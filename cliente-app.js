/* ============================================================
   CLIENTE — chat tipo WhatsApp (Fase 1)
   Flujo:
     1) Sesión anónima de Firebase.
     2) Lee el perfil de LocalStorage. Si no existe o está dañado → genera ID único y pide el nombre.
     3) Crea (o retoma) el chat en  solicitudes_entrantes/{solicitudId}.
     4) Antes de crear el chat, un modal pregunta qué desea, de dónde, quién recibe y dónde.
     5) Escucha el chat en vivo. El cliente solo puede escribir cuando un repartidor lo atendió
        (estado "atendido" + repartidorUid), y solo conversa con ese repartidor.
     6) Cuando el estado pasa a "entregado" (o "cancelado") el chat se vacía y queda un modal
        para valorar (1–5 estrellas) y el botón PEDIR NUEVAMENTE (crea una solicitud nueva).

   FASE 4 · ajustes aplicados
     · Palomitas ✓/✓✓ verdes en los mensajes del cliente (nodo solicitudes_entrantes/{id}/leidos/repartidor).
     · Indicador "escribiendo…" del repartidor (nodo solicitudes_entrantes/{id}/typing/repartidor).
       El cliente escribe su propio typing en solicitudes_entrantes/{id}/typing/cliente.
     · Botón "✏️ Cambiar mi nombre" en la cabecera, solo visible cuando estado === "nuevo"
       (sin repartidor asignado). Guarda en solicitudes_entrantes/{id}/nombre + LocalStorage.
     · Guardado de la última dirección del cliente en clientes/{clienteId}/ultimaDireccion
       (Firebase) y en localStorage (caché) al enviar el pedido. El tipo "gps" NO se guarda como
       confirmable (depende de dónde esté el cliente en ese momento).
     · Banner "La última vez pediste a: …" en el paso 3e del modal, con botones "Sí, aquí" / "No, otra dirección".
       Solo se ofrece si la última dirección es pin o direccion.

   Esquema en Realtime Database:
     solicitudes_entrantes/{solicitudId}
        clienteId, nombre, estado ("nuevo" | "atendido" | "entregado" | "cancelado"), creado, ts,
        pedido {quiere, origen, modo: "recibe"|"envia",
                destino: {tipo: "gps"|"pin"|"direccion", lat, lng | texto}},
        clienteGps {lat, lng, prec, ts}     (el cliente lo actualiza en vivo si modo "recibe")
        repartidorGps {lat, lng, ts}        (lo escribe el repartidor al atender)
        valoracion {estrellas, ts}          (el cliente, una vez "entregado")
        llegadaTs                           (el repartidor, al marcar "He llegado")
        repartidorUid, repartidorNombre,
        ultimoMensaje, ultimoDe,
        leidos/repartidor (ts de la última lectura del repartidor)
        leidos/cliente    (ts de la última lectura del cliente)
        typing/cliente    (ts del último latido de "escribiendo…" del cliente)
        typing/repartidor (ts del último latido de "escribiendo…" del repartidor)
     clientes/{clienteId}/ultimaDireccion = { tipo:"pin"|"direccion"|"gps", lat, lng, texto, ts }
     repartidorFotos/{repartidorUid}  (data URL JPEG de la foto del repartidor; lectura pública)
     solicitudes_entrantes/{solicitudId}/mensajes/{pushId}
        de ("cliente" | "repartidor"), tipo ("texto" | "factura" | "foto"), ts,
        texto            (tipo "texto")
        (tipo "foto": sin datos; la imagen va en solicitudes_fotos/{solicitudId}/{pushId})
        factura {…}      (tipo "factura")
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
  const TYPING_MS = 1500;          // debounce del "escribiendo…"
  const TYPING_CADUCA = 4000;      // se apaga a los 4 s sin nuevos latidos
  const COLOR_TICK_ENVIADO = "#8696A0";
  const COLOR_TICK_LEIDO = "#25D366";

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
  let lect = {};                    // { cliente: ts, repartidor: ts } leídos desde refLeidos
  let typingOtro = {};              // { cliente: ts, repartidor: ts } leídos desde refTyping
  let tUltTyping = 0, tmEscribiendo = null, tmTypingRefresh = null;
  let primeraLecturaSolicitud = true;

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
    } catch (_) { /* cae al respaldo */ }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }

  const dinero = (n) => "C$ " + (Number(n) || 0).toFixed(2);

  function hora(ts) {
    return new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  }

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
    } catch (_) { /* JSON dañado: se descarta */ }
    try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { /* nada */ }
    return null;
  }

  function guardarPerfil(p) {
    respaldoMemoria = p;
    try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify({ id: p.id, nombre: p.nombre, solicitudId: p.solicitudId || null })); }
    catch (_) { /* sin almacenamiento: queda en memoria durante la sesión */ }
  }

  /* ---------- Última dirección (localStorage caché) ---------- */
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

  /* Guarda la última dirección en Firebase (clientes/{clienteId}/ultimaDireccion) y en localStorage.
     Solo persiste si es "pin" o "direccion" (gps depende de dónde esté el cliente en ese momento). */
  async function guardarUltimaDireccion(destino) {
    if (!destino || !perfil) return;
    if (destino.tipo !== "pin" && destino.tipo !== "direccion") return;
    const dato = { tipo: destino.tipo, ts: Date.now() };
    if (destino.tipo === "pin") { dato.lat = redondear(destino.lat); dato.lng = redondear(destino.lng); }
    if (destino.tipo === "direccion") dato.texto = String(destino.texto || "").slice(0, 200);
    guardarUltimaDirLocal(dato);
    try { await db.ref(RAIZ_CLIENTES + "/" + perfil.id + "/ultimaDireccion").set(dato); }
    catch (_) { /* sin permiso o sin red: queda la copia local para la próxima */ }
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
    if (perfil) return abrirChat();
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

  /* ---------- Crear o retomar el chat en solicitudes_entrantes ---------- */
  async function abrirChat() {
    if (!perfil || !idValido(perfil.id)) {
      perfil = null;
      try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { /* nada */ }
      vista("vNombre");
      return;
    }
    $("msgCarga").className = "wa-splash-msg";
    $("msgCarga").textContent = "Abriendo tu chat…";
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
      if (!s.exists()) return pedirDetalles();
    } catch (e) {
      return errorCarga("No se pudo abrir tu chat: " + (e.code || e.message));
    }
    entrarAlChat();
  }

  async function crearSolicitud(pedido) {
    await refSolicitud.set({
      clienteId: perfil.id,
      nombre: perfil.nombre,
      estado: "nuevo",
      creado: firebase.database.ServerValue.TIMESTAMP,
      ts: firebase.database.ServerValue.TIMESTAMP,
      ultimoMensaje: "",
      ultimoDe: "",
      pedido
    });
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

  /* Detiene todo lo del chat actual y deja la pantalla lista para otro */
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
    pintarAvatar(null, "");
    limpiarMapa();
  }

  /* ---------- Estado de la solicitud ---------- */
  function escucharSolicitud() {
    primeraLecturaSolicitud = true;
    refSolicitud.on("value", (s) => {
      if (!s.exists()) {
        if (cerrado) return;
        detenerTodo();
        return abrirChat();
      }
      const d = s.val() || {};
      pedidoActual = d.pedido && typeof d.pedido === "object" ? d.pedido : null;

      /* FASE 4 · botón "Cambiar mi nombre" visible solo en estado "nuevo" */
      $("btnCambiarNombre").classList.toggle("oculto", !(d.estado === "nuevo"));

      if (d.estado === "entregado" || d.estado === "cancelado") return cerrarCiclo(d);

      const ahoraAsignado = d.estado === "atendido" && typeof d.repartidorUid === "string" && d.repartidorUid.length > 0;
      const nombreRep = typeof d.repartidorNombre === "string" ? d.repartidorNombre.slice(0, 40) : "";
      pintarEstado(ahoraAsignado, nombreRep, d.repartidorUid);
      pintarResumen();
      iniciarGps();
      if (ahoraAsignado && !asignado) setMapaVisible(true);
      if (!ahoraAsignado && asignado) {
        setMapaVisible(false);
        avisoSistema("Tu repartidor dejó el pedido. Estamos buscando otro para ti.");
      }
      if (ahoraAsignado && !asignado && !primerSnapshot) {
        avisoSistema((nombreRep || "Un repartidor") + " atendió tu chat.");
        if (window.Voz) Voz.clientePedidoAceptado();
      }
      if (!ahoraAsignado) avisadoCerca = false;
      asignado = ahoraAsignado;
      if (ahoraAsignado && d.llegadaTs) avisarCerca();
      primerSnapshot = false;
      primeraLecturaSolicitud = false;
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
    }).catch(() => {});
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
    $("btnMapa").classList.toggle("oculto", !conRepartidor || typeof L === "undefined");
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

  /* Marca como leído el chat por parte del cliente.
     Solo si hay repartidor asignado y la app está visible. */
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

  /* Palomitas en cada burbuja mía (mensajes del cliente) */
  function actualizarTicks() {
    $("mensajes").querySelectorAll(".wa-tick").forEach((t) => {
      const ts = +t.dataset.ts || 0;
      /* El mensaje es del cliente: se considera leído cuando el repartidor leyó (leidos.repartidor >= ts) */
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
  /* El cliente avisa al escribir */
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
    }

    const h = document.createElement("span");
    h.className = "wa-hora";
    h.textContent = hora(ts);

    /* Palomitas solo en MIS mensajes (los del cliente) */
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
     Modal inicial
     ============================================================ */
  let paso = 1, modo = null, tipoEnvio = "pin", pin = null, gpsListo = null;
  let mapaPin = null, marcaPin = null;

  const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  const redondear = (n) => Math.round(n * 1e6) / 1e6;
  const iconoPin = (clase, emoji) => L.divIcon({ className: "", html: '<div class="wa-pin ' + clase + '">' + emoji + "</div>", iconSize: [40, 40], iconAnchor: [20, 20] });

  function pedirDetalles() {
    paso = 1; modo = null; tipoEnvio = "pin"; pin = null; gpsListo = null;
    ["inQuiere", "inOrigen", "inDir"].forEach((id) => { $(id).value = ""; });
    $("estadoGps").classList.add("oculto");
    $("btnGps").textContent = "📍 Activar mi ubicación";
    $("ayudaPin").textContent = "Toca el mapa para colocar el pin. Puedes arrastrarlo.";
    $("ultimaDireccionBox").classList.add("oculto");
    if (marcaPin && mapaPin) { mapaPin.removeLayer(marcaPin); marcaPin = null; }
    setTipoEnvio("pin");
    errorPedido("");
    vista("vPedido");
    mostrarPaso();
    $("inQuiere").focus();
  }

  function errorPedido(msg) {
    const e = $("msgPedido");
    e.textContent = msg;
    e.classList.toggle("oculto", !msg);
  }

  /* FASE 4 · Muestra el banner con la última dirección guardada (solo pin o direccion).
     Si el cliente tocó "Sí, aquí", se rellena el destino y se salta al envío. */
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
        /* Enviamos directo al usuario al submit */
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
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function mostrarPaso() {
    const clave = paso === 3 ? (modo === "recibe" ? "3r" : "3e") : String(paso);
    document.querySelectorAll("#formPedido .wa-paso").forEach((n) => n.classList.toggle("oculto", n.dataset.paso !== clave));
    document.querySelectorAll(".wa-pasos i").forEach((n, i) => n.classList.toggle("on", i < paso));
    $("btnAtras").classList.toggle("oculto", paso === 1);
    $("btnSiguiente").classList.toggle("oculto", paso === 2);
    $("btnSiguiente").textContent = paso === 3 ? "Enviar pedido" : "Siguiente";
    errorPedido("");
    if (clave === "3e") { iniciarMapaPin(); mostrarUltimaDireccion(); }
    if (clave === "3r" && !gpsListo) pedirGps();
  }

  document.querySelectorAll("#formPedido .wa-opcion").forEach((b) => b.addEventListener("click", () => {
    modo = b.dataset.modo;
    paso = 3;
    mostrarPaso();
  }));

  $("btnAtras").addEventListener("click", () => { if (paso > 1) { paso -= 1; mostrarPaso(); } });

  /* GPS */
  let buscandoGps = false;
  function pedirGps() {
    if (buscandoGps) return;
    const est = $("estadoGps");
    est.className = "wa-estado";
    est.textContent = "Buscando tu ubicación…";
    if (!navigator.geolocation) return falloGps(0);
    buscandoGps = true;
    navigator.geolocation.getCurrentPosition((pos) => {
      buscandoGps = false;
      gpsListo = { lat: redondear(pos.coords.latitude), lng: redondear(pos.coords.longitude) };
      est.className = "wa-estado";
      est.textContent = "✅ Ubicación lista. Se compartirá en vivo con tu repartidor.";
      $("btnGps").textContent = "📍 Actualizar mi ubicación";
      errorPedido("");
    }, (e) => { buscandoGps = false; falloGps(e && e.code); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  $("btnGps").addEventListener("click", pedirGps);
  function falloGps(codigo) {
    gpsListo = null;
    const est = $("estadoGps");
    est.className = "wa-estado error";
    est.textContent = codigo === 1
      ? "Tu ubicación está bloqueada. Permite la ubicación para este sitio en los ajustes de tu navegador y toca el botón de nuevo."
      : "No pudimos obtener tu ubicación. Enciende el GPS de tu celular y toca el botón de nuevo.";
    $("btnGps").textContent = "📍 Reintentar ubicación";
  }

  function setTipoEnvio(t) {
    tipoEnvio = t;
    document.querySelectorAll("#formPedido .wa-seg button").forEach((b) => b.classList.toggle("activa", b.dataset.tipo === t));
    $("boxPin").classList.toggle("oculto", t !== "pin");
    $("boxDir").classList.toggle("oculto", t !== "direccion");
    if (t === "pin" && paso === 3 && modo === "envia") iniciarMapaPin();
  }
  document.querySelectorAll("#formPedido .wa-seg button").forEach((b) => b.addEventListener("click", () => setTipoEnvio(b.dataset.tipo)));

  function iniciarMapaPin() {
    if (typeof L === "undefined") {
      setTipoEnvio("direccion");
      document.querySelector('#formPedido .wa-seg button[data-tipo="pin"]').classList.add("oculto");
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

  /* Submit del pedido */
  $("formPedido").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (paso === 1) {
      const quiere = limpiarNombre($("inQuiere").value), origen = limpiarNombre($("inOrigen").value);
      if (quiere.length < 2) return errorPedido("Cuéntanos qué deseas.");
      if (origen.length < 2) return errorPedido("Indica de dónde lo deseas.");
      paso = 2;
      return mostrarPaso();
    }
    if (paso !== 3) return;

    let destino = null;
    if (modo === "recibe") {
      if (!gpsListo) return errorPedido("Para recibir tu pedido necesitamos tu ubicación en tiempo real. Actívala para continuar.");
      destino = { tipo: "gps", lat: gpsListo.lat, lng: gpsListo.lng };
    } else if (tipoEnvio === "pin") {
      if (!pin) return errorPedido("Toca el mapa para colocar el pin del lugar de entrega.");
      destino = { tipo: "pin", lat: pin.lat, lng: pin.lng };
    } else {
      const dir = limpiarNombre($("inDir").value);
      if (dir.length < 5) return errorPedido("Escribe la dirección exacta (mínimo 5 letras).");
      destino = { tipo: "direccion", texto: dir };
    }

    const pedido = { quiere: limpiarNombre($("inQuiere").value), origen: limpiarNombre($("inOrigen").value), modo, destino };
    const btn = $("btnSiguiente");
    btn.disabled = true;
    try {
      await crearSolicitud(pedido);
      /* FASE 4 · guardar la última dirección (solo pin o direccion) para el próximo pedido */
      guardarUltimaDireccion(destino);
    } catch (e) {
      btn.disabled = false;
      return errorPedido("No se pudo enviar tu pedido: " + (e.code || e.message));
    }
    btn.disabled = false;
    entrarAlChat();
  });

  /* ============================================================
     GPS en vivo del cliente (solo si recibe él mismo)
     ============================================================ */
  let watchId = null, ultimaEscritura = 0, ultimaEnviada = null;

  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function iniciarGps() {
    if (watchId !== null || cerrado || !navigator.geolocation) return;
    const d = pedidoActual && pedidoActual.destino;
    if (!pedidoActual || pedidoActual.modo !== "recibe" || !d || d.tipo !== "gps") return;
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
      refSolicitud.child("clienteGps").set({ lat: pos.lat, lng: pos.lng, prec: Math.round(p.coords.accuracy || 0), ts: firebase.database.ServerValue.TIMESTAMP }).catch(() => {});
    }
  }

  /* ============================================================
     Mapa de seguimiento
     ============================================================ */
  let mapa = null, marcaRep = null, marcaCli = null, posRep = null, encuadrado = false;

  function escucharRepartidorGps() {
    refSolicitud.child("repartidorGps").on("value", (s) => {
      const g = s.val();
      posRep = g && okLL(g.lat, g.lng) ? { lat: g.lat, lng: g.lng } : null;
      actualizarMapa();
      revisarCercania();
    }, () => {});
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
    $("btnMapa").setAttribute("aria-expanded", String(abrir));
    if (!abrir) return;
    if (!mapa) {
      mapa = L.map("mapaSeguir", { zoomControl: false }).setView(CENTRO_MAPA, 14);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    }
    setTimeout(() => { mapa.invalidateSize(); encuadrado = false; actualizarMapa(); }, 60);
  }
  $("btnMapa").addEventListener("click", () => setMapaVisible($("panelMapa").classList.contains("oculto")));

  function puntoCliente() {
    if (posCliente) return posCliente;
    const d = pedidoActual && pedidoActual.destino;
    return d && okLL(d.lat, d.lng) ? { lat: d.lat, lng: d.lng } : null;
  }
  function ponerMarca(marca, punto, icono) {
    if (!punto) { if (marca) mapa.removeLayer(marca); return null; }
    if (!marca) return L.marker([punto.lat, punto.lng], { icon: icono, interactive: false }).addTo(mapa);
    marca.setLatLng([punto.lat, punto.lng]);
    return marca;
  }
  function actualizarMapa() {
    if (!mapa || $("panelMapa").classList.contains("oculto")) return;
    const c = puntoCliente();
    marcaCli = ponerMarca(marcaCli, c, iconoPin("wa-pin-cli", pedidoActual && pedidoActual.modo === "envia" ? "🏠" : "📍"));
    marcaRep = ponerMarca(marcaRep, posRep, iconoPin("wa-pin-rep", "🛵"));
    $("estadoMapa").classList.toggle("oculto", !!posRep);
    if (encuadrado) return;
    const pts = [c, posRep].filter(Boolean).map((q) => [q.lat, q.lng]);
    if (pts.length === 2) { mapa.fitBounds(pts, { padding: [48, 48], maxZoom: 17 }); encuadrado = true; }
    else if (pts.length === 1) mapa.setView(pts[0], 16);
  }
  function limpiarMapa() {
    if (mapa) {
      if (marcaCli) mapa.removeLayer(marcaCli);
      if (marcaRep) mapa.removeLayer(marcaRep);
    }
    marcaCli = null; marcaRep = null; posRep = null; encuadrado = false;
    setMapaVisible(false);
  }

  /* ---------- Cancelar mientras nadie ha tomado el pedido ---------- */
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

  /* ---------- Resumen del pedido en el aviso de búsqueda ---------- */
  function pintarResumen() {
    const e = $("resumenPedido"), p = pedidoActual;
    e.textContent = p ? String(p.quiere || "") + " · de " + String(p.origen || "") : "";
    e.classList.toggle("oculto", !p);
  }

  /* ============================================================
     Fotos (cámara o galería) → JPEG comprimido
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
     FASE 4 · Cambiar mi nombre (solo mientras estado === "nuevo")
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
     Cierre del ciclo
     ============================================================ */
  function cerrarCiclo(d) {
    const entregado = d.estado === "entregado";
    if (!cerrado) {
      cerrado = true;
      detenerGps();
      if (refMensajes) refMensajes.off();
      $("mensajes").textContent = "";
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
    perfil = { id: generarId(), nombre: perfil.nombre, solicitudId: null };
    guardarPerfil(perfil);
    abrirChat();
  });

  /* ============================================================
     Fix del teclado táctil
     ============================================================ */
  function ajustarViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    const raiz = document.documentElement.style;
    const pegado = pegadoAlFinal();
    raiz.setProperty("--vvh", Math.round(vv.height) + "px");
    raiz.setProperty("--vvt", Math.round(vv.offsetTop) + "px");
    const activo = document.activeElement;
    if (activo && (activo.tagName === "INPUT" || activo.tagName === "TEXTAREA")) {
      setTimeout(() => {
        activo.scrollIntoView({ block: "nearest" });
        if (pegado && !$("vChat").classList.contains("oculto")) alFinal();
      }, 60);
    }
    window.scrollTo(0, 0);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", ajustarViewport);
    window.visualViewport.addEventListener("scroll", ajustarViewport);
    ajustarViewport();
  }

  arrancar();
})();
