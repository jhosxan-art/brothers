/* ============================================================
   MÓDULO CLIENTE — rastreo en tiempo real + alertas por voz
   - Al abrir el enlace se activa la ubicación del cliente y se comparte con el repartidor
   - "Cambiar mi ubicación": el cliente marca en el mapa dónde quiere recibir el pedido
   - Voz: "El repartidor está cerca" y "El repartidor te ha enviado un mensaje"
   ============================================================ */
const db = firebase.database();
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;
const token = new URLSearchParams(location.search).get("id");

// Mapa (Leaflet + OpenStreetMap)
const mapa = L.map("mapa", { zoomControl: false, attributionControl: false }).setView([-12.0464, -77.0428], 14);
L.control.zoom({ position: "bottomright" }).addTo(mapa);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);

const iconoDestino = iconoPin();
const iconoYo = L.divIcon({ className: "", html: '<div class="marca-cliente"><span>Tú</span></div>', iconSize: [26, 26], iconAnchor: [13, 13] });
let marcador = null, marcaDestino = null, primerPunto = true, referencia = null, maxDist = 0, nombreMarcado = "";
let posRep = null, destPedido = null;
const estela = L.polyline([], { color: "#0A86C9", weight: 5, opacity: .9 }).addTo(mapa);
// Línea punteada repartidor → cliente (seguimiento en marcha)
const guia = L.polyline([], { color: "#E5322D", weight: 4, opacity: .85, dashArray: "4 10" }).addTo(mapa);

const distM = (a, b) => {
  const R = 6371000, rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

/* ---------- Alertas: voz + vibración ---------- */
let vibInt = null, finAlarma = null, alarmaActiva = false, yaSono = false, wake = null;

async function pedirWake() { try { wake = await navigator.wakeLock?.request("screen"); } catch (_) {} }

/* Un solo botón al abrir el enlace: ubicación + voz + pantalla encendida */
function activarTodo() {
  Voz.activar();
  Voz.hablar(Voz.FRASES.prueba, { forzar: true });   // el cliente comprueba su volumen
  pedirWake();                                       // mantiene la pantalla encendida con la página abierta
  $("permisos").classList.add("oculto");
  iniciarUbicacion();                                // el navegador muestra su ventana de permiso de ubicación
}
$("btnPermisos").onclick = activarTodo;
$("btnPermisosMapa").onclick = () => { $("permisos").classList.add("oculto"); $("btnCambiarUbic").click(); };
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") pedirWake();
});

function hablarCerca() { Voz.hablar(Voz.FRASES.cerca, { repetir: 8, pausaMs: 3000, forzar: true }); }
function sonarAlarma() {
  if (alarmaActiva) return;
  alarmaActiva = true;
  hablarCerca();
  if (navigator.vibrate) {
    navigator.vibrate([600, 300, 600, 300, 600]);
    vibInt = setInterval(() => navigator.vibrate([600, 300, 600]), 3500);
  }
  // Si el navegador bloqueó el audio, pedir un toque en pantalla
  setTimeout(() => $("pistaSonido").classList.toggle("oculto", Voz.lista()), 600);
  finAlarma = setTimeout(pararAlarma, 60000);   // se apaga sola a los 60 s
}
function pararAlarma() {
  Voz.parar();
  clearInterval(vibInt); clearTimeout(finAlarma); navigator.vibrate?.(0);
  alarmaActiva = false;
  $("pantallaCerca").classList.add("oculto");
}
$("btnEntendido").onclick = pararAlarma;
$("pantallaCerca").addEventListener("pointerdown", () => {
  const estabaBloqueada = !Voz.lista();
  Voz.activar();
  $("pistaSonido").classList.add("oculto");
  if (estabaBloqueada && alarmaActiva) hablarCerca();   // el primer intento fue bloqueado: repetir ya con permiso
});

/* ---------- Pantalla final ---------- */
function terminar(titulo, mensaje) {
  Chat.detener();
  if (referencia) referencia.off("value");
  detenerUbicacion();
  pararAlarma();
  try { wake?.release(); } catch (_) {}
  $("finalTitulo").textContent = titulo;
  $("finalMsg").textContent = mensaje;
  $("pantallaFinal").classList.remove("oculto");
}
const formatoDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");

/* ============================================================
   UBICACIÓN DEL CLIENTE (en vivo o marcada a mano)
   Se guarda en pedidos/{token}/cliente  →  el repartidor la ve en su mapa
   ============================================================ */
let watchCli = null, ultimaEscCli = 0, manual = false, posCli = null, ultimaGps = null, marcaCli = null;
let eligiendo = false, marcaPend = null;

function setUbic(texto, tipo = "") { const e = $("ubicTxt"); e.textContent = texto; e.className = "estado " + tipo; }

let marcaManual = null, centradoGps = false;
function pintarCliente() {
  // Punto azul "Tú": dónde estás de verdad ahora (GPS). Si aún no hay GPS, la última ubicación enviada.
  const real = ultimaGps || (!manual ? posCli : null);
  if (real) {
    const p = [real.lat, real.lng];
    if (!marcaCli) marcaCli = L.marker(p, { icon: iconoYo, zIndexOffset: 500, interactive: false }).addTo(mapa);
    else marcaCli.setLatLng(p);
  }
  // Pin rojo: el lugar de entrega que el cliente marcó a mano
  if (manual && posCli) {
    const p = [posCli.lat, posCli.lng];
    if (!marcaManual) marcaManual = L.marker(p, { icon: iconoDestino, zIndexOffset: 400, interactive: false }).addTo(mapa);
    else marcaManual.setLatLng(p);
  } else if (marcaManual) { mapa.removeLayer(marcaManual); marcaManual = null; }
  pintarDestino();
  actualizarGuia();
}
function actualizarGuia() {
  guia.setLatLngs(posRep && posCli ? [posRep, [posCli.lat, posCli.lng]] : []);
}
function enviarCliente(lat, lng, precision, esManual) {
  posCli = { lat, lng };
  pintarCliente();
  const ahora = Date.now();
  if (!esManual && ahora - ultimaEscCli < 4000) return;   // máx. 1 escritura cada 4 s
  ultimaEscCli = ahora;
  db.ref("pedidos/" + token + "/cliente")
    .set({ lat, lng, precision: precision || 0, manual: !!esManual, ts: TS })
    .catch(() => setUbic("No se pudo enviar tu ubicación al repartidor. Revisa tu internet.", "error"));
}
function iniciarUbicacion() {
  if (watchCli !== null) return;
  if (!("geolocation" in navigator)) return setUbic("Tu dispositivo no tiene GPS. Toca «Cambiar mi ubicación» para marcarla en el mapa.", "error");
  watchCli = navigator.geolocation.watchPosition(
    (pos) => {
      const c = pos.coords;
      ultimaGps = { lat: c.latitude, lng: c.longitude, precision: Math.round(c.accuracy || 0) };
      if (!centradoGps && primerPunto) { centradoGps = true; mapa.setView([ultimaGps.lat, ultimaGps.lng], 17); }
      if (manual || eligiendo) { pintarCliente(); return; }
      enviarCliente(ultimaGps.lat, ultimaGps.lng, ultimaGps.precision, false);
      setUbic(`Compartiendo tu ubicación en tiempo real con el repartidor · ±${ultimaGps.precision} m`, "ok");
    },
    (err) => setUbic(err.code === 1
      ? "No diste permiso de ubicación. Actívalo en tu navegador o toca «Cambiar mi ubicación» para marcarla en el mapa."
      : "No se pudo obtener tu ubicación (" + err.message + "). Puedes marcarla en el mapa.", "error"),
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}
function detenerUbicacion() {
  if (watchCli !== null) { navigator.geolocation.clearWatch(watchCli); watchCli = null; }
}

/* "Cambiar mi ubicación": el cliente marca el punto exacto donde quiere recibir el pedido */
function mostrarModoManual(si) {
  eligiendo = si;
  $("barraManual").classList.toggle("oculto", !si);
  $("filaUbic").classList.toggle("oculto", si);
  if (!si && marcaPend) { mapa.removeLayer(marcaPend); marcaPend = null; }
}
function ponerPendiente(lat, lng) {
  if (!marcaPend) {
    marcaPend = L.marker([lat, lng], { icon: iconoDestino, draggable: true, zIndexOffset: 900 }).addTo(mapa);
  } else marcaPend.setLatLng([lat, lng]);
}
$("btnCambiarUbic").onclick = () => {
  mostrarModoManual(true);
  const poner = (p, zoom) => { ponerPendiente(p.lat, p.lng); mapa.setView([p.lat, p.lng], zoom); };
  const respaldo = ultimaGps || posCli;
  if (respaldo) poner(respaldo, 18);                       // salta ya a tu ubicación (se afina enseguida)
  $("textoManual").textContent = "Buscando tu ubicación exacta…";
  const listo = () => { $("textoManual").textContent = "El punto azul es donde estás ahora. Confirma aquí, o toca el mapa / arrastra el pin para elegir otro lugar de entrega."; };
  if (!("geolocation" in navigator)) return listo();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const c = pos.coords;
      ultimaGps = { lat: c.latitude, lng: c.longitude, precision: Math.round(c.accuracy || 0) };
      pintarCliente();
      if (eligiendo) poner(ultimaGps, 18);
      listo();
    },
    () => { listo(); if (!respaldo) $("textoManual").textContent = "No pudimos ubicarte: toca el mapa para marcar dónde estás."; },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 });
};
mapa.on("click", (e) => { if (eligiendo) ponerPendiente(e.latlng.lat, e.latlng.lng); });
$("btnConfirmarUbic").onclick = () => {
  if (!marcaPend) return;
  const p = marcaPend.getLatLng();
  manual = true;
  enviarCliente(p.lat, p.lng, 0, true);
  mostrarModoManual(false);
  $("btnVolverVivo").classList.remove("oculto");
  setUbic("Ubicación marcada por ti ✔ El repartidor ya la ve en su mapa.", "ok");
};
$("btnCancelarUbic").onclick = () => mostrarModoManual(false);
$("btnVolverVivo").onclick = () => {
  manual = false;
  $("btnVolverVivo").classList.add("oculto");
  pintarCliente();
  if (ultimaGps) { enviarCliente(ultimaGps.lat, ultimaGps.lng, ultimaGps.precision, false); setUbic("Compartiendo tu ubicación en tiempo real con el repartidor", "ok"); }
  else { setUbic("Buscando tu ubicación…"); iniciarUbicacion(); }
};

/* El pin del destino solo se dibuja si el repartidor lo movió lejos de tu ubicación */
function pintarDestino() {
  const hayDest = destPedido && (!posCli || distM([posCli.lat, posCli.lng], destPedido) > 30);
  if (hayDest) {
    if (!marcaDestino) marcaDestino = L.marker(destPedido, { icon: iconoDestino }).addTo(mapa);
    else marcaDestino.setLatLng(destPedido);
  } else if (marcaDestino) { mapa.removeLayer(marcaDestino); marcaDestino = null; }
}

/* ---------- Permisos al abrir el enlace ---------- */
async function pedirPermisosAlAbrir() {
  let estado = "prompt";
  try { estado = (await navigator.permissions.query({ name: "geolocation" })).state; } catch (_) {}
  if (estado === "granted") { iniciarUbicacion(); return; }   // ya autorizado: sin ventanas (el primer toque activa la voz)
  if (estado === "denied") {
    $("permTitulo").textContent = "Ubicación bloqueada";
    $("permTexto").textContent = "Tu navegador tiene bloqueada la ubicación. Toca el candado junto a la dirección de la página → Permisos → Ubicación → Permitir, y recarga. O marca tu ubicación a mano en el mapa.";
    $("permLista").classList.add("oculto");
    $("btnPermisos").textContent = "Ya la activé, continuar";
    $("btnPermisosMapa").classList.remove("oculto");
  }
  $("permisos").classList.remove("oculto");
}

/* ---------- Escucha en tiempo real ---------- */
if (!token) {
  terminar("Enlace no válido", "Pide a tu repartidor que te reenvíe el enlace de rastreo.");
} else {
  Chat.iniciar({
    token, yo: "cliente",
    titulo: (c) => "Chat con " + (c.nombreRepartidor || "tu repartidor"),
    subtitulo: (c) => (c.pedido ? "Pedido " + c.pedido : ""),
    alNoLeidos: (n) => { const b = $("badgeChat"); b.textContent = n; b.classList.toggle("oculto", !n); }
  });
  $("btnChat").onclick = () => Chat.abrir();
  pedirPermisosAlAbrir();   // al abrir el enlace: ubicación en tiempo real + voz
  referencia = db.ref("pedidos/" + token);
  referencia.on("value", (snap) => {
    const d = snap.val();
    if (!d) return terminar("El rastreo ha finalizado", "Este paquete ya ha sido entregado o el enlace ya no está activo.");
    if (d.estado === "entregado") return terminar("Paquete entregado", "Este paquete ya ha sido entregado. El rastreo ha finalizado. ¡Gracias por confiar en Brother’s Deliverys!");
    if (d.estado === "cancelado") return terminar("El rastreo ha finalizado", "El viaje fue cancelado. Contacta a Brother's Deliverys si tienes dudas.");

    if (d.pedido) $("pedidoTxt").textContent = "Pedido " + d.pedido;
    Chat.setContexto({ pedido: d.pedido, nombreRepartidor: d.repartidorNombre });
    if (d.repartidorNombre) $("nombreRepartidor").textContent = "Tu repartidor: " + d.repartidorNombre;

    if (d.cerca !== true) yaSono = false;   // si el cliente se alejó y vuelve a acercarse, se avisa otra vez
    // El repartidor llegó al radio de 200 m → voz "El repartidor está cerca" (una sola vez)
    if (d.cerca === true && !yaSono) {
      yaSono = true;
      $("pantallaCerca").classList.remove("oculto");
      sonarAlarma();
    }

    destPedido = typeof d.destLat === "number" ? [d.destLat, d.destLng] : null;

    if (typeof d.lat !== "number") { $("estadoTxt").textContent = "Esperando señal del repartidor…"; $("distTxt").textContent = ""; pintarDestino(); return; }

    const pos = [d.lat, d.lng];
    posRep = pos;
    const nombre = d.repartidorNombre || "";   // burbuja con el nombre del repartidor
    if (!marcador) { marcador = L.marker(pos, { icon: iconoRepartidorNombre(nombre) }).addTo(mapa); nombreMarcado = nombre; }
    else {
      marcador.setLatLng(pos);
      if (nombre !== nombreMarcado) { marcador.setIcon(iconoRepartidorNombre(nombre)); nombreMarcado = nombre; }
    }
    estela.addLatLng(pos);
    actualizarGuia();
    pintarDestino();

    const dest = posCli ? [posCli.lat, posCli.lng] : destPedido;
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
