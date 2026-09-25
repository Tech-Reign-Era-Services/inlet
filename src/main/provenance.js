'use strict';

// Reads where files came from, as macOS recorded it, for many files at once:
//  - com.apple.metadata:kMDItemWhereFroms → [download URL, page URL] (binary plist)
//  - com.apple.quarantine                → "flags;hex-time;app;event-id"
// Unzipped files inherit the archive's quarantine event id, which is how the ledger links them
// back to the archive's source. Always call Apple's tools by full path: a Python "xattr" package
// can shadow /usr/bin/xattr on PATH and doesn't support -x.
const { execFile } = require('child_process');

const XATTR = '/usr/bin/xattr';
const WHERE_FROMS = 'com.apple.metadata:kMDItemWhereFroms';
const QUARANTINE = 'com.apple.quarantine';
const BATCH = 100;

// Download agents as people know them.
const APP_NAMES = {
  sharingd: 'AirDrop',
  'com.apple.Safari.SandboxBroker.xpc': 'Safari',
  'com.apple.Safari': 'Safari',
  'Google Chrome': 'Chrome',
  'Google Chrome Helper': 'Chrome',
  MSTeams: 'Microsoft Teams',
  'Microsoft Teams': 'Microsoft Teams',
  'Brave Browser': 'Brave',
  'Microsoft Edge': 'Edge',
  firefox: 'Firefox',
  Mail: 'Mail',
  'com.apple.mail': 'Mail',
  Messages: 'Messages',
  'com.apple.MobileSMS': 'Messages',
};
const appLabel = (agent) => (agent ? APP_NAMES[agent] || agent : '');

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/** Run /usr/bin/xattr -p on many files; returns Map path → raw text value (missing attrs are skipped). */
function xattrBatch(args, paths) {
  return new Promise((resolve) => {
    execFile(XATTR, [...args, ...paths], { encoding: 'utf8', timeout: 60000, maxBuffer: 256 * 1024 * 1024 }, (_err, stdout) => {
      const out = new Map();
      if (!stdout) return resolve(out);
      if (paths.length === 1) { out.set(paths[0], stdout.trim()); return resolve(out); }
      // Several files: "path: value", or "path:" followed by hex-dump lines. Hex lines have no ':',
      // so only lines with one are checked against the known paths (a name may itself contain ': ').
      const known = new Set(paths);
      const parts = new Map();
      let current = null;
      for (const line of stdout.split('\n')) {
        let head = null;
        for (let i = line.indexOf(':'); i !== -1; i = line.indexOf(':', i + 1)) {
          if ((i === line.length - 1 || line[i + 1] === ' ') && known.has(line.slice(0, i))) { head = i; break; }
        }
        if (head !== null) {
          current = line.slice(0, head);
          parts.set(current, [line.slice(head + 1).trim()]);
        } else if (current) {
          parts.get(current).push(line.trim());
        }
      }
      for (const [p, chunks] of parts) out.set(p, chunks.join(' ').trim());
      resolve(out);
    });
  });
}

/**
 * Strings from a binary plist (kMDItemWhereFroms is an array of strings).
 * Handles ASCII and UTF-16 strings inside an array; returns [] for anything else.
 */
function parseBplistStrings(buf) {
  try {
    if (buf.length < 40 || buf.toString('ascii', 0, 8) !== 'bplist00') return [];
    const trailer = buf.subarray(buf.length - 32);
    const offsetSize = trailer[6];
    const refSize = trailer[7];
    const numObjects = Number(trailer.readBigUInt64BE(8));
    const top = Number(trailer.readBigUInt64BE(16));
    const tableOffset = Number(trailer.readBigUInt64BE(24));
    const readInt = (pos, size) => { let v = 0; for (let i = 0; i < size; i++) v = v * 256 + buf[pos + i]; return v; };
    const offsetOf = (ref) => readInt(tableOffset + ref * offsetSize, offsetSize);
    const lengthAt = (pos) => {
      const low = buf[pos] & 0x0f;
      if (low !== 0x0f) return [low, pos + 1];
      const intSize = 1 << (buf[pos + 1] & 0x0f);
      return [readInt(pos + 2, intSize), pos + 2 + intSize];
    };
    const stringAt = (ref) => {
      if (ref >= numObjects) return null;
      const pos = offsetOf(ref);
      const kind = buf[pos] >> 4;
      const [len, start] = lengthAt(pos);
      if (kind === 0x5) return buf.toString('latin1', start, start + len);
      if (kind === 0x6) {
        const chars = [];
        for (let i = 0; i < len; i++) chars.push(buf.readUInt16BE(start + i * 2));
        return String.fromCharCode(...chars);
      }
      return null;
    };
    const topPos = offsetOf(top);
    if (buf[topPos] >> 4 !== 0xa) { const s = stringAt(top); return s ? [s] : []; }
    const [count, start] = lengthAt(topPos);
    const out = [];
    for (let i = 0; i < count; i++) {
      const s = stringAt(readInt(start + i * refSize, refSize));
      if (s) out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

function parseQuarantine(value) {
  if (!value) return null;
  const [flags, hexTime, agent, id] = value.split(';');
  const secs = parseInt(hexTime, 16);
  return {
    app: appLabel(agent || ''),
    downloadedAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : 0,
    qid: id || '',
    flags: flags || '',
  };
}

/**
 * Provenance for many paths: Map path → { urls, host, fileHost, app, downloadedAt, qid }.
 * Files with nothing recorded are left out.
 */
async function readMany(paths) {
  const out = new Map();
  for (let i = 0; i < paths.length; i += BATCH) {
    const chunk = paths.slice(i, i + BATCH);
    const [quarantine, wheres] = await Promise.all([
      xattrBatch(['-p', QUARANTINE], chunk),
      xattrBatch(['-px', WHERE_FROMS], chunk),
    ]);
    for (const p of chunk) {
      const q = parseQuarantine(quarantine.get(p));
      const hex = wheres.get(p);
      // Keep real web addresses only: some apps store whole data:/blob: URLs (megabytes) that name no website.
      const urls = hex
        ? parseBplistStrings(Buffer.from(hex.replace(/[^0-9a-f]/gi, ''), 'hex')).filter((u) => /^(https?|ftp):/i.test(u)).map((u) => u.slice(0, 2048))
        : [];
      if (!q && !urls.length) continue;
      const fileHost = hostOf(urls[0] || '');
      out.set(p, {
        urls,
        fileHost,
        host: hostOf(urls[1] || '') || fileHost, // the page is more meaningful than a CDN link
        app: q ? q.app : '',
        downloadedAt: q ? q.downloadedAt : 0,
        qid: q ? q.qid : '',
      });
    }
  }
  return out;
}

const readOne = async (p) => (await readMany([p])).get(p) || null;

module.exports = { readMany, readOne, parseBplistStrings, parseQuarantine, appLabel, hostOf };
