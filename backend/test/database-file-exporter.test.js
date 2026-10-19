'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');
const { createDatabaseFileExporter } = require('../lib/databaseFileExporter');

function exportPath(root, kind, section, row, ext) {
  const id = String(row.event_id);
  const hash = crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
  const time = new Date(row.event_time).getTime();
  const batch = `batch-${time}-${hash}-${time}-${hash}`;
  return path.join(root, kind, section, 'XAUUSD', `${batch}.${ext}`);
}

test('exports existing DB rows as history and later rows as live, resumably', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'itr-db-export-'));
  const archiveDir = path.join(rootDir, 'itr-terminal-db');
  const rowsByDataset = {
    GCV: [
      { event_id: 'gcv-event-a', event_time: new Date('2026-10-16T10:00:00Z'), symbol: 'XAUUSD', row_data: { Last: 4200.1 } },
      { event_id: 'gcv-event-b', event_time: new Date('2026-10-16T10:00:01Z'), symbol: 'XAUUSD', row_data: { Last: 4200.2 } },
    ],
    TAQ: [
      { event_id: 'taq-event-a', event_time: new Date('2026-10-16T10:00:00Z'), symbol: 'XAUUSD', row_data: { BID: 4200, ASK: 4200.2 } },
    ],
    TAS: [],
  };
  const compressedFiles = new Set();
  const compressFiles = async files => files.forEach(file => compressedFiles.add(file));
  const pool = {
    async query(sql, values) {
      const dataset = values[0];
      if (/ORDER BY event_time DESC/.test(sql)) {
        const rows = [...rowsByDataset[dataset]].sort((a, b) =>
          new Date(b.event_time) - new Date(a.event_time) || b.event_id.localeCompare(a.event_id)
        );
        return { rows: rows.length ? [rows[0]] : [] };
      }
      const hasCursor = /\(event_time, event_id\) >/.test(sql);
      const hasUpper = /\(event_time, event_id\) <=/.test(sql);
      let valueIndex = 1;
      const cursor = hasCursor ? { time: new Date(values[valueIndex++]), id: values[valueIndex++] } : null;
      const upper = hasUpper ? { time: new Date(values[valueIndex++]), id: values[valueIndex++] } : null;
      const limit = Number(values[values.length - 1]);
      const rows = rowsByDataset[dataset]
        .filter(row => {
          const time = new Date(row.event_time);
          const id = row.event_id;
          const after = !cursor || time > cursor.time || (time.getTime() === cursor.time.getTime() && id > cursor.id);
          const before = !upper || time < upper.time || (time.getTime() === upper.time.getTime() && id <= upper.id);
          return after && before;
        })
        .sort((a, b) => new Date(a.event_time) - new Date(b.event_time) || a.event_id.localeCompare(b.event_id))
        .slice(0, limit);
      return { rows };
    },
  };
  const exporter = createDatabaseFileExporter({ pool, archiveDir, batchSize: 1, compressFiles });

  try {
    await exporter.runOnce();
    const historyFile = exportPath(archiveDir, 'history', 'gcv', rowsByDataset.GCV[0], 'csv');
    const historyExcel = exportPath(archiveDir, 'history', 'gcv', rowsByDataset.GCV[0], 'xlsx');
    await fs.access(historyFile);
    await fs.access(historyExcel);
    assert.ok(compressedFiles.has(historyFile));
    assert.ok(compressedFiles.has(historyExcel));
    await fs.access(exportPath(archiveDir, 'history', 'taq-pro', rowsByDataset.TAQ[0], 'csv'));
    await fs.access(exportPath(archiveDir, 'history', 'taq-pro', rowsByDataset.TAQ[0], 'xlsx'));

    const lateLiveRow = {
      event_id: 'gcv-event-c',
      event_time: new Date('2026-10-16T10:00:02Z'),
      symbol: 'XAUUSD',
      row_data: { Last: 4200.3, note: 'comma, quote "and" newline\npreserved' },
    };
    rowsByDataset.GCV.push(lateLiveRow);
    await exporter.runOnce();
    const liveFile = exportPath(archiveDir, 'live', 'gcv', lateLiveRow, 'csv');
    const liveExcel = exportPath(archiveDir, 'live', 'gcv', lateLiveRow, 'xlsx');
    await fs.access(liveFile);
    await fs.access(liveExcel);
    assert.ok(compressedFiles.has(liveFile));
    assert.ok(compressedFiles.has(liveExcel));

    for (const filePath of [liveFile, liveExcel]) {
      const parsed = XLSX.read(await fs.readFile(filePath), { type: 'buffer' });
      const exported = XLSX.utils.sheet_to_json(parsed.Sheets[parsed.SheetNames[0]]);
      assert.equal(exported.length, 1);
      assert.equal(String(exported[0].event_id), 'gcv-event-c');
      assert.equal(exported[0].event_time, lateLiveRow.event_time.toISOString());
      assert.equal(exported[0].symbol, 'XAUUSD');
      assert.deepEqual(JSON.parse(exported[0].row_data), lateLiveRow.row_data);
    }

    exporter.stop();
    const resumedExporter = createDatabaseFileExporter({ pool, archiveDir, batchSize: 1, compressFiles });
    await resumedExporter.runOnce();
    const afterRestart = {
      event_id: 'gcv-event-d',
      event_time: new Date('2026-10-16T10:00:03Z'),
      symbol: 'XAUUSD',
      row_data: { Last: 4200.4 },
    };
    rowsByDataset.GCV.push(afterRestart);
    await resumedExporter.runOnce();
    await fs.access(exportPath(archiveDir, 'live', 'gcv', afterRestart, 'csv'));
    await fs.access(exportPath(archiveDir, 'live', 'gcv', afterRestart, 'xlsx'));
    await assert.rejects(fs.access(exportPath(archiveDir, 'history', 'gcv', lateLiveRow, 'csv')));
    resumedExporter.stop();
  } finally {
    exporter.stop();
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
