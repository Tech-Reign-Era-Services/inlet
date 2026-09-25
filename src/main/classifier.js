'use strict';

const os = require('os');
const path = require('path');
const { IN_PROGRESS_EXTENSIONS } = require('./defaults');
const { hostOf } = require('./source');

const FOLDERS_CATEGORY = { id: 'folders', name: 'Folders', icon: 'folder', color: '#0A84FF', folder: 'Folders' };
const OLD_FILES_FOLDER = 'Old Downloads'; // where Cleanup archives stale files
const IGNORED_NAMES = new Set(['.DS_Store', '.localized', 'Icon\r', '.com.apple.timemachine.supported']);

function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

function expandHome(p) {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Resolve a destination folder: relative paths live inside the watched folder. */
function resolveFolder(folder, watchDir) {
  const p = expandHome(String(folder || '').trim());
  return path.isAbsolute(p) ? path.normalize(p) : path.join(watchDir, p);
}

/** Where relative destinations resolve: the folder itself, or (for extra folders set to "sort into Downloads") the primary folder. */
const destBase = (settings) => settings.baseDir || settings.watchDir;

function globToRegex(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/** Top-level names inside the watched folder that Inlet itself owns — never sort these. */
function reservedNames(settings) {
  const names = new Set([FOLDERS_CATEGORY.folder.toLowerCase(), OLD_FILES_FOLDER.toLowerCase()]);
  const add = (folder) => {
    const p = expandHome(String(folder || '').trim());
    if (!p) return;
    if (path.isAbsolute(p)) {
      const rel = path.relative(settings.watchDir, p);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) names.add(rel.split(path.sep)[0].toLowerCase());
      return;
    }
    names.add(p.split(/[\\/]/)[0].toLowerCase());
  };
  settings.categories.forEach((c) => add(c.folder));
  settings.rules.forEach((r) => add(r.target));
  return names;
}

function testCondition(cond, file) {
  const value = String(cond.value ?? '').trim();
  if (!value) return false;
  const lower = value.toLowerCase();
  switch (cond.field) {
    case 'name': {
      const name = file.name.toLowerCase();
      if (cond.op === 'contains') return name.includes(lower);
      if (cond.op === 'is') return name === lower || path.parse(name).name === lower;
      if (cond.op === 'startsWith') return name.startsWith(lower);
      if (cond.op === 'endsWith') return path.parse(name).name.endsWith(lower) || name.endsWith(lower);
      if (cond.op === 'matches') {
        try { return new RegExp(value, 'i').test(file.name); } catch { return false; }
      }
      return false;
    }
    case 'extension': {
      const list = lower.split(/[\s,]+/).map((e) => e.replace(/^\./, '')).filter(Boolean);
      const hit = list.includes(extOf(file.name));
      return cond.op === 'isNot' ? !hit : hit;
    }
    case 'source': {
      const src = (file.sources || []).join(' ').toLowerCase();
      if (cond.op === 'contains') return src.includes(lower);
      if (cond.op === 'isNot') return !src.includes(lower);
      return false;
    }
    case 'kind': {
      const kind = String(file.kind || '').toLowerCase();
      if (cond.op === 'contains') return kind.includes(lower);
      if (cond.op === 'isNot') return !!kind && !kind.includes(lower);
      return false;
    }
    case 'content': {
      // file.text is filled in (lowercased) only when a content rule is active — see organizer.enrich.
      if (typeof file.text !== 'string') return false;
      if (cond.op === 'contains') return file.text.includes(lower);
      if (cond.op === 'isNot') return !file.text.includes(lower);
      return false;
    }
    case 'size': {
      const mb = file.size / (1024 * 1024);
      const n = Number(value);
      if (Number.isNaN(n)) return false;
      return cond.op === 'gt' ? mb > n : mb < n;
    }
    case 'age': {
      const days = (Date.now() - (file.addedMs || file.mtimeMs)) / 86400000;
      const n = Number(value);
      if (Number.isNaN(n)) return false;
      return cond.op === 'gt' ? days > n : days < n;
    }
    default:
      return false;
  }
}

/** Does any enabled rule need file text? (Reading text is the only slow condition, so it's opt-in.) */
function needsContent(settings) {
  return settings.rules.some((r) => r.enabled && (r.conditions || []).some((c) => c.field === 'content' && String(c.value ?? '').trim()));
}

/** A rule limited to some folders only applies to files found in them (settings.folderId is the file's folder). */
const ruleAppliesHere = (rule, settings) => !rule.folders || !rule.folders.length || rule.folders.includes(settings.folderId || 'primary');

function ruleMatches(rule, file) {
  const conds = (rule.conditions || []).filter((c) => String(c.value ?? '').trim() !== '');
  if (!rule.enabled || conds.length === 0) return false;
  return rule.match === 'any' ? conds.some((c) => testCondition(c, file)) : conds.every((c) => testCondition(c, file));
}

function dateSubfolder(settings, file) {
  if (settings.dateSubfolders === 'none' || !settings.dateSubfolders) return '';
  const d = new Date(file.addedMs || file.mtimeMs);
  const y = String(d.getFullYear());
  if (settings.dateSubfolders === 'year') return y;
  return `${y}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const RENAME_TOKENS = ['name', 'date', 'year', 'month', 'day', 'source', 'ext'];

/**
 * Apply a rename pattern like "{date} {name}" or "Invoice {source} {date}".
 * The original extension is kept automatically. Returns null when there's nothing to rename.
 */
function renderName(pattern, file) {
  if (!pattern || !String(pattern).trim()) return null;
  const { name: base, ext } = path.parse(file.name);
  const d = new Date(file.addedMs || file.mtimeMs || Date.now());
  const pad = (n) => String(n).padStart(2, '0');
  const src = file.host || hostOf((file.sources || [])[1] || (file.sources || [])[0] || '') || 'unknown';
  const tokens = {
    name: base, ext: ext.slice(1), source: src,
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    year: String(d.getFullYear()), month: pad(d.getMonth() + 1), day: pad(d.getDate()),
  };
  let out = String(pattern).replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? tokens[k] : m));
  out = out.replace(/[/:\0]/g, '-').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!out) return null;
  if (ext && !out.toLowerCase().endsWith(ext.toLowerCase())) out += ext;
  return out === file.name ? null : out;
}

/** Cheap checks that don't need file metadata — used by the watcher before stat()ing. */
function quickSkip(name, settings, reserved = reservedNames(settings)) {
  if (name.startsWith('.') || IGNORED_NAMES.has(name)) return 'hidden';
  if (IN_PROGRESS_EXTENSIONS.includes(extOf(name))) return 'downloading';
  if (reserved.has(name.toLowerCase())) return 'tidy folder';
  if ((settings.ignorePatterns || []).some((g) => g.trim() && globToRegex(g.trim()).test(name))) return 'ignored';
  return null;
}

/**
 * Decide what to do with one entry of the watched folder.
 * file: { name, path, isDir, size, mtimeMs, addedMs, sources[] }
 * Returns { action: 'skip', reason } or { action: 'move', categoryId, dest, reason, ruleId? }.
 */
function classify(file, settings, reserved = reservedNames(settings)) {
  const skip = quickSkip(file.name, settings, reserved);
  if (skip) return { action: 'skip', reason: skip };

  const ext = extOf(file.name);
  const categories = settings.categories.filter((c) => c.enabled);
  const byExt = categories.find((c) => c.id !== 'other' && c.extensions.includes(ext));

  // Directories: packages like .app/.pages count as files; plain folders follow the folder policy.
  if (file.isDir && !byExt) {
    if (settings.folderPolicy !== 'move') return { action: 'skip', reason: 'folder' };
  }

  const withDate = (dir) => {
    const sub = dateSubfolder(settings, file);
    return sub ? path.join(dir, sub) : dir;
  };

  for (const rule of settings.rules) {
    if (!ruleAppliesHere(rule, settings) || !ruleMatches(rule, file)) continue;
    const dest = withDate(resolveFolder(rule.target, destBase(settings)));
    // Attribute the move to a category when the rule targets one of its folders (e.g. "Images/Screenshots").
    const top = String(rule.target).trim().split(/[\\/]/)[0].toLowerCase();
    const cat = categories.find((c) => String(c.folder).toLowerCase() === top);
    const newName = renderName(rule.rename, file);
    return { action: 'move', categoryId: cat ? cat.id : 'rule', dest, reason: `Rule: ${rule.name}`, ruleId: rule.id, ...(newName && { newName }) };
  }

  if (file.isDir && !byExt) {
    return { action: 'move', categoryId: 'folders', dest: withDate(resolveFolder(FOLDERS_CATEGORY.folder, destBase(settings))), reason: 'Folder' };
  }

  if (byExt) {
    return { action: 'move', categoryId: byExt.id, dest: withDate(resolveFolder(byExt.folder, destBase(settings))), reason: `.${ext} → ${byExt.name}` };
  }

  const other = categories.find((c) => c.id === 'other');
  if (settings.unknownFiles === 'other' && other) {
    return { action: 'move', categoryId: 'other', dest: withDate(resolveFolder(other.folder, destBase(settings))), reason: ext ? `Unknown type .${ext}` : 'No extension' };
  }
  return { action: 'skip', reason: 'unknown type' };
}

module.exports = { ruleAppliesHere, OLD_FILES_FOLDER, RENAME_TOKENS, renderName, needsContent, destBase, classify, quickSkip, reservedNames, resolveFolder, extOf, expandHome, ruleMatches, FOLDERS_CATEGORY };
