(() => {
  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
  const api = async (url, body) => {
    const response = await fetch(url, body
      ? { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  };
  const AI_NAMES = { none: 'Not configured', openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini' };
  const BROKER_NAMES = { none: 'Not configured', oanda: 'OANDA', 'interactive-brokers': 'Interactive Brokers', metatrader5: 'MetaTrader 5' };
  const number = value => Number(value || 0).toLocaleString('en-US');
  const when = value => value ? new Date(value).toLocaleString() : '—';
  let loading = false, refreshTimer = null;

  function signedOut() {
    clearInterval(refreshTimer);
    $('dashboard-view').hidden = true;
    $('login-view').hidden = false;
    $('password').value = '';
    $('username').focus();
  }

  function setMetric(prefix, text, className, detail) {
    $(`${prefix}-state`).textContent = text;
    $(`${prefix}-state`).className = className;
    $(`${prefix}-detail`).textContent = detail;
  }

  function renderStatus(status) {
    const { backend, database, watcher } = status;
    setMetric('backend', backend.up ? 'Online' : 'Offline', backend.up ? 'good' : 'bad',
      backend.up ? `API port ${backend.port} · PostgreSQL ${backend.postgres}` : (backend.error || 'Start the backend on its API port'));
    setMetric('database', database.connected ? 'Connected' : 'Unavailable', database.connected ? 'good' : 'bad',
      database.connected ? `${database.name}${database.timescale ? ' · TimescaleDB' : ''}${database.hasTicks ? '' : ' · itr_market_ticks missing'}` : database.error);
    const totalRows = status.datasets.reduce((sum, item) => sum + item.rows, 0);
    const stats = status.datasetStats || {};
    if (!stats.computedAt) setMetric('rows', stats.error ? 'Unavailable' : 'Counting…', stats.error ? 'bad' : '', stats.error || 'Large table: first count takes about a minute');
    else setMetric('rows', number(totalRows), '', `${status.datasets.length} groups · counted ${when(stats.computedAt)}`);
    if (!watcher.configured) setMetric('watcher', 'Not configured', '', 'WATCH_DIR is empty in backend/.env');
    else if (!watcher.exists) setMetric('watcher', 'Folder missing', 'bad', `${watcher.dir} (${watcher.error})`);
    else setMetric('watcher', 'Watching', 'good', `${watcher.pending} waiting · ${watcher.processed} processed · ${watcher.failed} failed`);

    $('dataset-summary').textContent = `${status.datasets.length} groups`;
    $('dataset-list').innerHTML = status.datasets.map(item =>
      `<article class="feed"><div class="feed-head"><span>${escapeHtml(item.dataset)} <span class="subtle">/</span> ${escapeHtml(item.symbol)}</span><span class="feed-badge">${number(item.rows)} rows</span></div><small>${escapeHtml(when(item.first))} → ${escapeHtml(when(item.last))}</small></article>`
    ).join('') || '<p class="subtle">No market rows stored yet.</p>';
    $('import-list').innerHTML = status.imports.map(item =>
      `<article class="feed"><div class="feed-head"><span>${escapeHtml(item.filename)}</span><span class="feed-badge">${escapeHtml(item.section)}</span></div><small>${escapeHtml(when(item.importedAt))} · ${number(item.rowCount)} rows · ${escapeHtml(item.source)}</small></article>`
    ).join('') || '<p class="subtle">No imports recorded yet.</p>';
  }

  function renderIntegrations(config) {
    $('ai-integration-state').textContent = config.ai.provider === 'none' ? 'Not configured' : `${AI_NAMES[config.ai.provider]} selected`;
    $('ai-integration-detail').textContent = config.ai.provider === 'none'
      ? 'Choose an AI provider and define its role before enabling any AI-assisted decisions.'
      : `${config.ai.model || 'Model not set'} · ${config.ai.hasApiKey ? 'credential stored' : 'credential missing'} · adapter inactive`;
    $('broker-integration-state').textContent = config.broker.provider === 'none' ? 'Not configured' : `${BROKER_NAMES[config.broker.provider]} selected`;
    $('broker-integration-detail').textContent = config.broker.provider === 'none'
      ? 'No external broker or order route is connected to this platform.'
      : `${config.broker.environment} environment · ${config.broker.hasApiKey || config.broker.hasAccessToken ? 'credential stored' : 'credential missing'} · adapter inactive`;
  }

  function showDashboard(username) {
    $('login-view').hidden = true;
    $('dashboard-view').hidden = false;
    $('admin-user').textContent = username;
    refresh();
    loadHealth();
    refreshTimer = setInterval(() => { refresh(); loadHealth() }, 10000);
  }

  function showView(viewName) {
    document.querySelectorAll('.portal-view').forEach(view => { view.hidden = view.id !== `view-${viewName}` });
    document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
    if (viewName === 'profile') loadProfile();
    if (viewName === 'settings') loadSettings();
    if (viewName === 'imports') loadImports();
    if (viewName === 'database') loadDatabase();
    if (viewName === 'backups') loadBackups(); else clearTimeout(backupTimer);
    if (viewName === 'system') loadSystem();
    if (viewName === 'activity') loadActivity();
    if (viewName === 'watcher') loadWatcher();
    if (viewName === 'profile') loadSessions();
  }

  const percentText = (used, total) => total ? `${Math.round(used / total * 100)}%` : '--';
  async function loadHealth() {
    try {
      const h = await api('/api/health-check');
      const ok = (id, check, okText, detail) => {
        $(id).textContent = check.ok ? okText : 'Down';
        $(id).className = check.ok ? 'good' : 'bad';
        $(`${id}-d`).textContent = check.ok ? detail : (check.error || 'Not reachable');
      };
      ok('h-frontend', h.frontend, 'Online', `${h.frontend.ms} ms · ${h.frontend.url}`);
      ok('h-db', h.database, `${h.database.ms} ms`, 'SELECT 1 round trip');
      $('h-cpu').textContent = h.host.cpuPercent === null ? '--' : `${h.host.cpuPercent}%`;
      $('h-cpu').className = h.host.cpuPercent > 90 ? 'bad' : '';
      $('h-cpu-d').textContent = h.host.name;
      const used = h.host.memTotal - h.host.memFree;
      $('h-mem').textContent = percentText(used, h.host.memTotal);
      $('h-mem').className = used / h.host.memTotal > 0.9 ? 'bad' : '';
      $('h-mem-d').textContent = `${bytes(used)} of ${bytes(h.host.memTotal)} · admin ${bytes(h.adminMemory)}`;
      if (h.host.disk) {
        const diskUsed = h.host.disk.totalBytes - h.host.disk.freeBytes;
        $('h-disk').textContent = `${bytes(h.host.disk.freeBytes)} free`;
        $('h-disk').className = h.host.disk.freeBytes / h.host.disk.totalBytes < 0.1 ? 'bad' : '';
        $('h-disk-d').textContent = `${percentText(diskUsed, h.host.disk.totalBytes)} of ${bytes(h.host.disk.totalBytes)} used`;
      } else { $('h-disk').textContent = 'n/a'; $('h-disk-d').textContent = 'Not supported on this system'; }
      $('health-summary').textContent = `Checked ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('health-summary').textContent = error.message;
    }
  }

  async function loadWatcher() {
    $('watcher-message').textContent = 'Loading…';
    try {
      const data = await api('/api/watcher');
      $('watcher-notice').hidden = data.configured && data.exists;
      if (!data.configured) {
        $('watcher-notice').innerHTML = '<b>Watcher is disabled</b><span>Set a Watch folder under Backend &amp; config, then restart the backend.</span>';
        $('watcher-groups').innerHTML = ''; $('watcher-message').textContent = ''; return;
      }
      if (!data.exists) {
        $('watcher-notice').innerHTML = `<b>Folder not found</b><span>${escapeHtml(data.dir)} does not exist or cannot be read.</span>`;
        $('watcher-groups').innerHTML = ''; $('watcher-message').textContent = ''; return;
      }
      const table = (title, files, withRetry) => `<div class="file-group"><h2>${escapeHtml(title)} <span class="subtle">(${files.length})</span></h2><div class="table-card"><table class="data-table"><thead><tr><th>File</th><th class="num">Size</th><th>Modified</th>${withRetry ? '<th></th>' : ''}</tr></thead><tbody>${
        files.slice(0, 100).map(file => `<tr><td class="mono">${escapeHtml(file.name)}</td><td class="num">${bytes(file.size)}</td><td>${escapeHtml(when(file.modifiedAt))}</td>${withRetry ? `<td class="num"><button class="quiet-button" type="button" data-retry="${escapeHtml(file.name)}">Retry</button></td>` : ''}</tr>`).join('')
        || `<tr><td class="empty" colspan="${withRetry ? 4 : 3}">No files.</td></tr>`}</tbody></table></div></div>`;
      $('watcher-groups').innerHTML = table('Waiting in watch folder', data.pending, false) + table(`Failed (${data.names.failed})`, data.failed, true) + table(`Processed (${data.names.processed})`, data.processed, false);
      $('watcher-message').textContent = `Watching ${data.dir}`;
    } catch (error) { failView(error, 'watcher-message') }
  }

  async function loadSessions() {
    try {
      const data = await api('/api/sessions');
      $('session-timeout').textContent = `· auto sign-out after ${Math.round(data.timeoutMinutes / 60)} h`;
      $('session-list').innerHTML = data.sessions.map(item =>
        `<div class="session-row"><span>${escapeHtml(item.username)} · started ${escapeHtml(when(item.startedAt))}</span>${item.current ? '<b>this browser</b>' : `<span>#${escapeHtml(item.id)}</span>`}</div>`
      ).join('');
    } catch (error) { failView(error, 'session-message') }
  }

  const bytes = value => {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let size = Number(value || 0), unit = 0;
    while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit++ }
    return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  };
  const failView = (error, target) => {
    if (error.status === 401) signedOut();
    else $(target).textContent = error.message;
  };

  async function loadImports() {
    $('imports-message').textContent = 'Loading…';
    try {
      const data = await api(`/api/imports?section=${encodeURIComponent($('imports-section').value)}&limit=100`);
      $('imports-body').innerHTML = data.imports.map(item =>
        `<tr><td>${escapeHtml(item.filename)}</td><td>${escapeHtml(item.section)}</td><td>${escapeHtml(when(item.importedAt))}</td><td>${escapeHtml(when(item.dataStart))} → ${escapeHtml(when(item.dataEnd))}</td><td class="num">${number(item.rowCount)}</td><td class="num">${number(item.barCount)}</td><td class="num"><button class="quiet-button danger" type="button" data-delete="${escapeHtml(item.id)}" data-section="${escapeHtml(item.section)}">Delete</button></td></tr>`
      ).join('') || '<tr><td class="empty" colspan="7">No imports found.</td></tr>';
      $('imports-message').textContent = `${data.imports.length} import(s) shown, newest first.`;
    } catch (error) { failView(error, 'imports-message') }
  }

  async function loadDatabase() {
    $('database-message').textContent = 'Loading…';
    try {
      const data = await api('/api/database');
      $('db-name').textContent = data.name;
      $('db-version').textContent = data.version.split(',')[0];
      $('db-size').textContent = bytes(data.bytes);
      $('db-tables').textContent = String(data.tables.length);
      $('database-body').innerHTML = data.tables.map(item =>
        `<tr><td>${escapeHtml(item.schema)}.${escapeHtml(item.name)}</td><td class="num">${number(item.estimate)}</td><td class="num">${bytes(item.bytes)}</td><td class="num"><button class="quiet-button" type="button" data-analyze="${escapeHtml(item.schema)}.${escapeHtml(item.name)}">Analyze</button></td></tr>`
      ).join('') || '<tr><td class="empty" colspan="4">No platform tables found.</td></tr>';
      $('database-message').textContent = '';
      const activity = await api('/api/database/activity');
      $('activity-conn-body').innerHTML = activity.connections.map(item =>
        `<tr><td>${item.pid}</td><td>${escapeHtml(item.state)}${item.waiting ? ` · ${escapeHtml(item.waiting)}` : ''}</td><td>${escapeHtml(item.application)}</td><td>${escapeHtml(when(item.queryStart))}</td><td class="mono">${escapeHtml(item.query)}</td></tr>`
      ).join('') || '<tr><td class="empty" colspan="5">No other connections.</td></tr>';
    } catch (error) { failView(error, 'database-message') }
  }

  function renderBackendService(backend) {
    $('backend-service-state').textContent = backend.running ? 'Running' : 'Stopped';
    $('backend-service-state').className = backend.running ? 'good' : 'bad';
    $('backend-service-detail').textContent = `API port ${backend.port}${backend.pid ? ` · started by this panel (PID ${backend.pid})` : backend.running ? ' · started outside this panel' : ''}`;
    $('backend-start').disabled = backend.running;
    $('backend-stop').disabled = !backend.running;
  }

  async function loadSystem() {
    $('config-message').textContent = '';
    try {
      const [system, log] = await Promise.all([api('/api/system'), api('/api/backend/log')]);
      renderBackendService(system.backend);
      $('config-fields').innerHTML = system.config.fields.map(field =>
        `<div class="config-row"><label for="cfg-${field.key}">${escapeHtml(field.label)}</label><input id="cfg-${field.key}" data-key="${field.key}" value="${escapeHtml(field.value)}" autocomplete="off"><small>${escapeHtml(field.hint)}</small></div>`
      ).join('');
      const admin = system.admin;
      $('admin-info').innerHTML = [['Admin port', admin.port], ['Node.js', admin.node], ['Uptime', `${Math.floor(admin.uptimeSec / 60)} min`], ['Project folder', admin.root]]
        .map(([label, value]) => `<div>${escapeHtml(label)}<b>${escapeHtml(value)}</b></div>`).join('');
      $('backend-log').textContent = log.log || 'No output captured yet. Output is recorded when the backend is started from this panel.';
    } catch (error) { failView(error, 'backend-message') }
  }

  async function backendAction(action) {
    const labels = { start: 'Starting', stop: 'Stopping', restart: 'Restarting' };
    if (action !== 'start' && !confirm(`${action === 'stop' ? 'Stop' : 'Restart'} the order flow backend?`)) return;
    ['backend-start', 'backend-stop', 'backend-restart'].forEach(id => { $(id).disabled = true });
    $('backend-message').textContent = `${labels[action]} backend…`;
    try {
      renderBackendService(await api('/api/backend', { action }));
      $('backend-message').textContent = `Backend ${action} completed.`;
    } catch (error) {
      if (error.status === 401) return signedOut();
      $('backend-message').textContent = error.message;
    }
    $('backend-restart').disabled = false;
    loadSystem();
  }

  async function loadActivity() {
    try {
      const data = await api('/api/audit');
      $('activity-body').innerHTML = data.events.map(item =>
        `<tr><td>${escapeHtml(when(item.at))}</td><td>${escapeHtml(item.user)}</td><td>${escapeHtml(item.action)}</td><td>${escapeHtml(item.detail)}</td></tr>`
      ).join('') || '<tr><td class="empty" colspan="4">No activity recorded yet.</td></tr>';
    } catch (error) { failView(error, 'activity-body') }
  }

  async function loadProfile() {
    $('profile-message').textContent = '';
    try {
      const profile = await api('/api/profile');
      $('profile-username').value = profile.username;
      $('profile-current-password').value = '';
      $('profile-new-password').value = '';
      $('profile-confirm-password').value = '';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('profile-message').textContent = error.message;
    }
  }

  function showKeyStatus(settings) {
    $('ai-key-status').textContent = settings.ai.hasApiKey ? 'Key stored · hidden' : 'No key stored';
    $('broker-key-status').textContent = settings.broker.hasApiKey ? 'Key stored · hidden' : 'No key stored';
    $('broker-token-status').textContent = settings.broker.hasAccessToken ? 'Token stored · hidden' : 'No token stored';
  }

  async function loadSettings() {
    $('settings-message').textContent = 'Loading saved configuration…';
    try {
      const settings = await api('/api/settings');
      $('ai-provider').value = settings.ai.provider;
      $('ai-model').value = settings.ai.model;
      $('ai-api-key').value = '';
      $('ai-clear-key').checked = false;
      $('broker-provider').value = settings.broker.provider;
      $('broker-environment').value = settings.broker.environment;
      $('broker-account').value = settings.broker.accountId;
      $('broker-api-key').value = '';
      $('broker-access-token').value = '';
      $('broker-clear-key').checked = false;
      $('broker-clear-token').checked = false;
      showKeyStatus(settings);
      $('settings-message').textContent = 'Settings are stored securely; provider connections are not active.';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('settings-message').textContent = error.message;
    }
  }

  async function refresh() {
    if (loading || $('dashboard-view').hidden) return;
    loading = true;
    $('dashboard-error').textContent = '';
    try {
      const [status, config] = await Promise.all([api('/api/status'), api('/api/settings')]);
      renderStatus(status);
      renderIntegrations(config);
      const healthy = status.backend.up && status.database.connected;
      $('connection').className = `status ${healthy ? 'online' : 'offline'}`;
      $('connection').innerHTML = healthy ? '<i></i> Systems connected' : '<i></i> Attention needed';
      $('last-updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
    } catch (error) {
      if (error.status === 401) { signedOut(); return }
      $('connection').className = 'status offline';
      $('connection').innerHTML = '<i></i> Service unavailable';
      $('dashboard-error').textContent = `Could not refresh dashboard: ${error.message}`;
    } finally {
      loading = false;
    }
  }

  $('login-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    $('login-error').textContent = '';
    try {
      const session = await api('/api/login', { username: $('username').value, password: $('password').value });
      $('password').value = '';
      showDashboard(session.username);
    } catch (error) {
      $('login-error').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  $('logout').onclick = async () => {
    try { await api('/api/logout', {}) } catch (error) { $('dashboard-error').textContent = error.message }
    signedOut();
  };
  $('refresh').onclick = () => { refresh(); loadHealth() };
  $('watcher-refresh').onclick = loadWatcher;
  $('watcher-groups').addEventListener('click', async event => {
    const button = event.target.closest('[data-retry]');
    if (!button) return;
    button.disabled = true;
    try { await api('/api/watcher/retry', { name: button.dataset.retry }); $('watcher-message').textContent = 'File moved back to the watch folder for re-ingest.'; await loadWatcher() }
    catch (error) { button.disabled = false; failView(error, 'watcher-message') }
  });
  $('database-body').addEventListener('click', async event => {
    const button = event.target.closest('[data-analyze]');
    if (!button) return;
    button.disabled = true;
    $('database-message').textContent = `Analyzing ${button.dataset.analyze}…`;
    try { const result = await api('/api/database/analyze', { table: button.dataset.analyze }); $('database-message').textContent = `Analyzed ${result.table} in ${result.seconds}s.` }
    catch (error) { failView(error, 'database-message') }
    button.disabled = false;
  });
  let backupTimer = null;
  async function loadBackups() {
    clearTimeout(backupTimer);
    try {
      const data = await api('/api/backups');
      $('backup-dir').textContent = data.directory;
      $('backup-free').textContent = data.freeBytes === null ? '--' : bytes(data.freeBytes);
      $('backup-count').textContent = String(data.backups.length);
      $('backup-scope').innerHTML = data.scopes.map(scope => `<option value="${escapeHtml(scope.key)}">${escapeHtml(scope.label)}</option>`).join('');
      const running = data.job && data.job.status === 'running';
      $('backup-create').disabled = running;
      $('backup-notice').hidden = data.pgDump;
      $('backup-notice').textContent = 'pg_dump was not found, so database backups are unavailable. Install PostgreSQL client tools or set PG_BIN_DIR.';
      if (data.job) {
        const job = data.job;
        $('backup-job').textContent = running ? `Backing up (${job.scope})… started ${when(job.startedAt)}`
          : job.status === 'done' ? `Last backup ${job.name} finished (${bytes(job.bytes)}).` : `Last backup failed: ${job.error}`;
      }
      $('backup-body').innerHTML = data.backups.map(item =>
        `<tr><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.scope)}</td><td>${escapeHtml(when(item.createdAt))}</td><td class="num">${bytes(item.bytes)}</td><td class="num"><a class="quiet-button link-button" href="/api/backups/download?name=${encodeURIComponent(item.name)}" download>Download</a> ${item.scope === 'full' ? '' : `<button class="quiet-button" type="button" data-backup-restore="${escapeHtml(item.name)}">Restore</button>`} <button class="quiet-button danger" type="button" data-backup-delete="${escapeHtml(item.name)}">Delete</button></td></tr>`
      ).join('') || '<tr><td class="empty" colspan="5">No backups yet.</td></tr>';
      const restoring = data.restore && data.restore.status === 'running';
      if (data.restore) {
        const r = data.restore;
        $('backup-message').textContent = restoring ? `Restoring ${r.name}… (safety backup: ${r.safetyBackup || 'in progress'})`
          : r.status === 'done' ? `Restore of ${r.name} completed${r.safetyBackup ? `. Safety backup: ${r.safetyBackup}` : '. Restart the backend to apply configuration.'}` : r.error;
      }
      $('backup-create').disabled = running || restoring;
      if (running || restoring) backupTimer = setTimeout(loadBackups, 3000);
    } catch (error) { failView(error, 'backup-message') }
  }

  $('backup-body').addEventListener('click', async event => {
    const button = event.target.closest('[data-backup-restore]');
    if (!button) return;
    const name = button.dataset.backupRestore;
    const isConfig = name.includes('-config-');
    const typed = prompt(`${isConfig ? 'This replaces backend/.env with the backup.' : 'This REPLACES the replay_v31 history tables with the backup contents. A safety backup is taken first and the restore is rolled back if it fails.'}\n\nType RESTORE to continue.`);
    if (typed !== 'RESTORE') return;
    button.disabled = true;
    try { await api('/api/backups/restore', { name }); $('backup-message').textContent = 'Restore started.' }
    catch (error) { failView(error, 'backup-message') }
    loadBackups();
  });

  $('backup-create').onclick = async () => {
    const scope = $('backup-scope').value;
    if (scope === 'full' && !confirm('A full database backup can take a long time and use many GB of disk. Continue?')) return;
    $('backup-create').disabled = true;
    $('backup-message').textContent = '';
    try { await api('/api/backups/create', { scope }); $('backup-message').textContent = 'Backup started.' }
    catch (error) { failView(error, 'backup-message') }
    loadBackups();
  };
  $('backup-refresh').onclick = loadBackups;
  $('backup-body').addEventListener('click', async event => {
    const button = event.target.closest('[data-backup-delete]');
    if (!button || !confirm(`Delete ${button.dataset.backupDelete} permanently?`)) return;
    button.disabled = true;
    try { await api('/api/backups/delete', { name: button.dataset.backupDelete }); $('backup-message').textContent = 'Backup deleted.' }
    catch (error) { failView(error, 'backup-message') }
    loadBackups();
  });
  $('config-restore').onclick = async () => {
    if (!confirm('Restore the previous backend/.env values? The current values are kept as the new backup.')) return;
    try { await api('/api/config/restore', {}); $('config-message').textContent = 'Previous configuration restored. Restart the backend to apply.'; loadSystem() }
    catch (error) { failView(error, 'config-message') }
  };
  $('revoke-others').onclick = async () => {
    try { const result = await api('/api/sessions/revoke-others', {}); $('session-message').textContent = `${result.revoked} other session(s) signed out.`; loadSessions() }
    catch (error) { failView(error, 'session-message') }
  };
  $('imports-refresh').onclick = loadImports;
  $('imports-section').onchange = loadImports;
  $('database-refresh').onclick = loadDatabase;
  $('system-refresh').onclick = loadSystem;
  $('activity-refresh').onclick = loadActivity;
  $('backend-start').onclick = () => backendAction('start');
  $('backend-stop').onclick = () => backendAction('stop');
  $('backend-restart').onclick = () => backendAction('restart');
  $('imports-body').addEventListener('click', async event => {
    const button = event.target.closest('[data-delete]');
    if (!button || !confirm('Delete this import permanently? Raw market ticks are not affected.')) return;
    button.disabled = true;
    try {
      await api('/api/imports/delete', { section: button.dataset.section, id: button.dataset.delete });
      loadImports();
    } catch (error) {
      button.disabled = false;
      failView(error, 'imports-message');
    }
  });
  $('config-form').addEventListener('submit', async event => {
    event.preventDefault();
    const values = {};
    document.querySelectorAll('#config-fields input').forEach(input => { values[input.dataset.key] = input.value });
    $('config-message').textContent = 'Saving…';
    try {
      await api('/api/config', { values });
      $('config-message').textContent = 'Saved to backend/.env. Restart the backend to apply.';
    } catch (error) { failView(error, 'config-message') }
  });
  document.querySelector('.portal-nav').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) showView(button.dataset.view);
  });
  $('profile-form').addEventListener('submit', async event => {
    event.preventDefault();
    const currentPassword = $('profile-current-password').value;
    const newPassword = $('profile-new-password').value;
    if (newPassword && newPassword !== $('profile-confirm-password').value) {
      $('profile-message').textContent = 'New password and confirmation do not match.';
      return;
    }
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    $('profile-message').textContent = 'Saving profile…';
    try {
      const profile = await api('/api/profile', { username: $('profile-username').value, currentPassword, newPassword });
      $('admin-user').textContent = profile.username;
      $('profile-current-password').value = '';
      $('profile-new-password').value = '';
      $('profile-confirm-password').value = '';
      $('profile-message').textContent = 'Profile saved. Other sessions have been signed out.';
    } catch (error) {
      if (error.status === 401 && /sign-in/i.test(error.message)) signedOut();
      else $('profile-message').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('settings-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type=submit]');
    button.disabled = true;
    $('settings-message').textContent = 'Encrypting and saving…';
    try {
      const settings = await api('/api/settings', {
        ai: {
          provider: $('ai-provider').value,
          model: $('ai-model').value,
          apiKey: $('ai-api-key').value,
          clearApiKey: $('ai-clear-key').checked
        },
        broker: {
          provider: $('broker-provider').value,
          environment: $('broker-environment').value,
          accountId: $('broker-account').value,
          apiKey: $('broker-api-key').value,
          accessToken: $('broker-access-token').value,
          clearApiKey: $('broker-clear-key').checked,
          clearAccessToken: $('broker-clear-token').checked
        }
      });
      $('ai-api-key').value = '';
      $('broker-api-key').value = '';
      $('broker-access-token').value = '';
      $('ai-clear-key').checked = false;
      $('broker-clear-key').checked = false;
      $('broker-clear-token').checked = false;
      showKeyStatus(settings);
      renderIntegrations(settings);
      $('settings-message').textContent = 'Configuration encrypted and saved. Integrations remain disconnected.';
    } catch (error) {
      if (error.status === 401) signedOut();
      else $('settings-message').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

  api('/api/session').then(session => showDashboard(session.username)).catch(error => {
    $('login-view').hidden = false;
    $('dashboard-view').hidden = true;
    if (error.status !== 401) $('login-error').textContent = `Admin service unavailable: ${error.message}`;
  });
})();
