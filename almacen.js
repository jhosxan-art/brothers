/* ============================================================
   ALMACÉN REDUNDANTE — la sesión del cliente no se pierde aunque cierre la ventana por error.
   Todo lo que la app guarda con claves «brothers_*» (perfil, sesión activa, conversación en curso,
   resumen, última dirección, chats anteriores…) se respalda además en:
     · IndexedDB   (todas las claves)
     · cookie 1 año (solo perfil y sesión activa, que son pequeños)
     · memoria      (si localStorage falla o está bloqueado)
   Al abrir la app, `Almacen.restaurar()` recupera lo que falte en localStorage desde esos respaldos.
   Además pide al navegador almacenamiento persistente para que no lo borre por falta de espacio.
   Debe cargarse ANTES de cliente-app.js.
   ============================================================ */
(() => {
  "use strict";

  const PREFIJO = "brothers_";
  const CLAVES_COOKIE = ["brothers_cliente_v1", "brothers_sesion_activa"];
  const BD = "brothers_almacen", TABLA = "kv";
  const mem = new Map();
  const esMia = (k) => typeof k === "string" && k.indexOf(PREFIJO) === 0;

  let LS = null;
  try { LS = window.localStorage; } catch (_) { LS = null; }
  const esLocal = (o) => !!LS && o === LS;

  const sSet = Storage.prototype.setItem;
  const sGet = Storage.prototype.getItem;
  const sRem = Storage.prototype.removeItem;

  /* ---------- IndexedDB ---------- */
  let dbp = null;
  function abrir() {
    return new Promise((ok, no) => {
      try {
        const r = indexedDB.open(BD, 1);
        r.onupgradeneeded = () => { r.result.createObjectStore(TABLA); };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => no(r.error);
        r.onblocked = () => no(new Error("bloqueada"));
      } catch (e) { no(e); }
    });
  }
  const bd = () => dbp || (dbp = abrir().catch((e) => { dbp = null; throw e; }));
  async function idbPut(k, v) {
    try { const db = await bd(); db.transaction(TABLA, "readwrite").objectStore(TABLA).put(v, k); } catch (_) { }
  }
  async function idbDel(k) {
    try { const db = await bd(); db.transaction(TABLA, "readwrite").objectStore(TABLA).delete(k); } catch (_) { }
  }
  async function idbTodo() {
    const db = await bd();
    return new Promise((ok, no) => {
      const out = {};
      const c = db.transaction(TABLA, "readonly").objectStore(TABLA).openCursor();
      c.onsuccess = () => {
        const cur = c.result;
        if (cur) { out[cur.key] = cur.value; cur.continue(); } else ok(out);
      };
      c.onerror = () => no(c.error);
    });
  }

  /* ---------- Cookies (solo claves pequeñas) ---------- */
  function cookieSet(k, v) {
    if (CLAVES_COOKIE.indexOf(k) < 0) return;
    try {
      document.cookie = k + "=" + encodeURIComponent(v) + "; max-age=31536000; path=/; SameSite=Lax" + (location.protocol === "https:" ? "; Secure" : "");
    } catch (_) { }
  }
  function cookieDel(k) {
    if (CLAVES_COOKIE.indexOf(k) < 0) return;
    try { document.cookie = k + "=; max-age=0; path=/; SameSite=Lax"; } catch (_) { }
  }
  function cookieGet(k) {
    try {
      const m = document.cookie.split("; ").find((x) => x.indexOf(k + "=") === 0);
      return m ? decodeURIComponent(m.slice(k.length + 1)) : null;
    } catch (_) { return null; }
  }

  /* ---------- Espejo automático: cada escritura en localStorage también se respalda ---------- */
  Storage.prototype.setItem = function (k, v) {
    if (esLocal(this) && esMia(k)) {
      const txt = String(v);
      mem.set(k, txt);
      idbPut(k, txt);
      cookieSet(k, txt);
    }
    return sSet.apply(this, arguments);
  };
  Storage.prototype.removeItem = function (k) {
    if (esLocal(this) && esMia(k)) {
      mem.delete(k);
      idbDel(k);
      cookieDel(k);
    }
    return sRem.apply(this, arguments);
  };
  Storage.prototype.getItem = function (k) {
    let v = null;
    try { v = sGet.apply(this, arguments); }
    catch (e) {
      if (esLocal(this) && esMia(k)) return mem.has(k) ? mem.get(k) : null;
      throw e;
    }
    if (v === null && esLocal(this) && esMia(k) && mem.has(k)) return mem.get(k);
    return v;
  };

  /* ---------- Restauración al abrir la app ---------- */
  async function restaurar() {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { }); } catch (_) { }

    let guardado = {};
    try {
      guardado = await Promise.race([
        idbTodo(),
        new Promise((_, no) => setTimeout(() => no(new Error("tiempo")), 2000))
      ]);
    } catch (_) { guardado = {}; }

    const actual = (k) => { try { return sGet.call(LS, k); } catch (_) { return mem.has(k) ? mem.get(k) : null; } };
    const poner = (k, v) => { mem.set(k, v); try { sSet.call(LS, k, v); } catch (_) { } };

    Object.keys(guardado).forEach((k) => {
      if (esMia(k) && typeof guardado[k] === "string" && actual(k) === null) poner(k, guardado[k]);
    });
    CLAVES_COOKIE.forEach((k) => {
      if (actual(k) === null) { const c = cookieGet(k); if (c) poner(k, c); }
    });

    /* Quien ya tenía datos en localStorage antes de esta versión: se respaldan ahora. */
    try {
      if (LS) {
        for (let i = 0; i < LS.length; i++) {
          const k = LS.key(i);
          if (!esMia(k)) continue;
          const v = sGet.call(LS, k);
          if (v === null) continue;
          mem.set(k, v);
          idbPut(k, v);
          cookieSet(k, v);
        }
      }
    } catch (_) { }
  }

  window.Almacen = { restaurar };
})();
