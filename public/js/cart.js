(function () {
  'use strict';

  var KEY = 'greenleaf_cart_v1';
  var listeners = [];

  function load() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(function (i) { return i && i.id; });
    } catch (e) {
      return [];
    }
  }

  function save(items) {
    try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) { }
    emit();
  }

  function emit() {
    document.dispatchEvent(new CustomEvent('cart:change'));
    listeners.forEach(function (fn) {
      try { fn(); } catch (e) { }
    });
  }

  function count() {
    return load().reduce(function (s, i) { return s + (Number(i.qty) || 0); }, 0);
  }

  // Выбранный СЦ (тот же ключ, что в catalog.js / cart-page.js)
  function selectedStoreId() {
    try {
      var s = JSON.parse(localStorage.getItem('greenleaf_sc_selected_v1') || 'null');
      return (s && s.id) ? String(s.id) : null;
    } catch (e) { return null; }
  }

  // Доступный остаток для товара в выбранном СЦ (null — данных нет, лимита нет)
  function stockMax(id) {
    try {
      if (!window.StoreStock || !StoreStock.count) return null;
      var sid = selectedStoreId();
      if (!sid) return null;
      return StoreStock.count(sid, id);
    } catch (e) { return null; }
  }

  // Верхний предел количества: остаток в выбранном СЦ (если известен), иначе 999
  function capFor(id) {
    var m = stockMax(id);
    return (m === null || m === undefined) ? 999 : Math.max(1, Math.min(m, 999));
  }

  function add(id, qty) {
    var items = load();
    var found = items.find(function (i) { return i.id === id; });
    var cap = capFor(id);
    if (found) {
      found.qty = Math.min((Number(found.qty) || 0) + (Number(qty) || 1), cap);
    } else {
      items.push({ id: id, qty: Math.min(Math.max(1, Number(qty) || 1), cap) });
    }
    save(items);
  }

  function setQty(id, qty) {
    var items = load();
    var found = items.find(function (i) { return i.id === id; });
    if (!found) return;
    found.qty = Math.min(Math.max(1, Number(qty) || 1), capFor(id));
    save(items);
  }

  // Срезать корзину до доступных остатков (например 100 → 50).
  // Возвращает число исправленных позиций. Не трогает товары без данных
  // об остатке (max null) и нулевые остатки (их скрытием занимается страница).
  function clampToStock() {
    var items = load();
    var changed = 0;
    items.forEach(function (i) {
      var m = stockMax(i.id);
      if (m === null || m === undefined || m <= 0) return;
      var cap = Math.min(m, 999);
      if ((Number(i.qty) || 0) > cap) { i.qty = cap; changed++; }
    });
    if (changed) save(items);
    return changed;
  }

  function remove(id) {
    save(load().filter(function (i) { return i.id !== id; }));
  }

  function clear() { save([]); }

  function updateBadge() {
    var n = count();
    var badge = document.getElementById('cartCount');
    if (badge) {
      badge.textContent = n > 99 ? '99+' : String(n);
      badge.style.display = n ? 'inline-flex' : 'none';
    }
    // Плавающая кнопка корзины (видна, только когда в корзине есть товары)
    var fab = document.getElementById('cartFab');
    if (fab) {
      fab.classList.toggle('hidden', !n);
      var fabCount = document.getElementById('cartFabCount');
      if (fabCount) {
        fabCount.textContent = n > 99 ? '99+' : String(n);
        fabCount.style.display = n ? 'inline-flex' : 'none';
      }
    }
    // Крестик очистки (только ПК, только когда есть товары)
    var clearBtn = document.getElementById('cartFabClear');
    if (clearBtn) {
      var isDesktop = window.matchMedia && window.matchMedia('(min-width: 641px)').matches;
      clearBtn.classList.toggle('hidden', !n || !isDesktop);
    }
  }

  // Крестик на плавающей корзине: очистить всю корзину (ПК)
  document.addEventListener('click', function (e) {
    if (!e.target.closest('#cartFabClear')) return;
    e.preventDefault();
    if (!count()) return;
    if (!confirm('Очистить корзину?')) return;
    clear();
    updateBadge();
    try { if (window.Utils && Utils.showToast) Utils.showToast('🗑 Корзина очищена'); } catch (err) { }
  });
  if (window.matchMedia) {
    try {
      window.matchMedia('(min-width: 641px)').addEventListener('change', updateBadge);
    } catch (e) {
      try { window.matchMedia('(min-width: 641px)').addListener(updateBadge); } catch (err) { }
    }
  }

  document.addEventListener('change', function (e) {
    var inp = e.target.closest('[data-cart-qty]');
    if (!inp) return;
    var id = inp.getAttribute('data-cart-qty');
    var qty = parseInt(inp.value, 10);
    if (isNaN(qty)) return;
    if (qty <= 0) { remove(id); return; }
    var cap = capFor(id);
    if (qty > cap) {
      qty = cap;
      try {
        if (window.Utils && Utils.showToast && cap < 999) Utils.showToast('⚠️ Количество уменьшено до доступного в филиале');
      } catch (err) { }
    }
    if (qty > 999) qty = 999;
    var items = load();
    var found = items.find(function (i) { return i.id === id; });
    if (found) setQty(id, qty);
    else add(id, qty);
  });

  window.Cart = {
    get: load,
    count: count,
    add: add,
    setQty: setQty,
    clampToStock: clampToStock,
    stockMax: stockMax,
    remove: remove,
    clear: clear,
    onChange: function (fn) { listeners.push(fn); },
    updateBadge: updateBadge
  };

  document.addEventListener('DOMContentLoaded', updateBadge);
  if (document.readyState === 'interactive' || document.readyState === 'complete') updateBadge();
})();
