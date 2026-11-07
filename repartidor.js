/* ============================================================
   MÓDULO REPARTIDOR — FASE 1 + FASE 2 integradas
   FASE 1: renombres ("Pedidos", "Mapa", "Crear Factura"), sin botón Atrás,
           navegación por popstate, chat limpio, Iniciar Entrega → Mapa.
   FASE 2: botón "📢 Avisar llegué" + "Entregado" en tarjetas del Mapa,
           filtro de "facturas internas" para pedidos WhatsApp (esChat).
   ============================================================ */
window.addEventListener("error", (e) => {
  const m = document.getElementById("msgLogin");
  if (m) { m.textContent = "Error en la página: " + e.message + ". Puede que falten archivos por subir a GitHub."; m.className = "estado error"; }
});
const auth = APP.auth();
const db = APP.database();
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;

/* ============================================================
   PANTALLA ACTIVA · Screen Wake Lock
   ============================================================ */
const Pantalla = (() => {
  let lock = null, quiere = false;
  const soportado = () => !!(navigator.wakeLock && typeof navigator.wakeLock.request === "function");
  const ind = (si) => { const e = document.getElementById("wakeInd"); if (e) e.classList.toggle("oculto", !si); };
  const nativoKA = () => { try { return typeof plug === "function" ? plug("KeepAwake") : null; } catch (_) { return null; } };
  async function pedir() {
    quiere = true;
    const ka = nativoKA();
    if (ka && typeof ka.keepAwake === "function") { try { await ka.keepAwake(); ind(true); } catch (_) {} }
    if (!soportado() || document.visibilityState !== "visible") return;
    if (lock && !lock.released) return;
    try {
      lock = await navigator.wakeLock.request("screen");
      ind(true);
      lock.addEventListener("release", () => { ind(false); });
    } catch (_) { ind(false); }
  }
  function soltar() {
    quiere = false;
    try { lock && lock.release(); } catch (_) {}
    lock = null; ind(false);
    const ka = nativoKA();
    if (ka && typeof ka.allowSleep === "function") { try { ka.allowSleep(); } catch (_) {} }
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && quiere) pedir(); });
  window.addEventListener("pageshow", () => { if (quiere) pedir(); });
  return { pedir, soltar, soportado };
})();

/* ============================================================
   ACTUALIZACIONES OBLIGATORIAS
   ============================================================ */
const APP_VERSION = 1;
const ActualizacionApp = (() => {
  const RUTA = "configuracion/actualizaciones/repartidor";
  let ref = null;
  const g = (id) => document.getElementById(id);
  const urlSegura = (u) => { try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_) { return ""; } };
  function mostrar(d) {
    const url = urlSegura(d.url), btn = g("btnActualizarApp");
    g("updNovedades").textContent = String(d.novedades || "").trim() || "Mejoras de rendimiento y correcciones.";
    g("updVersionTxt").textContent = "Tu versión: " + APP_VERSION + " · Nueva versión: " + Number(d.version);
    if (url) {
      btn.href = url; btn.removeAttribute("aria-disabled");
      btn.onclick = (e) => { e.preventDefault(); try { window.open(url, "_system"); } catch (_) { window.location.href = url; } };
    } else {
      btn.removeAttribute("href"); btn.setAttribute("aria-disabled", "true"); btn.onclick = (e) => e.preventDefault();
    }
    g("modalActualizacion").classList.remove("oculto");
    document.body.classList.add("upd-bloqueado");
    try { btn.focus(); } catch (_) {}
  }
  function ocultar() {
    g("modalActualizacion").classList.add("oculto");
    document.body.classList.remove("upd-bloqueado");
  }
  function evaluar(d) { if (d && Number(d.version) > APP_VERSION) mostrar(d); else ocultar(); }
  function vigilar() {
    if (ref) return;
    ref = db.ref(RUTA);
    ref.on("value", (s) => evaluar(s.val()), () => { ref = null; });
  }
  return { vigilar, evaluar };
})();
ActualizacionApp.vigilar();
auth.onAuthStateChanged((u) => { if (u) ActualizacionApp.vigilar(); });

const WORKER_URL_BROTHERS = "https://TU-WORKER.TU-CUENTA.workers.dev";
const PRIORIDAD_EXTRA = 10;
const sumaExtras = (o) => (o && typeof o === "object" ? Object.values(o).reduce((t, e) => t + (Number(e && e.monto) || 0), 0) : 0);

let watchId = null, bgId = null, bgPlugin = null, latido = null;
let uidActual = null, usuario = null, ultimaPos = null, ultimaEscritura = 0;
const INTERVALO_MS = 4000;
const RADIO_AVISO_M = 200;
const FRESCO_MS = 60000;

const viajes = {};
let orden = [];
let seleccionado = null;
let vistaActual = "factura";
let chatToken = null;
const RUTA_EQUIPO = { chats: "chatsEquipo", resumen: "chatsEquipoResumen", fotos: "fotosEquipo" };
let lugares = {}, lugarMarks = {}, refLugares = null, lugarDestino = null, marcaLugar = null, rutaLugar = null;
let capaLugar = null, flechasLugar = null, flechasOrden = null, flechasClave = "", resultadosRep = [];
let guiaActual = null, guiaTsVisto, marcaGuia = null, refGuia = null, refAdminChat = null, adminListo = false, noLeidosAdmin = 0;
let mapa = null, marcaYo = null, estelaProp = null, capaRuta = null, capaFlujo = null;
let rastro = [], marcando = false, nombreYoMarcado = "";
const iconoDestino = iconoPin();

function setEstado(texto, tipo = "") {
  const el = $("estadoGps"); if (!el) return;
  el.textContent = texto; el.className = "estado " + tipo;
}
function generarToken(largo = 14) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
function enlaceDe(token, extra) {
  if (window.Factura && typeof window.Factura.enlaceRastreo === "function") return window.Factura.enlaceRastreo(token, extra);
  try {
    const u = new URL(String(URL_RASTREO), window.location.href);
    u.hash = "";
    Array.from(u.searchParams.keys()).forEach((k) => { if (/^(utm_|fbclid$|gclid$|ref$|source$|debug$|v$|t$|ts$|cb$|nocache$)/i.test(k)) u.searchParams.delete(k); });
    u.pathname = u.pathname.replace(/\/index\.html?$/i, "/");
    u.searchParams.set("id", token);
    if (extra) Object.keys(extra).forEach((k) => u.searchParams.set(k, extra[k]));
    return u.toString();
  } catch (e) { return `${URL_RASTREO}?id=${token}` + (extra ? "&" + Object.keys(extra).map((k) => k + "=" + extra[k]).join("&") : ""); }
}
const leyendaEnlace = (link) =>
  "📍 *Importante:* abra el enlace y comparta su ubicación en tiempo real para que su repartidor lo encuentre y su pedido llegue más rápido.\n" +
  "👉 " + link;

const CodigosBD = (() => {
  const P = 100003, A = 48271, LOTE = 25, MINIMO = 8, CLAVE = "brothersCodigosBDReservados";
  let cola = [], pidiendo = false;
  try { const a = JSON.parse(localStorage.getItem(CLAVE)); if (Array.isArray(a)) cola = a.filter((c) => /^BD\d{5}$/.test(c)); } catch (_) {}
  const guardar = () => { try { localStorage.setItem(CLAVE, JSON.stringify(cola)); } catch (_) {} };
  async function reponer() {
    if (pidiendo || !uidActual) return;
    pidiendo = true;
    try {
      const r = await db.ref("codigosRetiro/contador").transaction((c) => (Number(c) || 0) + LOTE);
      if (r.committed) {
        const fin = Number(r.snapshot.val()) || 0;
        for (let k = fin - LOTE; k < fin; k++) {
          const idx = (k % (P - 1)) + 1, v = (idx * A) % P;
          if (v >= 1 && v <= 99999) cola.push("BD" + String(v).padStart(5, "0"));
        }
        guardar();
      }
    } catch (_) {}
    pidiendo = false;
  }
  function siguiente() {
    const c = cola.shift() || null;
    if (c) guardar();
    if (cola.length < MINIMO) reponer();
    return c;
  }
  return { siguiente, reponer };
})();
const etiquetaPedido = (codigo, origen) => (window.Factura && typeof window.Factura.etiquetaPedido === "function")
  ? window.Factura.etiquetaPedido(codigo, origen)
  : (((origen === "app" ? "APP" : "WA") + String(codigo == null ? "" : codigo).replace(/\D/g, "").padStart(5, "0")));
const etiquetaWA = (v) => etiquetaPedido(v && v.pedido, "wa");
const num = (x) => (Number.isFinite(x) ? x : null);
const formatoDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const nombreDe = (v) => v.cliente || ("Pedido " + etiquetaWA(v));
const esVivo = (v) => !!(v.cliPos && !v.cliPos.manual && v.cliPos.ts && Date.now() - v.cliPos.ts < FRESCO_MS);

function mostrar(vista) {
  $("splash").classList.add("oculto");
  $("mainAuth").classList.toggle("oculto", vista === "app");
  $("vistaLogin").classList.toggle("oculto", vista !== "login");
  $("vistaUsuario").classList.toggle("oculto", vista !== "usuario");
  $("btnSalir").classList.toggle("oculto", vista === "login");
  $("btnChatAdmin").classList.toggle("oculto", vista !== "app");
  if (vista !== "app") {
    ["vistaFactura", "vistaMapa", "vistaChats", "navApp"].forEach((id) => $(id).classList.add("oculto"));
  } else irA(vistaActual);
}
function irA(vista) {
  vistaActual = vista;
  $("vistaFactura").classList.toggle("oculto", vista !== "factura");
  $("vistaMapa").classList.toggle("oculto", vista !== "mapa");
  $("vistaChats").classList.toggle("oculto", vista !== "chats");
  actualizarNav();
  if (vista === "chats") { try { ChatsEntrantes.alMostrar(); } catch (_) {} }
  if (vista === "mapa") {
    renderLista();
    initMapa();
    try { ChatsEntrantes.pintarMapa(); } catch (_) {}
    setTimeout(() => {
      mapa.invalidateSize();
      if (seguirme && ultimaPos && seleccionado && viajes[seleccionado] && viajes[seleccionado].destino) {
        Camara.actualizar(true);
      } else {
        encuadrar();
        encuadrarTodosPedidos();
      }
    }, 60);
  }
}
const noLeidosPedido = () => { try { return PedidoRep.noLeidos(); } catch (_) { return 0; } };
const htmlPedidoChat = () => { try { return PedidoRep.htmlChat(); } catch (_) { return ""; } };
function actualizarNav() {
  const hay = !!uidActual && !!usuario;
  $("navApp").classList.toggle("oculto", !hay);
  document.body.classList.toggle("con-nav", !!hay);
  $("navFactura").classList.toggle("activa", vistaActual === "factura");
  $("navMapa").classList.toggle("activa", vistaActual === "mapa");
  $("navChats").classList.toggle("activa", vistaActual === "chats");
  let nuevosChats = 0;
  try { nuevosChats = ChatsEntrantes.pendientes(); } catch (_) {}
  $("badgeChats").textContent = String(nuevosChats);
  $("badgeChats").classList.toggle("oculto", !nuevosChats);
  const sinLeer = orden.reduce((t, k) => t + (viajes[k] ? viajes[k].noLeidos : 0), 0) + noLeidosPedido();
  const b = $("badgeNav");
  b.textContent = sinLeer ? "💬 " + sinLeer : String(orden.length);
  b.classList.toggle("rojo", sinLeer > 0);
  b.classList.toggle("oculto", !orden.length && !sinLeer);
}
$("navFactura").onclick = () => irA("factura");
$("navMapa").onclick = () => irA("mapa");
$("navChats").onclick = () => irA("chats");

function msgLogin(t) {
  const e = $("msgLogin");
  if (!e) { if (t) alert(t); return; }
  e.textContent = t || ""; e.classList.toggle("oculto", !t);
}
$("btnLogin").onclick = () => {
  msgLogin("");
  auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
      .catch(() => msgLogin("No se pudo entrar: correo o contraseña incorrectos."));
};

try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (_) {}
setTimeout(() => $("splash").classList.add("oculto"), 8000);
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    detenerGPS(); apagarNativo(); soltarViajesEnMemoria(); soltarAdmin(); try { ChatsEntrantes.detener(); } catch (_) {} uidActual = null; usuario = null; $("clave").value = "";
    return mostrar("login");
  }
  uidActual = user.uid;
  let reg;
  const claveCache = "repInfo_" + user.uid;
  try {
    reg = await Promise.race([
      db.ref("repartidores/" + user.uid).once("value").then((x) => x.val()),
      new Promise((_, no) => setTimeout(() => no({ code: "TIMEOUT" }), 6000))
    ]);
    if (reg) localStorage.setItem(claveCache, JSON.stringify(typeof reg === "object" ? { usuario: reg.usuario || null } : { usuario: null }));
  } catch (e) {
    if (e && e.code === "PERMISSION_DENIED") {
      msgLogin("No se pudo verificar tu cuenta: faltan permisos en Firebase (reglas).");
      return auth.signOut();
    }
    try { reg = JSON.parse(localStorage.getItem(claveCache) || "null"); } catch (_) { reg = null; }
    if (!reg) { msgLogin("Sin conexión: no se pudo verificar tu cuenta. Revisa tu internet."); return mostrar("login"); }
  }
  if (!reg) {
    msgLogin("Esta cuenta no está registrada como repartidor. Pide al administrador que la agregue en la pestaña Equipo.");
    return auth.signOut();
  }
  usuario = typeof reg === "object" && reg.usuario ? reg.usuario : null;
  if (!usuario) return mostrar("usuario");
  entrarTurno();
});

$("btnGuardarUsuario").onclick = async () => {
  const v = $("inputUsuario").value.trim().replace(/\s+/g, " ");
  if (v.length < 2 || v.length > 24) return alert("El nombre debe tener entre 2 y 24 caracteres.");
  try { await db.ref(`repartidores/${uidActual}/usuario`).set(v); }
  catch (e) { return alert("No se pudo guardar el nombre: " + e.message); }
  usuario = v;
  entrarTurno();
};

async function entrarTurno() {
  db.ref("ubicaciones/" + uidActual).onDisconnect().update({ enLinea: false, enViaje: false, conPedido: false, ts: TS });
  Factura.nombreRepartidor = usuario;
  Factura.codigoCompartido = () => CodigosBD.siguiente();
  CodigosBD.reponer();
  Pantalla.pedir();
  reanudarViajes();
  vistaActual = orden.length ? "mapa" : "factura";
  mostrar("app");
  escucharAdmin();
  ChatsEntrantes.iniciar();
  await permisosInicio();
  registrarPush();
  iniciarNativo();
  iniciarGPS();
}

$("btnSalir").onclick = async () => {
  if (orden.length || ChatsEntrantes.activos()) return alert("Primero entrega o cancela los pedidos en curso.");
  if (!confirm("¿Cerrar sesión? Dejarás de compartir tu ubicación.")) return;
  detenerGPS(); apagarNativo();
  try { await db.ref(`repartidores/${uidActual}/fcmToken`).remove(); } catch (_) {}
  try {
    await db.ref("ubicaciones/" + uidActual).update({ enLinea: false, enViaje: false, conPedido: false, ts: TS });
    db.ref("ubicaciones/" + uidActual).onDisconnect().cancel();
  } catch (_) {}
  await auth.signOut();
};

/* ============================================================
   MAPA
   ============================================================ */
function initMapa() {
  if (mapa) return;
  mapa = L.map("mapaRuta", Object.assign({}, GestosMapa.opciones, Camara.opcionesMapa())).setView([12.5700, -87.1311], 14);
  mapa.createPane("paneLugares").style.zIndex = 590;
  mapa.createPane("paneYo").style.zIndex = 640;
  L.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);
  GestosMapa.aplicar(mapa);
  mapa.on("click movestart", cerrarBusquedaRep);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
  estelaProp = L.polyline([], { color: "#7B8794", weight: 5, opacity: .65 }).addTo(mapa);
  capaRuta = L.polyline([], { color: "#0A86C9", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
  capaFlujo = L.polyline([], { color: "#fff", weight: 3, opacity: .95, className: "ruta-viva" }).addTo(mapa);
  flechasOrden = L.layerGroup().addTo(mapa);
  capaLugar = L.polyline([], { color: "#F59E0B", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
  flechasLugar = L.layerGroup().addTo(mapa);
  mapa.on("zoomend", () => mapa.getContainer().classList.toggle("zoom-lejos", mapa.getZoom() < 15));
  mapa.on("zoom zoomend", Camara.aplicarEscala);
  Camara.aplicarEscala();
  mapa.getContainer().classList.add("zoom-lejos");
  mapa.on("popupopen", (e) => {
    const el = e.popup.getElement(); if (!el) return;
    el.querySelectorAll("button[data-ir]").forEach((b) => b.onclick = () => { mapa.closePopup(); irALugar(lugares[b.dataset.ir], true); });
  });
  mapa.on("click", (e) => { if (Policia.clickMapa(e.latlng)) return; if (marcando) fijarDestinoManual(e.latlng.lat, e.latlng.lng); });
  mapa.on("dragstart", () => { seguirme = false; Camara.refrescarBoton(); });
  if (ultimaPos) { pintarYo(); mapa.setView([ultimaPos.lat, ultimaPos.lng], 15); }
  Policia.pintar();
  orden.forEach((t) => pintarCliente(viajes[t]));
  dibujarRuta();
  pintarGuia();
  PedidoRep.pintarCliente();
  pintarLugares();
  if (lugarDestino) { pintarLugarDestino(); dibujarRutaLugar(); }
  actualizarBanner();
  ["pointerdown", "touchstart", "wheel"].forEach((ev) => mapa.getContainer().addEventListener(ev, Camara.gesto, { passive: true, capture: true }));
  mapa.on("zoomstart", Camara.alZoom);
  try { ChatsEntrantes.pintarRutasPendientes(); } catch (_) {}
}
let seguirme = true;

/* ============================================================
   CÁMARA DEL REPARTIDOR
   ============================================================ */
const Camara = (() => {
  const SIGNO_ROTACION = 1;
  const MIN_PASO_M = 4;
  const MIN_MS = 900;
  let prev = null, suave = 0, tieneRumbo = false, ult = 0, ultGesto = 0;
  let modo = "fitbounds";
  const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
  const rotable = () => !!(mapa && typeof mapa.setBearing === "function");
  const gesto = () => { ultGesto = Date.now(); };
  const alZoom = () => { if (Date.now() - ultGesto < 1500 && seguirme) { seguirme = false; refrescarBoton(); } };
  const opcionesMapa = () => ({ rotate: true, bearing: 0, touchRotate: false, rotateControl: false, zoomSnap: 0.25, zoomDelta: 1 });

  function rumboEntre(a, b) {
    const dLng = rad(b.lng - a.lng);
    const y = Math.sin(dLng) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  function giroSuave(a, b) { const d = ((b - a + 540) % 360) - 180; return (a + d * 0.5 + 360) % 360; }
  function registrar(lat, lng) {
    const p = { lat, lng };
    if (!prev) { prev = p; return; }
    if (distanciaM(prev.lat, prev.lng, lat, lng) < MIN_PASO_M) return;
    const r = rumboEntre(prev, p);
    prev = p;
    suave = tieneRumbo ? giroSuave(suave, r) : r;
    tieneRumbo = true;
  }
  function destino() {
    if (lugarDestino) return lugarDestino;
    const v = viajes[seleccionado];
    if (v && v.destino) return v.destino;
    return PedidoRep.posCliente();
  }
  function zoomPara(dist) {
    if (dist == null) return 17;
    const z = 19 - Math.log2(Math.max(dist, 80) / 80) * 0.75;
    return Math.round(Math.min(19, Math.max(14.5, z)) * 4) / 4;
  }
  function escalaPara(z) { return Math.round(Math.min(1.6, Math.max(0.7, 0.7 * Math.pow(2, (z - 15) * 0.3))) * 100) / 100; }
  function aplicarEscala() {
    if (!mapa) return;
    try { mapa.getContainer().style.setProperty("--escala-rep", String(escalaPara(mapa.getZoom()))); } catch (_) {}
  }
  function marcarIcono() { const e = marcaYo && marcaYo.getElement && marcaYo.getElement(); if (e) e.classList.add("rep-yo"); }

  function refrescarBoton() {
    const b = $("btnSeguir"); if (!b) return;
    const nav = modo === "navegacion";
    b.classList.toggle("on", !!seguirme && nav);
    b.setAttribute("aria-pressed", String(!!seguirme && nav));
    b.setAttribute("aria-label", nav ? "Cambiar a vista con ambos visibles" : "Seguir mi moto (cámara de navegación)");
  }
  function setModo(m) {
    modo = m === "navegacion" ? "navegacion" : "fitbounds";
    refrescarBoton();
  }
  function getModo() { return modo; }

  function actualizar(forzar) {
    if (!mapa || !ultimaPos || !seguirme || vistaActual !== "mapa") return;
    if (marcando || document.activeElement === $("busqRep") || !$("resBusqRep").classList.contains("oculto")) return;
    const ahora = Date.now();
    if (!forzar && ahora - ult < MIN_MS) return;
    ult = ahora;
    const d = destino();

    if (modo === "fitbounds") {
      const pts = puntosMulti(d);
      if (pts.length >= 2) {
        if (!forzar) {
          const vb = mapa.getBounds();
          if (pts.every((q) => vb.contains(q))) { refrescarBoton(); return; }
        }
        mapa.fitBounds(L.latLngBounds(pts), { padding: [80, 80], maxZoom: 17, animate: !forzar, duration: 0.8 });
      } else if (pts.length === 1) {
        mapa.setView(pts[0], Math.max(mapa.getZoom(), 15), { animate: !forzar, duration: 0.8 });
      }
      aplicarEscala();
      refrescarBoton();
      return;
    }

    const dist = d && Number.isFinite(d.lat) ? distanciaM(ultimaPos.lat, ultimaPos.lng, d.lat, d.lng) : null;
    const z = zoomPara(dist), ang = rotable() && tieneRumbo ? suave : 0;
    const k = mapa.getSize().y / 6;
    const t = rad(ang), pr = mapa.project([ultimaPos.lat, ultimaPos.lng], z);
    const centro = mapa.unproject(L.point(pr.x + Math.sin(t) * k, pr.y - Math.cos(t) * k), z);
    if (rotable()) { try { mapa.setBearing((SIGNO_ROTACION * ang + 360) % 360); } catch (_) {} }
    mapa.setView(centro, z, { animate: !forzar, duration: 0.8, easeLinearity: 0.5, noMoveStart: true });
    aplicarEscala();
    refrescarBoton();
  }
  function norte() {
    if (rotable()) { try { mapa.setBearing(0); } catch (_) {} }
    setTimeout(refrescarBoton, 0);
  }
  return { opcionesMapa, registrar, actualizar, norte, aplicarEscala, marcarIcono, refrescarBoton, gesto, alZoom, setModo, getModo };
})();

function pintarYo(rumbo) {
  if (!mapa || !ultimaPos) return;
  const p = [ultimaPos.lat, ultimaPos.lng];
  if (!marcaYo) { marcaYo = L.marker(p, { icon: iconoRepartidorNombre(usuario), zIndexOffset: 1000, pane: "paneYo" }).addTo(mapa); nombreYoMarcado = usuario; }
  else {
    marcaYo.setLatLng(p);
    if (nombreYoMarcado !== usuario) { marcaYo.setIcon(iconoRepartidorNombre(usuario)); nombreYoMarcado = usuario; }
  }
  Camara.marcarIcono();
  if (rastro.length) estelaProp.setLatLngs(rastro);
  dibujarOtras();
}

function iconoCliente(n, nombre, sel, vivo) {
  const color = ["#E5322D", "#2F6FED", "#12A150", "#F59E0B", "#9333EA", "#0891B2"][(Number(n) - 1 + 6) % 6];
  return L.divIcon({
    className: "",
    html: `<div class="pin-cli-hit"><div class="pin-cli-min${sel ? " sel" : ""}${vivo ? " vivo" : ""}" style="--pin-cli-c:${color}"></div></div><span class="etq-cli-min"><b>${n}</b> · ${escHtml(nombre)}</span>`,
    iconSize: [28, 28], iconAnchor: [14, 14]
  });
}
const iconoClienteDot = L.divIcon({ className: "", html: '<div class="marca-cliente"><span>Cliente</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] });

function pintarCliente(v) {
  if (!mapa || !v) return;
  const n = orden.indexOf(v.token) + 1, sel = v.token === seleccionado, vivo = esVivo(v);
  if (v.destino) {
    const clave = [n, sel, vivo, nombreDe(v)].join("|"), p = [v.destino.lat, v.destino.lng];
    if (!v.marca) { v.marca = L.marker(p, { icon: iconoCliente(n, nombreDe(v), sel, vivo), zIndexOffset: sel ? 800 : 500 }).addTo(mapa); v.marca._clave = clave; v.marca.on("click", () => seleccionar(v.token, true)); }
    else {
      v.marca.setLatLng(p);
      if (v.marca._clave !== clave) { v.marca.setIcon(iconoCliente(n, nombreDe(v), sel, vivo)); v.marca.setZIndexOffset(sel ? 800 : 500); v.marca._clave = clave; }
    }
  } else if (v.marca) { mapa.removeLayer(v.marca); v.marca = null; }

  if (v.destManual && v.cliPos) {
    const p = [v.cliPos.lat, v.cliPos.lng];
    if (!v.marcaCli) v.marcaCli = L.marker(p, { icon: iconoClienteDot, interactive: false }).addTo(mapa);
    else v.marcaCli.setLatLng(p);
  } else if (v.marcaCli) { mapa.removeLayer(v.marcaCli); v.marcaCli = null; }
}

function encuadrar(soloSeleccionado) {
  if (!mapa) return;
  if (Camara.getModo() !== "navegacion") { try { mapa.setBearing(0); } catch (_) {} }
  const pts = [];
  if (ultimaPos) pts.push([ultimaPos.lat, ultimaPos.lng]);
  const lista = soloSeleccionado && seleccionado ? [seleccionado] : orden;
  lista.forEach((t) => { const v = viajes[t]; if (v && v.destino) pts.push([v.destino.lat, v.destino.lng]); });
  if (!(soloSeleccionado && seleccionado)) { try { ChatsEntrantes.puntos().forEach((p) => pts.push([p.lat, p.lng])); } catch (_) {} }
  if (guiaCliente() && !orden.length) pts.push([guiaActual.lat, guiaActual.lng]);
  const cliPed = PedidoRep.posCliente(); if (cliPed) pts.push([cliPed.lat, cliPed.lng]);
  if (pts.length > 1) mapa.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 17 });
  else if (pts.length === 1) mapa.setView(pts[0], 16);
}
function puntosMulti(extra) {
  const pts = [];
  const add = (p) => { if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) pts.push([p.lat, p.lng]); };
  if (ultimaPos) add(ultimaPos);
  if (lugarDestino) { add(extra); return pts; }
  orden.forEach((t) => { const v = viajes[t]; if (v) add(v.destino || v.cliPos); });
  try { ChatsEntrantes.puntos().forEach(add); } catch (_) {}
  try { add(PedidoRep.posCliente()); } catch (_) {}
  add(extra);
  return pts;
}
function encuadrarTodosPedidos() {
  if (!mapa) return;
  const pts = puntosMulti();
  if (pts.length >= 2) mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 17 });
  else if (pts.length === 1) mapa.setView(pts[0], 16);
}
const lineasOtras = {};
function dibujarOtras() {
  if (!mapa) return;
  Object.keys(lineasOtras).forEach((t) => { if (!viajes[t]) { mapa.removeLayer(lineasOtras[t]); delete lineasOtras[t]; } });
  orden.forEach((t) => {
    const v = viajes[t]; if (!v) return;
    if (t !== seleccionado && v.destino && ultimaPos) {
      const pts = [[ultimaPos.lat, ultimaPos.lng], [v.destino.lat, v.destino.lng]];
      if (!lineasOtras[t]) lineasOtras[t] = L.polyline(pts, { color: "#7B8794", weight: 3, opacity: .75, dashArray: "4 8", interactive: false }).addTo(mapa);
      else lineasOtras[t].setLatLngs(pts);
    } else if (lineasOtras[t]) { mapa.removeLayer(lineasOtras[t]); delete lineasOtras[t]; }
  });
}
$("btnVerTodo").onclick = () => { seguirme = false; Camara.setModo("fitbounds"); encuadrar(false); Camara.refrescarBoton(); };
$("btnSeguir").onclick = () => {
  if (!ultimaPos) return setEstado("Esperando tu ubicación para seguirte…", "error");
  if (Camara.getModo() === "navegacion") {
    Camara.setModo("fitbounds");
    setEstado("🧭 Vista: ambos visibles (moto + cliente)", "ok");
  } else {
    Camara.setModo("navegacion");
    setEstado("🧭 Vista: navegación (cámara girada)", "ok");
  }
  seguirme = true;
  Camara.actualizar(true);
};
Camara.refrescarBoton();

async function pedirRuta(v, forzar) {
  if (!v || !v.destino || !ultimaPos) return;
  const ahora = Date.now();
  if (!forzar && ahora - v.rutaEn < 15000) return;
  const cambioOrigen = !v.rutaOrigen || distanciaM(ultimaPos.lat, ultimaPos.lng, v.rutaOrigen.lat, v.rutaOrigen.lng) > 60;
  const cambioDest = !v.rutaDest || distanciaM(v.destino.lat, v.destino.lng, v.rutaDest.lat, v.rutaDest.lng) > 40;
  if (!forzar && v.rutaPts && !cambioOrigen && !cambioDest) return;
  v.rutaEn = ahora;
  const o = { lat: ultimaPos.lat, lng: ultimaPos.lng }, d = { lat: v.destino.lat, lng: v.destino.lng };
  try {
    const r = await Ordenes.rutaCalles(o, d);
    if (!r) throw new Error("sin ruta");
    v.rutaFallo = false;
    v.rutaPts = r.pts; v.rutaDur = r.dur; v.rutaDist = r.dist; v.rutaPasos = r.pasos; v.rutaIdx = 0;
    v.rutaOrigen = o; v.rutaDest = d;
  } catch (_) {
    v.rutaFallo = true; v.rutaEn = Date.now() - 12000;
    if (!v._reint) v._reint = setTimeout(() => { v._reint = null; if (viajes[v.token] && v.token === seleccionado) pedirRuta(v, true); }, 3000);
  }
  if (v.token === seleccionado) dibujarRuta();
  refrescarTextos(); actualizarBanner();
}
function dibujarRuta() {
  if (!mapa) return;
  const v = viajes[seleccionado];
  let pts = [];
  if (v && v.destino && ultimaPos) {
    pts = v.rutaPts ? [[ultimaPos.lat, ultimaPos.lng], ...v.rutaPts] : [];
  }
  capaRuta.setLatLngs(pts); capaFlujo.setLatLngs(pts);
  capaRuta.setStyle({ opacity: v && v.rutaPts ? .9 : .5 });
  const clave = v && v.rutaPts ? v.token + v.rutaPts.length + (v.rutaDist || 0) : "";
  if (clave !== flechasClave) { flechasClave = clave; if (clave) Ruta.flechas(v.rutaPts, flechasOrden, "#0A86C9"); else flechasOrden.clearLayers(); }
  dibujarOtras();
  pintarGuia();
}

function seleccionar(token, enfocar) {
  if (!viajes[token]) return;
  seleccionado = token;
  orden.forEach((t) => pintarCliente(viajes[t]));
  renderLista();
  dibujarRuta();
  pedirRuta(viajes[token], true);
  if (enfocar) {
    seguirme = true;
    Camara.setModo("fitbounds");
    Camara.refrescarBoton();
    Camara.actualizar(true);
  }
}
$("btnMarcarDestino").onclick = () => {
  if (!seleccionado) return alert("No hay un pedido seleccionado.");
  marcando = !marcando;
  $("btnMarcarDestino").classList.toggle("activo", marcando);
  $("avisoMarcar").textContent = `Toca el mapa para marcar el destino de ${nombreDe(viajes[seleccionado])}.`;
  $("avisoMarcar").classList.toggle("oculto", !marcando);
};
function fijarDestinoManual(lat, lng) {
  const v = viajes[seleccionado]; if (!v) return;
  marcando = false; $("btnMarcarDestino").classList.remove("activo"); $("avisoMarcar").classList.add("oculto");
  fijarDestino(v, lat, lng);
}
function fijarDestino(v, lat, lng) {
  v.destManual = true; v.destino = { lat, lng }; v.cerca = false; v.rutaPts = null; v.rutaDest = null; v.rutaIdx = 0;
  db.ref("pedidos/" + v.token).update({ destLat: lat, destLng: lng, cerca: false, distancia: null });
  guardarViajes(); pintarCliente(v); dibujarRuta(); pedirRuta(v, true); evaluarViaje(v); refrescarTextos();
}
function usarUbicacionCliente(v) {
  v.destManual = false; v.cerca = false; v.rutaPts = null; v.rutaDest = null; v.rutaIdx = 0;
  if (v.cliPos) v.destino = { lat: v.cliPos.lat, lng: v.cliPos.lng };
  else { v.destino = null; db.ref("pedidos/" + v.token).update({ destLat: null, destLng: null, cerca: null, distancia: null }); }
  guardarViajes(); pintarCliente(v); dibujarRuta(); pedirRuta(v, true); evaluarViaje(v); refrescarTextos();
}

function guardarViajes() {
  try {
    const otros = JSON.parse(localStorage.getItem("viajesActivos") || "[]").filter((x) => x.uid !== uidActual);
    const mios = orden.map((t) => ({ token: t, tel: viajes[t].tel, pedido: viajes[t].pedido, cliente: viajes[t].cliente, destManual: viajes[t].destManual, sinFactura: !!viajes[t].sinFactura, uid: uidActual }));
    localStorage.setItem("viajesActivos", JSON.stringify(otros.concat(mios)));
  } catch (_) {}
}

/* FASE 2 · crearViaje detecta si el pedido proviene del pool de WhatsApp (solicitudId) */
function crearViaje(info) {
  const v = {
    token: info.token, tel: info.tel || "", pedido: info.pedido || "", cliente: info.cliente || "",
    destManual: !!info.destManual, sinFactura: !!info.sinFactura, cerrando: false, refEstado: null, destino: null, cliPos: null, cerca: false, dist: null,
    marca: null, marcaCli: null, refCli: null, refChat: null, noLeidos: 0, chatListo: false, factura: null, sub: null, extras: null, refExtra: [],
    rutaPts: null, rutaEn: 0, rutaOrigen: null, rutaDest: null, rutaDur: null, rutaIdx: 0,
    esChat: !!info.esChat
  };
  viajes[v.token] = v;
  Pantalla.pedir();
  if (!orden.includes(v.token)) orden.push(v.token);
  escucharCliente(v);
  escucharChat(v);
  escucharEstado(v);
  escucharSubfactura(v);
  try { ChatsEntrantes.marcarConPedido(); } catch (_) {}
  // Detección asíncrona: si el pedido viene del pool de WhatsApp (solicitudes_entrantes), marcar esChat
  db.ref("pedidos/" + v.token + "/solicitudId").once("value").then((s) => {
    if (s.exists()) { v.esChat = true; refrescarTextos(); }
  }).catch(() => {});
  return v;
}

async function avisarAlAdminChat(a) {
  try {
    if (/TU-WORKER/.test(WORKER_URL_BROTHERS)) return;
    const u = auth.currentUser; if (!u) return;
    const idToken = await u.getIdToken();
    fetch(WORKER_URL_BROTHERS, {
      method: "POST", keepalive: true,
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
      body: JSON.stringify(Object.assign({ accion: "admin_chat" }, a, { texto: String(a.texto || "").slice(0, 240) }))
    }).catch(() => {});
  } catch (_) {}
}

function detalleDeFactura(f, conPrioridad) {
  const base = Number(f.total) || 0;
  const d = {
    productos: (f.productos || []).map((p) => ({ nombre: String(p.nombre).slice(0, 80), precio: Number(p.precio) || 0 })),
    subtotal: Number(f.subtotal) || 0, delivery: Number(f.delivery) || 0, totalBase: base, total: base
  };
  if (conPrioridad) { d.prioridad = PRIORIDAD_EXTRA; d.total = Math.round((base + PRIORIDAD_EXTRA) * 100) / 100; }
  return JSON.parse(JSON.stringify(d));
}
function alertaPrioridad(token, codigo) {
  const k = "prioAvisada_" + token;
  try { if (localStorage.getItem(k)) return; localStorage.setItem(k, "1"); } catch (_) {}
  const frase = Voz.FRASES.prioridadCliente(codigo);
  Voz.prioridad(codigo);
  navigator.vibrate && navigator.vibrate([400, 200, 400, 200, 400]);
  notificarTexto("⚡ Prioridad", frase, "Prioridad", { token });
  if (!document.hidden) setEstado("⚡ " + frase + " (+C$ " + PRIORIDAD_EXTRA.toFixed(2) + " de propina por prioridad)", "ok");
}
const money2 = (n) => "C$ " + Number(n || 0).toFixed(2);
function totalConPropina(v) {
  if (v.detalle && typeof v.detalle.total === "number") return v.detalle.total;
  if (v.factura && typeof v.factura.total === "number") return v.factura.total + PRIORIDAD_EXTRA;
  return null;
}
function totalCobrar(v) {
  const f = v && v.factura; if (!f || typeof f.total !== "number") return null;
  const r2n = (n) => Math.round(n * 100) / 100;
  let base = f.total;
  try {
    if (v.sub && v.sub.items && v.sub.items.length) { const g = SubFactura.calcular(f, v.sub).gran; if (typeof g === "number" && isFinite(g)) base = g; }
  } catch (_) {}
  const propina = v.prioridad ? PRIORIDAD_EXTRA : 0, delivery = Number(f.delivery) || 0, extras = sumaExtras(v.extras);
  return { total: r2n(base + propina + extras), delivery: r2n(delivery), propina, extras: r2n(extras), compras: r2n(Math.max(0, base - delivery)) };
}

function escucharSubfactura(v) {
  const base = db.ref("pedidos/" + v.token);
  const f = base.child("factura"), s = base.child("subfactura"), dt = base.child("detalle"), pr = base.child("prioridad");
  f.on("value", (x) => { v.factura = x.val(); refrescarTextos(); }, () => {});
  s.on("value", (x) => { v.sub = x.val(); refrescarTextos(); }, () => {});
  dt.on("value", (x) => { v.detalle = x.val(); refrescarTextos(); }, () => {});
  pr.on("value", (x) => {
    const activa = x.val() === true, era = v.prioridad === true;
    v.prioridad = activa;
    if (activa && !era) alertaPrioridad(v.token, etiquetaWA(v));
    refrescarTextos();
  }, () => {});
  const ex = base.child("extras");
  ex.on("value", (x) => { v.extras = x.val(); refrescarTextos(); }, () => {});
  v.refExtra = [f, s, dt, pr, ex];
}
const ctxSub = { db, usuario: () => usuario, wa: (m) => abrirWhatsApp(m), alCambiar: () => refrescarTextos() };

function escucharEstado(v) {
  v.refEstado = db.ref("pedidos/" + v.token + "/estado");
  v.refEstado.on("value", (s) => {
    const e = s.val();
    if (!e || e === "en_ruta" || !viajes[v.token] || v.cerrando) return;
    const quien = nombreDe(v), txt = e === "entregado" ? `Brothers marcó como entregado el pedido de ${quien}.` : `El pedido de ${quien} fue cancelado.`;
    quitarViaje(v.token);
    setEstado(txt, "ok");
    Voz.hablar(txt, { forzar: true });
    notificarTexto("Brothers", txt, "Pedido", { equipo: "guia" });
    if (!document.hidden) alert(txt);
  }, () => {});
}

function sincronizarContactos() {
  Factura.contactos = orden.filter((t) => viajes[t] && viajes[t].sinFactura).map((t) => ({ token: t, pedido: viajes[t].pedido, cliente: viajes[t].cliente }));
  Factura.refrescarContactos();
}
function contarFactura(f) {
  const inc = (n) => firebase.database.ServerValue.increment(Number(n) || 0);
  db.ref(`estadisticas/${Dia.clave()}/${uidActual}`).update({ facturas: inc(1), total: inc(f.total), delivery: inc(f.delivery), nombre: usuario }).catch(() => {});
}

Factura.alEnviar = (f) => {
  if (!uidActual || !usuario) return;
  contarFactura(f);
  const ex = viajes[f.token];
  if (ex) {
    ex.sinFactura = false; ex.cliente = f.cliente || ex.cliente; ex.pedido = f.pedido;
    ex.factura = SubFactura.instantanea(f);
    db.ref("pedidos/" + f.token).update({ pedido: f.pedido, sinFactura: null, factura: ex.factura, detalle: detalleDeFactura(f, ex.prioridad === true) }).catch(() => {});
    guardarViajes(); sincronizarContactos(); renderLista();
    seleccionado = f.token; irA("mapa"); seleccionar(f.token, false);
    setTimeout(() => { seguirme = true; Camara.setModo("fitbounds"); Camara.refrescarBoton(); Camara.actualizar(true); }, 400);
    return;
  }
  if (orden.length === 0) rastro = [];
  const v = crearViaje({ token: f.token, tel: f.tel, pedido: f.pedido, cliente: f.cliente });
  guardarViajes();
  db.ref("pedidos/" + f.token).set({
    estado: "en_ruta", pedido: f.pedido, inicio: TS,
    repartidorUid: uidActual, repartidorNombre: usuario, factura: SubFactura.instantanea(f), detalle: detalleDeFactura(f, false)
  }).catch((e) => {
    quitarViaje(f.token);
    alert("No se pudo activar el seguimiento: " + e.message);
  });
  seleccionado = v.token;
  sincronizarContactos();
  irA("mapa");
  seleccionar(v.token, false);
  setTimeout(() => { seguirme = true; Camara.setModo("fitbounds"); Camara.refrescarBoton(); Camara.actualizar(true); }, 400);
};

function pulsarMarca(m) {
  const e = m && m.getElement && m.getElement(); if (!e) return;
  e.classList.remove("pin-actualizado"); void e.offsetWidth; e.classList.add("pin-actualizado");
  setTimeout(() => e.classList.remove("pin-actualizado"), 1100);
}

const PedidoRep = (() => {
  const ACTIVO = ["pendiente", "asignado", "retirado"];
  let id = null, datos = null, prio = false, prioPed = false, facturada = false, refs = [], cli = null, marca = null;
  let noLeidos = 0, chatListo = false;

  function precioDelivery(o) {
    try { if (typeof Ordenes !== "undefined" && typeof Ordenes.totalDelivery === "function") { const t = Number(Ordenes.totalDelivery(o)); if (Number.isFinite(t)) return t; } } catch (_) {}
    return Math.round(((Number(o.delivery) || 0) + (Number(o.iva) || 0)) * 100) / 100;
  }
  const prioridad = () => prio || prioPed;
  const aceptado = () => !!(datos && datos.estado_asignacion === "aceptado" && ACTIVO.includes(datos.estado));
  const nombre = () => (datos && datos.cliente) || "Cliente";

  function seguir(nuevo) {
    if (!nuevo || nuevo === id) return;
    soltar();
    id = nuevo;
    const escuchar = (ref, cb) => { ref.on("value", cb, () => {}); refs.push(ref); };
    escuchar(db.ref("ordenes/" + nuevo), (s) => {
      if (id !== nuevo) return;
      const d = s.val();
      const ajeno = d && d.asignacion && d.asignacion.tipo === "registrado" && d.asignacion.uid && d.asignacion.uid !== uidActual;
      if (!d || ajeno || ["entregado", "cancelado"].includes(d.estado)) return soltar();
      datos = d; prio = d.prioridad === true;
      pintarBoton(); alCambiarPrioridad(); pintarCliente();
      renderLista();
      try { ChatsEntrantes.marcarConPedido(); } catch (_) {}
      if (abrirPendiente === nuevo) { abrirPendiente = null; irA("mapa"); abrirChatPedido(); }
    });
    escuchar(db.ref("pedidos/" + nuevo + "/cliente"), (s) => aplicarCliente(s.val()));
    escuchar(db.ref("pedidos/" + nuevo + "/prioridad"), (s) => { prioPed = s.val() === true; alCambiarPrioridad(); });
    escuchar(db.ref("pedidos/" + nuevo + "/factura"), (s) => { facturada = s.val() != null; pintarBoton(); });
    chatListo = false; noLeidos = 0;
    const rc = db.ref("chats/" + nuevo).limitToLast(1);
    rc.on("child_added", (s) => { if (chatListo && id === nuevo) alMensajeChat(s.key, s.val()); }, () => {});
    rc.once("value", () => { chatListo = true; });
    refs.push(rc);
  }
  function soltar() {
    refs.forEach((r) => r.off()); refs = [];
    const hubo = !!id, viejo = id;
    if (viejo && chatToken === viejo && !viajes[viejo]) { try { Chat.detener(); } catch (_) {} chatToken = null; }
    id = null; datos = null; prio = false; prioPed = false; facturada = false; cli = null; noLeidos = 0; chatListo = false;
    if (mapa && marca) { mapa.removeLayer(marca); }
    marca = null;
    try { if (hubo && Factura.enModoPedido()) Factura.salirModoPedido(true); } catch (_) {}
    pintarBoton();
    if (hubo) { try { renderLista(); actualizarNav(); } catch (_) {} }
  }
  const chatDisponible = () => !!(uidActual && usuario && id && datos && ACTIVO.includes(datos.estado) && datos.estado_asignacion !== "rechazado");
  const codigoApp = () => etiquetaPedido(datos && datos.codigo, "app");
  function pintarBadgeChat() {
    const b = $("bdAdm"); if (b) { b.textContent = noLeidos; b.classList.toggle("oculto", !noLeidos); }
    actualizarNav();
  }
  function alMensajeChat(key, m) {
    if (!m || !id || m.sistema) return;
    if (m.de === "repartidor") { avisarAlAdminChat({ clave: id + "|" + key, texto: m.texto, foto: !m.texto, nombreRepartidor: usuario, pedido: datos && datos.codigo, cliente: nombre(), equipo: false }); return; }
    if (m.de !== "cliente") return;
    Voz.hablar(orden.length && datos && datos.cliente ? `El cliente ${datos.cliente} te ha escrito` : Voz.FRASES.mensajeCliente);
    navigator.vibrate && navigator.vibrate(200);
    if (chatToken !== id || document.hidden) notificarTexto("Cliente · " + nombre(), m.texto ? m.texto : "📷 Te envió una foto", "Pedido " + codigoApp(), { token: id });
    if (chatToken !== id) { noLeidos++; pintarBadgeChat(); }
  }
  function abrirChatPedido() {
    if (!chatDisponible()) return;
    const mio = id;
    cancelarNotif({ token: mio });
    Chat.iniciar({
      token: mio, yo: "repartidor", pedido: datos.codigo, nombreRepartidor: usuario, avisos: false,
      titulo: () => "Chat con " + ((datos && datos.cliente) || "el cliente"),
      subtitulo: () => "Pedido " + codigoApp(),
      alCerrar: () => { if (chatToken === mio) chatToken = null; }
    });
    chatToken = mio; noLeidos = 0; pintarBadgeChat();
    Chat.abrir();
  }
  function responderRapido(texto) {
    if (!id || !texto) return;
    Chat.enviarA(id, "repartidor", { pedido: datos && datos.codigo, nombreRepartidor: usuario }, String(texto).slice(0, 600), null).catch(() => {});
  }
  function htmlChat() {
    if (!chatDisponible()) return "";
    return `<div class="pedido-card"><div class="pc-top"><span class="pc-num">💬</span><div class="pc-datos"><strong>${escHtml(nombre())}</strong><small>Pedido ${escHtml(codigoApp())} · chat con el cliente</small></div></div>
      <div class="pc-botones" style="grid-template-columns:1fr"><button class="boton-chat" data-adm="chat" type="button">💬 Abrir chat con el cliente <span class="badge${noLeidos ? "" : " oculto"}" id="bdAdm">${noLeidos}</span></button></div></div>`;
  }
  function alClick(e) {
    const b = e.target.closest && e.target.closest('button[data-adm="chat"]'); if (!b) return false;
    abrirChatPedido(); return true;
  }
  function aplicarCliente(c) {
    const antes = cli;
    cli = c && typeof c.lat === "number" && typeof c.lng === "number" ? { lat: c.lat, lng: c.lng, manual: !!c.manual, ts: c.ts || 0 } : null;
    pintarCliente();
    if (cli && (!antes || antes.lat !== cli.lat || antes.lng !== cli.lng)) {
      pulsarMarca(marca);
      if (antes && !document.hidden) setEstado("📍 " + nombre() + " actualizó su ubicación", "ok");
    }
  }
  function pintarCliente() {
    if (!mapa) return;
    if (!cli || !id) { if (marca) { mapa.removeLayer(marca); marca = null; } return; }
    const p = [cli.lat, cli.lng], vivo = !cli.manual && !!cli.ts && Date.now() - cli.ts < FRESCO_MS, clave = [nombre(), vivo].join("|");
    if (!marca) { marca = L.marker(p, { icon: iconoCliente("👤", nombre(), true, vivo), zIndexOffset: 850 }).addTo(mapa); marca._clave = clave; }
    else {
      marca.setLatLng(p);
      if (marca._clave !== clave) { marca.setIcon(iconoCliente("👤", nombre(), true, vivo)); marca._clave = clave; }
    }
  }
  function alCambiarPrioridad() {
    try { if (Factura.enModoPedido()) Factura.recalcular(); } catch (_) {}
    if (facturada && prioridad()) sumarPrioridadAlDetalle();
  }
  async function sumarPrioridadAlDetalle() {
    const mio = id; if (!mio) return;
    try {
      const ref = db.ref("pedidos/" + mio + "/detalle"), d = (await ref.once("value")).val();
      if (!d || d.prioridad || id !== mio) return;
      const base = typeof d.totalBase === "number" ? d.totalBase : Number(d.total) || 0;
      const total = Math.round((base + PRIORIDAD_EXTRA) * 100) / 100;
      await ref.update({ prioridad: PRIORIDAD_EXTRA, total });
      db.ref("ordenes/" + mio + "/facturaResumen").update({ prioridad: PRIORIDAD_EXTRA, total }).catch(() => {});
    } catch (_) {}
  }
  function pintarBoton() {
    const caja = document.querySelector("#vistaMapa .mapa-caja"); if (!caja) return;
    let b = $("btnCrearFactura");
    if (!(uidActual && usuario && aceptado())) { if (b) b.remove(); return; }
    if (!b) {
      b = document.createElement("button");
      b.id = "btnCrearFactura"; b.type = "button"; b.className = "btn-crear-factura";
      b.onclick = abrirFactura;
      caja.appendChild(b);
    }
    b.disabled = facturada;
    b.innerHTML = facturada ? '<span aria-hidden="true">✅</span> Factura enviada' : '<span aria-hidden="true">🧾</span> Crear Factura';
    b.setAttribute("aria-label", facturada ? "La factura ya fue enviada al cliente" : "Crear factura del pedido " + ((datos && datos.codigo) ? etiquetaPedido(datos.codigo, "app") : ""));
  }
  function abrirFactura() {
    if (!aceptado() || !datos) return;
    if (facturada) return alert("Este pedido ya tiene su factura enviada al cliente.");
    Factura.prepararPedido({ id, codigo: datos.codigo || id, cliente: datos.cliente || "", delivery: precioDelivery(datos) });
    irA("factura");
  }
  async function enviarFactura(f) {
    if (!uidActual || !usuario) throw new Error("Tu sesión no está activa.");
    if (!id || f.token !== id || !aceptado()) throw new Error("Este pedido ya no está en curso.");
    const mio = id, conPrio = (Number(f.prioridad) || 0) > 0 || prioridad();
    const detalle = detalleDeFactura(f, conPrio);
    const datosFactura = JSON.parse(JSON.stringify({ pedido: f.pedido, factura: SubFactura.instantanea(f), detalle }));
    const estado = (await db.ref("pedidos/" + mio + "/estado").once("value")).val();
    if (!estado) Object.assign(datosFactura, { estado: "en_ruta", inicio: TS, repartidorUid: uidActual, repartidorNombre: usuario });
    await db.ref("pedidos/" + mio).update(datosFactura);
    if (id === mio) { facturada = true; pintarBoton(); }
    contarFactura(f);
    db.ref("ordenes/" + mio + "/facturaResumen").set({
      total: detalle.total, subtotal: Number(f.subtotal) || 0, delivery: Number(f.delivery) || 0, prioridad: detalle.prioridad || 0,
      items: (f.productos || []).length, deposito: !!f.deposito, ts: TS, repartidor: usuario
    }).catch(() => {});
    navigator.vibrate && navigator.vibrate(120);
    return true;
  }
  return {
    seguir, soltar, pintarCliente, pintarBoton, posCliente: () => cli, prioridadExtra: () => (aceptado() && prioridad() ? PRIORIDAD_EXTRA : 0), enviarFactura,
    htmlChat, alClick, abrirChat: abrirChatPedido, responderRapido, noLeidos: () => noLeidos, esMio: (t) => !!id && t === id,
    info: () => (chatDisponible() ? { cliente: nombre(), codigo: codigoApp() } : null),
    id: () => id,
    meta: () => (id && datos ? { token: id, cliente: nombre(), codigo: codigoApp() } : null)
  };
})();
Factura.alEnviarPedido = (f) => PedidoRep.enviarFactura(f);
Factura.alTerminarPedido = () => irA("mapa");
Factura.prioridadExtra = () => PedidoRep.prioridadExtra();

const FacturaVivo = (() => {
  let tokenSel = null, ref = null, datos = null;
  const r2 = (n) => Math.round(n * 100) / 100;
  const lst = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
  const tokens = () => { const l = orden.slice(), m = PedidoRep.meta(); if (m && !l.includes(m.token)) l.push(m.token); return l; };
  function nombreTok(t) {
    const v = viajes[t]; if (v) return nombreDe(v) + " · " + etiquetaWA(v);
    const m = PedidoRep.meta(); if (m && m.token === t) return m.cliente + " · " + m.codigo;
    return "Pedido";
  }
  function aviso(txt, tipo) { const e = $("fvAviso"); e.textContent = txt || ""; e.className = "estado " + (tipo || "") + (txt ? "" : " oculto"); }
  function calc(d) {
    if (!d) return null;
    const f = d.factura && typeof d.factura === "object" ? d.factura : null, det = d.detalle && typeof d.detalle === "object" ? d.detalle : null;
    const fuente = det || f; if (!fuente) return null;
    const productos = lst(fuente.productos).map((p) => ({ nombre: String((p && p.nombre) || "Producto"), precio: Number(p && p.precio) || 0 }));
    const delivery = Number(fuente.delivery) || 0;
    const subtotal = fuente.subtotal != null ? Number(fuente.subtotal) || 0 : productos.reduce((a, p) => a + p.precio, 0);
    const base = det
      ? (det.totalBase != null ? Number(det.totalBase) || 0 : Math.max(0, (Number(det.total) || 0) - (Number(det.prioridad) || 0)))
      : (f.total != null ? Number(f.total) || 0 : subtotal + delivery);
    const prio = d.prioridad === true || (det && Number(det.prioridad) > 0) ? PRIORIDAD_EXTRA : 0;
    const extras = Object.entries(d.extras && typeof d.extras === "object" ? d.extras : {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, e]) => ({ k, monto: Number(e && e.monto) || 0, nota: String((e && e.nota) || "") }));
    const extrasTotal = extras.reduce((a, e) => a + e.monto, 0);
    return { productos, subtotal, delivery, prio, extras, extrasTotal, total: r2(base + prio + extrasTotal) };
  }
  const activo = (d) => !!d && (!d.estado || d.estado === "en_ruta");
  function pintar() {
    const cont = $("fvResumen"), c = calc(datos);
    $("fvForm").classList.toggle("oculto", !(c && activo(datos)));
    if (!datos) { cont.innerHTML = '<p class="ayuda">Cargando factura…</p>'; return; }
    if (!c) { cont.innerHTML = '<div class="fv-banner"><b>' + escHtml(nombreTok(tokenSel)) + '</b></div><p class="ayuda">Este pedido aún no tiene factura. Genera y envía la factura para ver el total y agregar mandados extra.</p>'; return; }
    let h = '<div class="fv-banner"><b>' + escHtml(nombreTok(tokenSel)) + '</b><small>' + (activo(datos) ? "En ruta · actualizado en vivo" : "Pedido cerrado") + "</small></div>";
    if (c.productos.length) h += '<div class="fv-sec">Productos</div>' + c.productos.map((p) => '<div class="fv-fila"><span>' + escHtml(p.nombre) + "</span><b>" + money2(p.precio) + "</b></div>").join("");
    h += '<div class="fv-fila fv-sub"><span>Total compras</span><b>' + money2(c.subtotal) + "</b></div>";
    h += '<div class="fv-fila"><span>🛵 Costo del delivery</span><b>' + money2(c.delivery) + "</b></div>";
    if (c.prio) h += '<div class="fv-fila fv-pri"><span>⚡ Prioridad (propina)</span><b>' + money2(c.prio) + "</b></div>";
    if (c.extras.length) {
      h += '<div class="fv-sec">Mandados extra (' + c.extras.length + ")</div>";
      h += c.extras.map((e) => '<div class="fv-fila fv-ex"><span>➕ ' + escHtml(e.nota || "Mandado extra") + "</span><b>" + money2(e.monto) + '</b>' +
        (activo(datos) ? '<button type="button" class="fv-del" data-del="' + escHtml(e.k) + '" aria-label="Quitar este mandado extra">✕</button>' : "") + "</div>").join("");
      h += '<div class="fv-fila fv-sub"><span>Total mandados extra</span><b>' + money2(c.extrasTotal) + "</b></div>";
    }
    h += '<div class="fv-total"><span>Total a cobrar</span><b>' + money2(c.total) + "</b></div>";
    cont.innerHTML = h;
  }
  function pintarSel() {
    const l = tokens(), s = $("fvSel");
    s.innerHTML = l.map((t) => '<option value="' + escHtml(t) + '">' + escHtml(nombreTok(t)) + "</option>").join("");
    if (tokenSel) s.value = tokenSel;
    s.classList.toggle("oculto", l.length < 2);
  }
  function soltar() { if (ref) { ref.off(); ref = null; } }
  function escuchar() {
    soltar(); datos = null; pintar();
    ref = db.ref("pedidos/" + tokenSel);
    ref.on("value", (s) => { datos = s.val() || {}; pintar(); }, () => aviso("No se pudo leer la factura. Revisa tu internet.", "error"));
  }
  function abrir(t) {
    const l = tokens();
    if (!l.length) return alert("No tienes pedidos en curso. Cuando generes una factura o aceptes un pedido, aquí verás su detalle en vivo.");
    tokenSel = t && l.includes(t) ? t : (l.includes(seleccionado) ? seleccionado : l[0]);
    aviso(""); $("fvMonto").value = ""; $("fvNota").value = "";
    pintarSel(); escuchar();
    $("modalFacturaVivo").classList.remove("oculto");
  }
  function cerrar() { soltar(); $("modalFacturaVivo").classList.add("oculto"); }
  function agregar() {
    const t = tokenSel;
    if (!t || !calc(datos) || !activo(datos)) return aviso("Primero envía la factura de este pedido.", "error");
    const monto = r2(Number($("fvMonto").value));
    if (!(monto > 0)) return aviso("Escribe un monto mayor a 0.", "error");
    if (monto > 100000) return aviso("Ese monto es demasiado alto.", "error");
    const nota = $("fvNota").value.trim().slice(0, 80);
    const reg = { monto, ts: TS, por: usuario || "" }; if (nota) reg.nota = nota;
    db.ref("pedidos/" + t + "/extras").push(reg).catch((e) => aviso("No se pudo guardar el mandado extra: " + e.message, "error"));
    $("fvMonto").value = ""; $("fvNota").value = "";
    navigator.vibrate && navigator.vibrate(80);
    aviso("Mandado extra de " + money2(monto) + " agregado ✓ El cliente ya lo ve.", "ok");
  }
  { const bfv = $("btnFacturaVivo"); if (bfv) bfv.onclick = () => abrir(); }
  $("btnFvCerrar").onclick = cerrar;
  $("btnFvAgregar").onclick = agregar;
  $("fvSel").onchange = (e) => { tokenSel = e.target.value; aviso(""); escuchar(); };
  $("fvRapidos").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) { $("fvMonto").value = b.dataset.m; $("fvMonto").focus(); } };
  $("fvResumen").onclick = (e) => {
    const b = e.target.closest("button[data-del]"); if (!b || !tokenSel) return;
    if (!confirm("¿Quitar este mandado extra de la factura?")) return;
    db.ref("pedidos/" + tokenSel + "/extras/" + b.dataset.del).remove().catch((err) => aviso("No se pudo quitar: " + err.message, "error"));
  };
  $("fvMonto").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); agregar(); } });
  $("modalFacturaVivo").addEventListener("click", (e) => { if (e.target === $("modalFacturaVivo")) cerrar(); });
  new MutationObserver(() => { if ($("modalFacturaVivo").classList.contains("oculto")) soltar(); }).observe($("modalFacturaVivo"), { attributes: true, attributeFilter: ["class"] });
  return { abrir, cerrar };
})();

function reanudarViajes() {
  let guardados = [];
  try { guardados = JSON.parse(localStorage.getItem("viajesActivos") || "[]"); } catch (_) {}
  try {
    const viejo = JSON.parse(localStorage.getItem("viajeActivo") || "null");
    if (viejo && viejo.token && !guardados.some((g) => g.token === viejo.token)) guardados.push(viejo);
    localStorage.removeItem("viajeActivo");
  } catch (_) {}
  guardados.filter((g) => g.uid === uidActual && !viajes[g.token]).forEach((g) => {
    const v = crearViaje(g);
    db.ref("pedidos/" + g.token).once("value").then((s) => {
      const d = s.val();
      if (!d || d.estado !== "en_ruta") return quitarViaje(g.token);
      if (d.pedido) v.pedido = d.pedido;
      if (typeof d.destLat === "number" && !v.destino) v.destino = { lat: d.destLat, lng: d.destLng };
      v.cerca = d.cerca === true;
      pintarCliente(v); renderLista(); refrescarTextos();
    }).catch(() => {});
  });
  sincronizarContactos();
  if (orden.length) {
    seleccionado = orden[0]; renderLista();
    if (abrirPendiente && viajes[abrirPendiente]) { const v0 = viajes[abrirPendiente]; abrirPendiente = null; irA("mapa"); abrirChat(v0); }
    try { const r = JSON.parse(localStorage.getItem("rastroViaje") || "null"); if (r && r.uid === uidActual && Array.isArray(r.pts)) rastro = r.pts; } catch (_) {}
    seguirme = true;
    Camara.setModo("fitbounds");
    Camara.refrescarBoton();
    setTimeout(() => Camara.actualizar(true), 800);
  }
  try { ChatsEntrantes.marcarConPedido(); } catch (_) {}
  actualizarNav();
}

function soltarViajesEnMemoria() {
  orden.forEach((t) => { const v = viajes[t]; if (!v) return; v.refCli && v.refCli.off(); v.refChat && v.refChat.off(); v.refEstado && v.refEstado.off(); (v.refExtra || []).forEach((r) => r.off()); if (mapa) { v.marca && mapa.removeLayer(v.marca); v.marcaCli && mapa.removeLayer(v.marcaCli); } delete viajes[t]; });
  orden = []; seleccionado = null; chatToken = null; rastro = [];
  try { Chat.detener(); } catch (_) {}
  renderLista(); actualizarNav();
}

let ultGuardadoRastro = 0;
function guardarRastro() {
  const n = Date.now(); if (n - ultGuardadoRastro < 10000) return; ultGuardadoRastro = n;
  try { localStorage.setItem("rastroViaje", JSON.stringify({ uid: uidActual, pts: rastro.slice(-800) })); } catch (_) {}
}
function quitarViaje(token) {
  const v = viajes[token]; if (!v) return;
  v.refCli && v.refCli.off(); v.refChat && v.refChat.off(); v.refEstado && v.refEstado.off(); (v.refExtra || []).forEach((r) => r.off());
  if (chatToken === token) { Chat.detener(); chatToken = null; }
  if (mapa) { v.marca && mapa.removeLayer(v.marca); v.marcaCli && mapa.removeLayer(v.marcaCli); }
  delete viajes[token];
  orden = orden.filter((t) => t !== token);
  if (seleccionado === token) seleccionado = orden[0] || null;
  if (!orden.length) { rastro = []; try { localStorage.removeItem("rastroViaje"); } catch (_) {} if (estelaProp) estelaProp.setLatLngs([]); }
  guardarViajes(); sincronizarContactos();
  orden.forEach((t) => pintarCliente(viajes[t]));
  renderLista(); dibujarRuta(); actualizarNav();
  try { ChatsEntrantes.marcarConPedido(); } catch (_) {}
  if (!orden.length && vistaActual === "mapa") irA("factura");
  else if (mapa && vistaActual === "mapa" && Camara.getModo() === "fitbounds") { seguirme = true; Camara.actualizar(true); }
}

function escucharCliente(v) {
  v.refCli = db.ref("pedidos/" + v.token + "/cliente");
  v.refCli.on("value", (s) => {
    const c = s.val(), antes = v.cliPos;
    v.cliPos = c && typeof c.lat === "number" ? { lat: c.lat, lng: c.lng, manual: !!c.manual, ts: c.ts || 0, precision: c.precision || 0 } : null;
    if (v.cliPos && !v.destManual) v.destino = { lat: v.cliPos.lat, lng: v.cliPos.lng };
    pintarCliente(v);
    if (v.cliPos && (!antes || antes.lat !== v.cliPos.lat || antes.lng !== v.cliPos.lng)) pulsarMarca(v.destManual ? v.marcaCli : v.marca);
    if (v.token === seleccionado) { dibujarRuta(); pedirRuta(v); }
    evaluarViaje(v);
    refrescarTextos();
  }, () => {});
}

function evaluarViaje(v, base) {
  const cambios = base ? Object.assign({}, base) : {};
  let dispararCerca = false;
  if (v.destino) {
    cambios.destLat = v.destino.lat; cambios.destLng = v.destino.lng;
    if (ultimaPos) {
      const dist = Math.round(distanciaM(ultimaPos.lat, ultimaPos.lng, v.destino.lat, v.destino.lng));
      v.dist = dist; cambios.distancia = dist;
      if (dist <= RADIO_AVISO_M && !v.cerca) { v.cerca = true; cambios.cerca = true; cambios.cercaTs = TS; dispararCerca = true; }
      else if (v.cerca && dist > RADIO_AVISO_M * 2) { v.cerca = false; cambios.cerca = false; }
    }
  }
  if (!Object.keys(cambios).length) return;
  db.ref("pedidos/" + v.token).update(cambios).then(() => {
    if (dispararCerca) { navigator.vibrate && navigator.vibrate([300, 150, 300]); refrescarTextos(); }
  }).catch((e) => {
    if (dispararCerca) v.cerca = false;
    setEstado("Error de red: " + e.message, "error");
  });
}

function escucharChat(v) {
  v.refChat = db.ref("chats/" + v.token).limitToLast(1);
  v.chatListo = false;
  v.refChat.on("child_added", (s) => {
    if (!v.chatListo) return;
    const m = s.val();
    if (m && m.de === "repartidor") avisarAlAdminChat({ clave: v.token + "|" + s.key, texto: m.texto, foto: !m.texto, nombreRepartidor: usuario, pedido: v.pedido, cliente: v.cliente, equipo: false });
    if (!m || m.de !== "cliente") return;
    Voz.hablar(orden.length > 1 && v.cliente ? `El cliente ${v.cliente} te ha escrito` : Voz.FRASES.mensajeCliente);
    navigator.vibrate && navigator.vibrate(200);
    if (chatToken !== v.token || document.hidden) notificarMensaje(v, m);
    if (chatToken !== v.token) { v.noLeidos++; refrescarTextos(); actualizarNav(); }
  }, () => {});
  v.refChat.once("value", () => { v.chatListo = true; });
}
function abrirChat(v) {
  cancelarNotif({ token: v.token });
  Chat.iniciar({
    token: v.token, yo: "repartidor", pedido: v.pedido, nombreRepartidor: usuario, avisos: false,
    titulo: () => "Chat con " + (v.cliente || "el cliente"),
    subtitulo: () => "Pedido " + etiquetaWA(v),
    alCerrar: () => { chatToken = null; }
  });
  chatToken = v.token; v.noLeidos = 0;
  Chat.abrir();
  refrescarTextos(); actualizarNav();
}

function pintarBadgeAdmin() {
  const b = $("badgeAdmin"); b.textContent = noLeidosAdmin; b.classList.toggle("oculto", !noLeidosAdmin);
}
function abrirChatAdmin() {
  cancelarNotif({ equipo: "chat" });
  Chat.iniciar({
    token: uidActual, yo: "repartidor", ruta: RUTA_EQUIPO, pedido: "Equipo", nombreRepartidor: usuario, avisos: false,
    titulo: () => "Brothers (administración)", subtitulo: () => usuario || "",
    alCerrar: () => { chatToken = null; }
  });
  chatToken = "equipo"; noLeidosAdmin = 0; pintarBadgeAdmin();
  Chat.abrir();
}
$("btnChatAdmin").onclick = abrirChatAdmin;
function soltarAdmin() {
  Policia.detener();
  if (refAdminChat) { refAdminChat.off(); refAdminChat = null; }
  if (refGuia) { refGuia.off(); refGuia = null; }
  if (refLugares) { refLugares.off(); refLugares = null; }
  lugares = {}; pintarLugares(); quitarLugarDestino();
  OrdenAdminRep.detener();
  PedidoRep.soltar();
  guiaActual = null; guiaTsVisto = undefined; noLeidosAdmin = 0; pintarBadgeAdmin(); pintarGuia();
}
function escucharAdmin() {
  soltarAdmin();
  adminListo = false;
  refAdminChat = db.ref(`chatsEquipo/${uidActual}`).limitToLast(1);
  refAdminChat.on("child_added", (s) => {
    if (!adminListo) return;
    const m = s.val();
    if (m && m.de === "repartidor") avisarAlAdminChat({ clave: "equipo|" + s.key, texto: m.texto, foto: !m.texto, nombreRepartidor: usuario, equipo: true });
    if (!m || m.de !== "admin") return;
    Voz.hablar(Voz.FRASES.mensajeAdmin);
    navigator.vibrate && navigator.vibrate(200);
    if (chatToken !== "equipo" || document.hidden) notificarTexto("Brothers", m.texto ? m.texto : "📷 Te envió una foto", "Administración", { equipo: "chat" });
    if (chatToken !== "equipo") { noLeidosAdmin++; pintarBadgeAdmin(); }
  }, () => {});
  refAdminChat.once("value", () => { adminListo = true; });

  Policia.iniciar({ db, mapa: () => mapa, uid: () => uidActual, nombre: () => usuario || "Repartidor", rol: "repartidor", pos: () => ultimaPos, alVer: () => irA("mapa") });
  if (refLugares) refLugares.off();
  refLugares = db.ref("lugares");
  refLugares.on("value", (s) => { lugares = s.val() || {}; pintarLugares(); if (!$("resBusqRep").classList.contains("oculto")) mostrarBusquedaRep(); }, () => {});

  refGuia = db.ref("guias/" + uidActual);
  refGuia.on("value", (s) => {
    const g = s.val(), primera = guiaTsVisto === undefined;
    if (g && g.ordenId) { OrdenAdminRep.seguir(g.ordenId); PedidoRep.seguir(g.ordenId); }
    if (!g || typeof g.lat !== "number") { guiaActual = null; guiaTsVisto = null; pintarGuia(); dibujarRuta(); return; }
    if (primera && g.ts && Date.now() - g.ts > 12 * 3600 * 1000) { guiaTsVisto = g.ts; return; }
    const nueva = !primera && g.ts !== guiaTsVisto;
    guiaTsVisto = g.ts;
    aplicarGuia(g, nueva);
  }, () => {});
}
const iconoGuia = L.divIcon({ className: "", html: '<div class="pin-cli sel"><b>🏠</b></div><span class="etq-cli">Cliente (Brothers)</span>', iconSize: [34, 34], iconAnchor: [17, 17] });
const guiaCliente = () => (guiaActual && guiaActual.tipo !== "negocio" ? guiaActual : null);
function pintarGuia() {
  if (!mapa) return;
  if (guiaCliente() && !orden.length) {
    const p = [guiaActual.lat, guiaActual.lng];
    if (!marcaGuia) marcaGuia = L.marker(p, { icon: iconoGuia, zIndexOffset: 700 }).addTo(mapa); else marcaGuia.setLatLng(p);
  } else if (marcaGuia) { mapa.removeLayer(marcaGuia); marcaGuia = null; }
}
function aplicarGuia(g, nueva) {
  guiaActual = g;
  if (g.tipo === "negocio") {
    irALugar({ nombre: g.negocio || g.nombre || "Negocio", lat: g.lat, lng: g.lng, icono: g.icono || "📍", producto: g.producto, etiqueta: !!g.ordenId, clase: g.punto === "entrega" ? "entrega" : "retiro" }, !!nueva);
    if (nueva && !g.ordenId) {
      const aviso = g.punto ? `Brothers te asignó un punto de ${g.punto}` : "Brothers te ha indicado la ubicación de " + (g.nombre || "un negocio");
      Voz.hablar(aviso, { forzar: true });
      navigator.vibrate && navigator.vibrate([300, 150, 300]);
      notificarTexto("Brothers", g.punto ? `Te asignó un punto de ${g.punto}` : "Te indicó la ubicación de " + (g.nombre || "un negocio"), "Guía", { equipo: "guia" });
    }
    return;
  }
  const v = (g.token && viajes[g.token]) || (orden.length === 1 ? viajes[orden[0]] : null) || (orden.length ? viajes[seleccionado] : null);
  if (v) fijarDestino(v, g.lat, g.lng);
  if (!v) irALugar({ nombre: "Cliente (Brothers)", lat: g.lat, lng: g.lng, icono: "🏠" }, !!nueva);
  pintarGuia(); dibujarRuta();
  if (!nueva) return;
  Voz.hablar(Voz.FRASES.guiaAdmin, { forzar: true });
  navigator.vibrate && navigator.vibrate([300, 150, 300]);
  notificarTexto("Brothers", "Te indicó la ubicación del cliente", "Guía", { equipo: "guia" });
  irA("mapa");
  if (v) seleccionar(v.token, true); else { seguirme = false; setTimeout(() => encuadrar(false), 200); }
}

function iconoLugarPlano(l, destacado) {
  const ico = escHtml(Array.from(String((l && l.icono) || "📍")).slice(0, 2).join(""));
  return L.divIcon({ className: "lg-plano-wrap", html: `<div class="lg-plano${destacado ? " dest" : ""}"><span class="lg-ic">${ico}</span><span class="lg-nom">${escHtml(String((l && l.nombre) || "").slice(0, 40))}</span></div>`, iconSize: [22, 22], iconAnchor: [11, 11] });
}
function pintarLugares() {
  if (!mapa) return;
  Object.keys(lugarMarks).forEach((id) => { if (!lugares[id]) { mapa.removeLayer(lugarMarks[id]); delete lugarMarks[id]; } });
  Object.entries(lugares).forEach(([id, l]) => {
    if (typeof l.lat !== "number") return;
    const clave = [l.nombre, l.icono].join("|");
    let m = lugarMarks[id];
    if (!m) {
      m = lugarMarks[id] = L.marker([l.lat, l.lng], { icon: iconoLugarPlano(l), pane: "paneLugares" });
      if (verNegociosRep) m.addTo(mapa);
      m._clave = clave;
      m.bindPopup(() => `<div class="pop-rep"><strong>${escHtml(l.icono || "📍")} ${escHtml(l.nombre)}</strong>${l.dir ? `<small>${escHtml(l.dir)}</small>` : ""}
        <div class="acciones-fila"><button class="mini pri" data-ir="${escHtml(id)}" type="button">🧭 Ir aquí</button></div></div>`, { offset: [0, -14], minWidth: 200 });
    } else { m.setLatLng([l.lat, l.lng]); if (m._clave !== clave) { m.setIcon(iconoLugarPlano(l)); m._clave = clave; } }
  });
}
let verNegociosRep = localStorage.getItem("verNegociosRep") !== "0";
function aplicarNegociosRep() {
  const b = $("btnVerNegociosRep");
  if (b) { b.classList.toggle("on", verNegociosRep); b.setAttribute("aria-pressed", String(verNegociosRep)); }
  if (!mapa) return;
  if (!verNegociosRep) mapa.closePopup();
  Object.values(lugarMarks).forEach((m) => { if (verNegociosRep) { if (!mapa.hasLayer(m)) m.addTo(mapa); } else mapa.removeLayer(m); });
}
$("btnVerNegociosRep").onclick = () => {
  verNegociosRep = !verNegociosRep;
  try { localStorage.setItem("verNegociosRep", verNegociosRep ? "1" : "0"); } catch (_) {}
  aplicarNegociosRep();
  setEstado(verNegociosRep ? "Negocios visibles en el mapa" : "Negocios ocultos del mapa", "ok");
};
aplicarNegociosRep();

let hojaOculta = false;
function aplicarHoja() {
  const h = $("hojaPedidos"), b = $("barraHoja"); if (!h || !b) return;
  h.classList.toggle("oculta", hojaOculta);
  b.setAttribute("aria-expanded", String(!hojaOculta));
  const n = orden.length + (OrdenAdminRep.activo() ? 1 : 0), res = OrdenAdminRep.resumen();
  const vsel = viajes[seleccionado]; $("barraHojaTxt").textContent = hojaOculta ? "▴ " + (res || (n ? "Mostrar pedido" + (vsel ? " · " + String(nombreDe(vsel)).slice(0, 22) : "") : "Mostrar panel")) : "▾ Ocultar pedido";
  const c = $("barraHojaCnt"); c.textContent = n; c.classList.toggle("oculto", !n);
  if (mapa) setTimeout(() => mapa.invalidateSize(), 80);
}
$("barraHoja").onclick = () => { hojaOculta = !hojaOculta; aplicarHoja(); };

function cerrarBusquedaRep() { $("resBusqRep").classList.add("oculto"); $("busqRep").blur(); }
function mostrarBusquedaRep(online) {
  const q = norm($("busqRep").value.trim()), caja = $("resBusqRep");
  const locales = Object.entries(lugares).filter(([, l]) => !q || norm(l.nombre + " " + (l.dir || "")).includes(q)).slice(0, 8);
  let html = '<div class="cerrar-res" data-k="__cerrar">✕ Cerrar búsqueda</div>' + locales.map(([id, l]) => `<div class="item-busq" data-k="l:${escHtml(id)}"><strong>${escHtml(l.icono || "📍")} ${escHtml(l.nombre)}</strong><small>${escHtml(l.dir || "Negocio de Brothers")}</small></div>`).join("");
  if (online) html += online.map((r, i) => `<div class="item-busq" data-k="o:${i}"><strong>${escHtml(r.nombre)}</strong><small>${escHtml(r.detalle || "")}</small></div>`).join("");
  if (q && !online) html += `<div class="item-busq" data-k="buscar"><strong>🔎 Buscar “${escHtml($("busqRep").value.trim())}” en todo el mapa</strong><small>Direcciones, barrios, ciudades, coordenadas…</small></div>`;
  caja.innerHTML = html || '<p class="ayuda">No hay negocios guardados todavía. Escribe para buscar en el mapa.</p>';
  caja.classList.remove("oculto");
}
$("busqRep").addEventListener("input", () => { resultadosRep = []; $("busqRep").value ? mostrarBusquedaRep() : $("resBusqRep").classList.add("oculto"); });
$("busqRep").addEventListener("focus", () => mostrarBusquedaRep());
$("formBusqRep").onsubmit = (e) => { e.preventDefault(); buscarEnMapa(); };
async function buscarEnMapa() {
  const q = $("busqRep").value.trim(); if (!q) return;
  $("resBusqRep").innerHTML = '<p class="ayuda">Buscando…</p>';
  try { resultadosRep = await Buscar.buscar(q, mapa && mapa.getBounds()); mostrarBusquedaRep(resultadosRep); }
  catch (err) { $("resBusqRep").innerHTML = `<p class="ayuda">No se pudo buscar: ${escHtml(err.message)}</p>`; }
}
$("resBusqRep").onclick = (e) => {
  const it = e.target.closest("[data-k]"); if (!it) return;
  const k = it.dataset.k;
  if (k === "__cerrar") return cerrarBusquedaRep();
  if (k === "buscar") return buscarEnMapa();
  if (k.startsWith("l:")) return irALugar(lugares[k.slice(2)], true);
  const r = resultadosRep[+k.slice(2)]; if (r) irALugar({ nombre: r.nombre, lat: r.lat, lng: r.lng, icono: "📍" }, true);
};
function irALugar(l, enfocar) {
  if (!l) return;
  lugarDestino = { nombre: l.nombre, lat: l.lat, lng: l.lng, icono: l.icono || "📍", producto: l.producto || "", etiqueta: !!l.etiqueta, clase: l.clase || "retiro" }; rutaLugar = null;
  $("resBusqRep").classList.add("oculto"); $("busqRep").blur();
  if (enfocar && vistaActual !== "mapa") irA("mapa");
  initMapa(); pintarLugarDestino();
  if (enfocar) { seguirme = false; mapa.flyTo([l.lat, l.lng], 16); }
  pedirRutaLugar(true); actualizarBanner();
}
function pintarLugarDestino() {
  if (!mapa) return;
  if (!lugarDestino) { if (marcaLugar) { mapa.removeLayer(marcaLugar); marcaLugar = null; } return; }
  const p = [lugarDestino.lat, lugarDestino.lng];
  const ic = lugarDestino.etiqueta ? Ordenes.pinEtiqueta(lugarDestino.clase, lugarDestino.icono, lugarDestino.nombre, lugarDestino.producto) : iconoLugarPlano(lugarDestino, true);
  if (!marcaLugar) marcaLugar = L.marker(p, { icon: ic, zIndexOffset: 900 }).addTo(mapa); else { marcaLugar.setLatLng(p); marcaLugar.setIcon(ic); }
}
function quitarLugarDestino() {
  lugarDestino = null; rutaLugar = null;
  if (capaLugar) capaLugar.setLatLngs([]);
  if (flechasLugar) flechasLugar.clearLayers();
  pintarLugarDestino(); actualizarBanner();
}
async function pedirRutaLugar(forzar) {
  if (!lugarDestino || !ultimaPos) return;
  const r0 = rutaLugar, ahora = Date.now();
  if (!forzar && r0 && (ahora - r0.rutaEn < 15000 || distanciaM(ultimaPos.lat, ultimaPos.lng, r0.rutaOrigen.lat, r0.rutaOrigen.lng) < 60)) return;
  const o = { lat: ultimaPos.lat, lng: ultimaPos.lng }, destino = lugarDestino;
  if (!rutaLugar) rutaLugar = { rutaEn: ahora, rutaOrigen: o, rutaPts: null };
  rutaLugar.rutaEn = ahora; rutaLugar.rutaOrigen = o;
  try {
    const r = await Ordenes.rutaCalles(o, destino);
    if (lugarDestino !== destino) return;
    if (!r) throw new Error("sin ruta");
    rutaLugar.rutaFallo = false;
    Object.assign(rutaLugar, { rutaPts: r.pts, rutaPasos: r.pasos, rutaDur: r.dur, rutaDist: r.dist, rutaIdx: 0 });
    Ruta.flechas(r.pts, flechasLugar, "#B45309");
  } catch (_) {
    if (rutaLugar) { rutaLugar.rutaFallo = true; rutaLugar.rutaEn = ahora - 12000; rutaLugar.rutaOrigen = { lat: 0, lng: 0 }; }
    if (!pedirRutaLugar._t) pedirRutaLugar._t = setTimeout(() => { pedirRutaLugar._t = null; if (lugarDestino) pedirRutaLugar(true); }, 3000);
  }
  dibujarRutaLugar(); actualizarBanner();
}
function dibujarRutaLugar() {
  if (!capaLugar) return;
  if (!lugarDestino || !ultimaPos) return capaLugar.setLatLngs([]);
  const aqui = [ultimaPos.lat, ultimaPos.lng];
  capaLugar.setLatLngs(rutaLugar && rutaLugar.rutaPts ? [aqui, ...rutaLugar.rutaPts] : []);
  capaLugar.setStyle({ opacity: rutaLugar && rutaLugar.rutaPts ? .9 : .5 });
}

/* ============================================================
   FASE 2 · BANNER TURN-BY-TURN
   ============================================================ */
function actualizarBanner() {
  const b = $("bannerRuta"); if (!b) return;
  const n = lugarDestino ? rutaLugar : viajes[seleccionado];
  const titulo = lugarDestino ? `${lugarDestino.icono} ${lugarDestino.nombre}` : (n ? "👤 " + nombreDe(n) : "");
  if (!lugarDestino && !(n && n.destino)) { b.classList.add("oculto"); return; }
  b.classList.remove("oculto");
  const cerrar = lugarDestino ? '<button id="brX" type="button" aria-label="Quitar destino">✕</button>' : "";
  let ico = "🧭", txt = "";

  if (!ultimaPos) {
    txt = escHtml(`Esperando tu ubicación para trazar la ruta…`);
  } else if (!n || n.rutaFallo) {
    txt = escHtml("No se pudo calcular la ruta por calles. Reintentando…");
  } else if (!n.rutaPasos || !n.rutaPasos.length) {
    txt = escHtml(`Calculando ruta a ${titulo}…`);
  } else {
    let idx = Math.max(0, Math.min(n.rutaIdx || 0, n.rutaPasos.length - 1));
    while (idx < n.rutaPasos.length - 1 && n.rutaPasos[idx] && n.rutaPasos[idx].loc &&
           distanciaM(ultimaPos.lat, ultimaPos.lng, n.rutaPasos[idx].loc.lat, n.rutaPasos[idx].loc.lng) < 30) idx++;
    n.rutaIdx = idx;
    const paso = n.rutaPasos[idx];
    const info = paso ? Ordenes.textoPaso(paso) : ["🧭", ""];
    ico = info[0] || "🧭";
    const dist = formatoDist(n.rutaDist || 0);
    const min = Math.max(1, Math.round((n.rutaDur || 0) / 60));
    txt = `<b>${escHtml(info[1] || "")}</b><span>${escHtml(dist)} · ≈ ${min} min · ${escHtml(titulo)}</span>`;
  }
  b.innerHTML = `<span class="ir-ic">${ico}</span><span class="ir-txt">${txt}</span>${cerrar}`;
  const x = $("brX"); if (x) x.onclick = quitarLugarDestino;
}

function renderLista() { renderListaBase(); aplicarHoja(); }

/* ============================================================
   FASE 2 · renderListaBase:
   - Añade el botón "📢 Avisar llegué" junto a "Entregado".
   - Oculta los detalles de factura interna (#cobro, #prio) para pedidos esChat.
   ============================================================ */
function renderListaBase() {
  const cont = $("hojaPedidos"), delAdmin = OrdenAdminRep.html() + htmlPedidoChat();
  if (!orden.length) { cont.innerHTML = delAdmin + (delAdmin ? "" : '<p class="ayuda">No hay pedidos en ruta. Toca un cliente en el mapa o inicia una entrega desde Pedidos.</p>'); return; }
  const t = viajes[seleccionado] ? seleccionado : orden[0], v = viajes[t], i = orden.indexOf(t);
  cont.innerHTML = delAdmin + `<div class="pedido-card sel${v.esChat ? " es-chat" : ""}" data-token="${t}">
      <div class="pc-top">
        <span class="pc-num">${i + 1}</span>
        <div class="pc-datos"><strong>${escHtml(nombreDe(v))}</strong><small class="pc-sub" id="sub-${t}"></small></div>
        <div class="pc-total"><small>Factura</small><b id="tot-${t}">—</b></div>
      </div>
      <div class="pc-botones pc-botones-3">
        <button class="boton-chat" data-acc="chat" type="button">💬 Chat <span class="badge oculto" id="bd-${t}">0</span></button>
        <button class="oscuro" data-acc="avisar" type="button" aria-label="Avisar al cliente que llegué">📢 Avisar</button>
        <button class="primario" data-acc="entregado" type="button">✓ Entregado</button>
      </div>
    </div>`;
  refrescarTextos();
}

/* FASE 2 · Avisar al cliente que el repartidor llegó (manual) */
function avisarLlegada(v) {
  if (!v) return;
  if (/^sol_/.test(v.token)) {
    db.ref("solicitudes_entrantes/" + v.token).update({ llegadaTs: TS, llegadaPor: "manual" })
      .then(() => {
        setEstado("📢 Cliente avisado: repartidor llegando al destino", "ok");
        Voz.hablar("Aviso enviado al cliente", { forzar: true });
        navigator.vibrate && navigator.vibrate([200, 100, 200]);
      })
      .catch((e) => setEstado("No se pudo avisar: " + e.message, "error"));
    return;
  }
  const upd = { cerca: true, cercaTs: TS };
  if (v.destino) { upd.destLat = v.destino.lat; upd.destLng = v.destino.lng; }
  db.ref("pedidos/" + v.token).update(upd)
    .then(() => {
      setEstado("📢 Cliente avisado: repartidor llegando al destino", "ok");
      Voz.hablar("Aviso enviado al cliente", { forzar: true });
      navigator.vibrate && navigator.vibrate([200, 100, 200]);
    })
    .catch((e) => setEstado("No se pudo avisar: " + e.message, "error"));
  // Si el pedido proviene del pool de WhatsApp, también se actualiza la solicitud para que la app del cliente lo detecte.
  db.ref("pedidos/" + v.token + "/solicitudId").once("value").then((s) => {
    if (s.exists()) {
      const sid = s.val();
      db.ref("solicitudes_entrantes/" + sid).update({ llegadaTs: TS, llegadaPor: "manual" }).catch(() => {});
    }
  }).catch(() => {});
}

function textoSub(v) {
  const p = [];
  if (v.sinFactura) p.push("enlace de contacto (aún sin factura)");
  p.push(v.destino ? (v.dist != null ? "a " + formatoDist(v.dist) : "calculando…") : "sin destino");
  if (v.rutaDur) p.push("≈ " + Math.max(1, Math.round(v.rutaDur / 60)) + " min");
  if (v.sub && v.sub.items && v.sub.items.length) p.push("➕ Mandado extra: gran total " + SubFactura.money(SubFactura.calcular(v.factura, v.sub).gran));
  p.push(v.destManual ? "destino marcado por ti" : !v.cliPos ? "el cliente aún no comparte ubicación" : v.cliPos.manual ? "ubicación marcada por el cliente" : esVivo(v) ? "cliente en vivo" : "cliente sin señal");
  return p.join(" · ");
}
function refrescarTextos() {
  orden.forEach((t) => {
    const v = viajes[t]; if (!v) return;
    const sub = $("sub-" + t); if (!sub) { pintarCliente(v); return; }
    sub.textContent = textoSub(v);
    const chip = $("chip-" + t);
    if (chip) {
      chip.textContent = v.cerca ? "Cerca" : v.sinFactura ? "Sin factura" : esVivo(v) ? "En vivo" : "En ruta";
      chip.className = "chip " + (v.cerca ? "alerta" : "vivo");
    }
    const te = $("tot-" + t);
    if (te) {
      const cc = totalCobrar(v);
      let tot = cc ? cc.total : null;
      if (tot == null && v.esChat) { try { tot = ChatsEntrantes.totalFactura(t); } catch (_) {} }
      te.textContent = tot != null ? money2(tot) : "Sin factura";
    }
    const bd = $("bd-" + t); if (bd) { bd.textContent = v.noLeidos; bd.classList.toggle("oculto", !v.noLeidos); }
    const uc = $("usarcli-" + t); if (uc) uc.classList.toggle("oculto", !(v.destManual && v.cliPos));
    const sb = $("subbd-" + t); if (sb) sb.textContent = v.sub && v.sub.items && v.sub.items.length ? "(" + v.sub.items.length + ")" : "";
    const pe = $("prio-" + t);
    if (pe) {
      if (v.prioridad) {
        pe.innerHTML = '<span class="chip alerta">⚡ PRIORIDAD</span> +' + money2(PRIORIDAD_EXTRA) + " en concepto de propina por prioridad";
        pe.classList.remove("oculto");
      } else { pe.classList.add("oculto"); pe.innerHTML = ""; }
    }
    const ce = $("cobro-" + t);
    if (ce) {
      const c = totalCobrar(v);
      if (c) {
        ce.innerHTML = '<span class="pc-cobro-t">💵 Total a cobrar</span><b>' + money2(c.total) + "</b><small>Compras " + money2(c.compras) + " · Delivery " + money2(c.delivery) + (c.propina ? " · Propina " + money2(c.propina) : "") + (c.extras ? " · Extras " + money2(c.extras) : "") + "</small>";
        ce.classList.remove("oculto");
      } else { ce.classList.add("oculto"); ce.innerHTML = ""; }
    }
    pintarCliente(v);
  });
  actualizarNav();
}
setInterval(() => { if (orden.length) refrescarTextos(); PedidoRep.pintarCliente(); }, 15000);

$("hojaPedidos").onclick = (e) => {
  if (PedidoRep.alClick(e)) return;
  if (OrdenAdminRep.alClick(e)) return;
  const card = e.target.closest(".pedido-card"); if (!card) return;
  const v = viajes[card.dataset.token]; if (!v) return;
  const b = e.target.closest("button[data-acc]");
  if (!b) return seleccionar(v.token, true);
  const acc = b.dataset.acc;
  if (acc === "chat") { if (!(ChatsEntrantes.abrirConv && ChatsEntrantes.abrirConv(v.token))) abrirChat(v); }
  else if (acc === "avisar") avisarLlegada(v);
  else if (acc === "entregado") cerrarViaje(v.token, "entregado");
  else if (acc === "cancelar") cerrarViaje(v.token, "cancelado");
  else if (acc === "sub") SubFactura.abrir(v, ctxSub);
  else if (acc === "factura") FacturaVivo.abrir(v.token);
  else if (acc === "wa") abrirWhatsApp(mensajeSeguimiento(v));
  else if (acc === "usarcli") usarUbicacionCliente(v);
};

/* ============================================================
   APK: plugins y notificaciones
   ============================================================ */
const esNativo = () => { const C = window.Capacitor; return !!(C && ((C.isNativePlatform && C.isNativePlatform()) || (C.getPlatform && C.getPlatform() !== "web"))); };
function plug(nombre) {
  const C = window.Capacitor;
  if (!esNativo()) return null;
  if (C.isPluginAvailable && !C.isPluginAvailable(nombre)) return null;
  return (C.Plugins && C.Plugins[nombre]) || (C.registerPlugin && C.registerPlugin(nombre)) || null;
}
let notifLista = false, esperandoPermisos = null;
const CLAVE_NOTIF_IDS = "brothersNotifIds";
let notifIds = {};
try { notifIds = JSON.parse(localStorage.getItem(CLAVE_NOTIF_IDS) || "{}"); } catch (_) {}
const guardarNotifIds = () => { try { localStorage.setItem(CLAVE_NOTIF_IDS, JSON.stringify(notifIds)); } catch (_) {} };
function claveNotif(extra) {
  if (!extra) return "";
  if (extra.solicitud) return "sol:" + extra.solicitud;
  if (extra.token) return "tok:" + extra.token;
  if (extra.equipo === "guia") return "guia";
  if (extra.equipo === "chat") return "eqchat";
  if (extra.equipo) return "eq";
  return "";
}
function cancelarNotif(extra) {
  const clave = claveNotif(extra);
  if (!clave) return;
  const id = notifIds[clave];
  if (id == null) return;
  delete notifIds[clave]; guardarNotifIds();
  const ln = plug("LocalNotifications");
  if (!ln) return;
  try { ln.cancel({ notifications: [{ id }] }).catch(() => {}); } catch (_) {}
  try { ln.removeDeliveredNotifications && ln.removeDeliveredNotifications({ notifications: [{ id }] }).catch(() => {}); } catch (_) {}
}

function permisosInicio() {
  if (!esNativo()) return Promise.resolve();
  return (async () => {
    const ln = plug("LocalNotifications");
    let faltaNotif = false;
    if (ln) { try { faltaNotif = (await ln.checkPermissions()).display !== "granted"; } catch (_) {} }
    if (localStorage.getItem("permisosExplicados") === "1" && !faltaNotif) return prepararNotificaciones();
    $("modalPermisos").classList.remove("oculto");
    await new Promise((ok) => { esperandoPermisos = ok; });
  })();
}
$("btnPermisos").onclick = async () => {
  $("btnPermisos").disabled = true;
  await prepararNotificaciones(true);
  localStorage.setItem("permisosExplicados", "1");
  $("modalPermisos").classList.add("oculto");
  $("btnPermisos").disabled = false;
  if (esperandoPermisos) { esperandoPermisos(); esperandoPermisos = null; }
};
$("btnAjustesApp").onclick = () => { const bg = plug("BackgroundGeolocation"); bg && bg.openSettings && bg.openSettings(); };

async function prepararNotificaciones(pedir) {
  const ln = plug("LocalNotifications");
  if (!ln) return;
  try {
    if (pedir) await ln.requestPermissions();
    await ln.createChannel({ id: "mensajes", name: "Mensajes de clientes", description: "Avisos cuando un cliente te escribe", importance: 5, visibility: 1, vibration: true, lights: true });
    await ln.registerActionTypes({ types: [{ id: "MENSAJE", actions: [
      { id: "responder", title: "Responder", input: true, inputButtonTitle: "Enviar", inputPlaceholder: "Escribe tu respuesta" },
      { id: "abrir", title: "Abrir chat" }
    ] }] });
    if (!notifLista) { notifLista = true; ln.addListener("localNotificationActionPerformed", alAccionNotificacion); }
  } catch (e) { console.warn("Notificaciones:", e); }
}

const PUSH_HABILITADO = true;
let pushActivo = false, abrirPendiente = null;
async function registrarPush() {
  if (!PUSH_HABILITADO) return;
  const PN = plug("PushNotifications");
  if (!PN || !uidActual) return;
  try {
    let p = await PN.checkPermissions();
    if (p.receive !== "granted") p = await PN.requestPermissions();
    if (p.receive !== "granted") return;
    await PN.createChannel({ id: "mensajes", name: "Mensajes", description: "Avisos cuando Brothers o un cliente te escribe", importance: 5, visibility: 1, vibration: true, lights: true });
    await PN.createChannel({ id: "pedidos", name: "Pedidos nuevos", description: "Pedidos y guías que te asigna Brothers", importance: 5, visibility: 1, vibration: true, lights: true });
    await PN.removeAllListeners();
    PN.addListener("registration", (t) => {
      pushActivo = true;
      const u = uidActual; if (!u) return;
      db.ref().update({ [`repartidores/${u}/fcmToken`]: t.value, [`repartidores/${u}/fcmTs`]: TS }).catch((e) => console.warn("fcmToken:", e.message));
    });
    PN.addListener("registrationError", (e) => console.warn("Push:", e));
    PN.addListener("pushNotificationActionPerformed", (ev) => {
      const d = (ev.notification && ev.notification.data) || {};
      if (d.tipo === "mensaje") return abrirChatAdmin();
      if (d.tipo === "pedido" || d.tipo === "guia") return irA("mapa");
      const tk = d.token;
      if (!tk) return;
      if (viajes[tk]) { irA("mapa"); abrirChat(viajes[tk]); }
      else if (PedidoRep.esMio(tk)) { irA("mapa"); PedidoRep.abrirChat(); }
      else abrirPendiente = tk;
    });
    await PN.register();
  } catch (e) { console.warn("Push:", e); }
}

function notificarTexto(titulo, cuerpo, resumen, extra) {
  const ln = plug("LocalNotifications");
  if (!ln || !document.hidden) return;
  if (pushActivo && extra && extra.equipo) return;
  const id = Math.floor(Math.random() * 2000000000);
  const clave = claveNotif(extra);
  if (clave) { notifIds[clave] = id; guardarNotifIds(); }
  ln.schedule({ notifications: [{
    id, title: titulo, body: cuerpo, largeBody: cuerpo, summaryText: resumen,
    channelId: "mensajes", actionTypeId: "MENSAJE", extra
  }] }).catch(() => {});
}
function notificarMensaje(v, m) {
  notificarTexto(v.cliente ? "Cliente · " + v.cliente : "Cliente · Pedido " + etiquetaWA(v), m.texto ? m.texto : "📷 Te envió una foto", "Pedido " + etiquetaWA(v), { token: v.token });
}
function alAccionNotificacion(ev) {
  const extra = (ev && ev.notification && ev.notification.extra) || {};
  cancelarNotif(extra);
  const texto = ev.inputValue && ev.inputValue.trim();
  if (extra.solicitud) { irA(ChatsEntrantes.activos() ? "chats" : "mapa"); ChatsEntrantes.vistaPrevia(extra.solicitud); return; }
  if (extra.equipo) {
    if (ev.actionId === "responder" && texto) {
      Chat.enviarA(uidActual, "repartidor", { pedido: "Equipo", nombreRepartidor: usuario }, texto.slice(0, 600), null, RUTA_EQUIPO).catch(() => {});
      return;
    }
    if (extra.equipo === "guia") { irA("mapa"); return; }
    return abrirChatAdmin();
  }
  if (!viajes[extra.token] && PedidoRep.esMio(extra.token)) {
    if (ev.actionId === "responder" && texto) return PedidoRep.responderRapido(texto);
    irA("mapa"); PedidoRep.abrirChat(); return;
  }
  const v = viajes[extra.token]; if (!v) return;
  if (ev.actionId === "responder" && texto) {
    Chat.enviarA(extra.token, "repartidor", { pedido: v.pedido, nombreRepartidor: usuario }, texto.slice(0, 600), null).catch(() => {});
    return;
  }
  irA("mapa"); abrirChat(v);
}

const nativo = () => plug("Nativo");
let esperandoAjustes = false, nativoListo = false, alElegirCb = null;
async function iniciarNativo(forzarModal) {
  const n = nativo(); if (!n) return;
  if (!nativoListo) { nativoListo = true; n.addListener("entrante", alEntrante); }
  let e; try { e = await n.estado(); } catch (_) { return; }
  if (e.permiso) n.activar({ activo: true }).catch(() => {});
  const falta = !e.permiso || !e.bateria;
  const hace3dias = Date.now() - Number(localStorage.getItem("nativoPreguntado") || 0) > 3 * 86400000;
  if (falta && (forzarModal || hace3dias)) {
    localStorage.setItem("nativoPreguntado", String(Date.now()));
    $("btnBurbujaPermiso").classList.toggle("oculto", !!e.permiso);
    $("btnBurbujaBateria").classList.toggle("oculto", !!e.bateria);
    $("modalBurbuja").classList.remove("oculto");
  } else $("modalBurbuja").classList.add("oculto");
}
$("btnBurbujaPermiso").onclick = () => { esperandoAjustes = true; nativo().pedirPermiso().catch(() => {}); };
$("btnBurbujaBateria").onclick = () => { esperandoAjustes = true; nativo().pedirBateria().catch(() => {}); };
$("btnBurbujaCerrar").onclick = () => $("modalBurbuja").classList.add("oculto");
function apagarNativo() { const n = nativo(); if (n) n.activar({ activo: false }).catch(() => {}); }

function elegirPedido(titulo, cb, etiqueta, extra) {
  $("elegirTitulo").textContent = titulo; alElegirCb = cb;
  $("elegirLista").innerHTML = orden.map((t, i) => `<button class="oscuro" data-t="${t}" type="button">${i + 1}. ${etiqueta || ""}${escHtml(nombreDe(viajes[t]))} · ${escHtml(etiquetaWA(viajes[t]))}</button>`).join("") + (extra || "");
  $("modalElegir").classList.remove("oculto");
}
$("elegirLista").onclick = (e) => {
  const b = e.target.closest("button[data-t]"); if (!b) return;
  $("modalElegir").classList.add("oculto");
  const cb = alElegirCb; alElegirCb = null; if (!cb) return;
  if (b.dataset.t === "__ir") return cb(null, "ir");
  if (b.dataset.t === "__adm") return cb({ admin: true });
  if (viajes[b.dataset.t]) cb(viajes[b.dataset.t]);
};
$("btnElegirCancelar").onclick = () => { alElegirCb = null; $("modalElegir").classList.add("oculto"); };

function alEntrante(ev) {
  if (!ev) return;
  if (ev.accion) return accionBurbuja(ev.accion);
  if (ev.texto) recibirUbicacion(String(ev.texto));
}
function accionBurbuja(a) {
  if (a === "factura") return irA("factura");
  if (a === "ubicacion") {
    irA("mapa"); seguirme = true;
    if (mapa && ultimaPos) mapa.setView([ultimaPos.lat, ultimaPos.lng], 17);
    return;
  }
  if (a === "chat") {
    const adm = PedidoRep.info();
    if (!orden.length && !adm) { irA("factura"); return alert("No tienes clientes en ruta para chatear."); }
    if (!orden.length) { irA("mapa"); return PedidoRep.abrirChat(); }
    if (orden.length === 1 && !adm) { irA("mapa"); return abrirChat(viajes[orden[0]]); }
    const extraBtn = adm ? `<button class="oscuro" data-t="__adm" type="button">${orden.length + 1}. 🛵 ${escHtml(adm.cliente)} · ${escHtml(adm.codigo)}</button>` : "";
    elegirPedido("¿Con qué cliente quieres chatear?", (v) => { irA("mapa"); if (v && v.admin) PedidoRep.abrirChat(); else abrirChat(v); }, "", extraBtn);
  }
}
async function recibirUbicacion(texto) {
  let c = Buscar.coords(texto), nombre = "Ubicación compartida";
  const l1 = texto.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).find((x) => !/^(https?:|geo:)/i.test(x) && !Buscar.coords(x));
  if (l1 && l1.length <= 60) nombre = l1;
  if (!c) {
    const m = texto.match(/https?:\/\/[^\s]+/i), n = nativo();
    if (m && n) {
      try { const r = await n.resolverEnlace({ url: m[0] }); c = Buscar.coords(r.url) || (r.coords && Buscar.coords(r.coords)); } catch (_) {}
    }
  }
  if (!c) return alert("No encontré una ubicación en lo que compartiste. Comparte un enlace de Google Maps, Waze, geo: o las coordenadas.\n\nNota: la ubicación EN TIEMPO REAL de WhatsApp solo se ve dentro de WhatsApp; usa “Contactarme al cliente” para que el cliente comparta la suya con tu app.");
  const lugar = { nombre, lat: c.lat, lng: c.lng, icono: "📍" };
  if (!orden.length) return irALugar(lugar, true);
  elegirPedido("📍 " + nombre + "\n¿Qué hacemos con esta ubicación?", (v, modo) => {
    if (modo === "ir" || !v) return irALugar(lugar, true);
    irA("mapa"); seleccionar(v.token, false);
    fijarDestino(v, c.lat, c.lng);
    seguirme = false; encuadrar(true);
  }, "Destino de ", '<button class="primario" data-t="__ir" type="button">🧭 Solo ir ahora (ruta)</button>');
}

const plugin = () => plug("BackgroundGeolocation");
async function iniciarGPS() {
  if (watchId !== null || bgId !== null) return;
  bgPlugin = plugin();
  if (bgPlugin) {
    bgId = await bgPlugin.addWatcher(
      { backgroundTitle: "Brother’s Deliverys · ubicación en tiempo real", backgroundMessage: "Se está registrando tu trayecto. Toca para volver a la app.",
        requestPermissions: true, stale: false, distanceFilter: 5 },
      (loc, err) => {
        if (err) {
          if (err.code === "NOT_AUTHORIZED" && confirm("Brother’s necesita la ubicación “Permitir todo el tiempo”. ¿Abrir los ajustes?")) bgPlugin.openSettings();
          return setEstado("Error GPS: " + (err.message || err.code), "error");
        }
        if (loc) procesarPosicion({ latitude: loc.latitude, longitude: loc.longitude, accuracy: loc.accuracy, heading: loc.bearing, speed: loc.speed });
      });
  } else {
    if (!("geolocation" in navigator)) return setEstado("Este dispositivo no tiene GPS.", "error");
    Pantalla.pedir();
    watchId = navigator.geolocation.watchPosition(
      (pos) => procesarPosicion(pos.coords),
      (err) => setEstado(err.code === 1 ? "Permiso de ubicación denegado. Actívalo en Ajustes." : "Error GPS: " + err.message, "error"),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  latido = setInterval(() => {
    if (ultimaPos && uidActual) db.ref("ubicaciones/" + uidActual).update({ ts: TS, enLinea: true }).catch(() => {});
  }, 30000);
}
function detenerGPS() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (bgId !== null && bgPlugin) { bgPlugin.removeWatcher({ id: bgId }); bgId = null; }
  clearInterval(latido); latido = null;
  Pantalla.soltar();
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (esperandoAjustes) { esperandoAjustes = false; iniciarNativo(true); }
  if (uidActual) Pantalla.pedir();
  if (mapa) { mapa.invalidateSize(); pintarYo(); dibujarRuta(); }
});

function procesarPosicion(c) {
  const lat = c.latitude, lng = c.longitude, precision = Math.round(c.accuracy || 0);
  const primera = !ultimaPos;
  ultimaPos = { lat, lng };
  if (orden.length) {
    const ult = rastro[rastro.length - 1];
    if (!ult || distanciaM(ult[0], ult[1], lat, lng) > 4) { rastro.push([lat, lng]); if (rastro.length > 800) rastro.shift(); guardarRastro(); }
  }
  Camara.registrar(lat, lng);
  pintarYo();
  if (mapa && vistaActual === "mapa") {
    if (seguirme) Camara.actualizar(primera);
    dibujarRuta(); dibujarRutaLugar(); actualizarBanner();
  }
  const ahora = Date.now();
  if (ahora - ultimaEscritura < INTERVALO_MS) return;
  ultimaEscritura = ahora;
  const ocupado = orden.length > 0 || (typeof OrdenAdminRep !== "undefined" && OrdenAdminRep.activo());
  db.ref("ubicaciones/" + uidActual).set({
    lat, lng, precision, rumbo: num(c.heading), velocidad: num(c.speed),
    ts: TS, enLinea: true, enViaje: ocupado, conPedido: ocupado, usuario
  }).catch(() => {});
  try { ChatsEntrantes.publicarGps({ lat, lng }); } catch (_) {}
  try { ChatsEntrantes.pintarRutasPendientes(); } catch (_) {}
  const base = { lat, lng, precision, rumbo: num(c.heading), velocidad: num(c.speed), ts: TS };
  orden.forEach((t) => evaluarViaje(viajes[t], base));
  OrdenAdminRep.publicar(base);
  if (seleccionado) pedirRuta(viajes[seleccionado]);
  if (lugarDestino) pedirRutaLugar();
  refrescarTextos();
  setEstado(`Compartiendo ubicación · ±${precision} m` + (orden.length ? ` · ${orden.length} pedido${orden.length > 1 ? "s" : ""} en ruta` : "") + (bgPlugin ? " · segundo plano activo" : " · solo con pantalla activa (usa el APK)"), "ok");
}

function enviarContacto(v) {
  const enlace = enlaceDe(v.token, { chat: "1" });
  abrirWhatsApp(
    `📞 *SOLICITUD DE CONTACTO*\n🏍️ Repartidor: ${usuario}\n📦 Pedido ${v.pedido}${v.cliente ? " · Cliente: " + v.cliente : ""}\n\n` +
    `💬 El repartidor desea contactarse con usted, por favor presione el enlace para responderle:\n${enlace}`);
}
function nuevoContacto() {
  let nombre = ($("customerName").value || "").trim();
  if (!nombre) nombre = (prompt("Nombre del cliente (para identificarlo):") || "").trim();
  if (!nombre) return;
  const token = generarToken(), pedido = Factura.nuevoCodigo();
  crearViaje({ token, pedido, cliente: nombre, sinFactura: true });
  if (!seleccionado) seleccionado = token;
  guardarViajes(); sincronizarContactos(); renderLista();
  db.ref("pedidos/" + token).set({ estado: "en_ruta", pedido, inicio: TS, repartidorUid: uidActual, repartidorNombre: usuario, sinFactura: true })
    .catch((e) => { quitarViaje(token); alert("No se pudo crear el enlace: " + e.message); });
  enviarContacto(viajes[token]);
}
$("btnContactoCliente").onclick = () => {
  if (!orden.length) return nuevoContacto();
  $("contactoLista").innerHTML = orden.map((t, i) => `<button class="oscuro" data-t="${t}" type="button">${i + 1}. ${escHtml(nombreDe(viajes[t]))} · ${escHtml(etiquetaWA(viajes[t]))}${viajes[t].sinFactura ? " (sin factura)" : ""}</button>`).join("") +
    '<button class="primario" data-t="__nuevo" type="button">➕ Cliente nuevo (aún sin factura)</button>';
  $("modalContacto").classList.remove("oculto");
};
$("contactoLista").onclick = (e) => {
  const b = e.target.closest("button[data-t]"); if (!b) return;
  $("modalContacto").classList.add("oculto");
  if (b.dataset.t === "__nuevo") return nuevoContacto();
  if (viajes[b.dataset.t]) enviarContacto(viajes[b.dataset.t]);
};
$("btnContactoCancelar").onclick = () => $("modalContacto").classList.add("oculto");

const NEGOCIO_WA = "50586265619";
function abrirWhatsApp(msg) {
  const url = `https://wa.me/${NEGOCIO_WA}?text=${encodeURIComponent(msg)}`;
  if (typeof 
