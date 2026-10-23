/* ============================================================
   ICONOS DE MARCA — repartidor con mochila celeste y pin de destino
   Se usan en el logo, en los mapas y en las pantallas finales.
   ============================================================ */
const RIDER_SVG = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Repartidor de Brother’s">
  <!-- mochila celeste -->
  <rect x="6" y="13" width="21" height="23" rx="5" fill="#3DB8F5" stroke="#0E141B" stroke-width="2"/>
  <rect x="9.5" y="18" width="14" height="3.4" rx="1.7" fill="#fff"/>
  <circle cx="16.5" cy="29" r="3" fill="#E5322D"/>
  <!-- ruedas -->
  <circle cx="14" cy="51" r="7.5" fill="#0E141B"/><circle cx="14" cy="51" r="3" fill="#fff"/>
  <circle cx="51" cy="51" r="7.5" fill="#0E141B"/><circle cx="51" cy="51" r="3" fill="#fff"/>
  <!-- moto roja -->
  <path d="M11 45 H36 L43 35 H47.5 L52 40 L46 51 H19 Z" fill="#E5322D" stroke="#0E141B" stroke-width="2" stroke-linejoin="round"/>
  <rect x="16" y="39" width="19" height="5" rx="2.5" fill="#0E141B"/>
  <path d="M47 35 L44.5 25" stroke="#0E141B" stroke-width="3.2" stroke-linecap="round"/>
  <path d="M41.5 25 H48" stroke="#0E141B" stroke-width="3.2" stroke-linecap="round"/>
  <!-- repartidor -->
  <path d="M27 40 L35 46 L38 51" stroke="#1C2B3A" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M24 40 C22.5 31 26 23 32.5 21 C38 20.5 40 26 38 32 L37 40 Z" fill="#1C2B3A" stroke="#0E141B" stroke-width="1.5" stroke-linejoin="round"/>
  <rect x="25" y="30" width="12" height="2.6" rx="1.3" fill="#3DB8F5" transform="rotate(-8 31 31)"/>
  <path d="M36 25 L44 26" stroke="#1C2B3A" stroke-width="5" stroke-linecap="round"/>
  <circle cx="35" cy="14.5" r="7" fill="#0E141B"/>
  <path d="M37.5 11.5 H41.5 A3.5 3.5 0 0 1 41.5 18 H37.5 Z" fill="#3DB8F5"/>
  <rect x="28" y="12.5" width="5" height="2.2" rx="1.1" fill="#E5322D"/>
</svg>`;

const PIN_SVG = `<svg viewBox="0 0 34 44" width="34" height="44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M17 2C8.7 2 2 8.5 2 16.6 2 27 17 42 17 42S32 27 32 16.6C32 8.5 25.3 2 17 2Z" fill="#E5322D" stroke="#0E141B" stroke-width="2"/>
  <circle cx="17" cy="16.5" r="6" fill="#fff"/>
</svg>`;

// Inserta el repartidor en cualquier elemento con atributo data-rider
document.querySelectorAll("[data-rider]").forEach((el) => { el.innerHTML = RIDER_SVG; });

// Marcadores para Leaflet
function iconoRepartidor() {
  return L.divIcon({ className: "", html: `<div class="marca-rider">${RIDER_SVG}</div>`, iconSize: [56, 56], iconAnchor: [28, 28] });
}
function iconoPin() {
  return L.divIcon({ className: "", html: PIN_SVG, iconSize: [34, 44], iconAnchor: [17, 42] });
}

/* "rodrigo.perez@gmail.com" → "Rodrigo Perez" (nombre que se muestra en el mapa del administrador) */
function nombreDesdeCorreo(correo) {
  if (!correo) return "";
  const local = String(correo).split("@")[0];
  const limpio = local.replace(/[._\-+0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)
    .map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join(" ");
  return limpio || local;
}

/* Marcador del repartidor con su nombre en una burbuja (mapa del cliente y del administrador) */
function escHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function iconoRepartidorNombre(nombre, apagado = false) {
  return L.divIcon({
    className: "",
    html: `<div class="marca-rider-caja"><div class="marca-rider${apagado ? " apagado" : ""}">${RIDER_SVG}</div>` +
          (nombre ? `<span class="etiqueta-rider">${escHtml(nombre)}</span>` : "") + `</div>`,
    iconSize: [56, 56], iconAnchor: [28, 28]
  });
}
