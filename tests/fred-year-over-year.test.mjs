import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// The helper as the Fetch node runs it: the shared file, evaluated on its own.
const context = {};
vm.runInNewContext(readFileSync(new URL('../src/n8n/fetch-market-helpers.js', import.meta.url), 'utf8') + '\nthis.fredYearOverYear = fredYearOverYear;', context);
const { fredYearOverYear } = context;

// Newest first, as FRED returns them with sort_order=desc.
const monthly = (from, values) => values.map((value, index) => {
  const [y, m] = from.split('-').map(Number);
  return { date: new Date(Date.UTC(y, m - 1 - index, 1)).toISOString().slice(0, 10), value };
});

test('CPI: the newest month against the same month a year earlier', () => {
  const obs = monthly('2026-09', ['336.298', ...Array(11).fill('330'), '324.245']);
  assert.deepEqual({ ...fredYearOverYear(obs) }, { value: '3.72%', date: '2026-09-01' });
});

test('CPI: a month FRED never published (".") moves the reading to the newest complete pair', () => {
  // FRED's CPIAUCSL as served on 2026-11-21: October 2025 is "." (no BLS release in the 2025 shutdown).
  const obs = monthly('2026-10', ['337.476', '336.298', '334.131', '332.813', '332.568', '333.979', '332.407', '330.293',
    '327.460', '326.588', '326.031', '325.063', '.', '324.245']);
  assert.deepEqual({ ...fredYearOverYear(obs) }, { value: '3.72%', date: '2026-09-01' });
});

test('CPI: no complete pair gives null, never NaN', () => {
  assert.equal(fredYearOverYear(monthly('2026-10', ['337.476', '.', '.'])), null);
  assert.equal(fredYearOverYear([]), null);
  assert.equal(fredYearOverYear(undefined), null);
  assert.equal(fredYearOverYear([{ date: '2026-10-01', value: '337' }, { date: '2025-10-01', value: '0' }]), null);
});
