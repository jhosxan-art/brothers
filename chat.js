/* ============================================================
   CHAT cliente ↔ repartidor (con fotos y aviso por voz)
   - Mensajes en  chats/{token}/{id}      (solo texto, livianos)
   - Fotos en     fotos/{token}/{id}      (JPEG comprimido en base64)
   - Resumen en   chatsResumen/{token}    (lista del administrador)
   Las reglas dejan leer/escribir solo mientras el pedido está "en_ruta";
   el administrador puede leer siempre (archivo permanente).
   ============================================================ */
const Chat = (() => {
  const db = APP.database();   // misma sesión que la página que lo usa
  const TS = firebase.database.ServerValue.TIMESTAMP;
  let token = null, yo = null, soloLectura = false, ctx = {}, opciones = {};
  let ref = null, el = null, abierto = false, cargando = true, audio = null;
  const q = (id) => el.querySelector("#" + id);

  // El sonido y la voz viven en voz.js (se desbloquean con el primer toque)
  const pitido = () => Voz.pitido(2);

  function montar() {
    if (el) return;
    el = document.createElement("div");
    el.className = "chat oculto";
    el.innerHTML = `
      <div class="chat-barra">
        <button class="chat-atras" type="button" aria-label="Volver">‹</button>
        <div><strong id="chatTitulo"></strong><small id="chatSub"></small></div>
      </div>
      <div class="chat-lista" id="chatLista" role="log" aria-live="polite"></div>
      <div class="chat-estado oculto" id="chatEstado"></div>
      <form class="chat-entrada" id="chatForm">
        <label class="chat-foto" aria-label="Enviar foto">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0E141B" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
          <input type="file" accept="image/*" id="chatArchivo" hidden>
        </label>
        <input id="chatTexto" type="text" maxlength="600" placeholder="Escribe un mensaje" autocomplete="off">
        <button class="primario" type="submit">Enviar</button>
      </form>`;
    document.body.appendChild(el);
    el.querySelector(".chat-atras").onclick = cerrar;
    q("chatForm").onsubmit = (e) => {
      e.preventDefault();
      const t = q("chatTexto").value.trim();
      if (!t) return;
      q("chatTexto").value = "";
      enviar(t, null).catch((err) => aviso("No se pudo enviar: " + err.message));
    };
    q("chatArchivo").onchange = async (e) => {
      const f = e.target.files[0]; e.target.value = "";
      if (!f) return;
      try { aviso("Enviando foto…"); await enviar("", await comprimir(f)); aviso(""); }
      catch (err) { aviso("No se pudo enviar la foto: " + err.message); }
    };
  }
  function aviso(t) { const e = q("chatEstado"); e.textContent = t || ""; e.classList.toggle("oculto", !t); }
  function titular() {
    q("chatTitulo").textContent = opciones.titulo ? opciones.titulo(ctx) : "Chat";
    q("chatSub").textContent = opciones.subtitulo ? opciones.subtitulo(ctx) : "";
  }

  // Foto → JPEG de máx. 900 px (≈ 60–150 KB) para guardarla en la base de datos
  function comprimir(file) {
    return new Promise((ok, fallo) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, 900 / Math.max(img.width, img.height));
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        let calidad = 0.7, d = c.toDataURL("image/jpeg", calidad);
        while (d.length > 350000 && calidad > 0.3) { calidad -= 0.1; d = c.toDataURL("image/jpeg", calidad); }
        d.length < 390000 ? ok(d) : fallo(new Error("la foto es demasiado grande"));
      };
      img.onerror = () => fallo(new Error("no se pudo leer la imagen"));
      img.src = url;
    });
  }

  async function enviar(texto, foto) {
    const id = db.ref("chats/" + token).push().key;
    const msg = { de: yo, ts: TS };
    if (texto) msg.texto = texto;
    if (foto) msg.foto = true;
    const upd = {};
    upd[`chats/${token}/${id}`] = msg;
    upd[`chatsResumen/${token}`] = {
      pedido: String(ctx.pedido || "").slice(0, 40), repartidor: String(ctx.nombreRepartidor || "").slice(0, 40),
      ultimoDe: yo, ultimo: (texto || "Foto enviada").slice(0, 100), ts: TS
    };
    if (foto) upd[`fotos/${token}/${id}`] = foto;
    await db.ref().update(upd);
  }

  function pintar(id, m) {
    const lista = q("chatLista");
    const propia = soloLectura ? m.de === "repartidor" : m.de === yo;
    const b = document.createElement("div");
    b.className = "burbuja " + (propia ? "propia" : "ajena");
    if (soloLectura || !propia) {
      const quien = document.createElement("span");
      quien.className = "quien";
      quien.textContent = m.de === "cliente" ? "Cliente" : (ctx.nombreRepartidor || "Repartidor");
      b.appendChild(quien);
    }
    if (m.foto) {
      const img = document.createElement("img");
      img.className = "foto-chat"; img.alt = "Foto";
      img.onclick = () => img.classList.toggle("grande");
      img.onload = () => { lista.scrollTop = lista.scrollHeight; };
      b.appendChild(img);
      db.ref(`fotos/${token}/${id}`).once("value").then((s) => { img.src = s.val() || ""; }).catch(() => { img.alt = "Foto no disponible"; });
    }
    if (m.texto) { const p = document.createElement("p"); p.textContent = m.texto; b.appendChild(p); }
    const h = document.createElement("small");
    h.className = "hora";
    const f = m.ts ? new Date(m.ts) : null;
    h.textContent = !f ? "" : soloLectura
      ? f.toLocaleString("es", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })
      : f.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
    b.appendChild(h);
    lista.appendChild(b);
    lista.scrollTop = lista.scrollHeight;
  }

  let sinLeer = 0;
  function iniciar(o) {
    detener(); montar();
    opciones = o; token = o.token; yo = o.yo || null; soloLectura = !!o.soloLectura;
    ctx = { pedido: o.pedido, nombreRepartidor: o.nombreRepartidor };
    titular();
    q("chatForm").classList.toggle("oculto", soloLectura);
    q("chatLista").innerHTML = ""; aviso(""); sinLeer = 0; cargando = true;
    ref = db.ref("chats/" + token);
    ref.on("child_added", (s) => {
      const m = s.val(); pintar(s.key, m);
      if (!cargando && !soloLectura && m.de !== yo) {
        // opciones.avisos === false: otra parte de la app (repartidor con varios pedidos) se encarga de avisar
        if (opciones.avisos !== false) {
          Voz.hablar(yo === "cliente" ? Voz.FRASES.mensajeRepartidor : Voz.FRASES.mensajeCliente);
          if (!abierto) { navigator.vibrate && navigator.vibrate(200); }
        }
        if (!abierto) { sinLeer++; opciones.alNoLeidos && opciones.alNoLeidos(sinLeer); }
      }
    }, () => aviso("Sin acceso al chat."));
    ref.once("value", () => { cargando = false; });   // llega después de los mensajes ya existentes
  }
  function setContexto(c) { Object.assign(ctx, c); if (el) titular(); }
  function abrir() {
    if (!el || !token) return;
    abierto = true; sinLeer = 0; opciones.alNoLeidos && opciones.alNoLeidos(0);
    el.classList.remove("oculto");
    const l = q("chatLista"); l.scrollTop = l.scrollHeight;
    if (!soloLectura) setTimeout(() => q("chatTexto").focus(), 60);
  }
  function cerrar() {
    abierto = false; if (el) el.classList.add("oculto");
    if (opciones.alCerrar) opciones.alCerrar();
    if (soloLectura) detener();
  }
  // Borra todo rastro local del chat (el repartidor no conserva nada al terminar)
  function detener() {
    if (ref) { ref.off(); ref = null; }
    abierto = false; sinLeer = 0;
    if (el) { el.classList.add("oculto"); q("chatLista").innerHTML = ""; q("chatTexto").value = ""; }
    if (opciones.alNoLeidos) opciones.alNoLeidos(0);
    token = null;
  }
  return { iniciar, abrir, cerrar, detener, setContexto, pitido };
})();
