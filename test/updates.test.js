'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { newer, whatsNewFrom, parseRelease, fetchLatest, download } = require('../src/main/updates');

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

const NOTES = `## Download

**Inlet-1.9.0.pkg**: one installer.

## What's new in 1.9.0

### Updates

![Shot](https://example.com/a.png)

- **Inlet tells you** when there's a new version.
- See the [release notes](https://github.com/x) or \`changelog.js\`.

Everything stays on your Mac.

## Something else

- not this
`;

const RELEASE = {
  tag_name: 'v1.9.0', name: 'Inlet 1.9.0', html_url: 'https://github.com/o/r/releases/tag/v1.9.0',
  draft: false, prerelease: false, published_at: '2026-10-01T10:00:00Z', body: NOTES,
  assets: [
    { name: 'notes.txt', size: 3, browser_download_url: 'x', digest: null },
    { name: 'Inlet-1.9.0.pkg', size: 5, browser_download_url: 'https://github.com/o/r/releases/download/v1.9.0/Inlet-1.9.0.pkg', digest: `sha256:${'a'.repeat(64)}` },
  ],
};

test('compares versions', () => {
  assert.equal(newer('1.9.0', '1.8.0'), true);
  assert.equal(newer('1.10.0', '1.9.2'), true, 'numbers, not text');
  assert.equal(newer('v2.0.0', '1.99.99'), true);
  assert.equal(newer('1.8.0', '1.8.0'), false);
  assert.equal(newer('1.7.9', '1.8.0'), false);
});

test('reads a GitHub release', () => {
  const r = parseRelease(RELEASE);
  assert.equal(r.version, '1.9.0');
  assert.equal(r.asset.name, 'Inlet-1.9.0.pkg');
  assert.equal(r.asset.sha256, 'a'.repeat(64));
  assert.deepEqual(r.notes, ['Inlet tells you when there\'s a new version.', 'See the release notes or changelog.js.']);
  assert.equal(parseRelease({ ...RELEASE, draft: true }), null);
  assert.equal(parseRelease({ ...RELEASE, prerelease: true }), null);
  assert.equal(parseRelease({ ...RELEASE, assets: [] }).asset, null, 'a release without an installer can still be announced');
  assert.equal(parseRelease({ ...RELEASE, assets: [{ ...RELEASE.assets[1], digest: 'md5:zz' }] }).asset.sha256, null);
  assert.deepEqual(whatsNewFrom('no heading here\n- a'), []);
});

/** A tiny local server standing in for GitHub. */
function serve(routes) {
  const server = http.createServer((req, res) => {
    const r = routes[req.url];
    if (!r) { res.writeHead(404); return res.end(); }
    res.writeHead(r.status || 200, { 'content-type': r.type || 'application/octet-stream', 'content-length': Buffer.byteLength(r.body) });
    res.end(r.body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

test('asks GitHub and downloads a checked installer', async () => {
  const payload = Buffer.from('pretend installer '.repeat(5000));
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const { server, base } = await serve({
    '/latest': { body: JSON.stringify({ ...RELEASE, assets: [{ name: 'Inlet-1.9.0.pkg', size: payload.length, browser_download_url: 'unused', digest: `sha256:${sha}` }] }), type: 'application/json' },
    '/good.pkg': { body: payload },
    '/missing': { status: 404, body: '' },
  });
  try {
    const latest = await fetchLatest({ url: `${base}/latest` });
    assert.equal(latest.version, '1.9.0');
    await assert.rejects(fetchLatest({ url: `${base}/missing` }), /404/);

    const dir = tmp('inlet-update-');
    const seen = [];
    const file = await download({ ...latest.asset, url: `${base}/good.pkg` }, dir, { onProgress: (p) => seen.push(p) });
    assert.equal(path.basename(file), 'Inlet-1.9.0.pkg');
    assert.deepEqual(fs.readFileSync(file), payload);
    assert.equal(seen.at(-1), 1);
    assert.ok(seen.every((p, i) => i === 0 || p >= seen[i - 1]), 'progress only goes up');

    // Tampered: right size, wrong contents. It's refused and nothing is left behind.
    const bad = Buffer.from(payload); bad[10] ^= 1;
    const { server: s2, base: b2 } = await serve({ '/bad.pkg': { body: bad }, '/short.pkg': { body: payload.subarray(0, 100) } });
    const dir2 = tmp('inlet-update-');
    await assert.rejects(download({ ...latest.asset, url: `${b2}/bad.pkg` }, dir2), /doesn't match/);
    await assert.rejects(download({ ...latest.asset, url: `${b2}/short.pkg` }, dir2), /incomplete/);
    assert.deepEqual(fs.readdirSync(dir2), [], 'a bad download is deleted');
    s2.close();
  } finally {
    server.close();
  }
});
