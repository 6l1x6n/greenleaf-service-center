(function () {
  'use strict';

  var overlay = document.getElementById('modalOverlay');
  var modalBody = document.getElementById('modalBody');
  var modalClose = document.getElementById('modalClose');
  var toastEl = document.getElementById('toast');
  var toastTimer = null;

  var store = null;

  function openModal(html, wide) {
    modalBody.innerHTML = html;
    var modalEl = overlay.querySelector('.modal');
    if (modalEl) {
      if (wide) {
        modalEl.classList.add('modal-wide');
      } else {
        modalEl.classList.remove('modal-wide');
      }
    }
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
    return new Intl.NumberFormat('ru-RU').format(n) + ' ₸';
  }

  function fmtDate(iso, opts) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('ru-RU', opts || { day: 'numeric', month: 'long' });
  }

  // Поиск товара по названию позиции (для миниатюр в поставках):
  // точное имя → артикул → вхождение строки → взвешенное совпадение токенов (бренд/тип продукта)
  function productByLabel(products, label) {
    if (!products || !products.length) return null;
    var q = String(label || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/[.,;:"'()\[\]«»]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    var i, p;
    for (i = 0; i < products.length; i++) {
      if (String(products[i].name || '').trim().toLowerCase().replace(/ё/g, 'е') === q) return products[i];
    }
    for (i = 0; i < products.length; i++) {
      if (String(products[i].sku || '').toLowerCase() === q) return products[i];
    }
    for (i = 0; i < products.length; i++) {
      if (String(products[i].name || '').toLowerCase().indexOf(q) !== -1) return products[i];
    }
    // Токенный матчинг: «SEALUX Hydra крем» → «Крем-лосьон Sealuxe …»
    var stop = { 'для': 1, 'и': 1, 'в': 1, 'на': 1, 'с': 1, 'со': 1, 'при': 1, 'от': 1, 'из': 1, 'по': 1, 'до': 1, 'не': 1, 'как': 1 };
    function tokens(s) {
      var out = [];
      String(s || '').toLowerCase().replace(/ё/g, 'е').split(/[^a-zа-я0-9]+/).forEach(function (t) {
        t = t.replace(/ы+$|и$/i, '').replace(/ая$|ое$|ый$|ий$|ой$|ого$|ому$|ым$|ом$|ах$|ях$|ами$|ями$/i, '');
        if (t.length >= 3 && !stop[t]) out.push(t);
      });
      return out;
    }
    var qTok = tokens(q);
    if (!qTok.length) return null;
    var best = null;
    var bestScore = 0;
    for (i = 0; i < products.length; i++) {
      var nameTok = tokens(products[i].name);
      if (!nameTok.length) continue;
      var score = 0;
      qTok.forEach(function (a) {
        nameTok.forEach(function (b) {
          if (a === b || (a.length >= 3 && b.length >= 3 && (a.indexOf(b) !== -1 || b.indexOf(a) !== -1))) score++;
        });
      });
      if (score > bestScore) {
        bestScore = score;
        best = products[i];
      }
    }
    // Одиночный специфичный токен («Освежитель») — тоже засчитываем
    if (bestScore >= 2 || (bestScore >= 1 && qTok.length === 1 && qTok[0].length >= 6)) return best;
    return null;
  }

  // Миниатюра товара для позиции поставки; наведение — название, клик — модалка товара
  function deliveryItemHtml(products, label, qty) {
    var p = productByLabel(products, label);
    var txt = Utils.esc(label);
    if (p) {
      var img = p.thumb || p.image || 'assets/images/products/placeholder.svg';
      return '<span class="delivery-item" data-del-open="' + Utils.esc(p.id) + '" title="' + txt + '" style="cursor:pointer;">' +
        '<img class="delivery-item-img" src="' + Utils.esc(img) + '" alt="' + txt + '" onerror="this.style.display=\'none\'">' +
        (qty ? ' × ' + qty : '') + '</span>';
    }
    return '<span class="delivery-item" title="' + txt + '">' + txt + (qty ? ' × ' + qty : '') + '</span>';
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
      var res = await fetch('data/store.json');
      store = await res.json();
      bindStore(store);
    } catch (err) { }
  }

  function bindStore(s) {
    document.title = 'Сервис-центры Greenleaf — каталог продукции и эко-товаров';

    var waButtons = document.querySelectorAll('#waHero, #waContacts, #waFooter');
    waButtons.forEach(function (b) {
      b.href = waLink('Здравствуйте! Интересует наличие эко-продукции Greenleaf.');
    });

    // Восстановление пароля — по email (форма в cabinet.html), не через WhatsApp

    // Контакты/карта зависят от выбранного СЦ — их рендерит catalog.js
    if (window.CatalogRefreshContacts) window.CatalogRefreshContacts();
  }

  // ---------------- Векторные иконки (SVG) ----------------
  // Эмодзи-символы не отрисовываются на части устройств — используем SVG.

  var SVG_ATTRS = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"';

  function iconX(size) {
    return '<svg ' + SVG_ATTRS + ' width="' + (size || 13) + '" height="' + (size || 13) + '" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
  }

  function iconTrash(size) {
    return '<svg ' + SVG_ATTRS + ' width="' + (size || 15) + '" height="' + (size || 15) + '" aria-hidden="true">' +
      '<path d="M4 7h16"/><path d="M9.5 7V5.2c0-.6.5-1.2 1.1-1.2h2.8c.6 0 1.1.6 1.1 1.2V7"/>' +
      '<path d="M6.5 7l.9 12.2c0 .6.5 1.2 1.1 1.2h7c.6 0 1.1-.6 1.1-1.2L17.5 7"/>' +
      '<path d="M10 11v6"/><path d="M14 11v6"/></svg>';
  }

  function iconTruck(size) {
    return '<svg ' + SVG_ATTRS + ' width="' + (size || 22) + '" height="' + (size || 22) + '" aria-hidden="true">' +
      '<rect x="2" y="6.5" width="11.5" height="8.5" rx="1.4"/>' +
      '<path d="M13.5 9.5h4.4l3.1 3.1V15h-7.5z"/>' +
      '<circle cx="6.4" cy="17.4" r="1.7"/><circle cx="17.3" cy="17.4" r="1.7"/></svg>';
  }

  var WEEK_DAYS = [['mon', 'Пн'], ['tue', 'Вт'], ['wed', 'Ср'], ['thu', 'Чт'], ['fri', 'Пт'], ['sat', 'Сб'], ['sun', 'Вс']];

  function scheduleTimeOptions(selected) {
    var out = '';
    for (var m = 8 * 60; m <= 21 * 60; m += 30) {
      var hh = String(Math.floor(m / 60)).padStart(2, '0');
      var mm = String(m % 60).padStart(2, '0');
      var v = hh + ':' + mm;
      out += '<option value="' + v + '"' + (v === selected ? ' selected' : '') + '>' + v + '</option>';
    }
    return out;
  }

  // Расписание по умолчанию: из schedule-объекта, статичной строки hours или 10:00–20:00 все дни
  function scheduleDefault(store) {
    store = store || {};
    if (store.schedule && typeof store.schedule === 'object' && store.schedule.mon !== undefined) {
      var merged = {};
      WEEK_DAYS.forEach(function (d) {
        var v = store.schedule[d[0]];
        merged[d[0]] = v ? { open: String(v.open || '10:00'), close: String(v.close || '20:00') } : null;
      });
      return merged;
    }
    var hrs = String(store.hours || '');
    var m = /(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})/.exec(hrs);
    var open = m ? m[1] + ':' + m[2] : '10:00';
    var close = m ? m[3] + ':' + m[4] : '20:00';
    var off = {};
    if (/Пн\s*[-–—]\s*Пт/.test(hrs)) { off.sat = true; off.sun = true; }
    else if (/Пн\s*[-–—]\s*Сб/.test(hrs) || /Сб\s*[-–—]\s*Вс/.test(hrs)) { off.sun = true; }
    var sch = {};
    WEEK_DAYS.forEach(function (d) { sch[d[0]] = off[d[0]] ? null : { open: open, close: close }; });
    return sch;
  }

  function scheduleToText(sch) {
    sch = sch || {};
    var parts = [];
    var i = 0;
    while (i < WEEK_DAYS.length) {
      var d = WEEK_DAYS[i];
      var cur = sch[d[0]];
      if (!cur) { i++; continue; }
      var j = i;
      while (j + 1 < WEEK_DAYS.length && sch[WEEK_DAYS[j + 1][0]] && sch[WEEK_DAYS[j + 1][0]].open === cur.open && sch[WEEK_DAYS[j + 1][0]].close === cur.close) {
        j++;
      }
      var range = WEEK_DAYS[i][1] + (j > i ? '–' + WEEK_DAYS[j][1] : '');
      parts.push(range + ' ' + cur.open + ' – ' + cur.close);
      i = j + 1;
    }
    return parts.length ? parts.join(', ') : 'Выходной';
  }

  function scheduleFormHtml(store) {
    var sch = scheduleDefault(store);
    var rows = WEEK_DAYS.map(function (d) {
      var v = sch[d[0]];
      var openSel = '<select class="sched-open" data-day="' + d[0] + '">' + scheduleTimeOptions(v ? v.open : '10:00') + '</select>';
      var closeSel = '<select class="sched-close" data-day="' + d[0] + '">' + scheduleTimeOptions(v ? v.close : '20:00') + '</select>';
      return '<div class="sched-row' + (v ? '' : ' has-off') + '">' +
        '<span class="sched-day">' + d[1] + '</span>' +
        '<label class="form-checkbox sched-off"><input type="checkbox" data-sched-off="' + d[0] + '"' + (v ? '' : ' checked') + '> Выходной</label>' +
        '<span class="sched-times">' + openSel + ' – ' + closeSel + '</span>' +
        '</div>';
    });
    return '<div class="form-group">' +
      '<label>Расписание работы (дни и время) *</label>' +
      '<div class="sched-grid">' + rows.join('') + '</div>' +
      '<input type="hidden" name="hours" value="' + esc(scheduleToText(sch)) + '">' +
      '</div>';
  }

  // Собрать расписание из DOM-селекторов
  function collectSchedule(form) {
    var sch = {};
    var any = false;
    WEEK_DAYS.forEach(function (d) {
      var off = form.querySelector('[data-sched-off="' + d[0] + '"]');
      if (off && off.checked) { sch[d[0]] = null; return; }
      var o = form.querySelector('.sched-open[data-day="' + d[0] + '"]');
      var c = form.querySelector('.sched-close[data-day="' + d[0] + '"]');
      sch[d[0]] = { open: o ? o.value : '10:00', close: c ? c.value : '20:00' };
      any = true;
    });
    return any ? sch : null;
  }

  window.Utils = {
    openModal: openModal,
    closeModal: closeModal,
    showToast: showToast,
    fmtPrice: fmtPrice,
    fmtDate: fmtDate,
    esc: esc,
    productByLabel: productByLabel,
    deliveryItemHtml: deliveryItemHtml,
    getStore: function () { return store; },
    waLink: waLink,
    iconX: iconX,
    iconTrash: iconTrash,
    iconTruck: iconTruck,
    scheduleTimeOptions: scheduleTimeOptions,
    scheduleDefault: scheduleDefault,
    scheduleToText: scheduleToText,
    scheduleFormHtml: scheduleFormHtml,
    collectSchedule: collectSchedule,
    WEEK_DAYS: WEEK_DAYS
  };

  document.getElementById('year').textContent = new Date().getFullYear();
  loadStore();

  // ---------------- Остатки по филиалам (store-stock.json + списания Worker) ----------------

  var baseStock = {};
  var baseStockUpdated = '';
  var baseStockLoaded = null;

  function loadBaseStock() {
    if (baseStockLoaded) return baseStockLoaded;
    // Эффективные остатки (база − продажи − активные брони) с Worker;
    // при недоступности API (офлайн-разработка) — статический файл.
    baseStockLoaded = fetch('/api/stock', { cache: 'default' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.stock) {
          baseStock = d.stock;
          baseStockUpdated = (d && d.updated) || '';
          return;
        }
        throw new Error('no stock');
      })
      .catch(function () {
        return fetch('data/store-stock.json')
          .then(function (r) { return r.json(); })
          .then(function (d) {
            baseStock = (d && d.stock) || {};
            baseStockUpdated = (d && d.updated) || '';
          })
          .catch(function () {
            baseStock = {};
            baseStockUpdated = '';
          });
      });
    return baseStockLoaded;
  }

  // Принудительная перезагрузка остатков (после сохранения правок в KV)
  function reloadBaseStock() {
    baseStockLoaded = null;
    baseStock = {};
    return loadBaseStock();
  }

  function storeStockData(storeId) {
    var fromBase = baseStock[storeId] && Object.keys(baseStock[storeId]).length;
    return !!fromBase;
  }

  function stockText(storeId, productId) {
    if (baseStock[storeId] && baseStock[storeId][productId] !== undefined) return baseStock[storeId][productId];
    return undefined;
  }

  // Скрытие товара в конкретном СЦ (оверрайд суперадмина из /data/products.json)
  function scHidden(storeId, productId) {
    try {
      var m = window.__scOverrides || {};
      return !!(m[storeId] && m[storeId][productId] && m[storeId][productId].hidden);
    } catch (e) { return false; }
  }

  function isAvailableInStore(p, storeId) {
    // Скрытые суперадмином товары в этом СЦ недоступны для заказа
    if (scHidden(storeId, p && p.id)) return false;
    // Если у филиала нет данных об остатках — товаров в нём нет
    if (!storeStockData(storeId)) return false;
    var t = stockText(storeId, p && p.id);
    if (t === undefined || t === null || String(t).trim() === '') return false;
    t = String(t);
    return t.indexOf('Нет') !== 0 && t.indexOf('Ожидается') === -1;
  }

  // Число из «В наличии (26 шт)» → 26; «Нет…» → 0; «Ожидается…»/без числа → null (лимита нет)
  function stockCount(storeId, productId) {
    var t = stockText(storeId, productId);
    if (t === undefined || t === null) return null;
    t = String(t).trim();
    if (t === '' || t.indexOf('Ожидается') !== -1) return null;
    if (t.indexOf('Нет') === 0) return 0;
    var m = t.match(/(\d+)\s*шт/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Сумма эффективных остатков по всем СЦ (для каталога без выбранного филиала):
  // «Нет в наличии» = 0, «Ожидается»/нет данных — пропускаем;
  // данных нет ни у одного СЦ → null (каталог покажет статичное p.quantity)
  function totalCount(productId) {
    var sum = 0;
    var any = false;
    Object.keys(baseStock || {}).forEach(function (sid) {
      var c = stockCount(sid, productId);
      if (c !== null) { sum += c; any = true; }
    });
    return any ? sum : null;
  }

  window.StoreStock = {
    load: loadBaseStock,
    reload: reloadBaseStock,
    hasData: storeStockData,
    text: stockText,
    count: stockCount,
    totalCount: totalCount,
    available: isAvailableInStore,
    updated: function () { return baseStockUpdated; }
  };
})();
