/* ============================================================
   MANDADO EXTRA · UI del repartidor (antes "Sub-factura")
   FASE 3 · Se renombra conceptualmente de "Sub-factura / Adiciones
   del cliente" a "Mandado Extra / Compras o tareas adicionales",
   para alinearlo con el botón "Mandado Extra" del chat.
   Sigue guardando en pedidos/{token}/subfactura:
     { etiqueta:"Mandado Extra", items:[{nombre,precio}], subtotal,
       envioExtra, ts }
   Desglose final:  Total Factura Original + Total Mandado Extra + Envíos combinados = Gran Total
   ============================================================ */
const SubFactura = (() => {
  const ETIQUETA = "Mandado Extra";
  const TOTAL_INCLUYE_ENVIO = true;

  const n = (x) => (Number.isFinite(+x) ? +x : 0);
  const r2 = (x) => Math.round(x * 100) / 100;
  const money = (x) => "C$ " + r2(x).toFixed(2);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const $ = (id) => document.getElementById(id);

  function instantanea(f) {
    const delivery = n(f.delivery), total = n(f.total);
    const subtotal = Number.isFinite(f.subtotal) ? f.subtotal : (TOTAL_INCLUYE_ENVIO ? Math.max(0, total - delivery) : total);
    return { subtotal: r2(subtotal), delivery: r2(delivery), total: r2(subtotal + delivery) };
  }

  function calcular(factura, sub) {
    const f = factura || {}, items = (sub && sub.items) || [];
    const original = n(f.subtotal), envioOrig = n(f.delivery);
    const totalSub = items.reduce((t, i) => t + n(i.precio), 0), envioExtra = n(sub && sub.envioExtra);
    const envios = envioOrig + envioExtra;
    return { original, totalSub, envioOrig, envioExtra, envios, gran: r2(original + totalSub + envios) };
  }

  const desgloseHtml = (c) => `<div class="pd-desglose">
      <div><span>Total Factura Original</span><b>${money(c.original)}</b></div>
      <div><span>+ Total Mandado Extra</span><b>${money(c.totalSub)}</b></div>
      <div><span>+ Envíos combinados</span><b>${money(c.envios)}</b></div>
      <div style="font-size:12px;color:var(--texto2)"><span>(original ${money(c.envioOrig)} + extra ${money(c.envioExtra)})</span><span></span></div>
      <div class="gran"><span>= Gran Total</span><b>${money(c.gran)}</b></div></div>`;

  function mensaje(v, ctx, c, sub) {
    const lineas = (sub.items || []).map((i) => `• ${i.nombre} — ${money(n(i.precio))}`).join("\n");
    return `🧾 *MANDADO EXTRA*\n🏍️ Repartidor: ${ctx.usuario()}\n📦 Pedido ${v.pedido}${v.cliente ? " · " + v.cliente : ""}\n\n${lineas}\n` +
      `\nTotal mandado extra: ${money(c.totalSub)}\nEnvío extra: ${money(c.envioExtra)}\n\n` +
      `Factura original: ${money(c.original)}\nEnvíos combinados: ${money(c.envios)}\n*GRAN TOTAL: ${money(c.gran)}*`;
  }

  function abrir(v, ctx) {
    let draft = { items: ((v.sub && v.sub.items) || []).map((i) => ({ nombre: i.nombre, precio: n(i.precio) })), envioExtra: n(v.sub && v.sub.envioExtra) };
    const refSub = ctx.db.ref(ctx.rutaSub || `pedidos/${v.token}/subfactura`);
    const guardar = () => {
      const subtotal = r2(draft.items.reduce((t, i) => t + i.precio, 0));
      const obj = { etiqueta: ETIQUETA, items: draft.items, subtotal, envioExtra: r2(draft.envioExtra), ts: firebase.database.ServerValue.TIMESTAMP };
      v.sub = obj;
      (draft.items.length || draft.envioExtra ? refSub.set(obj) : refSub.remove()).catch((e) => alert("No se pudo guardar el mandado extra: " + e.message));
      ctx.alCambiar && ctx.alCambiar(v);
    };
    const pintar = () => {
      const sub = { items: draft.items, envioExtra: draft.envioExtra }, c = calcular(v.factura, sub);
      $("subCab").innerHTML = `Pedido ${esc(v.pedido)}${v.cliente ? " · " + esc(v.cliente) : ""}`;
      $("subSinFactura").classList.toggle("oculto", !!v.factura);
      $("subItems").innerHTML = draft.items.length
        ? draft.items.map((i, k) => `<div class="pd-sub-item"><span>${esc(i.nombre)}</span><span><b>${money(i.precio)}</b> <button type="button" class="peligro" data-del="${k}" aria-label="Quitar ${esc(i.nombre)}">✕</button></span></div>`).join("")
        : '<p class="ayuda">Aún no hay tareas ni compras adicionales.</p>';
      $("subDesglose").innerHTML = desgloseHtml(c);
      $("btnSubWa").disabled = !draft.items.length;
    };
    const agregar = () => {
      const nombre = $("subNombre").value.trim(), precio = parseFloat($("subPrecio").value);
      if (!nombre) return alert("Escribe el nombre de la tarea o producto.");
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
    $("subEnvio").oninput = () => { draft.envioExtra = Math.max(0, n($("subEnvio").value)); pintar(); };
    $("subEnvio").onchange = guardar;
    const btnEnviar = $("btnSubWa");
    if (btnEnviar.dataset.txt === undefined) btnEnviar.dataset.txt = btnEnviar.textContent;
    btnEnviar.textContent = ctx.enviarChat ? "💬 Enviar mandado al chat del cliente" : btnEnviar.dataset.txt;
    btnEnviar.onclick = async () => {
      const sub = { items: draft.items, envioExtra: draft.envioExtra }, c = calcular(v.factura, sub);
      if (!ctx.enviarChat) return ctx.wa(mensaje(v, ctx, c, sub));
      btnEnviar.disabled = true;
      try { await ctx.enviarChat(c, sub); $("modalSub").classList.add("oculto"); }
      catch (e) { alert("No se pudo enviar al chat: " + (e.message || e)); }
      btnEnviar.disabled = !draft.items.length;
    };
    $("btnSubCerrar").onclick = () => { if (draft.envioExtra !== n(v.sub && v.sub.envioExtra)) guardar(); $("modalSub").classList.add("oculto"); };
    pintar();
    $("modalSub").classList.remove("oculto");
  }

  return { ETIQUETA, instantanea, calcular, money, abrir };
})();

/* ============================================================
   CONTABILIDAD UNIFICADA · FASE 2
   Nodo único en Firebase:  contabilidad/{uid}/{idEntrega}
   Fuentes (campo "origen"):
     "chat"     → Chat tipo WhatsApp (solicitudes_entrantes)
     "admin"    → Pedido enviado por el Admin (ordenes + pedidos)
     "manual"   → Factura creada a mano en "Crear Factura" (pedidos)
     "invitado" → Repartidor invitado (ordenes + pedidos)

   Fórmula:
     P_base  = costo del DELIVERY base (NO incluye el costo de los productos, ni mandados extra, ni prioridad)
     E       = mandados extra de delivery (botón +C$10/+C$20, envío extra de la subfactura, extras del admin);
               el costo de los productos/compras NUNCA entra en la contabilidad
     F       = deducción fija = (7 si P_base < 200 · 14 si 200 ≤ P_base ≤ 400 · 28 si P_base > 400)
               + IVAs extras × 7   (cada IVA extra vale C$ 7 y se indica en "Crear Factura")
     R_base  = P_base − F            (mínimo 0)
     Bolsa   = R_base + E
     Repartidor (70 %)  = Bolsa × 0.70
     Empresa            = F + Bolsa × 0.30
   La prioridad (propina) se guarda aparte y NO entra en la bolsa.
   Un pedido sin factura/monto (P_base = 0 y E = 0) se registra en cero.
   ============================================================ */
const Contabilidad = (() => {
  const RAIZ = "contabilidad";
  const n = (x) => (Number.isFinite(+x) ? +x : 0);
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const cortar = (s, k) => String(s == null ? "" : s).slice(0, k);
  const registradas = new Set();

  function fijo(pBase) {
    const p = n(pBase);
    if (p < 200) return 7;
    if (p <= 400) return 14;
    return 28;
  }

  const IVA_VALOR = 7;
  const nIvas = (k) => { const v = Math.floor(n(k)); return v > 0 ? Math.min(v, 20) : 0; };

  function calcular(pBase, extras, ivasExtras) {
    const P = Math.max(0, r2(pBase)), E = Math.max(0, r2(extras)), I = nIvas(ivasExtras);
    if (P === 0 && E === 0) return { base: 0, extras: 0, fijoBase: 0, ivasExtras: 0, ivasMonto: 0, fijo: 0, rBase: 0, bolsa: 0, repartidor: 0, empresa: 0, bruto: 0 };
    const FB = fijo(P), IM = I * IVA_VALOR, F = FB + IM, rBase = Math.max(0, r2(P - F)), bolsa = r2(rBase + E);
    return { base: P, extras: E, fijoBase: FB, ivasExtras: I, ivasMonto: IM, fijo: F, rBase, bolsa, repartidor: r2(bolsa * 0.70), empresa: r2(F + bolsa * 0.30), bruto: r2(P + E) };
  }

  /* Día de negocio (corte a las 08:00, igual que Factura.diaNegocio) en formato ISO yyyy-mm-dd */
  function fechaISO(ts) {
    const t = new Date(ts || Date.now());
    if (t.getHours() < 8) t.setDate(t.getDate() - 1);
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }

  /* Facturas enviadas al chat: base = primera factura, actual = factura acumulada con mandados */
  function desdeFacturas(base, actual) {
    const b = base || actual;
    if (!b) return { pBase: 0, extras: 0, prioridad: 0, ivasExtras: 0, sinFactura: true };
    /* Solo delivery: factura.delivery = delivery base + mandado extra; los productos (subtotal) se ignoran */
    const a = actual || b;
    const deliveryBase = (f) => (f.deliveryBase != null ? n(f.deliveryBase) : Math.max(0, n(f.delivery) - n(f.mandadoExtra)));
    return { pBase: Math.max(0, r2(deliveryBase(a))), extras: Math.max(0, r2(n(a.mandadoExtra))), prioridad: n(a.prioridad), ivasExtras: nIvas(a.ivasExtras != null ? a.ivasExtras : b.ivasExtras), sinFactura: false };
  }

  /* Nodo pedidos/{token}: detalle + subfactura + extras del admin, SOLO delivery (sin costo de productos). fallbackBase = precio del delivery si no hubo factura */
  function desdePedido(p, fallbackBase) {
    const x = p && typeof p === "object" ? p : {}, det = x.detalle && typeof x.detalle === "object" ? x.detalle : null;
    const fac = x.factura && typeof x.factura === "object" ? x.factura : null, sub = x.subfactura && typeof x.subfactura === "object" ? x.subfactura : null;
    let pBase = 0, extras = 0, prioridad = 0, ivasExtras = 0, sinFactura = false;
    if (det) {
      ivasExtras = nIvas(det.ivasExtras);
      const entrega = det.deliveryBase != null ? n(det.deliveryBase) : Math.max(0, n(det.delivery) - n(det.mandadoExtra));
      pBase = entrega; /* solo delivery, sin el subtotal de productos */
      extras += n(det.mandadoExtra);
      prioridad = n(det.prioridad);
    } else if (fac) {
      pBase = n(fac.delivery); /* solo delivery, sin el subtotal de productos */
    } else { pBase = n(fallbackBase); sinFactura = true; }
    if (sub) {
      const items = sub.items ? (Array.isArray(sub.items) ? sub.items : Object.values(sub.items)) : [];
      extras += n(sub.envioExtra); /* los items (compras/productos) no entran; solo el envío extra */
    }
    if (x.extras && typeof x.extras === "object") extras += Object.values(x.extras).reduce((t, e) => t + n(e && e.monto), 0);
    return { pBase: r2(pBase), extras: r2(extras), prioridad: r2(prioridad), ivasExtras, sinFactura };
  }

  /* Escribe una única vez la entrega en el nodo histórico unificado (clave = id de la entrega). */
  async function registrar(db, uid, r) {
    if (!db || !uid || !r || !r.id) return null;
    const clave = uid + "/" + r.id;
    if (registradas.has(clave)) return null;
    registradas.add(clave);
    const ref = db.ref(RAIZ + "/" + uid + "/" + r.id);
    try {
      /* Si las reglas no dejan leer este nodo (p. ej. invitado), se escribe igual: la regla solo permite crear, no sobrescribir. */
      try { if ((await ref.once("value")).exists()) return null; }
      catch (e) { if (!(e && e.code === "PERMISSION_DENIED")) throw e; }
      const c = calcular(r.pBase, r.extras, r.ivasExtras), ahora = Date.now();
      const obj = JSON.parse(JSON.stringify({
        id: String(r.id), origen: r.origen, repartidorUid: uid, repartidorNombre: cortar(r.repartidorNombre, 60),
        cliente: cortar(r.cliente, 60), pedido: cortar(r.pedido, 30),
        base: c.base, extras: c.extras, fijoBase: c.fijoBase, ivasExtras: c.ivasExtras, ivasMonto: c.ivasMonto, fijo: c.fijo, rBase: c.rBase, bolsa: c.bolsa,
        gananciaRepartidor: c.repartidor, comisionEmpresa: c.empresa, bruto: c.bruto,
        prioridad: r2(r.prioridad), sinFactura: !!r.sinFactura,
        ts: firebase.database.ServerValue.TIMESTAMP, tsLocal: ahora, fecha: fechaISO(ahora), iso: new Date(ahora).toISOString()
      }));
      await ref.set(obj);
      return obj;
    } catch (e) {
      registradas.delete(clave);
      console.warn("[contabilidad] no se pudo registrar la entrega", r.id, e && (e.code || e.message));
      return null;
    }
  }

  return { RAIZ, fijo, calcular, fechaISO, desdeFacturas, desdePedido, registrar };
})();

/* ============================================================
   PANEL CONTABLE · FASE 3
   Interfaz unificada de "Facturas entregadas" (Chat · Admin · Manual · Invitado).
   Lee contabilidad/{uid} (nodo de la Fase 2) en tiempo real, filtra por la
   fecha de negocio guardada en cada entrega (campo "fecha", yyyy-mm-dd) y
   recalcula el resumen y el listado cada vez que cambia el rango o llega
   una entrega nueva.
   Uso:  PanelContable.montar({ db, uid, contenedor, rangoInicial?, ocultarSiError?, alFallar?, editablePago? })
         PanelContable.detener()
   ============================================================ */
const PanelContable = (() => {
  const n = (x) => (Number.isFinite(+x) ? +x : 0);
  const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
  const dinero = (x) => "C$ " + r2(x).toFixed(2);
  const pad = (x) => String(x).padStart(2, "0");
  const iso = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
  const deISO = (s) => { const p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2], 12); };
  const bonita = (s) => { const p = String(s || "").split("-"); return p.length === 3 ? p[2] + "/" + p[1] + "/" + p[0] : "—"; };
  const hora = (ts) => { try { return new Date(ts).toLocaleTimeString("es-NI", { hour: "2-digit", minute: "2-digit" }); } catch (_) { return ""; } };
  const ORIGENES = { chat: ["💬", "Chat"], admin: ["📦", "Admin"], manual: ["🧾", "Manual"], invitado: ["👤", "Invitado"] };
  const PAGOS = { efectivo: "💵 Efectivo", transferencia: "🏦 Transferencia" };
  const RAPIDOS = [["hoy", "Hoy"], ["semana", "Esta Semana"], ["quincena", "Esta Quincena"], ["mes", "Este Mes"]];

  function h(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto != null) e.textContent = texto;
    return e;
  }

  /* Rango [inicio, fin] (yyyy-mm-dd) de un filtro rápido. La semana va de lunes a domingo. */
  function rangoRapido(clave) {
    const hoy = Contabilidad.fechaISO(Date.now()), d = deISO(hoy), y = d.getFullYear(), m = d.getMonth(), dia = d.getDate();
    const ultimo = new Date(y, m + 1, 0).getDate();
    if (clave === "hoy") return [hoy, hoy];
    if (clave === "semana") { const dow = (d.getDay() + 6) % 7; return [iso(new Date(y, m, dia - dow, 12)), iso(new Date(y, m, dia - dow + 6, 12))]; }
    if (clave === "quincena") return dia <= 15 ? [iso(new Date(y, m, 1, 12)), iso(new Date(y, m, 15, 12))] : [iso(new Date(y, m, 16, 12)), iso(new Date(y, m, ultimo, 12))];
    return [iso(new Date(y, m, 1, 12)), iso(new Date(y, m, ultimo, 12))];
  }

  /* Totales del conjunto de entregas ya filtrado */
  function totalizar(a) {
    const t = { bruto: 0, repartidor: 0, empresa: 0, cuenta: a.length };
    a.forEach((x) => { t.bruto += n(x.bruto != null ? x.bruto : n(x.base) + n(x.extras)); t.repartidor += n(x.gananciaRepartidor); t.empresa += n(x.comisionEmpresa); });
    t.bruto = r2(t.bruto); t.repartidor = r2(t.repartidor); t.empresa = r2(t.empresa);
    return t;
  }

  function fila(k, v, clase) {
    const f = h("div", "pc-fila" + (clase ? " " + clase : ""));
    f.appendChild(h("span", "", k)); f.appendChild(h("b", "", v));
    return f;
  }

  function tarjeta(x, ctx) {
    const o = ORIGENES[x.origen] || ["🧾", "Factura"];
    const t = h("div", "pc-item"), cab = h("div", "pc-item-cab");
    cab.appendChild(h("span", "pc-origen pc-origen-" + (ORIGENES[x.origen] ? x.origen : "otro"), o[0] + " " + o[1]));
    const dat = h("div", "pc-item-dat");
    dat.appendChild(h("strong", "", x.cliente || "Cliente"));
    dat.appendChild(h("small", "", (x.pedido ? x.pedido + " · " : "") + hora(x.tsLocal || x.ts) + (x.sinFactura ? " · sin factura" : "") + (PAGOS[x.metodoPago] ? " · " + PAGOS[x.metodoPago] : "")));
    cab.appendChild(dat);
    cab.appendChild(h("span", "pc-item-total", dinero(x.bruto != null ? x.bruto : n(x.base) + n(x.extras))));
    t.appendChild(cab);
    const des = h("div", "pc-desglose3");
    [["Delivery", dinero(x.base)], ["Extras", dinero(x.extras)], ["Ganancia neta", dinero(x.gananciaRepartidor)]].forEach((p, i) => {
      const c = h("div", i === 2 ? "neta" : "");
      c.appendChild(h("small", "", p[0])); c.appendChild(h("b", "", p[1]));
      des.appendChild(c);
    });
    t.appendChild(des);
    if (ctx && (ctx.editable || PAGOS[x.metodoPago])) {
      const pago = h("div", "pc-pago");
      pago.appendChild(h("small", "", "Forma de pago"));
      Object.keys(PAGOS).forEach((k) => {
        if (!ctx.editable && x.metodoPago !== k) return;
        const b = h("button", "pc-pago-btn pc-pago-" + k + (x.metodoPago === k ? " activo" : ""), PAGOS[k]);
        b.type = "button"; b.disabled = !ctx.editable; b.setAttribute("aria-pressed", x.metodoPago === k ? "true" : "false");
        if (ctx.editable) b.addEventListener("click", () => {
          b.disabled = true;
          ctx.db.ref(RAIZ + "/" + ctx.uid + "/" + (x.id || "") + "/metodoPago").set(x.metodoPago === k ? null : k)
            .catch((err) => { b.disabled = false; alert("No se pudo guardar la forma de pago: " + ((err && (err.code || err.message)) || "error")); });
        });
        pago.appendChild(b);
      });
      if (ctx.editable && !PAGOS[x.metodoPago]) pago.appendChild(h("em", "pc-pago-sin", "Sin indicar"));
      t.appendChild(pago);
    }
    const det = document.createElement("details");
    det.appendChild(h("summary", "", "Ver cálculo"));
    const cal = h("div", "pc-calculo");
    cal.appendChild(fila("Delivery base", dinero(x.base)));
    const ivM = n(x.ivasMonto), fBase = x.fijoBase != null ? n(x.fijoBase) : Math.max(0, n(x.fijo) - ivM);
    cal.appendChild(fila(ivM > 0 ? "Deducción fija por rango" : "Deducción fija", "− " + dinero(fBase)));
    if (ivM > 0) {
      cal.appendChild(fila("IVAs extras (" + n(x.ivasExtras) + " × C$ 7)", "− " + dinero(ivM)));
      cal.appendChild(fila("Deducción fija total", "− " + dinero(x.fijo)));
    }
    cal.appendChild(fila("Base tras rebajo", dinero(x.rBase)));
    cal.appendChild(fila("+ Mandados extra", dinero(x.extras)));
    cal.appendChild(fila("Bolsa a repartir", dinero(x.bolsa), "sep"));
    cal.appendChild(fila("Ganancia repartidor (70 %)", dinero(x.gananciaRepartidor), "verde"));
    cal.appendChild(fila("Comisión Brother’s Deliverys", dinero(x.comisionEmpresa), "rojo"));
    if (n(x.prioridad) > 0) cal.appendChild(fila("Prioridad (aparte, no entra en la bolsa)", dinero(x.prioridad)));
    det.appendChild(cal);
    t.appendChild(det);
    return t;
  }

  let est = null;

  function detener() {
    if (!est) return;
    if (est.q && est.cb) { try { est.q.off("value", est.cb); } catch (_) {} }
    try { est.cont.textContent = ""; } catch (_) {}
    est = null;
  }

  function montar(op) {
    const cont = op && op.contenedor;
    if (!cont || !op.db || !op.uid) return null;
    if (est && est.uid === op.uid && est.cont === cont && cont.isConnected && cont.firstChild) return est;
    detener();
    cont.textContent = "";
    const e = { uid: op.uid, cont, db: op.db, q: null, cb: null, items: [], error: null, cargado: false, clave: RAPIDOS.some((r) => r[0] === op.rangoInicial) ? op.rangoInicial : "hoy", desde: "", hasta: "" };
    est = e;

    const panel = h("div", "pc-panel");
    const resumen = h("div", "pc-resumen");
    const tarjetasRes = {};
    [["bruto", "Total Realizado en Pedidos"], ["repartidor", "Ganancia Neta Repartidor"], ["empresa", "Comisión Brother’s Deliverys"], ["cuenta", "Total de Pedidos Realizados"]].forEach((p) => {
      const c = h("div", "pc-res pc-res-" + p[0]);
      c.appendChild(h("small", "", p[1]));
      tarjetasRes[p[0]] = h("b", "", "—");
      c.appendChild(tarjetasRes[p[0]]);
      resumen.appendChild(c);
    });
    panel.appendChild(resumen);

    const filtros = h("div", "pc-filtros");
    const rapidos = h("div", "pc-rapidos");
    rapidos.setAttribute("role", "group"); rapidos.setAttribute("aria-label", "Filtro rápido por fecha");
    const botones = {};
    RAPIDOS.forEach((r) => {
      const b = h("button", "pc-rap", r[1]); b.type = "button"; b.dataset.rango = r[0];
      botones[r[0]] = b; rapidos.appendChild(b);
    });
    filtros.appendChild(rapidos);
    const rango = h("div", "pc-rango");
    const l1 = h("label", "", "Fecha Inicio"), i1 = document.createElement("input");
    const l2 = h("label", "", "Fecha Fin"), i2 = document.createElement("input");
    i1.type = "date"; i2.type = "date"; i1.setAttribute("aria-label", "Fecha de inicio"); i2.setAttribute("aria-label", "Fecha de fin");
    l1.appendChild(i1); l2.appendChild(i2);
    rango.appendChild(l1); rango.appendChild(l2);
    filtros.appendChild(rango);
    const txtRango = h("p", "pc-rango-txt");
    filtros.appendChild(txtRango);
    panel.appendChild(filtros);

    const lista = h("div", "pc-lista");
    lista.setAttribute("aria-live", "polite");
    panel.appendChild(lista);
    cont.appendChild(panel);

    const limites = () => e.clave === "personalizado"
      ? (() => { let a = e.desde || "0000-01-01", b = e.hasta || "9999-12-31"; if (a > b) { const t = a; a = b; b = t; } return [a, b]; })()
      : rangoRapido(e.clave);

    function pintar() {
      const [a, b] = limites();
      Object.keys(botones).forEach((k) => { botones[k].classList.toggle("activa", e.clave === k); botones[k].setAttribute("aria-pressed", e.clave === k ? "true" : "false"); });
      txtRango.textContent = (e.desde || e.hasta) && e.clave === "personalizado"
        ? "Mostrando " + (e.desde ? "desde " + bonita(a) : "") + (e.hasta ? (e.desde ? " " : "") + "hasta " + bonita(b) : "")
        : "Mostrando " + (a === b ? bonita(a) : bonita(a) + " al " + bonita(b));
      lista.textContent = "";
      if (e.error) {
        const permiso = e.error.code === "PERMISSION_DENIED";
        if (op.ocultarSiError) { cont.classList.add("oculto"); return; }
        Object.keys(tarjetasRes).forEach((k) => { tarjetasRes[k].textContent = "—"; });
        lista.appendChild(h("div", "pc-vacio pc-error", permiso ? "Faltan permisos en Firebase para leer la contabilidad (reglas)." : "No se pudo cargar la contabilidad. Revisa tu conexión."));
        return;
      }
      const datos = e.items.filter((x) => x && x.fecha && x.fecha >= a && x.fecha <= b).sort((p, q) => n(q.tsLocal || q.ts) - n(p.tsLocal || p.ts));
      const t = totalizar(datos);
      tarjetasRes.bruto.textContent = dinero(t.bruto);
      tarjetasRes.repartidor.textContent = dinero(t.repartidor);
      tarjetasRes.empresa.textContent = dinero(t.empresa);
      tarjetasRes.cuenta.textContent = String(t.cuenta);
      if (!e.cargado) { lista.appendChild(h("div", "pc-vacio", "Cargando facturas entregadas…")); return; }
      if (!datos.length) { lista.appendChild(h("div", "pc-vacio", "No hay facturas entregadas en este rango de fechas.")); return; }
      const dias = {};
      datos.forEach((x) => { (dias[x.fecha] = dias[x.fecha] || []).push(x); });
      Object.keys(dias).sort().reverse().forEach((f) => {
        lista.appendChild(h("div", "pc-dia", bonita(f) + " · " + dias[f].length + " entrega" + (dias[f].length > 1 ? "s" : "")));
        dias[f].forEach((x) => lista.appendChild(tarjeta(x, { editable: !!op.editablePago, db: e.db, uid: e.uid })));
      });
    }

    function suscribir() {
      if (e.q && e.cb) { try { e.q.off("value", e.cb); } catch (_) {} }
      const [a, b] = limites();
      e.cargado = false;
      e.q = e.db.ref(Contabilidad.RAIZ + "/" + e.uid).orderByChild("fecha").startAt(a).endAt(b);
      e.cb = (s) => {
        const v = s.val() || {};
        e.items = Object.keys(v).map((k) => v[k]).filter((x) => x && typeof x === "object");
        e.error = null; e.cargado = true;
        pintar();
      };
      e.q.on("value", e.cb, (err) => { e.error = err || { code: "ERROR" }; e.cargado = true; pintar(); if (op.alFallar) { try { op.alFallar(e.error); } catch (_) {} } });
      pintar();
    }

    function aplicarRapido(clave) {
      e.clave = clave;
      const r = rangoRapido(clave);
      e.desde = r[0]; e.hasta = r[1];
      i1.value = r[0]; i2.value = r[1];
      suscribir();
    }
    function aplicarPersonalizado() {
      e.clave = "personalizado"; e.desde = i1.value || ""; e.hasta = i2.value || "";
      suscribir();
    }
    rapidos.addEventListener("click", (ev) => { const b = ev.target.closest("button[data-rango]"); if (b) aplicarRapido(b.dataset.rango); });
    i1.addEventListener("change", aplicarPersonalizado);
    i2.addEventListener("change", aplicarPersonalizado);

    aplicarRapido(e.clave);
    return e;
  }

  return { montar, detener, activo: () => !!est, rangoRapido, totalizar };
})();
