'use strict';

// Reads where a file was downloaded from. macOS stores this in the
// com.apple.metadata:kMDItemWhereFroms extended attribute as a binary plist.
const { execFile, spawn } = require('child_process');

function run(cmd, args, input) {
  return new Promise((resolve) => {
    if (input === undefined) {
      execFile(cmd, args, { encoding: 'utf8', timeout: 3000 }, (err, stdout) => resolve(err ? null : stdout));
      return;
    }
    const child = spawn(cmd, args);
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
    child.stdin.end(input);
  });
}

async function getSources(filePath) {
  if (process.platform !== 'darwin') return [];
  const hex = await run('xattr', ['-px', 'com.apple.metadata:kMDItemWhereFroms', filePath]);
  if (!hex) return [];
  const bytes = Buffer.from(hex.replace(/\s+/g, ''), 'hex');
  const json = await run('plutil', ['-convert', 'json', '-o', '-', '-'], bytes);
  if (!json) return [];
  try {
    const list = JSON.parse(json);
    return Array.isArray(list) ? list.filter((s) => typeof s === 'string' && s) : [];
  } catch {
    return [];
  }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

module.exports = { getSources, hostOf };
