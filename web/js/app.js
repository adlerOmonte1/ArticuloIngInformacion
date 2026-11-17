/* Clima Huánuco — frontend estático.
   Lee los JSON de data/ (generados por 09_exportar_web.py) y no ejecuta ningún modelo.
   Los textos visibles están en lenguaje sencillo; los términos técnicos solo aparecen en la sección plegable. */
"use strict";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const CAT_TXT = ["Menos lluvia de lo normal", "Lluvia normal", "Más lluvia de lo normal", "Sin tendencia clara"];
const CAT_CORTO = ["Menos lluvia", "Normal", "Más lluvia", "Sin tendencia"];
const GRADIENTE = -6.5 / 1000;        // °C por metro
const CAMPANIA = [9, 10, 11, 12, 1, 2, 3, 4];
const LLUVIOSA = [12, 1, 2, 3];
const RAMPA_MM = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#2a78d6", "#1c5cab", "#104281", "#0d366b"];
const CORTES_MM = [25, 50, 100, 150, 200, 300, 400];
const NOMBRE_MODELO = { Climatologia: "Climatología (referencia)", Persistencia: "Persistencia", XGB_rezagos: "XGBoost",
  XGB_rezagos_oni: "XGBoost + ONI", XGB_completo: "XGBoost + ONI + geo", Ridge_rezagos: "Ridge (lineal)", Ridge_rezagos_oni: "Ridge + ONI" };

const S = { meta: null, geo: null, pron: null, clim: null, hist: null, histPromise: null,
  sel: null, capa: null, cell: null, punto: null, lugar: null, alt: null, map: null, capaGeo: null, base: {}, marca: null, borde: null, C: {} };

/* ------------------------------------------------------------------ utilidades */
const $ = (s) => document.querySelector(s);
const nf = (v, d = 0) => (v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString("es-PE", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (p) => `${Math.round(p * 100)} %`;
const de10 = (p) => `${Math.max(1, Math.round(p * 10))} de cada 10`;
const addM = (ym, k) => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + m - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
const difM = (a, b) => { const [ya, ma] = a.split("-").map(Number); const [yb, mb] = b.split("-").map(Number); return (yb * 12 + mb) - (ya * 12 + ma); };
const mesN = (ym) => Number(ym.slice(5, 7));
const nombreMes = (ym, corto = false) => corto ? `${MES_C[mesN(ym) - 1]} ${ym.slice(2, 4)}` : `${MESES[mesN(ym) - 1]} ${ym.slice(0, 4)}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function hex2rgb(h) { const n = parseInt(h.replace("#", ""), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mezcla(a, b, t) {
  const A = hex2rgb(a), B = hex2rgb(b);
  return "#" + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
function leerColores() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  const oscuro = matchMedia("(prefers-color-scheme: dark)").matches;
  S.C = { dry: g("--dry"), neutral: g("--neutral"), wet: g("--wet"), nos: g("--nosignal"), s2: g("--surface-2"),
    surface: g("--surface"), text: g("--text"), z: [g("--z1"), g("--z2"), g("--z3")], warning: g("--warning"),
    critical: g("--critical"), good: g("--good"), serious: g("--serious"), mid: oscuro ? "#383835" : "#f0efec", oscuro };
}

/* ------------------------------------------------------------------ carga */
async function json(ruta) {
  const r = await fetch(ruta);
  if (!r.ok) throw new Error(`${ruta}: ${r.status}`);
  return r.json();
}
function cargarHistorico() {
  if (!S.histPromise) S.histPromise = json("data/historico.json").then((h) => { S.hist = h; return h; });
  return S.histPromise;
}

async function iniciar() {
  leerColores();
  try {
    [S.meta, S.geo, S.pron, S.clim] = await Promise.all(
      ["meta.json", "celdas.geojson", "pronostico.json", "climatologia.json"].map((f) => json(`data/${f}`)));
  } catch (e) {
    $("#emision").textContent = "No se pudieron cargar los datos";
    $("#detalle").innerHTML = `<div class="empty">No se pudieron cargar los datos (${esc(e.message)}). Si abriste el archivo directamente, sírvelo con un servidor local: <code>python -m http.server -d web</code>.</div>`;
    return;
  }
  S.sel = S.pron.meses[0].fecha;
  pintarCabecera();
  construirControles();
  actualizarModo();          // fija la capa antes de pintar el mapa
  construirMapa();
  leyenda();
  renderPanel();
  renderZonas();
  renderComo();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    leerColores(); repintar(); renderPanel(); renderZonas(); renderComo();
  });
}

/* ------------------------------------------------------------------ cabecera */
function textoNino(v) {
  if (v >= 1.5) return ["Está activo y es fuerte", "El mar del Pacífico está mucho más caliente de lo normal."];
  if (v >= 0.5) return ["Está activo", "El mar del Pacífico está más caliente de lo normal."];
  if (v <= -0.5) return ["Hay La Niña", "El mar del Pacífico está más frío de lo normal."];
  return ["No está activo", "El mar del Pacífico está en condiciones normales."];
}
function pintarCabecera() {
  const m = S.meta, f = S.pron.meses;
  const [y, mo, d] = m.emision.split("-").map(Number);
  $("#emision").textContent = `Región Huánuco · Actualizado el ${d} de ${MESES[mo - 1]} de ${y}`;
  const nino = m.oni ? textoNino(m.oni.valor) : null;
  // Resumen regional del primer mes: parte del territorio en cada categoría
  const M = f[0], n = M.cat.length, cuenta = [0, 0, 0, 0];
  M.cat.forEach((k) => cuenta[k]++);
  const cols = [S.C.dry, S.C.neutral, S.C.wet, S.C.nos];
  const kMax = [0, 1, 2].reduce((a, b) => (cuenta[b] > cuenta[a] ? b : a), 0);
  const frase = ["menos lluvia de lo normal", "lluvia normal", "más lluvia de lo normal"][kMax];
  $("#resumen").innerHTML = `
    <h2>Resumen de la región</h2>
    <dl>
      <div class="sum-row"><dt>Pronóstico para</dt><dd><span class="big">${cap(MESES[mesN(f[0].fecha) - 1])} – ${MESES[mesN(f[2].fecha) - 1]}</span>
        <span class="sub">Con la lluvia registrada hasta ${nombreMes(m.ultimo_mes_observado)}</span></dd></div>
      <div class="sum-row"><dt>${cap(MESES[mesN(M.fecha) - 1])}</dt><dd><span class="big">${nf(100 * cuenta[kMax] / n)} % del territorio</span>
        <span class="sub">con ${frase}</span>
        <div class="sum-bar" role="img" aria-label="${CAT_TXT.map((t, i) => `${t}: ${nf(100 * cuenta[i] / n)} %`).join(", ")}">
          ${cuenta.map((c, i) => c ? `<span style="flex:${c};background:${cols[i]}"></span>` : "").join("")}</div>
        <div class="sum-key">${CAT_CORTO.map((t, i) => cuenta[i] ? `<span><i style="background:${cols[i]}"></i>${t} ${nf(100 * cuenta[i] / n)} %</span>` : "").join("")}</div></dd></div>
      ${nino ? `<div class="sum-row"><dt>Fenómeno El Niño</dt><dd><span class="big">${nino[0]}</span><span class="sub">${nino[1]}</span></dd></div>` : ""}
    </dl>`;
  const anios = Number(m.periodo[1].slice(0, 4)) - Number(m.periodo[0].slice(0, 4));
  document.querySelectorAll('[data-meta="inicio"]').forEach((e) => (e.textContent = m.periodo[0].slice(0, 4)));
  document.querySelectorAll('[data-meta="anios"]').forEach((e) => (e.textContent = anios));
  document.querySelectorAll('[data-meta="prueba"]').forEach((e) => (e.textContent = `${m.anios_prueba[0]} a ${m.anios_prueba.at(-1)}`));
  document.querySelectorAll('[data-meta="periodo"]').forEach((e) => (e.textContent = `${m.periodo[0]} a ${m.periodo[1]}`));
  document.querySelectorAll('[data-meta="modelo"]').forEach((e) => (e.textContent = NOMBRE_MODELO[m.modelo_por_horizonte["1"]] || m.modelo_por_horizonte["1"]));
  $("#fuentes").innerHTML = [`Lluvia: ${m.fuentes.lluvia}`, `El Niño: ${m.fuentes.enso}${m.oni ? ` (ONI ${m.oni.valor > 0 ? "+" : ""}${nf(m.oni.valor, 2)}, ${m.oni.fecha})` : ""}`,
    `Temperatura: ${m.fuentes.temperatura}`, "Mapa: © colaboradores de OpenStreetMap; imágenes satelitales © Esri, Maxar, Earthstar Geographics",
    "Búsqueda de lugares: Nominatim (OpenStreetMap)"].map((t) => `<li>${esc(t)}</li>`).join("");
  $("#footer-meta").textContent = `Datos de lluvia: SENAMHI (${m.periodo[0].slice(0, 4)}–${m.periodo[1].slice(0, 4)}). Archivos generados el ${m.generado}.`;
}

/* ------------------------------------------------------------------ controles */
function construirControles() {
  const seg = $("#seg-meses");
  seg.innerHTML = S.pron.meses.map((m) =>
    `<button type="button" role="radio" data-mes="${m.fecha}">${cap(MESES[mesN(m.fecha) - 1])}</button>`).join("");
  seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) elegirMes(b.dataset.mes); });
  seg.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const bs = [...seg.querySelectorAll("button")]; let i = bs.findIndex((b) => b.dataset.mes === S.sel);
    i = (i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length; elegirMes(bs[i].dataset.mes); bs[i].focus();
  });
  const inp = $("#mes-input");
  inp.value = S.sel;
  inp.addEventListener("change", () => { if (/^\d{4}-\d{2}$/.test(inp.value)) elegirMes(inp.value); });
  $("#capa").addEventListener("change", (e) => { S.capa = e.target.value; repintar(); });
  $("#btn-geo").addEventListener("click", usarUbicacion);
  $("#form-buscar").addEventListener("submit", (e) => { e.preventDefault(); buscarLugar($("#in-lugar").value.trim()); });
  $("#in-alt").addEventListener("change", () => {
    const a = parseFloat($("#in-alt").value.replace(",", "."));
    S.alt = Number.isFinite(a) && a > 0 && a < 7000 ? a : null;
    renderPanel();
  });
  $("#form-coord").addEventListener("submit", (e) => {
    e.preventDefault();
    const lat = parseFloat($("#in-lat").value.replace(",", ".")), lon = parseFloat($("#in-lon").value.replace(",", "."));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { $("#form-msg").textContent = "Escribe la latitud y la longitud con decimales (ej. -9.93 y -76.24)."; return; }
    S.lugar = null;
    elegirPunto(lat, lon, true);
  });
  $("#descargar").addEventListener("click", descargarCSV);
}

function modo(ym = S.sel) {
  if (ym <= S.meta.ultimo_mes_observado) return "obs";
  return S.pron.meses.some((m) => m.fecha === ym) ? "pron" : "clim";
}
const CAPAS = {
  pron: [["cat", "¿Lloverá más o menos de lo normal?"], ["pb", "Posibilidad de que llueva poco"], ["ps", "Posibilidad de que llueva mucho"],
    ["mm", "Cuánta lluvia se espera"], ["zona", "Zonas del clima"]],
  obs: [["anom", "¿Llovió más o menos de lo normal?"], ["mm", "Cuánto llovió"], ["zona", "Zonas del clima"]],
  clim: [["mm", "Cuánto llueve normalmente en este mes"], ["helada", "Peligro de heladas"], ["zona", "Zonas del clima"]],
};

async function elegirMes(ym) {
  if (ym < "1981-01") ym = "1981-01";
  S.sel = ym;
  $("#mes-input").value = ym;
  actualizarModo();
  if (modo() === "obs" && !S.hist) {
    $("#map-note").textContent = "Cargando los registros de lluvia…";
    await cargarHistorico();
  }
  repintar();
  renderPanel();
}

function actualizarModo() {
  const md = modo();
  document.querySelectorAll("#seg-meses button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mes === S.sel));
    b.tabIndex = b.dataset.mes === S.sel || (md !== "pron" && b === b.parentNode.firstChild) ? 0 : -1;
  });
  const opciones = CAPAS[md];
  if (!opciones.some(([id]) => id === S.capa)) S.capa = opciones[0][0];
  $("#capa").innerHTML = opciones.map(([id, t]) => `<option value="${id}"${id === S.capa ? " selected" : ""}>${t}</option>`).join("");
  const badge = $("#modo");
  const txt = { pron: `Pronóstico de ${nombreMes(S.sel)}`, obs: `Lo que llovió en ${nombreMes(S.sel)}`, clim: `Lo que suele llover en ${MESES[mesN(S.sel) - 1]}` };
  badge.textContent = txt[md];
  badge.style.setProperty("--mode-dot", md === "pron" ? "var(--wet)" : md === "obs" ? "var(--neutral)" : "var(--warning)");
  const notas = {
    pron: "Pronóstico hecho con la lluvia registrada hasta " + nombreMes(S.meta.ultimo_mes_observado) + ".",
    obs: "Lluvia registrada por el SENAMHI.",
    clim: "Todavía no hay pronóstico para este mes: se muestra lo que llueve normalmente.",
  };
  $("#map-note").textContent = notas[md];
}

/* ------------------------------------------------------------------ valores por celda */
function idxPron() { return S.pron.meses.findIndex((m) => m.fecha === S.sel); }
function obsMes(id, ym = S.sel) {
  if (!S.hist) return null;
  const i = difM(S.hist.inicio, ym);
  return i >= 0 && i < S.hist.pp.length ? S.hist.pp[i][id] : null;
}
function retroMes(id, ym) {
  const r = S.hist && S.hist.retro; if (!r) return null;
  const i = difM(r.inicio, ym);
  return i >= 0 && i < r.pp.length ? r.pp[i][id] : null;
}
function tminLocal(id, mes, alt) {
  const t = S.clim.tmin[id][mes - 1]; if (t == null) return null;
  const elev = S.geo.features[id].properties.elev;
  return t + GRADIENTE * ((alt ?? elev) - elev);
}
/* Umbrales sobre la Tmin media mensual de ERA5-Land, que es más fría que las estaciones de valle
   (≈ 6–7 °C en la celda de la estación CP-Huánuco). Por eso se exige Tmin ≤ 0 °C para "moderado". */
const HELADA_ALTO = -3, HELADA_MOD = 0;
function riesgoHelada(t) { return t == null ? null : t <= HELADA_ALTO ? "alto" : t <= HELADA_MOD ? "moderado" : "bajo"; }

function binColor(v, cortes, colores) { let i = 0; while (i < cortes.length && v >= cortes[i]) i++; return colores[i]; }
function rampaProb(color) { return [S.C.nos, mezcla(S.C.nos, color, 0.3), mezcla(S.C.nos, color, 0.55), mezcla(S.C.nos, color, 0.8), color]; }
const CORTES_P = [0.25, 0.33, 0.40, 0.50];
function rampaAnom() {
  const d = S.C.dry, w = S.C.wet, m = S.C.mid;
  return [d, mezcla(m, d, 0.66), mezcla(m, d, 0.33), m, mezcla(m, w, 0.33), mezcla(m, w, 0.66), w];
}
const CORTES_A = [-50, -25, -10, 10, 25, 50];
function difTxt(o, n) {
  const a = 100 * (o - n) / Math.max(n, 1);
  if (Math.abs(a) < 10) return "casi igual a lo normal";
  return `${nf(Math.abs(a))} % ${a < 0 ? "menos" : "más"} de lo normal`;
}

function valor(id) {
  const md = modo(), c = S.capa, p = S.geo.features[id].properties, mes = mesN(S.sel);
  if (c === "zona") return { color: S.C.z[p.zona - 1], txt: `Zona: ${S.meta.zonas[p.zona - 1].nombre}` };
  if (md === "pron") {
    const M = S.pron.meses[idxPron()], pr = M.p[id];
    if (!pr) return { color: S.C.s2, txt: "Sin dato" };
    if (c === "cat") return { color: [S.C.dry, S.C.neutral, S.C.wet, S.C.nos][M.cat[id]], txt: `<b>${CAT_TXT[M.cat[id]]}</b>` };
    if (c === "pb") return { color: binColor(pr[0], CORTES_P, rampaProb(S.C.dry)), txt: `Llueva poco: <b>${de10(pr[0])}</b>` };
    if (c === "ps") return { color: binColor(pr[2], CORTES_P, rampaProb(S.C.wet)), txt: `Llueva mucho: <b>${de10(pr[2])}</b>` };
    if (c === "mm") return { color: binColor(M.mm[id], CORTES_MM, RAMPA_MM), txt: `Se esperan <b>${nf(M.mm[id])} mm</b> (lo normal: ${nf(M.normal[id])} mm)` };
  }
  if (md === "obs") {
    const o = obsMes(id), n = S.clim.normal[id][mes - 1];
    if (o == null) return { color: S.C.s2, txt: "Sin dato" };
    if (c === "anom") { const a = 100 * (o - n) / Math.max(n, 1); return { color: binColor(a, CORTES_A, rampaAnom()), txt: `Llovió <b>${nf(o)} mm</b>: ${difTxt(o, n)}` }; }
    if (c === "mm") return { color: binColor(o, CORTES_MM, RAMPA_MM), txt: `Llovió <b>${nf(o)} mm</b> (lo normal: ${nf(n)} mm)` };
  }
  if (md === "clim") {
    if (c === "mm") { const n = S.clim.normal[id][mes - 1]; return { color: binColor(n, CORTES_MM, RAMPA_MM), txt: `Normalmente llueven <b>${nf(n)} mm</b>` }; }
    if (c === "helada") {
      const r = riesgoHelada(tminLocal(id, mes));
      return { color: r === "alto" ? S.C.critical : r === "moderado" ? S.C.warning : S.C.s2,
        txt: r === "alto" ? "<b>Peligro alto de heladas</b>" : r === "moderado" ? "<b>Puede helar algunas noches</b>" : "Sin peligro de heladas" };
    }
  }
  return { color: S.C.s2, txt: "" };
}

/* ------------------------------------------------------------------ mapa */
function construirMapa() {
  S.map = L.map("mapa", { zoomControl: true, scrollWheelZoom: false, minZoom: 6 });
  S.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  // Mapas base gratuitos y sin clave: OpenStreetMap (calles, pueblos, ríos) y Esri World Imagery (satélite)
  S.base.calles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>' });
  const sat = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 18, attribution: "Imágenes &copy; Esri, Maxar, Earthstar Geographics" });
  const etiquetas = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 18, pane: "shadowPane" });
  S.base.satelite = L.layerGroup([sat, etiquetas]);
  S.base.calles.addTo(S.map);
  L.control.layers({ "Mapa": S.base.calles, "Satélite": S.base.satelite }, null, { position: "topright", collapsed: false }).addTo(S.map);
  S.map.on("baselayerchange", repintar);

  S.capaGeo = L.geoJSON(S.geo, {
    style: estilo,
    onEachFeature: (f, lyr) => {
      lyr.bindTooltip(() => `<div>${valor(f.properties.id).txt}</div><div class="tip-sub">Altura promedio ${nf(f.properties.elev)} m · toca para ver más</div>`,
        { sticky: true, className: "cell-tip", direction: "top", offset: [0, -6] });
      lyr.on("click", (e) => { S.lugar = null; elegirPunto(e.latlng.lat, e.latlng.lng, false, f.properties.id); });
    },
  }).addTo(S.map);
  S.map.fitBounds(S.capaGeo.getBounds(), { padding: [10, 10] });
  S.map.on("focus", () => S.map.scrollWheelZoom.enable());
  S.map.on("blur", () => S.map.scrollWheelZoom.disable());
}
function estilo(f) {
  const sat = S.map && S.map.hasLayer(S.base.satelite);
  return { fillColor: valor(f.properties.id).color, fillOpacity: sat ? 0.6 : 0.72, color: "#ffffff", weight: 0.6, opacity: 0.8 };
}
function repintar() {
  S.capaGeo.setStyle(estilo);
  leyenda();
}
function leyenda() {
  const c = S.capa, md = modo(), el = $("#leyenda");
  const sw = (col, t) => `<span><i class="sw" style="background:${col}"></i>${t}</span>`;
  const rampa = (cols, etiquetas, titulo) => `<span class="ramp"><span class="title">${titulo}</span>
      <span class="ramp-bar" style="background:linear-gradient(90deg,${cols.map((x, i) => `${x} ${(100 * i) / cols.length}% ${(100 * (i + 1)) / cols.length}%`).join(",")})"></span>
      <span class="ramp-lbl">${etiquetas.map((t, i) => `<span style="left:${(100 * (i + 1)) / cols.length}%">${t}</span>`).join("")}</span></span>`;
  let h = "";
  if (c === "zona") h = S.meta.zonas.map((z, i) => sw(S.C.z[i], z.nombre)).join("");
  else if (c === "cat") h = [[S.C.dry, CAT_TXT[0]], [S.C.neutral, CAT_TXT[1]], [S.C.wet, CAT_TXT[2]], [S.C.nos, CAT_TXT[3]]].map(([a, b]) => sw(a, b)).join("");
  else if (c === "pb") h = rampa(rampaProb(S.C.dry), ["2 de 10", "3 de 10", "4 de 10", "5 de 10"], "Posibilidad de que llueva poco");
  else if (c === "ps") h = rampa(rampaProb(S.C.wet), ["2 de 10", "3 de 10", "4 de 10", "5 de 10"], "Posibilidad de que llueva mucho");
  else if (c === "mm") h = rampa(RAMPA_MM, CORTES_MM.map(String), "Milímetros de lluvia en el mes (1 mm = 1 litro por metro cuadrado)");
  else if (c === "anom") h = rampa(rampaAnom(), ["−50 %", "−25 %", "−10 %", "+10 %", "+25 %", "+50 %"], "Menos lluvia ← → Más lluvia que lo normal");
  else if (c === "helada") h = [[S.C.critical, "Peligro alto de heladas"], [S.C.warning, "Puede helar algunas noches"], [S.C.s2, "Sin peligro"]].map(([a, b]) => sw(a, b)).join("");
  el.innerHTML = h;
}

function celdaDe(lat, lon) {
  let mejor = null, dmin = Infinity;
  for (const f of S.geo.features) {
    const p = f.properties, dx = Math.abs(p.lon - lon), dy = Math.abs(p.lat - lat);
    if (dx <= 0.0501 && dy <= 0.0501 && dx + dy < dmin) { dmin = dx + dy; mejor = p.id; }
  }
  return mejor;
}
function elegirPunto(lat, lon, centrar, id = null) {
  id = id ?? celdaDe(lat, lon);
  if (id == null) { $("#form-msg").textContent = "Ese lugar está fuera de la región Huánuco."; return; }
  $("#form-msg").textContent = "";
  S.cell = id; S.punto = [lat, lon];
  $("#in-lat").value = lat.toFixed(4); $("#in-lon").value = lon.toFixed(4);
  const p = S.geo.features[id].properties;
  if (S.marca) S.map.removeLayer(S.marca);
  if (S.borde) S.map.removeLayer(S.borde);
  S.borde = L.rectangle([[p.lat - 0.05, p.lon - 0.05], [p.lat + 0.05, p.lon + 0.05]], { color: "#111", weight: 3, fill: false, interactive: false }).addTo(S.map);
  S.marca = L.circleMarker([lat, lon], { radius: 7, color: "#fff", weight: 2.5, fillColor: "#111", fillOpacity: 1, interactive: false }).addTo(S.map);
  if (centrar) S.map.setView([lat, lon], Math.max(S.map.getZoom(), 10));
  renderPanel();
  cargarHistorico().then(() => renderPanel());
  if (innerWidth < 900) $("#detalle").scrollIntoView({ behavior: "smooth", block: "start" });
}
function usarUbicacion() {
  if (!navigator.geolocation) { $("#form-msg").textContent = "Tu celular o navegador no permite obtener la ubicación."; return; }
  $("#form-msg").textContent = "";
  $("#btn-geo").disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    $("#btn-geo").disabled = false;
    const { latitude, longitude, altitude } = pos.coords;
    if (altitude != null && S.alt == null) { S.alt = altitude; $("#in-alt").value = Math.round(altitude); }
    S.lugar = "Tu ubicación";
    elegirPunto(latitude, longitude, true);
  }, (err) => {
    $("#btn-geo").disabled = false;
    $("#form-msg").textContent = err.code === 1 ? "No diste permiso para usar tu ubicación. Puedes buscar tu pueblo por su nombre." : "No se pudo obtener tu ubicación.";
  }, { timeout: 12000, enableHighAccuracy: true });
}

/* Búsqueda de lugares con Nominatim (OpenStreetMap): gratuita; política de uso de 1 consulta por segundo,
   por eso solo se consulta al pulsar "Buscar". Se limita a la región Huánuco. */
let ultimaBusqueda = 0;
async function buscarLugar(q) {
  const ul = $("#resultados");
  if (q.length < 3) { $("#form-msg").textContent = "Escribe al menos 3 letras del nombre."; return; }
  if (Date.now() - ultimaBusqueda < 1100) return;
  ultimaBusqueda = Date.now();
  $("#form-msg").textContent = "";
  ul.hidden = false; ul.innerHTML = '<li class="muted">Buscando…</li>';
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=pe&accept-language=es`
    + `&viewbox=-77.5,-8.2,-74.2,-10.8&bounded=1&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const lista = (await r.json()).filter((x) => celdaDe(+x.lat, +x.lon) != null);
    if (!lista.length) { ul.innerHTML = '<li class="muted">No encontramos ese lugar en Huánuco. Prueba con el nombre del distrito o toca el mapa.</li>'; return; }
    ul.innerHTML = lista.map((x, i) => {
      const partes = x.display_name.split(",").map((s) => s.trim());
      return `<li><button type="button" data-i="${i}"><b>${esc(partes[0])}</b><span>${esc(partes.slice(1, 4).join(", "))}</span></button></li>`;
    }).join("");
    ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const x = lista[+b.dataset.i];
      S.lugar = x.display_name.split(",")[0].trim();
      ul.hidden = true;
      elegirPunto(+x.lat, +x.lon, true);
    }));
  } catch {
    ul.innerHTML = '<li class="muted">No se pudo buscar en este momento. Toca tu chacra en el mapa.</li>';
  }
}

/* ------------------------------------------------------------------ panel "Mi chacra" */
const ICON = {
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20L12 3z" fill="var(--st)"/><path d="M12 9v5M12 17v.5" stroke="#1b1b19" stroke-width="2" stroke-linecap="round"/></svg>',
  drop: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c4 5.5 7 9 7 12.5a7 7 0 0 1-14 0C5 12 8 8.5 12 3z" fill="var(--st)"/></svg>',
  frost: '<svg viewBox="0 0 24 24" aria-hidden="true" stroke="var(--st)" stroke-width="2" stroke-linecap="round" fill="none"><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="var(--st)"/><path d="m7 12.5 3.2 3L17 9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
};

function alertas(id, alt) {
  const out = [];
  S.pron.meses.forEach((M) => {
    const [pb, , ps] = M.p[id] || [0, 0, 0], m = mesN(M.fecha), nm = MESES[m - 1];
    if (pb >= 0.4 && CAMPANIA.includes(m))
      out.push({ tipo: "deficit", st: pb >= 0.5 ? "var(--serious)" : "var(--warning)", ic: "warn", t: `Cuidado: podría llover poco en ${nm}`,
        d: `Hay ${de10(pb)} posibilidades de que llueva menos de ${nf(S.clim.q33[id][m - 1])} mm. Lo normal son ${nf(M.normal[id])} mm.` });
    if (ps >= 0.4 && LLUVIOSA.includes(m))
      out.push({ tipo: "exceso", st: ps >= 0.5 ? "var(--serious)" : "var(--warning)", ic: "drop", t: `Cuidado: podría llover mucho en ${nm}`,
        d: `Hay ${de10(ps)} posibilidades de que llueva más de ${nf(S.clim.q67[id][m - 1])} mm.` });
    const r = riesgoHelada(tminLocal(id, m, alt));
    if (r === "alto" || r === "moderado")
      out.push({ tipo: "helada", st: r === "alto" ? "var(--critical)" : "var(--warning)", ic: "frost",
        t: r === "alto" ? `Peligro de heladas en ${nm}` : `Puede helar algunas noches de ${nm}`,
        d: `A ${nf(alt)} metros de altura las noches de ${nm} suelen ser muy frías.` });
  });
  return out;
}
const RECS = {
  deficit: ["Prefiere semillas de cosecha rápida o que aguanten la falta de agua.",
    "No siembres con la tierra seca: espera a que las lluvias mojen bien el suelo.",
    "Si tienes riego, organiza los turnos. Si no, cubre el suelo con rastrojo para que no pierda humedad."],
  exceso: ["Limpia las zanjas y canales para que el agua corra y no se empoce.",
    "Evita remover la tierra en laderas empinadas para que no se lave el suelo.",
    "Vigila enfermedades que aparecen con la humedad, como la rancha en la papa.",
    "Guarda la cosecha y la semilla en un lugar seco."],
  helada: ["Trata de que la floración no coincida con los meses más fríos.",
    "Antes de una noche despejada y fría, un riego ligero, cubrir las plantas o hacer humo ayuda a reducir el daño.",
    "En las partes altas, usa variedades que resistan las heladas."],
  normal: ["Se esperan lluvias parecidas a las de un año normal: sigue tu calendario de siembra de siempre.",
    "Vuelve a revisar cada mes: el pronóstico se actualiza con la lluvia más reciente."],
};

function tarjetaPron(M, id, alt) {
  const pr = M.p[id]; if (!pr) return "";
  const k = M.cat[id], col = [S.C.dry, S.C.neutral, S.C.wet, S.C.text][k];
  const seg = (cls, p) => `<span class="${cls}" style="flex:${Math.max(p, 0.001)}">${p >= 0.14 ? pct(p) : ""}</span>`;
  const r = riesgoHelada(tminLocal(id, mesN(M.fecha), alt));
  const frase = k === 3 ? "Ninguna opción destaca: planifica como en un año normal."
    : `Hay ${de10(pr[k])} posibilidades.`;
  return `<div class="fc${M.fecha === S.sel ? " sel" : ""}">
    <div class="fc-month">${nombreMes(M.fecha)}</div>
    <div class="fc-cat"><i class="cat-dot" style="background:${k === 3 ? S.C.nos : col}"></i>${k === 3 ? CAT_TXT[3] : "Probablemente " + CAT_TXT[k].toLowerCase()}</div>
    <div class="fc-val">${frase} Se esperan unos <b>${nf(M.mm[id])} mm</b>; lo normal son ${nf(M.normal[id])} mm.</div>
    <div class="tbar" role="img" aria-label="Posibilidades: menos lluvia ${pct(pr[0])}, normal ${pct(pr[1])}, más lluvia ${pct(pr[2])}">
      ${seg("b", pr[0])}${seg("n", pr[1])}${seg("a", pr[2])}</div>
    <div class="tbar-lbl"><span>Menos lluvia</span><span>Normal</span><span>Más lluvia</span></div>
    ${r && r !== "bajo" ? `<div class="frost">${ICON.frost.replace(/var\(--st\)/g, r === "alto" ? "var(--critical)" : "var(--warning)").replace("<svg", '<svg width="18" height="18"')} ${r === "alto" ? "Peligro de heladas" : "Puede helar algunas noches"}</div>` : ""}
  </div>`;
}

function bloqueMesSel(id, alt) {
  const md = modo(); if (md === "pron") return "";
  const mes = mesN(S.sel), n = S.clim.normal[id][mes - 1], q33 = S.clim.q33[id][mes - 1], q67 = S.clim.q67[id][mes - 1];
  if (md === "obs") {
    if (!S.hist) return `<div class="block-title">Lo que llovió en ${nombreMes(S.sel)}</div><p class="muted">Cargando…</p>`;
    const o = obsMes(id), rt = retroMes(id, S.sel);
    return `<div class="block-title">Lo que llovió en ${nombreMes(S.sel)}</div>
      <div class="kv"><div><div class="k">Llovió</div><div class="v">${nf(o)} mm</div></div>
        <div><div class="k">Lo normal</div><div class="v">${nf(n)} mm</div></div></div>
      <p class="note big">${o == null ? "" : `Fue un mes con <strong>${difTxt(o, n)}</strong>.`}
      ${rt != null ? ` Un mes antes, nuestro pronóstico había dicho <strong>${nf(rt)} mm</strong>.` : ""}</p>`;
  }
  const r = riesgoHelada(tminLocal(id, mes, alt));
  return `<div class="block-title">Lo que suele llover en ${MESES[mes - 1]}</div>
    <div class="kv"><div><div class="k">Normalmente</div><div class="v">${nf(n)} mm</div></div>
      <div><div class="k">Año seco</div><div class="v">menos de ${nf(q33)}</div></div>
      <div><div class="k">Año lluvioso</div><div class="v">más de ${nf(q67)}</div></div></div>
    <p class="note big">${r === "alto" ? "En este mes hay <strong>peligro de heladas</strong> a esta altura. " : r === "moderado" ? "En este mes <strong>puede helar algunas noches</strong> a esta altura. " : ""}
      Todavía no podemos pronosticar ${nombreMes(S.sel)}; lo haremos desde ${nombreMes(addM(S.sel, -2))}.</p>`;
}

function renderPanel() {
  const el = $("#detalle");
  if (S.cell == null) {
    el.innerHTML = `<div class="empty"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
      <div>Busca tu pueblo o toca tu chacra en el mapa para ver el pronóstico, los avisos y los consejos.</div></div>`;
    return;
  }
  const id = S.cell, p = S.geo.features[id].properties, alt = S.alt ?? p.elev, z = S.meta.zonas[p.zona - 1];
  const al = alertas(id, alt);
  const tipos = [...new Set(al.map((a) => a.tipo))];
  const recs = (tipos.length ? tipos : ["normal"]).flatMap((t) => RECS[t]);
  el.innerHTML = `
    <div class="place"><div><h3>${esc(S.lugar || "Lugar elegido en el mapa")}</h3>
      <div class="meta">Altura ${S.alt != null ? `de tu chacra: ${nf(S.alt)} m` : `promedio de la zona: ${nf(p.elev)} m`}</div></div>
      <span class="zone-chip"><i style="background:${S.C.z[p.zona - 1]}"></i>${z.nombre}</span></div>
    ${bloqueMesSel(id, alt)}
    <div class="block-title">Pronóstico de los próximos 3 meses</div>
    <div class="fc-list">${S.pron.meses.map((M) => tarjetaPron(M, id, alt)).join("")}</div>
    <div class="block-title">Avisos</div>
    <div class="alerts">${al.length ? al.map((a) => `<div class="alert" style="--st:${a.st}">${ICON[a.ic]}<div><b>${a.t}</b>${a.d}</div></div>`).join("")
      : `<div class="alert" style="--st:var(--good)">${ICON.ok}<div><b>No hay avisos para los próximos 3 meses</b>No se espera falta ni exceso de lluvia marcado, ni heladas a esta altura.</div></div>`}</div>
    <div class="block-title">Consejos</div>
    <ul class="recs">${recs.map((r) => `<li>${r}</li>`).join("")}</ul>
    <p class="note">Son consejos generales. Para tu cultivo, consulta con el técnico de la Agencia Agraria.</p>
    <div class="block-title">Lluvia de los últimos 2 años y lo que viene</div>
    <div class="chart-legend"><span><i style="background:var(--neutral)"></i>Lo que llovió</span>
      <span><i style="background:repeating-linear-gradient(45deg,var(--wet) 0 2px,transparent 2px 4px);border:1px solid var(--wet)"></i>Lo que se espera</span>
      <span><i class="line" style="background:var(--text)"></i>Lo normal</span></div>
    <div class="chart" id="chart-celda">${S.hist ? "" : '<p class="muted small">Cargando…</p>'}</div>`;
  if (S.hist) graficoCelda(id);
}

/* ------------------------------------------------------------------ gráficos SVG */
function ticks(max) {
  const paso = [10, 20, 25, 50, 100, 200, 250, 500].find((s) => max / s <= 5) || 1000;
  const out = []; for (let v = 0; v <= max + 1e-9; v += paso) out.push(v); return out;
}
const tip = $("#chart-tip");
function mostrarTip(e, html) { tip.innerHTML = html; tip.hidden = false; moverTip(e); }
function moverTip(e) {
  const r = tip.getBoundingClientRect(); let x = e.clientX + 12, y = e.clientY - r.height - 10;
  if (x + r.width > innerWidth - 8) x = e.clientX - r.width - 12; if (y < 8) y = e.clientY + 16;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
}
function ocultarTip() { tip.hidden = true; }

/* Barras por mes (observado / pronóstico) + línea de lo normal. */
function barras(cont, filas, { colorBarra, linea = true, etiquetaCada = 3, alto = 200 }) {
  const W = 600, H = alto, m = { l: 34, r: 6, t: 8, b: 22 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
  const max = Math.max(1, ...filas.flatMap((f) => [f.v ?? 0, f.normal ?? 0])) * 1.08, tk = ticks(max), top = tk.at(-1);
  const y = (v) => m.t + ih - (v / top) * ih, bw = iw / filas.length, gap = Math.min(4, bw * 0.25);
  const uid = Math.random().toString(36).slice(2, 8);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gráfico de lluvia por mes, en milímetros">
    <defs><pattern id="h${uid}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="5" height="5" fill="${S.C.wet}" opacity=".25"/><rect width="2.2" height="5" fill="${S.C.wet}"/></pattern></defs>
    <g class="grid">${tk.map((t) => `<line x1="${m.l}" x2="${W - m.r}" y1="${y(t)}" y2="${y(t)}"/><text x="${m.l - 6}" y="${y(t) + 3.5}" text-anchor="end">${t}</text>`).join("")}</g>`;
  filas.forEach((f, i) => {
    if (f.v == null) return;
    const x = m.l + i * bw + gap / 2, w = bw - gap, h = Math.max(0, y(0) - y(f.v)), r = Math.min(4, w / 2, h);
    const fill = f.pron ? `url(#h${uid})` : (f.color || colorBarra);
    s += `<path d="M${x},${y(0)} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z" fill="${fill}"${f.pron ? ` stroke="${S.C.wet}" stroke-width="1"` : ""}/>`;
  });
  if (linea) {
    const pts = filas.map((f, i) => f.normal == null ? null : `${m.l + i * bw + bw / 2},${y(f.normal)}`).filter(Boolean).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${S.C.text}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  filas.forEach((f, i) => { if (i % etiquetaCada === 0 || filas.length <= 12) s += `<text x="${m.l + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${f.etiqueta}</text>`; });
  s += `<text x="${m.l - 6}" y="${m.t - 1}" text-anchor="end">mm</text>`;
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="${S.C.neutral}"/>`;
  filas.forEach((f, i) => { s += `<rect class="hit" data-i="${i}" x="${m.l + i * bw}" y="${m.t}" width="${bw}" height="${ih}"/>`; });
  cont.innerHTML = s + "</svg>";
  cont.querySelectorAll(".hit").forEach((r) => {
    const f = filas[+r.dataset.i];
    r.addEventListener("mouseenter", (e) => mostrarTip(e, f.tip));
    r.addEventListener("mousemove", moverTip);
    r.addEventListener("mouseleave", ocultarTip);
  });
}

function graficoCelda(id) {
  const cont = $("#chart-celda"); if (!cont) return;
  const ult = S.meta.ultimo_mes_observado, filas = [];
  for (let k = -23; k <= 0; k++) {
    const ym = addM(ult, k), o = obsMes(id, ym), n = S.clim.normal[id][mesN(ym) - 1];
    filas.push({ etiqueta: nombreMes(ym, true), v: o, normal: n, tip: `<b>${cap(nombreMes(ym))}</b><br>Llovió ${nf(o)} mm<br>Lo normal: ${nf(n)} mm` });
  }
  S.pron.meses.forEach((M) => filas.push({ etiqueta: nombreMes(M.fecha, true), v: M.mm[id], normal: M.normal[id], pron: true,
    tip: `<b>${cap(nombreMes(M.fecha))} · pronóstico</b><br>Se esperan ${nf(M.mm[id])} mm<br>Lo normal: ${nf(M.normal[id])} mm<br>${CAT_TXT[M.cat[id]]}` }));
  barras(cont, filas, { colorBarra: S.C.neutral, etiquetaCada: 3 });
}

/* ------------------------------------------------------------------ zonas */
function renderZonas() {
  $("#zone-grid").innerHTML = S.meta.zonas.map((z, i) => `
    <article class="card zone">
      <div class="zone-head"><i style="background:${S.C.z[i]}"></i><h3>${z.nombre}</h3></div>
      <div class="kv"><div><div class="k">Altura</div><div class="v">${nf(z.elev_min)} a ${nf(z.elev_max)} m</div></div>
        <div><div class="k">Lluvia en el año</div><div class="v">${nf(z.lluvia_anual)} mm</div></div></div>
      <div class="muted small">Cuánto llueve normalmente cada mes (mm):</div>
      <div class="chart" id="chart-z${i}"></div>
      <div class="muted small" style="margin-top:8px">Meses en que puede helar:</div>
      <div class="frost-strip">${z.tmin_mensual.map((t, m) => { const r = riesgoHelada(t);
        return `<span class="${r === "alto" ? "alto" : r === "moderado" ? "mod" : ""}" title="${cap(MESES[m])}: ${r === "alto" ? "peligro alto de heladas" : r === "moderado" ? "puede helar algunas noches" : "sin peligro de heladas"}">${MES_C[m][0].toUpperCase()}</span>`; }).join("")}</div>
      <div class="frost-key"><span><i class="mod"></i>Puede helar</span><span><i class="alto"></i>Peligro alto</span></div>
    </article>`).join("");
  S.meta.zonas.forEach((z, i) => barras($(`#chart-z${i}`), z.normal_mensual.map((v, m) => ({ etiqueta: MES_C[m], v, normal: null,
    color: S.C.z[i], tip: `<b>${cap(MESES[m])}</b><br>Normalmente llueven ${nf(v)} mm` })), { linea: false, alto: 170 }));
}

/* ------------------------------------------------------------------ ¿cómo funciona? + técnico */
function renderComo() {
  const m = S.meta, elegido = m.modelo_por_horizonte["1"], d = m.ss_por_anio_h1;
  const mejores = d.filter((x) => x.SS > 0).length;
  $("#confia").innerHTML = `Acertó mejor que solo usar lo normal en <strong>${mejores} de ${d.length} años</strong>.
    En promedio redujo el error en un <strong>${nf(100 * (m.metricas.find((r) => r.h === 1 && r.modelo === elegido) || {}).SS)} %</strong> para el mes siguiente.`;
  // barras por año: arriba = mejor que lo normal, abajo = peor
  const W = 600, H = 170, mg = { l: 8, r: 8, t: 16, b: 22 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
  const lim = Math.max(0.1, ...d.map((x) => Math.abs(x.SS))) * 1.15, y = (v) => mg.t + ih / 2 - (v / lim) * (ih / 2), bw = iw / d.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Por año: barras hacia arriba cuando el pronóstico acertó mejor que lo normal, hacia abajo cuando acertó peor">`;
  s += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(0)}" y2="${y(0)}" stroke="${S.C.neutral}"/>`;
  d.forEach((x, i) => {
    const x0 = mg.l + i * bw + 6, w = bw - 12, y0 = y(Math.max(0, x.SS)), h = Math.abs(y(x.SS) - y(0));
    s += `<rect x="${x0}" y="${y0}" width="${w}" height="${Math.max(h, 1)}" rx="3" fill="${x.SS >= 0 ? S.C.wet : S.C.dry}"><title>${x.anio}: ${x.SS >= 0 ? "mejor" : "peor"} que lo normal</title></rect>`;
    s += `<text x="${x0 + w / 2}" y="${H - 6}" text-anchor="middle">${x.anio}</text>`;
  });
  $("#chart-anios").innerHTML = s + "</svg>";

  const filas = ["Climatologia", "Persistencia", "XGB_rezagos", elegido];
  const g = (mod, h, k) => (m.metricas.find((r) => r.modelo === mod && r.h === h) || {})[k];
  const ssTxt = (v) => v == null ? "—" : `<span class="${v > 0.0005 ? "pos" : v < -0.0005 ? "neg" : ""}">${v > 0 ? "+" : ""}${nf(100 * v, 1)} %</span>`;
  $("#tabla-metricas").innerHTML = `<thead><tr><th>Modelo</th><th>SS h=1</th><th>SS h=2</th><th>SS h=3</th><th>RMSE h=1</th><th>Años SS&gt;0</th></tr></thead>
    <tbody>${filas.map((mod) => `<tr class="${mod === elegido ? "best" : ""}"><td>${NOMBRE_MODELO[mod] || mod}</td>
      <td>${ssTxt(g(mod, 1, "SS"))}</td><td>${ssTxt(g(mod, 2, "SS"))}</td><td>${ssTxt(g(mod, 3, "SS"))}</td>
      <td>${nf(g(mod, 1, "RMSE"))} mm</td><td>${g(mod, 1, "anios_pos") ?? "—"}</td></tr>`).join("")}</tbody>
    <tfoot><tr><td colspan="6" class="muted small">RPSS (terciles): ${m.rpss.filter((r) => r.modelo === elegido).map((r) => `h=${r.h} ${r.RPSS > 0 ? "+" : ""}${nf(r.RPSS, 3)}`).join(" · ")}. Prueba walk-forward ${m.anios_prueba[0]}–${m.anios_prueba.at(-1)}.</td></tr></tfoot>`;
}

/* ------------------------------------------------------------------ descarga */
function descargarCSV() {
  const md = modo(), mes = mesN(S.sel), filas = [];
  const cab = ["celda", "lon", "lat", "altitud_m", "zona", "mes"];
  if (md === "pron") cab.push("pronostico_mm", "normal_mm", "p_menos_lluvia", "p_normal", "p_mas_lluvia", "categoria");
  else if (md === "obs") cab.push("llovio_mm", "normal_mm", "diferencia_pct");
  else cab.push("normal_mm", "ano_seco_menos_de_mm", "ano_lluvioso_mas_de_mm", "tmin_media_c");
  S.geo.features.forEach(({ properties: p }) => {
    const id = p.id, base = [p.celda, p.lon, p.lat, p.elev, S.meta.zonas[p.zona - 1].nombre, S.sel], n = S.clim.normal[id][mes - 1];
    if (md === "pron") { const M = S.pron.meses[idxPron()]; base.push(M.mm[id], M.normal[id], ...(M.p[id] || ["", "", ""]), CAT_TXT[M.cat[id]]); }
    else if (md === "obs") { const o = obsMes(id); base.push(o ?? "", n, o == null ? "" : (100 * (o - n) / Math.max(n, 1)).toFixed(1)); }
    else base.push(n, S.clim.q33[id][mes - 1], S.clim.q67[id][mes - 1], S.clim.tmin[id][mes - 1] ?? "");
    filas.push(base.join(","));
  });
  const blob = new Blob(["﻿" + cab.join(",") + "\n" + filas.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `clima_huanuco_${S.sel}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

iniciar();
