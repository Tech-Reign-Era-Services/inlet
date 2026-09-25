'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { defaultSettings } = require('../src/main/defaults');
const provenance = require('../src/main/provenance');
const { Ledger, summary } = require('../src/main/ledger');
const { scan } = require('../src/main/organizer');

const mac = process.platform === 'darwin';
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** Give a file the attributes a browser download gets. */
function markDownloaded(file, { urls, app = 'Safari', qid = 'Q-1', time = 0x66f0c000 }) {
  execFileSync('/usr/bin/xattr', ['-w', 'com.apple.quarantine', `0083;${time.toString(16)};${app};${qid}`, file]);
  if (urls) {
    const json = path.join(path.dirname(file), '.wf.json');
    fs.writeFileSync(json, JSON.stringify(urls));
    const hex = execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', json]).toString('hex');
    fs.rmSync(json);
    execFileSync('/usr/bin/xattr', ['-wx', 'com.apple.metadata:kMDItemWhereFroms', hex, file]);
  }
}
const info = (p, extra = {}) => {
  const st = fs.lstatSync(p);
  return { path: p, name: path.basename(p), ino: st.ino, size: st.isDirectory() ? 0 : st.size, isDir: st.isDirectory(), addedMs: st.birthtimeMs, ...extra };
};

test('parses quarantine tags and binary plists', { skip: !mac }, () => {
  assert.deepEqual(provenance.parseQuarantine('0081;66f0c100;sharingd;'), { app: 'AirDrop', downloadedAt: 0x66f0c100 * 1000, qid: '', flags: '0081' });
  assert.equal(provenance.parseQuarantine('0083;66f0c000;com.apple.Safari.SandboxBroker.xpc;X').app, 'Safari');
  assert.equal(provenance.parseQuarantine(''), null);
  const hex = execFileSync('/usr/bin/plutil', ['-convert', 'binary1', '-o', '-', '-'], { input: JSON.stringify(['https://a.com/x', 'https://wiki.org/Straße—ü']) });
  assert.deepEqual(provenance.parseBplistStrings(hex), ['https://a.com/x', 'https://wiki.org/Straße—ü']);
  assert.deepEqual(provenance.parseBplistStrings(Buffer.from('not a plist')), []);
});

test('reads provenance for many files in one go, including awkward names', { skip: !mac }, async () => {
  const dir = tmp('inlet-prov-');
  const a = path.join(dir, 'report: final.pdf');
  const b = path.join(dir, 'photo.jpg');
  const c = path.join(dir, 'nothing.txt');
  for (const f of [a, b, c]) fs.writeFileSync(f, 'x');
  markDownloaded(a, { urls: ['https://cdn.github.com/x.pdf', 'https://github.com/acme/repo'], qid: 'Q-A' });
  markDownloaded(b, { app: 'sharingd', qid: '' });
  const d = path.join(dir, 'setup.dmg');
  fs.writeFileSync(d, 'x');
  markDownloaded(d, { app: 'Google Chrome', qid: 'Q-D' }); // xattr escapes the space when reading several files
  const m = await provenance.readMany([a, b, c, d]);
  assert.equal(m.get(d).app, 'Chrome');
  assert.equal(m.get(a).host, 'github.com'); // the page, not the CDN
  assert.equal(m.get(a).fileHost, 'cdn.github.com');
  assert.equal(m.get(a).app, 'Safari');
  assert.equal(m.get(b).app, 'AirDrop');
  assert.ok(!m.has(c));
});

test('ledger follows renames, survives restarts, and hands an archive’s source to unzipped files', { skip: !mac }, async () => {
  const dir = tmp('inlet-ledger-');
  const data = tmp('inlet-ledger-data-');
  const zip = path.join(dir, 'assets.zip');
  const early = path.join(dir, 'unzipped-first.png');
  const late = path.join(dir, 'unzipped-later.png');
  fs.writeFileSync(early, 'one'); fs.writeFileSync(zip, 'zip'); fs.writeFileSync(late, 'three');
  markDownloaded(zip, { urls: ['https://dl.figma.com/a.zip', 'https://figma.com/community'], qid: 'FAM' });
  markDownloaded(early, { qid: 'FAM', app: 'Archive Utility' }); // extracted files carry the archive's id but no URL
  markDownloaded(late, { qid: 'FAM' });

  const ledger = new Ledger(data);
  const prov = await provenance.readMany([early, zip, late]);
  ledger.record(info(early), prov.get(early)); // seen before the archive: no source yet
  assert.equal(ledger.get(info(early).ino, 3).host, '');
  ledger.record(info(zip), prov.get(zip)); // archive recorded: passes its source down
  ledger.record(info(late), prov.get(late)); // recorded after: inherits straight away
  for (const f of [early, late]) {
    const e = ledger.get(info(f).ino, info(f).size);
    assert.equal(e.host, 'figma.com');
    assert.equal(e.inheritedFrom.name, 'assets.zip');
    assert.equal(e.app, 'Safari'); // the archive's download app, not Archive Utility
  }

  // Renamed by hand: same inode, new path.
  const renamed = path.join(dir, 'Assets from Figma.zip');
  fs.renameSync(zip, renamed);
  ledger.record(info(renamed), null);
  assert.equal(ledger.get(info(renamed).ino, 3).path, renamed);

  // Reload from disk.
  const again = new Ledger(data);
  assert.equal(again.stats().files, 3);
  assert.equal(again.stats().inherited, 2);
  assert.equal(summary(again.get(info(late).ino, 5)).inheritedFrom, 'assets.zip');

  again.clear();
  assert.equal(new Ledger(data).stats().files, 0);
});

test('prune forgets records by when Inlet made them, not by download date; moved() keeps paths current', () => {
  const data = tmp('inlet-ledger-prune-');
  const ledger = new Ledger(data);
  const now = Date.now();
  const day = 86400000;
  // Recorded long ago: forgotten.
  ledger.record({ path: '/x/stale.pdf', ino: 1, size: 10 }, { urls: ['https://a.com'], host: 'a.com', downloadedAt: now - 900 * day }, now - 800 * day);
  // A three-year-old download Inlet only just found: that's exactly what the ledger is for, so it stays.
  ledger.record({ path: '/x/old-download.pdf', ino: 3, size: 10 }, { urls: ['https://b.com'], host: 'b.com', downloadedAt: now - 3 * 365 * day }, now);
  ledger.record({ path: '/x/new.pdf', ino: 2, size: 10 }, { urls: [], host: '', downloadedAt: now - 5 * day }, now);
  assert.equal(ledger.prune(730, now), 1);
  assert.equal(ledger.get(1, 10), null);
  assert.equal(ledger.get(3, 10).host, 'b.com');
  assert.equal(ledger.prune(730, now), 0); // stable: nothing is re-pruned on the next run
  assert.equal(ledger.prune(0, now), 0); // 0 = keep forever
  ledger.moved(2, 10, '/x/Documents/new.pdf');
  assert.equal(new Ledger(data).get(2, 10).path, '/x/Documents/new.pdf');
});

test('moved() follows a move across disks, where the file gets a new inode', () => {
  const data = tmp('inlet-ledger-xdev-');
  const ledger = new Ledger(data);
  ledger.record({ path: '/Users/me/Downloads/talk.mp4', ino: 100, size: 50 }, { urls: ['https://vimeo.com/1'], host: 'vimeo.com' });
  ledger.moved(100, 50, '/Volumes/Archive/Videos/talk.mp4', 900);
  assert.equal(ledger.get(100, 50), null); // the old inode no longer points at it
  assert.equal(ledger.get(900, 50).path, '/Volumes/Archive/Videos/talk.mp4');
  assert.equal(ledger.get(900, 50).host, 'vimeo.com');
  // Undo copies it back across again: another new inode.
  ledger.moved(900, 50, '/Users/me/Downloads/talk.mp4', 101);
  const reloaded = new Ledger(data);
  assert.equal(reloaded.get(101, 50).host, 'vimeo.com');
  assert.equal(reloaded.get(900, 50), null);
  assert.equal(reloaded.stats().files, 1);
});

test('keeps Mail senders and message links as sources, but not data: URLs', { skip: !mac }, async () => {
  const dir = tmp('inlet-ledger-mail-');
  const att = path.join(dir, 'invoice.pdf');
  const blob = path.join(dir, 'pasted.png');
  fs.writeFileSync(att, 'x');
  fs.writeFileSync(blob, 'y');
  markDownloaded(att, { urls: ['Jane Doe <jane@acme.com>', 'message:%3Cabc@acme.com%3E'], app: 'Mail', qid: 'Q-M' });
  markDownloaded(blob, { urls: ['data:image/png;base64,iVBORw0KGgo=', 'https://notes.example.com/page'], qid: 'Q-B' });
  const prov = await provenance.readMany([att, blob]);
  assert.deepEqual(prov.get(att).urls, ['Jane Doe <jane@acme.com>', 'message:%3Cabc@acme.com%3E']); // a "source contains acme.com" rule matches these
  assert.deepEqual(prov.get(blob).urls, ['https://notes.example.com/page']);
  const { getSources } = require('../src/main/source');
  assert.ok((await getSources(att)).some((u) => u.includes('acme.com')));
});

test('files on different disks with the same inode number get separate records', () => {
  const data = tmp('inlet-ledger-dev-');
  const ledger = new Ledger(data);
  // Folders are stored with size 0, so a folder on an external disk can share inode AND size with one on the startup disk.
  ledger.record({ path: '/Users/me/Downloads/repo', ino: 42, dev: 1, size: 0, isDir: true }, { urls: ['https://github.com/acme/repo'], host: 'github.com' });
  ledger.record({ path: '/Volumes/Ext/Downloads/photos', ino: 42, dev: 7, size: 0, isDir: true }, { urls: [], host: '' });
  assert.equal(ledger.stats().files, 2);
  assert.equal(ledger.get(42, 0, 1).host, 'github.com');
  assert.equal(ledger.get(42, 0, 7).host, ''); // doesn't inherit the other disk's website
  assert.equal(ledger.get(42, 0, 7).path, '/Volumes/Ext/Downloads/photos');
  ledger.moved(42, 0, '/Volumes/Ext/Downloads/Folders/photos', 42, { dev: 7 });
  const reloaded = new Ledger(data);
  assert.equal(reloaded.get(42, 0, 1).path, '/Users/me/Downloads/repo'); // untouched
  assert.equal(reloaded.get(42, 0, 7).path, '/Volumes/Ext/Downloads/Folders/photos');

  // Records without a device id (written before it was kept) still match, and pick it up when next seen.
  ledger.record({ path: '/x/old.pdf', ino: 5, size: 9 }, { urls: ['https://a.com'], host: 'a.com' });
  assert.equal(ledger.get(5, 9, 1).host, 'a.com');
  assert.equal(ledger.record({ path: '/x/old.pdf', ino: 5, size: 9, dev: 1 }, null).dev, 1);
  assert.equal(ledger.stats().files, 3);
  assert.ok(!('dev' in ledger.toJSON()[0])); // internal, not exported
});

test('website rules use a remembered source when macOS has lost it', async () => {
  const dir = tmp('inlet-ledger-rules-');
  const f = path.join(dir, 'report.pdf');
  fs.writeFileSync(f, 'x');
  const settings = { ...defaultSettings(), watchDir: dir };
  settings.rules = [{ id: 'r', name: 'From GitHub', enabled: true, match: 'all', conditions: [{ field: 'source', op: 'contains', value: 'github.com' }], target: 'Code' }];
  const plain = await scan(settings);
  assert.equal(plain.items[0].decision.categoryId, 'documents');
  const st = fs.lstatSync(f);
  const known = (ino, size) => (ino === st.ino && size === st.size ? ['https://github.com/acme/report.pdf'] : []);
  const withLedger = await scan(settings, { knownSources: known });
  assert.equal(withLedger.items[0].decision.reason, 'Rule: From GitHub');
  assert.equal(withLedger.items[0].host, 'github.com');
});
