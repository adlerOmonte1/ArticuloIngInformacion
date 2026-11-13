# Predicción climática Huánuco — ML + datos geoespaciales

Pronóstico mensual de precipitación (1 a 3 meses) en 378 celdas de 0.1° de la región Huánuco.
La documentación completa del desarrollo está en la Doc del proyecto.

## Orden de ejecución
| Paso | Archivo | Qué hace | Salida |
|---|---|---|---|
| 1 | `huanuco_gee_5anios.js` | Earth Engine Code Editor: promedios mensuales por celda (cambiar años) | `huanuco_mensual_AAAA_AAAA.csv`, `huanuco_estaticas.csv` |
| 2 | `sanear_dataset.py` | Une bloques, quita duplicados, controla rangos, rellena huecos sueltos, marca celdas inconsistentes | `dataset_huanuco_2015_2025.csv`, `reporte_saneamiento.txt` |
| 3 | `04_unir_pisco_oni.py` | Agrega PISCOp (objetivo) y ONI | `dataset_modelo.csv` |
| 4 | `05_modelar.py` | Climatología, Persistencia, RF, XGBoost, MLP; ablación; importancia; pronóstico actual | `resultados/` |
| 5 | `06_mapas_zonas.py` | Mapas, variabilidad, zonas K-means, GeoJSON | `resultados/*.png`, `zonas.csv` |
| 6 | `app.py` | Aplicación de consulta | `streamlit run app.py` |

```
pip install -r requirements.txt
python sanear_dataset.py
python 04_unir_pisco_oni.py
python 05_modelar.py
python 06_mapas_zonas.py
streamlit run app.py
```
Sin PISCO (prueba): `python 05_modelar.py --datos dataset_huanuco_2015_2025.csv --objetivo pp_chirps`
Temperatura: `python 05_modelar.py --objetivo t2m`

Los scripts `01_`, `02_` y `03_` son la ruta alternativa en Python para extraer de GEE; la ruta principal es el `.js`.