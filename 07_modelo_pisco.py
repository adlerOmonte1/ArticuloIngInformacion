"""
07_modelo_pisco.py
Modelo operativo de pronóstico mensual de lluvia que usa SOLO PISCOp (+ ONI opcional).

Por qué existe:
  - En 05_modelar.py la ablación mostró que el modelo con solo rezagos de lluvia y estacionalidad
    generaliza mejor que el modelo con 37 predictores (SS +0.010 frente a −0.115 en prueba 2023–2025).
  - PISCOp cubre 1981 → presente, mientras que los predictores de Earth Engine solo llegan a dic-2025.
    Sin depender de GEE, la serie pasa de 11 a ~45 años (varios El Niño: 1982-83, 1997-98, 2015-16, 2023-24)
    y el pronóstico se puede emitir desde el último mes de PISCO.

Diseño:
  - Objetivo: anomalía ESTANDARIZADA z = (lluvia − normal) / desviación, por celda y mes calendario.
    La normal, la desviación y los terciles se calculan SOLO con el periodo de entrenamiento de cada pliegue.
  - Predictores en el mes t: z en t, t−1, t−2, t−3, t−11; medias móviles de 3 y 6 meses;
    seno/coseno del mes objetivo; (variante) ONI con rezago 2 y 3; (variante) lon, lat, altitud.
  - Algoritmos: Ridge (lineal regularizado) y XGBoost. En 08_experimento_agregacion.py Ridge duplicó la
    habilidad de XGBoost: con poca información independiente la relación es casi lineal.
  - Evaluación walk-forward: para cada año k de prueba se entrena con todo lo anterior a k−1,
    se valida en k−1 (parada temprana) y se prueba en k.
  - Métricas en mm: RMSE, MAE, R², KGE, ACC (correlación de anomalías) y SS frente a la climatología.
  - Pronóstico probabilístico por terciles (bajo / normal / sobre lo normal) a partir de los errores
    fuera de muestra del walk-forward; se verifica con RPSS.
  - La categoría solo se asigna si su probabilidad es ≥ 40 %; si no, "sin señal clara".
  - Si ningún modelo supera a la climatología en un horizonte, el pronóstico operativo de ese horizonte
    es la climatología (honesto: "sin señal, se espera lo normal").

Uso (terminal o Colab):
    python 07_modelo_pisco.py                         # 1981 → último mes, prueba 2016–2025
    python 07_modelo_pisco.py --rapido                # prueba solo 2023–2025 (para verificar que corre)
    python 07_modelo_pisco.py --ini 1991-01 --anios 2019-2025
En Colab use "!python 07_modelo_pisco.py" (o %run); también funciona pegado en una celda.

Entradas: pisco_prec.nc, huanuco_estaticas.csv, ONI (se descarga; o oni.ascii.txt local)
Salidas en resultados_pisco/:
    metricas_walkforward.csv, metricas_resumen.csv, rpss.csv, predicciones_walkforward.csv,
    pronostico_actual.csv, climatologia.csv, modelo_h{1,2,3}.joblib, config.json
"""
import argparse
import calendar
import io
import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.linear_model import RidgeCV
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from xgboost import XGBRegressor

HORIZONTES = (1, 2, 3)
SEED = 42
URL_ONI = "https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt"
SEAS_MES = {"DJF": 1, "JFM": 2, "FMA": 3, "MAM": 4, "AMJ": 5, "MJJ": 6,
            "JJA": 7, "JAS": 8, "ASO": 9, "SON": 10, "OND": 11, "NDJ": 12}
SD_MIN = 5.0                                            # mm: evita dividir por ~0 en meses muy secos
P_SENAL = 0.40                                          # categoría solo si su probabilidad ≥ 40 %

REZAGOS = ["z_l0", "z_l1", "z_l2", "z_l3", "z_l11", "z_m3", "z_m6"]
ESTACION = ["mes_sin", "mes_cos"]
ENSO = ["oni_l2", "oni_l3"]
GEO = ["lon", "lat", "elev"]
VARIANTES = {                                          # el prefijo indica el algoritmo
    "Ridge_rezagos": REZAGOS + ESTACION,
    "Ridge_rezagos_oni": REZAGOS + ESTACION + ENSO,
    "XGB_rezagos": REZAGOS + ESTACION,
    "XGB_rezagos_oni": REZAGOS + ESTACION + ENSO,
    "XGB_completo": REZAGOS + ESTACION + ENSO + GEO,
}


# ---------------------------------------------------------------- datos
def leer_pisco(ruta, celdas):
    import xarray as xr
    try:
        ds = xr.open_dataset(ruta, decode_times=False)
    except Exception:
        ds = xr.open_dataset(ruta, decode_times=False, engine="scipy")    # netCDF3 sin netCDF4
    var = "Prec" if "Prec" in ds.data_vars else list(ds.data_vars)[0]
    unidades = str(ds[var].attrs.get("units", "?"))
    df = ds[var].to_dataframe(name="pp").reset_index()
    meses = {t: (pd.Timestamp("1960-01-01") + pd.DateOffset(months=int(np.floor(t)))).strftime("%Y-%m")
             for t in np.unique(df["T"])}
    df["fecha"] = df["T"].map(meses)
    df["X"] = np.where(df["X"] > 180, df["X"] - 360, df["X"])
    df["celda"] = df["X"].round(2).map("{:.2f}".format) + "_" + df["Y"].round(2).map("{:.2f}".format)
    if "day" in unidades.lower():
        dias = df["fecha"].map(lambda f: calendar.monthrange(int(f[:4]), int(f[5:]))[1])
        df["pp"] *= dias
    df = df[df.celda.isin(celdas)][["celda", "fecha", "pp"]]
    faltan = set(celdas) - set(df.celda)
    print(f"PISCO: unidades '{unidades}', {df.celda.nunique()}/{len(celdas)} celdas, "
          f"{df.fecha.min()} a {df.fecha.max()}")
    if faltan:
        print(f"AVISO: {len(faltan)} celdas sin PISCO, se excluyen: {sorted(faltan)[:5]}")
    return df


def leer_oni():
    txt = None
    try:
        import requests
        txt = requests.get(URL_ONI, timeout=60).text
    except Exception as e:
        print(f"AVISO: no se pudo descargar ONI ({e})")
    if (txt is None or "ANOM" not in txt) and Path("oni.ascii.txt").exists():
        txt = Path("oni.ascii.txt").read_text()
    if txt is None or "ANOM" not in txt:
        print("AVISO: sin ONI; se omiten las variantes con ENSO")
        return None
    df = pd.read_csv(io.StringIO(txt), sep=r"\s+")
    df["fecha"] = df["YR"].astype(str) + "-" + df["SEAS"].map(SEAS_MES).map("{:02d}".format)
    print(f"ONI: {df.fecha.min()} a {df.fecha.max()} (último: {df.ANOM.iloc[-1]:+.2f})")
    return df.set_index("fecha")["ANOM"]


def leer_estaticas():
    est = pd.read_csv("huanuco_estaticas.csv").rename(columns={"elev_mean": "elev"})
    return est[["celda", "lon", "lat", "elev"]]


def panel(pisco, est, oni, ini):
    df = pisco[pisco.fecha >= ini].merge(est, on="celda")
    df["anio"] = df.fecha.str[:4].astype(int)
    df["mes"] = df.fecha.str[5:7].astype(int)
    df["t"] = df.anio * 12 + df.mes - 1
    df = df.sort_values(["celda", "t"]).reset_index(drop=True)
    if oni is not None:
        per = pd.PeriodIndex(df.fecha, freq="M")
        for k in (2, 3):     # ONI centrado de 3 meses: el rótulo t−1 ya usa el mes t → rezago 2 y 3
            df[f"oni_l{k}"] = (per - k).strftime("%Y-%m").map(oni).astype(float)
    return df


# ---------------------------------------------------------------- variables (sin fuga)
def variables(df, corte):
    """Normal, desviación y terciles por celda×mes con datos < corte; luego anomalías y rezagos."""
    g = df[df.fecha < corte].groupby(["celda", "mes"]).pp
    clim = pd.DataFrame({"normal": g.mean(), "sd": g.std().clip(lower=SD_MIN),
                         "q33": g.quantile(1 / 3), "q67": g.quantile(2 / 3)})
    d = df.join(clim, on=["celda", "mes"])
    d["z"] = (d.pp - d.normal) / d.sd
    gc = d.groupby("celda")["z"]
    for k in (0, 1, 2, 3, 11):
        d[f"z_l{k}"] = gc.shift(k)
    d["z_m3"] = gc.transform(lambda s: s.rolling(3).mean())
    d["z_m6"] = gc.transform(lambda s: s.rolling(6).mean())
    return d, clim


def con_horizonte(d, h):
    g = d.groupby("celda")
    out = d.copy()
    for c in ("z", "pp", "normal", "sd", "q33", "q67", "fecha", "t"):
        out[f"{c}_obj"] = g[c].shift(-h)
    mes_obj = (out.mes - 1 + h) % 12 + 1
    out["mes_sin"], out["mes_cos"] = np.sin(2 * np.pi * mes_obj / 12), np.cos(2 * np.pi * mes_obj / 12)
    return out[out.t_obj - out.t == h]


def ajustar(nombre, cols, tr, va):
    """Ridge: lineal regularizado (alfa por validación cruzada). XGB: parada temprana con validación."""
    if nombre.startswith("Ridge"):
        return RidgeCV(alphas=np.logspace(-2, 3, 12)).fit(tr[cols], tr.z_obj)
    return nuevo_xgb().fit(tr[cols], tr.z_obj, eval_set=[(va[cols], va.z_obj)], verbose=False)


def nuevo_xgb():
    return XGBRegressor(n_estimators=600, learning_rate=0.05, max_depth=4, subsample=0.8,
                        colsample_bytree=0.8, min_child_weight=20, reg_lambda=5.0,
                        early_stopping_rounds=50, tree_method="hist", n_jobs=-1, random_state=SEED)


# ---------------------------------------------------------------- métricas
def a_mm(normal, sd, zhat):
    return np.clip(normal + zhat * sd, 0, None)


def metricas(obs, sim, normal):
    mse = mean_squared_error(obs, sim)
    r = np.corrcoef(obs, sim)[0, 1]
    kge = 1 - np.sqrt((r - 1) ** 2 + (sim.std() / obs.std() - 1) ** 2 + (sim.mean() / obs.mean() - 1) ** 2)
    a_obs, a_sim = obs - normal, sim - normal
    acc = np.corrcoef(a_obs, a_sim)[0, 1] if a_sim.std() > 1e-9 else 0.0
    return {"RMSE": np.sqrt(mse), "MAE": mean_absolute_error(obs, sim), "R2": r2_score(obs, sim),
            "KGE": kge, "ACC": acc, "SS_clim": 1 - mse / mean_squared_error(obs, normal)}


def prob_terciles(normal, sd, q33, q67, zhat, residuos):
    """P(bajo), P(normal), P(sobre) sumando a zhat la distribución empírica de errores fuera de muestra."""
    rq = np.quantile(residuos, np.linspace(0.005, 0.995, 200))
    y = np.clip(normal[:, None] + (zhat[:, None] + rq[None, :]) * sd[:, None], 0, None)
    p_bajo = (y < q33[:, None]).mean(1)
    p_sobre = (y > q67[:, None]).mean(1)
    return p_bajo, 1 - p_bajo - p_sobre, p_sobre


def rps(p_bajo, p_normal, obs_cat):
    c1, c2 = p_bajo, p_bajo + p_normal
    o1, o2 = (obs_cat == 0).astype(float), (obs_cat <= 1).astype(float)
    return (c1 - o1) ** 2 + (c2 - o2) ** 2


# ---------------------------------------------------------------- principal
def main(a):
    t0 = time.time()
    out = Path(a.salida)
    out.mkdir(exist_ok=True)
    est = leer_estaticas()
    pisco = leer_pisco(a.pisco, est.celda.unique())
    oni = None if a.sin_oni else leer_oni()
    df = panel(pisco, est, oni, a.ini)
    if oni is not None and df[ENSO].isna().all().any():
        oni = None
    variantes = {n: c for n, c in VARIANTES.items() if oni is not None or not set(c) & set(ENSO)}
    ultimo = df.dropna(subset=["pp"]).fecha.max()

    if a.rapido:
        anios = [2023, 2024, 2025]
    else:
        i, f = (int(x) for x in a.anios.split("-"))
        anios = list(range(i, f + 1))
    print(f"Celdas: {df.celda.nunique()} | meses: {df.fecha.min()} a {ultimo} | "
          f"años de prueba (walk-forward): {anios[0]}–{anios[-1]} | variantes: {list(variantes)}")

    filas, preds = [], []
    for k in anios:
        val_ini, test_ini, test_fin = f"{k - 1}-01", f"{k}-01", f"{k}-12"
        d, _ = variables(df, val_ini)
        for h in HORIZONTES:
            dh = con_horizonte(d, h).dropna(subset=REZAGOS + ["z_obj"])
            tr = dh[dh.fecha_obj < val_ini]
            va = dh[(dh.fecha_obj >= val_ini) & (dh.fecha_obj < test_ini)]
            te = dh[(dh.fecha_obj >= test_ini) & (dh.fecha_obj <= test_fin)]
            if len(te) == 0:
                continue
            zhat = {"Climatologia": np.zeros(len(te)), "Persistencia": te.z_l0.values}
            for nombre, cols in variantes.items():
                zhat[nombre] = ajustar(nombre, cols, tr, va).predict(te[cols])
            p = te[["celda", "lon", "lat", "fecha", "fecha_obj", "pp_obj", "normal_obj", "sd_obj",
                    "q33_obj", "q67_obj", "z_obj"]].assign(h=h, anio=k)
            for nombre, z in zhat.items():
                p[f"zhat_{nombre}"] = z
                sim = a_mm(te.normal_obj.values, te.sd_obj.values, z)
                filas.append({"anio": k, "h": h, "modelo": nombre, "n": len(te),
                              **metricas(te.pp_obj.values, sim, te.normal_obj.values)})
            preds.append(p)
        print(f"   año {k} listo ({time.time() - t0:.0f}s)")

    met = pd.DataFrame(filas)
    pr = pd.concat(preds, ignore_index=True)
    met.to_csv(out / "metricas_walkforward.csv", index=False, float_format="%.4f")

    # Resumen: métricas agregadas sobre todas las filas de prueba + estabilidad entre años
    modelos = ["Climatologia", "Persistencia"] + list(variantes)
    resumen = []
    for h in HORIZONTES:
        ph = pr[pr.h == h]
        for nombre in modelos:
            sim = a_mm(ph.normal_obj.values, ph.sd_obj.values, ph[f"zhat_{nombre}"].values)
            ss = met[(met.h == h) & (met.modelo == nombre)].SS_clim
            resumen.append({"h": h, "modelo": nombre, **metricas(ph.pp_obj.values, sim, ph.normal_obj.values),
                            "SS_media_anual": ss.mean(), "SS_desv_anual": ss.std(),
                            "anios_SS_positivo": f"{(ss > 0).sum()}/{len(ss)}"})
    res = pd.DataFrame(resumen)
    res.to_csv(out / "metricas_resumen.csv", index=False, float_format="%.4f")

    # Modelo operativo por horizonte: la mejor variante XGB si supera a la climatología; si no, climatología
    elegido = {}
    for h in HORIZONTES:
        r = res[(res.h == h) & res.modelo.isin(variantes)].sort_values("SS_clim", ascending=False).iloc[0]
        elegido[h] = r.modelo if r.SS_clim > 0 else "Climatologia"

    # Verificación probabilística (RPSS) con residuos de los OTROS años (fuera de muestra)
    filas_rps = []
    for h in HORIZONTES:
        ph = pr[pr.h == h]
        cat = np.where(ph.pp_obj < ph.q33_obj, 0, np.where(ph.pp_obj > ph.q67_obj, 2, 1))
        for nombre in ("Climatologia", elegido[h]) if elegido[h] != "Climatologia" else ("Climatologia",):
            res_z = (ph.z_obj - ph[f"zhat_{nombre}"]).values
            rp, rp_ref = np.zeros(len(ph)), np.zeros(len(ph))
            for k in anios:
                en_k = (ph.anio == k).values
                if not en_k.any():
                    continue
                pool = res_z[~en_k] if (~en_k).any() else res_z
                pb, pn, _ = prob_terciles(ph.normal_obj.values[en_k], ph.sd_obj.values[en_k],
                                          ph.q33_obj.values[en_k], ph.q67_obj.values[en_k],
                                          ph[f"zhat_{nombre}"].values[en_k], pool)
                rp[en_k] = rps(pb, pn, cat[en_k])
                rp_ref[en_k] = rps(np.full(en_k.sum(), 1 / 3), np.full(en_k.sum(), 1 / 3), cat[en_k])
            filas_rps.append({"h": h, "modelo": nombre, "RPS": rp.mean(), "RPS_clim_1/3": rp_ref.mean(),
                              "RPSS": 1 - rp.mean() / rp_ref.mean(),
                              "frec_bajo": (cat == 0).mean(), "frec_normal": (cat == 1).mean(),
                              "frec_sobre": (cat == 2).mean()})
    rpss = pd.DataFrame(filas_rps)
    rpss.to_csv(out / "rpss.csv", index=False, float_format="%.4f")
    pr.to_csv(out / "predicciones_walkforward.csv", index=False, float_format="%.3f")

    # ------------------------------------------------ entrenamiento final y pronóstico operativo
    corte = (pd.Period(ultimo, "M") + 1).strftime("%Y-%m")       # climatología con TODO lo observado
    val_ini = (pd.Period(ultimo, "M") - 11).strftime("%Y-%m")     # últimos 12 meses: parada temprana
    d, clim = variables(df, corte)
    base = d[d.fecha == ultimo].copy()
    pron = []
    for h in HORIZONTES:
        nombre = elegido[h]
        fecha_obj = (pd.Period(ultimo, "M") + h).strftime("%Y-%m")
        mes_obj = int(fecha_obj[5:])
        b = base.copy()
        b["mes_sin"], b["mes_cos"] = np.sin(2 * np.pi * mes_obj / 12), np.cos(2 * np.pi * mes_obj / 12)
        b = b.merge(clim.xs(mes_obj, level="mes").add_suffix("_obj"), left_on="celda", right_index=True)
        if nombre == "Climatologia":
            zhat = np.zeros(len(b))
            art = {"modelo": None, "nombre": nombre, "predictores": [], "h": h}
        else:
            cols = variantes[nombre]
            dh = con_horizonte(d, h).dropna(subset=cols + ["z_obj"])
            tr, va = dh[dh.fecha_obj < val_ini], dh[dh.fecha_obj >= val_ini]
            m = ajustar(nombre, cols, tr, va)
            b = b.dropna(subset=cols)
            zhat = m.predict(b[cols])
            art = {"modelo": m, "nombre": nombre, "predictores": cols, "h": h}
        art.update({"objetivo": "pp_pisco", "entrenado_hasta": ultimo, "corte_climatologia": corte})
        joblib.dump(art, out / f"modelo_h{h}.joblib")

        ph = pr[pr.h == h]
        residuos = (ph.z_obj - ph[f"zhat_{nombre}"]).values
        pb, pn, ps = prob_terciles(b.normal_obj.values, b.sd_obj.values, b.q33_obj.values,
                                   b.q67_obj.values, zhat, residuos)
        valor = a_mm(b.normal_obj.values, b.sd_obj.values, zhat)
        probs = np.c_[pb, pn, ps]
        categoria = np.array(["bajo lo normal", "normal", "sobre lo normal"])[probs.argmax(1)]
        # Con probabilidades casi iguales no hay señal: se informa como "probabilidades similares"
        categoria = np.where(probs.max(1) < P_SENAL, "sin señal clara", categoria)
        pron.append(pd.DataFrame({
            "celda": b.celda.values, "lon": b.lon.values, "lat": b.lat.values, "elev": b.elev.values,
            "h": h, "fecha_base": ultimo, "fecha_obj": fecha_obj, "modelo": nombre,
            "pronostico_mm": valor, "normal_mm": b.normal_obj.values,
            "anomalia_pct": 100 * (valor - b.normal_obj.values) / np.clip(b.normal_obj.values, 1, None),
            "p_bajo": pb, "p_normal": pn, "p_sobre": ps,
            "categoria": categoria}))
    pron = pd.concat(pron, ignore_index=True)
    pron.to_csv(out / "pronostico_actual.csv", index=False, float_format="%.3f")
    clim.reset_index().to_csv(out / "climatologia.csv", index=False, float_format="%.3f")
    json.dump({"objetivo": "pp_pisco", "fuente": a.pisco, "periodo": [a.ini, ultimo],
               "ultimo_mes_observado": ultimo, "anios_prueba": anios,
               "modelo_por_horizonte": {str(h): elegido[h] for h in HORIZONTES},
               "variantes": variantes, "oni_ultimo": None if oni is None else
               {"fecha": oni.index[-1], "valor": float(oni.iloc[-1])},
               "generado": time.strftime("%Y-%m-%d %H:%M")},
              open(out / "config.json", "w"), indent=2, ensure_ascii=False)

    # ------------------------------------------------ resumen en pantalla
    pd.set_option("display.width", 160)
    print("\nWALK-FORWARD — skill frente a climatología (SS) sobre todas las filas de prueba:")
    print(res.pivot_table(index="modelo", columns="h", values="SS_clim").round(3).to_string())
    print("\nAños con SS > 0:")
    print(res.pivot_table(index="modelo", columns="h", values="anios_SS_positivo", aggfunc="first").to_string())
    print("\nVerificación probabilística (RPSS > 0 = mejor que 1/3-1/3-1/3):")
    print(rpss.round(3).to_string(index=False))
    print(f"\nModelo operativo por horizonte: {elegido}")
    print(f"\nPRONÓSTICO desde {ultimo} — promedio regional:")
    print(pron.groupby(["h", "fecha_obj"]).agg(
        pronostico_mm=("pronostico_mm", "mean"), normal_mm=("normal_mm", "mean"),
        p_bajo=("p_bajo", "mean"), p_normal=("p_normal", "mean"), p_sobre=("p_sobre", "mean"))
        .round(2).to_string())
    print("\nCeldas por categoría:")
    print(pron.groupby(["fecha_obj", "categoria"]).size().unstack(fill_value=0).to_string())
    print(f"\nListo en {time.time() - t0:.0f}s. Resultados en {out}/")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--pisco", default="pisco_prec.nc")
    ap.add_argument("--ini", default="1981-01", help="primer mes de la serie (YYYY-MM)")
    ap.add_argument("--anios", default="2016-2025", help="años de prueba walk-forward, p. ej. 2016-2025")
    ap.add_argument("--rapido", action="store_true", help="prueba solo 2023–2025")
    ap.add_argument("--sin-oni", action="store_true", help="no usar ONI")
    ap.add_argument("--salida", default="resultados_pisco")
    main(ap.parse_known_args()[0])             # parse_known_args: ignora el "-f kernel.json" de Colab/Jupyter
