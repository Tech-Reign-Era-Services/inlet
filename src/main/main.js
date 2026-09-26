'use strict';

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage, Menu, globalShortcut, clipboard } = require('electron');
const { Store } = require('./store');
const { Watcher } = require('./watcher');
const organizer = require('./organizer');
const cleanup = require('./cleanup');
const folders = require('./folders');
const spotlight = require('./spotlight');
const suggest = require('./suggest');
const finder = require('./finder');
const portable = require('./portable');
const changelog = require('./changelog');
const provenance = require('./provenance');
const findParse = require('./find/parse');
const findSearch = require('./find/search');
const { Ledger, summary: originSummary } = require('./ledger');
const { classify, ruleMatches, renderName, reservedNames, OLD_FILES_FOLDER } = require('./classifier');
const { TrayController } = require('./tray');
const { Shelf } = require('./shelf');
const { ShelfWindow } = require('./shelfWindow');
const pasteboard = require('./pasteboard');
const updates = require('./updates');

app.setName('Inlet');
// Dev overrides let you point Inlet at a sandbox folder instead of your real Downloads.
// A sandbox gets its own profile, so it runs alongside (not instead of) your real Inlet.
// (INLET_* env vars; the TIDY_* names from before the rename still work.)
const env = (name) => process.env[`INLET_${name}`] || process.env[`TIDY_${name}`];
if (env('DATA_DIR')) app.setPath('userData', path.resolve(env('DATA_DIR')));
const DATA_DIR = app.getPath('userData');
migrateFromTidy();

/** The app used to be called Tidy: bring its settings, history and learning across on first launch. */
function migrateFromTidy() {
  if (env('DATA_DIR')) return;
  const oldDir = path.join(app.getPath('appData'), 'Tidy');
  if (fs.existsSync(path.join(DATA_DIR, 'settings.json')) || !fs.existsSync(path.join(oldDir, 'settings.json'))) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const f of ['settings.json', 'history.json', 'learning.json']) {
    if (fs.existsSync(path.join(oldDir, f))) fs.copyFileSync(path.join(oldDir, f), path.join(DATA_DIR, f));
  }
}
// From package.json, not app.getVersion(): that returns Electron's version when launched unpackaged from a script.
const APP_VERSION = require('../../package.json').version;
const GATHER_FOLDER = 'Gathered'; // Find → "Gather into a folder" puts files in Downloads/Gathered/<name>
const SHELF_SHORTCUT = 'Control+Option+S';
if (!app.requestSingleInstanceLock()) app.quit();

let store;
let ledger; // where files came from (provenance ledger)
const watchers = new Map(); // folder id → Watcher (auto mode only)
let tray;
let shelf; // what's on the Shelf
const shelfWin = new ShelfWindow();
let win = null;
let quitting = false;
let lastScan = { items: [], skipped: [], error: null };
let scanId = 0;
let holding = { count: 0, bytes: 0 };

// ---------- helpers ----------

function publicItem(it) {
  const { name, path: p, isDir, size, addedMs, host, kind, folderId, returned, origin, decision } = it;
  return { name, path: p, isDir, size, addedMs, host, kind, folderId, origin, returned: !!returned, categoryId: decision.categoryId, dest: decision.dest, reason: decision.reason, newName: decision.newName };
}

function undoSummary() {
  const b = store.lastUndoable();
  if (!b) return null;
  return { id: b.id, trigger: b.trigger, time: b.time, count: b.moves.filter((m) => !m.undone && !m.purged && !m.userMoved).length };
}

function state() {
  return {
    settings: store.settings,
    stats: store.stats(),
    autoRunning: store.settings.mode === 'auto' && !!watchers.get(folders.PRIMARY)?.running,
    ledger: ledgerStats(),
    folders: folders.allFolders(store.settings).map((f) => ({ ...f, effectiveMode: folders.effectiveMode(store.settings, f) })),
    suggestions: suggest.suggestions(store.learning, store.settings),
    whatsNew: whatsNew(),
    changelog,
    scanErrors: lastScan.errors || [],
    unsorted: lastScan.items.length,
    unsortedBytes: lastScan.items.reduce((s, i) => s + i.size, 0),
    scanId,
    recent: store.history.batches.slice(0, 6),
    lastUndoable: undoSummary(),
    holding,
    nextScheduled: nextScheduledRun(),
    shelf: { count: shelf ? shelf.list().length : 0, shortcut: shelfShortcutOk ? '⌃⌥S' : '' },
    update: publicUpdate(),
    version: APP_VERSION,
  };
}

function broadcast() {
  if (win && !win.isDestroyed()) win.webContents.send('state:changed', state());
  if (tray) tray.refresh();
}

// Coalesce overlapping scans: callers during a scan get that scan's result, plus one follow-up.
let scanning = null;
let scanAgain = false;
async function rescan() {
  if (scanning) { scanAgain = true; return scanning; }
  scanning = (async () => {
    do {
      scanAgain = false;
      const perFolder = folders.eachFolderSettings(store.settings);
      const results = await Promise.all(perFolder.map((fs_) => organizer.scan(fs_, { knownSources })));
      lastScan = {
        items: results.flatMap((r) => r.items).sort((a, b) => b.addedMs - a.addedMs),
        skipped: results.flatMap((r, i) => r.skipped.map((sk) => ({ ...sk, folderId: perFolder[i].folderId }))),
        error: results[0].error,
        errors: results.map((r, i) => r.error && { folderId: perFolder[i].folderId, error: r.error }).filter(Boolean),
      };
      holding = await cleanup.holdingStats(perFolder);
      // Files Inlet sorted that you dragged back out: show them, but don't tidy them by default.
      for (const it of lastScan.items) if (finder.returnedMove(store.history.batches, it)) it.returned = true;
      await recordFiles(lastScan.items);
      // A file just unzipped only gets its archive's website when it's recorded, after it was classified.
      // Scan once more so website rules (and the plan shown in Organize) use it. Converges: next time it has a source.
      if (lastScan.items.some((it) => !it.sources.length && knownSources(it.ino, it.size, it.dev).length)) scanAgain = true;
      for (const it of lastScan.items) it.origin = ledger ? originSummary(ledger.get(it.ino, it.size, it.dev)) : null;
      await learnFromFinder();
      scanId++;
    } while (scanAgain);
    broadcast();
    if (backfillArmed && backfillPending()) backfillLedger(); // e.g. Downloads access was just granted
    return lastScan;
  })();
  try { return await scanning; } finally { scanning = null; }
}

function showWindow(page) {
  if (!win || win.isDestroyed()) createWindow();
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  win.show();
  win.focus();
  if (page) win.webContents.send('navigate', page);
}

const catName = (id) => store.settings.categories.find((c) => c.id === id)?.name || 'Other';

// Notifications are batched so a burst of downloads produces one banner.
let pendingNotice = [];
let noticeTitle = null;
let noticeTimer = null;
function notifyMoves(moves, title) {
  if (!store.settings.notifications || !Notification.isSupported() || !moves.length) return;
  pendingNotice.push(...moves);
  if (title) noticeTitle = title;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    const list = pendingNotice;
    const heading = noticeTitle;
    pendingNotice = [];
    noticeTitle = null;
    const body = list.length === 1
      ? `${list[0].name} → ${catName(list[0].categoryId)}`
      : `${list.length} files sorted into ${[...new Set(list.map((m) => catName(m.categoryId)))].slice(0, 3).join(', ')}`;
    const n = new Notification({ title: heading || (list.length === 1 ? 'Sorted a download' : 'Sorted your downloads'), body, silent: true });
    n.on('click', () => showWindow('activity'));
    n.show();
  }, 2000);
}

async function runMoves(plan, trigger) {
  const batch = await organizer.execute(plan, trigger);
  // The ledger knows the file by its inode before the move; a move across disks gives it a new one.
  for (const m of batch.moves) if (m.ino && ledger) ledger.moved(m.fromIno || m.ino, m.size, m.to, m.ino, { dev: m.fromDev, newDev: m.dev });
  const saved = store.addBatch(batch);
  if (trigger === 'auto') notifyMoves(batch.moves);
  if (trigger === 'scheduled') notifyMoves(batch.moves, 'Scheduled tidy');
  await rescan();
  return { ...batch, id: saved ? saved.id : batch.id };
}

async function tidyAll(trigger) {
  await rescan();
  const paths = lastScan.items.filter((i) => !i.returned).map((i) => i.path); // respect files you pulled back out
  const plan = organizer.planFromItems(lastScan.items, store.settings, paths);
  return runMoves(plan, trigger);
}

/** A file finished arriving in a watched folder: remember where it came from, and sort it if the folder is in Auto mode. */
async function onArrival(fullPath, folderId) {
  const folder = folders.watchedFolders(store.settings).find((f) => f.id === folderId);
  if (!folder) return;
  let info = await organizer.describe(fullPath, { knownSources });
  if (!info) return;
  await recordFiles([info]);
  // Unzipped files learn their archive's website only now, as they're recorded: describe again so rules see it.
  if (!info.sources.length && knownSources(info.ino, info.size, info.dev).length) info = (await organizer.describe(fullPath, { knownSources })) || info;
  if (folders.effectiveMode(store.settings, folder) === 'auto') await autoSort(info, folders.folderSettings(store.settings, folder));
}

async function autoSort(info, fsettings) {
  // You dragged a sorted file back out: that means "leave it here", so don't sort it again.
  const back = finder.returnedMove(store.history.batches, info);
  if (back) {
    if (!back.userMoved) { back.userMoved = { at: Date.now(), to: info.path, returned: true }; store.save('history'); }
    return;
  }
  await organizer.enrich([info], fsettings);
  const decision = classify(info, fsettings);
  if (decision.action !== 'move') return;
  await runMoves([{ path: info.path, dest: decision.dest, categoryId: decision.categoryId, reason: decision.reason, newName: decision.newName, host: info.host }], 'auto');
}

async function undoBatch(batchId, moveId) {
  const batch = store.findBatch(batchId);
  if (!batch) return { restored: [], failed: [{ message: 'Nothing to undo' }] };
  // Files you've since moved yourself aren't Inlet's to put back.
  const moves = (moveId ? batch.moves.filter((m) => m.id === moveId) : batch.moves).filter((m) => !m.userMoved);
  const res = await organizer.undo(moves);
  const restored = new Set(res.restored);
  for (const m of moves) {
    if (!restored.has(m.from) || !m.ino || !ledger) continue;
    let back = { ino: m.ino, dev: undefined }; // putting it back across disks copies it again, so look up where it landed
    try { back = await fs.promises.lstat(m.from); } catch { /* gone again; keep the old key */ }
    ledger.moved(m.ino, m.size, m.from, back.ino, { dev: m.dev, newDev: back.dev });
  }
  for (const w of watchers.values()) w.suppress(res.restored); // don't let auto mode immediately re-sort what the user just restored
  store.save('history');
  await rescan();
  return res;
}

async function undoLast() {
  const b = store.lastUndoable();
  if (!b) return { restored: [], failed: [], nothing: true };
  return { ...(await undoBatch(b.id)), trigger: b.trigger };
}

/**
 * One watcher per watched folder. In Auto mode it sorts new files; in every mode it notes where they came from
 * (unless "Remember where files came from" is off, in which case only Auto folders are watched).
 */
function applyMode() {
  const recording = store.settings.ledgerEnabled !== false;
  const want = recording ? folders.watchedFolders(store.settings) : folders.autoFolders(store.settings);
  const wantIds = new Set(want.map((f) => f.id));
  for (const [id, w] of watchers) {
    if (!wantIds.has(id)) { w.stop(); watchers.delete(id); }
  }
  for (const f of want) {
    const startedAt = Date.now();
    const current = () => {
      const latest = folders.watchedFolders(store.settings).find((x) => x.id === f.id) || f;
      const fs_ = folders.folderSettings(store.settings, latest);
      // Recording-only watchers look at new arrivals; existing files are covered by the backfill.
      if (folders.effectiveMode(store.settings, latest) !== 'auto') fs_.autoSince = Math.max(fs_.autoSince || 0, startedAt);
      return fs_;
    };
    let w = watchers.get(f.id);
    if (w && w.dir !== f.path) { w.stop(); watchers.delete(f.id); w = null; } // folder was moved/changed
    if (!w) {
      w = new Watcher({
        getSettings: current,
        onReady: (p) => onArrival(p, f.id),
        onError: (err) => console.error(`[watcher ${f.label}]`, err.message),
      });
      watchers.set(f.id, w);
    }
    if (!w.running) w.start();
  }
}
const stopWatchers = () => { for (const w of watchers.values()) w.stop(); watchers.clear(); };

function applySystemSettings() {
  if (process.platform !== 'darwin') return;
  if (app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: !!store.settings.launchAtLogin, openAsHidden: true });
  }
  if (app.dock) {
    if (store.settings.showDockIcon || (win && win.isVisible())) app.dock.show();
    else app.dock.hide();
  }
}

// ---------- where files came from (provenance ledger) ----------

const knownSources = (ino, size, dev) => (ledger ? ledger.get(ino, size, dev)?.urls || [] : []);

/** Remember files we haven't seen (reading what macOS recorded about their origin), and refresh paths of known ones. */
async function recordFiles(infos) {
  if (!ledger || store.settings.ledgerEnabled === false) return;
  const fresh = [];
  for (const i of infos) {
    if (!i || !i.ino) continue;
    if (ledger.has(i)) ledger.record(i, null); else fresh.push(i);
  }
  if (!fresh.length) return;
  const prov = await provenance.readMany(fresh.map((i) => i.path));
  for (const i of fresh) ledger.record(i, prov.get(i.path) || null);
}

/** First run (and each newly added folder): remember the files already there, while macOS still has their origin. */
let backfilling = false;
let backfillArmed = false; // set once startup is done, so rescans don't start it earlier
/** A folder that hasn't been backfilled yet but scanned fine just now. */
function backfillPending() {
  if (!ledger || backfilling || store.settings.ledgerEnabled === false) return false;
  const done = store.settings.ledgerBackfilled || {};
  const failed = new Set((lastScan.errors || []).map((e) => e.folderId));
  return folders.eachFolderSettings(store.settings).some((f) => !done[f.watchDir] && !failed.has(f.folderId));
}
async function backfillLedger() {
  if (!ledger || backfilling || store.settings.ledgerEnabled === false) return;
  backfilling = true;
  try {
    let recorded = false;
    for (const fs_ of folders.eachFolderSettings(store.settings)) {
      // Keyed by path, not id: changing the main folder (always id 'primary') must backfill the new one.
      if ((store.settings.ledgerBackfilled || {})[fs_.watchDir]) continue;
      // Can't read it yet (no Downloads permission, disk not mounted): don't mark it done; a later scan retries.
      let top;
      try { top = await fs.promises.readdir(fs_.watchDir, { withFileTypes: true }); } catch { continue; }
      const files = await cleanup.collectFiles(fs_);
      // Loose folders too (often unzipped downloads): their quarantine id links them to the archive's source.
      // Not Inlet's own folders (Images, Documents, Old Downloads…): they aren't downloads.
      const reserved = reservedNames(fs_);
      for (const d of top) {
        if (!d.isDirectory() || d.name.startsWith('.') || reserved.has(d.name.toLowerCase())) continue;
        const p = path.join(fs_.watchDir, d.name);
        try {
          const st = await fs.promises.lstat(p);
          files.push({ name: d.name, path: p, ino: st.ino, dev: st.dev, size: 0, isDir: true, addedMs: st.birthtimeMs || st.mtimeMs });
        } catch { /* vanished */ }
      }
      for (let i = 0; i < files.length; i += 200) await recordFiles(files.slice(i, i + 200));
      store.updateSettings({ ledgerBackfilled: { ...(store.settings.ledgerBackfilled || {}), [fs_.watchDir]: Date.now() } });
      recorded = true;
    }
    if (recorded) await rescan();
  } finally {
    backfilling = false;
  }
}

let ledgerStatsCache = null;
let ledgerStatsAt = 0;
function ledgerStats() {
  if (!ledger) return null;
  if (!ledgerStatsCache || Date.now() - ledgerStatsAt > 5000) { ledgerStatsCache = ledger.stats(); ledgerStatsAt = Date.now(); }
  return { ...ledgerStatsCache, backfilling };
}

// ---------- learning from Finder ----------

let lastFinderCheck = 0;
async function learnFromFinder() {
  if (Date.now() - lastFinderCheck < 20000) return; // at most every 20s; rescans can be frequent
  lastFinderCheck = Date.now();
  try {
    const { corrections, changed, relocated } = await finder.detectRelocations(store.settings, store.history.batches);
    if (changed) store.save('history');
    // Only this run's finds: older userMoved paths are out of date once Inlet has moved the file again.
    for (const m of relocated || []) if (m.ino && ledger) ledger.moved(m.ino, m.size, m.userMoved.to, m.ino, { dev: m.dev });
    if (corrections.length) {
      suggest.record(store.learning, corrections);
      store.save('learning');
    }
  } catch (err) {
    console.error('[finder]', err.message);
  }
}

// ---------- rules sync & import/export ----------

let syncTimer = null;
let syncWatched = null;

/** Write this Mac's rules to the sync file (debounced), after any change to them. */
function scheduleSyncWrite() {
  if (!store.settings.syncFile) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    const updatedAt = Date.now();
    try {
      portable.writeFile(store.settings.syncFile, store.settings, APP_VERSION, updatedAt);
      store.updateSettings({ syncUpdatedAt: updatedAt, syncError: '' });
    } catch (err) {
      store.updateSettings({ syncError: `Couldn’t write the sync file: ${err.message}` });
    }
    broadcast();
  }, 1000);
}

/** Pick up rules another Mac wrote to the sync file. */
async function readSyncFile() {
  const file = store.settings.syncFile;
  if (!file || !fs.existsSync(file)) return;
  const parsed = portable.readFile(file);
  if (parsed.error) { store.updateSettings({ syncError: parsed.error }); broadcast(); return; }
  if (parsed.updatedAt <= (store.settings.syncUpdatedAt || 0)) return;
  store.updateSettings({ ...parsed.settings, syncUpdatedAt: parsed.updatedAt, syncError: '' });
  await rescan();
  if (win && !win.isDestroyed()) win.webContents.send('sync:applied', parsed.summary);
}

function watchSyncFile() {
  if (syncWatched) fs.unwatchFile(syncWatched);
  syncWatched = store.settings.syncFile || null;
  // Polling, not FSEvents: iCloud/Dropbox replace the file rather than editing it.
  if (syncWatched) fs.watchFile(syncWatched, { interval: 5000 }, () => readSyncFile());
}

/** Run after any settings change: keeps the sync file current when shareable settings changed. */
function afterSettingsChange(prev) {
  if (portable.portableChanged(prev, store.settings)) scheduleSyncWrite();
}

const { newer } = updates;
/** Release notes you haven't seen yet (empty on a fresh install). */
function whatsNew() {
  const seen = store.settings.lastSeenVersion;
  if (!store.settings.onboarded || !seen) return [];
  return changelog.filter((e) => newer(e.version, seen) && !newer(e.version, APP_VERSION));
}

// ---------- schedule ----------

function slotFor(day, time) {
  const [hh, mm] = String(time || '18:00').split(':').map(Number);
  const d = new Date(day);
  d.setHours(hh || 0, mm || 0, 0, 0);
  return d;
}

/** Today's slot if it's due and hasn't run yet (a slot missed while the Mac slept runs on wake, same day only). */
function scheduleDue(now = new Date()) {
  const sch = store.settings.schedule;
  if (!sch || !sch.enabled || !sch.days.includes(now.getDay())) return false;
  const slot = slotFor(now, sch.time).getTime();
  return now.getTime() >= slot && slot > (sch.enabledAt || 0) && (store.settings.lastScheduledRun || 0) < slot;
}

function nextScheduledRun() {
  const sch = store.settings.schedule;
  if (!sch || !sch.enabled || !sch.days.length) return null;
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!sch.days.includes(day.getDay())) continue;
    const slot = slotFor(day, sch.time).getTime();
    if (slot > now.getTime() || (i === 0 && scheduleDue(now))) return slot;
  }
  return null;
}

async function tickSchedule() {
  if (!scheduleDue()) return;
  store.updateSettings({ lastScheduledRun: Date.now() });
  try { await tidyAll('scheduled'); } catch (err) { console.error('[schedule]', err.message); }
}

// ---------- holding area ----------

async function purgeExpired() {
  const expired = cleanup.expiredRemovals(store.history.batches, store.settings.retentionDays);
  if (!expired.length) return;
  await cleanup.purge(expired, (p) => shell.trashItem(p));
  store.save('history');
  await rescan();
}

/** Send everything in the holding area to the macOS Trash now. */
async function emptyHolding() {
  const live = [];
  for (const b of store.history.batches) for (const m of b.moves) if (m.kind === 'remove' && !m.undone && !m.purged) live.push(m);
  await cleanup.purge(live, (p) => shell.trashItem(p));
  // Anything left over (e.g. from before history was cleared).
  for (const fs_ of folders.eachFolderSettings(store.settings)) {
    const dir = cleanup.holdingDir(fs_);
    try {
      for (const name of await fs.promises.readdir(dir)) await shell.trashItem(path.join(dir, name)).catch(() => {});
      await fs.promises.rmdir(dir).catch(() => {});
    } catch { /* no holding dir */ }
  }
  store.save('history');
  await rescan();
}

// ---------- updates ----------

// status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'installing' | 'error'
let update = { status: 'idle', latest: null, progress: 0, error: '', dismissed: false };
let updateNotified = ''; // the version we've already sent a notification about
const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const UPDATE_DIR = path.join(app.getPath('temp'), 'Inlet Update');

function publicUpdate() {
  const { latest } = update;
  const skipped = !!latest && store.settings.skippedVersion === latest.version;
  return { ...update, current: APP_VERSION, checkedAt: store.settings.lastUpdateCheck || 0, skipped, show: update.status !== 'idle' && !!latest && newer(latest.version, APP_VERSION) && !skipped && !update.dismissed };
}

function setUpdate(patch) {
  update = { ...update, ...patch };
  broadcast();
}

/** Ask GitHub for a newer Inlet. manual: the person clicked Check now (so say "up to date", and ignore Skip). */
async function checkForUpdates({ manual = false } = {}) {
  if (!manual && store.settings.updateCheck === false) return;
  if (['checking', 'downloading', 'installing'].includes(update.status)) return;
  setUpdate({ status: 'checking', error: '' });
  try {
    const latest = await updates.fetchLatest({ url: env('UPDATE_URL') || updates.LATEST_URL, userAgent: `Inlet/${APP_VERSION}` });
    store.updateSettings({ lastUpdateCheck: Date.now() });
    const available = !!latest && newer(latest.version, APP_VERSION);
    if (manual && available && store.settings.skippedVersion === latest.version) store.updateSettings({ skippedVersion: '' });
    setUpdate({ status: available ? 'available' : 'current', latest, dismissed: manual ? false : update.dismissed });
    const quiet = store.settings.skippedVersion === latest?.version || updateNotified === latest?.version;
    if (available && !manual && !quiet && Notification.isSupported()) {
      updateNotified = latest.version;
      const n = new Notification({ title: `Inlet ${latest.version} is available`, body: 'Click to see what’s new and update.', silent: true });
      n.on('click', () => showUpdate());
      n.show();
    }
  } catch (err) {
    // A failed automatic check (offline, GitHub busy) stays quiet; a manual one says what went wrong.
    setUpdate({ status: manual ? 'error' : (update.latest ? 'available' : 'idle'), error: manual ? `Couldn’t reach GitHub: ${err.message}` : '' });
  }
}

/** Download the new installer, check it, and open it in macOS Installer (which asks to quit Inlet). */
async function installUpdate() {
  const { latest } = update;
  if (!latest || !latest.asset || ['downloading', 'installing'].includes(update.status)) return;
  setUpdate({ status: 'downloading', progress: 0, error: '' });
  let shown = 0;
  try {
    const file = await updates.download(latest.asset, UPDATE_DIR, {
      // Progress goes straight to the bar, not through a full redraw of the window.
      onProgress: (p) => {
        if (p - shown < 0.01 && p !== 1) return;
        shown = p;
        update.progress = p;
        if (win && !win.isDestroyed()) win.webContents.send('update:progress', p);
      },
    });
    setUpdate({ status: 'installing', progress: 1 });
    const err = await shell.openPath(file);
    if (err) throw new Error(err);
  } catch (err) {
    setUpdate({ status: 'error', error: err.message || String(err) });
  }
}

function showUpdate() {
  showWindow();
  if (win && !win.isDestroyed()) win.webContents.send('update:show');
}

// ---------- the Shelf ----------

let shelfShortcutOk = false;

/** Turn the Shelf and its shortcut on or off to match Settings. */
function applyShelf() {
  const on = store.settings.shelfEnabled !== false && process.platform === 'darwin' && !env('SCREENSHOTS');
  if (on && !shelfWin.wanted) {
    shelfWin.enable().then(() => { shelfWin.setCount(shelf.list().length); }).catch((err) => console.error('[shelf]', err.message));
    try { shelfShortcutOk = globalShortcut.register(SHELF_SHORTCUT, () => shelfWin.toggle()); } catch { shelfShortcutOk = false; }
  } else if (!on && shelfWin.wanted) {
    shelfWin.disable();
    if (shelfShortcutOk) globalShortcut.unregister(SHELF_SHORTCUT);
    shelfShortcutOk = false;
  }
  if (tray) tray.refresh();
}

/** A text or link item as a .txt file, so Quick Look can show it. Kept in the temp folder, removed at quit. */
const QUICK_LOOK_CLOSE_MS = 300;
const SHELF_TEXT_DIR = path.join(app.getPath('temp'), 'Inlet Shelf');
async function shelfTextFile(it) {
  const name = `${it.name.replace(/[/:\\]/g, '-').replace(/^\.+/, '').slice(0, 60).trim() || 'Text'}.txt`;
  const file = path.join(SHELF_TEXT_DIR, it.id, name);
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, it.text);
    return file;
  } catch { return null; }
}

/** After the Shelf's contents change: redraw it, resize the island, and update the main window. */
function shelfChanged() {
  shelfWin.send('shelf:items', shelf.list());
  shelfWin.setCount(shelf.list().length);
  broadcast();
}

function showShelf() {
  if (!shelfWin.alive) return showWindow('settings');
  shelfWin.setState('open', { focus: true });
}

// ---------- window & menu ----------

function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    show: false,
    title: 'Inlet',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    const hidden = app.getLoginItemSettings().wasOpenedAtLogin || env('SCREENSHOTS');
    if (!hidden) win.show();
  });
  win.on('close', (e) => {
    // Keep running in the menu bar so auto mode and the schedule continue.
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (!store.settings.showDockIcon && app.dock) app.dock.hide();
    }
  });
  win.on('focus', () => { rescan(); });
  // Open external links in the browser, never inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

/** After Inlet ▸ Check for Updates…: show the update, or say Inlet is up to date. */
function showUpdateResult() {
  if (publicUpdate().show) return showUpdate();
  showWindow('settings'); // the Updates section says "up to date" or what went wrong
}

function buildMenu() {
  const go = (page, key) => ({ label: page[0].toUpperCase() + page.slice(1), accelerator: `CmdOrCtrl+${key}`, click: () => showWindow(page) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { label: 'Check for Updates…', click: async () => { await checkForUpdates({ manual: true }); showUpdateResult(); } },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showWindow('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        // ⌘Z undoes text edits while typing, otherwise the last thing Inlet did (the renderer decides).
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => win && !win.isDestroyed() && win.webContents.send('menu:undo') },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Go',
      submenu: [{ label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => showWindow('find') }, { type: 'separator' },
        go('overview', 1), go('organize', 2), go('cleanup', 3), go('rules', 4), go('activity', 5), go('settings', 6)],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Take the Tour', click: () => { showWindow(); win.webContents.send('menu:tour'); } }],
    },
  ]));
}

// ---------- IPC ----------

const iconCache = new Map();
const THUMB_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'tif', 'tiff', 'bmp', 'pdf', 'mp4', 'mov', 'm4v', 'svg', 'psd']);

/**
 * A thumbnail (images, PDFs, videos) or the Finder icon, as a data URL. anyKind asks Quick Look for every file,
 * which draws folders and documents at full size (the Shelf's few big tiles); long lists stick to THUMB_EXT.
 */
async function fileIcon(p, size = 80, anyKind = false) {
  const key = `${size}:${p}`;
  if (iconCache.has(key)) return iconCache.get(key);
  let url = null;
  const ext = path.extname(p).slice(1).toLowerCase();
  try {
    if (anyKind || THUMB_EXT.has(ext)) {
      const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
      if (!img.isEmpty()) url = img.toDataURL();
    }
  } catch { /* fall back to the Finder icon */ }
  if (!url) {
    // 'normal' only: 'large' isn't supported on macOS (asking for it crashes Electron).
    try { url = (await app.getFileIcon(p, { size: 'normal' })).toDataURL(); } catch { url = null; }
  }
  if (iconCache.size > 2000) iconCache.clear();
  iconCache.set(key, url);
  return url;
}

// startDrag throws on an empty icon, so fall back to the menu bar icon (always shipped) if the app icon is missing.
let fallbackDragIcon = null;
function dragIconFor(p) {
  const cached = p && iconCache.get(`96:${p}`);
  if (cached) {
    const img = nativeImage.createFromDataURL(cached);
    if (!img.isEmpty()) return img.resize({ width: 56 });
  }
  if (!fallbackDragIcon) {
    const buildImage = (name) => nativeImage.createFromPath(path.join(__dirname, '..', '..', 'build', name));
    fallbackDragIcon = buildImage('icon.png');
    if (fallbackDragIcon.isEmpty()) fallbackDragIcon = buildImage('trayTemplate@2x.png');
    if (!fallbackDragIcon.isEmpty()) fallbackDragIcon = fallbackDragIcon.resize({ width: 48, height: 48 });
  }
  return fallbackDragIcon;
}

/** Only let the renderer act on files Inlet manages: inside a watched folder, outside its holding area. */
function isManagedPath(p) {
  const f = folders.folderFor(store.settings, p);
  const r = path.resolve(p);
  if (!f || r === path.resolve(f.path)) return false;
  return !folders.isInside(r, path.resolve(cleanup.holdingDir(folders.folderSettings(store.settings, f))));
}

function registerIpc() {
  ipcMain.handle('state:get', () => state());

  ipcMain.handle('settings:update', async (_e, patch) => {
    const prev = store.settings;
    if (patch.mode === 'auto' && prev.mode !== 'auto') patch.autoSince = Date.now();
    // A schedule change only applies from now on — don't fire a slot that already passed today.
    if (patch.schedule) patch.schedule = { ...prev.schedule, ...patch.schedule, enabledAt: Date.now() };
    // Onboarding counts as having seen the current release notes.
    if (patch.onboarded && !prev.onboarded) patch.lastSeenVersion = APP_VERSION;
    // Recording switched back on: files that arrived (or were sorted) while it was off need recording too.
    const ledgerOn = patch.ledgerEnabled === true && prev.ledgerEnabled === false;
    if (ledgerOn) patch.ledgerBackfilled = {};
    store.updateSettings(patch);
    afterSettingsChange(prev);
    applyMode();
    applySystemSettings();
    applyShelf();
    await rescan();
    if (ledgerOn) backfillLedger();
    return state();
  });

  ipcMain.handle('settings:reset', async () => {
    const prev = store.settings;
    store.resetSettings();
    afterSettingsChange(prev);
    applyMode();
    applySystemSettings();
    applyShelf();
    await rescan();
    return state();
  });

  const scanResult = () => ({ items: lastScan.items.map(publicItem), skipped: lastScan.skipped, error: lastScan.error, scanId });
  ipcMain.handle('scan', async () => { await rescan(); return scanResult(); });
  ipcMain.handle('scan:get', () => scanResult());

  ipcMain.handle('organize', async (_e, { paths, overrides } = {}) => {
    const selected = paths || lastScan.items.map((i) => i.path);
    const byPath = new Map(lastScan.items.map((i) => [i.path, i]));
    const plan = organizer.planFromItems(lastScan.items, store.settings, selected, overrides || {});
    const batch = await runMoves(plan, 'manual');
    // Learn from destinations picked by hand, so Inlet can suggest a rule next time.
    const moved = new Set(batch.moves.map((m) => m.from));
    const corrections = Object.entries(overrides || {})
      .filter(([p]) => moved.has(p) && byPath.has(p))
      .map(([p, toCat]) => { const it = byPath.get(p); return { name: it.name, host: it.host, fromCat: it.decision.categoryId, toCat, folderId: it.folderId }; });
    if (corrections.length) {
      suggest.record(store.learning, corrections);
      store.save('learning');
      broadcast();
    }
    return batch;
  });

  ipcMain.handle('suggestions:apply', async (_e, id) => {
    const s = suggest.suggestions(store.learning, store.settings).find((x) => x.id === id);
    if (!s) return { error: 'That suggestion is no longer available.' };
    const patch = suggest.applySuggestion(store.settings, s);
    const previous = Object.fromEntries(Object.keys(patch).map((k) => [k, store.settings[k]])); // lets the UI undo it
    const prev = store.settings;
    store.updateSettings(patch);
    afterSettingsChange(prev);
    await rescan();
    return { state: state(), previous, title: s.title };
  });
  ipcMain.handle('suggestions:dismiss', (_e, id) => {
    store.learning.dismissed = [...new Set([...(store.learning.dismissed || []), id])];
    store.save('learning');
    broadcast();
    return state();
  });

  ipcMain.handle('history:get', () => store.history.batches);
  ipcMain.handle('history:undo', (_e, { batchId, moveId }) => undoBatch(batchId, moveId));
  ipcMain.handle('history:undoLast', () => undoLast());
  ipcMain.handle('history:clear', async () => {
    await emptyHolding(); // removed files can't be undone without history, so hand them to the Trash
    store.clearHistory();
    broadcast();
    return true;
  });

  ipcMain.handle('rule:test', async (_e, rule) => {
    // A content condition that isn't saved yet: read the text now (cached per file version).
    if ((rule.conditions || []).some((c) => c.field === 'content' && String(c.value ?? '').trim())) {
      await Promise.all(lastScan.items.filter((it) => it.text === undefined && spotlight.canReadText(it))
        .map(async (it) => { it.text = await spotlight.extractText(it); }));
    }
    const hits = lastScan.items.filter((it) => (!rule.folders || !rule.folders.length || rule.folders.includes(it.folderId))
      && ruleMatches({ ...rule, enabled: true }, it));
    const example = hits[0] || lastScan.items[0];
    return {
      count: hits.length,
      sample: hits.slice(0, 5).map((h) => h.name),
      renameExample: rule.rename && example ? { from: example.name, to: renderName(rule.rename, example) || example.name } : null,
    };
  });

  // ----- cleanup -----
  ipcMain.handle('cleanup:stale', async (_e, days) => {
    const files = await cleanup.findStale(folders.eachFolderSettings(store.settings), days || store.settings.staleDays);
    return files.map(({ name, path: p, size, lastUsedMs, opened }) => ({ name, path: p, size, lastUsedMs, opened, folder: folders.whereLabel(store.settings, p) }));
  });

  ipcMain.handle('cleanup:duplicates', async () => {
    const groups = await cleanup.findDuplicates(folders.eachFolderSettings(store.settings));
    return groups.map((g) => ({
      hash: g.hash,
      size: g.size,
      files: g.files.map(({ name, path: p, addedMs }) => ({ name, path: p, addedMs, folder: folders.whereLabel(store.settings, p) })),
    }));
  });

  ipcMain.handle('cleanup:apply', async (_e, { action, paths, source }) => {
    const valid = (paths || []).filter(isManagedPath);
    const stamp = new Date();
    const reason = source === 'duplicates' ? 'Duplicate' : 'Not used in a while';
    const plan = valid.map((p) => (action === 'archive'
      ? { path: p, dest: path.join(store.settings.watchDir, OLD_FILES_FOLDER, String(stamp.getFullYear())), categoryId: 'old', reason }
      : { path: p, dest: path.join(cleanup.holdingDir(folders.folderSettings(store.settings, folders.folderFor(store.settings, p))), stamp.toISOString().slice(0, 10)), categoryId: 'removed', kind: 'remove', reason }));
    return runMoves(plan, 'cleanup');
  });

  ipcMain.handle('holding:empty', () => emptyHolding());

  // ----- download history (provenance ledger) -----
  ipcMain.handle('ledger:export', async () => {
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('desktop'), 'Inlet Download History.json'), filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    try {
      fs.writeFileSync(res.filePath, JSON.stringify({ app: 'Inlet', exportedAt: new Date().toISOString(), files: ledger.toJSON() }, null, 2));
    } catch (err) {
      return { error: `Couldn’t save the file: ${err.message}` }; // read-only folder, disk full…
    }
    return { path: res.filePath };
  });
  ipcMain.handle('ledger:clear', async () => {
    ledger.clear();
    ledgerStatsCache = null;
    await rescan();
    return state();
  });

  // ----- rules: export / import / sync -----
  const iCloudFolder = () => {
    const icloud = path.join(app.getPath('home'), 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
    return fs.existsSync(icloud) ? path.join(icloud, 'Inlet') : null;
  };
  ipcMain.handle('config:export', async () => {
    const res = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('desktop'), 'Inlet Rules.json'), filters: [{ name: 'Inlet rules', extensions: ['json'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    portable.writeFile(res.filePath, store.settings, APP_VERSION, Date.now());
    return { path: res.filePath };
  });
  ipcMain.handle('config:importPick', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Inlet rules', extensions: ['json'] }] });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const parsed = portable.readFile(res.filePaths[0]);
    return parsed.error ? { error: parsed.error } : { path: res.filePaths[0], summary: parsed.summary };
  });
  ipcMain.handle('config:importApply', async (_e, file) => {
    const parsed = portable.readFile(file);
    if (parsed.error) return { error: parsed.error };
    const prev = store.settings;
    const previous = Object.fromEntries(portable.PORTABLE_KEYS.map((k) => [k, prev[k]]));
    store.updateSettings(parsed.settings);
    afterSettingsChange(prev);
    await rescan();
    return { state: state(), previous };
  });
  ipcMain.handle('sync:pick', async () => {
    const res = await dialog.showOpenDialog(win, {
      message: 'Choose a folder that syncs between your Macs, like iCloud Drive. Inlet keeps an “Inlet Rules.json” file there.',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: iCloudFolder() || app.getPath('documents'),
    });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    const file = path.join(res.filePaths[0], 'Inlet Rules.json');
    if (!fs.existsSync(file)) return { path: file, exists: false };
    const parsed = portable.readFile(file);
    return { path: file, exists: true, error: parsed.error, summary: parsed.summary, updatedAt: parsed.updatedAt };
  });
  ipcMain.handle('sync:set', async (_e, { file, prefer }) => {
    if (!file) {
      store.updateSettings({ syncFile: '', syncError: '' });
      watchSyncFile();
      return state();
    }
    store.updateSettings({ syncFile: file, syncError: '', syncUpdatedAt: 0 });
    if (prefer === 'file') await readSyncFile(); // adopt the rules already there
    else scheduleSyncWrite(); // this Mac's rules become the shared ones
    watchSyncFile();
    return state();
  });
  ipcMain.handle('update:check', async () => { await checkForUpdates({ manual: true }); return state(); });
  ipcMain.handle('update:install', () => { installUpdate(); return state(); });
  ipcMain.handle('update:later', () => { setUpdate({ dismissed: true }); return state(); });
  ipcMain.handle('update:skip', () => {
    if (update.latest) store.updateSettings({ skippedVersion: update.latest.version });
    broadcast();
    return state();
  });
  ipcMain.handle('update:notes', () => { if (update.latest && /^https:\/\/github\.com\//.test(update.latest.url)) shell.openExternal(update.latest.url); });
  ipcMain.handle('whatsnew:seen', () => { store.updateSettings({ lastSeenVersion: APP_VERSION }); return state(); });

  // ----- watched folders -----
  const afterFolderChange = async () => { applyMode(); await rescan(); backfillLedger(); return state(); };
  ipcMain.handle('folders:add', async (_e, p) => {
    const error = folders.validateNewFolder(store.settings, p);
    if (error) return { error };
    store.updateSettings({ extraFolders: [...(store.settings.extraFolders || []), folders.newFolder(p)] });
    return { state: await afterFolderChange() };
  });
  ipcMain.handle('folders:update', async (_e, { id, patch }) => {
    const allowed = {};
    if ('enabled' in patch) allowed.enabled = !!patch.enabled;
    if (['self', 'primary'].includes(patch.sortInto)) allowed.sortInto = patch.sortInto;
    if (['inherit', 'auto', 'manual'].includes(patch.mode)) {
      allowed.mode = patch.mode;
      allowed.autoSince = Date.now(); // only files arriving from now on are auto-sorted
    }
    // Re-enabling counts as a fresh start for auto mode, so old files there aren't swept up.
    if (allowed.enabled) allowed.addedAt = Date.now();
    store.updateSettings({ extraFolders: (store.settings.extraFolders || []).map((f) => (f.id === id ? { ...f, ...allowed } : f)) });
    return afterFolderChange();
  });
  ipcMain.handle('folders:remove', async (_e, id) => {
    store.updateSettings({ extraFolders: (store.settings.extraFolders || []).filter((f) => f.id !== id) });
    return afterFolderChange();
  });
  ipcMain.handle('folders:suggest', async () => {
    const out = [];
    const desktop = app.getPath('desktop');
    if (!folders.validateNewFolder(store.settings, desktop)) out.push({ path: desktop, label: 'Desktop', why: 'Where screenshots land by default' });
    const shots = await new Promise((resolve) => require('child_process').execFile('/usr/bin/defaults', ['read', 'com.apple.screencapture', 'location'],
      { encoding: 'utf8' }, (err, stdout) => resolve(err ? null : stdout.trim())));
    const shotsPath = shots && path.resolve(shots.replace(/^~/, app.getPath('home')));
    if (shotsPath && shotsPath !== desktop && !folders.validateNewFolder(store.settings, shotsPath)) {
      out.push({ path: shotsPath, label: path.basename(shotsPath), why: 'Your screenshots folder' });
    }
    return out;
  });

  // ----- files -----
  ipcMain.handle('file:icon', (_e, p) => fileIcon(p));

  // ----- Find -----
  let findAllowed = new Set(); // paths shown in the latest Find results (the renderer may act on these)
  let findRun = 0;
  ipcMain.handle('find:run', async (_e, { text, query, remove, everywhere, includeCode } = {}) => {
    const run = ++findRun;
    let q = query || findParse.parse(text || '', {
      categories: store.settings.categories,
      folders: folders.watchedFolders(store.settings),
    });
    if (remove) q = findParse.withoutChip(q, remove);
    if (findParse.isEmpty(q)) return { query: q, results: [], notes: q.notes || [], empty: true };
    const res = await findSearch.search(q, { settings: store.settings, ledger, batches: store.history.batches, everywhere: !!everywhere, includeCode: !!includeCode });
    // Only the newest search decides what the page may act on: a slower, older one finishing later must not.
    if (run === findRun) findAllowed = new Set(res.results.map((r) => r.path));
    return { ...res, query: { ...q, chips: findParse.chipsFor(q) } };
  });
  ipcMain.handle('find:gather', async (_e, { paths, name }) => {
    const valid = (paths || []).filter((p) => findAllowed.has(p) && fs.existsSync(p));
    const safe = String(name || '').replace(/[/:\\]/g, '-').replace(/^\.+/, '').trim().slice(0, 60) || `Found ${new Date().toISOString().slice(0, 10)}`;
    const dest = path.join(store.settings.watchDir, GATHER_FOLDER, safe);
    const batch = await runMoves(valid.map((p) => ({ path: p, dest, categoryId: 'gathered', reason: 'Gathered from Find' })), 'gather');
    for (const m of batch.moves) { findAllowed.delete(m.from); findAllowed.add(m.to); }
    return { ...batch, dest };
  });
  ipcMain.handle('find:preview', (_e, p) => { if (findAllowed.has(p) && win && !win.isDestroyed()) win.previewFile(p); });
  ipcMain.on('find:drag', (e, p) => {
    const icon = dragIconFor(null);
    if (!findAllowed.has(p) || icon.isEmpty()) return;
    try { e.sender.startDrag({ file: p, icon }); } catch (err) { console.error('[find drag]', err.message); }
  });
  ipcMain.handle('find:toShelf', (_e, paths) => {
    const added = shelf.addFiles((paths || []).filter((p) => findAllowed.has(p)));
    if (added.length) { shelfChanged(); shelfWin.flash(); }
    return { added: added.length, enabled: shelfWin.wanted };
  });

  // ----- Shelf (only its own window may call these) -----
  const fromShelf = (fn) => (e, ...args) => (shelfWin.owns(e.sender) ? fn(...args) : null);
  const shelfFiles = (ids) => shelf.get(ids || []).filter((it) => it.kind === 'file' && fs.existsSync(it.path));
  ipcMain.handle('shelf:items', fromShelf(() => { shelf.prune(); shelfWin.setCount(shelf.list().length); return shelf.list(); }));
  ipcMain.handle('shelf:addFiles', fromShelf((paths) => { const n = shelf.addFiles(paths || []).length; if (n) shelfChanged(); return n; }));
  ipcMain.handle('shelf:addText', fromShelf((text) => { const n = shelf.addText(text).length; if (n) shelfChanged(); return n; }));
  ipcMain.handle('shelf:paste', fromShelf(async () => {
    const files = await pasteboard.readFiles();
    const n = files.length ? shelf.addFiles(files).length : shelf.addText(clipboard.readText()).length;
    if (n) shelfChanged();
    return n;
  }));
  ipcMain.handle('shelf:remove', fromShelf((ids) => { if (shelf.remove(ids || [])) shelfChanged(); }));
  ipcMain.handle('shelf:clear', fromShelf(() => { shelf.clear(); shelfChanged(); }));
  ipcMain.handle('shelf:copy', fromShelf(async (ids) => {
    const items = shelf.get(ids || []);
    const files = shelfFiles(ids);
    // The clipboard holds files or text, not both: files win, as they're what the Shelf is mostly for.
    if (files.length) return { count: (await pasteboard.copyFiles(files.map((it) => it.path))) ? files.length : 0, kind: 'files' };
    const texts = items.filter((it) => it.kind !== 'file').map((it) => it.text);
    if (!texts.length) return { count: 0 };
    clipboard.writeText(texts.join('\n\n'));
    return { count: texts.length, kind: 'text' };
  }));
  ipcMain.handle('shelf:open', fromShelf((id) => {
    const [it] = shelf.get([id]);
    if (!it) return;
    if (it.kind === 'file') { if (fs.existsSync(it.path)) shell.openPath(it.path); }
    else if (it.kind === 'link' && /^https?:/i.test(it.text)) shell.openExternal(it.text);
    else clipboard.writeText(it.text);
  }));
  ipcMain.handle('shelf:reveal', fromShelf((id) => { const [f] = shelfFiles([id]); if (f) shell.showItemInFolder(f.path); }));
  // Quick Look, as Space does in Finder. Text and links are shown through a temporary text file.
  let previewTurn = 0; // the latest preview asked for: quick ← → presses end on the last one
  ipcMain.handle('shelf:preview', fromShelf(async (id, switching) => {
    const turn = ++previewTurn;
    const [it] = shelf.get([id]);
    if (!it || !shelfWin.alive) return false;
    const p = it.kind === 'file' ? (fs.existsSync(it.path) ? it.path : null) : await shelfTextFile(it);
    if (!p) return false;
    if (switching) {
      // An open Quick Look doesn't reload when given a new file (it keeps showing the old one), so close it,
      // and wait out its closing animation: asked to open again during it, it stays closed.
      shelfWin.win.closeFilePreview();
      await new Promise((r) => setTimeout(r, QUICK_LOOK_CLOSE_MS));
      if (turn !== previewTurn || !shelfWin.alive) return false;
    }
    shelfWin.focus(); // Quick Look only appears for the focused window (a no-op when the Shelf already has the keys)
    shelfWin.win.previewFile(p, it.name); // the name, not the whole path, in Quick Look's title bar
    shelfWin.keepKeys();
    return true;
  }));
  ipcMain.handle('shelf:closePreview', fromShelf(() => { previewTurn++; if (shelfWin.alive) shelfWin.win.closeFilePreview(); }));
  ipcMain.handle('shelf:focus', fromShelf(() => shelfWin.focus()));
  ipcMain.handle('shelf:icon', fromShelf((id) => { const [f] = shelf.get([id]); return f && f.kind === 'file' ? fileIcon(f.path, 96, true) : null; }));
  ipcMain.on('shelf:setState', fromShelf((state) => { if (['closed', 'peek', 'open'].includes(state)) shelfWin.setState(state); }));
  ipcMain.on('shelf:drag', (e, ids) => {
    if (!shelfWin.owns(e.sender)) return;
    const files = shelfFiles(ids);
    const icon = dragIconFor(files[0] && files[0].path);
    if (!files.length || icon.isEmpty()) return;
    try { e.sender.startDrag({ file: files[0].path, files: files.map((it) => it.path), icon }); } catch (err) { console.error('[shelf drag]', err.message); }
  });

  const knownPath = (p) => {
    const r = path.resolve(p);
    return !!folders.folderFor(store.settings, r)
      || findAllowed.has(r)
      || store.history.batches.some((b) => b.moves.some((m) => m.to === r || m.from === r));
  };
  ipcMain.handle('file:reveal', (_e, p) => { if (fs.existsSync(p)) shell.showItemInFolder(p); });
  ipcMain.handle('file:open', (_e, p) => (knownPath(p) && fs.existsSync(p) ? shell.openPath(p) : 'Not allowed'));
  ipcMain.handle('file:openTrash', () => shell.openPath(path.join(app.getPath('home'), '.Trash')));

  ipcMain.handle('dialog:pickFolder', async (_e, defaultPath) => {
    const res = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || store.settings.watchDir,
    });
    return res.canceled ? null : res.filePaths[0];
  });
}

// ---------- screenshots (dev aid: INLET_SCREENSHOTS=/some/dir npm start) ----------

async function captureScreenshots(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.setSize(1180, 780);
  win.showInactive();
  await wait(1500);
  for (const page of ['overview', 'organize', 'cleanup', 'rules', 'activity', 'settings']) {
    win.webContents.send('navigate', page);
    await wait(2000);
    await win.webContents.capturePage(); // the first capture can return the previous frame
    await wait(400);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${page}.png`), img.toPNG());
  }
  quitting = true;
  app.quit();
}

// ---------- lifecycle ----------

app.on('second-instance', () => showWindow());

app.whenReady().then(async () => {
  store = new Store(DATA_DIR);
  shelf = new Shelf(DATA_DIR);
  ledger = new Ledger(DATA_DIR);
  ledger.prune(store.settings.ledgerKeepDays);
  if (env('WATCH_DIR')) store.updateSettings({ watchDir: env('WATCH_DIR') });
  // Removed files from the Tidy days live in ".Tidy Removed"; move them (and their undo history) across.
  if (cleanup.migrateLegacyHolding(folders.eachFolderSettings(store.settings), store.history.batches)) store.save('history');


  registerIpc();
  buildMenu();
  createWindow();
  if (env('SCREENSHOTS')) {
    win.webContents.on('console-message', (e) => console.log('[renderer]', e.message || e));
    win.webContents.once('did-finish-load', () => captureScreenshots(env('SCREENSHOTS')));
  }
  tray = new TrayController({
    getSettings: () => store.settings,
    getUnsorted: () => lastScan.items.length,
    getUndoable: undoSummary,
    setMode: async (mode) => {
      store.updateSettings(mode === 'auto' ? { mode, autoSince: Date.now() } : { mode });
      applyMode();
      broadcast();
    },
    tidyNow: async () => {
      const batch = await tidyAll('manual');
      notifyMoves(batch.moves, 'Tidied Downloads');
    },
    undoLast: async () => {
      const res = await undoLast();
      if (res.restored.length && Notification.isSupported()) {
        new Notification({ title: 'Undone', body: `Put ${res.restored.length} file${res.restored.length === 1 ? '' : 's'} back`, silent: true }).show();
      }
    },
    show: showWindow,
    shelf: () => ({ on: shelfWin.wanted, count: shelf.list().length, shortcut: shelfShortcutOk ? SHELF_SHORTCUT : undefined }),
    showShelf,
    getUpdate: publicUpdate,
    showUpdate,
    quit: () => { quitting = true; app.quit(); },
  });

  // Upgrading from a version before release notes existed: show what's new since 1.0.
  if (store.settings.onboarded && !store.settings.lastSeenVersion) store.updateSettings({ lastSeenVersion: '1.0.0' });
  applyMode();
  applySystemSettings();
  applyShelf();
  await rescan();
  await purgeExpired();
  setTimeout(() => { backfillArmed = true; backfillLedger(); }, 3000); // after the window is up; runs in the background
  setInterval(() => { ledger.prune(store.settings.ledgerKeepDays); backfillLedger(); }, 6 * 60 * 60 * 1000);
  watchSyncFile();
  await readSyncFile();
  setInterval(rescan, 5 * 60 * 1000);
  setInterval(tickSchedule, 30 * 1000);
  setInterval(purgeExpired, 60 * 60 * 1000);
  tickSchedule();
  if (!env('SCREENSHOTS')) {
    setTimeout(() => checkForUpdates(), 10 * 1000); // after startup settles
    setInterval(() => checkForUpdates(), UPDATE_EVERY_MS);
  }
});

app.on('activate', () => showWindow());
app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  shelfWin.disable();
  fs.rmSync(SHELF_TEXT_DIR, { recursive: true, force: true });
  if (update.status !== 'installing') fs.rmSync(UPDATE_DIR, { recursive: true, force: true }); // the installer may still need it
  if (store) store.flush();
  stopWatchers();
  if (syncWatched) fs.unwatchFile(syncWatched);
});
app.on('window-all-closed', () => { /* stay alive in the menu bar */ });
