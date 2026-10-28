/* ============================================================
   ORDENES-REPARTIDOR · pedido asignado por el administrador (repartidor registrado)
   - El admin asigna → guias/{uid} trae { ordenId } y la app ya traza la ruta al Retiro.
   - Aquí se sigue ese pedido en vivo y se ofrecen los botones Retirado / Entregado:
       Retirado  → la guía pasa sola al punto de Entrega (ruta nueva automática)
       Entregado → se limpia la guía y la ruta
   ============================================================ */
const OrdenAdminRep = (() => {
  const O = Ordenes, esc = O.esc;
  let ctx = null, id = null, ref = null, orden = null, minimizada = false;

  const init = (c) => { ctx = c; };
  /* Asignado por el administrador y todavía sin respuesta del repartidor (Aceptar / Rechazar) */
  const sinResponder = (o) => !!o && o.estado === "asignado" && o.estado_asignacion !== "aceptado" && o.estado_asignacion !== "rechazado";
  /* Responde al administrador: 'aceptado' | 'rechazado'. Devuelve true si se guardó. */
  async function responder(valor) {
    if (!orden || !id || !ctx) return false;
    if (valor === "rechazado" && !confirm("¿Rechazar este pedido? Se le avisará al administrador.")) return false;
    const tk = id;
    try {
      await ctx.db.ref("ordenes/" + tk).update({ estado_asignacion: valor, actualizado: O.TS });
    } catch (err) { alert("No se pudo enviar tu respuesta: " + err.message); return false; }
    if (valor === "rechazado") {
      const uid = ctx.uid && ctx.uid();
      if (uid) ctx.db.ref("guias/" + uid).remove().catch(() => {});   // quita la ruta que el administrador había marcado
    }
    return true;
  }
  /* Un pedido es "nuevo" la primera vez que esta app lo ve (se recuerda en el aparato para no repetir el aviso al reabrir) */
  function esNuevo(ordenId, o) {
    const clave = "ordenVista_" + ordenId;
    try { if (localStorage.getItem(clave)) return false; localStorage.setItem(clave, "1"); } catch (_) {}
    return o.estado === "asignado" && Date.now() - (o.creado || Date.now()) < 12 * 3600 * 1000;
  }
  /* Todos los detalles del pedido: precio grande (con IVA), cliente, retiros con su producto, entrega y notas */
  function detallesHtml(o, sinPrecio) {
    const ps = O.paradas(o);
    const retiros = ps.map((p, k) => `<div class="pd-det"><span>${p.retirado ? "✅" : "📦"} ${ps.length > 1 ? "Retiro " + (k + 1) + " de " + ps.length : "Retiro"}</span><b>${esc(p.texto || "—")}</b>${p.producto ? `<em>Retirar: ${esc(p.producto)}</em>` : ""}</div>`).join("");
    return `${sinPrecio ? "" : O.precioHtml(o)}<div class="pd-det-lista">
      <div class="pd-det"><span>👤 Cliente</span><b>${esc(o.cliente || "—")}</b></div>${retiros}
      <div class="pd-det"><span>🏠 Entrega</span><b>${esc((o.entrega && o.entrega.texto) || "—")}</b></div>
      ${o.paquete ? `<div class="pd-det"><span>📝 Detalles del paquete</span><b>${esc(o.paquete)}</b></div>` : ""}</div>`;
  }
  function detener() { if (ref) { ref.off(); ref = null; } id = null; orden = null; }
  function seguir(ordenId) {
    if (!ordenId || ordenId === id) return;
    detener(); id = ordenId;
    ref = ctx.db.ref("ordenes/" + id);
    ref.on("value", (s) => {
      const o = s.val(), tenia = !!orden;
      const rechazado = !!o && o.estado_asignacion === "rechazado";
      const a = o && o.asignacion, deOtro = !!(a && a.tipo === "registrado" && a.uid && ctx.uid && a.uid !== ctx.uid());   // el admin lo reasignó a otro
      orden = o && !rechazado && !deOtro && ["pendiente", "asignado", "retirado"].includes(o.estado) ? o : null;   // terminado, cancelado o rechazado: la tarjeta desaparece
      if (tenia && !orden && (rechazado || deOtro) && ctx.alRechazado) ctx.alRechazado();
      if (orden && esNuevo(id, orden) && ctx.alNuevo) ctx.alNuevo(id, orden);
      ctx.alCambiar();
    }, () => {});
  }
  function html() {
    if (!orden) return "";
    const [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.asignado, ps = O.paradas(orden), sig = O.siguienteRetiro(orden);
    const porResponder = sinResponder(orden);
    const ahora = porResponder ? "🔔 Pedido nuevo: ¿lo aceptas?" : sig ? `📦 Ahora: ${esc(sig.p.texto || "Retiro")}${sig.p.producto ? " — <b>" + esc(sig.p.producto) + "</b>" : ""}` : `🏠 Ahora: entregar en ${esc((orden.entrega && orden.entrega.texto) || "—")}`;
    return `<div class="pedido-card sel pd-card-adm${minimizada ? " min" : ""}" data-oa="1">
      <div class="pc-top"><span class="pc-num">📦</span>
        <div class="pc-datos"><strong>${esc(orden.codigo)} · ${esc(orden.cliente || "")}</strong></div>
        <span class="chip ${cls}">${txt}</span>
        <button class="mini pd-min-btn" data-oa="min" type="button" aria-label="${minimizada ? "Ver detalles" : "Ocultar detalles"}">${minimizada ? "▴" : "▾"}</button></div>
      ${O.precioHtml(orden)}
      <div class="pd-ahora">${ahora}</div>
      ${minimizada ? "" : detallesHtml(orden, true)}
      ${porResponder ? `<div class="pc-botones">
        <button class="peligro" data-oa="rechazar" type="button">✖ Rechazar</button>
        <button class="primario" data-oa="aceptar" type="button">✔ Aceptar</button>
      </div></div>` : `<div class="pc-botones">
        <button class="oscuro" data-oa="retirado" type="button" ${sig ? "" : "disabled"}>${sig ? "📦 Retirado" + (ps.length > 1 ? " (" + (sig.i + 1) + "/" + ps.length + ")" : "") : "📦 Todo retirado"}</button>
        <button class="primario" data-oa="entregado" type="button" ${sig ? "disabled" : ""}>✅ Entregado</button>
      </div></div>`}`;
  }
  /* Texto corto para la barra minimizada del mapa */
  function resumen() {
    if (!orden) return "";
    if (sinResponder(orden)) return `🔔 ${orden.codigo}: responder pedido`;
    const sig = O.siguienteRetiro(orden);
    return `📦 ${orden.codigo}: ` + (sig ? "retirar" + (sig.p.texto ? " en " + sig.p.texto : "") : "entregar al cliente");
  }
  /* Devuelve true si el toque era de esta tarjeta */
  function alClick(e) {
    const b = e.target.closest("button[data-oa]"), card = e.target.closest("[data-oa]");
    if (!card) return false;
    if (!b || !orden) return true;
    if (b.dataset.oa === "min") { minimizada = !minimizada; ctx.alCambiar(); return true; }   // ocultar / ver detalles
    if (b.dataset.oa === "aceptar") { responder("aceptado"); return true; }
    if (b.dataset.oa === "rechazar") { responder("rechazado"); return true; }
    if (sinResponder(orden)) return true;   // primero hay que aceptar el pedido
    const estado = b.dataset.oa, sig = O.siguienteRetiro(orden);
    if (estado === "retirado" && !sig) return true;
    const pregunta = estado === "retirado" ? `¿Confirmas que ya RETIRASTE${sig.p.producto ? " “" + sig.p.producto + "”" : ""}${sig.p.texto ? " en " + sig.p.texto : ""}?` : "¿Confirmas que ENTREGASTE el paquete?";
    if (!confirm(pregunta)) return true;
    const trabajo = estado === "retirado" ? O.marcarRetiro(ctx.db, id, orden, sig.i) : O.marcar(ctx.db, id, estado, orden);
    trabajo.then(() => { if (estado === "entregado") ctx.alEntregado(); }).catch((err) => alert("No se pudo actualizar: " + err.message));
    return true;
  }
  /* Tu posición también llega al cliente de este pedido (pedidos/{token}), igual que en los pedidos con factura */
  let ultPub = 0;
  function publicar(base) {
    if (!orden || !id || Date.now() - ultPub < 4000) return; ultPub = Date.now();
    const ped = Object.assign({}, base), ent = orden.entrega;
    if (O.valido(ent)) {
      ped.destLat = ent.lat; ped.destLng = ent.lng; ped.distancia = Math.round(O.distM(base, ent));
      if (!O.siguienteRetiro(orden)) ped.cerca = ped.distancia <= 200;
    }
    ctx.db.ref("pedidos/" + id).update(ped).catch(() => {});
  }
  return { init, seguir, detener, html, alClick, publicar, detallesHtml, responder, resumen, activo: () => !!orden };
})();
