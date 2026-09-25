'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { defaultSettings } = require('../src/main/defaults');
const { classify } = require('../src/main/classifier');
const folders = require('../src/main/folders');
const { scan, execute, planFromItems, enrich } = require('../src/main/organizer');
const cleanup = require('../src/main/cleanup');
const spotlight = require('../src/main/spotlight');

function sandbox() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'inlet-folders-')));
  const downloads = path.join(root, 'Downloads');
  const desktop = path.join(root, 'Desktop');
  fs.mkdirSync(downloads); fs.mkdirSync(desktop);
  return { root, downloads, desktop, settings: { ...defaultSettings(), watchDir: downloads } };
}
const file = (name, extra = {}) => ({ name, path: `/x/${name}`, isDir: false, size: 10, mtimeMs: Date.now(), addedMs: Date.now(), sources: [], ...extra });

test('kind and file-text conditions', () => {
  const { settings } = sandbox();
  settings.rules = [
    { id: 'a', name: 'Invoices', enabled: true, match: 'all', conditions: [{ field: 'content', op: 'contains', value: 'Invoice Number' }], target: 'Documents/Invoices' },
    { id: 'b', name: 'Any image', enabled: true, match: 'all', conditions: [{ field: 'kind', op: 'contains', value: 'image' }], target: 'Pictures' },
  ];
  assert.equal(classify(file('scan.pdf', { text: 'tax invoice number 4471' }), settings).reason, 'Rule: Invoices');
  assert.equal(classify(file('scan.pdf', { text: 'a letter' }), settings).categoryId, 'documents');
  assert.equal(classify(file('scan.pdf'), settings).categoryId, 'documents'); // text not read → no match, no crash
  assert.equal(classify(file('photo.heic', { kind: 'HEIF image' }), settings).reason, 'Rule: Any image');
});

test('validates new folders: no duplicates, nesting, or whole-home', () => {
  const { settings, downloads, desktop } = sandbox();
  assert.equal(folders.validateNewFolder(settings, desktop), null);
  assert.match(folders.validateNewFolder(settings, downloads), /already watched/);
  fs.mkdirSync(path.join(downloads, 'projects'));
  assert.match(folders.validateNewFolder(settings, path.join(downloads, 'projects')), /inside/);
  assert.match(folders.validateNewFolder(settings, path.dirname(downloads)), /contains/);
  assert.match(folders.validateNewFolder(settings, os.homedir()), /too much/);
  assert.match(folders.validateNewFolder(settings, path.join(desktop, 'nope')), /doesn’t exist/);
});

test('an extra folder sorts inside itself or into the main folder', async () => {
  const { settings, downloads, desktop } = sandbox();
  fs.writeFileSync(path.join(desktop, 'photo.png'), 'x');
  fs.writeFileSync(path.join(desktop, 'report.pdf'), 'x');
  const extra = folders.newFolder(desktop);
  settings.extraFolders = [extra];

  // "self": Desktop/Images
  let fsSettings = folders.folderSettings(settings, folders.watchedFolders(settings)[1]);
  let { items } = await scan(fsSettings);
  assert.ok(items.every((i) => i.folderId === extra.id));
  assert.equal(items.find((i) => i.name === 'photo.png').decision.dest, path.join(desktop, 'Images'));

  // "primary": Downloads/Images, and overrides also resolve against Downloads
  extra.sortInto = 'primary';
  fsSettings = folders.folderSettings(settings, folders.watchedFolders(settings)[1]);
  ({ items } = await scan(fsSettings));
  assert.equal(items.find((i) => i.name === 'photo.png').decision.dest, path.join(downloads, 'Images'));
  const plan = planFromItems(items, settings, items.map((i) => i.path), { [path.join(desktop, 'report.pdf')]: 'archives' });
  await execute(plan, 'manual');
  assert.ok(fs.existsSync(path.join(downloads, 'Images', 'photo.png')));
  assert.ok(fs.existsSync(path.join(downloads, 'Archives', 'report.pdf')));

  assert.equal(folders.whereLabel(settings, path.join(desktop, 'x.txt')), 'Desktop');
  assert.equal(folders.whereLabel(settings, path.join(downloads, 'Images', 'x.png')), 'Images');
  assert.equal(folders.folderFor(settings, path.join(downloads, 'Images', 'x.png')).id, 'primary');
});

test('cleanup looks across all watched folders', async () => {
  const { settings, downloads, desktop } = sandbox();
  settings.extraFolders = [folders.newFolder(desktop)];
  fs.writeFileSync(path.join(downloads, 'a.zip'), 'same');
  fs.writeFileSync(path.join(desktop, 'a copy.zip'), 'same');
  const groups = await cleanup.findDuplicates(folders.eachFolderSettings(settings));
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].files.map((f) => f.name), ['a.zip', 'a copy.zip']);
});

test('reads text with the Spotlight importer, even outside the index', { skip: process.platform !== 'darwin' }, async () => {
  const { downloads, settings } = sandbox();
  fs.writeFileSync(path.join(downloads, 'bill.txt'), 'Tax Invoice Number 4471\nTotal due');
  settings.rules = [{ id: 'a', name: 'Invoices', enabled: true, match: 'all', conditions: [{ field: 'content', op: 'contains', value: 'invoice number' }], target: 'Documents/Invoices' }];
  const { items } = await scan(settings);
  assert.equal(items[0].decision.reason, 'Rule: Invoices');
  assert.match(items[0].kind, /text/i);
  assert.equal(spotlight.unescapeMdimport('a\\nb \\U2022 \\"c\\"'), 'a\nb • "c"');
  const [info] = await enrich([{ name: 'x.bin', path: path.join(downloads, 'x.bin'), isDir: false, size: 1, mtimeMs: 1 }], settings);
  assert.equal(info.text, undefined); // not a text format → never read
});
