'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const XLSX = require('xlsx');
const { detectFileSection } = require('../lib/rowParser');

const examples = [
  ['gcv', ['TIMEACT NS', 'Tick', 'Last', 'Bid', 'Ask', 'AGGRESSIVE ORD1']],
  ['taq-pro', ['Timestamp', 'PRCTCK_1', 'BID', 'ASK', 'BIDSIZE', 'ASKSIZE', 'SEQNUM', 'QUALIFIERS']],
  ['tas-regime', ['Timestamp', 'PRCTCK_1', 'AGGRS_SID1', 'TRDPRC_1', 'TRDVOL_1']],
];

test('workbook headers identify GCV, TAQ, and TAS independently', () => {
  for (const [expectedSection, headers] of examples) {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, headers.map(() => 'x')]), 'Ticks');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
    assert.equal(detectFileSection('xlsx', buffer), expectedSection);
  }
});

test('unknown workbook headers remain unclassified for filename-based compatibility', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['Timestamp', 'Price']]), 'Ticks');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  assert.equal(detectFileSection('xlsx', buffer), null);
});
