/* ============================================================
   CLIENTE — chat tipo WhatsApp + seguimiento en vivo (Fase 1)
   Flujo:
     1) Sesión anónima de Firebase.
     2) Lee el perfil de LocalStorage. Si no existe o está dañado → genera ID único y pide el nombre.
     3) Crea (o retoma) el chat en  solicitudes_entrantes/{solicitudId}.
     4) Antes de crear el chat, el chat inicial pregunta «¿Qué deseas hoy?» con 4 botones:
        Enviar · Retirar · Pedir Comida · Pickup (mototaxi). Cada opción abre un flujo paso a paso
        dentro del propio chat (GPS en vivo, pin en el mapa, dirección escrita o texto libre).
        El resumen del pedido queda como primer mensaje del chat al ser atendido.
        La conversación inicial se guarda en localStorage (se retoma tras un cierre accidental) y,
        al enviar, queda al inicio del chat junto al resumen. La solicitud estructurada se envía a
        Firebase y se muestra «Buscando un repartidor para tu pedido» / «Buscando un conductor para tu pickup».
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
  const URL_AVISO_ADMIN = "https://brothers-push.jhosxan.workers.dev";   // Worker de Cloudflare: avisa por push al administrador al instante
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

  /* ---------- Textos de búsqueda según el servicio (pickup → conductor) ---------- */
  const esPickup = () => !!pedidoActual && pedidoActual.servicio === "pickup";
  function textoBusqueda() {
    return esPickup()
      ? { titulo: "Buscando un conductor para tu pickup", sub: "Buscando conductor…", espera: "Esperando conductor…", quien: "conductor" }
      : { titulo: "Buscando un repartidor para tu pedido", sub: "Buscando repartidor…", espera: "Esperando repartidor…", quien: "repartidor" };
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
      const { tipo, retiro, servicio: _srv, contacto: _ctc, ...anterior } = pedido;
      await refSolicitud.set({ ...base, pedido: anterior });
    }
    avisarServidorSolicitud();
  }

  /* Push INSTANTÁNEO al administrador (app cerrada / celular en reposo). Si falla no pasa nada: el Worker también revisa cada minuto. */
  function avisarServidorSolicitud() {
    try {
      if (!perfil || !perfil.solicitudId) return;
      fetch(URL_AVISO_ADMIN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accion: "solicitud_nueva", solicitud: perfil.solicitudId }),
        keepalive: true
      }).catch(() => {});
    } catch (_) {}
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
      pintarHistorialLocal();
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
    const tb = textoBusqueda();
    $("avisoTitulo").textContent = tb.titulo;
    if (!conRepartidor) $("subChat").textContent = tb.sub;
    pintarAvatar(conRepartidor && typeof uidRep === "string" ? uidRep : null, nombreRep);
    const inp = $("inMensaje");
    inp.disabled = !conRepartidor;
    $("btnEnviar").disabled = !conRepartidor;
    $("btnFoto").disabled = !conRepartidor;
    $("btnSeguir").classList.toggle("oculto", !conRepartidor || typeof L === "undefined");
    inp.placeholder = conRepartidor ? "Escribe un mensaje" : tb.espera;
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
      sub.textContent = textoBusqueda().sub;
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
     Chat inicial: «¿Qué deseas hoy?» + flujos conversacionales
     Enviar · Retirar · Pedir Comida · Pickup (mototaxi)
     - Cada respuesta del cliente es una burbuja verde; el bot pregunta paso a paso.
     - Todo (burbujas + datos ya respondidos) se guarda en localStorage: si el cliente cierra
       la página a medias, la conversación se retoma justo donde quedó.
     - Al completar el flujo se consolida el pedido, se envía a Firebase (Admin/Repartidores)
       y el chat muestra la pantalla de búsqueda.
     ============================================================ */
  const MARCA_RESUMEN = "📋 RESUMEN DEL PEDIDO";
  const MARCA_GPS_RETIRO = "📍 Mi ubicación actual (retiro)";
  const CLAVE_RESUMEN = "brothers_resumen_pedido";
  const CLAVE_CONVO = "brothers_conversacion_v1";
  const CLAVE_HISTORIAL = "brothers_historial_chat";
  const CADUCA_CONVO_MS = 12 * 3600 * 1000;
  const MAX_LOG = 80;
  const SERVICIOS = ["enviar", "retirar", "comida", "pickup"];

  const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const redondear = (n) => Math.round(n * 1e6) / 1e6;
  const iconoPin = (clase, emoji) => L.divIcon({ className: "", html: '<div class="wa-pin ' + clase + '">' + emoji + "</div>", iconSize: [40, 40], iconAnchor: [20, 20] });
  const pausaSplash = () => new Promise((ok) => setTimeout(ok, 900));
  const pausa = (ms) => new Promise((ok) => setTimeout(ok, ms));

  const nuevosDatos = (s) => ({ servicio: s, dichos: {}, v: {}, log: [] });
  let datos = nuevosDatos(null);
  let gpsListo = null, convId = 0, pendTexto = null, mapaConv = null;
  const vivo = (id) => id === convId;

  /* ---------- Persistencia de la conversación (localStorage) ---------- */
  function guardarConvo() {
    if (!perfil || !datos.servicio) return;
    const o = { clienteId: perfil.id, ts: Date.now(), servicio: datos.servicio, dichos: datos.dichos, v: datos.v, log: datos.log.slice(-MAX_LOG) };
    try { localStorage.setItem(CLAVE_CONVO, JSON.stringify(o)); } catch (_) { }
  }

  function leerConvo() {
    try {
      const o = JSON.parse(localStorage.getItem(CLAVE_CONVO) || "null");
      if (o && typeof o === "object" && perfil && o.clienteId === perfil.id && SERVICIOS.indexOf(o.servicio) >= 0
        && Number.isFinite(o.ts) && Date.now() - o.ts < CADUCA_CONVO_MS && Array.isArray(o.log)
        && o.dichos && typeof o.dichos === "object" && o.v && typeof o.v === "object") {
        o.log = o.log.filter((e) => e && (e.c === "bot" || e.c === "yo") && typeof e.t === "string" && Number.isFinite(e.ts)).slice(-MAX_LOG);
        return o;
      }
    } catch (_) { }
    return null;
  }

  function borrarConvo() { try { localStorage.removeItem(CLAVE_CONVO); } catch (_) { } }

  function guardarHistorial() {
    if (!perfil || !perfil.solicitudId) return;
    try { localStorage.setItem(CLAVE_HISTORIAL, JSON.stringify({ solicitudId: perfil.solicitudId, log: datos.log.slice(-MAX_LOG) })); } catch (_) { }
  }
  function leerHistorial() {
    try {
      const o = JSON.parse(localStorage.getItem(CLAVE_HISTORIAL) || "null");
      if (o && perfil && o.solicitudId === perfil.solicitudId && Array.isArray(o.log)) {
        return o.log.filter((e) => e && (e.c === "bot" || e.c === "yo") && typeof e.t === "string" && Number.isFinite(e.ts));
      }
    } catch (_) { }
    return [];
  }
  function borrarHistorial() { try { localStorage.removeItem(CLAVE_HISTORIAL); } catch (_) { } }

  function guardar(clave, valor) { datos.v[clave] = valor; guardarConvo(); }

  /* ---------- Burbujas ---------- */
  function bajar() {
    const f = $("formPedido");
    requestAnimationFrame(() => { f.scrollTop = f.scrollHeight; });
  }

  function crearBurbuja(clase, texto, ts, quieta) {
    const d = document.createElement("div");
    d.className = clase + (quieta ? " sin-anim" : "");
    const p = document.createElement("p");
    p.textContent = texto;
    const t = document.createElement("span");
    t.className = "wa-hora";
    t.textContent = hora(ts);
    d.appendChild(p);
    d.appendChild(t);
    return d;
  }

  /* nuevo=false: burbuja restaurada, no se vuelve a registrar */
  function burbuja(clase, texto, nuevo) {
    const ts = Date.now();
    $("convo").appendChild(crearBurbuja(clase, texto, ts, nuevo === false));
    if (nuevo !== false) {
      datos.log.push({ c: clase === "wa-burbuja-yo" ? "yo" : "bot", t: texto, ts });
      guardarConvo();
    }
    bajar();
  }
  const addBot = (texto, nuevo) => burbuja("wa-burbuja-bot", texto, nuevo);
  const addYo = (texto, nuevo) => burbuja("wa-burbuja-yo", texto, nuevo);

  /* El bot «escribe…» un instante y responde. Si trae `clave` y ya la dijo antes (conversación
     retomada), no la repite. Devuelve false si la conversación se reinició. */
  async function di(id, texto, clave) {
    if (!vivo(id)) return false;
    if (clave && datos.dichos[clave]) return true;
    const e = document.createElement("div");
    e.className = "wa-burbuja-bot wa-escribiendo";
    e.setAttribute("aria-hidden", "true");
    e.innerHTML = '<span class="wa-puntos"><i></i><i></i><i></i></span>';
    $("convo").appendChild(e);
    bajar();
    await pausa(420);
    e.remove();
    if (!vivo(id)) return false;
    if (clave) datos.dichos[clave] = true;
    addBot(texto);
    return true;
  }

  /* Botones de respuesta rápida dentro del hilo. Resuelve con la clave elegida. */
  function opciones(id, lista) {
    return new Promise((res) => {
      if (!vivo(id)) return;
      const g = document.createElement("div");
      g.className = "wa-quick wa-quick-hilo";
      g.setAttribute("role", "group");
      lista.forEach((o) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "wa-quick-btn";
        b.textContent = o.texto;
        b.addEventListener("click", () => {
          if (!vivo(id)) return;
          g.remove();
          addYo(o.texto);
          res(o.clave);
        });
        g.appendChild(b);
      });
      $("convo").appendChild(g);
      bajar();
    });
  }

  /* Respuesta escrita: habilita el compositor inferior hasta que el cliente envía. */
  function apagarComposer() {
    const i = $("inConvo");
    i.value = ""; i.disabled = true; i.placeholder = "Elige una opción…";
    $("btnConvo").disabled = true;
  }

  function pedirTexto(id, placeholder, min, errorMsg, max) {
    return new Promise((res) => {
      if (!vivo(id)) return;
      pendTexto = { id, min, max: max || 200, errorMsg, res };
      const i = $("inConvo");
      i.disabled = false; i.value = ""; i.placeholder = placeholder;
      $("btnConvo").disabled = false;
      setTimeout(() => i.focus(), 60);
    });
  }

  $("formConvo").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = pendTexto;
    if (!p || !vivo(p.id)) return;
    const t = limpiarNombre($("inConvo").value);
    if (t.length < p.min) { addBot(p.errorMsg); return; }
    pendTexto = null;
    apagarComposer();
    addYo(t);
    p.res(t.slice(0, p.max));
  });

  /* ---------- GPS en tiempo real ---------- */
  function geoUna() {
    return new Promise((ok) => {
      if (!navigator.geolocation) return ok({ ok: false, code: 0 });
      navigator.geolocation.getCurrentPosition(
        (p) => ok({ ok: true, pos: { lat: redondear(p.coords.latitude), lng: redondear(p.coords.longitude) } }),
        (e) => ok({ ok: false, code: e && e.code }),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  /* Obliga a tener la ubicación en vivo. Devuelve {lat,lng} o null si la conversación se reinició. */
  async function obtenerGps(id) {
    let primera = true;
    while (vivo(id)) {
      if (primera) { if (!(await di(id, "📡 Activando tu ubicación en tiempo real…"))) return null; primera = false; }
      const r = await geoUna();
      if (!vivo(id)) return null;
      if (r.ok) {
        gpsListo = r.pos;
        addBot("✅ Ubicación lista. Tu repartidor te verá en el mapa mientras tu pedido esté en curso.");
        return gpsListo;
      }
      addBot(r.code === 1
        ? "Tu ubicación está bloqueada. Permite la ubicación para este sitio en los ajustes de tu navegador y toca «Reintentar»."
        : "No pude obtener tu ubicación. Enciende el GPS de tu celular y toca «Reintentar».");
      const c = await opciones(id, [{ clave: "r", texto: "📍 Reintentar ubicación" }, { clave: "x", texto: "↩️ Volver al inicio" }]);
      if (c === "x") { reiniciarConvo(); return null; }
    }
    return null;
  }

  /* ---------- Mapa dentro del chat ---------- */
  function mapaBurbuja(id) {
    return new Promise((res) => {
      if (!vivo(id)) return;
      if (typeof L === "undefined") { addBot("El mapa no está disponible ahora. Escribe la dirección exacta."); return res(null); }
      const caja = document.createElement("div");
      caja.className = "wa-burbuja-bot wa-burbuja-mapa";
      const ayuda = document.createElement("p");
      ayuda.textContent = "🗺️ Toca el mapa para colocar el pin. Puedes arrastrarlo para ajustarlo.";
      const cont = document.createElement("div");
      cont.className = "wa-pin-mapa";
      cont.setAttribute("aria-label", "Mapa para colocar el pin");
      const acc = document.createElement("div");
      acc.className = "wa-mapa-acc";
      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "primario"; ok.textContent = "✅ Confirmar ubicación"; ok.disabled = true;
      const no = document.createElement("button");
      no.type = "button"; no.textContent = "Cancelar";
      acc.appendChild(ok); acc.appendChild(no);
      caja.appendChild(ayuda); caja.appendChild(cont); caja.appendChild(acc);
      $("convo").appendChild(caja);
      bajar();

      const centro = gpsListo ? [gpsListo.lat, gpsListo.lng] : CENTRO_MAPA;
      const m = L.map(cont, { zoomControl: false }).setView(centro, gpsListo ? 16 : 14);
      mapaConv = m;
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
      let marca = null, punto = null;
      const poner = (ll) => {
        punto = { lat: redondear(ll.lat), lng: redondear(ll.lng) };
        if (!marca) {
          marca = L.marker(ll, { icon: iconoPin("wa-pin-cli", "📍"), draggable: true }).addTo(m);
          marca.on("dragend", () => poner(marca.getLatLng()));
        } else marca.setLatLng(ll);
        ayuda.textContent = "✅ Pin colocado. Puedes moverlo si hace falta y luego confirmar.";
        ok.disabled = false;
      };
      m.on("click", (ev) => poner(ev.latlng));
      setTimeout(() => m.invalidateSize(), 150);

      const cerrar = () => { try { m.remove(); } catch (_) { } if (mapaConv === m) mapaConv = null; caja.remove(); };
      ok.addEventListener("click", () => {
        if (!punto || !vivo(id)) return;
        const r = punto;
        cerrar();
        addYo("📍 Pin marcado en el mapa");
        res(r);
      });
      no.addEventListener("click", () => {
        if (!vivo(id)) return;
        cerrar();
        res(null);
      });
    });
  }

  /* ---------- Pedir un lugar: GPS en vivo / pin / dirección escrita / última dirección ---------- */
  async function pedirLugar(id, cfg) {
    if (!(await di(id, cfg.pregunta, cfg.clave))) return null;
    const ult = cfg.ultima ? leerUltimaDirLocal() : null;
    let ultTxt = "";
    if (ult && ult.tipo === "direccion" && ult.texto) ultTxt = "🕘 Usar: " + String(ult.texto).slice(0, 38);
    else if (ult && ult.tipo === "pin" && okLL(Number(ult.lat), Number(ult.lng))) ultTxt = "🕘 Usar mi último pin";
    const ops = [];
    if (cfg.gps) ops.push({ clave: "gps", texto: "📍 Mi ubicación en vivo" });
    ops.push({ clave: "pin", texto: "🗺️ Marcar en el mapa" }, { clave: "dir", texto: "🏠 Escribir dirección" });
    if (ultTxt) ops.push({ clave: "ult", texto: ultTxt });

    while (vivo(id)) {
      const c = await opciones(id, ops);
      if (!vivo(id)) return null;
      if (c === "gps") {
        if (!(await di(id, "Perfecto, usaré tu ubicación en tiempo real."))) return null;
        const g = await obtenerGps(id);
        if (!g) return null;
        return { tipo: "gps", lat: g.lat, lng: g.lng };
      }
      if (c === "pin") {
        const p = await mapaBurbuja(id);
        if (!vivo(id)) return null;
        if (p) return { tipo: "pin", lat: p.lat, lng: p.lng };
        continue;
      }
      if (c === "dir") {
        if (!(await di(id, "Escribe la dirección exacta: calle, barrio y una referencia (por ejemplo, «frente a la pulpería»)."))) return null;
        const t = await pedirTexto(id, "Calle, número, referencia", 5, "Escribe la dirección con un poco más de detalle (mínimo 5 letras).");
        if (!vivo(id)) return null;
        return { tipo: "direccion", texto: t.slice(0, 200) };
      }
      if (c === "ult" && ult) {
        if (!(await di(id, "Listo, usaré esa dirección."))) return null;
        return ult.tipo === "pin" ? { tipo: "pin", lat: Number(ult.lat), lng: Number(ult.lng) } : { tipo: "direccion", texto: String(ult.texto).slice(0, 200) };
      }
    }
    return null;
  }

  function origenTexto(l) {
    if (!l) return "Por confirmar";
    if (l.tipo === "gps") return MARCA_GPS_RETIRO;
    if (l.tipo === "pin") return "📍 Pin en el mapa (" + Number(l.lat).toFixed(5) + ", " + Number(l.lng).toFixed(5) + ")";
    return String(l.texto || "Por confirmar").slice(0, 120);
  }

  /* ---------- Consolidación del pedido: valida y deja la estructura exacta que acepta Firebase ---------- */
  function consolidarPedido(p) {
    const lug = (l, nombre) => {
      if (!l || typeof l !== "object") throw new Error("Falta " + nombre + ".");
      if (l.tipo === "direccion") {
        const t = limpiarNombre(l.texto).slice(0, 200);
        if (t.length < 5) throw new Error("La dirección de " + nombre + " es muy corta.");
        return { tipo: "direccion", texto: t };
      }
      if ((l.tipo === "gps" || l.tipo === "pin") && okLL(Number(l.lat), Number(l.lng))) {
        return { tipo: l.tipo, lat: redondear(Number(l.lat)), lng: redondear(Number(l.lng)) };
      }
      throw new Error("La ubicación de " + nombre + " no es válida.");
    };
    if (SERVICIOS.indexOf(p.servicio) < 0) throw new Error("Servicio desconocido.");
    const quiere = limpiarNombre(p.quiere).slice(0, 200), origen = limpiarNombre(p.origen).slice(0, 120);
    if (quiere.length < 2 || origen.length < 2) throw new Error("Faltan datos del pedido.");
    const o = {
      servicio: p.servicio, tipo: p.tipo === "compra" ? "compra" : "envio", quiere, origen,
      modo: p.modo === "recibe" ? "recibe" : "envia", destino: lug(p.destino, "entrega")
    };
    if (p.retiro) o.retiro = lug(p.retiro, "retiro");
    const contacto = limpiarNombre(p.contacto).slice(0, 80);
    if (contacto.length >= 2) o.contacto = contacto;
    return o;
  }

  /* ---------- Cierre de cualquier flujo: consolida, envía a Firebase y pasa a la pantalla de búsqueda ---------- */
  async function finalizar(id, bruto) {
    if (!vivo(id)) return;
    let pedido;
    try { pedido = consolidarPedido(bruto); }
    catch (e) {
      addBot("No pude armar tu solicitud: " + e.message + " Volvamos a empezar.");
      await opciones(id, [{ clave: "x", texto: "↩️ Volver al inicio" }]);
      if (vivo(id)) { borrarConvo(); reiniciarConvo(); }
      return;
    }
    if (!(await di(id, pedido.servicio === "pickup"
      ? "✅ ¡Listo! Ya tengo todo. Buscando un conductor para tu pickup…"
      : "✅ ¡Listo! Ya tengo todo. Buscando un repartidor para tu pedido…"))) return;
    try {
      await crearSolicitud(pedido);
      guardarResumenLocal(pedido);
      guardarSesion({ estado: "nuevo" });
      guardarUltimaDireccion(pedido.destino);
    } catch (e) {
      if (!vivo(id)) return;
      addBot("No se pudo enviar tu pedido: " + (e.code || e.message));
      await opciones(id, [{ clave: "r", texto: "🔄 Reintentar" }]);
      return finalizar(id, bruto);
    }
    if (!vivo(id)) return;
    guardarHistorial();
    borrarConvo();
    pendTexto = null;
    pedidoActual = pedido;
    entrarAlChat();
  }

  /* ---------- Flujo ENVIAR ---------- */
  async function flujoEnviar(id) {
    const v = datos.v;
    if (!v.gps) {
      if (!(await di(id, "📦 ¡Perfecto! Para recoger tu paquete usaré tu ubicación en tiempo real.", "e1"))) return;
      const g = await obtenerGps(id);
      if (!g || !vivo(id)) return;
      guardar("gps", g);
    } else gpsListo = v.gps;
    if (!v.quiere) {
      if (!(await di(id, "¿Qué vas a enviar? (por ejemplo: documentos, una caja pequeña, llaves)", "e2"))) return;
      const t = await pedirTexto(id, "Ej. Documentos", 2, "Cuéntame qué vas a enviar (mínimo 2 letras).");
      if (!vivo(id)) return;
      guardar("quiere", t);
    }
    if (!v.destino) {
      const d = await pedirLugar(id, { clave: "e3", pregunta: "¿Dónde entregamos el paquete? Marca el punto en el mapa o escribe la dirección de la persona que lo recibe.", ultima: true });
      if (!d || !vivo(id)) return;
      guardar("destino", d);
    }
    await finalizar(id, {
      servicio: "enviar", tipo: "envio", quiere: v.quiere, origen: MARCA_GPS_RETIRO, modo: "envia",
      retiro: { tipo: "gps", lat: v.gps.lat, lng: v.gps.lng }, destino: v.destino
    });
  }

  /* ---------- Flujo RETIRAR ---------- */
  async function flujoRetirar(id) {
    const v = datos.v;
    if (!v.retiro) {
      const r = await pedirLugar(id, { clave: "r1", pregunta: "📥 Muy bien, retiraremos algo por ti. ¿Dónde lo recogemos? Marca el punto exacto en el mapa o escribe la dirección de retiro." });
      if (!r || !vivo(id)) return;
      guardar("retiro", r);
    }
    if (!v.contacto) {
      if (!(await di(id, "¿Cómo se llama la persona o el negocio que te lo entrega?", "r2"))) return;
      const t = await pedirTexto(id, "Nombre de la persona o negocio", 2, "Escribe el nombre de la persona o del negocio (mínimo 2 letras).", 80);
      if (!vivo(id)) return;
      guardar("contacto", t);
    }
    if (!v.destino) {
      const d = await pedirLugar(id, { clave: "r3", pregunta: "Por último, ¿dónde lo entregamos? Comparte tu ubicación en tiempo real o marca el punto de entrega final.", gps: true, ultima: true });
      if (!d || !vivo(id)) return;
      guardar("destino", d);
    }
    await finalizar(id, {
      servicio: "retirar", tipo: "envio", quiere: ("Retirar con " + v.contacto).slice(0, 200), contacto: v.contacto,
      origen: origenTexto(v.retiro), modo: v.destino.tipo === "gps" ? "recibe" : "envia", retiro: v.retiro, destino: v.destino
    });
  }

  /* ---------- Flujo PEDIR COMIDA ---------- */
  async function flujoComida(id) {
    const v = datos.v;
    if (!v.quiere) {
      if (!(await di(id, "🍔 ¡Qué rico! ¿Qué deseas pedir?", "c1"))) return;
      const t = await pedirTexto(id, "Ej. 2 hamburguesas y una Coca-Cola", 2, "Cuéntame qué deseas pedir (mínimo 2 letras).");
      if (!vivo(id)) return;
      guardar("quiere", t);
    }
    if (!v.origen) {
      if (!(await di(id, "¿De qué establecimiento lo quieres?", "c2"))) return;
      const t = await pedirTexto(id, "Ej. Burger House, Av. Central", 2, "Indica el nombre del establecimiento (mínimo 2 letras).", 120);
      if (!vivo(id)) return;
      guardar("origen", t);
    }
    if (!v.quien) {
      if (!(await di(id, "¿Quién recibe el pedido?", "c3"))) return;
      const q = await opciones(id, [{ clave: "yo", texto: "🙋 Yo recibo" }, { clave: "otro", texto: "🎁 Envío a alguien" }]);
      if (!vivo(id)) return;
      guardar("quien", q);
    }
    if (!v.destino) {
      if (v.quien === "yo") {
        if (!(await di(id, "Activo tu ubicación en tiempo real para que el repartidor te encuentre.", "c4y"))) return;
        const g = await obtenerGps(id);
        if (!g || !vivo(id)) return;
        guardar("destino", { tipo: "gps", lat: g.lat, lng: g.lng });
      } else {
        const d = await pedirLugar(id, { clave: "c4o", pregunta: "Marca en el mapa o escribe la dirección exacta de la persona que recibe.", ultima: true });
        if (!d || !vivo(id)) return;
        guardar("destino", d);
      }
    }
    await finalizar(id, { servicio: "comida", tipo: "compra", quiere: v.quiere, origen: v.origen, modo: v.quien === "yo" ? "recibe" : "envia", destino: v.destino });
  }

  /* ---------- Flujo PICKUP (mototaxi) ---------- */
  async function flujoPickup(id) {
    const v = datos.v;
    if (!v.retiro) {
      const r = await pedirLugar(id, { clave: "p1", pregunta: "🏍️ ¡Listo! Pediremos un mototaxi. ¿Dónde te recogemos? Usa tu ubicación en vivo, marca el punto en el mapa o escribe la dirección.", gps: true });
      if (!r || !vivo(id)) return;
      guardar("retiro", r);
    }
    if (!v.destino) {
      const d = await pedirLugar(id, { clave: "p2", pregunta: "¿A dónde vas? Marca el destino en el mapa o escribe la dirección.", ultima: true });
      if (!d || !vivo(id)) return;
      guardar("destino", d);
    }
    await finalizar(id, {
      servicio: "pickup", tipo: "envio", quiere: "Pickup (mototaxi)", origen: origenTexto(v.retiro), modo: "envia", retiro: v.retiro, destino: v.destino
    });
  }

  const FLUJOS = { enviar: flujoEnviar, retirar: flujoRetirar, comida: flujoComida, pickup: flujoPickup };

  function ejecutarFlujo(id, clave) {
    FLUJOS[clave](id).catch(() => {
      if (vivo(id)) addBot("Ocurrió un problema inesperado. Toca ↩️ arriba para volver al inicio e intentarlo de nuevo.");
    });
  }

  /* ---------- Arranque, reinicio y retoma del chat inicial ---------- */
  function pintarInicio() {
    const saludo = $("saludoInicio");
    if (saludo) saludo.textContent = "¡Hola, " + ((perfil && perfil.nombre) || "") + "! 👋";
    const t = hora(Date.now());
    document.querySelectorAll(".wa-hora-inicio").forEach((n) => { n.textContent = t; });
  }

  function reiniciarConvo() {
    convId++;
    pendTexto = null; gpsListo = null;
    datos = nuevosDatos(null);
    borrarConvo();
    if (mapaConv) { try { mapaConv.remove(); } catch (_) { } mapaConv = null; }
    $("convo").textContent = "";
    apagarComposer();
    $("menuInicio").classList.remove("oculto");
    $("btnReiniciar").classList.add("oculto");
    pintarInicio();
    $("formPedido").scrollTop = 0;
  }

  /* Retoma una conversación guardada: repinta las burbujas y continúa en el paso pendiente. */
  function retomarConvo(o) {
    convId++;
    const id = convId;
    pendTexto = null;
    if (mapaConv) { try { mapaConv.remove(); } catch (_) { } mapaConv = null; }
    datos = { servicio: o.servicio, dichos: o.dichos, v: o.v, log: o.log.slice() };
    gpsListo = datos.v.gps && okLL(Number(datos.v.gps.lat), Number(datos.v.gps.lng)) ? datos.v.gps : null;
    $("convo").textContent = "";
    apagarComposer();
    pintarInicio();
    $("menuInicio").classList.add("oculto");
    $("btnReiniciar").classList.remove("oculto");
    o.log.forEach((e) => {
      $("convo").appendChild(crearBurbuja(e.c === "yo" ? "wa-burbuja-yo" : "wa-burbuja-bot", e.t, e.ts, true));
    });
    $("convo").appendChild(crearBurbuja("wa-burbuja-bot", "↩️ Retomamos tu solicitud donde la dejaste.", Date.now(), true));
    bajar();
    ejecutarFlujo(id, datos.servicio);
  }

  function pedirDetalles() {
    const previa = leerConvo();
    vista("vPedido");
    if (previa) retomarConvo(previa);
    else { borrarHistorial(); reiniciarConvo(); }
  }

  function iniciarFlujo(clave, etiqueta) {
    if (!FLUJOS[clave]) return;
    convId++;
    const id = convId;
    pendTexto = null; gpsListo = null;
    datos = nuevosDatos(clave);
    $("menuInicio").classList.add("oculto");
    $("btnReiniciar").classList.remove("oculto");
    addYo(etiqueta);
    ejecutarFlujo(id, clave);
  }

  document.querySelectorAll("#menuInicio [data-servicio]").forEach((b) => b.addEventListener("click", () => {
    iniciarFlujo(b.dataset.servicio, b.dataset.etiqueta || b.textContent.trim());
  }));
  $("btnReiniciar").addEventListener("click", reiniciarConvo);

  /* ---------- Conversación inicial dentro del chat (queda al principio, en orden cronológico) ---------- */
  function pintarHistorialLocal() {
    if (cerrado || $("histLocal")) return;
    const log = leerHistorial();
    if (!log.length) return;
    const cont = $("mensajes");
    const w = document.createElement("div");
    w.id = "histLocal";
    w.className = "wa-hist";
    const dia = document.createElement("div");
    dia.className = "wa-dia";
    const s = document.createElement("span");
    s.textContent = "Tu solicitud · " + etiquetaDia(log[0].ts);
    dia.appendChild(s);
    w.appendChild(dia);
    log.forEach((e) => w.appendChild(crearBurbuja(e.c === "yo" ? "wa-burbuja-yo" : "wa-burbuja-bot", e.t, e.ts, true)));
    cont.insertBefore(w, cont.firstChild);
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
    const s = p.servicio || ((p.tipo === "envio" || (!!p.retiro && p.tipo !== "compra")) ? "enviar" : "comida");
    const entrega = lugarTexto(p.destino) || "Por confirmar";
    const retiro = lugarTexto(p.retiro) || String(p.origen || "Por confirmar");
    const lineas = [MARCA_RESUMEN];
    if (s === "enviar") {
      lineas.push("📦 Servicio: Enviar", "🧾 Paquete: " + String(p.quiere || ""), "⬆️ Recogida: " + retiro, "🏁 Entrega: " + entrega);
    } else if (s === "retirar") {
      lineas.push("📥 Servicio: Retirar", "👤 Lo entrega: " + String(p.contacto || p.quiere || ""), "⬆️ Retiro: " + retiro, "🏁 Entrega final: " + entrega);
    } else if (s === "pickup") {
      lineas.push("🏍️ Servicio: Pickup (mototaxi)", "⬆️ Recogida: " + retiro, "🏁 Destino: " + entrega);
    } else {
      lineas.push("🍔 Servicio: Pedir Comida", "🛍️ Pedido: " + String(p.quiere || ""), "🏪 Establecimiento: " + String(p.origen || ""), "📍 Entrega: " + entrega + (p.modo === "recibe" ? " (lo recibe el cliente)" : " (lo recibe otra persona)"));
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
    const hist = $("histLocal");
    cont.insertBefore(card, hist ? hist.nextSibling : cont.firstChild);
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
    if (!confirm("¿Cancelar tu solicitud? Dejaremos de buscar " + textoBusqueda().quien + ".")) return;
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
      borrarHistorial();
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
    $("cierreSub").textContent = entregado ? "¿Cómo estuvo tu " + textoBusqueda().quien + "?" : "Tu pedido fue cancelado. Puedes pedir de nuevo cuando quieras.";
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
    borrarConvo(); borrarHistorial();
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
