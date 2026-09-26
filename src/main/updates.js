'use strict';

// Updates: ask GitHub Releases whether there's a newer Inlet, and fetch its installer.
// This is the only network request Inlet makes. It sends nothing about you or your files, and it can
// be turned off in Settings. Inlet isn't signed, so macOS's own auto-updaters can't be used: the new
// .pkg is downloaded, checked against GitHub's SHA-256 digest, and opened in macOS Installer.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = 'Tech-Reign-Era-Services/inlet';
const LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;

const semver = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
/** Is version a newer than b? ("1.10.0" > "1.9.2", "v2.0.0" > "1.9.9") */
function newer(a, b) {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

/** The bullet points under the release notes' "What's new" heading, as plain text. */
function whatsNewFrom(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s+What.s new/i.test(l));
  if (start < 0) return [];
  const out = [];
  for (const l of lines.slice(start + 1)) {
    if (/^##\s/.test(l)) break; // the next top-level section
    const m = l.match(/^\s*[-*]\s+(.*)$/);
    if (m) out.push(plain(m[1]));
  }
  return out.slice(0, 12);
}
const plain = (s) => s
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
  .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .trim();

/** Turn GitHub's release JSON into what Inlet needs, or null if it isn't a usable release. */
function parseRelease(json) {
  if (!json || json.draft || json.prerelease || !json.tag_name) return null;
  const pkg = (json.assets || []).find((a) => /\.pkg$/i.test(a.name));
  const digest = pkg && /^sha256:([0-9a-f]{64})$/i.exec(pkg.digest || '');
  return {
    version: String(json.tag_name).replace(/^v/, ''),
    name: json.name || `Inlet ${json.tag_name}`,
    url: json.html_url || `https://github.com/${REPO}/releases`,
    publishedAt: Date.parse(json.published_at) || 0,
    notes: whatsNewFrom(json.body),
    asset: pkg ? { name: pkg.name, url: pkg.browser_download_url, size: pkg.size, sha256: digest ? digest[1].toLowerCase() : null } : null,
  };
}

/** Ask GitHub for the latest release. Resolves to parseRelease's result; rejects on network errors. */
async function fetchLatest({ fetch = globalThis.fetch, url = LATEST_URL, userAgent = 'Inlet' } = {}) {
  const res = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': userAgent },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  return parseRelease(await res.json());
}

/**
 * Download the installer into dir, reporting progress (0–1), and check its size and SHA-256.
 * Resolves to the file's path. A file that doesn't match is deleted, never opened.
 */
async function download(asset, dir, { fetch = globalThis.fetch, onProgress = () => {}, signal } = {}) {
  if (!asset || !asset.url) throw new Error('This release has no installer');
  await fs.promises.mkdir(dir, { recursive: true });
  const safe = path.basename(asset.name).replace(/[^\w.-]/g, '_');
  const file = path.join(dir, safe);
  const part = `${file}.part`;
  const res = await fetch(asset.url, { headers: { 'User-Agent': 'Inlet' }, signal });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(part);
  let got = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total) onProgress(Math.min(1, got / total));
    }
    await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  } catch (err) {
    out.destroy();
    await fs.promises.rm(part, { force: true });
    throw err;
  }
  const sha = hash.digest('hex');
  const bad = (asset.size && got !== asset.size) ? 'is incomplete' : (asset.sha256 && sha !== asset.sha256) ? "doesn't match the release" : null;
  if (bad) {
    await fs.promises.rm(part, { force: true });
    throw new Error(`The download ${bad}. Nothing was installed.`);
  }
  await fs.promises.rename(part, file);
  return file;
}

module.exports = { newer, whatsNewFrom, parseRelease, fetchLatest, download, LATEST_URL, REPO };
