/* ============================================================
   PUSH-ADMIN · el panel del administrador manda avisos push (FCM) al celular del repartidor
   - Funcionan con la app CERRADA o con la pantalla apagada.
   - Se envían a través de tu "Worker" gratuito de Cloudflare (archivo push-worker.js), porque Firebase
     NO permite mandar push directo desde el navegador sin exponer una llave secreta.
   - El Worker comprueba que quien pide el envío es un administrador (con su sesión de Firebase).

   PASO ÚNICO AQUÍ: pega abajo la dirección de tu Worker (la ves al publicarlo en Cloudflare).
   Mientras tenga "TU-WORKER" no se envía nada y el resto del panel funciona igual.
   Usa: PushAdmin.pedidoAsignado(uid, orden) · PushAdmin.mensaje(uid, { texto, foto }) · PushAdmin.guia(uid, nombre) · PushAdmin.punto(uid, "retiro"|"entrega")
   NUEVO · WhatsApp: PushAdmin.pedidoAsignado(...) también le manda por WhatsApp (Cloud API de Meta, a través del mismo Worker)
           el mensaje "Tienes un nuevo pedido en la app. Detalles: ..." al número que guardaste en el repartidor (campo Teléfono).
           El token de Meta NO está aquí: vive como Secret en Cloudflare (WA_TOKEN y WA_PHONE_ID).
   NUEVO · Pedidos de clientes (solicitudes_entrantes): PushAdmin.solicitud(evento, texto, solicitudId) con evento
           nuevo | tomado | entrega | entregado | cancelado. Manda el aviso a los OTROS celulares/tablets de esta misma cuenta de
           administrador (tokens en admin_tokens), por el mismo Worker. En el aparato que detecta el cambio el aviso ya sale por
           voz + toast + notificación local (ordenes-admin.js).
           LIMITE: con la app de ESTE aparato cerrada no hay quién detecte el cambio. Eso requiere un disparador de servidor
           (Worker/Cloud Function que escuche solicitudes_entrantes y avise a admin_tokens) que aún no existe en el proyecto.
   Se carga DESPUÉS de admin.js (usa sus globales: db, auth, toast).
   ============================================================ */
const PushAdmin = (() => {
  const URL_PUSH = "https://brothers-push.jhosxan.workers.dev";   // ← PEGA AQUÍ la dirección de tu Worker de Cloudflare

  const configurado = () => !/TU-WORKER/.test(URL_PUSH);
  const recorta = (t, n) => { t = String(t == null ? "" : t); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
  let avisoConfig = false, ultAvisoError = 0;
  const ultimos = {};   // para no repetir el mismo aviso en pocos segundos

  function falla(txt) {
    console.warn("PushAdmin:", txt);
    if (Date.now() - ultAvisoError < 60000) return;   // un solo aviso por minuto, para no molestar
    ultAvisoError = Date.now();
    try { toast("⚠️ El aviso push no se pudo enviar (" + txt + "). El repartidor lo verá igual al abrir la app."); } catch (_) {}
  }

  /* Envía un aviso al repartidor registrado `uid`. Nunca lanza error: devuelve true/false. */
  async function enviar(uid, a) {
    try {
      if (!uid || String(uid).indexOf("inv_") === 0) return false;   // los invitados no tienen push
      if (!configurado()) {
        if (!avisoConfig) { avisoConfig = true; console.warn("PushAdmin: falta pegar la dirección del Worker en push-admin.js (URL_PUSH)."); }
        return false;
      }
      const clave = uid + "|" + a.tipo + "|" + (a.cuerpo || "");
      if (ultimos[clave] && Date.now() - ultimos[clave] < 4000) return false;
      ultimos[clave] = Date.now();

      const tk = (await db.ref("repartidores/" + uid + "/fcmToken").once("value")).val();
      if (!tk) return false;   // ese repartidor aún no tiene la app con push instalada
      const user = auth.currentUser; if (!user) return false;
      const idToken = await user.getIdToken();

      const r = await fetch(URL_PUSH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body: JSON.stringify({
          urgency: "high", ttl: 86400, token: tk, titulo: recorta(a.titulo, 80), cuerpo: recorta(a.cuerpo, 240), canal: a.canal || "pedidos",
          data: Object.assign({ tipo: a.tipo }, a.data || {})
        })
      });
      let j = {}; try { j = await r.json(); } catch (_) {}
      if (r.ok && j.ok) return true;
      if (j && (j.code === "UNREGISTERED" || j.code === "INVALID_ARGUMENT")) {   // ese celular ya no existe: se limpia su token viejo
        db.ref("repartidores/" + uid + "/fcmToken").remove().catch(() => {});
        return false;
      }
      falla((j && j.error) || ("error " + r.status));
      return false;
    } catch (err) {
      falla(err && err.message ? err.message : "sin conexión");
      return false;
    }
  }

  /* ---------- WhatsApp Cloud API (vía Worker) ---------- */
  const telefonoDe = (uid) => {
    const r = (typeof registrados !== "undefined" && registrados) ? registrados[uid] : null;
    return r && typeof r === "object" && r.telefono ? String(r.telefono).replace(/\D+/g, "") : "";
  };
  function resumenPedido(o) {
    o = o || {};
    let ps = []; try { ps = Ordenes.paradas(o); } catch (_) {}
    const retiros = ps.map((p) => (p.texto || "") + (p.producto ? " (" + p.producto + ")" : "")).filter(Boolean).join(" + ");
    let precio = ""; try { precio = Ordenes.textoDelivery(o); } catch (_) {}
    return [
      "Pedido " + (o.codigo || ""),
      o.cliente ? "Cliente: " + o.cliente : "",
      retiros ? "Retiro: " + retiros : "",
      o.entrega && o.entrega.texto ? "Entrega: " + o.entrega.texto : "",
      precio ? "Delivery: " + precio : "",
      o.paquete ? "Paquete: " + o.paquete : ""
    ].filter(Boolean).join(" | ");
  }
  /* Nunca lanza error: devuelve true/false. Si el repartidor no tiene teléfono guardado, no hace nada. */
  async function whatsappPedido(uid, o) {
    try {
      if (!uid || String(uid).indexOf("inv_") === 0) return false;
      const tel = telefonoDe(uid);
      if (!tel) return false;   // ese repartidor aún no tiene su WhatsApp guardado en el panel (pestaña Equipo)
      if (!configurado()) return false;
      const clave = uid + "|wa|" + (o && o.codigo || "");
      if (ultimos[clave] && Date.now() - ultimos[clave] < 4000) return false;
      ultimos[clave] = Date.now();
      const user = auth.currentUser; if (!user) return false;
      const idToken = await user.getIdToken();
      const r = await fetch(URL_PUSH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
        body: JSON.stringify({ accion: "whatsapp", telefono: tel, resumen: recorta(resumenPedido(o), 900) })
      });
      let j = {}; try { j = await r.json(); } catch (_) {}
      if (r.ok && j.ok) { try { toast("WhatsApp enviado al repartidor ✓"); } catch (_) {} return true; }
      falla("WhatsApp: " + ((j && j.error) || ("error " + r.status)));
      return false;
    } catch (err) {
      falla("WhatsApp: " + (err && err.message ? err.message : "sin conexión"));
      return false;
    }
  }

  /* ---------- Avisos listos para usar ---------- */
  function pedidoAsignado(uid, o) {
    o = o || {};
    whatsappPedido(uid, o);   // además del push: WhatsApp al número del repartidor
    const ps = (typeof Ordenes !== "undefined" && Ordenes.paradas) ? Ordenes.paradas(o) : [];
    const retiro = ps[0] && ps[0].texto ? "Retiro: " + ps[0].texto : "Revisa los detalles";
    let precio = ""; try { precio = Ordenes.textoDelivery(o); } catch (_) {}
    return enviar(uid, { tipo: "pedido", canal: "pedidos", titulo: "🛵 Nuevo pedido " + (o.codigo || ""), cuerpo: (precio ? precio + " · " : "") + retiro, data: { ordenId: o.token || "" } });
  }
  function mensaje(uid, m) {
    m = m || {};
    return enviar(uid, { tipo: "mensaje", canal: "mensajes", titulo: "💬 Mensaje de Brothers", cuerpo: m.texto ? m.texto : (m.foto ? "📷 Te envió una foto" : "Tienes un mensaje nuevo") });
  }
  function guia(uid, nombre) {
    return enviar(uid, { tipo: "guia", canal: "pedidos", titulo: "📍 Nueva guía de Brothers", cuerpo: nombre ? "Te indicó ir a " + nombre : "Te marcó un punto en el mapa" });
  }
  function punto(uid, p) {
    return enviar(uid, { tipo: "guia", canal: "pedidos", titulo: "📍 Nuevo punto de " + (p === "entrega" ? "entrega" : "retiro"), cuerpo: "Brothers te marcó un punto. Su ruta se traza sola." });
  }

  /* ---------- NUEVO · Avisos de pedidos de clientes (solicitudes_entrantes) ---------- */
  const EVENTOS_SOL = {
    nuevo:     { tipo: "sol_nuevo",     titulo: "📥 Nuevo pedido de cliente" },
    tomado:    { tipo: "sol_tomado",    titulo: "🛵 Pedido tomado" },
    entrega:   { tipo: "sol_entrega",   titulo: "📍 Va a entregar" },
    entregado: { tipo: "sol_entregado", titulo: "✅ Pedido entregado" },
    cancelado: { tipo: "sol_cancelado", titulo: "🚫 Pedido cancelado" }
  };
  async function llamarWorker(cuerpo) {
    const user = auth.currentUser; if (!user) return { ok: false, error: "sin sesión" };
    const idToken = await user.getIdToken();
    const r = await fetch(URL_PUSH, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + idToken },
      body: JSON.stringify(Object.assign({ urgency: "high", ttl: 86400 }, cuerpo))
    });
    let j = {}; try { j = await r.json(); } catch (_) {}
    return { ok: !!(r.ok && j && j.ok), code: j && j.code, error: (j && j.error) || ("error " + r.status) };
  }
  /* Tokens de los demás dispositivos de esta cuenta de administrador (excluye el aparato actual). */
  async function otrosDispositivosAdmin() {
    const u = auth.currentUser; if (!u) return [];
    const propia = (typeof adminPushClave !== "undefined") ? adminPushClave : null;
    const t = (await db.ref("admin_tokens/" + u.uid).once("value")).val() || {};
    return Object.keys(t).filter((k) => k !== propia && t[k] && typeof t[k].token === "string" && t[k].token.length >= 20)
      .map((k) => ({ clave: k, token: t[k].token }));
  }
  /* Nunca lanza error y nunca muestra toast (el aviso ya salió por voz/notificación local): devuelve true/false. */
  async function solicitud(evento, texto, id) {
    try {
      if (evento === "nuevo") return false;   // el pedido NUEVO lo avisa ahora el servidor (Worker: cron + solicitud_nueva); así no llega repetido
      const ev = EVENTOS_SOL[evento]; if (!ev || !configurado() || !id) return false;
      const clave = "sol|" + id + "|" + evento;
      if (ultimos[clave] && Date.now() - ultimos[clave] < 60000) return false;   // un solo aviso por solicitud y evento
      ultimos[clave] = Date.now();
      const otros = await otrosDispositivosAdmin();
      if (!otros.length) return false;
      let alguno = false;
      for (const o of otros) {
        const res = await llamarWorker({
          token: o.token, titulo: recorta(ev.titulo, 80), cuerpo: recorta(texto, 240), canal: "admin",
          data: { tipo: ev.tipo, solicitud: String(id) }
        });
        if (res.ok) { alguno = true; continue; }
        if (res.code === "UNREGISTERED" || res.code === "INVALID_ARGUMENT") {   // celular que ya no existe: se limpia su token
          const u = auth.currentUser;
          if (u) db.ref("admin_tokens/" + u.uid + "/" + o.clave).remove().catch(() => {});
        } else console.warn("PushAdmin.solicitud:", res.error);
      }
      return alguno;
    } catch (err) {
      console.warn("PushAdmin.solicitud:", err && err.message ? err.message : err);
      return false;
    }
  }
  return { enviar, pedidoAsignado, mensaje, guia, punto, configurado, whatsappPedido, solicitud };
})();

/* ============================================================
   FASE 2 (push) · SUSCRIPCIÓN FCM WEB del administrador (navegador / PWA)
   - Pide permiso de notificaciones, registra sw.js y obtiene el token FCM con la clave VAPID.
   - Guarda el token en admin_tokens/{uid}/{clave} (reglas ya existentes) para que PushAdmin.solicitud() y el Worker
     lo usen; así el administrador recibe las alertas con la app minimizada.
   - Clave VAPID: Firebase Console → Configuración del proyecto → Cloud Messaging → Certificados push web.
     Pégala en admin.html (window.FCM_VAPID_KEY).
   ============================================================ */
const PushWeb = (() => {
  let uidAct = null, ocupado = false, avisoVapid = false, gestoPuesto = false;
  const vapid = () => String(window.FCM_VAPID_KEY || ((firebase.app().options || {}).vapidKey) || "").trim();
  const soporta = () => {
    try {
      return "serviceWorker" in navigator && "Notification" in window && "PushManager" in window && !!firebase.messaging &&
        (typeof firebase.messaging.isSupported !== "function" || firebase.messaging.isSupported());
    } catch (_) { return false; }
  };
  async function obtener() {
    const llave = vapid();
    if (!llave || /PEGA/i.test(llave)) {
      if (!avisoVapid) { avisoVapid = true; console.warn("PushWeb: falta la clave VAPID (window.FCM_VAPID_KEY en admin.html)."); try { toast("⚠️ Falta la clave VAPID de Firebase para activar las alertas push del navegador."); } catch (_) {} }
      return null;
    }
    const reg = (await navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => null)) || window.__swAdmin || null;
    await navigator.serviceWorker.ready;
    return firebase.messaging().getToken({ vapidKey: llave, serviceWorkerRegistration: reg || (await navigator.serviceWorker.ready) });
  }
  async function guardar(uid, token) {
    adminPushUid = uid;
    adminPushClave = claveDeToken(token);
    await db.ref("admin_tokens/" + uid + "/" + adminPushClave).set({ token, ts: firebase.database.ServerValue.TIMESTAMP, plataforma: "web" });
  }
  async function registrar(uid) {
    uidAct = uid || uidAct;
    if (!uidAct || ocupado || !soporta()) return false;
    ocupado = true;
    try {
      if (Notification.permission === "denied") { try { toast("Activa las notificaciones del navegador para recibir las alertas de pedidos."); } catch (_) {} return false; }
      if (Notification.permission === "default") { esperarGesto(); return false; }   // el navegador exige un toque para pedir permiso
      const t = await obtener();
      if (!t) return false;
      await guardar(uidAct, t);
      return true;
    } catch (e) {
      console.warn("PushWeb:", e && e.message ? e.message : e);
      return false;
    } finally { ocupado = false; }
  }
  function esperarGesto() {
    if (gestoPuesto) return; gestoPuesto = true;
    const pedir = async () => {
      ["pointerdown", "click", "keydown"].forEach((ev) => document.removeEventListener(ev, pedir, true));
      gestoPuesto = false;
      try { await Notification.requestPermission(); } catch (_) {}
      if (Notification.permission === "granted") registrar(uidAct);
    };
    ["pointerdown", "click", "keydown"].forEach((ev) => document.addEventListener(ev, pedir, { capture: true, once: false, passive: true }));
  }
  window.addEventListener("push-admin-renovar", () => { registrar(uidAct); });
  return { registrar, soporta };
})();
