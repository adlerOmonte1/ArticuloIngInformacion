// =====================================================================
// Predicción climática Huánuco — extracción mensual por celda (PRUEBA 5 AÑOS)
// Pegar en https://code.earthengine.google.com y presionar Run.
// Todo se agrega en el servidor: sale un CSV de ~3 MB, no rásters de GB.
// =====================================================================

// ---------- Parámetros (para ampliar el periodo, cambia solo los años) ----------
var ANIO_INI = 2020;
var ANIO_FIN = 2024;
var RES = 0.1;                               // grados, misma grilla que PISCO
var BBOX = [-77.5, -10.8, -74.0, -8.2];      // lon_min, lat_min, lon_max, lat_max
var ESCALA = 1000;                           // m
var CARPETA = 'prediccion_huanuco';          // carpeta de Google Drive

var BANDAS_ERA5 = ['t2m', 'tmin', 'tmax', 'hr', 'pp_era5', 'rad', 'hum_suelo'];
var COLUMNAS = ['celda', 'lon', 'lat', 'fecha'].concat(BANDAS_ERA5, ['pp_chirps', 'ndvi', 'lst']);

// ---------- 1. Departamento y grilla de 0.1° ----------
var huanuco = ee.Feature(ee.FeatureCollection('FAO/GAUL/2015/level1')
  .filterBounds(ee.Geometry.Point(-76.24, -9.93)).first()).geometry();

var celdas = [];
var nx = Math.round((BBOX[2] - BBOX[0]) / RES);
var ny = Math.round((BBOX[3] - BBOX[1]) / RES);
for (var i = 0; i < nx; i++) {
  for (var j = 0; j < ny; j++) {
    var x0 = Math.round((BBOX[0] + i * RES) * 100) / 100;
    var y0 = Math.round((BBOX[1] + j * RES) * 100) / 100;
    var cx = Math.round((x0 + RES / 2) * 100) / 100;
    var cy = Math.round((y0 + RES / 2) * 100) / 100;
    celdas.push(ee.Feature(
      ee.Geometry.Rectangle([x0, y0, x0 + RES, y0 + RES], null, false),
      {celda: cx.toFixed(2) + '_' + cy.toFixed(2), lon: cx, lat: cy}));
  }
}
var grilla = ee.FeatureCollection(celdas).filterBounds(huanuco);

// ---------- 2. Imagen mensual con unidades ya convertidas ----------
// Si falta un mes, sale vacío (NaN) en lugar de romper el script.
function conVacio(col, bandas) {
  var ceros = bandas.map(function () { return 0; });
  var vacio = ee.Image.constant(ceros).rename(bandas).toFloat().updateMask(0);
  return col.map(function (img) { return img.toFloat(); }).merge(ee.ImageCollection([vacio]));
}

function convertirEra5(img) {
  var t = img.select('temperature_2m').subtract(273.15);             // K -> °C
  var td = img.select('dewpoint_temperature_2m').subtract(273.15);   // K -> °C
  var hr = td.expression(                                            // humedad relativa %, Magnus
    '100 * exp(17.625 * td / (243.04 + td)) / exp(17.625 * t / (243.04 + t))',
    {td: td, t: t}).min(100);
  return ee.Image.cat([
    t.rename('t2m'),
    img.select('temperature_2m_min').subtract(273.15).rename('tmin'),
    img.select('temperature_2m_max').subtract(273.15).rename('tmax'),
    hr.rename('hr'),
    img.select('total_precipitation_sum').multiply(1000).rename('pp_era5'),        // m -> mm/mes
    img.select('surface_solar_radiation_downwards_sum').divide(1e6).rename('rad'),  // J/m2 -> MJ/m2
    img.select('volumetric_soil_water_layer_1').rename('hum_suelo')                 // m3/m3
  ]);
}

function imagenMes(ini) {
  var fin = ini.advance(1, 'month');
  var era5 = conVacio(ee.ImageCollection('ECMWF/ERA5_LAND/MONTHLY_AGGR')
    .filterDate(ini, fin).map(convertirEra5), BANDAS_ERA5).mean();
  var chirps = conVacio(ee.ImageCollection('UCSB-CHG/CHIRPS/PENTAD')
    .filterDate(ini, fin).select(['precipitation'], ['pp_chirps']), ['pp_chirps']).sum();      // mm/mes
  var ndvi = conVacio(ee.ImageCollection('MODIS/061/MOD13A3')
    .filterDate(ini, fin).select(['NDVI'], ['ndvi']), ['ndvi']).mean().multiply(0.0001);
  var lst = conVacio(ee.ImageCollection('MODIS/061/MOD11A2')
    .filterDate(ini, fin).select(['LST_Day_1km'], ['lst']), ['lst']).mean()
    .multiply(0.02).subtract(273.15);                                                        // -> °C
  return ee.Image.cat([era5, chirps, ndvi, lst])
    .set({'system:time_start': ini.millis(), fecha: ini.format('YYYY-MM')});
}

var nMeses = (ANIO_FIN - ANIO_INI + 1) * 12;
var coleccion = ee.ImageCollection.fromImages(
  ee.List.sequence(0, nMeses - 1).map(function (k) {
    return imagenMes(ee.Date.fromYMD(ANIO_INI, 1, 1).advance(k, 'month'));
  }));

// ---------- 3. Tabla: un promedio por celda y por mes ----------
var tabla = coleccion.map(function (img) {
  return img.reduceRegions({collection: grilla, reducer: ee.Reducer.mean(),
                            scale: ESCALA, tileScale: 2})
    .map(function (f) { return f.set('fecha', img.get('fecha')).setGeometry(null); });
}).flatten();

// ---------- 4. Variables del terreno (fijas por celda) ----------
var dem = ee.Image('USGS/SRTMGL1_003').select('elevation');
var ter = ee.Terrain.products(dem);
var imgTerreno = ee.Image.cat([
  dem.rename('elev'),
  ter.select('slope').rename('pendiente'),
  ter.select('aspect').multiply(Math.PI / 180).cos().rename('orient_norte')
]);
var estaticas = imgTerreno.reduceRegions({
  collection: grilla,
  reducer: ee.Reducer.mean().combine(ee.Reducer.stdDev(), null, true),
  scale: 250, tileScale: 4
}).map(function (f) { return f.setGeometry(null); });

// ---------- 5. VERIFICACIÓN antes de exportar (revisar la Console) ----------
print('Celdas en Huánuco (esperado ~300-380):', grilla.size());
print('Meses a extraer (esperado ' + nMeses + '):', coleccion.size());
print('Filas esperadas en el CSV:', grilla.size().multiply(nMeses));
print('Vista previa (revisa que las unidades sean lógicas):', tabla.limit(3));

print(ui.Chart.image.series({
  imageCollection: coleccion.select(['pp_chirps', 'pp_era5']),
  region: huanuco, reducer: ee.Reducer.mean(), scale: 5000
}).setOptions({title: 'Lluvia media regional (mm/mes) — deben verse ' + nMeses + ' puntos sin huecos',
               lineWidth: 1, pointSize: 3}));

print(ui.Chart.image.series({
  imageCollection: coleccion.select(['t2m', 'tmin', 'tmax']),
  region: huanuco, reducer: ee.Reducer.mean(), scale: 5000
}).setOptions({title: 'Temperatura media regional (°C)', lineWidth: 1, pointSize: 3}));

Map.centerObject(huanuco, 8);
Map.addLayer(coleccion.first().select('pp_chirps'),
             {min: 0, max: 300, palette: ['ffffff', '9ecae1', '08519c']}, 'Lluvia CHIRPS (primer mes)');
Map.addLayer(grilla.style({color: '0000ff', fillColor: '00000000', width: 1}), {}, 'Grilla 0.1°');
Map.addLayer(ee.Image().paint(huanuco, 0, 2), {palette: ['ff0000']}, 'Límite Huánuco');

// ---------- 6. Exportación a Google Drive (se ejecuta desde la pestaña Tasks) ----------
Export.table.toDrive({
  collection: tabla,
  description: 'huanuco_mensual_' + ANIO_INI + '_' + ANIO_FIN,
  folder: CARPETA,
  fileFormat: 'CSV',
  selectors: COLUMNAS
});

Export.table.toDrive({
  collection: estaticas,
  description: 'huanuco_estaticas',
  folder: CARPETA,
  fileFormat: 'CSV',
  selectors: ['celda', 'lon', 'lat', 'elev_mean', 'elev_stdDev', 'pendiente_mean', 'orient_norte_mean']
});
