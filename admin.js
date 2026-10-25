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
let selUid = null;            // repartidor elegido para guiarlo
let resEquipo = {}, sinLeerEq = {}, chatEqAbierto = null;
let refGuias = null, refEq = null;
let modoSel = false;          // selección múltiple de chats
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
  $("loginMain").classList.toggle("oculto", vista !== "login");
  $("vistaApp").classList.toggle("oculto", vista !== "app");
  $("btnSalir").classList.toggle("oculto", vista !== "app");
}
const PANELES = ["panelMapa", "panelChats", "panelEquipo"];
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
auth.onAuthStateChanged(async (user) => {
  if (!user) { detener(); $("clave").value = ""; return mostrar("login"); }
  try {
    const esAdmin = (await db.ref("admins/" + user.uid).once("value")).exists();
    if (!esAdmin) { setMsg("msgLogin", "Esta cuenta no tiene permisos de administrador.", "error"); return auth.signOut(); }
  } catch (e) {
    setMsg("msgLogin", "No se pudo verificar el permiso. ¿Publicaste las reglas nuevas?", "error");
    return auth.signOut();
  }
  mostrar("app");
  initMapa();
  iniciarMonitoreo();
});
$("btnSalir").onclick = () => { if (confirm("¿Cerrar sesión?")) auth.signOut(); };

/* ---------- Mapa ---------- */
function initMapa() {
  if (!mapa) {
    mapa = L.map("mapaAdmin").setView([-12.0464, -77.0428], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(mapa);
  }
  mapa.on("click", (e) => { if (selUid) fijarGuia(selUid, e.latlng); });   // con un repartidor elegido, tocar el mapa = marcar dónde está el cliente
  setTimeout(() => mapa.invalidateSize(), 50);
}
function ajustarVista() {
  const pts = Object.values(marcadores).map((m) => m.getLatLng());
  if (!pts.length) return;
  if (pts.length === 1) mapa.setView(pts[0], 16);
  else mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
}
$("btnCentrar").onclick = ajustarVista;

function pintarMarcador(uid) {
  const u = ubic[uid];
  if (!u || typeof u.lat !== "number") return;
  const est = estadoDe(uid), nombre = nombreUid(uid);
  const apagado = est === "desconectado" || est === "sinSenal";
  const clave = nombre + "|" + apagado, pos = [u.lat, u.lng];
  if (!marcadores[uid]) {
    marcadores[uid] = L.marker(pos, { icon: iconoRepartidorNombre(nombre, apagado) }).addTo(mapa);
    marcadores[uid]._clave = clave;
    marcadores[uid].on("click", () => seleccionarRep(uid));   // tocar el icono = elegir a ese repartidor
    if (!ajusteProgramado) { ajusteProgramado = true; setTimeout(ajustarVista, 800); }   // encuadra a todos una sola vez
  } else {
    marcadores[uid].setLatLng(pos);
    if (marcadores[uid]._clave !== clave) { marcadores[uid].setIcon(iconoRepartidorNombre(nombre, apagado)); marcadores[uid]._clave = clave; }
  }
  const el = marcadores[uid].getElement();
  if (el) el.classList.toggle("sel-rep", uid === selUid);
  pintarGuia(uid);   // la línea de su guía sigue al repartidor mientras se mueve
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
  if (!g || typeof g.lat !== "number") {
    if (c) { mapa.removeLayer(c.pin); mapa.removeLayer(c.linea); delete guiaCapas[uid]; }
    return;
  }
  const col = colorUid(uid), p = [g.lat, g.lng], nom = nombreUid(uid), clave = nom + "|" + col;
  const icono = () => L.divIcon({ className: "", html: `<div class="pin-guia" style="--c:${col}"><b>🏠</b></div><span class="etq-cli">Cliente de ${esc(nom)}</span>`, iconSize: [34, 34], iconAnchor: [17, 17] });
  if (!c) {
    c = guiaCapas[uid] = {
      pin: L.marker(p, { icon: icono(), zIndexOffset: 300 }).addTo(mapa),
      linea: L.polyline([], { color: col, weight: 4, opacity: .85, dashArray: "4 10" }).addTo(mapa), clave
    };
  } else if (c.clave !== clave) { c.pin.setIcon(icono()); c.clave = clave; }
  c.pin.setLatLng(p);
  const u = ubic[uid];
  c.linea.setLatLngs(u && typeof u.lat === "number" ? [[u.lat, u.lng], p] : []);
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
async function fijarGuia(uid, ll) {
  const dato = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), ts: firebase.database.ServerValue.TIMESTAMP, por: "admin" };
  const tk = $("guiaPedido").value; if (tk) dato.token = tk;
  try { await db.ref("guias/" + uid).set(dato); toast(`Guía enviada a ${nombreUid(uid)} ✓ Solo la ve él.`); }
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
  refUbic.on("child_added", (s) => { ubic[s.key] = s.val(); pintarMarcador(s.key); pintarLista(); }, fallo);
  refUbic.on("child_changed", (s) => { ubic[s.key] = s.val(); pintarMarcador(s.key); pintarLista(); });
  refUbic.on("child_removed", (s) => { delete ubic[s.key]; quitarMarcador(s.key); pintarLista(); });

  // Guías marcadas por Brothers (una por repartidor)
  refGuias = db.ref("guias");
  const guiaOk = (s) => { guias[s.key] = s.val(); pintarGuia(s.key); pintarLista(); if (s.key === selUid) pintarSeleccion(); };
  refGuias.on("child_added", guiaOk, fallo);
  refGuias.on("child_changed", guiaOk);
  refGuias.on("child_removed", (s) => { delete guias[s.key]; pintarGuia(s.key); pintarLista(); if (s.key === selUid) pintarSeleccion(); });

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
          Voz.hablar(Voz.FRASES.mensajeRepartidor);
        }
      });
    }
    primeraEq = false; resEquipo = n; pintarChats(); pintarLista();
  }, fallo);

  // Pedidos en ruta (para saber quién lleva qué)
  consultaActivos = db.ref("pedidos").orderByChild("estado").equalTo("en_ruta");
  const alCambiar = (s) => { activos[s.key] = s.val(); refrescar(); };
  consultaActivos.on("child_added", alCambiar, fallo);
  consultaActivos.on("child_changed", alCambiar);
  consultaActivos.on("child_removed", (s) => { delete activos[s.key]; refrescar(); });

  db.ref("repartidores").on("value", (s) => { registrados = s.val() || {}; refrescar(); pintarEquipo(); pintarChats(); }, fallo);

  // Últimas 50 conversaciones
  consultaChats = db.ref("chatsResumen").orderByChild("ts").limitToLast(50);
  let primeraCargaChats = true;
  consultaChats.on("value", (s) => {
    const nuevos = s.val() || {};
    if (!primeraCargaChats) {
      // Aviso por voz: el repartidor acaba de escribir (mensaje nuevo = marca de tiempo mayor que la anterior)
      const hayNuevo = Object.entries(nuevos).some(([t, r]) => r.ultimoDe === "repartidor" && (r.ts || 0) > ((resumenes[t] && resumenes[t].ts) || 0));
      if (hayNuevo) Voz.hablar(Voz.FRASES.mensajeRepartidor);
    }
    primeraCargaChats = false;
    resumenes = nuevos; pintarChats();
  }, fallo);
}
function detener() {
  if (refUbic) { refUbic.off(); refUbic = null; }
  if (consultaActivos) { consultaActivos.off(); consultaActivos = null; }
  if (consultaChats) { consultaChats.off(); consultaChats = null; }
  if (refGuias) { refGuias.off(); refGuias = null; }
  if (refEq) { refEq.off(); refEq = null; }
  Object.keys(guiaCapas).forEach((u) => { delete guias[u]; pintarGuia(u); });
  [guias, sinLeerEq].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  resEquipo = {}; selUid = null; selChats.clear(); modoSel = false;
  db.ref("repartidores").off();
  Object.keys(marcadores).forEach(quitarMarcador);
  [ubic, activos].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  registrados = {}; resumenes = {}; ajusteProgramado = false;
}
function refrescar() { Object.keys(ubic).forEach(pintarMarcador); pintarLista(); pintarEquipo(); if (selUid) pintarSeleccion(); }
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
function pintarLista() {
  const ids = [...new Set([...Object.keys(registrados), ...Object.keys(ubic)])];
  const orden = { enRuta: 0, libre: 1, sinSenal: 2, desconectado: 3, sinDatos: 4 };
  ids.sort((a, b) => orden[estadoDe(a)] - orden[estadoDe(b)] || nombreUid(a).localeCompare(nombreUid(b)));
  const enRuta = ids.filter((u) => estadoDe(u) === "enRuta").length;
  const enLinea = ids.filter((u) => ["enRuta", "libre"].includes(estadoDe(u))).length;
  $("contador").textContent = `${enRuta} en ruta · ${enLinea} en línea`;
  if (!ids.length) { $("listaMapa").innerHTML = '<p class="ayuda">Aún no hay repartidores registrados.</p>'; return; }
  $("listaMapa").innerHTML = ids.map((uid) => {
    const est = estadoDe(uid), [texto, clase] = ETIQUETA[est], elegido = uid === selUid, n = sinLeerEq[uid] || 0;
    return `<div class="tarjeta-rep${elegido ? " sel" : ""}" data-uid="${esc(uid)}"><div class="fila">
      <span class="avatar">${RIDER_SVG}</span>
      <div class="datos"><strong>${esc(nombreUid(uid))}</strong><small>${esc(descripcion(uid, est))}${guias[uid] ? " · 📍 guía activa" : ""}</small></div>
      <span class="chip ${clase}">${texto}</span></div>
      <div class="acciones-fila">
        <button class="mini${elegido ? " pri" : ""}" data-act="guiar" data-uid="${esc(uid)}" type="button">📍 ${elegido ? "Elegido" : "Guiar"}</button>
        <button class="mini" data-act="chat" data-uid="${esc(uid)}" type="button">💬 Chat${n ? " (" + n + ")" : ""}</button>
        ${guias[uid] ? `<button class="mini peligro" data-act="quitarguia" data-uid="${esc(uid)}" type="button">Quitar guía</button>` : ""}
      </div></div>`;
  }).join("");
}
$("listaMapa").onclick = (e) => {
  const b = e.target.closest("button[data-act]");
  const uid = (b || e.target.closest("[data-uid]"))?.dataset.uid;
  if (!uid) return;
  if (!b) { if (marcadores[uid]) mapa.flyTo(marcadores[uid].getLatLng(), 17); return; }
  if (b.dataset.act === "guiar") { seleccionarRep(uid); if (selUid && marcadores[uid]) mapa.flyTo(marcadores[uid].getLatLng(), 16); }
  else if (b.dataset.act === "chat") abrirChatRep(uid);
  else if (b.dataset.act === "quitarguia") db.ref("guias/" + uid).remove().catch((err) => toast(err.message));
};

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
  if (!ids.length) { $("listaEquipo").innerHTML = '<p class="ayuda">Aún no hay repartidores registrados.</p>'; return; }
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
  }).join("");
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
