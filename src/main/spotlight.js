'use strict';

// Spotlight metadata helpers (macOS). All of these degrade to "unknown" elsewhere.
const { execFile } = require('child_process');
const path = require('path');

const isMac = process.platform === 'darwin';

/** One mdls attribute for many files. Returns raw strings (or null) in the same order as paths. */
function mdlsBatch(attr, paths) {
  if (!isMac || !paths.length) return Promise.resolve(paths.map(() => null));
  const chunks = [];
  for (let i = 0; i < paths.length; i += 200) chunks.push(paths.slice(i, i + 200));
  return Promise.all(chunks.map((chunk) => new Promise((resolve) => {
    execFile('mdls', ['-name', attr, '-raw', '-nullMarker', '(null)', ...chunk],
      { encoding: 'utf8', timeout: 20000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve(chunk.map(() => null));
        const values = stdout.split('\0');
        resolve(chunk.map((_, i) => (values[i] && !values[i].startsWith('(null)') ? values[i] : null)));
      });
  }))).then((parts) => parts.flat());
}

/** Finder "Kind" for each path, e.g. "PDF document", "PNG image". */
const kinds = (paths) => mdlsBatch('kMDItemKind', paths);

// ---------- text content ----------

// Formats Spotlight's importers can read text from.
const TEXT_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'rtf', 'rtfd', 'doc', 'docx', 'pages', 'odt', 'csv', 'tsv', 'xls', 'xlsx', 'numbers',
  'ppt', 'pptx', 'key', 'html', 'htm', 'xml', 'json', 'eml', 'epub']);
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const MAX_TEXT_CHARS = 64 * 1024; // keywords that matter are near the top; keeps the cache small
const textCache = new Map(); // `${path}:${mtimeMs}` → lowercased text ('' when none)

const canReadText = (file) => !file.isDir && file.size <= MAX_FILE_BYTES && TEXT_EXTENSIONS.has(path.extname(file.name).slice(1).toLowerCase());

function unescapeMdimport(s) {
  return s
    .replace(/\\U([0-9A-Fa-f]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

/**
 * Extract a file's text with the same importer Spotlight uses. Works on files Spotlight
 * hasn't indexed yet (a download that just landed) and on folders it doesn't index at all.
 */
function extractText(file) {
  const key = `${file.path}:${file.mtimeMs}`;
  if (textCache.has(key)) return Promise.resolve(textCache.get(key));
  if (!isMac || !canReadText(file)) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('mdimport', ['-t', '-d3', file.path], { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`; // mdimport writes its dump to stderr
      const m = out.match(/kMDItemTextContent = "((?:[^"\\]|\\.)*)"/);
      const text = m ? unescapeMdimport(m[1]).slice(0, MAX_TEXT_CHARS).toLowerCase() : '';
      if (textCache.size > 3000) textCache.clear();
      textCache.set(key, text);
      resolve(text);
    });
  });
}

module.exports = { mdlsBatch, kinds, extractText, canReadText, unescapeMdimport };
