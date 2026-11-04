/* ============================================================
   REPARTIDOR INVITADO (Función 2)
   Abre con invitado.html?t=TOKEN → pide solo el nombre → mapa de ruta + chat con el cliente
   + botones Retirado / Entregado. Todo en tiempo real con ordenes/{token}.
   COBRO AL RETIRAR: al pulsar "Retirado" se interrumpe la acción con un modal que pide el valor pagado al restaurante.
   Se guarda en ordenes/{token}/pagos/{n} (por retiro) y ordenes/{token}/pagadoRestaurante (suma), y en
   pedidos/{token}/pagadoRestaurante: con eso rastreo.js le muestra al cliente UN solo renglón "Total a Pagar" (valor pagado + delivery).
   NAVEGACIÓN: misma cámara inteligente que el repartidor registrado (Camara): zoom dinámico por proximidad al destino, mapa que rota
   hacia donde avanza (bearing de las dos últimas coordenadas), repartidor fijo en el tercio inferior e ícono que escala con el zoom.
   ============================================================ */
(() => {
  const O = Ordenes, esc = O.esc, TS = O.TS, $ = (id) => document.getElementById(id);
  const db = APP.database(), auth = APP.auth();
  const t = new URLSearchParams(location.search).get("t") || "";
  const uid = O.uidInvitado(t);
  const claveLocal = "invitado_" + t;
  const ES_INVITADO = O.esInvitadoUid(uid);   // este módulo solo lo usa el repartidor invitado (uid "inv_…"): el cobro al retirar aplica solo aquí

  let orden = null, nombre = "", mapa = null, marcaYo = null, pinsRetiro = [], pinEntrega = null, pinGuia = null, linea = null;
  let pos = null, ultEscritura = 0, watchId = null, wakeLock = null, refOrden = null, refChat = null, refVigia = null, refChatAdm = null, aceptando = false;
  const RA = { chats: "chatsInvitado", resumen: "chatsInvitadoResumen", leido: "leidosInvitado" };   // chat con el administrador
  let chatAdmAbierto = false, sinLeerAdm = 0;
  let capaFlujo = null, pinCli = null, refCli = null, cliPos = null, seguirme = true, pagoSig = null, guardandoPago = false;
  const FRESCO_MS = 60000;   // la ubicación del cliente se considera "en vivo" si es más reciente que esto
  let flechasCapa = null, ruta = { pts: null, pasos: null, idx: 0, dist: 0, dur: 0, origen: null, dest: null, en: 0 }, yaEncuadrado = false, chatAbierto = false, sinLeer = 0, terminado = false;
  const vista = (id) => ["vCarga", "vEntrada", "vApp", "vFin", "vTomado"].forEach((v) => $(v).classList.toggle("oculto", v !== id));
  const msgCarga = (m) => { $("msgCarga").textContent = m; $("msgCarga").className = "estado error"; };

  /* ---------- Arranque ---------- */
  const esMio = (o, guardado) => { const a = (o && o.asignacion) || {}; return a.authUid ? a.authUid === auth.currentUser.uid : !!guardado && a.nombre === guardado; };
  const tomadoPor = (o) => (o && o.asignacion && o.asignacion.nombre && ["asignado", "retirado"].includes(o.estado)) ? o.asignacion.nombre : null;
  /* Pantalla exclusiva de enlace ya tomado: nada más se muestra */
  function tomado(nom) {
    terminado = true;
    [refVigia, refOrden, refChat, refChatAdm, refCli].forEach((r) => { if (r) r.off(); });
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    $("txtTomado").textContent = `Este pedido ya fue tomado por ${nom}, muchas gracias.`;
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
    if (otro && !esMio(orden, guardado)) return tomado(otro);           // enlace ya tomado por otro repartidor
    if (["entregado", "cancelado"].includes(orden.estado)) return final(orden.estado);
    if (otro) return entrar(orden.asignacion.nombre, true);              // yo ya lo había aceptado: retomar
    // Sigue pendiente: se puede ver, pero NO se asigna nada hasta pulsar "Aceptar"
    $("resumenEntrada").innerHTML = resumenHtml(orden);
    $("inNombre").value = guardado || "";
    vista("vEntrada");
    refVigia = db.ref("ordenes/" + t);   // si otro lo acepta mientras lo miro, se bloquea al instante
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

  /* Aceptar = reclamar el pedido con una TRANSACCIÓN: solo el primero en llegar lo consigue */
  async function entrar(n, reanudar) {
    nombre = n; aceptando = true;
    $("btnEntrar").disabled = true; $("msgEntrada").classList.add("oculto");
    const miUid = auth.currentUser.uid;
    if (!reanudar) {
      let res;
      try {
        res = await db.ref(`ordenes/${t}/asignacion`).transaction((cur) => {
          if (cur && cur.nombre && cur.authUid !== miUid) return;   // ya lo tomó otro: se aborta
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
    db.ref("ubicaciones/" + uid).onDisconnect().update({ enLinea: false, enViaje: false, ts: TS });
    $("subTitulo").textContent = "Invitado · " + n;
    vista("vApp"); iniciarMapa(); escucharOrden(); escucharCliente(); escucharChat(); escucharChatAdm(); iniciarGPS();
  }

  /* ---------- Pedido en vivo ---------- */
  function escucharOrden() {
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
  /* Ubicación del cliente (pedidos/{token}/cliente): se mueve sola mientras él comparte su ubicación o la marca a mano */
  function escucharCliente() {
    refCli = db.ref("pedidos/" + t + "/cliente");
    refCli.on("value", (s) => {
      const c = s.val();
      cliPos = c && Number.isFinite(c.lat) && Number.isFinite(c.lng) ? { lat: c.lat, lng: c.lng, manual: !!c.manual, ts: c.ts || 0 } : null;
      if (orden && mapa) { pintarPuntos(); calcularRuta(false); }
    }, () => {});
  }
  const clienteVivo = () => (cliPos && (cliPos.manual || (cliPos.ts && Date.now() - cliPos.ts < FRESCO_MS)) ? cliPos : null);
  /* Punto de entrega: lo que el cliente marcó a mano > la dirección del pedido > el cliente en vivo (si la dirección no tiene coordenadas) */
  function puntoEntrega() {
    if (cliPos && cliPos.manual) return cliPos;
    if (orden && O.valido(orden.entrega)) return orden.entrega;
    return clienteVivo();
  }
  const destinoActual = () => {
    if (orden.guia && O.valido(orden.guia)) return { lat: orden.guia.lat, lng: orden.guia.lng, etiqueta: O.PUNTOS[orden.guia.punto] ? O.PUNTOS[orden.guia.punto].nombre : "Punto", texto: "Punto indicado por Brothers" };
    const d = O.destinoDe(orden);
    if (d.etiqueta === "Retiro" && d.total > 1) d.etiqueta = `Retiro ${d.idx + 1}/${d.total}`;
    if (d.etiqueta === "Entrega") {
      const e = puntoEntrega();
      if (e && O.valido(e)) return { etiqueta: "Entrega", lat: e.lat, lng: e.lng, texto: e === cliPos ? (cliPos.manual ? "Ubicación marcada por el cliente" : "Ubicación en vivo del cliente") : (orden.entrega && orden.entrega.texto) || "" };
    }
    return d;
  };
  /* Cuando ya declaró lo pagado al restaurante: cuánto debe cobrarle al cliente (lo mismo que ve el cliente en "Total a Pagar") */
  function cobroHtml() {
    if (!orden || orden.pagadoRestaurante == null || !Number.isFinite(+orden.pagadoRestaurante)) return "";
    const pagado = O.r2(orden.pagadoRestaurante), deliv = O.totalDelivery(orden);
    return `<div class="pd-precio"><small>💵 TOTAL A COBRAR AL CLIENTE</small><b>${O.money(pagado + deliv)}</b><span>Pagado al restaurante ${O.money(pagado)} + Delivery ${O.money(deliv)}</span></div>`;
  }
  function pintarPedido() {
    const d = destinoActual(), [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.pendiente;
    $("datosPedido").innerHTML = `<b>Pedido ${esc(orden.codigo)} · ${esc(orden.cliente || "")}</b>
      <span>${d.etiqueta === "Entrega" ? "🏠" : "📦"} Ahora: <b>${esc(d.etiqueta)}</b> — ${esc(d.texto || "sin dirección")}${d.producto ? " · <b>" + esc(d.producto) + "</b>" : ""}</span>
      ${O.paradas(orden).length > 1 ? "<small>Retiros del pedido:</small>" + listaParadas(orden) : ""}
      ${orden.paquete ? `<span>📝 ${esc(orden.paquete)}</span>` : ""}`;
    $("precioGrande").innerHTML = O.precioHtml(orden) + cobroHtml();
    $("chipEstado").textContent = txt; $("chipEstado").className = "chip " + cls;
    const sig = O.siguienteRetiro(orden);
    $("btnRetirado").disabled = !sig;
    $("btnRetirado").textContent = sig ? `📦 Retirado${O.paradas(orden).length > 1 ? " (" + (sig.i + 1) + "/" + O.paradas(orden).length + ")" : ""}` : "📦 Todo retirado";
    $("btnEntregado").disabled = !!sig;
    pintarPuntos(); calcularRuta(true);
  }

  /* ---------- Botones de estado ---------- */
  /* Aplica el cambio de estado en la nube. Devuelve true si se guardó. */
  async function aplicarCambio(estado, sig) {
    try {
      if (estado === "retirado") await O.marcarRetiro(db, t, orden, sig.i); else await O.marcar(db, t, estado, orden);
      await db.ref(`ordenes/${t}/guia`).remove().catch(() => {});   // el punto rápido del admin ya cumplió su función
      if (estado === "entregado") {
        await db.ref("pedidos/" + t).update({ estado: "entregado", fin: TS, lat: null, lng: null, rumbo: null, velocidad: null, precision: null, destLat: null, destLng: null, distancia: null, cerca: null });
        await db.ref("ubicaciones/" + uid).remove().catch(() => {});
        final("entregado");
      }
      return true;
    } catch (e) { alert("No se pudo actualizar el estado: " + e.message); return false; }
  }
  async function cambiar(estado) {
    const sig = O.siguienteRetiro(orden);
    if (estado === "retirado" && !sig) return;
    if (ES_INVITADO && estado === "retirado") return abrirPago(sig);   // el invitado primero declara cuánto pagó en el restaurante
    const pregunta = estado === "retirado" ? `¿Confirmas que ya RETIRASTE${sig.p.producto ? " “" + sig.p.producto + "”" : " este paquete"}${sig.p.texto ? " en " + sig.p.texto : ""}?` : "¿Confirmas que el paquete fue ENTREGADO?";
    if (!confirm(pregunta)) return;
    await aplicarCambio(estado, sig);
  }

  /* ---------- Cobro al retirar: valor pagado al restaurante ---------- */
  const msgPago = (m) => { $("pagoMsg").textContent = m || ""; $("pagoMsg").classList.toggle("oculto", !m); };
  function abrirPago(sig) {
    pagoSig = sig; guardandoPago = false;
    const ps = O.paradas(orden), previo = orden.pagos && orden.pagos[sig.i];   // si ya lo había declarado (reintento), se vuelve a mostrar
    $("pagoDetalle").textContent = [ps.length > 1 ? `Retiro ${sig.i + 1} de ${ps.length}` : "Retiro", sig.p.texto, sig.p.producto].filter(Boolean).join(" · ");
    $("pagoMonto").value = previo != null && Number.isFinite(+previo) ? String(previo) : "";
    msgPago("");
    $("btnPagoOk").disabled = false; $("btnPagoOk").textContent = "✅ Confirmar retiro";
    $("modalPago").classList.remove("oculto");
    setTimeout(() => { try { $("pagoMonto").focus(); } catch (_) {} }, 80);
  }
  function cerrarPago() { pagoSig = null; guardandoPago = false; $("modalPago").classList.add("oculto"); }
  /* Guarda el valor en el pedido. pedidos/{token} es lo que lee el cliente (y es imprescindible); ordenes/{token} es lo que audita el administrador. */
  async function guardarPago(sig, monto) {
    const pagos = Object.assign({}, orden.pagos || {}); pagos[sig.i] = monto;   // por retiro: reintentar un retiro no suma dos veces
    const total = O.r2(Object.values(pagos).reduce((a, v) => a + (Number(v) || 0), 0));
    await db.ref("pedidos/" + t).update({ pagadoRestaurante: total, delivery: O.totalDelivery(orden), invitado: true });
    try {
      await db.ref().update({ [`ordenes/${t}/pagos/${sig.i}`]: monto, [`ordenes/${t}/pagadoRestaurante`]: total, [`ordenes/${t}/actualizado`]: TS });
    } catch (e) { console.warn("No se pudo guardar el valor pagado en ordenes/" + t + " (revisa las reglas de Firebase):", e.message); }
    return total;
  }
  $("btnPagoOk").onclick = async () => {
    if (guardandoPago || !pagoSig) return;
    const crudo = $("pagoMonto").value.trim().replace(",", "."), monto = crudo === "" ? NaN : Number(crudo);
    if (!Number.isFinite(monto) || monto < 0 || monto > 1000000) return msgPago("Escribe cuánto pagaste al restaurante (solo números, por ejemplo 250 o 250.50).");
    guardandoPago = true; msgPago("");
    $("btnPagoOk").disabled = true; $("btnPagoOk").textContent = "Guardando…";
    const sig = pagoSig;
    try { await guardarPago(sig, O.r2(monto)); }
    catch (e) {
      guardandoPago = false; $("btnPagoOk").disabled = false; $("btnPagoOk").textContent = "✅ Confirmar retiro";
      return msgPago("No se pudo guardar el valor: " + e.message);
    }
    cerrarPago();
    await aplicarCambio("retirado", sig);
  };
  $("btnPagoCancelar").onclick = cerrarPago;
  $("pagoMonto").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("btnPagoOk").click(); } });
  /* Minimizar / ver los detalles (el precio y los botones siempre quedan a la vista) */
  $("btnMinPanel").onclick = () => {
    const min = $("panelInv").classList.toggle("min");
    $("detallesPanel").classList.toggle("oculto", min);
    $("btnMinPanel").setAttribute("aria-expanded", String(!min));
    $("txtMin").textContent = min ? "Ver detalles ▴" : "Ocultar detalles ▾";
    setTimeout(() => { if (!mapa) return; mapa.invalidateSize(); if (seguirme && pos) Camara.actualizar(true); }, 80);
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
    if (refOrden) refOrden.off(); if (refChat) refChat.off(); if (refChatAdm) refChatAdm.off(); if (refCli) refCli.off();
    cerrarPago();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    try { wakeLock && wakeLock.release(); } catch (_) {}
    db.ref("ubicaciones/" + uid).onDisconnect().cancel();
    $("finTitulo").textContent = estado === "entregado" ? "¡Entrega confirmada!" : "Pedido cancelado";
    $("finTxt").textContent = estado === "entregado" ? "Gracias por tu ayuda. Ya puedes cerrar esta página." : "El administrador canceló este pedido. Ya puedes cerrar esta página.";
    localStorage.removeItem(claveLocal);
    vista("vFin");
  }

  /* ============================================================
     CÁMARA INTELIGENTE (misma que el repartidor registrado)
     1) Zoom dinámico: cuanto más cerca del destino, más zoom (de ~14.5 lejos a 19 pegado al destino), con pasos de 0.25.
     2) Bearing: el rumbo se calcula con las dos últimas coordenadas (mínimo 4 m de avance) y el mapa rota para que el repartidor apunte
        hacia arriba. Usa el plugin leaflet-rotate; si no está cargado, el mapa queda con el norte arriba y lo demás sigue igual.
     3) Tercio inferior: el centro del mapa se corre H/6 px "hacia adelante" del rumbo, así el ícono queda fijo en la línea de 2/3
        de la altura mientras el mapa se mueve debajo, y se ve más calle por delante.
     4) Ícono proporcional: --escala-rep (CSS) crece con el zoom: ~0.7 lejos → 1.6 con el máximo acercamiento.
     Si el repartidor mueve el mapa o hace zoom con el dedo, la cámara se pausa (🧭 para retomarla).
     ============================================================ */
  const Camara = (() => {
    const SIGNO_ROTACION = 1;      // si en tu equipo el mapa gira al revés, cambia a -1
    const MIN_PASO_M = 4;          // avance mínimo entre dos puntos para recalcular el rumbo (evita temblor del GPS parado)
    const MIN_MS = 900;            // la cámara se mueve como máximo una vez por segundo
    let prev = null, suave = 0, tieneRumbo = false, ult = 0, ultGesto = 0;
    const rad = (x) => (x * Math.PI) / 180, deg = (x) => (x * 180) / Math.PI;
    const rotable = () => !!(mapa && typeof mapa.setBearing === "function");
    const gesto = () => { ultGesto = Date.now(); };
    const alZoom = () => { if (Date.now() - ultGesto < 1500 && seguirme) { seguirme = false; refrescarBoton(); } };
    const opcionesMapa = () => ({ rotate: true, bearing: 0, touchRotate: false, rotateControl: false, zoomSnap: 0.25, zoomDelta: 1 });
    /* Ángulo (0–360°, desde el norte, horario) entre dos coordenadas */
    function rumboEntre(a, b) {
      const dLng = rad(b.lng - a.lng);
      const y = Math.sin(dLng) * Math.cos(rad(b.lat));
      const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
      return (deg(Math.atan2(y, x)) + 360) % 360;
    }
    const giroSuave = (a, b) => { const d = ((b - a + 540) % 360) - 180; return (a + d * 0.5 + 360) % 360; };   // camino más corto entre ángulos, suavizado
    function registrar(lat, lng) {   // se llama con cada lectura del GPS
      const p = { lat, lng };
      if (!prev) { prev = p; return; }
      if (O.distM(prev, p) < MIN_PASO_M) return;
      const r = rumboEntre(prev, p);
      prev = p;
      suave = tieneRumbo ? giroSuave(suave, r) : r;
      tieneRumbo = true;
    }
    function zoomPara(dist) {
      if (dist == null) return 17;
      const z = 19 - Math.log2(Math.max(dist, 80) / 80) * 0.75;   // 80 m → 19 · 640 m → 16.75 · 5 km → 14.5
      return Math.round(Math.min(19, Math.max(14.5, z)) * 4) / 4;
    }
    const escalaPara = (z) => Math.round(Math.min(1.6, Math.max(0.7, 0.7 * Math.pow(2, (z - 15) * 0.3))) * 100) / 100;
    function aplicarEscala() {
      if (!mapa) return;
      try { mapa.getContainer().style.setProperty("--escala-rep", String(escalaPara(mapa.getZoom()))); } catch (_) {}
    }
    function marcarIcono() { const e = marcaYo && marcaYo.getElement && marcaYo.getElement(); if (e) e.classList.add("rep-yo"); }
    function refrescarBoton() {
      const b = $("btnSeguir"); if (!b) return;
      b.classList.toggle("on", !!seguirme);
      b.setAttribute("aria-pressed", String(!!seguirme));
    }
    /* Mueve la cámara: zoom por distancia + rotación + ícono en el tercio inferior */
    function actualizar(forzar) {
      if (!mapa || !pos || !seguirme || !orden) return;
      const ahora = Date.now();
      if (!forzar && ahora - ult < MIN_MS) return;
      ult = ahora;
      const d = destinoActual(), dist = d && O.valido(d) ? O.distM(pos, d) : null;
      const z = zoomPara(dist), ang = rotable() && tieneRumbo ? suave : 0;
      const k = mapa.getSize().y / 6;                 // 1/6 de la altura por debajo del centro = línea del tercio inferior
      const tt = rad(ang), pr = mapa.project([pos.lat, pos.lng], z);
      const centro = mapa.unproject(L.point(pr.x + Math.sin(tt) * k, pr.y - Math.cos(tt) * k), z);   // punto "por delante" del repartidor
      if (rotable()) { try { mapa.setBearing((SIGNO_ROTACION * ang + 360) % 360); } catch (_) {} }
      mapa.setView(centro, z, { animate: !forzar, duration: 0.8, easeLinearity: 0.5, noMoveStart: true });
      aplicarEscala();
      refrescarBoton();
    }
    /* Vista general (Ver todo, encuadrar…): norte arriba */
    function norte() {
      if (rotable()) { try { mapa.setBearing(0); } catch (_) {} }
      setTimeout(refrescarBoton, 0);
    }
    return { opcionesMapa, registrar, actualizar, norte, aplicarEscala, marcarIcono, refrescarBoton, gesto, alZoom };
  })();

  /* ---------- Mapa y ruta ---------- */
  function iniciarMapa() {
    const gestos = typeof GestosMapa !== "undefined" && GestosMapa.opciones ? GestosMapa.opciones : {};
    mapa = L.map("mapaInv", Object.assign({}, gestos, Camara.opcionesMapa(), { zoomControl: false })).setView([-12.0464, -77.0428], 14);
    if (typeof GestosMapa !== "undefined" && GestosMapa.aplicar) GestosMapa.aplicar(mapa);   // un dedo solo desliza; el zoom es con botones, doble toque o pellizco
    L.control.zoom({ position: "bottomright" }).addTo(mapa);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    linea = L.polyline([], { color: "#0A86C9", weight: 7, opacity: .9, lineCap: "round" }).addTo(mapa);
    capaFlujo = L.polyline([], { color: "#fff", weight: 3, opacity: .95, className: "ruta-viva" }).addTo(mapa);   // línea animada encima de la ruta
    flechasCapa = L.layerGroup().addTo(mapa);   // flechas: sentido de circulación en cada calle
    mapa.on("zoomend", () => mapa.getContainer().classList.toggle("zoom-lejos", mapa.getZoom() < 15));
    mapa.on("zoom zoomend", Camara.aplicarEscala);   // el ícono del repartidor crece con el zoom (respeta el ancho de la calle)
    Camara.aplicarEscala();
    mapa.getContainer().classList.add("zoom-lejos");
    mapa.on("dragstart", () => { seguirme = false; Camara.refrescarBoton(); });   // movió el mapa con el dedo: se pausa la cámara (🧭 para retomarla)
    ["pointerdown", "touchstart", "wheel"].forEach((ev) => mapa.getContainer().addEventListener(ev, Camara.gesto, { passive: true, capture: true }));
    mapa.on("zoomstart", Camara.alZoom);   // se registra al final para ignorar los zooms de arranque
    Camara.refrescarBoton();
    setTimeout(() => { mapa.invalidateSize(); pintarPuntos(); encuadrar(); }, 80);
  }
  $("btnSeguir").onclick = () => {   // retoma la cámara de navegación (sigue al repartidor, zoom por distancia, rotación)
    if (!pos) { $("estadoGps").textContent = "Esperando tu ubicación para seguirte…"; return; }
    seguirme = true; Camara.refrescarBoton();
    Camara.actualizar(true);
  };
  $("btnVerTodo").onclick = () => { seguirme = false; Camara.refrescarBoton(); encuadrar(); };
  function pintarPuntos() {
    if (!mapa || !orden) return;
    const poner = (actual, p, icono) => {
      if (!O.valido(p)) { if (actual) mapa.removeLayer(actual); return null; }
      if (!actual) return L.marker([p.lat, p.lng], { icon: icono, zIndexOffset: 300 }).addTo(mapa);
      actual.setLatLng([p.lat, p.lng]); actual.setIcon(icono); return actual;
    };
    const ps = O.paradas(orden);
    while (pinsRetiro.length > ps.length) { const x = pinsRetiro.pop(); if (x) mapa.removeLayer(x); }
    /* Sobre cada local de retiro: nombre del negocio + lo que hay que retirar (al retirarlo queda solo el ✅) */
    ps.forEach((p, k) => {
      const num = ps.length > 1 ? String(k + 1) : "📦";
      pinsRetiro[k] = poner(pinsRetiro[k], p, p.retirado ? O.pinIcono("retiro", "✅") : O.pinEtiqueta("retiro", num, p.texto || "Retiro", p.producto));
    });
    pinEntrega = poner(pinEntrega, orden.entrega, O.pinIcono("entrega", "🏠"));
    pinGuia = poner(pinGuia, orden.guia, O.pinIcono(orden.guia && orden.guia.punto === "entrega" ? "entrega" : "retiro", "📍"));
    /* El cliente (👤) solo se dibuja si está lejos de la dirección de entrega o si la dirección no tiene coordenadas */
    const verCli = clienteVivo() && (!O.valido(orden.entrega) || O.distM(cliPos, orden.entrega) > 30);
    pinCli = poner(pinCli, verCli ? cliPos : null, O.pinIcono("entrega", "👤"));
    if (!yaEncuadrado) encuadrar();
  }
  function encuadrar() {
    if (!mapa) return;
    if (seguirme && pos && orden) { Camara.actualizar(true); yaEncuadrado = true; return; }   // cámara de navegación activa: manda ella
    Camara.norte();   // vista general: norte arriba
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
    trazar([[pos.lat, pos.lng], ...r.pts]); O.flechas(r.pts, flechasCapa, "#0A86C9");
    avanzarBanner();
  }
  function limpiarRuta() { ruta = { pts: null, pasos: null, idx: 0, dist: 0, dur: 0, origen: null, dest: null, en: ruta.en }; trazar([]); flechasCapa.clearLayers(); }
  function trazar(pts) { linea.setLatLngs(pts); capaFlujo.setLatLngs(pts); }   // ruta azul + línea animada encima
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : m + " m");
  /* Aviso corto de la ruta: distancia, tiempo y destino. Ya no se muestra el cartel de "gira a la izquierda…". */
  function banner(paso, aviso) {
    const b = $("bannerRuta"); b.classList.remove("oculto");
    if (!paso) { b.innerHTML = `<span class="ir-ic">🧭</span><span class="ir-txt">${esc(aviso)}</span>`; return; }
    b.innerHTML = `<span class="ir-ic">🧭</span><span class="ir-txt"><b>${fmtDist(ruta.dist)}</b> · ≈ ${Math.max(1, Math.round(ruta.dur / 60))} min · ${esc(destinoActual().etiqueta)}</span>`;
  }
  function avanzarBanner() {   // pasa al siguiente giro cuando ya estás encima del anterior
    if (!ruta.pasos || !pos) return;
    while (ruta.idx < ruta.pasos.length - 1 && O.distM(pos, ruta.pasos[ruta.idx].loc) < 30) ruta.idx++;
    banner(ruta.pasos[ruta.idx]);
    if (ruta.pts) trazar([[pos.lat, pos.lng], ...ruta.pts]);
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
    Camara.registrar(pos.lat, pos.lng);   // rumbo con las dos últimas coordenadas
    if (!marcaYo) marcaYo = L.marker([pos.lat, pos.lng], { icon: (typeof iconoRepartidorNombre === "function" ? iconoRepartidorNombre(nombre) : O.pinIcono("", "🛵")), zIndexOffset: 1000 }).addTo(mapa);
    else marcaYo.setLatLng([pos.lat, pos.lng]);
    Camara.marcarIcono();
    if (primera) { yaEncuadrado = false; encuadrar(); }
    calcularRuta(false);
    if (seguirme && !primera) Camara.actualizar(false);   // zoom por proximidad + rotación + ícono en el tercio inferior
    const ahora = Date.now(); if (ahora - ultEscritura < 4000 || terminado) return; ultEscritura = ahora;
    const base = { lat: pos.lat, lng: pos.lng, precision: Math.round(c.accuracy || 0), rumbo: Number.isFinite(c.heading) ? c.heading : null, velocidad: Number.isFinite(c.speed) ? c.speed : null, ts: TS };
    db.ref("ubicaciones/" + uid).set(Object.assign({ enLinea: true, enViaje: true, usuario: nombre + " (invitado)" }, base)).catch(() => {});
    const ped = Object.assign({}, base), ent = puntoEntrega();   // el cliente ve el zoom por proximidad con esta distancia
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
        O.hablar("Mensaje del cliente: " + (m.texto || "te envió una foto"));   // en voz alta
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

  /* ---------- Chat con el administrador (chatsInvitado/{token}) ---------- */
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

  arrancar();
})();
