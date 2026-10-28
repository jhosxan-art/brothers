/* ============================================================
   ORDENES-CORE · lógica compartida de pedidos (admin, invitado, repartidor)

   Nodos de Realtime Database que usa:
     ordenes/{token}      pedido creado por el administrador
        { codigo, cliente, retiro:{texto,lat,lng}, entrega:{texto,lat,lng}, paquete,
          estado: pendiente|asignado|retirado|entregado|cancelado,
          asignacion:{ tipo:"registrado"|"invitado", uid?, nombre?, unido? },
          guia:{ punto, lat, lng, ts }  ← punto rápido asignado desde el mapa (solo invitados)
          creado, actualizado }
     guias/{uid}          punto Retiro/Entrega que ve UN repartidor registrado (ya existía)
     ubicaciones/inv_{t}  posición del invitado → aparece en el mapa del admin como un repartidor más
     pedidos/{token}      lo crea el invitado al entrar (seguimiento + chat del cliente, ya existente)
     chats/{token}        chat invitado ↔ cliente (mismo formato que el chat existente)
   ============================================================ */
const Ordenes = (() => {
  const TS = firebase.database.ServerValue.TIMESTAMP;
  const ESTADOS = {
    pendiente: ["Pendiente", "pend"], asignado: ["Asignado", "vivo"], retirado: ["Retirado", "ret"],
    entregado: ["Entregado", "ent"], cancelado: ["Cancelado", "gris"]
  };
  const PUNTOS = { retiro: { nombre: "Retiro", icono: "📦" }, entrega: { nombre: "Entrega", icono: "🏠" } };

  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const token = (largo = 14) => {
    const abc = "abcdefghijkmnpqrstuvwxyz23456789";
    return Array.from(crypto.getRandomValues(new Uint8Array(largo)), (b) => abc[b % abc.length]).join("");
  };
  const codigo = () => "P" + Date.now().toString(36).slice(-5).toUpperCase();
  const uidInvitado = (t) => "inv_" + t;
  const esInvitadoUid = (uid) => typeof uid === "string" && uid.startsWith("inv_");

  /* Enlaces: el del invitado vive junto a rastreo.html (misma carpeta pública) */
  const baseDe = (u) => u.replace(/[^/]*$/, "");
  const urlInvitado = (t) => (typeof URL_INVITADO !== "undefined" ? URL_INVITADO : baseDe(URL_RASTREO) + "invitado.html") + "?t=" + t;
  const urlCliente = (t) => `${URL_RASTREO}?id=${t}&chat=1`;

  /* Voz en voz alta (usa Voz.hablar si existe; si no, el sintetizador del navegador) */
  function hablar(texto) {
    try {
      if (typeof Voz !== "undefined" && Voz.hablar) return Voz.hablar(texto, { forzar: true });
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(texto); u.lang = "es-ES"; u.rate = 1;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (_) {}
  }
  const money = (x) => "C$ " + (Math.round((+x || 0) * 100) / 100).toFixed(2);
  const r2 = (x) => Math.max(0, Math.round((+x || 0) * 100) / 100);
  /* Delivery = base + IVA (el IVA solo existe en pedidos de repartidor registrado). "delivery" guarda la base. */
  const totalDelivery = (o) => r2(r2(o && o.delivery) + r2(o && o.iva));
  const textoDelivery = (o) => { const b = r2(o && o.delivery), i = r2(o && o.iva); return i ? `${money(b + i)} (${money(b)} + ${money(i)} IVA)` : money(b); };
  /* Precio del delivery EN GRANDE, con el desglose debajo cuando lleva IVA */
  const precioHtml = (o) => {
    const b = r2(o && o.delivery), i = r2(o && o.iva); if (!b && !i) return "";
    return `<div class="pd-precio"><small>🛵 DELIVERY A COBRAR</small><b>${money(b + i)}</b>${i ? `<span>${money(b)} + ${money(i)} IVA</span>` : ""}</div>`;
  };
  /* Un pedido puede tener varios retiros (cada uno con su producto). Pedidos viejos traen solo "retiro". */
  const paradas = (o) => (o && Array.isArray(o.retiros) && o.retiros.length ? o.retiros : o && o.retiro ? [o.retiro] : []);
  const pendientes = (o) => paradas(o).map((p, i) => ({ i, p })).filter((x) => !x.p.retirado);
  const siguienteRetiro = (o) => pendientes(o)[0] || null;
  /* Hacia dónde va ahora el repartidor: el siguiente retiro pendiente o, si ya retiró todo, la entrega */
  function destinoDe(o) {
    const s = siguienteRetiro(o);
    if (s && !(o.estado === "entregado")) return Object.assign({ etiqueta: "Retiro", idx: s.i, total: paradas(o).length }, s.p);
    return Object.assign({ etiqueta: "Entrega" }, o.entrega || {});
  }
  const valido = (p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lng);
  const limpiarPunto = (p) => {
    const o = { texto: String((p && p.texto) || "").trim().slice(0, 160) };
    if (valido(p)) { o.lat = +(+p.lat).toFixed(6); o.lng = +(+p.lng).toFixed(6); }
    return o;
  };

  /* Guía visible para un repartidor registrado (reutiliza guias/{uid}: el admin ya la dibuja y el repartidor ya la ruta) */
  const datosGuia = (punto, ll, extra) => Object.assign({
    lat: +(+ll.lat).toFixed(6), lng: +(+ll.lng).toFixed(6), ts: TS, por: "admin",
    tipo: "negocio", punto, nombre: PUNTOS[punto].nombre, icono: PUNTOS[punto].icono
  }, extra || {});

  /* Guía de retiro i: lleva negocio y producto para rotular el pin en el mapa del repartidor.
     Si el retiro no tiene coordenadas igual se escribe la guía (solo ordenId) para que el repartidor reciba el pedido. */
  const guiaRetiro = (t, orden, i) => {
    const ps = paradas(orden), p = ps[i];
    return valido(p) ? datosGuia("retiro", p, { ordenId: t, nombre: textoRetiro(p, ps.length, i), negocio: p.texto || "Retiro", producto: p.producto || "" })
      : { ts: TS, por: "admin", ordenId: t };
  };
  const guiaEntrega = (t, orden) => datosGuia("entrega", orden.entrega, { ordenId: t, negocio: "Entrega · " + (orden.cliente || "cliente") });
  const textoRetiro = (p, n, k) => `Retiro${n > 1 ? " " + (k + 1) + "/" + n : ""}${p.texto ? ": " + p.texto : ""}`.slice(0, 80);
  /* pedidos/{token}: lo que ve el cliente (seguimiento, chat y avisos de voz). Se crea al asignar. */
  const nodoCliente = (t, orden, uid, nombre) => ({
    estado: "en_ruta", pedido: orden.codigo, inicio: TS, repartidorUid: uid, repartidorNombre: nombre || "",
    clienteNombre: orden.cliente, adminOrden: true, delivery: totalDelivery(orden)
  });

  async function crear(db, d) {
    const t = token();
    const retiros = (d.retiros || []).map((r) => Object.assign(limpiarPunto(r), { producto: String(r.producto || "").trim().slice(0, 120) })).filter((r) => r.texto);
    const orden = {
      codigo: codigo(), cliente: String(d.cliente || "").trim().slice(0, 60),
      retiros, retiro: retiros[0] || { texto: "" }, entrega: limpiarPunto(d.entrega), paquete: String(d.paquete || "").trim().slice(0, 400),
      delivery: r2(d.delivery),
      estado: "pendiente", creado: TS, actualizado: TS
    };
    if (r2(d.iva) > 0) orden.iva = r2(d.iva);
    const upd = { ["ordenes/" + t]: orden };
    const a = d.asignacion;
    if (a && a.tipo === "registrado") {
      orden.estado = "asignado";
      orden.asignacion = { tipo: "registrado", uid: a.uid, nombre: a.nombre || "" };
      upd["pedidos/" + t] = nodoCliente(t, orden, a.uid, a.nombre);
      upd["guias/" + a.uid] = guiaRetiro(t, orden, 0);
    } else if (a && a.tipo === "invitado") {
      orden.asignacion = { tipo: "invitado" };   // el nombre llega cuando el invitado abre el enlace
      upd["pedidos/" + t] = nodoCliente(t, orden, uidInvitado(t), "");
    }
    await db.ref().update(upd);
    return { token: t, orden };
  }

  /* Asignar un pedido pendiente (o reasignarlo) a un repartidor registrado o generar enlace de invitado */
  async function asignar(db, t, orden, asignacion) {
    const upd = { ["ordenes/" + t + "/asignacion"]: asignacion, ["ordenes/" + t + "/estado"]: "asignado", ["ordenes/" + t + "/actualizado"]: TS };
    if (asignacion.tipo === "registrado") {
      upd["pedidos/" + t] = nodoCliente(t, orden, asignacion.uid, asignacion.nombre);
      const sig = siguienteRetiro(orden);
      if (sig) upd["guias/" + asignacion.uid] = guiaRetiro(t, orden, sig.i);
    } else upd["pedidos/" + t] = nodoCliente(t, orden, uidInvitado(t), "");
    await db.ref().update(upd);
  }

  /* Aviso al cliente: queda en pedidos/{token}/aviso (lo lee aviso-cliente.js y lo dice en voz alta) y en su chat */
  function avisoCliente(upd, db, t, texto, tipo) {
    upd[`pedidos/${t}/aviso`] = { texto, tipo, ts: TS, id: token(6) };
    db.ref("chats/" + t).push({ de: "repartidor", texto, ts: TS, sistema: true }).catch(() => {});
  }

  /* Un retiro (parada i) fue recogido. Cuando ya no quedan pendientes el pedido pasa a "retirado" y la ruta va a la entrega. */
  async function marcarRetiro(db, t, orden, i) {
    const ps = paradas(orden), p = ps[i]; if (!p || p.retirado) return;
    const faltan = ps.filter((x, k) => !x.retirado && k !== i), hechos = ps.length - faltan.length;
    const upd = { [`ordenes/${t}/retiros/${i}/retirado`]: TS, [`ordenes/${t}/actualizado`]: TS };
    const a = orden.asignacion || {};
    if (!Array.isArray(orden.retiros)) upd[`ordenes/${t}/retiros`] = ps.map((x, k) => Object.assign({}, x, k === i ? { retirado: TS } : {}));   // pedido viejo: se convierte
    const prod = p.producto ? `“${p.producto}”` : "un producto";
    if (faltan.length) {
      const sig = ps.findIndex((x, k) => !x.retirado && k !== i);
      avisoCliente(upd, db, t, `📦 Ya retiraron ${prod}${p.texto ? " en " + p.texto : ""} (${hechos}/${ps.length}). Faltan ${faltan.length} retiro${faltan.length > 1 ? "s" : ""}, ¡atento!`, "retiro");
      if (a.tipo === "registrado" && a.uid && valido(ps[sig])) upd["guias/" + a.uid] = guiaRetiro(t, orden, sig);
    } else {
      upd[`ordenes/${t}/estado`] = "retirado"; upd[`ordenes/${t}/retiradoTs`] = TS;
      avisoCliente(upd, db, t, `📦 Tu pedido completo ya fue retirado y va en camino hacia ti. ¡Está pendiente!`, "retirado");
      if (a.tipo === "registrado" && a.uid && valido(orden.entrega)) upd["guias/" + a.uid] = guiaEntrega(t, orden);
    }
    await db.ref().update(upd);
  }

  /* Cambio de estado (Retirado / Entregado). Lo usan el invitado y el repartidor registrado. */
  async function marcar(db, t, estado, orden) {
    const upd = { ["ordenes/" + t + "/estado"]: estado, ["ordenes/" + t + "/actualizado"]: TS };
    upd["ordenes/" + t + (estado === "retirado" ? "/retiradoTs" : "/entregadoTs")] = TS;
    const a = orden && orden.asignacion;
    if (a && a.tipo === "registrado" && a.uid) {
      if (estado === "retirado" && valido(orden.entrega)) upd["guias/" + a.uid] = guiaEntrega(t, orden);   // la ruta pasa sola al punto de entrega
      if (estado === "entregado") upd["guias/" + a.uid] = null;
    }
    if (estado === "entregado") { upd[`pedidos/${t}/estado`] = "entregado"; avisoCliente(upd, db, t, "✅ Tu pedido fue entregado. ¡Gracias por tu compra!", "entregado"); }
    await db.ref().update(upd);
  }

  /* Punto rápido desde el mapa (Retiro/Entrega) para un repartidor registrado o invitado */
  async function puntoRapido(db, uid, punto, ll) {
    if (esInvitadoUid(uid)) {
      const t = uid.slice(4);
      return db.ref("ordenes/" + t + "/guia").set({ punto, lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6), ts: TS });
    }
    return db.ref("guias/" + uid).set(datosGuia(punto, ll));
  }

  /* Ruta por calles (OSRM público). Si falla, devuelve null y se dibuja línea recta. */
  async function rutaOSRM(o, d) {
    if (typeof Ruta !== "undefined" && Ruta.pedir) { try { return await Ruta.pedir(o, d); } catch (_) {} }
    try {
      const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson`);
      const j = await r.json(); const rt = j.routes && j.routes[0]; if (!rt) return null;
      return { pts: rt.geometry.coordinates.map(([x, y]) => [y, x]), dist: Math.round(rt.distance), dur: rt.duration };
    } catch (_) { return null; }
  }
  /* Ruta por calles con instrucciones paso a paso. Prueba varios servidores públicos con tiempo límite.
     Devuelve null si todos fallan: NUNCA se dibuja línea recta. */
  const SERVIDORES_RUTA = ["https://router.project-osrm.org/route/v1/driving/", "https://routing.openstreetmap.de/routed-car/route/v1/driving/"];
  async function rutaCalles(o, d) {
    for (const base of SERVIDORES_RUTA) {
      const ctl = new AbortController(), cortar = setTimeout(() => ctl.abort(), 9000);
      try {
        const r = await fetch(`${base}${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson&steps=true`, { signal: ctl.signal });
        const j = await r.json(), rt = j.routes && j.routes[0]; if (!rt) continue;
        const pasos = [];
        (rt.legs || []).forEach((leg) => (leg.steps || []).forEach((st) => pasos.push({
          tipo: st.maneuver.type, mod: st.maneuver.modifier || "", calle: st.name || "", dist: Math.round(st.distance),
          loc: { lat: st.maneuver.location[1], lng: st.maneuver.location[0] }
        })));
        if (!pasos.length) pasos.push({ tipo: "arrive", mod: "", calle: "", dist: 0, loc: { lat: d.lat, lng: d.lng } });
        return { pts: rt.geometry.coordinates.map(([x, y]) => [y, x]), dist: Math.round(rt.distance), dur: rt.duration, pasos };
      } catch (_) { /* siguiente servidor */ } finally { clearTimeout(cortar); }
    }
    return null;
  }
  const GIROS = { left: ["⬅️", "a la izquierda"], right: ["➡️", "a la derecha"], "slight left": ["↖️", "levemente a la izquierda"], "slight right": ["↗️", "levemente a la derecha"],
    "sharp left": ["↩️", "cerrado a la izquierda"], "sharp right": ["↪️", "cerrado a la derecha"], uturn: ["🔄", "en U"], straight: ["⬆️", "recto"] };
  /* [icono, texto] de una maniobra, siempre con el nombre de la calle */
  function textoPaso(p) {
    const calle = p.calle ? p.calle : "la vía", g = GIROS[p.mod];
    if (p.tipo === "arrive") return ["🏁", "Llegaste a tu destino"];
    if (p.tipo === "depart") return ["⬆️", `Sal por ${calle}`];
    if (p.tipo === "roundabout" || p.tipo === "rotary" || p.tipo === "roundabout turn") return ["🔄", `En la rotonda, toma la salida hacia ${calle}`];
    if (g && ["turn", "end of road", "fork", "on ramp", "off ramp", "merge"].includes(p.tipo)) return [g[0], `Gira ${g[1]} hacia ${calle}`];
    return ["⬆️", `Sigue por ${calle}`];
  }
  const callesDe = (pasos) => { const v = []; (pasos || []).forEach((p) => { if (p.calle && v[v.length - 1] !== p.calle) v.push(p.calle); }); return v.slice(0, 6).join(" → "); };
  /* Flechas sobre la ruta: muestran el sentido de circulación en cada calle */
  function flechas(pts, capa, color) {
    capa.clearLayers(); let acum = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = { lat: pts[i - 1][0], lng: pts[i - 1][1] }, b = { lat: pts[i][0], lng: pts[i][1] };
      acum += distM(a, b);
      if (acum < 140) continue; acum = 0;
      const ang = (Math.atan2(b.lng - a.lng, b.lat - a.lat) * 180) / Math.PI;
      L.marker([b.lat, b.lng], { interactive: false, icon: L.divIcon({ className: "", html: `<div class="flecha-ruta" style="color:${color};transform:rotate(${ang - 90}deg)">➤</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }) }).addTo(capa);
    }
  }

  const distM = (a, b) => {
    const R = 6371000, rad = (x) => (x * Math.PI) / 180, h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const pinIcono = (clase, emoji) => L.divIcon({ className: "", html: `<div class="pd-pin ${clase}"><b>${emoji}</b></div>`, iconSize: [34, 34], iconAnchor: [17, 17] });

  /* Pin con rótulo encima: nombre del negocio y lo que hay que retirar */
  const pinEtiqueta = (clase, emoji, nombre, producto) => L.divIcon({
    className: "",
    html: `<div class="pd-pin-et"><div class="pd-et"><b>${esc(nombre || "")}</b>${producto ? `<span>${esc(producto)}</span>` : ""}</div><div class="pd-pin ${clase}"><b>${emoji}</b></div></div>`,
    iconSize: [34, 34], iconAnchor: [17, 17]
  });

  return { r2, totalDelivery, textoDelivery, precioHtml, pinEtiqueta, TS, ESTADOS, PUNTOS, esc, token, uidInvitado, esInvitadoUid, urlInvitado, urlCliente, valido, crear, asignar, marcar, marcarRetiro, avisoCliente, hablar, money, paradas, pendientes, siguienteRetiro, destinoDe, textoRetiro, puntoRapido, rutaOSRM, rutaCalles, textoPaso, callesDe, flechas, distM, pinIcono };
})();
