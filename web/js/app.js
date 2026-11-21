/* Tamya · Clima Huánuco — frontend estático.
   Lee los JSON de data/ (generados por 09_exportar_web.py); no ejecuta ningún modelo en el navegador.
   El mapa interpola los valores de las 378 celdas (bilineal entre centros) y los clasifica para dibujar
   bandas continuas sobre el relieve. La consulta de un punto usa siempre el valor exacto de su celda. */
"use strict";

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MES_C = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const GRADIENTE = -6.5 / 1000;              // °C por metro
const CAMPANIA = [9, 10, 11, 12, 1, 2, 3, 4];
const LLUVIOSA = [12, 1, 2, 3];
const PASO = 0.1;                            // tamaño de celda en grados
const UMBRAL = 0.40;                         // probabilidad mínima para mostrar una tendencia
const NOMBRE_MODELO = { Climatologia: "Climatología (referencia)", Persistencia: "Persistencia", XGB_rezagos: "XGBoost",
  XGB_rezagos_oni: "XGBoost + ONI", XGB_completo: "XGBoost + ONI + geo", Ridge_rezagos: "Ridge (lineal)", Ridge_rezagos_oni: "Ridge + ONI" };

/* Colores del mapa: el mapa base es siempre claro (relieve), así que no cambian con el modo oscuro. */
const MAPC = {
  dry: ["#e3ad84", "#b4632c"], wet: ["#9dbfe6", "#2b6cb0"], normal: "#c9bf9f",
  mm: ["#e6eef6", "#c5d8ee", "#9cc0e4", "#6fa3d6", "#4585c4", "#2b6cb0", "#1d528f", "#123a68"],
  anom: ["#9c4f1f", "#cf8650", "#ecc6a4", "#efe9dc", "#b9d0ec", "#6f9fd6", "#2a5f9e"],
  frost: ["#b3261e", "#e3a23a"],
  zona: ["#2a7fb8", "#b07f22", "#2f7a4a"],
};
const CORTES_MM = [25, 50, 100, 150, 200, 300, 400];
const CORTES_A = [-50, -25, -10, 10, 25, 50];

const ZONA_UI = {
  1: { icon: "sierraH", corto: "Sierra húmeda", desc: "Partes altas de la cordillera. Llueve bien de noviembre a abril; de mayo a septiembre las noches son muy frías." },
  2: { icon: "sierraS", corto: "Sierra irregular", desc: "Valles y laderas de sierra donde la lluvia cambia mucho de un año a otro. Es la zona más expuesta a una campaña seca." },
  3: { icon: "selva", corto: "Selva", desc: "Ceja de selva y selva baja. Llueve casi todo el año y mucho más que en la sierra; no hay heladas." },
};

const CAT = [
  { corto: "Menos lluvia", largo: "Menos lluvia de lo normal", icon: "sol" },
  { corto: "Normal", largo: "Lluvia normal", icon: "nube" },
  { corto: "Más lluvia", largo: "Más lluvia de lo normal", icon: "lluvia" },
  { corto: "Sin tendencia", largo: "Sin tendencia clara", icon: "igual" },
];

const S = { meta: null, geo: null, pron: null, clim: null, hist: null, histPromise: null, grid: null,
  sel: null, capa: null, cell: null, punto: null, lugar: null, alt: null,
  map: null, capaGeo: null, raster: null, contorno: null, base: {}, marca: null, borde: null, C: {} };

/* ------------------------------------------------------------------ utilidades */
const $ = (s) => document.querySelector(s);
const nf = (v, d = 0) => (v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString("es-PE", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (p) => `${Math.round(p * 100)} %`;
const addM = (ym, k) => { const [y, m] = ym.split("-").map(Number); const t = y * 12 + m - 1 + k; return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`; };
const difM = (a, b) => { const [ya, ma] = a.split("-").map(Number); const [yb, mb] = b.split("-").map(Number); return (yb * 12 + mb) - (ya * 12 + ma); };
const mesN = (ym) => Number(ym.slice(5, 7));
const nombreMes = (ym, corto = false) => corto ? `${MES_C[mesN(ym) - 1]} ${ym.slice(2, 4)}` : `${MESES[mesN(ym) - 1]} ${ym.slice(0, 4)}`;
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const lista = (xs) => xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} y ${xs.at(-1)}`;
const hex2rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

function leerColores() {
  const cs = getComputedStyle(document.documentElement), g = (n) => cs.getPropertyValue(n).trim();
  S.C = { dry: g("--dry"), normal: g("--normal"), wet: g("--wet"), nos: g("--nosignal"), text: g("--ink"), muted: g("--muted"),
    line: g("--line"), z: [g("--z1"), g("--z2"), g("--z3")], warning: g("--warning"), critical: g("--critical"),
    good: g("--good"), serious: g("--serious") };
}
const colorCat = (k) => [S.C.dry, S.C.normal, S.C.wet, S.C.muted][k];

/* Íconos (trazos simples, heredan el color con currentColor) */
const IC = {
  sol: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/></svg>',
  nube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M7 18h10.5a4 4 0 0 0 .4-8 6 6 0 0 0-11.6 1.4A3.3 3.3 0 0 0 7 18z"/></svg>',
  lluvia: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14h10.5a3.6 3.6 0 0 0 .4-7.2 5.6 5.6 0 0 0-10.9 1.3A3 3 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/></svg>',
  igual: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 10h12M6 15h12"/></svg>',
  mm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3c4 5 6.5 8.4 6.5 11.5a6.5 6.5 0 0 1-13 0C5.5 11.4 8 8 12 3z"/></svg>',
  capas: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3 2 8l10 5 10-5-10-5z"/><path d="m2 13 10 5 10-5"/></svg>',
  helada: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7M9 4l3 2 3-2M9 20l3-2 3 2"/></svg>',
  dif: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  aviso: '<svg viewBox="0 0 24 24"><path d="M12 3 2 20h20L12 3z" fill="var(--st)"/><path d="M12 9.5v4.5M12 16.8v.4" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
  gota: '<svg viewBox="0 0 24 24"><path d="M12 3c4 5.5 7 9 7 12.5a7 7 0 0 1-14 0C5 12 8 8.5 12 3z" fill="var(--st)"/></svg>',
  ok: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="var(--st)"/><path d="m7 12.5 3.2 3L17 9" stroke="#fff" stroke-width="2.2" fill="none" stroke-linecap="round"/></svg>',
  frio: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="var(--st)"/><path d="M12 6v12M6.8 9l10.4 6M6.8 15l10.4-6" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  voz: '<svg viewBox="0 0 24 24"><path d="M4 9v6h4l5 4V5L8 9H4z"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12"/></svg>',
  wa: '<svg viewBox="0 0 24 24"><path d="M4 20l1.3-4A8 8 0 1 1 8.4 19z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5l1-1.6-2-1-1 .8a4 4 0 0 1-1.8-1.8l.8-1-1-2z"/></svg>',
  sierraH: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M3 27l9-13 5 6 4-5 8 12z"/><path d="M10 9h8a3 3 0 0 0 .3-6 4.2 4.2 0 0 0-8 1A2.5 2.5 0 0 0 10 9z"/><path d="M12 12l-.6 1.6M15 12l-.6 1.6M18 12l-.6 1.6"/></svg>',
  sierraS: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M3 27l9-13 5 6 4-5 8 12z"/><circle cx="23" cy="7" r="3"/><path d="M23 1.5v1.2M28.5 7h-1.2M27 3l-.8.8M19 3l.8.8"/></svg>',
  selva: '<svg viewBox="0 0 32 32" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M16 29V17"/><path d="M16 4c-5 0-8 3.4-8 7.2 0 3.4 2.7 6 6 6h4c3.3 0 6-2.6 6-6C24 7.4 21 4 16 4z"/><path d="M16 21l-4-3M16 19l4-3"/><path d="M3 29h26"/></svg>',
};
const zonaIcon = (z) => IC[ZONA_UI[z].icon];

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
  prefsTexto();
  try {
    [S.meta, S.geo, S.pron, S.clim] = await Promise.all(
      ["meta.json", "celdas.geojson", "pronostico.json", "climatologia.json"].map((f) => json(`data/${f}`)));
  } catch (e) {
    $("#emision").textContent = "No se pudieron cargar los datos";
    $("#detalle").innerHTML = `<div class="empty">No se pudieron cargar los datos (${esc(e.message)}). Si abrió el archivo directamente, sírvalo con un servidor local: <code>python -m http.server -d web</code>.</div>`;
    return;
  }
  S.sel = S.pron.meses[0].fecha;
  S.grid = construirGrilla();
  pintarCabecera();
  construirControles();
  actualizarModo();
  construirMapa();
  repintar();
  renderPanel();
  renderPanorama();
  renderZonas();
  renderComo();
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    leerColores(); pintarCabecera(); renderPanel(); renderPanorama(); renderZonas(); renderComo();
  });
}

function prefsTexto() {
  const b = $("#btn-texto"), on = lsGet("tamya-letra") === "1";
  const fijar = (v) => { document.documentElement.classList.toggle("big-text", v); b.setAttribute("aria-pressed", String(v)); };
  fijar(on);
  b.addEventListener("click", () => { const v = b.getAttribute("aria-pressed") !== "true"; fijar(v); lsSet("tamya-letra", v ? "1" : "0"); if (S.map) S.map.invalidateSize(); });
}

/* ------------------------------------------------------------------ cabecera y resumen */
function textoNino(v) {
  if (v >= 1.5) return ["El Niño fuerte", "El mar del Pacífico está mucho más caliente de lo normal."];
  if (v >= 0.5) return ["El Niño activo", "El mar del Pacífico está más caliente de lo normal."];
  if (v <= -0.5) return ["La Niña activa", "El mar del Pacífico está más frío de lo normal."];
  return ["Sin El Niño", "El mar del Pacífico está en condiciones normales."];
}
function conteo(M, ids = null) {
  const c = [0, 0, 0, 0];
  (ids || M.cat.map((_, i) => i)).forEach((i) => c[M.cat[i]]++);
  return c;
}
function pintarCabecera() {
  const m = S.meta, f = S.pron.meses;
  const [y, mo, d] = m.emision.split("-").map(Number);
  $("#emision").textContent = `Región Huánuco · Actualizado el ${d} de ${MESES[mo - 1]} de ${y}`;
  const M = f[0], c = conteo(M), n = M.cat.length;
  const k = [0, 1, 2].reduce((a, b) => (c[b] > c[a] ? b : a), 0), share = c[k] / n;
  const parte = share >= 0.7 ? "casi toda la región" : share >= 0.55 ? "la mayor parte de la región" : share >= 0.45 ? "la mitad de la región" : `${nf(100 * share)} % de la región`;
  const nino = m.oni ? textoNino(m.oni.valor) : null;
  $("#resumen").innerHTML = `
    <div class="sum-top"><span class="sum-label">Así viene ${MESES[mesN(M.fecha) - 1]}</span>
      ${nino ? `<span class="nino${Math.abs(m.oni.valor) < 0.5 ? " off" : ""}" title="${esc(nino[1])}">${nino[0]}</span>` : ""}</div>
    <p class="sum-title" style="--c:${colorCat(k)}">Se espera <b>${CAT[k].largo.toLowerCase()}</b> en ${parte}.</p>
    <div class="sum-bar" role="img" aria-label="${CAT.map((t, i) => `${t.corto}: ${nf(100 * c[i] / n)} %`).join(", ")}">
      ${c.map((v, i) => v ? `<span style="flex:${v};background:${i === 3 ? S.C.nos : colorCat(i)}"></span>` : "").join("")}</div>
    <div class="sum-key">${CAT.map((t, i) => c[i] ? `<span><i style="background:${i === 3 ? S.C.nos : colorCat(i)}"></i>${t.corto} ${nf(100 * c[i] / n)} %</span>` : "").join("")}</div>`;
  const anios = Number(m.periodo[1].slice(0, 4)) - Number(m.periodo[0].slice(0, 4));
  const put = (k2, v) => document.querySelectorAll(`[data-meta="${k2}"]`).forEach((e) => (e.textContent = v));
  put("inicio", m.periodo[0].slice(0, 4)); put("anios", anios); put("celdas", m.n_celdas);
  put("prueba", `${m.anios_prueba[0]} a ${m.anios_prueba.at(-1)}`); put("periodo", `${m.periodo[0]} a ${m.periodo[1]}`);
  put("modelo", NOMBRE_MODELO[m.modelo_por_horizonte["1"]] || m.modelo_por_horizonte["1"]);
  $("#fuentes").innerHTML = [`Lluvia: ${m.fuentes.lluvia}`, `El Niño: ${m.fuentes.enso}${m.oni ? ` (ONI ${m.oni.valor > 0 ? "+" : ""}${nf(m.oni.valor, 2)}, ${m.oni.fecha})` : ""}`,
    `Temperatura: ${m.fuentes.temperatura}`, "Mapa: Esri World Shaded Relief, World Imagery y Light Gray Reference; © colaboradores de OpenStreetMap",
    "Búsqueda de lugares: Nominatim (OpenStreetMap)"].map((t) => `<li>${esc(t)}</li>`).join("");
  $("#footer-meta").textContent = `Datos de lluvia: SENAMHI (${m.periodo[0].slice(0, 4)}–${m.periodo[1].slice(0, 4)}). Última lluvia registrada: ${nombreMes(m.ultimo_mes_observado)}. Archivos generados el ${m.generado}.`;
}

/* ------------------------------------------------------------------ controles */
const CAPAS = {
  pron: [["cat", "Tendencia", "lluvia"], ["mm", "Cantidad", "mm"], ["zona", "Zonas", "capas"]],
  obs: [["anom", "Comparado con lo normal", "dif"], ["mm", "Cantidad", "mm"], ["zona", "Zonas", "capas"]],
  clim: [["mm", "Lluvia normal", "mm"], ["helada", "Heladas", "helada"], ["zona", "Zonas", "capas"]],
};
function construirControles() {
  const seg = $("#seg-meses"), rot = ["Próximo mes", "En 2 meses", "En 3 meses"];
  seg.innerHTML = S.pron.meses.map((m, i) =>
    `<button type="button" role="radio" data-mes="${m.fecha}"><span>${rot[i] || ""}</span><b>${cap(MESES[mesN(m.fecha) - 1])}</b></button>`).join("");
  seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) elegirMes(b.dataset.mes); });
  radioTeclas(seg, (b) => elegirMes(b.dataset.mes));
  const capas = $("#capas");
  capas.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) { S.capa = b.dataset.capa; marcarCapas(); repintar(); } });
  radioTeclas(capas, (b) => { S.capa = b.dataset.capa; marcarCapas(); repintar(); });
  const inp = $("#mes-input");
  inp.value = S.sel;
  inp.addEventListener("change", () => { if (/^\d{4}-\d{2}$/.test(inp.value)) elegirMes(inp.value); });
  $("#ver-grilla").addEventListener("change", estiloCeldas);
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
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) { $("#form-msg").textContent = "Escriba la latitud y la longitud con decimales (ej. -9.93 y -76.24)."; return; }
    S.lugar = null;
    elegirPunto(lat, lon, true);
  });
  $("#descargar").addEventListener("click", descargarCSV);
}
function radioTeclas(grupo, accion) {
  grupo.addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
    const bs = [...grupo.querySelectorAll("button")]; let i = bs.findIndex((b) => b.getAttribute("aria-checked") === "true");
    i = (i + (e.key === "ArrowRight" ? 1 : -1) + bs.length) % bs.length; accion(bs[i]); bs[i].focus(); e.preventDefault();
  });
}

function modo(ym = S.sel) {
  if (ym <= S.meta.ultimo_mes_observado) return "obs";
  return S.pron.meses.some((m) => m.fecha === ym) ? "pron" : "clim";
}

async function elegirMes(ym) {
  if (ym < "1981-01") ym = "1981-01";
  S.sel = ym;
  $("#mes-input").value = ym;
  actualizarModo();
  if (modo() === "obs" && !S.hist) {
    $("#map-note").textContent = "Cargando los registros de lluvia…";
    await cargarHistorico();
    actualizarModo();
  }
  repintar();
  renderPanel();
}

function marcarCapas() {
  document.querySelectorAll("#capas button").forEach((b) => {
    const on = b.dataset.capa === S.capa; b.setAttribute("aria-checked", String(on)); b.tabIndex = on ? 0 : -1;
  });
}
function actualizarModo() {
  const md = modo();
  document.querySelectorAll("#seg-meses button").forEach((b, i) => {
    const on = b.dataset.mes === S.sel;
    b.setAttribute("aria-checked", String(on));
    b.tabIndex = on || (md !== "pron" && i === 0) ? 0 : -1;
  });
  const opciones = CAPAS[md];
  if (!opciones.some(([id]) => id === S.capa)) S.capa = opciones[0][0];
  $("#capas").innerHTML = opciones.map(([id, t, ic]) => `<button type="button" role="radio" data-capa="${id}">${IC[ic]}${t}</button>`).join("");
  marcarCapas();
  const txt = { pron: `Pronóstico de ${nombreMes(S.sel)}`, obs: `Lo que llovió en ${nombreMes(S.sel)}`, clim: `Lo normal en ${MESES[mesN(S.sel) - 1]}` };
  const badge = $("#modo");
  badge.textContent = txt[md];
  badge.style.setProperty("--mode-dot", md === "pron" ? "var(--wet)" : md === "obs" ? "var(--normal)" : "var(--ochre)");
  const notas = {
    pron: `Calculado con la lluvia registrada hasta ${nombreMes(S.meta.ultimo_mes_observado)}.`,
    obs: "Lluvia registrada por el SENAMHI.",
    clim: "Aún no hay pronóstico para este mes; se muestra lo que llueve normalmente.",
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
/* Umbrales sobre la Tmin media mensual de ERA5-Land, más fría que las estaciones de valle (≈ 6–7 °C). */
const HELADA_ALTO = -3, HELADA_MOD = 0;
function riesgoHelada(t) { return t == null ? null : t <= HELADA_ALTO ? "alto" : t <= HELADA_MOD ? "moderado" : "bajo"; }
function certeza(p) { return p >= 0.6 ? "Muy probable" : p >= 0.5 ? "Probable" : "Posible"; }
function nivel(p) { return p >= 0.6 ? 3 : p >= 0.5 ? 2 : 1; }
function difTxt(o, n) {
  const a = 100 * (o - n) / Math.max(n, 1);
  if (Math.abs(a) < 10) return "casi igual a lo normal";
  return `${nf(Math.abs(a))} % ${a < 0 ? "menos" : "más"} que lo normal`;
}
function binIdx(v, cortes) { let i = 0; while (i < cortes.length && v >= cortes[i]) i++; return i; }

/* Texto del recuadro flotante del mapa */
function textoCelda(id) {
  const md = modo(), c = S.capa, p = S.geo.features[id].properties, mes = mesN(S.sel);
  if (c === "zona") return `<b>${S.meta.zonas[p.zona - 1].nombre}</b>`;
  if (md === "pron") {
    const M = S.pron.meses[idxPron()], pr = M.p[id];
    if (!pr) return "Sin dato";
    const k = M.cat[id];
    if (c === "cat") return k === 3 ? `<b>${CAT[3].largo}</b>` : `<b>${CAT[k].largo}</b><div class="tip-sub">${certeza(pr[k])} · ${pct(pr[k])}</div>`;
    return `Se esperan <b>${nf(M.mm[id])} mm</b><div class="tip-sub">Lo normal: ${nf(M.normal[id])} mm</div>`;
  }
  if (md === "obs") {
    const o = obsMes(id), n = S.clim.normal[id][mes - 1];
    if (o == null) return "Sin dato";
    return `Llovió <b>${nf(o)} mm</b><div class="tip-sub">${cap(difTxt(o, n))} (${nf(n)} mm)</div>`;
  }
  if (c === "helada") {
    const r = riesgoHelada(tminLocal(id, mes));
    return r === "alto" ? "<b>Peligro alto de heladas</b>" : r === "moderado" ? "<b>Puede helar algunas noches</b>" : "Sin peligro de heladas";
  }
  return `Normalmente llueven <b>${nf(S.clim.normal[id][mes - 1])} mm</b>`;
}

/* Campo numérico por celda (para interpolar) y su color.  */
function campo() {
  const md = modo(), c = S.capa, mes = mesN(S.sel), F = S.geo.features;
  if (c === "zona") return { val: (id) => [0, 1, 2].map((z) => (F[id].properties.zona === z + 1 ? 1 : 0)), color: (v) => MAPC.zona[argmax(v)], alfa: 0.62 };
  if (md === "pron") {
    const M = S.pron.meses[idxPron()];
    if (c === "cat") return { val: (id) => M.p[id], color: colorTendencia, alfa: 0.82 };
    return { val: (id) => [M.mm[id]], color: (v) => MAPC.mm[binIdx(v[0], CORTES_MM)], alfa: 0.8 };
  }
  if (md === "obs") {
    if (c === "anom") return { val: (id) => { const o = obsMes(id), n = S.clim.normal[id][mes - 1]; return o == null ? null : [100 * (o - n) / Math.max(n, 1)]; },
      color: (v) => MAPC.anom[binIdx(v[0], CORTES_A)], alfa: 0.82 };
    return { val: (id) => { const o = obsMes(id); return o == null ? null : [o]; }, color: (v) => MAPC.mm[binIdx(v[0], CORTES_MM)], alfa: 0.8 };
  }
  if (c === "helada") return { val: (id) => { const t = tminLocal(id, mes); return t == null ? null : [t]; },
    color: (v) => (v[0] <= HELADA_ALTO ? MAPC.frost[0] : v[0] <= HELADA_MOD ? MAPC.frost[1] : null), alfa: 0.78 };
  return { val: (id) => [S.clim.normal[id][mes - 1]], color: (v) => MAPC.mm[binIdx(v[0], CORTES_MM)], alfa: 0.8 };
}
function argmax(v) { let k = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[k]) k = i; return k; }
function colorTendencia(p) {
  const k = argmax(p); if (p[k] < UMBRAL) return null;
  if (k === 1) return MAPC.normal;
  return (k === 0 ? MAPC.dry : MAPC.wet)[p[k] >= 0.5 ? 1 : 0];
}

/* ------------------------------------------------------------------ grilla y rasterizado */
function construirGrilla() {
  const P = S.geo.features.map((f) => f.properties);
  const lon0 = Math.min(...P.map((p) => p.lon)), lat1 = Math.max(...P.map((p) => p.lat));
  const ix = (lon) => Math.round((lon - lon0) / PASO), iy = (lat) => Math.round((lat1 - lat) / PASO);
  const nx = Math.max(...P.map((p) => ix(p.lon))) + 1, ny = Math.max(...P.map((p) => iy(p.lat))) + 1;
  // grilla con un borde vacío alrededor
  const G = Array.from({ length: ny + 2 }, () => new Array(nx + 2).fill(-1));
  P.forEach((p) => { G[iy(p.lat) + 1][ix(p.lon) + 1] = p.id; });
  const oeste = lon0 - PASO, norte = lat1 + PASO;
  return { G, nx, ny, oeste, norte, este: oeste + (nx + 1) * PASO, sur: norte - (ny + 1) * PASO };
}

function rasterizar() {
  const { G, nx, ny } = S.grid, F = 12, W = (nx + 1) * F, H = (ny + 1) * F;
  const cf = campo();
  const vals = G.map((fila) => fila.map((id) => (id < 0 ? null : cf.val(id))));
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d"), img = ctx.createImageData(W, H), d = img.data;
  const cache = new Map();
  const rgb = (h) => { if (!cache.has(h)) cache.set(h, hex2rgb(h)); return cache.get(h); };
  for (let py = 0; py < H; py++) {
    const gy = (py + 0.5) / F, j = Math.floor(gy), ty = gy - j;
    for (let px = 0; px < W; px++) {
      const gx = (px + 0.5) / F, i = Math.floor(gx), tx = gx - i;
      const esq = [[j, i, (1 - tx) * (1 - ty)], [j, i + 1, tx * (1 - ty)], [j + 1, i, (1 - tx) * ty], [j + 1, i + 1, tx * ty]];
      let m = 0, wsum = 0, v = null;
      for (const [a, b, w] of esq) {
        if (G[a][b] < 0) continue;
        m += w;
        const x = vals[a][b]; if (!x || w === 0) continue;
        if (!v) v = new Array(x.length).fill(0);
        for (let k = 0; k < x.length; k++) v[k] += w * x[k];
        wsum += w;
      }
      if (m < 0.42 || !v) continue;
      for (let k = 0; k < v.length; k++) v[k] /= wsum;
      const col = cf.color(v); if (!col) continue;
      const [r, g, b] = rgb(col), o = 4 * (py * W + px);
      const borde = Math.min(1, Math.max(0, (m - 0.42) / 0.16));
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = Math.round(255 * cf.alfa * borde);
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL("image/png");
}

/* Contorno de la región por cuadrados marchantes sobre el indicador de celdas (umbral 0.5). */
function contornoRegion() {
  const { G, oeste, norte } = S.grid, segs = [];
  const ll = (x, y) => [norte - y * PASO, oeste + x * PASO];
  for (let j = 0; j < G.length - 1; j++) for (let i = 0; i < G[0].length - 1; i++) {
    const a = G[j][i] >= 0, b = G[j][i + 1] >= 0, c = G[j + 1][i + 1] >= 0, d = G[j + 1][i] >= 0;
    const code = (a << 3) | (b << 2) | (c << 1) | d;
    const T = ll(i + 0.5, j), R = ll(i + 1, j + 0.5), B = ll(i + 0.5, j + 1), Lf = ll(i, j + 0.5);
    const tabla = { 1: [[Lf, B]], 2: [[B, R]], 3: [[Lf, R]], 4: [[T, R]], 5: [[T, R], [Lf, B]], 6: [[T, B]], 7: [[T, Lf]],
      8: [[T, Lf]], 9: [[T, B]], 10: [[T, Lf], [B, R]], 11: [[T, R]], 12: [[Lf, R]], 13: [[R, B]], 14: [[Lf, B]] };
    (tabla[code] || []).forEach((s) => segs.push(s));
  }
  return segs;
}

/* ------------------------------------------------------------------ mapa */
function construirMapa() {
  const g = S.grid;
  S.map = L.map("mapa", { zoomControl: true, scrollWheelZoom: false, minZoom: 7, maxZoom: 15, zoomSnap: 0.25 });
  S.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  const ras = S.map.createPane("raster"); ras.style.zIndex = 350; ras.style.pointerEvents = "none"; ras.classList.add("leaflet-raster-pane");
  const etq = S.map.createPane("etiquetas"); etq.style.zIndex = 420; etq.style.pointerEvents = "none";

  // Mapas base gratuitos y sin clave
  const esri = (s, o = {}) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${s}/MapServer/tile/{z}/{y}/{x}`, { maxZoom: 18, ...o });
  S.base.relieve = L.layerGroup([
    esri("World_Shaded_Relief", { maxNativeZoom: 13, attribution: "Relieve &copy; Esri" }),
    esri("Canvas/World_Light_Gray_Reference", { maxNativeZoom: 16, pane: "etiquetas", attribution: "Etiquetas &copy; Esri, HERE, Garmin" }),
  ]);
  S.base.calles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">colaboradores de OpenStreetMap</a>' });
  S.base.satelite = L.layerGroup([
    esri("World_Imagery", { attribution: "Imágenes &copy; Esri, Maxar, Earthstar Geographics" }),
    esri("Reference/World_Boundaries_and_Places", { pane: "etiquetas" }),
  ]);
  S.base.relieve.addTo(S.map);
  L.control.layers({ "Relieve": S.base.relieve, "Calles": S.base.calles, "Satélite": S.base.satelite }, null, { position: "topright", collapsed: innerWidth < 640 }).addTo(S.map);
  S.map.on("baselayerchange", () => {
    const sat = S.map.hasLayer(S.base.satelite), calles = S.map.hasLayer(S.base.calles);
    ras.classList.toggle("blend", !sat);
    if (S.raster) S.raster.setOpacity(sat ? 0.72 : calles ? 0.8 : 1);
  });
  ras.classList.add("blend");

  const limites = [[g.sur, g.oeste], [g.norte, g.este]];
  S.raster = L.imageOverlay(rasterizar(), limites, { pane: "raster", interactive: false }).addTo(S.map);

  const segs = contornoRegion();
  S.contorno = L.layerGroup([
    L.polyline(segs, { color: "#ffffff", weight: 5, opacity: 0.85, interactive: false, lineCap: "round" }),
    L.polyline(segs, { color: "#1b2620", weight: 1.8, opacity: 0.9, interactive: false, lineCap: "round" }),
  ]).addTo(S.map);

  // Capa de celdas: invisible, sirve para el recuadro flotante, el clic y la cuadrícula opcional
  S.capaGeo = L.geoJSON(S.geo, {
    style: estiloCelda,
    onEachFeature: (f, lyr) => {
      lyr.bindTooltip(() => `<div>${textoCelda(f.properties.id)}</div><div class="tip-sub">${nf(f.properties.elev)} m de altura · toque para ver más</div>`,
        { sticky: true, className: "cell-tip", direction: "top", offset: [0, -8], opacity: 1 });
      lyr.on("mouseover", () => lyr.setStyle({ weight: 2, color: "#1b2620", opacity: 0.9 }));
      lyr.on("mouseout", () => S.capaGeo.resetStyle(lyr));
      lyr.on("click", (e) => { S.lugar = null; elegirPunto(e.latlng.lat, e.latlng.lng, false, f.properties.id); });
    },
  }).addTo(S.map);
  S.map.fitBounds(limites, { padding: [12, 12] });
  S.map.setMaxBounds(L.latLngBounds(limites).pad(0.6));
  S.map.on("focus", () => S.map.scrollWheelZoom.enable());
  S.map.on("blur", () => S.map.scrollWheelZoom.disable());
}
function estiloCelda() {
  const g = $("#ver-grilla").checked;
  return { fill: true, fillOpacity: 0, stroke: true, color: "#1b2620", weight: g ? 0.6 : 0, opacity: g ? 0.45 : 0 };
}
function estiloCeldas() { S.capaGeo.setStyle(estiloCelda); }
function repintar() {
  if (!S.map) return;
  S.raster.setUrl(rasterizar());
  leyenda();
}

function leyenda() {
  const c = S.capa, md = modo(), el = $("#leyenda");
  const fila = (col, t, extra = "") => `<div class="lg-row"><i style="background:${col}"></i>${t}${extra}</div>`;
  const rampa = (cols, ticks, titulo, sub = "") => `<div class="lg-title">${titulo}</div>
    <div class="lg-ramp" style="--n:${cols.length}">${cols.map((x) => `<span style="background:${x}"></span>`).join("")}</div>
    <div class="lg-ticks" style="--n:${cols.length}">${["", ...ticks].map((t) => `<span>${t}</span>`).join("")}</div>${sub ? `<div class="lg-sub">${sub}</div>` : ""}`;
  let h = "";
  if (c === "zona") h = `<div class="lg-title">Zonas de lluvia</div><div class="lg-items">${S.meta.zonas.map((z, i) =>
    `<div class="lg-row"><i style="background:${MAPC.zona[i]}"></i><span style="color:${MAPC.zona[i]};display:inline-flex">${zonaIcon(i + 1).replace("<svg", '<svg width="18" height="18"')}</span>${z.nombre}</div>`).join("")}</div>`;
  else if (c === "cat") h = `<div class="lg-title">¿Cómo vendrá la lluvia?</div>
    <div class="lg-pair"><span></span><span class="h">Posible</span><span class="h" style="text-align:left">Probable</span>
      <i style="background:${MAPC.dry[0]}"></i><i style="background:${MAPC.dry[1]}"></i><span>Menos lluvia</span>
      <span></span><i style="background:${MAPC.normal}"></i><span>Normal</span>
      <i style="background:${MAPC.wet[0]}"></i><i style="background:${MAPC.wet[1]}"></i><span>Más lluvia</span>
      <span></span><i style="background:transparent;border:1px dashed #9a9585"></i><span>Sin tendencia (sin color)</span></div>`;
  else if (c === "mm") h = rampa(MAPC.mm, CORTES_MM, md === "pron" ? "Lluvia esperada en el mes (mm)" : md === "obs" ? "Lluvia del mes (mm)" : "Lluvia normal del mes (mm)", "1 mm = 1 litro por metro cuadrado");
  else if (c === "anom") h = rampa(MAPC.anom, ["−50 %", "−25", "−10", "+10", "+25", "+50 %"], "Comparado con lo normal", "Tierra: llovió menos · Azul: llovió más");
  else if (c === "helada") h = `<div class="lg-title">Heladas en el mes</div><div class="lg-items">${fila(MAPC.frost[0], "Peligro alto")}${fila(MAPC.frost[1], "Puede helar algunas noches")}${fila("transparent", "Sin peligro (sin color)")}</div>`;
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
  S.borde = L.rectangle([[p.lat - 0.05, p.lon - 0.05], [p.lat + 0.05, p.lon + 0.05]],
    { color: "#1b2620", weight: 2.5, dashArray: "6 4", fill: false, interactive: false }).addTo(S.map);
  S.marca = L.circleMarker([lat, lon], { radius: 8, color: "#fff", weight: 3, fillColor: "#1f5a3d", fillOpacity: 1, interactive: false, pane: "markerPane" }).addTo(S.map);
  if (centrar) S.map.setView([lat, lon], Math.max(S.map.getZoom(), 10));
  renderPanel();
  cargarHistorico().then(() => renderPanel());
  if (innerWidth < 960) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
}
function usarUbicacion() {
  if (!navigator.geolocation) { $("#form-msg").textContent = "Su celular o navegador no permite obtener la ubicación."; return; }
  $("#form-msg").textContent = "";
  $("#btn-geo").disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    $("#btn-geo").disabled = false;
    const { latitude, longitude, altitude } = pos.coords;
    if (altitude != null && S.alt == null) { S.alt = altitude; $("#in-alt").value = Math.round(altitude); }
    S.lugar = "Mi ubicación";
    elegirPunto(latitude, longitude, true);
  }, (err) => {
    $("#btn-geo").disabled = false;
    $("#form-msg").textContent = err.code === 1 ? "No se dio permiso para usar la ubicación. Puede buscar su pueblo por su nombre." : "No se pudo obtener la ubicación.";
  }, { timeout: 12000, enableHighAccuracy: true });
}

/* Búsqueda con Nominatim (OpenStreetMap): gratuita, máx. 1 consulta por segundo; solo al pulsar "Buscar". */
let ultimaBusqueda = 0;
async function buscarLugar(q) {
  const ul = $("#resultados");
  if (q.length < 3) { $("#form-msg").textContent = "Escriba al menos 3 letras del nombre."; return; }
  if (Date.now() - ultimaBusqueda < 1100) return;
  ultimaBusqueda = Date.now();
  $("#form-msg").textContent = "";
  ul.hidden = false; ul.innerHTML = '<li class="muted">Buscando…</li>';
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=8&countrycodes=pe&accept-language=es`
    + `&viewbox=-77.5,-8.2,-74.2,-10.8&bounded=1&q=${encodeURIComponent(q)}`;
  try {
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    const res = (await r.json()).filter((x) => celdaDe(+x.lat, +x.lon) != null);
    if (!res.length) { ul.innerHTML = '<li class="muted">No encontramos ese lugar en Huánuco. Pruebe con el nombre del distrito o toque el mapa.</li>'; return; }
    ul.innerHTML = res.map((x, i) => {
      const partes = x.display_name.split(",").map((s) => s.trim());
      return `<li><button type="button" data-i="${i}"><b>${esc(partes[0])}</b><span>${esc(partes.slice(1, 4).join(", "))}</span></button></li>`;
    }).join("");
    ul.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      const x = res[+b.dataset.i];
      S.lugar = x.display_name.split(",")[0].trim();
      ul.hidden = true;
      elegirPunto(+x.lat, +x.lon, true);
    }));
  } catch {
    ul.innerHTML = '<li class="muted">No se pudo buscar en este momento. Toque su chacra en el mapa.</li>';
  }
}

/* ------------------------------------------------------------------ panel "Mi chacra" */
/* Avisos agrupados por tipo: un aviso por riesgo con los meses afectados. */
function alertas(id, alt) {
  const grupos = { deficit: [], exceso: [], helada: [] };
  S.pron.meses.forEach((M) => {
    const [pb, , ps] = M.p[id] || [0, 0, 0], m = mesN(M.fecha);
    if (pb >= UMBRAL && CAMPANIA.includes(m)) grupos.deficit.push({ m, p: pb, lim: S.clim.q33[id][m - 1] });
    if (ps >= UMBRAL && LLUVIOSA.includes(m)) grupos.exceso.push({ m, p: ps, lim: S.clim.q67[id][m - 1] });
    const r = riesgoHelada(tminLocal(id, m, alt));
    if (r === "alto" || r === "moderado") grupos.helada.push({ m, r });
  });
  const meses = (xs) => lista(xs.map((x) => MESES[x.m - 1]));
  const out = [];
  if (grupos.deficit.length) {
    const g = grupos.deficit, pmax = Math.max(...g.map((x) => x.p));
    out.push({ tipo: "deficit", st: pmax >= 0.5 ? "var(--serious)" : "var(--warning)", ic: "aviso", t: `Podría llover poco en ${meses(g)}`,
      d: `Aquí un mes seco deja menos de ${lista(g.map((x) => `${nf(x.lim)} mm en ${MESES[x.m - 1]}`))}.` });
  }
  if (grupos.exceso.length) {
    const g = grupos.exceso, pmax = Math.max(...g.map((x) => x.p));
    out.push({ tipo: "exceso", st: pmax >= 0.5 ? "var(--serious)" : "var(--warning)", ic: "gota", t: `Podría llover de más en ${meses(g)}`,
      d: `Aquí un mes muy lluvioso supera ${lista(g.map((x) => `${nf(x.lim)} mm en ${MESES[x.m - 1]}`))}.` });
  }
  if (grupos.helada.length) {
    const g = grupos.helada, alto = g.some((x) => x.r === "alto");
    out.push({ tipo: "helada", st: alto ? "var(--critical)" : "var(--warning)", ic: "frio", t: alto ? `Peligro de heladas en ${meses(g)}` : `Puede helar algunas noches de ${meses(g)}`,
      d: `A ${nf(alt)} m de altura las noches de estos meses suelen bajar de cero grados.` });
  }
  return out;
}
const RECS = {
  deficit: ["Prefiera semillas de cosecha rápida o que aguanten la falta de agua.",
    "No siembre con la tierra seca: espere a que las lluvias mojen bien el suelo.",
    "Si tiene riego, organice los turnos; si no, cubra el suelo con rastrojo para guardar la humedad."],
  exceso: ["Limpie zanjas y canales para que el agua corra y no se empoce.",
    "Evite remover la tierra en laderas empinadas para que no se lave el suelo.",
    "Vigile enfermedades que llegan con la humedad, como la rancha en la papa.",
    "Guarde la cosecha y la semilla en un lugar seco."],
  helada: ["Procure que la floración no coincida con los meses más fríos.",
    "Antes de una noche despejada y fría, un riego ligero, cubrir las plantas o hacer humo reduce el daño.",
    "En las partes altas, use variedades que resistan las heladas."],
  normal: ["Se esperan lluvias parecidas a las de un año normal: siga su calendario de siembra de siempre.",
    "Vuelva a revisar el próximo mes: el pronóstico se actualiza con la lluvia más reciente."],
};

function medidor(p) { const n = nivel(p); return `<span class="meter" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i <= n ? "on" : ""}"></i>`).join("")}</span>`; }

/* Barra de rango: dónde cae la lluvia esperada frente a un mes seco, normal o lluvioso. */
function gauge(id, mes, valor, etiqueta) {
  const q33 = S.clim.q33[id][mes - 1], q67 = S.clim.q67[id][mes - 1];
  const max = Math.max(q67 * 1.55, (valor ?? 0) * 1.12, q33 * 2.2, 10);
  const x = (v) => `${Math.min(100, Math.max(0, (100 * v) / max))}%`;
  const tint = (c) => `color-mix(in srgb, ${c} 38%, var(--surface))`;
  return `<div class="gauge" role="img" aria-label="${etiqueta} ${nf(valor)} mm. Mes seco: menos de ${nf(q33)} mm; mes lluvioso: más de ${nf(q67)} mm.">
    <div class="g-bar"><span style="width:${x(q33)};background:${tint(S.C.dry)}"></span><span style="width:calc(${x(q67)} - ${x(q33)});background:${tint(S.C.normal)}"></span>
      <span style="flex:1;background:${tint(S.C.wet)}"></span>
      ${valor != null ? `<span class="g-mark" style="left:${x(valor)}" data-l="${nf(valor)} mm"></span>` : ""}</div>
    <div class="g-lbl"><span><b>Seco</b><br>menos de ${nf(q33)}</span><span><b>Normal</b><br>${nf(q33)}–${nf(q67)}</span><span><b>Lluvioso</b><br>más de ${nf(q67)}</span></div></div>`;
}

function veredicto(id, alt) {
  const md = modo(), mes = mesN(S.sel), n = S.clim.normal[id][mes - 1];
  if (md === "pron") {
    const M = S.pron.meses[idxPron()], pr = M.p[id], k = M.cat[id];
    if (!pr) return "";
    const c = k === 3 ? S.C.muted : colorCat(k);
    const cab = k === 3
      ? `<div class="v-cert">Ninguna opción destaca: planifique como en un año normal.</div>`
      : `<div class="v-cert">${medidor(pr[k])}${certeza(pr[k])} · ${pct(pr[k])}</div>`;
    return `<div class="verdict" style="--c:${c}">
      <div class="v-month">${cap(nombreMes(M.fecha))} · pronóstico</div>
      <div class="v-head"><span class="v-ic">${IC[CAT[k].icon]}</span><strong>${CAT[k].largo}</strong></div>${cab}
      <p class="v-text">Se esperan unos <b>${nf(M.mm[id])} mm</b>; lo normal son ${nf(n)} mm.</p>
      ${gauge(id, mes, M.mm[id], "Lluvia esperada:")}
      <div class="probs">${[0, 1, 2].map((i) => `<div class="${i === k ? "top" : ""}">${CAT[i].corto}<b>${pct(pr[i])}</b></div>`).join("")}</div></div>`;
  }
  if (md === "obs") {
    if (!S.hist) return `<div class="verdict" style="--c:${S.C.normal}"><div class="v-month">${cap(nombreMes(S.sel))}</div><p class="v-text">Cargando los registros…</p></div>`;
    const o = obsMes(id), rt = retroMes(id, S.sel);
    const k = o == null ? 3 : o < S.clim.q33[id][mes - 1] ? 0 : o > S.clim.q67[id][mes - 1] ? 2 : 1;
    const titulo = ["Fue un mes seco", "Fue un mes normal", "Fue un mes lluvioso", "Sin registro"][k];
    return `<div class="verdict" style="--c:${k === 3 ? S.C.muted : colorCat(k)}">
      <div class="v-month">${cap(nombreMes(S.sel))} · lo que llovió</div>
      <div class="v-head"><span class="v-ic">${IC[CAT[k].icon]}</span><strong>${titulo}</strong></div>
      ${o != null ? `<p class="v-text">Llovieron <b>${nf(o)} mm</b>, ${difTxt(o, n)} (${nf(n)} mm).${rt != null ? ` Un mes antes, Tamya había previsto <b>${nf(rt)} mm</b>.` : ""}</p>${gauge(id, mes, o, "Lluvia registrada:")}` : ""}</div>`;
  }
  const r = riesgoHelada(tminLocal(id, mes, alt));
  return `<div class="verdict" style="--c:${S.C.normal}">
    <div class="v-month">${cap(MESES[mes - 1])} · lo normal</div>
    <div class="v-head"><span class="v-ic">${IC.nube}</span><strong>Normalmente llueven ${nf(n)} mm</strong></div>
    <p class="v-text">${r === "alto" ? "A esta altura hay <b>peligro de heladas</b> en este mes. " : r === "moderado" ? "A esta altura <b>puede helar algunas noches</b>. " : ""}
      El pronóstico de ${nombreMes(S.sel)} estará disponible desde ${nombreMes(addM(S.sel, -2))}.</p>
    ${gauge(id, mes, n, "Lluvia normal:")}</div>`;
}

function tiraMeses(id, alt) {
  return `<div class="mstrip">${S.pron.meses.map((M) => {
    const pr = M.p[id]; if (!pr) return "";
    const k = M.cat[id], r = riesgoHelada(tminLocal(id, mesN(M.fecha), alt));
    return `<button type="button" data-mes="${M.fecha}" aria-current="${M.fecha === S.sel}" style="--c:${k === 3 ? S.C.muted : colorCat(k)}">
      <span class="m-n">${MESES[mesN(M.fecha) - 1]}</span><span class="m-i">${IC[CAT[k].icon]}</span>
      <span class="m-t">${CAT[k].corto}</span>${k !== 3 ? `<span class="m-p">${certeza(pr[k])} · ${pct(pr[k])}</span>` : ""}
      ${r && r !== "bajo" ? `<span class="m-f">${r === "alto" ? "Heladas" : "Puede helar"}</span>` : ""}</button>`;
  }).join("")}</div>`;
}

function resumenTexto(id, alt, al) {
  const M = S.pron.meses[0], p = S.geo.features[id].properties, z = S.meta.zonas[p.zona - 1];
  const partes = S.pron.meses.map((X) => {
    const k = X.cat[id];
    return `${cap(MESES[mesN(X.fecha) - 1])}: ${k === 3 ? "sin tendencia clara" : CAT[k].largo.toLowerCase()}, unos ${nf(X.mm[id])} milímetros`;
  });
  return `Pronóstico de lluvias para ${S.lugar || "su chacra"}, ${z.nombre}, a ${nf(alt)} metros. ${partes.join(". ")}. `
    + (al.length ? `Avisos: ${al.map((a) => a.t.toLowerCase()).join("; ")}.` : "No hay avisos para los próximos tres meses.")
    + ` Datos hasta ${nombreMes(S.meta.ultimo_mes_observado)}. ${M ? "" : ""}`;
}

function renderPanel() {
  const el = $("#detalle");
  if (S.cell == null) {
    el.innerHTML = `<div class="empty">${IC.pin}<div><b>Elija un lugar</b><br>Busque su pueblo o toque su chacra en el mapa para ver el pronóstico, los avisos y los consejos.</div></div>`;
    return;
  }
  const id = S.cell, p = S.geo.features[id].properties, alt = S.alt ?? p.elev, z = S.meta.zonas[p.zona - 1];
  const al = alertas(id, alt), tipos = al.map((a) => a.tipo);
  const recs = (tipos.length ? tipos : ["normal"]).flatMap((t) => RECS[t]);
  el.innerHTML = `
    <div class="place" style="--zc:${S.C.z[p.zona - 1]}"><span class="place-ic">${zonaIcon(p.zona)}</span>
      <div><h3>${esc(S.lugar || "Lugar elegido en el mapa")}</h3>
      <p>${z.nombre} · ${S.alt != null ? `${nf(S.alt)} m (su chacra)` : `${nf(p.elev)} m de altura promedio`}</p></div></div>
    ${veredicto(id, alt)}
    <div class="block-title">Próximos 3 meses</div>
    ${tiraMeses(id, alt)}
    <div class="block-title">Avisos</div>
    <div class="alerts">${al.length ? al.map((a) => `<div class="alert" style="--st:${a.st}">${IC[a.ic]}<div><b>${a.t}</b><span>${a.d}</span></div></div>`).join("")
      : `<div class="alert" style="--st:var(--good)">${IC.ok}<div><b>Sin avisos para los próximos 3 meses</b><span>No se espera falta ni exceso marcado de lluvia, ni heladas a esta altura.</span></div></div>`}</div>
    <div class="block-title">Consejos</div>
    <ul class="recs">${recs.map((r) => `<li>${r}</li>`).join("")}</ul>
    <p class="note">Consejos generales. Para su cultivo, consulte al técnico de la Agencia Agraria.</p>
    <div class="block-title">Lluvia de los últimos 2 años</div>
    <div class="chart-legend"><span><i style="background:${S.C.normal}"></i>Lo que llovió</span>
      <span><i style="background:repeating-linear-gradient(45deg,var(--wet) 0 2px,transparent 2px 4px);border:1px solid var(--wet)"></i>Pronóstico</span>
      <span><i class="line" style="background:var(--ink)"></i>Lo normal</span></div>
    <div class="chart" id="chart-celda">${S.hist ? "" : '<p class="muted small">Cargando…</p>'}</div>
    <div class="actions">
      <button class="btn btn-soft" id="btn-voz" type="button">${IC.voz.replace("<svg", '<svg fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"')}Escuchar</button>
      <a class="btn btn-wa" id="btn-wa" target="_blank" rel="noopener">${IC.wa.replace("<svg", '<svg fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"')}Compartir por WhatsApp</a>
    </div>`;
  el.querySelectorAll(".mstrip button").forEach((b) => b.addEventListener("click", () => elegirMes(b.dataset.mes)));
  const texto = resumenTexto(id, alt, al);
  $("#btn-wa").href = `https://wa.me/?text=${encodeURIComponent(`${texto}\n${location.origin}${location.pathname}`)}`;
  const bv = $("#btn-voz");
  if (!("speechSynthesis" in window)) bv.hidden = true;
  else bv.addEventListener("click", () => {
    if (speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    const u = new SpeechSynthesisUtterance(texto.replace(/ mm/g, " milímetros"));
    u.lang = "es-PE"; u.rate = 0.92;
    const v = speechSynthesis.getVoices().find((x) => x.lang.startsWith("es"));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  });
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
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="${S.C.line}"/>`;
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
    tip: `<b>${cap(nombreMes(M.fecha))} · pronóstico</b><br>Se esperan ${nf(M.mm[id])} mm<br>Lo normal: ${nf(M.normal[id])} mm` }));
  barras(cont, filas, { colorBarra: S.C.normal, etiquetaCada: 3 });
}

/* ------------------------------------------------------------------ panorama por zona */
function renderPanorama() {
  const zonasIds = [1, 2, 3].map((z) => S.geo.features.filter((f) => f.properties.zona === z).map((f) => f.properties.id));
  const celda = (M, ids, extra = "") => {
    const c = conteo(M, ids), n = ids.length, k = argmax(c), share = c[k] / n;
    const col = k === 3 ? S.C.muted : colorCat(k);
    return `<div class="pc${extra}" style="--c:${col}"><div class="t"><span>${IC[CAT[k].icon]}</span>${CAT[k].corto}</div>
      <div class="mini">${c.map((v, i) => v ? `<i style="flex:${v};background:${i === 3 ? S.C.nos : colorCat(i)}"></i>` : "").join("")}</div>
      <div class="s">En ${nf(100 * share)} % de la zona</div></div>`;
  };
  const fila = (z, ids) => `<div class="pz" style="--zc:${S.C.z[z - 1]}"><span class="zi">${zonaIcon(z)}</span><div>${S.meta.zonas[z - 1].nombre}<small>${nf(S.meta.zonas[z - 1].elev_min)}–${nf(S.meta.zonas[z - 1].elev_max)} m</small></div></div>
    ${S.pron.meses.map((M) => celda(M, ids)).join("")}`;
  const todos = S.geo.features.map((f) => f.properties.id);
  $("#pano").innerHTML = `<div class="ph">Zona</div>${S.pron.meses.map((M) => `<div class="ph">${cap(nombreMes(M.fecha))}</div>`).join("")}
    ${[1, 2, 3].map((z) => fila(z, zonasIds[z - 1])).join("")}
    <div class="pz pall"><span class="zi" style="--zc:var(--brand)">${IC.capas}</span><div>Toda la región<small>${S.meta.n_celdas} puntos</small></div></div>
    ${S.pron.meses.map((M) => celda(M, todos)).join("")}`;
  $("#pano-nota").textContent = "La barra delgada muestra cómo se reparte el resto de la zona entre las cuatro opciones. Para el detalle de su chacra, use el mapa.";
}

/* ------------------------------------------------------------------ zonas */
function renderZonas() {
  $("#zone-grid").innerHTML = S.meta.zonas.map((z, i) => `
    <article class="card zone" style="--zc:${S.C.z[i]}">
      <div class="zone-band"></div>
      <div class="zone-body">
        <div class="zone-head"><span class="zi">${zonaIcon(z.zona)}</span><div><h3>${z.nombre}</h3><p>${z.celdas} puntos del mapa</p></div></div>
        <p class="zone-desc">${ZONA_UI[z.zona].desc}</p>
        <div class="kv"><div><div class="k">Altura</div><div class="v">${nf(z.elev_min)}–${nf(z.elev_max)} m</div></div>
          <div><div class="k">Lluvia en el año</div><div class="v">${nf(z.lluvia_anual)} mm</div></div></div>
        <div class="muted small">Lluvia normal de cada mes (mm)</div>
        <div class="chart" id="chart-z${i}"></div>
        <div class="muted small">Meses con heladas</div>
        <div class="frost-strip">${z.tmin_mensual.map((t, m) => { const r = riesgoHelada(t);
          return `<span class="${r === "alto" ? "alto" : r === "moderado" ? "mod" : ""}" title="${cap(MESES[m])}: ${r === "alto" ? "peligro alto de heladas" : r === "moderado" ? "puede helar algunas noches" : "sin peligro de heladas"}">${MES_C[m][0].toUpperCase()}</span>`; }).join("")}</div>
        <div class="frost-key"><span><i class="mod"></i>Puede helar</span><span><i class="alto"></i>Peligro alto</span></div>
      </div>
    </article>`).join("");
  S.meta.zonas.forEach((z, i) => barras($(`#chart-z${i}`), z.normal_mensual.map((v, m) => ({ etiqueta: MES_C[m], v, normal: null,
    color: S.C.z[i], tip: `<b>${cap(MESES[m])}</b><br>Normalmente llueven ${nf(v)} mm` })), { linea: false, alto: 160 }));
}

/* ------------------------------------------------------------------ método + técnico */
function renderComo() {
  const m = S.meta, elegido = m.modelo_por_horizonte["1"], d = m.ss_por_anio_h1;
  const mejores = d.filter((x) => x.SS > 0).length;
  const ss1 = (m.metricas.find((r) => r.h === 1 && r.modelo === elegido) || {}).SS;
  $("#confia").innerHTML = `Superó a la lluvia normal en <strong>${mejores} de ${d.length} años</strong> y, en promedio, redujo el error del mes siguiente en <strong>${nf(100 * ss1)} %</strong>.`;
  const W = 600, H = 170, mg = { l: 8, r: 8, t: 16, b: 22 }, iw = W - mg.l - mg.r, ih = H - mg.t - mg.b;
  const lim = Math.max(0.1, ...d.map((x) => Math.abs(x.SS))) * 1.15, y = (v) => mg.t + ih / 2 - (v / lim) * (ih / 2), bw = iw / d.length;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Por año: barras hacia arriba cuando el pronóstico acertó mejor que lo normal, hacia abajo cuando acertó peor">`;
  s += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${y(0)}" y2="${y(0)}" stroke="${S.C.line}"/>`;
  d.forEach((x, i) => {
    const x0 = mg.l + i * bw + 6, w = bw - 12, y0 = y(Math.max(0, x.SS)), h = Math.abs(y(x.SS) - y(0));
    s += `<rect x="${x0}" y="${y0}" width="${w}" height="${Math.max(h, 1)}" rx="3" fill="${x.SS >= 0 ? S.C.good : S.C.dry}"><title>${x.anio}: ${x.SS >= 0 ? "mejor" : "peor"} que lo normal</title></rect>`;
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
    if (md === "pron") { const M = S.pron.meses[idxPron()]; base.push(M.mm[id], M.normal[id], ...(M.p[id] || ["", "", ""]), CAT[M.cat[id]].largo); }
    else if (md === "obs") { const o = obsMes(id); base.push(o ?? "", n, o == null ? "" : (100 * (o - n) / Math.max(n, 1)).toFixed(1)); }
    else base.push(n, S.clim.q33[id][mes - 1], S.clim.q67[id][mes - 1], S.clim.tmin[id][mes - 1] ?? "");
    filas.push(base.join(","));
  });
  const blob = new Blob(["﻿" + cab.join(",") + "\n" + filas.join("\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = `tamya_huanuco_${S.sel}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

iniciar();
