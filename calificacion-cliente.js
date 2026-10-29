/* ============================================================
   CALIFICACION-CLIENTE · al ENTREGAR el pedido, se le pide al cliente que califique la atención del repartidor.
   Instalación: en rastreo.html, justo antes de </body> (después de firebase-config.js y aviso-cliente.js):
       <script src="calificacion-cliente.js"></script>
   Lee pedidos/{token}/estado; cuando pasa a "entregado" muestra 1 a 5 estrellas + comentario opcional
   y lo guarda en calificaciones/{token}  (una sola vez por pedido).
   ============================================================ */
(() => {
  const t = new URLSearchParams(location.search).get("id"); if (!t || typeof firebase === "undefined") return;
  const db = (typeof APP !== "undefined" ? APP : firebase.app()).database();
  const clave = "calif_" + t;
  const guardado = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch (_) { return null; } };
  const sesion = (k, v) => { try { return v === undefined ? sessionStorage.getItem(k) : sessionStorage.setItem(k, v); } catch (_) { return null; } };
  if (guardado(clave)) return;   // ya calificó este pedido
  const TEXTOS = ["", "Muy mala atención", "Mala atención", "Regular", "Buena atención", "¡Excelente atención!"];
  let abierto = false;

  function abrir(ped) {
    if (abierto || guardado(clave) || sesion(clave)) return; abierto = true;
    const f = document.createElement("div");
    f.style.cssText = "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:flex-end;justify-content:center;font-family:system-ui,sans-serif";
    f.innerHTML = `<div style="width:100%;max-width:440px;background:#fff;border-radius:20px 20px 0 0;padding:20px 18px calc(18px + env(safe-area-inset-bottom));box-sizing:border-box;text-align:center">
      <div style="font-size:34px">📦✅</div>
      <h2 style="margin:6px 0 2px;font-size:20px">¡Tu pedido fue entregado!</h2>
      <p style="margin:0 0 12px;color:#555;font-size:15px">¿Cómo fue la atención${ped && ped.repartidorNombre ? " de <b>" + String(ped.repartidorNombre).replace(/[<>&]/g, "") + "</b>" : " del repartidor"}?</p>
      <div id="calEst" style="display:flex;justify-content:center;gap:6px"></div>
      <div id="calTxt" style="min-height:22px;margin:6px 0 8px;font-weight:700;color:#b45309"></div>
      <textarea id="calCom" maxlength="300" rows="3" placeholder="Comentario (opcional)" style="width:100%;box-sizing:border-box;border:2px solid #ddd;border-radius:12px;padding:10px;font:inherit;resize:none"></textarea>
      <button id="calOk" type="button" disabled style="width:100%;margin-top:10px;border:0;border-radius:12px;padding:13px;font:700 16px system-ui;background:#0A86C9;color:#fff;opacity:.5">Enviar calificación</button>
      <button id="calNo" type="button" style="width:100%;margin-top:6px;border:0;background:none;padding:10px;font:600 14px system-ui;color:#666">Ahora no</button></div>`;
    document.body.appendChild(f);
    const caja = f.querySelector("#calEst"), txt = f.querySelector("#calTxt"), ok = f.querySelector("#calOk");
    let n = 0;
    const pinta = () => {
      caja.querySelectorAll("button").forEach((b, i) => { b.textContent = i < n ? "★" : "☆"; b.style.color = i < n ? "#F59E0B" : "#bbb"; });
      txt.textContent = TEXTOS[n]; ok.disabled = !n; ok.style.opacity = n ? "1" : ".5";
    };
    for (let i = 1; i <= 5; i++) {
      const b = document.createElement("button"); b.type = "button"; b.setAttribute("aria-label", i + " estrella" + (i > 1 ? "s" : ""));
      b.style.cssText = "border:0;background:none;font-size:42px;line-height:1;padding:0 2px;cursor:pointer";
      b.onclick = () => { n = i; pinta(); };
      caja.appendChild(b);
    }
    pinta();
    f.querySelector("#calNo").onclick = () => { sesion(clave, "1"); f.remove(); abierto = false; };
    ok.onclick = () => {
      if (!n) return; ok.disabled = true; ok.textContent = "Enviando…";
      const d = { estrellas: n, ts: firebase.database.ServerValue.TIMESTAMP };
      const c = f.querySelector("#calCom").value.trim(); if (c) d.comentario = c.slice(0, 300);
      if (ped) { if (ped.repartidorUid) d.repartidorUid = ped.repartidorUid; if (ped.repartidorNombre) d.repartidorNombre = String(ped.repartidorNombre).slice(0, 60); if (ped.pedido) d.pedido = String(ped.pedido).slice(0, 30); }
      db.ref("calificaciones/" + t).set(d).then(() => {
        guardado(clave, "1");
        f.querySelector("div").innerHTML = '<div style="font-size:42px">🙏</div><h2 style="margin:8px 0">¡Gracias por tu calificación!</h2><button id="calCerrar" type="button" style="margin-top:8px;border:0;border-radius:12px;padding:12px 22px;font:700 15px system-ui;background:#111;color:#fff">Cerrar</button>';
        f.querySelector("#calCerrar").onclick = () => f.remove();
        setTimeout(() => f.remove(), 4000);
      }).catch(() => { ok.disabled = false; ok.textContent = "Enviar calificación"; txt.textContent = "No se pudo enviar. Intenta de nuevo."; });
    };
  }
  db.ref("pedidos/" + t + "/estado").on("value", (s) => {
    if (s.val() !== "entregado") return;
    db.ref("pedidos/" + t).once("value").then((p) => setTimeout(() => abrir(p.val() || {}), 2500)).catch(() => {});   // deja oír primero el aviso de "entregado"
  });
})();
