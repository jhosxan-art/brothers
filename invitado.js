/* ============================================================
   REPARTIDOR INVITADO (Función 2)
   Abre con invitado.html?t=TOKEN → pide solo el nombre → mapa de ruta + chat con el cliente
   + botones Retirado / Entregado. Todo en tiempo real con ordenes/{token}.
   ============================================================ */
(() => {
  const O = Ordenes, esc = O.esc, TS = O.TS, $ = (id) => document.getElementById(id);
  const db = APP.database(), auth = APP.auth();
  const t = new URLSearchParams(location.search).get("t") || "";
  const uid = O.uidInvitado(t);
  const claveLocal = "invitado_" + t;

  let orden = null, nombre = "", mapa = null, marcaYo = null, pinRetiro = null, pinEntrega = null, pinGuia = null, linea = null;
  let pos = null, ultEscritura = 0, watchId = null, wakeLock = null, refOrden = null, refChat = null;
  let flechasCapa = null, ruta = { pts: null, pasos: null, idx: 0, dist: 0, dur: 0, origen: null, dest: null, en: 0 }, yaEncuadrado = false, chatAbierto = false, sinLeer = 0, terminado = false;
  const vista = (id) => ["vCarga", "vEntrada", "vApp", "vFin"].forEach((v) => $(v).classList.toggle("oculto", v !== id));
  const msgCarga = (m) => { $("msgCarga").textContent = m; $("msgCarga").className = "estado error"; };

  /* ---------- Arranque ---------- */
  async function arrancar() {
    if (!/^[a-z0-9]{8,32}$/i.test(t)) return msgCarga("Este enlace no es válido. Pide uno nuevo al administrador.");
    try { await auth.signInAnonymously(); }
    catch (e) {
      const off = e.code === "auth/operation-not-allowed" || e.code === "auth/admin-restricted-operation";
      return msgCarga(off ? "Falta activar el inicio de sesión anónimo en Firebase (Authentication → Sign-in method → Anonymous)." : "No se pudo iniciar la sesión de invitado: " + (e.code || e.message));
    }
    try {
      const s = await db.ref("ordenes/" + t).once("value");
      if (!s.exists()) return msgCarga("Este pedido no existe o fue eliminado.");
      orden = s.val();
    } catch (e) { return msgCarga("No se pudo abrir el pedido: " + e.message); }
    if (["entregado", "cancelado"].includes(orden.estado)) return final(orden.estado);
    const guardado = localStorage.getItem(claveLocal);
    $("resumenEntrada").innerHTML = resumenHtml(orden);
    $("inNombre").value = guardado || (orden.asignacion && orden.asignacion.nombre) || "";
    if (guardado) return entrar(guardado);   // mismo aparato: entra directo
    vista("vEntrada");
  }
  const resumenHtml = (o) => `<b>Pedido ${esc(o.codigo)}</b>
    <span>📦 Retiro: ${esc((o.retiro && o.retiro.texto) || "—")}</span><span>🏠 Entrega: ${esc((o.entrega && o.entrega.texto) || "—")}</span>
    ${o.paquete ? `<span>📝 ${esc(o.paquete)}</span>` : ""}`;

  $("btnEntrar").onclick = () => {
    const n = $("inNombre").value.trim().replace(/\s+/g, " ");
    if (n.length < 2) { $("msgEntrada").textContent = "Escribe tu nombre (mínimo 2 letras)."; $("msgEntrada").classList.remove("oculto"); return; }
    entrar(n);
  };

  async function entrar(n) {
    nombre = n; localStorage.setItem(claveLocal, n);
    $("btnEntrar").disabled = true;
    const primeraVez = !(orden.asignacion && orden.asignacion.unido);
    const upd = {
      [`ordenes/${t}/asignacion/tipo`]: "invitado", [`ordenes/${t}/asignacion/nombre`]: n, [`ordenes/${t}/asignacion/unido`]: TS,
      [`ordenes/${t}/actualizado`]: TS,
      [`pedidos/${t}/estado`]: "en_ruta", [`pedidos/${t}/pedido`]: orden.codigo, [`pedidos/${t}/repartidorUid`]: uid,
      [`pedidos/${t}/repartidorNombre`]: n, [`pedidos/${t}/invitado`]: true
    };
    if (orden.estado === "pendiente") upd[`ordenes/${t}/estado`] = "asignado";
    if (primeraVez) upd[`pedidos/${t}/inicio`] = TS;
    try { await db.ref().update(upd); }
    catch (e) { $("btnEntrar").disabled = false; vista("vEntrada"); $("msgEntrada").textContent = "No se pudo entrar: " + e.message; $("msgEntrada").classList.remove("oculto"); return; }
    db.ref("ubicaciones/" + uid).onDisconnect().update({ enLinea: false, enViaje: false, ts: TS });
    $("subTitulo").textContent = "Invitado · " + n;
    vista("vApp"); iniciarMapa(); escucharOrden(); escucharChat(); iniciarGPS();
  }

  /* ---------- Pedido en vivo ---------- */
  function escucharOrden() {
    refOrden = db.ref("ordenes/" + t);
    refOrden.on("value", (s) => {
      if (!s.exists()) return final("cancelado");
      orden = s.val();
      if (["entregado", "cancelado"].includes(orden.estado) && !terminado) return final(orden.estado);
      pintarPedido();
    });
  }
  const destinoActual = () => {
    if (orden.guia && O.valido(orden.guia)) return { lat: orden.guia.lat, lng: orden.guia.lng, etiqueta: O.PUNTOS[orden.guia.punto] ? O.PUNTOS[orden.guia.punto].nombre : "Punto", texto: "Punto indicado por Brothers" };
    const p = orden.estado === "retirado" ? orden.entrega : orden.retiro;
    return Object.assign({ etiqueta: orden.estado === "retirado" ? "Entrega" : "Retiro" }, p || {});
  };
  function pintarPedido() {
    const d = destinoActual(), [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.pendiente;
    $("datosPedido").innerHTML = `<b>Pedido ${esc(orden.codigo)} · ${esc(orden.cliente || "")}</b>
      <span>${d.etiqueta === "Entrega" ? "🏠" : "📦"} Ahora: <b>${esc(d.etiqueta)}</b> — ${esc(d.texto || "sin dirección")}</span>
      ${orden.paquete ? `<span>📝 ${esc(orden.paquete)}</span>` : ""}`;
    $("chipEstado").textContent = txt; $("chipEstado").className = "chip " + cls;
    $("btnRetirado").disabled = orden.estado === "retirado";
    $("btnEntregado").disabled = orden.estado !== "retirado";
    pintarPuntos(); calcularRuta(true);
  }

  /* ---------- Botones de estado ---------- */
  async function cambiar(estado) {
    const etiqueta = estado === "retirado" ? "RETIRADO" : "ENTREGADO";
    if (!confirm(`¿Confirmas que el paquete fue ${etiqueta}?`)) return;
    try {
      await O.marcar(db, t, estado, orden);
      await db.ref(`ordenes/${t}/guia`).remove().catch(() => {});   // el punto rápido del admin ya cumplió su función
      if (estado === "entregado") {
        await db.ref("pedidos/" + t).update({ estado: "entregado", fin: TS, lat: null, lng: null, rumbo: null, velocidad: null, precision: null, destLat: null, destLng: null, distancia: null, cerca: null });
        await db.ref("ubicaciones/" + uid).remove().catch(() => {});
        final("entregado");
      }
    } catch (e) { alert("No se pudo actualizar el estado: " + e.message); }
  }
  $("btnRetirado").onclick = () => cambiar("retirado");
  $("btnEntregado").onclick = () => cambiar("entregado");
  $("btnNavegar").onclick = () => {
    const d = destinoActual();
    const url = O.valido(d) ? `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.texto || "")}`;
    window.open(url, "_blank");
  };

  function final(estado) {
    terminado = true;
    if (refOrden) refOrden.off(); if (refChat) refChat.off();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    try { wakeLock && wakeLock.release(); } catch (_) {}
    db.ref("ubicaciones/" + uid).onDisconnect().cancel();
    $("finTitulo").textContent = estado === "entregado" ? "¡Entrega confirmada!" : "Pedido cancelado";
    $("finTxt").textContent = estado === "entregado" ? "Gracias por tu ayuda. Ya puedes cerrar esta página." : "El administrador canceló este pedido. Ya puedes cerrar esta página.";
    localStorage.removeItem(claveLocal);
    vista("vFin");
  }

  /* ---------- Mapa y ruta ---------- */
  function iniciarMapa() {
    mapa = L.map("mapaInv", { zoomControl: false }).setView([-12.0464, -77.0428], 14);
    L.control.zoom({ position: "bottomright" }).addTo(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    linea = L.polyline([], { color: "#0A86C9", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
    flechasCapa = L.layerGroup().addTo(mapa);
    setTimeout(() => { mapa.invalidateSize(); pintarPuntos(); encuadrar(); }, 80);
  }
  function pintarPuntos() {
    if (!mapa || !orden) return;
    const poner = (actual, p, clase, emoji) => {
      if (!O.valido(p)) { if (actual) mapa.removeLayer(actual); return null; }
      if (!actual) return L.marker([p.lat, p.lng], { icon: O.pinIcono(clase, emoji) }).addTo(mapa);
      actual.setLatLng([p.lat, p.lng]); return actual;
    };
    pinRetiro = poner(pinRetiro, orden.retiro, "retiro", "📦");
    pinEntrega = poner(pinEntrega, orden.entrega, "entrega", "🏠");
    pinGuia = poner(pinGuia, orden.guia, orden.guia && orden.guia.punto === "entrega" ? "entrega" : "retiro", "📍");
    if (!yaEncuadrado) encuadrar();
  }
  function encuadrar() {
    if (!mapa) return;
    const pts = [];
    if (pos) pts.push([pos.lat, pos.lng]);
    const d = orden && destinoActual(); if (d && O.valido(d)) pts.push([d.lat, d.lng]);
    if (pts.length > 1) { mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 17 }); yaEncuadrado = true; }
    else if (pts.length === 1) { mapa.setView(pts[0], 16); yaEncuadrado = !!pos; }
  }
  /* Ruta SOLO por calles (respeta sentidos). Mientras llega no se dibuja nada: jamás una línea recta. */
  async function calcularRuta(forzar) {
    const d = orden && destinoActual();
    if (!d || !O.valido(d)) { limpiarRuta(); return banner(null, "Este punto no tiene ubicación exacta. Usa 🧭 Abrir navegación."); }
    if (!pos) return banner(null, "Esperando tu ubicación para trazar la ruta…");
    const cambioDest = !ruta.dest || O.distM(ruta.dest, d) > 20, movido = !ruta.origen || O.distM(ruta.origen, pos) > 60;
    if (cambioDest && ruta.pts) limpiarRuta();   // destino nuevo: se quita la ruta vieja
    if (!forzar && !cambioDest && !movido) return avanzarBanner();
    if (Date.now() - ruta.en < (cambioDest ? 800 : 15000)) return avanzarBanner();
    ruta.en = Date.now();
    if (!ruta.pts) banner(null, `Calculando ruta por calles hasta ${d.etiqueta}…`);
    const r = await O.rutaCalles({ lat: pos.lat, lng: pos.lng }, { lat: d.lat, lng: d.lng });
    if (!r) { ruta.en = Date.now() - 12000; return banner(null, "No se pudo calcular la ruta por calles. Reintentando…"); }   // reintenta en ~3 s
    Object.assign(ruta, { pts: r.pts, pasos: r.pasos, idx: Math.min(1, r.pasos.length - 1), dist: r.dist, dur: r.dur, origen: { lat: pos.lat, lng: pos.lng }, dest: { lat: d.lat, lng: d.lng }, en: Date.now() });
    linea.setLatLngs([[pos.lat, pos.lng], ...r.pts]); O.flechas(r.pts, flechasCapa, "#0A86C9");
    avanzarBanner();
  }
  function limpiarRuta() { ruta = { pts: null, pasos: null, idx: 0, dist: 0, dur: 0, origen: null, dest: null, en: ruta.en }; linea.setLatLngs([]); flechasCapa.clearLayers(); }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");
  function banner(paso, aviso) {
    const b = $("bannerRuta"); b.classList.remove("oculto");
    if (!paso) { b.innerHTML = `<div class="br-fila"><span class="br-ic">🧭</span><div class="br-txt"><b>${esc(aviso)}</b></div></div>`; return; }
    const [ic, tx] = O.textoPaso(paso), aqui = pos, dm = Math.round(O.distM(aqui, paso.loc)), calles = O.callesDe(ruta.pasos);
    b.innerHTML = `<div class="br-fila"><span class="br-ic">${ic}</span><div class="br-txt"><b>${esc(tx)}</b><small>${paso.tipo === "arrive" ? "" : "en " + fmtDist(dm) + " · "}${esc(destinoActual().etiqueta)}</small></div></div>
      <small>${fmtDist(ruta.dist)} · ≈ ${Math.max(1, Math.round(ruta.dur / 60))} min${calles ? " · Vía: " + esc(calles) : ""}</small>`;
  }
  function avanzarBanner() {   // pasa al siguiente giro cuando ya estás encima del anterior
    if (!ruta.pasos || !pos) return;
    while (ruta.idx < ruta.pasos.length - 1 && O.distM(pos, ruta.pasos[ruta.idx].loc) < 30) ruta.idx++;
    banner(ruta.pasos[ruta.idx]);
    if (ruta.pts) linea.setLatLngs([[pos.lat, pos.lng], ...ruta.pts]);
  }

  /* ---------- GPS: se comparte con el admin (mapa) y el cliente (seguimiento) ---------- */
  async function iniciarGPS() {
    if (!("geolocation" in navigator)) return ($("estadoGps").textContent = "Este dispositivo no tiene GPS.");
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {}
    watchId = navigator.geolocation.watchPosition((p) => alPosicion(p.coords),
      (err) => { $("estadoGps").textContent = err.code === 1 ? "Permiso de ubicación denegado. Actívalo para que el cliente te siga." : "Error GPS: " + err.message; },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    document.addEventListener("visibilitychange", async () => { if (document.visibilityState === "visible" && !terminado) { try { wakeLock = await navigator.wakeLock?.request("screen"); } catch (_) {} mapa.invalidateSize(); } });
  }
  function alPosicion(c) {
    const primera = !pos;
    pos = { lat: c.latitude, lng: c.longitude };
    if (!marcaYo) marcaYo = L.marker([pos.lat, pos.lng], { icon: (typeof iconoRepartidorNombre === "function" ? iconoRepartidorNombre(nombre) : O.pinIcono("", "🛵")), zIndexOffset: 1000 }).addTo(mapa);
    else marcaYo.setLatLng([pos.lat, pos.lng]);
    if (primera) { yaEncuadrado = false; encuadrar(); }
    calcularRuta(false);
    const ahora = Date.now(); if (ahora - ultEscritura < 4000 || terminado) return; ultEscritura = ahora;
    const base = { lat: pos.lat, lng: pos.lng, precision: Math.round(c.accuracy || 0), rumbo: Number.isFinite(c.heading) ? c.heading : null, velocidad: Number.isFinite(c.speed) ? c.speed : null, ts: TS };
    db.ref("ubicaciones/" + uid).set(Object.assign({ enLinea: true, enViaje: true, usuario: nombre + " (invitado)" }, base)).catch(() => {});
    const ped = Object.assign({}, base), ent = orden && orden.entrega;
    if (O.valido(ent)) {
      ped.destLat = ent.lat; ped.destLng = ent.lng;
      const dist = Math.round(O.distM(pos, ent)); ped.distancia = dist;
      if (orden.estado === "retirado") ped.cerca = dist <= 200;
    }
    db.ref("pedidos/" + t).update(ped).catch(() => {});
    if (!terminado) $("estadoGps").textContent = $("estadoGps").textContent.includes("·") ? $("estadoGps").textContent : `Compartiendo ubicación · ±${base.precision} m`;
  }

  /* ---------- Chat en vivo con el cliente ---------- */
  function burbuja(m) {
    const d = document.createElement("div");
    d.className = "pd-msg" + (m.de === "repartidor" ? " yo" : ""); d.textContent = m.texto || (m.foto ? "📷 Foto" : "");
    $("msgs").appendChild(d); $("msgs").scrollTop = $("msgs").scrollHeight;
  }
  function escucharChat() {
    let cargado = false;
    refChat = db.ref("chats/" + t).limitToLast(50);
    refChat.on("child_added", (s) => {
      const m = s.val(); if (!m) return; burbuja(m);
      if (cargado && m.de === "cliente") {
        navigator.vibrate && navigator.vibrate(200);
        if (!chatAbierto) { sinLeer++; $("chatBadge").textContent = sinLeer; $("chatBadge").classList.remove("oculto"); }
      }
    });
    refChat.once("value", () => { cargado = true; });
  }
  $("btnChat").onclick = () => {
    chatAbierto = !chatAbierto; $("chatBox").classList.toggle("oculto", !chatAbierto);
    if (chatAbierto) { sinLeer = 0; $("chatBadge").classList.add("oculto"); $("msgs").scrollTop = $("msgs").scrollHeight; setTimeout(() => mapa && mapa.invalidateSize(), 50); }
  };
  $("formChat").onsubmit = async (e) => {
    e.preventDefault();
    const texto = $("chatTexto").value.trim().slice(0, 600); if (!texto) return;
    $("chatTexto").value = "";
    try {
      await db.ref("chats/" + t).push({ de: "repartidor", texto, ts: TS, nombre });
      await db.ref("chatsResumen/" + t).set({ pedido: orden.codigo, repartidor: nombre, ultimo: texto.slice(0, 100), ultimoDe: "repartidor", ts: TS });
    } catch (err) { alert("No se pudo enviar: " + err.message); $("chatTexto").value = texto; }
  };

  arrancar();
})();
