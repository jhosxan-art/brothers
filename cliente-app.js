/* ============================================================
   CLIENTE-APP · "Clon de WhatsApp" para clientes (FASE 1)
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

function nombreGuardado() {
  try { return localStorage.getItem("brothers_cliente_nombre") || ""; } catch (_) { return ""; }
}
function guardarNombre(n) {
  try { localStorage.setItem("brothers_cliente_nombre", n); } catch (_) {}
}

let miId = null;
let miNombre = nombreGuardado();
let solicitud = null;
let refSol = null, refChat = null, chatPrimero = false;

/* ---------- Arranque Bulletproof ---------- */
// 1. Bloquear el botón desde el inicio para que no presionen antes de tiempo
if($("btnNuevoPedido")) $("btnNuevoPedido").disabled = true;

function arrancar() {
  // 2. Usar onAuthStateChanged es más seguro para recuperar la sesión anónima
  APP.auth().onAuthStateChanged((user) => {
    if (user) {
      miId = user.uid;
      console.log("✅ Sesión Firebase lista. UID:", miId);
      if($("btnNuevoPedido")) $("btnNuevoPedido").disabled = false; // Habilitar botón
      escucharSolicitud();
    } else {
      console.log("⏳ Iniciando sesión anónima...");
      APP.auth().signInAnonymously().catch((e) => {
        console.error("❌ Error Auth:", e);
        const off = e.code === "auth/operation-not-allowed" || e.code === "auth/admin-restricted-operation";
        $("arranqueError").textContent = off
          ? "El negocio aún no activó el acceso de clientes. Activa 'Anónimo' en Firebase."
          : "Fallo de conexión o dominio no autorizado: " + e.message;
        $("arranqueError").classList.remove("oculto");
      });
    }
  });
}

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

function pintarInicio() {
  $("homeView").classList.remove("oculto");
  $("chatView").classList.add("oculto");
}

function nuevoPedido() {
  if (!miId) {
    alert("⏳ Conectando con el servidor... Espera un segundo e intenta de nuevo.");
    return;
  }

  const nombre = ($("nombreNuevo").value || "").trim().replace(/\s+/g, " ").slice(0, 40);
  if (nombre.length < 2) { $("nombreNuevo").focus(); $("nombreNuevo").placeholder = "Escribe tu nombre (mínimo 2 letras)"; return; }
  miNombre = nombre; guardarNombre(nombre);
  
  $("btnNuevoPedido").disabled = true;
  $("btnNuevoPedido").textContent = "Creando...";
  
  const reg = {
    estado: "pendiente",
    dispositivo: miId, // ID real de Firebase
    creado: TS, actualizado: TS,
    cliente: { nombre, dispositivo: miId },
    ultimo: { texto: "👋 Hola, quiero hacer un pedido.", de: "cliente", ts: TS }
  };
  
  db.ref(RUTA).push(reg).then((r) => {
    try { localStorage.setItem("brothers_cliente_sol", r.key); } catch (_) {}
    $("btnNuevoPedido").disabled = false;
    $("btnNuevoPedido").textContent = "💬 Nuevo Pedido";
    $("nombreNuevo").value = "";
    solicitud = Object.assign({ id: r.key }, reg);
    soltar();
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
    $("btnNuevoPedido").textContent = "💬 Nuevo Pedido";
    alert("No se pudo crear el chat: " + e.message);
    console.error("Error BD:", e);
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

window.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("chatView").classList.contains("oculto")) return;
});

arrancar();
})();
