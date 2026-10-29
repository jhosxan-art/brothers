/* ============================================================
   PANEL DE ADMINISTRACIÓN
   - Mapa con TODOS los repartidores, siempre (también cuando no tienen pedido)
   - Chats archivados de cada pedido
   - Agregar / quitar repartidores sin entrar a la consola de Firebase
   ============================================================ */
/* Si algo falla al cargar (p. ej. faltan archivos por subir), el motivo aparece escrito bajo el formulario */
window.addEventListener("error", (e) => {
  const m = document.getElementById("msgLogin");
  if (m) { m.textContent = "Error en la página: " + e.message + ". Puede que falten archivos por subir a GitHub."; m.className = "estado error"; }
});
const auth = APP.auth();
const db = APP.database();
const $ = (id) => document.getElementById(id);
const esc = escHtml;   // iconos.js

const SIN_SENAL_MS = 120000;  // sin posición nueva en 2 min → "Sin señal"
const ubic = {};              // uid → última ubicación del repartidor
const marcadores = {};        // uid → marcador del mapa
const activos = {};           // token → pedido en ruta
let registrados = {};         // uid → { email, nombre, usuario } (o true en cuentas antiguas)
let resumenes = {};           // token → resumen del chat
let mapa = null, refUbic = null, consultaActivos = null, consultaChats = null;
let ajusteProgramado = false, secundaria = null;
// Guiar a los repartidores y chat de equipo (administrador ↔ repartidor)
const RUTA_EQ = { chats: "chatsEquipo", resumen: "chatsEquipoResumen", fotos: "fotosEquipo" };
const guias = {};             // uid → { lat, lng, token } guía que Brothers marcó para ese repartidor
const guiaCapas = {};         // uid → { pin, linea } en el mapa
let focoUid = null;           // repartidor cuyo recorrido muestra el cartel de giros
let selUid = null;            // repartidor elegido para guiarlo
let resEquipo = {}, sinLeerEq = {}, chatEqAbierto = null;
let refGuias = null, refEq = null;
let modoSel = false;          // selección múltiple de chats
let ocultos = new Set(); try { ocultos = new Set(JSON.parse(localStorage.getItem("repOcultos") || "[]")); } catch (_) {}   // repartidores que no se dibujan en el mapa
const guardarOcultos = () => { try { localStorage.setItem("repOcultos", JSON.stringify([...ocultos])); } catch (_) {} };
let lugares = {}, refLugares = null;   // negocios agregados al mapa
const lugarMarks = {};
let modoNegocio = false, marcaBusq = null, datosBusq = null, resultadosBusq = [];
const selChats = new Set();

/* ---------- Utilidades ---------- */
function setMsg(id, texto, tipo = "") {
  const el = $(id);
  if (!el) return;
  el.textContent = texto || "";
  el.className = "estado " + tipo + (texto ? "" : " oculto");
}
const infoReg = (uid) => (registrados[uid] && typeof registrados[uid] === "object" ? registrados[uid] : {});
const nombreUid = (uid) => (ubic[uid] && ubic[uid].usuario) || infoReg(uid).usuario || infoReg(uid).nombre ||
  nombreDesdeCorreo(infoReg(uid).email) || "Repartidor";
const formatoDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");
function hace(ts) {
  if (!ts) return "sin datos";
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `hace ${s} s`;
  const m = Math.round(s / 60);
  return m < 60 ? `hace ${m} min` : `hace ${Math.round(m / 60)} h`;
}
function errorAuth(e) {
  const t = {
    "auth/weak-password": "La contraseña es muy corta (mínimo 6 caracteres).",
    "auth/invalid-email": "El correo no es válido.",
    "auth/wrong-password": "Correo o contraseña incorrectos.",
    "auth/invalid-credential": "Correo o contraseña incorrectos.",
    "auth/user-not-found": "Correo o contraseña incorrectos.",
    "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.",
    "auth/network-request-failed": "Sin conexión a internet."
  };
  return t[e.code] || e.message;
}
const viajesDe = (uid) => Object.entries(activos).filter(([, d]) => d.repartidorUid === uid).map(([token, d]) => ({ token, d }));
const viajeDe = (uid) => viajesDe(uid)[0] || null;
function estadoDe(uid) {
  const u = ubic[uid];
  if (!u) return "sinDatos";
  if (u.enLinea === false) return "desconectado";
  if (!u.ts || Date.now() - u.ts > SIN_SENAL_MS) return "sinSenal";
  return viajeDe(uid) ? "enRuta" : "libre";
}
const ETIQUETA = {
  enRuta: ["En ruta", "vivo"], libre: ["Libre", "libre"], sinSenal: ["Sin señal", "alerta"],
  desconectado: ["Desconectado", "gris"], sinDatos: ["Sin datos", "gris"]
};

/* ---------- Vistas y pestañas ---------- */
function mostrar(vista) {
  $("splash").classList.add("oculto");
  $("loginMain").classList.toggle("oculto", vista !== "login");
  $("vistaApp").classList.toggle("oculto", vista !== "app");
  $("btnSalir").classList.toggle("oculto", vista !== "app");
}
const PANELES = ["panelMapa", "panelPedidos", "panelChats", "panelEquipo"];
document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("activa", x === b));
    PANELES.forEach((id) => $(id).classList.toggle("oculto", id !== b.dataset.tab));
    if (b.dataset.tab === "panelMapa") setTimeout(() => mapa.invalidateSize(), 50);
  };
});

/* ---------- Sesión (solo administradores) ---------- */
$("btnLogin").onclick = () => {
  setMsg("msgLogin", "");
  try {
    auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
        .catch((e) => setMsg("msgLogin", errorAuth(e), "error"));
  } catch (e) { setMsg("msgLogin", "Error: " + e.message, "error"); }
};
try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (_) {}   // la sesión se recuerda en este aparato
setTimeout(() => $("splash").classList.add("oculto"), 8000);   // por si algo tarda: nunca se queda cargando
auth.onAuthStateChanged(async (user) => {
  if (!user) { detener(); $("clave").value = ""; return mostrar("login"); }
  try {
    const esAdmin = (await db.ref("admins/" + user.uid).once("value")).exists();
    if (!esAdmin) { setMsg("msgLogin", "Esta cuenta no tiene permisos de administrador.", "error"); return auth.signOut(); }
  } catch (e) {
    if (e && e.code === "PERMISSION_DENIED") { setMsg("msgLogin", "No se pudo verificar el permiso. ¿Publicaste las reglas nuevas?", "error"); return auth.signOut(); }
    // sin internet u otro fallo pasajero: se conserva la sesión y se entra igual (las reglas protegen los datos)
  }
  mostrar("app");
  initMapa();
  iniciarMonitoreo();
  Policia.iniciar({ db, mapa: () => mapa, uid: () => auth.currentUser && auth.currentUser.uid, nombre: () => "Brothers (admin)", rol: "admin", pos: () => null });
});
$("btnSalir").onclick = () => { if (confirm("¿Cerrar sesión?")) auth.signOut(); };

/* ---------- Mapa ---------- */
function initMapa() {
  if (!mapa) {
    mapa = L.map("mapaAdmin", GestosMapa.opciones).setView([-12.0464, -77.0428], 12);
    L.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);   // zoom con botones
    GestosMapa.aplicar(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(mapa);
  }
  iniciarPopups();
  mapa.on("click movestart", () => { $("resBusq").classList.add("oculto"); $("busq").blur(); });   // tocar o mover el mapa cierra la búsqueda
  mapa.on("click", (e) => {
    if (Policia.clickMapa(e.latlng)) return;   // reporte de policía: el toque marca el retén
    if (modoNegocio) { terminarModoNegocio(); return formNegocio({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }); }
    if (selUid) return fijarGuia(selUid, e.latlng);   // el mapa se puede mover y explorar libremente; solo un toque marca la guía
    if (typeof PedidosAdmin !== "undefined") PedidosAdmin.clickMapa(e.latlng);   // toque libre: asignar Retiro/Entrega a un repartidor (ordenes-admin.js)
  });
  mapa.on("zoomend", () => mapa.getContainer().classList.toggle("zoom-lejos", mapa.getZoom() < 15));   // nombres de negocios solo de cerca
  mapa.getContainer().classList.add("zoom-lejos");   // con un repartidor elegido, tocar el mapa = marcar dónde está el cliente
  aplicarHerramientas();
  setTimeout(() => mapa.invalidateSize(), 50);
}
function ajustarVista() {
  const pts = Object.values(marcadores).map((m) => m.getLatLng());
  if (!pts.length) return;
  if (pts.length === 1) mapa.setView(pts[0], 16);
  else mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
}
$("btnCentrar").onclick = ajustarVista;

const EST_ICONO = {
  enRuta: ["#12A150", "En ruta"], libre: ["#12A150", "Conectado"], sinSenal: ["#F59E0B", "Sin señal"],
  desconectado: ["#8A97A5", "Desconectado"], sinDatos: ["#8A97A5", "Sin datos"]
};
function iconoRepAdmin(nombre, est) {
  const [col, txt] = EST_ICONO[est] || EST_ICONO.sinDatos, apagado = ["desconectado", "sinSenal", "sinDatos"].includes(est);
  return L.divIcon({
    className: "",
    html: `<div class="marca-rider-caja"><div class="marca-rider${apagado ? " apagado" : ""}">${RIDER_SVG}<i class="pt-est" style="background:${col}"></i></div>` +
          `<span class="etiqueta-rider">${esc(nombre)}<small class="est" style="color:${col}">● ${txt}</small></span></div>`,
    iconSize: [56, 56], iconAnchor: [28, 28]
  });
}
function pintarMarcador(uid) {
  const u = ubic[uid];
  if (!u || typeof u.lat !== "number") return;
  if (typeof PedidosAdmin !== "undefined" && PedidosAdmin.invCerrado(uid)) { quitarMarcador(uid); pintarGuia(uid); return; }   // invitado con pedido entregado/cancelado: sale del mapa
  if (ocultos.has(uid)) { quitarMarcador(uid); pintarGuia(uid); return; }   // desactivado en la lista: no aparece en el mapa
  const est = estadoDe(uid), nombre = nombreUid(uid);
  const clave = nombre + "|" + est, pos = [u.lat, u.lng];
  if (!marcadores[uid]) {
    marcadores[uid] = L.marker(pos, { icon: iconoRepAdmin(nombre, est) }).addTo(mapa);
    marcadores[uid]._clave = clave;
    marcadores[uid].bindPopup(() => popupRep(uid), { offset: [0, -22], minWidth: 210 });   // tocar el repartidor = Guiar / Chat
    if (!ajusteProgramado) { ajusteProgramado = true; setTimeout(ajustarVista, 800); }   // encuadra a todos una sola vez
  } else {
    marcadores[uid].setLatLng(pos);
    if (marcadores[uid]._clave !== clave) { marcadores[uid].setIcon(iconoRepAdmin(nombre, est)); marcadores[uid]._clave = clave; }
  }
  const el = marcadores[uid].getElement();
  if (el) el.classList.toggle("sel-rep", uid === selUid);
  pintarGuia(uid);   // la línea de su guía sigue al repartidor mientras se mueve
  pintarBannerAdmin();
}

/* ---------- Herramientas: negocios visibles, tamaño de iconos ---------- */
let verNegocios = localStorage.getItem("verNegocios") !== "0";
let escalaRep = parseFloat(localStorage.getItem("escalaRep")) || 1;
function aplicarHerramientas() {
  if (!mapa) return;
  mapa.getContainer().style.setProperty("--escala-rep", escalaRep);
  $("btnVerNegocios").classList.toggle("on", verNegocios);
  Object.values(lugarMarks).forEach((m) => { if (verNegocios) m.addTo(mapa); else mapa.removeLayer(m); });
}
$("btnVerNegocios").onclick = () => { verNegocios = !verNegocios; localStorage.setItem("verNegocios", verNegocios ? "1" : "0"); aplicarHerramientas(); toast(verNegocios ? "Negocios visibles" : "Negocios ocultos"); };
const cambiarEscala = (d) => { escalaRep = Math.max(.5, Math.min(2, +(escalaRep + d).toFixed(1))); localStorage.setItem("escalaRep", escalaRep); aplicarHerramientas(); toast("Tamaño de iconos: " + Math.round(escalaRep * 100) + " %"); };
$("btnIconoMas").onclick = () => cambiarEscala(.2);
$("btnIconoMenos").onclick = () => cambiarEscala(-.2);

/* ---------- Ventanitas del mapa: repartidor y cliente ---------- */
function popupRep(uid) {
  const est = estadoDe(uid), [texto, clase] = ETIQUETA[est], n = sinLeerEq[uid] || 0;
  if (typeof PedidosAdmin !== "undefined" && Ordenes.esInvitadoUid(uid)) {   // repartidor invitado: Entregado / Guiar / Chat / Cancelar
    return `<div class="pop-rep"><strong>${esc(nombreUid(uid))} <i class="pd-tag">Invitado</i></strong>
    <span class="chip ${clase}">${texto}</span>
    <small>${esc(descripcion(uid, est))}${guias[uid] ? " · 📍 guía activa" : ""}${esc(PedidosAdmin.notaRep(uid))}</small>
    <div class="acciones-fila">
      <button class="mini pri" data-pa="invent" data-uid="${esc(uid)}" type="button">✅ Pedido entregado</button>
      <button class="mini" data-pa="guiar" data-uid="${esc(uid)}" type="button">📍 Guiar repartidor</button>
      <button class="mini" data-pa="chat" data-uid="${esc(uid)}" type="button">💬 Chat al repartidor</button>
      ${guias[uid] ? `<button class="mini peligro" data-pa="quitarguia" data-uid="${esc(uid)}" type="button">Quitar guía</button>` : ""}
      <button class="mini peligro" data-pa="invcancel" data-uid="${esc(uid)}" type="button">✖ Cancelar pedido</button>
      <button class="mini peligro" data-pa="invexp" data-uid="${esc(uid)}" type="button">⛔ Expulsar</button>
    </div></div>`;
  }
  return `<div class="pop-rep"><strong>${esc(nombreUid(uid))}</strong>
    <span class="chip ${clase}">${texto}</span>
    <small>${esc(descripcion(uid, est))}${guias[uid] ? " · 📍 guía activa" : ""}${typeof PedidosAdmin !== "undefined" ? esc(PedidosAdmin.notaRep(uid)) : ""}</small>
    <div class="acciones-fila">
      <button class="mini pri" data-pa="guiar" data-uid="${esc(uid)}" type="button">📍 Guiar</button>
      <button class="mini" data-pa="chat" data-uid="${esc(uid)}" type="button">💬 Chat${n ? " (" + n + ")" : ""}</button>
      ${guias[uid] ? `<button class="mini peligro" data-pa="quitarguia" data-uid="${esc(uid)}" type="button">Quitar guía</button>` : ""}
    </div>
    ${viajesDe(uid).map((x) => `<button class="mini" data-pa="entregarped" data-token="${esc(x.token)}" type="button">✓ Marcar entregado: ${esc(x.d.pedido || "—")}</button>`).join("")}</div>`;
}
function popupCliente(token) {
  const d = activos[token] || {}, c = d.cliente || {}, uid = d.repartidorUid;
  const vivo = !c.manual && c.ts && Date.now() - c.ts < 60000;
  const tipo = c.manual ? "Ubicación marcada por el cliente" : vivo ? "En vivo" : "Sin señal reciente";
  return `<div class="pop-rep"><strong>👤 Cliente · Pedido ${esc(d.pedido || "—")}</strong>
    <small>Lo lleva: <b>${esc(nombreUid(uid))}</b></small>
    <small>${tipo} · ${hace(c.ts)}${c.precision ? " · ±" + c.precision + " m" : ""}</small>
    ${d.sinFactura ? "<small>🧾 Todavía sin factura (solo enlace de contacto)</small>" : ""}
    <div class="acciones-fila"><button class="mini pri" data-pa="guiaclie" data-token="${esc(token)}" type="button">📍 Guiar a ${esc(nombreUid(uid))} hasta aquí</button>
    <button class="mini" data-pa="entregarped" data-token="${esc(token)}" type="button">✓ Marcar como entregado</button></div></div>`;
}
function iniciarPopups() {
  mapa.on("popupopen", (e) => {
    const el = e.popup.getElement(); if (!el) return;
    const bu = el.querySelector("button[data-uid]"); if (bu) { focoUid = bu.dataset.uid; pintarBannerAdmin(); }   // muestra el cartel de ese repartidor
    el.querySelectorAll("button[data-pa]").forEach((b) => {
      b.onclick = () => {
        const uid = b.dataset.uid, a = b.dataset.pa;
        mapa.closePopup();
        if (a === "guiar") { selUid = uid; pintarSeleccion(); }
        else if (a === "chat") { if (Ordenes.esInvitadoUid(uid) && typeof PedidosAdmin !== "undefined") PedidosAdmin.chatInvitado(uid); else abrirChatRep(uid); }
        else if (a === "invent") PedidosAdmin.accionInvitado(uid, "entregado");
        else if (a === "invexp") PedidosAdmin.expulsarInvitado(uid);
        else if (a === "invcancel") PedidosAdmin.accionInvitado(uid, "cancelado");
        else if (a === "quitarguia") db.ref("guias/" + uid).remove().then(() => toast("Guía quitada.")).catch((err) => toast(err.message));
        else if (a === "guiarbus" && datosBusq) { if (selUid) fijarGuia(selUid, datosBusq); }
        else if (a === "negbus" && datosBusq) formNegocio({ nombre: datosBusq.tipo === "coords" ? "" : datosBusq.nombre, dir: datosBusq.tipo === "coords" ? "" : datosBusq.detalle.slice(0, 120), lat: +datosBusq.lat.toFixed(6), lng: +datosBusq.lng.toFixed(6) });
        else if (a === "cerrarbus") { if (marcaBusq) { mapa.removeLayer(marcaBusq); marcaBusq = null; } }
        else if (a === "guiarlugar") { const l = lugares[b.dataset.id]; if (l && selUid) fijarGuia(selUid, l, null, { tipo: "negocio", nombre: l.nombre, icono: l.icono || "📍" }); }
        else if (a === "editarlugar") formNegocio(lugares[b.dataset.id], b.dataset.id);
        else if (a === "borrarlugar") {
          const l = lugares[b.dataset.id];
          if (l && confirm(`¿Eliminar el negocio “${l.nombre}”? Los repartidores dejarán de verlo.`)) db.ref("lugares/" + b.dataset.id).remove().then(() => toast("Negocio eliminado.")).catch((err) => toast(err.message));
        }
        else if (a === "entregarped") marcarEntregado(b.dataset.token);
        else if (a === "guiaclie") {
          const d = activos[b.dataset.token];
          if (d && d.cliente && d.repartidorUid) fijarGuia(d.repartidorUid, { lat: d.cliente.lat, lng: d.cliente.lng }, b.dataset.token);
        }
      };
    });
  });
}

/* ---------- Marcar un pedido como entregado (si el repartidor lo olvidó) ---------- */
async function marcarEntregado(token) {
  const d = activos[token]; if (!d) return toast("Ese pedido ya no está en ruta.");
  const quien = nombreUid(d.repartidorUid);
  if (!confirm(`¿Marcar como ENTREGADO el pedido ${d.pedido || ""} que lleva ${quien}?\nDesaparecerá de su app y el cliente verá “Paquete entregado”.`)) return;
  try {
    await db.ref("pedidos/" + token).update({
      estado: "entregado", fin: firebase.database.ServerValue.TIMESTAMP, entregadoPor: "admin",
      lat: null, lng: null, rumbo: null, velocidad: null, precision: null, destLat: null, destLng: null, distancia: null, cerca: null, cliente: null
    });
    if (guias[d.repartidorUid] && guias[d.repartidorUid].token === token) db.ref("guias/" + d.repartidorUid).remove().catch(() => {});
    if (typeof PedidosAdmin !== "undefined") PedidosAdmin.cerrarInvitado(token, d.repartidorUid);   // pedido de un invitado: cierra también su orden
    toast(`Pedido ${d.pedido || ""} marcado como entregado ✓`);
  } catch (e) { toast("No se pudo marcar: " + e.message); }
}

/* ---------- Facturas del día ---------- */
let refStats = null, facturasHoy = 0;
function cargarStats() {
  if (refStats) refStats.off();
  const dia = $("diaStats").value || Dia.clave();
  refStats = db.ref("estadisticas/" + dia);
  refStats.on("value", (s) => pintarStats(s.val() || {}, dia), (e) => { $("statsDia").innerHTML = `<p class="ayuda">No se pudieron leer las facturas: ${esc(e.message)}</p>`; });
}
function pintarStats(d, dia) {
  const uids = [...new Set([...Object.keys(registrados), ...Object.keys(d)])];
  const filas = uids.map((uid) => { const x = d[uid] || {}; return { nombre: x.nombre || nombreUid(uid), f: x.facturas || 0, t: x.total || 0, del: x.delivery || 0 }; }).sort((a, b) => b.f - a.f || a.nombre.localeCompare(b.nombre));
  const tf = filas.reduce((n, x) => n + x.f, 0), tt = filas.reduce((n, x) => n + x.t, 0), td = filas.reduce((n, x) => n + x.del, 0);
  if (dia === Dia.clave()) { facturasHoy = tf; pintarLista(); }
  const money = (n) => "C$ " + (Math.round(n * 100) / 100).toFixed(2);
  $("statsDia").innerHTML = `<div class="stats-total"><b>${tf}</b> factura${tf === 1 ? "" : "s"} ${dia === Dia.clave() ? "hoy" : "el " + esc(dia)}<br>Delivery ${money(td)} · Ventas ${money(tt)}</div>` +
    filas.map((x) => `<div class="stats-fila"><div><strong>${esc(x.nombre)}</strong><small>Delivery ${money(x.del)} · Ventas ${money(x.t)}</small></div><b class="n">${x.f}</b></div>`).join("");
}
$("diaStats").onchange = cargarStats;

/* ---------- Buscador del mapa ---------- */
$("formBusq").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("busq").value.trim(); if (!q) return;
  const caja = $("resBusq"); caja.innerHTML = '<p class="ayuda">Buscando…</p>'; caja.classList.remove("oculto");
  try {
    resultadosBusq = await Buscar.buscar(q, mapa.getBounds());
    caja.innerHTML = resultadosBusq.length
      ? '<div class="cerrar-res" data-cerrar="1">✕ Cerrar búsqueda</div>' + resultadosBusq.map((r, i) => `<div class="item-busq" data-i="${i}"><strong>${esc(r.nombre)}</strong><small>${esc(r.detalle || "")}</small></div>`).join("")
      : '<p class="ayuda">Sin resultados. Prueba con el nombre y la ciudad, o escribe las coordenadas.</p>';
  } catch (err) { caja.innerHTML = `<p class="ayuda">No se pudo buscar: ${esc(err.message)}</p>`; }
};
$("busq").addEventListener("input", () => { if (!$("busq").value) $("resBusq").classList.add("oculto"); });
$("resBusq").onclick = (e) => {
  if (e.target.closest("[data-cerrar]")) { $("resBusq").classList.add("oculto"); $("busq").blur(); return; }
  const it = e.target.closest("[data-i]"); if (!it) return;
  mostrarResultado(resultadosBusq[+it.dataset.i]);
  $("resBusq").classList.add("oculto");
};
function mostrarResultado(r) {
  if (marcaBusq) mapa.removeLayer(marcaBusq);
  datosBusq = r;
  marcaBusq = L.marker([r.lat, r.lng], { icon: iconoPin() }).addTo(mapa).bindPopup(() => popupBusq(r), { offset: [0, -30], minWidth: 230 });
  mapa.flyTo([r.lat, r.lng], r.tipo === "coords" ? 18 : 17);
  setTimeout(() => marcaBusq && marcaBusq.openPopup(), 700);
}
function popupBusq(r) {
  return `<div class="pop-rep"><strong>${esc(r.nombre)}</strong>
    <small>${esc(r.detalle || "")}</small><small>${r.lat.toFixed(6)}, ${r.lng.toFixed(6)}</small>
    <div class="acciones-fila">
      ${selUid ? `<button class="mini pri" data-pa="guiarbus" type="button">📍 Guiar a ${esc(nombreUid(selUid))} hasta aquí</button>` : ""}
      <button class="mini" data-pa="negbus" type="button">➕ Guardar como negocio</button>
      <button class="mini" data-pa="cerrarbus" type="button">Quitar</button>
    </div></div>`;
}

/* ---------- Negocios en el mapa (icono + nombre + ubicación precisa) ---------- */
function terminarModoNegocio() { modoNegocio = false; $("btnNegocio").classList.remove("activo"); if (mapa) mapa.getContainer().classList.remove("modo-guia", "modo-registro"); }
$("btnNegocio").onclick = () => {
  if (modoNegocio) { terminarModoNegocio(); return toast("Cancelado."); }
  modoNegocio = true; selUid = null; pintarSeleccion(); pintarLista();
  $("btnNegocio").classList.add("activo"); mapa.closePopup(); mapa.getContainer().classList.add("modo-guia", "modo-registro");   // los iconos dejan de recibir toques
  toast("Toca el mapa donde está el negocio (o búscalo y usa “Guardar como negocio”).");
};
$("btnNuevoNegocio").onclick = () => { document.querySelector('.tabs button[data-tab="panelMapa"]').click(); setTimeout(() => $("btnNegocio").click(), 150); };

function formNegocio(d, id) {
  let icono = d.icono || "🏪";
  modal(`<h2>${id ? "✏️ Editar negocio" : "➕ Nuevo negocio"}</h2>
    <label>Nombre<input id="nNombre" maxlength="60" value="${esc(d.nombre || "")}" placeholder="Ej. Pizzería La Esquina"></label>
    <label>Dirección o referencia (opcional)<input id="nDir" maxlength="120" value="${esc(d.dir || "")}" placeholder="Frente al parque…"></label>
    <div><small>Icono que verán los repartidores</small><div class="icon-grid">${Lugares.ICONOS.map((i) => `<button type="button" class="ic${i === icono ? " on" : ""}" data-ic="${i}">${i}</button>`).join("")}</div></div>
    <div class="dos-botones"><label>Latitud<input id="nLat" type="number" step="0.000001" value="${d.lat}"></label><label>Longitud<input id="nLng" type="number" step="0.000001" value="${d.lng}"></label></div>
    <small>Para afinar la ubicación escribe las coordenadas (6 decimales ≈ 10 cm).</small>
    <button id="nOk" class="primario" type="button">Guardar</button><button id="nNo" class="oscuro" type="button">Cancelar</button>`);
  document.querySelectorAll(".icon-grid .ic").forEach((b) => b.onclick = () => {
    icono = b.dataset.ic; document.querySelectorAll(".icon-grid .ic").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("nNo").onclick = cerrarModal;
  $("nOk").onclick = async () => {
    const nombre = $("nNombre").value.trim(), lat = parseFloat($("nLat").value), lng = parseFloat($("nLng").value);
    if (nombre.length < 2) return toast("Escribe el nombre del negocio.");
    if (!(Math.abs(lat) <= 90 && Math.abs(lng) <= 180)) return toast("Las coordenadas no son válidas.");
    const datos = { nombre, icono, dir: $("nDir").value.trim().slice(0, 120), lat, lng };
    $("nOk").disabled = true;
    try {
      if (id) await db.ref("lugares/" + id).update({ ...datos, actualizado: firebase.database.ServerValue.TIMESTAMP });
      else await db.ref("lugares").push({ ...datos, creado: firebase.database.ServerValue.TIMESTAMP });
      cerrarModal(); toast(`Negocio “${nombre}” guardado ✓ Los repartidores ya lo ven.`);
      if (marcaBusq) { mapa.removeLayer(marcaBusq); marcaBusq = null; }
    } catch (err) { toast("No se pudo guardar: " + err.message); $("nOk").disabled = false; }
  };
}
function pintarLugares() {
  if (!mapa) return;
  Object.keys(lugarMarks).forEach((id) => { if (!lugares[id]) { mapa.removeLayer(lugarMarks[id]); delete lugarMarks[id]; } });
  Object.entries(lugares).forEach(([id, l]) => {
    if (typeof l.lat !== "number") return;
    const clave = [l.nombre, l.icono].join("|");
    let m = lugarMarks[id];
    if (!m) { m = lugarMarks[id] = L.marker([l.lat, l.lng], { icon: Lugares.iconoMapa(l), zIndexOffset: 100 }); if (verNegocios) m.addTo(mapa); m._clave = clave; m.bindPopup(() => popupLugar(id), { offset: [0, -14], minWidth: 230 }); }
    else { m.setLatLng([l.lat, l.lng]); if (m._clave !== clave) { m.setIcon(Lugares.iconoMapa(l)); m._clave = clave; } }
  });
}
function popupLugar(id) {
  const l = lugares[id] || {};
  return `<div class="pop-rep"><strong>${esc(l.icono || "📍")} ${esc(l.nombre)}</strong>
    ${l.dir ? `<small>${esc(l.dir)}</small>` : ""}<small>${(+l.lat).toFixed(6)}, ${(+l.lng).toFixed(6)}</small>
    <div class="acciones-fila">
      ${selUid ? `<button class="mini pri" data-pa="guiarlugar" data-id="${esc(id)}" type="button">📍 Enviar a ${esc(nombreUid(selUid))} hasta aquí</button>` : ""}
      <button class="mini" data-pa="editarlugar" data-id="${esc(id)}" type="button">✏️ Editar</button>
      <button class="mini peligro" data-pa="borrarlugar" data-id="${esc(id)}" type="button">🗑</button>
    </div></div>`;
}
function pintarNegocios() {
  const ids = Object.keys(lugares).sort((a, b) => lugares[a].nombre.localeCompare(lugares[b].nombre));
  $("listaNegocios").innerHTML = ids.length ? ids.map((id) => {
    const l = lugares[id];
    return `<div class="tarjeta-rep"><div class="fila"><span class="avatar" style="font-size:26px">${esc(l.icono || "📍")}</span>
      <div class="datos"><strong>${esc(l.nombre)}</strong><small>${esc(l.dir || "Sin referencia")} · ${(+l.lat).toFixed(5)}, ${(+l.lng).toFixed(5)}</small></div></div>
      <div class="acciones-fila"><button class="mini" data-ln="ver" data-id="${esc(id)}" type="button">Ver en el mapa</button>
      <button class="mini" data-ln="editar" data-id="${esc(id)}" type="button">Editar</button>
      <button class="mini peligro" data-ln="borrar" data-id="${esc(id)}" type="button">Eliminar</button></div></div>`;
  }).join("") : '<p class="ayuda">Aún no hay negocios. Agrega el primero.</p>';
}
$("listaNegocios").onclick = (e) => {
  const b = e.target.closest("button[data-ln]"); if (!b) return;
  const id = b.dataset.id, l = lugares[id]; if (!l) return;
  if (b.dataset.ln === "editar") formNegocio(l, id);
  else if (b.dataset.ln === "borrar") { if (confirm(`¿Eliminar el negocio “${l.nombre}”?`)) db.ref("lugares/" + id).remove().then(() => toast("Negocio eliminado.")).catch((err) => toast(err.message)); }
  else {
    document.querySelector('.tabs button[data-tab="panelMapa"]').click();
    setTimeout(() => { mapa.flyTo([l.lat, l.lng], 18); setTimeout(() => lugarMarks[id] && lugarMarks[id].openPopup(), 800); }, 150);
  }
};

/* ---------- Clientes en el mapa (cuando abren el enlace o marcan su ubicación) ---------- */
const clientesM = {};   // token → { pin, linea }
function pintarClientes() {
  if (!mapa) return;
  const vistos = new Set();
  Object.entries(activos).forEach(([token, d]) => {
    const c = d.cliente;
    if (!c || typeof c.lat !== "number" || ocultos.has(d.repartidorUid)) return;   // clientes de repartidores ocultos tampoco se dibujan
    vistos.add(token);
    const uid = d.repartidorUid, col = colorUid(uid || token), nom = nombreUid(uid);
    const vivo = !c.manual && c.ts && Date.now() - c.ts < 60000;
    const clave = [nom, d.pedido, col, vivo, !!c.manual].join("|");
    const icono = () => L.divIcon({
      className: "",
      html: `<div class="pin-cliente${vivo ? " vivo" : ""}${c.manual ? " manual" : ""}" style="--c:${col}"><b>👤</b></div>` +
            `<span class="etq-cli">Cliente · ${esc(d.pedido || "")}<small>Lo lleva ${esc(nom)}</small></span>`,
      iconSize: [34, 34], iconAnchor: [17, 17]
    });
    let m = clientesM[token];
    if (!m) {
      m = clientesM[token] = {
        pin: L.marker([c.lat, c.lng], { icon: icono(), zIndexOffset: 200 }).addTo(mapa),
        linea: L.polyline([], { color: col, weight: 2, opacity: .55, dashArray: "2 8" }).addTo(mapa), clave
      };
      m.pin.bindPopup(() => popupCliente(token), { offset: [0, -14], minWidth: 220 });
    } else {
      m.pin.setLatLng([c.lat, c.lng]);
      if (m.clave !== clave) { m.pin.setIcon(icono()); m.clave = clave; }
    }
    const u = ubic[uid];
    m.linea.setLatLngs([]);   // sin línea recta: la ruta por calles se ve en la guía del repartidor
  });
  Object.keys(clientesM).forEach((t) => {
    if (!vistos.has(t)) { mapa.removeLayer(clientesM[t].pin); mapa.removeLayer(clientesM[t].linea); delete clientesM[t]; }
  });
}

/* ---------- Guiar repartidores (cada uno con su propia guía) ---------- */
const PALETA = ["#E5322D", "#2F6FED", "#12A150", "#F59E0B", "#9333EA", "#0891B2", "#DB2777", "#65A30D"];
function colorUid(uid) { let h = 0; for (const c of uid) h = (h * 31 + c.charCodeAt(0)) >>> 0; return PALETA[h % PALETA.length]; }
function toast(t) {
  const e = $("toastAdmin"); e.textContent = t; e.classList.remove("oculto");
  clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.add("oculto"), 3800);
}
function pintarGuia(uid) {
  const g = guias[uid]; let c = guiaCapas[uid];
  if (!g || typeof g.lat !== "number" || ocultos.has(uid)) {
    if (c) { mapa.removeLayer(c.pin); mapa.removeLayer(c.linea); mapa.removeLayer(c.flechas); delete guiaCapas[uid]; }
    return;
  }
  const col = colorUid(uid), p = [g.lat, g.lng], nom = nombreUid(uid), neg = g.tipo === "negocio";
  const clave = [nom, col, g.icono, g.nombre, c && c.calles].join("|");
  const icono = () => L.divIcon({ className: "", html: `<div class="pin-guia" style="--c:${col}"><b>${esc(neg ? (g.icono || "📍") : "🏠")}</b></div><span class="etq-cli">Guía para ${esc(nom)}${neg ? `<small>${esc(g.nombre || "")}</small>` : ""}${c && c.calles ? `<small>Vía: ${esc(c.calles)}</small>` : ""}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });
  if (!c) {
    c = guiaCapas[uid] = {
      pin: L.marker(p, { icon: icono(), zIndexOffset: 300 }).addTo(mapa),
      linea: L.polyline([], { color: col, weight: 4, opacity: .85, dashArray: "4 10" }).addTo(mapa),
      flechas: L.layerGroup().addTo(mapa), clave, rutaEn: 0
    };
  } else if (c.clave !== clave) { c.pin.setIcon(icono()); c.clave = clave; }
  c.pin.setLatLng(p);
  const u = ubic[uid];
  if (!u || typeof u.lat !== "number") return c.linea.setLatLngs([]);
  // Ruta por calles (respeta sentidos); mientras llega, línea recta punteada
  c.linea.setLatLngs(c.pts ? [[u.lat, u.lng], ...c.pts] : []);   // solo por calles: nunca línea recta
  const movido = !c.origen || Ruta.dist([u.lat, u.lng], c.origen) > 80, cambioDest = !c.dest || Ruta.dist(p, c.dest) > 10;
  if ((movido || cambioDest || !c.pts) && Date.now() - c.rutaEn > (cambioDest ? 1500 : 20000)) {
    c.rutaEn = Date.now();
    const o = { lat: u.lat, lng: u.lng };
    Ordenes.rutaCalles(o, { lat: g.lat, lng: g.lng }).then((r) => {
      if (!guiaCapas[uid]) return;
      if (!r) throw new Error("sin ruta");
      c.rutaFallo = false; c.pasos = r.pasos; c.idx = Math.min(1, r.pasos.length - 1); c.dist = r.dist; c.dur = r.dur;
      c.pts = r.pts; c.origen = [o.lat, o.lng]; c.dest = p;
      c.linea.setStyle({ dashArray: null, weight: 5, opacity: .9 });
      c.linea.setLatLngs([[o.lat, o.lng], ...r.pts]);
      Ruta.flechas(r.pts, c.flechas, col);
      c.calles = Ordenes.callesDe(r.pasos);   // calles exactas por donde va el repartidor
      pintarBannerAdmin();
      c.pin.setIcon(icono()); c.clave = [nom, col, g.icono, g.nombre, c.calles].join("|");
      if (c.calles) c.linea.bindTooltip("Vía: " + c.calles, { sticky: true });
    }).catch(() => {   // sin ruta aún: avisa y reintenta cada ~3 s (no se dibuja línea recta)
      if (!guiaCapas[uid]) return;
      c.rutaFallo = true; c.rutaEn = Date.now() - 18000; pintarBannerAdmin();
      clearTimeout(c._rt); c._rt = setTimeout(() => pintarGuia(uid), 3000);
    });
  }
}
/* Cartel de giros del recorrido del repartidor enfocado (el que guías o el que tocaste en el mapa) */
const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
function pintarBannerAdmin() {
  const b = $("bannerRuta"); if (!b) return;
  const uid = focoUid && guiaCapas[focoUid] ? focoUid : (selUid && guiaCapas[selUid] ? selUid : null);
  if (!uid) { b.classList.add("oculto"); return; }
  const c = guiaCapas[uid], u = ubic[uid], g = guias[uid] || {}, nom = nombreUid(uid), destino = g.nombre || (g.tipo === "negocio" ? "destino" : "cliente");
  const cerrar = '<button id="brXAdm" type="button" aria-label="Cerrar">✕</button>';
  b.classList.remove("oculto");
  if (!u || typeof u.lat !== "number" || !c.pasos) {
    const txt = !u || typeof u.lat !== "number" ? `Esperando la ubicación de ${nom}…` : c.rutaFallo ? `No se pudo calcular la ruta de ${nom}. Reintentando…` : `Calculando ruta de ${nom}…`;
    b.innerHTML = `<div class="br-fila"><span class="br-ic">🧭</span><div class="br-txt"><b>${esc(txt)}</b></div>${cerrar}</div>`;
  } else {
    const aqui = { lat: u.lat, lng: u.lng };
    while (c.idx < c.pasos.length - 1 && Ordenes.distM(aqui, c.pasos[c.idx].loc) < 30) c.idx++;   // pasa solo al siguiente giro
    const p = c.pasos[c.idx], [ic, tx] = Ordenes.textoPaso(p), d = Ordenes.distM(aqui, p.loc);
    b.innerHTML = `<div class="br-fila"><span class="br-ic">${ic}</span><div class="br-txt"><b>${esc(tx)}</b><small>${p.tipo === "arrive" ? "" : "en " + fmtM(d) + " · "}${esc(nom)} → ${esc(destino)}</small></div>${cerrar}</div>
      <small>${fmtM(c.dist)} · ≈ ${Math.max(1, Math.round(c.dur / 60))} min${c.calles ? " · Vía: " + esc(c.calles) : ""}</small>`;
  }
  const x = $("brXAdm"); if (x) x.onclick = () => { focoUid = null; if (selUid) { selUid = null; pintarSeleccion(); pintarLista(); } pintarBannerAdmin(); };
}
function seleccionarRep(uid) { selUid = selUid === uid ? null : uid; pintarSeleccion(); pintarLista(); }
function pintarSeleccion() {
  Object.keys(marcadores).forEach((u) => { const e = marcadores[u].getElement(); if (e) e.classList.toggle("sel-rep", u === selUid); });
  $("panelGuia").classList.toggle("oculto", !selUid);
  mapa.getContainer().classList.toggle("modo-guia", !!selUid);
  if (!selUid) return;
  const vs = viajesDe(selUid), sel = $("guiaPedido"), previo = sel.value;
  $("guiaTxt").innerHTML = `<b>Guiando a ${esc(nombreUid(selUid))}</b><br>Toca el mapa donde está el cliente.`;
  sel.innerHTML = vs.map((x) => `<option value="${esc(x.token)}">Pedido ${esc(x.d.pedido || "—")}</option>`).join("");
  if (previo && vs.some((x) => x.token === previo)) sel.value = previo;
  sel.classList.toggle("oculto", vs.length < 2);   // con varios pedidos, eliges para cuál es la guía
  $("btnGuiaQuitar").classList.toggle("oculto", !guias[selUid]);
}
async function fijarGuia(uid, ll, tokenForzado, extra) {
  const dato = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), ts: firebase.database.ServerValue.TIMESTAMP, por: "admin" };
  const tk = tokenForzado || (extra ? "" : $("guiaPedido").value); if (tk) dato.token = tk;
  if (extra) Object.assign(dato, extra);   // guía a un negocio: nombre e icono
  try { await db.ref("guias/" + uid).set(dato); if (typeof PushAdmin !== "undefined" && !Ordenes.esInvitadoUid(uid)) PushAdmin.guia(uid, extra && extra.nombre ? extra.nombre : "");
    if (Ordenes.esInvitadoUid(uid)) db.ref("ordenes/" + PedidosAdmin.tokenInv(uid) + "/guiaAdmin").set(dato).catch(() => {}); toast(`Guía enviada a ${nombreUid(uid)} ✓ Solo la ve él.`); }
  catch (e) { return toast("No se pudo enviar la guía: " + e.message); }
  selUid = null; pintarSeleccion(); pintarLista();   // listo: los demás repartidores no se tocan
}
$("btnGuiaCancelar").onclick = () => { selUid = null; pintarSeleccion(); pintarLista(); };
$("btnGuiaQuitar").onclick = () => { if (selUid) db.ref("guias/" + selUid).remove().then(() => toast("Guía quitada.")).catch((e) => toast(e.message)); };
$("btnGuiaChat").onclick = () => { if (selUid) abrirChatRep(selUid); };

/* ---------- Chat del administrador con un repartidor ---------- */
function abrirChatRep(uid) {
  chatEqAbierto = uid; sinLeerEq[uid] = 0; pintarLista(); pintarChats();
  Chat.iniciar({
    token: uid, yo: "admin", ruta: RUTA_EQ, pedido: "Equipo", nombreRepartidor: nombreUid(uid), puedeBorrar: true, avisos: false,
    titulo: () => "Chat con " + nombreUid(uid),
    subtitulo: () => "Equipo · Brothers ↔ repartidor",
    alEnviar: (m) => { if (typeof PushAdmin !== "undefined") PushAdmin.mensaje(uid, m); },   // aviso push al celular del repartidor
    alCerrar: () => { chatEqAbierto = null; }
  });
  Chat.abrir();
}
function quitarMarcador(uid) { if (marcadores[uid]) { mapa.removeLayer(marcadores[uid]); delete marcadores[uid]; } }

/* ---------- Monitoreo en tiempo real ---------- */
function iniciarMonitoreo() {
  detener();
  const fallo = () => setMsg("msgEquipo", "Sin permiso para leer datos. Revisa las reglas y tu registro en 'admins'.", "error");

  // Ubicación permanente de cada repartidor (con o sin pedido)
  refUbic = db.ref("ubicaciones");
  refUbic.on("child_added", (s) => { ubic[s.key] = s.val(); pintarMarcador(s.key); pintarClientes(); pintarLista(); }, fallo);
  refUbic.on("child_changed", (s) => { ubic[s.key] = s.val(); pintarMarcador(s.key); pintarClientes(); pintarLista(); });
  refUbic.on("child_removed", (s) => { delete ubic[s.key]; quitarMarcador(s.key); pintarLista(); });

  // Facturas del día (cada repartidor suma la suya al enviar)
  $("diaStats").value = Dia.clave(); cargarStats(); cargarCalif();

  // Negocios agregados al mapa
  refLugares = db.ref("lugares");
  refLugares.on("value", (s) => { lugares = s.val() || {}; pintarLugares(); pintarNegocios(); }, fallo);

  // Guías marcadas por Brothers (una por repartidor)
  refGuias = db.ref("guias");
  const guiaOk = (s) => { guias[s.key] = s.val(); pintarGuia(s.key); pintarBannerAdmin(); pintarLista(); if (s.key === selUid) pintarSeleccion(); };
  refGuias.on("child_added", guiaOk, fallo);
  refGuias.on("child_changed", guiaOk);
  refGuias.on("child_removed", (s) => { delete guias[s.key]; pintarGuia(s.key); pintarBannerAdmin(); pintarLista(); if (s.key === selUid) pintarSeleccion(); });

  // Chat de equipo: aviso por voz cuando un repartidor escribe a Brothers
  refEq = db.ref("chatsEquipoResumen");
  let primeraEq = true;
  refEq.on("value", (s) => {
    const n = s.val() || {};
    if (!primeraEq) {
      Object.entries(n).forEach(([uid, r]) => {
        const antes = (resEquipo[uid] && resEquipo[uid].ts) || 0;
        if (r.ultimoDe === "repartidor" && (r.ts || 0) > antes) {
          if (chatEqAbierto !== uid) sinLeerEq[uid] = (sinLeerEq[uid] || 0) + 1;
          Voz.hablar(Voz.repartidorEscribio(nombreUid(uid)));
        }
      });
    }
    primeraEq = false; resEquipo = n; pintarChats(); pintarLista();
  }, fallo);

  if (typeof PedidosAdmin !== "undefined") PedidosAdmin.iniciar();   // pedidos del administrador e invitados

  // Pedidos en ruta (para saber quién lleva qué)
  consultaActivos = db.ref("pedidos").orderByChild("estado").equalTo("en_ruta");
  const alCambiar = (s) => { activos[s.key] = s.val(); pintarClientes(); refrescar(); };
  consultaActivos.on("child_added", alCambiar, fallo);
  consultaActivos.on("child_changed", alCambiar);
  consultaActivos.on("child_removed", (s) => { delete activos[s.key]; pintarClientes(); refrescar(); });

  db.ref("repartidores").on("value", (s) => { registrados = s.val() || {}; refrescar(); pintarEquipo(); pintarChats(); if (refStats) cargarStats(); }, fallo);

  // Últimas 50 conversaciones
  consultaChats = db.ref("chatsResumen").orderByChild("ts").limitToLast(50);
  let primeraCargaChats = true;
  consultaChats.on("value", (s) => {
    const nuevos = s.val() || {};
    if (!primeraCargaChats) {
      // Aviso por voz: el repartidor acaba de escribir (mensaje nuevo = marca de tiempo mayor que la anterior)
      Object.entries(nuevos).forEach(([t, r]) => {
        if ((r.ts || 0) <= ((resumenes[t] && resumenes[t].ts) || 0)) return;   // no es un mensaje nuevo
        if (r.ultimoDe === "repartidor") Voz.hablar(Voz.repartidorEscribio(r.repartidor || ""));
        else if (r.ultimoDe === "cliente") Voz.hablar(Voz.clienteEscribio(nombreCliente(t, r)));
      });
    }
    primeraCargaChats = false;
    resumenes = nuevos; pintarChats();
  }, fallo);
}
function detener() {
  Policia.detener();
  if (refCalif) { refCalif.off(); refCalif = null; } calif = {};
  if (typeof PedidosAdmin !== "undefined") PedidosAdmin.detener();
  if (refUbic) { refUbic.off(); refUbic = null; }
  if (consultaActivos) { consultaActivos.off(); consultaActivos = null; }
  if (consultaChats) { consultaChats.off(); consultaChats = null; }
  if (refGuias) { refGuias.off(); refGuias = null; }
  if (refLugares) { refLugares.off(); refLugares = null; }
  if (refStats) { refStats.off(); refStats = null; }
  facturasHoy = 0;
  Object.keys(lugarMarks).forEach((id) => { mapa.removeLayer(lugarMarks[id]); delete lugarMarks[id]; });
  lugares = {};
  if (refEq) { refEq.off(); refEq = null; }
  Object.keys(guiaCapas).forEach((u) => { delete guias[u]; pintarGuia(u); });
  [guias, sinLeerEq].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  resEquipo = {}; selUid = null; selChats.clear(); modoSel = false;
  db.ref("repartidores").off();
  Object.keys(marcadores).forEach(quitarMarcador);
  Object.keys(clientesM).forEach((t) => { mapa.removeLayer(clientesM[t].pin); mapa.removeLayer(clientesM[t].linea); delete clientesM[t]; });
  [ubic, activos].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  registrados = {}; resumenes = {}; ajusteProgramado = false;
}
function refrescar() { Object.keys(ubic).forEach(pintarMarcador); pintarClientes(); pintarLista(); pintarEquipo(); if (selUid) pintarSeleccion(); }
setInterval(() => { if (!$("vistaApp").classList.contains("oculto")) refrescar(); }, 15000);   // actualiza "hace X s" y "sin señal"

/* ---------- Lista del mapa: todos los repartidores ---------- */
function descripcion(uid, est) {
  const u = ubic[uid] || {}, v = viajeDe(uid);
  if (est === "enRuta") {
    const todos = viajesDe(uid);
    if (todos.length > 1) return `${todos.length} pedidos en ruta: ` + todos.map((x) => x.d.pedido || "—").join(", ");
    const dist = typeof v.d.distancia === "number" ? `a ${formatoDist(v.d.distancia)} del destino` : "sin destino marcado";
    return `Pedido ${v.d.pedido || "—"} · ${dist}`;
  }
  if (est === "libre") return `Sin pedido · señal ${hace(u.ts)}`;   // (la marca de guía se agrega en pintarLista)
  if (est === "sinSenal") return `Última señal ${hace(u.ts)}${v ? " · lleva el pedido " + (v.d.pedido || "—") : ""}`;
  if (est === "desconectado") return `Cerró sesión o perdió conexión ${hace(u.ts)}`;
  return "Aún no ha compartido ubicación";
}
function pintarLista() {   // ya no hay lista inferior: solo el contador del mapa
  const ids = [...new Set([...Object.keys(registrados), ...Object.keys(ubic)])];
  const enRuta = ids.filter((u) => estadoDe(u) === "enRuta").length;
  const enLinea = ids.filter((u) => ["enRuta", "libre"].includes(estadoDe(u))).length;
  $("contador").textContent = `${enRuta} en ruta · ${enLinea} en línea · ${facturasHoy} 🧾` + (ocultos.size ? ` · ${ocultos.size} 👁‍🗨 ocultos` : "");
  $("btnOcultar").querySelector("small").textContent = ocultos.size ? ocultos.size + " ocultos" : "Repartidores";
}

/* ---------- Chats: equipo + clientes, selección múltiple, envío y borrado por fecha ---------- */
const RUTA_CL = { chats: "chats", resumen: "chatsResumen", fotos: "fotos" };
const fechaCorta = (ts) => (ts ? new Date(ts).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
function conversaciones() {
  const eq = Object.keys(registrados).map((uid) => {
    const r = resEquipo[uid] || {};
    return { key: "eq:" + uid, titulo: "👥 " + nombreUid(uid), ts: r.ts || 0, sinLeer: sinLeerEq[uid] || 0,
      sub: r.ultimo ? `${r.ultimoDe === "admin" ? "Tú" : nombreUid(uid)}: ${r.ultimo}` : "Sin mensajes todavía" };
  }).sort((a, b) => b.ts - a.ts || a.titulo.localeCompare(b.titulo));
  const cl = Object.entries(resumenes).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).map(([token, r]) => ({
    key: "cl:" + token, titulo: `Pedido ${r.pedido || "—"} · ${r.repartidor || "Repartidor"}`, ts: r.ts || 0, sinLeer: 0,
    sub: `${r.ultimoDe === "cliente" ? "Cliente" : (r.repartidor || "Repartidor")}: ${r.ultimo || ""}` }));
  return { eq, cl };
}
function pintarChats() {
  const { eq, cl } = conversaciones();
  const tarjeta = (c) => `<div class="tarjeta-rep conv${selChats.has(c.key) ? " sel" : ""}" data-key="${esc(c.key)}" style="cursor:pointer"><div class="fila">
      ${modoSel ? `<input type="checkbox" class="chk" ${selChats.has(c.key) ? "checked" : ""} tabindex="-1" aria-label="Seleccionar">` : `<span class="avatar">${RIDER_SVG}</span>`}
      <div class="datos"><strong>${esc(c.titulo)}${c.sinLeer ? ` <span class="badge">${c.sinLeer}</span>` : ""}</strong>
        <small>${esc(c.sub)}</small><small>${esc(fechaCorta(c.ts))}</small></div></div></div>`;
  $("listaChats").innerHTML =
    `<h3 class="sec">Equipo (chat con tus repartidores)</h3>` + (eq.length ? eq.map(tarjeta).join("") : '<p class="ayuda">Aún no hay repartidores.</p>') +
    `<h3 class="sec">Clientes (archivo de pedidos)</h3>` + (cl.length ? cl.map(tarjeta).join("") : '<p class="ayuda">Aún no hay conversaciones de clientes.</p>');
  actualizarBarraSel();
}
function actualizarBarraSel() {
  $("btnModoSel").textContent = modoSel ? "✕ Salir de selección" : "☑ Seleccionar";
  ["selInfo", "btnSelTodos", "btnSelEnviar", "btnSelBorrar"].forEach((id) => $(id).classList.toggle("oculto", !modoSel));
  $("selInfo").textContent = selChats.size + " seleccionado" + (selChats.size === 1 ? "" : "s");
}
$("btnModoSel").onclick = () => { modoSel = !modoSel; selChats.clear(); pintarChats(); };
$("btnSelTodos").onclick = () => {
  const { eq, cl } = conversaciones(), todas = [...eq, ...cl].map((c) => c.key);
  if (todas.every((k) => selChats.has(k))) selChats.clear(); else todas.forEach((k) => selChats.add(k));
  pintarChats();
};
$("listaChats").onclick = (e) => {
  const k = e.target.closest("[data-key]")?.dataset.key;
  if (!k) return;
  if (modoSel) { selChats.has(k) ? selChats.delete(k) : selChats.add(k); return pintarChats(); }
  const id = k.slice(3);
  if (k.startsWith("eq:")) return abrirChatRep(id);
  const r = resumenes[id] || {};
  Chat.iniciar({
    token: id, soloLectura: true, puedeBorrar: true, pedido: r.pedido, nombreRepartidor: r.repartidor,
    titulo: (c) => "Pedido " + (c.pedido || "—"),
    subtitulo: (c) => (c.nombreRepartidor ? "Repartidor: " + c.nombreRepartidor : "")
  });
  Chat.abrir();
};

/* Ventana de diálogo del administrador */
function modal(html) { $("modalCaja").innerHTML = html; $("modalAdmin").classList.remove("oculto"); }
const cerrarModal = () => $("modalAdmin").classList.add("oculto");
const rutaDe = (k) => (k.startsWith("eq:") ? { r: RUTA_EQ, id: k.slice(3) } : { r: RUTA_CL, id: k.slice(3) });

$("btnSelEnviar").onclick = () => {
  const uids = [...selChats].filter((k) => k.startsWith("eq:")).map((k) => k.slice(3));
  const clientes = [...selChats].filter((k) => k.startsWith("cl:")).length;
  if (!uids.length) return toast("Selecciona al menos un chat del equipo (repartidores).");
  modal(`<h2>✉️ Enviar mensaje</h2>
    <p>Se enviará a <b>${uids.length}</b> repartidor${uids.length > 1 ? "es" : ""}: ${uids.map((u) => esc(nombreUid(u))).join(", ")}.
    ${clientes ? `<br><small>Los ${clientes} chat(s) de clientes seleccionados no reciben mensajes del administrador.</small>` : ""}</p>
    <textarea id="envTexto" rows="4" maxlength="600" placeholder="Escribe el mensaje…"></textarea>
    <button id="envOk" class="primario" type="button">Enviar</button><button id="envNo" class="oscuro" type="button">Cancelar</button>`);
  $("envNo").onclick = cerrarModal;
  $("envOk").onclick = async () => {
    const t = $("envTexto").value.trim(); if (!t) return;
    $("envOk").disabled = true;
    try {
      await Promise.all(uids.map((u) => Chat.enviarA(u, "admin", { pedido: "Equipo", nombreRepartidor: nombreUid(u) }, t, null, RUTA_EQ)));
      cerrarModal(); toast(`Mensaje enviado a ${uids.length} repartidor${uids.length > 1 ? "es" : ""} ✓`);
    } catch (e) { toast("Error al enviar: " + e.message); $("envOk").disabled = false; }
  };
};

/* Eliminar mensajes de varios chats, por fecha o todo */
async function planBorrado(keys, d, h) {
  const plan = []; let total = 0;
  for (const k of keys) {
    const { r, id } = rutaDe(k);
    const msgs = (await db.ref(`${r.chats}/${id}`).once("value")).val() || {};
    const todos = Object.entries(msgs);
    const ids = todos.filter(([, m]) => (!d || (m.ts || 0) >= d) && (!h || (m.ts || 0) <= h)).map(([i]) => i);
    if (ids.length) { plan.push({ r, id, ids, restantes: todos.filter(([i]) => !ids.includes(i)).map(([, m]) => m) }); total += ids.length; }
  }
  return { plan, total };
}
async function ejecutarBorrado(plan) {
  for (const p of plan) {
    const upd = {};
    p.ids.forEach((i) => { upd[`${p.r.chats}/${p.id}/${i}`] = null; upd[`${p.r.fotos}/${p.id}/${i}`] = null; });
    if (!p.restantes.length) upd[`${p.r.resumen}/${p.id}`] = null;   // chat vacío: sale de la lista
    else {
      const ult = p.restantes.sort((a, b) => (a.ts || 0) - (b.ts || 0)).pop();
      upd[`${p.r.resumen}/${p.id}/ultimoDe`] = ult.de;
      upd[`${p.r.resumen}/${p.id}/ultimo`] = (ult.texto || "Foto enviada").slice(0, 100);
      upd[`${p.r.resumen}/${p.id}/ts`] = ult.ts || firebase.database.ServerValue.TIMESTAMP;
    }
    await db.ref().update(upd);
  }
}
$("btnSelBorrar").onclick = () => {
  if (!selChats.size) return toast("Selecciona al menos un chat.");
  modal(`<h2>🗑 Eliminar mensajes</h2>
    <p>En <b>${selChats.size}</b> chat${selChats.size > 1 ? "s" : ""} seleccionado${selChats.size > 1 ? "s" : ""}.</p>
    <label class="opcion"><input type="radio" name="modoB" value="fecha" checked> Solo los de estas fechas</label>
    <div class="dos-botones"><label>Desde<input type="date" id="bDesde"></label><label>Hasta<input type="date" id="bHasta"></label></div>
    <small>Puedes dejar una vacía (sin límite). “Hasta” incluye ese día completo.</small>
    <label class="opcion"><input type="radio" name="modoB" value="todo"> Todo el historial</label>
    <button id="bOk" class="primario" type="button">Revisar y eliminar</button><button id="bNo" class="oscuro" type="button">Cancelar</button>`);
  $("bNo").onclick = cerrarModal;
  $("bOk").onclick = async () => {
    let d = null, h = null;
    if (document.querySelector("input[name=modoB]:checked").value === "fecha") {
      if ($("bDesde").value) d = new Date($("bDesde").value + "T00:00:00").getTime();
      if ($("bHasta").value) h = new Date($("bHasta").value + "T23:59:59.999").getTime();
      if (!d && !h) return toast("Elige al menos una fecha o marca “Todo el historial”.");
      if (d && h && d > h) return toast("“Desde” no puede ser posterior a “Hasta”.");
    }
    $("bOk").disabled = true; $("bOk").textContent = "Revisando…";
    try {
      const { plan, total } = await planBorrado([...selChats], d, h);
      if (!total) { cerrarModal(); return toast("No hay mensajes en ese rango."); }
      if (!confirm(`Se eliminarán ${total} mensaje${total > 1 ? "s" : ""} de ${plan.length} chat${plan.length > 1 ? "s" : ""}. Esto no se puede deshacer. ¿Continuar?`)) {
        $("bOk").disabled = false; $("bOk").textContent = "Revisar y eliminar"; return;
      }
      await ejecutarBorrado(plan);
      cerrarModal(); selChats.clear(); pintarChats(); toast(`Se eliminaron ${total} mensajes ✓`);
    } catch (e) { toast("No se pudo eliminar: " + e.message); $("bOk").disabled = false; $("bOk").textContent = "Revisar y eliminar"; }
  };
};

/* ---------- Equipo: agregar y quitar repartidores ---------- */
function pintarEquipo() {
  const ids = Object.keys(registrados);
  const invitados = typeof PedidosAdmin !== "undefined" ? PedidosAdmin.htmlInvitados() : "";   // repartidores invitados activos
  if (!ids.length && !invitados) { $("listaEquipo").innerHTML = '<p class="ayuda">Aún no hay repartidores registrados.</p>'; return; }
  $("listaEquipo").innerHTML = ids.map((uid) => {
    const i = infoReg(uid), est = estadoDe(uid), [texto, clase] = ETIQUETA[est];
    return `<div class="tarjeta-rep">
      <div class="fila">
        <span class="avatar">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(nombreUid(uid))}</strong>
          <small>${i.email ? esc(i.email) : "Sin correo registrado · " + esc(uid.slice(0, 8)) + "…"}</small></div>
        <span class="chip ${clase}">${texto}</span>
      </div>
      <div class="acciones-fila">
        ${i.email ? `<button class="mini" data-accion="reset" data-uid="${esc(uid)}">Restablecer clave</button>` : ""}
        <button class="mini peligro" data-accion="quitar" data-uid="${esc(uid)}">Quitar</button>
      </div></div>`;
  }).join("") + (invitados ? '<h3 class="sec">Invitados activos</h3>' + invitados : "");
}
$("listaEquipo").onclick = (e) => {
  const b = e.target.closest("button[data-accion]"); if (!b) return;
  const uid = b.dataset.uid, i = infoReg(uid), nombre = nombreUid(uid);
  if (b.dataset.accion === "quitar") {
    if (!confirm(`¿Quitar a ${nombre}?${viajeDe(uid) ? " Tiene un viaje en curso." : ""} Ya no podrá usar la app ni aparecerá en el mapa.`)) return;
    db.ref().update({ ["repartidores/" + uid]: null, ["ubicaciones/" + uid]: null })
      .then(() => setMsg("msgEquipo", `${nombre} fue quitado del equipo.`, "ok"))
      .catch((err) => setMsg("msgEquipo", "No se pudo quitar: " + err.message, "error"));
  } else {
    auth.sendPasswordResetEmail(i.email)
      .then(() => setMsg("msgEquipo", `Enviamos un correo a ${i.email} para cambiar su contraseña.`, "ok"))
      .catch((err) => setMsg("msgEquipo", errorAuth(err), "error"));
  }
};

$("btnAgregar").onclick = async () => {
  const email = $("nuevoCorreo").value.trim().toLowerCase();
  const clave = $("nuevaClave").value;
  if (!email || clave.length < 6) return setMsg("msgEquipo", "Escribe el correo y una contraseña de al menos 6 caracteres.", "error");
  setMsg("msgEquipo", "Creando repartidor…");
  $("btnAgregar").disabled = true;

  // Segunda instancia de Firebase: crear la cuenta NO cierra tu sesión de administrador
  secundaria = secundaria || firebase.initializeApp(FIREBASE_CONFIG, "secundaria");
  const a = secundaria.auth();
  try {
    let uid;
    try { uid = (await a.createUserWithEmailAndPassword(email, clave)).user.uid; }
    catch (e) {
      if (e.code !== "auth/email-already-in-use") throw e;
      try { uid = (await a.signInWithEmailAndPassword(email, clave)).user.uid; }
      catch (_) { throw { message: "Ese correo ya existe. Escribe su contraseña actual para volver a registrarlo, o usa “Restablecer clave”." }; }
    }
    // El nombre de usuario lo elige el propio repartidor la primera vez que entra
    await db.ref("repartidores/" + uid).set({ email, nombre: nombreDesdeCorreo(email), creado: firebase.database.ServerValue.TIMESTAMP });
    $("nuevoCorreo").value = ""; $("nuevaClave").value = "";
    setMsg("msgEquipo", `Listo: ${email} ya puede entrar a la app. Elegirá su nombre de usuario al iniciar sesión.`, "ok");
  } catch (e) {
    setMsg("msgEquipo", e.code ? errorAuth(e) : e.message, "error");
  } finally {
    try { await a.signOut(); } catch (_) {}
    $("btnAgregar").disabled = false;
  }
};


/* ---------- Botón / gesto atrás: cierra de a una capa, sin cerrar la app ---------- */
Atras.iniciar([
  () => Chat.cerrarCapa(),
  () => (typeof PedidosAdmin !== "undefined" && PedidosAdmin.cerrarMapaForm()),
  () => { if (!$("modalAdmin").classList.contains("oculto")) { cerrarModal(); return true; } return false; },
  () => { if (mapa && mapa._popup && mapa._popup.isOpen && mapa._popup.isOpen()) { mapa.closePopup(); return true; } return false; },
  () => { if (!$("resBusq").classList.contains("oculto") || document.activeElement === $("busq")) { $("resBusq").classList.add("oculto"); $("busq").blur(); return true; } return false; },
  () => { if (modoNegocio) { terminarModoNegocio(); return true; } return false; },
  () => { if (selUid) { selUid = null; pintarSeleccion(); pintarLista(); return true; } return false; },
  () => { if (modoSel) { modoSel = false; selChats.clear(); pintarChats(); return true; } return false; },
  () => { const t = document.querySelector('.tabs button[data-tab="panelMapa"]'); if ($("vistaApp").classList.contains("oculto") || t.classList.contains("activa")) return false; t.click(); return true; }
]);


/* ---------- Ocultar repartidores del mapa (lista con interruptores) ---------- */
function abrirOcultar() {
  const uids = [...new Set([...Object.keys(registrados), ...Object.keys(ubic)])].sort((x, y) => nombreUid(x).localeCompare(nombreUid(y)));
  modal(`<h2>👁 Repartidores en el mapa</h2>
    <p class="ayuda">Activa o desactiva a cada uno. Los desactivados no aparecen en el mapa (ni su guía ni sus clientes). Siguen trabajando normal.</p>
    <div class="lista-sw">${uids.length ? uids.map((uid) => { const [txt, clase] = ETIQUETA[estadoDe(uid)]; return `<label class="fila-sw"><span><strong>${esc(nombreUid(uid))}</strong><small class="chip ${clase}">${txt}</small></span><input type="checkbox" class="sw" data-uid="${esc(uid)}" ${ocultos.has(uid) ? "" : "checked"}></label>`; }).join("") : '<p class="ayuda">Aún no hay repartidores.</p>'}</div>
    <button id="ocTodos" class="oscuro" type="button">Mostrar a todos</button><button id="ocListo" class="primario" type="button">Listo</button>`);
  const aplicar = () => {
    guardarOcultos();
    if (selUid && ocultos.has(selUid)) { selUid = null; pintarSeleccion(); }
    refrescar(); Object.keys(guias).forEach(pintarGuia);
  };
  document.querySelectorAll("#modalCaja input.sw").forEach((i) => i.onchange = () => {
    if (i.checked) ocultos.delete(i.dataset.uid); else ocultos.add(i.dataset.uid);
    aplicar();
  });
  $("ocTodos").onclick = () => { ocultos.clear(); guardarOcultos(); document.querySelectorAll("#modalCaja input.sw").forEach((i) => i.checked = true); aplicar(); };
  $("ocListo").onclick = cerrarModal;
}
$("btnOcultar").onclick = abrirOcultar;


/* ---------- Voz: nombre del cliente y permiso de audio del navegador ---------- */
function nombreCliente(token, r) {   // la factura del pedido en ruta o la orden del administrador traen el nombre
  const f = activos[token] && activos[token].factura;
  const n = (f && (f.cliente || f.nombre)) || (typeof PedidosAdmin !== "undefined" && PedidosAdmin.clienteDe(token)) || "";
  return n || (r && r.pedido ? "del pedido " + r.pedido : "");
}
function revisarVoz() { const a = $("avisoVoz"); if (a) a.classList.toggle("oculto", Voz.lista()); }
$("btnActivarVoz").onclick = () => { Voz.activar(); Voz.hablar(Voz.FRASES.prueba, { forzar: true }); revisarVoz(); };
const timerVoz = setInterval(() => { revisarVoz(); if (Voz.lista()) clearInterval(timerVoz); }, 1000);
revisarVoz();

/* ---------- Calificaciones de los clientes (calificaciones/{token}) ---------- */
let refCalif = null, calif = {};
function cargarCalif() {
  if (refCalif) refCalif.off();
  refCalif = db.ref("calificaciones").orderByChild("ts").limitToLast(1000);
  refCalif.on("value", (s) => { calif = s.val() || {}; pintarCalif(); }, (e) => { $("califLista").innerHTML = `<p class="ayuda">No se pudieron leer las calificaciones: ${esc(e.message)}</p>`; });
}
$("califRango").onchange = () => pintarCalif();
function estrellasTxt(n) { const r = Math.round(n); return "★".repeat(r) + "☆".repeat(5 - r); }
function chispaCalif(rs) {   // promedio por semana (últimas 8): sube o baja en el tiempo
  const SEM = 7 * 864e5, ahora = Date.now(), b = Array.from({ length: 8 }, () => []);
  rs.forEach((r) => { const i = 7 - Math.floor((ahora - r.ts) / SEM); if (i >= 0 && i < 8) b[i].push(r.estrellas); });
  const pts = b.map((a, i) => a.length ? [i * 12 + 4, 26 - ((a.reduce((x, y) => x + y, 0) / a.length) - 1) / 4 * 22] : null).filter(Boolean);
  if (pts.length < 2) return "";
  return `<svg width="100" height="30" viewBox="0 0 100 30" aria-label="Evolución semanal"><polyline fill="none" stroke="#F59E0B" stroke-width="2.5" stroke-linejoin="round" points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" ")}"/>${pts.map((p) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.5" fill="#F59E0B"/>`).join("")}</svg>`;
}
function pintarCalif() {
  const caja = $("califLista"); if (!caja) return;
  const dias = +$("califRango").value, desde = dias ? Date.now() - dias * 864e5 : 0;
  const todas = Object.entries(calif).map(([t, r]) => Object.assign({ token: t }, r)).filter((r) => typeof r.estrellas === "number" && r.ts);
  if (!todas.length) { caja.innerHTML = '<p class="ayuda">Aún no hay calificaciones de clientes.</p>'; return; }
  const grupos = {};
  todas.forEach((r) => { const u = r.repartidorUid || "sin"; (grupos[u] = grupos[u] || []).push(r); });
  const prom = (a) => a.reduce((x, r) => x + r.estrellas, 0) / a.length;
  const filas = Object.entries(grupos).map(([u, rs]) => {
    const rango = rs.filter((r) => r.ts >= desde), ult = rs.slice().sort((a, b) => b.ts - a.ts);
    const nombre = (ubic[u] || registrados[u]) ? nombreUid(u) : ((ult.find((r) => r.repartidorNombre) || {}).repartidorNombre || (u.startsWith("inv_") ? "Invitado" : "Repartidor"));
    return { u, nombre, rs, rango, total: prom(rs), pr: rango.length ? prom(rango) : null, ult };
  }).sort((a, b) => (b.pr || 0) - (a.pr || 0) || b.rs.length - a.rs.length);
  const g = todas.length, gp = prom(todas);
  caja.innerHTML = `<div class="stats-total"><b>${gp.toFixed(1)}</b> ★ promedio general · ${g} calificación${g === 1 ? "" : "es"}</div>` + filas.map((f) =>
    `<details class="stats-fila" style="display:block"><summary style="display:flex;justify-content:space-between;gap:8px;align-items:center;cursor:pointer">
      <div><strong>${esc(f.nombre)}${f.u.startsWith("inv_") ? ' <i class="pd-tag">Invitado</i>' : ""}</strong>
      <small style="display:block">${f.pr == null ? "Sin calificaciones en este periodo" : `<b style="color:#F59E0B">${estrellasTxt(f.pr)}</b> ${f.pr.toFixed(1)} · ${f.rango.length} en el periodo`}</small>
      <small style="display:block">Acumulado: ${f.total.toFixed(1)} ★ · ${f.rs.length} en total</small></div>${chispaCalif(f.rs)}</summary>
      ${f.ult.slice(0, 8).map((r) => `<div style="padding:6px 0;border-top:1px solid #eee"><b style="color:#F59E0B">${estrellasTxt(r.estrellas)}</b> <small>${new Date(r.ts).toLocaleDateString()}${r.pedido ? " · pedido " + esc(r.pedido) : ""}</small>${r.comentario ? `<div>${esc(r.comentario)}</div>` : ""}</div>`).join("")}
    </details>`).join("");
}
