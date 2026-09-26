'use strict';

// Runs a parsed query (see parse.js) across every source of truth and explains each match:
//   1. Spotlight (mdfind), for names, text, kinds, sizes and dates, fast and over everything indexed
//   2. the provenance ledger, for where files came from, even when macOS has forgotten
//   3. Inlet's history, for "what did Inlet move / remove"
//   4. a direct scan, for folders Spotlight doesn't index
// Dates note: kMDItemDateAdded resets whenever a file is moved (e.g. by Inlet), so "downloaded
// when" uses the download time Inlet recorded, kMDItemDownloadedDate, or the file's creation date.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { resolveFolder, destBase, extOf } = require('../classifier');
const folders = require('../folders');
const spotlight = require('../spotlight');
const provenance = require('../provenance');
const { summary: originSummary } = require('../ledger');

const MDFIND = '/usr/bin/mdfind';
const MAX_RESULTS = 300;
const FOLDER_CAP = 20000;
const DAY = 86400000;
const SKIP = /\/(?:\.[^/]+|node_modules|Library|\.git)(?:\/|$)/; // hidden folders, dependencies, app data

/**
 * Is `p` inside a hidden folder, dependencies or app data *below* the search root that contains it? Only the
 * part under the root is tested: a watched folder that itself lives in ~/Library or a hidden folder (iCloud
 * Drive is ~/Library/Mobile Documents/…) must still return its files.
 */
function skipped(p, roots) {
  const r = path.resolve(p);
  const root = roots.filter((d) => r === d || folders.isInside(r, d)).sort((a, b) => b.length - a.length)[0];
  return SKIP.test(`/${root ? path.relative(root, r) : r}`);
}

const esc = (s) => String(s).replace(/[\\"*]/g, (c) => `\\${c}`);
const iso = (ms) => `$time.iso(${new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')})`;

/** Extensions for a kind chip. */
function kindExts(kind, categories) {
  if (kind.type === 'ext') return [kind.ext];
  if (kind.type === 'category') return (categories.find((c) => c.id === kind.id) || { extensions: [] }).extensions;
  return [];
}

/** Query → Spotlight query string (apps and ledger-only sources are handled outside Spotlight). */
function toSpotlight(q, { categories, now = Date.now() }) {
  const and = [];
  if (q.kinds.length) {
    const any = [];
    for (const k of q.kinds) {
      if (k.type === 'screenshot') any.push('kMDItemIsScreenCapture == 1', 'kMDItemFSName == "Screenshot*"c', 'kMDItemFSName == "Screen Shot*"c');
      else for (const e of kindExts(k, categories)) any.push(`kMDItemFSName == "*.${esc(e)}"c`);
    }
    if (any.length) and.push(`(${any.join(' || ')})`);
  }
  if (q.time) {
    const r = (attr) => `(${attr} >= ${iso(q.time.from)} && ${attr} < ${iso(q.time.to)})`;
    if (q.time.field === 'opened') and.push(r('kMDItemLastUsedDate'));
    else if (q.time.field === 'modified') and.push(r('kMDItemContentModificationDate'));
    else and.push(`(${r('kMDItemDownloadedDate')} || ${r('kMDItemFSCreationDate')})`);
  }
  if (q.notOpenedDays) {
    and.push(q.notOpenedDays >= 36500 ? 'kMDItemLastUsedDate != "*"' : `(kMDItemLastUsedDate < ${iso(now - q.notOpenedDays * DAY)} || kMDItemLastUsedDate != "*")`);
  }
  if (q.size?.min) and.push(`kMDItemFSSize >= ${Math.round(q.size.min)}`);
  if (q.size?.max) and.push(`kMDItemFSSize <= ${Math.round(q.size.max)}`);
  if (q.sources.length) and.push(`(${q.sources.map((s) => `kMDItemWhereFroms == "*${esc(s)}*"cd`).join(' || ')})`);
  for (const p of q.phrases) and.push(`kMDItemTextContent == "*${esc(p)}*"cd`);
  // Leftover words: any of them, in the name, title or text. Sentences carry stray words, so requiring
  // all of them would lose good matches; results with more of them in the name rank first.
  if (q.words.length) {
    and.push(`(${q.words.map((w) => `kMDItemFSName == "*${esc(w)}*"cd || kMDItemTextContent == "*${esc(w)}*"cd || kMDItemTitle == "*${esc(w)}*"cd`).join(' || ')})`);
  }
  return and.length ? and.join(' && ') : null;
}

/** mdfind, stopping after `cap` results so a huge folder can't stall the search. */
function mdfind(queryString, dir, { cap = FOLDER_CAP, timeout = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(MDFIND, ['-onlyin', dir, queryString]);
    const paths = [];
    let rest = '';
    let capped = false;
    const done = () => { clearTimeout(timer); resolve({ paths, capped }); };
    const timer = setTimeout(() => { capped = true; child.kill(); }, timeout);
    child.stdout.on('data', (chunk) => {
      const lines = (rest + chunk).split('\n');
      rest = lines.pop();
      for (const l of lines) {
        if (!l) continue;
        if (paths.length >= cap) { capped = true; child.kill(); return; }
        paths.push(l);
      }
    });
    child.on('error', done);
    child.on('close', () => { if (rest && paths.length < cap) paths.push(rest); done(); });
  });
}

/** Is this folder in the Spotlight index? (Checked once per session.) */
const indexedCache = new Map();
async function isIndexed(dir) {
  if (indexedCache.has(dir)) return indexedCache.get(dir);
  let entries = [];
  try { entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.')); } catch { /* unreadable */ }
  const probe = entries.find((e) => e.isFile()) || entries[0];
  let ok = true;
  // Ask for one known item by its exact name: fast, unlike listing the folder (mdfind only returns when done).
  if (probe) ok = (await mdfind(`kMDItemFSName == "${esc(probe.name)}"`, dir, { cap: 5, timeout: 8000 })).paths.length > 0;
  indexedCache.set(dir, ok);
  return ok;
}

/**
 * Where to look. Roots are searched for their loose files directly; each top-level subfolder is
 * searched with Spotlight separately, so one enormous folder (say, code projects) can be skipped
 * for broad searches without losing the rest.
 */
async function areas(settings, everywhere, only) {
  const roots = only || (everywhere ? [os.homedir()] : scopes(settings, false));
  const subdirs = [];
  for (const r of roots) {
    try {
      for (const d of await fsp.readdir(r, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.') || (everywhere && d.name === 'Library')) continue;
        subdirs.push(path.join(r, d.name));
      }
    } catch { /* unreadable */ }
  }
  return { roots, subdirs };
}

// Signs that a folder holds code projects (they contain hundreds of thousands of files nobody searches by plain English).
const CODE_MARKERS = new Set(['node_modules', '.git', 'venv', '.venv', 'Pods', 'DerivedData', 'target', '.gradle']);
const codeCache = new Map(); // root → { at, names: Set of top-level folder names }

async function hasCodeMarker(dir, depth) {
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (CODE_MARKERS.has(e.name) || e.name.endsWith('.xcodeproj')) return true;
  }
  if (depth <= 0) return false;
  for (const e of entries) {
    if (e.isDirectory() && !e.name.startsWith('.') && await hasCodeMarker(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

/** Top-level folders of `root` that contain code projects (checked 4 levels deep, cached for 10 minutes). */
async function codeFolders(root) {
  const hit = codeCache.get(root);
  if (hit && Date.now() - hit.at < 600000) return hit.names;
  const names = new Set();
  try {
    for (const e of await fsp.readdir(root, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      if (CODE_MARKERS.has(e.name) || await hasCodeMarker(path.join(root, e.name), 3)) names.add(e.name);
    }
  } catch { /* unreadable */ }
  codeCache.set(root, { at: Date.now(), names });
  return names;
}

/** Where to look: watched folders plus category folders that live elsewhere, or the whole home folder. */
function scopes(settings, everywhere) {
  if (everywhere) return [os.homedir()];
  const dirs = new Set();
  for (const fs_ of folders.eachFolderSettings(settings)) {
    dirs.add(path.resolve(fs_.watchDir));
    for (const c of settings.categories) dirs.add(path.resolve(resolveFolder(c.folder, destBase(fs_))));
  }
  // Drop folders inside other scopes.
  const list = [...dirs].sort((a, b) => a.length - b.length);
  return list.filter((d, i) => !list.slice(0, i).some((p) => folders.isInside(d, p)));
}

/** File facts needed to check and explain a match. */
async function facts(p, ledger) {
  let st;
  try { st = await fsp.lstat(p); } catch { return null; }
  const e = ledger ? ledger.get(st.ino, st.isDirectory() ? 0 : st.size, st.dev) : null;
  return {
    path: p,
    name: path.basename(p),
    ext: extOf(path.basename(p)),
    isDir: st.isDirectory(),
    size: st.isDirectory() ? 0 : st.size,
    ino: st.ino,
    createdAt: st.birthtimeMs || st.mtimeMs,
    modifiedAt: st.mtimeMs,
    downloadedAt: (e && e.downloadedAt) || 0,
    entry: e,
  };
}

/** Check the conditions Spotlight couldn't (apps, ledger sources), and those for non-Spotlight candidates. Returns reasons, or null. */
async function check(f, q, ctx, { trustSpotlight }) {
  const reasons = [];
  const when = f.downloadedAt || f.createdAt;
  const origin = f.entry ? originSummary(f.entry) : null;

  if (q.place && !inPlace(f.path, q.place, ctx.settings)) return null;

  if (q.kinds.length) {
    const hit = q.kinds.find((k) => (k.type === 'screenshot'
      ? /^screen ?shot/i.test(f.name)
      : kindExts(k, ctx.settings.categories).includes(f.ext)));
    if (!hit && !trustSpotlight) return null;
    reasons.push(hit ? (hit.type === 'ext' ? hit.label.toUpperCase().slice(1) : hit.label.replace(/s$/, '')) : q.kinds[0].label);
  }

  if (q.sources.length) {
    const hosts = [origin?.host, ...(f.entry?.urls || [])].filter(Boolean).map((h) => h.toLowerCase());
    const hit = q.sources.find((s) => hosts.some((h) => h.includes(s)));
    if (!hit && !trustSpotlight) return null;
    const host = origin?.host || hit;
    reasons.push(origin?.inheritedFrom ? `from ${host} (unzipped from ${origin.inheritedFrom})` : `from ${host}`);
  }

  if (q.apps.length) {
    const app = origin?.app || (ctx.prov.has(f.path) ? ctx.prov.get(f.path)?.app : (await provenance.readOne(f.path))?.app) || '';
    if (!q.apps.includes(app)) return null;
    reasons.push(app === 'AirDrop' ? 'via AirDrop' : `downloaded with ${app}`);
  }

  if (q.time) {
    if (q.time.field === 'downloaded') {
      if (!trustSpotlight || f.downloadedAt) {
        if (when < q.time.from || when >= q.time.to) return null;
      }
      reasons.push(`downloaded ${fmtDate(when)}`);
    } else if (q.time.field === 'modified') {
      if (!trustSpotlight && (f.modifiedAt < q.time.from || f.modifiedAt >= q.time.to)) return null;
      reasons.push(`changed ${fmtDate(f.modifiedAt)}`);
    } else {
      if (!trustSpotlight) {
        const used = await lastUsed(f.path);
        if (!used || used < q.time.from || used >= q.time.to) return null;
      }
      reasons.push(`opened ${q.time.label.replace(/^opened /, '')}`);
    }
  }

  if (q.notOpenedDays) {
    const used = await lastUsed(f.path);
    if (!trustSpotlight && used && used >= Date.now() - q.notOpenedDays * DAY) return null;
    reasons.push(used ? `last opened ${fmtDate(used)}` : 'never opened');
  }

  if (q.size) {
    if (!trustSpotlight && ((q.size.min && f.size < q.size.min) || (q.size.max && f.size > q.size.max))) return null;
    reasons.push(fmtBytes(f.size));
  }

  const lower = f.name.toLowerCase();
  let text = null;
  const readText = async () => {
    if (text !== null) return text;
    if (ctx.noText || !spotlight.canReadText(f)) return (text = '');
    if (ctx.textBudget <= 0) { ctx.textSkipped = true; return (text = ''); }
    ctx.textBudget--;
    return (text = await spotlight.extractText({ ...f, mtimeMs: f.modifiedAt }));
  };
  for (const p of q.phrases) {
    if (!trustSpotlight && !(await readText()).includes(p.toLowerCase())) return null;
    reasons.push(`mentions “${p}”`);
  }
  if (q.words.length) {
    const inName = q.words.filter((w) => lower.includes(w.toLowerCase()));
    if (inName.length) {
      reasons.push(`name has ${inName.map((w) => `“${w}”`).join(', ')}`);
      f.nameHits = inName.length;
    } else {
      if (!trustSpotlight) {
        const t = await readText();
        if (!q.words.some((w) => t.includes(w.toLowerCase()))) return null;
      }
      reasons.push(`mentions ${q.words.map((w) => `“${w}”`).join(' or ')}`);
    }
  }

  if (q.inletAction) reasons.unshift(q.inletAction === 'moved' ? 'moved by Inlet' : 'removed');
  return reasons;
}

const lastUsedCache = new Map();
async function lastUsed(p) {
  if (!lastUsedCache.has(p)) {
    const [raw] = await spotlight.mdlsBatch('kMDItemLastUsedDate', [p]);
    lastUsedCache.set(p, raw ? Date.parse(raw.trim().replace(/^(\S+) (\S+) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4')) || 0 : 0);
    if (lastUsedCache.size > 5000) lastUsedCache.clear();
  }
  return lastUsedCache.get(p);
}

function inPlace(p, place, settings) {
  const r = path.resolve(p);
  if (place.folderId) {
    const f = folders.watchedFolders(settings).find((x) => x.id === place.folderId);
    return !!f && folders.isInside(r, path.resolve(f.path));
  }
  const c = settings.categories.find((x) => x.id === place.categoryId);
  if (!c) return false;
  return folders.eachFolderSettings(settings).some((fs_) => folders.isInside(r, path.resolve(resolveFolder(c.folder, destBase(fs_)))));
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: new Date(ms).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
function fmtBytes(n) {
  if (!n) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(3, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
}

/** Loose files at the top of a folder (used when that folder is searched sub-folder by sub-folder). */
async function checkLoose(root, q, ctx, found, add) {
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch { return; }
  const loose = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => path.join(root, e.name));
  await prefetch(loose, q, ctx);
  for (const p of loose) {
    if (found.has(p)) continue;
    const f = await facts(p, ctx.ledger);
    if (f) add(f, await check(f, q, ctx, { trustSpotlight: false }));
  }
}

/** Files in a folder Spotlight doesn't index (depth-limited, skipping hidden folders and dependencies). */
async function walkFiles(dir, depth = 0, out = [], root = dir) {
  if (depth > 4 || out.length > 5000) return out;
  let entries = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (skipped(p, [root])) continue;
    if (e.isDirectory()) await walkFiles(p, depth + 1, out, root);
    else if (e.isFile()) out.push({ path: p });
  }
  return out;
}

/** Read download apps and last-opened dates for many files in one go, before checking them one by one. */
async function prefetch(paths, q, ctx) {
  if (q.apps.length) {
    const unknown = paths.filter((p) => !ctx.prov.has(p));
    const m = await provenance.readMany(unknown);
    for (const p of unknown) ctx.prov.set(p, m.get(p) || null);
  }
  if (q.notOpenedDays || q.time?.field === 'opened') {
    const todo = paths.filter((p) => !lastUsedCache.has(p));
    const raw = await spotlight.mdlsBatch('kMDItemLastUsedDate', todo);
    todo.forEach((p, i) => lastUsedCache.set(p, raw[i] ? Date.parse(raw[i].trim().replace(/^(\S+) (\S+) ([+-]\d{2})(\d{2})$/, '$1T$2$3:$4')) || 0 : 0));
  }
}

/** "from trip": if nothing was ever downloaded from there, it's a word, not a website. */
async function reconsiderSources(q, ctx, dirs) {
  const keep = [];
  for (const s of q.sources) {
    if (s.includes('.')) { keep.push(s); continue; }
    const inLedger = [...(ctx.ledger?.entries.values() || [])].some((e) => (e.host || '').includes(s) || e.urls.some((u) => u.includes(s)));
    let inSpotlight = false;
    if (!inLedger) {
      for (const d of dirs) if ((await mdfind(`kMDItemWhereFroms == "*${esc(s)}*"cd`, d, { cap: 1, timeout: 5000 })).paths.length) { inSpotlight = true; break; }
    }
    if (inLedger || inSpotlight) keep.push(s);
    else {
      q.words.push(s);
      q.notes.push(`Nothing was downloaded from “${s}”, so Inlet looked for the word in names and text instead.`);
    }
  }
  q.sources = keep;
}

/** Files from Inlet's history: "what did Inlet move this morning", "files I removed". */
async function fromHistory(q, ctx) {
  const out = [];
  for (const b of ctx.batches) {
    if (q.time && (b.time < q.time.from || b.time >= q.time.to)) continue;
    for (const m of b.moves) {
      if (q.inletAction === 'removed' ? m.kind !== 'remove' : m.kind === 'remove') continue;
      const where = m.userMoved?.to || (m.undone ? m.from : m.to);
      if (!where) continue;
      const f = await facts(where, ctx.ledger);
      if (!f) continue;
      const rest = { ...q, time: null, inletAction: null };
      const reasons = await check(f, rest, ctx, { trustSpotlight: false });
      if (!reasons) continue;
      const verb = m.kind === 'remove' ? 'Removed' : 'Moved';
      out.push({ f, reasons: [`${verb} by Inlet ${fmtDate(b.time)}, ${new Date(b.time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`, ...reasons], at: b.time });
    }
  }
  return out;
}

/**
 * Run a query. ctx: { settings, ledger, batches, everywhere }.
 * Returns { results: [{ path, name, isDir, size, date, where, origin, reasons }], notes, took, scopes }.
 */
async function search(query, ctxIn) {
  const started = Date.now();
  const ctx = { ...ctxIn, prov: new Map(), textBudget: 80, textSkipped: false };
  const q = JSON.parse(JSON.stringify(query));
  q.notes = [...(q.notes || [])];
  const dirs = scopes(ctx.settings, ctx.everywhere);
  const found = new Map(); // path → { f, reasons, score }

  // `ours`: a file from Inlet's own history. Removed files live in Inlet's hidden holding folder, so the
  // hidden-folder rule mustn't hide them from "what did I remove".
  const add = (f, reasons, bonus = 0, ours = false) => {
    if (!f || !reasons || (!ours && skipped(f.path, dirs)) || found.has(f.path)) return;
    found.set(f.path, { f, reasons, score: reasons.length + bonus + (f.nameHits || 0) * 2 });
  };

  if (q.inletAction) {
    for (const r of await fromHistory(q, ctx)) add(r.f, r.reasons, 1, true);
    return finish(found, q, ctx, dirs, started);
  }

  await reconsiderSources(q, ctx, dirs);
  const { roots } = await areas(ctx.settings, ctx.everywhere);
  const broad = !q.words.length && !q.phrases.length && !q.sources.length && !q.kinds.length;
  const wantsCode = ctx.includeCode || q.kinds.some((k) => k.id === 'code' || (k.ext && (ctx.settings.categories.find((c) => c.id === 'code')?.extensions || []).includes(k.ext)));
  const qs = toSpotlight(q, { categories: ctx.settings.categories });
  const unindexed = [];
  const leftOut = new Map(); // code folder name → matches left out

  // 1. Spotlight. One query per watched folder is fastest (each mdfind call has a fixed cost), but code
  //    projects hold hundreds of thousands of files: specific searches drop matches inside them, and broad
  //    ones search the other folders one by one so the projects are never listed at all.
  if (qs) {
    const spotPaths = [];
    for (const r of roots) {
      if (!(await isIndexed(r))) { unindexed.push(r); continue; }
      const code = wantsCode ? new Set() : await codeFolders(r);
      const inCode = (p) => {
        const top = path.relative(r, p).split(path.sep)[0];
        return code.has(top) ? top : null;
      };
      // One query over the whole folder is fastest, and the only fast way to search text (a scoped text query
      // costs ~0.5 s per folder). But a broad metadata query ("never opened") would list every file in the code
      // projects, so those go sub-folder by sub-folder, skipping the projects.
      if (!code.size || !broad) {
        for (const p of (await mdfind(qs, r, { cap: 50000, timeout: 30000 })).paths) {
          const c = inCode(p);
          if (c) leftOut.set(c, (leftOut.get(c) || 0) + 1); else spotPaths.push(p);
        }
      } else {
        const { subdirs } = await areas(ctx.settings, ctx.everywhere, [r]);
        const lists = await Promise.all(subdirs.filter((d) => !code.has(path.basename(d))).map((d) => mdfind(qs, d)));
        spotPaths.push(...lists.flatMap((l) => l.paths));
        for (const c of code) leftOut.set(c, null); // how many matched there is unknown: they were never searched
        await checkLoose(r, q, ctx, found, add);
      }
    }
    const paths = [...new Set(spotPaths)].filter((p) => !skipped(p, dirs)).slice(0, 2000);
    await prefetch(paths, q, ctx);
    for (const p of paths) {
      const f = await facts(p, ctx.ledger);
      if (f) add(f, await check(f, q, ctx, { trustSpotlight: true }));
    }
  } else {
    for (const r of roots) if (!(await isIndexed(r))) unindexed.push(r);
  }
  if (leftOut.size) {
    const n = [...leftOut.values()].reduce((a, b) => a + (b || 0), 0);
    q.notes.push(`Left out ${n ? `${n.toLocaleString()} matches in ` : ''}code projects (${[...leftOut.keys()].map((k) => `“${k}”`).join(', ')}).`);
    q.codeLeftOut = true;
  }

  // 2. The ledger: sources macOS has forgotten, download apps, and download times.
  //    (Text checks here are limited by ctx.textBudget; Spotlight already covered text in indexed folders.)
  if (ctx.ledger && (q.sources.length || q.apps.length || q.time?.field === 'downloaded')) {
    for (const e of ctx.ledger.entries.values()) {
      if (found.has(e.path)) continue;
      if (!dirs.some((d) => folders.isInside(path.resolve(e.path), d))) continue;
      const f = await facts(e.path, ctx.ledger);
      if (!f || f.entry !== e) continue; // moved or replaced since
      // Spotlight has already checked the text of indexed files; don't read it all again here.
      const indexed = unindexed.every((d) => !folders.isInside(path.resolve(e.path), d));
      add(f, await check(f, q, { ...ctx, noText: indexed }, { trustSpotlight: false }));
    }
  }

  // 3. Folders Spotlight doesn't index: check their files directly.
  for (const d of unindexed) {
    for (const c of await walkFiles(d)) {
      if (found.has(c.path)) continue;
      const f = await facts(c.path, ctx.ledger);
      if (f) add(f, await check(f, q, ctx, { trustSpotlight: false }));
    }
  }

  return finish(found, q, ctx, dirs, started);
}

function finish(found, q, ctx, dirs, started) {
  const results = [...found.values()]
    .sort((a, b) => b.score - a.score || (b.f.downloadedAt || b.f.createdAt) - (a.f.downloadedAt || a.f.createdAt))
    .slice(0, MAX_RESULTS)
    .map(({ f, reasons }) => ({
      path: f.path,
      name: f.name,
      isDir: f.isDir,
      size: f.size,
      date: f.downloadedAt || f.createdAt,
      where: folders.whereLabel(ctx.settings, f.path),
      origin: f.entry ? originSummary(f.entry) : null,
      reasons: [...new Set(reasons)],
    }));
  const notes = [...q.notes];
  if (ctx.textSkipped) notes.push('Some files weren’t checked for text, to keep the search fast. Add another detail to narrow it down.');
  return { results, total: found.size, notes, codeLeftOut: !!q.codeLeftOut, took: Date.now() - started, scopes: dirs, query: q };
}

module.exports = { search, toSpotlight, scopes };
