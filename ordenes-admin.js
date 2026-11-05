/* ============================================================
   ORDENES-ADMIN · Funciones 1 y 2 del panel de administración
   1) Toque en el mapa → modal para elegir repartidor activo y punto Retiro/Entrega
   2) Pestaña "Pedidos": formulario, asignación (registrado o enlace de invitado) y estado en vivo
   3) Auditoría de facturas: al tocar el marcador de un repartidor en el mapa (o su tarjeta / el botón 🧾 Facturas) se abre la factura
      exacta y en vivo que lleva (productos, delivery, prioridad, mandados extra y total), leída de pedidos/{token}.
   Se carga DESPUÉS de admin.js y usa sus globales (db, mapa, ubic, registrados, toast, modal…).
   ============================================================ */
const PedidosAdmin = (() => {
  const O = Ordenes, esc = O.esc, el = (id) => document.getElementById(id);
  let ordenes = {}, ref = null, primera = true, listo = false;
  let tempMarca = null, timerClick = null, popupCerrado = 0, busqAbierta = false, ovl = null;
  let avisoToken = null;   // pedido del aviso "enviado a …" del formulario: se quita cuando ese pedido termina
  let regSel = "", creando = false, firmaSel = "";   // repartidor elegido (sobrevive a repintados) y candado anti doble envío
  let refChatInv = null, resInv = {}, primeraInv = true, sinLeerInv = {}, chatInvAbierto = null;   // chat Admin ↔ invitado
  const RUTA_INV = { chats: "chatsInvitado", resumen: "chatsInvitadoResumen", fotos: "fotosInvitado", leido: "leidosInvitado" };
  const nuevoRetiro = () => ({ texto: "", ll: null, producto: "" }), nuevaEntrega = () => ({ texto: "", ll: null, tipo: "entrega", nota: "" });
  let retirosForm = [nuevoRetiro()];     // varios retiros, cada uno con su producto
  let entregasForm = [nuevaEntrega()];   // la 1.ª es la entrega principal; las demás son entregas o cobros extra
  let modoAsig = "registrado";

  /* ---------- Utilidades ---------- */
  /* Código tal como se VE en pantalla: pedido hecho desde la app → APP12345 (en Firebase sigue guardado como BD12345) */
  const cod = (c) => { const d = String(c == null ? "" : c).replace(/\D/g, ""); return d ? "APP" + d.padStart(5, "0") : String(c == null ? "" : c); };
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
        if (typeof PushAdmin !== "undefined") PushAdmin.punto(uid, punto);   // push al celular del repartidor
        cerrarModal();
        toast(`${O.PUNTOS[punto].icono} ${O.PUNTOS[punto].nombre} enviado a ${nombreUid(uid)} ✓ Su ruta se traza sola.`);
      } catch (err) { toast("No se pudo asignar: " + err.message); el("pdAsignar").disabled = false; }
    };
  }

  /* ============================================================
     2) PEDIDOS Y REPARTIDORES INVITADOS
     ============================================================ */
  const okLL = (ll) => !!ll && typeof ll.lat === "number" && typeof ll.lng === "number";
  const hitLugar = (v) => { const n = (x) => String(x || "").toLowerCase().trim(); return Object.values(lugares).find((l) => n(l.nombre) === n(v) && typeof l.lat === "number"); };
  const lista = (cual) => (cual === "retiro" ? retirosForm : entregasForm);
  const esCobro = (cual, p) => cual === "entrega" && !!p && p.tipo === "cobro";
  const icono = (cual, p) => (cual === "retiro" ? "📦" : esCobro(cual, p) ? "💵" : "🏠");
  const etiqueta = (cual, i) => { const n = lista(cual).length; return (cual === "retiro" ? "Retiro" : esCobro(cual, lista(cual)[i]) ? "Cobro" : "Entrega") + (n > 1 ? " " + (i + 1) : ""); };
  const textoPunto = (p) => p.texto.trim() || (okLL(p.ll) ? `Punto del mapa (${p.ll.lat.toFixed(5)}, ${p.ll.lng.toFixed(5)})` : "");
  const tieneLugar = (p) => !!p.texto.trim() || okLL(p.ll);

  /* ---------- Tarjeta única "Lugar de Retiro y Entrega" (resumen; el punto y la dirección se editan en el mapa) ---------- */
  function pintarLugares() {
    const fila = (cual, i, p) => {
      const t = textoPunto(p), det = cual === "entrega" && (p.nota || "").trim() ? " · " + p.nota.trim() : "";
      const est = okLL(p.ll) ? ["ok", "✓ En el mapa"] : p.texto.trim() ? ["med", "Solo dirección"] : ["no", "Pendiente"];
      return `<div class="pdl-fila ${cual}" data-k="${cual}" data-i="${i}">
        <button type="button" class="pdl-pt" data-a="mapa" aria-label="Fijar ${esc(etiqueta(cual, i))} en el mapa">
          <span class="pdl-ico" aria-hidden="true">${icono(cual, p)}</span>
          <span class="pdl-txt"><b>${esc(etiqueta(cual, i))}</b><small>${esc((t || "Toca para fijar en el mapa (dirección opcional)") + det)}</small></span>
          <span class="pdl-est ${est[0]}">${est[1]}</span>
        </button>
        ${cual === "retiro" ? `<input data-f="producto" maxlength="120" autocomplete="off" placeholder="Producto a retirar aquí (ej. 2 pizzas medianas)" aria-label="Producto a retirar en ${esc(etiqueta(cual, i))}" value="${esc(p.producto)}">` : ""}
      </div>`;
    };
    el("pdLista").innerHTML = retirosForm.map((p, i) => fila("retiro", i, p)).join("") + entregasForm.map((p, i) => fila("entrega", i, p)).join("");
  }
  function añadir(cual) { lista(cual).push(cual === "retiro" ? nuevoRetiro() : nuevaEntrega()); pintarLugares(); return lista(cual).length - 1; }

  /* ---------- Burbujas de coincidencias con los negocios guardados ---------- */
  const norm = (x) => String(x || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  function coincidencias(v) {
    const q = norm(v); if (!q) return [];
    const ts = q.split(/\s+/), validos = Object.entries(lugares).filter(([, l]) => l && l.nombre && typeof l.lat === "number");
    const porNombre = (a, b) => a[1].nombre.localeCompare(b[1].nombre, "es", { sensitivity: "base" });
    const empieza = validos.filter(([, l]) => norm(l.nombre).startsWith(q)).sort(porNombre);   // "M" → Mil Sabores, Mercado…
    const resto = validos.filter(([id, l]) => !empieza.some((e) => e[0] === id) && (() => { const pal = norm(l.nombre).split(/\s+/); return ts.every((t) => pal.some((w) => w.startsWith(t))); })()).sort(porNombre);   // "sab" → Mil Sabores
    return empieza.concat(resto).slice(0, 12);
  }
  function mostrarSug(box, v) {
    if (!box) return;
    const q = norm(v), l = coincidencias(v);
    if (!l.length) { box.classList.add("oculto"); box.innerHTML = ""; return; }
    const nombreHtml = (n) => {   // resalta en negrita lo que ya escribiste cuando el nombre empieza así
      const k = String(v || "").trim().length;
      return k && norm(n.slice(0, k)) === q ? `<b>${esc(n.slice(0, k))}</b>${esc(n.slice(k))}` : esc(n);
    };
    box.innerHTML = l.map(([id, x]) => `<button type="button" class="pdm-burb" data-lid="${esc(id)}"><span>${esc(x.icono || "🏪")}</span><span class="pdm-bn">${nombreHtml(x.nombre)}</span>${x.dir ? `<small>${esc(x.dir)}</small>` : ""}</button>`).join("");
    box.classList.remove("oculto");
    box.scrollTop = 0;
  }

  /* ============================================================
     MAPA DEL FORMULARIO (pantalla completa, instancia aparte, sin negocios ni repartidores)
     Arriba: Retiro / Entrega (y los extras). Al tocar uno: tocas el mapa para fijarlo, escribes una
     dirección (opcional) y puedes cancelar esa ubicación y dirección. Abajo: añadir más lugares.
     ============================================================ */
  const fmtKm = (m) => (m / 1000).toFixed(1) + " km";
  const fmtEta = (s) => { const mi = Math.max(1, Math.round(s / 60)); return mi >= 60 ? Math.floor(mi / 60) + " h " + (mi % 60) + " min" : mi + " min"; };
  function puntosForm() {   // orden de la ruta: primero todos los retiros, luego las entregas
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
    const m = L.map(g("pdOvlMapa"), { zoomControl: false }).setView(mapa ? mapa.getCenter() : [-12.0464, -77.0428], mapa ? Math.max(mapa.getZoom(), 13) : 14);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(m);
    const idx = Math.min(Math.max(+i || 0, 0), lista(cual).length - 1);
    ovl = { div, m, capa: L.layerGroup().addTo(m), rutaCapa: L.layerGroup().addTo(m), activo: { cual, i: idx }, ult: { retiro: 0, entrega: 0 }, seq: 0 };
    ovl.ult[cual] = idx;
    const info = (t) => { const e = g("pdOvlInfo"); if (e) e.innerHTML = t; };
    const act = () => lista(ovl.activo.cual)[ovl.activo.i];
    const ir = (c, k) => { ovl.activo = { cual: c, i: k }; ovl.ult[c] = k; };

    function titulo() {   // el panel solo ofrece lo que corresponde al grupo elegido (Retiro o Entrega)
      const a = ovl.activo, p = act(), extra = a.cual === "entrega" && a.i > 0;
      g("pdmEdT").textContent = `${icono(a.cual, p)} ${etiqueta(a.cual, a.i)} · ` + (okLL(p.ll) ? "ubicación fijada (toca el mapa para moverla)" : "toca el mapa para fijar la ubicación");
      g("pdmDir").placeholder = a.cual === "retiro" ? "Dirección o negocio de retiro (opcional)" : esCobro(a.cual, p) ? "Dirección del lugar de cobro (opcional)" : "Dirección de entrega (opcional)";
      g("pdmAdd").textContent = a.cual === "retiro" ? "➕ Otro retiro" : "➕ Otra entrega o cobro";
      g("pdmQuitar").textContent = a.i > 0 ? `🗑 Quitar ${etiqueta(a.cual, a.i)}` : "🗑 Cancelar ubicación y dirección";
      g("pdmDet").classList.toggle("oculto", !extra);   // entrega o cobro extra: se detalla qué debe hacer el repartidor
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
        if (ovl !== mio || seq !== mio.seq) return;   // se cerró o cambió un punto mientras calculaba
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
      g("pdmSub").classList.toggle("oculto", l.length < 2);   // numeración solo del grupo elegido
      g("pdmSub").innerHTML = l.map((p, k) => `<button type="button" data-i="${k}" class="${k === a.i ? "on" : ""}">${icono(a.cual, p)} ${esc(etiqueta(a.cual, k))}${okLL(p.ll) ? " ✓" : ""}</button>`).join("");
      ps.forEach((q) => {   // los puntos del otro grupo se ven atenuados: solo se editan los del grupo elegido
        if (okLL(q.p.ll)) L.marker([q.p.ll.lat, q.p.ll.lng], { icon: O.pinIcono(q.cual, icono(q.cual, q.p)), opacity: q.cual === a.cual ? 1 : .4, zIndexOffset: q.cual === a.cual && q.i === a.i ? 800 : 0 }).addTo(ovl.capa);
      });
      titulo();
      trazar(encuadrar);
    }
    const mas = (c) => { const n = añadir(c); ir(c, n); cargarEditor(); dibujar(false); };

    g("pdmTabs").onclick = (e) => {   // Retiro ↔ Entrega
      const b = e.target.closest("button[data-g]"); if (!b) return;
      const c = b.dataset.g; ir(c, Math.min(ovl.ult[c], lista(c).length - 1));
      cargarEditor(); dibujar(false);
      const p = act(); if (okLL(p.ll)) m.panTo([p.ll.lat, p.ll.lng]);
    };
    g("pdmSub").onclick = (e) => {   // Retiro 1, Retiro 2… / Entrega 1, Cobro 2…
      const b = e.target.closest("button[data-i]"); if (!b) return;
      ir(ovl.activo.cual, +b.dataset.i);
      cargarEditor(); dibujar(false);
      const p = act(); if (okLL(p.ll)) m.panTo([p.ll.lat, p.ll.lng]);
    };
    m.on("click", (e) => {   // fija (o mueve) solo el punto del lugar elegido
      const p = act(); p.ll = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) }; p.auto = false;
      dibujar(false);
    });
    g("pdmDir").addEventListener("input", (e) => {   // dirección opcional; si coincide con un negocio guardado, fija su ubicación
      const p = act(), v = e.target.value; p.texto = v;
      const hit = hitLugar(v);
      if (hit) { p.ll = { lat: hit.lat, lng: hit.lng }; p.auto = true; mostrarSug(g("pdmSug"), ""); dibujar(false); m.setView([hit.lat, hit.lng], Math.max(m.getZoom(), 16)); return; }
      if (p.auto) { p.ll = null; p.auto = false; dibujar(false); }   // ya no coincide con el negocio: se suelta su ubicación
      mostrarSug(g("pdmSug"), v);
    });
    g("pdmDir").addEventListener("focus", () => { const p = act(); if (!okLL(p.ll) && p.texto.trim()) mostrarSug(g("pdmSug"), p.texto); });
    g("pdmSug").onclick = (e) => {
      const b = e.target.closest("button[data-lid]"), l = b && lugares[b.dataset.lid]; if (!l) return;
      const p = act(); p.texto = l.nombre; p.ll = { lat: l.lat, lng: l.lng }; p.auto = true;
      g("pdmDir").value = l.nombre; mostrarSug(g("pdmSug"), "");
      dibujar(false); m.setView([l.lat, l.lng], Math.max(m.getZoom(), 16));
    };
    g("pdmTipo").onclick = (e) => {   // otra entrega o lugar de cobro
      const b = e.target.closest("button[data-t]"); if (!b) return;
      act().tipo = b.dataset.t === "cobro" ? "cobro" : "entrega";
      dibujar(false);
    };
    g("pdmNota").addEventListener("input", (e) => { act().nota = e.target.value; });
    g("pdmQuitar").onclick = () => {   // cancelar ubicación y dirección (en los lugares extra, quita el lugar completo)
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
    document.querySelectorAll("#panelPedidos .pd-iva-campo").forEach((c) => c.classList.toggle("oculto", m !== "registrado"));   // el IVA solo aplica con repartidor registrado
    el("pdCrear").textContent = m === "invitado" ? "Crear pedido y generar enlace" : "Crear y asignar pedido";
    pintarTotalDelivery();
  }

  /* ---------- IVA automático ----------
     Delivery 35 a 190  → IVA base 7
     Delivery 200 a 300 → IVA base 14
     (lo que cae entre 190 y 200 se trata como del primer tramo; fuera de 35–300 el IVA base es 0).
     El IVA base se puede corregir a mano; "IVA extra" se suma encima. Total = delivery + IVA base + IVA extra. */
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
  function alEscribirDelivery() {   // cada cambio del delivery recalcula el IVA base (sobrescribe un ajuste manual anterior)
    const raw = el("pdDelivery").value;
    el("pdIvaBase").value = raw === "" ? "" : String(ivaBaseAuto(n2(raw)));
    pintarTotalDelivery();
  }

  /* Mensaje visible dentro de la pestaña Pedidos (el toast vive en el mapa y ahí no se ve) */
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
    const extras = entregas.slice(1);   // la 1.ª entrega es la principal; las demás (entrega o cobro) viajan también en los detalles del paquete para que el repartidor sepa qué hacer
    const linea = (x, n) => `${x.tipo === "cobro" ? "💵 Lugar de cobro" : "🏠 Entrega"} ${n}: ${x.texto}${x.nota ? " — " + x.nota : ""}${typeof x.lat === "number" ? " https://www.google.com/maps?q=" + x.lat + "," + x.lng : ""}`;
    const lineas = extras.map((x, k) => linea(x, k + 2));
    if (entregas[0].tipo === "cobro" || entregas[0].nota) lineas.unshift(linea(entregas[0], 1));
    const paquete = [el("pdPaquete").value.trim()].concat(lineas).filter(Boolean).join("\n");
    let asignacion;
    if (modoAsig === "registrado") {
      const uid = regSel || el("pdRegSel").value;
      if (!uid) return falla("Elige un repartidor registrado, o cambia a “Enlace de invitado”.");
      asignacion = { tipo: "registrado", uid, nombre: nombreUid(uid) };
    } else asignacion = { tipo: "invitado" };
    creando = true; el("pdCrear").disabled = true; aviso("Creando pedido…", "ok");
    const tot = totalForm();   // delivery + IVA base + IVA extra (el repartidor ve el total; "iva" guarda la suma)
    try {
      // JSON ida y vuelta: Firebase rechaza los valores "undefined" y haría fallar la escritura completa
      const datos = JSON.parse(JSON.stringify({
        cliente, paquete, retiros, delivery: tot.d,
        iva: asignacion.tipo === "registrado" ? tot.iva : 0,
        entrega: principal, entregasExtra: extras, asignacion
      }));
      const { token, orden } = await O.crear(db, datos);
      if (extras.length) db.ref("ordenes/" + token + "/entregasExtra").set(extras).catch(() => {});   // por si O.crear no guarda campos extra
      ["pdCliente", "pdPaquete", "pdDelivery", "pdIvaBase"].forEach((id) => { el(id).value = ""; }); el("pdIvaExtra").value = "0"; pintarTotalDelivery();
      retirosForm = [nuevoRetiro()]; entregasForm = [nuevaEntrega()]; pintarLugares();
      if (asignacion.tipo === "invitado") { aviso(""); mostrarEnlaces(token, orden); }
      else {
        const t = `Pedido ${cod(orden.codigo)} enviado a ${asignacion.nombre} ✓ (${O.textoDelivery(orden)})` + (O.valido(orden.retiros[0]) ? " y su ruta al primer retiro." : ".");
        aviso(t, "ok"); avisoToken = token; toast(t);
        if (typeof PushAdmin !== "undefined") PushAdmin.pedidoAsignado(asignacion.uid, Object.assign({ token }, orden));   // push al celular del repartidor
      }
    } catch (err) {
      console.error("crearPedido", err);
      falla("No se pudo crear el pedido: " + ((err && (err.code ? err.code + " · " : "") + err.message) || err) + (err && err.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : ""));
    } finally { creando = false; el("pdCrear").disabled = false; }
  }

  function mostrarEnlaces(t, o) {
    const li = O.urlInvitado(t), lc = O.urlCliente(t);
    modal(`<h2>🔗 Enlace de invitado</h2>
      <p class="ayuda">Pedido <b>${esc(cod(o.codigo))}</b> · ${esc(o.cliente)}. Envía este enlace a quien hará la entrega: solo tendrá que escribir su nombre.</p>
      <div class="pd-enlace">${esc(li)}</div>
      <button id="pdCopiarInv" class="primario" type="button">📋 Copiar enlace del invitado</button>
      <button id="pdWaInv" class="whatsapp" type="button">Enviar por WhatsApp</button>
      <p class="ayuda">Enlace del cliente (seguimiento + chat con el invitado):</p>
      <div class="pd-enlace">${esc(lc)}</div>
      <button id="pdCopiarCli" type="button">📋 Copiar enlace del cliente</button>
      <button id="pdCerrarEnl" class="oscuro" type="button">Listo</button>`);
    el("pdCopiarInv").onclick = () => copiar(li);
    el("pdCopiarCli").onclick = () => copiar(lc);
    el("pdWaInv").onclick = () => wa(`🛵 Brother’s Deliverys · Pedido ${cod(o.codigo)}\nAbre este enlace, escribe tu nombre y sigue la ruta:\n${li}`);
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
        await db.ref("ordenes/" + t).update({ estado_asignacion: "pendiente" });   // el nuevo repartidor debe aceptar de nuevo
        cerrarModal(); toast(`Asignado a ${nombreUid(uid)} ✓`);
        if (typeof PushAdmin !== "undefined") PushAdmin.pedidoAsignado(uid, Object.assign({ token: t }, o));   // push al celular del repartidor
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

  function tarjeta(t) {
    const o = ordenes[t], [txt, cls] = O.ESTADOS[o.estado] || O.ESTADOS.pendiente, a = o.asignacion || {};
    const inv = a.tipo === "invitado", btn = (acc, label, extra) => `<button class="mini ${extra || ""}" data-pa="${acc}" data-t="${esc(t)}" type="button">${label}</button>`;
    return `<div class="tarjeta-rep pd-orden">
      <div class="fila"><div class="datos"><strong>${esc(cod(o.codigo))} · ${esc(o.cliente || "Sin nombre")}</strong>
        <small>👤 ${esc(nombreOrden(o))}${inv ? ' <i class="pd-tag">Invitado</i>' : ""}</small></div><span class="chip ${cls}">${txt}</span></div>
      <div class="ruta">${O.paradas(o).map((p, k) => `${p.retirado ? "✅" : "📦"} ${O.paradas(o).length > 1 ? "Retiro " + (k + 1) + ": " : ""}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}`).join("<br>")}<br>🏠 ${esc((o.entrega && o.entrega.texto) || "—")}${o.delivery || o.iva ? "<br>🛵 Delivery: <b>" + O.textoDelivery(o) + "</b>" : ""}${o.paquete ? "<br>📝 " + esc(o.paquete) : ""}${a.tipo === "registrado" && activa(o) ? (o.estado_asignacion === "aceptado" ? "<br>✅ Aceptado por el repartidor" : o.estado_asignacion === "rechazado" ? "<br>❌ Rechazado por el repartidor" : o.estado === "asignado" ? "<br>⏳ Esperando respuesta del repartidor" : "") : ""}</div>
      <div class="acciones-fila" style="flex-wrap:wrap">
        ${inv && activa(o) ? btn("linkinv", "🔗 Enlace invitado") : ""}${inv && a.nombre && activa(o) ? btn("chatinv", "🗨 Chat invitado" + (sinLeerInv[t] ? " (" + sinLeerInv[t] + ")" : "")) : ""}${a.tipo && activa(o) ? btn("linkcli", "💬 Enlace cliente") : ""}${a.tipo && activa(o) ? btn("factura", "🧾 Factura", "pri") : ""}${inv && activa(o) ? btn("recorrido", "🗺 Recorrido") : ""}
        ${(o.estado === "pendiente" && !a.tipo) || (o.estado_asignacion === "rechazado" && activa(o)) ? btn("asignar", o.estado_asignacion === "rechazado" ? "Reasignar" : "Asignar", "pri") : ""}
        ${activa(o) ? btn("cancelar", "Cancelar", "peligro") : btn("borrar", "Eliminar", "peligro")}
      </div></div>`;
  }
  function pintarOrdenes() {
    const ids = Object.keys(ordenes).sort((a, b) => (ordenes[b].creado || 0) - (ordenes[a].creado || 0));
    el("listaPedidos").innerHTML = ids.length ? ids.map(tarjeta).join("") : '<p class="ayuda">Aún no hay pedidos. Crea el primero arriba.</p>';
    const c = el("pdCuenta"); if (c) c.textContent = ids.length;
    pintarTodosRecInv();   // pines de recogida/entrega y recorrido de los invitados en el mapa
  }

  /* ---------- Chat Admin ↔ repartidor invitado (nodo chatsInvitado/{token}) ---------- */
  function abrirChatInv(t) {
    const o = ordenes[t]; if (!o) return;
    const nom = (o.asignacion && o.asignacion.nombre) || "Invitado";
    chatInvAbierto = t; sinLeerInv[t] = 0; pintarOrdenes();
    Chat.iniciar({
      token: t, yo: "admin", ruta: RUTA_INV, pedido: o.codigo, nombreRepartidor: nom, puedeBorrar: true, avisos: false,
      titulo: () => "Chat con " + nom, subtitulo: () => "Pedido " + cod(o.codigo) + " · invitado",
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
      <p>El repartidor <b>${esc(quien)}</b> rechazó el pedido <b>${esc(cod(o.codigo))}</b>${o.cliente ? " (" + esc(o.cliente) + ")" : ""}.</p>
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
        if (resp === "aceptado") decir(`✅ El repartidor ${quien} aceptó el pedido ${cod(o.codigo)}`);
        else { decir(`❌ El repartidor ${quien} rechazó el pedido ${cod(o.codigo)}`); alertaRechazo(t, o, quien); }
      }
      const nom = (o.asignacion && o.asignacion.nombre) || "El repartidor", pa = O.paradas(a), po = O.paradas(o);
      if (o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && !(a.asignacion && a.asignacion.nombre)) decir(`🔗 ${nom} aceptó el pedido ${cod(o.codigo)}`);
      po.forEach((p, k) => {
        if (!p.retirado || (pa[k] && pa[k].retirado)) return;   // solo retiros nuevos
        const falta = po.filter((x) => !x.retirado).length;
        decir(`📦 ${nom} ya retiró ${p.producto ? p.producto : "un producto"}${p.texto ? " en " + p.texto : ""}. ${falta ? "Faltan " + falta + " retiro" + (falta > 1 ? "s" : "") + " del pedido " + cod(o.codigo) : "Pedido " + cod(o.codigo) + " completo, va hacia el cliente"}`);
      });
      if (o.estado !== a.estado && o.estado === "entregado") decir(`✅ ${nom} entregó el pedido ${cod(o.codigo)}`);
      if (o.estado !== a.estado && (o.estado === "entregado" || o.estado === "cancelado") && t === avisoToken) aviso("");   // el pedido ya terminó: se quita el aviso "enviado a …"
    });
  }

  /* Tarjetas de invitados activos para la pestaña Equipo (junto a los registrados) */
  function htmlInvitados() {
    return Object.entries(ordenes).filter(([, o]) => o.asignacion && o.asignacion.tipo === "invitado" && o.asignacion.nombre && ["asignado", "retirado"].includes(o.estado)).map(([t, o]) => {
      const [tx] = ETIQUETA[estadoDe(O.uidInvitado(t))], [et, ec] = O.ESTADOS[o.estado];
      return `<div class="tarjeta-rep"><div class="fila"><span class="avatar">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(o.asignacion.nombre)} <i class="pd-tag">Invitado</i></strong><small>Pedido ${esc(cod(o.codigo))} · ${esc(o.cliente)} · ${tx}</small></div>
        <span class="chip ${ec}">${et}</span></div>
        <div class="acciones-fila"><button class="mini pri" data-fv-uid="${esc(O.uidInvitado(t))}" type="button">🧾 Ver factura</button></div></div>`;
    }).join("");
  }
  /* Nota corta para la ventanita del repartidor en el mapa */
  function notaRep(uid) {
    const e = Object.entries(ordenes).find(([t, o]) => ["asignado", "retirado"].includes(o.estado) && o.asignacion &&
      ((o.asignacion.tipo === "invitado" && O.uidInvitado(t) === uid) || (o.asignacion.tipo === "registrado" && o.asignacion.uid === uid)));
    return e ? ` · 📦 ${cod(e[1].codigo)}: ${O.ESTADOS[e[1].estado][0]}` : "";
  }
  /* ---------- Repartidor invitado tocado en el mapa: Entregado / Cancelar / Chat ---------- */
  const tokenInv = (uid) => String(uid).replace(/^inv_/, "");
  const invCerrado = (uid) => { const o = ordenes[tokenInv(uid)]; return !!o && O.esInvitadoUid(uid) && !activa(o); };   // su pedido ya terminó: no se dibuja
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
  /* Expulsar a un invitado sin importar en qué paso va: cancela su pedido, corta su ubicación y lo saca del mapa */
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
  /* Si el admin marca entregado un pedido de un invitado desde el mapa */
  function cerrarInvitado(token, uid) {
    if (!O.esInvitadoUid(uid)) return;
    db.ref().update({ [`ordenes/${token}/estado`]: "entregado", [`ordenes/${token}/actualizado`]: O.TS, ["ubicaciones/" + uid]: null }).catch(() => {});
  }

  /* ============================================================
     3) AUDITORÍA DE FACTURAS EN VIVO
     Lee pedidos/{token} (factura, detalle, prioridad y extras) y se actualiza solo mientras la ventana está abierta.
     ============================================================ */
  let fvRefs = [], fvDatos = {}, fvToks = [];
  const fvLst = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
  const fvR2 = (n) => Math.round(n * 100) / 100;
  function fvSoltar() { fvRefs.forEach((r) => r.off()); fvRefs = []; fvDatos = {}; fvToks = []; }

  /* Desglose exacto: misma regla que ve el repartidor y el cliente (base + prioridad + extras) */
  function fvCalc(d) {
    if (!d) return null;
    const f = d.factura && typeof d.factura === "object" ? d.factura : null, det = d.detalle && typeof d.detalle === "object" ? d.detalle : null;
    const fuente = det || f; if (!fuente) return null;
    const productos = fvLst(fuente.productos).map((p) => ({ nombre: String((p && p.nombre) || "Producto"), precio: Number(p && p.precio) || 0 }));
    const delivery = Number(fuente.delivery) || 0;
    const subtotal = fuente.subtotal != null ? Number(fuente.subtotal) || 0 : productos.reduce((a, p) => a + p.precio, 0);
    const base = det
      ? (det.totalBase != null ? Number(det.totalBase) || 0 : Math.max(0, (Number(det.total) || 0) - (Number(det.prioridad) || 0)))
      : (f.total != null ? Number(f.total) || 0 : subtotal + delivery);
    const prio = d.prioridad === true || (det && Number(det.prioridad) > 0) ? (Number(d.prioridadMonto) || 10) : 0;
    const extras = Object.entries(d.extras && typeof d.extras === "object" ? d.extras : {}).sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, e]) => ({ k, monto: Number(e && e.monto) || 0, nota: String((e && e.nota) || ""), por: String((e && e.por) || "") }));
    const extrasTotal = extras.reduce((a, e) => a + e.monto, 0);
    return { productos, subtotal, delivery, prio, extras, extrasTotal, total: fvR2(base + prio + extrasTotal) };
  }

  function fvBloque(t) {
    const d = fvDatos[t], o = ordenes[t] || {};
    if (d === undefined) return '<div class="fv-bloque"><p class="ayuda">Cargando factura…</p></div>';
    if (d === null) return '<div class="fv-bloque"><p class="ayuda">Este pedido ya no está en curso.</p></div>';
    const c = fvCalc(d), cliente = o.cliente || (d.factura && d.factura.cliente) || "", codigo = o.codigo ? cod(o.codigo) : (d.pedido || "");
    const cerrado = d.estado && d.estado !== "en_ruta";
    let h = `<div class="fv-bloque"><div class="fv-banner"><b>${esc(codigo)}${cliente ? " · " + esc(cliente) : ""}</b><small>🛵 ${esc(d.repartidorNombre || nombreOrden(o))} · ${cerrado ? "Pedido " + esc(d.estado) : "En ruta"}</small></div>`;
    h += fvPuntos(t);
    if (!c) return h + '<p class="ayuda">Todavía no hay factura para este pedido (el repartidor aún no la genera).</p></div>';
    if (c.productos.length) h += '<div class="fv-sec">Productos</div>' + c.productos.map((p) => `<div class="fv-fila"><span>${esc(p.nombre)}</span><b>${O.money(p.precio)}</b></div>`).join("");
    h += `<div class="fv-fila fv-sub"><span>💵 Pagado en restaurante / compras</span><b>${O.money(c.subtotal)}</b></div>`;
    h += `<div class="fv-fila"><span>🛵 Costo del delivery</span><b>${O.money(c.delivery)}</b></div>`;
    if (c.prio) h += `<div class="fv-fila fv-pri"><span>⚡ Prioridad (propina)</span><b>${O.money(c.prio)}</b></div>`;
    if (c.extras.length) {
      h += `<div class="fv-sec">Mandados extra (${c.extras.length})</div>`;
      h += c.extras.map((e) => `<div class="fv-fila fv-ex"><span>➕ ${esc(e.nota || "Mandado extra")}</span><b>${O.money(e.monto)}</b></div>`).join("");
      h += `<div class="fv-fila fv-sub"><span>Total mandados extra</span><b>${O.money(c.extrasTotal)}</b></div>`;
    }
    h += `<div class="fv-total"><span>Total a cobrar</span><b>${O.money(c.total)}</b></div></div>`;
    return h;
  }
  function fvPintar() {
    const cont = el("fvAdmCuerpo"); if (!cont) return fvSoltar();   // la ventana cambió de contenido: se dejan de escuchar los pedidos
    cont.innerHTML = fvToks.map(fvBloque).join("");
  }
  function mostrarFacturas(titulo, toks) {
    fvSoltar(); fvToks = toks.slice();
    modal(`<h2>🧾 Factura · ${esc(titulo)}</h2>
      <span class="fv-vivo">En vivo · se actualiza sola</span>
      <div id="fvAdmCuerpo" class="fv-lista-pedidos"></div>
      <button id="fvAdmCerrar" class="oscuro" type="button">Cerrar</button>`);
    el("fvAdmCerrar").onclick = cerrarModal;
    fvToks.forEach((t) => { fvDatos[t] = undefined; });
    fvPintar();
    fvToks.forEach((t) => {
      const r = db.ref("pedidos/" + t);
      r.on("value", (s) => { fvDatos[t] = s.val(); fvPintar(); }, () => { fvDatos[t] = null; fvPintar(); });
      fvRefs.push(r);
    });
  }

  /* Pedidos activos de un motorizado: los que el administrador le asignó + los que el propio repartidor abrió con su factura */
  async function fvTokensDe(uid) {
    const set = new Set();
    Object.entries(ordenes).forEach(([t, o]) => {
      if (!activa(o)) return;
      const a = o.asignacion || {};
      if ((a.tipo === "registrado" && a.uid === uid) || (a.tipo === "invitado" && O.uidInvitado(t) === uid)) set.add(t);
    });
    try {
      const s = await db.ref("pedidos").orderByChild("repartidorUid").equalTo(uid).limitToLast(20).once("value");
      Object.entries(s.val() || {}).forEach(([t, p]) => { if (p && p.estado === "en_ruta") set.add(t); });
    } catch (_) { /* sin permiso o sin conexión: se usan los pedidos conocidos */ }
    return [...set];
  }
  async function abrirFacturaUid(uid, silencioso) {
    const toks = await fvTokensDe(uid);
    if (!toks.length) { if (!silencioso) toast(nombreUid(uid) + " no lleva ninguna factura en este momento."); return; }
    try { mapa.closePopup(); } catch (_) {}
    mostrarFacturas(nombreUid(uid), toks);
  }

  /* Botón 🧾 Facturas: todos los pedidos en ruta con su motorizado y total */
  async function abrirListaFacturas() {
    modal(`<h2>🧾 Facturas en curso</h2><p class="ayuda" id="fvListaMsg">Cargando pedidos en ruta…</p><div id="fvListaBox" class="fv-lista-pedidos"></div><button id="fvListaCerrar" class="oscuro" type="button">Cerrar</button>`);
    el("fvListaCerrar").onclick = cerrarModal;
    let lista = {};
    try { lista = (await db.ref("pedidos").orderByChild("estado").equalTo("en_ruta").once("value")).val() || {}; }
    catch (err) { const m = el("fvListaMsg"); if (m) m.textContent = "No se pudo leer: " + err.message; return; }
    const box = el("fvListaBox"); if (!box) return;
    const items = Object.entries(lista).filter(([, p]) => p && p.estado === "en_ruta").sort((a, b) => (b[1].inicio || 0) - (a[1].inicio || 0));
    el("fvListaMsg").textContent = items.length ? "Toca un pedido para ver la factura exacta que lleva el motorizado." : "No hay pedidos en ruta ahora mismo.";
    box.innerHTML = items.map(([t, p]) => {
      const c = fvCalc(p), o = ordenes[t] || {}, cliente = o.cliente || (p.factura && p.factura.cliente) || (p.pedido ? "Pedido " + p.pedido : "Pedido");
      return `<button type="button" class="pd-rep" data-ft="${esc(t)}" data-fn="${esc(p.repartidorNombre || "Repartidor")}"><span><strong>${esc(p.repartidorNombre || "Repartidor")}</strong><small>${esc(cliente)} · ${c ? O.money(c.total) : "sin factura aún"}</small></span></button>`;
    }).join("");
    box.onclick = (e) => { const b = e.target.closest("button[data-ft]"); if (b) mostrarFacturas(b.dataset.fn, [b.dataset.ft]); };
  }

  /* Tocar el marcador (burbuja) de un repartidor en el mapa → su factura. Se identifica por la ubicación más cercana al marcador tocado. */
  function alTocarMarcador(e) {
    const t = e.target; if (!t || !t.closest) return;
    if (t.closest(".leaflet-popup, .leaflet-control, button")) return;
    const caja = t.closest(".marca-rider-caja, .marca-rider"); if (!caja) return;
    const icono = caja.closest(".leaflet-marker-icon"); if (!icono || !mapa) return;
    if (!el("modalAdmin").classList.contains("oculto")) return;
    const r = icono.getBoundingClientRect(), c = mapa.getContainer().getBoundingClientRect();
    const px = r.left + r.width / 2 - c.left, py = r.top + r.height / 2 - c.top;
    let mejor = null, dmin = 56;   // máximo ~56 px de distancia al centro del ícono
    Object.keys(ubic || {}).forEach((uid) => {
      const u = ubic[uid]; if (!u || typeof u.lat !== "number" || typeof u.lng !== "number") return;
      const p = mapa.latLngToContainerPoint([u.lat, u.lng]), d = Math.hypot(p.x - px, p.y - py);
      if (d < dmin) { dmin = d; mejor = uid; }
    });
    if (mejor) setTimeout(() => abrirFacturaUid(mejor, true), 150);   // silencioso: si no lleva factura, el toque sigue funcionando como siempre
  }


  /* ============================================================
     4) RECOGIDA, ENTREGA Y RECORRIDO DEL REPARTIDOR INVITADO
     Dibuja en el mapa del admin los pines de cada retiro y de la entrega del pedido del invitado, y el recorrido por calles:
     ubicación actual del invitado → retiros pendientes → entrega. Se actualiza solo cuando el invitado se mueve o retira.
     ============================================================ */
  const recInv = {};   // token → { pins, linea, flechas, legs:{k:{pts,dist,dur,pasos}}, firma, pend, origen, rutaEn, ocupado, gen, resumen }
  const fmtKmR = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
  const esInvActivo = (o) => !!o && !!o.asignacion && o.asignacion.tipo === "invitado" && activa(o);

  /* Todos los puntos del pedido en el orden en que se recorren: retiros y, al final, la entrega */
  function puntosPedido(o) {
    const v = [], retirado = o.estado === "retirado" || o.estado === "entregado";
    O.paradas(o).forEach((p, i) => v.push({ cual: "retiro", i, p, hecho: !!p.retirado || retirado }));
    if (o.entrega && (o.entrega.texto || O.valido(o.entrega))) v.push({ cual: "entrega", i: 0, p: o.entrega, hecho: o.estado === "entregado" });
    return v;
  }
  function limpiarRec(t) {
    const r = recInv[t]; if (!r) return;
    clearTimeout(r.rt); r.pins.forEach((m) => mapa.removeLayer(m)); mapa.removeLayer(r.linea); mapa.removeLayer(r.flechas);
    delete recInv[t];
  }
  function dibujarRec(t) {
    const r = recInv[t]; if (!r) return;
    const u = ubic[O.uidInvitado(t)], tiene = !!u && typeof u.lat === "number";
    let pts = [], dist = 0, dur = 0, pasos = [];
    r.pend.forEach((_, k) => { const l = r.legs[k]; if (!l) return; pts = pts.concat(l.pts); dist += l.dist; dur += l.dur; pasos = pasos.concat(l.pasos || []); });
    if (tiene && r.legs[0] && pts.length) pts = [[u.lat, u.lng]].concat(pts);   // la línea arranca en el invitado y lo sigue mientras se mueve
    r.linea.setLatLngs(pts);
    r.resumen = pts.length ? { dist, dur, calles: O.callesDe(pasos) } : null;
    if (r.resumen && r.resumen.calles) r.linea.bindTooltip("Vía: " + r.resumen.calles, { sticky: true });
  }
  function pintarRecInv(t) {
    if (!mapa) return;
    const o = ordenes[t], uid = O.uidInvitado(t);
    if (!esInvActivo(o) || ocultos.has(uid)) return limpiarRec(t);
    const col = colorUid(uid), nom = (o.asignacion && o.asignacion.nombre) || "Invitado";
    const todos = puntosPedido(o).filter((x) => O.valido(x.p)), pend = todos.filter((x) => !x.hecho);
    const firma = todos.map((x) => [x.cual, x.i, x.hecho ? 1 : 0, x.p.lat, x.p.lng, x.p.texto || "", x.p.producto || ""].join(",")).join("|");
    let r = recInv[t];
    if (!r) r = recInv[t] = { pins: [], linea: L.polyline([], { color: col, weight: 5, opacity: .85 }).addTo(mapa), flechas: L.layerGroup().addTo(mapa), firma: null, legs: {}, pend: [], origen: null, rutaEn: 0, ocupado: false, gen: 0, resumen: null };
    if (r.firma !== firma) {   // cambió un punto o se retiró algo: pines nuevos y recorrido nuevo
      r.firma = firma; r.legs = {}; r.origen = null; r.gen++; r.rutaEn = 0;
      r.pins.forEach((m) => mapa.removeLayer(m));
      const nRet = O.paradas(o).length;
      r.pins = todos.map((x) => {
        const ret = x.cual === "retiro";
        const nombre = ret ? (nRet > 1 ? "Retiro " + (x.i + 1) + ": " : "") + (x.p.texto || "Retiro") : "Entrega · " + (o.cliente || "cliente");
        const m = L.marker([x.p.lat, x.p.lng], { icon: O.pinEtiqueta(x.cual, x.hecho ? "✅" : ret ? "📦" : "🏠", nombre, ret ? x.p.producto : ""), opacity: x.hecho ? .55 : 1, zIndexOffset: 250 }).addTo(mapa);
        m.bindPopup(`<div class="pop-rep"><strong>${ret ? "📦 Punto de recogida" : "🏠 Punto de entrega"}${x.hecho ? " · hecho" : ""}</strong>
          <small>${esc(x.p.texto || "—")}${ret && x.p.producto ? " — " + esc(x.p.producto) : ""}</small>
          <small>🛵 ${esc(nom)} · pedido ${esc(cod(o.codigo))}</small></div>`, { offset: [0, -20], minWidth: 200 });
        return m;
      });
    }
    r.pend = pend;
    dibujarRec(t);
    const u = ubic[uid], tiene = !!u && typeof u.lat === "number";
    if (!pend.length || r.ocupado) return;
    const par = (k) => (k === 0 ? (tiene ? { o: { lat: u.lat, lng: u.lng }, d: pend[0].p } : null) : { o: pend[k - 1].p, d: pend[k].p });
    const movido = tiene && (!r.origen || O.distM(u, r.origen) > 80);
    const faltan = pend.map((_, k) => k).filter((k) => (k === 0 ? tiene && (movido || !r.legs[0]) : !r.legs[k]));
    if (!faltan.length) return;
    if (faltan.length === 1 && faltan[0] === 0 && r.legs[0] && Date.now() - r.rutaEn < 20000) return;   // solo se movió el invitado: recalcula cada ~20 s
    const gen = r.gen, o0 = tiene ? { lat: u.lat, lng: u.lng } : null;
    r.ocupado = true; r.rutaEn = Date.now();
    Promise.all(faltan.map((k) => { const p = par(k); return O.rutaCalles(p.o, p.d).then((res) => ({ k, res })); })).then((rs) => {
      r.ocupado = false;
      if (recInv[t] !== r) return;
      if (r.gen !== gen) return pintarRecInv(t);   // los puntos cambiaron mientras se calculaba
      let fallo = false;
      rs.forEach(({ k, res }) => { if (res) { r.legs[k] = res; if (k === 0) r.origen = o0; } else fallo = true; });
      dibujarRec(t);
      O.flechas(r.linea.getLatLngs().map((p) => [p.lat, p.lng]), r.flechas, col);
      if (fallo) { clearTimeout(r.rt); r.rt = setTimeout(() => pintarRecInv(t), 4000); }   // sin ruta: reintenta (nunca línea recta)
      if (el("fvAdmCuerpo")) fvPintar();   // la factura abierta muestra el recorrido actualizado
    });
  }
  function pintarTodosRecInv() {
    if (!mapa) return;
    Object.keys(ordenes).forEach(pintarRecInv);
    Object.keys(recInv).forEach((t) => { if (!esInvActivo(ordenes[t])) limpiarRec(t); });
  }
  /* Encuadra en el mapa al invitado, sus puntos de recogida y la entrega */
  function verRecorrido(t) {
    t = String(t).replace(/^inv_/, "");
    const r = recInv[t];
    if (!r || !r.pins.length) return toast("Este pedido todavía no tiene puntos con ubicación en el mapa.");
    irAPestana("panelMapa");
    setTimeout(() => {
      mapa.invalidateSize();
      const ll = r.pins.map((m) => m.getLatLng()), u = ubic[O.uidInvitado(t)];
      if (u && typeof u.lat === "number") ll.push(L.latLng(u.lat, u.lng));
      mapa.fitBounds(L.latLngBounds(ll), { padding: [80, 60], maxZoom: 17 });
    }, 120);
  }
  /* Bloque dentro de la ventana de factura: recogida, entrega y resumen del recorrido */
  function fvPuntos(t) {
    const o = ordenes[t]; if (!o) return "";
    const pts = puntosPedido(o); if (!pts.length) return "";
    const n = O.paradas(o).length, r = recInv[t];
    let h = '<div class="fv-sec">Recogida y entrega</div>' + pts.map((x) => {
      const ret = x.cual === "retiro", ic = x.hecho ? "✅" : ret ? "📦" : "🏠";
      return `<div class="fv-fila"><span>${ic} <b>${ret ? "Recogida" + (n > 1 ? " " + (x.i + 1) + "/" + n : "") : "Entrega"}:</b> ${esc(x.p.texto || "—")}${ret && x.p.producto ? " — " + esc(x.p.producto) : ""}${O.valido(x.p) ? "" : " <small>(sin ubicación en el mapa)</small>"}</span><b>${x.hecho ? (ret && x.p.pagado != null ? "Pagó " + O.money(x.p.pagado) : "Hecho") : "Pendiente"}</b></div>`;
    }).join("");
    if (r && r.resumen) h += `<div class="fv-fila fv-sub"><span>🛣 Recorrido pendiente</span><b>${fmtKmR(r.resumen.dist)} · ≈ ${Math.max(1, Math.round(r.resumen.dur / 60))} min</b></div>` + (r.resumen.calles ? `<p class="ayuda">Vía: ${esc(r.resumen.calles)}</p>` : "");
    else if (r) h += `<p class="ayuda">${(ubic[O.uidInvitado(t)] || {}).lat != null ? "Calculando el recorrido…" : "Esperando la ubicación del repartidor para trazar el recorrido…"}</p>`;
    if (r && r.pins.length) h += `<div class="acciones-fila"><button class="mini pri" data-fv-mapa="${esc(t)}" type="button">🗺 Ver recorrido en el mapa</button></div>`;
    return h;
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
      new MutationObserver(() => { if (el("modalAdmin").classList.contains("oculto")) fvSoltar(); }).observe(el("modalAdmin"), { attributes: true, attributeFilter: ["class"] });   // cerrar la ventana corta las escuchas de la factura
      mapa.getContainer().addEventListener("click", alTocarMarcador, true);   // toque en la burbuja de un repartidor → su factura en vivo
      document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("button[data-fv-uid]"); if (b) abrirFacturaUid(b.dataset.fvUid); });   // botón de las tarjetas de invitados (Equipo)
      document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("button[data-fv-mapa]"); if (b) { const t = b.dataset.fvMapa; cerrarModal(); verRecorrido(t); } });   // "Ver recorrido en el mapa" de la factura
      const bf = el("btnFacturasVivo"); if (bf) bf.onclick = abrirListaFacturas;
      document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { cerrarMapaForm(); if (b.dataset.tab === "panelPedidos") pintarSelectorReg(); }));
      el("pdModo").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) modoAsignacion(b.dataset.m); };
      el("pdCrear").onclick = crearPedido;
      el("pdRegSel").addEventListener("change", (e) => { regSel = e.target.value; });
      el("pdDelivery").addEventListener("input", alEscribirDelivery);
      el("pdIvaBase").addEventListener("input", pintarTotalDelivery);    // ajuste manual del IVA base
      el("pdIvaExtra").addEventListener("input", pintarTotalDelivery);
      el("pdIvaExtra").addEventListener("change", () => { if (el("pdIvaExtra").value === "") el("pdIvaExtra").value = "0"; pintarTotalDelivery(); });
      pintarTotalDelivery();
      pintarLugares();
      el("pdAbrirMapa").onclick = () => abrirMapaForm("retiro", 0);
      el("pdAddRetiro").onclick = () => abrirMapaForm("retiro", añadir("retiro"));
      el("pdAddEntrega").onclick = () => abrirMapaForm("entrega", añadir("entrega"));
      el("pdLista").addEventListener("input", (e) => {   // producto de cada retiro
        const f = e.target.closest("[data-i]"); if (f && f.dataset.k === "retiro" && e.target.dataset.f === "producto") retirosForm[+f.dataset.i].producto = e.target.value;
      });
      el("pdLista").addEventListener("click", (e) => {   // tocar un lugar = fijarlo en el mapa
        const b = e.target.closest("button[data-a]"), f = e.target.closest("[data-i]"); if (b && f) abrirMapaForm(f.dataset.k, +f.dataset.i);
      });
      el("listaPedidos").onclick = (e) => {
        const b = e.target.closest("button[data-pa]"); if (!b) return;
        const t = b.dataset.t, o = ordenes[t], a = b.dataset.pa; if (!o) return;
        if (a === "chatinv") abrirChatInv(t);
        else if (a === "linkinv") mostrarEnlaces(t, o);
        else if (a === "linkcli") copiar(O.urlCliente(t));
        else if (a === "factura") mostrarFacturas(o.cliente || cod(o.codigo), [t]);
        else if (a === "recorrido") verRecorrido(t);
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
  function detener() { if (ref) { ref.off(); ref = null; } if (refChatInv) { refChatInv.off(); refChatInv = null; } Object.keys(recInv).forEach(limpiarRec); ordenes = {}; resInv = {}; sinLeerInv = {}; fvSoltar(); cerrarMapaForm(); quitarTemp(); cancelarClick(); }

  return { iniciar, detener, clickMapa, htmlInvitados, notaRep, cerrarInvitado, accionInvitado, expulsarInvitado, chatInvitado, invCerrado, tokenInv, cerrarMapaForm, clienteDe: (t) => (ordenes[t] && ordenes[t].cliente) || "", abrirFacturaUid, abrirListaFacturas, recorridoInv: (uid) => { if (O.esInvitadoUid(uid)) pintarRecInv(tokenInv(uid)); }, verRecorrido };
})();


/* ============================================================
   ACTUALIZACIONES OBLIGATORIAS (In-App Updates) · app Admin / Controlador
   Firebase: configuracion/actualizaciones/admin = { version: 2, novedades: "texto", url: "https://…apk" }
   Si version > APP_VERSION_ADMIN se bloquea la app con una pantalla que no se puede cerrar.
   Además: botón "🚀 Lanzar actualización" (pestaña Equipo) para publicar versiones de admin o repartidor.
   ============================================================ */
const APP_VERSION_ADMIN = 1;
const ActualizacionAdmin = (() => {
  const BASE = "configuracion/actualizaciones/", g = (id) => document.getElementById(id);
  let ref = null;
  const bd = () => (typeof db !== "undefined" ? db : null);
  const urlSegura = (u) => { try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_) { return ""; } };

  /* ---------- Bloqueo ---------- */
  function mostrar(d) {
    const url = urlSegura(d.url), btn = g("btnActualizarApp");
    g("updNovedades").textContent = String(d.novedades || "").trim() || "Mejoras de rendimiento y correcciones.";
    g("updVersionTxt").textContent = "Tu versión: " + APP_VERSION_ADMIN + " · Nueva versión: " + Number(d.version);
    if (url) {
      btn.href = url; btn.removeAttribute("aria-disabled");
      btn.onclick = (e) => { e.preventDefault(); try { window.open(url, "_system"); } catch (_) { window.location.href = url; } };
    } else {
      btn.removeAttribute("href"); btn.setAttribute("aria-disabled", "true"); btn.onclick = (e) => e.preventDefault();
    }
    g("modalActualizacion").classList.remove("oculto");
    document.body.classList.add("upd-bloqueado");
    try { btn.focus(); } catch (_) {}
  }
  function ocultar() {
    g("modalActualizacion").classList.add("oculto");
    document.body.classList.remove("upd-bloqueado");
  }
  function evaluar(d) { if (d && Number(d.version) > APP_VERSION_ADMIN) mostrar(d); else ocultar(); }
  function vigilar() {
    const base = bd(); if (ref || !base) return;
    ref = base.ref(BASE + "admin");
    ref.on("value", (s) => evaluar(s.val()), () => { ref = null; });   // sin permiso todavía (sin sesión): se reintenta al iniciar sesión
  }

  /* ---------- Lanzar actualización (modal del admin) ---------- */
  function lanzar() {
    const base = bd(); if (!base) return;
    modal(`<h2>🚀 Lanzar actualización</h2>
      <p class="ayuda">Las apps con una versión menor quedarán bloqueadas hasta que instalen el nuevo APK.</p>
      <label>Tipo de app <select id="updTipo"><option value="repartidor">Repartidor</option><option value="admin">Admin / Controlador</option></select></label>
      <small id="updActual" class="ayuda">Versión actual en la nube: …</small>
      <label>Nueva versión (número entero, ej. 2) <input id="updVersion" type="number" inputmode="numeric" min="1" step="1" placeholder="2"></label>
      <label>Novedades <textarea id="updNov" rows="4" maxlength="600" placeholder="Qué trae esta versión…"></textarea></label>
      <label>Enlace del nuevo APK <input id="updUrl" type="url" inputmode="url" autocomplete="off" placeholder="https://…"></label>
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
      } catch (_) { if (g("updActual")) g("updActual").textContent = "No se pudo leer la versión actual (revisa las reglas de Firebase)."; }
    }
    mostrarActual();
    g("updTipo").onchange = mostrarActual;
    g("updCancelar").onclick = cerrarModal;
    g("updPublicar").onclick = async () => {
      const tipo = g("updTipo").value, version = Number(g("updVersion").value), novedades = g("updNov").value.trim(), url = urlSegura(g("updUrl").value);
      if (!Number.isInteger(version) || version < 1) return msg("Escribe la versión como número entero (1, 2, 3…).", "error");
      if (!novedades) return msg("Escribe las novedades de esta versión.", "error");
      if (!url) return msg("El enlace del APK debe empezar con http:// o https://", "error");
      if (tipo === "admin" && version > APP_VERSION_ADMIN && !confirm("Esta versión es mayor que la instalada en este aparato: tú también quedarás bloqueado hasta instalar el nuevo APK. ¿Continuar?")) return;
      let actual = null;
      try { actual = (await base.ref(BASE + tipo).once("value")).val(); } catch (_) {}
      if (actual && Number(actual.version) >= version && !confirm("En la nube ya está la versión " + actual.version + ". Con un número igual o menor nadie se bloquea. ¿Publicar de todos modos?")) return;
      g("updPublicar").disabled = true; msg("Publicando…", "ok");
      try {
        await base.ref(BASE + tipo).set({ version, novedades, url, publicado: firebase.database.ServerValue.TIMESTAMP });
        cerrarModal(); toast("Actualización " + version + " publicada para " + (tipo === "admin" ? "Admin" : "Repartidores") + " ✓");
      } catch (err) {
        g("updPublicar").disabled = false;
        msg("No se pudo publicar: " + ((err && err.message) || err) + (err && err.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : ""), "error");
      }
    };
  }

  /* ---------- Arranque ---------- */
  const btnLanzar = g("btnLanzarUpd");
  if (btnLanzar) btnLanzar.onclick = lanzar;
  vigilar();
  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) vigilar(); });
  return { vigilar, lanzar, evaluar };
})();


/* ============================================================
   FASE 3 · AUDITORÍA DE SOLICITUDES ENTRANTES + MODO ESPECTADOR (solo lectura)
   - Pestaña "Auditoría": lista en vivo de solicitudes_entrantes (pendientes / asignadas / pedidos en curso).
   - Al tocar una: panel grande que lee chats/{id} en vivo (texto, tarjetas de factura y movimientos de estado).
   - El administrador NUNCA escribe aquí: solo se usan .on('value') / .on('child_added'), no hay input ni set/update/push.
   Usa los globales de admin.js (db).
   ============================================================ */
const AuditoriaAdmin = (() => {
  const RUTA = "solicitudes_entrantes";
  const g = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const money = (n) => "C$ " + (Number(n) || 0).toFixed(2);
  const hora = (ts) => { const n = Number(ts) || 0; if (!n) return ""; const d = new Date(n); return d.toLocaleDateString("es-NI", { day: "2-digit", month: "short" }) + " " + d.toLocaleTimeString("es-NI", { hour: "2-digit", minute: "2-digit" }); };
  function hace(ts) {
    const n = Number(ts) || 0; if (!n) return "";
    const m = Math.max(0, Math.round((Date.now() - n) / 60000));
    if (m < 1) return "ahora"; if (m < 60) return "hace " + m + " min";
    const h = Math.round(m / 60); return h < 24 ? "hace " + h + " h" : "hace " + Math.round(h / 24) + " d";
  }

  let datos = {}, ref = null, filtro = "todas", errLista = "";
  let abiertoId = null, refChat = null, refSol = null, refPed = null;
  let msgs = {}, solVivo = null, pedVivo = null, eventos = [], eventosVistos = new Set(), prevSol = null, prevPed = null, primeraChat = true;

  const dueno = (s) => (s && s.atendidoPor && s.atendidoPor.uid ? s.atendidoPor : null);
  const grupo = (s) => (s.estado === "pedido" ? "pedido" : dueno(s) ? "asignada" : "pendiente");   // pendiente | asignada | pedido
  const ETQ = { pendiente: "⏳ Pendiente", asignada: "🧑‍🚀 Asignada", pedido: "📦 Pedido en curso" };
  const nombreSol = (s) => String((s && (s.cliente || s.nombre || s.nombreCliente)) || "Cliente").slice(0, 60);
  const textoSol = (s) => String((s && (s.texto || s.mensaje || s.ultimo)) || "").slice(0, 200);
  const lista = () => Object.keys(datos).filter((k) => datos[k] && typeof datos[k] === "object")
    .sort((a, b) => (Number(datos[b].ts) || 0) - (Number(datos[a].ts) || 0));

  /* ---------- Lista en vivo ---------- */
  function pintarLista() {
    const cont = g("audLista"); if (!cont) return;
    const ids = lista(), cuenta = { pendiente: 0, asignada: 0, pedido: 0 };
    ids.forEach((k) => { cuenta[grupo(datos[k])]++; });
    const bd = g("audBadge"); if (bd) { bd.textContent = cuenta.pendiente > 99 ? "99+" : String(cuenta.pendiente); bd.classList.toggle("oculto", !cuenta.pendiente); }
    const rs = g("audResumen");
    if (rs) rs.innerHTML = `<span class="p">⏳ ${cuenta.pendiente} pendientes</span><span class="a">🧑‍🚀 ${cuenta.asignada} asignadas</span><span class="f">📦 ${cuenta.pedido} pedidos</span><span>Total ${ids.length}</span>`;
    const er = g("audError"); if (er) { er.textContent = errLista; er.classList.toggle("oculto", !errLista); }
    document.querySelectorAll("#audFiltros button").forEach((b) => b.classList.toggle("on", b.dataset.f === filtro));
    const vis = ids.filter((k) => filtro === "todas" || grupo(datos[k]) === filtro);
    if (!vis.length) { cont.innerHTML = `<div class="aud-vacio">${errLista ? "" : ids.length ? "No hay solicitudes en este filtro." : "Aún no hay solicitudes entrantes."}</div>`; return; }
    cont.innerHTML = vis.map((k) => {
      const s = datos[k], gr = grupo(s), d = dueno(s);
      const quien = d ? `Atiende: ${esc(d.nombre || "Repartidor")}${d.tipo === "invitado" ? " (invitado)" : ""}` : "Sin repartidor";
      const extra = gr === "pedido" ? ` · ${esc(s.pedidoCodigo || "")} ${s.total != null ? money(s.total) : ""}` : "";
      return `<button type="button" class="aud-item ${gr}" data-id="${esc(k)}" aria-label="Abrir chat de ${esc(nombreSol(s))}">
        <span class="barra"></span>
        <span class="cuerpo"><b>${esc(nombreSol(s))}</b><span>${esc(textoSol(s)) || "—"}</span><small>${quien}${extra}</small></span>
        <span class="lado"><span class="aud-etq">${ETQ[gr]}</span><small>${esc(hace(s.ts))}</small></span>
      </button>`;
    }).join("");
  }

  /* ---------- Visor (Modo Espectador) ---------- */
  function soltarChat() {
    if (refChat) { refChat.off(); refChat = null; }
    if (refSol) { refSol.off(); refSol = null; }
    if (refPed) { refPed.off(); refPed = null; }
    msgs = {}; solVivo = null; pedVivo = null; eventos = []; eventosVistos = new Set(); prevSol = null; prevPed = null; primeraChat = true;
  }
  function evento(clave, ts, texto) {
    if (eventosVistos.has(clave)) return;
    eventosVistos.add(clave); eventos.push({ ts: Number(ts) || Date.now(), texto });
  }
  /* Movimientos de estado: los que ya constan en la solicitud / pedido + los cambios que se observan en vivo */
  function derivarEventos() {
    const s = solVivo, p = pedVivo;
    if (s) {
      if (s.ts) evento("creada", s.ts, "💬 El cliente abrió el chat");
      const d = dueno(s);
      if (d) evento("atendida:" + d.uid + ":" + (d.ts || ""), d.ts, `🧑‍🚀 ${esc(d.nombre || "Repartidor")} tomó el chat${d.tipo === "invitado" ? " (invitado)" : ""}`);
      if (s.facturaTs) evento("factura", s.facturaTs, `🧾 Factura ${esc(s.pedidoCodigo || "")} enviada: ya es un pedido en curso`);
      if (prevSol) {
        const dPrev = dueno(prevSol);
        if (dPrev && !d) evento("liberada:" + Date.now(), Date.now(), `🔓 ${esc(dPrev.nombre || "El repartidor")} liberó el chat`);
        if (prevSol.estado !== s.estado && s.estado) evento("estsol:" + s.estado + ":" + Date.now(), Date.now(), "🔄 Estado de la solicitud: " + esc(s.estado));
      }
    }
    if (p) {
      if (p.inicio) evento("inicio", p.inicio, "🛵 Pedido en ruta");
      if (p.estado === "entregado") evento("estped:entregado", p.fin || p.entregadoTs || Date.now(), "✅ Pedido entregado");
      else if (p.estado === "cancelado") evento("estped:cancelado", p.fin || Date.now(), "⛔ Pedido cancelado");
      else if (prevPed && prevPed.estado !== p.estado && p.estado) evento("estped:" + p.estado + ":" + Date.now(), Date.now(), "🔄 Estado del pedido: " + esc(String(p.estado).replace(/_/g, " ")));
    }
    prevSol = s ? JSON.parse(JSON.stringify(s)) : null; prevPed = p ? JSON.parse(JSON.stringify(p)) : null;
  }
  function tarjetaFactura(m) {
    const f = m.factura || {};
    const prods = Array.isArray(f.productos) ? f.productos : f.productos && typeof f.productos === "object" ? Object.values(f.productos) : [];
    const filas = prods.map((x) => `<div class="fila"><span>${esc(x.nombre || x.name || "Producto")}</span><span>${money(x.precio != null ? x.precio : x.price)}</span></div>`).join("");
    const delTot = f.deliveryTotal != null ? f.deliveryTotal : f.delivery;
    return `<div class="aud-fac" data-k="${esc(m._k)}">
      <header><span>🧾 Factura ${esc(f.pedido || "")}</span><span>${esc(m.nombre || "Repartidor")}</span></header>
      <div class="cu">
        ${f.cliente ? `<div class="fila"><span>Cliente</span><span>${esc(f.cliente)}</span></div>` : ""}
        ${filas || `<div class="fila"><span>${esc(m.texto || "Factura")}</span><span></span></div>`}
        ${f.subtotal != null ? `<div class="fila"><span>Subtotal</span><span>${money(f.subtotal)}</span></div>` : ""}
        ${delTot != null ? `<div class="fila"><span>Delivery</span><span>${money(delTot)}</span></div>` : ""}
        ${Number(f.mandadoExtra) ? `<div class="fila"><span>Mandado extra (incluido)</span><span>${money(f.mandadoExtra)}</span></div>` : ""}
        <div class="fila tot"><span>Total</span><span>${money(f.total)}</span></div>
        ${f.deposito ? `<div class="nota">💵 Con depósito</div>` : ""}
      </div>
      <time>${esc(hora(m.ts))}</time>
    </div>`;
  }
  function pintarMsgs() {
    const box = g("audVMsgs"); if (!box) return;
    const cerca = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const items = Object.keys(msgs).map((k) => ({ t: Number(msgs[k].ts) || 0, tipo: "m", m: msgs[k] }))
      .concat(eventos.map((e) => ({ t: e.ts, tipo: "e", e })))
      .sort((a, b) => a.t - b.t);
    if (!items.length) { box.innerHTML = `<div class="aud-vacio">Todavía no hay mensajes en esta conversación.</div>`; return; }
    box.innerHTML = items.map((it) => {
      if (it.tipo === "e") return `<div class="aud-ev">${it.e.texto}<time>${esc(hora(it.e.ts))}</time></div>`;
      const m = it.m;
      if (m.tipo === "factura" || (m.factura && typeof m.factura === "object")) return tarjetaFactura(m);
      if (m.de === "sistema" || ["estado", "sistema", "evento"].includes(m.tipo)) return `<div class="aud-ev">${esc(m.texto || m.estado || "")}<time>${esc(hora(m.ts))}</time></div>`;
      const rep = m.de === "repartidor" || m.de === "admin";
      const quien = rep ? (m.nombre || (m.de === "admin" ? "Administrador" : "Repartidor")) : (m.nombre || nombreSol(solVivo));
      const cuerpo = m.texto != null && String(m.texto) !== "" ? esc(m.texto) : "📎 Adjunto no mostrable";
      return `<div class="aud-m ${rep ? "rep" : "cli"}"><span class="quien">${rep ? "🛵" : "👤"} ${esc(quien)}</span>${cuerpo}<time>${esc(hora(m.ts))}</time></div>`;
    }).join("");
    if (cerca || primeraChat) box.scrollTop = box.scrollHeight;
    primeraChat = false;
  }
  function pintarCabecera() {
    const s = solVivo || datos[abiertoId] || {}, gr = grupo(s), d = dueno(s);
    g("audVTitulo").textContent = nombreSol(s);
    g("audVSub").textContent = ETQ[gr] + (d ? " · " + (d.nombre || "Repartidor") : "") + " · #" + String(abiertoId).slice(-6);
    const chips = [`<span>${ETQ[gr]}</span>`];
    if (d) chips.push(`<span>🛵 ${esc(d.nombre || "Repartidor")}${d.tipo === "invitado" ? " · invitado" : " · registrado"}</span>`);
    if (s.pedidoCodigo) chips.push(`<span>🧾 ${esc(s.pedidoCodigo)}</span>`);
    if (s.total != null && gr === "pedido") chips.push(`<span>${money(s.total)}</span>`);
    if (pedVivo && pedVivo.estado) chips.push(`<span>📍 ${esc(String(pedVivo.estado).replace(/_/g, " "))}</span>`);
    g("audVInfo").innerHTML = chips.join("");
  }
  function abrir(id) {
    if (!id || typeof db === "undefined") return;
    soltarChat(); abiertoId = id;
    g("audVMsgs").innerHTML = `<div class="aud-vacio">Cargando conversación…</div>`;
    g("audVisor").classList.remove("oculto");
    pintarCabecera();
    refSol = db.ref(RUTA + "/" + id);
    refSol.on("value", (sn) => { solVivo = sn.val(); derivarEventos(); pintarCabecera(); pintarMsgs(); }, () => {});
    refPed = db.ref("pedidos/" + id);
    refPed.on("value", (sn) => { pedVivo = sn.val(); derivarEventos(); pintarCabecera(); pintarMsgs(); }, () => {});
    refChat = db.ref("chats/" + id).limitToLast(300);
    refChat.on("value", (sn) => {
      msgs = {};
      sn.forEach((c) => { const v = c.val(); if (v && typeof v === "object") { v._k = c.key; msgs[c.key] = v; } });
      pintarMsgs();
    }, (err) => { g("audVMsgs").innerHTML = `<div class="aud-vacio">No se pudo leer el chat: ${esc((err && err.message) || "sin permiso")}</div>`; });
  }
  function cerrar() {
    soltarChat(); abiertoId = null;
    const v = g("audVisor"); if (v) v.classList.add("oculto");
  }

  /* ---------- Pestañas: el panel se muestra solo con su pestaña, sin depender de la lista interna de admin.js ---------- */
  function alTab(b) {
    const mio = b.dataset.tab === "panelAuditoria", p = g("panelAuditoria");
    if (!p) return;
    if (mio) {
      ["panelMapa", "panelPedidos", "panelChats", "panelEquipo"].forEach((id) => { const x = g(id); if (x) x.classList.add("oculto"); });
      p.classList.remove("oculto");
      document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("activa", x === b));
      pintarLista();
    } else { p.classList.add("oculto"); }
  }

  function iniciar() {
    if (typeof db === "undefined" || !g("audLista")) return;
    g("audLista").addEventListener("click", (e) => { const b = e.target.closest("button[data-id]"); if (b) abrir(b.dataset.id); });
    g("audFiltros").addEventListener("click", (e) => { const b = e.target.closest("button[data-f]"); if (b) { filtro = b.dataset.f; pintarLista(); } });
    g("audVCerrar").onclick = cerrar;
    g("audVisor").addEventListener("click", (e) => { if (e.target === g("audVisor")) cerrar(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && abiertoId) cerrar(); });
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => alTab(b)));
    ref = db.ref(RUTA).limitToLast(300);
    ref.on("value", (sn) => { datos = sn.val() || {}; errLista = ""; pintarLista(); }, (err) => {
      errLista = "No se pudieron leer las solicitudes: " + ((err && err.message) || "sin permiso") + (err && err.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : "");
      pintarLista();
    });
    setInterval(() => { if (g("panelAuditoria") && !g("panelAuditoria").classList.contains("oculto")) pintarLista(); }, 60000);   // refresca "hace X min"
  }

  /* admin.js crea db al iniciar sesión del administrador; si aún no hay sesión, se espera a que la haya */
  function arrancar() {
    if (typeof auth !== "undefined" && auth.currentUser) return iniciar();
    if (typeof auth !== "undefined") { const off = auth.onAuthStateChanged((u) => { if (u) { off(); iniciar(); } }); }
    else iniciar();
  }
  arrancar();
  return { abrir, cerrar };
})();
