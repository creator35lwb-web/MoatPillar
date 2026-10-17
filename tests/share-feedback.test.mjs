import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import MP_LINKS from '../src/n8n/public-links.js';
import {runNode, validAnalysis, pipeline, suffixFor} from './helpers/n8n.mjs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const BUTTONS = [['📊 Dashboard', 'dashboard'], ['💬 Feedback', 'feedback'], ['📣 Share', 'share']];

// The module with other form values, so the URL rules are tested apart from the live form.
function linksWithForm(form, field) {
  const source = read('src/n8n/public-links.js')
    .replace(/const FEEDBACK_FORM = '[^']*';/, 'const FEEDBACK_FORM = ' + JSON.stringify(form) + ';')
    .replace(/const FEEDBACK_DETAILS_FIELD = '[^']*';/, 'const FEEDBACK_DETAILS_FIELD = ' + JSON.stringify(field) + ';');
  return vm.runInNewContext(source + '\nMP_LINKS;', {});
}

test('public links are absolute https addresses, and a feedback form is a Google Form', () => {
  for (const url of [MP_LINKS.DASHBOARD, MP_LINKS.REPOSITORY, MP_LINKS.CHANNEL]) assert.match(url, /^https:\/\/\S+$/);
  assert.ok(MP_LINKS.FEEDBACK_FORM === '' || /^https:\/\/docs\.google\.com\/forms\/d\/e\/[\w-]+\/viewform$/.test(MP_LINKS.FEEDBACK_FORM), 'feedback form address');
  assert.ok(MP_LINKS.FEEDBACK_DETAILS_FIELD === '' || /^entry\.\d+$/.test(MP_LINKS.FEEDBACK_DETAILS_FIELD), 'details field id');
  assert.ok(!MP_LINKS.FEEDBACK_DETAILS_FIELD || MP_LINKS.FEEDBACK_FORM, 'a details field needs a form');
});

test('button URLs: the edition opens on the dashboard, share opens Telegram, and feedback never leaves a dead button', () => {
  const us = MP_LINKS.forPost('US', '2026-10-07');
  assert.equal(us.dashboard, MP_LINKS.DASHBOARD + '#us');
  assert.equal(MP_LINKS.forPost('CN', '2026-10-07').dashboard, MP_LINKS.DASHBOARD + '#cn');
  assert.equal(MP_LINKS.forPost('weekly', '2026-10-10').dashboard, MP_LINKS.DASHBOARD);
  assert.equal(us.share, 'https://t.me/share/url?url=' + encodeURIComponent(MP_LINKS.CHANNEL) + '&text=' + encodeURIComponent(MP_LINKS.PITCH));
  assert.equal(us.feedback, MP_LINKS.FEEDBACK_FORM
    ? MP_LINKS.FEEDBACK_FORM + '?usp=pp_url&' + MP_LINKS.FEEDBACK_DETAILS_FIELD + '=' + encodeURIComponent('telegram · US · 2026-10-07')
    : us.dashboard);

  const form = 'https://docs.google.com/forms/d/e/1FAIpQLSexample/viewform';
  const withForm = linksWithForm(form, 'entry.123');
  assert.equal(withForm.forPost('US', '2026-10-07').feedback,
    form + '?usp=pp_url&entry.123=' + encodeURIComponent('telegram · US · 2026-10-07'));
  assert.equal(withForm.feedback(''), form);
  assert.equal(linksWithForm(form, '').forPost('CN', '2026-10-07').feedback, form);
});

test('every daily post carries the three button URLs, and the footer uses the same links', () => {
  for (const edition of ['US', 'CN']) {
    const {verified} = pipeline(edition, validAnalysis(edition));
    const out = runNode('compose-telegram-message' + suffixFor(edition), verified)[0].json;
    assert.deepEqual(Object.keys(out.links), ['dashboard', 'feedback', 'share']);
    for (const url of Object.values(out.links)) assert.match(url, /^https:\/\/\S+$/);
    // The fixture clock is 2026-09-10 12:00 UTC: 20:00 in Malaysia, the same date.
    assert.deepEqual({...out.links}, {...MP_LINKS.forPost(edition, '2026-09-10')});
    assert.match(out.message, new RegExp('<a href="' + escapeRegex(MP_LINKS.DASHBOARD) + '">Dashboard</a> · <a href="' + escapeRegex(MP_LINKS.REPOSITORY) + '">Open source</a>'));
  }
});

test('the daily post closes with a titled section, not a drawn rule', () => {
  for (const edition of ['US', 'CN']) {
    const {verified} = pipeline(edition, validAnalysis(edition));
    const out = runNode('compose-telegram-message' + suffixFor(edition), verified)[0].json;
    assert.doesNotMatch(out.message, /[━─═]{4,}/, edition + ': no line of box-drawing characters');
    assert.match(out.message, /\n\nℹ️ <b>ABOUT THIS BRIEF<\/b>\n/, edition + ': the closing section header');
    const about = out.message.slice(out.message.indexOf('ℹ️ <b>ABOUT THIS BRIEF</b>'));
    assert.match(about, /📎 <i>/, edition + ': sources inside the closing section');
    assert.match(about, /Information only, not financial advice\./, edition + ': the disclaimer inside it');
    assert.ok(out.message.length <= 4096, edition + ': within the Telegram limit');
  }
});

test('the weekly report links to the real dashboard and carries the same buttons', () => {
  const out = runNode('compose-weekly-report', [], {state: {}})[0].json;
  assert.doesNotMatch(out.message, /YOUR_GITHUB_USERNAME/);
  assert.ok(out.message.endsWith('\n' + MP_LINKS.DASHBOARD), 'ends with the dashboard address');
  assert.deepEqual(Object.keys(out.links), ['dashboard', 'feedback', 'share']);
  assert.equal(out.links.dashboard, MP_LINKS.DASHBOARD);
});

test('the channel posts send the buttons and drop the n8n attribution line', () => {
  const template = JSON.parse(read('scripts/workflow-template.json'));
  const node = name => template.nodes.find(n => n.name === name);
  for (const name of ['Send to Telegram', 'Send to Telegram1', 'Send Weekly to Telegram']) {
    const p = node(name).parameters;
    assert.equal(p.replyMarkup, 'inlineKeyboard', name);
    const buttons = p.inlineKeyboard.rows.flatMap(r => r.row.buttons);
    assert.deepEqual(buttons.map(b => [b.text, b.additionalFields.url]), BUTTONS.map(([text, key]) => [text, '={{ $json.links.' + key + ' }}']), name);
    assert.equal(p.additionalFields.appendAttribution, false, name);
  }
  assert.equal(node('Send Status to Telegram').parameters.additionalFields.appendAttribution, false);
});

test('every Telegram send retries, including the weekly report', () => {
  // The 2026-10-04 weekly report was lost to one failed connection: its node was the only one without a retry.
  const template = JSON.parse(read('scripts/workflow-template.json'));
  const sends = template.nodes.filter(n => n.type === 'n8n-nodes-base.telegram');
  assert.ok(sends.some(n => n.name === 'Send Weekly to Telegram'));
  for (const n of sends) assert.deepEqual([n.retryOnFail, n.maxTries, n.waitBetweenTries], [true, 3, 5000], n.name);
});

test('the dashboard uses the same links as the Telegram posts', () => {
  const block = /var LINKS = (\{[\s\S]*?\n {2}\});/.exec(read('docs/app.js'));
  assert.ok(block, 'LINKS block in docs/app.js');
  const links = vm.runInNewContext('(' + block[1] + ')', {});
  assert.deepEqual({...links}, {dashboard: MP_LINKS.DASHBOARD, channel: MP_LINKS.CHANNEL, feedbackForm: MP_LINKS.FEEDBACK_FORM,
    feedbackDetailsField: MP_LINKS.FEEDBACK_DETAILS_FIELD, pitch: MP_LINKS.PITCH});
});

test('the dashboard declares a share preview image, and the image matches its declared size', () => {
  const html = read('docs/index.html');
  assert.match(html, new RegExp('<meta property="og:url" content="' + escapeRegex(MP_LINKS.DASHBOARD) + '">'));
  assert.match(html, new RegExp('<meta property="og:image" content="' + escapeRegex(MP_LINKS.DASHBOARD) + 'assets/og-card\\.png">'));
  const png = readFileSync(new URL('../docs/assets/og-card.png', import.meta.url));
  assert.equal(png.toString('latin1', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200); assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length < 300 * 1024, 'small enough for chat-app previews');
});
