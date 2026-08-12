(function () {
  'use strict';

  var STORAGE_KEY = 'greenleaf_partner_stores_v2';

  function getStores() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        var parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch (e) {
      console.warn('Could not read partner stores from localStorage', e);
    }
    return [];
  }

  function saveStores(list) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch (e) {
      console.warn('Could not save partner stores to localStorage', e);
    }
  }

  // Компактный список запросов (только созданные пользователем)
  function renderStores() {
    var container = document.getElementById('partnerStoresGrid');
    var countEl = document.getElementById('partnerStoresCount');
    if (!container) return;

    var list = getStores();
    if (countEl) countEl.textContent = list.length;

    if (list.length === 0) {
      container.innerHTML = '<div class="owner-req-empty">Заявок пока нет — заполните форму слева, и она появится здесь.</div>';
      return;
    }

    container.innerHTML = list.map(function (item) {
      var statusCls = item.status === 'pending' ? 'badge-pending' : (item.status === 'rejected' ? 'badge-rejected' : 'badge-active');
      var statusText = item.statusLabel || (item.status === 'pending' ? '⏳ На рассмотрении' : (item.status === 'rejected' ? '❌ Отклонена' : '🏬 Действующий магазин'));
      return '<article class="owner-req-item" id="store-' + Utils.esc(item.id) + '">' +
        '<div class="owner-req-top">' +
        '<strong>' + Utils.esc(item.storeName || 'Магазин') + '</strong>' +
        '<span class="store-badge ' + statusCls + '">' + Utils.esc(statusText) + '</span>' +
        '</div>' +
        '<div class="owner-req-meta">📍 ' + Utils.esc(item.city || 'Город не указан') + '</div>' +
        '</article>';
    }).join('');
  }

  function addStoreFromForm(data) {
    var list = getStores();
    var fullCity = [data.city, data.address].filter(Boolean).join(', ');

    var newStore = {
      id: 'store_' + Date.now(),
      storeName: data.storeName || ('Зелёный Магазин (' + (data.city || 'Новая заявка') + ')'),
      name: data.name || 'Заявитель',
      phone: data.phone || '',
      city: fullCity || 'Казахстан',
      status: 'pending',
      statusLabel: '⏳ На рассмотрении',
      message: data.message || 'Заявка отправлена и ожидает проверки администратором.',
      createdAt: new Date().toISOString(),
      isNew: true
    };

    list.unshift(newStore);
    saveStores(list);
    renderStores();

    setTimeout(function () {
      var el = document.getElementById('store-' + newStore.id);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 100);
  }

  window.Partners = {
    renderStores: renderStores,
    addStoreFromForm: addStoreFromForm,
    getStores: getStores,
    saveStores: saveStores
  };

  // ---------------- Единая заявка партнёра / Сервис-Центра ----------------
  // Отправляется в Worker (Cloudflare KV) + уведомление главному администратору.
  // Поля кабинета (officeCode/portalLogin/portalPassword) необязательны:
  // без них заявка считается партнёрской, с ними — на подключение СЦ с автоостатками.

  function submitPartnerRegistration(form) {
    var data = {};
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name || el.type === 'radio' || el.type === 'checkbox') return;
      data[el.name] = el.value;
    });
    if (!data.name || !data.phone || !data.storeName || !data.city || !data.address) {
      form.classList.remove('show-success');
      form.classList.add('show-error');
      return;
    }
    if (data.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
      form.classList.remove('show-success');
      form.classList.add('show-error');
      return;
    }
    data.type = 'sc_registration';
    var schedule = window.Utils && Utils.collectSchedule ? Utils.collectSchedule(form) : null;
    if (!schedule) {
      form.classList.remove('show-success');
      form.classList.add('show-error');
      if (window.Utils) Utils.showToast('⚠️ Укажите хотя бы один рабочий день в расписании');
      return;
    }
    data.schedule = schedule;
    if (!data.hours) data.hours = Utils.scheduleToText(schedule);

    var btn = form.querySelector('button[type="submit"]');
    var prev = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Отправляем…'; }

    fetch('/api/register-sc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    }).then(function (r) {
      return r.json();
    }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || 'HTTP error');
      form.classList.add('show-success');
      addStoreFromForm(data);
      if (window.Utils) Utils.showToast('✅ Заявка отправлена администратору');
    }).catch(function (err) {
      form.classList.remove('show-success');
      form.classList.add('show-error');
      if (window.Utils && err && err.message) Utils.showToast(err.message);
    }).then(function () {
      if (btn) { btn.disabled = false; btn.innerHTML = prev; }
    });
  }

  // Города Казахстана в селекторы городов: топ-3 жирными, остальные по алфавиту
  function populateCitySelect() {
    var selects = document.querySelectorAll('.city-select');
    if (!selects.length || !window.KZ_CITIES) return;
    selects.forEach(function (sel) {
      if (sel.options.length > 1) return;
      (window.KZ_CITIES_ORDERED || window.KZ_CITIES).forEach(function (c) {
        var opt = document.createElement('option');
        opt.textContent = c;
        if ((window.KZ_CITIES_TOP || []).indexOf(c) !== -1) opt.className = 'city-top';
        sel.appendChild(opt);
      });
    });
  }

  document.addEventListener('submit', function (e) {
    var partnerForm = e.target.closest('form[data-partner-register]');
    if (partnerForm) {
      e.preventDefault();
      submitPartnerRegistration(partnerForm);
      return;
    }
    // Клиентская форма убрана: вход и регистрация только для СЦ и суперадмина
  });

  document.addEventListener('DOMContentLoaded', function () {
    populateCitySelect();
    renderStores();
    var ownerSchedule = document.getElementById('ownerScheduleBlock');
    if (ownerSchedule && window.Utils && Utils.scheduleFormHtml) {
      ownerSchedule.innerHTML = Utils.scheduleFormHtml({});
    }
  });
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    populateCitySelect();
    renderStores();
    var ownerScheduleReady = document.getElementById('ownerScheduleBlock');
    if (ownerScheduleReady && window.Utils && Utils.scheduleFormHtml) {
      ownerScheduleReady.innerHTML = Utils.scheduleFormHtml({});
    }
  }
})();
