'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const XLSX = require('xlsx');

const execFileAsync = promisify(execFile);
const DATASETS = [
  { dataset: 'GCV', section: 'gcv' },
  { dataset: 'TAQ', section: 'taq-pro' },
  { dataset: 'TAS', section: 'tas-regime' },
];
const CSV_HEADER = ['event_id', 'event_time', 'symbol', 'row_data'];

function csvCell(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/"/g, '""')}"`;
}

function toCsv(rows) {
  return [
    CSV_HEADER.join(','),
    ...rows.map(row => [
      row.event_id,
      row.event_time instanceof Date ? row.event_time.toISOString() : row.event_time,
      row.symbol,
      JSON.stringify(row.row_data == null ? {} : row.row_data),
    ].map(csvCell).join(',')),
    '',
  ].join('\r\n');
}

function toWorkbook(rows) {
  const aoa = [
    CSV_HEADER,
    ...rows.map(row => [
      String(row.event_id),
      row.event_time instanceof Date ? row.event_time.toISOString() : String(row.event_time),
      String(row.symbol || ''),
      JSON.stringify(row.row_data == null ? {} : row.row_data),
    ]),
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(aoa), 'MarketData');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true });
}

function safeSymbol(symbol) {
  const normalized = String(symbol || 'UNKNOWN').trim().toUpperCase().replace(/[^A-Z0-9._-]/g, '_');
  return normalized || 'UNKNOWN';
}

function cursorFor(row) {
  return {
    eventTime: row.event_time instanceof Date ? row.event_time.toISOString() : String(row.event_time),
    eventId: String(row.event_id),
  };
}

function batchId(row) {
  return crypto.createHash('sha256').update(String(row.event_id)).digest('hex').slice(0, 12);
}

async function compressWindowsFiles(files) {
  if (process.platform !== 'win32' || !files.length) return;
  await execFileAsync('compact.exe', ['/C', '/Q', ...files], {
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
}

function createDatabaseFileExporter({
  pool,
  archiveDir,
  batchSize = 10000,
  compressFiles = compressWindowsFiles,
}) {
  const statePath = path.join(archiveDir, '.export-state.json');
  const datasetsByName = new Map(DATASETS.map(item => [item.dataset, item]));
  let state = { version: 1, datasets: {}, compressionPending: [] };
  let timer = null;
  let running = false;
  let ready = false;

  async function saveState() {
    const tempPath = `${statePath}.${process.pid}.tmp`;
    await fsp.writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: 'utf8' });
    await fsp.rename(tempPath, statePath);
  }

  async function loadState() {
    try {
      const saved = JSON.parse(await fsp.readFile(statePath, 'utf8'));
      if (saved.version !== 1 || !saved.datasets || typeof saved.datasets !== 'object') {
        throw new Error('Invalid database export state file');
      }
      if (saved.compressionPending !== undefined && !Array.isArray(saved.compressionPending)) {
        throw new Error('Invalid pending-file list in database export state');
      }
      saved.compressionPending = saved.compressionPending || [];
      state = saved;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async function flushCompression(force = false) {
    if (process.platform !== 'win32') return;
    while (state.compressionPending.length >= 50 ||
      (force && state.compressionPending.length > 0)) {
      const files = state.compressionPending.slice(0, 50);
      await compressFiles(files);
      state.compressionPending.splice(0, files.length);
      await saveState();
    }
  }

  async function writeBatch(sourceKind, datasetName, rows) {
    const dataset = datasetsByName.get(datasetName);
    if (!dataset) throw new Error(`Unsupported market dataset "${datasetName}"`);
    const groups = new Map();
    for (const row of rows) {
      const symbol = safeSymbol(row.symbol);
      if (!groups.has(symbol)) groups.set(symbol, []);
      groups.get(symbol).push(row);
    }
    for (const [symbol, symbolRows] of groups) {
      const first = symbolRows[0];
      const last = symbolRows[symbolRows.length - 1];
      const dir = path.join(archiveDir, sourceKind, dataset.section, symbol);
      await fsp.mkdir(dir, { recursive: true });
      const basename = `batch-${new Date(first.event_time).getTime()}-${batchId(first)}-${new Date(last.event_time).getTime()}-${batchId(last)}`;
      for (const [extension, content] of [
        ['csv', toCsv(symbolRows)],
        ['xlsx', toWorkbook(symbolRows)],
      ]) {
        const finalPath = path.join(dir, `${basename}.${extension}`);
        try {
          await fsp.access(finalPath);
          if (process.platform === 'win32' && !state.compressionPending.includes(finalPath)) {
            state.compressionPending.push(finalPath);
          }
          continue;
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        const tempPath = `${finalPath}.${process.pid}.tmp`;
        await fsp.writeFile(tempPath, content, { flag: 'wx' });
        try {
          await fsp.rename(tempPath, finalPath);
        } catch (_) {
          await fsp.rm(tempPath, { force: true });
          try {
            await fsp.access(finalPath);
          } catch (err) {
            throw err;
          }
        }
        if (process.platform === 'win32' && !state.compressionPending.includes(finalPath)) {
          state.compressionPending.push(finalPath);
        }
      }
    }
    await saveState();
    await flushCompression();
  }

  async function queryPage(dataset, cursor, upperBound) {
    const values = [dataset];
    const conditions = ['dataset = $1', 'event_time IS NOT NULL'];
    if (cursor && cursor.eventTime) {
      values.push(cursor.eventTime, cursor.eventId);
      conditions.push(`(event_time, event_id) > ($${values.length - 1}::timestamptz, $${values.length}::text)`);
    }
    if (upperBound && upperBound.eventTime) {
      values.push(upperBound.eventTime, upperBound.eventId);
      conditions.push(`(event_time, event_id) <= ($${values.length - 1}::timestamptz, $${values.length}::text)`);
    }
    values.push(batchSize);
    const result = await pool.query(`
      SELECT event_id::text AS event_id, event_time, symbol, row_data
      FROM public.itr_market_ticks
      WHERE ${conditions.join(' AND ')}
      ORDER BY event_time, event_id
      LIMIT $${values.length}
    `, values);
    return result.rows;
  }

  async function initializeDataset(dataset) {
    if (state.datasets[dataset]) return;
    const result = await pool.query(`
      SELECT event_time, event_id::text AS event_id
      FROM public.itr_market_ticks
      WHERE dataset = $1 AND event_time IS NOT NULL
      ORDER BY event_time DESC, event_id DESC
      LIMIT 1
    `, [dataset]);
    const watermark = result.rows[0] ? cursorFor(result.rows[0]) : null;
    state.datasets[dataset] = {
      watermark,
      historyCursor: null,
      liveCursor: watermark,
      historyComplete: false,
    };
    await saveState();
  }

  async function exportHistory(dataset) {
    const progress = state.datasets[dataset];
    if (progress.historyComplete) return;
    let exportedRows = 0;
    while (true) {
      const rows = await queryPage(dataset, progress.historyCursor, progress.watermark);
      if (!rows.length) {
        progress.historyComplete = true;
        progress.liveCursor = progress.watermark;
        await saveState();
        console.log(`[db-file-exporter] ${dataset} history export complete: ${exportedRows} rows this run`);
        return;
      }
      await writeBatch('history', dataset, rows);
      progress.historyCursor = cursorFor(rows[rows.length - 1]);
      exportedRows += rows.length;
      await saveState();
      if (exportedRows % 100000 < rows.length) {
        console.log(`[db-file-exporter] ${dataset} history export progress: ${exportedRows} rows`);
      }
    }
  }

  async function exportLive(dataset) {
    const progress = state.datasets[dataset];
    while (true) {
      const rows = await queryPage(dataset, progress.liveCursor, null);
      if (!rows.length) return;
      await writeBatch('live', dataset, rows);
      progress.liveCursor = cursorFor(rows[rows.length - 1]);
      await saveState();
    }
  }

  async function ensureReady() {
    if (ready) return;
    await fsp.mkdir(archiveDir, { recursive: true });
    await loadState();
    for (const { dataset, section } of DATASETS) {
      await fsp.mkdir(path.join(archiveDir, 'history', section), { recursive: true });
      await fsp.mkdir(path.join(archiveDir, 'live', section), { recursive: true });
    }
    ready = true;
  }

  async function runOnce() {
    await ensureReady();
    if (running) return;
    running = true;
    try {
      for (const { dataset } of DATASETS) {
        await initializeDataset(dataset);
        await exportHistory(dataset);
        await exportLive(dataset);
      }
      await flushCompression(true);
    } finally {
      running = false;
    }
  }

  async function start(pollMs = 5000) {
    if (timer) return;
    await ensureReady();
    timer = setInterval(() => {
      runOnce().catch(err => console.error('[db-file-exporter] Export failed:', err.message));
    }, pollMs);
    console.log('[db-file-exporter] Initial database export started');
    runOnce().catch(err => console.error('[db-file-exporter] Initial export failed:', err.message));
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, runOnce };
}

module.exports = { createDatabaseFileExporter, toCsv, toWorkbook, safeSymbol };
