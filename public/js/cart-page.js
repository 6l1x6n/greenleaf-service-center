(function () {
  'use strict';

  var products = [];
  var state = { payment: 'kaspi', partnerMode: false };

  var itemsEl = document.getElementById('cartItems');
  var viewEl = document.getElementById('cartView');
  var emptyEl = document.getElementById('cartEmpty');
  var successEl = document.getElementById('cartSuccess');
  var summaryEl = document.querySelector('.cart-summary');
  var orderForm = document.getElementById('orderForm');

  function partnerModeValid(id) {
    return /^[a-z]{2}\d{8}$/i.test(String(id || '').trim());
  }

  function packageFee(totalQty) {
    return totalQty >= 4 ? 30 : 15;
  }

  function unitPrice(p) {
    return state.partnerMode
      ? (p.partner_price != null ? p.partner_price : Math.round(p.price / 2))
      : p.price;
  }

  function cartLines() {
    return Cart.get().map(function (i) {
      var p = products.find(function (x) { return x.id === i.id; });
      if (!p) return null;
      var qty = Number(i.qty) || 1;
      var price = unitPrice(p);
      return { p: p, qty: qty, price: price, total: qty * price };
    }).filter(Boolean);
  }

  function totals() {
    var lines = cartLines();
    var qtyTotal = lines.reduce(function (s, l) { return s + l.qty; }, 0);
    var goodsTotal = lines.reduce(function (s, l) { return s + l.total; }, 0);
    var pkg = lines.length ? packageFee(qtyTotal) : 0;
    return { lines: lines, qtyTotal: qtyTotal, goodsTotal: goodsTotal, pkg: pkg, total: goodsTotal + pkg };
  }

  function setField(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  function render() {
    var t = totals();

    if (!t.lines.length) {
      emptyEl.classList.remove('hidden');
      viewEl.classList.add('hidden');
      successEl.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    successEl.classList.add('hidden');
    viewEl.classList.remove('hidden');

    itemsEl.innerHTML = t.lines.map(function (l) {
      return '<div class="cart-item">' +
        '<div class="cart-item-media"><img src="' + Utils.esc(l.p.image || 'assets/images/products/placeholder.svg') + '" onerror="this.src=\'assets/images/products/placeholder.svg\'" alt=""></div>' +
        '<div class="cart-item-body">' +
        '<div class="cart-item-name">' + Utils.esc(l.p.name) + '</div>' +
        '<div class="cart-item-sku">Артикул: ' + Utils.esc(l.p.sku) + '</div>' +
        '<div class="cart-item-price">' + Utils.fmtPrice(l.price) + (state.partnerMode ? ' <span class="badge-sale">-50%</span>' : '') + '</div>' +
        '</div>' +
        '<div class="cart-item-ctrl">' +
        '<div class="qty-stepper">' +
        '<button class="qty-btn" data-cart-dec="' + Utils.esc(l.p.id) + '" aria-label="Уменьшить">−</button>' +
        '<span class="qty-val">' + l.qty + '</span>' +
        '<button class="qty-btn" data-cart-inc="' + Utils.esc(l.p.id) + '" aria-label="Увеличить">+</button>' +
        '</div>' +
        '<button class="btn btn-light-outline btn-sm" data-cart-remove="' + Utils.esc(l.p.id) + '">Удалить</button>' +
        '</div>' +
        '<div class="cart-item-total">' + Utils.fmtPrice(l.total) + '</div>' +
        '</div>';
    }).join('');

    summaryEl.querySelector('.sum-goods').textContent = Utils.fmtPrice(t.goodsTotal);
    summaryEl.querySelector('.sum-package').textContent = Utils.fmtPrice(t.pkg);
    summaryEl.querySelector('.sum-qty').textContent = t.qtyTotal;
    summaryEl.querySelectorAll('.sum-total').forEach(function (el) {
      el.textContent = Utils.fmtPrice(t.total);
      el.setAttribute('data-total', t.total);
    });

    setField('orderItems', t.lines.map(function (l) {
      return l.p.name + ' (' + l.p.sku + ') × ' + l.qty + ' = ' + Utils.fmtPrice(l.total);
    }).join('\n'));
    setField('orderTotal', t.total);
    setField('orderPackage', t.pkg);
    setField('orderQtyTotal', t.qtyTotal);
    setField('orderPartnerMode', state.partnerMode ? '1' : '0');
  }

  function renderPickup() {
    var el = document.getElementById('cartPickup');
    if (!el) return;
    try {
      var saved = JSON.parse(localStorage.getItem('greenleaf_sc_selected_v1') || 'null');
      if (saved && saved.name) {
        el.textContent = '🏬 Получение: ' + saved.name + (saved.address ? ' — ' + saved.address : '');
        setField('orderStore', saved.name);
      } else {
        el.textContent = '🏬 Получение уточните у менеджера — подскажем ближайший Сервис-Центр.';
        setField('orderStore', 'Не выбран');
      }
    } catch (e) { }
  }

  function setPayment(method) {
    state.payment = method;
    document.querySelectorAll('.pay-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-pay') === method);
    });
    document.querySelectorAll('.pay-panel').forEach(function (p) {
      p.classList.toggle('hidden', p.getAttribute('data-pay-panel') !== method);
    });
    document.querySelectorAll('[data-cash-fields]').forEach(function (el) {
      el.classList.toggle('hidden', method !== 'cash');
    });
    var date = document.getElementById('pickupDate');
    var time = document.getElementById('pickupTime');
    if (date) date.required = method === 'cash';
    if (time) time.required = method === 'cash';
  }

  function blink(field) {
    if (!field) return;
    field.classList.add('field-blink');
    setTimeout(function () { field.classList.remove('field-blink'); }, 1600);
  }

  function contactFieldsOk() {
    var name = orderForm.querySelector('input[name="name"]');
    var phone = orderForm.querySelector('input[name="phone"]');
    var ok = true;
    if (!name.value.trim()) { blink(name); ok = false; }
    if (!phone.value.trim()) { blink(phone); ok = false; }
    if (!ok) (name.value.trim() ? phone : name).focus();
    return ok;
  }

  function cashFieldsOk() {
    if (state.payment !== 'cash') return true;
    var date = document.getElementById('pickupDate');
    var time = document.getElementById('pickupTime');
    var ok = true;
    if (!date.value) { blink(date); ok = false; }
    if (!time.value) { blink(time); ok = false; }
    return ok;
  }

  function kaspiQr() {
    var st = Utils.getStore();
    if (st && st.kaspi_qr) return st.kaspi_qr;
    var sel = window.CatalogSelectedStore ? window.CatalogSelectedStore() : null;
    return (sel && sel.kaspi_qr) || '';
  }

  function payWithQr(total) {
    var totalEl = summaryEl.querySelector('.sum-total');
    var totalTxt = Utils.fmtPrice(total);
    Utils.openModal(
      '<h3>💳 Оплата по Kaspi QR</h3>' +
      '<p class="modal-product">Откройте приложение Kaspi.kz → «Сканировать» и наведите на QR-код.</p>' +
      '<div style="text-align:center; margin:14px 0;">' +
      '<img src="' + Utils.esc(kaspiQr()) + '" alt="Kaspi QR" style="width:220px; height:220px; object-fit:contain; border-radius:12px; background:#fff; padding:8px; border:1px solid var(--line);">' +
      '</div>' +
      '<p class="modal-price" style="text-align:center;">К оплате: <b>' + totalTxt + '</b></p>' +
      '<p class="form-note" style="text-align:center;">Сумма скопирована — вставьте её в приложении после сканирования.</p>'
    );
  }

  function copyTotal() {
    var totalEl = summaryEl.querySelector('.sum-total');
    var total = Number(totalEl.getAttribute('data-total')) || 0;
    var text = 'К оплате: ' + Utils.fmtPrice(total);
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          Utils.showToast('Сумма скопирована: ' + Utils.fmtPrice(total));
        });
      } else {
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        Utils.showToast('Сумма скопирована: ' + Utils.fmtPrice(total));
      }
    } catch (e) { }
    return total;
  }

  document.addEventListener('click', function (e) {
    var payTab = e.target.closest('[data-pay]');
    if (payTab) {
      setPayment(payTab.getAttribute('data-pay'));
      return;
    }
    if (e.target.closest('#kaspiPayBtn')) {
      if (!contactFieldsOk() || !cashFieldsOk()) return;
      var qr = kaspiQr();
      if (qr) {
        copyTotal();
        payWithQr(Number(summaryEl.querySelector('.sum-total').getAttribute('data-total')) || 0);
        return;
      }
      copyTotal();
      var win = window.open('https://kaspi.kz', '_blank', 'noopener');
      if (!win) Utils.showToast('Откройте приложение Kaspi и вставьте сумму');
      return;
    }
    var add = e.target.closest('[data-cart-add]');
    if (add) { Cart.add(add.getAttribute('data-cart-add'), 1); return; }
    var inc = e.target.closest('[data-cart-inc]');
    if (inc) { Cart.add(inc.getAttribute('data-cart-inc'), 1); return; }
    var dec = e.target.closest('[data-cart-dec]');
    if (dec) {
      var dId = dec.getAttribute('data-cart-dec');
      var dItem = Cart.get().find(function (i) { return i.id === dId; });
      if (dItem) {
        if ((Number(dItem.qty) || 1) <= 1) Cart.remove(dId);
        else Cart.setQty(dId, (Number(dItem.qty) || 1) - 1);
      }
      return;
    }
    var rm = e.target.closest('[data-cart-remove]');
    if (rm) { Cart.remove(rm.getAttribute('data-cart-remove')); }
  });

  var partnerInput = document.getElementById('partnerId');
  if (partnerInput) {
    partnerInput.addEventListener('input', function () {
      var valid = partnerModeValid(partnerInput.value);
      state.partnerMode = valid;
      setField('orderPartnerId', partnerInput.value.trim());
      var hint = document.getElementById('partnerHint');
      if (hint) {
        hint.textContent = valid
          ? '✅ Подтверждён: применяются партнёрские цены (−50%)'
          : partnerInput.value.trim() ? 'ID партнёра не распознан — цены розничные. Формат: 2 буквы + 8 цифр (ab12345678).' : '';
        hint.className = 'partner-hint' + (valid ? ' ok' : '');
      }
      render();
    });
  }

  window.addEventListener('order:sent', function () {
    Cart.clear();
    emptyEl.classList.add('hidden');
    viewEl.classList.add('hidden');
    successEl.classList.remove('hidden');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  Cart.onChange(function () {
    Cart.updateBadge();
    render();
  });

  async function init() {
    try {
      var res = await fetch('data/products.json?t=' + Date.now());
      var data = await res.json();
      products = data.products || [];
    } catch (e) {
      products = [];
    }
    renderPickup();
    render();
  }

  setPayment('kaspi');
  orderForm.querySelectorAll('input, select').forEach(function (el) {
    el.addEventListener('input', function () { el.classList.remove('field-blink'); });
    el.addEventListener('change', function () { el.classList.remove('field-blink'); });
  });
  init();
})();
