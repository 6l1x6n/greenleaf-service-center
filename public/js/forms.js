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
      case 'order': return 'Заказ ушёл менеджеру — подтвердим его в ближайшее время.';
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

  function markError(form) {
    form.classList.remove('show-success');
    form.classList.add('show-error');
    var btn = form.querySelector('button[type="submit"]');
    if (btn) { btn.disabled = false; }
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
    if (e.defaultPrevented) return;
    e.preventDefault();

    var honeypot = form.querySelector('.hp');
    if (honeypot && honeypot.value) {
      markSuccess(form);
      return;
    }

    var data = collectFormData(form);

    // Повторная запись на мероприятие с того же устройства — блокируем
    if (data.type === 'event' && data.event_id && alreadyBookedEvent(data.event_id)) {
      Utils.showToast('Вы уже записаны на это мероприятие');
      return;
    }

    // Заказы (корзина) — валидация своих полей
    if (data.type === 'order') {
      var isCash = data.payment === 'Наличные при получении';
      if (!data.name || !data.phone || (isCash && (!data.pickup_date || !data.pickup_time))) {
        markInvalid(form, isCash ? ['name', 'phone', 'pickup_date', 'pickup_time'] : ['name', 'phone']);
        return;
      }
    }

    if (!data.name || !data.phone) {
      markInvalid(form, ['name', 'phone']);
      return;
    }

    var btn = form.querySelector('button[type="submit"]');
    var prev = btn ? btn.innerHTML : '';

    // Отправка заказа с повторами при «expired»: KV eventual consistency —
    // бронь может быть не видна на другом коло сразу после резерва (секунды).
    // До 3 повторов с паузой 3с закрывают окно лага; если брони реально нет —
    // покажем «время истекло».
    function submitOrder(attemptsLeft) {
      if (btn) { btn.disabled = true; btn.textContent = attemptsLeft > 0 ? '⏳ Проверяем бронь…' : 'Отправляем…'; }
      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
        .then(function (res) {
          if (!res.ok) {
            if (data.type === 'order') {
              return res.json().catch(function () { return null; }).then(function (errData) {
                if (errData && errData.error === 'expired' && attemptsLeft > 0) {
                  setTimeout(function () { submitOrder(attemptsLeft - 1); }, 3000);
                  return;
                }
                if (errData && errData.error === 'expired') {
                  if (window.Utils) Utils.showToast('⏳ ' + (errData.message || 'Время бронирования истекло — соберите корзину заново'));
                  window.dispatchEvent(new CustomEvent('order:expired'));
                }
                markError(form);
              });
            }
            throw new Error('HTTP ' + res.status);
          }
          markSuccess(form, data.type === 'order' ? '' : 'Заявка отправлена!', successTextFor(data));
          if (data.type === 'order') {
            window.dispatchEvent(new CustomEvent('order:sent', { detail: data }));
          }
          if (data.type === 'event' && data.event_id) {
            // Бронь места в единой БД (Worker KV) + защита от дублей на этом устройстве
            fetch('/api/event-book', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ eventId: data.event_id, qty: 1 })
            }).catch(function () { });
            try {
              var mine = JSON.parse(localStorage.getItem('greenleaf_event_my_v1') || '{}');
              mine[data.event_id] = Date.now();
              localStorage.setItem('greenleaf_event_my_v1', JSON.stringify(mine));
            } catch (e) { }
            window.dispatchEvent(new CustomEvent('event:booked', { detail: { id: data.event_id } }));
          }
          if (data.type === 'partner' && window.Partners) {
            window.Partners.addStoreFromForm(data);
          }
        })
        .catch(function () {
          markError(form);
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.innerHTML = prev; }
        });
    }

    submitOrder(data.type === 'order' ? 3 : 0);
  });
})();
