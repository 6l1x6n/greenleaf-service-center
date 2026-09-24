(function () {
  'use strict';

  var SESSION_KEY = 'greenleaf_sc_logged_user_v1';
  var expiryTimer = null;

  function getCurrentUser() {
    try {
      var s = localStorage.getItem(SESSION_KEY);
      if (s) return JSON.parse(s);
    } catch (e) { }
    return null;
  }

  function tokenExpiry(user) {
    var parts = String((user && user.token) || '').split('.');
    var exp = Number(parts[2]);
    return isFinite(exp) && exp > 0 ? exp * 1000 : 0;
  }

  function scheduleExpiry(user) {
    if (expiryTimer) clearTimeout(expiryTimer);
    expiryTimer = null;
    var exp = tokenExpiry(user);
    if (!exp) return;
    var delay = Math.max(0, exp - Date.now() + 250);
    expiryTimer = setTimeout(function () {
      if (tokenExpiry(getCurrentUser()) <= Date.now()) {
        expireSession('expired');
      }
    }, Math.min(delay, 2147483647));
  }

  function setCurrentUser(user) {
    if (user) {
      localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    } else {
      localStorage.removeItem(SESSION_KEY);
    }
    scheduleExpiry(user);
    updateAuthBtn();
    document.dispatchEvent(new CustomEvent('auth:changed', { detail: { user: user || null } }));
  }

  function expireSession(reason) {
    if (!getCurrentUser()) return;
    setCurrentUser(null);
    document.dispatchEvent(new CustomEvent('auth:expired', { detail: { reason: reason || 'expired' } }));
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
          token: data.token || '',
          expiresAt: data.expiresAt || 0
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

  function api(path, options) {
    var opts = Object.assign({}, options || {});
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    var token = getToken();
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (r.status === 401 || (r.status === 403 && data && data.error === 'unauthorized')) {
          var current = getCurrentUser();
          if (token && (!current || current.token === token)) expireSession(r.status === 401 ? 'unauthorized' : 'expired');
          var error = new Error((data && data.error) || 'Сессия истекла');
          error.status = r.status;
          error.code = (data && data.error) || 'unauthorized';
          error.body = data;
          throw error;
        }
        if (r.status >= 500) {
          var serverError = new Error((data && data.error) || 'Ошибка сервера');
          serverError.status = r.status;
          serverError.body = data;
          throw serverError;
        }
        return data;
      });
    });
  }

  function revalidate() {
    var user = getCurrentUser();
    if (!user || !user.token) return Promise.resolve(null);
    if (tokenExpiry(user) && tokenExpiry(user) <= Date.now()) {
      expireSession('expired');
      return Promise.resolve(null);
    }
    return api('/api/auth/session').then(function (data) {
      if (!data || !data.ok || !data.user) return null;
      return data.user;
    }).catch(function (err) {
      if (err && (err.status === 401 || err.code === 'unauthorized')) return null;
      return false;
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
        // Имя оборачиваем в span — кнопка ужимается с многоточием (text-overflow)
        btn.innerHTML = '<span class="sc-auth-name">🟢 ' + Utils.esc(user.name) + '</span>';
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
    api: api,
    revalidate: revalidate,
    expireSession: expireSession,
    tokenExpiry: tokenExpiry
  };

  document.addEventListener('DOMContentLoaded', updateAuthBtn);
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    scheduleExpiry(getCurrentUser());
    updateAuthBtn();
  }
})();
