'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultSettings } = require('../src/main/defaults');
const cleanup = require('../src/main/cleanup');
const { scan, execute, undo, planFromItems } = require('../src/main/organizer');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-cleanup-'));
  return { dir, settings: { ...defaultSettings(), watchDir: dir } };
}
const write = (p, content = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };

test('collectFiles covers loose files and Inlet folders, never user folders', async () => {
  const { dir, settings } = sandbox();
  write(path.join(dir, 'loose.pdf'));
  write(path.join(dir, 'Documents', '2025', 'old.pdf'));
  write(path.join(dir, 'my-project', 'src', 'index.js'));
  write(path.join(dir, 'Folders', 'moved-project', 'a.txt'));
  write(path.join(dir, cleanup.HOLDING_NAME, 'removed.pdf'));
  const names = (await cleanup.collectFiles(settings)).map((f) => f.name).sort();
  assert.deepEqual(names, ['loose.pdf', 'old.pdf']);
});

test('findDuplicates groups identical files and keeps the plain name first', async () => {
  const { dir, settings } = sandbox();
  write(path.join(dir, 'report (1).pdf'), 'same bytes');
  write(path.join(dir, 'Documents', 'report.pdf'), 'same bytes');
  write(path.join(dir, 'other.pdf'), 'same size!'); // same length, different content
  const groups = await cleanup.findDuplicates(settings);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files.map((f) => f.name), ['report.pdf', 'report (1).pdf']);
});

test('removing into the holding area is undoable, and expired removals get trashed', async () => {
  const { dir, settings } = sandbox();
  write(path.join(dir, 'dupe.zip'), 'zip');
  const batch = await execute([{ path: path.join(dir, 'dupe.zip'), dest: path.join(cleanup.holdingDir(settings), '2026-09-25'), categoryId: 'removed', kind: 'remove' }], 'cleanup');
  assert.equal(batch.moves[0].kind, 'remove');
  assert.ok(!fs.existsSync(path.join(dir, 'dupe.zip')));
  assert.deepEqual(await cleanup.holdingStats(settings), { count: 1, bytes: 3 });

  await undo(batch.moves);
  assert.ok(fs.existsSync(path.join(dir, 'dupe.zip')));

  // Remove again, then let it expire.
  const again = await execute([{ path: path.join(dir, 'dupe.zip'), dest: cleanup.holdingDir(settings), categoryId: 'removed', kind: 'remove' }], 'cleanup');
  again.time -= 31 * 86400000;
  const expired = cleanup.expiredRemovals([again], 30);
  assert.equal(expired.length, 1);
  const trashed = [];
  await cleanup.purge(expired, async (p) => { trashed.push(p); fs.rmSync(p); });
  assert.equal(trashed.length, 1);
  const res = await undo(again.moves);
  assert.match(res.failed[0].message, /Put Back/);
});

test('rules can rename while moving, and undo restores the original name', async () => {
  const { dir, settings } = sandbox();
  settings.rules = [{ id: 'r', name: 'Scans', enabled: true, match: 'all', conditions: [{ field: 'name', op: 'startsWith', value: 'scan' }], target: 'Documents/Scans', rename: 'Scan {date}' }];
  write(path.join(dir, 'scan0001.pdf'));
  const { items } = await scan(settings);
  const batch = await execute(planFromItems(items, settings, items.map((i) => i.path)), 'manual');
  const moved = batch.moves[0];
  assert.match(moved.name, /^Scan \d{4}-\d{2}-\d{2}\.pdf$/);
  assert.equal(moved.originalName, 'scan0001.pdf');
  await undo(batch.moves);
  assert.ok(fs.existsSync(path.join(dir, 'scan0001.pdf')));
});

test('parses mdls dates and scores copy-looking names', () => {
  assert.equal(cleanup.parseMdlsDate('2025-02-14 05:49:36 +0000'), Date.parse('2025-02-14T05:49:36Z'));
  assert.equal(cleanup.parseMdlsDate('(null)'), null);
  assert.ok(cleanup.copyScore('a (2).pdf') > cleanup.copyScore('a copy.pdf'));
  assert.equal(cleanup.copyScore('a.pdf'), 0);
});
