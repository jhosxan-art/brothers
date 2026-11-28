/* ============================================================
   PROMOCIONES · el administrador manda un push (título grande + descripción pequeña + foto) a restaurantes y/o clientes.
   Prioridad máxima (igual que los pedidos). Se envía por el Worker de Cloudflare (acción "difusion"), por lotes.
   Se carga DESPUÉS de admin.js (usa db, auth, toast y $).
   ============================================================ */
(() => {
  const URL_PUSH = "https://brothers-push.jhosxan.workers.dev";
  let foto = "", destino = "todos", enviando = false;
  const q = (id) => document.getElementById(id);
  const msg = (t, tipo) => { const e = q("prMsg"); if (!e) return; e.textContent = t || ""; e.className = "pr-msg" + (tipo ? " " + tipo : ""); };

  function pintarVista() {
    q("prVTit").textContent = q("prTit").value.trim() || "Título de la promoción";
    q("prVDesc").textContent = q("prDesc").value.trim() || "Aquí va la descripción, en letra pequeña.";
    const im = q("prVFoto"); im.style.display = foto ? "" : "none"; if (foto) im.src = foto;
    q("prCuenta").textContent = q("prTit").value.length + "/60 · " + q("prDesc").value.length + "/180";
  }

  /* Foto ancha (máx. 1024 px) en JPEG; la notificación la muestra grande */
  function reducir(file) {
    return new Promise((ok, fail) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let lado = 1024;
        for (let i = 0; i < 6; i++) {
          const k = Math.min(1, lado / Math.max(img.width, img.height));
          const c = document.createElement("canvas"); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
          const s = c.toDataURL("image/jpeg", 0.82);
          if (s.length <= 600000) return ok(s);
          lado = Math.round(lado * 0.78);
        }
        fail(new Error("La foto es demasiado pesada."));
      };
      img.onerror = () => { URL.revokeObjectURL(url); fail(new Error("No se pudo leer la imagen.")); };
      img.src = url;
    });
  }

  async function enviar() {
    if (enviando) return;
    const titulo = q("prTit").value.trim().slice(0, 60), desc = q("prDesc").value.trim().slice(0, 180);
    if (titulo.length < 3) { msg("Escribe el título (mínimo 3 letras).", "error"); return; }
    const user = auth.currentUser; if (!user) { msg("Sin sesión.", "error"); return; }
    const quien = destino === "restaurantes" ? "los RESTAURANTES" : destino === "clientes" ? "los CLIENTES" : "RESTAURANTES y CLIENTES";
    if (!confirm("¿Enviar «" + titulo + "» a " + quien + " ahora?")) return;
    enviando = true; q("prEnviar").disabled = true; msg("Guardando…");
    try {
      const id = "pr" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      if (foto) await db.ref("difusionesFoto/" + id).set(foto);
      await db.ref("difusiones/" + id).set({ titulo, desc, destino, ts: firebase.database.ServerValue.TIMESTAMP, tieneFoto: !!foto });
      let desde = 0, enviados = 0, fallidos = 0, total = 0;
      while (desde !== null) {
        const idToken = await user.getIdToken();
        const r = await fetch(URL_PUSH, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken }, body: JSON.stringify({ accion: "difusion", id, desde }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || ("Error " + r.status));
        total = j.total; enviados += j.enviados; fallidos += j.fallidos; desde = j.siguiente;
        msg("Enviando… " + Math.min(enviados + fallidos, total) + " de " + total);
      }
      await db.ref("difusiones/" + id).update({ total, enviados });
      msg(total ? "✅ Enviado a " + enviados + " de " + total + " dispositivos" + (fallidos ? " (" + fallidos + " fallaron o ya no existen)" : "") + "." : "No hay dispositivos con avisos activados todavía.", total ? "ok" : "error");
      try { toast("📣 Promoción enviada"); } catch (_) {}
    } catch (e) { msg("No se pudo enviar: " + (e && e.message ? e.message : e), "error"); }
    finally { enviando = false; q("prEnviar").disabled = false; }
  }

  function historial() {
    const ul = q("prHist"); if (!ul) return;
    db.ref("difusiones").orderByChild("ts").limitToLast(8).on("value", (s) => {
      const l = []; s.forEach((c) => { l.push(Object.assign({ id: c.key }, c.val())); });
      l.reverse();
      ul.innerHTML = l.length ? l.map((x) => `<li><strong>${String(x.titulo || "").replace(/</g, "&lt;")}</strong><small>${new Date(x.ts || 0).toLocaleString("es")} · ${x.destino === "restaurantes" ? "Restaurantes" : x.destino === "clientes" ? "Clientes" : "Todos"}${x.total != null ? " · " + (x.enviados || 0) + "/" + x.total : ""}</small></li>`).join("") : "<li><small>Aún no has enviado promociones.</small></li>";
    }, () => {});
  }

  function iniciar() {
    if (!q("prTit")) return;
    /* 6 pestañas en una sola línea (el CSS base estaba pensado para 5) */
    const st = document.createElement("style");
    st.textContent = "body.admin nav.tabs{display:grid!important;grid-auto-flow:column;grid-template-columns:none!important;grid-auto-columns:max-content;justify-content:space-between;overflow-x:auto;scrollbar-width:none}" +
      "body.admin nav.tabs button{white-space:nowrap!important;font-size:11px!important;padding:0 5px!important;letter-spacing:-.01em;line-height:1.1;overflow:visible!important;text-overflow:clip!important}" +
      "body.admin nav.tabs::-webkit-scrollbar{display:none}";
    document.head.appendChild(st);
    /* El manejador de pestañas de admin.js no conoce este panel: lo mostramos/ocultamos aquí */
    document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
      const ver = b.dataset.tab === "panelPromos", pan = q("panelPromos");
      if (ver) document.querySelectorAll("section[id^='panel']").forEach((s) => { if (s !== pan) s.classList.add("oculto"); });
      pan.classList.toggle("oculto", !ver);
    }));
    ["prTit", "prDesc"].forEach((i) => q(i).addEventListener("input", pintarVista));
    q("prDest").addEventListener("click", (e) => { const b = e.target.closest("[data-d]"); if (!b) return; destino = b.dataset.d; q("prDest").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b)); });
    q("prFotoBtn").onclick = () => q("prFoto").click();
    q("prFoto").onchange = async () => { const f = q("prFoto").files[0]; q("prFoto").value = ""; if (!f) return; try { foto = await reducir(f); q("prFotoQuitar").classList.remove("oculto"); pintarVista(); } catch (e) { msg(e.message, "error"); } };
    q("prFotoQuitar").onclick = () => { foto = ""; q("prFotoQuitar").classList.add("oculto"); pintarVista(); };
    q("prEnviar").onclick = enviar;
    pintarVista();
    auth.onAuthStateChanged((u) => { if (u) historial(); });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
