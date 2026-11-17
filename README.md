# Predicción climática Huánuco — ML + datos geoespaciales

Pronóstico mensual de precipitación (1 a 3 meses) en 378 celdas de 0.1° de la región Huánuco,
con probabilidades por terciles (bajo / normal / sobre lo normal) para apoyar decisiones agrícolas.

## Modelo final (operativo)

`07_modelo_pisco.py` → **Ridge sobre anomalías estandarizadas de PISCOp 1981→presente** (rezagos de lluvia + estacionalidad).
Elegido por la mayor habilidad en la evaluación walk-forward 2016–2025:

| Horizonte | SS frente a climatología | RPSS (terciles) |
|---|---|---|
| 1 mes | +0.114 | +0.080 |
| 2 meses | +0.051 | +0.044 |
| 3 meses | +0.017 | +0.020 |

Salidas en `resultados_pisco/`: `pronostico_actual.csv` (lo que consume la web), `climatologia.csv`, `config.json`,
métricas (`metricas_resumen.csv`, `metricas_walkforward.csv`, `rpss.csv`), `predicciones_walkforward.csv` y `modelo_h{1,2,3}.joblib`.

**Actualización mensual:** reemplazar `pisco_prec.nc` por la versión nueva (el IRI ahora pide iniciar sesión;
se descarga en el navegador desde la URL de `04_unir_pisco_oni.py`) y ejecutar:
```
python 07_modelo_pisco.py     # reentrena y pronostica
python 09_exportar_web.py     # actualiza web/data/
```

## Página web

`web/` es el frontend estático: mapa de pronóstico por celda, selector de cualquier mes (observado, pronóstico
o perspectiva climatológica), panel "Mi parcela" con alertas y recomendaciones, zonas climáticas y metodología.
Ver en local con `python -m http.server 8765 -d web`. Detalles y publicación en `web/README.md`.

**En Colab:** abrir `colab/entrenamiento_pisco_colab.ipynb`, subir `colab/paquete_pisco_colab.zip` y ejecutar todo (~1 min).
Los scripts se corren con `!python script.py`, no pegando su código en una celda.

## Pipeline de investigación (artículo, Capítulo IV)

| Paso | Archivo | Qué hace | Salida |
|---|---|---|---|
| 1 | `huanuco_gee_5anios.js` | Earth Engine: promedios mensuales por celda (ERA5-Land, CHIRPS, MODIS, SRTM) | `huanuco_mensual_2015_2029.csv` (datos hasta 2026-10), `huanuco_estaticas.csv` |
| 2 | `sanear_dataset.py` | Quita duplicados, controla rangos, rellena huecos sueltos, marca celdas inconsistentes | `dataset_huanuco_2015_2025.csv`, `reporte_saneamiento.txt` |
| 3 | `04_unir_pisco_oni.py` | Agrega PISCOp (objetivo) y ONI | `dataset_modelo.csv` |
| 4 | `05_modelar.py` | Climatología, Persistencia, RF, XGBoost, MLP con 37 predictores; ablación; importancia | `resultados/` |
| 5 | `06_mapas_zonas.py` | Mapas, variabilidad, zonas K-means, GeoJSON | `resultados/*.png`, `zonas.csv`, `celdas.geojson` |
| 6 | `07_modelo_pisco.py` | Modelo operativo (ver arriba) | `resultados_pisco/` |
| 7 | `08_experimento_agregacion.py` | ¿Mejora la habilidad agregando por trimestre o por zona? XGBoost frente a Ridge | `resultados_pisco/experimento_agregacion.csv` |
| 8 | `09_exportar_web.py` | Convierte los resultados en JSON para la web | `web/data/` |
| — | `app.py` | Prototipo Streamlit anterior (reemplazado por `web/`) | `streamlit run app.py` |

```
pip install -r requirements.txt
python sanear_dataset.py
python 04_unir_pisco_oni.py
python 05_modelar.py
python 06_mapas_zonas.py
python 07_modelo_pisco.py
python 08_experimento_agregacion.py
```
Variantes de 05: `--datos dataset_huanuco_2015_2025.csv --objetivo pp_chirps` (sin PISCO), `--objetivo t2m` (temperatura).
