require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const database = require('./lib/postgres');

const app = express();
const PORT = Number(process.env.PORT) || 4001;
const HOST = process.env.HOST || '127.0.0.1';
const JSON_LIMIT = process.env.JSON_LIMIT || '100mb';

// IMPORTANT: cors({origin:['*']}) does NOT mean "allow all" in the cors package.
// Preserve '*' as a string; only build an array for an explicit origin list.
const corsRaw = (process.env.CORS_ORIGIN || '*').trim();
const corsOrigin = corsRaw === '*'
  ? '*'
  : corsRaw.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: corsOrigin,
  exposedHeaders: ['X-Market-Data-Source', 'X-Market-Data-Rows', 'X-Market-Data-Truncated', 'X-Market-Data-Limit'],
}));
app.use(express.json({ limit: JSON_LIMIT }));
app.use('/api', require('./lib/apiAuth').createApiAuth());

let postgresReady = false;
function requirePostgres(req, res, next) {
  if (!postgresReady) {
    return res.status(503).json({ error: 'PostgreSQL is not connected', postgres: 'disconnected' });
  }
  next();
}

app.use('/api/imports', requirePostgres, require('./routes/imports'));
app.use('/api/ticks', requirePostgres, require('./routes/ticks'));
app.use('/api/orderflow', requirePostgres, require('./routes/orderflow'));

app.get('/api/health', async (req, res) => {
  let db = null, timescale = false;
  if (postgresReady) {
    try {
      const result = await database.health();
      db = result.database;
      timescale = result.timescale;
    } catch (err) {
      postgresReady = false;
      console.error('[ISKRU TRADE ROBOT PRO backend] PostgreSQL health check failed:', err.message);
    }
  }
  res.status(200).json({
    ok: postgresReady,
    api: 'up',
    postgres: postgresReady ? 'connected' : 'disconnected',
    database: postgresReady ? 'connected' : 'disconnected',
    db,
    timescale,
    port: PORT,
  });
});

app.listen(PORT, HOST, () => console.log(`[ISKRU TRADE ROBOT PRO backend] API listening on ${HOST}:${PORT}`));

let watcherStarted = false;
let databaseExporterStarted = false;
let retryTimer = null;
async function connectPostgres() {
  if (postgresReady) return;
  try {
    const status = await database.health();
    postgresReady = true;
    console.log('[ISKRU TRADE ROBOT PRO backend] PostgreSQL connected:', status.database,
      status.timescale ? '(TimescaleDB enabled)' : '');
    if (!watcherStarted) {
      try {
        await require('./watcher').startWatcher();
        watcherStarted = true;
      } catch (err) {
        console.error('[ISKRU TRADE ROBOT PRO backend] Folder watcher startup failed:', err.message);
      }
    }
    if (!databaseExporterStarted) {
      try {
        const archiveRoot = process.env.WATCH_ARCHIVE_DIR
          ? path.resolve(process.env.WATCH_ARCHIVE_DIR)
          : path.join(__dirname, 'data', 'market-files');
        const exporter = require('./lib/databaseFileExporter').createDatabaseFileExporter({
          pool: database.pool,
          archiveDir: path.join(archiveRoot, 'itr-terminal-db'),
          batchSize: parseInt(process.env.WATCH_DB_EXPORT_BATCH_SIZE, 10) || 10000,
        });
        await exporter.start(parseInt(process.env.WATCH_DB_EXPORT_POLL_MS, 10) || 5000);
        databaseExporterStarted = true;
        console.log('[ISKRU TRADE ROBOT PRO backend] Shared market database file export enabled');
      } catch (err) {
        console.error('[ISKRU TRADE ROBOT PRO backend] Database file exporter startup failed:', err.message);
      }
    }
  } catch (err) {
    postgresReady = false;
    console.error('[ISKRU TRADE ROBOT PRO backend] PostgreSQL connection failed:', err.message);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connectPostgres, 5000);
  }
}

database.pool.on('error', err => {
  postgresReady = false;
  console.error('[ISKRU TRADE ROBOT PRO backend] PostgreSQL pool error:', err.message);
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connectPostgres, 5000);
});

connectPostgres();
