(function () {
  'use strict';

  var ENDPOINT = '/.netlify/functions/telegram';

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-type]');
    if (!form) return;
    e.preventDefault();

    var honeypot = form.querySelector('.hp');
    if (honeypot && honeypot.value) {
      form.classList.remove('show-error');
      form.classList.add('show-success');
      return;
    }

    var data = { type: form.getAttribute('data-type') };
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (el.name && el.type !== 'hidden') data[el.name] = el.value;
    });
    data.phone = (data.phone || '').replace(/[^\d+]/g, '');

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
      })
      .catch(function () {
        form.classList.add('show-error');
        Utils.showToast('Не получилось отправить. Напишите в WhatsApp.');
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.innerHTML = prev; }
      });
  });
})();
