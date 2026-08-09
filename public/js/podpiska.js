(function () {
  'use strict';

  function populateCitySelects() {
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

  function modalForm(opts) {
    var hidden = opts.package ? '<input type="hidden" name="package" value="' + opts.package + '">' : '';
    var listHtml = opts.list
      ? '<ul class="modal-list">' + opts.list.map(function (li) { return '<li>' + li + '</li>'; }).join('') + '</ul>'
      : '';
    return '' +
      '<h3>' + opts.title + '</h3>' +
      '<p class="modal-product">Оставьте заявку и мы свяжемся с вами для предоставления более подробной информации:</p>' +
      listHtml +
      '<form class="form" data-type="' + opts.type + '">' + hidden +
      '<input name="name" placeholder="Ваше имя *" required>' +
      '<input name="phone" type="tel" placeholder="+7 (___) ___-__-__ *" required>' +
      '<select name="contact" required>' +
      '<option value="" selected disabled>Способ связи</option>' +
      '<option value="Whatsapp">Whatsapp</option>' +
      '<option value="Телефон">Телефон</option>' +
      '</select>' +
      '<select name="city" class="city-select" required>' +
      '<option value="" selected disabled>Город</option>' +
      '</select>' +
      '<textarea name="comment" placeholder="Комментарий (необязательно)"></textarea>' +
      '<input class="hp" name="company" tabindex="-1" autocomplete="off">' +
      '<label class="form-consent"><input type="checkbox" checked>' +
      '<span>Нажимая на кнопку «Отправить», Вы соглашаетесь с обработкой Ваших персональных данных в соответствии с нашей Политикой конфиденциальности</span></label>' +
      '<button class="btn btn-primary btn-lg" type="submit">Отправить</button>' +
      '<p class="form-success">Заявка отправлена! Свяжемся с вами в ближайшее время.</p>' +
      '<p class="form-error">Проверьте обязательные поля.</p>' +
      '</form>';
  }

  document.addEventListener('click', function (e) {
    var planBtn = e.target.closest('.plan-btn');
    if (planBtn) {
      var plan = planBtn.getAttribute('data-plan');
      var pack = plan === 'Платина' ? 'Платина (188 000 ₸)' : 'Бронза (50 000 ₸)';
      Utils.openModal(modalForm({
        title: 'Оставить заявку на подписку по пакету ' + plan,
        type: 'subscription',
        package: pack
      }));
      populateCitySelects();
      return;
    }

    var joinBtn = e.target.closest('.join-team-btn');
    if (joinBtn) {
      Utils.openModal(modalForm({
        title: 'Присоединиться к команде',
        type: 'join_team',
        list: [
          'Что дает Регистрация в GreenLeaf;',
          'Какие есть преимущества;',
          'О скидках;',
          'О франшизе;',
          'Личный кабинет;',
          'и т.д.'
        ]
      }));
      populateCitySelects();
    }
  });

  populateCitySelects();
})();
