/* ============================================================
   SUB-FACTURA DINÁMICA (Función 3) · UI del repartidor
   Permite agregar productos a un pedido en curso SIN tocar la factura original.
   Guarda en pedidos/{token}/subfactura:
     { etiqueta:"Adiciones del cliente", items:[{nombre,precio}], subtotal, envioExtra, ts }
   y lee pedidos/{token}/factura (la crea repartidor.js al enviar la factura):
     { subtotal, delivery, total }
   Desglose final:  Total Factura Original + Total Sub-factura + Envíos combinados = Gran Total
   ============================================================ */
const SubFactura = (() => {
  const ETIQUETA = "Adiciones del cliente";
  /* ⚙️ Ajuste según factura.js: ¿el "total" que entrega la factura YA incluye el delivery?
     (true = "Total a pagar" = subtotal + delivery, como en la pantalla de factura). */
  const TOTAL_INCLUYE_ENVIO = true;

  const n = (x) => (Number.isFinite(+x) ? +x : 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  const money = (x) => "C$ " + r2(x).toFixed(2);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);

  /* Foto de la factura original (se guarda al enviarla) */
  function instantanea(f) {
    const delivery = n(f.delivery), total = n(f.total);
    const subtotal = Number.isFinite(f.subtotal) ? f.subtotal : (TOTAL_INCLUYE_ENVIO ? Math.max(0, total - delivery) : total);
    return { subtotal: r2(subtotal), delivery: r2(delivery), total: r2(subtotal + delivery) };
  }

  /* Cálculo puro del desglose */
  function calcular(factura, sub) {
    const f = factura || {}, items = (sub && sub.items) || [];
    const original = n(f.subtotal), envioOrig = n(f.delivery);
    const totalSub = items.reduce((t, i) => t + n(i.precio), 0), envioExtra = n(sub && sub.envioExtra);
    const envios = envioOrig + envioExtra;
    return { original, totalSub, envioOrig, envioExtra, envios, gran: r2(original + totalSub + envios) };
  }

  const desgloseHtml = (c) => `<div class="pd-desglose">
      <div><span>Total Factura Original</span><b>${money(c.original)}</b></div>
      <div><span>+ Total Sub-factura</span><b>${money(c.totalSub)}</b></div>
      <div><span>+ Envíos combinados</span><b>${money(c.envios)}</b></div>
      <div style="font-size:12px;color:var(--texto2)"><span>(original ${money(c.envioOrig)} + extra ${money(c.envioExtra)})</span><span></span></div>
      <div class="gran"><span>= Gran Total</span><b>${money(c.gran)}</b></div></div>`;

  function mensaje(v, ctx, c, sub) {
    const lineas = (sub.items || []).map((i) => `• ${i.nombre} — ${money(n(i.precio))}`).join("\n");
    return `🧾 *SUB-FACTURA · ${ETIQUETA.toUpperCase()}*\n🏍️ Repartidor: ${ctx.usuario()}\n📦 Pedido ${v.pedido}${v.cliente ? " · " + v.cliente : ""}\n\n${lineas}\n` +
      `\nTotal sub-factura: ${money(c.totalSub)}\nEnvío extra: ${money(c.envioExtra)}\n\n` +
      `Factura original: ${money(c.original)}\nEnvíos combinados: ${money(c.envios)}\n*GRAN TOTAL: ${money(c.gran)}*`;
  }

  /* ---------- Ventana ---------- */
  function abrir(v, ctx) {
    let draft = { items: ((v.sub && v.sub.items) || []).map((i) => ({ nombre: i.nombre, precio: n(i.precio) })), envioExtra: n(v.sub && v.sub.envioExtra) };
    const refSub = ctx.db.ref(`pedidos/${v.token}/subfactura`);
    const guardar = () => {
      const subtotal = r2(draft.items.reduce((t, i) => t + i.precio, 0));
      const obj = { etiqueta: ETIQUETA, items: draft.items, subtotal, envioExtra: r2(draft.envioExtra), ts: firebase.database.ServerValue.TIMESTAMP };
      v.sub = obj;   // se ve al instante; la nube confirma después
      (draft.items.length || draft.envioExtra ? refSub.set(obj) : refSub.remove()).catch((e) => alert("No se pudo guardar la sub-factura: " + e.message));
      ctx.alCambiar && ctx.alCambiar(v);
    };
    const pintar = () => {
      const sub = { items: draft.items, envioExtra: draft.envioExtra }, c = calcular(v.factura, sub);
      $("subCab").innerHTML = `Pedido ${esc(v.pedido)}${v.cliente ? " · " + esc(v.cliente) : ""}`;
      $("subSinFactura").classList.toggle("oculto", !!v.factura);
      $("subItems").innerHTML = draft.items.length
        ? draft.items.map((i, k) => `<div class="pd-sub-item"><span>${esc(i.nombre)}</span><span><b>${money(i.precio)}</b> <button type="button" class="peligro" data-del="${k}" aria-label="Quitar ${esc(i.nombre)}">✕</button></span></div>`).join("")
        : '<p class="ayuda">Aún no hay productos adicionales.</p>';
      $("subDesglose").innerHTML = desgloseHtml(c);
      $("btnSubWa").disabled = !draft.items.length;
    };
    const agregar = () => {
      const nombre = $("subNombre").value.trim(), precio = parseFloat($("subPrecio").value);
      if (!nombre) return alert("Escribe el nombre del producto.");
      if (!(precio >= 0)) return alert("Escribe un precio válido.");
      draft.items.push({ nombre: nombre.slice(0, 60), precio: r2(precio) });
      $("subNombre").value = ""; $("subPrecio").value = ""; $("subNombre").focus();
      guardar(); pintar();
    };
    $("subEnvio").value = draft.envioExtra || "";
    $("subNombre").value = ""; $("subPrecio").value = "";
    $("btnSubAgregar").onclick = agregar;
    $("subPrecio").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); agregar(); } };
    $("subItems").onclick = (e) => {
      const b = e.target.closest("button[data-del]"); if (!b) return;
      draft.items.splice(+b.dataset.del, 1); guardar(); pintar();
    };
    $("subEnvio").oninput = () => { draft.envioExtra = Math.max(0, n($("subEnvio").value)); pintar(); };   // el desglose se recalcula mientras escribes
    $("subEnvio").onchange = guardar;
    $("btnSubWa").onclick = () => { const sub = { items: draft.items, envioExtra: draft.envioExtra }; ctx.wa(mensaje(v, ctx, calcular(v.factura, sub), sub)); };
    $("btnSubCerrar").onclick = () => { if (draft.envioExtra !== n(v.sub && v.sub.envioExtra)) guardar(); $("modalSub").classList.add("oculto"); };
    pintar();
    $("modalSub").classList.remove("oculto");
  }

  return { ETIQUETA, instantanea, calcular, money, abrir };
})();
