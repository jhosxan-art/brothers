/* ============================================================
   CLIENTE — chat tipo WhatsApp + seguimiento en vivo (Fase 1)
   Flujo:
     1) Sesión anónima de Firebase.
     2) Lee el perfil de LocalStorage. Si no existe o está dañado → genera ID único y pide el nombre.
     3) Crea (o retoma) el chat en  solicitudes_entrantes/{solicitudId}.
     4) Antes de crear el chat, un modal dual pregunta si desea ENVIAR algo (retiro/entrega,
        con GPS, pin o direcciones escritas) o PEDIR algo (qué, de dónde, quién recibe y dónde).
        El resumen del pedido queda como primer mensaje del chat al ser atendido.
     5) Escucha el chat en vivo. El cliente solo puede escribir cuando un repartidor lo atendió.
     6) Cuando el estado pasa a "entregado" (o "cancelado") el chat se vacía y queda un modal
        para valorar (1–5 estrellas) y el botón PEDIR NUEVAMENTE.

   FASE 2 · recuperación de sesión (CLAVE_SESION), botón «Seguir mi Pedido» con mapa a pantalla
   completa y ajuste del teclado con visualViewport.

   FASE 1 · mejoras aplicadas:
     - Pin escalable con el zoom (--pin-scale actualizado en cada zoomend).
     - fitBounds forzado en el primer encuadre cuando repartidor + cliente están disponibles.
     - Fallback claro de la ruta OSRM (línea punteada gris, no recta).
     - Banner de ruta "km · min · calle actual" con desvanecimiento suave.
     - Breakpoints responsive (700/900/1200 px) en cliente-app.css.
   ============================================================ */
(() => {
  "use strict";

  const RAIZ = "solicitudes_entrantes";
  const RAIZ_CLIENTES = "clientes";
  const CLAVE_LOCAL = "brothers_cliente_v1";
  const CLAVE_ULTIMA_DIR = "brothers_ultima_direccion";
  const MAX_TEXTO = 600;
  const RAIZ_FOTOS = "solicitudes_fotos";
  const MAX_FOTO = 300000;
  const RAIZ_PERFIL = "repartidorFotos";
  const CENTRO_MAPA = [12.5700, -87.1311];   // Chinandega, Nicaragua
  const RADIO_CERCA_M = 200;
  const TYPING_MS = 1500, TYPING_CADUCA = 4000;
  const COLOR_TICK_ENVIADO = "#8696A0";
  const COLOR_TICK_LEIDO = "#25D366";
  const COLOR_PIN_REP = "#25D366";
  const COLOR_PIN_CLI = "#2F6FED";

  const $ = (id) => document.getElementById(id);
  const db = APP.database();
  const auth = APP.auth();

  let perfil = null;
  let refSolicitud = null;
  let refMensajes = null;
  let refLeidos = null;
  let refTyping = null;
  let asignado = false;
  let primerSnapshot = true;
  let respaldoMemoria = null;
  let cerrado = false;
  let valorada = false;
  let pedidoActual = null;
  let posCliente = null;
  let mensajesListos = false;
  let avisadoCerca = false;
  let fotoRepUid = null;
  let lect = {};
  let typingOtro = {};
  let tUltTyping = 0, tmEscribiendo = null, tmTypingRefresh = null;
  let resumenCard = null, resumenReal = false, resumenEnviando = false;
  let recuperando = false;

  /* ---------- Utilidades ---------- */
  const vista = (id) => ["vCarga", "vNombre", "vPedido", "vChat"].forEach((v) => $(v).classList.toggle("oculto", v !== id));

  function errorCarga(msg) {
    const el = $("msgCarga");
    el.textContent = msg;
    el.className = "wa-estado error";
    vista("vCarga");
  }

  function mostrarError(msg) {
    const el = $("msgError");
    el.textContent = msg;
    el.classList.toggle("oculto", !msg);
  }

  const limpiarNombre = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const nombreValido = (s) => typeof s === "string" && s.length >= 2 && s.length <= 24;
  const idValido = (s) => typeof s === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(s);

  function generarId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID().replace(/-/g, "");
      if (window.crypto && window.crypto.getRandomValues) {
        const b = new Uint8Array(16);
        window.crypto.getRandomValues(b);
        return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
      }
    } catch (_) { }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  const dinero = (n) => "C$ " + (Number(n) || 0).toFixed(2);
  const hora = (ts) => new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });

  function etiquetaDia(ts) {
    const d = new Date(ts), hoy = new Date();
    const ini = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dif = Math.round((ini(hoy) - ini(d)) / 86400000);
    if (dif === 0) return "Hoy";
    if (dif === 1) return "Ayer";
    return d.toLocaleDateString("es", { day: "numeric", month: "long" });
  }

  /* ---------- Perfil en LocalStorage ---------- */
  function leerPerfil() {
    let crudo = null;
    try { crudo = localStorage.getItem(CLAVE_LOCAL); } catch (_) { crudo = null; }
    if (!crudo && respaldoMemoria) return respaldoMemoria;
    if (!crudo) return null;
    try {
      const p = JSON.parse(crudo);
      if (p && typeof p === "object" && idValido(p.id) && nombreValido(p.nombre)) {
        return { id: p.id, nombre: p.nombre, solicitudId: idValido(p.solicitudId) ? p.solicitudId : null };
      }
    } catch (_) { }
    try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { }
    return null;
  }

  function guardarPerfil(p) {
    respaldoMemoria = p;
    try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify({ id: p.id, nombre: p.nombre, solicitudId: p.solicitudId || null })); }
    catch (_) { }
  }

  /* ---------- Sesión activa (recuperación ante cierres accidentales) ---------- */
  const CLAVE_SESION = "brothers_sesion_activa";

  function leerSesion() {
    for (const almacen of ["localStorage", "sessionStorage"]) {
      try {
        const s = JSON.parse(window[almacen].getItem(CLAVE_SESION) || "null");
        if (s && typeof s === "object" && idValido(s.clienteId) && s.pedidoId === "sol_" + s.clienteId && nombreValido(s.nombre)) return s;
      } catch (_) { }
    }
    return null;
  }

  function guardarSesion(extra) {
    if (!perfil || !perfil.solicitudId || !idValido(perfil.id)) return;
    const previa = leerSesion();
    const s = Object.assign({}, previa && previa.pedidoId === perfil.solicitudId ? previa : {}, {
      pedidoId: perfil.solicitudId, clienteId: perfil.id, nombre: perfil.nombre, ts: Date.now()
    }, extra || {});
    const txt = JSON.stringify(s);
    try { localStorage.setItem(CLAVE_SESION, txt); } catch (_) { }
    try { sessionStorage.setItem(CLAVE_SESION, txt); } catch (_) { }
  }

  function borrarSesion() {
    try { localStorage.removeItem(CLAVE_SESION); } catch (_) { }
    try { sessionStorage.removeItem(CLAVE_SESION); } catch (_) { }
  }

  /* ---------- Última dirección ---------- */
  function leerUltimaDirLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(CLAVE_ULTIMA_DIR) || "null");
      if (o && typeof o === "object" && (o.tipo === "pin" || o.tipo === "direccion" || o.tipo === "gps")) return o;
    } catch (_) {}
    return null;
  }
  function guardarUltimaDirLocal(d) {
    try { localStorage.setItem(CLAVE_ULTIMA_DIR, JSON.stringify(d)); } catch (_) {}
  }
  async function guardarUltimaDireccion(destino) {
    if (!destino || !perfil) return;
    if (destino.tipo !== "pin" && destino.tipo !== "direccion") return;
    const dato = { tipo: destino.tipo, ts: Date.now() };
    if (destino.tipo === "pin") { dato.lat = redondear(destino.lat); dato.lng = redondear(destino.lng); }
    if (destino.tipo === "direccion") dato.texto = String(destino.texto || "").slice(0, 200);
    guardarUltimaDirLocal(dato);
    try { await db.ref(RAIZ_CLIENTES + "/" + perfil.id + "/ultimaDireccion").set(dato); }
    catch (_) { }
  }

  /* ---------- Arranque ---------- */
  async function arrancar() {
    try {
      await auth.signInAnonymously();
    } catch (e) {
      const apagado = e.code === "auth/operation-not-allowed" || e.code === "auth/admin-restricted-operation";
      return errorCarga(apagado
        ? "Falta activar el inicio de sesión anónimo en Firebase (Authentication → Sign-in method → Anonymous)."
        : "No se pudo abrir la sesión: " + (e.code || e.message));
    }

    perfil = leerPerfil();
    const ses = leerSesion();
    if (!perfil && ses) {
      perfil = { id: ses.clienteId, nombre: ses.nombre, solicitudId: ses.pedidoId };
      guardarPerfil(perfil);
    }
    if (perfil) {
      recuperando = !!(ses && ses.clienteId === perfil.id && ses.estado !== "entregado" && ses.estado !== "cancelado");
      return abrirChat();
    }
    vista("vNombre");
    $("inNombre").focus();
  }

  $("formNombre").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const n = limpiarNombre($("inNombre").value);
    const msg = $("msgNombre");
    if (!nombreValido(n)) {
      msg.textContent = "Escribe tu nombre (entre 2 y 24 letras).";
      msg.classList.remove("oculto");
      return;
    }
    msg.classList.add("oculto");
    perfil = { id: generarId(), nombre: n, solicitudId: null };
    guardarPerfil(perfil);
    abrirChat();
  });

  /* ---------- Crear o retomar el chat ---------- */
  async function abrirChat() {
    if (!perfil || !idValido(perfil.id)) {
      perfil = null;
      try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { }
      vista("vNombre");
      return;
    }
    $("msgCarga").className = "wa-splash-msg";
    $("msgCarga").textContent = recuperando ? "Recuperando tu pedido…" : "Abriendo tu chat…";
    vista("vCarga");

    if (!perfil.solicitudId) {
      perfil.solicitudId = "sol_" + perfil.id;
      guardarPerfil(perfil);
    }

    refSolicitud = db.ref(RAIZ + "/" + perfil.solicitudId);
    refMensajes = refSolicitud.child("mensajes");
    refLeidos = refSolicitud.child("leidos");
    refTyping = refSolicitud.child("typing");

    try {
      const s = await refSolicitud.once("value");
      if (!s.exists()) { recuperando = false; borrarSesion(); await pausaSplash(); return pedirDetalles(); }
    } catch (e) {
      return errorCarga("No se pudo abrir tu chat: " + (e.code || e.message));
    }
    entrarAlChat();
  }

  async function crearSolicitud(pedido) {
    const base = {
      clienteId: perfil.id,
      nombre: perfil.nombre,
      estado: "nuevo",
      creado: firebase.database.ServerValue.TIMESTAMP,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ultimoMensaje: "",
      ultimoDe: "",
      pedido
    };
    try {
      await refSolicitud.set(base);
    } catch (e) {
      /* Reglas aún sin los campos nuevos (tipo / retiro): reintenta con el formato anterior. */
      if (!e || e.code !== "PERMISSION_DENIED") throw e;
      const { tipo, retiro, ...anterior } = pedido;
      await refSolicitud.set({ ...base, pedido: anterior });
    }
  }

  function entrarAlChat() {
    vista("vChat");
    escucharSolicitud();
    escucharLeidos();
    escucharTyping();
    escucharMensajes();
    escucharRepartidorGps();
    marcarLeidoPropio();
  }

  function detenerTodo() {
    if (refSolicitud) { refSolicitud.off(); refSolicitud.child("repartidorGps").off(); }
    if (refMensajes) refMensajes.off();
    if (refLeidos) refLeidos.off();
    if (refTyping) refTyping.off();
    apagarTypingPropio();
    detenerGps();
    $("mensajes").textContent = "";
    ultimoDe = null; ultimoDia = null; vistos.clear();
    primerSnapshot = true; asignado = false; pedidoActual = null; posCliente = null;
    mensajesListos = false; avisadoCerca = false;
    lect = {}; typingOtro = {};
    resumenCard = null; resumenReal = false; resumenEnviando = false;
    pintarAvatar(null, "");
    limpiarMapa();
  }

  /* ---------- Estado de la solicitud ---------- */
  function escucharSolicitud() {
    refSolicitud.on("value", (s) => {
      if (!s.exists()) {
        if (cerrado) return;
        detenerTodo();
        return abrirChat();
      }
      const d = s.val() || {};
      pedidoActual = d.pedido && typeof d.pedido === "object" ? d.pedido : null;
      $("btnCambiarNombre").classList.toggle("oculto", !(d.estado === "nuevo"));

      if (d.estado === "entregado" || d.estado === "cancelado") { recuperando = false; borrarSesion(); return cerrarCiclo(d); }
      guardarSesion({ estado: d.estado });
      if (recuperando) {
        recuperando = false;
        avisoSistema("Recuperamos tu pedido: tu chat y tu ubicación siguen activos.");
      }

      const ahoraAsignado = d.estado === "atendido" && typeof d.repartidorUid === "string" && d.repartidorUid.length > 0;
      const nombreRep = typeof d.repartidorNombre === "string" ? d.repartidorNombre.slice(0, 40) : "";
      pintarEstado(ahoraAsignado, nombreRep, d.repartidorUid);
      pintarResumen();
      if (!ahoraAsignado) pintarResumenLocal();
      iniciarGps();

      if (!ahoraAsignado && asignado) {
        setMapaVisible(false);
        avisoSistema("Tu repartidor dejó el pedido. Estamos buscando otro para ti.");
      }
      if (ahoraAsignado && !asignado && !primerSnapshot) {
        avisoSistema((nombreRep || "Un repartidor") + " atendió tu chat. Toca «Seguir mi Pedido» para verlo en el mapa.");
        if (window.Voz) Voz.clientePedidoAceptado();
      }
      if (!ahoraAsignado) avisadoCerca = false;
      asignado = ahoraAsignado;
      if (ahoraAsignado) enviarResumenAlChat();

      if (ahoraAsignado && d.llegadaTs) avisarCerca();
      primerSnapshot = false;
    }, (e) => mostrarError("Se perdió la conexión con tu chat: " + (e.code || e.message)));
  }

  function pintarAvatar(uid, nombre) {
    const img = $("avatarFoto"), letra = $("avatarLetra");
    letra.textContent = uid ? (nombre || "R").charAt(0).toUpperCase() : "B";
    if (!uid) {
      fotoRepUid = null;
      img.classList.add("oculto"); img.removeAttribute("src"); img.alt = "";
      letra.classList.remove("oculto");
      return;
    }
    if (fotoRepUid === uid) return;
    fotoRepUid = uid;
    img.classList.add("oculto"); letra.classList.remove("oculto");
    db.ref(RAIZ_PERFIL + "/" + uid).once("value").then((s) => {
      const f = s.val();
      if (fotoRepUid !== uid || typeof f !== "string" || f.indexOf("data:image/") !== 0) return;
      img.alt = "Foto de " + (nombre || "tu repartidor");
      img.src = f;
      img.classList.remove("oculto"); letra.classList.add("oculto");
    }).catch(() => { });
  }

  function pintarEstado(conRepartidor, nombreRep, uidRep) {
    $("avisoEspera").classList.toggle("oculto", conRepartidor);
    $("tituloChat").textContent = conRepartidor ? (nombreRep || "Tu repartidor") : "Brother’s Deliverys";
    if (!conRepartidor) $("subChat").textContent = "Buscando repartidor…";
    pintarAvatar(conRepartidor && typeof uidRep === "string" ? uidRep : null, nombreRep);
    const inp = $("inMensaje");
    inp.disabled = !conRepartidor;
    $("btnEnviar").disabled = !conRepartidor;
    $("btnFoto").disabled = !conRepartidor;
    $("btnSeguir").classList.toggle("oculto", !conRepartidor || typeof L === "undefined");
    inp.placeholder = conRepartidor ? "Escribe un mensaje" : "Esperando repartidor…";
    if (conRepartidor) pintarTyping();
  }

  /* ---------- Leídos (palomitas ✓ / ✓✓ verdes) ---------- */
  function escucharLeidos() {
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    refLeidos = refSolicitud.child("leidos");
    refLeidos.on("value", (s) => {
      const v = s.val() || {};
      lect = { cliente: Number(v.cliente) || 0, repartidor: Number(v.repartidor) || 0 };
      actualizarTicks();
    }, () => {});
  }

  let tmLeidoCliente = null, tUltLeidoCliente = 0;
  function marcarLeidoPropio() {
    if (!refSolicitud || cerrado || !asignado || document.visibilityState !== "visible") return;
    clearTimeout(tmLeidoCliente);
    const espera = 1500 - (Date.now() - tUltLeidoCliente);
    if (espera > 0) { tmLeidoCliente = setTimeout(marcarLeidoPropio, espera + 50); return; }
    tUltLeidoCliente = Date.now();
    refSolicitud.child("leidos/cliente").set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") marcarLeidoPropio(); });

  function actualizarTicks() {
    $("mensajes").querySelectorAll(".wa-tick").forEach((t) => {
      const ts = +t.dataset.ts || 0;
      const leido = ts > 0 && (Number(lect.repartidor) || 0) >= ts;
      t.textContent = leido ? "✓✓" : "✓";
      t.classList.toggle("leido", leido);
      t.style.color = leido ? COLOR_TICK_LEIDO : COLOR_TICK_ENVIADO;
      t.title = leido ? "Leído" : "Enviado";
    });
  }

  /* ---------- Typing ("escribiendo…") ---------- */
  function marcarTypingPropio() {
    if (!refSolicitud || cerrado || !asignado) return;
    const ahora = Date.now();
    if (ahora - tUltTyping < TYPING_MS) {
      clearTimeout(tmEscribiendo);
      tmEscribiendo = setTimeout(marcarTypingPropio, TYPING_MS);
      return;
    }
    tUltTyping = ahora;
    refSolicitud.child("typing/cliente").set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});
    clearTimeout(tmEscribiendo);
    tmEscribiendo = setTimeout(marcarTypingPropio, TYPING_MS);
  }
  function apagarTypingPropio() {
    clearTimeout(tmEscribiendo);
    if (refSolicitud) refSolicitud.child("typing/cliente").remove().catch(() => {});
    tUltTyping = 0;
  }
  function escucharTyping() {
    if (refTyping) { refTyping.off(); refTyping = null; }
    refTyping = refSolicitud.child("typing");
    refTyping.on("value", (s) => {
      typingOtro = s.val() || {};
      pintarTyping();
      clearTimeout(tmTypingRefresh);
      const ahora = Date.now();
      const cad = Object.entries(typingOtro)
        .filter(([rol]) => rol !== "cliente")
        .map(([, ts]) => Number(ts) + TYPING_CADUCA - ahora)
        .filter((x) => x > 0);
      if (cad.length) tmTypingRefresh = setTimeout(pintarTyping, Math.min(...cad) + 50);
    }, () => {});
  }
  function pintarTyping() {
    const sub = $("subChat");
    if (!sub) return;
    const ahora = Date.now();
    const repTs = Number(typingOtro.repartidor) || 0;
    const escribiendo = asignado && repTs > 0 && ahora - repTs < TYPING_CADUCA;
    if (escribiendo) {
      sub.textContent = ($("tituloChat").textContent || "Tu repartidor") + " está escribiendo…";
      sub.classList.add("escribiendo");
    } else if (asignado) {
      sub.textContent = "Te está atendiendo";
      sub.classList.remove("escribiendo");
    } else {
      sub.textContent = "Buscando repartidor…";
      sub.classList.remove("escribiendo");
    }
  }
  $("inMensaje").addEventListener("input", () => { if (asignado) marcarTypingPropio(); });

  /* ---------- Mensajes ---------- */
  let ultimoDe = null, ultimoDia = null;
  const vistos = new Set();

  function escucharMensajes() {
    refMensajes.limitToLast(300).on("child_added", (s) => {
      if (cerrado || vistos.has(s.key)) return;
      vistos.add(s.key);
      const m = s.val();
      if (!m || typeof m !== "object") return;
      pintarMensaje(m, s.key);
      if (mensajesListos && m.de === "repartidor" && window.Voz) Voz.clienteMensajeNuevo();
    }, (e) => mostrarError("No se pudieron leer los mensajes: " + (e.code || e.message)));
    mensajesListos = false;
    refMensajes.limitToLast(300).once("value").then(() => { mensajesListos = true; }).catch(() => { mensajesListos = true; });
  }

  function pegadoAlFinal() {
    const c = $("mensajes");
    return c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  }
  function alFinal() { const c = $("mensajes"); c.scrollTop = c.scrollHeight; }

  function separadorDia(ts) {
    const dia = new Date(ts).toDateString();
    if (dia === ultimoDia) return;
    ultimoDia = dia;
    ultimoDe = null;
    const el = document.createElement("div");
    el.className = "wa-dia";
    el.textContent = etiquetaDia(ts);
    $("mensajes").appendChild(el);
  }

  function avisoSistema(texto) {
    const el = document.createElement("div");
    el.className = "wa-sistema";
    el.textContent = texto;
    $("mensajes").appendChild(el);
    ultimoDe = null;
    alFinal();
  }

  function pintarMensaje(m, clave) {
    const ts = Number(m.ts) || Date.now();
    const yo = m.de === "cliente";
    const seguir = pegadoAlFinal() || yo;
    separadorDia(ts);

    const burbuja = document.createElement("div");
    burbuja.className = "wa-msg" + (yo ? " yo" : "") + (ultimoDe === m.de ? " cont" : "");
    ultimoDe = m.de;

    if (m.tipo === "factura" && m.factura && typeof m.factura === "object") {
      burbuja.classList.add("factura");
      burbuja.appendChild(tarjetaFactura(m.factura));
    } else if (m.tipo === "foto") {
      burbuja.classList.add("foto");
      const img = document.createElement("img");
      img.alt = "Cargando foto…";
      burbuja.appendChild(img);
      const poner = (v) => {
        if (typeof v === "string" && v.indexOf("data:image/") === 0) { img.addEventListener("load", () => { if (seguir) alFinal(); }, { once: true }); img.src = v; }
        else img.alt = "Foto no disponible";
      };
      if (typeof m.foto === "string") poner(m.foto);
      else db.ref(RAIZ_FOTOS + "/" + perfil.solicitudId + "/" + clave).once("value").then((x) => poner(x.val())).catch(() => { img.alt = "No se pudo cargar la foto"; });
    } else {
      const p = document.createElement("p");
      p.textContent = String(m.texto || "");
      burbuja.appendChild(p);
      if (typeof m.texto === "string" && m.texto.indexOf(MARCA_RESUMEN) === 0) {
        burbuja.classList.add("resumen");
        resumenReal = true;
        quitarResumenLocal();
      }
    }

    const h = document.createElement("span");
    h.className = "wa-hora";
    h.textContent = hora(ts);

    if (yo) {
      const tick = document.createElement("span");
      tick.className = "wa-tick";
      tick.dataset.ts = ts;
      tick.textContent = "✓";
      tick.style.color = COLOR_TICK_ENVIADO;
      tick.title = "Enviado";
      h.appendChild(document.createTextNode(" "));
      h.appendChild(tick);
    }
    burbuja.appendChild(h);

    $("mensajes").appendChild(burbuja);
    actualizarTicks();
    if (seguir) alFinal();
    if (!yo && asignado) marcarLeidoPropio();
  }

  /* ---------- Factura como tarjeta ---------- */
  function el(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }
  function fila(etiqueta, valor, clase) {
    const f = el("div", "wa-fac-fila" + (clase ? " " + clase : ""));
    f.appendChild(el("span", "", etiqueta));
    f.appendChild(el("b", "", valor));
    return f;
  }
  function tarjetaFactura(f) {
    const caja = document.createElement("div");
    const cab = el("div", "wa-fac-cab");
    cab.appendChild(el("strong", "", "🏍️ Brother’s Delivery"));
    cab.appendChild(el("span", "", "Factura"));
    caja.appendChild(cab);
    const cuerpo = el("div", "wa-fac-cuerpo");
    if (f.cliente) cuerpo.appendChild(el("div", "wa-fac-meta", "Cliente: " + String(f.cliente)));
    if (f.deposito) cuerpo.appendChild(el("div", "wa-fac-meta", "Depósito: sí"));
    const lista = el("div", "wa-fac-lista");
    (Array.isArray(f.productos) ? f.productos : []).forEach((p) => {
      if (p && typeof p === "object") lista.appendChild(fila(String(p.nombre || "Producto"), dinero(p.precio)));
    });
    cuerpo.appendChild(lista);
    const tot = el("div", "wa-fac-totales");
    tot.appendChild(fila("Subtotal", dinero(f.subtotal)));
    tot.appendChild(fila(Number(f.mandadoExtra) > 0 ? "Delivery (con mandado extra)" : "Delivery", dinero(f.delivery)));
    if (Number(f.prioridad) > 0) tot.appendChild(fila("⚡ Prioridad", dinero(f.prioridad)));
    tot.appendChild(fila("Total", dinero(f.totalFinal != null ? f.totalFinal : f.total), "total"));
    cuerpo.appendChild(tot);
    if (f.pedido) {
      const cod = el("div", "wa-fac-codigo");
      cod.appendChild(el("small", "", "Código de retiro"));
      cod.appendChild(el("span", "", String(f.pedido)));
      cuerpo.appendChild(cod);
    }
    caja.appendChild(cuerpo);
    return caja;
  }

  /* ---------- Enviar ---------- */
  $("formMensaje").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const inp = $("inMensaje");
    const texto = inp.value.trim().slice(0, MAX_TEXTO);
    if (!texto || !asignado || !refMensajes) return;

    inp.value = "";
    apagarTypingPropio();
    mostrarError("");
    const clave = refMensajes.push().key;
    const ts = firebase.database.ServerValue.TIMESTAMP;
    const cambios = {};
    cambios["mensajes/" + clave] = { de: "cliente", tipo: "texto", texto, ts };
    cambios["ultimoMensaje"] = texto.slice(0, 80);
    cambios["ultimoDe"] = "cliente";
    cambios["ts"] = ts;
    try { await refSolicitud.update(cambios); }
    catch (e) { inp.value = texto; mostrarError("No se pudo enviar el mensaje: " + (e.code || e.message)); }
    inp.focus();
  });

  /* ============================================================
     Modal inicial: tipo de servicio + datos del pedido
     Pantallas: 0 (Enviar / Pedir) · 1, 2, 3r, 3e (Pedir algo) · E1, E2, E3 (Enviar algo)
     ============================================================ */
  const MARCA_RESUMEN = "📋 RESUMEN DEL PEDIDO";
  const MARCA_GPS_RETIRO = "📍 Mi ubicación actual (retiro)";
  const CLAVE_RESUMEN = "brothers_resumen_pedido";

  let pantalla = "0", historial = [], servicio = null, modo = null, modoEnvio = null;
  let tipoEnvio = "pin", pin = null, gpsListo = null;
  let mapaPin = null, marcaPin = null;
  let tipoLugarE = "pin", pinE = null, mapaE = null, marcaE = null;

  const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const redondear = (n) => Math.round(n * 1e6) / 1e6;
  const iconoPin = (clase, emoji) => L.divIcon({ className: "", html: '<div class="wa-pin ' + clase + '">' + emoji + "</div>", iconSize: [40, 40], iconAnchor: [20, 20] });
  const falla = (msg) => { errorPedido(msg); return null; };
  const pausaSplash = () => new Promise((ok) => setTimeout(ok, 900));

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function errorPedido(msg) {
    const e = $("msgPedido");
    e.textContent = msg;
    e.classList.toggle("oculto", !msg);
  }

  function pedirDetalles() {
    servicio = null; modo = null; modoEnvio = null; historial = [];
    tipoEnvio = "pin"; pin = null; gpsListo = null; pantalla = "0";
    ["inQuiere", "inOrigen", "inDir", "inPaquete", "inRetiroTxt", "inEntregaTxt", "inLugarE"].forEach((id) => { $(id).value = ""; });
    ["estadoGps", "estadoGpsE"].forEach((id) => $(id).classList.add("oculto"));
    $("btnGps").textContent = "📍 Activar mi ubicación";
    $("btnGpsE").textContent = "📍 Activar mi ubicación";
    $("ayudaPin").textContent = "Toca el mapa para colocar el pin. Puedes arrastrarlo.";
    $("ultimaDireccionBox").classList.add("oculto");
    if (marcaPin && mapaPin) { mapaPin.removeLayer(marcaPin); marcaPin = null; }
    resetLugarE();
    setTipoEnvio("pin");
    $("btnSiguiente").disabled = false;
    errorPedido("");
    vista("vPedido");
    mostrarPantalla();
  }

  /* ---------- Navegación entre pantallas ---------- */
  function pintarIndicador() {
    const ind = $("pasosInd");
    let idx = -1, total = 3;
    if (servicio === "pedir") {
      idx = pantalla === "1" ? 0 : pantalla === "2" ? 1 : (pantalla === "3r" || pantalla === "3e") ? 2 : -1;
    } else if (servicio === "enviar") {
      total = 2;
      idx = pantalla === "E1" ? 0 : (pantalla === "E2" || pantalla === "E3") ? 1 : -1;
    }
    ind.classList.toggle("oculto", idx < 0);
    if (idx < 0) return;
    ind.textContent = "";
    for (let i = 0; i < total; i++) {
      const b = document.createElement("i");
      if (i <= idx) b.className = "on";
      ind.appendChild(b);
    }
  }

  function mostrarPantalla() {
    document.querySelectorAll("#formPedido .wa-paso").forEach((n) => n.classList.toggle("oculto", n.dataset.paso !== pantalla));
    pintarIndicador();
    $("btnAtras").classList.toggle("oculto", pantalla === "0");
    $("btnAtras").parentElement.classList.toggle("oculto", pantalla === "0");
    const sinBoton = pantalla === "0" || pantalla === "2" || pantalla === "E1";
    $("btnSiguiente").classList.toggle("oculto", sinBoton);
    $("btnSiguiente").textContent = pantalla === "1" ? "Siguiente" : "Enviar pedido";
    errorPedido("");
    if (pantalla === "1") setTimeout(() => $("inQuiere").focus(), 60);
    if (pantalla === "E3") setTimeout(() => $("inRetiroTxt").focus(), 60);
    if (pantalla === "3e") { iniciarMapaPin(); mostrarUltimaDireccion(); }
    if (pantalla === "3r") { if (gpsListo) pintarGpsListo("estadoGps", "btnGps"); else pedirGps("estadoGps", "btnGps"); }
    if (pantalla === "E2") prepararE2();
  }

  function irA(clave) {
    if (pantalla !== clave) historial.push(pantalla);
    pantalla = clave;
    mostrarPantalla();
  }

  $("btnAtras").addEventListener("click", () => {
    if (!historial.length) return;
    pantalla = historial.pop();
    if (pantalla === "0") servicio = null;
    mostrarPantalla();
  });

  document.querySelectorAll("#formPedido [data-servicio]").forEach((b) => b.addEventListener("click", () => {
    servicio = b.dataset.servicio;
    irA(servicio === "enviar" ? "E1" : "1");
  }));

  document.querySelectorAll('#formPedido [data-paso="2"] .wa-opcion').forEach((b) => b.addEventListener("click", () => {
    modo = b.dataset.modo;
    irA(modo === "recibe" ? "3r" : "3e");
  }));

  document.querySelectorAll("#formPedido [data-envio]").forEach((b) => b.addEventListener("click", () => {
    const paquete = limpiarNombre($("inPaquete").value);
    if (paquete.length < 2) { $("inPaquete").focus(); return errorPedido("Cuéntanos qué vas a enviar."); }
    const antes = modoEnvio;
    modoEnvio = b.dataset.envio;
    if (antes && antes !== modoEnvio) resetLugarE();
    irA(modoEnvio === "texto" ? "E3" : "E2");
  }));

  /* ---------- Última dirección guardada (Pedir algo → entrega a otra persona) ---------- */
  function mostrarUltimaDireccion() {
    const box = $("ultimaDireccionBox"), txt = $("ultimaDireccionTxt");
    const dir = leerUltimaDirLocal();
    if (!dir || (dir.tipo !== "pin" && dir.tipo !== "direccion")) {
      box.classList.add("oculto");
      return;
    }
    let donde = "";
    if (dir.tipo === "direccion") donde = dir.texto || "";
    else if (okLL(dir.lat, dir.lng)) donde = `Pin del mapa (${Number(dir.lat).toFixed(5)}, ${Number(dir.lng).toFixed(5)})`;
    if (!donde) { box.classList.add("oculto"); return; }

    let hace = "";
    if (dir.ts) {
      const s = Math.max(0, Math.round((Date.now() - Number(dir.ts)) / 1000));
      hace = s < 60 ? "hace unos segundos" : s < 3600 ? "hace " + Math.round(s / 60) + " min" : s < 86400 ? "hace " + Math.round(s / 3600) + " h" : "hace " + Math.round(s / 86400) + " días";
    }
    txt.innerHTML = "La última vez pediste a: <b>" + escapeHtml(donde) + "</b>" + (hace ? " (" + escapeHtml(hace) + ")" : "") + ".<br>¿Recibes aquí de nuevo?";
    box.classList.remove("oculto");

    $("btnUsarUltima").onclick = () => {
      if (dir.tipo === "direccion") {
        setTipoEnvio("direccion");
        $("inDir").value = dir.texto || "";
        $("formPedido").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
      } else if (dir.tipo === "pin" && okLL(dir.lat, dir.lng)) {
        setTipoEnvio("pin");
        setTimeout(() => {
          colocarPin({ lat: Number(dir.lat), lng: Number(dir.lng) });
          if (mapaPin) mapaPin.setView([Number(dir.lat), Number(dir.lng)], Math.max(mapaPin.getZoom(), 16));
          $("formPedido").dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        }, 80);
      }
    };
    $("btnOtraDir").onclick = () => box.classList.add("oculto");
  }

  /* ---------- GPS (compartido por "Lo recibo yo", "Retiran donde mí" y "Traen donde mí") ---------- */
  let buscandoGps = false;

  function pintarGpsListo(estId, btnId) {
    const est = $(estId);
    est.className = "wa-estado";
    est.textContent = "✅ Ubicación lista. Se compartirá en vivo con tu repartidor.";
    $(btnId).textContent = "📍 Actualizar mi ubicación";
  }

  function pedirGps(estId, btnId) {
    if (buscandoGps) return;
    const est = $(estId);
    est.className = "wa-estado";
    est.textContent = "Buscando tu ubicación…";
    if (!navigator.geolocation) return falloGps(0, estId, btnId);
    buscandoGps = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      buscandoGps = false;
      gpsListo = { lat: redondear(pos.coords.latitude), lng: redondear(pos.coords.longitude) };
      pintarGpsListo(estId, btnId);
      errorPedido("");
    }, (e) => { buscandoGps = false; falloGps(e && e.code, estId, btnId); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }

  function falloGps(codigo, estId, btnId) {
    gpsListo = null;
    const est = $(estId);
    est.className = "wa-estado error";
    est.textContent = codigo === 1
      ? "Tu ubicación está bloqueada. Permite la ubicación para este sitio en los ajustes de tu navegador y toca el botón de nuevo."
      : "No pudimos obtener tu ubicación. Enciende el GPS de tu celular y toca el botón de nuevo.";
    $(btnId).textContent = "📍 Reintentar ubicación";
  }

  $("btnGps").addEventListener("click", () => pedirGps("estadoGps", "btnGps"));
  $("btnGpsE").addEventListener("click", () => pedirGps("estadoGpsE", "btnGpsE"));

  /* ---------- Pedir algo: dónde se entrega (pin o dirección) ---------- */
  function setTipoEnvio(t) {
    tipoEnvio = t;
    document.querySelectorAll("#segPedir button").forEach((b) => b.classList.toggle("activa", b.dataset.tipo === t));
    $("boxPin").classList.toggle("oculto", t !== "pin");
    $("boxDir").classList.toggle("oculto", t !== "direccion");
    if (t === "pin" && pantalla === "3e") iniciarMapaPin();
  }
  document.querySelectorAll("#segPedir button").forEach((b) => b.addEventListener("click", () => setTipoEnvio(b.dataset.tipo)));

  function iniciarMapaPin() {
    if (typeof L === "undefined") {
      setTipoEnvio("direccion");
      document.querySelector('#segPedir button[data-tipo="pin"]').classList.add("oculto");
      return;
    }
    if (!mapaPin) {
      mapaPin = L.map("mapaPin", { zoomControl: false }).setView(CENTRO_MAPA, 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapaPin);
      mapaPin.on("click", (ev) => colocarPin(ev.latlng));
    }
    setTimeout(() => mapaPin.invalidateSize(), 80);
  }

  function colocarPin(ll) {
    pin = { lat: redondear(ll.lat), lng: redondear(ll.lng) };
    if (!marcaPin) {
      marcaPin = L.marker(ll, { icon: iconoPin("wa-pin-cli", "📍"), draggable: true }).addTo(mapaPin);
      marcaPin.on("dragend", () => colocarPin(marcaPin.getLatLng()));
    } else marcaPin.setLatLng(ll);
    $("ayudaPin").textContent = "✅ Pin colocado. Puedes moverlo si hace falta.";
    errorPedido("");
  }

  /* ---------- Enviar algo: lugar de retiro o de entrega (pin o dirección) ---------- */
  function prepararE2() {
    const retiran = modoEnvio === "retiran";
    $("tituloE2").textContent = retiran ? "📍 Retiran donde mí" : "🏠 Traen donde mí";
    $("ayudaGpsE").textContent = retiran
      ? "Tu ubicación en vivo será el punto de retiro y el repartidor te verá en el mapa. Si tu GPS está encendido, la detectamos sola."
      : "Tu ubicación en vivo será el punto de entrega final y el repartidor te verá en el mapa. Si tu GPS está encendido, la detectamos sola.";
    $("lblLugarE").textContent = retiran ? "¿Dónde se entrega el paquete?" : "¿Dónde retiran el paquete?";
    if (gpsListo) pintarGpsListo("estadoGpsE", "btnGpsE"); else pedirGps("estadoGpsE", "btnGpsE");
    setTipoLugarE(tipoLugarE);
  }

  function resetLugarE() {
    pinE = null; tipoLugarE = "pin";
    if (marcaE && mapaE) { mapaE.removeLayer(marcaE); marcaE = null; }
    $("ayudaPinE").textContent = "Toca el mapa para colocar el pin. Puedes arrastrarlo.";
    $("inLugarE").value = "";
    document.querySelectorAll("#segEnvio button").forEach((b) => b.classList.toggle("activa", b.dataset.tipo === "pin"));
    $("boxPinE").classList.remove("oculto");
    $("boxDirE").classList.add("oculto");
  }

  function setTipoLugarE(t) {
    tipoLugarE = t;
    document.querySelectorAll("#segEnvio button").forEach((b) => b.classList.toggle("activa", b.dataset.tipo === t));
    $("boxPinE").classList.toggle("oculto", t !== "pin");
    $("boxDirE").classList.toggle("oculto", t !== "direccion");
    if (t === "pin" && pantalla === "E2") iniciarMapaE();
  }
  document.querySelectorAll("#segEnvio button").forEach((b) => b.addEventListener("click", () => setTipoLugarE(b.dataset.tipo)));

  function iniciarMapaE() {
    if (typeof L === "undefined") {
      setTipoLugarE("direccion");
      document.querySelector('#segEnvio button[data-tipo="pin"]').classList.add("oculto");
      return;
    }
    if (!mapaE) {
      mapaE = L.map("mapaEnvio", { zoomControl: false }).setView(CENTRO_MAPA, 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapaE);
      mapaE.on("click", (ev) => colocarPinE(ev.latlng));
    }
    setTimeout(() => mapaE.invalidateSize(), 80);
  }

  function colocarPinE(ll) {
    pinE = { lat: redondear(ll.lat), lng: redondear(ll.lng) };
    if (!marcaE) {
      marcaE = L.marker(ll, { icon: iconoPin("wa-pin-cli", "📍"), draggable: true }).addTo(mapaE);
      marcaE.on("dragend", () => colocarPinE(marcaE.getLatLng()));
    } else marcaE.setLatLng(ll);
    $("ayudaPinE").textContent = "✅ Pin colocado. Puedes moverlo si hace falta.";
    errorPedido("");
  }

  function leerLugarE() {
    if (tipoLugarE === "pin") {
      if (!pinE) return falla(modoEnvio === "retiran" ? "Toca el mapa para colocar el pin del lugar de entrega." : "Toca el mapa para colocar el pin del lugar de retiro.");
      return { tipo: "pin", lat: pinE.lat, lng: pinE.lng };
    }
    const t = limpiarNombre($("inLugarE").value);
    if (t.length < 5) return falla("Escribe la dirección exacta (mínimo 5 letras).");
    return { tipo: "direccion", texto: t };
  }

  /* ---------- Armado del pedido ---------- */
  function armarPedidoCompra() {
    const quiere = limpiarNombre($("inQuiere").value), origen = limpiarNombre($("inOrigen").value);
    let destino = null;
    if (pantalla === "3r") {
      if (!gpsListo) return falla("Para recibir tu pedido necesitamos tu ubicación en tiempo real. Actívala para continuar.");
      destino = { tipo: "gps", lat: gpsListo.lat, lng: gpsListo.lng };
    } else if (tipoEnvio === "pin") {
      if (!pin) return falla("Toca el mapa para colocar el pin del lugar de entrega.");
      destino = { tipo: "pin", lat: pin.lat, lng: pin.lng };
    } else {
      const dir = limpiarNombre($("inDir").value);
      if (dir.length < 5) return falla("Escribe la dirección exacta (mínimo 5 letras).");
      destino = { tipo: "direccion", texto: dir };
    }
    return { tipo: "compra", quiere, origen, modo: pantalla === "3r" ? "recibe" : "envia", destino };
  }

  function armarPedidoEnvio() {
    const quiere = limpiarNombre($("inPaquete").value);
    if (quiere.length < 2) return falla("Cuéntanos qué vas a enviar.");

    if (modoEnvio === "texto") {
      const retiro = limpiarNombre($("inRetiroTxt").value), entrega = limpiarNombre($("inEntregaTxt").value);
      if (retiro.length < 2) return falla("Escribe el lugar de retiro.");
      if (entrega.length < 5) return falla("Escribe la dirección de entrega (mínimo 5 letras).");
      return {
        tipo: "envio", quiere, origen: retiro.slice(0, 120), modo: "envia",
        retiro: { tipo: "direccion", texto: retiro },
        destino: { tipo: "direccion", texto: entrega }
      };
    }

    if (!gpsListo) return falla("Necesitamos tu ubicación en tiempo real para este envío. Actívala para continuar.");
    const gps = { tipo: "gps", lat: gpsListo.lat, lng: gpsListo.lng };
    const lugar = leerLugarE();
    if (!lugar) return null;

    if (modoEnvio === "retiran") {
      return { tipo: "envio", quiere, origen: MARCA_GPS_RETIRO, modo: "envia", retiro: gps, destino: lugar };
    }
    const origen = lugar.tipo === "pin"
      ? "📍 Pin en el mapa (" + lugar.lat.toFixed(5) + ", " + lugar.lng.toFixed(5) + ")"
      : lugar.texto.slice(0, 120);
    return { tipo: "envio", quiere, origen, modo: "recibe", retiro: lugar, destino: gps };
  }

  /* ---------- Resumen automático del pedido ---------- */
  function enlaceMapa(l) { return "https://maps.google.com/?q=" + l.lat + "," + l.lng; }

  function lugarTexto(l) {
    if (!l || typeof l !== "object") return "";
    if (l.tipo === "direccion") return String(l.texto || "");
    if (okLL(l.lat, l.lng)) return (l.tipo === "gps" ? "Mi ubicación en vivo (GPS)" : "Pin en el mapa") + " · " + enlaceMapa(l);
    return "";
  }

  function armarResumen(p) {
    if (!p || typeof p !== "object") return "";
    const envio = p.tipo === "envio" || (!!p.retiro && p.tipo !== "compra");
    const entrega = lugarTexto(p.destino) || "Por confirmar";
    const lineas = [MARCA_RESUMEN];
    if (envio) {
      lineas.push(
        "📦 Servicio: Enviar algo (mándado / paquete)",
        "🧾 Paquete: " + String(p.quiere || ""),
        "⬆️ Retiro: " + (lugarTexto(p.retiro) || String(p.origen || "Por confirmar")),
        "🏁 Entrega: " + entrega
      );
    } else {
      lineas.push(
        "🍔 Servicio: Pedir algo (comida / compras)",
        "🛍️ Pedido: " + String(p.quiere || ""),
        "🏪 Comprar en: " + String(p.origen || ""),
        "📍 Entrega: " + entrega
      );
    }
    return lineas.join("\n").slice(0, MAX_TEXTO);
  }

  function guardarResumenLocal(p) {
    try { localStorage.setItem(CLAVE_RESUMEN, JSON.stringify({ id: perfil.solicitudId, texto: armarResumen(p) })); } catch (_) { }
  }

  function textoResumen() {
    try {
      const c = JSON.parse(localStorage.getItem(CLAVE_RESUMEN) || "null");
      if (c && perfil && c.id === perfil.solicitudId && typeof c.texto === "string" && c.texto) return c.texto;
    } catch (_) { }
    return armarResumen(pedidoActual);
  }

  function quitarResumenLocal() {
    if (resumenCard && resumenCard.parentNode) resumenCard.parentNode.removeChild(resumenCard);
    resumenCard = null;
  }

  /* Tarjeta fija al inicio del chat mientras el resumen real aún no se envía */
  function pintarResumenLocal() {
    if (resumenReal || cerrado) return;
    const cont = $("mensajes");
    if (resumenCard && cont.contains(resumenCard)) return;
    const texto = textoResumen();
    if (!texto) return;
    const card = document.createElement("div");
    card.className = "wa-msg yo resumen";
    const p = document.createElement("p");
    p.textContent = texto;
    const h = document.createElement("span");
    h.className = "wa-hora";
    h.textContent = "Resumen de tu solicitud";
    card.appendChild(p);
    card.appendChild(h);
    cont.insertBefore(card, cont.firstChild);
    resumenCard = card;
  }

  /* Cuando un repartidor atiende, el resumen se guarda como primer mensaje del chat */
  async function enviarResumenAlChat() {
    if (resumenEnviando || cerrado || !asignado || !refMensajes || !refSolicitud) return;
    const texto = textoResumen();
    if (!texto) return;
    resumenEnviando = true;
    try {
      const s = await refMensajes.limitToLast(300).once("value");
      let ya = false;
      s.forEach((c) => {
        const m = c.val();
        if (m && m.de === "cliente" && typeof m.texto === "string" && m.texto.indexOf(MARCA_RESUMEN) === 0) ya = true;
      });
      if (ya || cerrado || !asignado) return;
      const clave = refMensajes.push().key;
      const ts = firebase.database.ServerValue.TIMESTAMP;
      const cambios = {};
      cambios["mensajes/" + clave] = { de: "cliente", tipo: "texto", texto, ts };
      cambios["ultimoMensaje"] = "📋 Resumen del pedido";
      cambios["ultimoDe"] = "cliente";
      cambios["ts"] = ts;
      await refSolicitud.update(cambios);
    } catch (_) {
    } finally {
      resumenEnviando = false;
    }
  }

  /* ---------- Submit del pedido ---------- */
  $("formPedido").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (pantalla === "1") {
      const quiere = limpiarNombre($("inQuiere").value), origen = limpiarNombre($("inOrigen").value);
      if (quiere.length < 2) return errorPedido("Cuéntanos qué deseas.");
      if (origen.length < 2) return errorPedido("Indica de dónde lo deseas.");
      return irA("2");
    }

    let pedido = null;
    if (pantalla === "3r" || pantalla === "3e") pedido = armarPedidoCompra();
    else if (pantalla === "E2" || pantalla === "E3") pedido = armarPedidoEnvio();
    if (!pedido) return;

    const btn = $("btnSiguiente");
    btn.disabled = true;
    try {
      await crearSolicitud(pedido);
      guardarResumenLocal(pedido);
      guardarSesion({ estado: "nuevo" });
      if (pedido.tipo === "compra") guardarUltimaDireccion(pedido.destino);
    } catch (e) {
      btn.disabled = false;
      return errorPedido("No se pudo enviar tu pedido: " + (e.code || e.message));
    }
    btn.disabled = false;
    entrarAlChat();
  });

  /* ============================================================
     GPS en vivo del cliente
     ============================================================ */
  let watchId = null, ultimaEscritura = 0, ultimaEnviada = null;

  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  /* El cliente comparte su posición en vivo si es quien recibe (GPS) o si es el punto de retiro (GPS). */
  function comparteGps(p) {
    if (!p || typeof p !== "object") return false;
    const d = p.destino;
    if (p.modo === "recibe" && d && d.tipo === "gps") return true;
    if (p.retiro && p.retiro.tipo === "gps") return true;
    return typeof p.origen === "string" && p.origen.indexOf(MARCA_GPS_RETIRO) === 0;
  }

  function iniciarGps() {
    if (watchId !== null || cerrado || !navigator.geolocation) return;
    if (!comparteGps(pedidoActual)) return;
    watchId = navigator.geolocation.watchPosition(alPosicion, (e) => {
      if (e && e.code === 1) mostrarError("Activa el permiso de ubicación para que tu repartidor te encuentre.");
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
  function detenerGps() {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null; ultimaEscritura = 0; ultimaEnviada = null;
  }
  function alPosicion(p) {
    const pos = { lat: redondear(p.coords.latitude), lng: redondear(p.coords.longitude) };
    if (!okLL(pos.lat, pos.lng)) return;
    posCliente = pos;
    actualizarMapa();
    const ahora = Date.now();
    if (ahora - ultimaEscritura < 3000) return;
    if (ultimaEnviada && distanciaM(ultimaEnviada, pos) < 5 && ahora - ultimaEscritura < 20000) return;
    ultimaEscritura = ahora; ultimaEnviada = pos;
    if (refSolicitud) {
      refSolicitud.child("clienteGps").set({ lat: pos.lat, lng: pos.lng, prec: Math.round(p.coords.accuracy || 0), ts: firebase.database.ServerValue.TIMESTAMP }).catch(() => { });
    }
  }

  /* ============================================================
     MAPA DE SEGUIMIENTO DEL PEDIDO (Fase 1)
     - Pin minimalista blanco+color tipo WhatsApp (verde = repartidor, azul = cliente)
     - fitBounds inteligente: muestra ambos sin sacudir el mapa
     - Pin escalable: --pin-scale se recalcula en cada zoomend
     - Ruta OSRM con flechas + banner "X km · Y min · calle actual"
     ============================================================ */
  let mapa = null, marcaRep = null, marcaCli = null, posRep = null, encuadrado = false;
  let capaRuta = null, capaFlechas = null;
  let ultimaRutaFetch = 0, ultimaRutaPos = null, rutaDist = null, rutaDur = null, rutaCalle = "";
  let rutaInfoTimer = null;

  // Pin minimalista tipo WhatsApp: círculo blanco con anillo de color y punto central
  function iconoPinDiscreto(color, pulso = false, clase = "") {
    return L.divIcon({
      className: "",
      html: `<div class="pin-discreto${pulso ? " pulso" : ""}${clase ? " " + clase : ""}" style="--c: ${color}"></div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
  }

  /* FASE 1 · Escala del pin según el zoom: 0.75 en zoom 14, 1.0 en zoom 16, 1.3 en zoom 19 */
  function escalaPin(z) {
    return Math.max(0.75, Math.min(1.3, 0.75 + (z - 14) * 0.11));
  }
  function aplicarEscalaPin() {
    if (!mapa) return;
    const s = escalaPin(mapa.getZoom());
    mapa.getContainer().style.setProperty("--pin-scale", s.toFixed(2));
  }

  function escucharRepartidorGps() {
    refSolicitud.child("repartidorGps").on("value", (s) => {
      const g = s.val();
      posRep = g && okLL(g.lat, g.lng) ? { lat: g.lat, lng: g.lng } : null;
      actualizarMapa();
      revisarCercania();
    }, () => { });
  }

  function avisarCerca() {
    if (avisadoCerca || cerrado) return;
    avisadoCerca = true;
    avisoSistema("Tu repartidor está cerca de tu destino.");
    if (window.Voz) Voz.clienteRepartidorCerca();
  }

  function revisarCercania() {
    if (!asignado || avisadoCerca || !posRep) return;
    const c = puntoCliente();
    if (c && distanciaM(posRep, c) <= RADIO_CERCA_M) avisarCerca();
  }

  function setMapaVisible(v) {
    const abrir = !!v && typeof L !== "undefined";
    $("panelMapa").classList.toggle("oculto", !abrir);
    $("btnSeguir").setAttribute("aria-expanded", String(abrir));
    if (!abrir) return;

    if (!mapa) {
      mapa = L.map("mapaSeguir", { zoomControl: false }).setView(CENTRO_MAPA, 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);

      capaRuta = L.polyline([], { color: "#3B82F6", weight: 6, opacity: 0.85, lineCap: "round" }).addTo(mapa);
      capaFlechas = L.layerGroup().addTo(mapa);

      mapa.on("dragstart zoomstart", () => { mapa._lastUserMove = Date.now(); });
      mapa.on("zoomend", aplicarEscalaPin);   // FASE 1: pin escalable
      aplicarEscalaPin();
    }

    setTimeout(() => { mapa.invalidateSize(); encuadrado = false; actualizarMapa(); }, 60);
  }

  $("btnSeguir").addEventListener("click", () => setMapaVisible(true));
  $("btnCerrarMapa").addEventListener("click", () => setMapaVisible(false));
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("panelMapa").classList.contains("oculto")) setMapaVisible(false);
  });

  function puntoCliente() {
    if (posCliente) return posCliente;
    const p = pedidoActual || {};
    const d = p.retiro && p.retiro.tipo === "gps" ? p.retiro : p.destino;
    return d && okLL(d.lat, d.lng) ? { lat: d.lat, lng: d.lng } : null;
  }

  function ponerMarca(marca, punto, icono) {
    if (!punto) { if (marca) mapa.removeLayer(marca); return null; }
    if (!marca) return L.marker([punto.lat, punto.lng], { icon: icono, interactive: false }).addTo(mapa);
    marca.setLatLng([punto.lat, punto.lng]);
    return marca;
  }

  function ajustarEncuadre(pts, forzar) {
    if (!mapa || !pts || !pts.length) return;
    const ahora = Date.now();
    if (!forzar && mapa._lastUserMove && ahora - mapa._lastUserMove < 8000) return;

    if (pts.length === 1) {
      if (!forzar && encuadrado) return;
      mapa.setView(pts[0], 16, { animate: true, duration: 0.6 });
      encuadrado = true;
      return;
    }

    if (!forzar && encuadrado) {
      const v = mapa.getBounds();
      const b = L.latLngBounds(pts);
      const ne = v.getNorthEast(), sw = v.getSouthWest();
      const neD = b.getNorthEast(), swD = b.getSouthWest();
      const padLat = (ne.lat - sw.lat) * 0.08;
      const padLng = (ne.lng - sw.lng) * 0.08;
      if (neD.lat < ne.lat - padLat && swD.lat > sw.lat + padLat &&
          neD.lng < ne.lng - padLng && swD.lng > sw.lng + padLng) return;
    }

    mapa.fitBounds(L.latLngBounds(pts), {
      padding: [50, 50],
      maxZoom: 17,
      animate: true,
      duration: 0.8
    });
    encuadrado = true;
  }

  function actualizarMapa() {
    if (!mapa || $("panelMapa").classList.contains("oculto")) return;

    const c = puntoCliente();
    marcaCli = ponerMarca(marcaCli, c, iconoPinDiscreto(COLOR_PIN_CLI, false, "cli"));
    marcaRep = ponerMarca(marcaRep, posRep, iconoPinDiscreto(COLOR_PIN_REP, true, "rep"));

    $("estadoMapa").classList.toggle("oculto", !!posRep);

    /* FASE 1: primer encuadre forzado cuando ambos están presentes */
    const pts = [c, posRep].filter(Boolean);
    const forzar = pts.length === 2 && !encuadrado;
    ajustarEncuadre(pts, forzar);

    if (c && posRep) {
      trazarRutaCliente(posRep, c);
    } else {
      if (capaRuta) capaRuta.setLatLngs([]);
      if (capaFlechas) capaFlechas.clearLayers();
      ocultarInfoRuta();
    }
  }

  /* ---------- Ruta por calles con flechas e indicaciones ---------- */
  async function trazarRutaCliente(rep, cli) {
    const ahora = Date.now();
    if (ultimaRutaPos && distanciaM(ultimaRutaPos, rep) < 30 && ahora - ultimaRutaFetch < 15000) return;
    if (ahora - ultimaRutaFetch < 5000) return;
    ultimaRutaFetch = ahora;
    ultimaRutaPos = rep;

    try {
      if (typeof Ruta === "undefined" || typeof Ruta.pedir !== "function") throw new Error("módulo Ruta no disponible");
      const r = await Ruta.pedir(rep, cli);
      if (!r || !r.pts) throw new Error("sin ruta");
      if (capaRuta) {
        capaRuta.setStyle({ color: "#3B82F6", dashArray: null, opacity: 0.85 });
        capaRuta.setLatLngs([[rep.lat, rep.lng], ...r.pts]);
      }
      if (capaFlechas && typeof Ruta.flechas === "function") {
        Ruta.flechas(r.pts, capaFlechas, "#3B82F6");
      }
      rutaDist = r.dist;
      rutaDur = r.dur;
      rutaCalle = (typeof Ruta.calles === "function") ? Ruta.calles(r.pasos || []) : "";
      pintarInfoRuta();
    } catch (e) {
      console.warn("Ruta OSRM:", e && e.message);
      if (capaRuta) {
        capaRuta.setStyle({ color: "#94A3B8", dashArray: "6 10", opacity: 0.7 });
        capaRuta.setLatLngs([[rep.lat, rep.lng], [cli.lat, cli.lng]]);
      }
      if (capaFlechas) capaFlechas.clearLayers();
      rutaDist = null; rutaDur = null; rutaCalle = "";
      ocultarInfoRuta();
    }
  }

  function pintarInfoRuta() {
    const el = $("rutaInfo");
    if (!el) return;
    if (rutaDist == null || rutaDur == null) { el.classList.add("oculto"); return; }
    const fmtDist = rutaDist >= 1000 ? (rutaDist / 1000).toFixed(1) + " km" : Math.round(rutaDist) + " m";
    const min = Math.max(1, Math.round(rutaDur / 60));
    const calles = rutaCalle ? " · " + rutaCalle : "";
    el.innerHTML = '<span class="ri-ic">🚗</span><span class="ri-txt"><b>' + fmtDist + "</b> · " + min + " min" + calles + "</span>";
    el.classList.remove("oculto");
    clearTimeout(rutaInfoTimer);
    rutaInfoTimer = setTimeout(ocultarInfoRuta, 8000);
  }

  function ocultarInfoRuta() {
    const el = $("rutaInfo");
    if (el) el.classList.add("oculto");
    clearTimeout(rutaInfoTimer);
    rutaInfoTimer = null;
  }

  function limpiarMapa() {
    if (mapa) {
      if (marcaCli) mapa.removeLayer(marcaCli);
      if (marcaRep) mapa.removeLayer(marcaRep);
      if (capaRuta) mapa.removeLayer(capaRuta);
      if (capaFlechas) mapa.removeLayer(capaFlechas);
    }
    marcaCli = null; marcaRep = null; posRep = null; encuadrado = false;
    capaRuta = null; capaFlechas = null;
    ultimaRutaFetch = 0; ultimaRutaPos = null;
    rutaDist = null; rutaDur = null; rutaCalle = "";
    ocultarInfoRuta();
    setMapaVisible(false);
  }

  /* ---------- Cancelar ---------- */
  $("btnCancelar").addEventListener("click", async () => {
    if (!refSolicitud || asignado || cerrado) return;
    if (!confirm("¿Cancelar tu solicitud? Dejaremos de buscar repartidor.")) return;
    const btn = $("btnCancelar");
    btn.disabled = true;
    mostrarError("");
    try {
      const s = await refSolicitud.once("value");
      const d = s.val() || {};
      if (d.repartidorUid) { btn.disabled = false; return mostrarError("Un repartidor acaba de tomar tu pedido. Ya no se puede cancelar desde aquí."); }
      await refSolicitud.update({ estado: "cancelado", canceladoPor: "cliente", ts: firebase.database.ServerValue.TIMESTAMP });
    } catch (e) {
      btn.disabled = false;
      mostrarError("No se pudo cancelar: " + (e.code || e.message));
    }
  });

  function pintarResumen() {
    const e = $("resumenPedido"), p = pedidoActual;
    e.textContent = p ? String(p.quiere || "") + " · de " + String(p.origen || "") : "";
    e.classList.toggle("oculto", !p);
  }

  /* ============================================================
     Fotos (cámara o galería)
     ============================================================ */
  function comprimirImagen(archivo) {
    return new Promise((ok, fallo) => {
      if (!archivo || !/^image\//.test(archivo.type)) return fallo(new Error("tipo"));
      const url = URL.createObjectURL(archivo);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let lado = 960;
        for (let i = 0; i < 5; i++) {
          const k = Math.min(1, lado / Math.max(img.width, img.height));
          const c = document.createElement("canvas");
          c.width = Math.max(1, Math.round(img.width * k));
          c.height = Math.max(1, Math.round(img.height * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          const salida = c.toDataURL("image/jpeg", 0.7);
          if (salida.length <= MAX_FOTO) return ok(salida);
          lado = Math.round(lado * 0.75);
        }
        fallo(new Error("grande"));
      };
      img.onerror = () => { URL.revokeObjectURL(url); fallo(new Error("lectura")); };
      img.src = url;
    });
  }

  $("btnFoto").addEventListener("click", () => { if (asignado) $("inFoto").click(); });
  $("inFoto").addEventListener("change", async () => {
    const archivo = $("inFoto").files && $("inFoto").files[0];
    $("inFoto").value = "";
    if (!archivo || !asignado || !refMensajes) return;
    mostrarError("");
    let foto;
    try { foto = await comprimirImagen(archivo); }
    catch (_) { return mostrarError("No se pudo preparar la foto. Prueba con otra."); }

    const clave = refMensajes.push().key;
    const ts = firebase.database.ServerValue.TIMESTAMP;
    const base = RAIZ + "/" + perfil.solicitudId, cambios = {};
    cambios[RAIZ_FOTOS + "/" + perfil.solicitudId + "/" + clave] = foto;
    cambios[base + "/mensajes/" + clave] = { de: "cliente", tipo: "foto", ts };
    cambios[base + "/ultimoMensaje"] = "📷 Foto";
    cambios[base + "/ultimoDe"] = "cliente";
    cambios[base + "/ts"] = ts;
    try { await db.ref().update(cambios); }
    catch (e) { mostrarError("No se pudo enviar la foto: " + (e.code || e.message)); }
  });

  /* ============================================================
     Cierre del ciclo
     ============================================================ */
  function cerrarCiclo(d) {
    const entregado = d.estado === "entregado";
    if (!cerrado) {
      cerrado = true;
      detenerGps();
      if (refMensajes) refMensajes.off();
      $("mensajes").textContent = "";
      resumenCard = null;
      ultimoDe = null; ultimoDia = null;
      $("vChat").classList.add("cerrado");
      setMapaVisible(false);
      mostrarError("");
      $("btnCambiarNombre").classList.add("oculto");
    }
    const est = d.valoracion && Number(d.valoracion.estrellas);
    $("cierreIcono").textContent = entregado ? "✅" : "🚫";
    $("cierreTitulo").textContent = entregado ? "¡Pedido entregado!" : "Pedido cancelado";
    $("cierreSub").textContent = entregado ? "¿Cómo estuvo tu repartidor?" : "Tu pedido fue cancelado. Puedes pedir de nuevo cuando quieras.";
    $("boxEstrellas").classList.toggle("oculto", !entregado);
    if (est >= 1 && est <= 5) {
      valorada = true;
      pintarEstrellas(est, true);
      mensajeValoracion("¡Gracias por tu valoración!");
    } else if (!valorada) {
      pintarEstrellas(0, false);
      $("msgValoracion").classList.add("oculto");
    }
    $("vCierre").classList.remove("oculto");
  }

  function pintarEstrellas(n, bloquear) {
    document.querySelectorAll("#boxEstrellas .wa-estrella").forEach((b) => {
      const k = Number(b.dataset.n);
      b.classList.toggle("on", k <= n);
      b.setAttribute("aria-checked", String(k === n));
      b.disabled = !!bloquear;
    });
  }

  function mensajeValoracion(texto, error) {
    const e = $("msgValoracion");
    e.textContent = texto;
    e.className = "wa-estado" + (error ? " error" : "");
  }

  document.querySelectorAll("#boxEstrellas .wa-estrella").forEach((b) => b.addEventListener("click", async () => {
    if (valorada || !refSolicitud) return;
    const n = Number(b.dataset.n);
    valorada = true;
    pintarEstrellas(n, true);
    try {
      const e = await refSolicitud.child("estado").once("value");
      if (e.exists()) {
        await refSolicitud.child("valoracion").set({ estrellas: n, ts: firebase.database.ServerValue.TIMESTAMP });
      }
      mensajeValoracion("¡Gracias por tu valoración!");
    } catch (err) {
      valorada = false;
      pintarEstrellas(0, false);
      mensajeValoracion("No se pudo guardar tu valoración: " + (err.code || err.message), true);
    }
  }));

  $("btnNuevo").addEventListener("click", () => {
    detenerTodo();
    cerrado = false; valorada = false;
    $("btnCancelar").disabled = false;
    $("vCierre").classList.add("oculto");
    $("vChat").classList.remove("cerrado");
    borrarSesion();
    perfil = { id: generarId(), nombre: perfil.nombre, solicitudId: null };
    guardarPerfil(perfil);
    abrirChat();
  });

  /* ============================================================
     Cambiar mi nombre
     ============================================================ */
  function abrirCambiarNombre() {
    if (!refSolicitud || asignado || cerrado) return;
    $("inNuevoNombre").value = perfil.nombre || "";
    $("msgNuevoNombre").classList.add("oculto");
    $("modalNombre").classList.remove("oculto");
    setTimeout(() => $("inNuevoNombre").focus(), 60);
  }
  function cerrarCambiarNombre() { $("modalNombre").classList.add("oculto"); }

  $("btnCambiarNombre").addEventListener("click", abrirCambiarNombre);
  $("btnCancelarNombre").addEventListener("click", cerrarCambiarNombre);

  $("btnGuardarNombre").addEventListener("click", async () => {
    const n = limpiarNombre($("inNuevoNombre").value);
    const msg = $("msgNuevoNombre");
    if (!nombreValido(n)) {
      msg.textContent = "Escribe un nombre de 2 a 24 letras.";
      msg.classList.remove("oculto");
      return;
    }
    if (n === perfil.nombre) { return cerrarCambiarNombre(); }
    const btn = $("btnGuardarNombre");
    btn.disabled = true;
    try {
      const s = await refSolicitud.once("value");
      const d = s.val() || {};
      if (d.estado !== "nuevo" || d.repartidorUid) {
        btn.disabled = false;
        msg.textContent = "Un repartidor ya tomó tu pedido: no se puede cambiar el nombre.";
        msg.classList.remove("oculto");
        return;
      }
      await refSolicitud.update({ nombre: n });
      perfil.nombre = n;
      guardarPerfil(perfil);
      cerrarCambiarNombre();
      avisoSistema("Tu nombre ahora es " + n + ".");
    } catch (e) {
      btn.disabled = false;
      msg.textContent = "No se pudo cambiar el nombre: " + (e.code || e.message);
      msg.classList.remove("oculto");
      return;
    }
    btn.disabled = false;
  });

  /* ============================================================
     Teclado táctil (window.visualViewport) y reanudación de sesión
     - --vvh / --vvt siguen el área realmente visible (el teclado no tapa nada).
     - body.teclado compacta modales y mapas mientras el teclado está abierto.
     - Los campos enfocados se centran en su hoja; los botones quedan fijos abajo.
     ============================================================ */
  const esCampo = (n) => !!n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA");

  function mostrarCampo(campo) {
    if (!campo || !campo.isConnected) return;
    const dentroModal = !!campo.closest(".wa-hoja, .wa-nombre-caja");
    try { campo.scrollIntoView({ block: dentroModal ? "center" : "nearest", behavior: "auto" }); }
    catch (_) { campo.scrollIntoView(); }
  }

  let rafViewport = 0;
  function ajustarViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const raiz = document.documentElement.style;
    const pegado = pegadoAlFinal();
    raiz.setProperty("--vvh", Math.round(vv.height) + "px");
    raiz.setProperty("--vvt", Math.round(vv.offsetTop) + "px");
    document.body.classList.toggle("teclado", window.innerHeight - vv.height > 120);
    const activo = document.activeElement;
    if (esCampo(activo)) {
      setTimeout(() => {
        mostrarCampo(activo);
        if (pegado && !$("vChat").classList.contains("oculto")) alFinal();
      }, 60);
    }
    window.scrollTo(0, 0);
  }
  function programarViewport() {
    cancelAnimationFrame(rafViewport);
    rafViewport = requestAnimationFrame(ajustarViewport);
  }

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", programarViewport);
    window.visualViewport.addEventListener("scroll", programarViewport);
    window.addEventListener("orientationchange", () => setTimeout(ajustarViewport, 300));
    ajustarViewport();
  }
  document.addEventListener("focusin", (ev) => {
    if (!esCampo(ev.target)) return;
    setTimeout(() => { ajustarViewport(); mostrarCampo(ev.target); }, 320);
  });
  document.addEventListener("focusout", () => {
    setTimeout(() => { if (!esCampo(document.activeElement)) ajustarViewport(); }, 120);
  });

  /* Al volver a la app (pestaña recuperada, pantalla desbloqueada) se reanuda el GPS en vivo. */
  function reanudar() {
    if (!refSolicitud || cerrado || !pedidoActual) return;
    iniciarGps();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reanudar(); });
  window.addEventListener("pageshow", (ev) => { if (ev.persisted) reanudar(); });

  arrancar();
})();
