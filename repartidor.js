/* ============================================================
   MÓDULO REPARTIDOR
   Flujo:
   1) Al entrar sale la FACTURA (factura.js).
   2) "Enviar factura por WhatsApp" → la factura sale con el enlace de seguimiento,
      se crea el pedido en la nube y la app pasa al MAPA con el seguimiento activo.
   3) Cada nueva factura agrega otro pedido (otro token): el repartidor puede llevar varios
      y entregarlos en el orden que quiera. Entre pantallas se mueve con la barra inferior.
   4) El cliente comparte su ubicación al abrir el enlace; aquí se ve en tiempo real.
   - Turno: la ubicación del repartidor se comparte SIEMPRE mientras haya sesión (mapa del administrador)
   - En el APK (Capacitor) el GPS sigue en segundo plano; en el navegador solo con la pantalla activa
   ============================================================ */
/* Si algo falla al cargar (p. ej. faltan archivos por subir), el motivo aparece escrito bajo el formulario */
window.addEventListener("error", (e) => {
  const m = document.getElementById("msgLogin");
  if (m) { m.textContent = "Error en la página: " + e.message + ". Puede que falten archivos por subir a GitHub."; m.className = "estado error"; }
});
const auth = APP.auth();
const db = APP.database();
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;

let watchId = null, bgId = null, bgPlugin = null, latido = null, wakeLock = null;
let uidActual = null, usuario = null, ultimaPos = null, ultimaEscritura = 0;
const INTERVALO_MS = 4000;   // máximo 1 escritura de GPS cada 4 s
const RADIO_AVISO_M = 200;   // distancia que dispara "El repartidor está cerca" en el cliente
const FRESCO_MS = 60000;     // la ubicación del cliente se considera "en vivo" si es más reciente que esto

/* Estado de la app */
const viajes = {};           // token → pedido en ruta (ver crearViaje)
let orden = [];              // tokens, en el orden en que se crearon (define el número 1, 2, 3…)
let seleccionado = null;     // token del pedido enfocado en el mapa
let vistaActual = "factura"; // "factura" | "mapa"
let chatToken = null;        // token cuyo chat está abierto ahora ("equipo" = chat con Brothers)
const RUTA_EQUIPO = { chats: "chatsEquipo", resumen: "chatsEquipoResumen", fotos: "fotosEquipo" };
let lugares = {}, lugarMarks = {}, refLugares = null, lugarDestino = null, marcaLugar = null, rutaLugar = null;
let capaLugar = null, flechasLugar = null, flechasOrden = null, flechasClave = "", resultadosRep = [];
let guiaActual = null, guiaTsVisto, marcaGuia = null, refGuia = null, refAdminChat = null, adminListo = false, noLeidosAdmin = 0;
let mapa = null, marcaYo = null, estelaProp = null, capaRuta = null, capaFlujo = null;
let rastro = [], marcando = false, nombreYoMarcado = "";
const iconoDestino = iconoPin();

/* ---------- Utilidades ---------- */
function setEstado(texto, tipo = "") {
  const el = $("estadoGps"); if (!el) return;
  el.textContent = texto; el.className = "estado " + tipo;
}
function generarToken(largo = 14) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
const enlaceDe = (token) => `${URL_RASTREO}?id=${token}`;
const num = (x) => (Number.isFinite(x) ? x : null);
const formatoDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const nombreDe = (v) => v.cliente || ("Pedido " + v.pedido);
const esVivo = (v) => !!(v.cliPos && !v.cliPos.manual && v.cliPos.ts && Date.now() - v.cliPos.ts < FRESCO_MS);

/* ---------- Pantallas ---------- */
function mostrar(vista) {   // "login" | "usuario" | "app"
  $("splash").classList.add("oculto");
  $("mainAuth").classList.toggle("oculto", vista === "app");
  $("vistaLogin").classList.toggle("oculto", vista !== "login");
  $("vistaUsuario").classList.toggle("oculto", vista !== "usuario");
  $("btnSalir").classList.toggle("oculto", vista === "login");
  $("btnChatAdmin").classList.toggle("oculto", vista !== "app");
  if (vista !== "app") {
    ["vistaFactura", "vistaMapa", "navApp"].forEach((id) => $(id).classList.add("oculto"));
  } else irA(vistaActual);
}
function irA(vista) {
  vistaActual = vista;
  $("vistaFactura").classList.toggle("oculto", vista !== "factura");
  $("vistaMapa").classList.toggle("oculto", vista !== "mapa");
  actualizarNav();
  if (vista === "mapa") {
    renderLista();
    initMapa();
    setTimeout(() => { mapa.invalidateSize(); encuadrar(); }, 60);
  }
}
function actualizarNav() {
  const hay = !!uidActual && !!usuario;   // Factura ⇄ Mapa siempre disponibles; el mapa también sirve sin pedidos
  $("navApp").classList.toggle("oculto", !hay);
  document.body.classList.toggle("con-nav", !!hay);
  $("navFactura").classList.toggle("activa", vistaActual === "factura");
  $("navMapa").classList.toggle("activa", vistaActual === "mapa");
  const sinLeer = orden.reduce((t, k) => t + (viajes[k] ? viajes[k].noLeidos : 0), 0);
  const b = $("badgeNav");
  b.textContent = sinLeer ? "💬 " + sinLeer : String(orden.length);
  b.classList.toggle("rojo", sinLeer > 0);
  b.classList.toggle("oculto", !orden.length && !sinLeer);
}
$("navFactura").onclick = () => irA("factura");
$("navMapa").onclick = () => irA("mapa");

/* ---------- Sesión y nombre de usuario ---------- */
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

try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (_) {}   // la sesión se recuerda en este aparato
setTimeout(() => $("splash").classList.add("oculto"), 8000);   // por si algo tarda: nunca se queda cargando
auth.onAuthStateChanged(async (user) => {
  if (!user) {
    detenerGPS(); apagarNativo(); soltarViajesEnMemoria(); soltarAdmin(); uidActual = null; usuario = null; $("clave").value = "";
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
    // sin internet o muy lenta: NO se cierra la sesión; se entra con los datos guardados la última vez
    try { reg = JSON.parse(localStorage.getItem(claveCache) || "null"); } catch (_) { reg = null; }
    if (!reg) { msgLogin("Sin conexión: no se pudo verificar tu cuenta. Revisa tu internet."); return mostrar("login"); }
  }
  if (!reg) {
    msgLogin("Esta cuenta no está registrada como repartidor. Pide al administrador que la agregue en la pestaña Equipo.");
    return auth.signOut();
  }
  usuario = typeof reg === "object" && reg.usuario ? reg.usuario : null;
  if (!usuario) return mostrar("usuario");   // primera vez: pedir nombre de usuario
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
  // Si se corta la conexión, el administrador lo verá como "desconectado"
  db.ref("ubicaciones/" + uidActual).onDisconnect().update({ enLinea: false, enViaje: false, ts: TS });
  Factura.nombreRepartidor = usuario;
  reanudarViajes();                 // por si la app se cerró con pedidos en ruta
  vistaActual = orden.length ? "mapa" : "factura";   // la factura es lo primero, salvo que ya lleve un pedido en camino
  mostrar("app");
  escucharAdmin();                  // chat con Brothers + guías del administrador
  await permisosInicio();           // APK: explica y pide permisos (notificaciones…)
  registrarPush();                  // avisos push con la app cerrada
  iniciarNativo();                  // burbuja flotante, batería y ubicaciones compartidas (solo APK)
  iniciarGPS();                     // y aquí Android pide la ubicación (“todo el tiempo”)
}

$("btnSalir").onclick = async () => {
  if (orden.length) return alert("Primero entrega o cancela los pedidos en curso.");
  if (!confirm("¿Cerrar sesión? Dejarás de compartir tu ubicación.")) return;
  detenerGPS(); apagarNativo();
  try { await db.ref(`repartidores/${uidActual}/fcmToken`).remove(); } catch (_) {}   // este teléfono deja de recibir avisos
  try {
    await db.ref("ubicaciones/" + uidActual).update({ enLinea: false, enViaje: false, ts: TS });
    db.ref("ubicaciones/" + uidActual).onDisconnect().cancel();
  } catch (_) {}
  await auth.signOut();
};

/* ============================================================
   MAPA (repartidor + clientes + ruta)
   ============================================================ */
function initMapa() {
  if (mapa) return;
  mapa = L.map("mapaRuta", GestosMapa.opciones).setView([-12.0464, -77.0428], 14);
  L.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);   // zoom: botones, doble toque o pellizco
  GestosMapa.aplicar(mapa);
  mapa.on("click movestart", cerrarBusquedaRep);   // tocar o mover el mapa cierra la búsqueda y deja el mapa completo
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
  // Recorrido del repartidor (lo que ya avanzó) + ruta hacia el cliente (con línea animada encima)
  estelaProp = L.polyline([], { color: "#7B8794", weight: 5, opacity: .65 }).addTo(mapa);
  capaRuta = L.polyline([], { color: "#0A86C9", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
  capaFlujo = L.polyline([], { color: "#fff", weight: 3, opacity: .95, className: "ruta-viva" }).addTo(mapa);
  flechasOrden = L.layerGroup().addTo(mapa);   // flechas: sentido de circulación en cada calle
  capaLugar = L.polyline([], { color: "#F59E0B", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
  flechasLugar = L.layerGroup().addTo(mapa);
  mapa.on("zoomend", () => mapa.getContainer().classList.toggle("zoom-lejos", mapa.getZoom() < 15));
  mapa.getContainer().classList.add("zoom-lejos");
  mapa.on("popupopen", (e) => {   // botón "Ir aquí" dentro de la ventanita de un negocio
    const el = e.popup.getElement(); if (!el) return;
    el.querySelectorAll("button[data-ir]").forEach((b) => b.onclick = () => { mapa.closePopup(); irALugar(lugares[b.dataset.ir], true); });
  });
  mapa.on("click", (e) => { if (marcando) fijarDestinoManual(e.latlng.lat, e.latlng.lng); });
  mapa.on("dragstart", () => { seguirme = false; });
  if (ultimaPos) { pintarYo(); mapa.setView([ultimaPos.lat, ultimaPos.lng], 15); }
  orden.forEach((t) => pintarCliente(viajes[t]));
  dibujarRuta();
  pintarGuia();
  pintarLugares();
  if (lugarDestino) { pintarLugarDestino(); dibujarRutaLugar(); }
  actualizarBanner();
}
let seguirme = true;   // el mapa sigue al repartidor hasta que lo mueve con el dedo

function pintarYo(rumbo) {
  if (!mapa || !ultimaPos) return;
  const p = [ultimaPos.lat, ultimaPos.lng];
  if (!marcaYo) { marcaYo = L.marker(p, { icon: iconoRepartidorNombre(usuario), zIndexOffset: 1000 }).addTo(mapa); nombreYoMarcado = usuario; }
  else {
    marcaYo.setLatLng(p);
    if (nombreYoMarcado !== usuario) { marcaYo.setIcon(iconoRepartidorNombre(usuario)); nombreYoMarcado = usuario; }
  }
  if (rastro.length) estelaProp.setLatLngs(rastro);
}
function iconoCliente(n, nombre, sel, vivo) {
  return L.divIcon({
    className: "",
    html: `<div class="pin-cli${sel ? " sel" : ""}${vivo ? " vivo" : ""}"><b>${n}</b></div><span class="etq-cli">${escHtml(nombre)}</span>`,
    iconSize: [34, 34], iconAnchor: [17, 17]
  });
}
const iconoClienteDot = L.divIcon({ className: "", html: '<div class="marca-cliente"><span>Cliente</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] });

/* Dibuja el destino del pedido (= ubicación del cliente) y, si hubo destino manual, también la del cliente */
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
  const pts = [];
  if (ultimaPos) pts.push([ultimaPos.lat, ultimaPos.lng]);
  const lista = soloSeleccionado && seleccionado ? [seleccionado] : orden;
  lista.forEach((t) => { const v = viajes[t]; if (v && v.destino) pts.push([v.destino.lat, v.destino.lng]); });
  if (guiaCliente() && !orden.length) pts.push([guiaActual.lat, guiaActual.lng]);
  if (pts.length > 1) mapa.fitBounds(L.latLngBounds(pts), { padding: [70, 70], maxZoom: 17 });
  else if (pts.length === 1) mapa.setView(pts[0], 16);
}
$("btnVerTodo").onclick = () => { seguirme = false; encuadrar(false); };

/* ---------- Ruta hacia el pedido seleccionado ---------- */
// Ruta por calles con el servidor público de OSRM (gratis, para uso ligero). Si falla, se dibuja una línea recta.
async function pedirRuta(v, forzar) {
  if (!v || !v.destino || !ultimaPos) return;
  const ahora = Date.now();
  if (!forzar && ahora - v.rutaEn < 15000) return;
  const cambioOrigen = !v.rutaOrigen || distanciaM(ultimaPos.lat, ultimaPos.lng, v.rutaOrigen.lat, v.rutaOrigen.lng) > 60;
  const cambioDest = !v.rutaDest || distanciaM(v.destino.lat, v.destino.lng, v.rutaDest.lat, v.rutaDest.lng) > 40;
  if (!forzar && v.rutaPts && !cambioOrigen && !cambioDest) return;
  v.rutaEn = ahora;
  const o = { lat: ultimaPos.lat, lng: ultimaPos.lng }, d = { lat: v.destino.lat, lng: v.destino.lng };
  try {   // ruta por calles: respeta sentidos únicos y giros; si falla, línea recta
    const r = await Ruta.pedir(o, d);
    v.rutaPts = r.pts; v.rutaDur = r.dur; v.rutaDist = r.dist; v.rutaPasos = r.pasos; v.rutaIdx = Math.min(1, r.pasos.length - 1);
    v.rutaOrigen = o; v.rutaDest = d;
  } catch (_) { /* sin ruta por calles: se usa la línea recta */ }
  if (v.token === seleccionado) dibujarRuta();
  refrescarTextos(); actualizarBanner();
}
function dibujarRuta() {
  if (!mapa) return;
  const v = viajes[seleccionado];
  let pts = [];
  if (v && v.destino && ultimaPos) {
    pts = v.rutaPts ? [[ultimaPos.lat, ultimaPos.lng], ...v.rutaPts] : [[ultimaPos.lat, ultimaPos.lng], [v.destino.lat, v.destino.lng]];
  }
  if (!v && guiaCliente() && !orden.length && ultimaPos) pts = [[ultimaPos.lat, ultimaPos.lng], [guiaActual.lat, guiaActual.lng]];   // sin pedido: línea hacia la guía de Brothers
  capaRuta.setLatLngs(pts); capaFlujo.setLatLngs(pts);
  capaRuta.setStyle({ opacity: v && v.rutaPts ? .9 : .5 });
  const clave = v && v.rutaPts ? v.token + v.rutaPts.length + (v.rutaDist || 0) : "";
  if (clave !== flechasClave) { flechasClave = clave; if (clave) Ruta.flechas(v.rutaPts, flechasOrden, "#0A86C9"); else flechasOrden.clearLayers(); }
  pintarGuia();
}

/* ---------- Selección y destino manual ---------- */
function seleccionar(token, enfocar) {
  if (!viajes[token]) return;
  seleccionado = token;
  orden.forEach((t) => pintarCliente(viajes[t]));
  renderLista();
  dibujarRuta();
  pedirRuta(viajes[token], true);
  if (enfocar) { seguirme = false; encuadrar(true); }
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
  v.destManual = true; v.destino = { lat, lng }; v.cerca = false; v.rutaPts = null; v.rutaDest = null;
  db.ref("pedidos/" + v.token).update({ destLat: lat, destLng: lng, cerca: false, distancia: null });
  guardarViajes(); pintarCliente(v); dibujarRuta(); pedirRuta(v, true); evaluarViaje(v); refrescarTextos();
}
function usarUbicacionCliente(v) {
  v.destManual = false; v.cerca = false; v.rutaPts = null; v.rutaDest = null;
  if (v.cliPos) v.destino = { lat: v.cliPos.lat, lng: v.cliPos.lng };
  else { v.destino = null; db.ref("pedidos/" + v.token).update({ destLat: null, destLng: null, cerca: null, distancia: null }); }
  guardarViajes(); pintarCliente(v); dibujarRuta(); pedirRuta(v, true); evaluarViaje(v); refrescarTextos();
}

/* ============================================================
   PEDIDOS EN RUTA (varios a la vez)
   ============================================================ */
function guardarViajes() {
  try {
    const otros = JSON.parse(localStorage.getItem("viajesActivos") || "[]").filter((x) => x.uid !== uidActual);
    const mios = orden.map((t) => ({ token: t, tel: viajes[t].tel, pedido: viajes[t].pedido, cliente: viajes[t].cliente, destManual: viajes[t].destManual, sinFactura: !!viajes[t].sinFactura, uid: uidActual }));
    localStorage.setItem("viajesActivos", JSON.stringify(otros.concat(mios)));
  } catch (_) {}
}
function crearViaje(info) {
  const v = {
    token: info.token, tel: info.tel || "", pedido: info.pedido || "", cliente: info.cliente || "",
    destManual: !!info.destManual, sinFactura: !!info.sinFactura, cerrando: false, refEstado: null, destino: null, cliPos: null, cerca: false, dist: null,
    marca: null, marcaCli: null, refCli: null, refChat: null, noLeidos: 0, chatListo: false, factura: null, sub: null, refExtra: [],
    rutaPts: null, rutaEn: 0, rutaOrigen: null, rutaDest: null, rutaDur: null
  };
  viajes[v.token] = v;
  if (!orden.includes(v.token)) orden.push(v.token);
  escucharCliente(v);
  escucharChat(v);
  escucharEstado(v);
  escucharSubfactura(v);
  return v;
}

/* Factura original + sub-factura del pedido (sincronizadas en pedidos/{token}) */
function escucharSubfactura(v) {
  const base = db.ref("pedidos/" + v.token);
  const f = base.child("factura"), s = base.child("subfactura");
  f.on("value", (x) => { v.factura = x.val(); refrescarTextos(); }, () => {});
  s.on("value", (x) => { v.sub = x.val(); refrescarTextos(); }, () => {});
  v.refExtra = [f, s];
}
const ctxSub = { db, usuario: () => usuario, wa: (m) => abrirWhatsApp(m), alCambiar: () => refrescarTextos() };

/* Si Brothers marca el pedido como entregado (o se cancela), desaparece también de este teléfono */
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

/* Enlaces de contacto sin factura: la factura los puede usar después (mismo enlace) */
function sincronizarContactos() {
  Factura.contactos = orden.filter((t) => viajes[t] && viajes[t].sinFactura).map((t) => ({ token: t, pedido: viajes[t].pedido, cliente: viajes[t].cliente }));
  Factura.refrescarContactos();
}
function contarFactura(f) {   // suma al contador del día que ve el administrador
  const inc = (n) => firebase.database.ServerValue.increment(Number(n) || 0);
  db.ref(`estadisticas/${Dia.clave()}/${uidActual}`).update({ facturas: inc(1), total: inc(f.total), delivery: inc(f.delivery), nombre: usuario }).catch(() => {});
}

/* Nuevo pedido: lo llama factura.js cuando se pulsa "Enviar factura por WhatsApp" */
Factura.alEnviar = (f) => {
  if (!uidActual || !usuario) return;
  contarFactura(f);
  const ex = viajes[f.token];
  if (ex) {   // la factura usa un enlace de contacto que ya estaba abierto: mismo token, ahora con factura
    ex.sinFactura = false; ex.cliente = f.cliente || ex.cliente; ex.pedido = f.pedido;
    ex.factura = SubFactura.instantanea(f);
    db.ref("pedidos/" + f.token).update({ pedido: f.pedido, sinFactura: null, factura: ex.factura }).catch(() => {});
    guardarViajes(); sincronizarContactos(); renderLista();
    seleccionado = f.token; irA("mapa"); seleccionar(f.token, false);
    setTimeout(() => { seguirme = false; encuadrar(true); }, 400);
    return;
  }
  if (orden.length === 0) rastro = [];
  const v = crearViaje({ token: f.token, tel: f.tel, pedido: f.pedido, cliente: f.cliente });
  guardarViajes();
  // El pedido se crea en la nube (se aplica de inmediato en el aparato y se sincroniza)
  db.ref("pedidos/" + f.token).set({
    estado: "en_ruta", pedido: f.pedido, inicio: TS,
    repartidorUid: uidActual, repartidorNombre: usuario, factura: SubFactura.instantanea(f)
  }).catch((e) => {
    quitarViaje(f.token);
    alert("No se pudo activar el seguimiento: " + e.message);
  });
  seleccionado = v.token;
  sincronizarContactos();
  irA("mapa");
  seleccionar(v.token, false);
  setTimeout(() => { seguirme = false; encuadrar(true); }, 400);
};

/* Al abrir la app: recuperar los pedidos que seguían en ruta */
function reanudarViajes() {
  let guardados = [];
  try { guardados = JSON.parse(localStorage.getItem("viajesActivos") || "[]"); } catch (_) {}
  try {   // compatibilidad con la versión anterior (un solo viaje)
    const viejo = JSON.parse(localStorage.getItem("viajeActivo") || "null");
    if (viejo && viejo.token && !guardados.some((g) => g.token === viejo.token)) guardados.push(viejo);
    localStorage.removeItem("viajeActivo");
  } catch (_) {}
  guardados.filter((g) => g.uid === uidActual && !viajes[g.token]).forEach((g) => {
    const v = crearViaje(g);
    db.ref("pedidos/" + g.token).once("value").then((s) => {
      const d = s.val();
      if (!d || d.estado !== "en_ruta") return quitarViaje(g.token);   // ya terminó en otro aparato
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
  }
  actualizarNav();
}

function soltarViajesEnMemoria() {   // al cerrar sesión: no borra nada en la nube ni en localStorage
  orden.forEach((t) => { const v = viajes[t]; if (!v) return; v.refCli && v.refCli.off(); v.refChat && v.refChat.off(); v.refEstado && v.refEstado.off(); (v.refExtra || []).forEach((r) => r.off()); if (mapa) { v.marca && mapa.removeLayer(v.marca); v.marcaCli && mapa.removeLayer(v.marcaCli); } delete viajes[t]; });
  orden = []; seleccionado = null; chatToken = null; rastro = [];
  try { Chat.detener(); } catch (_) {}
  renderLista(); actualizarNav();
}

let ultGuardadoRastro = 0;
function guardarRastro() {   // el recorrido sobrevive aunque Android cierre la pantalla de la app
  const n = Date.now(); if (n - ultGuardadoRastro < 10000) return; ultGuardadoRastro = n;
  try { localStorage.setItem("rastroViaje", JSON.stringify({ uid: uidActual, pts: rastro.slice(-800) })); } catch (_) {}
}
function quitarViaje(token) {
  const v = viajes[token]; if (!v) return;
  v.refCli && v.refCli.off(); v.refChat && v.refChat.off(); v.refEstado && v.refEstado.off(); (v.refExtra || []).forEach((r) => r.off());
  if (chatToken === token) { Chat.detener(); chatToken = null; }   // el repartidor no conserva rastro del chat
  if (mapa) { v.marca && mapa.removeLayer(v.marca); v.marcaCli && mapa.removeLayer(v.marcaCli); }
  delete viajes[token];
  orden = orden.filter((t) => t !== token);
  if (seleccionado === token) seleccionado = orden[0] || null;
  if (!orden.length) { rastro = []; try { localStorage.removeItem("rastroViaje"); } catch (_) {} if (estelaProp) estelaProp.setLatLngs([]); }
  guardarViajes(); sincronizarContactos();
  orden.forEach((t) => pintarCliente(viajes[t]));
  renderLista(); dibujarRuta(); actualizarNav();
  if (!orden.length && vistaActual === "mapa") irA("factura");
}

/* Ubicación del cliente en tiempo real → es el destino del pedido (salvo destino manual) */
function escucharCliente(v) {
  v.refCli = db.ref("pedidos/" + v.token + "/cliente");
  v.refCli.on("value", (s) => {
    const c = s.val();
    v.cliPos = c && typeof c.lat === "number" ? { lat: c.lat, lng: c.lng, manual: !!c.manual, ts: c.ts || 0, precision: c.precision || 0 } : null;
    if (v.cliPos && !v.destManual) v.destino = { lat: v.cliPos.lat, lng: v.cliPos.lng };
    pintarCliente(v);
    if (v.token === seleccionado) { dibujarRuta(); pedirRuta(v); }
    evaluarViaje(v);
    refrescarTextos();
  }, () => {});
}

/* Distancia, aviso de cercanía y envío de datos al cliente. `base` = posición del repartidor (si viene del GPS) */
function evaluarViaje(v, base) {
  const cambios = base ? Object.assign({}, base) : {};
  let dispararCerca = false;
  if (v.destino) {
    cambios.destLat = v.destino.lat; cambios.destLng = v.destino.lng;
    if (ultimaPos) {
      const dist = Math.round(distanciaM(ultimaPos.lat, ultimaPos.lng, v.destino.lat, v.destino.lng));
      v.dist = dist; cambios.distancia = dist;
      if (dist <= RADIO_AVISO_M && !v.cerca) { v.cerca = true; cambios.cerca = true; cambios.cercaTs = TS; dispararCerca = true; }
      else if (v.cerca && dist > RADIO_AVISO_M * 2) { v.cerca = false; cambios.cerca = false; }   // el cliente se alejó
    }
  }
  if (!Object.keys(cambios).length) return;
  db.ref("pedidos/" + v.token).update(cambios).then(() => {
    if (dispararCerca) { navigator.vibrate && navigator.vibrate([300, 150, 300]); refrescarTextos(); }
  }).catch((e) => {
    if (dispararCerca) v.cerca = false;   // no llegó: se reintenta en la siguiente posición
    setEstado("Error de red: " + e.message, "error");
  });
}

/* ---------- Chat por pedido (avisos por voz aunque el chat esté cerrado) ---------- */
function escucharChat(v) {
  v.refChat = db.ref("chats/" + v.token).limitToLast(1);
  v.chatListo = false;
  v.refChat.on("child_added", (s) => {
    if (!v.chatListo) return;                       // mensajes que ya existían al abrir la app
    const m = s.val();
    if (!m || m.de !== "cliente") return;
    Voz.hablar(orden.length > 1 && v.cliente ? `El cliente ${v.cliente} te ha escrito` : Voz.FRASES.mensajeCliente);
    navigator.vibrate && navigator.vibrate(200);
    if (chatToken !== v.token || document.hidden) notificarMensaje(v, m);
    if (chatToken !== v.token) { v.noLeidos++; refrescarTextos(); actualizarNav(); }
  }, () => {});
  v.refChat.once("value", () => { v.chatListo = true; });
}
function abrirChat(v) {
  Chat.iniciar({
    token: v.token, yo: "repartidor", pedido: v.pedido, nombreRepartidor: usuario, avisos: false,
    titulo: () => "Chat con " + (v.cliente || "el cliente"),
    subtitulo: () => "Pedido " + v.pedido,
    alCerrar: () => { chatToken = null; }
  });
  chatToken = v.token; v.noLeidos = 0;
  Chat.abrir();
  refrescarTextos(); actualizarNav();
}

/* ---------- Chat con Brothers (administración) ---------- */
function pintarBadgeAdmin() {
  const b = $("badgeAdmin"); b.textContent = noLeidosAdmin; b.classList.toggle("oculto", !noLeidosAdmin);
}
function abrirChatAdmin() {
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
  if (refAdminChat) { refAdminChat.off(); refAdminChat = null; }
  if (refGuia) { refGuia.off(); refGuia = null; }
  if (refLugares) { refLugares.off(); refLugares = null; }
  lugares = {}; pintarLugares(); quitarLugarDestino();
  OrdenAdminRep.detener();
  guiaActual = null; guiaTsVisto = undefined; noLeidosAdmin = 0; pintarBadgeAdmin(); pintarGuia();
}
function escucharAdmin() {
  soltarAdmin();
  adminListo = false;
  refAdminChat = db.ref(`chatsEquipo/${uidActual}`).limitToLast(1);
  refAdminChat.on("child_added", (s) => {
    if (!adminListo) return;
    const m = s.val();
    if (!m || m.de !== "admin") return;
    Voz.hablar(Voz.FRASES.mensajeAdmin);   // “Brothers te ha escrito”
    navigator.vibrate && navigator.vibrate(200);
    if (chatToken !== "equipo" || document.hidden) notificarTexto("Brothers", m.texto ? m.texto : "📷 Te envió una foto", "Administración", { equipo: "chat" });
    if (chatToken !== "equipo") { noLeidosAdmin++; pintarBadgeAdmin(); }
  }, () => {});
  refAdminChat.once("value", () => { adminListo = true; });

  // Guía de Brothers: solo para este repartidor (cada uno tiene la suya en guias/{su uid})
  if (refLugares) refLugares.off();
  refLugares = db.ref("lugares");
  refLugares.on("value", (s) => { lugares = s.val() || {}; pintarLugares(); if (!$("resBusqRep").classList.contains("oculto")) mostrarBusquedaRep(); }, () => {});

  refGuia = db.ref("guias/" + uidActual);
  refGuia.on("value", (s) => {
    const g = s.val(), primera = guiaTsVisto === undefined;
    if (g && g.ordenId) OrdenAdminRep.seguir(g.ordenId);   // pedido asignado por el administrador: tarjeta con Retirado / Entregado
    if (!g || typeof g.lat !== "number") { guiaActual = null; guiaTsVisto = null; pintarGuia(); dibujarRuta(); return; }
    if (primera && g.ts && Date.now() - g.ts > 12 * 3600 * 1000) { guiaTsVisto = g.ts; return; }   // guía vieja de otro día: se ignora
    const nueva = !primera && g.ts !== guiaTsVisto;
    guiaTsVisto = g.ts;
    aplicarGuia(g, nueva);
  }, () => {});
}
const iconoGuia = L.divIcon({ className: "", html: '<div class="pin-cli sel"><b>🏠</b></div><span class="etq-cli">Cliente (Brothers)</span>', iconSize: [34, 34], iconAnchor: [17, 17] });
const guiaCliente = () => (guiaActual && guiaActual.tipo !== "negocio" ? guiaActual : null);   // la guía a un negocio se maneja como destino libre
function pintarGuia() {   // sin pedido en curso se dibuja el pin de la guía; con pedido, la guía ya es su destino
  if (!mapa) return;
  if (guiaCliente() && !orden.length) {
    const p = [guiaActual.lat, guiaActual.lng];
    if (!marcaGuia) marcaGuia = L.marker(p, { icon: iconoGuia, zIndexOffset: 700 }).addTo(mapa); else marcaGuia.setLatLng(p);
  } else if (marcaGuia) { mapa.removeLayer(marcaGuia); marcaGuia = null; }
}
function aplicarGuia(g, nueva) {
  guiaActual = g;
  if (g.tipo === "negocio") {   // Brothers te manda a un negocio: se abre como destino con su ruta por calles
    irALugar({ nombre: g.nombre || "Negocio", lat: g.lat, lng: g.lng, icono: g.icono || "📍" }, !!nueva);
    if (nueva) {
      const aviso = g.punto ? `Brothers te asignó un punto de ${g.punto}` : "Brothers te ha indicado la ubicación de " + (g.nombre || "un negocio");
      Voz.hablar(aviso, { forzar: true });
      navigator.vibrate && navigator.vibrate([300, 150, 300]);
      notificarTexto("Brothers", g.punto ? `Te asignó un punto de ${g.punto}` : "Te indicó la ubicación de " + (g.nombre || "un negocio"), "Guía", { equipo: "guia" });
    }
    return;
  }
  const v = (g.token && viajes[g.token]) || (orden.length === 1 ? viajes[orden[0]] : null) || (orden.length ? viajes[seleccionado] : null);
  if (v) fijarDestino(v, g.lat, g.lng);   // el pedido toma esa ubicación como destino (el cliente también la ve)
  pintarGuia(); dibujarRuta();
  if (!nueva) return;
  Voz.hablar(Voz.FRASES.guiaAdmin, { forzar: true });   // “Brothers te ha indicado la ubicación del cliente”
  navigator.vibrate && navigator.vibrate([300, 150, 300]);
  notificarTexto("Brothers", "Te indicó la ubicación del cliente", "Guía", { equipo: "guia" });
  irA("mapa");
  if (v) seleccionar(v.token, true); else { seguirme = false; setTimeout(() => encuadrar(false), 200); }
}

/* ---------- Negocios del mapa, buscador y navegación a un lugar ---------- */
function pintarLugares() {
  if (!mapa) return;
  Object.keys(lugarMarks).forEach((id) => { if (!lugares[id]) { mapa.removeLayer(lugarMarks[id]); delete lugarMarks[id]; } });
  Object.entries(lugares).forEach(([id, l]) => {
    if (typeof l.lat !== "number") return;
    const clave = [l.nombre, l.icono].join("|");
    let m = lugarMarks[id];
    if (!m) {
      m = lugarMarks[id] = L.marker([l.lat, l.lng], { icon: Lugares.iconoMapa(l), zIndexOffset: 100 }).addTo(mapa);
      m._clave = clave;
      m.bindPopup(() => `<div class="pop-rep"><strong>${escHtml(l.icono || "📍")} ${escHtml(l.nombre)}</strong>${l.dir ? `<small>${escHtml(l.dir)}</small>` : ""}
        <div class="acciones-fila"><button class="mini pri" data-ir="${escHtml(id)}" type="button">🧭 Ir aquí</button></div></div>`, { offset: [0, -14], minWidth: 200 });
    } else { m.setLatLng([l.lat, l.lng]); if (m._clave !== clave) { m.setIcon(Lugares.iconoMapa(l)); m._clave = clave; } }
  });
}
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
  lugarDestino = { nombre: l.nombre, lat: l.lat, lng: l.lng, icono: l.icono || "📍" }; rutaLugar = null;
  $("resBusqRep").classList.add("oculto"); $("busqRep").blur();
  if (enfocar && vistaActual !== "mapa") irA("mapa");   // al restaurar una guía vieja no se cambia de pantalla
  initMapa(); pintarLugarDestino();
  if (enfocar) { seguirme = false; mapa.flyTo([l.lat, l.lng], 16); }
  pedirRutaLugar(true); actualizarBanner();
}
function pintarLugarDestino() {
  if (!mapa) return;
  if (!lugarDestino) { if (marcaLugar) { mapa.removeLayer(marcaLugar); marcaLugar = null; } return; }
  const p = [lugarDestino.lat, lugarDestino.lng], ic = Lugares.iconoMapa(lugarDestino, true);
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
    const r = await Ruta.pedir(o, destino);
    if (lugarDestino !== destino) return;
    Object.assign(rutaLugar, { rutaPts: r.pts, rutaPasos: r.pasos, rutaDur: r.dur, rutaDist: r.dist, rutaIdx: Math.min(1, r.pasos.length - 1) });
    Ruta.flechas(r.pts, flechasLugar, "#B45309");
  } catch (_) { /* sin ruta por calles: línea recta */ }
  dibujarRutaLugar(); actualizarBanner();
}
function dibujarRutaLugar() {
  if (!capaLugar) return;
  if (!lugarDestino || !ultimaPos) return capaLugar.setLatLngs([]);
  const aqui = [ultimaPos.lat, ultimaPos.lng];
  capaLugar.setLatLngs(rutaLugar && rutaLugar.rutaPts ? [aqui, ...rutaLugar.rutaPts] : [aqui, [lugarDestino.lat, lugarDestino.lng]]);
  capaLugar.setStyle({ opacity: rutaLugar && rutaLugar.rutaPts ? .9 : .5 });
}
/* Aviso de ruta: próximo giro, calle y distancia (calles de un solo sentido ya vienen resueltas en la ruta) */
function actualizarBanner() {
  const b = $("bannerRuta"); if (!b) return;
  const n = lugarDestino ? rutaLugar : viajes[seleccionado];
  const titulo = lugarDestino ? `${lugarDestino.icono} ${lugarDestino.nombre}` : (n ? "👤 " + nombreDe(n) : "");
  if (!lugarDestino && !(n && n.rutaPasos)) { b.classList.add("oculto"); return; }
  b.classList.remove("oculto");
  const cerrar = lugarDestino ? '<button id="brX" type="button" aria-label="Quitar destino">✕</button>' : "";
  if (!n || !n.rutaPasos || !ultimaPos) { b.innerHTML = `<div class="br-fila"><span class="br-ic">🧭</span><div class="br-txt"><b>Calculando ruta a ${escHtml(titulo)}…</b></div>${cerrar}</div>`; }
  else {
    const aqui = [ultimaPos.lat, ultimaPos.lng], pasos = n.rutaPasos;
    while (n.rutaIdx < pasos.length - 1 && Ruta.dist(aqui, [pasos[n.rutaIdx].loc.lat, pasos[n.rutaIdx].loc.lng]) < 30) n.rutaIdx++;
    const p = pasos[n.rutaIdx], [ic, tx] = Ruta.textoPaso(p), d = Math.round(Ruta.dist(aqui, [p.loc.lat, p.loc.lng]));
    b.innerHTML = `<div class="br-fila"><span class="br-ic">${ic}</span><div class="br-txt"><b>${escHtml(tx)}</b><small>${p.tipo === "arrive" ? "" : "en " + formatoDist(d) + " · "}${escHtml(titulo)}</small></div>${cerrar}</div>
      <small>${formatoDist(n.rutaDist)} · ≈ ${Math.max(1, Math.round(n.rutaDur / 60))} min${Ruta.calles(pasos) ? " · Vía: " + escHtml(Ruta.calles(pasos)) : ""}</small>`;
  }
  const x = $("brX"); if (x) x.onclick = quitarLugarDestino;
}

/* ---------- Lista de pedidos (hoja inferior del mapa) ---------- */
function renderLista() {
  const cont = $("hojaPedidos"), delAdmin = OrdenAdminRep.html();
  if (!orden.length) { cont.innerHTML = delAdmin + (delAdmin ? "" : '<p class="ayuda">No hay pedidos en ruta. Haz una factura y envíala por WhatsApp para iniciar el seguimiento.</p>'); return; }
  cont.innerHTML = delAdmin + '<p class="ayuda">Toca un pedido para verlo en el mapa. Entrégalos en el orden que prefieras.</p>' + orden.map((t, i) => {
    const v = viajes[t];
    return `<div class="pedido-card${t === seleccionado ? " sel" : ""}" data-token="${t}">
      <div class="pc-top">
        <span class="pc-num">${i + 1}</span>
        <div class="pc-datos"><strong>${escHtml(nombreDe(v))}</strong><small>Pedido ${escHtml(v.pedido)}</small><small class="pc-sub" id="sub-${t}"></small></div>
        <span class="chip" id="chip-${t}"></span>
      </div>
      <div class="pc-botones">
        <button class="boton-chat" data-acc="chat" type="button">💬 Chat <span class="badge oculto" id="bd-${t}">0</span></button>
        <button class="oscuro" data-acc="entregado" type="button">✓ Entregado</button>
      </div>
      <div class="pc-mas">
        <button class="mini pri" data-acc="sub" type="button">➕ Productos <span id="subbd-${t}"></span></button>
        <button class="mini" data-acc="wa" type="button">Reenviar al negocio</button>
        <button class="mini oculto" data-acc="usarcli" id="usarcli-${t}" type="button">Usar ubic. del cliente</button>
        <button class="mini peligro" data-acc="cancelar" type="button">Cancelar</button>
      </div>
    </div>`;
  }).join("");
  refrescarTextos();
}
function textoSub(v) {
  const p = [];
  if (v.sinFactura) p.push("enlace de contacto (aún sin factura)");
  p.push(v.destino ? (v.dist != null ? "a " + formatoDist(v.dist) : "calculando…") : "sin destino");
  if (v.rutaDur) p.push("≈ " + Math.max(1, Math.round(v.rutaDur / 60)) + " min");
  if (v.sub && v.sub.items && v.sub.items.length) p.push("🧾 " + SubFactura.ETIQUETA + ": gran total " + SubFactura.money(SubFactura.calcular(v.factura, v.sub).gran));
  p.push(v.destManual ? "destino marcado por ti" : !v.cliPos ? "el cliente aún no comparte ubicación" : v.cliPos.manual ? "ubicación marcada por el cliente" : esVivo(v) ? "cliente en vivo" : "cliente sin señal");
  return p.join(" · ");
}
function refrescarTextos() {
  orden.forEach((t) => {
    const v = viajes[t]; if (!v) return;
    const sub = $("sub-" + t); if (!sub) return;
    sub.textContent = textoSub(v);
    const chip = $("chip-" + t);
    chip.textContent = v.cerca ? "Cerca" : v.sinFactura ? "Sin factura" : esVivo(v) ? "En vivo" : "En ruta";
    chip.className = "chip " + (v.cerca ? "alerta" : "vivo");
    const bd = $("bd-" + t); bd.textContent = v.noLeidos; bd.classList.toggle("oculto", !v.noLeidos);
    $("usarcli-" + t).classList.toggle("oculto", !(v.destManual && v.cliPos));
    const sb = $("subbd-" + t); if (sb) sb.textContent = v.sub && v.sub.items && v.sub.items.length ? "(" + v.sub.items.length + ")" : "";
    pintarCliente(v);
  });
  actualizarNav();
}
setInterval(() => { if (orden.length) refrescarTextos(); }, 15000);   // el estado "en vivo" caduca solo

$("hojaPedidos").onclick = (e) => {
  if (OrdenAdminRep.alClick(e)) return;   // tarjeta del pedido asignado por el administrador
  const card = e.target.closest(".pedido-card"); if (!card) return;
  const v = viajes[card.dataset.token]; if (!v) return;
  const b = e.target.closest("button[data-acc]");
  if (!b) return seleccionar(v.token, true);
  const acc = b.dataset.acc;
  if (acc === "chat") abrirChat(v);
  else if (acc === "entregado") cerrarViaje(v.token, "entregado");
  else if (acc === "cancelar") cerrarViaje(v.token, "cancelado");
  else if (acc === "sub") SubFactura.abrir(v, ctxSub);
  else if (acc === "wa") abrirWhatsApp(mensajeSeguimiento(v));
  else if (acc === "usarcli") usarUbicacionCliente(v);
};

/* ============================================================
   APK: plugins nativos, permisos y notificaciones de mensajes
   ============================================================ */
const esNativo = () => { const C = window.Capacitor; return !!(C && ((C.isNativePlatform && C.isNativePlatform()) || (C.getPlatform && C.getPlatform() !== "web"))); };
function plug(nombre) {
  const C = window.Capacitor;
  if (!esNativo()) return null;
  if (C.isPluginAvailable && !C.isPluginAvailable(nombre)) return null;
  return (C.Plugins && C.Plugins[nombre]) || (C.registerPlugin && C.registerPlugin(nombre)) || null;
}
let notifLista = false, esperandoPermisos = null;

/* Ventana inicial que explica los permisos (ubicación todo el tiempo, notificaciones) y luego los pide */
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
    if (pedir) await ln.requestPermissions();   // ventana de Android: "¿Permitir notificaciones?"
    await ln.createChannel({ id: "mensajes", name: "Mensajes de clientes", description: "Avisos cuando un cliente te escribe", importance: 5, visibility: 1, vibration: true, lights: true });
    await ln.registerActionTypes({ types: [{ id: "MENSAJE", actions: [
      { id: "responder", title: "Responder", input: true, inputButtonTitle: "Enviar", inputPlaceholder: "Escribe tu respuesta" },
      { id: "abrir", title: "Abrir chat" }
    ] }] });
    if (!notifLista) { notifLista = true; ln.addListener("localNotificationActionPerformed", alAccionNotificacion); }
  } catch (e) { console.warn("Notificaciones:", e); }
}

/* ---------- Push (FCM): llega aunque la app esté cerrada o en otra app ---------- */
// ⚠️ Déjalo en false hasta completar GUIA-PUSH.md (google-services.json + plugin). Con true y sin eso, la app se cierra al abrir.
const PUSH_HABILITADO = false;
let pushActivo = false, abrirPendiente = null;
async function registrarPush() {
  if (!PUSH_HABILITADO) return;
  const PN = plug("PushNotifications");
  if (!PN || !uidActual) return;
  try {
    let p = await PN.checkPermissions();
    if (p.receive !== "granted") p = await PN.requestPermissions();
    if (p.receive !== "granted") return;
    await PN.createChannel({ id: "mensajes", name: "Mensajes de clientes", description: "Avisos cuando un cliente te escribe", importance: 5, visibility: 1, vibration: true });
    await PN.removeAllListeners();
    PN.addListener("registration", (t) => {
      pushActivo = true;   // con push activo no hace falta la notificación local (evita duplicados)
      db.ref(`repartidores/${uidActual}/fcmToken`).set(t.value).catch((e) => console.warn("fcmToken:", e.message));
    });
    PN.addListener("registrationError", (e) => console.warn("Push:", e));
    PN.addListener("pushNotificationActionPerformed", (ev) => {   // tocó la notificación
      const tk = ev.notification && ev.notification.data && ev.notification.data.token;
      if (!tk) return;
      if (viajes[tk]) { irA("mapa"); abrirChat(viajes[tk]); } else abrirPendiente = tk;
    });
    await PN.register();
  } catch (e) { console.warn("Push:", e); }
}

/* Notificación tipo WhatsApp: título + texto; se puede responder desde la propia notificación */
function notificarTexto(titulo, cuerpo, resumen, extra) {
  const ln = plug("LocalNotifications");
  if (!ln || !document.hidden) return;   // con la app a la vista basta la voz y la burbuja
  ln.schedule({ notifications: [{
    id: Math.floor(Math.random() * 2000000000), title: titulo, body: cuerpo, largeBody: cuerpo, summaryText: resumen,
    channelId: "mensajes", actionTypeId: "MENSAJE", extra
  }] }).catch(() => {});
}
function notificarMensaje(v, m) {
  if (pushActivo) return;
  notificarTexto(v.cliente ? "Cliente · " + v.cliente : "Cliente · Pedido " + v.pedido, m.texto ? m.texto : "📷 Te envió una foto", "Pedido " + v.pedido, { token: v.token });
}
function alAccionNotificacion(ev) {
  const extra = (ev && ev.notification && ev.notification.extra) || {};
  const texto = ev.inputValue && ev.inputValue.trim();
  if (extra.equipo) {   // aviso de Brothers (mensaje o guía)
    if (ev.actionId === "responder" && texto) {
      Chat.enviarA(uidActual, "repartidor", { pedido: "Equipo", nombreRepartidor: usuario }, texto.slice(0, 600), null, RUTA_EQUIPO).catch(() => {});
      return;
    }
    if (extra.equipo === "guia") { irA("mapa"); return; }
    return abrirChatAdmin();
  }
  const v = viajes[extra.token]; if (!v) return;
  if (ev.actionId === "responder" && texto) {
    Chat.enviarA(extra.token, "repartidor", { pedido: v.pedido, nombreRepartidor: usuario }, texto.slice(0, 600), null).catch(() => {});
    return;   // respondido sin abrir la app
  }
  irA("mapa"); abrirChat(v);   // tocar la notificación o "Abrir chat"
}

/* ============================================================
   Funciones nativas del APK: burbuja flotante, batería, ubicaciones compartidas
   ============================================================ */
const nativo = () => plug("Nativo");
let esperandoAjustes = false, nativoListo = false, alElegirCb = null;

async function iniciarNativo(forzarModal) {
  const n = nativo(); if (!n) return;
  if (!nativoListo) { nativoListo = true; n.addListener("entrante", alEntrante); }   // lo compartido/tocado en la burbuja llega aquí
  let e; try { e = await n.estado(); } catch (_) { return; }
  if (e.permiso) n.activar({ activo: true }).catch(() => {});   // burbuja activa mientras haya sesión
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

/* Lista para elegir un pedido (chat, destino…) */
function elegirPedido(titulo, cb, etiqueta, extra) {
  $("elegirTitulo").textContent = titulo; alElegirCb = cb;
  $("elegirLista").innerHTML = orden.map((t, i) => `<button class="oscuro" data-t="${t}" type="button">${i + 1}. ${etiqueta || ""}${escHtml(nombreDe(viajes[t]))} · ${escHtml(viajes[t].pedido)}</button>`).join("") + (extra || "");
  $("modalElegir").classList.remove("oculto");
}
$("elegirLista").onclick = (e) => {
  const b = e.target.closest("button[data-t]"); if (!b) return;
  $("modalElegir").classList.add("oculto");
  const cb = alElegirCb; alElegirCb = null; if (!cb) return;
  if (b.dataset.t === "__ir") return cb(null, "ir");
  if (viajes[b.dataset.t]) cb(viajes[b.dataset.t]);
};
$("btnElegirCancelar").onclick = () => { alElegirCb = null; $("modalElegir").classList.add("oculto"); };

function alEntrante(ev) {
  if (!ev) return;
  if (ev.accion) return accionBurbuja(ev.accion);
  if (ev.texto) recibirUbicacion(String(ev.texto));
}
/* Menú de la burbuja: Chat al cliente · Nueva factura · Ver ubicación */
function accionBurbuja(a) {
  if (a === "factura") return irA("factura");
  if (a === "ubicacion") {
    irA("mapa"); seguirme = true;
    if (mapa && ultimaPos) mapa.setView([ultimaPos.lat, ultimaPos.lng], 17);
    return;
  }
  if (a === "chat") {
    if (!orden.length) { irA("factura"); return alert("No tienes clientes en ruta para chatear."); }
    if (orden.length === 1) { irA("mapa"); return abrirChat(viajes[orden[0]]); }
    elegirPedido("¿Con qué cliente quieres chatear?", (v) => { irA("mapa"); abrirChat(v); });
  }
}
/* Ubicación compartida desde WhatsApp / Google Maps / Waze / geo: → ruta tipo Waze */
async function recibirUbicacion(texto) {
  let c = Buscar.coords(texto), nombre = "Ubicación compartida";
  const l1 = texto.split(/\r?\n/).map((x) => x.trim()).filter(Boolean).find((x) => !/^(https?:|geo:)/i.test(x) && !Buscar.coords(x));
  if (l1 && l1.length <= 60) nombre = l1;
  if (!c) {
    const m = texto.match(/https?:\/\/[^\s]+/i), n = nativo();
    if (m && n) {   // enlaces cortos (maps.app.goo.gl): se siguen hasta el enlace final para sacar las coordenadas
      try { const r = await n.resolverEnlace({ url: m[0] }); c = Buscar.coords(r.url) || (r.coords && Buscar.coords(r.coords)); } catch (_) { /* sin red */ }
    }
  }
  if (!c) return alert("No encontré una ubicación en lo que compartiste. Comparte un enlace de Google Maps, Waze, geo: o las coordenadas.\n\nNota: la ubicación EN TIEMPO REAL de WhatsApp solo se ve dentro de WhatsApp; usa “Contactarme al cliente” para que el cliente comparta la suya con tu app.");
  const lugar = { nombre, lat: c.lat, lng: c.lng, icono: "📍" };
  if (!orden.length) return irALugar(lugar, true);
  elegirPedido("📍 " + nombre + "\n¿Qué hacemos con esta ubicación?", (v, modo) => {
    if (modo === "ir" || !v) return irALugar(lugar, true);
    irA("mapa"); seleccionar(v.token, false);
    fijarDestino(v, c.lat, c.lng);   // pasa a ser el destino de ese pedido (el cliente también lo ve)
    seguirme = false; encuadrar(true);
  }, "Destino de ", '<button class="primario" data-t="__ir" type="button">🧭 Solo ir ahora (ruta)</button>');
}

/* ============================================================
   GPS permanente (turno)
   ============================================================ */
const plugin = () => plug("BackgroundGeolocation");

async function iniciarGPS() {
  if (watchId !== null || bgId !== null) return;
  bgPlugin = plugin();
  if (bgPlugin) {
    // APK: servicio en primer plano → sigue enviando con la app minimizada o la pantalla apagada
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
    // Navegador: solo mientras la pantalla esté activa
    if (!("geolocation" in navigator)) return setEstado("Este dispositivo no tiene GPS.", "error");
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
    watchId = navigator.geolocation.watchPosition(
      (pos) => procesarPosicion(pos.coords),
      (err) => setEstado(err.code === 1 ? "Permiso de ubicación denegado. Actívalo en Ajustes." : "Error GPS: " + err.message, "error"),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }
  // Latido: si estás quieto, el administrador sigue viéndote "en línea"
  latido = setInterval(() => {
    if (ultimaPos && uidActual) db.ref("ubicaciones/" + uidActual).update({ ts: TS, enLinea: true }).catch(() => {});
  }, 30000);
}
function detenerGPS() {
  if (watchId !== null) { navigator.geolocation.clearWatch(watchId); watchId = null; }
  if (bgId !== null && bgPlugin) { bgPlugin.removeWatcher({ id: bgId }); bgId = null; }
  clearInterval(latido); latido = null;
  try { wakeLock && wakeLock.release(); } catch (_) {}
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible") return;
  if (esperandoAjustes) { esperandoAjustes = false; iniciarNativo(true); }   // volvió de los ajustes de Android: se revisa de nuevo
  if (watchId !== null) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {} }
  if (mapa) { mapa.invalidateSize(); pintarYo(); dibujarRuta(); }   // muestra el trayecto recorrido en segundo plano
});

function procesarPosicion(c) {
  const lat = c.latitude, lng = c.longitude, precision = Math.round(c.accuracy || 0);
  const primera = !ultimaPos;
  ultimaPos = { lat, lng };

  // El mapa se mueve con cada lectura (sin esperar al envío a la nube) → el repartidor se ve a sí mismo en tiempo real
  if (orden.length) {
    const ult = rastro[rastro.length - 1];
    if (!ult || distanciaM(ult[0], ult[1], lat, lng) > 4) { rastro.push([lat, lng]); if (rastro.length > 800) rastro.shift(); guardarRastro(); }
  }
  pintarYo();
  if (mapa && vistaActual === "mapa") {
    if (primera && !orden.length) mapa.setView([lat, lng], 16);
    else if (seguirme && !mapa.getBounds().pad(-0.25).contains([lat, lng])) mapa.panTo([lat, lng]);
    dibujarRuta(); dibujarRutaLugar(); actualizarBanner();
  }

  const ahora = Date.now();
  if (ahora - ultimaEscritura < INTERVALO_MS) return;
  ultimaEscritura = ahora;

  // 1) Ubicación permanente → mapa del administrador (aunque no haya pedidos)
  db.ref("ubicaciones/" + uidActual).set({
    lat, lng, precision, rumbo: num(c.heading), velocidad: num(c.speed),
    ts: TS, enLinea: true, enViaje: orden.length > 0, usuario
  }).catch(() => {});

  // 2) Cada pedido en ruta → su cliente (posición, distancia, aviso de cercanía)
  const base = { lat, lng, precision, rumbo: num(c.heading), velocidad: num(c.speed), ts: TS };
  orden.forEach((t) => evaluarViaje(viajes[t], base));
  if (seleccionado) pedirRuta(viajes[seleccionado]);
  if (lugarDestino) pedirRutaLugar();
  refrescarTextos();
  setEstado(`Compartiendo ubicación · ±${precision} m` + (orden.length ? ` · ${orden.length} pedido${orden.length > 1 ? "s" : ""} en ruta` : "") + (bgPlugin ? " · segundo plano activo" : " · solo con pantalla activa (usa el APK)"), "ok");
}

/* ---------- "Contactarme al cliente": el negocio avisa al cliente con un enlace que abre el chat ---------- */
function enviarContacto(v) {
  const enlace = enlaceDe(v.token) + "&chat=1";   // abre el chat directamente en la página del cliente
  abrirWhatsApp(
    `📞 *SOLICITUD DE CONTACTO*\n🏍️ Repartidor: ${usuario}\n📦 Pedido ${v.pedido}${v.cliente ? " · Cliente: " + v.cliente : ""}\n\n` +
    `💬 El repartidor desea contactarse con usted, por favor presione el enlace para responderle:\n${enlace}`);
}
function nuevoContacto() {   // crea el MISMO enlace de seguimiento que crea la factura, sin hacer la factura todavía
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
  $("contactoLista").innerHTML = orden.map((t, i) => `<button class="oscuro" data-t="${t}" type="button">${i + 1}. ${escHtml(nombreDe(viajes[t]))} · ${escHtml(viajes[t].pedido)}${viajes[t].sinFactura ? " (sin factura)" : ""}</button>`).join("") +
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

/* ---------- WhatsApp: siempre al chat del negocio (el repartidor no contacta al cliente fuera de la app) ---------- */
const NEGOCIO_WA = "50586265619";
function abrirWhatsApp(msg) { window.open(`https://wa.me/${NEGOCIO_WA}?text=${encodeURIComponent(msg)}`, "_system"); }
const mensajeSeguimiento = (v) =>
  `🏍️ Repartidor: ${usuario}\n📦 Pedido ${v.pedido}${v.cliente ? " · " + v.cliente : ""}\n📍 Seguimiento en tiempo real: ${enlaceDe(v.token)}`;

/* ---------- Entregar / cancelar un pedido ---------- */
async function cerrarViaje(token, estadoFinal) {
  const v = viajes[token]; if (!v) return;
  const quien = nombreDe(v);
  if (!confirm(estadoFinal === "entregado" ? `¿Confirmar la entrega a ${quien}?` : `¿Cancelar el pedido de ${quien}?`)) return;
  v.cerrando = true;   // para que no avise "Brothers lo marcó" cuando lo cierra el propio repartidor
  try {
    await db.ref("pedidos/" + token).update({
      estado: estadoFinal, lat: null, lng: null, rumbo: null, velocidad: null, precision: null,
      destLat: null, destLng: null, distancia: null, cerca: null, cliente: null, fin: TS
    });
  } catch (e) { v.cerrando = false; return alert("No se pudo cerrar en la nube: " + e.message); }
  // La guía de Brothers se borra cuando entrega ESTANDO en el lugar que se le marcó (≤ 250 m); si cancela ese pedido, también
  const g = guiaCliente();
  if (g && (!g.token || g.token === token)) {
    const enElLugar = ultimaPos && distanciaM(ultimaPos.lat, ultimaPos.lng, g.lat, g.lng) <= 250;
    if ((estadoFinal === "entregado" && enElLugar) || (estadoFinal === "cancelado" && g.token === token)) db.ref("guias/" + uidActual).remove().catch(() => {});
  }
  quitarViaje(token);          // el GPS del turno sigue activo
  irA("factura");              // vuelve a la factura…
  if (estadoFinal === "entregado") mostrarEntregado(quien);   // …con la ventana para moverse entre pantallas
}
function mostrarEntregado(quien) {
  const n = orden.length;
  $("entregadoTxt").textContent = n
    ? `Pedido de ${quien} entregado. Te ${n === 1 ? "queda 1 pedido" : "quedan " + n + " pedidos"} en ruta.`
    : `Pedido de ${quien} entregado. No tienes más pedidos en ruta.`;
  $("btnVerMapa").classList.toggle("oculto", !n);
  $("modalEntregado").classList.remove("oculto");
}
$("btnOtraFactura").onclick = () => { $("modalEntregado").classList.add("oculto"); irA("factura"); };
$("btnVerMapa").onclick = () => { $("modalEntregado").classList.add("oculto"); irA("mapa"); };


/* ---------- Botón / gesto atrás: cierra de a una capa, sin cerrar la app ---------- */
Atras.iniciar([
  () => Chat.cerrarCapa(),
  () => { for (const id of ["modalSub", "modalEntregado", "modalContacto", "modalElegir", "modalBurbuja"]) if (!$(id).classList.contains("oculto")) { $(id).classList.add("oculto"); return true; } return false; },
  () => {   // ventanas de la factura
    if ($("invoicePopup").classList.contains("show")) { closePopup(); return true; }
    if ($("customConfirmModal").classList.contains("show")) { closeCustomConfirm(false); return true; }
    if ($("customAlertModal").classList.contains("show")) { closeCustomAlert(); return true; }
    if ($("depositPromptPopup").classList.contains("show")) { $("depositPromptPopup").classList.remove("show"); return true; }
    return false;
  },
  () => { if (mapa && mapa._popup && mapa._popup.isOpen && mapa._popup.isOpen()) { mapa.closePopup(); return true; } return false; },
  () => { if (!$("resBusqRep").classList.contains("oculto") || document.activeElement === $("busqRep")) { cerrarBusquedaRep(); return true; } return false; },   // atrás sale del buscador y deja ver el mapa completo
  () => { if (marcando) { marcando = false; $("btnMarcarDestino").classList.remove("activo"); $("avisoMarcar").classList.add("oculto"); return true; } return false; },
  () => { if ($("invoiceContainer").style.display === "none") { hideStats(); return true; } return false; },   // pantalla de estadísticas
  () => { if (vistaActual === "mapa" && uidActual) { irA("factura"); return true; } return false; }
]);


/* ---------- Pedido asignado por el administrador (ordenes-repartidor.js) ---------- */
OrdenAdminRep.init({ db, alCambiar: () => renderLista(), alEntregado: () => quitarLugarDestino() });
