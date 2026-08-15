(function () {
  'use strict';

  var KEYS = {
    stores: 'greenleaf_sc_custom_stores_v1',
    stock: 'greenleaf_sc_custom_products_v1',
    deliveries: 'greenleaf_admin_deliveries_v1',
    scDeliveries: 'greenleaf_sc_deliveries_v1',
    events: 'greenleaf_admin_events_v1',
    scEvents: 'greenleaf_sc_events_v1',
    products: 'greenleaf_admin_products_v2',
    notices: 'greenleaf_admin_notices_v1'
  };

  var STATUS_OPTIONS = [
    ['in_stock', '✅ В наличии'],
    ['low', '⚠️ Заканчивается'],
    ['expected', '📦 Ожидается'],
    ['out', '— Нет в наличии']
  ];

  // Карточки полного каталога пока могут ссылаться на remote-миниатюры портала
  // (-small 60×60) — в таблицах берём веб-версию -shop (600×600)
  function adminImgUrl(p) {
    var img = (p && (p.thumb || p.image)) || 'assets/images/products/placeholder.svg';
    if (img.indexOf('http') === 0 && img.indexOf('-small.') !== -1) {
      img = img.replace('-small.', '-shop.');
    }
    return img;
  }

  var state = {
    user: null,
    stores: [],
    products: [],
    deliveries: [],
    events: [],
    section: null,
    editingDeliveryId: null,
    editingEventId: null,
    selectedScId: null,
    editingStoreId: null,
    newStoreFromApp: null,
    lastAppId: null,
    applications: [],
    productOverrides: {},
    scProductOverrides: {},
    siteSettings: { showDiscountPrices: true, categories: [] },
    productSearch: '',
    productCatFilter: 'all',
    productPage: 0,
    availabilityPage: 0,
    stockPage: 0,
    pendingProductChanges: {},
    pendingScChanges: {},
    availabilityScId: null,
    stockScId: null
  };

  var SECTIONS = {
    overview: { label: '📊 Обзор', roles: ['superadmin'] },
    cabinet: { label: '📋 Кабинет СЦ', roles: ['sc'] },
    sc: { label: '🏬 Сервис-Центры', roles: ['superadmin'] },
    scArchive: { label: '🗄 Архив СЦ', roles: ['superadmin'] },
    stock: { label: '📦 Остатки товаров', roles: ['sc'] },
    deliveries: { label: '🚚 Поставки', roles: ['superadmin', 'sc'] },
    events: { label: '📅 Мероприятия', roles: ['superadmin', 'sc'] },
    products: { label: '🛒 Товары', roles: ['superadmin'] },
    catalog: { label: '📦 Наличие в СЦ', roles: ['superadmin'] },
    orders: { label: '🛒 Заказы', roles: ['superadmin', 'sc'] },
    applications: { label: '📋 Заявки', roles: ['superadmin'] },
    notices: { label: '📢 Уведомления СЦ', roles: ['superadmin', 'sc'] }
  };

  function h(v) { return Utils.esc(v); }
  function shortHash(s) {
    var hash = 0;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) hash = ((hash * 31) + s.charCodeAt(i)) | 0;
    return Math.abs(hash).toString(36);
  }
  function lsGet(key) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
  }
  function lsSet(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { }
  }
  function loadJSON(url) {
    return fetch(url + '?t=' + Date.now()).then(function (r) { return r.json(); });
  }
  function isSuper() { return state.user && state.user.role === 'superadmin'; }

  // ---------------- Пагинация таблиц и бейдж разницы остатков ----------------

  var PAGE_SIZE = 100;

  function pageSlice(list, page) {
    var total = list.length;
    var pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
    if (page < 0) page = 0;
    if (page >= pages) page = pages - 1;
    var start = page * PAGE_SIZE;
    return {
      page: page,
      pages: pages,
      total: total,
      start: start,
      end: Math.min(total, start + PAGE_SIZE),
      items: list.slice(start, start + PAGE_SIZE)
    };
  }

  // Нумерованный пейджер: окно из 5 номеров вокруг текущей страницы,
  // крайние страницы с «…» при большом числе страниц, активная — подсвечена
  function pagerBtnHtml(label, go, active) {
    return '<button class="pager-btn' + (active ? ' active' : '') + '" type="button" data-page-go="' + go + '">' + label + '</button>';
  }

  function pagerHtml(info) {
    var page = info.page;
    var pages = info.pages;
    var html = '';
    if (pages > 1 && page > 0) html += pagerBtnHtml('‹ Назад', page - 1);
    var from = Math.max(0, page - 2);
    var to = Math.min(pages - 1, from + 4);
    from = Math.max(0, to - 4);
    if (from > 0) {
      html += pagerBtnHtml('1', 0, page === 0);
      if (from > 1) html += '<span class="pager-ellipsis">…</span>';
    }
    for (var i = from; i <= to; i++) html += pagerBtnHtml(String(i + 1), i, page === i);
    if (to < pages - 1) {
      if (to < pages - 2) html += '<span class="pager-ellipsis">…</span>';
      html += pagerBtnHtml(String(pages), pages - 1);
    }
    if (pages > 1 && page < pages - 1) html += pagerBtnHtml('Вперёд ›', page + 1);
    html += '<span class="pager-info">Стр. ' + (page + 1) + ' из ' + pages + ' · показано ' + (info.total ? (info.start + 1) + '–' + info.end : 0) + ' из ' + info.total + '</span>';
    return html;
  }

  // Бейдж постоянной поправки остатка: красный при минусе, зелёный при плюсе
  function deltaBadgeHtml(scId, pid) {
    var d = window.StoreStock && StoreStock.delta ? StoreStock.delta(scId, pid) : null;
    if (d === null || d === undefined || d === 0) return '';
    var cls = d < 0 ? 'stock-delta neg' : 'stock-delta pos';
    var sign = d > 0 ? '+' : '';
    return ' <span class="' + cls + '" title="Постоянная поправка к остатку парсера: на сайте = факт ' + (d > 0 ? '+ ' : '− ') + Math.abs(d) + '">Δ ' + sign + d + '</span>';
  }

  // Группы параметров для модалки «Сбросить правки» (имена полей оверрайдов)
  var RESET_GROUPS = [
    { fields: ['price', 'discount_price'], label: '💰 Цены (цена и скидка)' },
    { fields: ['description', 'category'], label: '📝 Описания и категории' },
    { fields: ['status', 'eta', 'incoming'], label: '📊 Статусы и поставки' },
    { fields: ['priority', 'hit'], label: '🔥 Приоритеты и «Хит»' },
    { fields: ['showDiscount'], label: '🏷 Показ скидки на сайте' },
    { fields: ['hidden'], label: '🙈 Скрытие товаров с сайта' }
  ];
  // Для сброса настроек филиала — только поля, которые есть в sc_product_overrides
  var RESET_SC_GROUPS = [
    { fields: ['price', 'discount_price'], label: '💰 Цены (цена и скидка)' },
    { fields: ['status', 'eta', 'incoming'], label: '📊 Статусы и поставки' },
    { fields: ['hidden'], label: '🙈 Скрытие товаров в филиале' }
  ];

  function openResetModal(opts) {
    var groups = (opts.sc ? RESET_SC_GROUPS : RESET_GROUPS).map(function (g, i) {
      return '<label class="form-checkbox reset-check"><input type="checkbox" name="grp" value="' + i + '" checked> ' + g.label + '</label>';
    }).join('');
    var includeScHtml = opts.includeSc
      ? '<label class="form-checkbox reset-check"><input type="checkbox" name="includeSc" checked> 🏬 Настройки товаров филиалов («Наличие в СЦ»)</label>'
      : '';
    Utils.openModal(
      '<h3 style="margin-bottom:6px;">🧹 ' + h(opts.title) + '</h3>' +
      '<p style="margin-top:0; color:var(--muted); font-size:13.5px;">Выберите параметры, которые вернуть к базовым данным. Невыбранные правки останутся.</p>' +
      '<form class="form" id="resetForm">' + groups + includeScHtml +
      '<label class="form-checkbox reset-check"><input type="checkbox" id="resetAllChk" checked> ☑️ Выбрать всё</label>' +
      '<div class="admin-actions" style="margin-top:14px;">' +
      '<button class="btn btn-primary danger-btn" type="submit">🧹 Сбросить выбранное</button>' +
      '<button class="btn btn-outline" type="button" id="resetCancelBtn">Отмена</button>' +
      '</div></form>'
    );
    var form = document.getElementById('resetForm');
    var allChk = document.getElementById('resetAllChk');
    var groupBoxes = form.querySelectorAll('input[type="checkbox"]:not(#resetAllChk)');
    function syncAll() {
      allChk.checked = Array.prototype.every.call(groupBoxes, function (b) { return b.checked; });
    }
    allChk.addEventListener('change', function () {
      groupBoxes.forEach(function (b) { b.checked = allChk.checked; });
    });
    form.addEventListener('change', syncAll);
    document.getElementById('resetCancelBtn').addEventListener('click', function () { Utils.closeModal(); });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var srcGroups = opts.sc ? RESET_SC_GROUPS : RESET_GROUPS;
      var fields = [];
      form.querySelectorAll('input[name="grp"]:checked').forEach(function (b) {
        srcGroups[Number(b.value)].fields.forEach(function (f) {
          if (fields.indexOf(f) === -1) fields.push(f);
        });
      });
      var includeSc = opts.includeSc && !!form.querySelector('input[name="includeSc"]:checked');
      if (!fields.length) {
        Utils.showToast('⚠️ Выберите хотя бы один параметр');
        return;
      }
      var payload = { action: opts.action, fields: fields };
      if (opts.extra) Object.assign(payload, opts.extra);
      if (opts.action === 'reset') payload.includeSc = includeSc;
      var btn = form.querySelector('button[type="submit"]');
      btn.disabled = true;
      btn.textContent = '⏳ Сбрасываем…';
      Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
        if (res && res.ok) {
          Utils.closeModal();
          Utils.showToast('🧹 Правки сброшены');
          state.pendingProductChanges = {};
          state.pendingScChanges = {};
          loadData().then(function () { openSection(state.section); });
        } else {
          btn.disabled = false;
          btn.textContent = '🧹 Сбросить выбранное';
          Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сбросить. Проверьте соединение.'));
        }
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = '🧹 Сбросить выбранное';
        Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз');
      });
    });
  }

  // ---------------- Данные ----------------

  function applyListOverride(list, key) {
    var saved = lsGet(key);
    if (saved && Array.isArray(saved)) return saved;
    return list;
  }

  // Устаревшие localStorage-оверрайды СЦ/товаров больше не применяются:
  // источник правок — KV Worker (/api/sc-stores, /data/products.json).
  // Иначе старые значения из localStorage маскируют свежие правки («не меняется»).

  // Поставки: базовый JSON → глобальный оверрайд суперадмина → пер-филиальные оверрайды СЦ
  function mergeDeliveries(base) {
    var result = applyListOverride(base, KEYS.deliveries);
    var perStore = lsGet(KEYS.scDeliveries) || {};
    Object.keys(perStore).forEach(function (storeId) {
      var arr = perStore[storeId];
      if (!Array.isArray(arr)) return;
      result = result.filter(function (d) { return d.storeId !== storeId; });
      arr.forEach(function (d) { result.push(d); });
    });
    return result;
  }

  function mergeEvents(base) {
    var result = applyListOverride(base, KEYS.events);
    var perStore = lsGet(KEYS.scEvents) || {};
    Object.keys(perStore).forEach(function (storeId) {
      var arr = perStore[storeId];
      if (!Array.isArray(arr)) return;
      result = result.filter(function (ev) { return ev.storeId !== storeId; });
      arr.forEach(function (ev) { result.push(ev); });
    });
    return result;
  }

  // Сохранение списка поставок: глобальные — в общий оверрайд, филиальные — в пер-филиальную карту.
  // Правки уходят в Worker KV (/api/deliveries) — видны посетителям и СЦ на всех устройствах.
  function saveDeliveries(list) {
    Auth.api('/api/deliveries', { method: 'POST', body: JSON.stringify({ deliveries: list }) }).catch(function () { });
    if (isSuper()) {
      var globals = list.filter(function (d) { return !d.storeId; });
      lsSet(KEYS.deliveries, globals);
      var map = {};
      list.filter(function (d) { return d.storeId; }).forEach(function (d) {
        if (!map[d.storeId]) map[d.storeId] = [];
        map[d.storeId].push(d);
      });
      lsSet(KEYS.scDeliveries, map);
    } else {
      var perStore = lsGet(KEYS.scDeliveries) || {};
      perStore[state.user.id] = list.filter(function (d) { return d.storeId === state.user.id; });
      lsSet(KEYS.scDeliveries, perStore);
    }
  }

  function saveEvents(list) {
    // Единая БД: правки уходят в Worker KV — сайт и админка видят сразу
    Auth.api('/api/events', { method: 'POST', body: JSON.stringify({ events: list }) }).catch(function () { });
    if (isSuper()) {
      var globals = list.filter(function (ev) { return !ev.storeId; });
      lsSet(KEYS.events, globals);
      var map = {};
      list.filter(function (ev) { return ev.storeId; }).forEach(function (ev) {
        if (!map[ev.storeId]) map[ev.storeId] = [];
        map[ev.storeId].push(ev);
      });
      lsSet(KEYS.scEvents, map);
    } else {
      var perStore = lsGet(KEYS.scEvents) || {};
      perStore[state.user.id] = list.filter(function (ev) { return ev.storeId === state.user.id; });
      lsSet(KEYS.scEvents, perStore);
    }
  }

  function loadData() {
    var p1 = loadJSON('data/stores.json')
      .catch(function () { return []; })
      .then(function (base) {
        // Зарегистрированные СЦ (Worker KV) — приоритетнее статичного списка
        return fetch('/api/stores')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var kv = (d && d.stores) || [];
            var deletedIds = (d && d.deletedIds) || [];
            var byId = {};
            kv.forEach(function (s) { byId[s.id] = s; });
            var merged = base.filter(function (s) { return deletedIds.indexOf(s.id) === -1; })
              .map(function (s) { return byId[s.id] ? Object.assign({}, s, byId[s.id]) : s; });
            kv.forEach(function (s) {
              if (!merged.some(function (x) { return x.id === s.id; })) merged.push(s);
            });
            return merged;
          })
          .catch(function () { return base; });
      });
    var p2 = loadJSON('data/products.json').then(function (d) { return d.products || []; }).catch(function () { return []; });
    // Поставки — из Worker KV (общие для всех устройств); при недоступности — статика + локальные
    var p3 = fetch('/api/deliveries')
      .then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.deliveries) || []; })
      .catch(function () {
        return loadJSON('data/deliveries.json').then(function (d) { return mergeDeliveries(d.deliveries || []); }).catch(function () { return mergeDeliveries([]); });
      });
    var p4 = Auth.api('/api/events')
      .then(function (d) { return (d && d.events) || []; })
      .catch(function () {
        return loadJSON('data/events.json').then(function (d) { return d.events || []; }).catch(function () { return []; });
      })
      .then(function (list) { return mergeEvents(list); });
    var p5 = window.StoreStock ? StoreStock.load() : Promise.resolve();
    var p6 = Auth.api('/api/sc-applications').then(function (d) { return (d && d.applications) || []; }).catch(function () { return []; });
    // Полные карточки СЦ (email, креды) — для редактирования; /api/sc-stores
    // суперадмину отдаёт все филиалы, СЦ — только свой
    var p7 = Auth.api('/api/sc-stores').then(function (d) { return (d && d.stores) || []; }).catch(function () { return []; });
    // Оверрайды товаров и настройки скидок (суперадмин)
    var p8 = isSuper()
      ? Auth.api('/api/admin/products').then(function (d) {
        return {
          overrides: (d && d.overrides) || {},
          scOverrides: (d && d.scOverrides) || {},
          settings: (d && d.settings) || { showDiscountPrices: true, categories: [] }
        };
      }).catch(function () { return { overrides: {}, scOverrides: {}, settings: { showDiscountPrices: true, categories: [] } }; })
      : Promise.resolve({ overrides: {}, scOverrides: {}, settings: { showDiscountPrices: true, categories: [] } });
    // Единый счётчик броней мест на мероприятия (Worker KV)
    var p9 = fetch('/api/event-bookings')
      .then(function (r) { return r.json(); })
      .then(function (d) { return (d && d.bookings) || {}; })
      .catch(function () { return {}; });
    return Promise.all([p1, p2, p3, p4, p5, p6, p7, p8, p9]).then(function (res) {
      state.stores = res[0];
      state.products = res[1];
      state.deliveries = res[2];
      state.events = res[3];
      state.applications = res[5];
      state.eventBookings = res[8] || {};
      // Полные записи СЦ из Worker — перекрывают публичный список (виден email и пр.)
      var fullById = {};
      res[6].forEach(function (s) { fullById[s.id] = s; });
      state.stores = state.stores.map(function (s) { return fullById[s.id] ? Object.assign({}, s, fullById[s.id]) : s; });
      res[6].forEach(function (s) {
        if (!state.stores.some(function (x) { return x.id === s.id; })) state.stores.push(s);
      });
      state.productOverrides = res[7].overrides || {};
      state.scProductOverrides = res[7].scOverrides || {};
      state.siteSettings = Object.assign({ showDiscountPrices: true, categories: [] }, res[7].settings || {});
      state.pendingProductChanges = {};
      state.pendingScChanges = {};
      // Стабильные строковые id: у базовых поставок/мероприятий их нет или они числа
      state.deliveries.forEach(function (d) {
        if (d.id === undefined || d.id === null) d.id = 'del_' + shortHash((d.date || '') + '|' + (d.note || '') + '|' + (d.storeId || ''));
        else d.id = String(d.id);
      });
      state.events.forEach(function (ev) {
        if (ev.id === undefined || ev.id === null) ev.id = 'ev_' + shortHash((ev.title || '') + '|' + (ev.date || ''));
        else ev.id = String(ev.id);
      });
    });
  }

  // ---------------- Навигация ----------------

  function visibleSections() {
    return Object.keys(SECTIONS).filter(function (k) {
      return SECTIONS[k].roles.indexOf(state.user.role) !== -1;
    });
  }

  function renderNav() {
    var nav = document.getElementById('adminNav');
    var html = visibleSections().map(function (k) {
      return '<button class="admin-nav-btn' + (state.section === k ? ' active' : '') + '" data-section="' + k + '">' + SECTIONS[k].label + '</button>';
    }).join('');
    html += '<div class="admin-nav-user" style="margin-top:24px; padding-top:16px; border-top:1px solid var(--line); font-size:12.5px; color:var(--muted);">Вы вошли как:<br><strong style="color:var(--ink);">' + h(state.user.name) + '</strong><br>' + (isSuper() ? '👑 Суперадмин' : '🏬 Сервис-Центр') + '</div>';
    nav.innerHTML = html;
  }

  function renderSection() {
    var renderers = {
      overview: renderOverview,
      cabinet: renderCabinet,
      sc: renderScContacts,
      scArchive: renderScArchive,
      stock: renderStock,
      deliveries: renderDeliveries,
      events: renderEvents,
      applications: renderApplications,
      orders: renderOrders,
      products: renderProducts,
      catalog: renderAvailability,
      notices: renderNotices
    };
    var fn = renderers[state.section] || renderOverview;
    var content = document.getElementById('adminContent');
    content.innerHTML = '<h2 class="admin-title">' + h(SECTIONS[state.section].label) + '</h2>';
    fn(content);
  }

  function openSection(name) {
    state.section = name;
    renderNav();
    renderSection();
  }

  // ---------------- Обзор ----------------

  function renderOverview(content) {
    var inStock = state.products.filter(function (p) { return p.status === 'in_stock' || p.status === 'low'; }).length;
    var pending = (state.applications || []).filter(function (a) { return a.status === 'pending'; }).length;

    var html =
      '<div class="admin-stats">' +
      statCard('📦', state.products.length, 'Товаров в каталоге') +
      statCard('✅', inStock, 'В наличии') +
      statCard('🚚', state.deliveries.length, 'Поставок') +
      statCard('📅', state.events.length, 'Мероприятий') +
      statCard('🏬', state.stores.length, 'Сервис-Центров') +
      statCard('🤝', pending, 'Заявок на рассмотрении') +
      '</div>' +
      '<div class="admin-card">' +
      '<h4 style="margin-bottom:10px;">Быстрые действия</h4>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<button class="btn btn-primary btn-sm" data-go="deliveries">🚚 Управлять поставками</button>' +
      '<button class="btn btn-primary btn-sm" data-go="events">📅 Управлять мероприятиями</button>' +
      '<button class="btn btn-primary btn-sm" data-go="applications">📋 Заявки (' + pending + ')</button>' +
      '<button class="btn btn-primary btn-sm" data-go="products">🛒 Товары</button>' +
      '<button class="btn btn-primary btn-sm" data-go="catalog">📦 Наличие товаров в СЦ</button>' +
      '<button class="btn btn-primary btn-sm" data-go="orders">🛒 Заказы</button>' +
      '</div>' +
      '</div>' +
      '<div class="admin-card">' +
      '<h4 style="margin-bottom:6px;">⚙️ Парсер каталога</h4>' +
      '<p style="font-size:13px;color:var(--muted);margin-bottom:10px;">Ручной запуск синхронизации с порталом (GitHub Actions). Результат появится на сайте через ~3–5 минут. Расписание 11:00/14:00/17:00/20:00 продолжает работать автоматически.</p>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<button class="btn btn-outline btn-sm" id="parserRunProducts">🔄 Обновить товары</button>' +
      '<button class="btn btn-outline btn-sm" id="parserRunDeliveries">🚚 Обновить поступления</button>' +
      '<button class="btn btn-outline btn-sm" id="parserRunFull">⏳ Полный прогон товаров</button>' +
      '</div>' +
      '<p class="form-note" id="parserRunMsg" style="margin-top:8px;"></p>' +
      '</div>';
    content.insertAdjacentHTML('beforeend', html);

    ['deliveries', 'events', 'applications', 'products', 'catalog', 'orders'].forEach(function (name) {
      var btn = content.querySelector('[data-go="' + name + '"]');
      if (btn) btn.addEventListener('click', function () { openSection(name); });
    });

    function bindParserRun(btnId, task, full, label) {
      var btn = content.querySelector(btnId);
      if (!btn) return;
      btn.addEventListener('click', function () {
        if (!confirm('Запустить парсер: ' + label + '?')) return;
        btn.disabled = true;
        var msg = content.querySelector('#parserRunMsg');
        if (msg) msg.textContent = '⏳ Запускаю…';
        Auth.api('/api/admin/parser-run', { method: 'POST', body: JSON.stringify({ task: task, full: full }) }).then(function (res) {
          if (res && res.ok) {
            if (msg) msg.textContent = '✅ Запущено. Результат на сайте через ~3–5 минут.';
            Utils.showToast('⚙️ Парсер запущен: ' + label);
          } else {
            if (msg) msg.textContent = '⚠️ ' + ((res && res.error) || 'Не удалось запустить');
            Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось запустить парсер'));
          }
          btn.disabled = false;
        }).catch(function () {
          if (msg) msg.textContent = '⚠️ Нет связи — попробуйте ещё раз';
          btn.disabled = false;
        });
      });
    }
    bindParserRun('#parserRunProducts', 'products', false, 'обновление товаров');
    bindParserRun('#parserRunDeliveries', 'deliveries', false, 'обновление поступлений');
    bindParserRun('#parserRunFull', 'products', true, 'полный прогон товаров');
  }

  function statCard(ico, val, lbl) {
    return '<div class="admin-stat"><div class="admin-stat-ico">' + ico + '</div><div class="admin-stat-val">' + val + '</div><div class="admin-stat-lbl">' + h(lbl || '') + '</div></div>';
  }

  // ---------------- Кабинет СЦ (контакты своего филиала) ----------------

  function renderCabinet(content) {
    var store = state.stores.find(function (s) { return s.id === state.user.id; }) ||
      state.stores.find(function (s) { return String(s.authLogin || '').toLowerCase() === String(state.user.login || '').toLowerCase(); }) || {
        id: state.user.id, name: state.user.name, address: '', hours: '', phone: '', whatsapp: '', description: ''
      };
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">⚙️ Управляете контактами своего филиала — они показываются посетителям на сайте.</div>' +
      '<form class="form admin-form" id="storeForm">' + storeFormHtml(store, false) + '</form>'
    );
    bindStoreForm(content, store, false);
  }

  // ---------------- Расписание работы СЦ (селекторы дней и времени) ----------------

  // ---------------- Сервис-Центры (суперадмин: все филиалы + создание) ----------------

  function storeFormHtml(store, withAuth) {
    var cityOptions = (window.KZ_CITIES_ORDERED || window.KZ_CITIES || []).map(function (c) {
      var top = (window.KZ_CITIES_TOP || []).indexOf(c) !== -1;
      return '<option value="' + h(c) + '"' + ((store.city || '').indexOf(c) !== -1 ? ' selected' : '') + ' class="' + (top ? 'city-top' : '') + '">' + h(c) + '</option>';
    }).join('');
    var imagePreview = store.image
      ? '<img id="storeImagePreview" class="store-img-preview" src="' + h(store.image) + '" alt="Превью фото" onerror="this.src=\'assets/images/products/placeholder.svg\'">'
      : '<img id="storeImagePreview" class="store-img-preview hidden" src="assets/images/products/placeholder.svg" alt="Превью фото" onerror="this.src=\'assets/images/products/placeholder.svg\'">';
    var pm = store.payment_methods || ['kaspi', 'cash'];
    return '<div class="admin-card">' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;" class="store-auth-grid">' +
      '<div class="form-group"><label>Название СЦ *</label><input name="storeName" value="' + h(store.name) + '" required></div>' +
      '<div class="form-group"><label>Город *</label><select name="city" required>' + cityOptions + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Точный адрес *</label><input name="address" value="' + h(store.address) + '" placeholder="ул. Абая 150" required></div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>Телефон *</label><input name="phone" value="' + h(store.phone) + '" placeholder="+7 (700) 000-00-00" required></div>' +
      '<div class="form-group"><label>WhatsApp (только цифры, с 7)</label><input name="whatsapp" value="' + h(store.whatsapp) + '" placeholder="77001234567"></div>' +
      '</div>' +
            Utils.scheduleFormHtml(store) +
      '<p class="form-note" style="max-width:360px;">🕐 Часы работы — по времени Астаны (UTC+5), общий часовой пояс для всех филиалов. Бронь и выдача проверяются по нему.</p>' +
      '<div class="form-group"><label>Kaspi QR (путь к картинке статичного QR)</label><input name="kaspi_qr" value="' + h(store.kaspi_qr || '') + '" placeholder="assets/images/kaspi-qr.png"></div>' +
      '<div class="form-group"><label>Методы оплаты</label>' +
      '<div class="pay-methods-admin">' +
      '<label class="pm-opt' + (pm.indexOf('kaspi') !== -1 ? ' checked' : '') + '">' +
      '<input type="checkbox" name="pay_kaspi" value="1"' + (pm.indexOf('kaspi') !== -1 ? ' checked' : '') + '>' +
      '<span class="pm-emoji">💳</span><span class="pm-name">Kaspi</span><span class="pm-hint">Оплата переводом онлайн</span>' +
      '</label>' +
      '<label class="pm-opt' + (pm.indexOf('cash') !== -1 ? ' checked' : '') + '">' +
      '<input type="checkbox" name="pay_cash" value="1"' + (pm.indexOf('cash') !== -1 ? ' checked' : '') + '>' +
      '<span class="pm-emoji">💵</span><span class="pm-name">Наличные</span><span class="pm-hint">Оплата при получении</span>' +
      '</label>' +
      '</div>' +
      '<p class="form-note">Отключённый метод станет недоступен при оформлении заказа (кнопка неактивна с подсказкой).</p></div>' +
      '<div class="form-group"><label>Фото (путь или ссылка)</label><input name="image" value="' + h(store.image || '') + '" placeholder="assets/images/... или https://..."' + (store.image ? '' : '') + '>' + imagePreview + '</div>' +
      '<div class="form-group"><label>Краткое описание филиала</label><textarea name="description">' + h(store.description) + '</textarea></div>' +
      '<div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">' +
      '<strong style="font-size:14px;">🔐 Доступ к кабинету сайта</strong>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      (isSuper()
        ? '<div class="form-group"><label>Логин для входа в кабинет</label><input name="authLogin" value="' + h(store.authLogin || '') + '" placeholder="s240534"></div>'
        : '<div class="form-group"><label>Логин для входа (менять нельзя)</label><input name="authLogin" value="' + h(store.authLogin || '') + '" readonly style="background:#f2f4f7;color:#555;"></div>') +
      (isSuper()
        ? '<div class="form-group"><label>Пароль кабинета</label><input name="authPassword" type="text" value="' + h(store.authPassword || '') + '" placeholder="••••••••"></div>'
        : '<div class="form-group"><label>Новый пароль кабинета (пусто — не менять)</label><input name="authPassword" type="password" value="" placeholder="Новый пароль"></div>') +
      '</div>' +
      (isSuper()
        ? '<div class="admin-actions" style="margin-top:6px;"><button class="btn btn-outline btn-sm" type="button" id="storeResetPasswordBtn">🔄 Сбросить пароль (сгенерировать)</button></div>'
        : '<p class="form-note">🔑 Меняйте пароль кабинета здесь. Логин закреплён администратором — восстановление пароля только через него.</p>') +
      '</div>' +
      '<div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">' +
      '<strong style="font-size:14px;">🔌 Подключение к порталу (автосинхронизация остатков)</strong>' +
      (store.portalLogin && (store.portalPassword || !isSuper())
        ? '<p class="form-note" style="color:var(--green-darker);">✅ Парсер подключён — остатки будут подтягиваться автоматически.</p>'
        : '<p class="form-note" style="color:#b54708; font-weight:600;">⚠️ Парсер ещё не подключён — укажите логин и пароль кабинета СЦ, чтобы остатки обновлялись автоматически.</p>') +
      '<div class="form-group"><label>Логин кабинета СЦ (для парсера)</label><input name="portalLogin" value="' + h(store.portalLogin || '') + '" placeholder="s240534"></div>' +
      (isSuper()
        ? '<div class="form-group"><label>Пароль кабинета СЦ (для парсера)</label><input name="portalPassword" type="text" value="' + h(store.portalPassword || '') + '" placeholder="••••••••"></div>'
        : '<div class="form-group"><label>Новый пароль кабинета СЦ (для парсера, пусто — не менять)</label><input name="portalPassword" type="password" value="" placeholder="Новый пароль"></div>') +
      '<p class="form-note">🔐 Бот заходит в кабинет Сервис-Центра по этим логину и паролю и автоматически подтягивает остатки. Текущий пароль видит только суперадмин.</p>' +
      '</div>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-primary" type="submit">💾 Сохранить филиал</button>' +
      (withAuth ? '<button class="btn btn-outline danger-btn" type="button" id="storeDeleteBtn">' + Utils.iconTrash(14) + 'Удалить филиал</button>' : '') +
      '</div>' +
      '<p class="form-error hidden">Проверьте заполнение полей.</p>' +
      '</div>';
  }

  function issuedCredsHtml(rec, phone) {
    var wa = '';
    var digits = String(phone || '').replace(/\D/g, '');
    if (digits) {
      wa = 'https://wa.me/' + digits + '?text=' + encodeURIComponent(
        'Здравствуйте! Ваш Сервис-Центр подключён к каталогу Greenleaf. Логин: ' + rec.authLogin + ', пароль: ' + rec.authPassword + '. Вход: сайт → «Войти».'
      );
    }
    return '<div class="admin-card" style="border-color:var(--green); margin-top:12px;">' +
      '<strong style="color:var(--green-darker);">🔐 Доступ для Сервис-Центра</strong>' +
      '<p style="margin:6px 0;">Логин: <b>' + h(rec.authLogin || '') + '</b><br>Пароль: <b>' + h(rec.authPassword || '') + '</b></p>' +
      '<p class="form-note">Доступы передаёт суперадмин лично — почтовые письма не используются.</p>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-outline btn-sm" data-copy="' + h(rec.authLogin + ' / ' + rec.authPassword) + '">📋 Копировать</button>' +
      (wa ? '<a class="btn btn-whatsapp btn-sm" href="' + wa + '" target="_blank" rel="noopener">📱 Отправить владельцу</a>' : '') +
      '</div></div>';
  }

  function bindStoreForm(content, store, withAuth) {
    var form = content.querySelector('#storeForm');
    form.addEventListener('change', function (e) {
      var off = e.target.closest('[data-sched-off]');
      if (off) {
        var row = off.closest('.sched-row');
        if (row) row.classList.toggle('has-off', off.checked);
      }
      // Карточка-переключатель метода оплаты: подсвечиваем выбранное состояние
      var pmOpt = e.target.closest('.pm-opt');
      if (pmOpt) pmOpt.classList.toggle('checked', e.target.checked);
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var errMsg = form.querySelector('.form-error');
      var errors = [];
      ['storeName', 'city', 'address', 'phone'].forEach(function (f) {
        if (!form[f] || !String(form[f].value || '').trim()) errors.push(f);
      });
      if (errors.length) {
        form.classList.remove('show-success');
        form.classList.add('show-error');
        if (errMsg) errMsg.textContent = 'Не заполнены обязательные поля: ' + errors.join(', ');
        Utils.showToast('⚠️ Не заполнены обязательные поля: ' + errors.join(', '));
        return;
      }
      // Расписание из селекторов; если все дни — выходной, не сохраняем
      var schedule = Utils.collectSchedule(form);
      var hoursText = schedule ? Utils.scheduleToText(schedule) : '';
      if (!schedule) {
        form.classList.remove('show-success');
        form.classList.add('show-error');
        if (errMsg) errMsg.textContent = 'Укажите часы работы хотя бы в один день недели (снимите «Выходной — закрыто»).';
        Utils.showToast('⚠️ Укажите часы работы хотя бы в один день недели');
        return;
      }
      form.classList.remove('show-error');
      store.name = form.storeName.value.trim();
      store.city = form.city.value;
      store.cityKey = form.city.value.toLowerCase();
      store.address = form.address.value.trim();
      store.hours = hoursText;
      store.schedule = schedule;
      store.phone = form.phone.value.trim();
      store.whatsapp = form.whatsapp.value.trim();
      store.kaspi_qr = form.kaspi_qr.value.trim();
      store.image = form.image.value.trim();
      store.description = form.description.value.trim();
      store.portalLogin = form.portalLogin ? form.portalLogin.value.trim() : '';
      // Пароль портала/кабинета: пустое значение = не менять (для СЦ значение скрыто)
      var portalPass = form.portalPassword ? form.portalPassword.value : '';
      var authPass = form.authPassword ? form.authPassword.value : '';
      store.portalPassword = portalPass ? portalPass : store.portalPassword;
      store.authLogin = form.authLogin ? form.authLogin.value.trim() : store.authLogin;
      store.authPassword = authPass ? authPass : store.authPassword;
      store.phoneRaw = (store.phone || '').replace(/\D/g, '');
      if (store.phoneRaw && !store.whatsapp) store.whatsapp = store.phoneRaw;
      // Методы оплаты: хотя бы один выбран; пустая конфигурация не сохраняется
      var paymentMethods = [];
      if (form.pay_kaspi && form.pay_kaspi.checked) paymentMethods.push('kaspi');
      if (form.pay_cash && form.pay_cash.checked) paymentMethods.push('cash');
      if (!paymentMethods.length) {
        form.classList.remove('show-success');
        form.classList.add('show-error');
        if (errMsg) errMsg.textContent = 'Выберите хотя бы один метод оплаты.';
        Utils.showToast('⚠️ Выберите хотя бы один метод оплаты');
        return;
      }
      store.payment_methods = paymentMethods;

      // Карточка СЦ всегда пишется в Worker KV: статика для остальных в stores.json
      var isNew = !store.id || String(store.id).indexOf('sc-new-') === 0;
      var payload = {
        id: isNew ? ('sc_' + Date.now()) : store.id,
        name: store.name,
        city: store.city,
        cityKey: store.cityKey,
        address: store.address,
        hours: store.hours,
        schedule: store.schedule,
        phone: store.phone,
        phoneRaw: store.phoneRaw,
        whatsapp: store.whatsapp,
        image: store.image,
        description: store.description,
        payment_methods: store.payment_methods,
        portalLogin: store.portalLogin,
        portalPassword: portalPass,
        authLogin: store.authLogin || '',
        authPassword: authPass
      };
      Auth.api('/api/sc-store', { method: 'POST', body: JSON.stringify(payload) }).then(function (data) {
        if (!data || !data.ok) {
          var reason = (data && data.error) || 'Не удалось сохранить. Проверьте соединение и попробуйте ещё раз.';
          form.classList.remove('show-success');
          form.classList.add('show-error');
          if (errMsg) errMsg.textContent = reason;
          Utils.showToast('⚠️ ' + reason);
          return;
        }
        var rec = data.store;
        store.id = rec.id;
        store.authLogin = rec.authLogin;
        store.authPassword = rec.authPassword;
        Utils.showToast('✅ Сервис-Центр сохранён');
        if (state.lastAppId) {
          Auth.api('/api/sc-application', { method: 'POST', body: JSON.stringify({ id: state.lastAppId, action: 'approve' }) });
          state.lastAppId = null;
        }
        if (isSuper()) {
          var credsPanel = content.querySelector('#issuedCreds');
          if (!credsPanel) {
            credsPanel = document.createElement('div');
            credsPanel.id = 'issuedCreds';
            content.appendChild(credsPanel);
          }
          credsPanel.innerHTML = issuedCredsHtml(rec, store.phoneRaw || store.phone);
        }
        loadData().then(function () { openSection(state.section); });
      });
    });

    // Превью фото филиала по мере ввода
    var imgInput = form.image;
    var imgPrev = form.querySelector('#storeImagePreview');
    if (imgInput && imgPrev) {
      imgInput.addEventListener('input', function () {
        var v = imgInput.value.trim();
        if (v) {
          imgPrev.src = v;
          imgPrev.classList.remove('hidden');
        } else {
          imgPrev.classList.add('hidden');
        }
      });
      if (imgInput.value.trim()) imgPrev.classList.remove('hidden');
    }

    content.addEventListener('click', function (e) {
      var copyBtn = e.target.closest('[data-copy]');
      if (!copyBtn) return;
      var text = copyBtn.getAttribute('data-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { Utils.showToast('📋 Скопировано'); });
      }
    });

    var resetPassBtn = content.querySelector('#storeResetPasswordBtn');
    if (resetPassBtn) {
      resetPassBtn.addEventListener('click', function () {
        if (!confirm('Сгенерировать новый пароль кабинета для «' + store.name + '»? Текущий пароль перестанет работать.')) return;
        Auth.api('/api/sc-store/reset-password', { method: 'POST', body: JSON.stringify({ id: store.id }) }).then(function (res) {
          if (res && res.ok) {
            Utils.showToast('✅ Новый пароль: ' + res.password);
            var credsPanel = content.querySelector('#issuedCreds');
            if (!credsPanel) {
              credsPanel = document.createElement('div');
              credsPanel.id = 'issuedCreds';
              content.appendChild(credsPanel);
            }
            credsPanel.innerHTML = issuedCredsHtml({ id: store.id, authLogin: res.login, authPassword: res.password }, store.phoneRaw || store.phone);
          } else {
            Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сбросить пароль. Проверьте соединение.'));
          }
        });
      });
    }

    var delBtn = content.querySelector('#storeDeleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('Удалить филиал «' + store.name + '»? Он исчезнет с сайта, но останется в архиве — оттуда его можно восстановить.')) return;
        Auth.api('/api/sc-store', { method: 'DELETE', body: JSON.stringify({ id: store.id }) }).then(function (res) {
          state.editingStoreId = null;
          Utils.showToast(res && res.ok ? '✅ Филиал перемещён в архив' : '⚠️ ' + ((res && res.error) || 'Не удалось удалить. Проверьте соединение.'));
          loadData().then(function () { openSection('sc'); });
        });
      });
    }
  }

  function renderScContacts(content) {
    var list = state.stores;
    var selectedId = state.editingStoreId || state.selectedScId || (list[0] ? list[0].id : '');

    var addBtn = '<button class="btn btn-primary" id="scAddStoreBtn">➕ Добавить филиал</button>';
    var cardsHtml = '<div class="admin-card">' +
      '<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">' +
      '<strong style="font-size:15px;">Филиалы (' + list.length + ')</strong>' + addBtn +
      '</div>' +
      '<ul class="admin-list" id="scStoresList">' +
      list.map(function (s) {
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(s.name) + (s.portalLogin ? ' <span class="badge st-in" title="Остатки синхронизируются автоматически">🔌 автоостатки</span>' : '') + '</strong>' +
          '<span>📍 ' + h(s.address || '') + ' · ' + h(s.city || '') + ' · 🕒 ' + h(s.hours || '') + '</span>' +
          '<span>📞 ' + h(s.phone || '') + '</span>' +
          '</div>' +
          '<div class="admin-actions">' +
          '<button class="btn btn-outline btn-sm" data-sc-edit="' + h(s.id) + '">✏️ Редактировать</button>' +
          '<button class="btn btn-outline btn-sm danger-btn" data-sc-remove="' + h(s.id) + '">🗑 Удалить</button>' +
          '</div>' +
          '</li>';
      }).join('') +
      '</ul></div>';

    content.insertAdjacentHTML('beforeend',
      '<div class="sc-layout">' +
      '<div class="sc-layout-list">' + cardsHtml + '</div>' +
      '<div class="sc-layout-form"></div>' +
      '</div>'
    );
    var formPane = content.querySelector('.sc-layout-form');

    content.querySelector('#scAddStoreBtn').addEventListener('click', function () {
      state.editingStoreId = 'new';
      openSection('sc');
    });

    content.querySelector('#scStoresList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-sc-edit]');
      if (btn) {
        state.editingStoreId = btn.getAttribute('data-sc-edit');
        openSection('sc');
        return;
      }
      var rmBtn = e.target.closest('[data-sc-remove]');
      if (!rmBtn) return;
      var sid = rmBtn.getAttribute('data-sc-remove');
      var s = list.find(function (x) { return x.id === sid; });
      if (!confirm('Удалить филиал «' + (s ? s.name : sid) + '»? Он исчезнет с сайта, но останется в архиве — оттуда его можно восстановить.')) return;
      Auth.api('/api/sc-store', { method: 'DELETE', body: JSON.stringify({ id: sid }) }).then(function (res) {
        Utils.showToast(res && res.ok ? '✅ Филиал перемещён в архив' : '⚠️ ' + ((res && res.error) || 'Не удалось удалить. Проверьте соединение.'));
        state.editingStoreId = null;
        loadData().then(function () { openSection('sc'); });
      });
    });

    if (selectedId === 'new') {
      var fromApp = state.newStoreFromApp || null;
      var newStore = fromApp
        ? {
          id: fromApp.officeId || 'sc-new-' + Date.now(),
          officeCode: fromApp.officeCode || '',
          name: fromApp.storeName || '',
          city: fromApp.city || 'Алматы',
          address: fromApp.address || '',
          hours: '',
          phone: fromApp.phone || '',
          whatsapp: fromApp.phoneRaw || fromApp.phone || '',
          email: fromApp.email || '',
          kaspi_qr: '',
          payment_methods: ['kaspi', 'cash'],
          image: '',
          description: '',
          portalLogin: fromApp.portalLogin || '',
          portalPassword: fromApp.portalPassword || ''
        }
        : { id: 'sc-new-' + Date.now(), name: '', city: 'Алматы', address: '', hours: '', phone: '', whatsapp: '', email: '', kaspi_qr: '', payment_methods: ['kaspi', 'cash'], image: '', description: '', officeCode: '', portalLogin: '', portalPassword: '', partner: '' };
      state.editingStoreId = null;
      state.newStoreFromApp = null;
      formPane.insertAdjacentHTML('beforeend', '<h4 style="margin-bottom:8px; color:var(--green-dark);">➕ Новый филиал</h4><form class="form admin-form" id="storeForm">' + storeFormHtml(newStore, true) + '</form>');
      bindStoreForm(content, newStore, true);
      return;
    }

    var store = list.find(function (s) { return s.id === selectedId; });
    if (!store) return;
    try {
      formPane.insertAdjacentHTML('beforeend',
        '<h4 style="margin-bottom:8px; color:var(--green-dark);">✏️ Редактирование: ' + h(store.name) + '</h4>' +
        '<form class="form admin-form" id="storeForm">' + storeFormHtml(store, true) + '</form>'
      );
      bindStoreForm(content, store, true);
      // После выбора «Редактировать» плавно подводим к форме (на узких экранах форма ниже)
      if (state.editingStoreId) {
        setTimeout(function () {
          var fp = content.querySelector('.sc-layout-form');
          if (fp) fp.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 60);
      }
    } catch (err) {
      formPane.insertAdjacentHTML('beforeend',
        '<div class="admin-card" style="border-color:var(--danger); color:var(--danger);">⚠️ Ошибка рендера формы: ' + h(String(err && err.message || err)) + '</div>'
      );
    }
  }

  // ---------------- Архив Сервис-Центров ----------------

  function renderScArchive(content) {
    content.insertAdjacentHTML('beforeend', '<div class="admin-note">🗄 Сюда попадают филиалы, удалённые из раздела «Сервис-Центры». Здесь их можно <b>восстановить</b> или <b>удалить навсегда</b> (безвозвратно).</div><div class="admin-card"><div id="scArchiveList">Загружаем…</div></div>');
    var listEl = content.querySelector('#scArchiveList');
    Auth.api('/api/sc-archive').then(function (d) {
      var list = (d && d.archived) || [];
      if (!list.length) {
        listEl.innerHTML = '<div class="owner-req-empty">Архив пуст.</div>';
        return;
      }
      listEl.innerHTML = '<ul class="admin-list">' + list.map(function (s) {
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(s.name) + '</strong>' +
          '<span>📍 ' + h(s.city || '') + ' · ' + h(s.address || '') + '</span>' +
          '<span>🗓 В архиве с ' + h(new Date(s.archivedAt || Date.now()).toLocaleString('ru-RU')) + '</span>' +
          '</div>' +
          '<div class="admin-actions">' +
          '<button class="btn btn-outline btn-sm" data-sc-archive-restore="' + h(s.id) + '">↩️ Восстановить</button>' +
          '<button class="btn btn-outline btn-sm danger-btn" data-sc-archive-purge="' + h(s.id) + '">🗑 Удалить навсегда</button>' +
          '</div>' +
          '</li>';
      }).join('') + '</ul>';

      listEl.addEventListener('click', function (e) {
        var restoreBtn = e.target.closest('[data-sc-archive-restore]');
        if (restoreBtn) {
          var rid = restoreBtn.getAttribute('data-sc-archive-restore');
          if (!confirm('Восстановить филиал «' + rid + '»? Он снова появится на сайте.')) return;
          Auth.api('/api/sc-archive/action', { method: 'POST', body: JSON.stringify({ id: rid, action: 'restore' }) }).then(function (res) {
            Utils.showToast(res && res.ok ? '✅ Филиал восстановлен' : '⚠️ ' + ((res && res.error) || 'Не удалось восстановить. Проверьте соединение.'));
            openSection('scArchive');
          });
          return;
        }
        var purgeBtn = e.target.closest('[data-sc-archive-purge]');
        if (!purgeBtn) return;
        var pid = purgeBtn.getAttribute('data-sc-archive-purge');
        if (!confirm('Удалить филиал «' + pid + '» НАВСЕГДА? Это действие необратимо.')) return;
        Auth.api('/api/sc-archive/action', { method: 'POST', body: JSON.stringify({ id: pid, action: 'purge' }) }).then(function (res) {
          Utils.showToast(res && res.ok ? '🗑 Удалён безвозвратно' : '⚠️ ' + ((res && res.error) || 'Не удалось удалить. Проверьте соединение.'));
          openSection('scArchive');
        });
      });
    }).catch(function () {
      listEl.innerHTML = '<div class="owner-req-empty">Не удалось загрузить архив. Войдите заново.</div>';
    });
  }

  // ---------------- Остатки ----------------

  function renderStock(content) {
    var visibleStores = isSuper() ? state.stores : state.stores.filter(function (s) { return s.id === state.user.id; });
    if (!visibleStores.length) visibleStores = state.stores;
    // СЦ правит остатки своего филиала, суперадмин — любого
    var canSave = true;
    var curScId = state.stockScId || (visibleStores[0] ? visibleStores[0].id : '');

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">📦 Остатки = база (парсер/файл) − продажи − активные брони (Worker). Введите нужное число — сохранится постоянная поправка к факту парсера (бейдж Δ под полем: красный — минус, зелёный — плюс). Пустое поле снимает поправку.</div>' +
      '<div class="admin-toolbar stock-toolbar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">' +
      '<label style="font-weight:600; font-size:13.5px;">Филиал:</label>' +
      '<select id="stockScSel" style="min-width:260px;">' +
      visibleStores.map(function (s) { return '<option value="' + h(s.id) + '"' + (s.id === curScId ? ' selected' : '') + '>' + h(s.name) + '</option>'; }).join('') +
      '</select>' +
      '<input class="search" id="stockSearch" type="search" placeholder="Поиск по названию или артикулу…" autocomplete="off" style="flex:1; min-width:200px;">' +
      '<select id="stockStatusFilter" style="min-width:170px;">' +
      '<option value="">Статус: все</option>' +
      '<option value="in_stock">В наличии</option>' +
      '<option value="zero">Нет в наличии</option>' +
      '<option value="none">Нет данных</option>' +
      '</select>' +
      '</div>' +
      '<div class="admin-card admin-table-wrap">' +
      '<div class="admin-pager pager-top" id="stockPagerTop"></div>' +
      '<table class="admin-table" id="stockTable">' +
      '<thead><tr>' +
      '<th style="min-width:60px;"></th>' +
      '<th style="min-width:240px;">Товар</th>' +
      '<th>Категория</th>' +
      '<th style="min-width:150px;">Цена / скидка</th>' +
      '<th>Статус</th>' +
      '<th style="min-width:150px;">Остаток</th>' +
      '</tr></thead><tbody id="stockTbody"></tbody></table>' +
      '<div class="admin-pager" id="stockPager"></div>' +
      '</div>' +
      '<div class="admin-actions stock-actions" style="flex-wrap:wrap;">' +
      (canSave ? '<button class="btn btn-primary" id="stockSaveBtn">💾 Сохранить остатки (Worker)</button>' : '') +
      '<button class="btn btn-outline" id="stockExportBtn">⬇️ Экспорт JSON (store-stock.json)</button>' +
      '<button class="btn btn-outline" id="stockImportBtn">⬆️ Импорт JSON</button>' +
      '<input type="file" id="stockImportFile" accept="application/json,.json" style="display:none;">' +
      '</div>'
    );

    var scSel = content.querySelector('#stockScSel');
    var searchInp = content.querySelector('#stockSearch');
    var statusFilter = content.querySelector('#stockStatusFilter');

    function pendSc() {
      if (!state.pendingScChanges[curScId]) state.pendingScChanges[curScId] = {};
      return state.pendingScChanges[curScId];
    }

    function statusOf(p, scId) {
      var cnt = StoreStock.count(scId, p.id);
      if (cnt === null) return 'none';
      return cnt > 0 ? 'in_stock' : 'zero';
    }

    function drawRows() {
      var scId = scSel ? scSel.value : curScId;
      if (!scId && visibleStores.length) scId = visibleStores[0].id;
      if (scId) curScId = scId;
      var q = (searchInp ? searchInp.value : '').trim().toLowerCase();
      var stFilter = statusFilter ? statusFilter.value : '';
      var list = state.products.filter(function (p) {
        if (q && p.name.toLowerCase().indexOf(q) === -1 && p.sku.toLowerCase().indexOf(q) === -1) return false;
        if (stFilter && statusOf(p, scId) !== stFilter) return false;
        return true;
      });
      var info = pageSlice(list, state.stockPage);
      state.stockPage = info.page;
      var pend = pendSc();
      var rows = info.items.map(function (p) {
        var img = adminImgUrl(p);
        var st = statusOf(p, scId);
        var stBadge = st === 'in_stock' ? '<span class="badge st-in">✅ В наличии</span>'
          : st === 'zero' ? '<span class="badge st-out">— Нет</span>'
          : '<span class="badge st-exp">🕓 Нет данных</span>';
        var pe = pend[p.id] || {};
        var cnt = pe.stock !== undefined ? pe.stock : StoreStock.count(scId, p.id);
        var priceTxt = Utils.fmtPrice(p.price);
        if (p.discount_price) priceTxt += ' <s class="muted-sku">' + Utils.fmtPrice(p.discount_price) + '</s>';
        return '<tr>' +
          '<td><img class="admin-thumb" src="' + h(img) + '" alt="" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'"></td>' +
          '<td><strong>' + h(p.name) + '</strong><br><span class="muted-sku">' + h(p.sku) + '</span></td>' +
          '<td>' + h(p.category || '') + '</td>' +
          '<td>' + priceTxt + '</td>' +
          '<td>' + stBadge + '</td>' +
          '<td><div class="stock-cell"><input data-stock-prod="' + h(p.id) + '" type="number" min="0" data-init="' + h(cnt === null ? '' : cnt) + '" value="' + h(cnt === null ? '' : cnt) + '" placeholder="Число (0 = нет)" style="width:130px;">' + deltaBadgeHtml(scId, p.id) + '</div></td>' +
          '</tr>';
      }).join('');
      document.getElementById('stockTbody').innerHTML = rows || '<tr><td colspan="6" style="color:var(--muted);">Ничего не найдено.</td></tr>';
      var pagerHtmlStr = info.pages > 1 ? pagerHtml(info) : '<span class="pager-info">Показано ' + (info.total ? (info.start + 1) + '–' + info.end : 0) + ' из ' + info.total + '</span>';
      ['stockPager', 'stockPagerTop'].forEach(function (id) {
        var pager = document.getElementById(id);
        if (pager) pager.innerHTML = pagerHtmlStr;
      });
    }

    // Текущая страница → буфер (изменённое запоминаем, возвращённое к data-init убираем)
    function syncBuffer() {
      var pend = pendSc();
      content.querySelectorAll('#stockTbody [data-stock-prod]').forEach(function (el) {
        var pid = el.getAttribute('data-stock-prod');
        var init = el.getAttribute('data-init') || '';
        var val = el.value;
        if (!pend[pid]) pend[pid] = {};
        if (val !== init) pend[pid].stock = val;
        else delete pend[pid].stock;
        if (!Object.keys(pend[pid]).length) delete pend[pid];
      });
    }

    drawRows();
    scSel.addEventListener('change', function () {
      state.stockScId = scSel.value;
      state.stockPage = 0;
      drawRows();
    });
    searchInp.addEventListener('input', function () {
      state.stockPage = 0;
      drawRows();
    });
    statusFilter.addEventListener('change', function () {
      state.stockPage = 0;
      drawRows();
    });
    var stockTbody = document.getElementById('stockTbody');
    stockTbody.addEventListener('input', function (e) {
      var el = e.target.closest('[data-stock-prod]');
      if (!el) return;
      var pend = pendSc();
      var pid = el.getAttribute('data-stock-prod');
      if (!pend[pid]) pend[pid] = {};
      pend[pid].stock = el.value;
    });
    ['stockPager', 'stockPagerTop'].forEach(function (id) {
      var stockPager = document.getElementById(id);
      stockPager.addEventListener('click', function (e) {
        var go = e.target.closest('[data-page-go]');
        if (go) {
          state.stockPage = parseInt(go.getAttribute('data-page-go'), 10) || 0;
          drawRows();
          content.querySelector('.admin-table-wrap').scrollIntoView({ block: 'start' });
        }
      });
    });

    var saveBtn = content.querySelector('#stockSaveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var scId = curScId;
        syncBuffer();
        var pend = pendSc();
        var items = {};
        Object.keys(pend).forEach(function (pid) {
          var v = pend[pid].stock;
          if (v === undefined) return;
          v = String(v).trim();
          var n = Number(v);
          if (v !== '' && (isNaN(n) || n < 0)) return;
          // Пустое значение = снять поправку (дельту/абсолютную правку)
          items[pid] = v === '' ? '' : (n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии');
        });
        Auth.api('/api/stock', { method: 'POST', body: JSON.stringify({ scId: scId, items: items }) }).then(function (res) {
          if (res && res.ok) {
            Utils.showToast('✅ Остатки филиала сохранены — сайт обновлён');
            delete state.pendingScChanges[scId];
            return StoreStock.reload();
          }
          Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сохранить. Проверьте соединение.'));
          return null;
        }).then(function () {
          loadData().then(function () { openSection(state.section); });
        });
      });
    }

    content.querySelector('#stockExportBtn').addEventListener('click', function () {
      syncBuffer();
      var scId = curScId;
      var pend = pendSc();
      var stock = {};
      state.products.forEach(function (p) {
        var v = (pend[p.id] || {}).stock !== undefined ? String(pend[p.id].stock) : (StoreStock.count(scId, p.id) === null ? '' : String(StoreStock.count(scId, p.id)));
        if (v === '') return;
        var n = Number(v);
        if (isNaN(n)) return;
        if (!stock[scId]) stock[scId] = {};
        stock[scId][p.id] = n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии';
      });
      var payload = JSON.stringify({ updated: new Date().toISOString(), stock: stock }, null, 1);
      var blob = new Blob([payload], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'store-stock.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      Utils.showToast('⬇️ Файл store-stock.json скачан — загрузите его в репозиторий');
    });

    content.querySelector('#stockImportBtn').addEventListener('click', function () {
      content.querySelector('#stockImportFile').click();
    });
    content.querySelector('#stockImportFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var stock = (parsed && parsed.stock) || parsed || {};
          if (typeof stock !== 'object' || Array.isArray(stock)) throw new Error('bad format');
          var scId = curScId;
          if (stock[scId]) {
            if (!state.pendingScChanges[scId]) state.pendingScChanges[scId] = {};
            Object.keys(stock[scId]).forEach(function (pid) {
              var m = /(\d+)\s*шт/.exec(String(stock[scId][pid]));
              var val = m ? m[1] : (String(stock[scId][pid]).toLowerCase().indexOf('нет') === 0 ? '0' : '');
              if (!state.pendingScChanges[scId][pid]) state.pendingScChanges[scId][pid] = {};
              state.pendingScChanges[scId][pid].stock = val;
            });
            drawRows();
          }
          Utils.showToast('⬆️ Файл загружен в таблицу — проверьте и нажмите «Сохранить остатки»');
        } catch (err) {
          Utils.showToast('Не удалось прочитать JSON');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });
  }

  // ---------------- Поставки ----------------

  function storeSelectHtml(selectedId, allLabel) {
    var opts = '<option value="">' + h(allLabel || 'Общая (все филиалы)') + '</option>' +
      state.stores.map(function (s) {
        return '<option value="' + h(s.id) + '"' + (s.id === selectedId ? ' selected' : '') + '>' + h(s.name) + '</option>';
      }).join('');
    return '<select name="storeId">' + opts + '</select>';
  }

  function deliveryFormHtml(editing, editingId) {
    var prodOptions = state.products.map(function (p) {
      return '<option value="' + h(p.name) + '"></option><option value="' + h(p.sku) + '"></option>';
    }).join('');
    var itemRows = '';
    var srcItems = editing && editing.items;
    if (Array.isArray(srcItems)) {
      srcItems.forEach(function (it) {
        var name = typeof it === 'object' ? (it.name || '') : String(it);
        var sku = typeof it === 'object' ? (it.sku || '') : '';
        var qty = typeof it === 'object' ? (it.qty || '') : '';
        itemRows += '<div class="delivery-item-row">' +
          (sku ? '<code class="delivery-item-sku" title="Артикул">' + h(sku) + '</code>' : '') +
          '<input class="delivery-item-name" list="deliveryProductList" placeholder="Позиция — начните вводить название или артикул" value="' + h(name) + '"' +
          (sku ? ' data-sku="' + h(sku) + '" data-name="' + h(name) + '"' : '') + '>' +
          '<input class="delivery-item-qty" type="number" min="1" placeholder="Кол-во" value="' + h(qty) + '">' +
          '<button type="button" class="btn btn-outline btn-sm delivery-item-del">✕</button>' +
          '</div>';
      });
    }
    if (!itemRows) {
      itemRows = '<div class="delivery-item-row">' +
        '<input class="delivery-item-name" list="deliveryProductList" placeholder="Позиция — начните вводить название или артикул">' +
        '<input class="delivery-item-qty" type="number" min="1" placeholder="Кол-во">' +
        '<button type="button" class="btn btn-outline btn-sm delivery-item-del">✕</button>' +
        '</div>';
    }
    return '<form class="form admin-form" id="deliveryForm">' +
      '<h4 style="margin-bottom:10px;">' + (editing ? '✏️ Изменить поставку' : '➕ Новая поставка') + '</h4>' +
      (isSuper()
        ? '<div class="form-group"><label>Филиал</label>' + storeSelectHtml(editing ? editing.storeId || '' : (state.user && state.user.role === 'sc' ? state.user.id : '')) + '</div>'
        : '') +
      '<div style="display:grid; grid-template-columns:180px 1fr; gap:12px;">' +
      '<div class="form-group"><label>Дата *</label><input type="date" name="date" min="' + h(tomorrowStr()) + '" value="' + h(editing ? editing.date : '') + '" required></div>' +
      '<div class="form-group"><label>Описание *</label><input name="note" value="' + h(editing ? editing.note : '') + '" placeholder="Например: Поставка эко-порошков iLife" required></div>' +
      '</div>' +
      '<div class="form-group"><label>Что приедет (позиции)</label>' +
      '<datalist id="deliveryProductList">' + prodOptions + '</datalist>' +
      '<div id="deliveryItems">' + itemRows + '</div>' +
      '<button class="btn btn-outline btn-sm" type="button" id="deliveryItemAdd" style="margin-top:6px;">➕ Добавить позицию</button></div>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-primary" type="submit">' + (editing ? '💾 Сохранить' : '➕ Добавить') + '</button>' +
      (editing ? '<button class="btn btn-outline" type="button" id="deliveryCancelEdit">Отмена</button>' : '') +
      '</div>' +
      '</form>';
  }

  // Дата завтрашнего дня в формате YYYY-MM-DD (местное время)
  function tomorrowStr() {
    var d = new Date();
    d.setDate(d.getDate() + 1);
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  // Сравнение двух дат в формате YYYY-MM-DD (сегодняшняя строка — fromDateStr)
  function dateStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function renderDeliveries(content) {
    var editingId = state.editingDeliveryId;
    var editing = editingId ? state.deliveries.find(function (d) { return d.id === editingId; }) : null;

    // СЦ видит только свои поставки, суперадмин — все
    var visible = isSuper()
      ? state.deliveries
      : state.deliveries.filter(function (d) { return d.storeId === state.user.id; });

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-toolbar" style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-bottom:10px;">' +
      '<label class="del-tab-toggle"><input type="radio" name="delTab" value="manual" checked> Ручные поставки</label>' +
      '<label class="del-tab-toggle"><input type="radio" name="delTab" value="moves"> Накладные (парсер)</label>' +
      '</div>');
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card">' +
      '<ul class="admin-list" id="deliveryList"></ul>' +
      '<div class="admin-list-footer">' +
      '<button class="btn btn-primary" data-del-new>➕ Добавить поставку</button>' +
      '</div>' +
      '</div>');
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card hidden" id="movesListCard">' +
      '<p style="color:var(--muted); font-size:13px; margin-bottom:10px;">Накладные поставщика — собираются парсером автоматически, только просмотр. Обновляются по расписанию (11:00/14:00/17:00/20:00).</p>' +
      '<div id="movesList">Загружаем…</div>' +
      '</div>');
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card' + (editing ? '' : ' hidden') + '" id="deliveryFormCard">' +
      deliveryFormHtml(editing, editingId) +
      '</div>');

    var listEl = content.querySelector('#deliveryList');
    var movesCard = content.querySelector('#movesListCard');
    var movesListEl = content.querySelector('#movesList');

    // Переключатель «Ручные / Накладные»
    function renderMovesTab() {
      movesListEl.innerHTML = 'Загружаем…';
      fetch('data/moves.json').then(function (r) { return r.json(); }).then(function (d) {
        var moves = (d && d.moves) || [];
        var st = {
          0: { t: '🏭 Оформлена · ждёт отгрузки', c: '#b26a00', b: '#fff3cd' },
          4: { t: '🚚 В пути', c: '#004085', b: '#cce5ff' },
          7: { t: '✅ Прибыла', c: '#155724', b: '#d4edda' }
        };
        if (!moves.length) {
          movesListEl.innerHTML = '<div class="owner-req-empty">Накладных пока нет.</div>';
          return;
        }
        movesListEl.innerHTML = '<ul class="admin-list">' + moves.slice(0, 25).map(function (m) {
          var s = st[m.statusCode] || { t: 'Готовится к отправке', c: '#6b5410', b: '#fff8e6' };
          var itemsHtml = (m.items || []).map(function (it) {
            var p = state.products.find(function (x) { return x.id === it.sku; });
            var img = p ? adminImgUrl(p) : '';
            return '<span class="delivery-item-chip">' +
              (img ? '<img class="delivery-item-img" src="' + h(img) + '" alt="" onerror="this.style.display=\'none\'">' : '') +
              h(it.sku) + ' · ' + h(String(it.name || '').slice(0, 40)) + (it.qty ? ' · ' + h(it.qty) + ' шт' : '') +
              '</span>';
          }).join('');
          return '<li>' +
            '<div class="admin-list-main">' +
            '<strong>№' + h(m.number || '') + ' <span class="badge" style="background:' + s.b + ';color:' + s.c + ';">' + s.t + '</span></strong>' +
            '<span>📅 ' + h(m.date || '') + (m.time ? ' · ' + h(String(m.time).slice(11, 16)) : '') + (m.sum ? ' · 💰 ' + h(m.sum) + ' ₸' : '') + '</span>' +
            (itemsHtml ? '<div class="delivery-items-list" style="margin-top:6px;">' + itemsHtml + '</div>' : '<span class="muted-sku">Состав уточняется</span>') +
            '</div></li>';
        }).join('') + '</ul>';
      }).catch(function () {
        movesListEl.innerHTML = '<div class="owner-req-empty">Не удалось загрузить накладные.</div>';
      });
    }

    content.querySelectorAll('[name="delTab"]').forEach(function (radio) {
      radio.addEventListener('change', function () {
        var mode = radio.value;
        var manualBlock = content.querySelector('#deliveryList').closest('.admin-card');
        var formCard = content.querySelector('#deliveryFormCard');
        if (mode === 'moves') {
          manualBlock.classList.add('hidden');
          formCard.classList.add('hidden');
          movesCard.classList.remove('hidden');
          renderMovesTab();
        } else {
          movesCard.classList.add('hidden');
          manualBlock.classList.remove('hidden');
          if (editing) formCard.classList.remove('hidden');
        }
      });
    });

    function drawList() {
      listEl.innerHTML = visible.map(function (d) {
        var dt = Utils.fmtDate(d.date + 'T00:00:00', { day: 'numeric', month: 'long', year: 'numeric' });
        var storeName = d.storeId
          ? (function () { var s = state.stores.find(function (x) { return x.id === d.storeId; }); return s ? s.name : d.storeId; })()
          : 'Общая поставка';
        var itemsHtml = '';
        if (Array.isArray(d.items) && d.items.length) {
          itemsHtml = '<div class="delivery-items-list">' + d.items.map(function (it) {
            var name = typeof it === 'object' ? (it.name || '') : String(it);
            var qty = typeof it === 'object' ? (it.qty ? it.qty + ' шт' : '') : '';
            // Поставка/накладная: товар строго по артикулу (sku — ID товара)
            var p = null;
            if (typeof it === 'object' && it.sku) p = state.products.find(function (x) { return x.id === it.sku; }) || null;
            if (!p) p = Utils.productByArticle(state.products, name);
            var chip = '';
            if (p) {
              var img = adminImgUrl(p);
              chip = '<img class="delivery-item-img" src="' + h(img) + '" alt="' + h(p.name) + '" onerror="this.style.display=\'none\'">';
            } else {
              chip = '<span class="delivery-item-img delivery-item-clock" title="Фото появится, когда товар попадёт в каталог">⏳</span>';
            }
            return '<span class="delivery-item-chip">' + chip + h(name) + (qty ? ' · ' + h(qty) : '') + '</span>';
          }).join('') + '</div>';
        } else if (typeof d.items === 'string' && d.items) {
          itemsHtml = '<span class="muted-sku">📦 Прибудет: ' + h(d.items) + '</span>';
        }
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(dt) + ' <span style="font-weight:500; color:var(--green); font-size:12.5px;">· ' + h(storeName) + '</span></strong>' +
          '<span>' + h(d.note || '') + '</span>' +
          itemsHtml +
          '</div>' +
          '<div class="admin-actions">' +
          '<button class="btn btn-outline btn-sm" data-del-edit="' + h(d.id) + '">✏️ Изменить</button>' +
          '<button class="btn btn-outline btn-sm danger-btn" data-del-remove="' + h(d.id) + '">' + Utils.iconTrash(14) + 'Удалить</button>' +
          '</div></li>';
      }).join('') || '<li style="color:var(--muted);">Поставок пока нет — добавьте первую.</li>';
    }
    drawList();

    var form = content.querySelector('#deliveryForm');

    var newBtn = content.querySelector('[data-del-new]');
    if (newBtn) newBtn.addEventListener('click', function () {
      var card = content.querySelector('#deliveryFormCard');
      card.classList.remove('hidden');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      var f = card.querySelector('#deliveryForm');
      if (f && f.note) f.note.focus();
    });

    // Добавление/удаление позиций поставки
    var itemsWrap = content.querySelector('#deliveryItems');
    function addItemRow(name, qty) {
      var row = document.createElement('div');
      row.className = 'delivery-item-row';
      row.innerHTML = '<input class="delivery-item-name" list="deliveryProductList" placeholder="Позиция — начните вводить название или артикул" value="' + h(name || '') + '">' +
        '<input class="delivery-item-qty" type="number" min="1" placeholder="Кол-во" value="' + h(qty || '') + '">' +
        '<button type="button" class="btn btn-outline btn-sm delivery-item-del">✕</button>';
      itemsWrap.appendChild(row);
    }
    var addItemBtn = content.querySelector('#deliveryItemAdd');
    if (addItemBtn) addItemBtn.addEventListener('click', function () { addItemRow(); });
    itemsWrap.addEventListener('click', function (e) {
      var del = e.target.closest('.delivery-item-del');
      if (del) {
        if (itemsWrap.querySelectorAll('.delivery-item-row').length <= 1) return;
        del.closest('.delivery-item-row').remove();
      }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var storeId = isSuper() ? form.storeId.value : state.user.id;
      var dateVal = form.date.value;
      var noteVal = form.note.value.trim();
      var itemsList = [];
      itemsWrap.querySelectorAll('.delivery-item-row').forEach(function (row) {
        var nameInput = row.querySelector('.delivery-item-name');
        var name = nameInput.value.trim();
        if (!name) return;
        var qty = parseInt(row.querySelector('.delivery-item-qty').value, 10);
        if (isNaN(qty) || qty <= 0) qty = 1;
        // Артикул сохраняем: (а) у существующей позиции, если название не менялось;
        // (б) если введён артикул, совпавший со sku в каталоге
        var savedSku = nameInput.getAttribute('data-sku');
        var savedName = nameInput.getAttribute('data-name');
        if (savedSku && savedName === name) {
          itemsList.push({ sku: savedSku, name: name, qty: qty });
          return;
        }
        var m = state.products.find(function (x) { return String(x.sku).toLowerCase() === name.toLowerCase(); });
        itemsList.push(m ? { sku: m.sku, name: m.name, qty: qty } : { name: name, qty: qty });
      });
      if (!itemsList.length) {
        Utils.showToast('⚠️ Добавьте хотя бы одну позицию поставки');
        return;
      }
      if (dateVal < dateStr()) {
        Utils.showToast('⚠️ Дата поставки не может быть раньше сегодняшнего дня');
        return;
      }
      var item = {
        date: dateVal,
        note: noteVal,
        items: itemsList
      };
      if (storeId) item.storeId = storeId;
      if (editingId) {
        var idx = state.deliveries.findIndex(function (d) { return d.id === editingId; });
        if (idx >= 0) { item.id = editingId; state.deliveries[idx] = item; }
        state.editingDeliveryId = null;
        Utils.showToast('✅ Поставка обновлена');
      } else {
        item.id = 'del_' + Date.now();
        state.deliveries.unshift(item);
        Utils.showToast('✅ Поставка добавлена');
      }
      saveDeliveries(state.deliveries);
      openSection('deliveries');
    });

    var cancelBtn = content.querySelector('#deliveryCancelEdit');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      state.editingDeliveryId = null;
      openSection('deliveries');
    });

    listEl.addEventListener('click', function (e) {
      var editBtn = e.target.closest('[data-del-edit]');
      if (editBtn) { state.editingDeliveryId = editBtn.getAttribute('data-del-edit'); openSection('deliveries'); return; }
      var rmBtn = e.target.closest('[data-del-remove]');
      if (rmBtn) {
        var id = rmBtn.getAttribute('data-del-remove');
        if (!confirm('Удалить поставку?')) return;
        state.deliveries = state.deliveries.filter(function (d) { return d.id !== id; });
        saveDeliveries(state.deliveries);
        openSection('deliveries');
      }
    });
  }

  // ---------------- Мероприятия ----------------

  function renderEvents(content) {
    var editingId = state.editingEventId;
    var editing = editingId ? state.events.find(function (ev) { return ev.id === editingId; }) : null;

    var visible = isSuper()
      ? state.events
      : state.events.filter(function (ev) { return ev.storeId === state.user.id; });

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card">' +
      '<ul class="admin-list" id="eventList"></ul>' +
      '<div class="admin-list-footer">' +
      '<button class="btn btn-primary" data-ev-new>➕ Добавить мероприятие</button>' +
      '</div>' +
      '</div>');
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card' + (editing ? '' : ' hidden') + '" id="eventFormCard">' +
      '<form class="form admin-form" id="eventForm">' +
      '<h4 style="margin-bottom:10px;">' + (editing ? '✏️ Изменить мероприятие' : '➕ Новое мероприятие') + '</h4>' +
      (isSuper()
        ? '<div class="form-group"><label>Филиал</label>' + storeSelectHtml(editing ? editing.storeId || '' : '') + '</div>'
        : '') +
      '<div class="form-group"><label>Название *</label><input name="title" value="' + h(editing ? editing.title : '') + '" placeholder="Например: Презентация линейки SEALUX" required></div>' +
      '<div style="display:grid; grid-template-columns:160px 120px 1fr; gap:12px;">' +
      '<div class="form-group"><label>Дата *</label><input type="date" name="date" value="' + h(editing ? editing.date : '') + '" required></div>' +
      '<div class="form-group"><label>Время</label><input name="time" value="' + h(editing ? editing.time : '') + '" placeholder="14:00"></div>' +
      '<div class="form-group"><label>Место</label><input name="place" value="' + h(editing ? editing.place : '') + '" placeholder="Сервис-центр, демозал"></div>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns:1fr 140px; gap:12px;">' +
      '<div class="form-group"><label>Описание</label><textarea name="description">' + h(editing ? editing.description : '') + '</textarea></div>' +
      '<div class="form-group"><label>Мест</label><input type="number" name="slots" min="0" value="' + h(editing && editing.slots != null ? editing.slots : '') + '" placeholder="20"></div>' +
      '</div>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-primary" type="submit">' + (editing ? '💾 Сохранить' : '➕ Добавить') + '</button>' +
      (editing ? '<button class="btn btn-outline" type="button" id="eventCancelEdit">Отмена</button>' : '') +
      '</div>' +
      '</form>' +
      '</div>'
    );

    var listEl = content.querySelector('#eventList');

    function drawList() {
      var bookings = state.eventBookings || {};
      listEl.innerHTML = visible.map(function (ev) {
        var dt = Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long', year: 'numeric' });
        var storeName = ev.storeId
          ? (function () { var s = state.stores.find(function (x) { return x.id === ev.storeId; }); return s ? s.name : ev.storeId; })()
          : '';
        var booked = Number(bookings[String(ev.id)]) || 0;
        var remaining = ev.slots != null ? Math.max(0, ev.slots - booked) : null;
        var seatsTxt = 'Мест: ' + h(ev.slots != null ? ev.slots : '—');
        if (remaining !== null) seatsTxt += ' · Записалось: ' + booked + ' · Осталось: ' + remaining;
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(ev.title) + (storeName ? ' <span style="font-weight:500; color:var(--green); font-size:12.5px;">· ' + h(storeName) + '</span>' : '') + '</strong>' +
          '<span>' + h(dt) + ' · ' + h(ev.time || '') + ' · ' + h(ev.place || '') + ' · ' + seatsTxt + '</span>' +
          '</div>' +
          '<div class="admin-actions">' +
          '<button class="btn btn-outline btn-sm" data-ev-edit="' + h(ev.id) + '">✏️ Изменить</button>' +
          '<button class="btn btn-outline btn-sm danger-btn" data-ev-remove="' + h(ev.id) + '">' + Utils.iconTrash(14) + 'Удалить</button>' +
          '</div></li>';
      }).join('') || '<li style="color:var(--muted);">Мероприятий пока нет — добавьте первое.</li>';
    }
    drawList();

    var form = content.querySelector('#eventForm');

    var newEventBtn = content.querySelector('[data-ev-new]');
    if (newEventBtn) newEventBtn.addEventListener('click', function () {
      var card = content.querySelector('#eventFormCard');
      card.classList.remove('hidden');
      card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      var f = card.querySelector('#eventForm');
      if (f && f.title) f.title.focus();
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var storeId = isSuper() ? form.storeId.value : state.user.id;
      var dateVal = form.date.value;
      var timeVal = form.time.value.trim();
      var titleVal = form.title.value.trim();
      var placeVal = form.place.value.trim();
      if (!titleVal) {
        Utils.showToast('⚠️ Укажите название мероприятия');
        return;
      }
      if (!dateVal) {
        Utils.showToast('⚠️ Укажите дату мероприятия');
        return;
      }
      if (dateVal < dateStr()) {
        Utils.showToast('⚠️ Дата мероприятия не может быть раньше сегодняшнего дня');
        return;
      }
      var timeErr = '';
      if (timeVal) {
        var m = /^([0-9]{1,2}):([0-9]{2})$/.exec(timeVal);
        if (!m) timeErr = 'Время указывайте в формате ЧЧ:ММ (например 14:00)';
        else if (Number(m[1]) > 23 || Number(m[2]) > 59) timeErr = 'Время указывайте в формате ЧЧ:ММ (например 14:00)';
      }
      if (timeErr) {
        Utils.showToast('⚠️ ' + timeErr);
        return;
      }
      var item = {
        title: titleVal,
        date: dateVal,
        time: timeVal,
        place: placeVal,
        description: form.description.value.trim(),
        slots: form.slots.value ? parseInt(form.slots.value, 10) : null
      };
      if (storeId) item.storeId = storeId;
      if (editingId) {
        var idx = state.events.findIndex(function (x) { return x.id === editingId; });
        if (idx >= 0) { item.id = editingId; state.events[idx] = item; }
        state.editingEventId = null;
        Utils.showToast('✅ Мероприятие обновлено');
      } else {
        item.id = 'ev_' + Date.now();
        state.events.unshift(item);
        Utils.showToast('✅ Мероприятие добавлено');
      }
      saveEvents(state.events);
      openSection('events');
    });

    var cancelBtn = content.querySelector('#eventCancelEdit');
    if (cancelBtn) cancelBtn.addEventListener('click', function () {
      state.editingEventId = null;
      openSection('events');
    });

    listEl.addEventListener('click', function (e) {
      var editBtn = e.target.closest('[data-ev-edit]');
      if (editBtn) { state.editingEventId = editBtn.getAttribute('data-ev-edit'); openSection('events'); return; }
      var rmBtn = e.target.closest('[data-ev-remove]');
      if (rmBtn) {
        var id = rmBtn.getAttribute('data-ev-remove');
        if (!confirm('Удалить мероприятие?')) return;
        state.events = state.events.filter(function (x) { return x.id !== id; });
        saveEvents(state.events);
        openSection('events');
      }
    });
  }

  // ---------------- Заявки (суперадмин, Worker KV) ----------------

  function renderApplications(content) {
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card">' +
      '<p style="color:var(--muted); font-size:13.5px; margin-bottom:12px;">Заявки приходят из формы «Войти» → «Регистрация Сервис-Центра». Обычные заявки партнёров помечены 🤝, заявки с кабинетом поставщика — 🏬 (остатки будут парситься автоматически).</p>' +
      '<div id="scAppsList">Загружаем заявки…</div>' +
      '</div>'
    );

    Auth.api('/api/sc-applications').then(function (data) {
      var apps = (data && data.applications) || [];
      var scApps = apps.filter(function (a) { return a.type !== 'client'; });
      var listEl = content.querySelector('#scAppsList');
      if (!scApps.length) {
        listEl.innerHTML = '<div class="owner-req-empty">Заявок пока нет. Новые заявки появятся здесь автоматически.</div>';
      } else {
        listEl.innerHTML = '<ul class="admin-list">' + scApps.map(function (a) {
          var isSc = a.type === 'sc_registration' || a.hasCabinet;
          var badge = a.status === 'pending' ? '⏳ На рассмотрении' : (a.status === 'rejected' ? '❌ Отклонена' : '✅ Одобрена');
          var typeTag = isSc ? '🏬 Сервис-Центр' : '🤝 Магазин-партнёр';
          return '<li>' +
            '<div class="admin-list-main">' +
            '<strong>' + h(a.storeName || 'Магазин') + ' <span style="font-weight:400; font-size:12.5px; color:var(--muted);">' + h(badge) + ' · ' + typeTag + '</span></strong>' +
            '<span>👤 ' + h(a.name || '') + ' · 📞 ' + h(a.phone || '') + (a.email ? ' · 📧 ' + h(a.email) : '') + '</span>' +
            (isSc && a.officeCode ? '<span>🔑 Код кабинета: <b>' + h(a.officeCode) + '</b></span>' : '') +
            '<span>📍 ' + h(a.city || '') + (a.address ? ', ' + h(a.address) : '') + '</span>' +
            (isSc ? '<span style="color:var(--muted);">👤 Логин поставщика: ' + h(a.portalLogin || '—') + '</span>' : '') +
            (a.comment ? '<span style="color:var(--muted);">«' + h(a.comment) + '»</span>' : '') +
            '<span style="color:var(--muted); font-size:12px;">🕐 ' + h(new Date(a.createdAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })) + '</span>' +
            '</div>' +
            '<div class="admin-actions" style="flex-wrap:wrap;">' +
            (a.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-sc-app-approve="' + h(a.id) + '">✅ Одобрить</button>' : '') +
            (a.status === 'pending' ? '<button class="btn btn-outline btn-sm" data-sc-app-edit="' + h(a.id) + '">✏️ Редактировать перед созданием</button>' : '') +
            (a.status !== 'approved' && a.status !== 'rejected' ? '<button class="btn btn-outline btn-sm danger-btn" data-sc-app-reject="' + h(a.id) + '">🚫 Отклонить</button>' : '') +
            '</div></li>';
        }).join('') + '</ul>';
      }

      listEl.addEventListener('click', function (e) {
        var approveBtn = e.target.closest('[data-sc-app-approve]');
        if (approveBtn) {
          var app = scApps.find(function (x) { return x.id === approveBtn.getAttribute('data-sc-app-approve'); });
          if (!app) return;
          var isSc = app.type === 'sc_registration' || app.hasCabinet;
          if (!confirm(isSc
            ? 'Создать карточку СЦ «' + app.storeName + '» из заявки? Доступы к кабинету сгенерируются — передайте их владельцу лично.'
            : 'Одобрить заявку партнёра «' + app.storeName + '»? Карточка магазина появится в «Сервис-Центрах».')) return;
          Auth.api('/api/sc-application', { method: 'POST', body: JSON.stringify({ id: app.id, action: 'approve', create: true }) }).then(function (res) {
            if (res && res.store) {
              Utils.showToast(isSc ? '✅ СЦ создан: ' + res.store.name : '✅ Магазин-партнёр добавлен: ' + res.store.name);
            } else {
              Utils.showToast('✅ Заявка одобрена');
            }
            openSection('applications');
          });
          return;
        }
        var editBtn = e.target.closest('[data-sc-app-edit]');
        if (editBtn) {
          var appEdit = scApps.find(function (x) { return x.id === editBtn.getAttribute('data-sc-app-edit'); });
          if (!appEdit) return;
          state.lastAppId = appEdit.id;
          state.editingStoreId = 'new';
          state.newStoreFromApp = appEdit;
          openSection('sc');
          return;
        }
        var rejectBtn = e.target.closest('[data-sc-app-reject]');
        if (rejectBtn) {
          var app2 = scApps.find(function (x) { return x.id === rejectBtn.getAttribute('data-sc-app-reject'); });
          if (!app2) return;
          if (!confirm('Отклонить заявку «' + app2.storeName + '»?')) return;
          Auth.api('/api/sc-application', { method: 'POST', body: JSON.stringify({ id: app2.id, action: 'reject' }) }).then(function () {
            Utils.showToast('🚫 Заявка отклонена');
            openSection('applications');
          });
        }
      });
    });
  }

  // ---------------- Заказы (СЦ и суперадмин) ----------------
  // Остаток = факт(парсер) − активные заказы. Подтверждение = резерв переходит в
  // продажу (после синка парсера заказ уходит в архив), отмена возвращает товар.

  function renderOrders(content) {
    var orderStoreFilter = state.orderStoreFilter || 'all';
    var showArchive = isSuper() && !!state.orderShowArchive;
    var storeOptions = '<option value="all">Все филиалы</option>' + state.stores.map(function (s) {
      return '<option value="' + h(s.id) + '"' + (orderStoreFilter === s.id ? ' selected' : '') + '>' + h(s.name) + '</option>';
    }).join('');

    // Тулбар с фильтром/архивом — только у суперадмина: для СЦ он был бы
    // пустой серой плашкой между подсказкой и списком.
    var toolbarHtml = isSuper()
      ? '<div class="admin-toolbar">' +
        '<label style="font-weight:600; font-size:13.5px;">Филиал:</label><select id="orderStoreFilter">' + storeOptions + '</select>' +
        '<label class="form-checkbox" style="margin:0;"><input type="checkbox" id="orderArchiveToggle"' + (showArchive ? ' checked' : '') + '> Архив подтверждённых</label>' +
        '</div>'
      : '';

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">🛒 Активные заказы сайта: <b>новые</b> держат резерв товара, <b>подтверждённые</b> — состоявшиеся продажи (после синка парсера уходят в архив и на остаток не влияют), <b>отменённые</b> возвращают товар. Удаление подтверждённого заказа <b>не</b> возвращает товар.</div>' +
      toolbarHtml +
      '<div class="admin-card"><div id="ordersList">Загружаем заказы…</div></div>'
    );

    var load = function () {
      var showArchive = isSuper() && !!state.orderShowArchive;
      var url = '/api/orders' + (showArchive ? '?archive=1' : '');
      Auth.api(url).then(function (d) {
        var orders = (d && d.orders) || [];
        // Фильтр по филиалу (суперадмин): применяем к загруженному списку
        var sf = state.orderStoreFilter;
        if (isSuper() && sf && sf !== 'all') {
          orders = orders.filter(function (o) { return String(o.storeId) === sf; });
        }
        var listEl = content.querySelector('#ordersList');
        if (!orders.length) {
          listEl.innerHTML = '<div class="owner-req-empty">' + (showArchive ? 'Архив пуст.' : 'Заказов пока нет.') + '</div>';
          return;
        }
        var byId = {};
        (state.products || []).forEach(function (p) { byId[p.id] = p; });
        var storeName = {};
        state.stores.forEach(function (s) { storeName[s.id] = s.name; });
        listEl.innerHTML = '<ul class="admin-list">' + orders.map(function (o) {
          var statusBadge = o.status === 'new' ? '<span class="badge" style="background:#fff3cd;color:#8a6d00;">' + Utils.icon('clock', 14) + ' Новый</span>'
            : (o.status === 'ready' ? '<span class="badge" style="background:#cce5ff;color:#004085;">' + Utils.icon('package', 14) + ' Готов к выдаче</span>'
              : (o.status === 'confirmed' ? '<span class="badge" style="background:#d4edda;color:#155724;">' + Utils.icon('check', 14) + ' Подтверждён</span>'
                : '<span class="badge" style="background:#f8d7da;color:#721c24;">' + Utils.icon('x', 14) + ' Отменён</span>'));
          var itemsHtml = (o.items || []).map(function (i) {
            var p = byId[i.productId];
            var img = p ? adminImgUrl(p) : '';
            var name = i.name || (p ? p.name : '') || i.sku || i.productId;
            var unit = Number(i.price) || 0;
            var subtotal = unit ? (unit * (Number(i.qty) || 1)) : 0;
            return '<span class="delivery-item-row order-receipt-row">' +
              (img ? '<img class="delivery-item-img order-receipt-img" src="' + h(img) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\'">' : '') +
              '<span class="order-receipt-name">' + h(name) + '</span>' +
              (unit ? '<span class="order-receipt-price">' + h(String(unit).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) + ' ₸ × ' + h(i.qty) + ' = <b>' + h(String(subtotal).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) + ' ₸</b></span>' : '<span class="order-receipt-price">× ' + h(i.qty) + '</span>') +
              '</span>';
          }).join('');
          var totalTxt = o.total ? '<span>💰 Итого: <b>' + h(String(o.total).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')) + ' ₸</b></span>' : '';
          var payTxt = o.payment ? '<span>💳 ' + h(o.payment) + '</span>' : '';
          var pickupTxt = o.pickupDate ? '<span>📅 Забрать: ' + h(o.pickupDate) + (o.pickupTime ? ' в ' + h(o.pickupTime) : '') + '</span>' : '';
          // Партнёрская скидка — приглушённый текст в строке метаданных, а не яркая плашка
          var partnerTxt = o.partnerMode ? '<span class="order-partner-txt">🎫 Партнёрская цена (−50%)</span>' : '';
          var noteTxt = o.managerNote ? '<span style="color:var(--muted);">💬 Менеджер: ' + h(o.managerNote) + '</span>' : '';
          var canResolve = o.status === 'new' || o.status === 'ready';
          var dispNum = o.number ? ('#' + o.number) : o.id;
          return '<li>' +
            '<div class="admin-list-main">' +
            '<strong>' + (o.number ? 'Заказ #' + h(o.number) : 'Заказ ' + h(o.id)) + ' ' + statusBadge + '</strong>' +
            '<span>👤 ' + h(o.name || '—') + (o.phone ? ' · 📞 ' + h(o.phone) : '') + '</span>' +
            '<span>🏬 ' + h(storeName[o.storeId] || o.storeId || '—') + ' · 🕐 ' + h(new Date(o.createdAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })) + '</span>' +
            '<div class="delivery-items order-receipt" style="margin:6px 0 0; display:flex; flex-direction:column; align-items:flex-start; gap:4px;">' + itemsHtml + '</div>' +
            '<span style="font-size:13px;color:var(--muted); display:flex; flex-wrap:wrap; gap:6px; align-items:center;">' + [totalTxt, payTxt, partnerTxt, pickupTxt].filter(Boolean).join('') + '</span>' +
            (o.comment ? '<span style="color:var(--muted);">💬 Клиент: ' + h(o.comment) + '</span>' : '') +
            noteTxt +
            '</div>' +
            '<div class="admin-actions" style="flex-wrap:wrap;">' +
            (o.status === 'new' ? '<button class="btn btn-outline btn-sm" data-order-ready="' + h(o.id) + '">' + Utils.icon('package', 14) + ' Готов к выдаче</button>' : '') +
            (canResolve ? '<button class="btn btn-primary btn-sm" data-order-confirm="' + h(o.id) + '">' + Utils.icon('check', 14) + ' Подтвердить</button>' : '') +
            (canResolve ? '<button class="btn btn-outline btn-sm btn-neutral" data-order-cancel="' + h(o.id) + '">' + Utils.icon('x', 14) + ' Отменить</button>' : '') +
            '<span class="admin-more">' +
            '<button class="btn btn-outline btn-sm btn-icon" type="button" data-more-open="' + h(o.id) + '" aria-label="Ещё действия" title="Ещё действия">' + Utils.icon('more', 16) + '</button>' +
            '<span class="admin-more-menu hidden"><button class="admin-more-item danger" type="button" data-order-delete="' + h(o.id) + '">' + Utils.iconTrash(14) + ' Удалить заказ</button></span>' +
            '</span>' +
            '</div></li>';
        }).join('') + '</ul>';

        // onclick (а не addEventListener): load() вызывается многократно, а
        // element «ordersList» сохраняется — addEventListener копил бы обработчики
        // и каждое нажатие открывало бы confirm по нескольку раз подряд.
        listEl.onclick = function (e) {
          // Меню «⋯»: открыть/закрыть
          var moreBtn = e.target.closest('[data-more-open]');
          if (moreBtn) {
            var wrap = moreBtn.closest('.admin-more');
            var menu = wrap ? wrap.querySelector('.admin-more-menu') : null;
            if (menu) menu.classList.toggle('hidden');
            return;
          }
          var btn = e.target.closest('[data-order-confirm],[data-order-cancel],[data-order-delete],[data-order-ready]');
          if (!btn) return;
          var oid = btn.hasAttribute('data-order-ready') ? btn.getAttribute('data-order-ready')
            : btn.getAttribute('data-order-' + (btn.hasAttribute('data-order-confirm') ? 'confirm' : (btn.hasAttribute('data-order-cancel') ? 'cancel' : 'delete')));
          var action = btn.hasAttribute('data-order-ready') ? 'ready' : (btn.hasAttribute('data-order-confirm') ? 'confirm' : (btn.hasAttribute('data-order-cancel') ? 'cancel' : 'delete'));
          var dispNum = '#?';
          var orderRow = orders.find(function (x) { return x.id === oid; });
          if (orderRow) dispNum = orderRow.number ? ('#' + orderRow.number) : oid;
          var label = action === 'ready' ? 'Отметить заказ ' + dispNum + ' готовым к выдаче? Клиент увидит статус в «Моих заказах».' :
            (action === 'confirm' ? 'Подтвердить заказ ' + dispNum + '? Товар считается проданным и не вернётся в остаток.' :
              (action === 'cancel' ? 'Отменить заказ ' + dispNum + '? Зарезервированный товар вернётся в доступное.' : 'Удалить заказ ' + dispNum + '? Подтверждённый заказ удаляется без возврата товара.'));
          if (!confirm(label)) return;
          // Защита от двойного клика: список перерендерится после действия
          btn.disabled = true;
          // Необязательный комментарий для клиента (виден в «Моих заказах»)
          var comment = '';
          if (action !== 'delete') {
            comment = prompt('Комментарий для клиента (необязательно):', '') || '';
          }
          var payload = { id: oid, action: action };
          if (comment) payload.comment = comment.trim();
          Auth.api('/api/orders/action', { method: 'POST', body: JSON.stringify(payload) }).then(function (res) {
            if (res && res.ok) {
              Utils.showToast(action === 'ready' ? 'Заказ готов к выдаче' : (action === 'confirm' ? '✅ Заказ подтверждён' : (action === 'cancel' ? '🚫 Заказ отменён' : '🗑 Заказ удалён')));
            } else {
              Utils.showToast((res && res.error) || '⚠️ Не удалось выполнить. Войдите заново (сессия истекла).');
            }
            load();
          }).catch(function () {
            Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз');
            btn.disabled = false;
          });
        };
      }).catch(function () {
        content.querySelector('#ordersList').innerHTML = '<div class="owner-req-empty">Не удалось загрузить заказы. Войдите заново.</div>';
      });
    };

    var filterEl = content.querySelector('#orderStoreFilter');
    if (filterEl) filterEl.addEventListener('change', function () {
      state.orderStoreFilter = filterEl.value;
      load();
    });
    var archiveToggle = content.querySelector('#orderArchiveToggle');
    if (archiveToggle) archiveToggle.addEventListener('change', function () {
      state.orderShowArchive = archiveToggle.checked;
      load();
    });

    // Закрытие меню «⋯» при клике вне него (один слушатель на документ)
    if (!window.__adminMoreMenusBound) {
      window.__adminMoreMenusBound = true;
      document.addEventListener('click', function (ev) {
        if (ev.target.closest('.admin-more')) return;
        document.querySelectorAll('.admin-more-menu:not(.hidden)').forEach(function (m) {
          m.classList.add('hidden');
        });
      });
    }

    load();
  }

  // ---------------- Товары (суперадмин) ----------------

  function renderProducts(content) {
    var settings = state.siteSettings || {};
    var PRIO_OPTIONS = [
      ['', '— без приоритета'],
      ['1', '1 · 🔥 Хит'],
      ['2', '2 · ✨ Новинка'],
      ['3', '3 · 🚀 Топ']
    ];

    function allCats() {
      var set = {};
      (settings.categories || []).forEach(function (c) { if (c) set[c] = true; });
      state.products.forEach(function (p) { if (p.category) set[p.category] = true; });
      return Object.keys(set).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
    }

    function catOptionsHtml(selected) {
      var opts = allCats().map(function (c) {
        return '<option value="' + h(c) + '"' + (c === selected ? ' selected' : '') + '>' + h(c) + '</option>';
      });
      opts.push('<option value="__new__">➕ Новая категория…</option>');
      return opts.join('');
    }

    function prioValue(p) {
      // Свежие оверрайды (KV, /api/admin/products без кеша) — в приоритете над
      // закешированным каталогом: после сохранения панель сразу показывает бейдж.
      // Несохранённая правка из буфера — самая свежая.
      var pend = state.pendingProductChanges[p.id] || {};
      if (pend.priority !== undefined) return String(pend.priority);
      var o = state.productOverrides[p.id] || {};
      if (o.priority != null && o.priority !== '') return String(o.priority);
      if (o.hit) return '1';
      if (p.priority != null && p.priority !== '') return String(p.priority);
      return p.hit ? '1' : '';
    }

    function prioBadgeChip(p) {
      var v = prioValue(p);
      if (v === '1') return ' <span class="badge-hot badge-p1">🔥 Хит</span>';
      if (v === '2') return ' <span class="badge-hot badge-p2">✨ Новинка</span>';
      if (v === '3') return ' <span class="badge-hot badge-p3">🚀 Топ</span>';
      return '';
    }

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-toolbar">' +
      '<input class="search" id="prodSearch" type="search" placeholder="Поиск по названию или артикулу…" autocomplete="off">' +
      '<select id="prodCatFilter"><option value="all">Все категории</option>' +
      allCats().map(function (c) { return '<option value="' + h(c) + '">' + h(c) + '</option>'; }).join('') +
      '</select>' +
      '<button class="btn btn-outline" id="prodResetBtn" style="margin-left:auto;">🧹 Сбросить мои правки</button>' +
      '</div>' +
      '<div class="admin-add-buttons">' +
      '<button class="btn btn-primary" id="prodAddBtn">➕ Добавить новый товар</button>' +
      '<button class="btn btn-outline" id="prodAddCatBtn">➕ Добавить категорию</button>' +
      '</div>' +
      '<div class="admin-card admin-table-wrap">' +
      '<div class="admin-pager pager-top" id="prodPagerTop"></div>' +
      '<table class="admin-table"><thead><tr>' +
      '<th>Фото</th><th style="min-width:200px;">Название</th><th>Артикул</th><th style="min-width:180px;">Описание</th><th>Категория</th><th>Цена ₸</th><th>Приоритет</th><th style="min-width:110px;">Скидка на сайте</th><th style="width:46px;"></th>' +
      '</tr></thead><tbody id="prodTbody"></tbody></table>' +
      '<div class="admin-pager" id="prodPager"></div>' +
      '</div>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<button class="btn btn-primary" id="prodSaveBtn">💾 Сохранить изменения</button>' +
      '<button class="btn btn-outline" id="prodScBtn">📦 Наличие товаров в СЦ</button>' +
      '</div>' +
      '<p style="margin-top:10px; font-size:13px; color:var(--muted);">Приоритет: 🔥 Хит — 1, ✨ Новинка — 2, 🚀 Топ — 3 (меньше число — выше в каталоге). «Скидка на сайте» включает скидочную цену товара для всех посетителей. Статус (наличие) задаётся в разделе «Наличие товаров в СЦ» для каждого филиала отдельно. Пустые поля не меняют данные.</p>'
    );

    function pendValue(p, field, baseVal) {
      var pend = state.pendingProductChanges[p.id] || {};
      if (pend[field] !== undefined) return pend[field];
      return baseVal;
    }

    function drawRows() {
      var q = (state.productSearch || '').trim().toLowerCase();
      var cat = state.productCatFilter || 'all';
      var list = state.products.filter(function (p) {
        if (cat !== 'all' && p.category !== cat) return false;
        return !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      });
      var info = pageSlice(list, state.productPage);
      state.productPage = info.page;
      var rows = info.items.map(function (p) {
        var o = state.productOverrides[p.id] || {};
        var changed = Object.keys(o).some(function (k) { return k !== 'hidden' && k !== 'discount_price'; }) ? ' style="outline:1px solid var(--green); outline-offset:-1px;"' : '';
        var isHidden = !!p.hidden;
        var isCustom = !!p.custom;
        var img = adminImgUrl(p);
        var delBtn = isCustom
          ? '<button class="btn btn-outline btn-sm" data-prod-del="' + h(p.id) + '" title="Удалить карточку из базы">🗑</button>'
          : (isHidden
            ? '<button class="btn btn-outline btn-sm" data-prod-restore="' + h(p.id) + '" title="Вернуть на сайт">↩️</button>'
            : '<button class="btn btn-outline btn-sm" data-prod-del="' + h(p.id) + '" title="Скрыть с сайта">🗑</button>');
        var descVal = pendValue(p, 'description', p.description || '');
        var catVal = pendValue(p, 'category', p.category || '');
        var priceVal = pendValue(p, 'price', p.price != null ? p.price : '');
        var showDisc = pendValue(p, 'showDiscount', p.showDiscount !== false);
        return '<tr' + (isHidden ? ' class="row-hidden"' : '') + changed + '>' +
          '<td><img class="admin-thumb" src="' + h(img) + '" alt="' + h(p.name) + '" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\';"></td>' +
          '<td><strong>' + h(p.name) + '</strong>' + prioBadgeChip(p) + (isCustom ? ' <span class="admin-sc-tag">🖊 ручной</span>' : '') + (isHidden ? ' <span class="badge st-out">скрыт</span>' : '') + '</td>' +
          '<td class="muted-sku">' + h(p.sku) + '</td>' +
          '<td><input class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="description" data-init="' + h(descVal) + '" value="' + h(descVal) + '"></td>' +
          '<td><select class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="category" data-init="' + h(catVal) + '">' + catOptionsHtml(catVal) + '</select></td>' +
          '<td><input class="cat-input" type="number" min="0" data-cat-prod="' + h(p.id) + '" data-cat-field="price" data-init="' + h(priceVal) + '" value="' + h(priceVal) + '"></td>' +
          '<td><select class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="priority" data-init="' + h(prioValue(p)) + '">' +
          PRIO_OPTIONS.map(function (pr) {
            return '<option value="' + pr[0] + '"' + (prioValue(p) === pr[0] ? ' selected' : '') + '>' + pr[1] + '</option>';
          }).join('') +
          '</select></td>' +
          '<td style="text-align:center;"><input type="checkbox" data-cat-prod="' + h(p.id) + '" data-cat-field="showDiscount" data-init="' + (showDisc ? '1' : '0') + '" ' + (showDisc ? 'checked' : '') + ' title="Показывать скидочную цену на сайте"></td>' +
          '<td>' + delBtn + '</td>' +
          '</tr>';
      }).join('');
      document.getElementById('prodTbody').innerHTML = rows || '<tr><td colspan="9" style="color:var(--muted);">Ничего не найдено.</td></tr>';
      var pagerHtmlStr = info.pages > 1 ? pagerHtml(info) : '<span class="pager-info">Показано ' + (info.total ? (info.start + 1) + '–' + info.end : 0) + ' из ' + info.total + '</span>';
      ['prodPager', 'prodPagerTop'].forEach(function (id) {
        var pager = document.getElementById(id);
        if (pager) pager.innerHTML = pagerHtmlStr;
      });
    }

    drawRows();
    content.querySelector('#prodSearch').addEventListener('input', function (e) {
      state.productSearch = e.target.value;
      state.productPage = 0;
      drawRows();
    });
    content.querySelector('#prodCatFilter').addEventListener('change', function (e) {
      state.productCatFilter = e.target.value;
      state.productPage = 0;
      drawRows();
    });

    // Несохранённые правки живут в буфере, чтобы переживать смену страницы/поиск
    var prodTbody = document.getElementById('prodTbody');
    prodTbody.addEventListener('input', function (e) {
      var el = e.target.closest('[data-cat-prod]');
      if (!el) return;
      var pid = el.getAttribute('data-cat-prod');
      var field = el.getAttribute('data-cat-field');
      if (!state.pendingProductChanges[pid]) state.pendingProductChanges[pid] = {};
      state.pendingProductChanges[pid][field] = el.type === 'checkbox' ? el.checked : el.value;
    });
    ['prodPager', 'prodPagerTop'].forEach(function (id) {
      var prodPager = document.getElementById(id);
      prodPager.addEventListener('click', function (e) {
        var go = e.target.closest('[data-page-go]');
        if (go) {
          state.productPage = parseInt(go.getAttribute('data-page-go'), 10) || 0;
          drawRows();
          content.querySelector('.admin-table-wrap').scrollIntoView({ block: 'start' });
        }
      });
    });

    // Создание категории: сохраняет в settings и обновляет фильтр; false при отмене/ошибке
    function ensureCategory(newCat) {
      if (!newCat) return Promise.resolve(false);
      if (settings.categories.indexOf(newCat) !== -1) return Promise.resolve(true);
      settings.categories.push(newCat);
      settings.categories.sort(function (a, b) { return a.localeCompare(b, 'ru'); });
      return Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'settings', categories: settings.categories }) })
        .then(function () {
          var f = content.querySelector('#prodCatFilter');
          if (f) {
            f.innerHTML = '<option value="all">Все категории</option>' +
              allCats().map(function (c) { return '<option value="' + h(c) + '">' + h(c) + '</option>'; }).join('');
          }
          return true;
        })
        .catch(function () {
          Utils.showToast('⚠️ Не удалось создать категорию — проверьте соединение');
          return false;
        });
    }

    // Категория: выбор существующей или «➕ Новая категория…»
    document.getElementById('prodTbody').addEventListener('change', function (e) {
      var sel = e.target.closest('[data-cat-field="category"]');
      if (!sel || sel.value !== '__new__') return;
      var prodId = sel.getAttribute('data-cat-prod');
      var resetSel = function () {
        var p = state.products.find(function (x) { return x.id === prodId; });
        sel.value = p && p.category ? p.category : '';
      };
      var newCat = window.prompt('Название новой категории:');
      if (newCat === null) { resetSel(); return; }
      newCat = String(newCat).trim();
      if (!newCat) { resetSel(); return; }
      ensureCategory(newCat).then(function (ok) {
        if (!ok) { resetSel(); return; }
        var p = state.products.find(function (x) { return x.id === prodId; });
        if (p) p.category = newCat;
        drawRows();
        Utils.showToast('✅ Категория «' + newCat + '» создана — нажмите «Сохранить изменения»');
      });
    });

    content.querySelector('#prodAddCatBtn').addEventListener('click', function () {
      var newCat = window.prompt('Название новой категории:');
      if (newCat === null) return;
      newCat = String(newCat).trim();
      if (!newCat) return;
      ensureCategory(newCat).then(function (ok) {
        if (!ok) return;
        drawRows();
        Utils.showToast('✅ Категория «' + newCat + '» создана');
      });
    });

    // Удаление/возврат карточек: ручные — из базы, базовые — скрытие с сайта
    document.getElementById('prodTbody').addEventListener('click', function (e) {
      var delBtn = e.target.closest('[data-prod-del]');
      if (delBtn) {
        var id = delBtn.getAttribute('data-prod-del');
        var p = state.products.find(function (x) { return x.id === id; });
        if (!p) return;
        if (p.custom) {
          if (!confirm('Удалить ручную карточку товара «' + p.name + '» из базы?')) return;
          Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'custom-delete', sku: p.sku }) })
            .then(function (res) {
              if (res && res.ok) {
                Utils.showToast('🗑 Карточка «' + p.name + '» удалена');
                loadData().then(function () { openSection(state.section); });
              } else {
                Utils.showToast('⚠️ Не удалось удалить. Войдите заново (сессия истекла).');
              }
            })
            .catch(function () { Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз'); });
        } else {
          if (!confirm('Скрыть товар «' + p.name + '» с сайта? Его можно вернуть кнопкой ↩️.')) return;
          var u = {};
          u[id] = { hidden: true };
          Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'save', updates: u }) })
            .then(function (res) {
              if (res && res.ok) {
                var pr = state.products.find(function (x) { return x.id === id; });
                if (pr) pr.hidden = true;
                if (!state.productOverrides[id]) state.productOverrides[id] = {};
                state.productOverrides[id].hidden = true;
                drawRows();
                Utils.showToast('🚫 Товар скрыт с сайта');
              } else {
                Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сохранить. Проверьте соединение.'));
              }
            })
            .catch(function () { Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз'); });
        }
        return;
      }
      var restoreBtn = e.target.closest('[data-prod-restore]');
      if (restoreBtn) {
        var rid = restoreBtn.getAttribute('data-prod-restore');
        var u2 = {};
        u2[rid] = { hidden: false };
        Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'save', updates: u2 }) })
          .then(function (res) {
            if (res && res.ok) {
              var pr2 = state.products.find(function (x) { return x.id === rid; });
              if (pr2) pr2.hidden = false;
              if (state.productOverrides[rid]) delete state.productOverrides[rid].hidden;
              drawRows();
              Utils.showToast('✅ Товар снова виден на сайте');
            } else {
              Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сохранить. Проверьте соединение.'));
            }
          })
          .catch(function () { Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз'); });
      }
    });

    // «➕ Добавить новый товар» — модалка
    function openCustomProductModal() {
      var catOpts = allCats().length
        ? allCats().map(function (c) { return '<option value="' + h(c) + '">' + h(c) + '</option>'; }).join('')
        : '<option value="Прочее">Прочее</option>';
      var prioOpts = PRIO_OPTIONS.map(function (pr) { return '<option value="' + pr[0] + '">' + pr[1] + '</option>'; }).join('');
      Utils.openModal(
        '<h3 style="margin-bottom:10px;">➕ Новый товар</h3>' +
        '<form class="form" id="customProductForm">' +
        '<div class="form-group"><label>Артикул * (например ABC123)</label><input name="sku" required placeholder="ABC123" autocomplete="off"></div>' +
        '<div class="form-group"><label>Название *</label><input name="name" required></div>' +
        '<div class="form-group"><label>Категория</label><select name="category">' + catOpts + '</select>' +
        '<p class="form-note" style="margin-top:4px;">Новая категория создаётся кнопкой «➕ Добавить категорию» над таблицей.</p></div>' +
        '<div class="form-group"><label>Описание</label><textarea name="description" rows="3"></textarea></div>' +
        '<div class="form-group"><label>Цена ₸ *</label><input name="price" type="number" min="0" step="1" required>' +
        '<p class="form-note" style="margin-top:4px;">Скидка −50% действует на товар автоматически, как и на все товары каталога.</p></div>' +
        '<div class="form-group"><label>Приоритет</label><select name="priority">' + prioOpts + '</select></div>' +
        '<div class="admin-actions"><button class="btn btn-primary" type="submit">💾 Сохранить товар</button></div>' +
        '</form>'
      );
      var form = document.getElementById('customProductForm');
      form.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var d = {};
        ['sku', 'name', 'category', 'description', 'price', 'priority'].forEach(function (k) {
          var el = form[k];
          if (el) d[k] = el.value.trim();
        });
        if (!d.sku || !d.name || d.price === '') {
          Utils.showToast('⚠️ Заполните артикул, название и цену');
          return;
        }
        var btn = form.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = '⏳ Сохраняем…';
        Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'custom', product: d }) })
          .then(function (res) {
            if (!res || !res.ok) throw new Error((res && res.error) || 'save error');
            Utils.closeModal();
            Utils.showToast('✅ Товар «' + d.name + '» добавлен — парсер найдёт его по артикулу');
            return loadData().then(function () { openSection(state.section); });
          })
          .catch(function (err) {
            btn.disabled = false;
            btn.textContent = '💾 Сохранить товар';
            Utils.showToast('⚠️ ' + ((err && err.message) || 'Не удалось сохранить'));
          });
      });
    }
    content.querySelector('#prodAddBtn').addEventListener('click', openCustomProductModal);

    content.querySelector('#prodSaveBtn').addEventListener('click', function () {
      // 1. Синхронизируем текущую страницу в буфер (на случай, если событие
      //    input не сработало), убираем поля, возвращённые к исходному виду
      content.querySelectorAll('[data-cat-prod]').forEach(function (el) {
        var prodId = el.getAttribute('data-cat-prod');
        var field = el.getAttribute('data-cat-field');
        var init = el.getAttribute('data-init') || '';
        var val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
        if (!state.pendingProductChanges[prodId]) state.pendingProductChanges[prodId] = {};
        if (val !== init) {
          state.pendingProductChanges[prodId][field] = el.type === 'checkbox' ? val === '1' : val;
        } else {
          delete state.pendingProductChanges[prodId][field];
          if (!Object.keys(state.pendingProductChanges[prodId]).length) delete state.pendingProductChanges[prodId];
        }
      });
      // 2. Собираем правки из буфера (переживает пагинацию)
      var edits = {};
      Object.keys(state.pendingProductChanges).forEach(function (prodId) {
        var prod = state.products.find(function (x) { return x.id === prodId; });
        if (!prod) return;
        var pend = state.pendingProductChanges[prodId];
        Object.keys(pend).forEach(function (field) {
          if (field === 'showDiscount') {
            var curBool = prod.showDiscount !== false;
            if (pend.showDiscount !== curBool) {
              if (!edits[prodId]) edits[prodId] = {};
              edits[prodId].showDiscount = pend.showDiscount;
            }
            return;
          }
          var val = String(pend[field]).trim();
          var cur = prod[field];
          var curStr = cur == null ? '' : String(cur);
          if (field === 'priority' && val === '' && curStr !== '') {
            if (!edits[prodId]) edits[prodId] = {};
            edits[prodId][field] = '';
            return;
          }
          // Пустое значение = снять правку (вернуть базовую цену/описание)
          if (val === curStr) return;
          if (!edits[prodId]) edits[prodId] = {};
          edits[prodId][field] = (field === 'price' || field === 'discount_price' || val === '') ? (val === '' ? '' : parseFloat(val)) : val;
        });
      });
      var btn = content.querySelector('#prodSaveBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сохраняем…';
      Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'save', updates: edits }) }).then(function (res) {
        var ok = res && res.ok;
        if (ok) {
          Utils.showToast('✅ Изменения сохранены — применены на сайте');
          state.pendingProductChanges = {};
        } else {
          Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сохранить. Проверьте соединение.'));
        }
        btn.disabled = false;
        btn.textContent = '💾 Сохранить изменения';
        loadData().then(function () { openSection(state.section); });
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = '💾 Сохранить изменения';
        Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз');
      });
    });

    content.querySelector('#prodResetBtn').addEventListener('click', function () {
      openResetModal({
        title: 'Сбросить мои правки',
        action: 'reset',
        includeSc: true
      });
    });

    content.querySelector('#prodScBtn').addEventListener('click', function () {
      openSection('catalog');
    });
  }

  // ---------------- Наличие товаров в СЦ (суперадмин) ----------------

  function renderAvailability(content) {
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">🛒 Здесь задаются товары, доступные для заказа в каждом Сервис-Центре: цена, скидка, наличие, остаток и скрытие товара в этом СЦ. Настройки перекрывают остатки парсера для конкретного филиала и применяются при оплате.</div>' +
      '<div class="admin-toolbar" style="flex-wrap:wrap; gap:8px;">' +
      '<select id="scSel"><option value="">Выберите Сервис-Центр…</option>' +
      state.stores.map(function (s) { return '<option value="' + h(s.id) + '"' + (s.id === state.availabilityScId ? ' selected' : '') + '>' + h(s.name) + '</option>'; }).join('') +
      '</select>' +
      '<input class="search" id="avSearch" type="search" placeholder="Поиск по названию или артикулу…" autocomplete="off">' +
      '</div>' +
      '<div class="admin-card admin-table-wrap" id="avTableWrap">' +
      '<p style="color:var(--muted); padding:16px;">Выберите Сервис-Центр, чтобы настроить наличие товаров.</p>' +
      '</div>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<button class="btn btn-primary" id="avSaveBtn">💾 Сохранить настройки филиала</button>' +
      '<button class="btn btn-primary" id="avStockSaveBtn">📦 Сохранить остатки (Worker)</button>' +
      '<button class="btn btn-outline" id="avStockExportBtn">⬇️ Экспорт JSON (store-stock.json)</button>' +
      '<button class="btn btn-outline" id="avStockImportBtn">⬆️ Импорт JSON</button>' +
      '<input type="file" id="avStockImportFile" accept="application/json,.json" style="display:none;">' +
      '<button class="btn btn-outline" id="avResetBtn">🧹 Сбросить настройки этого филиала</button>' +
      '</div>'
    );

    var wrap = content.querySelector('#avTableWrap');
    var storeSel = content.querySelector('#scSel');
    var searchInput = content.querySelector('#avSearch');

    // Буфер несохранённых правок филиала (переживает пагинацию): { pid: {field: value, stock: 'N'} }
    function pendSc() {
      if (!state.pendingScChanges[state.availabilityScId]) state.pendingScChanges[state.availabilityScId] = {};
      return state.pendingScChanges[state.availabilityScId];
    }

    function drawRows(scId) {
      state.availabilityScId = scId;
      state.availabilityPage = 0;
      drawAvRows();
    }

    function drawAvRows() {
      var scId = state.availabilityScId;
      if (!scId) return;
      var scOverrides = state.scProductOverrides[scId] || {};
      var pend = pendSc();
      var q = (searchInput.value || '').trim().toLowerCase();
      var list = state.products.filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      });
      var info = pageSlice(list, state.availabilityPage);
      state.availabilityPage = info.page;
      var rows = info.items.map(function (p) {
        var o = scOverrides[p.id] || {};
        var pe = pend[p.id] || {};
        function fv(field, base) { return pe[field] !== undefined ? pe[field] : (o[field] != null ? o[field] : (base != null ? base : '')); }
        var isHidden = pe.hidden !== undefined ? pe.hidden : !!o.hidden;
        var basePrice = fv('price', p.price);
        var baseDisc = fv('discount_price', p.discount_price);
        var stVal = fv('status', p.status);
        var cnt = pe.stock !== undefined ? pe.stock : StoreStock.count(scId, p.id);
        return '<tr' + (isHidden ? ' class="row-hidden"' : '') + '>' +
          '<td><strong>' + h(p.name) + '</strong>' + (isHidden ? ' <span class="badge st-out">скрыт</span>' : '') + '<br><span class="muted-sku">' + h(p.sku) + '</span></td>' +
          '<td><input class="cat-input" type="number" min="0" data-sc-prod="' + h(p.id) + '" data-sc-field="price" data-init="' + h(basePrice) + '" value="' + h(basePrice) + '"></td>' +
          '<td><input class="cat-input" type="number" min="0" data-sc-prod="' + h(p.id) + '" data-sc-field="discount_price" data-init="' + h(baseDisc) + '" value="' + h(baseDisc) + '" placeholder="—"></td>' +
          '<td><select class="cat-input" data-sc-prod="' + h(p.id) + '" data-sc-field="status" data-init="' + h(stVal) + '">' +
          STATUS_OPTIONS.map(function (o2) {
            return '<option value="' + o2[0] + '"' + (stVal === o2[0] ? ' selected' : '') + '>' + o2[1] + '</option>';
          }).join('') +
          '</select></td>' +
          '<td><div class="stock-cell"><input class="cat-input" type="number" min="0" data-stock-prod="' + h(p.id) + '" data-init="' + h(cnt === null ? '' : cnt) + '" value="' + h(cnt === null ? '' : cnt) + '" placeholder="—">' + deltaBadgeHtml(scId, p.id) + '</div></td>' +
          '<td style="text-align:center;"><input type="checkbox" data-sc-prod="' + h(p.id) + '" data-sc-field="hidden" data-init="' + (isHidden ? '1' : '0') + '" ' + (isHidden ? 'checked' : '') + ' title="Скрыть товар в этом филиале"></td>' +
          '</tr>';
      }).join('');
      var pagerTop = info.pages > 1 ? '<div class="admin-pager pager-top">' + pagerHtml(info) + '</div>' : '';
      var pagerBottom = info.pages > 1 ? '<div class="admin-pager">' + pagerHtml(info) + '</div>' : '';
      wrap.innerHTML = pagerTop + '<table class="admin-table"><thead><tr>' +
        '<th style="min-width:200px;">Товар</th><th>Цена ₸</th><th>Скидка ₸</th><th>Наличие</th><th style="min-width:120px;">Остаток</th><th>Скрыть</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" style="color:var(--muted);">Ничего не найдено.</td></tr>') + '</tbody></table>' + pagerBottom;
    }

    // Текущая страница → буфер: изменённые значения запоминаются,
    // возвращённые к исходному виду (data-init) — убираются из буфера
    function syncAvBuffer() {
      var pend = pendSc();
      wrap.querySelectorAll('[data-sc-prod]').forEach(function (el) {
        var pid = el.getAttribute('data-sc-prod');
        var field = el.getAttribute('data-sc-field');
        var init = el.getAttribute('data-init') || '';
        var val = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
        if (!pend[pid]) pend[pid] = {};
        if (val !== init) pend[pid][field] = el.type === 'checkbox' ? val === '1' : val;
        else delete pend[pid][field];
      });
      wrap.querySelectorAll('[data-stock-prod]').forEach(function (el) {
        var pid = el.getAttribute('data-stock-prod');
        var init = el.getAttribute('data-init') || '';
        var val = el.value;
        if (!pend[pid]) pend[pid] = {};
        if (val !== init) pend[pid].stock = val;
        else delete pend[pid].stock;
      });
      Object.keys(pend).forEach(function (pid) {
        if (!Object.keys(pend[pid]).length) delete pend[pid];
      });
    }

    storeSel.addEventListener('change', function (e) {
      if (!e.target.value) {
        wrap.innerHTML = '<p style="color:var(--muted); padding:16px;">Выберите Сервис-Центр, чтобы настроить наличие товаров.</p>';
        state.availabilityScId = null;
        return;
      }
      drawRows(e.target.value);
    });
    searchInput.addEventListener('input', function () {
      if (!state.availabilityScId) return;
      state.availabilityPage = 0;
      drawAvRows();
    });
    wrap.addEventListener('click', function (e) {
      var go = e.target.closest('[data-page-go]');
      if (go) {
        state.availabilityPage = parseInt(go.getAttribute('data-page-go'), 10) || 0;
        drawAvRows();
        wrap.scrollIntoView({ block: 'start' });
      }
    });
    wrap.addEventListener('input', function (e) {
      var el = e.target.closest('[data-sc-prod],[data-stock-prod]');
      if (!el) return;
      var pend = pendSc();
      var pid = el.hasAttribute('data-sc-prod') ? el.getAttribute('data-sc-prod') : el.getAttribute('data-stock-prod');
      if (!pend[pid]) pend[pid] = {};
      if (el.hasAttribute('data-sc-prod')) {
        var field = el.getAttribute('data-sc-field');
        pend[pid][field] = el.type === 'checkbox' ? el.checked : el.value;
      } else {
        pend[pid].stock = el.value;
      }
    });

    // Сохранение настроек филиала: буфер → сравнение с текущими значениями
    content.querySelector('#avSaveBtn').addEventListener('click', function () {
      if (!state.availabilityScId) {
        Utils.showToast('⚠️ Сначала выберите Сервис-Центр');
        return;
      }
      var scId = state.availabilityScId;
      syncAvBuffer();
      var pend = pendSc();
      var edits = {};
      Object.keys(pend).forEach(function (pid) {
        var prod = state.products.find(function (x) { return x.id === pid; });
        if (!prod) return;
        var o = (state.scProductOverrides[scId] || {})[pid] || {};
        var pe = pend[pid];
        Object.keys(pe).forEach(function (field) {
          if (field === 'stock') return; // остатки сохраняются отдельной кнопкой
          if (field === 'hidden') {
            if (pe.hidden !== !!o.hidden) {
              if (!edits[pid]) edits[pid] = {};
              edits[pid].hidden = pe.hidden;
            }
            return;
          }
          var val = String(pe[field]).trim();
          var cur = o[field] != null ? o[field] : (prod[field] != null ? prod[field] : null);
          var curStr = cur == null ? '' : String(cur);
          // Пустое значение = снять правку филиала (вернуть базовую цену/статус)
          if (val === curStr) return;
          if (!edits[pid]) edits[pid] = {};
          edits[pid][field] = (field === 'price' || field === 'discount_price' || val === '') ? (val === '' ? '' : parseFloat(val)) : val;
        });
      });
      var items = Object.keys(edits).map(function (pid) {
        return Object.assign({ productId: pid }, edits[pid]);
      });
      var btn = content.querySelector('#avSaveBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сохраняем…';
      Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'saveSc', storeId: scId, items: items }) }).then(function (data) {
        if (data && data.ok) {
          Utils.showToast('✅ Настройки филиала сохранены');
          delete state.pendingScChanges[scId];
        } else {
          Utils.showToast('⚠️ ' + ((data && data.error) || 'Не удалось сохранить. Проверьте соединение.'));
        }
        btn.disabled = false;
        btn.textContent = '💾 Сохранить настройки филиала';
        loadData().then(function () { openSection(state.section); });
      }).catch(function () {
        btn.disabled = false;
        btn.textContent = '💾 Сохранить настройки филиала';
        Utils.showToast('⚠️ Сеть недоступна — попробуйте ещё раз');
      });
    });

    content.querySelector('#avResetBtn').addEventListener('click', function () {
      if (!state.availabilityScId) {
        Utils.showToast('⚠️ Сначала выберите Сервис-Центр');
        return;
      }
      openResetModal({
        title: 'Сбросить настройки филиала',
        action: 'resetSc',
        sc: true,
        extra: { storeId: state.availabilityScId }
      });
    });

    var avStockSaveBtn = content.querySelector('#avStockSaveBtn');
    if (avStockSaveBtn) {
      avStockSaveBtn.addEventListener('click', function () {
        if (!state.availabilityScId) {
          Utils.showToast('⚠️ Сначала выберите Сервис-Центр');
          return;
        }
        var scId = state.availabilityScId;
        syncAvBuffer();
        var pend = pendSc();
        var items = {};
        Object.keys(pend).forEach(function (pid) {
          var v = pend[pid].stock;
          if (v === undefined) return;
          v = String(v).trim();
          var n = Number(v);
          if (v !== '' && (isNaN(n) || n < 0)) return;
          // Пустое значение = снять поправку (дельту/абсолютную правку)
          items[pid] = v === '' ? '' : (n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии');
        });
        avStockSaveBtn.disabled = true;
        avStockSaveBtn.textContent = '⏳ Сохраняем…';
        Auth.api('/api/stock', { method: 'POST', body: JSON.stringify({ scId: scId, items: items }) }).then(function (res) {
          avStockSaveBtn.disabled = false;
          avStockSaveBtn.textContent = '📦 Сохранить остатки (Worker)';
          if (res && res.ok) {
            Utils.showToast('✅ Остатки филиала сохранены — сайт обновлён');
            delete state.pendingScChanges[scId];
            return StoreStock.reload();
          }
          Utils.showToast('⚠️ ' + ((res && res.error) || 'Не удалось сохранить. Проверьте соединение.'));
          return null;
        }).then(function () {
          loadData().then(function () { openSection(state.section); });
        });
      });
    }

    content.querySelector('#avStockExportBtn').addEventListener('click', function () {
      if (!state.availabilityScId) {
        Utils.showToast('⚠️ Сначала выберите Сервис-Центр');
        return;
      }
      var scId = state.availabilityScId;
      syncAvBuffer();
      var pend = pendSc();
      var stock = {};
      state.products.forEach(function (p) {
        var v = (pend[p.id] || {}).stock !== undefined ? String(pend[p.id].stock) : (StoreStock.count(scId, p.id) === null ? '' : String(StoreStock.count(scId, p.id)));
        if (v === '') return;
        var n = Number(v);
        if (isNaN(n)) return;
        if (!stock[scId]) stock[scId] = {};
        stock[scId][p.id] = n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии';
      });
      var payload = JSON.stringify({ updated: new Date().toISOString(), stock: stock }, null, 1);
      var blob = new Blob([payload], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'store-stock.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      Utils.showToast('⬇️ Файл store-stock.json скачан — загрузите его в репозиторий');
    });

    content.querySelector('#avStockImportBtn').addEventListener('click', function () {
      content.querySelector('#avStockImportFile').click();
    });
    content.querySelector('#avStockImportFile').addEventListener('change', function (e) {
      var file = e.target.files && e.target.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var parsed = JSON.parse(reader.result);
          var stock = (parsed && parsed.stock) || parsed || {};
          if (typeof stock !== 'object' || Array.isArray(stock)) throw new Error('bad format');
          var scId = state.availabilityScId;
          if (scId && stock[scId]) {
            if (!state.pendingScChanges[scId]) state.pendingScChanges[scId] = {};
            Object.keys(stock[scId]).forEach(function (pid) {
              var m = /(\d+)\s*шт/.exec(String(stock[scId][pid]));
              var val = m ? m[1] : (String(stock[scId][pid]).toLowerCase().indexOf('нет') === 0 ? '0' : '');
              if (!state.pendingScChanges[scId][pid]) state.pendingScChanges[scId][pid] = {};
              state.pendingScChanges[scId][pid].stock = val;
            });
            drawAvRows();
          }
          Utils.showToast('⬆️ Файл загружен в таблицу — проверьте и нажмите «Сохранить остатки»');
        } catch (err) {
          Utils.showToast('Не удалось прочитать JSON');
        }
      };
      reader.readAsText(file);
      e.target.value = '';
    });

    if (state.availabilityScId) {
      storeSel.value = state.availabilityScId;
      drawRows(state.availabilityScId);
    }
  }

  // ---------------- Уведомления СЦ (KV — видны СЦ на всех устройствах) ----------------

  function renderNotices(content) {
    var notices = [];

    function draw() {
      var listEl = content.querySelector('#noticeList');
      if (!listEl) return;
      listEl.innerHTML = (notices.length ? notices.map(function (n) {
        return '<li><div class="admin-list-main"><strong>' + h(new Date(n.date).toLocaleString('ru-RU')) + '</strong><span>' + h(n.text) + '</span></div>' +
          (isSuper() ? '<div class="admin-actions"><button class="btn btn-outline btn-sm danger-btn" data-notice-remove="' + h(n.id) + '">🗑</button></div>' : '') +
          '</li>';
      }).join('') : '<li style="color:var(--muted);">Уведомлений пока нет.</li>') + '</ul>';
    }

    function save() {
      Auth.api('/api/notices', { method: 'POST', body: JSON.stringify({ notices: notices }) }).catch(function () { });
    }

    if (isSuper()) {
      content.insertAdjacentHTML('beforeend',
        '<form class="form admin-form" id="noticeForm">' +
        '<h4 style="margin-bottom:10px;">📢 Отправить уведомление Сервис-Центрам</h4>' +
        '<div class="form-group"><label>Текст уведомления</label><textarea name="notice" placeholder="Например: Напоминаем обновить остатки до пятницы!"></textarea></div>' +
        '<div class="admin-actions">' +
        '<button class="btn btn-primary" type="submit">💾 Сохранить уведомление</button>' +
        '<button class="btn btn-whatsapp" type="button" id="noticeTgBtn">✈️ Сохранить и отправить в Telegram</button>' +
        '</div>' +
        '<p style="margin-top:10px; font-size:13px; color:var(--muted);">Уведомления видны в кабинетах СЦ на всех устройствах. Отправка в Telegram приходит вам (единый чат владельца).</p>' +
        '</form>'
      );

      var form = content.querySelector('#noticeForm');
      function addNotice(sendTg) {
        var text = form.notice.value.trim();
        if (!text) { Utils.showToast('Введите текст уведомления'); return; }
        notices.unshift({ id: 'n_' + Date.now(), text: text, date: new Date().toISOString() });
        save();
        if (sendTg) {
          fetch('/telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'notice', notice: text, name: 'Суперадмин', phone: '-' })
          }).then(function (r) { return r.ok; }).catch(function () { return false; }).then(function (ok) {
            Utils.showToast(ok ? '✅ Уведомление сохранено и отправлено в Telegram' : '✅ Уведомление сохранено (Telegram недоступен)');
          });
        } else {
          Utils.showToast('✅ Уведомление сохранено');
        }
        draw();
        form.notice.value = '';
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); addNotice(false); });
      form.querySelector('#noticeTgBtn').addEventListener('click', function () { addNotice(true); });
    }

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card"><h4 style="margin-bottom:10px;">История уведомлений</h4><ul class="admin-list" id="noticeList">Загружаем…</ul></div>'
    );

    Auth.api('/api/notices').then(function (d) {
      notices = (d && d.notices) || [];
      draw();
    }).catch(function () {
      draw();
    });

    content.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-notice-remove]');
      if (!btn) return;
      var id = btn.getAttribute('data-notice-remove');
      notices = notices.filter(function (n) { return n.id !== id; });
      save();
      draw();
    });
  }

  // ---------------- Вход / выход ----------------

  function showLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('adminLayout').classList.add('hidden');
    var badge = document.getElementById('adminUserBadge');
    var logout = document.getElementById('adminLogoutBtn');
    if (badge) badge.classList.add('hidden');
    if (logout) logout.classList.add('hidden');
  }

  function showPanel() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('adminLayout').classList.remove('hidden');
    var badge = document.getElementById('adminUserBadge');
    var logout = document.getElementById('adminLogoutBtn');
    if (badge) { badge.classList.remove('hidden'); badge.innerHTML = '🟢 ' + h(state.user.name); }
    if (logout) logout.classList.remove('hidden');
    if (state.section && visibleSections().indexOf(state.section) !== -1) {
      openSection(state.section);
    } else {
      openSection(isSuper() ? 'overview' : 'cabinet');
    }
  }

  function bindAuthSwitchers() {
    var loginView = document.getElementById('authLoginView');
    var ownerView = document.getElementById('authOwnerView');
    var card = document.querySelector('.admin-login-card');
    if (!loginView || !ownerView) return;
    function show(view) {
      loginView.classList.add('hidden');
      ownerView.classList.add('hidden');
      view.classList.remove('hidden');
      if (card) {
        if (view === ownerView) card.classList.add('wide');
        else card.classList.remove('wide');
      }
    }
    var ownerBtn = document.getElementById('authOwnerBtn');
    if (ownerBtn) ownerBtn.addEventListener('click', function () { show(ownerView); });
    var back2 = document.getElementById('authOwnerBackBtn');
    if (back2) back2.addEventListener('click', function () { show(loginView); });
  }

  function bindLogin() {
    var form = document.getElementById('adminLoginForm');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var btn = form.querySelector('button[type="submit"]');
      if (btn) { btn.disabled = true; }
      Auth.login(form.login.value, form.password.value).then(function (user) {
        if (btn) { btn.disabled = false; }
        if (user) {
          Auth.setCurrentUser(user);
          state.user = user;
          loadData().then(showPanel);
        } else {
          document.getElementById('adminLoginErr').style.display = 'block';
        }
      });
    });
  }

  function init() {
    bindLogin();
    bindAuthSwitchers();

    document.getElementById('adminLogoutBtn').addEventListener('click', function () {
      Auth.setCurrentUser(null);
      state.user = null;
      Utils.showToast('Вы вышли из аккаунта');
      showLogin();
    });

    document.getElementById('adminNav').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-section]');
      if (!btn) return;
      openSection(btn.getAttribute('data-section'));
    });

    var user = Auth.getCurrentUser();
    if (user) {
      state.user = user;
      loadData().then(showPanel);
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    init();
  }
})();
