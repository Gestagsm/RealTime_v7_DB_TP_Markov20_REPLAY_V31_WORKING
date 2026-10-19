const crypto = require('crypto');
const XLSX = require('xlsx');
const database = require('./postgres');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function parseSourceRows(ext, data) {
  ext = String(ext || '').toLowerCase();
  let wb;
  if (ext === 'csv' || ext === 'txt') {
    // CSV must be decoded as UTF-8 before XLSX parses it. Reading the Buffer
    // directly causes UTF-8 arrow characters to become mojibake.
    wb = XLSX.read(data.toString('utf8'), { type: 'string', raw: true });
  } else {
    wb = XLSX.read(data, { type: 'buffer', raw: true, cellDates: false });
  }
  const first = wb.SheetNames[0];
  if (!first) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[first], {
    defval: '',
    raw: true,
    blankrows: false,
  });
}

function firstValue(row, names) {
  for (const n of names) {
    if (row && row[n] !== undefined && row[n] !== null && String(row[n]).trim() !== '') return row[n];
  }
  return '';
}

function _pad2(n) {
  return String(n).padStart(2, '0');
}

function _pad3(n) {
  return String(n).padStart(3, '0');
}

function _formatExcelTimeFraction(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';

  let totalMs = Math.round(
    ((n % 1) + 1) % 1 * 86400000
  );

  if (totalMs >= 86400000) totalMs = 0;

  const hh = Math.floor(totalMs / 3600000);
  totalMs -= hh * 3600000;

  const mm = Math.floor(totalMs / 60000);
  totalMs -= mm * 60000;

  const ss = Math.floor(totalMs / 1000);
  const ms = totalMs - ss * 1000;

  let text =
    _pad2(hh) + ':' +
    _pad2(mm) + ':' +
    _pad2(ss);

  if (ms) text += '.' + _pad3(ms);

  return text;
}

function _formatExcelSerial(value) {
  const serial = Number(value);

  if (!Number.isFinite(serial)) return '';

  /*
    Excel 1900 date system.
    25569 = 1970-01-01.
    UTC is used here only to convert the Excel serial into
    calendar components without host-timezone shifting.
  */
  const excelEpochUtc = Date.UTC(1899, 11, 30);
  const msUtc = excelEpochUtc + Math.round(serial * 86400000);

  const d = new Date(msUtc);

  const yyyy = d.getUTCFullYear();
  const MM   = _pad2(d.getUTCMonth() + 1);
  const dd   = _pad2(d.getUTCDate());
  const hh   = _pad2(d.getUTCHours());
  const mm   = _pad2(d.getUTCMinutes());
  const ss   = _pad2(d.getUTCSeconds());
  const ms   = d.getUTCMilliseconds();

  let text =
    yyyy + '-' + MM + '-' + dd + ' ' +
    hh + ':' + mm + ':' + ss;

  if (ms) text += '.' + _pad3(ms);

  return text;
}

function _formatExcelDateOnly(value) {
  const serial = Number(value);

  if (!Number.isFinite(serial)) return '';

  const excelEpochUtc = Date.UTC(1899, 11, 30);
  const msUtc = excelEpochUtc +
    Math.floor(serial) * 86400000;

  const d = new Date(msUtc);

  return (
    d.getUTCFullYear() + '-' +
    _pad2(d.getUTCMonth() + 1) + '-' +
    _pad2(d.getUTCDate())
  );
}

function _parseSourceLocalTimestamp(text) {
  if (!text) return null;

  /*
    Deliberately parse without Z.
    This preserves the source/server local market-clock semantics
    used by the current application instead of treating Excel
    wall-clock values as UTC.
  */
  const normalized = String(text)
    .trim()
    .replace('T', ' ');

  const ms = Date.parse(normalized);

  return Number.isFinite(ms)
    ? new Date(ms)
    : null;
}

function sourceTimeInfo(row, dateFallback) {
  const full = firstValue(row, [
    'Timestamp',
    'TIMESTAMP',
    'timestamp',
    'DateTime',
    'DATETIME',
    'datetime',
    'DATE_TIME'
  ]);

  let text = '';

  /*
    TAS / Excel full timestamp:
      46227.83329861111
      -> 2026-07-24 19:59:57
  */
  if (
    typeof full === 'number' &&
    Number.isFinite(full) &&
    full >= 1
  ) {
    text = _formatExcelSerial(full);
  } else if (
    full !== '' &&
    full !== null &&
    full !== undefined
  ) {
    text = String(full).trim();
  }

  if (!text) {
    const dateValue = firstValue(row, [
      'Date of Update',
      'DATE',
      'Date',
      'date'
    ]);

    const timeValue = firstValue(row, [
      'TIMEACT NS',
      'Timeact NS',
      'TIME',
      'Time',
      'time'
    ]);

    let dateText = '';

    if (
      typeof dateValue === 'number' &&
      Number.isFinite(dateValue) &&
      dateValue >= 1
    ) {
      dateText = _formatExcelDateOnly(dateValue);
    } else if (
      dateValue !== '' &&
      dateValue !== null &&
      dateValue !== undefined
    ) {
      dateText = String(dateValue).trim();
    } else if (dateFallback) {
      dateText = String(dateFallback).trim();
    }

    let timeText = '';

    /*
      GCV / Excel time-only:
        0.313599537037037
        -> 07:31:35
    */
    if (
      typeof timeValue === 'number' &&
      Number.isFinite(timeValue)
    ) {
      if (timeValue >= 0 && timeValue < 1) {
        timeText = _formatExcelTimeFraction(timeValue);
      } else if (timeValue >= 1) {
        /*
          Some Excel exports put full serial datetime
          in a column nominally called TIME.
        */
        const serialText = _formatExcelSerial(timeValue);

        return {
          sourceTimestamp: serialText,
          ts: _parseSourceLocalTimestamp(serialText),
        };
      }
    } else if (
      timeValue !== '' &&
      timeValue !== null &&
      timeValue !== undefined
    ) {
      timeText = String(timeValue).trim();
    }

    if (dateText && timeText) {
      text = dateText + ' ' + timeText;
    } else if (dateText) {
      text = dateText;
    } else if (timeText) {
      text = timeText;
    }
  }

  return {
    sourceTimestamp: text,
    ts: _parseSourceLocalTimestamp(text),
  };
}

async function archiveSourceFile(section, filename, ext, data, options = {}) {
  const rows = parseSourceRows(ext, data);
  const fileHash = sha256(data);
  const dateFallback = options.dateFallback || '';

  if (!rows.length) {
    return { fileHash, valid: 0, inserted: 0, duplicates: 0, invalidTimestamp: 0 };
  }

  const events = rows.map((raw, index) => {
    const time = sourceTimeInfo(raw, dateFallback);
    return {
      ts: time.ts,
      sourceTimestamp: time.sourceTimestamp,
      sourceFile: filename,
      fileHash,
      rowIndex: index + 1,
      raw,
    };
  });
  const stored = await database.storeRawEvents(section, events);

  return {
    fileHash,
    valid: rows.length,
    inserted: stored.inserted,
    duplicates: Math.max(0, rows.length - stored.inserted),
    invalidTimestamp: stored.invalidTimestamp,
  };
}

module.exports = {
  sha256,
  parseSourceRows,
  sourceTimeInfo,
  archiveSourceFile,
};