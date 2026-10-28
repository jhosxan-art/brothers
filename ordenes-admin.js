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
  const lugarSel = { retiro: null, entrega: null };   // coordenadas fijadas para cada campo del formulario
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
  function estadoCampo(cual) {
    const p = lugarSel[cual], e = el(cual === "retiro" ? "pdRetiroOk" : "pdEntregaOk");
    e.textContent = p ? `✓ Ubicación fijada (${p.lat.toFixed(5)}, ${p.lng.toFixed(5)})` : "Sin coordenadas: no habrá ruta automática. Usa 🔎 o 📍.";
    e.style.color = p ? "#17602B" : "#8A5A00";
  }
  const campo = (cual) => el(cual === "retiro" ? "pdRetiro" : "pdEntrega");
  function fijar(cual, ll, texto) {
    lugarSel[cual] = { lat: ll.lat, lng: ll.lng, texto: texto };
    campo(cual).value = texto; estadoCampo(cual);
  }
  function alEscribir(cual) {
    const v = campo(cual).value.trim(), n = (s) => String(s || "").toLowerCase().trim();
    const hit = Object.values(lugares).find((l) => n(l.nombre) === n(v) && typeof l.lat === "number");   // coincide con un negocio guardado
    if (hit) return fijar(cual, hit, hit.nombre);
    if (lugarSel[cual] && lugarSel[cual].texto !== campo(cual).value) lugarSel[cual] = null;
    estadoCampo(cual);
  }
  function llenarLugares() {
    el("pdLugares").innerHTML = Object.values(lugares).map((l) => `<option value="${esc(l.nombre)}"></option>`).join("");
  }
  async function buscarLugar(cual) {
    const q = campo(cual).value.trim(); if (!q) return toast("Escribe algo para buscar.");
    toast("Buscando…");
    let res = [];
    try { res = (await Buscar.buscar(q, mapa.getBounds())).slice(0, 6); } catch (err) { return toast("No se pudo buscar: " + err.message); }
    if (!res.length) return toast("Sin resultados. Prueba con el nombre y la ciudad, o usa 📍.");
    modal(`<h2>Elige el lugar</h2>${res.map((r, i) => `<div class="item-busq" data-i="${i}" style="cursor:pointer"><strong>${esc(r.nombre)}</strong><small>${esc(r.detalle || "")}</small></div>`).join("")}
      <button id="pdBusqNo" class="oscuro" type="button">Cancelar</button>`);
    el("pdBusqNo").onclick = () => { el("modalCaja").onclick = null; cerrarModal(); };
    el("modalCaja").onclick = (e) => {
      const it = e.target.closest("[data-i]"); if (!it) return;
      const r = res[+it.dataset.i]; fijar(cual, r, campo(cual).value.trim() || r.nombre); cerrarModal();
      el("modalCaja").onclick = null;
    };
  }
  function elegirEnMapa(cual) {
    document.querySelector('.tabs button[data-tab="panelMapa"]').click();
    pick = cual;   // se activa DESPUÉS del clic de la pestaña (que lo reinicia)
    toast(`Toca el mapa para fijar el lugar de ${cual === "retiro" ? "retiro" : "entrega"}.`);
  }
  function fijarDesdeMapa(cual, ll) {
    pick = null;
    const actual = campo(cual).value.trim();
    fijar(cual, { lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) }, actual || `Punto del mapa (${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)})`);
    document.querySelector('.tabs button[data-tab="panelPedidos"]').click();
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
    const cliente = el("pdCliente").value.trim(), rt = campo("retiro").value.trim(), en = campo("entrega").value.trim();
    if (!cliente) return toast("Escribe el nombre del cliente.");
    if (!rt || !en) return toast("Indica el lugar de retiro y el de entrega.");
    let asignacion;
    if (modoAsig === "registrado") {
      const uid = el("pdRegSel").value;
      if (!uid) return toast("Elige un repartidor registrado, o cambia a “Enlace de invitado”.");
      asignacion = { tipo: "registrado", uid, nombre: nombreUid(uid) };
    } else asignacion = { tipo: "invitado" };
    el("pdCrear").disabled = true;
    try {
      const { token, orden } = await O.crear(db, {
        cliente, paquete: el("pdPaquete").value,
        retiro: Object.assign({ texto: rt }, lugarSel.retiro), entrega: Object.assign({ texto: en }, lugarSel.entrega), asignacion
      });
      ["pdCliente", "pdRetiro", "pdEntrega", "pdPaquete"].forEach((id) => { el(id).value = ""; });
      lugarSel.retiro = lugarSel.entrega = null; estadoCampo("retiro"); estadoCampo("entrega");
      if (asignacion.tipo === "invitado") mostrarEnlaces(token, orden);
      else toast(`Pedido ${orden.codigo} asignado a ${asignacion.nombre} ✓` + (O.valido(orden.retiro) ? " Su ruta al retiro ya aparece en su app." : ""));
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
      <div class="ruta">📦 ${esc((o.retiro && o.retiro.texto) || "—")}<br>🏠 ${esc((o.entrega && o.entrega.texto) || "—")}${o.paquete ? "<br>📝 " + esc(o.paquete) : ""}</div>
      <div class="acciones-fila" style="flex-wrap:wrap">
        ${inv && activa(o) ? btn("linkinv", "🔗 Enlace invitado") + btn("linkcli", "💬 Enlace cliente") : ""}
        ${o.estado === "pendiente" && !a.tipo ? btn("asignar", "Asignar", "pri") : ""}
        ${activa(o) ? btn("cancelar", "Cancelar", "peligro") : btn("borrar", "Eliminar", "peligro")}
      </div></div>`;
  }
  function pintarOrdenes() {
    const ids = Object.keys(ordenes).sort((a, b) => (ordenes[b].creado || 0) - (ordenes[a].creado || 0));
    el("listaPedidos").innerHTML = ids.length ? ids.map(tarjeta).join("") : '<p class="ayuda">Aún no hay pedidos. Crea el primero arriba.</p>';
  }

  /* Avisos en vivo: el invitado abrió el enlace / cambió de estado */
  function avisarCambios(nuevo) {
    Object.entries(nuevo).forEach(([t, o]) => {
      const a = ordenes[t]; if (!a) return;
      const nom = (o.asignacion && o.asignacion.nombre) || "Repartidor";
      if (o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && !(a.asignacion && a.asignacion.nombre)) toast(`🔗 ${nom} (invitado) abrió el enlace · pedido ${o.codigo}`);
      else if (o.estado !== a.estado && ["retirado", "entregado"].includes(o.estado)) toast(`${o.estado === "retirado" ? "📦" : "✅"} ${nom}: ${O.ESTADOS[o.estado][0]} · pedido ${o.codigo}`);
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
      ["retiro", "entrega"].forEach((c) => {
        campo(c).addEventListener("input", () => alEscribir(c));
        campo(c).addEventListener("focus", llenarLugares);
        el(c === "retiro" ? "pdRetiroBus" : "pdEntregaBus").onclick = () => buscarLugar(c);
        el(c === "retiro" ? "pdRetiroMapa" : "pdEntregaMapa").onclick = () => elegirEnMapa(c);
        estadoCampo(c);
      });
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
