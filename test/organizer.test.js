'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultSettings } = require('../src/main/defaults');
const { classify } = require('../src/main/classifier');
const { scan, execute, undo, planFromItems } = require('../src/main/organizer');
const { Watcher } = require('../src/main/watcher');

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-test-'));
  const settings = { ...defaultSettings(), watchDir: dir };
  return { dir, settings };
}
const touch = (dir, name, content = 'x') => fs.writeFileSync(path.join(dir, name), content);
const file = (name, extra = {}) => ({ name, path: `/x/${name}`, isDir: false, size: 10, mtimeMs: Date.now(), addedMs: Date.now(), sources: [], ...extra });

test('classifies by extension, rules, and skips in-progress/hidden files', () => {
  const { settings } = sandbox();
  assert.equal(classify(file('photo.JPG'), settings).categoryId, 'images');
  assert.equal(classify(file('Report.pdf'), settings).categoryId, 'documents');
  assert.equal(classify(file('server.pem'), settings).categoryId, 'keys');
  assert.equal(classify(file('movie.mp4.crdownload'), settings).reason, 'downloading');
  assert.equal(classify(file('.DS_Store'), settings).action, 'skip');
  assert.equal(classify(file('Images', { isDir: true }), settings).reason, 'tidy folder');
  assert.equal(classify(file('my-project', { isDir: true }), settings).reason, 'folder');
  assert.equal(classify(file('Keynote.app', { isDir: true }), settings).categoryId, 'installers');

  const shot = classify(file('Screenshot 2026-09-01 at 10.00.png'), settings);
  assert.equal(shot.reason, 'Rule: Screenshots');
  assert.equal(shot.categoryId, 'images');
  assert.ok(shot.dest.endsWith(path.join('Images', 'Screenshots')));

  settings.rules.find((r) => r.id === 'rule-github').enabled = true;
  const gh = classify(file('tool.tar.gz', { sources: ['https://codeload.github.com/x', 'https://github.com/x/y'] }), settings);
  assert.equal(gh.reason, 'Rule: From GitHub');

  assert.equal(classify(file('mystery.xyz'), settings).categoryId, 'other');
  settings.unknownFiles = 'leave';
  assert.equal(classify(file('mystery.xyz'), settings).action, 'skip');
});

test('scan → execute → undo round trip, with name conflicts', async () => {
  const { dir, settings } = sandbox();
  touch(dir, 'a.pdf', 'new');
  touch(dir, 'b.png');
  touch(dir, 'half.zip.part');
  fs.mkdirSync(path.join(dir, 'project'));
  fs.mkdirSync(path.join(dir, 'Documents'));
  touch(path.join(dir, 'Documents'), 'a.pdf', 'old');

  const { items, skipped } = await scan(settings);
  assert.deepEqual(items.map((i) => i.name).sort(), ['a.pdf', 'b.png']);
  assert.ok(skipped.some((s) => s.name === 'half.zip.part' && s.reason === 'downloading'));
  assert.ok(skipped.some((s) => s.name === 'project' && s.reason === 'folder'));

  const plan = planFromItems(items, settings, items.map((i) => i.path), { [path.join(dir, 'b.png')]: 'design' });
  const batch = await execute(plan, 'manual');
  assert.equal(batch.errors.length, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'Documents', 'a.pdf'), 'utf8'), 'old'); // never overwrites
  assert.equal(fs.readFileSync(path.join(dir, 'Documents', 'a (1).pdf'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(dir, 'Design', 'b.png')));

  const { restored, failed } = await undo(batch.moves);
  assert.equal(failed.length, 0);
  assert.equal(restored.length, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'a.pdf'), 'utf8'), 'new');
  assert.ok(fs.existsSync(path.join(dir, 'b.png')));
});

test('undo refuses to overwrite a file that reappeared at the original path', async () => {
  const { dir, settings } = sandbox();
  touch(dir, 'c.txt', 'first');
  const { items } = await scan(settings);
  const batch = await execute(planFromItems(items, settings, items.map((i) => i.path)), 'manual');
  touch(dir, 'c.txt', 'second');
  const { failed } = await undo(batch.moves);
  assert.equal(failed.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8'), 'second');
});

test('watcher waits for a download to finish before handing it off', async () => {
  const { dir, settings } = sandbox();
  settings.autoDelaySec = 0.2;
  settings.autoSince = Date.now();
  const ready = [];
  const w = new Watcher({ getSettings: () => settings, onReady: async (p) => ready.push(path.basename(p)) });
  w.start();
  touch(dir, 'big.zip.crdownload', 'partial');
  await new Promise((r) => setTimeout(r, 300));
  fs.renameSync(path.join(dir, 'big.zip.crdownload'), path.join(dir, 'big.zip'));
  await new Promise((r) => setTimeout(r, 4500));
  w.stop();
  assert.deepEqual(ready, ['big.zip']);
});
