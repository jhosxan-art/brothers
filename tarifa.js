"use strict";
/* Motor tarifario del servidor (misma lógica que la app del repartidor).
   · Urbano (≤ 4.0 km): 42, 52, 62, 72, 82 (+10 por cada 0.8 km) · termina en 2.
   · Rural (> 4.0 km): Math.round((57 + 12·km) / 10) · 10 − 3 · termina en 7.
   · Cada parada extra en la ruta: +C$ 20. */
const EXTRA_PARADA = 20, LIM_URBANO = 4.0, PASO_KM = 0.8;

function tarifaBase(km) {
  const k = Math.max(0, Number(km) || 0);
  if (k <= LIM_URBANO) return { regimen: "urbano", base: 42 + 10 * (Math.max(1, Math.ceil(k / PASO_KM - 1e-9)) - 1) };
  return { regimen: "rural", base: Math.round((57 + 12 * k) / 10) * 10 - 3 };
}
function calcTarifa(km, nParadas) {
  const t = tarifaBase(km), extra = Math.max(0, (Number(nParadas) || 1) - 1) * EXTRA_PARADA;
  return { regimen: t.regimen, base: t.base, extra, sugerida: t.base + extra };
}
function haversineKm(a, b) {
  const R = 6371, r = Math.PI / 180, dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
  const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const okPt = (p) => !!p && typeof p.lat === "number" && typeof p.lng === "number" && isFinite(p.lat) && isFinite(p.lng);

module.exports = { tarifaBase, calcTarifa, haversineKm, okPt, EXTRA_PARADA };
