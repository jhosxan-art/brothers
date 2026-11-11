/* ============================================================
   ORDENES-ADMIN · Panel del administrador (Fases 2, 3 y 4 unificadas)
   FASE ÚNICA: se añade el módulo EQUIPO que reemplaza a pintarEquipo()
   con un renderizado robusto, redundante y auto-recuperable.
   ============================================================ */

/* ============================================================
   1) PEDIDOS ADMIN (Asignación, creación, forzar estados)
   ============================================================ */
const PedidosAdmin = (() => {
  const O = Ordenes, esc = O.esc, el = (id) => document.getElementById(id);
  let ordenes = {}, ref = null, primera = true, listo = false;
  let tempMarca = null, timerClick = null, popupCerrado = 0, busqAbierta = false, ovl = null;
  let avisoToken = null;
  let regSel = "", creando = false, firmaSel = ""; 
  let refChatInv = null, resInv = {}, primeraInv = true, sinLeerInv = {}, chatInvAbierto = null;
  const RUTA_INV = { chats: "chatsInvitado", resumen: "chatsInvitadoResumen", fotos: "fotosInvitado", leido: "leidosInvitado" };
  const nuevoRetiro = () => ({ texto: "", ll: null, producto: "" }), nuevaEntrega = () => ({ texto: "", ll: null, tipo: "entrega", nota: "" });
  let retirosForm = [nuevoRetiro()]; 
  let entregasForm = [nuevaEntrega()]; 
  let modoAsig = "registrado";

  const cod = (c) => { const d = String(c == null ? "" : c).replace(/\D/g, ""); return d ? "APP" + d.padStart(5, "0") : String(c == null ? "" : c); };
  const activa = (o) => ["pendiente", "asignado", "retirado"].includes(o.estado);
  const nombreOrden = (o) => (o.asignacion && (o.asignacion.nombre || (o.asignacion.tipo === "invitado" ? "Invitado (sin aceptar)" : ""))) || "Sin asignar";
  
  function copiar(texto) {
    const ok = () => toast("Enlace copiado ✓");
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(texto).then(ok).catch(() => prompt("Copia el enlace:", texto));
    prompt("Copia el enlace:", texto);
  }
  const wa = (msg) => window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_system");
  
  function repsActivos() {
    const ids = [...new Set([...Object.keys(registrados), ...Object.keys(ubic)])];
    return ids.filter((u) => ["enRuta", "libre"].includes(estadoDe(u))).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
  }

  // FASE 1 · Capas del mapa: los negocios (.neg-ico) siempre quedan POR DEBAJO de repartidores y demás marcadores.
  // Leaflet asigna z-index inline según la latitud; aquí se fuerza un valor bajo fijo para los negocios y se mantiene
  // aunque Leaflet reposicione los íconos (zoom, movimiento, actualización en vivo).
  let obsCapas = null;
  function ordenarCapasMapa() {
    const pane = document.querySelector(".leaflet-marker-pane");
    if (!pane) return;
    pane.querySelectorAll(".leaflet-marker-icon.neg-ico").forEach((m) => {
      if (m.style.zIndex !== "-100000") m.style.zIndex = "-100000";
    });
  }
  function vigilarCapasMapa() {
    if (obsCapas) return;
    const pane = document.querySelector(".leaflet-marker-pane");
    if (!pane) { setTimeout(vigilarCapasMapa, 800); return; }
    let t = null;
    obsCapas = new MutationObserver(() => { if (t) return; t = setTimeout(() => { t = null; ordenarCapasMapa(); }, 30); });
    obsCapas.observe(pane, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
    ordenarCapasMapa();
  }

  function cancelarClick() { if (timerClick) { clearTimeout(timerClick); timerClick = null; } }
  function quitarTemp() { if (tempMarca && mapa) { mapa.removeLayer(tempMarca); } tempMarca = null; }

  function clickMapa(ll) {
    if (typeof ZonasMapa !== "undefined" && ZonasMapa.capturar(ll)) return;   // modo dibujo de zonas: el toque es un vértice
    if (busqAbierta || Date.now() - popupCerrado < 350) return;
    if (!el("modalAdmin").classList.contains("oculto")) return;
    cancelarClick();
    timerClick = setTimeout(() => { timerClick = null; abrirAsignacion(ll); }, 260);
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
        if (typeof PushAdmin !== "undefined") PushAdmin.punto(uid, punto);
        cerrarModal();
        toast(`${O.PUNTOS[punto].icono} ${O.PUNTOS[punto].nombre} enviado a ${nombreUid(uid)} ✓ Su ruta se traza sola.`);
      } catch (err) { toast("No se pudo asignar: " + err.message); el("pdAsignar").disabled = false; }
    };
  }

  const okLL = (ll) => !!ll && typeof ll.lat === "number" && typeof ll.lng === "number";
  const hitLugar = (v) => { const n = (x) => String(x || "").toLowerCase().trim(); return Object.values(lugares).find((l) => n(l.nombre) === n(v) && typeof l.lat === "number"); };
  const lista = (cual) => (cual === "retiro" ? retirosForm : entregasForm);
  const esCobro = (cual, p) => cual === "entrega" && !!p && p.tipo === "cobro";
  const icono = (cual, p) => (cual === "retiro" ? "📦" : esCobro(cual, p) ? "💵" : "🏠");
  const etiqueta = (cual, i) => { const n = lista(cual).length; return (cual === "retiro" ? "Retiro" : esCobro(cual, lista(cual)[i]) ? "Cobro" : "Entrega") + (n > 1 ? " " + (i + 1) : ""); };
  const textoPunto = (p) => p.texto.trim() || (okLL(p.ll) ? `Punto del mapa (${p.ll.lat.toFixed(5)}, ${p.ll.lng.toFixed(5)})` : "");
  const tieneLugar = (p) => !!p.texto.trim() || okLL(p.ll);

  function pintarLugares() {
    const fila = (cual, i, p) => {
      const t = textoPunto(p), det = cual === "entrega" && (p.nota || "").trim() ? " · " + p.nota.trim() : "";
      const est = okLL(p.ll) ? ["ok", "✓ En el mapa"] : p.texto.trim() ? ["med", "Solo dirección"] : ["no", "Pendiente"];
      return `<div class="pdl-fila ${cual}" data-k="${cual}" data-i="${i}">
        <button type="button" class="pdl-pt" data-a="mapa" aria-label="Fijar ${esc(etiqueta(cual, i))} en el mapa">
          <span class="pdl-ico" aria-hidden="true">${icono(cual, p)}</span>
          <span class="pdl-txt"><b>${esc(etiqueta(cual, i))}</b>${t || det ? `<small>${esc(t + det)}</small>` : ""}</span>
          <span class="pdl-est ${est[0]}">${est[1]}</span>
        </button>
        ${cual === "retiro" ? `<input data-f="producto" maxlength="120" autocomplete="off" placeholder="Producto a retirar aquí (ej. 2 pizzas medianas)" aria-label="Producto a retirar en ${esc(etiqueta(cual, i))}" value="${esc(p.producto)}">` : ""}
      </div>`;
    };
    el("pdLista").innerHTML = retirosForm.map((p, i) => fila("retiro", i, p)).join("") + entregasForm.map((p, i) => fila("entrega", i, p)).join("");
  }
  function añadir(cual) { lista(cual).push(cual === "retiro" ? nuevoRetiro() : nuevaEntrega()); pintarLugares(); return lista(cual).length - 1; }

  const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  function coincidencias(v) {
    const q = norm(v); if (!q) return [];
    const ts = q.split(/\s+/), validos = Object.entries(lugares).filter(([, l]) => l && l.nombre && typeof l.lat === "number");
    const porNombre = (a, b) => a[1].nombre.localeCompare(b[1].nombre, "es", { sensitivity: "base" });
    const empieza = validos.filter(([, l]) => norm(l.nombre).startsWith(q)).sort(porNombre);
    const resto = validos.filter(([id, l]) => !empieza.some((e) => e[0] === id) && (() => { const pal = norm(l.nombre).split(/\s+/); return ts.every((t) => pal.some((w) => w.startsWith(t))); })()).sort(porNombre);
    return empieza.concat(resto).slice(0, 12);
  }
  function mostrarSug(box, v) {
    if (!box) return;
    const q = norm(v), l = coincidencias(v);
    if (!l.length) { box.classList.add("oculto"); box.innerHTML = ""; return; }
    const nombreHtml = (n) => {
      const k = String(v || "").trim().length;
      return k && norm(n.slice(0, k)) === q ? `<b>${esc(n.slice(0, k))}</b>${esc(n.slice(k))}` : esc(n);
    };
    box.innerHTML = l.map(([id, x]) => `<button type="button" class="pdm-burb" data-lid="${esc(id)}"><span>${esc(x.icono || "🏪")}</span><span class="pdm-bn">${nombreHtml(x.nombre)}</span>${x.dir ? `<small>${esc(x.dir)}</small>` : ""}</button>`).join("");
    box.classList.remove("oculto");
    box.scrollTop = 0;
  }

  const fmtKm = (m) => (m / 1000).toFixed(1) + " km";
  const fmtEta = (s) => { const mi = Math.max(1, Math.round(s / 60)); return mi >= 60 ? Math.floor(mi / 60) + " h " + (mi % 60) + " min" : mi + " min"; };
  function puntosForm() {
    const l = [];
    retirosForm.forEach((p, i) => l.push({ cual: "retiro", i, p }));
    entregasForm.forEach((p, i) => l.push({ cual: "entrega", i, p }));
    return l;
  }
  function cerrarMapaForm() {
    if (!ovl) return false;
    try { ovl.m.remove(); } catch (_) {}
    ovl.div.remove(); ovl = null;
    pintarLugares();
    return true;
  }
  function abrirMapaForm(cual, i) {
    cerrarMapaForm();
    const div = document.createElement("div");
    div.className = "pdm";
    div.innerHTML = `<div id="pdOvlMapa" class="pdm-mapa"></div>
      <div class="pdm-top">
        <div class="pdm-top-fila"><button type="button" class="pdm-x" aria-label="Cerrar mapa">✕</button><div class="pdm-tabs" id="pdmTabs"></div></div>
        <div class="pdm-chips oculto" id="pdmSub"></div>
      </div>
      <div class="pdm-panel">
        <div class="pdm-info" id="pdOvlInfo"></div>
        <div class="pdm-ed-t" id="pdmEdT"></div>
        <input id="pdmDir" maxlength="160" autocomplete="off" aria-label="Dirección (opcional)">
        <div id="pdmSug" class="pdm-sug oculto"></div>
        <div id="pdmDet" class="pdm-det oculto">
          <div class="pdm-seg" id="pdmTipo"><button type="button" data-t="entrega">🏠 Otra entrega</button><button type="button" data-t="cobro">💵 Lugar de cobro</button></div>
          <input id="pdmNota" maxlength="140" autocomplete="off" placeholder="Detalle para el repartidor (ej. cobrar C$350 en efectivo)" aria-label="Detalle para el repartidor">
        </div>
        <button type="button" id="pdmAdd" class="pdm-add"></button>
        <div class="pdm-fila2"><button type="button" id="pdmQuitar" class="pdm-quitar"></button><button type="button" class="pdm-ok">Listo</button></div>
      </div>`;
    document.body.appendChild(div);
    const g = (id) => div.querySelector("#" + id);
    const m = L.map(g("pdOvlMapa"), { zoomControl: false }).setView(mapa ? mapa.getCenter() : [12.5700, -87.1311], mapa ? Math.max(mapa.getZoom(), 13) : 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    const idx = Math.min(Math.max(+i || 0, 0), lista(cual).length - 1);
    ovl = { div, m, capa: L.layerGroup().addTo(m), rutaCapa: L.layerGroup().addTo(m), activo: { cual, i: idx }, ult: { retiro: 0, entrega: 0 }, seq: 0 };
    ovl.ult[cual] = idx;
    const info = (t) => { const e = g("pdOvlInfo"); if (e) e.innerHTML = t; };
    const act = () => lista(ovl.activo.cual)[ovl.activo.i];
    const ir = (c, k) => { ovl.activo = { cual: c, i: k }; ovl.ult[c] = k; };

    function titulo() { 
      const a = ovl.activo, p = act(), extra = a.cual === "entrega" && a.i > 0;
      g("pdmEdT").textContent = `${icono(a.cual, p)} ${etiqueta(a.cual, a.i)} · ` + (okLL(p.ll) ? "ubicación fijada (toca el mapa para moverla)" : "toca el mapa para fijar la ubicación");
      g("pdmDir").placeholder = a.cual === "retiro" ? "Dirección o negocio de retiro (opcional)" : esCobro(a.cual, p) ? "Dirección del lugar de cobro (opcional)" : "Dirección de entrega (opcional)";
      g("pdmAdd").textContent = a.cual === "retiro" ? "➕ Otro retiro" : "➕ Otra entrega o cobro";
      g("pdmQuitar").textContent = a.i > 0 ? `🗑 Quitar ${etiqueta(a.cual, a.i)}` : "🗑 Cancelar ubicación y dirección";
      g("pdmDet").classList.toggle("oculto", !extra);
      g("pdmTipo").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.t === (p.tipo === "cobro" ? "cobro" : "entrega")));
    }
    function cargarEditor() {
      titulo(); const p = act();
      g("pdmDir").value = p.texto; g("pdmNota").value = p.nota || "";
      g("pdmSug").classList.add("oculto"); g("pdmSug").innerHTML = "";
    }
    async function trazar(encuadrar) {
      const mio = ovl, seq = ++mio.seq;
      mio.rutaCapa.clearLayers();
      const pts = puntosForm().filter((q) => okLL(q.p.ll)).map((q) => q.p.ll);
      if (pts.length < 2) {
        if (pts.length === 1 && encuadrar) m.setView([pts[0].lat, pts[0].lng], 16);
        return info("Fija al menos un retiro y una entrega para ver la ruta, la distancia y el tiempo.");
      }
      info("Calculando ruta por calles…");
      let dist = 0, dur = 0;
      for (let k = 0; k < pts.length - 1; k++) {
        let r = null;
        try { r = await O.rutaCalles({ lat: pts[k].lat, lng: pts[k].lng }, { lat: pts[k + 1].lat, lng: pts[k + 1].lng }); } catch (_) {}
        if (ovl !== mio || seq !== mio.seq) return;
        if (!r) return info("No se pudo calcular la ruta por calles. Cambia un punto o intenta de nuevo.");
        dist += r.dist; dur += r.dur;
        L.polyline([[pts[k].lat, pts[k].lng], ...r.pts, [pts[k + 1].lat, pts[k + 1].lng]], { color: "#0A86C9", weight: 6, opacity: .9 }).addTo(mio.rutaCapa);
      }
      info(`🛣 <b>${fmtKm(dist)}</b> · ⏱ ETA <b>≈ ${fmtEta(dur)}</b>`);
      if (encuadrar) m.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [110, 90], maxZoom: 17 });
    }
    function dibujar(encuadrar) {
      ovl.capa.clearLayers();
      const ps = puntosForm(), a = ovl.activo, l = lista(a.cual);
      g("pdmTabs").innerHTML = ["retiro", "entrega"].map((c) => {
        const arr = lista(c);
        return `<button type="button" data-g="${c}" class="${a.cual === c ? "on" : ""}">${c === "retiro" ? "📦 Retiro" : "🏠 Entrega"}${arr.length > 1 ? " (" + arr.length + ")" : ""}${arr.every((p) => okLL(p.ll)) ? " ✓" : ""}</button>`;
      }).join("");
      g("pdmSub").classList.toggle("oculto", l.length < 2);
      g("pdmSub").innerHTML = l.map((p, k) => `<button type="button" data-i="${k}" class="${k === a.i ? "on" : ""}">${icono(a.cual, p)} ${esc(etiqueta(a.cual, k))}${okLL(p.ll) ? " ✓" : ""}</button>`).join("");
      ps.forEach((q) => { 
        if (okLL(q.p.ll)) L.marker([q.p.ll.lat, q.p.ll.lng], { icon: O.pinIcono(q.cual, icono(q.cual, q.p)), opacity: q.cual === a.cual ? 1 : .4, zIndexOffset: q.cual === a.cual && q.i === a.i ? 800 : 0 }).addTo(ovl.capa);
      });
      titulo();
      trazar(encuadrar);
    }
    const mas = (c) => { const n = añadir(c); ir(c, n); cargarEditor(); dibujar(false); };

    g("pdmTabs").onclick = (e) => { 
      const b = e.target.closest("button[data-g]"); if (!b) return;
      const c = b.dataset.g; ir(c, Math.min(ovl.ult[c], lista(c).length - 1));
      cargarEditor(); dibujar(false);
      const p = act(); if (okLL(p.ll)) m.panTo([p.ll.lat, p.ll.lng]);
    };
    g("pdmSub").onclick = (e) => { 
      const b = e.target.closest("button[data-i]"); if (!b) return;
      ir(ovl.activo.cual, +b.dataset.i);
      cargarEditor(); dibujar(false);
      const p = act(); if (okLL(p.ll)) m.panTo([p.ll.lat, p.ll.lng]);
    };
    m.on("click", (e) => { 
      const p = act(); p.ll = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }; p.auto = false;
      dibujar(false);
    });
    g("pdmDir").addEventListener("input", (e) => { 
      const p = act(), v = e.target.value; p.texto = v;
      const hit = hitLugar(v);
      if (hit) { p.ll = { lat: hit.lat, lng: hit.lng }; p.auto = true; mostrarSug(g("pdmSug"), ""); dibujar(false); m.setView([hit.lat, hit.lng], Math.max(m.getZoom(), 16)); return; }
      if (p.auto) { p.ll = null; p.auto = false; dibujar(false); } 
      mostrarSug(g("pdmSug"), v);
    });
    g("pdmDir").addEventListener("focus", () => { const p = act(); if (!okLL(p.ll) && p.texto.trim()) mostrarSug(g("pdmSug"), p.texto); });
    g("pdmSug").onclick = (e) => {
      const b = e.target.closest("button[data-lid]"), l = b && lugares[b.dataset.lid]; if (!l) return;
      const p = act(); p.texto = l.nombre; p.ll = { lat: l.lat, lng: l.lng }; p.auto = true;
      g("pdmDir").value = l.nombre; mostrarSug(g("pdmSug"), "");
      dibujar(false); m.setView([l.lat, l.lng], Math.max(m.getZoom(), 16));
    };
    g("pdmTipo").onclick = (e) => { 
      const b = e.target.closest("button[data-t]"); if (!b) return;
      act().tipo = b.dataset.t === "cobro" ? "cobro" : "entrega";
      dibujar(false);
    };
    g("pdmNota").addEventListener("input", (e) => { act().nota = e.target.value; });
    g("pdmQuitar").onclick = () => { 
      const a = ovl.activo, arr = lista(a.cual);
      if (a.i > 0) { arr.splice(a.i, 1); ir(a.cual, a.i - 1); }
      else { const p = arr[0]; p.ll = null; p.texto = ""; p.auto = false; if (a.cual === "entrega") { p.tipo = "entrega"; p.nota = ""; } }
      cargarEditor(); dibujar(false);
    };
    g("pdmAdd").onclick = () => mas(ovl.activo.cual);
    div.querySelector(".pdm-x").onclick = cerrarMapaForm;
    div.querySelector(".pdm-ok").onclick = cerrarMapaForm;
    cargarEditor();
    setTimeout(() => { if (ovl && ovl.m === m) { m.invalidateSize(); dibujar(true); } }, 80);
  }

  /* FASE 2 · el selector directo y los botones de modo ya no existen: la asignación se elige en un modal al crear el pedido */
  function pintarSelectorReg() {}
  function modoAsignacion(m) { modoAsig = m; pintarTotalDelivery(); }

  const n2 = (v) => { const x = parseFloat(v); return isFinite(x) && x > 0 ? Math.round(x * 100) / 100 : 0; };
  function ivaBaseAuto(d) { if (d >= 35 && d < 200) return 7; if (d >= 200 && d <= 300) return 14; return 0; }
  function totalForm() {
    const reg = modoAsig === "registrado", d = n2(el("pdDelivery").value);
    const base = reg ? n2(el("pdIvaBase").value) : 0, extra = reg ? n2(el("pdIvaExtra").value) : 0, iva = n2(base + extra);
    return { d, base, extra, iva, total: n2(d + iva) };
  }
  function pintarTotalDelivery() {
    const t = totalForm(), partes = [t.d.toFixed(2)];
    if (t.base) partes.push(`${t.base.toFixed(2)} IVA`);
    if (t.extra) partes.push(`${t.extra.toFixed(2)} extra`);
    el("pdTotalDel").innerHTML = `<span>Total general<small>${t.d || t.iva ? partes.join(" + ") : "Escribe el delivery: el IVA base se calcula solo"}</small></span><b>${O.money(t.total)}</b>`;
  }
  function alEscribirDelivery() { 
    const raw = el("pdDelivery").value;
    el("pdIvaBase").value = raw === "" ? "" : String(ivaBaseAuto(n2(raw)));
    pintarTotalDelivery();
  }

  function aviso(txt, tipo = "") {
    const m = el("pdMsg"); if (!m) return;
    avisoToken = null;
    m.textContent = txt || ""; m.className = "estado " + tipo + (txt ? "" : " oculto");
    if (txt && m.scrollIntoView) m.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  async function crearPedido(ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    if (creando) return;
    const falla = (t) => { aviso(t, "error"); toast(t); };
    aviso("");
    const cliente = el("pdCliente").value.trim();
    const ll2 = (p) => (okLL(p.ll) ? { lat: p.ll.lat, lng: p.ll.lng } : {});
    const retiros = retirosForm.filter(tieneLugar).map((r) => Object.assign({ texto: textoPunto(r), producto: (r.producto || "").trim() }, ll2(r)));
    const entregas = entregasForm.filter(tieneLugar).map((p) => Object.assign({ texto: textoPunto(p), tipo: p.tipo === "cobro" ? "cobro" : "entrega", nota: (p.nota || "").trim() }, ll2(p)));
    if (!cliente) return falla("Escribe el nombre del cliente.");
    if (!retiros.length || !entregas.length) return falla("Fija al menos un lugar de retiro y uno de entrega (toca 📍 y elígelos en el mapa).");
    const principal = { texto: entregas[0].texto }; if (typeof entregas[0].lat === "number") { principal.lat = entregas[0].lat; principal.lng = entregas[0].lng; }
    const extras = entregas.slice(1);
    const linea = (x, n) => `${x.tipo === "cobro" ? "💵 Lugar de cobro" : "🏠 Entrega"} ${n}: ${x.texto}${x.nota ? " — " + x.nota : ""}${typeof x.lat === "number" ? " https://www.google.com/maps?q=" + x.lat + "," + x.lng : ""}`;
    const lineas = extras.map((x, k) => linea(x, k + 2));
    if (entregas[0].tipo === "cobro" || entregas[0].nota) lineas.unshift(linea(entregas[0], 1));
    const paquete = [el("pdPaquete").value.trim()].concat(lineas).filter(Boolean).join("\n");
    modoAsig = "registrado"; pintarTotalDelivery();
    pedirAsignacion({ cliente, paquete, retiros, extras, principal });
  }

  /* FASE 2 · Modal de asignación: repartidor registrado (con foto) o enlace de invitado */
  function avatarRep(uid) {
    const f = typeof fotosCache !== "undefined" ? fotosCache[uid] : null;
    return f && typeof f === "string" && f.indexOf("data:image/") === 0
      ? `<span class="as-av con-foto" style="background-image:url('${f}')"></span>`
      : `<span class="as-av">${typeof RIDER_SVG !== "undefined" ? RIDER_SVG : "🛵"}</span>`;
  }
  function pedirAsignacion(base) {
    const rango = { libre: 0, enRuta: 1, sinSenal: 2, desconectado: 3, sinDatos: 4 };
    const ids = Object.keys(registrados).sort((a, b) => (rango[estadoDe(a)] - rango[estadoDe(b)]) || nombreUid(a).localeCompare(nombreUid(b)));
    const tot = totalForm();
    modal(`<div class="as-caja"><h2>Asignar pedido</h2>
      <p class="ayuda">Cliente <b>${esc(base.cliente)}</b> · Total <b>${esc(O.money(tot.total))}</b></p>
      <div class="as-sec">🛵 Asignar a un repartidor registrado</div>
      <div class="as-lista" id="asLista">${ids.length ? ids.map((u) => {
        const r = registrados[u] && typeof registrados[u] === "object" ? registrados[u] : {}, [tx, cl] = ETIQUETA[estadoDe(u)];
        return `<button type="button" class="as-rep" data-uid="${esc(u)}">${avatarRep(u)}<span class="as-dat"><strong>${esc(nombreUid(u))}</strong><small>${esc(r.telefono ? "📱 +" + r.telefono : (r.email || "Sin datos de contacto"))}${viajeDe(u) ? " · con pedido" : ""}</small></span><span class="chip ${esc(cl)}">${esc(tx)}</span></button>`;
      }).join("") : '<p class="ayuda">Aún no hay repartidores registrados.</p>'}</div>
      <div class="as-o"><span>o</span></div>
      <button id="asInv" class="as-inv" type="button"><b>🔗 Crear enlace de invitado</b><small>Para un repartidor externo. Lo envías por WhatsApp o lo copias. El pedido va sin IVA.</small></button>
      <button id="asNo" class="oscuro" type="button">Cancelar</button></div>`);
    el("asNo").onclick = cerrarModal;
    el("asLista").onclick = (e) => {
      const b = e.target.closest("button[data-uid]"); if (!b) return;
      confirmarCreacion(base, { tipo: "registrado", uid: b.dataset.uid, nombre: nombreUid(b.dataset.uid) });
    };
    el("asInv").onclick = () => confirmarCreacion(base, { tipo: "invitado" });
  }

  async function confirmarCreacion(base, asignacion) {
    if (creando) return;
    const falla = (t) => { aviso(t, "error"); toast(t); };
    cerrarModal();
    modoAsig = asignacion.tipo; creando = true; el("pdCrear").disabled = true; aviso("Creando pedido…", "ok");
    const tot = totalForm(), { cliente, paquete, retiros, extras, principal } = base;
    try {
      const datos = JSON.parse(JSON.stringify({
        cliente, paquete, retiros, delivery: tot.d,
        iva: asignacion.tipo === "registrado" ? tot.iva : 0,
        entrega: principal, entregasExtra: extras, asignacion
      }));
      const { token, orden } = await O.crear(db, datos);
      if (extras.length) db.ref("ordenes/" + token + "/entregasExtra").set(extras).catch(() => {});
      ["pdCliente", "pdPaquete", "pdDelivery", "pdIvaBase"].forEach((id) => { el(id).value = ""; }); el("pdIvaExtra").value = "0";
      retirosForm = [nuevoRetiro()]; entregasForm = [nuevaEntrega()]; pintarLugares();
      if (asignacion.tipo === "invitado") { aviso(""); mostrarEnlaces(token, orden); }
      else {
        const t = `Pedido ${cod(orden.codigo)} enviado a ${asignacion.nombre} ✓ (${O.textoDelivery(orden)})` + (O.valido(orden.retiros[0]) ? " y su ruta al primer retiro." : ".");
        aviso(t, "ok"); avisoToken = token; toast(t);
        if (typeof PushAdmin !== "undefined") PushAdmin.pedidoAsignado(asignacion.uid, Object.assign({ token }, orden));
      }
    } catch (err) {
      console.error("crearPedido", err);
      falla("No se pudo crear el pedido: " + ((err && (err.code ? err.code + " · " : "") + err.message) || err) + (err && err.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : ""));
    } finally { creando = false; el("pdCrear").disabled = false; modoAsig = "registrado"; pintarTotalDelivery(); }
  }

  function mostrarEnlaces(t, o) {
    const li = O.urlInvitado(t), lc = O.urlCliente(t);
    const msgWa = `🛵 Brother’s Deliverys · Pedido ${cod(o.codigo)}\nAbre este enlace, escribe tu nombre y sigue la ruta:\n${li}`;
    modal(`<h2>🔗 Enlace de invitado</h2>
      <p class="ayuda">Pedido <b>${esc(cod(o.codigo))}</b> · ${esc(o.cliente)}. Envía este enlace a quien hará la entrega: solo tendrá que escribir su nombre.</p>
      <div class="pd-enlace">${esc(li)}</div>
      <button id="pdWaInv" class="whatsapp" type="button">💬 Enviar por WhatsApp</button>
      <button id="pdCopiarInv" class="primario" type="button">📋 Copiar enlace y código ${esc(cod(o.codigo))}</button>
      <p class="ayuda">Enlace del cliente (seguimiento + chat con el invitado):</p>
      <div class="pd-enlace">${esc(lc)}</div>
      <button id="pdCopiarCli" type="button">📋 Copiar enlace del cliente</button>
      <button id="pdCerrarEnl" class="oscuro" type="button">Listo</button>`);
    el("pdCopiarInv").onclick = () => copiar(`Pedido ${cod(o.codigo)}\n${li}`);
    el("pdCopiarCli").onclick = () => copiar(lc);
    el("pdWaInv").onclick = () => wa(msgWa);
    el("pdCerrarEnl").onclick = cerrarModal;
  }

  function asignarExistente(t) {
    const o = ordenes[t]; if (!o) return;
    const ids = Object.keys(registrados).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
    modal(`<h2>Asignar pedido ${esc(cod(o.codigo))}</h2>
      <label>Repartidor registrado<select id="pdAsSel"><option value="">— Elige —</option>${ids.map((u) => `<option value="${esc(u)}">${esc(nombreUid(u))}</option>`).join("")}</select></label>
      <button id="pdAsOk" class="primario" type="button">Asignar</button>
      <button id="pdAsInv" type="button">🔗 Generar enlace de invitado</button>
      <button id="pdAsNo" class="oscuro" type="button">Cancelar</button>`);
    el("pdAsNo").onclick = cerrarModal;
    el("pdAsOk").onclick = async () => {
      const uid = el("pdAsSel").value; if (!uid) return toast("Elige un repartidor.");
      try {
        await O.asignar(db, t, o, { tipo: "registrado", uid, nombre: nombreUid(uid) });
        await db.ref("ordenes/" + t).update({ estado_asignacion: "pendiente" }); 
        cerrarModal(); toast(`Asignado a ${nombreUid(uid)} ✓`);
        if (typeof PushAdmin !== "undefined") PushAdmin.pedidoAsignado(uid, Object.assign({ token: t }, o)); 
      }
      catch (err) { toast("No se pudo asignar: " + err.message); }
    };
    el("pdAsInv").onclick = async () => {
      try { await O.asignar(db, t, o, { tipo: "invitado" }); mostrarEnlaces(t, o); }
      catch (err) { toast("No se pudo generar el enlace: " + err.message); }
    };
  }
  async function cancelarOrden(t) {
    const o = ordenes[t]; if (!o || !confirm(`¿Cancelar el pedido ${cod(o.codigo)}?`)) return;
    const upd = { [`ordenes/${t}/estado`]: "cancelado", [`ordenes/${t}/actualizado`]: O.TS };
    const a = o.asignacion || {};
    if (a.tipo === "registrado" && guias[a.uid] && guias[a.uid].ordenId === t) upd["guias/" + a.uid] = null;
    if (a.tipo === "invitado" && a.unido) upd[`pedidos/${t}/estado`] = "cancelado";
    try { await db.ref().update(upd); toast("Pedido cancelado."); } catch (err) { toast("No se pudo cancelar: " + err.message); }
  }

  async function forzarEstadoOrden(token, nuevoEstado) {
    const o = ordenes[token];
    if (!o) return toast("No encuentro ese pedido.");
    if (!["entregado", "cancelado"].includes(nuevoEstado)) return toast("Estado no válido.");
    if (!activa(o)) return toast(`El pedido ${cod(o.codigo)} ya está ${o.estado === "entregado" ? "entregado" : "cancelado"}: no admite más cambios.`);
    const esEnt = nuevoEstado === "entregado";
    if (!confirm((esEnt ? "¿Forzar como ENTREGADO" : "¿Forzar como CANCELADO") + " el pedido " + cod(o.codigo) + "?\n\nEsto sobrescribe el estado sin importar lo que diga el repartidor o el cliente.")) return;
    const motivo = (prompt("Motivo del forzado (opcional):", "") || "").trim().slice(0, 300);
    if (!motivo && !confirm("Sin motivo. ¿Continuar igual?")) return;
    
    const upd = {
      [`ordenes/${token}/estado`]: nuevoEstado,
      [`ordenes/${token}/actualizado`]: O.TS,
      [`ordenes/${token}/forzadoPorAdmin`]: true,
      [`ordenes/${token}/forzadoTs`]: O.TS
    };
    if (esEnt) upd[`ordenes/${token}/entregadoTs`] = O.TS;
    else upd[`ordenes/${token}/canceladoTs`] = O.TS;
    if (motivo) upd[`ordenes/${token}/motivoForzado`] = motivo;
    
    const a = o.asignacion || {};
    if (a.tipo === "registrado" && a.uid && guias[a.uid] && guias[a.uid].ordenId === token) upd["guias/" + a.uid] = null;
    if (a.tipo === "invitado") upd["ubicaciones/" + O.uidInvitado(token)] = null;
    try {
      if ((await db.ref("pedidos/" + token).once("value")).exists()) {
        upd[`pedidos/${token}/estado`] = nuevoEstado;
        if (esEnt) upd[`pedidos/${token}/fin`] = O.TS;
      }
    } catch (_) {}
    try {
      await db.ref().update(upd);
      toast(esEnt ? "✅ Pedido forzado a ENTREGADO" : "🚫 Pedido forzado a CANCELADO");
    } catch (err) { toast("No se pudo forzar: " + err.message); }
  }

  async function asignarManual(uid, token) {
    const o = ordenes[token];
    if (!o) return toast("No encuentro ese pedido.");
    const nom = nombreUid(uid);
    if (!confirm(`¿Asignar FORZOSAMENTE el pedido ${cod(o.codigo)} a ${nom}?\nEl repartidor recibirá un aviso y deberá aceptar de nuevo.`)) return;
    try {
      await db.ref("ordenes/" + token + "/estado_asignacion").transaction((cur) => {
        if (cur === "pendiente") return;
        return "pendiente";
      });
      const upd = {
        [`ordenes/${token}/asignacion`]: { tipo: "registrado", uid, nombre: nom },
        [`ordenes/${token}/estado`]: "asignado",
        [`ordenes/${token}/actualizado`]: O.TS,
        [`ordenes/${token}/asignadoPorAdmin`]: true,
        [`ordenes/${token}/asignadoTs`]: O.TS
      };
      const nCli = (typeof O.nodoCliente === "function") ? O.nodoCliente(token, o, uid, nom)
        : { estado: "en_ruta", pedido: o.codigo, inicio: O.TS, repartidorUid: uid, repartidorNombre: nom, clienteNombre: o.cliente, adminOrden: true, delivery: O.totalDelivery(o) };
      upd["pedidos/" + token] = nCli;
      const sig = O.siguienteRetiro(o);
      if (sig && O.valido(sig.p)) upd["guias/" + uid] = O.datosGuia ? O.datosGuia("retiro", sig.p, { ordenId: token, nombre: O.textoRetiro(sig.p, O.paradas(o).length, sig.i), negocio: sig.p.texto || "Retiro", producto: sig.p.producto || "" }) : null;
      await db.ref().update(upd);
      toast(`Pedido asignado a ${nom} ✓`);
      if (typeof PushAdmin !== "undefined") PushAdmin.pedidoAsignado(uid, Object.assign({ token }, o));
    } catch (err) { toast("No se pudo asignar: " + err.message); }
  }

  function tarjeta(t) {
    const o = ordenes[t], [txt, cls] = O.ESTADOS[o.estado] || O.ESTADOS.pendiente, a = o.asignacion || {};
    const inv = a.tipo === "invitado", btn = (acc, label, extra) => `<button class="mini ${extra || ""}" data-pa="${acc}" data-t="${esc(t)}" type="button">${label}</button>`;
    return `<div class="tarjeta-rep pd-orden">
      <div class="fila"><div class="datos"><strong>${esc(cod(o.codigo))} · ${esc(o.cliente || "Sin nombre")}</strong>
        <small>👤 ${esc(nombreOrden(o))}${inv ? ' <i class="pd-tag">Invitado</i>' : ""}</small></div><span class="chip ${cls}">${txt}</span></div>
      <div class="ruta">${O.paradas(o).map((p, k) => `${p.retirado ? "✅" : "📦"} ${O.paradas(o).length > 1 ? "Retiro " + (k + 1) + ": " : ""}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}`).join("<br>")}<br>🏠 ${esc((o.entrega && o.entrega.texto) || "—")}${o.delivery || o.iva ? "<br>🛵 Delivery: <b>" + O.textoDelivery(o) + "</b>" : ""}${o.paquete ? "<br>📝 " + esc(o.paquete) : ""}${a.tipo === "registrado" && activa(o) ? (o.estado_asignacion === "aceptado" ? "<br>✅ Aceptado por el repartidor" : o.estado_asignacion === "rechazado" ? "<br>❌ Rechazado por el repartidor" : o.estado === "asignado" ? "<br>⏳ Esperando respuesta del repartidor" : "") : ""}${o.forzadoPorAdmin ? "<br>🛡️ <b>Forzado por el administrador</b>" + (o.motivoForzado ? ": " + esc(o.motivoForzado) : "") : ""}</div>
      <div class="acciones-fila" style="flex-wrap:wrap">
        ${inv && activa(o) ? btn("linkinv", "🔗 Enlace invitado") : ""}${inv && a.nombre && activa(o) ? btn("chatinv", "🗨 Chat invitado" + (sinLeerInv[t] ? " (" + sinLeerInv[t] + ")" : "")) : ""}${a.tipo && activa(o) ? btn("linkcli", "💬 Enlace cliente") : ""}${a.tipo && activa(o) ? btn("factura", "🧾 Factura", "pri") : ""}${inv && activa(o) ? btn("recorrido", "🗺 Recorrido") : ""}
        ${(o.estado === "pendiente" && !a.tipo) || (o.estado_asignacion === "rechazado" && activa(o)) ? btn("asignar", o.estado_asignacion === "rechazado" ? "Reasignar" : "Asignar", "pri") : ""}
        ${activa(o) ? btn("forzar-ent", "✅ Forzar entregado") + btn("forzar-canc", "🚫 Forzar cancelado") : ""}
        ${activa(o) ? btn("cancelar", "Cancelar", "peligro") : btn("borrar", "Eliminar", "peligro")}
      </div></div>`;
  }
  function pintarOrdenes() {
    const ids = Object.keys(ordenes).sort((a, b) => (ordenes[b].creado || 0) - (ordenes[a].creado || 0));
    el("listaPedidos").innerHTML = ids.length ? ids.map(tarjeta).join("") : '<p class="ayuda">Aún no hay pedidos. Crea el primero arriba.</p>';
    const c = el("pdCuenta"); if (c) c.textContent = ids.length;
  }

  function abrirChatInv(t) {
    const o = ordenes[t]; if (!o) return;
    const nom = (o.asignacion && o.asignacion.nombre) || "Invitado";
    chatInvAbierto = t; sinLeerInv[t] = 0; pintarOrdenes();
    Chat.iniciar({
      token: t, yo: "admin", ruta: RUTA_INV, pedido: o.codigo, nombreRepartidor: nom, puedeBorrar: true, avisos: false,
      titulo: () => "Chat con " + nom, subtitulo: () => "Pedido " + cod(o.codigo) + " · invitado",
      alCerrar: () => { chatInvAbierto = null; ChatMessenger.limpiar(); }
    });
    ChatMessenger.set({ uid: O.uidInvitado(t), nombre: nom });
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
          try { ChatBandeja.aviso({ clave: "inv:" + t, uid: O.uidInvitado(t), nombre: (r.repartidor || "Invitado") + " · pedido " + (r.pedido || ""), texto: r.ultimo || "", abrir: () => chatInvitado(O.uidInvitado(t)) }); } catch (_) {}
          O.hablar("Mensaje del repartidor invitado " + (r.repartidor || ""));
        }
      });
      primeraInv = false; resInv = n; pintarOrdenes();
    }, () => {});
  }

  function avisarCambios(nuevo) {
    const decir = (txt) => { toast(txt); O.hablar(txt.replace(/[📦✅❌🔗🛵]/gu, "")); };
    Object.entries(nuevo).forEach(([t, o]) => {
      const a = ordenes[t]; if (!a) return;
      const resp = o.estado_asignacion;
      if (resp !== a.estado_asignacion && (resp === "aceptado" || resp === "rechazado") && o.asignacion && o.asignacion.tipo === "registrado") {
        const quien = o.asignacion.nombre || "repartidor";
        if (resp === "aceptado") decir(`✅ El repartidor ${quien} aceptó el pedido ${cod(o.codigo)}`);
        else decir(`❌ El repartidor ${quien} rechazó el pedido ${cod(o.codigo)}`);
      }
      const nom = (o.asignacion && o.asignacion.nombre) || "El repartidor", pa = O.paradas(a), po = O.paradas(o);
      if (o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && !(a.asignacion && a.asignacion.nombre)) decir(`🔗 ${nom} aceptó el pedido ${cod(o.codigo)}`);
      po.forEach((p, k) => {
        if (!p.retirado || (pa[k] && pa[k].retirado)) return;
        const falta = po.filter((x) => !x.retirado).length;
        decir(`📦 ${nom} ya retiró ${p.producto ? p.producto : "un producto"}${p.texto ? " en " + p.texto : ""}. ${falta ? "Faltan " + falta + " retiro" + (falta > 1 ? "s" : "") : "Pedido completo, va hacia el cliente"}`);
      });
      if (o.estado !== a.estado && o.estado === "entregado") decir(`✅ ${nom} entregó el pedido ${cod(o.codigo)}`);
      if (o.estado !== a.estado && (o.estado === "entregado" || o.estado === "cancelado") && t === avisoToken) aviso("");
    });
  }

  function htmlInvitados() {
    return Object.entries(ordenes).filter(([, o]) => o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && ["asignado", "retirado"].includes(o.estado)).map(([t, o]) => {
      const [tx] = ETIQUETA[estadoDe(O.uidInvitado(t))], [et, ec] = O.ESTADOS[o.estado];
      return `<div class="tarjeta-rep"><div class="fila"><span class="avatar" data-av="${esc(O.uidInvitado(t))}">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(o.asignacion.nombre)} <i class="pd-tag">Invitado</i></strong><small>Pedido ${esc(cod(o.codigo))} · ${esc(o.cliente)} · ${tx}</small></div>
        <span class="chip ${ec}">${et}</span></div>
        <div class="acciones-fila">
          <button class="mini pri" data-fv-uid="${esc(O.uidInvitado(t))}" type="button">🧾 Ver factura</button>
          <button class="mini" data-foto-uid="${esc(O.uidInvitado(t))}" data-foto-nom="${esc(o.asignacion.nombre)}" type="button">📷 Foto</button>
        </div></div>`;
    }).join("");
  }
  function notaRep(uid) {
    const e = Object.entries(ordenes).find(([t, o]) => ["asignado", "retirado"].includes(o.estado) && o.asignacion &&
      ((o.asignacion.tipo === "invitado" && O.uidInvitado(t) === uid) || (o.asignacion.tipo === "registrado" && o.asignacion.uid === uid)));
    return e ? ` · 📦 ${cod(e[1].codigo)}: ${O.ESTADOS[e[1].estado][0]}` : "";
  }
  const tokenInv = (uid) => String(uid).replace(/^inv_/, "");
  const invCerrado = (uid) => { const o = ordenes[tokenInv(uid)]; return !!o && O.esInvitadoUid(uid) && !activa(o); }; 
  function chatInvitado(uid) { abrirChatInv(tokenInv(uid)); }
  async function accionInvitado(uid, accion) {
    const t = tokenInv(uid), o = ordenes[t]; if (!o) return toast("No encuentro el pedido de este invitado.");
    const ent = accion === "entregado", est = ent ? "entregado" : "cancelado";
    if (!confirm(ent ? `¿Marcar como ENTREGADO el pedido ${cod(o.codigo)}? El repartidor saldrá del mapa.` : `¿Cancelar el pedido ${cod(o.codigo)}? El repartidor saldrá del mapa.`)) return;
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
  async function expulsarInvitado(uid) {
    const t = tokenInv(uid), o = ordenes[t], nom = nombreUid(uid);
    if (!confirm(`⛔ ¿EXPULSAR a ${nom}?\nSe cancela su pedido${o ? " " + cod(o.codigo) : ""}, pierde el acceso y sale del mapa. No se puede deshacer.`)) return;
    const upd = { ["ubicaciones/" + uid]: null, ["guias/" + uid]: null };
    if (o) { upd[`ordenes/${t}/estado`] = "cancelado"; upd[`ordenes/${t}/expulsado`] = true; upd[`ordenes/${t}/actualizado`] = O.TS; }
    try {
      if ((await db.ref("pedidos/" + t).once("value")).exists()) upd[`pedidos/${t}/estado`] = "cancelado";
      await db.ref().update(upd);
      toast(`${nom} fue expulsado ⛔`);
    } catch (err) { toast("No se pudo expulsar: " + err.message); }
  }
  function cerrarInvitado(token, uid) {
    if (!O.esInvitadoUid(uid)) return;
    db.ref().update({ [`ordenes/${token}/estado`]: "entregado", [`ordenes/${token}/actualizado`]: O.TS, ["ubicaciones/" + uid]: null }).catch(() => {});
  }

  /* ============================================================
     FASE 1 · FACTURAS EN RUTA (botón 🧾 del mapa)
     Lista TODO lo que anda en ruta con el nombre del repartidor y
     abre el detalle completo al tocar una. Fuentes:
       o: pedidos creados por el admin (ordenes)  · p: pedidos en curso (pedidos)
       s: solicitudes de clientes atendidas (solicitudes_entrantes)
     ============================================================ */
  const dinero = (n) => "C$ " + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  const hayNum = (n) => typeof n === "number" && isFinite(n);

  function facturasEnRuta() {
    const lista = [], conOrden = new Set(), conSol = new Set();
    Object.entries(ordenes).forEach(([t, o]) => {
      if (!o || !activa(o) || !(o.asignacion && o.asignacion.nombre)) return;
      conOrden.add(t);
      lista.push({ k: "o:" + t, cliente: o.cliente || "Sin nombre", rep: o.asignacion.nombre, codigo: cod(o.codigo), tag: o.asignacion.tipo === "invitado" ? "Invitado" : "Pedido admin", total: O.money(O.totalDelivery ? O.totalDelivery(o) : (Number(o.delivery) || 0) + (Number(o.iva) || 0)), est: (O.ESTADOS[o.estado] || [""])[0], ts: o.creado || 0 });
    });
    let sols = [];
    try { sols = typeof SolicitudesAdmin !== "undefined" && SolicitudesAdmin.activas ? SolicitudesAdmin.activas() : []; } catch (_) {}
    sols.forEach(([id, d]) => {
      conSol.add(id);
      const ff = d.facturaFinal;
      lista.push({ k: "s:" + id, cliente: d.nombre || "Cliente", rep: d.repartidorNombre || nombreUid(d.repartidorUid), codigo: ff && ff.pedido ? String(ff.pedido) : "Solicitud", tag: "Chat cliente", total: ff ? dinero(ff.totalFinal != null ? ff.totalFinal : ff.total) : "Sin factura final", est: "Con pedido", ts: d.ts || d.creado || 0 });
    });
    Object.entries(activos).forEach(([t, d]) => {
      if (!d || d.estado !== "en_ruta" || conOrden.has(t) || (d.solicitudId && conSol.has(d.solicitudId))) return;
      const f = d.factura || {}, det = d.detalle || {};
      const tot = hayNum(det.total) ? det.total : hayNum(f.total) ? f.total : null;
      lista.push({ k: "p:" + t, cliente: d.clienteNombre || f.cliente || "Cliente", rep: d.repartidorNombre || nombreUid(d.repartidorUid), codigo: d.pedido ? String(d.pedido) : "—", tag: d.sinFactura ? "Sin factura" : "En curso", total: tot == null ? "Sin factura" : dinero(tot), est: "En ruta", ts: d.inicio || 0 });
    });
    return lista.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }

  let facturaDesdeLista = false;   // true cuando el detalle se abrió desde la lista "Facturas en ruta" (atrás → lista)
  function volverALista() {
    if (!facturaDesdeLista) return false;
    const m = el("modalAdmin");
    if (!m || m.classList.contains("oculto") || !el("fvVolver")) return false;
    abrirFacturasEnRuta();
    return true;
  }
  function abrirFacturasEnRuta() {
    facturaDesdeLista = false;
    const l = facturasEnRuta();
    modal(`<div class="fv-caja"><h2>🧾 Facturas en ruta</h2>
      <p class="ayuda"><span class="fv-vivo">${l.length} activa${l.length === 1 ? "" : "s"}</span> · Toca una para ver el detalle completo.</p>
      <div class="fv-lista-pedidos">${l.length ? l.map((x) => `<button type="button" class="pd-rep" data-fk="${esc(x.k)}"><span><strong>${esc(x.codigo)} · ${esc(x.cliente)}</strong><small>🛵 ${esc(x.rep)} · ${esc(x.est)} · ${esc(x.total)}</small></span><i class="pd-tag">${esc(x.tag)}</i></button>`).join("") : '<p class="ayuda">No hay facturas en ruta ahora mismo.</p>'}</div>
      <button id="fvCerrar" class="oscuro" type="button">Cerrar</button></div>`);
    el("fvCerrar").onclick = cerrarModal;
    el("modalCaja").querySelector(".fv-lista-pedidos").onclick = (e) => {
      const b = e.target.closest("button[data-fk]"); if (b) abrirDetalleFactura(b.dataset.fk, true);
    };
  }

  const filaFv = (txt, val, clase) => `<div class="fv-fila${clase ? " " + clase : ""}"><span>${txt}</span><b>${val}</b></div>`;
  function itemsFv(items) {
    return (Array.isArray(items) ? items : Object.values(items || {})).filter((p) => p && typeof p === "object")
      .map((p) => filaFv(esc(String(p.nombre || "Producto").replace(/^➕\s*/, "")), dinero(p.precio), String(p.nombre || "").indexOf("➕") === 0 ? "fv-ex" : "")).join("");
  }
  function totalesFv(f) {
    if (!f || typeof f !== "object") return "";
    let h = "";
    if (hayNum(f.subtotal)) h += filaFv("Subtotal", dinero(f.subtotal), "fv-sub");
    if (hayNum(f.delivery)) h += filaFv("🛵 Delivery", dinero(f.delivery));
    if (Number(f.mandadoExtra) > 0) h += filaFv("➕ Mandado extra", dinero(f.mandadoExtra), "fv-ex");
    if (Number(f.prioridad) > 0) h += filaFv("⚡ Prioridad", dinero(f.prioridad), "fv-pri");
    if (Number(f.deposito) > 0) h += filaFv("Depósito", dinero(f.deposito));
    const t = f.totalFinal != null ? f.totalFinal : f.total;
    if (hayNum(t)) h += `<div class="fv-total"><span>Total</span><b>${dinero(t)}</b></div>`;
    return h;
  }
  function subFv(s) {
    if (!s || typeof s !== "object" || !hayNum(s.subtotal)) return "";
    return `<div class="fv-sec">${esc(s.etiqueta || "Subfactura")}</div><div class="fv-bloque">${itemsFv(s.items)}${filaFv("Subtotal", dinero(s.subtotal), "fv-sub")}${Number(s.envioExtra) > 0 ? filaFv("Envío extra", dinero(s.envioExtra)) : ""}</div>`;
  }
  function extrasFv(ex) {
    const l = Object.values(ex || {}).filter((x) => x && hayNum(x.monto));
    return l.length ? `<div class="fv-sec">➕ Extras</div><div class="fv-bloque">${l.map((x) => filaFv(esc((x.nota || "Extra") + (x.por ? " · " + x.por : "")), dinero(x.monto), "fv-ex")).join("")}</div>` : "";
  }
  const bannerFv = (tit, sub) => `<div class="fv-banner"><b>${esc(tit)}</b><small>${esc(sub)}</small></div>`;

  function abrirDetalleFactura(k, desdeLista) {
    const tipo = String(k).slice(0, 1), id = String(k).slice(2);
    let cuerpo = "";
    if (tipo === "o") {
      const o = ordenes[id]; if (!o) return toast("Ese pedido ya no está disponible.");
      const a = o.asignacion || {}, ps = O.paradas(o), d = activos[id] || {};
      cuerpo = bannerFv(`${cod(o.codigo)} · ${o.cliente || "Sin nombre"}`, `🛵 ${nombreOrden(o)}${a.tipo === "invitado" ? " (invitado)" : ""} · ${(O.ESTADOS[o.estado] || [""])[0]}`) +
        `<div class="fv-sec">Ruta</div><div class="fv-bloque">${ps.map((p, i) => `<div class="fv-fila"><span>${p.retirado ? "✅" : "📦"} ${ps.length > 1 ? "Retiro " + (i + 1) + ": " : "Retiro: "}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}</span></div>`).join("")}<div class="fv-fila"><span>🏠 Entrega: ${esc((o.entrega && o.entrega.texto) || "—")}</span></div></div>` +
        `<div class="fv-sec">Cobro</div><div class="fv-bloque">${filaFv("🛵 Delivery", dinero(o.delivery))}${Number(o.iva) > 0 ? filaFv("IVA", dinero(o.iva)) : ""}<div class="fv-total"><span>Total</span><b>${esc(O.money(O.totalDelivery ? O.totalDelivery(o) : (Number(o.delivery) || 0) + (Number(o.iva) || 0)))}</b></div></div>` +
        (o.paquete ? `<div class="fv-sec">📝 Paquete</div><div class="fv-bloque"><div class="fv-fila"><span>${esc(o.paquete).replace(/\n/g, "<br>")}</span></div></div>` : "") +
        (d.detalle || d.factura ? `<div class="fv-sec">Factura del repartidor</div><div class="fv-bloque">${totalesFv(d.detalle || d.factura)}</div>` : "") + subFv(d.subfactura) + extrasFv(d.extras);
    } else if (tipo === "s") {
      const s = typeof SolicitudesAdmin !== "undefined" && SolicitudesAdmin.activas ? SolicitudesAdmin.activas().find((x) => x[0] === id) : null;
      if (!s) return toast("Esa solicitud ya no está en ruta.");
      const d = s[1], p = d.pedido || {}, ff = d.facturaFinal;
      const ped = Object.entries(activos).find(([, x]) => x && x.solicitudId === id);
      cuerpo = bannerFv(`${d.nombre || "Cliente"}${ff && ff.pedido ? " · " + ff.pedido : ""}`, `🛵 ${d.repartidorNombre || nombreUid(d.repartidorUid)} · Chat de cliente`) +
        (p.quiere ? `<div class="fv-sec">🛍️ Pedido</div><div class="fv-bloque"><div class="fv-fila"><span>${esc(p.quiere)}${p.origen ? " · de " + esc(p.origen) : ""}</span></div></div>` : "") +
        (ff ? `<div class="fv-sec">Factura</div><div class="fv-bloque">${itemsFv(ff.productos)}${totalesFv(ff)}</div>` : '<div class="fv-sec">Factura</div><div class="fv-bloque"><div class="fv-fila"><span>Todavía no hay factura final: el repartidor aún no la envía.</span></div></div>') +
        subFv(d.subfactura) + (ped ? subFv(ped[1].subfactura) + extrasFv(ped[1].extras) : "");
    } else {
      const d = activos[id]; if (!d) return toast("Ese pedido ya no está en ruta.");
      cuerpo = bannerFv(`${d.pedido || "Pedido"} · ${d.clienteNombre || (d.factura && d.factura.cliente) || "Cliente"}`, `🛵 ${d.repartidorNombre || nombreUid(d.repartidorUid)} · En ruta`) +
        (d.sinFactura ? '<div class="fv-bloque"><div class="fv-fila"><span>🧾 Todavía sin factura (solo enlace de contacto).</span></div></div>' : `<div class="fv-sec">Factura</div><div class="fv-bloque">${totalesFv(d.detalle || d.factura) || '<div class="fv-fila"><span>Sin montos todavía.</span></div>'}</div>`) +
        subFv(d.subfactura) + extrasFv(d.extras);
    }
    modal(`<div class="fv-caja"><h2>🧾 Detalle de factura</h2><div class="fv-resumen">${cuerpo}</div>
      <button id="fvEntregar" class="primario" type="button">✅ Marcar como entregada</button>
      <button id="fvVolver" type="button">← Volver a la lista</button><button id="fvCerrar2" class="oscuro" type="button">Cerrar</button></div>`);
    facturaDesdeLista = !!desdeLista;
    el("fvEntregar").onclick = () => marcarEntregadaFactura(k);
    el("fvVolver").onclick = abrirFacturasEnRuta;
    el("fvCerrar2").onclick = cerrarModal;
  }

  /* Marcar como ENTREGADA desde el detalle de una factura (por si al repartidor se le olvidó). */
  async function marcarEntregadaFactura(k) {
    const tipo = String(k).slice(0, 1), id = String(k).slice(2);
    if (tipo === "s") { cerrarModal(); return SolicitudesAdmin.forzarEstadoSolicitud(id, "entregado"); }
    const upd = {};
    let nombre = "";
    if (tipo === "o") {
      const o = ordenes[id]; if (!o) return toast("Ese pedido ya no está disponible.");
      nombre = cod(o.codigo) + " · " + (o.cliente || "Sin nombre");
      if (!confirm(`¿Marcar como ENTREGADO el pedido ${nombre}?\nEl repartidor saldrá de la ruta y la factura dejará de estar en ruta.`)) return;
      const a = o.asignacion || {};
      Object.assign(upd, {
        [`ordenes/${id}/estado`]: "entregado", [`ordenes/${id}/actualizado`]: O.TS, [`ordenes/${id}/entregadoTs`]: O.TS,
        [`ordenes/${id}/forzadoPorAdmin`]: true, [`ordenes/${id}/forzadoTs`]: O.TS
      });
      if (a.tipo === "registrado" && a.uid && guias[a.uid] && guias[a.uid].ordenId === id) upd["guias/" + a.uid] = null;
      if (a.tipo === "invitado") { upd["ubicaciones/" + O.uidInvitado(id)] = null; upd["guias/" + O.uidInvitado(id)] = null; }
    } else {
      const d = activos[id]; if (!d) return toast("Ese pedido ya no está en ruta.");
      nombre = (d.pedido || "Pedido") + " · " + (d.clienteNombre || (d.factura && d.factura.cliente) || "Cliente");
      if (!confirm(`¿Marcar como ENTREGADO el pedido ${nombre}?\nLa factura dejará de estar en ruta.`)) return;
    }
    try {
      if (tipo === "o") { if ((await db.ref("pedidos/" + id).once("value")).exists()) { upd[`pedidos/${id}/estado`] = "entregado"; upd[`pedidos/${id}/fin`] = O.TS; } }
      else { upd[`pedidos/${id}/estado`] = "entregado"; upd[`pedidos/${id}/fin`] = O.TS; }
      await db.ref().update(upd);
      cerrarModal(); toast("✅ Pedido marcado como entregado");
    } catch (err) { toast("No se pudo marcar como entregado: " + (err.message || err)); }
  }

  function abrirFacturaUid(uid) {
    if (O.esInvitadoUid(uid) && ordenes[tokenInv(uid)]) return abrirDetalleFactura("o:" + tokenInv(uid));
    const f = facturasEnRuta().find((x) => {
      if (x.k.startsWith("o:")) { const o = ordenes[x.k.slice(2)]; return o && o.asignacion && o.asignacion.uid === uid; }
      if (x.k.startsWith("s:")) { const s = SolicitudesAdmin.activas().find((y) => y[0] === x.k.slice(2)); return s && s[1].repartidorUid === uid; }
      const d = activos[x.k.slice(2)]; return d && d.repartidorUid === uid;
    });
    if (f) abrirDetalleFactura(f.k); else toast("Este repartidor no tiene facturas en ruta.");
  }
  function verRecorrido(uid) {
    const u = ubic[uid];
    if (!mapa || !u || typeof u.lat !== "number") return toast("Este repartidor aún no comparte ubicación.");
    mapa.flyTo([u.lat, u.lng], 17);
    setTimeout(() => { try { if (marcadores[uid]) marcadores[uid].openPopup(); } catch (_) {} }, 700);
  }
  /* ============================================================
     RUTA DE LOS PEDIDOS QUE ENVIÉ (repartidor registrado o invitado)
     Cuando el repartidor toma el pedido se ve en el mapa: dónde retira (📦), dónde entrega (🏠/💵) y la línea
     por las calles desde su posición hasta cada parada. admin.js llama a recorridoInv en cada refresco del marcador.
     ============================================================ */
  const rutasO = {};         // token → { capa, firma, pos, ts, seq }
  const cachePatas = {};     // tramo (origen>destino) → { pts, dist, dur }
  let tRutas = null;
  const r5 = (n) => Math.round(n * 1e5) / 1e5;
  const llOk = (p) => !!p && typeof p.lat === "number" && typeof p.lng === "number" && isFinite(p.lat) && isFinite(p.lng);
  const kPata = (a, b) => r5(a.lat) + "," + r5(a.lng) + ">" + r5(b.lat) + "," + r5(b.lng);
  function distM(a, b) {
    const rad = Math.PI / 180, dLa = (b.lat - a.lat) * rad, dLo = (b.lng - a.lng) * rad;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  function pedidoTomado(o) {
    const a = o && o.asignacion;
    if (!a || !a.tipo || !activa(o)) return false;
    if (a.tipo === "invitado") return !!a.nombre;                                   // el invitado ya abrió el enlace y puso su nombre
    return o.estado_asignacion !== "pendiente" && o.estado_asignacion !== "rechazado"; // el registrado ya lo aceptó
  }
  function paradasRuta(o) {
    const out = [];
    O.paradas(o).forEach((p, i) => { if (llOk(p)) out.push({ lat: p.lat, lng: p.lng, cual: "retiro", emoji: "📦", p, i, hecho: !!p.retirado }); });
    const extra = Array.isArray(o.entregasExtra) ? o.entregasExtra : Object.values(o.entregasExtra || {});
    [o.entrega].concat(extra).forEach((e, i) => { if (e && llOk(e)) out.push({ lat: e.lat, lng: e.lng, cual: "entrega", emoji: e.tipo === "cobro" ? "💵" : "🏠", p: e, i, hecho: false }); });
    return out;
  }
  function quitarRuta(t) {
    const r = rutasO[t]; if (!r) return;
    r.seq++; try { if (mapa) mapa.removeLayer(r.capa); } catch (_) {}
    delete rutasO[t];
  }
  async function refrescarRuta(t) {
    const o = ordenes[t];
    if (!o || !pedidoTomado(o) || typeof mapa === "undefined" || !mapa) return quitarRuta(t);
    const stops = paradasRuta(o), pend = stops.filter((x) => !x.hecho);
    if (!pend.length) return quitarRuta(t);
    const a = o.asignacion, uid = a.tipo === "invitado" ? O.uidInvitado(t) : a.uid;
    const u = uid && ubic[uid], pos = u && llOk(u) ? { lat: u.lat, lng: u.lng } : null;
    let r = rutasO[t];
    if (!r) r = rutasO[t] = { capa: L.layerGroup().addTo(mapa), firma: "", pos: null, ts: 0, seq: 0 };
    const firma = stops.map((x) => r5(x.lat) + "," + r5(x.lng) + (x.hecho ? "x" : "")).join("|");
    const cambio = firma !== r.firma;
    const movio = !!pos && (!r.pos || distM(pos, r.pos) > 60) && Date.now() - r.ts > 15000;
    if (!cambio && !movio) return;
    r.firma = firma; r.ts = Date.now(); if (pos) r.pos = pos;
    const seq = ++r.seq, color = colorUid(uid || t);
    const seqPts = (pos ? [pos] : []).concat(pend);
    if (Object.keys(cachePatas).length > 250) Object.keys(cachePatas).forEach((k) => delete cachePatas[k]);
    const patas = await Promise.all(seqPts.slice(0, -1).map(async (p0, k) => {
      const p1 = seqPts[k + 1], key = kPata(p0, p1);
      if (cachePatas[key]) return cachePatas[key];
      try {
        const res = await O.rutaCalles({ lat: p0.lat, lng: p0.lng }, { lat: p1.lat, lng: p1.lng });
        if (res && res.pts) { cachePatas[key] = res; return res; }
      } catch (_) {}
      return null;
    }));
    if (r.seq !== seq || rutasO[t] !== r) return;               // llegó un cambio más nuevo mientras se calculaba
    r.capa.clearLayers();
    patas.forEach((res, k) => {
      const p0 = seqPts[k], p1 = seqPts[k + 1];
      const linea = res && res.pts ? [[p0.lat, p0.lng], ...res.pts, [p1.lat, p1.lng]] : [[p0.lat, p0.lng], [p1.lat, p1.lng]];
      const actual = !!pos && k === 0, w = actual ? 6 : 4;
      L.polyline(linea, { color: "#fff", weight: w + 4, opacity: .9, interactive: false }).addTo(r.capa);
      L.polyline(linea, { color, weight: w, opacity: res ? (actual ? .95 : .75) : .6, dashArray: res ? (actual ? null : "2 9") : "6 8", lineCap: "round", interactive: false }).addTo(r.capa);
    });
    const nRet = O.paradas(o).length, rep = a.nombre || nombreUid(uid);
    stops.forEach((x) => {
      const titulo = x.cual === "retiro" ? (nRet > 1 ? "Retiro " + (x.i + 1) : "Retiro") + (x.hecho ? " ✅" : "") : (x.emoji === "💵" ? "Lugar de cobro" : "Entrega") + (x.i > 0 ? " " + (x.i + 1) : "");
      L.marker([x.lat, x.lng], { icon: O.pinIcono(x.cual, x.emoji), opacity: x.hecho ? .45 : 1, zIndexOffset: 300, keyboard: false })
        .bindPopup(`<div class="pop-rep"><strong>${x.emoji} ${esc(titulo)}</strong><small>${esc(x.p.texto || "—")}${x.p.producto ? " — " + esc(x.p.producto) : ""}</small><small>Pedido ${esc(cod(o.codigo))} · 🛵 ${esc(rep)}</small></div>`, { autoPanPaddingTopLeft: [16, 110], autoPanPaddingBottomRight: [90, 110] })
        .addTo(r.capa);
    });
  }
  function refrescarRutas() {
    Object.keys(rutasO).forEach((t) => { if (!ordenes[t]) quitarRuta(t); });
    Object.keys(ordenes).forEach((t) => { refrescarRuta(t).catch((e) => console.warn("[ruta pedido]", e)); });
  }
  function pedirRutas() {
    if (tRutas) return;
    tRutas = setTimeout(() => { tRutas = null; try { refrescarRutas(); } catch (e) { console.warn("[rutas pedidos]", e); } }, 1200);
  }
  const recorridoInv = () => pedirRutas();

  function iniciar() {
    detener(); primera = true;
    // FASE ÚNICA · Arrancar el módulo EQUIPO lo antes posible (aunque el mapa falle)
    try { EQUIPO.iniciar(); } catch (e) { console.error("[EQUIPO] iniciar:", e); }
    if (!listo) {
      listo = true;
      try { vigilarCapasMapa(); } catch (e) { console.warn("[capas mapa]", e); }
      mapa.on("preclick", () => { busqAbierta = !el("resBusq").classList.contains("oculto"); });
      mapa.on("popupclose", () => { popupCerrado = Date.now(); });
      mapa.on("dblclick zoomstart movestart", cancelarClick);
      new MutationObserver(() => { if (el("modalAdmin").classList.contains("oculto")) quitarTemp(); }).observe(el("modalAdmin"), { attributes: true, attributeFilter: ["class"] });
      
      document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { cerrarMapaForm(); if (b.dataset.tab === "panelPedidos") pintarSelectorReg(); }));
      try { Brujula.iniciar(); ChatMessenger.iniciar(); } catch (e) { console.warn("[FASE2] brújula/chat:", e); }
      const btnFv = el("btnFacturasVivo"); if (btnFv) btnFv.onclick = abrirFacturasEnRuta;
      el("pdCrear").onclick = crearPedido;
      el("pdDelivery").addEventListener("input", alEscribirDelivery);
      el("pdIvaBase").addEventListener("input", pintarTotalDelivery);
      el("pdIvaExtra").addEventListener("input", pintarTotalDelivery);
      el("pdIvaExtra").addEventListener("change", () => { if (el("pdIvaExtra").value === "") el("pdIvaExtra").value = "0"; pintarTotalDelivery(); });
      pintarTotalDelivery();
      pintarLugares();
      el("pdAbrirMapa").onclick = () => abrirMapaForm("retiro", 0);
      el("pdAddRetiro").onclick = () => abrirMapaForm("retiro", añadir("retiro"));
      el("pdAddEntrega").onclick = () => abrirMapaForm("entrega", añadir("entrega"));
      el("pdLista").addEventListener("input", (e) => {
        const f = e.target.closest("[data-i]"); if (f && f.dataset.k === "retiro" && e.target.dataset.f === "producto") retirosForm[+f.dataset.i].producto = e.target.value;
      });
      el("pdLista").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-a]"), f = e.target.closest("[data-i]"); if (b && f) abrirMapaForm(f.dataset.k, +f.dataset.i);
      });
      el("listaPedidos").onclick = (e) => {
        const b = e.target.closest("button[data-pa]"); if (!b) return;
        const t = b.dataset.t, o = ordenes[t], a = b.dataset.pa; if (!o) return;
        if (a === "chatinv") abrirChatInv(t);
        else if (a === "linkinv") mostrarEnlaces(t, o);
        else if (a === "linkcli") copiar(O.urlCliente(t));
        else if (a === "factura") abrirDetalleFactura("o:" + t);
        else if (a === "recorrido") verRecorrido(O.uidInvitado(t));
        else if (a === "asignar") asignarExistente(t);
        else if (a === "cancelar") cancelarOrden(t);
        else if (a === "forzar-ent") forzarEstadoOrden(t, "entregado");
        else if (a === "forzar-canc") forzarEstadoOrden(t, "cancelado");
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
      pintarOrdenes(); pintarSelectorReg(); pintarEquipo(); pintarLista(); pedirRutas();
      try { ClientesMapa.pedirPintar(); } catch (_) {}
    }, () => { el("listaPedidos").innerHTML = '<p class="ayuda">Sin permiso para leer "ordenes". Revisa las reglas de Firebase.</p>'; });
  }
  function detener() {
    if (ref) { ref.off(); ref = null; }
    if (refChatInv) { refChatInv.off(); refChatInv = null; }
    clearTimeout(tRutas); tRutas = null; Object.keys(rutasO).forEach(quitarRuta);
    ordenes = {}; resInv = {}; sinLeerInv = {};
    try { EQUIPO.detener(); } catch (e) {}
    cerrarMapaForm(); quitarTemp(); cancelarClick();
  }

  return {
    iniciar, detener, clickMapa, htmlInvitados, notaRep, cerrarInvitado, accionInvitado, expulsarInvitado, chatInvitado,
    invCerrado, tokenInv, cerrarMapaForm, clienteDe: (t) => (ordenes[t] && ordenes[t].cliente) || "",
    forzarEstadoOrden, asignarManual,
    abrirFacturasEnRuta, abrirFacturaUid, verRecorrido, recorridoInv, volverALista,
    ordenesActivas: () => Object.entries(ordenes).filter(([, o]) => o && typeof o === "object" && activa(o)),
    codigo: cod
  };
})();


/* ============================================================
   FASE ÚNICA · EQUIPO (renderizado robusto y auto-recuperable)
   ------------------------------------------------------------
   - Registra su PROPIO listener de repartidores + repartidorFotos.
   - Reemplaza window.pintarEquipo() para que TODAS las llamadas
     (de admin.js y de ordenes-admin.js) usen esta versión defensiva.
   - try/catch por fila: si una fila falla, las demás se pintan igual.
   - Detecta errores de permisos / red y ofrece botón "Reintentar".
   - Reintenta automáticamente 3 veces (15 s entre cada intento).
   - Botón "🔄 Recargar" en admin.html llama a refrescarManual().
   ============================================================ */
const EQUIPO = (() => {
  const g = (id) => document.getElementById(id);
  const cache = { registrados: {}, fotos: {}, error: null, cargando: true };
  let refRep = null, refFotos = null, tRetry = null, intentos = 0, lastHash = "";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function render(force) {
    const cont = g("listaEquipo");
    if (!cont) { console.warn("[EQUIPO] No existe #listaEquipo"); return; }

    const hash = (() => {
      try { return JSON.stringify([Object.keys(cache.registrados).sort(), cache.fotos, cache.error && (cache.error.message || cache.error.code), cache.cargando]); }
      catch (_) { return ""; }
    })();
    if (!force && hash && hash === lastHash) return;
    lastHash = hash;

    // A. Error de Firebase
    if (cache.error) {
      const mensaje = cache.error.message || cache.error.code || "error desconocido";
      cont.innerHTML =
        '<div class="estado error" style="margin:0 0 10px" role="alert">' +
        '<div style="flex:1;min-width:0">⚠️ No se pudo leer la lista de repartidores: ' + esc(mensaje) + '. Verifica tu conexión y las reglas de Firebase (admins).</div>' +
        '</div>' +
        '<button id="eqRetry" class="mini primario" type="button" style="width:auto;height:40px;padding:0 16px;border-radius:12px">🔄 Reintentar</button>';
      const btn = g("eqRetry");
      if (btn) btn.onclick = () => { intentos = 0; iniciar(); };
      return;
    }

    // B. Estado de carga
    if (cache.cargando) {
      cont.innerHTML = '<p class="ayuda">Cargando repartidores…</p>';
      return;
    }

    // C. Lista de IDs válidos (objetos)
    const data = cache.registrados || {};
    const ids = Object.keys(data).filter((uid) => {
      const r = data[uid];
      return r && typeof r === "object";
    });

    // D. Invitados activos (desde PedidosAdmin)
    let invitados = "";
    try {
      if (typeof PedidosAdmin !== "undefined" && typeof PedidosAdmin.htmlInvitados === "function") {
        invitados = PedidosAdmin.htmlInvitados() || "";
      }
    } catch (e) { console.warn("[EQUIPO] invitados:", e); }

    // E. Vacío real
    if (!ids.length && !invitados) {
      cont.innerHTML = '<p class="ayuda">Aún no hay repartidores registrados. Usa el formulario de arriba para crear el primero.</p>';
      return;
    }

    // F. Renderizar cada tarjeta (con try/catch por fila)
    const filas = ids.map((uid) => {
      try {
        const r = data[uid] || {};
        const nombre = r.usuario || r.nombre || (r.email ? String(r.email).split("@")[0] : "") || "Repartidor";
        const email = r.email || "";
        const tel = r.telefono || "";

        let estado = "sinDatos", estadoLabel = "Sin datos", estadoClase = "";
        try {
          if (typeof estadoDe === "function") {
            estado = estadoDe(uid);
            if (typeof ETIQUETA !== "undefined" && Array.isArray(ETIQUETA[estado])) {
              estadoLabel = ETIQUETA[estado][0];
              estadoClase = ETIQUETA[estado][1] || "";
            }
          }
        } catch (_) {}

        const avatar = (typeof RIDER_SVG !== "undefined" && RIDER_SVG) ? RIDER_SVG : '<span style="font-size:24px;display:grid;place-items:center;width:100%;height:100%">🛵</span>';
        const foto = cache.fotos[uid];
        const tieneFoto = foto && typeof foto === "string" && foto.indexOf("data:image/") === 0;
        const avatarStyle = tieneFoto ? ' style="background-image:url(\'' + foto + '\');background-size:cover;background-position:center;background-color:transparent"' : "";
        const avatarInner = tieneFoto ? "" : avatar;

        return '<div class="tarjeta-rep">' +
          '<div class="fila">' +
          '<span class="avatar' + (tieneFoto ? ' con-foto' : '') + '" data-av="' + esc(uid) + '"' + avatarStyle + '>' + avatarInner + '</span>' +
          '<div class="datos">' +
          '<strong>' + esc(nombre) + '</strong>' +
          '<small>' + (email ? esc(email) : "Sin correo registrado · " + esc(String(uid).slice(0, 8)) + "…") + '</small>' +
          '<small>📱 ' + (tel ? "WhatsApp +" + esc(tel) : "Sin WhatsApp guardado") + '</small>' +
          '</div>' +
          '<span class="chip ' + esc(estadoClase) + '">' + esc(estadoLabel) + '</span>' +
          '</div>' +
          '<div class="acciones-fila">' +
          '<button class="mini" data-foto-uid="' + esc(uid) + '" data-foto-nom="' + esc(nombre) + '" type="button">📷 Foto</button>' +
          '<button class="mini" data-accion="telefono" data-uid="' + esc(uid) + '" type="button">' + (tel ? "Editar WhatsApp" : "Agregar WhatsApp") + '</button>' +
          (email ? '<button class="mini" data-accion="reset" data-uid="' + esc(uid) + '" type="button">Restablecer clave</button>' : '') +
          '<button class="mini peligro" data-accion="quitar" data-uid="' + esc(uid) + '" type="button">Quitar</button>' +
          '</div>' +
          '</div>';
      } catch (e) {
        console.error("[EQUIPO] error renderizando uid=" + uid, e);
        return '<div class="tarjeta-rep" style="border-color:#E5322D"><small>⚠️ Error al mostrar el repartidor ' + esc(String(uid).slice(0, 8)) + '…</small></div>';
      }
    }).join("");

    // G. Insertar HTML final
    let html = filas;
    if (invitados) html += '<h3 class="sec">Invitados activos</h3>' + invitados;
    cont.innerHTML = html;

    // H. Aplicar fotos vía función de admin.js (por si el listener de allí trae más)
    try {
      if (typeof aplicarFotosAvatares === "function") aplicarFotosAvatares();
    } catch (_) {}
  }

  function iniciar() {
    detener();
    cache.cargando = true;
    cache.error = null;
    render(true);

    // Botón "Recargar" en admin.html
    const btnRecargar = g("btnRecargarEquipo");
    if (btnRecargar && !btnRecargar._eqBound) {
      btnRecargar._eqBound = true;
      btnRecargar.onclick = () => { intentos = 0; iniciar(); };
    }

    if (typeof db === "undefined") {
      cache.error = { message: "Firebase no está inicializado" };
      cache.cargando = false;
      render(true);
      return;
    }

    // Listener de repartidores
    try {
      refRep = db.ref("repartidores");
      refRep.on("value", (s) => {
        const data = s.val();
        cache.cargando = false;
        if (data === null) {
          cache.registrados = {};
          cache.error = null;
        } else if (typeof data === "object") {
          cache.registrados = data;
          cache.error = null;
        } else {
          cache.registrados = {};
          cache.error = { message: "Estructura inesperada en repartidores/ (se esperaba objeto)" };
        }
        render(true);
      }, (err) => {
        console.error("[EQUIPO] repartidores:", err);
        cache.cargando = false;
        cache.error = err || { message: "Error al leer Firebase" };
        render(true);
        if (intentos < 3) {
          intentos++;
          clearTimeout(tRetry);
          tRetry = setTimeout(() => iniciar(), 15000);
        }
      });
    } catch (e) {
      console.error("[EQUIPO] refRep:", e);
      cache.cargando = false;
      cache.error = e;
      render(true);
    }

    // Listener de fotos (para avatares)
    try {
      refFotos = db.ref("repartidorFotos");
      refFotos.on("value", (s) => {
        cache.fotos = s.val() || {};
        render(true);
      }, () => { cache.fotos = {}; });
    } catch (e) { console.warn("[EQUIPO] refFotos:", e); }
  }

  function detener() {
    if (refRep) { try { refRep.off(); } catch (_) {} refRep = null; }
    if (refFotos) { try { refFotos.off(); } catch (_) {} refFotos = null; }
    clearTimeout(tRetry); tRetry = null;
    intentos = 0;
    lastHash = "";
  }

  return { iniciar, detener, render, refrescarManual: iniciar };
})();

// Sobrescribir pintarEquipo() para que todas las llamadas (de admin.js y de
// ordenes-admin.js) usen el renderizado robusto de EQUIPO.
try { window.pintarEquipo = () => EQUIPO.render(); } catch (_) {}


/* ============================================================
   FASE 3 · Cortinas (minimizar / maximizar) de los módulos de "Equipo":
   Tu equipo · Facturas del día · Calificaciones de clientes.
   El estado de cada cortina se recuerda en este aparato.
   ============================================================ */
const CortinasEquipo = (() => {
  const CLAVE = "admin_equipo_cortinas";
  const panel = document.getElementById("panelEquipo");
  let estado = {};
  try { estado = JSON.parse(localStorage.getItem(CLAVE) || "{}") || {}; } catch (_) { estado = {}; }

  function aplicar(mod, abierta) {
    mod.classList.toggle("cerrada", !abierta);
    const t = mod.querySelector(".eq-toggle");
    if (t) t.setAttribute("aria-expanded", abierta ? "true" : "false");
    const c = mod.querySelector(".eq-cuerpo");
    if (c && "inert" in c) c.inert = !abierta;
  }
  function guardar() { try { localStorage.setItem(CLAVE, JSON.stringify(estado)); } catch (_) {} }
  function alternar(mod) {
    const abrir = mod.classList.contains("cerrada");
    aplicar(mod, abrir);
    estado[mod.id] = abrir;
    guardar();
  }
  if (panel) {
    panel.querySelectorAll(".eq-mod").forEach((mod) => aplicar(mod, estado[mod.id] !== false));
    panel.addEventListener("click", (e) => {
      const t = e.target.closest(".eq-toggle");
      if (!t || !panel.contains(t)) return;
      const mod = t.closest(".eq-mod");
      if (mod) alternar(mod);
    });
  }
  return { alternar, aplicar };
})();


/* ============================================================
   2) SOLICITUDES ADMIN (Chats, Modo Espectador, Palomitas)
   ============================================================ */
const SolicitudesAdmin = (() => {
  const RAIZ = "solicitudes_entrantes", RAIZ_FOTOS = "solicitudes_fotos", RAIZ_CLIENTES = "clientes", PANEL = "panelSolicitudes";
  const g = (id) => document.getElementById(id);
  let consulta = null, lista = {}, filtro = "todos", fecha = "", visorId = null, consultaMsgs = null, ultDia = null, origenVisor = "";
  let refUbic = null, ubic = {};
  let refLeidos = null, refUltimaDir = null, lect = {}, ultimaDirCliente = null;
  let mapa = null, marcaCli = null, marcaRep = null, linea = null, encuadrado = false;
  const vistos = new Set(), sel = new Set();
  let cargada = false;
  const avisadas = new Set();
  const COLOR_TICK_ENVIADO = "#8696A0", COLOR_TICK_LEIDO = "#25D366";

  const fin = (d) => !!d && (d.estado === "entregado" || d.estado === "cancelado");
  const estadoDe = (d) => (fin(d) ? d.estado : d.repartidorUid ? "atendido" : "nuevo");
  const dinero = (n) => "C$ " + (Number(n) || 0).toFixed(2);
  const hoyClave = () => { const t = new Date(); return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0"); };
  const CLAVE_CORTINA = "admin_solicitudes_cortina";
  let cortinaAbierta = true; try { cortinaAbierta = localStorage.getItem(CLAVE_CORTINA) !== "0"; } catch (_) {}
  function aplicarCortina() {
    const p = g(PANEL), b = g("saCortina"); if (!p || !b) return;
    p.classList.toggle("sa-min", !cortinaAbierta);
    b.setAttribute("aria-expanded", String(cortinaAbierta));
    b.querySelector(".sa-cortina-txt").textContent = cortinaAbierta ? "Minimizar" : "Mostrar";
    const lista = g("saLista"); if (lista && "inert" in lista) lista.inert = !cortinaAbierta;
  }
  function contarCortina(n) { const c = g("saCortinaN"); if (c) c.textContent = String(n); }
  const horaDe = (ts) => new Date(ts).toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" });
  const cortar = (s, n) => String(s == null ? "" : s).slice(0, n);
  const okLL = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180;
  
  function etiquetaDia(ts) {
    const d = new Date(ts), hoy = new Date();
    const ini = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dif = Math.round((ini(hoy) - ini(d)) / 86400000);
    return dif === 0 ? "Hoy" : dif === 1 ? "Ayer" : d.toLocaleDateString("es", { day: "numeric", month: "long" });
  }
  function el(tag, clase, texto) {
    const e = document.createElement(tag);
    if (clase) e.className = clase;
    if (texto !== undefined) e.textContent = texto;
    return e;
  }
  function diaDe(d) {
    const t = new Date(Number(d && (d.creado || d.ts)) || 0);
    return t.getFullYear() + "-" + String(t.getMonth() + 1).padStart(2, "0") + "-" + String(t.getDate()).padStart(2, "0");
  }
  function iconoWA() {
    const ns = "http://www.w3.org/2000/svg", s = document.createElementNS(ns, "svg"), p = document.createElementNS(ns, "path");
    s.setAttribute("viewBox", "0 0 24 24"); s.setAttribute("width", "14"); s.setAttribute("height", "14"); s.setAttribute("aria-hidden", "true");
    p.setAttribute("fill", "currentColor");
    p.setAttribute("d", "M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm5.2 14.2c-.2.6-1.2 1.2-1.7 1.2-.4.1-1 .1-1.6-.1-.4-.1-.9-.3-1.5-.6-2.6-1.1-4.3-3.8-4.4-4-.1-.2-1-1.3-1-2.5s.6-1.8.9-2c.2-.3.5-.3.7-.3h.5c.2 0 .4 0 .6.5l.8 2c.1.2.1.3 0 .5l-.3.4-.4.5c-.1.1-.3.3-.1.6.2.3.8 1.3 1.7 2.1 1.1 1 2.1 1.3 2.4 1.5.3.1.5.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.9.9c.3.1.5.2.5.3.1.2.1.8-.1 1.4z");
    s.appendChild(p);
    return s;
  }
  function chipEstado(d) {
    const est = estadoDe(d), nom = cortar(d.repartidorNombre || "un repartidor", 30);
    if (est === "nuevo") return el("span", "sa-estado", "Sin atender");
    if (est === "atendido") { const c = el("span", "sa-estado wa"); c.appendChild(iconoWA()); c.appendChild(document.createTextNode(" Con pedido · " + nom)); return c; }
    if (est === "entregado") return el("span", "sa-estado entregado", "✅ Entregado" + (d.repartidorNombre ? " · " + nom : "") + (d.forzadoPorAdmin ? " · forzado" : ""));
    return el("span", "sa-estado cancelado", "🚫 Cancelado" + (d.motivoCancelacion === "cliente" ? " · lo decidió el cliente" : "") + (d.forzadoPorAdmin ? " · forzado" : ""));
  }
  const estrellas = (n) => "★".repeat(n) + "☆".repeat(5 - n);
  const valoracion = (d) => { const n = Number(d && d.valoracion && d.valoracion.estrellas); return n >= 1 && n <= 5 ? Math.round(n) : 0; };
  
  function msg(texto, error) {
    const m = g("saMsg");
    if (!m) return;
    m.textContent = texto || "";
    m.className = "sa-msg" + (error ? " error" : "") + (texto ? "" : " oculto");
  }

  /* ============================================================
     FASE 2 · AVISOS DEL CICLO DE VIDA DEL PEDIDO DEL CLIENTE
     nuevo → tomado → entrega (llegadaTs) → entregado / cancelado.
     Cada aviso: voz (Voz.solicitudEvento) + toast + notificación.
     Se avisa solo de cambios posteriores a la primera carga y una sola vez por evento.
     ============================================================ */
  const vistosEv = new Set();
  let notifOyente = false;
  function irASolicitud(id) {
    try { irAPestana("panelSolicitudes"); } catch (_) {}
    setTimeout(() => { if (lista[id]) abrirVisor(id, PANEL); }, 150);
  }
  window.__irASolicitud = irASolicitud;   // lo usa el Service Worker (sw.js) al tocar una notificación push
  /* FASE 2 (push) · el Service Worker avisa que llegó un push (app abierta, minimizada o en segundo plano): voz + refresco. */
  const TIPOS_VOZ_PUSH = ["sol_nuevo", "pedido_whatsapp", "whatsapp", "mensaje_repartidor", "chat_repartidor", "mensaje", "pedido"];
  window.addEventListener("push-admin-recibido", (ev) => {
    const d = (ev && ev.detail) || {};
    if (TIPOS_VOZ_PUSH.indexOf(String(d.tipo || "sol_nuevo")) !== -1) { try { Voz.alertaPedido(); } catch (_) {} }
  });
  async function notificarLocal(titulo, cuerpo, id, tipo) {
    try {
      const LN = typeof adminPlug === "function" ? adminPlug("LocalNotifications") : null;
      if (LN) {
        let p = await LN.checkPermissions();
        if (p.display !== "granted") p = await LN.requestPermissions();
        if (p.display === "granted") {
          if (!notifOyente) {
            notifOyente = true;
            LN.addListener("localNotificationActionPerformed", (e) => { const x = e && e.notification && e.notification.extra; if (x && x.solicitud) irASolicitud(x.solicitud); });
          }
          await LN.schedule({ notifications: [{ id: (Date.now() % 2147483000) + 1, title: titulo, body: cuerpo, channelId: "admin", extra: { solicitud: id, tipo } }] });
          return;
        }
      }
    } catch (_) {}
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "granted") {
        const n = new Notification(titulo, { body: cuerpo, tag: "sol-" + id + "-" + tipo });
        n.onclick = () => { window.focus(); irASolicitud(id); n.close(); };
      }
    } catch (_) {}
  }
  const TITULO_EV = { nuevo: "📥 Nuevo pedido de cliente", tomado: "🛵 Pedido tomado", entrega: "📍 Va a entregar", entregado: "✅ Pedido entregado", cancelado: "🚫 Pedido cancelado" };
  function eventosDe(k, d) {
    const l = [{ c: k + ":nuevo", t: "nuevo" }];
    if (d.repartidorUid) l.push({ c: k + ":tomado:" + d.repartidorUid, t: "tomado" });
    if (d.llegadaTs) l.push({ c: k + ":entrega", t: "entrega" });
    if (d.estado === "entregado") l.push({ c: k + ":entregado", t: "entregado" });
    else if (d.estado === "cancelado") l.push({ c: k + ":cancelado", t: "cancelado" });
    return l;
  }
  function revisarEventos(avisar) {
    Object.keys(lista).forEach((k) => {
      const d = lista[k]; if (!d || typeof d !== "object") return;
      const nuevos = eventosDe(k, d).filter((e) => !vistosEv.has(e.c));
      nuevos.forEach((e) => vistosEv.add(e.c));
      if (!avisar || !nuevos.length) return;
      const e = nuevos[nuevos.length - 1], p = d.pedido || {};
      const por = d.canceladoPor || d.motivoCancelacion || "";
      if ((e.t === "entregado" || e.t === "cancelado") && (d.forzadoPorAdmin || por === "admin")) return;   // lo hizo el propio admin
      const args = { cliente: cortar(d.nombre || "Cliente", 30), repartidor: cortar(d.repartidorNombre || "", 30), quiere: cortar(p.quiere || "", 80), origen: cortar(p.origen || "", 50), por };
      const texto = e.t === "nuevo" ? (Voz.alertaPedido(), Voz.FRASES.solicitudNueva(args.cliente, args.quiere, args.origen)) : Voz.solicitudEvento(e.t, args);   // nuevo → "Hay una solicitud de pedido"
      if (typeof toast === "function") toast(TITULO_EV[e.t].slice(0, 2) + " " + texto);
      notificarLocal(TITULO_EV[e.t], texto, k, e.t);
      if (typeof PushAdmin !== "undefined" && PushAdmin.solicitud) PushAdmin.solicitud(e.t, texto, k);
    });
  }

  function iniciar() {
    detener();
    cargada = false; avisadas.clear(); vistosEv.clear();
    consulta = db.ref(RAIZ).limitToLast(100);
    consulta.on("value", (s) => {
      const antes = lista;
      lista = s.val() || {};
      revisarEventos(cargada);
      cargada = true;
      [...sel].forEach((id) => { if (!lista[id] || !fin(lista[id])) sel.delete(id); });
      pintar();
      if (visorId) { cabeceraVisor(); actualizarMapa(false); }
    }, (e) => {
      lista = {};
      pintar(e && e.code === "PERMISSION_DENIED" ? "Sin permiso para leer “solicitudes_entrantes”." : "No se pudieron cargar las solicitudes.");
    });
    refUbic = db.ref("ubicaciones");
    refUbic.on("value", (s) => { ubic = s.val() || {}; pintarServicio(); }, () => { ubic = {}; pintarServicio(); });
  }
  function detener() {
    if (consulta) { consulta.off(); consulta = null; }
    if (refUbic) { refUbic.off(); refUbic = null; }
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    if (refUltimaDir) { refUltimaDir.off(); refUltimaDir = null; }
    lect = {}; ultimaDirCliente = null;
    limpiarVisor();
    lista = {}; ubic = {}; sel.clear();
    pintar();
  }
  function pintarServicio() {
    const c = g("saServicio"); if (!c) return;
    c.textContent = "";
    const ids = Object.keys(ubic).filter((u) => ubic[u] && ubic[u].conPedido === true && ubic[u].enLinea !== false);
    ids.forEach((u) => { const x = el("span", "sa-estado wa"); x.appendChild(iconoWA()); x.appendChild(document.createTextNode(" " + cortar(ubic[u].usuario || "Repartidor", 24) + " · con pedido")); c.appendChild(x); });
    c.classList.toggle("oculto", !ids.length);
  }
  function visibles() {
    return Object.keys(lista).filter((k) => lista[k] && typeof lista[k] === "object")
      .filter((k) => {
        const e = estadoDe(lista[k]);
        if (filtro === "nuevo" && e !== "nuevo") return false;
        if (filtro === "atendido" && e !== "atendido") return false;
        if (filtro === "finalizado" && !fin(lista[k])) return false;
        return !fecha || diaDe(lista[k]) === fecha;
      })
      .sort((a, b) => (Number(lista[b].ts) || 0) - (Number(lista[a].ts) || 0));
  }
  
  function pintar(error) {
    const caja = g("saLista"); if (!caja) return;
    caja.textContent = "";
    const todas = Object.keys(lista).filter((k) => lista[k] && typeof lista[k] === "object");
    const sinAtender = todas.filter((k) => estadoDe(lista[k]) === "nuevo").length;
    const badge = g("saBadge");
    if (badge) { badge.textContent = String(sinAtender); badge.classList.toggle("oculto", !sinAtender); }
    const vals = todas.map((k) => valoracion(lista[k])).filter(Boolean);
    g("saResumen").textContent = vals.length ? "⭐ " + (vals.reduce((t, n) => t + n, 0) / vals.length).toFixed(1) + " de promedio · " + vals.length + " valoración" + (vals.length > 1 ? "es" : "") : "";
    if (error) { caja.appendChild(el("div", "sa-vacio", error)); pintarHerramientas([]); return; }
    
    const vis = visibles();
    pintarHerramientas(vis);
    contarCortina(vis.length);
    if (!vis.length) {
      caja.appendChild(el("div", "sa-vacio", !todas.length ? "Todavía no hay solicitudes." : "No hay solicitudes con este filtro."));
      return;
    }
    
    vis.forEach((k) => {
      const d = lista[k], est = estadoDe(d), p = d.pedido || {};
      const finalizada = fin(d);
      const f = el("div", "sa-item" + (est === "nuevo" ? " nuevo" : est === "atendido" ? " activo" : "") + (finalizada ? " fin" : ""));
      const fila = el("div", "sa-fila");
      if (finalizada) {
        const c = el("input", "sa-chk");
        c.type = "checkbox"; c.checked = sel.has(k);
        c.setAttribute("aria-label", "Seleccionar solicitud finalizada");
        c.addEventListener("change", () => { if (c.checked) sel.add(k); else sel.delete(k); pintarHerramientas(visibles()); });
        fila.appendChild(c);
      }
      const nombre = cortar(d.nombre || "Cliente", 40);
      fila.appendChild(el("span", "sa-av", nombre.charAt(0).toUpperCase()));
      const dat = el("div", "sa-dat");
      dat.appendChild(el("strong", "", nombre));
      dat.appendChild(chipEstado(d));
      if (p.quiere) dat.appendChild(el("small", "", "🛍️ " + cortar(p.quiere, 70) + (p.origen ? " · de " + cortar(p.origen, 40) : "")));
      const ult = d.ultimoMensaje ? (d.ultimoDe === "cliente" ? "Cliente: " : d.ultimoDe === "repartidor" ? "Repartidor: " : "") + String(d.ultimoMensaje) : "Sin mensajes todavía";
      dat.appendChild(el("small", "", ult + (d.ts ? " · " + horaDe(d.ts) : "")));
      if (valoracion(d)) dat.appendChild(el("small", "sa-estrellas", estrellas(valoracion(d))));
      fila.appendChild(dat);
      f.appendChild(fila);

      const acc = el("div", "sa-acc");
      const b = el("button", "oscuro", "👁 Ver");
      b.type = "button"; b.addEventListener("click", () => abrirVisor(k, PANEL));
      acc.appendChild(b);

      // Estados finales (Entregado / Cancelado): NO se muestran botones de forzar ni cancelar.
      if (d.repartidorUid && !finalizada) {
        const fEnt = el("button", "primario", "✅ Entregado");
        fEnt.type = "button"; fEnt.title = "Forzar entregado";
        fEnt.addEventListener("click", () => forzarEstadoSolicitud(k, "entregado"));
        acc.appendChild(fEnt);
        const fCanc = el("button", "peligro", "🚫 Cancelar");
        fCanc.type = "button"; fCanc.title = "Forzar cancelado";
        fCanc.addEventListener("click", () => forzarEstadoSolicitud(k, "cancelado"));
        acc.appendChild(fCanc);
      }
      if (finalizada) {
        const x = el("button", "peligro", "🗑 Eliminar");
        x.type = "button"; x.addEventListener("click", () => borrar([k]));
        acc.appendChild(x);
      }
      f.appendChild(acc);
      caja.appendChild(f);
    });
  }

  function pintarHerramientas(vis) {
    const finV = vis.filter((k) => fin(lista[k]));
    const selV = finV.filter((k) => sel.has(k));
    g("saSelTodas").checked = !!finV.length && selV.length === finV.length;
    g("saSelTodas").disabled = !finV.length;
    g("saBorrarSel").disabled = !sel.size;
    g("saBorrarSel").textContent = "🗑 Eliminar seleccionadas (" + sel.size + ")";
    g("saBorrarFecha").disabled = !fecha || !finV.length;
    g("saBorrarFecha").textContent = fecha ? "🗑 Eliminar finalizadas del " + fecha.split("-").reverse().join("/") + " (" + finV.length + ")" : "🗑 Elige una fecha para borrar por día";
  }

  async function borrar(ids) {
    ids = ids.filter((id) => lista[id] && fin(lista[id]));
    if (!ids.length) return msg("Solo se pueden eliminar chats entregados o cancelados.", true);
    if (!confirm("¿Eliminar " + (ids.length === 1 ? "este chat" : ids.length + " chats") + " para siempre?")) return;
    msg("Eliminando…");
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const upd = {};
        ids.slice(i, i + 40).forEach((id) => { upd[RAIZ + "/" + id] = null; upd[RAIZ_FOTOS + "/" + id] = null; });
        await db.ref().update(upd);
      }
    } catch (e) { return msg("No se pudo eliminar: " + (e.code || e.message), true); }
    ids.forEach((id) => { sel.delete(id); delete lista[id]; if (id === visorId) cerrarVisor(); });
    msg(ids.length === 1 ? "Chat eliminado." : ids.length + " chats eliminados.");
    pintar();
    setTimeout(() => msg(""), 4000);
  }

  async function forzarEstadoSolicitud(id, nuevoEstado) {
    const d = lista[id];
    if (!d) return msg("No encuentro esa solicitud.", true);
    if (!["entregado", "cancelado"].includes(nuevoEstado)) return msg("Estado no válido.", true);
    if (fin(d)) return msg("Esta solicitud ya está " + (d.estado === "entregado" ? "entregada" : "cancelada") + ": no admite más cambios de estado.", true);
    const esEnt = nuevoEstado === "entregado";
    if (!confirm((esEnt ? "¿Forzar como ENTREGADO" : "¿Forzar como CANCELADO") + " el chat de " + cortar(d.nombre || "Cliente", 30) + "?")) return;
    const motivo = (prompt("Motivo del forzado (opcional):", "") || "").trim().slice(0, 300);
    if (!motivo && !confirm("Sin motivo. ¿Continuar igual?")) return;
    const upd = {
      [RAIZ + "/" + id + "/estado"]: nuevoEstado,
      [RAIZ + "/" + id + "/forzadoPorAdmin"]: true,
      [RAIZ + "/" + id + "/forzadoTs"]: firebase.database.ServerValue.TIMESTAMP
    };
    if (esEnt) upd[RAIZ + "/" + id + "/entregadoTs"] = firebase.database.ServerValue.TIMESTAMP;
    else upd[RAIZ + "/" + id + "/canceladoTs"] = firebase.database.ServerValue.TIMESTAMP;
    if (motivo) upd[RAIZ + "/" + id + "/motivoForzado"] = motivo;
    try {
      await db.ref().update(upd);
      msg(esEnt ? "✅ Chat forzado a ENTREGADO" : "🚫 Chat forzado a CANCELADO");
      setTimeout(() => msg(""), 4000);
    } catch (e) { msg("No se pudo forzar: " + (e.code || e.message), true); }
  }

  // Espectador: deshabilitado cuando la solicitud está Entregada o Cancelada
  function bloquearEspectador(bloq) {
    const b = g("saMapaBtn"); if (!b) return;
    b.disabled = !!bloq;
    b.setAttribute("aria-disabled", String(!!bloq));
    b.title = bloq ? "No disponible: el pedido ya fue entregado o cancelado" : "";
    if (bloq) {
      const caja = g("saMapaCaja");
      if (caja && !caja.classList.contains("oculto")) { caja.classList.add("oculto"); b.setAttribute("aria-expanded", "false"); }
    }
  }
  function cabeceraVisor() {
    const d = lista[visorId];
    if (!d) { g("saSub").textContent = "Este chat fue eliminado."; g("saBorrarUno").classList.add("oculto"); g("saForzarEnt").classList.add("oculto"); g("saForzarCanc").classList.add("oculto"); bloquearEspectador(true); return; }
    g("saTitulo").textContent = cortar(d.nombre || "Cliente", 40);
    const est = estadoDe(d), v = valoracion(d);
    g("saSub").textContent = est === "nuevo" ? "Sin atender todavía" : est === "atendido" ? "Con pedido · " + cortar(d.repartidorNombre || "un repartidor", 30) : est === "entregado" ? "Entregado" + (d.forzadoPorAdmin ? " · forzado" : "") : "Cancelado" + (d.forzadoPorAdmin ? " · forzado" : "");
    g("saBorrarUno").classList.toggle("oculto", !fin(d));
    const activa = !!d.repartidorUid && !fin(d);
    g("saForzarEnt").classList.toggle("oculto", !activa);
    g("saForzarCanc").classList.toggle("oculto", !activa);
    bloquearEspectador(fin(d));
    const p = d.pedido;
    const r = g("saPedido");
    
    let info = "";
    if (p && p.quiere) info = "🛍️ " + cortar(p.quiere, 160) + " · de " + cortar(p.origen, 80);
    if (ultimaDirCliente) info += (info ? " · " : "") + "📮 <b>Última dirección:</b> " + esc(ultimaDirCliente.texto);
    
    r.innerHTML = info;
    r.classList.toggle("oculto", !info);
  }
  
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

  const tabActivaSA = () => { const b = document.querySelector(".tabs button.activa"); return b ? b.dataset.tab : "panelMapa"; };
  function abrirVisor(id, origen) {
    limpiarVisor();
    origenVisor = origen || tabActivaSA();   // pestaña a la que se regresa al cerrar (Mapa o Solicitudes)
    visorId = id; ultDia = null; vistos.clear();
    g("saMsgs").textContent = "";
    g("saMapaCaja").classList.add("oculto");
    g("saMapaBtn").setAttribute("aria-expanded", "false");
    cabeceraVisor();
    g("modalSolicitud").classList.remove("oculto");
    consultaMsgs = db.ref(RAIZ + "/" + id + "/mensajes").limitToLast(300);
    consultaMsgs.on("child_added", (s) => {
      if (vistos.has(s.key)) return;
      vistos.add(s.key);
      const m = s.val();
      if (m && typeof m === "object") pintarMensaje(m, s.key);
    });
    leerLeidos(id);
    leerUltimaDir(id);
  }

  function leerLeidos(id) {
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    refLeidos = db.ref(RAIZ + "/" + id + "/leidos");
    refLeidos.on("value", (s) => {
      const v = s.val() || {};
      lect = { cliente: Number(v.cliente) || 0, repartidor: Number(v.repartidor) || 0 };
      actualizarTicks();
    });
  }
  
  function actualizarTicks() {
    if (!visorId) return;
    g("saMsgs").querySelectorAll(".sa-tick").forEach((t) => {
      const ts = +t.dataset.ts || 0;
      const leido = ts > 0 && (Number(lect.cliente) || 0) >= ts;
      t.textContent = leido ? "✓✓" : "✓";
      t.classList.toggle("leido", leido);
      t.style.color = leido ? COLOR_TICK_LEIDO : COLOR_TICK_ENVIADO;
    });
  }

  function leerUltimaDir(id) {
    if (refUltimaDir) { refUltimaDir.off(); refUltimaDir = null; }
    ultimaDirCliente = null;
    const d = lista[id];
    if (!d || !d.clienteId) return;
    refUltimaDir = db.ref(RAIZ_CLIENTES + "/" + d.clienteId + "/ultimaDireccion");
    refUltimaDir.on("value", (s) => {
      const u = s.val();
      if (!u || typeof u !== "object") { ultimaDirCliente = null; cabeceraVisor(); return; }
      if (u.tipo !== "pin" && u.tipo !== "direccion") { ultimaDirCliente = null; cabeceraVisor(); return; }
      let donde = "";
      if (u.tipo === "direccion") donde = String(u.texto || "");
      else if (okLL(Number(u.lat), Number(u.lng))) donde = `Pin del mapa (${Number(u.lat).toFixed(5)}, ${Number(u.lng).toFixed(5)})`;
      if (!donde) { ultimaDirCliente = null; cabeceraVisor(); return; }
      ultimaDirCliente = { tipo: u.tipo, texto: donde };
      cabeceraVisor();
    });
  }

  /* Cierra el visor y regresa a la pantalla desde donde se abrió (bandeja de Solicitudes o Mapa). */
  function cerrarVisor() {
    const estaba = !!visorId, destino = origenVisor;
    limpiarVisor();
    if (estaba && destino && tabActivaSA() !== destino) setTimeout(() => { try { irAPestana(destino); } catch (_) {} }, 0);
  }
  /* Atrás dentro del visor: primero pliega el mapa espectador; después cierra el visor. */
  function atrasVisor() {
    if (!visorId) return false;
    const caja = g("saMapaCaja");
    if (caja && !caja.classList.contains("oculto")) { caja.classList.add("oculto"); g("saMapaBtn").setAttribute("aria-expanded", "false"); return true; }
    cerrarVisor();
    return true;
  }
  function limpiarVisor() {
    if (consultaMsgs) { consultaMsgs.off(); consultaMsgs = null; }
    if (refLeidos) { refLeidos.off(); refLeidos = null; }
    if (refUltimaDir) { refUltimaDir.off(); refUltimaDir = null; }
    visorId = null;
    lect = {}; ultimaDirCliente = null;
    quitarMarcas();
    const m = g("modalSolicitud");
    if (m) m.classList.add("oculto");
  }

  function cargarFoto(id, clave, img, listo) {
    db.ref(RAIZ_FOTOS + "/" + id + "/" + clave).once("value").then((s) => {
      const v = s.val();
      if (typeof v === "string" && v.indexOf("data:image/") === 0) { img.addEventListener("load", listo, { once: true }); img.src = v; }
      else img.alt = "Foto no disponible";
    }).catch(() => { img.alt = "No se pudo cargar la foto"; });
  }

  function pintarMensaje(m, clave) {
    const c = g("saMsgs"), ts = Number(m.ts) || Date.now(), rep = m.de === "repartidor";
    const pegado = c.scrollHeight - c.scrollTop - c.clientHeight < 80;
    const dia = new Date(ts).toDateString();
    if (dia !== ultDia) { ultDia = dia; c.appendChild(el("div", "sa-dia", etiquetaDia(ts))); }
    const d = lista[visorId] || {};
    const b = el("div", "sa-b" + (rep ? " rep" : ""));
    b.appendChild(el("div", "sa-quien", rep ? cortar(d.repartidorNombre || "Repartidor", 40) : cortar(d.nombre || "Cliente", 40)));
    if (m.tipo === "factura" && m.factura && typeof m.factura === "object") {
      b.classList.add("fac");
      b.appendChild(tarjetaFactura(m.factura));
    } else if (m.tipo === "foto") {
      b.classList.add("foto");
      const img = document.createElement("img");
      img.alt = "Cargando foto…";
      b.appendChild(img);
      const id = visorId;
      cargarFoto(id, clave, img, () => { if (pegado) c.scrollTop = c.scrollHeight; });
    } else {
      b.appendChild(el("p", "", String(m.texto || "")));
    }
    const h = el("span", "sa-h", horaDe(ts));
    if (rep) {
      const tick = document.createElement("span");
      tick.className = "sa-tick"; tick.dataset.ts = ts; tick.textContent = "✓";
      tick.style.color = COLOR_TICK_ENVIADO;
      h.appendChild(document.createTextNode(" "));
      h.appendChild(tick);
    }
    b.appendChild(h);
    c.appendChild(b);
    actualizarTicks();
    if (pegado || c.children.length <= 2) c.scrollTop = c.scrollHeight;
  }

  function filaF(etiqueta, valor, clase) {
    const f = el("div", "sa-ffil" + (clase ? " " + clase : ""));
    f.appendChild(el("span", "", etiqueta));
    f.appendChild(el("b", "", valor));
    return f;
  }

  function tarjetaFactura(f) {
    const caja = document.createElement("div");
    const prods = (Array.isArray(f.productos) ? f.productos : []).filter((p) => p && typeof p === "object");
    const extras = prods.filter((p) => String(p.nombre || "").indexOf("➕") === 0), normales = prods.filter((p) => extras.indexOf(p) < 0);
    const cab = el("div", "sa-fcab");
    cab.appendChild(el("strong", "", "🏍️ Brother’s Delivery"));
    cab.appendChild(el("span", "", extras.length ? "Factura actualizada" : "Factura"));
    caja.appendChild(cab);
    const cue = el("div", "sa-fcue");
    if (f.cliente) cue.appendChild(el("div", "sa-fmeta", "Cliente: " + String(f.cliente)));
    const lis = el("div", "sa-flis");
    normales.forEach((p) => lis.appendChild(filaF(String(p.nombre || "Producto"), dinero(p.precio))));
    cue.appendChild(lis);
    if (extras.length) {
      const ex = el("div", "sa-extras");
      ex.appendChild(el("div", "sa-extras-tit", "➕ Mandados extra"));
      extras.forEach((p) => ex.appendChild(filaF(String(p.nombre).replace(/^➕\s*/, "") || "Extra", dinero(p.precio))));
      cue.appendChild(ex);
    }
    const tot = el("div", "sa-ftot");
    tot.appendChild(filaF("Subtotal", dinero(f.subtotal)));
    tot.appendChild(filaF("Delivery", dinero(f.delivery)));
    if (Number(f.prioridad) > 0) tot.appendChild(filaF("⚡ Prioridad", dinero(f.prioridad)));
    tot.appendChild(filaF("Total", dinero(f.totalFinal != null ? f.totalFinal : f.total), "total"));
    cue.appendChild(tot);
    if (f.pedido) {
      const cod = el("div", "sa-fcod");
      cod.appendChild(el("small", "", "Código de retiro"));
      cod.appendChild(el("span", "", String(f.pedido)));
      cue.appendChild(cod);
    }
    caja.appendChild(cue);
    return caja;
  }

  const iconoPin = (clase, emoji) => L.divIcon({ className: "", html: '<div class="sa-pin ' + clase + '">' + emoji + "</div>", iconSize: [36, 36], iconAnchor: [18, 18] });
  function distanciaM(a, b) {
    const R = 6371000, rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function hace(ts) {
    const s = Math.max(0, Math.round((Date.now() - Number(ts)) / 1000));
    return s < 60 ? "hace " + s + " s" : s < 3600 ? "hace " + Math.round(s / 60) + " min" : "hace " + Math.round(s / 3600) + " h";
  }
  function quitarMarcas() {
    if (mapa) { [marcaCli, marcaRep, linea].forEach((x) => { if (x) mapa.removeLayer(x); }); }
    marcaCli = marcaRep = linea = null; encuadrado = false;
  }
  function alternarMapa() {
    if (typeof L === "undefined") return msg("No se pudo cargar el mapa (Leaflet).", true);
    if (visorId && fin(lista[visorId])) return msg("Modo espectador no disponible: el pedido ya fue entregado o cancelado.", true);
    const caja = g("saMapaCaja"), abrir = caja.classList.contains("oculto");
    caja.classList.toggle("oculto", !abrir);
    g("saMapaBtn").setAttribute("aria-expanded", String(abrir));
    if (!abrir) return;
    if (!mapa) {
      mapa = L.map("saMapa", { zoomControl: false }).setView([12.5700, -87.1311], 13);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(mapa);
    }
    setTimeout(() => { mapa.invalidateSize(); encuadrado = false; actualizarMapa(true); }, 80);
  }
  function actualizarMapa(forzar) {
    if (!mapa || !visorId || g("saMapaCaja").classList.contains("oculto") || fin(lista[visorId])) return;
    const d = lista[visorId] || {}, cg = d.clienteGps, rg = d.repartidorGps, dest = d.pedido && d.pedido.destino;
    let cli = null, vivoCli = false;
    if (cg && okLL(cg.lat, cg.lng)) { cli = { lat: cg.lat, lng: cg.lng }; vivoCli = true; }
    else if (dest && okLL(dest.lat, dest.lng)) cli = { lat: dest.lat, lng: dest.lng };
    const rep = rg && okLL(rg.lat, rg.lng) ? { lat: rg.lat, lng: rg.lng } : null;
    const poner = (marca, p, icono) => { if (!p) { if (marca) mapa.removeLayer(marca); return null; } if (!marca) return L.marker([p.lat, p.lng], { icon: icono, interactive: false }).addTo(mapa); marca.setLatLng([p.lat, p.lng]); return marca; };
    marcaCli = poner(marcaCli, cli, iconoPin("cli", d.pedido && d.pedido.modo === "envia" ? "🏠" : "👤"));
    marcaRep = poner(marcaRep, rep, iconoPin("rep", "🛵"));
    if (cli && rep) {
      if (!linea) linea = L.polyline([[cli.lat, cli.lng], [rep.lat, rep.lng]], { color: "#0A86C9", weight: 3, dashArray: "6 8" }).addTo(mapa);
      else linea.setLatLngs([[cli.lat, cli.lng], [rep.lat, rep.lng]]);
    } else if (linea) { mapa.removeLayer(linea); linea = null; }
    const partes = [];
    partes.push(cli ? "👤 Cliente " + (vivoCli ? "en vivo" : "· punto del pedido") : "👤 Cliente sin ubicación");
    partes.push(rep ? "🛵 Repartidor" : "🛵 Repartidor sin señal");
    g("saMapaInfo").textContent = partes.join(" · ");
    if (forzar || !encuadrado) {
      const pts = [cli, rep].filter(Boolean).map((p) => [p.lat, p.lng]);
      if (pts.length === 2) { mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 17 }); encuadrado = true; }
      else if (pts.length === 1) mapa.setView(pts[0], 16);
    }
  }

  function enlazar() {
    const botones = document.querySelectorAll(".tabs button");
    botones.forEach((b) => b.addEventListener("click", () => {
      const panel = g(PANEL); if (!panel) return;
      if (b.dataset.tab === PANEL) {
        botones.forEach((x) => {
          x.classList.toggle("activa", x === b);
          const p = x === b ? null : g(x.dataset.tab);
          if (p) p.classList.add("oculto");
        });
        panel.classList.remove("oculto");
        pintar();
      } else panel.classList.add("oculto");
    }));
    g("saFiltros").addEventListener("click", (e) => {
      const b = e.target.closest("button[data-f]"); if (!b) return;
      filtro = b.dataset.f;
      g("saFiltros").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      pintar();
    });
    fecha = hoyClave(); g("saFecha").value = fecha;   // por defecto: pedidos de hoy
    g("saFecha").addEventListener("change", () => { fecha = g("saFecha").value || ""; pintar(); });
    const cort = g("saCortina");
    if (cort) cort.addEventListener("click", () => { cortinaAbierta = !cortinaAbierta; try { localStorage.setItem(CLAVE_CORTINA, cortinaAbierta ? "1" : "0"); } catch (_) {} aplicarCortina(); });
    aplicarCortina();
    g("saFechaLimpiar").addEventListener("click", () => { fecha = ""; g("saFecha").value = ""; pintar(); });
    g("saFechaLimpiar").textContent = "Todas";
    g("saSelTodas").addEventListener("change", () => {
      const finV = visibles().filter((k) => fin(lista[k]));
      finV.forEach((k) => { if (g("saSelTodas").checked) sel.add(k); else sel.delete(k); });
      pintar();
    });
    g("saBorrarSel").addEventListener("click", () => borrar([...sel]));
    g("saBorrarFecha").addEventListener("click", () => { if (fecha) borrar(visibles().filter((k) => fin(lista[k]))); });
    g("saBorrarUno").addEventListener("click", () => { if (visorId) borrar([visorId]); });
    g("saForzarEnt").addEventListener("click", () => { if (visorId) forzarEstadoSolicitud(visorId, "entregado"); });
    g("saForzarCanc").addEventListener("click", () => { if (visorId) forzarEstadoSolicitud(visorId, "cancelado"); });
    g("saMapaBtn").addEventListener("click", alternarMapa);
    g("saCerrar").addEventListener("click", cerrarVisor);
    g("modalSolicitud").addEventListener("click", (e) => { if (e.target === g("modalSolicitud")) cerrarVisor(); });
    setInterval(() => { if (visorId) actualizarMapa(false); }, 10000);
  }

  if (g(PANEL)) {
    enlazar();
    if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) iniciar(); else detener(); });
  }
  const activas = () => Object.entries(lista).filter(([, d]) => d && typeof d === "object" && d.repartidorUid && !fin(d));
  return { iniciar, detener, forzarEstadoSolicitud, activas, abrirVisor, cerrarVisor, atras: atrasVisor, visorAbierto: () => !!visorId };
})();


/* ============================================================
   BRÚJULA DEL MAPA
   - La aguja SIEMPRE señala el norte del mapa: se calcula a partir del propio mapa (hacia dónde cae el norte
     geográfico en la pantalla), así gira junto con él al rotarlo, moverlo o acercarlo, sin depender de sensores.
   - Al tocarla se DESBLOQUEA el mapa: moverlo, acercarlo y girarlo con los dedos (plugin leaflet-rotate;
     si no carga, el mapa sigue sin girar y la aguja queda fija al norte).
     Un segundo toque lo vuelve a bloquear y lo orienta al norte.
   ============================================================ */
const Brujula = (() => {
  let btn = null, aguja = null, estado = null, listo = false, libre = false, pendiente = false;
  const g = (id) => document.getElementById(id);
  const puedeGirar = () => !!(typeof mapa !== "undefined" && mapa && typeof mapa.setBearing === "function" && mapa.options && mapa.options.rotate);
  /* Ángulo (horario) con que se ve el norte geográfico respecto a "arriba" de la pantalla. */
  function anguloNorte() {
    try {
      const c = mapa.getCenter(), n = L.latLng(Math.min(c.lat + 0.002, 85), c.lng);
      const p0 = mapa.latLngToContainerPoint(c), p1 = mapa.latLngToContainerPoint(n);
      const dx = p1.x - p0.x, dy = p1.y - p0.y;
      if (!isFinite(dx) || !isFinite(dy) || (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6)) return 0;
      return Math.atan2(dx, -dy) * 180 / Math.PI;
    } catch (_) { return 0; }
  }
  function pintar() {
    pendiente = false;
    if (!aguja || !mapa) return;
    aguja.setAttribute("transform", "rotate(" + anguloNorte().toFixed(1) + " 24 24)");
  }
  function pedirPintar() { if (!pendiente) { pendiente = true; requestAnimationFrame(pintar); } }
  function aplicarModo() {
    if (!mapa) return;
    btn.classList.toggle("libre", libre);
    btn.setAttribute("aria-pressed", String(libre));
    estado.textContent = libre ? "Libre" : "Bloqueado";
    if (libre) {
      ["dragging", "touchZoom", "doubleClickZoom", "scrollWheelZoom", "boxZoom", "keyboard"].forEach((h) => { try { if (mapa[h]) mapa[h].enable(); } catch (_) {} });
      if (mapa.touchRotate) { try { mapa.touchRotate.enable(); } catch (_) {} }
      toast(puedeGirar() ? "🧭 Mapa libre: muévelo y gíralo con los dedos. Toca la brújula para bloquear." : "🧭 Mapa libre (este navegador no permite girar el mapa). Toca la brújula para bloquear.");
    } else {
      if (puedeGirar()) { try { mapa.setBearing(0); } catch (_) {} }
      if (mapa.touchRotate) { try { mapa.touchRotate.disable(); } catch (_) {} }
      try { if (typeof GestosMapa !== "undefined") GestosMapa.aplicar(mapa); } catch (_) {}
      toast("🧭 Mapa bloqueado y orientado al norte.");
    }
    pintar();
  }
  function iniciar() {
    if (listo) return;
    btn = g("btnBrujula"); aguja = g("brAguja"); estado = g("brEstado");
    if (!btn || !aguja || !mapa) return;
    listo = true;
    if (mapa.touchRotate) { try { mapa.touchRotate.disable(); } catch (_) {} }   // arranca bloqueado
    mapa.on("rotate move zoom moveend zoomend resize viewreset", pedirPintar);
    btn.addEventListener("click", () => { libre = !libre; aplicarModo(); });
    pintar();
  }
  return { iniciar, pintar: pedirPintar };
})();


/* ============================================================
   FASE 2 · CHAT ESTILO MESSENGER
   Los estilos viven en style.css (body.admin .chat …). Este módulo agrega
   la foto de perfil del repartidor en la cabecera y junto a sus burbujas.
   ============================================================ */
const ChatMessenger = (() => {
  let ctx = null, obs = null, prog = false;
  const foto = (uid) => { const f = typeof fotosCache !== "undefined" ? fotosCache[uid] : ""; return f && typeof f === "string" && f.indexOf("data:image/") === 0 ? f : ""; };
  /* Contexto del chat abierto: primero el chat con un repartidor del equipo (chatEqAbierto, de admin.js);
     si no hay, el del repartidor invitado que fijó abrirChatInv(). */
  function contexto() {
    try {
      if (typeof chatEqAbierto !== "undefined" && chatEqAbierto) {
        const n = typeof nombreUid === "function" ? nombreUid(chatEqAbierto) : "";
        return { uid: chatEqAbierto, nombre: n || "Repartidor" };
      }
    } catch (_) {}
    return ctx;
  }
  function avatar(clase, cx) {
    const s = document.createElement("span");
    s.className = clase;
    const f = cx && foto(cx.uid);
    if (f) { s.style.backgroundImage = "url('" + f + "')"; s.classList.add("con-foto"); }
    else s.textContent = String((cx && cx.nombre) || "R").trim().charAt(0).toUpperCase() || "R";
    return s;
  }
  function decorar() {
    prog = false;
    const c = document.querySelector("body.admin .chat");
    if (!c) return;
    c.classList.add("messenger");
    const cx = contexto();
    if (!cx) return;
    const barra = c.querySelector(".chat-barra");
    if (barra) {
      const previo = barra.querySelector(".msg-av-cab");
      const f = foto(cx.uid);
      if (!previo || previo.dataset.uid !== cx.uid || (!!f) !== previo.classList.contains("con-foto")) {
        if (previo) previo.remove();
        const a = avatar("msg-av msg-av-cab", cx); a.dataset.uid = cx.uid;
        const atras = barra.querySelector(".chat-atras");
        if (atras && atras.nextSibling) barra.insertBefore(a, atras.nextSibling); else barra.insertBefore(a, barra.firstChild);
      }
    }
    /* Burbujas del repartidor: si cambió el chat abierto o llegó la foto, se rehace el avatar de cada burbuja. */
    c.querySelectorAll(".burbuja.ajena").forEach((b) => {
      const av = b.querySelector(":scope > .msg-av");
      if (av && b.dataset.av === cx.uid && (!!foto(cx.uid)) === av.classList.contains("con-foto")) return;
      if (av) av.remove();
      b.dataset.av = cx.uid; b.classList.add("con-av"); b.appendChild(avatar("msg-av", cx));
    });
  }
  const pedir = () => { if (!prog) { prog = true; requestAnimationFrame(decorar); } };
  function iniciar() {
    if (obs) return;
    obs = new MutationObserver(pedir);
    obs.observe(document.body, { childList: true, subtree: true });
  }
  return { iniciar, set: (c) => { ctx = c; pedir(); }, limpiar: () => { ctx = null; } };
})();


/* ============================================================
   3) ACTUALIZACIONES OBLIGATORIAS
   ============================================================ */
const APP_VERSION_ADMIN = 1;
const ActualizacionAdmin = (() => {
  const BASE = "configuracion/actualizaciones/", g = (id) => document.getElementById(id);
  let ref = null;
  const bd = () => (typeof db !== "undefined" ? db : null);
  const urlSegura = (u) => { try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_) { return ""; } };
  /* Convierte enlaces de "compartir" de Google Drive / Dropbox en enlaces de descarga directa del APK. */
  function enlaceDirecto(u) {
    const url = urlSegura(u); if (!url) return "";
    try {
      const x = new URL(url);
      if (/(^|\.)drive\.google\.com$/.test(x.hostname)) {
        const m = x.pathname.match(/\/file\/d\/([^/]+)/) || null, id = (m && m[1]) || x.searchParams.get("id");
        if (id) return "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(id);
      }
      if (/(^|\.)dropbox\.com$/.test(x.hostname)) { x.searchParams.delete("dl"); x.searchParams.set("dl", "1"); return x.href; }
    } catch (_) {}
    return url;
  }
  const abrirNavegador = (url) => { try { window.open(url, "_system"); } catch (_) { window.location.href = url; } };
  const plug = (n) => (typeof adminPlug === "function" ? adminPlug(n) : null);

  /* Descarga el APK dentro de la app y abre el instalador del sistema (sin desinstalar la app).
     Requiere en la app Android: plugins Filesystem + FileOpener y el permiso REQUEST_INSTALL_PACKAGES.
     Si falta algo, abre el enlace en el navegador como antes. */
  let enCurso = false;
  async function actualizarApp(url, btn) {
    if (enCurso) return;
    const nativo = typeof adminEsNativo === "function" && adminEsNativo();
    const FS = nativo ? plug("Filesystem") : null, FO = nativo ? plug("FileOpener") : null;
    if (!FS || !FO || !FS.downloadFile) return abrirNavegador(url);
    const ARCHIVO = "brothers-admin-update.apk", DIR = "CACHE", txtBtn = btn.textContent;
    const prog = g("updProg"), barra = g("updProgBarra"), est = g("updEstado");
    const estado = (t) => { if (est) est.textContent = t || ""; };
    const avance = (pc) => { if (barra) barra.style.width = pc + "%"; if (prog) prog.setAttribute("aria-valuenow", String(pc)); };
    let escucha = null;
    enCurso = true; btn.setAttribute("aria-disabled", "true");
    try {
      prog.classList.remove("oculto"); avance(0); btn.textContent = "DESCARGANDO… 0 %"; estado("Descargando la actualización. No cierres la app.");
      try { await FS.deleteFile({ path: ARCHIVO, directory: DIR }); } catch (_) {}          // borra una descarga anterior
      try {
        escucha = await FS.addListener("progress", (p) => {
          if (!p || (p.url && p.url !== url) || !(p.contentLength > 0)) return;
          const pc = Math.min(100, Math.round((p.bytes / p.contentLength) * 100));
          avance(pc); btn.textContent = "DESCARGANDO… " + pc + " %";
        });
      } catch (_) {}
      await FS.downloadFile({ url, path: ARCHIVO, directory: DIR, progress: true });
      const st = await FS.stat({ path: ARCHIVO, directory: DIR });
      if (!st || Number(st.size) < 300000) throw new Error("El enlace no descargó un APK (revisa que sea un enlace directo).");
      avance(100); btn.textContent = "INSTALANDO…"; estado("Descarga lista. Acepta la ventana de instalación del sistema.");
      const { uri } = await FS.getUri({ path: ARCHIVO, directory: DIR });
      await FO.open({ filePath: uri, contentType: "application/vnd.android.package-archive", openWithDefault: true });
      estado("Si no aparece el instalador, toca el botón otra vez. Si el sistema lo pide, permite instalar apps desde Brother’s Deliverys.");
    } catch (err) {
      console.warn("actualizarApp:", err);
      estado("No se pudo instalar dentro de la app. Abriendo la descarga en el navegador…");
      setTimeout(() => abrirNavegador(url), 1200);
    } finally {
      try { if (escucha && escucha.remove) await escucha.remove(); } catch (_) {}
      enCurso = false; btn.removeAttribute("aria-disabled"); btn.textContent = txtBtn;
      setTimeout(() => { if (prog) prog.classList.add("oculto"); }, 1500);
    }
  }

  function mostrar(d) {
    const url = enlaceDirecto(d.url), btn = g("btnActualizarApp");
    g("updNovedades").textContent = String(d.novedades || "").trim() || "Mejoras de rendimiento y correcciones.";
    g("updVersionTxt").textContent = "Tu versión: " + APP_VERSION_ADMIN + " · Nueva versión: " + Number(d.version);
    if (url) {
      btn.href = url; btn.removeAttribute("aria-disabled");
      btn.onclick = (e) => { e.preventDefault(); actualizarApp(url, btn); };
    } else {
      btn.removeAttribute("href"); btn.setAttribute("aria-disabled", "true"); btn.onclick = (e) => e.preventDefault();
    }
    g("modalActualizacion").classList.remove("oculto");
    document.body.classList.add("upd-bloqueado");
  }
  function ocultar() {
    g("modalActualizacion").classList.add("oculto");
    document.body.classList.remove("upd-bloqueado");
  }
  function evaluar(d) { if (d && Number(d.version) > APP_VERSION_ADMIN) mostrar(d); else ocultar(); }
  function vigilar() {
    const base = bd(); if (ref || !base) return;
    ref = base.ref(BASE + "admin");
    ref.on("value", (s) => evaluar(s.val()), () => { ref = null; });
  }
  function lanzar() {
    const base = bd(); if (!base) return;
    modal(`<h2>🚀 Lanzar actualización</h2>
      <p class="ayuda">Las apps con una versión menor quedarán bloqueadas hasta que instalen el nuevo APK.</p>
      <label>Tipo de app <select id="updTipo"><option value="repartidor">Repartidor</option><option value="admin">Admin / Controlador</option></select></label>
      <small id="updActual" class="ayuda">Versión actual en la nube: …</small>
      <label>Nueva versión (ej. 2) <input id="updVersion" type="number" min="1" step="1" placeholder="2"></label>
      <label>Novedades <textarea id="updNov" rows="4" maxlength="600" placeholder="Qué trae esta versión…"></textarea></label>
      <label>Enlace del nuevo APK <input id="updUrl" type="url" placeholder="https://…"></label>
      <small class="ayuda">Debe ser un enlace directo de descarga del .apk (GitHub Releases, Firebase Storage, tu servidor, o un enlace de Google Drive/Dropbox, que se convierte solo). La app lo descarga e instala sin desinstalar.</small>
      <div id="updMsg" class="estado oculto" role="status"></div>
      <button id="updPublicar" class="primario" type="button">Publicar actualización</button>
      <button id="updCancelar" class="oscuro" type="button">Cancelar</button>`);
    const msg = (t, tipo) => { const m = g("updMsg"); m.textContent = t || ""; m.className = "estado " + (tipo || "") + (t ? "" : " oculto"); };
    async function mostrarActual() {
      const tipo = g("updTipo").value;
      g("updActual").textContent = "Versión actual en la nube: …";
      try {
        const v = (await base.ref(BASE + tipo).once("value")).val();
        if (g("updTipo") && g("updTipo").value === tipo) g("updActual").textContent = "Versión actual en la nube: " + (v && v.version != null ? v.version : "ninguna") + " · Instalada en este aparato (admin): " + APP_VERSION_ADMIN;
      } catch (_) { if (g("updActual")) g("updActual").textContent = "No se pudo leer la versión actual."; }
    }
    mostrarActual();
    g("updTipo").onchange = mostrarActual;
    g("updCancelar").onclick = cerrarModal;
    g("updPublicar").onclick = async () => {
      const tipo = g("updTipo").value, version = Number(g("updVersion").value), novedades = g("updNov").value.trim(), url = enlaceDirecto(g("updUrl").value);
      if (!Number.isInteger(version) || version < 1) return msg("Escribe la versión como número entero.", "error");
      if (!novedades) return msg("Escribe las novedades.", "error");
      if (!url) return msg("El enlace debe empezar con http:// o https://", "error");
      g("updPublicar").disabled = true; msg("Publicando…", "ok");
      try {
        await base.ref(BASE + tipo).set({ version, novedades, url, publicado: firebase.database.ServerValue.TIMESTAMP });
        cerrarModal(); toast("Actualización publicada ✓");
      } catch (err) {
        g("updPublicar").disabled = false;
        msg("No se pudo publicar: " + (err.message || err), "error");
      }
    };
  }
  const btnLanzar = g("btnLanzarUpd");
  if (btnLanzar) btnLanzar.onclick = lanzar;
  vigilar();
  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) vigilar(); });
  return { vigilar, lanzar, evaluar };
})();


/* ============================================================
   FASE 1 · NAVEGACIÓN CONTEXTUAL HACIA ATRÁS (pila SPA)
   admin.html envuelve Atras.iniciar para que esta capa corra justo después de la cámara/chat:
     · Chat con repartidor            → bandeja de Chats
     · Detalle de factura (lista)     → lista "Facturas en ruta" → Mapa
     · Factura/panel de cliente (Mapa)→ Mapa
     · Visor de solicitud (lectura)   → mapa espectador plegado → bandeja de Solicitudes (o Mapa si se abrió desde él)
     · Dibujo de zonas                → cancela el dibujo
   El resto de capas (modales, popups, búsqueda, pestañas…) sigue en la lista original de admin.js.
   ============================================================ */
const NavAdmin = (() => {
  const g = (id) => document.getElementById(id);
  const tabActiva = () => { const b = document.querySelector(".tabs button.activa"); return b ? b.dataset.tab : "panelMapa"; };
  function irA(tab) { if (tab && tabActiva() !== tab) { try { irAPestana(tab); } catch (_) {} } }

  /* Todo chat administrador ↔ repartidor (equipo o invitado) regresa a la bandeja de Chats al cerrarse. */
  if (typeof Chat !== "undefined" && Chat && Chat.iniciar && !Chat.__navAdmin) {
    const original = Chat.iniciar;
    Chat.iniciar = function (o) {
      o = o || {};
      if (o.yo === "admin") {
        const previo = o.alCerrar;
        o.alCerrar = function () {
          try { if (previo) previo.apply(this, arguments); }
          finally { setTimeout(() => irA("panelChats"), 0); }
        };
      }
      return original.call(this, o);
    };
    Chat.__navAdmin = true;
  }

  function atras() {
    try { if (ZonasMapa.atras()) return true; } catch (_) {}
    const modal = g("modalAdmin");
    if (modal && !modal.classList.contains("oculto")) {
      try { if (PedidosAdmin.volverALista()) return true; } catch (_) {}
      return false;   // cualquier otro modal: lo cierra la lista original (y se regresa a la pantalla de abajo)
    }
    try { if (SolicitudesAdmin.atras()) return true; } catch (_) {}
    try { if (ClientesMapa.atras()) return true; } catch (_) {}
    return false;
  }
  return { atras, irA, tabActiva };
})();


/* ============================================================
   FASE 1 · CLIENTES EN VIVO EN EL MAPA
   Un ícono con el nombre del cliente en su ubicación GPS por cada pedido activo
   (app cliente, WhatsApp / factura manual del repartidor, o pedido creado por el admin).
   Al tocarlo: panel flotante con repartidor asignado, Factura y Espectar Chat.
   Capas (de abajo hacia arriba): zonas 350 · rutas 400 · negocios 450 · clientes 560 · repartidores 600 · tarjetas 700.
   ============================================================ */
const ClientesMapa = (() => {
  const g = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hayNum = (n) => typeof n === "number" && isFinite(n);
  const num = (n) => (hayNum(n) ? n : Number(n) || 0);
  const r2 = (n) => Math.round(num(n) * 100) / 100;
  const dinero = (n) => "C$ " + r2(n).toFixed(2);
  const llOk = (p) => !!p && hayNum(p.lat) && hayNum(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const arr = (x) => (Array.isArray(x) ? x : Object.values(x || {})).filter((p) => p && typeof p === "object");
  const nomRep = (uid) => { try { return uid ? nombreUid(uid) : ""; } catch (_) { return ""; } };
  let items = {}, marcas = {}, abierto = null, tPintar = null, listo = false;

  /* ---------- capas y limpieza de controles del mapa ---------- */
  function preparar() {
    const pane = (nombre, z, sinEventos) => {
      const p = mapa.getPane(nombre) || mapa.createPane(nombre);
      p.style.zIndex = String(z);
      if (sinEventos) p.style.pointerEvents = "none";
    };
    pane("paneZonas", 350, true);
    pane("paneNegocios", 450);     // los negocios siempre por debajo de clientes, repartidores y tarjetas
    pane("paneClientes", 560);
    quitarZoom();
  }
  function quitarZoom() {
    try { if (mapa.zoomControl) mapa.removeControl(mapa.zoomControl); } catch (_) {}
    document.querySelectorAll("#mapaAdmin .leaflet-control-zoom").forEach((e) => e.remove());
  }

  /* ---------- fuentes de datos ---------- */
  function reunir() {
    const out = {};
    const sols = typeof solicitudesMapa !== "undefined" && solicitudesMapa ? solicitudesMapa : {};
    Object.entries(sols).forEach(([id, s]) => {
      if (!s || typeof s !== "object" || s.estado === "entregado" || s.estado === "cancelado") return;
      const p = typeof puntoSolicitud === "function" ? puntoSolicitud(s) : null;
      if (!llOk(p)) return;
      const uid = s.repartidorUid || "";
      out["s:" + id] = { k: "s:" + id, tipo: "s", id, nombre: s.nombre || "Cliente", lat: p.lat, lng: p.lng, uid, rep: uid ? (s.repartidorNombre || nomRep(uid)) : "", est: uid ? "Con pedido" : "Sin atender", fuente: "App cliente", d: s };
    });
    const tokens = new Set();
    PedidosAdmin.ordenesActivas().forEach(([t, o]) => {
      tokens.add(t);
      if (!llOk(o.entrega)) return;
      const a = o.asignacion || {}, uid = a.tipo === "invitado" ? Ordenes.uidInvitado(t) : (a.uid || "");
      out["o:" + t] = { k: "o:" + t, tipo: "o", id: t, nombre: o.cliente || "Cliente", lat: o.entrega.lat, lng: o.entrega.lng, uid, rep: a.nombre || "", est: (Ordenes.ESTADOS[o.estado] || [""])[0] || "Pedido", fuente: "Pedido admin", d: o };
    });
    Object.entries(typeof activos !== "undefined" ? activos : {}).forEach(([t, d]) => {
      if (!d || d.estado !== "en_ruta" || tokens.has(t) || (d.solicitudId && out["s:" + d.solicitudId])) return;
      const p = hayNum(d.destLat) && hayNum(d.destLng) ? { lat: d.destLat, lng: d.destLng } : d.cliente;
      if (!llOk(p)) return;
      const f = d.factura || {}, uid = d.repartidorUid || "";
      out["p:" + t] = { k: "p:" + t, tipo: "p", id: t, nombre: d.clienteNombre || f.cliente || "Cliente", lat: p.lat, lng: p.lng, uid, rep: d.repartidorNombre || nomRep(uid), est: "En ruta", fuente: d.sinFactura ? "WhatsApp (sin factura)" : "WhatsApp / factura manual", d };
    });
    return out;
  }

  /* ---------- marcadores ---------- */
  function icono(it) {
    const em = it.fuente.indexOf("WhatsApp") === 0 ? "💬" : "👤";
    return L.divIcon({
      className: "cm-wrap",
      html: `<div class="cm-pin ${it.uid ? "tomado" : "nuevo"}"><span>${em}</span></div><span class="cm-etq">${esc(it.nombre)}</span>`,
      iconSize: [40, 40], iconAnchor: [20, 20]
    });
  }
  function pedirPintar() { if (tPintar) return; tPintar = setTimeout(() => { tPintar = null; try { pintar(); } catch (e) { console.warn("[clientes mapa]", e); } }, 120); }
  function pintar() {
    if (!listo || typeof mapa === "undefined" || !mapa) return;
    items = reunir();
    const ver = new Set();
    Object.values(items).forEach((it) => {
      if (it.uid && typeof ocultos !== "undefined" && ocultos.has(it.uid)) return;   // repartidor oculto → tampoco se ven sus clientes
      ver.add(it.k);
      const clave = [it.nombre, it.uid ? 1 : 0, it.fuente].join("|");
      let m = marcas[it.k];
      if (!m) {
        m = marcas[it.k] = L.marker([it.lat, it.lng], { icon: icono(it), pane: "paneClientes", keyboard: false, riseOnHover: false }).addTo(mapa);
        m._k = it.k; m._clave = clave;
        m.on("click", () => abrir(m._k));
      } else {
        m.setLatLng([it.lat, it.lng]);
        if (m._clave !== clave) { m.setIcon(icono(it)); m._clave = clave; }
      }
    });
    Object.keys(marcas).forEach((k) => { if (!ver.has(k)) { try { mapa.removeLayer(marcas[k]); } catch (_) {} delete marcas[k]; } });
    if (abierto) { if (ver.has(abierto)) pintarPanel(); else cerrar(); }
  }
  function limpiar() {
    Object.keys(marcas).forEach((k) => { try { if (mapa) mapa.removeLayer(marcas[k]); } catch (_) {} delete marcas[k]; });
    items = {}; cerrar();
  }

  /* ---------- panel flotante ---------- */
  function detalle(it) {
    if (it.tipo === "s") { const p = it.d.pedido || {}; return p.quiere ? `<div class="cm-det">🛍️ ${esc(p.quiere)}${p.origen ? " · de " + esc(p.origen) : ""}</div>` : ""; }
    if (it.tipo === "o") { const o = it.d; return `<div class="cm-det">📦 ${esc(PedidosAdmin.codigo(o.codigo))}${o.paquete ? " · " + esc(o.paquete) : ""}</div>`; }
    return it.d.pedido ? `<div class="cm-det">📦 Pedido ${esc(it.d.pedido)}</div>` : "";
  }
  function pintarPanel() {
    const it = items[abierto], c = g("panelCliente");
    if (!it || !c) return;
    const av = it.uid ? `<span class="avatar cm-av" data-av="${esc(it.uid)}">${typeof RIDER_SVG !== "undefined" ? RIDER_SVG : "🛵"}</span>` : '<span class="cm-av cm-sin">🛵</span>';
    c.innerHTML = `<div class="cm-cab"><span class="cm-ini">${esc((it.nombre || "C").charAt(0).toUpperCase())}</span>
        <div class="cm-tit"><strong>${esc(it.nombre)}</strong><small>${esc(it.fuente)} · ${esc(it.est)}</small></div>
        <button type="button" class="cm-x" data-cm="cerrar" aria-label="Cerrar panel">✕</button></div>
      <div class="cm-rep">${av}<div><small>Repartidor asignado</small><strong>${it.rep ? esc(it.rep) : "Sin asignar todavía"}</strong></div></div>
      ${detalle(it)}
      <div class="cm-acc"><button type="button" class="cm-btn pri" data-cm="factura">🧾 Factura</button><button type="button" class="cm-btn" data-cm="chat">👁 Espectar Chat</button></div>`;
    c.classList.remove("oculto");
    try { aplicarFotosAvatares(); } catch (_) {}
  }
  function abrir(k) {
    if (!items[k]) return;
    abierto = k; pintarPanel();
    try { mapa.panTo([items[k].lat, items[k].lng], { animate: true }); } catch (_) {}
  }
  function cerrar() { abierto = null; const c = g("panelCliente"); if (c) { c.classList.add("oculto"); c.innerHTML = ""; } }
  function atras() {
    if (!abierto || NavAdmin.tabActiva() !== "panelMapa") return false;
    cerrar(); return true;
  }

  /* ---------- factura: productos · delivery · mandados extra · total general ---------- */
  function desdeFactura(f, extraAparte) {
    const prods = arr(f.productos);
    let prod = 0, ex = 0;
    prods.forEach((p) => { const m = num(p.precio); if (String(p.nombre || "").indexOf("➕") === 0) ex += m; else prod += m; });
    if (!prods.length && hayNum(f.subtotal)) prod = f.subtotal;
    const mand = num(f.mandadoExtra);
    const deliv = hayNum(f.deliveryBase) ? f.deliveryBase : Math.max(0, num(f.delivery) - mand);
    ex += mand + num(extraAparte);
    const otros = num(f.prioridad) + num(f.ivaExtraMonto);
    const base = hayNum(f.totalFinal) ? f.totalFinal : hayNum(f.total) ? f.total : prod + deliv + ex + otros;
    return { prod, deliv, ex, otros, total: r2(base + num(extraAparte)) };
  }
  const sumaExtras = (ex) => arr(ex).reduce((t, x) => t + num(x.monto), 0);
  function resumen(it) {
    if (it.tipo === "s") { const ff = it.d.facturaFinal; return ff && typeof ff === "object" ? desdeFactura(ff, 0) : null; }
    if (it.tipo === "p") { const f = it.d.detalle || it.d.factura; return f && typeof f === "object" && (hayNum(f.total) || hayNum(f.totalFinal) || arr(f.productos).length) ? desdeFactura(f, sumaExtras(it.d.extras)) : null; }
    const o = it.d, ped = typeof activos !== "undefined" ? activos[it.id] : null;
    const f = ped && (ped.detalle || ped.factura);
    if (f && typeof f === "object" && (hayNum(f.total) || hayNum(f.totalFinal))) return desdeFactura(f, sumaExtras(ped.extras));
    const k = Ordenes.cobro(o, ped);
    return { prod: k.pagado, deliv: k.delivery, ex: k.extras, otros: k.prio, total: k.total };
  }
  function abrirFactura() {
    const it = items[abierto]; if (!it) return;
    const r = resumen(it), fila = (t, v, c) => `<div class="fv-fila${c ? " " + c : ""}"><span>${t}</span><b>${dinero(v)}</b></div>`;
    const cuerpo = r
      ? `<div class="fv-bloque">${fila("🛍️ Total de productos", r.prod)}${fila("🛵 Delivery", r.deliv)}${fila("➕ Mandados extras", r.ex, r.ex > 0 ? "fv-ex" : "")}${r.otros > 0 ? fila("⚡ Prioridad / IVA extra", r.otros, "fv-pri") : ""}<div class="fv-total"><span>Total General</span><b>${dinero(r.total)}</b></div></div>`
      : '<div class="fv-bloque"><div class="fv-fila"><span>Todavía no hay factura: el repartidor aún no la envía.</span></div></div>';
    modal(`<div class="fv-caja"><h2>🧾 Factura</h2>
      <div class="fv-resumen"><div class="fv-banner"><b>${esc(it.nombre)}</b><small>🛵 ${esc(it.rep || "Sin asignar")} · ${esc(it.fuente)}</small></div>${cuerpo}</div>
      <button id="cmFvCerrar" class="oscuro" type="button">Cerrar</button></div>`);
    g("cmFvCerrar").onclick = cerrarModal;
  }

  /* ---------- espectar chat (solo lectura) ---------- */
  function espectar() {
    const it = items[abierto]; if (!it) return;
    if (it.tipo === "s") return SolicitudesAdmin.abrirVisor(it.id, "panelMapa");
    try { if (typeof ChatMessenger !== "undefined") ChatMessenger.limpiar(); } catch (_) {}
    const cod = it.tipo === "o" ? PedidosAdmin.codigo(it.d.codigo) : (it.d.pedido || "—");
    Chat.iniciar({
      token: it.id, soloLectura: true, puedeBorrar: true, pedido: cod, nombreRepartidor: it.rep, nombreCliente: it.nombre,
      titulo: () => "Pedido " + cod + " · " + it.nombre,
      subtitulo: () => (it.rep ? "Repartidor: " + it.rep : "Sin repartidor") + " · modo lectura"
    });
    Chat.abrir();
  }

  function iniciar() {
    if (listo) { pedirPintar(); return; }
    if (typeof mapa === "undefined" || !mapa) { setTimeout(iniciar, 600); return; }
    listo = true;
    preparar();
    const panel = g("panelCliente");
    if (panel) panel.addEventListener("click", (e) => {
      const b = e.target.closest("[data-cm]"); if (!b) return;
      const a = b.dataset.cm;
      if (a === "cerrar") cerrar(); else if (a === "factura") abrirFactura(); else if (a === "chat") espectar();
    });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { if (b.dataset.tab !== "panelMapa") cerrar(); }));
    setInterval(pedirPintar, 4000);
    pedirPintar();
  }

  /* El pin rojo/azul antiguo de solicitudes (admin.js) se reemplaza por este marcador unificado; las líneas guía se conservan. */
  if (typeof pintarSolicitudesMapa === "function" && !window.__pintarSolEnvuelto) {
    const original = pintarSolicitudesMapa;
    window.__pintarSolEnvuelto = true;
    window.pintarSolicitudesMapa = function () {
      original.apply(this, arguments);
      try {
        Object.keys(marcasSolicitud).forEach((id) => { try { mapa.removeLayer(marcasSolicitud[id]); } catch (_) {} delete marcasSolicitud[id]; });
        pedirPintar();
      } catch (_) {}
    };
  }

  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) iniciar(); else limpiar(); });
  return { iniciar, pedirPintar, pintar, abrir, cerrar, atras, quitarZoom };
})();


/* ============================================================
   FASE 1 · POLÍGONOS DE BARRIOS, REPARTOS Y COMARCAS
   Vectores sutiles casi translúcidos (no capturan toques). Se guardan en Firebase (nodo "zonas"),
   se dibujan tocando el mapa o se importan de OpenStreetMap para la vista actual.
   ============================================================ */
const ZonasMapa = (() => {
  const g = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const COLOR = { barrio: "#2E86DE", reparto: "#8E44AD", comarca: "#1E9B5A" };
  const TIPO = { barrio: "Barrio", reparto: "Reparto", comarca: "Comarca" };
  const CLAVE_VER = "admin_zonas_visibles";
  let ref = null, zonas = {}, capas = {}, visibles = true, dib = null, capaDib = null;
  try { visibles = localStorage.getItem(CLAVE_VER) !== "0"; } catch (_) {}

  const puntosDe = (z) => (Array.isArray(z && z.puntos) ? z.puntos : Object.values((z && z.puntos) || {})).filter((p) => p && isFinite(p.lat) && isFinite(p.lng));
  function centro(pts) {
    let la = 0, ln = 0; pts.forEach((p) => { la += p.lat; ln += p.lng; });
    return [la / pts.length, ln / pts.length];
  }
  function quitarCapas() { Object.keys(capas).forEach((id) => { try { mapa.removeLayer(capas[id]); } catch (_) {} delete capas[id]; }); }
  function pintar() {
    if (typeof mapa === "undefined" || !mapa) return;
    if (!mapa.getPane("paneZonas")) { const pz = mapa.createPane("paneZonas"); pz.style.zIndex = "350"; pz.style.pointerEvents = "none"; }
    quitarCapas();
    if (!visibles) return;
    Object.entries(zonas).forEach(([id, z]) => {
      const pts = puntosDe(z); if (pts.length < 3) return;
      const color = z.color || COLOR[z.tipo] || COLOR.barrio, grupo = L.layerGroup();
      L.polygon(pts.map((p) => [p.lat, p.lng]), { pane: "paneZonas", color, weight: 1.2, opacity: .45, fillColor: color, fillOpacity: .06, interactive: false, lineJoin: "round" }).addTo(grupo);
      L.marker(centro(pts), { pane: "paneZonas", interactive: false, keyboard: false, icon: L.divIcon({ className: "zn-wrap", html: `<span class="zn-etq" style="color:${color}">${esc(z.nombre || "")}</span>`, iconSize: [0, 0] }) }).addTo(grupo);
      grupo.addTo(mapa); capas[id] = grupo;
    });
  }
  function iniciar() {
    if (typeof mapa === "undefined" || !mapa) return setTimeout(iniciar, 600);
    if (ref) ref.off();
    ref = db.ref("zonas");
    ref.on("value", (s) => { zonas = s.val() || {}; pintar(); }, () => { zonas = {}; pintar(); });
  }
  function detener() { if (ref) { ref.off(); ref = null; } zonas = {}; quitarCapas(); cancelarDibujo(true); }

  /* ---------- gestor ---------- */
  function abrirGestor() {
    const ids = Object.keys(zonas).sort((a, b) => String(zonas[a].nombre || "").localeCompare(String(zonas[b].nombre || "")));
    modal(`<div class="zn-gestor"><h2>🗺️ Zonas del mapa</h2>
      <p class="ayuda">Barrios, repartos y comarcas se dibujan como áreas casi transparentes para ubicarte mejor.</p>
      <label class="zn-ver"><input id="znVer" type="checkbox" ${visibles ? "checked" : ""}> Mostrar zonas en el mapa</label>
      <div class="zn-acc"><button id="znNueva" class="primario" type="button">✏️ Dibujar zona nueva</button><button id="znOSM" type="button">📥 Importar de OpenStreetMap (vista actual)</button></div>
      <div id="znMsg" class="estado oculto" role="status"></div>
      <div class="zn-lista">${ids.length ? ids.map((id) => `<div class="zn-fila"><i style="background:${esc(zonas[id].color || COLOR[zonas[id].tipo] || COLOR.barrio)}"></i><span><strong>${esc(zonas[id].nombre || "Sin nombre")}</strong><small>${esc(TIPO[zonas[id].tipo] || "Zona")} · ${puntosDe(zonas[id]).length} puntos</small></span><button type="button" class="mini peligro" data-zdel="${esc(id)}" aria-label="Eliminar zona">🗑</button></div>`).join("") : '<p class="ayuda">Aún no hay zonas. Dibuja una o impórtalas.</p>'}</div>
      <button id="znCerrar" class="oscuro" type="button">Cerrar</button></div>`);
    g("znCerrar").onclick = cerrarModal;
    g("znVer").onchange = (e) => { visibles = e.target.checked; try { localStorage.setItem(CLAVE_VER, visibles ? "1" : "0"); } catch (_) {} pintar(); };
    g("znNueva").onclick = formularioNueva;
    g("znOSM").onclick = importarOSM;
    g("modalCaja").querySelector(".zn-lista").onclick = (e) => {
      const b = e.target.closest("button[data-zdel]"); if (!b) return;
      const z = zonas[b.dataset.zdel]; if (!z) return;
      if (!confirm("¿Eliminar la zona “" + (z.nombre || "") + "”?")) return;
      db.ref("zonas/" + b.dataset.zdel).remove().then(() => setTimeout(abrirGestor, 250)).catch((err) => toast("No se pudo eliminar: " + err.message));
    };
  }
  function msgGestor(t, error) { const m = g("znMsg"); if (!m) return; m.textContent = t || ""; m.className = "estado" + (error ? " error" : "") + (t ? "" : " oculto"); }

  /* ---------- importar de OpenStreetMap ---------- */
  async function importarOSM() {
    const b = mapa.getBounds(), caja = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`;
    if (mapa.getZoom() < 12) return msgGestor("Acerca el mapa (zoom 12 o más) para importar solo tu zona.", true);
    msgGestor("Buscando zonas en OpenStreetMap…");
    const consulta = `[out:json][timeout:25];(way["place"~"^(suburb|neighbourhood|quarter|village|hamlet|locality)$"](${caja});way["landuse"="residential"]["name"](${caja}););out geom 80;`;
    const ctl = typeof AbortController !== "undefined" ? new AbortController() : null, t = setTimeout(() => { try { ctl && ctl.abort(); } catch (_) {} }, 28000);
    try {
      const r = await fetch("https://overpass-api.de/api/interpreter", { method: "POST", body: "data=" + encodeURIComponent(consulta), headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: ctl ? ctl.signal : undefined });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json(), upd = {};
      (j.elements || []).forEach((el) => {
        const geo = (el.geometry || []).map((p) => ({ lat: +p.lat.toFixed(6), lng: +p.lon.toFixed(6) })), tags = el.tags || {};
        if (el.type !== "way" || geo.length < 4 || !tags.name) return;
        const pl = tags.place || "", tipo = /village|hamlet|locality/.test(pl) ? "comarca" : /suburb|neighbourhood|quarter/.test(pl) ? "barrio" : "reparto";
        upd["osm_" + el.id] = { nombre: String(tags.name).slice(0, 60), tipo, puntos: geo.slice(0, geo.length - 1), fuente: "osm", creado: firebase.database.ServerValue.TIMESTAMP };
      });
      const n = Object.keys(upd).length;
      if (!n) return msgGestor("OpenStreetMap no tiene zonas con nombre aquí. Usa “Dibujar zona nueva”.", true);
      await db.ref("zonas").update(upd);
      msgGestor("✓ " + n + " zona" + (n === 1 ? "" : "s") + " importada" + (n === 1 ? "" : "s") + ".");
      setTimeout(abrirGestor, 900);
    } catch (e) { msgGestor("No se pudo importar: " + (e && e.name === "AbortError" ? "tiempo agotado" : (e.message || e)), true); }
    finally { clearTimeout(t); }
  }

  /* ---------- dibujo manual ---------- */
  function formularioNueva() {
    modal(`<div class="zn-gestor"><h2>✏️ Zona nueva</h2>
      <label>Nombre <input id="znNombre" maxlength="60" autocomplete="off" placeholder="Ej. Barrio San Antonio"></label>
      <label>Tipo <select id="znTipo"><option value="barrio">Barrio</option><option value="reparto">Reparto</option><option value="comarca">Comarca</option></select></label>
      <div id="znMsg" class="estado oculto" role="status"></div>
      <button id="znEmpezar" class="primario" type="button">Marcar esquinas en el mapa</button>
      <button id="znVolver" type="button">← Volver</button></div>`);
    g("znVolver").onclick = abrirGestor;
    g("znEmpezar").onclick = () => {
      const nombre = g("znNombre").value.trim();
      if (!nombre) return msgGestor("Escribe el nombre de la zona.", true);
      cerrarModal(); empezarDibujo(nombre, g("znTipo").value);
    };
  }
  function barra(texto) {
    const b = g("barraZona"); if (!b) return;
    b.classList.toggle("oculto", !dib);
    if (dib) { g("znTxt").textContent = texto || ""; g("znOk").disabled = dib.pts.length < 3; g("znUndo").disabled = !dib.pts.length; }
  }
  function empezarDibujo(nombre, tipo) {
    dib = { nombre, tipo, pts: [] };
    if (!capaDib) capaDib = L.layerGroup().addTo(mapa);
    redibujar();
    try { NavAdmin.irA("panelMapa"); } catch (_) {}
  }
  function redibujar() {
    if (!capaDib) return;
    capaDib.clearLayers();
    if (!dib) return barra();
    const ll = dib.pts.map((p) => [p.lat, p.lng]), color = COLOR[dib.tipo] || COLOR.barrio;
    if (ll.length >= 3) L.polygon(ll, { color, weight: 2, fillColor: color, fillOpacity: .12, interactive: false }).addTo(capaDib);
    else if (ll.length === 2) L.polyline(ll, { color, weight: 2, interactive: false }).addTo(capaDib);
    ll.forEach((p) => L.circleMarker(p, { radius: 5, color: "#fff", weight: 2, fillColor: color, fillOpacity: 1, interactive: false }).addTo(capaDib));
    barra(`${dib.nombre}: ${dib.pts.length} punto${dib.pts.length === 1 ? "" : "s"} · toca el mapa para añadir esquinas`);
  }
  function capturar(ll) {
    if (!dib) return false;
    dib.pts.push({ lat: +ll.lat.toFixed(6), lng: +ll.lng.toFixed(6) });
    redibujar(); return true;
  }
  function deshacer() { if (dib && dib.pts.length) { dib.pts.pop(); redibujar(); } }
  function cancelarDibujo(silencio) {
    if (!dib) return false;
    dib = null; if (capaDib) capaDib.clearLayers();
    barra(); if (!silencio) toast("Dibujo de zona cancelado");
    return true;
  }
  async function guardarDibujo() {
    if (!dib || dib.pts.length < 3) return toast("Marca al menos 3 esquinas.");
    const z = { nombre: dib.nombre, tipo: dib.tipo, puntos: dib.pts, creado: firebase.database.ServerValue.TIMESTAMP };
    try { await db.ref("zonas").push(z); cancelarDibujo(true); toast("Zona guardada ✓"); }
    catch (e) { toast("No se pudo guardar: " + (e.code || e.message)); }
  }
  function atras() { return cancelarDibujo(false); }

  (function enlazar() {
    const b = g("btnZonas"); if (b) b.onclick = abrirGestor;
    const u = g("znUndo"), o = g("znOk"), c = g("znCancel");
    if (u) u.onclick = deshacer; if (o) o.onclick = guardarDibujo; if (c) c.onclick = () => cancelarDibujo(false);
  })();
  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) iniciar(); else detener(); });
  return { iniciar, detener, capturar, atras, abrirGestor };
})();


/* ============================================================
   FASE 2 · AVISOS DE CHAT INTEGRADOS EN LA BANDEJA
   El mensaje nuevo de un repartidor aparece dentro de la bandeja de Chats (arriba de la lista),
   con su foto de perfil, y no como aviso flotante en la esquina. Si el admin está en otra pestaña,
   la pestaña "Chats" muestra el contador y el aviso lo espera en la bandeja.
   ============================================================ */
const ChatBandeja = (() => {
  const g = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const avisos = new Map();   // clave → { uid, nombre, texto, n, abrir, ts }
  let ref = null, primera = true, previo = {};

  function pintar() {
    const caja = g("bannerChatBandeja"), badge = g("chatsBadge");
    const total = [...avisos.values()].reduce((t, a) => t + a.n, 0);
    if (badge) { badge.textContent = String(total); badge.classList.toggle("oculto", !total); }
    if (!caja) return;
    const lista = [...avisos.entries()].sort((a, b) => b[1].ts - a[1].ts).slice(0, 4);
    caja.innerHTML = lista.map(([k, a]) => `<div class="cb-aviso" data-k="${esc(k)}" role="button" tabindex="0" aria-label="Abrir chat con ${esc(a.nombre)}">
        <span class="avatar" data-av="${esc(a.uid)}">${typeof RIDER_SVG !== "undefined" ? RIDER_SVG : "🛵"}</span>
        <div class="cb-txt"><strong>${esc(a.nombre)}</strong><small>${esc(a.texto || "Mensaje nuevo")}</small></div>
        ${a.n > 1 ? `<span class="cb-mas">${a.n}</span>` : ""}
        <button type="button" class="cb-x" data-x="${esc(k)}" aria-label="Descartar aviso">✕</button></div>`).join("");
    try { aplicarFotosAvatares(); } catch (_) {}
  }
  function aviso(a) {
    const previoA = avisos.get(a.clave);
    avisos.set(a.clave, { uid: a.uid, nombre: a.nombre, texto: a.texto, abrir: a.abrir, n: (previoA ? previoA.n : 0) + 1, ts: Date.now() });
    pintar();
  }
  function quitar(k) { if (avisos.delete(k)) pintar(); }

  function escuchar() {
    if (ref) ref.off();
    primera = true; previo = {};
    ref = db.ref("chatsEquipoResumen");
    ref.on("value", (s) => {
      const n = s.val() || {};
      Object.entries(n).forEach(([uid, r]) => {
        if (!primera && r.ultimoDe === "repartidor" && (r.ts || 0) > ((previo[uid] && previo[uid].ts) || 0) && (typeof chatEqAbierto === "undefined" || chatEqAbierto !== uid)) {
          aviso({ clave: "eq:" + uid, uid, nombre: nombreUid(uid), texto: r.ultimo || "", abrir: () => abrirChatRep(uid) });
        }
        if (r.ultimoDe === "admin") quitar("eq:" + uid);   // ya respondiste: el aviso deja de tener sentido
      });
      primera = false; previo = n;
    }, () => {});
  }
  function detener() { if (ref) { ref.off(); ref = null; } avisos.clear(); pintar(); }

  const caja = g("bannerChatBandeja");
  if (caja) {
    const abrirDe = (e) => {
      const x = e.target.closest("[data-x]");
      if (x) { quitar(x.dataset.x); return; }
      const f = e.target.closest(".cb-aviso"); if (!f) return;
      const a = avisos.get(f.dataset.k); quitar(f.dataset.k);
      if (a && a.abrir) a.abrir();
    };
    caja.addEventListener("click", abrirDe);
    caja.addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("cb-aviso")) { e.preventDefault(); abrirDe(e); } });
  }
  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) escuchar(); else detener(); });
  return { aviso, quitar };
})();


/* ============================================================
   FASE 2 · RENDIMIENTO E INGRESOS POR REPARTIDOR (pestaña Equipo)
   Fuente: contabilidad/{uid}/* (un registro por pedido cobrado, sin importar el origen).
   Modelo: deducción fija por pedido (C$ 7 / 14 / 21 según el rango de precio + C$ 7 por cada IVA extra)
           → remanente (bolsa) → 30 % para Brother’s y 70 % para el repartidor.
   Entregar a Brother’s = Σ deducciones fijas + Σ 30 % de comisión (todas las fuentes unidas).
   ============================================================ */
const RendimientoEquipo = (() => {
  const g = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const hayNum = (n) => typeof n === "number" && isFinite(n);
  const num = (n) => (hayNum(n) ? n : Number(n) || 0);
  const r2 = (n) => Math.round(num(n) * 100) / 100;
  const dinero = (n) => "C$ " + r2(n).toFixed(2);
  const PCT_BROTHERS = 0.3, IVA = 7;
  const refs = {}, datos = {};        // uid → ref / registros
  let rango = 30, timer = null, tPintar = null, activo = false;

  const desdeFecha = () => {
    if (!rango) return "";
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (rango - 1));
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  };
  const fuenteDe = (o) => (o === "manual" ? "wa" : o === "chat" ? "app" : "admin");   // admin + invitado → Admin

  function calcular(recs) {
    const t = { n: 0, admin: 0, wa: 0, app: 0, bruto: 0, fijo: 0, ivaN: 0, ivaMonto: 0, d7: 0, d14: 0, d21: 0, dOtro: 0, bolsa: 0, brothers30: 0, rep70: 0 };
    recs.forEach((r) => {
      if (!r || typeof r !== "object") return;
      const fijo = num(r.fijo), bruto = num(r.bruto);
      const bolsa = hayNum(r.bolsa) ? r.bolsa : Math.max(0, bruto - fijo);
      const ivaMonto = num(r.ivasMonto) || num(r.ivasExtras) * IVA;
      const base = hayNum(r.fijoBase) ? r.fijoBase : Math.max(0, fijo - ivaMonto);
      const com = r2(bolsa * PCT_BROTHERS);
      t.n++; t[fuenteDe(r.origen)]++;
      t.bruto += bruto; t.fijo += fijo; t.bolsa += bolsa; t.brothers30 += com; t.rep70 += r2(bolsa - com);
      t.ivaMonto += ivaMonto; t.ivaN += Math.round(ivaMonto / IVA);
      const b = Math.round(base);
      if (b === 7) t.d7++; else if (b === 14) t.d14++; else if (b === 21) t.d21++; else t.dOtro++;
    });
    t.entregar = r2(t.fijo + t.brothers30);
    return t;
  }

  function tarjeta(titulo, sub, uid, t, esTotal) {
    const av = uid ? `<span class="avatar" data-av="${esc(uid)}">${typeof RIDER_SVG !== "undefined" ? RIDER_SVG : "🛵"}</span>` : '<span class="avatar" aria-hidden="true">👥</span>';
    const conteo = [t.d7 ? `C$ 7 × ${t.d7}` : "", t.d14 ? `C$ 14 × ${t.d14}` : "", t.d21 ? `C$ 21 × ${t.d21}` : "", t.dOtro ? `otras × ${t.dOtro}` : "", t.ivaN ? `IVA extra (C$ 7) × ${t.ivaN}` : ""].filter(Boolean).join(" · ") || "Sin deducciones";
    return `<div class="rd-tarjeta${esTotal ? " total" : ""}">
      <div class="rd-cab">${av}<div><strong>${esc(titulo)}</strong><small>${esc(sub)}</small></div><span class="rd-n" title="Pedidos realizados">${t.n}</span></div>
      <div class="rd-orig"><div><b>${t.admin}</b><small>🛡️ Admin</small></div><div><b>${t.wa}</b><small>💬 WhatsApp / Factura manual</small></div><div><b>${t.app}</b><small>📱 App Cliente</small></div></div>
      <div class="rd-filas">
        <div class="rd-fila"><span>Ingresos brutos (delivery + mandados)</span><b>${dinero(t.bruto)}</b></div>
        <div class="rd-fila"><span>− Deducciones fijas</span><b>${dinero(t.fijo)}</b></div>
        <div class="rd-fila sub"><span>${esc(conteo)}</span></div>
        <div class="rd-fila fuerte"><span>Remanente a repartir</span><b>${dinero(t.bolsa)}</b></div>
        <div class="rd-fila"><span>30 % comisión Brother’s</span><b>${dinero(t.brothers30)}</b></div>
        <div class="rd-fila"><span>70 % neto del repartidor</span><b>${dinero(t.rep70)}</b></div>
      </div>
      <div class="rd-entrega"><span>💵 Entregar a Brother’s<br><small>Deducciones fijas + 30 % acumulado</small></span><b>${dinero(t.entregar)}</b></div>
    </div>`;
  }

  function pintar() {
    const caja = g("rendLista"); if (!caja) return;
    const uids = Object.keys(typeof registrados !== "undefined" ? registrados : {}).sort((a, b) => nombreUid(a).localeCompare(nombreUid(b)));
    if (!uids.length) { caja.innerHTML = '<div class="rd-vacio">Aún no hay repartidores en el equipo.</div>'; return; }
    const todos = [], tarjetas = uids.map((uid) => {
      const recs = Object.values(datos[uid] || {}); todos.push(...recs);
      return tarjeta(nombreUid(uid), recs.length ? "Pedidos realizados en el periodo" : "Sin pedidos en el periodo", uid, calcular(recs), false);
    });
    const total = tarjeta("Total del equipo", "Todas las fuentes unificadas", "", calcular(todos), true);
    caja.innerHTML = total + tarjetas.join("");
    try { aplicarFotosAvatares(); } catch (_) {}
  }
  function pedirPintar() { if (tPintar) return; tPintar = setTimeout(() => { tPintar = null; pintar(); }, 150); }

  function suscribir(uid) {
    if (refs[uid]) return;
    const d = desdeFecha();
    const q = d ? db.ref("contabilidad/" + uid).orderByChild("fecha").startAt(d) : db.ref("contabilidad/" + uid);
    refs[uid] = q;
    q.on("value", (s) => { datos[uid] = s.val() || {}; pedirPintar(); }, () => { datos[uid] = {}; pedirPintar(); });
  }
  function soltarTodo() { Object.keys(refs).forEach((u) => { try { refs[u].off(); } catch (_) {} delete refs[u]; }); Object.keys(datos).forEach((u) => delete datos[u]); }
  function sincronizar() {
    if (!activo || typeof registrados === "undefined") return;
    const uids = Object.keys(registrados);
    uids.forEach(suscribir);
    Object.keys(refs).forEach((u) => { if (uids.indexOf(u) < 0) { try { refs[u].off(); } catch (_) {} delete refs[u]; delete datos[u]; } });
    pedirPintar();
  }
  function iniciar() { activo = true; sincronizar(); clearInterval(timer); timer = setInterval(sincronizar, 5000); }
  function detener() { activo = false; clearInterval(timer); soltarTodo(); const c = g("rendLista"); if (c) c.innerHTML = ""; }

  const sel = g("rendRango");
  if (sel) sel.addEventListener("change", () => { rango = Number(sel.value) || 0; soltarTodo(); sincronizar(); });
  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) iniciar(); else detener(); });
  return { iniciar, detener, calcular };
})();


/* ============================================================
   FASE 3 · ALERTAS PUSH DE ALTA PRIORIDAD (lado página) + VOZ
   sw.js muestra el banner (pantalla encendida, vibración) con la app cerrada o en segundo plano y avisa a la página
   (PUSH_RECIBIDO). Con la app abierta: vibración + voz "Hay una solicitud de pedido".
   ============================================================ */
const AlertasPush = (() => {
  const FRASE = "Hay una solicitud de pedido";
  try {
    if (typeof Voz !== "undefined" && Voz && typeof Voz.alertaPedido !== "function") {
      Voz.alertaPedido = () => {
        try { if (typeof Voz.hablar === "function") return Voz.hablar(FRASE, { forzar: true }); } catch (_) {}
        try { const u = new SpeechSynthesisUtterance(FRASE); u.lang = "es-MX"; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (_) {}
      };
    }
  } catch (_) {}
  window.addEventListener("push-admin-recibido", () => { try { if (navigator.vibrate) navigator.vibrate([300, 120, 300, 120, 500]); } catch (_) {} });
  return { FRASE };
})();
