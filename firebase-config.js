/* ============================================================
   CONFIGURACIÓN COMPARTIDA (repartidor + cliente)
   Pega aquí los datos de Firebase Console > Configuración del proyecto > Tus apps > Web
   ============================================================ */
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD_Rl3u322VMFNyOqVflaSXqDxTTTid_lM",
  authDomain: "brothers-deliverys.firebaseapp.com",
  databaseURL: "https://brothers-deliverys-default-rtdb.firebaseio.com",
  projectId: "brothers-deliverys",
  appId: "1:985252496445:web:71cc6ca8c92692f4b39654"
};

/* URL pública donde alojarás rastreo.html (ej. Firebase Hosting).
   Importante: en el APK la app corre desde archivos locales, por eso el
   enlace del cliente DEBE apuntar a tu dominio público, no a la app. */
const URL_RASTREO = "https://jhosxan-art.github.io/brothers/rastreo.html";

firebase.initializeApp(FIREBASE_CONFIG);
