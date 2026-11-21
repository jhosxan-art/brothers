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

/* Cada panel tiene su PROPIA sesión: si el administrador y un repartidor abren la app en el mismo
   navegador, uno no cierra la sesión del otro. admin.html define window.NOMBRE_APP = "admin". */
const APP = window.NOMBRE_APP
  ? firebase.initializeApp(FIREBASE_CONFIG, window.NOMBRE_APP)
  : firebase.initializeApp(FIREBASE_CONFIG);

/* (Opcional) URL pública de invitado.html. Si no la defines, se usa la misma carpeta que rastreo.html. */
// const URL_INVITADO = "https://jhosxan-art.github.io/brothers/invitado.html";

/* ============================================================
   CIUDADES (compartido cliente + repartidor)
   · Catálogo de ciudades con su centro. Se usa para detectar la ciudad por GPS, centrar mapas,
     filtrar negocios/ubicaciones, estimar la tarifa entre ciudades y enrutar cada pedido
     (pedido.ciudadRuta = ciudad cuyos repartidores lo reciben).
   ============================================================ */
const Ciudades = (() => {
  const LISTA = [
    { id: "chinandega", nombre: "Chinandega", lat: 12.6294, lng: -87.1311 },
    { id: "el-viejo", nombre: "El Viejo", lat: 12.6628, lng: -87.1655 },
    { id: "chichigalpa", nombre: "Chichigalpa", lat: 12.5764, lng: -87.0239 },
    { id: "posoltega", nombre: "Posoltega", lat: 12.5989, lng: -86.9831 },
    { id: "corinto", nombre: "Corinto", lat: 12.4833, lng: -87.1744 },
    { id: "leon", nombre: "León", lat: 12.4379, lng: -86.8780 },
    { id: "managua", nombre: "Managua", lat: 12.1364, lng: -86.2514 }
  ];
  const DEFECTO = "chinandega";
  const MAX_DETECCION_KM = 30;   // más lejos de cualquier ciudad del catálogo: no se detecta
  const FACTOR_CALLE = 1.3;      // distancia por calles ≈ línea recta × 1.3
  const R = Math.PI / 180;
  const km = (a, b) => {
    const dLa = (b.lat - a.lat) * R, dLo = (b.lng - a.lng) * R;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  };
  const porId = (id) => LISTA.find((c) => c.id === id) || null;
  const nombre = (id) => { const c = porId(id); return c ? c.nombre : "Ciudad"; };
  function deCoord(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let mejor = null, md = Infinity;
    LISTA.forEach((c) => { const d = km({ lat, lng }, c); if (d < md) { md = d; mejor = c; } });
    return mejor && md <= MAX_DETECCION_KM ? { id: mejor.id, nombre: mejor.nombre, lat: mejor.lat, lng: mejor.lng, distKm: md } : null;
  }
  /* Misma lógica del motor tarifario (urbano ≤ 4 km termina en 2 · rural termina en 7) */
  function tarifaKm(k) {
    k = Math.max(0, Number(k) || 0);
    if (k <= 4.0) return 42 + 10 * (Math.max(1, Math.ceil(k / 0.8 - 1e-9)) - 1);
    return Math.round((57 + 12 * k) / 10) * 10 - 3;
  }
  const kmRuta = (a, b) => km(a, b) * FACTOR_CALLE;
  return { LISTA, DEFECTO, porId, nombre, deCoord, km, kmRuta, tarifaKm };
})();
