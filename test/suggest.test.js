'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { defaultSettings } = require('../src/main/defaults');
const suggest = require('../src/main/suggest');
const folders = require('../src/main/folders');
const { classify } = require('../src/main/classifier');

const fresh = () => ({ events: [], dismissed: [] });
const fix = (name, toCat, extra = {}) => ({ name, fromCat: 'other', toCat, ...extra });

test('one correction is not a pattern; two consistent ones are', () => {
  const settings = defaultSettings();
  const learning = fresh();
  suggest.record(learning, [fix('model.stl', 'design')]);
  assert.equal(suggest.suggestions(learning, settings).length, 0);
  suggest.record(learning, [fix('bracket.stl', 'design')]);
  const [s] = suggest.suggestions(learning, settings);
  assert.equal(s.id, 'ext:stl->design');
  assert.match(s.title, /\.stl files into Design/);
});

test('conflicting corrections produce no suggestion', () => {
  const learning = fresh();
  suggest.record(learning, [fix('a.stl', 'design'), fix('b.stl', 'design'), fix('c.stl', 'code'), fix('d.stl', 'code')]);
  assert.equal(suggest.suggestions(learning, defaultSettings()).filter((s) => s.kind === 'extension').length, 0);
});

test('suggests website and name rules, skips what already exists or was dismissed', () => {
  const settings = defaultSettings();
  const learning = fresh();
  suggest.record(learning, [
    fix('statement-june.pdf', 'spreadsheets', { host: 'mybank.com', fromCat: 'documents' }),
    fix('statement-july.pdf', 'spreadsheets', { host: 'mybank.com', fromCat: 'documents' }),
  ]);
  const ids = suggest.suggestions(learning, settings).map((s) => s.id);
  assert.ok(ids.includes('host:mybank.com->spreadsheets'));
  assert.ok(ids.includes('word:statement->spreadsheets'));
  assert.ok(!ids.includes('ext:pdf->spreadsheets')); // two statements aren't a reason to move every PDF

  // Accepting the website suggestion turns it into a rule that then classifies new files.
  const host = suggest.suggestions(learning, settings).find((s) => s.id.startsWith('host:'));
  Object.assign(settings, suggest.applySuggestion(settings, host));
  const rule = settings.rules[settings.rules.length - 1];
  assert.deepEqual(rule.conditions, [{ field: 'source', op: 'contains', value: 'mybank.com' }]);
  const decision = classify({ name: 'aug.pdf', path: '/x/aug.pdf', isDir: false, size: 1, mtimeMs: 1, addedMs: 1, sources: ['https://mybank.com/dl'] }, { ...settings, watchDir: '/x' });
  assert.equal(decision.categoryId, 'spreadsheets');
  assert.ok(!suggest.suggestions(learning, settings).some((s) => s.id.startsWith('host:')));

  learning.dismissed.push('word:statement->spreadsheets');
  assert.ok(!suggest.suggestions(learning, settings).some((s) => s.id.startsWith('word:')));
});

test('extension suggestion moves the extension between categories', () => {
  const settings = defaultSettings();
  const patch = suggest.applySuggestion(settings, { apply: { type: 'extension', ext: 'csv', categoryId: 'code' } });
  assert.ok(patch.categories.find((c) => c.id === 'code').extensions.includes('csv'));
  assert.ok(!patch.categories.find((c) => c.id === 'spreadsheets').extensions.includes('csv'));
  assert.ok(settings.categories.find((c) => c.id === 'spreadsheets').extensions.includes('csv')); // input untouched
});

test('noise words and numbers are ignored', () => {
  assert.deepEqual(suggest.wordsOf('Screenshot 2026-09-25 final copy.png'), []);
  assert.deepEqual(suggest.wordsOf('ACME_invoice-4471.pdf'), ['acme', 'invoice', '4471'].filter((w) => !/^\d+$/.test(w)));
});

test('rules can be limited to folders, and folders can override the mode', () => {
  const settings = { ...defaultSettings(), watchDir: '/dl', mode: 'manual' };
  const desk = { ...folders.newFolder('/desk'), mode: 'auto' };
  settings.extraFolders = [desk];
  settings.rules = [{ id: 'r', name: 'Desk notes', enabled: true, match: 'all', folders: [desk.id], conditions: [{ field: 'name', op: 'contains', value: 'note' }], target: 'Notes' }];
  const f = { name: 'note.txt', path: '/x/note.txt', isDir: false, size: 1, mtimeMs: 1, addedMs: 1, sources: [] };
  const [primary, desktop] = folders.watchedFolders(settings);
  assert.equal(classify(f, folders.folderSettings(settings, primary)).categoryId, 'documents');
  assert.equal(classify(f, folders.folderSettings(settings, desktop)).reason, 'Rule: Desk notes');

  assert.deepEqual(folders.autoFolders(settings).map((x) => x.id), [desk.id]);
  settings.mode = 'auto';
  desk.mode = 'manual';
  assert.deepEqual(folders.autoFolders(settings).map((x) => x.id), ['primary']);
});
