/* ============================================================
   BUSCADOR, RUTAS POR CALLES E ICONOS DE NEGOCIOS (admin y repartidor)
   - Buscador: ciudades, barrios, direcciones, negocios y coordenadas
     (Nominatim / OpenStreetMap; también entiende enlaces de Google Maps)
   - Rutas: OSRM (datos de OpenStreetMap) → respeta sentidos de calle, giros prohibidos y calles de un solo sentido
   - Servicios públicos y gratuitos: uso ligero. Para mucho tráfico conviene un servidor propio.
   ============================================================ */
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

const Buscar = (() => {
  /* "12.1364, -86.2514" · "12.1364 -86.2514" · enlaces de Google Maps (@lat,lng · q=lat,lng · !3dLAT!4dLNG) */
  function coords(texto) {
    const t = String(texto || "").trim();
    let m = t.match(/@(-?\d{1,3}\.\d+),\s*(-?\d{1,3}\.\d+)/) || t.match(/[?&](?:q|ll|query|destination)=(-?\d{1,3}\.\d+)(?:,|%2C)\s*(-?\d{1,3}\.\d+)/i) ||
        t.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
    if (!m) m = t.match(/^\(?\s*(-?\d{1,3}(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:[.,]\d+)?)\s*\)?$/);
    if (!m) return null;
    const a = parseFloat(m[1].replace(",", ".")), b = parseFloat(m[2].replace(",", "."));
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) return { lat: a, lng: b };
    if (Math.abs(b) <= 90 && Math.abs(a) <= 180) return { lat: b, lng: a };   // vino como "lng, lat"
    return null;
  }
  async function buscar(texto, limites) {
    const c = coords(texto);
    if (c) return [{ nombre: `Coordenadas ${c.lat.toFixed(6)}, ${c.lng.toFixed(6)}`, detalle: "Ubicación exacta", lat: c.lat, lng: c.lng, tipo: "coords" }];
    const p = new URLSearchParams({ q: texto, format: "jsonv2", limit: "8", dedupe: "1", "accept-language": "es" });
    if (limites) p.set("viewbox", `${limites.getWest()},${limites.getNorth()},${limites.getEast()},${limites.getSouth()}`);   // da prioridad a lo que ves en pantalla
    const r = await fetch("https://nominatim.openstreetmap.org/search?" + p);
    if (!r.ok) throw new Error("el buscador no respondió (" + r.status + ")");
    return (await r.json()).map((x) => ({
      nombre: x.name || String(x.display_name).split(",")[0], detalle: x.display_name, lat: +x.lat, lng: +x.lon, tipo: x.type
    }));
  }
  return { coords, buscar };
})();

const Ruta = (() => {
  const rad = (x) => (x * Math.PI) / 180;
  function dist(a, b) {   // metros entre [lat,lng] y [lat,lng]
    const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  }
  function rumbo(a, b) {
    const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
    const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  }
  /* Ruta por calles (auto: respeta sentidos y giros) con los pasos: calle, giro y distancia */
  async function pedir(o, d) {
    const r = await fetch(`https://router.project-osrm.org/route/v1/driving/${o.lng},${o.lat};${d.lng},${d.lat}?overview=full&geometries=geojson&steps=true`);
    const j = await r.json();
    if (j.code !== "OK" || !j.routes || !j.routes[0]) throw new Error("sin ruta");
    const rt = j.routes[0];
    return {
      pts: rt.geometry.coordinates.map(([x, y]) => [y, x]), dist: Math.round(rt.distance), dur: rt.duration,
      pasos: rt.legs[0].steps.map((s) => ({
        tipo: s.maneuver.type, mod: s.maneuver.modifier || "", nombre: s.name || "", dist: Math.round(s.distance),
        loc: { lat: s.maneuver.location[1], lng: s.maneuver.location[0] }, salida: s.maneuver.exit
      }))
    };
  }
  const MOD = {
    left: ["⬅️", "Gira a la izquierda"], right: ["➡️", "Gira a la derecha"],
    "slight left": ["↖️", "Gira ligeramente a la izquierda"], "slight right": ["↗️", "Gira ligeramente a la derecha"],
    "sharp left": ["↩️", "Gira cerrado a la izquierda"], "sharp right": ["↪️", "Gira cerrado a la derecha"],
    straight: ["⬆️", "Sigue recto"], uturn: ["🔄", "Da la vuelta"]
  };
  function textoPaso(p) {
    if (p.tipo === "arrive") return ["🏁", "Has llegado a tu destino"];
    if (p.tipo === "roundabout" || p.tipo === "rotary") return ["🔁", "En la rotonda toma la salida " + (p.salida || "") + (p.nombre ? " hacia " + p.nombre : "")];
    const m = MOD[p.mod] || ["⬆️", "Sigue"];
    return [m[0], m[1] + (p.nombre ? (p.mod === "straight" || !p.mod ? " por " : " hacia ") + p.nombre : "")];
  }
  const calles = (pasos) => pasos.map((p) => p.nombre).filter((n, i, a) => n && n !== a[i - 1]).slice(0, 8).join(" → ");
  /* Flechas sobre la ruta: muestran hacia dónde se circula en cada calle */
  function flechas(pts, grupo, color) {
    grupo.clearLayers();
    let acum = 0, prox = 120, n = 0;
    for (let i = 1; i < pts.length && n < 70; i++) {
      acum += dist(pts[i - 1], pts[i]);
      if (acum >= prox) {
        prox += 200; n++;
        grupo.addLayer(L.marker(pts[i], {
          icon: L.divIcon({ className: "", html: `<div class="flecha-ruta" style="transform:rotate(${rumbo(pts[i - 1], pts[i]).toFixed(0)}deg);color:${color}">▲</div>`, iconSize: [16, 16], iconAnchor: [8, 8] }),
          interactive: false, keyboard: false
        }));
      }
    }
  }
  return { dist, pedir, textoPaso, calles, flechas };
})();

/* Negocios que el administrador agrega al mapa */
const Lugares = {
  ICONOS: ["🍕", "🍔", "🍗", "🌮", "🥩", "🍣", "☕", "🍰", "🍺", "🍹", "🍦", "🥖", "🛒", "🏪", "💊", "🏥", "🏦", "⛽", "🔧", "💈", "👕", "📦", "🏢", "🏠"],
  iconoMapa(l, sel) {
    return L.divIcon({
      className: "",
      html: `<div class="pin-lugar${sel ? " sel" : ""}"><b>${escHtml(l.icono || "📍")}</b></div><span class="etq-lugar">${escHtml(l.nombre)}</span>`,
      iconSize: [34, 34], iconAnchor: [17, 17]
    });
  }
};

/* Día de trabajo (igual que la factura): antes de las 8:00 a. m. todavía cuenta como el día anterior. Clave: AAAA-MM-DD */
const Dia = {
  clave(fecha) {
    const d = fecha ? new Date(fecha) : new Date();
    if (!fecha && d.getHours() < 8) d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
};
