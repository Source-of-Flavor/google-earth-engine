/*
===========================================================================================
Monthly Soil Moisture Mapping: Example Template
Adapted from Amirhossein Ahrari & Mina Nada
-------------------------------------------------------------------------------------------
Script Workflow (Flowchart):
flowchart TD
    A[Define ROI Polygon] --> B[Load Sentinel-2 Collection]
    B --> C[Filter by Date and Cloud Cover]
    C --> D[Split into Monthly Median Images]
    D --> E[Calculate NDVI & STR]
    E --> F[Mask STR for Vegetation (NDVI > 0.3)]
    E --> G[Mask STR for Bare Soil (0 ≤ NDVI < 0.2)]
    F --> H[Compute STR Max/Min for Vegetation]
    G --> I[Compute STR Max/Min for Bare Soil]
    H & I --> J[Calculate Soil Moisture Index]
    J --> K[Generate Time Series Chart at Point]
    J --> L[Export Soil Moisture Images to Drive]
-------------------------------------------------------------------------------------------
Uses Sentinel-2 Surface Reflectance (COPERNICUS/S2_SR_HARMONIZED).
Output: Multi-year, monthly composites of Soil Moisture Index (SMI).
===========================================================================================
*/

//========================================================================================
//                          MAP VIEW & STUDY AREA
//========================================================================================

/**
 * Add a title label and set initial map view.
 * AOI ('banana') must be predefined as a geometry or FeatureCollection.
 */
var title = ui.Label({
  value: 'Monthly Soil Moisture Mapping',
  style: {fontWeight: 'bold', fontSize: '18px'}
});
title.style().set('position', 'top-center');
Map.add(title);

var aoi = geometry; // AOI geometry or FeatureCollection; replace with your study area
Map.centerObject(aoi, 10);

//========================================================================================
//                          CLOUD MASKING FUNCTION
//========================================================================================

/**
 * Cloud and cirrus masking for Sentinel-2 SR images using QA60 band.
 * @param {ee.Image} image - Sentinel-2 SR image.
 * @return {ee.Image} - Cloud-masked and selected bands image.
 */
function maskS2clouds(image) {
  var qa = image.select('QA60');
  var cloudBitMask = ee.Number(2).pow(10).int();
  var cirrusBitMask = ee.Number(2).pow(11).int();
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
               .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  return image.updateMask(mask)
              .select("B.*")
              .copyProperties(image, ["system:time_start"]);
}

//========================================================================================
//                    MONTHLY SOIL MOISTURE INDEX FUNCTION
//========================================================================================

/**
 * Computes monthly soil moisture index (SMI) from Sentinel-2 imagery.
 * NDVI used to mask vegetation and bare soil, STR index used for soil moisture logic.
 *
 * @param {number} startYear - Start year (inclusive).
 * @param {number} endYear   - End year (inclusive).
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 * @return {ee.ImageCollection} - Multi-year, monthly SMI composites.
 */
function monthlySoilMoisture(startYear, endYear, aoi) {
  var years = ee.List.sequence(startYear, endYear);

  var allImages = years.map(function(year) {
    year = ee.Number(year);

    var s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(aoi)
      .filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year, 12, 31))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 20))
      .map(maskS2clouds);

    var monthly = ee.List.sequence(1, 12).map(function(month) {
      var start = ee.Date.fromYMD(year, month, 1);
      var end = start.advance(1, 'month');
      var collection = s2.filterDate(start, end);

      var composite = collection.median().clip(aoi);
      var count = collection.size();

      // Proceed if images are available for this month
      return ee.Algorithms.If(
        count.gt(0),
        (function() {
          // Scale reflectance, compute NDVI and STR index
          var bands = composite.select('B.*').multiply(0.0001);
          var ndvi = bands.normalizedDifference(['B8', 'B4']).rename('ndvi');
          var str = bands.expression('((1 - swir) ** 2) / (2 * swir)', {'swir': bands.select('B12')}).rename('str');
          var parameters = ndvi.addBands(str);

          // Define NDVI thresholds
          var thr_full = ndvi.gt(0.3); // Dense vegetation
          var thr_bare = ndvi.gte(0).and(ndvi.lt(0.2)); // Bare soil

          // Mask STR for vegetation and bare soil
          var str_full = str.updateMask(thr_full);
          var str_bare = str.updateMask(thr_bare);

          // Compute region statistics for each mask
          var vw = ee.Number(str_full.reduceRegion({
            reducer: ee.Reducer.max(), geometry: aoi, scale: 20, maxPixels: 1e13
          }).values().get(0)); // Max STR (veg)

          var vd = ee.Number(str_full.reduceRegion({
            reducer: ee.Reducer.min(), geometry: aoi, scale: 20, maxPixels: 1e13
          }).values().get(0)); // Min STR (veg)

          var iw = ee.Number(str_bare.reduceRegion({
            reducer: ee.Reducer.max(), geometry: aoi, scale: 20, maxPixels: 1e13
          }).values().get(0)); // Max STR (bare)

          var id = ee.Number(str_bare.reduceRegion({
            reducer: ee.Reducer.min(), geometry: aoi, scale: 20, maxPixels: 1e13
          }).values().get(0)); // Min STR (bare)

          var sw = vw.subtract(iw);
          var sd = vd.subtract(id);

          // Compute Soil Moisture Index (SMI)
          var soil_moisture = parameters.expression(
            '(id + sd * ndvi - str) / (id - iw + (sd - sw) * ndvi)', {
              'id': id, 'sd': sd,
              'ndvi': parameters.select('ndvi'),
              'str': parameters.select('str'),
              'iw': iw, 'sw': sw
            }).rename('SMI');

          // Apply mask and scale output
          var mask = ndvi.gte(-0.1);
          var final = soil_moisture.multiply(1000).updateMask(mask)
            .set('year', year)
            .set('month', month)
            .set('count', count)
            .set('system:time_start', start.millis());

          return final;
        })(),
        // No data: output empty image with flag
        ee.Image().rename('SMI')
          .set('year', year)
          .set('month', month)
          .set('count', 0)
          .set('noData', 1)
          .set('system:time_start', start.millis())
      );
    });

    return ee.ImageCollection.fromImages(monthly);
  });

  // Merge all years into a single collection
  return ee.ImageCollection(allImages.iterate(function(ic, prev) {
    return ee.ImageCollection(prev).merge(ic);
  }, ee.ImageCollection([])));
}

//========================================================================================
//                          CREATE SMI GIF FUNCTION
//========================================================================================

/**
 * Create and print an animated GIF of SMI time series.
 * @param {ee.ImageCollection} smiImages - Collection of SMI images.
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 */
function createSMIGif(smiImages, aoi) {
  var visParams = {
    min: 0,
    max: 1000,
    palette: ['#f7fcf5', '#74c476', '#006d2c']
  };

  var gifParams = {
    region: aoi,
    dimensions: 600,
    crs: 'EPSG:3857',
    framesPerSecond: 2,
    format: 'gif',
    min: visParams.min,
    max: visParams.max,
    palette: visParams.palette
  };

  var filtered = smiImages.filter(ee.Filter.neq('noData', 1)).sort('system:time_start');

  filtered.size().evaluate(function(size) {
    if (size > 0) {
      print(ui.Thumbnail(filtered.select('SMI'), gifParams, 'SMI Animation'));
      print('📥 Download SMI GIF:', filtered.select('SMI').getVideoThumbURL(gifParams));
    } else {
      print('⚠️ No Soil Moisture data available for animation.');
    }
  });
}

//========================================================================================
//                          EXPORT FUNCTION
//========================================================================================

/**
 * Export each monthly SMI image to Google Drive.
 * Skips months with no data.
 * @param {ee.ImageCollection} smiImages - SMI image collection.
 * @param {string} folderName - Drive folder name for exports.
 */
function exportSMIToDrive(smiImages, folderName) {
  smiImages.evaluate(function(images) {
    images.features.forEach(function(f) {
      var year = f.properties.year;
      var month = f.properties.month;
      var noData = f.properties.noData;
      if (noData !== 1) {
        var image = ee.Image(f.id);
        Export.image.toDrive({
          image: image,
          description: 'SMI_' + year + '_' + month,
          folder: folderName,
          fileNamePrefix: 'SMI_' + year + '_' + month,
          region: aoi,
          scale: 20,
          maxPixels: 1e13
        });
        print('✅ Exporting Soil Moisture for', year + '-' + month);
      } else {
        print('⚠️ No data for ' + year + '-' + month + ', skipping export.');
      }
    });
  });
}

//========================================================================================
//                          CHART FUNCTIONS
//========================================================================================

/**
 * Create and print a time series chart (mean SMI) for the AOI.
 * @param {ee.ImageCollection} smiImages - SMI image collection.
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 * @param {string} title - Chart title.
 */
function createSMITimeSeriesChart(smiImages, aoi, title) {
  var chart = ui.Chart.image.series({
    imageCollection: smiImages.select('SMI'),
    region: aoi,
    reducer: ee.Reducer.mean(),
    scale: 20
  }).setOptions({
    lineWidth: 2,
    pointSize: 4,
    title: title,
    interpolateNulls: true,
    vAxis: {title: 'Soil Moisture Index (×1000)'},
    hAxis: {title: '', format: 'YYYY-MMM'},
    series: { 0: {color: '#1E90FF'} }
  });

  print(chart);
}

/**
 * Print a column chart of image count per monthly SMI composite.
 * @param {ee.ImageCollection} smiImages - SMI image collection.
 */
function createImageCountChart(smiImages) {
  var chart = ui.Chart.feature.byFeature(smiImages, 'system:time_start', ['count'])
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Monthly Image Count for Soil Moisture Calculation',
      hAxis: {
        title: 'Date',
        format: 'YYYY-MM',
        slantedText: true,
        slantedTextAngle: 45
      },
      vAxis: { title: 'Image Count' },
      legend: { position: 'none' },
      colors: ['#1E90FF']
    });
  print(chart);
}

//========================================================================================
//                          EXECUTION BLOCK
//========================================================================================

//---------------------- USER PARAMETERS ----------------------//
var startYear = 2022; // Start year for analysis
var endYear = 2024;   // End year for analysis

//------------------------------------------------------------//
var smiImages = monthlySoilMoisture(startYear, endYear, aoi);

// Visualize each monthly SMI image and print stats
smiImages.aggregate_array('system:time_start').evaluate(function(timestamps) {
  timestamps.forEach(function(time) {
    var img = smiImages.filter(ee.Filter.eq('system:time_start', time)).first();
    img.get('count').evaluate(function(count) {
      var date = ee.Date(time).format('YYYY-MM').getInfo();
      print('Month:', date, '| Images used:', count);
      Map.addLayer(img, 
        {min: 0, max: 1000, palette: ['#f7fcf5', '#74c476', '#006d2c']},
        'SMI ' + date
      );
    });
  });
});

// Generate interactive charts and GIF preview
createSMITimeSeriesChart(smiImages, aoi, 'Soil Moisture Index Time Series (' + startYear + '–' + endYear + ')');
createImageCountChart(smiImages);
createSMIGif(smiImages, aoi);
exportSMIToDrive(smiImages, 'SMI_MultiYear_Exports');
