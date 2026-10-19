const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const database = require('../lib/postgres');

function stable(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value === 'object' && !(value instanceof Date)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key]);
    return out;
  }
  return value;
}

function sectionOr400(value, res) {
  const section = String(value || '').trim();
  if (!database.ALLOWED_SECTIONS.includes(section)) {
    res.status(400).json({ error: `Unknown section "${section}"`, allowed: database.ALLOWED_SECTIONS });
    return null;
  }
  return section;
}

function kindOr400(value, res) {
  const kind = String(value || '').trim().toLowerCase();
  if (!database.ALLOWED_KINDS.includes(kind)) {
    res.status(400).json({ error: `Unknown kind "${kind}"`, allowed: database.ALLOWED_KINDS });
    return null;
  }
  return kind;
}

function parseTs(payload) {
  const raw = payload && (payload.timestamp || payload.ts || payload.time || (payload.result && payload.result.timestamp));
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function engineVersion(payload) {
  return String((payload && (payload.engineVersion || payload.version || payload.TP_Engine)) ||
    (payload && payload.result && (payload.result.engineVersion || payload.result.method)) || '').trim();
}

function source(payload) {
  return String((payload && payload.source) || (payload && payload.result && payload.result.source) || '').trim();
}

function keyFor(section, kind, payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(stable({ section, kind, payload })))
    .digest('hex');
}

router.get('/health', async (req, res) => {
  try {
    const counts = await database.countOrderflow();
    res.json({ ok: true, api: 'orderflow', sections: database.ALLOWED_SECTIONS, kinds: database.ALLOWED_KINDS, counts });
  } catch (err) {
    res.status(500).json({ error: 'OrderFlow derived health failed', detail: err.message });
  }
});

router.post('/:kind/:section', async (req, res) => {
  const section = sectionOr400(req.params.section, res);
  if (!section) return;
  const kind = kindOr400(req.params.kind, res);
  if (!kind) return;
  try {
    const payload = req.body && req.body.payload !== undefined ? req.body.payload : req.body;
    if (!payload || typeof payload !== 'object') return res.status(400).json({ error: 'payload object is required' });
    const eventKey = keyFor(section, kind, payload);
    const inserted = await database.saveOrderflow({
      section,
      kind,
      source: source(payload),
      engineVersion: engineVersion(payload),
      ts: parseTs(payload),
      eventKey,
      payload,
    });
    res.status(inserted ? 201 : 200).json({ ok: true, existing: !inserted, eventKey });
  } catch (err) {
    console.error('[POST /api/orderflow/:kind/:section]', err);
    res.status(500).json({ error: 'Failed to store OrderFlow derived record', detail: err.message });
  }
});

router.get('/latest/:section/:kind', async (req, res) => {
  const section = sectionOr400(req.params.section, res);
  if (!section) return;
  const kind = kindOr400(req.params.kind, res);
  if (!kind) return;
  try {
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 100));
    const rows = await database.latestOrderflow(section, kind, limit);
    res.json({ section, kind, rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read OrderFlow derived records', detail: err.message });
  }
});

module.exports = router;
