/* ============================================================
   POLICIA · alertas de retén / presencia policial (administrador y repartidores registrados)
   - Botón 🚨 → se elige: "Mi ubicación actual" o "Elegir en el mapa".
   - El reporte se guarda en  alertasPolicia/{id}  y le llega en vivo a todos
     (aviso en pantalla + voz + vibración + marcador 🚨 en el mapa).
   - Cualquiera puede confirmar "Sigue ahí" (renueva la hora) o "Ya no está" (lo quita).
   - Los reportes se ocultan solos a las 3 horas.
   Uso:  Policia.iniciar({ db, mapa: () => mapa, uid: () => uid, nombre: () => "Juan", rol: "repartidor", pos: () => ultimaPos });
         Policia.clickMapa(latlng)  → devuelve true si el toque era para marcar el retén
         Policia.pintar()           → vuelve a dibujar los marcadores (cuando el mapa se crea después)
         Policia.detener()          → al cerrar sesión
   ============================================================ */
const Policia = (() => {
  const VIDA_MS = 3 * 3600 * 1000, AVISO_MS = 45 * 1000;
  let ctx = null, ref = null, datos = {}, marcas = {}, capa = null, capaMapa = null, modoMapa = false, vistos = new Set(), timer = null, ultEnvio = 0, tToast = null;
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t == null ? "" : t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const TS = firebase.database.ServerValue.TIMESTAMP;

  function hace(ts) {
    const s = Math.max(0, Math.round((Date.now() - (ts || 0)) / 1000));
    if (s < 60) return "hace " + s + " s";
    if (s < 3600) return "hace " + Math.round(s / 60) + " min";
    return "hace " + Math.floor(s / 3600) + " h " + (Math.round(s / 60) % 60) + " min";
  }
  function distM(a, b) {
    const R = 6371000, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
    const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m");
  const vigente = (v) => v && typeof v.lat === "number" && typeof v.lng === "number" && Date.now() - (v.ts || 0) < VIDA_MS;

  /* ---------- Avisos ---------- */
  function toast(t) {
    let e = $("polToast");
    if (!e) { e = document.createElement("div"); e.id = "polToast"; e.className = "poli-toast oculto"; document.body.appendChild(e); }
    e.textContent = t; e.classList.remove("oculto");
    clearTimeout(tToast); tToast = setTimeout(() => e.classList.add("oculto"), 3500);
  }
  function banner(html, alVer) {
    let e = $("polBanner");
    if (!e) { e = document.createElement("div"); e.id = "polBanner"; e.className = "poli-banner oculto"; document.body.appendChild(e); }
    e.innerHTML = html + '<div class="poli-bt"><button type="button" class="primario" data-p="ver">Ver en el mapa</button><button type="button" class="oscuro" data-p="ok">Entendido</button></div>';
    e.classList.remove("oculto");
    e.querySelector('[data-p="ok"]').onclick = () => e.classList.add("oculto");
    e.querySelector('[data-p="ver"]').onclick = () => { e.classList.add("oculto"); alVer(); };
    clearTimeout(banner._t); banner._t = setTimeout(() => e.classList.add("oculto"), 15000);
  }
  function alertar(k, v) {
    try { if (navigator.vibrate) navigator.vibrate([300, 150, 300, 150, 300]); } catch (_) {}
    let lejos = "";
    const p = ctx.pos && ctx.pos();
    if (p && typeof p.lat === "number") lejos = " · a " + fmtDist(distM(p, v)) + " de ti";
    try { if (typeof Voz !== "undefined") Voz.hablar("Alerta. Reporte de policía de " + (v.nombre || "un repartidor")); } catch (_) {}
    banner(`<strong>🚨 Policía reportada</strong><span>${esc(v.nombre || "Un repartidor")} · ${hace(v.ts)}${lejos}</span>`, () => verEnMapa(k));
  }
  function verEnMapa(k) {
    const m = ctx.mapa && ctx.mapa(), v = datos[k]; if (!m || !v) return;
    if (typeof ctx.alVer === "function") ctx.alVer();   // el repartidor vuelve a la vista del mapa
    m.setView([v.lat, v.lng], Math.max(m.getZoom(), 16));
    setTimeout(() => { if (marcas[k]) marcas[k].openPopup(); }, 250);
  }

  /* ---------- Marcadores ---------- */
  function icono(v) {
    return L.divIcon({ className: "", html: `<div class="pin-poli"><b>🚨</b></div><span class="etq-poli">Policía<small>${esc(hace(v.ts))}</small></span>`, iconSize: [38, 38], iconAnchor: [19, 19] });
  }
  function popup(k) {
    const v = datos[k]; if (!v) return "";
    return `<div class="pop-rep"><strong>🚨 Reporte de policía</strong>
      <small>Lo reportó <b>${esc(v.nombre || "un repartidor")}</b> · ${esc(hace(v.ts))}${v.tipo === "mapa" ? " · punto marcado en el mapa" : " · su ubicación"}</small>
      ${v.confirmadoPor ? `<small>Confirmado por ${esc(v.confirmadoPor)}</small>` : ""}
      <div class="acciones-fila"><button class="mini pri" data-po="sigue" data-k="${esc(k)}" type="button">✔ Sigue ahí</button>
      <button class="mini peligro" data-po="no" data-k="${esc(k)}" type="button">✖ Ya no está</button></div></div>`;
  }
  function pintar() {
    const m = ctx && ctx.mapa && ctx.mapa(); if (!m) return;
    if (capa && capaMapa !== m) { capa = null; marcas = {}; }
    if (!capa) { capa = L.layerGroup().addTo(m); capaMapa = m; }
    Object.keys(marcas).forEach((k) => { if (!vigente(datos[k])) { capa.removeLayer(marcas[k]); delete marcas[k]; } });
    Object.keys(datos).forEach((k) => {
      const v = datos[k]; if (!vigente(v)) return;
      if (!marcas[k]) {
        const mk = L.marker([v.lat, v.lng], { icon: icono(v), zIndexOffset: 900 }).addTo(capa);
        mk.bindPopup(() => popup(k), { offset: [0, -20], minWidth: 220 });
        mk.on("popupopen", (e) => {
          const el = e.popup.getElement(); if (!el) return;
          el.querySelectorAll("button[data-po]").forEach((b) => b.onclick = () => { mk.closePopup(); responder(b.dataset.k, b.dataset.po); });
        });
        marcas[k] = mk;
      } else { marcas[k].setLatLng([v.lat, v.lng]); marcas[k].setIcon(icono(v)); }
    });
  }
  function responder(k, acc) {
    if (!datos[k]) return;
    if (acc === "sigue") ref.child(k).update({ ts: TS, confirmadoPor: ctx.nombre() }).then(() => toast("Gracias, el aviso se renovó ✓")).catch((e) => toast("No se pudo: " + e.message));
    else if (confirm("¿Confirmas que la policía YA NO está ahí? Se quitará el aviso para todos.")) ref.child(k).remove().then(() => toast("Aviso quitado ✓")).catch((e) => toast("No se pudo: " + e.message));
  }

  /* ---------- Reportar ---------- */
  function enviar(lat, lng, tipo) {
    if (Date.now() - ultEnvio < 15000) return toast("Espera unos segundos antes de reportar otra vez.");
    ultEnvio = Date.now();
    const dato = { lat: +lat.toFixed(6), lng: +lng.toFixed(6), ts: TS, uid: ctx.uid(), nombre: ctx.nombre(), rol: ctx.rol || "repartidor", tipo };
    ref.push(dato).then(() => toast("🚨 Reporte enviado a todos los repartidores ✓")).catch((e) => { ultEnvio = 0; toast("No se pudo enviar: " + e.message); });
  }
  function obtenerPos() {
    return new Promise((ok, mal) => {
      const p = ctx.pos && ctx.pos();
      if (p && typeof p.lat === "number" && Date.now() - (p.ts || Date.now()) < 120000) return ok({ lat: p.lat, lng: p.lng });
      if (!navigator.geolocation) return mal(new Error("Este aparato no da la ubicación."));
      navigator.geolocation.getCurrentPosition((g) => ok({ lat: g.coords.latitude, lng: g.coords.longitude }), () => mal(new Error("No se pudo obtener tu ubicación. Elige el punto en el mapa.")), { enableHighAccuracy: true, timeout: 10000, maximumAge: 15000 });
    });
  }
  function cerrarHoja() { const e = $("polHoja"); if (e) e.remove(); }
  function abrirOpciones() {
    if (!ref) return;
    cerrarHoja(); terminarModoMapa();
    const e = document.createElement("div"); e.id = "polHoja"; e.className = "poli-fondo";
    e.innerHTML = `<div class="poli-hoja" role="dialog" aria-label="Reportar policía">
      <h2>🚨 Reportar policía</h2>
      <p class="ayuda">Les llegará una alerta con la ubicación a los demás repartidores.</p>
      <button type="button" class="primario" data-p="actual">📍 Mi ubicación actual</button>
      <button type="button" data-p="mapa">🗺 Elegir en el mapa dónde está el retén</button>
      <button type="button" class="oscuro" data-p="no">Cancelar</button></div>`;
    document.body.appendChild(e);
    e.onclick = (ev) => { if (ev.target === e) cerrarHoja(); };
    e.querySelector('[data-p="no"]').onclick = cerrarHoja;
    e.querySelector('[data-p="actual"]').onclick = () => {
      cerrarHoja(); toast("Buscando tu ubicación…");
      obtenerPos().then((p) => enviar(p.lat, p.lng, "actual")).catch((er) => toast(er.message));
    };
    e.querySelector('[data-p="mapa"]').onclick = () => { cerrarHoja(); iniciarModoMapa(); };
  }
  function iniciarModoMapa() {
    if (typeof ctx.alVer === "function") ctx.alVer();
    modoMapa = true;
    let a = $("polAviso");
    if (!a) { a = document.createElement("div"); a.id = "polAviso"; a.className = "poli-aviso oculto"; document.body.appendChild(a); }
    a.innerHTML = '<span>🚨 Toca el mapa donde está el retén</span><button type="button" class="oscuro">Cancelar</button>';
    a.querySelector("button").onclick = terminarModoMapa;
    a.classList.remove("oculto");
    const b = $("btnPolicia"); if (b) b.classList.add("activo");
  }
  function terminarModoMapa() {
    modoMapa = false;
    const a = $("polAviso"); if (a) a.classList.add("oculto");
    const b = $("btnPolicia"); if (b) b.classList.remove("activo");
  }
  /* Devuelve true si el toque en el mapa era para marcar el retén (el resto de acciones del mapa se saltan) */
  function clickMapa(ll) {
    if (!modoMapa) return false;
    terminarModoMapa();
    if (confirm("¿Reportar la policía en este punto del mapa?")) enviar(ll.lat, ll.lng, "mapa");
    return true;
  }

  /* ---------- Arranque / parada ---------- */
  function iniciar(c) {
    detener(); ctx = c; vistos = new Set(); datos = {};
    ref = c.db.ref("alertasPolicia");
    const q = ref.orderByChild("ts").startAt(Date.now() - VIDA_MS);
    q.on("child_added", (s) => {
      const v = s.val(), k = s.key; datos[k] = v; pintar();
      if (!vistos.has(k)) {
        vistos.add(k);
        if (vigente(v) && Date.now() - v.ts < AVISO_MS && v.uid !== ctx.uid()) alertar(k, v);
      }
    }, () => {});
    q.on("child_changed", (s) => { datos[s.key] = s.val(); pintar(); });
    q.on("child_removed", (s) => { delete datos[s.key]; pintar(); });
    ref._q = q;
    const b = $("btnPolicia"); if (b) b.onclick = abrirOpciones;
    timer = setInterval(pintar, 60000);   // oculta los vencidos y actualiza el "hace X min"
    pintar();
  }
  function detener() {
    if (ref && ref._q) ref._q.off();
    if (timer) { clearInterval(timer); timer = null; }
    if (capa) { try { capa.clearLayers(); capa.remove(); } catch (_) {} }
    capa = null; capaMapa = null; marcas = {}; datos = {}; ref = null;
    terminarModoMapa(); cerrarHoja();
    ["polBanner", "polToast"].forEach((i) => { const e = $(i); if (e) e.classList.add("oculto"); });
  }
  return { iniciar, detener, pintar, clickMapa, abrir: () => abrirOpciones(), enModoMapa: () => modoMapa };
})();
