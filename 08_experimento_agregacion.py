"""
08_experimento_agregacion.py
¿Mejora la predictibilidad al agregar en el tiempo (total de 3 meses) y en el espacio (zona climática)?

Compara 4 escalas con el mismo protocolo walk-forward de 07_modelo_pisco.py (prueba 2016–2025):
    celda × mes        (lo que hoy usa el modelo operativo)
    celda × trimestre  (total de los 3 meses siguientes: t+1..t+3)
    zona  × mes        (lluvia media de las celdas de la zona; zonas K-means de 06_mapas_zonas.py)
    zona  × trimestre
Modelos: Climatología, Persistencia, XGBoost y Ridge (lineal regularizado), todos sobre la anomalía
estandarizada. Predictores = rezagos de la anomalía MENSUAL y estacionalidad (variante ganadora en 07).

Métricas: SS frente a climatología (mm), ACC (correlación de anomalías), RPSS por terciles
(residuos fuera de muestra: los de los otros años) y años con SS > 0.

Uso:  python 08_experimento_agregacion.py            (≈ 1 min)
Salida: resultados_pisco/experimento_agregacion.csv
"""
import argparse
import importlib.util
import time
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV

spec = importlib.util.spec_from_file_location("m07", Path(__file__).with_name("07_modelo_pisco.py"))
m07 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m07)

COLS = m07.REZAGOS + m07.ESTACION


def por_zona(df, zonas):
    z = df.merge(zonas, on="celda")
    g = z.groupby(["zona", "fecha"], as_index=False).agg(pp=("pp", "mean"), lon=("lon", "mean"),
                                                         lat=("lat", "mean"), elev=("elev", "mean"))
    g["celda"] = "zona_" + g.zona.astype(str)
    g["anio"], g["mes"] = g.fecha.str[:4].astype(int), g.fecha.str[5:7].astype(int)
    g["t"] = g.anio * 12 + g.mes - 1
    return g.drop(columns="zona").sort_values(["celda", "t"]).reset_index(drop=True)


def objetivo(df, corte, trimestral):
    """Estadísticos del objetivo indexados por (celda, fecha final). Mensual = pp; trimestral = suma de 3 meses."""
    a = df[["celda", "fecha", "mes", "t", "pp"]].copy()
    if trimestral:
        a["pp"] = a.groupby("celda").pp.transform(lambda s: s.rolling(3).sum())
    a, _ = m07.variables(a.assign(lon=0, lat=0, elev=0), corte)
    return a[["celda", "t", "pp", "normal", "sd", "q33", "q67", "z"]]


def filas_modelo(df, corte, trimestral, h):
    d, _ = m07.variables(df, corte)                       # predictores: anomalías mensuales hasta t
    y = objetivo(df, corte, trimestral)
    y = y.assign(t=y.t - h).add_suffix("_obj").rename(columns={"celda_obj": "celda", "t_obj": "t"})
    out = d.merge(y, on=["celda", "t"])
    mes_fin = (out.mes - 1 + h) % 12 + 1
    out["mes_sin"], out["mes_cos"] = np.sin(2 * np.pi * mes_fin / 12), np.cos(2 * np.pi * mes_fin / 12)
    out["fecha_obj"] = (pd.PeriodIndex(out.fecha, freq="M") + h).strftime("%Y-%m")
    return out.dropna(subset=COLS + ["z_obj"])


def evaluar(df, trimestral, anios, etiqueta):
    horizontes = [3] if trimestral else [1, 2, 3]          # trimestral: total t+1..t+3 (fecha final t+3)
    preds = []
    for k in anios:
        val_ini, test_ini, test_fin = f"{k - 1}-01", f"{k}-01", f"{k}-12"
        for h in horizontes:
            d = filas_modelo(df, val_ini, trimestral, h)
            tr = d[d.fecha_obj < val_ini]
            va = d[(d.fecha_obj >= val_ini) & (d.fecha_obj < test_ini)]
            te = d[(d.fecha_obj >= test_ini) & (d.fecha_obj <= test_fin)]
            if te.empty:
                continue
            xgb = m07.nuevo_xgb().fit(tr[COLS], tr.z_obj, eval_set=[(va[COLS], va.z_obj)], verbose=False)
            rid = RidgeCV(alphas=np.logspace(-2, 3, 12)).fit(tr[COLS], tr.z_obj)
            p = te[["celda", "fecha_obj", "pp_obj", "normal_obj", "sd_obj", "q33_obj", "q67_obj", "z_obj"]].assign(
                h=h, anio=k, Climatologia=0.0, Persistencia=te.z_l0.values if not trimestral else te.z_m3.values,
                XGBoost=xgb.predict(te[COLS]), Ridge=rid.predict(te[COLS]))
            preds.append(p)
    pr = pd.concat(preds, ignore_index=True)

    filas = []
    for h in horizontes:
        ph = pr[pr.h == h]
        cat = np.where(ph.pp_obj < ph.q33_obj, 0, np.where(ph.pp_obj > ph.q67_obj, 2, 1))
        for mod in ("Climatologia", "Persistencia", "XGBoost", "Ridge"):
            sim = m07.a_mm(ph.normal_obj.values, ph.sd_obj.values, ph[mod].values)
            met = m07.metricas(ph.pp_obj.values, sim, ph.normal_obj.values)
            ss_anio = [m07.metricas(g.pp_obj.values, m07.a_mm(g.normal_obj.values, g.sd_obj.values, g[mod].values),
                                    g.normal_obj.values)["SS_clim"] for _, g in ph.groupby("anio")]
            res_z = (ph.z_obj - ph[mod]).values
            rp = np.zeros(len(ph))
            for k in anios:
                en = (ph.anio == k).values
                if en.any():
                    pb, pn, _ = m07.prob_terciles(ph.normal_obj.values[en], ph.sd_obj.values[en],
                                                  ph.q33_obj.values[en], ph.q67_obj.values[en],
                                                  ph[mod].values[en], res_z[~en])
                    rp[en] = m07.rps(pb, pn, cat[en])
            rp_ref = m07.rps(np.full(len(ph), 1 / 3), np.full(len(ph), 1 / 3), cat)
            filas.append({"escala": etiqueta, "h": ("t+1..t+3" if trimestral else f"t+{h}"), "modelo": mod,
                          "n": len(ph), "SS_clim": met["SS_clim"], "ACC": met["ACC"], "RMSE": met["RMSE"],
                          "RPSS": 1 - rp.mean() / rp_ref.mean(),
                          "anios_SS_pos": f"{sum(s > 0 for s in ss_anio)}/{len(ss_anio)}"})
    return filas


def main(a):
    t0 = time.time()
    est = m07.leer_estaticas()
    df = m07.panel(m07.leer_pisco(a.pisco, est.celda.unique()), est, None, a.ini)
    zonas = pd.read_csv("resultados/zonas.csv")[["celda", "zona"]]
    dz = por_zona(df, zonas)
    i, f = (int(x) for x in a.anios.split("-"))
    anios = list(range(i, f + 1))

    filas = []
    for etiqueta, datos, trim in (("celda × mes", df, False), ("celda × trimestre", df, True),
                                  ("zona × mes", dz, False), ("zona × trimestre", dz, True)):
        filas += evaluar(datos, trim, anios, etiqueta)
        print(f"   {etiqueta} listo ({time.time() - t0:.0f}s)")
    res = pd.DataFrame(filas)
    Path("resultados_pisco").mkdir(exist_ok=True)
    res.to_csv("resultados_pisco/experimento_agregacion.csv", index=False, float_format="%.4f")

    pd.set_option("display.width", 160)
    ml = res[res.modelo.isin(["XGBoost", "Ridge", "Persistencia"])]
    for col in ("SS_clim", "ACC", "RPSS"):
        print(f"\n{col}  (prueba walk-forward {anios[0]}–{anios[-1]}):")
        print(ml.pivot_table(index=["escala", "h"], columns="modelo", values=col, sort=False).round(3).to_string())
    print("\nAños con SS > 0:")
    print(ml.pivot_table(index=["escala", "h"], columns="modelo", values="anios_SS_pos",
                         aggfunc="first", sort=False).to_string())
    print(f"\nListo en {time.time() - t0:.0f}s → resultados_pisco/experimento_agregacion.csv")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pisco", default="pisco_prec.nc")
    ap.add_argument("--ini", default="1981-01")
    ap.add_argument("--anios", default="2016-2025")
    main(ap.parse_known_args()[0])
