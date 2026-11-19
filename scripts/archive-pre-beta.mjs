#!/usr/bin/env node
// Archives the record MoatPillar (then MarketPulse) published before its beta (W25).
//
// For each edition, finds the newest published version of docs/data/latest-<ed>.json written
// before the beta (one whose trackRecord has no phase), copies its record fields exactly to
// docs/archive/pre-beta-<ed>.json, and renders docs/archive/pre-beta.html from those copies.
// The full publication stays in the repository at the commit the page names; the archive keeps
// only the record, not that day's facts and headlines.
// Before the beta goes live it archives the current publication. Run it again on an up-to-date
// main after the deploy, so the archive ends at the last edition published before the beta.
//
//   node scripts/archive-pre-beta.mjs          write the archive
//   node scripts/archive-pre-beta.mjs --check  fail unless the page matches its archived copies
import {execFileSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = 'https://github.com/creator35lwb-web/MoatPillar';
const PAGE = 'docs/archive/pre-beta.html';
export const EDITIONS = [
  {key: 'us', title: 'US edition'},
  {key: 'cn', title: 'China edition'},
];
const sourcePath = key => 'docs/data/latest-' + key + '.json';
const archivePath = key => 'docs/archive/pre-beta-' + key + '.json';
const RESULT = {hit: 'Correct', miss: 'Missed', flat: 'Too flat to judge'};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const RECORD_FIELDS = ['edition', 'generatedAt', 'trackRecord', 'history'];
export const recordOf = data => Object.fromEntries(RECORD_FIELDS.filter(k => data[k] !== undefined).map(k => [k, data[k]]));
export const isPreBeta = data => !!data && typeof data === 'object' && data.trackRecord?.phase === undefined;
const esc = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// '2026-10-07T13:40:49Z' becomes 'Oct 7, 2026, 21:40 MYT' (Malaysia is UTC+8, with no daylight saving).
function mytStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'unknown';
  const d = new Date(t + 8 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() + ', ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + ' MYT';
}

// What differs between archive pages (W25's pre-beta record; beta run 1, archived after the host loss).
export const PRE_BETA_PAGE = {
  copyName: key => 'pre-beta-' + key + '.json',
  title: 'MoatPillar · Record before the beta',
  description: 'The track record MoatPillar, then called MarketPulse, published before its beta, archived unchanged.',
  h1: 'The record before the beta',
  lead: 'MoatPillar, called MarketPulse until its beta, restarts its public track record with the beta. This page keeps the record published before the beta, unchanged.',
  noteTitle: 'Why the record restarts',
  notes: [
    'The beta brings a corrected scorer. Before it, when no new AI call was published for several days, later runs graded the last call again, and a run that started late could grade a call against a session that was still trading. The beta grades each call once, against closed sessions only, and shows beside the hit rate how often the market fell on the same days.',
    'The figures below are exactly as published, including any extra grades.',
  ],
};

function editionSection({key, title, commit, data}, spec = PRE_BETA_PAGE) {
  const tr = data.trackRecord || {};
  const history = Array.isArray(data.history) ? data.history.slice().reverse() : [];
  const rows = history.map(h => '        <tr><td>' + esc(h.date) + '</td><td>' + esc(h.sentiment || 'n/a') + '</td><td>' +
    esc(h.actualChange || '—') + '</td><td class="result ' + esc(h.result || 'none') + '">' + esc(RESULT[h.result] || 'Not graded') + '</td></tr>').join('\n');
  return `  <section class="card" aria-labelledby="${key}-title">
    <h2 id="${key}-title">${esc(title)}</h2>
    <dl class="summary">
      <div><dt>Track record, as last published</dt><dd class="figure">${esc(tr.accuracy || 'none published')}</dd></div>
      <div><dt>Last graded call</dt><dd>${esc(tr.last || 'none')}</dd></div>
      <div><dt>Published</dt><dd>${esc(mytStamp(data.generatedAt))}</dd></div>
    </dl>
    <div class="table-wrap">
      <table>
        <caption>The ${history.length} calls in that publication, newest first</caption>
        <thead><tr><th scope="col">Call date</th><th scope="col">Short-term read</th><th scope="col">Market move</th><th scope="col">Result</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>
    <p class="fine">One row per call. Where a call was graded more than once, its row shows the last grade, while the figure above counts every grade, as published.</p>
    <p class="fine">The figure and the calls are copied exactly from <code>${sourcePath(key)}</code> at commit <a href="${REPOSITORY}/blob/${commit}/${sourcePath(key)}">${commit.slice(0, 7)}</a>, which keeps the full publication. Archived copy of the record: <a href="${spec.copyName(key)}">${spec.copyName(key)}</a>.</p>
  </section>`;
}

// The page is a pure function of the archived copies and their source commits, so --check can rebuild it.
export function renderPage(archives) {
  return renderArchivePage(archives, PRE_BETA_PAGE);
}

export function renderArchivePage(archives, spec) {
  const sources = archives.map(a => a.key + ':' + a.commit).join(' ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(spec.title)}</title>
<meta name="description" content="${esc(spec.description)}">
<meta name="archive-sources" content="${esc(sources)}">
<link rel="icon" type="image/svg+xml" href="../assets/brand/mark-small.svg">
<link rel="icon" type="image/png" sizes="32x32" href="../assets/brand/favicon-32.png">
<link rel="apple-touch-icon" href="../assets/brand/apple-touch-icon.png">
<style>
:root {
  --bg: #F2F3F5; --surface: #FFFFFF; --rule: #E1E4E9; --text: #121826; --muted: #5B6474;
  --accent: #8A6A2E; --accent-soft: rgba(138, 106, 46, 0.10); --pos: #1E7A4C; --neg: #B3382F;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --serif: Georgia, "Times New Roman", serif;
  --mono: "SFMono-Regular", Consolas, monospace;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0D1015; --surface: #141922; --rule: #252C38; --text: #ECE9E2; --muted: #98A1AF;
    --accent: #CFA75A; --accent-soft: rgba(207, 167, 90, 0.12); --pos: #4CB782; --neg: #E0675C;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.55 var(--sans); }
a { color: var(--accent); text-underline-offset: 3px; }
.wrap { max-width: 880px; margin: 0 auto; padding: 0 16px 48px; }
.topbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 0 18px; margin-bottom: 28px; border-bottom: 1px solid var(--rule); }
.brand { display: inline-flex; align-items: center; gap: 10px; text-decoration: none; }
.brand img { display: block; width: 36px; height: 36px; }
.brand-name { font: 600 24px/1 var(--serif); color: var(--text); white-space: nowrap; }
.brand-name span { color: var(--accent); }
.kicker { margin: 0 0 6px; color: var(--accent); font-size: 12px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; }
h1 { margin: 0 0 12px; font: 600 clamp(28px, 6vw, 40px)/1.15 var(--serif); }
.lead { margin: 0 0 24px; font-size: 17px; color: var(--muted); }
.note { margin: 0 0 24px; padding: 14px 16px; border-left: 3px solid var(--accent); border-radius: 0 6px 6px 0; background: var(--accent-soft); }
.note h2 { margin: 0 0 6px; font-size: 15px; }
.note p { margin: 0 0 8px; }
.note p:last-child { margin-bottom: 0; }
.card { margin: 0 0 20px; padding: 18px; border: 1px solid var(--rule); border-radius: 10px; background: var(--surface); }
.card h2 { margin: 0 0 12px; font: 600 22px/1.2 var(--serif); }
.summary { display: grid; gap: 10px; margin: 0 0 16px; }
.summary div { display: grid; gap: 2px; }
dt { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; }
dd { margin: 0; }
.figure { font: 500 19px/1.3 var(--mono); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
caption { text-align: left; color: var(--muted); font-size: 13px; padding-bottom: 6px; }
th, td { padding: 7px 6px; border-bottom: 1px solid var(--rule); text-align: left; vertical-align: top; }
td:nth-child(1), td:nth-child(3) { white-space: nowrap; }
th { color: var(--muted); font-size: 12px; font-weight: 600; }
td:nth-child(3) { font-family: var(--mono); }
.result.hit { color: var(--pos); }
.result.miss { color: var(--neg); }
.result.flat, .result.none { color: var(--muted); }
.fine { margin: 10px 0 0; color: var(--muted); font-size: 13px; }
code { font-family: var(--mono); font-size: 0.92em; }
footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<div class="wrap">
  <header class="topbar">
    <a class="brand" href="../" aria-label="MoatPillar dashboard">
      <img src="../assets/brand/mark.svg" alt="" width="36" height="36">
      <span class="brand-name">Moat<span>Pillar</span></span>
    </a>
    <a href="../">Back to the dashboard</a>
  </header>
  <main>
  <p class="kicker">Archive</p>
  <h1>${esc(spec.h1)}</h1>
  <p class="lead">${esc(spec.lead)}</p>
  <section class="note" aria-labelledby="why-title">
    <h2 id="why-title">${esc(spec.noteTitle)}</h2>
${spec.notes.map(n => '    <p>' + esc(n) + '</p>').join('\n')}
  </section>
${archives.map(a => editionSection(a, spec)).join('\n')}
  <p class="fine">Every earlier publication is in the repository's history: <a href="${REPOSITORY}/commits/main/${sourcePath('us')}">US</a> · <a href="${REPOSITORY}/commits/main/${sourcePath('cn')}">China</a>.</p>
  </main>
  <footer>Information only, not financial advice.</footer>
</div>
</body>
</html>
`;
}

// Git runs from its standard install path, never found through a PATH that a user or a tool can write to.
const GIT = process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git';
const git = (...args) => execFileSync(GIT, args, {cwd: ROOT, maxBuffer: 64 * 1024 * 1024});

// Newest first: the first version without a beta phase is the last one published before the beta.
function findPreBeta(key) {
  const commits = git('log', '--format=%H', '--', sourcePath(key)).toString('utf8').split('\n').filter(Boolean);
  for (const commit of commits) {
    let data;
    try { data = JSON.parse(git('show', commit + ':' + sourcePath(key)).toString('utf8')); } catch { continue; }
    if (isPreBeta(data)) return {commit, data};
  }
  throw new Error('No version of ' + sourcePath(key) + ' from before the beta was found.');
}

// Reads the archived copies and the commits the page names, for --check and for the tests.
export function readArchive(root = ROOT) {
  const page = readFileSync(path.join(root, PAGE), 'utf8').replaceAll('\r\n', '\n');
  const meta = /<meta name="archive-sources" content="([^"]*)">/.exec(page);
  const commits = Object.fromEntries((meta ? meta[1] : '').split(' ').filter(Boolean).map(pair => pair.split(':')));
  const archives = EDITIONS.map(({key, title}) => ({
    key, title, commit: commits[key] || '',
    data: JSON.parse(readFileSync(path.join(root, archivePath(key)), 'utf8')),
  }));
  return {page, archives};
}

// A shallow clone lacks the source commit; a full one can prove the copy exact.
function sourceRecord(a) {
  try { return recordOf(JSON.parse(git('show', a.commit + ':' + sourcePath(a.key)).toString('utf8'))); }
  catch { console.warn(a.key + ': source commit not in this clone; copy not compared'); return null; }
}

function problemsWith(a) {
  const problems = [];
  if (!/^[0-9a-f]{40}$/.test(a.commit)) problems.push(a.key + ': the page names no source commit');
  if (!isPreBeta(a.data)) problems.push(a.key + ': the archived copy carries a beta phase');
  if (Object.keys(a.data).some(k => !RECORD_FIELDS.includes(k))) problems.push(a.key + ': the archived copy holds more than the record');
  const source = sourceRecord(a);
  if (source && JSON.stringify(source) !== JSON.stringify(a.data)) problems.push(a.key + ': the archived record differs from its source commit');
  return problems;
}

function check() {
  const {page, archives} = readArchive();
  const problems = archives.flatMap(problemsWith);
  if (renderPage(archives) !== page) problems.push(PAGE + ' does not match its archived copies; run node scripts/archive-pre-beta.mjs');
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; return; }
  console.log('Pre-beta archive verified: ' + archives.map(a => a.key + ' ' + a.commit.slice(0, 7)).join(', '));
}

function write() {
  mkdirSync(path.join(ROOT, 'docs/archive'), {recursive: true});
  const archives = EDITIONS.map(({key, title}) => {
    const found = findPreBeta(key);
    const data = recordOf(found.data);
    writeFileSync(path.join(ROOT, archivePath(key)), JSON.stringify(data, null, 2) + '\n');
    return {key, title, commit: found.commit, data};
  });
  writeFileSync(path.join(ROOT, PAGE), renderPage(archives));
  console.log('Pre-beta archive written: ' + archives.map(a => a.key + ' ' + a.commit.slice(0, 7) + ' (' + mytStamp(a.data.generatedAt) + ')').join(', '));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) check(); else write();
}
