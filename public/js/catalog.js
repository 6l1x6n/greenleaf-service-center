(function () {
  'use strict';

  var STATUS = {
    in_stock: { label: 'В наличии', cls: 'st-in', icon: '✅' },
    low: { label: 'Заканчивается', cls: 'st-low', icon: '⚠️' },
    expected: { label: 'Ожидается', cls: 'st-exp', icon: '📦' },
    out: { label: 'Нет в наличии', cls: 'st-out', icon: '—' }
  };

  var ORDER = { in_stock: 0, low: 1, expected: 2, out: 3 };

  var products = [];
  var stores = [];
  var categories = [];
  var state = { category: 'all', query: '', stockOnly: true, selectedStoreId: 'all', cityFilter: 'all', storeQuery: '', showAllCatalog: false };

  var isCatalogPage = document.body && document.body.dataset.catalogPage === '1';
  var MAIN_PAGE_LIMIT = 10;
  var FILTERS_KEY = 'greenleaf_catalog_filters_v1';

  var grid = document.getElementById('grid');
  var chips = document.getElementById('chips');
  var search = document.getElementById('search');
  var stockOnly = document.getElementById('stockOnly');
  var scActiveBannerContainer = document.getElementById('scActiveBannerContainer');

  // Оверрайды из Worker: глобальные правки товаров и правки по Сервис-Центрам.
  // Устанавливаются в init() из /api/products.
  var productOverrides = {};
  var scOverrides = {};
  var siteSettings = { showDiscountPrices: true, categories: [] };

  // Оверрайд товара в выбранном СЦ (или пустой объект)
  function scOverrideFor(p) {
    if (!p) return {};
    if (state.selectedStoreId && state.selectedStoreId !== 'all') {
      var o = scOverrides[state.selectedStoreId];
      if (o && o[p.id]) return o[p.id];
    }
    return {};
  }

  // Товар скрыт в выбранном СЦ суперадмином
  function scHidden(p) {
    return !!scOverrideFor(p).hidden;
  }

  // Приоритет товара: 1 🔥 Хит, 2 ✨ Новинка, 3 🚀 Топ (0 — без приоритета)
  function priorityRank(p) {
    if (p.priority != null && p.priority !== '') return Number(p.priority);
    return p.hit ? 1 : 0;
  }

  function priorityBadge(p) {
    var pr = priorityRank(p);
    if (pr === 1) return '<span class="badge-hot badge-p1">🔥 Хит</span>';
    if (pr === 2) return '<span class="badge-hot badge-p2">✨ Новинка</span>';
    if (pr === 3) return '<span class="badge-hot badge-p3">🚀 Топ</span>';
    return '';
  }

  // Актуальный статус: оверрайд СЦ → глобальный → базовый
  function effectiveStatus(p) {
    var so = scOverrideFor(p);
    if (so.status) return so.status;
    return p.status;
  }

  function statusInfo(p) {
    var st = STATUS[effectiveStatus(p)] || STATUS.out;
    var so = scOverrideFor(p);
    var eta = so.eta || p.eta;
    var incoming = so.incoming || p.incoming;
    var extra = '';
    if (st === STATUS.low) {
      extra = '<p class="eta-line">📦 ' + (incoming ? 'Завоз: <b>' + Utils.fmtDate(incoming, { day: 'numeric', month: 'short' }) + '</b>' : 'Возьмём в работу — напишите нам') + '</p>';
    } else if (st === STATUS.expected) {
      extra = '<p class="eta-line">Поставка: <b>' + Utils.fmtDate(eta, { day: 'numeric', month: 'long' }) + '</b></p>';
    } else if (st === STATUS.out) {
      extra = '<p class="eta-line">Следующая поставка: <b>' + Utils.fmtDate(eta, { day: 'numeric', month: 'long' }) + '</b></p>';
    } else if (incoming) {
      extra = '<p class="eta-line">Завоз в пути: <b>' + Utils.fmtDate(incoming, { day: 'numeric', month: 'short' }) + '</b></p>';
    }
    return { meta: st, extra: extra };
  }

  // Актуальная цена и скидочная цена: оверрайд СЦ → глобальный оверрайд → базовый товар
  function effectivePrices(p) {
    var so = scOverrideFor(p);
    var global = productOverrides[p.id] || {};
    var price = so.price != null ? so.price : (global.price != null ? global.price : p.price);
    var discount = so.discount_price != null ? so.discount_price : (global.discount_price != null ? global.discount_price : p.discount_price);
    return { price: price, discount: discount };
  }

  function scAppliedTo(storeId) {
    var o = scOverrides[storeId];
    return !!(o && Object.keys(o).length);
  }

  function rowCartControl(p) {
    var item = Cart.get().find(function (i) { return i.id === p.id; });
    if (item) {
      return '<div class="qty-stepper" data-cart-row="' + Utils.esc(p.id) + '">' +
        '<button class="qty-btn" data-cart-dec="' + Utils.esc(p.id) + '" aria-label="Уменьшить">−</button>' +
        '<input type="number" class="qty-input" data-cart-qty="' + Utils.esc(p.id) + '" min="1" max="999" value="' + (Number(item.qty) || 1) + '" aria-label="Количество">' +
        '<button class="qty-btn" data-cart-inc="' + Utils.esc(p.id) + '" aria-label="Увеличить">+</button>' +
        '</div>' +
        '<button class="btn btn-light-outline btn-sm row-remove" data-cart-remove="' + Utils.esc(p.id) + '" aria-label="Убрать из корзины">' + Utils.iconX(12) + '</button>';
    }
    return '<button class="btn btn-primary btn-sm" data-cart-add="' + Utils.esc(p.id) + '">🛒 В корзину</button>';
  }

  function rowHtml(p) {
    var st = statusInfo(p);
    var img = p.thumb || p.image || 'assets/images/products/placeholder.svg';
    var stockInSelectedStore = '';
    if (state.selectedStoreId && state.selectedStoreId !== 'all') {
      var storeStock = StoreStock.text(state.selectedStoreId, p.id);
      if (storeStock !== undefined && String(storeStock).trim() !== '') {
        stockInSelectedStore = '<div class="eta-line" style="color:var(--green-dark); font-weight:700; margin-top:2px;">📍 В выбранном СЦ: ' + Utils.esc(storeStock) + '</div>';
      }
    }

    // Глобальный остаток показываем только когда СЦ не выбран — при выбранном филиале
    // единственный показатель — наличие именно в нём (два числа вводят в заблуждение)
    var qtyHtml = '';
    if (!(state.selectedStoreId && state.selectedStoreId !== 'all')) {
      // Сумма живых остатков по всем СЦ из /api/stock; при недоступности данных — статичное число
      var totalQty = StoreStock.totalCount ? StoreStock.totalCount(p.id) : null;
      var qtyNum = totalQty !== null ? totalQty : p.quantity;
      if (typeof qtyNum === 'number' && qtyNum > 0) {
        qtyHtml = '<div class="eta-line qty-line' + (p.status === 'low' ? ' qty-line-low' : '') + '">📦 Доступно: <b>' + qtyNum + ' шт.</b></div>';
      }
    }

    // Скидочные цены: оверрайды СЦ/глобальные уже учтены в effectivePrices
    var prices = effectivePrices(p);
    var disc = prices.discount != null && prices.discount > 0 && prices.discount < prices.price && p.showDiscount !== false;
    var priceHtml;
    if (disc) {
      priceHtml = '<span class="price-old">' + Utils.fmtPrice(prices.price) + '</span>' +
        '<span class="price-partner" style="color:var(--green-dark); font-weight:800;">' + Utils.fmtPrice(prices.discount) + '</span>' +
        '<span class="badge-sale">−' + Math.round((1 - prices.discount / prices.price) * 100) + '%</span>';
    } else {
      priceHtml = '<span class="price-old">' + Utils.fmtPrice(prices.price) + '</span>' +
        '<span class="price-partner">' + Utils.fmtPrice(partnerPrice(p)) + '</span>' +
        '<span class="badge-sale">-50%</span>';
    }

    return '' +
      '<article class="product-row" data-product-id="' + Utils.esc(p.id) + '">' +
      '<div class="row-media" data-open-detail="' + Utils.esc(p.id) + '">' +
      priorityBadge(p) +
      '<img src="' + Utils.esc(img) + '" alt="' + Utils.esc(p.name) + '" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
      '</div>' +
      '<div class="row-body">' +
      '<span class="row-cat">' + Utils.esc(p.category) + '</span>' +
      '<h3 class="row-title" style="cursor:pointer;" data-open-detail="' + Utils.esc(p.id) + '">' + Utils.esc(p.name) + '</h3>' +
      '<div class="row-meta">' +
      '<span class="badge ' + st.meta.cls + '">' + st.meta.icon + ' ' + st.meta.label + '</span>' +
      (moveSkuMap[p.id] ? '<span class="badge st-exp">🚚 В пути · ' + Utils.fmtDate(moveSkuMap[p.id].eta + 'T00:00:00', { day: 'numeric', month: 'short' }) + '</span>' : '') +
      '<span class="row-sku">Артикул: ' + Utils.esc(p.sku) + '</span>' +
      '</div>' +
      qtyHtml +
      stockInSelectedStore +
      st.extra +
      '</div>' +
      '<div class="row-prices">' +
      '<div class="card-prices">' +
      priceHtml +
      '</div>' +
      '<a class="partner-link" href="podpiska.html">Как стать партнёром →</a>' +
      '</div>' +
      '<div class="row-actions">' +
      rowCartControl(p) +
      '<button class="btn btn-outline btn-sm" data-open-detail="' + Utils.esc(p.id) + '">🔍 Подробнее</button>' +
      '</div>' +
      '</article>';
  }

  function partnerPrice(p) {
    var v = p.partner_price;
    if (typeof v !== 'number' || isNaN(v)) v = Math.round(p.price / 2);
    return v;
  }

  function selectedStore() {
    if (state.selectedStoreId && state.selectedStoreId !== 'all') {
      return stores.find(function (s) { return s.id === state.selectedStoreId; }) || null;
    }
    return null;
  }

  // ---------------- Секция Сервис-Центров: города + поиск + сетка карточек ----------------

  function uniqueCities() {
    var seen = {};
    var list = [];
    stores.forEach(function (s) {
      var key = s.cityKey || s.city || 'Другое';
      if (!seen[key]) {
        seen[key] = true;
        list.push({ key: key, label: s.city || key, count: 0 });
      }
    });
    stores.forEach(function (s) {
      var key = s.cityKey || s.city || 'Другое';
      var c = list.find(function (x) { return x.key === key; });
      if (c) c.count++;
    });
    list.sort(function (a, b) { return a.label.localeCompare(b.label, 'ru'); });
    return list;
  }

  function renderCityChips() {
    var el = document.getElementById('scCityChips');
    if (!el) return;
    var cities = uniqueCities();
    var total = stores.length;
    var html = '<button class="chip' + (state.cityFilter === 'all' ? ' active' : '') + '" data-city="all">Все города <span class="cnt">' + total + '</span></button>' +
      cities.map(function (c) {
        return '<button class="chip' + (state.cityFilter === c.key ? ' active' : '') + '" data-city="' + Utils.esc(c.key) + '">' + Utils.esc(c.label) + ' <span class="cnt">' + c.count + '</span></button>';
      }).join('');
    el.innerHTML = html;
  }

  function filteredStores() {
    var q = (state.storeQuery || '').trim().toLowerCase();
    return stores.filter(function (s) {
      var okCity = state.cityFilter === 'all' || (s.cityKey || s.city || '') === state.cityFilter;
      var okQ = !q ||
        s.name.toLowerCase().indexOf(q) !== -1 ||
        s.address.toLowerCase().indexOf(q) !== -1 ||
        (s.city || '').toLowerCase().indexOf(q) !== -1;
      return okCity && okQ;
    });
  }

  function renderStoresGrid() {
    var el = document.getElementById('scGrid');
    if (!el) return;
    var list = filteredStores();

    if (!list.length) {
      el.innerHTML = '<div class="empty">В этом городе пока нет филиалов — выберите другой город или напишите нам в WhatsApp.</div>';
      return;
    }

    el.innerHTML = list.map(function (s) {
      var isActive = state.selectedStoreId === s.id;
      return '<article class="sc-card' + (isActive ? ' active' : '') + '" data-select-store="' + Utils.esc(s.id) + '">' +
        '<div class="sc-card-media">' +
        '<img src="' + Utils.esc(s.image) + '" alt="' + Utils.esc(s.name) + '" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
        (isActive ? '<span class="sc-card-check">✓ Выбран</span>' : '') +
        '</div>' +
        '<div class="sc-card-body">' +
        '<h3 class="sc-card-title">' + Utils.esc(s.name) + '</h3>' +
        '<div class="sc-card-line">📍 ' + Utils.esc(s.address) + '</div>' +
        '<div class="sc-card-line">🕒 ' + Utils.esc(s.hours) + '</div>' +
        '<div class="sc-card-line">📞 ' + Utils.esc(s.phone) + '</div>' +
        (isActive ? '<div class="sc-card-hint">Нажмите ещё раз, чтобы снять выбор</div>' : '') +
        '</div>' +
        '</article>';
    }).join('');
  }

  function renderStoresSection() {
    if (!document.getElementById('scGrid')) return;
    renderCityChips();
    renderStoresGrid();
  }

  function renderActiveStoreBanner() {
    if (!scActiveBannerContainer) return;
    var store = selectedStore();
    if (!store) {
      scActiveBannerContainer.innerHTML = '';
      return;
    }

    var hasDataHere = StoreStock.hasData(store.id);
    var inStockHere = hasDataHere ? products.filter(function (p) {
      return !p.hidden && !scHidden(p) && StoreStock.available(p, store.id);
    }).length : 0;

    var filtered = !state.showAllCatalog;

    scActiveBannerContainer.innerHTML = '' +
      '<div class="sc-active-banner">' +
      '<div class="sc-banner-info">' +
      '<img class="sc-banner-img" src="' + Utils.esc(store.image) + '" alt="' + Utils.esc(store.name) + '" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
      '<div class="sc-banner-text">' +
      '<h3>🏬 ' + Utils.esc(store.name) + '</h3>' +
      '<p>' + Utils.esc(store.description || '') + '</p>' +
      (hasDataHere ? '' : '<p style="color:var(--muted);">🕓 В этом филиале каталог пока не подключён — товары появятся автоматически после регистрации филиала.</p>') +
      '<div class="sc-banner-meta">' +
      '<span>📍 ' + Utils.esc(store.address) + '</span>' +
      '<span>🕒 ' + Utils.esc(store.hours) + '</span>' +
      '<span>📞 ' + Utils.esc(store.phone) + '</span>' +
      (hasDataHere && inStockHere ? '<span>📦 Позиций в наличии: ' + inStockHere + '</span>' : '') +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="sc-banner-actions">' +
      (filtered && hasDataHere && inStockHere > 0
        ? '<button class="btn btn-primary btn-sm" data-catalog-all="1">📦 Сейчас показаны только товары в наличии здесь — Показать все</button>'
        : '') +
      '<a class="btn btn-whatsapp btn-sm" href="https://wa.me/' + store.whatsapp + '?text=' + encodeURIComponent('Здравствуйте! Интересует наличие в филиале ' + store.name) + '" target="_blank" rel="noopener">📱 Написать в СЦ</a>' +
      '<button class="btn btn-light-outline btn-sm" data-select-store="all">❌ Сбросить выбор СЦ</button>' +
      '</div>' +
      '</div>';
  }

  // ---------------- Контакты следуют за выбранным СЦ ----------------

  function renderContacts() {
    var contactsEl = document.getElementById('contactsInfo');
    if (!contactsEl) return;
    var sel = selectedStore();
    var s = sel || Utils.getStore();
    if (!s) return;

    var hoursTxt = Array.isArray(s.hours)
      ? s.hours.map(function (h) { return h.days + ' ' + h.time; }).join('<br>')
      : (s.hours || '');
    var title = sel ? 'Филиал: ' + s.name : 'Сервис-Центр';

    contactsEl.innerHTML =
      '<div class="row"><span class="lbl">Филиал</span><span><strong>' + Utils.esc(title) + '</strong></span></div>' +
      '<div class="row"><span class="lbl">Адрес</span><span>' + Utils.esc(s.address || '') + '</span></div>' +
      '<div class="row"><span class="lbl">Часы</span><span>' + hoursTxt + '</span></div>' +
      '<div class="row"><span class="lbl">Телефон</span><span>' + Utils.esc(s.phone || '') + '</span></div>';

    var phoneLink = document.getElementById('phoneLink');
    if (phoneLink) {
      phoneLink.href = 'tel:' + (s.phoneRaw || s.phone || '');
      phoneLink.textContent = 'Позвонить: ' + (s.phone || '');
    }

    var waContacts = document.getElementById('waContacts');
    if (waContacts && s.whatsapp) {
      waContacts.href = 'https://wa.me/' + s.whatsapp + '?text=' + encodeURIComponent('Здравствуйте! Интересует продукция Greenleaf.');
    }

    var map = document.getElementById('map');
    if (map) {
      map.src = 'https://static.maps.2gis.com/1.0?center=71.394568,51.126181&zoom=17&size=1200,600';
    }
    var mapLink = document.getElementById('mapLink');
    if (mapLink) mapLink.href = 'https://go.2gis.com/eKKpH';
  }

  window.CatalogRefreshContacts = renderContacts;
  window.CatalogSelectedStore = selectedStore;

  // ---------------- Товар: модалка, резерв ----------------

  // ---------------- Товар: модалка, корзина ----------------

  function openProductDetailModal(p) {
    var st = statusInfo(p);
    var prices = effectivePrices(p);
    var disc = prices.discount != null && prices.discount > 0 && prices.discount < prices.price && p.showDiscount !== false;
    var priceHtml;
    if (disc) {
      priceHtml = '<span class="price-old">' + Utils.fmtPrice(prices.price) + '</span>' +
        '<span class="price-partner" style="color:var(--green-dark); font-weight:800;">' + Utils.fmtPrice(prices.discount) + '</span>' +
        '<span class="badge-sale">−' + Math.round((1 - prices.discount / prices.price) * 100) + '%</span>';
    } else {
      priceHtml = '<span class="price-old">' + Utils.fmtPrice(prices.price) + '</span>' +
        '<span class="price-partner">' + Utils.fmtPrice(partnerPrice(p)) + '</span>' +
        '<span class="badge-sale">-50%</span>';
    }
    var qtyLine = '';
    var sel = selectedStore();
    if (sel && StoreStock.hasData(sel.id)) {
      var selTxt = StoreStock.text(sel.id, p.id);
      if (selTxt !== undefined && String(selTxt).trim() !== '') {
        qtyLine = '<div class="product-stock-item" style="font-weight:700;">📦 Доступно в ' + Utils.esc(sel.name) + ': <b>' + Utils.esc(selTxt) + '</b></div>';
      }
    }
    var stockRows = '';
    var storeStockLines = [];
    stores.forEach(function (s) {
      var txt = StoreStock.text(s.id, p.id);
      if (txt === undefined || String(txt).trim() === '') return;
      storeStockLines.push('<div class="product-stock-item"><span>📍 <strong>' + Utils.esc(s.name) + ':</strong></span> <span>' + Utils.esc(txt) + '</span></div>');
    });
    if (storeStockLines.length) {
      stockRows = storeStockLines.join('');
    } else if (sel) {
      stockRows = '<div class="product-stock-item"><span>📍 <strong>' + Utils.esc(sel.name) + ':</strong></span> <span>Каталог пока не подключён — товары появятся после подключения филиала</span></div>';
    } else {
      stockRows = '<div class="product-stock-item"><span>📍 Наличие:</span> <span>В наличии — данные обновляются автоматически</span></div>';
    }
    Utils.openModal(
      '<div class="modal-product-detail">' +
      '<div style="display:flex; justify-content:space-between; align-items:flex-start;">' +
      '<div>' +
      '<span class="card-cat">' + Utils.esc(p.category) + '</span>' +
      '<h3 style="margin-top:2px;">' + Utils.esc(p.name) + '</h3>' +
      '<span class="product-detail-sku">Артикул: ' + Utils.esc(p.sku) + '</span>' +
      '</div>' +
      '</div>' +
      '<div class="product-detail-grid">' +
      '<div class="product-detail-media">' +
      '<img src="' + Utils.esc(p.image || 'assets/images/products/placeholder.svg') + '" alt="' + Utils.esc(p.name) + '" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
      '</div>' +
      '<div class="product-detail-body">' +
      '<div class="card-prices" style="margin-top:6px;">' +
      priceHtml +
      '</div>' +
      '<a class="partner-link" href="podpiska.html">Партнёрская цена для подписчиков · Как стать партнёром →</a>' +
      '<div class="product-detail-desc">' + Utils.esc(p.description || 'Высококачественная экологичная продукция Greenleaf.') + '</div>' +
      qtyLine +
      '<h4 style="margin-top:8px; font-size:14.5px; color:var(--green-darker);">Наличие в Сервис-Центрах:</h4>' +
      '<div class="product-stock-list">' + stockRows + '</div>' +
      '<div style="display:flex; gap:10px; margin-top:14px; flex-wrap:wrap;">' +
      '<button class="btn btn-primary" style="flex:1;" data-cart-add="' + Utils.esc(p.id) + '">🛒 Добавить в корзину</button>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>',
      true
    );
  }

  function render() {
    var list = products.filter(function (p) {
      if (p.hidden) return false;
      var okCat = state.category === 'all' || p.category === state.category;
      var effSt = effectiveStatus(p);
      var okStock = !state.stockOnly || effSt === 'in_stock' || effSt === 'low';
      var q = state.query.trim().toLowerCase();
      var okQ = !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      var okStore = true;
      if (state.selectedStoreId && state.selectedStoreId !== 'all') {
        // Скрытые суперадмином товары в этом СЦ не показываем вовсе
        if (scHidden(p)) return false;
        // Филиал без данных каталога — в нём нет товаров; с данными — фильтр остатков
        okStore = StoreStock.hasData(state.selectedStoreId)
          ? (state.showAllCatalog || StoreStock.available(p, state.selectedStoreId))
          : false;
      }
      return okCat && okStock && okQ && okStore;
    });
    list.sort(function (a, b) {
      var ha = priorityRank(a) || 9;
      var hb = priorityRank(b) || 9;
      return (ha - hb) || (ORDER[effectiveStatus(a)] - ORDER[effectiveStatus(b)]) || (a.name.localeCompare(b.name, 'ru'));
    });
    if (!isCatalogPage && list.length > MAIN_PAGE_LIMIT) {
      list = list.slice(0, MAIN_PAGE_LIMIT);
    }
    grid.innerHTML = list.map(rowHtml).join('');
    var allLink = document.getElementById('catalogAllLink');
    if (allLink) {
      allLink.classList.toggle('hidden', list.length < MAIN_PAGE_LIMIT);
    }
    var emptyEl = document.getElementById('empty');
    if (emptyEl) {
      emptyEl.classList.toggle('hidden', list.length > 0);
      var noData = state.selectedStoreId && state.selectedStoreId !== 'all' && !StoreStock.hasData(state.selectedStoreId);
      emptyEl.innerHTML = noData
        ? 'В этом сервис-центре товары пока не подключены.<br>Напишите нам в WhatsApp — поможем оформить заказ в ближайшем филиале.'
        : 'Ничего не найдено.<br>Оставьте заявку — сообщим, когда товар появится.';
    }
  }

  function renderChips() {
    var scId = (state.selectedStoreId && state.selectedStoreId !== 'all') ? state.selectedStoreId : null;
    var scMode = !!scId && !state.showAllCatalog;
    function countFor(cat) {
      if (!scMode) {
        if (cat === 'all') return products.length;
        var c = null;
        for (var i = 0; i < categories.length; i++) {
          if (categories[i].name === cat) { c = categories[i]; break; }
        }
        return c ? c.count : 0;
      }
      var n = 0;
      products.forEach(function (p) {
        if (cat !== 'all' && p.category !== cat) return;
        if (scHidden(p)) return;
        if (StoreStock.hasData(scId) && StoreStock.available(p, scId)) n++;
      });
      return n;
    }
    var html = [chipHtml({ name: 'all', label: 'Все', count: countFor('all') })];
    categories.forEach(function (c) {
      html.push(chipHtml({ name: c.name, label: c.label, count: countFor(c.name) }));
    });
    chips.innerHTML = html.join('');
  }

  function chipHtml(c) {
    var active = state.category === c.name;
    return '<button class="chip' + (active ? ' active' : '') + '" data-cat="' + Utils.esc(c.name) + '">' +
      Utils.esc(c.label) + ' <span class="cnt">' + c.count + '</span></button>';
  }

  document.addEventListener('click', function (e) {
    var cartAdd = e.target.closest('[data-cart-add]');
    if (cartAdd) {
      e.stopPropagation();
      var addId = cartAdd.getAttribute('data-cart-add');
      var addMax = (state.selectedStoreId && state.selectedStoreId !== 'all') ? StoreStock.count(state.selectedStoreId, addId) : null;
      var addItem = Cart.get().find(function (i) { return i.id === addId; });
      var addCur = addItem ? (Number(addItem.qty) || 0) : 0;
      if (addMax !== null && addCur >= addMax) {
        Utils.showToast('⚠️ В филиале доступно только ' + addMax + ' шт.');
        return;
      }
      Cart.add(addId, 1);
      Utils.showToast('🛒 Добавлено в корзину');
      var modalBtn = cartAdd.closest('.modal') ? cartAdd : null;
      if (modalBtn) {
        modalBtn.innerHTML = '✅ В корзине';
        modalBtn.disabled = true;
      }
      return;
    }

    var cartInc = e.target.closest('[data-cart-inc]');
    if (cartInc) {
      e.stopPropagation();
      var incId = cartInc.getAttribute('data-cart-inc');
      var incMax = (state.selectedStoreId && state.selectedStoreId !== 'all') ? StoreStock.count(state.selectedStoreId, incId) : null;
      var incItem = Cart.get().find(function (i) { return i.id === incId; });
      var incCur = incItem ? (Number(incItem.qty) || 1) : 1;
      if (incMax !== null && incCur >= incMax) {
        Utils.showToast('⚠️ В филиале доступно только ' + incMax + ' шт.');
        return;
      }
      Cart.add(incId, 1);
      return;
    }

    var cartDec = e.target.closest('[data-cart-dec]');
    if (cartDec) {
      e.stopPropagation();
      var dId = cartDec.getAttribute('data-cart-dec');
      var dItem = Cart.get().find(function (i) { return i.id === dId; });
      if (dItem) {
        if ((Number(dItem.qty) || 1) <= 1) Cart.remove(dId);
        else Cart.setQty(dId, (Number(dItem.qty) || 1) - 1);
      }
      return;
    }

    var cartRemove = e.target.closest('[data-cart-remove]');
    if (cartRemove) {
      e.stopPropagation();
      Cart.remove(cartRemove.getAttribute('data-cart-remove'));
      return;
    }

    var openDetailEl = e.target.closest('[data-open-detail]');
    if (openDetailEl) {
      var pId = openDetailEl.getAttribute('data-open-detail');
      var p = products.find(function (x) { return x.id === pId && !x.hidden; });
      if (p) openProductDetailModal(p);
      return;
    }

    var delOpenEl = e.target.closest('[data-del-open]');
    if (delOpenEl) {
      var delP = products.find(function (x) { return x.id === delOpenEl.getAttribute('data-del-open') && !x.hidden; });
      if (delP) openProductDetailModal(delP);
      return;
    }

    var delCard = e.target.closest('[data-delivery-detail]');
    if (delCard) {
      var di = Number(delCard.getAttribute('data-delivery-detail'));
      if (!isNaN(di) && lastRenderedDeliveries && lastRenderedDeliveries[di]) {
        deliveryDetailModal(lastRenderedDeliveries[di]);
        return;
      }
    }

    var storeChip = e.target.closest('[data-select-store]');
    if (storeChip) {
      var storeId = storeChip.getAttribute('data-select-store');
      state.selectedStoreId = (state.selectedStoreId === storeId && storeId !== 'all') ? 'all' : storeId;
      state.showAllCatalog = false;
      try {
        var selStore = stores.find(function (s) { return s.id === state.selectedStoreId; }) || null;
        if (selStore) {
          localStorage.setItem('greenleaf_sc_selected_v1', JSON.stringify({ id: selStore.id, name: selStore.name, address: selStore.address || '' }));
        } else {
          localStorage.removeItem('greenleaf_sc_selected_v1');
        }
      } catch (err) { }
      syncStockToggle();
      renderStoresSection();
      renderActiveStoreBanner();
      renderContacts();
      render();
      renderChips();
      renderDeliveries(lastDeliveries);
      return;
    }

    var catalogAllBtn = e.target.closest('[data-catalog-all]');
    if (catalogAllBtn) {
      state.showAllCatalog = true;
      syncStockToggle();
      renderActiveStoreBanner();
      render();
      renderChips();
      return;
    }

    var cityChip = e.target.closest('[data-city]');
    if (cityChip) {
      state.cityFilter = cityChip.getAttribute('data-city');
      try { localStorage.setItem('greenleaf_city_v1', state.cityFilter); } catch (err) { }
      Utils.closeModal();
      renderCityChips();
      renderStoresGrid();
      return;
    }
  });

  // Ручной ввод количества — клампинг по остатку выбранного СЦ
  document.addEventListener('change', function (e) {
    var inp = e.target.closest('[data-cart-qty]');
    if (!inp) return;
    var id = inp.getAttribute('data-cart-qty');
    var qty = parseInt(inp.value, 10);
    if (isNaN(qty) || qty < 1) return;
    if (state.selectedStoreId && state.selectedStoreId !== 'all') {
      var max = StoreStock.count(state.selectedStoreId, id);
      if (max !== null && qty > max) {
        Utils.showToast('⚠️ В филиале доступно только ' + max + ' шт. — количество уменьшено');
        Cart.setQty(id, max);
      }
    }
  });

  var scSearch = document.getElementById('scSearch');
  if (scSearch) {
    scSearch.addEventListener('input', function () {
      state.storeQuery = scSearch.value;
      renderStoresGrid();
    });
  }

  chips.addEventListener('click', function (e) {
    var chip = e.target.closest('[data-cat]');
    if (!chip) return;
    state.category = chip.getAttribute('data-cat');
    renderChips();
    render();
    saveFilters();
  });

  search.addEventListener('input', function () {
    state.query = search.value;
    render();
    saveFilters();
  });

  function syncStockToggle() {
    if (stockOnly) stockOnly.checked = !state.showAllCatalog;
  }

  stockOnly.addEventListener('change', function () {
    state.stockOnly = stockOnly.checked;
    state.showAllCatalog = !stockOnly.checked;
    render();
    renderChips();
    saveFilters();
  });

  function saveFilters() {
    try {
      localStorage.setItem(FILTERS_KEY, JSON.stringify({ q: state.query, cat: state.category, stock: state.stockOnly }));
    } catch (e) { }
  }

  function restoreFilters() {
    try {
      var saved = JSON.parse(localStorage.getItem(FILTERS_KEY) || 'null');
      if (saved) {
        state.query = saved.q || '';
        state.category = saved.cat || 'all';
        state.stockOnly = !!saved.stock;
        state.showAllCatalog = !state.stockOnly;
        if (search) search.value = state.query;
        if (stockOnly) stockOnly.checked = state.stockOnly;
      } else {
        // Галочка «Только в наличии» автовыбрана по умолчанию
        state.stockOnly = true;
        state.showAllCatalog = false;
        if (stockOnly) stockOnly.checked = true;
      }
    } catch (e) { }
  }

  Cart.onChange(function () {
    Cart.updateBadge();
    grid.querySelectorAll('.product-row').forEach(function (row) {
      var id = row.getAttribute('data-product-id');
      var p = products.find(function (x) { return x.id === id; });
      if (!p) return;
      var actions = row.querySelector('.row-actions');
      if (actions) {
        actions.innerHTML = rowCartControl(p) +
          '<button class="btn btn-outline btn-sm" data-open-detail="' + Utils.esc(p.id) + '">🔍 Подробнее</button>';
      }
    });
  });

  // ---------------- Поставки (общие + по филиалам) ----------------

  var lastDeliveries = [];
  var lastRenderedDeliveries = [];
  var moveSkuMap = {};

  // Действующие поставщики: «Астана поставщик "новый"», «Астана поставщик», «Алматы поставщик».
  // Накладные с любым другим источником — это брак, на сайте не учитываются.
  var VALID_MOVE_SOURCE_RE = /(Астана поставщик|Алматы поставщик)/i;

  function applyDeliveriesOverrides(list) {
    var result = list;
    try {
      var saved = localStorage.getItem('greenleaf_admin_deliveries_v1');
      if (saved) {
        var arr = JSON.parse(saved);
        if (Array.isArray(arr)) result = arr;
      }
    } catch (e) { }
    try {
      var perStore = JSON.parse(localStorage.getItem('greenleaf_sc_deliveries_v1') || '{}');
      Object.keys(perStore).forEach(function (storeId) {
        var arr = perStore[storeId];
        if (!Array.isArray(arr)) return;
        result = result.filter(function (d) { return d.storeId !== storeId; });
        arr.forEach(function (d) { result.push(d); });
      });
    } catch (e) { }
    return result;
  }

  function transitDays(source) {
    return /Алматы/i.test(String(source || '')) ? 2 : 1;
  }

  // Диапазон прибытия для «Оформлена · на складе»: минимум — только путь (Астана 1 / Алматы 2 дня),
  // максимум — ещё до 3 дней товар может лежать на складе поставщика
  function moveEtaRange(d) {
    var min = new Date();
    min.setDate(min.getDate() + transitDays(d.source));
    var max = new Date(min);
    max.setDate(max.getDate() + 3);
    return { min: min, max: max };
  }

  function moveEta(d) {
    var start;
    if (d.statusCode === 0) {
      start = new Date();
    } else {
      start = new Date(d.date + 'T00:00:00');
      if (isNaN(start.getTime())) start = new Date();
    }
    start.setDate(start.getDate() + transitDays(d.source));
    return start;
  }

  // Позиция фуры на дороге: Новый — у склада (0%), дальше — по времени в пути
  function moveProgress(d) {
    if (d.statusCode === 0) return 0;
    if (d.statusCode === 7) return 1;
    var start = new Date(d.date + 'T00:00:00').getTime();
    if (isNaN(start)) return 0.5;
    var elapsed = (Date.now() - start) / 86400000;
    var days = transitDays(d.source);
    return Math.max(0.06, Math.min(0.97, elapsed / days));
  }

  function moveStatusLabel(d) {
    if (d.statusCode === 0) return { text: '🏭 На складе поставщика', cls: 'mv-warehouse', arrived: false };
    if (d.statusCode === 4) return { text: '🚚 В пути', cls: 'mv-transit', arrived: false };
    if (d.statusCode === 7) return { text: '✅ Прибыла', cls: 'mv-arrived', arrived: true };
    return { text: 'Готовится к отправке', cls: 'mv-prep', arrived: false };
  }

  function moveEtaText(d) {
    if (d.statusCode === 7) return '<div class="move-eta">✅ Прибыла — товары уже на складе СЦ</div>';
    if (d.statusCode === 0) {
      var r = moveEtaRange(d);
      var mMin = Utils.fmtDate(r.min, { day: 'numeric', month: 'short' });
      var mMax = Utils.fmtDate(r.max, { day: 'numeric', month: 'short' });
      return '<div class="move-eta">📅 Прибудет ≈ ' + mMin + ' – ' + mMax + '</div>';
    }
    var eta = moveEta(d);
    var etaStr = eta.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
    return '<div class="move-eta">📅 Прибудет ≈ ' + etaStr + '</div>';
  }

  // Визуал «фуры» по стадии: на складе → в пути → прибыла
  function moveRoadHtml(d, pct) {
    if (d.statusCode === 0) {
      return '<div class="move-stage">🏭 📦📦📦 → 🚚</div>';
    }
    if (d.statusCode === 7) {
      return '<div class="move-stage move-stage-arrived">🚚 → 🏢 Наш ЦС</div>';
    }
    return '<div class="move-road">' +
      '<span class="move-point move-point-start">' + Utils.esc(String(d.source || '').replace(/поставщик.*/i, '').replace(/["']/g, '').trim() || 'Склад') + '</span>' +
      '<div class="move-track">' +
      '<div class="move-progress" style="width:' + pct + '%"></div>' +
      '<span class="move-truck" style="left:clamp(10px,' + pct + '%,calc(100% - 10px))">' + Utils.iconTruck(22) + '</span>' +
      '</div>' +
      '<span class="move-point move-point-end">Наш СЦ</span>' +
      '</div>';
  }

  function moveCardHtml(d, di) {
    var dt = new Date(d.date + 'T00:00:00');
    var dNum = dt.toLocaleDateString('ru-RU', { day: 'numeric' });
    var mStr = dt.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
    var st = moveStatusLabel(d);
    var pct = Math.round(moveProgress(d) * 100);
    var itemsHtml = '';
    if (d.items && d.items.length) {
      var names = d.items.map(function (it) {
        // Товар ищется строго по артикулу (sku — это ID товара). Если артикула нет в базе —
        // плейсхолдер + наименование из накладной, без подстановки «похожих» товаров.
        var p = products.find(function (x) { return x.id === it.sku; });
        var label = it.name || (p && p.name) || it.sku || '';
        return Utils.deliveryItemHtml(products, label, it.qty > 1 ? it.qty : '', p || null);
      });
      var shown = names.slice(0, 5);
      var more = names.length - shown.length;
      itemsHtml = '<div class="delivery-items">Прибудет: ' + shown.join('') +
        (more > 0 ? '<span class="delivery-more" title="Открыть состав накладной">+' + more + '</span>' : '') +
        '</div>';
    } else if (d.itemsParsed === false) {
      itemsHtml = '<div class="delivery-items">Состав накладной уточняется</div>';
    }
    return '<div class="delivery move-card" data-delivery-detail="' + di + '" style="cursor:pointer;">' +
      '<div class="delivery-date"><span class="d">' + dNum + '</span><span class="m">' + mStr + '</span></div>' +
      '<div class="delivery-main">' +
      '<div class="move-top">' +
      '<span class="move-status ' + st.cls + '">' + st.text + '</span>' +
      '<span class="move-num">№' + Utils.esc(d.number || '') + '</span>' +
      '</div>' +
      moveRoadHtml(d, pct) +
      moveEtaText(d) +
      itemsHtml +
      '</div>' +
      '</div>';
  }

  function renderDeliveries(deliveries) {
    var el = document.getElementById('deliveriesList');
    if (!el) return;
    lastDeliveries = deliveries;

    var list = deliveries;
    var isMoves = list.some(function (d) { return d.statusCode !== undefined; });
    var scopeNote = '';
    var sel = selectedStore();

    if (!isMoves && sel) {
      list = deliveries.filter(function (d) { return !d.storeId || d.storeId === sel.id; });
      scopeNote = '<div class="deliveries-scope">Поставки филиала: <strong>' + Utils.esc(sel.name) + '</strong> <button class="btn btn-outline btn-sm" data-select-store="all">Показать все</button></div>';
    }

    if (isMoves) {
      var cutoff = Date.now() - 21 * 86400000;
      list = list.filter(function (d) {
        if (!VALID_MOVE_SOURCE_RE.test(d.source || '')) return false;
        var code = d.statusCode;
        if (code === 9 || code === -1) return false; // отменённые не показываем
        if (code === 7) {
          // Прибывшие показываем только первые сутки после прибытия
          if (!d.time) return false;
          var tArr = new Date(d.time.replace(' ', 'T')).getTime();
          return !isNaN(tArr) && Date.now() - tArr < 86400000;
        }
        if (!d.time) return true;
        var t = new Date(d.time.replace(' ', 'T')).getTime();
        return !isNaN(t) && t >= cutoff;
      });
    } else {
      // Прошедшие поставки не показываем («Прибудет 10-го» при сегодняшнем 11-м — убираем)
      var todayS = todayDateStr();
      list = list.filter(function (d) { return String(d.date || '') >= todayS; });
    }

    lastRenderedDeliveries = list;

    if (!list.length) {
      el.innerHTML = scopeNote + '<div class="delivery"><span class="delivery-note">' +
        (isMoves
          ? 'Нет накладных в пути. Свежие поставки появятся здесь автоматически.'
          : (sel ? 'У этого филиала пока нет запланированных поставок.' : 'Нет данных о поставках — уточните в WhatsApp.')) +
        '</span></div>';
      return;
    }

    el.innerHTML = scopeNote + list.map(function (d, di) {
      if (isMoves) return moveCardHtml(d, di);
      var dt = new Date(d.date + 'T00:00:00');
      var dNum = dt.toLocaleDateString('ru-RU', { day: 'numeric' });
      var mStr = dt.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
      var storeTag = '';
      if (d.storeId) {
        var s = stores.find(function (x) { return x.id === d.storeId; });
        if (s) storeTag = '<span class="delivery-store">' + Utils.esc(s.name) + '</span>';
      } else if (sel) {
        storeTag = '<span class="delivery-store">Общая поставка</span>';
      }
      var itemsHtml = d.items
        ? '<div class="delivery-items">Прибудет: ' + d.items.split(/[;,]/).map(function (i) {
          var t = String(i).trim();
          return t ? Utils.deliveryItemHtml(products, t, '') : '';
        }).join('') + '</div>'
        : '';
      return '<div class="delivery" data-delivery-detail="' + di + '" style="cursor:pointer;">' +
        '<div class="delivery-date"><span class="d">' + dNum + '</span><span class="m">' + mStr + '</span></div>' +
        '<div class="delivery-main">' +
        storeTag +
        '<span class="delivery-note">' + Utils.esc(d.note || '') + '</span>' +
        itemsHtml +
        '</div>' +
        '</div>';
    }).join('');
  }

  // Модалка состава поставки: картинки + наименования каждой позиции
  function deliveryDetailModal(d) {
    var lines = [];
    var raw = d.items;
    if (Array.isArray(raw)) {
      raw.forEach(function (it) {
        var label = it && (it.name || it.sku || '');
        if (label) lines.push({ label: String(label).trim(), qty: it.qty ? ' × ' + it.qty : '', sku: it && it.sku });
      });
    } else if (typeof raw === 'string') {
      String(raw).split(/[;,]/).forEach(function (t) {
        var s = String(t).trim();
        if (s) lines.push({ label: s, qty: '' });
      });
    }
    var storeName = '';
    if (d.storeId) {
      var st = stores.find(function (x) { return x.id === d.storeId; });
      if (st) storeName = st.name;
    }
    var rows = lines.map(function (l) {
      // Накладные: товар строго по артикулу (sku — ID товара), без угадывания по названию
      var p = null;
      if (l.sku) p = products.find(function (x) { return x.id === l.sku; }) || null;
      if (!p) p = Utils.productByArticle(products, l.label);
      var img = p ? (p.thumb || p.image || 'assets/images/products/placeholder.svg') : 'assets/images/products/placeholder.svg';
      return '<div class="delivery-detail-item">' +
        '<img class="delivery-item-img" src="' + Utils.esc(img) + '" alt="' + Utils.esc(l.label) + '" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
        '<span class="delivery-detail-name">' + Utils.esc(l.label) + '</span>' +
        (l.qty ? '<span class="muted-sku">' + Utils.esc(l.qty) + '</span>' : '') +
        '</div>';
    }).join('');
    var dt = d.date ? Utils.fmtDate(String(d.date) + 'T00:00:00', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
    Utils.openModal(
      '<h3>🚚 Поставка' + (dt ? ' · ' + dt : '') + '</h3>' +
      (storeName ? '<p class="modal-product"><b>' + Utils.esc(storeName) + '</b></p>' : '') +
      (d.note ? '<p>' + Utils.esc(d.note) + '</p>' : '') +
      (rows ? '<div class="delivery-detail-list">' + rows + '</div>' : '<p class="modal-product">Состав накладной уточняется</p>')
    );
  }

  function buildMoveSkuMap(moves) {    moveSkuMap = {};
    moves.forEach(function (mv) {
      if (!VALID_MOVE_SOURCE_RE.test(mv.source || '')) return;
      var code = mv.statusCode;
      if (code === 0 || code === 7 || code === 9 || code === -1) return;
      if (!mv.items) return;
      var eta = moveEta(mv).toISOString().slice(0, 10);
      mv.items.forEach(function (it) {
        if (it.sku && !moveSkuMap[it.sku]) {
          moveSkuMap[it.sku] = { eta: eta, number: mv.number };
        }
      });
    });
  }

  // ---------------- Мероприятия (с бейджем филиала) ----------------

  function applyEventsOverrides(list) {
    var result = list;
    try {
      var saved = localStorage.getItem('greenleaf_admin_events_v1');
      if (saved) {
        var arr = JSON.parse(saved);
        if (Array.isArray(arr)) result = arr;
      }
    } catch (e) { }
    try {
      var perStore = JSON.parse(localStorage.getItem('greenleaf_sc_events_v1') || '{}');
      Object.keys(perStore).forEach(function (storeId) {
        var arr = perStore[storeId];
        if (!Array.isArray(arr)) return;
        result = result.filter(function (ev) { return ev.storeId !== storeId; });
        arr.forEach(function (ev) { result.push(ev); });
      });
    } catch (e) { }
    return result;
  }

  var lastEvents = [];

  function todayDateStr() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function eventBookings() {
    try { return window.__eventBookings || {}; } catch (e) { return {}; }
  }

  function refreshEventBookings() {
fetch('/api/event-bookings')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        window.__eventBookings = (d && d.bookings) || {};
        renderEvents(lastEvents);
      })
      .catch(function () { });
  }

  function eventMyBooked(id) {
    try {
      var mine = JSON.parse(localStorage.getItem('greenleaf_event_my_v1') || '{}');
      return !!mine[String(id)];
    } catch (e) { return false; }
  }

  function eventRemaining(ev) {
    if (ev.slots == null) return null;
    var booked = Number(eventBookings()[String(ev.id)]) || 0;
    return Math.max(0, ev.slots - booked);
  }

  function eventWhenLabel(dateStr) {
    var today = todayDateStr();
    if (dateStr === today) return { label: 'Сегодня', cls: 'today' };
    var t = new Date(today + 'T00:00:00');
    var d = new Date(dateStr + 'T00:00:00');
    if (isNaN(t.getTime()) || isNaN(d.getTime())) return null;
    var diff = Math.round((d.getTime() - t.getTime()) / 86400000);
    if (diff === 1) return { label: 'Завтра', cls: 'tomorrow' };
    return null;
  }

  function renderEvents(events) {
    var el = document.getElementById('eventsList');
    if (!el) return;
    lastEvents = events || [];

    var today = todayDateStr();
    var list = lastEvents.filter(function (ev) { return String(ev.date || '') >= today; });
    list.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });

    if (!list.length) {
      el.innerHTML = '<p class="section-sub">Новых мероприятий пока нет — скоро анонсируем.</p>';
      return;
    }
    el.innerHTML = list.map(function (ev) {
      var when = eventWhenLabel(String(ev.date));
      var dt = Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long' });
      var whenBadge = when
        ? '<span class="event-when event-when-' + when.cls + '">' + when.label + '</span>'
        : '';
      var storeTag = '';
      if (ev.storeId) {
        var s = stores.find(function (x) { return x.id === ev.storeId; });
        if (s) storeTag = '<span class="event-store-badge">' + Utils.esc(s.name) + '</span>';
      }
      var remaining = eventRemaining(ev);
      var slotsTxt = 'Мест: ' + Utils.esc(ev.slots != null ? ev.slots : '—');
      if (remaining !== null) slotsTxt += ' · Осталось: ' + remaining;
      var full = remaining !== null && remaining <= 0;
      var myBooked = eventMyBooked(ev.id);
      var btnHtml = myBooked
        ? '<button class="btn btn-outline" disabled>✅ Вы записаны</button>'
        : full
          ? '<button class="btn btn-outline" disabled>Мест нет</button>'
          : '<button class="btn btn-primary" data-event="' + Utils.esc(ev.id) + '">Записаться</button>';
      return '<article class="event' + (when ? ' event-when-card-' + when.cls : '') + '">' +
        '<div class="event-top"><div class="event-date">' + whenBadge + dt + ' · ' + Utils.esc(ev.time || '') + '</div>' + storeTag + '</div>' +
        '<h3>' + Utils.esc(ev.title) + '</h3>' +
        '<div class="event-meta"><span>📍 ' + Utils.esc(ev.place || '') + '</span></div>' +
        '<p class="event-desc">' + Utils.esc(ev.description || '') + '</p>' +
        '<span class="event-slots">' + slotsTxt + '</span>' +
        btnHtml +
        '</article>';
    }).join('');
  }

  window.addEventListener('event:booked', function () { refreshEventBookings(); });

  function eventModal(ev) {
    if (eventMyBooked(ev.id)) {
      Utils.showToast('Вы уже записаны на это мероприятие');
      return;
    }
    if (eventRemaining(ev) === 0) {
      Utils.showToast('К сожалению, места закончились');
      return;
    }
    Utils.openModal(
      '<h3>Запись на мероприятие</h3>' +
      '<p class="modal-product"><b>' + Utils.esc(ev.title) + '</b></p>' +
      '<p class="modal-price">' + Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long' }) + ' · ' + Utils.esc(ev.time || '') + '</p>' +
      '<form class="form" data-type="event">' +
      '<input type="hidden" name="event" value="' + Utils.esc(ev.title + ' · ' + ev.date) + '">' +
      '<input type="hidden" name="event_id" value="' + Utils.esc(ev.id) + '">' +
      '<input name="name" placeholder="Ваше имя" required>' +
      '<input name="phone" placeholder="Телефон" required>' +
      '<input class="hp" name="company" tabindex="-1" autocomplete="off">' +
      '<button class="btn btn-primary" type="submit">Записаться</button>' +
      '<p class="form-note">Подтвердим запись в ближайшее время.</p>' +
      '<p class="form-success">Запись отправлена! Подтвердим участие.</p>' +
      '<p class="form-error">Что-то пошло не так. Попробуйте ещё раз или напишите нам в WhatsApp.</p>' +
      '</form>'
    );
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-event]');
    if (!btn) return;
    fetch('/api/events')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var ev = applyEventsOverrides((d && d.events) || []).find(function (x) { return String(x.id) === btn.getAttribute('data-event'); });
        if (ev) eventModal(ev);
      })
      .catch(function () {
        fetch('data/events.json')
          .then(function (r) { return r.json(); })
          .then(function (data) {
            var ev = applyEventsOverrides(data.events || []).find(function (x) { return String(x.id) === btn.getAttribute('data-event'); });
            if (ev) eventModal(ev);
          });
      });
  });

  // ---------------- Оверрайды и инициализация ----------------

  function applyLocalOverrides() {
    var CUSTOM_STORES_KEY = 'greenleaf_sc_custom_stores_v1';
    var CUSTOM_PRODUCTS_KEY = 'greenleaf_sc_custom_products_v1';
    var ADMIN_PRODUCTS_KEY = 'greenleaf_admin_products_v2';

    try {
      var savedStores = JSON.parse(localStorage.getItem(CUSTOM_STORES_KEY) || '{}');
      Object.keys(savedStores).forEach(function (scId) {
        var override = savedStores[scId];
        var idx = stores.findIndex(function (s) { return s.id === scId; });
        if (idx >= 0) {
          stores[idx] = Object.assign({}, stores[idx], override);
        } else {
          stores.push(Object.assign({}, override, { id: scId }));
        }
      });
    } catch (e) { console.warn('applyLocalOverrides stores error', e); }

    try {
      var savedProds = JSON.parse(localStorage.getItem(CUSTOM_PRODUCTS_KEY) || '{}');
      void savedProds;
    } catch (e) { console.warn('applyLocalOverrides products error', e); }

    try {
      var knownCats = {};
      products.forEach(function (p) { knownCats[p.category] = true; });
      var adminProds = JSON.parse(localStorage.getItem(ADMIN_PRODUCTS_KEY) || '{}');
      products.forEach(function (p) {
        var o = adminProds[p.id];
        if (!o) return;
        ['price', 'status', 'eta', 'incoming', 'description', 'category'].forEach(function (f) {
          if (o[f] === undefined || o[f] === '') return;
          if (f === 'category' && !knownCats[o[f]]) return;
          p[f] = o[f];
        });
      });
      } catch (e) { console.warn('applyLocalOverrides admin products error', e); }
  }

  function plural(n, forms) {
    var n10 = n % 10;
    var n100 = n % 100;
    if (n10 === 1 && n100 !== 11) return forms[0];
    if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return forms[1];
    return forms[2];
  }

  function updateHeroMeta() {
    var metaEl = document.getElementById('heroStoresMeta');
    if (metaEl) {
      metaEl.textContent = '🏬 ' + stores.length + ' ' + plural(stores.length, ['филиал', 'филиала', 'филиалов']);
    }
    var citiesEl = document.getElementById('heroCities');
    if (citiesEl) {
      var cities = uniqueCities();
      citiesEl.innerHTML = cities.map(function (c) {
        var label = String(c.label || '').replace(/^г\.\s*/i, '');
        return '<span>' + Utils.esc(label) + ' · ' + c.count + '</span>';
      }).join('');
    }
  }

  function maybeAskCity() {
    try {
      if (localStorage.getItem('greenleaf_city_v1')) return;
    } catch (e) { return; }
    var cities = uniqueCities();
    if (!cities.length) return;
    Utils.openModal(
      '<h3>🌆 Выберите ваш город</h3>' +
      '<p class="modal-product">Покажем Сервис-Центры и наличие рядом с вами. Город можно поменять в любой момент на странице.</p>' +
      '<div class="city-pick-grid">' +
      cities.map(function (c) {
        return '<button class="chip city-pick-chip" data-city="' + Utils.esc(c.key) + '">' + Utils.esc(c.label) + ' <span class="cnt">' + c.count + '</span></button>';
      }).join('') +
      '<button class="chip city-pick-chip" data-city="all">Все города</button>' +
      '</div>'
    );
  }

  async function init() {
    try {
      var storesRes = await fetch('data/stores.json');
      stores = await storesRes.json();
    } catch (e) {
      console.warn('Could not load stores.json', e);
    }

    // Сервис-Центры из KV (зарегистрированные суперадмином) — приоритетнее статичного списка
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
    } catch (e) {
      console.warn('Could not load /api/stores', e);
    }

    await StoreStock.load();

    try {
      var res = await fetch('data/products.json');
      var data = await res.json();
      products = data.products || [];

      // Серверные оверрайды из Worker (отдаются вместе с каталогом):
      // глобальные правки уже применены к товарам, raw-карта и правки по СЦ — ниже
      if (data.overrides) productOverrides = data.overrides || {};
      if (data.scOverrides) scOverrides = data.scOverrides || {};
      siteSettings = Object.assign({ showDiscountPrices: true, categories: [] }, data.settings || {});
      if (typeof data.showDiscountPrices === 'boolean') siteSettings.showDiscountPrices = data.showDiscountPrices;
      window.__productOverrides = productOverrides;
      window.__scOverrides = scOverrides;
      window.__siteSettings = siteSettings;

      // Единый счётчик броней мест на мероприятия (Worker KV)
      try {
        var ebRes = await fetch('/api/event-bookings');
        var ebData = await ebRes.json();
        window.__eventBookings = (ebData && ebData.bookings) || {};
      } catch (e) {
        window.__eventBookings = {};
      }

      var byCat = {};
      products.forEach(function (p) {
        if (p.hidden) return;
        byCat[p.category] = (byCat[p.category] || 0) + 1;
      });
      categories = Object.keys(byCat).map(function (k) { return { name: k, label: k, count: byCat[k] }; });
      // Порядок категорий: сначала заданный суперадмином, затем остальные по алфавиту
      var catOrder = (siteSettings.categories || []).filter(function (c) { return byCat[c]; });
      var extra = Object.keys(byCat).filter(function (c) { return catOrder.indexOf(c) === -1; }).sort(function (a, b) { return a.localeCompare(b, 'ru'); });
      categories = catOrder.concat(extra).map(function (k) { return { name: k, label: k, count: byCat[k] }; });

      var updatedEl = document.getElementById('catalogUpdated');
      if (updatedEl) {
        updatedEl.textContent = 'Обновлено: ' +
          Utils.fmtDate(data.updated, { day: 'numeric', month: 'long' }) + ' ' +
          new Date(data.updated).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
      }

      var inStock = products.filter(function (p) { return !p.hidden && (p.status === 'in_stock' || p.status === 'low'); }).length;
      var heroStockEl = document.getElementById('heroStock');
      if (heroStockEl) {
        heroStockEl.textContent = 'В наличии: ' + inStock + ' ' + plural(inStock, ['позиция', 'позиции', 'позиций']);
      }

      var countEl = document.getElementById('catalogCount');
      if (countEl) {
        countEl.textContent = products.length + ' ' + plural(products.length, ['позиция', 'позиции', 'позиций']);
      }
    } catch (err) {
      grid.innerHTML = '<div class="empty">Каталог временно недоступен. Напишите нам в WhatsApp — подскажем наличие.</div>';
    }

    applyLocalOverrides();
    updateHeroMeta();
    restoreFilters();

    try {
      var savedCity = localStorage.getItem('greenleaf_city_v1');
      if (savedCity) state.cityFilter = savedCity;
    } catch (e) { }

    try {
      var savedSc = localStorage.getItem('greenleaf_sc_selected_v1');
      if (savedSc) {
        var scObj = JSON.parse(savedSc);
        if (scObj && scObj.id) state.selectedStoreId = scObj.id;
      }
    } catch (e) { }

    window.CatalogStores = stores;
    window.CatalogProducts = products;

    renderStoresSection();
    renderChips();
    render();
    renderContacts();
    if (!isCatalogPage) maybeAskCity();

    fetch('data/moves.json')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var moves = d.moves || [];
        if (!moves.length) throw new Error('moves empty');
        buildMoveSkuMap(moves);
        renderDeliveries(moves);
        render();
      })
      .catch(function () {
        fetch('data/deliveries.json')
          .then(function (r) { return r.json(); })
          .then(function (d) { renderDeliveries(applyDeliveriesOverrides(d.deliveries || [])); })
          .catch(function () { renderDeliveries(applyDeliveriesOverrides([])); });
      });

    fetch('/api/events')
      .then(function (r) { return r.json(); })
      .then(function (d) { renderEvents(applyEventsOverrides((d && d.events) || [])); })
      .catch(function () {
        fetch('data/events.json')
          .then(function (r) { return r.json(); })
          .then(function (d) { renderEvents(applyEventsOverrides(d.events || [])); })
          .catch(function () { renderEvents(applyEventsOverrides([])); });
      });
  }

  window.CatalogReload = function () {
    applyLocalOverrides();
    window.CatalogStores = stores;
    window.CatalogProducts = products;
    renderStoresSection();
    renderActiveStoreBanner();
    renderContacts();
    render();
  };

  init();
})();
