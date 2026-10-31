/* ============================================================
   PUSH-WORKER · Cloudflare Worker (plan gratuito) de Brother’s Deliverys
   Un solo Worker, cuatro funciones (campo "accion" del JSON que recibe por POST):

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
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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
const CANALES = ["pedidos", "mensajes", "admin"];
async function enviarFCM(env, token, { titulo, cuerpo, canal, data }) {
  const acceso = await tokenGoogle(env);
  const r = await fetch("https://fcm.googleapis.com/v1/projects/" + encodeURIComponent(env.FCM_PROJECT_ID) + "/messages:send", {
    method: "POST",
    headers: { "Authorization": "Bearer " + acceso, "Content-Type": "application/json" },
    body: JSON.stringify({ message: {
      token,
      notification: { title: titulo, body: cuerpo },
      data,
      android: {
        priority: "HIGH", ttl: "3600s",
        notification: { channel_id: canal, sound: "default", default_sound: true, default_vibrate_timings: true, notification_priority: "PRIORITY_MAX", visibility: "PUBLIC" }
      }
    } })
  });
  const j = await r.json().catch(() => ({}));
  if (r.ok) return { ok: true, id: j.name };
  const det = (j.error && j.error.details && j.error.details.find((x) => x.errorCode)) || {};
  const code = det.errorCode || (j.error && j.error.status) || "ERROR";
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
    const r = await enviarFCM(env, a.token, { titulo: aviso.titulo, cuerpo: aviso.cuerpo, canal: "admin", data });
    if (r.ok) enviados++;
    else {
      ultimoError = r.error;
      if (["UNREGISTERED", "INVALID_ARGUMENT", "NOT_FOUND"].includes(r.code)) await dbBorrar(env, "admin_tokens/" + encodeURIComponent(a.uid) + "/" + encodeURIComponent(a.clave));   // celular que ya no existe
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
  const r = await avisarAdmins(env, { titulo: "👀 El cliente abrió su enlace", cuerpo: recorta(cuerpo, 240), data: { tipo: "cliente_abrio", pedido: String(d.pedido || ""), token: t } });
  return json(r, r.ok ? 200 : 502);
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
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return json({ ok: false, error: "Solo POST" }, 405);
    try {
      const idToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      const b = await req.json().catch(() => ({}));
      if (b.accion === "cliente_abrio") return await accionClienteAbrio(b, env);   // sin sesión: el cliente no inicia sesión
      if (b.accion === "admin_chat") return await accionAdminChat(b, idToken, env);
      return await accionAdmin(b, idToken, env);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};
