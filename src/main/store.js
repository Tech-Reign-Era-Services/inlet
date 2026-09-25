'use strict';

// Settings and activity history, persisted as JSON in the app's data folder.
const fs = require('fs');
const path = require('path');
const { defaultSettings, OTHER_CATEGORY } = require('./defaults');

const MAX_BATCHES = 1000;
const AUTO_MERGE_MS = 15 * 1000; // auto moves this close together share one history batch

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.settingsPath = path.join(dir, 'settings.json');
    this.historyPath = path.join(dir, 'history.json');
    this.learningPath = path.join(dir, 'learning.json');
    this.settings = this.loadSettings();
    this.history = readJson(this.historyPath, { batches: [] });
    // Manual corrections from Organize, used to suggest rules (see suggest.js).
    this.learning = { events: [], dismissed: [], ...readJson(this.learningPath, {}) };
    this.timers = {};
  }

  loadSettings() {
    const defaults = defaultSettings();
    const saved = readJson(this.settingsPath, null);
    if (!saved) return defaults;
    const merged = { ...defaults, ...saved };
    if (!Array.isArray(merged.categories) || !merged.categories.length) merged.categories = defaults.categories;
    if (!merged.categories.some((c) => c.id === 'other')) merged.categories.push({ ...OTHER_CATEGORY });
    if (!Array.isArray(merged.rules)) merged.rules = defaults.rules;
    merged.schedule = { ...defaults.schedule, ...(saved.schedule || {}) };
    // People who set Inlet up before the tour existed don't need it forced on them (Help → Take the Tour).
    if (saved.onboarded && !('tourDone' in saved)) merged.tourDone = true;
    return merged;
  }

  updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    this.save('settings');
    return this.settings;
  }

  resetSettings() {
    // Reset rules and preferences, not your setup: folders, sync and onboarding stay.
    const { watchDir, extraFolders, syncFile, lastSeenVersion } = this.settings;
    const keep = { watchDir, extraFolders, syncFile, lastSeenVersion, onboarded: true, tourDone: true };
    this.settings = { ...defaultSettings(), ...keep };
    this.save('settings');
    return this.settings;
  }

  addBatch(batch) {
    if (!batch.moves.length) return null;
    const last = this.history.batches[0];
    if (batch.trigger === 'auto' && last && last.trigger === 'auto' && batch.time - last.time < AUTO_MERGE_MS) {
      last.moves.push(...batch.moves);
      last.time = batch.time;
      this.save('history');
      return last;
    }
    this.history.batches.unshift(batch);
    this.history.batches.length = Math.min(this.history.batches.length, MAX_BATCHES);
    this.save('history');
    return batch;
  }

  findBatch(id) { return this.history.batches.find((b) => b.id === id); }

  /** Most recent batch that still has something to undo. */
  lastUndoable() {
    return this.history.batches.find((b) => b.moves.some((m) => !m.undone && !m.purged && !m.userMoved)) || null;
  }

  clearHistory() {
    this.history = { batches: [] };
    this.save('history');
  }

  stats() {
    const weekAgo = Date.now() - 7 * 86400000;
    let total = 0; let bytes = 0; let week = 0; let removed = 0; let removedBytes = 0;
    const byCategory = {};
    for (const b of this.history.batches) {
      for (const m of b.moves) {
        if (m.undone) continue;
        if (m.kind === 'remove') { removed++; removedBytes += m.size || 0; continue; }
        total++; bytes += m.size || 0;
        if (b.time >= weekAgo) week++;
        byCategory[m.categoryId] = (byCategory[m.categoryId] || 0) + 1;
      }
    }
    return { total, bytes, week, byCategory, removed, removedBytes };
  }

  /** Debounced atomic write. */
  save(which) {
    clearTimeout(this.timers[which]);
    this.timers[which] = setTimeout(() => this.flush(which), 250);
  }

  flush(which) {
    const files = {
      settings: [this.settingsPath, this.settings],
      history: [this.historyPath, this.history],
      learning: [this.learningPath, this.learning],
    };
    for (const t of which ? [which] : Object.keys(files)) {
      clearTimeout(this.timers[t]);
      const [file, data] = files[t];
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, file);
    }
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

module.exports = { Store };
