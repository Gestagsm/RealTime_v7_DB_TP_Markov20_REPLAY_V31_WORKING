'use strict';

const crypto = require('crypto');

function safeEqual(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createApiAuth({ username = process.env.API_USERNAME, password = process.env.API_PASSWORD } = {}) {
  return function requireApiAuth(req, res, next) {
    if (!username || !password) {
      return res.status(503).json({ error: 'API authentication is not configured' });
    }

    const header = String(req.headers.authorization || '');
    const match = /^Basic\s+([A-Za-z0-9+/=]+)$/i.exec(header);
    if (!match) return unauthorized(res);

    let supplied;
    try {
      supplied = Buffer.from(match[1], 'base64').toString('utf8');
    } catch {
      return unauthorized(res);
    }
    const separator = supplied.indexOf(':');
    if (separator < 0) return unauthorized(res);

    const suppliedUsername = supplied.slice(0, separator);
    const suppliedPassword = supplied.slice(separator + 1);
    if (!safeEqual(suppliedUsername, username) || !safeEqual(suppliedPassword, password)) {
      return unauthorized(res);
    }
    next();
  };
}

function unauthorized(res) {
  res.set('WWW-Authenticate', 'Basic realm="RealTime API", charset="UTF-8"');
  return res.status(401).json({ error: 'API username or password is incorrect' });
}

module.exports = { createApiAuth };
