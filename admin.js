/* ============================================================
   PANEL DE ADMINISTRACIÓN
   - Mapa con TODOS los repartidores, siempre (también cuando no tienen pedido)
   - Chats archivados de cada pedido
   - Agregar / quitar repartidores sin entrar a la consola de Firebase
   FASE 3: fotos de perfil (registrado e invitado) desde el botón 📷 del equipo,
     centro del mapa en Chinandega, watcher de repartidorFotos para avatares en vivo.
   FASE 3 v2: ruta de fotos renombrada a repartidorFotos, permiso de Web Notifications
     solicitado junto al de voz.
   FASE 4 · ajustes aplicados
     · Ícono del pedido en el mapa del admin más discreto (24 px con etiqueta al costado).
     · Al abrir la pestaña "Mapa en vivo", fitBounds de todos los pedidos activos.
     · Palomitas verdes ✓✓ en el Modo Espectador (via ordenes-admin.js).
     · Línea "📮 Última dirección del cliente" en el visor (via ordenes-admin.js).
   FASE 3 · mapa maestro del administrador:
     · Badge "🛵 Con Pedido" sobre el ícono de cada repartidor ocupado.
     · Polyline punteada animada por repartidor en ruta hacia su cliente (toggle 🛣).
     · Pines pulsantes de alerta para solicitudes_entrantes pendientes en el mapa.
     · Encuadre maestro que incluye solicitudes y todos los repartidores en línea.
     · fitBounds automático al llegar una nueva solicitud si el admin está en el mapa.
   ============================================================ */
window.addEventListener("error", (e) => {
  const m = document.getElementById("msgLogin");
  if (m) { m.textContent = "Error en la página: " + e.message + ". Puede que falten archivos por subir a GitHub."; m.className = "estado error"; }
});
const auth = APP.auth();
const db = APP.database();
const $ = (id) => document.getElementById(id);
const esc = escHtml;

const SIN_SENAL_MS = 120000;
const ubic = {};
const marcadores = {};
const activos = {};
let registrados = {};
let resumenes = {};
let mapa = null, refUbic = null, consultaActivos = null, consultaChats = null;
let ajusteProgramado = false, secundaria = null;
const RUTA_EQ = { chats: "chatsEquipo", resumen: "chatsEquipoResumen", fotos: "fotosEquipo" };
const guias = {};
const guiaCapas = {};
let focoUid = null;
let selUid = null;
let resEquipo = {}, sinLeerEq = {}, chatEqAbierto = null;
let refGuias = null, refEq = null;
let modoSel = false;
let ocultos = new Set(); try { ocultos = new Set(JSON.parse(localStorage.getItem("repOcultos") || "[]")); } catch (_) {}
const guardarOcultos = () => { try { localStorage.setItem("repOcultos", JSON.stringify([...ocultos])); } catch (_) {} };
let lugares = {}, refLugares = null;
const lugarMarks = {};
let modoNegocio = false, marcaBusq = null, datosBusq = null, resultadosBusq = [];
const selChats = new Set();

/* FASE 3 · rutas de repartidores y pines de solicitudes pendientes */
/* FASE 1 · botón "Ruta" eliminado: las rutas punteadas quedan deshabilitadas */
const verRutas = false;
try { localStorage.removeItem("verRutasAdmin"); } catch (_) {}
const capaRutas = {};               // uid → polyline
const marcasSolicitud = {};         // id → marker de alerta
let solicitudesMapa = {};           // solicitudes_entrantes (últimas 60)
let refSolicMapa = null;
let primeraSolMapa = true;

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
/* Solicitud de cliente (chat tipo WhatsApp) que el repartidor tomó y sigue activa → también cuenta como viaje (repartidor ocupado) */
const solActivaDe = (uid) => Object.entries(solicitudesMapa).find(([, x]) => x && x.repartidorUid === uid && !["nuevo", "entregado", "cancelado"].includes(x.estado || "nuevo"));
function viajeSolDe(uid) {
  const e = solActivaDe(uid); if (!e) return null;
  return { token: "sol_" + e[0], d: { repartidorUid: uid, estado: "en_ruta", solicitudId: e[0], clienteNombre: e[1].nombre || "Cliente", pedido: "de " + (e[1].nombre || "cliente") } };
}
const viajeDe = (uid) => viajesDe(uid)[0] || viajeSolDe(uid);
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
    if (b.dataset.tab === "panelMapa") {
      setTimeout(() => {
        mapa.invalidateSize();
        /* FASE 4 · al abrir "Mapa en vivo", encuadrar todos los pedidos activos */
        encuadrarTodosActivos();
      }, 60);
    }
  };
});

/* FASE 4 · Encuadra el mapa del admin para que se vean todos los pedidos activos.
   FASE 3 · También incluye TODOS los repartidores en línea y las solicitudes pendientes. */
let encuadrePedidosHecho = false;
function encuadrarTodosActivos() {
  if (!mapa) return;
  const pts = [];
  // Pedidos activos
  Object.entries(activos).forEach(([, d]) => {
    if (!d || d.estado !== "en_ruta") return;
    if (typeof d.destLat === "number" && typeof d.destLng === "number") pts.push([d.destLat, d.destLng]);
    else if (d.cliente && typeof d.cliente.lat === "number" && typeof d.cliente.lng === "number") pts.push([d.cliente.lat, d.cliente.lng]);
  });
  // Todos los repartidores con posición conocida
  Object.keys(ubic).forEach((uid) => {
    const u = ubic[uid]; if (!u || typeof u.lat !== "number") return;
    if (viajeDe(uid) || u.enLinea !== false) pts.push([u.lat, u.lng]);
  });
  // FASE 3 · pines de solicitudes pendientes también entran en el encuadre
  Object.entries(solicitudesMapa).forEach(([, s]) => {
    if (!s || s.repartidorUid) return;
    if (s.estado && s.estado !== "nuevo") return;
    const p = puntoSolicitud(s);
    if (p) pts.push([p.lat, p.lng]);
  });
  if (pts.length >= 2) {
    mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 16 });
    encuadrePedidosHecho = true;
  } else if (pts.length === 1) {
    mapa.setView(pts[0], 15);
    encuadrePedidosHecho = true;
  }
}

$("btnLogin").onclick = () => {
  setMsg("msgLogin", "");
  try {
    auth.signInWithEmailAndPassword($("email").value.trim(), $("clave").value)
        .catch((e) => setMsg("msgLogin", errorAuth(e), "error"));
  } catch (e) { setMsg("msgLogin", "Error: " + e.message, "error"); }
};
try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (_) {}
setTimeout(() => $("splash").classList.add("oculto"), 8000);
auth.onAuthStateChanged(async (user) => {
  if (!user) { detener(); $("clave").value = ""; return mostrar("login"); }
  try {
    const esAdmin = (await db.ref("admins/" + user.uid).once("value")).exists();
    if (!esAdmin) { setMsg("msgLogin", "Esta cuenta no tiene permisos de administrador.", "error"); return auth.signOut(); }
  } catch (e) {
    if (e && e.code === "PERMISSION_DENIED") { setMsg("msgLogin", "No se pudo verificar el permiso. ¿Publicaste las reglas nuevas?", "error"); return auth.signOut(); }
  }
  mostrar("app");
  initMapa();
  iniciarMonitoreo();
  registrarPushAdmin(user.uid);
  ActivaSiempre.activar(false);
  Policia.iniciar({ db, mapa: () => mapa, uid: () => auth.currentUser && auth.currentUser.uid, nombre: () => "Brothers (admin)", rol: "admin", pos: () => null });
  setTimeout(() => { if (!encuadrePedidosHecho) encuadrarTodosActivos(); }, 1500);
});
$("btnSalir").onclick = async () => { if (!confirm("¿Cerrar sesión?")) return; await quitarPushAdmin(); auth.signOut(); };

const adminEsNativo = () => { const C = window.Capacitor; return !!(C && ((C.isNativePlatform && C.isNativePlatform()) || (C.getPlatform && C.getPlatform() !== "web"))); };
function adminPlug(nombre) {
  const C = window.Capacitor;
  if (!adminEsNativo()) return null;
  if (C.isPluginAvailable && !C.isPluginAvailable(nombre)) return null;
  return (C.Plugins && C.Plugins[nombre]) || (C.registerPlugin && C.registerPlugin(nombre)) || null;
}
let adminPushUid = null, adminPushClave = null;
const claveDeToken = (t) => String(t || "").replace(/[.#$\[\]\/]/g, "_").slice(-40);
function irAPestana(id) { const b = document.querySelector('.tabs button[data-tab="' + id + '"]'); if (b) b.click(); }
async function registrarPushAdmin(uid) {
  const PN = adminPlug("PushNotifications");
  if (!PN && uid && !adminEsNativo() && typeof PushWeb !== "undefined") { PushWeb.registrar(uid); return; }   // FASE 2 (push): navegador/PWA → FCM web
  if (!PN || !uid) return;
  adminPushUid = uid;
  try {
    let p = await PN.checkPermissions();
    if (p.receive !== "granted") p = await PN.requestPermissions();
    if (p.receive !== "granted") { toast("Activa las notificaciones de la app en Ajustes para recibir los avisos de tus repartidores."); return; }
    await PN.createChannel({ id: "admin", name: "Avisos de Brothers", description: "Mensajes de repartidores y clientes que abren su enlace", importance: 5, visibility: 1, vibration: true, lights: true });
    await PN.removeAllListeners();
    PN.addListener("registration", (t) => {
      const u = adminPushUid; if (!u || !t || !t.value) return;
      adminPushClave = claveDeToken(t.value);
      db.ref("admin_tokens/" + u + "/" + adminPushClave).set({ token: t.value, ts: firebase.database.ServerValue.TIMESTAMP, plataforma: "android" })
        .catch((e) => console.warn("admin_tokens:", e.message));
    });
    PN.addListener("registrationError", (e) => console.warn("Push admin:", e));
    PN.addListener("pushNotificationReceived", (n) => {
      const d = (n && n.data) || {};
      if (d.tipo === "cliente_abrio") { try { Voz.hablar("El cliente " + (d.pedido ? "del pedido " + d.pedido + " " : "") + "abrió su enlace", { forzar: true }); } catch (_) {} }
    });
    PN.addListener("pushNotificationActionPerformed", (ev) => {
      const d = (ev && ev.notification && ev.notification.data) || {};
      if (String(d.tipo || "").indexOf("sol_") === 0) { irAPestana("panelSolicitudes"); return; }
      if (d.tipo === "chat_repartidor") {
        irAPestana("panelChats");
        if (d.equipo === "1" && d.uid && typeof abrirChatRep === "function") setTimeout(() => { try { abrirChatRep(d.uid); } catch (_) {} }, 300);
      } else irAPestana("panelMapa");
    });
    await PN.register();
  } catch (e) { console.warn("Push admin:", e); }
}
/* ============================================================
   PERMISO DE CÁMARA EN EL CHAT
   Al tocar la cámara (o un selector de imagen) dentro de un chat, si el permiso no está dado se pide primero.
   ============================================================ */
const PermisosCamara = (() => {
  let concedida = false, pidiendo = null;
  const gumOriginal = (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices) : null;
  async function estado() {
    try { const P = adminPlug("Camera"); if (P && P.checkPermissions) return (await P.checkPermissions()).camera; } catch (_) {}
    try { if (navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({ name: "camera" })).state; } catch (_) {}
    return "prompt";
  }
  function pedir() {
    if (concedida) return Promise.resolve(true);
    if (pidiendo) return pidiendo;
    pidiendo = (async () => {
      try {
        const e = await estado();
        if (e === "granted" || e === "limited") { concedida = true; return true; }
        const P = adminPlug("Camera");
        if (P && P.requestPermissions) {
          const r = await P.requestPermissions({ permissions: ["camera"] });
          if (r.camera === "granted" || r.camera === "limited") { concedida = true; toast("📷 Cámara activada."); return true; }
          toast("📷 Sin permiso de cámara. Actívalo en Ajustes › Aplicaciones › Brother’s Deliverys › Permisos."); return false;
        }
        if (gumOriginal) {
          const st = await gumOriginal({ video: true });
          st.getTracks().forEach((t) => t.stop());
          concedida = true; toast("📷 Cámara activada."); return true;
        }
        return true;   // sin API de permisos: el sistema lo pedirá al abrir la cámara
      } catch (_) {
        toast("📷 Sin permiso de cámara. Actívalo en Ajustes › Aplicaciones › Brother’s Deliverys › Permisos.");
        return false;
      } finally { pidiendo = null; }
    })();
    return pidiendo;
  }
  // Selectores de imagen / cámara dentro de un chat
  document.addEventListener("click", (e) => {
    const inp = e.target && e.target.closest && e.target.closest('input[type="file"]');
    if (!inp || inp.dataset.permOk || concedida) return;
    const enChat = inp.hasAttribute("capture") || inp.closest('[id*="chat" i], [class*="chat" i]');
    if (!enChat || !/image|\*\/\*|^$/.test(inp.getAttribute("accept") || "")) return;
    e.preventDefault(); e.stopImmediatePropagation();
    pedir().then((ok) => { if (ok) { inp.dataset.permOk = "1"; try { inp.click(); } catch (_) {} setTimeout(() => { delete inp.dataset.permOk; }, 1500); } });
  }, true);
  // Cámara abierta por código (getUserMedia) dentro de la app
  if (gumOriginal) {
    navigator.mediaDevices.getUserMedia = async (c) => { if (c && c.video && !concedida) await pedir(); return gumOriginal(c); };
  }
  return { pedir };
})();

/* ============================================================
   MANTENER LA APP ACTIVA (no dormirse)
   Recibir avisos con ahorro de batería, pantalla apagada o en segundo plano:
   activa el servicio en segundo plano y pide excluir la app del ahorro de batería.
   Requiere un plugin nativo de modo en segundo plano (BackgroundMode) instalado en la app Android.
   ============================================================ */
const ActivaSiempre = (() => {
  const CLAVE_PEDIDA = "admin_bateria_pedida";
  async function activar(manual) {
    if (!adminEsNativo()) { if (manual) toast("Esta opción solo funciona en la app instalada en el celular."); return false; }
    const BM = adminPlug("BackgroundMode");
    if (!BM) { if (manual) toast("Esta versión de la app no trae el modo de segundo plano. Instala la versión nueva."); return false; }
    const cfg = { title: "Brother’s Deliverys", text: "Recibiendo pedidos y mensajes", silent: false, hidden: false, resume: true };
    try { if (BM.requestNotificationsPermission) await BM.requestNotificationsPermission(); } catch (_) {}
    try { if (BM.requestForegroundPermission) await BM.requestForegroundPermission(); } catch (_) {}
    try { if (BM.setSettings) await BM.setSettings(cfg); } catch (_) {}
    try { if (BM.enable) await BM.enable(cfg); } catch (e) { console.warn("BackgroundMode.enable:", e); }
    try { if (BM.disableWebViewOptimizations) await BM.disableWebViewOptimizations(); } catch (_) {}
    // Exención del ahorro de batería (el plugin trae un nombre u otro según su versión)
    const pedirExencion = BM.requestDisableBatteryOptimizations || BM.disableBatteryOptimizations;
    let pidio = false, yaExenta = false;
    try {
      if (BM.checkBatteryOptimizations) yaExenta = !!(await BM.checkBatteryOptimizations()).disabled;
      else if (BM.isIgnoringBatteryOptimizations) yaExenta = !!(await BM.isIgnoringBatteryOptimizations()).isIgnoring;
    } catch (_) {}
    try {
      if (!yaExenta && pedirExencion && (manual || !localStorage.getItem(CLAVE_PEDIDA))) {
        await pedirExencion.call(BM); pidio = true;
        try { localStorage.setItem(CLAVE_PEDIDA, "1"); } catch (_) {}
      }
    } catch (e) { console.warn("Exención de batería:", e); }
    if (manual) toast(yaExenta ? "🔋 Todo listo: la app ya no entra en ahorro de batería." : pidio ? "🔋 Acepta la ventana del sistema para que la app no se duerma." : "🔋 Modo activo: la app sigue funcionando en segundo plano.");
    return true;
  }
  return { activar };
})();
$("btnActiva").onclick = () => ActivaSiempre.activar(true);

async function quitarPushAdmin() {
  try { if (adminPushUid && adminPushClave) await db.ref("admin_tokens/" + adminPushUid + "/" + adminPushClave).remove(); } catch (_) {}
  adminPushUid = null; adminPushClave = null;
}

function normalizarTelefono(t) {
  let d = String(t == null ? "" : t).replace(/\D+/g, "");
  if (d.indexOf("00") === 0) d = d.slice(2);
  if (d.length === 8) d = "505" + d;
  return d.length >= 10 && d.length <= 15 ? d : "";
}

function initMapa() {
  if (!mapa) {
    mapa = L.map("mapaAdmin", Object.assign({}, GestosMapa.opciones, { rotate: true, touchRotate: true, bearing: 0 })).setView([12.5700, -87.1311], 13);
    mapa.createPane("paneNegocios").style.zIndex = 590;   // los negocios siempre quedan DEBAJO de los repartidores (markerPane = 600)
    L.control.zoom({ position: "bottomright", zoomInTitle: "Acercar", zoomOutTitle: "Alejar" }).addTo(mapa);
    GestosMapa.aplicar(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(mapa);
  }
  iniciarPopups();
  mapa.on("click movestart", () => { $("resBusq").classList.add("oculto"); $("busq").blur(); });
  mapa.on("click", (e) => {
    if (Policia.clickMapa(e.latlng)) return;
    if (modoNegocio) { terminarModoNegocio(); return formNegocio({ lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }); }
    if (selUid) return fijarGuia(selUid, e.latlng);
    if (typeof PedidosAdmin !== "undefined") PedidosAdmin.clickMapa(e.latlng);
  });
  mapa.on("zoomend", () => mapa.getContainer().classList.toggle("zoom-lejos", mapa.getZoom() < 15));
  mapa.on("moveend zoomend", programarSyncNegocios);
  mapa.getContainer().classList.add("zoom-lejos");
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
  /* FASE 3 · badge "Con Pedido" en la esquina del ícono cuando hay viaje activo */
  const conPedido = est === "enRuta";
  const badge = conPedido ? '<span class="badge-pedido" aria-label="Con pedido activo">🛵</span>' : "";
  return L.divIcon({
    className: "",
    html: `<div class="marca-rider-caja"><div class="marca-rider${apagado ? " apagado" : ""}">${RIDER_SVG}<i class="pt-est" style="background:${col}"></i></div>${badge}` +
          `<span class="etiqueta-rider">${esc(nombre)}<small class="est" style="color:${col}">● ${txt}</small></span></div>`,
    iconSize: [56, 56], iconAnchor: [28, 28]
  });
}
function pintarMarcador(uid) {
  const u = ubic[uid];
  if (!u || typeof u.lat !== "number") return;
  if (typeof PedidosAdmin !== "undefined" && PedidosAdmin.invCerrado(uid)) { quitarMarcador(uid); pintarGuia(uid); PedidosAdmin.recorridoInv(uid); return; }
  if (ocultos.has(uid)) { quitarMarcador(uid); pintarGuia(uid); return; }
  const est = estadoDe(uid), nombre = nombreUid(uid);
  const clave = nombre + "|" + est, pos = [u.lat, u.lng];
  if (!marcadores[uid]) {
    marcadores[uid] = L.marker(pos, { icon: iconoRepAdmin(nombre, est), zIndexOffset: 1000 }).addTo(mapa);
    marcadores[uid]._clave = clave;
    marcadores[uid].bindPopup(() => popupRep(uid), { offset: [0, -22], minWidth: 210 });
    if (!ajusteProgramado) { ajusteProgramado = true; setTimeout(ajustarVista, 800); }
  } else {
    marcadores[uid].setLatLng(pos);
    if (marcadores[uid]._clave !== clave) { marcadores[uid].setIcon(iconoRepAdmin(nombre, est)); marcadores[uid]._clave = clave; }
  }
  const el = marcadores[uid].getElement();
  if (el) el.classList.toggle("sel-rep", uid === selUid);
  pintarGuia(uid);
  pintarGuiasSolicitud(uid);
  if (typeof PedidosAdmin !== "undefined") PedidosAdmin.recorridoInv(uid);
  pintarBannerAdmin();
}

let verNegocios = localStorage.getItem("verNegocios") !== "0";
let escalaRep = parseFloat(localStorage.getItem("escalaRep")) || 1;
function aplicarHerramientas() {
  if (!mapa) return;
  mapa.getContainer().style.setProperty("--escala-rep", escalaRep);
  $("btnVerNegocios").classList.toggle("on", verNegocios);
  /* FASE 3 · toggle de rutas */
  const br = $("btnRutas");
  if (br) { br.classList.toggle("on", verRutas); br.setAttribute("aria-pressed", String(verRutas)); }
  sincronizarNegocios();
}
$("btnVerNegocios").onclick = () => { verNegocios = !verNegocios; localStorage.setItem("verNegocios", verNegocios ? "1" : "0"); aplicarHerramientas(); toast(verNegocios ? "Negocios visibles" : "Negocios ocultos"); };
const cambiarEscala = (d) => { escalaRep = Math.max(.5, Math.min(2, +(escalaRep + d).toFixed(1))); localStorage.setItem("escalaRep", escalaRep); aplicarHerramientas(); toast("Tamaño de iconos: " + Math.round(escalaRep * 100) + " %"); };
$("btnIconoMas").onclick = () => cambiarEscala(.2);
$("btnIconoMenos").onclick = () => cambiarEscala(-.2);

/* ============================================================
   FASE 3 · RUTAS DE REPARTIDORES EN EL MAPA DEL ADMIN
   Por cada repartidor con viaje activo se dibuja una polyline punteada
   animada (clase .ruta-viva) desde su posición hasta el destino del pedido.
   ============================================================ */
function pintarRutas() {
  if (!mapa) return;
  // Quitar las rutas de repartidores que ya no están en viaje o si está desactivado
  Object.keys(capaRutas).forEach((uid) => {
    if (!verRutas || !viajeDe(uid)) {
      try { mapa.removeLayer(capaRutas[uid]); } catch (_) {}
      delete capaRutas[uid];
    }
  });
  if (!verRutas) return;
  // Dibujar/actualizar rutas
  Object.entries(activos).forEach(([, d]) => {
    if (!d || d.estado !== "en_ruta") return;
    const uid = d.repartidorUid;
    if (!uid || !ubic[uid] || typeof ubic[uid].lat !== "number") return;
    if (typeof d.destLat !== "number" || typeof d.destLng !== "number") return;
    const desde = [ubic[uid].lat, ubic[uid].lng];
    const hasta = [d.destLat, d.destLng];
    const color = colorUid(uid);
    if (capaRutas[uid]) {
      capaRutas[uid].setLatLngs([desde, hasta]);
      capaRutas[uid].setStyle({ color });
    } else {
      capaRutas[uid] = L.polyline([desde, hasta], {
        color, weight: 5, opacity: .8, dashArray: "10 14", lineCap: "round", className: "ruta-admin"
      }).addTo(mapa);
    }
  });
}

/* ============================================================
   FASE 3 · ALERTAS VISUALES DE SOLICITUDES EN EL MAPA DEL ADMIN
   Pin pulsante rojo con el nombre del cliente para cada solicitud pendiente.
   ============================================================ */
function puntoSolicitud(s) {
  if (!s) return null;
  const g = s.clienteGps;
  if (g && typeof g.lat === "number" && typeof g.lng === "number") return { lat: g.lat, lng: g.lng };
  const p = s.pedido && s.pedido.destino;
  if (p && typeof p.lat === "number" && typeof p.lng === "number") return { lat: p.lat, lng: p.lng };
  return null;
}
function iconoSolAdmin(nombre) {
  return L.divIcon({
    className: "",
    html: `<div class="pin-solicitud-admin"><span>📥</span></div><span class="etq-solicitud-admin">${esc(nombre || "Cliente")}</span>`,
    iconSize: [44, 44], iconAnchor: [22, 22]
  });
}
/* Solicitud pendiente: pin rojo pulsante. Solicitud TOMADA: pin con el nombre de quien la tomó + línea guía por calles hasta el cliente. */
const capasGuiaSol = {};   // id → { capa, origen, dest, ts, seq }
function iconoSolTomada(cliente, rep) {
  return L.divIcon({
    className: "",
    html: `<div class="pin-solicitud-admin tomada"><span>🛵</span></div><span class="etq-solicitud-admin tomada">${esc(rep)} → ${esc(cliente || "Cliente")}</span>`,
    iconSize: [44, 44], iconAnchor: [22, 22]
  });
}
function popupSolTomada(s) {
  const p = s.pedido || {}, rep = s.repartidorNombre || nombreUid(s.repartidorUid);
  return `<div class="pop-rep"><strong>🛵 ${esc(rep)} tomó el pedido</strong><small>👤 Cliente: ${esc(s.nombre || "Cliente")}</small>` +
    (p.quiere ? `<small>🛍️ ${esc(p.quiere)}${p.origen ? " · de " + esc(p.origen) : ""}</small>` : "") +
    `<small>Estado: ${esc(s.estado || "atendido")}</small></div>`;
}
function quitarGuiaSol(id) {
  const c = capasGuiaSol[id]; if (!c) return;
  c.seq++; try { mapa.removeLayer(c.capa); } catch (_) {}
  delete capasGuiaSol[id];
}
async function actualizarGuiaSol(id, s) {
  const p = puntoSolicitud(s), u = s && ubic[s.repartidorUid];
  if (!mapa || !p || !u || typeof u.lat !== "number") return quitarGuiaSol(id);
  let c = capasGuiaSol[id];
  if (!c) c = capasGuiaSol[id] = { capa: L.layerGroup().addTo(mapa), origen: null, dest: null, ts: 0, seq: 0, pts: null };
  const movido = !c.origen || Ruta.dist([u.lat, u.lng], c.origen) > 80, cambioDest = !c.dest || Ruta.dist([p.lat, p.lng], c.dest) > 10;
  if (!cambioDest && !(movido && Date.now() - c.ts > 12000)) return;
  c.ts = Date.now(); c.origen = [u.lat, u.lng]; c.dest = [p.lat, p.lng];
  const seq = ++c.seq, color = colorUid(s.repartidorUid);
  let r = null;
  try { r = await Ordenes.rutaCalles({ lat: u.lat, lng: u.lng }, { lat: p.lat, lng: p.lng }); } catch (_) {}
  if (capasGuiaSol[id] !== c || c.seq !== seq) return;
  const linea = r && r.pts ? [[u.lat, u.lng], ...r.pts, [p.lat, p.lng]] : [[u.lat, u.lng], [p.lat, p.lng]];
  c.capa.clearLayers();
  L.polyline(linea, { color: "#fff", weight: 10, opacity: .9, interactive: false }).addTo(c.capa);
  L.polyline(linea, { color, weight: 6, opacity: r ? .95 : .6, dashArray: r ? null : "6 8", lineCap: "round", interactive: false }).addTo(c.capa);
}
function pintarGuiasSolicitud(uid) {
  Object.entries(solicitudesMapa).forEach(([id, s]) => { if (s && s.repartidorUid === uid && solActivaDe(uid) && solActivaDe(uid)[0] === id) actualizarGuiaSol(id, s); });
}
function pintarSolicitudesMapa() {
  if (!mapa) return;
  const activas = new Set(), tomadas = new Set();
  Object.entries(solicitudesMapa).forEach(([id, s]) => {
    if (!s) return;
    const tomada = !!s.repartidorUid;
    if (tomada ? ["nuevo", "entregado", "cancelado"].includes(s.estado || "nuevo") : (s.estado && s.estado !== "nuevo")) return;   // ya no está pendiente ni en curso
    const p = puntoSolicitud(s);
    if (!p) return;
    activas.add(id); if (tomada) tomadas.add(id);
    const rep = tomada ? (s.repartidorNombre || nombreUid(s.repartidorUid)) : "";
    const clave = (tomada ? "t|" + rep + "|" : "n|") + (s.nombre || "");
    let mk = marcasSolicitud[id];
    if (!mk) {
      mk = marcasSolicitud[id] = L.marker([p.lat, p.lng], { icon: tomada ? iconoSolTomada(s.nombre, rep) : iconoSolAdmin(s.nombre), zIndexOffset: 2000 }).addTo(mapa);
      mk._clave = clave;
    } else {
      mk.setLatLng([p.lat, p.lng]);
      if (mk._clave !== clave) { mk.setIcon(tomada ? iconoSolTomada(s.nombre, rep) : iconoSolAdmin(s.nombre)); mk._clave = clave; }
    }
    mk.off("click");
    if (tomada) { mk.bindPopup(() => popupSolTomada(solicitudesMapa[id] || s), { offset: [0, -14], autoPanPaddingTopLeft: [16, 110], autoPanPaddingBottomRight: [90, 110] }); }
    else { mk.unbindPopup(); mk.on("click", () => { try { irAPestana("panelSolicitudes"); } catch (_) {} }); }
    if (tomada && solActivaDe(s.repartidorUid) && solActivaDe(s.repartidorUid)[0] === id) actualizarGuiaSol(id, s); else quitarGuiaSol(id);
  });
  Object.keys(marcasSolicitud).forEach((id) => {
    if (!activas.has(id)) {
      try { mapa.removeLayer(marcasSolicitud[id]); } catch (_) {}
      delete marcasSolicitud[id];
    }
  });
  Object.keys(capasGuiaSol).forEach((id) => { if (!tomadas.has(id)) quitarGuiaSol(id); });
}
function iniciarSolicitudesMapa() {
  if (refSolicMapa) refSolicMapa.off();
  primeraSolMapa = true;
  refSolicMapa = db.ref("solicitudes_entrantes").limitToLast(60);
  refSolicMapa.on("value", (s) => {
    const antes = solicitudesMapa;
    solicitudesMapa = s.val() || {};
    pintarSolicitudesMapa();
    const uidsSol = new Set();
    [antes, solicitudesMapa].forEach((o) => Object.values(o).forEach((x) => { if (x && x.repartidorUid) uidsSol.add(x.repartidorUid); }));
    uidsSol.forEach((u) => { if (ubic[u]) pintarMarcador(u); });
    pintarLista();
    /* FASE 3 · Detectar nuevas solicitudes pendientes y hacer fitBounds si el admin está en el mapa */
    if (!primeraSolMapa) {
      const nuevas = Object.keys(solicitudesMapa).filter((id) => {
        const n = solicitudesMapa[id], a = antes[id];
        const esNueva = n && !n.repartidorUid && (!n.estado || n.estado === "nuevo");
        const eraNueva = a && !a.repartidorUid && (!a.estado || a.estado === "nuevo");
        return esNueva && !eraNueva;
      });
      if (nuevas.length) {
        const enMapa = document.querySelector('.tabs button[data-tab="panelMapa"]').classList.contains("activa");
        if (enMapa) setTimeout(() => encuadrarTodosActivos(), 400);
      }
    }
    primeraSolMapa = false;
    pintarRutas();
  }, () => {});
}

function popupRep(uid) {
  const est = estadoDe(uid), [texto, clase] = ETIQUETA[est], n = sinLeerEq[uid] || 0;
  if (typeof PedidosAdmin !== "undefined" && Ordenes.esInvitadoUid(uid)) {
    return `<div class="pop-rep"><strong>${esc(nombreUid(uid))} <i class="pd-tag">Invitado</i></strong>
    <span class="chip ${clase}">${texto}</span>
    <small>${esc(descripcion(uid, est))}${guias[uid] ? " · 📍 guía activa" : ""}${esc(PedidosAdmin.notaRep(uid))}</small>
    <div class="acciones-fila">
      <button class="mini pri" data-pa="invent" data-uid="${esc(uid)}" type="button">✅ Pedido entregado</button>
      <button class="mini pri" data-pa="invfact" data-uid="${esc(uid)}" type="button">🧾 Ver factura</button>
      <button class="mini" data-pa="invrec" data-uid="${esc(uid)}" type="button">🗺 Ver recorrido</button>
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

/* FASE 4 · Ícono del pedido en el mapa del admin: pin discreto (24 px) con etiqueta al costado */
function iconoClienteAdmin(uid, token, d) {
  const col = colorUid(uid || token);
  const vivo = d && d.cliente && !d.cliente.manual && d.cliente.ts && Date.now() - d.cliente.ts < 60000;
  const nombre = (d && d.pedido) ? String(d.pedido) : "";
  return L.divIcon({
    className: "",
    html: `<div class="pin-cli-admin${vivo ? " vivo" : ""}${d && d.cliente && d.cliente.manual ? " manual" : ""}" style="--pin-cli-c:${col}"></div>` +
          `<span class="etq-cli-admin"><b>${esc(nombre || "Pedido")}</b>${d && d.repartidorNombre ? " · " + esc(cortar(d.repartidorNombre, 14)) : ""}</span>`,
    iconSize: [24, 24], iconAnchor: [12, 12]
  });
}
const cortar = (s, n) => String(s == null ? "" : s).slice(0, n);

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
    const bu = el.querySelector("button[data-uid]"); if (bu) { focoUid = bu.dataset.uid; pintarBannerAdmin(); }
    el.querySelectorAll("button[data-pa]").forEach((b) => {
      b.onclick = () => {
        const uid = b.dataset.uid, a = b.dataset.pa;
        mapa.closePopup();
        if (a === "guiar") { selUid = uid; pintarSeleccion(); }
        else if (a === "chat") { if (Ordenes.esInvitadoUid(uid) && typeof PedidosAdmin !== "undefined") PedidosAdmin.chatInvitado(uid); else abrirChatRep(uid); }
        else if (a === "invfact") PedidosAdmin.abrirFacturaUid(uid);
        else if (a === "invrec") PedidosAdmin.verRecorrido(uid);
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
    if (typeof PedidosAdmin !== "undefined") PedidosAdmin.cerrarInvitado(token, d.repartidorUid);
    toast(`Pedido ${d.pedido || ""} marcado como entregado ✓`);
  } catch (e) { toast("No se pudo marcar: " + e.message); }
}

let refStats = null, facturasHoy = 0;
/* El conteo de facturas de hoy alimenta el contador del mapa (🧾). La sección "Facturas del día" del panel Equipo ya no existe. */
function cargarStats() {
  if (refStats) refStats.off();
  const dia = Dia.clave();
  refStats = db.ref("estadisticas/" + dia);
  refStats.on("value", (s) => pintarStats(s.val() || {}), () => {});
}
function pintarStats(d) {
  facturasHoy = Object.values(d).reduce((n, x) => n + ((x && Number(x.facturas)) || 0), 0);
  pintarLista();
}

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

function terminarModoNegocio() { modoNegocio = false; $("btnNegocio").classList.remove("activo"); if (mapa) mapa.getContainer().classList.remove("modo-guia", "modo-registro"); }
$("btnNegocio").onclick = () => {
  if (modoNegocio) { terminarModoNegocio(); return toast("Cancelado."); }
  modoNegocio = true; selUid = null; pintarSeleccion(); pintarLista();
  $("btnNegocio").classList.add("activo"); mapa.closePopup(); mapa.getContainer().classList.add("modo-guia", "modo-registro");
  toast("Toca el mapa donde está el negocio (o búscalo y usa “Guardar como negocio”).");
};
/* FASE 3 · La gestión de negocios se hace solo desde el mapa (botón ➕ Agregar). */

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
/* Ícono de negocio: círculo pequeño anclado exactamente en su coordenada, solo el ícono (sin nombre). */
function iconoNegocio(l) {
  return L.divIcon({
    className: "neg-ico",
    html: '<span class="neg-pin">' + esc(l.icono || "📍") + "</span>",
    iconSize: [20, 20], iconAnchor: [10, 10]
  });
}
/* Optimización: los negocios se dibujan en UNA capa y solo los que caen dentro de la pantalla (más un margen);
   con el mapa muy alejado no se dibujan. Mover el mapa o activar la vista ya no crea cientos de íconos a la vez. */
const capaNegocios = L.layerGroup();
const ZOOM_MIN_NEGOCIOS = 14;
let tSyncNeg = null;
function sincronizarNegocios() {
  if (!mapa) return;
  const visible = verNegocios && mapa.getZoom() >= ZOOM_MIN_NEGOCIOS;
  if (!visible) {
    if (mapa.hasLayer(capaNegocios)) { capaNegocios.eachLayer((m) => { if (!m.isPopupOpen || !m.isPopupOpen()) capaNegocios.removeLayer(m); }); }
    if (mapa.hasLayer(capaNegocios) && !capaNegocios.getLayers().length) mapa.removeLayer(capaNegocios);
    return;
  }
  if (!mapa.hasLayer(capaNegocios)) capaNegocios.addTo(mapa);
  const b = mapa.getBounds().pad(0.35);
  Object.values(lugarMarks).forEach((m) => {
    const dentro = b.contains(m.getLatLng());
    const puesto = capaNegocios.hasLayer(m);
    if (dentro && !puesto) capaNegocios.addLayer(m);
    else if (!dentro && puesto && !(m.isPopupOpen && m.isPopupOpen())) capaNegocios.removeLayer(m);
  });
}
function programarSyncNegocios() { clearTimeout(tSyncNeg); tSyncNeg = setTimeout(sincronizarNegocios, 140); }
let tPintarLug = null;
function pintarLugares() { clearTimeout(tPintarLug); tPintarLug = setTimeout(pintarLugaresYa, 120); }
function pintarLugaresYa() {
  if (!mapa) return;
  Object.keys(lugarMarks).forEach((id) => { if (!lugares[id]) { capaNegocios.removeLayer(lugarMarks[id]); delete lugarMarks[id]; } });
  Object.entries(lugares).forEach(([id, l]) => {
    if (typeof l.lat !== "number" || typeof l.lng !== "number") return;
    const clave = [l.nombre, l.icono].join("|");
    let m = lugarMarks[id];
    if (!m) {
      m = lugarMarks[id] = L.marker([l.lat, l.lng], { icon: iconoNegocio(l), pane: "paneNegocios", keyboard: false, riseOnHover: false });
      m._clave = clave;
      m.bindPopup(() => popupLugar(id), { offset: [0, -10], minWidth: 230, autoPanPaddingTopLeft: [16, 110], autoPanPaddingBottomRight: [90, 110] });
    } else {
      m.setLatLng([l.lat, l.lng]);
      if (m._clave !== clave) { m.setIcon(iconoNegocio(l)); m._clave = clave; }
    }
  });
  sincronizarNegocios();
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
/* FASE 4 · Clientes en el mapa del admin con ícono discreto (24 px) */
const clientesM = {};
function pintarClientes() {
  if (!mapa) return;
  const vistos = new Set();
  Object.entries(activos).forEach(([token, d]) => {
    const c = d.cliente;
    if (!c || typeof c.lat !== "number" || ocultos.has(d.repartidorUid)) return;
    vistos.add(token);
    const uid = d.repartidorUid, clave = [uid, d.pedido, c.lat, c.lng, !!c.manual].join("|");
    let m = clientesM[token];
    if (!m) {
      m = clientesM[token] = {
        pin: L.marker([c.lat, c.lng], { icon: iconoClienteAdmin(uid, token, d), zIndexOffset: 200 }).addTo(mapa),
        clave
      };
      m.pin.bindPopup(() => popupCliente(token), { offset: [0, -14], minWidth: 220 });
    } else {
      m.pin.setLatLng([c.lat, c.lng]);
      if (m.clave !== clave) { m.pin.setIcon(iconoClienteAdmin(uid, token, d)); m.clave = clave; }
    }
  });
  Object.keys(clientesM).forEach((t) => {
    if (!vistos.has(t)) { mapa.removeLayer(clientesM[t].pin); delete clientesM[t]; }
  });
}

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
  c.linea.setLatLngs(c.pts ? [[u.lat, u.lng], ...c.pts] : []);
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
      c.calles = Ordenes.callesDe(r.pasos);
      pintarBannerAdmin();
      c.pin.setIcon(icono()); c.clave = [nom, col, g.icono, g.nombre, c.calles].join("|");
      if (c.calles) c.linea.bindTooltip("Vía: " + c.calles, { sticky: true });
    }).catch(() => {
      if (!guiaCapas[uid]) return;
      c.rutaFallo = true; c.rutaEn = Date.now() - 18000; pintarBannerAdmin();
      clearTimeout(c._rt); c._rt = setTimeout(() => pintarGuia(uid), 3000);
    });
  }
}
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
    while (c.idx < c.pasos.length - 1 && Ordenes.distM(aqui, c.pasos[c.idx].loc) < 30) c.idx++;
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
  sel.classList.toggle("oculto", vs.length < 2);
  $("btnGuiaQuitar").classList.toggle("oculto", !guias[selUid]);
}
async function fijarGuia(uid, ll, tokenForzado, extra) {
  const dato = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), ts: firebase.database.ServerValue.TIMESTAMP, por: "admin" };
  const tk = tokenForzado || (extra ? "" : $("guiaPedido").value); if (tk) dato.token = tk;
  if (extra) Object.assign(dato, extra);
  try { await db.ref("guias/" + uid).set(dato); if (typeof PushAdmin !== "undefined" && !Ordenes.esInvitadoUid(uid)) PushAdmin.guia(uid, extra && extra.nombre ? extra.nombre : "");
    if (Ordenes.esInvitadoUid(uid)) db.ref("ordenes/" + PedidosAdmin.tokenInv(uid) + "/guiaAdmin").set(dato).catch(() => {}); toast(`Guía enviada a ${nombreUid(uid)} ✓ Solo la ve él.`); }
  catch (e) { return toast("No se pudo enviar la guía: " + e.message); }
  selUid = null; pintarSeleccion(); pintarLista();
}
$("btnGuiaCancelar").onclick = () => { selUid = null; pintarSeleccion(); pintarLista(); };
$("btnGuiaQuitar").onclick = () => { if (selUid) db.ref("guias/" + selUid).remove().then(() => toast("Guía quitada.")).catch((e) => toast(e.message)); };
$("btnGuiaChat").onclick = () => { if (selUid) abrirChatRep(selUid); };

function abrirChatRep(uid) {
  chatEqAbierto = uid; sinLeerEq[uid] = 0; pintarLista(); pintarChats();
  Chat.iniciar({
    token: uid, yo: "admin", ruta: RUTA_EQ, pedido: "Equipo", nombreRepartidor: nombreUid(uid), puedeBorrar: true, avisos: false,
    titulo: () => "Chat con " + nombreUid(uid),
    subtitulo: () => "Equipo · Brothers ↔ repartidor",
    alEnviar: (m) => { if (typeof PushAdmin !== "undefined") PushAdmin.mensaje(uid, m); },
    alCerrar: () => { chatEqAbierto = null; if (typeof ChatMessenger !== "undefined") ChatMessenger.limpiar(); }
  });
  if (typeof ChatMessenger !== "undefined") ChatMessenger.set({ uid, nombre: nombreUid(uid) });
  Chat.abrir();
}
function quitarMarcador(uid) { if (marcadores[uid]) { mapa.removeLayer(marcadores[uid]); delete marcadores[uid]; } }

function iniciarMonitoreo() {
  detener();
  const fallo = () => setMsg("msgEquipo", "Sin permiso para leer datos. Revisa las reglas y tu registro en 'admins'.", "error");

  refUbic = db.ref("ubicaciones");
  refUbic.on("child_added", (s) => { ubic[s.key] = s.val(); pintarMarcador(s.key); pintarClientes(); pintarLista(); pintarRutas(); }, fallo);
  refUbic.on("child_changed", (s) => { ubic[s.key] = s.val(); pintarMarcador(s.key); pintarClientes(); pintarLista(); pintarRutas(); });
  refUbic.on("child_removed", (s) => { delete ubic[s.key]; quitarMarcador(s.key); pintarLista(); pintarRutas(); });

  cargarStats(); cargarCalif();

  refLugares = db.ref("lugares");
  refLugares.on("value", (s) => { lugares = s.val() || {}; pintarLugares(); }, fallo);

  refGuias = db.ref("guias");
  const guiaOk = (s) => { guias[s.key] = s.val(); pintarGuia(s.key); pintarBannerAdmin(); pintarLista(); if (s.key === selUid) pintarSeleccion(); };
  refGuias.on("child_added", guiaOk, fallo);
  refGuias.on("child_changed", guiaOk);
  refGuias.on("child_removed", (s) => { delete guias[s.key]; pintarGuia(s.key); pintarBannerAdmin(); pintarLista(); if (s.key === selUid) pintarSeleccion(); });

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

  if (typeof PedidosAdmin !== "undefined") PedidosAdmin.iniciar();

  consultaActivos = db.ref("pedidos").orderByChild("estado").equalTo("en_ruta");
  const alCambiar = (s) => { activos[s.key] = s.val(); pintarClientes(); refrescar(); pintarRutas(); };
  consultaActivos.on("child_added", alCambiar, fallo);
  consultaActivos.on("child_changed", alCambiar);
  consultaActivos.on("child_removed", (s) => { delete activos[s.key]; pintarClientes(); refrescar(); pintarRutas(); });

  db.ref("repartidores").on("value", (s) => { registrados = s.val() || {}; refrescar(); pintarEquipo(); pintarChats(); if (refStats) cargarStats(); }, fallo);

  db.ref("repartidorFotos").on("value", (s) => {
    fotosCache = s.val() || {};
    aplicarFotosAvatares();
  }, () => { fotosCache = {}; aplicarFotosAvatares(); });

  consultaChats = db.ref("chatsResumen").orderByChild("ts").limitToLast(50);
  let primeraCargaChats = true;
  consultaChats.on("value", (s) => {
    const nuevos = s.val() || {};
    if (!primeraCargaChats) {
      Object.entries(nuevos).forEach(([t, r]) => {
        if ((r.ts || 0) <= ((resumenes[t] && resumenes[t].ts) || 0)) return;
        if (r.ultimoDe === "repartidor") Voz.hablar(Voz.repartidorEscribio(r.repartidor || ""));
        else if (r.ultimoDe === "cliente") Voz.hablar(Voz.clienteEscribio(nombreCliente(t, r)));
      });
    }
    primeraCargaChats = false;
    resumenes = nuevos; pintarChats();
  }, fallo);

  /* FASE 3 · Suscripción a solicitudes_entrantes para pintar pines pulsantes + rutas */
  iniciarSolicitudesMapa();
  pintarRutas();
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
  clearTimeout(tPintarLug); clearTimeout(tSyncNeg);
  capaNegocios.clearLayers(); Object.keys(lugarMarks).forEach((id) => { delete lugarMarks[id]; });
  lugares = {};
  if (refEq) { refEq.off(); refEq = null; }
  Object.keys(guiaCapas).forEach((u) => { delete guias[u]; pintarGuia(u); });
  [guias, sinLeerEq].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  resEquipo = {}; selUid = null; selChats.clear(); modoSel = false;
  db.ref("repartidores").off();
  db.ref("repartidorFotos").off();
  Object.keys(marcadores).forEach(quitarMarcador);
  Object.keys(clientesM).forEach((t) => { mapa.removeLayer(clientesM[t].pin); delete clientesM[t]; });
  [ubic, activos].forEach((o) => Object.keys(o).forEach((k) => delete o[k]));
  registrados = {}; resumenes = {}; ajusteProgramado = false;
  encuadrePedidosHecho = false;
  /* FASE 3 · limpieza de rutas y pines de solicitudes */
  if (refSolicMapa) { refSolicMapa.off(); refSolicMapa = null; }
  Object.keys(marcasSolicitud).forEach((id) => { try { if (mapa) mapa.removeLayer(marcasSolicitud[id]); } catch (_) {} delete marcasSolicitud[id]; });
  solicitudesMapa = {}; primeraSolMapa = true;
  Object.keys(capaRutas).forEach((uid) => { try { if (mapa) mapa.removeLayer(capaRutas[uid]); } catch (_) {} delete capaRutas[uid]; });
}
function refrescar() { Object.keys(ubic).forEach(pintarMarcador); pintarClientes(); pintarLista(); pintarEquipo(); if (selUid) pintarSeleccion(); }
setInterval(() => { if (!$("vistaApp").classList.contains("oculto")) refrescar(); }, 15000);

function descripcion(uid, est) {
  const u = ubic[uid] || {}, v = viajeDe(uid);
  if (est === "enRuta") {
    const todos = viajesDe(uid);
    if (todos.length > 1) return `${todos.length} pedidos en ruta: ` + todos.map((x) => x.d.pedido || "—").join(", ");
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
  const enRuta = ids.filter((u) => estadoDe(u) === "enRuta").length;
  const enLinea = ids.filter((u) => ["enRuta", "libre"].includes(estadoDe(u))).length;
  $("contador").textContent = `${enRuta} en ruta · ${enLinea} en línea · ${facturasHoy} 🧾` + (ocultos.size ? ` · ${ocultos.size} 👁‍🗨 ocultos` : "");
  $("btnOcultar").querySelector("small").textContent = ocultos.size ? ocultos.size + " ocultos" : "Repartidores";
}

const RUTA_CL = { chats: "chats", resumen: "chatsResumen", fotos: "fotos" };
const fechaCorta = (ts) => (ts ? new Date(ts).toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "");
function conversaciones() {
  const eq = Object.keys(registrados).map((uid) => {
    const r = resEquipo[uid] || {};
    return { key: "eq:" + uid, uid, titulo: "👥 " + nombreUid(uid), ts: r.ts || 0, sinLeer: sinLeerEq[uid] || 0,
      sub: r.ultimo ? `${r.ultimoDe === "admin" ? "Tú" : nombreUid(uid)}: ${r.ultimo}` : "Sin mensajes todavía" };
  }).sort((a, b) => b.ts - a.ts || a.titulo.localeCompare(b.titulo));
  const cl = Object.entries(resumenes).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0)).map(([token, r]) => ({
    key: "cl:" + token, uid: r.repartidorUid || r.uid || "", titulo: `Pedido ${r.pedido || "—"} · ${r.repartidor || "Repartidor"}`, ts: r.ts || 0, sinLeer: 0,
    sub: `${r.ultimoDe === "cliente" ? "Cliente" : (r.repartidor || "Repartidor")}: ${r.ultimo || ""}` }));
  return { eq, cl };
}
function pintarChats() {
  const { eq, cl } = conversaciones();
  const tarjeta = (c) => `<div class="tarjeta-rep conv${selChats.has(c.key) ? " sel" : ""}" data-key="${esc(c.key)}" style="cursor:pointer"><div class="fila">
      ${modoSel ? `<input type="checkbox" class="chk" ${selChats.has(c.key) ? "checked" : ""} tabindex="-1" aria-label="Seleccionar">` : `<span class="avatar" data-av="${esc(c.uid || "")}">${RIDER_SVG}</span>`}
      <div class="datos"><strong>${esc(c.titulo)}${c.sinLeer ? ` <span class="badge">${c.sinLeer}</span>` : ""}</strong>
        <small>${esc(c.sub)}</small><small>${esc(fechaCorta(c.ts))}</small></div></div></div>`;
  $("listaChats").innerHTML =
    `<h3 class="sec">Equipo (chat con tus repartidores)</h3>` + (eq.length ? eq.map(tarjeta).join("") : '<p class="ayuda">Aún no hay repartidores.</p>') +
    `<h3 class="sec">Clientes (archivo de pedidos)</h3>` + (cl.length ? cl.map(tarjeta).join("") : '<p class="ayuda">Aún no hay conversaciones de clientes.</p>');
  aplicarFotosAvatares();
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
  if (typeof ChatMessenger !== "undefined") ChatMessenger.limpiar();
  Chat.iniciar({
    token: id, soloLectura: true, puedeBorrar: true, pedido: r.pedido, nombreRepartidor: r.repartidor,
    titulo: (c) => "Pedido " + (c.pedido || "—"),
    subtitulo: (c) => (c.nombreRepartidor ? "Repartidor: " + c.nombreRepartidor : "")
  });
  Chat.abrir();
};

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
    if (!p.restantes.length) upd[`${p.r.resumen}/${p.id}`] = null;
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

function pintarEquipo() {
  const ids = Object.keys(registrados);
  const invitados = typeof PedidosAdmin !== "undefined" ? PedidosAdmin.htmlInvitados() : "";
  if (!ids.length && !invitados) { $("listaEquipo").innerHTML = '<p class="ayuda">Aún no hay repartidores registrados.</p>'; return; }
  $("listaEquipo").innerHTML = ids.map((uid) => {
    const i = infoReg(uid), est = estadoDe(uid), [texto, clase] = ETIQUETA[est];
    return `<div class="tarjeta-rep">
      <div class="fila">
        <span class="avatar" data-av="${esc(uid)}">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(nombreUid(uid))}</strong>
          <small>${i.email ? esc(i.email) : "Sin correo registrado · " + esc(uid.slice(0, 8)) + "…"}</small>
          <small>📱 ${i.telefono ? "WhatsApp +" + esc(i.telefono) : "Sin WhatsApp guardado"}</small></div>
        <span class="chip ${clase}">${texto}</span>
      </div>
      <div class="acciones-fila">
        <button class="mini" data-foto-uid="${esc(uid)}" data-foto-nom="${esc(nombreUid(uid))}">📷 Foto</button>
        <button class="mini" data-accion="telefono" data-uid="${esc(uid)}">${i.telefono ? "Editar WhatsApp" : "Agregar WhatsApp"}</button>
        ${i.email ? `<button class="mini" data-accion="reset" data-uid="${esc(uid)}">Restablecer clave</button>` : ""}
        <button class="mini peligro" data-accion="quitar" data-uid="${esc(uid)}">Quitar</button>
      </div></div>`;
  }).join("") + (invitados ? '<h3 class="sec">Invitados activos</h3>' + invitados : "");
  aplicarFotosAvatares();
}
$("listaEquipo").onclick = (e) => {
  const fotoBtn = e.target.closest("button[data-foto-uid]");
  if (fotoBtn) { abrirFotoPerfil(fotoBtn.dataset.fotoUid, fotoBtn.dataset.fotoNom); return; }
  const b = e.target.closest("button[data-accion]"); if (!b) return;
  const uid = b.dataset.uid, i = infoReg(uid), nombre = nombreUid(uid);
  if (b.dataset.accion === "telefono") {
    const escrito = prompt(`WhatsApp de ${nombre} con código de país (ej. 50588887777). Déjalo vacío para quitarlo:`, i.telefono || "");
    if (escrito === null) return;
    const tel = escrito.trim() ? normalizarTelefono(escrito) : "";
    if (escrito.trim() && !tel) return setMsg("msgEquipo", "Ese teléfono no es válido. Usa solo números con código de país, ej. 50588887777.", "error");
    db.ref("repartidores/" + uid + "/telefono").set(tel || null)
      .then(() => setMsg("msgEquipo", tel ? `WhatsApp de ${nombre} guardado: +${tel}` : `Se quitó el WhatsApp de ${nombre}.`, "ok"))
      .catch((err) => setMsg("msgEquipo", "No se pudo guardar el teléfono: " + err.message, "error"));
    return;
  }
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

/* FASE 3 · Foto de perfil opcional al crear el repartidor (se guarda en repartidorFotos/<uid>) */
let fotoNueva = "";
function pintarFotoNueva() {
  const av = $("nuevoFotoPrev"); if (!av) return;
  av.style.backgroundImage = fotoNueva ? "url('" + fotoNueva + "')" : "";
  av.style.backgroundSize = "cover"; av.style.backgroundPosition = "center";
  av.classList.toggle("con-foto", !!fotoNueva);
  $("nuevoFotoQuitar").classList.toggle("oculto", !fotoNueva);
  $("nuevoFotoElegir").textContent = fotoNueva ? "Cambiar foto" : "Elegir foto";
}
$("nuevoFotoPrev").onclick = $("nuevoFotoElegir").onclick = () => $("nuevoFotoFile").click();
$("nuevoFotoFile").onchange = async () => {
  const f = $("nuevoFotoFile").files && $("nuevoFotoFile").files[0];
  $("nuevoFotoFile").value = "";
  if (!f) return;
  if (!/^image\//.test(f.type)) return toast("Selecciona una imagen válida.");
  if (f.size > 10 * 1024 * 1024) return toast("La imagen es demasiado grande (máx. 10 MB).");
  try { fotoNueva = await comprimirFoto(f); pintarFotoNueva(); }
  catch (err) { toast("No se pudo usar la foto: " + (err.message || err)); }
};
$("nuevoFotoQuitar").onclick = () => { fotoNueva = ""; pintarFotoNueva(); };

$("btnAgregar").onclick = async () => {
  const email = $("nuevoCorreo").value.trim().toLowerCase();
  const clave = $("nuevaClave").value;
  const telefono = normalizarTelefono($("nuevoTelefono").value);
  if (!email || clave.length < 6) return setMsg("msgEquipo", "Escribe el correo y una contraseña de al menos 6 caracteres.", "error");
  if ($("nuevoTelefono").value.trim() && !telefono) return setMsg("msgEquipo", "El número de WhatsApp no es válido. Usa solo números con código de país, ej. 50588887777.", "error");
  setMsg("msgEquipo", "Creando repartidor…");
  $("btnAgregar").disabled = true;

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
    const ficha = { email, nombre: nombreDesdeCorreo(email), creado: firebase.database.ServerValue.TIMESTAMP };
    if (telefono) ficha.telefono = telefono;
    await db.ref("repartidores/" + uid).set(ficha);
    let avisoFoto = "";
    if (fotoNueva) {
      try { await db.ref("repartidorFotos/" + uid).set(fotoNueva); }
      catch (_) { avisoFoto = " La foto no se pudo guardar; agrégala desde “Tu equipo”."; }
    }
    $("nuevoCorreo").value = ""; $("nuevaClave").value = ""; $("nuevoTelefono").value = "";
    fotoNueva = ""; pintarFotoNueva();
    setMsg("msgEquipo", `Listo: ${email} ya puede entrar a la app. Elegirá su nombre de usuario al iniciar sesión.` + avisoFoto, avisoFoto ? "error" : "ok");
  } catch (e) {
    setMsg("msgEquipo", e.code ? errorAuth(e) : e.message, "error");
  } finally {
    try { await a.signOut(); } catch (_) {}
    $("btnAgregar").disabled = false;
  }
};

Atras.iniciar([
  () => Chat.cerrarCapa(),
  () => (typeof PedidosAdmin !== "undefined" && PedidosAdmin.cerrarMapaForm()),
  () => { const m = $("modalFoto"); if (m && !m.classList.contains("oculto")) { m.classList.add("oculto"); fotoUid = null; return true; } return false; },
  () => { if (!$("modalAdmin").classList.contains("oculto")) { cerrarModal(); return true; } return false; },
  () => { if (mapa && mapa._popup && mapa._popup.isOpen && mapa._popup.isOpen()) { mapa.closePopup(); return true; } return false; },
  () => { if (!$("resBusq").classList.contains("oculto") || document.activeElement === $("busq")) { $("resBusq").classList.add("oculto"); $("busq").blur(); return true; } return false; },
  () => { if (modoNegocio) { terminarModoNegocio(); return true; } return false; },
  () => { if (selUid) { selUid = null; pintarSeleccion(); pintarLista(); return true; } return false; },
  () => { if (modoSel) { modoSel = false; selChats.clear(); pintarChats(); return true; } return false; },
  () => { const t = document.querySelector('.tabs button[data-tab="panelMapa"]'); if ($("vistaApp").classList.contains("oculto") || t.classList.contains("activa")) return false; t.click(); return true; }
]);

function abrirOcultar() {
  const uids = [...new Set([...Object.keys(registrados), ...Object.keys(ubic)])].sort((x, y) => nombreUid(x).localeCompare(nombreUid(y)));
  const avatar = (uid) => {
    const f = typeof fotosCache !== "undefined" ? fotosCache[uid] : null;
    return f && typeof f === "string" && f.indexOf("data:image/") === 0
      ? `<span class="oc-av con-foto" style="background-image:url('${f}')"></span>`
      : `<span class="oc-av">${RIDER_SVG}</span>`;
  };
  const fila = (uid) => {
    const est = estadoDe(uid), [txt, clase] = ETIQUETA[est], v = viajeDe(uid);
    return `<label class="oc-fila"><input type="checkbox" class="sw" data-uid="${esc(uid)}" ${ocultos.has(uid) ? "" : "checked"}>
      ${avatar(uid)}
      <span class="oc-dat"><strong>${esc(nombreUid(uid))}${Ordenes.esInvitadoUid(uid) ? ' <i class="pd-tag">Invitado</i>' : ""}</strong>
        <small><span class="chip ${clase}">${txt}</span>${v ? " · Pedido " + esc(v.d.pedido || "—") : ""}</small></span>
      <span class="oc-sw" aria-hidden="true"></span></label>`;
  };
  modal(`<div class="oc-cab"><h2>👁 Repartidores en el mapa</h2><span id="ocConteo" class="oc-conteo"></span></div>
    <p class="ayuda">Activa o desactiva a cada uno. Los desactivados no aparecen en el mapa (ni su guía ni sus clientes). Siguen trabajando normal.</p>
    <div class="oc-lista">${uids.length ? uids.map(fila).join("") : '<p class="ayuda">Aún no hay repartidores.</p>'}</div>
    <div class="oc-acc"><button id="ocTodos" type="button">Mostrar a todos</button><button id="ocNinguno" type="button">Ocultar a todos</button></div>
    <button id="ocListo" class="primario" type="button">Listo</button>`);
  const conteo = () => { const c = $("ocConteo"); if (c) c.textContent = (uids.length - uids.filter((u) => ocultos.has(u)).length) + " de " + uids.length + " visibles"; };
  conteo();
  const aplicar = () => {
    guardarOcultos(); conteo();
    if (selUid && ocultos.has(selUid)) { selUid = null; pintarSeleccion(); }
    refrescar(); Object.keys(guias).forEach(pintarGuia);
  };
  document.querySelectorAll("#modalCaja input.sw").forEach((i) => i.onchange = () => {
    if (i.checked) ocultos.delete(i.dataset.uid); else ocultos.add(i.dataset.uid);
    aplicar();
  });
  const todos = (mostrar) => { uids.forEach((u) => { if (mostrar) ocultos.delete(u); else ocultos.add(u); }); document.querySelectorAll("#modalCaja input.sw").forEach((i) => i.checked = mostrar); aplicar(); };
  $("ocTodos").onclick = () => todos(true);
  $("ocNinguno").onclick = () => todos(false);
  $("ocListo").onclick = cerrarModal;
}
$("btnOcultar").onclick = abrirOcultar;

function nombreCliente(token, r) {
  const f = activos[token] && activos[token].factura;
  const n = (f && (f.cliente || f.nombre)) || (typeof PedidosAdmin !== "undefined" && PedidosAdmin.clienteDe(token)) || "";
  return n || (r && r.pedido ? "del pedido " + r.pedido : "");
}
/* Las alertas de voz se piden UNA sola vez: al activarlas queda guardado (admin_voz_activada) y VozSiempre (ordenes-admin.js)
   las mantiene activas siempre; el aviso ya no vuelve a aparecer. */
const vozGuardada = () => { try { return localStorage.getItem("admin_voz_activada") === "1"; } catch (_) { return false; } };
function revisarVoz() { const a = $("avisoVoz"); if (a) a.classList.toggle("oculto", Voz.lista() || vozGuardada()); }
$("btnActivarVoz").onclick = () => {
  try { localStorage.setItem("admin_voz_activada", "1"); } catch (_) {}
  Voz.activar(); Voz.hablar(Voz.FRASES.prueba, { forzar: true }); revisarVoz();
  try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission().catch(() => {}); } catch (_) {}
};
const timerVoz = setInterval(() => { revisarVoz(); if (Voz.lista()) clearInterval(timerVoz); }, 1000);
revisarVoz();

let refCalif = null, calif = {};
function cargarCalif() {
  if (refCalif) refCalif.off();
  refCalif = db.ref("calificaciones").orderByChild("ts").limitToLast(1000);
  refCalif.on("value", (s) => { calif = s.val() || {}; pintarCalif(); }, (e) => { $("califLista").innerHTML = `<p class="ayuda">No se pudieron leer las calificaciones: ${esc(e.message)}</p>`; });
}
$("califRango").onchange = () => pintarCalif();
function estrellasTxt(n) { const r = Math.round(n); return "★".repeat(r) + "☆".repeat(5 - r); }
function chispaCalif(rs) {
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

let fotoUid = null, fotoNom = "", fotosCache = {};
function abrirFotoPerfil(uid, nombre) {
  if (!uid) return;
  fotoUid = uid; fotoNom = nombre || "";
  const m = $("modalFoto");
  if (!m) return;
  $("fotoTitulo").textContent = "📷 Foto de " + (fotoNom || "repartidor");
  $("fotoSub").textContent = "Se mostrará al cliente en su seguimiento.";
  $("fotoPreview").textContent = "Cargando…";
  $("fotoPreview").style.backgroundImage = "";
  $("btnFotoBorrar").classList.add("oculto");
  m.classList.remove("oculto");
  db.ref("repartidorFotos/" + uid).once("value").then((s) => pintarPreviewFoto(s.val())).catch(() => pintarPreviewFoto(""));
}
function pintarPreviewFoto(dataUrl) {
  const preview = $("fotoPreview");
  if (!preview) return;
  preview.textContent = "";
  if (dataUrl && typeof dataUrl === "string" && dataUrl.indexOf("data:image/") === 0) {
    preview.style.backgroundImage = "url('" + dataUrl + "')";
    $("btnFotoBorrar").classList.remove("oculto");
  } else {
    preview.style.backgroundImage = "";
    preview.textContent = "Sin foto (se muestra el ícono del repartidor)";
    $("btnFotoBorrar").classList.add("oculto");
  }
}
async function subirFotoPerfil(file) {
  if (!fotoUid || !file) return;
  if (!/^image\//.test(file.type)) return toast("Selecciona una imagen válida.");
  if (file.size > 10 * 1024 * 1024) return toast("La imagen es demasiado grande (máx. 10 MB).");
  $("btnFotoPick").disabled = true; $("btnFotoBorrar").disabled = true;
  try {
    const dataUrl = await comprimirFoto(file);
    await db.ref("repartidorFotos/" + fotoUid).set(dataUrl);
    pintarPreviewFoto(dataUrl);
    toast("Foto guardada ✓");
  } catch (err) {
    toast("No se pudo subir la foto: " + (err.message || err));
  } finally { $("btnFotoPick").disabled = false; $("btnFotoBorrar").disabled = false; }
}
function comprimirFoto(file) {
  return new Promise((ok, fail) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let lado = 640;
      for (let i = 0; i < 5; i++) {
        const k = Math.min(1, lado / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(img.width * k));
        c.height = Math.max(1, Math.round(img.height * k));
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const salida = c.toDataURL("image/jpeg", 0.8);
        if (salida.length <= 300000) return ok(salida);
        lado = Math.round(lado * 0.75);
      }
      fail(new Error("La foto es demasiado grande incluso después de comprimir."));
    };
    img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("No se pudo leer la imagen.")); };
    img.src = url;
  });
}
function aplicarFotosAvatares() {
  document.querySelectorAll("[data-av]").forEach((el) => {
    const f = fotosCache[el.dataset.av];
    if (f && typeof f === "string" && f.indexOf("data:image/") === 0) {
      el.style.backgroundImage = "url('" + f + "')";
      el.style.backgroundSize = "cover";
      el.style.backgroundPosition = "center";
      el.classList.add("con-foto");
    } else {
      el.style.backgroundImage = "";
      el.classList.remove("con-foto");
    }
  });
}
$("btnFotoPick").onclick = () => $("fotoFile").click();
$("fotoFile").onchange = () => {
  const f = $("fotoFile").files && $("fotoFile").files[0];
  $("fotoFile").value = "";
  if (f) subirFotoPerfil(f);
};
$("btnFotoBorrar").onclick = async () => {
  if (!fotoUid) return;
  if (!confirm("¿Quitar la foto de " + (fotoNom || "este repartidor") + "?")) return;
  try { await db.ref("repartidorFotos/" + fotoUid).remove(); pintarPreviewFoto(""); toast("Foto quitada."); }
  catch (e) { toast("No se pudo quitar: " + e.message); }
};
$("btnFotoCerrar").onclick = () => { $("modalFoto").classList.add("oculto"); fotoUid = null; };
$("modalFoto").addEventListener("click", (e) => { if (e.target === $("modalFoto")) { $("modalFoto").classList.add("oculto"); fotoUid = null; } });
