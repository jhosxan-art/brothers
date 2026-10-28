/* ============================================================
   ORDENES-ADMIN · Funciones 1 y 2 del panel de administración
   1) Toque en el mapa → modal para elegir repartidor activo y punto Retiro/Entrega
   2) Pestaña "Pedidos": formulario, asignación (registrado o enlace de invitado) y estado en vivo
   Se carga DESPUÉS de admin.js y usa sus globales (db, mapa, ubic, registrados, toast, modal…).
   ============================================================ */
const PedidosAdmin = (() => {
  const O = Ordenes, esc = O.esc, el = (id) => document.getElementById(id);
  let ordenes = {}, ref = null, primera = true, listo = false;
  let tempMarca = null, timerClick = null, popupCerrado = 0, busqAbierta = false, pick = null;
  const lugarSel = { entrega: null };   // coordenadas fijadas de la entrega
  let retirosForm = [{ texto: "", ll: null, producto: "" }];   // varios retiros, cada uno con su producto
  let modoAsig = "registrado";

  /* ---------- Utilidades ---------- */
  const activa = (o) => ["pendiente", "asignado", "retirado"].includes(o.estado);
  const nombreOrden = (o) => (o.asignacion && (o.asignacion.nombre || (o.asignacion.tipo === "invitado" ? "Invitado (sin abrir enlace)" : ""))) || "Sin asignar";
  function copiar(texto) {
    const ok = () => toast("Enlace copiado ✓");
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(texto).then(ok).catch(() => prompt("Copia el enlace:", texto));
    prompt("Copia el enlace:", texto);
  }
  const wa = (msg) => window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_system");
  function repsActivos() {   // registrados + invitados que están conectados ahora
    const ids = [...new Set([...Object.keys(registrados), ...Object.keys(ubic)])];
    return ids.filter((u) => ["enRuta", "libre"].includes(estadoDe(u))).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
  }

  /* ============================================================
     1) ASIGNACIÓN RÁPIDA DESDE EL MAPA
     ============================================================ */
  function cancelarClick() { if (timerClick) { clearTimeout(timerClick); timerClick = null; } }
  function quitarTemp() { if (tempMarca && mapa) { mapa.removeLayer(tempMarca); } tempMarca = null; }

  /* admin.js llama aquí en cada toque del mapa que no esté ocupado por otra herramienta */
  function clickMapa(ll) {
    if (pick) return fijarDesdeMapa(pick, ll);
    if (busqAbierta || Date.now() - popupCerrado < 350) return;       // ese toque solo cerraba la búsqueda o una ventanita
    if (!el("modalAdmin").classList.contains("oculto")) return;
    cancelarClick();
    timerClick = setTimeout(() => { timerClick = null; abrirAsignacion(ll); }, 260);   // si es doble toque (zoom) se cancela
  }

  function abrirAsignacion(ll) {
    quitarTemp();
    tempMarca = L.marker(ll, { icon: O.pinIcono("temp", "📍"), interactive: false, zIndexOffset: 1200 }).addTo(mapa);
    const reps = repsActivos();
    let punto = "retiro", uid = null;
    modal(`<h2>📍 Asignar punto</h2>
      <div class="pd-coord">${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}</div>
      <div class="pd-seg" id="pdPunto"><button type="button" data-p="retiro" class="on">📦 Retiro</button><button type="button" data-p="entrega">🏠 Entrega</button></div>
      <small>Repartidor activo</small>
      <div class="pd-lista-rep" id="pdReps">${reps.length ? reps.map((u) => {
        const inv = O.esInvitadoUid(u), [tx] = ETIQUETA[estadoDe(u)];
        return `<button type="button" class="pd-rep" data-uid="${esc(u)}"><span><strong>${esc(nombreUid(u))}</strong><small>${tx}${viajeDe(u) ? " · con pedido" : ""}</small></span>${inv ? '<i class="pd-tag">Invitado</i>' : ""}</button>`;
      }).join("") : '<p class="ayuda">No hay repartidores activos (conectados) ahora mismo.</p>'}</div>
      <button id="pdAsignar" class="primario" type="button" disabled>Asignar punto</button>
      <button id="pdCancelar" class="oscuro" type="button">Cancelar</button>`);
    el("pdPunto").onclick = (e) => {
      const b = e.target.closest("button[data-p]"); if (!b) return; punto = b.dataset.p;
      el("pdPunto").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    };
    el("pdReps").onclick = (e) => {
      const b = e.target.closest("button[data-uid]"); if (!b) return; uid = b.dataset.uid;
      el("pdReps").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      el("pdAsignar").disabled = false;
    };
    el("pdCancelar").onclick = cerrarModal;
    el("pdAsignar").onclick = async () => {
      if (!uid) return;
      el("pdAsignar").disabled = true;
      try {
        await O.puntoRapido(db, uid, punto, ll);
        cerrarModal();
        toast(`${O.PUNTOS[punto].icono} ${O.PUNTOS[punto].nombre} enviado a ${nombreUid(uid)} ✓ Su ruta se traza sola.`);
      } catch (err) { toast("No se pudo asignar: " + err.message); el("pdAsignar").disabled = false; }
    };
  }

  /* ============================================================
     2) PEDIDOS Y REPARTIDORES INVITADOS
     ============================================================ */
  const okMsg = (ll) => (ll ? `✓ Ubicación fijada (${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)})` : "Sin coordenadas: no habrá ruta automática. Usa 🔎 o 📍.");
  function pintarOk(span, ll) { if (!span) return; span.textContent = okMsg(ll); span.style.color = ll ? "#17602B" : "#8A5A00"; }
  const filaEl = (i) => el("pdRetiros").querySelector(`[data-i="${i}"]`);
  const hitLugar = (v) => { const n = (s) => String(s || "").toLowerCase().trim(); return Object.values(lugares).find((l) => n(l.nombre) === n(v) && typeof l.lat === "number"); };

  function pintarRetiros() {
    const n = retirosForm.length;
    el("pdRetiros").innerHTML = retirosForm.map((r, i) => `<div class="pd-retiro" data-i="${i}">
      <div class="pd-lugar">
        <label>📦 Lugar de retiro${n > 1 ? " " + (i + 1) : ""} <input data-f="texto" list="pdLugares" maxlength="160" autocomplete="off" placeholder="Negocio o dirección" value="${esc(r.texto)}"></label>
        <button data-a="bus" type="button" aria-label="Buscar lugar">🔎</button>
        <button data-a="mapa" type="button" aria-label="Elegir en el mapa">📍</button>
        <span class="pd-ok"></span>
      </div>
      <label>Producto a retirar aquí <input data-f="producto" maxlength="120" autocomplete="off" placeholder="Ej. 2 pizzas medianas" value="${esc(r.producto)}"></label>
      ${n > 1 ? '<button data-a="quitar" class="mini peligro" type="button">Quitar este retiro</button>' : ""}</div>`).join("");
    retirosForm.forEach((r, i) => pintarOk(filaEl(i).querySelector(".pd-ok"), r.ll));
  }
  function fijarRetiro(i, ll, texto) {
    const r = retirosForm[i]; if (!r) return;
    r.ll = { lat: ll.lat, lng: ll.lng }; r.texto = texto;
    const f = filaEl(i); f.querySelector('[data-f="texto"]').value = texto; pintarOk(f.querySelector(".pd-ok"), r.ll);
  }
  function fijarEntrega(ll, texto) { lugarSel.entrega = { lat: ll.lat, lng: ll.lng, texto }; el("pdEntrega").value = texto; pintarOk(el("pdEntregaOk"), lugarSel.entrega); }
  function alEscribirRetiro(i, v) {
    const r = retirosForm[i], hit = hitLugar(v); r.texto = v;
    if (hit) return fijarRetiro(i, hit, hit.nombre);
    r.ll = null; pintarOk(filaEl(i).querySelector(".pd-ok"), null);
  }
  function alEscribirEntrega() {
    const v = el("pdEntrega").value.trim(), hit = hitLugar(v);
    if (hit) return fijarEntrega(hit, hit.nombre);
    if (lugarSel.entrega && lugarSel.entrega.texto !== el("pdEntrega").value) lugarSel.entrega = null;
    pintarOk(el("pdEntregaOk"), lugarSel.entrega);
  }
  function llenarLugares() {
    el("pdLugares").innerHTML = Object.values(lugares).map((l) => `<option value="${esc(l.nombre)}"></option>`).join("");
  }
  async function buscarLugar(cual, i) {
    const q = (cual === "retiro" ? retirosForm[i].texto : el("pdEntrega").value).trim(); if (!q) return toast("Escribe algo para buscar.");
    toast("Buscando…");
    let res = [];
    try { res = (await Buscar.buscar(q, mapa.getBounds())).slice(0, 6); } catch (err) { return toast("No se pudo buscar: " + err.message); }
    if (!res.length) return toast("Sin resultados. Prueba con el nombre y la ciudad, o usa 📍.");
    modal(`<h2>Elige el lugar</h2>${res.map((r, k) => `<div class="item-busq" data-i="${k}" style="cursor:pointer"><strong>${esc(r.nombre)}</strong><small>${esc(r.detalle || "")}</small></div>`).join("")}
      <button id="pdBusqNo" class="oscuro" type="button">Cancelar</button>`);
    el("pdBusqNo").onclick = () => { el("modalCaja").onclick = null; cerrarModal(); };
    el("modalCaja").onclick = (e) => {
      const it = e.target.closest("[data-i]"); if (!it) return;
      const r = res[+it.dataset.i];
      if (cual === "retiro") fijarRetiro(i, r, retirosForm[i].texto.trim() || r.nombre); else fijarEntrega(r, el("pdEntrega").value.trim() || r.nombre);
      cerrarModal(); el("modalCaja").onclick = null;
    };
  }
  function elegirEnMapa(cual, i) {
    document.querySelector('.tabs button[data-tab="panelMapa"]').click();
    pick = { cual, i };   // se activa DESPUÉS del clic de la pestaña (que lo reinicia)
    toast(`Toca el mapa para fijar el lugar de ${cual === "retiro" ? "retiro" : "entrega"}.`);
  }
  function fijarDesdeMapa(p, ll) {
    pick = null;
    const ll6 = { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }, auto = `Punto del mapa (${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)})`;
    document.querySelector('.tabs button[data-tab="panelPedidos"]').click();
    if (p.cual === "retiro") fijarRetiro(p.i, ll6, retirosForm[p.i].texto.trim() || auto); else fijarEntrega(ll6, el("pdEntrega").value.trim() || auto);
  }

  function pintarSelectorReg() {
    const ids = Object.keys(registrados).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
    const previo = el("pdRegSel").value;
    el("pdRegSel").innerHTML = '<option value="">— Elige un repartidor —</option>' + ids.map((u) => `<option value="${esc(u)}">${esc(nombreUid(u))} · ${ETIQUETA[estadoDe(u)][0]}</option>`).join("");
    if (previo && ids.includes(previo)) el("pdRegSel").value = previo;
  }
  function modoAsignacion(m) {
    modoAsig = m;
    el("pdModo").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    el("pdRegBox").classList.toggle("oculto", m !== "registrado");
    el("pdInvBox").classList.toggle("oculto", m !== "invitado");
    el("pdCrear").textContent = m === "invitado" ? "Crear pedido y generar enlace" : "Crear y asignar pedido";
  }

  async function crearPedido() {
    const cliente = el("pdCliente").value.trim(), en = el("pdEntrega").value.trim();
    const retiros = retirosForm.filter((r) => r.texto.trim()).map((r) => Object.assign({ texto: r.texto.trim(), producto: r.producto.trim() }, r.ll));
    if (!cliente) return toast("Escribe el nombre del cliente.");
    if (!retiros.length || !en) return toast("Indica al menos un lugar de retiro y el de entrega.");
    let asignacion;
    if (modoAsig === "registrado") {
      const uid = el("pdRegSel").value;
      if (!uid) return toast("Elige un repartidor registrado, o cambia a “Enlace de invitado”.");
      asignacion = { tipo: "registrado", uid, nombre: nombreUid(uid) };
    } else asignacion = { tipo: "invitado" };
    el("pdCrear").disabled = true;
    try {
      const { token, orden } = await O.crear(db, {
        cliente, paquete: el("pdPaquete").value, retiros, delivery: parseFloat(el("pdDelivery").value) || 0,
        entrega: Object.assign({ texto: en }, lugarSel.entrega), asignacion
      });
      ["pdCliente", "pdEntrega", "pdPaquete", "pdDelivery"].forEach((id) => { el(id).value = ""; });
      lugarSel.entrega = null; retirosForm = [{ texto: "", ll: null, producto: "" }]; pintarRetiros(); pintarOk(el("pdEntregaOk"), null);
      if (asignacion.tipo === "invitado") mostrarEnlaces(token, orden);
      else toast(`Pedido ${orden.codigo} asignado a ${asignacion.nombre} ✓` + (O.valido(orden.retiros[0]) ? " Su ruta al primer retiro ya aparece en su app." : "") + " Enlace del cliente: botón 💬 en la lista.");
    } catch (err) { toast("No se pudo crear el pedido: " + err.message); }
    el("pdCrear").disabled = false;
  }

  function mostrarEnlaces(t, o) {
    const li = O.urlInvitado(t), lc = O.urlCliente(t);
    modal(`<h2>🔗 Enlace de invitado</h2>
      <p class="ayuda">Pedido <b>${esc(o.codigo)}</b> · ${esc(o.cliente)}. Envía este enlace a quien hará la entrega: solo tendrá que escribir su nombre.</p>
      <div class="pd-enlace">${esc(li)}</div>
      <button id="pdCopiarInv" class="primario" type="button">📋 Copiar enlace del invitado</button>
      <button id="pdWaInv" class="whatsapp" type="button">Enviar por WhatsApp</button>
      <p class="ayuda">Enlace del cliente (seguimiento + chat con el invitado):</p>
      <div class="pd-enlace">${esc(lc)}</div>
      <button id="pdCopiarCli" type="button">📋 Copiar enlace del cliente</button>
      <button id="pdCerrarEnl" class="oscuro" type="button">Listo</button>`);
    el("pdCopiarInv").onclick = () => copiar(li);
    el("pdCopiarCli").onclick = () => copiar(lc);
    el("pdWaInv").onclick = () => wa(`🛵 Brother’s Deliverys · Pedido ${o.codigo}\nAbre este enlace, escribe tu nombre y sigue la ruta:\n${li}`);
    el("pdCerrarEnl").onclick = cerrarModal;
  }

  function asignarExistente(t) {
    const o = ordenes[t]; if (!o) return;
    const ids = Object.keys(registrados).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
    modal(`<h2>Asignar pedido ${esc(o.codigo)}</h2>
      <label>Repartidor registrado<select id="pdAsSel"><option value="">— Elige —</option>${ids.map((u) => `<option value="${esc(u)}">${esc(nombreUid(u))}</option>`).join("")}</select></label>
      <button id="pdAsOk" class="primario" type="button">Asignar</button>
      <button id="pdAsInv" type="button">🔗 Generar enlace de invitado</button>
      <button id="pdAsNo" class="oscuro" type="button">Cancelar</button>`);
    el("pdAsNo").onclick = cerrarModal;
    el("pdAsOk").onclick = async () => {
      const uid = el("pdAsSel").value; if (!uid) return toast("Elige un repartidor.");
      try { await O.asignar(db, t, o, { tipo: "registrado", uid, nombre: nombreUid(uid) }); cerrarModal(); toast(`Asignado a ${nombreUid(uid)} ✓`); }
      catch (err) { toast("No se pudo asignar: " + err.message); }
    };
    el("pdAsInv").onclick = async () => {
      try { await O.asignar(db, t, o, { tipo: "invitado" }); mostrarEnlaces(t, o); }
      catch (err) { toast("No se pudo generar el enlace: " + err.message); }
    };
  }
  async function cancelarOrden(t) {
    const o = ordenes[t]; if (!o || !confirm(`¿Cancelar el pedido ${o.codigo}?`)) return;
    const upd = { [`ordenes/${t}/estado`]: "cancelado", [`ordenes/${t}/actualizado`]: O.TS };
    const a = o.asignacion || {};
    if (a.tipo === "registrado" && guias[a.uid] && guias[a.uid].ordenId === t) upd["guias/" + a.uid] = null;
    if (a.tipo === "invitado" && a.unido) upd[`pedidos/${t}/estado`] = "cancelado";
    try { await db.ref().update(upd); toast("Pedido cancelado."); } catch (err) { toast("No se pudo cancelar: " + err.message); }
  }

  function tarjeta(t) {
    const o = ordenes[t], [txt, cls] = O.ESTADOS[o.estado] || O.ESTADOS.pendiente, a = o.asignacion || {};
    const inv = a.tipo === "invitado", btn = (acc, label, extra) => `<button class="mini ${extra || ""}" data-pa="${acc}" data-t="${esc(t)}" type="button">${label}</button>`;
    return `<div class="tarjeta-rep pd-orden">
      <div class="fila"><div class="datos"><strong>${esc(o.codigo)} · ${esc(o.cliente || "Sin nombre")}</strong>
        <small>👤 ${esc(nombreOrden(o))}${inv ? ' <i class="pd-tag">Invitado</i>' : ""}</small></div><span class="chip ${cls}">${txt}</span></div>
      <div class="ruta">${O.paradas(o).map((p, k) => `${p.retirado ? "✅" : "📦"} ${O.paradas(o).length > 1 ? "Retiro " + (k + 1) + ": " : ""}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}`).join("<br>")}<br>🏠 ${esc((o.entrega && o.entrega.texto) || "—")}${o.delivery ? "<br>🛵 Delivery: <b>" + O.money(o.delivery) + "</b>" : ""}${o.paquete ? "<br>📝 " + esc(o.paquete) : ""}</div>
      <div class="acciones-fila" style="flex-wrap:wrap">
        ${inv && activa(o) ? btn("linkinv", "🔗 Enlace invitado") : ""}${a.tipo && activa(o) ? btn("linkcli", "💬 Enlace cliente") : ""}
        ${o.estado === "pendiente" && !a.tipo ? btn("asignar", "Asignar", "pri") : ""}
        ${activa(o) ? btn("cancelar", "Cancelar", "peligro") : btn("borrar", "Eliminar", "peligro")}
      </div></div>`;
  }
  function pintarOrdenes() {
    const ids = Object.keys(ordenes).sort((a, b) => (ordenes[b].creado || 0) - (ordenes[a].creado || 0));
    el("listaPedidos").innerHTML = ids.length ? ids.map(tarjeta).join("") : '<p class="ayuda">Aún no hay pedidos. Crea el primero arriba.</p>';
  }

  /* Avisos en vivo (texto + VOZ ALTA): el invitado abrió el enlace, retiró un producto, entregó */
  function avisarCambios(nuevo) {
    const decir = (txt) => { toast(txt); O.hablar(txt.replace(/[📦✅🔗🛵]/gu, "")); };
    Object.entries(nuevo).forEach(([t, o]) => {
      const a = ordenes[t]; if (!a) return;
      const nom = (o.asignacion && o.asignacion.nombre) || "El repartidor", pa = O.paradas(a), po = O.paradas(o);
      if (o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && !(a.asignacion && a.asignacion.nombre)) decir(`🔗 ${nom} abrió el enlace de invitado del pedido ${o.codigo}`);
      po.forEach((p, k) => {
        if (!p.retirado || (pa[k] && pa[k].retirado)) return;   // solo retiros nuevos
        const falta = po.filter((x) => !x.retirado).length;
        decir(`📦 ${nom} ya retiró ${p.producto ? p.producto : "un producto"}${p.texto ? " en " + p.texto : ""}. ${falta ? "Faltan " + falta + " retiro" + (falta > 1 ? "s" : "") + " del pedido " + o.codigo : "Pedido " + o.codigo + " completo, va hacia el cliente"}`);
      });
      if (o.estado !== a.estado && o.estado === "entregado") decir(`✅ ${nom} entregó el pedido ${o.codigo}`);
    });
  }

  /* Tarjetas de invitados activos para la pestaña Equipo (junto a los registrados) */
  function htmlInvitados() {
    return Object.entries(ordenes).filter(([, o]) => o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && ["asignado", "retirado"].includes(o.estado)).map(([t, o]) => {
      const [tx] = ETIQUETA[estadoDe(O.uidInvitado(t))], [et, ec] = O.ESTADOS[o.estado];
      return `<div class="tarjeta-rep"><div class="fila"><span class="avatar">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(o.asignacion.nombre)} <i class="pd-tag">Invitado</i></strong><small>Pedido ${esc(o.codigo)} · ${esc(o.cliente)} · ${tx}</small></div>
        <span class="chip ${ec}">${et}</span></div></div>`;
    }).join("");
  }
  /* Nota corta para la ventanita del repartidor en el mapa */
  function notaRep(uid) {
    const e = Object.entries(ordenes).find(([t, o]) => ["asignado", "retirado"].includes(o.estado) && o.asignacion &&
      ((o.asignacion.tipo === "invitado" && O.uidInvitado(t) === uid) || (o.asignacion.tipo === "registrado" && o.asignacion.uid === uid)));
    return e ? ` · 📦 ${e[1].codigo}: ${O.ESTADOS[e[1].estado][0]}` : "";
  }
  /* Si el admin marca entregado un pedido de un invitado desde el mapa */
  function cerrarInvitado(token, uid) {
    if (!O.esInvitadoUid(uid)) return;
    db.ref().update({ [`ordenes/${token}/estado`]: "entregado", [`ordenes/${token}/actualizado`]: O.TS, ["ubicaciones/" + uid]: null }).catch(() => {});
  }

  /* ---------- Arranque / parada ---------- */
  function iniciar() {
    detener(); primera = true;
    if (!listo) {
      listo = true;
      mapa.on("preclick", () => { busqAbierta = !el("resBusq").classList.contains("oculto"); });
      mapa.on("popupclose", () => { popupCerrado = Date.now(); });
      mapa.on("dblclick zoomstart movestart", cancelarClick);
      new MutationObserver(() => { if (el("modalAdmin").classList.contains("oculto")) quitarTemp(); }).observe(el("modalAdmin"), { attributes: true, attributeFilter: ["class"] });
      document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { pick = null; if (b.dataset.tab === "panelPedidos") pintarSelectorReg(); }));
      el("pdModo").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) modoAsignacion(b.dataset.m); };
      el("pdCrear").onclick = crearPedido;
      pintarRetiros();
      el("pdAddRetiro").onclick = () => { retirosForm.push({ texto: "", ll: null, producto: "" }); pintarRetiros(); const f = filaEl(retirosForm.length - 1); f && f.querySelector("input").focus(); };
      const rc = el("pdRetiros");
      rc.addEventListener("input", (e) => {
        const f = e.target.closest("[data-i]"), campo = e.target.dataset.f; if (!f) return; const i = +f.dataset.i;
        if (campo === "texto") alEscribirRetiro(i, e.target.value); else if (campo === "producto") retirosForm[i].producto = e.target.value;
      });
      rc.addEventListener("focusin", (e) => { if (e.target.dataset.f === "texto") llenarLugares(); });
      rc.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-a]"), f = e.target.closest("[data-i]"); if (!b || !f) return; const i = +f.dataset.i;
        if (b.dataset.a === "bus") buscarLugar("retiro", i);
        else if (b.dataset.a === "mapa") elegirEnMapa("retiro", i);
        else if (b.dataset.a === "quitar") { retirosForm.splice(i, 1); pintarRetiros(); }
      });
      el("pdEntrega").addEventListener("input", alEscribirEntrega);
      el("pdEntrega").addEventListener("focus", llenarLugares);
      el("pdEntregaBus").onclick = () => buscarLugar("entrega");
      el("pdEntregaMapa").onclick = () => elegirEnMapa("entrega");
      pintarOk(el("pdEntregaOk"), null);
      el("listaPedidos").onclick = (e) => {
        const b = e.target.closest("button[data-pa]"); if (!b) return;
        const t = b.dataset.t, o = ordenes[t], a = b.dataset.pa; if (!o) return;
        if (a === "linkinv") mostrarEnlaces(t, o);
        else if (a === "linkcli") copiar(O.urlCliente(t));
        else if (a === "asignar") asignarExistente(t);
        else if (a === "cancelar") cancelarOrden(t);
        else if (a === "borrar") { if (confirm("¿Eliminar este pedido del historial?")) db.ref("ordenes/" + t).remove().catch((err) => toast(err.message)); }
      };
      modoAsignacion("registrado");
    }
    ref = db.ref("ordenes").orderByChild("creado").limitToLast(60);
    ref.on("value", (s) => {
      const nuevo = s.val() || {};
      if (!primera) avisarCambios(nuevo);
      primera = false; ordenes = nuevo;
      pintarOrdenes(); pintarSelectorReg(); pintarEquipo(); pintarLista();
    }, () => { el("listaPedidos").innerHTML = '<p class="ayuda">Sin permiso para leer “ordenes”. Revisa las reglas de Firebase (ver LEEME).</p>'; });
  }
  function detener() { if (ref) { ref.off(); ref = null; } ordenes = {}; quitarTemp(); cancelarClick(); }

  return { iniciar, detener, clickMapa, htmlInvitados, notaRep, cerrarInvitado };
})();
