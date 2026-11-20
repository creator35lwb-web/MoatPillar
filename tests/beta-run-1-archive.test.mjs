import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {EDITIONS, RECORD_FIELDS} from '../scripts/archive-pre-beta.mjs';
import {BETA_RUN_1_PAGE, PAGE, SOURCES, isBetaRecord, readArchive} from '../scripts/archive-beta-run-1.mjs';
import {renderArchivePage} from '../scripts/archive-pre-beta.mjs';

const read = rel => readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('beta run 1 is rebuilt exactly from its pinned beta publications', () => {
  const {page, archives} = readArchive();
  assert.equal(renderArchivePage(archives, BETA_RUN_1_PAGE), page, 'run node scripts/archive-beta-run-1.mjs');
  assert.deepEqual(archives.map(a => a.key), EDITIONS.map(e => e.key));
  for (const a of archives) {
    assert.match(SOURCES[a.key], /^[0-9a-f]{40}$/);
    assert.ok(isBetaRecord(a.data), a.key + ' is a beta record');
    assert.deepEqual(Object.keys(a.data), RECORD_FIELDS, a.key + ' keeps the record and nothing else');
    assert.ok(page.includes(a.data.trackRecord.accuracy), a.key + ' figure shown as published');
    assert.ok(page.includes(SOURCES[a.key]), a.key + ' source commit named');
  }
  assert.equal((page.match(/<tr><td>\d{4}-\d{2}-\d{2}<\/td>/g) || []).length,
    archives.reduce((n, x) => n + x.data.history.length, 0), 'one row per published call');
  assert.equal(isBetaRecord({trackRecord: {accuracy: 'x'}}), false);
});

test('the dashboard links beta run 1 from the beta phase note', () => {
  const app = read('docs/app.js');
  const url = /var BETA_RUN_1_URL = '([^']+)';/.exec(app);
  assert.ok(url && url[1] === PAGE.replace(/^docs\//, ''), 'the link names the archive page');
  assert.ok(existsSync(new URL('../' + PAGE, import.meta.url)), 'the archive page exists');
  assert.match(app, /run1\.href = BETA_RUN_1_URL;/);
});
