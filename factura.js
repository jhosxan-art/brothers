/* ============================================================
   FACTURACIÓN — integrada en la app del repartidor
   Basada en el sistema del ZIP (productos, delivery, mandado extra, depósito, estadísticas).
   Cambios: sin PIN (ya hay login), campo de WhatsApp del cliente, enlace de seguimiento dentro
   de la factura y gancho Factura.alEnviar(...) que usa repartidor.js para activar el seguimiento.
   Va dentro de una función para no chocar con los nombres de repartidor.js.
   FASE 2: modo "pedido asignado" (Factura.prepararPedido): el delivery lo fija el sistema, suma la prioridad
   de C$ 10 si el cliente la aceptó y la factura se guarda en Firebase sin pasar por WhatsApp.
   FASE 3: mensaje de WhatsApp minimalista, leyenda persuasiva para abrir el enlace y enlace de rastreo limpio (solo ?id=).
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
    recalcular: () => calculateTotal(),
    enlaceRastreo: (token, extra) => enlaceRastreo(token, extra),
    leyendaEnlace: (link) => leyendaEnlace(link)
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


  /* FASE 3 — Enlace de rastreo limpio: solo lleva ?id=TOKEN (sin utm_, fbclid, index.html, #hash ni otros parámetros de ruido).
     Si necesitas "&chat=1" u otro parámetro funcional, pásalo en `extra`. */
  function enlaceRastreo(token, extra) {
      try {
          const u = new URL(String(URL_RASTREO), window.location.href);
          u.hash = '';
          Array.from(u.searchParams.keys()).forEach((k) => {
              if (/^(utm_|fbclid$|gclid$|ref$|source$|debug$|v$|t$|ts$|cb$|nocache$)/i.test(k)) u.searchParams.delete(k);
          });
          u.pathname = u.pathname.replace(/\/index\.html?$/i, '/');
          u.searchParams.set('id', token);
          if (extra) Object.keys(extra).forEach((k) => u.searchParams.set(k, extra[k]));
          return u.toString();
      } catch (e) {
          return `${URL_RASTREO}?id=${token}`;
      }
  }

  /* FASE 3 — Leyenda persuasiva que acompaña al enlace en WhatsApp */
  function leyendaEnlace(link) {
      return '📍 *Paso importante para recibir su pedido*\n' +
          'Para que su repartidor sepa con exactitud dónde se encuentra y su pedido llegue lo más rápido posible, ' +
          '*es vital que abra el enlace de abajo y permita compartir su ubicación en tiempo real*. ' +
          'Sin su ubicación, la entrega puede retrasarse.\n\n' +
          '👉 *Abra aquí ahora (toma 5 segundos):*\n' + link;
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

  setInterval(checkAndResetStats, 30000);

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
      const link = enlaceRastreo(token);   // FASE 3: enlace limpio, solo ?id=

      let invoiceHTML = '<div class="invoice-header-popup">🏍️ BROTHERS DELIVERY</div>';
      invoiceHTML += '<div class="invoice-divider"></div>';

      if (customerName) {
          invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">👤 CLIENTE: ${escHtml(customerName)}</div>`;
      }

      invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">💳 DEPÓSITO: ${depositPaid ? 'SÍ' : 'NO'}</div>`;

      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">📦 PRODUCTOS</div>';
      invoiceHTML += '<table class="invoice-products-table">';

      /* FASE 3 — Texto de WhatsApp minimalista: repartidor, productos con precio, costo de productos, delivery y total */
      const nombreRep = (window.Factura && window.Factura.nombreRepartidor) ? String(window.Factura.nombreRepartidor).trim() : '';
      let invoiceText = '🏍️ *BROTHERS DELIVERY*\n';
      if (nombreRep) invoiceText += `Repartidor: ${nombreRep}\n`;
      invoiceText += '\n*Productos*\n';

      products.forEach(product => {
          invoiceHTML += `<tr><td>${escHtml(product.name)}</td><td>C$ ${product.price.toFixed(2)}</td></tr>`;
          invoiceText += `• ${product.name} — C$ ${product.price.toFixed(2)}\n`;
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
      invoiceHTML += `<div class="invoice-track"><b>📍 Paso importante: abra el enlace</b>Es vital que lo abra y comparta su ubicación en tiempo real para que su repartidor sepa dónde está y su pedido llegue más rápido.<div class="lnk">${escHtml(link)}</div></div>`;
      invoiceHTML += '<div class="invoice-footer">¡Vuelve a pedir con nosotros cuando quieras! 🚀 Siempre listos para ayudarte 🙌</div>';

      // El delivery del mensaje incluye mandado extra y prioridad (si hay) para que la suma siempre cuadre con el total final
      const deliveryMensaje = r2(totalDelivery + prioridad);
      invoiceText += '\n━━━━━━━━━━━━━━\n';
      invoiceText += `Productos: C$ ${subtotal.toFixed(2)}\n`;
      invoiceText += `Delivery: C$ ${deliveryMensaje.toFixed(2)}\n`;
      invoiceText += `*TOTAL: C$ ${grandTotal.toFixed(2)}*\n`;
      invoiceText += '━━━━━━━━━━━━━━\n\n';
      invoiceText += leyendaEnlace(link);

      document.getElementById('generatedInvoiceDisplay').innerHTML = invoiceHTML;

      facturaActual = {
          token, pedido: pickupCode, cliente: customerName, tel: '', texto: invoiceText, total: totalBase, totalFinal: grandTotal, delivery: totalDelivery, link,
          // Desglose que ve el cliente en su enlace de rastreo (repartidor.js lo guarda en pedidos/{token}/detalle)
          productos: products.map((p) => ({ nombre: String(p.name), precio: Number(p.price) || 0 })),
          subtotal: subtotal, deliveryBase: deliveryPrice, mandadoExtra: extraErrand,
          prioridad, deposito: depositPaid, deSistema: enPedido, enviada: false
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
      window.open(url, '_system');
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

  document.getElementById('invoicePopup').addEventListener('click', function(e) {
      if (e.target === this) {
          closePopup();
      }
  });

  document.getElementById('depositPromptPopup').addEventListener('click', function(e) {
      if (e.target === this) {
          this.classList.remove('show');
      }
  });

  toggleExtraErrand(0);
  calculateTotal();
  checkAndResetStats();
  checkSessionAndLogin();
  renderDepositInvoices();

Object.assign(window, { showCustomAlert, closeCustomAlert, closeCustomConfirm, confirmDeposit, showStats, hideStats, calculateTotal, toggleExtraErrand, addProductToList, editProduct, deleteProduct, clearDepositInvoices, resetStats, calculateIVA, promptGenerateInvoice, downloadInvoiceImage, closePopup, enviarFacturaWhatsApp, alElegirContacto, reintentarEnvioPedido });
})();
