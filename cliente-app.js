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
  const MAX_TEXTO = 1000;
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
  const CADUCA_CHAT_MS = 12 * 3600 * 1000;           // el chat de un pedido terminado dura 12 h
  const CLAVE_ARCHIVO = "brothers_archivo_chat";
  const CLAVE_VAL_OMITIDA = "brothers_valoracion_omitida";

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
  let cierreTs = 0, tmCaduca = null, enviandoVal = false, estrellasSel = 0;

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
  /* Texto libre (listas de mandados, compras del mercado…): conserva los saltos de línea */
  const limpiarTexto = (s) => String(s || "").replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  /* Los campos de escribir son <textarea>: Enter / "saltar línea" del teclado inserta un salto real; solo el botón envía */
  function ajustarAlto(ta) {
    if (!ta) return;
    ta.style.height = "auto";
    const h = Math.min(ta.scrollHeight + 3, 128);
    ta.style.height = h + "px";
    ta.style.overflowY = ta.scrollHeight + 3 > 128 ? "auto" : "hidden";
  }

  /* ---------- Horario de atención (configurado por el administrador) ---------- */
  const RUTA_HORARIO = "configuracion/horarioAtencion";
  const ZONA_HORARIO = "America/Managua";
  const MENSAJE_FUERA = "👋 ¡Hola! En este momento estamos fuera de servicio (fuera de nuestro horario de atención). Recibimos tu pedido y lo atenderemos en cuanto abramos. ¡Gracias por escribirnos! 🛵";
  let cfgHorario = null, cerradoServicio = false, horarioListo = false, autoRecibido = false, avisoFueraMostrado = false, tmAvisoFuera = null;
  const aMinHora = (h) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(h || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  function ahoraManagua() {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: ZONA_HORARIO, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    const p = {}; f.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
    return { dia: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
  }
  function abiertoAhora(cfg) {
    const { dia, min } = ahoraManagua(), dias = cfg.dias || {};
    const ventana = (d) => (d && d.abierto ? [aMinHora(d.desde), aMinHora(d.hasta)] : null);
    const h = ventana(dias[dia]);
    if (h && h[0] != null && h[1] != null) { if (h[1] > h[0]) { if (min >= h[0] && min < h[1]) return true; } else if (min >= h[0]) return true; }
    const y = ventana(dias[(dia + 6) % 7]);   // horario que cruza la medianoche (p. ej. 18:00–02:00)
    return !!(y && y[0] != null && y[1] != null && y[1] <= y[0] && min < y[1]);
  }
  const mensajeFuera = () => String((cfgHorario && cfgHorario.mensaje) || MENSAJE_FUERA).slice(0, 500);
  function pintarHorario() {
    const si = $("subInicio");
    if (si) { si.textContent = cerradoServicio ? "Fuera de servicio" : "En línea"; si.classList.toggle("fuera-servicio", cerradoServicio); }
    const ac = $("avisoCerrado");
    if (ac) { ac.classList.toggle("oculto", !cerradoServicio); const t = $("txtCerrado"); if (t) t.textContent = mensajeFuera(); }
    /* Fuera de servicio: NO se puede pedir. Solo se muestra el aviso con el mensaje que configuró el administrador. */
    const mi = $("menuInicio"), pi = $("preguntaInicio");
    if (pi) pi.classList.toggle("oculto", cerradoServicio);
    document.querySelectorAll("#menuInicio [data-servicio]").forEach((b) => { b.disabled = cerradoServicio; });
    if (cerradoServicio) {
      if (datos && datos.servicio) { try { reiniciarConvo(); } catch (_) { } }   // un pedido a medias se cancela: ya no se puede enviar
      if (mi) mi.classList.add("oculto");   // después de reiniciar, para que el menú no reaparezca
      apagarComposer();
    } else if (mi && datos && !datos.servicio) mi.classList.remove("oculto");
    if (cerrado) {   // chat de un pedido ya terminado: no deja escribir para pedir de nuevo
      const inp = $("inMensaje");
      if (inp) { inp.disabled = cerradoServicio; inp.placeholder = cerradoServicio ? "Fuera de servicio" : "Escribe aquí para hacer otro pedido…"; }
      const be = $("btnEnviar"); if (be) be.disabled = cerradoServicio;
    }
    const sub = $("subChat");
    if (sub && !asignado && !cerrado && !sub.classList.contains("escribiendo")) {
      sub.textContent = cerradoServicio ? "Fuera de servicio" : textoBusqueda().sub;
      sub.classList.toggle("fuera-servicio", cerradoServicio);
    }
  }
  /* Mensaje automático dentro del chat con la central (si el servidor ya lo escribió, no se repite) */
  function avisoFueraDeServicio() {
    if (!cerradoServicio || avisoFueraMostrado || autoRecibido || asignado || cerrado) return;
    const vc = $("vChat");
    if (!vc || vc.classList.contains("oculto")) return;
    avisoFueraMostrado = true;
    avisoSistema(mensajeFuera());
  }
  function programarAvisoFuera() {
    clearTimeout(tmAvisoFuera);
    tmAvisoFuera = setTimeout(avisoFueraDeServicio, 3500);
  }
  function evaluarHorario(avisar) {
    const antes = cerradoServicio;
    cerradoServicio = !!cfgHorario && (cfgHorario.cerradoManual === true || (cfgHorario.activo === true && !abiertoAhora(cfgHorario)));
    if (!cerradoServicio) avisoFueraMostrado = false;
    pintarHorario();
    if (avisar && cerradoServicio && !antes) avisoFueraDeServicio();
  }
  function escucharHorario() {
    try {
      db.ref(RUTA_HORARIO).on("value", (sn) => { cfgHorario = sn.val() || null; evaluarHorario(horarioListo); horarioListo = true; }, () => { });
    } catch (_) { }
    setInterval(() => evaluarHorario(true), 30000);
  }
  const nombreValido = (s) => typeof s === "string" && s.length >= 2 && s.length <= 24;

  /* ---------- Registro breve: nombre y apellido, país de Centroamérica y celular ---------- */
  const PAISES = [
    { cod: "NI", nombre: "Nicaragua", marca: "+505", dig: 8, bandera: "🇳🇮" },
    { cod: "CR", nombre: "Costa Rica", marca: "+506", dig: 8, bandera: "🇨🇷" },
    { cod: "PA", nombre: "Panamá", marca: "+507", dig: 8, bandera: "🇵🇦" },
    { cod: "HN", nombre: "Honduras", marca: "+504", dig: 8, bandera: "🇭🇳" },
    { cod: "SV", nombre: "El Salvador", marca: "+503", dig: 8, bandera: "🇸🇻" },
    { cod: "GT", nombre: "Guatemala", marca: "+502", dig: 8, bandera: "🇬🇹" },
    { cod: "BZ", nombre: "Belice", marca: "+501", dig: 7, bandera: "🇧🇿" }   // la numeración de Belice es de 7 dígitos
  ];
  const TERMINOS_VERSION = "2026-11";   // al cambiar el texto de los términos, sube la versión: se vuelve a pedir la aceptación
  const paisDe = (cod) => PAISES.find((p) => p.cod === cod) || null;
  const apellidoValido = (s) => typeof s === "string" && s.length >= 2 && s.length <= 30;
  const regValido = (r) => !!r && typeof r === "object" && apellidoValido(r.ap) && !!paisDe(r.pais) && typeof r.tel === "string" && r.tel.length === paisDe(r.pais).dig && /^[0-9]+$/.test(r.tel);
  const regLimpio = (r) => (regValido(r) ? { ap: r.ap, pais: r.pais, tel: r.tel } : null);
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
        return { id: p.id, nombre: p.nombre, reg: regLimpio(p.reg), terminos: typeof p.terminos === "string" ? p.terminos : null, solicitudId: idValido(p.solicitudId) ? p.solicitudId : null };
      }
    } catch (_) { }
    try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { }
    return null;
  }

  function guardarPerfil(p) {
    respaldoMemoria = p;
    try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify({ id: p.id, nombre: p.nombre, reg: regLimpio(p.reg), terminos: p.terminos || null, solicitudId: p.solicitudId || null })); }
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
  async function guardarUltimaDireccion(destino, ciudadId) {
    if (!destino || !perfil) return;
    if (destino.tipo !== "pin" && destino.tipo !== "direccion") return;
    const dato = { tipo: destino.tipo, ts: Date.now() };
    if (Ciudades.porId(ciudadId)) dato.ciudad = ciudadId;
    if (destino.tipo === "pin") { dato.lat = redondear(destino.lat); dato.lng = redondear(destino.lng); }
    if (destino.tipo === "direccion") dato.texto = String(destino.texto || "").slice(0, 200);
    guardarUltimaDirLocal(dato);
    try { await db.ref(RAIZ_CLIENTES + "/" + perfil.id + "/ultimaDireccion").set(dato); }
    catch (_) { }
  }

  /* ---------- Ciudad del pedido: detección automática (solo ciudades que el admin habilita como cobertura) ---------- */
  const CLAVE_CIUDAD = "brothers_ciudad_cliente";
  let ciudadActiva = { id: Ciudades.DEFECTO, fuente: "defecto" };   // fuente: defecto | guardada | gps | manual
  const nombreCiudad = (id) => Ciudades.nombre(id);
  const centroCiudad = (id) => { const c = Ciudades.porId(id) || Ciudades.porId(Ciudades.DEFECTO); return [c.lat, c.lng]; };
  window.CiudadCliente = { id: () => ciudadActiva.id, nombre: () => nombreCiudad(ciudadActiva.id) };

  function leerCiudadLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(CLAVE_CIUDAD) || "null");
      if (o && Ciudades.habilitada(o.id)) return { id: o.id, fuente: o.manual ? "manual" : "guardada" };
    } catch (_) { }
    return null;
  }
  function guardarCiudadLocal() {
    try { localStorage.setItem(CLAVE_CIUDAD, JSON.stringify({ id: ciudadActiva.id, manual: ciudadActiva.fuente === "manual", ts: Date.now() })); } catch (_) { }
  }
  function pintarCiudad() {
    const t = $("txtCiudad");
    if (t) t.textContent = nombreCiudad(ciudadActiva.id);
    const b = $("btnCiudad");
    if (b) b.title = "Ciudad: " + nombreCiudad(ciudadActiva.id) + (ciudadActiva.fuente === "gps" ? " (detectada)" : "") + " · toca para cambiar";
  }
  function aplicarCiudad(id, fuente) {
    if (!Ciudades.habilitada(id)) return;
    ciudadActiva = { id, fuente };
    guardarCiudadLocal();
    pintarCiudad();
  }
  function detectarCiudad() {
    if (!navigator.geolocation) return;
    try {
      navigator.geolocation.getCurrentPosition((p) => {
        if (ciudadActiva.fuente === "manual") return;
        const c = Ciudades.deCoord(p.coords.latitude, p.coords.longitude);   // solo ciudades con cobertura
        if (c) aplicarCiudad(c.id, "gps");
      }, () => { }, { enableHighAccuracy: false, timeout: 9000, maximumAge: 600000 });
    } catch (_) { }
  }
  /* Si el admin cambia la cobertura y la ciudad activa ya no está habilitada, se pasa a una que sí lo esté */
  function validarCiudad() {
    if (!Ciudades.habilitada(ciudadActiva.id)) { ciudadActiva = { id: Ciudades.DEFECTO, fuente: "defecto" }; guardarCiudadLocal(); }
    pintarCiudad();
  }
  function iniciarCiudad() {
    const loc = leerCiudadLocal();
    if (loc) ciudadActiva = loc;
    Ciudades.suscribir(db, validarCiudad);
    validarCiudad();   // la ciudad por GPS la fija iniciarUbicacion() cuando el cliente concede la ubicación
  }

  /* ---------- Ubicación obligatoria desde que entra a la app ----------
     Al abrir se pide el permiso del sistema al instante. Si está bloqueada o el GPS está apagado, una ventana pide activarla:
     al tocar «Activar ubicación» se vuelve a pedir en ese mismo toque (aparece el aviso del sistema) y la ventana se cierra sola al conseguirla. */
  let ubicacionOk = false, ubicVerificando = false, tmUbic = null;
  function cerrarModalUbicacion() { clearInterval(tmUbic); tmUbic = null; $("modalUbicacion").classList.add("oculto"); }
  function alUbicar(pos) {
    ubicacionOk = true;
    cerrarModalUbicacion();
    if (ciudadActiva.fuente !== "manual") { const c = Ciudades.deCoord(pos.lat, pos.lng); if (c) aplicarCiudad(c.id, "gps"); }
  }
  function mostrarModalUbicacion(tipo) {
    const bloqueada = (esNavInterno || esIOS) ? mensajeBloqueoGps({}).replace(/«Reintentar»/g, "«Activar ubicación»")
      : "Tu ubicación está bloqueada para este sitio. Toca el candado junto a la dirección web > Permisos > Ubicación > Permitir. Al volver aquí se activará sola.";
    const textos = {
      pedir: ["Activa tu ubicación", "La necesitamos para saber dónde estás, detectar tu ciudad y llevar tu pedido. Toca «Activar ubicación» y elige «Permitir»."],
      bloqueada: ["Ubicación bloqueada", bloqueada],
      apagada: ["Enciende el GPS", "No pudimos leer tu ubicación. Enciende la ubicación (GPS) de tu teléfono desde los ajustes rápidos y toca «Activar ubicación»."]
    };
    const t = textos[tipo] || textos.pedir;
    $("ubicTitulo").textContent = t[0];
    $("ubicTexto").textContent = t[1];
    $("btnUbicActivar").disabled = false; $("btnUbicActivar").textContent = "Activar ubicación";
    $("modalUbicacion").classList.remove("oculto");
    clearInterval(tmUbic);
    tmUbic = setInterval(() => {   // si la activa desde los ajustes rápidos o los ajustes del navegador, se detecta sola
      if (ubicacionOk || document.hidden) return;
      try { navigator.geolocation.getCurrentPosition((p) => alUbicar({ lat: redondear(p.coords.latitude), lng: redondear(p.coords.longitude) }), () => { }, { enableHighAccuracy: false, timeout: 3000, maximumAge: 60000 }); } catch (_) { }
    }, 4000);
  }
  async function verificarUbicacion() {
    if (ubicVerificando || ubicacionOk || !navigator.geolocation) return;
    ubicVerificando = true;
    try {
      const r = await geoUna();   // pide el permiso si hace falta y lee la posición
      if (r.ok) alUbicar(r.pos);
      else mostrarModalUbicacion(r.code === 1 ? "bloqueada" : "apagada");
    } finally { ubicVerificando = false; }
  }
  function iniciarUbicacion() {
    if (!navigator.geolocation) return;
    $("btnUbicActivar").addEventListener("click", () => {
      $("btnUbicActivar").disabled = true; $("btnUbicActivar").textContent = "Activando…";
      verificarUbicacion().then(() => { $("btnUbicActivar").disabled = false; $("btnUbicActivar").textContent = "Activar ubicación"; });
    });
    try {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions.query({ name: "geolocation" }).then((st) => { st.onchange = () => { if (st.state === "granted" && !ubicacionOk) verificarUbicacion(); }; }).catch(() => { });
      }
    } catch (_) { }
    document.addEventListener("visibilitychange", () => { if (!document.hidden && !ubicacionOk) verificarUbicacion(); });
    verificarUbicacion();
  }
  function abrirModalCiudad() {
    const lista = $("listaCiudades");
    lista.textContent = "";
    Ciudades.habilitadas().forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = "🏙️ " + c.nombre;
      if (c.id === ciudadActiva.id) b.setAttribute("aria-current", "true");
      b.addEventListener("click", () => { aplicarCiudad(c.id, "manual"); $("modalCiudad").classList.add("oculto"); });
      lista.appendChild(b);
    });
    $("modalCiudad").classList.remove("oculto");
  }
  $("btnCiudad").addEventListener("click", abrirModalCiudad);
  $("btnCiudadCerrar").addEventListener("click", () => $("modalCiudad").classList.add("oculto"));
  $("btnCiudadAuto").addEventListener("click", () => {
    $("modalCiudad").classList.add("oculto");
    ciudadActiva = { id: ciudadActiva.id, fuente: "guardada" };
    guardarCiudadLocal();
    pintarCiudad();
    detectarCiudad();
  });
  $("modalCiudad").addEventListener("click", (ev) => { if (ev.target === $("modalCiudad")) $("modalCiudad").classList.add("oculto"); });

  /* Ciudad de un lugar del pedido: por coordenadas (GPS / pin) o por lo escrito (ciudad, barrio, reparto, comarca). null = no se pudo saber. */
  function ciudadDeLugar(l) {
    if (!l || typeof l !== "object") return null;
    if ((l.tipo === "gps" || l.tipo === "pin") && okLL(Number(l.lat), Number(l.lng))) {
      const c = Ciudades.deCoord(Number(l.lat), Number(l.lng));
      return c ? c.id : null;
    }
    if (l.tipo === "direccion") return Ciudades.deTexto(l.texto, ciudadActiva.id);
    return null;
  }

  /* Tarifa estimada de referencia (el repartidor confirma el precio final): distancia por calles ≈ línea recta × 1.3 */
  function estimarTarifa(o) {
    const pt = (l) => (l && okLL(Number(l.lat), Number(l.lng)) ? { lat: Number(l.lat), lng: Number(l.lng) } : null);
    let a = pt(o.retiro), b = pt(o.destino);
    if (o.entreCiudades) { a = a || Ciudades.porId(o.ciudadOrigen); b = b || Ciudades.porId(o.ciudadDestino); }
    if (!a || !b) return null;
    const km = Ciudades.kmRuta(a, b);
    return { km: Math.round(km * 10) / 10, tarifa: Ciudades.tarifaKm(km) };
  }
  /* Evita ambigüedades entre barrios homónimos: la dirección/negocio escrita lleva su ciudad. */
  function conCiudad(txt, ciudadId, max) {
    const t = limpiarNombre(txt), c = nombreCiudad(ciudadId);
    if (!t || t.indexOf("📍") === 0 || t.toLowerCase().indexOf(c.toLowerCase()) >= 0) return t.slice(0, max);
    const suf = " (" + c + ")";
    return (t.slice(0, max - suf.length) + suf).slice(0, max);
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

    escucharHorario();
    iniciarCiudad();
    iniciarUbicacion();

    /* Recupera perfil, sesión y conversación desde los respaldos (IndexedDB / cookie) si el navegador los perdió. */
    if (window.Almacen) { try { await Almacen.restaurar(); } catch (_) { } }
    perfil = leerPerfil();
    const ses = leerSesion();
    if (!perfil && ses) {
      perfil = { id: ses.clienteId, nombre: ses.nombre, solicitudId: ses.pedidoId };
      guardarPerfil(perfil);
    }
    if (perfil) {
      recuperando = !!(ses && ses.clienteId === perfil.id && ses.estado !== "entregado" && ses.estado !== "cancelado");
      return abrirChat();   // si aún no tiene registro, abrirChat() pide sus datos antes de continuar
    }
    mostrarRegistro();
  }

  /* Pantalla de registro: usuarios nuevos y también quienes ya habían pedido antes (se les piden al entrar) */
  function mostrarRegistro() {
    const sel = $("inPais");
    if (!sel.options.length) {
      PAISES.forEach((p) => { const o = document.createElement("option"); o.value = p.cod; o.textContent = p.bandera + " " + p.nombre + " " + p.marca; sel.appendChild(o); });
    }
    const reg = perfil && perfil.reg;
    $("inNombre").value = (perfil && perfil.nombre) || "";
    $("inApellido").value = (reg && reg.ap) || "";
    sel.value = (reg && reg.pais) || "NI";
    $("inCelular").value = (reg && reg.tel) || "";
    ajustarPais();
    $("txtRegistro").textContent = perfil
      ? "Confirma tus datos para seguir pidiendo. Tu celular solo lo ve la central."
      : "Tus datos para pedir. Tu celular solo lo ve la central.";
    $("chkTerminos").checked = false;   // la aceptación se confirma cada vez que se muestra esta pantalla
    $("msgNombre").classList.add("oculto");
    vista("vNombre");
    $((perfil && perfil.nombre) ? "inApellido" : "inNombre").focus();
  }
  function ajustarPais() {
    const p = paisDe($("inPais").value) || PAISES[0];
    const inp = $("inCelular");
    inp.maxLength = p.dig + 1;
    inp.placeholder = p.dig === 8 ? "8888 7777" : "888 7777";
    formatearCelular();
  }
  function formatearCelular() {
    const p = paisDe($("inPais").value) || PAISES[0];
    const d = $("inCelular").value.replace(/\D/g, "").slice(0, p.dig);
    $("inCelular").value = d.length > 4 ? d.slice(0, d.length - 4) + " " + d.slice(-4) : d;
  }
  $("btnVerTerminos").addEventListener("click", (ev) => { ev.preventDefault(); $("modalTerminos").classList.remove("oculto"); });
  $("btnTerminosOk").addEventListener("click", () => $("modalTerminos").classList.add("oculto"));
  $("modalTerminos").addEventListener("click", (ev) => { if (ev.target === $("modalTerminos")) $("modalTerminos").classList.add("oculto"); });
  $("inPais").addEventListener("change", ajustarPais);
  $("inCelular").addEventListener("input", formatearCelular);

  /* El celular se guarda aparte (contactosClientes/{clienteId}): solo el admin puede leerlo. No viaja en la solicitud ni lo ven los repartidores. */
  let contactoEscrito = "";
  async function guardarContacto() {
    if (!perfil || !idValido(perfil.id) || !regValido(perfil.reg) || contactoEscrito === perfil.id) return;
    const p = paisDe(perfil.reg.pais);
    const o = { nombre: perfil.nombre, apellido: perfil.reg.ap, pais: p.cod, codigo: p.marca, telefono: perfil.reg.tel, completo: p.marca + perfil.reg.tel, terminos: perfil.terminos || TERMINOS_VERSION, terminosTs: firebase.database.ServerValue.TIMESTAMP, ts: firebase.database.ServerValue.TIMESTAMP };
    try { await db.ref("contactosClientes/" + perfil.id).set(o); contactoEscrito = perfil.id; } catch (_) { }
  }

  $("formNombre").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const n = limpiarNombre($("inNombre").value), ap = limpiarNombre($("inApellido").value);
    const pais = paisDe($("inPais").value) || PAISES[0], tel = $("inCelular").value.replace(/\D/g, "");
    const msg = $("msgNombre");
    const error = !nombreValido(n) ? "Escribe tu nombre (entre 2 y 24 letras)."
      : !apellidoValido(ap) ? "Escribe tu apellido (entre 2 y 30 letras)."
      : tel.length !== pais.dig ? "El celular de " + pais.nombre + " debe tener " + pais.dig + " dígitos."
      : !$("chkTerminos").checked ? "Debes aceptar los términos y condiciones para continuar."
      : "";
    if (error) {
      msg.textContent = error;
      msg.classList.remove("oculto");
      return;
    }
    msg.classList.add("oculto");
    const reg = { ap, pais: pais.cod, tel };
    if (perfil && idValido(perfil.id)) { perfil.nombre = n; perfil.reg = reg; perfil.terminos = TERMINOS_VERSION; }   // quien ya había pedido conserva su historial
    else perfil = { id: generarId(), nombre: n, reg, terminos: TERMINOS_VERSION, solicitudId: null };
    contactoEscrito = "";
    guardarPerfil(perfil);
    guardarContacto();
    abrirChat();
  });

  /* ---------- Crear o retomar el chat ---------- */
  async function abrirChat(opc) {
    const silencioso = !!(opc && opc.silencioso);   // sin pantalla de carga: la interfaz no parpadea ni se recarga
    if (!perfil || !idValido(perfil.id)) {
      perfil = null;
      try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { }
      mostrarRegistro();
      return;
    }
    if (!regValido(perfil.reg) || perfil.terminos !== TERMINOS_VERSION) { mostrarRegistro(); return; }   // sin registro o sin aceptar los términos (p. ej. ya había pedido antes)
    guardarContacto();
    if (!silencioso) {
      $("msgCarga").className = "wa-splash-msg";
      $("msgCarga").textContent = recuperando ? "Recuperando tu pedido…" : "Abriendo tu chat…";
      vista("vCarga");
    }

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
      if (!s.exists()) { recuperando = false; borrarSesion(); if (!silencioso) await pausaSplash(); return pedirDetalles(); }
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
      ciudadRuta: pedido.ciudadRuta,
      ...(pedido.restauranteUid && Array.isArray(pedido.items) ? { restauranteUid: pedido.restauranteUid, vistaRestaurante: { items: pedido.items, subtotal: pedido.subtotal || 0, ...(pedido.nota ? { nota: pedido.nota } : {}), ts: firebase.database.ServerValue.TIMESTAMP } } : {}),
      pedido
    };
    restPrev = null; retPrev = false; cronoRest(null);
    try {
      await refSolicitud.set(base);
    } catch (e) {
      /* Reglas aún sin los campos de ciudad: reintenta sin ellos (el pedido queda sin aislamiento por ciudad hasta publicar las reglas). */
      if (!e || e.code !== "PERMISSION_DENIED") throw e;
      const { ciudadOrigen: _co, ciudadDestino: _cd, ciudadRuta: _cr, entreCiudades: _ec, kmEstimado: _km, tarifaEstimada: _te, ...sinCiudad } = pedido;
      const { ciudadRuta: _top, ...baseSin } = base;
      try {
        await refSolicitud.set({ ...baseSin, pedido: sinCiudad });
      } catch (e2) {
        /* Reglas aún sin los campos nuevos (tipo / retiro): reintenta con el formato anterior. */
        if (!e2 || e2.code !== "PERMISSION_DENIED") throw e2;
        const { tipo, retiro, servicio: _srv, contacto: _ctc, ...anterior } = sinCiudad;
        await refSolicitud.set({ ...baseSin, pedido: anterior });
      }
    }
    if (pedido.restauranteUid && perfil && perfil.solicitudId) {   // índice que lee el restaurante (restaurantePedidos/{uid}/{id})
      try { await db.ref("restaurantePedidos/" + pedido.restauranteUid + "/" + perfil.solicitudId).set(firebase.database.ServerValue.TIMESTAMP); } catch (_) { }
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
    pintarArchivoChat();
    escucharSolicitud();
    escucharLeidos();
    escucharTyping();
    escucharMensajes();
    escucharRepartidorGps();
    marcarLeidoPropio();
    programarAvisoFuera();
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
    autoRecibido = false; avisoFueraMostrado = false; clearTimeout(tmAvisoFuera);
    cierreTs = 0; clearTimeout(tmCaduca);
    pintarAvatar(null, "");
    limpiarMapa();
  }

  /* ---------- Negociación de tarifa: el cliente ve las tarifas de todos los repartidores y elige ---------- */
  let negAcepVisto = null;
  function toastNeg(texto) {
    let t = $("toastNeg");
    if (!t) { t = document.createElement("div"); t.id = "toastNeg"; t.className = "toast-neg"; t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = texto; t.classList.add("ver");
    clearTimeout(toastNeg._t); toastNeg._t = setTimeout(() => t.classList.remove("ver"), 3500);
  }
  function pintarNegociacion(d, asignadoYa) {
    const n = d.negociacion, ref = $("avisoEspera");
    const ofertas = n && n.ofertas && typeof n.ofertas === "object" ? Object.entries(n.ofertas) : [];
    const fij = n && n.fijo && Number(n.fijo.monto) > 0 ? n.fijo : null;
    const acep = n && n.aceptada && typeof n.aceptada === "object" ? n.aceptada : fij;
    /* Tarifa aceptada: NO se deja nada en pantalla (como WhatsApp). Solo un aviso breve que se quita solo. */
    const claveAcep = acep ? String(acep.uid || "fijo") + ":" + Math.round(Number(acep.monto) || 0) : "";
    if (negAcepVisto === null) negAcepVisto = claveAcep;
    else if (claveAcep && claveAcep !== negAcepVisto) { negAcepVisto = claveAcep; toastNeg("✅ Tarifa aceptada · C$ " + Math.round(Number(acep.monto) || 0)); }
    else if (!claveAcep) negAcepVisto = "";
    const activa = !acep && ofertas.length > 0;
    let c = $("negCliente");
    if (!c) {
      if (!activa || !ref) return;
      c = document.createElement("div"); c.id = "negCliente"; c.className = "neg-cliente";
      ref.parentNode.insertBefore(c, ref);
    }
    c.classList.toggle("oculto", !activa);
    if (!activa) { c.textContent = ""; return; }
    const mk = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
    const money = (x) => "C$ " + Math.round(Number(x) || 0);
    c.textContent = "";
    const desc = n.descartadas && typeof n.descartadas === "object" ? n.descartadas : {};
    const vivas = ofertas.filter(([uid, o]) => o && Number(o.monto) > 0 && Number(o.monto) !== Number(desc[uid])).sort((a, b) => a[1].monto - b[1].monto);
    c.appendChild(mk("small", "", "💰 Tarifa de tu envío"));
    if (!vivas.length) { c.appendChild(mk("small", "neg-esp", "No hay ofertas disponibles ahora. Esperando nuevas tarifas de los repartidores…")); return; }
    c.appendChild(mk("b", "neg-total", "Desde " + money(vivas[0][1].monto)));
    c.appendChild(mk("small", "neg-tit", "Elige con qué repartidor quieres tu pedido"));
    vivas.forEach(([uid, o]) => {
      const fila = mk("div", "neg-of"), info = mk("div", "neg-of-i");
      info.appendChild(mk("b", "", String(o.nombre || "Repartidor").slice(0, 40)));
      const sub = [Number(o.km) > 0 ? Number(o.km).toFixed(1) + " km" : "", Number(o.nParadas) > 1 ? (o.nParadas - 1) + " parada(s) extra" : "", o.tipo === "central" ? "Propuesta de la central" : Number(o.monto) > Number(o.sugerida) ? "Sugerida " + money(o.sugerida) + " → subió" : "Tarifa sugerida"].filter(Boolean).join(" · ");
      info.appendChild(mk("small", "", sub));
      fila.appendChild(info);
      fila.appendChild(mk("strong", "", money(o.monto)));
      const bt = mk("div", "neg-bt");
      const ok = mk("button", "neg-si", "Aceptar"); ok.type = "button";
      ok.addEventListener("click", () => {
        if (!window.confirm("¿Aceptar " + money(o.monto) + " con " + String(o.nombre || "este repartidor").slice(0, 40) + "?")) return;
        ok.disabled = true;
        refSolicitud.child("negociacion/aceptada").set({ uid, nombre: String(o.nombre || "Repartidor").slice(0, 60), monto: Math.round(o.monto), ts: firebase.database.ServerValue.TIMESTAMP })
          .catch(() => { ok.disabled = false; avisoSistema("No se pudo aceptar esa oferta. Intenta de nuevo."); });
      });
      const no = mk("button", "neg-no", "No acepto"); no.type = "button";
      no.addEventListener("click", () => {
        no.disabled = true;
        refSolicitud.child("negociacion/descartadas/" + uid).set(Math.round(o.monto))
          .catch(() => { no.disabled = false; avisoSistema("No se pudo descartar esa oferta."); });
      });
      bt.appendChild(ok); bt.appendChild(no); fila.appendChild(bt);
      c.appendChild(fila);
    });
  }

  /* ---------- Estado del restaurante (solicitudes_entrantes/{id}/rest, lo escribe restaurante.js) ---------- */
  let restPrev = null, cronoT = null;
  /* Cronómetro del tiempo de preparación que pidió el restaurante */
  function cronoRest(r) {
    let el = document.getElementById("restCrono");
    const fin = r && Number(r.prepMin) && Number(r.aceptadoTs) ? Number(r.aceptadoTs) + Number(r.prepMin) * 60000 : 0;
    const activo = fin && (r.estado === "aceptado" || r.estado === "preparando");
    clearInterval(cronoT);
    if (!activo) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div"); el.id = "restCrono";
      el.style.cssText = "align-self:flex-end;width:fit-content;margin:4px 12px 4px auto;padding:4px 14px;border-radius:999px;font-size:15px;font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:.3px;color:#fff;background:#FF6A00;box-shadow:0 2px 8px rgba(255,106,0,.55)";
      const cv = $("mensajes"); cv.parentNode.insertBefore(el, cv);
    }
    const tick = () => {
      const d = fin - Date.now(), a = Math.abs(Math.round(d / 1000));
      el.style.background = d < 0 ? "#D90429" : "#FF6A00"; el.style.boxShadow = d < 0 ? "0 2px 8px rgba(217,4,41,.6)" : "0 2px 8px rgba(255,106,0,.55)";
      el.textContent = (d < 0 ? "⚠️ +" : "⏱ ") + String(Math.floor(a / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0");
    };
    tick(); cronoT = setInterval(tick, 1000);
  }
  let retPrev = false;
  function pintarRetiro(x) {
    if (!pedidoActual || !pedidoActual.restauranteUid || retPrev || !x || !x.ts) return;
    retPrev = true;
    avisoSistema("🛵 Tu repartidor ya retiró tu pedido en " + String(pedidoActual.restauranteNombre || "el negocio").slice(0, 60) + " y va en camino." + (Number(x.delivery) >= 0 ? " Delivery: C$ " + Number(x.delivery).toFixed(2) + "." : ""));
  }
  function pintarRestaurante(r) {
    if (!pedidoActual || !pedidoActual.restauranteUid) return;
    const e = r && typeof r.estado === "string" ? r.estado : "pendiente";
    cronoRest(r);
    if (e === restPrev) return;
    restPrev = e;
    const n = String(pedidoActual.restauranteNombre || "El restaurante").slice(0, 60);
    const t = {
      aceptado: "🍔 " + n + " aceptó tu pedido" + (Number(r.prepMin) ? " (~" + Math.round(Number(r.prepMin)) + " min de preparación)." : "."),
      preparando: "👨‍🍳 ¡" + n + " ya está cocinando tu pedido!" + (Number(r.prepMin) ? " Estará listo en ~" + Math.round(Number(r.prepMin)) + " min." : ""),
      listo: "🛍️ Tu pedido ya está listo en " + n + ". El repartidor pasa por él.",
      rechazado: "⚠️ " + n + " no puede preparar tu pedido" + (r && r.motivo ? ": " + String(r.motivo).slice(0, 120) : ".") + " Puedes cancelar la solicitud o esperar indicaciones de la central."
    }[e];
    if (t) avisoSistema(t);
  }

  /* ---------- Estado de la solicitud ---------- */
  function escucharSolicitud() {
    refSolicitud.on("value", (s) => {
      if (!s.exists()) {
        if (cerrado) return;
        /* La solicitud desapareció con el chat abierto (la central la canceló o la limpió): se cierra el ciclo SIN recargar,
           con las escuchas vivas y el chat visible para que el cliente pueda seguir escribiendo. */
        if (!primerSnapshot) { recuperando = false; borrarSesion(); return cerrarCiclo({ estado: "cancelado", canceladoPor: "admin", ts: Date.now() }); }
        detenerTodo();
        return abrirChat({ silencioso: true });
      }
      const d = s.val() || {};
      pedidoActual = d.pedido && typeof d.pedido === "object" ? d.pedido : null;
      pintarRestaurante(d.rest);
      pintarRetiro(d.retiroRest);
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
      pintarNegociacion(d, ahoraAsignado);
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
    const img = $("avatarFoto"), letra = $("avatarLetra"), logo = $("avatarLogo");
    letra.textContent = uid ? (nombre || "R").charAt(0).toUpperCase() : "B";
    /* Sin repartidor: logo de Brother’s. Con repartidor: se oculta el logo y aparece su foto (o su inicial). */
    if (logo) logo.classList.toggle("oculto", !!uid);
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
    if (!conRepartidor) $("subChat").textContent = cerradoServicio ? "Fuera de servicio" : tb.sub;
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
    if (cerrado) { sub.textContent = "Pedido finalizado"; sub.classList.remove("escribiendo"); return; }
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
      sub.textContent = cerradoServicio ? "Fuera de servicio" : textoBusqueda().sub;
      sub.classList.remove("escribiendo");
    }
  }
  $("inMensaje").addEventListener("input", () => { if (asignado) marcarTypingPropio(); });

  /* ---------- Mensajes ---------- */
  let ultimoDe = null, ultimoDia = null;
  const vistos = new Set();

  function escucharMensajes() {
    refMensajes.limitToLast(300).on("child_added", (s) => {
      if (vistos.has(s.key)) return;
      vistos.add(s.key);
      const m = s.val();
      if (!m || typeof m !== "object") return;
      if (m.auto === true && m.de === "admin") autoRecibido = true;   // el servidor ya envió el mensaje de ausencia
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

  /* Inserta contenido ARRIBA (archivo, historial local) sin mover lo que la persona está viendo:
     si estaba al final se queda al final; si estaba leyendo historial, conserva su posición. */
  function conservarScroll(fn) {
    const c = $("mensajes");
    const pegado = pegadoAlFinal(), alto = c.scrollHeight, top = c.scrollTop;
    fn();
    c.scrollTop = pegado ? c.scrollHeight : top + (c.scrollHeight - alto);
  }

  function avisoSistema(texto) {
    const seguir = pegadoAlFinal();
    const el = document.createElement("div");
    el.className = "wa-sistema";
    el.textContent = texto;
    $("mensajes").appendChild(el);
    ultimoDe = null;
    if (seguir) alFinal();
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
      if (m.de === "admin") { const q = document.createElement("small"); q.className = "wa-de"; q.textContent = "🛵 Central"; burbuja.appendChild(q); }
      else if (m.de === "restaurante") { const q = document.createElement("small"); q.className = "wa-de"; q.textContent = "🍔 " + String((pedidoActual && pedidoActual.restauranteNombre) || "Restaurante").slice(0, 40); burbuja.appendChild(q); }
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
    if (seguir) { alFinal(); if (yo) pegados.mensajes = true; }   // al enviar un mensaje propio siempre baja; si leía historial, no lo arrastra al recibir
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
    const texto = limpiarTexto(inp.value).slice(0, MAX_TEXTO);   // conserva los saltos de línea
    /* Pedido terminado: al escribir, el chat se reinicia con los botones guiados para un pedido NUEVO */
    if (cerrado) {
      if (!texto) return;
      if (cerradoServicio) { inp.value = ""; ajustarAlto(inp); avisoSistema(mensajeFuera()); return; }   // fuera de servicio: no arranca otro pedido
      inp.value = ""; ajustarAlto(inp); nuevoPedidoDesdeChat(); return;
    }
    if (!texto || !asignado || !refMensajes) return;

    inp.value = ""; ajustarAlto(inp);
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
    catch (e) { inp.value = texto; ajustarAlto(inp); mostrarError("No se pudo enviar el mensaje: " + (e.code || e.message)); }
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
  const SERVICIOS = ["enviar", "retirar", "comida", "mandado", "pickup"];

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

  /* Selección múltiple: el cliente marca varias opciones y pulsa el botón final. Resuelve con lista de claves. */
  function multiOpciones(id, lista, textoOk, textoNada) {
    return new Promise((res) => {
      if (!vivo(id)) return;
      const g = document.createElement("div");
      g.className = "wa-quick wa-quick-hilo";
      g.setAttribute("role", "group");
      const sel = new Set(), bs = [];
      const ok = document.createElement("button");
      ok.type = "button"; ok.className = "wa-quick-btn"; ok.style.cssText = "font-weight:800;border-color:#FF6A00";
      const pintarOk = () => { ok.textContent = sel.size ? "✅ " + (textoOk || "Continuar") + " (" + sel.size + ")" : "➡️ " + (textoNada || "Ninguno, continuar"); };
      lista.forEach((o) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "wa-quick-btn"; b.textContent = "⬜ " + o.texto;
        b.addEventListener("click", () => {
          if (sel.has(o.clave)) { sel.delete(o.clave); b.textContent = "⬜ " + o.texto; b.style.background = ""; b.style.color = ""; }
          else { sel.add(o.clave); b.textContent = "☑️ " + o.texto; b.style.background = "#FF6A00"; b.style.color = "#fff"; }
          pintarOk();
        });
        bs.push(b); g.appendChild(b);
      });
      ok.addEventListener("click", () => {
        if (!vivo(id)) return;
        const claves = lista.filter((o) => sel.has(o.clave));
        g.remove();
        addYo(claves.length ? "➕ " + claves.map((o) => o.texto.replace(/\s*·.*$/, "")).join(", ") : "No, gracias");
        res(claves.map((o) => o.clave));
      });
      pintarOk(); g.appendChild(ok);
      $("convo").appendChild(g);
      bajar();
    });
  }

  /* Respuesta escrita: habilita el compositor inferior hasta que el cliente envía. */
  function apagarComposer() {
    const i = $("inConvo");
    i.value = ""; i.disabled = true; i.placeholder = "Elige una opción…"; ajustarAlto(i);
    $("btnConvo").disabled = true;
  }

  function pedirTexto(id, placeholder, min, errorMsg, max) {
    return new Promise((res) => {
      if (!vivo(id)) return;
      pendTexto = { id, min, max: max || 1000, errorMsg, res };
      const i = $("inConvo");
      i.disabled = false; i.value = ""; i.placeholder = placeholder; ajustarAlto(i);
      $("btnConvo").disabled = false;
      setTimeout(() => i.focus(), 60);
    });
  }

  $("formConvo").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const p = pendTexto;
    if (!p || !vivo(p.id)) return;
    const t = limpiarTexto($("inConvo").value);
    if (t.length < p.min) { addBot(p.errorMsg); return; }
    pendTexto = null;
    apagarComposer();
    addYo(t);
    p.res(t.slice(0, p.max));
  });

  /* ---------- GPS en tiempo real ---------- */
  const UA = navigator.userAgent || "";
  const esIOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  /* Navegadores internos (WhatsApp, Facebook, Instagram, Messenger, TikTok, Snapchat, Line…): en iPhone bloquean la ubicación. */
  const esNavInterno = /FBAN|FBAV|FB_IAB|Instagram|Messenger|WhatsApp|TikTok|musical_ly|Snapchat|Line\/|MicroMessenger|GSA\//i.test(UA) ||
    (esIOS && /AppleWebKit/i.test(UA) && !/Safari\//i.test(UA) && !window.navigator.standalone);

  function estadoPermisoGps() {
    try {
      if (!navigator.permissions || !navigator.permissions.query) return Promise.resolve("");
      return navigator.permissions.query({ name: "geolocation" }).then((r) => r.state || "").catch(() => "");
    } catch (e) { return Promise.resolve(""); }
  }

  /* Una lectura de posición. Si el GPS fino tarda o falla (típico en iPhone bajo techo), reintenta con precisión normal. */
  function geoUna() {
    return new Promise((ok) => {
      if (!navigator.geolocation) return ok({ ok: false, code: 0 });
      const bien = (p) => ok({ ok: true, pos: { lat: redondear(p.coords.latitude), lng: redondear(p.coords.longitude) } });
      navigator.geolocation.getCurrentPosition(
        bien,
        (e) => {
          const code = e && e.code;
          if (code === 1) return estadoPermisoGps().then((estado) => ok({ ok: false, code: 1, estado }));
          navigator.geolocation.getCurrentPosition(
            bien,
            (e2) => ok({ ok: false, code: (e2 && e2.code) || code }),
            { enableHighAccuracy: false, timeout: 20000, maximumAge: 60000 }
          );
        },
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
      );
    });
  }

  /* Mensaje claro según el caso real: navegador interno, iPhone o Android/otro. */
  function mensajeBloqueoGps(r) {
    if (esNavInterno) {
      return "La ubicación no funciona dentro de esta ventana (WhatsApp, Facebook, Instagram…). Toca los tres puntos o el ícono de compartir y elige «Abrir en Safari». Ahí podrás permitir la ubicación.";
    }
    if (esIOS) {
      return "Tu iPhone tiene la ubicación bloqueada para este sitio. Para arreglarlo:\n" +
        "1) Ajustes > Privacidad y seguridad > Localización: actívala.\n" +
        "2) En esa misma pantalla entra a «Sitios web de Safari» y elige «Al usar la app» o «Preguntar».\n" +
        "3) En Safari toca «AA» (barra de direcciones) > Ajustes del sitio web > Ubicación > Permitir.\n" +
        "Luego vuelve aquí y toca «Reintentar».";
    }
    return "Tu ubicación está bloqueada. Permite la ubicación para este sitio en los ajustes de tu navegador (candado junto a la dirección > Permisos > Ubicación) y toca «Reintentar».";
  }

  /* Obliga a tener la ubicación en vivo. Devuelve {lat,lng} o null si la conversación se reinició. */
  /* Tocar el botón («Yo recibo», «Mi ubicación en vivo», «Enviar»…) ya es la confirmación del cliente:
     la ubicación se activa de inmediato, sin preguntar de nuevo. */
  async function obtenerGps(id) {
    let primera = true;
    while (vivo(id)) {
      const r = await geoUna();
      if (!vivo(id)) return null;
      if (r.ok) {
        gpsListo = r.pos;
        return gpsListo;
      }
      addBot(r.code === 1
        ? mensajeBloqueoGps(r)
        : (esIOS
          ? "No pude obtener tu ubicación. Revisa que «Localización» esté activada en Ajustes > Privacidad y seguridad, sal a un lugar con mejor señal y toca «Reintentar»."
          : "No pude obtener tu ubicación. Enciende el GPS de tu celular y toca «Reintentar»."));
      const c = await opciones(id, [
        { clave: "d", texto: "🏠 Escribir mi dirección" },
        { clave: "r", texto: "📍 Reintentar ubicación" },
        { clave: "x", texto: "↩️ Volver al inicio" }
      ]);
      if (!vivo(id)) return null;
      if (c === "x") { reiniciarConvo(); return null; }
      if (c === "d") {
        if (!(await di(id, "Sin problema. Escribe tu dirección exacta: calle, barrio y una referencia (por ejemplo, «frente a la pulpería»)."))) return null;
        const t = await pedirTexto(id, "Calle, número, referencia", 5, "Escribe la dirección con un poco más de detalle (mínimo 5 letras).", 200);
        if (!vivo(id)) return null;
        return { manual: true, texto: t.slice(0, 200) };
      }
    }
    return null;
  }

  /* Convierte lo que devuelve obtenerGps en un lugar del pedido: GPS en vivo o dirección escrita. */
  const lugarDeGps = (g) => g.manual ? { tipo: "direccion", texto: g.texto } : { tipo: "gps", lat: g.lat, lng: g.lng };

  /* ---------- Mapa dentro del chat ---------- */
  function mapaBurbuja(id, ciudadId) {
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

      const usarGps = !!gpsListo;
      const centro = usarGps ? [gpsListo.lat, gpsListo.lng] : centroCiudad(ciudadId || ciudadActiva.id);
      const m = L.map(cont, { zoomControl: false }).setView(centro, usarGps ? 16 : 14);
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
    const cid = ciudadActiva.id;
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
        const g = await obtenerGps(id);
        if (!g) return null;
        return lugarDeGps(g);
      }
      if (c === "pin") {
        const p = await mapaBurbuja(id, cid);
        if (!vivo(id)) return null;
        if (p) return { tipo: "pin", lat: p.lat, lng: p.lng };
        continue;
      }
      if (c === "dir") {
        if (!(await di(id, "Escribe la dirección exacta: calle, barrio y una referencia (por ejemplo, «frente a la pulpería»)."))) return null;
        const t = await pedirTexto(id, "Calle, número, referencia", 5, "Escribe la dirección con un poco más de detalle (mínimo 5 letras).", 200);
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
    /* La app deduce sola si es «entre ciudades»: ciudad de retiro (o del negocio escrito) vs ciudad de entrega */
    const cO = (p.retiro ? ciudadDeLugar(p.retiro) : Ciudades.deTexto(p.origen, ciudadActiva.id)) || ciudadActiva.id;
    const cD = ciudadDeLugar(p.destino) || ciudadActiva.id;
    const entre = cO !== cD;
    const lug = (l, nombre, ciudadId) => {
      if (!l || typeof l !== "object") throw new Error("Falta " + nombre + ".");
      if (l.tipo === "direccion") {
        const t = conCiudad(l.texto, ciudadId || cD, 200);
        if (t.length < 5) throw new Error("La dirección de " + nombre + " es muy corta.");
        return { tipo: "direccion", texto: t };
      }
      if ((l.tipo === "gps" || l.tipo === "pin") && okLL(Number(l.lat), Number(l.lng))) {
        return { tipo: l.tipo, lat: redondear(Number(l.lat)), lng: redondear(Number(l.lng)) };
      }
      throw new Error("La ubicación de " + nombre + " no es válida.");
    };
    if (SERVICIOS.indexOf(p.servicio) < 0) throw new Error("Servicio desconocido.");
    const quiere = limpiarTexto(p.quiere).slice(0, 1000), origen = conCiudad(p.origen, cO, 120);
    if (quiere.length < 2 || origen.length < 2) throw new Error("Faltan datos del pedido.");
    const o = {
      servicio: p.servicio, tipo: p.tipo === "compra" ? "compra" : "envio", quiere, origen,
      modo: p.modo === "recibe" ? "recibe" : "envia", destino: lug(p.destino, "entrega", cD),
      ciudadOrigen: cO, ciudadDestino: cD, ciudadRuta: cO, entreCiudades: entre   // ciudadRuta = ciudad donde se RETIRA: sus repartidores reciben el pedido
    };
    if (p.retiro) o.retiro = lug(p.retiro, "retiro", cO);
    if (p.restauranteUid && Array.isArray(p.items) && p.items.length) {
      o.restauranteUid = String(p.restauranteUid).slice(0, 64);
      o.restauranteNombre = limpiarNombre(p.restauranteNombre).slice(0, 60);
      o.items = p.items.slice(0, 30).map((i) => ({ n: limpiarNombre(i.n).slice(0, 60), q: Math.max(1, Math.min(99, parseInt(i.q, 10) || 1)), p: Math.round((Number(i.p) || 0) * 100) / 100 }));
      o.subtotal = Math.round(o.items.reduce((a, i) => a + i.p * i.q, 0) * 100) / 100;
      const nota = limpiarTexto(p.nota).slice(0, 200);
      if (nota) o.nota = nota;
      if (Array.isArray(p.otros) && p.otros.length) o.otros = p.otros.slice(0, 10).map((x) => ({ l: limpiarNombre(x.l).slice(0, 40) || "Otro lugar", n: limpiarNombre(x.n).slice(0, 60) || "Compra", q: Math.max(1, Math.min(99, parseInt(x.q, 10) || 1)), p: Math.max(0, Math.round((Number(x.p) || 0) * 100) / 100) }));
    }
    const contacto = limpiarNombre(p.contacto).slice(0, 80);
    if (contacto.length >= 2) o.contacto = contacto;
    const est = estimarTarifa(o);
    if (est) { o.kmEstimado = est.km; o.tarifaEstimada = est.tarifa; }
    return o;
  }

  /* ---------- Cierre de cualquier flujo: consolida, envía a Firebase y pasa a la pantalla de búsqueda ---------- */
  async function finalizar(id, bruto) {
    if (!vivo(id)) return;
    if (cerradoServicio) { addBot("⛔ " + mensajeFuera()); return; }
    let pedido;
    try { pedido = consolidarPedido(bruto); }
    catch (e) {
      addBot("No pude armar tu solicitud: " + e.message + " Volvamos a empezar.");
      await opciones(id, [{ clave: "x", texto: "↩️ Volver al inicio" }]);
      if (vivo(id)) { borrarConvo(); reiniciarConvo(); }
      return;
    }
    if (pedido.entreCiudades) {
      if (!(await di(id, "🚚 Entre ciudades: " + nombreCiudad(pedido.ciudadOrigen) + " → " + nombreCiudad(pedido.ciudadDestino) + ". Lo atenderán repartidores de " + nombreCiudad(pedido.ciudadOrigen) + "."))) return;
    }
    if (pedido.tarifaEstimada) {
      if (!(await di(id, "💰 Tarifa estimada" + (pedido.entreCiudades ? " (" + nombreCiudad(pedido.ciudadOrigen) + " → " + nombreCiudad(pedido.ciudadDestino) + ")" : "") + ": C$ " + pedido.tarifaEstimada + " · ~" + pedido.kmEstimado + " km. El repartidor confirma el precio final contigo."))) return;
    }
    if (!(await di(id, pedido.servicio === "pickup"
      ? "✅ ¡Listo! Ya tengo todo. Buscando un conductor para tu pickup…"
      : "✅ ¡Listo! Ya tengo todo. Buscando un repartidor para tu pedido…"))) return;
    try {
      await crearSolicitud(pedido);
      guardarResumenLocal(pedido);
      guardarSesion({ estado: "nuevo" });
      if (!pedido.entreCiudades) guardarUltimaDireccion(pedido.destino, pedido.ciudadDestino);
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
    if (!v.gps && !v.retiroDir) {
      const g = await obtenerGps(id);
      if (!g || !vivo(id)) return;
      if (g.manual) guardar("retiroDir", { tipo: "direccion", texto: g.texto });
      else guardar("gps", g);
    } else if (v.gps) gpsListo = v.gps;
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
    const retiroEnv = v.retiroDir ? v.retiroDir : { tipo: "gps", lat: v.gps.lat, lng: v.gps.lng };
    await finalizar(id, {
      servicio: "enviar", tipo: "envio", quiere: v.quiere, origen: origenTexto(retiroEnv), modo: "envia",
      retiro: retiroEnv, destino: v.destino
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
  const RESUMEN_ITEMS = (items) => items.map((i) => i.q + " × " + i.n).join(", ").slice(0, 1000);

  /* Restaurantes ABIERTOS de la ciudad activa (restaurantes/{uid}, ficha pública). Si falla o no hay, el flujo sigue como antes (texto libre). */
  const DIAS_H = ["dom", "lun", "mar", "mie", "jue", "vie", "sab"];
  const minH = (s) => { const m = /^(\d{2}):(\d{2})$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  /* Horario por día: sin horario guardado = siempre disponible. Soporta cierre pasada la medianoche. */
  function dentroHorario(h, f) {
    if (!h || typeof h !== "object" || !Object.keys(h).length) return true;
    f = f || new Date();
    const hoy = h[DIAS_H[f.getDay()]], ayer = h[DIAS_H[(f.getDay() + 6) % 7]], n = f.getHours() * 60 + f.getMinutes();
    if (hoy) { const a = minH(hoy.a), c = minH(hoy.c); if (a != null && c != null && (a < c ? n >= a && n < c : n >= a)) return true; }
    if (ayer) { const a = minH(ayer.a), c = minH(ayer.c); if (a != null && c != null && c <= a && n < c) return true; }
    return false;
  }
  let errRest = "";
  async function cargarRestaurantes() {
    errRest = "";
    try {
      const s = await db.ref("restaurantes").orderByChild("ciudad").equalTo(ciudadActiva.id).once("value");
      return Object.entries(s.val() || {})
        .filter(([, r]) => r && r.activo !== false && r.suspendida !== true && r.abierto === true && dentroHorario(r.horario) && typeof r.nombre === "string")
        .map(([uid, r]) => ({ uid, nombre: String(r.nombre).slice(0, 60), lat: Number(r.lat), lng: Number(r.lng), prepMin: Number(r.prepMin) || 0, menuDe: typeof r.menuDe === "string" ? r.menuDe : "" }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre)).slice(0, 30);
    } catch (er) { errRest = (er && (er.code || er.message)) || "error"; return []; }
  }

  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  const cachePlatos = {};
  const normOpc = (a, max) => (Array.isArray(a) ? a : []).filter((x) => x && typeof x.n === "string" && x.n && Number(x.p) >= 0).slice(0, max).map((x) => ({ n: x.n.slice(0, 24), p: Math.round(Number(x.p) * 100) / 100 }));
  /* Platos activos de un restaurante (menus/{uid}), con caché por sesión. */
  async function cargarPlatos(uid) {
    if (cachePlatos[uid] && Date.now() - cachePlatos[uid].t < 60000) return cachePlatos[uid].v;
    let platos = [], ordenCats = [];
    try {
      try { const sc = await db.ref("menusCats/" + uid).once("value"), vc = sc.val(); if (Array.isArray(vc)) ordenCats = vc.filter((x) => typeof x === "string"); } catch (_) { }
      const s = await db.ref("menus/" + uid).once("value");
      platos = Object.entries(s.val() || {}).map(([k, p]) => ({ k, ...p }))
        .filter((p) => p && p.activo !== false && typeof p.nombre === "string" && Number(p.precio) >= 0)
        .map((p) => ({ ...p, sabores: Array.isArray(p.sabores) ? p.sabores.filter((x) => typeof x === "string" && x).slice(0, 8) : [],
          variantes: normOpc(p.variantes, 6), extras: normOpc(p.extras, 8) }))
        .sort((a, b) => { const ia = ordenCats.indexOf(a.cat || ""), ib = ordenCats.indexOf(b.cat || ""); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || String(a.cat || "").localeCompare(String(b.cat || "")) || (a.orden || 0) - (b.orden || 0); }).slice(0, 60);
    } catch (_) { }
    cachePlatos[uid] = { t: Date.now(), v: platos }; return platos;
  }

  const STOP = new Set(["de", "del", "la", "el", "los", "las", "con", "sin", "y", "un", "una", "unos", "unas", "quiero", "quisiera", "pedir", "comer", "para", "por", "algo", "me", "mi", "en", "al"]);
  const raiz = (w) => (w.length > 5 ? w.slice(0, 5) : w.length > 3 ? w.replace(/(es|s)$/, "") : w);
  /* Busca por nombre del negocio o por plato/categoría (solo platos disponibles). Devuelve los negocios que lo tienen,
     los que coinciden con todo primero y los que coinciden con parte después. */
  async function buscarRestaurantes(lista, texto) {
    const tk = [...new Set(norm(texto).split(/[^a-z0-9ñ]+/).filter((x) => x.length >= 2 && !STOP.has(x)))];
    if (!tk.length) return [];
    const res = await Promise.all(lista.map(async (r) => {
      const platos = await cargarPlatos(r.menuDe || r.uid), nn = norm(r.nombre);
      let mejor = 0; const hit = [];
      platos.forEach((p) => {
        const h = norm(p.nombre + " " + (p.desc || "") + " " + (p.cat || "") + " " + (p.sabores || []).join(" "));
        const n = tk.filter((x) => h.includes(raiz(x))).length;
        if (n) { hit.push({ n, nombre: p.nombre }); mejor = Math.max(mejor, n); }
      });
      const nomN = tk.filter((x) => nn.includes(raiz(x))).length;
      const total = Math.max(mejor, nomN);
      if (!total) return null;
      hit.sort((a, b) => b.n - a.n);
      return { ...r, _n: total, _t: tk.length, hint: hit.filter((x) => x.n === mejor).slice(0, 2).map((x) => x.nombre).join(", ") };
    }));
    return res.filter(Boolean).sort((a, b) => b._n - a._n || a.nombre.localeCompare(b.nombre));
  }

  function estiloMenu() {
    if (document.getElementById("estiloMenuRest")) return;
    const st = document.createElement("style"); st.id = "estiloMenuRest";
    st.textContent = ".wa-menu{align-self:stretch;margin:4px 0;background:#fff;border-radius:12px;padding:8px;box-shadow:0 1px 2px rgba(0,0,0,.15);display:grid;gap:4px;color:#0E141B;max-width:100%}" +
      ".wa-menu h4{margin:0 0 2px;font-size:13px;font-weight:800}.wa-menu .wm-lista{max-height:38vh;overflow:auto;display:grid;gap:0;position:relative}" +
      ".wa-menu .wm-chips{display:flex;gap:4px;overflow-x:auto;padding:2px 0 4px;scrollbar-width:none}.wa-menu .wm-chip{flex:none;width:auto;border:1px solid #FF6A00;background:#fff;color:#C2410C;border-radius:999px;padding:2px 8px;font-size:11px;font-weight:700;line-height:1.2;min-height:0;height:auto}.wa-menu .wm-chip.on{background:#FF6A00;color:#fff}.wa-menu .wm-oculto{display:none!important}" +
      ".wa-menu .wm-cat{margin:6px 0 2px;font-size:10.5px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;color:#5B6672}" +
      ".wa-menu .wm-fila{display:grid;grid-template-columns:36px minmax(0,1fr) auto;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid #EEF1F4}" +
      ".wa-menu .wm-img{width:36px;height:36px;border-radius:8px;background:#F1F4F7;display:grid;place-items:center;font-size:18px;overflow:hidden}.wa-menu .wm-img img{width:100%;height:100%;object-fit:cover}" +
      ".wa-menu .wm-n{min-width:0;display:grid}.wa-menu .wm-n b{font-size:13px;font-weight:700;line-height:1.2;overflow-wrap:anywhere}.wa-menu .wm-n em{font-style:normal;font-size:12px;font-weight:800;color:#075E54}" +
      ".wa-menu .wm-q{display:flex;align-items:center;gap:6px}.wa-menu .wm-q button{width:26px;height:26px;border-radius:50%;border:1.5px solid #075E54;background:#fff;color:#075E54;font-size:15px;font-weight:800;line-height:1;padding:0}" +
      ".wa-menu .wm-q span{min-width:14px;text-align:center;font-weight:800;font-size:13px}" +
      ".wa-menu .wm-pie{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px}.wa-menu .wm-pie b{font-size:12.5px}" +
      ".wa-menu .wm-ok{height:34px;padding:0 14px;border:0;border-radius:17px;background:#075E54;color:#fff;font-weight:800;font-size:13px}.wa-menu .wm-ok:disabled{opacity:.45}.wa-menu .wm-no{height:26px;border:0;background:none;color:#5B6672;font-weight:700;font-size:12px;justify-self:start}";
    document.head.appendChild(st);
  }

  /* Menú compacto del negocio (menus/{uid}). Después de confirmar, pregunta el sabor de cada bebida.
     Resuelve { items, nota } | { sinMenu } | { volver } */
  function armarPedidoMenu(id, r) {
    return new Promise(async (res) => {
      const platos = await cargarPlatos(r.menuDe || r.uid);
      if (!vivo(id)) return;
      if (!platos.length) return res({ sinMenu: true });
      estiloMenu();
      const cant = {}, caja = document.createElement("div");
      caja.className = "wa-menu";
      const h = document.createElement("h4"); h.textContent = "🍔 " + r.nombre; caja.appendChild(h);
      const chips = document.createElement("div"); chips.className = "wm-chips"; caja.appendChild(chips);
      let catFiltro = null;
      const aplicarFiltro = (k) => {
        catFiltro = k;
        lista.querySelectorAll("[data-cat]").forEach((x) => x.classList.toggle("wm-oculto", k !== null && x.dataset.cat !== k));
        chips.querySelectorAll(".wm-chip").forEach((x) => x.classList.toggle("on", (x.dataset.k === undefined ? null : x.dataset.k) === k));
        lista.scrollTop = 0;
      };
      const cTodo = document.createElement("button"); cTodo.type = "button"; cTodo.className = "wm-chip on"; cTodo.textContent = "Menú completo";
      cTodo.onclick = () => aplicarFiltro(null); chips.appendChild(cTodo);
      const lista = document.createElement("div"); lista.className = "wm-lista"; caja.appendChild(lista);
      const pie = document.createElement("div"); pie.className = "wm-pie";
      const tot = document.createElement("b"); tot.textContent = "Elige lo que quieres";
      const ok = document.createElement("button"); ok.type = "button"; ok.className = "wm-ok"; ok.disabled = true; ok.textContent = "Listo";
      pie.append(tot, ok); caja.appendChild(pie);
      const no = document.createElement("button"); no.type = "button"; no.className = "wm-no"; no.textContent = "↩️ Otro negocio"; caja.appendChild(no);
      const precio = (p) => Math.round(Number(p.precio) * 100) / 100;
      let cat = null;
      platos.forEach((p) => {
        if ((p.cat || "") !== cat) { cat = p.cat || ""; const c = document.createElement("div"); c.className = "wm-cat"; c.textContent = cat || "Menú"; c.dataset.cat = cat; lista.appendChild(c);
          const cb = document.createElement("button"); cb.type = "button"; cb.className = "wm-chip"; cb.textContent = cat || "Menú";
          const kCat = cat; cb.dataset.k = kCat; cb.onclick = () => aplicarFiltro(kCat);
          chips.appendChild(cb); }
        const f = document.createElement("div"); f.className = "wm-fila"; f.dataset.cat = cat;
        const img = document.createElement("div"); img.className = "wm-img";
        if (typeof p.foto === "string" && p.foto.indexOf("data:image/") === 0) { const im = document.createElement("img"); im.alt = ""; im.src = p.foto; img.appendChild(im); }
        else img.textContent = /beb|jug|refr|gas/i.test(p.cat || "") ? "🥤" : "🍽️";
        const n = document.createElement("div"); n.className = "wm-n"; n.innerHTML = "<b></b><em></em>";
        n.querySelector("b").textContent = p.nombre; n.querySelector("em").textContent = (p.variantes.length ? "Desde C$ " + Math.min(...p.variantes.map((v) => v.p)).toFixed(2) : "C$ " + precio(p).toFixed(2)) + (p.extras.length ? " · con adicionales" : "");
        const q = document.createElement("div"); q.className = "wm-q";
        const mn = document.createElement("button"); mn.type = "button"; mn.textContent = "−"; mn.setAttribute("aria-label", "Quitar uno");
        const nq = document.createElement("span"); nq.textContent = "0";
        const mas = document.createElement("button"); mas.type = "button"; mas.textContent = "+"; mas.setAttribute("aria-label", "Agregar uno");
        const set = (d) => { cant[p.k] = Math.max(0, Math.min(20, (cant[p.k] || 0) + d)); nq.textContent = cant[p.k]; calc(); };
        mn.onclick = () => set(-1); mas.onclick = () => set(1);
        q.append(mn, nq, mas); f.append(img, n, q); lista.appendChild(f);
      });
      const elegidos = () => platos.filter((p) => cant[p.k] > 0);
      function calc() {
        const e = elegidos(), t = e.reduce((a, p) => a + precio(p) * cant[p.k], 0), nu = e.reduce((a, p) => a + cant[p.k], 0);
        tot.textContent = e.length ? (e.some((p) => p.variantes.length || p.extras.length) ? nu + " producto(s)" : "C$ " + (Math.round(t * 100) / 100).toFixed(2)) : "Elige lo que quieres";
        ok.disabled = !e.length;
      }
      no.onclick = () => { if (!vivo(id)) return; caja.remove(); res({ volver: true }); };
      ok.onclick = async () => {
        if (!vivo(id)) return;
        const e = elegidos(); if (!e.length) return;
        caja.remove();
        /* Opciones por unidad: tamaño/variante, sabor y adicionales */
        const items = [], agg = {}, fotosPed = [];
        for (const p of e) {
          if (typeof p.foto === "string" && p.foto.indexOf("data:image/") === 0) fotosPed.push({ src: p.foto, n: p.nombre });
          let prev = null;
          for (let u = 1; u <= cant[p.k]; u++) {
            const rotulo = p.nombre + (cant[p.k] > 1 ? " (" + u + " de " + cant[p.k] + ")" : "");
            let cfg = null;
            const conOpc = p.variantes.length || p.sabores.length || p.extras.length;
            if (conOpc && prev && u > 1) {
              if (!(await di(id, "¿" + rotulo + " igual que el anterior?"))) return;
              const ig = await opciones(id, [{ clave: "s", texto: "🔁 Igual que el anterior" }, { clave: "n", texto: "✏️ Elegir distinto" }]);
              if (!vivo(id)) return;
              if (ig === "s") cfg = prev;
            }
            if (!cfg) {
              let pu = precio(p); const partes = [], ext = [];
              if (p.variantes.length) {
                if (!(await di(id, "📏 ¿Qué opción quieres para " + rotulo + "?"))) return;
                const s = await opciones(id, p.variantes.map((v, i) => ({ clave: String(i), texto: v.n + " · C$ " + v.p.toFixed(2) })));
                if (!vivo(id)) return;
                const v = p.variantes[Number(s)]; partes.push(v.n); pu = v.p;
              }
              const norm2 = (s) => norm(String(s || ""));
              const esBebTxt = (s) => /\b(refresc|gaseos|jug|soda|fresc|batid|agua|cerve|cafe|bebid|coca|pepsi|sprite|fanta)/.test(norm2(s)) || /\bte\b/.test(norm2(s));
              const saboresRest = [...new Set(platos.flatMap((q) => q.sabores || []))].slice(0, 12);
              const opcSab = p.sabores.length ? p.sabores : saboresRest;
              let sabYa = false;
              if (p.extras.length) {
                if (!(await di(id, "➕ ¿Quieres agregar algún adicional a " + rotulo + "? Marca los que quieras:"))) return;
                const cl = await multiOpciones(id, p.extras.map((x, i) => ({ clave: String(i), texto: x.n + " · +C$ " + x.p.toFixed(2) })), "Agregar", "Ninguno, continuar");
                if (!vivo(id)) return;
                for (const c of cl) {
                  const x = p.extras[Number(c)]; let nom = x.n; pu += x.p;
                  if (esBebTxt(x.n) && opcSab.length) {
                    if (!(await di(id, "🥤 ¿De qué sabor quieres «" + x.n + "»?"))) return;
                    const s = await opciones(id, opcSab.map((z, i) => ({ clave: String(i), texto: z })));
                    if (!vivo(id)) return;
                    nom += " " + opcSab[Number(s)]; sabYa = true;
                  }
                  ext.push(nom);
                }
              }
              const hayExtBeb = p.extras.some((x) => esBebTxt(x.n));
              const esBeb = esBebTxt((p.cat || "") + " " + p.nombre);
              if (p.sabores.length && !sabYa && (!p.extras.length || esBeb || (ext.length && !hayExtBeb))) {
                const nb = Math.max(1, Math.min(6, Number(p.nSab) || 1)), sel = [];
                for (let j = 1; j <= nb; j++) {
                  if (!(await di(id, "🥤 " + (nb > 1 ? "Refresco " + j + " de " + nb + " de " : "¿De qué sabor quieres ") + rotulo + (nb > 1 ? ": ¿qué sabor?" : "?")))) return;
                  const s = await opciones(id, p.sabores.map((x, i) => ({ clave: String(i), texto: x })));
                  if (!vivo(id)) return;
                  sel.push(p.sabores[Number(s)]);
                }
                partes.push(sel.join(" + "));
              }
              const suf = (partes.length ? " (" + partes.join(", ") + ")" : "") + (ext.length ? " + " + ext.join(" + ") : "");
              cfg = { n: (p.nombre.slice(0, Math.max(10, 60 - suf.length)) + suf).slice(0, 60), p: Math.round(pu * 100) / 100 };
              prev = cfg;
            }
            const key = cfg.n + "|" + cfg.p;
            if (agg[key]) agg[key].q++; else { agg[key] = { n: cfg.n, q: 1, p: cfg.p }; items.push(agg[key]); }
          }
        }
        addYo("🧾 " + RESUMEN_ITEMS(items) + " · C$ " + (Math.round(items.reduce((a, i) => a + i.p * i.q, 0) * 100) / 100).toFixed(2));
        if (fotosPed.length) {
          const fx = document.createElement("div");
          fx.style.cssText = "display:flex;flex-wrap:wrap;gap:8px;margin:6px 0 4px auto;justify-content:flex-end;max-width:92%";
          fotosPed.slice(0, 8).forEach((f) => {
            const w = document.createElement("figure"); w.style.cssText = "margin:0;width:92px;text-align:center";
            const im = document.createElement("img"); im.alt = f.n; im.src = f.src; im.style.cssText = "width:92px;height:92px;object-fit:cover;border-radius:14px;border:2px solid #FF6A00;display:block";
            const c = document.createElement("figcaption"); c.textContent = f.n; c.style.cssText = "font-size:11px;font-weight:700;margin-top:2px;line-height:1.15;overflow:hidden;max-height:2.4em";
            w.appendChild(im); w.appendChild(c); fx.appendChild(w);
          });
          $("convo").appendChild(fx); bajar();
        }
        let nota = "";
        const kk = await opciones(id, [{ clave: "n", texto: "📝 Agregar nota" }, { clave: "s", texto: "➡️ Continuar" }]);
        if (!vivo(id)) return;
        if (kk === "n") {
          if (!(await di(id, "Escribe tu nota (sin cebolla, bien cocido…).", "c0n"))) return;
          nota = await pedirTexto(id, "Ej. Sin cebolla", 2, "Escribe la nota (mínimo 2 letras).", 200);
          if (!vivo(id)) return;
        }
        res({ items, nota });
      };
      $("convo").appendChild(caja); bajar();
    });
  }

  /* Compras adicionales en el mismo viaje: platos de otro restaurante o una compra libre en cualquier lugar. Devuelve [{l,n,q,p}] */
  async function agregarOtros(id, lista, uid0) {
    const out = [];
    while (vivo(id) && out.length < 10) {
      if (!(await di(id, out.length ? "¿Quieres agregar algo más de otro lugar?" : "🛍️ ¿Quieres agregar algo de otro restaurante o comprar algo en otro lugar? El repartidor lo recoge en el mismo viaje."))) return out;
      const k = await opciones(id, [{ clave: "r", texto: "🍽️ Menú de otro restaurante" }, { clave: "c", texto: "🛍️ Compra en otro lugar" }, { clave: "n", texto: "➡️ No, continuar" }]);
      if (!vivo(id)) return out;
      if (k === "n") break;
      if (k === "r") {
        const otrosR = lista.filter((x) => x.uid !== uid0);
        if (!otrosR.length) { if (!(await di(id, "No hay otros restaurantes abiertos ahora."))) return out; continue; }
        const j = await opciones(id, otrosR.map((x, i) => ({ clave: String(i), texto: "🍔 " + x.nombre })).concat([{ clave: "x", texto: "↩️ Cancelar" }]));
        if (!vivo(id)) return out;
        if (j === "x") continue;
        const r2 = otrosR[Number(j)], m = await armarPedidoMenu(id, r2);
        if (!vivo(id)) return out;
        if (m.volver) continue;
        if (m.sinMenu) { if (!(await di(id, "Ese negocio aún no tiene su menú disponible."))) return out; continue; }
        m.items.forEach((i) => out.push({ l: limpiarNombre(r2.nombre).slice(0, 40), n: String(i.n).slice(0, 60), q: i.q, p: i.p }));
      } else {
        if (!(await di(id, "¿En qué lugar? (nombre o referencia)"))) return out;
        const lug = await pedirTexto(id, "Ej. Pulpería Doña Rosa", 2, "Escribe el lugar (mínimo 2 letras).", 40);
        if (!vivo(id)) return out;
        if (!(await di(id, "¿Qué quieres que compre ahí? Si sabes el precio, escríbelo (ej. 2 galones de agua, C$ 60)."))) return out;
        const q = await pedirTexto(id, "Ej. 2 aguas · C$ 60", 2, "Escribe qué comprar.", 60);
        if (!vivo(id)) return out;
        out.push({ l: limpiarNombre(lug).slice(0, 40), n: limpiarNombre(q).slice(0, 60), q: 1, p: 0 });
      }
    }
    return out;
  }

  async function flujoComida(id) {
    const v = datos.v;
    if (!v.rest && !v.quiere && !v.libre) {
      const lista = await cargarRestaurantes();
      if (!vivo(id)) return;
      if (!lista.length) {
        if (!(await di(id, "No encontré negocios abiertos en tu ciudad ahora mismo" + (errRest ? " (" + errRest + ")" : "") + ". Cuéntame qué deseas pedir y lo coordinamos."))) return;
        guardar("libre", true);
      } else {
        if (!(await di(id, "🍔 ¡Qué rico! ¿Qué se te antoja? Busca un negocio o un plato y te muestro quién lo tiene.", "c0"))) return;
        const menuModo = () => opciones(id, [{ clave: "b", texto: "🔎 Buscar negocio o antojo" }, { clave: "t", texto: "🍔 Ver todos los negocios" }, { clave: "otro", texto: "✍️ Otro establecimiento" }]);
        let modo = await menuModo(), hecho = false;
        while (vivo(id) && !hecho) {
          if (modo === "otro") { guardar("libre", true); break; }
          let cand = lista;
          if (modo === "b") {
            const q = await pedirTexto(id, "Ej. guapollón, pollo frito, pizza", 2, "Escribe al menos 2 letras.", 60);
            if (!vivo(id)) return;
            cand = await buscarRestaurantes(lista, q);
            if (!vivo(id)) return;
            if (!cand.length) {
              if (!(await di(id, "No encontré negocios abiertos que vendan «" + q.slice(0, 40) + "» 😕 Prueba con otra palabra o mira todos los negocios."))) return;
              modo = await menuModo(); continue;
            }
          }
          const k = await opciones(id, cand.map((r, i) => ({ clave: String(i), texto: "🍔 " + r.nombre + (r.hint ? " · " + r.hint : "") + (r._t > 1 && r._n < r._t ? " (parecido)" : "") + (r.prepMin ? " · ~" + r.prepMin + " min" : "") })).concat([{ clave: "x", texto: "↩️ Volver" }]));
          if (!vivo(id)) return;
          if (k === "x") { modo = await menuModo(); continue; }
          const r = cand[Number(k)];
          const m = await armarPedidoMenu(id, r);
          if (!vivo(id)) return;
          if (m.volver) { modo = await menuModo(); continue; }
          if (m.sinMenu) { if (!(await di(id, "Ese negocio aún no tiene su menú disponible. Cuéntame qué deseas pedir."))) return; guardar("libre", true); break; }
          guardar("rest", { uid: r.uid, nombre: r.nombre, lat: r.lat, lng: r.lng, items: m.items, nota: m.nota || "" });
          guardar("quiere", RESUMEN_ITEMS(m.items)); guardar("origen", r.nombre);
          { const ot = await agregarOtros(id, lista, r.uid); if (!vivo(id)) return; if (ot.length) guardar("otros", ot); }
          hecho = true;
        }
        if (!vivo(id)) return;
      }
    }
    if (!v.quiere) {
      if (!(await di(id, "🍔 ¡Qué rico! ¿Qué deseas pedir?", "c1"))) return;
      const t = await pedirTexto(id, "Ej. 2 hamburguesas y una Coca-Cola", 2, "Cuéntame qué deseas pedir (mínimo 2 letras).");
      if (!vivo(id)) return;
      guardar("quiere", t);
    }
    if (!v.origen) {
      if (!(await di(id, "¿De qué establecimiento lo quieres? Si es de otra ciudad, escribe también el nombre de la ciudad.", "c2"))) return;
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
        const g = await obtenerGps(id);
        if (!g || !vivo(id)) return;
        guardar("destino", lugarDeGps(g));
      } else {
        const d = await pedirLugar(id, { clave: "c4o", pregunta: "Marca en el mapa o escribe la dirección exacta de la persona que recibe.", ultima: true });
        if (!d || !vivo(id)) return;
        guardar("destino", d);
      }
    }
    const rst = v.rest && v.rest.uid ? { ...(okLL(Number(v.rest.lat), Number(v.rest.lng)) ? { retiro: { tipo: "pin", lat: v.rest.lat, lng: v.rest.lng } } : {}), restauranteUid: v.rest.uid, restauranteNombre: v.rest.nombre, items: v.rest.items, nota: v.rest.nota, ...(Array.isArray(v.otros) && v.otros.length ? { otros: v.otros } : {}) } : {};
    await finalizar(id, { servicio: "comida", tipo: "compra", quiere: v.quiere, origen: v.origen, modo: v.quien === "yo" ? "recibe" : "envia", destino: v.destino, ...rst });
  }

  /* ---------- Flujo MANDADO (compramos o hacemos algo por el cliente) ---------- */
  async function flujoMandado(id) {
    const v = datos.v;
    if (!v.quiere) {
      if (!(await di(id, "🛒 ¡Con gusto! Cuéntame qué mandado necesitas (por ejemplo: comprar medicinas, pagar un recibo, traer algo del mercado).", "m1"))) return;
      const t = await pedirTexto(id, "Ej. Comprar medicinas", 2, "Cuéntame qué necesitas (mínimo 2 letras).");
      if (!vivo(id)) return;
      guardar("quiere", t);
    }
    if (!v.origen) {
      if (!(await di(id, "¿Dónde lo compramos o lo hacemos? Escribe el nombre del lugar (por ejemplo: «Farmacia Santa Ana» o «Mercado Central»). Si es de otra ciudad, escribe también el nombre de la ciudad.", "m2"))) return;
      const t = await pedirTexto(id, "Nombre del lugar", 2, "Indica el lugar (mínimo 2 letras).", 120);
      if (!vivo(id)) return;
      guardar("origen", t);
    }
    if (!v.quien) {
      if (!(await di(id, "¿Quién recibe el mandado?", "m3"))) return;
      const q = await opciones(id, [{ clave: "yo", texto: "🙋 Yo recibo" }, { clave: "otro", texto: "🎁 Lo recibe otra persona" }]);
      if (!vivo(id)) return;
      guardar("quien", q);
    }
    if (!v.destino) {
      if (v.quien === "yo") {
        const g = await obtenerGps(id);
        if (!g || !vivo(id)) return;
        guardar("destino", lugarDeGps(g));
      } else {
        const d = await pedirLugar(id, { clave: "m4o", pregunta: "Marca en el mapa o escribe la dirección exacta de la persona que recibe.", ultima: true });
        if (!d || !vivo(id)) return;
        guardar("destino", d);
      }
    }
    if (!(await di(id, "Tu repartidor te confirmará el costo del mandado por el chat.", "m5"))) return;
    await finalizar(id, { servicio: "mandado", tipo: "compra", quiere: v.quiere, origen: v.origen, modo: v.quien === "yo" ? "recibe" : "envia", destino: v.destino });
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

  const FLUJOS = { enviar: flujoEnviar, retirar: flujoRetirar, comida: flujoComida, mandado: flujoMandado, pickup: flujoPickup };

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
    pintarArchivoInicio();
    vista("vPedido");
    if (previa && !cerradoServicio) retomarConvo(previa);
    else { if (!previa) borrarHistorial(); reiniciarConvo(); }
    pintarHorario();
  }

  function iniciarFlujo(clave, etiqueta) {
    if (!FLUJOS[clave] || cerradoServicio) return;
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
  /* «Atrás»: pide confirmación antes de borrar los datos del pedido. */
  function cerrarAvisoReiniciar() { $("modalReiniciar").classList.add("oculto"); }
  function abrirAvisoReiniciar() {
    if (esCampo(document.activeElement)) document.activeElement.blur();
    $("modalReiniciar").classList.remove("oculto");
    setTimeout(() => { try { $("btnReiniciarNo").focus(); } catch (_) { } }, 50);
  }
  $("btnReiniciar").addEventListener("click", abrirAvisoReiniciar);
  $("btnReiniciarNo").addEventListener("click", cerrarAvisoReiniciar);
  $("btnReiniciarSi").addEventListener("click", () => { cerrarAvisoReiniciar(); reiniciarConvo(); });
  $("modalReiniciar").addEventListener("click", (ev) => { if (ev.target === $("modalReiniciar")) cerrarAvisoReiniciar(); });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !$("modalReiniciar").classList.contains("oculto")) cerrarAvisoReiniciar();
  });

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
    const ar = $("archivoPrev");
    conservarScroll(() => cont.insertBefore(w, ar ? ar.nextSibling : cont.firstChild));
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
    const lineas = [MARCA_RESUMEN];
    if (p.entreCiudades && p.ciudadOrigen && Ciudades.porId(p.ciudadOrigen) && Ciudades.porId(p.ciudadDestino)) lineas.push("🚚 " + nombreCiudad(p.ciudadOrigen) + " → " + nombreCiudad(p.ciudadDestino));
    if (s === "enviar") lineas.push("📦 Enviar", String(p.quiere || ""));
    else if (s === "retirar") lineas.push("📥 Retirar", String(p.contacto || p.quiere || ""));
    else if (s === "mandado") lineas.push("🛒 Mandado", String(p.quiere || ""), "🏪 " + String(p.origen || ""));
    else if (s === "pickup") lineas.push("🏍️ Pickup");
    else if (Array.isArray(p.items) && p.items.length) {
      lineas.push("🍔 " + String(p.restauranteNombre || p.origen || "Pedido"));
      p.items.forEach((i) => lineas.push("• " + (Number(i.q) || 1) + " × " + String(i.n || "")));
      if (p.nota) lineas.push("📝 " + String(p.nota));
      if (Array.isArray(p.otros) && p.otros.length) { lineas.push("🛍️ También en otros lugares:"); p.otros.forEach((x) => lineas.push("• " + String(x.l || "") + ": " + (Number(x.q) || 1) + " × " + String(x.n || "") + (Number(x.p) > 0 ? " (C$ " + Number(x.p).toFixed(2) + ")" : ""))); }
      if (Number(p.subtotal) > 0) lineas.push("💰 Productos: C$ " + (Math.round(Number(p.subtotal) * 100) / 100).toFixed(2));
    } else lineas.push("🍔 Pedir comida", String(p.quiere || ""), "🏪 " + String(p.origen || ""));
    if (Number(p.tarifaEstimada) > 0) lineas.push("💰 Delivery est.: C$ " + Number(p.tarifaEstimada));
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
    const ar = $("archivoPrev");
    conservarScroll(() => cont.insertBefore(card, hist ? hist.nextSibling : (ar ? ar.nextSibling : cont.firstChild)));
    resumenCard = card;
  }

  /* Cuando un repartidor atiende, el resumen se guarda como primer mensaje del chat */
  async function enviarResumenAlChat() {
    if (resumenEnviando || cerrado || !asignado || !refMensajes || !refSolicitud) return;
    const texto = String(textoResumen() || "").slice(0, 1500);
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
    let bajoPrecision = false;
    const alError = (e) => {
      if (e && e.code === 1) {
        mostrarError(esNavInterno
          ? "Abre esta página en Safari para que tu repartidor pueda ver tu ubicación."
          : (esIOS
            ? "Activa la ubicación: Ajustes > Privacidad y seguridad > Localización > Sitios web de Safari > «Al usar la app»."
            : "Activa el permiso de ubicación para que tu repartidor te encuentre."));
        return;
      }
      if (!bajoPrecision && e && (e.code === 2 || e.code === 3)) {
        bajoPrecision = true;
        if (watchId !== null) navigator.geolocation.clearWatch(watchId);
        watchId = navigator.geolocation.watchPosition(alPosicion, alError, { enableHighAccuracy: false, maximumAge: 15000, timeout: 30000 });
      }
    };
    watchId = navigator.geolocation.watchPosition(alPosicion, alError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
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
  /* El chat NO se borra al terminar: se conserva 12 h desde la entrega. Entregado → calificar → agradecimiento;
     cancelado → aviso directo. Al escribir de nuevo arranca un pedido nuevo con los botones guiados. */
  function cerrarCiclo(d) {
    const entregado = d.estado === "entregado";
    const tsCierre = Number(entregado ? d.entregadoTs : d.canceladoTs) || Number(d.ts) || Date.now();
    if (!cerrado && Date.now() - tsCierre >= CADUCA_CHAT_MS) {
      return reiniciarCiclo(false);   // ya pasaron 12 h: ese chat se descarta
    }
    if (!cerrado) {
      cerrado = true;
      cierreTs = tsCierre;
      detenerGps();
      ultimoDe = null;
      $("vChat").classList.add("cerrado");
      { const nc = $("negCliente"); if (nc) { nc.classList.add("oculto"); nc.textContent = ""; } }   // ya no hay negociación que mostrar
      setMapaVisible(false);
      mostrarError("");
      $("btnCambiarNombre").classList.add("oculto");
      programarCaducidad(tsCierre);
      habilitarEscribirTrasCierre(!entregado);
    }
    const est = d.valoracion && Number(d.valoracion.estrellas);
    if (est >= 1 && est <= 5) valorada = true;
    const pendiente = entregado && !valorada && !enviandoVal && !valoracionOmitida();
    if (pendiente) {
      $("cierreIcono").textContent = "✅";
      $("cierreTitulo").textContent = "¡Pedido entregado!";
      $("cierreSub").textContent = "¿Cómo estuvo tu " + textoBusqueda().quien + "? Califica y déjanos tu comentario.";
      pintarEstrellas(estrellasSel, false);
      $("btnEnviarVal").disabled = estrellasSel < 1;
      $("vCierre").classList.remove("oculto");
    } else {
      $("vCierre").classList.add("oculto");
      mostrarAgradecimiento(entregado, d);
    }
  }

  function habilitarEscribirTrasCierre(cancelado) {
    const inp = $("inMensaje");
    inp.disabled = false;
    inp.placeholder = "Escribe aquí para hacer otro pedido…";
    $("btnEnviar").disabled = false;
    if (cerradoServicio) { inp.disabled = true; inp.placeholder = "Fuera de servicio"; $("btnEnviar").disabled = true; }
    $("btnFoto").disabled = true;
    const sub = $("subChat");
    sub.textContent = cancelado ? "Pedido cancelado" : "Pedido finalizado";
    sub.classList.remove("escribiendo");
  }

  function mostrarAgradecimiento(entregado, d) {
    if ($("msgCierre")) return;
    const caja = el("div", "wa-msg cierre");
    caja.id = "msgCierre";
    const intro = entregado
      ? "💚 ¡Gracias por confiar en Brother’s Deliverys! Tu pedido fue entregado.\n\nEste chat se borrará automáticamente 12 horas después de la entrega."
      : d && /tarifa/i.test(String(d.motivoForzado || "")) ? "🚫 Tu pedido fue cancelado porque no se llegó a un acuerdo con la tarifa del envío."
      : d && d.canceladoPor === "admin" ? "🚫 Tu pedido fue cancelado por la central."
      : "Tu pedido fue cancelado.";
    caja.appendChild(el("p", "", intro + "\n\nSi deseas algo más, escríbenos aquí y te guiaremos para hacer tu nuevo pedido. 🏍️"));
    caja.appendChild(el("span", "wa-hora", hora(Date.now())));
    const seguirCierre = pegadoAlFinal();
    $("mensajes").appendChild(caja);
    ultimoDe = null;
    if (seguirCierre) alFinal();
  }

  const valoracionOmitida = () => {
    try { return !!perfil && localStorage.getItem(CLAVE_VAL_OMITIDA) === perfil.solicitudId; } catch (_) { return false; }
  };

  /* ---------- Caducidad de 12 h ---------- */
  function programarCaducidad(ts) {
    clearTimeout(tmCaduca);
    const falta = ts + CADUCA_CHAT_MS - Date.now();
    if (falta <= 0) return;
    tmCaduca = setTimeout(caducarChat, Math.min(falta, 2147000000));
  }

  function caducarChat() {
    if (!cerrado) return;
    $("mensajes").textContent = "";
    resumenCard = null; ultimoDe = null; ultimoDia = null;
    avisoSistema("La conversación de tu pedido anterior se borró (pasaron 12 horas). Escribe para hacer un nuevo pedido.");
  }

  /* ---------- Chats anteriores (conservados 12 h tras cada entrega) ---------- */
  function leerArchivo() {
    let l = [];
    try { l = JSON.parse(localStorage.getItem(CLAVE_ARCHIVO) || "[]"); } catch (_) { l = []; }
    if (!Array.isArray(l)) l = [];
    const ahora = Date.now();
    const v = l.filter((e) => e && typeof e.html === "string" && Number.isFinite(e.ts) && Number.isFinite(e.expira) && e.expira > ahora);
    if (v.length !== l.length) escribirArchivo(v);
    return v;
  }

  function escribirArchivo(l) {
    try { localStorage.setItem(CLAVE_ARCHIVO, JSON.stringify(l)); return; } catch (_) { }
    try { localStorage.setItem(CLAVE_ARCHIVO, JSON.stringify(l.slice(-1))); } catch (_) {
      try { localStorage.removeItem(CLAVE_ARCHIVO); } catch (__) { }
    }
  }

  function archivarChat() {
    try {
      const cont = $("mensajes");
      if (!cont || !cont.children.length) return;
      const clon = cont.cloneNode(true);
      const prev = clon.querySelector("#archivoPrev");
      if (prev) prev.remove();
      clon.querySelectorAll("img").forEach((i) => i.replaceWith(el("p", "", "📷 Foto")));
      clon.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      if (!clon.children.length) return;
      const base = cierreTs || Date.now();
      const lista = leerArchivo();
      lista.push({ ts: base, expira: base + CADUCA_CHAT_MS, html: clon.innerHTML });
      escribirArchivo(lista.slice(-4));
    } catch (_) { }
  }

  function bloqueArchivo(e) {
    const w = el("div", "wa-archivo");
    const dia = el("div", "wa-dia");
    dia.appendChild(el("span", "", "Pedido anterior · " + etiquetaDia(e.ts)));
    const cuerpo = el("div", "wa-archivo-cuerpo");
    cuerpo.innerHTML = e.html;
    w.appendChild(dia);
    w.appendChild(cuerpo);
    return w;
  }

  function pintarArchivoChat() {
    if ($("archivoPrev")) return;
    const lista = leerArchivo();
    if (!lista.length) return;
    const caja = el("div", "wa-archivo-caja");
    caja.id = "archivoPrev";
    lista.forEach((e) => caja.appendChild(bloqueArchivo(e)));
    conservarScroll(() => $("mensajes").insertBefore(caja, $("mensajes").firstChild));
  }

  function pintarArchivoInicio() {
    const caja = $("archivoInicio");
    if (!caja) return;
    caja.textContent = "";
    leerArchivo().forEach((e) => caja.appendChild(bloqueArchivo(e)));
  }

  /* ---------- Reinicio: el siguiente pedido es una solicitud nueva; el chat anterior se conserva ---------- */
  function reiniciarCiclo(archivar) {
    if (archivar) archivarChat();
    clearTimeout(tmCaduca);
    detenerTodo();
    cerrado = false; valorada = false; enviandoVal = false; estrellasSel = 0;
    $("btnCancelar").disabled = false;
    $("vCierre").classList.add("oculto");
    $("vChat").classList.remove("cerrado");
    $("inComentario").value = "";
    $("inMensaje").value = ""; ajustarAlto($("inMensaje"));
    borrarSesion();
    borrarConvo(); borrarHistorial();
    perfil = { id: generarId(), nombre: perfil.nombre, reg: perfil.reg, terminos: perfil.terminos, solicitudId: null };
    guardarPerfil(perfil);
    abrirChat({ silencioso: true });
  }
  function nuevoPedidoDesdeChat() { reiniciarCiclo(true); }

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

  document.querySelectorAll("#boxEstrellas .wa-estrella").forEach((b) => b.addEventListener("click", () => {
    if (valorada || enviandoVal) return;
    estrellasSel = Number(b.dataset.n);
    pintarEstrellas(estrellasSel, false);
    $("btnEnviarVal").disabled = false;
    $("msgValoracion").classList.add("oculto");
  }));

  $("btnEnviarVal").addEventListener("click", async () => {
    if (valorada || enviandoVal || !refSolicitud || estrellasSel < 1) return;
    enviandoVal = true;
    $("btnEnviarVal").disabled = true;
    const coment = $("inComentario").value.replace(/\s+/g, " ").trim().slice(0, 300);
    try {
      const e = await refSolicitud.child("estado").once("value");
      if (e.exists()) {
        const v = { estrellas: estrellasSel, ts: firebase.database.ServerValue.TIMESTAMP };
        if (coment) v.comentario = coment;
        try { await refSolicitud.child("valoracion").set(v); }
        catch (err) {
          /* Reglas aún sin el campo «comentario»: guarda al menos las estrellas. */
          if (!coment || !err || err.code !== "PERMISSION_DENIED") throw err;
          await refSolicitud.child("valoracion").set({ estrellas: estrellasSel, ts: firebase.database.ServerValue.TIMESTAMP });
        }
      }
      valorada = true;
      pintarEstrellas(estrellasSel, true);
      $("vCierre").classList.add("oculto");
      mostrarAgradecimiento(true);
    } catch (err) {
      mensajeValoracion("No se pudo guardar tu valoración: " + (err.code || err.message), true);
      $("btnEnviarVal").disabled = false;
    } finally {
      enviandoVal = false;
    }
  });

  $("btnOmitirVal").addEventListener("click", () => {
    try { localStorage.setItem(CLAVE_VAL_OMITIDA, (perfil && perfil.solicitudId) || ""); } catch (_) { }
    $("vCierre").classList.add("oculto");
    mostrarAgradecimiento(true);
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
      contactoEscrito = ""; guardarContacto();   // mantiene al día el nombre en el contacto que ve el admin
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
    if (campo.closest(".wa-compositor")) return;
    const dentroModal = !!campo.closest(".wa-hoja, .wa-nombre-caja");
    try { campo.scrollIntoView({ block: dentroModal ? "center" : "nearest", behavior: "auto" }); }
    catch (_) { campo.scrollIntoView(); }
  }

  /* Recuerda si la persona está viendo lo más reciente. Solo cambia cuando ella scrollea:
     al abrir el teclado el área se achica y NO debe contar como "scrolleó". */
  const pegados = { formPedido: true, mensajes: true };
  let ignorarScrollHasta = 0;
  ["formPedido", "mensajes"].forEach((sid) => {
    const el = $(sid);
    if (!el) return;
    el.addEventListener("scroll", () => {
      if (Date.now() < ignorarScrollHasta) return;
      pegados[sid] = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }, { passive: true });
  });
  function mantenerFinal() {
    [["formPedido", "vPedido"], ["mensajes", "vChat"]].forEach((par) => {
      const sc = $(par[0]), vis = $(par[1]);
      if (!sc || !vis || vis.classList.contains("oculto") || !pegados[par[0]]) return;
      sc.scrollTop = sc.scrollHeight;
    });
  }
  function seguirFinalUnRato() {
    ignorarScrollHasta = Date.now() + 900;
    mantenerFinal();
    [60, 180, 380, 700].forEach((ms) => setTimeout(mantenerFinal, ms));
  }

  let rafViewport = 0;
  function ajustarViewport() {
    const vv = window.visualViewport;
    if (!vv) return;
    ignorarScrollHasta = Math.max(ignorarScrollHasta, Date.now() + 600);
    const raiz = document.documentElement.style;
    raiz.setProperty("--vvh", Math.round(vv.height) + "px");
    raiz.setProperty("--vvt", Math.round(vv.offsetTop) + "px");
    document.body.classList.toggle("teclado", window.innerHeight - vv.height > 120);
    mantenerFinal();
    const activo = document.activeElement;
    if (esCampo(activo)) {
      setTimeout(() => { mostrarCampo(activo); mantenerFinal(); }, 60);
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
    seguirFinalUnRato();
    /* Reajusta varias veces: algunos teclados terminan de abrirse (y de cambiar de alto) después del primer aviso. */
    [100, 320, 700].forEach((ms) => setTimeout(() => { ajustarViewport(); mostrarCampo(ev.target); mantenerFinal(); }, ms));
  });
  document.addEventListener("focusout", () => {
    seguirFinalUnRato();
    [120, 400].forEach((ms) => setTimeout(() => { if (!esCampo(document.activeElement)) ajustarViewport(); }, ms));
  });

  /* Al volver a la app (pestaña recuperada, pantalla desbloqueada) se reanuda el GPS en vivo. */
  function reanudar() {
    if (!refSolicitud || cerrado || !pedidoActual) return;
    iniciarGps();
  }
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") reanudar(); });
  window.addEventListener("pageshow", (ev) => { if (ev.persisted) reanudar(); });

  /* Los campos de escribir crecen con el texto (hasta 5 líneas) */
  ["inMensaje", "inConvo"].forEach((id) => { const ta = $(id); if (ta) { ta.addEventListener("input", () => ajustarAlto(ta)); ajustarAlto(ta); } });

  /* ---------- Promociones push (navegador / PWA): el cliente decide si quiere recibirlas ---------- */
  const PushCli = (() => {
    const VAPID = "BJeqekVqA_37Sc75uSnVSHiAqqU-WY3LRRvnetF0crQTC-wHzym3tue2eTT3zO9Say16DaXRYEe8X9xNIETVBQA";
    const soporta = () => { try { return "serviceWorker" in navigator && "Notification" in window && "PushManager" in window && !!firebase.messaging && (typeof firebase.messaging.isSupported !== "function" || firebase.messaging.isSupported()); } catch (_) { return false; } };
    const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
    const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) { } };
    /* APK (Capacitor): push nativo */
    const nativo = () => !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform() && window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications);
    async function registrarNativo() {
      const P = window.Capacitor.Plugins.PushNotifications, u = auth.currentUser; if (!u) return false;
      try {
        try { await P.createChannel({ id: "avisos", name: "Avisos y promociones", description: "Ofertas y avisos de Brother’s Deliverys", importance: 5, sound: "default", vibration: true, lights: true, visibility: 1 }); } catch (_) { }
        const perm = await P.requestPermissions(); if (perm.receive !== "granted") return false;
        P.addListener("registration", (t) => { if (t && t.value && auth.currentUser) db.ref("clientesPush/" + auth.currentUser.uid).set({ t: t.value, ts: firebase.database.ServerValue.TIMESTAMP }).catch(() => { }); });
        await P.register();
        return true;
      } catch (e) { console.warn("Push nativo cliente:", e && e.message ? e.message : e); return false; }
    }
    async function registrar() {
      if (nativo()) return registrarNativo();
      const u = auth.currentUser; if (!u || !soporta() || Notification.permission !== "granted") return false;
      try {
        const reg = await navigator.serviceWorker.register("cliente-sw.js", { scope: "./cliente-app" });
        await navigator.serviceWorker.ready;
        const t = await firebase.messaging().getToken({ vapidKey: VAPID, serviceWorkerRegistration: reg });
        if (!t) return false;
        await db.ref("clientesPush/" + u.uid).set({ t, ts: firebase.database.ServerValue.TIMESTAMP });
        return true;
      } catch (e) { console.warn("Push cliente:", e && e.message ? e.message : e); return false; }
    }
    function banner() {
      if (!soporta() || Notification.permission !== "default" || lsGet("bd_promo_no") === "1" || document.getElementById("bdPromoBan")) return;
      const cv = $("mensajes"); if (!cv || !cv.parentNode) return;
      const b = document.createElement("div"); b.id = "bdPromoBan";
      b.style.cssText = "display:flex;align-items:center;gap:8px;margin:6px 10px;padding:8px 10px;border-radius:12px;background:#FFF3E8;border:1.5px solid #FF6A00;font-size:13px;font-weight:700;color:#7A2E00";
      b.innerHTML = '<span style="flex:1">🔔 ¿Quieres recibir promociones y ofertas de Brother’s Deliverys?</span>';
      const si = document.createElement("button"); si.type = "button"; si.textContent = "Sí"; si.style.cssText = "border:0;border-radius:10px;padding:6px 12px;background:#FF6A00;color:#fff;font-weight:800";
      const no = document.createElement("button"); no.type = "button"; no.textContent = "No"; no.style.cssText = "border:0;background:transparent;font-weight:800;color:#7A2E00;padding:6px";
      si.onclick = async () => { b.remove(); try { await Notification.requestPermission(); } catch (_) { } registrar(); };
      no.onclick = () => { lsSet("bd_promo_no", "1"); b.remove(); };
      b.appendChild(si); b.appendChild(no);
      cv.parentNode.insertBefore(b, cv);
    }
    return { iniciar() { if (nativo()) { setTimeout(registrar, 3000); return; } if (!("Notification" in window)) return; if (Notification.permission === "granted") registrar(); else setTimeout(banner, 4000); } };
  })();

  arrancar().then(() => { try { PushCli.iniciar(); } catch (_) { } });
})();
