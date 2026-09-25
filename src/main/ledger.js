'use strict';

// The provenance ledger: Inlet's own memory of where files came from.
//
// macOS forgets a lot: "where from" is lost when a file is unzipped, AirDropped or saved by
// another app, and the system download log no longer keeps URLs. So Inlet writes down what it
// can see the moment a file lands, and keeps it:
//   - files are keyed by inode + size, which survive renames and moves on the same disk
//   - files unzipped from an archive share its quarantine id, so they inherit its source
// Stored as JSON Lines (one full record per line, last one wins) so writes are cheap appends.
// Stays on this Mac: never exported with rules or synced.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'ledger.jsonl';

class Ledger {
  constructor(dir) {
    this.file = path.join(dir, FILE);
    this.entries = new Map(); // id → entry
    this.byKey = new Map(); // `${ino}:${size}` → id
    this.byQid = new Map(); // quarantine id → Set of ids
    this.lines = 0;
    this.load();
  }

  static key(ino, size) { return `${ino}:${size}`; }

  load() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      this.lines++;
      try {
        const e = JSON.parse(line);
        if (e.deleted) this.drop(e.id); else this.index(e);
      } catch { /* skip a torn line */ }
    }
    if (this.lines > this.entries.size * 2 + 200) this.compact();
  }

  index(e) {
    const old = this.entries.get(e.id);
    if (old) {
      this.byKey.delete(Ledger.key(old.ino, old.size));
      if (old.qid) this.byQid.get(old.qid)?.delete(old.id);
    }
    this.entries.set(e.id, e);
    this.byKey.set(Ledger.key(e.ino, e.size), e.id);
    if (e.qid) {
      if (!this.byQid.has(e.qid)) this.byQid.set(e.qid, new Set());
      this.byQid.get(e.qid).add(e.id);
    }
  }

  drop(id) {
    const e = this.entries.get(id);
    if (!e) return;
    this.byKey.delete(Ledger.key(e.ino, e.size));
    if (e.qid) this.byQid.get(e.qid)?.delete(id);
    this.entries.delete(id);
  }

  write(e) {
    this.index(e);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(e)}\n`);
      this.lines++;
    } catch { /* disk full / permissions: keep the in-memory copy */ }
  }

  /** Rewrite the file with only current records. */
  compact() {
    const tmp = `${this.file}.tmp`;
    try {
      fs.writeFileSync(tmp, [...this.entries.values()].map((e) => JSON.stringify(e)).join('\n') + (this.entries.size ? '\n' : ''));
      fs.renameSync(tmp, this.file);
      this.lines = this.entries.size;
    } catch { /* try again next time */ }
  }

  get(ino, size) {
    const id = this.byKey.get(Ledger.key(ino, size));
    return id ? this.entries.get(id) : null;
  }

  has(file) { return !!(file.ino && this.byKey.has(Ledger.key(file.ino, file.size))); }

  /** The archive-or-sibling in the same quarantine family that knows a source, if any. */
  familySource(qid, exceptId) {
    for (const id of this.byQid.get(qid) || []) {
      const e = this.entries.get(id);
      if (e && id !== exceptId && e.urls.length && !e.inheritedFrom) return e;
    }
    return null;
  }

  /**
   * Remember a file and what macOS knows about its origin.
   * file: { path, name, ino, size, isDir, addedMs }   prov: result of provenance.readMany (or null)
   * Returns the entry. Existing entries only get their path/name refreshed (the first sighting wins).
   */
  record(file, prov, now = Date.now()) {
    if (!file.ino) return null;
    const existing = this.get(file.ino, file.size);
    if (existing) {
      if (existing.path !== file.path) this.write({ ...existing, path: file.path, name: path.basename(file.path), seenAt: now });
      return this.get(file.ino, file.size);
    }
    const e = {
      id: crypto.randomUUID(),
      path: file.path,
      name: file.name || path.basename(file.path),
      ino: file.ino,
      size: file.size,
      isDir: !!file.isDir,
      urls: prov?.urls || [],
      host: prov?.host || '',
      fileHost: prov?.fileHost || '',
      app: prov?.app || '',
      downloadedAt: prov?.downloadedAt || 0,
      qid: prov?.qid || '',
      addedAt: file.addedMs || 0,
      recordedAt: now,
      seenAt: now,
    };
    if (!e.urls.length && e.qid) {
      const src = this.familySource(e.qid);
      if (src) Object.assign(e, inheritFrom(src));
    }
    this.write(e);
    // An archive recorded after its unzipped files: pass its source down to them.
    if (e.urls.length && e.qid && !e.inheritedFrom) {
      for (const id of this.byQid.get(e.qid) || []) {
        const sib = this.entries.get(id);
        if (sib && id !== e.id && !sib.urls.length) {
          this.write({ ...sib, ...inheritFrom(e) });
        }
      }
    }
    return this.get(file.ino, file.size);
  }

  /**
   * Inlet moved or renamed a file: keep the path current. `newIno` is the inode at the new path, which
   * differs from the old one when the move crossed disks (a copy, then delete).
   */
  moved(ino, size, newPath, newIno = ino) {
    const e = this.get(ino, size);
    if (e && (e.path !== newPath || e.ino !== newIno)) this.write({ ...e, ino: newIno, path: newPath, name: path.basename(newPath), seenAt: Date.now() });
  }

  /**
   * Forget records Inlet made more than `days` ago (0 = keep forever). Counted from when Inlet recorded the
   * file, not when it was downloaded: an old download recorded today is exactly what the ledger is for.
   */
  prune(days, now = Date.now()) {
    if (!days) return 0;
    const cutoff = now - days * 86400000;
    let n = 0;
    for (const e of [...this.entries.values()]) {
      if (e.recordedAt < cutoff) { this.drop(e.id); n++; }
    }
    if (n) this.compact();
    return n;
  }

  clear() {
    this.entries.clear(); this.byKey.clear(); this.byQid.clear();
    this.compact();
  }

  stats() {
    let withSource = 0; let withApp = 0; let inherited = 0; let since = 0;
    for (const e of this.entries.values()) {
      if (e.urls.length) withSource++;
      if (e.app) withApp++;
      if (e.inheritedFrom) inherited++;
      if (!since || e.recordedAt < since) since = e.recordedAt;
    }
    return { files: this.entries.size, withSource, withApp, inherited, since };
  }

  /** A readable copy for export. */
  toJSON() {
    return [...this.entries.values()].map(({ id, ino, ...rest }) => rest);
  }
}

/**
 * Fields an unzipped file takes from its archive. The download app and time are the archive's too:
 * the child's own quarantine tag names Archive Utility, which unzipped it, not where it came from.
 */
function inheritFrom(src) {
  return {
    urls: src.urls, host: src.host, fileHost: src.fileHost,
    app: src.app, downloadedAt: src.downloadedAt,
    inheritedFrom: { id: src.id, name: src.name },
  };
}

/** What the interface shows about a file's origin. */
function summary(e) {
  if (!e) return null;
  return {
    host: e.host || '',
    app: e.app || '',
    downloadedAt: e.downloadedAt || 0,
    url: e.urls[0] || '',
    page: e.urls[1] || '',
    inheritedFrom: e.inheritedFrom ? e.inheritedFrom.name : '',
  };
}

module.exports = { Ledger, summary };
