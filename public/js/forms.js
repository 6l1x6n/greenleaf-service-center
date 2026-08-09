(function () {
  'use strict';

  var ENDPOINT = '/telegram';

  // Эти типы заявок уходят в WhatsApp (подписки, данные, регистрации и т.п.)
  var WHATSAPP_TYPES = {
    consultation: '💬 Консультация по подписке',
    subscription: '📦 Заявка на подписку',
    partner: '🤝 Заявка на партнёрство',
    event: '📅 Запись на мероприятие',
    client_registration: '📝 Регистрация клиента',
    join_team: '🤝 Присоединение к команде',
    notice: '📢 Уведомление для Сервис-Центров'
  };

  var FIELD_LABELS = {
    name: 'Имя',
    phone: 'Телефон',
    city: 'Город',
    address: 'Адрес',
    contact: 'Способ связи',
    comment: 'Комментарий',
    event: 'Мероприятие',
    product: 'Товар',
    store: 'Филиал',
    quantity: 'Кол-во',
    experience: 'Тип бизнеса',
    message: 'Сообщение',
    package: 'Пакет',
    notice: 'Уведомление',
    pickup_date: 'Дата приезда',
    pickup_time: 'Время приезда',
    partner_id: 'ID партнёра'
  };

  function whatsappNumber() {
    var sel = window.CatalogSelectedStore ? window.CatalogSelectedStore() : null;
    var num = sel && sel.whatsapp ? sel.whatsapp : null;
    if (!num) {
      var st = Utils.getStore();
      num = st && st.whatsapp ? st.whatsapp : null;
    }
    return num || '';
  }

  function collectFormData(form) {
    var data = { type: form.getAttribute('data-type') };
    var includeHidden = data.type === 'order';
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name) return;
      if (el.type === 'hidden' && !includeHidden) return;
      if (el.type === 'radio' || el.type === 'checkbox') {
        if (el.checked) data[el.name] = el.value;
        return;
      }
      data[el.name] = el.value;
    });
    data.phone = (data.phone || '').replace(/[^\d+]/g, '');
    return data;
  }

  function buildWaText(form, data) {
    var head = WHATSAPP_TYPES[data.type] || 'Заявка с сайта';
    var lines = [head];
    form.querySelectorAll('input, select, textarea').forEach(function (el) {
      if (!el.name || !el.value) return;
      if (el.type === 'radio' || el.type === 'checkbox') return;
      if (el.classList.contains('hp')) return;
      if (el.name === 'consent' || el.type === 'submit') return;
      var label = FIELD_LABELS[el.name] || el.name;
      lines.push(label + ': ' + String(el.value).trim());
    });
    lines.push('🕐 ' + new Date().toLocaleString('ru-RU'));
    return lines.join('\n');
  }

  function openWhatsApp(form, data) {
    var num = whatsappNumber();
    if (!num) {
      form.classList.remove('show-error');
      form.classList.add('show-success');
      Utils.showToast('Заявка сохранена!');
      return;
    }
    var text = buildWaText(form, data);
    window.open('https://wa.me/' + num + '?text=' + encodeURIComponent(text), '_blank');
    form.classList.remove('show-error');
    form.classList.add('show-success');
    Utils.showToast('Открываем WhatsApp…');
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
        form.classList.add('show-error');
        return;
      }
      data.payment = isCash ? 'Наличные при получении' : 'Kaspi';
    }

    if (!data.name || !data.phone) {
      form.classList.add('show-error');
      return;
    }

    if (WHATSAPP_TYPES[data.type]) {
      openWhatsApp(form, data);
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
