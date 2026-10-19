'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const CONFIG_FIELDS = {
  PORT: { label: 'Backend API port', hint: 'TCP port of the order flow backend (default 4001).', test: v => /^\d{1,5}$/.test(v) && +v >= 1 && +v <= 65535, required: true, fallback: '4001' },
  MARKET_SYMBOL: { label: 'Default market symbol', hint: 'Symbol used when imports do not carry one, e.g. XAUUSD.', test: v => /^[A-Za-z0-9._-]{1,20}$/.test(v), required: true, fallback: 'XAUUSD' },
  JSON_LIMIT: { label: 'Max request size', hint: 'Express JSON body limit, e.g. 100mb.', test: v => /^\d{1,4}(kb|mb)$/i.test(v), required: true, fallback: '100mb' },
  CORS_ORIGIN: { label: 'Allowed frontend origins', hint: 'Comma separated list of origins allowed to call the backend.', test: v => v.length <= 500 },
  WATCH_DIR: { label: 'Watch folder', hint: 'Drop folder for Excel exports. Empty disables the folder watcher.', test: v => v.length <= 300 && !/["<>|*?]/.test(v) },
  WATCH_POLL_MS: { label: 'Watcher poll interval (ms)', hint: 'How often the folder is checked (250-60000).', test: v => /^\d{3,5}$/.test(v) && +v >= 250 && +v <= 60000, required: true, fallback: '1000' },
  WATCH_GCV_PATTERN: { label: 'GCV file pattern', hint: 'Filename text that identifies GCV files.', test: v => /^[A-Za-z0-9_.-]{1,40}$/.test(v), required: true, fallback: 'GCV' },
  WATCH_TAQ_PATTERN: { label: 'TAQ file pattern', hint: 'Filename text that identifies TAQ files.', test: v => /^[A-Za-z0-9_.-]{1,40}$/.test(v), required: true, fallback: 'TAQ' },
  WATCH_TAS_PATTERN: { label: 'TAS file pattern', hint: 'Filename text that identifies TAS files.', test: v => /^[A-Za-z0-9_.-]{1,40}$/.test(v), required: true, fallback: 'TAS' },
  WATCH_PROCESSED_DIRNAME: { label: 'Processed subfolder', hint: 'Folder (inside the watch folder) for ingested files.', test: v => /^[A-Za-z0-9_.-]{1,60}$/.test(v), required: true, fallback: '_processed' },
  WATCH_FAILED_DIRNAME: { label: 'Failed subfolder', hint: 'Folder (inside the watch folder) for files that could not be ingested.', test: v => /^[A-Za-z0-9_.-]{1,60}$/.test(v), required: true, fallback: '_failed' }
};

function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (match) values[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return values;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(file, args) {
  return new Promise(resolve => {
    execFile(file, args, { windowsHide: true, timeout: 8000 }, (error, stdout) => resolve(error ? '' : String(stdout)));
  });
}

function createPlatformControl({ rootDir, dataDir, database, fetchImpl = fetch, spawnImpl = spawn }) {
  const backendDir = path.join(rootDir, 'backend');
  const envFile = path.join(backendDir, '.env');
  const pidFile = path.join(dataDir, 'backend.pid');
  const logFile = path.join(dataDir, 'backend.log');
  const auditFile = path.join(dataDir, 'audit.log');
  const backupFile = path.join(dataDir, 'backend.env.backup');
  fs.mkdirSync(dataDir, { recursive: true });

  const readEnv = () => { try { return parseEnv(fs.readFileSync(envFile, 'utf8')) } catch { return {} } };
  const backendPort = () => Number(readEnv().PORT || process.env.BACKEND_PORT || 4001);
  const backendUrl = () => process.env.ADMIN_BACKEND_URL || `http://127.0.0.1:${backendPort()}`;
  const watchDir = () => readEnv().WATCH_DIR || '';

  function audit(user, action, detail = '') {
    try { fs.appendFileSync(auditFile, `${JSON.stringify({ at: new Date().toISOString(), user, action, detail })}\n`) }
    catch { /* auditing must never break an operation */ }
  }

  function readAudit(limit = 100) {
    try {
      return fs.readFileSync(auditFile, 'utf8').split('\n').filter(Boolean).slice(-limit).reverse()
        .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean);
    } catch { return [] }
  }

  function getConfig() {
    const env = readEnv();
    return {
      envFile,
      restartRequired: true,
      fields: Object.entries(CONFIG_FIELDS).map(([key, spec]) => ({ key, label: spec.label, hint: spec.hint, value: env[key] ?? spec.fallback ?? '' })),
      hasBackup: fs.existsSync(backupFile)
    };
  }

  function restoreConfig() {
    if (!fs.existsSync(backupFile)) throw new Error('No earlier configuration backup exists.');
    const previous = fs.readFileSync(backupFile, 'utf8');
    const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    fs.writeFileSync(`${envFile}.admin.tmp`, previous);
    fs.renameSync(`${envFile}.admin.tmp`, envFile);
    fs.writeFileSync(backupFile, current, { mode: 0o600 });
    return getConfig();
  }

  function saveConfig(values) {
    if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('Configuration must be an object.');
    const clean = {};
    for (const [key, raw] of Object.entries(values)) {
      const spec = CONFIG_FIELDS[key];
      if (!spec) throw new Error(`${key} cannot be edited from the admin panel.`);
      const value = String(raw ?? '').trim();
      if (/[\r\n]/.test(value)) throw new Error(`${spec.label} must be a single line.`);
      if (value === '' && spec.required) throw new Error(`${spec.label} is required.`);
      if (value !== '' && !spec.test(value)) throw new Error(`${spec.label} is not valid.`);
      clean[key] = value;
    }
    const original = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
    fs.writeFileSync(backupFile, original, { mode: 0o600 });
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original === '' ? [] : original.split(/\r?\n/);
    for (const [key, value] of Object.entries(clean)) {
      const index = lines.findIndex(line => new RegExp(`^\\s*${key}\\s*=`).test(line));
      if (index >= 0) lines[index] = `${key}=${value}`;
      else {
        if (lines.length && lines[lines.length - 1] === '') lines.pop();
        lines.push(`${key}=${value}`, '');
      }
    }
    const temporary = `${envFile}.admin.tmp`;
    fs.writeFileSync(temporary, lines.join(newline));
    fs.renameSync(temporary, envFile);
    return getConfig();
  }

  const managedPid = () => {
    try { const pid = Number(fs.readFileSync(pidFile, 'utf8')); return pidAlive(pid) ? pid : 0 } catch { return 0 }
  };

  async function backendHealthy() {
    try {
      const response = await fetchImpl(new URL('/api/health', backendUrl()), { cache: 'no-store', signal: AbortSignal.timeout(2500) });
      return response.ok;
    } catch { return false }
  }

  async function listenerPid(port) {
    if (process.platform !== 'win32') return 0;
    const out = await run('powershell.exe', ['-NoProfile', '-Command',
      `$c=Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)"; "$($c.OwningProcess)|$($p.CommandLine)" }`]);
    const [pid, command = ''] = out.trim().split('|');
    return /node(\.exe)?"?\s+("?[^ ]*[\\/])?server\.js/i.test(command) ? Number(pid) : 0;
  }

  async function backendState() {
    const [healthy, managed] = await Promise.all([backendHealthy(), Promise.resolve(managedPid())]);
    return { running: healthy, managed: Boolean(managed), pid: managed || null, port: backendPort(), logFile };
  }

  async function startBackend() {
    if (await backendHealthy()) throw new Error('The backend is already running.');
    if (!fs.existsSync(path.join(backendDir, 'server.js'))) throw new Error('backend/server.js was not found.');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n--- backend started by admin panel at ${new Date().toISOString()} ---\n`);
    const child = spawnImpl(process.execPath, ['server.js'], { cwd: backendDir, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
    child.unref();
    fs.closeSync(out);
    fs.writeFileSync(pidFile, String(child.pid));
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(500);
      if (await backendHealthy()) return backendState();
      if (!pidAlive(child.pid)) throw new Error('The backend exited right after starting. Check the backend log.');
    }
    throw new Error('The backend process started but is not answering health checks yet. Check the backend log.');
  }

  async function stopBackend() {
    let pid = managedPid();
    if (!pid) pid = await listenerPid(backendPort());
    if (!pid) throw new Error(await backendHealthy()
      ? 'The backend was not started by this panel and could not be identified safely. Stop it from its own window.'
      : 'The backend is not running.');
    process.kill(pid);
    for (let attempt = 0; attempt < 20; attempt++) {
      await sleep(250);
      if (!pidAlive(pid)) break;
    }
    try { fs.unlinkSync(pidFile) } catch { /* no pid file */ }
    return backendState();
  }

  function backendLog(lines = 200) {
    try {
      const size = fs.statSync(logFile).size;
      const fd = fs.openSync(logFile, 'r');
      const length = Math.min(size, 64 * 1024);
      const buffer = Buffer.alloc(length);
      fs.readSync(fd, buffer, 0, length, size - length);
      fs.closeSync(fd);
      return buffer.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
    } catch { return '' }
  }

  async function databaseOverview() {
    const sizes = await database.pool.query(`
      SELECT n.nspname AS schema, c.relname AS name, c.reltuples::bigint AS estimate,
             pg_total_relation_size(c.oid)::bigint AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r','p') AND (n.nspname = 'replay_v31' OR (n.nspname = 'public' AND c.relname LIKE 'itr\\_%'))
      ORDER BY bytes DESC`);
    const info = await database.pool.query(`SELECT current_database() AS name, pg_database_size(current_database())::bigint AS bytes, version() AS version`);
    return {
      name: info.rows[0].name, bytes: Number(info.rows[0].bytes), version: info.rows[0].version,
      tables: sizes.rows.map(row => ({ schema: row.schema, name: row.name, estimate: Math.max(0, Number(row.estimate)), bytes: Number(row.bytes) }))
    };
  }

  const SECTIONS = ['gcv', 'taq-pro', 'tas-regime'];

  const watchNames = () => {
    const env = readEnv();
    return { processed: env.WATCH_PROCESSED_DIRNAME || '_processed', failed: env.WATCH_FAILED_DIRNAME || '_failed' };
  };

  async function timed(task) {
    const started = process.hrtime.bigint();
    try { await task(); return { ok: true, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e6) } }
    catch (error) { return { ok: false, ms: null, error: error.message } }
  }

  const cpuTimes = () => os.cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });

  async function healthCheck() {
    const before = cpuTimes();
    const frontendUrl = process.env.ADMIN_FRONTEND_URL || 'http://127.0.0.1:8080/';
    const [dbCheck, backendCheck, frontendCheck] = await Promise.all([
      timed(() => database.pool.query('SELECT 1')),
      timed(async () => { const r = await fetchImpl(new URL('/api/health', backendUrl()), { cache: 'no-store', signal: AbortSignal.timeout(3000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`) }),
      timed(async () => { const r = await fetchImpl(frontendUrl, { cache: 'no-store', signal: AbortSignal.timeout(3000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`) })
    ]);
    await sleep(250);
    const after = cpuTimes();
    const totalDelta = after.total - before.total;
    let disk = null;
    try {
      const stat = await fs.promises.statfs(rootDir);
      disk = { freeBytes: Number(stat.bavail) * Number(stat.bsize), totalBytes: Number(stat.blocks) * Number(stat.bsize) };
    } catch { /* statfs unsupported */ }
    return {
      database: dbCheck, backend: backendCheck, frontend: { ...frontendCheck, url: frontendUrl },
      host: {
        cpuPercent: totalDelta > 0 ? Math.round((1 - (after.idle - before.idle) / totalDelta) * 100) : null,
        memTotal: os.totalmem(), memFree: os.freemem(), disk, uptimeSec: Math.round(os.uptime()), name: os.hostname()
      },
      adminMemory: process.memoryUsage().rss
    };
  }

  async function watcherOverview() {
    const dir = watchDir();
    if (!dir) return { configured: false };
    const names = watchNames();
    const describe = async folder => {
      try {
        const entries = await fs.promises.readdir(folder, { withFileTypes: true });
        const files = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
          const stat = await fs.promises.stat(path.join(folder, entry.name));
          return { name: entry.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
        }));
        return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
      } catch { return null }
    };
    const pending = await describe(dir);
    return {
      configured: true, dir, exists: pending !== null, names,
      pending: pending || [], processed: (await describe(path.join(dir, names.processed))) || [], failed: (await describe(path.join(dir, names.failed))) || []
    };
  }

  async function retryFailed(name) {
    const dir = watchDir();
    if (!dir) throw new Error('The watch folder is not configured.');
    if (typeof name !== 'string' || !name || name !== path.basename(name) || name.startsWith('.')) throw new Error('Invalid file name.');
    const source = path.join(dir, watchNames().failed, name), target = path.join(dir, name);
    if (!fs.existsSync(source)) throw new Error('That file is not in the failed folder.');
    if (fs.existsSync(target)) throw new Error('A file with this name is already waiting in the watch folder.');
    await fs.promises.rename(source, target);
  }

  async function dbActivity() {
    const result = await database.pool.query(`
      SELECT pid, state, application_name, backend_start, query_start, wait_event_type, left(query, 160) AS query
      FROM pg_stat_activity WHERE datname = current_database() AND usename = current_user AND pid <> pg_backend_pid()
      ORDER BY query_start DESC NULLS LAST LIMIT 50`);
    return result.rows.map(row => ({
      pid: row.pid, state: row.state || '', application: row.application_name || '', backendStart: row.backend_start,
      queryStart: row.query_start, waiting: row.wait_event_type || '', query: row.query || ''
    }));
  }

  async function analyzeTable(table) {
    const overview = await databaseOverview();
    const found = overview.tables.find(item => `${item.schema}.${item.name}` === table);
    if (!found) throw new Error('Choose one of the platform tables listed on this page.');
    const quote = name => `"${name.replace(/"/g, '""')}"`;
    const started = Date.now();
    await database.pool.query({ text: `ANALYZE ${quote(found.schema)}.${quote(found.name)}`, query_timeout: 600000 });
    return { table, seconds: Math.round((Date.now() - started) / 100) / 10 };
  }

  async function listImports(section, limit = 50) {
    if (section && !SECTIONS.includes(section)) throw new Error('Unknown section.');
    const values = [Math.min(200, Math.max(1, Number(limit) || 50))];
    if (section) values.push(section);
    const result = await database.pool.query(`
      SELECT id, section, filename, imported_at, data_start, data_end, row_count, bar_count, source
      FROM replay_v31.replay_imports ${section ? 'WHERE section = $2' : ''}
      ORDER BY imported_at DESC LIMIT $1`, values);
    return result.rows.map(row => ({
      id: String(row.id), section: row.section, filename: row.filename, importedAt: row.imported_at,
      dataStart: row.data_start, dataEnd: row.data_end, rowCount: row.row_count, barCount: row.bar_count, source: row.source
    }));
  }

  async function deleteImport(section, id) {
    if (!SECTIONS.includes(section)) throw new Error('Unknown section.');
    if (!/^\d+$/.test(String(id))) throw new Error('Invalid import id.');
    const result = await database.pool.query('DELETE FROM replay_v31.replay_imports WHERE section = $1 AND id = $2', [section, id]);
    return result.rowCount > 0;
  }

  const backupDir = process.env.ADMIN_BACKUP_DIR || path.join(dataDir, 'backups');
  const BACKUP_SCOPES = {
    history: { label: 'Replay history (replay_v31 schema)', args: ['--schema=replay_v31'] },
    full: { label: 'Full database (all schemas, can be many GB)', args: [] },
    config: { label: 'Backend configuration (backend/.env)', args: null }
  };
  const BACKUP_NAME = /^itr-(history|full|config)-\d{8}-\d{6}\.(dump|env)$/;
  let backupJob = null;

  function findPgTool(name) {
    const exe = process.platform === 'win32' ? `${name}.exe` : name;
    const candidates = [];
    if (process.env.PG_BIN_DIR) candidates.push(path.join(process.env.PG_BIN_DIR, exe));
    for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, exe));
    if (process.platform === 'win32') {
      try {
        const base = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PostgreSQL');
        for (const version of fs.readdirSync(base).sort((a, b) => Number(b) - Number(a))) candidates.push(path.join(base, version, 'bin', exe));
      } catch { /* PostgreSQL not installed in the default location */ }
    }
    return candidates.find(file => { try { return fs.statSync(file).isFile() } catch { return false } }) || null;
  }

  function dbConnectionEnv() {
    const env = { ...process.env };
    const b64 = process.env.PGPASSWORD_B64;
    if (b64) env.PGPASSWORD = Buffer.from(b64, 'base64').toString('utf8');
    return env;
  }

  function backupInfo(name) {
    const stat = fs.statSync(path.join(backupDir, name));
    return { name, scope: name.split('-')[1], bytes: stat.size, createdAt: stat.mtime.toISOString() };
  }

  function listBackups() {
    fs.mkdirSync(backupDir, { recursive: true });
    const backups = fs.readdirSync(backupDir).filter(name => BACKUP_NAME.test(name)).map(backupInfo)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    let freeBytes = null;
    try { const s = fs.statfsSync(backupDir); freeBytes = Number(s.bavail) * Number(s.bsize) } catch { /* optional */ }
    return {
      directory: backupDir, freeBytes, pgDump: Boolean(findPgTool('pg_dump')), backups,
      scopes: Object.entries(BACKUP_SCOPES).map(([key, spec]) => ({ key, label: spec.label })),
      job: backupJob && { ...backupJob }, restore: restoreJob && { ...restoreJob }
    };
  }

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function startBackup(scope, onDone, internal = false) {
    const spec = BACKUP_SCOPES[scope];
    if (!spec) throw new Error('Choose a backup type from the list.');
    if (backupJob && backupJob.status === 'running') throw new Error('A backup is already running. Wait for it to finish.');
    if (!internal && restoreJob && restoreJob.status === 'running') throw new Error('A restore is running. Wait for it to finish.');
    fs.mkdirSync(backupDir, { recursive: true });
    const isConfig = scope === 'config';
    const name = `itr-${scope}-${stamp()}.${isConfig ? 'env' : 'dump'}`;
    const target = path.join(backupDir, name);
    const partial = `${target}.partial`;
    const job = backupJob = { scope, name, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, bytes: 0 };
    const finish = (status, error = null) => {
      job.status = status; job.error = error; job.finishedAt = new Date().toISOString();
      if (status !== 'done') try { fs.rmSync(partial, { force: true }) } catch { /* best effort */ }
      if (onDone) onDone(job);
    };
    if (isConfig) {
      try {
        fs.copyFileSync(envFile, partial);
        fs.renameSync(partial, target);
        fs.chmodSync(target, 0o600);
        job.bytes = fs.statSync(target).size;
        finish('done');
      } catch (error) { finish('failed', error.message) }
      return { ...job };
    }
    const pgDump = findPgTool('pg_dump');
    if (!pgDump) { finish('failed', 'pg_dump was not found. Install PostgreSQL client tools or set PG_BIN_DIR.'); return { ...job } }
    const args = ['--format=custom', '--no-owner', '--no-privileges', `--file=${partial}`, ...spec.args];
    if (process.env.DATABASE_URL) args.push(`--dbname=${process.env.DATABASE_URL}`);
    else args.push('--host', process.env.PGHOST || '127.0.0.1', '--port', String(process.env.PGPORT || 5432),
      '--username', process.env.PGUSER || 'orderflow_app', '--dbname', process.env.PGDATABASE || 'itr_market_data');
    let stderr = '';
    const child = spawn(pgDump, args, { env: dbConnectionEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) });
    child.on('error', error => finish('failed', error.message));
    child.on('close', async code => {
      if (job.status !== 'running') return;
      if (code !== 0) return finish('failed', stderr.trim() || `pg_dump exited with code ${code}`);
      const pgRestore = findPgTool('pg_restore');
      if (pgRestore) {
        const listing = await new Promise(resolve => execFile(pgRestore, ['--list', partial], { windowsHide: true, maxBuffer: 1 << 28, timeout: 600000 }, error => resolve(!error)));
        if (!listing) return finish('failed', 'The backup file was written but failed verification (pg_restore --list).');
      }
      try { fs.renameSync(partial, target); job.bytes = fs.statSync(target).size; finish('done') }
      catch (error) { finish('failed', error.message) }
    });
    return { ...job };
  }

  function backupPath(name) {
    if (!BACKUP_NAME.test(String(name))) throw new Error('Invalid backup name.');
    const file = path.join(backupDir, name);
    if (!fs.existsSync(file)) throw new Error('Backup was not found.');
    return file;
  }

  function deleteBackup(name) {
    fs.rmSync(backupPath(name));
    return true;
  }

  let restoreJob = null;

  async function startRestore(name) {
    const file = backupPath(name);
    const scope = String(name).split('-')[1];
    if (scope === 'full') throw new Error('Full-database backups cannot be restored from the panel. Use pg_restore from the command line (see the note on this page).');
    if (backupJob && backupJob.status === 'running') throw new Error('A backup is running. Wait for it to finish.');
    if (restoreJob && restoreJob.status === 'running') throw new Error('A restore is already running.');
    if (scope === 'config') {
      const current = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
      fs.writeFileSync(backupFile, current, { mode: 0o600 });
      fs.copyFileSync(file, `${envFile}.admin.tmp`);
      fs.renameSync(`${envFile}.admin.tmp`, envFile);
      restoreJob = { name, scope, status: 'done', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), error: null, safetyBackup: null };
      return { ...restoreJob };
    }
    if ((await backendState()).running) throw new Error('Stop the backend (Backend & config) before restoring the database.');
    const pgRestore = findPgTool('pg_restore');
    if (!pgRestore) throw new Error('pg_restore was not found. Install PostgreSQL client tools or set PG_BIN_DIR.');
    const job = restoreJob = { name, scope, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, error: null, safetyBackup: null };
    const fail = error => { job.status = 'failed'; job.error = error; job.finishedAt = new Date().toISOString() };
    try {
    startBackup('history', safety => {
      if (safety.status !== 'done') return fail(`Safety backup failed, nothing was restored: ${safety.error}`);
      job.safetyBackup = safety.name;
      const args = ['--clean', '--if-exists', '--no-owner', '--no-privileges', '--single-transaction', '--exit-on-error'];
      if (process.env.DATABASE_URL) args.push(`--dbname=${process.env.DATABASE_URL}`);
      else args.push('--host', process.env.PGHOST || '127.0.0.1', '--port', String(process.env.PGPORT || 5432),
        '--username', process.env.PGUSER || 'orderflow_app', '--dbname', process.env.PGDATABASE || 'itr_market_data');
      args.push(file);
      const listFile = `${file}.restore.list`;
      const listing = require('child_process').spawnSync(pgRestore, ['--list', file], { encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
      if (listing.status !== 0) return fail(`Could not read the backup: ${(listing.stderr || '').trim()}`);
      fs.writeFileSync(listFile, listing.stdout.split(/\r?\n/).filter(line => !/^\d+;\s+\d+\s+\d+\s+SCHEMA\s/.test(line)).join('\n'));
      args.splice(args.length - 1, 0, `--use-list=${listFile}`);
      let stderr = '';
      const child = spawn(pgRestore, args, { env: dbConnectionEnv(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) });
      child.on('error', error => { fs.rmSync(listFile, { force: true }); fail(error.message) });
      child.on('close', code => {
        fs.rmSync(listFile, { force: true });
        if (code !== 0) return fail(`Restore failed and was rolled back (database unchanged). ${stderr.trim()}`);
        job.status = 'done'; job.finishedAt = new Date().toISOString();
      });
    }, true);
    } catch (error) { fail(error.message); throw error }
    return { ...job };
  }

  return {
    listBackups, startBackup, startRestore, deleteBackup, backupPath, BACKUP_NAME,
    backendUrl, watchDir, watchNames, audit, readAudit, getConfig, saveConfig, restoreConfig, backendState, startBackend, stopBackend,
    backendLog, databaseOverview, listImports, deleteImport, healthCheck, watcherOverview, retryFailed, dbActivity, analyzeTable, sections: SECTIONS
  };
}

module.exports = { createPlatformControl, parseEnv, CONFIG_FIELDS };
