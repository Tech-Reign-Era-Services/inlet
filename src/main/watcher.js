'use strict';

// Auto mode: watch the folder, wait for each new file to finish downloading, then hand it off.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { quickSkip, reservedNames } = require('./classifier');

const STABLE_CHECK_MS = 1500;
const MAX_WAIT_MS = 6 * 60 * 60 * 1000; // give up on a file that keeps changing for 6h
const SWEEP_MS = 5 * 60 * 1000;

class Watcher {
  /**
   * getSettings: () => settings
   * onReady: (fullPath) => Promise — called once a file is complete and should be sorted
   */
  constructor({ getSettings, onReady, onError }) {
    this.getSettings = getSettings;
    this.onReady = onReady;
    this.onError = onError || (() => {});
    this.fsWatcher = null;
    this.sweepTimer = null;
    this.pending = new Map(); // name → { timer, firstSeen, lastSize, lastMtime }
    this.suppressed = new Map(); // fullPath → expiry ms (files just restored by undo)
    this.dir = null;
  }

  get running() { return !!this.fsWatcher; }

  start() {
    this.stop();
    const settings = this.getSettings();
    this.dir = settings.watchDir;
    try {
      this.fsWatcher = fs.watch(this.dir, { persistent: true }, (_event, filename) => {
        if (filename) this.schedule(String(filename));
      });
      this.fsWatcher.on('error', (err) => { this.onError(err); this.stop(); });
    } catch (err) {
      this.fsWatcher = null;
      this.onError(err);
      return false;
    }
    this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
    this.sweep();
    return true;
  }

  stop() {
    if (this.fsWatcher) this.fsWatcher.close();
    this.fsWatcher = null;
    clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const p of this.pending.values()) clearTimeout(p.timer);
    this.pending.clear();
  }

  /** Don't re-sort these paths (e.g. after the user undid a move) until they change again. */
  suppress(paths, ms = 10 * 60 * 1000) {
    const until = Date.now() + ms;
    for (const p of paths) this.suppressed.set(p, until);
  }

  isSuppressed(fullPath) {
    const until = this.suppressed.get(fullPath);
    if (!until) return false;
    if (Date.now() > until) { this.suppressed.delete(fullPath); return false; }
    return true;
  }

  /** Catch files that arrived while Inlet wasn't running or that fs.watch missed — only ones added after auto mode was turned on. */
  async sweep() {
    const settings = this.getSettings();
    const since = settings.autoSince || Date.now();
    let names;
    try { names = await fsp.readdir(this.dir); } catch { return; }
    for (const name of names) {
      if (this.pending.has(name) || quickSkip(name, settings)) continue;
      try {
        const st = await fsp.lstat(path.join(this.dir, name));
        if ((st.birthtimeMs || st.mtimeMs) >= since) this.schedule(name);
      } catch { /* gone */ }
    }
  }

  schedule(name) {
    const settings = this.getSettings();
    if (name.includes('/') || quickSkip(name, settings, reservedNames(settings))) return;
    const existing = this.pending.get(name);
    if (existing) clearTimeout(existing.timer);
    const entry = existing || { firstSeen: Date.now(), lastSize: -1, lastMtime: -1 };
    entry.timer = setTimeout(() => this.check(name), Math.max(1, settings.autoDelaySec) * 1000);
    this.pending.set(name, entry);
  }

  async check(name) {
    const entry = this.pending.get(name);
    if (!entry) return;
    const fullPath = path.join(this.dir, name);
    let st;
    try { st = await fsp.lstat(fullPath); } catch { this.pending.delete(name); return; } // renamed/removed (e.g. .crdownload → final)
    if (this.isSuppressed(fullPath)) { this.pending.delete(name); return; }

    const size = st.isDirectory() ? await dirSize(fullPath) : st.size;
    const quiet = Date.now() - st.mtimeMs > STABLE_CHECK_MS;
    const stable = size === entry.lastSize && st.mtimeMs === entry.lastMtime && quiet;
    entry.lastSize = size;
    entry.lastMtime = st.mtimeMs;

    if (!stable) {
      if (Date.now() - entry.firstSeen > MAX_WAIT_MS) { this.pending.delete(name); return; }
      entry.timer = setTimeout(() => this.check(name), STABLE_CHECK_MS);
      return;
    }
    this.pending.delete(name);
    try { await this.onReady(fullPath); } catch (err) { this.onError(err); }
  }
}

async function dirSize(dir) {
  let total = 0;
  try {
    for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) total += await dirSize(p);
      else { try { total += (await fsp.lstat(p)).size; } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  return total;
}

module.exports = { Watcher };
