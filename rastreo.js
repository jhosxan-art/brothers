/* ============================================================
   MÓDULO CLIENTE — rastreo en tiempo real + alarma a 200 m
   ============================================================ */
const db = firebase.database();
const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("id");

// Mapa (Leaflet + OpenStreetMap)
const mapa = L.map("mapa", { zoomControl: false, attributionControl: false }).setView([-12.0464, -77.0428], 14);
L.control.zoom({ position: "bottomright" }).addTo(mapa);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);

const iconoMoto = iconoRepartidor();   // repartidor con mochila celeste (iconos.js)
const iconoDestino = iconoPin();
let marcador = null, marcaDestino = null, primerPunto = true, referencia = null, maxDist = 0;
const estela = L.polyline([], { color: "#ffc20e", weight: 5, opacity: .9 }).addTo(mapa);

/* ---------- Alarma sonora ----------
   Los navegadores solo permiten sonido después de que el usuario toca la pantalla,
   por eso existe el botón "Activar". Además no se puede forzar el volumen del celular. */
let audioCtx = null, sirena = null, vibInt = null, finAlarma = null, alarmaActiva = false, yaSono = false, wake = null;

function ctxAudio() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state !== "running") audioCtx.resume();
  return audioCtx;
}
async function pedirWake() { try { wake = await navigator.wakeLock?.request("screen"); } catch (_) {} }

$("btnActivarSonido").onclick = () => {
  const ctx = ctxAudio();
  // Pitido corto de prueba para que el cliente compruebe su volumen
  const o = ctx.createOscillator(), g = ctx.createGain();
  g.gain.value = 0.4; o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + 0.25);
  pedirWake();                       // mantiene la pantalla encendida con la página abierta
  $("avisoSonido").classList.add("oculto");
};
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && audioCtx) { audioCtx.resume(); pedirWake(); }
});

function sonarAlarma() {
  if (alarmaActiva) return;
  alarmaActiva = true;
  const ctx = ctxAudio();
  const osc = ctx.createOscillator(), gain = ctx.createGain();
  osc.type = "square"; osc.frequency.value = 700; gain.gain.value = 1;
  osc.connect(gain).connect(ctx.destination); osc.start();
  let alto = false;
  const t = setInterval(() => { alto = !alto; osc.frequency.setValueAtTime(alto ? 1100 : 700, ctx.currentTime); }, 400);
  sirena = { osc, t };
  if (navigator.vibrate) {
    navigator.vibrate([600, 300, 600, 300, 600]);
    vibInt = setInterval(() => navigator.vibrate([600, 300, 600]), 2500);
  }
  // Si el navegador bloqueó el audio, pedir un toque en pantalla
  setTimeout(() => $("pistaSonido").classList.toggle("oculto", ctx.state === "running"), 600);
  finAlarma = setTimeout(pararAlarma, 60000);   // se apaga sola a los 60 s
}
function pararAlarma() {
  if (sirena) { clearInterval(sirena.t); try { sirena.osc.stop(); } catch (_) {} sirena = null; }
  clearInterval(vibInt); clearTimeout(finAlarma); navigator.vibrate?.(0);
  alarmaActiva = false;
  $("pantallaCerca").classList.add("oculto");
}
$("btnEntendido").onclick = pararAlarma;
$("pantallaCerca").addEventListener("pointerdown", () => { if (audioCtx) audioCtx.resume(); $("pistaSonido").classList.add("oculto"); });

/* ---------- Pantalla final ---------- */
function terminar(titulo, mensaje) {
  if (referencia) referencia.off("value");
  pararAlarma();
  try { wake?.release(); } catch (_) {}
  $("finalTitulo").textContent = titulo;
  $("finalMsg").textContent = mensaje;
  $("pantallaFinal").classList.remove("oculto");
}
const formatoDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");

/* ---------- Escucha en tiempo real ---------- */
if (!token) {
  terminar("Enlace no válido", "Pide a tu repartidor que te reenvíe el enlace de rastreo.");
} else {
  referencia = db.ref("pedidos/" + token);
  referencia.on("value", (snap) => {
    const d = snap.val();
    if (!d) return terminar("El rastreo ha finalizado", "Este paquete ya ha sido entregado o el enlace ya no está activo.");
    if (d.estado === "entregado") return terminar("Paquete entregado", "Este paquete ya ha sido entregado. El rastreo ha finalizado. ¡Gracias por confiar en Brother’s Deliverys!");
    if (d.estado === "cancelado") return terminar("El rastreo ha finalizado", "El viaje fue cancelado. Contacta a Brother's Deliverys si tienes dudas.");

    if (d.pedido) $("pedidoTxt").textContent = "Pedido " + d.pedido;
    if (d.repartidorNombre) $("nombreRepartidor").textContent = "Tu repartidor: " + d.repartidorNombre;

    // El repartidor llegó al radio de 200 m → alarma (una sola vez)
    if (d.cerca === true && !yaSono) {
      yaSono = true;
      $("pantallaCerca").classList.remove("oculto");
      sonarAlarma();
    }

    if (typeof d.lat !== "number") { $("estadoTxt").textContent = "Esperando señal del repartidor…"; $("distTxt").textContent = ""; return; }

    const pos = [d.lat, d.lng];
    if (!marcador) marcador = L.marker(pos, { icon: iconoMoto }).addTo(mapa);
    else marcador.setLatLng(pos);
    estela.addLatLng(pos);

    // Marcador del destino (si el repartidor lo definió)
    let dest = null;
    if (typeof d.destLat === "number") {
      dest = [d.destLat, d.destLng];
      if (!marcaDestino) marcaDestino = L.marker(dest, { icon: iconoDestino }).addTo(mapa);
      else marcaDestino.setLatLng(dest);
    } else if (marcaDestino) { mapa.removeLayer(marcaDestino); marcaDestino = null; }

    if (primerPunto) {
      if (dest) mapa.fitBounds([pos, dest], { padding: [60, 60], maxZoom: 17 }); else mapa.setView(pos, 16);
      primerPunto = false;
    } else if (!mapa.getBounds().contains(pos)) mapa.panTo(pos);   // respeta el zoom del cliente

    // Textos de la hoja inferior: estado, distancia y barra de progreso
    const llegando = d.cerca === true || (typeof d.distancia === "number" && d.distancia <= 200);
    $("estadoTxt").textContent = llegando ? "¡Tu repartidor está llegando!" : "Tu pedido va en camino";
    if (typeof d.distancia === "number") {
      maxDist = Math.max(maxDist, d.distancia);
      $("distTxt").textContent = "a " + formatoDist(d.distancia);
      $("progresoBarra").style.width = (llegando || !maxDist ? 100 : Math.round(100 * (1 - d.distancia / maxDist))) + "%";
    } else { $("distTxt").textContent = ""; }
    if (d.ts) $("horaTxt").textContent = "Actualizado " + new Date(d.ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  }, () => terminar("Sin conexión", "No se pudo leer el rastreo. Revisa tu internet e intenta de nuevo."));
}
