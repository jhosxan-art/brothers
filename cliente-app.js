/* ============================================================
   Cliente · chat estilo WhatsApp
   Usa APP (firebase-config.js). Rutas según las reglas actuales:
   - solicitudes_entrantes/{id}  → la solicitud (id = push key guardado en localStorage)
   - chats/{id}/{msgId}          → mensajes (de: cliente | repartidor | sistema)
   Mensaje de factura (lo escribe el repartidor):
   { de:'repartidor', tipo:'factura', ts, texto?, factura:{ total, ts, numero?, items?, subtotal?, envio?, prioridad?, direccion?, metodoPago? } }
   ============================================================ */
(() => {
  'use strict';

  const db = APP.database();
  const auth = APP.auth();
  const TS = firebase.database.ServerValue.TIMESTAMP;
  const LS_ID = 'bd_cliente_solicitud';
  const LS_NOMBRE = 'bd_cliente_nombre';

  const $ = (id) => document.getElementById(id);
  const el = {
    avatar: $('avatar'), titulo: $('titulo'), sub: $('sub'), btnFin: $('btnFin'),
    chat: $('chat'), hint: $('hint'), lista: $('lista'), fab: $('fab'), cerrado: $('cerrado'),
    entrada: $('entrada'), enviar: $('enviar'), toast: $('toast'), dlg: $('dlg'), nombre: $('nombre')
  };

  let sid = null, solRef = null, chatRef = null, sol = null, estado = null;
  let conectado = true, lastDia = '', lastDe = null, asigPrev, toastT;
  const rendered = new Set();
  const pend = new Set();

  /* ---------- utilidades ---------- */
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sin almacenamiento */ } };
  const lsDel = (k) => { try { localStorage.removeItem(k); } catch (e) { /* sin almacenamiento */ } };
  const h = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  };
  const money = (n) => '$' + Number(n || 0).toLocaleString('es', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const hora = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
  const fechaCorta = (ts) => new Date(ts).toLocaleDateString('es', { day: 'numeric', month: 'short' }) + ' ' + hora(ts);
  const dia = (ts) => {
    const d = new Date(ts), hoy = new Date();
    const n = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const dif = Math.round((n(hoy) - n(d)) / 864e5);
    if (dif === 0) return 'Hoy';
    if (dif === 1) return 'Ayer';
    return d.toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' });
  };
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.hidden = false;
    clearTimeout(toastT);
    toastT = setTimeout(() => { el.toast.hidden = true; }, 3500);
  }
  function ajustar() {
    el.entrada.style.height = 'auto';
    el.entrada.style.height = Math.min(el.entrada.scrollHeight, 120) + 'px';
  }

  /* ---------- estado visual ---------- */
  function vista() {
    const cerrada = estado === 'cerrada';
    const a = sol && sol.asignacion;
    const titulo = a && a.nombre ? a.nombre : 'Brother’s Deliverys';
    let sub = !sid ? 'Pide tu delivery'
      : cerrada ? 'Chat cerrado'
      : a ? 'Repartidor asignado'
      : 'Esperando repartidor · tus mensajes quedan guardados';
    if (sid && !cerrada && !conectado) sub = 'Sin conexión · se enviará al reconectar';
    el.titulo.textContent = titulo;
    el.sub.textContent = sub;
    el.avatar.textContent = titulo.charAt(0).toUpperCase();
    el.fab.hidden = !!sid && !cerrada;
    el.cerrado.hidden = !cerrada;
    el.btnFin.hidden = !sid || cerrada;
    el.entrada.disabled = cerrada;
    el.enviar.disabled = cerrada;
    el.hint.textContent = sid
      ? 'Escribe lo que necesitas. Un repartidor te responderá en este chat.'
      : 'Toca “Nuevo pedido” o escribe un mensaje para empezar.';
    el.hint.hidden = el.lista.childElementCount > 0;
  }

  /* ---------- render de mensajes ---------- */
  function facturaCard(f) {
    const card = h('div', 'factura');
    const num = f.numero || f.id;
    const cab = h('div', 'f-cab');
    cab.append(h('strong', null, 'Factura' + (num ? ' #' + num : '')));
    if (f.ts) cab.append(h('span', 'f-fecha', fechaCorta(f.ts)));
    card.append(cab);

    const items = Array.isArray(f.items) ? f.items : (f.items && typeof f.items === 'object' ? Object.values(f.items) : []);
    if (items.length) {
      const ul = h('ul', 'f-items');
      items.forEach((it) => {
        const cant = Number(it.cantidad || it.cant || 1);
        const monto = it.total != null ? Number(it.total) : (it.precio != null ? Number(it.precio) * cant : null);
        const li = h('li');
        li.append(h('span', null, (cant > 1 ? cant + ' × ' : '') + (it.nombre || it.descripcion || it.producto || 'Artículo')));
        if (monto != null && !isNaN(monto)) li.append(h('span', 'f-monto', money(monto)));
        ul.append(li);
      });
      card.append(ul);
    }
    [['Subtotal', f.subtotal], ['Envío', f.envio], ['Prioridad', f.prioridad]].forEach(([k, v]) => {
      if (typeof v !== 'number') return;
      const r = h('div', 'f-fila');
      r.append(h('span', null, k), h('span', 'f-monto', money(v)));
      card.append(r);
    });
    const tot = h('div', 'f-total');
    tot.append(h('span', null, 'Total'), h('strong', null, money(f.total)));
    card.append(tot);
    if (f.direccion) card.append(h('p', 'f-nota', f.direccion));
    if (f.metodoPago) card.append(h('p', 'f-nota', 'Pago: ' + f.metodoPago));
    return card;
  }

  function addMsg(key, m) {
    if (rendered.has(key) || !m) return;
    rendered.add(key);
    const ts = m.ts || Date.now();
    const cercaDelFinal = el.chat.scrollHeight - el.chat.scrollTop - el.chat.clientHeight < 140;
    const d = dia(ts);
    if (d !== lastDia) { lastDia = d; el.lista.append(h('div', 'dia', d)); lastDe = null; }

    const sis = m.de === 'sistema' || m.tipo === 'sistema';
    const propio = m.de === 'cliente';
    const esFactura = m.tipo === 'factura' && m.factura && typeof m.factura === 'object';
    const w = h('div', 'msg ' + (sis ? 'sistema' : propio ? 'out' : 'in') + (esFactura ? ' factura-msg' : ''));
    w.dataset.k = key;
    if (!sis && m.de !== lastDe) w.classList.add('cola');
    lastDe = sis ? null : m.de;

    if (sis) {
      w.textContent = m.texto || '';
    } else {
      if (esFactura) {
        if (m.texto) w.append(h('div', 'txt', m.texto));
        w.append(facturaCard(m.factura));
      } else {
        w.append(h('div', 'txt', m.texto || ''));
      }
      const meta = h('div', 'meta');
      meta.append(h('span', null, hora(ts)));
      if (propio) meta.append(h('span', 'tick', pend.has(key) ? '🕓' : '✓'));
      w.append(meta);
    }
    el.lista.append(w);
    el.hint.hidden = true;
    if (propio || cercaDelFinal) el.chat.scrollTop = el.chat.scrollHeight;
  }

  function marcarEnviado(key) {
    const t = el.lista.querySelector('[data-k="' + key + '"] .tick');
    if (t) t.textContent = '✓';
  }

  /* ---------- conexión con Firebase ---------- */
  function detach() {
    if (solRef) solRef.off();
    if (chatRef) chatRef.off();
    solRef = chatRef = sol = estado = sid = null;
    asigPrev = undefined; lastDia = ''; lastDe = null;
    rendered.clear(); pend.clear();
    el.lista.textContent = '';
  }

  function listenChat() {
    chatRef.on('child_added', (s) => addMsg(s.key, s.val()), () => toast('No se pudo leer el chat.'));
    chatRef.on('child_removed', (s) => {
      const n = el.lista.querySelector('[data-k="' + s.key + '"]');
      if (n) n.remove();
      rendered.delete(s.key);
      pend.delete(s.key);
    });
  }

  function listenSol() {
    if (!solRef) return;
    solRef.on('value', (s) => {
      const v = s.val();
      if (!v) { if (sid) { lsDel(LS_ID); detach(); vista(); } return; }
      sol = v;
      estado = v.estado;
      const a = v.asignacion && v.asignacion.uid ? v.asignacion.uid : null;
      if (asigPrev !== undefined && a && a !== asigPrev) addMsg('local-asig-' + a, { de: 'sistema', texto: v.asignacion.nombre + ' es tu repartidor', ts: Date.now() });
      asigPrev = a;
      vista();
    }, () => toast('No se pudo leer tu pedido.'));
  }

  function crear(nombre) {
    const id = db.ref('solicitudes_entrantes').push().key;
    detach();
    sid = id;
    solRef = db.ref('solicitudes_entrantes/' + id);
    chatRef = db.ref('chats/' + id);
    lsSet(LS_ID, id);
    lsSet(LS_NOMBRE, nombre);
    listenChat();
    vista();
    // El listener de la solicitud se activa cuando el servidor confirma su creación (las reglas exigen que exista).
    solRef.set({
      estado: 'pendiente', creado: TS, actualizado: TS, clienteUid: auth.currentUser.uid,
      cliente: { nombre: nombre }, sinLeerRep: 0
    }).then(() => { if (sid === id) listenSol(); })
      .catch(() => {
        if (sid !== id) return;
        toast('No se pudo crear el pedido. Intenta de nuevo.');
        lsDel(LS_ID); detach(); vista();
      });
  }

  async function abrir(id) {
    try {
      const s = await db.ref('solicitudes_entrantes/' + id).once('value');
      if (!s.exists()) throw new Error('no existe');
    } catch (e) { lsDel(LS_ID); vista(); return; }
    if (sid) return;
    sid = id;
    solRef = db.ref('solicitudes_entrantes/' + id);
    chatRef = db.ref('chats/' + id);
    listenChat();
    listenSol();
    vista();
  }

  /* ---------- acciones ---------- */
  function enviar() {
    const texto = el.entrada.value.trim();
    if (!texto || estado === 'cerrada') return;
    if (!auth.currentUser) { toast('Aún no hay sesión. Revisa tu conexión.'); return; }
    if (!sid) crear(lsGet(LS_NOMBRE) || 'Cliente');
    el.entrada.value = '';
    ajustar();
    const ref = chatRef.push();
    pend.add(ref.key);
    ref.set({ de: 'cliente', texto: texto, ts: TS })
      .then(() => { pend.delete(ref.key); marcarEnviado(ref.key); })
      .catch(() => toast('No se pudo enviar el mensaje.'));
    solRef.update({ ultimo: { texto: texto.slice(0, 200), de: 'cliente', ts: TS }, actualizado: TS }).catch(() => {});
    solRef.child('sinLeerRep').transaction((n) => (n || 0) + 1);
  }

  function finalizar() {
    if (!solRef || !confirm('¿Finalizar este chat? Para volver a escribir tendrás que crear un pedido nuevo.')) return;
    solRef.update({ estado: 'cerrada', cerradoPor: 'cliente', actualizado: TS })
      .catch(() => toast('No se pudo finalizar el chat.'));
  }

  function bindUI() {
    el.enviar.addEventListener('click', enviar);
    el.entrada.addEventListener('input', ajustar);
    el.entrada.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover) and (pointer: fine)').matches) {
        e.preventDefault();
        enviar();
      }
    });
    el.btnFin.addEventListener('click', finalizar);
    el.fab.addEventListener('click', () => {
      el.nombre.value = lsGet(LS_NOMBRE) || '';
      el.dlg.showModal();
    });
    el.dlg.addEventListener('close', () => {
      if (el.dlg.returnValue !== 'ok') return;
      const n = el.nombre.value.trim();
      if (n.length < 2) return;
      crear(n);
      el.entrada.focus();
    });
    db.ref('.info/connected').on('value', (s) => { conectado = s.val() === true; vista(); });
  }

  async function init() {
    bindUI();
    vista();
    try {
      let user = await new Promise((res) => { const off = auth.onAuthStateChanged((u) => { off(); res(u); }); });
      if (!user) user = (await auth.signInAnonymously()).user;
    } catch (e) {
      toast('No se pudo iniciar sesión. Activa el acceso anónimo en Firebase Authentication.');
      return;
    }
    const guardado = lsGet(LS_ID);
    if (guardado) abrir(guardado);
  }

  init();
})();
