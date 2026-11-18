"use strict";
/* ============================================================
   CLOUD FUNCTIONS · Brothers Deliverys (negociación de tarifa)
   1) asegurarTarifaOferta      → el servidor recalcula la tarifa sugerida de cada oferta y corrige cualquier
                                  trampa (km, paradas, sugerida o monto por debajo de la sugerida).
   2) notificarTarifaAceptada   → push al repartidor cuando el cliente acepta su tarifa.
   3) notificarAsignacionAdmin  → push al repartidor cuando la central (admin) le asigna un pedido.
   4) notificarPedidoDevuelto   → push a los demás repartidores cuando un pedido vuelve a quedar libre.
   5) notificarNuevaSolicitud   → push a TODOS los repartidores en cuanto entra un pedido nuevo (suena aunque estén en
                                  otra app o con la pantalla apagada). Si aún usas worker-solicitudes.js, apágalo o
                                  despliega con NOTIFICAR_NUEVOS=0 para no recibir el aviso doble.
   6) respuestaAusencia         → si el pedido entra fuera del horario de atención (o con "cerrado ahora"), le escribe al
                                  cliente el mensaje de ausencia configurado en Solicitudes → Horario de atención.
   Los tokens FCM salen de repartidores/{uid}/fcmToken (los mismos que ya guarda la app).
   ============================================================ */
const { onValueCreated, onValueWritten } = require("firebase-functions/v2/database");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { calcTarifa, haversineKm, okPt } = require("./tarifa");

admin.initializeApp();
const db = admin.database();

/* Ajusta si tu base de datos no está en us-central1 (la URL ...firebaseio.com es us-central1). */
const REGION = "us-central1";
const INSTANCE = "brothers-deliverys-default-rtdb";
const RAIZ = "solicitudes_entrantes";
const NOTIFICAR_DEVUELTOS = process.env.NOTIFICAR_DEVUELTOS !== "0";
const NOTIFICAR_NUEVOS = process.env.NOTIFICAR_NUEVOS !== "0";
setGlobalOptions({ region: REGION, maxInstances: 10 });

const money = (n) => "C$ " + Math.round(Number(n) || 0);
const corto = (s, n) => String(s == null ? "" : s).slice(0, n);

/* ---------- Push ---------- */
function mensaje(token, titulo, cuerpo, id) {
  return {
    token,
    notification: { title: titulo, body: cuerpo },
    data: { tipo: "solicitud", solicitud: String(id) },
    /* Prioridad máxima: llega aunque el teléfono esté en reposo (Doze), con la pantalla apagada o en otra app. */
    android: { priority: "high", ttl: 600000, notification: { channelId: "pedidos", sound: "default", priority: "max", visibility: "public", defaultVibrateTimings: true, defaultLightSettings: true } },
    apns: { headers: { "apns-priority": "10" }, payload: { aps: { sound: "default", "interruption-level": "time-sensitive" } } }
  };
}
const tokenMuerto = (e) => /registration-token-not-registered|invalid-registration-token/.test((e && (e.code || e.message)) || "");
async function enviarPush(uid, titulo, cuerpo, id) {
  const ref = db.ref(`repartidores/${uid}/fcmToken`), token = (await ref.once("value")).val();
  if (!token || typeof token !== "string") return;
  try { await admin.messaging().send(mensaje(token, titulo, cuerpo, id)); }
  catch (e) { if (tokenMuerto(e)) await ref.remove().catch(() => {}); else console.error("push", uid, e.code || e.message); }
}
async function enviarAVarios(uids, titulo, cuerpo, id) {
  const snaps = await Promise.all(uids.map((u) => db.ref(`repartidores/${u}/fcmToken`).once("value")));
  const lista = uids.map((u, i) => ({ u, t: snaps[i].val() })).filter((x) => typeof x.t === "string" && x.t);
  for (let i = 0; i < lista.length; i += 500) {
    const lote = lista.slice(i, i + 500);
    const r = await admin.messaging().sendEach(lote.map((x) => mensaje(x.t, titulo, cuerpo, id)));
    await Promise.all(r.responses.map((resp, k) => (!resp.success && tokenMuerto(resp.error) ? db.ref(`repartidores/${lote[k].u}/fcmToken`).remove().catch(() => {}) : null)));
  }
}

/* ---------- 1) Tarifa verificada por el servidor ---------- */
const paradasDe = (o) => {
  const v = Array.isArray(o.paradas) ? o.paradas : o.paradas && typeof o.paradas === "object" ? Object.values(o.paradas) : [];
  const pts = v.filter(okPt);
  return pts.length ? pts : okPt(o.origen) ? [o.origen] : [];
};
const destinoDe = (s) => {
  const p = s.pedido || {};
  if (p.destino && okPt(p.destino)) return { lat: p.destino.lat, lng: p.destino.lng };
  if (okPt(s.clienteGps)) return { lat: s.clienteGps.lat, lng: s.clienteGps.lng };
  return null;
};
exports.asegurarTarifaOferta = onValueWritten({ ref: `/${RAIZ}/{id}/negociacion/ofertas/{uid}`, instance: INSTANCE }, async (event) => {
  const o = event.data.after.val();
  if (!o || event.params.uid === "central" || o.tipo === "central") return;
  const s = (await db.ref(`${RAIZ}/${event.params.id}`).once("value")).val();
  if (!s || s.estado !== "nuevo" || s.repartidorUid) return;
  const n = s.negociacion || {};
  if (n.aceptada || n.fijo) return; /* el cliente ya decidió: no se toca el monto */

  const pts = paradasDe(o), dest = destinoDe(s);
  let kmMin = 0;
  if (dest && pts.length) { const cadena = pts.concat([dest]); for (let i = 0; i < cadena.length - 1; i++) kmMin += haversineKm(cadena[i], cadena[i + 1]); }
  const km = Math.round(Math.max(Number(o.km) || 0, kmMin) * 100) / 100;
  const nPar = Math.max(1, pts.length || Number(o.nParadas) || 1);
  const t = calcTarifa(km, nPar);
  const monto = Math.max(Math.round(Number(o.monto) || 0), t.sugerida);
  const esperado = { km, regimen: t.regimen, base: t.base, extra: t.extra, nParadas: nPar, sugerida: t.sugerida, monto, tipo: monto > t.sugerida ? "subida" : "sugerida" };
  const cambios = {};
  Object.keys(esperado).forEach((k) => {
    const a = o[k], b = esperado[k];
    if (typeof b === "number" ? Math.abs((Number(a) || 0) - b) > 0.005 : a !== b) cambios[k] = b;
  });
  if (Object.keys(cambios).length) { await event.data.after.ref.update(cambios); console.log("Tarifa corregida", event.params.id, event.params.uid, cambios); }
});

/* ---------- 2) El cliente aceptó la tarifa de un repartidor ---------- */
exports.notificarTarifaAceptada = onValueCreated({ ref: `/${RAIZ}/{id}/negociacion/aceptada`, instance: INSTANCE }, async (event) => {
  const a = event.data.val();
  if (!a || !a.uid || a.uid === "central") return;
  const s = (await db.ref(`${RAIZ}/${event.params.id}`).once("value")).val() || {};
  await enviarPush(a.uid, "🎉 ¡El cliente aceptó tu tarifa!", `${money(a.monto)} · ${corto(s.nombre || "Cliente", 30)}`, event.params.id);
});

/* ---------- 3) La central asignó un pedido a un repartidor ---------- */
exports.notificarAsignacionAdmin = onValueCreated({ ref: `/${RAIZ}/{id}/asignadoPor`, instance: INSTANCE }, async (event) => {
  if (event.data.val() !== "admin") return;
  const s = (await db.ref(`${RAIZ}/${event.params.id}`).once("value")).val();
  if (!s || !s.repartidorUid) return;
  const fijo = s.negociacion && s.negociacion.fijo ? " · envío " + money(s.negociacion.fijo.monto) : "";
  await enviarPush(s.repartidorUid, "📌 La central te asignó un pedido", `${corto(s.nombre || "Cliente", 30)}${fijo}`, event.params.id);
});

/* ---------- 4) Un pedido devuelto vuelve a estar disponible ---------- */
exports.notificarPedidoDevuelto = onValueWritten({ ref: `/${RAIZ}/{id}/reasignadoTs`, instance: INSTANCE }, async (event) => {
  if (!NOTIFICAR_DEVUELTOS) return;
  if (!event.data.after.exists() || event.data.before.val() === event.data.after.val()) return;
  const s = (await db.ref(`${RAIZ}/${event.params.id}`).once("value")).val();
  if (!s || s.estado !== "nuevo" || s.repartidorUid) return;
  const omit = s.omitidoPor || {}, reps = (await db.ref("repartidores").once("value")).val() || {};
  const uids = Object.keys(reps).filter((u) => !omit[u] && reps[u] && reps[u].fcmToken);
  if (!uids.length) return;
  const fijo = s.negociacion && s.negociacion.fijo ? ` · envío ${money(s.negociacion.fijo.monto)} ya acordado` : "";
  await enviarAVarios(uids, "🔁 Pedido disponible", `${corto(s.nombre || "Cliente", 30)}${fijo}`, event.params.id);
});

/* ---------- 5) Entra un pedido nuevo: aviso a todos los repartidores ---------- */
exports.notificarNuevaSolicitud = onValueCreated({ ref: `/${RAIZ}/{id}`, instance: INSTANCE }, async (event) => {
  if (!NOTIFICAR_NUEVOS) return;
  const s = event.data.val();
  if (!s || s.estado !== "nuevo" || s.repartidorUid) return;
  const reps = (await db.ref("repartidores").once("value")).val() || {};
  const uids = Object.keys(reps).filter((u) => reps[u] && reps[u].fcmToken);
  if (!uids.length) return;
  const p = s.pedido || {}, que = p.quiere ? " · " + corto(p.quiere, 60) : "";
  await enviarAVarios(uids, "🆕 Nuevo pedido", `${corto(s.nombre || "Cliente", 30)}${que}`, event.params.id);
});

/* ---------- 6) Mensaje de ausencia fuera del horario de atención ---------- */
const MENSAJE_AUSENCIA = "👋 ¡Hola! En este momento estamos fuera de nuestro horario de atención. Recibimos tu pedido y lo atenderemos en cuanto abramos. ¡Gracias por escribirnos! 🛵";
const aMin = (h) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(h || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
function ahoraEn(zona) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: zona || "America/Managua", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const p = {}; f.formatToParts(new Date()).forEach((x) => { p[x.type] = x.value; });
  return { dia: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday], min: (parseInt(p.hour, 10) % 24) * 60 + parseInt(p.minute, 10) };
}
function abiertoAhora(cfg) {
  const { dia, min } = ahoraEn(cfg.zona), dias = cfg.dias || {};
  const ventana = (d) => (d && d.abierto ? [aMin(d.desde), aMin(d.hasta)] : null);
  const h = ventana(dias[dia]);
  if (h && h[0] != null && h[1] != null) { if (h[1] > h[0]) { if (min >= h[0] && min < h[1]) return true; } else if (min >= h[0]) return true; }
  const y = ventana(dias[(dia + 6) % 7]);
  return !!(y && y[0] != null && y[1] != null && y[1] <= y[0] && min < y[1]);
}
exports.respuestaAusencia = onValueCreated({ ref: `/${RAIZ}/{id}`, instance: INSTANCE }, async (event) => {
  const s = event.data.val();
  if (!s || s.estado !== "nuevo" || s.repartidorUid) return;
  const cfg = (await db.ref("configuracion/horarioAtencion").once("value")).val();
  if (!cfg) return;
  const cerrado = cfg.cerradoManual === true || (cfg.activo === true && !abiertoAhora(cfg));
  if (!cerrado) return;
  const texto = String(cfg.mensaje || MENSAJE_AUSENCIA).slice(0, 500);
  const ref = db.ref(`${RAIZ}/${event.params.id}`);
  await ref.child("mensajes").push({ de: "admin", tipo: "texto", texto, ts: admin.database.ServerValue.TIMESTAMP, auto: true });
  await ref.update({ ultimoMensaje: texto.slice(0, 200), ultimoDe: "admin" });
});
