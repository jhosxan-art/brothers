/* ============================================================
   Brother's Deliverys — Service Worker del Administrador
   FASE 1 + 3 · Push de alta prioridad estilo WhatsApp + redirección inteligente + consolidación
   - Evento `push`: banner flotante (heads-up) con emisor + contenido, vibración, acciones y
     requireInteraction: true. Funciona con la app minimizada, en otra app o con pantalla apagada.
   - Evento `notificationclick`: enfoca la pestaña del Administrador (o abre una nueva) y lleva
     directo al panel de Solicitudes para revisar, asignar a un repartidor o generar enlace de invitado.
   - Alta prioridad (urgency: 'high', ttl: 86400): se define del lado del emisor (FCM webpush headers);
     este archivo expone esos valores en PUSH_CONFIG para que el Worker/cliente los reutilicen.
   ============================================================ */
"use strict";

const SW_VERSION = "admin-push-v1.1.0";
const PUSH_CONFIG = Object.freeze({ urgency: "high", ttl: 86400 });
const PANEL_URL = "./admin.html";
const ICONO = "./icons/icon-192.png";
const BADGE = "./icons/badge-96.png";
const VIBRACION = [300, 120, 300, 120, 500];

self.addEventListener("install", () => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

/* ---------- Lectura tolerante del payload (FCM data / notification / JSON plano / texto) ---------- */
function leerPayload(event) {
  let raw = {};
  if (event.data) {
    try { raw = event.data.json(); } catch (_) { try { raw = { body: event.data.text() }; } catch (__) { raw = {}; } }
  }
  const n = (raw && raw.notification) || {};
  const d = Object.assign({}, (raw && raw.data) || {});
  const pick = (...v) => { for (const x of v) if (x != null && String(x).trim() !== "") return String(x); return ""; };
  return {
    titulo: pick(n.title, d.titulo, d.title, raw.title, d.cliente, d.emisor, "Brother’s Deliverys"),
    cuerpo: pick(n.body, d.cuerpo, d.body, raw.body, d.texto, "Hay una solicitud de pedido"),
    tipo: pick(d.tipo, raw.tipo, "sol_nuevo"),
    solicitud: pick(d.solicitud, d.solicitudId, raw.solicitud),
    ordenId: pick(d.ordenId, raw.ordenId),
    emisor: pick(d.emisor, d.cliente, d.repartidor, n.title),
    url: pick(d.url, raw.url),
    icono: pick(n.icon, d.icono, ICONO),
    imagen: pick(n.image, d.imagen)
  };
}

/* ---------- URL de destino: siempre el panel de gestión del Administrador ---------- */
function urlDestino(p) {
  const u = new URL(p.url || PANEL_URL, self.registration.scope);
  u.searchParams.set("push", p.ordenId && !p.solicitud ? "orden" : "sol");
  if (p.solicitud) u.searchParams.set("id", p.solicitud);
  else if (p.ordenId) u.searchParams.set("id", p.ordenId);
  u.searchParams.set("t", String(Date.now()));
  return u.href;
}

/* ---------- PUSH: banner estilo WhatsApp ---------- */
self.addEventListener("push", (event) => {
  const p = leerPayload(event);
  const clave = p.solicitud || p.ordenId || p.emisor || "general";
  const urgente = true;   // toda alerta del admin es de alta prioridad: ver TIPOS_URGENTES si luego se quiere filtrar
  const opciones = {
    body: p.cuerpo,
    icon: p.icono || ICONO,
    badge: BADGE,
    tag: "brothers-" + clave,            // un mismo chat/pedido se agrupa, como WhatsApp
    renotify: true,                      // vuelve a sonar y vibrar aunque ya exista
    requireInteraction: urgente,         // se queda fija hasta que el admin la toque
    silent: false,
    vibrate: VIBRACION,
    timestamp: Date.now(),
    dir: "auto",
    lang: "es",
    actions: [
      { action: "ver", title: "👁️ Ver pedido" },
      { action: "asignar", title: "🛵 Asignar / Enlace" }
    ],
    data: { tipo: p.tipo, solicitud: p.solicitud, ordenId: p.ordenId, url: urlDestino(p), urgency: PUSH_CONFIG.urgency, ttl: PUSH_CONFIG.ttl, ts: Date.now() }
  };
  if (p.imagen) opciones.image = p.imagen;

  event.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // Si el administrador ya está mirando el panel (ventana visible y enfocada) basta la voz + el aviso interno:
    // no se duplica el banner. En cualquier otro caso (minimizada, otra app, pantalla apagada) se muestra el banner.
    const mirando = abiertas.some((c) => c.focused && c.visibilityState === "visible");
    if (!mirando) await self.registration.showNotification(p.titulo, opciones);
    // Avisa a las pestañas abiertas para que disparen la voz ("Hay una solicitud de pedido") y refresquen el panel.
    abiertas.forEach((c) => c.postMessage({ tipo: "PUSH_RECIBIDO", datos: { tipo: p.tipo, solicitud: p.solicitud, ordenId: p.ordenId, titulo: p.titulo, cuerpo: p.cuerpo } }));
  })());
});

/* ---------- CLICK: enfocar pestaña del Administrador o abrir una nueva en el panel ---------- */
self.addEventListener("notificationclick", (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  const accion = event.action || "ver";
  const destino = d.url || new URL(PANEL_URL, self.registration.scope).href;

  event.waitUntil((async () => {
    const lista = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const panel = new URL(PANEL_URL, self.registration.scope).pathname;
    const existente = lista.find((c) => { try { return new URL(c.url).pathname === panel; } catch (_) { return false; } }) || lista[0];
    const mensaje = { tipo: "PUSH_ABRIR", accion, datos: { tipo: d.tipo, solicitud: d.solicitud, ordenId: d.ordenId } };
    if (existente) {
      try { await existente.focus(); } catch (_) {}
      existente.postMessage(mensaje);
      return;
    }
    const nueva = await self.clients.openWindow(destino + (destino.indexOf("#") === -1 ? "#" + accion : ""));
    if (nueva) { try { await nueva.focus(); } catch (_) {} }
  })());
});

self.addEventListener("notificationclose", () => { /* sin acción: la notificación quedó descartada */ });

/* ---------- Mensajes desde la página ---------- */
self.addEventListener("message", (event) => {
  const m = event.data || {};
  if (m.tipo === "SKIP_WAITING") self.skipWaiting();
  if (m.tipo === "PING" && event.source) event.source.postMessage({ tipo: "PONG", version: SW_VERSION, config: PUSH_CONFIG });
});

/* Si el navegador renueva la suscripción push, se pide a la página que la vuelva a registrar. */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((cs) => cs.forEach((c) => c.postMessage({ tipo: "PUSH_RENOVAR" }))));
});
