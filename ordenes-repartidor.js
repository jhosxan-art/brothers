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
    const [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.asignado, ps = O.paradas(orden), sig = O.siguienteRetiro(orden);
    const lista = ps.map((p, k) => `<small>${p.retirado ? "✅" : "📦"} ${ps.length > 1 ? "Retiro " + (k + 1) + ": " : "Retiro: "}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}</small>`).join("");
    return `<div class="pedido-card sel" data-oa="1">
      <div class="pc-top"><span class="pc-num">📦</span>
        <div class="pc-datos"><strong>${esc(orden.codigo)} · ${esc(orden.cliente || "")}</strong>
          ${lista}<small>🏠 Entrega: ${esc((orden.entrega && orden.entrega.texto) || "—")}</small>
          ${orden.delivery ? `<small>🛵 Delivery: <b>${O.money(orden.delivery)}</b></small>` : ""}
          ${orden.paquete ? `<small>📝 ${esc(orden.paquete)}</small>` : ""}</div>
        <span class="chip ${cls}">${txt}</span></div>
      <div class="pc-botones">
        <button class="oscuro" data-oa="retirado" type="button" ${sig ? "" : "disabled"}>${sig ? "📦 Retirado" + (ps.length > 1 ? " (" + (sig.i + 1) + "/" + ps.length + ")" : "") : "📦 Todo retirado"}</button>
        <button class="primario" data-oa="entregado" type="button" ${sig ? "disabled" : ""}>✅ Entregado</button>
      </div></div>`;
  }
  /* Devuelve true si el toque era de esta tarjeta */
  function alClick(e) {
    const b = e.target.closest("button[data-oa]"), card = e.target.closest("[data-oa]");
    if (!card) return false;
    if (!b || !orden) return true;
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
  return { init, seguir, detener, html, alClick, publicar };
})();
