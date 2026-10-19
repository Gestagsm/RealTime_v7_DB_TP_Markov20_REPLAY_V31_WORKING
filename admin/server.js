'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ASSET_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'itr_admin_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 8;
const MAX_BODY_BYTES = 16 * 1024;
const MIN_PASSWORD = 6;
const USERNAME_PATTERN = /^[a-zA-Z0-9._@+-]{3,64}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const DEFAULT_SETTINGS = {
  ai: { provider: 'none', model: '', apiKey: '' },
  broker: { provider: 'none', environment: 'demo', accountId: '', apiKey: '', accessToken: '' }
};
const AI_PROVIDERS = new Set(['none', 'openai', 'anthropic', 'google']);
const BROKER_PROVIDERS = new Set(['none', 'oanda', 'interactive-brokers', 'metatrader5']);

function validateOptions(options) {
  if (!options.username || !options.password) throw new Error('ADMIN_USERNAME and ADMIN_PASSWORD must be configured before starting the admin service.');
  if (options.password.length < MIN_PASSWORD) throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD} characters long.`);
  if (typeof options.dataSource !== 'function') throw new Error('A platform status data source is required.');
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('ADMIN_PORT must be a valid TCP port.');
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(options.host);
  if (!loopback && !options.cookieSecure) {
    throw new Error('Remote admin binding requires ADMIN_COOKIE_SECURE=1 behind a trusted HTTPS proxy.');
  }
}

function safeEqual(left, right) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(left)).digest(),
    crypto.createHash('sha256').update(String(right)).digest()
  );
}

function passwordKey(password, salt) {
  return crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

function sealSettings(settings, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(settings), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

function openSettings(envelope, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]).toString('utf8'));
}

function publicSettings(settings) {
  return {
    ai: { provider: settings.ai.provider, model: settings.ai.model, hasApiKey: Boolean(settings.ai.apiKey) },
    broker: {
      provider: settings.broker.provider, environment: settings.broker.environment,
      accountId: settings.broker.accountId,
      hasApiKey: Boolean(settings.broker.apiKey), hasAccessToken: Boolean(settings.broker.accessToken)
    },
    integrationsActive: false
  };
}

function validateSettings(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Settings must be an object.');
  const ai = body.ai, broker = body.broker;
  if (!ai || typeof ai !== 'object' || !AI_PROVIDERS.has(ai.provider)) throw new Error('Choose a supported AI provider.');
  if (!broker || typeof broker !== 'object' || !BROKER_PROVIDERS.has(broker.provider)) throw new Error('Choose a supported broker provider.');
  if (!['demo', 'live'].includes(broker.environment)) throw new Error('Broker environment must be demo or live.');
  const text = (value, field, max) => {
    if (typeof value !== 'string' || value.length > max) throw new Error(`${field} must be text no longer than ${max} characters.`);
    return value.trim();
  };
  const secret = (value, field, oldValue, clear) => {
    if (clear) return '';
    if (value === undefined || value === '') return oldValue;
    return text(value, field, 4096);
  };
  const sameAiProvider = ai.provider === previous.ai.provider;
  const sameBrokerProvider = broker.provider === previous.broker.provider;
  return {
    ai: {
      provider: ai.provider,
      model: text(ai.model || '', 'AI model', 120),
      apiKey: secret(ai.apiKey, 'AI API key', sameAiProvider ? previous.ai.apiKey : '', ai.clearApiKey)
    },
    broker: {
      provider: broker.provider,
      environment: broker.environment,
      accountId: text(broker.accountId || '', 'Broker account ID', 160),
      apiKey: secret(broker.apiKey, 'Broker API key', sameBrokerProvider ? previous.broker.apiKey : '', broker.clearApiKey),
      accessToken: secret(broker.accessToken, 'Broker access token', sameBrokerProvider ? previous.broker.accessToken : '', broker.clearAccessToken)
    }
  };
}

function cookieValue(request) {
  const cookie = request.headers.cookie || '';
  for (const field of cookie.split(';')) {
    const separator = field.indexOf('=');
    if (separator < 0 || field.slice(0, separator).trim() !== SESSION_COOKIE) continue;
    return field.slice(separator + 1).trim();
  }
  return '';
}

function createAdminServer(options) {
  validateOptions(options);
  const secret = crypto.randomBytes(32);
  const sessions = new Map();
  const loginAttempts = new Map();
  const dataDir = options.dataDir || path.join(__dirname, '.data');
  const dataFile = path.join(dataDir, 'admin-state.json');
  fs.mkdirSync(dataDir, { recursive: true });
  let state;
  const platform = options.platform || null;
  const audit = (user, action, detail) => { if (platform) platform.audit(user, action, detail) };
  function persist(nextState) {
    const temporary = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(nextState), { mode: 0o600 });
    fs.renameSync(temporary, dataFile);
    state = nextState;
  }

  if (fs.existsSync(dataFile)) {
    state = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    if (state.version !== 1 || !state.auth || !state.encryptedSettings) throw new Error('Admin state file is invalid; refusing to start with missing authentication or settings data.');
  } else {
    const salt = crypto.randomBytes(16);
    const key = passwordKey(options.password, salt);
    persist({
      version: 1,
      auth: { username: options.username, salt: salt.toString('base64'), verifier: key.subarray(0, 32).toString('base64') },
      encryptedSettings: sealSettings(DEFAULT_SETTINGS, key.subarray(32))
    });
  }

  const sign = payload => crypto.createHmac('sha256', secret).update(payload).digest('base64url');

  function sessionFor(request) {
    const token = cookieValue(request);
    const separator = token.lastIndexOf('.');
    if (separator < 1) return null;
    const payload = token.slice(0, separator), signature = token.slice(separator + 1);
    if (!safeEqual(signature, sign(payload))) return null;
    const session = sessions.get(payload);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(payload);
      return null;
    }
    return { payload, ...session };
  }

  function sendJson(response, status, data, headers = {}) {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(JSON.stringify(data));
  }

  const cookieHeader = (value, maxAge) =>
    `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${options.cookieSecure ? '; Secure' : ''}`;

  function startSession(username, key) {
    const payload = `${Date.now()}.${crypto.randomBytes(24).toString('base64url')}`;
    sessions.set(payload, { username, expiresAt: Date.now() + SESSION_TTL_MS, key });
    return cookieHeader(`${payload}.${sign(payload)}`, Math.floor(SESSION_TTL_MS / 1000));
  }

  function originMatches(request) {
    const origin = request.headers.origin;
    if (!origin || !request.headers.host) return false;
    try {
      const parsed = new URL(origin);
      return parsed.host.toLowerCase() === request.headers.host.toLowerCase()
        && (parsed.protocol === 'http:' || parsed.protocol === 'https:');
    } catch {
      return false;
    }
  }

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let body = '';
      request.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
          reject(new Error('Request body is too large.'));
          request.destroy();
        }
      });
      request.on('end', () => {
        if (!body) return resolve({});
        try { resolve(JSON.parse(body)) }
        catch { reject(new Error('Request must contain valid JSON.')) }
      });
      request.on('error', reject);
    });
  }

  function allowLogin(address) {
    const now = Date.now();
    const attempts = (loginAttempts.get(address) || []).filter(at => now - at < LOGIN_WINDOW_MS);
    loginAttempts.set(address, attempts);
    return attempts.length < LOGIN_MAX_ATTEMPTS;
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");

    const url = new URL(request.url, 'http://localhost');
    if (request.method === 'GET' && url.pathname === '/healthz') return sendJson(response, 200, { service: 'itr-orderflow-admin' });
    if (request.method === 'GET' && url.pathname === '/') {
      response.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store' });
      return fs.createReadStream(path.join(ASSET_DIR, 'index.html')).pipe(response);
    }
    if (request.method === 'GET' && ['/admin.css', '/admin.js'].includes(url.pathname)) {
      const asset = path.join(ASSET_DIR, path.basename(url.pathname));
      response.writeHead(200, { 'Content-Type': MIME[path.extname(asset)], 'Cache-Control': 'no-cache' });
      return fs.createReadStream(asset).pipe(response);
    }

    const address = request.socket.remoteAddress || 'unknown';
    if (request.method === 'POST') {
      if (!originMatches(request)) return sendJson(response, 403, { error: 'Request origin was not accepted.' });
      if ((request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        return sendJson(response, 415, { error: 'Content-Type must be application/json.' });
      }
      let body;
      try { body = await readJson(request) }
      catch (error) { return sendJson(response, 400, { error: error.message }) }

      if (url.pathname === '/api/login') {
        if (!allowLogin(address)) return sendJson(response, 429, { error: 'Too many sign-in attempts. Wait 15 minutes and try again.' });
        loginAttempts.get(address).push(Date.now());
        const candidate = passwordKey(String(body.password || ''), Buffer.from(state.auth.salt, 'base64'));
        const valid = safeEqual(String(body.username || '').trim().toLowerCase(), state.auth.username.toLowerCase())
          && safeEqual(candidate.subarray(0, 32).toString('base64'), state.auth.verifier);
        if (!valid) { audit(String(body.username || '').slice(0, 64), 'login.failed', address); return sendJson(response, 401, { error: 'Username or password is incorrect.' }) }
        loginAttempts.delete(address);
        audit(state.auth.username, 'login', address);
        return sendJson(response, 200, { username: state.auth.username }, { 'Set-Cookie': startSession(state.auth.username, candidate.subarray(32)) });
      }

      const session = sessionFor(request);
      if (!session) return sendJson(response, 401, { error: 'Administrator sign-in is required.' }, { 'Set-Cookie': cookieHeader('', 0) });
      if (url.pathname === '/api/logout') {
        audit(session.username, 'logout');
        sessions.delete(session.payload);
        return sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0) });
      }
      if (url.pathname === '/api/profile') {
        if (typeof body.currentPassword !== 'string') return sendJson(response, 400, { error: 'Enter your current password.' });
        const oldKey = passwordKey(body.currentPassword, Buffer.from(state.auth.salt, 'base64'));
        if (!safeEqual(oldKey.subarray(0, 32).toString('base64'), state.auth.verifier)) {
          return sendJson(response, 401, { error: 'Current password is incorrect.' });
        }
        const username = body.username === undefined ? state.auth.username : String(body.username).trim();
        if (!USERNAME_PATTERN.test(username)) return sendJson(response, 400, { error: 'Username or email must be 3-64 characters (letters, numbers and . _ @ + -).' });
        const newPassword = body.newPassword || body.currentPassword;
        if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD || newPassword.length > 256) {
          return sendJson(response, 400, { error: `New password must be at least ${MIN_PASSWORD} characters and no longer than 256.` });
        }
        let existingSettings;
        try { existingSettings = openSettings(state.encryptedSettings, oldKey.subarray(32)) }
        catch (error) { return sendJson(response, 500, { error: `Could not decrypt saved settings: ${error.message}` }) }
        const salt = crypto.randomBytes(16);
        const newKey = passwordKey(newPassword, salt);
        try {
          persist({
            ...state,
            auth: { username, salt: salt.toString('base64'), verifier: newKey.subarray(0, 32).toString('base64') },
            encryptedSettings: sealSettings(existingSettings, newKey.subarray(32))
          });
        } catch (error) {
          return sendJson(response, 500, { error: `Could not securely save profile: ${error.message}` });
        }
        sessions.clear();
        audit(username, 'profile.updated', body.newPassword ? 'password changed' : 'username/profile');
        return sendJson(response, 200, { username }, { 'Set-Cookie': startSession(username, newKey.subarray(32)) });
      }
      if (url.pathname === '/api/settings') {
        let previous;
        try { previous = openSettings(state.encryptedSettings, session.key) }
        catch (error) { return sendJson(response, 500, { error: `Could not decrypt integration settings: ${error.message}` }) }
        let next;
        try { next = validateSettings(body, previous) }
        catch (error) { return sendJson(response, 400, { error: error.message }) }
        try {
          persist({ ...state, encryptedSettings: sealSettings(next, session.key) });
          audit(session.username, 'api-settings.updated', `ai=${next.ai.provider} broker=${next.broker.provider}`);
          return sendJson(response, 200, publicSettings(next));
        } catch (error) {
          return sendJson(response, 500, { error: `Could not save integration settings: ${error.message}` });
        }
      }
      if (url.pathname === '/api/sessions/revoke-others') {
        let revoked = 0;
        for (const key of [...sessions.keys()]) if (key !== session.payload) { sessions.delete(key); revoked++ }
        audit(session.username, 'sessions.revoked', `${revoked} other session(s)`);
        return sendJson(response, 200, { revoked });
      }
      if (platform && url.pathname.startsWith('/api/')) {
        try {
          if (url.pathname === '/api/config/restore') {
            const config = platform.restoreConfig();
            audit(session.username, 'config.restored');
            return sendJson(response, 200, config);
          }
          if (url.pathname === '/api/backups/create') {
            const job = platform.startBackup(String(body.scope));
            audit(session.username, 'backup.started', `${job.scope} -> ${job.name}`);
            return sendJson(response, 202, job);
          }
          if (url.pathname === '/api/backups/restore') {
            audit(session.username, 'backup.restore.requested', String(body.name));
            const job = await platform.startRestore(String(body.name));
            audit(session.username, 'backup.restore.started', `${job.name} status=${job.status}`);
            return sendJson(response, 202, job);
          }
          if (url.pathname === '/api/backups/delete') {
            platform.deleteBackup(String(body.name));
            audit(session.username, 'backup.deleted', String(body.name));
            return sendJson(response, 200, { ok: true });
          }
          if (url.pathname === '/api/watcher/retry') {
            await platform.retryFailed(body.name);
            audit(session.username, 'watcher.retry', String(body.name));
            return sendJson(response, 200, { ok: true });
          }
          if (url.pathname === '/api/database/analyze') {
            const result = await platform.analyzeTable(String(body.table));
            audit(session.username, 'database.analyze', result.table);
            return sendJson(response, 200, result);
          }
          if (url.pathname === '/api/backend') {
            const action = body.action;
            if (!['start', 'stop', 'restart'].includes(action)) return sendJson(response, 400, { error: 'Unknown backend action.' });
            audit(session.username, `backend.${action}`);
            if (action !== 'start') {
              try { await platform.stopBackend() } catch (error) { if (action === 'stop') throw error }
            }
            if (action !== 'stop') await platform.startBackend();
            return sendJson(response, 200, await platform.backendState());
          }
          if (url.pathname === '/api/config') {
            const config = platform.saveConfig(body.values);
            audit(session.username, 'config.updated', Object.keys(body.values).join(','));
            return sendJson(response, 200, config);
          }
          if (url.pathname === '/api/imports/delete') {
            const removed = await platform.deleteImport(String(body.section), body.id);
            audit(session.username, 'import.deleted', `${body.section}#${body.id} removed=${removed}`);
            return sendJson(response, removed ? 200 : 404, removed ? { ok: true } : { error: 'Import was not found.' });
          }
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }
      }
      return sendJson(response, 404, { error: 'Admin API route not found.' });
    }

    if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET, POST' });
    const session = sessionFor(request);
    if (!url.pathname.startsWith('/api/')) return sendJson(response, 404, { error: 'Not found.' });
    if (!session) return sendJson(response, 401, { error: 'Sign-in required.' });
    if (url.pathname === '/api/session') return sendJson(response, 200, { username: session.username, expiresAt: session.expiresAt });
    if (url.pathname === '/api/profile') return sendJson(response, 200, { username: session.username });
    if (url.pathname === '/api/settings') {
      try { return sendJson(response, 200, publicSettings(openSettings(state.encryptedSettings, session.key))) }
      catch (error) { return sendJson(response, 500, { error: `Could not decrypt integration settings: ${error.message}` }) }
    }
    if (url.pathname === '/api/status') {
      try { return sendJson(response, 200, await options.dataSource()) }
      catch (error) { return sendJson(response, 502, { error: `Platform status unavailable: ${error.message}` }) }
    }
    if (url.pathname === '/api/sessions') {
      return sendJson(response, 200, {
        timeoutMinutes: SESSION_TTL_MS / 60000,
        sessions: [...sessions.entries()].filter(([, item]) => item.expiresAt > Date.now()).map(([key, item]) => ({
          id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), username: item.username,
          startedAt: new Date(Number(key.split('.')[0])).toISOString(), expiresAt: new Date(item.expiresAt).toISOString(), current: key === session.payload
        }))
      });
    }
    if (platform) {
      try {
        if (url.pathname === '/api/health-check') return sendJson(response, 200, await platform.healthCheck());
        if (url.pathname === '/api/backups') return sendJson(response, 200, platform.listBackups());
        if (url.pathname === '/api/backups/download') {
          const name = url.searchParams.get('name');
          let file;
          try { file = platform.backupPath(name) } catch (error) { return sendJson(response, 400, { error: error.message }) }
          audit(session.username, 'backup.downloaded', name);
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size,
            'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store'
          });
          return fs.createReadStream(file).pipe(response);
        }
        if (url.pathname === '/api/watcher') return sendJson(response, 200, await platform.watcherOverview());
        if (url.pathname === '/api/database/activity') return sendJson(response, 200, { connections: await platform.dbActivity() });
        if (url.pathname === '/api/audit.csv') {
          const cell = value => {
            const text = String(value ?? '');
            return `"${(/^[=+\-@\t\r]/.test(text) ? `'${text}` : text).replace(/"/g, '""')}"`;
          };
          const rows = [['time', 'user', 'action', 'detail'], ...platform.readAudit(5000).map(item => [item.at, item.user, item.action, item.detail])];
          response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="admin-activity.csv"', 'Cache-Control': 'no-store' });
          return response.end(rows.map(row => row.map(cell).join(',')).join('\r\n'));
        }
        if (url.pathname === '/api/system') return sendJson(response, 200, {
          backend: await platform.backendState(), config: platform.getConfig(),
          admin: { node: process.version, pid: process.pid, uptimeSec: Math.round(process.uptime()), platform: process.platform, root: ROOT, port: options.port }
        });
        if (url.pathname === '/api/backend/log') return sendJson(response, 200, { log: platform.backendLog() });
        if (url.pathname === '/api/audit') return sendJson(response, 200, { events: platform.readAudit() });
        if (url.pathname === '/api/database') return sendJson(response, 200, await platform.databaseOverview());
        if (url.pathname === '/api/imports') {
          const section = url.searchParams.get('section') || '';
          return sendJson(response, 200, { sections: platform.sections, imports: await platform.listImports(section, url.searchParams.get('limit')) });
        }
      } catch (error) {
        return sendJson(response, 502, { error: error.message });
      }
    }
    return sendJson(response, 404, { error: 'Not found.' });
  });

  return server;
}

function createPlatformStatusSource({ backendUrl, watchDir, watchNames, database, fetchImpl = fetch, statsTimeoutMs = 300000, statsRefreshMs = 300000 }) {
  const withTimeout = (promise, ms, label) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms) })
    ]).finally(() => clearTimeout(timer));
  };

  const resolve = value => (typeof value === 'function' ? value() : value);

  async function backend() {
    try {
      const response = await withTimeout(fetchImpl(new URL('/api/health', resolve(backendUrl)), { cache: 'no-store' }), 4000, 'Backend health check');
      const data = await response.json();
      return { up: response.ok && data.api === 'up', postgres: data.postgres || 'unknown', timescale: Boolean(data.timescale), port: data.port, error: '' };
    } catch (error) {
      return { up: false, postgres: 'unknown', timescale: false, port: null, error: error.message };
    }
  }

  // Full-table counts take tens of seconds on a large tick table, so they are
  // computed in the background and served from a cache.
  const stats = { rows: null, computedAt: null, error: '', running: null };

  function refreshStats() {
    if (stats.running) return stats.running;
    stats.running = withTimeout(database.pool.query(`
      SELECT dataset, symbol, COUNT(*)::bigint AS rows, MIN(event_time) AS first, MAX(event_time) AS last
      FROM public.itr_market_ticks GROUP BY dataset, symbol ORDER BY dataset, symbol`), statsTimeoutMs, 'Dataset statistics query')
      .then(result => {
        stats.rows = result.rows.map(row => ({ dataset: row.dataset, symbol: row.symbol, rows: Number(row.rows), first: row.first, last: row.last }));
        stats.computedAt = new Date().toISOString();
        stats.error = '';
      })
      .catch(error => { stats.error = error.message })
      .finally(() => { stats.running = null });
    return stats.running;
  }

  async function postgres() {
    try {
      const run = sql => withTimeout(database.pool.query(sql), 8000, 'PostgreSQL query');
      const info = await run(`SELECT current_database() AS name,
        EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS timescale,
        to_regclass('public.itr_market_ticks') IS NOT NULL AS has_ticks,
        to_regclass('replay_v31.replay_imports') IS NOT NULL AS has_imports`);
      const meta = info.rows[0];
      if (meta.has_ticks && (!stats.computedAt || Date.now() - Date.parse(stats.computedAt) > statsRefreshMs)) refreshStats();
      const imports = meta.has_imports ? (await run(`
        SELECT id, section, filename, imported_at, row_count, source
        FROM replay_v31.replay_imports ORDER BY imported_at DESC LIMIT 10`)).rows : [];
      return {
        database: { connected: true, name: meta.name, timescale: meta.timescale, hasTicks: meta.has_ticks, error: '' },
        datasets: stats.rows || [],
        datasetStats: { computedAt: stats.computedAt, calculating: Boolean(stats.running), error: stats.error },
        imports: imports.map(row => ({ id: String(row.id), section: row.section, filename: row.filename, importedAt: row.imported_at, rowCount: row.row_count, source: row.source }))
      };
    } catch (error) {
      return {
        database: { connected: false, name: '', timescale: false, hasTicks: false, error: error.message },
        datasets: [], datasetStats: { computedAt: null, calculating: false, error: '' }, imports: []
      };
    }
  }

  async function watcher() {
    const watchDirectory = resolve(watchDir);
    if (!watchDirectory) return { configured: false };
    const count = async name => {
      try { return (await fs.promises.readdir(path.join(watchDirectory, name))).length }
      catch { return 0 }
    };
    const names = resolve(watchNames) || { processed: process.env.WATCH_PROCESSED_DIRNAME || '_processed', failed: process.env.WATCH_FAILED_DIRNAME || '_failed' };
    try {
      const entries = await fs.promises.readdir(watchDirectory, { withFileTypes: true });
      return {
        configured: true, dir: watchDirectory, exists: true,
        pending: entries.filter(entry => entry.isFile()).length,
        processed: await count(names.processed),
        failed: await count(names.failed)
      };
    } catch (error) {
      return { configured: true, dir: watchDirectory, exists: false, error: error.code || error.message };
    }
  }

  async function status() {
    const [backendStatus, db, watch] = await Promise.all([backend(), postgres(), watcher()]);
    return { checkedAt: new Date().toISOString(), backend: backendStatus, watcher: watch, ...db };
  }
  status.waitForStats = () => stats.running || Promise.resolve();
  return status;
}

if (require.main === module) {
  const { createRequire } = require('module');
  const backendRequire = createRequire(path.join(ROOT, 'backend', 'package.json'));
  const dotenv = backendRequire('dotenv');
  dotenv.config({ path: path.join(__dirname, '.env') });
  dotenv.config({ path: path.join(ROOT, 'backend', '.env') });
  const database = backendRequire('./lib/postgres');
  const { createPlatformControl } = require('./platform');
  const platform = createPlatformControl({ rootDir: ROOT, dataDir: path.join(__dirname, '.data'), database });
  const port = +(process.env.ADMIN_PORT || 4300);
  const host = process.env.ADMIN_HOST || '127.0.0.1';
  const options = {
    username: process.env.ADMIN_USERNAME || '',
    password: process.env.ADMIN_PASSWORD || '',
    dataSource: createPlatformStatusSource({ backendUrl: platform.backendUrl, watchDir: platform.watchDir, watchNames: platform.watchNames, database }),
    platform,
    port,
    host,
    cookieSecure: process.env.ADMIN_COOKIE_SECURE === '1'
  };
  try {
    const server = createAdminServer(options);
    server.listen(port, host, () => {
      console.log(`ITR Order Flow admin portal listening at ${options.cookieSecure ? 'https' : 'http'}://${host}:${port}`);
    });
    server.on('error', error => {
      console.error(`Admin service failed to listen: ${error.message}`);
      process.exitCode = 1;
    });
  } catch (error) {
    console.error(`Admin service configuration error: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { createAdminServer, createPlatformStatusSource, validateOptions };
