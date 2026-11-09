/* ============================================================
   FACTURACIÓN — integrada en la app del repartidor
   FASE 3 · El desglose visual separa explícitamente:
     - Subtotal (productos)
     - Delivery base
     - ➕ Mandado Extra (si extraErrand > 0)
     - ⚡ Prioridad (si el cliente la aceptó)
     - TOTAL
   ============================================================ */
(function () {
'use strict';
window.Factura = {
    alEnviar: null, nombreRepartidor: '', contactos: [], nuevoCodigo: () => getUniqueCode(), refrescarContactos: () => refrescarContactos(),
    alEnviarPedido: null,
    alTerminarPedido: null,
    prioridadExtra: () => 0,
    prepararPedido: (info) => prepararPedido(info),
    salirModoPedido: (forzar) => salirModoPedido(forzar),
    enModoPedido: () => !!pedidoSistema,
    recalcular: () => calculateTotal(),
    alEnviarChat: null,
    alTerminarChat: null,
    prepararChat: (info) => prepararChat(info),
    salirModoChat: (forzar) => salirModoChat(forzar),
    enModoChat: () => !!chatDestino,
    chatActual: () => (chatDestino ? chatDestino.solicitudId : ''),
    descartarChat: (id) => descartarChat(id),
    diaNegocio: () => getBusinessDayString(),
    nuevoCodigoChat: () => getUniqueCode()
  };

  let products = [];
  let editingIndex = -1;
  let extraErrand = 0;
  let depositPaid = false;
  let pendingDeleteIndex = -1;
  let pedidoSistema = null;
  let chatDestino = null;
  let enviandoPedido = false;
  const facturasContadas = new Set();

  function showCustomAlert(message) {
      document.getElementById('customAlertMessage').textContent = message;
      document.getElementById('customAlertModal').classList.add('show');
  }
  function closeCustomAlert() {
      document.getElementById('customAlertModal').classList.remove('show');
  }
  function showCustomConfirm(index, productName) {
      pendingDeleteIndex = index;
      document.getElementById('customConfirmMessage').textContent = `¿Estás seguro de eliminar el producto "${productName}"?`;
      document.getElementById('customConfirmModal').classList.add('show');
  }
  function closeCustomConfirm(confirmed) {
      document.getElementById('customConfirmModal').classList.remove('show');
      if (confirmed && pendingDeleteIndex >= 0) {
          products.splice(pendingDeleteIndex, 1);
          renderProductList();
          calculateTotal();
      }
      pendingDeleteIndex = -1;
  }
  function showCustomLoading() { document.getElementById('customLoadingModal').classList.add('show'); }
  function hideCustomLoading() { document.getElementById('customLoadingModal').classList.remove('show'); }

  function getBusinessDayString() {
      const now = new Date();
      if (now.getHours() < 8) { now.setDate(now.getDate() - 1); }
      return now.toDateString();
  }
  function checkSessionAndLogin() {
      const currentBusinessDay = getBusinessDayString();
      let storedStats = JSON.parse(localStorage.getItem('brothersDeliveryStats'));
      if (!storedStats || storedStats.businessDay !== currentBusinessDay) {
          dailyStats = { totalOrders: 0, totalEarnings: 0, businessDay: currentBusinessDay };
          localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
      } else { dailyStats = storedStats; }
  }
  let dailyStats = JSON.parse(localStorage.getItem('brothersDeliveryStats')) || { totalOrders: 0, totalEarnings: 0, businessDay: getBusinessDayString() };
  let depositInvoices = JSON.parse(localStorage.getItem('brothersDeliveryDepositInvoices')) || [];

  function crearToken(largo = 14) {
      const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
      const bytes = crypto.getRandomValues(new Uint8Array(largo));
      return Array.from(bytes, (b) => abc[b % abc.length]).join('');
  }
  function abrirEnlaceExterno(url) {
      const C = window.Capacitor, nativo = !!(C && ((C.isNativePlatform && C.isNativePlatform()) || (C.getPlatform && C.getPlatform() !== 'web')));
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (!nativo && ios) { window.location.href = url; return; }
      let w = null;
      try { w = window.open(url, nativo ? '_system' : '_blank'); } catch (_) {}
      if (!w && !nativo) window.location.href = url;
  }
  const CLAVE_BORRADOR = 'brothersDeliveryBorrador';
  function guardarBorrador() {
      try {
          if (chatDestino) return guardarBorradorChat();
          if (pedidoSistema) return;
          const d = { products, extraErrand, cliente: document.getElementById('customerName').value, delivery: document.getElementById('deliveryPrice').value, ivasExtras: ivasExtrasActual(), ts: Date.now() };
          if (!products.length && !d.cliente.trim() && !String(d.delivery).trim()) localStorage.removeItem(CLAVE_BORRADOR);
          else localStorage.setItem(CLAVE_BORRADOR, JSON.stringify(d));
      } catch (_) {}
  }
  const CLAVE_BORRADORES_CHAT = 'brothersDeliveryBorradoresChat';
  const VIDA_BORRADOR_MS = 12 * 3600 * 1000;
  function leerBorradoresChat() {
      try { const o = JSON.parse(localStorage.getItem(CLAVE_BORRADORES_CHAT) || '{}'); return o && typeof o === 'object' ? o : {}; } catch (_) { return {}; }
  }
  function escribirBorradoresChat(o) {
      try { localStorage.setItem(CLAVE_BORRADORES_CHAT, JSON.stringify(o)); } catch (_) {}
  }
  function guardarBorradorChat() {
      if (!chatDestino) return;
      const o = leerBorradoresChat(), id = chatDestino.solicitudId, ahora = Date.now();
      const d = { products, extraErrand, cliente: document.getElementById('customerName').value, delivery: document.getElementById('deliveryPrice').value, ivasExtras: ivasExtrasActual(), deposito: depositPaid, ts: ahora };
      if (!products.length && !String(d.delivery).trim() && !extraErrand && !d.ivasExtras) delete o[id]; else o[id] = d;
      Object.keys(o).forEach((k) => { if (ahora - (Number(o[k] && o[k].ts) || 0) > VIDA_BORRADOR_MS) delete o[k]; });
      escribirBorradoresChat(o);
  }
  function descartarBorradorChat(id) {
      const o = leerBorradoresChat();
      if (o[id]) { delete o[id]; escribirBorradoresChat(o); }
  }
  function descartarChat(id) {
      id = String(id || '');
      if (!id) return;
      descartarBorradorChat(id);
      if (chatDestino && chatDestino.solicitudId === id) salirModoChat(true);
  }
  function restaurarBorrador() {
      try {
          const d = JSON.parse(localStorage.getItem(CLAVE_BORRADOR) || 'null');
          if (!d || Date.now() - (Number(d.ts) || 0) > 12 * 3600 * 1000) return localStorage.removeItem(CLAVE_BORRADOR);
          products = (Array.isArray(d.products) ? d.products : []).filter((p) => p && typeof p.name === 'string' && typeof p.price === 'number' && p.price >= 0)
              .map((p) => ({ name: p.name, price: p.price }));
          extraErrand = d.extraErrand === 10 || d.extraErrand === 20 ? d.extraErrand : 0;
          document.getElementById('customerName').value = String(d.cliente || '');
          document.getElementById('deliveryPrice').value = String(d.delivery || '');
          fijarIvasExtras(d.ivasExtras);
      } catch (_) {}
  }

  function refrescarContactos() {
      const fila = document.getElementById('contactoFila'), sel = document.getElementById('contactoSel');
      if (pedidoSistema || chatDestino) { fila.style.display = 'none'; return; }
      const cs = window.Factura.contactos || [], previo = sel.value;
      fila.style.display = cs.length ? '' : 'none';
      sel.innerHTML = '<option value="">🆕 Pedido nuevo (enlace nuevo)</option>' +
          cs.map((c) => `<option value="${escHtml(c.token)}">🔗 ${escHtml(c.cliente || 'Cliente')} · ${escHtml(c.pedido)}</option>`).join('');
      sel.value = cs.some((c) => c.token === previo) ? previo : (cs.length ? cs[cs.length - 1].token : '');
      alElegirContacto();
  }
  function alElegirContacto() {
      const c = (window.Factura.contactos || []).find((x) => x.token === document.getElementById('contactoSel').value);
      const campo = document.getElementById('customerName');
      if (c && c.cliente && !campo.value.trim()) campo.value = c.cliente;
  }

  function getUniqueCode() {
      let codes = JSON.parse(localStorage.getItem('brothersDeliveryAvailableCodes'));
      let today = getBusinessDayString();
      let lastReset = localStorage.getItem('brothersDeliveryCodeResetDate');
      if (!codes || codes.length === 0 || lastReset !== today) {
          codes = [];
          for (let i = 1; i <= 1500; i++) { codes.push('BD' + i.toString().padStart(4, '0')); }
          localStorage.setItem('brothersDeliveryCodeResetDate', today);
      }
      const randomIndex = Math.floor(Math.random() * codes.length);
      const selectedCode = codes.splice(randomIndex, 1)[0];
      localStorage.setItem('brothersDeliveryAvailableCodes', JSON.stringify(codes));
      return selectedCode;
  }
  function persistDepositInvoices() { localStorage.setItem('brothersDeliveryDepositInvoices', JSON.stringify(depositInvoices)); }
  function formatMoney(n) { return `C$ ${Number(n || 0).toFixed(2)}`; }
  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /* IVAs extras: cada IVA vale C$ 7 y se suma a la deducción fija del cálculo contable del pedido */
  const IVA_VALOR = 7, IVAS_MAX = 20;
  function ivasExtrasActual() {
      const el = document.getElementById('ivasExtras');
      const v = Math.floor(parseFloat(el && el.value));
      return Number.isFinite(v) && v > 0 ? Math.min(v, IVAS_MAX) : 0;
  }
  function pintarIvasExtras() {
      const el = document.getElementById('ivasExtrasMonto');
      if (!el) return;
      const k = ivasExtrasActual();
      el.textContent = k === 0 ? '0 IVAs = C$ 0' : (k === 1 ? '1 IVA = C$ 7' : k + ' IVAs = C$ ' + (k * IVA_VALOR));
  }
  function fijarIvasExtras(k) {
      const el = document.getElementById('ivasExtras');
      if (!el) return;
      const v = Math.floor(Number(k));
      el.value = String(Number.isFinite(v) && v > 0 ? Math.min(v, IVAS_MAX) : 0);
      pintarIvasExtras();
  }
  function cambiarIvasExtras(delta) {
      fijarIvasExtras(ivasExtrasActual() + (Number(delta) || 0));
      calculateTotal();
  }
  function deliveryBase() {
      if (pedidoSistema) return Number(pedidoSistema.delivery) || 0;
      return parseFloat(document.getElementById('deliveryPrice').value) || 0;
  }
  function prioridadActual() {
      if (!pedidoSistema) return 0;
      const f = window.Factura.prioridadExtra;
      return typeof f === 'function' ? (Number(f()) || 0) : 0;
  }
  function renderDepositInvoices() {
      const container = document.getElementById('depositInvoicesList');
      if (!container) return;
      if (!depositInvoices.length) { container.innerHTML = '<div class="small-muted" style="margin-top:10px;">No hay facturas por cobrar.</div>'; return; }
      let html = '';
      depositInvoices.slice().reverse().forEach((inv) => {
          const productsHtml = (inv.products || []).map(p => `<tr><td>${escHtml(p.name)}</td><td style="text-align:right;font-weight:700;color:var(--red);">C$ ${Number(p.price).toFixed(2)}</td></tr>`).join('');
          html += `
              <div class="deposit-invoice">
                  <div class="row"><span><strong>Cliente:</strong> ${escHtml(inv.customerName) || '—'}</span><span><strong>Total:</strong> ${formatMoney(inv.grandTotal)}</span></div>
                  <div class="row"><span><strong>Delivery:</strong> ${formatMoney(inv.totalDelivery)}</span><span><strong>Fecha:</strong> ${inv.createdAt}</span></div>
                  <details>
                      <summary>Ver detalles</summary>
                      <div style="margin-top:8px;">
                          <table class="invoice-products-table">${productsHtml}</table>
                          <div class="small-muted">Subtotal: ${formatMoney(inv.subtotal)} | Mandado extra: ${formatMoney(inv.extraErrand)}</div>
                      </div>
                  </details>
              </div>
          `;
      });
      container.innerHTML = html;
  }
  function clearDepositInvoices() {
      if (confirm('¿Seguro que deseas limpiar la lista de facturas "Por Cobrar"?')) {
          depositInvoices = []; persistDepositInvoices(); renderDepositInvoices(); showCustomAlert('Lista "Por Cobrar" limpiada.');
      }
  }
  function checkAndResetStats() {
      const currentBusinessDay = getBusinessDayString();
      if (dailyStats.businessDay !== currentBusinessDay) {
          dailyStats = { totalOrders: 0, totalEarnings: 0, businessDay: currentBusinessDay };
          localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
          checkSessionAndLogin();
      }
  }
  setInterval(checkAndResetStats, 30000);
  /* "Mis estadísticas" se eliminó de la pantalla: estas funciones quedan como no-op para no romper llamadas antiguas */
  function showStats() {}
  function hideStats() {
      const inv = document.getElementById('invoiceContainer');
      if (inv) inv.style.display = 'block';
  }
  function updateStatsDisplay() {}
  function calculateIVA() {}
  function resetStats() {}
  function toggleExtraErrand(amount) {
      extraErrand = amount;
      const buttons = document.querySelectorAll('.extra-errand-btn');
      buttons.forEach(btn => btn.classList.remove('active'));
      if (amount === 0) buttons[0].classList.add('active');
      else if (amount === 10) buttons[1].classList.add('active');
      else if (amount === 20) buttons[2].classList.add('active');
      calculateTotal();
  }
  function addProductToList() {
      const name = document.getElementById('currentProductName').value.trim();
      const priceRaw = document.getElementById('currentProductPrice').value;
      const price = priceRaw === '' ? NaN : parseFloat(priceRaw);
      if (!name) { showCustomAlert('Por favor, ingresa el nombre del producto.'); return; }
      if (Number.isNaN(price) || price < 0) { showCustomAlert('Por favor, ingresa un precio válido (puede ser 0).'); return; }
      if (editingIndex >= 0) {
          products[editingIndex] = { name, price }; editingIndex = -1;
          document.querySelector('.add-product-btn').textContent = '+';
      } else { products.push({ name, price }); }
      document.getElementById('currentProductName').value = '';
      document.getElementById('currentProductPrice').value = '';
      renderProductList(); calculateTotal();
  }
  function renderProductList() {
      const listContainer = document.getElementById('savedProductsList');
      listContainer.innerHTML = '';
      products.forEach((product, index) => {
          const productItem = document.createElement('div');
          productItem.className = 'product-list-item';
          productItem.innerHTML = `
              <div class="product-info">
                  <span class="name">${escHtml(product.name)}</span>
                  <span class="price">C$ ${product.price.toFixed(2)}</span>
              </div>
              <div class="product-actions">
                  <button type="button" class="edit-btn" onclick="editProduct(${index})" aria-label="Editar">✏️</button>
                  <button type="button" class="delete-btn" onclick="deleteProduct(${index})" aria-label="Eliminar">🗑️</button>
              </div>
          `;
          listContainer.appendChild(productItem);
      });
  }
  function editProduct(index) {
      const product = products[index];
      document.getElementById('currentProductName').value = product.name;
      document.getElementById('currentProductPrice').value = product.price;
      editingIndex = index;
      document.querySelector('.add-product-btn').textContent = '✓';
      document.getElementById('currentProductName').focus();
  }
  function deleteProduct(index) {
      const product = products[index];
      showCustomConfirm(index, product ? product.name : 'este producto');
  }
  function calculateTotal() {
      let subtotal = 0;
      products.forEach(product => { subtotal += product.price; });
      const deliveryPrice = deliveryBase();
      const totalDelivery = deliveryPrice + extraErrand;
      const prioridad = prioridadActual();
      const ivasMonto = ivasExtrasActual() * IVA_VALOR;
      const grandTotal = subtotal + totalDelivery + prioridad + ivasMonto;
      pintarIvasExtras();
      guardarBorrador();
      document.getElementById('subtotal').textContent = `C$ ${subtotal.toFixed(2)}`;
      document.getElementById('deliveryCost').textContent = `C$ ${totalDelivery.toFixed(2)}`;
      document.getElementById('grandTotal').textContent = `C$ ${grandTotal.toFixed(2)}`;
      const filaIva = document.getElementById('fxIvaTotFila');
      if (filaIva) {
          const k = ivasExtrasActual();
          filaIva.style.display = ivasMonto > 0 ? 'flex' : 'none';
          document.getElementById('fxIvaTotTxt').textContent = '🧮 ' + (k === 1 ? '1 IVA extra' : k + ' IVAs extras');
          document.getElementById('fxIvaTotMonto').textContent = '+' + formatMoney(ivasMonto);
      }
      const filaPrio = document.getElementById('fxPrioFila');
      if (filaPrio) {
          filaPrio.style.display = prioridad > 0 ? 'flex' : 'none';
          document.getElementById('fxPrioMonto').textContent = '+' + formatMoney(prioridad);
      }
  }
  function promptGenerateInvoice() {
      if (products.length === 0) { showCustomAlert('Por favor, agrega al menos un producto.'); return; }
      document.getElementById('depositPromptPopup').classList.add('show');
  }
  function confirmDeposit(isPaid) {
      depositPaid = isPaid;
      document.getElementById('depositPromptPopup').classList.remove('show');
      generateInvoice();
  }
  let facturaActual = null;

  function generateInvoice() {
      const customerName = document.getElementById('customerName').value.trim();
      const enPedido = !!pedidoSistema;
      const enChat = !enPedido && !!chatDestino;
      const contacto = (enPedido || enChat) ? null : (window.Factura.contactos || []).find((x) => x.token === document.getElementById('contactoSel').value);
      const pickupCode = enPedido ? pedidoSistema.codigo : (contacto ? contacto.pedido : getUniqueCode());
      const token = enPedido ? pedidoSistema.id : (contacto ? contacto.token : crearToken());
      const link = `${URL_RASTREO}?id=${token}`;
      const sinEnlace = !!contacto || enChat;

      let invoiceHTML = '<div class="invoice-header-popup">🏍️ BROTHERS DELIVERY</div>';
      invoiceHTML += '<div class="invoice-divider"></div>';
      if (customerName) invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">👤 CLIENTE: ${escHtml(customerName)}</div>`;
      invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">💳 DEPÓSITO: ${depositPaid ? 'SÍ' : 'NO'}</div>`;
      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">📦 PRODUCTOS</div>';
      invoiceHTML += '<table class="invoice-products-table">';

      const SEP = '━━━━━━━━━━';
      let invoiceText = '🏍️ *BROTHERS DELIVERY*\n';
      if (customerName) invoiceText += `Cliente: ${customerName}\n`;
      if (window.Factura && window.Factura.nombreRepartidor) invoiceText += `Repartidor: ${window.Factura.nombreRepartidor}\n`;
      if (depositPaid) invoiceText += 'Depósito: SÍ\n';
      invoiceText += '\n*Productos*\n';
      products.forEach(product => {
          invoiceHTML += `<tr><td>${escHtml(product.name)}</td><td>C$ ${product.price.toFixed(2)}</td></tr>`;
          invoiceText += `• ${product.name} – C$ ${product.price.toFixed(2)}\n`;
      });
      invoiceHTML += '</table>';

      const subtotal = r2(products.reduce((t, p) => t + p.price, 0));
      const deliveryPrice = deliveryBase();
      const totalDelivery = r2(deliveryPrice + extraErrand);
      const prioridad = prioridadActual();
      const ivasK = ivasExtrasActual(), ivasMonto = r2(ivasK * IVA_VALOR);
      const totalBase = r2(subtotal + totalDelivery + ivasMonto);
      const grandTotal = r2(totalBase + prioridad);

      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<table class="invoice-totals-table">';
      invoiceHTML += `<tr><td>Subtotal:</td><td>C$ ${subtotal.toFixed(2)}</td></tr>`;
      invoiceHTML += `<tr><td>Delivery base:</td><td>C$ ${deliveryPrice.toFixed(2)}</td></tr>`;
      if (extraErrand > 0) { invoiceHTML += `<tr><td>➕ Mandado Extra:</td><td>C$ ${extraErrand.toFixed(2)}</td></tr>`; }
      if (ivasMonto > 0) { invoiceHTML += `<tr><td>🧮 ${ivasK === 1 ? '1 IVA extra' : ivasK + ' IVAs extras'}:</td><td>C$ ${ivasMonto.toFixed(2)}</td></tr>`; }
      if (prioridad > 0) { invoiceHTML += `<tr><td>⚡ Prioridad:</td><td>C$ ${prioridad.toFixed(2)}</td></tr>`; }
      invoiceHTML += `<tr class="total-row"><td>TOTAL:</td><td>C$ ${grandTotal.toFixed(2)}</td></tr>`;
      invoiceHTML += '</table>';
      invoiceHTML += `<div style="text-align:center; font-weight:700; color:var(--red); margin-top:10px; font-size:1em;">CÓDIGO DE RETIRO: ${pickupCode}</div>`;
      if (enChat) { /* sin bloque de seguimiento */ }
      else if (sinEnlace) invoiceHTML += `<div class="invoice-track"><b>📍 Seguimiento en tiempo real</b>Usa el mismo enlace de seguimiento que ya te enviamos.</div>`;
      else invoiceHTML += `<div class="invoice-track"><b>📍 Seguimiento en tiempo real</b>Toca el enlace y verás la ubicación de tu paquete en tiempo real.<div class="lnk">${escHtml(link)}</div></div>`;
      invoiceHTML += '<div class="invoice-footer">¡Vuelve a pedir con nosotros cuando quieras! 🚀 Siempre listos para ayudarte 🙌</div>';

      invoiceText += `\n${SEP}\n`;
      invoiceText += `Productos: C$ ${subtotal.toFixed(2)}\n`;
      invoiceText += `Delivery base: C$ ${deliveryPrice.toFixed(2)}\n`;
      if (extraErrand > 0) invoiceText += `➕ Mandado Extra: C$ ${extraErrand.toFixed(2)}\n`;
      if (ivasMonto > 0) invoiceText += `🧮 ${ivasK === 1 ? '1 IVA extra' : ivasK + ' IVAs extras'}: C$ ${ivasMonto.toFixed(2)}\n`;
      if (prioridad > 0) invoiceText += `⚡ Prioridad: C$ ${prioridad.toFixed(2)}\n`;
      invoiceText += `*TOTAL: C$ ${grandTotal.toFixed(2)}*\n`;
      invoiceText += `*CÓDIGO DE RETIRO: ${pickupCode}*\n`;
      invoiceText += `${SEP}\n\n`;
      if (enChat) { invoiceText += '¡Gracias por pedir con nosotros! 🙌'; }
      else if (sinEnlace) { invoiceText += '📍 *Importante:* siga compartiendo su ubicación en tiempo real en el mismo enlace de seguimiento que ya le enviamos, para que su repartidor lo encuentre y su pedido llegue más rápido.'; }
      else {
          invoiceText += '📍 *Importante:* abra el enlace y comparta su ubicación en tiempo real para que su repartidor lo encuentre y su pedido llegue más rápido.\n';
          invoiceText += `👉 ${link}`;
      }

      document.getElementById('generatedInvoiceDisplay').innerHTML = invoiceHTML;

      facturaActual = {
          token, pedido: pickupCode, cliente: customerName, tel: '', texto: invoiceText, total: totalBase, totalFinal: grandTotal, delivery: totalDelivery, link,
          productos: products.map((p) => ({ nombre: String(p.name), precio: Number(p.price) || 0 })),
          subtotal: subtotal, deliveryBase: deliveryPrice, mandadoExtra: extraErrand,
          prioridad, ivasExtras: ivasK, ivaExtraMonto: ivasMonto, deposito: depositPaid, deSistema: enPedido, deChat: enChat, chatId: enChat ? chatDestino.solicitudId : '', enlaceYaEnviado: sinEnlace, enviada: false
      };

      const yaContada = enPedido && facturasContadas.has(token);
      if (!yaContada) {
          if (enPedido) facturasContadas.add(token);
          dailyStats.totalOrders += 1;
          dailyStats.totalEarnings += totalDelivery;
          localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
          if (depositPaid) {
              const now = new Date();
              const createdAt = now.toLocaleString('es-ES');
              depositInvoices.push({
                  id: `${now.getTime()}_${Math.random().toString(16).slice(2)}`,
                  createdAt, customerName, depositPaid: true,
                  products: products.map(p => ({ name: p.name, price: p.price })),
                  subtotal, deliveryPrice, extraErrand, totalDelivery, grandTotal
              });
              persistDepositInvoices();
          }
      }

      document.getElementById('invoicePopup').classList.add('show');
      pintarPopupPedido(enPedido || enChat);
      if (enPedido || enChat) enviarAPedido();
  }

  const NEGOCIO_WA = '50586265619';
  function enviarFacturaWhatsApp() {
      if (!facturaActual) return;
      const f = facturaActual; facturaActual = null;
      const url = `https://wa.me/${NEGOCIO_WA}?text=${encodeURIComponent(f.texto)}`;
      if (window.Factura && typeof window.Factura.alEnviar === 'function') window.Factura.alEnviar(f);
      abrirEnlaceExterno(url);
      document.getElementById('invoicePopup').classList.remove('show');
      resetForm();
  }
  function downloadInvoiceImage() {
      showCustomLoading();
      const element = document.getElementById('generatedInvoiceDisplay');
      setTimeout(() => {
          html2canvas(element, { scale: 2 }).then(canvas => {
              hideCustomLoading();
              const link = document.createElement('a');
              const now = new Date();
              const dateStr = now.toISOString().slice(0, 10);
              const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
              link.download = `factura_${dateStr}_${timeStr}.png`;
              link.href = canvas.toDataURL('image/png');
              link.click();
              showCustomAlert('¡Imagen de la factura descargada con éxito!');
          }).catch(() => { hideCustomLoading(); showCustomAlert('Ocurrió un error al guardar la imagen.'); });
      }, 600);
  }
  function prepararPedido(info) {
      if (!info || !info.id) return;
      chatDestino = null;
      const mismo = !!pedidoSistema && pedidoSistema.id === String(info.id);
      pedidoSistema = { id: String(info.id), codigo: String(info.codigo || ''), cliente: String(info.cliente || ''), delivery: r2(info.delivery) };
      if (!mismo) {
          products = []; editingIndex = -1; extraErrand = 0; depositPaid = false; facturaActual = null;
          document.getElementById('currentProductName').value = '';
          document.getElementById('currentProductPrice').value = '';
          document.getElementById('customerName').value = pedidoSistema.cliente;
          document.querySelector('.add-product-btn').textContent = '+';
          renderProductList(); toggleExtraErrand(0);
      }
      hideStats(); pintarModoPedido();
  }
  function pintarModoPedido() {
      const on = !!pedidoSistema, enChat = !on && !!chatDestino, g = (id) => document.getElementById(id);
      g('pedidoBanner').style.display = (on || enChat) ? '' : 'none';
      g('deliveryManual').style.display = on ? 'none' : '';
      g('deliverySistema').style.display = on ? '' : 'none';
      g('btnContactoCliente').style.display = (on || enChat) ? 'none' : '';
      if (enChat) {
          g('pedidoBannerCod').textContent = 'del chat';
          g('pedidoBannerTxt').textContent = 'Se envía a la conversación de ' + (chatDestino.cliente || 'tu cliente');
          g('contactoFila').style.display = 'none';
      } else if (on) {
          g('pedidoBannerCod').textContent = pedidoSistema.codigo;
          g('pedidoBannerTxt').textContent = 'Se envía directo a la app del cliente' + (pedidoSistema.cliente ? ' · ' + pedidoSistema.cliente : '');
          g('deliverySistemaMonto').textContent = formatMoney(pedidoSistema.delivery);
          g('contactoFila').style.display = 'none';
      } else refrescarContactos();
      calculateTotal();
  }
  function salirModoPedido(forzar) {
      if (!pedidoSistema && chatDestino) return salirModoChat(forzar);
      if (!pedidoSistema) return;
      if (!forzar && products.length && !confirm('¿Salir de la factura de este pedido? Se descartan los productos agregados.')) return;
      pedidoSistema = null; facturaActual = null; enviandoPedido = false;
      document.getElementById('invoicePopup').classList.remove('show');
      resetForm(); pintarModoPedido();
  }
  function prepararChat(info) {
      if (!info || !info.solicitudId) return;
      const mismo = !!chatDestino && chatDestino.solicitudId === String(info.solicitudId);
      if (chatDestino && !mismo) guardarBorradorChat();
      pedidoSistema = null;
      const id = String(info.solicitudId);
      let previo = leerBorradoresChat()[id];
      if (previo && Date.now() - (Number(previo.ts) || 0) > VIDA_BORRADOR_MS) previo = null;
      chatDestino = { solicitudId: id, cliente: String(info.cliente || '') };
      if (!mismo) {
          products = []; editingIndex = -1; extraErrand = 0; depositPaid = false; facturaActual = null;
          document.getElementById('currentProductName').value = '';
          document.getElementById('currentProductPrice').value = '';
          document.getElementById('deliveryPrice').value = '';
          fijarIvasExtras(0);
          document.getElementById('customerName').value = chatDestino.cliente;
          document.querySelector('.add-product-btn').textContent = '+';
          if (previo) {
              products = (Array.isArray(previo.products) ? previo.products : []).filter((p) => p && typeof p.name === 'string' && typeof p.price === 'number' && p.price >= 0)
                  .map((p) => ({ name: p.name, price: p.price }));
              depositPaid = !!previo.deposito;
              document.getElementById('deliveryPrice').value = String(previo.delivery || '');
              fijarIvasExtras(previo.ivasExtras);
              if (previo.cliente) document.getElementById('customerName').value = String(previo.cliente);
          }
          renderProductList();
          toggleExtraErrand(previo && (previo.extraErrand === 10 || previo.extraErrand === 20) ? previo.extraErrand : 0);
      }
      hideStats(); pintarModoPedido();
  }
  function salirModoChat(forzar) {
      if (!chatDestino) return;
      if (!forzar && products.length && !confirm('¿Salir de la factura de este chat? Se descartan los productos agregados.')) return;
      if (!forzar) descartarBorradorChat(chatDestino.solicitudId);
      chatDestino = null; facturaActual = null; enviandoPedido = false;
      document.getElementById('invoicePopup').classList.remove('show');
      resetForm(); pintarModoPedido();
  }
  function pintarPopupPedido(on) {
      document.getElementById('whatsappShareBtn').style.display = on ? 'none' : '';
      document.getElementById('fxTrackNote').style.display = on ? 'none' : '';
      document.getElementById('fxEnvioApp').style.display = on ? 'flex' : 'none';
  }
  function estadoEnvio(tipo, dato) {
      const g = (id) => document.getElementById(id);
      g('fxEnvioApp').className = 'fx-envio-app' + (tipo === 'ok' ? ' ok' : tipo === 'error' ? ' error' : '');
      g('fxEnvioReintentar').style.display = tipo === 'error' ? '' : 'none';
      if (tipo === 'enviando') {
          g('fxEnvioIcono').textContent = '⏳';
          g('fxEnvioTitulo').textContent = 'Enviando a la app del cliente…';
          g('fxEnvioTxt').textContent = '';
      } else if (tipo === 'ok') {
          g('fxEnvioIcono').textContent = '✅';
          g('fxEnvioTitulo').textContent = 'Factura enviada a la app del cliente';
          g('fxEnvioTxt').textContent = dato && dato.deChat
              ? `Ya aparece como tarjeta en el chat. Total a cobrar: ${formatMoney(dato.totalFinal)}.`
              : dato && dato.prioridad > 0
              ? `Ya la ve en su rastreo, con ⚡ prioridad +${formatMoney(dato.prioridad)}. Total a cobrar: ${formatMoney(dato.totalFinal)}.`
              : 'Ya la ve en su pantalla de rastreo, en tiempo real.';
      } else {
          g('fxEnvioIcono').textContent = '⚠️';
          g('fxEnvioTitulo').textContent = 'No se pudo enviar la factura';
          g('fxEnvioTxt').textContent = (dato && dato.message) || 'Revisa tu conexión e inténtalo de nuevo.';
      }
  }
  async function enviarAPedido() {
      const f = facturaActual;
      if (!f || !(f.deSistema || f.deChat) || f.enviada || enviandoPedido) return;
      enviandoPedido = true;
      estadoEnvio('enviando');
      try {
          const hook = f.deChat ? window.Factura.alEnviarChat : window.Factura.alEnviarPedido;
          if (typeof hook !== 'function') throw new Error(f.deChat ? 'El módulo de chats aún no está listo.' : 'El módulo de pedidos aún no está listo.');
          await hook(f); f.enviada = true; estadoEnvio('ok', f);
      } catch (e) { estadoEnvio('error', e); } finally { enviandoPedido = false; }
  }
  function reintentarEnvioPedido() { enviarAPedido(); }
  function closePopup() {
      const f = facturaActual;
      document.getElementById('invoicePopup').classList.remove('show');
      if (f && f.deChat) {
          if (!f.enviada) return;
          descartarBorradorChat(f.chatId); facturaActual = null; chatDestino = null;
          resetForm(); pintarModoPedido();
          if (typeof window.Factura.alTerminarChat === 'function') window.Factura.alTerminarChat(f);
          return;
      }
      if (f && f.deSistema) {
          if (!f.enviada) return;
          facturaActual = null; pedidoSistema = null; resetForm(); pintarModoPedido();
          if (typeof window.Factura.alTerminarPedido === 'function') window.Factura.alTerminarPedido(f);
          return;
      }
      facturaActual = null; resetForm();
  }
  function resetForm() {
      products = []; editingIndex = -1; extraErrand = 0;
      document.getElementById('deliveryPrice').value = '';
      fijarIvasExtras(0);
      document.getElementById('currentProductName').value = '';
      document.getElementById('currentProductPrice').value = '';
      document.getElementById('customerName').value = '';
      depositPaid = false; refrescarContactos();
      const buttons = document.querySelectorAll('.extra-errand-btn');
      buttons.forEach(btn => btn.classList.remove('active'));
      renderProductList(); calculateTotal();
  }
  document.getElementById('invoicePopup').addEventListener('click', function(e) { if (e.target === this) closePopup(); });
  document.getElementById('depositPromptPopup').addEventListener('click', function(e) { if (e.target === this) this.classList.remove('show'); });

  /* FASE 1 · Teclado móvil: auto-scroll del campo activo + altura según visualViewport */
  function iniciarTecladoFactura() {
      const vista = document.getElementById('vistaFactura');
      if (!vista) return;
      const vv = window.visualViewport;
      const esCampo = (el) => !!el && el.nodeType === 1 && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) && vista.contains(el) && el.type !== 'hidden';
      let alturaBase = vv ? vv.height : window.innerHeight;
      let temporizador = 0;

      function centrarActivo() {
          const el = document.activeElement;
          if (!esCampo(el)) return;
          try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); }
          catch (_) { el.scrollIntoView(); }
      }
      function programarCentrado(ms) {
          clearTimeout(temporizador);
          temporizador = setTimeout(centrarActivo, ms);
      }
      function sincronizarViewport() {
          const alto = vv ? vv.height : window.innerHeight;
          const activo = esCampo(document.activeElement);
          if (!activo) alturaBase = Math.max(alto, alturaBase);
          const abierto = activo && alto < alturaBase - 120;
          const r = document.documentElement.style;
          r.setProperty('--vvh', Math.round(alto) + 'px');
          document.body.classList.toggle('fx-teclado', abierto);
          if (abierto) programarCentrado(120);
      }

      vista.addEventListener('focusin', (e) => {
          if (!esCampo(e.target)) return;
          sincronizarViewport();
          programarCentrado(320);
      });
      vista.addEventListener('focusout', () => {
          setTimeout(() => { if (!esCampo(document.activeElement)) { document.body.classList.remove('fx-teclado'); sincronizarViewport(); } }, 80);
      });
      if (vv) {
          vv.addEventListener('resize', sincronizarViewport);
          vv.addEventListener('scroll', () => { if (esCampo(document.activeElement)) programarCentrado(150); });
      }
      window.addEventListener('orientationchange', () => { alturaBase = 0; setTimeout(() => { alturaBase = vv ? vv.height : window.innerHeight; sincronizarViewport(); }, 400); });

      const nombre = document.getElementById('currentProductName'), precio = document.getElementById('currentProductPrice');
      const enter = (e, fn) => { if (e.key === 'Enter') { e.preventDefault(); fn(); } };
      if (nombre && precio) nombre.addEventListener('keydown', (e) => enter(e, () => precio.focus()));
      if (precio) precio.addEventListener('keydown', (e) => enter(e, () => { addProductToList(); if (nombre) nombre.focus(); }));
      const cliente = document.getElementById('customerName'), delivery = document.getElementById('deliveryPrice');
      if (cliente && delivery) cliente.addEventListener('keydown', (e) => enter(e, () => { if (delivery.offsetParent !== null) delivery.focus(); else if (nombre) nombre.focus(); }));
      if (delivery && nombre) delivery.addEventListener('keydown', (e) => enter(e, () => nombre.focus()));
  }
  iniciarTecladoFactura();

  restaurarBorrador(); renderProductList();
  document.getElementById('customerName').addEventListener('input', guardarBorrador);
  toggleExtraErrand(extraErrand); calculateTotal();
  checkAndResetStats(); checkSessionAndLogin(); renderDepositInvoices();

  Object.assign(window, { abrirEnlaceExterno, showCustomAlert, closeCustomAlert, closeCustomConfirm, confirmDeposit, showStats, hideStats, calculateTotal, toggleExtraErrand, cambiarIvasExtras, pintarIvasExtras, addProductToList, editProduct, deleteProduct, clearDepositInvoices, resetStats, calculateIVA, promptGenerateInvoice, downloadInvoiceImage, closePopup, enviarFacturaWhatsApp, alElegirContacto, reintentarEnvioPedido });
})();
