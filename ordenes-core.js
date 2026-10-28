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

  async function crear(db, d) {
    const t = token();
    const orden = {
      codigo: codigo(), cliente: String(d.cliente || "").trim().slice(0, 60),
      retiro: limpiarPunto(d.retiro), entrega: limpiarPunto(d.entrega), paquete: String(d.paquete || "").trim().slice(0, 400),
      estado: "pendiente", creado: TS, actualizado: TS
    };
    const upd = { ["ordenes/" + t]: orden };
    if (d.asignacion && d.asignacion.tipo === "registrado") {
      orden.estado = "asignado";
      orden.asignacion = { tipo: "registrado", uid: d.asignacion.uid, nombre: d.asignacion.nombre || "" };
      if (valido(orden.retiro)) upd["guias/" + d.asignacion.uid] = datosGuia("retiro", orden.retiro, { ordenId: t });
    } else if (d.asignacion && d.asignacion.tipo === "invitado") {
      orden.asignacion = { tipo: "invitado" };   // el nombre llega cuando el invitado abre el enlace
    }
    await db.ref().update(upd);
    return { token: t, orden };
  }

  /* Cambio de estado (Retirado / Entregado). Lo usan el invitado y el repartidor registrado. */
  async function marcar(db, t, estado, orden) {
    const upd = { ["ordenes/" + t + "/estado"]: estado, ["ordenes/" + t + "/actualizado"]: TS };
    upd["ordenes/" + t + (estado === "retirado" ? "/retiradoTs" : "/entregadoTs")] = TS;
    const a = orden && orden.asignacion;
    if (a && a.tipo === "registrado" && a.uid) {
      if (estado === "retirado" && valido(orden.entrega)) upd["guias/" + a.uid] = datosGuia("entrega", orden.entrega, { ordenId: t });   // la ruta pasa sola al punto de entrega
      if (estado === "entregado") upd["guias/" + a.uid] = null;
    }
    await db.ref().update(upd);
  }

  /* Asignar un pedido pendiente (o reasignarlo) a un repartidor registrado o generar enlace de invitado */
  async function asignar(db, t, orden, asignacion) {
    const upd = { ["ordenes/" + t + "/asignacion"]: asignacion, ["ordenes/" + t + "/estado"]: "asignado", ["ordenes/" + t + "/actualizado"]: TS };
    if (asignacion.tipo === "registrado" && valido(orden.retiro)) upd["guias/" + asignacion.uid] = datosGuia("retiro", orden.retiro, { ordenId: t });
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
  const distM = (a, b) => {
    const R = 6371000, rad = (x) => (x * Math.PI) / 180, h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  const pinIcono = (clase, emoji) => L.divIcon({ className: "", html: `<div class="pd-pin ${clase}"><b>${emoji}</b></div>`, iconSize: [34, 34], iconAnchor: [17, 17] });

  return { TS, ESTADOS, PUNTOS, esc, token, uidInvitado, esInvitadoUid, urlInvitado, urlCliente, valido, crear, asignar, marcar, puntoRapido, rutaOSRM, distM, pinIcono };
})();
