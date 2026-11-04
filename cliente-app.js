/* ============================================================
   CLIENTE-APP · "Clon de WhatsApp" para clientes (FASE 1)
   El cliente entra a cliente-app.html:
   1) Si nunca pidió nada (o su chat anterior ya cerró) ve la pantalla de inicio con el
      botón flotante "Nuevo Pedido". Al tocarlo se crea un nodo anónimo en
      solicitudes_entrantes/{id} (el ID es anónimo y se recuerda en LocalStorage).
   2) El chat es directo con el repartidor que atienda la solicitud. Si aún no hay
      repartidor, los mensajes se encolan igualmente en chats/{id} y el repartidor los
      ve al atender (jamás se pierden).
   3) Las facturas llegan como TARJETAS dentro del chat (mensaje tipo:"factura").
   Todo en tiempo real (Firebase Realtime Database, SDK compat v10.12.2 como el resto
   de la app). Sesión: firebase.auth().signInAnonymously() + ID anónimo en LocalStorage.
   ============================================================ */
(function () {
"use strict";

const RUTA = "solicitudes_entrantes";
const $ = (id) => document.getElementById(id);
const TS = firebase.database.ServerValue.TIMESTAMP;
const db = APP.database();
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "C$ " + (Number(n) || 0).toFixed(2);
const hora = (ts) => (ts ? new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "");

/* ---------- Identidad del dispositivo ---------- */
function nombreGuardado() {
  try { return localStorage.getItem("brothers_cliente_nombre") || ""; } catch (_) { return ""; }
}
function guardarNombre(n) {
  try { localStorage.setItem("brothers_cliente_nombre", n); } catch (_) {}
}

/* ---------- Estado ---------- */
let miId = null;
let miNombre = nombreGuardado();
let solicitud = null;          // la solicitud activa (en vivo): { id, estado, asignacion, factura… }
let refSol = null, refChat = null, chatPrimero = false;

/* ---------- Arranque ---------- */
async function arrancar() {
  try { 
    const credencial = await APP.auth().signInAnonymously(); 
    miId = credencial.user.uid;
  }
  catch (e) {
    const off = e.code === "auth/operation-not-allowed" || e.code === "auth/admin-restricted-operation";
    $("arranqueError").textContent = off
      ? "El negocio aún no activó el acceso de clientes. Vuelve a intentarlo más tarde."
      : "No se pudo abrir la app: " + (e.code || e.message);
    $("arranqueError").classList.remove("oculto");
    return;
  }
  escucharSolicitud();
}

/* La app recuerda la última solicitud del aparato y reabre su chat si sigue abierta */
function escucharSolicitud() {
  const ultimo = localStorage.getItem("brothers_cliente_sol");
  if (ultimo) {
    refSol = db.ref(RUTA + "/" + ultimo);
    refSol.on("value", (s) => {
      const d = s.val();
      if (!d || d.estado === "cerrada") { localStorage.removeItem("brothers_cliente_sol"); soltar(); pintarInicio(); return; }
      solicitud = Object.assign({ id: ultimo }, d);
      pintarChat();
    }, () => { pintarInicio(); });
  } else pintarInicio();
}
function soltar() {
  solicitud = null;
  if (refSol) { refSol.off(); refSol = null; }
  soltarChat();
  $("chatView").classList.add("oculto");
}
function soltarChat() {
  if (refChat) { refChat.off(); refChat = null; }
  chatPrimero = false;
  $("msgs").innerHTML = "";
}

/* ---------- Pantalla de inicio + Nuevo Pedido ---------- */
function pintarInicio() {
  $("homeView").classList.remove("oculto");
  $("chatView").classList.add("oculto");
}
function nuevoPedido() {
  const nombre = ($("nombreNuevo").value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (nombre.length < 2) { $("nombreNuevo").focus(); $("nombreNuevo").placeholder = "Escribe tu nombre (mínimo 2 letras)"; return; }
  miNombre = nombre; guardarNombre(nombre);
  $("btnNuevoPedido").disabled = true;
  const reg = {
    estado: "pendiente",                       // pendiente → atendida → cerrada
    dispositivo: miId,                         // ID real vinculado a este aparato (Firebase UID)
    creado: TS, actualizado: TS,
    cliente: { nombre, dispositivo: miId },
    ultimo: { texto: "👋 Hola, quiero hacer un pedido.", de: "cliente", ts: TS }
  };
  db.ref(RUTA).push(reg).then((r) => {
    try { localStorage.setItem("brothers_cliente_sol", r.key); } catch (_) {}
    $("btnNuevoPedido").disabled = false;
    $("nombreNuevo").value = "";
    solicitud = Object.assign({ id: r.key }, reg);
    soltar();                                   // suelta el listener anterior (si lo había)
    refSol = db.ref(RUTA + "/" + r.key);
    refSol.on("value", (s) => {
      const d = s.val();
      if (!d || d.estado === "cerrada") { localStorage.removeItem("brothers_cliente_sol"); soltar(); pintarInicio(); return; }
      solicitud = Object.assign({ id: r.key }, d);
      pintarChat();
    }, () => {});
    pintarChat();
  }).catch((e) => {
    $("btnNuevoPedido").disabled = false;
    alert("No se pudo crear el chat: " + e.message);
  });
}
$("btnNuevoPedido").onclick = nuevoPedido;
$("nombreNuevo").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); nuevoPedido(); } });
$("btnCancelarChat").onclick = () => {
  if (!solicitud) return;
  if (!confirm("¿Cancelar este chat? Se cerrará y no llegará a ningún repartidor.")) return;
  db.ref(RUTA + "/" + solicitud.id).update({ estado: "cerrada", actualizado: TS, cerradoPor: "cliente" }).catch(() => {});
  localStorage.removeItem("brothers_cliente_sol");
  soltar(); pintarInicio();
};

/* ---------- Chat ---------- */
function estadoChip() {
  if (!solicitud) return "";
  if (solicitud.estado === "atendida" && solicitud.asignacion && solicitud.asignacion.nombre)
    return '🛵 Te atiende <b>' + esc(solicitud.asignacion.nombre) + "</b>";
  if (solicitud.factura) return "🧾 Factura lista · revisa la tarjeta en el chat";
  return "⏳ Buscando repartidor… tus mensajes quedan guardados y los verá quien te atienda";
}
function pintarChat() {
  $("homeView").classList.add("oculto");
  $("chatView").classList.remove("oculto");
  $("chatEstado").innerHTML = estadoChip();
  if (!refChat) {
    refChat = db.ref("chats/" + solicitud.id).limitToLast(200);
    refChat.on("child_added", (s) => burbuja(s.key, s.val()), () => {});
    refChat.once("value", () => { chatPrimero = true; });
  }
  if (!$("chatNombre").textContent) $("chatNombre").textContent = solicitud.asignacion && solicitud.asignacion.nombre ? "Repartidor " + solicitud.asignacion.nombre : "Brother’s Deliverys";
}
function estadoTexto(s) {
  if (!s) return "";
  if (s.estado === "atendida") return s.asignacion && s.asignacion.nombre ? "Enviado · " + s.asignacion.nombre + " te lee" : "Enviado ✓";
  if (s.estado === "cerrada") return "Chat cerrado";
  return "Enviado · esperando repartidor…";
}
function burbuja(key, m) {
  if (!m || document.getElementById("m-" + key)) return;
  const d = document.createElement("div");
  d.id = "m-" + key;
  if (m.tipo === "sistema" || m.de === "sistema") {
    d.className = "b-sistema"; d.textContent = m.texto || "";
  } else if (m.tipo === "factura" && m.factura) {
    d.className = "fila" + (m.de === "cliente" ? " yo" : "");
    d.innerHTML = '<div class="b-fx">' + tarjetaFactura(m.factura) + '<small class="b-h">' + hora(m.ts) + "</small></div>";
  } else {
    const mio = m.de === "cliente";
    d.className = "fila" + (mio ? " yo" : "");
    const quien = mio ? "" : '<b class="b-quien">' + esc((m.nombre && m.de === "repartidor" ? "🛵 " + m.nombre : m.de === "repartidor" ? "🛵 Repartidor" : "Cliente")) + "</b>";
    d.innerHTML = '<div class="burbuja' + (mio ? " mia" : "") + '">' + quien + '<span class="b-txt">' + esc(m.texto || (m.foto ? "📷 Foto" : "")) + '</span><small class="b-h">' + hora(m.ts) + "</small></div>";
  }
  $("msgs").appendChild(d);
  $("msgs").scrollTop = $("msgs").scrollHeight;
}
/* Tarjeta de factura dentro del chat (la manda el repartidor desde su app) */
function tarjetaFactura(f) {
  if (!f) return "";
  const prods = (f.productos || []).map((p) => '<div class="fx-fila"><span>' + esc(p.nombre) + "</span><b>" + money(p.precio) + "</b></div>").join("");
  const prio = Number(f.prioridad) > 0 ? '<div class="fx-fila fx-prio"><span>⚡ Prioridad</span><b>' + money(f.prioridad) + "</b></div>" : "";
  return '<div class="fx-cab">🧾 BROTHER’S DELIVERY</div>' +
    (f.cliente ? '<div class="fx-fila"><span>Cliente</span><b>' + esc(f.cliente) + "</b></div>" : "") +
    (f.repartidor ? '<div class="fx-fila"><span>Repartidor</span><b>' + esc(f.repartidor) + "</b></div>" : "") +
    '<div class="fx-div"></div>' + (prods || "") +
    '<div class="fx-fila"><span>Subtotal</span><b>' + money(f.subtotal) + "</b></div>" +
    '<div class="fx-fila"><span>Delivery</span><b>' + money(f.delivery) + "</b></div>" + prio +
    '<div class="fx-fila fx-total"><span>TOTAL</span><b>' + money(f.total) + "</b></div>" +
    '<div class="fx-cod">CÓDIGO DE RETIRO: ' + esc(String(f.pedido || "").replace(/^\D+/, "").replace(/^/, "APP")) + "</div>" +
    (f.link ? '<a class="fx-link" href="' + esc(f.link) + '" target="_blank" rel="noopener">📍 Seguir mi pedido en tiempo real</a>' : "");
}

/* ---------- Enviar mensaje (se encola aunque no haya repartidor aún) ---------- */
$("formEnviar").onsubmit = async (e) => {
  e.preventDefault();
  const texto = $("inputMsg").value.trim().slice(0, 800);
  if (!texto || !solicitud) return;
  $("inputMsg").value = "";
  const msg = { de: "cliente", texto, ts: TS, nombre: miNombre };
  const upd = {};
  upd[RUTA + "/" + solicitud.id + "/ultimo"] = { texto: texto.slice(0, 100), de: "cliente", ts: TS };
  upd[RUTA + "/" + solicitud.id + "/actualizado"] = TS;
  try { await db.ref().update(upd); } catch (_) {}
  try { await db.ref("chats/" + solicitud.id).push(msg); }
  catch (err) { alert("No se pudo enviar: " + err.message); $("inputMsg").value = texto; }
};

/* ---------- Botón atrás: cierra capas, no la app ---------- */
window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("chatView").classList.contains("oculto")) return;   // el chat es la pantalla principal: no se cierra con Escape
});

arrancar();
})();
