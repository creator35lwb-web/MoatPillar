#!/usr/bin/env node
// Archives beta run 1: the beta record MoatPillar published from 2026-10-17 until the host that
// runs the workflow was lost after the China edition of 2026-11-03. The runtime copy of the record
// was lost with the host; the newest saved copy predates almost the whole run. So the published
// record is archived here exactly as last published, and the beta record restarts on the rebuilt
// host. Nothing is rebuilt or backfilled.
//
// The sources are pinned: the last beta publication of each edition before the loss.
//
//   node scripts/archive-beta-run-1.mjs          write the archive
//   node scripts/archive-beta-run-1.mjs --check  fail unless the page and copies match their sources
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {EDITIONS, RECORD_FIELDS, recordOf, renderArchivePage} from './archive-pre-beta.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PAGE = 'docs/archive/beta-run-1.html';
const sourcePath = key => 'docs/data/latest-' + key + '.json';
const archivePath = key => 'docs/archive/beta-run-1-' + key + '.json';

// The last publication of each edition before the host was lost.
export const SOURCES = {
  us: '09c4a502ea4a0d698a103008935f278f7067ef95', // Publish US dashboard data - Monday, November 2, 2026
  cn: 'eec5ad46a02bff506bfaf64dc8dcd1fcacd31fd7', // Publish CN dashboard data - Tuesday, November 3, 2026
};

export const BETA_RUN_1_PAGE = {
  copyName: key => 'beta-run-1-' + key + '.json',
  title: 'MoatPillar · Beta run 1',
  description: 'The beta track record MoatPillar published from October 17 to November 3, 2026, archived unchanged.',
  h1: 'Beta run 1',
  lead: 'The beta track record MoatPillar published from October 17 to November 3, 2026, kept here unchanged. The beta record restarted after the computer that runs MoatPillar was lost.',
  noteTitle: 'Why the record restarts',
  notes: [
    'After the China edition of November 3, 2026, the computer that runs MoatPillar stopped working and had to be reinstalled. Its working copy of the record was lost with it, and no edition was published until the service was rebuilt.',
    'The newest saved copy of the record was from October 17, before almost every call shown below. Rather than reconstruct the missing weeks, MoatPillar archives the record exactly as it was last published and starts a new beta record on the rebuilt machine. Missed editions are not backfilled.',
    'The figures below are exactly as published.',
  ],
};

export const isBetaRecord = data => !!data && typeof data === 'object' && data.trackRecord?.phase === 'beta';

// Git runs from its standard install path, never found through a PATH that a user or a tool can write to.
const GIT = process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git';
const git = (...args) => execFileSync(GIT, args, {cwd: ROOT, maxBuffer: 64 * 1024 * 1024});

export function readArchive(root = ROOT) {
  const page = readFileSync(path.join(root, PAGE), 'utf8').replaceAll('\r\n', '\n');
  const archives = EDITIONS.map(({key, title}) => ({
    key, title, commit: SOURCES[key],
    data: JSON.parse(readFileSync(path.join(root, archivePath(key)), 'utf8')),
  }));
  return {page, archives};
}

function sourceRecord(key) {
  try { return recordOf(JSON.parse(git('show', SOURCES[key] + ':' + sourcePath(key)).toString('utf8'))); }
  catch { console.warn(key + ': source commit not in this clone; copy not compared'); return null; }
}

function problemsWith(a) {
  const problems = [];
  if (!isBetaRecord(a.data)) problems.push(a.key + ': the archived copy is not a beta record');
  if (Object.keys(a.data).some(k => !RECORD_FIELDS.includes(k))) problems.push(a.key + ': the archived copy holds more than the record');
  const source = sourceRecord(a.key);
  if (source && JSON.stringify(source) !== JSON.stringify(a.data)) problems.push(a.key + ': the archived record differs from its source commit');
  return problems;
}

function check() {
  const {page, archives} = readArchive();
  const problems = archives.flatMap(problemsWith);
  if (renderArchivePage(archives, BETA_RUN_1_PAGE) !== page) problems.push(PAGE + ' does not match its archived copies; run node scripts/archive-beta-run-1.mjs');
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; return; }
  console.log('Beta run 1 archive verified: ' + archives.map(a => a.key + ' ' + a.commit.slice(0, 7)).join(', '));
}

function write() {
  mkdirSync(path.join(ROOT, 'docs/archive'), {recursive: true});
  const archives = EDITIONS.map(({key, title}) => {
    const data = recordOf(JSON.parse(git('show', SOURCES[key] + ':' + sourcePath(key)).toString('utf8')));
    if (!isBetaRecord(data)) throw new Error(key + ': the pinned source is not a beta record');
    writeFileSync(path.join(ROOT, archivePath(key)), JSON.stringify(data, null, 2) + '\n');
    return {key, title, commit: SOURCES[key], data};
  });
  writeFileSync(path.join(ROOT, PAGE), renderArchivePage(archives, BETA_RUN_1_PAGE));
  console.log('Beta run 1 archive written: ' + archives.map(a => a.key + ' ' + a.commit.slice(0, 7) + ' ' + a.data.trackRecord.accuracy).join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check(); else write();
}
