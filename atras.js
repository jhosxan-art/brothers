/* ============================================================
   BOTÓN / GESTO "ATRÁS" (Android, navegador)
   Cada "atrás" cierra la capa de arriba (chat, cámara, ventana, panel, búsqueda…)
   y nunca cierra la app mientras quede algo abierto. En la pantalla principal pide
   un segundo "atrás" para salir (así no se sale por accidente).
   ============================================================ */
const Atras = (() => {
  let capas = [], ultimo = 0, hayCentinela = false, timer = null;
  function toast(t) {
    let e = document.getElementById("toastAtras");
    if (!e) { e = document.createElement("div"); e.id = "toastAtras"; e.className = "toast-atras"; document.body.appendChild(e); }
    e.textContent = t; e.classList.add("ver");
    clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.remove("ver"), 2200);
  }
  function empujar() { history.pushState({ c: 1 }, ""); hayCentinela = true; }
  /* lista: funciones de la capa más alta a la más baja; cada una devuelve true si cerró algo */
  function iniciar(lista) {
    capas = lista;
    history.replaceState({ r: 1 }, "");
    empujar();   // entrada "centinela": el primer atrás la consume y la app sigue abierta
    addEventListener("popstate", () => {
      hayCentinela = false;
      for (const c of capas) {
        let hecho = false;
        try { hecho = !!c(); } catch (e) { console.warn("atrás:", e); }
        if (hecho) { empujar(); return; }
      }
      if (Date.now() - ultimo < 2500) return;   // segundo atrás seguido: el sistema cierra la app
      ultimo = Date.now();
      toast("Desliza atrás otra vez para salir");
      clearTimeout(timer); timer = setTimeout(() => { if (!hayCentinela) empujar(); }, 2600);
    });
  }
  return { iniciar, toast };
})();
