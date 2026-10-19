'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('watcher imports files present at startup and files dropped while running', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itr-watcher-'));
  const watchDir = path.join(rootDir, 'live');
  const historyDir = path.join(rootDir, 'history');
  const archiveDir = path.join(rootDir, 'archive');
  await fs.mkdir(watchDir);
  await fs.mkdir(historyDir);
  const envKeys = ['WATCH_DIR', 'WATCH_HISTORY_DIR', 'WATCH_ARCHIVE_DIR', 'WATCH_POLL_MS', 'WATCH_FAILED_DIRNAME'];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  process.env.WATCH_DIR = watchDir;
  process.env.WATCH_HISTORY_DIR = historyDir;
  process.env.WATCH_ARCHIVE_DIR = archiveDir;
  process.env.WATCH_POLL_MS = '20';
  process.env.WATCH_FAILED_DIRNAME = '_failed';

  const database = require('../lib/postgres');
  const originalMethods = {
    storeRawEvents: database.storeRawEvents,
    storeRawRows: database.storeRawRows,
    createImport: database.createImport,
  };
  const imports = [];
  let rawEventWrites = 0;
  let tickWrites = 0;
  const tickSections = [];
  database.storeRawEvents = async (_section, events) => {
    rawEventWrites += events.length;
    return { valid: events.length, inserted: events.length, duplicates: 0, invalidTimestamp: 0 };
  };
  database.storeRawRows = async (section, rows) => {
    tickSections.push(section);
    tickWrites += rows.length;
    return { valid: rows.length, duplicates: 0 };
  };
  database.createImport = async (section, input) => imports.push({ section, ...input });

  const watcherPath = require.resolve('../watcher');
  delete require.cache[watcherPath];
  const watcher = require('../watcher');
  const gcvCsv = [
    'Date,TIMEACT NS,Tick,Last,Bid,Ask,B Size,A Size,AGGRESSIVE ORD1,TRADE_ID',
    '2026-10-16,13:00:00,4200.1,4200.15,4200.1,4200.2,4,5,B,trade-1',
  ].join('\n');
  const taqCsv = [
    'Timestamp,PRCTCK_1,BID,ASK,BIDSIZE,ASKSIZE,SEQNUM,RTL,QUALIFIERS',
    '2026-10-16 13:00:00,4200.1,4200.1,4200.2,4,5,1,0,',
  ].join('\n');
  const tasCsv = [
    'Timestamp,PRCTCK_1,AGGRS_SID1,TRDPRC_1,BID,ASK,BIDSIZE,ASKSIZE,TRDVOL_1,TRADE_ID,SEQNUM,RTL,QUALIFIERS',
    '2026-10-16 13:00:00,4200.1,B,4200.15,4200.1,4200.2,4,5,1,trade-2,2,0,',
  ].join('\n');
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(predicate(), 'timed out waiting for file import');
  };
  const waitForFile = async filePath => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {
        await fs.access(filePath);
        return;
      } catch (_) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.fail(`timed out waiting for ${filePath}`);
  };

  try {
    await fs.writeFile(path.join(historyDir, 'GCV_2026-10-16_history.csv'), gcvCsv);
    await watcher.startWatcher();
    for (const sourceKind of ['history', 'live']) {
      for (const section of ['gcv', 'taq-pro', 'tas-regime']) {
        await fs.access(path.join(archiveDir, sourceKind, section));
      }
    }
    await waitFor(() => imports.length === 1);
    assert.equal(imports[0].filename, 'GCV_2026-10-16_history.csv');
    assert.equal(imports[0].section, 'gcv');
    assert.equal(imports[0].source, 'folder-watcher');
    const archivedHistory = path.join(archiveDir, 'history', 'gcv', 'GCV_2026-10-16_history.csv');
    await waitForFile(archivedHistory);
    assert.equal(await fs.readFile(archivedHistory, 'utf8'), gcvCsv);
    await assert.rejects(fs.access(path.join(historyDir, 'GCV_2026-10-16_history.csv')));

    await fs.writeFile(path.join(watchDir, 'TAQ_2026-10-16_live.csv'), taqCsv);
    await fs.writeFile(path.join(watchDir, 'TAS_2026-10-16_live.csv'), tasCsv);
    await fs.writeFile(path.join(watchDir, 'TAQ_2026-10-16_mislabeled.csv'), tasCsv);
    await waitFor(() => imports.length === 3);
    const sectionByFile = Object.fromEntries(imports.map(({ filename, section }) => [filename, section]));
    assert.deepEqual(sectionByFile, {
      'GCV_2026-10-16_history.csv': 'gcv',
      'TAQ_2026-10-16_live.csv': 'taq-pro',
      'TAS_2026-10-16_live.csv': 'tas-regime',
    });
    const archivedTaq = path.join(archiveDir, 'live', 'taq-pro', 'TAQ_2026-10-16_live.csv');
    const archivedTas = path.join(archiveDir, 'live', 'tas-regime', 'TAS_2026-10-16_live.csv');
    await waitForFile(archivedTaq);
    await waitForFile(archivedTas);
    assert.equal(await fs.readFile(archivedTaq, 'utf8'), taqCsv);
    assert.equal(await fs.readFile(archivedTas, 'utf8'), tasCsv);
    await waitForFile(path.join(watchDir, '_failed', 'TAQ_2026-10-16_mislabeled.csv'));
    await assert.rejects(fs.access(path.join(watchDir, 'TAQ_2026-10-16_live.csv')));
    await assert.rejects(fs.access(path.join(watchDir, 'TAS_2026-10-16_live.csv')));
    assert.equal(rawEventWrites, 3);
    assert.equal(tickWrites, 3);
    assert.deepEqual(tickSections.sort(), ['gcv', 'taq-pro', 'tas-regime']);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(imports.length, 3);
    assert.equal(rawEventWrites, 3);
    assert.equal(tickWrites, 3);
  } finally {
    watcher.stopWatcher();
    database.storeRawEvents = originalMethods.storeRawEvents;
    database.storeRawRows = originalMethods.storeRawRows;
    database.createImport = originalMethods.createImport;
    delete require.cache[watcherPath];
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
