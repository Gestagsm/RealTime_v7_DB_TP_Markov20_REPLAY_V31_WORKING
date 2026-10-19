const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const proxyConfig = read('frontend/web.config');
const backendConfig = read('backend/.env.example');
const backendServer = read('backend/server.js');
const postgres = read('backend/lib/postgres.js');
const pagesWorkflow = read('.github/workflows/deploy-pages.yml');
const headersBySection = {
  gcv: ['TIMEACT NS', 'Tick', 'Last', 'Bid', 'Ask', 'B Size', 'A Size', 'AGGRESSIVE ORD1', 'TRADE_ID'],
  'taq-pro': ['Timestamp', 'PRCTCK_1', 'BID', 'ASK', 'BIDSIZE', 'ASKSIZE', 'SEQNUM', 'RTL', 'QUALIFIERS'],
  'tas-regime': ['Timestamp', 'PRCTCK_1', 'AGGRS_SID1', 'TRDPRC_1', 'TRDVOL_1', 'SEQNUM', 'QUALIFIERS'],
};

test('IIS proxies API requests to this project’s configured PostgreSQL backend', () => {
  const configuredPort = backendConfig.match(/^PORT=(\d+)$/m);
  assert.ok(configuredPort, 'backend port is configured');
  assert.match(backendServer, /Number\(process\.env\.PORT\)\s*\|\|\s*4001/);
  assert.match(
    proxyConfig,
    new RegExp(`url="http://127\\.0\\.0\\.1:${configuredPort[1]}/api/\\{R:1\\}"`)
  );
});

test('GitHub Pages loads the configured Windows Server API origin in every section', () => {
  for (const section of ['pro-single-display', 'taq-pro', 'tas-regime']) {
    const html = read(`frontend/sections/${section}/index.html`);
    assert.match(html, /<script src="\.\.\/\.\.\/api-config\.js"><\/script>/);
    const script = read(`frontend/sections/${section}/script.js`);
    assert.match(script, /ITR_API_BASE_OVERRIDE/);
    assert.match(script, /Backend URL is not configured/);
  }
  assert.match(pagesWorkflow, /vars\.ITR_API_BASE/);
  assert.match(pagesWorkflow, /ITR_API_BASE must be an HTTPS origin/);
  assert.match(backendConfig, /https:\/\/gestagsm\.github\.io/);
});

test('backend maps each UI section to its matching shared market dataset', () => {
  assert.match(
    postgres,
    /DATASET_BY_SECTION\s*=\s*\{\s*gcv:\s*'GCV',\s*'taq-pro':\s*'TAQ',\s*'tas-regime':\s*'TAS'\s*\}/
  );
  assert.match(postgres, /FROM public\.itr_market_ticks/);
});

test('Pro Single Display shows the shared controls directly below Build Candles', () => {
  const html = read('frontend/sections/pro-single-display/index.html');
  const controls = [
    'id="btn-build"',
    'onclick="trNav(-1)"',
    'id="tr-nav-info"',
    '<span>Data Coverage</span>',
    'id="cov-days"',
    'id="historical-replay-panel"',
    'id="sim-mode-lbl"',
  ];
  const positions = controls.map(marker => html.indexOf(marker));
  assert.ok(positions.every(position => position >= 0), 'expected build, navigation, coverage, replay, and simulation controls');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'shared controls should appear in the same vertical order as TAQ/TAS');
  assert.equal((html.match(/id="cov-days"/g) || []).length, 1, 'coverage controls should not be duplicated');
});

for (const [section, file] of [
  ['gcv', 'frontend/sections/pro-single-display/script.js'],
  ['taq-pro', 'frontend/sections/taq-pro/script.js'],
  ['tas-regime', 'frontend/sections/tas-regime/script.js'],
]) {
  test(`${section} database range request includes the selected symbol`, () => {
    const source = read(file);
    assert.match(source, new RegExp(`ITR_SECTION_ID\\s*=\\s*['"]${section}['"]`));
    assert.match(source, /async function _itrFetchDbTicks\(startIso,endIso\)/);
    assert.match(source, /\/api\/ticks\/\$\{ITR_SECTION_ID\}/);
    assert.match(source, /\/api\/imports\/\$\{ITR_SECTION_ID\}/);
    assert.match(source, /_itrAssertFileSection\(hdrs\)/);
    assert.match(source, /This file's headers identify/);
    const sectionGuard = source.match(/function _itrAssertFileSection\(headers\)\{[\s\S]*?\n\}/);
    assert.ok(sectionGuard, 'manual file import has a section header validator');
    const assertFileSection = vm.runInNewContext(
      `(()=>{const ITR_SECTION_ID=${JSON.stringify(section)};${sectionGuard[0]};return _itrAssertFileSection;})()`
    );
    assert.doesNotThrow(() => assertFileSection(headersBySection[section]));
    const otherSection = Object.keys(headersBySection).find(candidate => candidate !== section);
    assert.throws(
      () => assertFileSection(headersBySection[otherSection]),
      /headers identify/
    );
    assert.match(source, /symbol=String\(CFG\.symbol\|\|'XAUUSD'\)\.trim\(\)\.toUpperCase\(\)/);
    assert.match(source, /&symbol=\$\{encodeURIComponent\(symbol\)\}/);
  });
}
