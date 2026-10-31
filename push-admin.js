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
          token: tk, titulo: recorta(a.titulo, 80), cuerpo: recorta(a.cuerpo, 240), canal: a.canal || "pedidos",
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
  return { enviar, pedidoAsignado, mensaje, guia, punto, configurado, whatsappPedido };
})();
