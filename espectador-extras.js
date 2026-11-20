/* ============================================================
   ESPECTADOR-EXTRAS · Minimizar pedido + mensajes rápidos al cliente
   Se carga DESPUÉS de ordenes-admin.js (ver admin.html). Usa los eventos
   "visor-abierto" / "visor-cerrado" que ordenes-admin.js lanza al abrir/cerrar el visor.
   1) Botón "🧾 Pedido" en la cabecera del visor: oculta/muestra el ticket
      (#saPedido) para dejar más espacio al chat y al mapa. Se recuerda.
   2) Barra de mensajes rápidos en el footer: un toque = un mensaje de
      "admin" en solicitudes_entrantes/{id}/mensajes, también cuando aún
      no hay repartidor (estado "nuevo"). Se desactiva si el pedido ya
      está entregado o cancelado.
   ============================================================ */
(function () {
"use strict";

/* Edita esta lista para cambiar los mensajes (máx. 600 caracteres c/u) */
const RAPIDOS = [
  "🔎 Estamos buscando un repartidor para tu pedido",
  "🍳 El restaurante está preparando tu pedido",
  "⏳ Seguimos buscando repartidor, gracias por tu paciencia",
  "🛵 Ya hay repartidor asignado, va en camino",
  "📍 Tu repartidor va en camino a tu ubicación",
  "🙏 Disculpa la demora, estamos trabajando en tu pedido",
  "✅ Recibimos tu pedido, lo estamos procesando",
  "📞 ¿Puedes confirmarnos tu ubicación?"
];
const KEY_MIN = "saPedidoMin";
const ID_OK = /^sol_[A-Za-z0-9_-]{8,64}$/;
const $ = (id) => document.getElementById(id);

let idActual = null, estado = null, refEstado = null, ocupado = false, ultimo = { t: "", ts: 0 }, msgTimer = null;

/* ---------- 1) Minimizar / mostrar el pedido ---------- */
function leerMin() { try { return localStorage.getItem(KEY_MIN) === "1"; } catch (_) { return false; } }
function guardarMin(v) { try { localStorage.setItem(KEY_MIN, v ? "1" : "0"); } catch (_) {} }

function pintarPedido() {
  const p = $("saPedido"), b = $("saPedidoToggle"); if (!p || !b) return;
  const hay = !p.classList.contains("oculto");
  const min = hay && leerMin();
  if (p.classList.contains("sa-min") !== min) p.classList.toggle("sa-min", min);
  if (b.classList.contains("oculto") === hay) b.classList.toggle("oculto", !hay);
  const exp = hay && !min ? "true" : "false";
  if (b.getAttribute("aria-expanded") !== exp) {
    b.setAttribute("aria-expanded", exp);
    b.title = min ? "Mostrar el pedido" : "Minimizar el pedido";
    b.innerHTML = "🧾 Pedido <span aria-hidden=\"true\">" + (min ? "▾" : "▴") + "</span>";
  }
}
function initPedido() {
  const p = $("saPedido"), b = $("saPedidoToggle"); if (!p || !b) return;
  b.addEventListener("click", () => { guardarMin(!leerMin()); pintarPedido(); });
  new MutationObserver(pintarPedido).observe(p, { attributes: true, attributeFilter: ["class"], childList: true });
  pintarPedido();
}

/* ---------- 2) Mensajes rápidos ---------- */
function aviso(txt, error) {
  const m = $("saRapidosMsg"); if (!m) return;
  clearTimeout(msgTimer);
  m.textContent = txt || ""; m.classList.toggle("error", !!error);
  if (txt) msgTimer = setTimeout(() => { m.textContent = ""; }, 2500);
}
function puedeEnviar() { return !!idActual && !ocupado && (estado === "nuevo" || estado === "atendido"); }
function pintarChips() {
  const caja = $("saRapidos"); if (!caja) return;
  const ok = puedeEnviar();
  caja.querySelectorAll("button").forEach((b) => { b.disabled = !ok; });
  caja.title = !idActual ? "No se pudo identificar la solicitud" : (estado === "entregado" || estado === "cancelado") ? "El pedido ya terminó" : "";
}
function crearChips() {
  const caja = $("saRapidos"); if (!caja) return;
  RAPIDOS.forEach((t) => {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = t; b.dataset.rapido = t; b.disabled = true;
    caja.appendChild(b);
  });
  caja.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-rapido]"); if (b) enviar(b.dataset.rapido);
  });
}
async function enviar(texto) {
  if (!puedeEnviar()) return;
  const ahora = Date.now();
  if (texto === ultimo.t && ahora - ultimo.ts < 5000) { aviso("Ese mensaje ya se envió hace un momento"); return; }
  const id = idActual;
  ocupado = true; pintarChips();
  try {
    const TS = firebase.database.ServerValue.TIMESTAMP;
    const base = APP.database().ref("solicitudes_entrantes/" + id);
    const k = base.child("mensajes").push().key;
    await base.update({
      ["mensajes/" + k]: { de: "admin", tipo: "texto", texto: texto, ts: TS },
      ultimoMensaje: texto.slice(0, 200), ultimoDe: "admin", ts: TS
    });
    ultimo = { t: texto, ts: ahora };
    aviso("✓ Enviado al cliente");
  } catch (err) {
    console.warn("Mensaje rápido:", err && err.message ? err.message : err);
    aviso("No se pudo enviar. Revisa la conexión e inténtalo de nuevo.", true);
  } finally {
    setTimeout(() => { ocupado = false; pintarChips(); }, 1000);
  }
}

/* ---------- Solicitud abierta en el visor (eventos de ordenes-admin.js) ---------- */
function soltarEstado() { if (refEstado) { refEstado.off(); refEstado = null; } }
window.addEventListener("visor-abierto", (e) => {
  const id = e.detail && e.detail.id;
  soltarEstado(); estado = null; ocupado = false; aviso("");
  idActual = id && ID_OK.test(String(id)) ? String(id) : null;
  if (idActual && typeof APP !== "undefined") {
    refEstado = APP.database().ref("solicitudes_entrantes/" + idActual + "/estado");
    refEstado.on("value", (s) => { estado = s.val(); pintarChips(); }, () => { estado = null; pintarChips(); });
  }
  pintarChips(); pintarPedido();
});
window.addEventListener("visor-cerrado", () => {
  soltarEstado(); estado = null; idActual = null; ocupado = false; aviso(""); pintarChips();
});

crearChips();
initPedido();
})();
