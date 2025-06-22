//========================================================================================
//                             Precipitation Analysis
//========================================================================================
// This script computes a multi-year monthly precipitation time series using
// the CHIRPS daily precipitation dataset in a defined ROI. Outputs include:
// - Monthly precipitation composites (mm)
// - Daily and monthly time series charts
// - Animated GIF of monthly precipitation
//========================================================================================

//----------------------------------- USER INPUT ----------------------------------------//
// Define the area of interest (geometry or FeatureCollection)
// Replace 'geometry3' with your specific ROI if needed
var roi = geometry3;

// Set the time range for the analysis
var startYear = 2020;
var endYear = 2024;

//========================================================================================
//                       Function: Monthly Precipitation Series
//========================================================================================
/**
 * Computes monthly precipitation totals for each year and month in a given range.
 * Data source: CHIRPS Daily (UCSB-CHG/CHIRPS/DAILY)
 * Each monthly composite sums daily precipitation over the month.
 *
 * @param {number} startYear - Start year (inclusive).
 * @param {number} endYear   - End year (inclusive).
 * @param {ee.Geometry|ee.FeatureCollection} roi - Analysis region.
 * @return {ee.ImageCollection} - Multi-year monthly precipitation images.
 */
function monthlyPrecip(startYear, endYear, roi) {
  var years = ee.List.sequence(startYear, endYear); // List of years to process

  // Loop through each year and process months
  var allImages = years.map(function(year) {
    year = ee.Number(year);
    // Load CHIRPS daily precipitation for the year, clipped to ROI
    var chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
      .filterBounds(roi)
      .filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year, 12, 31));

    // Loop through months and sum daily precip within each month
    var monthly = ee.List.sequence(1, 12).map(function(month) {
      var start = ee.Date.fromYMD(year, month, 1);           // Start of month
      var end = start.advance(1, 'month');                   // End of month
      var monthlySum = chirps.filterDate(start, end)         // Filter daily images
        .sum()                                               // Sum daily values (mm)
        .clip(roi);                                          // Clip to ROI
      var count = chirps.filterDate(start, end).size();      // Number of daily images

      // Tag image with time, year, month, and count metadata
      return monthlySum
        .rename('Precip')
        .set('system:time_start', start.millis())
        .set('year', year)
        .set('month', month)
        .set('count', count);
    });

    // Return one imageCollection per year
    return ee.ImageCollection.fromImages(monthly);
  });

  // Merge all years' collections into one collection
  return ee.ImageCollection(allImages.iterate(function(ic, prev) {
    return ee.ImageCollection(prev).merge(ic);
  }, ee.ImageCollection([])));
}

// Run function to generate monthly precipitation ImageCollection
var precipImages = monthlyPrecip(startYear, endYear, roi);

//========================================================================================
//                        Function: Daily Precipitation Chart
//========================================================================================
/**
 * Plots a daily precipitation time series over the specified date range and region.
 * Uses CHIRPS daily precipitation dataset.
 *
 * @param {string} startDate - Start date (YYYY-MM-DD).
 * @param {string} endDate   - End date (YYYY-MM-DD).
 * @param {ee.Geometry|ee.FeatureCollection} region - Chart region.
 * @param {number} scale - Pixel scale (default: 5500 m for CHIRPS ~0.05°).
 * @return {ui.Chart} - Daily mean precipitation line chart.
 */
function dailyPrecipChart(startDate, endDate, region, scale) {
  var collection = ee.ImageCollection('UCSB-CHG/CHIRPS/DAILY')
    .filterDate(startDate, endDate)
    .filterBounds(region)
    .map(function(img){
      // Ensure clipping and property transfer
      return img.clip(region).copyProperties(img, img.propertyNames());
    })
    .select('precipitation'); // Main precipitation band

  return ui.Chart.image.series({
    imageCollection: collection,
    region: region,
    reducer: ee.Reducer.mean(),
    scale: scale || 5500,
    xProperty: 'system:time_start'
  })
  .setChartType('LineChart')
  .setOptions({
    title: 'Daily precipitation (mm)',
    hAxis: {title: 'Date'},
    vAxis: {title: 'mm/day'},
    lineWidth: 1
  });
}

// Print daily precipitation chart for full analysis period
print(dailyPrecipChart(startYear + '-01-01', endYear + '-12-31', roi));

//========================================================================================
//                  Function: Monthly Average Precipitation Chart
//========================================================================================
/**
 * Plots a time series of monthly mean precipitation in the ROI.
 *
 * @param {ee.ImageCollection} images - Monthly precipitation collection.
 * @param {ee.Geometry|ee.FeatureCollection} region - Analysis region.
 */
function createMonthlyPrecipChart(images, region) {
  var chart = ui.Chart.image.series({
    imageCollection: images.select('Precip'), // Only use 'Precip' band
    region: region,
    reducer: ee.Reducer.mean(),
    scale: 5500
  }).setOptions({
    title: 'Average Monthly Precipitation (mm)',
    hAxis: {title: '', format: 'YYYY-MMM'},  // Grouped by year-month
    vAxis: {title: 'Precip (mm)'},
    lineWidth: 2,
    pointSize: 4,
    series: { 0: {color: '#1E90FF'} }
  });

  print(chart);
}

// Print monthly precipitation time series chart
createMonthlyPrecipChart(precipImages, roi);

//========================================================================================
//                       Function: Monthly Precipitation GIF
//========================================================================================
/**
 * Creates and prints an animated GIF of the monthly precipitation time series.
 * Uses a color palette scaled for typical monthly values (max: 300 mm).
 *
 * @param {ee.ImageCollection} images - Monthly precipitation images.
 * @param {ee.Geometry|ee.FeatureCollection} roi - Area of interest.
 */
function createPrecipGif(images, roi) {
  var visParams = {
    min: 0,
    max: 300, // Adjust if necessary for your region
    palette: ['#ADD8E6', '#6495ED', '#7B68EE', '#6A5ACD', '#4B0082'] // Blue scale
  };

  var gifParams = {
    region: roi,
    dimensions: 600,
    crs: 'EPSG:3857',
    framesPerSecond: 2,
    format: 'gif',
    min: visParams.min,
    max: visParams.max,
    palette: visParams.palette
  };

  // Sort by time to ensure animation is correct
  var filtered = images.sort('system:time_start');

  print(ui.Thumbnail(filtered.select('Precip'), gifParams, 'Monthly Precipitation Animation'));
  print('📥 Download Precip GIF:', filtered.select('Precip').getVideoThumbURL(gifParams));
}

// Print and preview animated monthly precipitation GIF
createPrecipGif(precipImages, roi);