"""
05_modelar.py
Entrena y evalúa los modelos de pronóstico mensual por celda.

Diseño:
  - Objetivo: anomalía del mes t+h respecto a la climatología de la celda (calculada SOLO con entrenamiento).
    La predicción final = climatología + anomalía predicha (en lluvia, nunca negativa).
  - Predictores en el mes t: rezagos de la anomalía objetivo, anomalías de las variables satelitales,
    ONI con rezago (sin fuga), estacionalidad del mes objetivo y variables geoespaciales fijas.
  - Partición temporal por fecha objetivo: entrenamiento < VAL <= validación < TEST <= prueba.
  - Modelos: Climatología, Persistencia (líneas base), Random Forest, XGBoost, MLP.
  - Métricas en mm: RMSE, MAE, R2, KGE y SS (skill frente a climatología; > 0 = mejora real).

Uso:
    python 05_modelar.py                                   # PISCO, val 2022, test 2023+
    python 05_modelar.py --objetivo pp_chirps --datos dataset_huanuco_2015_2025.csv
    python 05_modelar.py --objetivo t2m                    # temperatura (secundaria)

Salidas en resultados/: metricas.csv, ablacion.csv, importancia.csv, predicciones_test.csv,
pronostico_actual.csv, modelo_h{1,2,3}.joblib, config.json
"""
import argparse
import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.inspection import permutation_importance
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.neural_network import MLPRegressor
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from xgboost import XGBRegressor

OUT = Path("resultados")
OUT.mkdir(exist_ok=True)
HORIZONTES = (1, 2, 3)
DINAMICAS = ["pp_chirps", "pp_era5", "t2m", "tmin", "tmax", "hr", "rad", "hum_suelo", "ndvi", "lst"]
GEO = ["lon", "lat", "elev", "rugosidad", "pendiente", "orient_norte"]
SEED = 42


# ---------------------------------------------------------------- métricas
def kge(obs, sim):
    r = np.corrcoef(obs, sim)[0, 1]
    return 1 - np.sqrt((r - 1) ** 2 + (sim.std() / obs.std() - 1) ** 2 + (sim.mean() / obs.mean() - 1) ** 2)


def metricas(obs, sim, sim_clim):
    mse = mean_squared_error(obs, sim)
    return {"RMSE": np.sqrt(mse), "MAE": mean_absolute_error(obs, sim), "R2": r2_score(obs, sim),
            "KGE": kge(obs, sim), "SS_clim": 1 - mse / mean_squared_error(obs, sim_clim)}


# ---------------------------------------------------------------- variables
def preparar(df, objetivo, val_ini):
    df = df.sort_values(["celda", "fecha"]).reset_index(drop=True)
    df["t"] = df.anio * 12 + df.mes - 1
    entren = df.fecha < val_ini

    # climatologías por celda y mes, SOLO con datos de entrenamiento (evita fuga de información)
    cols_clim = list(dict.fromkeys([objetivo] + [c for c in DINAMICAS if c in df]))
    clim = df[entren].groupby(["celda", "mes"])[cols_clim].mean()
    clim.columns = [f"clim_{c}" for c in cols_clim]
    df = df.join(clim, on=["celda", "mes"])

    df["anom"] = df[objetivo] - df[f"clim_{objetivo}"]
    g = df.groupby("celda")
    feats = []
    for k in (0, 1, 2, 3, 11):                                   # rezagos de la anomalía objetivo
        df[f"anom_l{k}"] = g["anom"].shift(k)
        feats.append(f"anom_l{k}")
    df["anom_m3"] = g["anom"].transform(lambda s: s.rolling(3).mean())
    df["anom_m6"] = g["anom"].transform(lambda s: s.rolling(6).mean())
    feats += ["anom_m3", "anom_m6"]

    satelitales = []
    for c in DINAMICAS:                                          # anomalías de predictores en t y t-1
        if c in df and c != objetivo:
            df[f"{c}_a"] = df[c] - df[f"clim_{c}"]
            df[f"{c}_a_l1"] = df.groupby("celda")[f"{c}_a"].shift(1)
            satelitales += [f"{c}_a", f"{c}_a_l1"]

    enso = []
    if "oni" in df and df.oni.notna().any():
        # ONI es media móvil centrada de 3 meses: el valor rotulado t-1 usa el mes t.
        # Rezago 2 y 3 garantizan que el índice ya era conocido al pronosticar.
        df["oni_l2"] = df.groupby("celda")["oni"].shift(2)
        df["oni_l3"] = df.groupby("celda")["oni"].shift(3)
        enso = ["oni_l2", "oni_l3"]
    else:
        print("AVISO: sin columna ONI, se entrena sin variables ENSO")

    geo = [c for c in GEO if c in df]
    grupos = {"objetivo": feats, "satelital": satelitales, "enso": enso, "geo": geo}
    return df, grupos, clim


def con_horizonte(df, objetivo, h):
    """Filas: predictores en t, objetivo en t+h (misma celda)."""
    g = df.groupby("celda")
    d = df.copy()
    d["y_anom"] = g["anom"].shift(-h)
    d["y_obs"] = g[objetivo].shift(-h)
    d["clim_obj"] = g[f"clim_{objetivo}"].shift(-h)
    d["fecha_obj"] = g["fecha"].shift(-h)
    mes_obj = (d.mes - 1 + h) % 12 + 1
    d["mes_sin"], d["mes_cos"] = np.sin(2 * np.pi * mes_obj / 12), np.cos(2 * np.pi * mes_obj / 12)
    # el objetivo debe ser exactamente h meses después (no saltar huecos)
    d = d[g["t"].shift(-h) - d["t"] == h]
    return d


def modelos():
    return {
        "RandomForest": RandomForestRegressor(n_estimators=300, min_samples_leaf=5, max_features=0.5,
                                              n_jobs=-1, random_state=SEED),
        "XGBoost": XGBRegressor(n_estimators=800, learning_rate=0.03, max_depth=6, subsample=0.8,
                                colsample_bytree=0.8, min_child_weight=5, early_stopping_rounds=50,
                                n_jobs=-1, random_state=SEED),
        "MLP": make_pipeline(StandardScaler(), MLPRegressor(hidden_layer_sizes=(64, 32), alpha=1e-3,
                                                            early_stopping=True, max_iter=400,
                                                            random_state=SEED)),
    }


def ajustar(nombre, modelo, Xtr, ytr, Xva, yva):
    if nombre == "XGBoost":
        modelo.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
    else:
        modelo.fit(Xtr, ytr)
    return modelo


def final(objetivo, clim, anom):
    pred = clim + anom
    return np.clip(pred, 0, None) if objetivo.startswith("pp") else pred


# ---------------------------------------------------------------- principal
def main(a):
    t0 = time.time()
    df = pd.read_csv(a.datos)
    if a.objetivo not in df:
        raise SystemExit(f"La columna objetivo '{a.objetivo}' no existe en {a.datos}")
    df = df[df.fecha <= a.fin] if a.fin else df
    df, grupos, clim = preparar(df, a.objetivo, a.val)
    todas = [f for g in grupos.values() for f in g] + ["mes_sin", "mes_cos"]
    print(f"Objetivo: {a.objetivo} | celdas: {df.celda.nunique()} | "
          f"meses: {df.fecha.min()} a {df.fecha.max()} | predictores: {len(todas)}")

    filas_m, filas_ab, preds, imp = [], [], [], None
    for h in HORIZONTES:
        d = con_horizonte(df, a.objetivo, h).dropna(subset=todas + ["y_anom"])
        tr = d[d.fecha_obj < a.val]
        va = d[(d.fecha_obj >= a.val) & (d.fecha_obj < a.test)]
        te = d[d.fecha_obj >= a.test]
        if min(len(tr), len(va), len(te)) == 0:
            raise SystemExit(f"h={h}: partición vacía (train {len(tr)}, val {len(va)}, test {len(te)}). "
                             "Ajusta --val y --test.")
        print(f"\nh={h}: entrenamiento {len(tr):,} | validación {len(va):,} | prueba {len(te):,} filas")

        resultados = {"Climatologia": {}, "Persistencia": {}}
        for nombre_p, parte in (("val", va), ("test", te)):
            resultados["Climatologia"][nombre_p] = np.zeros(len(parte))
            resultados["Persistencia"][nombre_p] = parte["anom_l0"].values
        entrenados = {}
        for nombre, m in modelos().items():
            m = ajustar(nombre, m, tr[todas], tr.y_anom, va[todas], va.y_anom)
            entrenados[nombre] = m
            resultados[nombre] = {"val": m.predict(va[todas]), "test": m.predict(te[todas])}
            print(f"   {nombre} entrenado ({time.time() - t0:.0f}s)")

        for nombre, r in resultados.items():
            for nombre_p, parte in (("val", va), ("test", te)):
                sim = final(a.objetivo, parte.clim_obj.values, r[nombre_p])
                filas_m.append({"h": h, "modelo": nombre, "particion": nombre_p,
                                **metricas(parte.y_obs.values, sim, final(a.objetivo, parte.clim_obj.values, 0))})

        # mejor modelo por RMSE de validación (entre los de ML)
        val_rmse = {n: np.sqrt(mean_squared_error(va.y_obs, final(a.objetivo, va.clim_obj.values, resultados[n]["val"])))
                    for n in entrenados}
        mejor = min(val_rmse, key=val_rmse.get)
        print(f"   mejor en validación: {mejor}")
        joblib.dump({"modelo": entrenados[mejor], "nombre": mejor, "predictores": todas, "h": h,
                     "objetivo": a.objetivo}, OUT / f"modelo_h{h}.joblib")

        p = te[["celda", "lon", "lat", "fecha", "fecha_obj", "y_obs", "clim_obj"]].copy()
        p["h"] = h
        for nombre in resultados:
            p[f"pred_{nombre}"] = final(a.objetivo, te.clim_obj.values, resultados[nombre]["test"])
        preds.append(p)

        if h == 1:
            # Ablación (PE3): XGBoost quitando grupos de variables
            for etiqueta, quitar in (("completo", []), ("sin_geoespaciales", grupos["geo"]),
                                     ("sin_enso", grupos["enso"]), ("sin_satelitales", grupos["satelital"]),
                                     ("solo_rezagos_y_estacion", grupos["satelital"] + grupos["enso"] + grupos["geo"])):
                if not quitar and etiqueta != "completo":
                    continue                                 # grupo inexistente (p. ej. sin ONI)
                cols = [c for c in todas if c not in quitar]
                m = ajustar("XGBoost", modelos()["XGBoost"], tr[cols], tr.y_anom, va[cols], va.y_anom)
                sim = final(a.objetivo, te.clim_obj.values, m.predict(te[cols]))
                filas_ab.append({"variante": etiqueta, "n_predictores": len(cols),
                                 **metricas(te.y_obs.values, sim, final(a.objetivo, te.clim_obj.values, 0))})
            # Importancia por permutación (PE1/PE2), sobre prueba
            muestra = te.sample(min(len(te), 4000), random_state=SEED)
            pi = permutation_importance(entrenados["XGBoost"], muestra[todas], muestra.y_anom,
                                        n_repeats=5, random_state=SEED, scoring="neg_root_mean_squared_error")
            grupo_de = {f: g for g, fs in grupos.items() for f in fs}
            imp = (pd.DataFrame({"predictor": todas, "importancia": pi.importances_mean,
                                 "desv": pi.importances_std})
                     .assign(grupo=lambda x: x.predictor.map(grupo_de).fillna("estacion"))
                     .sort_values("importancia", ascending=False))

    met = pd.DataFrame(filas_m)
    met.to_csv(OUT / "metricas.csv", index=False, float_format="%.4f")
    pd.DataFrame(filas_ab).to_csv(OUT / "ablacion.csv", index=False, float_format="%.4f")
    imp.to_csv(OUT / "importancia.csv", index=False, float_format="%.5f")
    pd.concat(preds).to_csv(OUT / "predicciones_test.csv", index=False, float_format="%.3f")

    # Pronóstico operativo desde el último mes con objetivo observado
    ultimo = df.dropna(subset=["anom"]).fecha.max()
    base = df[df.fecha == ultimo]
    filas = []
    for h in HORIZONTES:
        art = joblib.load(OUT / f"modelo_h{h}.joblib")
        b = base.copy()
        mes_obj = (b.mes - 1 + h) % 12 + 1
        b["mes_sin"], b["mes_cos"] = np.sin(2 * np.pi * mes_obj / 12), np.cos(2 * np.pi * mes_obj / 12)
        b["mes_obj"] = mes_obj
        b = b.dropna(subset=art["predictores"])
        clim_obj = b[["celda"]].assign(mes=b.mes_obj.values).join(clim[f"clim_{a.objetivo}"], on=["celda", "mes"])
        anom = art["modelo"].predict(b[art["predictores"]])
        normal = clim_obj[f"clim_{a.objetivo}"].values
        filas.append(pd.DataFrame({
            "celda": b.celda.values, "lon": b.lon.values, "lat": b.lat.values, "h": h,
            "fecha_base": ultimo,
            "fecha_obj": (pd.Period(ultimo, "M") + h).strftime("%Y-%m"),
            "pronostico": final(a.objetivo, normal, anom), "normal": normal, "modelo": art["nombre"]}))
    pron = pd.concat(filas)
    if a.objetivo.startswith("pp"):
        pron["anomalia_pct"] = 100 * (pron.pronostico - pron.normal) / pron.normal.clip(lower=1)
    else:
        pron["anomalia"] = pron.pronostico - pron.normal
    pron.to_csv(OUT / "pronostico_actual.csv", index=False, float_format="%.3f")
    clim.reset_index().to_csv(OUT / "climatologia.csv", index=False, float_format="%.3f")
    json.dump({"objetivo": a.objetivo, "datos": a.datos, "val": a.val, "test": a.test,
               "ultimo_mes_observado": ultimo, "predictores": todas, "grupos": grupos},
              open(OUT / "config.json", "w"), indent=2, ensure_ascii=False)

    # Resumen en pantalla
    tabla = (met[met.particion == "test"].pivot_table(index="modelo", columns="h", values=["RMSE", "SS_clim"])
             .round(3))
    print("\nPRUEBA (test) — RMSE y skill frente a climatología por horizonte:")
    print(tabla.to_string())
    print("\nAblación (h=1, XGBoost):")
    print(pd.DataFrame(filas_ab).round(3).to_string(index=False))
    print("\nTop 10 predictores (h=1):")
    print(imp.head(10).round(4).to_string(index=False))
    print(f"\nListo en {time.time() - t0:.0f}s. Resultados en {OUT}/")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--datos", default="dataset_modelo.csv")
    ap.add_argument("--objetivo", default="pp_pisco")
    ap.add_argument("--val", default="2022-01", help="inicio de validación (YYYY-MM)")
    ap.add_argument("--test", default="2023-01", help="inicio de prueba (YYYY-MM)")
    ap.add_argument("--fin", default=None, help="último mes a usar (opcional)")
    main(ap.parse_known_args()[0])             # parse_known_args: ignora el "-f kernel.json" de Colab/Jupyter
