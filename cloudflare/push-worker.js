/* ============================================================
   PUSH-WORKER · Cloudflare Worker (plan gratuito) que envía las notificaciones FCM
   Recibe del panel de administración:  POST  { token, titulo, cuerpo, canal, data }
   con la cabecera  Authorization: Bearer <sesión de Firebase del administrador>

   Comprueba que quien llama es ADMINISTRADOR y envía la notificación con la API HTTP v1 de FCM.
   La llave del servicio de Firebase vive SOLO aquí (como "Secret"), nunca en el navegador.

   Variables que debes crear en Cloudflare (Settings → Variables and Secrets):
     FCM_PROJECT_ID    → ID del proyecto de Firebase (ej. brothers-delivery-12345)       (texto)
     FIREBASE_API_KEY  → "Clave de API web" de Firebase (la de firebase-config.js)       (texto)
     DB_URL            → URL de la Realtime Database, sin "/" al final                    (texto)
                         ej. https://brothers-delivery-12345-default-rtdb.firebaseio.com
     SA_CLIENT_EMAIL   → "client_email" del JSON de la cuenta de servicio                 (Secret)
     SA_PRIVATE_KEY    → "private_key" del JSON de la cuenta de servicio (todo el texto)  (Secret)
   ============================================================ */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
};
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

let cache = { token: null, exp: 0 };   // el token de Google se reutiliza ~55 minutos

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

/* Token de acceso de Google para la API de FCM (firma un JWT con la llave de la cuenta de servicio) */
async function tokenGoogle(env) {
  const ahora = Math.floor(Date.now() / 1000);
  if (cache.token && cache.exp > ahora + 120) return cache.token;
  const cabecera = { alg: "RS256", typ: "JWT" };
  const reclamo = { iss: env.SA_CLIENT_EMAIL, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: ahora, exp: ahora + 3600 };
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

/* ¿La sesión de Firebase es válida y es de un administrador? (admins/{uid} existe) */
async function esAdmin(idToken, env) {
  const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=" + encodeURIComponent(env.FIREBASE_API_KEY), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken })
  });
  if (!r.ok) return false;
  const j = await r.json();
  const uid = j && j.users && j.users[0] && j.users[0].localId;
  if (!uid) return false;
  const d = await fetch(env.DB_URL.replace(/\/+$/, "") + "/admins/" + encodeURIComponent(uid) + ".json?auth=" + encodeURIComponent(idToken));
  if (!d.ok) return false;
  const v = await d.json();
  return v !== null && v !== false;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST") return json({ ok: false, error: "Solo POST" }, 405);
    try {
      const idToken = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!idToken) return json({ ok: false, error: "Falta la sesión del administrador" }, 401);
      if (!(await esAdmin(idToken, env))) return json({ ok: false, error: "No eres administrador" }, 403);

      const b = await req.json();
      const token = String(b.token || ""), titulo = String(b.titulo || "").slice(0, 100), cuerpo = String(b.cuerpo || "").slice(0, 300);
      if (token.length < 20 || !titulo) return json({ ok: false, error: "Datos incompletos" }, 400);
      const canal = ["pedidos", "mensajes"].includes(b.canal) ? b.canal : "pedidos";
      const data = {}; Object.entries(b.data || {}).slice(0, 10).forEach(([k, v]) => { data[String(k).slice(0, 40)] = String(v == null ? "" : v).slice(0, 200); });

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
      if (r.ok) return json({ ok: true, id: j.name });
      const det = (j.error && j.error.details && j.error.details.find((x) => x.errorCode)) || {};
      const code = det.errorCode || (j.error && j.error.status) || "ERROR";
      return json({ ok: false, code, error: (j.error && j.error.message) || "FCM rechazó el envío" }, r.status === 404 ? 404 : 502);
    } catch (err) {
      return json({ ok: false, error: String(err && err.message ? err.message : err) }, 500);
    }
  }
};
