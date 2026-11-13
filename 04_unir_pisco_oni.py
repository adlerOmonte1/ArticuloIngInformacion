"""
04_unir_pisco_oni.py
Agrega al dataset saneado la variable objetivo PISCOp (SENAMHI, vía IRI Data Library)
y el índice ONI (El Niño, NOAA CPC).

Uso:
    python 04_unir_pisco_oni.py                      # usa dataset_huanuco_2015_2025.csv
    python 04_unir_pisco_oni.py --datos otro.csv
Si la descarga de PISCO falla, el script imprime la URL: ábrela en el navegador,
guarda el archivo como pisco_prec.nc en esta carpeta y vuelve a ejecutar.

Salida: dataset_modelo.csv  (= dataset saneado + pp_pisco + oni)
"""
import argparse
import calendar
import io
from pathlib import Path

import numpy as np
import pandas as pd
import requests

URL_PISCO = ("https://iridl.ldeo.columbia.edu/SOURCES/.SENAMHI/.HSR/.PISCO/.Prec/.v2p1/.unstable/.monthly/.Prec/"
             "X/(77.5W)/(74W)/RANGEEDGES/Y/(10.8S)/(8.2S)/RANGEEDGES/data.nc")
URL_ONI = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
SEAS_MES = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6,
            "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10, "OND": 11, "NDJ": 12}


def descargar(url, destino):
    if destino.exists():
        return
    r = requests.get(url, timeout=600)
    r.raise_for_status()
    destino.write_bytes(r.content)


def leer_pisco(celdas):
    import xarray as xr
    nc = Path("pisco_prec.nc")
    try:
        descargar(URL_PISCO, nc)
    except Exception as e:
        raise SystemExit(f"No se pudo descargar PISCO ({e}).\n"
                         f"Abre esta URL, guarda el archivo como {nc} aquí y vuelve a ejecutar:\n{URL_PISCO}")
    ds = xr.open_dataset(nc, decode_times=False)          # IRI: "months since 1960-01-01"
    var = "Prec" if "Prec" in ds.data_vars else list(ds.data_vars)[0]
    unidades = str(ds[var].attrs.get("units", "?"))
    df = ds[var].to_dataframe(name="pp_pisco").reset_index()
    meses = {t: (pd.Timestamp("1960-01-01") + pd.DateOffset(months=int(np.floor(t)))).strftime("%Y-%m")
             for t in np.unique(df["T"])}
    df["fecha"] = df["T"].map(meses)
    df["X"] = np.where(df["X"] > 180, df["X"] - 360, df["X"])
    df["celda"] = df["X"].round(2).map("{:.2f}".format) + "_" + df["Y"].round(2).map("{:.2f}".format)
    if "day" in unidades.lower():                         # mm/día -> mm/mes
        dias = df["fecha"].map(lambda f: calendar.monthrange(int(f[:4]), int(f[5:]))[1])
        df["pp_pisco"] *= dias
    df = df[df.celda.isin(celdas)][["celda", "fecha", "pp_pisco"]]
    print(f"PISCO: unidades '{unidades}', {df.celda.nunique()}/{len(celdas)} celdas, "
          f"{df.fecha.min()} a {df.fecha.max()}")
    faltan = set(celdas) - set(df.celda)
    if faltan:
        print(f"AVISO: {len(faltan)} celdas sin PISCO: {sorted(faltan)[:5]}")
    return df


def leer_oni():
    try:
        txt = requests.get(URL_ONI, timeout=60).text
    except Exception as e:
        raise SystemExit(f"No se pudo descargar ONI ({e}). Descarga {URL_ONI} como oni.ascii.txt aquí.")
    df = pd.read_csv(io.StringIO(txt), sep=r"\s+")
    df["fecha"] = df["YR"].astype(str) + "-" + df["SEAS"].map(SEAS_MES).map("{:02d}".format)
    print(f"ONI: {df.fecha.min()} a {df.fecha.max()}")
    return df[["fecha", "ANOM"]].rename(columns={"ANOM": "oni"})


def main(datos):
    base = pd.read_csv(datos)
    pisco = leer_pisco(base.celda.unique())
    oni = leer_oni()
    df = base.merge(pisco, on=["celda", "fecha"], how="left").merge(oni, on="fecha", how="left")

    # Control de coherencia: PISCO frente a CHIRPS (deberían parecerse; PISCO incluye estaciones)
    ok = df.pp_pisco.notna() & df.pp_chirps.notna()
    r = df.loc[ok, "pp_pisco"].corr(df.loc[ok, "pp_chirps"])
    razon = df.loc[ok, "pp_chirps"].mean() / df.loc[ok, "pp_pisco"].mean()
    print(f"PISCO vs CHIRPS: r = {r:.2f}, media CHIRPS/PISCO = {razon:.2f}"
          + ("   <- revisar unidades" if not 0.5 < razon < 2 else ""))
    print(f"Filas con objetivo PISCO: {ok.sum():,} de {len(df):,}")

    df.to_csv("dataset_modelo.csv", index=False, float_format="%.4f")
    print("Guardado: dataset_modelo.csv")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="dataset_huanuco_2015_2025.csv")
    main(ap.parse_args().datos)
