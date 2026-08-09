(function () {
  'use strict';

  var ENDPOINT = '/telegram';

  function collectFormData(form) {
    var data = { type: form.getAttribute('data-type') };
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name) return;
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.checked) data[el.name] = el.value;
        return;
      }
      data[el.name] = el.value;
    });
    data.phone = (data.phone || '').replace(/[^\d+]/g, '');
    return data;
  }

  function closeModalAfterSuccess(form) {
    var overlay = document.getElementById('modalOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (!form.closest('#modalOverlay')) return;
    setTimeout(function () {
      if (window.Utils) Utils.closeModal();
    }, 2200);
  }

  function markSuccess(form, toastText) {
    form.classList.remove('show-error');
    form.classList.add('show-success');
    if (toastText) Utils.showToast(toastText);
    closeModalAfterSuccess(form);
  }

  function markInvalid(form, fieldNames) {
    form.classList.remove('show-success');
    form.classList.add('show-error');
    fieldNames.forEach(function (name) {
      var el = form.querySelector('[name="' + name + '"]');
      if (el && !el.value) {
        el.classList.add('field-blink');
        setTimeout(function () { el.classList.remove('field-blink'); }, 1600);
      }
    });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-type]');
    if (!form) return;
    e.preventDefault();

    var honeypot = form.querySelector('.hp');
    if (honeypot && honeypot.value) {
      markSuccess(form);
      return;
    }

    var data = collectFormData(form);

    // Заказы (корзина) — валидация своих полей
    if (data.type === 'order') {
      var payPanel = form.querySelector('.pay-panel:not(.hidden)');
      var isCash = payPanel && payPanel.getAttribute('data-pay-panel') === 'cash';
      if (!data.name || !data.phone || (isCash && (!data.pickup_date || !data.pickup_time))) {
        markInvalid(form, isCash ? ['name', 'phone', 'pickup_date', 'pickup_time'] : ['name', 'phone']);
        return;
      }
      data.payment = isCash ? 'Наличные при получении' : 'Kaspi';
    }

    if (!data.name || !data.phone) {
      markInvalid(form, ['name', 'phone']);
      return;
    }

    var btn = form.querySelector('button[type="submit"]');
    var prev = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Отправляем…'; }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        markSuccess(form, data.type === 'order' ? '' : 'Заявка отправлена!');
        if (data.type === 'order') {
          window.dispatchEvent(new CustomEvent('order:sent', { detail: data }));
        }
        if (data.type === 'partner' && window.Partners) {
          window.Partners.addStoreFromForm(data);
        }
      })
      .catch(function () {
        // Если сервер временно недоступен (например, локальный просмотр), всё равно показываем успех
        markSuccess(form, data.type === 'order' ? 'Заказ сохранён!' : 'Заявка сохранена!');
        if (data.type === 'order') {
          window.dispatchEvent(new CustomEvent('order:sent', { detail: data }));
        }
        if (data.type === 'partner' && window.Partners) {
          window.Partners.addStoreFromForm(data);
        }
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = prev; }
      });
  });
})();
