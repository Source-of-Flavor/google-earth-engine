/*
COFFEE NDVI TIME SERIES: SANTA ANA, EL SALVADOR
https://library.sweetmarias.com/coffee-production-timetable/
By: Source of Flavor Institute (SoFI)
Date: Feb. 2025

The goal of this script will be create an NDVI timeseries of the coffee growing regions.
The aim is to highlight the rise of  and fall of NDVI values over the period of a growing season from start -> harvest

Context:

-All analyses will focus on key coffee-producing regions, such as Ethiopia, Colombia, Brazil, and Central America.

Background on Coffee Production
The Coffee Plant (Coffea spp.)
Coffee is a tropical, perennial plant that thrives in high-altitude, humid regions with well-draining soils. The two main commercial species are:
Coffea arabica: Known for its superior quality, typically grown at higher elevations.
Coffea canephora (Robusta): More disease-resistant and can be cultivated at lower elevations. 

Coffee Growth Cycle & Environmental Needs

Flowering: Triggered by seasonal rains, followed by cherry development.
Fruit Development: Takes approximately 6–8 months for Arabica and 9–11 months for Robusta. 

Harvesting: Typically occurs once per year, depending on regional climate.
Drying & Processing: Coffee cherries are processed using washed, natural, or honey methods, affecting flavor.
Each stage of the coffee cycle is influenced by temperature, rainfall, and altitude, making Earth observation data essential for understanding regional differences in coffee quality and production sustainability.

Hypothesis: TBA


Methodology:

-Add in study area / Create ROI
-Load an Sentinel-2 image collection
  -Split up image collection by month // filter date
  -Mask clouds using 'percentage' method
  -clip to roi
-Make composite image for each month (e.g. take the median of all pixels from monthly image collection)
-Create NDVI for each month
  -Save only the processed NDVI band to reduce memory
-Apply color pallete
-Print out time series
-Add NDVI layers to map for inspection

Ex

*/

//=====================================================================================================
//                          MAP VIEW & STUDY AREA DEFINITION
//*****************************************************************************************************

// Create a title label to display on the map
var title = ui.Label({
  value: 'NDVI Time Series of the Coffee Growing Region of Brazil',
  style: { fontWeight: 'bold', fontSize: '18px' }
});

// Set the position of the title to top-center
title.style().set('position', 'top-center');

// Add the title label to the map
Map.add(title);

// Define Area of Interest (AOI)
//var aoi = rioClaro, a coffee growin region in Brazil;
var aoi = ee.Geometry.Polygon([
  [[-47.56809373293885, -22.373191935904938],
  [-47.421838239774786, -22.373191935904938],
  [-47.421838239774786, -22.30523489029257],
  [-47.56809373293885, -22.30523489029257],
  [-47.56809373293885, -22.373191935904938]
  ]
]);



// Center the map view over the AOI with zoom level 10
Map.centerObject(aoi, 10);

//=====================================================================================================
//                          CLOUD MASKING FUNCTION
//*****************************************************************************************************

// Function to mask out clouds and cirrus from Sentinel-2 imagery
function maskS2clouds(image) {
  var qa = image.select('QA60'); // Select cloud mask band
  var cloudBitMask = ee.Number(2).pow(10).int(); // Bit 10 for clouds
  var cirrusBitMask = ee.Number(2).pow(11).int(); // Bit 11 for cirrus
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0) // Mask cloudy pixels
               .and(qa.bitwiseAnd(cirrusBitMask).eq(0)); // Mask cirrus pixels
  return image.updateMask(mask) // Apply mask
              .divide(10000) // Scale reflectance to 0–1
              .select("B.*") // Keep only spectral bands
              .copyProperties(image, ["system:time_start"]); // Retain timestamp
}

//=====================================================================================================
//                          MULTI-YEAR MONTHLY NDVI FUNCTION (Safe Normalization)
//*****************************************************************************************************

// Function to compute monthly NDVI from a multi-year Sentinel-2 collection
function monthlyNDVIrange(startYear, endYear, aoi) {
  var years = ee.List.sequence(startYear, endYear); // Create list of years

  var allImages = years.map(function(year) {
    year = ee.Number(year);

    // Load and filter Sentinel-2 imagery
    var s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(aoi)
      .filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year, 12, 31))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .map(maskS2clouds)
      .select(['B4', 'B8']); // Red and NIR bands

    // Map over each month to create a composite
    var monthly = ee.List.sequence(1, 12).map(function(month) {
      var start = ee.Date.fromYMD(year, month, 1);
      var end = start.advance(1, 'month');
      var collection = s2.filterDate(start, end); // Filter by month
      var composite = collection.median().clip(aoi); // Median composite
      var count = collection.size(); // Image count for QA

      return ee.Algorithms.If(
        count.gt(0), // If images exist
        (function() {
          var ndviImage = composite.normalizedDifference(['B8', 'B4']).rename('NDVI');
          var ndviMinMax = ndviImage.reduceRegion({
            reducer: ee.Reducer.minMax(),
            geometry: aoi,
            scale: 10,
            maxPixels: 1e13
          });
          var ndviMin = ee.Number(ndviMinMax.get('NDVI_min'));
          var ndviMax = ee.Number(ndviMinMax.get('NDVI_max'));
          var ndviNormalized = ndviImage.subtract(ndviMin).divide(ndviMax.subtract(ndviMin))
                              .rename('NDVI_Normalized');
          return ndviNormalized
            .set('year', year)
            .set('month', month)
            .set('count', count)
            .set('system:time_start', ee.Date.fromYMD(year, month, 1).millis());
        })(),
        ee.Image().rename('NDVI_Normalized') // Fallback if no data
          .set('year', year)
          .set('month', month)
          .set('count', 0)
          .set('noData', 1)
          .set('system:time_start', ee.Date.fromYMD(year, month, 1).millis())
      );
    });

    return ee.ImageCollection.fromImages(monthly); // Return monthly image collection
  });

  // Merge all years into one ImageCollection
  return ee.ImageCollection(allImages.iterate(function(ic, prev) {
    return ee.ImageCollection(prev).merge(ic);
  }, ee.ImageCollection([])));
}

//=====================================================================================================
//                          EXPORT NDVI FUNCTION
//*****************************************************************************************************

// Function to export each monthly NDVI image to Google Drive
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

//=====================================================================================================
//                          GENERATE NDVI GIF FUNCTION
//*****************************************************************************************************

// Function to create an animated GIF from monthly NDVI images
function createNDVIGif(ndviImages, aoi) {
  var visParams = {
    min: 0,
    max: 1,
    palette: ['#FF0000', '#FFA500', '#FFFF00', '#ADFF2F', '#008000']
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

  filtered.size().evaluate(function(size) {
    if (size > 0) {
      print(ui.Thumbnail(filtered.select('NDVI_Normalized'), gifParams, 'NDVI Animation'));
      print('📥 Download NDVI GIF:', filtered.select('NDVI_Normalized').getVideoThumbURL(gifParams));
    } else {
      print('⚠️ No NDVI data available for animation.');
    }
  });
}

//=====================================================================================================
//                          NDVI TIME SERIES CHART FUNCTION
//*****************************************************************************************************

// Function to plot NDVI values as a time series chart
function createNDVITimeSeriesChart(ndviImages, aoi, title) {
  var chart = ui.Chart.image.series({
    imageCollection: ndviImages.select('NDVI_Normalized'),
    region: aoi,
    reducer: ee.Reducer.mean(),
    scale: 10
  }).setOptions({
    lineWidth: 2,
    pointSize: 4,
    title: title,
    interpolateNulls: true,
    vAxis: {title: 'Normalized NDVI'},
    hAxis: {title: '', format: 'YYYY-MMM'},
    series: { 0: {color: '#2E8B57'} }
  });

  print(chart);
}

//=====================================================================================================
//                          IMAGE COUNT CHART FUNCTION
//*****************************************************************************************************

// Function to plot a bar chart showing number of images used per month
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

//=====================================================================================================
//                          EXECUTION BLOCK: MULTI-YEAR RANGE
//*****************************************************************************************************

// Define start and end year of analysis
var startYear = 2022;
var endYear = 2024;

// Generate the NDVI image collection for the specified years
var ndviImages = monthlyNDVIrange(startYear, endYear, aoi);

// For each month, print image count and add NDVI layer to map
ndviImages.aggregate_array('system:time_start').evaluate(function(timestamps) {
  timestamps.forEach(function(time) {
    var img = ndviImages.filter(ee.Filter.eq('system:time_start', time)).first();
    img.get('count').evaluate(function(count) {
      var date = ee.Date(time).format('YYYY-MM').getInfo();
      print('Month:', date, '| Images used:', count);
      Map.addLayer(img, 
        {min: 0, max: 1, palette: ['#FF0000', '#FFA500', '#FFFF00', '#ADFF2F', '#008000']},
        'NDVI ' + date
      );
    });
  });
});

// Generate NDVI time series chart
createNDVITimeSeriesChart(ndviImages, aoi, 'Normalized NDVI Time Series (' + startYear + '–' + endYear + ')');

// Generate NDVI animation GIF
createNDVIGif(ndviImages, aoi);

// Generate image count chart
createImageCountChart(ndviImages);

// Export all valid NDVI images to Google Drive
exportNDVIToDrive(ndviImages, 'NDVI_MultiYear_Exports');
