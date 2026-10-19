const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sections = [
  ['TAS Regime', path.join(__dirname, 'tas-regime', 'script.js')],
  ['TAQ Pro', path.join(__dirname, 'taq-pro', 'script.js')],
];

const priorCandlePainter = [
  /const bTop=Math\.min\(oY,cY\),bH=Math\.max\(CFG\.rowH,Math\.abs\(cY-oY\)\);/,
  /cx\.moveTo\(x0\+1,hY\);cx\.lineTo\(x0\+1,lY\);cx\.stroke\(\);/,
  /cx\.moveTo\(x0\+this\.barW-1,hY\);cx\.lineTo\(x0\+this\.barW-1,lY\);cx\.stroke\(\);/,
  /cx\.fillRect\(x0\+1,bTop,this\.barW-2,bH\);/,
  /cx\.strokeRect\(x0\+1,bTop,this\.barW-2,bH\);/,
  /cx\.moveTo\(wX-4,hY\);cx\.lineTo\(wX\+4,hY\);cx\.stroke\(\);/,
  /cx\.moveTo\(wX-4,lY\);cx\.lineTo\(wX\+4,lY\);cx\.stroke\(\);/,
];

for (const [name, file] of sections) {
  const source = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

  test(`${name} preserves the prior Build Candles rendering and database workflow`, () => {
    for (const painterPattern of priorCandlePainter) assert.match(source, painterPattern);

    assert.match(source, /function chartPriceStep\(range,visibleRows\)/);
    assert.match(source, /function chartDisplayRows\(rows,topPrice,priceStep\)/);
    assert.match(source, /const _itrSourceAwareBuild=function\(\)/);
    assert.match(source, /if\(window\._itrDataSource==='database'\) return (?:window\.)?_itrLoadDatabaseRange/);
  });

  test(`${name} draws full-width candle bodies with complete high-low wicks`, () => {
    const painter = source.match(
      /(if\(candleMode\)\{\s*const col=bar\.isBull\?CFG\.bullColor:CFG\.bearColor;[\s\S]*?\n\s*\})\n\s*if\(CFG\.showDelta\)/
    );
    assert.ok(painter, 'candle painter block exists');

    for (const isBull of [true, false]) {
      const calls = [];
      const cx = {
        beginPath() { calls.push({ op: 'beginPath' }); },
        moveTo(x, y) { calls.push({ op: 'moveTo', x, y }); },
        lineTo(x, y) { calls.push({ op: 'lineTo', x, y }); },
        stroke() { calls.push({ op: 'stroke', color: this.strokeStyle, width: this.lineWidth }); },
        fillRect(x, y, width, height) {
          calls.push({ op: 'fillRect', x, y, width, height, color: this.fillStyle });
        },
        strokeRect(x, y, width, height) {
          calls.push({ op: 'strokeRect', x, y, width, height, color: this.strokeStyle });
        },
      };
      const drawCandle = new Function(
        'bar', 'CFG', 'cx', 'oY', 'cY', 'hY', 'lY', 'x0', 'candleMode', painter[1]
      );
      drawCandle.call({ barW: 100 }, {
        isBull,
      }, {
        bullColor: '#00aa44',
        bearColor: '#cc0022',
        rowH: 19,
      }, cx, 100, 120, 80, 140, 10, true);

      const body = calls.find(call => call.op === 'fillRect');
      assert.deepStrictEqual(
        [body.x, body.y, body.width, body.height],
        [11, 100, 98, 20]
      );
      assert.strictEqual(body.color, isBull ? 'rgba(0,170,68,0.22)' : 'rgba(204,0,34,0.22)');
      assert.ok(calls.some(call => call.op === 'moveTo' && call.x === 11 && call.y === 80));
      assert.ok(calls.some(call => call.op === 'moveTo' && call.x === 109 && call.y === 80));
      assert.ok(calls.some(call => call.op === 'moveTo' && call.x === 56 && call.y === 80));
      assert.ok(calls.some(call => call.op === 'lineTo' && call.x === 64 && call.y === 140));
    }
  });
}
