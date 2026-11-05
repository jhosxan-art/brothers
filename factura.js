/* ============================================================
   FACTURACIÓN — integrada en la app del repartidor
   Basada en el sistema del ZIP (productos, delivery, mandado extra, depósito, estadísticas).
   Cambios: sin PIN (ya hay login), campo de WhatsApp del cliente, enlace de seguimiento dentro
   de la factura y gancho Factura.alEnviar(...) que usa repartidor.js para activar el seguimiento.
   Va dentro de una función para no chocar con los nombres de repartidor.js.
   FASE 2: modo "pedido asignado" (Factura.prepararPedido): el delivery lo fija el sistema, suma la prioridad
   de C$ 10 si el cliente la aceptó y la factura se guarda en Firebase sin pasar por WhatsApp.
   ============================================================ */
(function () {
'use strict';
window.Factura = {
    alEnviar: null, nombreRepartidor: '', contactos: [], nuevoCodigo: () => getUniqueCode(), refrescarContactos: () => refrescarContactos(),
    /* Pedidos asignados por el administrador: los conecta repartidor.js */
    alEnviarPedido: null,           // async (factura) → guarda la factura en Firebase para el cliente
    alTerminarPedido: null,         // (factura) → se llama al cerrar la ventana de una factura ya enviada
    prioridadExtra: () => 0,        // C$ de prioridad que aceptó el cliente (10 o 0)
    prepararPedido: (info) => prepararPedido(info),
    salirModoPedido: (forzar) => salirModoPedido(forzar),
    enModoPedido: () => !!pedidoSistema,
    recalcular: () => calculateTotal()
  };

  let products = [];
  let editingIndex = -1;
  let extraErrand = 0;
  let depositPaid = false;
  let pendingDeleteIndex = -1;
  let pedidoSistema = null;            // {id, codigo, cliente, delivery}: factura de un pedido aceptado (delivery fijado por el sistema)
  let enviandoPedido = false;          // candado anti doble envío
  const facturasContadas = new Set();  // cada pedido cuenta una sola vez en las estadísticas aunque se reintente el envío

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

  function showCustomLoading() {
      document.getElementById('customLoadingModal').classList.add('show');
  }

  function hideCustomLoading() {
      document.getElementById('customLoadingModal').classList.remove('show');
  }

  function getBusinessDayString() {
      const now = new Date();
      if (now.getHours() < 8) {
          now.setDate(now.getDate() - 1);
      }
      return now.toDateString();
  }

  /* Estadísticas del día. Ya no hay PIN: el repartidor entra con su cuenta. */
  function checkSessionAndLogin() {
      const currentBusinessDay = getBusinessDayString();

      let storedStats = JSON.parse(localStorage.getItem('brothersDeliveryStats'));
      if (!storedStats || storedStats.businessDay !== currentBusinessDay) {
          dailyStats = { totalOrders: 0, totalEarnings: 0, businessDay: currentBusinessDay };
          localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
      } else {
          dailyStats = storedStats;
      }

  }

  let dailyStats = JSON.parse(localStorage.getItem('brothersDeliveryStats')) || {
      totalOrders: 0,
      totalEarnings: 0,
      businessDay: getBusinessDayString()
  };

  let depositInvoices = JSON.parse(localStorage.getItem('brothersDeliveryDepositInvoices')) || [];

  function crearToken(largo = 14) {
      const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
      const bytes = crypto.getRandomValues(new Uint8Array(largo));
      return Array.from(bytes, (b) => abc[b % abc.length]).join('');
  }

  /* Abre un enlace fuera de la app (WhatsApp).
     - APK (Capacitor): app/navegador externo con "_system".
     - Safari de iPhone/iPad: window.open("_system") abre una pestaña EN BLANCO y deja la app en segundo plano, donde iOS la descarta y la reinicia.
       Se navega en la misma pestaña: Safari entrega wa.me directo a WhatsApp y al volver la app sigue ahí.
     - Otros navegadores: pestaña nueva; si el bloqueador de ventanas la impide, se navega en la misma pestaña. */
  function abrirEnlaceExterno(url) {
      const C = window.Capacitor, nativo = !!(C && ((C.isNativePlatform && C.isNativePlatform()) || (C.getPlatform && C.getPlatform() !== 'web')));
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      if (!nativo && ios) { window.location.href = url; return; }
      let w = null;
      try { w = window.open(url, nativo ? '_system' : '_blank'); } catch (_) {}
      if (!w && !nativo) window.location.href = url;
  }

  /* Borrador de la factura: si iOS descarta la pestaña y la app se reinicia, lo que ya se había armado vuelve solo */
  const CLAVE_BORRADOR = 'brothersDeliveryBorrador';
  function guardarBorrador() {
      try {
          if (pedidoSistema) return;   // la factura de un pedido asignado depende de ese pedido
          const d = { products, extraErrand, cliente: document.getElementById('customerName').value, delivery: document.getElementById('deliveryPrice').value, ts: Date.now() };
          if (!products.length && !d.cliente.trim() && !String(d.delivery).trim()) localStorage.removeItem(CLAVE_BORRADOR);
          else localStorage.setItem(CLAVE_BORRADOR, JSON.stringify(d));
      } catch (_) {}
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
      } catch (_) {}
  }

  /* Enlaces de contacto abiertos (los crea repartidor.js con "Contactarme al cliente") */
  function refrescarContactos() {
      const fila = document.getElementById('contactoFila'), sel = document.getElementById('contactoSel');
      if (pedidoSistema) { fila.style.display = 'none'; return; }   // la factura de un pedido ya tiene su enlace
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
          for (let i = 1; i <= 1500; i++) {
              codes.push('BD' + i.toString().padStart(4, '0'));
          }
          localStorage.setItem('brothersDeliveryCodeResetDate', today);
      }

      const randomIndex = Math.floor(Math.random() * codes.length);
      const selectedCode = codes.splice(randomIndex, 1)[0];
      localStorage.setItem('brothersDeliveryAvailableCodes', JSON.stringify(codes));
      return selectedCode;
  }

  function persistDepositInvoices() {
      localStorage.setItem('brothersDeliveryDepositInvoices', JSON.stringify(depositInvoices));
  }

  function formatMoney(n) {
      return `C$ ${Number(n || 0).toFixed(2)}`;
  }

  const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

  /* Precio base del delivery: en un pedido asignado lo fija el sistema; si no, lo escribe el repartidor */
  function deliveryBase() {
      if (pedidoSistema) return Number(pedidoSistema.delivery) || 0;
      return parseFloat(document.getElementById('deliveryPrice').value) || 0;
  }
  /* Cargo extra de prioridad (C$) que aceptó el cliente: solo aplica a la factura de un pedido asignado */
  function prioridadActual() {
      if (!pedidoSistema) return 0;
      const f = window.Factura.prioridadExtra;
      return typeof f === 'function' ? (Number(f()) || 0) : 0;
  }

  function renderDepositInvoices() {
      const container = document.getElementById('depositInvoicesList');
      if (!container) return;

      if (!depositInvoices.length) {
          container.innerHTML = '<div class="small-muted" style="margin-top:10px;">No hay facturas por cobrar.</div>';
          return;
      }

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
                          <table class="invoice-products-table">
                              ${productsHtml}
                          </table>
                          <div class="small-muted">Subtotal: ${formatMoney(inv.subtotal)} | Mandado extra: ${formatMoney(inv.extraErrand)}</div>
                      </div>
                  </details>
              </div>
          `;
      });

      container.innerHTML = html;
  }

  function clearDepositInvoices() {
      if (confirm('¿Seguro que deseas limpiar la lista de facturas “Por Cobrar”?')) {
          depositInvoices = [];
          persistDepositInvoices();
          renderDepositInvoices();
          showCustomAlert('Lista “Por Cobrar” limpiada.');
      }
  }

  function checkAndResetStats() {
      const currentBusinessDay = getBusinessDayString();
      if (dailyStats.businessDay !== currentBusinessDay) {
          dailyStats = {
              totalOrders: 0,
              totalEarnings: 0,
              businessDay: currentBusinessDay
          };
          localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
          document.getElementById('ivaAmount').value = '0';
          checkSessionAndLogin();
      }
  }

  /* factura.js también se carga en invitado.html (solo para el módulo "Nuevos Chats"), donde no existe la pantalla de factura */
  const TIENE_UI = !!document.getElementById('invoiceContainer');
  if (TIENE_UI) setInterval(checkAndResetStats, 30000);

  function showStats() {
      document.getElementById('invoiceContainer').style.display = 'none';
      document.getElementById('statsContainer').classList.add('active');
      updateStatsDisplay();
      renderDepositInvoices();
  }

  function hideStats() {
      document.getElementById('statsContainer').classList.remove('active');
      document.getElementById('invoiceContainer').style.display = 'block';
  }

  function updateStatsDisplay() {
      document.getElementById('totalOrders').textContent = dailyStats.totalOrders;
      document.getElementById('totalEarnings').textContent = `C$ ${dailyStats.totalEarnings.toFixed(2)}`;
      calculateIVA();
  }

  function calculateIVA() {
      const ivaAmount = parseFloat(document.getElementById('ivaAmount').value) || 0;
      const ivaResult = document.getElementById('ivaResult');
      
      if (ivaAmount > 0) {
          const totalWithoutIVA = dailyStats.totalEarnings - ivaAmount;
          ivaResult.style.display = 'block';
          ivaResult.textContent = `Total después de restar IVA: C$ ${totalWithoutIVA.toFixed(2)}`;
      } else {
          ivaResult.style.display = 'none';
      }
  }

  function resetStats() {
      if (confirm('¿Estás seguro de reiniciar todas las estadísticas? Esta acción no se puede deshacer.')) {
          dailyStats = {
              totalOrders: 0,
              totalEarnings: 0,
              businessDay: getBusinessDayString()
          };
          localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
          document.getElementById('ivaAmount').value = '0';
          updateStatsDisplay();
          showCustomAlert('¡Estadísticas reiniciadas correctamente!');
      }
  }

  function toggleExtraErrand(amount) {
      extraErrand = amount;
      const buttons = document.querySelectorAll('.extra-errand-btn');
      buttons.forEach(btn => btn.classList.remove('active'));
      
      if (amount === 0) {
          buttons[0].classList.add('active');
      } else if (amount === 10) {
          buttons[1].classList.add('active');
      } else if (amount === 20) {
          buttons[2].classList.add('active');
      }
      
      calculateTotal();
  }

  function addProductToList() {
      const name = document.getElementById('currentProductName').value.trim();
      const priceRaw = document.getElementById('currentProductPrice').value;
      const price = priceRaw === '' ? NaN : parseFloat(priceRaw);

      if (!name) {
          showCustomAlert('Por favor, ingresa el nombre del producto.');
          return;
      }

      if (Number.isNaN(price) || price < 0) {
          showCustomAlert('Por favor, ingresa un precio válido (puede ser 0).');
          return;
      }

      if (editingIndex >= 0) {
          products[editingIndex] = { name, price };
          editingIndex = -1;
          document.querySelector('.add-product-btn').textContent = '+';
      } else {
          products.push({ name, price });
      }

      document.getElementById('currentProductName').value = '';
      document.getElementById('currentProductPrice').value = '';

      renderProductList();
      calculateTotal();
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
      
      products.forEach(product => {
          subtotal += product.price;
      });

      const deliveryPrice = deliveryBase();
      const totalDelivery = deliveryPrice + extraErrand;
      const prioridad = prioridadActual();
      const grandTotal = subtotal + totalDelivery + prioridad;

      guardarBorrador();
      document.getElementById('subtotal').textContent = `C$ ${subtotal.toFixed(2)}`;
      document.getElementById('deliveryCost').textContent = `C$ ${totalDelivery.toFixed(2)}`;
      document.getElementById('grandTotal').textContent = `C$ ${grandTotal.toFixed(2)}`;

      const filaPrio = document.getElementById('fxPrioFila');
      if (filaPrio) {
          filaPrio.style.display = prioridad > 0 ? 'flex' : 'none';
          document.getElementById('fxPrioMonto').textContent = '+' + formatMoney(prioridad);
      }
  }

  function promptGenerateInvoice() {
      if (products.length === 0) {
          showCustomAlert('Por favor, agrega al menos un producto.');
          return;
      }
      document.getElementById('depositPromptPopup').classList.add('show');
  }

  function confirmDeposit(isPaid) {
      depositPaid = isPaid;
      document.getElementById('depositPromptPopup').classList.remove('show');
      generateInvoice();
  }

  let facturaActual = null;   // factura recién generada (aún sin enviar)

  function generateInvoice() {
      const customerName = document.getElementById('customerName').value.trim();
      const enPedido = !!pedidoSistema;   // pedido aceptado: usa SU código y SU enlace (el cliente ya lo está siguiendo)
      // Si ya se abrió un enlace de contacto con este cliente, la factura usa ESE mismo enlace y código
      const contacto = enPedido ? null : (window.Factura.contactos || []).find((x) => x.token === document.getElementById('contactoSel').value);
      const pickupCode = enPedido ? pedidoSistema.codigo : (contacto ? contacto.pedido : getUniqueCode());
      const token = enPedido ? pedidoSistema.id : (contacto ? contacto.token : crearToken());
      const link = `${URL_RASTREO}?id=${token}`;
      // Si el pedido nació con "Contactar con el cliente", el cliente YA recibió su enlace: la factura no vuelve a poner un enlace de seguimiento
      // (así no parece un segundo pedido). El token es el mismo, el seguimiento sigue funcionando en ese enlace.
      const sinEnlace = !!contacto;

      let invoiceHTML = '<div class="invoice-header-popup">🏍️ BROTHERS DELIVERY</div>';
      invoiceHTML += '<div class="invoice-divider"></div>';

      if (customerName) {
          invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">👤 CLIENTE: ${escHtml(customerName)}</div>`;
      }

      invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">💳 DEPÓSITO: ${depositPaid ? 'SÍ' : 'NO'}</div>`;

      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">📦 PRODUCTOS</div>';
      invoiceHTML += '<table class="invoice-products-table">';

      const SEP = '━━━━━━━━━━';   // línea del mensaje de WhatsApp (10 caracteres, como en el formato original)
      let invoiceText = '🏍️ *BROTHERS DELIVERY*\n';
      if (customerName) invoiceText += `Cliente: ${customerName}\n`;   // el nombre del cliente va arriba del nombre del repartidor
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
      const prioridad = prioridadActual();            // 10 si el cliente aceptó la prioridad, si no 0
      const totalBase = r2(subtotal + totalDelivery); // sin prioridad (el desglose del cliente suma la prioridad aparte)
      const grandTotal = r2(totalBase + prioridad);

      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<table class="invoice-totals-table">';
      invoiceHTML += `<tr><td>Subtotal:</td><td>C$ ${subtotal.toFixed(2)}</td></tr>`;

      if (extraErrand > 0) {
          invoiceHTML += `<tr><td>Delivery (C$ ${deliveryPrice.toFixed(2)} + Mandado Extra C$ ${extraErrand.toFixed(2)}):</td><td>C$ ${totalDelivery.toFixed(2)}</td></tr>`;
      } else {
          invoiceHTML += `<tr><td>Delivery:</td><td>C$ ${totalDelivery.toFixed(2)}</td></tr>`;
      }

      if (prioridad > 0) invoiceHTML += `<tr><td>⚡ Prioridad:</td><td>C$ ${prioridad.toFixed(2)}</td></tr>`;
      invoiceHTML += `<tr class="total-row"><td>TOTAL:</td><td>C$ ${grandTotal.toFixed(2)}</td></tr>`;
      invoiceHTML += '</table>';
      invoiceHTML += `<div style="text-align:center; font-weight:700; color:var(--red); margin-top:10px; font-size:1em;">CÓDIGO DE RETIRO: ${pickupCode}</div>`;
      if (sinEnlace) invoiceHTML += `<div class="invoice-track"><b>📍 Seguimiento en tiempo real</b>Usa el mismo enlace de seguimiento que ya te enviamos.</div>`;
      else invoiceHTML += `<div class="invoice-track"><b>📍 Seguimiento en tiempo real</b>Toca el enlace y verás la ubicación de tu paquete en tiempo real.<div class="lnk">${escHtml(link)}</div></div>`;
      invoiceHTML += '<div class="invoice-footer">¡Vuelve a pedir con nosotros cuando quieras! 🚀 Siempre listos para ayudarte 🙌</div>';

      invoiceText += `\n${SEP}\n`;
      invoiceText += `Productos: C$ ${subtotal.toFixed(2)}\n`;
      invoiceText += `Delivery: C$ ${(extraErrand > 0 ? deliveryPrice : totalDelivery).toFixed(2)}\n`;
      if (extraErrand > 0) invoiceText += `Mandado extra: C$ ${extraErrand.toFixed(2)}\n`;
      if (prioridad > 0) invoiceText += `⚡ Prioridad: C$ ${prioridad.toFixed(2)}\n`;
      invoiceText += `*TOTAL: C$ ${grandTotal.toFixed(2)}*\n`;
      invoiceText += `*CÓDIGO DE RETIRO: ${pickupCode}*\n`;
      invoiceText += `${SEP}\n\n`;
      if (sinEnlace) {   // el cliente ya recibió su enlace con "Contactar con el cliente": no se manda otro
          invoiceText += '📍 *Importante:* siga compartiendo su ubicación en tiempo real en el mismo enlace de seguimiento que ya le enviamos, para que su repartidor lo encuentre y su pedido llegue más rápido.';
      } else {
          invoiceText += '📍 *Importante:* abra el enlace y comparta su ubicación en tiempo real para que su repartidor lo encuentre y su pedido llegue más rápido.\n';
          invoiceText += `👉 ${link}`;
      }

      document.getElementById('generatedInvoiceDisplay').innerHTML = invoiceHTML;

      facturaActual = {
          token, pedido: pickupCode, cliente: customerName, tel: '', texto: invoiceText, total: totalBase, totalFinal: grandTotal, delivery: totalDelivery, link,
          // Desglose que ve el cliente en su enlace de rastreo (repartidor.js lo guarda en pedidos/{token}/detalle)
          productos: products.map((p) => ({ nombre: String(p.name), precio: Number(p.price) || 0 })),
          subtotal: subtotal, deliveryBase: deliveryPrice, mandadoExtra: extraErrand,
          prioridad, deposito: depositPaid, deSistema: enPedido, enlaceYaEnviado: sinEnlace, enviada: false
      };

      // En un pedido asignado la factura cuenta una sola vez, aunque haya que reintentar el envío
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
                  createdAt,
                  customerName,
                  depositPaid: true,
                  products: products.map(p => ({ name: p.name, price: p.price })),
                  subtotal,
                  deliveryPrice,
                  extraErrand,
                  totalDelivery,
                  grandTotal
              });

              persistDepositInvoices();
          }
      }

      document.getElementById('invoicePopup').classList.add('show');
      pintarPopupPedido(enPedido);
      if (enPedido) enviarAPedido();   // envío silencioso: sin WhatsApp, directo a la app del cliente
  }

  /* Botón principal: la factura (con el enlace de seguimiento) va SIEMPRE al chat de WhatsApp del negocio;
     el repartidor no tiene contacto directo con el cliente fuera de la app.
     Además activa el seguimiento: repartidor.js crea el pedido y lleva al repartidor al mapa. */
  const NEGOCIO_WA = '50586265619';
  function enviarFacturaWhatsApp() {
      if (!facturaActual) return;
      const f = facturaActual;
      facturaActual = null;   // evita iniciar dos veces con un doble toque
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
          }).catch(() => {
              hideCustomLoading();
              showCustomAlert('Ocurrió un error al guardar la imagen.');
          });
      }, 600);
  }

  /* ---------- Factura de un pedido asignado: delivery del sistema + envío silencioso a la app del cliente ---------- */
  function prepararPedido(info) {
      if (!info || !info.id) return;
      const mismo = !!pedidoSistema && pedidoSistema.id === String(info.id);
      pedidoSistema = { id: String(info.id), codigo: String(info.codigo || ''), cliente: String(info.cliente || ''), delivery: r2(info.delivery) };
      if (!mismo) {   // si el repartidor vuelve al mismo pedido, conserva lo que ya había armado
          products = []; editingIndex = -1; extraErrand = 0; depositPaid = false; facturaActual = null;
          document.getElementById('currentProductName').value = '';
          document.getElementById('currentProductPrice').value = '';
          document.getElementById('customerName').value = pedidoSistema.cliente;
          document.querySelector('.add-product-btn').textContent = '+';
          renderProductList();
          toggleExtraErrand(0);
      }
      hideStats();
      pintarModoPedido();
  }

  function pintarModoPedido() {
      const on = !!pedidoSistema, g = (id) => document.getElementById(id);
      g('pedidoBanner').style.display = on ? '' : 'none';
      g('deliveryManual').style.display = on ? 'none' : '';
      g('deliverySistema').style.display = on ? '' : 'none';
      g('btnContactoCliente').style.display = on ? 'none' : '';
      if (on) {
          g('pedidoBannerCod').textContent = pedidoSistema.codigo;
          g('pedidoBannerTxt').textContent = 'Se envía directo a la app del cliente' + (pedidoSistema.cliente ? ' · ' + pedidoSistema.cliente : '');
          g('deliverySistemaMonto').textContent = formatMoney(pedidoSistema.delivery);
          g('contactoFila').style.display = 'none';
      } else refrescarContactos();
      calculateTotal();
  }

  function salirModoPedido(forzar) {
      if (!pedidoSistema) return;
      if (!forzar && products.length && !confirm('¿Salir de la factura de este pedido? Se descartan los productos agregados.')) return;
      pedidoSistema = null; facturaActual = null; enviandoPedido = false;
      document.getElementById('invoicePopup').classList.remove('show');
      resetForm();
      pintarModoPedido();
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
          g('fxEnvioTxt').textContent = dato && dato.prioridad > 0
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
      if (!f || !f.deSistema || f.enviada || enviandoPedido) return;
      enviandoPedido = true;
      estadoEnvio('enviando');
      try {
          if (typeof window.Factura.alEnviarPedido !== 'function') throw new Error('El módulo de pedidos aún no está listo.');
          await window.Factura.alEnviarPedido(f);
          f.enviada = true;
          estadoEnvio('ok', f);
      } catch (e) {
          estadoEnvio('error', e);
      } finally {
          enviandoPedido = false;
      }
  }

  function reintentarEnvioPedido() { enviarAPedido(); }

  function closePopup() {
      const f = facturaActual;
      document.getElementById('invoicePopup').classList.remove('show');
      if (f && f.deSistema) {
          if (!f.enviada) return;   // no llegó al cliente: se conserva el formulario para volver a generar o reintentar
          facturaActual = null;     // enviada: se sale del modo pedido y se vuelve al mapa
          pedidoSistema = null;
          resetForm();
          pintarModoPedido();
          if (typeof window.Factura.alTerminarPedido === 'function') window.Factura.alTerminarPedido(f);
          return;
      }
      facturaActual = null;
      resetForm();
  }

  function resetForm() {
      products = [];
      editingIndex = -1;
      extraErrand = 0;

      document.getElementById('deliveryPrice').value = '';
      document.getElementById('currentProductName').value = '';
      document.getElementById('currentProductPrice').value = '';
      document.getElementById('customerName').value = '';
      depositPaid = false;
      refrescarContactos();
      
      const buttons = document.querySelectorAll('.extra-errand-btn');
      buttons.forEach(btn => btn.classList.remove('active'));
      
      renderProductList();
      calculateTotal();
  }

  if (TIENE_UI) document.getElementById('invoicePopup').addEventListener('click', function(e) {
      if (e.target === this) {
          closePopup();
      }
  });

  if (TIENE_UI) document.getElementById('depositPromptPopup').addEventListener('click', function(e) {
      if (e.target === this) {
          this.classList.remove('show');
      }
  });

  if (TIENE_UI) {
    restaurarBorrador();
    renderProductList();
    document.getElementById('customerName').addEventListener('input', guardarBorrador);
    toggleExtraErrand(extraErrand);
    calculateTotal();
    checkAndResetStats();
    checkSessionAndLogin();
    renderDepositInvoices();
  }

  /* ============================================================
     NUEVOS CHATS (FASE 2) — módulo compartido por repartidor.html (registrados) e invitado.html (invitados)
     - Escucha en tiempo real solicitudes_entrantes/{id} = { cliente, texto, ts, estado, atendidoPor:{uid,nombre,tipo} }.
       El id de la solicitud es también el token del chat (chats/{id}) y del pedido (pedidos/{id}).
     - "Atender": transacción sobre la solicitud → solo el primero se queda como dueño exclusivo; para los demás desaparece del pool.
     - Dentro del chat atendido: mensajes en vivo, "Crear factura" (productos, delivery, mandado extra, depósito) y al enviarla
       se escribe EN UNA SOLA operación: mensaje tipo "factura" en chats/{id}, pedidos/{id} (factura + detalle, estado en_ruta)
       y la solicitud pasa a estado "pedido" (pedido en curso).
     - Se construye todo con DOM propio, así funciona igual donde no existe la pantalla de factura.
     ============================================================ */
  const Solicitudes = (() => {
    const RUTA = 'solicitudes_entrantes';
    let o = null, ref = null, datos = {}, listo = false, abierto = false, vista = 'lista', tab = 'entrantes', errLectura = '';
    let chatId = null, refChat = null, prevPend = new Set(), avisoT = null, construido = false;
    let fcProds = [], fcExtra = 0, fcEnviando = false, fcId = null;
    const claimando = new Set();
    const g = (id) => document.getElementById(id);
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const money = (n) => 'C$ ' + (Number(n) || 0).toFixed(2);
    const TSX = () => firebase.database.ServerValue.TIMESTAMP;
    const miUid = () => (o && typeof o.uid === 'function' && o.uid()) || '';
    const miNombre = () => String((o && typeof o.nombre === 'function' && o.nombre()) || 'Repartidor').slice(0, 40);
    const nombreSol = (s) => String((s && (s.cliente || s.nombre || s.nombreCliente)) || 'Cliente').slice(0, 60);
    const textoSol = (s) => String((s && (s.texto || s.mensaje || s.ultimo)) || '').slice(0, 200);
    const dueno = (s) => (s && s.atendidoPor && s.atendidoPor.uid ? s.atendidoPor : null);
    const pendiente = (s) => !!s && typeof s === 'object' && (!s.estado || s.estado === 'pendiente') && !dueno(s);
    const mia = (s) => !!s && typeof s === 'object' && !!dueno(s) && dueno(s).uid === miUid();
    const ids = (f) => Object.keys(datos).filter((k) => datos[k] && typeof datos[k] === 'object' && f(datos[k]));
    const porTs = (a, b) => (Number(datos[a].ts) || 0) - (Number(datos[b].ts) || 0);
    function hace(ts) {
      const n = Number(ts) || 0; if (!n) return '';
      const m = Math.max(0, Math.round((Date.now() - n) / 60000));
      if (m < 1) return 'ahora'; if (m < 60) return 'hace ' + m + ' min';
      const h = Math.round(m / 60); return h < 24 ? 'hace ' + h + ' h' : 'hace ' + Math.round(h / 24) + ' d';
    }
    function aviso(txt, tipo) {
      const e = g('sxAviso'); if (!e) return;
      e.textContent = txt || ''; e.className = 'sx-aviso' + (txt ? ' on ' + (tipo || '') : '');
      clearTimeout(avisoT); if (txt) avisoT = setTimeout(() => aviso(''), 5000);
    }

    function estilos() {
      if (g('sxEstilos')) return;
      const st = document.createElement('style'); st.id = 'sxEstilos';
      st.textContent = `
.sx-ov{position:fixed;inset:0;z-index:9000;display:none;align-items:flex-end;justify-content:center;background:rgba(14,20,27,.55);font-family:"Plus Jakarta Sans",system-ui,sans-serif}
.sx-ov.on{display:flex}
.sx-fov{z-index:9100;align-items:center}
.sx-box{width:100%;max-width:520px;height:min(92vh,680px);display:flex;flex-direction:column;background:#fff;color:#0E141B;border-radius:20px 20px 0 0;overflow:hidden;box-sizing:border-box}
.sx-fov .sx-box{height:auto;max-height:92vh;border-radius:20px;width:calc(100% - 24px)}
.sx-cab{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:2px solid #E3E9EE}
.sx-cab h2{flex:1;margin:0;min-width:0;font-size:17px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-ib{flex:none;width:38px;height:38px;border:0;border-radius:12px;background:#EEF3F7;color:#0E141B;font-size:17px;font-weight:800;cursor:pointer}
.sx-h{display:none!important}
.sx-aviso{display:none;margin:8px 14px 0;padding:8px 12px;border-radius:10px;background:#E8F6EE;color:#17602B;font-size:13px;font-weight:700}
.sx-aviso.on{display:block}.sx-aviso.error{background:#FDECEA;color:#B3261E}
.sx-cuerpo{flex:1;min-height:0;display:flex;flex-direction:column;overflow-y:auto}
.sx-tabs{display:flex;gap:6px;padding:10px 14px 0}
.sx-tabs button{flex:1;padding:10px 6px;border:0;border-radius:10px;background:#EEF3F7;color:#0E141B;font-size:13px;font-weight:700;cursor:pointer}
.sx-tabs button.on{background:#3DB8F5}
.sx-lista{display:grid;gap:8px;padding:10px 14px 16px}
.sx-card{display:flex;align-items:center;gap:10px;padding:10px 12px;border:2px solid #D6DDE3;border-radius:14px}
.sx-dat{flex:1;min-width:0;display:grid;gap:2px}
.sx-dat b{font-size:15px;font-weight:800}
.sx-dat span{font-size:13px;color:#4A5A6A;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-dat small{font-size:11.5px;font-weight:700;color:#6B7B8A}
.sx-vacio{margin:18px 6px;text-align:center;font-size:13.5px;font-weight:600;color:#6B7B8A}
.sx-pri{flex:none;padding:10px 14px;border:0;border-radius:12px;background:#0E141B;color:#fff;font-size:14px;font-weight:800;cursor:pointer}
.sx-pri:disabled{background:#1E9B5A;opacity:.9;cursor:default}
.sx-sec{padding:10px 14px;border:0;border-radius:12px;background:#EEF3F7;color:#0E141B;font-size:14px;font-weight:700;cursor:pointer}
.sx-info{margin:10px 14px 0;padding:8px 12px;border-radius:10px;background:#F1F5F9;font-size:13px;font-weight:600;color:#2C3E50;overflow-wrap:anywhere}
.sx-msgs{flex:1;min-height:200px;display:flex;flex-direction:column;gap:6px;padding:10px 14px;overflow-y:auto}
.sx-msg{max-width:82%;align-self:flex-start;padding:8px 12px;border-radius:14px 14px 14px 4px;background:#EEF3F7;font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap}
.sx-msg.yo{align-self:flex-end;border-radius:14px 14px 4px 14px;background:#CDEBFB}
.sx-fac{display:grid;gap:3px;background:#fff!important;border:2px solid #1E9B5A;white-space:normal}
.sx-fac span{font-size:13px}
.sx-form{display:flex;gap:8px;padding:8px 14px}
.sx-form input{flex:1;min-width:0;height:44px;padding:0 12px;border:2px solid #D6DDE3;border-radius:12px;font-size:15px;box-sizing:border-box}
.sx-acc{display:flex;gap:8px;padding:8px 14px 14px}
.sx-acc button{flex:1}
.sx-body{overflow-y:auto;padding:12px 14px;display:grid;gap:10px}
.sx-l{display:grid;gap:4px;font-size:12.5px;font-weight:800;color:#4A5A6A}
.sx-l input{height:44px;padding:0 12px;border:2px solid #D6DDE3;border-radius:12px;font-size:15px;color:#0E141B;box-sizing:border-box;width:100%}
.sx-ext{display:flex;gap:6px}
.sx-ext button{flex:1;padding:10px 4px;border:2px solid #D6DDE3;border-radius:10px;background:#fff;color:#0E141B;font-size:13px;font-weight:800;cursor:pointer}
.sx-ext button.on{background:#3DB8F5;border-color:#0A86C9}
.sx-prod{display:grid;grid-template-columns:1fr 90px 46px;gap:6px}
.sx-prod .sx-pri{padding:0}
.sx-it{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:10px;background:#F1F5F9;font-size:14px}
.sx-it span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sx-it button{width:30px;height:30px;border:0;border-radius:8px;background:#fff;font-weight:800;cursor:pointer}
.sx-chk{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:700}
.sx-chk input{width:20px;height:20px}
.sx-tot{display:grid;gap:3px;padding:10px 12px;border-radius:12px;background:#E8F6EE;border:2px solid #1E9B5A;font-size:14px;font-weight:700}
.sx-tot div{display:flex;justify-content:space-between}
.sx-tot .g{font-size:17px;font-weight:800}
.sx-err{min-height:0;color:#B3261E;font-size:13px;font-weight:700}`;
      document.head.appendChild(st);
    }

    function construir() {
      if (construido) return;
      estilos();
      const ov = document.createElement('div'); ov.className = 'sx-ov'; ov.id = 'sxOv';
      ov.innerHTML = '<div class="sx-box" role="dialog" aria-modal="true" aria-labelledby="sxTitulo">' +
        '<div class="sx-cab"><button type="button" class="sx-ib sx-h" id="sxAtras" aria-label="Volver a la lista">←</button><h2 id="sxTitulo">Nuevos Chats</h2><button type="button" class="sx-ib" id="sxCerrar" aria-label="Cerrar">✕</button></div>' +
        '<div id="sxAviso" class="sx-aviso" role="status"></div><div class="sx-cuerpo" id="sxCuerpo"></div></div>';
      document.body.appendChild(ov);
      ov.addEventListener('click', (e) => {
        if (e.target === ov) return cerrar();
        const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'sxCerrar') return cerrar();
        if (b.id === 'sxAtras') return salirChat();
        if (b.dataset.tab) { tab = b.dataset.tab; return render(); }
        if (b.dataset.at) return atender(b.dataset.at);
        if (b.dataset.ab) return abrirChat(b.dataset.ab);
        if (b.id === 'sxBtnFact') return abrirFactura();
        if (b.id === 'sxBtnLib') return liberar();
      });
      ov.addEventListener('submit', (e) => { if (e.target.id === 'sxForm') { e.preventDefault(); enviarTexto(); } });

      const fov = document.createElement('div'); fov.className = 'sx-ov sx-fov'; fov.id = 'sxFov';
      fov.innerHTML = '<div class="sx-box" role="dialog" aria-modal="true" aria-labelledby="sxfTitulo">' +
        '<div class="sx-cab"><h2 id="sxfTitulo">🧾 Factura del chat</h2><button type="button" class="sx-ib" id="sxfX" aria-label="Cerrar factura">✕</button></div>' +
        '<div class="sx-body">' +
        '<label class="sx-l">👤 Cliente<input id="sxfCli" maxlength="60" autocomplete="off" placeholder="Nombre del cliente"></label>' +
        '<label class="sx-l">🛵 Delivery (C$)<input id="sxfDel" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0"></label>' +
        '<div class="sx-l">➕ Mandado extra<div class="sx-ext" id="sxfExt"><button type="button" data-x="0">Ninguno</button><button type="button" data-x="10">+C$10</button><button type="button" data-x="20">+C$20</button></div></div>' +
        '<div class="sx-l">📦 Producto y precio<div class="sx-prod"><input id="sxfPN" maxlength="80" autocomplete="off" placeholder="Producto" aria-label="Producto"><input id="sxfPP" type="number" inputmode="decimal" min="0" step="0.01" placeholder="C$" aria-label="Precio"><button type="button" class="sx-pri" id="sxfAdd" aria-label="Agregar producto">+</button></div></div>' +
        '<div id="sxfLista" style="display:grid;gap:6px"></div>' +
        '<label class="sx-chk"><input type="checkbox" id="sxfDep"> 💳 El cliente pagó por depósito</label>' +
        '<div class="sx-tot" id="sxfTot"></div><div class="sx-err" id="sxfMsg" role="alert"></div></div>' +
        '<div class="sx-acc"><button type="button" class="sx-sec" id="sxfCancel">Cancelar</button><button type="button" class="sx-pri" id="sxfEnv">📤 Enviar factura al chat</button></div></div>';
      document.body.appendChild(fov);
      fov.addEventListener('click', (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.id === 'sxfX' || b.id === 'sxfCancel') return cerrarFactura();
        if (b.id === 'sxfAdd') return agregarProd();
        if (b.id === 'sxfEnv') return enviarFactura();
        if (b.dataset.x !== undefined) { fcExtra = Number(b.dataset.x) || 0; return pintarFactura(); }
        if (b.dataset.rm !== undefined) { fcProds.splice(Number(b.dataset.rm), 1); return pintarFactura(); }
      });
      fov.addEventListener('input', (e) => { if (e.target.id === 'sxfDel') pintarFactura(); });
      fov.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.id === 'sxfPN' || e.target.id === 'sxfPP')) { e.preventDefault(); agregarProd(); } });
      construido = true;
    }

    /* ---------- Lista (pool) ---------- */
    const card = (id, s, esMia) => `<div class="sx-card"><div class="sx-dat"><b>${esc(nombreSol(s))}</b><span>${esc(textoSol(s) || 'Quiere hacer un pedido')}</span><small>${esc(hace(s.ts))}${esMia && s.estado === 'pedido' ? ' · ✅ Pedido en curso' : ''}</small></div><button type="button" class="sx-pri" ${esMia ? 'data-ab' : 'data-at'}="${esc(id)}">${esMia ? 'Abrir' : 'Atender'}</button></div>`;
    function renderLista() {
      g('sxTitulo').textContent = 'Nuevos Chats';
      const pend = ids(pendiente).sort(porTs), mias = ids(mia).sort((a, b) => porTs(b, a));
      const tb = (k, t, n) => `<button type="button" class="${tab === k ? 'on' : ''}" data-tab="${k}">${t} (${n})</button>`;
      let h = `<div class="sx-tabs">${tb('entrantes', '📥 Entrantes', pend.length)}${tb('mis', '💬 Mis chats', mias.length)}</div><div class="sx-lista">`;
      if (errLectura) h += `<p class="sx-vacio">${esc(errLectura)}</p>`;
      else if (tab === 'entrantes') h += pend.length ? pend.map((id) => card(id, datos[id], false)).join('') : '<p class="sx-vacio">No hay solicitudes nuevas. Cuando un cliente escriba, aparecerá aquí al instante.</p>';
      else h += mias.length ? mias.map((id) => card(id, datos[id], true)).join('') : '<p class="sx-vacio">Todavía no atiendes ningún chat.</p>';
      g('sxCuerpo').innerHTML = h + '</div>';
    }
    function render() {
      if (!abierto || !construido) return;
      g('sxAtras').classList.toggle('sx-h', vista !== 'chat');
      if (vista === 'chat') return pintarCabChat();
      renderLista();
    }
    function badge() {
      const n = ids(pendiente).length, b = o && g(o.badge);
      if (b) { b.textContent = n; b.classList.toggle('oculto', !n); }
    }

    /* ---------- Atender: dueño exclusivo con transacción ---------- */
    async function atender(id) {
      if (claimando.has(id)) return; claimando.add(id);
      aviso('');
      try {
        const r = o.db.ref(RUTA + '/' + id);
        await r.once('value');   // carga el valor real para que la transacción no parta de "vacío"
        const res = await r.transaction((cur) => {
          if (cur === null) return cur;
          if (typeof cur !== 'object') return;
          const d = dueno(cur);
          if (d && d.uid !== miUid()) return;   // ya lo tomó otro: se aborta
          if (cur.estado && cur.estado !== 'pendiente' && cur.estado !== 'atendida' && cur.estado !== 'pedido') return;
          if (cur.estado !== 'pedido') cur.estado = 'atendida';
          cur.atendidoPor = { uid: miUid(), nombre: miNombre(), tipo: (o && o.tipo) || 'registrado', ts: Date.now() };
          return cur;
        }, undefined, false);
        const val = res.snapshot.val();
        if (!res.committed || !val) {
          const quien = val && dueno(val) ? dueno(val).nombre : '';
          aviso(val ? 'Este chat ya lo atiende ' + (quien || 'otro repartidor') + '.' : 'Esta solicitud ya no existe.', 'error');
        } else { datos[id] = val; tab = 'mis'; abrirChat(id); }
      } catch (e) { aviso('No se pudo atender: ' + e.message, 'error'); }
      finally { claimando.delete(id); }
    }
    async function liberar() {
      const id = chatId, s = id && datos[id]; if (!s || !mia(s) || s.estado === 'pedido') return;
      if (!confirm('¿Devolver este chat al pool para que lo atienda otro repartidor?')) return;
      try {
        await o.db.ref(RUTA + '/' + id).transaction((cur) => {
          if (!cur || !dueno(cur) || dueno(cur).uid !== miUid() || cur.estado === 'pedido') return;
          cur.estado = 'pendiente'; cur.atendidoPor = null; return cur;
        }, undefined, false);
        salirChat(); tab = 'entrantes'; render();
      } catch (e) { aviso('No se pudo liberar: ' + e.message, 'error'); }
    }

    /* ---------- Chat del cliente ---------- */
    function pintarMsg(m) {
      const box = g('sxMsgs'); if (!box || !m) return;
      const d = document.createElement('div'), yo = m.de === 'repartidor';
      if (m.tipo === 'factura' && m.factura) {
        const f = m.factura; d.className = 'sx-msg sx-fac' + (yo ? ' yo' : '');
        d.innerHTML = `<b>🧾 Factura ${esc(f.pedido || '')}</b>` + (Array.isArray(f.productos) ? f.productos : []).map((p) => `<span>• ${esc(p.nombre)} – ${money(p.precio)}</span>`).join('') + `<b>TOTAL ${money(f.total)}</b>`;
      } else { d.className = 'sx-msg' + (yo ? ' yo' : ''); d.textContent = m.texto || (m.foto ? '📷 Foto' : ''); }
      box.appendChild(d); box.scrollTop = box.scrollHeight;
    }
    function detenerChat() { if (refChat) { refChat.off(); refChat = null; } chatId = null; }
    function abrirChat(id) {
      const s = datos[id];
      if (!s || !mia(s)) return aviso('Este chat no está asignado a ti.', 'error');
      detenerChat(); chatId = id; vista = 'chat';
      g('sxCuerpo').innerHTML = '<div class="sx-info" id="sxInfo"></div><div class="sx-msgs" id="sxMsgs"></div>' +
        '<form class="sx-form" id="sxForm" autocomplete="off"><input id="sxTxt" maxlength="600" placeholder="Escribe al cliente…" aria-label="Mensaje al cliente"><button type="submit" class="sx-pri">Enviar</button></form>' +
        '<div class="sx-acc"><button type="button" class="sx-pri" id="sxBtnFact">🧾 Crear factura</button><button type="button" class="sx-sec" id="sxBtnLib">Liberar</button></div>';
      let cargado = false;
      refChat = o.db.ref('chats/' + id).limitToLast(60);
      refChat.on('child_added', (sn) => {
        if (chatId !== id) return;
        const m = sn.val(); pintarMsg(m);
        if (cargado && m && m.de === 'cliente' && navigator.vibrate) navigator.vibrate(150);
      }, () => aviso('No se pudo leer el chat. Revisa tu conexión.', 'error'));
      refChat.once('value', () => { cargado = true; });
      render();
    }
    function salirChat() { detenerChat(); vista = 'lista'; render(); }
    function pintarCabChat() {
      const s = chatId && datos[chatId];
      if (!s || !mia(s)) { salirChat(); aviso('Este chat ya no está asignado a ti.', 'error'); return; }
      g('sxTitulo').textContent = '💬 ' + nombreSol(s);
      g('sxAtras').classList.remove('sx-h');
      const info = g('sxInfo'); if (info) info.textContent = textoSol(s) ? 'Solicitud: ' + textoSol(s) : 'El cliente aún no escribió un mensaje inicial.';
      const fact = s.estado === 'pedido', bf = g('sxBtnFact'), bl = g('sxBtnLib');
      if (bf) { bf.disabled = fact; bf.textContent = fact ? '✅ Pedido en curso · ' + (s.pedidoCodigo || 'factura enviada') : '🧾 Crear factura'; }
      if (bl) bl.classList.toggle('sx-h', fact);
    }
    async function enviarTexto() {
      const id = chatId, inp = g('sxTxt'); if (!id || !inp) return;
      const texto = inp.value.trim().slice(0, 600); if (!texto) return;
      inp.value = '';
      try { await o.db.ref('chats/' + id).push({ de: 'repartidor', texto, ts: TSX(), nombre: miNombre() }); }
      catch (e) { inp.value = texto; aviso('No se pudo enviar: ' + e.message, 'error'); }
    }

    /* ---------- Factura dentro del chat (misma lógica de cuenta que factura.js) ---------- */
    function calcFc() {
      const sub = r2(fcProds.reduce((t, p) => t + p.precio, 0)), raw = g('sxfDel').value.trim();
      const del = raw === '' ? 0 : parseFloat(raw), delOk = Number.isFinite(del) && del >= 0, delivery = delOk ? r2(del) : 0, totDel = r2(delivery + fcExtra);
      return { sub, delivery, delOk, totDel, total: r2(sub + totDel) };
    }
    function pintarFactura() {
      const c = calcFc();
      g('sxfExt').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.x) === fcExtra));
      g('sxfLista').innerHTML = fcProds.map((p, i) => `<div class="sx-it"><span>${esc(p.nombre)}</span><b>${money(p.precio)}</b><button type="button" data-rm="${i}" aria-label="Quitar ${esc(p.nombre)}">✕</button></div>`).join('');
      g('sxfTot').innerHTML = `<div><span>Subtotal</span><b>${money(c.sub)}</b></div><div><span>Delivery${fcExtra ? ' + mandado extra' : ''}</span><b>${money(c.totDel)}</b></div><div class="g"><span>TOTAL</span><b>${money(c.total)}</b></div>`;
    }
    function agregarProd() {
      const n = g('sxfPN').value.trim().slice(0, 80), raw = g('sxfPP').value, p = raw === '' ? NaN : parseFloat(raw);
      if (!n) return (g('sxfMsg').textContent = 'Escribe el nombre del producto.');
      if (!Number.isFinite(p) || p < 0) return (g('sxfMsg').textContent = 'Escribe un precio válido (puede ser 0).');
      g('sxfMsg').textContent = '';
      fcProds.push({ nombre: n, precio: r2(p) });
      g('sxfPN').value = ''; g('sxfPP').value = ''; g('sxfPN').focus();
      pintarFactura();
    }
    function abrirFactura() {
      const id = chatId, s = id && datos[id]; if (!s || !mia(s)) return;
      if (s.estado === 'pedido') return aviso('Este chat ya tiene su factura enviada.');
      fcId = id; fcProds = []; fcExtra = 0;
      g('sxfCli').value = String(s.cliente || s.nombre || '').slice(0, 60);
      g('sxfDel').value = ''; g('sxfPN').value = ''; g('sxfPP').value = ''; g('sxfDep').checked = false; g('sxfMsg').textContent = '';
      pintarFactura();
      g('sxFov').classList.add('on');
      setTimeout(() => g('sxfDel').focus(), 60);
    }
    function cerrarFactura() { const f = g('sxFov'); if (f) f.classList.remove('on'); fcId = null; }
    async function enviarFactura() {
      if (fcEnviando || !o) return;
      const id = fcId, msg = g('sxfMsg'), btn = g('sxfEnv');
      msg.textContent = '';
      if (!id) return;
      if (!fcProds.length) { msg.textContent = 'Agrega al menos un producto.'; return; }
      const c = calcFc();
      if (!c.delOk) { msg.textContent = 'El delivery debe ser un número válido (0 o más).'; return; }
      const cliente = g('sxfCli').value.trim().slice(0, 60) || nombreSol(datos[id]), deposito = g('sxfDep').checked;
      fcEnviando = true; btn.disabled = true; btn.textContent = 'Enviando…';
      try {
        const db = o.db;
        const sol = (await db.ref(RUTA + '/' + id).once('value')).val();
        if (!sol || !mia(sol)) throw new Error('Este chat ya no está asignado a ti.');
        if (sol.estado === 'pedido') throw new Error('Este chat ya tiene una factura enviada.');
        const estadoPed = (await db.ref('pedidos/' + id + '/estado').once('value')).val();
        const codigo = String((typeof o.codigo === 'function' && o.codigo()) || getUniqueCode());
        const productos = fcProds.map((p) => ({ nombre: String(p.nombre), precio: r2(p.precio) }));
        const f = {
          token: id, pedido: codigo, cliente, tel: '', total: c.total, totalFinal: c.total, delivery: c.totDel, subtotal: c.sub,
          deliveryBase: c.delivery, mandadoExtra: fcExtra, productos, prioridad: 0, deposito, deSistema: false, enviada: true
        };
        let facturaDb = null;
        try { facturaDb = typeof o.instantanea === 'function' ? o.instantanea(f) : null; } catch (_) { facturaDb = null; }
        if (!facturaDb || typeof facturaDb !== 'object') facturaDb = { pedido: codigo, cliente, total: c.total, delivery: c.totDel, subtotal: c.sub, productos, deposito };
        facturaDb = JSON.parse(JSON.stringify(facturaDb));
        const detalle = { productos, subtotal: c.sub, delivery: c.totDel, totalBase: c.total, total: c.total };
        let texto = '🧾 FACTURA ' + codigo + '\n';
        productos.forEach((p) => { texto += '• ' + p.nombre + ' – ' + money(p.precio) + '\n'; });
        texto += 'Productos: ' + money(c.sub) + '\nDelivery: ' + money(c.delivery) + '\n';
        if (fcExtra > 0) texto += 'Mandado extra: ' + money(fcExtra) + '\n';
        texto += 'TOTAL: ' + money(c.total) + '\nCÓDIGO DE RETIRO: ' + codigo;
        if (deposito) texto += '\nDepósito: SÍ';
        const mensaje = {
          de: 'repartidor', nombre: miNombre(), tipo: 'factura', texto, ts: TSX(),
          factura: { pedido: codigo, cliente, productos, subtotal: c.sub, delivery: c.delivery, mandadoExtra: fcExtra, deliveryTotal: c.totDel, total: c.total, deposito }
        };
        const base = 'pedidos/' + id + '/', key = db.ref('chats/' + id).push().key, upd = {};
        upd['chats/' + id + '/' + key] = mensaje;
        upd[base + 'pedido'] = codigo;
        upd[base + 'repartidorUid'] = String((typeof o.repartidorUid === 'function' && o.repartidorUid()) || miUid());
        upd[base + 'repartidorNombre'] = miNombre();
        upd[base + 'factura'] = facturaDb;
        upd[base + 'detalle'] = detalle;
        if (!estadoPed) { upd[base + 'estado'] = 'en_ruta'; upd[base + 'inicio'] = TSX(); }
        if (o.tipo === 'invitado') upd[base + 'invitado'] = true;
        upd[RUTA + '/' + id + '/estado'] = 'pedido';
        upd[RUTA + '/' + id + '/pedidoCodigo'] = codigo;
        upd[RUTA + '/' + id + '/total'] = c.total;
        upd[RUTA + '/' + id + '/facturaTs'] = TSX();
        await db.ref().update(upd);

        dailyStats.totalOrders += 1; dailyStats.totalEarnings += c.totDel;
        localStorage.setItem('brothersDeliveryStats', JSON.stringify(dailyStats));
        if (deposito) {
          const now = new Date();
          depositInvoices.push({ id: now.getTime() + '_' + Math.random().toString(16).slice(2), createdAt: now.toLocaleString('es-ES'), customerName: cliente, depositPaid: true,
            products: productos.map((p) => ({ name: p.nombre, price: p.precio })), subtotal: c.sub, deliveryPrice: c.delivery, extraErrand: fcExtra, totalDelivery: c.totDel, grandTotal: c.total });
          persistDepositInvoices();
        }
        cerrarFactura();
        if (datos[id]) { datos[id].estado = 'pedido'; datos[id].pedidoCodigo = codigo; }
        aviso('✅ Factura enviada al chat del cliente. Ya es un pedido en curso.');
        render();
        if (typeof o.alFacturada === 'function') { try { o.alFacturada(f); } catch (e2) { console.warn('alFacturada:', e2); } }
      } catch (e) { msg.textContent = 'No se pudo enviar la factura: ' + (e && e.message ? e.message : e); }
      finally { fcEnviando = false; btn.disabled = false; btn.textContent = '📤 Enviar factura al chat'; }
    }

    /* ---------- Ciclo de vida ---------- */
    function alDatos(snap) {
      errLectura = ''; datos = snap.val() || {};
      const pend = ids(pendiente);
      if (listo) pend.filter((k) => !prevPend.has(k)).forEach((k) => {
        navigator.vibrate && navigator.vibrate([250, 120, 250]);
        if (typeof o.alNueva === 'function') { try { o.alNueva(k, datos[k]); } catch (_) {} }
      });
      prevPend = new Set(pend); listo = true;
      badge(); render();
    }
    function init(opts) {
      detener();
      o = opts; estilos();
      const b = g(o.boton); if (b) b.onclick = abrir;
      ref = o.db.ref(RUTA).limitToLast(100);
      ref.on('value', alDatos, (err) => { errLectura = 'No se pudieron leer las solicitudes: ' + (err && err.message ? err.message : 'sin permiso'); badge(); render(); });
    }
    function abrir() {
      if (!o) return;
      construir(); abierto = true; vista = 'lista';
      g('sxOv').classList.add('on'); render();
    }
    function cerrar() {
      cerrarFactura(); detenerChat(); abierto = false; vista = 'lista';
      const ov = g('sxOv'); if (ov) ov.classList.remove('on');
    }
    function cerrarCapa() {
      const f = g('sxFov');
      if (f && f.classList.contains('on')) { cerrarFactura(); return true; }
      if (!abierto) return false;
      if (vista === 'chat') { salirChat(); return true; }
      cerrar(); return true;
    }
    function detener() {
      if (ref) { ref.off(); ref = null; }
      cerrar(); datos = {}; listo = false; prevPend = new Set(); errLectura = '';
      const b = o && g(o.badge); if (b) b.classList.add('oculto');
      o = null;
    }
    return { init, detener, abrir, cerrar, cerrarCapa };
  })();
  window.Solicitudes = Solicitudes;

Object.assign(window, { abrirEnlaceExterno, showCustomAlert, closeCustomAlert, closeCustomConfirm, confirmDeposit, showStats, hideStats, calculateTotal, toggleExtraErrand, addProductToList, editProduct, deleteProduct, clearDepositInvoices, resetStats, calculateIVA, promptGenerateInvoice, downloadInvoiceImage, closePopup, enviarFacturaWhatsApp, alElegirContacto, reintentarEnvioPedido });
})();
