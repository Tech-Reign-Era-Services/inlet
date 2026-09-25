'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { classify, quickSkip, reservedNames, resolveFolder, needsContent, destBase } = require('./classifier');
const spotlight = require('./spotlight');
const { getSources, hostOf } = require('./source');

const sourceCache = new Map(); // `${path}:${mtimeMs}` → sources[]

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

async function sourcesFor(p, mtimeMs) {
  const key = `${p}:${mtimeMs}`;
  if (!sourceCache.has(key)) {
    if (sourceCache.size > 5000) sourceCache.clear();
    sourceCache.set(key, await getSources(p));
  }
  return sourceCache.get(key);
}

/**
 * Stat one entry and build the file-info object the classifier works with. Returns null if gone or a symlink.
 * opts.knownSources(ino, size, dev): sources Inlet remembers when macOS no longer has them (the provenance ledger).
 */
async function describe(fullPath, opts = {}) {
  let st;
  try { st = await fsp.lstat(fullPath); } catch { return null; }
  if (st.isSymbolicLink()) return null;
  let sources = await sourcesFor(fullPath, st.mtimeMs);
  if (!sources.length && opts.knownSources) sources = opts.knownSources(st.ino, st.isDirectory() ? 0 : st.size, st.dev) || [];
  return {
    name: path.basename(fullPath),
    path: fullPath,
    isDir: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    mtimeMs: st.mtimeMs,
    addedMs: st.birthtimeMs || st.mtimeMs,
    ino: st.ino,
    dev: st.dev, // inode numbers are only unique per disk
    sources,
    host: sources.length ? hostOf(sources[sources.length > 1 ? 1 : 0]) || hostOf(sources[0]) : '',
  };
}

/**
 * Add Spotlight metadata the rules can use: Finder kind always (one batched call),
 * and file text only when a content rule is switched on.
 */
async function enrich(infos, settings) {
  const k = await spotlight.kinds(infos.map((i) => i.path));
  infos.forEach((info, i) => { info.kind = k[i] || ''; });
  if (needsContent(settings)) {
    await mapLimit(infos.filter(spotlight.canReadText), 4, async (info) => { info.text = await spotlight.extractText(info); });
  }
  return infos;
}

/** Scan the watched folder and classify everything in it (a dry run — nothing moves). */
async function scan(settings, opts = {}) {
  const reserved = reservedNames(settings);
  let entries;
  try {
    entries = await fsp.readdir(settings.watchDir, { withFileTypes: true });
  } catch (err) {
    return { items: [], skipped: [], error: err.code === 'EPERM' || err.code === 'EACCES' ? 'permission' : err.message };
  }
  const candidates = [];
  const skipped = [];
  for (const e of entries) {
    const reason = quickSkip(e.name, settings, reserved);
    if (reason) { if (reason !== 'hidden') skipped.push({ name: e.name, reason }); continue; }
    candidates.push(path.join(settings.watchDir, e.name));
  }
  const infos = await enrich((await mapLimit(candidates, 12, (p) => describe(p, opts))).filter(Boolean), settings);
  const items = [];
  for (const info of infos) {
    const decision = classify(info, settings, reserved);
    if (decision.action === 'skip') skipped.push({ name: info.name, reason: decision.reason });
    else items.push({ ...info, decision, folderId: settings.folderId || 'primary', baseDir: destBase(settings) });
  }
  items.sort((a, b) => b.addedMs - a.addedMs);
  return { items, skipped, error: null };
}

/** "report.pdf" → "report (1).pdf", "report (2).pdf", … until the name is free in dir. */
async function uniqueDest(dir, name) {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  const stem = base.replace(/ \(\d+\)$/, '');
  let candidate = path.join(dir, name);
  for (let n = 1; ; n++) {
    try { await fsp.lstat(candidate); } catch { return candidate; }
    candidate = path.join(dir, `${stem} (${n})${ext !== name ? ext : ''}`);
  }
}

async function movePath(src, dest) {
  try {
    await fsp.rename(src, dest);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    // Different volume: copy, verify, then remove the original.
    await fsp.cp(src, dest, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false });
    const [a, b] = await Promise.all([fsp.lstat(src), fsp.lstat(dest)]);
    if (!a.isDirectory() && a.size !== b.size) throw new Error('Copy verification failed');
    await fsp.rm(src, { recursive: true });
  }
}

/**
 * Move a list of { path, dest, categoryId, reason } entries.
 * Returns a history batch: { id, time, trigger, moves: [{ id, from, to, name, categoryId, size, reason, undone }], errors }.
 */
async function execute(entries, trigger) {
  const batch = { id: crypto.randomUUID(), time: Date.now(), trigger, moves: [], errors: [] };
  for (const entry of entries) {
    try {
      let st;
      try { st = await fsp.lstat(entry.path); } catch { continue; } // vanished since the scan
      await fsp.mkdir(entry.dest, { recursive: true });
      const to = await uniqueDest(entry.dest, entry.newName || path.basename(entry.path));
      await movePath(entry.path, to);
      let ino = null;
      let dev = null;
      try { ({ ino, dev } = await fsp.lstat(to)); } catch { /* ignore */ }
      batch.moves.push({
        id: crypto.randomUUID(),
        from: entry.path,
        to,
        name: path.basename(to),
        categoryId: entry.categoryId,
        size: st.isDirectory() ? 0 : st.size,
        reason: entry.reason || '',
        kind: entry.kind || 'move', // 'move' | 'remove' (into the holding area)
        ino, // lets Inlet recognise the file if you later move it yourself in Finder
        fromIno: st.ino, // differs from ino when the move crossed disks (copied, so a new inode)
        dev,
        fromDev: st.dev,
        ...(entry.host && { host: entry.host }),
        ...(path.basename(to) !== path.basename(entry.path) && { originalName: path.basename(entry.path) }),
        undone: false,
      });
    } catch (err) {
      batch.errors.push({ path: entry.path, message: err.message });
    }
  }
  return batch;
}

/** Put moved files back where they came from. Never overwrites. Mutates and returns the moves. */
async function undo(moves) {
  const restored = [];
  const failed = [];
  for (const m of moves) {
    if (m.undone) continue;
    try {
      await fsp.lstat(m.to);
    } catch {
      failed.push({ id: m.id, name: m.name, message: m.purged
        ? 'Already moved to the macOS Trash — open the Trash and use Put Back'
        : 'File is no longer where Inlet put it' });
      continue;
    }
    let exists = true;
    try { await fsp.lstat(m.from); } catch { exists = false; }
    if (exists) {
      failed.push({ id: m.id, name: m.name, message: 'Something else now has the original name' });
      continue;
    }
    try {
      await movePath(m.to, m.from);
      m.undone = true;
      restored.push(m.from);
    } catch (err) {
      failed.push({ id: m.id, name: m.name, message: err.message });
    }
  }
  return { restored, failed };
}

/** Move plan from scan items, honouring per-file overrides { [path]: categoryId }. */
function planFromItems(items, settings, selectedPaths, overrides = {}) {
  const selected = new Set(selectedPaths);
  return items
    .filter((it) => selected.has(it.path))
    .map((it) => {
      const override = overrides[it.path];
      if (override) {
        const cat = settings.categories.find((c) => c.id === override);
        if (cat) return { path: it.path, dest: resolveFolder(cat.folder, it.baseDir || settings.watchDir), categoryId: cat.id, reason: 'Chosen by you', host: it.host };
      }
      return { path: it.path, dest: it.decision.dest, categoryId: it.decision.categoryId, reason: it.decision.reason, newName: it.decision.newName, host: it.host };
    });
}

module.exports = { scan, describe, enrich, execute, undo, uniqueDest, planFromItems };
