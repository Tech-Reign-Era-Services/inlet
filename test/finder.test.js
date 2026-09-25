'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultSettings } = require('../src/main/defaults');
const { scan, execute, planFromItems, describe } = require('../src/main/organizer');
const finder = require('../src/main/finder');
const portable = require('../src/main/portable');
const suggest = require('../src/main/suggest');

function sandbox() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-finder-')));
  return { dir, settings: { ...defaultSettings(), watchDir: dir } };
}

async function sortAll(dir, settings, names) {
  for (const n of names) fs.writeFileSync(path.join(dir, n), `content of ${n}`);
  const { items } = await scan(settings);
  const batch = await execute(planFromItems(items, settings, items.map((i) => i.path)), 'manual');
  batch.time = Date.now();
  return [batch];
}

test('a file dragged into another Inlet folder becomes a correction', async () => {
  const { dir, settings } = sandbox();
  const batches = await sortAll(dir, settings, ['part-a.stl', 'part-b.stl']);
  assert.equal(batches[0].moves[0].categoryId, 'other');
  fs.mkdirSync(path.join(dir, 'Design', 'Models'), { recursive: true });
  for (const n of ['part-a.stl', 'part-b.stl']) fs.renameSync(path.join(dir, 'Other', n), path.join(dir, 'Design', 'Models', n));

  const { corrections, changed } = await finder.detectRelocations(settings, batches);
  assert.equal(changed, 2);
  assert.deepEqual(corrections.map((c) => [c.name, c.fromCat, c.toCat]).sort(), [['part-a.stl', 'other', 'design'], ['part-b.stl', 'other', 'design']]);
  assert.ok(batches[0].moves.every((m) => m.userMoved && m.userMoved.categoryId === 'design'));

  // …which is enough for a suggestion, and isn't counted twice on the next check.
  const learning = { events: [], dismissed: [] };
  suggest.record(learning, corrections);
  assert.equal(suggest.suggestions(learning, settings)[0].id, 'ext:stl->design');
  assert.equal((await finder.detectRelocations(settings, batches)).changed, 0);
});

test('a file dragged back out is recognised (so auto mode leaves it alone)', async () => {
  const { dir, settings } = sandbox();
  const batches = await sortAll(dir, settings, ['keep-me.pdf']);
  const back = path.join(dir, 'keep-me-renamed.pdf');
  fs.renameSync(path.join(dir, 'Documents', 'keep-me.pdf'), back); // moved back AND renamed
  const info = await describe(back);
  assert.ok(finder.returnedMove(batches, info));
  await finder.detectRelocations(settings, batches);
  assert.equal(batches[0].moves[0].userMoved.returned, true);
  assert.ok(finder.returnedMove(batches, info)); // still recognised after being marked
  assert.equal(finder.categoryAt(settings, path.join(dir, 'Images', 'x', 'y.png')), 'images');
  assert.equal(finder.categoryAt(settings, back), 'root');
});

test('moves within the same category, deletions, and old history are not corrections', async () => {
  const { dir, settings } = sandbox();
  const batches = await sortAll(dir, settings, ['a.png', 'b.png']);
  fs.mkdirSync(path.join(dir, 'Images', 'Trips'));
  fs.renameSync(path.join(dir, 'Images', 'a.png'), path.join(dir, 'Images', 'Trips', 'a.png'));
  fs.rmSync(path.join(dir, 'Images', 'b.png'));
  const { corrections, changed } = await finder.detectRelocations(settings, batches);
  assert.equal(changed, 2);
  assert.equal(corrections.length, 0);
  const b = batches[0].moves.find((m) => m.name === 'b.png');
  assert.equal(b.userMoved.to, null);

  const old = await sortAll(dir, settings, ['c.png']);
  old[0].time -= 40 * 86400000;
  assert.equal(finder.trackedMoves(old).length, 0);
});

test('rules file: round trip, folder scoping stripped, damaged files rejected', () => {
  const settings = defaultSettings();
  settings.watchDir = '/Users/me/Downloads';
  settings.rules[0].folders = ['some-folder-id'];
  const file = portable.toFile(settings, '1.5.0', 1234);
  assert.equal(file.settings.watchDir, undefined);
  const parsed = portable.parse(JSON.parse(JSON.stringify(file)));
  assert.equal(parsed.updatedAt, 1234);
  assert.deepEqual(parsed.settings.rules[0].folders, []);
  assert.equal(parsed.summary.rules, settings.rules.length);

  assert.match(portable.parse({ hello: 1 }).error, /isn’t an Inlet rules file/);
  assert.match(portable.parse({ ...file, formatVersion: 99 }).error, /newer version/);
  assert.match(portable.parse({ ...file, settings: { ...file.settings, rules: [{ name: 'x' }] } }).error, /rules .* damaged/);
  assert.ok(!portable.portableChanged(settings, { ...settings, watchDir: '/elsewhere' }));
  assert.ok(portable.portableChanged(settings, { ...settings, ignorePatterns: ['*.iso'] }));

  const { dir } = sandbox();
  const f = path.join(dir, 'sync', 'Inlet Rules.json');
  portable.writeFile(f, settings, '1.5.0', 99);
  assert.equal(portable.readFile(f).updatedAt, 99);
});

test('rename from Tidy: old rules files still load, old holding folder moves with its undo history', () => {
  const settings = defaultSettings();
  const legacy = { ...portable.toFile(settings, '1.5.0', 5), format: 'tidy-rules' };
  assert.equal(portable.parse(legacy).updatedAt, 5);

  const cleanup = require('../src/main/cleanup');
  const { dir } = sandbox();
  const oldFile = path.join(dir, cleanup.LEGACY_HOLDING_NAME, '2026-09-25', 'dupe.zip');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, 'x');
  const batches = [{ time: Date.now(), moves: [{ kind: 'remove', to: oldFile }] }];
  assert.equal(cleanup.migrateLegacyHolding([{ ...settings, watchDir: dir }], batches), true);
  assert.equal(batches[0].moves[0].to, path.join(dir, cleanup.HOLDING_NAME, '2026-09-25', 'dupe.zip'));
  assert.ok(fs.existsSync(batches[0].moves[0].to));
});
