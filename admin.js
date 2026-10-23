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
const viajeDe = (uid) => {
  const e = Object.entries(activos).find(([, d]) => d.repartidorUid === uid);
  return e ? { token: e[0], d: e[1] } : null;
};
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
    if (!ajusteProgramado) { ajusteProgramado = true; setTimeout(ajustarVista, 800); }   // encuadra a todos una sola vez
  } else {
    marcadores[uid].setLatLng(pos);
    if (marcadores[uid]._clave !== clave) { marcadores[uid].setIcon(iconoRepartidorNombre(nombre, apagado)); marcadores[uid]._clave = clave; }
  }
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

  // Pedidos en ruta (para saber quién lleva qué)
  consultaActivos = db.ref("pedidos").orderByChild("estado").equalTo("en_ruta");
  const alCambiar = (s) => { activos[s.key] = s.val(); refrescar(); };
  consultaActivos.on("child_added", alCambiar, fallo);
  consultaActivos.on("child_changed", alCambiar);
  consultaActivos.on("child_removed", (s) => { delete activos[s.key]; refrescar(); });

  db.ref("repartidores").on("value", (s) => { registrados = s.val() || {}; refrescar(); pintarEquipo(); }, fallo);

  // Últimas 50 conversaciones
  consultaChats = db.ref("chatsResumen").orderByChild("ts").limitToLast(50);
  consultaChats.on("value", (s) => { resumenes = s.val() || {}; pintarChats(); }, fallo);
}
function detener() {
  if (refUbic) { refUbic.off(); refUbic = null; }
  if (consultaActivos) { consultaActivos.off(); consultaActivos = null; }
  if (consultaChats) { consultaChats.off(); consultaChats = null; }
  db.ref("repartidores").off();
  Object.keys(marcadores).forEach(quitarMarcador);
  [ubic, activos].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  registrados = {}; resumenes = {}; ajusteProgramado = false;
}
function refrescar() { Object.keys(ubic).forEach(pintarMarcador); pintarLista(); pintarEquipo(); }
setInterval(() => { if (!$("vistaApp").classList.contains("oculto")) refrescar(); }, 15000);   // actualiza "hace X s" y "sin señal"

/* ---------- Lista del mapa: todos los repartidores ---------- */
function descripcion(uid, est) {
  const u = ubic[uid] || {}, v = viajeDe(uid);
  if (est === "enRuta") {
    const dist = typeof v.d.distancia === "number" ? `a ${formatoDist(v.d.distancia)} del destino` : "sin destino marcado";
    return `Pedido ${v.d.pedido || "—"} · ${dist}`;
  }
  if (est === "libre") return `Sin pedido · señal ${hace(u.ts)}`;
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
    const est = estadoDe(uid), [texto, clase] = ETIQUETA[est];
    return `<div class="tarjeta-rep" data-uid="${esc(uid)}"><div class="fila">
      <span class="avatar">${RIDER_SVG}</span>
      <div class="datos"><strong>${esc(nombreUid(uid))}</strong><small>${esc(descripcion(uid, est))}</small></div>
      <span class="chip ${clase}">${texto}</span></div></div>`;
  }).join("");
}
$("listaMapa").onclick = (e) => {
  const uid = e.target.closest("[data-uid]")?.dataset.uid;
  if (uid && marcadores[uid]) mapa.flyTo(marcadores[uid].getLatLng(), 17);
};

/* ---------- Chats archivados ---------- */
function pintarChats() {
  const lista = Object.entries(resumenes).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  if (!lista.length) { $("listaChats").innerHTML = '<p class="ayuda">Aún no hay conversaciones.</p>'; return; }
  $("listaChats").innerHTML = lista.map(([token, r]) => {
    const quien = r.ultimoDe === "cliente" ? "Cliente" : (r.repartidor || "Repartidor");
    const f = r.ts ? new Date(r.ts).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    return `<div class="tarjeta-rep" data-token="${esc(token)}" style="cursor:pointer"><div class="fila">
      <span class="avatar">${RIDER_SVG}</span>
      <div class="datos"><strong>Pedido ${esc(r.pedido || "—")} · ${esc(r.repartidor || "Repartidor")}</strong>
        <small>${esc(quien)}: ${esc(r.ultimo || "")}</small><small>${esc(f)}</small></div></div></div>`;
  }).join("");
}
$("listaChats").onclick = (e) => {
  const token = e.target.closest("[data-token]")?.dataset.token;
  if (!token) return;
  const r = resumenes[token] || {};
  Chat.iniciar({
    token, soloLectura: true, pedido: r.pedido, nombreRepartidor: r.repartidor,
    titulo: (c) => "Pedido " + (c.pedido || "—"),
    subtitulo: (c) => (c.nombreRepartidor ? "Repartidor: " + c.nombreRepartidor : "")
  });
  Chat.abrir();
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
