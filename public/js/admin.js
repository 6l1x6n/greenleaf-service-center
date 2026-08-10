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
    notices: 'greenleaf_admin_notices_v1',
    texts: 'greenleaf_admin_texts_v1',
    partners: 'greenleaf_partner_stores_v2'
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
    lastAppId: null
  };

  var SECTIONS = {
    overview: { label: '📊 Обзор', roles: ['superadmin'] },
    cabinet: { label: '📋 Кабинет СЦ', roles: ['sc'] },
    sc: { label: '🏬 Сервис-Центры', roles: ['superadmin'] },
    stock: { label: '📦 Остатки товаров', roles: ['superadmin', 'sc'] },
    deliveries: { label: '🚚 Поставки', roles: ['superadmin', 'sc'] },
    events: { label: '📅 Мероприятия', roles: ['superadmin', 'sc'] },
    partners: { label: '🤝 Заявки магазинов', roles: ['superadmin'] },
    scApps: { label: '🗂 Заявки СЦ', roles: ['superadmin'] },
    catalog: { label: '🛒 Каталог товаров', roles: ['superadmin'] },
    notices: { label: '📢 Уведомления СЦ', roles: ['superadmin', 'sc'] },
    texts: { label: '✏️ Тексты сайта', roles: ['superadmin'] }
  };

  function h(v) { return Utils.esc(v); }
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
        return fetch('/api/stores?t=' + Date.now())
          .then(function (r) { return r.json(); })
          .then(function (d) {
            var kv = (d && d.stores) || [];
            var byId = {};
            kv.forEach(function (s) { byId[s.id] = s; });
            var merged = base.map(function (s) { return byId[s.id] ? Object.assign({}, s, byId[s.id]) : s; });
            kv.forEach(function (s) {
              if (!merged.some(function (x) { return x.id === s.id; })) merged.push(s);
            });
            return merged;
          })
          .catch(function () { return base; });
      });
    var p2 = loadJSON('data/products.json').then(function (d) { return d.products || []; }).catch(function () { return []; });
    var p3 = loadJSON('data/deliveries.json').then(function (d) { return mergeDeliveries(d.deliveries || []); }).catch(function () { return mergeDeliveries([]); });
    var p4 = loadJSON('data/events.json').then(function (d) { return mergeEvents(d.events || []); }).catch(function () { return mergeEvents([]); });
    var p5 = window.StoreStock ? StoreStock.load() : Promise.resolve();
    return Promise.all([p1, p2, p3, p4, p5]).then(function (res) {
      state.stores = res[0];
      state.products = res[1];
      state.deliveries = res[2];
      state.events = res[3];
      applyStoreOverrides();
      applyProductOverrides();
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
      stock: renderStock,
      deliveries: renderDeliveries,
      events: renderEvents,
      partners: renderPartners,
      scApps: renderScApplications,
      catalog: renderCatalog,
      notices: renderNotices,
      texts: renderTexts
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
    var partnerStores = getPartnerStores();
    var pending = partnerStores.filter(function (s) { return s.status === 'pending'; }).length;

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
      '<button class="btn btn-primary btn-sm" data-go="partners">🤝 Заявки магазинов (' + pending + ')</button>' +
      '<button class="btn btn-primary btn-sm" data-go="stock">📦 Остатки товаров</button>' +
      '<button class="btn btn-primary btn-sm" data-go="catalog">🛒 Каталог</button>' +
      '</div>' +
      '</div>';
    content.insertAdjacentHTML('beforeend', html);

    ['deliveries', 'events', 'partners', 'stock', 'catalog'].forEach(function (name) {
      var btn = content.querySelector('[data-go="' + name + '"]');
      if (btn) btn.addEventListener('click', function () { openSection(name); });
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

  // ---------------- Сервис-Центры (суперадмин: все филиалы + создание) ----------------

  function storeFormHtml(store, withAuth) {
    var cityOptions = (window.KZ_CITIES_ORDERED || window.KZ_CITIES || []).map(function (c) {
      var top = (window.KZ_CITIES_TOP || []).indexOf(c) !== -1;
      return '<option value="' + h(c) + '"' + ((store.city || '').indexOf(c) !== -1 ? ' selected' : '') + ' class="' + (top ? 'city-top' : '') + '">' + h(c) + '</option>';
    }).join('');
    return '<div class="admin-card">' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;" class="store-auth-grid">' +
      '<div class="form-group"><label>Название СЦ *</label><input name="storeName" value="' + h(store.name) + '" required></div>' +
      '<div class="form-group"><label>Город *</label><select name="city">' + cityOptions + '</select></div>' +
      '</div>' +
      '<div class="form-group"><label>Точный адрес *</label><input name="address" value="' + h(store.address) + '" placeholder="ул. Абая 150" required></div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>Часы работы</label><input name="hours" value="' + h(store.hours) + '" placeholder="Пн–Вс 10:00 – 20:00"></div>' +
      '<div class="form-group"><label>Телефон</label><input name="phone" value="' + h(store.phone) + '" placeholder="+7 (700) 000-00-00"></div>' +
      '</div>' +
      '<div class="form-group"><label>Email владельца (сюда придут логин и пароль кабинета)</label><input name="email" type="email" value="' + h(store.email || '') + '" placeholder="owner@mail.kz"></div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>WhatsApp (только цифры, с 7)</label><input name="whatsapp" value="' + h(store.whatsapp) + '" placeholder="77001234567"></div>' +
      '<div class="form-group"><label>Kaspi QR (путь к картинке статичного QR)</label><input name="kaspi_qr" value="' + h(store.kaspi_qr || '') + '" placeholder="assets/images/kaspi-qr.png"></div>' +
      '</div>' +
      '<div class="form-group"><label>Фото (путь или ссылка)</label><input name="image" value="' + h(store.image || '') + '" placeholder="assets/images/... или https://..."></div>' +
      '<div class="form-group"><label>Краткое описание филиала</label><textarea name="description">' + h(store.description) + '</textarea></div>' +
      '<div style="margin-top:14px; padding-top:14px; border-top:1px solid var(--line);">' +
      '<strong style="font-size:14px;">🔌 Подключение к порталу (автосинхронизация остатков)</strong>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>Код личного кабинета</label><input name="officeCode" value="' + h(store.officeCode || '') + '" placeholder="S240-534"></div>' +
      '<div class="form-group"><label>Логин кабинета поставщика (для парсера)</label><input name="portalLogin" value="' + h(store.portalLogin || '') + '" placeholder="s240534"></div>' +
      '</div>' +
      '<div style="display:grid; grid-template-columns:1fr 1fr; gap:0 14px;">' +
      '<div class="form-group"><label>Пароль кабинета поставщика (для парсера)</label><input name="portalPassword" type="password" value="' + h(store.portalPassword || '') + '" placeholder="••••••••"></div>' +
      '<div class="form-group"><label>Логин партнёра для каталога</label><input name="partner" value="' + h(store.partner || '') + '" placeholder="kz44326234"></div>' +
      '</div>' +
      '<p class="form-note">🔐 Пароль хранится только в Cloudflare KV и используется исключительно парсером для автосинхронизации остатков. На сайте не публикуется.</p>' +
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
      '<div class="admin-actions">' +
      '<button class="btn btn-outline btn-sm" data-copy="' + h(rec.authLogin + ' / ' + rec.authPassword) + '">📋 Копировать</button>' +
      (wa ? '<a class="btn btn-whatsapp btn-sm" href="' + wa + '" target="_blank" rel="noopener">📱 Отправить владельцу</a>' : '') +
      '</div></div>';
  }

  function bindStoreForm(content, store, withAuth) {
    var form = content.querySelector('#storeForm');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      store.name = form.storeName.value;
      store.city = form.city.value;
      store.cityKey = form.city.value.toLowerCase();
      store.address = form.address.value;
      store.hours = form.hours.value;
      store.phone = form.phone.value;
      store.whatsapp = form.whatsapp.value;
      store.kaspi_qr = form.kaspi_qr.value;
      store.image = form.image.value;
      store.description = form.description.value;
      store.officeCode = form.officeCode ? form.officeCode.value : '';
      store.portalLogin = form.portalLogin ? form.portalLogin.value : '';
      store.portalPassword = form.portalPassword ? form.portalPassword.value : '';
      store.partner = form.partner ? form.partner.value : '';
      store.email = form.email ? form.email.value : '';
      store.phoneRaw = (store.phone || '').replace(/\D/g, '');
      if (store.phoneRaw && !store.whatsapp) store.whatsapp = store.phoneRaw;

      var isRegistered = !!(store.officeCode || store.portalLogin || store.portalPassword);
      if (isRegistered) {
        // Подключённый СЦ хранится в Worker KV (карточка + креды для парсера + выданный доступ)
        var officeId = String(store.officeCode || '').replace(/[^A-Za-z0-9]/g, '').toLowerCase();
        var isNew = !store.id || String(store.id).indexOf('sc-new-') === 0;
        var payload = {
          id: isNew ? (officeId || store.id) : store.id,
          officeCode: store.officeCode,
          name: store.name,
          city: store.city,
          cityKey: store.cityKey,
          address: store.address,
          hours: store.hours,
          phone: store.phone,
          phoneRaw: store.phoneRaw,
          whatsapp: store.whatsapp,
          email: store.email,
          image: store.image,
          description: store.description,
          partner: store.partner,
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
          Utils.showToast('✅ Сервис-Центр сохранён — остатки будут парситься автоматически');
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
        return;
      }

      var saved = lsGet(KEYS.stores) || {};
      saved[store.id] = Object.assign({}, store);
      lsSet(KEYS.stores, saved);
      Utils.showToast('✅ Филиал сохранён');
      loadData().then(function () { openSection(state.section); });
    });

    content.addEventListener('click', function (e) {
      var copyBtn = e.target.closest('[data-copy]');
      if (!copyBtn) return;
      var text = copyBtn.getAttribute('data-copy');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { Utils.showToast('📋 Скопировано'); });
      }
    });

    var delBtn = content.querySelector('#storeDeleteBtn');
    if (delBtn) {
      delBtn.addEventListener('click', function () {
        if (!confirm('Удалить филиал «' + store.name + '»? Восстановить его можно будет только вручную.')) return;
        var isRegistered = !!(store.officeCode || store.portalLogin || store.portalPassword);
        if (isRegistered) {
          Auth.api('/api/sc-store', { method: 'DELETE', body: JSON.stringify({ id: store.id }) }).then(function (res) {
            var saved = lsGet(KEYS.stores) || {};
            delete saved[store.id];
            lsSet(KEYS.stores, saved);
            state.editingStoreId = null;
            Utils.showToast(res && res.ok ? '✅ Филиал удалён (карточка в Worker тоже)' : '⚠️ Удалено локально, карточка в Worker не удалилась');
            loadData().then(function () { openSection('sc'); });
          });
          return;
        }
        var saved = lsGet(KEYS.stores) || {};
        delete saved[store.id];
        lsSet(KEYS.stores, saved);
        state.editingStoreId = null;
        Utils.showToast('Филиал удалён');
        loadData().then(function () { openSection('sc'); });
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
          '<div class="admin-actions"><button class="btn btn-outline btn-sm" data-sc-edit="' + h(s.id) + '">✏️ Редактировать</button></div>' +
          '</li>';
      }).join('') +
      '</ul></div>';

    content.insertAdjacentHTML('beforeend', cardsHtml);

    content.querySelector('#scAddStoreBtn').addEventListener('click', function () {
      state.editingStoreId = 'new';
      openSection('sc');
    });

    content.querySelector('#scStoresList').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-sc-edit]');
      if (!btn) return;
      state.editingStoreId = btn.getAttribute('data-sc-edit');
      openSection('sc');
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
      content.insertAdjacentHTML('beforeend', '<h4 style="margin-bottom:8px; color:var(--green-dark);">➕ Новый филиал</h4><form class="form admin-form" id="storeForm">' + storeFormHtml(newStore, true) + '</form>');
      bindStoreForm(content, newStore, true);
      return;
    }

    var store = list.find(function (s) { return s.id === selectedId; });
    if (!store) return;
    content.insertAdjacentHTML('beforeend',
      '<h4 style="margin-bottom:8px; color:var(--green-dark);">✏️ Редактирование: ' + h(store.name) + '</h4>' +
      '<form class="form admin-form" id="storeForm">' + storeFormHtml(store, true) + '</form>'
    );
    bindStoreForm(content, store, true);
  }

  // ---------------- Остатки ----------------

  function renderStock(content) {
    var visibleStores = isSuper() ? state.stores : state.stores.filter(function (s) { return s.id === state.user.id; });

    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">📦 Остатки сохраняются на этом устройстве и видны в каталоге здесь. Чтобы посетители увидели остатки по филиалам: нажмите «Экспорт JSON», сохраните файл как <b>data/store-stock.json</b> и загрузите его в репозиторий (Decap CMS → GitHub) или через «Импорт JSON» ниже.</div>' +
      '<div class="admin-toolbar"><input class="search" id="stockSearch" type="search" placeholder="Поиск по названию или артикулу…" autocomplete="off"></div>' +
      '<div class="admin-card admin-table-wrap">' +
      '<table class="admin-table" id="stockTable">' +
      '<thead><tr><th style="min-width:220px;">Товар</th>' +
      visibleStores.map(function (s) { return '<th>' + h(s.name) + '</th>'; }).join('') +
      '</tr></thead><tbody id="stockTbody"></tbody></table>' +
      '</div>' +
      '<div class="admin-actions" style="flex-wrap:wrap;">' +
      '<button class="btn btn-primary" id="stockSaveBtn">💾 Сохранить остатки</button>' +
      '<button class="btn btn-outline" id="stockExportBtn">⬇️ Экспорт JSON (store-stock.json)</button>' +
      '<button class="btn btn-outline" id="stockImportBtn">⬆️ Импорт JSON</button>' +
      '<input type="file" id="stockImportFile" accept="application/json,.json" style="display:none;">' +
      '</div>'
    );

    function drawRows(query) {
      var q = (query || '').trim().toLowerCase();
      var rows = state.products.filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      }).map(function (p) {
        return '<tr>' +
          '<td><strong>' + h(p.name) + '</strong><br><span class="muted-sku">' + h(p.sku) + '</span></td>' +
          visibleStores.map(function (s) {
            var val = StoreStock.text(s.id, p.id);
            return '<td><input data-stock-sc="' + h(s.id) + '" data-stock-prod="' + h(p.id) + '" value="' + h(val === undefined ? '' : val) + '" placeholder="Например: В наличии (10 шт)"></td>';
          }).join('') +
          '</tr>';
      }).join('');
      document.getElementById('stockTbody').innerHTML = rows || '<tr><td colspan="99" style="color:var(--muted);">Ничего не найдено.</td></tr>';
    }

    drawRows('');
    content.querySelector('#stockSearch').addEventListener('input', function (e) { drawRows(e.target.value); });

    content.querySelector('#stockSaveBtn').addEventListener('click', function () {
      var saved = lsGet(KEYS.stock) || {};
      content.querySelectorAll('[data-stock-sc]').forEach(function (inp) {
        var scId = inp.getAttribute('data-stock-sc');
        if (!saved[scId]) saved[scId] = {};
        saved[scId][inp.getAttribute('data-stock-prod')] = inp.value;
      });
      lsSet(KEYS.stock, saved);
      Utils.showToast('✅ Остатки сохранены');
      loadData().then(function () { openSection(state.section); });
    });

    content.querySelector('#stockExportBtn').addEventListener('click', function () {
      var stock = {};
      content.querySelectorAll('[data-stock-sc]').forEach(function (inp) {
        var val = inp.value.trim();
        if (!val) return;
        var scId = inp.getAttribute('data-stock-sc');
        if (!stock[scId]) stock[scId] = {};
        stock[scId][inp.getAttribute('data-stock-prod')] = val;
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
          lsSet(KEYS.stock, stock);
          Utils.showToast('⬆️ Остатки импортированы — применены на этом устройстве');
          loadData().then(function () { openSection(state.section); });
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
    return '<form class="form admin-form" id="deliveryForm">' +
      '<h4 style="margin-bottom:10px;">' + (editing ? '✏️ Изменить поставку' : '➕ Новая поставка') + '</h4>' +
      (isSuper()
        ? '<div class="form-group"><label>Филиал</label>' + storeSelectHtml(editing ? editing.storeId || '' : (state.user && state.user.role === 'sc' ? state.user.id : '')) + '</div>'
        : '') +
      '<div style="display:grid; grid-template-columns:180px 1fr; gap:12px;">' +
      '<div class="form-group"><label>Дата *</label><input type="date" name="date" value="' + h(editing ? editing.date : '') + '" required></div>' +
      '<div class="form-group"><label>Описание *</label><input name="note" value="' + h(editing ? editing.note : '') + '" placeholder="Например: Поставка эко-порошков iLife" required></div>' +
      '</div>' +
      '<div class="form-group"><label>Что приедет (позиции через запятую)</label>' +
      '<textarea name="items" placeholder="Эко-порошок iLife 1 кг; Средство для посуды; Гели CARICH">' + h(editing ? editing.items || '' : '') + '</textarea></div>' +
      '<div class="admin-actions">' +
      '<button class="btn btn-primary" type="submit">' + (editing ? '💾 Сохранить' : '➕ Добавить') + '</button>' +
      (editing ? '<button class="btn btn-outline" type="button" id="deliveryCancelEdit">Отмена</button>' : '') +
      '</div>' +
      '</form>';
  }

  function renderDeliveries(content) {
    var editingId = state.editingDeliveryId;
    var editing = editingId ? state.deliveries.find(function (d) { return d.id === editingId; }) : null;

    // СЦ видит только свои поставки, суперадмин — все
    var visible = isSuper()
      ? state.deliveries
      : state.deliveries.filter(function (d) { return d.storeId === state.user.id; });

    content.insertAdjacentHTML('beforeend', deliveryFormHtml(editing, editingId));

    var listEl = document.createElement('div');
    listEl.className = 'admin-card';
    listEl.innerHTML = '<ul class="admin-list" id="deliveryList"></ul>';
    content.appendChild(listEl);

    function drawList() {
      var ul = listEl.querySelector('#deliveryList');
      ul.innerHTML = visible.map(function (d) {
        var dt = Utils.fmtDate(d.date + 'T00:00:00', { day: 'numeric', month: 'long', year: 'numeric' });
        var storeName = d.storeId
          ? (function () { var s = state.stores.find(function (x) { return x.id === d.storeId; }); return s ? s.name : d.storeId; })()
          : 'Общая поставка';
        var itemsTxt = d.items ? '<span class="muted-sku">📦 Прибудет: ' + h(d.items) + '</span>' : '';
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(dt) + ' <span style="font-weight:500; color:var(--green); font-size:12.5px;">· ' + h(storeName) + '</span></strong>' +
          '<span>' + h(d.note || '') + '</span>' +
          itemsTxt +
          '</div>' +
          '<div class="admin-actions">' +
          '<button class="btn btn-outline btn-sm" data-del-edit="' + h(d.id) + '">✏️ Изменить</button>' +
          '<button class="btn btn-outline btn-sm danger-btn" data-del-remove="' + h(d.id) + '">' + Utils.iconTrash(14) + 'Удалить</button>' +
          '</div></li>';
      }).join('') || '<li style="color:var(--muted);">Поставок пока нет — добавьте первую.</li>';
    }
    drawList();

    var form = content.querySelector('#deliveryForm');
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var storeId = isSuper() ? form.storeId.value : state.user.id;
      var item = {
        date: form.date.value,
        note: form.note.value.trim(),
        items: form.items.value.trim()
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
      '</form>'
    );

    var listEl = document.createElement('div');
    listEl.className = 'admin-card';
    listEl.innerHTML = '<ul class="admin-list" id="eventList"></ul>';
    content.appendChild(listEl);

    function drawList() {
      var ul = listEl.querySelector('#eventList');
      var bookings = (function () {
        try { return JSON.parse(localStorage.getItem('greenleaf_event_bookings_v1') || '{}'); } catch (e) { return {}; }
      })();
      ul.innerHTML = visible.map(function (ev) {
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
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var storeId = isSuper() ? form.storeId.value : state.user.id;
      var item = {
        title: form.title.value.trim(),
        date: form.date.value,
        time: form.time.value.trim(),
        place: form.place.value.trim(),
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

  // ---------------- Заявки магазинов ----------------

  function getPartnerStores() {
    var saved = lsGet(KEYS.partners);
    if (saved && Array.isArray(saved)) return saved;
    return [];
  }

  function savePartnerStores(list) {
    lsSet(KEYS.partners, list);
  }

  function partnerStoreId(item) {
    return 'sc-partner-' + item.id;
  }

  function deriveCityKey(cityName) {
    var c = String(cityName || '').trim();
    if (!c) return 'other';
    var found = state.stores.find(function (s) {
      return s.city && s.city.indexOf(c) !== -1;
    });
    if (found && found.cityKey) return found.cityKey;
    return c.toLowerCase();
  }

  function createStoreCardFromRequest(item) {
    var parts = String(item.city || '').split(',').map(function (p) { return p.trim(); });
    var cityName = parts[0].replace(/^г\.\s*/i, '').trim();
    var addrPart = parts.slice(1).join(', ').trim();
    var saved = lsGet(KEYS.stores) || {};
    var entry = {
      name: item.storeName || 'Магазин-партнёр Greenleaf',
      city: cityName ? 'г. ' + cityName : '',
      cityKey: deriveCityKey(cityName),
      address: addrPart || 'Адрес уточняется',
      hours: 'Пн–Вс 10:00 – 20:00',
      phone: item.phone || '',
      phoneRaw: String(item.phone || '').replace(/[^\d+]/g, ''),
      whatsapp: String(item.phone || '').replace(/[^\d]/g, ''),
      image: 'assets/images/products/placeholder.svg',
      description: item.message || 'Магазин-партнёр Greenleaf. Приходите за эко-продукцией!',
      isPartner: true
    };
    saved[partnerStoreId(item)] = Object.assign({}, saved[partnerStoreId(item)], entry);
    lsSet(KEYS.stores, saved);
  }

  function removeStoreCardFromRequest(item) {
    var saved = lsGet(KEYS.stores) || {};
    var id = partnerStoreId(item);
    if (saved[id]) {
      delete saved[id];
      lsSet(KEYS.stores, saved);
    }
  }

  function renderPartners(content) {
    var list = getPartnerStores();

    var html = '<div class="admin-card">' +
      '<p style="color:var(--muted); font-size:13.5px; margin-bottom:12px;">Заявки с формы регистрации магазина (через «Войти» → «Регистрация» → «Я владелец магазина») появляются здесь со статусом «На рассмотрении». Одобренные заявки создают карточку филиала в секции «Сервис-Центры» на сайте.</p>' +
      '<ul class="admin-list">' +
      (list.length
        ? list.map(function (s) {
        var badge = s.status === 'pending' ? '⏳ На рассмотрении' : (s.status === 'rejected' ? '❌ Отклонена' : '🏬 Действующий');
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(s.storeName || 'Магазин') + ' <span style="font-weight:400; font-size:12.5px; color:var(--muted);">' + h(badge) + '</span></strong>' +
          '<span>📍 ' + h(s.city || '') + ' · 👤 ' + h(s.name || '') + ' · 📞 ' + h(s.phone || '') + '</span>' +
          (s.message ? '<span style="color:var(--muted);">«' + h(s.message) + '»</span>' : '') +
          '</div>' +
          '<div class="admin-actions" style="flex-wrap:wrap;">' +
          (s.status !== 'active' ? '<button class="btn btn-primary btn-sm" data-pt-approve="' + h(s.id) + '">✅ Одобрить</button>' : '') +
          (s.status !== 'rejected' ? '<button class="btn btn-outline btn-sm danger-btn" data-pt-reject="' + h(s.id) + '">🚫 Отклонить</button>' : '') +
          '<button class="btn btn-outline btn-sm danger-btn" data-pt-remove="' + h(s.id) + '">' + Utils.iconTrash(14) + 'Удалить</button>' +
          '</div></li>';
      }).join('')
        : '<li style="color:var(--muted);">Заявок пока нет. Новые заявки с формы «Регистрация магазина» появятся здесь.</li>') +
      '</ul></div>';

    content.insertAdjacentHTML('beforeend', html);

    var ul = content.querySelector('.admin-list');
    ul.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-pt-approve], [data-pt-reject], [data-pt-remove]');
      if (!btn) return;
      var id = btn.getAttribute('data-pt-approve') || btn.getAttribute('data-pt-reject') || btn.getAttribute('data-pt-remove');
      var item = list.find(function (x) { return x.id === id; });
      if (!item) return;
      if (btn.hasAttribute('data-pt-approve')) {
        item.status = 'active';
        item.statusLabel = '🏬 Действующий магазин';
        createStoreCardFromRequest(item);
        Utils.showToast('✅ Заявка одобрена — карточка добавлена в «Сервис-Центры»');
      } else if (btn.hasAttribute('data-pt-reject')) {
        item.status = 'rejected';
        item.statusLabel = '❌ Отклонена';
        removeStoreCardFromRequest(item);
        Utils.showToast('🚫 Заявка отклонена');
      } else {
        if (!confirm('Удалить заявку «' + item.storeName + '»?')) return;
        removeStoreCardFromRequest(item);
        list = list.filter(function (x) { return x.id !== id; });
        Utils.showToast('Заявка удалена');
      }
      savePartnerStores(list);
      openSection('partners');
    });
  }

  // ---------------- Заявки Сервис-Центров (суперадмин, Worker KV) ----------------

  function renderScApplications(content) {
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-card">' +
      '<p style="color:var(--muted); font-size:13.5px; margin-bottom:12px;">Заявки на подключение Сервис-Центра приходят из формы регистрации («Войти» → «Регистрация» → «Я владелец магазина» → «Сервис-Центр»). Проверьте, что заявитель действительно владелец магазина, и создайте карточку — остатки этого СЦ начнут парситься автоматически.</p>' +
      '<div id="scAppsList">Загружаем заявки…</div>' +
      '</div>'
    );
    var listEl = content.querySelector('#scAppsList');

    Auth.api('/api/sc-applications').then(function (data) {
      var apps = (data && data.applications) || [];
      if (!apps.length) {
        listEl.innerHTML = '<div class="owner-req-empty">Заявок пока нет. Новые заявки появятся здесь автоматически.</div>';
        return;
      }
      listEl.innerHTML = '<ul class="admin-list">' + apps.map(function (a) {
        var badge = a.status === 'pending' ? '⏳ На рассмотрении' : (a.status === 'rejected' ? '❌ Отклонена' : '✅ Одобрена');
        return '<li>' +
          '<div class="admin-list-main">' +
          '<strong>' + h(a.storeName || 'Магазин') + ' <span style="font-weight:400; font-size:12.5px; color:var(--muted);">' + h(badge) + '</span></strong>' +
          '<span>🔑 Код кабинета: <b>' + h(a.officeCode || '—') + '</b> · 👤 ' + h(a.name || '') + ' · 📞 ' + h(a.phone || '') + '</span>' +
          (a.email ? '<span>📧 <b>' + h(a.email) + '</b> — сюда придут логин и пароль кабинета</span>' : '') +
          '<span>📍 ' + h(a.city || '') + (a.address ? ', ' + h(a.address) : '') + '</span>' +
          '<span style="color:var(--muted);">👤 Логин поставщика: ' + h(a.portalLogin || '—') + ' · 🔒 Пароль: <b>' + h(a.portalPassword || '—') + '</b></span>' +
          (a.comment ? '<span style="color:var(--muted);">«' + h(a.comment) + '»</span>' : '') +
          '<span style="color:var(--muted); font-size:12px;">🕐 ' + h(new Date(a.createdAt).toLocaleString('ru-RU', { timeZone: 'Asia/Almaty' })) + '</span>' +
          '</div>' +
          '<div class="admin-actions" style="flex-wrap:wrap;">' +
          (a.status === 'pending' ? '<button class="btn btn-primary btn-sm" data-sc-app-approve="' + h(a.id) + '">✅ Подтвердить и создать СЦ</button>' : '') +
          (a.status !== 'approved' ? '<button class="btn btn-outline btn-sm" data-sc-app-edit="' + h(a.id) + '">✏️ Редактировать перед созданием</button>' : '') +
          (a.status !== 'approved' && a.status !== 'rejected' ? '<button class="btn btn-outline btn-sm danger-btn" data-sc-app-reject="' + h(a.id) + '">🚫 Отклонить</button>' : '') +
          '</div></li>';
      }).join('') + '</ul>';

      listEl.addEventListener('click', function (e) {
        var approveBtn = e.target.closest('[data-sc-app-approve]');
        if (approveBtn) {
          var app = apps.find(function (x) { return x.id === approveBtn.getAttribute('data-sc-app-approve'); });
          if (!app) return;
          if (!confirm('Создать карточку СЦ «' + app.storeName + '» из заявки? Логин и пароль кабинета уйдут на ' + (app.email || 'указанную почту') + '.')) return;
          Auth.api('/api/sc-application', { method: 'POST', body: JSON.stringify({ id: app.id, action: 'approve', create: true }) }).then(function (res) {
            if (res && res.store) {
              Utils.showToast('✅ СЦ создан: ' + res.store.name + ' — доступы отправлены на почту');
            } else {
              Utils.showToast('✅ Заявка одобрена');
            }
            openSection('scApps');
          });
          return;
        }
        var editBtn = e.target.closest('[data-sc-app-edit]');
        if (editBtn) {
          var appEdit = apps.find(function (x) { return x.id === editBtn.getAttribute('data-sc-app-edit'); });
          if (!appEdit) return;
          state.lastAppId = appEdit.id;
          state.editingStoreId = 'new';
          state.newStoreFromApp = appEdit;
          openSection('sc');
          return;
        }
        var rejectBtn = e.target.closest('[data-sc-app-reject]');
        if (rejectBtn) {
          var app2 = apps.find(function (x) { return x.id === rejectBtn.getAttribute('data-sc-app-reject'); });
          if (!app2) return;
          if (!confirm('Отклонить заявку «' + app2.storeName + '»?')) return;
          Auth.api('/api/sc-application', { method: 'POST', body: JSON.stringify({ id: app2.id, action: 'reject' }) }).then(function () {
            Utils.showToast('🚫 Заявка отклонена');
            openSection('scApps');
          });
        }
      });
    });
  }

  // ---------------- Каталог товаров ----------------

  function renderCatalog(content) {
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-toolbar"><input class="search" id="catSearch" type="search" placeholder="Поиск по названию или артикулу…" autocomplete="off"></div>' +
      '<div class="admin-card admin-table-wrap">' +
      '<table class="admin-table"><thead><tr>' +
      '<th>Артикул</th><th style="min-width:200px;">Название</th><th>Категория</th><th>Цена ₸</th><th>Статус</th><th>Поставка (ETA)</th><th>Завоз (в пути)</th>' +
      '</tr></thead><tbody id="catTbody"></tbody></table>' +
      '</div>' +
      '<button class="btn btn-primary" id="catSaveBtn">💾 Сохранить изменения каталога</button>' +
      '<p style="margin-top:10px; font-size:13px; color:var(--muted);">Правки (цена, статус, даты) сохраняются в этом браузере и применяются к каталогу на сайте. Пустые поля не меняют данные.</p>'
    );

    function drawRows(query) {
      var q = (query || '').trim().toLowerCase();
      var rows = state.products.filter(function (p) {
        return !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      }).map(function (p) {
        return '<tr>' +
          '<td class="muted-sku">' + h(p.sku) + '</td>' +
          '<td>' + h(p.name) + '</td>' +
          '<td><input class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="category" value="' + h(p.category || '') + '"></td>' +
          '<td><input class="cat-input" type="number" min="0" data-cat-prod="' + h(p.id) + '" data-cat-field="price" value="' + h(p.price != null ? p.price : '') + '"></td>' +
          '<td><select class="cat-input" data-cat-prod="' + h(p.id) + '" data-cat-field="status">' +
          STATUS_OPTIONS.map(function (o) {
            return '<option value="' + o[0] + '"' + (p.status === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
          }).join('') +
          '</select></td>' +
          '<td><input class="cat-input" type="date" data-cat-prod="' + h(p.id) + '" data-cat-field="eta" value="' + h(p.eta || '') + '"></td>' +
          '<td><input class="cat-input" type="date" data-cat-prod="' + h(p.id) + '" data-cat-field="incoming" value="' + h(p.incoming || '') + '"></td>' +
          '</tr>';
      }).join('');
      document.getElementById('catTbody').innerHTML = rows || '<tr><td colspan="7" style="color:var(--muted);">Ничего не найдено.</td></tr>';
    }

    drawRows('');
    content.querySelector('#catSearch').addEventListener('input', function (e) { drawRows(e.target.value); });

    content.querySelector('#catSaveBtn').addEventListener('click', function () {
      var saved = lsGet(KEYS.products) || {};
      content.querySelectorAll('[data-cat-prod]').forEach(function (el) {
        var prodId = el.getAttribute('data-cat-prod');
        var field = el.getAttribute('data-cat-field');
        var val = el.value.trim();
        var prod = state.products.find(function (x) { return x.id === prodId; });
        var cur = prod ? prod[field] : null;
        var curStr = cur == null ? '' : String(cur);
        if (val === '' || val === curStr) return;
        if (!saved[prodId]) saved[prodId] = {};
        saved[prodId][field] = field === 'price' ? parseFloat(val) : val;
      });
      lsSet(KEYS.products, saved);
      Utils.showToast('✅ Изменения каталога сохранены');
      loadData().then(function () { openSection(state.section); });
    });
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

  // ---------------- Тексты сайта ----------------

  function renderTexts(content) {
    content.insertAdjacentHTML('beforeend',
      '<div class="admin-note">✏️ Здесь можно менять тексты сайта. Альтернатива: на самом сайте при входе суперадмином кликните по любому тексту и редактируйте прямо на месте.</div>' +
      '<div class="admin-card"><ul class="admin-list" id="textsList"></ul></div>' +
      '<button class="btn btn-primary" id="textsSaveBtn">💾 Сохранить тексты</button>' +
      '<p style="margin-top:10px; font-size:13px; color:var(--muted);">Тексты сохраняются в этом браузере и применяются при загрузке сайта на этом устройстве. Для правок «для всех посетителей» используйте админку /admin (Decap CMS → GitHub).</p>'
    );

    var overrides = lsGet(KEYS.texts) || {};

    fetch('index.html')
      .then(function (r) { return r.text(); })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var els = doc.querySelectorAll('[data-edit-key]');
        if (!els.length) {
          document.getElementById('textsList').innerHTML = '<li style="color:var(--muted);">Не найдено редактируемых текстов.</li>';
          return;
        }
        document.getElementById('textsList').innerHTML = Array.prototype.map.call(els, function (el) {
          var key = el.getAttribute('data-edit-key');
          var val = overrides[key] !== undefined ? overrides[key] : el.textContent.trim();
          return '<li>' +
            '<div class="admin-list-main">' +
            '<strong>' + h(key) + '</strong>' +
            '<input data-text-key="' + h(key) + '" value="' + h(val) + '">' +
            '</div></li>';
        }).join('');
      })
      .catch(function () {
        document.getElementById('textsList').innerHTML = '<li style="color:var(--muted);">Не удалось загрузить index.html для чтения текущих текстов.</li>';
      });

    content.querySelector('#textsSaveBtn').addEventListener('click', function () {
      var texts = {};
      content.querySelectorAll('[data-text-key]').forEach(function (el) {
        var v = el.value.trim();
        if (v) texts[el.getAttribute('data-text-key')] = v;
      });
      lsSet(KEYS.texts, texts);
      Utils.showToast('✅ Тексты сайта сохранены');
    });
  }

  // ---------------- Вход / выход ----------------

  function showLogin() {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('adminLayout').classList.add('hidden');
    var clientLayout = document.getElementById('clientLayout');
    if (clientLayout) clientLayout.classList.add('hidden');
    var badge = document.getElementById('adminUserBadge');
    var logout = document.getElementById('adminLogoutBtn');
    if (badge) badge.classList.add('hidden');
    if (logout) logout.classList.add('hidden');
  }

  function showClientPanel() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('adminLayout').classList.add('hidden');
    var clientLayout = document.getElementById('clientLayout');
    if (!clientLayout) { showPanel(); return; }
    clientLayout.classList.remove('hidden');
    var user = state.user || {};
    var nameEl = document.getElementById('clientName');
    if (nameEl) nameEl.textContent = user.name || user.login || 'клиент';
    var emailEl = document.getElementById('clientEmail');
    if (emailEl) emailEl.textContent = user.email || user.login || '—';
    var phoneEl = document.getElementById('clientPhone');
    if (phoneEl) phoneEl.textContent = user.phone || '—';
    var badge = document.getElementById('adminUserBadge');
    var logout = document.getElementById('adminLogoutBtn');
    if (badge) { badge.classList.remove('hidden'); badge.innerHTML = '🧑 ' + h(user.name || user.login || 'клиент'); }
    if (logout) logout.classList.remove('hidden');
  }

  function showPanel() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('adminLayout').classList.remove('hidden');
    var clientLayout = document.getElementById('clientLayout');
    if (clientLayout) clientLayout.classList.add('hidden');
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
    var regView = document.getElementById('authRegView');
    var ownerView = document.getElementById('authOwnerView');
    var card = document.querySelector('.admin-login-card');
    if (!loginView || !regView || !ownerView) return;
    function show(view) {
      loginView.classList.add('hidden');
      regView.classList.add('hidden');
      ownerView.classList.add('hidden');
      view.classList.remove('hidden');
      if (card) card.classList.toggle('wide', view === ownerView);
    }
    var regBtn = document.getElementById('authRegBtn');
    if (regBtn) regBtn.addEventListener('click', function () { show(regView); });
    var ownerBtn = document.getElementById('authOwnerBtn');
    if (ownerBtn) ownerBtn.addEventListener('click', function () { show(ownerView); });
    var back1 = document.getElementById('authBackToLoginBtn');
    if (back1) back1.addEventListener('click', function () { show(loginView); });
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
          if (user.role === 'client') {
            showClientPanel();
            return;
          }
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

    var clientLogout = document.getElementById('clientLogoutBtn');
    if (clientLogout) {
      clientLogout.addEventListener('click', function (e) {
        e.preventDefault();
        Auth.setCurrentUser(null);
        state.user = null;
        showLogin();
      });
    }

    document.getElementById('adminNav').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-section]');
      if (!btn) return;
      openSection(btn.getAttribute('data-section'));
    });

    var user = Auth.getCurrentUser();
    if (user) {
      state.user = user;
      if (user.role === 'client') {
        showClientPanel();
      } else {
        loadData().then(showPanel);
      }
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    init();
  }
})();
