// lib/barBuilder.js
//
// Server-side port of the frontend's candle-building pipeline
// (_ticksToBar / _bucketByInterval), producing bars in the exact shape
// the frontend's Renderer and "🗄 Auto-load from Database" checkbox
// expect (open/high/low/close/footprint/pocPrice/vah/val/delta/totalVol/
// buyVol/sellVol/avgVwap/minDelta/maxDelta/cumD/date/time).
//
// Only rows with a real trade price (last > 0) can form a footprint —
// this mirrors the frontend exactly. That means TAQ (quote-only, no
// trade price) will legitimately produce zero bars here; that is not a
// bug, it's the same behavior a manual browser import would have. TAS
// and GCV (which carry a real trade price) build normally.

function snapPrice(last, tickSize) {
  const mult = 10000, tkI = Math.round(tickSize * mult);
  return Math.round(Math.round(last * mult) / tkI) * tkI / mult;
}

function ticksToBar(ticks, tickSize) {
  const priceTicks = ticks.filter(r => r.last > 0);
  if (!priceTicks.length) return null;

  const prices = priceTicks.map(r => r.last);
  const hi = Math.max(...prices), lo = Math.min(...prices);
  const op = prices[0], cl = prices[prices.length - 1];
  const byP = {};
  let tV = 0;

  priceTicks.forEach(r => {
    const pk = snapPrice(r.last, tickSize);
    if (!byP[pk]) byP[pk] = {
      price: pk, bid: 0, ask: 0, bSize: 0, aSize: 0,
      trdVol: 0, volume: 0, delta: 0, vol: 0,
      hitBid: 0, hitAsk: 0, hitTrdVol: 0,
      liftBid: 0, liftAsk: 0, liftTrdVol: 0,
    };
    const lv = byP[pk];
    const bidSz = r.bSize || 0, askSz = r.aSize || 0, vol = r.trdVol || 0;

    let side = 'N';
    if (r.aggr === 'ASK' || r.aggr === 'BUY') side = 'L';
    else if (r.aggr === 'BID' || r.aggr === 'SELL') side = 'H';
    else if (r.ask > 0 && Math.abs(r.last - r.ask) < tickSize * 0.5) side = 'L';
    else if (r.bid > 0 && Math.abs(r.last - r.bid) < tickSize * 0.5) side = 'H';

    lv.bid += bidSz; lv.bSize += bidSz;
    lv.ask += askSz; lv.aSize += askSz;
    lv.trdVol += vol; lv.volume += (r.volume || vol);
    lv.vol += vol; tV += vol;
    lv.delta += bidSz - askSz;
    if (side === 'H') { lv.hitBid += bidSz; lv.hitAsk += askSz; lv.hitTrdVol += vol; }
    if (side === 'L') { lv.liftBid += bidSz; lv.liftAsk += askSz; lv.liftTrdVol += vol; }
  });

  const fp = Object.values(byP).sort((a, b) => a.price - b.price);
  const poc = fp.length ? fp.reduce((mx, r) => r.vol > mx.vol ? r : mx, fp[0]) : { price: prices[0], vol: 0 };
  const sv = [...fp].sort((a, b) => b.vol - a.vol);
  let vaV = 0, vaPs = [];
  for (const r of sv) { vaPs.push(r.price); vaV += r.vol; if (vaV >= tV * 0.7) break; }
  const delta = fp.reduce((s, r) => s + r.delta, 0);
  const buyVol = fp.reduce((s, r) => s + r.liftTrdVol, 0);
  const sellVol = fp.reduce((s, r) => s + r.hitTrdVol, 0);
  const t0 = priceTicks[0];

  return {
    open: op, high: hi, low: lo, close: cl, isBull: cl >= op,
    footprint: fp, pocPrice: poc.price, pocVol: poc.vol,
    vah: vaPs.length ? Math.max(...vaPs) : hi,
    val: vaPs.length ? Math.min(...vaPs) : lo,
    delta, totalVol: tV, buyVol, sellVol,
    avgVwap: prices.reduce((s, p) => s + p, 0) / prices.length,
    minDelta: fp.length ? Math.min(...fp.map(r => r.delta)) : 0,
    maxDelta: fp.length ? Math.max(...fp.map(r => r.delta)) : 0,
    cumD: 0, isOpen: false,
    date: t0.date || '', time: t0.time || '',
  };
}

// Groups finalized rows into fixed-width time buckets (by _tsMs) and
// builds one bar per bucket — same grouping principle as the frontend's
// _bucketByInterval, simplified (no SPL-row special-casing, which these
// TAQ/TAS/GCV feeds don't use).
function bucketByInterval(rows, intervalSec, tickSize) {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => (a._tsMs || 0) - (b._tsMs || 0));
  const groups = new Map();
  sorted.forEach(r => {
    const ms = r._tsMs || 0;
    const bucket = Math.floor(ms / (intervalSec * 1000));
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(r);
  });
  const bars = [];
  for (const bucket of [...groups.keys()].sort((a, b) => a - b)) {
    const bar = ticksToBar(groups.get(bucket), tickSize);
    if (bar) bars.push(bar);
  }
  let cd = 0;
  bars.forEach(b => { cd += b.delta; b.cumD = cd; });
  return bars;
}

module.exports = { ticksToBar, bucketByInterval };
