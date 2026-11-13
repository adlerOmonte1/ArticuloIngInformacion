"""
02_descargar_pisco_oni.py
Descarga la variable objetivo (PISCOp mensual, SENAMHI, vía IRI Data Library) recortada a Huánuco
y el índice ONI (El Niño, NOAA CPC). Requiere haber ejecutado 01 (usa data/celdas.csv).

Salidas:
  data/pisco_mensual.csv   celda, fecha, pp_pisco (mm/mes)
  data/oni.csv             fecha, oni
"""
import calendar
import io
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import xarray as xr

DATA = Path("data")
ANIO_INI = 2001
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


def pisco(celdas):
    nc = DATA / "pisco_prec.nc"
    try:
        descargar(URL_PISCO, nc)
    except Exception as e:
        raise SystemExit(
            f"No se pudo descargar PISCO ({e}).\n"
            f"Abre esta URL en el navegador, guarda el archivo como {nc} y vuelve a ejecutar:\n{URL_PISCO}")

    ds = xr.open_dataset(nc, decode_times=False)        # IRI usa "months since 1960-01-01"
    var = "Prec" if "Prec" in ds.data_vars else list(ds.data_vars)[0]
    unidades = str(ds[var].attrs.get("units", "?"))
    print(f"PISCO: variable '{var}', unidades '{unidades}', dims {dict(ds[var].sizes)}")

    df = ds[var].to_dataframe(name="pp_pisco").reset_index()
    meses = {t: (pd.Timestamp("1960-01-01") + pd.DateOffset(months=int(np.floor(t)))).strftime("%Y-%m")
             for t in np.unique(df["T"])}
    df["fecha"] = df["T"].map(meses)
    df["X"] = np.where(df["X"] > 180, df["X"] - 360, df["X"])
    df["celda"] = df["X"].round(2).map("{:.2f}".format) + "_" + df["Y"].round(2).map("{:.2f}".format)

    if "day" in unidades.lower():                       # mm/día -> mm/mes
        dias = df["fecha"].map(lambda f: calendar.monthrange(int(f[:4]), int(f[5:]))[1])
        df["pp_pisco"] = df["pp_pisco"] * dias
        print("PISCO venía en mm/día: convertido a mm/mes")

    df = df[df["celda"].isin(celdas) & (df["fecha"] >= f"{ANIO_INI}-01")]
    faltan = set(celdas) - set(df["celda"])
    if faltan:
        print(f"AVISO: {len(faltan)} celdas sin PISCO (revisa alineación de grilla): {sorted(faltan)[:5]}...")
    df[["celda", "fecha", "pp_pisco"]].sort_values(["fecha", "celda"]).to_csv(DATA / "pisco_mensual.csv", index=False)
    print(f"PISCO: {df.fecha.min()} a {df.fecha.max()}, {df.celda.nunique()} celdas, {len(df)} filas")


def oni():
    txt = requests.get(URL_ONI, timeout=60).text
    df = pd.read_csv(io.StringIO(txt), sep=r"\s+")
    df["fecha"] = df["YR"].astype(str) + "-" + df["SEAS"].map(SEAS_MES).map("{:02d}".format)
    df = df[df["fecha"] >= f"{ANIO_INI - 1}-01"]
    df[["fecha", "ANOM"]].rename(columns={"ANOM": "oni"}).to_csv(DATA / "oni.csv", index=False)
    print(f"ONI: {df.fecha.min()} a {df.fecha.max()}")


if __name__ == "__main__":
    celdas = pd.read_csv(DATA / "celdas.csv")["celda"].tolist()
    pisco(celdas)
    oni()
