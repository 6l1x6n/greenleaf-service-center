(function () {
  'use strict';

  var products = [];
  var stores = [];
  var state = { payment: 'kaspi', partnerMode: false, storeId: null, showHiddenItems: false };

  var itemsEl = document.getElementById('cartItems');
  var viewEl = document.getElementById('cartView');
  var emptyEl = document.getElementById('cartEmpty');
  var successEl = document.getElementById('cartSuccess');
  var summaryEl = document.querySelector('.cart-summary');
  var orderForm = document.getElementById('orderForm');
  var clearBtn = document.getElementById('cartClearBtn');

  var SELECTED_KEY = 'greenleaf_sc_selected_v1';

  // ---- Бронь товаров (5 минут, как места в кинотеатре) ----
  var RESERVE_TTL = 300;
  var RESERVE_KEY = 'greenleaf_order_reservation_v1';
  var reserve = { orderId: '', expiresAt: 0, interval: null, signature: '', expired: false };
  var kaspiPaid = false;
  var paymentStarted = false;
  var submitBtn = document.getElementById('orderSubmitBtn');
  var reserveTimerEl = document.getElementById('reserveTimer');

  function orderId() {
    if (!reserve.orderId) {
      try { reserve.orderId = sessionStorage.getItem(RESERVE_KEY) || ''; } catch (e) { }
      if (!reserve.orderId) {
        // Короткий номер заказа GL-XXXXXX (без похожих символов 0/O, 1/I/L)
        var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        var code = '';
        for (var i = 0; i < 6; i++) {
          code += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
        }
        reserve.orderId = 'GL-' + code;
        try { sessionStorage.setItem(RESERVE_KEY, reserve.orderId); } catch (e) { }
      }
    }
    return reserve.orderId;
  }

  // Токен устройства для «Моих заказов»: привязывает заказы к этому браузеру
  function clientToken() {
    if (window.Utils && Utils.clientToken) return Utils.clientToken();
    try {
      var t = localStorage.getItem('greenleaf_client_token_v1');
      if (!t) {
        t = 'ct_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
        localStorage.setItem('greenleaf_client_token_v1', t);
      }
      return t;
    } catch (e) { return ''; }
  }

  function availableCount(l) {
    if (!state.storeId) return null;
    return StoreStock.count(state.storeId, l.p.id);
  }

  function lineQtyValid(l) {
    var max = availableCount(l);
    return max === null || l.qty <= max;
  }

  // Дата сегодня в формате YYYY-MM-DD (местное время)
  function dateStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function hideTimer() {
    if (reserveTimerEl) reserveTimerEl.classList.add('hidden');
    if (reserve.interval) { clearInterval(reserve.interval); reserve.interval = null; }
  }

  // Истечение 5 минут: бронь снята, оплата на сайте технически невозможна,
  // нужно собрать корзину заново (как места в кинотеатре).
  function expiredState() {
    reserve.expired = true;
    reserve.expiresAt = 0;
    if (reserve.interval) { clearInterval(reserve.interval); reserve.interval = null; }
    if (reserveTimerEl) {
      reserveTimerEl.innerHTML = '⏳ Время истекло — товары снова доступны другим покупателям, оформить заказ нельзя.<br>' +
        '<button class="btn btn-outline btn-sm" type="button" data-cart-rebuild="1" style="margin-top:8px;">🔄 Собрать корзину заново</button>';
      reserveTimerEl.classList.remove('hidden');
    }
    updateSubmitGate();
  }

  function startTimer() {
    if (!reserveTimerEl) return;
    reserveTimerEl.classList.remove('hidden');
    if (reserve.interval) clearInterval(reserve.interval);
    function tick() {
      var left = reserve.expiresAt - Date.now();
      if (left <= 0) {
        expiredState();
        return;
      }
      var s = Math.ceil(left / 1000);
      var mm = Math.floor(s / 60);
      var ss = s % 60;
      reserveTimerEl.innerHTML = '⏳ Товары зарезервированы на <b>' + mm + ':' + (ss < 10 ? '0' : '') + ss + '</b> — успейте оплатить заказ, иначе бронь снимется и товар снова станет доступен другим покупателям.';
    }
    tick();
    reserve.interval = setInterval(tick, 1000);
  }

  var reserveDebounceTimer = null;

  // Дебаунс: серии кликов «+/−» и других изменений корзины схлопываются
  // в одну запись брони (экономия KV-записей на сервере)
  function scheduleReserve() {
    if (window.__stockReserveOff) return;
    if (reserveDebounceTimer) clearTimeout(reserveDebounceTimer);
    reserveDebounceTimer = setTimeout(doReserve, 800);
  }

  function doReserve() {
    reserveDebounceTimer = null;
    var t = totals();
    if (!state.storeId || !t.lines.length) {
      reserve.expired = false;
      reserve.signature = '';
      if (!state.storeId && t.lines.length && reserveTimerEl) {
        reserveTimerEl.innerHTML = '🛒 Выберите Сервис-Центр в каталоге, чтобы зарезервировать товары.';
        reserveTimerEl.classList.remove('hidden');
      } else {
        hideTimer();
      }
      return;
    }
    var signature = state.storeId + '|' + t.lines.map(function (l) { return l.p.id + ':' + l.qty; }).join(',');
    if (signature === reserve.signature && reserve.expiresAt > Date.now()) return;
    // После истечения бронь не продлевается сама собой — только при изменении корзины
    if (reserve.expired && signature === reserve.signature) return;
    reserve.expired = false;
    reserve.signature = signature;
    setField('orderId', orderId());
    setField('orderStoreId', state.storeId);
    fetch('/api/reserve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: orderId(),
        storeId: state.storeId,
        items: t.lines.map(function (l) { return { productId: l.p.id, qty: l.qty }; }),
        ttlSeconds: RESERVE_TTL
      })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) {
        if (d && d.error === 'closed' && window.Utils) {
          Utils.showToast('⏰ ' + (d.message || 'Филиал сейчас закрыт — оформить можно в рабочее время'));
          expiredState();
          return;
        }
        if (d && d.error === 'not enough' && window.Utils) {
          var pid = d.product && d.product.productId;
          var p = products.find(function (x) { return x.id === pid; });
          var name = p ? p.name : (pid || 'товар');
          Utils.showToast('⚠️ «' + name + '» сейчас зарезервирован другим покупателем — измените количество');
        }
        expiredState();
        return;
      }
      reserve.expiresAt = Number(d.expiresAt) || 0;
      // Ответ пришёл, но срок брони уже прошёл — перебронируем заново
      if (reserve.expiresAt <= Date.now()) {
        reserve.expiresAt = 0;
        retryReserve(500);
        return;
      }
      startTimer();
    }).catch(function () {
      // Ошибка сети: бронь не снимаем, пробуем ещё раз через 3 секунды
      if (reserveTimerEl) {
        reserveTimerEl.innerHTML = '⚠️ Не удалось зарезервировать — проверьте соединение. Повтор через 3 с…';
        reserveTimerEl.classList.remove('hidden');
      }
      retryReserve(3000);
    });
  }

  var reserveRetryTimer = null;
  function retryReserve(delay) {
    if (reserveRetryTimer) clearTimeout(reserveRetryTimer);
    reserveRetryTimer = setTimeout(function () {
      reserveRetryTimer = null;
      scheduleReserve();
    }, delay);
  }

  function updateSubmitGate() {
    if (!submitBtn) return;
    var needPay = state.payment === 'kaspi';
    var ok = !reserve.expired && (!needPay || (paymentStarted && kaspiPaid));
    submitBtn.disabled = !ok;
    var note = document.getElementById('submitGateNote');
    if (note) note.style.display = needPay && !ok ? '' : 'none';
  }

  function partnerModeValid(id) {
    return /^[a-z]{2}\d{8}$/i.test(String(id || '').trim());
  }

  function packageFee(totalQty) {
    return totalQty >= 4 ? 30 : 15;
  }

  // Оверрайды суперадмина (глобальные и по Сервис-Центру) для корзины:
  // цены, скидки и скрытие применяются и при оплате
  function productOverrides() {
    try { return window.__productOverrides || {}; } catch (e) { return {}; }
  }
  function scOverrides() {
    try { return window.__scOverrides || {}; } catch (e) { return {}; }
  }
  function scOverrideFor(p) {
    try {
      var all = scOverrides();
      if (state.storeId && all[state.storeId] && all[state.storeId][p.id]) return all[state.storeId][p.id];
    } catch (e) { }
    return {};
  }
  function effectivePrice(p) {
    var g = productOverrides()[p.id] || {};
    var so = scOverrideFor(p);
    var price = so.price != null ? so.price : (g.price != null ? g.price : p.price);
    var disc = so.discount_price != null ? so.discount_price : (g.discount_price != null ? g.discount_price : p.discount_price);
    return { price: price, discount: disc };
  }

  function unitPrice(p) {
    var ep = effectivePrice(p);
    if (state.partnerMode) {
      return p.partner_price != null ? p.partner_price : Math.round(ep.price / 2);
    }
    // Скидочная цена, если включена и реально ниже обычной
    if (ep.discount != null && ep.discount > 0 && ep.discount < ep.price) return ep.discount;
    return ep.price;
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

  // Филиалы, где есть данные об остатках и есть хотя бы один товар из корзины
  function candidateStores() {
    var lines = cartLines();
    var good = {};
    stores.forEach(function (s) {
      if (!StoreStock.hasData(s.id)) return;
      if (lines.some(function (l) { return StoreStock.available(l.p, s.id); })) {
        good[s.id] = true;
      }
    });
    return stores.filter(function (s) { return good[s.id]; });
  }

  function lineAvailable(l) {
    if (!state.storeId) return true;
    return StoreStock.available(l.p, state.storeId);
  }

  function savedStore() {
    try {
      return JSON.parse(localStorage.getItem(SELECTED_KEY) || 'null');
    } catch (e) { return null; }
  }

  function selectedStoreObj() {
    return stores.find(function (s) { return s.id === state.storeId; }) || null;
  }

  function syncStoreSelection() {
    var cands = candidateStores();
    if (!cands.length) {
      var saved = savedStore();
      state.storeId = (saved && saved.id) || null;
      return;
    }
    if (!state.storeId || !cands.some(function (s) { return s.id === state.storeId; })) {
      var saved = savedStore();
      state.storeId = (saved && cands.some(function (s) { return s.id === saved.id; }))
        ? saved.id
        : cands[0].id;
    }
  }

  function totals() {
    var all = cartLines();
    syncStoreSelection();
    var lines = all.filter(lineAvailable);
    var hidden = all.length - lines.length;
    var qtyTotal = lines.reduce(function (s, l) { return s + l.qty; }, 0);
    var goodsTotal = lines.reduce(function (s, l) { return s + l.total; }, 0);
    var pkg = lines.length ? packageFee(qtyTotal) : 0;
    return { lines: lines, all: all, hidden: hidden, qtyTotal: qtyTotal, goodsTotal: goodsTotal, pkg: pkg, total: goodsTotal + pkg };
  }

  function setField(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  function itemHtml(l, unavailable) {
    return '<div class="cart-item' + (unavailable ? ' cart-item-unavailable' : '') + '">' +
      '<button class="cart-item-x" data-cart-remove="' + Utils.esc(l.p.id) + '" aria-label="Удалить из корзины">' + Utils.iconX(13) + '</button>' +
      '<div class="cart-item-media"><img src="' + Utils.esc(Utils.img(l.p.image || 'assets/images/products/placeholder.svg')) + '" onerror="this.src=\'assets/images/products/placeholder.svg\'" alt=""></div>' +
      '<div class="cart-item-body">' +
      '<div class="cart-item-name">' + Utils.esc(l.p.name) + '</div>' +
      '<div class="cart-item-sku">Артикул: ' + Utils.esc(l.p.sku) + '</div>' +
      '<div class="cart-item-price">' + Utils.fmtPrice(l.price) + (state.partnerMode ? ' <span class="badge-sale">-50%</span>' : '') + '</div>' +
      (unavailable ? '<div class="cart-item-unavailable-note">Нет в выбранном филиале — не войдёт в заказ</div>' : '') +
      '</div>' +
      '<div class="cart-item-ctrl">' +
      '<div class="qty-stepper">' +
      '<button class="qty-btn" data-cart-dec="' + Utils.esc(l.p.id) + '" aria-label="Уменьшить">−</button>' +
      '<input type="number" class="qty-input" data-cart-qty="' + Utils.esc(l.p.id) + '" min="1" max="' + (function () { var m = availableCount(l); return m === null ? 999 : m; }()) + '" value="' + l.qty + '" aria-label="Количество">' +
      '<button class="qty-btn" data-cart-inc="' + Utils.esc(l.p.id) + '" aria-label="Увеличить">+</button>' +
      '</div>' +
      '<button class="cart-item-trash" data-cart-remove="' + Utils.esc(l.p.id) + '" aria-label="Убрать из корзины">' + Utils.iconTrash(15) + '</button>' +
      '</div>' +
      '<div class="cart-item-total">' + (unavailable ? '<span style="color:var(--muted);">—</span>' : Utils.fmtPrice(l.total)) + '</div>' +
      '</div>';
  }

  function renderStoreSelect() {
    var el = document.getElementById('cartStoreSelect');
    if (!el) return;
    var cands = candidateStores();
    if (!cands.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML =
      '<div class="cart-store-select-title">🏬 Филиал, где заберёте заказ</div>' +
      '<div class="cart-store-list">' +
      cands.map(function (s) {
        var checked = s.id === state.storeId;
        return '<label class="cart-store-opt' + (checked ? ' checked' : '') + '">' +
          '<input type="radio" name="cart-store" value="' + Utils.esc(s.id) + '"' + (checked ? ' checked' : '') + '>' +
          '<span class="cart-store-name">' + Utils.esc(s.name) + '</span>' +
          '</label>';
      }).join('') +
      '</div>';
  }

  // Методы оплаты выбранного СЦ (по умолчанию Kaspi + наличные)
  function paymentMethods() {
    var st = selectedStoreObj();
    var m = st && Array.isArray(st.payment_methods) && st.payment_methods.length
      ? st.payment_methods
      : ['kaspi', 'cash'];
    return m;
  }

  // Обновляет доступность вкладок оплаты: отключённый у СЦ метод — неактивен,
  // при наведении показывается подсказка; метод автопереключается на доступный
  function updatePayTabs() {
    var m = paymentMethods();
    var hasKaspi = m.indexOf('kaspi') !== -1;
    var hasCash = m.indexOf('cash') !== -1;
    var st = selectedStoreObj();
    var name = st ? st.name : '';
    var tip = 'Данный метод оплаты у СЦ «' + name + '» временно недоступен';
    var kaspiWrap = document.getElementById('payTabKaspi');
    var cashWrap = document.getElementById('payTabCash');
    var kaspiBtn = kaspiWrap ? kaspiWrap.querySelector('.pay-tab') : null;
    var cashBtn = cashWrap ? cashWrap.querySelector('.pay-tab') : null;
    if (kaspiBtn) kaspiBtn.disabled = !hasKaspi;
    if (cashBtn) cashBtn.disabled = !hasCash;
    if (kaspiWrap) {
      if (hasKaspi) kaspiWrap.removeAttribute('data-tip');
      else kaspiWrap.setAttribute('data-tip', tip);
    }
    if (cashWrap) {
      if (hasCash) cashWrap.removeAttribute('data-tip');
      else cashWrap.setAttribute('data-tip', tip);
    }
    if (!hasKaspi && state.payment === 'kaspi') setPayment('cash');
    else if (!hasCash && state.payment === 'cash') setPayment('kaspi');
  }

  function render() {
    var t = totals();

    if (!t.all.length) {
      emptyEl.classList.remove('hidden');
      viewEl.classList.add('hidden');
      successEl.classList.add('hidden');
      return;
    }
    emptyEl.classList.add('hidden');
    successEl.classList.add('hidden');
    viewEl.classList.remove('hidden');

    renderStoreSelect();
    updatePayTabs();

    var storeObj = selectedStoreObj();
    var saved = savedStore();
    var showUnavailable = state.showHiddenItems && t.hidden > 0;
    var displayLines = showUnavailable ? t.all : t.lines;

    var hideNote = '';
    if (t.hidden > 0) {
      var storeName = storeObj ? Utils.esc(storeObj.name) : 'выбранный филиал';
      hideNote = showUnavailable
        ? '<div class="cart-hide-note">Эти позиции недоступны в филиале <b>' + storeName + '</b> — они не войдут в заказ. <button class="btn btn-outline btn-sm" data-cart-hide-hidden="1">Скрыть</button></div>'
        : '<div class="cart-hide-note">Скрыто <b>' + t.hidden + ' ' + (t.hidden === 1 ? 'позиция' : (t.hidden >= 2 && t.hidden <= 4 ? 'позиции' : 'позиций')) + '</b> — их нет в филиале <b>' + storeName + '</b>. <button class="btn btn-outline btn-sm" data-cart-show-hidden="1">Показать</button></div>';
    }

    itemsEl.innerHTML = hideNote + displayLines.map(function (l) {
      return itemHtml(l, showUnavailable && !lineAvailable(l));
    }).join('');

    summaryEl.querySelector('.sum-goods').textContent = Utils.fmtPrice(t.goodsTotal);
    summaryEl.querySelector('.sum-package').textContent = Utils.fmtPrice(t.pkg);
    summaryEl.querySelector('.sum-qty').textContent = t.qtyTotal;
    summaryEl.querySelectorAll('.sum-total').forEach(function (el) {
      el.textContent = Utils.fmtPrice(t.total);
      el.setAttribute('data-total', t.total);
    });

    var orderStoreTxt = 'Не выбран';
    var pickupTxt = '🏬 Получение уточните у менеджера — подскажем ближайший Сервис-Центр.';
    if (storeObj) {
      orderStoreTxt = storeObj.name;
      pickupTxt = '🏬 Получение: ' + storeObj.name + (storeObj.address ? ' — ' + storeObj.address : '');
    } else if (saved && saved.name) {
      orderStoreTxt = saved.name;
      pickupTxt = '🏬 Получение: ' + saved.name + (saved.address ? ' — ' + saved.address : '') + ' — проверим наличие в этом филиале.';
    }
    var pickupEl = document.getElementById('cartPickup');
    if (pickupEl) pickupEl.textContent = pickupTxt;
    setField('orderStore', orderStoreTxt);

    var orderItemsTxt = t.lines.map(function (l) {
      return l.p.name + ' (' + l.p.sku + ') × ' + l.qty + ' = ' + Utils.fmtPrice(l.total);
    }).join('\n');
    if (t.hidden > 0) {
      var hiddenNames = t.all.filter(function (l) { return !lineAvailable(l); })
        .map(function (l) { return l.p.name + ' (' + l.p.sku + ')'; });
      orderItemsTxt += '\n—\nНе вошло в заказ (нет в филиале): ' + hiddenNames.join(', ');
    }
    setField('orderItems', orderItemsTxt);
    setField('orderTotal', t.total);
    setField('orderPackage', t.pkg);
    setField('orderQtyTotal', t.qtyTotal);
    setField('orderPartnerMode', state.partnerMode ? '1' : '0');
  }

  function pickupDateLabel(d) {
    var ast = astanaNow();
    var base = new Date(ast.date + 'T00:00:00');
    var diff = Math.round((d.getTime() - base.getTime()) / 86400000);
    if (diff === 0) return 'Сегодня, ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    if (diff === 1) return 'Завтра, ' + d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    return d.toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
  }

  function storeSchedule() {
    var st = stores.find(function (s) { return s.id === state.storeId; });
    if (st && st.schedule && typeof st.schedule === 'object' && st.schedule.mon !== undefined) return st.schedule;
    // Расписания нет — пробуем распарсить текстовые часы («Пн–Вс 10:00 – 20:00»)
    if (st && window.Utils && Utils.scheduleDefault) {
      var parsed = Utils.scheduleDefault(st);
      if (parsed && parsed.mon) return parsed;
    }
    return null;
  }

  function dayKeyOf(d) {
    return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
  }

  function slotMinutes(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(t || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  }

  // «Сейчас» в часовом поясе Астаны (UTC+5): расписание филиалов задаётся в этом времени.
  // Без пересчёта ночь по Астане была бы «вчера» по местному времени посетителя.
  function astanaNow() {
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Almaty', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }).formatToParts(new Date());
    var get = function (t) { var p = parts.find(function (x) { return x.type === t; }); return p ? Number(p.value) : 0; };
    var y = get('year'), mo = get('month'), d = get('day');
    return {
      date: y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
      minutes: get('hour') * 60 + get('minute'),
      dayKey: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(y, mo - 1, d).getDay()]
    };
  }

  // Ближайший рабочий слот выдачи: следующий рабочий день + время открытия
  function nextPickupSlot() {
    var sch = storeSchedule();
    if (!sch) return null;
    var ast = astanaNow();
    var d = new Date(ast.date + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    for (var i = 0; i < 9; i++) {
      var s = sch[dayKeyOf(d)];
      if (s && s.open) return { date: new Date(d.getFullYear(), d.getMonth(), d.getDate()), open: s.open };
      d.setDate(d.getDate() + 1);
    }
    return null;
  }

  function pickupHintText() {
    var sch = storeSchedule();
    if (!sch) return '';
    var ast = astanaNow();
    var slot = sch[ast.dayKey];
    var curMin = ast.minutes;
    var workingNow = slot && curMin >= slotMinutes(slot.open) && curMin <= slotMinutes(slot.close) - 30;
    var slot2 = nextPickupSlot();
    if (!slot2) return '';
    var dateLabel = pickupDateLabel(slot2.date);
    return '⏰ ' + (workingNow ? 'Оплатите сейчас — товар будет готов к выдаче ' : 'Сейчас филиал не работает — ближайшая выдача ') +
      dateLabel + ' к ' + slot2.open;
  }

  function initPickupSelectors() {
    var date = document.getElementById('pickupDate');
    var time = document.getElementById('pickupTime');
    var hint = document.getElementById('pickupHint');
    if (!date || !time) return;
    var sch = storeSchedule();
    var opts = [];
    var ast = astanaNow();
    var base = new Date(ast.date + 'T00:00:00');
    var picked = 0;
    for (var i = 0; picked < 7 && i < 14; i++) {
      var d = new Date(base.getTime() + i * 86400000);
      var dayS = sch ? sch[dayKeyOf(d)] : null;
      if (sch && !dayS) continue; // выходной — пропускаем
      // Сегодня недоступно, если филиал уже закрыт или до закрытия менее 30 минут
      if (i === 0 && dayS) {
        var closeM = slotMinutes(dayS.close);
        if (closeM < 0 || ast.minutes >= closeM - 30) continue;
      }
      var iso = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      opts.push('<option value="' + iso + '">' + pickupDateLabel(d) + '</option>');
      picked++;
    }
    date.innerHTML = opts.join('');
    function buildTimes() {
      var minMin = 9 * 60;
      var maxMin = 19 * 60 + 30;
      var excludeEnd = false;
      if (sch) {
        var slot = sch[dayKeyOf(new Date(date.value + 'T00:00:00'))];
        if (slot) {
          var oM = slotMinutes(slot.open);
          var cM = slotMinutes(slot.close);
          if (oM >= 0) minMin = oM;
          if (cM > 0) { maxMin = Math.min(cM, 21 * 60); excludeEnd = true; }
        }
      }
      var aNow = astanaNow();
      if (date.value === aNow.date) minMin = Math.max(minMin, aNow.minutes + 30);
      var out = [];
      // Время закрытия не предлагаем: сервер принимает только pM < close
      for (var m = minMin; (excludeEnd ? m < maxMin : m <= maxMin); m += 30) {
        var hh = String(Math.floor(m / 60)).padStart(2, '0');
        var mm = String(m % 60).padStart(2, '0');
        out.push('<option value="' + hh + ':' + mm + '">' + hh + ':' + mm + '</option>');
      }
      time.innerHTML = out.length ? out.join('') : '<option value="">Нет доступного времени</option>';
    }
    date.addEventListener('change', buildTimes);
    buildTimes();
    if (hint) hint.textContent = pickupHintText();
  }

  function setPayment(method) {
    var m = paymentMethods();
    if (method === 'kaspi' && m.indexOf('kaspi') === -1) return;
    if (method === 'cash' && m.indexOf('cash') === -1) return;
    state.payment = method;
    setField('orderPayment', method === 'cash' ? 'Наличные при получении' : 'Kaspi');
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
    if (method === 'cash') {
      kaspiPaid = false;
      paymentStarted = false;
      var paidWrap = document.getElementById('kaspiPaidWrap');
      if (paidWrap) paidWrap.classList.add('hidden');
      var paidEl = document.getElementById('kaspiPaid');
      if (paidEl) paidEl.checked = false;
    }
    updateSubmitGate();
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
    var rebuild = e.target.closest('[data-cart-rebuild]');
    if (rebuild) {
      Cart.clear();
      Utils.showToast('🛒 Корзина очищена — соберите заново');
      return;
    }
    var payTab = e.target.closest('[data-pay]');
    if (payTab && !payTab.disabled) {
      setPayment(payTab.getAttribute('data-pay'));
      return;
    }
    if (e.target.closest('#kaspiPayBtn')) {
      if (!contactFieldsOk() || !cashFieldsOk()) return;
      var qr = kaspiQr();
      if (qr) {
        copyTotal();
        payWithQr(Number(summaryEl.querySelector('.sum-total').getAttribute('data-total')) || 0);
      } else {
        copyTotal();
        var win = window.open('https://kaspi.kz', '_blank', 'noopener');
        if (!win) Utils.showToast('Откройте приложение Kaspi и вставьте сумму');
      }
      paymentStarted = true;
      var paidWrap = document.getElementById('kaspiPaidWrap');
      if (paidWrap) paidWrap.classList.remove('hidden');
      updateSubmitGate();
      return;
    }
    var storeOpt = e.target.closest('[name="cart-store"]');
    if (storeOpt) {
      state.storeId = storeOpt.value;
      state.showHiddenItems = false;
      var so = stores.find(function (s) { return s.id === state.storeId; });
      if (so) {
        try {
          localStorage.setItem(SELECTED_KEY, JSON.stringify({ id: so.id, name: so.name, address: so.address || '' }));
        } catch (err) { }
      }
      render();
      initPickupSelectors();
      scheduleReserve();
      return;
    }
    var showHidden = e.target.closest('[data-cart-show-hidden]');
    if (showHidden) { state.showHiddenItems = true; render(); return; }
    var hideHidden = e.target.closest('[data-cart-hide-hidden]');
    if (hideHidden) { state.showHiddenItems = false; render(); return; }
    var add = e.target.closest('[data-cart-add]');
    if (add) {
      var addId = add.getAttribute('data-cart-add');
      var addMax = state.storeId ? StoreStock.count(state.storeId, addId) : null;
      var addCur = 0;
      var addItem = Cart.get().find(function (i) { return i.id === addId; });
      if (addItem) addCur = Number(addItem.qty) || 0;
      if (addMax !== null && addCur >= addMax) {
        Utils.showToast('⚠️ В филиале доступно только ' + addMax + ' шт.');
        return;
      }
      Cart.add(addId, 1);
      return;
    }
    var inc = e.target.closest('[data-cart-inc]');
    if (inc) {
      var incId = inc.getAttribute('data-cart-inc');
      var incMax = state.storeId ? StoreStock.count(state.storeId, incId) : null;
      var incItem = Cart.get().find(function (i) { return i.id === incId; });
      var incCur = incItem ? (Number(incItem.qty) || 1) : 1;
      if (incMax !== null && incCur >= incMax) {
        Utils.showToast('⚠️ В филиале доступно только ' + incMax + ' шт.');
        return;
      }
      Cart.add(incId, 1);
      return;
    }
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

  // Ручной ввод количества — клампинг по остатку (после глобального обработчика cart.js)
  document.addEventListener('change', function (e) {
    var inp = e.target.closest('[data-cart-qty]');
    if (!inp) return;
    var id = inp.getAttribute('data-cart-qty');
    var qty = parseInt(inp.value, 10);
    if (isNaN(qty) || qty < 1) return;
    var max = state.storeId ? StoreStock.count(state.storeId, id) : null;
    if (max !== null && qty > max) {
      Utils.showToast('⚠️ В филиале доступно только ' + max + ' шт. — количество уменьшено');
      Cart.setQty(id, max);
    }
  });

  var kaspiPaidEl = document.getElementById('kaspiPaid');
  if (kaspiPaidEl) {
    kaspiPaidEl.addEventListener('change', function () {
      kaspiPaid = kaspiPaidEl.checked;
      updateSubmitGate();
    });
  }

  // Валидация перед отправкой (forms.js уже проверит defaultPrevented)
  if (orderForm) {
    orderForm.addEventListener('submit', function (e) {
      var t = totals();
      var bad = t.lines.filter(function (l) { return !lineQtyValid(l); });
      if (bad.length) {
        e.preventDefault();
        var l0 = bad[0];
        Utils.showToast('⚠️ «' + l0.p.name + '» — в филиале доступно только ' + availableCount(l0) + ' шт. Уменьшите количество.');
        var inp = document.querySelector('[data-cart-qty="' + l0.p.id + '"]');
        if (inp) blink(inp);
        return;
      }
      if (state.payment === 'kaspi' && !(paymentStarted && kaspiPaid)) {
        e.preventDefault();
        Utils.showToast('⚠️ Сначала оплатите через Kaspi и отметьте «Я оплатил(а) заказ»');
        var payBtn = document.getElementById('kaspiPayBtn');
        if (payBtn) blink(payBtn);
        return;
      }
      // Дата и время приезда (для самовывоза): только рабочие часы филиала,
      // дата не раньше сегодня, время — не раньше чем через 30 минут (по Астане)
      var pDate = orderForm.pickup_date ? orderForm.pickup_date.value : '';
      var pTime = orderForm.pickup_time ? orderForm.pickup_time.value : '';
      if (pDate) {
        var ast = astanaNow();
        var todayS = ast.date;
        if (pDate < todayS) {
          e.preventDefault();
          Utils.showToast('⚠️ Дата приезда не может быть раньше сегодняшнего дня');
          var dateInp = orderForm.pickup_date;
          if (dateInp) blink(dateInp);
          return;
        }
        // День должен быть рабочим (если у филиала задано расписание)
        var sch = storeSchedule();
        var slot = sch ? sch[dayKeyOf(new Date(pDate + 'T00:00:00'))] : null;
        if (sch && !slot) {
          e.preventDefault();
          Utils.showToast('⚠️ В этот день филиал не работает — выберите другой день');
          if (dateInp) blink(dateInp);
          return;
        }
        if (pDate === todayS && pTime) {
          var hm = /^([0-9]{2}):([0-9]{2})$/.exec(pTime);
          if (hm && (Number(hm[1]) * 60 + Number(hm[2])) < ast.minutes + 30) {
            e.preventDefault();
            Utils.showToast('⚠️ Время приезда уже прошло — выберите время не раньше, чем через 30 минут');
            var timeInp = orderForm.pickup_time;
            if (timeInp) blink(timeInp);
            return;
          }
        }
        // Время — только в рабочем окне филиала
        if (pTime && slot) {
          var hm2 = /^([0-9]{1,2}):([0-9]{2})$/.exec(pTime);
          if (hm2) {
            var pM = Number(hm2[1]) * 60 + Number(hm2[2]);
            var oM = slotMinutes(slot.open);
            var cM = slotMinutes(slot.close);
            if (pM < oM || pM >= cM) {
              e.preventDefault();
              Utils.showToast('⚠️ Выберите время получения в рабочее время филиала (' + slot.open + '–' + slot.close + ')');
              var timeInp2 = orderForm.pickup_time;
              if (timeInp2) blink(timeInp2);
              return;
            }
          }
        }
      }
      setField('orderId', orderId());
      setField('orderStoreId', state.storeId || '');
      var ctInput = document.getElementById('orderClientToken');
      if (ctInput) ctInput.value = clientToken();
      setField('orderItemsJson', JSON.stringify(t.lines.map(function (l) {
        return { productId: l.p.id, sku: l.p.sku, name: l.p.name, qty: l.qty, price: l.price };
      })));
    });
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', function () {
      if (!confirm('Очистить корзину?')) return;
      Cart.clear();
      Utils.showToast('🗑 Корзина очищена');
    });
  }

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

  window.addEventListener('order:sent', function (e) {
    reserve.signature = '';
    reserve.expiresAt = 0;
    reserve.expired = false;
    hideTimer();
    Cart.clear();
    emptyEl.classList.add('hidden');
    viewEl.classList.add('hidden');
    successEl.classList.remove('hidden');

    // Номер заказа (#N из воркера или внутренний id как запасной) + текст по оплате
    var detail = (e && e.detail) || {};
    var orderNumber = detail.orderNumber || '';
    var oid = orderId();
    var displayNumber = orderNumber ? ('#' + orderNumber) : oid;
    var oidEl = document.getElementById('successOrderId');
    if (oidEl) oidEl.textContent = displayNumber;
    var payEl = document.getElementById('successPayText');
    if (payEl) {
      payEl.textContent = state.payment === 'cash'
        ? 'Оплата наличными при получении — ничего предоплачивать не нужно. Менеджер подтвердит заказ и свяжется с вами.'
        : 'Оплату по Kaspi проверим по оповещению. Менеджер подтвердит заказ и свяжется с вами.';
    }
    var copyBtn = document.getElementById('successCopyBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(displayNumber).then(function () { Utils.showToast('Номер заказа скопирован'); });
        }
      });
    }
    var myBtn = document.getElementById('successMyOrdersBtn');
    if (myBtn) {
      myBtn.addEventListener('click', function (ev) {
        ev.preventDefault();
        if (window.Utils) Utils.openMyOrdersModal();
      });
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // Бронь снята на сервере (409) — переводим страницу в заблокированное состояние
  window.addEventListener('order:expired', function () {
    expiredState();
  });

  Cart.onChange(function () {
    Cart.updateBadge();
    render();
    scheduleReserve();
  });

  async function init() {
    try {
      var res = await fetch('data/products.json');
      var data = await res.json();
      products = data.products || [];
      // Версия каталога для URL картинок (?v=) — сброс кэша при обновлении
      window.SITE_VER = data.updated || '';
      // Каталог для модалки «Мои заказы» (названия/фото в чеке) — без доп. запросов
      window.CatalogProducts = products;
      // Серверные оверрайды суперадмина (цены, скидки, скрытие по СЦ) —
      // отдаются вместе с каталогом и применяются и при оплате
      window.__productOverrides = data.overrides || {};
      window.__scOverrides = data.scOverrides || {};
      window.__siteSettings = Object.assign({ showDiscountPrices: true, categories: [] }, data.settings || {});
      if (typeof data.showDiscountPrices === 'boolean') window.__siteSettings.showDiscountPrices = data.showDiscountPrices;
    } catch (e) {
      products = [];
    }
    try {
      var sRes = await fetch('data/stores.json');
      stores = await sRes.json();
    } catch (e) {
      stores = [];
    }
    // СЦ из KV (Worker) — приоритетнее статики; удалённые суперадмином — убираем
    try {
      var apiRes = await fetch('/api/stores');
      var apiData = await apiRes.json();
      var kvStores = (apiData && apiData.stores) || [];
      var deletedIds = (apiData && apiData.deletedIds) || [];
      var byId = {};
      kvStores.forEach(function (s) { byId[s.id] = s; });
      stores = stores.filter(function (s) { return deletedIds.indexOf(s.id) === -1; })
        .map(function (s) { return byId[s.id] ? Object.assign({}, s, byId[s.id]) : s; });
      kvStores.forEach(function (s) {
        if (!stores.some(function (x) { return x.id === s.id; })) stores.push(s);
      });
    } catch (e) { }
    await StoreStock.load();

    var saved = savedStore();
    if (saved && saved.id) state.storeId = saved.id;

    render();
    // Селекторы даты/времени строим ПОСЛЕ выбора филиала (иначе расписание
    // не подхватывается и предлагается общее время 9:00–19:30)
    initPickupSelectors();
    scheduleReserve();
  }

  setPayment('kaspi');
  updatePayTabs();
  orderForm.querySelectorAll('input, select').forEach(function (el) {
    el.addEventListener('input', function () { el.classList.remove('field-blink'); });
    el.addEventListener('change', function () { el.classList.remove('field-blink'); });
  });
  init();
})();
