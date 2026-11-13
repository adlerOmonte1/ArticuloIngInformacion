"""
app.py — Sistema de consulta climática Huánuco
Ejecutar (después de 05 y 06):  streamlit run app.py

Consulta: el usuario indica una ubicación (y opcionalmente su altitud) y obtiene, para los
próximos 3 meses, la lluvia pronosticada frente a la normal, la categoría (bajo/normal/sobre lo
normal), alertas agrícolas y la temperatura mínima esperada corregida por altitud.
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pydeck as pdk
import streamlit as st

OUT = Path("resultados")
GRADIENTE = -6.5 / 1000            # °C por metro (gradiente térmico estándar)
UMBRAL_ANOM = 15                   # ±15 % = rango normal de lluvia (criterio usado por SENAMHI)
UMBRAL_HELADA = 0.0                # °C, Tmin mensual corregida por altitud
CAMPANA = {9, 10, 11, 12, 1, 2, 3, 4}   # campaña agrícola de secano sep-abr
MESES = ["", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]

st.set_page_config(page_title="Clima Huánuco", page_icon="🌦️", layout="wide")


@st.cache_data
def cargar():
    cfg = json.load(open(OUT / "config.json"))
    datos = pd.read_csv(cfg["datos"])
    return {
        "cfg": cfg,
        "datos": datos,
        "pron": pd.read_csv(OUT / "pronostico_actual.csv"),
        "met": pd.read_csv(OUT / "metricas.csv"),
        "abl": pd.read_csv(OUT / "ablacion.csv"),
        "imp": pd.read_csv(OUT / "importancia.csv"),
        "pred": pd.read_csv(OUT / "predicciones_test.csv"),
        "zonas": pd.read_csv(OUT / "zonas.csv"),
        "geo": json.load(open(OUT / "celdas.geojson")),
        "temp": datos.groupby(["celda", "mes"])[["t2m", "tmin", "tmax"]].mean(),
    }


def celda_cercana(zonas, lat, lon):
    d = (zonas.lat - lat) ** 2 + (zonas.lon - lon) ** 2
    return zonas.loc[d.idxmin()]


def categoria(anom):
    if anom < -UMBRAL_ANOM:
        return "Bajo lo normal"
    if anom > UMBRAL_ANOM:
        return "Sobre lo normal"
    return "Normal"


def color(valor, modo, k=6):
    if valor is None or (isinstance(valor, float) and np.isnan(valor)):
        return [200, 200, 200, 80]
    if modo == "zona":
        paleta = [[102, 194, 165], [252, 141, 98], [141, 160, 203], [231, 138, 195], [166, 216, 84], [255, 217, 47]]
        return paleta[(int(valor) - 1) % len(paleta)] + [170]
    v = float(np.clip(valor / 50, -1, 1))          # anomalía %: -50 marrón ... +50 verde
    return ([int(140 + 100 * (1 + v)), int(81 + 120 * (1 + v)), 10, 180] if v < 0
            else [int(240 - 200 * v), int(240 - 100 * v), int(220 - 120 * v), 180])


D = cargar()
cfg, obj = D["cfg"], D["cfg"]["objetivo"]
es_lluvia = obj.startswith("pp")

st.title("Sistema de consulta climática — Región Huánuco")
st.caption(f"Pronóstico mensual con Machine Learning y datos geoespaciales · variable: {obj} · "
           f"último mes observado: {cfg['ultimo_mes_observado']}")

with st.sidebar:
    st.header("Ubicación")
    lat = st.number_input("Latitud", value=-9.93, min_value=-10.8, max_value=-8.2, step=0.01, format="%.3f")
    lon = st.number_input("Longitud", value=-76.24, min_value=-77.5, max_value=-74.0, step=0.01, format="%.3f")
    alt = st.number_input("Altitud del lugar (m, 0 = usar la de la celda)", value=0, min_value=0, max_value=6500, step=50)
    c = celda_cercana(D["zonas"], lat, lon)
    alt_ref = alt if alt > 0 else float(c.elev)
    st.markdown(f"**Celda:** `{c.celda}`  \n**Altitud media de la celda:** {c.elev:,.0f} m  \n**Zona climática:** {int(c.zona)}")

tab1, tab2, tab3 = st.tabs(["Consulta", "Mapas", "Modelos"])

with tab1:
    p = D["pron"][D["pron"].celda == c.celda].sort_values("h")
    st.subheader(f"Próximos 3 meses desde {cfg['ultimo_mes_observado']}")
    cols = st.columns(3)
    alertas = []
    for col, (_, r) in zip(cols, p.iterrows()):
        mes = int(r.fecha_obj[5:])
        if es_lluvia:
            cat = categoria(r.anomalia_pct)
            col.metric(f"{MESES[mes]} {r.fecha_obj[:4]} (h={int(r.h)})", f"{r.pronostico:,.0f} mm",
                       f"{r.anomalia_pct:+.0f} % vs normal ({r.normal:,.0f} mm)")
            col.write(f"Categoría: **{cat}**")
            if cat == "Bajo lo normal" and mes in CAMPANA:
                alertas.append(f"Déficit de lluvia esperado en {MESES[mes]} durante la campaña agrícola: "
                               "planificar riego o cultivos tolerantes a sequía.")
            if cat == "Sobre lo normal" and r.anomalia_pct > 50:
                alertas.append(f"Lluvias muy por encima de lo normal en {MESES[mes]}: riesgo de huaicos y erosión.")
        else:
            col.metric(f"{MESES[mes]} {r.fecha_obj[:4]} (h={int(r.h)})", f"{r.pronostico:.1f} °C",
                       f"{r.anomalia:+.1f} °C vs normal")
        if (c.celda, mes) in D["temp"].index:
            tmin = D["temp"].loc[(c.celda, mes), "tmin"] + GRADIENTE * (alt_ref - c.elev)
            col.caption(f"Tmin esperada a {alt_ref:,.0f} m: {tmin:.1f} °C")
            if tmin <= UMBRAL_HELADA:
                alertas.append(f"Riesgo de heladas en {MESES[mes]} a {alt_ref:,.0f} m (Tmin ≈ {tmin:.1f} °C).")

    st.subheader("Alertas agrícolas")
    if alertas:
        for a in dict.fromkeys(alertas):
            st.warning(a)
    else:
        st.success("Sin alertas para los próximos 3 meses.")
    st.caption("La temperatura se corrige por altitud con −6.5 °C cada 1000 m respecto a la altitud media de la celda.")

    st.subheader("Histórico y validación del modelo en la celda")
    hist = D["datos"][D["datos"].celda == c.celda].set_index("fecha")[[obj]].rename(columns={obj: "Observado"})
    pr = D["pred"][(D["pred"].celda == c.celda) & (D["pred"].h == 1)].set_index("fecha_obj")
    mejor = D["met"].query("h == 1 and particion == 'val' and modelo in ['XGBoost','RandomForest','MLP']") \
                    .sort_values("RMSE").modelo.iloc[0]
    hist = hist.join(pr[[f"pred_{mejor}", "pred_Climatologia"]].rename(
        columns={f"pred_{mejor}": f"Pronóstico {mejor} (h=1)", "pred_Climatologia": "Normal"}), how="left")
    st.line_chart(hist)

with tab2:
    modo = st.radio("Capa", ["Anomalía pronosticada h=1", "Zonas climáticas"], horizontal=True)
    geo = json.loads(json.dumps(D["geo"]))
    for f in geo["features"]:
        pr_ = f["properties"]
        f["properties"]["color"] = (color(pr_.get("zona"), "zona") if modo == "Zonas climáticas"
                                    else color(pr_.get("anomalia_h1"), "anom"))
    capa = pdk.Layer("GeoJsonLayer", geo, pickable=True, stroked=False, filled=True, get_fill_color="properties.color")
    marcador = pdk.Layer("ScatterplotLayer", pd.DataFrame({"lat": [lat], "lon": [lon]}),
                         get_position="[lon, lat]", get_radius=2500, get_fill_color=[220, 30, 30])
    st.pydeck_chart(pdk.Deck(layers=[capa, marcador],
                             initial_view_state=pdk.ViewState(latitude=-9.5, longitude=-75.9, zoom=6.6),
                             tooltip={"text": "{celda}\nZona {zona}\nAnomalía h1: {anomalia_h1} %"}))
    imgs = ["mapa_climatologia.png", "mapa_variabilidad.png", "mapa_zonas.png",
            "mapa_error_modelo.png", "mapa_pronostico.png"]
    for nombre in imgs:
        if (OUT / nombre).exists():
            st.image(str(OUT / nombre), width="stretch")

with tab3:
    st.subheader("Desempeño en prueba (datos nunca vistos)")
    t = (D["met"][D["met"].particion == "test"]
         .pivot_table(index="modelo", columns="h", values=["RMSE", "MAE", "R2", "KGE", "SS_clim"]).round(3))
    st.dataframe(t, width="stretch")
    st.caption("SS_clim > 0 significa que el modelo mejora a la climatología; un R² alto sin SS > 0 solo refleja la estacionalidad.")
    st.subheader("Ablación de variables (XGBoost, h=1)")
    st.dataframe(D["abl"].round(3), width="stretch", hide_index=True)
    st.subheader("Importancia de predictores (permutación, h=1)")
    st.bar_chart(D["imp"].head(15).set_index("predictor")["importancia"])
