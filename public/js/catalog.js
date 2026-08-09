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
  var state = { category: 'all', query: '', stockOnly: false, selectedStoreId: 'all', cityFilter: 'all', storeQuery: '', showAllCatalog: false };

  var grid = document.getElementById('grid');
  var chips = document.getElementById('chips');
  var search = document.getElementById('search');
  var stockOnly = document.getElementById('stockOnly');
  var scActiveBannerContainer = document.getElementById('scActiveBannerContainer');

  function statusInfo(p) {
    var meta = STATUS[p.status] || STATUS.out;
    var extra = '';
    if (p.status === 'low') {
      extra = '<p class="eta-line">📦 ' + (p.incoming ? 'Завоз: <b>' + Utils.fmtDate(p.incoming, { day: 'numeric', month: 'short' }) + '</b>' : 'Возьмём в работу — напишите нам') + '</p>';
    } else if (p.status === 'expected') {
      extra = '<p class="eta-line">Поставка: <b>' + Utils.fmtDate(p.eta, { day: 'numeric', month: 'long' }) + '</b></p>';
    } else if (p.status === 'out') {
      extra = '<p class="eta-line">Следующая поставка: <b>' + Utils.fmtDate(p.eta, { day: 'numeric', month: 'long' }) + '</b></p>';
    } else if (p.incoming) {
      extra = '<p class="eta-line">Завоз в пути: <b>' + Utils.fmtDate(p.incoming, { day: 'numeric', month: 'short' }) + '</b></p>';
    }
    return { meta: meta, extra: extra };
  }

  function rowCartControl(p) {
    var item = Cart.get().find(function (i) { return i.id === p.id; });
    if (item) {
      return '<div class="qty-stepper" data-cart-row="' + Utils.esc(p.id) + '">' +
        '<button class="qty-btn" data-cart-dec="' + Utils.esc(p.id) + '" aria-label="Уменьшить">−</button>' +
        '<span class="qty-val">' + (Number(item.qty) || 1) + '</span>' +
        '<button class="qty-btn" data-cart-inc="' + Utils.esc(p.id) + '" aria-label="Увеличить">+</button>' +
        '</div>' +
        '<button class="btn btn-light-outline btn-sm row-remove" data-cart-remove="' + Utils.esc(p.id) + '" aria-label="Убрать из корзины">✕</button>';
    }
    return '<button class="btn btn-primary btn-sm" data-cart-add="' + Utils.esc(p.id) + '">🛒 В корзину</button>';
  }

  function rowHtml(p) {
    var st = statusInfo(p);
    var img = p.image || 'assets/images/products/placeholder.svg';
    var stockInSelectedStore = '';
    if (state.selectedStoreId && state.selectedStoreId !== 'all' && p.stockByStore) {
      var storeStock = p.stockByStore[state.selectedStoreId] || 'Нет данных';
      stockInSelectedStore = '<div class="eta-line" style="color:var(--green-dark); font-weight:700; margin-top:2px;">📍 В выбранном СЦ: ' + Utils.esc(storeStock) + '</div>';
    }

    return '' +
      '<article class="product-row" data-product-id="' + Utils.esc(p.id) + '">' +
      '<div class="row-media" data-open-detail="' + Utils.esc(p.id) + '">' +
      '<img src="' + Utils.esc(img) + '" alt="' + Utils.esc(p.name) + '" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
      '</div>' +
      '<div class="row-body">' +
      '<span class="row-cat">' + Utils.esc(p.category) + '</span>' +
      '<h3 class="row-title" style="cursor:pointer;" data-open-detail="' + Utils.esc(p.id) + '">' + Utils.esc(p.name) + '</h3>' +
      '<div class="row-meta">' +
      '<span class="badge ' + st.meta.cls + '">' + st.meta.icon + ' ' + st.meta.label + '</span>' +
      '<span class="row-sku">Артикул: ' + Utils.esc(p.sku) + '</span>' +
      '</div>' +
      stockInSelectedStore +
      st.extra +
      '</div>' +
      '<div class="row-prices">' +
      '<div class="card-prices">' +
      '<span class="price-old">' + Utils.fmtPrice(p.price) + '</span>' +
      '<span class="price-partner">' + Utils.fmtPrice(partnerPrice(p)) + '</span>' +
      '<span class="badge-sale">-50%</span>' +
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

    var inStockHere = products.filter(function (p) {
      return p.stockByStore && p.stockByStore[store.id] && p.stockByStore[store.id].indexOf('Нет') === -1;
    }).length;

    var filtered = !state.showAllCatalog;

    scActiveBannerContainer.innerHTML = '' +
      '<div class="sc-active-banner">' +
      '<div class="sc-banner-info">' +
      '<img class="sc-banner-img" src="' + Utils.esc(store.image) + '" alt="' + Utils.esc(store.name) + '" onerror="this.src=\'assets/images/products/placeholder.svg\'">' +
      '<div class="sc-banner-text">' +
      '<h3>🏬 ' + Utils.esc(store.name) + '</h3>' +
      '<p>' + Utils.esc(store.description || '') + '</p>' +
      '<div class="sc-banner-meta">' +
      '<span>📍 ' + Utils.esc(store.address) + '</span>' +
      '<span>🕒 ' + Utils.esc(store.hours) + '</span>' +
      '<span>📞 ' + Utils.esc(store.phone) + '</span>' +
      (inStockHere ? '<span>📦 Позиций в наличии: ' + inStockHere + '</span>' : '') +
      '</div>' +
      '</div>' +
      '</div>' +
      '<div class="sc-banner-actions">' +
      (filtered
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
    var title = sel ? 'Филиал: ' + s.name : 'Головной офис';

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
      map.src = 'https://yandex.ru/map-widget/v1/?text=' + encodeURIComponent(s.address || '');
    }
  }

  window.CatalogRefreshContacts = renderContacts;
  window.CatalogSelectedStore = selectedStore;

  // ---------------- Товар: модалка, резерв ----------------

  function openProductDetailModal(p) {
    var stockRows = '';
    if (p.stockByStore) {
      stockRows = Object.keys(p.stockByStore).map(function (sId) {
        var s = stores.find(function (x) { return x.id === sId; });
        var storeName = s ? s.name : sId;
        return '<div class="product-stock-item"><span>📍 <strong>' + Utils.esc(storeName) + ':</strong></span> <span>' + Utils.esc(p.stockByStore[sId]) + '</span></div>';
      }).join('');
    } else {
      stockRows = '<div class="product-stock-item">В наличии на центральном складе</div>';
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
      '<span class="price-old">' + Utils.fmtPrice(p.price) + '</span>' +
      '<span class="price-partner">' + Utils.fmtPrice(partnerPrice(p)) + '</span>' +
      '<span class="badge-sale">-50%</span>' +
      '</div>' +
      '<a class="partner-link" href="podpiska.html">Партнёрская цена для подписчиков · Как стать партнёром →</a>' +
      '<div class="product-detail-desc">' + Utils.esc(p.description || 'Высококачественная экологичная продукция Greenleaf.') + '</div>' +
      '<h4 style="margin-top:8px; font-size:14.5px; color:var(--green-darker);">Наличие в Сервис-Центрах:</h4>' +
      '<div class="product-stock-list">' + stockRows + '</div>' +
      '<div style="display:flex; gap:10px; margin-top:14px; flex-wrap:wrap;">' +
      '<button class="btn btn-primary" style="flex:1;" data-reserve="' + Utils.esc(p.id) + '">🛒 Забронировать к приезду</button>' +
      '<a class="btn btn-whatsapp" style="flex:1;" href="' + Utils.waLink('Здравствуйте! Интересует позиция: ' + p.name + ' (' + p.sku + ')') + '" target="_blank" rel="noopener">📱 Задать вопрос в WhatsApp</a>' +
      '</div>' +
      '</div>' +
      '</div>' +
      '</div>',
      true
    );
  }

  function render() {
    var list = products.filter(function (p) {
      var okCat = state.category === 'all' || p.category === state.category;
      var okStock = !state.stockOnly || p.status === 'in_stock' || p.status === 'low';
      var q = state.query.trim().toLowerCase();
      var okQ = !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      var okStore = true;
      if (state.selectedStoreId && state.selectedStoreId !== 'all' && !state.showAllCatalog) {
        var stk = p.stockByStore && p.stockByStore[state.selectedStoreId];
        okStore = !!(stk && stk.indexOf('Нет') !== 0 && stk.indexOf('Ожидается') === -1);
      }
      return okCat && okStock && okQ && okStore;
    });
    list.sort(function (a, b) {
      return (ORDER[a.status] - ORDER[b.status]) || (a.name.localeCompare(b.name, 'ru'));
    });
    grid.innerHTML = list.map(rowHtml).join('');
    document.getElementById('empty').classList.toggle('hidden', list.length > 0);
  }

  function renderChips() {
    var all = { name: 'all', label: 'Все', count: products.length };
    var html = [chipHtml(all)];
    categories.forEach(function (c) {
      html.push(chipHtml(c));
    });
    chips.innerHTML = html.join('');
  }

  function chipHtml(c) {
    var active = state.category === c.name;
    return '<button class="chip' + (active ? ' active' : '') + '" data-cat="' + Utils.esc(c.name) + '">' +
      Utils.esc(c.label) + ' <span class="cnt">' + c.count + '</span></button>';
  }

  function availableStoresFor(p) {
    if (!p.stockByStore) return [];
    return Object.keys(p.stockByStore).map(function (sId) {
      var s = stores.find(function (x) { return x.id === sId; });
      if (!s) return null;
      var stockTxt = p.stockByStore[sId] || '';
      var low = stockTxt.indexOf('Нет') === 0 || stockTxt.indexOf('Ожидается') !== -1;
      return { id: s.id, name: s.name, stock: stockTxt, available: !low };
    }).filter(function (x) { return x && x.available; });
  }

  function storeOf(a) {
    return stores.find(function (x) { return x.id === a.id; }) || null;
  }

  function storeRadioHtml(a, checked) {
    return '<label class="reserve-store-opt' + (checked ? ' checked' : '') + '">' +
      '<input type="radio" name="store" value="' + Utils.esc(a.name) + '"' + (checked ? ' checked' : '') + '>' +
      '<span class="reserve-store-name">' + Utils.esc(a.name) + '</span>' +
      '<span class="badge st-in">' + Utils.esc(a.stock) + '</span>' +
      '</label>';
  }

  function reserveStoreField(avail, sel) {
    if (avail.length === 1) {
      return '<input type="hidden" name="store" value="' + Utils.esc(avail[0].name) + '">' +
        '<div class="reserve-store-single">🏬 Товар есть в: <strong>' + Utils.esc(avail[0].name) + '</strong> <span class="badge st-in">' + Utils.esc(avail[0].stock) + '</span></div>';
    }
    var city = state.cityFilter;
    var inCity = city === 'all' ? [] : avail.filter(function (a) {
      var s = storeOf(a);
      return s && s.cityKey === city;
    });
    var others = avail.filter(function (a) {
      var s = storeOf(a);
      return !(s && s.cityKey === city);
    });
    var defaultId = sel && avail.some(function (a) { return a.id === sel.id; })
      ? sel.id
      : (inCity.length ? inCity[0].id : avail[0].id);

    function groupHtml(title, list) {
      if (!list.length) return '';
      return '<div class="reserve-store-group">' +
        (title ? '<div class="reserve-store-group-title">' + title + '</div>' : '') +
        list.map(function (a) { return storeRadioHtml(a, a.id === defaultId); }).join('') +
        '</div>';
    }
    return '<div class="form-group"><label>Филиал, где заберёте товар *</label>' +
      '<div class="reserve-store-list">' +
      groupHtml(city === 'all' ? '' : '🏙 В вашем городе', inCity) +
      groupHtml(city === 'all' ? '' : 'Другие города', others) +
      '</div></div>';
  }

  function reserveModal(p) {
    var sel = selectedStore();
    var avail = availableStoresFor(p);
    var st = statusInfo(p);

    Utils.openModal(
      '<h3>Бронирование продукции</h3>' +
      '<p class="modal-product"><b>' + Utils.esc(p.name) + '</b></p>' +
      '<p class="modal-price">Розничная цена: <b>' + Utils.fmtPrice(p.price) + '</b> · ' + Utils.esc(p.sku) + '</p>' +
      '<p class="modal-partner-note">Для партнёров по подписке: <b>' + Utils.fmtPrice(partnerPrice(p)) + '</b> <a href="podpiska.html">Как стать партнёром →</a></p>' +
      '<div style="margin-top:10px"><span class="badge ' + st.meta.cls + '">' + st.meta.icon + ' ' + st.meta.label + '</span></div>' +
      '<form class="form" data-type="reservation">' +
      '<input type="hidden" name="product" value="' + Utils.esc(p.name) + ' (' + Utils.esc(p.sku) + ')">' +
      (avail.length === 0
        ? '<div class="reserve-nostock">В выбранных филиалах товара пока нет. Напишите нам в WhatsApp — подскажем, где забрать или закажем к вашей поездке.</div>' +
          '<a class="btn btn-whatsapp" href="' + Utils.waLink('Здравствуйте! Хочу узнать, где есть в наличии: ' + p.name + ' (' + p.sku + ')') + '" target="_blank" rel="noopener">📱 Написать в WhatsApp</a>'
        : reserveStoreField(avail, sel) +
          '<label for="qty">Количество</label>' +
          '<input type="number" id="qty" name="quantity" min="1" max="99" value="1" required>' +
          '<input name="name" placeholder="Ваше имя" required>' +
          '<input name="phone" placeholder="Телефон для связи" required>' +
          '<input class="hp" name="company" tabindex="-1" autocomplete="off">' +
          '<textarea name="comment" placeholder="Комментарий (необязательно)"></textarea>' +
          '<button class="btn btn-primary" type="submit">Забронировать</button>' +
          '<p class="form-note">Заявка отправится администратору выбранного филиала — подготовим заказ к вашему приезду.</p>' +
          '<p class="form-success">Заявка отправлена! Подтвердим бронь в ближайшее время.</p>' +
          '<p class="form-error">Что-то пошло не так. Попробуйте ещё раз или напишите нам в WhatsApp.</p>') +
      '</form>'
    );
  }

  document.addEventListener('click', function (e) {
    var cartAdd = e.target.closest('[data-cart-add]');
    if (cartAdd) {
      e.stopPropagation();
      Cart.add(cartAdd.getAttribute('data-cart-add'), 1);
      Utils.showToast('🛒 Добавлено в корзину');
      return;
    }

    var cartInc = e.target.closest('[data-cart-inc]');
    if (cartInc) {
      e.stopPropagation();
      Cart.add(cartInc.getAttribute('data-cart-inc'), 1);
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

    var reserveBtn = e.target.closest('[data-reserve]');
    if (reserveBtn) {
      e.stopPropagation();
      var pId = reserveBtn.getAttribute('data-reserve');
      var p = products.find(function (x) { return x.id === pId; });
      if (p) reserveModal(p);
      return;
    }

    var openDetailEl = e.target.closest('[data-open-detail]');
    if (openDetailEl) {
      var pId = openDetailEl.getAttribute('data-open-detail');
      var p = products.find(function (x) { return x.id === pId; });
      if (p) openProductDetailModal(p);
      return;
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
      renderStoresSection();
      renderActiveStoreBanner();
      renderContacts();
      render();
      renderDeliveries(lastDeliveries);
      return;
    }

    var catalogAllBtn = e.target.closest('[data-catalog-all]');
    if (catalogAllBtn) {
      state.showAllCatalog = true;
      renderActiveStoreBanner();
      render();
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
  });

  search.addEventListener('input', function () {
    state.query = search.value;
    render();
  });

  stockOnly.addEventListener('change', function () {
    state.stockOnly = stockOnly.checked;
    render();
  });

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

  function renderDeliveries(deliveries) {
    var el = document.getElementById('deliveriesList');
    if (!el) return;
    lastDeliveries = deliveries;

    var sel = selectedStore();
    var list = deliveries;
    var scopeNote = '';
    if (sel) {
      list = deliveries.filter(function (d) { return !d.storeId || d.storeId === sel.id; });
      scopeNote = '<div class="deliveries-scope">Поставки филиала: <strong>' + Utils.esc(sel.name) + '</strong> <button class="btn btn-outline btn-sm" data-select-store="all">Показать все</button></div>';
    }

    if (!list.length) {
      el.innerHTML = scopeNote + '<div class="delivery"><span class="delivery-note">' +
        (sel ? 'У этого филиала пока нет запланированных поставок.' : 'Нет данных о поставках — уточните в WhatsApp.') +
        '</span></div>';
      return;
    }

    el.innerHTML = scopeNote + list.map(function (d) {
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
        ? '<div class="delivery-items">Прибудет: ' + d.items.split(/[;,]/).map(function (i) { return '<span class="delivery-item">' + Utils.esc(i.trim()) + '</span>'; }).join('') + '</div>'
        : '';
      return '<div class="delivery">' +
        '<div class="delivery-date"><span class="d">' + dNum + '</span><span class="m">' + mStr + '</span></div>' +
        '<div class="delivery-main">' +
        storeTag +
        '<span class="delivery-note">' + Utils.esc(d.note || '') + '</span>' +
        itemsHtml +
        '</div>' +
        '</div>';
    }).join('');
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

  function renderEvents(events) {
    var el = document.getElementById('eventsList');
    if (!el) return;
    if (!events || !events.length) {
      el.innerHTML = '<p class="section-sub">Новых мероприятий пока нет — скоро анонсируем.</p>';
      return;
    }
    el.innerHTML = events.map(function (ev) {
      var dt = Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long' });
      var storeTag = '';
      if (ev.storeId) {
        var s = stores.find(function (x) { return x.id === ev.storeId; });
        if (s) storeTag = '<span class="event-store-badge">' + Utils.esc(s.name) + '</span>';
      }
      return '<article class="event">' +
        '<div class="event-top"><div class="event-date">' + dt + ' · ' + Utils.esc(ev.time || '') + '</div>' + storeTag + '</div>' +
        '<h3>' + Utils.esc(ev.title) + '</h3>' +
        '<div class="event-meta"><span>📍 ' + Utils.esc(ev.place || '') + '</span></div>' +
        '<p class="event-desc">' + Utils.esc(ev.description || '') + '</p>' +
        '<span class="event-slots">Мест: ' + Utils.esc(ev.slots != null ? ev.slots : '—') + '</span>' +
        '<button class="btn btn-primary" data-event="' + Utils.esc(ev.id) + '">Записаться</button>' +
        '</article>';
    }).join('');
  }

  function eventModal(ev) {
    Utils.openModal(
      '<h3>Запись на мероприятие</h3>' +
      '<p class="modal-product"><b>' + Utils.esc(ev.title) + '</b></p>' +
      '<p class="modal-price">' + Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long' }) + ' · ' + Utils.esc(ev.time || '') + '</p>' +
      '<form class="form" data-type="event">' +
      '<input type="hidden" name="event" value="' + Utils.esc(ev.title + ' · ' + ev.date) + '">' +
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
    fetch('data/events.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var ev = applyEventsOverrides(data.events || []).find(function (x) { return String(x.id) === btn.getAttribute('data-event'); });
        if (ev) eventModal(ev);
      });
  });

  // ---------------- Оверрайды и инициализация ----------------

  function applyLocalOverrides() {
    var CUSTOM_STORES_KEY = 'greenleaf_sc_custom_stores_v1';
    var CUSTOM_PRODUCTS_KEY = 'greenleaf_sc_custom_products_v1';
    var ADMIN_PRODUCTS_KEY = 'greenleaf_admin_products_v1';
    var TEXTS_KEY = 'greenleaf_admin_texts_v1';

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
      Object.keys(savedProds).forEach(function (scId) {
        var stockMap = savedProds[scId];
        products.forEach(function (p) {
          if (stockMap[p.id] !== undefined) {
            if (!p.stockByStore) p.stockByStore = {};
            p.stockByStore[scId] = stockMap[p.id];
          }
        });
      });
    } catch (e) { console.warn('applyLocalOverrides products error', e); }

    try {
      var adminProds = JSON.parse(localStorage.getItem(ADMIN_PRODUCTS_KEY) || '{}');
      products.forEach(function (p) {
        var o = adminProds[p.id];
        if (!o) return;
        ['price', 'status', 'eta', 'incoming', 'description', 'category'].forEach(function (f) {
          if (o[f] !== undefined && o[f] !== '') p[f] = o[f];
        });
      });
    } catch (e) { console.warn('applyLocalOverrides admin products error', e); }

    try {
      var texts = JSON.parse(localStorage.getItem(TEXTS_KEY) || '{}');
      document.querySelectorAll('[data-edit-key]').forEach(function (el) {
        var k = el.getAttribute('data-edit-key');
        if (texts[k]) el.textContent = texts[k];
      });
    } catch (e) { console.warn('applyLocalOverrides texts error', e); }
  }

  function setupTapEdit() {
    if (!window.Auth || !window.Auth.isSuperadmin()) return;
    var TEXTS_KEY = 'greenleaf_admin_texts_v1';

    function saveText(key, val) {
      try {
        var texts = JSON.parse(localStorage.getItem(TEXTS_KEY) || '{}');
        texts[key] = val;
        localStorage.setItem(TEXTS_KEY, JSON.stringify(texts));
        Utils.showToast('✓ Текст обновлён');
      } catch (e) { }
    }

    document.querySelectorAll('[data-edit-key]').forEach(function (el) {
      el.classList.add('tap-editable');
      el.addEventListener('click', function () {
        if (el.getAttribute('contenteditable') === 'true') return;
        el.setAttribute('contenteditable', 'true');
        el.classList.add('editing');
        el.focus();
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      });
      el.addEventListener('blur', function () {
        if (el.getAttribute('contenteditable') !== 'true') return;
        el.removeAttribute('contenteditable');
        el.classList.remove('editing');
        saveText(el.getAttribute('data-edit-key'), el.textContent.trim());
      });
      el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          el.blur();
        }
      });
    });
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
      var storesRes = await fetch('data/stores.json?t=' + Date.now());
      stores = await storesRes.json();
    } catch (e) {
      console.warn('Could not load stores.json', e);
    }

    try {
      var res = await fetch('data/products.json?t=' + Date.now());
      var data = await res.json();
      products = data.products || [];

      var byCat = {};
      products.forEach(function (p) {
        byCat[p.category] = (byCat[p.category] || 0) + 1;
      });
      categories = Object.keys(byCat).map(function (k) { return { name: k, label: k, count: byCat[k] }; });

      document.getElementById('catalogUpdated').textContent = 'Обновлено: ' +
        Utils.fmtDate(data.updated, { day: 'numeric', month: 'long' }) + ' ' +
        new Date(data.updated).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

      var inStock = products.filter(function (p) { return p.status === 'in_stock' || p.status === 'low'; }).length;
      document.getElementById('heroStock').textContent = 'В наличии: ' + inStock + ' ' + plural(inStock, ['позиция', 'позиции', 'позиций']);
    } catch (err) {
      grid.innerHTML = '<div class="empty">Каталог временно недоступен. Напишите нам в WhatsApp — подскажем наличие.</div>';
    }

    applyLocalOverrides();
    setupTapEdit();
    updateHeroMeta();

    try {
      var savedCity = localStorage.getItem('greenleaf_city_v1');
      if (savedCity) state.cityFilter = savedCity;
    } catch (e) { }

    window.CatalogStores = stores;
    window.CatalogProducts = products;

    renderStoresSection();
    renderChips();
    render();
    renderContacts();
    maybeAskCity();

    fetch('data/deliveries.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) { renderDeliveries(applyDeliveriesOverrides(d.deliveries || [])); })
      .catch(function () { renderDeliveries(applyDeliveriesOverrides([])); });

    fetch('data/events.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) { renderEvents(applyEventsOverrides(d.events || [])); })
      .catch(function () { renderEvents(applyEventsOverrides([])); });
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
