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
      var res = await fetch('data/store.json?t=' + Date.now());
      store = await res.json();
      bindStore(store);
    } catch (err) { }
  }

  function bindStore(s) {
    document.title = 'Сервис-центры Greenleaf — каталог продукции и эко-товаров';

    var waButtons = document.querySelectorAll('#waHero, #waContacts, #waFooter');
    waButtons.forEach(function (b) {
      b.href = waLink('Здравствуйте! Интересует наличие эко-продукции Greenleaf.');
    });

    var forgot = document.getElementById('forgotPassLink');
    if (forgot) {
      forgot.href = waLink('Здравствуйте! Не могу вспомнить пароль от кабинета Greenleaf.');
    }

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

  window.Utils = {
    openModal: openModal,
    closeModal: closeModal,
    showToast: showToast,
    fmtPrice: fmtPrice,
    fmtDate: fmtDate,
    esc: esc,
    getStore: function () { return store; },
    waLink: waLink,
    iconX: iconX,
    iconTrash: iconTrash,
    iconTruck: iconTruck
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
    baseStockLoaded = fetch('/api/stock?t=' + Date.now())
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
        return fetch('data/store-stock.json?t=' + Date.now())
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

  function storeStockData(storeId) {
    var fromBase = baseStock[storeId] && Object.keys(baseStock[storeId]).length;
    return !!fromBase;
  }

  function stockText(storeId, productId) {
    if (baseStock[storeId] && baseStock[storeId][productId] !== undefined) return baseStock[storeId][productId];
    return undefined;
  }

  function isAvailableInStore(p, storeId) {
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

  window.StoreStock = {
    load: loadBaseStock,
    hasData: storeStockData,
    text: stockText,
    count: stockCount,
    available: isAvailableInStore,
    updated: function () { return baseStockUpdated; }
  };
})();
