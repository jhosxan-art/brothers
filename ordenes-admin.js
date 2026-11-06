const SolicitudesAdmin = (() => {
  const RAIZ = "solicitudes_entrantes", RAIZ_FOTOS = "solicitudes_fotos", RAIZ_CLIENTES = "clientes", PANEL = "panelSolicitudes";
  const g = (id) => document.getElementById(id);
  let consulta = null, lista = {}, filtro = "todos", fecha = "", visorId = null, consultaMsgs = null, ultDia = null;
  let refUbic = null, ubic = {};
  let refLeidos = null, refUltimaDir = null, lect = {}, ultimaDirCliente = null;
  let mapa = null, marcaCli = null, marcaRep = null, linea = null, encuadrado = false;
  const vistos = new Set(), sel = new Set();
  let cargada = false;
  const avisadas = new Set();
  const COLOR_TICK_ENVIADO = "#8696A0", COLOR_TICK_LEIDO = "#25D366";

  const fin = (d) => !!d && (d.estado === "entregado" || d.estado === "cancelado");
  const estadoDe = (d) => (fin(d) ? d.estado : d.repartidorUid ? "atendido" : "nuevo");
  const dinero = (n) => "C$ " + (Number(n) || 0).toFixed(2);
  const horaDe = (ts) => new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const cortar = (s, n) => String(s == null ? "" : s).slice(0, n);
  const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  function etiquetaDia(ts) {
    const d = new Date(ts), hoy = new Date();
    const ini = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dif = Math.round((ini(hoy) - ini(d)) / 86400000);
    return dif === 0 ? "Hoy" : dif === 1 ? "Ayer" : d.toLocaleDateString("es", { day: "numeric", month: "long" });
  }
  function el(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }
  function diaDe(d) {
    const t = new Date(Number(d && (d.creado || d.ts)) || 0);
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }
  function iconoWA() {
    const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "14"); s.setAttribute("height", "14"); s.setAttribute("aria-hidden", "true");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", "M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.2 14.2c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.6-2.6-1.1-4.3-3.8-4.4-4-.1-.2-1-1.3-1-2.5s.6-1.8.9-2c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.3.4-.4.5c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.8-.1 1.4z");
    s.appendChild(p);
    return s;
  }
  function chipEstado(d) {
    const est = estadoDe(d), nom = cortar(d.repartidorNombre || "un repartidor", 30);
    if (est === "nuevo") return el("span", "sa-estado", "Sin atender");
    if (est === "atendido") { const c = el("span", "sa-estado wa"); c.appendChild(iconoWA()); c.appendChild(document.createTextNode(" Con pedido · " + nom)); return c; }
    if (est === "entregado") return el("span", "sa-estado entregado", "✅ Entregado" + (d.repartidorNombre ? " · " + nom : "") + (d.forzadoPorAdmin ? " · forzado" : ""));
    return el("span", "sa-estado cancelado", "🚫 Cancelado" + (d.motivoCancelacion === "cliente" ? " · lo decidió el cliente" : "") + (d.forzadoPorAdmin ? " · forzado" : ""));
  }
  const estrellas = (n) => "★".repeat(n) + "☆".repeat(5 - n);
  const valoracion = (d) => { const n = Number(d && d.valoracion && d.valoracion.estrellas); return n >= 1 && n <= 5 ? Math.round(n) : 0; };
  function msg(texto, error) {
    const m = g("saMsg");
    if (!m) return;
    m.textContent = texto || "";
    m.className = "sa-msg" + (error ? " error" : "") + (texto ? "" : " oculto");
  }

  function anunciarNuevas(ids) {
    if (!ids.length) return;
    try { if (typeof Voz !== "undefined" && Voz.solicitudAdmin) Voz.solicitudAdmin(); } catch (_) {}
    if (typeof toast === "function") {
      toast("📥 " + (ids.length === 1 ? "Nueva solicitud de cliente pendiente" : ids.length + " solicitudes nuevas pendientes"));
    }
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const titulo = "📥 " + (ids.length === 1 ? "Nueva solicitud de pedido" : ids.length + " solicitudes nuevas");
        const cuerpo = ids.length === 1
          ? "Un cliente quiere hacer un pedido. Toca para abrir el panel de Solicitudes."
          : ids.length + " clientes quieren hacer pedidos. Toca para abrir el panel de Solicitudes.";
        const n = new Notification(titulo, { body: cuerpo, tag: "solicitud-nueva", requireInteraction: false });
        n.onclick = () => { try { window.focus(); } catch (_) {} ; try { irAPestana("panelSolicitudes"); } catch (_) {} ; try { n.close(); } catch (_) {} };
      }
    } catch (_) {}
  }

  function iniciar() {
    detener();
    cargada = false; avisadas.clear();
    consulta = db.ref(RAIZ).limitToLast(100);
    consulta.on("value", (s) => {
      const antes = lista;
      lista = s.val() || {};
      if (cargada) {
        const nuevas = [];
        Object.keys(lista).forEach((k) => {
          const d = lista[k];
          if (d && estadoDe(d) === "nuevo" && !avisadas.has(k) && (!antes[k] || estadoDe(antes[k]) !== "nuevo")) {
            avisadas.add(k);
            nuevas.push(k);
          }
        });
        if (nuevas.length) anunciarNuevas(nuevas);
      } else {
        Object.keys(lista).forEach((k) => { if (lista[k] && estadoDe(lista[k]) === "nuevo") avisadas.add(k); });
      }
      cargada = true;
      [...sel].forEach((id) => { if (!lista[id] || !fin(lista[id])) sel.delete(id); });
      pintar();
      if (visorId) { cabeceraVisor(); actualizarMapa(false); }
    }, (e) => {
      lista = {};
      pintar(e && e.code === "PERMISSION_DENIED" ? "Sin permiso para leer “solicitudes_entrantes”. Revisa las reglas de Firebase." : "No se pudieron cargar las solicitudes.");
    });
    refUbic = db.ref("ubicaciones");
    refUbic.on("value", (s) => { ubic = s.val() || {}; pintarServicio(); }, () => { ubic = {}; pintarServicio(); });
  }
  function detener() {
    if (consulta) { consulta.off(); consulta = null; }
    if (refUbic) { refUbic.off(); refUbic = null; }
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    if (refUltimaDir) { refUltimaDir.off(); refUltimaDir = null; }
    lect = {}; ultimaDirCliente = null;
    cerrarVisor();
    lista = {}; ubic = {}; sel.clear();
    pintar();
  }
  function pintarServicio() {
    const c = g("saServicio");
    if (!c) return;
    c.textContent = "";
    const ids = Object.keys(ubic).filter((u) => ubic[u] && ubic[u].conPedido === true && ubic[u].enLinea !== false);
    ids.forEach((u) => { const x = el("span", "sa-estado wa"); x.appendChild(iconoWA()); x.appendChild(document.createTextNode(" " + cortar(ubic[u].usuario || "Repartidor", 24) + " · con pedido")); c.appendChild(x); });
    c.classList.toggle("oculto", !ids.length);
  }
  function visibles() {
    return Object.keys(lista).filter((k) => lista[k] && typeof lista[k] === "object")
      .filter((k) => {
        const e = estadoDe(lista[k]);
        if (filtro === "nuevo" && e !== "nuevo") return false;
        if (filtro === "atendido" && e !== "atendido") return false;
        if (filtro === "finalizado" && !fin(lista[k])) return false;
        return !fecha || diaDe(lista[k]) === fecha;
      })
      .sort((a, b) => (Number(lista[b].ts) || 0) - (Number(lista[a].ts) || 0));
  }
  function pintar(error) {
    const caja = g("saLista");
    if (!caja) return;
    caja.textContent = "";
    const todas = Object.keys(lista).filter((k) => lista[k] && typeof lista[k] === "object");
    const sinAtender = todas.filter((k) => estadoDe(lista[k]) === "nuevo").length;
    const badge = g("saBadge");
    if (badge) { badge.textContent = String(sinAtender); badge.classList.toggle("oculto", !sinAtender); }
    const vals = todas.map((k) => valoracion(lista[k])).filter(Boolean);
    g("saResumen").textContent = vals.length ? "⭐ " + (vals.reduce((t, n) => t + n, 0) / vals.length).toFixed(1) + " de promedio · " + vals.length + " valoración" + (vals.length > 1 ? "es" : "") : "";
    if (error) { caja.appendChild(el("div", "sa-vacio", error)); pintarHerramientas([]); return; }
    const vis = visibles();
    pintarHerramientas(vis);
    if (!vis.length) {
      caja.appendChild(el("div", "sa-vacio", !todas.length ? "Todavía no hay solicitudes. Aparecerán aquí en cuanto un cliente haga un pedido." : "No hay solicitudes con este filtro."));
      return;
    }
    vis.forEach((k) => {
      const d = lista[k], est = estadoDe(d), p = d.pedido || {};
      const f = el("div", "sa-item" + (est === "nuevo" ? " nuevo" : est === "atendido" ? " activo" : ""));
      if (fin(d)) {
        const c = el("input", "sa-chk");
        c.type = "checkbox"; c.checked = sel.has(k);
        c.setAttribute("aria-label", "Seleccionar el chat de " + cortar(d.nombre || "Cliente", 30));
        c.addEventListener("change", () => { if (c.checked) sel.add(k); else sel.delete(k); pintarHerramientas(visibles()); });
        f.appendChild(c);
      }
      const nombre = cortar(d.nombre || "Cliente", 40);
      f.appendChild(el("span", "sa-av", nombre.charAt(0).toUpperCase()));
      const dat = el("div", "sa-dat");
      dat.appendChild(el("strong", "", nombre));
      dat.appendChild(chipEstado(d));
      if (p.quiere) dat.appendChild(el("small", "", "🛍️ " + cortar(p.quiere, 70) + (p.origen ? " · de " + cortar(p.origen, 40) : "")));
      const ult = d.ultimoMensaje ? (d.ultimoDe === "cliente" ? "Cliente: " : d.ultimoDe === "repartidor" ? "Repartidor: " : "") + String(d.ultimoMensaje) : "Sin mensajes todavía";
      dat.appendChild(el("small", "", ult + (d.ts ? " · " + horaDe(d.ts) : "")));
      if (valoracion(d)) dat.appendChild(el("small", "sa-estrellas", estrellas(valoracion(d))));
      f.appendChild(dat);
      const acc = el("div", "sa-acc");
      const b = el("button", "oscuro", "👁 Ver");
      b.type = "button"; b.setAttribute("aria-label", "Leer el chat de " + nombre);
      b.addEventListener("click", () => abrirVisor(k));
      acc.appendChild(b);
      if (d.repartidorUid) {
        const fEnt = el("button", "primario", "✅");
        fEnt.type = "button"; fEnt.title = "Forzar entregado"; fEnt.setAttribute("aria-label", "Forzar entregado");
        fEnt.addEventListener("click", () => forzarEstadoSolicitud(k, "entregado"));
        acc.appendChild(fEnt);
        const fCanc = el("button", "peligro", "🚫");
        fCanc.type = "button"; fCanc.title = "Forzar cancelado"; fCanc.setAttribute("aria-label", "Forzar cancelado");
        fCanc.addEventListener("click", () => forzarEstadoSolicitud(k, "cancelado"));
        acc.appendChild(fCanc);
      }
      if (fin(d)) {
        const x = el("button", "peligro", "🗑");
        x.type = "button"; x.setAttribute("aria-label", "Eliminar el chat de " + nombre);
        x.addEventListener("click", () => borrar([k]));
        acc.appendChild(x);
      }
      f.appendChild(acc);
      caja.appendChild(f);
    });
  }
  function pintarHerramientas(vis) {
    const finV = vis.filter((k) => fin(lista[k]));
    const selV = finV.filter((k) => sel.has(k));
    g("saSelTodas").checked = !!finV.length && selV.length === finV.length;
    g("saSelTodas").disabled = !finV.length;
    g("saBorrarSel").disabled = !sel.size;
    g("saBorrarSel").textContent = "🗑 Eliminar seleccionadas (" + sel.size + ")";
    g("saBorrarFecha").disabled = !fecha || !finV.length;
    g("saBorrarFecha").textContent = fecha ? "🗑 Eliminar finalizadas del " + fecha.split("-").reverse().join("/") + " (" + finV.length + ")" : "🗑 Elige una fecha para borrar por día";
  }
  async function borrar(ids) {
    ids = ids.filter((id) => lista[id] && fin(lista[id]));
    if (!ids.length) return msg("Solo se pueden eliminar chats entregados o cancelados.", true);
    if (!confirm("¿Eliminar " + (ids.length === 1 ? "este chat" : ids.length + " chats") + " para siempre? Se borran también sus mensajes, fotos y facturas. Esta acción no se puede deshacer.")) return;
    msg("Eliminando…");
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const upd = {};
        ids.slice(i, i + 40).forEach((id) => { upd[RAIZ + "/" + id] = null; upd[RAIZ_FOTOS + "/" + id] = null; });
        await db.ref().update(upd);
      }
    } catch (e) {
      return msg("No se pudo eliminar: " + (e.code || e.message) + (e.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : ""), true);
    }
    ids.forEach((id) => { sel.delete(id); delete lista[id]; if (id === visorId) cerrarVisor(); });
    msg(ids.length === 1 ? "Chat eliminado." : ids.length + " chats eliminados.");
    pintar();
    setTimeout(() => msg(""), 4000);
  }
  async function forzarEstadoSolicitud(id, nuevoEstado) {
    const d = lista[id];
    if (!d) return msg("No encuentro esa solicitud.", true);
    if (!["entregado", "cancelado"].includes(nuevoEstado)) return msg("Estado no válido.", true);
    const esEnt = nuevoEstado === "entregado";
    const yaEsta = d.estado === nuevoEstado;
    if (yaEsta && !confirm("La solicitud YA está " + (esEnt ? "ENTREGADA" : "CANCELADA") + ".\n¿Re-forzar de todos modos? (actualiza los sellos de tiempo)")) return;
    if (!yaEsta && !confirm((esEnt ? "¿Forzar como ENTREGADO" : "¿Forzar como CANCELADO") + " el chat de " + cortar(d.nombre || "Cliente", 30) + "?\n\nEsto sobrescribe el estado sin importar lo que diga el repartidor o el cliente.")) return;
    const motivo = (prompt("Motivo del forzado (queda en el historial, máx. 300 caracteres):", "") || "").trim().slice(0, 300);
    if (!motivo && !confirm("Sin motivo. ¿Continuar igual?")) return;
    const upd = {
      [RAIZ + "/" + id + "/estado"]: nuevoEstado,
      [RAIZ + "/" + id + "/forzadoPorAdmin"]: true,
      [RAIZ + "/" + id + "/forzadoTs"]: firebase.database.ServerValue.TIMESTAMP
    };
    if (esEnt) upd[RAIZ + "/" + id + "/entregadoTs"] = firebase.database.ServerValue.TIMESTAMP;
    else upd[RAIZ + "/" + id + "/canceladoTs"] = firebase.database.ServerValue.TIMESTAMP;
    if (motivo) upd[RAIZ + "/" + id + "/motivoForzado"] = motivo;
    try {
      await db.ref().update(upd);
      msg(esEnt ? "✅ Chat forzado a ENTREGADO" : "🚫 Chat forzado a CANCELADO");
      setTimeout(() => msg(""), 4000);
    } catch (e) { msg("No se pudo forzar: " + (e.code || e.message), true); }
  }

  /* ---------- Visor de solo lectura ---------- */
  function cabeceraVisor() {
    const d = lista[visorId];
    if (!d) { g("saSub").textContent = "Este chat fue eliminado."; g("saBorrarUno").classList.add("oculto"); g("saForzarEnt").classList.add("oculto"); g("saForzarCanc").classList.add("oculto"); return; }
    g("saTitulo").textContent = cortar(d.nombre || "Cliente", 40);
    const est = estadoDe(d), v = valoracion(d);
    g("saSub").textContent = est === "nuevo" ? "Sin atender todavía"
      : est === "atendido" ? "Con pedido · " + cortar(d.repartidorNombre || "un repartidor", 30)
      : est === "entregado" ? "Entregado" + (d.repartidorNombre ? " por " + cortar(d.repartidorNombre, 30) : "") + (v ? " · " + estrellas(v) : " · sin valoración") + (d.forzadoPorAdmin ? " · forzado" : "")
      : "Cancelado" + (d.motivoCancelacion === "cliente" ? " · lo decidió el cliente" : "") + (d.forzadoPorAdmin ? " · forzado" : "");
    g("saBorrarUno").classList.toggle("oculto", !fin(d));
    const activa = !!d.repartidorUid;
    g("saForzarEnt").classList.toggle("oculto", !activa);
    g("saForzarCanc").classList.toggle("oculto", !activa);
    const p = d.pedido;
    const r = g("saPedido");
    /* FASE 4 · añade la última dirección del cliente al bloque de info */
    let info = "";
    if (p && p.quiere) info = "🛍️ " + cortar(p.quiere, 160) + " · de " + cortar(p.origen, 80) + " · " + (p.modo === "envia" ? "🎁 lo envía a otra persona" : "🙋 lo recibe él") + " · 📍 " + destinoTexto(p);
    if (ultimaDirCliente) {
      info += (info ? " · " : "") + "📮 <b>Última dirección:</b> " + escapeHtml(ultimaDirCliente.texto);
    }
    r.innerHTML = info;
    r.classList.toggle("oculto", !info);
  }
  function destinoTexto(p) {
    const x = p && p.destino;
    if (!x) return "sin dato";
    return x.tipo === "gps" ? "GPS en vivo" : x.tipo === "pin" ? "pin en el mapa" : cortar(x.texto || "dirección", 120);
  }
  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function abrirVisor(id) {
    cerrarVisor();
    visorId = id; ultDia = null; vistos.clear();
    g("saMsgs").textContent = "";
    g("saMapaCaja").classList.add("oculto");
    g("saMapaBtn").setAttribute("aria-expanded", "false");
    cabeceraVisor();
    g("modalSolicitud").classList.remove("oculto");
    consultaMsgs = db.ref(RAIZ + "/" + id + "/mensajes").limitToLast(300);
    consultaMsgs.on("child_added", (s) => {
      if (vistos.has(s.key)) return;
      vistos.add(s.key);
      const m = s.val();
      if (m && typeof m === "object") pintarMensaje(m, s.key);
    }, (e) => { g("saSub").textContent = "No se pudieron leer los mensajes: " + (e.code || e.message); });
    /* FASE 4 · palomitas y última dirección */
    leerLeidos(id);
    leerUltimaDir(id);
  }
  function leerLeidos(id) {
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    refLeidos = db.ref(RAIZ + "/" + id + "/leidos");
    refLeidos.on("value", (s) => {
      const v = s.val() || {};
      lect = { cliente: Number(v.cliente) || 0, repartidor: Number(v.repartidor) || 0 };
      actualizarTicks();
    }, () => {});
  }
  function actualizarTicks() {
    if (!visorId) return;
    g("saMsgs").querySelectorAll(".sa-tick").forEach((t) => {
      const ts = +t.dataset.ts || 0;
      const leido = ts > 0 && (Number(lect.cliente) || 0) >= ts;
      t.textContent = leido ? "✓✓" : "✓";
      t.classList.toggle("leido", leido);
      t.style.color = leido ? COLOR_TICK_LEIDO : COLOR_TICK_ENVIADO;
      t.title = leido ? "Leído" : "Enviado";
    });
  }
  function leerUltimaDir(id) {
    if (refUltimaDir) { refUltimaDir.off(); refUltimaDir = null; }
    ultimaDirCliente = null;
    const d = lista[id];
    if (!d || !d.clienteId) return;
    refUltimaDir = db.ref(RAIZ_CLIENTES + "/" + d.clienteId + "/ultimaDireccion");
    refUltimaDir.on("value", (s) => {
      const u = s.val();
      if (!u || typeof u !== "object") { ultimaDirCliente = null; cabeceraVisor(); return; }
      if (u.tipo !== "pin" && u.tipo !== "direccion") { ultimaDirCliente = null; cabeceraVisor(); return; }
      let donde = "";
      if (u.tipo === "direccion") donde = String(u.texto || "");
      else if (okLL(Number(u.lat), Number(u.lng))) donde = `Pin del mapa (${Number(u.lat).toFixed(5)}, ${Number(u.lng).toFixed(5)})`;
      if (!donde) { ultimaDirCliente = null; cabeceraVisor(); return; }
      ultimaDirCliente = { tipo: u.tipo, texto: donde };
      cabeceraVisor();
    }, () => {});
  }
  function cerrarVisor() {
    if (consultaMsgs) { consultaMsgs.off(); consultaMsgs = null; }
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    if (refUltimaDir) { refUltimaDir.off(); refUltimaDir = null; }
    visorId = null;
    lect = {}; ultimaDirCliente = null;
    quitarMarcas();
    const m = g("modalSolicitud");
    if (m) m.classList.add("oculto");
  }
  function cargarFoto(id, clave, img, listo) {
    db.ref(RAIZ_FOTOS + "/" + id + "/" + clave).once("value").then((s) => {
      const v = s.val();
      if (typeof v === "string" && v.indexOf("data:image/") === 0) { img.addEventListener("load", listo, { once: true }); img.src = v; }
      else img.alt = "Foto no disponible";
    }).catch(() => { img.alt = "No se pudo cargar la foto"; });
  }
  function pintarMensaje(m, clave) {
    const c = g("saMsgs"), ts = Number(m.ts) || Date.now(), rep = m.de === "repartidor";
    const pegado = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
    const dia = new Date(ts).toDateString();
    if (dia !== ultDia) { ultDia = dia; c.appendChild(el("div", "sa-dia", etiquetaDia(ts))); }
    const d = lista[visorId] || {};
    const b = el("div", "sa-b" + (rep ? " rep" : ""));
    b.appendChild(el("div", "sa-quien", rep ? cortar(d.repartidorNombre || "Repartidor", 40) : cortar(d.nombre || "Cliente", 40)));
    if (m.tipo === "factura" && m.factura && typeof m.factura === "object") {
      b.classList.add("fac");
      b.appendChild(tarjetaFactura(m.factura));
    } else if (m.tipo === "foto") {
      b.classList.add("foto");
      const img = document.createElement("img");
      img.alt = "Cargando foto…";
      b.appendChild(img);
      const id = visorId;
      cargarFoto(id, clave, img, () => { if (pegado) c.scrollTop = c.scrollHeight; });
    } else {
      b.appendChild(el("p", "", String(m.texto || "")));
    }
    const h = el("span", "sa-h", horaDe(ts));
    /* FASE 4 · palomitas en los mensajes del repartidor (los que el cliente leyó) */
    if (rep) {
      const tick = document.createElement("span");
      tick.className = "sa-tick"; tick.dataset.ts = ts; tick.textContent = "✓";
      tick.style.color = COLOR_TICK_ENVIADO;
      h.appendChild(document.createTextNode(" "));
      h.appendChild(tick);
    }
    b.appendChild(h);
    c.appendChild(b);
    actualizarTicks();
    if (pegado || c.children.length <= 2) c.scrollTop = c.scrollHeight;
  }
  function filaF(etiqueta, valor, clase) {
    const f = el("div", "sa-ffil" + (clase ? " " + clase : ""));
    f.appendChild(el("span", "", etiqueta));
    f.appendChild(el("b", "", valor));
    return f;
  }
  function tarjetaFactura(f) {
    const caja = document.createElement("div");
    const prods = (Array.isArray(f.productos) ? f.productos : []).filter((p) => p && typeof p === "object");
    const extras = prods.filter((p) => String(p.nombre || "").indexOf("➕") === 0), normales = prods.filter((p) => extras.indexOf(p) < 0);
    const cab = el("div", "sa-fcab");
    cab.appendChild(el("strong", "", "🏍️ Brother’s Delivery"));
    cab.appendChild(el("span", "", extras.length ? "Factura actualizada" : "Factura"));
    caja.appendChild(cab);
    const cue = el("div", "sa-fcue");
    if (f.cliente) cue.appendChild(el("div", "sa-fmeta", "Cliente: " + String(f.cliente)));
    if (f.deposito) cue.appendChild(el("div", "sa-fmeta", "Depósito: sí"));
    const lis = el("div", "sa-flis");
    normales.forEach((p) => lis.appendChild(filaF(String(p.nombre || "Producto"), dinero(p.precio))));
    cue.appendChild(lis);
    if (extras.length) {
      const ex = el("div", "sa-extras");
      ex.appendChild(el("div", "sa-extras-tit", "➕ Mandados extra"));
      extras.forEach((p) => ex.appendChild(filaF(String(p.nombre).replace(/^➕\s*/, "") || "Extra", dinero(p.precio))));
      ex.appendChild(filaF("Suma de extras", dinero(extras.reduce((t, p) => t + (Number(p.precio) || 0), 0)), "sub"));
      cue.appendChild(ex);
    }
    const tot = el("div", "sa-ftot");
    tot.appendChild(filaF("Subtotal", dinero(f.subtotal)));
    tot.appendChild(filaF(Number(f.mandadoExtra) > 0 ? "Delivery (incluye mandado extra " + dinero(f.mandadoExtra) + ")" : "Delivery", dinero(f.delivery)));
    if (Number(f.prioridad) > 0) tot.appendChild(filaF("⚡ Prioridad", dinero(f.prioridad)));
    tot.appendChild(filaF("Total", dinero(f.totalFinal != null ? f.totalFinal : f.total), "total"));
    cue.appendChild(tot);
    if (f.pedido) {
      const cod = el("div", "sa-fcod");
      cod.appendChild(el("small", "", "Código de retiro"));
      cod.appendChild(el("span", "", String(f.pedido)));
      cue.appendChild(cod);
    }
    caja.appendChild(cue);
    return caja;
  }
  const iconoPin = (clase, emoji) => L.divIcon({ className: "", html: '<div class="sa-pin ' + clase + '">' + emoji + "</div>", iconSize: [36, 36], iconAnchor: [18, 18] });
  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function hace(ts) {
    const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
    return s < 60 ? "hace " + s + " s" : s < 3600 ? "hace " + Math.round(s / 60) + " min" : "hace " + Math.round(s / 3600) + " h";
  }
  function quitarMarcas() {
    if (mapa) { [marcaCli, marcaRep, linea].forEach((x) => { if (x) mapa.removeLayer(x); }); }
    marcaCli = marcaRep = linea = null; encuadrado = false;
  }
  function alternarMapa() {
    if (typeof L === "undefined") return msg("No se pudo cargar el mapa (Leaflet).", true);
    const caja = g("saMapaCaja"), abrir = caja.classList.contains("oculto");
    caja.classList.toggle("oculto", !abrir);
    g("saMapaBtn").setAttribute("aria-expanded", String(abrir));
    if (!abrir) return;
    if (!mapa) {
      mapa = L.map("saMapa", { zoomControl: false }).setView([12.5700, -87.1311], 13);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    }
    setTimeout(() => { mapa.invalidateSize(); encuadrado = false; actualizarMapa(true); }, 80);
  }
  function actualizarMapa(forzar) {
    if (!mapa || !visorId || g("saMapaCaja").classList.contains("oculto")) return;
    const d = lista[visorId] || {}, cg = d.clienteGps, rg = d.repartidorGps, dest = d.pedido && d.pedido.destino;
    let cli = null, vivoCli = false;
    if (cg && okLL(cg.lat, cg.lng)) { cli = { lat: cg.lat, lng: cg.lng }; vivoCli = true; }
    else if (dest && okLL(dest.lat, dest.lng)) cli = { lat: dest.lat, lng: dest.lng };
    const rep = rg && okLL(rg.lat, rg.lng) ? { lat: rg.lat, lng: rg.lng } : null;
    const poner = (marca, p, icono) => { if (!p) { if (marca) mapa.removeLayer(marca); return null; } if (!marca) return L.marker([p.lat, p.lng], { icon: icono, interactive: false }).addTo(mapa); marca.setLatLng([p.lat, p.lng]); return marca; };
    marcaCli = poner(marcaCli, cli, iconoPin("cli", d.pedido && d.pedido.modo === "envia" ? "🏠" : "👤"));
    marcaRep = poner(marcaRep, rep, iconoPin("rep", "🛵"));
    if (cli && rep) {
      if (!linea) linea = L.polyline([[cli.lat, cli.lng], [rep.lat, rep.lng]], { color: "#0A86C9", weight: 3, dashArray: "6 8" }).addTo(mapa);
      else linea.setLatLngs([[cli.lat, cli.lng], [rep.lat, rep.lng]]);
    } else if (linea) { mapa.removeLayer(linea); linea = null; }
    const partes = [];
    partes.push(cli ? "👤 Cliente " + (vivoCli ? "en vivo (" + hace(cg.ts) + ")" : "· punto del pedido") : "👤 Cliente sin ubicación");
    partes.push(rep ? "🛵 Repartidor (" + hace(rg.ts) + ")" : "🛵 Repartidor sin señal");
    if (cli && rep) { const m = distanciaM(cli, rep); partes.push("📏 " + (m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km")); }
    g("saMapaInfo").textContent = partes.join(" · ");
    if (forzar || !encuadrado) {
      const pts = [cli, rep].filter(Boolean).map((p) => [p.lat, p.lng]);
      if (pts.length === 2) { mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 17 }); encuadrado = true; }
      else if (pts.length === 1) mapa.setView(pts[0], 16);
    }
  }
  function enlazar() {
    const botones = document.querySelectorAll(".tabs button");
    botones.forEach((b) => b.addEventListener("click", () => {
      const panel = g(PANEL);
      if (!panel) return;
      if (b.dataset.tab === PANEL) {
        botones.forEach((x) => {
          x.classList.toggle("activa", x === b);
          const p = x === b ? null : g(x.dataset.tab);
          if (p) p.classList.add("oculto");
        });
        panel.classList.remove("oculto");
        pintar();
      } else panel.classList.add("oculto");
    }));
    g("saFiltros").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      filtro = b.dataset.f;
      g("saFiltros").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      pintar();
    });
    g("saFecha").addEventListener("change", () => { fecha = g("saFecha").value || ""; pintar(); });
    g("saFechaLimpiar").addEventListener("click", () => { fecha = ""; g("saFecha").value = ""; pintar(); });
    g("saSelTodas").addEventListener("change", () => {
      const finV = visibles().filter((k) => fin(lista[k]));
      finV.forEach((k) => { if (g("saSelTodas").checked) sel.add(k); else sel.delete(k); });
      pintar();
    });
    g("saBorrarSel").addEventListener("click", () => borrar([...sel]));
    g("saBorrarFecha").addEventListener("click", () => { if (fecha) borrar(visibles().filter((k) => fin(lista[k]))); });
    g("saBorrarUno").addEventListener("click", () => { if (visorId) borrar([visorId]); });
    g("saForzarEnt").addEventListener("click", () => { if (visorId) forzarEstadoSolicitud(visorId, "entregado"); });
    g("saForzarCanc").addEventListener("click", () => { if (visorId) forzarEstadoSolicitud(visorId, "cancelado"); });
    g("saMapaBtn").addEventListener("click", alternarMapa);
    g("saCerrar").addEventListener("click", cerrarVisor);
    g("modalSolicitud").addEventListener("click", (e) => { if (e.target === g("modalSolicitud")) cerrarVisor(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && visorId) cerrarVisor(); });
    setInterval(() => { if (visorId) actualizarMapa(false); }, 10000);
  }
  if (g(PANEL)) {
    enlazar();
    if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) iniciar(); else detener(); });
  }
  return { iniciar, detener, forzarEstadoSolicitud };
})();
