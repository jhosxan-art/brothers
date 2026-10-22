/* ============================================================
   MÓDULO REPARTIDOR — emisor GPS y gestor de pedidos
   ============================================================ */
const auth = firebase.auth();
const db = firebase.database();
const $ = (id) => document.getElementById(id);

let watchId = null;        // ID de watchPosition (para clearWatch)
let tokenActivo = null;    // token único del viaje en curso
let telActivo = "";
let wakeLock = null;       // evita que la pantalla se apague
let ultimaEscritura = 0;
const INTERVALO_MS = 3000; // máximo 1 escritura cada 3 s (ahorra batería y cuota)

/* ---------- Utilidades ---------- */
function mostrar(vista) {
  ["vistaLogin", "vistaNuevo", "vistaActivo"].forEach((v) =>
    $(v).classList.toggle("oculto", v !== vista));
}
function setEstado(texto, tipo = "") {
  const el = $("estadoGps"); el.textContent = texto; el.className = "estado " + tipo;
}
/* Token aleatorio criptográfico: el enlace no se puede adivinar (a diferencia de ?id=12345) */
function generarToken(largo = 14) {
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(largo));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
const enlaceDe = (token) => `${URL_RASTREO}?id=${token}`;

/* ---------- Sesión ---------- */
auth.onAuthStateChanged((user) => {
  if (!user) return mostrar("vistaLogin");
  const guardado = JSON.parse(localStorage.getItem("viajeActivo") || "null");
  if (guardado) reanudar(guardado);          // la app se cerró a mitad de viaje
  else mostrar("vistaNuevo");
});
$("btnLogin").onclick = () =>
  auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
      .catch((e) => alert("No se pudo entrar: " + e.message));

/* ---------- Iniciar viaje ---------- */
$("btnIniciar").onclick = async () => {
  const token = generarToken();
  const pedido = $("inputPedido").value.trim() || "P-" + Date.now().toString(36).toUpperCase();
  const tel = $("inputTel").value.replace(/\D/g, "");
  try {
    // Estado inicial del pedido: en_ruta (aún sin coordenadas)
    await db.ref("pedidos/" + token).set({
      estado: "en_ruta", pedido, inicio: firebase.database.ServerValue.TIMESTAMP
    });
  } catch (e) { return alert("Error al crear el pedido: " + e.message); }
  localStorage.setItem("viajeActivo", JSON.stringify({ token, tel }));
  reanudar({ token, tel });
};

function reanudar({ token, tel }) {
  tokenActivo = token; telActivo = tel;
  $("enlaceTxt").textContent = enlaceDe(token);
  mostrar("vistaActivo");
  iniciarGPS();
}

/* ---------- GPS en tiempo real ---------- */
async function iniciarGPS() {
  if (!("geolocation" in navigator)) return setEstado("Este dispositivo no tiene GPS.", "error");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}

  // watchPosition pide permiso la primera vez y dispara cada vez que cambia la posición
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const ahora = Date.now();
      if (ahora - ultimaEscritura < INTERVALO_MS) return;
      ultimaEscritura = ahora;
      const { latitude: lat, longitude: lng, accuracy, heading, speed } = pos.coords;
      // update() cambia solo estos campos; NO toca "estado"
      db.ref("pedidos/" + tokenActivo).update({
        lat, lng, precision: Math.round(accuracy),
        rumbo: heading ?? null, velocidad: speed ?? null,
        ts: firebase.database.ServerValue.TIMESTAMP
      }).then(() => setEstado(`Transmitiendo · precisión ±${Math.round(accuracy)} m`, "ok"))
        .catch((e) => setEstado("Error de red: " + e.message, "error"));
    },
    (err) => setEstado(
      err.code === 1 ? "Permiso de ubicación denegado. Actívalo en Ajustes." : "Error GPS: " + err.message,
      "error"),
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
}
// El wake lock se libera al cambiar de app; lo pedimos de nuevo al volver
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && watchId !== null) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
  }
});

/* ---------- WhatsApp ---------- */
$("btnWhatsapp").onclick = () => {
  const msg = `Hola 👋 Tu pedido de Brother's Deliverys ya va en camino. Síguelo en tiempo real aquí: ${enlaceDe(tokenActivo)}`;
  // Con número → chat directo; sin número → WhatsApp deja elegir contacto
  const base = telActivo ? `https://wa.me/${telActivo}` : "https://wa.me/";
  window.open(`${base}?text=${encodeURIComponent(msg)}`, "_system"); // "_system" abre la app en Cordova
};
$("btnCopiar").onclick = async () => {
  try { await navigator.clipboard.writeText(enlaceDe(tokenActivo)); setEstado("Enlace copiado.", "ok"); }
  catch (_) { prompt("Copia el enlace:", enlaceDe(tokenActivo)); }
};

/* ---------- Finalizar / cancelar ---------- */
async function cerrarViaje(estadoFinal) {
  if (!confirm(estadoFinal === "entregado" ? "¿Confirmar entrega?" : "¿Cancelar este viaje?")) return;

  // 1. Detener GPS y liberar pantalla
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  try { await wakeLock?.release(); } catch (_) {}

  // 2. Cerrar el enlace: marcar estado y borrar coordenadas (privacidad)
  try {
    await db.ref("pedidos/" + tokenActivo).update({
      estado: estadoFinal, lat: null, lng: null, rumbo: null, velocidad: null, precision: null,
      fin: firebase.database.ServerValue.TIMESTAMP
    });
  } catch (e) { return alert("No se pudo cerrar en la nube: " + e.message); }

  // 3. Limpiar interfaz para el siguiente cliente
  localStorage.removeItem("viajeActivo");
  tokenActivo = null; telActivo = "";
  $("inputPedido").value = ""; $("inputTel").value = "";
  mostrar("vistaNuevo");
}
$("btnFinalizar").onclick = () => cerrarViaje("entregado");
$("btnCancelar").onclick = () => cerrarViaje("cancelado");
