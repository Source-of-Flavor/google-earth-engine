/*
==========================================================================================
SAVI TIME SERIES: Rio Claro, BRAZIL
https://library.sweetmarias.com/coffee-production-timetable/
Author: Mina Nada
Date: Feb. 2025

------------------------------------------------------------------------------------------
Script Overview:
- Generate a multi-year SAVI (Soil-Adjusted Vegetation Index) time series over coffee-growing regions.
- Visualize seasonal rise/fall in SAVI values (proxy for crop growth stage).
- Produce monthly composites, time series charts, and animated GIFs.
- Script can be exported for use in geemap (Python).
------------------------------------------------------------------------------------------
Data:
- Sentinel-2 Surface Reflectance (COPERNICUS/S2_SR_HARMONIZED)
------------------------------------------------------------------------------------------
*/

//========================================================================================
//                              MAP VIEW & STUDY AREA
//========================================================================================

/**
 * Add a title label and set the initial map view.
 * AOI ('rioClaro') must be pre-defined in your GEE assets or script.
 */
var title = ui.Label({
  value: 'NDVI Time Series of the Coffee Growing Region of Brazil',
  style: { fontWeight: 'bold', fontSize: '18px' }
});
title.style().set('position', 'top-center');
Map.add(title);

var aoi = rioClaro;  // Study area; replace with your actual FeatureCollection or Geometry
Map.centerObject(aoi, 10);

//========================================================================================
//                              CLOUD MASKING FUNCTION
//========================================================================================

/**
 * Cloud and cirrus masking for Sentinel-2 SR data using QA60 band.
 * @param {ee.Image} image - Sentinel-2 SR image.
 * @return {ee.Image} - Cloud-masked, scaled, and selected bands image.
 */
function maskS2clouds(image) {
  var qa = image.select('QA60');
  var cloudBitMask = ee.Number(2).pow(10).int();
  var cirrusBitMask = ee.Number(2).pow(11).int();

  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
               .and(qa.bitwiseAnd(cirrusBitMask).eq(0));

  return image.updateMask(mask)
              .divide(10000)  // Scale reflectance bands to [0,1]
              .select("B.*")
              .copyProperties(image, ["system:time_start"]);
}

//========================================================================================
//                        MULTI-YEAR MONTHLY SAVI FUNCTION
//========================================================================================

/**
 * Build a multi-year, monthly SAVI (NDVI here; set L=0.5 for SAVI) ImageCollection.
 * Each monthly image is a median composite.
 *
 * @param {number} startYear - Starting year (inclusive).
 * @param {number} endYear   - Ending year (inclusive).
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 * @return {ee.ImageCollection} - Multi-year monthly SAVI composites with properties.
 */
function monthlyNDVIrange(startYear, endYear, aoi) {
  var years = ee.List.sequence(startYear, endYear);

  var allImages = years.map(function(year) {
    year = ee.Number(year);

    var s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(aoi)
      .filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year, 12, 31))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .map(maskS2clouds)
      .select(['B4', 'B8']); // RED and NIR

    var monthly = ee.List.sequence(1, 12).map(function(month) {
      var start = ee.Date.fromYMD(year, month, 1);
      var end = start.advance(1, 'month');
      var collection = s2.filterDate(start, end);
      var composite = collection.median().clip(aoi);
      var count = collection.size();

      var L = 0.5; // SAVI soil adjustment constant
      var saviImage = ee.Algorithms.If(
        composite.bandNames().length().gt(0),
        composite.expression(
          '((NIR - RED) / (NIR + RED + L)) * (1 + L)', {
            NIR: composite.select('B8'),
            RED: composite.select('B4'),
            L: L
          }).rename('NDVI'),
        ee.Image().rename('NDVI').set('noData', 1)
      );

      return ee.Image(saviImage)
        .set('year', year)
        .set('month', month)
        .set('count', count)
        .set('system:time_start', ee.Date.fromYMD(year, month, 1).millis());
    });

    return ee.ImageCollection.fromImages(monthly);
  });

  // Merge all yearly collections into one
  return ee.ImageCollection(allImages.iterate(function(ic, prev) {
    return ee.ImageCollection(prev).merge(ic);
  }, ee.ImageCollection([])));
}

//========================================================================================
//                          EXPORT NDVI FUNCTION FOR MULTI-YEAR
//========================================================================================

/**
 * Export each monthly SAVI (NDVI) image to Google Drive.
 * Skips months with no data.
 * @param {ee.ImageCollection} ndviImages - Collection of SAVI images.
 * @param {string} folderName - Name of Drive folder for exports.
 */
function exportNDVIToDrive(ndviImages, folderName) {
  ndviImages.evaluate(function(images) {
    images.features.forEach(function(f) {
      var year = f.properties.year;
      var month = f.properties.month;
      var noData = f.properties.noData;

      if (noData !== 1) {
        var image = ee.Image(f.id);
        Export.image.toDrive({
          image: image,
          description: 'NDVI_' + year + '_' + month,
          folder: folderName,
          fileNamePrefix: 'NDVI_' + year + '_' + month,
          region: aoi,
          scale: 10,
          maxPixels: 1e13
        });
        print('✅ Exporting NDVI for', year + '-' + month);
      } else {
        print('⚠️ No data for ' + year + '-' + month + ', skipping export.');
      }
    });
  });
}

//========================================================================================
//                          GENERATE NDVI GIF FUNCTION
//========================================================================================

/**
 * Create and print an animated GIF of the SAVI/NDVI time series.
 * @param {ee.ImageCollection} ndviImages - Collection of monthly SAVI images.
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 */
function createNDVIGif(ndviImages, aoi) {
  var visParams = {
    min: -0.25,
    max: 0.75,
    palette: ['#8B4513', '#D2B48C', '#FFFF00', '#ADFF2F', '#008000']
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

  var filtered = ndviImages.filter(ee.Filter.neq('noData', 1)).sort('system:time_start');

  print(ui.Thumbnail(filtered.select('NDVI'), gifParams, 'NDVI Animation'));
  print('📥 Download NDVI GIF:', filtered.select('NDVI').getVideoThumbURL(gifParams));
}

//========================================================================================
//                          NDVI TIME SERIES CHART FUNCTION
//========================================================================================

/**
 * Create and print a time series chart (mean NDVI/SAVI) for the AOI.
 * @param {ee.ImageCollection} ndviImages - SAVI/NDVI collection.
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 * @param {string} title - Chart title.
 */
function createNDVITimeSeriesChart(ndviImages, aoi, title) {
  var chart = ui.Chart.image.series({
    imageCollection: ndviImages.select('NDVI'),
    region: aoi,
    reducer: ee.Reducer.mean(),
    scale: 10
  }).setOptions({
    lineWidth: 2,
    pointSize: 4,
    title: title,
    interpolateNulls: true,
    vAxis: {title: 'NDVI'},
    hAxis: {title: '', format: 'YYYY-MMM'},
    series: { 0: {color: '#2E8B57'} }
  });

  print(chart);
}

//========================================================================================
//                          IMAGE COUNT CHART FUNCTION
//========================================================================================

/**
 * Print a column chart of image count per monthly composite.
 * @param {ee.ImageCollection} ndviImages - SAVI/NDVI collection.
*/

function createImageCountChart(ndviImages) {
  var chart = ui.Chart.feature.byFeature(ndviImages, 'system:time_start', ['count'])
    .setChartType('ColumnChart')
    .setOptions({
      title: 'Monthly Image Count',
      hAxis: {
        title: 'Date',
        format: 'YYYY-MM',
        slantedText: true,
        slantedTextAngle: 45
      },
      vAxis: { title: 'Image Count' },
      legend: { position: 'none' },
      colors: ['#3366cc']
    });
  print(chart);
}

//========================================================================================
//                          EXECUTION BLOCK: MULTI-YEAR RANGE
//========================================================================================

//---------------------- USER PARAMETERS ----------------------//
var startYear = 2022;  // Set start year
var endYear = 2024;    // Set end year

//-------------------------------------------------------------//
var ndviImages = monthlyNDVIrange(startYear, endYear, aoi);

// Visualize each monthly NDVI/SAVI image on the map, print stats
ndviImages.aggregate_array('system:time_start').evaluate(function(timestamps) {
  timestamps.forEach(function(time) {
    var img = ndviImages.filter(ee.Filter.eq('system:time_start', time)).first();
    img.get('noData').evaluate(function(noData) {
      img.get('count').evaluate(function(count) {
        var date = ee.Date(time).format('YYYY-MM').getInfo();
        print('Month:', date, '| Images used:', count);
        if (noData !== 1) {
          var visParamNDVI = {
            min: -0.25,
            max: 0.75,
            palette: ['#8B4513', '#D2B48C', '#FFFF00', '#ADFF2F', '#008000']
          };
          Map.addLayer(img, visParamNDVI, 'NDVI ' + date);
        }
      });
    });
  });
});

// Add interactive charts and GIF preview
createNDVITimeSeriesChart(ndviImages, aoi, 'NDVI Time Series (' + startYear + '–' + endYear + ')');
createNDVIGif(ndviImages, aoi);
createImageCountChart(ndviImages);
exportNDVIToDrive(ndviImages, 'NDVI_MultiYear_Exports');
