# Documentación técnica — Predicción climática Huánuco (ML + datos geoespaciales)

Nov 7, 2026 · @Oadler

## Resumen y alcance

El sistema pronostica la precipitación mensual de la región Huánuco con 1 a 3 meses de anticipación, en 378 celdas de 0.1° (\~11 × 11 km), y compara Random Forest, XGBoost y una red neuronal MLP contra dos líneas base.

| Aspecto | Definición |
| --- | --- |
| Variable objetivo | Precipitación mensual (mm/mes) de PISCOp – SENAMHI; CHIRPS como objetivo provisional mientras no se une PISCO |
| Variable secundaria | Temperatura media mensual (ERA5-Land), mismo pipeline cambiando la columna objetivo |
| Unidad de análisis | Celda de 0.1° × mes, grilla alineada con PISCO (centros en .x5) |
| Periodo | Enero 2015 – diciembre 2025 (PISCO disponible hasta junio 2025) |
| Horizonte | h = 1, 2 y 3 meses |
| Resolución temporal | Mensual: total del mes para lluvia, promedio del mes para el resto. No es pronóstico horario del tiempo |
| Salidas | Métricas comparativas, importancia de variables, mapas de pronóstico y variabilidad, zonas homogéneas y una aplicación de consulta |

El sistema predice clima (condiciones esperadas de un mes en una zona), no tiempo (el estado de la atmósfera en una hora dada).

## Arquitectura y flujo

El sistema es un pipeline lineal de seis etapas: los datos se agregan en Earth Engine, se sanean y unen en Python, y los resultados alimentan una aplicación de consulta.

| Etapa | Archivo | Entrada | Salida |
| --- | --- | --- | --- |
| 1. Adquisición | `huanuco_gee_5anios.js` (Earth Engine Code Editor) | Catálogo GEE: ERA5-Land, CHIRPS, MODIS, SRTM | `huanuco_mensual_AAAA_AAAA.csv`, `huanuco_estaticas.csv` |
| 2. Saneamiento | `sanear_dataset.py` | CSV de la etapa 1 | `dataset_huanuco_2015_2025.csv`, `reporte_saneamiento.txt` |
| 3. Objetivo y ENSO | `04_unir_pisco_oni.py` | Dataset saneado, PISCOp (IRI), ONI (NOAA) | `dataset_modelo.csv` |
| 4. Modelado y evaluación | `05_modelar.py` | `dataset_modelo.csv` | `resultados/metricas.csv`, `ablacion.csv`, `importancia.csv`, `predicciones_test.csv`, `pronostico_actual.csv`, `modelo_h{1,2,3}.joblib` |
| 5. Espacialización y zonas | `06_mapas_zonas.py` | Salidas de la etapa 4 | `resultados/mapa_*.png`, `zonas.csv`, `resumen_zonas.csv`, `celdas.geojson` |
| 6. Consulta | `app.py` (Streamlit) | Carpeta `resultados/` | Aplicación web local |

Cada etapa lee solo archivos de la anterior, así que cualquiera se puede repetir sin rehacer las demás. Todo el volumen de datos 2015–2025 ocupa unos 10 MB.

## Fuentes de datos y unidades

Todas las fuentes son abiertas y se descargan sin solicitudes ni permisos; las unidades ya llegan convertidas al dataset.

| Columna | Fuente | Rol | Conversión aplicada | Unidad final |
| --- | --- | --- | --- | --- |
| `pp_pisco` | PISCOp v2.1 mensual, SENAMHI ([IRI Data Library](https://iridl.ldeo.columbia.edu/SOURCES/.SENAMHI/.HSR/.PISCO/.Prec/.v2p1/.unstable/.monthly/.Prec)) | Objetivo | Ninguna (mm/día × días si viniera diario) | mm/mes |
| `pp_chirps` | CHIRPS pentadal, `UCSB-CHG/CHIRPS/PENTAD` | Objetivo provisional y predictor | Suma de 6 pentadas | mm/mes |
| `pp_era5` | ERA5-Land, `ECMWF/ERA5_LAND/MONTHLY_AGGR` | Predictor | m × 1000 | mm/mes |
| `t2m`, `tmin`, `tmax` | ERA5-Land | Predictor; objetivo secundario (`t2m`) | K − 273.15 | °C |
| `hr` | ERA5-Land (punto de rocío y t2m) | Predictor | Fórmula de Magnus | % |
| `rad` | ERA5-Land, radiación solar descendente | Predictor | J/m² ÷ 10⁶ | MJ/m² por mes |
| `hum_suelo` | ERA5-Land, capa 1 | Predictor | Ninguna | m³/m³ |
| `ndvi` | MODIS `MOD13A3` | Predictor | × 0.0001 | adimensional |
| `lst` | MODIS `MOD11A2`, LST diurna | Predictor | × 0.02 − 273.15 | °C |
| `elev`, `rugosidad`, `pendiente`, `orient_norte` | SRTM 30 m, `USGS/SRTMGL1_003` | Predictor fijo | Media y desviación por celda; coseno de la orientación | m, m, grados, −1 a 1 |
| `oni` | Oceanic Niño Index, [NOAA CPC](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt) | Predictor ENSO | Estación de 3 meses asignada a su mes central | °C (anomalía) |

PISCO se usa como objetivo porque combina estaciones de SENAMHI con satélite; las fuentes satelitales sin estaciones solo entran como predictores.

## Adquisición en Google Earth Engine

La extracción calcula en el servidor de Google un promedio por celda y por mes, de modo que se descargan tablas de pocos MB en lugar de rásters de varios GB por año.

1. **Área de estudio.** El polígono del departamento se toma de `FAO/GAUL/2015/level1`, seleccionando el que contiene la ciudad de Huánuco (−76.24, −9.93).
2. **Grilla.** Se generan celdas de 0.1° con bordes en múltiplos de 0.1 y centros en .x5, la misma grilla de PISCO, y se conservan las que tocan el departamento: 378 celdas.
3. **Imagen mensual.** Para cada mes se arma una imagen con ERA5-Land, CHIRPS (suma de pentadas), NDVI y LST de MODIS, con las unidades ya convertidas. Si una fuente no tiene datos en un mes, la banda queda vacía en lugar de detener el proceso.
4. **Reducción espacial.** `reduceRegions` con reductor media a 1 km por celda; las variables del terreno usan media y desviación estándar a 250 m.
5. **Exportación.** `Export.table.toDrive` en CSV, con columnas fijas: una tarea mensual por bloque de años y una tarea de variables estáticas.
6. **Verificación previa.** Antes de exportar, la consola muestra el número de celdas, de meses y de filas esperadas, una vista previa y gráficos regionales de lluvia y temperatura donde un mes faltante se ve como hueco.

Para 2015–2025 se exportaron bloques de cinco años (2015–2019, 2020–2024) y uno de 2025; el saneamiento los une.

## Saneamiento y control de calidad

El bloque 2020–2024 llegó completo (378 celdas × 60 meses = 22 680 filas, sin duplicados ni meses faltantes); el único problema de fondo es el sesgo de lluvia de ERA5-Land.

**Reglas aplicadas por `sanear_dataset.py`**

1. Elimina duplicados `(celda, fecha)` producidos por bloques superpuestos.
2. Construye la tabla completa celdas × meses y reporta los meses ausentes; nunca los inventa.
3. Convierte en vacío todo valor fuera de su rango físico (por ejemplo, humedad relativa > 100 %).
4. Rellena huecos sueltos solo en predictores: interpolación de hasta 2 meses y, si no alcanza, la climatología de la celda. El objetivo no se rellena.
5. Calcula la razón ERA5/CHIRPS por celda y marca como `lluvia_inconsistente` las que difieren más de 3 veces.
6. Une las variables estáticas y guarda un único CSV.

**Hallazgos en los datos reales (2020–2024)**

| Control | Resultado |
| --- | --- |
| Completitud | 12 meses en los 5 años y 378 celdas en todos los meses |
| Valores fuera de rango | 0 en todas las variables |
| Huecos de LST | 100 (0.44 %), todos en meses de lluvia por nubosidad: 77 interpolados, 23 por climatología |
| Lluvia ERA5 frente a CHIRPS | ERA5 es 1.55 veces CHIRPS en promedio; correlación mensual por celda con mediana 0.85 |
| Celdas inconsistentes | 15, agrupadas al este de la ciudad de Huánuco (lon −75.65 a −75.95, lat −9.75 a −9.95), con ERA5 entre 3.9 y 10.1 veces CHIRPS |
| Coherencia física | Ciclo de lluvias dic–mar y estiaje jun–ago; temperatura media de celda entre \~3 °C (puna) y \~26 °C (selva baja) |

**Contraste con estación.** En enero de 2021 la estación CP-Huánuco (1947 m) registró Tmax media 25.7 °C, Tmin media 15.8 °C y 74.3 mm ([boletín DZ-10 SENAMHI](https://www.senamhi.gob.pe/load/file/04401SENA-96.pdf)). La celda que la contiene dio 86 mm con CHIRPS y 238 mm con ERA5, y una temperatura unos 7 °C menor. Conclusiones: ERA5 no sirve como objetivo de lluvia, y la temperatura de celda representa la altitud media de la celda, no la del fondo del valle; por eso la aplicación corrige por altitud.

## Ingeniería de variables

El modelo predice la anomalía del mes objetivo, no el valor bruto, para que la estacionalidad no infle las métricas; el valor final se reconstruye sumando la climatología.

```latex
a_{c,t} = y_{c,t} - \bar{y}_{c,m(t)} \qquad \hat{y}_{c,t+h} = \max\left(0,\; \bar{y}_{c,m(t+h)} + \hat{a}_{c,t+h}\right)
```

Donde c es la celda, t el mes, m(t) el mes calendario, h el horizonte y la barra la climatología calculada solo con el periodo de entrenamiento.

| Grupo | Predictores (en el mes t) | Cantidad |
| --- | --- | --- |
| Objetivo (rezagos) | Anomalía en t, t−1, t−2, t−3 y t−11; medias móviles de 3 y 6 meses | 7 |
| Satelital | Anomalías de CHIRPS o PISCO, ERA5 (lluvia, t2m, tmin, tmax, hr, rad, humedad del suelo), NDVI y LST, en t y t−1 | hasta 20 |
| ENSO | ONI con rezago de 2 y 3 meses | 2 |
| Estacionalidad | Seno y coseno del mes objetivo | 2 |
| Geoespacial | Longitud, latitud, altitud, rugosidad, pendiente, orientación norte | 6 |

**Prevención de fuga de información**

- La climatología de cada celda y mes se calcula solo con entrenamiento.
- El ONI es una media móvil centrada de 3 meses: el valor rotulado t−1 ya incluye el mes t. Por eso se usa con rezago 2 y 3.
- El objetivo se toma exactamente h meses después en la misma celda; si hay un mes faltante, la fila se descarta.
- La partición es por fecha objetivo, no aleatoria.

## Modelos y diseño experimental

Tres modelos de Machine Learning se comparan contra dos líneas base, con partición temporal y una métrica de habilidad que exige superar a la climatología.

| Modelo | Tipo | Configuración en `05_modelar.py` |
| --- | --- | --- |
| Climatología | Línea base | Anomalía = 0 (predice el valor normal del mes) |
| Persistencia | Línea base | La anomalía del mes t se repite en t+h |
| Random Forest | Ensamble de árboles | 300 árboles, hoja mínima 5, 50 % de predictores por división |
| XGBoost | Gradient boosting | Hasta 800 árboles, tasa 0.03, profundidad 6, submuestreo 0.8, parada temprana en validación |
| MLP | Red neuronal | Capas 64-32, regularización 1e-3, estandarización previa, parada temprana |

**Partición temporal (2015–2025).** Entrenamiento: fecha objetivo hasta dic 2021. Validación: 2022, usada para la parada temprana y para elegir el mejor modelo por horizonte. Prueba: ene 2023 a jun 2025, datos nunca vistos. Se cambia con `--val` y `--test`.

**Métricas** (sobre el valor final en mm): RMSE, MAE, R², KGE y la habilidad frente a climatología:

```latex
SS_{clim} = 1 - \frac{MSE_{modelo}}{MSE_{climatologia}} \qquad KGE = 1 - \sqrt{(r-1)^2 + (\sigma_s/\sigma_o - 1)^2 + (\mu_s/\mu_o - 1)^2}
```

SS > 0 indica mejora real; un R² alto con SS ≈ 0 solo refleja la estacionalidad.

**Ablación (PE3).** Con XGBoost y h = 1 se reentrena quitando grupos: sin geoespaciales, sin ENSO, sin satelitales, y solo rezagos con estacionalidad.

**Importancia (PE1, PE2).** Importancia por permutación del XGBoost sobre prueba, medida como aumento del RMSE al desordenar cada predictor, agrupada por tipo de variable.

## Espacialización, variabilidad y zonas

`06_mapas_zonas.py` convierte los resultados por celda en cinco mapas y una zonificación climática con K-means.

| Mapa | Indicador por celda | Pregunta que responde |
| --- | --- | --- |
| `mapa_climatologia.png` | Lluvia anual normal (solo años completos) | Distribución espacial del clima (OE5) |
| `mapa_variabilidad.png` | Coeficiente de variación interanual = desviación / media anual × 100 | Zonas de mayor variabilidad (OE6, PE4) |
| `mapa_error_modelo.png` | RMSE del mejor modelo y skill frente a climatología en prueba | Dónde el modelo es confiable |
| `mapa_pronostico.png` | Anomalía pronosticada (%) para h = 1, 2 y 3 | Pronóstico espacializado (OE5) |
| `mapa_zonas.png` | Zona K-means | Zonas climáticas homogéneas (OE6) |

**Zonificación.** Cada celda se describe con la forma de su ciclo anual (12 valores normalizados), la lluvia anual, la altitud y el CV. Tras estandarizar, se prueba k = 3 a 6 y se elige el k con mayor silhouette. Las zonas se numeran de mayor a menor altitud media; `resumen_zonas.csv` da por zona el número de celdas, la altitud, la lluvia normal, el CV y el error del modelo.

En la prueba con datos reales, el mapa reprodujo el gradiente esperado: unos 500 mm/año en el valle seco del Huallaga alrededor de la ciudad y más de 3000 mm/año en la selva alta al noreste. El CV interanual fue del 3 % al 16 %, mayor en los bordes noroeste y este. `celdas.geojson` lleva todos los atributos para la aplicación y para QGIS.

## Aplicación de consulta

`app.py` (Streamlit) responde, para una ubicación, cuánta lluvia se espera en los próximos 3 meses frente a lo normal y qué alertas agrícolas implica.

| Pestaña | Contenido |
| --- | --- |
| Consulta | Latitud, longitud y altitud opcional → celda más cercana y su zona; lluvia pronosticada (mm), normal y anomalía (%) para h = 1, 2, 3; categoría; Tmin esperada corregida por altitud; alertas; serie histórica con el pronóstico de prueba |
| Mapas | Mapa interactivo (pydeck) de anomalía pronosticada o de zonas, con la ubicación marcada, y los mapas estáticos de la etapa 5 |
| Modelos | Tabla de métricas en prueba, ablación e importancia de predictores |

**Reglas de la consulta**

- Categoría de lluvia: bajo lo normal si la anomalía es menor de −15 %, sobre lo normal si supera +15 %, normal en el resto.
- Alerta de déficit: categoría bajo lo normal en un mes de la campaña de secano (septiembre a abril).
- Alerta de lluvias intensas: anomalía mayor de +50 %.
- Corrección por altitud: Tmin del lugar = Tmin de la celda − 6.5 °C × (altitud del lugar − altitud media de la celda) / 1000.
- Alerta de heladas: Tmin corregida ≤ 0 °C.

En la prueba, una consulta a 4300 m en la celda más fría devolvió Tmin de −4.9 a −4.1 °C entre enero y marzo y activó la alerta de heladas; la misma consulta en la ciudad de Huánuco no generó alertas.

## Guía de ejecución

Con los CSV de Earth Engine ya descargados, faltan cinco comandos; todo corre en una laptop en unos 5 minutos.

1. Poner en una carpeta los `huanuco_mensual_*.csv`, `huanuco_estaticas.csv` y los scripts.
2. Instalar dependencias: `pip install -r requirements.txt` (o en Google Colab, subiendo los archivos).
3. `python sanear_dataset.py` → revisar `reporte_saneamiento.txt`: el punto 2 debe decir OK y el final, 132 meses.
4. `python 04_unir_pisco_oni.py` → descarga PISCO y ONI. Si falla la descarga de PISCO, abrir la URL que imprime, guardar el archivo como `pisco_prec.nc` en la carpeta y repetir. Verificar que la correlación PISCO–CHIRPS sea mayor de 0.7.
5. `python 05_modelar.py` → métricas, ablación, importancia, modelos y pronóstico actual en `resultados/`.
6. `python 06_mapas_zonas.py` → mapas, zonas y `celdas.geojson`.
7. `streamlit run app.py` → abre la aplicación en el navegador.

**Variantes**

- Sin PISCO: `python 05_modelar.py --datos dataset_huanuco_2015_2025.csv --objetivo pp_chirps`
- Temperatura: `python 05_modelar.py --objetivo t2m`
- Otra partición: `python 05_modelar.py --val 2021-01 --test 2023-01`

En el código, `05_modelar.py`, `06_mapas_zonas.py` y `app.py` se probaron completos con los datos reales 2020–2024; `04_unir_pisco_oni.py` se probó con un archivo con el formato del IRI, porque desde el entorno de desarrollo no hubo acceso a ese servidor.

## Resultados

Con solo 5 años y CHIRPS como objetivo, XGBoost iguala a la climatología (SS entre −0.002 y 0.032) y los demás modelos quedan por debajo; son resultados de prueba del pipeline, no los del artículo.

Condiciones de esta corrida: datos 2020–2024, entrenamiento hasta dic 2022, validación 2023, prueba 2024 (4536 filas por horizonte), sin ONI. La corrida final con 2015–2025 y PISCO reemplaza estas tablas con `resultados/metricas.csv`, `ablacion.csv` e `importancia.csv`.

**Desempeño en prueba**

| Modelo | RMSE h=1 (mm) | RMSE h=2 (mm) | RMSE h=3 (mm) | SS h=1 | SS h=2 | SS h=3 |
| --- | --- | --- | --- | --- | --- | --- |
| XGBoost | 51.6 | 51.7 | 50.9 | 0.004 | −0.002 | 0.032 |
| Climatología | 51.7 | 51.7 | 51.7 | 0 | 0 | 0 |
| Random Forest | 61.6 | 55.8 | 52.6 | −0.419 | −0.165 | −0.034 |
| Persistencia | 70.1 | 61.9 | 67.1 | −0.840 | −0.434 | −0.687 |
| MLP | 74.1 | 63.9 | 71.3 | −1.057 | −0.529 | −0.904 |

XGBoost obtuvo R² = 0.70 con SS ≈ 0: casi todo el R² proviene del ciclo estacional, lo que confirma la necesidad de reportar SS.

**Ablación (XGBoost, h = 1)**

| Variante | Predictores | RMSE (mm) | SS |
| --- | --- | --- | --- |
| Completo | 33 | 51.6 | 0.004 |
| Sin satelitales | 15 | 51.6 | 0.005 |
| Sin geoespaciales | 27 | 51.7 | −0.002 |
| Solo rezagos y estacionalidad | 9 | 55.4 | −0.148 |

Los predictores con mayor importancia por permutación fueron la anomalía actual de lluvia (0.118), la estacionalidad (0.034), la anomalía de humedad relativa (0.031), la anomalía de Tmax del mes anterior (0.016) y la lluvia ERA5 del mes anterior (0.015). Con 2 años de entrenamiento la climatología misma es inestable; se espera que la serie 2015–2025, PISCO y el ONI mejoren la habilidad, y si no la superan, ese resultado también es reportable.

## Correspondencia con el artículo

Cada objetivo específico y problema del Capítulo I tiene un script y un archivo de salida que lo responde.

| Objetivo / problema | Cómo se responde | Script | Evidencia |
| --- | --- | --- | --- |
| OE1: recopilar y preparar datos | Extracción GEE, saneamiento, unión con PISCO | `.js`, `sanear_dataset.py`, `04_unir_pisco_oni.py` | `reporte_saneamiento.txt`, `dataset_modelo.csv` |
| OE2 / PE1: variables con mayor capacidad predictiva | Importancia por permutación agrupada | `05_modelar.py` | `importancia.csv` |
| OE3: desarrollar modelos | RF, XGBoost, MLP con líneas base | `05_modelar.py` | `modelo_h*.joblib` |
| OE4 / PE2: comparar desempeño | RMSE, MAE, R², KGE y SS en prueba, por horizonte | `05_modelar.py` | `metricas.csv` |
| PE3: combinación de variables | Ablación por grupos | `05_modelar.py` | `ablacion.csv` |
| OE5: predicciones espacializadas | Mapas de pronóstico y normal | `06_mapas_zonas.py` | `mapa_pronostico.png`, `mapa_climatologia.png` |
| OE6 / PE4: zonas de mayor variabilidad | CV interanual y K-means | `06_mapas_zonas.py` | `mapa_variabilidad.png`, `mapa_zonas.png`, `resumen_zonas.csv` |
| Vínculo agrícola | Alertas de déficit y heladas por ubicación | `app.py` | Aplicación de consulta |

El Capítulo I debe ajustar sus alcances a lo ejecutado: precipitación como variable principal, periodo 2015–2025, resolución 0.1°, horizonte mensual de 1 a 3 meses y validación contra PISCO.

## Limitaciones y trabajo futuro

La principal limitación es que la validación usa PISCO, que ya incorpora las estaciones de SENAMHI, así que no existe un contraste totalmente independiente.

| Limitación | Efecto | Trabajo futuro |
| --- | --- | --- |
| PISCO incluye estaciones SENAMHI | Validación no independiente | Validar con estaciones no usadas por PISCO o con datos solicitados a la DZ-10 Huánuco |
| PISCO v2.1 llega a junio 2025 | El pronóstico operativo parte de ese mes | Actualizar a PISCOp v3.0 cuando esté accesible |
| 11 años de serie | Climatología y patrones ENSO con pocas repeticiones | Extender a 1981–2025 con PISCO y ERA5-Land; MODIS limita a 2001 |
| Celda de \~120 km² | No representa microclimas de valle | Reducción de escala a 1 km con covariables de terreno |
| Sesgo de lluvia de ERA5-Land (hasta 10 veces en 15 celdas) | Predictor ruidoso en la transición Andes–selva | Corrección de sesgo o exclusión de esas celdas en un análisis de sensibilidad |
| Gradiente térmico fijo de −6.5 °C/km | Corrección de altitud aproximada | Gradiente local estimado con estaciones |
| Sin LSTM ni modelos de series profundas | Comparación limitada a modelos tabulares | Incluir LSTM con la serie completa |

Fuentes consultadas: [PISCO en IRI Data Library](https://iridl.ldeo.columbia.edu/SOURCES/.SENAMHI/.HSR/.PISCO/.Prec/.v2p1/.unstable/.monthly/.Prec), [ONI de NOAA CPC](https://www.cpc.ncep.noaa.gov/data/indices/oni.ascii.txt), [boletín hidroclimático DZ-10 SENAMHI](https://www.senamhi.gob.pe/load/file/04401SENA-96.pdf).
