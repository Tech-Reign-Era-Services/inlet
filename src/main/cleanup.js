'use strict';

// Cleanup: old files, duplicates, and the holding area that makes removals undoable.
//
// Inlet never deletes directly. "Remove" moves files into a hidden holding folder inside the
// watched folder (same volume, so it's an instant rename). They stay there — fully undoable —
// for settings.retentionDays, then go to the macOS Trash, where Finder's Put Back still works.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { mdlsBatch } = require('./spotlight');
const { reservedNames, FOLDERS_CATEGORY, OLD_FILES_FOLDER } = require('./classifier');

const HOLDING_NAME = '.Inlet Removed';
const MAX_DEPTH = 4;

const LEGACY_HOLDING_NAME = '.Tidy Removed'; // before the app was renamed to Inlet
const holdingDir = (settings) => path.join(settings.watchDir, HOLDING_NAME);

/**
 * Rename each folder's old ".Tidy Removed" to ".Inlet Removed" and point history at the new paths,
 * so removed files stay undoable across the rename. Returns true if anything changed.
 */
function migrateLegacyHolding(settingsList, batches) {
  let changed = false;
  for (const s of settingsList) {
    const oldDir = path.join(s.watchDir, LEGACY_HOLDING_NAME);
    const newDir = holdingDir(s);
    if (!fs.existsSync(oldDir) || fs.existsSync(newDir)) continue;
    try { fs.renameSync(oldDir, newDir); } catch { continue; }
    for (const b of batches) {
      for (const m of b.moves) {
        if (m.to && m.to.startsWith(oldDir + path.sep)) { m.to = newDir + m.to.slice(oldDir.length); changed = true; }
      }
    }
  }
  return changed;
}

/**
 * Regular files Inlet is responsible for: loose files in the watched folder plus everything
 * inside Inlet's own category folders. User folders (projects etc.) are never looked into.
 */
async function collectFiles(settings) {
  const reserved = reservedNames(settings);
  // Moved user folders and already-archived files aren't ours to judge.
  reserved.delete(FOLDERS_CATEGORY.folder.toLowerCase());
  reserved.delete(OLD_FILES_FOLDER.toLowerCase());
  const out = [];
  const walk = async (dir, depth) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        const topLevel = dir === settings.watchDir;
        if (topLevel && !reserved.has(e.name.toLowerCase())) continue;
        if (depth < MAX_DEPTH) await walk(p, depth + 1);
      } else if (e.isFile()) {
        try {
          const st = await fsp.lstat(p);
          out.push({ name: e.name, path: p, size: st.size, mtimeMs: st.mtimeMs, addedMs: st.birthtimeMs || st.mtimeMs, ino: st.ino });
        } catch { /* vanished */ }
      }
    }
  };
  await walk(settings.watchDir, 0);
  return out;
}

/** Spotlight's "last opened" date for many files at once (null when unknown). */
const lastUsedDates = async (paths) => (await mdlsBatch('kMDItemLastUsedDate', paths)).map(parseMdlsDate);

function parseMdlsDate(s) {
  if (!s || s.startsWith('(null)')) return null;
  const iso = s.trim().replace(/^(\S+) (\S+) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Files not opened, modified, or downloaded in the last `days` days, oldest first. */
/** Cleanup works across every watched folder: pass one folder's settings or a list of them. */
const asList = (s) => (Array.isArray(s) ? s : [s]);
const collectAll = async (list) => (await Promise.all(asList(list).map(collectFiles))).flat();

async function findStale(settings, days) {
  const files = await collectAll(settings);
  const used = await lastUsedDates(files.map((f) => f.path));
  const cutoff = Date.now() - days * 86400000;
  return files
    .map((f, i) => {
      const lastUsedMs = Math.max(f.mtimeMs, f.addedMs, used[i] || 0);
      // Only call it "opened" when Spotlight's last-used date is the most recent thing that happened to the file.
      return { ...f, lastUsedMs, opened: !!used[i] && used[i] >= Math.max(f.mtimeMs, f.addedMs) + 1000 };
    })
    .filter((f) => f.lastUsedMs < cutoff)
    .sort((a, b) => a.lastUsedMs - b.lastUsedMs);
}

function hashFile(p) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (d) => h.update(d))
      .on('error', () => resolve(null))
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** "report (1).pdf", "report copy.pdf", "report-1.pdf" look like copies; the plain name is the keeper. */
function copyScore(name) {
  const base = path.parse(name).name;
  if (/ \(\d+\)$/.test(base)) return 2;
  if (/( copy( \d+)?| - copy|-\d)$/i.test(base)) return 1;
  return 0;
}

/** Groups of byte-identical files (size match, then SHA-256). The first file in each group is the suggested keeper. */
async function findDuplicates(settings) {
  const files = (await collectAll(settings)).filter((f) => f.size > 0);
  const bySize = new Map();
  for (const f of files) {
    if (!bySize.has(f.size)) bySize.set(f.size, []);
    bySize.get(f.size).push(f);
  }
  const groups = [];
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map();
    for (const f of same) {
      const h = await hashFile(f.path);
      if (!h) continue;
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(f);
    }
    for (const [hash, list] of byHash) {
      if (list.length < 2) continue;
      list.sort((a, b) => copyScore(a.name) - copyScore(b.name) || a.addedMs - b.addedMs);
      groups.push({ hash, size: list[0].size, files: list });
    }
  }
  return groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
}

/** Holding-area moves whose retention has passed and that are still sitting there. */
function expiredRemovals(batches, retentionDays, now = Date.now()) {
  const out = [];
  for (const b of batches) {
    for (const m of b.moves) {
      if (m.kind === 'remove' && !m.undone && !m.purged && b.time + retentionDays * 86400000 <= now) out.push(m);
    }
  }
  return out;
}

/** Hand removals to the macOS Trash (trashFn = electron's shell.trashItem). Marks them purged. */
async function purge(moves, trashFn) {
  let count = 0;
  for (const m of moves) {
    try {
      await fsp.lstat(m.to);
      await trashFn(m.to);
      count++;
    } catch { /* already gone — nothing to trash */ }
    m.purged = true;
  }
  return count;
}

async function holdingStats(settings) {
  let count = 0; let bytes = 0;
  const walk = async (dir) => {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else { count++; try { bytes += (await fsp.lstat(p)).size; } catch { /* ignore */ } }
    }
  };
  for (const s of asList(settings)) await walk(holdingDir(s));
  return { count, bytes };
}

module.exports = { HOLDING_NAME, LEGACY_HOLDING_NAME, migrateLegacyHolding, holdingDir, collectFiles, findStale, findDuplicates, expiredRemovals, purge, holdingStats, parseMdlsDate, copyScore };
