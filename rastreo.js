/* ============================================================
   MÓDULO CLIENTE — rastreo en tiempo real + alertas por voz
   - Al abrir el enlace se activa la ubicación del cliente y se comparte con el repartidor
   - "Cambiar mi ubicación": el cliente marca en el mapa dónde quiere recibir el pedido
   - Voz: "El repartidor está cerca" y "El repartidor te ha enviado un mensaje"
   - Cámara de seguimiento (CamaraCliente): zoom por proximidad, rotación hacia adelante, repartidor en el tercio inferior
   - Factura en vivo: los mandados extra (pedidos/{token}/extras) se desglosan y suman al total al instante
   - Pedido de repartidor INVITADO (pedidos/{token}/invitado = true): factura simplificada, sin desglose de productos; solo un renglón
     grande "Total a Pagar" = valor pagado al restaurante (pedidos/{token}/pagadoRestaurante) + precio del delivery (pedidos/{token}/delivery)
   ============================================================ */
const db = firebase.database();
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;
const token = new URLSearchParams(location.search).get("id");

/* ⚠️ PEGA AQUÍ la dirección de tu Worker de Cloudflare (la misma de push-admin.js, p. ej. https://brothers-push.tu-cuenta.workers.dev).
   Sirve para avisar al administrador cuando abres el enlace. Mientras diga "TU-WORKER" no se envía nada y todo lo demás funciona. */
const WORKER_URL_BROTHERS = "https://TU-WORKER.TU-CUENTA.workers.dev";
const PRIORIDAD_MONTO = 10;                 // C$ que se suman al total al priorizar

// Mapa (Leaflet + OpenStreetMap)
const mapa = L.map("mapa", { ...GestosMapa.opciones, attributionControl: false, rotate: true, bearing: 0, touchRotate: false, rotateControl: false, zoomSnap: 0.25, zoomDelta: 1 }).setView([-12.0464, -77.0428], 14);
GestosMapa.aplicar(mapa);   // un dedo solo desliza; el zoom es con botones, doble toque o pellizco
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

/* ============================================================
   CÁMARA DE SEGUIMIENTO (cliente)
   - Zoom dinámico: cuanto más cerca está el repartidor de ti, más se acerca la cámara (≈14.5 lejos → 19 muy cerca).
   - Bearing: el mapa rota hacia donde avanza el repartidor (rumbo de sus dos últimas posiciones).
   - Tercio inferior: el repartidor queda a 2/3 de la altura del mapa y se ve más camino por delante.
   - Ícono proporcional: crece con el zoom (--escala-rep) para respetar el ancho de la calle.
   Si mueves el mapa o haces zoom, la cámara se pausa y aparece «Seguir repartidor» para retomarla.
   ============================================================ */
const CamaraCliente = (() => {
  const SIGNO_ROTACION = 1;   // si en tu equipo el mapa gira al revés, cambia a -1
  const MIN_PASO_M = 4, MIN_MS = 900;
  let prev = null, suave = 0, tiene = false, ult = 0, seguir = true, ultGesto = 0, pausaHasta = 0;
  const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
  const rotable = () => typeof mapa.setBearing === "function";
  const boton = () => { const b = $("btnSeguir"); if (b) b.classList.toggle("oculto", seguir); };

  function rumboEntre(a, b) {   // a, b = [lat, lng]
    const dLng = rad(b[1] - a[1]);
    const y = Math.sin(dLng) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(dLng);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  const giroSuave = (a, b) => { const d = ((b - a + 540) % 360) - 180; return (a + d * 0.5 + 360) % 360; };
  function registrar(pos) {   // con cada posición nueva del repartidor
    if (!prev) { prev = pos; return; }
    if (distM(prev, pos) < MIN_PASO_M) return;
    const r = rumboEntre(prev, pos);
    prev = pos;
    suave = tiene ? giroSuave(suave, r) : r;
    tiene = true;
  }
  function zoomPara(dist) {
    if (dist == null) return 17;
    const z = 19 - Math.log2(Math.max(dist, 80) / 80) * 0.75;
    return Math.round(Math.min(19, Math.max(14.5, z)) * 4) / 4;
  }
  const escalaPara = (z) => Math.round(Math.min(1.6, Math.max(0.7, 0.7 * Math.pow(2, (z - 15) * 0.3))) * 100) / 100;
  function aplicarEscala() { try { mapa.getContainer().style.setProperty("--escala-rep", String(escalaPara(mapa.getZoom()))); } catch (_) {} }
  function marcarIcono() { const e = marcador && marcador.getElement && marcador.getElement(); if (e) e.classList.add("rep-yo"); }

  function actualizar(pos, dest, distancia, forzar) {
    if (!seguir || eligiendo || (!forzar && Date.now() < pausaHasta)) return;
    const ahora = Date.now();
    if (!forzar && ahora - ult < MIN_MS) return;
    ult = ahora;
    const dist = distancia != null ? distancia : dest ? Math.round(distM(pos, dest)) : null;
    const z = zoomPara(dist), ang = rotable() && tiene ? suave : 0;
    const k = mapa.getSize().y / 6, t = rad(ang), pr = mapa.project(pos, z);
    const centro = mapa.unproject(L.point(pr.x + Math.sin(t) * k, pr.y - Math.cos(t) * k), z);   // punto "por delante" del repartidor
    if (rotable()) { try { mapa.setBearing((SIGNO_ROTACION * ang + 360) % 360); } catch (_) {} }
    mapa.setView(centro, z, { animate: !forzar, duration: 0.8, easeLinearity: 0.5, noMoveStart: true });
    aplicarEscala();
  }
  function retomar() {
    seguir = true; pausaHasta = 0; boton();
    if (posRep) actualizar(posRep, posCli ? [posCli.lat, posCli.lng] : destPedido, null, true);
  }

  /* Gestos del cliente: tocar el mapa pausa unos segundos; arrastrar o hacer zoom la desactiva hasta pulsar «Seguir» */
  const marcarGesto = () => { ultGesto = Date.now(); pausaHasta = ultGesto + 8000; };
  ["pointerdown", "touchstart", "wheel"].forEach((ev) => mapa.getContainer().addEventListener(ev, marcarGesto, { passive: true, capture: true }));
  mapa.on("dragstart", () => { seguir = false; boton(); });
  mapa.on("zoomstart", () => { if (Date.now() - ultGesto < 1500 && seguir) { seguir = false; boton(); } });
  mapa.on("zoom zoomend", aplicarEscala);
  $("btnSeguir").onclick = retomar;
  aplicarEscala();
  return { registrar, actualizar, marcarIcono, retomar };
})();

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
  BrothersExtras.alTerminar();
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

/* ============================================================
   EXTRAS DEL CLIENTE
   1) Calificación del servicio: al pasar a "entregado" se muestra PRIMERO (1 a 5 estrellas + comentario opcional);
      al enviarla u omitirla se oculta y aparece la pantalla tradicional de "Pedido entregado".
      Se guarda en pedidos/{token}/calificacion y en calificaciones/{token} (lo que lee el panel del administrador).
   2) Factura: tarjeta colapsable con productos, delivery y total a pagar (pedidos/{token}/detalle).
   3) Prioridad: al abrir el enlace (sin esperas), si el pedido no se entregó, ofrece priorizarlo por 10 C$:
      guarda pedidos/{token}/prioridad = true y suma 10 C$ al total de la factura.
   3b) Panel inferior minimizable: deja una barra compacta con Total compras, Delivery y Total a pagar; al tocarla se expande.
   4) Aviso al administrador la primera vez que se abre el enlace (push, vía el Worker de Cloudflare).
   Va dentro de un objeto para no chocar con los nombres de otros archivos.
   ============================================================ */
const BrothersExtras = (() => {
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const num = (x) => { const n = typeof x === "string" ? parseFloat(x.replace(/[^\d.,-]/g, "").replace(",", ".")) : x; return typeof n === "number" && isFinite(n) ? n : null; };
  const dinero = (n) => "C$ " + Number(n || 0).toFixed(2);
  const lista = (v) => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : []);

  let ultimoEstado = null, hayPrioridad = false, descartado = false, enviandoPrioridad = false, ultimaFirma = "", detalleActual = null, abrioAvisado = false;
  let extrasPrevios = null;   // cantidad / monto de extras de la lectura anterior (para avisar solo de los nuevos)

  /* ---------- Normaliza el desglose (pedidos/{token}/detalle, o la factura vieja si no hay detalle) ---------- */
  /* Repartidor invitado: no hay productos ni desglose. Total = lo que pagó en el restaurante + el delivery (se suman aquí, sin mostrarlos por separado).
     Mientras no haya retirado (no hay valor pagado) no hay nada que cobrar y la tarjeta de factura no aparece. */
  function normalizarInvitado(d) {
    const pagado = num(d.pagadoRestaurante);
    if (pagado == null || pagado < 0) return null;
    const delivery = num(d.delivery) || 0;
    const total = Math.round((pagado + delivery) * 100) / 100;
    return { simple: true, productos: [], subtotal: null, delivery: null, total, totalBase: total, monto: 0, extras: [], extrasTotal: 0, dePrioridad: false };
  }
  function normalizar(d) {
    if (d.invitado === true) return normalizarInvitado(d);
    const x = d.detalle && typeof d.detalle === "object" ? d.detalle : null;
    const f = !x && d.factura && typeof d.factura === "object" ? d.factura : null;
    const fuente = x || f; if (!fuente) return null;
    const productos = lista(fuente.productos || fuente.products || fuente.items).map((p) => {
      if (typeof p === "string") return { nombre: p, precio: null };
      return { nombre: p && (p.nombre || p.name || p.producto || p.descripcion || p.item) || "Producto", precio: num(p && (p.precio != null ? p.precio : p.price != null ? p.price : p.monto)) };
    });
    let delivery = num(fuente.delivery != null ? fuente.delivery : fuente.totalDelivery != null ? fuente.totalDelivery : fuente.envio);
    let subtotal = num(fuente.subtotal);
    if (subtotal == null && productos.some((p) => p.precio != null)) subtotal = productos.reduce((a, p) => a + (p.precio || 0), 0);
    let total = num(fuente.total != null ? fuente.total : fuente.grandTotal != null ? fuente.grandTotal : fuente.gran);
    if (total == null && (subtotal != null || delivery != null)) total = (subtotal || 0) + (delivery || 0);
    const monto = d.prioridad === true ? (num(d.prioridadMonto) || PRIORIDAD_MONTO) : 0;
    /* Mandados extra que agrega el repartidor: pedidos/{token}/extras/{id} = { monto, nota }. Se ordenan por su id (cronológico). */
    const extras = (d.extras && typeof d.extras === "object" ? Object.entries(d.extras) : []).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, e]) => ({ k, monto: num(e && e.monto) || 0, nota: String((e && e.nota) || "").slice(0, 80) })).filter((e) => e.monto > 0);
    const extrasTotal = Math.round(extras.reduce((a, e) => a + e.monto, 0) * 100) / 100;
    // Con "detalle" el total guardado ya incluye la propina; con la factura vieja se suma aquí. Los extras siempre se suman encima.
    const totalSinExtras = total == null ? null : (x ? total : total + monto);
    const totalMostrado = totalSinExtras == null ? (extrasTotal ? extrasTotal : null) : Math.round((totalSinExtras + extrasTotal) * 100) / 100;
    if (!productos.length && delivery == null && total == null) return null;
    return { productos, subtotal, delivery, total: totalMostrado, totalBase: total == null ? null : (x ? (num(x.totalBase) != null ? num(x.totalBase) : total - monto) : total), monto, extras, extrasTotal, dePrioridad: !!x };
  }

  /* ---------- Tarjeta de factura ---------- */
  function pintarFactura(d) {
    const card = $("totalCaja"), det = normalizar(d);
    detalleActual = det;
    if (!det) { card.classList.add("oculto"); cerrarFactura(); ultimaFirma = ""; extrasPrevios = null; pintarBarraMin(null); return; }
    const firma = JSON.stringify(det) + "|" + (d.pedido || "");
    card.classList.remove("oculto");
    if (firma === ultimaFirma) return;
    ultimaFirma = firma;
    // El repartidor agregó un mandado extra: se avisa y el total ya se actualizó (sin recargar la página)
    if (extrasPrevios !== null && det.extras.length > extrasPrevios) {
      const nuevo = det.extras[det.extras.length - 1];
      toastPri("➕ Tu repartidor agregó un mandado extra: " + dinero(nuevo.monto) + ". Nuevo total: " + dinero(det.total));
      navigator.vibrate && navigator.vibrate(150);
    }
    extrasPrevios = det.extras.length;
    $("mfPedido").textContent = d.pedido ? "· Pedido " + d.pedido : "";
    if (det.simple) {   // factura simplificada del invitado: un único renglón grande, sin productos ni desglose
      $("tcTotal").textContent = dinero(det.total);
      $("tcDet").textContent = "";
      $("facLista").innerHTML = ""; $("facLista").classList.add("oculto");
      $("facTotales").innerHTML = `<div class="fac-total" style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap;font-size:26px;font-weight:800"><span>Total a Pagar:</span><b style="font-size:34px">${dinero(det.total)}</b></div>`;
      pintarBarraMin(det);
      return;
    }
    $("tcTotal").textContent = det.total != null ? dinero(det.total) : "—";   // total visible en el panel, sin abrir la factura
    $("tcDet").textContent = [det.subtotal != null ? "Compras " + dinero(det.subtotal) : "", det.delivery != null ? "Delivery " + dinero(det.delivery) : "", det.monto ? "⚡ Propina " + dinero(det.monto) : "", det.extrasTotal ? "➕ Extras " + dinero(det.extrasTotal) : ""].filter(Boolean).join(" · ");
    let lista = "";
    if (det.productos.length) {
      lista += '<div class="fac-sub">Productos</div>';
      lista += det.productos.map((p) => `<div class="fac-fila"><span>${esc(p.nombre)}</span>${p.precio != null ? `<b>${dinero(p.precio)}</b>` : ""}</div>`).join("");
    }
    $("facLista").innerHTML = lista;
    $("facLista").classList.toggle("oculto", !lista);
    let tot = "";
    if (det.subtotal != null) tot += `<div class="fac-fila"><span>Total compras</span><b>${dinero(det.subtotal)}</b></div>`;
    if (det.delivery != null) tot += `<div class="fac-fila"><span>Costo del delivery</span><b>${dinero(det.delivery)}</b></div>`;
    if (det.monto) tot += `<div class="fac-fila fac-pri"><span>⚡ Prioridad (propina)</span><b>${dinero(det.monto)}</b></div>`;
    if (det.extras.length) {   // cada mandado extra aparece desglosado, con su detalle
      tot += '<div class="fac-sub">Mandados extra</div>';
      tot += det.extras.map((e) => `<div class="fac-fila fac-ext"><span>➕ ${esc(e.nota || "Mandado extra")}</span><b>${dinero(e.monto)}</b></div>`).join("");
    }
    if (det.total != null) tot += `<div class="fac-total"><span>Total a pagar</span><b>${dinero(det.total)}</b></div>`;
    $("facTotales").innerHTML = tot;
    pintarBarraMin(det);
  }

  /* ---------- Ventana "Ver factura" ---------- */
  function abrirFactura() { if (detalleActual) $("modalFactura").classList.remove("oculto"); }
  function cerrarFactura() { $("modalFactura").classList.add("oculto"); }
  $("btnVerFactura").onclick = abrirFactura;
  $("btnCerrarFactura").onclick = cerrarFactura;
  $("modalFactura").addEventListener("click", (e) => { if (e.target === $("modalFactura")) cerrarFactura(); });   // tocar fuera de la factura también la cierra
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") cerrarFactura(); });

  /* ---------- Panel inferior minimizable ---------- */
  // Barra compacta: resumen de la factura (o el estado del viaje si aún no hay factura)
  function pintarBarraMin(det) {
    ["bmCompras", "bmDelivery"].forEach((id) => { const p = $(id) && $(id).parentElement; if (p) p.classList.toggle("oculto", !!(det && det.simple)); });   // invitado: solo el total
    $("bmFactura").classList.toggle("oculto", !det);
    $("bmEstado").classList.toggle("oculto", !!det);
    if (!det) return;
    $("bmCompras").textContent = det.subtotal != null ? dinero(det.subtotal) : "—";
    $("bmDelivery").textContent = det.delivery != null ? dinero(det.delivery) : "—";
    $("bmTotal").textContent = det.total != null ? dinero(det.total) : "—";
  }
  function sincronizarEstadoMin() {
    const e = $("estadoTxt").textContent, dd = $("distTxt").textContent;
    $("bmEstado").textContent = dd ? e + " · " + dd : e;
  }
  function aplicarPanel(minimizado) {
    $("hoja").classList.toggle("oculto", minimizado);
    $("barraMin").classList.toggle("oculto", !minimizado);
    $("btnMinimizar").setAttribute("aria-expanded", String(!minimizado));
    document.body.classList.toggle("panel-min", minimizado);
    // el mapa cambia de alto: Leaflet debe recalcular su tamaño para ocupar todo el espacio
    requestAnimationFrame(() => mapa.invalidateSize({ animate: false }));
    setTimeout(() => mapa.invalidateSize({ animate: false }), 250);
  }
  $("btnMinimizar").onclick = () => aplicarPanel(true);
  $("barraMin").onclick = () => aplicarPanel(false);
  const obsEstado = new MutationObserver(sincronizarEstadoMin);
  obsEstado.observe($("estadoTxt"), { childList: true, characterData: true, subtree: true });
  obsEstado.observe($("distTxt"), { childList: true, characterData: true, subtree: true });
  sincronizarEstadoMin();

  /* ---------- Prioridad por 10 C$ (se ofrece al instante, al abrir el enlace) ---------- */
  const bannerPri = () => $("bannerPrioridad");
  const estadoFinal = () => ultimoEstado === "entregado" || ultimoEstado === "cancelado";
  function ocultarBanner() { bannerPri().classList.add("oculto"); }
  function mostrarBannerPrioridad() {
    if (!token || estadoFinal() || hayPrioridad || descartado) return;
    if (!$("pantallaCerca").classList.contains("oculto")) { setTimeout(mostrarBannerPrioridad, 15000); return; }   // no tapa la alarma de llegada
    const b = $("btnPriorizar"); b.disabled = false; b.textContent = "Priorizar";
    bannerPri().classList.remove("oculto");
  }
  function toastPri(texto) {
    const t = document.createElement("div"); t.className = "pri-ok"; t.textContent = texto; document.body.appendChild(t);
    setTimeout(() => t.remove(), 4500);
  }
  function aceptarPrioridad() {
    if (enviandoPrioridad || hayPrioridad || !token) return;
    enviandoPrioridad = true;
    const b = $("btnPriorizar"); b.disabled = true; b.textContent = "Enviando…";
    const ref = db.ref("pedidos/" + token);
    // Se lee el pedido justo antes de escribir: como el aviso sale al instante, quizá aún no llegaron los datos
    ref.once("value").then((snap) => {
      const d = snap.val();
      if (!d || d.estado === "entregado" || d.estado === "cancelado") { ocultarBanner(); return; }
      if (d.prioridad === true) { hayPrioridad = true; ocultarBanner(); return; }
      const cambios = { prioridad: true, prioridadMonto: PRIORIDAD_MONTO, prioridadTs: TS };
      const det = normalizar(d);
      if (det && det.dePrioridad && det.totalBase != null) {   // suma 10 C$ al importe total de la factura (siempre desde el total base: nunca se suma dos veces)
        cambios["detalle/totalBase"] = det.totalBase;
        cambios["detalle/prioridad"] = PRIORIDAD_MONTO;
        cambios["detalle/total"] = Math.round((det.totalBase + PRIORIDAD_MONTO) * 100) / 100;
      }
      return ref.update(cambios).then(() => {
        hayPrioridad = true; ocultarBanner(); toastPri("⚡ ¡Listo! Tu pedido fue priorizado (+10 C$).");
      });
    }).catch(() => {
      b.disabled = false; b.textContent = "Reintentar"; toastPri("No se pudo priorizar. Revisa tu internet.");
    }).then(() => { enviandoPrioridad = false; });
  }
  $("btnPriorizar").onclick = aceptarPrioridad;
  $("btnPriCerrar").onclick = () => { descartado = true; ocultarBanner(); };

  /* ---------- Aviso al administrador: el cliente abrió su enlace (solo la primera vez) ---------- */
  function avisarApertura(d) {
    if (abrioAvisado) return; abrioAvisado = true;
    if (d.abiertoAviso || /TU-WORKER/.test(WORKER_URL_BROTHERS)) return;   // ya se avisó, o aún no pegaste la dirección del Worker
    const k = "abrio_" + token; if (lsGet(k)) return;
    fetch(WORKER_URL_BROTHERS, { method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true, body: JSON.stringify({ accion: "cliente_abrio", pedido: token }) })
      .then((r) => r.json()).then((j) => { if (j && j.ok) lsSet(k, "1"); }).catch(() => {});
  }

  /* ---------- Cada actualización del pedido ---------- */
  function alDatos(d) {
    ultimoEstado = d.estado || "en_ruta";
    hayPrioridad = d.prioridad === true;
    if (hayPrioridad) ocultarBanner();
    pintarFactura(d);
    avisarApertura(d);
  }

  /* ---------- Calificación ---------- */
  const TEXTOS = ["", "Muy mala atención", "Mala atención", "Regular", "Buena atención", "¡Excelente atención!"];
  let calMostrada = false, calEstrellas = 0;
  const mensajeEntregado = (gracias) => "Este paquete ya ha sido entregado. El rastreo ha finalizado. " + (gracias ? "¡Gracias por tu calificación y por confiar en Brother’s Deliverys!" : "¡Gracias por confiar en Brother’s Deliverys!");
  function irAPantallaFinal(gracias) {
    $("pantallaCalif").classList.add("oculto");
    terminar("Paquete entregado", mensajeEntregado(gracias));
  }
  function pintarEstrellas() {
    $("calEstrellas").querySelectorAll("button").forEach((b, i) => { b.classList.toggle("on", i < calEstrellas); b.textContent = i < calEstrellas ? "★" : "☆"; b.setAttribute("aria-checked", String(i + 1 === calEstrellas)); });
    $("calTexto").textContent = TEXTOS[calEstrellas];
    $("btnCalEnviar").disabled = !calEstrellas;
  }
  function mostrarCalificacion(d) {
    calMostrada = true;
    const caja = $("calEstrellas"); caja.innerHTML = "";
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "radio"); b.setAttribute("aria-label", i + (i > 1 ? " estrellas" : " estrella"));
      b.onclick = () => { calEstrellas = i; pintarEstrellas(); };
      caja.appendChild(b);
    }
    calEstrellas = 0; pintarEstrellas();
    $("calSub").innerHTML = d.repartidorNombre ? "¿Cómo fue el servicio de <b>" + esc(d.repartidorNombre) + "</b>?" : "¿Cómo fue el servicio?";
    $("btnCalOmitir").onclick = () => { lsSet("calif_" + token, "omitida"); irAPantallaFinal(false); };
    $("btnCalEnviar").onclick = () => {
      if (!calEstrellas) return;
      const btn = $("btnCalEnviar"); btn.disabled = true; btn.textContent = "Enviando…";
      const comentario = $("calComentario").value.trim().slice(0, 300);
      const nodo = { estrellas: calEstrellas, ts: TS }; if (comentario) nodo.comentario = comentario;
      const resumen = Object.assign({}, nodo);   // copia para el panel del administrador (calificaciones/{token}) con datos del repartidor
      if (d.repartidorUid) resumen.repartidorUid = d.repartidorUid;
      if (d.repartidorNombre) resumen.repartidorNombre = String(d.repartidorNombre).slice(0, 60);
      if (d.pedido) resumen.pedido = String(d.pedido).slice(0, 30);
      Promise.allSettled([
        db.ref("pedidos/" + token + "/calificacion").set(nodo),   // en el nodo del pedido
        db.ref("calificaciones/" + token).set(resumen)             // lo que lee la pestaña Equipo del admin
      ]).then((r) => {
        if (r.every((x) => x.status === "rejected")) { btn.disabled = false; btn.textContent = "Enviar calificación"; $("calTexto").textContent = "No se pudo enviar. Intenta de nuevo."; return; }
        lsSet("calif_" + token, "1");
        irAPantallaFinal(true);
      });
    };
    $("pantallaCalif").classList.remove("oculto");
  }

  /* El pedido pasó a "entregado": primero la calificación, luego la pantalla tradicional */
  function alEntregar(d) {
    if (calMostrada) return;
    cerrarFactura();
    ultimoEstado = "entregado"; ocultarBanner();
    if (referencia) referencia.off("value");   // ya no hace falta escuchar más cambios: se muestra la última foto del pedido
    detenerUbicacion(); pararAlarma();
    try { wake?.release(); } catch (_) {}
    if (d.calificacion || lsGet("calif_" + token)) return terminar("Paquete entregado", mensajeEntregado(!!d.calificacion));   // ya calificó (o la omitió): directo a la pantalla final
    mostrarCalificacion(d);
  }

  /* Cuando el rastreo termina por cualquier motivo */
  function alTerminar() {
    ocultarBanner(); cerrarFactura();
    ultimoEstado = ultimoEstado || "cancelado";
  }

  mostrarBannerPrioridad();   // sin temporizador: el aviso de prioridad sale al instante al abrir el enlace
  return { alDatos, alEntregar, alTerminar };
})();

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
  if (new URLSearchParams(location.search).get("chat") === "1") setTimeout(() => Chat.abrir(), 700);   // enlace de contacto: abre el chat
  pedirPermisosAlAbrir();   // al abrir el enlace: ubicación en tiempo real + voz
  referencia = db.ref("pedidos/" + token);
  referencia.on("value", (snap) => {
    const d = snap.val();
    if (!d) return terminar("El rastreo ha finalizado", "Este paquete ya ha sido entregado o el enlace ya no está activo.");
    if (d.estado === "entregado") return BrothersExtras.alEntregar(d);   // primero la calificación, después la pantalla de "Pedido entregado"
    if (d.estado === "cancelado") return terminar("El rastreo ha finalizado", "El viaje fue cancelado. Contacta a Brother's Deliverys si tienes dudas.");

    BrothersExtras.alDatos(d);   // factura, prioridad y aviso de apertura
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
    CamaraCliente.registrar(pos);   // rumbo con las dos últimas posiciones del repartidor
    if (primerPunto) {
      if (dest) mapa.fitBounds([pos, dest], { padding: [60, 60], maxZoom: 17 }); else mapa.setView(pos, 16);
      primerPunto = false;
    } else CamaraCliente.actualizar(pos, dest, typeof d.distancia === "number" ? d.distancia : null);   // zoom por proximidad + rotación + tercio inferior
    CamaraCliente.marcarIcono();

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
