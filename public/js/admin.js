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
    catalog: { label: '📦 Наличие товаров в СЦ', roles: ['superadmin'] },
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

  // ---------------- Данные ----------------

  function applyListOverride(list, key) {
    var saved = lsGet(key);
    if (saved && Array.isArray(saved)) return saved;
    return list;
  }

  function applyStoreOverrides() {
    var saved = lsGet(KEYS.stores) || {};
    Object.keys(saved).forEach(function (id) {
      var idx = state.stores.findIndex(function (s) { return s.id === id; });
      if (idx >= 0) {
        state.stores[idx] = Object.assign({}, state.stores[idx], saved[id]);
      } else {
        state.stores.push(Object.assign({}, saved[id], { id: id }));
      }
    });
  }

  function applyProductOverrides() {
    var saved = lsGet(KEYS.products) || {};
    state.products.forEach(function (p) {
      var o = saved[p.id];
      if (!o) return;
      ['price', 'status', 'eta', 'incoming', 'description', 'category'].forEach(function (f) {
        if (o[f] !== undefined && o[f] !== '') p[f] = o[f];
      });
    });
  }

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

  // Сохранение списка поставок: глобальные — в общий оверрайд, филиальные — в пер-филиальную карту
  function saveDeliveries(list) {
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
    var p3 = loadJSON('data/deliveries.json').then(function (d) { return mergeDeliveries(d.deliveries || []); }).catch(function () { return mergeDeliveries([]); });
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
          settings: (d && d.settings) || { showDiscountPrices: true, categories: [] },
          adminEmail: (d && d.adminEmail) || ''
        };
      }).catch(function () { return { overrides: {}, scOverrides: {}, settings: { showDiscountPrices: true, categories: [] }, adminEmail: '' }; })
      : Promise.resolve({ overrides: {}, scOverrides: {}, settings: { showDiscountPrices: true, categories: [] }, adminEmail: '' });
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
      state.adminEmail = res[7].adminEmail || '';
      state.pendingProductChanges = {};
      state.pendingScChanges = {};
      applyStoreOverrides();
      applyProductOverrides();
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
    html += '<div style="margin-top:24px; padding-top:16px; border-top:1px solid var(--line); font-size:12.5px; color:var(--muted);">Вы вошли как:<br><strong style="color:var(--ink);">' + h(state.user.name) + '</strong><br>' + (isSuper() ? '👑 Суперадмин' : '🏬 Сервис-Центр') + '</div>';
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
      '</div>' +
      '</div>' +
      '<div class="admin-card">' +
      '<h4 style="margin-bottom:6px;">🔐 Восстановление пароля суперадмина</h4>' +
      '<p style="font-size:13px;color:var(--muted);margin-bottom:8px;">Привяжите email — на него будет приходить ссылка для сброса пароля, если вы его забудете.</p>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<input type="email" id="adminRecoveryEmail" placeholder="email@example.com" style="min-width:240px;" value="' + h(state.adminEmail || '') + '">' +
      '<button class="btn btn-outline btn-sm" id="adminRecoveryEmailBtn">Сохранить email</button>' +
      '</div>' +
      '<p class="form-success" id="adminRecoveryEmailMsg" style="display:none;">Email сохранён — восстановление пароля доступно по кнопке «Забыли пароль?»</p>' +
      '</div>';
    content.insertAdjacentHTML('beforeend', html);

    ['deliveries', 'events', 'applications', 'products', 'catalog'].forEach(function (name) {
      var btn = content.querySelector('[data-go="' + name + '"]');
      if (btn) btn.addEventListener('click', function () { openSection(name); });
    });

    var emailBtn = content.querySelector('#adminRecoveryEmailBtn');
    if (emailBtn) emailBtn.addEventListener('click', function () {
      var email = (content.querySelector('#adminRecoveryEmail').value || '').trim();
      Auth.api('/api/admin/email', { method: 'POST', body: JSON.stringify({ email: email }) })
        .then(function (d) {
          if (d && d.ok) {
            state.adminEmail = email;
            var msg = content.querySelector('#adminRecoveryEmailMsg');
            if (msg) msg.style.display = 'block';
            Utils.showToast('✅ Email для восстановления сохранён');
          } else {
            Utils.showToast('⚠️ Не удалось сохранить email: ' + ((d && d.error) || 'ошибка'));
          }
        })
        .catch(function () { Utils.showToast('⚠️ Ошибка сети — попробуйте ещё раз'); });
    });
  }

  function statCard(ico, val, lbl) {
    return '<div class="admin-stat"><div class="admin-stat-ico">' + ico + '</div><div class="admin-stat-val">' + val + '</div><div class="admin-stat-lbl">' + h(lbl || '') + '</div></div>';
  }

  // ---------------- Кабинет СЦ (контакты своего филиала) ----------------

  function renderCabinet(content) {
    var store = state.stores.find(function (s) { return s.id === state.user.id; }) || {
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
    return '<div class="admin-card">' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;" class="store-auth-grid">' +
      '<div class="form-group"><label>Название СЦ *</label><input name="storeName" value="' + h(store.name) + '" required></div>' +
      '<div class="form-group"><label>Город *</label><select name="city" required>' + cityOptions + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Точный адрес *</label><input name="address" value="' + h(store.address) + '" placeholder="ул. Абая 150" required></div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>Телефон *</label><input name="phone" value="' + h(store.phone) + '" placeholder="+7 (700) 000-00-00" required></div>' +
      '<div class="form-group"><label>Email владельца * (сюда приходят логин и пароль кабинета)</label><input name="email" type="email" value="' + h(store.email || '') + '" placeholder="owner@mail.kz" required></div>' +
      '</div>' +
            Utils.scheduleFormHtml(store) +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>WhatsApp (только цифры, с 7)</label><input name="whatsapp" value="' + h(store.whatsapp) + '" placeholder="77001234567"></div>' +
      '<div class="form-group"><label>Kaspi QR (путь к картинке статичного QR)</label><input name="kaspi_qr" value="' + h(store.kaspi_qr || '') + '" placeholder="assets/images/kaspi-qr.png"></div>' +
      '</div>' +
      '<div class="form-group"><label>Фото (путь или ссылка) *</label><input name="image" value="' + h(store.image || '') + '" placeholder="assets/images/... или https://..." required>' + imagePreview + '</div>' +
      '<div class="form-group"><label>Краткое описание филиала *</label><textarea name="description" required>' + h(store.description) + '</textarea></div>' +
      '<div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">' +
      '<strong style="font-size:14px;">🔌 Подключение к порталу (автосинхронизация остатков)</strong>' +
      (store.portalLogin && store.portalPassword
        ? '<p class="form-note" style="color:var(--green-darker);">✅ Парсер подключён — остатки будут подтягиваться автоматически.</p>'
        : '<p class="form-note" style="color:#b54708; font-weight:600;">⚠️ Парсер ещё не подключён — укажите логин и пароль кабинета СЦ, чтобы остатки обновлялись автоматически.</p>') +
      '<div class="form-group"><label>Логин кабинета СЦ (для парсера)</label><input name="portalLogin" value="' + h(store.portalLogin || '') + '" placeholder="s240534"></div>' +
      '<div class="form-group"><label>Пароль кабинета СЦ (для парсера)</label><input name="portalPassword" type="password" value="' + h(store.portalPassword || '') + '" placeholder="••••••••"></div>' +
      '<p class="form-note">🔐 Бот заходит в кабинет Сервис-Центра по этим логину и паролю и автоматически подтягивает остатки. Пароль хранится только в Cloudflare KV, на сайте не публикуется.</p>' +
      '</div>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-primary" type="submit">💾 Сохранить филиал</button>' +
      (withAuth ? '<button class="btn btn-outline danger-btn" type="button" id="storeDeleteBtn">' + Utils.iconTrash(14) + 'Удалить филиал</button>' : '') +
      '</div>' +
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
      '<p style="margin:6px 0;">Логин: <b>' + h(rec.authLogin) + '</b><br>Пароль: <b>' + h(rec.authPassword) + '</b></p>' +
      '<p class="form-note">Письмо с доступом отправлено на email СЦ. Если не пришло — проверьте спам или отправьте письма ещё раз.</p>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-outline btn-sm" data-copy="' + h(rec.authLogin + ' / ' + rec.authPassword) + '">📋 Копировать</button>' +
      '<button class="btn btn-outline btn-sm" type="button" data-resend-creds="' + h(rec.id) + '">📧 Отправить письма заново</button>' +
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
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var errMsg = form.querySelector('.form-error');
      var errors = [];
      ['storeName', 'city', 'address', 'hours', 'phone', 'image', 'description', 'email'].forEach(function (f) {
        if (!form[f] || !String(form[f].value || '').trim()) errors.push(f);
      });
      if (errors.length) {
        if (errMsg) errMsg.classList.remove('hidden');
        return;
      }
      if (errMsg) errMsg.classList.add('hidden');
      // Расписание из селекторов; если все дни — выходной, не сохраняем
      var schedule = Utils.collectSchedule(form);
      var hoursText = schedule ? Utils.scheduleToText(schedule) : (form.hours ? form.hours.value.trim() : '');
      if (!schedule) {
        if (errMsg) errMsg.classList.remove('hidden');
        return;
      }
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
      store.portalPassword = form.portalPassword ? form.portalPassword.value : '';
      store.email = form.email ? form.email.value.trim() : '';
      store.phoneRaw = (store.phone || '').replace(/\D/g, '');
      if (store.phoneRaw && !store.whatsapp) store.whatsapp = store.phoneRaw;

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
        email: store.email,
        image: store.image,
        description: store.description,
        portalLogin: store.portalLogin,
        portalPassword: store.portalPassword,
        authLogin: store.authLogin || '',
        authPassword: store.authPassword || ''
      };
      Auth.api('/api/sc-store', { method: 'POST', body: JSON.stringify(payload) }).then(function (data) {
        if (!data || !data.ok) {
          Utils.showToast('⚠️ Не удалось сохранить в Worker. Войдите заново (сессия истекла).');
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
        var credsPanel = content.querySelector('#issuedCreds');
        if (!credsPanel) {
          credsPanel = document.createElement('div');
          credsPanel.id = 'issuedCreds';
          content.appendChild(credsPanel);
        }
        credsPanel.innerHTML = issuedCredsHtml(rec, store.phoneRaw || store.phone);
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

    content.addEventListener('click', function (e) {
      var resendBtn = e.target.closest('[data-resend-creds]');
      if (!resendBtn) return;
      var sid = resendBtn.getAttribute('data-resend-creds');
      Auth.api('/api/sc-store/resend', { method: 'POST', body: JSON.stringify({ id: sid }) }).then(function (res) {
        Utils.showToast(res && res.ok ? '📧 Письма с доступом отправлены заново' : '⚠️ Не удалось отправить письма. Войдите заново.');
      });
    });

    var delBtn = content.querySelector('#storeDeleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('Удалить филиал «' + store.name + '»? Он исчезнет с сайта, но останется в архиве — оттуда его можно восстановить.')) return;
        Auth.api('/api/sc-store', { method: 'DELETE', body: JSON.stringify({ id: store.id }) }).then(function (res) {
          state.editingStoreId = null;
          Utils.showToast(res && res.ok ? '✅ Филиал перемещён в архив' : '⚠️ Не удалось удалить. Войдите заново (сессия истекла).');
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
        Utils.showToast(res && res.ok ? '✅ Филиал перемещён в архив' : '⚠️ Не удалось удалить. Войдите заново (сессия истекла).');
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
          image: '',
          description: '',
          portalLogin: fromApp.portalLogin || '',
          portalPassword: fromApp.portalPassword || ''
        }
        : { id: 'sc-new-' + Date.now(), name: '', city: 'Алматы', address: '', hours: '', phone: '', whatsapp: '', email: '', kaspi_qr: '', image: '', description: '', officeCode: '', portalLogin: '', portalPassword: '', partner: '' };
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
            Utils.showToast(res && res.ok ? '✅ Филиал восстановлен' : '⚠️ Не удалось восстановить. Войдите заново (сессия истекла).');
            openSection('scArchive');
          });
          return;
        }
        var purgeBtn = e.target.closest('[data-sc-archive-purge]');
        if (!purgeBtn) return;
        var pid = purgeBtn.getAttribute('data-sc-archive-purge');
        if (!confirm('Удалить филиал «' + pid + '» НАВСЕГДА? Это действие необратимо.')) return;
        Auth.api('/api/sc-archive/action', { method: 'POST', body: JSON.stringify({ id: pid, action: 'purge' }) }).then(function (res) {
          Utils.showToast(res && res.ok ? '🗑 Удалён безвозвратно' : '⚠️ Не удалось удалить. Войдите заново (сессия истекла).');
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
    var canSave = isSuper();
    var curScId = state.stockScId || (visibleStores[0] ? visibleStores[0].id : '');

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">📦 Остатки = база (парсер/файл) − продажи − активные брони (Worker). Выберите филиал и отредактируйте остатки — <b>«Сохранить остатки»</b> сразу обновляет сайт.' + (canSave ? '' : ' (Правки сохраняет только суперадмин.)') + '</div>' +
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
      '<table class="admin-table" id="stockTable">' +
      '<thead><tr>' +
      '<th style="min-width:60px;"></th>' +
      '<th style="min-width:240px;">Товар</th>' +
      '<th>Категория</th>' +
      '<th style="min-width:150px;">Цена / скидка</th>' +
      '<th>Статус</th>' +
      '<th style="min-width:150px;">Остаток</th>' +
      '</tr></thead><tbody id="stockTbody"></tbody></table>' +
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

    function statusOf(p, scId) {
      var cnt = StoreStock.count(scId, p.id);
      if (cnt === null) return 'none';
      return cnt > 0 ? 'in_stock' : 'zero';
    }

    function drawRows() {
      var scId = scSel ? scSel.value : curScId;
      var q = (searchInp ? searchInp.value : '').trim().toLowerCase();
      var stFilter = statusFilter ? statusFilter.value : '';
      var rows = state.products.filter(function (p) {
        if (q && p.name.toLowerCase().indexOf(q) === -1 && p.sku.toLowerCase().indexOf(q) === -1) return false;
        if (stFilter && statusOf(p, scId) !== stFilter) return false;
        return true;
      }).map(function (p) {
        var img = p.thumb || p.image || 'assets/images/products/placeholder.svg';
        var st = statusOf(p, scId);
        var stBadge = st === 'in_stock' ? '<span class="badge st-in">✅ В наличии</span>'
          : st === 'zero' ? '<span class="badge st-out">— Нет</span>'
          : '<span class="badge st-exp">🕓 Нет данных</span>';
        var cnt = StoreStock.count(scId, p.id);
        var priceTxt = Utils.fmtPrice(p.price);
        if (p.discount_price) priceTxt += ' <s class="muted-sku">' + Utils.fmtPrice(p.discount_price) + '</s>';
        return '<tr>' +
          '<td><img class="admin-thumb" src="' + h(img) + '" alt="" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'"></td>' +
          '<td><strong>' + h(p.name) + '</strong><br><span class="muted-sku">' + h(p.sku) + '</span></td>' +
          '<td>' + h(p.category || '') + '</td>' +
          '<td>' + priceTxt + '</td>' +
          '<td>' + stBadge + '</td>' +
          '<td><input data-stock-prod="' + h(p.id) + '" type="number" min="0" value="' + h(cnt === null ? '' : cnt) + '" placeholder="Число (0 = нет)" style="width:130px;"></td>' +
          '</tr>';
      }).join('');
      document.getElementById('stockTbody').innerHTML = rows || '<tr><td colspan="6" style="color:var(--muted);">Ничего не найдено.</td></tr>';
    }

    drawRows();
    scSel.addEventListener('change', function () {
      state.stockScId = scSel.value;
      drawRows();
    });
    searchInp.addEventListener('input', drawRows);
    statusFilter.addEventListener('change', drawRows);

    var saveBtn = content.querySelector('#stockSaveBtn');
    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var scId = scSel.value;
        var items = {};
        content.querySelectorAll('#stockTbody [data-stock-prod]').forEach(function (inp) {
          var v = inp.value.trim();
          if (v === '') return;
          var n = Number(v);
          if (isNaN(n) || n < 0) return;
          items[inp.getAttribute('data-stock-prod')] = n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии';
        });
        Auth.api('/api/stock', { method: 'POST', body: JSON.stringify({ scId: scId, items: items }) }).then(function (res) {
          if (res && res.ok) {
            Utils.showToast('✅ Остатки филиала сохранены — сайт обновлён');
            return StoreStock.reload();
          }
          Utils.showToast('⚠️ Не удалось сохранить. Войдите заново (сессия истекла).');
          return null;
        }).then(function () {
          loadData().then(function () { openSection(state.section); });
        });
      });
    }

    content.querySelector('#stockExportBtn').addEventListener('click', function () {
      var stock = {};
      content.querySelectorAll('[data-stock-prod]').forEach(function (inp) {
        var val = inp.value.trim();
        if (val === '') return;
        var n = Number(val);
        if (isNaN(n)) return;
        var scId = scSel.value;
        if (!stock[scId]) stock[scId] = {};
        stock[scId][inp.getAttribute('data-stock-prod')] = n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии';
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
          var scId = scSel.value;
          if (stock[scId]) {
            content.querySelectorAll('[data-stock-prod]').forEach(function (inp) {
              var pid = inp.getAttribute('data-stock-prod');
              if (stock[scId][pid] !== undefined) {
                var m = /(\d+)\s*шт/.exec(String(stock[scId][pid]));
                inp.value = m ? m[1] : (String(stock[scId][pid]).indexOf('Нет') === 0 ? '0' : '');
              }
            });
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
        var qty = typeof it === 'object' ? (it.qty || '') : '';
        itemRows += '<div class="delivery-item-row">' +
          '<input class="delivery-item-name" list="deliveryProductList" placeholder="Позиция — начните вводить название или артикул" value="' + h(name) + '">' +
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
      '<div class="admin-card">' +
      '<ul class="admin-list" id="deliveryList"></ul>' +
      '<div class="admin-list-footer">' +
      '<button class="btn btn-primary" data-del-new>➕ Добавить поставку</button>' +
      '</div>' +
      '</div>');
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card' + (editing ? '' : ' hidden') + '" id="deliveryFormCard">' +
      deliveryFormHtml(editing, editingId) +
      '</div>');

    var listEl = content.querySelector('#deliveryList');

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
            var p = Utils.productByLabel(state.products, name);
            var chip = '';
            if (p) {
              var img = p.thumb || p.image || 'assets/images/products/placeholder.svg';
              chip = '<img class="delivery-item-img" src="' + h(img) + '" alt="' + h(p.name) + '" onerror="this.style.display=\'none\'">';
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
        var name = row.querySelector('.delivery-item-name').value.trim();
        if (!name) return;
        var qty = parseInt(row.querySelector('.delivery-item-qty').value, 10);
        if (isNaN(qty) || qty <= 0) qty = 1;
        itemsList.push({ name: name, qty: qty });
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
      '</div>' +
      '<div class="admin-card" style="margin-top:12px;">' +
      '<strong>🔑 Восстановление паролей</strong>' +
      '<p style="color:var(--muted); font-size:13px; margin:6px 0 10px;">Запросы «Забыли пароль» с кабинета. Кнопка «Сбросить» генерирует новый пароль — покажите его владельцу или отправьте в WhatsApp.</p>' +
      '<div id="pwdReqList">Загружаем…</div>' +
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
            ? 'Создать карточку СЦ «' + app.storeName + '» из заявки? ' + (app.email ? 'Логин и пароль кабинета уйдут на ' + app.email + '.' : '')
            : 'Одобрить заявку партнёра «' + app.storeName + '»? Карточка магазина появится в «Сервис-Центрах».')) return;
          Auth.api('/api/sc-application', { method: 'POST', body: JSON.stringify({ id: app.id, action: 'approve', create: true }) }).then(function (res) {
            if (res && res.store) {
              Utils.showToast(isSc ? '✅ СЦ создан: ' + res.store.name + (app.email ? ' — доступы отправлены на почту' : '') : '✅ Магазин-партнёр добавлен: ' + res.store.name);
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

    // Запросы на восстановление пароля
    Auth.api('/api/password-requests').then(function (data) {
      var reqs = (data && data.requests) || [];
      var listEl = content.querySelector('#pwdReqList');
      if (!reqs.length) {
        listEl.innerHTML = '<div class="owner-req-empty">Запросов на восстановление пароля нет.</div>';
        return;
      }
      listEl.innerHTML = '<ul class="admin-list">' + reqs.map(function (r) {
        var wa = (r.phone || '').replace(/\D/g, '');
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(r.storeName || 'Администратор') + '</strong>' +
          '<span>' + (r.kind === 'sc' ? '🏬 Сервис-Центр' : '👑 Суперадмин') + ' · 📧 ' + h(r.email) + (r.phone ? ' · 📞 ' + h(r.phone) : '') + '</span>' +
          '<span style="color:var(--muted); font-size:12px;">🕐 ' + h(new Date(r.createdAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })) + '</span>' +
          '</div>' +
          '<div class="admin-actions" style="flex-wrap:wrap;">' +
          '<button class="btn btn-primary btn-sm" data-pwd-reset="' + h(r.id) + '">🔄 Сбросить пароль</button>' +
          '<button class="btn btn-outline btn-sm danger-btn" data-pwd-delete="' + h(r.id) + '">🗑 Удалить запрос</button>' +
          (wa ? '<a class="btn btn-whatsapp btn-sm" href="https://wa.me/' + wa + '" target="_blank" rel="noopener">📱 Владельцу</a>' : '') +
          '</div>' +
          '<div class="pwd-new" id="pwdNew-' + h(r.id) + '"></div>' +
          '</li>';
      }).join('') + '</ul>';

      listEl.addEventListener('click', function (e) {
        var resetBtn = e.target.closest('[data-pwd-reset]');
        if (resetBtn) {
          var rid = resetBtn.getAttribute('data-pwd-reset');
          var req = reqs.find(function (x) { return x.id === rid; });
          if (!req) return;
          if (!confirm('Сбросить пароль для ' + (req.storeName || req.email) + '? Новый пароль сгенерируется автоматически.')) return;
          resetBtn.disabled = true;
          resetBtn.textContent = '⏳ Сбрасываем…';
          Auth.api('/api/password-request', { method: 'POST', body: JSON.stringify({ id: rid, action: 'reset' }) }).then(function (res) {
            var box = content.querySelector('#pwdNew-' + rid);
            if (res && res.ok) {
              var wa = (req.phone || '').replace(/\D/g, '');
              var waLink = wa ? '<a class="btn btn-whatsapp btn-sm" target="_blank" rel="noopener" href="https://wa.me/' + wa + '?text=' + encodeURIComponent('Здравствуйте! Новый пароль от кабинета Greenleaf: ' + res.password) + '">📱 Отправить в WhatsApp</a>' : '';
              if (box) {
                box.innerHTML = '<div class="admin-card" style="border-color:var(--green); margin-top:12px;">' +
                  '<strong style="color:var(--green-darker);">🔐 Новый пароль: <b>' + h(res.password) + '</b></strong>' +
                  '<p class="form-note">Пароль показан один раз. Сообщите его владельцу (WhatsApp/звонок/почта).</p>' +
                  '<div class="admin-actions">' +
                  '<button class="btn btn-outline btn-sm" data-copy="' + h(res.password) + '">📋 Копировать</button>' +
                  waLink +
                  '</div></div>';
              }
              resetBtn.disabled = false;
              resetBtn.textContent = '🔄 Сбросить пароль';
              resetBtn.closest('li').querySelector('.admin-actions').querySelectorAll('[data-pwd-reset],[data-pwd-delete]').forEach(function (b) { b.style.display = 'none'; });
              Utils.showToast('✅ Пароль сброшен: ' + res.password);
            } else {
              resetBtn.disabled = false;
              resetBtn.textContent = '🔄 Сбросить пароль';
              Utils.showToast((res && res.error) || '⚠️ Не удалось сбросить пароль');
            }
          });
          return;
        }
        var delBtn = e.target.closest('[data-pwd-delete]');
        if (delBtn) {
          var did = delBtn.getAttribute('data-pwd-delete');
          if (!confirm('Удалить запрос на восстановление пароля?')) return;
          Auth.api('/api/password-request', { method: 'POST', body: JSON.stringify({ id: did, action: 'delete' }) }).then(function () {
            Utils.showToast('🗑 Запрос удалён');
            openSection('applications');
          });
        }
      });
    });
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
      if (p.priority != null && p.priority !== '') return String(p.priority);
      return p.hit ? '1' : '';
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
      '<table class="admin-table"><thead><tr>' +
      '<th>Фото</th><th style="min-width:200px;">Название</th><th>Артикул</th><th style="min-width:180px;">Описание</th><th>Категория</th><th>Цена ₸</th><th>Приоритет</th><th style="min-width:110px;">Скидка на сайте</th><th style="width:46px;"></th>' +
      '</tr></thead><tbody id="prodTbody"></tbody></table>' +
      '</div>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<button class="btn btn-primary" id="prodSaveBtn">💾 Сохранить изменения</button>' +
      '<button class="btn btn-outline" id="prodScBtn">📦 Наличие товаров в СЦ</button>' +
      '</div>' +
      '<p style="margin-top:10px; font-size:13px; color:var(--muted);">Приоритет: 🔥 Хит — 1, ✨ Новинка — 2, 🚀 Топ — 3 (меньше число — выше в каталоге). «Скидка на сайте» включает скидочную цену товара для всех посетителей. Статус (наличие) задаётся в разделе «Наличие товаров в СЦ» для каждого филиала отдельно. Пустые поля не меняют данные.</p>'
    );

    function drawRows() {
      var prev = {};
      var oldTbody = document.getElementById('prodTbody');
      if (oldTbody) {
        oldTbody.querySelectorAll('[data-cat-prod]').forEach(function (el) {
          var k = el.getAttribute('data-cat-prod') + '|' + el.getAttribute('data-cat-field');
          prev[k] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
        });
      }
      var q = (state.productSearch || '').trim().toLowerCase();
      var cat = state.productCatFilter || 'all';
      var rows = state.products.filter(function (p) {
        if (cat !== 'all' && p.category !== cat) return false;
        return !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      }).map(function (p) {
        var o = state.productOverrides[p.id] || {};
        var changed = Object.keys(o).some(function (k) { return k !== 'hidden' && k !== 'discount_price'; }) ? ' style="outline:1px solid var(--green); outline-offset:-1px;"' : '';
        var isHidden = !!p.hidden;
        var isCustom = !!p.custom;
        var img = p.thumb || p.image || 'assets/images/products/placeholder.svg';
        var delBtn = isCustom
          ? '<button class="btn btn-outline btn-sm" data-prod-del="' + h(p.id) + '" title="Удалить карточку из базы">🗑</button>'
          : (isHidden
            ? '<button class="btn btn-outline btn-sm" data-prod-restore="' + h(p.id) + '" title="Вернуть на сайт">↩️</button>'
            : '<button class="btn btn-outline btn-sm" data-prod-del="' + h(p.id) + '" title="Скрыть с сайта">🗑</button>');
        return '<tr' + (isHidden ? ' class="row-hidden"' : '') + changed + '>' +
          '<td><img class="admin-thumb" src="' + h(img) + '" alt="' + h(p.name) + '" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\';"></td>' +
          '<td><strong>' + h(p.name) + '</strong>' + (isCustom ? ' <span class="admin-sc-tag">🖊 ручной</span>' : '') + (isHidden ? ' <span class="badge st-out">скрыт</span>' : '') + '</td>' +
          '<td class="muted-sku">' + h(p.sku) + '</td>' +
          '<td><input class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="description" value="' + h(p.description || '') + '"></td>' +
          '<td><select class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="category">' + catOptionsHtml(p.category || '') + '</select></td>' +
          '<td><input class="cat-input" type="number" min="0" data-cat-prod="' + h(p.id) + '" data-cat-field="price" value="' + h(p.price != null ? p.price : '') + '"></td>' +
          '<td><select class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="priority">' +
          PRIO_OPTIONS.map(function (pr) {
            return '<option value="' + pr[0] + '"' + (prioValue(p) === pr[0] ? ' selected' : '') + '>' + pr[1] + '</option>';
          }).join('') +
          '</select></td>' +
          '<td style="text-align:center;"><input type="checkbox" data-cat-prod="' + h(p.id) + '" data-cat-field="showDiscount" ' + (p.showDiscount !== false ? 'checked' : '') + ' title="Показывать скидочную цену на сайте"></td>' +
          '<td>' + delBtn + '</td>' +
          '</tr>';
      }).join('');
      oldTbody.innerHTML = rows || '<tr><td colspan="9" style="color:var(--muted);">Ничего не найдено.</td></tr>';
      oldTbody.querySelectorAll('[data-cat-prod]').forEach(function (el) {
        var k = el.getAttribute('data-cat-prod') + '|' + el.getAttribute('data-cat-field');
        if (prev[k] === undefined) return;
        if (el.type === 'checkbox') el.checked = prev[k] === '1';
        else if (prev[k] !== el.value) el.value = prev[k];
      });
    }

    drawRows();
    content.querySelector('#prodSearch').addEventListener('input', function (e) {
      state.productSearch = e.target.value;
      drawRows();
    });
    content.querySelector('#prodCatFilter').addEventListener('change', function (e) {
      state.productCatFilter = e.target.value;
      drawRows();
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
                Utils.showToast('⚠️ Не удалось сохранить. Войдите заново (сессия истекла).');
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
              Utils.showToast('⚠️ Не удалось сохранить. Войдите заново (сессия истекла).');
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
      // 1. Собираем правки из полей таблицы
      var edits = {};
      content.querySelectorAll('[data-cat-prod]').forEach(function (el) {
        var prodId = el.getAttribute('data-cat-prod');
        var field = el.getAttribute('data-cat-field');
        var prod = state.products.find(function (x) { return x.id === prodId; });
        if (field === 'showDiscount') {
          var curBool = prod && prod.showDiscount !== undefined ? !!prod.showDiscount : true;
          if (el.checked !== curBool) {
            if (!edits[prodId]) edits[prodId] = {};
            edits[prodId].showDiscount = el.checked;
          }
          return;
        }
        var val = el.value.trim();
        var cur = prod ? prod[field] : null;
        var curStr = cur == null ? '' : String(cur);
        if (field === 'priority' && val === '' && curStr !== '') {
          if (!edits[prodId]) edits[prodId] = {};
          edits[prodId][field] = '';
          return;
        }
        if (val === '' || val === curStr) return;
        if (!edits[prodId]) edits[prodId] = {};
        edits[prodId][field] = field === 'price' || field === 'discount_price' ? parseFloat(val) : val;
      });
      var btn = content.querySelector('#prodSaveBtn');
      btn.disabled = true;
      btn.textContent = '⏳ Сохраняем…';
      Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'save', updates: edits }) }).then(function (res) {
        var ok = res && res.ok;
        if (ok) {
          Utils.showToast('✅ Изменения сохранены — применены на сайте');
        } else {
          Utils.showToast('⚠️ Не удалось сохранить в Worker. Войдите заново (сессия истекла).');
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
      if (!confirm('Сбросить все оверрайды товаров (цены, статусы, скидки, настройки СЦ) к базовым данным? Ручные карточки и скрытые товары останутся.')) return;
      Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'reset' }) }).then(function (res) {
        if (res && res.ok) {
          Utils.showToast('🧹 Все правки товаров сброшены');
        } else {
          Utils.showToast('⚠️ Не удалось сбросить. Войдите заново (сессия истекла).');
        }
        loadData().then(function () { openSection(state.section); });
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

    function drawRows(scId) {
      state.availabilityScId = scId;
      var scOverrides = state.scProductOverrides[scId] || {};
      var q = (searchInput.value || '').trim().toLowerCase();
      var rows = state.products.filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      }).map(function (p) {
        var o = scOverrides[p.id] || {};
        var isHidden = !!o.hidden;
        var basePrice = o.price != null ? o.price : p.price;
        var baseDisc = o.discount_price != null ? o.discount_price : p.discount_price;
        var cnt = StoreStock.count(scId, p.id);
        return '<tr' + (isHidden ? ' class="row-hidden"' : '') + '>' +
          '<td><strong>' + h(p.name) + '</strong>' + (isHidden ? ' <span class="badge st-out">скрыт</span>' : '') + '<br><span class="muted-sku">' + h(p.sku) + '</span></td>' +
          '<td><input class="cat-input" type="number" min="0" data-sc-prod="' + h(p.id) + '" data-sc-field="price" value="' + h(basePrice != null ? basePrice : '') + '"></td>' +
          '<td><input class="cat-input" type="number" min="0" data-sc-prod="' + h(p.id) + '" data-sc-field="discount_price" value="' + h(baseDisc != null ? baseDisc : '') + '" placeholder="—"></td>' +
          '<td><select class="cat-input" data-sc-prod="' + h(p.id) + '" data-sc-field="status">' +
          STATUS_OPTIONS.map(function (o2) {
            return '<option value="' + o2[0] + '"' + ((o.status || p.status) === o2[0] ? ' selected' : '') + '>' + o2[1] + '</option>';
          }).join('') +
          '</select></td>' +
          '<td><input class="cat-input" type="number" min="0" data-stock-prod="' + h(p.id) + '" value="' + h(cnt === null ? '' : cnt) + '" placeholder="—"></td>' +
          '<td style="text-align:center;"><input type="checkbox" data-sc-prod="' + h(p.id) + '" data-sc-field="hidden" ' + (isHidden ? 'checked' : '') + ' title="Скрыть товар в этом филиале"></td>' +
          '</tr>';
      }).join('');
      wrap.innerHTML = '<table class="admin-table"><thead><tr>' +
        '<th style="min-width:200px;">Товар</th><th>Цена ₸</th><th>Скидка ₸</th><th>Наличие</th><th style="min-width:120px;">Остаток</th><th>Скрыть</th>' +
        '</tr></thead><tbody>' + (rows || '<tr><td colspan="6" style="color:var(--muted);">Ничего не найдено.</td></tr>') + '</tbody></table>';
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
      if (state.availabilityScId) drawRows(state.availabilityScId);
    });

    content.querySelector('#avSaveBtn').addEventListener('click', function () {
      if (!state.availabilityScId) {
        Utils.showToast('⚠️ Сначала выберите Сервис-Центр');
        return;
      }
      var scId = state.availabilityScId;
      var edits = {};
      content.querySelectorAll('[data-sc-prod]').forEach(function (el) {
        var pid = el.getAttribute('data-sc-prod');
        var field = el.getAttribute('data-sc-field');
        if (field === 'hidden') {
          if (!edits[pid]) edits[pid] = {};
          edits[pid].hidden = el.checked;
          return;
        }
        var val = el.value.trim();
        var cur = (state.scProductOverrides[scId] || {})[pid] ? state.scProductOverrides[scId][pid][field] : null;
        var curStr = cur == null ? '' : String(cur);
        if (val === '' || val === curStr) return;
        if (!edits[pid]) edits[pid] = {};
        edits[pid][field] = field === 'price' || field === 'discount_price' ? parseFloat(val) : val;
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
        } else {
          Utils.showToast('⚠️ Не удалось сохранить в Worker. Войдите заново (сессия истекла).');
        }
        btn.disabled = false;
        btn.textContent = '💾 Сохранить настройки филиала';
        loadData();
      });
    });

    content.querySelector('#avResetBtn').addEventListener('click', function () {
      if (!state.availabilityScId) {
        Utils.showToast('⚠️ Сначала выберите Сервис-Центр');
        return;
      }
      var scId = state.availabilityScId;
      if (!confirm('Сбросить все настройки товаров для этого филиала (цены, наличие, скрытие)?')) return;
      Auth.api('/api/admin/products', { method: 'POST', body: JSON.stringify({ action: 'resetSc', storeId: scId }) }).then(function (data) {
        if (data && data.ok) {
          Utils.showToast('🧹 Настройки филиала сброшены');
          loadData().then(function () { openSection(state.section); });
        } else {
          Utils.showToast('⚠️ Не удалось сбросить. Войдите заново (сессия истекла).');
        }
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
        var items = {};
        wrap.querySelectorAll('[data-stock-prod]').forEach(function (inp) {
          var v = inp.value.trim();
          if (v === '') return;
          var n = Number(v);
          if (isNaN(n) || n < 0) return;
          items[inp.getAttribute('data-stock-prod')] = n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии';
        });
        avStockSaveBtn.disabled = true;
        avStockSaveBtn.textContent = '⏳ Сохраняем…';
        Auth.api('/api/stock', { method: 'POST', body: JSON.stringify({ scId: scId, items: items }) }).then(function (res) {
          avStockSaveBtn.disabled = false;
          avStockSaveBtn.textContent = '📦 Сохранить остатки (Worker)';
          if (res && res.ok) {
            Utils.showToast('✅ Остатки филиала сохранены — сайт обновлён');
            return StoreStock.reload();
          }
          Utils.showToast('⚠️ Не удалось сохранить. Войдите заново (сессия истекла).');
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
      var stock = {};
      wrap.querySelectorAll('[data-stock-prod]').forEach(function (inp) {
        var val = inp.value.trim();
        if (val === '') return;
        var n = Number(val);
        if (isNaN(n)) return;
        if (!stock[scId]) stock[scId] = {};
        stock[scId][inp.getAttribute('data-stock-prod')] = n > 0 ? 'В наличии (' + n + ' шт)' : 'нет в наличии';
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
            wrap.querySelectorAll('[data-stock-prod]').forEach(function (inp) {
              var pid = inp.getAttribute('data-stock-prod');
              if (stock[scId][pid] !== undefined) {
                var m = /(\d+)\s*шт/.exec(String(stock[scId][pid]));
                inp.value = m ? m[1] : (String(stock[scId][pid]).indexOf('Нет') === 0 ? '0' : '');
              }
            });
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

  // ---------------- Уведомления СЦ ----------------

  function renderNotices(content) {
    var notices = lsGet(KEYS.notices) || [];

    if (isSuper()) {
      content.insertAdjacentHTML('beforeend',
        '<form class="form admin-form" id="noticeForm">' +
        '<h4 style="margin-bottom:10px;">📢 Отправить уведомление Сервис-Центрам</h4>' +
        '<div class="form-group"><label>Текст уведомления</label><textarea name="notice" placeholder="Например: Напоминаем обновить остатки до пятницы!"></textarea></div>' +
        '<div class="admin-actions">' +
        '<button class="btn btn-primary" type="submit">💾 Сохранить уведомление</button>' +
        '<button class="btn btn-whatsapp" type="button" id="noticeTgBtn">✈️ Сохранить и отправить в Telegram</button>' +
        '</div>' +
        '<p style="margin-top:10px; font-size:13px; color:var(--muted);">Уведомления видны в кабинетах СЦ на этом устройстве. Отправка в Telegram приходит вам (единый чат владельца).</p>' +
        '</form>'
      );

      var form = content.querySelector('#noticeForm');
      function addNotice(sendTg) {
        var text = form.notice.value.trim();
        if (!text) { Utils.showToast('Введите текст уведомления'); return; }
        var list = lsGet(KEYS.notices) || [];
        list.unshift({ id: 'n_' + Date.now(), text: text, date: new Date().toISOString() });
        lsSet(KEYS.notices, list);
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
        openSection('notices');
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); addNotice(false); });
      form.querySelector('#noticeTgBtn').addEventListener('click', function () { addNotice(true); });
    }

    var html = '<div class="admin-card"><h4 style="margin-bottom:10px;">История уведомлений</h4><ul class="admin-list">' +
      (notices.length ? notices.map(function (n) {
        return '<li><div class="admin-list-main"><strong>' + h(new Date(n.date).toLocaleString('ru-RU')) + '</strong><span>' + h(n.text) + '</span></div>' +
          (isSuper() ? '<div class="admin-actions"><button class="btn btn-outline btn-sm danger-btn" data-notice-remove="' + h(n.id) + '">🗑</button></div>' : '') +
          '</li>';
      }).join('') : '<li style="color:var(--muted);">Уведомлений пока нет.</li>') +
      '</ul></div>';
    content.insertAdjacentHTML('beforeend', html);

    content.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-notice-remove]');
      if (!btn) return;
      var id = btn.getAttribute('data-notice-remove');
      var list = (lsGet(KEYS.notices) || []).filter(function (n) { return n.id !== id; });
      lsSet(KEYS.notices, list);
      openSection('notices');
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
    var forgotView = document.getElementById('authForgotView');
    var card = document.querySelector('.admin-login-card');
    if (!loginView || !ownerView) return;
    function show(view) {
      loginView.classList.add('hidden');
      if (forgotView) forgotView.classList.add('hidden');
      ownerView.classList.add('hidden');
      view.classList.remove('hidden');
      if (card) {
        if (view === ownerView) card.classList.add('wide');
        else card.classList.remove('wide');
      }
    }
    var ownerBtn = document.getElementById('authOwnerBtn');
    if (ownerBtn) ownerBtn.addEventListener('click', function () { show(ownerView); });
    var forgotBtn = document.getElementById('forgotPassLink');
    if (forgotBtn) forgotBtn.addEventListener('click', function () { show(forgotView); });
    var forgotBack = document.getElementById('forgotBackBtn');
    if (forgotBack) forgotBack.addEventListener('click', function () { show(loginView); });
    var back2 = document.getElementById('authOwnerBackBtn');
    if (back2) back2.addEventListener('click', function () { show(loginView); });

    // Форма «Забыли пароль» — заявка администратору (без email-ссылки)
    var forgotForm = document.getElementById('forgotForm');
    if (forgotForm) {
      forgotForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var msg = document.getElementById('forgotMsg');
        var btn = forgotForm.querySelector('button[type="submit"]');
        var email = forgotForm.email.value.trim();
        if (!email) {
          forgotForm.querySelector('.form-error').style.display = 'block';
          return;
        }
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Отправляем…'; }
        fetch('/api/forgot-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email })
        }).then(function (r) { return r.json().catch(function () { return {}; }); }).then(function (data) {
          if (data && data.ok) {
            msg.textContent = '📨 Если кабинет с таким email существует — заявка отправлена администратору. Он восстановит доступ и свяжется с вами.';
          } else {
            msg.textContent = (data && data.error) || 'Что-то пошло не так — попробуйте позже.';
          }
          if (btn) { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
        }).catch(function () {
          msg.textContent = 'Нет связи с сервером — попробуйте позже.';
          if (btn) { btn.disabled = false; btn.textContent = 'Отправить заявку'; }
        });
      });
    }
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
