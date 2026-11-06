/* ============================================================
   REPARTIDOR INVITADO (Función 2)
   Abre con invitado.html?t=TOKEN → pide solo el nombre → mapa de ruta + chat con el cliente
   + botones Retirado / Entregado. Todo en tiempo real con ordenes/{token}.

   FASE 1 · cambios aplicados:
     · Vista previa en vEntrada: se dibuja un mini-mapa con los puntos de retiro
       y entrega. Si el dispositivo concede GPS, se traza automáticamente la ruta
       al primer retiro y se muestra la distancia (km/m) en #infoEntrada.
     · El mapa de vista previa se destruye al entrar al flujo de trabajo (vApp).
   ============================================================ */
(() => {
  const O = Ordenes, esc = O.esc, TS = O.TS, $ = (id) => document.getElementById(id);
  const db = APP.database(), auth = APP.auth();
  const t = new URLSearchParams(location.search).get("t") || "";
  const uid = O.uidInvitado(t);
  const claveLocal = "invitado_" + t;

  let pedido = null, refPedido = null;
  let orden = null, nombre = "", mapa = null, marcaYo = null, pinsRetiro = [], pinEntrega = null, pinGuia = null, linea = null;
  let pos = null, ultEscritura = 0, watchId = null, wakeLock = null, refOrden = null, refChat = null, refVigia = null, refChatAdm = null, aceptando = false;
  const RA = { chats: "chatsInvitado", resumen: "chatsInvitadoResumen", leido: "leidosInvitado" };
  let chatAdmAbierto = false, sinLeerAdm = 0;
  let flechasCapa = null, ruta = { pts: null, pasos: null, idx: 0, dist: 0, dur: 0, origen: null, dest: null, en: 0 };
  let yaEncuadrado = false, chatAbierto = false, sinLeer = 0, terminado = false;
  let modoSeguir = "fitbounds";

  /* FASE 1 · mapa de vista previa en vEntrada */
  let mapaEntrada = null, capaEntrada = null;

  const vista = (id) => ["vCarga", "vEntrada", "vApp", "vFin", "vTomado"].forEach((v) => $(v).classList.toggle("oculto", v !== id));
  const msgCarga = (m) => { $("msgCarga").textContent = m; $("msgCarga").className = "estado error"; };

  function mostrarOcupado(on) {
    const chip = $("chipOcupado");
    if (chip) {
      chip.classList.toggle("oculto", !on);
      chip.textContent = on ? "🛵 OCUPADO · CON PEDIDO" : "";
    }
  }

  /* ---------- Arranque ---------- */
  const esMio = (o, guardado) => { const a = (o && o.asignacion) || {}; return a.authUid ? a.authUid === auth.currentUser.uid : !!guardado && a.nombre === guardado; };
  const tomadoPor = (o) => (o && o.asignacion && o.asignacion.nombre && ["asignado", "retirado"].includes(o.estado)) ? o.asignacion.nombre : null;
  function tomado(nom) {
    terminado = true;
    [refVigia, refOrden, refChat, refChatAdm].forEach((r) => { if (r) r.off(); });
    try { Solicitudes.detener(); } catch (_) {}
    mostrarOcupado(false);
    $("btnNuevosChats").classList.add("oculto");
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    $("txtTomado").textContent = `Este pedido ya fue tomado por ${nom}, muchas gracias.`;
    destruirMapaEntrada();
    vista("vTomado");
  }
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
    const guardado = localStorage.getItem(claveLocal);
    const otro = tomadoPor(orden);
    if (otro && !esMio(orden, guardado)) return tomado(otro);
    if (["entregado", "cancelado"].includes(orden.estado)) return final(orden.estado);
    if (otro) return entrar(orden.asignacion.nombre, true);
    $("resumenEntrada").innerHTML = resumenHtml(orden);
    $("inNombre").value = guardado || "";
    vista("vEntrada");
    /* FASE 1 · mini-mapa de vista previa con ruta sugerida (best-effort GPS) */
    setTimeout(iniciarMapaEntrada, 60);
    refVigia = db.ref("ordenes/" + t);
    refVigia.on("value", (s2) => {
      if (aceptando || terminado || !s2.exists()) return;
      const o2 = s2.val(), n = tomadoPor(o2);
      if (n && !esMio(o2, guardado)) tomado(n);
      else if (["entregado", "cancelado"].includes(o2.estado)) final(o2.estado);
    });
  }
  const listaParadas = (o) => O.paradas(o).map((p, k) => `<span>${p.retirado ? "✅" : "📦"} Retiro ${O.paradas(o).length > 1 ? k + 1 + ": " : ": "}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}</span>`).join("");
  const resumenHtml = (o) => `${O.precioHtml(o)}<b>Pedido ${esc(o.codigo)}</b>
    ${listaParadas(o)}<span>🏠 Entrega: ${esc((o.entrega && o.entrega.texto) || "—")}</span>
    ${o.paquete ? `<span>📝 ${esc(o.paquete)}</span>` : ""}`;

  $("btnEntrar").onclick = () => {
    const n = $("inNombre").value.trim().replace(/\s+/g, " ");
    if (n.length < 2) { $("msgEntrada").textContent = "Escribe tu nombre (mínimo 2 letras)."; $("msgEntrada").classList.remove("oculto"); return; }
    entrar(n, false);
  };

  /* FASE 1 · vista previa de la ruta antes de aceptar */
  function destruirMapaEntrada() {
    if (mapaEntrada) { try { mapaEntrada.remove(); } catch (_) {} }
    mapaEntrada = null; capaEntrada = null;
  }
  function iniciarMapaEntrada() {
    if (mapaEntrada) return;
    const cont = $("mapaEntrada");
    if (!cont || typeof L === "undefined" || !orden) return;
    try {
      mapaEntrada = L.map("mapaEntrada", { zoomControl: false, attributionControl: false }).setView([12.5700, -87.1311], 13);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapaEntrada);
      capaEntrada = L.layerGroup().addTo(mapaEntrada);
    } catch (e) { console.warn("[vEntrada] map:", e); return; }

    const ps = O.paradas(orden), puntos = [];
    ps.forEach((p, k) => {
      if (O.valido(p)) {
        L.marker([p.lat, p.lng], { icon: O.pinEtiqueta("retiro", ps.length > 1 ? String(k + 1) : "📦", p.texto || "Retiro", p.producto) }).addTo(capaEntrada);
        puntos.push([p.lat, p.lng]);
      }
    });
    if (O.valido(orden.entrega)) {
      L.marker([orden.entrega.lat, orden.entrega.lng], { icon: O.pinIcono("entrega", "🏠") }).addTo(capaEntrada);
      puntos.push([orden.entrega.lat, orden.entrega.lng]);
    }
    if (puntos.length === 1) mapaEntrada.setView(puntos[0], 15);
    else if (puntos.length > 1) mapaEntrada.fitBounds(L.latLngBounds(puntos), { padding: [30, 30], maxZoom: 16 });

    setTimeout(() => { try { mapaEntrada && mapaEntrada.invalidateSize(); } catch (_) {} }, 100);

    /* Best-effort: si el usuario ya dio permiso de ubicación, trazamos la ruta
       al primer retiro (o a la entrega si no hay retiro con coordenadas). */
    const info = $("infoEntrada");
    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition((gpsPos) => {
        if (!mapaEntrada || terminado) return;
        const c = gpsPos.coords, yo = { lat: c.latitude, lng: c.longitude };
        try { L.marker([yo.lat, yo.lng], { icon: O.pinIcono("", "🛵") }).addTo(capaEntrada); } catch (_) {}
        const destino = ps.find((p) => O.valido(p)) || orden.entrega;
        if (!destino || !O.valido(destino)) return;
        if (info) { info.style.display = "block"; info.classList.remove("oculto"); info.textContent = "⏳ Calculando ruta hasta el retiro…"; }
        O.rutaCalles(yo, destino).then((r) => {
          if (!r || !mapaEntrada) { if (info) info.textContent = "No se pudo calcular la ruta por calles."; return; }
          try { L.polyline([[yo.lat, yo.lng], ...r.pts], { color: "#0A86C9", weight: 5, opacity: .85, lineCap: "round" }).addTo(capaEntrada); } catch (_) {}
          const dist = r.dist >= 1000 ? (r.dist / 1000).toFixed(1) + " km" : Math.round(r.dist) + " m";
          const min = Math.max(1, Math.round((r.dur || 0) / 60));
          if (info) info.innerHTML = "📍 <b>" + dist + "</b> · ≈ " + min + " min hasta el primer retiro";
          try { mapaEntrada.fitBounds([[yo.lat, yo.lng], [destino.lat, destino.lng]], { padding: [30, 30], maxZoom: 16 }); } catch (_) {}
        }).catch(() => { if (info) info.textContent = "No se pudo calcular la ruta por calles."; });
      }, () => {
        if (info) { info.style.display = "block"; info.classList.remove("oculto"); info.textContent = "Permite la ubicación para ver la ruta hasta el retiro."; }
      }, { enableHighAccuracy: true, timeout: 8000, maximumAge: 30000 });
    }
  }

  async function entrar(n, reanudar) {
    nombre = n; aceptando = true;
    $("btnEntrar").disabled = true; $("msgEntrada").classList.add("oculto");
    const miUid = auth.currentUser.uid;
    if (!reanudar) {
      let res;
      try {
        res = await db.ref(`ordenes/${t}/asignacion`).transaction((cur) => {
          if (cur && cur.nombre && cur.authUid !== miUid) return;
          return { tipo: "invitado", nombre: n, authUid: miUid, unido: TS };
        }, undefined, false);
      } catch (e) { aceptando = false; $("btnEntrar").disabled = false; vista("vEntrada"); $("msgEntrada").textContent = "No se pudo aceptar: " + e.message; $("msgEntrada").classList.remove("oculto"); return; }
      if (!res.committed) {
        aceptando = false;
        const quien = (res.snapshot.val() || {}).nombre || "otro repartidor";
        return tomado(quien);
      }
    }
    if (refVigia) { refVigia.off(); refVigia = null; }
    localStorage.setItem(claveLocal, n);
    const primeraVez = !(orden.asignacion && orden.asignacion.unido);
    const upd = {
      [`ordenes/${t}/actualizado`]: TS,
      [`pedidos/${t}/estado`]: "en_ruta", [`pedidos/${t}/pedido`]: orden.codigo, [`pedidos/${t}/repartidorUid`]: uid,
      [`pedidos/${t}/repartidorNombre`]: n, [`pedidos/${t}/invitado`]: true
    };
    if (!orden.estado || orden.estado === "pendiente") upd[`ordenes/${t}/estado`] = "asignado";
    if (primeraVez) upd[`pedidos/${t}/inicio`] = TS;
    try { await db.ref().update(upd); }
    catch (e) { aceptando = false; $("btnEntrar").disabled = false; vista("vEntrada"); $("msgEntrada").textContent = "Aceptaste, pero no se pudo iniciar: " + e.message; $("msgEntrada").classList.remove("oculto"); return; }
    aceptando = false;
    /* FASE 1 · liberar el mapa de vista previa al pasar al flujo de trabajo */
    destruirMapaEntrada();
    mostrarOcupado(true);
    db.ref("ubicaciones/" + uid).onDisconnect().update({ enLinea: false, enViaje: false, conPedido: false, ts: TS });
    $("subTitulo").textContent = "Invitado · " + n;
    vista("vApp"); iniciarMapa(); escucharOrden(); escucharChat(); escucharChatAdm(); iniciarGPS();
    aplicarModo();
    iniciarSolicitudes();
  }

  function iniciarSolicitudes() {
    if (typeof Solicitudes === "undefined") return;
    $("btnNuevosChats").classList.remove("oculto");
    Solicitudes.init({
      db, tipo: "invitado",
      uid: () => uid, nombre: () => nombre || "Invitado", repartidorUid: () => uid,
      boton: "btnNuevosChats", badge: "badgeNuevosChats",
      codigo: () => "",
      instantanea: (f) => f,
      alNueva: () => {},
      alFacturada: () => {}
    });
  }

  /* ---------- Pedido en vivo ---------- */
  function escucharOrden() {
    refPedido = db.ref("pedidos/" + t);
    refPedido.on("value", (s) => { pedido = s.val(); if (orden && !terminado) $("precioGrande").innerHTML = O.cobroHtml(orden, pedido); }, () => {});
    refOrden = db.ref("ordenes/" + t);
    refOrden.on("value", (s) => {
      if (!s.exists()) return final("cancelado");
      orden = s.val();
      const a = orden.asignacion || {};
      if (a.authUid && a.authUid !== auth.currentUser.uid && !terminado) return tomado(a.nombre || "otro repartidor");
      if (["entregado", "cancelado"].includes(orden.estado) && !terminado) return final(orden.estado);
      pintarPedido();
    });
  }
  const destinoActual = () => {
    if (orden.guia && O.valido(orden.guia)) return { lat: orden.guia.lat, lng: orden.guia.lng, etiqueta: O.PUNTOS[orden.guia.punto] ? O.PUNTOS[orden.guia.punto].nombre : "Punto", texto: "Punto indicado por Brothers" };
    const d = O.destinoDe(orden);
    if (d.etiqueta === "Retiro" && d.total > 1) d.etiqueta = `Retiro ${d.idx + 1}/${d.total}`;
    return d;
  };
  function pintarPedido() {
    const d = destinoActual(), [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.pendiente;
    $("datosPedido").innerHTML = `<b>Pedido ${esc(orden.codigo)} · ${esc(orden.cliente || "")}</b>
      <span>${d.etiqueta === "Entrega" ? "🏠" : "📦"} Ahora: <b>${esc(d.etiqueta)}</b> — ${esc(d.texto || "sin dirección")}${d.producto ? " · <b>" + esc(d.producto) + "</b>" : ""}</span>
      ${O.paradas(orden).length > 1 ? "<small>Retiros del pedido:</small>" + listaParadas(orden) : ""}
      ${orden.paquete ? `<span>📝 ${esc(orden.paquete)}</span>` : ""}`;
    $("precioGrande").innerHTML = O.cobroHtml(orden, pedido);
    $("chipEstado").textContent = txt; $("chipEstado").className = "chip " + cls;
    const sig = O.siguienteRetiro(orden);
    $("btnRetirado").disabled = !sig;
    $("btnRetirado").textContent = sig ? `📦 Retirado${O.paradas(orden).length > 1 ? " (" + (sig.i + 1) + "/" + O.paradas(orden).length + ")" : ""}` : "📦 Todo retirado";
    $("btnEntregado").disabled = !!sig;
    pintarPuntos(); calcularRuta(true);
    if (modoSeguir === "fitbounds") setTimeout(encuadrarDinamico, 200);
  }

  /* ---------- Botones de estado ---------- */
  const pedirPago = (sig) => new Promise((resolve) => {
    const m = $("modalPago"), inp = $("pagoMonto"), msg = $("pagoMsg");
    $("pagoDetalle").textContent = [sig.p.producto, sig.p.texto].filter(Boolean).join(" · ") || "Este retiro";
    inp.value = sig.p.pagado != null ? sig.p.pagado : ""; msg.classList.add("oculto"); m.classList.remove("oculto");
    setTimeout(() => inp.focus(), 60);
    const cerrar = (val) => { m.classList.add("oculto"); $("btnPagoOk").onclick = null; $("btnPagoCancelar").onclick = null; inp.onkeydown = null; resolve(val); };
    $("btnPagoOk").onclick = () => {
      const raw = inp.value.trim().replace(",", "."), n = Number(raw);
      if (raw === "" || !Number.isFinite(n) || n < 0) { msg.textContent = "Escribe cuánto pagaste (0 si no pagaste nada)."; msg.classList.remove("oculto"); return; }
      cerrar(O.r2(n));
    };
    $("btnPagoCancelar").onclick = () => cerrar(null);
    inp.onkeydown = (e) => { if (e.key === "Enter") $("btnPagoOk").click(); };
  });
  async function cambiar(estado) {
    const sig = O.siguienteRetiro(orden);
    if (estado === "retirado" && !sig) return;
    let monto = null;
    if (estado === "retirado") { monto = await pedirPago(sig); if (monto === null) return; }
    else if (!confirm("¿Confirmas que el paquete fue ENTREGADO?")) return;
    try {
      if (estado === "retirado") await O.marcarRetiro(db, t, orden, sig.i, monto); else await O.marcar(db, t, estado, orden);
      await db.ref(`ordenes/${t}/guia`).remove().catch(() => {});
      if (estado === "entregado") {
        await db.ref("pedidos/" + t).update({ estado: "entregado", fin: TS, lat: null, lng: null, rumbo: null, velocidad: null, precision: null, destLat: null, destLng: null, distancia: null, cerca: null });
        await db.ref("ubicaciones/" + uid).remove().catch(() => {});
        final("entregado");
      }
    } catch (e) { alert("No se pudo actualizar el estado: " + e.message); }
  }
  $("btnMinPanel").onclick = () => {
    const min = $("panelInv").classList.toggle("min");
    $("detallesPanel").classList.toggle("oculto", min);
    $("btnMinPanel").setAttribute("aria-expanded", String(!min));
    $("txtMin").textContent = min ? "Ver detalles ▴" : "Ocultar detalles ▾";
    setTimeout(() => mapa && mapa.invalidateSize(), 80);
  };
  $("btnRetirado").onclick = () => cambiar("retirado");
  $("btnEntregado").onclick = () => cambiar("entregado");
  $("btnNavegar").onclick = () => {
    const d = destinoActual();
    const url = O.valido(d) ? `https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lng}` : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(d.texto || "")}`;
    window.open(url, "_blank");
  };

  function final(estado) {
    terminado = true;
    mostrarOcupado(false);
    try { Solicitudes.detener(); } catch (_) {}
    if (refOrden) refOrden.off(); if (refPedido) refPedido.off(); if (refChat) refChat.off(); if (refChatAdm) refChatAdm.off();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    try { wakeLock && wakeLock.release(); } catch (_) {}
    db.ref("ubicaciones/" + uid).onDisconnect().cancel();
    destruirMapaEntrada();
    $("finTitulo").textContent = estado === "entregado" ? "¡Entrega confirmada!" : "Pedido cancelado";
    $("finTxt").textContent = estado === "entregado" ? "Gracias por tu ayuda. Ya puedes cerrar esta página." : "El administrador canceló este pedido. Ya puedes cerrar esta página.";
    localStorage.removeItem(claveLocal);
    vista("vFin");
  }

  /* ---------- Mapa y ruta ---------- */
  function iniciarMapa() {
    mapa = L.map("mapaInv", { zoomControl: false }).setView([12.5700, -87.1311], 14);
    L.control.zoom({ position: "bottomright" }).addTo(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    linea = L.polyline([], { color: "#0A86C9", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
    flechasCapa = L.layerGroup().addTo(mapa);
    setTimeout(() => { mapa.invalidateSize(); pintarPuntos(); encuadrar(); }, 80);
  }
  function pintarPuntos() {
    if (!mapa || !orden) return;
    const poner = (actual, p, icono) => {
      if (!O.valido(p)) { if (actual) mapa.removeLayer(actual); return null; }
      if (!actual) return L.marker([p.lat, p.lng], { icon: icono, zIndexOffset: 300 }).addTo(mapa);
      actual.setLatLng([p.lat, p.lng]); actual.setIcon(icono); return actual;
    };
    const ps = O.paradas(orden);
    while (pinsRetiro.length > ps.length) { const x = pinsRetiro.pop(); if (x) mapa.removeLayer(x); }
    ps.forEach((p, k) => {
      const num = ps.length > 1 ? String(k + 1) : "📦";
      pinsRetiro[k] = poner(pinsRetiro[k], p, p.retirado ? O.pinIcono("retiro", "✅") : O.pinEtiqueta("retiro", num, p.texto || "Retiro", p.producto));
    });
    pinEntrega = poner(pinEntrega, orden.entrega, O.pinIcono("entrega", "🏠"));
    pinGuia = poner(pinGuia, orden.guia, O.pinIcono(orden.guia && orden.guia.punto === "entrega" ? "entrega" : "retiro", "📍"));
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
  function encuadrarDinamico() {
    if (!mapa || !pos || modoSeguir !== "fitbounds") return;
    const d = orden && destinoActual();
    const pts = [[pos.lat, pos.lng]];
    if (d && O.valido(d)) pts.push([d.lat, d.lng]);
    if (pts.length === 2) {
      const v = mapa.getBounds();
      const in1 = v.contains(pts[0]);
      const in2 = v.contains(pts[1]);
      if (in1 && in2) return;
      mapa.fitBounds(L.latLngBounds(pts), { padding: [60, 60], maxZoom: 17, animate: true, duration: 0.6 });
    } else if (pts.length === 1) {
      mapa.setView(pts[0], Math.max(mapa.getZoom(), 15));
    }
  }
  function centrarMoto() {
    if (!mapa || !pos) return;
    mapa.setView([pos.lat, pos.lng], 17, { animate: true, duration: 0.5 });
  }
  function aplicarModo() {
    $("btnSeguir").classList.toggle("on", modoSeguir === "navegacion");
    $("btnSeguir").setAttribute("aria-pressed", String(modoSeguir === "navegacion"));
  }
  $("btnSeguir").onclick = () => {
    modoSeguir = "navegacion";
    aplicarModo();
    centrarMoto();
  };
  $("btnVerTodo").onclick = () => {
    modoSeguir = "fitbounds";
    aplicarModo();
    encuadrar();
  };
  aplicarModo();

  /* Ruta SOLO por calles. Mientras llega no se dibuja nada: jamás una línea recta. */
  async function calcularRuta(forzar) {
    const d = orden && destinoActual();
    if (!d || !O.valido(d)) { limpiarRuta(); return banner(null, "Este punto no tiene ubicación exacta. Usa 🧭 Abrir navegación."); }
    if (!pos) return banner(null, "Esperando tu ubicación para trazar la ruta…");
    const cambioDest = !ruta.dest || O.distM(ruta.dest, d) > 20, movido = !ruta.origen || O.distM(ruta.origen, pos) > 60;
    if (cambioDest && ruta.pts) limpiarRuta();
    if (!forzar && !cambioDest && !movido) return avanzarBanner();
    if (Date.now() - ruta.en < (cambioDest ? 800 : 15000)) return avanzarBanner();
    ruta.en = Date.now();
    if (!ruta.pts) banner(null, `Calculando ruta por calles hasta ${d.etiqueta}…`);
    const r = await O.rutaCalles({ lat: pos.lat, lng: pos.lng }, { lat: d.lat, lng: d.lng });
    if (!r) { ruta.en = Date.now() - 12000; return banner(null, "No se pudo calcular la ruta por calles. Reintentando…"); }
    Object.assign(ruta, { pts: r.pts, pasos: r.pasos, idx: 0, dist: r.dist, dur: r.dur, origen: { lat: pos.lat, lng: pos.lng }, dest: { lat: d.lat, lng: d.lng }, en: Date.now() });
    linea.setLatLngs([[pos.lat, pos.lng], ...r.pts]); O.flechas(r.pts, flechasCapa, "#0A86C9");
    avanzarBanner();
  }
  function limpiarRuta() { ruta = { pts: null, pasos: null, idx: 0, dist: 0, dur: 0, origen: null, dest: null, en: ruta.en }; linea.setLatLngs([]); flechasCapa.clearLayers(); }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");

  function banner(paso, aviso) {
    const b = $("bannerRuta"); b.classList.remove("oculto");
    if (!paso && aviso) { b.innerHTML = `<span class="ir-ic">🧭</span><span class="ir-txt">${esc(aviso)}</span>`; return; }
    if (!paso) {
      b.innerHTML = `<span class="ir-ic">🧭</span><span class="ir-txt"><b>${fmtDist(ruta.dist)}</b><span>≈ ${Math.max(1, Math.round(ruta.dur / 60))} min · ${esc(destinoActual().etiqueta)}</span></span>`;
      return;
    }
    const info = O.textoPaso(paso);
    b.innerHTML = `<span class="ir-ic">${info[0] || "🧭"}</span><span class="ir-txt"><b>${esc(info[1] || "")}</b><span>${fmtDist(ruta.dist)} · ≈ ${Math.max(1, Math.round(ruta.dur / 60))} min · ${esc(destinoActual().etiqueta)}</span></span>`;
  }
  function avanzarBanner() {
    if (!ruta.pasos || !pos) return;
    while (ruta.idx < ruta.pasos.length - 1 && ruta.pasos[ruta.idx] && ruta.pasos[ruta.idx].loc && O.distM(pos, ruta.pasos[ruta.idx].loc) < 30) ruta.idx++;
    banner(ruta.pasos[ruta.idx]);
    if (ruta.pts) linea.setLatLngs([[pos.lat, pos.lng], ...ruta.pts]);
  }

  /* ---------- GPS ---------- */
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
    if (primera) {
      yaEncuadrado = false;
      encuadrar();
      calcularRuta(true);
    } else {
      calcularRuta(false);
      if (modoSeguir === "fitbounds") encuadrarDinamico();
      else if (modoSeguir === "navegacion") centrarMoto();
    }
    const ahora = Date.now(); if (ahora - ultEscritura < 4000 || terminado) return; ultEscritura = ahora;
    const base = { lat: pos.lat, lng: pos.lng, precision: Math.round(c.accuracy || 0), rumbo: Number.isFinite(c.heading) ? c.heading : null, velocidad: Number.isFinite(c.speed) ? c.speed : null, ts: TS };
    db.ref("ubicaciones/" + uid).set(Object.assign({ enLinea: true, enViaje: true, conPedido: true, usuario: nombre + " (invitado)" }, base)).catch(() => {});
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
        O.hablar("Mensaje del cliente: " + (m.texto || "te envió una foto"));
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

  /* ---------- Chat con el administrador ---------- */
  function burbujaAdm(m) {
    const d = document.createElement("div");
    d.className = "pd-msg" + (m.de === "repartidor" ? " yo" : ""); d.textContent = m.texto || (m.foto ? "📷 Foto" : "");
    $("msgsAdm").appendChild(d); $("msgsAdm").scrollTop = $("msgsAdm").scrollHeight;
  }
  function marcarLeidoAdm() { if (chatAdmAbierto && document.visibilityState === "visible") db.ref(`${RA.leido}/${t}/repartidor`).set(TS).catch(() => {}); }
  function escucharChatAdm() {
    let cargado = false;
    refChatAdm = db.ref(`${RA.chats}/${t}`).limitToLast(50);
    refChatAdm.on("child_added", (s) => {
      const m = s.val(); if (!m) return; burbujaAdm(m);
      if (m.de === "admin") marcarLeidoAdm();
      if (cargado && m.de === "admin") {
        navigator.vibrate && navigator.vibrate(200);
        O.hablar("Mensaje de Brothers: " + (m.texto || "te envió una foto"));
        if (!chatAdmAbierto) { sinLeerAdm++; $("chatAdmBadge").textContent = sinLeerAdm; $("chatAdmBadge").classList.remove("oculto"); }
      }
    });
    refChatAdm.on("child_removed", () => { $("msgsAdm").innerHTML = ""; db.ref(`${RA.chats}/${t}`).limitToLast(50).once("value").then((s) => s.forEach((c) => burbujaAdm(c.val()))); });
    refChatAdm.once("value", () => { cargado = true; });
  }
  $("btnChatAdm").onclick = () => {
    chatAdmAbierto = !chatAdmAbierto; $("chatAdmBox").classList.toggle("oculto", !chatAdmAbierto);
    if (chatAdmAbierto) { sinLeerAdm = 0; $("chatAdmBadge").classList.add("oculto"); $("msgsAdm").scrollTop = $("msgsAdm").scrollHeight; marcarLeidoAdm(); setTimeout(() => mapa && mapa.invalidateSize(), 50); }
  };
  $("formChatAdm").onsubmit = async (e) => {
    e.preventDefault();
    const texto = $("chatAdmTexto").value.trim().slice(0, 600); if (!texto) return;
    $("chatAdmTexto").value = "";
    try {
      const id = db.ref(`${RA.chats}/${t}`).push().key;
      await db.ref().update({
        [`${RA.chats}/${t}/${id}`]: { de: "repartidor", texto, ts: TS },
        [`${RA.resumen}/${t}`]: { pedido: String(orden.codigo || "").slice(0, 40), repartidor: nombre.slice(0, 40), ultimo: texto.slice(0, 100), ultimoDe: "repartidor", ts: TS }
      });
    } catch (err) { alert("No se pudo enviar: " + err.message); $("chatAdmTexto").value = texto; }
  };

  /* ---------- Fix del teclado táctil ---------- */
  function ajustarViewportInv() {
    const vv = window.visualViewport;
    if (!vv) return;
    const r = document.documentElement.style;
    r.setProperty("--vvh", Math.round(vv.height) + "px");
    r.setProperty("--vvt", Math.round(vv.offsetTop) + "px");
    const activo = document.activeElement;
    if (activo && (activo.tagName === "INPUT" || activo.tagName === "TEXTAREA")) {
      setTimeout(() => activo.scrollIntoView({ block: "nearest" }), 60);
    }
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", ajustarViewportInv);
    window.visualViewport.addEventListener("scroll", ajustarViewportInv);
    ajustarViewportInv();
  }

  arrancar();
})();
