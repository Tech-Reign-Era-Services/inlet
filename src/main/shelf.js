'use strict';

// The Shelf: a holding place at the top of the screen for things you want to drop somewhere else later.
// Files are kept by reference (never copied or moved); text and links are stored here. No Electron in this
// file, so it's tested directly with node --test.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_ITEMS = 100;
const MAX_TEXT = 20000; // characters kept from one text drop
const URL_RE = /^https?:\/\/[^\s]+$/i;

class Shelf {
  constructor(dir) {
    this.file = path.join(dir, 'shelf.json');
    let saved = [];
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')).items || []; } catch { /* first run */ }
    this.items = saved.filter((it) => it && it.id && (it.kind === 'file' ? it.path : it.text));
  }

  list() { return this.items; }
  get(ids) { const want = new Set(ids); return this.items.filter((it) => want.has(it.id)); }

  /** Add files and folders by path, newest first. A path already on the Shelf moves to the front. */
  addFiles(paths) {
    const added = [];
    for (const raw of [...new Set(paths)].reverse()) {
      if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue;
      const p = path.resolve(raw);
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      this.items = this.items.filter((it) => it.path !== p);
      const item = { id: newId(), kind: 'file', path: p, name: path.basename(p), isDir: st.isDirectory() && !isPackage(p), addedAt: Date.now() };
      this.items.unshift(item);
      added.unshift(item);
    }
    return this.commit(added);
  }

  /** Add a piece of text. A lone URL becomes a link. The same text twice moves to the front instead. */
  addText(raw) {
    const text = String(raw || '').slice(0, MAX_TEXT);
    if (!text.trim()) return [];
    const kind = URL_RE.test(text.trim()) ? 'link' : 'text';
    const value = kind === 'link' ? text.trim() : text;
    this.items = this.items.filter((it) => it.kind === 'file' || it.text !== value);
    const item = { id: newId(), kind, text: value, name: kind === 'link' ? linkName(value) : firstLine(value), addedAt: Date.now() };
    this.items.unshift(item);
    return this.commit([item]);
  }

  remove(ids) {
    const drop = new Set(ids);
    const before = this.items.length;
    this.items = this.items.filter((it) => !drop.has(it.id));
    if (this.items.length !== before) this.save();
    return before - this.items.length;
  }

  clear() { const n = this.items.length; this.items = []; this.save(); return n; }

  /** Forget files that are gone (moved away by dragging them into Finder, or deleted). Returns true if anything changed. */
  prune(exists = fs.existsSync) {
    const before = this.items.length;
    this.items = this.items.filter((it) => it.kind !== 'file' || exists(it.path));
    if (this.items.length === before) return false;
    this.save();
    return true;
  }

  commit(added) {
    if (this.items.length > MAX_ITEMS) this.items.length = MAX_ITEMS;
    if (added.length) this.save();
    return added;
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: this.items }));
    fs.renameSync(tmp, this.file);
  }
}

const newId = () => crypto.randomBytes(6).toString('hex');
const isPackage = (p) => /\.(app|pages|numbers|key|bundle|rtfd|pkg|mpkg|photoslibrary)$/i.test(p);
const firstLine = (t) => t.trim().split('\n')[0].slice(0, 80);
function linkName(url) {
  try { const u = new URL(url); return (u.hostname.replace(/^www\./, '') + (u.pathname === '/' ? '' : u.pathname)).slice(0, 80); } catch { return url.slice(0, 80); }
}

// ---------- where the Shelf sits on screen ----------

// The notch, read from AppKit through JavaScript for Automation (no native code needed).
// NSScreen.screens[0] is the screen with the menu bar, which is Electron's primary display.
const NOTCH_SCRIPT = `ObjC.import('AppKit');
const s = $.NSScreen.screens.objectAtIndex(0);
const f = s.frame, l = s.auxiliaryTopLeftArea, r = s.auxiliaryTopRightArea;
JSON.stringify({ width: f.size.width, safeTop: s.safeAreaInsets.top, leftWidth: l.size.width, rightX: r.origin.x - f.origin.x });`;

/** Turn NOTCH_SCRIPT's output into { left, width, height } relative to the screen, or null for a screen with no notch. */
function parseNotch(json) {
  let n;
  try { n = JSON.parse(json); } catch { return null; }
  if (!n || !(n.safeTop > 0) || !(n.leftWidth > 0) || !(n.rightX > n.leftWidth)) return null;
  return { left: Math.round(n.leftWidth), width: Math.round(n.rightX - n.leftWidth), height: Math.round(n.safeTop), screenWidth: Math.round(n.width) };
}

const EAR = 38; // room either side of the notch for the newest item and the count
const NO_NOTCH_WIDTH = 200; // the hover strip on screens without a notch
const EDGE_HEIGHT = 5; // …and its height, so it never covers menu bar items
const OPEN_WIDTH = 640;
const OPEN_HEIGHT = 174;
const SHOULDER = 10; // the inward curves where the island meets the top of the screen, like the notch's own
const SIDE = 34; // open: room beside and below the island for its shoulders, shadow and springy overshoot
const BELOW = 48;

/**
 * Sizes and screen positions for each state. display is Electron's { bounds, workArea };
 * notch is from parseNotch (ignored if it was measured on a screen of a different width).
 * closed/open are the window's bounds; island.closed/island.open are the black shape drawn inside it.
 */
function layout(display, notch, count) {
  const b = display.bounds;
  const menuBar = Math.max(24, display.workArea.y - b.y);
  const hasNotch = !!notch && notch.screenWidth === b.width;
  const n = hasNotch ? notch : { left: Math.round((b.width - NO_NOTCH_WIDTH) / 2), width: NO_NOTCH_WIDTH, height: menuBar };
  const center = b.x + n.left + n.width / 2;
  // Same odd/even width as the notch, so everything centres on it exactly.
  const fit = (w) => Math.max(1, Math.min(Math.round(w), b.width) - ((Math.min(Math.round(w), b.width) - n.width) % 2 ? 1 : 0));
  const box = (w, h) => {
    const width = fit(w); // a sleeping display can report 0 × 0, and a window can't be 0 wide
    const x = Math.round(Math.min(Math.max(center - width / 2, b.x), b.x + b.width - width));
    return { x, y: b.y, width, height: Math.round(h) };
  };
  const closedIsland = hasNotch
    ? { width: fit(n.width + (count ? EAR * 2 : 0)), height: n.height }
    : { width: fit(n.width), height: count ? 8 : EDGE_HEIGHT };
  // An empty Shelf is exactly the notch (invisible). With items, the window also fits the shoulders.
  const closed = box(closedIsland.width + (hasNotch && count ? SHOULDER * 2 : 0), closedIsland.height);
  const openIsland = { width: fit(Math.min(Math.max(OPEN_WIDTH, n.width + EAR * 2), b.width - SIDE * 2)), height: OPEN_HEIGHT + (hasNotch ? n.height - 32 : 0) };
  const open = box(openIsland.width + SIDE * 2, openIsland.height + BELOW);
  return {
    hasNotch,
    notch: { width: n.width, height: hasNotch ? n.height : 0 },
    bar: hasNotch ? n.height : menuBar,
    shoulder: SHOULDER,
    closed,
    open,
    island: { closed: closedIsland, open: openIsland },
  };
}

module.exports = { Shelf, parseNotch, layout, NOTCH_SCRIPT, MAX_ITEMS, EAR, SHOULDER };
