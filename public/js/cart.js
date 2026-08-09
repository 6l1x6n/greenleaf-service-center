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

  function add(id, qty) {
    var items = load();
    var found = items.find(function (i) { return i.id === id; });
    if (found) {
      found.qty = (Number(found.qty) || 0) + (Number(qty) || 1);
    } else {
      items.push({ id: id, qty: Number(qty) || 1 });
    }
    save(items);
  }

  function setQty(id, qty) {
    var items = load();
    var found = items.find(function (i) { return i.id === id; });
    if (!found) return;
    found.qty = Math.max(1, Number(qty) || 1);
    save(items);
  }

  function remove(id) {
    save(load().filter(function (i) { return i.id !== id; }));
  }

  function clear() { save([]); }

  function updateBadge() {
    var badge = document.getElementById('cartCount');
    if (!badge) return;
    var n = count();
    badge.textContent = n > 99 ? '99+' : String(n);
    badge.style.display = n ? 'inline-flex' : 'none';
  }

  window.Cart = {
    get: load,
    count: count,
    add: add,
    setQty: setQty,
    remove: remove,
    clear: clear,
    onChange: function (fn) { listeners.push(fn); },
    updateBadge: updateBadge
  };

  document.addEventListener('DOMContentLoaded', updateBadge);
  if (document.readyState === 'interactive' || document.readyState === 'complete') updateBadge();
})();
