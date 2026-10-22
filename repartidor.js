/* ============================================================
   MÓDULO REPARTIDOR — GPS, destino, aviso a 200 m y sesión
   ============================================================ */
const auth = firebase.auth();
const db = firebase.database();
const $ = (id) => document.getElementById(id);

let watchId = null;        // ID de watchPosition (para clearWatch)
let tokenActivo = null;    // token único del viaje en curso
let telActivo = "";
let wakeLock = null;
let ultimaEscritura = 0;
let destino = null;        // {lat, lng} donde recibe el cliente
let cercaEnviado = false;  // ya se avisó que está a ≤ 200 m
let mapa = null, marcaDestino = null;
const INTERVALO_MS = 3000;
const RADIO_AVISO_M = 200; // distancia que dispara la alerta al cliente

const iconoDestino = iconoPin();   // pin rojo de la marca (iconos.js)

/* ---------- Utilidades ---------- */
function setEstado(texto, tipo = "") {
  const el = $("estadoGps"); el.textContent = texto; el.className = "estado " + tipo;
}
function generarToken(largo = 14) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
const enlaceDe = (token) => `${URL_RASTREO}?id=${token}`;

/* Distancia en metros entre dos coordenadas (fórmula de Haversine) */
function distanciaM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- Vistas ---------- */
function mostrar(vista) {
  ["vistaLogin", "vistaNuevo", "vistaActivo"].forEach((v) => $(v).classList.toggle("oculto", v !== vista));
  $("btnSalir").classList.toggle("oculto", vista === "vistaLogin");
  if (vista === "vistaLogin") return;
  // El mapa de destino vive dentro de la vista visible (encima del botón en "nuevo", al final en "activo")
  const d = $("vistaDestino");
  if (vista === "vistaNuevo") $("vistaNuevo").insertBefore(d, $("btnIniciar"));
  else $("vistaActivo").appendChild(d);
  initMapa();
  setTimeout(() => mapa.invalidateSize(), 50);
}

/* ---------- Sesión: entrar y cerrar sesión ---------- */
auth.onAuthStateChanged((user) => {
  if (!user) { $("clave").value = ""; return mostrar("vistaLogin"); }
  const guardado = JSON.parse(localStorage.getItem("viajeActivo") || "null");
  if (guardado) reanudar(guardado);
  else mostrar("vistaNuevo");
});
$("btnLogin").onclick = () =>
  auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
      .catch((e) => alert("No se pudo entrar: " + e.message));

$("btnSalir").onclick = async () => {
  // Si cerráramos sesión con un viaje abierto, el GPS dejaría de poder escribir
  if (tokenActivo) return alert("Primero finaliza o cancela el viaje en curso.");
  if (!confirm("¿Cerrar sesión?")) return;
  await auth.signOut();
};

/* ---------- Mapa de destino ---------- */
function initMapa() {
  if (mapa) return;
  mapa = L.map("mapaDestino").setView([-12.0464, -77.0428], 13);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
  mapa.on("click", (e) => fijarDestino(e.latlng.lat, e.latlng.lng));
  // Centrar el mapa donde está el repartidor
  navigator.geolocation?.getCurrentPosition(
    (p) => { if (!destino) mapa.setView([p.coords.latitude, p.coords.longitude], 15); },
    () => {}, { timeout: 8000 });
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
  if (tokenActivo) // viaje en curso: actualizar en la nube y reiniciar el aviso
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

/* ---------- Iniciar viaje ---------- */
$("btnIniciar").onclick = async () => {
  const token = generarToken();
  const pedido = $("inputPedido").value.trim() || "P-" + Date.now().toString(36).toUpperCase();
  const tel = $("inputTel").value.replace(/\D/g, "");
  const datos = {
    estado: "en_ruta", pedido, inicio: firebase.database.ServerValue.TIMESTAMP,
    repartidorUid: auth.currentUser.uid,                              // para el panel del administrador
    repartidorNombre: nombreDesdeCorreo(auth.currentUser.email)       // nombre visible (no se guarda el correo)
  };
  if (destino) { datos.destLat = destino.lat; datos.destLng = destino.lng; datos.cerca = false; }
  try { await db.ref("pedidos/" + token).set(datos); }
  catch (e) { return alert("Error al crear el pedido: " + e.message); }
  localStorage.setItem("viajeActivo", JSON.stringify({ token, tel }));
  reanudar({ token, tel });
};

function reanudar({ token, tel }) {
  tokenActivo = token; telActivo = tel;
  $("enlaceTxt").textContent = enlaceDe(token);
  mostrar("vistaActivo");
  // Recuperar destino y estado del aviso (por si la app se cerró y volvió a abrir)
  db.ref("pedidos/" + token).once("value").then((s) => {
    const d = s.val() || {};
    if (typeof d.destLat === "number") { destino = { lat: d.destLat, lng: d.destLng }; ponerMarcador(d.destLat, d.destLng); }
    cercaEnviado = d.cerca === true;
    if (cercaEnviado) $("btnCerca").classList.remove("oculto");
  });
  iniciarGPS();
}

/* ---------- GPS en tiempo real + aviso de cercanía ---------- */
async function iniciarGPS() {
  if (!("geolocation" in navigator)) return setEstado("Este dispositivo no tiene GPS.", "error");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}

  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const ahora = Date.now();
      if (ahora - ultimaEscritura < INTERVALO_MS) return;
      ultimaEscritura = ahora;
      const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;

      const cambios = {
        lat, lng, precision: Math.round(accuracy),
        rumbo: heading ?? null, velocidad: speed ?? null,
        ts: firebase.database.ServerValue.TIMESTAMP
      };
      // Distancia al destino; si entra en el radio, se marca "cerca" (el cliente recibe la alarma)
      let dist = null;
      if (destino) {
        dist = Math.round(distanciaM(lat, lng, destino.lat, destino.lng));
        cambios.distancia = dist;
        if (dist <= RADIO_AVISO_M && !cercaEnviado) { cambios.cerca = true; cambios.cercaTs = firebase.database.ServerValue.TIMESTAMP; }
      }
      db.ref("pedidos/" + tokenActivo).update(cambios)
        .then(() => {
          if (cambios.cerca && !cercaEnviado) {
            cercaEnviado = true;
            navigator.vibrate?.([300, 150, 300]);          // avisa al repartidor
            $("btnCerca").classList.remove("oculto");      // refuerzo por WhatsApp
          }
          setEstado(`Transmitiendo · ±${Math.round(accuracy)} m` + (dist !== null ? ` · destino a ${dist} m` : ""), "ok");
        })
        .catch((e) => setEstado("Error de red: " + e.message, "error"));
    },
    (err) => setEstado(
      err.code === 1 ? "Permiso de ubicación denegado. Actívalo en Ajustes." : "Error GPS: " + err.message, "error"),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && watchId !== null) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
  }
});

/* ---------- WhatsApp ---------- */
function abrirWhatsApp(msg) {
  const base = telActivo ? `https://wa.me/${telActivo}` : "https://wa.me/";
  window.open(`${base}?text=${encodeURIComponent(msg)}`, "_system");
}
$("btnWhatsapp").onclick = () =>
  abrirWhatsApp(`Hola 👋 Tu pedido de Brother's Deliverys ya va en camino. Síguelo en tiempo real aquí: ${enlaceDe(tokenActivo)}`);
$("btnCerca").onclick = () =>
  abrirWhatsApp("📦 Tu repartidor de Brother's Deliverys está a menos de 200 metros. ¡Sal a recibir tu pedido!");
$("btnCopiar").onclick = async () => {
  try { await navigator.clipboard.writeText(enlaceDe(tokenActivo)); setEstado("Enlace copiado.", "ok"); }
  catch (_) { prompt("Copia el enlace:", enlaceDe(tokenActivo)); }
};

/* ---------- Finalizar / cancelar ---------- */
async function cerrarViaje(estadoFinal) {
  if (!confirm(estadoFinal === "entregado" ? "¿Confirmar entrega?" : "¿Cancelar este viaje?")) return;
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  try { await wakeLock?.release(); } catch (_) {}
  try {
    await db.ref("pedidos/" + tokenActivo).update({
      estado: estadoFinal, lat: null, lng: null, rumbo: null, velocidad: null, precision: null,
      destLat: null, destLng: null, distancia: null, cerca: null,
      fin: firebase.database.ServerValue.TIMESTAMP
    });
  } catch (e) { return alert("No se pudo cerrar en la nube: " + e.message); }

  localStorage.removeItem("viajeActivo");
  tokenActivo = null; telActivo = "";
  limpiarDestinoLocal();
  $("inputPedido").value = ""; $("inputTel").value = "";
  mostrar("vistaNuevo");
}
$("btnFinalizar").onclick = () => cerrarViaje("entregado");
$("btnCancelar").onclick = () => cerrarViaje("cancelado");
