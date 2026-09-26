'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaultSettings } = require('../src/main/defaults');
const { parse, withoutChip, isEmpty } = require('../src/main/find/parse');
const { search, toSpotlight } = require('../src/main/find/search');
const { Ledger } = require('../src/main/ledger');
const provenance = require('../src/main/provenance');
const { execute } = require('../src/main/organizer');

const categories = defaultSettings().categories;
const folders = [{ id: 'primary', label: 'Downloads' }, { id: 'desk', label: 'Desktop' }];
const now = new Date('2026-09-25T15:00:00'); // a Friday
const chips = (s) => parse(s, { categories, folders, now }).chips.map((c) => c.label);

test('understands how people describe files', () => {
  const cases = [
    ['pdfs I downloaded from github last week', ['.pdf', 'from github', 'last week']],
    ['that invoice from amazon about the headphones', ['from amazon', 'mentions “headphones”', '“invoice”']],
    ['big videos I haven\'t opened in a month', ['videos', 'not opened in a month', 'over 50 MB']],
    ['screenshots from yesterday', ['screenshots', 'yesterday']],
    ['files airdropped on monday', ['via AirDrop', 'on Monday']],
    ['spreadsheets over 5 MB from docs.google.com', ['spreadsheets', 'from docs.google.com', 'over 5 MB']],
    ['"quarterly report" on my desktop', ['in Desktop', 'mentions “quarterly report”']],
    ['installers i never opened', ['installers', 'never opened']],
    ['dmg files from 2025', ['.dmg', 'in 2025']],
    ['what did inlet move this morning', ['this morning', 'moved by Inlet']],
    ['photos I edited this week', ['images', 'changed this week']],
    ['files downloaded with chrome in march', ['with Chrome', 'in March']],
    ['small images from the past 3 days', ['images', 'last 3 days', 'under 1 MB']],
  ];
  for (const [sentence, expected] of cases) assert.deepEqual(chips(sentence), expected, sentence);
});

test('dates resolve against today', () => {
  const q = parse('files from last week', { categories, now });
  assert.equal(new Date(q.time.from).toDateString(), 'Mon Sep 14 2026');
  assert.equal(new Date(q.time.to).toDateString(), 'Mon Sep 21 2026');
  const nov = parse('in november', { categories, now }); // most recent November
  assert.equal(new Date(nov.time.from).getFullYear(), 2025);
  assert.ok(isEmpty(parse('the files please', { categories, now })));
});

test('people it can’t identify get a note, and chips can be removed', () => {
  const q = parse('the zip my manager sent on teams', { categories, now });
  assert.deepEqual(q.chips.map((c) => c.label), ['.zip', 'with Microsoft Teams']);
  assert.match(q.notes[0], /can’t tell who sent/);
  const fewer = withoutChip(q, 'app:Microsoft Teams');
  assert.deepEqual(fewer.chips.map((c) => c.label), ['.zip']);
});

test('ordinary words aren’t mistaken for months, people, removals or file types', () => {
  const p = (s) => parse(s, { categories, folders, now });
  // Words that merely start like a month
  for (const s of ['slide decks from github', 'marketing plan pdf', 'files I may have saved', 'separate invoices']) assert.equal(p(s).time, undefined, s);
  assert.deepEqual(p('marketing plan pdf').kinds.map((k) => k.label), ['.pdf']);
  assert.ok(p('separate invoices').words.includes('invoice'));
  // …while real months still work, "may" included when it's clearly a date
  assert.equal(p('invoices in may').time.label, 'in May');
  assert.equal(p('photos from sept 2025').time.label, 'in Sept 2025');
  assert.equal(p('files before march').time.label, 'before March');

  // "shared"/"emailed" after a thing, not a person: keep the thing, no "who sent it" note
  const slack = p('pdfs shared on slack');
  assert.deepEqual(slack.chips.map((c) => c.label), ['.pdf', 'with Slack']);
  assert.deepEqual(slack.notes, []);
  const emailed = p('invoice emailed last week');
  assert.deepEqual(emailed.chips.map((c) => c.label), ['last week', '“invoice”']);
  assert.deepEqual(emailed.notes, []);
  assert.match(p('the deck the designer shared').notes[0] || '', /can’t tell who sent/);
  assert.match(p('what my cousin sent').notes[0] || '', /can’t tell who sent/);

  // "never opened" plus a date: both count, and nothing is left behind as a word
  const lastWeek = p('pdfs from last week I never opened');
  assert.deepEqual(lastWeek.chips.map((c) => c.label), ['.pdf', 'last week', 'never opened']);
  const since = p('haven’t opened since march');
  assert.equal(since.notOpenedLabel, 'not opened since March');
  assert.equal(since.notOpenedDays, Math.ceil((now - new Date(2026, 2, 1)) / 86400000));
  assert.deepEqual(since.words, []);

  // "removed" describing a file isn't a question about Inlet's history
  assert.equal(p('photos with background removed').inletAction, null);
  assert.equal(p('what did i remove yesterday').inletAction, 'removed');
  assert.equal(p('files i deleted last week').inletAction, 'removed');

  // "used", "read", "changed" describe the thing unless someone did it or a date follows
  assert.deepEqual(p('pdfs about used cars').chips.map((c) => c.label), ['.pdf', 'mentions “used cars”']);
  assert.equal(p('used car receipts from last week').time.field, 'downloaded');
  assert.equal(p('pdfs opened last week').time.label, 'opened last week');
  assert.equal(p('docs changed on monday').time.label, 'changed on Monday');

  // "the past week" without a number, and counts said in words
  assert.deepEqual(p('files from the past week').chips.map((c) => c.label), ['past week']);
  assert.equal(new Date(p('files from the past week').time.from).toDateString(), 'Sat Sep 19 2026');
  assert.deepEqual(p('in the past month').chips.map((c) => c.label), ['past month']);
  const couple = p('pdfs from a couple of weeks ago');
  assert.deepEqual(couple.chips.map((c) => c.label), ['.pdf', 'a couple of weeks ago']); // no "from couple"
  assert.equal(new Date(couple.time.from).toDateString(), 'Fri Sep 04 2026'); // 3 weeks back…
  assert.equal(new Date(couple.time.to).toDateString(), 'Fri Sep 25 2026'); // …to 1 week back, plus that week
  assert.equal(p('files from several days ago').time.label, 'several days ago');
  assert.equal(p('photos from 3 weeks ago').time.label, '3 weeks ago');
  assert.equal(p('a week ago').time.label, '1 week ago');

  // Everyday words that are also extensions
  assert.deepEqual(p('web pages about taxes').kinds, []);
  assert.deepEqual(p('.pages files about taxes').kinds.map((k) => k.label), ['.pages']);
  assert.deepEqual(p('numbers files').kinds.map((k) => k.label), ['.numbers']);
});

test('a watched folder inside a hidden or Library folder still returns results', { skip: process.platform !== 'darwin' }, async () => {
  // e.g. iCloud Drive, which lives at ~/Library/Mobile Documents/com~apple~CloudDocs
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-find-hidden-')));
  const dir = path.join(base, '.cloud', 'Library', 'Watched');
  fs.mkdirSync(path.join(dir, '.cache'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'headphones-invoice.txt'), 'Tax invoice for headphones');
  fs.writeFileSync(path.join(dir, '.cache', 'headphones-invoice-copy.txt'), 'hidden copy'); // hidden *inside* the folder: still skipped
  const settings = { ...defaultSettings(), watchDir: dir };
  const res = await search(parse('headphones invoice', { categories }), { settings, ledger: null, batches: [] });
  assert.deepEqual(res.results.map((r) => r.name), ['headphones-invoice.txt']);
});

test('“what did I remove” finds files in Inlet’s hidden holding folder', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-find-removed-')));
  const settings = { ...defaultSettings(), watchDir: dir };
  const old = path.join(dir, 'old-setup.dmg');
  fs.writeFileSync(old, 'dmg');
  // Cleanup's "remove" moves files into a hidden holding folder, so they can be undone.
  const batch = await execute([{ path: old, dest: path.join(dir, '.Inlet Removed'), categoryId: 'installers', kind: 'remove' }], 'cleanup');
  const res = await search(parse('what did i remove today', { categories }), { settings, ledger: null, batches: [batch] });
  assert.deepEqual(res.results.map((r) => r.name), ['old-setup.dmg']);
  assert.match(res.results[0].reasons[0], /Removed by Inlet/);
});

test('compiles to a Spotlight query', () => {
  const q = parse('pdfs from github about "tax return" over 2 MB', { categories, now });
  const s = toSpotlight(q, { categories });
  assert.match(s, /kMDItemFSName == "\*\.pdf"c/);
  assert.match(s, /kMDItemWhereFroms == "\*github\*"cd/);
  assert.match(s, /kMDItemTextContent == "\*tax return\*"cd/);
  assert.match(s, /kMDItemFSSize >= 2097152/);
  const never = toSpotlight(parse('videos i never opened', { categories, now }), { categories });
  assert.match(never, /kMDItemLastUsedDate != "\*"/);
  // "downloaded when" must not rely on kMDItemDateAdded, which resets when a file is moved
  assert.doesNotMatch(toSpotlight(parse('files from yesterday', { categories, now }), { categories }), /DateAdded/);
});

test('searches a folder: remembered sources, download apps, text, and Inlet’s history', { skip: process.platform !== 'darwin' }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-find-')));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-find-data-'));
  const settings = { ...defaultSettings(), watchDir: dir };
  fs.mkdirSync(path.join(dir, 'Documents'));
  const write = (rel, text) => { const p = path.join(dir, rel); fs.writeFileSync(p, text); return p; };
  const quarantine = (p, app, qid) => execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;66f0c000;${app};${qid}`, p]);
  const zip = write('repo.zip', 'zip');
  quarantine(zip, 'Google Chrome', 'R1');
  const hex = execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: JSON.stringify(['https://codeload.github.com/a.zip', 'https://github.com/acme/repo']) }).toString('hex');
  execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.metadata:kMDItemWhereFroms', hex, zip]);
  const readme = write('Documents/README.pdf', 'unzipped'); // no where-from of its own…
  quarantine(readme, 'Archive Utility', 'R1'); // …but it came out of repo.zip
  const photo = write('holiday.jpg', 'jpg');
  quarantine(photo, 'sharingd', '');
  write('Documents/invoice-march.txt', 'Tax Invoice Number 4471 for headphones');

  const ledger = new Ledger(data);
  const prov = await provenance.readMany([zip, readme, photo]);
  for (const p of [zip, readme, photo]) {
    const st = fs.lstatSync(p);
    ledger.record({ path: p, name: path.basename(p), ino: st.ino, size: st.size }, prov.get(p));
  }
  const run = async (sentence, extra = {}) => (await search(parse(sentence, { categories, folders: [{ id: 'primary', label: 'Downloads' }] }), { settings, ledger, batches: [], ...extra })).results;

  const fromGithub = await run('pdfs from github');
  assert.deepEqual(fromGithub.map((r) => r.name), ['README.pdf']);
  assert.match(fromGithub[0].reasons.join(' '), /unzipped from repo\.zip/);

  // The unzipped README counts too: it came from a Chrome download.
  assert.deepEqual((await run('files downloaded with chrome')).map((r) => r.name).sort(), ['README.pdf', 'repo.zip']);
  assert.deepEqual((await run('airdropped photos')).map((r) => r.name), ['holiday.jpg']);
  assert.deepEqual((await run('headphones invoice')).map((r) => r.name), ['invoice-march.txt']);

  // "from trip": nothing was downloaded from there, so it's treated as a word
  const trip = await search(parse('photos from holiday', { categories }), { settings, ledger, batches: [] });
  assert.deepEqual(trip.results.map((r) => r.name), ['holiday.jpg']);
  assert.match(trip.notes[0], /looked for the word/);

  // Inlet's own history
  const batch = await execute([{ path: photo, dest: path.join(dir, 'Images'), categoryId: 'images' }], 'manual');
  const moved = await run('what did inlet move today', { batches: [batch] });
  assert.equal(moved[0].name, 'holiday.jpg');
  assert.match(moved[0].reasons[0], /Moved by Inlet/);
});
