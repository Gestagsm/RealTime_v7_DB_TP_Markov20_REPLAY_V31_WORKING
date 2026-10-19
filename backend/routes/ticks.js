const express = require('express');
const router = express.Router();
const database = require('../lib/postgres');

function sectionOr400(req, res) {
  const { section } = req.params;
  if (!database.ALLOWED_SECTIONS.includes(section)) {
    res.status(400).json({
      error: `Unknown section "${section}". Allowed: ${database.ALLOWED_SECTIONS.join(', ')}`,
    });
    return null;
  }
  return section;
}

function parseDate(value) {
  if (!value) return null;
  const result = new Date(value);
  return Number.isNaN(result.getTime()) ? null : result;
}

function marketSymbol(req) {
  return String(req.query.symbol || (req.body && req.body.symbol) || database.DEFAULT_SYMBOL)
    .trim().toUpperCase();
}

async function readRange(section, range) {
  let rows = await database.querySharedTicks(section, range);
  if (rows.length) return { rows, source: 'shared-market-history' };
  rows = await database.queryImportedTicks(section, range);
  return { rows, source: 'project-imports' };
}

router.post('/:section', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  try {
    const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
    if (!rows.length) return res.status(400).json({ error: 'rows array is required' });
    const result = await database.storeRawRows(section, rows, marketSymbol(req));
    if (!result.valid) {
      return res.status(422).json({
        error: 'No rows had a valid historical timestamp',
        invalidTimestamp: result.invalidTimestamp,
      });
    }
    res.status(result.inserted ? 201 : 200).json({
      inserted: result.inserted,
      skippedDuplicate: result.duplicates,
      skippedInvalidTimestamp: result.invalidTimestamp,
      validRows: result.valid,
    });
  } catch (err) {
    console.error('[POST /api/ticks/:section]', err);
    res.status(500).json({ error: 'Failed to store ticks in PostgreSQL', detail: err.message });
  }
});

router.get('/:section/coverage', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  try {
    let timeZone = String(req.query.tz || 'UTC');
    try { new Intl.DateTimeFormat('en-US', { timeZone }) } catch { return res.status(400).json({ error: 'Unknown time zone.' }) }
    const from = parseDate(req.query.from);
    const to = parseDate(req.query.to);
    if ((req.query.from && !from) || (req.query.to && !to)) return res.status(400).json({ error: 'Invalid from/to.' });
    if (from && to && (from >= to || to - from > 93 * 86400000)) {
      return res.status(400).json({ error: 'from must be before to, and the window can be at most 93 days.' });
    }
    res.json(await database.tickCoverage(section, { symbol: marketSymbol(req), timeZone, from, to }));
  } catch (err) {
    console.error('[GET /api/ticks/:section/coverage]', err);
    res.status(500).json({ error: 'Failed to read data coverage', detail: err.message });
  }
});

router.get('/:section', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  try {
    const start = parseDate(req.query.start);
    const end = parseDate(req.query.end);
    if (!start || !end || start > end) {
      return res.status(400).json({ error: 'Valid start and end are required, and start must be before end' });
    }
    const result = await readRange(section, {
      start, end, symbol: marketSymbol(req),
      limit: database.MAX_RANGE_ROWS + 1,
    });
    const truncated = result.rows.length > database.MAX_RANGE_ROWS;
    if (truncated) result.rows.length = database.MAX_RANGE_ROWS;
    res.setHeader('X-Market-Data-Source', result.source);
    res.setHeader('X-Market-Data-Rows', String(result.rows.length));
    res.setHeader('X-Market-Data-Truncated', truncated ? 'true' : 'false');
    res.setHeader('X-Market-Data-Limit', String(database.MAX_RANGE_ROWS));
    res.json(result.rows);
  } catch (err) {
    console.error('[GET /api/ticks/:section]', err);
    res.status(500).json({ error: 'Failed to fetch ticks from PostgreSQL', detail: err.message });
  }
});

router.get('/:section/export', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  try {
    const start = req.query.start ? parseDate(req.query.start) : new Date(0);
    const end = req.query.end ? parseDate(req.query.end) : new Date();
    if (!start || !end || start > end) {
      return res.status(400).json({ error: 'Valid start/end range required' });
    }
    const { rows } = await readRange(section, {
      start, end, symbol: marketSymbol(req), limit: database.MAX_RANGE_ROWS,
    });
    if (!rows.length) return res.status(404).json({ error: 'No data found for the selected range' });

    const XLSX = require('xlsx');
    const worksheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Ticks');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${section}_export.xlsx"`);
    res.send(buffer);
  } catch (err) {
    console.error('[GET /api/ticks/:section/export]', err);
    res.status(500).json({ error: 'Failed to export ticks', detail: err.message });
  }
});

module.exports = router;
