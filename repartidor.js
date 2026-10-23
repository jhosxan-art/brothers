/* ============================================================
   MÓDULO REPARTIDOR
   - Turno: la ubicación se comparte SIEMPRE mientras haya sesión (mapa del administrador)
   - Viajes: enlace de rastreo, destino con aviso a 200 m, chat con el cliente
   - En el APK (Capacitor) el GPS sigue en segundo plano; en el navegador solo con la pantalla activa
   ============================================================ */
const auth = firebase.auth();
const db = firebase.database();
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;

let watchId = null, bgId = null, bgPlugin = null, latido = null, wakeLock = null;
let uidActual = null, usuario = null, ultimaPos = null, ultimaEscritura = 0;
let tokenActivo = null, telActivo = "", pedidoActivo = "";
let destino = null, cercaEnviado = false, mapa = null, marcaDestino = null;
const INTERVALO_MS = 4000;   // máximo 1 escritura de GPS cada 4 s
const RADIO_AVISO_M = 200;   // distancia que dispara la alerta al cliente
const iconoDestino = iconoPin();

/* ---------- Utilidades ---------- */
function setEstado(texto, tipo = "") {
  ["estadoGps", "estadoTurno"].forEach((id) => { const el = $(id); el.textContent = texto; el.className = "estado " + tipo; });
}
function generarToken(largo = 14) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
const enlaceDe = (token) => `${URL_RASTREO}?id=${token}`;
const num = (x) => (Number.isFinite(x) ? x : null);
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- Vistas ---------- */
function mostrar(vista) {
  ["vistaLogin", "vistaUsuario", "vistaNuevo", "vistaActivo"].forEach((v) => $(v).classList.toggle("oculto", v !== vista));
  $("btnSalir").classList.toggle("oculto", vista === "vistaLogin");
  if (vista !== "vistaNuevo" && vista !== "vistaActivo") return;
  const d = $("vistaDestino");
  if (vista === "vistaNuevo") $("vistaNuevo").insertBefore(d, $("btnIniciar"));
  else $("vistaActivo").appendChild(d);
  initMapa();
  setTimeout(() => mapa.invalidateSize(), 50);
}

/* ---------- Sesión y nombre de usuario ---------- */
$("btnLogin").onclick = () =>
  auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
      .catch((e) => alert("No se pudo entrar: " + e.message));

auth.onAuthStateChanged(async (user) => {
  if (!user) {
    detenerGPS(); uidActual = null; usuario = null; $("clave").value = "";
    return mostrar("vistaLogin");
  }
  uidActual = user.uid;
  let reg;
  try { reg = (await db.ref("repartidores/" + user.uid).once("value")).val(); }
  catch (e) { return alert("No se pudo verificar tu cuenta. Revisa tu conexión o pide al administrador que revise los permisos."); }
  if (!reg) { alert("Tu cuenta no está registrada como repartidor. Pide al administrador que te agregue."); return auth.signOut(); }
  usuario = typeof reg === "object" && reg.usuario ? reg.usuario : null;
  if (!usuario) return mostrar("vistaUsuario");   // primera vez: pedir nombre de usuario
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

function entrarTurno() {
  // Si se corta la conexión, el administrador lo verá como "desconectado"
  db.ref("ubicaciones/" + uidActual).onDisconnect().update({ enLinea: false, enViaje: false, ts: TS });
  const guardado = JSON.parse(localStorage.getItem("viajeActivo") || "null");
  if (guardado && guardado.uid === uidActual) reanudar(guardado);
  else mostrar("vistaNuevo");
  iniciarGPS();
}

$("btnSalir").onclick = async () => {
  if (tokenActivo) return alert("Primero finaliza o cancela el viaje en curso.");
  if (!confirm("¿Cerrar sesión? Dejarás de compartir tu ubicación.")) return;
  detenerGPS();
  try {
    await db.ref("ubicaciones/" + uidActual).update({ enLinea: false, enViaje: false, ts: TS });
    db.ref("ubicaciones/" + uidActual).onDisconnect().cancel();
  } catch (_) {}
  await auth.signOut();
};

/* ---------- Mapa de destino ---------- */
function initMapa() {
  if (mapa) return;
  mapa = L.map("mapaDestino").setView([-12.0464, -77.0428], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
  mapa.on("click", (e) => fijarDestino(e.latlng.lat, e.latlng.lng));
  if (ultimaPos) mapa.setView([ultimaPos.lat, ultimaPos.lng], 15);
}
function ponerMarcador(lat, lng) {
  if (!marcaDestino) marcaDestino = L.marker([lat, lng], { icon: iconoDestino }).addTo(mapa);
  else marcaDestino.setLatLng([lat, lng]);
  $("destinoTxt").textContent = `Destino marcado ✔ (aviso a ${RADIO_AVISO_M} m)`;
}
function fijarDestino(lat, lng) {
  destino = { lat, lng }; cercaEnviado = false;
  $("btnCerca").classList.add("oculto");
  ponerMarcador(lat, lng);
  if (tokenActivo)
    db.ref("pedidos/" + tokenActivo).update({ destLat: lat, destLng: lng, cerca: false, distancia: null });
}
function limpiarDestinoLocal() {
  destino = null; cercaEnviado = false;
  if (marcaDestino) { mapa.removeLayer(marcaDestino); marcaDestino = null; }
  $("destinoTxt").textContent = "Sin destino marcado";
  $("btnCerca").classList.add("oculto");
}
$("btnQuitarDestino").onclick = () => {
  limpiarDestinoLocal();
  if (tokenActivo) db.ref("pedidos/" + tokenActivo).update({ destLat: null, destLng: null, cerca: null, distancia: null });
};

/* ---------- Viaje: iniciar / reanudar ---------- */
$("btnIniciar").onclick = async () => {
  const token = generarToken();
  const pedido = $("inputPedido").value.trim() || "P-" + Date.now().toString(36).toUpperCase();
  const tel = $("inputTel").value.replace(/\D/g, "");
  const datos = {
    estado: "en_ruta", pedido, inicio: TS,
    repartidorUid: uidActual, repartidorNombre: usuario   // el cliente y el administrador ven este nombre
  };
  if (destino) { datos.destLat = destino.lat; datos.destLng = destino.lng; datos.cerca = false; }
  try { await db.ref("pedidos/" + token).set(datos); }
  catch (e) { return alert("Error al crear el pedido: " + e.message); }
  localStorage.setItem("viajeActivo", JSON.stringify({ token, tel, pedido, uid: uidActual }));
  reanudar({ token, tel, pedido });
};

function reanudar({ token, tel, pedido }) {
  tokenActivo = token; telActivo = tel || ""; pedidoActivo = pedido || "";
  $("enlaceTxt").textContent = enlaceDe(token);
  mostrar("vistaActivo");
  Chat.iniciar({
    token, yo: "repartidor", pedido: pedidoActivo, nombreRepartidor: usuario,
    titulo: () => "Chat con el cliente",
    subtitulo: (c) => (c.pedido ? "Pedido " + c.pedido : ""),
    alNoLeidos: (n) => { const b = $("badgeChat"); b.textContent = n; b.classList.toggle("oculto", !n); }
  });
  // Recuperar destino y estado del aviso (por si la app se reinició)
  db.ref("pedidos/" + token).once("value").then((s) => {
    const d = s.val() || {};
    if (d.pedido) { pedidoActivo = d.pedido; Chat.setContexto({ pedido: d.pedido }); }
    if (typeof d.destLat === "number") { destino = { lat: d.destLat, lng: d.destLng }; ponerMarcador(d.destLat, d.destLng); }
    cercaEnviado = d.cerca === true;
    if (cercaEnviado) $("btnCerca").classList.remove("oculto");
  });
}
$("btnChat").onclick = () => Chat.abrir();

/* ---------- GPS permanente (turno) ---------- */
function plugin() {
  const C = window.Capacitor;
  if (!C) return null;
  const nativo = (C.isNativePlatform && C.isNativePlatform()) || (C.getPlatform && C.getPlatform() !== "web");
  if (!nativo) return null;
  return (C.Plugins && C.Plugins.BackgroundGeolocation) || (C.registerPlugin && C.registerPlugin("BackgroundGeolocation")) || null;
}

async function iniciarGPS() {
  if (watchId !== null || bgId !== null) return;
  bgPlugin = plugin();
  if (bgPlugin) {
    // APK: servicio en primer plano → sigue enviando con la app minimizada o la pantalla apagada
    bgId = await bgPlugin.addWatcher(
      { backgroundTitle: "Turno activo", backgroundMessage: "Compartiendo tu ubicación con Brother’s Deliverys",
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
  if (document.visibilityState === "visible" && watchId !== null) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
  }
});

function procesarPosicion(c) {
  const lat = c.latitude, lng = c.longitude, precision = Math.round(c.accuracy || 0);
  ultimaPos = { lat, lng };
  const ahora = Date.now();
  if (ahora - ultimaEscritura < INTERVALO_MS) return;
  ultimaEscritura = ahora;

  // 1) Ubicación permanente → mapa del administrador (aunque no haya viaje)
  db.ref("ubicaciones/" + uidActual).set({
    lat, lng, precision, rumbo: num(c.heading), velocidad: num(c.speed),
    ts: TS, enLinea: true, enViaje: !!tokenActivo, usuario
  }).catch(() => {});

  // 2) Si hay viaje en curso → también al cliente
  let dist = null;
  if (tokenActivo) {
    const cambios = { lat, lng, precision, rumbo: num(c.heading), velocidad: num(c.speed), ts: TS };
    let dispararCerca = false;
    if (destino) {
      dist = Math.round(distanciaM(lat, lng, destino.lat, destino.lng));
      cambios.distancia = dist;
      if (dist <= RADIO_AVISO_M && !cercaEnviado) { cambios.cerca = true; cambios.cercaTs = TS; dispararCerca = true; }
    }
    db.ref("pedidos/" + tokenActivo).update(cambios).then(() => {
      if (dispararCerca && !cercaEnviado) {
        cercaEnviado = true;
        navigator.vibrate && navigator.vibrate([300, 150, 300]);
        $("btnCerca").classList.remove("oculto");
      }
    }).catch((e) => setEstado("Error de red: " + e.message, "error"));
  }
  setEstado(`Compartiendo ubicación · ±${precision} m` + (dist !== null ? ` · destino a ${dist} m` : ""), "ok");
}

/* ---------- WhatsApp ---------- */
function abrirWhatsApp(msg) {
  const base = telActivo ? `https://wa.me/${telActivo}` : "https://wa.me/";
  window.open(`${base}?text=${encodeURIComponent(msg)}`, "_system");
}
$("btnWhatsapp").onclick = () =>
  abrirWhatsApp(`Hola 👋 Tu pedido de Brother’s Deliverys ya va en camino con ${usuario}. Síguelo en tiempo real aquí: ${enlaceDe(tokenActivo)}`);
$("btnCerca").onclick = () =>
  abrirWhatsApp("📦 Tu repartidor de Brother’s Deliverys está a menos de 200 metros. ¡Sal a recibir tu pedido!");
$("btnCopiar").onclick = async () => {
  try { await navigator.clipboard.writeText(enlaceDe(tokenActivo)); setEstado("Enlace copiado.", "ok"); }
  catch (_) { prompt("Copia el enlace:", enlaceDe(tokenActivo)); }
};

/* ---------- Finalizar / cancelar ---------- */
async function cerrarViaje(estadoFinal) {
  if (!confirm(estadoFinal === "entregado" ? "¿Confirmar entrega?" : "¿Cancelar este viaje?")) return;
  Chat.detener();   // el repartidor no conserva ningún rastro del chat (el administrador sí lo archiva)
  try {
    await db.ref("pedidos/" + tokenActivo).update({
      estado: estadoFinal, lat: null, lng: null, rumbo: null, velocidad: null, precision: null,
      destLat: null, destLng: null, distancia: null, cerca: null, fin: TS
    });
  } catch (e) { return alert("No se pudo cerrar en la nube: " + e.message); }
  localStorage.removeItem("viajeActivo");
  tokenActivo = null; telActivo = ""; pedidoActivo = "";
  limpiarDestinoLocal();
  $("inputPedido").value = ""; $("inputTel").value = "";
  mostrar("vistaNuevo");   // el GPS del turno sigue activo
}
$("btnFinalizar").onclick = () => cerrarViaje("entregado");
$("btnCancelar").onclick = () => cerrarViaje("cancelado");
