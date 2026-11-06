/* ============================================================
   ORDENES-ADMIN · Funciones 1 y 2 del panel de administración
   1) Toque en el mapa → modal para elegir repartidor activo y punto Retiro/Entrega
   2) Pestaña "Pedidos": formulario, asignación (registrado o enlace de invitado) y estado en vivo
   3) Auditoría de facturas: al tocar el marcador de un repartidor en el mapa (o su tarjeta / el botón 🧾 Facturas) se abre la factura
      exacta y en vivo que lleva (productos, delivery, prioridad, mandados extra y total), leída de pedidos/{token}.
   FASE 3 · Control manual: forzar estado a "entregado" / "cancelado" desde la lista y desde el Modo Espectador,
      y asignación manual forzada (transacción sobre repartidorUid) cuando nadie toma una solicitud.
      Notificación sonora + toast cuando llega una solicitud nueva (solo en el panel del admin).
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
    const m = L.map(g("pdOvlMapa"), { zoomControl: false }).setView(mapa ? mapa.getCenter() : [12.5700, -87.1311], mapa ? Math.max(mapa.getZoom(), 13) : 14);
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

  /* ============================================================
     FASE 3 · CONTROL MANUAL (Tachar/Forzar)
     ============================================================ */
  /* Fuerza el estado de un pedido del administrador (ordenes/{token}) a "entregado" o "cancelado".
     Se escribe en ordenes/{token} y en pedidos/{token} para que el cliente lo vea al instante.
     También limpia la guía y la ubicación del invitado. */
  async function forzarEstadoOrden(token, nuevoEstado) {
    const o = ordenes[token];
    if (!o) return toast("No encuentro ese pedido.");
    if (!["entregado", "cancelado"].includes(nuevoEstado)) return toast("Estado no válido.");
    if (o.estado === nuevoEstado) return toast("El pedido ya está en ese estado.");
    const esEnt = nuevoEstado === "entregado";
    if (!confirm((esEnt ? "¿Forzar como ENTREGADO" : "¿Forzar como CANCELADO") + " el pedido " + cod(o.codigo) + "?\n\nEsto sobrescribe el estado sin importar lo que diga el repartidor o el cliente.")) return;
    const upd = {
      [`ordenes/${token}/estado`]: nuevoEstado,
      [`ordenes/${token}/actualizado`]: O.TS,
      [`ordenes/${token}/forzadoPorAdmin`]: true,
      [`ordenes/${token}/forzadoTs`]: O.TS
    };
    if (esEnt) upd[`ordenes/${token}/entregadoTs`] = O.TS;
    // También actualiza el pedido del cliente (si existe) para que lo vea al instante
    try {
      const existe = (await db.ref("pedidos/" + token).once("value")).exists();
      if (existe) {
        upd[`pedidos/${token}/estado`] = nuevoEstado;
        if (esEnt) upd[`pedidos/${token}/fin`] = O.TS;
        upd[`pedidos/${token}/forzadoPorAdmin`] = true;
      }
    } catch (_) {}
    // Limpia guía y ubicación del invitado (si aplica)
    const a = o.asignacion || {};
    if (a.tipo === "registrado" && a.uid && guias[a.uid] && guias[a.uid].ordenId === token) upd["guias/" + a.uid] = null;
    if (a.tipo === "invitado") upd["ubicaciones/" + O.uidInvitado(token)] = null;
    try {
      await db.ref().update(upd);
      toast(esEnt ? "✅ Pedido forzado a ENTREGADO" : "🚫 Pedido forzado a CANCELADO");
    } catch (err) { toast("No se pudo forzar: " + err.message); }
  }

  /* Asignación manual forzada: transacción sobre repartidorUid para que dos administradores no asignen a la vez.
     El repartidor debe aceptar de nuevo (estado_asignacion = "pendiente"). */
  async function asignarManual(uid, token) {
    const o = ordenes[token];
    if (!o) return toast("No encuentro ese pedido.");
    const nom = nombreUid(uid);
    if (!confirm(`¿Asignar FORZOSAMENTE el pedido ${cod(o.codigo)} a ${nom}?\nEl repartidor recibirá un aviso y deberá aceptar de nuevo.`)) return;
    try {
      // Transacción: solo uno de los admins concurrentes gana el "pendiente"
      const r = await db.ref("ordenes/" + token + "/estado_asignacion").transaction((cur) => {
        if (cur === "pendiente") return;   // ya está pendiente: no se pisa
        return "pendiente";
      });
      const upd = {
        [`ordenes/${token}/asignacion`]: { tipo: "registrado", uid, nombre: nom },
        [`ordenes/${token}/estado`]: "asignado",
        [`ordenes/${token}/actualizado`]: O.TS,
        [`ordenes/${token}/asignadoPorAdmin`]: true,
        [`ordenes/${token}/asignadoTs`]: O.TS
      };
      // Pedido del cliente (si existe) para que vea a su repartidor
      const nCli = (typeof O.nodoCliente === "function") ? O.nodoCliente(token, o, uid, nom)
        : { estado: "en_ruta", pedido: o.codigo, inicio: O.TS, repartidorUid: uid, repartidorNombre: nom, clienteNombre: o.cliente, adminOrden: true, delivery: O.totalDelivery(o) };
      upd["pedidos/" + token] = nCli;
      // Guía al primer retiro pendiente (si tiene coordenadas)
      const sig = O.siguienteRetiro(o);
      if (sig && O.valido(sig.p)) upd["guias/" + uid] = O.datosGuia ? O.datosGuia("retiro", sig.p, { ordenId: token, nombre: O.textoRetiro(sig.p, O.paradas(o).length, sig.i), negocio: sig.p.texto || "Retiro", producto: sig.p.producto || "" }) : null;
      await db.ref().update(upd);
      toast(`Pedido asignado a ${nom} ✓`);
      if (typeof PushAdmin !== "undefined") PushAdmin.pedidoAsignado(uid, Object.assign({ token }, o));
    } catch (err) { toast("No se pudo asignar: " + err.message); }
  }

  /* Devuelve los pedidos activos (ordenes) de un repartidor registrado o invitado */
  function ordenesDe(uid) {
    return Object.entries(ordenes).filter(([t, o]) =>
      activa(o) && o.asignacion && (
        (o.asignacion.tipo === "registrado" && o.asignacion.uid === uid) ||
        (o.asignacion.tipo === "invitado" && O.uidInvitado(t) === uid)
      )
    ).map(([token, orden]) => ({ token, orden }));
  }

  function tarjeta(t) {
    const o = ordenes[t], [txt, cls] = O.ESTADOS[o.estado] || O.ESTADOS.pendiente, a = o.asignacion || {};
    const inv = a.tipo === "invitado", btn = (acc, label, extra) => `<button class="mini ${extra || ""}" data-pa="${acc}" data-t="${esc(t)}" type="button">${label}</button>`;
    return `<div class="tarjeta-rep pd-orden">
      <div class="fila"><div class="datos"><strong>${esc(cod(o.codigo))} · ${esc(o.cliente || "Sin nombre")}</strong>
        <small>👤 ${esc(nombreOrden(o))}${inv ? ' <i class="pd-tag">Invitado</i>' : ""}</small></div><span class="chip ${cls}">${txt}</span></div>
      <div class="ruta">${O.paradas(o).map((p, k) => `${p.retirado ? "✅" : "📦"} ${O.paradas(o).length > 1 ? "Retiro " + (k + 1) + ": " : ""}${esc(p.texto || "—")}${p.producto ? " — <b>" + esc(p.producto) + "</b>" : ""}`).join("<br>")}<br>🏠 ${esc((o.entrega && o.entrega.texto) || "—")}${o.delivery || o.iva ? "<br>🛵 Delivery: <b>" + O.textoDelivery(o) + "</b>" : ""}${o.paquete ? "<br>📝 " + esc(o.paquete) : ""}${a.tipo === "registrado" && activa(o) ? (o.estado_asignacion === "aceptado" ? "<br>✅ Aceptado por el repartidor" : o.estado_asignacion === "rechazado" ? "<br>❌ Rechazado por el repartidor" : o.estado === "asignado" ? "<br>⏳ Esperando respuesta del repartidor" : "") : ""}${o.forzadoPorAdmin ? "<br>🛡️ <b>Forzado por el administrador</b>" : ""}</div>
      <div class="acciones-fila" style="flex-wrap:wrap">
        ${inv && activa(o) ? btn("linkinv", "🔗 Enlace invitado") : ""}${inv && a.nombre && activa(o) ? btn("chatinv", "🗨 Chat invitado" + (sinLeerInv[t] ? " (" + sinLeerInv[t] + ")" : "")) : ""}${a.tipo && activa(o) ? btn("linkcli", "💬 Enlace cliente") : ""}${a.tipo && activa(o) ? btn("factura", "🧾 Factura", "pri") : ""}${inv && activa(o) ? btn("recorrido", "🗺 Recorrido") : ""}
        ${(o.estado === "pendiente" && !a.tipo) || (o.estado_asignacion === "rechazado" && activa(o)) ? btn("asignar", o.estado_asignacion === "rechazado" ? "Reasignar" : "Asignar", "pri") : ""}
        ${activa(o) ? btn("forzar-ent", "✅ Forzar entregado") : ""}${activa(o) ? btn("forzar-canc", "🚫 Forzar cancelado") : ""}
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
      return `<div class="tarjeta-rep"><div class="fila"><span class="avatar" data-av="${esc(O.uidInvitado(t))}">${RIDER_SVG}</span>
        <div class="datos"><strong>${esc(o.asignacion.nombre)} <i class="pd-tag">Invitado</i></strong><small>Pedido ${esc(cod(o.codigo))} · ${esc(o.cliente)} · ${tx}</small></div>
        <span class="chip ${ec}">${et}</span></div>
        <div class="acciones-fila">
          <button class="mini pri" data-fv-uid="${esc(O.uidInvitado(t))}" type="button">🧾 Ver factura</button>
          <button class="mini" data-foto-uid="${esc(O.uidInvitado(t))}" data-foto-nom="${esc(o.asignacion.nombre)}" type="button">📷 Foto</button>
        </div></div>`;
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
     ============================================================ */
  let fvRefs = [], fvDatos = {}, fvToks = [];
  const fvLst = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);
  const fvR2 = (n) => Math.round(n * 100) / 100;
  function fvSoltar() { fvRefs.forEach((r) => r.off()); fvRefs = []; fvDatos = {}; fvToks = []; }

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
    const cont = el("fvAdmCuerpo"); if (!cont) return fvSoltar();
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
    } catch (_) {}
    return [...set];
  }
  async function abrirFacturaUid(uid, silencioso) {
    const toks = await fvTokensDe(uid);
    if (!toks.length) { if (!silencioso) toast(nombreUid(uid) + " no lleva ninguna factura en este momento."); return; }
    try { mapa.closePopup(); } catch (_) {}
    mostrarFacturas(nombreUid(uid), toks);
  }

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

  function alTocarMarcador(e) {
    const t = e.target; if (!t || !t.closest) return;
    if (t.closest(".leaflet-popup, .leaflet-control, button")) return;
    const caja = t.closest(".marca-rider-caja, .marca-rider"); if (!caja) return;
    const icono = caja.closest(".leaflet-marker-icon"); if (!icono || !mapa) return;
    if (!el("modalAdmin").classList.contains("oculto")) return;
    const r = icono.getBoundingClientRect(), c = mapa.getContainer().getBoundingClientRect();
    const px = r.left + r.width / 2 - c.left, py = r.top + r.height / 2 - c.top;
    let mejor = null, dmin = 56;
    Object.keys(ubic || {}).forEach((uid) => {
      const u = ubic[uid]; if (!u || typeof u.lat !== "number" || typeof u.lng !== "number") return;
      const p = mapa.latLngToContainerPoint([u.lat, u.lng]), d = Math.hypot(p.x - px, p.y - py);
      if (d < dmin) { dmin = d; mejor = uid; }
    });
    if (mejor) setTimeout(() => abrirFacturaUid(mejor, true), 150);
  }

  /* ============================================================
     4) RECOGIDA, ENTREGA Y RECORRIDO DEL REPARTIDOR INVITADO
     ============================================================ */
  const recInv = {};
  const fmtKmR = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
  const esInvActivo = (o) => !!o && !!o.asignacion && o.asignacion.tipo === "invitado" && activa(o);

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
    if (tiene && r.legs[0] && pts.length) pts = [[u.lat, u.lng]].concat(pts);
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
    if (r.firma !== firma) {
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
    if (faltan.length === 1 && faltan[0] === 0 && r.legs[0] && Date.now() - r.rutaEn < 20000) return;
    const gen = r.gen, o0 = tiene ? { lat: u.lat, lng: u.lng } : null;
    r.ocupado = true; r.rutaEn = Date.now();
    Promise.all(faltan.map((k) => { const p = par(k); return O.rutaCalles(p.o, p.d).then((res) => ({ k, res })); })).then((rs) => {
      r.ocupado = false;
      if (recInv[t] !== r) return;
      if (r.gen !== gen) return pintarRecInv(t);
      let fallo = false;
      rs.forEach(({ k, res }) => { if (res) { r.legs[k] = res; if (k === 0) r.origen = o0; } else fallo = true; });
      dibujarRec(t);
      O.flechas(r.linea.getLatLngs().map((p) => [p.lat, p.lng]), r.flechas, col);
      if (fallo) { clearTimeout(r.rt); r.rt = setTimeout(() => pintarRecInv(t), 4000); }
      if (el("fvAdmCuerpo")) fvPintar();
    });
  }
  function pintarTodosRecInv() {
    if (!mapa) return;
    Object.keys(ordenes).forEach(pintarRecInv);
    Object.keys(recInv).forEach((t) => { if (!esInvActivo(ordenes[t])) limpiarRec(t); });
  }
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
      new MutationObserver(() => { if (el("modalAdmin").classList.contains("oculto")) fvSoltar(); }).observe(el("modalAdmin"), { attributes: true, attributeFilter: ["class"] });
      mapa.getContainer().addEventListener("click", alTocarMarcador, true);
      document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("button[data-fv-uid]"); if (b) abrirFacturaUid(b.dataset.fvUid); });
      document.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest("button[data-fv-mapa]"); if (b) { const t = b.dataset.fvMapa; cerrarModal(); verRecorrido(t); } });
      const bf = el("btnFacturasVivo"); if (bf) bf.onclick = abrirListaFacturas;
      document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => { cerrarMapaForm(); if (b.dataset.tab === "panelPedidos") pintarSelectorReg(); }));
      el("pdModo").onclick = (e) => { const b = e.target.closest("button[data-m]"); if (b) modoAsignacion(b.dataset.m); };
      el("pdCrear").onclick = crearPedido;
      el("pdRegSel").addEventListener("change", (e) => { regSel = e.target.value; });
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
        else if (a === "factura") mostrarFacturas(o.cliente || cod(o.codigo), [t]);
        else if (a === "recorrido") verRecorrido(t);
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
      pintarOrdenes(); pintarSelectorReg(); pintarEquipo(); pintarLista();
    }, () => { el("listaPedidos").innerHTML = '<p class="ayuda">Sin permiso para leer "ordenes". Revisa las reglas de Firebase (ver LEEME).</p>'; });
  }
  function detener() { if (ref) { ref.off(); ref = null; } if (refChatInv) { refChatInv.off(); refChatInv = null; } Object.keys(recInv).forEach(limpiarRec); ordenes = {}; resInv = {}; sinLeerInv = {}; fvSoltar(); cerrarMapaForm(); quitarTemp(); cancelarClick(); }

  return {
    iniciar, detener, clickMapa, htmlInvitados, notaRep, cerrarInvitado, accionInvitado, expulsarInvitado, chatInvitado,
    invCerrado, tokenInv, cerrarMapaForm, clienteDe: (t) => (ordenes[t] && ordenes[t].cliente) || "",
    abrirFacturaUid, abrirListaFacturas,
    recorridoInv: (uid) => { if (O.esInvitadoUid(uid)) pintarRecInv(tokenInv(uid)); },
    verRecorrido,
    /* FASE 3 */
    forzarEstadoOrden, asignarManual, ordenesDe
  };
})();


/* ============================================================
   SOLICITUDES ENTRANTES · panel del administrador
   - Lista en vivo de solicitudes_entrantes con su estado: Sin atender · Con pedido · Entregado · Cancelado.
   - Visor de SOLO LECTURA: mensajes, fotos, facturas con el desglose de mandados extra y valoración del cliente.
   - "Modo espectador": mapa con el GPS del cliente y del repartidor a la vez, en vivo.
   - Borrado de chats FINALIZADOS: uno por uno, por fecha o por selección múltiple.
   - FASE 3 · Notificación sonora + toast al recibir solicitudes nuevas (solo una vez, al pasar a "nuevo").
   - FASE 3 · Control manual: forzar estado a entregado o cancelado desde el visor o la lista.
   Usa los globales de admin.js (auth, db). Cuenta propia de pestaña: funciona aunque admin.js no la conozca.
   ============================================================ */
const SolicitudesAdmin = (() => {
  const RAIZ = "solicitudes_entrantes", RAIZ_FOTOS = "solicitudes_fotos", PANEL = "panelSolicitudes";
  const g = (id) => document.getElementById(id);
  let consulta = null, lista = {}, filtro = "todos", fecha = "", visorId = null, consultaMsgs = null, ultDia = null;
  let refUbic = null, ubic = {};
  let mapa = null, marcaCli = null, marcaRep = null, linea = null, encuadrado = false;
  const vistos = new Set(), sel = new Set();
  let cargada = false;              // FASE 3: la primera lectura no notifica
  const avisadas = new Set();       // FASE 3: ids de solicitudes "nuevo" ya anunciadas

  const fin = (d) => !!d && (d.estado === "entregado" || d.estado === "cancelado");
  const estadoDe = (d) => (fin(d) ? d.estado : d.repartidorUid ? "atendido" : "nuevo");
  const dinero = (n) => "C$ " + (Number(n) || 0).toFixed(2);
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

  /* ---------- FASE 3 · Notificación sonora + toast al recibir una solicitud nueva ---------- */
  function anunciarNuevas(ids) {
    if (!ids.length) return;
    try { if (typeof Voz !== "undefined" && Voz.solicitud) Voz.solicitud(); } catch (_) {}
    if (typeof toast === "function") {
      toast("📥 " + (ids.length === 1 ? "Nueva solicitud de cliente pendiente" : ids.length + " solicitudes nuevas pendientes"));
    }
  }

  /* ---------- Lista en vivo ---------- */
  function iniciar() {
    detener();
    cargada = false; avisadas.clear();
    consulta = db.ref(RAIZ).limitToLast(100);
    consulta.on("value", (s) => {
      const antes = lista;
      lista = s.val() || {};
      // FASE 3: detectar nuevas solicitudes "nuevo" y anunciarlas (voz + toast) una sola vez
      if (cargada) {
        const nuevas = [];
        Object.keys(lista).forEach((k) => {
          const d = lista[k];
          if (d && estadoDe(d) === "nuevo" && !avisadas.has(k) && (!antes[k] || estadoDe(antes[k]) !== "nuevo")) {
            avisadas.add(k);
            nuevas.push(k);
          }
        });
        if (nuevas.length) anunciarNuevas(nuevas);
      } else {
        // primera carga: marcar todas como ya anunciadas (no sonar por lo que ya estaba)
        Object.keys(lista).forEach((k) => { if (lista[k] && estadoDe(lista[k]) === "nuevo") avisadas.add(k); });
      }
      cargada = true;
      [...sel].forEach((id) => { if (!lista[id] || !fin(lista[id])) sel.delete(id); });
      pintar();
      if (visorId) { cabeceraVisor(); actualizarMapa(false); }
    }, (e) => {
      lista = {};
      pintar(e && e.code === "PERMISSION_DENIED" ? "Sin permiso para leer “solicitudes_entrantes”. Revisa las reglas de Firebase." : "No se pudieron cargar las solicitudes.");
    });
    refUbic = db.ref("ubicaciones");
    refUbic.on("value", (s) => { ubic = s.val() || {}; pintarServicio(); }, () => { ubic = {}; pintarServicio(); });
  }

  function detener() {
    if (consulta) { consulta.off(); consulta = null; }
    if (refUbic) { refUbic.off(); refUbic = null; }
    cerrarVisor();
    lista = {}; ubic = {}; sel.clear();
    pintar();
  }

  function pintarServicio() {
    const c = g("saServicio");
    if (!c) return;
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
    const caja = g("saLista");
    if (!caja) return;
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
    if (!vis.length) {
      caja.appendChild(el("div", "sa-vacio", !todas.length ? "Todavía no hay solicitudes. Aparecerán aquí en cuanto un cliente haga un pedido." : "No hay solicitudes con este filtro."));
      return;
    }
    vis.forEach((k) => {
      const d = lista[k], est = estadoDe(d), p = d.pedido || {};
      const f = el("div", "sa-item" + (est === "nuevo" ? " nuevo" : est === "atendido" ? " activo" : ""));
      if (fin(d)) {
        const c = el("input", "sa-chk");
        c.type = "checkbox"; c.checked = sel.has(k);
        c.setAttribute("aria-label", "Seleccionar el chat de " + cortar(d.nombre || "Cliente", 30));
        c.addEventListener("change", () => { if (c.checked) sel.add(k); else sel.delete(k); pintarHerramientas(visibles()); });
        f.appendChild(c);
      }
      const nombre = cortar(d.nombre || "Cliente", 40);
      f.appendChild(el("span", "sa-av", nombre.charAt(0).toUpperCase()));
      const dat = el("div", "sa-dat");
      dat.appendChild(el("strong", "", nombre));
      dat.appendChild(chipEstado(d));
      if (p.quiere) dat.appendChild(el("small", "", "🛍️ " + cortar(p.quiere, 70) + (p.origen ? " · de " + cortar(p.origen, 40) : "")));
      const ult = d.ultimoMensaje ? (d.ultimoDe === "cliente" ? "Cliente: " : d.ultimoDe === "repartidor" ? "Repartidor: " : "") + String(d.ultimoMensaje) : "Sin mensajes todavía";
      dat.appendChild(el("small", "", ult + (d.ts ? " · " + horaDe(d.ts) : "")));
      if (valoracion(d)) dat.appendChild(el("small", "sa-estrellas", estrellas(valoracion(d))));
      f.appendChild(dat);
      const acc = el("div", "sa-acc");
      const b = el("button", "oscuro", "👁 Ver");
      b.type = "button"; b.setAttribute("aria-label", "Leer el chat de " + nombre);
      b.addEventListener("click", () => abrirVisor(k));
      acc.appendChild(b);
      // FASE 3: si la solicitud está activa (atendida), ofrecer forzar cancelado/entregado desde la lista
      if (!fin(d) && d.repartidorUid) {
        const fEnt = el("button", "primario", "✅");
        fEnt.type = "button"; fEnt.title = "Forzar entregado"; fEnt.setAttribute("aria-label", "Forzar entregado");
        fEnt.addEventListener("click", () => forzarEstadoSolicitud(k, "entregado"));
        acc.appendChild(fEnt);
        const fCanc = el("button", "peligro", "🚫");
        fCanc.type = "button"; fCanc.title = "Forzar cancelado"; fCanc.setAttribute("aria-label", "Forzar cancelado");
        fCanc.addEventListener("click", () => forzarEstadoSolicitud(k, "cancelado"));
        acc.appendChild(fCanc);
      }
      if (fin(d)) {
        const x = el("button", "peligro", "🗑");
        x.type = "button"; x.setAttribute("aria-label", "Eliminar el chat de " + nombre);
        x.addEventListener("click", () => borrar([k]));
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

  /* ---------- Borrado (solo chats finalizados) ---------- */
  async function borrar(ids) {
    ids = ids.filter((id) => lista[id] && fin(lista[id]));
    if (!ids.length) return msg("Solo se pueden eliminar chats entregados o cancelados.", true);
    if (!confirm("¿Eliminar " + (ids.length === 1 ? "este chat" : ids.length + " chats") + " para siempre? Se borran también sus mensajes, fotos y facturas. Esta acción no se puede deshacer.")) return;
    msg("Eliminando…");
    try {
      for (let i = 0; i < ids.length; i += 40) {
        const upd = {};
        ids.slice(i, i + 40).forEach((id) => { upd[RAIZ + "/" + id] = null; upd[RAIZ_FOTOS + "/" + id] = null; });
        await db.ref().update(upd);
      }
    } catch (e) {
      return msg("No se pudo eliminar: " + (e.code || e.message) + (e.code === "PERMISSION_DENIED" ? " (revisa las reglas de Firebase)" : ""), true);
    }
    ids.forEach((id) => { sel.delete(id); delete lista[id]; if (id === visorId) cerrarVisor(); });
    msg(ids.length === 1 ? "Chat eliminado." : ids.length + " chats eliminados.");
    pintar();
    setTimeout(() => msg(""), 4000);
  }

  /* ---------- FASE 3 · Forzar estado (Control manual) ---------- */
  async function forzarEstadoSolicitud(id, nuevoEstado) {
    const d = lista[id];
    if (!d) return msg("No encuentro esa solicitud.", true);
    if (!["entregado", "cancelado"].includes(nuevoEstado)) return msg("Estado no válido.", true);
    if (d.estado === nuevoEstado) return msg("La solicitud ya está en ese estado.", true);
    const esEnt = nuevoEstado === "entregado";
    if (!confirm((esEnt ? "¿Forzar como ENTREGADO" : "¿Forzar como CANCELADO") + " el chat de " + cortar(d.nombre || "Cliente", 30) + "?\n\nEsto sobrescribe el estado sin importar lo que diga el repartidor o el cliente.")) return;
    const upd = {
      [RAIZ + "/" + id + "/estado"]: nuevoEstado,
      [RAIZ + "/" + id + "/forzadoPorAdmin"]: true,
      [RAIZ + "/" + id + "/forzadoTs"]: firebase.database.ServerValue.TIMESTAMP
    };
    if (esEnt) upd[RAIZ + "/" + id + "/entregadoTs"] = firebase.database.ServerValue.TIMESTAMP;
    else upd[RAIZ + "/" + id + "/canceladoTs"] = firebase.database.ServerValue.TIMESTAMP;
    try {
      await db.ref().update(upd);
      msg(esEnt ? "✅ Chat forzado a ENTREGADO" : "🚫 Chat forzado a CANCELADO");
      setTimeout(() => msg(""), 4000);
    } catch (e) { msg("No se pudo forzar: " + (e.code || e.message), true); }
  }

  /* ---------- Visor de solo lectura ---------- */
  function cabeceraVisor() {
    const d = lista[visorId];
    if (!d) { g("saSub").textContent = "Este chat fue eliminado."; g("saBorrarUno").classList.add("oculto"); g("saForzarEnt").classList.add("oculto"); g("saForzarCanc").classList.add("oculto"); return; }
    g("saTitulo").textContent = cortar(d.nombre || "Cliente", 40);
    const est = estadoDe(d), v = valoracion(d);
    g("saSub").textContent = est === "nuevo" ? "Sin atender todavía"
      : est === "atendido" ? "Con pedido · " + cortar(d.repartidorNombre || "un repartidor", 30)
      : est === "entregado" ? "Entregado" + (d.repartidorNombre ? " por " + cortar(d.repartidorNombre, 30) : "") + (v ? " · " + estrellas(v) : " · sin valoración") + (d.forzadoPorAdmin ? " · forzado" : "")
      : "Cancelado" + (d.motivoCancelacion === "cliente" ? " · lo decidió el cliente" : "") + (d.forzadoPorAdmin ? " · forzado" : "");
    g("saBorrarUno").classList.toggle("oculto", !fin(d));
    // FASE 3: forzar solo si la solicitud está activa (atendida)
    const activa = !fin(d) && !!d.repartidorUid;
    g("saForzarEnt").classList.toggle("oculto", !activa);
    g("saForzarCanc").classList.toggle("oculto", !activa);
    const p = d.pedido;
    const r = g("saPedido");
    r.textContent = p && p.quiere ? "🛍️ " + cortar(p.quiere, 160) + " · de " + cortar(p.origen, 80) + " · " + (p.modo === "envia" ? "🎁 lo envía a otra persona" : "🙋 lo recibe él") + " · 📍 " + destinoTexto(p) : "";
    r.classList.toggle("oculto", !r.textContent);
  }
  function destinoTexto(p) {
    const x = p && p.destino;
    if (!x) return "sin dato";
    return x.tipo === "gps" ? "GPS en vivo" : x.tipo === "pin" ? "pin en el mapa" : cortar(x.texto || "dirección", 120);
  }

  function abrirVisor(id) {
    cerrarVisor();
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
    }, (e) => { g("saSub").textContent = "No se pudieron leer los mensajes: " + (e.code || e.message); });
  }

  function cerrarVisor() {
    if (consultaMsgs) { consultaMsgs.off(); consultaMsgs = null; }
    visorId = null;
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
    b.appendChild(el("span", "sa-h", horaDe(ts)));
    c.appendChild(b);
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
    if (f.deposito) cue.appendChild(el("div", "sa-fmeta", "Depósito: sí"));
    const lis = el("div", "sa-flis");
    normales.forEach((p) => lis.appendChild(filaF(String(p.nombre || "Producto"), dinero(p.precio))));
    cue.appendChild(lis);
    if (extras.length) {
      const ex = el("div", "sa-extras");
      ex.appendChild(el("div", "sa-extras-tit", "➕ Mandados extra"));
      extras.forEach((p) => ex.appendChild(filaF(String(p.nombre).replace(/^➕\s*/, "") || "Extra", dinero(p.precio))));
      ex.appendChild(filaF("Suma de extras", dinero(extras.reduce((t, p) => t + (Number(p.precio) || 0), 0)), "sub"));
      cue.appendChild(ex);
    }
    const tot = el("div", "sa-ftot");
    tot.appendChild(filaF("Subtotal", dinero(f.subtotal)));
    tot.appendChild(filaF(Number(f.mandadoExtra) > 0 ? "Delivery (incluye mandado extra " + dinero(f.mandadoExtra) + ")" : "Delivery", dinero(f.delivery)));
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

  /* ---------- Modo espectador: GPS del cliente y del repartidor a la vez ---------- */
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
    const caja = g("saMapaCaja"), abrir = caja.classList.contains("oculto");
    caja.classList.toggle("oculto", !abrir);
    g("saMapaBtn").setAttribute("aria-expanded", String(abrir));
    if (!abrir) return;
    if (!mapa) {
      mapa = L.map("saMapa", { zoomControl: false }).setView([12.5700, -87.1311], 13);
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" }).addTo(mapa);
    }
    setTimeout(() => { mapa.invalidateSize(); encuadrado = false; actualizarMapa(true); }, 80);
  }
  function actualizarMapa(forzar) {
    if (!mapa || !visorId || g("saMapaCaja").classList.contains("oculto")) return;
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
    partes.push(cli ? "👤 Cliente " + (vivoCli ? "en vivo (" + hace(cg.ts) + ")" : "· punto del pedido") : "👤 Cliente sin ubicación");
    partes.push(rep ? "🛵 Repartidor (" + hace(rg.ts) + ")" : "🛵 Repartidor sin señal");
    if (cli && rep) { const m = distanciaM(cli, rep); partes.push("📏 " + (m < 1000 ? Math.round(m) + " m" : (m / 1000).toFixed(1) + " km")); }
    g("saMapaInfo").textContent = partes.join(" · ");
    if (forzar || !encuadrado) {
      const pts = [cli, rep].filter(Boolean).map((p) => [p.lat, p.lng]);
      if (pts.length === 2) { mapa.fitBounds(pts, { padding: [40, 40], maxZoom: 17 }); encuadrado = true; }
      else if (pts.length === 1) mapa.setView(pts[0], 16);
    }
  }

  /* ---------- Pestaña, filtros y cierre del visor ---------- */
  function enlazar() {
    const botones = document.querySelectorAll(".tabs button");
    botones.forEach((b) => b.addEventListener("click", () => {
      const panel = g(PANEL);
      if (!panel) return;
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
      const b = e.target.closest("button[data-f]");
      if (!b) return;
      filtro = b.dataset.f;
      g("saFiltros").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      pintar();
    });
    g("saFecha").addEventListener("change", () => { fecha = g("saFecha").value || ""; pintar(); });
    g("saFechaLimpiar").addEventListener("click", () => { fecha = ""; g("saFecha").value = ""; pintar(); });
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
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && visorId) cerrarVisor(); });
    setInterval(() => { if (visorId) actualizarMapa(false); }, 10000);
  }

  if (g(PANEL)) {
    enlazar();
    if (typeof auth !== "undefined") auth.onAuthStateChange = auth.onAuthStateChange;   // (no-op)
    if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) iniciar(); else detener(); });
  }
  return { iniciar, detener, forzarEstadoSolicitud };
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
    ref.on("value", (s) => evaluar(s.val()), () => { ref = null; });
  }
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
  const btnLanzar = g("btnLanzarUpd");
  if (btnLanzar) btnLanzar.onclick = lanzar;
  vigilar();
  if (typeof auth !== "undefined") auth.onAuthStateChanged((u) => { if (u) vigilar(); });
  return { vigilar, lanzar, evaluar };
})();
