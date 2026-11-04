/* ============================================================
   SOLICITUDES-ADMIN · Auditoría y Modo Espectador (FASE 3)
   Panel dentro de la pestaña "Chats" del administrador:
   1) Lista EN VIVO de todas las solicitudes_entrantes (pendientes, atendidas y cerradas)
      con cliente, último mensaje, repartidor asignado, código de pedido y hora.
   2) Modo Espectador: al tocar una solicitud se abre el modal del admin con el chat del
      cliente y el repartidor EN TIEMPO REAL (chats/{id}), la factura generada como tarjeta
      y el estado de la solicitud. El admin solo LEE: no interfiere en el chat.
   Se carga DESPUÉS de ordenes-admin.js y usa los globales de admin.js (db, modal,
   cerrarModal, toast) y el nodo modalAdmin de admin.html.
   Requiere las reglas de lectura para administradores (ver reglas-database.json).
   ============================================================ */
(function () {
"use strict";

const RUTA = "solicitudes_entrantes";
const el = (id) => document.getElementById(id);
const db = APP.database();
const TS = firebase.database.ServerValue.TIMESTAMP;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "C$ " + (Number(n) || 0).toFixed(2);
const bonito = (c) => { const d = String(c == null ? "" : c).replace(/\D/g, ""); return d ? "APP" + d.padStart(5, "0") : String(c == null ? "" : c); };
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

let solicitudes = {}, ref = null, refChatEsp = null, idEsp = null, espPrimero = false;

/* ---------- Listener de las solicitudes ---------- */
function iniciar() {
  if (ref) return;
  ref = db.ref(RUTA);
  ref.on("value", (s) => { solicitudes = s.val() || {}; pintar(); }, () => { ref = null; });
}
APP.auth().onAuthStateChanged((u) => {
  if (u) iniciar();
  else { if (ref) { ref.off(); ref = null; } solicitudes = {}; pintar(); }
});

/* ---------- 1) Panel de auditoría (lista) ---------- */
function pintar() {
  const cont = el("listaSolicitudesAdmin"); if (!cont) return;
  const lista = Object.entries(solicitudes).map(([id, s]) => Object.assign({ id }, s))
    .sort((a, b) => (b.actualizado || b.creado || 0) - (a.actualizado || a.creado || 0));
  if (!lista.length) { cont.innerHTML = '<p class="ayuda">Aún no hay solicitudes. Los clientes las crean desde cliente-app.html con el botón "Nuevo Pedido".</p>'; return; }
  const nPend = lista.filter((s) => !s.estado || s.estado === "pendiente").length;
  cont.innerHTML = '<p class="ayuda">' + lista.length + " solicitud" + (lista.length > 1 ? "es" : "") + " · " + nPend + " pendiente" + (nPend === 1 ? "" : "s") + ". Toca una para el modo espectador.</p>" +
    lista.map((s) => {
      const est = s.estado === "atendida" ? ["vivo", "Atendida"] : s.estado === "cerrada" ? ["", "Cerrada"] : ["alerta", "Pendiente"];
      const rep = s.asignacion && s.asignacion.nombre ? "🛵 " + esc(s.asignacion.nombre) : "— sin repartidor —";
      return '<button type="button" class="sol-adm" data-id="' + esc(s.id) + '">' +
        '<span class="chip ' + est[0] + '">' + est[1] + "</span>" +
        '<span class="sol-adm-n"><b>' + esc(clienteDe(s)) + "</b>" +
        "<small>" + (s.ultimo && s.ultimo.texto ? esc(s.ultimo.texto) : "Solicitud de pedido") + " · " + esc(hace(s.actualizado || s.creado)) + "</small>" +
        "<small>" + rep + (s.pedido ? " · Pedido " + esc(bonito(s.pedido)) : "") + (s.factura ? " · Factura " + esc(money(s.factura.total)) : "") + "</small></span>" +
        "</button>";
    }).join("");
}
el("listaSolicitudesAdmin").onclick = (e) => {
  const b = e.target.closest("[data-id]"); if (b) espectador(b.dataset.id);
};

/* ---------- 2) Modo espectador (chat en vivo + factura) ---------- */
function burbujaEsp(key, m) {
  const caja = el("espMsgs"); if (!caja || !m) return;
  if (document.getElementById("e-" + key)) return;
  const d = document.createElement("div");
  d.id = "e-" + key;
  if (m.tipo === "sistema" || m.de === "sistema") {
    d.className = "msg-sistema"; d.textContent = m.texto || "";
  } else if (m.tipo === "factura") {
    d.className = "pd-msg esp-fx";
    d.innerHTML = '<div class="esp-factura">' + facturaHtml(m.factura) + "</div>";
  } else {
    d.className = "pd-msg";
    d.textContent = (m.de === "cliente" ? "🧑 " + (m.nombre || "Cliente") + ": " : "🛵 " + (m.nombre || "Repartidor") + ": ") + (m.texto || (m.foto ? "📷 Foto" : ""));
  }
  caja.appendChild(d);
  caja.scrollTop = caja.scrollHeight;
}
function facturaHtml(f) {
  if (!f) return "";
  const prods = (f.productos || []).map((p) => '<div class="esp-fila"><span>' + esc(p.nombre) + "</span><b>" + money(p.precio) + "</b></div>").join("");
  const prio = Number(f.prioridad) > 0 ? '<div class="esp-fila"><span>⚡ Prioridad</span><b>' + money(f.prioridad) + "</b></div>" : "";
  return '<div class="esp-fx-cab">🧾 FACTURA · ' + esc(bonito(f.pedido)) + "</div>" +
    (f.cliente ? '<div class="esp-fila"><span>Cliente</span><b>' + esc(f.cliente) + "</b></div>" : "") +
    (f.repartidor ? '<div class="esp-fila"><span>Repartidor</span><b>' + esc(f.repartidor) + "</b></div>" : "") +
    '<div class="esp-fx-div"></div>' + prods +
    '<div class="esp-fila"><span>Subtotal</span><b>' + money(f.subtotal) + "</b></div>" +
    '<div class="esp-fila"><span>Delivery</span><b>' + money(f.delivery) + "</b></div>" + prio +
    '<div class="esp-fila esp-total"><span>TOTAL</span><b>' + money(f.total) + "</b></div>" +
    (f.link ? '<a class="esp-enlace" href="' + esc(f.link) + '" target="_blank" rel="noopener">📍 Ver seguimiento</a>' : "");
}
function espectador(id) {
  const s = solicitudes[id]; if (!s) return;
  idEsp = id; espPrimero = false;
  const est = s.estado === "atendida" ? "Atendida" : s.estado === "cerrada" ? "Cerrada" : "Pendiente";
  const html = '<h2>📥 ' + esc(clienteDe(s)) + ' <span class="pd-etiqueta">' + est + "</span></h2>" +
    "<small>Repartidor: <b>" + esc((s.asignacion && s.asignacion.nombre) || "—") + "</b>" +
    (s.pedido ? " · Pedido " + esc(bonito(s.pedido)) : "") +
    (s.factura ? " · Factura: " + esc(money(s.factura.total)) : "") +
    " · modo espectador (solo lectura)</small>" +
    '<div class="pd-msgs" id="espMsgs" style="max-height:46vh;overflow-y:auto;margin:10px 0"></div>' +
    '<button id="btnEspCerrar" class="oscuro" type="button">Cerrar</button>';
  if (typeof modal === "function") modal(html);
  else { const c = el("modalCaja"); if (!c) return; c.innerHTML = html; el("modalAdmin").classList.remove("oculto"); }
  const bx = el("btnEspCerrar"); if (bx) bx.onclick = cerrarEspectador;
  refChatEsp = db.ref("chats/" + id).limitToLast(200);
  refChatEsp.on("child_added", (x) => burbujaEsp(x.key, x.val()), () => {});
  refChatEsp.once("value", () => { espPrimero = true; });
}
function cerrarEspectador() {
  if (typeof cerrarModal === "function") cerrarModal();
  else { const m = el("modalAdmin"); if (m) m.classList.add("oculto"); }
  detenerEspectador();
}
function detenerEspectador() {
  if (refChatEsp) { refChatEsp.off(); refChatEsp = null; }
  idEsp = null;
}
/* Si el modal se cierra por otra vía (botón ✕ del admin), se sueltan los listeners */
new MutationObserver(() => {
  const m = el("modalAdmin");
  if (m && m.classList.contains("oculto") && refChatEsp) detenerEspectador();
}).observe(el("modalAdmin"), { attributes: true, attributeFilter: ["class"] });

pintar();
})();
