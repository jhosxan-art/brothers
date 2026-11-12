
/* ============================================================================
   admin-spa.js · FASE 2 · SPA + Responsividad Universal
   ----------------------------------------------------------------------------
   ARQUITECTURA:
   El archivo atras.js + el wrapper en admin.html YA manejan el botón Atrás:
     Atras.iniciar([...])  →  cadena que cierra: chat → NavAdmin.atras() → ...
   
   Este módulo NO registra popstate propio. Su única función es llamar
   history.pushState() cada vez que se abre una subvista, para que el botón
   Atrás FÍSICO del navegador/Android dispare popstate → atras.js → cadena.
   ========================================================================== */
(function () {
  'use strict';

  /* ─── A. Push state cuando una subvista se abre ────────────────────── */
  function push(id) {
    try {
      history.pushState({ __spa: true, id: String(id || 'anon'), ts: Date.now() }, '', location.href);
    } catch (e) { console.warn('[SPA] pushState falló:', e); }
  }

  /* ─── B. Observador de elementos que se abren/cierran por clase ────── */
  function observarElementos() {
    const SELECTORES = '.modal-rep, .panel-cliente, .barra-zona';
    const obs = new MutationObserver((ms) => {
      ms.forEach((m) => {
        if (m.type !== 'attributes' || m.attributeName !== 'class') return;
        const el = m.target;
        if (!el.classList) return;
        const esModal = el.classList.contains('modal-rep');
        const esPanel = el.classList.contains('panel-cliente');
        const esZona  = el.classList.contains('barra-zona');
        if (!esModal && !esPanel && !esZona) return;
        const abierto = !el.classList.contains('oculto');
        if (!abierto) return;
        const pref = esModal ? 'modal:' : esPanel ? 'panel:' : 'zona:';
        push(pref + (el.id || 'anon'));
      });
    });
    document.querySelectorAll(SELECTORES).forEach((el) => {
      obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    });
  }

  /* ─── C. Hook de Chat.iniciar (crea .chat dinámicamente) ───────────── */
  function hookChat() {
    if (typeof Chat === 'undefined' || !Chat || typeof Chat.iniciar !== 'function') {
      return setTimeout(hookChat, 300);
    }
    if (Chat.__spaHooked) return;
    const orig = Chat.iniciar;
    Chat.iniciar = function (opts) {
      const res = orig.apply(this, arguments);
      try {
        if (opts && opts.yo === 'admin') push('chat:' + (opts.token || 'admin'));
      } catch (_) {}
      return res;
    };
    Chat.__spaHooked = true;
  }

  /* ─── D. Hook Capacitor backButton (por si atras.js no lo registró) ── */
  function instalarBackButtonNativo() {
    const C = window.Capacitor;
    if (!C) return;
    const App = (C.Plugins && C.Plugins.App) || (C.registerPlugin && C.registerPlugin('App'));
    if (!App || !App.addListener || App.__spaBack) return;
    App.__spaBack = true;
    try {
      App.addListener('backButton', () => {
        if (typeof Atras !== 'undefined' && typeof Atras.atras === 'function') {
          if (Atras.atras()) return;
        }
        if (App.exitApp) App.exitApp();
      });
    } catch (e) { console.warn('[SPA] backButton:', e); }
  }

  /* ─── E. Responsividad universal ───────────────────────────────────── */
  function aplicarResponsividad() {
    const setVar = (k, v) => document.documentElement.style.setProperty(k, v);
    const vv = window.visualViewport;
    if (vv) {
      setVar('--vvh', Math.round(vv.height) + 'px');
      setVar('--vvt', Math.round(vv.offsetTop) + 'px');
      vv.addEventListener('resize', () => {
        setVar('--vvh', Math.round(vv.height) + 'px');
        setVar('--vvt', Math.round(vv.offsetTop) + 'px');
      });
      vv.addEventListener('scroll', () => setVar('--vvt', Math.round(vv.offsetTop) + 'px'));
    }
    const clasificar = () => {
      const w = window.innerWidth;
      const b = w <= 480 ? 'xs' : w <= 700 ? 'sm' : w <= 1099 ? 'md' : w <= 1599 ? 'lg' : 'xl';
      if (document.body.dataset.bp !== b) document.body.dataset.bp = b;
    };
    clasificar();
    window.addEventListener('resize', clasificar, { passive: true });
    document.body.classList.add('spa-responsivo-activo');
  }

  /* ─── F. API pública (para compatibilidad con otros módulos) ───────── */
  window.SPA = {
    push,
    abrirChatRep:         (uid) => push('chat:' + uid),
    abrirDetalleFactura:  (tok) => push('factura:' + tok),
    abrirLecturaSolicitud:(id)  => push('solicitud:' + id),
    abrirSubPanel:        (nom) => push('subpanel:' + nom),
  };

  /* ─── G. Init ──────────────────────────────────────────────────────── */
  function init() {
    observarElementos();
    hookChat();
    instalarBackButtonNativo();
    aplicarResponsividad();
    console.log('[SPA] admin-spa.js · FASE 2 listo');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
