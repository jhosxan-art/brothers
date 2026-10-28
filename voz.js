/* ============================================================
   VOZ Y SONIDOS (repartidor, cliente y administrador)
   - Voz con la síntesis del propio celular/navegador (en español)
   - Los navegadores solo permiten sonido después de un toque del usuario:
     por eso se "desbloquea" con el primer toque en la pantalla.
   - Si cierras la página o bloqueas el celular, el navegador NO deja sonar nada
     (para eso hacen falta notificaciones push; ver README).
   Cambia las frases aquí, en un solo lugar.
   ============================================================ */
const Voz = (() => {
  const FRASES = {
    mensajeRepartidor: "El repartidor te ha enviado un mensaje",
    mensajeCliente: "El cliente te ha escrito",
    mensajeAdmin: "Brothers te ha escrito",
    guiaAdmin: "Brothers te ha indicado la ubicación del cliente",
    cerca: "El repartidor está cerca",
    prueba: "Alertas de voz activadas"
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

  /* Frases con nombre para el administrador */
  const repartidorEscribio = (n) => (n ? "Nuevo mensaje del repartidor " + n : "Nuevo mensaje del repartidor");
  const clienteEscribio = (n) => (n ? "El cliente " + n + " ha enviado un mensaje" : "Un cliente ha enviado un mensaje");

  const lista = () => desbloqueada;

  return { FRASES, hablar, parar, pitido, activar, lista, soporta, repartidorEscribio, clienteEscribio };
})();
