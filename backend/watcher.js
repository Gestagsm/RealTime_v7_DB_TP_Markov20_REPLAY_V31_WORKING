// watcher.js
//
// Server-side "drop folder" watcher Ã¢â‚¬â€ runs as part of the itr-backend
// process (started from server.js after PostgreSQL connects), completely
// independent of any browser tab being open.
//
// Purpose: the external platform that produces TAQ and TAS data drops
// files into WATCH_DIR on its own schedule. This watcher polls that
// folder every WATCH_POLL_MS (default 1000ms = every second), and for
// every TAQ or TAS file it finds:
//   1. waits until the file's size/mtime are stable for one extra poll
//      (so a file that's still being written by the other platform is
//      never read half-finished)
//   2. parses it with the exact same row pipeline the frontend uses
//      (lib/rowParser.js), producing the same row shape as a manual
//      browser import
//   3. stores the rows in PostgreSQL and logs an Import record
//      (imports_taq_pro / imports_tas_regime, source: 'folder-watcher')
//   4. moves the source file into a persistent archive by origin and section,
//      or quarantines failed files under the source folder
//
// TAQ and TAS are watched at the same time, independently Ã¢â‚¬â€ one file
// failing or arriving late never blocks or affects the other.
//
// Once data is in PostgreSQL this way, the existing "DATA SOURCE: DATABASE"
// toggle in each section (already wired to /api/ticks/:section?start=&end=)
// picks it up for whatever date/time range is requested Ã¢â‚¬â€ no frontend
// changes needed.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const database = require('./lib/postgres');
const { parseAndFinalize, extractDateFromFilename, detectFileSection } = require('./lib/rowParser');
const { bucketByInterval } = require('./lib/barBuilder');
const { rangeFromRows } = require('./lib/dataRange');
const { archiveSourceFile } = require('./lib/rawArchive');

const WATCH_DIR = process.env.WATCH_DIR ? path.resolve(process.env.WATCH_DIR) : '';
const WATCH_HISTORY_DIR = process.env.WATCH_HISTORY_DIR ? path.resolve(process.env.WATCH_HISTORY_DIR) : '';
const WATCH_DIRS = [...new Set([WATCH_HISTORY_DIR, WATCH_DIR].filter(Boolean))];
const WATCH_ARCHIVE_DIR = process.env.WATCH_ARCHIVE_DIR
  ? path.resolve(process.env.WATCH_ARCHIVE_DIR)
  : path.join(__dirname, 'data', 'market-files');
const POLL_MS = parseInt(process.env.WATCH_POLL_MS, 10) || 1000;
const FAILED_DIRNAME = process.env.WATCH_FAILED_DIRNAME || '_failed';

// Filename Ã¢â€ â€™ section detection. Override the patterns via .env if the
// other platform names its exports differently (e.g. WATCH_TAQ_PATTERN).
// GCV files arrive already merged (trade+quote combined upstream, not
// computed by us) so they're stored as-is like TAS, no quoteOnly needed.
// Order matters: GCV is checked before TAQ/TAS so a filename containing
// both "GCV" and, say, "TAQ" is never mis-routed.
const SECTION_MATCHERS = [
  { section: 'gcv', re: new RegExp(process.env.WATCH_GCV_PATTERN || 'GCV', 'i') },
  { section: 'taq-pro', re: new RegExp(process.env.WATCH_TAQ_PATTERN || 'TAQ', 'i') },
  { section: 'tas-regime', re: new RegExp(process.env.WATCH_TAS_PATTERN || 'TAS', 'i') },
];

function detectSection(filename) {
  for (const m of SECTION_MATCHERS) {
    if (m.re.test(filename)) return m.section;
  }
  return null;
}

// filename -> { size, mtimeMs, stable } Ã¢â‚¬â€ tracks whether a file's stats
// have stopped changing across polls before we dare read it.
const _pending = new Map();

async function ingestFile(fullPath, filename, section) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  const data = await fsp.readFile(fullPath);
  const contentSection = detectFileSection(ext, data);
  if (contentSection && contentSection !== section) {
    throw new Error(`Filename routes to ${section}, but file headers identify ${contentSection}`);
  }

  // V6 LOSSLESS RAW ARCHIVE: preserve every source row BEFORE normalization,
  // filtering or deduplication. This shadow archive does not change the
  // existing normalized ticks/API path.
  const dateFallback = extractDateFromFilename(filename);
  const rawArchive = await archiveSourceFile(section, filename, ext, data, { dateFallback });
  if (!rawArchive.valid) throw new Error('No raw source rows found for lossless archive');
  console.log('[watcher] RAW archive ' + filename + ': ' + rawArchive.valid + ' rows, ' + rawArchive.inserted + ' new, ' + rawArchive.duplicates + ' retry-existing');
  // TAQ files are quote-only (BID/ASK/BIDSIZE/ASKSIZE, no trade price) Ã¢â‚¬â€
  // keep quote ticks even without a "last" price. TAS keeps the normal rule.
  // GCV files carry time-of-day only (no date column) Ã¢â‚¬â€ the filename's
  // embedded date fills in the missing calendar date for every row.
  const rows = parseAndFinalize(ext, data, {
    quoteOnly: section === 'taq-pro',
    dateFallback,
  });
  if (!rows.length) throw new Error('No data rows parsed from file');

  const stored = await database.storeRawRows(section, rows);
  if (!stored.valid) throw new Error('No rows had a valid historical timestamp');
  if (stored.duplicates) {
    console.log(`[watcher] ${stored.duplicates} duplicate ticks skipped for ${filename}`);
  }

  // Also pre-build candles (1-minute bars, default tick size 0.10 unless
  // overridden) and store them on the Import record Ã¢â‚¬â€ this is what makes
  // the existing "Ã°Å¸â€”â€ž Auto-load from Database" checkbox work immediately,
  // with zero frontend changes needed. TAQ (quote-only, no trade price)
  // will legitimately produce zero bars here Ã¢â‚¬â€ same as a manual browser
  // import would Ã¢â‚¬â€ since candles need a real "last" trade price. TAS and
  // GCV (which carry a real trade price) build normally.
  const barIntervalSec = parseInt(process.env.WATCH_BAR_INTERVAL_SEC, 10) || 60;
  const barTickSize = parseFloat(process.env.WATCH_BAR_TICK_SIZE) || 0.10;
  const bars = bucketByInterval(rows, barIntervalSec, barTickSize);

  const range = rangeFromRows(rows);
  await database.createImport(section, {
    filename,
    rowCount: rows.length,
    rawRowCount: rawArchive.valid,
    rawInserted: rawArchive.inserted,
    rawDuplicateRows: rawArchive.duplicates,
    rawFileHash: rawArchive.fileHash,
    barCount: bars.length,
    bars,
    source: 'folder-watcher',
    dataStart: range.dataStart,
    dataEnd: range.dataEnd,
  });

  return rows.length;
}

async function moveTo(fullPath, filename, destDir) {
  await fsp.mkdir(destDir, { recursive: true });
  let dest = path.join(destDir, filename);
  // Never overwrite an earlier same-named file in the destination Ã¢â‚¬â€
  // append a timestamp instead of silently clobbering it.
  try {
    await fsp.access(dest);
    const stamp = Date.now();
    const extIdx = filename.lastIndexOf('.');
    dest = extIdx > 0
      ? path.join(destDir, `${filename.slice(0, extIdx)}_${stamp}${filename.slice(extIdx)}`)
      : path.join(destDir, `${filename}_${stamp}`);
  } catch (_) { /* dest doesn't exist yet Ã¢â‚¬â€ fine */ }
  try {
    await fsp.rename(fullPath, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    await fsp.copyFile(fullPath, dest, fs.constants.COPYFILE_EXCL);
    await fsp.unlink(fullPath);
  }
}

async function handleFile(fullPath, filename, section, sourceDir) {
  console.log(`[watcher] Ingesting "${filename}" Ã¢â€ â€™ ${section} Ã¢â‚¬Â¦`);
  try {
    const n = await ingestFile(fullPath, filename, section);
    console.log(`[watcher] Ã¢Å“â€œ "${filename}": ${n} ticks stored in ${section}`);
    const sourceKind = WATCH_HISTORY_DIR && sourceDir === WATCH_HISTORY_DIR ? 'history' : 'live';
    await moveTo(fullPath, filename, path.join(WATCH_ARCHIVE_DIR, sourceKind, section));
  } catch (err) {
    console.error(`[watcher] Ã¢Å“â€” "${filename}" failed: ${err.message}`);
    await moveTo(fullPath, filename, path.join(sourceDir, FAILED_DIRNAME));
  }
}

async function pollOnce() {
  const presentPaths = new Set();
  for (const sourceDir of WATCH_DIRS) {
    let entries;
    try {
      entries = await fsp.readdir(sourceDir, { withFileTypes: true });
    } catch (err) {
      console.error(`[watcher] cannot read watch folder "${sourceDir}": ${err.message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filename = entry.name;
      if (filename.startsWith('~$')) continue;
      const section = detectSection(filename);
      if (!section) continue;

      const fullPath = path.join(sourceDir, filename);
      presentPaths.add(fullPath);
      let stat;
      try {
        stat = await fsp.stat(fullPath);
      } catch (_) {
        continue;
      }

      const prev = _pending.get(fullPath);
      if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
        _pending.delete(fullPath);
        await handleFile(fullPath, filename, section, sourceDir);
      } else {
        _pending.set(fullPath, { size: stat.size, mtimeMs: stat.mtimeMs });
      }
    }
  }

  for (const fullPath of _pending.keys()) {
    if (!presentPaths.has(fullPath)) _pending.delete(fullPath);
  }
}

let _timer = null;
let _polling = false; // guards against overlapping poll cycles

async function _loop() {
  if (_polling) return; // a previous cycle (e.g. still ingesting a big file) hasn't finished Ã¢â‚¬â€ skip this tick rather than run concurrently
  _polling = true;
  try {
    await pollOnce();
  } catch (err) {
    console.error('[watcher] poll error:', err);
  } finally {
    _polling = false;
  }
}

async function startWatcher() {
  if (!WATCH_DIRS.length) {
    console.log('[watcher] WATCH_DIR and WATCH_HISTORY_DIR not set — folder watcher disabled.');
    return;
  }
  if (_timer) return;
  const archiveDirs = ['history', 'live'].flatMap(sourceKind =>
    ['gcv', 'taq-pro', 'tas-regime'].map(section => path.join(WATCH_ARCHIVE_DIR, sourceKind, section))
  );
  await Promise.all([
    ...WATCH_DIRS.flatMap(dir => [dir, path.join(dir, FAILED_DIRNAME)]),
    ...archiveDirs,
  ].map(dir => fsp.mkdir(dir, { recursive: true })));
  console.log(`[watcher] Watching ${WATCH_DIRS.map(dir => `"${dir}"`).join(', ')} every ${POLL_MS}ms; archive="${WATCH_ARCHIVE_DIR}" (patterns: ${SECTION_MATCHERS.map(m => m.section + '=' + m.re).join(', ')})`);
  // setInterval does NOT wait for an async callback to finish before firing
  // the next tick Ã¢â‚¬â€ with a big file (ingest can take >1s) that let two
  // poll cycles overlap and ingest the same file twice. _loop()'s guard
  // makes overlapping ticks a no-op instead.
  _timer = setInterval(() => { _loop(); }, POLL_MS);
  _loop();
}

function stopWatcher() {
  if (_timer) clearInterval(_timer);
  _timer = null;
}

module.exports = { startWatcher, stopWatcher };
