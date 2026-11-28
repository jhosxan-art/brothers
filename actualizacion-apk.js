/* ============================================================
   ACTUALIZACIÓN OBLIGATORIA DEL APK · apps RESTAURANTE y CLIENTE
   - El administrador publica la versión desde su panel («Lanzar actualización»): configuracion/actualizaciones/{restaurante|cliente}
   - Solo actúa dentro del APK (Capacitor). En la web (navegador / GitHub Pages) nunca muestra ni bloquea nada.
   - Descarga el APK dentro de la app y abre el instalador del sistema (si faltan los plugins, abre el enlace en el navegador).
   Uso: cada HTML define window.APK_APP = "restaurante" | "cliente" y carga apk-version.js (lo escribe el workflow).
   ============================================================ */
(() => {
  const APP_ID = String(window.APK_APP || "").trim();
  if (!/^(restaurante|cliente)$/.test(APP_ID)) return;
  const C = window.Capacitor;
  const esApk = () => { const c = window.Capacitor; return !!(c && ((c.isNativePlatform && c.isNativePlatform()) || (c.getPlatform && c.getPlatform() !== "web"))); };
  if (!esApk()) return;                                  // web: no hace nada
  const MI_VERSION = Number(window.APK_VERSION) || 0;
  const plug = (n) => (window.Capacitor && window.Capacitor.Plugins ? window.Capacitor.Plugins[n] : null);
  const urlSegura = (u) => { try { const x = new URL(String(u || "").trim()); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch (_) { return ""; } };
  function enlaceDirecto(u) {
    const url = urlSegura(u); if (!url) return "";
    try {
      const x = new URL(url);
      if (/(^|\.)drive\.google\.com$/.test(x.hostname)) {
        const m = x.pathname.match(/\/file\/d\/([^/]+)/), id = (m && m[1]) || x.searchParams.get("id");
        if (id) return "https://drive.google.com/uc?export=download&id=" + encodeURIComponent(id);
      }
      if (/(^|\.)dropbox\.com$/.test(x.hostname)) { x.searchParams.delete("dl"); x.searchParams.set("dl", "1"); return x.href; }
    } catch (_) {}
    return url;
  }
  const abrirNavegador = (url) => { try { window.open(url, "_system"); } catch (_) { window.location.href = url; } };

  let caja = null, enCurso = false;
  function construir() {
    if (caja) return caja;
    const st = document.createElement("style");
    st.textContent = "#apkUpd{position:fixed;inset:0;z-index:2147483000;background:rgba(10,20,30,.92);display:flex;align-items:center;justify-content:center;padding:20px;font-family:system-ui,sans-serif}" +
      "#apkUpd.oculto{display:none}#apkUpd .c{background:#fff;color:#0E141B;border-radius:22px;padding:22px 18px;width:100%;max-width:380px;text-align:center;display:grid;gap:10px}" +
      "#apkUpd h2{margin:0;font-size:22px}#apkUpd .n{background:#F3F6F9;border-radius:12px;padding:10px;font-size:14px;text-align:left;white-space:pre-wrap}" +
      "#apkUpd .v{font-size:12px;opacity:.7}#apkUpd a.b{display:block;background:#FF6A00;color:#fff;font-weight:800;font-size:17px;padding:15px;border-radius:14px;text-decoration:none}" +
      "#apkUpd a.b[aria-disabled=true]{opacity:.5}#apkUpd .p{height:10px;background:#E4E9EE;border-radius:6px;overflow:hidden}#apkUpd .p.oculto{display:none}#apkUpd .p i{display:block;height:100%;width:0;background:#1E9B5A}";
    document.head.appendChild(st);
    caja = document.createElement("div"); caja.id = "apkUpd"; caja.className = "oculto"; caja.setAttribute("role", "alertdialog"); caja.setAttribute("aria-modal", "true");
    caja.innerHTML = '<div class="c"><div style="font-size:42px">🚀</div><h2>¡Actualización disponible!</h2><div>Para seguir usando la app debes instalar la nueva versión.</div>' +
      '<div class="n" id="apkUpdNov"></div><a class="b" id="apkUpdBtn" href="#">ACTUALIZA TU APP</a><div class="p oculto" id="apkUpdProg"><i id="apkUpdBar"></i></div><div class="v" id="apkUpdEst" role="status"></div><div class="v" id="apkUpdVer"></div></div>';
    document.body.appendChild(caja);
    return caja;
  }
  const g = (id) => document.getElementById(id);

  async function actualizarApp(url, btn) {
    if (enCurso) return;
    const FS = plug("Filesystem"), FO = plug("FileOpener");
    if (!FS || !FO || !FS.downloadFile) return abrirNavegador(url);
    const ARCHIVO = "brothers-" + APP_ID + "-update.apk", DIR = "CACHE", txt = btn.textContent;
    const est = (t) => { g("apkUpdEst").textContent = t || ""; };
    const avance = (pc) => { g("apkUpdBar").style.width = pc + "%"; };
    let escucha = null; enCurso = true; btn.setAttribute("aria-disabled", "true");
    try {
      g("apkUpdProg").classList.remove("oculto"); avance(0); btn.textContent = "DESCARGANDO… 0 %"; est("Descargando la actualización. No cierres la app.");
      try { await FS.deleteFile({ path: ARCHIVO, directory: DIR }); } catch (_) {}
      try { escucha = await FS.addListener("progress", (p) => { if (!p || (p.url && p.url !== url) || !(p.contentLength > 0)) return; const pc = Math.min(100, Math.round((p.bytes / p.contentLength) * 100)); avance(pc); btn.textContent = "DESCARGANDO… " + pc + " %"; }); } catch (_) {}
      await FS.downloadFile({ url, path: ARCHIVO, directory: DIR, progress: true });
      const s = await FS.stat({ path: ARCHIVO, directory: DIR });
      if (!s || Number(s.size) < 300000) throw new Error("El enlace no descargó un APK.");
      avance(100); btn.textContent = "INSTALANDO…"; est("Descarga lista. Acepta la ventana de instalación del sistema.");
      const { uri } = await FS.getUri({ path: ARCHIVO, directory: DIR });
      await FO.open({ filePath: uri, contentType: "application/vnd.android.package-archive", openWithDefault: true });
      est("Si no aparece el instalador, toca el botón otra vez. Si el sistema lo pide, permite instalar apps desde esta app.");
    } catch (err) {
      console.warn("Actualización APK:", err);
      est("No se pudo instalar dentro de la app. Abriendo la descarga en el navegador…");
      setTimeout(() => abrirNavegador(url), 1200);
    } finally {
      try { if (escucha && escucha.remove) await escucha.remove(); } catch (_) {}
      enCurso = false; btn.removeAttribute("aria-disabled"); btn.textContent = txt;
      setTimeout(() => g("apkUpdProg").classList.add("oculto"), 1500);
    }
  }
  function mostrar(d) {
    const c = construir(), url = enlaceDirecto(d.url), btn = g("apkUpdBtn");
    g("apkUpdNov").textContent = String(d.novedades || "").trim() || "Mejoras de rendimiento y correcciones.";
    g("apkUpdVer").textContent = "Tu versión: " + MI_VERSION + " · Nueva versión: " + Number(d.version);
    if (url) { btn.href = url; btn.removeAttribute("aria-disabled"); btn.onclick = (e) => { e.preventDefault(); actualizarApp(url, btn); }; }
    else { btn.removeAttribute("href"); btn.setAttribute("aria-disabled", "true"); btn.onclick = (e) => e.preventDefault(); }
    c.classList.remove("oculto");
  }
  function ocultar() { if (caja) caja.classList.add("oculto"); }
  const evaluar = (d) => { if (d && Number(d.version) > MI_VERSION) mostrar(d); else ocultar(); };

  let ref = null;
  function vigilar() {
    if (ref || typeof APP === "undefined") return;
    ref = APP.database().ref("configuracion/actualizaciones/" + APP_ID);
    ref.on("value", (s) => evaluar(s.val()), () => { try { ref.off(); } catch (_) {} ref = null; setTimeout(vigilar, 15000); });
  }
  const iniciar = () => { try { APP.auth().onAuthStateChanged((u) => { if (u) vigilar(); else if (ref) { try { ref.off(); } catch (_) {} ref = null; } }); } catch (_) {} };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", iniciar); else iniciar();
})();
