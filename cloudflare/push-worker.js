/* ============================================================
   PUSH-WORKER · Cloudflare Worker (plan gratuito) de Brother’s Deliverys
   Un solo Worker, cinco funciones (campo "accion" del JSON que recibe por POST) + REVISIÓN AUTOMÁTICA cada minuto:

   0) NUEVO · Cron (scheduled): cada minuto busca en solicitudes_entrantes los pedidos "nuevo" que aún no se han avisado y
        manda push de ALTA PRIORIDAD a todos los administradores, aunque su app esté cerrada o el celular en reposo.
        Activar en Cloudflare: Workers → tu Worker → Settings → Triggers → Cron Triggers → Add → expresión  * * * * *
   5) NUEVO · "solicitud_nueva"   CLIENTE → ADMIN      Aviso INSTANTÁNEO (sin esperar al cron). Sin sesión: el Worker comprueba en
        Firebase que la solicitud existe y está "nuevo", y la marca (avisoAdmin) para avisar una sola vez.
        Cuerpo:   { accion: "solicitud_nueva", solicitud: "sol_xxxxxxxx" }

   1) (sin accion / "push")  ADMIN → REPARTIDOR   Aviso push al celular de un repartidor.
        Cabecera: Authorization: Bearer <sesión de Firebase del administrador>
        Cuerpo:   { token, titulo, cuerpo, canal, data }

   2) "whatsapp"            ADMIN → REPARTIDOR   Mensaje de WhatsApp (Cloud API de Meta) al asignar un pedido.
        Cabecera: Authorization: Bearer <sesión de Firebase del administrador>
        Cuerpo:   { accion: "whatsapp", telefono, resumen }
        Texto enviado: "Tienes un nuevo pedido en la app. Detalles: <resumen>"

   3) "admin_chat"          REPARTIDOR → ADMIN   Aviso push a TODOS los celulares de administrador (APK Admin)
        cuando un repartidor escribe en un chat.
        Cabecera: Authorization: Bearer <sesión de Firebase del repartidor registrado>
        Cuerpo:   { accion: "admin_chat", texto, foto, nombreRepartidor, pedido, cliente, equipo, clave }

   4) "cliente_abrio"       CLIENTE → ADMIN      Aviso push al administrador la PRIMERA vez que el cliente
        abre su enlace de rastreo. No lleva sesión: el Worker comprueba en Firebase que el pedido existe y
        marca pedidos/{token}/abiertoAviso para avisar una sola vez (nadie puede repetirlo ni inventar pedidos).
        Cuerpo:   { accion: "cliente_abrio", pedido: "<token del pedido>" }

   6) NUEVO · "mensaje_cliente"  CLIENTE → REPARTIDOR  Push de alta prioridad al repartidor del pedido cuando el cliente le escribe (app cerrada o en reposo).
        Sin sesión: el Worker comprueba en Firebase que el mensaje existe, es del cliente y es reciente, y lo marca (pushOk) para avisar una sola vez.
        Cuerpo:   { accion: "mensaje_cliente", pedido: "<token del pedido>", clave: "<id del mensaje en chats/<token>>" }
   7) NUEVO · Las solicitudes de pedido nuevas (cron o "solicitud_nueva") ahora también avisan por push a TODOS los repartidores con sesión (fcmToken).

   8) NUEVO · "cliente_prioridad"  CLIENTE → REPARTIDOR  Push al repartidor del pedido cuando el cliente activa la prioridad (+C$ 10).
        Cuerpo:   { accion: "cliente_prioridad", pedido: "<token del pedido>" }  (el Worker verifica pedidos/{token}/prioridad === true)

   9) NUEVO · Cron: cada minuto también busca pedidos que el ADMINISTRADOR asignó a un repartidor registrado (ordenes/{id}, estado "asignado")
        y manda push de ALTA PRIORIDAD a ese repartidor aunque tenga la app cerrada. Se avisa una sola vez por pedido (ordenes/{id}/pushRepartidor).

   Variables que debes crear en Cloudflare (Workers → tu Worker → Settings → Variables and Secrets):
     FCM_PROJECT_ID    → ID del proyecto de Firebase (ej. brothers-delivery-12345)       (texto)
     FIREBASE_API_KEY  → "Clave de API web" de Firebase (la de firebase-config.js)       (texto)
     DB_URL            → URL de la Realtime Database, sin "/" al final                    (texto)
                         ej. https://brothers-delivery-12345-default-rtdb.firebaseio.com
     SA_CLIENT_EMAIL   → "client_email" del JSON de la cuenta de servicio                 (Secret)
     SA_PRIVATE_KEY    → "private_key" del JSON de la cuenta de servicio (todo el texto)  (Secret)
     --- WhatsApp Cloud API de Meta (solo si usas la función 2) ---
     WA_TOKEN          → Token de acceso permanente de Meta (usuario del sistema)         (Secret)
     WA_PHONE_ID       → "Identificador del número de teléfono" (Phone number ID)         (texto)
     WA_TEMPLATE       → (opcional) nombre de tu plantilla aprobada, ej. nuevo_pedido     (texto)
                         Con plantilla el mensaje llega SIEMPRE; sin plantilla solo llega si el repartidor
                         te escribió por WhatsApp en las últimas 24 horas (regla de Meta).
     WA_TEMPLATE_LANG  → (opcional) idioma de la plantilla, por defecto "es"              (texto)
     WA_API_VERSION    → (opcional) versión de la API de Graph, por defecto "v21.0"       (texto)
   ============================================================ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

const ALCANCES = [
  "https://www.googleapis.com/auth/firebase.messaging",   // enviar push (FCM)
  "https://www.googleapis.com/auth/firebase.database",    // leer/escribir la base de datos sin depender de las reglas
  "https://www.googleapis.com/auth/userinfo.email"        // requerido por la base de datos para aceptar el token
].join(" ");

let cache = { token: null, exp: 0 };   // el token de Google se reutiliza ~55 minutos
const recientes = new Map();           // para no repetir el mismo aviso en pocos segundos

const b64url = (buf) => {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer || buf);
  let s = ""; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlTexto = (t) => b64url(new TextEncoder().encode(t));

function pemABuffer(pem) {
  const limpio = String(pem).replace(/\\n/g, "\n").replace(/-----BEGIN PRIVATE KEY-----/, "").replace(/-----END PRIVATE KEY-----/, "").replace(/\s+/g, "");
  const bin = atob(limpio); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/* Token de acceso de Google (firma un JWT con la llave de la cuenta de servicio): sirve para FCM y para la base de datos */
async function tokenGoogle(env) {
  const ahora = Math.floor(Date.now() / 1000);
  if (cache.token && cache.exp > ahora + 120) return cache.token;
  const cabecera = { alg: "RS256", typ: "JWT" };
  const reclamo = { iss: env.SA_CLIENT_EMAIL, scope: ALCANCES, aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600 };
  const sinFirma = b64urlTexto(JSON.stringify(cabecera)) + "." + b64urlTexto(JSON.stringify(reclamo));
  const llave = await crypto.subtle.importKey("pkcs8", pemABuffer(env.SA_PRIVATE_KEY), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", llave, new TextEncoder().encode(sinFirma));
  const jwt = sinFirma + "." + b64url(firma);
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer") + "&assertion=" + jwt
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error("Google rechazó la llave de la cuenta de servicio: " + (j.error_description || j.error || r.status));
  cache = { token: j.access_token, exp: ahora + (j.expires_in || 3600) };
  return cache.token;
}

/* ---------- Base de datos (REST, con la cuenta de servicio) ---------- */
const dbBase = (env) => String(env.DB_URL || "").replace(/\/+$/, "");
async function dbLeer(env, ruta) {
  const acceso = await tokenGoogle(env);
  const r = await fetch(dbBase(env) + "/" + ruta + ".json?access_token=" + encodeURIComponent(acceso));
  if (!r.ok) throw new Error("Base de datos: error " + r.status + " al leer " + ruta);
  return r.json();
}
async function dbBorrar(env, ruta) {
  const acceso = await tokenGoogle(env);
  await fetch(dbBase(env) + "/" + ruta + ".json?access_token=" + encodeURIComponent(acceso), { method: "DELETE" }).catch(() => {});
}

/* ---------- Identidad de quien llama ---------- */
/* Devuelve el uid de Firebase de la sesión (o null si no es válida) */
async function uidDeSesion(idToken, env) {
  if (!idToken) return null;
  const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(env.FIREBASE_API_KEY), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken })
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j && j.users && j.users[0] && j.users[0].localId) || null;
}
async function esAdmin(uid, env) {
  if (!uid) return false;
  const v = await dbLeer(env, "admins/" + encodeURIComponent(uid));
  return v !== null && v !== false;
}
async function esRepartidor(uid, env) {
  if (!uid) return false;
  const v = await dbLeer(env, "repartidores/" + encodeURIComponent(uid));
  return v !== null && v !== false;
}

/* ---------- Envío de push por FCM (API HTTP v1) ---------- */
const CANALES = ["pedidos", "mensajes", "admin", "solicitudes", "avisos"];
async function enviarFCM(env, token, { titulo, cuerpo, canal, data, tag, sonido, imagen, link }) {
  const acceso = await tokenGoogle(env);
  const r = await fetch("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(env.FCM_PROJECT_ID) + "/messages:send", {
    method: "POST",
    headers: { "Authorization": "Bearer " + acceso, "Content-Type": "application/json" },
    body: JSON.stringify({ message: {
      token,
      notification: { title: titulo, body: cuerpo, ...(imagen ? { image: imagen } : {}) },
      data,
      webpush: { headers: { Urgency: "high", TTL: "86400" }, ...((tag || imagen) ? { notification: { ...(tag ? { tag } : {}), ...(imagen ? { image: imagen } : {}), requireInteraction: true } } : {}), ...(link ? { fcm_options: { link } } : {}) },   // navegador / PWA del admin: entrega inmediata aunque el equipo esté en reposo
      android: {
        priority: "HIGH", ttl: "86400s",
        notification: { ...(tag ? { tag } : {}), ...(imagen ? { image: imagen } : {}), channel_id: canal, ...(sonido ? { sound: sonido } : { sound: "default", default_sound: true }), default_vibrate_timings: true, notification_priority: "PRIORITY_MAX", visibility: "PUBLIC" }
      }
    } })
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, id: j.name };
  const det = (j.error && j.error.details && j.error.details.find((x) => x.errorCode)) || {};
  let code = det.errorCode || (j.error && j.error.status) || "ERROR";
  /* INVALID_ARGUMENT también lo devuelve FCM por un mensaje mal armado: solo es «token muerto» si el error nombra el token de registro */
  if (code === "INVALID_ARGUMENT" && /registration token|message\.token/i.test(JSON.stringify(j.error || {}))) code = "UNREGISTERED";
  return { ok: false, code, status: r.status, error: (j.error && j.error.message) || "FCM rechazó el envío" };
}
function limpiaData(d) {
  const data = {};
  Object.entries(d || {}).slice(0, 10).forEach(([k, v]) => { data[String(k).slice(0, 40)] = String(v == null ? "" : v).slice(0, 200); });
  return data;
}
const recorta = (t, n) => { t = String(t == null ? "" : t); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

/* Avisa a TODOS los celulares de administrador guardados en admin_tokens/{uid}/{clave-del-aparato} = { token, ts, plataforma } */
async function avisarAdmins(env, aviso) {
  const todos = (await dbLeer(env, "admin_tokens")) || {};
  const lista = [];
  Object.entries(todos).forEach(([uid, aparatos]) => {
    Object.entries(aparatos || {}).forEach(([clave, v]) => {
      if (v && typeof v.token === "string" && v.token.length > 20) lista.push({ uid, clave, token: v.token });
    });
  });
  if (!lista.length) return { ok: false, error: "Ningún administrador tiene la APK Admin con avisos activados", enviados: 0 };
  const data = limpiaData(aviso.data);
  let enviados = 0, ultimoError = "";
  await Promise.all(lista.map(async (a) => {
    const r = await enviarFCM(env, a.token, { titulo: aviso.titulo, cuerpo: aviso.cuerpo, canal: "admin", data, tag: aviso.tag ? String(aviso.tag).slice(0, 80) : undefined });
    if (r.ok) enviados++;
    else {
      ultimoError = r.error;
      if (["UNREGISTERED", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, "admin_tokens/" + encodeURIComponent(a.uid) + "/" + encodeURIComponent(a.clave));   // celular que ya no existe
    }
  }));
  return enviados ? { ok: true, enviados } : { ok: false, error: ultimoError || "FCM rechazó el envío", enviados: 0 };
}

/* ---------- WhatsApp Cloud API de Meta ---------- */
async function enviarWhatsApp(env, telefono, resumen) {
  if (!env.WA_TOKEN || !env.WA_PHONE_ID) return { ok: false, status: 500, error: "Faltan WA_TOKEN y WA_PHONE_ID en las variables del Worker" };
  const para = String(telefono || "").replace(/\D+/g, "");
  if (para.length < 8 || para.length > 15) return { ok: false, status: 400, error: "Teléfono no válido (usa código de país, ej. 50588887777)" };
  const limpio = String(resumen || "").replace(/\s+/g, " ").trim().slice(0, 900) || "Revisa los detalles en la app";
  const cuerpo = { messaging_product: "whatsapp", to: para };
  if (env.WA_TEMPLATE) {
    // Plantilla aprobada con UNA variable {{1}} en el cuerpo:  "Tienes un nuevo pedido en la app. Detalles: {{1}}"
    cuerpo.type = "template";
    cuerpo.template = {
      name: env.WA_TEMPLATE,
      language: { code: env.WA_TEMPLATE_LANG || "es" },
      components: [{ type: "body", parameters: [{ type: "text", text: limpio }] }]
    };
  } else {
    cuerpo.type = "text";
    cuerpo.text = { preview_url: false, body: "Tienes un nuevo pedido en la app. Detalles: " + limpio };
  }
  const r = await fetch("https://graph.facebook.com/" + (env.WA_API_VERSION || "v21.0") + "/" + encodeURIComponent(env.WA_PHONE_ID) + "/messages", {
    method: "POST",
    headers: { "Authorization": "Bearer " + env.WA_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo)
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, id: j.messages && j.messages[0] && j.messages[0].id };
  return { ok: false, status: 502, code: j.error && j.error.code, error: (j.error && (j.error.error_user_msg || j.error.message)) || ("WhatsApp respondió " + r.status) };
}

/* ---------- Acciones ---------- */
/* 3) El repartidor escribió en un chat → push a los administradores */
async function accionAdminChat(b, idToken, env) {
  const uid = await uidDeSesion(idToken, env);
  if (!uid) return json({ ok: false, error: "Sesión no válida" }, 401);
  if (!(await esRepartidor(uid, env))) return json({ ok: false, error: "No eres un repartidor registrado" }, 403);
  const clave = "chat|" + uid + "|" + String(b.clave || "").slice(0, 80);
  const antes = recientes.get(clave);
  if (b.clave && antes && Date.now() - antes < 30000) return json({ ok: true, repetido: true });
  recientes.set(clave, Date.now());
  if (recientes.size > 500) recientes.clear();

  const nombre = recorta(b.nombreRepartidor || "Un repartidor", 40);
  const cliente = recorta(b.cliente || "", 40), pedido = recorta(b.pedido || "", 30);
  const titulo = b.equipo ? "💬 " + nombre + " te escribió" : "💬 " + nombre + (cliente ? " → " + cliente : (pedido ? " · pedido " + pedido : "")) ;
  const cuerpo = b.texto ? recorta(b.texto, 240) : (b.foto ? "📷 Envió una foto" : "Nuevo mensaje en el chat");
  const r = await avisarAdmins(env, { titulo, cuerpo, data: { tipo: "chat_repartidor", uid, equipo: b.equipo ? "1" : "0", pedido, nombre } });
  return json(r, r.ok ? 200 : 502);
}

/* 4) El cliente abrió su enlace de rastreo por primera vez → push a los administradores (una sola vez por pedido) */
async function accionClienteAbrio(b, env) {
  const t = String(b.pedido || "");
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(t)) return json({ ok: false, error: "Pedido no válido" }, 400);
  const acceso = await tokenGoogle(env);
  const urlMarca = dbBase(env) + "/pedidos/" + t + "/abiertoAviso.json?access_token=" + encodeURIComponent(acceso);

  // ¿Ya se avisó? (se pide también la "etiqueta" de versión para escribir solo si nadie se adelantó)
  const g = await fetch(urlMarca, { headers: { "X-Firebase-ETag": "true" } });
  if (!g.ok) return json({ ok: false, error: "No se pudo leer el pedido" }, 502);
  const etag = g.headers.get("ETag");
  const previo = await g.json();
  if (previo !== null) return json({ ok: true, yaAvisado: true });

  const d = await dbLeer(env, "pedidos/" + encodeURIComponent(t));
  if (!d) return json({ ok: false, error: "Ese pedido no existe" }, 404);
  if (d.estado === "entregado" || d.estado === "cancelado") return json({ ok: true, omitido: true });

  // Marca atómica: si dos aparatos abren a la vez, solo uno logra escribir
  const p = await fetch(urlMarca, { method: "PUT", headers: { "Content-Type": "application/json", "if-match": etag || "null_etag" }, body: JSON.stringify(Date.now()) });
  if (p.status === 412) return json({ ok: true, yaAvisado: true });
  if (!p.ok) return json({ ok: false, error: "No se pudo marcar el pedido" }, 502);

  const cliente = d.factura && (d.factura.cliente || d.factura.nombre) || "";
  const cuerpo = ["Pedido " + (d.pedido || "—"), cliente, d.repartidorNombre ? "Repartidor: " + d.repartidorNombre : ""].filter(Boolean).join(" · ");
  const r = await avisarAdmins(env, { titulo: "👀 El cliente abrió su enlace", cuerpo: recorta(cuerpo, 240), tag: "cliente_abrio_" + t, data: { tipo: "cliente_abrio", pedido: String(d.pedido || ""), token: t } });
  return json(r, r.ok ? 200 : 502);
}

/* ---------- NUEVO · Pedidos nuevos de clientes → push a los administradores (servidor, app cerrada) ---------- */
const EDAD_MAXIMA_MS = 3 * 60 * 60 * 1000;   // no se avisan solicitudes más viejas de 3 horas (evita avalanchas)

/* Marca atómica: solo UN proceso (cron o aviso instantáneo) logra avisar cada solicitud. Devuelve true si le tocó avisar. */
async function marcarAvisoSolicitud(env, id) {
  const acceso = await tokenGoogle(env);
  const url = dbBase(env) + "/solicitudes_entrantes/" + id + "/avisoAdmin.json?access_token=" + encodeURIComponent(acceso);
  const g = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
  if (!g.ok) return false;
  const etag = g.headers.get("ETag");
  const previo = await g.json();
  if (previo !== null) return false;
  const p = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "if-match": etag || "null_etag" }, body: JSON.stringify(Date.now()) });
  return p.ok;
}
/* Push a todos los repartidores con sesión iniciada (guardan repartidores/{uid}/fcmToken y lo borran al salir) */
async function avisarRepartidores(env, aviso, ciudad) {
  const todos = (await dbLeer(env, "repartidores")) || {};
  /* Si el pedido trae ciudadRuta, solo avisa a los repartidores activos en esa ciudad (repartidores/{uid}/ciudad) */
  const lista = Object.entries(todos).filter(([, v]) => v && typeof v.fcmToken === "string" && v.fcmToken.length > 20 && (!ciudad || v.ciudad === ciudad)).map(([uid, v]) => ({ uid, token: v.fcmToken }));
  if (!lista.length) return { ok: false, error: ciudad ? "Ningún repartidor de esa ciudad tiene avisos activados" : "Ningún repartidor tiene avisos activados", enviados: 0 };
  const data = limpiaData(aviso.data);
  let enviados = 0, ultimoError = "";
  await Promise.all(lista.map(async (a) => {
    const r = await enviarFCM(env, a.token, { titulo: aviso.titulo, cuerpo: aviso.cuerpo, canal: aviso.canal || "pedidos", data });
    if (r.ok) enviados++;
    else {
      ultimoError = r.error;
      if (["UNREGISTERED", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, "repartidores/" + encodeURIComponent(a.uid) + "/fcmToken");
    }
  }));
  return enviados ? { ok: true, enviados } : { ok: false, error: ultimoError || "FCM rechazó el envío", enviados: 0 };
}
/* ---------- NUEVO · Restaurantes: push INVASIVO (canal «solicitudes», sonido con voz) y repetición cada minuto hasta que acepten o rechacen ---------- */
const REST_MAX_AVISOS = 10, REST_CADA_MS = 55000, REST_EDAD_MS = 30 * 60 * 1000;
async function dbLeerQ(env, ruta, query) {
  const acceso = await tokenGoogle(env);
  const r = await fetch(dbBase(env) + "/" + ruta + ".json?" + query + "&access_token=" + encodeURIComponent(acceso));
  if (!r.ok) throw new Error("Base de datos: error " + r.status + " al leer " + ruta);
  return r.json();
}
async function dbEscribir(env, ruta, valor) {
  const acceso = await tokenGoogle(env);
  await fetch(dbBase(env) + "/" + ruta + ".json?access_token=" + encodeURIComponent(acceso), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(valor) }).catch(() => {});
}
/* El negocio solo recibe el número del pedido y que viene de Brother’s Deliverys (nunca datos del cliente) */
async function pushRestaurante(env, bid, sid, d) {
  const priv = await dbLeer(env, "restaurantesPriv/" + encodeURIComponent(bid) + "/fcmToken");
  if (typeof priv !== "string" || priv.length < 20) return { ok: false, error: "El negocio no tiene avisos activados" };
  const prev = d && d.pushRest && typeof d.pushRest === "object" ? d.pushRest : {};
  const n = Number(prev.n) || 0;
  const items = d && d.vistaRestaurante && Array.isArray(d.vistaRestaurante.items) ? d.vistaRestaurante.items : (d && d.pedido && Array.isArray(d.pedido.items) ? d.pedido.items : []);
  const unidades = items.reduce((a, i) => a + (Number(i && i.q) || 1), 0);
  const num = "#" + String(sid).slice(-5).toUpperCase();
  const r = await enviarFCM(env, priv, {
    titulo: (n ? "🔁 " : "🔔 ") + "¡TIENES UNA SOLICITUD DE PEDIDO!",
    cuerpo: "Pedido " + num + " de Brother’s Deliverys" + (unidades ? " · " + unidades + " producto(s)" : "") + ". ¡Ábrelo y acéptalo!",
    canal: "solicitudes", sonido: "solicitud_pedido", tag: "rest_" + sid,
    data: { tipo: "solicitud_rest", solicitud: sid, voz: "Tienes una solicitud de pedido" }
  });
  if (r.ok) await dbEscribir(env, "solicitudes_entrantes/" + encodeURIComponent(sid) + "/pushRest", { n: n + 1, ts: Date.now() });
  else if (["UNREGISTERED", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, "restaurantesPriv/" + encodeURIComponent(bid) + "/fcmToken");
  return r;
}
const restPendiente = (d) => d && typeof d === "object" && !["cancelado", "rechazado", "entregado", "finalizado"].includes(d.estado) && ((d.rest && d.rest.estado) || "pendiente") === "pendiente";
/* Cron: repite el aviso cada minuto (hasta 10 veces) mientras el negocio no haya aceptado ni rechazado */
async function revisarRestaurantes(env) {
  const privs = (await dbLeer(env, "restaurantesPriv")) || {};
  let avisos = 0;
  for (const [bid, v] of Object.entries(privs)) {
    if (!v || typeof v.fcmToken !== "string" || v.fcmToken.length < 20) continue;
    const idx = (await dbLeerQ(env, "restaurantePedidos/" + encodeURIComponent(bid), "orderBy=" + encodeURIComponent('"$value"') + "&startAt=" + (Date.now() - REST_EDAD_MS))) || {};
    for (const sid of Object.keys(idx)) {
      if (!/^sol_[A-Za-z0-9_-]{8,64}$/.test(sid)) continue;
      const d = await dbLeer(env, "solicitudes_entrantes/" + encodeURIComponent(sid));
      if (!d || d.restauranteUid !== bid || !restPendiente(d)) continue;
      const pr = d.pushRest || {};
      if ((Number(pr.n) || 0) >= REST_MAX_AVISOS || Date.now() - (Number(pr.ts) || 0) < REST_CADA_MS) continue;
      const r = await pushRestaurante(env, bid, sid, d);
      if (r.ok) avisos++;
    }
  }
  return avisos;
}
async function avisarSolicitudNueva(env, id, d) {
  if (d && typeof d.restauranteUid === "string" && /^[A-Za-z0-9_~-]{6,90}$/.test(d.restauranteUid)) {
    try { await pushRestaurante(env, d.restauranteUid, id, d); } catch (_) {}
  }
  const p = (d && d.pedido) || {};
  const nombre = recorta((d && d.nombre) || "Cliente", 40);
  const quiere = recorta(p.quiere || "", 160);
  const ciudadRuta = typeof ((d && d.ciudadRuta) || p.ciudadRuta) === "string" ? String((d && d.ciudadRuta) || p.ciudadRuta).slice(0, 30) : "";
  const cuerpo = quiere ? quiere + (p.origen ? " · de " + recorta(p.origen, 60) : "") : "Hay una solicitud de pedido";
  const [adm, rep] = await Promise.all([
    avisarAdmins(env, { titulo: "📥 " + nombre, cuerpo, data: { tipo: "sol_nuevo", solicitud: id, nombre, quiere: recorta(p.quiere || "", 120) } }),
    avisarRepartidores(env, { titulo: "📥 Nueva solicitud · " + nombre, cuerpo, canal: "pedidos", data: { tipo: "solicitud", solicitud: id, nombre, quiere: recorta(p.quiere || "", 120) } }, ciudadRuta)
  ]);
  return { ok: !!(adm.ok || rep.ok), admins: adm, repartidores: rep, error: (adm.ok || rep.ok) ? undefined : (adm.error || rep.error) };
}
async function procesarSolicitud(env, id) {
  const d = await dbLeer(env, "solicitudes_entrantes/" + encodeURIComponent(id));
  if (!d || typeof d !== "object") return { ok: false, error: "Esa solicitud no existe" };
  if (d.estado !== "nuevo" || d.repartidorUid) return { ok: true, omitido: true };
  const t = Number(d.creado || d.ts) || 0;
  if (t && Date.now() - t > EDAD_MAXIMA_MS) return { ok: true, omitido: true };
  if (!(await marcarAvisoSolicitud(env, id))) return { ok: true, yaAvisado: true };
  return avisarSolicitudNueva(env, id, d);
}
/* Cron: revisa todas las solicitudes "nuevo" (la base tiene índice por "estado") */
async function revisarSolicitudesNuevas(env) {
  const acceso = await tokenGoogle(env);
  const q = "?orderBy=" + encodeURIComponent('"estado"') + "&equalTo=" + encodeURIComponent('"nuevo"') + "&limitToLast=50&access_token=" + encodeURIComponent(acceso);
  const r = await fetch(dbBase(env) + "/solicitudes_entrantes.json" + q);
  if (!r.ok) throw new Error("Base de datos: error " + r.status + " al buscar solicitudes nuevas");
  const todas = (await r.json()) || {};
  let avisadas = 0;
  for (const [id, d] of Object.entries(todas)) {
    if (!d || typeof d !== "object" || d.avisoAdmin || d.repartidorUid) continue;
    if (!/^sol_[A-Za-z0-9_-]{8,64}$/.test(id)) continue;
    const res = await procesarSolicitud(env, id);
    if (res && res.ok && !res.omitido && !res.yaAvisado) avisadas++;
  }
  return avisadas;
}

/* 9) Pedidos asignados por el administrador → push al repartidor elegido */
async function revisarOrdenesAdmin(env) {
  const acceso = await tokenGoogle(env);
  const q = "?orderBy=" + encodeURIComponent('"creado"') + "&startAt=" + (Date.now() - EDAD_MAXIMA_MS) + "&limitToLast=200&access_token=" + encodeURIComponent(acceso);
  const r = await fetch(dbBase(env) + "/ordenes.json" + q);
  if (!r.ok) throw new Error("Base de datos: error " + r.status + " al buscar pedidos del administrador");
  const todas = (await r.json()) || {};
  let avisados = 0;
  for (const [id, o] of Object.entries(todas)) {
    if (!o || typeof o !== "object" || o.pushRepartidor || o.estado !== "asignado") continue;
    const a = o.asignacion;
    if (!a || a.tipo !== "registrado" || !a.uid || !/^[A-Za-z0-9_-]{4,80}$/.test(id)) continue;
    if (o.estado_asignacion === "aceptado" || o.estado_asignacion === "rechazado") continue;
    const creado = Number(o.creado || 0);
    if (creado && Date.now() - creado > EDAD_MAXIMA_MS) continue;
    const fcm = await dbLeer(env, "repartidores/" + encodeURIComponent(a.uid) + "/fcmToken");
    if (typeof fcm !== "string" || fcm.length < 20) continue;   // sin token todavía: se reintenta en el siguiente minuto
    if (!(await marcarUnaVez(env, "ordenes/" + encodeURIComponent(id) + "/pushRepartidor"))) continue;
    const cliente = recorta(o.cliente || "", 40), dir = recorta((o.entrega && o.entrega.texto) || "", 90);
    const res = await enviarFCM(env, fcm, { titulo: "📦 Nuevo pedido asignado" + (cliente ? " · " + cliente : ""), cuerpo: dir ? "Entrega: " + dir : "Abre la app para ver los detalles del pedido", canal: "pedidos", data: limpiaData({ tipo: "pedido", orden: id }) });
    if (res.ok) avisados++;
    else if (["UNREGISTERED", "NOT_FOUND"].includes(res.code)) await dbBorrar(env, "repartidores/" + encodeURIComponent(a.uid) + "/fcmToken");
  }
  return avisados;
}

/* 5) El cliente acaba de crear su solicitud → aviso instantáneo a los administradores */
async function accionSolicitudNueva(b, env) {
  const id = String(b.solicitud || "");
  if (!/^sol_[A-Za-z0-9_-]{8,64}$/.test(id)) return json({ ok: false, error: "Solicitud no válida" }, 400);
  const r = await procesarSolicitud(env, id);
  return json(r, r.ok ? 200 : 502);
}

/* 6) El cliente le escribió a su repartidor → push de alta prioridad al repartidor del pedido */
async function marcarUnaVez(env, ruta) {
  const acceso = await tokenGoogle(env);
  const url = dbBase(env) + "/" + ruta + ".json?access_token=" + encodeURIComponent(acceso);
  const g = await fetch(url, { headers: { "X-Firebase-ETag": "true" } });
  if (!g.ok) return false;
  const etag = g.headers.get("ETag");
  if ((await g.json()) !== null) return false;
  const p = await fetch(url, { method: "PUT", headers: { "Content-Type": "application/json", "if-match": etag || "null_etag" }, body: JSON.stringify(Date.now()) });
  return p.ok;
}
async function accionMensajeCliente(b, env) {
  const pedido = String(b.pedido || ""), clave = String(b.clave || "");
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(pedido) || !/^[A-Za-z0-9_-]{6,60}$/.test(clave)) return json({ ok: false, error: "Datos no válidos" }, 400);
  const msg = await dbLeer(env, "chats/" + encodeURIComponent(pedido) + "/" + encodeURIComponent(clave));
  if (!msg || typeof msg !== "object") return json({ ok: false, error: "Ese mensaje no existe" }, 404);
  const quien = [msg.de, msg.yo, msg.autor, msg.rol, msg.quien, msg.from].filter(Boolean);
  if (quien.length && !quien.includes("cliente")) return json({ ok: true, omitido: true });
  const ts = Number(msg.ts || msg.t || msg.fecha || 0);
  if (ts && Date.now() - ts > 180000) return json({ ok: true, omitido: true });
  let ped = await dbLeer(env, "pedidos/" + encodeURIComponent(pedido));
  let uid = ped && ped.repartidorUid;
  if (!uid) { const sol = await dbLeer(env, "solicitudes_entrantes/" + encodeURIComponent(pedido)); if (sol && sol.repartidorUid) { uid = sol.repartidorUid; ped = ped || sol; } }
  if (!uid) return json({ ok: false, error: "El pedido no tiene repartidor" }, 404);
  const fcm = await dbLeer(env, "repartidores/" + encodeURIComponent(uid) + "/fcmToken");
  if (typeof fcm !== "string" || fcm.length < 20) return json({ ok: false, error: "El repartidor no tiene avisos activados" }, 404);
  if (!(await marcarUnaVez(env, "chats/" + encodeURIComponent(pedido) + "/" + encodeURIComponent(clave) + "/pushOk"))) return json({ ok: true, yaAvisado: true });
  const nombre = (ped && (ped.cliente || (ped.factura && (ped.factura.cliente || ped.factura.nombre)) || ped.nombre)) || "";
  const texto = recorta(msg.texto || msg.text || "", 200);
  const r = await enviarFCM(env, fcm, { titulo: "💬 " + (nombre ? "Cliente · " + recorta(nombre, 40) : "Mensaje de tu cliente"), cuerpo: texto || "📷 Te envió una foto", canal: "mensajes", data: limpiaData({ tipo: "mensaje", token: pedido }) });
  if (!r.ok && ["UNREGISTERED", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, "repartidores/" + encodeURIComponent(uid) + "/fcmToken");
  return json(r.ok ? { ok: true } : { ok: false, code: r.code, error: r.error }, r.ok ? 200 : 502);
}

/* 8) El cliente activó la prioridad → push al repartidor del pedido */
async function accionClientePrioridad(b, env) {
  const pedido = String(b.pedido || "");
  if (!/^[A-Za-z0-9_-]{6,60}$/.test(pedido)) return json({ ok: false, error: "Datos no válidos" }, 400);
  const ped = await dbLeer(env, "pedidos/" + encodeURIComponent(pedido));
  if (!ped || ped.prioridad !== true) return json({ ok: false, error: "El pedido no tiene prioridad" }, 404);
  const uid = ped.repartidorUid;
  if (!uid) return json({ ok: false, error: "El pedido no tiene repartidor" }, 404);
  const fcm = await dbLeer(env, "repartidores/" + encodeURIComponent(uid) + "/fcmToken");
  if (typeof fcm !== "string" || fcm.length < 20) return json({ ok: false, error: "El repartidor no tiene avisos activados" }, 404);
  if (!(await marcarUnaVez(env, "pedidos/" + encodeURIComponent(pedido) + "/prioridadAviso"))) return json({ ok: true, yaAvisado: true });
  const nombre = recorta(ped.cliente || (ped.factura && ped.factura.cliente) || "", 40);
  const r = await enviarFCM(env, fcm, { titulo: "⚡ Pedido con prioridad", cuerpo: (nombre ? nombre + " " : "El cliente ") + "pidió prioridad (+C$ 10). ¡Entrégalo lo antes posible!", canal: "pedidos", data: limpiaData({ tipo: "prioridad", token: pedido }) });
  if (!r.ok && ["UNREGISTERED", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, "repartidores/" + encodeURIComponent(uid) + "/fcmToken");
  return json(r.ok ? { ok: true } : { ok: false, code: r.code, error: r.error }, r.ok ? 200 : 502);
}

/* 9) NUEVO · PROMOCIONES: el administrador envía un push (título grande + descripción + foto) a restaurantes y/o clientes.
      Cuerpo: { accion:"difusion", id:"<difusiones/{id}>", desde:0 }  (con sesión de admin). Responde { total, enviados, siguiente } → repetir con desde=siguiente hasta que sea null.
      La foto vive en difusionesFoto/{id} (data URL) y se sirve en GET /img/{id} para que FCM la descargue. */
const LOTE_DIFUSION = 40;
async function accionDifusion(b, idToken, env) {
  const uid = await uidDeSesion(idToken, env);
  if (!uid || !(await esAdmin(uid, env))) return json({ ok: false, error: "No eres administrador" }, 403);
  const id = String(b.id || "");
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return json({ ok: false, error: "Id no válido" }, 400);
  const d = await dbLeer(env, "difusiones/" + id);
  if (!d || !d.titulo) return json({ ok: false, error: "La promoción no existe" }, 404);
  const destino = ["restaurantes", "clientes", "todos"].includes(d.destino) ? d.destino : "todos";
  const vistos = new Set(), dest = [];
  const agregar = (t, ruta) => { if (typeof t === "string" && t.length > 20 && !vistos.has(t)) { vistos.add(t); dest.push({ t, ruta }); } };
  if (destino !== "clientes") { const p = (await dbLeer(env, "restaurantesPriv")) || {}; Object.entries(p).forEach(([k, v]) => agregar(v && v.fcmToken, "restaurantesPriv/" + encodeURIComponent(k) + "/fcmToken")); }
  if (destino !== "restaurantes") { const c = (await dbLeer(env, "clientesPush")) || {}; Object.entries(c).forEach(([k, v]) => agregar(v && v.t, "clientesPush/" + encodeURIComponent(k))); }
  const desde = Math.max(0, Number(b.desde) || 0), lote = dest.slice(desde, desde + LOTE_DIFUSION);
  const base = new URL(req_url_base(env)).origin;
  const imagen = d.tieneFoto ? base + "/img/" + id : "";
  let enviados = 0, fallidos = 0;
  for (const x of lote) {
    const r = await enviarFCM(env, x.t, { titulo: recorta(d.titulo, 80), cuerpo: recorta(d.desc || "", 240), canal: "avisos", tag: "promo_" + id, imagen, link: "https://jhosxan-art.github.io/brothers/cliente-app.html", data: { tipo: "promo", id } });
    if (r.ok) enviados++; else { fallidos++; if (["UNREGISTERED", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, x.ruta); }
  }
  const sig = desde + LOTE_DIFUSION < dest.length ? desde + LOTE_DIFUSION : null;
  return json({ ok: true, total: dest.length, enviados, fallidos, siguiente: sig });
}
let URL_BASE = "";
const req_url_base = () => URL_BASE;
/* GET /img/{id}: sirve la foto de la promoción (pública; solo lectura de una foto que el admin eligió enviar) */
async function servirImagen(id, env) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return new Response("No", { status: 404 });
  const v = await dbLeer(env, "difusionesFoto/" + id);
  const m = typeof v === "string" && v.match(/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/);
  if (!m) return new Response("No", { status: 404 });
  const bin = atob(m[2]), buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Response(buf, { headers: { "Content-Type": m[1], "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" } });
}

/* 1) y 2): solo administradores */
async function accionAdmin(b, idToken, env) {
  const uid = await uidDeSesion(idToken, env);
  if (!uid) return json({ ok: false, error: "Falta la sesión del administrador" }, 401);
  if (!(await esAdmin(uid, env))) return json({ ok: false, error: "No eres administrador" }, 403);

  if (b.accion === "whatsapp") {
    const r = await enviarWhatsApp(env, b.telefono, b.resumen);
    return json(r, r.ok ? 200 : (r.status || 502));
  }

  // Push al celular de un repartidor
  const token = String(b.token || ""), titulo = String(b.titulo || "").slice(0, 100), cuerpo = String(b.cuerpo || "").slice(0, 300);
  if (token.length < 20 || !titulo) return json({ ok: false, error: "Datos incompletos" }, 400);
  const canal = CANALES.includes(b.canal) && b.canal !== "admin" ? b.canal : "pedidos";
  const r = await enviarFCM(env, token, { titulo, cuerpo, canal, data: limpiaData(b.data) });
  if (r.ok) return json({ ok: true, id: r.id });
  return json({ ok: false, code: r.code, error: r.error }, r.status === 404 ? 404 : 502);
}

export default {
  /* Cron Trigger (cada minuto): pedidos nuevos de clientes → push a los administradores aunque su app esté cerrada */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(revisarSolicitudesNuevas(env).catch((e) => console.warn("cron solicitudes:", e && e.message ? e.message : e)));
    ctx.waitUntil(revisarOrdenesAdmin(env).catch((e) => console.warn("cron pedidos admin:", e && e.message ? e.message : e)));
    ctx.waitUntil(revisarRestaurantes(env).catch((e) => console.warn("cron restaurantes:", e && e.message ? e.message : e)));
  },
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    URL_BASE = req.url;
    if (req.method === "GET") { const mm = new URL(req.url).pathname.match(/^\/img\/([A-Za-z0-9_-]+)$/); if (mm) return await servirImagen(mm[1], env); return new Response("Brother's push", { status: 200 }); }
    if (req.method !== "POST") return json({ ok: false, error: "Solo POST" }, 405);
    try {
      const idToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const b = await req.json().catch(() => ({}));
      if (b.accion === "cliente_abrio") return await accionClienteAbrio(b, env);   // sin sesión: el cliente no inicia sesión
      if (b.accion === "solicitud_nueva") return await accionSolicitudNueva(b, env);   // sin sesión: se valida contra Firebase
      if (b.accion === "cliente_prioridad") return await accionClientePrioridad(b, env);
      if (b.accion === "mensaje_cliente") return await accionMensajeCliente(b, env);   // sin sesión: se valida contra Firebase
      if (b.accion === "difusion") return await accionDifusion(b, idToken, env);
      if (b.accion === "admin_chat") return await accionAdminChat(b, idToken, env);
      return await accionAdmin(b, idToken, env);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};
