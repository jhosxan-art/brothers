/* ============================================================
   ORDENES-REPARTIDOR · pedido asignado por el administrador (repartidor registrado)
   - El admin asigna → guias/{uid} trae { ordenId } y la app ya traza la ruta al Retiro.
   - Aquí se sigue ese pedido en vivo y se ofrecen los botones Retirado / Entregado:
       Retirado  → la guía pasa sola al punto de Entrega (ruta nueva automática)
       Entregado → se limpia la guía y la ruta
   ============================================================ */
const OrdenAdminRep = (() => {
  const O = Ordenes, esc = O.esc;
  let ctx = null, sel = null, minimizada = false;
  const items = {};   // id → { id, ref, refPri, orden, prioridad, prioLista, avisoPri, detallePub, ultPub }
  const EXTRA_PRI = 10;   // C$ de propina por prioridad (pedidos/{id}/prioridad)
  const dinero = (n) => (O.money ? O.money(n) : "C$ " + Number(n || 0).toFixed(2));
  const baseTotal = (o) => (O.r2 ? O.r2(o.delivery) + O.r2(o.iva) : (Number(o.delivery) || 0) + (Number(o.iva) || 0));   // lo que cobra el repartidor sin propina

  const init = (c) => { ctx = c; };
  /* Varios pedidos del admin a la vez: los ids se recuerdan por repartidor para recuperarlos al reabrir la app */
  const claveGuardado = () => "ordenesAdm_" + ((ctx && ctx.uid && ctx.uid()) || "");
  const leerGuardados = () => { try { const v = JSON.parse(localStorage.getItem(claveGuardado()) || "[]"); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch (_) { return []; } };
  const guardar = () => { try { localStorage.setItem(claveGuardado(), JSON.stringify(Object.keys(items))); } catch (_) {} };
  const actual = () => (sel && items[sel] && items[sel].orden ? items[sel] : null);
  /* Orden cronológico por hora de entrada: el primero que entra es «Pedido #1» */
  const lista = () => Object.values(items).filter((it) => it.orden).sort((a, b) => ((a.orden.creado || 0) - (b.orden.creado || 0)) || (a.id < b.id ? -1 : 1));
  const numeroDe = (idOrden) => lista().findIndex((it) => it.id === idOrden) + 1;
  const etiquetaNum = (idOrden) => "Pedido #" + (numeroDe(idOrden) || 1);
  function elegir(idOrden, desdeUsuario) {
    if (!items[idOrden] || !items[idOrden].orden) return;
    const cambio = sel !== idOrden; sel = idOrden;
    if (ctx.alSeleccionar) ctx.alSeleccionar(idOrden, items[idOrden].orden, !!desdeUsuario, cambio);
    ctx.alCambiar();
  }
  /* Desliza al pedido anterior (-1) o siguiente (+1) y la ruta pasa al cliente activo */
  function cambiar(dir) {
    const l = lista(); if (l.length < 2) return;
    const i = Math.max(0, l.findIndex((it) => it.id === sel));
    elegir(l[(i + dir + l.length) % l.length].id, true);
  }
  function reenfocar() { const it = actual(); if (it && ctx.alSeleccionar) ctx.alSeleccionar(it.id, it.orden, false, false); }
  function soltarItem(it) {
    if (it.ref) it.ref.off(); if (it.refPri) it.refPri.off();
    delete items[it.id]; guardar();
    if (sel === it.id) { sel = null; const l = lista(); if (l.length) { sel = l[0].id; if (ctx.alSeleccionar) ctx.alSeleccionar(sel, l[0].orden, false, true); } }
  }
  /* Asignado por el administrador y todavía sin respuesta del repartidor (Aceptar / Rechazar) */
  const sinResponder = (o) => !!o && o.estado === "asignado" && o.estado_asignacion !== "aceptado" && o.estado_asignacion !== "rechazado";
  /* Responde al administrador: 'aceptado' | 'rechazado'. Devuelve true si se guardó. */
  async function responder(valor, idOrden) {
    const it = items[idOrden || sel], orden = it && it.orden, id = it && it.id;
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
  function detener() {
    Object.values(items).forEach((it) => { if (it.ref) it.ref.off(); if (it.refPri) it.refPri.off(); });
    Object.keys(items).forEach((k) => delete items[k]); sel = null;
  }
  /* Dispara la alerta una sola vez cuando ya se conocen la orden (código de factura) y la prioridad */
  function revisarPrioridad(it) {
    if (it.prioridad && !it.avisoPri && it.orden && ctx.alPrioridad) { it.avisoPri = true; ctx.alPrioridad(it.id, it.orden); }
  }
  /* Etiqueta visual + total con los 10 C$ de propina por prioridad */
  function prioridadHtml(it) {
    if (!it.prioridad) return "";
    return `<div class="pd-prio" style="margin:6px 0;padding:7px 10px;border-radius:10px;background:#FFF4E5;border:1.5px solid #F59E0B;color:#7c3a00;font-size:13px;font-weight:600;line-height:1.35"><span class="chip alerta">⚡ PRIORIDAD</span> +${dinero(EXTRA_PRI)} en concepto de propina por prioridad<br>Total a cobrar: <b>${dinero(baseTotal(it.orden) + EXTRA_PRI)}</b></div>`;
  }
  function seguir(ordenId) {
    if (!ordenId || items[ordenId]) return;
    const it = items[ordenId] = { id: ordenId, ref: null, refPri: null, orden: null, prioridad: false, prioLista: false, avisoPri: false, detallePub: null, ultPub: 0 };
    guardar();
    it.refPri = ctx.db.ref("pedidos/" + ordenId + "/prioridad");
    it.refPri.on("value", (s) => {
      it.prioridad = s.val() === true; it.prioLista = true;
      revisarPrioridad(it); ctx.alCambiar();
    }, () => {});
    it.ref = ctx.db.ref("ordenes/" + ordenId);
    it.ref.on("value", (s) => {
      if (items[ordenId] !== it) return;
      const o = s.val(), tenia = !!it.orden;
      const rechazado = !!o && o.estado_asignacion === "rechazado";
      const a = o && o.asignacion, deOtro = !!(a && a.tipo === "registrado" && a.uid && ctx.uid && a.uid !== ctx.uid());   // el admin lo reasignó a otro
      it.orden = o && !rechazado && !deOtro && ["pendiente", "asignado", "retirado"].includes(o.estado) ? o : null;   // terminado, cancelado o rechazado: la tarjeta desaparece
      if (!it.orden) {
        soltarItem(it);
        if (tenia && (rechazado || deOtro) && ctx.alRechazado) ctx.alRechazado();
        ctx.alCambiar(); return;
      }
      if (!sel) { sel = ordenId; if (ctx.alSeleccionar) ctx.alSeleccionar(ordenId, it.orden, false, true); }
      if (esNuevo(ordenId, it.orden) && ctx.alNuevo) ctx.alNuevo(ordenId, it.orden);
      revisarPrioridad(it);
      ctx.alCambiar();
    }, () => { if (items[ordenId] === it) { soltarItem(it); ctx.alCambiar(); } });   // sin permiso (ya no es mío): se olvida
  }
  /* Recupera los pedidos que seguía este repartidor (por si la guía ya cambió a otro pedido) */
  function restaurar() { leerGuardados().forEach(seguir); }
  function html() {
    const it = actual(); if (!it) return "";
    const orden = it.orden, id = it.id, l = lista(), n = l.length, pos = Math.max(0, l.findIndex((x) => x.id === id));
    const [txt, cls] = O.ESTADOS[orden.estado] || O.ESTADOS.asignado, ps = O.paradas(orden), sig = O.siguienteRetiro(orden);
    const porResponder = sinResponder(orden);
    const ahora = porResponder ? "🔔 Pedido nuevo: ¿lo aceptas?" : sig ? `📦 Ahora: ${esc(sig.p.texto || "Retiro")}${sig.p.producto ? " — <b>" + esc(sig.p.producto) + "</b>" : ""}` : `🏠 Ahora: entregar en ${esc((orden.entrega && orden.entrega.texto) || "—")}`;
    const pager = n > 1 ? `<div class="pc-pager" aria-label="Pedido ${pos + 1} de ${n}"><button type="button" data-oa="prev" aria-label="Pedido anterior">‹</button><span class="pc-dots">${l.map((x, j) => `<i class="${j === pos ? "on" : ""}"></i>`).join("")}</span><small>Pedido #${pos + 1} de ${n}</small><button type="button" data-oa="next" aria-label="Pedido siguiente">›</button></div>` : "";
    const facturada = !!(ctx.facturada && ctx.facturada(id));
    const btnFactura = porResponder ? "" : `<button class="boton-chat pd-fact" data-oa="factura" type="button" ${facturada ? "disabled" : ""}>${facturada ? "✅ Factura enviada" : "🧾 Facturar a " + esc(orden.cliente || "este cliente")}</button>`;
    return `<div class="pedido-card sel pd-card-adm${minimizada ? " min" : ""}" data-oa="1" data-orden="${esc(id)}">
      ${pager}
      <div class="pc-top"><span class="pc-num">#${pos + 1}</span>
        <div class="pc-datos"><span class="pc-ped">Pedido #${pos + 1}</span><strong>${esc(orden.codigo)} · ${esc(orden.cliente || "")}</strong></div>
        <span class="chip ${cls}">${txt}</span>
        <button class="mini pd-min-btn" data-oa="min" type="button" aria-label="${minimizada ? "Ver detalles" : "Ocultar detalles"}">${minimizada ? "▴" : "▾"}</button></div>
      ${O.precioHtml(orden)}
      ${prioridadHtml(it)}
      <div class="pd-ahora">${ahora}</div>
      ${minimizada ? "" : detallesHtml(orden, true)}
      ${porResponder ? `<div class="pc-botones">
        <button class="peligro" data-oa="rechazar" type="button">✖ Rechazar</button>
        <button class="primario" data-oa="aceptar" type="button">✔ Aceptar</button>
      </div></div>` : `${btnFactura}<div class="pc-botones">
        <button class="oscuro" data-oa="retirado" type="button" ${sig ? "" : "disabled"}>${sig ? "📦 Retirado" + (ps.length > 1 ? " (" + (sig.i + 1) + "/" + ps.length + ")" : "") : "📦 Todo retirado"}</button>
        <button class="primario" data-oa="entregado" type="button" ${sig ? "disabled" : ""}>✅ Entregado</button>
      </div></div>`}`;
  }
  /* Texto corto para la barra minimizada del mapa */
  function resumen() {
    const it = actual(); if (!it) return "";
    const orden = it.orden, n = lista().length, pre = n > 1 ? `Pedido #${numeroDe(it.id)}/${n} · ` : "";
    if (sinResponder(orden)) return `🔔 ${pre}${orden.codigo}: responder pedido`;
    const sig = O.siguienteRetiro(orden);
    return `📦 ${pre}${orden.codigo}: ` + (sig ? "retirar" + (sig.p.texto ? " en " + sig.p.texto : "") : "entregar al cliente");
  }
  /* Devuelve true si el toque era de esta tarjeta */
  function alClick(e) {
    const b = e.target.closest("button[data-oa]"), card = e.target.closest("[data-oa]");
    if (!card) return false;
    const it = actual();
    if (!b || !it) return true;
    const orden = it.orden, id = it.id;
    if (b.dataset.oa === "prev") { cambiar(-1); return true; }
    if (b.dataset.oa === "next") { cambiar(1); return true; }
    if (b.dataset.oa === "min") { minimizada = !minimizada; ctx.alCambiar(); return true; }   // ocultar / ver detalles
    if (b.dataset.oa === "aceptar") { responder("aceptado", id); return true; }
    if (b.dataset.oa === "rechazar") { responder("rechazado", id); return true; }
    if (sinResponder(orden)) return true;   // primero hay que aceptar el pedido
    if (b.dataset.oa === "factura") { if (ctx.abrirFactura) ctx.abrirFactura(id, orden); return true; }   // factura de ESTE cliente
    const estado = b.dataset.oa, sig = O.siguienteRetiro(orden);
    if (estado === "retirado" && !sig) return true;
    const idPed = id, ordPed = orden;
    const ejecutar = () => {
      const trabajo = estado === "retirado" ? O.marcarRetiro(ctx.db, idPed, ordPed, sig.i) : O.marcar(ctx.db, idPed, estado, ordPed);
      trabajo.then(() => { if (estado === "entregado") ctx.alEntregado(); }).catch((err) => alert("No se pudo actualizar: " + err.message));
    };
    if (estado === "entregado") {
      /* Pago post-entrega obligatorio: Efectivo o Transferencia (la transferencia va a la bandeja de cobros al admin) */
      Promise.resolve(typeof ctx.pedirPago === "function" ? ctx.pedirPago({ id: idPed, orden: ordPed }) : (confirm("¿Confirmas que ENTREGASTE el paquete?") ? "efectivo" : null)).then((pago) => { if (pago) ejecutar(); });
      return true;
    }
    const pregunta = `¿Confirmas que ya RETIRASTE${sig.p.producto ? " “" + sig.p.producto + "”" : ""}${sig.p.texto ? " en " + sig.p.texto : ""}?`;
    if (!confirm(pregunta)) return true;
    ejecutar();
    return true;
  }
  /* Tu posición también llega al cliente de cada pedido activo (pedidos/{token}), igual que en los pedidos con factura */
  function publicar(base) {
    Object.values(items).forEach((it) => {
      const orden = it.orden, id = it.id;
      if (!orden || Date.now() - it.ultPub < 4000) return; it.ultPub = Date.now();
      const ped = Object.assign({}, base), ent = orden.entrega;
      if (O.valido(ent)) {
        ped.destLat = ent.lat; ped.destLng = ent.lng; ped.distancia = Math.round(O.distM(base, ent));
        if (!O.siguienteRetiro(orden)) ped.cerca = ped.distancia <= 200;
      }
      if (it.prioLista && it.detallePub !== id) {   // desglose inicial para la app del cliente (una vez por pedido; el total ya incluye la propina si el cliente priorizó)
        it.detallePub = id;
        const bt = baseTotal(orden);
        const prods = O.paradas(orden).filter((p) => p.producto).map((p) => ({ nombre: String(p.producto).slice(0, 80) }));
        if (!prods.length && orden.paquete) prods.push({ nombre: String(orden.paquete).slice(0, 80) });
        const det = { delivery: bt, totalBase: bt, total: Math.round((bt + (it.prioridad ? EXTRA_PRI : 0)) * 100) / 100 };
        if (prods.length) det.productos = prods;
        if (it.prioridad) det.prioridad = EXTRA_PRI;
        /* Transacción: solo escribe si todavía NO hay detalle. Así nunca pisa la factura real (productos con precio + delivery) que ya envió el repartidor. */
        ctx.db.ref("pedidos/" + id + "/detalle").transaction((cur) => (cur ? undefined : det)).catch(() => {});
      }
      ctx.db.ref("pedidos/" + id).update(ped).catch(() => {});
    });
  }
  return { init, seguir, restaurar, detener, html, alClick, publicar, detallesHtml, responder, resumen, cambiar, seleccionar: (i) => elegir(i, false), reenfocar, idSel: () => (actual() ? sel : null), cantidad: () => lista().length, numero: numeroDe, etiqueta: etiquetaNum, activo: () => lista().length > 0 };
})();
