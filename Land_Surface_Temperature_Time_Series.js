//========================================================================================
//             High-Resolution Land Surface Temperature (LST) Prediction
//----------------------------------------------------------------------------------------
// Upscales daily LST to 10-meter resolution using Sentinel-2 bands, indices, and DEM,
// trained on coarser Landsat-derived LST using Random Forest regression. Output includes
// daily time series, feature correlation ranking, and animated map visualization.
//
// Based on Ramadhan script. 
// Youtube: https://youtube.com/@ramiqcom
// Reference: https://code.earthengine.google.com/ac986028b56a794aefd3ea54e9cb09ba
//========================================================================================


//========================================================================================
// PARAMETERS & AOI
//========================================================================================

// Add a title to the Earth Engine map UI for context
var title = ui.Label({
  value: 'Daily Land Surface Temperature Prediction',
  style: { fontWeight: 'bold', fontSize: '18px' }
});
title.style().set('position', 'top-center');
Map.add(title);

// Define area of interest (replace 'egypt' with actual FeatureCollection/geometry)
var roi = egypt;

// Center the map for visualization; adjust zoom as needed
Map.centerObject(roi, 15);

// Set analysis period (daily LST will be predicted for each day)
var start = '2024-01-01';
var end = '2025-01-01';

// Set number of predictor variables (top features)
var finalPredictorsSize = 3;

// LST band/label used for regression target
var label = 'LST';

// Training/test data split
var train_ratio = 0.7;

// Visualization for LST maps (Celsius degrees)
var lstVis = { min: 20, max: 30, palette: ['blue', 'yellow', 'red'] };


//========================================================================================
// BASE DATA & MASKING
//========================================================================================

// Import base datasets: SRTM DEM, Landsat (L8+L9), Sentinel-2
var srtm = ee.Image("USGS/SRTMGL1_003");
var l8 = ee.ImageCollection("LANDSAT/LC08/C02/T1_L2");
var l9 = ee.ImageCollection("LANDSAT/LC09/C02/T1_L2");
var s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED");

/**
 * Mask clouds from Landsat using QA_PIXEL band, and extract/convert LST.
 * LST (Kelvin) to Celsius: LST = (ST_B10 * 0.00341802 + 149) - 273.15
 * Returns masked LST band named 'LST'.
 */
function cloudMaskLandsat(image){
  var qa = image.select('QA_PIXEL');
  // Cloud bits: 1-4 (fill, dilated cloud, cirrus, cloud)
  var mask = ee.Image([1,2,3,4].map(function(b){ return qa.bitwiseAnd(1 << b).eq(0); }))
                .reduce(ee.Reducer.allNonZero());
  return image.select('ST_B10')
    .multiply(0.00341802).add(149).subtract(273.15) // Convert to °C
    .updateMask(mask)
    .rename('LST');
}

/**
 * Mask clouds/cirrus from Sentinel-2 using QA60, scale reflectance, return all S2 bands.
 * Output: All "B.*" bands, scaled to [0,1], masked for clouds.
 */
function cloudMaskS2(image){
  var qa = image.select('QA60');
  var cloud = ee.Number(2).pow(10).int();
  var cirrus = ee.Number(2).pow(11).int();
  var mask = qa.bitwiseAnd(cloud).eq(0).and(qa.bitwiseAnd(cirrus).eq(0));
  return image.updateMask(mask).divide(10000).select("B.*");
}


//========================================================================================
// FEATURE ENGINEERING: BAND, INDEX, AND TOPOGRAPHIC DERIVATION
//========================================================================================

// Filter all input imagery to AOI and date range
var filter = ee.Filter.and(ee.Filter.bounds(roi), ee.Filter.date(start, end));

// Landsat LST label (mean over period)
var lstLandsat = l8.merge(l9).filter(filter).map(cloudMaskLandsat).mean().clip(roi);

// Median cloud-masked Sentinel-2 image (reflectance)
var s2Image = s2.filter(filter).map(cloudMaskS2).median().clip(roi);

// Vegetation and surface moisture indices (from Sentinel-2)
var ndmi = s2Image.normalizedDifference(['B8', 'B11']).rename('NDMI');    // Moisture Index
var nbr = s2Image.normalizedDifference(['B8', 'B12']).rename('NBR');      // Burn Ratio (dryness)
var mndwi2 = s2Image.normalizedDifference(['B3', 'B12']).rename('MNDWI2');// Water index

// DEM-derived terrain features
var tpi = srtm.subtract(srtm.focalMean(5)).rename('TPI');     // Topographic Position Index
var slope = ee.Terrain.slope(srtm).rename('slope');           // Slope in degrees

// Stratified elevation classes for spatially-stratified sampling
var strat = ee.Image(0)
  .where(srtm.lt(0), 1)
  .where(srtm.gte(0).and(srtm.lt(10)), 2)
  .where(srtm.gte(10).and(srtm.lt(50)), 3)
  .where(srtm.gte(50).and(srtm.lt(100)), 4)
  .where(srtm.gte(100).and(srtm.lt(500)), 5)
  .where(srtm.gte(500).and(srtm.lt(1000)), 6)
  .where(srtm.gte(1000), 7)
  .rename('elevation_class');

// Stack all features into a single multi-band image
var features = ee.Image([
  s2Image, ndmi, nbr, mndwi2,
  srtm.rename('elevation'), tpi, slope, strat
]);


//========================================================================================
// TRAINING SAMPLE CREATION & CORRELATION ANALYSIS
//========================================================================================

/**
 * Stratified random sampling (by elevation class), combining features + LST label.
 * The number of samples and their distribution are key to generalization.
 */
var sample = features.addBands(lstLandsat).stratifiedSample({
  scale: 30,                // Landsat LST resolution (native 30 m)
  numPoints: 1000,          // Total samples (adjust as needed)
  region: roi,              // Area of interest
  classBand: 'elevation_class', // Ensures elevation class representation
  seed: 1                   // For reproducibility
});

// List of potential predictors; select the best later
var predictors = ['B4', 'B8', 'B11', 'NDMI', 'NBR', 'MNDWI2', 'elevation', 'TPI', 'slope'];
var predictorsLst = [];
for (var i = 0; i < predictors.length; i++) {
  predictorsLst.push(predictors[i]);
  predictorsLst.push(label);
}

// Calculate Pearson's R^2 for each predictor vs LST to rank importance
var corr = sample.reduceColumns(ee.Reducer.pearsonsCorrelation().repeat(predictors.length), predictorsLst);
var correlation = ee.FeatureCollection(predictors.map(function(b, i){
  return ee.Feature(null, {
    feature: b,
    r2: ee.Number(ee.List(corr.get('correlation')).get(i)).pow(2)
  });
}));

// Select top predictors by R^2, remove redundancy by correlation
var topCorr = correlation.limit(finalPredictorsSize * 2, 'r2', false).aggregate_array('feature');
var modelFeatures = ee.List(topCorr).slice(0, finalPredictorsSize); // Only use top N

// Stratified random train-test split
sample = sample.randomColumn();
var train = sample.filter(ee.Filter.lte('random', train_ratio));

// Fit regression Random Forest model to training data
var model = ee.Classifier.smileRandomForest(50)
  .setOutputMode('REGRESSION')
  .train(train, label, modelFeatures);


//========================================================================================
// DAILY LST PREDICTION FUNCTION
//========================================================================================
/**
 * Predicts daily LST at 10m (Sentinel-2) resolution for each day in time range.
 * Uses cloud-masked S2 and top predictors, applies trained regression model.
 *
 * @param {string} startDate - Start of prediction period (YYYY-MM-DD)
 * @param {string} endDate   - End of prediction period (YYYY-MM-DD)
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest
 * @return {ee.ImageCollection} - Collection of predicted daily LST images (°C)
 */
function predictDailyLST(startDate, endDate, aoi) {
  // Build list of daily offsets (from start)
  var days = ee.List.sequence(0, ee.Date(endDate).difference(ee.Date(startDate), 'day').subtract(1));
  return ee.ImageCollection.fromImages(days.map(function(offset) {
    var day = ee.Date(startDate).advance(offset, 'day');
    // Collect all S2 images for that day
    var s2day = s2.filterBounds(aoi).filterDate(day, day.advance(1, 'day'))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .map(cloudMaskS2);
    var hasData = s2day.size().gt(0); // Only predict if data is present
    return ee.Image(ee.Algorithms.If(hasData,
      (function(){
        var img = s2day.median().clip(aoi);
        // Calculate indices for current day
        var ndmi = img.normalizedDifference(['B8', 'B11']).rename('NDMI');
        var nbr = img.normalizedDifference(['B8', 'B12']).rename('NBR');
        var mndwi2 = img.normalizedDifference(['B3', 'B12']).rename('MNDWI2');
        var all = img.addBands([ndmi, nbr, mndwi2, srtm.rename('elevation'), tpi, slope]);
        // Predict LST using the trained model; set date property
        return all.classify(model, 'LST').set('system:time_start', day.millis()).rename('LST');
      })(),
      // If no data, output a dummy image (flagged with noData)
      ee.Image().rename('LST').set('system:time_start', day.millis()).set('noData', 1)
    ));
  }));
}

// Generate daily high-resolution LST predictions
var dailyLST = predictDailyLST(start, end, roi);


//========================================================================================
//                VISUALIZATION: TIME SERIES CHART & ANIMATION GIF
//========================================================================================

/**
 * Plots the daily predicted mean LST as a time series chart for the AOI.
 * Outputs in °C.
 */
var chart = ui.Chart.image.series({
  imageCollection: dailyLST.select('LST'),
  region: roi,
  reducer: ee.Reducer.mean(),
  scale: 10 // Use Sentinel-2 native
}).setOptions({
  title: 'Daily Predicted LST Time Series',
  vAxis: { title: 'LST (°C)' },
  hAxis: { format: 'YYYY-MM-dd' }
});
print(chart);

/**
 * Outputs animated GIF of daily LST (°C) using a blue-yellow-red color ramp.
 * GIF is downloadable from the provided URL.
 */
var gifParams = {
  region: roi,
  dimensions: 600,
  crs: 'EPSG:3857',
  framesPerSecond: 2,
  format: 'gif',
  min: 20,
  max: 40,
  palette: lstVis.palette
};

// Remove images flagged with 'noData' and sort by date
var filtered = dailyLST.filter(ee.Filter.neq('noData', 1)).sort('system:time_start');
print(ui.Thumbnail(filtered.select('LST'), gifParams, 'LST Animation'));
print('GIF URL:', filtered.select('LST').getVideoThumbURL(gifParams));