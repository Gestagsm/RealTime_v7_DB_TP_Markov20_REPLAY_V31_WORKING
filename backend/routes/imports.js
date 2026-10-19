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

function validId(value) {
  return /^\d+$/.test(String(value || ''));
}

router.post('/:section', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  try {
    const { filename, rowCount, barCount, intervalSec, bars, source, dataStart, dataEnd } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename is required' });
    const doc = await database.createImport(section, {
      filename,
      rowCount,
      barCount,
      intervalSec,
      bars: Array.isArray(bars) ? bars : [],
      source: source || 'manual',
      dataStart: dataStart || null,
      dataEnd: dataEnd || null,
    });
    res.status(201).json({
      id: doc.id,
      _id: doc._id,
      importedAt: doc.importedAt,
      dataStart: doc.dataStart,
      dataEnd: doc.dataEnd,
    });
  } catch (err) {
    console.error('[POST /api/imports/:section]', err);
    res.status(500).json({ error: 'Failed to save import in PostgreSQL', detail: err.message });
  }
});

router.get('/:section', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  try {
    const { limit, before, at } = req.query;
    let beforeDate = null, atDate = null;
    if (before) {
      beforeDate = new Date(before);
      if (Number.isNaN(beforeDate.getTime())) return res.status(400).json({ error: 'Invalid before timestamp' });
    }
    if (at) {
      atDate = new Date(at);
      if (Number.isNaN(atDate.getTime())) return res.status(400).json({ error: 'Invalid at timestamp' });
    }
    const effectiveLimit = Math.min(200, Math.max(1, parseInt(limit, 10) || (beforeDate ? 1 : 50)));
    const docs = await database.listImports(section, {
      limit: effectiveLimit,
      before: beforeDate,
      at: atDate,
    });
    res.json(docs);
  } catch (err) {
    console.error('[GET /api/imports/:section]', err);
    res.status(500).json({ error: 'Failed to fetch imports', detail: err.message });
  }
});

router.get('/:section/:id', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid import id' });
  try {
    const doc = await database.findImport(section, req.params.id);
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.json(doc);
  } catch (err) {
    console.error('[GET /api/imports/:section/:id]', err);
    res.status(500).json({ error: 'Failed to fetch import', detail: err.message });
  }
});

router.delete('/:section/:id', async (req, res) => {
  const section = sectionOr400(req, res);
  if (!section) return;
  if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid import id' });
  try {
    await database.deleteImport(section, req.params.id);
    res.status(204).end();
  } catch (err) {
    console.error('[DELETE /api/imports/:section/:id]', err);
    res.status(500).json({ error: 'Failed to delete import', detail: err.message });
  }
});

module.exports = router;
