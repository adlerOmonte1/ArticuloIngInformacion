"""
09_exportar_web.py
Convierte los resultados del modelo operativo en archivos JSON livianos para el frontend (web/data/).

La web no ejecuta el modelo: solo lee estos archivos. Se vuelve a correr cada mes,
justo después de 07_modelo_pisco.py.

Entradas: resultados_pisco/ (pronóstico, climatología, métricas, predicciones walk-forward, config),
          pisco_prec.nc, huanuco_estaticas.csv, huanuco_mensual_2015_2029.csv (Tmin ERA5-Land),
          resultados/zonas.csv
Salidas en web/data/:
    meta.json          emisión, modelo, métricas, zonas, ONI
    celdas.geojson     378 polígonos de 0.1° con id, altitud y zona
    pronostico.json    3 meses × 378 celdas: mm, normal, probabilidades por terciles, categoría
    climatologia.json  por celda: normal, terciles y Tmin de los 12 meses
    historico.json     lluvia observada PISCO por mes (1981→) y pronóstico a 1 mes del walk-forward (2016–2025)

Uso:  python 09_exportar_web.py
"""
import importlib.util
import json
import time
from pathlib import Path

import numpy as np
import pandas as pd

spec = importlib.util.spec_from_file_location("m07", Path(__file__).with_name("07_modelo_pisco.py"))
m07 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m07)

RES = Path("resultados_pisco")
OUT = Path("web/data")
CATEGORIAS = {"bajo lo normal": 0, "normal": 1, "sobre lo normal": 2, "sin señal clara": 3}
NOMBRES_ZONA = {1: "Sierra húmeda", 2: "Sierra de lluvias irregulares", 3: "Selva"}


def escribir(nombre, obj):
    ruta = OUT / nombre
    ruta.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"   {ruta}  {ruta.stat().st_size / 1024:,.0f} KB")


def r(x, d=1):
    return None if pd.isna(x) else round(float(x), d)


def main():
    t0 = time.time()
    OUT.mkdir(parents=True, exist_ok=True)
    cfg = json.load(open(RES / "config.json", encoding="utf-8"))
    est = m07.leer_estaticas()
    zonas = pd.read_csv("resultados/zonas.csv")[["celda", "zona"]]
    celdas = est.merge(zonas, on="celda", how="left").sort_values(["lat", "lon"], ascending=[False, True])
    celdas = celdas.reset_index(drop=True)
    idx = {c: i for i, c in enumerate(celdas.celda)}
    n = len(celdas)

    # ------------------------------------------------ geometría
    feats = []
    for i, c in celdas.iterrows():
        x0, x1, y0, y1 = c.lon - 0.05, c.lon + 0.05, c.lat - 0.05, c.lat + 0.05
        feats.append({"type": "Feature", "id": i,
                      "properties": {"id": i, "celda": c.celda, "lon": round(c.lon, 2), "lat": round(c.lat, 2),
                                     "elev": round(c.elev), "zona": int(c.zona)},
                      "geometry": {"type": "Polygon", "coordinates": [[[round(x0, 2), round(y0, 2)],
                                   [round(x1, 2), round(y0, 2)], [round(x1, 2), round(y1, 2)],
                                   [round(x0, 2), round(y1, 2)], [round(x0, 2), round(y0, 2)]]]}})
    escribir("celdas.geojson", {"type": "FeatureCollection", "features": feats})

    # ------------------------------------------------ pronóstico
    pron = pd.read_csv(RES / "pronostico_actual.csv")
    meses = []
    for h, g in pron.groupby("h"):
        g = g.set_index("celda").reindex(celdas.celda)
        meses.append({"h": int(h), "fecha": g.fecha_obj.dropna().iloc[0], "modelo": g.modelo.dropna().iloc[0],
                      "mm": [r(v) for v in g.pronostico_mm], "normal": [r(v) for v in g.normal_mm],
                      "anom": [r(v) for v in g.anomalia_pct],
                      "p": [[r(a, 2), r(b, 2), r(c, 2)] for a, b, c in zip(g.p_bajo, g.p_normal, g.p_sobre)],
                      "cat": [CATEGORIAS.get(v, 3) for v in g.categoria]})
    escribir("pronostico.json", {"fecha_base": cfg["ultimo_mes_observado"], "meses": meses})

    # ------------------------------------------------ climatología de lluvia + Tmin ERA5-Land
    clim = pd.read_csv(RES / "climatologia.csv")
    gee = pd.read_csv("huanuco_mensual_2015_2029.csv", usecols=["celda", "fecha", "tmin", "t2m"])
    gee = gee.drop_duplicates(["celda", "fecha"], keep="last").dropna(subset=["tmin"])
    gee["mes"] = gee.fecha.str[5:7].astype(int)
    tmin = gee.groupby(["celda", "mes"]).tmin.mean()
    periodo_t = [gee.fecha.min(), gee.fecha.max()]

    def por_mes(df, col):
        tabla = df.pivot(index="celda", columns="mes", values=col).reindex(celdas.celda)
        return [[r(v) for v in fila] for fila in tabla.values]

    escribir("climatologia.json", {
        "periodo_lluvia": cfg["periodo"], "periodo_tmin": periodo_t,
        "normal": por_mes(clim, "normal"), "q33": por_mes(clim, "q33"), "q67": por_mes(clim, "q67"),
        "tmin": [[r(tmin.get((c, m))) for m in range(1, 13)] for c in celdas.celda]})

    # ------------------------------------------------ histórico observado + pronóstico retrospectivo
    pisco = m07.leer_pisco("pisco_prec.nc", celdas.celda.unique())
    pisco = pisco[pisco.fecha >= cfg["periodo"][0]]
    tabla = pisco.pivot(index="fecha", columns="celda", values="pp").reindex(columns=celdas.celda).sort_index()
    modelo_h1 = cfg["modelo_por_horizonte"]["1"]
    wf = pd.read_csv(RES / "predicciones_walkforward.csv",
                     usecols=["celda", "fecha_obj", "h", "normal_obj", "sd_obj", f"zhat_{modelo_h1}"])
    wf = wf[wf.h == 1]
    wf["mm"] = m07.a_mm(wf.normal_obj.values, wf.sd_obj.values, wf[f"zhat_{modelo_h1}"].values)
    t_wf = wf.pivot(index="fecha_obj", columns="celda", values="mm").reindex(columns=celdas.celda).sort_index()
    escribir("historico.json", {
        "inicio": tabla.index[0], "fin": tabla.index[-1],
        "pp": [[None if pd.isna(v) else int(round(v)) for v in fila] for fila in tabla.values],
        "retro": {"modelo": modelo_h1, "inicio": t_wf.index[0], "fin": t_wf.index[-1],
                  "pp": [[None if pd.isna(v) else int(round(v)) for v in fila] for fila in t_wf.values]}})

    # ------------------------------------------------ metadatos, métricas y zonas
    res = pd.read_csv(RES / "metricas_resumen.csv")
    rpss = pd.read_csv(RES / "rpss.csv")
    wfm = pd.read_csv(RES / "metricas_walkforward.csv")
    elegido = cfg["modelo_por_horizonte"]
    tabla_m = []
    for _, f in res.iterrows():
        tabla_m.append({"h": int(f.h), "modelo": f.modelo, "SS": r(f.SS_clim, 3), "RMSE": r(f.RMSE, 1),
                        "ACC": r(f.ACC, 3), "anios_pos": f.anios_SS_positivo})
    por_anio = wfm[(wfm.modelo == elegido["1"]) & (wfm.h == 1)][["anio", "SS_clim"]]
    normal_anual = clim.groupby("celda").normal.sum()
    zon = []
    for z, g in celdas.groupby("zona"):
        cz = clim[clim.celda.isin(g.celda)].groupby("mes").normal.mean()
        tz = [r(np.nanmean([tmin.get((c, m), np.nan) for c in g.celda])) for m in range(1, 13)]
        zon.append({"zona": int(z), "nombre": NOMBRES_ZONA.get(int(z), f"Zona {z}"), "celdas": len(g),
                    "elev_media": round(g.elev.mean()), "elev_min": round(g.elev.min()), "elev_max": round(g.elev.max()),
                    "lluvia_anual": round(normal_anual.reindex(g.celda).mean()),
                    "normal_mensual": [r(v) for v in cz.values], "tmin_mensual": tz})
    escribir("meta.json", {
        "generado": time.strftime("%Y-%m-%d"), "emision": cfg["generado"][:10],
        "ultimo_mes_observado": cfg["ultimo_mes_observado"], "periodo": cfg["periodo"],
        "modelo_por_horizonte": elegido, "anios_prueba": cfg["anios_prueba"], "oni": cfg.get("oni_ultimo"),
        "metricas": tabla_m, "ss_por_anio_h1": [{"anio": int(a), "SS": r(s, 3)} for a, s in por_anio.values],
        "rpss": [{"h": int(f.h), "modelo": f.modelo, "RPSS": r(f.RPSS, 3)} for _, f in rpss.iterrows()],
        "zonas": zon, "n_celdas": n,
        "fuentes": {"lluvia": "PISCOp v2.1 mensual – SENAMHI", "enso": "ONI – NOAA CPC",
                    "temperatura": "ERA5-Land mensual (ECMWF) vía Google Earth Engine"}})
    print(f"Listo en {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
