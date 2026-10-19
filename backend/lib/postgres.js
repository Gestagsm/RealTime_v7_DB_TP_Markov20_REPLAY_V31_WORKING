'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const ALLOWED_SECTIONS = ['gcv', 'taq-pro', 'tas-regime'];
const ALLOWED_KINDS = ['tp', 'regime', 'agent'];
const DATASET_BY_SECTION = { gcv: 'GCV', 'taq-pro': 'TAQ', 'tas-regime': 'TAS' };
const DEFAULT_SYMBOL = String(process.env.MARKET_SYMBOL || 'XAUUSD').trim().toUpperCase();
const MAX_RANGE_ROWS = 300000;
const databasePassword = process.env.PGPASSWORD_B64
  ? Buffer.from(process.env.PGPASSWORD_B64, 'base64').toString('utf8')
  : (process.env.PGPASSWORD || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DATABASE_URL ? undefined : (process.env.PGHOST || '127.0.0.1'),
  port: process.env.DATABASE_URL ? undefined : (Number(process.env.PGPORT) || 5432),
  database: process.env.DATABASE_URL ? undefined : (process.env.PGDATABASE || 'itr_market_data'),
  user: process.env.DATABASE_URL ? undefined : (process.env.PGUSER || 'orderflow_app'),
  password: process.env.DATABASE_URL ? undefined : databasePassword,
  max: 8,
  connectionTimeoutMillis: 5000,
});

let initialized = false;
let initializing;

function sectionOrThrow(section) {
  if (!ALLOWED_SECTIONS.includes(section)) throw new Error(`Unknown section "${section}"`);
  return section;
}

function parseTimestamp(row) {
  if (row && Number.isFinite(Number(row._tsMs)) && Number(row._tsMs) > 0) {
    return new Date(Number(row._tsMs));
  }
  if (row && (row.date || row.time)) {
    const parsed = Date.parse(`${row.date || ''} ${row.time || ''}`.trim());
    if (Number.isFinite(parsed)) return new Date(parsed);
  }
  if (row) {
    const value = row.Timestamp || row.timestamp || row.TIMESTAMP || row.DateTime || row.datetime;
    if (value != null) {
      const parsed = Date.parse(String(value).replace('T', ' '));
      if (Number.isFinite(parsed)) return new Date(parsed);
    }
  }
  return null;
}

function stableValue(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function getSymbol(row, fallback = DEFAULT_SYMBOL) {
  const value = row && (row.symbol || row.Symbol || row.SYMBOL || row.RIC || row.TICKER);
  return String(value || fallback).trim().toUpperCase();
}

async function initialize() {
  if (initialized) return;
  if (!initializing) {
    initializing = (async () => {
      const shared = await pool.query(`SELECT to_regclass('public.itr_market_ticks') AS table_name`);
      if (!shared.rows[0].table_name) {
        throw new Error('Shared table public.itr_market_ticks is missing from the configured PostgreSQL database');
      }
      await pool.query(`
        CREATE TABLE IF NOT EXISTS replay_v31.replay_import_ticks (
          section TEXT NOT NULL CHECK (section IN ('gcv', 'taq-pro', 'tas-regime')),
          event_time TIMESTAMPTZ NOT NULL,
          symbol TEXT NOT NULL,
          fingerprint TEXT NOT NULL UNIQUE,
          row_data JSONB NOT NULL
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS replay_import_ticks_range
        ON replay_v31.replay_import_ticks (section, symbol, event_time, fingerprint)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS replay_v31.replay_imports (
          id BIGSERIAL PRIMARY KEY,
          section TEXT NOT NULL CHECK (section IN ('gcv', 'taq-pro', 'tas-regime')),
          filename TEXT NOT NULL,
          imported_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          data_start TIMESTAMPTZ,
          data_end TIMESTAMPTZ,
          row_count INTEGER NOT NULL DEFAULT 0,
          raw_row_count INTEGER NOT NULL DEFAULT 0,
          raw_inserted INTEGER NOT NULL DEFAULT 0,
          raw_duplicate_rows INTEGER NOT NULL DEFAULT 0,
          raw_file_hash TEXT NOT NULL DEFAULT '',
          bar_count INTEGER NOT NULL DEFAULT 0,
          interval_sec INTEGER,
          bars JSONB NOT NULL DEFAULT '[]'::jsonb,
          source TEXT NOT NULL DEFAULT 'manual',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS replay_imports_range
        ON replay_v31.replay_imports (section, data_start, data_end)
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS replay_imports_latest
        ON replay_v31.replay_imports (section, imported_at DESC)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS replay_v31.replay_raw_events (
          section TEXT NOT NULL CHECK (section IN ('gcv', 'taq-pro', 'tas-regime')),
          event_time TIMESTAMPTZ,
          source_timestamp TEXT NOT NULL DEFAULT '',
          source_file TEXT NOT NULL,
          file_hash TEXT NOT NULL,
          row_index INTEGER NOT NULL,
          archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          row_data JSONB NOT NULL,
          PRIMARY KEY (section, file_hash, row_index)
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS replay_raw_events_time
        ON replay_v31.replay_raw_events (section, event_time, row_index)
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS replay_v31.replay_orderflow_derived (
          event_key TEXT PRIMARY KEY,
          section TEXT NOT NULL CHECK (section IN ('gcv', 'taq-pro', 'tas-regime')),
          kind TEXT NOT NULL CHECK (kind IN ('tp', 'regime', 'agent')),
          source TEXT NOT NULL DEFAULT '',
          engine_version TEXT NOT NULL DEFAULT '',
          event_time TIMESTAMPTZ,
          payload JSONB NOT NULL,
          stored_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE INDEX IF NOT EXISTS replay_orderflow_latest
        ON replay_v31.replay_orderflow_derived (section, kind, event_time DESC, stored_at DESC)
      `);
      initialized = true;
    })();
    initializing.catch(() => { initializing = null });
  }
  return initializing;
}

async function health() {
  await initialize();
  const result = await pool.query(`
    SELECT current_database() AS database,
      EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') AS timescale
  `);
  return { database: result.rows[0].database, timescale: result.rows[0].timescale };
}

async function counts() {
  await initialize();
  const result = await pool.query(`
    SELECT dataset, symbol, COUNT(*)::bigint AS rows, MIN(event_time) AS first, MAX(event_time) AS last
    FROM public.itr_market_ticks
    GROUP BY dataset, symbol
    ORDER BY dataset, symbol
  `);
  return result.rows;
}

async function tickCoverage(section, { symbol = DEFAULT_SYMBOL, timeZone = 'UTC', from, to }) {
  sectionOrThrow(section);
  await initialize();
  const dataset = DATASET_BY_SECTION[section];
  const bounds = await pool.query(`
    SELECT (SELECT MIN(event_time) FROM public.itr_market_ticks WHERE dataset = $1 AND symbol = $2) AS first,
           (SELECT MAX(event_time) FROM public.itr_market_ticks WHERE dataset = $1 AND symbol = $2) AS last
  `, [dataset, symbol]);
  const { first, last } = bounds.rows[0];
  if (!first || !last) return { first: null, last: null, days: [], timeZone, maxRangeRows: MAX_RANGE_ROWS };
  const upper = to || new Date(new Date(last).getTime() + 1000);
  const lower = from || new Date(upper.getTime() - 31 * 86400000);
  const client = await pool.connect();
  try {
    await client.query('SET statement_timeout = 30000');
    const days = await client.query(`
      WITH calendar AS (
        SELECT generated.day_value::date AS day_value
        FROM generate_series(
          (($4::timestamptz AT TIME ZONE $3)::date)::timestamp,
          ((($5::timestamptz - interval '1 microsecond') AT TIME ZONE $3)::date)::timestamp,
          interval '1 day'
        ) AS generated(day_value)
      )
      SELECT to_char(calendar.day_value, 'YYYY-MM-DD') AS day,
             bounded.ticks,
             bounded.ticks > $6 - 1 AS "ticksTruncated"
      FROM calendar
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS ticks
        FROM (
          SELECT 1
          FROM public.itr_market_ticks
          WHERE dataset = $1 AND symbol = $2
            AND event_time >= (calendar.day_value::timestamp AT TIME ZONE $3)
            AND event_time < ((calendar.day_value::timestamp + interval '1 day') AT TIME ZONE $3)
          LIMIT $6
        ) sampled
      ) bounded
      WHERE bounded.ticks > 0
      ORDER BY calendar.day_value DESC
    `, [dataset, symbol, timeZone, lower, upper, MAX_RANGE_ROWS + 1]);
    return {
      first, last, timeZone, maxRangeRows: MAX_RANGE_ROWS,
      from: lower, to: upper,
      days: days.rows.map(row => ({
        day: row.day,
        ticks: row.ticks,
        ticksTruncated: row.ticksTruncated,
        fits: row.ticks <= MAX_RANGE_ROWS,
      }))
    };
  } finally {
    try { await client.query('RESET statement_timeout') } catch { /* connection is released anyway */ }
    client.release();
  }
}

async function querySharedTicks(section, { start, end, symbol = DEFAULT_SYMBOL, limit = MAX_RANGE_ROWS }) {
  sectionOrThrow(section);
  await initialize();
  const result = await pool.query(`
    SELECT row_data, event_time, symbol, trade_price, direction, bid, ask, volume
    FROM public.itr_market_ticks
    WHERE dataset = $1 AND symbol = $2 AND event_time >= $3 AND event_time <= $4
    ORDER BY event_time, sequence_no, event_id
    LIMIT $5
  `, [DATASET_BY_SECTION[section], symbol, start, end, limit]);
  const value = (...candidates) => {
    for (const candidate of candidates) {
      if (candidate !== null && candidate !== undefined && candidate !== '') return candidate;
    }
    return undefined;
  };
  return result.rows.map(row => {
    const data = row.row_data || {};
    return {
      ...data,
      last: value(row.trade_price, data.last, data.TRDPRC_1, data.Last, data.LAST),
      bid: value(data.bid, data.BID, data.Bid, row.bid),
      ask: value(data.ask, data.ASK, data.Ask, data.OFFER, row.ask),
      tick: value(data.tick, data.PRCTCK_1, data.TICK, row.direction),
      bSize: value(data.bSize, data.BIDSIZE, data.BID_SIZE, data.BidSize),
      aSize: value(data.aSize, data.ASKSIZE, data.ASK_SIZE, data.AskSize),
      trdVol: value(data.trdVol, data.TRDVOL_1, data.TRDVOL, data.VOLUME, row.volume),
      volume: value(data.volume, data.VOLUME, data.TRDVOL_1, row.volume),
      aggr: value(data.aggr, data.AGGRS_SID1, data.AGGRESSIVE, data.SIDE),
      moves: value(data.moves, data.RTL, data.RT_COUNT),
      rtCount: value(data.rtCount, data.RT_COUNT, data.RTL),
      seqNum: value(data.seqNum, data.SEQNUM, data.SEQ_NUM),
      Symbol: row.symbol,
      _tsMs: new Date(row.event_time).getTime(),
    };
  });
}

async function queryImportedTicks(section, { start, end, symbol = DEFAULT_SYMBOL, limit = MAX_RANGE_ROWS }) {
  sectionOrThrow(section);
  await initialize();
  const values = [section, symbol];
  const conditions = ['section = $1', 'symbol = $2'];
  if (start) { values.push(start); conditions.push(`event_time >= $${values.length}`) }
  if (end) { values.push(end); conditions.push(`event_time <= $${values.length}`) }
  values.push(limit);
  const result = await pool.query(`
    SELECT row_data, event_time, symbol
    FROM replay_v31.replay_import_ticks
    WHERE ${conditions.join(' AND ')}
    ORDER BY event_time, fingerprint
    LIMIT $${values.length}
  `, values);
  return result.rows.map(row => ({
    ...row.row_data,
    Symbol: row.symbol,
    _tsMs: new Date(row.event_time).getTime(),
  }));
}

async function storeRawRows(section, rows, defaultSymbol = DEFAULT_SYMBOL) {
  sectionOrThrow(section);
  await initialize();
  let invalidTimestamp = 0;
  const unique = new Map();
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const ts = parseTimestamp(row);
    if (!ts) { invalidTimestamp++; continue }
    const symbol = getSymbol(row, defaultSymbol);
    const fingerprint = crypto.createHash('sha256')
      .update(`${section}|${symbol}|${ts.toISOString()}|${JSON.stringify(stableValue(row))}`)
      .digest('hex');
    unique.set(fingerprint, { ts, symbol, fingerprint, row });
  }
  const docs = [...unique.values()];
  let inserted = 0;
  for (let offset = 0; offset < docs.length; offset += 500) {
    const chunk = docs.slice(offset, offset + 500);
    const values = [];
    const tuples = chunk.map((doc, i) => {
      const n = i * 5;
      values.push(section, doc.ts, doc.symbol, doc.fingerprint, JSON.stringify(doc.row));
      return `($${n + 1}, $${n + 2}, $${n + 3}, $${n + 4}, $${n + 5}::jsonb)`;
    });
    const result = await pool.query(`
      INSERT INTO replay_v31.replay_import_ticks (section, event_time, symbol, fingerprint, row_data)
      VALUES ${tuples.join(', ')}
      ON CONFLICT (fingerprint) DO NOTHING
    `, values);
    inserted += result.rowCount;
  }
  const valid = docs.length;
  return { inserted, duplicates: valid - inserted, invalidTimestamp, valid };
}

function importRow(row, includeBars = true) {
  return {
    _id: String(row.id),
    id: String(row.id),
    filename: row.filename,
    importedAt: row.imported_at,
    dataStart: row.data_start,
    dataEnd: row.data_end,
    rowCount: row.row_count,
    rawRowCount: row.raw_row_count,
    rawInserted: row.raw_inserted,
    rawDuplicateRows: row.raw_duplicate_rows,
    rawFileHash: row.raw_file_hash,
    barCount: row.bar_count,
    intervalSec: row.interval_sec,
    ...(includeBars ? { bars: row.bars } : {}),
    source: row.source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function createImport(section, input) {
  sectionOrThrow(section);
  await initialize();
  const result = await pool.query(`
    INSERT INTO replay_v31.replay_imports
      (section, filename, row_count, raw_row_count, raw_inserted, raw_duplicate_rows,
       raw_file_hash, bar_count, interval_sec, bars, source, data_start, data_end)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
    RETURNING *
  `, [
    section, input.filename, input.rowCount || 0, input.rawRowCount || 0,
    input.rawInserted || 0, input.rawDuplicateRows || 0, input.rawFileHash || '',
    input.barCount || 0, input.intervalSec || null, JSON.stringify(input.bars || []),
    input.source || 'manual', input.dataStart || null, input.dataEnd || null,
  ]);
  return importRow(result.rows[0]);
}

async function findImport(section, id) {
  sectionOrThrow(section);
  await initialize();
  const result = await pool.query(
    'SELECT * FROM replay_v31.replay_imports WHERE section = $1 AND id = $2',
    [section, id]
  );
  return result.rows[0] ? importRow(result.rows[0]) : null;
}

async function closestImport(section, at) {
  sectionOrThrow(section);
  await initialize();
  const containing = await pool.query(`
    SELECT * FROM replay_v31.replay_imports
    WHERE section=$1 AND data_start <= $2 AND data_end >= $2
    ORDER BY data_start DESC LIMIT 1
  `, [section, at]);
  if (containing.rows[0]) return importRow(containing.rows[0], false);

  const [previous, next] = await Promise.all([
    pool.query(`SELECT * FROM replay_v31.replay_imports WHERE section=$1 AND data_end <= $2 ORDER BY data_end DESC LIMIT 1`, [section, at]),
    pool.query(`SELECT * FROM replay_v31.replay_imports WHERE section=$1 AND data_start >= $2 ORDER BY data_start ASC LIMIT 1`, [section, at]),
  ]);
  const prev = previous.rows[0], following = next.rows[0];
  if (!prev) return following ? importRow(following, false) : null;
  if (!following) return importRow(prev, false);
  const prevDistance = at.getTime() - new Date(prev.data_end).getTime();
  const nextDistance = new Date(following.data_start).getTime() - at.getTime();
  return importRow(prevDistance <= nextDistance ? prev : following, false);
}

async function listImports(section, { limit = 50, before, at } = {}) {
  sectionOrThrow(section);
  await initialize();
  if (at) {
    const closest = await closestImport(section, at);
    return closest ? [closest] : [];
  }
  const values = [section], where = ['section=$1'];
  if (before) { values.push(before); where.push(`imported_at <= $${values.length}`) }
  values.push(limit);
  const result = await pool.query(`
    SELECT id, section, filename, imported_at, data_start, data_end, row_count, raw_row_count,
      raw_inserted, raw_duplicate_rows, raw_file_hash, bar_count, interval_sec, source, created_at, updated_at
    FROM replay_v31.replay_imports
    WHERE ${where.join(' AND ')}
    ORDER BY imported_at DESC
    LIMIT $${values.length}
  `, values);
  return result.rows.map(row => importRow(row, false));
}

async function deleteImport(section, id) {
  sectionOrThrow(section);
  await initialize();
  const result = await pool.query(
    'DELETE FROM replay_v31.replay_imports WHERE section=$1 AND id=$2',
    [section, id]
  );
  return result.rowCount > 0;
}

async function storeRawEvents(section, events) {
  sectionOrThrow(section);
  await initialize();
  let inserted = 0, invalidTimestamp = 0;
  for (let offset = 0; offset < events.length; offset += 500) {
    const chunk = events.slice(offset, offset + 500);
    const values = [];
    const tuples = chunk.map((event, i) => {
      const n = i * 7;
      if (!event.ts) invalidTimestamp++;
      values.push(section, event.ts, event.sourceTimestamp || '', event.sourceFile, event.fileHash, event.rowIndex, JSON.stringify(event.raw));
      return `($${n + 1},$${n + 2},$${n + 3},$${n + 4},$${n + 5},$${n + 6},$${n + 7}::jsonb)`;
    });
    const result = await pool.query(`
      INSERT INTO replay_v31.replay_raw_events
        (section,event_time,source_timestamp,source_file,file_hash,row_index,row_data)
      VALUES ${tuples.join(',')}
      ON CONFLICT (section,file_hash,row_index) DO NOTHING
    `, values);
    inserted += result.rowCount;
  }
  return { valid: events.length, inserted, duplicates: events.length - invalidTimestamp - inserted, invalidTimestamp };
}

async function countOrderflow() {
  await initialize();
  const result = await pool.query(`
    SELECT kind, COUNT(*)::bigint AS count
    FROM replay_v31.replay_orderflow_derived GROUP BY kind
  `);
  return Object.fromEntries(ALLOWED_KINDS.map(kind => [kind, Number(
    result.rows.find(row => row.kind === kind)?.count || 0
  )]));
}

async function saveOrderflow(doc) {
  await initialize();
  const result = await pool.query(`
    INSERT INTO replay_v31.replay_orderflow_derived
      (event_key,section,kind,source,engine_version,event_time,payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
    ON CONFLICT (event_key) DO NOTHING
    RETURNING event_key
  `, [doc.eventKey, doc.section, doc.kind, doc.source, doc.engineVersion, doc.ts, JSON.stringify(doc.payload)]);
  return result.rowCount > 0;
}

async function latestOrderflow(section, kind, limit) {
  await initialize();
  const result = await pool.query(`
    SELECT event_time,stored_at,source,engine_version,event_key,payload
    FROM replay_v31.replay_orderflow_derived
    WHERE section=$1 AND kind=$2
    ORDER BY event_time DESC NULLS LAST,stored_at DESC
    LIMIT $3
  `, [section, kind, limit]);
  return result.rows.map(row => ({
    ts: row.event_time,
    storedAt: row.stored_at,
    source: row.source,
    engineVersion: row.engine_version,
    eventKey: row.event_key,
    payload: row.payload,
  }));
}

async function close() {
  await pool.end();
}

module.exports = {
  ALLOWED_SECTIONS, ALLOWED_KINDS, DEFAULT_SYMBOL, MAX_RANGE_ROWS, pool,
  initialize, health, counts, tickCoverage, querySharedTicks, queryImportedTicks, storeRawRows,
  createImport, findImport, closestImport, listImports, deleteImport,
  storeRawEvents, countOrderflow, saveOrderflow, latestOrderflow, close,
};
