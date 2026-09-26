'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Shelf, parseNotch, layout, MAX_ITEMS, EAR, SHOULDER } = require('../src/main/shelf');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

test('keeps files by reference, newest first, and remembers them', () => {
  const dir = tmp('shelf-');
  const a = path.join(dir, 'a.pdf');
  const b = path.join(dir, 'b.png');
  fs.writeFileSync(a, 'a');
  fs.writeFileSync(b, 'b');
  fs.mkdirSync(path.join(dir, 'Folder'));
  fs.mkdirSync(path.join(dir, 'Deck.key'));

  const shelf = new Shelf(dir);
  const added = shelf.addFiles([a, b, path.join(dir, 'missing.txt'), 'relative/path', a]);
  assert.deepEqual(added.map((it) => it.name), ['a.pdf', 'b.png']);
  assert.deepEqual(shelf.list().map((it) => it.name), ['a.pdf', 'b.png']);

  shelf.addFiles([path.join(dir, 'Folder'), path.join(dir, 'Deck.key')]);
  assert.equal(shelf.list().find((it) => it.name === 'Folder').isDir, true);
  assert.equal(shelf.list().find((it) => it.name === 'Deck.key').isDir, false, 'packages behave like files');

  // Adding a file again moves it to the front instead of duplicating it.
  shelf.addFiles([b]);
  assert.equal(shelf.list()[0].path, b);
  assert.equal(shelf.list().filter((it) => it.path === b).length, 1);

  // The files themselves are never touched.
  assert.equal(fs.readFileSync(a, 'utf8'), 'a');
  assert.deepEqual(new Shelf(dir).list(), shelf.list(), 'survives a restart');
});

test('text and links', () => {
  const shelf = new Shelf(tmp('shelf-'));
  const [link] = shelf.addText('  https://www.figma.com/file/abc  ');
  assert.equal(link.kind, 'link');
  assert.equal(link.text, 'https://www.figma.com/file/abc');
  assert.equal(link.name, 'figma.com/file/abc');
  const [note] = shelf.addText('Meeting notes\nsecond line');
  assert.equal(note.kind, 'text');
  assert.equal(note.name, 'Meeting notes');
  assert.equal(shelf.addText('see https://a.com here')[0].kind, 'text', 'a URL inside a sentence is text');
  assert.deepEqual(shelf.addText('   '), []);
  shelf.addText('https://www.figma.com/file/abc');
  assert.equal(shelf.list().filter((it) => it.kind === 'link').length, 1, 'no duplicates');
  assert.equal(shelf.list()[0].kind, 'link');
});

test('remove, clear, prune and the size cap', () => {
  const dir = tmp('shelf-');
  const shelf = new Shelf(dir);
  const f = path.join(dir, 'x.txt');
  fs.writeFileSync(f, 'x');
  shelf.addFiles([f]);
  const [t] = shelf.addText('keep me');
  assert.equal(shelf.prune(), false);
  fs.rmSync(f); // e.g. dragged into Finder, which moved it
  assert.equal(shelf.prune(), true);
  assert.deepEqual(shelf.list().map((it) => it.id), [t.id], 'text survives a prune');
  assert.equal(shelf.remove(['nope']), 0);
  assert.equal(shelf.remove([t.id]), 1);
  for (let i = 0; i < MAX_ITEMS + 5; i++) shelf.addText(`note ${i}`);
  assert.equal(shelf.list().length, MAX_ITEMS);
  assert.equal(shelf.list()[0].text, `note ${MAX_ITEMS + 4}`, 'the oldest fall off');
  assert.equal(shelf.clear(), MAX_ITEMS);
  assert.deepEqual(new Shelf(dir).list(), []);
});

test('ignores a damaged shelf file', () => {
  const dir = tmp('shelf-');
  fs.writeFileSync(path.join(dir, 'shelf.json'), '{not json');
  assert.deepEqual(new Shelf(dir).list(), []);
  fs.writeFileSync(path.join(dir, 'shelf.json'), JSON.stringify({ items: [null, { id: 'a', kind: 'file' }, { id: 'b', kind: 'text', text: 'ok' }] }));
  assert.deepEqual(new Shelf(dir).list().map((it) => it.id), ['b']);
});

// Measured on a 14" MacBook Pro: 1710 pt wide, a 209 × 38 pt notch at x 751.
const MBP = JSON.stringify({ width: 1710, safeTop: 38, leftWidth: 751, rightX: 960 });
const MBP_DISPLAY = { bounds: { x: 0, y: 0, width: 1710, height: 1112 }, workArea: { x: 0, y: 40, width: 1710, height: 1015 } };

test('reads the notch', () => {
  assert.deepEqual(parseNotch(MBP), { left: 751, width: 209, height: 38, screenWidth: 1710 });
  assert.equal(parseNotch(JSON.stringify({ width: 2560, safeTop: 0, leftWidth: 0, rightX: 0 })), null, 'no notch');
  assert.equal(parseNotch('garbage'), null);
});

test('sits on the notch and grows around it', () => {
  const notch = parseNotch(MBP);
  const empty = layout(MBP_DISPLAY, notch, 0);
  assert.equal(empty.hasNotch, true);
  assert.deepEqual(empty.closed, { x: 751, y: 0, width: 209, height: 38 }, 'empty: exactly the notch, so it is invisible');
  assert.deepEqual(empty.island.closed, { width: 209, height: 38 });
  const full = layout(MBP_DISPLAY, notch, 3);
  assert.deepEqual(full.island.closed, { width: 209 + EAR * 2, height: 38 }, 'with items: room for the newest item and the count');
  assert.deepEqual(full.closed, { x: 751 - EAR - SHOULDER, y: 0, width: 209 + (EAR + SHOULDER) * 2, height: 38 }, '…and the shoulders');
  const center = (r) => r.x + r.width / 2;
  assert.equal(center(full.open), center(full.closed), 'opens around the notch');
  assert.equal(center(full.open), 751 + 209 / 2);
  assert.ok(full.open.width > full.island.open.width && full.open.height > full.island.open.height, 'room for the shadow');
  assert.equal((full.island.open.width - 209) % 2, 0, 'the island centres exactly');
});

test('without a notch it is a thin strip in the middle of the menu bar', () => {
  const display = { bounds: { x: -2560, y: -300, width: 2560, height: 1440 }, workArea: { x: -2560, y: -275, width: 2560, height: 1415 } };
  const L = layout(display, null, 0);
  assert.equal(L.hasNotch, false);
  assert.equal(L.closed.y, -300);
  assert.equal(L.closed.x + L.closed.width / 2, -1280);
  assert.ok(L.closed.height < 10, 'never covers menu bar items');
  // A notch measured on another screen (e.g. the lid is closed and an external display is primary) is ignored.
  assert.equal(layout(display, parseNotch(MBP), 0).hasNotch, false);
});
