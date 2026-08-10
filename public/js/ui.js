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

    var waButtons = document.querySelectorAll('#waHeader, #waHero, #waContacts, #waFooter');
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

  window.Utils = {
    openModal: openModal,
    closeModal: closeModal,
    showToast: showToast,
    fmtPrice: fmtPrice,
    fmtDate: fmtDate,
    esc: esc,
    getStore: function () { return store; },
    waLink: waLink
  };

  document.getElementById('year').textContent = new Date().getFullYear();
  loadStore();

  // ---------------- Остатки по филиалам (store-stock.json + оверрайды админки) ----------------

  var STOCK_KEY = 'greenleaf_sc_custom_products_v1';
  var baseStock = {};
  var baseStockUpdated = '';
  var baseStockLoaded = null;

  function loadBaseStock() {
    if (baseStockLoaded) return baseStockLoaded;
    baseStockLoaded = fetch('data/store-stock.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        baseStock = (d && d.stock) || {};
        baseStockUpdated = (d && d.updated) || '';
      })
      .catch(function () {
        baseStock = {};
        baseStockUpdated = '';
      });
    return baseStockLoaded;
  }

  function stockOverrides() {
    try { return JSON.parse(localStorage.getItem(STOCK_KEY) || '{}'); } catch (e) { return {}; }
  }

  function storeStockData(storeId) {
    var ov = stockOverrides();
    var fromOverride = ov[storeId] && Object.keys(ov[storeId]).length;
    var fromBase = baseStock[storeId] && Object.keys(baseStock[storeId]).length;
    return !!(fromOverride || fromBase);
  }

  function stockText(storeId, productId) {
    var ov = stockOverrides();
    if (ov[storeId] && ov[storeId][productId] !== undefined) return ov[storeId][productId];
    if (baseStock[storeId] && baseStock[storeId][productId] !== undefined) return baseStock[storeId][productId];
    return undefined;
  }

  function isAvailableInStore(p, storeId) {
    if (!storeStockData(storeId)) return true;
    var t = stockText(storeId, p && p.id);
    if (t === undefined || t === null || String(t).trim() === '') return false;
    t = String(t);
    return t.indexOf('Нет') !== 0 && t.indexOf('Ожидается') === -1;
  }

  window.StoreStock = {
    load: loadBaseStock,
    hasData: storeStockData,
    text: stockText,
    available: isAvailableInStore,
    updated: function () { return baseStockUpdated; }
  };
})();
