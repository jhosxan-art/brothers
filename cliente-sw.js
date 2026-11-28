/* Service worker de los CLIENTES: recibe las promociones push de Brother's Deliverys con la app cerrada. */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyD_Rl3u322VMFNyOqVflaSXqDxTTTid_lM",
  authDomain: "brothers-deliverys.firebaseapp.com",
  databaseURL: "https://brothers-deliverys-default-rtdb.firebaseio.com",
  projectId: "brothers-deliverys",
  messagingSenderId: "985252496445",
  appId: "1:985252496445:web:71cc6ca8c92692f4b39654"
});
firebase.messaging();   // las notificaciones con «notification» las muestra el navegador solas
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = (e.notification.data && (e.notification.data.FCM_MSG && e.notification.data.FCM_MSG.fcmOptions && e.notification.data.FCM_MSG.fcmOptions.link)) || (e.notification.data && e.notification.data.link) || "./cliente-app.html";
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((l) => { for (const c of l) { if ("focus" in c) return c.focus(); } return clients.openWindow(url); }));
});
