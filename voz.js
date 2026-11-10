/* ============================================================
   VOZ Y SONIDOS (repartidor, cliente y administrador)
   - Voz con la síntesis del propio celular/navegador (en español)
   - Los navegadores solo permiten sonido después de un toque del usuario:
     por eso se "desbloquea" con el primer toque en la pantalla.
   - Si cierras la página o bloqueas el celular, el navegador NO deja sonar nada
     (para eso hacen falta notificaciones push; ver README).
   Cambia las frases aquí, en un solo lugar.
   FASE 3: se agrega solicitudAdmin() para el panel del administrador.
   FASE 2 (push): alertaPedido() dice EXACTAMENTE "Hay una solicitud de pedido" cuando llega un pedido de cliente (WhatsApp)
   o un mensaje de repartidor. Mantiene el audio vivo (Web Audio + audio silencioso en bucle) para que la voz suene con la
   app minimizada; si el navegador la bloquea, suena un pitido y la frase se dice al volver a la app.
   ============================================================ */
const Voz = (() => {
  const FRASES = {
    mensajeRepartidor: "El repartidor te ha enviado un mensaje",
    mensajeCliente: "El cliente te ha escrito",
    mensajeAdmin: "Brothers te ha escrito",
    guiaAdmin: "Brothers te ha indicado la ubicación del cliente",
    cerca: "El repartidor está cerca",
    // Prioridad: el cliente pagó 10 C$ extra para que su pedido salga primero
    prioridadCliente: (id) => "El cliente de la factura " + String(id == null || id === "" ? "sin número" : id).split("").join(" ") + " quiere priorizar su pedido",
    prueba: "Alertas de voz activadas",
    // Llega una solicitud nueva desde cliente-app.html (o una que otro repartidor pasó al grupo)
    solicitudPedido: "Hay una solicitud de pedido",
    // FASE 2 (push) · frase única del administrador para pedido de cliente o mensaje de repartidor
    alertaPedido: "Hay una solicitud de pedido",
    // FASE 3 · aviso en el panel del administrador
    solicitudAdmin: "Nueva solicitud de cliente pendiente",
    // FASE 2 · ciclo de vida del pedido de un cliente (panel del administrador)
    solicitudNueva: (c, q, o) => "Nuevo pedido de " + c + (q ? ": " + q : "") + (o ? ", en " + o : ""),
    solicitudTomada: (r, c) => r + " tomó el pedido de " + c,
    solicitudEnEntrega: (r, c) => r + " llegó y va a entregar el pedido de " + c,
    solicitudEntregada: (r, c) => r + " entregó el pedido de " + c,
    solicitudCancelada: (por, r, c) => por === "cliente" ? "El cliente " + c + " canceló su pedido" : por === "repartidor" ? r + " canceló el pedido de " + c : "Se canceló el pedido de " + c,
    // Celular del cliente (cliente-app.html)
    clientePedidoAceptado: "Un repartidor ha aceptado tu pedido",
    clienteMensajeNuevo: "Tienes un nuevo mensaje del repartidor",
    clienteRepartidorCerca: "Tu repartidor está cerca de tu destino"
  };
  const soporta = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
  let desbloqueada = false, audio = null, vozEs = null, gen = 0, pendiente = null;   // gen: cancela repeticiones pendientes
  const ultimaVez = {};

  function elegirVoz() {
    if (!soporta) return;
    const todas = speechSynthesis.getVoices() || [];
    vozEs = todas.find((v) => /^es[-_](MX|US|419)/i.test(v.lang)) || todas.find((v) => /^es/i.test(v.lang)) || null;
  }
  if (soporta) { elegirVoz(); speechSynthesis.addEventListener?.("voiceschanged", elegirVoz); }

  /* En el APK se usa la voz nativa de Android (plugin text-to-speech): sigue sonando con la app en segundo plano.
     En el navegador se usa speechSynthesis. */
  function nativo() {
    const C = window.Capacitor;
    if (!C || !(C.isNativePlatform && C.isNativePlatform())) return null;
    if (C.isPluginAvailable && !C.isPluginAvailable("TextToSpeech")) return null;
    return (C.Plugins && C.Plugins.TextToSpeech) || null;
  }

  function ctxAudio() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== "running") audio.resume();
    } catch (_) {}
    return audio;
  }

  /* Se llama solo (primer toque) o a mano desde un botón */
  function activar() {
    if (desbloqueada) return;
    desbloqueada = true;
    ctxAudio();
    if (soporta) {
      try { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } catch (_) {}
    }
    if (window.NOMBRE_APP === "admin") mantenerVivo();   // el panel del administrador debe poder hablar en segundo plano
    if (pendiente) {   // un aviso llegó antes del primer toque: se dice ahora (si aún es reciente)
      const p = pendiente; pendiente = null;
      if (Date.now() - p.t < 30000) setTimeout(() => hablar(p.texto, p.opciones), 50);
    }
  }
  ["pointerdown", "touchend", "keydown", "click"].forEach((ev) =>
    document.addEventListener(ev, activar, { once: true, passive: true }));

  /* Dos pitidos cortos (también sirven si el aparato no tiene voz) */
  function pitido(veces = 2) {
    const ctx = ctxAudio();
    if (!ctx || ctx.state !== "running") return;
    for (let i = 0; i < veces; i++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      g.gain.value = 0.35; o.frequency.value = 880; o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + i * 0.2); o.stop(ctx.currentTime + i * 0.2 + 0.12);
    }
  }

  /* Dice una frase. opciones.repetir = veces; opciones.pausaMs = espera entre repeticiones */
  function hablar(texto, opciones = {}) {
    const { repetir = 1, pausaMs = 2500, forzar = false } = opciones;
    if (!desbloqueada && !nativo()) { pendiente = { texto, opciones, t: Date.now() }; return; }   // el navegador exige un toque previo
    const ahora = Date.now();
    if (!forzar && ultimaVez[texto] && ahora - ultimaVez[texto] < 2500) return;   // evita que se solape consigo misma
    ultimaVez[texto] = ahora;
    pitido(1);
    let n = 0;
    const mi = gen;
    const decir = () => {
      if (!soporta) return;
      try {
        const u = new SpeechSynthesisUtterance(texto);
        u.lang = (vozEs && vozEs.lang) || "es-MX";
        if (vozEs) u.voice = vozEs;
        u.rate = 1; u.pitch = 1; u.volume = 1;
        u.onend = () => { if (mi === gen && ++n < repetir) setTimeout(decir, pausaMs); };
        speechSynthesis.speak(u);
      } catch (_) {}
    };
    const tts = nativo();
    if (!tts) return decir();
    const decirNativo = () => {
      tts.speak({ text: texto, lang: "es-MX", rate: 1, pitch: 1, volume: 1, category: "ambient", queueStrategy: 1 })
        .then(() => { if (mi === gen && ++n < repetir) setTimeout(decirNativo, pausaMs); })
        .catch(() => decir());   // sin voz nativa instalada: prueba la del navegador
    };
    decirNativo();
  }
  function parar() {
    gen++;
    try { const t = nativo(); t && t.stop(); } catch (_) {}
    try { soporta && speechSynthesis.cancel(); } catch (_) {}
  }


  /* ---------- FASE 2 (push) · audio vivo en segundo plano + alerta de pedido ---------- */
  let vivo = null, ultAlerta = 0, alertaPend = null;
  function wavSilencio() {   // 1 s de silencio, 8 kHz, 8 bits, mono
    const n = 8000, b = new Uint8Array(44 + n), dv = new DataView(b.buffer);
    const txt = (o, s) => { for (let i = 0; i < s.length; i++) b[o + i] = s.charCodeAt(i); };
    txt(0, "RIFF"); dv.setUint32(4, 36 + n, true); txt(8, "WAVE"); txt(12, "fmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true);
    dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); txt(36, "data"); dv.setUint32(40, n, true);
    b.fill(128, 44);
    return URL.createObjectURL(new Blob([b], { type: "audio/wav" }));
  }
  function mantenerVivo() {
    if (vivo) { try { vivo.play().catch(() => {}); ctxAudio(); } catch (_) {} return; }
    try {
      ctxAudio();
      vivo = new Audio(wavSilencio());
      vivo.loop = true; vivo.volume = 0.01; vivo.setAttribute("playsinline", "");
      vivo.play().catch(() => {});
      if ("mediaSession" in navigator) {
        try { navigator.mediaSession.metadata = new MediaMetadata({ title: "Brother’s Deliverys", artist: "Alertas del administrador activas" }); navigator.mediaSession.playbackState = "playing"; } catch (_) {}
      }
    } catch (_) {}
  }
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    ctxAudio();
    if (vivo && vivo.paused) { try { vivo.play().catch(() => {}); } catch (_) {} }
    if (alertaPend) {   // la alerta llegó con la app oculta: se dice al volver (si aún es reciente)
      const p = alertaPend; alertaPend = null;
      if (Date.now() - p.t < 60000) hablar(FRASES.alertaPedido, { forzar: true, repetir: 2, pausaMs: 2000 });
    }
  });
  /* Pedido de cliente (WhatsApp) o mensaje de repartidor → "Hay una solicitud de pedido". Un solo aviso cada 6 s. */
  const alertaPedido = () => {
    const ahora = Date.now();
    if (ahora - ultAlerta < 6000) return false;
    ultAlerta = ahora;
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 500]); } catch (_) {}
    if (window.NOMBRE_APP === "admin") mantenerVivo();
    if (document.hidden) { alertaPend = { t: ahora }; pitido(3); }
    hablar(FRASES.alertaPedido, { forzar: true, repetir: 2, pausaMs: 2000 });
    return true;
  };

  /* Frases con nombre para el administrador */
  const repartidorEscribio = () => FRASES.alertaPedido;   // FASE 2 (push): mensaje de repartidor → "Hay una solicitud de pedido"
  const clienteEscribio = (n) => (n ? "El cliente " + n + " ha enviado un mensaje" : "Un cliente ha enviado un mensaje");

  const lista = () => desbloqueada;

  /* Alerta de prioridad (se repite 2 veces para que se oiga aunque el repartidor esté manejando) */
  const prioridad = (id) => hablar(FRASES.prioridadCliente(id), { forzar: true, repetir: 2, pausaMs: 2000 });

  /* Solicitud de pedido: vibra y lo dice 2 veces para que se oiga aunque el repartidor esté manejando */
  const solicitud = () => {
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (_) {}
    hablar(FRASES.solicitudPedido, { forzar: true, repetir: 2, pausaMs: 2000 });
  };

  /* FASE 3 · Aviso de solicitud nueva en el panel del administrador (frase propia, sin repetir) */
  const solicitudAdmin = () => {
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300]); } catch (_) {}
    hablar(FRASES.solicitudAdmin, { forzar: true });
  };

  /* FASE 2 · Aviso del administrador por cada paso del pedido de un cliente.
     tipo: nuevo | tomado | entrega | entregado | cancelado. Devuelve el texto dicho (sirve para toast y notificación). */
  const solicitudEvento = (tipo, x) => {
    x = x || {};
    const c = x.cliente || "un cliente", r = x.repartidor || "Un repartidor", f = FRASES;
    const texto = tipo === "nuevo" ? f.solicitudNueva(c, x.quiere, x.origen)
      : tipo === "tomado" ? f.solicitudTomada(r, c)
      : tipo === "entrega" ? f.solicitudEnEntrega(r, c)
      : tipo === "entregado" ? f.solicitudEntregada(r, c)
      : f.solicitudCancelada(x.por, r, c);
    try { if (navigator.vibrate) navigator.vibrate(tipo === "nuevo" ? [300, 150, 300, 150, 300] : [250, 120, 250]); } catch (_) {}
    hablar(texto, { forzar: true, repetir: tipo === "nuevo" ? 2 : 1, pausaMs: 2000 });
    return texto;
  };

  /* Alertas del cliente. Se dicen una vez; la de cercanía se repite para que se oiga con el celular en el bolsillo */
  const clientePedidoAceptado = () => hablar(FRASES.clientePedidoAceptado, { forzar: true });
  const clienteMensajeNuevo = () => hablar(FRASES.clienteMensajeNuevo);
  const clienteRepartidorCerca = () => {
    try { if (navigator.vibrate) navigator.vibrate([250, 120, 250]); } catch (_) {}
    hablar(FRASES.clienteRepartidorCerca, { forzar: true, repetir: 2, pausaMs: 2500 });
  };

  return { FRASES, hablar, parar, pitido, activar, lista, soporta, repartidorEscribio, clienteEscribio, prioridad, solicitud, solicitudAdmin, solicitudEvento, alertaPedido, mantenerVivo,
           clientePedidoAceptado, clienteMensajeNuevo, clienteRepartidorCerca };
})();
