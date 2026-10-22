/* ============================================================
   MÓDULO CLIENTE — rastreo en tiempo real (solo lectura)
   ============================================================ */
const db = firebase.database();
const $ = (id) => document.getElementById(id);

// 1) Leer el ID de la URL: rastreo.html?id=abc123
const token = new URLSearchParams(location.search).get("id");

// 2) Mapa (Leaflet + OpenStreetMap, gratis y sin API key)
const mapa = L.map("mapa", { zoomControl: false }).setView([-12.0464, -77.0428], 14);
L.control.zoom({ position: "bottomright" }).addTo(mapa);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: "© OpenStreetMap"
}).addTo(mapa);

const iconoMoto = L.divIcon({ className: "", html: '<div class="pin-moto">🛵</div>', iconSize: [30, 30], iconAnchor: [15, 15] });
let marcador = null;
const estela = L.polyline([], { color: "#ffc20e", weight: 5, opacity: .9 }).addTo(mapa); // ruta recorrida
let primerPunto = true;
let referencia = null;

// 3) Pantalla final: detiene el listener y bloquea el mapa
function terminar(titulo, mensaje) {
  if (referencia) referencia.off("value");   // deja de escuchar → rastreo detenido
  $("finalTitulo").textContent = titulo;
  $("finalMsg").textContent = mensaje;
  $("pantallaFinal").classList.remove("oculto");
}

if (!token) {
  terminar("Enlace no válido", "Pide a tu repartidor que te reenvíe el enlace de rastreo.");
} else {
  referencia = db.ref("pedidos/" + token);
  referencia.on("value", (snap) => {
    const d = snap.val();

    // Datos eliminados o enlace inexistente
    if (!d) return terminar("El rastreo ha finalizado", "Este paquete ya ha sido entregado o el enlace ya no está activo.");

    // Estado distinto de "en_ruta": entregado o cancelado
    if (d.estado === "entregado") return terminar("Paquete entregado", "Este paquete ya ha sido entregado. El rastreo ha finalizado. ¡Gracias por confiar en Brother's Deliverys!");
    if (d.estado === "cancelado") return terminar("El rastreo ha finalizado", "El viaje fue cancelado. Contacta a Brother's Deliverys si tienes dudas.");

    if (d.pedido) $("pedidoTxt").textContent = "Pedido " + d.pedido;

    // En ruta pero aún sin primera coordenada
    if (typeof d.lat !== "number") return ($("estadoTxt").textContent = "Esperando señal del repartidor…");

    const pos = [d.lat, d.lng];
    if (!marcador) marcador = L.marker(pos, { icon: iconoMoto }).addTo(mapa);
    else marcador.setLatLng(pos);                       // mueve el marcador
    estela.addLatLng(pos);

    if (primerPunto) { mapa.setView(pos, 16); primerPunto = false; }
    else mapa.panTo(pos, { animate: true });

    $("estadoTxt").innerHTML = "<strong>En camino</strong> a tu dirección";
    if (d.ts) $("horaTxt").textContent = "Actualizado " + new Date(d.ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }, () => terminar("Sin conexión", "No se pudo leer el rastreo. Revisa tu internet e intenta de nuevo."));
}
