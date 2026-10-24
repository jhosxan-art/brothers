/* ============================================================
   FACTURACIÓN — integrada en la app del repartidor
   Basada en el sistema del ZIP (productos, delivery, mandado extra, depósito, estadísticas).
   Cambios: sin PIN (ya hay login), campo de WhatsApp del cliente, enlace de seguimiento dentro
   de la factura y gancho Factura.alEnviar(...) que usa repartidor.js para activar el seguimiento.
   Va dentro de una función para no chocar con los nombres de repartidor.js.
   ============================================================ */
(function () {
'use strict';
window.Factura = { alEnviar: null, nombreRepartidor: '' };

  let products = [];
  let editingIndex = -1;
  let extraErrand = 0;
  let depositPaid = false;
  let pendingDeleteIndex = -1;

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
                  <div class="name">${escHtml(product.name)}</div>
                  <div class="price">C$ ${product.price.toFixed(2)}</div>
              </div>
              <div class="product-actions">
                  <button class="edit-btn" onclick="editProduct(${index})">Editar</button>
                  <button class="delete-btn" onclick="deleteProduct(${index})">Eliminar</button>
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

      const deliveryPrice = parseFloat(document.getElementById('deliveryPrice').value) || 0;
      const totalDelivery = deliveryPrice + extraErrand;
      const grandTotal = subtotal + totalDelivery;

      document.getElementById('subtotal').textContent = `C$ ${subtotal.toFixed(2)}`;
      document.getElementById('deliveryCost').textContent = `C$ ${totalDelivery.toFixed(2)}`;
      document.getElementById('grandTotal').textContent = `C$ ${grandTotal.toFixed(2)}`;
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
      const pickupCode = getUniqueCode();
      const token = crearToken();
      const link = `${URL_RASTREO}?id=${token}`;

      let invoiceHTML = '<div class="invoice-header-popup">🏍️ BROTHERS DELIVERY</div>';
      invoiceHTML += '<div class="invoice-divider"></div>';

      if (customerName) {
          invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">👤 CLIENTE: ${escHtml(customerName)}</div>`;
      }

      invoiceHTML += `<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">💳 DEPÓSITO: ${depositPaid ? 'SÍ' : 'NO'}</div>`;

      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<div class="invoice-header-popup" style="font-size: 0.95em; margin-top: 8px;">📦 PRODUCTOS</div>';
      invoiceHTML += '<table class="invoice-products-table">';

      let invoiceText = '━━━━━━━━━━━━━━━━━━━━\n';
      invoiceText += '🏍️ *BROTHERS DELIVERY*\n';
      invoiceText += '━━━━━━━━━━━━━━━━━━━━\n\n';
      if (window.Factura && window.Factura.nombreRepartidor) invoiceText += `🏍️ *Repartidor:* ${window.Factura.nombreRepartidor}\n`;
      if (customerName) invoiceText += `👤 *Cliente:* ${customerName}\n`;
      invoiceText += `💳 *Depósito:* ${depositPaid ? 'SÍ' : 'NO'}\n\n`;
      invoiceText += '📦 *PRODUCTOS:*\n';

      products.forEach(product => {
          invoiceHTML += `<tr><td>${escHtml(product.name)}</td><td>C$ ${product.price.toFixed(2)}</td></tr>`;
          invoiceText += `${product.name} → C$ ${product.price.toFixed(2)}\n`;
      });

      invoiceHTML += '</table>';

      const subtotal = parseFloat(document.getElementById('subtotal').textContent.replace('C$ ', ''));
      const deliveryPrice = parseFloat(document.getElementById('deliveryPrice').value) || 0;
      const totalDelivery = deliveryPrice + extraErrand;
      const grandTotal = parseFloat(document.getElementById('grandTotal').textContent.replace('C$ ', ''));

      invoiceHTML += '<div class="invoice-divider"></div>';
      invoiceHTML += '<table class="invoice-totals-table">';
      invoiceHTML += `<tr><td>Subtotal:</td><td>C$ ${subtotal.toFixed(2)}</td></tr>`;

      if (extraErrand > 0) {
          invoiceHTML += `<tr><td>Delivery (C$ ${deliveryPrice.toFixed(2)} + Mandado Extra C$ ${extraErrand.toFixed(2)}):</td><td>C$ ${totalDelivery.toFixed(2)}</td></tr>`;
      } else {
          invoiceHTML += `<tr><td>Delivery:</td><td>C$ ${totalDelivery.toFixed(2)}</td></tr>`;
      }

      invoiceHTML += `<tr class="total-row"><td>TOTAL:</td><td>C$ ${grandTotal.toFixed(2)}</td></tr>`;
      invoiceHTML += '</table>';
      invoiceHTML += `<div style="text-align:center; font-weight:700; color:var(--red); margin-top:10px; font-size:1em;">CÓDIGO DE RETIRO: ${pickupCode}</div>`;
      invoiceHTML += `<div class="invoice-track"><b>📍 Seguimiento en tiempo real</b>Toca el enlace y verás la ubicación de tu paquete en tiempo real.<div class="lnk">${escHtml(link)}</div></div>`;
      invoiceHTML += '<div class="invoice-footer">¡Vuelve a pedir con nosotros cuando quieras! 🚀 Siempre listos para ayudarte 🙌</div>';

      invoiceText += '\n━━━━━━━━━━━━━━━━━━━━\n';
      invoiceText += `*Subtotal:* C$ ${subtotal.toFixed(2)}\n`;

      if (extraErrand > 0) {
          invoiceText += `*Delivery:* C$ ${deliveryPrice.toFixed(2)}\n`;
          invoiceText += `*Mandado Extra:* C$ ${extraErrand.toFixed(2)}\n`;
          invoiceText += `*Total Delivery:* C$ ${totalDelivery.toFixed(2)}\n`;
      } else {
          invoiceText += `*Delivery:* C$ ${totalDelivery.toFixed(2)}\n`;
      }

      invoiceText += '━━━━━━━━━━━━━━━━━━━━\n';
      invoiceText += `*TOTAL:* C$ ${grandTotal.toFixed(2)}\n`;
      invoiceText += `*CÓDIGO DE RETIRO:* *${pickupCode}*\n`;
      invoiceText += '━━━━━━━━━━━━━━━━━━━━\n\n';
      invoiceText += '📍 *Sigue tu paquete en tiempo real:*\n';
      invoiceText += `${link}\n`;
      invoiceText += '👆 Toca el enlace y verás la ubicación de tu paquete en tiempo real en el mapa.\n\n';
      invoiceText += '¡Vuelve a pedir con nosotros cuando quieras! 🚀 Siempre listos para ayudarte 🙌';

      document.getElementById('generatedInvoiceDisplay').innerHTML = invoiceHTML;

      facturaActual = { token, pedido: pickupCode, cliente: customerName, tel: '', texto: invoiceText, total: grandTotal, link };

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

      document.getElementById('invoicePopup').classList.add('show');
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

  function closePopup() {
      document.getElementById('invoicePopup').classList.remove('show');
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

Object.assign(window, { showCustomAlert, closeCustomAlert, closeCustomConfirm, confirmDeposit, showStats, hideStats, calculateTotal, toggleExtraErrand, addProductToList, editProduct, deleteProduct, clearDepositInvoices, resetStats, calculateIVA, promptGenerateInvoice, downloadInvoiceImage, closePopup, enviarFacturaWhatsApp });
})();
