(function () {
  'use strict';

  var SESSION_KEY = 'greenleaf_sc_logged_user_v1';
  var CUSTOM_STORES_KEY = 'greenleaf_sc_custom_stores_v1';

  // Захардкоженные учётки: суперадмин + резервные демо-СЦ (работают даже без интернета/JSON)
  var USERS = {
    'admin': { id: 'superadmin', pass: 'Snikers23@', name: 'Суперадминистратор', role: 'superadmin' },
    's240534': { id: 'sc-almaty', pass: '***REMOVED***@', name: 'СЦ Greenleaf Алматы', role: 'sc' },
    'almaty': { id: 'sc-almaty', pass: '123456', name: 'СЦ Greenleaf Алматы', role: 'sc' },
    'astana': { id: 'sc-astana', pass: '123456', name: 'СЦ Greenleaf Астана', role: 'sc' },
    'shymkent': { id: 'sc-shymkent', pass: '123456', name: 'СЦ Greenleaf Шымкент', role: 'sc' },
    'karaganda': { id: 'sc-karaganda', pass: '123456', name: 'СЦ Greenleaf Караганда', role: 'sc' }
  };

  function getCurrentUser() {
    try {
      var s = localStorage.getItem(SESSION_KEY);
      if (s) return JSON.parse(s);
    } catch (e) { }
    return null;
  }

  function setCurrentUser(user) {
    if (user) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
    updateAuthBtn();
  }

  // Все СЦ-аккаунты: из data/stores.json + локальные оверрайды (добавленные суперадмином филиалы)
  function getStoreAccounts() {
    return fetch('data/stores.json?t=' + Date.now())
      .then(function (r) { return r.json(); })
      .catch(function () { return []; })
      .then(function (list) {
        var accounts = {};
        if (Array.isArray(list)) {
          list.forEach(function (s) {
            if (s.login) {
              accounts[String(s.login).toLowerCase()] = {
                id: s.id, login: s.login, pass: s.password || '',
                name: s.name || 'СЦ Greenleaf', role: 'sc'
              };
            }
          });
        }
        try {
          var saved = JSON.parse(localStorage.getItem(CUSTOM_STORES_KEY) || '{}');
          Object.keys(saved).forEach(function (id) {
            var s = saved[id];
            if (s && s.login) {
              accounts[String(s.login).toLowerCase()] = {
                id: id, login: s.login, pass: s.password || '',
                name: s.name || 'СЦ Greenleaf', role: 'sc'
              };
            }
          });
        } catch (e) { }
        return accounts;
      });
  }

  // Вход: сначала захардкоженные, затем динамические СЦ из stores.json
  function login(login, pass) {
    var l = String(login || '').trim().toLowerCase();
    var p = String(pass || '');
    var u = USERS[l];
    if (u && u.pass === p) {
      return Promise.resolve({
        id: u.id, login: l, name: u.name, role: u.role
      });
    }
    return getStoreAccounts().then(function (accounts) {
      var a = accounts[l];
      if (a && a.pass === p) {
        return { id: a.id, login: l, name: a.name, role: a.role };
      }
      return null;
    });
  }

  function isSuperadmin() {
    var u = getCurrentUser();
    return !!(u && u.role === 'superadmin');
  }

  function updateAuthBtn() {
    var btn = document.getElementById('scAuthBtn');
    if (!btn) return;
    var user = getCurrentUser();
    if (user) {
      btn.innerHTML = '🟢 ' + Utils.esc(user.name);
      btn.classList.remove('btn-outline');
      btn.classList.add('btn-primary');
    } else {
      btn.innerHTML = 'Войти';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-outline');
    }
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('#scAuthBtn');
    if (!btn) return;
    window.location.href = 'cabinet.html';
  });

  window.Auth = {
    USERS: USERS,
    getCurrentUser: getCurrentUser,
    setCurrentUser: setCurrentUser,
    login: login,
    isSuperadmin: isSuperadmin,
    updateAuthBtn: updateAuthBtn
  };

  document.addEventListener('DOMContentLoaded', updateAuthBtn);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    updateAuthBtn();
  }
})();
