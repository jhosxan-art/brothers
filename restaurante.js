/* ============================================================
   RESTAURANTE · panel del restaurante de Brother’s Deliverys (window.NOMBRE_APP = "restaurante")

   Nodos de Realtime Database (brothers-deliverys):
     restaurantes/{uid}   ficha PÚBLICA: { nombre, desc, ciudad, dir, lat, lng, prepMin, foto, abierto, activo, creado, actualizado }
     restaurantesPriv/{uid}  datos privados (solo dueño + admin + Worker): { email, tel, fcmToken }
                          (la cuenta la crea el administrador con la app secundaria «authSec»; aquí solo se edita la ficha)
     lugares/rest_{uid}   pin del negocio que ven admin y repartidores: { nombre, icono, dir, lat, lng, ciudad, tipo:"restaurante", restauranteUid }
     menus/{uid}/{id}     platos: { nombre, desc, precio, cat, activo, foto, orden, creado }
     solicitudes_entrantes/{id}   pedidos de «Pedir Comida» con restauranteUid == uid (consulta orderByChild("restauranteUid"))
        pedido.items = [{ n, q, p }] · pedido.subtotal · s.nombre = cliente
        rest: { estado: pendiente|aceptado|preparando|listo|rechazado, prepMin, ts, aceptadoTs, listoTs, motivo }  ← lo escribe SOLO este panel
        mensajes/{k}: { de:"restaurante", tipo:"texto", texto, ts }  ← chat del pedido
   ============================================================ */
(function () {
"use strict";

const $ = (id) => document.getElementById(id);
const auth = APP.auth();
const db = APP.database();
const TS = firebase.database.ServerValue.TIMESTAMP;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "C$ " + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const bonito = (id) => "#" + String(id || "").slice(-5).toUpperCase();   // mismo número que ve la central
const hora = (ts) => ts ? new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" }) : "";
const hace = (ts) => {
  if (!ts) return "";
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return "ahora";
  if (m < 60) return "hace " + m + " min";
  const h = Math.floor(m / 60);
  return h < 24 ? "hace " + h + " h" : new Date(ts).toLocaleDateString("es");
};
const claveDeToken = (t) => { let h = 0; for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return "w" + (h >>> 0).toString(36); };

let uidBase = null, sedes = [], eligiendo = false;
let uid = null, perfil = {}, menu = {}, pedidos = {}, ciudadesOk = [];
let refPerfil = null, refMenu = null, refPedidos = null;
const refsPed = {}, diag = {};
let filtro = "nuevo", catSel = "Todos", fotoPerfil = "", primeraCarga = true;
const vistos = new Set();
let sonidoOk = false, audioCtx = null;

/* ---------- Utilidades de interfaz ---------- */
let tToast = null;
function toast(t) {
  const e = $("toastRt"); if (!e) return;
  e.textContent = t; e.classList.remove("oculto");
  clearTimeout(tToast); tToast = setTimeout(() => e.classList.add("oculto"), 3500);
}
function setMsg(id, t, tipo) {
  const e = $(id); if (!e) return;
  e.textContent = t || ""; e.className = "estado" + (tipo ? " " + tipo : "") + (t ? "" : " oculto");
}
function modal(html) { $("modalRtCaja").innerHTML = html; $("modalRt").classList.remove("oculto"); }
function cerrarModal() { $("modalRt").classList.add("oculto"); $("modalRtCaja").innerHTML = ""; }
$("modalRt").addEventListener("click", (e) => { if (e.target === $("modalRt") && !eligiendo) cerrarModal(); });

function vista(v) {   // login | denegado | app
  $("loginMain").classList.toggle("oculto", v !== "login");
  $("vistaDenegado").classList.toggle("oculto", v !== "denegado");
  $("vistaApp").classList.toggle("oculto", v !== "app");
  $("btnSalir").classList.toggle("oculto", v === "login");
  $("btnAbierto").classList.toggle("oculto", v !== "app");
  const s = $("splash"); if (s) s.classList.add("oculto");
}
const errorAuth = (e) => ({
  "auth/invalid-email": "El correo no es válido.", "auth/user-not-found": "No existe una cuenta con ese correo.",
  "auth/wrong-password": "Contraseña incorrecta.", "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/too-many-requests": "Demasiados intentos. Espera unos minutos.", "auth/network-request-failed": "Sin conexión a internet."
}[e && e.code] || (e && e.message) || "No se pudo iniciar sesión.");

/* ---------- Sonido de pedido nuevo (WebAudio; el navegador exige un toque antes) ---------- */
function activarSonido() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
    sonidoOk = true; $("rtAviso").classList.add("oculto");
  } catch (_) {}
}
/* ---------- Alarma insistente: voz + sirena + vibración cada 9 s mientras haya solicitudes sin responder ---------- */
let alarmaT = null;
function decirSolicitud() {
  try {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance("¡Tienes una solicitud de pedido!");
    u.lang = "es-MX"; u.rate = .95; u.pitch = 1; u.volume = 1;
    const vs = (speechSynthesis.getVoices() || []).filter((v) => /^es/i.test(v.lang));
    if (vs.length) u.voice = vs.find((v) => /MX|419|US/i.test(v.lang)) || vs[0];
    speechSynthesis.speak(u);
  } catch (_) {}
}
function rondaAlarma() {
  pitar(); decirSolicitud();
  try { if (navigator.vibrate) navigator.vibrate([500, 150, 500, 150, 500]); } catch (_) {}
}
function gestionarAlarma(n) {
  let ban = document.getElementById("rtAlarma");
  if (n > 0) {
    if (!ban) {
      ban = document.createElement("button"); ban.id = "rtAlarma"; ban.type = "button";
      ban.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:99999;border:0;padding:16px 12px;background:#D90429;color:#fff;font:800 18px/1.2 system-ui,sans-serif;text-align:center;animation:rtParpadeo .8s infinite;box-shadow:0 4px 16px rgba(0,0,0,.4)";
      if (!document.getElementById("rtAlarmaCss")) { const st = document.createElement("style"); st.id = "rtAlarmaCss"; st.textContent = "@keyframes rtParpadeo{50%{background:#7A0016}}"; document.head.appendChild(st); }
      ban.onclick = () => { filtro = "nuevo"; document.querySelectorAll("#rtFiltros button").forEach((x) => x.classList.toggle("on", x.dataset.f === "nuevo")); pintarPedidos(); };
      document.body.appendChild(ban);
    }
    ban.textContent = "🔔 TIENES " + (n === 1 ? "UNA SOLICITUD" : n + " SOLICITUDES") + " DE PEDIDO · TOCA PARA VERLA";
    if (!alarmaT) { rondaAlarma(); alarmaT = setInterval(rondaAlarma, 9000); }
  } else {
    if (alarmaT) { clearInterval(alarmaT); alarmaT = null; try { speechSynthesis.cancel(); } catch (_) {} }
    if (ban) ban.remove();
  }
}
function pitar() {
  try { if (navigator.vibrate) navigator.vibrate([220, 100, 220]); } catch (_) {}
  if (!sonidoOk || !audioCtx) return;
  [0, .25, .5].forEach((d, i) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = "sine"; o.frequency.value = i === 1 ? 988 : 784;
    g.gain.setValueAtTime(.0001, audioCtx.currentTime + d);
    g.gain.exponentialRampToValueAtTime(.35, audioCtx.currentTime + d + .02);
    g.gain.exponentialRampToValueAtTime(.0001, audioCtx.currentTime + d + .2);
    o.connect(g); g.connect(audioCtx.destination); o.start(audioCtx.currentTime + d); o.stop(audioCtx.currentTime + d + .22);
  });
}
$("btnActivarSonido").onclick = activarSonido;
document.addEventListener("pointerdown", () => { if (!sonidoOk) activarSonido(); }, { once: true, passive: true });

/* ---------- Sesión ---------- */
/* Recordar correo y contraseña (solo en este dispositivo) */
const CRED = "rt_cred";
(function () {
  try {
    const g = JSON.parse(localStorage.getItem(CRED) || "null");
    if (g && g.e) { $("email").value = g.e; try { $("clave").value = atob(g.c || ""); } catch (_) {} $("recordar").checked = true; }
  } catch (_) {}
})();
$("btnVerClave").onclick = () => { const p = $("clave"), ver = p.type === "password"; p.type = ver ? "text" : "password"; $("btnVerClave").textContent = ver ? "🙈" : "👁"; };
$("formLogin").addEventListener("submit", (e) => e.preventDefault());
$("btnLogin").onclick = async (ev) => {
  if (ev) ev.preventDefault();
  const email = $("email").value.trim(), clave = $("clave").value;
  if (!email || !clave) return setMsg("msgLogin", "Escribe tu correo y contraseña.", "error");
  setMsg("msgLogin", "Entrando…"); $("btnLogin").disabled = true;
  try {
    try { sessionStorage.setItem("rt_ask", "1"); } catch (_) {}
    await auth.signInWithEmailAndPassword(email, clave); setMsg("msgLogin", "");
    try { if ($("recordar").checked) localStorage.setItem(CRED, JSON.stringify({ e: email, c: btoa(clave) })); else localStorage.removeItem(CRED); } catch (_) {}
  }
  catch (e) { setMsg("msgLogin", errorAuth(e), "error"); }
  finally { $("btnLogin").disabled = false; }
};
$("btnSalir").onclick = async () => { if (!confirm("¿Cerrar sesión?")) return; await quitarPush(); auth.signOut(); };
$("btnDenegadoSalir").onclick = () => auth.signOut();

const nomCiudad = (id) => { try { return Ciudades.nombre(id); } catch (_) { return id || "Ciudad"; } };
/* Cada ciudad es una sucursal (restaurantes/{uid} = ciudad principal, restaurantes/{uid}~{ciudad} = las demás).
   El administrador activa las ciudades; al entrar, el negocio indica en cuál opera hoy. */
function entrarSede(s) {
  eligiendo = false; cerrarModal();
  detener();
  uid = s.id; perfil = s;
  try { localStorage.setItem("rt_sede_" + uidBase, s.id); sessionStorage.removeItem("rt_ask"); } catch (_) {}
  iniciar(); vista("app"); pintarPerfilBarra();
  const pie = $("btnActiva") && $("btnActiva").parentNode, ya = $("btnCambiarSede");
  if (sedes.length > 1 && pie && !ya) {
    const b = document.createElement("button"); b.id = "btnCambiarSede"; b.type = "button"; b.className = "mini"; b.style.marginRight = "8px";
    b.textContent = "🏙️ Cambiar de ciudad"; b.onclick = elegirCiudad; pie.insertBefore(b, $("btnActiva"));
  }
}
function elegirCiudad() {
  eligiendo = true; vista("login"); $("loginMain").classList.add("oculto");
  const activas = sedes.filter((s) => s.suspendida !== true), lista = activas.map((s) => nomCiudad(s.ciudad)).join(", ");
  modal(`<h2>📍 ¿En qué ciudad vas a operar?</h2>
    <p class="ayuda">Tu administrador te dio acceso en: <b>${esc(lista)}</b>. Los pedidos de esa ciudad llegarán a esta sucursal.</p>
    <div class="rt-catlista">${sedes.map((s) => s.suspendida === true
      ? `<button class="mini" type="button" disabled>🔒 ${esc(nomCiudad(s.ciudad))} · no habilitada</button>`
      : `<button class="primario" type="button" data-sede="${esc(s.id)}">🏙️ ${esc(nomCiudad(s.ciudad))}</button>`).join("")}</div>
    <div id="elMsg" class="estado oculto" role="alert"></div>
    <button id="elGps" class="oscuro" type="button">📍 Usar mi ubicación en tiempo real</button>
    <button id="elSalir" class="mini" type="button">Cerrar sesión</button>`);
  $("modalRtCaja").querySelectorAll("[data-sede]").forEach((b) => { b.onclick = () => entrarSede(sedes.find((s) => s.id === b.dataset.sede)); });
  $("elSalir").onclick = () => { eligiendo = false; cerrarModal(); auth.signOut(); };
  $("elGps").onclick = () => {
    if (!navigator.geolocation) return setMsg("elMsg", "Tu dispositivo no permite ubicación. Elige tu ciudad de la lista.", "error");
    setMsg("elMsg", "Buscando tu ubicación…"); $("elGps").disabled = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      $("elGps").disabled = false;
      let c = null; try { c = Ciudades.deCoord(pos.coords.latitude, pos.coords.longitude); } catch (_) {}
      const s = c && activas.find((x) => x.ciudad === c.id);
      if (s) return entrarSede(s);
      setMsg("elMsg", (c ? "Estás en " + c.nombre + ", donde tu negocio no tiene sucursal activa." : "No estás en una ciudad con cobertura.") + " Tienes acceso en: " + lista + ".", "error");
    }, () => { $("elGps").disabled = false; setMsg("elMsg", "No pude obtener tu ubicación. Elige tu ciudad de la lista.", "error"); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  };
}
auth.onAuthStateChanged(async (u) => {
  if (!u) { eligiendo = false; detener(); uid = null; uidBase = null; sedes = []; vista("login"); return; }
  try {
    uidBase = u.uid;
    const f = await db.ref("restaurantes/" + u.uid).once("value");
    if (!f.exists() || (f.val() && f.val().activo === false)) { detener(); uid = null; vista("denegado"); return; }
    let ramas = {};
    try { ramas = (await db.ref("restaurantes").orderByKey().startAt(u.uid + "~").endAt(u.uid + "~").once("value")).val() || {}; } catch (_) {}
    sedes = [{ id: u.uid, ...f.val() }].concat(Object.entries(ramas).filter(([, r]) => r && r.activo !== false).map(([id, r]) => ({ id, ...r })));
    const activas = sedes.filter((s) => s.suspendida !== true);
    if (!activas.length) { detener(); uid = null; vista("denegado"); return; }
    if (activas.length === 1) return entrarSede(activas[0]);
    let ask = false, g = null;
    try { ask = sessionStorage.getItem("rt_ask") === "1"; g = activas.find((s) => s.id === localStorage.getItem("rt_sede_" + u.uid)); } catch (_) {}
    if (g && !ask) return entrarSede(g);
    elegirCiudad();
  } catch (e) { detener(); uid = null; vista("denegado"); }
});

/* Menú compartido entre sucursales: si el administrador vinculó este negocio a otro (menuDe), se usa ese menú. */
let mActual = null;
const mid = () => (perfil && perfil.menuDe) || uid;
function escucharMenu() {
  if (refMenu) { try { refMenu.off(); } catch (_) {} }
  mActual = mid();
  refMenu = db.ref("menus/" + mActual);
  refMenu.on("value", (s) => { diag.menu = "ok"; pintarDiag(); menu = s.val() || {}; pintarMenu(); }, (e) => { diag.menu = e.code || e.message; pintarDiag(); });
  if (refCats) { try { refCats.off(); } catch (_) {} }
  catsGuardadas = null;
  refCats = db.ref("menusCats/" + mActual);
  refCats.on("value", (s) => { const v = s.val(); catsGuardadas = Array.isArray(v) ? v.filter((x) => typeof x === "string") : null; pintarMenu(); }, () => {});
}
function iniciar() {
  detener();
  primeraCarga = true; vistos.clear();
  refPerfil = db.ref("restaurantes/" + uid);
  refPerfil.on("value", (s) => { diag.perfil = "ok"; pintarDiag(); perfil = s.val() || {}; pintarPerfilBarra(); if (!perfilPintado) pintarPerfil(); if (mActual !== mid()) escucharMenu(); }, (e) => { diag.perfil = e.code || e.message; pintarDiag(); });
  escucharMenu();
  /* Pedidos: índice restaurantePedidos/{uid}/{id} (lo escribe el cliente al pedir) + un oyente por pedido */
  refPedidos = db.ref("restaurantePedidos/" + uid).limitToLast(100);
  refPedidos.on("child_added", (x) => { diag.indice = "ok"; pintarDiag(); escucharPedido(x.key); }, (e) => { diag.indice = e.code || e.message; pintarDiag(); });
  refPedidos.once("value", () => { diag.indice = "ok"; pintarDiag(); }, () => {});
  try { Ciudades.suscribir(db, () => { llenarCiudades(); }); } catch (_) {}
  llenarCiudades();
  registrarPush();
}
/* Privacidad: el restaurante NO lee la solicitud completa (nombre, celular, GPS, direcciones…). Solo 4 datos sueltos:
   vistaRestaurante {items, subtotal, nota, ts} · estado · rest · repartidorNombre. */
function escucharPedido(id) {
  if (refsPed[id]) return;
  const base = "solicitudes_entrantes/" + id, parte = {}, lista = [];
  const armar = () => {
    if (!parte.vista) return;
    pedidos[id] = { estado: parte.estado || "nuevo", rest: parte.rest || null, repartidorNombre: parte.rep || "", creado: parte.vista.ts || 0, pedido: { items: parte.vista.items, subtotal: parte.vista.subtotal, nota: parte.vista.nota } };
    diag.pedidos = "ok"; pintarPedidos(); pintarDiag();
  };
  [["vista", "vistaRestaurante"], ["estado", "estado"], ["rest", "rest"], ["rep", "repartidorNombre"]].forEach(([k, ruta]) => {
    const r = db.ref(base + "/" + ruta); lista.push(r);
    r.on("value", (s) => { parte[k] = s.val(); armar(); }, (e) => {
      (refsPed[id] || []).forEach((x) => { try { x.off(); } catch (_) {} }); refsPed[id] = [];
      delete pedidos[id]; if (ruta !== "vistaRestaurante") diag["pedido " + bonito(id) + " " + ruta] = e.code || e.message; pintarDiag(); pintarPedidos();
    });
  });
  refsPed[id] = lista;
}
function pintarDiag() {
  const mal = Object.entries(diag).filter(([, v]) => v !== "ok");
  setMsg("rtMsg", mal.length ? "Sin permiso en: " + mal.map(([k, v]) => k + " (" + v + ")").join(", ") + " · cuenta " + String(uid || "").slice(0, 8) : "", "error");
}
function detener() {
  Object.keys(refsPed).forEach((k) => { (refsPed[k] || []).forEach((r) => { try { r.off(); } catch (_) {} }); delete refsPed[k]; });
  Object.keys(diag).forEach((k) => { delete diag[k]; });
  [refPerfil, refMenu, refPedidos, refCats].forEach((r) => { try { r && r.off(); } catch (_) {} });
  refPerfil = refMenu = refPedidos = refCats = null; cerrarChat();
  perfil = {}; menu = {}; pedidos = {}; perfilPintado = false;   // OJO: uid NO se borra aquí (iniciar() lo necesita)
}

/* ---------- Pestañas ---------- */
document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("activa", x === b));
    ["panelPedidos", "panelMenu", "panelPerfil"].forEach((p) => $(p).classList.toggle("oculto", p !== b.dataset.tab));
    if (b.dataset.tab === "panelPerfil") { iniciarMapa(); }
  };
});

/* ---------- Abierto / Cerrado ---------- */
function pintarPerfilBarra() {
  $("rtNombreBarra").textContent = (perfil.nombre || "Brother’s Deliverys") + (sedes.length > 1 && perfil.ciudad ? " · " + nomCiudad(perfil.ciudad) : "");
  const on = perfil.abierto === true, b = $("btnAbierto");
  const fuera = on && !dentroHorarioRt(perfil.horario);
  b.setAttribute("aria-checked", on ? "true" : "false"); b.querySelector("span").textContent = fuera ? "Fuera de horario" : on ? "Abierto" : "Cerrado";
}
$("btnAbierto").onclick = async () => {
  const on = !(perfil.abierto === true);
  if (on && (!Number.isFinite(perfil.lat) || !Number.isFinite(perfil.lng) || !perfil.nombre)) { toast("Primero completa tu nombre y ubicación en «Mi negocio»."); return; }
  try { await db.ref("restaurantes/" + uid).update({ abierto: on, actualizado: TS }); toast(on ? "Restaurante abierto ✓" : "Restaurante cerrado"); }
  catch (e) { toast("No se pudo cambiar: " + (e.code || e.message)); }
};

/* ============================================================
   1) PEDIDOS
   ============================================================ */
const FIN = (s) => s.estado === "entregado" || s.estado === "cancelado";
function grupoDe(s) {
  const r = (s.rest && s.rest.estado) || "pendiente";
  if (FIN(s) || r === "rechazado") return "finalizado";
  return r === "pendiente" ? "nuevo" : "curso";
}
function itemsHtml(s) {
  const p = s.pedido || {};
  if (Array.isArray(p.items) && p.items.length) {
    return p.items.map((i) => `<div class="rt-item"><span>${esc(i.q || 1)} × ${esc(i.n)}</span><b>${money((Number(i.p) || 0) * (Number(i.q) || 1))}</b></div>`).join("");
  }
  return `<div class="rt-item"><span>Pedido</span></div>`;
}
const etiqueta = (s) => {
  const r = (s.rest && s.rest.estado) || "pendiente";
  if (s.estado === "cancelado") return ["rech", "Cancelado"];
  if (s.estado === "entregado") return ["fin", "Entregado"];
  return { pendiente: ["", "Nuevo"], aceptado: ["prep", "Aceptado"], preparando: ["prep", "Preparando"], listo: ["listo", "Listo para retirar"], rechazado: ["rech", "Rechazado"] }[r] || ["", r];
};
function tarjeta(s) {
  const r = (s.rest && s.rest.estado) || "pendiente", g = grupoDe(s), [cl, tx] = etiqueta(s), p = s.pedido || {};
  const total = Number(p.subtotal) || (Array.isArray(p.items) ? p.items.reduce((a, i) => a + (Number(i.p) || 0) * (Number(i.q) || 1), 0) : 0);
  let acc = "";
  if (g === "nuevo") acc = `<button class="ok" data-a="aceptar" type="button">✅ Aceptar</button><button class="no" data-a="rechazar" type="button">✖ Rechazar</button>`;
  else if (g === "curso") {
    if (r === "aceptado") acc = `<button class="ok" data-a="preparando" type="button">👨‍🍳 Empezar a preparar</button>`;
    else if (r === "preparando") acc = `<button class="ok" data-a="listo" type="button">🛍️ Listo para retirar</button>`;
    else if (r === "listo") acc = `<span class="rt-rep">Esperando al repartidor…</span>`;
    if (r === "aceptado" || r === "preparando") acc += `<button class="no" data-a="rechazar" type="button">✖ No puedo</button>`;
  }
  const rep = s.repartidorNombre ? `<div class="rt-rep">🛵 ${esc(s.repartidorNombre)}</div>` : (g === "curso" ? `<div class="rt-rep">🛵 Buscando repartidor…</div>` : "");
  const fin = s.rest && s.rest.prepMin && s.rest.aceptadoTs ? Number(s.rest.aceptadoTs) + Number(s.rest.prepMin) * 60000 : 0;
  const prep = fin && g === "curso" ? (r === "listo" ? `<div class="rt-crono ok">✅ Listo · tiempo pedido: ${esc(s.rest.prepMin)} min</div>` : `<div class="rt-crono" data-fin="${fin}"><span>⏱ Tiempo restante (${esc(s.rest.prepMin)} min)</span><b>--:--</b></div>`) : "";
  const mot = s.rest && s.rest.motivo && r === "rechazado" ? `<div class="rt-nota">Motivo: ${esc(s.rest.motivo)}</div>` : "";
  return `<article class="rt-ped ${g === "nuevo" ? "nuevo" : ""}" data-id="${esc(s.id)}">
    <div class="rt-ped-top"><div><strong>🛵 Brother’s Deliverys · ${esc(bonito(s.id))}</strong><small>${esc(hace(s.creado || s.ts))} · ${esc(hora(s.creado || s.ts))}</small></div><span class="rt-chip ${cl}">${esc(tx)}</span></div>
    <div class="rt-items">${itemsHtml(s)}</div>
    ${p.nota ? `<div class="rt-nota">📝 ${esc(p.nota)}</div>` : ""}
    ${total ? `<div class="rt-total"><span>Productos</span><span>${money(total)}</span></div>` : ""}
    ${rep}${prep}${mot}
    <div class="rt-acc">${acc}</div>
  </article>`;
}
function tickCrono() {
  const n = Date.now();
  document.querySelectorAll(".rt-crono[data-fin]").forEach((e) => {
    const d = Number(e.dataset.fin) - n, a = Math.abs(Math.round(d / 1000)), m = Math.floor(a / 60), s = a % 60;
    e.classList.toggle("tarde", d < 0);
    e.querySelector("b").textContent = (d < 0 ? "+" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    e.querySelector("span").textContent = d < 0 ? "⚠️ Retraso" : e.querySelector("span").textContent.replace("⚠️ Retraso", "⏱ Tiempo restante");
  });
}
setInterval(tickCrono, 1000);
function pintarPedidos() {
  const lista = Object.entries(pedidos).map(([id, s]) => Object.assign({ id }, s)).sort((a, b) => (b.creado || b.ts || 0) - (a.creado || a.ts || 0));
  const cnt = { nuevo: 0, curso: 0, finalizado: 0 };
  lista.forEach((s) => { cnt[grupoDe(s)]++; });
  ["nuevo", "curso", "finalizado"].forEach((k) => { const e = $("rtN_" + k); e.textContent = cnt[k]; e.classList.toggle("hay", k === "nuevo" && cnt.nuevo > 0); });
  $("rtCuenta").textContent = lista.length;
  gestionarAlarma(lista.filter((s) => grupoDe(s) === "nuevo" && ((s.rest && s.rest.estado) || "pendiente") === "pendiente").length);
  const b = $("rtBadge"); b.textContent = cnt.nuevo; b.classList.toggle("oculto", !cnt.nuevo);
  const ver = lista.filter((s) => grupoDe(s) === filtro);
  $("rtListaPedidos").innerHTML = ver.length ? ver.map(tarjeta).join("") : `<p class="rt-vacio">${filtro === "nuevo" ? "No hay pedidos nuevos." : filtro === "curso" ? "No tienes pedidos en curso." : "Aún no hay pedidos finalizados."}</p>`;
  /* Pedido nuevo → sonido (no en la carga inicial) */
  const nuevos = lista.filter((s) => grupoDe(s) === "nuevo" && !vistos.has(s.id) && Date.now() - (s.creado || s.ts || 0) < 120000);
  lista.forEach((s) => vistos.add(s.id));
  if (nuevos.length) { pitar(); toast("📥 Pedido nuevo de Brother’s Deliverys " + bonito(nuevos[0].id)); }
  primeraCarga = false;
  tickCrono();
}
$("rtFiltros").onclick = (e) => {
  const b = e.target.closest("[data-f]"); if (!b) return;
  filtro = b.dataset.f;
  document.querySelectorAll("#rtFiltros button").forEach((x) => x.classList.toggle("on", x === b));
  pintarPedidos();
};
$("rtListaPedidos").onclick = (e) => {
  const b = e.target.closest("[data-a]"), art = e.target.closest("[data-id]"); if (!b || !art) return;
  accion(art.dataset.id, b.dataset.a);
};
async function actualizar(id, cambios, ok) {
  try { await db.ref("solicitudes_entrantes/" + id).update(cambios); if (ok) toast(ok); }
  catch (e) { toast("No se pudo guardar: " + (e.code || e.message)); }
}
function accion(id, a) {
  const s = pedidos[id]; if (!s) return;
  if (a === "aceptar") {
    const prep = Number(perfil.prepMin) || 20;
    modal(`<h2>✅ Aceptar pedido ${esc(bonito(id))}</h2>
      <label>Tiempo de preparación (min)<input id="apPrep" type="number" inputmode="numeric" min="5" max="120" step="5" value="${prep}"></label>
      <button id="apOk" class="primario" type="button">Aceptar</button><button id="apNo" class="oscuro" type="button">Cancelar</button>`);
    $("apNo").onclick = cerrarModal;
    $("apOk").onclick = () => {
      const m = Math.max(5, Math.min(120, parseInt($("apPrep").value, 10) || prep));
      cerrarModal();
      actualizar(id, { "rest/estado": "aceptado", "rest/prepMin": m, "rest/ts": TS, "rest/aceptadoTs": TS }, "Pedido aceptado ✓");
    };
    return;
  }
  if (a === "preparando") return actualizar(id, { "rest/estado": "preparando", "rest/ts": TS }, "Preparando…");
  if (a === "listo") return actualizar(id, { "rest/estado": "listo", "rest/ts": TS, "rest/listoTs": TS }, "Marcado como listo ✓");
  if (a === "rechazar") {
    modal(`<h2>✖ Rechazar pedido ${esc(bonito(id))}</h2>
      <p class="ayuda">El cliente y la central verán el motivo.</p>
      <label>Motivo<input id="rzMot" maxlength="120" placeholder="Ej. Se terminó el plato"></label>
      <button id="rzOk" class="peligro" type="button">Rechazar</button><button id="rzNo" class="oscuro" type="button">Volver</button>`);
    $("rzNo").onclick = cerrarModal;
    $("rzOk").onclick = () => {
      const mot = $("rzMot").value.trim();
      if (mot.length < 3) return toast("Escribe el motivo.");
      cerrarModal();
      actualizar(id, { "rest/estado": "rechazado", "rest/motivo": mot.slice(0, 120), "rest/ts": TS }, "Pedido rechazado");
    };
  }
}

/* ============================================================
   2) MENÚ  (menus/{uid}/{id})
   ============================================================ */
const CATS_BASE = ["Platos", "Bebidas", "Postres", "Extras"];
let catsGuardadas = null, refCats = null;
function listaCats() {
  const v = new Set(Array.isArray(catsGuardadas) && catsGuardadas.length ? catsGuardadas : CATS_BASE);
  Object.values(menu).forEach((p) => { if (p && p.cat) v.add(p.cat); });
  return [...v];
}
function categorias() { return ["Todos", ...listaCats()]; }
/* Gestión de categorías (menusCats/{menú}) */
function formCats() {
  const cs = listaCats();
  modal(`<h2>⚙️ Categorías</h2>
    <div class="rt-catlista">${cs.map((c, i) => `<div class="rt-catfila"><span>${esc(c)}</span><button class="mini" type="button" data-up="${i}" aria-label="Subir ${esc(c)}"${i === 0 ? " disabled" : ""}>⬆️</button><button class="mini" type="button" data-dn="${i}" aria-label="Bajar ${esc(c)}"${i === cs.length - 1 ? " disabled" : ""}>⬇️</button><button class="mini peligro" type="button" data-del="${esc(c)}" aria-label="Eliminar ${esc(c)}">🗑</button></div>`).join("")}</div>
    <label>Nueva categoría<input id="ctNueva" maxlength="24" placeholder="Ej. Combos, Desayunos"></label>
    <div id="ctMsg" class="estado oculto" role="alert"></div>
    <button id="ctAdd" class="primario" type="button">➕ Agregar categoría</button>
    <button id="ctOk" class="oscuro" type="button">Listo</button>`);
  $("ctOk").onclick = cerrarModal;
  $("ctAdd").onclick = async () => {
    const n = $("ctNueva").value.trim().replace(/\s+/g, " ");
    if (n.length < 2) return setMsg("ctMsg", "Escribe el nombre (mínimo 2 letras).", "error");
    if (cs.some((c) => c.toLowerCase() === n.toLowerCase())) return setMsg("ctMsg", "Esa categoría ya existe.", "error");
    if (cs.length >= 20) return setMsg("ctMsg", "Máximo 20 categorías.", "error");
    try { const nl = cs.concat([n.slice(0, 24)]); await db.ref("menusCats/" + mid()).set(nl); catsGuardadas = nl; pintarMenu(); formCats(); }
    catch (err) { setMsg("ctMsg", "No se pudo guardar: " + (err.code || err.message), "error"); }
  };
  $("modalRtCaja").querySelectorAll("[data-up],[data-dn]").forEach((b) => {
    b.onclick = async () => {
      const i = Number(b.dataset.up !== undefined ? b.dataset.up : b.dataset.dn), j = b.dataset.up !== undefined ? i - 1 : i + 1;
      if (j < 0 || j >= cs.length) return;
      const nl = cs.slice(); const x = nl[i]; nl[i] = nl[j]; nl[j] = x;
      try { await db.ref("menusCats/" + mid()).set(nl); catsGuardadas = nl; pintarMenu(); formCats(); }
      catch (err) { setMsg("ctMsg", "No se pudo mover: " + (err.code || err.message), "error"); }
    };
  });
  $("modalRtCaja").querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const c = b.dataset.del;
      if (cs.length <= 1) return setMsg("ctMsg", "Debe quedar al menos una categoría.", "error");
      const usados = Object.entries(menu).filter(([, p]) => p && p.cat === c);
      if (!confirm(usados.length ? `¿Eliminar «${c}»? Sus ${usados.length} producto(s) pasarán a «Otros».` : `¿Eliminar «${c}»?`)) return;
      let nl = cs.filter((x) => x !== c);
      const upd = {};
      if (usados.length) { if (nl.indexOf("Otros") < 0) nl.push("Otros"); usados.forEach(([id]) => { upd["menus/" + mid() + "/" + id + "/cat"] = "Otros"; }); }
      upd["menusCats/" + mid()] = nl;
      try { await db.ref().update(upd); catsGuardadas = nl; if (catSel === c) catSel = "Todos"; pintarMenu(); formCats(); }
      catch (err) { setMsg("ctMsg", "No se pudo eliminar: " + (err.code || err.message), "error"); }
    };
  });
}
function pintarMenu() {
  const cats = categorias(); if (cats.indexOf(catSel) < 0) catSel = "Todos";
  $("rtCats").innerHTML = cats.map((c) => `<button type="button" class="${c === catSel ? "on" : ""}" data-c="${esc(c)}">${esc(c)}</button>`).join("") + `<button type="button" data-c="__gest" aria-label="Gestionar categorías">⚙️ Categorías</button>`;
  const lista = Object.entries(menu).map(([id, p]) => Object.assign({ id }, p)).filter((p) => catSel === "Todos" || p.cat === catSel)
    .sort((a, b) => (a.orden || 0) - (b.orden || 0) || String(a.nombre).localeCompare(String(b.nombre)));
  $("rtListaMenu").innerHTML = lista.length ? lista.map((p) => `<article class="rt-pl ${p.activo === false ? "off" : ""}" data-id="${esc(p.id)}">
      <div class="rt-pl-tx"><b>${esc(p.nombre)}</b>${p.desc ? `<small>${esc(p.desc)}</small>` : ""}<em>${money(p.precio)}</em>${Array.isArray(p.sabores) && p.sabores.length ? `<div class="rt-pl-sab">${p.sabores.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}${Array.isArray(p.variantes) && p.variantes.length ? `<div class="rt-pl-sab">${p.variantes.map((x) => `<span>📏 ${esc(x.n)} · ${money(x.p)}</span>`).join("")}</div>` : ""}${Array.isArray(p.extras) && p.extras.length ? `<div class="rt-pl-sab">${p.extras.map((x) => `<span>➕ ${esc(x.n)} +${money(x.p)}</span>`).join("")}</div>` : ""}</div>
      <div class="rt-pl-img">${p.foto ? `<img src="${esc(p.foto)}" alt="">` : "🍽️"}${p.activo === false ? `<i>Agotado</i>` : ""}</div>
      <div class="rt-pl-pie"><label class="rt-pl-sw"><button class="rt-sw" type="button" role="switch" data-a="sw" aria-checked="${p.activo !== false}" aria-label="Disponible"></button><span>${p.activo === false ? "No disponible" : "Disponible"}</span></label><button class="mini" type="button" data-a="ed">✏️ Editar</button></div>
    </article>`).join("") : `<p class="rt-vacio">${Object.keys(menu).length ? "No hay platos en esta categoría." : "Aún no tienes platos. Toca «➕ Plato» para agregar el primero."}</p>`;
}
$("rtCats").onclick = (e) => { const b = e.target.closest("[data-c]"); if (!b) return; if (b.dataset.c === "__gest") return formCats(); catSel = b.dataset.c; pintarMenu(); };
$("rtListaMenu").onclick = async (e) => {
  const b = e.target.closest("[data-a]"), c = e.target.closest("[data-id]"); if (!b || !c) return;
  const id = c.dataset.id, p = menu[id]; if (!p) return;
  if (b.dataset.a === "ed") return formPlato(p, id);
  try { await db.ref("menus/" + mid() + "/" + id + "/activo").set(p.activo === false); }
  catch (err) { toast("No se pudo cambiar: " + (err.code || err.message)); }
};
$("btnNuevoPlato").onclick = () => formPlato({ cat: catSel === "Todos" ? "Platos" : catSel }, null);

/* Foto reducida a ~480 px JPEG para que quepa en la base de datos */
function reducirFoto(file, max, calidad) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height)), c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); res(c.toDataURL("image/jpeg", calidad));
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("No se pudo leer la imagen.")); };
    img.src = url;
  });
}
const opcTxt = (a) => (Array.isArray(a) ? a : []).map((x) => x.n + " = " + x.p).join("\n");
function leerOpc(txt, max) {
  const out = [];
  String(txt || "").split(/\n/).forEach((l) => {
    const m = l.trim().match(/^(.{1,24}?)\s*[=:]\s*\+?\s*(\d+(?:[.,]\d+)?)$/);
    if (m && out.length < max) out.push({ n: m[1].trim(), p: Math.round(parseFloat(m[2].replace(",", ".")) * 100) / 100 });
  });
  return out;
}
function formPlato(p, id) {
  let foto = p.foto || "";
  const cats = categorias().filter((c) => c !== "Todos"), catIni = p.cat || cats[0] || "Platos";
  if (cats.indexOf(catIni) < 0) cats.unshift(catIni);
  modal(`<h2>${id ? "✏️ Editar plato" : "➕ Nuevo plato"}</h2>
    <label>Nombre<input id="plNombre" maxlength="60" value="${esc(p.nombre || "")}" placeholder="Ej. Pollo con tajadas"></label>
    <label>Descripción (opcional)<textarea id="plDesc" rows="2" maxlength="160" placeholder="Acompañado de…">${esc(p.desc || "")}</textarea></label>
    <div class="rt-fila2">
      <label>Precio (C$)<input id="plPrecio" type="number" inputmode="decimal" min="0" step="0.01" value="${p.precio != null ? esc(p.precio) : ""}" placeholder="0.00"></label>
      <label>Categoría<select id="plCat">${cats.map((c) => `<option value="${esc(c)}" ${c === catIni ? "selected" : ""}>${esc(c)}</option>`).join("")}<option value="__nueva">➕ Nueva categoría…</option></select></label>
    </div>
    <div id="plSugs" class="rt-pl-sab" style="margin:-4px 0 4px"></div>
    <label>Refrescos que incluye este plato (para elegir sabores)<input id="plNSab" type="number" inputmode="numeric" min="1" max="6" value="${esc(p.nSab || 1)}"></label>
    <label>Tamaños u opciones con precio (opcional, una por línea)<textarea id="plVar" rows="3" placeholder="Media libra = 90&#10;Una libra = 170">${esc(opcTxt(p.variantes))}</textarea></label>
    <label>Adicionales opcionales (una por línea, el cliente decide)<textarea id="plExt" rows="3" placeholder="Con bebida = 25&#10;Extra queso = 15">${esc(opcTxt(p.extras))}</textarea></label>
    <input id="plCatNueva" class="oculto" maxlength="24" placeholder="Nombre de la nueva categoría">
    <label>Sabores (opcional, separados por coma)<input id="plSab" maxlength="160" value="${esc(Array.isArray(p.sabores) ? p.sabores.join(", ") : "")}" placeholder="Ej. Naranja, Piña, Cola"></label>
    <div class="eq-foto-fila"><div id="plFotoPrev" class="rt-plato-img">${foto ? `<img src="${esc(foto)}" alt="">` : "🍽️"}</div>
      <div class="eq-foto-txt"><strong>Foto (opcional)</strong><div class="acciones-fila"><button id="plFotoBtn" class="mini" type="button">Elegir</button><button id="plFotoQ" class="mini peligro ${foto ? "" : "oculto"}" type="button">Quitar</button></div></div>
      <input id="plFotoFile" type="file" accept="image/*" hidden></div>
    <div id="plMsg" class="estado oculto" role="alert"></div>
    <button id="plOk" class="primario" type="button">Guardar</button>
    ${id ? `<button id="plDel" class="peligro" type="button">🗑 Eliminar plato</button>` : ""}
    <button id="plNo" class="oscuro" type="button">Cancelar</button>`);
  const prev = () => { $("plFotoPrev").innerHTML = foto ? `<img src="${esc(foto)}" alt="">` : "🍽️"; $("plFotoQ").classList.toggle("oculto", !foto); };
  $("plNo").onclick = cerrarModal;
  /* Sabores ya usados en el menú: se sugieren para no escribirlos otra vez */
  const conocidos = [...new Set(Object.values(menu).flatMap((x) => (x && Array.isArray(x.sabores) ? x.sabores : [])))];
  const pintarSugs = () => {
    const act = $("plSab").value.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    const faltan = conocidos.filter((s) => act.indexOf(s.toLowerCase()) < 0);
    $("plSugs").innerHTML = faltan.length ? "<small style='width:100%;font-weight:700;color:var(--texto2)'>Sabores de tu menú (toca para agregar):</small>" + faltan.map((s) => `<button type="button" class="mini" data-s="${esc(s)}">+ ${esc(s)}</button>`).join("") + (faltan.length > 1 ? `<button type="button" class="mini" data-s="__todos">➕ Todos</button>` : "") : "";
  };
  $("plSugs").onclick = (e) => {
    const b = e.target.closest("[data-s]"); if (!b) return;
    const act = $("plSab").value.split(",").map((x) => x.trim()).filter(Boolean), add = b.dataset.s === "__todos" ? conocidos : [b.dataset.s];
    add.forEach((s) => { if (act.map((x) => x.toLowerCase()).indexOf(s.toLowerCase()) < 0) act.push(s); });
    $("plSab").value = act.join(", "); pintarSugs();
  };
  $("plSab").oninput = pintarSugs; pintarSugs();
  $("plCat").onchange = () => { const n = $("plCat").value === "__nueva"; $("plCatNueva").classList.toggle("oculto", !n); if (n) $("plCatNueva").focus(); };
  $("plFotoBtn").onclick = () => $("plFotoFile").click();
  $("plFotoQ").onclick = () => { foto = ""; prev(); };
  $("plFotoFile").onchange = async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try { foto = await reducirFoto(f, 480, 0.72); prev(); } catch (err) { setMsg("plMsg", err.message, "error"); }
  };
  if (id) $("plDel").onclick = async () => {
    if (!confirm("¿Eliminar este plato del menú?")) return;
    try { await db.ref("menus/" + mid() + "/" + id).remove(); cerrarModal(); toast("Plato eliminado."); } catch (err) { setMsg("plMsg", err.code || err.message, "error"); }
  };
  $("plOk").onclick = async () => {
    let precio, cat; const nombre = $("plNombre").value.trim(); precio = parseFloat($("plPrecio").value); cat = $("plCat").value === "__nueva" ? $("plCatNueva").value.trim().replace(/\s+/g, " ") : $("plCat").value;
    if (!cat || cat.length < 2) return setMsg("plMsg", "Escribe el nombre de la nueva categoría.", "error");
    if (nombre.length < 2) return setMsg("plMsg", "Escribe el nombre del plato.", "error");
    const variantes = leerOpc($("plVar").value, 6), extras = leerOpc($("plExt").value, 8);
    if ($("plVar").value.trim() && !variantes.length) return setMsg("plMsg", "Tamaños: usa el formato «Nombre = precio», una por línea.", "error");
    if ($("plExt").value.trim() && !extras.length) return setMsg("plMsg", "Adicionales: usa el formato «Nombre = precio», una por línea.", "error");
    if (!(precio >= 0) && variantes.length) precio = Math.min(...variantes.map((v) => v.p));
    if (!(precio >= 0)) return setMsg("plMsg", "Escribe un precio válido.", "error");
    const sabores = [...new Set($("plSab").value.split(",").map((x) => x.trim().slice(0, 20)).filter(Boolean))].slice(0, 8);
    const d = { sabores: sabores.length ? sabores : null, nSab: sabores.length && parseInt($("plNSab").value, 10) > 1 ? Math.min(6, parseInt($("plNSab").value, 10)) : null, variantes: variantes.length ? variantes : null, extras: extras.length ? extras : null, nombre, desc: $("plDesc").value.trim().slice(0, 160), precio: Math.round(precio * 100) / 100, cat: cat.slice(0, 24), foto: foto || null, actualizado: TS };
    $("plOk").disabled = true;
    try {
      if (id) await db.ref("menus/" + mid() + "/" + id).update(d);
      else { const k = db.ref("menus/" + mid()).push().key; await db.ref("menus/" + mid() + "/" + k).set(Object.assign(d, { activo: true, orden: Date.now(), creado: TS })); }
      if (listaCats().every((c) => c.toLowerCase() !== cat.toLowerCase())) { const nl = listaCats().concat([cat.slice(0, 24)]); await db.ref("menusCats/" + mid()).set(nl); catsGuardadas = nl; }
      cerrarModal(); toast("Plato guardado ✓");
    } catch (err) { setMsg("plMsg", "No se pudo guardar: " + (err.code || err.message), "error"); $("plOk").disabled = false; }
  };
}

/* ============================================================
   3) MI NEGOCIO  (restaurantes/{uid} + lugares/rest_{uid})
   ============================================================ */
let perfilPintado = false, mapa = null, pin = null, pinLL = null;
/* Horario de atención por día (restaurantes/{id}/horario/{lun..dom} = {a:"HH:MM", c:"HH:MM"}). Sin horario = siempre. */
const DIAS = [["lun", "Lunes"], ["mar", "Martes"], ["mie", "Miércoles"], ["jue", "Jueves"], ["vie", "Viernes"], ["sab", "Sábado"], ["dom", "Domingo"]];
const DIA_JS = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
const minHr = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function dentroHorarioRt(h, f) {
  if (!h || typeof h !== "object" || !Object.keys(h).length) return true;
  f = f || new Date();
  const hoy = h[DIA_JS[f.getDay()]], ayer = h[DIA_JS[(f.getDay() + 6) % 7]], n = f.getHours() * 60 + f.getMinutes();
  if (hoy) { const a = minHr(hoy.a), c = minHr(hoy.c); if (a != null && c != null && (a < c ? n >= a && n < c : n >= a)) return true; }
  if (ayer) { const a = minHr(ayer.a), c = minHr(ayer.c); if (a != null && c != null && c <= a && n < c) return true; }
  return false;
}
function pintarHorario(h) {
  h = h || {};
  $("pfHorario").innerHTML = DIAS.map(([k, n]) => {
    const d = h[k], on = !!d;
    return `<div class="rt-hd ${on ? "" : "off"}" data-k="${k}"><label><input type="checkbox" ${on ? "checked" : ""}> ${n}</label><div class="horas"><input type="time" data-t="a" value="${esc(d ? d.a : "08:00")}"><span>a</span><input type="time" data-t="c" value="${esc(d ? d.c : "20:00")}"></div></div>`;
  }).join("");
  $("pfHorario").querySelectorAll(".rt-hd input[type=checkbox]").forEach((c) => { c.onchange = () => c.closest(".rt-hd").classList.toggle("off", !c.checked); });
}
function leerHorario() {
  const out = {};
  $("pfHorario").querySelectorAll(".rt-hd").forEach((f) => {
    if (!f.querySelector("input[type=checkbox]").checked) return;
    const a = f.querySelector("[data-t=a]").value, c = f.querySelector("[data-t=c]").value;
    if (/^\d{2}:\d{2}$/.test(a) && /^\d{2}:\d{2}$/.test(c) && a !== c) out[f.dataset.k] = { a, c };
  });
  return Object.keys(out).length ? out : null;
}
$("btnCopiarHorario").onclick = () => {
  const filas = [...$("pfHorario").querySelectorAll(".rt-hd")], base = filas.find((f) => f.querySelector("input[type=checkbox]").checked);
  if (!base) return toast("Marca primero un día con su horario.");
  const a = base.querySelector("[data-t=a]").value, c = base.querySelector("[data-t=c]").value;
  filas.forEach((f) => { f.querySelector("input[type=checkbox]").checked = true; f.classList.remove("off"); f.querySelector("[data-t=a]").value = a; f.querySelector("[data-t=c]").value = c; });
};
function llenarCiudades() {
  try { ciudadesOk = Ciudades.habilitadas(); } catch (_) { ciudadesOk = []; }
  const sel = $("pfCiudad"), actual = sel.value || perfil.ciudad || "";
  sel.innerHTML = ciudadesOk.map((c) => `<option value="${esc(c.id)}">${esc(c.nombre)}</option>`).join("");
  if (actual && ciudadesOk.some((c) => c.id === actual)) sel.value = actual;
}
function pintarFotoPerfil() {
  const b = $("rtFotoPrev");
  b.innerHTML = fotoPerfil ? `<img src="${esc(fotoPerfil)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">` : "🍔";
  $("rtFotoQuitar").classList.toggle("oculto", !fotoPerfil);
}
function pintarCoord() {
  $("pfCoord").textContent = pinLL ? pinLL.lat.toFixed(6) + ", " + pinLL.lng.toFixed(6) : "Toca el mapa para fijar el pin";
}
function pintarPerfil() {
  perfilPintado = true;
  $("pfNombre").value = perfil.nombre || ""; $("pfDesc").value = perfil.desc || "";
  db.ref("restaurantesPriv/" + uid + "/tel").once("value").then((t) => { if (!$("pfTel").value) $("pfTel").value = t.val() || ""; }).catch(() => {});
  $("pfDir").value = perfil.dir || ""; $("pfPrep").value = perfil.prepMin || 20;
  llenarCiudades(); if (perfil.ciudad) $("pfCiudad").value = perfil.ciudad;
  if (sedes.length > 1) $("pfCiudad").disabled = true;
  pintarHorario(perfil.horario);
  fotoPerfil = perfil.foto || ""; pintarFotoPerfil();
  pinLL = Number.isFinite(perfil.lat) && Number.isFinite(perfil.lng) ? { lat: perfil.lat, lng: perfil.lng } : null; pintarCoord();
  pintarPerfilBarra();
}
function ponerPin(ll, centrar) {
  pinLL = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) };
  if (mapa) {
    if (pin) pin.setLatLng(pinLL);
    else pin = L.marker(pinLL, { draggable: true }).addTo(mapa).on("dragend", () => { const p = pin.getLatLng(); ponerPin(p, false); });
    if (centrar) mapa.setView(pinLL, Math.max(mapa.getZoom(), 16));
  }
  pintarCoord();
}
function iniciarMapa() {
  if (!mapa) {
    const c = (() => { try { return Ciudades.porId($("pfCiudad").value) || Ciudades.CATALOGO[0]; } catch (_) { return { lat: 12.6294, lng: -87.1311 }; } })();
    mapa = L.map("rtMapa", { zoomControl: true }).setView(pinLL ? [pinLL.lat, pinLL.lng] : [c.lat, c.lng], pinLL ? 16 : 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    mapa.on("click", (e) => ponerPin(e.latlng, false));
    if (pinLL) ponerPin(pinLL, false);
  }
  setTimeout(() => mapa.invalidateSize(), 120);
}
$("btnUbicGps").onclick = () => {
  if (!navigator.geolocation) return toast("Tu dispositivo no permite ubicación.");
  navigator.geolocation.getCurrentPosition((p) => { iniciarMapa(); ponerPin({ lat: p.coords.latitude, lng: p.coords.longitude }, true); },
    () => toast("No se pudo obtener tu ubicación. Toca el mapa para fijar el pin."), { enableHighAccuracy: true, timeout: 15000 });
};
$("pfCiudad").onchange = () => { if (mapa && !pinLL) { const c = Ciudades.porId($("pfCiudad").value); if (c) mapa.setView([c.lat, c.lng], 14); } };
$("rtFotoElegir").onclick = $("rtFotoPrev").onclick = () => $("rtFotoFile").click();
$("rtFotoQuitar").onclick = () => { fotoPerfil = ""; pintarFotoPerfil(); };
$("rtFotoFile").onchange = async (e) => {
  const f = e.target.files && e.target.files[0]; if (!f) return;
  try { fotoPerfil = await reducirFoto(f, 360, 0.75); pintarFotoPerfil(); } catch (err) { setMsg("msgPerfil", err.message, "error"); }
};
const normalizarTel = (t) => String(t || "").replace(/\D+/g, "");
$("btnGuardarPerfil").onclick = async () => {
  const nombre = $("pfNombre").value.trim(), tel = normalizarTel($("pfTel").value), ciudad = $("pfCiudad").value;
  if (nombre.length < 2) return setMsg("msgPerfil", "Escribe el nombre del restaurante.", "error");
  if ($("pfTel").value.trim() && (tel.length < 8 || tel.length > 15)) return setMsg("msgPerfil", "El teléfono no es válido. Usa números con código de país, ej. 50588887777.", "error");
  if (!pinLL) return setMsg("msgPerfil", "Fija la ubicación del restaurante en el mapa.", "error");
  if (!ciudad) return setMsg("msgPerfil", "Elige la ciudad.", "error");
  const dir = $("pfDir").value.trim().slice(0, 160), prep = Math.max(5, Math.min(120, parseInt($("pfPrep").value, 10) || 20));
  const ficha = { nombre, desc: $("pfDesc").value.trim().slice(0, 160), ciudad, dir, lat: pinLL.lat, lng: pinLL.lng, prepMin: prep, foto: fotoPerfil || null, horario: leerHorario(), actualizado: TS };
  setMsg("msgPerfil", "Guardando…"); $("btnGuardarPerfil").disabled = true;
  try {
    await db.ref("restaurantes/" + uid).update(ficha);
    await db.ref("restaurantesPriv/" + uid + "/tel").set(tel || null);
    const lugar = { nombre, icono: "🍔", dir, lat: pinLL.lat, lng: pinLL.lng, ciudad, tipo: "restaurante", restauranteUid: uid, actualizado: TS };
    await db.ref("lugares/rest_" + uid).update(lugar);
    setMsg("msgPerfil", "Guardado ✓ Los repartidores ya ven tu restaurante en el mapa.", "ok");
  } catch (e) { setMsg("msgPerfil", "No se pudo guardar: " + (e.code || e.message), "error"); }
  finally { $("btnGuardarPerfil").disabled = false; }
};

/* ============================================================
   Chat del pedido (solicitudes_entrantes/{id}/mensajes)
   ============================================================ */
let chatId = null, refChat = null;
function burbuja(key, m) {
  const caja = $("chMsgs"); if (!caja || !m || document.getElementById("m-" + key)) return;
  const d = document.createElement("div"); d.id = "m-" + key;
  if (m.tipo === "factura") { d.className = "rt-b sis"; d.textContent = "🧾 Factura · " + money(m.factura && m.factura.totalFinal); }
  else {
    const yo = m.de === "restaurante";
    d.className = "rt-b" + (yo ? " yo" : "");
    const quien = yo ? "" : m.de === "cliente" ? "Cliente" : m.de === "repartidor" ? "Repartidor" : "Central";
    d.innerHTML = (quien ? `<span class="q">${quien}</span>` : "") + `<p>${esc(m.texto || (m.tipo === "foto" ? "📷 Foto" : ""))}</p><time>${esc(hora(m.ts))}</time>`;
  }
  const abajo = caja.scrollHeight - caja.scrollTop - caja.clientHeight < 80;
  caja.appendChild(d); if (abajo) caja.scrollTop = caja.scrollHeight;
}
function abrirChat(id) {
  const s = pedidos[id]; if (!s) return;
  cerrarChat(); chatId = id;
  $("chTitulo").textContent = (s.nombre || "Cliente") + " · " + bonito(id);
  $("chSub").textContent = s.repartidorNombre ? "Repartidor: " + s.repartidorNombre : "Chat del pedido";
  $("chMsgs").innerHTML = ""; $("modalChat").classList.remove("oculto");
  refChat = db.ref("solicitudes_entrantes/" + id + "/mensajes").limitToLast(200);
  refChat.on("child_added", (x) => burbuja(x.key, x.val()), (e) => { $("chMsgs").innerHTML = `<div class="rt-b sis">No se pudo abrir el chat: ${esc(e.code || e.message)}</div>`; });
  setTimeout(() => { $("chMsgs").scrollTop = $("chMsgs").scrollHeight; }, 300);
}
function cerrarChat() {
  if (refChat) { try { refChat.off(); } catch (_) {} refChat = null; }
  chatId = null; const m = $("modalChat"); if (m) m.classList.add("oculto");
}
$("chCerrar").onclick = cerrarChat;
$("modalChat").addEventListener("click", (e) => { if (e.target === $("modalChat")) cerrarChat(); });
$("chIn").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chForm").requestSubmit(); } });
$("chForm").onsubmit = async (e) => {
  e.preventDefault();
  const texto = $("chIn").value.trim().slice(0, 600); if (!texto || !chatId) return;
  $("chIn").value = "";
  const k = db.ref("solicitudes_entrantes/" + chatId + "/mensajes").push().key;
  try { await db.ref("solicitudes_entrantes/" + chatId + "/mensajes/" + k).set({ de: "restaurante", tipo: "texto", texto, ts: TS }); }
  catch (err) { $("chIn").value = texto; toast("No se pudo enviar: " + (err.code || err.message)); }
};

/* ============================================================
   Push (APK Capacitor) y segundo plano
   ============================================================ */
const cap = () => window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins : null;
async function registrarPush() {
  try {
    const P = cap() && cap().PushNotifications; if (!P || !uid) return;
    try { await P.createChannel({ id: "pedidos", name: "Pedidos", importance: 5, sound: "default", vibration: true, visibility: 1 }); } catch (_) {}
    try { await P.createChannel({ id: "avisos", name: "Avisos y promociones", description: "Mensajes de Brother’s Deliverys", importance: 5, sound: "default", vibration: true, lights: true, visibility: 1 }); } catch (_) {}
    try { await P.createChannel({ id: "solicitudes", name: "Solicitudes de pedido (urgente)", description: "Suena con voz hasta que aceptes el pedido", importance: 5, sound: "solicitud_pedido", vibration: true, lights: true, lightColor: "#FF0000", visibility: 1 }); } catch (_) {}
    const perm = await P.requestPermissions(); if (perm.receive !== "granted") return;
    P.addListener("registration", (t) => {
      if (!t || !t.value) return;
      const ids = new Set([uid].concat((sedes || []).map((x) => x && x.id)).filter(Boolean));   // el mismo celular recibe los pedidos de todas sus sedes
      ids.forEach((i) => db.ref("restaurantesPriv/" + i + "/fcmToken").set(t.value).catch(() => {}));
    });
    P.addListener("pushNotificationReceived", (n) => { const d = (n && n.data) || {}; if (d.tipo === "promo") { pitar(); toast("📣 " + ((n && n.title) || "Brother’s Deliverys") + (n && n.body ? " · " + n.body : "")); } else { pitar(); decirSolicitud(); } });
    await P.register();
  } catch (e) { console.warn("Push restaurante:", e && e.message ? e.message : e); }
}
async function quitarPush() { try { if (uid) await db.ref("restaurantesPriv/" + uid + "/fcmToken").remove(); } catch (_) {} }
$("btnActiva").onclick = async () => {
  try {
    const B = cap() && (cap().BackgroundMode || cap().CapacitorBackgroundMode);
    if (B && B.enable) { await B.enable(); if (B.disableWebViewOptimizations) await B.disableWebViewOptimizations(); if (B.requestDisableBatteryOptimizations) await B.requestDisableBatteryOptimizations(); toast("Segundo plano activado ✓"); }
    else toast("En el celular: Ajustes → Batería → Brothers Restaurante → Sin restricciones.");
  } catch (e) { toast("No se pudo activar: " + (e && e.message ? e.message : e)); }
};

/* Botón «atrás» de Android: cierra capas abiertas antes de salir */
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("modalRt").classList.contains("oculto")) cerrarModal(); else cerrarChat();
});
setTimeout(() => { const s = $("splash"); if (s && !auth.currentUser) s.classList.add("oculto"); }, 4000);
})();
