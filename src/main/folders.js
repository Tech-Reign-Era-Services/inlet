'use strict';

// Watched folders. The primary folder (settings.watchDir, normally ~/Downloads) is always watched;
// settings.extraFolders adds more (Desktop, a screenshots folder…). Each extra folder sorts either
// into its own category subfolders ("self") or into the primary folder's ("primary").
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PRIMARY = 'primary';

function allFolders(settings) {
  return [
    { id: PRIMARY, path: settings.watchDir, label: path.basename(settings.watchDir) || settings.watchDir, sortInto: 'self', primary: true, enabled: true },
    ...(settings.extraFolders || []).map((f) => ({ ...f, label: path.basename(f.path) || f.path, primary: false })),
  ];
}

const watchedFolders = (settings) => allFolders(settings).filter((f) => f.enabled !== false);

/** A folder's mode: extra folders can override Inlet's mode ('auto' | 'manual'), or follow it ('inherit'). */
const effectiveMode = (settings, folder) => (!folder.primary && ['auto', 'manual'].includes(folder.mode) ? folder.mode : settings.mode);

/** Folders auto mode should be watching right now. */
const autoFolders = (settings) => watchedFolders(settings).filter((f) => effectiveMode(settings, f) === 'auto');

/** The settings a single folder is scanned/watched/classified with. */
function folderSettings(settings, folder) {
  return {
    ...settings,
    watchDir: folder.path,
    baseDir: folder.sortInto === 'primary' ? settings.watchDir : folder.path,
    folderId: folder.id,
    // Auto mode only sorts files that arrived after it was switched on *for this folder*.
    autoSince: Math.max(folder.mode === 'auto' ? 0 : settings.autoSince || 0, folder.addedAt || 0, folder.autoSince || 0),
  };
}

const eachFolderSettings = (settings) => watchedFolders(settings).map((f) => folderSettings(settings, f));

const isInside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
};

/** The watched folder a path lives in (deepest match), or null. */
function folderFor(settings, p) {
  const r = path.resolve(p);
  return watchedFolders(settings)
    .filter((f) => isInside(r, path.resolve(f.path)))
    .sort((a, b) => b.path.length - a.path.length)[0] || null;
}

/** Folders Inlet must never manage: they hold apps, system files, or everything you own. */
function forbiddenFolders() {
  const home = os.homedir();
  return ['/', '/System', '/Applications', '/Library', '/Users', '/Volumes', '/private', home, path.join(home, 'Library'), path.join(home, 'Applications')];
}

/** Returns an error message, or null if the folder can be watched. */
function validateNewFolder(settings, p) {
  if (!p || !path.isAbsolute(p)) return 'Choose a folder.';
  const r = path.resolve(p);
  let st;
  try { st = fs.statSync(r); } catch { return 'That folder doesn’t exist.'; }
  if (!st.isDirectory()) return 'That isn’t a folder.';
  if (forbiddenFolders().includes(r)) return 'Inlet can’t manage that folder — it holds too much. Pick a more specific one, like Desktop.';
  for (const f of allFolders(settings)) {
    const fp = path.resolve(f.path);
    if (r === fp) return `${f.label} is already watched.`;
    if (isInside(r, fp)) return `That folder is inside ${f.label}, which Inlet already watches.`;
    if (isInside(fp, r)) return `That folder contains ${f.label}, which Inlet already watches.`;
  }
  return null;
}

const newFolder = (p) => ({ id: crypto.randomUUID(), path: path.resolve(p), enabled: true, sortInto: 'self', mode: 'inherit', addedAt: Date.now() });

/** Human label for where a file is: "Documents" inside Downloads, "Desktop/Images" elsewhere. */
function whereLabel(settings, p) {
  const f = folderFor(settings, p);
  if (!f) return path.dirname(p).replace(os.homedir(), '~');
  const rel = path.relative(f.path, path.dirname(p));
  if (f.primary) return rel || f.label;
  return rel ? `${f.label}/${rel}` : f.label;
}

module.exports = { PRIMARY, allFolders, watchedFolders, effectiveMode, autoFolders, folderSettings, eachFolderSettings, folderFor, validateNewFolder, newFolder, whereLabel, isInside };
