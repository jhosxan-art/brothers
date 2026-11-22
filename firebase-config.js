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
   CIUDADES (compartido cliente + repartidor + admin)
   · Cobertura: solo se pueden elegir/detectar las ciudades que el administrador habilita
     (configuracion/cobertura). Sin configuración: Chinandega y Chichigalpa.
   · Reconoce ciudad por coordenadas (GPS/pin) y por texto (nombre de ciudad o barrios, repartos y comarcas).
     Los nombres repetidos en varias ciudades son ambiguos: se resuelven con la ciudad base del cliente.
   · Enrutamiento: pedido.ciudadRuta = ciudad donde se RETIRA el pedido (sus repartidores lo reciben).
   ============================================================ */
const Ciudades = (() => {
  /* «zonas» = barrios/repartos/comarcas ya conocidos. El admin agrega más desde Cobertura por ciudades. */
  const CATALOGO = [
    { id: "chinandega", nombre: "Chinandega", lat: 12.6294, lng: -87.1311, zonas: [] },
    { id: "chichigalpa", nombre: "Chichigalpa", lat: 12.5764, lng: -87.0239, zonas: [] },
    { id: "el-viejo", nombre: "El Viejo", lat: 12.6628, lng: -87.1655, zonas: [] },
    { id: "posoltega", nombre: "Posoltega", lat: 12.5989, lng: -86.9831, zonas: [] },
    { id: "corinto", nombre: "Corinto", lat: 12.4833, lng: -87.1744, zonas: [] },
    { id: "leon", nombre: "León", lat: 12.4379, lng: -86.8780, zonas: [] },
    { id: "managua", nombre: "Managua", lat: 12.1364, lng: -86.2514, zonas: [] }
  ];
  const COBERTURA_DEFECTO = ["chinandega", "chichigalpa"];
  const MAX_ZONA_KM = 30;        // una zona del mapa se asigna a la ciudad más cercana si está a menos de esto
  const MAX_DETECCION_KM = 15;   // más lejos de toda ciudad habilitada: no se detecta
  const FACTOR_CALLE = 1.3;      // distancia por calles ≈ línea recta × 1.3
  const R = Math.PI / 180;
  let cob = null, suscrito = false;
  const oyentes = [];

  const km = (a, b) => {
    const dLa = (b.lat - a.lat) * R, dLo = (b.lng - a.lng) * R;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * R) * Math.cos(b.lat * R) * Math.sin(dLo / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(x));
  };
  const porId = (id) => CATALOGO.find((c) => c.id === id) || null;
  const nombre = (id) => { const c = porId(id); return c ? c.nombre : "Ciudad"; };
  const norm = (s) => String(s == null ? "" : s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

  function habilitadas() {
    let l = CATALOGO.filter((c) => (cob ? !!(cob[c.id] && cob[c.id].activa === true) : COBERTURA_DEFECTO.indexOf(c.id) >= 0));
    if (!l.length) l = CATALOGO.filter((c) => COBERTURA_DEFECTO.indexOf(c.id) >= 0);
    return l;
  }
  const habilitada = (id) => habilitadas().some((c) => c.id === id);
  function defecto() { const a = habilitadas(); return (a.find((c) => c.id === "chinandega") || a[0]).id; }

  function deCoord(lat, lng) {
    lat = Number(lat); lng = Number(lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let mejor = null, md = Infinity;
    habilitadas().forEach((c) => { const d = km({ lat, lng }, c); if (d < md) { md = d; mejor = c; } });
    return mejor && md <= MAX_DETECCION_KM ? { id: mejor.id, nombre: mejor.nombre, lat: mejor.lat, lng: mejor.lng, distKm: md } : null;
  }

  /* Barrios/repartos/comarcas de una ciudad: los tomados del MAPA del admin (zonasMapa, sincronizado desde `zonas`)
     + los extra que escribió el admin a mano. También se reconocen sin el prefijo («Barrio San Antonio» → «San Antonio»). */
  const cacheZonas = {};
  const PREFIJO_ZONA = /^(barrio|reparto|comarca|residencial|colonia|urbanizacion|rpto|bo)\s+/;
  function zonasDe(id) {
    if (cacheZonas[id]) return cacheZonas[id];
    const c = porId(id), v = cob && cob[id] ? cob[id] : {};
    const lista = (c ? c.zonas : []).concat(typeof v.zonasMapa === "string" ? v.zonasMapa.split(/[,;\n]+/) : [], typeof v.zonas === "string" ? v.zonas.split(/[,;\n]+/) : []);
    const set = new Set();
    lista.forEach((n) => { const z = norm(n); if (z.length < 3) return; set.add(z); const s = z.replace(PREFIJO_ZONA, ""); if (s.length >= 3) set.add(s); });
    return (cacheZonas[id] = Array.from(set));
  }
  /* Ciudad que nombra un texto (dirección, negocio…) o null. Si el nombre es ambiguo entre ciudades, gana la «preferida». */
  function deTexto(texto, preferida) {
    const t = " " + norm(texto) + " ";
    if (t.trim().length < 3) return null;
    const tiene = (frase) => t.indexOf(" " + frase + " ") >= 0;
    const act = habilitadas();
    const resolver = (lista) => (lista.length === 1 ? lista[0].id : lista.length > 1 && preferida && lista.some((c) => c.id === preferida) ? preferida : null);
    const porNombre = act.filter((c) => tiene(norm(c.nombre)));
    if (porNombre.length) return resolver(porNombre);   // nombre explícito de ciudad: manda sobre los barrios
    return resolver(act.filter((c) => zonasDe(c.id).some(tiene)));
  }

  /* Lee configuracion/cobertura en vivo (requiere sesión de Firebase). alCambiar se llama en cada cambio. */
  function suscribir(db, alCambiar) {
    if (typeof alCambiar === "function") oyentes.push(alCambiar);
    if (suscrito) return;
    suscrito = true;
    try {
      db.ref("configuracion/cobertura").on("value", (s) => {
        const v = s.val();
        cob = v && typeof v === "object" ? v : null;
        Object.keys(cacheZonas).forEach((k) => { delete cacheZonas[k]; });
        oyentes.forEach((f) => { try { f(); } catch (_) {} });
      }, () => {});
    } catch (_) { suscrito = false; }
  }

  /* Misma lógica del motor tarifario (urbano ≤ 4 km termina en 2 · rural termina en 7) */
  function tarifaKm(k) {
    k = Math.max(0, Number(k) || 0);
    if (k <= 4.0) return 42 + 10 * (Math.max(1, Math.ceil(k / 0.8 - 1e-9)) - 1);
    return Math.round((57 + 12 * k) / 10) * 10 - 3;
  }
  const kmRuta = (a, b) => km(a, b) * FACTOR_CALLE;
  return { CATALOGO, COBERTURA_DEFECTO, MAX_ZONA_KM, habilitadas, habilitada, get DEFECTO() { return defecto(); }, porId, nombre, deCoord, deTexto, zonasDe, suscribir, km, kmRuta, tarifaKm };
})();
