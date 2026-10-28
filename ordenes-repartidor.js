/* ============================================================
   ORDENES-REPARTIDOR · pedido asignado por el administrador (repartidor registrado)
   - El admin asigna → guias/{uid} trae { ordenId } y la app ya traza la ruta al Retiro.
   - Aquí se sigue ese pedido en vivo y se ofrecen los botones Retirado / Entregado:
       Retirado  → la guía pasa sola al punto de Entrega (ruta nueva automática)
       Entregado → se limpia la guía y la ruta
   ============================================================ */
const OrdenAdminRep = (() => {
  const O = Ordenes, esc = O.esc;
  let ctx = null, id = null, ref = null, orden = null;

  const init = (c) => { ctx = c; };
  function detener() { if (ref) { ref.off(); ref = null; } id = null; orden = null; }
  function seguir(ordenId) {
    if (!ordenId || ordenId === id) return;
    detener(); id = ordenId;
    ref = ctx.db.ref("ordenes/" + id);
    ref.on("value", (s) => {
      const o = s.val();
      orden = o && ["pendiente", "asignado", "retirado"].includes(o.estado) ? o : null;   // terminado o cancelado: la tarjeta desaparece
      ctx.alCambiar();
    }, () => {});
  }
  function html() {
    if (!orden) return "";
    const [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.asignado, ret = orden.estado === "retirado";
    return `<div class="pedido-card sel" data-oa="1">
      <div class="pc-top"><span class="pc-num">📦</span>
        <div class="pc-datos"><strong>${esc(orden.codigo)} · ${esc(orden.cliente || "")}</strong>
          <small>Retiro: ${esc((orden.retiro && orden.retiro.texto) || "—")}</small><small>Entrega: ${esc((orden.entrega && orden.entrega.texto) || "—")}</small>
          ${orden.paquete ? `<small>📝 ${esc(orden.paquete)}</small>` : ""}</div>
        <span class="chip ${cls}">${txt}</span></div>
      <div class="pc-botones">
        <button class="oscuro" data-oa="retirado" type="button" ${ret ? "disabled" : ""}>📦 Retirado</button>
        <button class="primario" data-oa="entregado" type="button" ${ret ? "" : "disabled"}>✅ Entregado</button>
      </div></div>`;
  }
  /* Devuelve true si el toque era de esta tarjeta */
  function alClick(e) {
    const b = e.target.closest("button[data-oa]"), card = e.target.closest("[data-oa]");
    if (!card) return false;
    if (!b || !orden) return true;
    const estado = b.dataset.oa;
    if (!confirm(estado === "retirado" ? "¿Confirmas que ya RETIRASTE el paquete?" : "¿Confirmas que ENTREGASTE el paquete?")) return true;
    O.marcar(ctx.db, id, estado, orden).then(() => { if (estado === "entregado") ctx.alEntregado(); }).catch((err) => alert("No se pudo actualizar: " + err.message));
    return true;
  }
  return { init, seguir, detener, html, alClick };
})();
