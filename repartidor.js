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
let chatToken = null;        // token cuyo chat está abierto ahora
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
  $("mainAuth").classList.toggle("oculto", vista === "app");
  $("vistaLogin").classList.toggle("oculto", vista !== "login");
  $("vistaUsuario").classList.toggle("oculto", vista !== "usuario");
  $("btnSalir").classList.toggle("oculto", vista === "login");
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
    initMapa();
    setTimeout(() => { mapa.invalidateSize(); encuadrar(); }, 60);
  }
}
function actualizarNav() {
  const hay = orden.length > 0 && !!uidActual && !!usuario;
  $("navApp").classList.toggle("oculto", !hay);
  document.body.classList.toggle("con-nav", !!hay);
  $("navFactura").classList.toggle("activa", vistaActual === "factura");
  $("navMapa").classList.toggle("activa", vistaActual === "mapa");
  const sinLeer = orden.reduce((t, k) => t + (viajes[k] ? viajes[k].noLeidos : 0), 0);
  const b = $("badgeNav");
  b.textContent = sinLeer ? "💬 " + sinLeer : String(orden.length);
  b.classList.toggle("rojo", sinLeer > 0);
  b.classList.toggle("oculto", !orden.length);
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

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    detenerGPS(); soltarViajesEnMemoria(); uidActual = null; usuario = null; $("clave").value = "";
    return mostrar("login");
  }
  uidActual = user.uid;
  let reg;
  try { reg = (await db.ref("repartidores/" + user.uid).once("value")).val(); }
  catch (e) {
    msgLogin("No se pudo verificar tu cuenta (sin conexión o reglas de Firebase sin actualizar).");
    return auth.signOut();
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
  vistaActual = "factura";          // lo primero que ve el repartidor: la factura
  mostrar("app");
  Factura.nombreRepartidor = usuario;
  reanudarViajes();                 // por si la app se cerró con pedidos en ruta
  await permisosInicio();           // APK: explica y pide permisos (notificaciones…)
  registrarPush();                  // avisos push con la app cerrada
  iniciarGPS();                     // y aquí Android pide la ubicación (“todo el tiempo”)
}

$("btnSalir").onclick = async () => {
  if (orden.length) return alert("Primero entrega o cancela los pedidos en curso.");
  if (!confirm("¿Cerrar sesión? Dejarás de compartir tu ubicación.")) return;
  detenerGPS();
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
  mapa = L.map("mapaRuta", { zoomControl: false }).setView([-12.0464, -77.0428], 14);
  L.control.zoom({ position: "bottomright" }).addTo(mapa);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
  // Recorrido del repartidor (lo que ya avanzó) + ruta hacia el cliente (con línea animada encima)
  estelaProp = L.polyline([], { color: "#7B8794", weight: 5, opacity: .65 }).addTo(mapa);
  capaRuta = L.polyline([], { color: "#0A86C9", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
  capaFlujo = L.polyline([], { color: "#fff", weight: 3, opacity: .95, className: "ruta-viva" }).addTo(mapa);
  mapa.on("click", (e) => { if (marcando) fijarDestinoManual(e.latlng.lat, e.latlng.lng); });
  mapa.on("dragstart", () => { seguirme = false; });
  if (ultimaPos) { pintarYo(); mapa.setView([ultimaPos.lat, ultimaPos.lng], 15); }
  orden.forEach((t) => pintarCliente(viajes[t]));
  dibujarRuta();
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
  try {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`);
    const j = await r.json();
    if (j.code === "OK" && j.routes && j.routes[0]) {
      v.rutaPts = j.routes[0].geometry.coordinates.map(([x, y]) => [y, x]);
      v.rutaDur = j.routes[0].duration; v.rutaOrigen = o; v.rutaDest = d;
    }
  } catch (_) { /* sin ruta por calles: se usa la línea recta */ }
  if (v.token === seleccionado) dibujarRuta();
  refrescarTextos();
}
function dibujarRuta() {
  if (!mapa) return;
  const v = viajes[seleccionado];
  let pts = [];
  if (v && v.destino && ultimaPos) {
    pts = v.rutaPts ? [[ultimaPos.lat, ultimaPos.lng], ...v.rutaPts] : [[ultimaPos.lat, ultimaPos.lng], [v.destino.lat, v.destino.lng]];
  }
  capaRuta.setLatLngs(pts); capaFlujo.setLatLngs(pts);
  capaRuta.setStyle({ opacity: v && v.rutaPts ? .9 : .5 });
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
    const mios = orden.map((t) => ({ token: t, tel: viajes[t].tel, pedido: viajes[t].pedido, cliente: viajes[t].cliente, destManual: viajes[t].destManual, uid: uidActual }));
    localStorage.setItem("viajesActivos", JSON.stringify(otros.concat(mios)));
  } catch (_) {}
}
function crearViaje(info) {
  const v = {
    token: info.token, tel: info.tel || "", pedido: info.pedido || "", cliente: info.cliente || "",
    destManual: !!info.destManual, destino: null, cliPos: null, cerca: false, dist: null,
    marca: null, marcaCli: null, refCli: null, refChat: null, noLeidos: 0, chatListo: false,
    rutaPts: null, rutaEn: 0, rutaOrigen: null, rutaDest: null, rutaDur: null
  };
  viajes[v.token] = v;
  if (!orden.includes(v.token)) orden.push(v.token);
  escucharCliente(v);
  escucharChat(v);
  return v;
}

/* Nuevo pedido: lo llama factura.js cuando se pulsa "Enviar factura por WhatsApp" */
Factura.alEnviar = (f) => {
  if (!uidActual || !usuario) return;
  if (orden.length === 0) rastro = [];
  const v = crearViaje({ token: f.token, tel: f.tel, pedido: f.pedido, cliente: f.cliente });
  guardarViajes();
  // El pedido se crea en la nube (se aplica de inmediato en el aparato y se sincroniza)
  db.ref("pedidos/" + f.token).set({
    estado: "en_ruta", pedido: f.pedido, inicio: TS,
    repartidorUid: uidActual, repartidorNombre: usuario
  }).catch((e) => {
    quitarViaje(f.token);
    alert("No se pudo activar el seguimiento: " + e.message);
  });
  seleccionado = v.token;
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
  if (orden.length) {
    seleccionado = orden[0]; renderLista();
    if (abrirPendiente && viajes[abrirPendiente]) { const v0 = viajes[abrirPendiente]; abrirPendiente = null; irA("mapa"); abrirChat(v0); }
    try { const r = JSON.parse(localStorage.getItem("rastroViaje") || "null"); if (r && r.uid === uidActual && Array.isArray(r.pts)) rastro = r.pts; } catch (_) {}
  }
  actualizarNav();
}

function soltarViajesEnMemoria() {   // al cerrar sesión: no borra nada en la nube ni en localStorage
  orden.forEach((t) => { const v = viajes[t]; if (!v) return; v.refCli && v.refCli.off(); v.refChat && v.refChat.off(); if (mapa) { v.marca && mapa.removeLayer(v.marca); v.marcaCli && mapa.removeLayer(v.marcaCli); } delete viajes[t]; });
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
  v.refCli && v.refCli.off(); v.refChat && v.refChat.off();
  if (chatToken === token) { Chat.detener(); chatToken = null; }   // el repartidor no conserva rastro del chat
  if (mapa) { v.marca && mapa.removeLayer(v.marca); v.marcaCli && mapa.removeLayer(v.marcaCli); }
  delete viajes[token];
  orden = orden.filter((t) => t !== token);
  if (seleccionado === token) seleccionado = orden[0] || null;
  if (!orden.length) { rastro = []; try { localStorage.removeItem("rastroViaje"); } catch (_) {} if (estelaProp) estelaProp.setLatLngs([]); }
  guardarViajes();
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

/* ---------- Lista de pedidos (hoja inferior del mapa) ---------- */
function renderLista() {
  const cont = $("hojaPedidos");
  if (!orden.length) { cont.innerHTML = '<p class="ayuda">No hay pedidos en ruta. Haz una factura y envíala por WhatsApp para iniciar el seguimiento.</p>'; return; }
  cont.innerHTML = '<p class="ayuda">Toca un pedido para verlo en el mapa. Entrégalos en el orden que prefieras.</p>' + orden.map((t, i) => {
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
  p.push(v.destino ? (v.dist != null ? "a " + formatoDist(v.dist) : "calculando…") : "sin destino");
  if (v.rutaDur) p.push("≈ " + Math.max(1, Math.round(v.rutaDur / 60)) + " min");
  p.push(v.destManual ? "destino marcado por ti" : !v.cliPos ? "el cliente aún no comparte ubicación" : v.cliPos.manual ? "ubicación marcada por el cliente" : esVivo(v) ? "cliente en vivo" : "cliente sin señal");
  return p.join(" · ");
}
function refrescarTextos() {
  orden.forEach((t) => {
    const v = viajes[t]; if (!v) return;
    const sub = $("sub-" + t); if (!sub) return;
    sub.textContent = textoSub(v);
    const chip = $("chip-" + t);
    chip.textContent = v.cerca ? "Cerca" : esVivo(v) ? "En vivo" : "En ruta";
    chip.className = "chip " + (v.cerca ? "alerta" : "vivo");
    const bd = $("bd-" + t); bd.textContent = v.noLeidos; bd.classList.toggle("oculto", !v.noLeidos);
    $("usarcli-" + t).classList.toggle("oculto", !(v.destManual && v.cliPos));
    pintarCliente(v);
  });
  actualizarNav();
}
setInterval(() => { if (orden.length) refrescarTextos(); }, 15000);   // el estado "en vivo" caduca solo

$("hojaPedidos").onclick = (e) => {
  const card = e.target.closest(".pedido-card"); if (!card) return;
  const v = viajes[card.dataset.token]; if (!v) return;
  const b = e.target.closest("button[data-acc]");
  if (!b) return seleccionar(v.token, true);
  const acc = b.dataset.acc;
  if (acc === "chat") abrirChat(v);
  else if (acc === "entregado") cerrarViaje(v.token, "entregado");
  else if (acc === "cancelar") cerrarViaje(v.token, "cancelado");
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
let pushActivo = false, abrirPendiente = null;
async function registrarPush() {
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

/* Notificación tipo WhatsApp: título = cliente, cuerpo = su mensaje; se puede responder desde la propia notificación */
function notificarMensaje(v, m) {
  const ln = plug("LocalNotifications");
  if (!ln || !document.hidden || pushActivo) return;   // con la app a la vista basta la voz y la burbuja
  const cuerpo = m.texto ? m.texto : "📷 Te envió una foto";
  ln.schedule({ notifications: [{
    id: Math.floor(Math.random() * 2000000000), title: v.cliente ? "Cliente · " + v.cliente : "Cliente · Pedido " + v.pedido,
    body: cuerpo, largeBody: cuerpo, summaryText: "Pedido " + v.pedido,
    channelId: "mensajes", actionTypeId: "MENSAJE", extra: { token: v.token }
  }] }).catch(() => {});
}
function alAccionNotificacion(ev) {
  const token = ev && ev.notification && ev.notification.extra && ev.notification.extra.token;
  const v = viajes[token]; if (!v) return;
  if (ev.actionId === "responder" && ev.inputValue && ev.inputValue.trim()) {
    Chat.enviarA(token, "repartidor", { pedido: v.pedido, nombreRepartidor: usuario }, ev.inputValue.trim().slice(0, 600), null).catch(() => {});
    return;   // respondido sin abrir la app
  }
  irA("mapa"); abrirChat(v);   // tocar la notificación o "Abrir chat"
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
    dibujarRuta();
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
  refrescarTextos();
  setEstado(`Compartiendo ubicación · ±${precision} m` + (orden.length ? ` · ${orden.length} pedido${orden.length > 1 ? "s" : ""} en ruta` : "") + (bgPlugin ? " · segundo plano activo" : " · solo con pantalla activa (usa el APK)"), "ok");
}

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
  try {
    await db.ref("pedidos/" + token).update({
      estado: estadoFinal, lat: null, lng: null, rumbo: null, velocidad: null, precision: null,
      destLat: null, destLng: null, distancia: null, cerca: null, cliente: null, fin: TS
    });
  } catch (e) { return alert("No se pudo cerrar en la nube: " + e.message); }
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
