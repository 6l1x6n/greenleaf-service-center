(function () {
  'use strict';

  var FAB_KEY = 'greenleaf_ai_fab_hidden_v1';
  var HIST_KEY = 'greenleaf_ai_hist_v1';
  var MAX_HIST = 20;

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
    toast('Кнопка менеджера скрыта — вернуть можно через меню «🤖 ИИ-менеджер»');
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
      addBotHtml('Здравствуйте! Я помогу подобрать товары Greenleaf. Напишите, что ищете — например, «что есть для мозга» или «какие витаминки есть».');
      renderChips();
    }
    setTimeout(function () {
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
    if (e.target.closest('#aiHide')) hideFab();
    var chip = e.target.closest('[data-ai-chip]');
    if (chip) {
      openPanel();
      ask(chip.getAttribute('data-ai-chip') || '');
    }
    var add = e.target.closest('[data-ai-add]');
    if (add) {
      var id = add.getAttribute('data-ai-add');
      try {
        if (window.Cart && Cart.add) {
          Cart.add(id, 1);
          toast('🛒 Добавлено в корзину');
        } else {
          toast('Откройте каталог, чтобы добавить товар');
        }
      } catch (err) { toast('Не удалось добавить в корзину'); }
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

  function renderChips() {
    var d = document.createElement('div');
    d.className = 'ai-chips';
    var items = ['🧠 Что есть для мозга?', '💊 Какие витаминки есть?', '🧴 Что для дома?', '📍 Адрес и часы'];
    d.innerHTML = items.map(function (t) {
      return '<button class="ai-chip" type="button" data-ai-chip="' + esc(t) + '">' + esc(t) + '</button>';
    }).join('');
    body.appendChild(d);
    scrollBottom();
  }

  function prodCard(p) {
    var price = Number(p.price) > 0 ? fmtPrice(p.price) : 'Цена по запросу';
    var stock = p.inStock
      ? '<span class="ai-prod-stock ok">В наличии</span>'
      : '<span class="ai-prod-stock no">Нет в наличии</span>';
    return '<div class="ai-prod">' +
      '<img src="' + esc(imgUrl(p.image)) + '" alt="" loading="lazy" onerror="this.onerror=null;this.src=\'assets/images/products/placeholder.svg\'">' +
      '<div class="ai-prod-info">' +
      '<div class="ai-prod-name" title="' + esc(p.name) + '">' + esc(p.name) + '</div>' +
      '<div class="ai-prod-meta"><span class="ai-prod-price">' + esc(price) + '</span>' + stock + '</div>' +
      '</div>' +
      '<div class="ai-prod-btns">' +
      '<button class="btn btn-primary" type="button" data-ai-add="' + esc(p.id) + '">В корзину</button>' +
      '<button class="btn btn-outline" type="button" data-ai-detail="' + esc(p.id) + '">Подробнее</button>' +
      '</div>' +
      '</div>';
  }

  function setBusy(b) {
    sendBtn.disabled = !!b;
    input.disabled = !!b;
  }

  function setOffline(off) {
    if (!statusEl) return;
    statusEl.classList.toggle('off', !!off);
    statusEl.textContent = off ? 'Эко-режим (без ИИ)' : 'Online • отвечает кратко';
  }

  // ---------------- Запрос ----------------

  var pending = false;

  function ask(text) {
    var q = String(text || '').trim();
    if (!q || pending) return;
    pending = true;
    setBusy(true);
    closeChips();
    addUser(q);
    var typing = addBotHtml('<span class="ai-msg typing">Печатает…</span>');
    var st = selectedStore();

    fetch('/api/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: q,
        history: hist.slice(-4),
        storeId: st.id,
        storeName: st.name
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
        if (d.products && d.products.length) {
          var wrap = document.createElement('div');
          wrap.className = 'ai-prods';
          wrap.innerHTML = d.products.map(prodCard).join('');
          box.appendChild(wrap);
          scrollBottom();
        }
        hist.push({ role: 'user', text: q });
        hist.push({ role: 'assistant', text: String(d.reply || '').slice(0, 500) });
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
    var c = body.querySelector('.ai-chips');
    if (c) c.remove();
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

  // Восстановить старые реплики (только текст, без карточек — экономия DOM)
  (function restore() {
    hist.slice(-6).forEach(function (m) {
      var d = document.createElement('div');
      d.className = 'ai-msg ' + (m.role === 'user' ? 'user' : 'bot');
      d.textContent = m.text;
      body.appendChild(d);
    });
  })();

  applyFabVisibility();
})();
