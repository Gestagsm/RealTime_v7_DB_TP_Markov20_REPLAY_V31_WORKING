function validDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

function rowMs(row) {
  if (!row) return 0;
  if (Number.isFinite(Number(row._tsMs)) && Number(row._tsMs) > 0) return Number(row._tsMs);
  const raw = row.date && row.time ? `${row.date} ${row.time}` : (row.Timestamp || row.timestamp || '');
  const ms = Date.parse(String(raw).replace('T', ' ').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function barMs(bar, useEnd = false) {
  if (!bar) return 0;
  if (Number.isFinite(Number(bar._tsMs)) && Number(bar._tsMs) > 0) return Number(bar._tsMs);
  if (Number.isFinite(Number(bar.startMs)) && Number(bar.startMs) > 0 && !useEnd) return Number(bar.startMs);
  if (Number.isFinite(Number(bar.endMs)) && Number(bar.endMs) > 0 && useEnd) return Number(bar.endMs);
  const time = useEnd ? (bar.timeEnd || bar.time || '') : (bar.time || '');
  const raw = bar.date && time ? `${bar.date} ${time}` : (bar.Timestamp || bar.timestamp || '');
  const ms = Date.parse(String(raw).replace('T', ' ').trim());
  return Number.isFinite(ms) ? ms : 0;
}

function rangeFromRows(rows) {
  const values = (rows || []).map(rowMs).filter(ms => ms > 0).sort((a, b) => a - b);
  if (!values.length) return { dataStart: null, dataEnd: null };
  return { dataStart: new Date(values[0]), dataEnd: new Date(values[values.length - 1]) };
}

function rangeFromBars(bars) {
  const starts = (bars || []).map(b => barMs(b, false)).filter(ms => ms > 0);
  const ends = (bars || []).map(b => barMs(b, true)).filter(ms => ms > 0);
  const all = starts.concat(ends).sort((a, b) => a - b);
  if (!all.length) return { dataStart: null, dataEnd: null };
  return { dataStart: new Date(all[0]), dataEnd: new Date(all[all.length - 1]) };
}

function normalizeRange(dataStart, dataEnd, bars) {
  let start = validDate(dataStart);
  let end = validDate(dataEnd);
  if (!start || !end) {
    const derived = rangeFromBars(bars);
    start = start || derived.dataStart;
    end = end || derived.dataEnd;
  }
  if (start && end && start > end) [start, end] = [end, start];
  return { dataStart: start, dataEnd: end };
}

function distanceToRange(target, start, end) {
  const t = validDate(target);
  const s = validDate(start);
  const e = validDate(end);
  if (!t || !s || !e) return Number.POSITIVE_INFINITY;
  const tm = t.getTime(), sm = s.getTime(), em = e.getTime();
  if (tm >= sm && tm <= em) return 0;
  return tm < sm ? sm - tm : tm - em;
}

module.exports = { validDate, rowMs, rangeFromRows, rangeFromBars, normalizeRange, distanceToRange };
