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
  var categories = [];
  var state = { category: 'all', query: '' };

  var grid = document.getElementById('grid');
  var chips = document.getElementById('chips');
  var search = document.getElementById('search');

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

  function cardHtml(p) {
    var st = statusInfo(p);
    var img = p.image || 'assets/images/products/placeholder.svg';
    return '' +
      '<article class="card">' +
      '<div class="card-media"><img src="' + Utils.esc(img) + '" alt="' + Utils.esc(p.name) + '" loading="lazy" onerror="this.src=\'assets/images/products/placeholder.svg\'"></div>' +
      '<div class="card-body">' +
      '<span class="card-cat">' + Utils.esc(p.category) + '</span>' +
      '<h3 class="card-title">' + Utils.esc(p.name) + '</h3>' +
      '<span class="card-sku">Артикул: ' + Utils.esc(p.sku) + '</span>' +
      '<div class="card-price">' + Utils.fmtPrice(p.price) + '</div>' +
      '<div><span class="badge ' + st.meta.cls + '">' + st.meta.icon + ' ' + st.meta.label + '</span></div>' +
      st.extra +
      '<div class="card-footer">' +
      '<button class="btn btn-primary" data-reserve="' + Utils.esc(p.id) + '">Забронировать</button>' +
      '</div>' +
      '</div>' +
      '</article>';
  }

  function render() {
    var list = products.filter(function (p) {
      var okCat = state.category === 'all' || p.category === state.category;
      var q = state.query.trim().toLowerCase();
      var okQ = !q || p.name.toLowerCase().indexOf(q) !== -1 || p.sku.toLowerCase().indexOf(q) !== -1;
      return okCat && okQ;
    });
    list.sort(function (a, b) {
      return (ORDER[a.status] - ORDER[b.status]) || (a.name.localeCompare(b.name, 'ru'));
    });
    grid.innerHTML = list.map(cardHtml).join('');
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

  function reserveModal(p) {
    var st = statusInfo(p);
    var info = '';
    if (p.status === 'in_stock') {
      info = '<span class="badge st-in">✅ В наличии — можно забрать сегодня</span>';
    } else if (p.status === 'low') {
      info = '<span class="badge st-low">⚠️ Заканчивается — бронируйте, пока есть</span>';
    } else {
      info = '<span class="badge st-exp">📦 Забронируем под заказ — привезём ' + Utils.fmtDate(p.eta, { day: 'numeric', month: 'long' }) + '</span>';
    }
    Utils.openModal(
      '<h3>Бронирование</h3>' +
      '<p class="modal-product"><b>' + Utils.esc(p.name) + '</b></p>' +
      '<p class="modal-price">' + Utils.fmtPrice(p.price) + ' · ' + Utils.esc(p.sku) + '</p>' +
      '<div style="margin-top:10px">' + info + '</div>' +
      '<form class="form" data-type="reservation">' +
      '<input type="hidden" name="product" value="' + Utils.esc(p.name) + ' (' + Utils.esc(p.sku) + ')">' +
      '<input type="hidden" name="productStatus" value="' + Utils.esc(p.status) + '">' +
      '<label for="qty">Количество</label>' +
      '<input type="number" id="qty" name="quantity" min="1" max="99" value="1" required>' +
      '<input name="name" placeholder="Ваше имя" required>' +
      '<input name="phone" placeholder="Телефон" required>' +
      '<input class="hp" name="company" tabindex="-1" autocomplete="off">' +
      '<textarea name="comment" placeholder="Комментарий (необязательно)"></textarea>' +
      '<button class="btn btn-primary" type="submit">Забронировать</button>' +
      '<p class="form-note">Заявка уйдёт нам в WhatsApp/Telegram — подтвердим бронь и подготовим товар к приезду.</p>' +
      '<p class="form-success">Заявка отправлена! Подтвердим бронь в ближайшее время.</p>' +
      '<p class="form-error">Что-то пошло не так. Попробуйте ещё раз или напишите нам в WhatsApp.</p>' +
      '</form>'
    );
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-reserve]');
    if (!btn) return;
    var p = products.find(function (x) { return x.id === btn.getAttribute('data-reserve'); });
    if (p) reserveModal(p);
  });

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

  function renderDeliveries(deliveries) {
    var el = document.getElementById('deliveriesList');
    if (!deliveries || !deliveries.length) {
      el.innerHTML = '<div class="delivery"><span class="delivery-note">Нет данных о поставках — уточните в WhatsApp.</span></div>';
      return;
    }
    el.innerHTML = deliveries.map(function (d) {
      var dt = new Date(d.date + 'T00:00:00');
      var dNum = dt.toLocaleDateString('ru-RU', { day: 'numeric' });
      var mStr = dt.toLocaleDateString('ru-RU', { month: 'short' }).replace('.', '');
      return '<div class="delivery">' +
        '<div class="delivery-date"><span class="d">' + dNum + '</span><span class="m">' + mStr + '</span></div>' +
        '<span class="delivery-note">' + Utils.esc(d.note || '') + '</span>' +
        '</div>';
    }).join('');
  }

  function renderEvents(events) {
    var el = document.getElementById('eventsList');
    if (!events || !events.length) {
      el.innerHTML = '<p class="section-sub">Новых мероприятий пока нет — скоро анонсируем.</p>';
      return;
    }
    el.innerHTML = events.map(function (ev) {
      var dt = Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long' });
      return '<article class="event">' +
        '<div class="event-date">' + dt + ' · ' + Utils.esc(ev.time) + '</div>' +
        '<h3>' + Utils.esc(ev.title) + '</h3>' +
        '<div class="event-meta"><span>📍 ' + Utils.esc(ev.place) + '</span></div>' +
        '<p class="event-desc">' + Utils.esc(ev.description) + '</p>' +
        '<span class="event-slots">Мест: ' + (ev.slots || '—') + '</span>' +
        '<button class="btn btn-primary" data-event="' + Utils.esc(ev.id) + '">Записаться</button>' +
        '</article>';
    }).join('');
  }

  function eventModal(ev) {
    Utils.openModal(
      '<h3>Запись на мероприятие</h3>' +
      '<p class="modal-product"><b>' + Utils.esc(ev.title) + '</b></p>' +
      '<p class="modal-price">' + Utils.fmtDate(ev.date + 'T00:00:00', { day: 'numeric', month: 'long' }) + ' · ' + Utils.esc(ev.time) + '</p>' +
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
    var ev = null;
    fetch('data/events.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (data) {
        ev = (data.events || []).find(function (x) { return String(x.id) === btn.getAttribute('data-event'); });
        if (ev) eventModal(ev);
      });
  });

  async function init() {
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
      document.getElementById('heroStock').textContent = 'Сейчас в наличии: ' + inStock + ' позиций';

      renderChips();
      render();
    } catch (err) {
      grid.innerHTML = '<div class="empty">Каталог временно недоступен. Напишите нам в WhatsApp — подскажем наличие.</div>';
    }

    fetch('data/deliveries.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) { renderDeliveries(d.deliveries || []); })
      .catch(function () { renderDeliveries([]); });

    fetch('data/events.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) { renderEvents(d.events || []); })
      .catch(function () { renderEvents([]); });
  }

  init();
})();
