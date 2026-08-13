(function () {
  'use strict';

  var overlay = document.getElementById('modalOverlay');
  var modalBody = document.getElementById('modalBody');
  var modalClose = document.getElementById('modalClose');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  var store = null;

  function openModal(html, wide) {
    modalBody.innerHTML = html;
    var modalEl = overlay.querySelector('.modal');
    if (modalEl) {
      if (wide) {
        modalEl.classList.add('modal-wide');
      } else {
        modalEl.classList.remove('modal-wide');
      }
    }
    overlay.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    var first = modalBody.querySelector('input');
    if (first) first.focus();
  }

  function closeModal() {
    overlay.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.add('hidden');
    }, 4000);
  }

  function waLink(text) {
    if (!store || !store.whatsapp) return '#';
    var url = 'https://wa.me/' + store.whatsapp;
    if (text) url += '?text=' + encodeURIComponent(text);
    return url;
  }

  function fmtPrice(n) {
    return new Intl.NumberFormat('ru-RU').format(n) + ' ₸';
  }

  function fmtDate(iso, opts) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('ru-RU', opts || { day: 'numeric', month: 'long' });
  }

  // Поиск товара по названию позиции (для миниатюр в поставках):
  // точное имя → артикул → вхождение строки → взвешенное совпадение токенов (бренд/тип продукта)
  function productByLabel(products, label) {
    if (!products || !products.length) return null;
    var q = String(label || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[.,;:"'()\[\]«»]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    var i, p;
    for (i = 0; i < products.length; i++) {
      if (String(products[i].name || '').trim().toLowerCase().replace(/ё/g, 'е') === q) return products[i];
    }
    for (i = 0; i < products.length; i++) {
      if (String(products[i].sku || '').toLowerCase() === q) return products[i];
    }
    for (i = 0; i < products.length; i++) {
      if (String(products[i].name || '').toLowerCase().indexOf(q) !== -1) return products[i];
    }
    // Токенный матчинг: «SEALUX Hydra крем» → «Крем-лосьон Sealuxe …»
    var stop = { 'для': 1, 'и': 1, 'в': 1, 'на': 1, 'с': 1, 'со': 1, 'при': 1, 'от': 1, 'из': 1, 'по': 1, 'до': 1, 'не': 1, 'как': 1 };
    function tokens(s) {
      var out = [];
      String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).forEach(function (t) {
        t = t.replace(/ы+$|и$/i, '').replace(/ая$|ое$|ый$|ий$|ой$|ого$|ому$|ым$|ом$|ах$|ях$|ами$|ями$/i, '');
        if (t.length >= 3 && !stop[t]) out.push(t);
      });
      return out;
    }
    var qTok = tokens(q);
    if (!qTok.length) return null;
    var best = null;
    var bestScore = 0;
    for (i = 0; i < products.length; i++) {
      var nameTok = tokens(products[i].name);
      if (!nameTok.length) continue;
      var score = 0;
      qTok.forEach(function (a) {
        nameTok.forEach(function (b) {
          if (a === b || (a.length >= 3 && b.length >= 3 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1))) score++;
        });
      });
      if (score > bestScore) {
        bestScore = score;
        best = products[i];
      }
    }
    // Одиночный специфичный токен («Освежитель») — тоже засчитываем
    if (bestScore >= 2 || (bestScore >= 1 && qTok.length === 1 && qTok[0].length >= 6)) return best;
    return null;
  }

  // Строгий поиск товара для поставок: артикул → точное имя → вхождение строки.
  // Без «угадывания» по токенам: товары могут иметь одинаковые названия,
  // а артикулы всегда уникальны — неверный товар не подставляется.
  function productByArticle(products, label) {
    if (!products || !products.length) return null;
    var q = String(label || '').trim();
    if (!q) return null;
    var ql = q.toLowerCase().replace(/ё/g, 'е');
    var i, p;
    // 1. Артикул (по sku/id) — точное совпадение
    for (i = 0; i < products.length; i++) {
      if (String(products[i].sku || products[i].id || '').toLowerCase() === ql) return products[i];
    }
    // 2. Точное имя
    for (i = 0; i < products.length; i++) {
      if (String(products[i].name || '').trim().toLowerCase().replace(/ё/g, 'е') === ql) return products[i];
    }
    // 3. Вхождение строки в название
    for (i = 0; i < products.length; i++) {
      if (String(products[i].name || '').toLowerCase().indexOf(ql) !== -1) return products[i];
    }
    return null;
  }

  // Миниатюра товара для позиции поставки; наведение — название, клик — модалка товара.
  // exactProduct — товар, уже найденный по артикулу (накладные): используется ТОЛЬКО он,
  // без повторного матчинга по названию. Всегда рисуется картинка (фото или плейсхолдер),
  // при ошибке загрузки фото подменяется плейсхолдером.
  function deliveryItemHtml(products, label, qty, exactProduct) {
    var txt = Utils.esc(String(label == null ? '' : label));
    var p = exactProduct || productByArticle(products, label);
    var dataAttr = '';
    var cls = 'delivery-item';
    var inner;
    if (p) {
      var img = p.thumb || p.image || 'assets/images/products/placeholder.svg';
      cls += ' has-prod';
      dataAttr = ' data-del-open="' + Utils.esc(p.id) + '"';
      inner = '<img class="delivery-item-img" src="' + Utils.esc(img) + '" alt="' + txt + '" loading="lazy" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\'">';
    } else {
      // Товара ещё нет в каталоге — «часики»: фото появится после парсинга
      inner = '<span class="delivery-item-img delivery-item-clock" title="Фото появится, когда товар попадёт в каталог">⏳</span>';
    }
    return '<span class="' + cls + '"' + dataAttr + ' title="' + txt + '" style="cursor:pointer;">' +
      inner +
      (qty ? ' <b class="delivery-item-qty">× ' + Utils.esc(String(qty).replace(/^×\s*/, '')) + '</b>' : '') +
      '</span>';
  }

  // ---------------- «Мои заказы» клиента (без кабинетов) ----------------

  // Единый набор контурных SVG-иконок (стиль интерфейса, без системных эмодзи)
  var SVG_ICONS = {
    box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
    info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    store: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
    money: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    card: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    package: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/>',
    arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
    more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'
  };

  function icon(name, size) {
    return '<svg class="ico" width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (SVG_ICONS[name] || '') + '</svg>';
  }

  var CLIENT_TOKEN_KEY = 'greenleaf_client_token_v1';

  // Токен устройства: привязывает заказы к этому браузеру (localStorage)
  function clientToken() {
    try {
      var t = localStorage.getItem(CLIENT_TOKEN_KEY);
      if (!t) {
        t = 'ct_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
        localStorage.setItem(CLIENT_TOKEN_KEY, t);
      }
      return t;
    } catch (e) { return ''; }
  }

  function orderStatusMeta(status) {
    if (status === 'new') return { label: 'Новый', sub: 'ждём подтверждения', icon: 'clock', cls: 'badge badge-st-new' };
    if (status === 'ready') return { label: 'Готов к выдаче', sub: 'можно забирать', icon: 'package', cls: 'badge badge-st-ready' };
    if (status === 'confirmed') return { label: 'Подтверждён', sub: 'заказ выдан', icon: 'check', cls: 'badge badge-st-confirmed' };
    if (status === 'cancelled') return { label: 'Отменён', sub: '', icon: 'x', cls: 'badge badge-st-cancelled' };
    return { label: '—', sub: '', icon: 'info', cls: 'badge' };
  }

  // Единый формат даты в модалке: «13 авг · 09:00» (без запятых и точек после месяца)
  function orderDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var date = d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\./g, '');
    var time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return date + ' · ' + time;
  }

  // Модалка со списком заказов этого устройства. Данные грузятся только при открытии
  // (1 запрос); позиции/фото подтягиваются из уже загруженного каталога (0 запросов).
  function openMyOrdersModal() {
    var token = clientToken();
    if (!token) { showToast('Не удалось определить устройство'); return; }
    openModal(
      '<div class="my-orders-head">' +
      '<h3 style="margin:0;">' + icon('box', 20) + ' Мои заказы</h3>' +
      '</div>' +
      '<div class="my-orders-info">' + icon('info', 16) + '<span>Заказы, оформленные с этого устройства. Когда статус «Готов к выдаче» — товары можно забирать.</span></div>' +
      '<div id="myOrdersList">Загружаем…</div>' +
      '<div class="my-orders-foot"><a href="#" class="my-orders-refresh" id="myOrdersRefreshBtn">' + icon('refresh', 14) + ' Обновить</a></div>',
      true
    );
    var listEl = document.getElementById('myOrdersList');
    var render = function () {
      listEl.innerHTML = 'Загружаем…';
      fetch('/api/my-orders?token=' + encodeURIComponent(token))
        .then(function (r) { return r.json(); })
        .then(function (d) {
          var orders = (d && d.orders) || [];
          if (!orders.length) {
            listEl.innerHTML = '<div class="owner-req-empty">У вас пока нет заказов.<br><a href="catalog.html">Перейти в каталог →</a></div>';
            return;
          }
          var byId = {};
          (window.CatalogProducts || []).forEach(function (p) { byId[p.id] = p; });
          listEl.innerHTML = '<ul class="admin-list my-orders-list">' + orders.map(function (o) {
            var st = orderStatusMeta(o.status);
            // Номер: #N (новые заказы), иначе — читаемый суффикс id (без «…» и мусора)
            var oid = String(o.id || '');
            var isShort = /^GL-[A-Z0-9]{6}$/.test(oid);
            var suffix = oid.slice(oid.lastIndexOf('_') + 1).toUpperCase();
            var oidShow = o.number ? ('#' + o.number) : (isShort ? oid : (suffix || oid));
            var itemsHtml = (o.items || []).map(function (i) {
              var p = byId[i.productId];
              var img = p ? (p.thumb || p.image) : '';
              var name = i.name || (p ? p.name : '') || i.sku || i.productId;
              var unit = Number(i.price) || 0;
              var subtotal = unit ? (unit * (Number(i.qty) || 1)) : 0;
              return '<div class="order-receipt-row">' +
                (img ? '<img class="order-receipt-img" src="' + esc(img) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\'">' : '<span class="order-receipt-img delivery-item-clock">' + icon('clock', 18) + '</span>') +
                '<span class="order-receipt-name" title="' + esc(name) + '">' + esc(name) + '</span>' +
                '<span class="order-receipt-qty">× ' + esc(i.qty) + '</span>' +
                (unit ? '<span class="order-receipt-sum">' + fmtPrice(subtotal) + '</span>' : '') +
                '</div>';
            }).join('');
            var summaryParts = [];
            var pkg = Number(o.package) || 0;
            var goodsTotal = Number(o.total) || 0;
            if (pkg > 0 && goodsTotal > pkg) {
              summaryParts.push('<span class="sum-goods">Товары: ' + fmtPrice(goodsTotal - pkg) + '</span>');
              summaryParts.push('<span class="sum-pkg">Пакет: ' + fmtPrice(pkg) + '</span>');
            }
            if (goodsTotal) {
              summaryParts.push('<span class="sum-total">Итого: <b>' + fmtPrice(goodsTotal) + '</b></span>');
            }
            if (o.payment) summaryParts.push('<span class="sum-pay">' + esc(o.payment) + '</span>');
            if (o.pickupDate) summaryParts.push('<span class="sum-pickup">' + esc(Utils.fmtDate(o.pickupDate + 'T00:00:00', { day: 'numeric', month: 'short' }).replace(/\./g, '')) + (o.pickupTime ? ' · ' + esc(o.pickupTime) : '') + '</span>');
            var noteTxt = o.managerNote ? '<div class="order-manager-note">' + icon('info', 14) + '<span><b>Сообщение менеджера:</b> ' + esc(o.managerNote) + '</span></div>' : '';
            return '<li class="order-card">' +
              '<div class="order-card-head">' +
              '<span class="order-id-chip" title="' + esc(oid) + '">Заказ ' + esc(oidShow) +
              '<button class="btn btn-outline btn-sm" type="button" data-copy-order="' + esc(oidShow) + '" title="Скопировать номер">' + icon('copy', 14) + '</button></span>' +
              '<span class="' + st.cls + '">' + icon(st.icon, 14) + ' ' + st.label + (st.sub ? '<small> · ' + st.sub + '</small>' : '') + '</span>' +
              '</div>' +
              '<div class="order-meta">' + icon('store', 14) + ' <span>' + esc(o.storeName || '—') + ' · ' + esc(orderDate(o.createdAt)) + '</span></div>' +
              '<div class="order-receipt">' + itemsHtml + '</div>' +
              '<div class="order-summary">' + summaryParts.map(function (s) { return '<span>' + s + '</span>'; }).join('') + '</div>' +
              noteTxt +
              (o.status === 'new' ? '<div class="order-card-footer"><a href="#" class="order-cancel-link" data-my-cancel="' + esc(o.id) + '">Отменить заказ</a></div>' : '') +
              '</li>';
          }).join('') + '</ul>';

          listEl.addEventListener('click', function (e) {
            var copyBtn = e.target.closest('[data-copy-order]');
            if (copyBtn) {
              var txt = copyBtn.getAttribute('data-copy-order');
              if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(txt).then(function () { showToast('Номер заказа скопирован'); });
              }
              return;
            }
            var btn = e.target.closest('[data-my-cancel]');
            if (!btn) return;
            e.preventDefault();
            var oid = btn.getAttribute('data-my-cancel');
            if (!confirm('Отменить заказ? Зарезервированный товар вернётся в наличие. Отменить можно только пока заказ ещё «Новый».')) return;
            fetch('/api/my-orders/action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: oid, token: token, action: 'cancel' })
            }).then(function (r) { return r.json(); }).then(function (res) {
              showToast(res && res.ok ? 'Заказ отменён' : ((res && res.error) || 'Не удалось отменить заказ'));
              render();
            }).catch(function () { showToast('Нет связи — попробуйте ещё раз'); });
          });
          var ref = document.getElementById('myOrdersRefreshBtn');
          if (ref) ref.addEventListener('click', function (e) { e.preventDefault(); render(); });
        })
        .catch(function () {
          listEl.innerHTML = '<div class="owner-req-empty">Не удалось загрузить заказы. Проверьте соединение и попробуйте ещё раз.</div>';
        });
    };
    render();
  }

  // Кнопка «📦 Мои заказы» в шапке — открывает модалку
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.my-orders-link');
    if (btn) {
      e.preventDefault();
      openMyOrdersModal();
    }
  });

  // Счётчик заказов на кнопке «Мои заказы»: запрос только если у устройства уже есть
  // clientToken (у новых посетителей — 0 дополнительных запросов).
  function refreshMyOrdersBadge() {
    var token = null;
    try { token = localStorage.getItem(CLIENT_TOKEN_KEY) || ''; } catch (e) { token = ''; }
    if (!token) return;
    fetch('/api/my-orders?token=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var n = (d && d.orders) ? d.orders.length : 0;
        if (!n) return;
        document.querySelectorAll('.my-orders-link').forEach(function (btn) {
          var count = btn.querySelector('.my-orders-count');
          if (!count) {
            count = document.createElement('span');
            count.className = 'cart-badge my-orders-count';
            btn.appendChild(count);
          }
          count.textContent = n;
        });
      })
      .catch(function () { });
  }

  document.addEventListener('DOMContentLoaded', refreshMyOrdersBadge);
  if (document.readyState === 'interactive' || document.readyState === 'complete') refreshMyOrdersBadge();

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  document.addEventListener('click', function (e) {
    if (e.target === overlay) closeModal();
    if (e.target === modalClose) closeModal();
    var burger = document.getElementById('burger');
    var nav = document.getElementById('nav');
    if (e.target.closest('#burger')) {
      burger.classList.toggle('open');
      nav.classList.toggle('open');
    }
    if (e.target.closest('.nav a')) {
      burger.classList.remove('open');
      nav.classList.remove('open');
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  async function loadStore() {
    try {
      var res = await fetch('data/store.json');
      store = await res.json();
      bindStore(store);
    } catch (err) { }
  }

  function bindStore(s) {
    document.title = 'Сервис-центры Greenleaf — каталог продукции и эко-товаров';

    var waButtons = document.querySelectorAll('#waHero, #waContacts, #waFooter');
    waButtons.forEach(function (b) {
      b.href = waLink('Здравствуйте!\nПишу из сайта mygreenleaf.\nИнтересует наличие эко-продукции');
    });

    // Восстановление пароля — по email (форма в cabinet.html), не через WhatsApp

    // Контакты/карта зависят от выбранного СЦ — их рендерит catalog.js
    if (window.CatalogRefreshContacts) window.CatalogRefreshContacts();
  }

  // ---------------- Векторные иконки (SVG) ----------------
  // Эмодзи-символы не отрисовываются на части устройств — используем SVG.

  var SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

  function iconX(size) {
    return '<svg ' + SVG_ATTRS + ' width="' + (size || 13) + '" height="' + (size || 13) + '" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
  }

  function iconTrash(size) {
    return '<svg ' + SVG_ATTRS + ' width="' + (size || 15) + '" height="' + (size || 15) + '" aria-hidden="true">' +
      '<path d="M4 7h16"/><path d="M9.5 7V5.2c0-.6.5-1.2 1.1-1.2h2.8c.6 0 1.1.6 1.1 1.2V7"/>' +
      '<path d="M6.5 7l.9 12.2c0 .6.5 1.2 1.1 1.2h7c.6 0 1.1-.6 1.1-1.2L17.5 7"/>' +
      '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  }

  function iconTruck(size) {
    return '<svg ' + SVG_ATTRS + ' width="' + (size || 22) + '" height="' + (size || 22) + '" aria-hidden="true">' +
      '<rect x="2" y="6.5" width="11.5" height="8.5" rx="1.4"/>' +
      '<path d="M13.5 9.5h4.4l3.1 3.1V15h-7.5z"/>' +
      '<circle cx="6.4" cy="17.4" r="1.7"/><circle cx="17.3" cy="17.4" r="1.7"/></svg>';
  }

  var WEEK_DAYS = [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']];

  function scheduleTimeOptions(selected) {
    var out = '';
    for (var m = 8 * 60; m <= 21 * 60; m += 30) {
      var hh = String(Math.floor(m / 60)).padStart(2, '0');
      var mm = String(m % 60).padStart(2, '0');
      var v = hh + ':' + mm;
      out += '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + v + '</option>';
    }
    return out;
  }

  // Расписание по умолчанию: из schedule-объекта, статичной строки hours или 10:00–20:00 все дни
  function scheduleDefault(store) {
    store = store || {};
    if (store.schedule && typeof store.schedule === 'object' && store.schedule.mon !== undefined) {
      var merged = {};
      WEEK_DAYS.forEach(function (d) {
        var v = store.schedule[d[0]];
        merged[d[0]] = v ? { open: String(v.open || '10:00'), close: String(v.close || '20:00') } : null;
      });
      return merged;
    }
    var hrs = String(store.hours || '');
    var m = /(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/.exec(hrs);
    var open = m ? m[1] + ':' + m[2] : '10:00';
    var close = m ? m[3] + ':' + m[4] : '20:00';
    var off = {};
    if (/Пн\s*[-–—]\s*Пт/.test(hrs)) { off.sat = true; off.sun = true; }
    else if (/Пн\s*[-–—]\s*Сб/.test(hrs) || /Сб\s*[-–—]\s*Вс/.test(hrs)) { off.sun = true; }
    var sch = {};
    WEEK_DAYS.forEach(function (d) { sch[d[0]] = off[d[0]] ? null : { open: open, close: close }; });
    return sch;
  }

  function scheduleToText(sch) {
    sch = sch || {};
    var parts = [];
    var i = 0;
    while (i < WEEK_DAYS.length) {
      var d = WEEK_DAYS[i];
      var cur = sch[d[0]];
      if (!cur) { i++; continue; }
      var j = i;
      while (j + 1 < WEEK_DAYS.length && sch[WEEK_DAYS[j + 1][0]] && sch[WEEK_DAYS[j + 1][0]].open === cur.open && sch[WEEK_DAYS[j + 1][0]].close === cur.close) {
        j++;
      }
      var range = WEEK_DAYS[i][1] + (j > i ? '–' + WEEK_DAYS[j][1] : '');
      parts.push(range + ' ' + cur.open + ' – ' + cur.close);
      i = j + 1;
    }
    // Явно перечисляем выходные дни, чтобы «выходной» не терялся между рабочими
    var offDays = WEEK_DAYS.filter(function (d) { return !sch[d[0]]; }).map(function (d) { return d[1]; });
    if (offDays.length) parts.push('Выходной: ' + offDays.join(', '));
    return parts.length ? parts.join(', ') : 'Выходной';
  }

  function scheduleFormHtml(store) {
    var sch = scheduleDefault(store);
    var rows = WEEK_DAYS.map(function (d) {
      var v = sch[d[0]];
      var openSel = '<select class="sched-open" data-day="' + d[0] + '">' + scheduleTimeOptions(v ? v.open : '10:00') + '</select>';
      var closeSel = '<select class="sched-close" data-day="' + d[0] + '">' + scheduleTimeOptions(v ? v.close : '20:00') + '</select>';
      return '<div class="sched-row' + (v ? '' : ' has-off') + '">' +
        '<span class="sched-day">' + d[1] + '</span>' +
        '<label class="form-checkbox sched-off"><input type="checkbox" data-sched-off="' + d[0] + '"' + (v ? '' : ' checked') + '> Выходной — закрыто</label>' +
        '<span class="sched-times">' + openSel + ' – ' + closeSel + '</span>' +
        '</div>';
    });
    return '<p class="form-note">Укажите часы работы по дням недели. Отметьте <b>«Выходной — закрыто»</b>, если в этот день не работаете (время скрывается).</p>' +
      '<div class="sched-grid">' + rows.join('') + '</div>' +
      '<input type="hidden" name="hours" value="' + esc(scheduleToText(sch)) + '">' +
      '<input type="hidden" name="schedule_json" value="' + esc(JSON.stringify(sch)) + '">';
  }

  // Собрать расписание из DOM-селекторов
  function collectSchedule(form) {
    var sch = {};
    var any = false;
    WEEK_DAYS.forEach(function (d) {
      var off = form.querySelector('[data-sched-off="' + d[0] + '"]');
      if (off && off.checked) { sch[d[0]] = null; return; }
      var o = form.querySelector('.sched-open[data-day="' + d[0] + '"]');
      var c = form.querySelector('.sched-close[data-day="' + d[0] + '"]');
      sch[d[0]] = { open: o ? o.value : '10:00', close: c ? c.value : '20:00' };
      any = true;
    });
    return any ? sch : null;
  }

  window.Utils = {
    openModal: openModal,
    closeModal: closeModal,
    showToast: showToast,
    fmtPrice: fmtPrice,
    fmtDate: fmtDate,
    esc: esc,
    productByLabel: productByLabel,
    productByArticle: productByArticle,
    deliveryItemHtml: deliveryItemHtml,
    clientToken: clientToken,
    openMyOrdersModal: openMyOrdersModal,
    getStore: function () { return store; },
    waLink: waLink,
    icon: icon,
    iconX: iconX,
    iconTrash: iconTrash,
    iconTruck: iconTruck,
    scheduleTimeOptions: scheduleTimeOptions,
    scheduleDefault: scheduleDefault,
    scheduleToText: scheduleToText,
    scheduleFormHtml: scheduleFormHtml,
    collectSchedule: collectSchedule,
    WEEK_DAYS: WEEK_DAYS
  };

  document.getElementById('year').textContent = new Date().getFullYear();
  loadStore();

  // ---------------- Остатки по филиалам (store-stock.json + списания Worker) ----------------

  var baseStock = {};
  var baseStockUpdated = '';
  var baseStockLoaded = null;

  function loadBaseStock() {
    if (baseStockLoaded) return baseStockLoaded;
    // Эффективные остатки (база − продажи − активные брони) с Worker;
    // при недоступности API (офлайн-разработка) — статический файл.
    baseStockLoaded = fetch('/api/stock', { cache: 'default' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.stock) {
          baseStock = d.stock;
          baseStockUpdated = (d && d.updated) || '';
          return;
        }
        throw new Error('no stock');
      })
      .catch(function () {
        return fetch('data/store-stock.json')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            baseStock = (d && d.stock) || {};
            baseStockUpdated = (d && d.updated) || '';
          })
          .catch(function () {
            baseStock = {};
            baseStockUpdated = '';
          });
      });
    return baseStockLoaded;
  }

  // Принудительная перезагрузка остатков (после сохранения правок в KV)
  function reloadBaseStock() {
    baseStockLoaded = null;
    baseStock = {};
    return loadBaseStock();
  }

  function storeStockData(storeId) {
    var fromBase = baseStock[storeId] && Object.keys(baseStock[storeId]).length;
    return !!fromBase;
  }

  function stockText(storeId, productId) {
    if (baseStock[storeId] && baseStock[storeId][productId] !== undefined) return baseStock[storeId][productId];
    return undefined;
  }

  // Скрытие товара в конкретном СЦ (оверрайд суперадмина из /data/products.json)
  function scHidden(storeId, productId) {
    try {
      var m = window.__scOverrides || {};
      return !!(m[storeId] && m[storeId][productId] && m[storeId][productId].hidden);
    } catch (e) { return false; }
  }

  function isAvailableInStore(p, storeId) {
    // Скрытые суперадмином товары в этом СЦ недоступны для заказа
    if (scHidden(storeId, p && p.id)) return false;
    // Если у филиала нет данных об остатках — товаров в нём нет
    if (!storeStockData(storeId)) return false;
    var t = stockText(storeId, p && p.id);
    if (t === undefined || t === null || String(t).trim() === '') return false;
    t = String(t);
    return t.indexOf('Нет') !== 0 && t.indexOf('Ожидается') === -1;
  }

  // Число из «В наличии (26 шт)» → 26; «Нет…» → 0; «Ожидается…»/без числа → null (лимита нет)
  function stockCount(storeId, productId) {
    var t = stockText(storeId, productId);
    if (t === undefined || t === null) return null;
    t = String(t).trim();
    if (t === '' || t.indexOf('Ожидается') !== -1) return null;
    if (t.indexOf('Нет') === 0) return 0;
    var m = t.match(/(\d+)\s*шт/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Сумма эффективных остатков по всем СЦ (для каталога без выбранного филиала):
  // «Нет в наличии» = 0, «Ожидается»/нет данных — пропускаем;
  // данных нет ни у одного СЦ → null (каталог покажет статичное p.quantity)
  function totalCount(productId) {
    var sum = 0;
    var any = false;
    Object.keys(baseStock || {}).forEach(function (sid) {
      var c = stockCount(sid, productId);
      if (c !== null) { sum += c; any = true; }
    });
    return any ? sum : null;
  }

  window.StoreStock = {
    load: loadBaseStock,
    reload: reloadBaseStock,
    hasData: storeStockData,
    text: stockText,
    count: stockCount,
    totalCount: totalCount,
    available: isAvailableInStore,
    updated: function () { return baseStockUpdated; }
  };
})();
