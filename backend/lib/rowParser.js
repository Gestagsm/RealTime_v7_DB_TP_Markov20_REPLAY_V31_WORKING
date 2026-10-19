// lib/rowParser.js
//
// Server-side port of the EXACT row-parsing pipeline used by the TAQ Pro /
// TAS Regime frontends (COLMAP → normR → _fillNaN → dedup → _applyDiffs).
// This lets the folder watcher (watcher.js) turn a raw TAQ/TAS file into
// the *same* row shape the browser produces after a manual import, so
// whatever lands in PostgreSQL via the watcher looks identical to whatever
// would have landed there via a manual upload.
//
// Kept as plain Node-safe JS (no DOM, no FileReader) — only dependency is
// the `xlsx` package already used elsewhere in this backend.

const XLSX = require('xlsx');

/* ============================================================
   COLMAP – header aliases for auto-detection
   (copied verbatim from sections/taq-pro/script.js — identical in
   sections/tas-regime/script.js)
   ============================================================ */
const COLMAP = {
  date:     ['Date of Update','DATE','Date','Timestamp','TIMESTAMP','Date_Time','DATETIME','DATE_TIME'],
  time:     ['TIMEACT NS','Timeact NS','TIME','Time','Timestamp','TIMESTAMP'],
  tick:     ['PRCTCK_1','Tick','TICK','PRICE_TICK','PriceTick'],
  aggr:     ['AGGRS_SID1','AGGRESSIVE ORD1','AGGRESSIVE OR','AGGRESSIVE','AGGR','AggrSide','Side','SIDE'],
  last:     ['TRDPRC_1','Last','LAST','LAST PRICE','Price','PRICE','TradePrice','Trade Price','Close','CLOSE'],
  bid:      ['BID','Bid','CF BID','BestBid','BEST_BID'],
  ask:      ['ASK','Ask','CF ASK','BestAsk','BEST_ASK','OFFER'],
  bSize:    ['BIDSIZE','B Size','B SIZE','BID SIZE','BSIZE','BidSize','Bid Size','BID_SIZE'],
  aSize:    ['ASKSIZE','A Size','A SIZE','ASK SIZE','ASIZE','AskSize','Ask Size','ASK_SIZE','OFFER SIZE'],
  numBid:   ['NUM BID ORDERS 1','NUM BID','NUM_BID_ORDERS','BidOrders','NumBidOrders'],
  numAsk:   ['NUM ASK ORDERS 1','NUM ASK ORD','NUM ASK','NUM_ASK_ORDERS','AskOrders','NumAskOrders'],
  numOrders:['NUMBER OF ORDERS','NUM ORDERS','#ORDERS','NumOrders','OrderCount'],
  trdVol:   ['TRDVOL_1','Trd.Vol','TRADE VOL','TRDVOL','Trade Volume','TradeVol','TRADE_VOL','ELIGBL TRD ACVOL'],
  volume:   ['TRDVOL_1','Volume','VOLUME','CF VOLUME','VOL','ELIGBL TRD ACVOL','CumVol','CUM_VOL'],
  tradeId:  ['TRADE_ID','TRD_ID','Trade ID','TRADEID','TradeID'],
  seqNum:   ['SEQNUM','SEQ_NUM','SEQ_Num','SEQ_ID','SEQ','Sequence','SequenceNum','SEQ_NUMBER'],
  moves:    ['RTL','RT_Count','RT_COUNT','RtCount','RTCount','Moves','MOVES'],
  rtCount:  ['RT_Count','RTL','RT_COUNT','RtCount','RTCount'],
  condKey:  ['QUALIFIERS','Qualifiers','QUALIFIER','Cond','COND','Condition','CONDITION','CondKey','cond_key'],
};

function _buildColCache(hdrs) {
  const cache = {};
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const hdrNorm = hdrs.map(norm);

  for (const [key, aliases] of Object.entries(COLMAP)) {
    let found = null;

    // Match declared aliases after harmless punctuation/spacing normalisation.
    for (const alias of aliases) {
      const idx = hdrNorm.indexOf(norm(alias));
      if (idx >= 0) { found = hdrs[idx]; break; }
    }

    // Exact normalised key fallback only.
    // Never use substring matching: numBid must not match BID,
    // and numAsk must not match ASK.
    if (!found) {
      const idx = hdrNorm.indexOf(norm(key));
      if (idx >= 0) found = hdrs[idx];
    }

    if (found) cache[key] = found;
  }
  return cache;
}
function _detectHeaderRow(arr, maxScan = 20) {
  const all = Object.values(COLMAP).flat().map(s => s.toLowerCase().trim());
  let bestRow = 0, bestScore = 0;
  for (let i = 0; i < Math.min(arr.length, maxScan); i++) {
    const row = (arr[i] || []).map(c => String(c || '').toLowerCase().trim());
    if (!row.length || row.every(c => !c)) continue;
    const score = row.filter(c => all.includes(c)).length;
    if (score > bestScore) { bestScore = score; bestRow = i; }
    if (score >= 3) break;
  }
  return bestRow;
}

function detectSectionFromHeaders(headers) {
  const names = new Set(headers.map(value => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')));
  if (names.has('timeactns') || names.has('aggressiveord1')) return 'gcv';
  if (names.has('aggrssid1') || (names.has('trdprc1') && names.has('trdvol1'))) return 'tas-regime';
  if (names.has('prctck1')) return 'taq-pro';
  return null;
}

function extractFileHeaders(ext, data) {
  if (ext === 'csv') {
    const lines = data.toString('utf8').split(/\r?\n/).filter(line => line.trim());
    const arr = lines.slice(0, 20).map(line => line.split(',').map(cell => cell.trim().replace(/^"|"$/g, '')));
    return arr[_detectHeaderRow(arr)] || [];
  }
  if (['xlsx', 'xlsm', 'xls'].includes(ext)) {
    const wb = XLSX.read(data, { type: 'buffer', cellDates: true, raw: false });
    const sn = wb.SheetNames.find(name => !name.startsWith('_xlnm') && !name.startsWith('xl/')) || wb.SheetNames[0];
    const arr = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '', raw: false });
    return (arr[_detectHeaderRow(arr)] || []).map(cell => String(cell || '').trim());
  }
  throw new Error(`Unsupported file type: .${ext}`);
}

function detectFileSection(ext, data) {
  return detectSectionFromHeaders(extractFileHeaders(ext, data));
}

function secToHHMMSS(s) {
  s = Math.round(s);
  return String(Math.floor(s / 3600)).padStart(2, '0') + ':' +
         String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ':' +
         String(s % 60).padStart(2, '0');
}

function normTime(t) {
  if (t === null || t === undefined || t === '') return '';
  const s = String(t).trim();
  if (!s || s === 'undefined' || s === 'null') return '';
  if (/^\d{1,2}:\d{2}/.test(s)) return s.substring(0, 8);
  if (s.includes(' ')) {
    const parts = s.split(' ');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (/^\d{1,2}:\d{2}/.test(parts[i])) return parts[i].substring(0, 8);
    }
  }
  const f = parseFloat(s);
  if (!isNaN(f) && f >= 0 && f < 1) return secToHHMMSS(Math.round(f * 86400));
  if (!isNaN(f) && f > 1) return secToHHMMSS(Math.round((f % 1) * 86400));
  return s;
}

/* ============================================================
   ROW NORMALISER (identical to normR() in the frontend)
   ============================================================ */
function normR(obj, hdrs, cc) {
  const g = k => { const h = cc[k]; return h != null ? (obj[h] != null ? obj[h] : '') : ''; };
  const n = v => { const x = parseFloat(String(v || '').replace(/,/g, '.')); return isNaN(x) ? 0 : x; };
  const s = v => String(v || '').trim().toUpperCase();
  const ts = v => String(v || '').trim();

  let dateVal = ts(g('date'));
  let timeVal = normTime(ts(g('time')));

  if (timeVal && timeVal.includes(' ') && timeVal.includes('-')) {
    const p = timeVal.split(' '); dateVal = dateVal || p[0]; timeVal = p[1] || timeVal;
  } else if (dateVal && dateVal.includes(' ') && dateVal.includes('-')) {
    const p = dateVal.split(' '); dateVal = p[0]; if (!timeVal) timeVal = p[1] || '';
  }

  let aggrVal = s(g('aggr'));
  if (aggrVal === 'B' || aggrVal === '1') aggrVal = 'BID';
  if (aggrVal === 'A' || aggrVal === '2' || aggrVal === 'S') aggrVal = 'ASK';

  let _rowTsMs = 0;
  if (dateVal && timeVal) {
    const _dm = dateVal.match(/(\d{4})-(\d{2})-(\d{2})/);
    const _tm = timeVal.match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (_dm && _tm) {
      const _d = new Date(+_dm[1], +_dm[2] - 1, +_dm[3], +_tm[1], +_tm[2], +_tm[3], 0);
      if (!isNaN(_d.getTime())) _rowTsMs = _d.getTime();
    }
  }
  if (!_rowTsMs) {
    const _raw = ts(g('date')) || ts(g('time')) || '';
    if (_raw) {
      const _em = _raw.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
      if (_em) {
        const _d2 = new Date(+_em[3], +_em[2] - 1, +_em[1], +_em[4], +_em[5], +_em[6], 0);
        if (!isNaN(_d2.getTime())) {
          _rowTsMs = _d2.getTime();
          if (!dateVal || !dateVal.match(/\d{4}-\d{2}-\d{2}/)) {
            dateVal = `${_em[3]}-${_em[2].padStart(2, '0')}-${_em[1].padStart(2, '0')}`;
          }
          if (!timeVal || !timeVal.match(/\d{2}:\d{2}:\d{2}/)) {
            timeVal = `${_em[4].padStart(2, '0')}:${_em[5]}:${_em[6]}`;
          }
        }
      }
      if (!_rowTsMs) {
        const _im = _raw.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
        if (_im) {
          const _d3 = new Date(+_im[1], +_im[2] - 1, +_im[3], +_im[4], +_im[5], +_im[6], 0);
          if (!isNaN(_d3.getTime())) _rowTsMs = _d3.getTime();
        }
      }
    }
  }

  return {
    _tsMs: _rowTsMs,
    date: dateVal, time: timeVal, aggr: aggrVal, tick: ts(g('tick')),
    last: n(g('last')), bid: n(g('bid')), ask: n(g('ask')),
    bSize: n(g('bSize')), aSize: n(g('aSize')),
    numBid: n(g('numBid')), numAsk: n(g('numAsk')), numOrders: n(g('numOrders')),
    trdVol: n(g('trdVol')), volume: n(g('volume')),
    moves: n(g('moves')),
    tradeId: ts(g('tradeId')),
    seqNum: n(g('seqNum')),
    rtCount: n(g('rtCount')),
    condKey: String(g('condKey') || '').replace(/[^\x20-\x7E]/g, '').trim(),
    QUALIFIERS: String(g('condKey') || '').replace(/[^\x20-\x7E]/g, '').trim(),
    volDiff: 0, movesDiff: 0, seqNumDiff: 0, trdIdDiff: 0,
  };
}

/* ============================================================
   _fillNaN — forward/back-fill sparse columns (identical to frontend)
   ============================================================ */
function _fillNaN(rows) {
  if (!rows.length) return rows;
  const ffill = (rows, field, isNum) => {
    let last = isNum ? 0 : '';
    rows.forEach(r => {
      const v = r[field];
      const empty = isNum ? (!v || v === 0) : (!v || v === '');
      if (!empty) last = v; else r[field] = last;
    });
  };
  const bfill = (rows, field, isNum) => {
    let first = isNum ? 0 : '';
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i][field];
      const empty = isNum ? (!v || v === 0) : (!v || v === '');
      if (!empty) first = v; else rows[i][field] = first;
    }
  };
  ['bid', 'ask', 'last', 'aggr', 'tick', 'seqNum', 'rtCount'].forEach(f => {
    ffill(rows, f, f !== 'aggr' && f !== 'tick');
    bfill(rows, f, f !== 'aggr' && f !== 'tick');
  });
  ['bSize', 'aSize', 'trdVol', 'volume', 'numBid', 'numAsk', 'numOrders', 'moves'].forEach(f => {
    rows.forEach(r => { if (!r[f]) r[f] = 0; });
  });
  rows.forEach(r => { if (!r.tradeId) r.tradeId = ''; });
  return rows;
}

/* ============================================================
   _applyDiffs — identical to frontend
   ============================================================ */
function _applyDiffs(rows) {
  if (!rows || rows.length < 1) return rows;

  for (let i = 0; i < rows.length; i++) {
    const curr = parseFloat(rows[i].volume) || 0;
    const next = parseFloat(rows[i + 1] && rows[i + 1].volume) || 0;
    rows[i].volDiff = (i < rows.length - 1) ? Math.abs(next - curr) : 0;
  }

  for (let i = 0; i < rows.length; i++) {
    const curr = parseFloat(rows[i].seqNum) || 0;
    const next = parseFloat(rows[i + 1] && rows[i + 1].seqNum) || 0;
    const d = (i < rows.length - 1) ? Math.abs(next - curr) : NaN;
    rows[i].seqNumDiff = isFinite(d) ? d : (curr % 100);
  }

  function _rtlCounterDiff(src) {
    for (let i = 0; i < rows.length; i++) {
      const curr = parseFloat(rows[i][src]);
      const next = (i < rows.length - 1) ? parseFloat(rows[i + 1][src]) : NaN;
      let d = 0;
      if (Number.isFinite(curr) && Number.isFinite(next)) {
        d = next >= curr ? (next - curr) : Math.max(0, next);
      }
      rows[i].movesDiff = Number.isFinite(d) ? d : 0;
    }
  }
  if (rows.some(r => Number.isFinite(parseFloat(r.moves)) && parseFloat(r.moves) !== 0)) _rtlCounterDiff('moves');
  else if (rows.some(r => Number.isFinite(parseFloat(r.rtCount)) && parseFloat(r.rtCount) !== 0)) _rtlCounterDiff('rtCount');
  else rows.forEach(r => { r.movesDiff = 0; });

  for (let i = 0; i < rows.length; i++) {
    const curr = parseFloat(rows[i].tradeId) || 0;
    const next = parseFloat(rows[i + 1] && rows[i + 1].tradeId) || 0;
    rows[i].trdIdDiff = (i < rows.length - 1) ? Math.abs(next - curr) : 0;
  }
  const trdSum = rows.reduce((s, r) => s + (r.trdIdDiff || 0), 0);
  if (trdSum === 0) { rows.forEach(r => { r.trdIdDiff = r.seqNumDiff || 0; }); }

  return rows;
}

/* ============================================================
   dedup — identical to frontend
   ============================================================ */
function dedup(rows) {
  const seen = new Set();
  let splIdx = 0;

  const cleanQ = v => String(v ?? '').replace(/[^\x20-\x7E]/g, '').trim().toUpperCase();
  const nk = v => {
    if (v === undefined || v === null) return '';
    const n = Number(String(v).replace(',', '.'));
    if (Number.isFinite(n)) return String(Math.round(n * 1000000) / 1000000);
    return String(v).trim();
  };

  return (rows || []).filter(r => {
    const isSplRow = cleanQ(r.condKey || r.QUALIFIERS || r.qualifiers || '').includes('SPL TRD');

    if (isSplRow) {
      const k = ['spl', nk(r.date), nk(r.time), nk(r.last), nk(r.bid), nk(r.ask),
        nk(r.trdVol), nk(r.volume), nk(r.tradeId), nk(r.seqNum), nk(r.moves), splIdx++].join('|');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }

    const k = ['row', nk(r.date), nk(r.time), nk(r.last), nk(r.bid), nk(r.ask),
      nk(r.bSize), nk(r.aSize), nk(r.numBid), nk(r.numAsk), nk(r.numOrders),
      nk(r.trdVol), nk(r.volume), nk(r.tradeId), nk(r.seqNum), nk(r.moves), nk(r.rtCount),
      nk(r.aggr), nk(r.tick)].join('|');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* ============================================================
   Format helpers for xlsx date cells (identical to frontend's parseFile)
   ============================================================ */
function _fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function _normCell(v) {
  if (v instanceof Date && !isNaN(v.getTime())) return _fmtDate(v);
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  const em = s.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (em) {
    const d2 = new Date(+em[3], +em[2] - 1, +em[1], +em[4], +em[5], +(em[6] || 0), 0);
    if (!isNaN(d2.getTime())) return _fmtDate(d2);
  }
  const em2 = s.match(/^(\d{1,2})\/(\d{2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (em2) {
    const d3 = new Date(+em2[3], +em2[2] - 1, +em2[1], +em2[4], +em2[5], +(em2[6] || 0), 0);
    if (!isNaN(d3.getTime())) return _fmtDate(d3);
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (us) {
    const d4 = new Date(+us[3], +us[1] - 1, +us[2], +us[4], +us[5], +(us[6] || 0), 0);
    if (!isNaN(d4.getTime())) return _fmtDate(d4);
  }
  return s;
}

/* ============================================================
   parseCSVText — identical logic to frontend's parseCSVText
   ============================================================ */
function parseCSVText(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) throw new Error('Empty CSV');
  const arr = lines.map(l => l.split(',').map(c => c.trim().replace(/^"|"$/g, '')));
  const hi = _detectHeaderRow(arr);
  const hdrs = (arr[hi] || []).map(c => String(c || '').trim());
  const cc = _buildColCache(hdrs);
  const rows = [];
  for (let i = hi + 1; i < arr.length; i++) {
    const r = arr[i]; if (!r || r.every(c => !c)) continue;
    const obj = {}; hdrs.forEach((h, j) => { if (h) obj[h] = r[j] ?? ''; });
    rows.push(normR(obj, hdrs, cc));
  }
  if (!rows.length) throw new Error('File contains no data rows.');
  return _fillNaN(rows);
}

/* ============================================================
   parseWorkbookBuffer — identical logic to frontend's parseFile()
   xlsx branch, reading from a Node Buffer instead of FileReader
   ============================================================ */
function parseWorkbookBuffer(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sn = wb.SheetNames.find(n => !n.startsWith('_xlnm') && !n.startsWith('xl/')) || wb.SheetNames[0];
  const ws = wb.Sheets[sn];
  const arr = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const hi = _detectHeaderRow(arr);
  const hdrs = (arr[hi] || []).map(c => String(c || '').trim());
  if (!hdrs.filter(Boolean).length) throw new Error(`No header row in "${sn}".`);
  const cc = _buildColCache(hdrs);

  const _tsHdrIdx = hdrs.findIndex(h => /^timestamp$/i.test(h) || /^date$/i.test(h) || /^datetime$/i.test(h));

  const rows = [];
  for (let i = hi + 1; i < arr.length; i++) {
    const r = arr[i];
    if (!r || r.every(c => c === '' || c === null || c === undefined)) continue;
    const obj = {};
    hdrs.forEach((h, j) => { if (h) obj[h] = _normCell(r[j]); });

    let _preTs = 0;
    if (_tsHdrIdx >= 0) {
      const rawCell = r[_tsHdrIdx];
      if (rawCell instanceof Date && !isNaN(rawCell.getTime())) {
        _preTs = rawCell.getTime();
      } else if (rawCell) {
        const _rs = String(rawCell).trim();
        const _im = _rs.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2}):(\d{2})/);
        if (_im) {
          const _d = new Date(+_im[1], +_im[2] - 1, +_im[3], +_im[4], +_im[5], +_im[6], 0);
          if (!isNaN(_d.getTime())) _preTs = _d.getTime();
        }
        if (!_preTs) {
          const _em = _rs.match(/^(\d{1,2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
          if (_em) {
            const _d2 = new Date(+_em[3], +_em[2] - 1, +_em[1], +_em[4], +_em[5], +_em[6], 0);
            if (!isNaN(_d2.getTime())) _preTs = _d2.getTime();
          }
        }
        if (!_preTs) {
          const _us = _rs.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})/);
          if (_us) {
            const _d3 = new Date(+_us[3], +_us[1] - 1, +_us[2], +_us[4], +_us[5], +_us[6], 0);
            if (!isNaN(_d3.getTime())) _preTs = _d3.getTime();
          }
        }
      }
    }
    const row = normR(obj, hdrs, cc);
    if (_preTs > 0) row._tsMs = _preTs;
    rows.push(row);
  }
  if (!rows.length) throw new Error(`No data rows in "${sn}".`);
  return _fillNaN(rows);
}

/* ============================================================
   finalizeRows — mirrors exactly what the frontend does right after
   parseFile() returns, before storing rows in _allRawRows/_tlRows:
     dedup → keep priced/SPL rows only → sort by _tsMs → _applyDiffs
   ============================================================ */
// `quoteOnly` keeps rows that have a bid or ask even with no trade/"last"
// price — needed for genuinely quote-only TAQ files (BID/ASK/BIDSIZE/
// ASKSIZE, no price column at all), where the frontend's own last>0 filter
// would otherwise drop every single row. TAS/GCV keep the original,
// stricter last>0-or-SPL rule unchanged.
function _prepareQuoteOnlyRow(r) {
  let tick = String(r.tick || '').trim();
  const u = tick.toUpperCase();

  const isDown =
    tick.includes('\u21E9') ||
    tick.includes('\u00E2\u2021\u00A9') ||
    u === 'DOWN' || u === '-' || u === 'BID' || u === 'SELL' || u === 'HIT';

  const isUp =
    tick.includes('\u21E7') ||
    tick.includes('\u00E2\u2021\u00A7') ||
    u === 'UP' || u === '+' || u === 'ASK' || u === 'BUY' || u === 'LIFT';

  // Canonicalise tick so PostgreSQL/frontend receives the real arrow.
  if (isDown) tick = '\u21E9';
  else if (isUp) tick = '\u21E7';
  r.tick = tick;

  // TAQ source has PRCTCK_1 but no AGGRS_SID1.
  if (!r.aggr) {
    if (isDown) r.aggr = 'BID';
    else if (isUp) r.aggr = 'ASK';
  }

  // TAQ source has no TRDPRC_1/Last. Give the candle builder a
  // side-aware quote price without changing TAS/GCV behavior.
  if (!(Number(r.last) > 0)) {
    const bid = Number(r.bid) || 0;
    const ask = Number(r.ask) || 0;

    if (r.aggr === 'BID' && bid > 0) r.last = bid;
    else if (r.aggr === 'ASK' && ask > 0) r.last = ask;
    else if (bid > 0 && ask > 0) r.last = (bid + ask) / 2;
    else r.last = bid || ask || 0;
  }

  return r;
}
function finalizeRows(rawRows, { quoteOnly = false } = {}) {
  if (quoteOnly) (rawRows || []).forEach(_prepareQuoteOnlyRow);
  const _isSplRow = r => {
    const q = String(r.condKey || r.QUALIFIERS || '').replace(/[^\x20-\x7E]/g, '').trim().toUpperCase();
    return q.includes('SPL TRD');
  };
  const rows = dedup(rawRows).filter(r =>
    r.last > 0 || _isSplRow(r) || (quoteOnly && (r.bid > 0 || r.ask > 0)));
  rows.sort((a, b) => {
    const aMs = a._tsMs || Number.MAX_SAFE_INTEGER;
    const bMs = b._tsMs || Number.MAX_SAFE_INTEGER;
    return aMs - bMs;
  });
  _applyDiffs(rows);
  return rows;
}

/* ============================================================
   extractDateFromFilename / _applyDateFallback
   ─────────────────────────────────────────────────────────────
   Some real files (e.g. GCV/"Pro Single-Display" exports) only carry a
   TIME-OF-DAY column (e.g. "TIMEACT NS" = "7:31:35") with no date column
   at all — so every row would otherwise get _tsMs=0 and can never be
   found by a date-range query. The filename itself carries the real
   calendar date (e.g. "GCv1__2026-01-27_12-10.xlsx" → 2026-01-27), the
   same convention the existing browser Watch Folder already uses to pick
   files by date — so we reuse it here as a fallback, giving those rows a
   correct absolute timestamp instead of silently losing the date.
   Rows that already have a real per-row date (TAQ/TAS "Timestamp" column)
   are left untouched.
   ============================================================ */
function extractDateFromFilename(name) {
  const m = String(name || '').match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})(?:[_\s-]?(\d{2})[-:h]?(\d{2})?)?/);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h || 0), Number(mi || 0));
  return isNaN(dt.getTime()) ? null : dt;
}

function _applyDateFallback(rows, fallbackDate) {
  if (!fallbackDate) return rows;
  const y = fallbackDate.getFullYear(), mo = fallbackDate.getMonth(), d = fallbackDate.getDate();
  rows.forEach(r => {
    if (r._tsMs > 0) return; // already has a real per-row date — leave it alone
    if (!r.time) return; // nothing to combine the date with
    const tm = String(r.time).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (!tm) return;
    const dt = new Date(y, mo, d, +tm[1], +tm[2], +(tm[3] || 0), 0);
    if (isNaN(dt.getTime())) return;
    r._tsMs = dt.getTime();
    if (!r.date) {
      const p = n => String(n).padStart(2, '0');
      r.date = `${y}-${p(mo + 1)}-${p(d)}`;
    }
  });
  return rows;
}

/* Reads a file (by extension) into finalized rows, ready to store.
   opts.dateFallback: a Date whose Y/M/D is used to complete rows that
   have a time but no date of their own (see above). */
function parseAndFinalize(ext, data, opts = {}) {
  let raw;
  if (ext === 'csv') raw = parseCSVText(data.toString('utf8'));
  else if (['xlsx', 'xlsm', 'xls'].includes(ext)) raw = parseWorkbookBuffer(data);
  else throw new Error(`Unsupported file type: .${ext}`);
  if (opts.dateFallback) _applyDateFallback(raw, opts.dateFallback);
  return finalizeRows(raw, opts);
}

module.exports = {
  COLMAP, parseCSVText, parseWorkbookBuffer, finalizeRows, parseAndFinalize, extractDateFromFilename,
  detectSectionFromHeaders, extractFileHeaders, detectFileSection,
};
