"""
06_mapas_zonas.py
Espacializa los resultados (OE5) e identifica zonas de mayor variabilidad (OE6, PE4).

Mapas (resultados/):
  mapa_climatologia.png   lluvia anual normal por celda
  mapa_variabilidad.png   coeficiente de variación interanual (dónde el clima es menos estable)
  mapa_error_modelo.png   RMSE del mejor modelo en prueba (dónde el modelo acierta menos)
  mapa_pronostico.png     anomalía pronosticada para h = 1, 2, 3
  mapa_zonas.png          zonas climáticas homogéneas (K-means)
Tablas: zonas.csv (celda -> zona), resumen_zonas.csv, celdas.geojson (para la app y QGIS)

Uso: python 06_mapas_zonas.py   (después de 05_modelar.py)
"""
import json
from pathlib import Path

import joblib
import matplotlib
import numpy as np
import pandas as pd
from sklearn.cluster import KMeans
from sklearn.metrics import silhouette_score
from sklearn.preprocessing import StandardScaler

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

OUT = Path("resultados")
RES = 0.1


def grilla(df, col):
    """Convierte (lon, lat, valor) en matriz regular para dibujar celdas como cuadros."""
    lons = np.round(np.arange(df.lon.min(), df.lon.max() + RES / 2, RES), 2)
    lats = np.round(np.arange(df.lat.min(), df.lat.max() + RES / 2, RES), 2)
    m = df.pivot_table(index=df.lat.round(2), columns=df.lon.round(2), values=col).reindex(index=lats, columns=lons)
    bordes_x = np.append(lons - RES / 2, lons[-1] + RES / 2)
    bordes_y = np.append(lats - RES / 2, lats[-1] + RES / 2)
    return bordes_x, bordes_y, m.values


def mapa(ax, df, col, titulo, cmap, etiqueta, vmin=None, vmax=None, centro=None):
    x, y, z = grilla(df, col)
    if centro is not None:
        lim = np.nanmax(np.abs(z - centro))
        vmin, vmax = centro - lim, centro + lim
    pc = ax.pcolormesh(x, y, z, cmap=cmap, vmin=vmin, vmax=vmax, shading="flat")
    ax.set(title=titulo, xlabel="Longitud", ylabel="Latitud", aspect="equal")
    plt.colorbar(pc, ax=ax, label=etiqueta, shrink=0.85)


def guardar(fig, nombre):
    fig.tight_layout()
    fig.savefig(OUT / nombre, dpi=150)
    plt.close(fig)
    print(f"   {nombre}")


def main():
    cfg = json.load(open(OUT / "config.json"))
    obj = cfg["objetivo"]
    es_lluvia = obj.startswith("pp")
    unidad = "mm" if es_lluvia else "°C"
    df = pd.read_csv(cfg["datos"]).dropna(subset=[obj])
    df["anio"] = df.fecha.str[:4].astype(int)
    print(f"Objetivo: {obj}")

    # --- Indicadores por celda
    anual = df.groupby(["celda", "anio"])[obj].agg("sum" if es_lluvia else "mean")
    anual = anual[df.groupby(["celda", "anio"]).size() == 12]          # solo años completos
    cel = (df.groupby("celda")[["lon", "lat", "elev"]].first()
             .join(anual.groupby("celda").mean().rename("normal_anual"))
             .join(anual.groupby("celda").std().rename("desv_interanual")))
    cel["cv_interanual"] = 100 * cel.desv_interanual / cel.normal_anual.abs()
    clim12 = df.groupby(["celda", "mes"])[obj].mean().unstack()          # ciclo anual (12 valores)
    cel = cel.reset_index()

    # --- Error del mejor modelo en prueba
    pred = pd.read_csv(OUT / "predicciones_test.csv")
    nombre_h1 = joblib.load(OUT / "modelo_h1.joblib")["nombre"]
    p1 = pred[pred.h == 1]
    err = (p1.assign(e2=(p1[f"pred_{nombre_h1}"] - p1.y_obs) ** 2,
                     e2c=(p1["pred_Climatologia"] - p1.y_obs) ** 2)
             .groupby("celda")[["e2", "e2c"]].mean())
    err["rmse_modelo"] = np.sqrt(err.e2)
    err["skill_celda"] = 1 - err.e2 / err.e2c
    cel = cel.merge(err[["rmse_modelo", "skill_celda"]], on="celda", how="left")

    # --- Zonificación K-means: ciclo anual normalizado + altitud + variabilidad
    X = np.column_stack([
        clim12.loc[cel.celda].values / clim12.loc[cel.celda].values.sum(axis=1, keepdims=True)
        if es_lluvia else clim12.loc[cel.celda].values,                 # forma del ciclo anual
        cel[["normal_anual", "elev", "cv_interanual"]].fillna(cel[["normal_anual", "elev", "cv_interanual"]].median()).values,
    ])
    Xs = StandardScaler().fit_transform(X)
    puntajes = {k: silhouette_score(Xs, KMeans(k, n_init=20, random_state=42).fit_predict(Xs)) for k in range(3, 7)}
    k = max(puntajes, key=puntajes.get)
    km = KMeans(k, n_init=20, random_state=42).fit(Xs)
    orden = cel.assign(z=km.labels_).groupby("z").elev.mean().sort_values(ascending=False).index   # zona 1 = más alta
    cel["zona"] = pd.Series(km.labels_).map({z: i + 1 for i, z in enumerate(orden)}).values
    print(f"K-means: k = {k} (silhouette {', '.join(f'{kk}:{v:.2f}' for kk, v in puntajes.items())})")

    resumen = (cel.groupby("zona")
                  .agg(celdas=("celda", "size"), elev_media_m=("elev", "mean"),
                       normal_anual=("normal_anual", "mean"), cv_interanual_pct=("cv_interanual", "mean"),
                       rmse_modelo=("rmse_modelo", "mean"), skill=("skill_celda", "mean"))
                  .round(2))
    resumen.to_csv(OUT / "resumen_zonas.csv")
    cel.to_csv(OUT / "zonas.csv", index=False, float_format="%.4f")
    print(resumen.to_string())

    # --- Mapas
    print("Mapas:")
    fig, ax = plt.subplots(figsize=(7, 6))
    mapa(ax, cel, "normal_anual", f"Normal anual de {obj}", "YlGnBu" if es_lluvia else "RdYlBu_r",
         f"{unidad}/año" if es_lluvia else unidad)
    guardar(fig, "mapa_climatologia.png")

    fig, ax = plt.subplots(figsize=(7, 6))
    mapa(ax, cel, "cv_interanual", "Variabilidad interanual (CV)", "magma_r", "%")
    guardar(fig, "mapa_variabilidad.png")

    fig, axs = plt.subplots(1, 2, figsize=(13, 5.5))
    mapa(axs[0], cel, "rmse_modelo", f"RMSE {nombre_h1} (h=1, prueba)", "OrRd", unidad)
    mapa(axs[1], cel, "skill_celda", "Skill frente a climatología (>0 mejora)", "RdBu", "SS", centro=0)
    guardar(fig, "mapa_error_modelo.png")

    pron = pd.read_csv(OUT / "pronostico_actual.csv")
    col_an = "anomalia_pct" if es_lluvia else "anomalia"
    fig, axs = plt.subplots(1, 3, figsize=(18, 5.5))
    for ax, (h, g) in zip(axs, pron.groupby("h")):
        mapa(ax, g, col_an, f"Pronóstico {g.fecha_obj.iloc[0]} (h={h})", "BrBG" if es_lluvia else "RdBu_r",
             "% vs normal" if es_lluvia else "°C vs normal", centro=0)
    guardar(fig, "mapa_pronostico.png")

    fig, ax = plt.subplots(figsize=(7, 6))
    x, y, z = grilla(cel, "zona")
    pc = ax.pcolormesh(x, y, z, cmap=plt.get_cmap("Set2", k), vmin=0.5, vmax=k + 0.5)
    ax.set(title=f"Zonas climáticas homogéneas (K-means, k={k})", xlabel="Longitud", ylabel="Latitud", aspect="equal")
    plt.colorbar(pc, ax=ax, ticks=range(1, k + 1), label="Zona (1 = más alta)")
    guardar(fig, "mapa_zonas.png")

    # --- GeoJSON de celdas con atributos (app y QGIS)
    ultimo = pron[pron.h == 1].set_index("celda")
    feats = []
    for _, r in cel.iterrows():
        x0, y0 = r.lon - RES / 2, r.lat - RES / 2
        props = {k_: (None if pd.isna(v) else (round(float(v), 3) if isinstance(v, (float, np.floating)) else v))
                 for k_, v in r.items()}
        if r.celda in ultimo.index:
            props["pronostico_h1"] = round(float(ultimo.loc[r.celda, "pronostico"]), 2)
            props["anomalia_h1"] = round(float(ultimo.loc[r.celda, col_an]), 2)
        feats.append({"type": "Feature", "properties": props, "geometry": {"type": "Polygon", "coordinates": [[
            [x0, y0], [x0 + RES, y0], [x0 + RES, y0 + RES], [x0, y0 + RES], [x0, y0]]]}})
    json.dump({"type": "FeatureCollection", "features": feats}, open(OUT / "celdas.geojson", "w"))
    print("   celdas.geojson")


if __name__ == "__main__":
    main()
