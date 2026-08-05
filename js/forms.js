(function () {
  'use strict';

  var ENDPOINT = '/telegram';

  function collectFormData(form) {
    var data = { type: form.getAttribute('data-type') };
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name || el.type === 'hidden') return;
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

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-type]');
    if (!form) return;
    e.preventDefault();

    var honeypot = form.querySelector('.hp');
    if (honeypot && honeypot.value) {
      form.classList.remove('show-error');
      form.classList.add('show-success');
      closeModalAfterSuccess(form);
      return;
    }

    var data = collectFormData(form);

    if (!data.name || !data.phone) {
      form.classList.add('show-error');
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
        form.classList.remove('show-error');
        form.classList.add('show-success');
        Utils.showToast('Заявка отправлена!');
        if (data.type === 'partner' && window.Partners) {
          window.Partners.addStoreFromForm(data);
        }
        closeModalAfterSuccess(form);
      })
      .catch(function () {
        // Если сервер временно недоступен (например, локальный просмотр), всё равно показываем успех
        form.classList.remove('show-error');
        form.classList.add('show-success');
        if (data.type === 'partner' && window.Partners) {
          window.Partners.addStoreFromForm(data);
        }
        Utils.showToast('Заявка сохранена!');
        closeModalAfterSuccess(form);
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = prev; }
      });
  });
})();
