# Clima Huánuco — frontend web

Página estática (HTML + CSS + JavaScript, sin servidor de aplicaciones). Lee los JSON de `data/`, que genera
`09_exportar_web.py`; **no ejecuta el modelo** en el navegador.

```
web/
├── index.html        estructura: pronóstico, Mi parcela, zonas, metodología
├── css/styles.css    estilos (modo claro y oscuro automáticos, adaptable a celular)
├── js/app.js         lógica: mapa (Leaflet), selector de mes, alertas, gráficos SVG
└── data/             generado por 09_exportar_web.py (≈ 1.1 MB)
    ├── meta.json         emisión, modelo, métricas, zonas, ONI
    ├── celdas.geojson    378 celdas de 0.1°
    ├── pronostico.json   3 meses: mm, normal, probabilidades por terciles, categoría
    ├── climatologia.json normal, terciles y Tmin por celda y mes
    └── historico.json    lluvia observada 1981→ y pronóstico retrospectivo 2016–2025 (carga diferida)
```

## Ver en local
Los navegadores bloquean `fetch` sobre `file://`, así que se sirve con un servidor estático:
```
python -m http.server 8765 -d web
```
y se abre http://localhost:8765

## Qué muestra según el mes elegido
| Mes | Modo | Fuente |
|---|---|---|
| Hasta el último mes observado | Observado (y lo que el modelo pronosticó a 1 mes, 2016–2025) | `historico.json` |
| Los 3 meses siguientes | Pronóstico probabilístico | `pronostico.json` |
| Más adelante | Perspectiva climatológica (normal y rango típico) | `climatologia.json` |

## Actualización mensual
```
python 07_modelo_pisco.py      # reentrena y pronostica con el nuevo pisco_prec.nc
python 09_exportar_web.py      # regenera web/data/
```
y se vuelve a publicar la carpeta `web/`.

## Publicar en Vercel (gratis)
La carpeta `web/` ya trae `vercel.json` (sin paso de compilación; los datos de `data/` no se guardan en caché,
así que cada actualización mensual se ve al instante).

**Opción A — desde GitHub (recomendada, se actualiza sola en cada `git push`):**
1. Sube el repositorio a GitHub.
2. En vercel.com → *Add New… → Project* → importa el repositorio.
3. *Root Directory*: `ArticuloIngInformacion/web` (o `web` si el repositorio empieza en esta carpeta).
4. *Framework Preset*: **Other**. Deja vacíos *Build Command* y *Output Directory*.
5. *Deploy*. La URL queda como `https://<proyecto>.vercel.app` y se puede cambiar el nombre en *Settings → Domains*.

**Opción B — desde la terminal:**
```
npm i -g vercel
cd web
vercel          # primera vez: inicia sesión y crea el proyecto (vista previa)
vercel --prod   # publica en producción
```

**Actualización mensual:** `python 07_modelo_pisco.py` → `python 09_exportar_web.py` → `git push` (opción A) o `vercel --prod` (opción B).

También funciona igual en Netlify, Cloudflare Pages o GitHub Pages.

Servicios externos (todos gratuitos y sin clave de API):
- **Leaflet 1.9.4** (unpkg): librería del mapa.
- **OpenStreetMap** (vista "Mapa": calles, pueblos, ríos) y **Esri World Imagery** (vista "Satélite"). Ambas exigen mostrar la atribución, que ya aparece en el mapa.
- **Nominatim** (buscador de pueblos de OpenStreetMap): máximo 1 búsqueda por segundo; solo se consulta al pulsar "Buscar".

Google Maps no se usa porque su API exige clave y una cuenta con tarjeta de crédito, y usar sus mosaicos sin clave infringe sus condiciones.

## Lenguaje
Los textos visibles están pensados para agricultores y personas mayores: sin términos técnicos, con posibilidades
expresadas como "6 de cada 10". Los términos técnicos (SS, RPSS, Ridge, terciles, ERA5-Land…) solo aparecen
en la sección plegable "Información técnica".
