'use strict';

// Learns from what people do in Finder after Inlet has sorted something:
//  - dragged from Images into Design  → a correction ("that belonged in Design"), fed to suggest.js
//  - dragged back out into Downloads  → "leave this one here": auto mode won't sort it again
// Files are recognised by inode + size, which survive moves and renames on the same volume.
const fsp = require('fs').promises;
const path = require('path');
const folders = require('./folders');
const { resolveFolder, destBase } = require('./classifier');
const cleanup = require('./cleanup');

const RECENT_MS = 30 * 86400000; // only watch what Inlet moved in the last 30 days

/** Moves still worth following: real moves (not removals), not undone, and not already explained. */
function trackedMoves(batches, now = Date.now()) {
  const out = [];
  for (const b of batches) {
    if (now - b.time > RECENT_MS) continue;
    for (const m of b.moves) {
      if (m.kind === 'remove' || m.undone || m.purged || m.userMoved || !m.ino) continue;
      out.push({ move: m, batch: b });
    }
  }
  return out;
}

/** 'root' if the file sits loose in a watched folder, else the id of the category folder it's in (deepest match), else null. */
function categoryAt(settings, filePath) {
  const dir = path.dirname(path.resolve(filePath));
  const watched = folders.watchedFolders(settings);
  if (watched.some((f) => path.resolve(f.path) === dir)) return 'root';
  let best = null;
  let bestLen = -1;
  for (const f of watched) {
    const base = destBase(folders.folderSettings(settings, f));
    for (const c of settings.categories) {
      const catDir = path.resolve(resolveFolder(c.folder, base));
      if (folders.isInside(dir, catDir) && catDir.length > bestLen) { best = c.id; bestLen = catDir.length; }
    }
  }
  return best;
}

/** A file that appeared loose in a watched folder but is one Inlet already sorted: the person moved it back. */
function returnedMove(batches, file) {
  if (!file.ino) return null;
  for (const { move } of trackedMoves(batches)) {
    if (move.ino === file.ino && move.size === file.size && move.to !== file.path) return move;
  }
  for (const b of batches) {
    for (const m of b.moves) {
      if (m.userMoved?.returned && m.ino === file.ino && m.size === file.size) return m;
    }
  }
  return null;
}

/**
 * Check where recently sorted files are now. Marks moves the person changed (`userMoved`) and
 * returns corrections for suggest.record(). Mutates the batches it's given.
 */
async function detectRelocations(settings, batches, now = Date.now()) {
  const tracked = trackedMoves(batches, now);
  const missing = [];
  for (const t of tracked) {
    try {
      const st = await fsp.lstat(t.move.to);
      if (st.ino === t.move.ino) continue; // still where Inlet put it
    } catch { /* moved, renamed or deleted */ }
    missing.push(t);
  }
  if (!missing.length) return { corrections: [], changed: 0, relocated: [] };

  const byIno = new Map();
  for (const fs_ of folders.eachFolderSettings(settings)) {
    for (const f of await cleanup.collectFiles(fs_)) byIno.set(`${f.ino}:${f.size}`, f.path);
  }

  const corrections = [];
  const relocated = []; // moves found at a new place in this run (not ones found earlier)
  for (const { move } of missing) {
    const now_ = byIno.get(`${move.ino}:${move.size}`);
    if (!now_) { move.userMoved = { at: now, to: null }; continue; } // deleted, or moved somewhere Inlet doesn't watch
    const where = categoryAt(settings, now_);
    move.userMoved = { at: now, to: now_, ...(where === 'root' && { returned: true }), ...(where && where !== 'root' && { categoryId: where }) };
    relocated.push(move);
    if (where && where !== 'root' && where !== move.categoryId && settings.categories.some((c) => c.id === where)) {
      corrections.push({ name: move.originalName || move.name, host: move.host || '', fromCat: move.categoryId, toCat: where, folderId: folders.folderFor(settings, now_)?.id });
    }
  }
  return { corrections, changed: missing.length, relocated };
}

module.exports = { trackedMoves, categoryAt, returnedMove, detectRelocations };
