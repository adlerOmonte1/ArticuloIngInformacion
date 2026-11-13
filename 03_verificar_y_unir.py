"""
03_verificar_y_unir.py
Verifica que los datos estén completos y sean coherentes, y arma el dataset final.

Revisa:
  1. Completitud: 12 meses por año y todas las celdas en cada mes (detecta el "solo llega a mayo").
  2. Valores faltantes por variable.
  3. Rangos físicos plausibles (detecta errores de unidades: K vs °C, m vs mm, escalas MODIS).
  4. Coherencia de lluvia entre fuentes independientes (PISCO vs CHIRPS vs ERA5-Land).
  5. Climatología regional (debe verse la temporada de lluvias dic-mar y el estiaje jun-ago).

Salidas:
  reporte/reporte_calidad.txt, reporte/climatologia.png, reporte/serie_regional.png
  data/dataset_huanuco.csv
"""
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

DATA, OUT = Path("data"), Path("reporte")
OUT.mkdir(exist_ok=True)

RANGOS = {  # (mínimo, máximo) físicamente razonables para Huánuco, valores mensuales
    "t2m": (-15, 35), "tmin": (-25, 30), "tmax": (-5, 45), "hr": (5, 100),
    "pp_era5": (0, 1500), "pp_chirps": (0, 1500), "pp_pisco": (0, 1500),
    "rad": (100, 1200), "hum_suelo": (0, 0.8), "ndvi": (-0.2, 1), "lst": (-20, 60),
}
lineas = []


def log(s=""):
    print(s)
    lineas.append(s)


def completitud(nombre, df, n_celdas):
    log(f"\n[{nombre}] {df.fecha.min()} a {df.fecha.max()}")
    anio = df.fecha.str[:4].astype(int)
    mes = df.fecha.str[5:7].astype(int)
    problemas = 0
    for a in sorted(anio.unique()):
        sub = df[anio == a]
        presentes = set(mes[anio == a])
        faltan = sorted(set(range(1, 13)) - presentes)
        celdas_min = sub.groupby("fecha").celda.nunique().min()
        if faltan or celdas_min < n_celdas:
            problemas += 1
            log(f"  {a}: faltan meses {faltan}" if faltan else f"  {a}: completo en meses")
            if celdas_min < n_celdas:
                log(f"        algún mes tiene solo {celdas_min}/{n_celdas} celdas")
    if not problemas:
        log(f"  OK: todos los años con 12 meses y {n_celdas} celdas por mes")


def main():
    celdas = pd.read_csv(DATA / "celdas.csv")
    n = len(celdas)
    archivos = sorted((DATA / "gee").glob("anio_*.csv"))
    gee = pd.concat([pd.read_csv(p) for p in archivos], ignore_index=True)
    est = pd.read_csv(DATA / "estaticas.csv")
    pis = pd.read_csv(DATA / "pisco_mensual.csv")
    oni = pd.read_csv(DATA / "oni.csv")

    log("=" * 64)
    log("REPORTE DE CALIDAD DE DATOS - REGIÓN HUÁNUCO")
    log("=" * 64)
    log(f"Celdas de 0.1°: {n} | archivos GEE: {len(archivos)} | filas GEE: {len(gee):,}")

    log("\n1) COMPLETITUD")
    completitud("GEE", gee, n)
    completitud("PISCO", pis, n)
    dup = gee.duplicated(["celda", "fecha"]).sum() + pis.duplicated(["celda", "fecha"]).sum()
    log(f"\n  Filas duplicadas (celda, fecha): {dup}")

    df = (gee.merge(pis, on=["celda", "fecha"], how="left")
             .merge(est, on="celda", how="left")
             .merge(celdas, on="celda", how="left")
             .merge(oni, on="fecha", how="left"))

    log("\n2) VALORES FALTANTES (%)")
    for c in [c for c in RANGOS if c in df] + ["oni", "elev"]:
        pct = df[c].isna().mean() * 100
        log(f"  {c:<10} {pct:6.2f}%" + ("   <- revisar" if pct > 5 else ""))

    log("\n3) RANGOS FÍSICOS (mín / media / máx | fuera de rango)")
    for c, (lo, hi) in RANGOS.items():
        if c not in df:
            continue
        s = df[c].dropna()
        fuera = ((s < lo) | (s > hi)).sum()
        aviso = "   <- posible error de unidades" if fuera > 0.01 * len(s) else ""
        log(f"  {c:<10} {s.min():9.2f} / {s.mean():9.2f} / {s.max():9.2f} | {fuera}{aviso}")

    log("\n4) COHERENCIA DE LLUVIA ENTRE FUENTES (mensual, todas las celdas)")
    pp = df.dropna(subset=["pp_pisco", "pp_chirps", "pp_era5"])
    for c in ["pp_chirps", "pp_era5"]:
        r = pp["pp_pisco"].corr(pp[c])
        ratio = pp[c].mean() / pp["pp_pisco"].mean()
        aviso = "   <- revisar unidades" if not 0.5 < ratio < 2 else ""
        log(f"  PISCO vs {c:<10} r = {r:5.2f} | media {c}/PISCO = {ratio:4.2f}{aviso}")
    log("  (r > 0.7 y razón cercana a 1 indican que las fuentes cuentan lo mismo)")

    df["mes"] = df.fecha.str[5:7].astype(int)
    clim = df.groupby("mes")[["pp_pisco", "pp_chirps", "pp_era5", "t2m"]].mean()
    log("\n5) CLIMATOLOGÍA REGIONAL (promedio de todas las celdas)")
    log(clim.round(1).to_string())

    fig, ax = plt.subplots(figsize=(9, 4.5))
    ancho = 0.27
    for k, c in enumerate(["pp_pisco", "pp_chirps", "pp_era5"]):
        ax.bar(clim.index + (k - 1) * ancho, clim[c], ancho, label=c)
    ax.set(xlabel="Mes", ylabel="Precipitación (mm/mes)", xticks=range(1, 13),
           title="Climatología regional de Huánuco")
    ax2 = ax.twinx()
    ax2.plot(clim.index, clim["t2m"], "k-o", label="t2m")
    ax2.set_ylabel("Temperatura (°C)")
    fig.legend(loc="lower center", ncol=4, frameon=False)
    fig.tight_layout(rect=[0, 0.08, 1, 1])
    fig.savefig(OUT / "climatologia.png", dpi=150)

    serie = df.groupby("fecha")[["pp_pisco", "pp_chirps"]].mean()
    serie.index = pd.to_datetime(serie.index)
    fig, ax = plt.subplots(figsize=(11, 4))
    serie.plot(ax=ax, lw=1)
    ax.set(ylabel="mm/mes", title="Precipitación media regional (huecos = meses faltantes)")
    fig.tight_layout()
    fig.savefig(OUT / "serie_regional.png", dpi=150)

    columnas = ["celda", "lon", "lat", "fecha", "mes", "elev", "rugosidad", "pendiente", "orient_norte",
                "pp_pisco", "pp_chirps", "pp_era5", "t2m", "tmin", "tmax", "hr", "rad",
                "hum_suelo", "ndvi", "lst", "oni"]
    df = df.reindex(columns=columnas).sort_values(["celda", "fecha"])
    df.to_csv(DATA / "dataset_huanuco.csv", index=False)
    con_obj = df.dropna(subset=["pp_pisco"])
    log(f"\nDATASET FINAL: {len(df):,} filas | con objetivo PISCO: {len(con_obj):,} "
        f"({con_obj.fecha.min()} a {con_obj.fecha.max()})")
    log("Nota: ONI es una media de 3 meses centrada (incluye el mes siguiente); "
        "en el modelado úsalo con rezago >= 2.")

    (OUT / "reporte_calidad.txt").write_text("\n".join(lineas), encoding="utf-8")
    print(f"\nReporte: {OUT / 'reporte_calidad.txt'}")


if __name__ == "__main__":
    main()
