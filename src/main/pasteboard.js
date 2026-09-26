'use strict';

// Files on the macOS clipboard, so ⌘V in Finder, Mail or Slack pastes the files themselves.
// Electron's clipboard can't write several file URLs (and writing a custom type stalls), so this talks
// to NSPasteboard through JavaScript for Automation instead.
const { execFile } = require('child_process');

function jxa(script, args) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-', ...args], { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out.trim())))
      .stdin.end(script);
  });
}

const WRITE = `function run(paths) {
  ObjC.import('AppKit');
  const pb = $.NSPasteboard.generalPasteboard;
  pb.clearContents;
  return pb.writeObjects($(paths.map((p) => $.NSURL.fileURLWithPath(p)))) ? 'ok' : 'failed';
}`;

const READ = `function run() {
  ObjC.import('AppKit');
  const items = $.NSPasteboard.generalPasteboard.pasteboardItems;
  const out = [];
  for (let i = 0; i < items.count; i++) {
    const u = items.objectAtIndex(i).stringForType('public.file-url');
    if (u && !u.isNil()) out.push(ObjC.unwrap($.NSURL.URLWithString(u).path));
  }
  return JSON.stringify(out);
}`;

/** Put these files on the clipboard. Resolves true when it worked. */
async function copyFiles(paths) {
  if (!paths.length) return false;
  try { return (await jxa(WRITE, paths)) === 'ok'; } catch { return false; }
}

/** Paths of any files on the clipboard (e.g. after ⌘C in Finder). */
async function readFiles() {
  try { return JSON.parse(await jxa(READ, [])).filter(Boolean); } catch { return []; }
}

module.exports = { copyFiles, readFiles, jxa };
