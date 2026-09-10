(function () {
  'use strict';

  var FAB_KEY = 'greenleaf_ai_fab_hidden_v1';
  var HIST_KEY = 'greenleaf_ai_hist_v1';
  var MAX_HIST = 10;

  var fab = document.getElementById('aiFab');
  var panel = document.getElementById('aiPanel');
  var body = document.getElementById('aiBody');
  var input = document.getElementById('aiInput');
  var sendBtn = document.getElementById('aiSend');
  var statusEl = document.getElementById('aiStatus');
  if (!fab || !panel) return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function toast(t) {
    try {
      if (window.Utils && Utils.showToast) Utils.showToast(t);
    } catch (e) { /* без тостов */ }
  }

  function imgUrl(src) {
    var v = window.SITE_VER;
    if (!src) return 'assets/images/products/placeholder.svg';
    if (src.indexOf('assets/') === 0 && v) {
      return src + (src.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(v);
    }
    return src;
  }

  function fmtPrice(n) {
    try {
      if (window.Utils && Utils.fmtPrice) return Utils.fmtPrice(n);
    } catch (e) { }
    return new Intl.NumberFormat('ru-RU').format(Number(n) || 0) + ' ₸';
  }

  function selectedStore() {
    try {
      var s = JSON.parse(localStorage.getItem('greenleaf_sc_selected_v1') || 'null');
      if (s && s.id) return { id: String(s.id), name: String(s.name || '') };
    } catch (e) { }
    return { id: '', name: '' };
  }

  function loadHist() {
    try {
      var h = JSON.parse(localStorage.getItem(HIST_KEY) || '[]');
      return Array.isArray(h) ? h.slice(-MAX_HIST) : [];
    } catch (e) { return []; }
  }

  function saveHist(h) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h.slice(-MAX_HIST))); } catch (e) { }
  }

  var hist = loadHist();

  // ---------------- Открытие / закрытие ----------------

  function isHidden() {
    try { return localStorage.getItem(FAB_KEY) === '1'; } catch (e) { return false; }
  }

  function applyFabVisibility() {
    fab.classList.toggle('hidden', isHidden());
  }

  function hideFab() {
    try { localStorage.setItem(FAB_KEY, '1'); } catch (e) { }
    closePanel();
    applyFabVisibility();
    toast('Скрыто. Вернуть: меню → «Менеджер Иса»');
  }

  function showFab() {
    try { localStorage.removeItem(FAB_KEY); } catch (e) { }
    applyFabVisibility();
  }

  var greeted = false;
  function openPanel() {
    showFab();
    panel.classList.remove('hidden');
    if (!greeted && !hist.length) {
      greeted = true;
      addBotHtml('Здравствуйте! Я Иса, помогу подобрать товары Greenleaf. Напишите, что ищете — например, «что есть для мозга» или «какие витаминки есть».');
      renderChips(['🧠 Что есть для мозга?', '💊 Какие витаминки есть?', '🧴 Что для дома?', '📍 Адрес и часы']);
    }
    setTimeout(function () {
      try { body.scrollTop = body.scrollHeight; } catch (e) { }
      try { input.focus(); } catch (e) { }
    }, 60);
  }

  function closePanel() {
    panel.classList.add('hidden');
  }

  function togglePanel() {
    if (panel.classList.contains('hidden')) openPanel();
    else closePanel();
  }

  // ---------------- Drag-to-hide ----------------
  // Тап — открыть/закрыть; перетаскивание за край экрана — скрыть кнопку.
  (function initDrag() {
    var startX = 0, startY = 0, dx = 0, dy = 0, dragging = false, moved = false;
    fab.addEventListener('pointerdown', function (e) {
      if (e.target.closest('.ai-fab-hide')) return;
      dragging = true;
      moved = false;
      startX = e.clientX;
      startY = e.clientY;
      dx = 0;
      dy = 0;
      try { fab.setPointerCapture(e.pointerId); } catch (err) { }
    });
    fab.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      dx = e.clientX - startX;
      dy = e.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 8) {
        moved = true;
        fab.classList.add('dragging');
        fab.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
      }
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      fab.classList.remove('dragging');
      fab.style.transform = '';
      if (!moved) {
        togglePanel();
        return;
      }
      // Кнопку утащили за край экрана — прячем
      var r = fab.getBoundingClientRect();
      var cx = r.left + r.width / 2 + dx;
      var cy = r.top + r.height / 2 + dy;
      var m = 24;
      if (cx < m || cy < m || cx > window.innerWidth - m || cy > window.innerHeight - m) {
        hideFab();
      }
    }
    fab.addEventListener('pointerup', endDrag);
    fab.addEventListener('pointercancel', function () {
      dragging = false;
      fab.classList.remove('dragging');
      fab.style.transform = '';
    });
  })();

  var hideBtn = fab.querySelector('.ai-fab-hide');
  if (hideBtn) hideBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    hideFab();
  });

  // Возврат через меню: любой .ai-chat-link открывает чат
  document.addEventListener('click', function (e) {
    var link = e.target.closest('.ai-chat-link');
    if (link) {
      e.preventDefault();
      openPanel();
      var burger = document.getElementById('burger');
      var nav = document.getElementById('nav');
      if (burger) burger.classList.remove('open');
      if (nav) nav.classList.remove('open');
    }
    if (e.target.closest('#aiClose')) closePanel();
    if (e.target.closest('#aiHide')) closePanel(); // «−» только сворачивает, кнопка остаётся
    var more = e.target.closest('[data-ai-more]');
    if (more) {
      var w = more.closest('.ai-prods');
      if (w) {
        more.classList.add('hidden');
        w.querySelector('.ai-prods-more').classList.remove('hidden');
        w.querySelector('[data-ai-hide-list]').classList.remove('hidden');
        scrollBottom();
      }
      return;
    }
    var hideList = e.target.closest('[data-ai-hide-list]');
    if (hideList) {
      var w2 = hideList.closest('.ai-prods');
      if (w2) {
        w2.querySelector('.ai-prods-more').classList.add('hidden');
        hideList.classList.add('hidden');
        w2.querySelector('[data-ai-more]').classList.remove('hidden');
      }
      return;
    }
    var chip = e.target.closest('[data-ai-chip]');
    if (chip) {
      openPanel();
      ask(chip.getAttribute('data-ai-chip') || '');
      return;
    }
    var ordersBtn = e.target.closest('[data-ai-orders]');
    if (ordersBtn) {
      e.preventDefault();
      try { if (window.Utils && Utils.openMyOrdersModal) Utils.openMyOrdersModal(); } catch (err) { }
      return;
    }
    // Степпер идёт раньше деталей: клик по +/− не открывает карточку
    var inc = e.target.closest('[data-ai-inc]');
    if (inc) {
      var iid = inc.getAttribute('data-ai-inc');
      if (!window.Cart || !Cart.add) { toast('Откройте каталог, чтобы добавить товар'); return; }
      if (aiQty(iid) >= aiMax(iid)) { toast('⚠️ В выбранном филиале недостаточно товара'); return; }
      try { Cart.add(iid, 1); } catch (err) { toast('Не удалось добавить в корзину'); return; }
      refreshAiSteppers();
      return;
    }
    var dec = e.target.closest('[data-ai-dec]');
    if (dec) {
      var did = dec.getAttribute('data-ai-dec');
      var dq = aiQty(did);
      if (dq <= 0) return;
      try {
        if (!window.Cart) return;
        if (dq <= 1) Cart.remove(did);
        else Cart.setQty(did, dq - 1);
      } catch (err) { }
      refreshAiSteppers();
      return;
    }
    var det = e.target.closest('[data-ai-detail]');
    if (det) {
      var pid = det.getAttribute('data-ai-detail');
      try {
        if (window.CatalogOpenDetail) window.CatalogOpenDetail(pid);
        else location.href = 'catalog.html';
      } catch (err) { location.href = 'catalog.html'; }
    }
  });

  // Enter по карточке (не по степперу) — тоже открывает подробности
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || /INPUT|TEXTAREA/.test(String(document.activeElement && document.activeElement.tagName || ''))) return;
    var card = e.target && e.target.closest ? e.target.closest('.ai-prod') : null;
    if (!card || e.target.closest('[data-ai-inc],[data-ai-dec]')) return;
    var pid2 = card.getAttribute('data-ai-detail');
    if (!pid2) return;
    try {
      if (window.CatalogOpenDetail) window.CatalogOpenDetail(pid2);
      else location.href = 'catalog.html';
    } catch (err) { location.href = 'catalog.html'; }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !panel.classList.contains('hidden')) closePanel();
  });

  // ---------------- Рендер ----------------

  function scrollBottom() {
    try { body.scrollTop = body.scrollHeight; } catch (e) { }
  }

  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'ai-msg user';
    d.textContent = text;
    body.appendChild(d);
    scrollBottom();
  }

  function addBotHtml(html) {
    var d = document.createElement('div');
    d.className = 'ai-msg bot';
    d.innerHTML = html;
    body.appendChild(d);
    scrollBottom();
    return d;
  }

  // Пузырь «печатает…» с анимированными точками (пока ждём ответ сервера)
  function addTyping() {
    var d = document.createElement('div');
    d.className = 'ai-msg bot ai-typing-msg';
    d.innerHTML = '<span class="ai-typing" aria-label="Иса печатает"><span></span><span></span><span></span></span>';
    body.appendChild(d);
    scrollBottom();
    return d;
  }

  // Подсказки-кнопки: приветствие — стандартный набор, дальше — от сервера.
  // box — пузырь ответа, под которым рисуем чипы (по умолчанию — внизу чата).
  var DEFAULT_CHIPS = ['📍 Адрес и часы', '🚚 Когда поставка?', '📋 Подписка', '🔍 Помоги подобрать'];
  function renderChips(items, box) {
    var list = (Array.isArray(items) && items.length) ? items : DEFAULT_CHIPS;
    var d = document.createElement('div');
    d.className = 'ai-chips';
    d.innerHTML = list.map(function (t) {
      return '<button class="ai-chip" type="button" data-ai-chip="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    (box || body).appendChild(d);
    scrollBottom();
    return d;
  }

  // Кнопки под сообщением (решает сервер: подписка / WhatsApp / «Мои заказы»)
  function renderActions(box, actions) {
    if (!actions || !actions.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'ai-actions';
    wrap.innerHTML = actions.map(function (a) {
      if (a.type === 'orders') {
        return '<button class="ai-act" type="button" data-ai-orders>' + esc(a.label || '📦 Мои заказы') + '</button>';
      }
      var ext = /^https?:/i.test(a.url || '');
      return '<a class="ai-act' + (a.type === 'wa' ? ' ai-act-wa' : '') + '" href="' + esc(a.url || '#') + '"' +
        (ext ? ' target="_blank" rel="noopener"' : '') + '>' + esc(a.label || 'Подробнее') + '</a>';
    }).join('');
    box.appendChild(wrap);
    scrollBottom();
  }

  // Компактный список поставок: дата, маршрут, статус. Просрочка — акцентно.
  function renderSupplies(box, supplies) {
    if (!supplies || !supplies.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'ai-supplies';
    wrap.innerHTML = supplies.map(function (s) {
      var cls = s.late ? 'late' : (s.status === 'transit' ? 'transit' : 'expected');
      var label = s.late ? '⚠️ Задерживается' : (s.status === 'transit' ? 'В пути' : 'Ожидается');
      return '<div class="ai-supply ' + cls + '">' +
        '<span class="ai-supply-date">' + esc(s.date || '') + '</span>' +
        '<span class="ai-supply-info">' + esc(s.route || '') + (s.items ? ' · ' + s.items + ' поз.' : '') + '</span>' +
        '<span class="ai-supply-status">' + label + '</span>' +
        '</div>';
    }).join('');
    box.appendChild(wrap);
    scrollBottom();
  }

  // Оценка ответа: 👍/👎 уходит на сервер (в KV для разбора), повторно не спрашиваем
  function renderFeedback(box, q, reply) {
    var d = document.createElement('div');
    d.className = 'ai-fb';
    d.innerHTML = '<span class="ai-fb-q">Ответ полезен?</span>' +
      '<button class="ai-fb-btn" type="button" data-ai-fb="up" aria-label="Полезно">👍</button>' +
      '<button class="ai-fb-btn" type="button" data-ai-fb="down" aria-label="Не полезно">👎</button>';
    box.appendChild(d);
    d.addEventListener('click', function (e) {
      var b = e.target.closest('[data-ai-fb]');
      if (!b || d.classList.contains('voted')) return;
      d.classList.add('voted');
      var vote = b.getAttribute('data-ai-fb');
      fetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feedback: vote, q: q, reply: reply })
      }).catch(function () { });
      d.innerHTML = '<span class="ai-fb-thanks">Спасибо за оценку!</span>';
    });
    scrollBottom();
  }

  // Подборка товаров: ≤3 — все сразу; больше — первые 2 + кнопка
  // с иконками остальных (раскрыть) + «Скрыть» внизу списка.
  var AI_VISIBLE_COUNT = 2;
  var AI_COLLAPSE_FROM = 3;

  function moreBtnHtml(hiddenProds) {
    var thumbs = hiddenProds.slice(0, 5).map(function (p) {
      return '<img src="' + esc(imgUrl(p.image)) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">';
    }).join('');
    var extra = hiddenProds.length > 5 ? '<span class="ai-more-n">+' + (hiddenProds.length - 5) + '</span>' : '';
    return '<button class="ai-more-btn" type="button" data-ai-more>' +
      '<span class="ai-more-thumbs">' + thumbs + extra + '</span>' +
      '<span class="ai-more-txt">Показать ещё ' + hiddenProds.length + '</span>' +
      '<span class="ai-more-chev">▾</span>' +
      '</button>';
  }

  function renderProducts(box, products) {
    if (!products || !products.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'ai-prods';
    if (products.length <= AI_COLLAPSE_FROM) {
      wrap.innerHTML = products.map(prodCard).join('');
    } else {
      var vis = products.slice(0, AI_VISIBLE_COUNT);
      var rest = products.slice(AI_VISIBLE_COUNT);
      wrap.innerHTML = vis.map(prodCard).join('') +
        moreBtnHtml(rest) +
        '<div class="ai-prods-more hidden">' + rest.map(prodCard).join('') + '</div>' +
        '<button class="ai-hide-link hidden" type="button" data-ai-hide-list>Скрыть ▲</button>';
    }
    box.appendChild(wrap);
    scrollBottom();
  }

  // Кол-во товара в корзине (0 — нет) и потолок по остатку филиала
  function aiQty(id) {
    try {
      if (!window.Cart || !Cart.get) return 0;
      var it = Cart.get().find(function (i) { return String(i.id) === String(id); });
      return it ? (Number(it.qty) || 0) : 0;
    } catch (e) { return 0; }
  }

  function aiMax(id) {
    try {
      if (window.Cart && Cart.stockMax) {
        var m = Cart.stockMax(id);
        if (m !== null && m !== undefined) return Math.max(1, Math.min(m, 999));
      }
    } catch (e) { }
    return 999;
  }

  function cartIcon(size) {
    try { if (window.Utils && Utils.icon) return Utils.icon('cart', size || 14); } catch (e) { }
    return '';
  }

  // Контрол корзины в чате: пусто — зелёная кнопка «В корзину»;
  // после добавления — степпер − N +. Ширина обоих состояний одинаковая.
  function cartControlHtml(id) {
    var q = aiQty(id);
    if (q <= 0) {
      return '<button class="ai-add" type="button" data-ai-inc="' + esc(id) + '">' + cartIcon(14) + ' В корзину</button>';
    }
    return '<div class="ai-qty" title="Количество">' +
      '<button class="qty-btn" type="button" data-ai-dec="' + esc(id) + '" aria-label="Уменьшить">−</button>' +
      '<span class="qty-val" data-ai-qtyval="' + esc(id) + '">' + q + '</span>' +
      '<button class="qty-btn" type="button" data-ai-inc="' + esc(id) + '" aria-label="Увеличить">+</button>' +
      '</div>';
  }

  // Обновить все контролы корзины в чате (после изменений корзины)
  function refreshAiSteppers() {
    body.querySelectorAll('.ai-prod').forEach(function (card) {
      var id = card.getAttribute('data-ai-detail');
      if (!id) return;
      var side = card.querySelector('.ai-prod-side');
      if (side) side.innerHTML = cartControlHtml(id);
    });
  }

  function prodCard(p) {
    var price = Number(p.price) > 0 ? fmtPrice(p.price) : 'Цена по запросу';
    var st = p.stockState || (p.inStock ? 'in' : 'out');
    var stock = st === 'in'
      ? '<span class="ai-prod-stock ok">В наличии</span>'
      : st === 'out'
        ? (p.etaText
          ? '<span class="ai-prod-stock eta">Ожидается ≈ ' + esc(p.etaText) + '</span>'
          : '<span class="ai-prod-stock no">Нет в наличии</span>')
        : '<span class="ai-prod-stock na">Наличие уточняйте</span>';
    return '<div class="ai-prod" data-ai-detail="' + esc(p.id) + '" tabindex="0" role="button" title="Нажмите, чтобы открыть подробности">' +
      '<span class="ai-prod-media zoom-zone" data-zoom="2.8" data-lens="110">' +
      '<img src="' + esc(imgUrl(p.image)) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\'">' +
      (window.Utils && Utils.lensHtml ? Utils.lensHtml() : '') +
      '</span>' +
      '<div class="ai-prod-info">' +
      '<div class="ai-prod-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
      '<div class="ai-prod-meta"><span class="ai-prod-price">' + esc(price) + '</span>' + stock + '</div>' +
      '</div>' +
      '<div class="ai-prod-side">' + cartControlHtml(p.id) + '</div>' +
      '</div>';
  }

  function setBusy(b) {
    sendBtn.disabled = !!b;
    input.disabled = !!b;
  }

  function setOffline(off) {
    if (!statusEl) return;
    statusEl.classList.toggle('off', !!off);
    statusEl.textContent = off ? 'Эко-режим (без ИИ)' : 'Online';
  }

  // ---------------- Запрос ----------------

  var pending = false;

  // «Что в корзине?» — отвечает сам сайт, без запроса к серверу и нейронов
  function localCartAnswer(q) {
    if (!/корзин/i.test(q)) return null;
    var items = [];
    try { if (window.Cart && Cart.get) items = Cart.get() || []; } catch (e) { }
    if (!items.length) {
      return {
        reply: 'Ваша корзина пока пуста. Выберите товары в каталоге — помогу с выбором и оформлением.',
        products: [],
        actions: [{ type: 'link', label: '🔍 Открыть каталог', url: 'catalog.html' }],
        chips: DEFAULT_CHIPS
      };
    }
    var byId = {};
    (window.CatalogProducts || []).forEach(function (p) { byId[String(p.id)] = p; });
    var products = [];
    var total = 0;
    var lines = [];
    items.forEach(function (it) {
      var p = byId[String(it.id)];
      var qty = Number(it.qty) || 0;
      lines.push((p ? p.name : it.id) + ' × ' + qty);
      if (!p) return;
      total += (Number(p.price) || 0) * qty;
      products.push({ id: p.id, name: p.name, price: p.price, image: p.thumb || p.image, stockState: 'in' });
    });
    if (!products.length) return null;
    return {
      reply: 'В корзине: ' + lines.join(', ') + '. Итого: ' + fmtPrice(total) + '. Можно перейти в корзину и оформить заказ.',
      products: products,
      actions: [{ type: 'link', label: '🛒 Открыть корзину', url: 'cart.html' }],
      chips: DEFAULT_CHIPS
    };
  }

  function ask(text) {
    var q = String(text || '').trim();
    if (!q || pending) return;

    // Корзина — мгновенный локальный ответ
    var local = localCartAnswer(q);
    if (local) {
      closeChips();
      addUser(q);
      var lbox = addBotHtml(esc(local.reply).replace(/\n/g, '<br>'));
      renderProducts(lbox, local.products);
      renderActions(lbox, local.actions);
      renderChips(local.chips, lbox);
      renderFeedback(lbox, q, local.reply);
      hist.push({ role: 'user', text: q });
      hist.push({ role: 'assistant', text: local.reply, products: local.products, actions: local.actions });
      saveHist(hist);
      try { input.focus(); } catch (e) { }
      return;
    }

    pending = true;
    setBusy(true);
    closeChips();
    addUser(q);
    var typing = addTyping();
    var st = selectedStore();
    // Серверу — только текст реплик (без карточек, чтобы не раздувать запрос)
    var histToSend = hist.slice(-4).map(function (m) {
      return { role: m.role, text: m.text };
    });

    // ID устройства для личного лимита (тот же токен, что у «Моих заказов»)
    var ct = '';
    try { ct = (window.Utils && Utils.clientToken) ? Utils.clientToken() : (localStorage.getItem('greenleaf_client_token_v1') || ''); } catch (e) { }

    fetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: q,
        history: histToSend,
        storeId: st.id,
        storeName: st.name,
        ct: ct
      })
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        typing.remove();
        if (!d || !d.ok) {
          var msg = (d && d.message) || 'Не получилось ответить — попробуйте ещё раз или напишите в WhatsApp.';
          if (d && d.error === 'rate') {
            addBotHtml(esc(msg));
          } else {
            addBotHtml(esc(msg));
          }
          hist.push({ role: 'user', text: q });
          saveHist(hist);
          return;
        }
        var html = esc(d.reply || '').replace(/\n/g, '<br>');
        if (d.offline) {
          var note = document.createElement('div');
          note.className = 'ai-offline-note';
          note.textContent = 'Эко-режим: отвечаю без ИИ, чтобы не тратить квоту';
          body.appendChild(note);
        }
        setOffline(!!d.offline);
        var box = addBotHtml(html);
        renderSupplies(box, d.supplies);
        renderProducts(box, d.products);
        var acts = Array.isArray(d.actions) ? d.actions : [];
        renderActions(box, acts);
        renderChips(d.chips, box);
        renderFeedback(box, q, String(d.reply || ''));
        hist.push({ role: 'user', text: q });
        hist.push({ role: 'assistant', text: String(d.reply || '').slice(0, 500), products: Array.isArray(d.products) ? d.products : [], actions: acts });
        saveHist(hist);
      })
      .catch(function () {
        typing.remove();
        addBotHtml('Нет связи с сервером — проверьте интернет и попробуйте ещё раз.');
      })
      .then(function () {
        pending = false;
        setBusy(false);
        try { input.focus(); } catch (e) { }
      });
  }

  function closeChips() {
    body.querySelectorAll('.ai-chips').forEach(function (c) { c.remove(); });
  }

  sendBtn.addEventListener('click', function () {
    var v = input.value;
    input.value = '';
    ask(v);
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      var v = input.value;
      input.value = '';
      ask(v);
    }
  });

  // Восстановить историю (текст + карточки товаров — переживают перезагрузку)
  (function restore() {
    hist.slice(-MAX_HIST).forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'ai-msg ' + (m.role === 'user' ? 'user' : 'bot');
      if (m.role === 'user' || (!m.products && !m.actions)) {
        d.textContent = m.text;
        body.appendChild(d);
      } else {
        d.innerHTML = esc(m.text).replace(/\n/g, '<br>');
        body.appendChild(d);
        renderProducts(d, m.products);
        renderActions(d, m.actions);
      }
    });
    if (hist.length) scrollBottom();
  })();

  // Метка «корзина видна» для раскладки кнопок справа на десктопе.
  // cartFab переключается из cart.js — следим через observer + события.
  function syncHasCart() {
    try {
      var cf = document.getElementById('cartFab');
      document.body.classList.toggle('has-cart', !!(cf && !cf.classList.contains('hidden')));
    } catch (e) { }
  }
  try {
    var cf0 = document.getElementById('cartFab');
    if (cf0 && window.MutationObserver) {
      new MutationObserver(syncHasCart).observe(cf0, { attributes: true, attributeFilter: ['class'] });
    }
  } catch (e) { }
  document.addEventListener('cart:change', function () { setTimeout(function () { syncHasCart(); refreshAiSteppers(); }, 50); });
  document.addEventListener('DOMContentLoaded', function () { setTimeout(syncHasCart, 50); });
  syncHasCart();

  applyFabVisibility();
})();
