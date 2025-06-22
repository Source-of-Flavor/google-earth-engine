/*
===========================================================================================
Monthly False Color (NIR) Animation: Coffee Region, Brazil
-------------------------------------------------------------------------------------------
Produces a monthly, multi-year false color (NIR-Red-Green) composite time series
using Sentinel-2, with cloud masking, monthly median compositing, GIF animation,
and image count chart for QA/QC.
-------------------------------------------------------------------------------------------
Data: COPERNICUS/S2_SR_HARMONIZED
Author: [Your Name]
===========================================================================================
*/

//========================================================================================
//                               MAP VIEW & STUDY AREA
//========================================================================================

/**
 * Add a title and set initial map view.
 * AOI ('taj') must be a predefined geometry or FeatureCollection.
 */
var title = ui.Label({
  value: 'Monthly False Color (NIR) Time Series',
  style: { fontWeight: 'bold', fontSize: '18px' }
});
title.style().set('position', 'top-center');
Map.add(title);

var aoi = taj; // Replace with your AOI geometry or FeatureCollection
Map.centerObject(aoi, 10);

//========================================================================================
//                                CLOUD MASKING
//========================================================================================

/**
 * Cloud and cirrus masking for Sentinel-2 SR using QA60 band.
 * Returns scaled and selected NIR, Red, Green bands (B8, B4, B3).
 * @param {ee.Image} image - Sentinel-2 SR image.
 * @return {ee.Image} - Cloud-masked, scaled, and band-selected image.
 */
function maskS2clouds(image) {
  var qa = image.select('QA60');
  var cloudBitMask = ee.Number(2).pow(10).int();
  var cirrusBitMask = ee.Number(2).pow(11).int();
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
               .and(qa.bitwiseAnd(cirrusBitMask).eq(0));
  return image.updateMask(mask)
              .divide(10000)
              .select(["B3", "B4", "B8"]) // Green, Red, NIR
              .copyProperties(image, ["system:time_start"]);
}

//========================================================================================
//                      MONTHLY FALSE COLOR COLLECTION
//========================================================================================

/**
 * Builds a multi-year, monthly median composite ImageCollection (False Color: NIR, Red, Green).
 * @param {number} startYear - Start year (inclusive).
 * @param {number} endYear   - End year (inclusive).
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 * @return {ee.ImageCollection} - Collection of monthly composites with metadata.
 */
function monthlyFalseColorCollection(startYear, endYear, aoi) {
  var years = ee.List.sequence(startYear, endYear);

  var allImages = years.map(function(year) {
    year = ee.Number(year);
    var s2 = ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
      .filterBounds(aoi)
      .filterDate(ee.Date.fromYMD(year, 1, 1), ee.Date.fromYMD(year, 12, 31))
      .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', 10))
      .map(maskS2clouds);

    var monthly = ee.List.sequence(1, 12).map(function(month) {
      var start = ee.Date.fromYMD(year, month, 1);
      var end = start.advance(1, 'month');
      var collection = s2.filterDate(start, end);
      var composite = collection.median().clip(aoi);
      var count = collection.size();

      return ee.Algorithms.If(
        count.gt(0),
        composite.set({
          'year': year,
          'month': month,
          'count': count,
          'system:time_start': start.millis()
        }),
        ee.Image().set({
          'year': year,
          'month': month,
          'count': 0,
          'noData': 1,
          'system:time_start': start.millis()
        })
      );
    });

    return ee.ImageCollection.fromImages(monthly);
  });

  // Merge all years' collections
  return ee.ImageCollection(allImages.iterate(function(ic, prev) {
    return ee.ImageCollection(prev).merge(ic);
  }, ee.ImageCollection([])));
}

//========================================================================================
//                         FALSE COLOR GIF ANIMATION
//========================================================================================

/**
 * Creates an animated GIF for the monthly false color composites (NIR, Red, Green).
 * @param {ee.ImageCollection} images - Collection of false color monthly composites.
 * @param {ee.Geometry|ee.FeatureCollection} aoi - Area of interest.
 */
function createFalseColorGif(images, aoi) {
  var visParams = {
    min: 0,
    max: 0.3,
    bands: ['B8', 'B4', 'B3'] // NIR, Red, Green for false color
  };

  var gifParams = {
    region: aoi,
    dimensions: 600,
    crs: 'EPSG:3857',
    framesPerSecond: 2,
    format: 'gif',
    min: visParams.min,
    max: visParams.max,
    bands: visParams.bands
  };

  var filtered = images.filter(ee.Filter.neq('noData', 1)).sort('system:time_start');

  filtered.size().evaluate(function(size) {
    if (size > 0) {
      print(ui.Thumbnail(filtered, gifParams, 'False Color Animation'));
      print('📥 Download False Color GIF:', filtered.getVideoThumbURL(gifParams));
    } else {
      print('⚠️ No data available for animation.');
    }
  });
}

//========================================================================================
//                              IMAGE COUNT CHART
//========================================================================================

/**
 * Generates a column chart of monthly image counts (used in each composite).
 * @param {ee.ImageCollection} images - Collection with 'count' property.
 */
function createImageCountChart(images) {
  var chart = ui.Chart.feature.byFeature(images, 'system:time_start', ['count'])
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
//                                EXECUTION BLOCK
//========================================================================================

//---------------------- USER PARAMETERS ----------------------//
var startYear = 2022;  // Analysis start year
var endYear = 2024;    // Analysis end year

//------------------------------------------------------------//
var falseColorImages = monthlyFalseColorCollection(startYear, endYear, aoi);

// Add each monthly composite to map, print stats
falseColorImages
  .filter(ee.Filter.neq('noData', 1))
  .aggregate_array('system:time_start')
  .evaluate(function(timestamps) {
    timestamps.forEach(function(time) {
      var img = falseColorImages.filter(ee.Filter.eq('system:time_start', time)).first();
      img.get('count').evaluate(function(count) {
        var date = ee.Date(time).format('YYYY-MM').getInfo();
        print('Month:', date, '| Images used:', count);
        Map.addLayer(img, {min: 0, max: 0.3, bands: ['B8', 'B4', 'B3']}, 'False Color ' + date, false);
      });
    });
  });

// Output animated GIF and chart
createFalseColorGif(falseColorImages, aoi);
createImageCountChart(falseColorImages);
