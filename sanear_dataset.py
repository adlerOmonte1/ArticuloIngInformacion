"""
sanear_dataset.py
Une los CSV exportados desde Earth Engine (uno o varios bloques de años), los sanea
y deja UN solo dataset mensual por celda.

Uso (en la carpeta donde están los CSV):
    pip install pandas numpy
    python sanear_dataset.py
Opcional:
    python sanear_dataset.py --carpeta ./datos --ini 2015-01 --fin 2025-12

Entradas:  huanuco_mensual_*.csv  +  huanuco_estaticas.csv
Salidas:   dataset_huanuco_<ini>_<fin>.csv  +  reporte_saneamiento.txt
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd

VARIABLES = ["t2m", "tmin", "tmax", "hr", "pp_era5", "rad", "hum_suelo", "pp_chirps", "ndvi", "lst"]
OBJETIVOS = ["pp_chirps"]          # nunca se rellenan: un objetivo inventado contamina la evaluación
RANGOS = {                          # límites físicos para valores mensuales en Huánuco
    "t2m": (-15, 35), "tmin": (-25, 30), "tmax": (-5, 45), "hr": (5, 100),
    "pp_era5": (0, 2000), "pp_chirps": (0, 1500), "rad": (100, 1200),
    "hum_suelo": (0, 0.8), "ndvi": (-0.2, 1), "lst": (-20, 60),
}
UMBRAL_RAZON = 3.0                  # ERA5/CHIRPS > 3 o < 1/3 => celda con lluvia inconsistente


def interpolar(valores, t):
    """Interpola huecos de hasta 2 meses en la serie de una celda, respetando meses ausentes."""
    s = pd.Series(valores.values, index=t.values)
    completa = s.reindex(range(int(t.min()), int(t.max()) + 1))
    return completa.interpolate(limit=2, limit_area="inside").reindex(s.index).values


def main(carpeta, ini, fin):
    carpeta = Path(carpeta)
    lineas = []

    def log(s=""):
        print(s)
        lineas.append(s)

    archivos = sorted(carpeta.glob("huanuco_mensual_*.csv"))
    if not archivos:
        raise SystemExit(f"No hay archivos huanuco_mensual_*.csv en {carpeta.resolve()}")
    df = pd.concat([pd.read_csv(a) for a in archivos], ignore_index=True)
    est = pd.read_csv(carpeta / "huanuco_estaticas.csv").rename(columns={
        "elev_mean": "elev", "elev_stdDev": "rugosidad",
        "pendiente_mean": "pendiente", "orient_norte_mean": "orient_norte"})

    log("=" * 60)
    log(f"SANEAMIENTO DEL DATASET  {ini} a {fin}")
    log("=" * 60)
    log(f"Archivos: {', '.join(a.name for a in archivos)}")

    # 1. Duplicados (bloques de años superpuestos) y periodo
    n0 = len(df)
    df = df.drop_duplicates(["celda", "fecha"], keep="last")
    n_dup = n0 - len(df)
    df = df[(df.fecha >= ini) & (df.fecha <= fin)]
    log(f"\n1) Filas leídas: {n0:,} | duplicados eliminados: {n_dup:,}")
    log(f"   Filas dentro del periodo: {len(df):,}")

    # 2. Completitud: tabla celda x mes completa, los huecos quedan explícitos
    sin_estatica = sorted(set(df.celda) - set(est.celda))
    if sin_estatica:
        log(f"   AVISO: {len(sin_estatica)} celdas sin variables estáticas: {sin_estatica[:5]}")
    meses = pd.period_range(ini, fin, freq="M").strftime("%Y-%m")
    idx = pd.MultiIndex.from_product([sorted(est.celda), meses], names=["celda", "fecha"])
    df = (df.drop(columns=["lon", "lat"], errors="ignore")
            .set_index(["celda", "fecha"]).reindex(idx).reset_index())
    vacias = df[VARIABLES].isna().all(axis=1)
    log(f"\n2) Tabla completa: {est.celda.nunique()} celdas x {len(meses)} meses = {len(df):,} filas")
    if vacias.any():
        por_mes = df.loc[vacias].groupby("fecha").size()
        log(f"   Filas sin ningún dato: {vacias.sum():,} en meses {list(por_mes.index[:12])}")
        log("   -> vuelve a exportar esos meses desde Earth Engine")
    else:
        log("   OK: ningún mes ni celda falta por completo")

    # 3. Rangos físicos: lo imposible pasa a NaN
    log("\n3) Valores fuera de rango físico (pasan a NaN)")
    for c, (lo, hi) in RANGOS.items():
        fuera = df[c].notna() & ~df[c].between(lo, hi)
        df.loc[fuera, c] = np.nan
        log(f"   {c:<10} {int(fuera.sum()):>5}")

    # 4. Relleno de predictores: interpolación en el tiempo (máx. 2 meses) y luego
    #    climatología mensual de la misma celda. Los objetivos no se tocan.
    df = df.sort_values(["celda", "fecha"]).reset_index(drop=True)
    df["anio"] = df.fecha.str[:4].astype(int)
    df["mes"] = df.fecha.str[5:7].astype(int)
    # Las filas sin ningún dato NO se rellenan (sería inventar meses enteros): se excluyen.
    df = df[~df[VARIABLES].isna().all(axis=1)].sort_values(["celda", "fecha"]).reset_index(drop=True)
    df["t"] = df.anio * 12 + df.mes          # índice mensual continuo
    log("\n4) Huecos sueltos rellenados (interpolación | climatología | siguen vacíos)")
    for c in VARIABLES:
        n_nan = int(df[c].isna().sum())
        if c in OBJETIVOS:
            log(f"   {c:<10} objetivo: no se rellena ({n_nan} vacíos se excluyen al modelar)")
            continue
        if n_nan == 0:
            continue
        df[c] = np.concatenate([interpolar(g[c], g["t"]) for _, g in df.groupby("celda", sort=True)])
        n_interp = n_nan - int(df[c].isna().sum())
        antes = int(df[c].isna().sum())
        df[c] = df[c].fillna(df.groupby(["celda", "mes"])[c].transform("mean"))
        log(f"   {c:<10} {n_interp:>5} | {antes - int(df[c].isna().sum()):>5} | {int(df[c].isna().sum()):>5}")

    # 5. Coherencia de lluvia entre fuentes: se marca, no se borra
    ambas = df.pp_era5.notna() & df.pp_chirps.notna()
    tot = df[ambas].groupby("celda")[["pp_era5", "pp_chirps"]].sum()
    razon = (tot.pp_era5 / tot.pp_chirps).rename("razon_era5_chirps")
    df = df.merge(razon, on="celda", how="left")
    df["lluvia_inconsistente"] = ((df.razon_era5_chirps > UMBRAL_RAZON) |
                                  (df.razon_era5_chirps < 1 / UMBRAL_RAZON)).astype(int)
    malas = razon[(razon > UMBRAL_RAZON) | (razon < 1 / UMBRAL_RAZON)].sort_values(ascending=False)
    log(f"\n5) Razón ERA5/CHIRPS por celda: mediana {razon.median():.2f}, "
        f"rango {razon.min():.2f} a {razon.max():.2f}")
    log(f"   Celdas marcadas como lluvia inconsistente (> {UMBRAL_RAZON:g}x): {len(malas)}")
    for celda, r in malas.head(10).items():
        log(f"     {celda}  ERA5 = {r:.1f} x CHIRPS")
    log("   pp_era5 queda solo como predictor; el objetivo provisional es pp_chirps (luego PISCO)")

    # 6. Unir estáticas y guardar
    df = df.merge(est[["celda", "lon", "lat", "elev", "rugosidad", "pendiente", "orient_norte"]],
                  on="celda", how="left")
    columnas = (["celda", "lon", "lat", "fecha", "anio", "mes", "elev", "rugosidad", "pendiente",
                 "orient_norte"] + VARIABLES + ["razon_era5_chirps", "lluvia_inconsistente"])
    df = df[columnas]
    salida = carpeta / f"dataset_huanuco_{ini[:4]}_{fin[:4]}.csv"
    df.to_csv(salida, index=False, float_format="%.4f")

    log(f"\n6) DATASET FINAL: {salida.name}")
    log(f"   {len(df):,} filas | {df.celda.nunique()} celdas | {df.fecha.nunique()} meses "
        f"({df.fecha.min()} a {df.fecha.max()}) | {salida.stat().st_size / 1e6:.1f} MB")
    if df.fecha.nunique() < len(meses):
        log(f"   AVISO: faltan {len(meses) - df.fecha.nunique()} meses del periodo pedido (ver punto 2)")
    log(f"   Vacíos restantes en predictores: "
        f"{int(df[[v for v in VARIABLES if v not in OBJETIVOS]].isna().sum().sum())}")
    (carpeta / "reporte_saneamiento.txt").write_text("\n".join(lineas), encoding="utf-8")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--carpeta", default=".")
    ap.add_argument("--ini", default="2015-01")
    ap.add_argument("--fin", default="2025-12")
    a = ap.parse_args()
    main(a.carpeta, a.ini, a.fin)
