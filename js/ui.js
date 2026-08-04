(function () {
  'use strict';

  var overlay = document.getElementById('modalOverlay');
  var modalBody = document.getElementById('modalBody');
  var modalClose = document.getElementById('modalClose');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  var store = null;

  function openModal(html) {
    modalBody.innerHTML = html;
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
    return new Intl.NumberFormat('ru-RU').format(n) + ' ₽';
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
    } catch (err) {
      document.getElementById('heroAddress').textContent = 'Данные скоро появятся';
    }
  }

  function bindStore(s) {
    document.title = 'Сервис-центр Greenleaf — ' + s.address;
    document.getElementById('heroAddress').textContent = s.address;
    document.getElementById('heroHours').textContent =
      (s.hours[0] ? s.hours[0].days + ' ' + s.hours[0].time : '');
    document.getElementById('contactsInfo').innerHTML =
      '<div class="row"><span class="lbl">Адрес</span><span>' + esc(s.address) + '</span></div>' +
      '<div class="row"><span class="lbl">Часы</span><span>' + esc(s.hours.map(function (h) { return h.days + ' ' + h.time; }).join('<br>')) + '</span></div>' +
      '<div class="row"><span class="lbl">Телефон</span><span>' + esc(s.phone) + '</span></div>';
    document.getElementById('phoneLink').href = 'tel:' + s.phoneRaw;
    document.getElementById('phoneLink').textContent = 'Позвонить: ' + s.phone;

    var waButtons = document.querySelectorAll('#waHeader, #waHero, #waContacts, #waFooter');
    waButtons.forEach(function (b) {
      b.href = waLink('Здравствуйте! Интересует наличие техники Greenleaf.');
    });

    var map = document.getElementById('map');
    map.src = 'https://yandex.ru/map-widget/v1/?text=' + encodeURIComponent(s.address);
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
})();
