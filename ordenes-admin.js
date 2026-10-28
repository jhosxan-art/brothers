/* ============================================================
   ORDENES-ADMIN · Funciones 1 y 2 del panel de administración
   1) Toque en el mapa → modal para elegir repartidor activo y punto Retiro/Entrega
   2) Pestaña "Pedidos": formulario, asignación (registrado o enlace de invitado) y estado en vivo
   Se carga DESPUÉS de admin.js y usa sus globales (db, mapa, ubic, registrados, toast, modal…).
   ============================================================ */
const PedidosAdmin = (() => {
  const O = Ordenes, esc = O.esc, el = (id) => document.getElementById(id);
  let ordenes = {}, ref = null, primera = true, listo = false;
  let tempMarca = null, timerClick = null, popupCerrado = 0, busqAbierta = false, ovl = null;
  let regSel = "", creando = false, firmaSel = "";   // repartidor elegido (sobrevive a repintados) y candado anti doble envío
  let refChatInv = null, resInv = {}, primeraInv = true, sinLeerInv = {}, chatInvAbierto = null;   // chat Admin ↔ invitado
  const RUTA_INV = { chats: "chatsInvitado", resumen: "chatsInvitadoResumen", fotos: "fotosInvitado", leido: "leidosInvitado" };
  const lugarSel = { entrega: null };   // coordenadas fijadas de la entrega
  let retirosForm = [{ texto: "", ll: null, producto: "" }];   // varios retiros, cada uno con su producto
  let modoAsig = "registrado";

  /* ---------- Utilidades ---------- */
  const activa = (o) => ["pendiente", "asignado", "retirado"].includes(o.estado);
  const nombreOrden = (o) => (o.asignacion && (o.asignacion.nombre || (o.asignacion.tipo === "invitado" ? "Invitado (sin aceptar)" : ""))) || "Sin asignar";
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
  const okMsg = (ll) => (ll ? `✓ Ubicación fijada (${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)})` : "Sin coordenadas: no habrá ruta automática. Usa 📍 para fijarlo en el mapa.");
  function pintarOk(span, ll) { if (!span) return; span.textContent = okMsg(ll); span.style.color = ll ? "#17602B" : "#8A5A00"; }
  const filaEl = (i) => el("pdRetiros").querySelector(`[data-i="${i}"]`);
  const hitLugar = (v) => { const n = (s) => String(s || "").toLowerCase().trim(); return Object.values(lugares).find((l) => n(l.nombre) === n(v) && typeof l.lat === "number"); };

  function pintarRetiros() {
    const n = retirosForm.length;
    el("pdRetiros").innerHTML = retirosForm.map((r, i) => `<div class="pd-retiro" data-i="${i}">
      <div class="pd-lugar">
        <label>📦 Lugar de retiro${n > 1 ? " " + (i + 1) : ""} <input data-f="texto" maxlength="160" autocomplete="off" placeholder="Negocio o dirección" value="${esc(r.texto)}"></label>
        <button data-a="mapa" type="button" aria-label="Elegir en el mapa">📍</button>
        <span class="pd-ok"></span>
        <div class="pd-sug oculto" data-sug></div>
      </div>
      <label>Producto a retirar aquí <input data-f="producto" maxlength="120" autocomplete="off" placeholder="Ej. 2 pizzas medianas" value="${esc(r.producto)}"></label>
      ${n > 1 ? '<button data-a="quitar" class="mini peligro" type="button">Quitar este retiro</button>' : ""}</div>`).join("");
    retirosForm.forEach((r, i) => pintarOk(filaEl(i).querySelector(".pd-ok"), r.ll));
  }
  /* ---------- Burbujas de coincidencias con los negocios guardados ---------- */
  const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  function coincidencias(v) {
    const q = norm(v); if (!q) return [];
    const ts = q.split(/\s+/);   // cada palabra escrita debe aparecer en el nombre o la referencia del negocio
    return Object.entries(lugares).filter(([, l]) => typeof l.lat === "number" && ts.every((w) => norm(l.nombre + " " + (l.dir || "")).includes(w)))
      .sort((a, b) => (norm(a[1].nombre).startsWith(q) ? 0 : 1) - (norm(b[1].nombre).startsWith(q) ? 0 : 1) || a[1].nombre.localeCompare(b[1].nombre)).slice(0, 6);
  }
  function mostrarSug(box, v) {
    if (!box) return;
    const lista = coincidencias(v);
    if (!lista.length) { box.classList.add("oculto"); box.innerHTML = ""; return; }
    box.innerHTML = lista.map(([id, l]) => `<button type="button" class="pd-burbuja" data-lid="${esc(id)}"><span>${esc(l.icono || "🏪")}</span><b>${esc(l.nombre)}</b>${l.dir ? `<small>${esc(l.dir)}</small>` : ""}</button>`).join("");
    box.classList.remove("oculto");
  }
  function ocultarSugs() { document.querySelectorAll("#panelPedidos .pd-sug").forEach((b) => { b.classList.add("oculto"); b.innerHTML = ""; }); }

  function fijarRetiro(i, ll, texto) {
    const r = retirosForm[i]; if (!r) return;
    r.ll = { lat: ll.lat, lng: ll.lng }; r.texto = texto;
    const f = filaEl(i); f.querySelector('[data-f="texto"]').value = texto; pintarOk(f.querySelector(".pd-ok"), r.ll);
  }
  function fijarEntrega(ll, texto) { lugarSel.entrega = { lat: ll.lat, lng: ll.lng, texto }; el("pdEntrega").value = texto; pintarOk(el("pdEntregaOk"), lugarSel.entrega); }
  function alEscribirRetiro(i, v) {
    const r = retirosForm[i], hit = hitLugar(v); r.texto = v;
    const box = filaEl(i).querySelector("[data-sug]");
    if (hit) { fijarRetiro(i, hit, hit.nombre); return mostrarSug(box, ""); }
    r.ll = null; pintarOk(filaEl(i).querySelector(".pd-ok"), null);
    mostrarSug(box, v);
  }
  function alEscribirEntrega() {
    const v = el("pdEntrega").value.trim(), hit = hitLugar(v);
    if (hit) { fijarEntrega(hit, hit.nombre); return mostrarSug(el("pdEntregaSug"), ""); }
    if (lugarSel.entrega && lugarSel.entrega.texto !== el("pdEntrega").value) lugarSel.entrega = null;
    pintarOk(el("pdEntregaOk"), lugarSel.entrega);
    mostrarSug(el("pdEntregaSug"), v);
  }
  /* ============================================================
     MAPA EN BLANCO DEL FORMULARIO: solo Retiro → Entrega, con distancia (km) y ETA
     (sin negocios ni repartidores; es una instancia de mapa aparte)
     ============================================================ */
  const okLL = (ll) => !!ll && typeof ll.lat === "number" && typeof ll.lng === "number";
  const fmtKm = (m) => (m / 1000).toFixed(1) + " km";
  const fmtEta = (s) => { const mi = Math.max(1, Math.round(s / 60)); return mi >= 60 ? Math.floor(mi / 60) + " h " + (mi % 60) + " min" : mi + " min"; };
  function puntosForm() {
    const n = retirosForm.length;
    const l = retirosForm.map((r, i) => ({ cual: "retiro", i, ll: r.ll, nombre: n > 1 ? "📦 Retiro " + (i + 1) : "📦 Retiro" }));
    l.push({ cual: "entrega", i: 0, ll: lugarSel.entrega, nombre: "🏠 Entrega" });
    return l;
  }
  function cerrarMapaForm() {
    if (!ovl) return false;
    try { ovl.m.remove(); } catch (_) {}
    ovl.div.remove(); ovl = null;
    return true;
  }
  function abrirMapaForm(cual, i) {
    cerrarMapaForm();
    const div = document.createElement("div");
    div.className = "pd-ovl";
    div.innerHTML = `<div id="pdOvlMapa"></div>
      <div class="pd-ovl-top"><button type="button" class="pd-ovl-x" aria-label="Cerrar mapa">✕</button><div class="pd-ovl-sel" id="pdOvlSel"></div></div>
      <div class="pd-ovl-info" id="pdOvlInfo">Toca el mapa para fijar el punto elegido arriba.</div>
      <button type="button" class="primario pd-ovl-ok">Listo</button>`;
    document.body.appendChild(div);
    const m = L.map(div.querySelector("#pdOvlMapa"), { zoomControl: false }).setView(mapa ? mapa.getCenter() : [-12.0464, -77.0428], mapa ? Math.max(mapa.getZoom(), 13) : 14);
    L.control.zoom({ position: "bottomright" }).addTo(m);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    ovl = { div, m, capa: L.layerGroup().addTo(m), rutaCapa: L.layerGroup().addTo(m), activo: { cual, i: i || 0 }, seq: 0 };
    const info = (t) => { const e = div.querySelector("#pdOvlInfo"); if (e) e.innerHTML = t; };

    async function trazar(encuadrar) {
      const mio = ovl, seq = ++mio.seq;
      mio.rutaCapa.clearLayers();
      const pts = puntosForm().filter((p) => okLL(p.ll));
      if (pts.length < 2) {
        if (pts.length === 1 && encuadrar) m.setView([pts[0].ll.lat, pts[0].ll.lng], 16);
        return info("Fija el retiro y la entrega para ver la ruta, la distancia y el tiempo.");
      }
      info("Calculando ruta por calles…");
      let dist = 0, dur = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        let r = null;
        try { r = await O.rutaCalles({ lat: pts[k].ll.lat, lng: pts[k].ll.lng }, { lat: pts[k + 1].ll.lat, lng: pts[k + 1].ll.lng }); } catch (_) {}
        if (ovl !== mio || seq !== mio.seq) return;   // se cerró o cambió un punto mientras calculaba
        if (!r) return info("No se pudo calcular la ruta por calles. Cambia un punto o intenta de nuevo.");
        dist += r.dist; dur += r.dur;
        L.polyline([[pts[k].ll.lat, pts[k].ll.lng], ...r.pts, [pts[k + 1].ll.lat, pts[k + 1].ll.lng]], { color: "#0A86C9", weight: 6, opacity: .9 }).addTo(mio.rutaCapa);
      }
      info(`🛣 <b>${fmtKm(dist)}</b> · ⏱ ETA <b>≈ ${fmtEta(dur)}</b>`);
      if (encuadrar) m.fitBounds(L.latLngBounds(pts.map((p) => [p.ll.lat, p.ll.lng])), { padding: [70, 70], maxZoom: 17 });
    }
    function dibujar(encuadrar) {
      ovl.capa.clearLayers();
      const ps = puntosForm(), a = ovl.activo;
      div.querySelector("#pdOvlSel").innerHTML = ps.map((p, k) => `<button type="button" data-k="${k}" class="${p.cual === a.cual && p.i === a.i ? "on" : ""}">${p.nombre}${okLL(p.ll) ? " ✓" : ""}</button>`).join("");
      ps.forEach((p) => { if (okLL(p.ll)) L.marker([p.ll.lat, p.ll.lng], { icon: O.pinIcono(p.cual, p.cual === "retiro" ? "📦" : "🏠") }).addTo(ovl.capa); });
      trazar(encuadrar);
    }
    div.querySelector("#pdOvlSel").onclick = (e) => {
      const b = e.target.closest("button[data-k]"); if (!b) return;
      const p = puntosForm()[+b.dataset.k]; ovl.activo = { cual: p.cual, i: p.i };
      dibujar(false);
      if (okLL(p.ll)) m.panTo([p.ll.lat, p.ll.lng]);
    };
    m.on("click", (e) => {
      const ll = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }, auto = `Punto del mapa (${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)})`, a = ovl.activo;
      if (a.cual === "retiro") fijarRetiro(a.i, ll, (retirosForm[a.i] && retirosForm[a.i].texto.trim()) || auto);
      else fijarEntrega(ll, el("pdEntrega").value.trim() || auto);
      dibujar(false);
    });
    div.querySelector(".pd-ovl-x").onclick = cerrarMapaForm;
    div.querySelector(".pd-ovl-ok").onclick = cerrarMapaForm;
    setTimeout(() => { if (ovl && ovl.m === m) { m.invalidateSize(); dibujar(true); } }, 80);
  }

  function pintarSelectorReg() {
    const sel = el("pdRegSel"), ids = Object.keys(registrados).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
    const opts = ids.map((u) => `<option value="${esc(u)}">${esc(nombreUid(u))} · ${ETIQUETA[estadoDe(u)][0]}</option>`).join("");
    if (opts === firmaSel) return;                 // nada cambió: no se toca el <select> (evita el parpadeo)
    if (document.activeElement === sel) return;    // se está usando: no se reconstruye (cerraría la lista en el móvil)
    firmaSel = opts;
    sel.innerHTML = '<option value="">— Elige un repartidor —</option>' + opts;
    if (regSel && ids.includes(regSel)) sel.value = regSel;
  }
  function modoAsignacion(m) {
    modoAsig = m;
    el("pdModo").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    el("pdRegBox").classList.toggle("oculto", m !== "registrado");
    el("pdInvBox").classList.toggle("oculto", m !== "invitado");
    el("pdIvaBox").classList.toggle("oculto", m !== "registrado");   // el IVA solo aplica con repartidor registrado
    el("pdCrear").textContent = m === "invitado" ? "Crear pedido y generar enlace" : "Crear y asignar pedido";
  }

  /* Delivery + IVA = total que verá el repartidor */
  function pintarTotalDelivery() {
    const b = O.r2(el("pdDelivery").value), i = O.r2(el("pdIva").value);
    el("pdTotalDel").innerHTML = b || i ? `Total para el repartidor: <b>${O.money(b + i)}</b>${i ? ` (${O.money(b)} + ${O.money(i)} IVA)` : ""}` : "Escribe el delivery y, si aplica, el IVA.";
    el("pdIvaRap").querySelectorAll("button").forEach((x) => x.classList.toggle("on", O.r2(x.dataset.iva) === i && (i > 0 || x.dataset.iva === "0" && el("pdIva").value !== "")));
  }

  /* Mensaje visible dentro de la pestaña Pedidos (el toast vive en el mapa y ahí no se ve) */
  function aviso(txt, tipo = "") {
    const m = el("pdMsg"); if (!m) return;
    m.textContent = txt || ""; m.className = "estado " + tipo + (txt ? "" : " oculto");
    if (txt && m.scrollIntoView) m.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  async function crearPedido(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (creando) return;
    const falla = (t) => { aviso(t, "error"); toast(t); };
    aviso("");
    const cliente = el("pdCliente").value.trim(), en = el("pdEntrega").value.trim();
    const retiros = retirosForm.filter((r) => r.texto.trim()).map((r) => Object.assign({ texto: r.texto.trim(), producto: (r.producto || "").trim() }, r.ll || {}));
    if (!cliente) return falla("Escribe el nombre del cliente.");
    if (!retiros.length || !en) return falla("Indica al menos un lugar de retiro y el de entrega.");
    let asignacion;
    if (modoAsig === "registrado") {
      const uid = regSel || el("pdRegSel").value;
      if (!uid) return falla("Elige un repartidor registrado, o cambia a “Enlace de invitado”.");
      asignacion = { tipo: "registrado", uid, nombre: nombreUid(uid) };
    } else asignacion = { tipo: "invitado" };
    creando = true; el("pdCrear").disabled = true; aviso("Creando pedido…", "ok");
    try {
      // JSON ida y vuelta: Firebase rechaza los valores "undefined" y haría fallar la escritura completa
      const datos = JSON.parse(JSON.stringify({
        cliente, paquete: el("pdPaquete").value, retiros, delivery: parseFloat(el("pdDelivery").value) || 0,
        iva: asignacion.tipo === "registrado" ? parseFloat(el("pdIva").value) || 0 : 0,
        entrega: Object.assign({}, lugarSel.entrega || {}, { texto: en }), asignacion
      }));
      const { token, orden } = await O.crear(db, datos);
      ["pdCliente", "pdEntrega", "pdPaquete", "pdDelivery", "pdIva"].forEach((id) => { el(id).value = ""; }); pintarTotalDelivery();
      lugarSel.entrega = null; retirosForm = [{ texto: "", ll: null, producto: "" }]; pintarRetiros(); pintarOk(el("pdEntregaOk"), null); ocultarSugs();
      if (asignacion.tipo === "invitado") { aviso(""); mostrarEnlaces(token, orden); }
      else {
        const t = `Pedido ${orden.codigo} enviado a ${asignacion.nombre} ✓ (${O.textoDelivery(orden)})` + (O.valido(orden.retiros[0]) ? " y su ruta al primer retiro." : ".");
        aviso(t, "ok"); toast(t);
      }
    } catch (err) {
      console.error("crearPedido", err);
      falla("No se pudo crear el pedido: " + ((err && (err.code ? err.code + " · " : "") + err.message) || err) + (err && err.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : ""));
    } finally { creando = false; el("pdCrear").disabled = false; }
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
      try {
        await O.asignar(db, t, o, { tipo: "registrado", uid, nombre: nombreUid(uid) });
        await db.ref("ordenes/" + t).update({ estado_asignacion: "pendiente" });   // el nuevo repartidor debe aceptar de nuevo
        cerrarModal(); toast(`Asignado a ${nombreUid(uid)} ✓`);
      }
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
      <div class="ruta">${O.paradas(o).map((p, k) => `${p.retirado ? "✅" : "📦"} ${O.paradas(o).length > 1 ? "Retiro " + (k + 1) + ": " : ""}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}`).join("<br>")}<br>🏠 ${esc((o.entrega && o.entrega.texto) || "—")}${o.delivery || o.iva ? "<br>🛵 Delivery: <b>" + O.textoDelivery(o) + "</b>" : ""}${o.paquete ? "<br>📝 " + esc(o.paquete) : ""}${a.tipo === "registrado" && activa(o) ? (o.estado_asignacion === "aceptado" ? "<br>✅ Aceptado por el repartidor" : o.estado_asignacion === "rechazado" ? "<br>❌ Rechazado por el repartidor" : o.estado === "asignado" ? "<br>⏳ Esperando respuesta del repartidor" : "") : ""}</div>
      <div class="acciones-fila" style="flex-wrap:wrap">
        ${inv && activa(o) ? btn("linkinv", "🔗 Enlace invitado") : ""}${inv && a.nombre && activa(o) ? btn("chatinv", "🗨 Chat invitado" + (sinLeerInv[t] ? " (" + sinLeerInv[t] + ")" : "")) : ""}${a.tipo && activa(o) ? btn("linkcli", "💬 Enlace cliente") : ""}
        ${(o.estado === "pendiente" && !a.tipo) || (o.estado_asignacion === "rechazado" && activa(o)) ? btn("asignar", o.estado_asignacion === "rechazado" ? "Reasignar" : "Asignar", "pri") : ""}
        ${activa(o) ? btn("cancelar", "Cancelar", "peligro") : btn("borrar", "Eliminar", "peligro")}
      </div></div>`;
  }
  function pintarOrdenes() {
    const ids = Object.keys(ordenes).sort((a, b) => (ordenes[b].creado || 0) - (ordenes[a].creado || 0));
    el("listaPedidos").innerHTML = ids.length ? ids.map(tarjeta).join("") : '<p class="ayuda">Aún no hay pedidos. Crea el primero arriba.</p>';
    const c = el("pdCuenta"); if (c) c.textContent = ids.length;
  }

  /* ---------- Chat Admin ↔ repartidor invitado (nodo chatsInvitado/{token}) ---------- */
  function abrirChatInv(t) {
    const o = ordenes[t]; if (!o) return;
    const nom = (o.asignacion && o.asignacion.nombre) || "Invitado";
    chatInvAbierto = t; sinLeerInv[t] = 0; pintarOrdenes();
    Chat.iniciar({
      token: t, yo: "admin", ruta: RUTA_INV, pedido: o.codigo, nombreRepartidor: nom, puedeBorrar: true, avisos: false,
      titulo: () => "Chat con " + nom, subtitulo: () => "Pedido " + o.codigo + " · invitado",
      alCerrar: () => { chatInvAbierto = null; }
    });
    Chat.abrir();
  }
  function escucharChatInv() {
    if (refChatInv) refChatInv.off();
    primeraInv = true;
    refChatInv = db.ref("chatsInvitadoResumen");
    refChatInv.on("value", (s) => {
      const n = s.val() || {};
      if (!primeraInv) Object.entries(n).forEach(([t, r]) => {
        const antes = (resInv[t] && resInv[t].ts) || 0;
        if (r.ultimoDe === "repartidor" && (r.ts || 0) > antes) {
          if (chatInvAbierto !== t) sinLeerInv[t] = (sinLeerInv[t] || 0) + 1;
          const txt = `💬 ${r.repartidor || "Invitado"} (pedido ${r.pedido || ""}): ${r.ultimo || ""}`;
          toast(txt); O.hablar("Mensaje del repartidor invitado " + (r.repartidor || ""));
        }
      });
      primeraInv = false; resInv = n; pintarOrdenes();
    }, () => {});
  }

  /* Ventana visible cuando un repartidor rechaza el pedido (con atajo para reasignarlo) */
  function alertaRechazo(t, o, quien) {
    if (!el("modalAdmin").classList.contains("oculto")) return;   // hay otra ventana abierta: basta el aviso (toast) y la voz
    modal(`<h2>❌ Pedido rechazado</h2>
      <p>El repartidor <b>${esc(quien)}</b> rechazó el pedido <b>${esc(o.codigo)}</b>${o.cliente ? " (" + esc(o.cliente) + ")" : ""}.</p>
      <button id="pdRechReasig" class="primario" type="button">Reasignar a otro repartidor</button>
      <button id="pdRechCerrar" class="oscuro" type="button">Cerrar</button>`);
    el("pdRechCerrar").onclick = cerrarModal;
    el("pdRechReasig").onclick = () => asignarExistente(t);
  }

  /* Avisos en vivo (texto + VOZ ALTA): el invitado abrió el enlace, retiró un producto, entregó */
  function avisarCambios(nuevo) {
    const decir = (txt) => { toast(txt); O.hablar(txt.replace(/[📦✅❌🔗🛵]/gu, "")); };
    Object.entries(nuevo).forEach(([t, o]) => {
      const a = ordenes[t]; if (!a) return;
      /* El repartidor registrado aceptó o rechazó el pedido asignado */
      const resp = o.estado_asignacion;
      if (resp !== a.estado_asignacion && (resp === "aceptado" || resp === "rechazado") && o.asignacion && o.asignacion.tipo === "registrado") {
        const quien = o.asignacion.nombre || "repartidor";
        if (resp === "aceptado") decir(`✅ El repartidor ${quien} aceptó el pedido ${o.codigo}`);
        else { decir(`❌ El repartidor ${quien} rechazó el pedido ${o.codigo}`); alertaRechazo(t, o, quien); }
      }
      const nom = (o.asignacion && o.asignacion.nombre) || "El repartidor", pa = O.paradas(a), po = O.paradas(o);
      if (o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && !(a.asignacion && a.asignacion.nombre)) decir(`🔗 ${nom} aceptó el pedido ${o.codigo}`);
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
  /* ---------- Repartidor invitado tocado en el mapa: Entregado / Cancelar / Chat ---------- */
  const tokenInv = (uid) => String(uid).replace(/^inv_/, "");
  const invCerrado = (uid) => { const o = ordenes[tokenInv(uid)]; return !!o && O.esInvitadoUid(uid) && !activa(o); };   // su pedido ya terminó: no se dibuja
  function chatInvitado(uid) { abrirChatInv(tokenInv(uid)); }
  async function accionInvitado(uid, accion) {
    const t = tokenInv(uid), o = ordenes[t]; if (!o) return toast("No encuentro el pedido de este invitado.");
    const ent = accion === "entregado", est = ent ? "entregado" : "cancelado";
    if (!confirm(ent ? `¿Marcar como ENTREGADO el pedido ${o.codigo}? El repartidor saldrá del mapa.` : `¿Cancelar el pedido ${o.codigo}? El repartidor saldrá del mapa.`)) return;
    const upd = { [`ordenes/${t}/estado`]: est, [`ordenes/${t}/actualizado`]: O.TS, ["ubicaciones/" + uid]: null, ["guias/" + uid]: null };
    if (ent) upd[`ordenes/${t}/entregadoTs`] = O.TS;
    try {
      if ((await db.ref("pedidos/" + t).once("value")).exists()) {
        upd[`pedidos/${t}/estado`] = est;
        if (ent) upd[`pedidos/${t}/fin`] = O.TS;
      }
      await db.ref().update(upd);
      toast(ent ? "Pedido entregado ✓ El repartidor salió del mapa." : "Pedido cancelado. El repartidor salió del mapa.");
    } catch (err) { toast("No se pudo actualizar: " + err.message); }
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
      document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { cerrarMapaForm(); if (b.dataset.tab === "panelPedidos") pintarSelectorReg(); }));
      el("pdModo").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) modoAsignacion(b.dataset.m); };
      el("pdCrear").onclick = crearPedido;
      el("pdRegSel").addEventListener("change", (e) => { regSel = e.target.value; });
      el("pdDelivery").addEventListener("input", pintarTotalDelivery); el("pdIva").addEventListener("input", pintarTotalDelivery);
      el("pdIvaRap").onclick = (e) => { const b = e.target.closest("button[data-iva]"); if (!b) return; el("pdIva").value = b.dataset.iva === "0" ? "" : b.dataset.iva; pintarTotalDelivery(); if (b.dataset.iva === "0") b.classList.add("on"); };
      pintarTotalDelivery();
      pintarRetiros();
      el("pdAddRetiro").onclick = () => { retirosForm.push({ texto: "", ll: null, producto: "" }); pintarRetiros(); const f = filaEl(retirosForm.length - 1); f && f.querySelector("input").focus(); };
      const rc = el("pdRetiros");
      rc.addEventListener("input", (e) => {
        const f = e.target.closest("[data-i]"), campo = e.target.dataset.f; if (!f) return; const i = +f.dataset.i;
        if (campo === "texto") alEscribirRetiro(i, e.target.value); else if (campo === "producto") retirosForm[i].producto = e.target.value;
      });
      rc.addEventListener("click", (e) => {
        const b = e.target.closest("button[data-a]"), f = e.target.closest("[data-i]"); if (!b || !f) return; const i = +f.dataset.i;
        if (b.dataset.a === "mapa") abrirMapaForm("retiro", i);
        else if (b.dataset.a === "quitar") { retirosForm.splice(i, 1); pintarRetiros(); }
      });
      rc.addEventListener("click", (e) => {   // elegir una burbuja de negocio
        const b = e.target.closest("button[data-lid]"), f = e.target.closest("[data-i]"); if (!b || !f) return;
        const l = lugares[b.dataset.lid]; if (!l) return;
        fijarRetiro(+f.dataset.i, l, l.nombre); ocultarSugs();
      });
      rc.addEventListener("focusin", (e) => { if (e.target.dataset.f === "texto") { const f = e.target.closest("[data-i]"); if (f && !retirosForm[+f.dataset.i].ll) mostrarSug(f.querySelector("[data-sug]"), e.target.value); } });
      el("pdEntrega").addEventListener("focus", () => { if (!lugarSel.entrega) mostrarSug(el("pdEntregaSug"), el("pdEntrega").value); });
      el("pdEntregaSug").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-lid]"); if (!b) return;
        const l = lugares[b.dataset.lid]; if (!l) return;
        fijarEntrega(l, l.nombre); ocultarSugs();
      });
      document.addEventListener("click", (e) => { if (!e.target.closest("#panelPedidos .pd-lugar")) ocultarSugs(); });
      el("pdEntrega").addEventListener("input", alEscribirEntrega);
      el("pdEntregaMapa").onclick = () => abrirMapaForm("entrega");
      pintarOk(el("pdEntregaOk"), null);
      el("listaPedidos").onclick = (e) => {
        const b = e.target.closest("button[data-pa]"); if (!b) return;
        const t = b.dataset.t, o = ordenes[t], a = b.dataset.pa; if (!o) return;
        if (a === "chatinv") abrirChatInv(t);
        else if (a === "linkinv") mostrarEnlaces(t, o);
        else if (a === "linkcli") copiar(O.urlCliente(t));
        else if (a === "asignar") asignarExistente(t);
        else if (a === "cancelar") cancelarOrden(t);
        else if (a === "borrar") { if (confirm("¿Eliminar este pedido del historial?")) db.ref("ordenes/" + t).remove().catch((err) => toast(err.message)); }
      };
      modoAsignacion("registrado");
    }
    escucharChatInv();
    ref = db.ref("ordenes").orderByChild("creado").limitToLast(60);
    ref.on("value", (s) => {
      const nuevo = s.val() || {};
      if (!primera) avisarCambios(nuevo);
      primera = false; ordenes = nuevo;
      pintarOrdenes(); pintarSelectorReg(); pintarEquipo(); pintarLista();
    }, () => { el("listaPedidos").innerHTML = '<p class="ayuda">Sin permiso para leer “ordenes”. Revisa las reglas de Firebase (ver LEEME).</p>'; });
  }
  function detener() { if (ref) { ref.off(); ref = null; } if (refChatInv) { refChatInv.off(); refChatInv = null; } ordenes = {}; resInv = {}; sinLeerInv = {}; cerrarMapaForm(); quitarTemp(); cancelarClick(); }

  return { iniciar, detener, clickMapa, htmlInvitados, notaRep, cerrarInvitado, accionInvitado, chatInvitado, invCerrado, tokenInv, cerrarMapaForm, clienteDe: (t) => (ordenes[t] && ordenes[t].cliente) || "" };
})();
