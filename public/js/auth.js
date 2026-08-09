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

  // Вход проверяется на сервере (Cloudflare Worker): креды живут только в секрете STORE_CREDS
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
        return { id: data.store.id, login: l, name: data.store.name, role: data.store.role };
      }
      return null;
    }).catch(function () {
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
