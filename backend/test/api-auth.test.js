'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApiAuth } = require('../lib/apiAuth');

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('rejects requests when API credentials are not configured', () => {
  const res = response();
  let continued = false;
  createApiAuth({ username: '', password: '' })({ headers: {} }, res, () => { continued = true; });
  assert.equal(res.statusCode, 503);
  assert.equal(continued, false);
});

test('requires HTTP Basic authentication', () => {
  const res = response();
  let continued = false;
  createApiAuth({ username: 'site-user', password: 'long-test-password' })(
    { headers: {} }, res, () => { continued = true; }
  );
  assert.equal(res.statusCode, 401);
  assert.equal(res.headers['WWW-Authenticate'].startsWith('Basic '), true);
  assert.equal(continued, false);
});

test('rejects incorrect credentials', () => {
  const authorization = `Basic ${Buffer.from('site-user:wrong-password').toString('base64')}`;
  const res = response();
  createApiAuth({ username: 'site-user', password: 'long-test-password' })(
    { headers: { authorization } }, res, () => assert.fail('Unauthorized request continued')
  );
  assert.equal(res.statusCode, 401);
});

test('accepts valid credentials', () => {
  const authorization = `Basic ${Buffer.from('site-user:long-test-password').toString('base64')}`;
  const res = response();
  let continued = false;
  createApiAuth({ username: 'site-user', password: 'long-test-password' })(
    { headers: { authorization } }, res, () => { continued = true; }
  );
  assert.equal(continued, true);
  assert.equal(res.statusCode, 200);
});
