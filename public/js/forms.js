(function () {
  'use strict';

  var ENDPOINT = '/telegram';

  function alreadyBookedEvent(eventId) {
    try {
      var mine = JSON.parse(localStorage.getItem('greenleaf_event_my_v1') || '{}');
      return !!mine[String(eventId)];
    } catch (e) { return false; }
  }

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
    if (data.type === 'order') delete data.name;
    data.phone = (data.phone || '').replace(/[^\d+]/g, '');
    return data;
  }

  function closeModalAfterSuccess(form) {
    var overlay = document.getElementById('modalOverlay');
    if (!overlay || overlay.classList.contains('hidden')) return;
    if (!form.closest('#modalOverlay')) return;
    setTimeout(function () {
      if (window.Utils) Utils.closeModal();
    }, 2600);
  }

  function successView(text) {
    return '<div class="form-success-panel">' +
      '<div class="fsp-icon">✅</div>' +
      '<div class="fsp-title">Заявка отправлена!</div>' +
      '<div class="fsp-text">' + (text || 'Мы получили ваши данные и свяжемся с вами в ближайшее время.') + '</div>' +
      '</div>';
  }

  function successTextFor(data) {
    switch (data.type) {
      case 'order': return 'Заказ принят. Уведомление отправляется менеджеру.';
      case 'subscription': return 'Заявка на подписку принята — менеджер свяжется с вами.';
      case 'event': return 'Вы записаны — подтвердим участие в ближайшее время.';
      case 'partner': return 'Заявка на партнёрство принята — рассмотрим её в ближайшее время.';
      default: return 'Мы получили ваши данные и свяжемся с вами в ближайшее время.';
    }
  }

  function markSuccess(form, toastText, text) {
    form.classList.remove('show-error');
    form.classList.remove('show-success');
    form.innerHTML = successView(text || successTextFor({ type: form.getAttribute('data-type') }));
    if (toastText) Utils.showToast(toastText);
    closeModalAfterSuccess(form);
  }

  function setFormError(form, message) {
    form.classList.remove('show-success');
    form.classList.add('show-error');
    var error = form.querySelector('.form-error');
    if (error) error.textContent = message || 'Не удалось отправить форму. Попробуйте ещё раз.';
  }

  function markError(form, message) {
    setFormError(form, message);
  }

  function markInvalid(form, fieldNames, message) {
    setFormError(form, message);
    fieldNames.forEach(function (name) {
      var el = form.querySelector('[name="' + name + '"]');
      if (el && !String(el.value || '').trim()) {
        el.classList.add('field-blink');
        setTimeout(function () { el.classList.remove('field-blink'); }, 1600);
      }
    });
  }

  document.addEventListener('submit', function (e) {
    var form = e.target.closest('form[data-type]');
    if (!form) return;
    if (e.defaultPrevented) return;
    if (form.getAttribute('data-submitting') === '1') return;
    e.preventDefault();

    var honeypot = form.querySelector('.hp');
    if (honeypot && honeypot.value) {
      markSuccess(form);
      return;
    }

    var data = collectFormData(form);

    if (data.type === 'event' && data.event_id && alreadyBookedEvent(data.event_id)) {
      Utils.showToast('Вы уже записаны на это мероприятие');
      return;
    }

    if (data.type === 'order') {
      if (!data.phone) {
        markInvalid(form, ['phone'], 'Укажите номер телефона.');
        return;
      }
    } else if (!data.name || !data.phone) {
      markInvalid(form, ['name', 'phone'], 'Заполните имя и номер телефона.');
      return;
    }

    var btn = form.querySelector('button[type="submit"]');
    var prev = btn ? btn.innerHTML : '';

    function setBusy(busy) {
      form.setAttribute('data-submitting', busy ? '1' : '0');
      if (btn) {
        btn.disabled = busy;
        btn.innerHTML = busy ? (data.type === 'order' ? 'Оформляем…' : 'Отправляем…') : prev;
      }
      window.dispatchEvent(new CustomEvent('form:state', { detail: { form: form, busy: busy } }));
    }

    function showFailure(message) {
      markError(form, message);
      if (window.Utils) Utils.showToast('⚠️ ' + message);
    }

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
      .then(function (res) {
        return res.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (err) { body = null; }
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (result) {
        if (!result.ok) {
          var err = result.body || {};
          var message = err.message || 'Не удалось отправить форму. Попробуйте ещё раз.';
          if (data.type === 'order' && err.error === 'expired') {
            message = err.message || 'Бронь не подтверждена. Обновите корзину и попробуйте ещё раз.';
            window.dispatchEvent(new CustomEvent('order:expired'));
          }
          showFailure(message);
          return;
        }

        markSuccess(form, data.type === 'order' ? '' : 'Заявка отправлена!', successTextFor(data));
        if (data.type === 'order') {
          window.dispatchEvent(new CustomEvent('order:sent', {
            detail: Object.assign({}, data, { orderNumber: result.body && result.body.number })
          }));
          return;
        }
        if (data.type === 'event' && data.event_id) {
          fetch('/api/event-book', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ eventId: data.event_id, qty: 1 })
          }).catch(function () { });
          try {
            var mine = JSON.parse(localStorage.getItem('greenleaf_event_my_v1') || '{}');
            mine[data.event_id] = Date.now();
            localStorage.setItem('greenleaf_event_my_v1', JSON.stringify(mine));
          } catch (err) { }
          window.dispatchEvent(new CustomEvent('event:booked', { detail: { id: data.event_id } }));
        }
        if (data.type === 'partner' && window.Partners) {
          window.Partners.addStoreFromForm(data);
        }
      })
      .catch(function () {
        showFailure('Нет связи с сервером. Проверьте соединение и попробуйте ещё раз.');
      })
      .finally(function () {
        setBusy(false);
      });
  });
})();
