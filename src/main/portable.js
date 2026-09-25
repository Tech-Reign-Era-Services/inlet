'use strict';

// Rules and categories as a portable file: export/import, and an optional sync file
// (put it in iCloud Drive or Dropbox and every Mac running Inlet shares the same rules).
// Only settings that mean the same thing on any Mac travel; folder paths never do.
const fs = require('fs');
const path = require('path');

const FORMAT = 'inlet-rules';
const LEGACY_FORMATS = ['tidy-rules']; // files saved before the app was renamed to Inlet
const FORMAT_VERSION = 1;
const PORTABLE_KEYS = ['categories', 'rules', 'ignorePatterns', 'dateSubfolders', 'unknownFiles', 'folderPolicy'];

/** The shareable part of settings. Folder-scoped rules become "all folders" — folder ids are per-Mac. */
function pick(settings) {
  const out = {};
  for (const k of PORTABLE_KEYS) out[k] = JSON.parse(JSON.stringify(settings[k]));
  out.rules = out.rules.map((r) => ({ ...r, folders: [] }));
  return out;
}

function toFile(settings, appVersion, updatedAt = Date.now()) {
  return { format: FORMAT, formatVersion: FORMAT_VERSION, app: 'Inlet', appVersion, updatedAt, settings: pick(settings) };
}

const isStr = (v) => typeof v === 'string';

/** Validate a parsed file. Returns { error } or { settings, updatedAt, summary }. */
function parse(data) {
  if (!data || ![FORMAT, ...LEGACY_FORMATS].includes(data.format) || !data.settings) return { error: 'This isn’t an Inlet rules file.' };
  if (data.formatVersion > FORMAT_VERSION) return { error: 'This file was made by a newer version of Inlet. Update Inlet and try again.' };
  const s = data.settings;
  if (!Array.isArray(s.categories) || !s.categories.every((c) => c && isStr(c.id) && isStr(c.name) && isStr(c.folder) && Array.isArray(c.extensions))) {
    return { error: 'The categories in this file are damaged.' };
  }
  if (!Array.isArray(s.rules) || !s.rules.every((r) => r && isStr(r.id) && isStr(r.name) && Array.isArray(r.conditions) && isStr(r.target))) {
    return { error: 'The rules in this file are damaged.' };
  }
  const clean = {};
  for (const k of PORTABLE_KEYS) if (k in s) clean[k] = s[k];
  clean.categories = clean.categories.map((c) => ({ ...c, extensions: c.extensions.filter(isStr).map((e) => e.toLowerCase()), enabled: c.enabled !== false }));
  if (!clean.categories.some((c) => c.id === 'other')) {
    return { error: 'The file is missing the “Other” category.' };
  }
  clean.rules = clean.rules.map((r) => ({ ...r, folders: [], enabled: r.enabled !== false }));
  return {
    settings: clean,
    updatedAt: Number(data.updatedAt) || 0,
    summary: { categories: clean.categories.length, rules: clean.rules.length, from: data.appVersion || '?' },
  };
}

function readFile(file) {
  try { return parse(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (err) {
    return { error: err.code === 'ENOENT' ? 'File not found.' : 'Couldn’t read that file.' };
  }
}

/** Atomic write so another Mac never syncs half a file. */
function writeFile(file, settings, appVersion, updatedAt) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(toFile(settings, appVersion, updatedAt), null, 2));
  fs.renameSync(tmp, file);
}

/** Did any shareable setting change between two settings objects? */
const portableChanged = (a, b) => JSON.stringify(pick(a)) !== JSON.stringify(pick(b));

module.exports = { PORTABLE_KEYS, pick, toFile, parse, readFile, writeFile, portableChanged };
