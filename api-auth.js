(function () {
  'use strict';

  if (window.__ITR_API_AUTH_V1__) return;
  window.__ITR_API_AUTH_V1__ = true;

  const nativeFetch = window.fetch.bind(window);
  const storageKey = 'itr_api_basic_credentials';
  const username = String(window.ITR_API_USERNAME || 'realtime-web');

  function apiOrigin() {
    const override = String(window.ITR_API_BASE_OVERRIDE || '').trim();
    if (override) return new URL(override, location.href).origin;
    if (location.protocol === 'file:') return 'http://127.0.0.1:4001';
    if (location.protocol === 'http:' && (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      return `http://${location.hostname}:4001`;
    }
    return location.origin;
  }

  function apiPathPrefix() {
    const override = String(window.ITR_API_BASE_OVERRIDE || '').trim();
    const basePath = override ? new URL(override, location.href).pathname.replace(/\/+$/, '') : '';
    return `${basePath}/api/`;
  }

  function isApiRequest(input) {
    try {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      return url.origin === apiOrigin() && url.pathname.startsWith(apiPathPrefix());
    } catch {
      return false;
    }
  }

  function readCredentials() {
    try {
      return sessionStorage.getItem(storageKey) || '';
    } catch {
      return '';
    }
  }

  function askForCredentials() {
    const password = window.prompt('Geli erayga sirta ee API-ga RealTime si database-ka loo furo.');
    if (!password) return '';
    const value = btoa(`${username}:${password}`);
    try {
      sessionStorage.setItem(storageKey, value);
    } catch {
      // Keep credentials in memory for this page when storage is unavailable.
    }
    return value;
  }

  async function request(input, init, credentials) {
    const original = input instanceof Request ? input.clone() : input;
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init && init.headers) new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    headers.set('Authorization', `Basic ${credentials}`);
    return nativeFetch(original, { ...init, headers });
  }

  window.fetch = async function (input, init) {
    if (!isApiRequest(input)) return nativeFetch(input, init);

    let credentials = readCredentials() || askForCredentials();
    if (!credentials) return nativeFetch(input, init);

    let response = await request(input, init, credentials);
    if (response.status !== 401) return response;

    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      // A new password can still be entered for this retry.
    }
    credentials = askForCredentials();
    if (!credentials) return response;
    response = await request(input, init, credentials);
    return response;
  };
})();
