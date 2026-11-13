"""
01_extraer_gee.py
Extrae de Google Earth Engine variables MENSUALES por celda de 0.1° (grilla alineada con PISCO)
para la región Huánuco. Todo se agrega en el servidor de GEE: se descargan tablas de pocos MB,
no rásters de GB. Se puede volver a ejecutar: los años ya descargados se saltan.

Salidas:
  data/celdas.csv          celda, lon, lat
  data/estaticas.csv       celda, elev, rugosidad, pendiente, orient_norte
  data/gee/anio_YYYY.csv   celda, fecha + variables mensuales (un archivo por año)
"""
import time
from pathlib import Path

import ee
import numpy as np
import pandas as pd

PROYECTO_GEE = "tu-proyecto-gcp"    # <- CAMBIA ESTO por el ID de tu proyecto de Google Cloud
ANIO_INI, ANIO_FIN = 2001, 2025
RES = 0.1                            # grados (igual que PISCO)
BBOX = (-77.5, -10.8, -74.0, -8.2)   # lon_min, lat_min, lon_max, lat_max (Huánuco con margen)
ESCALA = 1000                        # m, escala de cálculo de promedios mensuales

DATA = Path("data")
(DATA / "gee").mkdir(parents=True, exist_ok=True)

BANDAS_ERA5 = ["t2m", "tmin", "tmax", "hr", "pp_era5", "rad", "hum_suelo"]
COLUMNAS = BANDAS_ERA5 + ["pp_chirps", "ndvi", "lst"]


# ---------- Grilla ----------
def departamento():
    """Polígono del departamento que contiene la ciudad de Huánuco."""
    punto = ee.Geometry.Point(-76.24, -9.93)
    return ee.FeatureCollection("FAO/GAUL/2015/level1").filterBounds(punto).first().geometry()


def crear_grilla():
    nx = int(round((BBOX[2] - BBOX[0]) / RES))
    ny = int(round((BBOX[3] - BBOX[1]) / RES))
    feats = []
    for i in range(nx):
        x0 = round(BBOX[0] + i * RES, 2)
        for j in range(ny):
            y0 = round(BBOX[1] + j * RES, 2)
            cx, cy = round(x0 + RES / 2, 2), round(y0 + RES / 2, 2)
            geom = ee.Geometry.Rectangle([x0, y0, round(x0 + RES, 2), round(y0 + RES, 2)], None, False)
            feats.append(ee.Feature(geom, {"celda": f"{cx:.2f}_{cy:.2f}", "lon": cx, "lat": cy}))
    return ee.FeatureCollection(feats).filterBounds(departamento())


# ---------- Imagen mensual con unidades convertidas ----------
def con_vacio(col, bandas):
    """Agrega una imagen enmascarada: si falta el mes, el resultado sale NaN en vez de error."""
    vacio = ee.Image.constant([0] * len(bandas)).rename(bandas).toFloat().updateMask(0)
    return col.map(lambda i: i.toFloat()).merge(ee.ImageCollection([vacio]))


def convertir_era5(img):
    t = img.select("temperature_2m").subtract(273.15)              # K -> °C
    td = img.select("dewpoint_temperature_2m").subtract(273.15)    # K -> °C
    hr = td.expression(                                            # humedad relativa (Magnus), %
        "100 * exp(17.625 * td / (243.04 + td)) / exp(17.625 * t / (243.04 + t))",
        {"td": td, "t": t}).min(100)
    return ee.Image.cat([
        t.rename("t2m"),
        img.select("temperature_2m_min").subtract(273.15).rename("tmin"),
        img.select("temperature_2m_max").subtract(273.15).rename("tmax"),
        hr.rename("hr"),
        img.select("total_precipitation_sum").multiply(1000).rename("pp_era5"),        # m -> mm/mes
        img.select("surface_solar_radiation_downwards_sum").divide(1e6).rename("rad"),  # J/m² -> MJ/m²
        img.select("volumetric_soil_water_layer_1").rename("hum_suelo"),                # m³/m³
    ])


def imagen_mes(anio, mes):
    ini = ee.Date.fromYMD(anio, mes, 1)
    fin = ini.advance(1, "month")
    era5 = con_vacio(
        ee.ImageCollection("ECMWF/ERA5_LAND/MONTHLY_AGGR").filterDate(ini, fin).map(convertir_era5),
        BANDAS_ERA5).mean()
    chirps = con_vacio(
        ee.ImageCollection("UCSB-CHG/CHIRPS/PENTAD").filterDate(ini, fin)
        .select(["precipitation"], ["pp_chirps"]), ["pp_chirps"]).sum()                 # mm/mes
    ndvi = con_vacio(
        ee.ImageCollection("MODIS/061/MOD13A3").filterDate(ini, fin)
        .select(["NDVI"], ["ndvi"]), ["ndvi"]).mean().multiply(0.0001)                  # escala MODIS
    lst = con_vacio(
        ee.ImageCollection("MODIS/061/MOD11A2").filterDate(ini, fin)
        .select(["LST_Day_1km"], ["lst"]), ["lst"]).mean().multiply(0.02).subtract(273.15)  # -> °C
    return ee.Image.cat([era5, chirps, ndvi, lst])


# ---------- Reducción por celda ----------
def poner_fecha(fecha):
    return lambda f: f.set("fecha", fecha).setGeometry(None)


def a_tabla(fc):
    return pd.DataFrame([f["properties"] for f in fc.getInfo()["features"]])


def tabla_bloque(grilla, anio, meses):
    fcs = []
    for m in meses:
        fc = imagen_mes(anio, m).reduceRegions(
            collection=grilla, reducer=ee.Reducer.mean(), scale=ESCALA, tileScale=2)
        fcs.append(fc.map(poner_fecha(f"{anio}-{m:02d}")))
    return a_tabla(ee.FeatureCollection(fcs).flatten())


def estaticas(grilla):
    dem = ee.Image("USGS/SRTMGL1_003").select("elevation")
    ter = ee.Terrain.products(dem)
    img = ee.Image.cat([
        dem.rename("elev"),
        ter.select("slope").rename("pendiente"),
        ter.select("aspect").multiply(np.pi / 180).cos().rename("orient_norte"),
    ])
    red = ee.Reducer.mean().combine(ee.Reducer.stdDev(), sharedInputs=True)
    df = a_tabla(img.reduceRegions(collection=grilla, reducer=red, scale=250, tileScale=4))
    return df[["celda", "elev_mean", "elev_stdDev", "pendiente_mean", "orient_norte_mean"]].rename(
        columns={"elev_mean": "elev", "elev_stdDev": "rugosidad",
                 "pendiente_mean": "pendiente", "orient_norte_mean": "orient_norte"})


def con_reintentos(fn, *args, intentos=4):
    for k in range(intentos):
        try:
            return fn(*args)
        except ee.EEException as e:
            espera = 15 * (k + 1)
            print(f"   aviso: {e} -> reintento en {espera}s")
            time.sleep(espera)
    raise RuntimeError(f"Falló tras {intentos} intentos: {fn.__name__}{args[1:]}")


def main():
    try:
        ee.Initialize(project=PROYECTO_GEE)
    except Exception:
        ee.Authenticate()
        ee.Initialize(project=PROYECTO_GEE)

    grilla = crear_grilla()
    celdas = a_tabla(grilla)[["celda", "lon", "lat"]].sort_values(["lat", "lon"])
    celdas.to_csv(DATA / "celdas.csv", index=False)
    print(f"Celdas de 0.1° en Huánuco: {len(celdas)}")

    if not (DATA / "estaticas.csv").exists():
        con_reintentos(estaticas, grilla).to_csv(DATA / "estaticas.csv", index=False)
        print("Variables estáticas guardadas")

    for anio in range(ANIO_INI, ANIO_FIN + 1):
        destino = DATA / "gee" / f"anio_{anio}.csv"
        if destino.exists():
            print(f"{anio}: ya existe, se salta")
            continue
        t0 = time.time()
        partes = [con_reintentos(tabla_bloque, grilla, anio, list(meses))
                  for meses in (range(1, 7), range(7, 13))]   # 2 bloques: evita el límite de 5000 elementos
        df = pd.concat(partes).reindex(columns=["celda", "fecha"] + COLUMNAS)
        df.sort_values(["fecha", "celda"]).to_csv(destino, index=False)
        print(f"{anio}: {df.fecha.nunique()} meses, {len(df)} filas ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
