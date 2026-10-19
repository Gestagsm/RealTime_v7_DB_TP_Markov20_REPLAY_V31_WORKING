const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, 'script.js'), 'utf8');
function grab(startRe, endMarker) {
  const i = src.search(startRe);
  const j = src.indexOf(endMarker, i);
  return src.slice(i, j);
}
const code =
  grab(/function secToHHMMSS/, 'function normTime') +
  grab(/function normTime/, 'function _bucketByInterval') +
  grab(/function _bucketByInterval/, '/* ============================================================\n   NAVIGATION');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(code + '\nthis._bucket=_bucketByInterval;', ctx);
ctx._ticksToBar = undefined;
vm.runInContext('function _ticksToBar(t){return {time:t[0].time,n:t.length,delta:0};}', ctx);

const hms = s => [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map(x => String(x).padStart(2, '0')).join(':');
const day = (d, secs) => secs.map((s, i) => ({ date: d, time: hms(s), tradeId: d + i, last: 1 }));

const secs = [];
for (let s = 0; s < 86400; s += 137) secs.push(s);
const rows = [...day('2026-10-10', secs), ...day('2026-10-11', secs)];

for (const [name, iv] of [['M1', 60], ['M5', 300], ['M15', 900], ['M30', 1800], ['H1', 3600], ['H4', 14400]]) {
  test(`${name} bars are clock-aligned and keep every tick`, () => {
    const bars = ctx._bucket(rows, iv);
    for (const b of bars) {
      const p = b.time.split(':').map(Number);
      assert.strictEqual((p[0] * 3600 + p[1] * 60 + p[2]) % iv, 0, `${name} bar ${b.time}`);
    }
    assert.strictEqual(bars.reduce((a, b) => a + b.n, 0), rows.length);
    assert.ok(bars.length <= Math.ceil(86400 / iv) * 2);
  });
}

const tzCode = grab(/\/\* ── Display time zone/, 'function _dbRangeFromInputs');
const tctx = {};
tctx.window = tctx;
vm.createContext(tctx);
vm.runInContext(tzCode + '\nthis._wall=_itrWallToUtcMs;this._shift=_itrTzShiftMs;this._in=_itrInputToDate;', tctx);

test('New York wall-clock → UTC handles EDT and EST', () => {
  tctx._itrTZ = 'America/New_York';
  assert.strictEqual(new Date(tctx._wall(2026, 10, 10, 0, 0, 0)).toISOString(), '2026-10-10T04:00:00.000Z');
  assert.strictEqual(new Date(tctx._wall(2026, 12, 10, 0, 0, 0)).toISOString(), '2026-12-10T05:00:00.000Z');
  assert.strictEqual(tctx._in('2026-10-10T23:59:59').toISOString(), '2026-10-11T03:59:59.000Z');
});

test('UTC zone and local zone behave as identity/native', () => {
  tctx._itrTZ = 'UTC';
  assert.strictEqual(tctx._in('2026-10-10T12:30:00').toISOString(), '2026-10-10T12:30:00.000Z');
  tctx._itrTZ = 'local';
  const ms = Date.UTC(2026, 9, 10, 12);
  assert.strictEqual(tctx._shift(ms), ms);
});

test('shifted epoch renders the target zone wall clock', () => {
  tctx._itrTZ = 'America/New_York';
  const d = new Date(tctx._shift(Date.UTC(2026, 9, 10, 10, 14, 29)));
  assert.deepStrictEqual([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()], [2026, 10, 10, 6, 14, 29]);
});

test('multi-day D1 in NY: ticks at 03:59Z and 04:01Z fall on different days', () => {
  tctx._itrTZ = 'America/New_York';
  const mk = iso => { const d = new Date(tctx._shift(Date.parse(iso))); const p = n => String(n).padStart(2, '0'); return { date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`, time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` }; };
  const rowsNY = [mk('2026-10-10T03:59:00Z'), mk('2026-10-10T04:01:00Z')].map((r, i) => ({ ...r, tradeId: 'x' + i, last: 1 }));
  assert.strictEqual(ctx._bucket(rowsNY, 86400).length, 2);
});

test('D1 gives one bar per calendar day', () => {
  const bars = ctx._bucket(rows, 86400);
  assert.strictEqual(bars.length, 2);
  assert.strictEqual(bars[0].n, secs.length);
});
