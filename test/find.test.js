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
