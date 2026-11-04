/* ============================================================
   SOLICITUDES-REPARTIDOR · Pool "Nuevos Chats" (FASE 2 del ecosistema de chats)
   Escucha solicitudes_entrantes (los clientes las crean desde cliente-app.html):
   1) Pool: pestaña "📥 Nuevos chats" con Pendientes / Mis chats / Todos + badge en la cabecera.
   2) "Atender": TRANSACCIÓN atómica en solicitudes_entrantes/{id}/asignacion — el primer
      repartidor que toca se queda el chat; para los demás la transacción se aborta.
      Al atender se crea el pedido real (pedidos/{token}, estado "en_ruta", sinFactura:true,
      con su código BD##### del contador compartido CodigosBD) y el chat queda bloqueado.
   3) Factura: el botón "🧾 Crear factura" preselecciona ese contacto en la factura existente
      (factura.js) y, cuando se envía, la factura entra al chat del cliente como TARJETA
      (mensaje tipo:"factura"). Al entregar o cancelar, el chat se cierra solo.
   INTEGRACIÓN SIN TOCAR repartidor.js NI factura.js: este módulo se carga DESPUÉS y usa
   sus globales (uidActual, usuario, viajes, orden, chatToken, crearViaje, guardarViajes,
   sincronizarContactos, renderLista, irA, FacturaVivo, CodigosBD, generarToken,
   etiquetaPedido) y envuelve sus ganchos (Factura.alEnviar, abrirChat, quitarViaje).
   Requiere: repartidor.html (con el botón #btnSolicitudes y el modal #modalSolicitudes),
   chat.js, factura.js, firebase-config.js, ordenes-core.js.
   ============================================================ */
(function () {
"use strict";

const RUTA = "solicitudes_entrantes";
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;
const db = APP.database();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "C$ " + (Number(n) || 0).toFixed(2);
const hace = (ts) => {
  if (!ts) return "";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "ahora";
  if (m < 60) return "hace " + m + " min";
  const h = Math.floor(m / 60);
  if (h < 24) return "hace " + h + " h";
  return new Date(ts).toLocaleDateString("es");
};
const clienteDe = (s) => (s && s.cliente && s.cliente.nombre) || "Cliente";
const codigoBonito = (c) => {
  try { if (typeof etiquetaPedido === "function") return etiquetaPedido(c, "app"); } catch (_) {}
  const d = String(c == null ? "" : c).replace(/\D/g, "");
  return d ? "APP" + d.padStart(5, "0") : String(c == null ? "" : c);
};

let solicitudes = {};          // id → datos de la solicitud (en vivo)
let refSol = null;             // listener del pool
let chatAbiertoId = null;      // solicitud cuyo chat está abierto ahora
let filtro = "pendientes";     // "pendientes" | "mios" | "todos"
let pendPrevias = new Set();   // pendientes ya vistas: solo se avisa de las NUEVAS
const chatPedidos = {};        // token → { id, codigo, cliente } (pedidos nacidos de un chat)

/* ---------- Listener del pool ---------- */
function attach() {
  if (refSol) return;
  refSol = db.ref(RUTA);
  refSol.on("value", (s) => {
    solicitudes = s.val() || {};
    reconstruir(); autoreparar(); avisarNuevas(); pintar(); liberarLeidos();
  }, () => { refSol = null; });   // sin permisos aún (sin sesión): se reintenta al entrar
}
function soltar() {
  if (refSol) { refSol.off(); refSol = null; }
  solicitudes = {}; pendPrevias = new Set();
  Object.keys(chatPedidos).forEach((k) => { delete chatPedidos[k]; });
  pintar();
}
APP.auth().onAuthStateChanged((u) => {
  const b = $("btnSolicitudes");
  if (b) b.classList.toggle("oculto", !u);
  if (u) attach(); else soltar();
});

/* Mapa token → solicitud, reconstruido en cada cambio (sobrevive a reinicios de la app) */
function reconstruir() {
  Object.keys(chatPedidos).forEach((k) => { delete chatPedidos[k]; });
  Object.entries(solicitudes).forEach(([id, s]) => {
    if (s && s.token) chatPedidos[s.token] = { id, codigo: s.pedido || "", cliente: clienteDe(s) };
  });
}

/* Si la app se cerró con chats atendidos, se recrean sus viajes (aparecen en el mapa,
   en la hoja de pedidos y en Factura.contactos para poder facturarlos) */
function autoreparar() {
  if (!uidActual || !usuario || typeof crearViaje !== "function") return;
  Object.entries(solicitudes).forEach(([id, s]) => {
    if (!s || s.estado !== "atendida" || !s.token) return;
    if (!s.asignacion || s.asignacion.uid !== uidActual) return;
    if (viajes[s.token]) return;
    crearViaje({ token: s.token, pedido: s.pedido || "", cliente: clienteDe(s), sinFactura: true });
    db.ref("pedidos/" + s.token).update(esqueletoPedido(id, s.pedido || "")).catch(() => {});
    if (typeof guardarViajes === "function") guardarViajes();
    if (typeof sincronizarContactos === "function") sincronizarContactos();
    if (typeof renderLista === "function") renderLista();
  });
}

/* Esqueleto del pedido real que nace del chat (mismo modelo que pedidos/{token} normal) */
function esqueletoPedido(id, codigo) {
  return {
    estado: "en_ruta", pedido: codigo, inicio: TS,
    repartidorUid: uidActual, repartidorNombre: usuario,
    sinFactura: true, solicitudId: id, origen: "chat"
  };
}

/* Aviso de solicitud nueva: vibración + voz + estado, solo si es nueva en este aparato */
function avisarNuevas() {
  const ahora = new Set(Object.keys(solicitudes).filter((id) => !solicitudes[id].estado || solicitudes[id].estado === "pendiente"));
  let nueva = null;
  ahora.forEach((id) => { if (!pendPrevias.has(id)) nueva = id; });
  pendPrevias = ahora;
  if (nueva && uidActual && !document.hidden) {
    navigator.vibrate && navigator.vibrate([300, 150, 300]);
    if (typeof setEstado === "function") setEstado("📥 Nuevo chat de cliente: " + clienteDe(solicitudes[nueva]), "ok");
    if (typeof Voz !== "undefined" && Voz.hablar) Voz.hablar("Nuevo chat de cliente", { forzar: true });
  }
}

/* Mensajes ya leídos mientras el chat estaba abierto: se limpian para el badge */
function liberarLeidos() {
  if (!chatAbiertoId) return;
  const s = solicitudes[chatAbiertoId];
  if (s && Number(s.sinLeerRep)) db.ref(RUTA + "/" + chatAbiertoId + "/sinLeerRep").remove().catch(() => {});
}

/* ---------- Pool: pestañas y tarjetas ---------- */
function pintar() {
  badge();
  const cont = $("listaSolicitudes"); if (!cont) return;
  const lista = Object.entries(solicitudes).map(([id, s]) => Object.assign({ id }, s));
  const pend = lista.filter((s) => !s.estado || s.estado === "pendiente");
  const mias = lista.filter((s) => s.estado === "atendida" && s.asignacion && s.asignacion.uid === uidActual);
  const otras = lista.filter((s) => s.estado === "atendida" && !(s.asignacion && s.asignacion.uid === uidActual));
  const cerradas = lista.filter((s) => s.estado === "cerrada");
  let html = "";
  if (filtro === "pendientes" || filtro === "todos") {
    html += '<h3 class="sol-h">⏳ Pendientes (' + pend.length + ")</h3>" + (pend.length ? pend.map(tarjetaPendiente).join("") : '<p class="ayuda">Sin solicitudes pendientes.</p>');
  }
  if (filtro === "mios" || filtro === "todos") {
    html += '<h3 class="sol-h">💬 Mis chats (' + mias.length + ")</h3>" + (mias.length ? mias.map(tarjetaMia).join("") : '<p class="ayuda">Aún no has atendido chats.</p>');
  }
  if (filtro === "todos") {
    html += '<h3 class="sol-h">🛵 Atendidos por otros (' + otras.length + ")</h3>" + (otras.length ? otras.map(tarjetaMia).join("") : '<p class="ayuda">—</p>');
    html += '<h3 class="sol-h">✅ Cerrados (' + cerradas.length + ")</h3>" + (cerradas.length ? cerradas.map(tarjetaMia).join("") : '<p class="ayuda">—</p>');
  }
  cont.innerHTML = html;
}
function tarjetaPendiente(s) {
  return '<div class="sol-card">' +
    '<div class="sol-top"><b>🧑 ' + esc(clienteDe(s)) + "</b><small>" + esc(hace(s.creado)) + "</small></div>" +
    '<div class="sol-prev">' + (s.ultimo && s.ultimo.texto ? esc(s.ultimo.texto) : "Quiere hacer un pedido nuevo.") + "</div>" +
    (Number(s.sinLeerRep) ? '<div><span class="badge-nav rojo">💬 ' + Number(s.sinLeerRep) + "</span></div>" : "") +
    '<div class="sol-btns"><button type="button" class="primario" data-acc="atender" data-id="' + esc(s.id) + '">✅ Atender</button></div>' +
    "</div>";
}
function tarjetaMia(s) {
  const mia = !!(uidActual && s.asignacion && s.asignacion.uid === uidActual);
  const chip = s.estado === "cerrada" ? '<span class="chip">Cerrado</span>' : '<span class="chip vivo">En curso</span>';
  const botones = ['<button type="button" class="boton-chat" data-acc="chat" data-id="' + esc(s.id) + '">💬 Chat</button>'];
  if (s.estado === "atendida" && !s.factura && s.token) botones.push('<button type="button" class="mini pri" data-acc="factura" data-id="' + esc(s.id) + '">🧾 Crear factura</button>');
  if (s.factura && s.token && typeof FacturaVivo !== "undefined") botones.push('<button type="button" class="mini pri" data-acc="vivo" data-id="' + esc(s.id) + '">🧾 Factura en vivo</button>');
  return '<div class="sol-card">' +
    '<div class="sol-top"><b>🧑 ' + esc(clienteDe(s)) + (mia ? "" : " · " + esc((s.asignacion && s.asignacion.nombre) || "otro repartidor")) + "</b>" + chip + "</div>" +
    '<div class="sol-prev">' + (s.pedido ? "Pedido " + esc(codigoBonito(s.pedido)) : "Sin pedido aún") + (s.ultimo && s.ultimo.texto ? " · " + esc(s.ultimo.texto) : "") + "</div>" +
    (Number(s.sinLeerRep) ? '<div><span class="badge-nav rojo">💬 ' + Number(s.sinLeerRep) + " sin leer</span></div>" : "") +
    '<div class="sol-btns">' + botones.join("") + "</div>" +
    "</div>";
}
function badge() {
  const b = $("badgeSolicitudes"); if (!b) return;
  let n = 0;
  Object.entries(solicitudes).forEach(([id, s]) => {
    if (!s) return;
    if (!s.estado || s.estado === "pendiente") { n += 1; return; }
    if (s.estado === "atendida" && s.asignacion && s.asignacion.uid === uidActual && Number(s.sinLeerRep) && id !== chatAbiertoId) n += Number(s.sinLeerRep);
  });
  b.textContent = String(n);
  b.classList.toggle("oculto", !n);
}

/* ---------- Atender: TRANSACCIÓN atómica (solo el primero se queda el chat) ---------- */
async function atender(id) {
  if (!uidActual || !usuario) return alert("Tu sesión aún no está lista.");
  const s = solicitudes[id]; if (!s) return;
  if (!window.Factura || typeof generarToken !== "function") return alert("Faltan módulos de la app (factura.js / repartidor.js).");
  const b = document.querySelector('#listaSolicitudes button[data-acc="atender"][data-id="' + id + '"]');
  if (b) b.disabled = true;
  const token = generarToken();
  const codigo = ((typeof CodigosBD !== "undefined" && CodigosBD && typeof CodigosBD.siguiente === "function" && CodigosBD.siguiente()) || Factura.nuevoCodigo());
  let res = null;
  try {
    res = await db.ref(RUTA + "/" + id + "/asignacion").transaction((cur) => {
      if (cur && cur.uid) return;   // otro repartidor llegó primero: la transacción se aborta
      return { tipo: "registrado", uid: uidActual, nombre: usuario, ts: TS };
    }, undefined, false);
  } catch (e) {
    if (b) b.disabled = false;
    return alert("No se pudo atender: " + e.message);
  }
  if (!res.committed) { pintar(); return alert("Otro repartidor ya atendió este chat."); }
  const upd = {};
  upd[RUTA + "/" + id + "/estado"] = "atendida";
  upd[RUTA + "/" + id + "/token"] = token;
  upd[RUTA + "/" + id + "/pedido"] = codigo;
  upd[RUTA + "/" + id + "/actualizado"] = TS;
  upd["pedidos/" + token] = esqueletoPedido(id, codigo);
  try { await db.ref().update(upd); }
  catch (e) { return alert("Atendiste el chat, pero no se pudo crear el pedido: " + e.message); }
  chatPedidos[token] = { id, codigo, cliente: clienteDe(s) };
  db.ref("chats/" + id).push({ de: "sistema", tipo: "sistema", texto: "🛵 " + usuario + " atenderá tu pedido. Te escribe por aquí para confirmar detalles.", ts: TS }).catch(() => {});
  if (!viajes[token]) {
    crearViaje({ token, pedido: codigo, cliente: clienteDe(s), sinFactura: true });
    if (typeof guardarViajes === "function") guardarViajes();
    if (typeof sincronizarContactos === "function") sincronizarContactos();
    if (typeof renderLista === "function") renderLista();
  }
  filtro = "mios";
  pintar();
  abrirChatSolicitud(id);
}

/* ---------- Chat de la solicitud (sala chats/{solicitudId}, la misma del cliente) ---------- */
function abrirChatSolicitud(id) {
  const s = solicitudes[id]; if (!s) return;
  if (typeof Chat === "undefined") return alert("Falta chat.js en esta página.");
  Chat.iniciar({
    token: id, yo: "repartidor", pedido: s.pedido || "Nuevo chat", nombreRepartidor: usuario, avisos: false,
    titulo: () => "Chat con " + clienteDe(s),
    subtitulo: () => (s.pedido ? "Pedido " + codigoBonito(s.pedido) : "Solicitud de pedido"),
    alCerrar: () => { if (chatAbiertoId === id) { chatAbiertoId = null; pintar(); } }
  });
  chatAbiertoId = id;
  try { chatToken = id; } catch (_) {}   // global de repartidor.js: silencia avisos duplicados
  db.ref(RUTA + "/" + id + "/sinLeerRep").remove().catch(() => {});
  Chat.abrir();
  pintar();
}

/* ---------- Factura: preselecciona el contacto y abre la factura existente ---------- */
function crearFacturaChat(id) {
  const s = solicitudes[id];
  if (!s || !s.token) return alert("Este chat aún no tiene pedido asociado.");
  if (s.factura) return alert("Este chat ya tiene su factura enviada. Usa 🧾 Factura en vivo para revisarla.");
  if (!viajes[s.token] && typeof crearViaje === "function") {
    crearViaje({ token: s.token, pedido: s.pedido || "", cliente: clienteDe(s), sinFactura: true });
    if (typeof guardarViajes === "function") guardarViajes();
  }
  if (typeof sincronizarContactos === "function") sincronizarContactos();
  try {   // factura.js: deja ese contacto y ese cliente ya elegidos
    if (typeof Factura.refrescarContactos === "function") Factura.refrescarContactos();
    const sel = document.getElementById("contactoSel");
    if (sel) { sel.value = s.token; if (typeof alElegirContacto === "function") alElegirContacto(); }
    const cn = document.getElementById("customerName");
    if (cn && !cn.value.trim()) cn.value = clienteDe(s);
  } catch (_) {}
  if (typeof setEstado === "function") setEstado("🧾 Completa la factura de " + clienteDe(s) + ": al enviarla llegará a su chat.", "ok");
  if (typeof irA === "function") irA("factura");
}

/* ---------- Publica la factura en el chat del cliente (mensaje tipo "factura") ---------- */
function publicarFactura(f, id) {
  const factura = {
    pedido: f.pedido || "", cliente: f.cliente || "", repartidor: usuario || "",
    productos: (f.productos || []).map((p) => ({ nombre: String((p && p.nombre) || ""), precio: Number(p && p.precio) || 0 })),
    subtotal: Number(f.subtotal) || 0, delivery: Number(f.delivery) || 0,
    prioridad: Number(f.prioridad) || 0,
    total: Number(f.totalFinal != null ? f.totalFinal : f.total) || 0,
    deposito: !!f.deposito, token: f.token || "", link: f.link || "", ts: Date.now()
  };
  const upd = {};
  upd[RUTA + "/" + id + "/factura"] = { pedido: factura.pedido, total: factura.total, ts: TS };
  upd[RUTA + "/" + id + "/ultimo"] = { texto: "🧾 Factura " + factura.pedido + " · " + money(factura.total), de: "repartidor", ts: TS };
  upd[RUTA + "/" + id + "/actualizado"] = TS;
  db.ref().update(upd).catch(() => {});
  db.ref("chats/" + id).push({ de: "repartidor", tipo: "factura", texto: "", factura, ts: TS, nombre: usuario || "" }).catch(() => {});
}

/* ---------- Eventos del panel ---------- */
$("btnSolicitudes").onclick = () => { pintar(); $("modalSolicitudes").classList.remove("oculto"); };
$("btnSolCerrar").onclick = () => $("modalSolicitudes").classList.add("oculto");
$("modalSolicitudes").addEventListener("click", (e) => { if (e.target === $("modalSolicitudes")) $("modalSolicitudes").classList.add("oculto"); });
document.querySelector("#modalSolicitudes .sol-tabs").onclick = (e) => {
  const b = e.target.closest("button[data-f]"); if (!b) return;
  filtro = b.dataset.f;
  document.querySelectorAll("#modalSolicitudes .sol-tabs button").forEach((x) => x.classList.toggle("on", x === b));
  pintar();
};
$("listaSolicitudes").onclick = (e) => {
  const b = e.target.closest("button[data-acc]"); if (!b) return;
  const id = b.dataset.id;
  if (b.dataset.acc === "atender") atender(id);
  else if (b.dataset.acc === "chat") abrirChatSolicitud(id);
  else if (b.dataset.acc === "factura") crearFacturaChat(id);
  else if (b.dataset.acc === "vivo") { const s = solicitudes[id]; if (s && s.token && typeof FacturaVivo !== "undefined") FacturaVivo.abrir(s.token); }
};

/* ============================================================
   GANCHOS (composición, sin editar repartidor.js):
   1) Factura.alEnviar → además publica la tarjeta en el chat si el pedido nació de un chat.
   2) abrirChat(v) → para pedidos de chat abre la sala chats/{solicitudId}.
   3) quitarViaje(token) → al entregar/cancelar, cierra la solicitud en la nube.
   ============================================================ */
window.Factura.alEnviar = ((previo) => (f) => {
  previo(f);   // flujo normal: crea/actualiza el pedido en la nube y pasa al mapa
  const sol = chatPedidos[f.token];
  if (sol && sol.id) publicarFactura(f, sol.id);
})(window.Factura.alEnviar);

if (typeof abrirChat === "function") {
  window.abrirChat = ((previo) => (v) => {
    const sol = v && chatPedidos[v.token];
    if (!sol || !sol.id) return previo(v);
    return abrirChatSolicitud(sol.id);
  })(abrirChat);
}
if (typeof quitarViaje === "function") {
  window.quitarViaje = ((previo) => (token) => {
    const sol = chatPedidos[token];
    previo(token);
    if (sol && sol.id && solicitudes[sol.id] && solicitudes[sol.id].estado !== "cerrada") {
      const upd = {};
      upd[RUTA + "/" + sol.id + "/estado"] = "cerrada";
      upd[RUTA + "/" + sol.id + "/actualizado"] = TS;
      db.ref().update(upd).catch(() => {});
      db.ref("chats/" + sol.id).push({ de: "sistema", tipo: "sistema", texto: "✅ Este pedido finalizó. ¡Gracias por pedir con Brother's Deliverys! 🙌", ts: TS }).catch(() => {});
    }
  })(quitarViaje);
}

pintar();
})();
