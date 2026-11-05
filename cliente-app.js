/* ============================================================
   CLIENTE — chat tipo WhatsApp (Fase 1)
   Flujo:
     1) Sesión anónima de Firebase.
     2) Lee el perfil de LocalStorage. Si no existe o está dañado → genera ID único y pide el nombre.
     3) Crea (o retoma) el chat en  solicitudes_entrantes/{solicitudId}.
     4) Escucha el chat en vivo. El cliente solo puede escribir cuando un repartidor lo atendió
        (estado "atendido" + repartidorUid), y solo conversa con ese repartidor.

   Esquema en Realtime Database:
     solicitudes_entrantes/{solicitudId}
        clienteId, nombre, estado ("nuevo" | "atendido"), creado, ts,
        repartidorUid, repartidorNombre (los escribe el repartidor al pulsar "Atender"),
        ultimoMensaje, ultimoDe
     solicitudes_entrantes/{solicitudId}/mensajes/{pushId}
        de ("cliente" | "repartidor"), tipo ("texto" | "factura"), ts,
        texto            (tipo "texto")
        factura {…}      (tipo "factura": productos[{nombre,precio}], subtotal, delivery,
                          mandadoExtra, prioridad, deposito, totalFinal, pedido, cliente)
   ============================================================ */
(() => {
  "use strict";

  const RAIZ = "solicitudes_entrantes";
  const CLAVE_LOCAL = "brothers_cliente_v1";
  const MAX_TEXTO = 600;

  const $ = (id) => document.getElementById(id);
  const db = APP.database();
  const auth = APP.auth();

  let perfil = null;            // { id, nombre, solicitudId }
  let refSolicitud = null;
  let refMensajes = null;
  let asignado = false;         // true cuando hay repartidor asignado
  let primerSnapshot = true;
  let respaldoMemoria = null;   // si LocalStorage no está disponible (modo privado, etc.)

  /* ---------- Utilidades ---------- */
  const vista = (id) => ["vCarga", "vNombre", "vChat"].forEach((v) => $(v).classList.toggle("oculto", v !== id));

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

  /* ---------- Perfil en LocalStorage (validado: nunca devuelve algo sin id) ---------- */
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
    if (!perfil || !idValido(perfil.id)) {          // salvaguarda: jamás se lee .id de algo nulo
      perfil = null;
      try { localStorage.removeItem(CLAVE_LOCAL); } catch (_) { /* nada */ }
      vista("vNombre");
      return;
    }
    $("msgCarga").className = "wa-estado";
    $("msgCarga").textContent = "Abriendo tu chat…";
    vista("vCarga");

    if (!perfil.solicitudId) {
      perfil.solicitudId = "sol_" + perfil.id;
      guardarPerfil(perfil);
    }

    refSolicitud = db.ref(RAIZ + "/" + perfil.solicitudId);
    refMensajes = refSolicitud.child("mensajes");

    try {
      const s = await refSolicitud.once("value");
      if (!s.exists()) {
        await refSolicitud.set({
          clienteId: perfil.id,
          nombre: perfil.nombre,
          estado: "nuevo",
          creado: firebase.database.ServerValue.TIMESTAMP,
          ts: firebase.database.ServerValue.TIMESTAMP,
          ultimoMensaje: "",
          ultimoDe: ""
        });
      }
    } catch (e) {
      return errorCarga("No se pudo crear tu chat: " + (e.code || e.message));
    }

    vista("vChat");
    escucharSolicitud();
    escucharMensajes();
  }

  /* ---------- Estado de la solicitud (quién me atiende) ---------- */
  function escucharSolicitud() {
    refSolicitud.on("value", (s) => {
      if (!s.exists()) {
        // El chat fue eliminado desde el panel: se crea uno nuevo con el mismo perfil.
        refSolicitud.off();
        refMensajes.off();
        $("mensajes").textContent = "";
        ultimoDe = null; ultimoDia = null; vistos.clear();
        primerSnapshot = true; asignado = false;
        return abrirChat();
      }
      const d = s.val() || {};
      const ahoraAsignado = d.estado === "atendido" && typeof d.repartidorUid === "string" && d.repartidorUid.length > 0;
      const nombreRep = typeof d.repartidorNombre === "string" ? d.repartidorNombre.slice(0, 40) : "";
      pintarEstado(ahoraAsignado, nombreRep);
      if (ahoraAsignado && !asignado && !primerSnapshot) {
        avisoSistema((nombreRep || "Un repartidor") + " atendió tu chat.");
      }
      asignado = ahoraAsignado;
      primerSnapshot = false;
    }, (e) => mostrarError("Se perdió la conexión con tu chat: " + (e.code || e.message)));
  }

  function pintarEstado(conRepartidor, nombreRep) {
    $("avisoEspera").classList.toggle("oculto", conRepartidor);
    $("tituloChat").textContent = conRepartidor ? (nombreRep || "Tu repartidor") : "Brother’s Deliverys";
    $("subChat").textContent = conRepartidor ? "Te está atendiendo" : "Buscando repartidor…";
    $("avatarRep").textContent = conRepartidor ? (nombreRep || "R").charAt(0).toUpperCase() : "B";
    const inp = $("inMensaje");
    inp.disabled = !conRepartidor;
    $("btnEnviar").disabled = !conRepartidor;
    inp.placeholder = conRepartidor ? "Escribe un mensaje" : "Esperando repartidor…";
  }

  /* ---------- Mensajes en vivo ---------- */
  let ultimoDe = null, ultimoDia = null;
  const vistos = new Set();

  function escucharMensajes() {
    // Las claves push() ya van en orden cronológico, así no hace falta un índice en la base de datos.
    refMensajes.limitToLast(300).on("child_added", (s) => {
      if (vistos.has(s.key)) return;
      vistos.add(s.key);
      const m = s.val();
      if (!m || typeof m !== "object") return;
      pintarMensaje(m);
    }, (e) => mostrarError("No se pudieron leer los mensajes: " + (e.code || e.message)));
  }

  function pegadoAlFinal() {
    const c = $("mensajes");
    return c.scrollHeight - c.scrollTop - c.clientHeight < 80;
  }

  function alFinal() {
    const c = $("mensajes");
    c.scrollTop = c.scrollHeight;
  }

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

  function pintarMensaje(m) {
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
    } else {
      const p = document.createElement("p");
      p.textContent = String(m.texto || "");
      burbuja.appendChild(p);
    }

    const h = document.createElement("span");
    h.className = "wa-hora";
    h.textContent = hora(ts);
    burbuja.appendChild(h);

    $("mensajes").appendChild(burbuja);
    if (seguir) alFinal();
  }

  /* ---------- Factura como tarjeta (todo con textContent: nada se interpreta como HTML) ---------- */
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
    mostrarError("");
    const clave = refMensajes.push().key;
    const ts = firebase.database.ServerValue.TIMESTAMP;
    const cambios = {};
    cambios["mensajes/" + clave] = { de: "cliente", tipo: "texto", texto, ts };
    cambios["ultimoMensaje"] = texto.slice(0, 80);
    cambios["ultimoDe"] = "cliente";
    cambios["ts"] = ts;

    try {
      await refSolicitud.update(cambios);
    } catch (e) {
      inp.value = texto;
      mostrarError("No se pudo enviar el mensaje: " + (e.code || e.message));
    }
    inp.focus();
  });

  arrancar();
})();
