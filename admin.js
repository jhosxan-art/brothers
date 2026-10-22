/* ============================================================
   PANEL DE ADMINISTRACIÓN
   - Agregar / quitar repartidores sin entrar a la consola de Firebase
   - Mapa con todos los repartidores en ruta, con su nombre
   ============================================================ */
const auth = firebase.auth();
const db = firebase.database();
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const SIN_SENAL_MS = 90000;   // sin posición nueva en 90 s → "Sin señal"
const activos = {};           // token del pedido → datos (solo pedidos en ruta)
const marcadores = {};        // token → marcador del mapa
let registrados = {};         // uid → { email, nombre } (o true en cuentas antiguas)
let mapa = null, consultaActivos = null, ajusteProgramado = false, secundaria = null;

/* ---------- Utilidades ---------- */
function setMsg(id, texto, tipo = "") {
  const el = $(id);
  el.textContent = texto || "";
  el.className = "estado " + tipo + (texto ? "" : " oculto");
}
const infoReg = (uid) => (registrados[uid] && typeof registrados[uid] === "object" ? registrados[uid] : {});
const nombreDe = (d) => d.repartidorNombre || infoReg(d.repartidorUid).nombre || nombreDesdeCorreo(infoReg(d.repartidorUid).email) || "Repartidor";
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

/* ---------- Vistas y pestañas ---------- */
function mostrar(vista) {
  $("loginMain").classList.toggle("oculto", vista !== "login");
  $("vistaApp").classList.toggle("oculto", vista !== "app");
  $("btnSalir").classList.toggle("oculto", vista !== "app");
}
document.querySelectorAll(".tabs button").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("activa", x === b));
    ["panelMapa", "panelEquipo"].forEach((id) => $(id).classList.toggle("oculto", id !== b.dataset.tab));
    if (b.dataset.tab === "panelMapa") setTimeout(() => mapa.invalidateSize(), 50);
  };
});

/* ---------- Sesión (solo administradores) ---------- */
$("btnLogin").onclick = () => {
  setMsg("msgLogin", "");
  auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
      .catch((e) => setMsg("msgLogin", errorAuth(e), "error"));
};
auth.onAuthStateChanged(async (user) => {
  if (!user) { detener(); $("clave").value = ""; return mostrar("login"); }
  try {
    const esAdmin = (await db.ref("admins/" + user.uid).once("value")).exists();
    if (!esAdmin) {
      setMsg("msgLogin", "Esta cuenta no tiene permisos de administrador.", "error");
      return auth.signOut();
    }
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
function iconoConNombre(nombre) {
  return L.divIcon({
    className: "",
    html: `<div class="marca-rider-caja"><div class="marca-rider">${RIDER_SVG}</div><span class="etiqueta-rider">${esc(nombre)}</span></div>`,
    iconSize: [56, 56], iconAnchor: [28, 28]
  });
}
function ajustarVista() {
  const pts = Object.values(marcadores).map((m) => m.getLatLng());
  if (!pts.length) return;
  if (pts.length === 1) mapa.setView(pts[0], 16);
  else mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
}
$("btnCentrar").onclick = ajustarVista;

/* ---------- Monitoreo en tiempo real ---------- */
function iniciarMonitoreo() {
  detener();
  // Solo pedidos en ruta: cada cambio de GPS llega como child_changed
  consultaActivos = db.ref("pedidos").orderByChild("estado").equalTo("en_ruta");
  const fallo = () => setMsg("msgEquipo", "Sin permiso para leer datos. Revisa las reglas y tu registro en 'admins'.", "error");
  consultaActivos.on("child_added", (s) => actualizar(s.key, s.val()), fallo);
  consultaActivos.on("child_changed", (s) => actualizar(s.key, s.val()));
  consultaActivos.on("child_removed", (s) => quitar(s.key));
  db.ref("repartidores").on("value", (s) => { registrados = s.val() || {}; pintarActivos(); pintarEquipo(); }, fallo);
}
function detener() {
  if (consultaActivos) { consultaActivos.off(); consultaActivos = null; }
  db.ref("repartidores").off();
  Object.keys(marcadores).forEach((t) => { mapa?.removeLayer(marcadores[t]); delete marcadores[t]; });
  Object.keys(activos).forEach((t) => delete activos[t]);
  registrados = {}; ajusteProgramado = false;
}
function actualizar(token, d) {
  activos[token] = d;
  if (typeof d.lat === "number") {
    const pos = [d.lat, d.lng];
    if (!marcadores[token]) marcadores[token] = L.marker(pos, { icon: iconoConNombre(nombreDe(d)) }).addTo(mapa);
    else marcadores[token].setLatLng(pos);
    // Al abrir, esperar a que lleguen todos y encuadrarlos una sola vez
    if (!ajusteProgramado) { ajusteProgramado = true; setTimeout(ajustarVista, 800); }
  }
  pintarActivos(); pintarEquipo();
}
function quitar(token) {
  if (marcadores[token]) { mapa.removeLayer(marcadores[token]); delete marcadores[token]; }
  delete activos[token];
  pintarActivos(); pintarEquipo();
}

function pintarActivos() {
  const lista = Object.entries(activos).sort((a, b) => nombreDe(a[1]).localeCompare(nombreDe(b[1])));
  $("contador").textContent = `${lista.length} en ruta`;
  if (!lista.length) { $("listaActivos").innerHTML = '<p class="ayuda">Ningún repartidor en ruta ahora.</p>'; return; }
  $("listaActivos").innerHTML = lista.map(([token, d]) => {
    const sinSenal = !d.ts || Date.now() - d.ts > SIN_SENAL_MS;
    const dest = typeof d.distancia === "number" ? `a ${formatoDist(d.distancia)} del destino` : "sin destino marcado";
    return `<div class="tarjeta-rep" data-token="${esc(token)}">
      <div class="fila">
        <span class="avatar">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(nombreDe(d))}</strong>
          <small>Pedido ${esc(d.pedido || "—")} · ${esc(dest)}</small>
          <small>Última señal ${esc(hace(d.ts))}</small></div>
        <span class="chip ${sinSenal ? "alerta" : "vivo"}">${sinSenal ? "Sin señal" : "En vivo"}</span>
      </div></div>`;
  }).join("");
}
$("listaActivos").onclick = (e) => {
  const t = e.target.closest("[data-token]")?.dataset.token;
  if (t && marcadores[t]) mapa.flyTo(marcadores[t].getLatLng(), 17);
};
setInterval(() => { if (!$("vistaApp").classList.contains("oculto")) pintarActivos(); }, 15000);   // refresca "hace X s"

/* ---------- Equipo: agregar y quitar repartidores ---------- */
function pintarEquipo() {
  const ids = Object.keys(registrados);
  if (!ids.length) { $("listaEquipo").innerHTML = '<p class="ayuda">Aún no hay repartidores registrados.</p>'; return; }
  $("listaEquipo").innerHTML = ids.map((uid) => {
    const i = infoReg(uid);
    const nombre = i.nombre || nombreDesdeCorreo(i.email) || "Repartidor";
    const enRuta = Object.values(activos).some((d) => d.repartidorUid === uid);
    return `<div class="tarjeta-rep">
      <div class="fila">
        <span class="avatar">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(nombre)}</strong>
          <small>${i.email ? esc(i.email) : "Sin correo registrado · " + esc(uid.slice(0, 8)) + "…"}</small></div>
        <span class="chip ${enRuta ? "vivo" : ""}">${enRuta ? "En ruta" : "Libre"}</span>
      </div>
      <div class="acciones-fila">
        ${i.email ? `<button class="mini" data-accion="reset" data-uid="${esc(uid)}">Restablecer clave</button>` : ""}
        <button class="mini peligro" data-accion="quitar" data-uid="${esc(uid)}">Quitar</button>
      </div></div>`;
  }).join("");
}
$("listaEquipo").onclick = (e) => {
  const b = e.target.closest("button[data-accion]"); if (!b) return;
  const uid = b.dataset.uid, i = infoReg(uid);
  const nombre = i.nombre || nombreDesdeCorreo(i.email) || "este repartidor";
  if (b.dataset.accion === "quitar") {
    const enRuta = Object.values(activos).some((d) => d.repartidorUid === uid);
    if (!confirm(`¿Quitar a ${nombre}?${enRuta ? " Tiene un viaje en curso." : ""} Ya no podrá usar la app del repartidor.`)) return;
    db.ref("repartidores/" + uid).remove()
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

  // Segunda instancia de Firebase: así crear la cuenta NO cierra tu sesión de administrador
  secundaria = secundaria || firebase.initializeApp(FIREBASE_CONFIG, "secundaria");
  const a = secundaria.auth();
  try {
    let uid;
    try { uid = (await a.createUserWithEmailAndPassword(email, clave)).user.uid; }
    catch (e) {
      if (e.code !== "auth/email-already-in-use") throw e;
      // El correo ya existe (ej. repartidor quitado antes): se vuelve a registrar si la contraseña coincide
      try { uid = (await a.signInWithEmailAndPassword(email, clave)).user.uid; }
      catch (_) { throw { message: "Ese correo ya existe. Escribe su contraseña actual para volver a registrarlo, o usa “Restablecer clave”." }; }
    }
    const nombre = nombreDesdeCorreo(email);
    await db.ref("repartidores/" + uid).set({ email, nombre, creado: firebase.database.ServerValue.TIMESTAMP });
    $("nuevoCorreo").value = ""; $("nuevaClave").value = "";
    setMsg("msgEquipo", `Listo: ${nombre} ya puede entrar a la app del repartidor.`, "ok");
  } catch (e) {
    setMsg("msgEquipo", e.code ? errorAuth(e) : e.message, "error");
  } finally {
    try { await a.signOut(); } catch (_) {}
    $("btnAgregar").disabled = false;
  }
};
