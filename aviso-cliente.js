/* ============================================================
   AVISO-CLIENTE · el cliente ESCUCHA en voz alta cuando retiran su pedido, lo entregan o le escriben.
   Instalación: en rastreo.html, justo antes de </body> (después de firebase-config.js), agrega:
       <script src="aviso-cliente.js"></script>
   Lee pedidos/{token}/aviso (lo escribe el repartidor al marcar "Retirado" / "Entregado") y los
   mensajes nuevos del repartidor en chats/{token}.
   ============================================================ */
(() => {
  const t = new URLSearchParams(location.search).get("id"); if (!t || typeof firebase === "undefined") return;
  const db = (typeof APP !== "undefined" ? APP : firebase.app()).database();
  let audioOk = false, ultAviso = 0, cargadoChat = false;
  const cola = [];
  function decir(txt) {
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    if (!audioOk || !("speechSynthesis" in window)) { cola.push(txt); return; }
    const u = new SpeechSynthesisUtterance(txt.replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, "")); u.lang = "es-ES";
    speechSynthesis.speak(u);
  }
  // Los navegadores exigen un toque antes de permitir voz: el primer toque en la página la activa
  const chip = document.createElement("button");
  chip.type = "button"; chip.textContent = "🔊 Toca para activar avisos de voz";
  chip.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:12px;z-index:99999;border:0;border-radius:999px;padding:10px 16px;font:700 13px system-ui;background:#111;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.35)";
  document.body.appendChild(chip);
  const activar = () => {
    audioOk = true; chip.remove();
    try { speechSynthesis.speak(new SpeechSynthesisUtterance(" ")); } catch (_) {}
    while (cola.length) decir(cola.shift());
    removeEventListener("pointerdown", activar);
  };
  addEventListener("pointerdown", activar); chip.onclick = activar;

  db.ref(`pedidos/${t}/aviso`).on("value", (s) => {
    const a = s.val(); if (!a || !a.ts || a.ts === ultAviso) return;
    const primera = ultAviso === 0; ultAviso = a.ts;
    if (primera && Date.now() - a.ts > 120000) return;   // avisos viejos no se repiten al abrir la página
    decir(a.texto);
  });
  const rc = db.ref("chats/" + t).limitToLast(30);
  rc.on("child_added", (s) => { const m = s.val(); if (cargadoChat && m && m.de === "repartidor" && !m.sistema && m.texto) decir("Mensaje del repartidor: " + m.texto); });
  rc.once("value", () => { cargadoChat = true; });
})();
