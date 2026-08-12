(function () {
  'use strict';

  var SESSION_KEY = 'greenleaf_sc_logged_user_v1';

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

  // Вход проверяется на сервере (Cloudflare Worker): креды живут только в секрете STORE_CREDS / KV
  function login(login, pass) {
    var l = String(login || '').trim().toLowerCase();
    var p = String(pass || '');
    return fetch('/api/auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: l, password: p })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (data) {
      if (data && data.ok && data.store) {
        return {
          id: data.store.id,
          login: l,
          name: data.store.name,
          role: data.store.role,
          email: data.store.email || '',
          phone: data.store.phone || '',
          token: data.token || ''
        };
      }
      return null;
    }).catch(function () {
      return null;
    });
  }

  function getToken() {
    var u = getCurrentUser();
    return (u && u.token) || '';
  }

  // API-запрос к Worker от имени авторизованного пользователя (токен в заголовке)
  function api(path, options) {
    var opts = options || {};
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var token = getToken();
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; });
    });
  }

  function isSuperadmin() {
    var u = getCurrentUser();
    return !!(u && u.role === 'superadmin');
  }

  function updateAuthBtn() {
    var buttons = document.querySelectorAll('.sc-auth-btn');
    if (!buttons.length) return;
    var user = getCurrentUser();
    buttons.forEach(function (btn) {
      if (user) {
        btn.innerHTML = '🟢 ' + Utils.esc(user.name);
        btn.classList.remove('btn-outline');
        btn.classList.add('btn-primary');
      } else {
        btn.innerHTML = 'Войти';
        btn.classList.remove('btn-primary');
        btn.classList.add('btn-outline');
      }
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest('.sc-auth-btn');
    if (!btn) return;
    window.location.href = 'cabinet.html';
  });

  window.Auth = {
    getCurrentUser: getCurrentUser,
    setCurrentUser: setCurrentUser,
    login: login,
    isSuperadmin: isSuperadmin,
    updateAuthBtn: updateAuthBtn,
    getToken: getToken,
    api: api
  };

  document.addEventListener('DOMContentLoaded', updateAuthBtn);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    updateAuthBtn();
  }
})();
