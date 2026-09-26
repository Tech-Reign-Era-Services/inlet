'use strict';

// The Shelf's window: a borderless panel over the notch (or the middle of the menu bar) that grows
// like the Dynamic Island when you hover over it, drag something onto it, or press the shortcut.
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { layout, parseNotch, nearShelf, NOTCH_SCRIPT } = require('./shelf');
const { jxa } = require('./pasteboard');
const { DragWatch } = require('./dragWatch');

const COLLAPSE_MS = 320; // a little longer than the island's 0.3s close in shelf.css
const WATCH_MS = 250; // while peeking, how often to check the pointer is still near the Shelf
const DRAG_MS = 50; // while something is being dragged, how often to check whether it's heading for the Shelf

class ShelfWindow {
  constructor() {
    this.win = null;
    this.wanted = false; // on in Settings (the window itself appears a moment later, once the notch is measured)
    this.enabling = false;
    this.state = 'closed'; // 'closed' | 'peek' (hovering or dragging) | 'open' (shortcut or menu: stays until you leave it)
    this.count = 0;
    this.notch = null;
    this.shrinkTimer = null;
    this.watchTimer = null;
    this.dragTimer = null;
    this.onDisplays = () => this.measure();
    // A drag anywhere on the Mac: open as the pointer nears the notch, since the notch itself is too small to aim for.
    this.drags = new DragWatch();
    this.drags.on('drag', () => {
      clearInterval(this.dragTimer);
      this.dragTimer = setInterval(() => {
        if (this.alive && this.state === 'closed' && nearShelf(screen.getCursorScreenPoint(), this.layout())) this.setState('peek');
      }, DRAG_MS);
    });
    this.drags.on('end', () => { clearInterval(this.dragTimer); this.dragTimer = null; });
  }

  get alive() { return !!this.win && !this.win.isDestroyed(); }

  async enable() {
    this.wanted = true;
    if (this.alive || this.enabling) return;
    this.enabling = true;
    await this.measure();
    this.enabling = false;
    if (!this.wanted || this.alive) return;
    this.win = new BrowserWindow({
      ...this.layout().closed,
      type: 'panel', // a non-activating panel: using the Shelf never brings Inlet's main window forward
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      enableLargerThanScreen: true,
      show: false,
      title: 'Shelf',
      webPreferences: {
        preload: path.join(__dirname, '..', 'shelf-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });
    // Above the menu bar (level 24) but below the image of whatever is being dragged (level 500):
    // at 'screen-saver' (1000) a file dragged onto the Shelf would disappear behind it.
    this.win.setAlwaysOnTop(true, 'pop-up-menu');
    // Without skipTransformProcessType, macOS would turn Inlet into a menu-bar-only app and hide its Dock icon.
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    this.win.on('blur', () => { if (this.state === 'open') this.setState('closed'); });
    this.win.webContents.on('will-navigate', (e) => e.preventDefault());
    this.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'shelf.html'));
    this.win.once('ready-to-show', () => { this.place(); this.win.showInactive(); });
    screen.on('display-metrics-changed', this.onDisplays);
    screen.on('display-added', this.onDisplays);
    screen.on('display-removed', this.onDisplays);
    this.drags.start();
  }

  disable() {
    this.wanted = false;
    screen.removeListener('display-metrics-changed', this.onDisplays);
    screen.removeListener('display-added', this.onDisplays);
    screen.removeListener('display-removed', this.onDisplays);
    clearTimeout(this.shrinkTimer);
    this.watch(false);
    this.drags.stop();
    if (this.alive) this.win.destroy();
    this.win = null;
    this.state = 'closed';
  }

  /** Read the notch again (screens changed), then reposition. */
  async measure() {
    try { this.notch = parseNotch(await jxa(NOTCH_SCRIPT, [])); } catch { this.notch = null; }
    this.place();
  }

  layout() { return layout(screen.getPrimaryDisplay(), this.notch, this.count); }

  /** Size the window for the current state and tell the page how to draw the island. */
  place() {
    if (!this.alive) return;
    const L = this.layout();
    clearTimeout(this.shrinkTimer);
    if (this.state === 'closed') {
      // Let the island shrink inside the big window first, then shrink the window to fit it.
      const shrink = () => this.alive && this.state === 'closed' && this.win.setBounds(L.closed);
      if (this.win.getBounds().height > L.closed.height) this.shrinkTimer = setTimeout(shrink, COLLAPSE_MS);
      else shrink();
    } else {
      this.win.setBounds(L.open);
    }
    this.watch(this.state === 'peek');
    this.win.webContents.send('shelf:state', { state: this.state, layout: L });
  }

  /**
   * A peeking Shelf closes once the pointer has left it. The page sees the pointer leave too, but not after
   * dragging a file out (the drag belongs to macOS by then), so this is the backstop.
   */
  watch(on) {
    if (!on) { clearInterval(this.watchTimer); this.watchTimer = null; return; }
    if (this.watchTimer) return;
    let away = 0;
    this.watchTimer = setInterval(() => {
      if (!this.alive || this.state !== 'peek') return this.watch(false);
      const p = screen.getCursorScreenPoint();
      const b = this.win.getBounds();
      const inside = p.x >= b.x - 8 && p.x <= b.x + b.width + 8 && p.y >= b.y && p.y <= b.y + b.height + 12;
      away = inside ? 0 : away + 1;
      if (away >= 3) this.setState('closed');
    }, WATCH_MS);
  }

  setState(next, { focus = false } = {}) {
    if (!this.alive) return;
    if (next === this.state && !focus) return;
    // Hovering doesn't downgrade a Shelf that was opened on purpose.
    if (next === 'peek' && this.state === 'open') return;
    this.state = next;
    this.place();
    if (next === 'open' && focus) this.win.focus();
  }

  /** Take the keyboard (after a click on the island), so Space, arrows and ⌘C reach the Shelf. */
  focus() { if (this.alive && !this.win.isFocused()) this.win.focus(); }

  toggle() { this.setState(this.state === 'closed' ? 'open' : 'closed', { focus: true }); }

  /** Open briefly to show something just landed on the Shelf. */
  flash(ms = 1600) {
    if (!this.alive || this.state !== 'closed') return;
    this.setState('peek');
    this.win.webContents.send('shelf:flash', ms);
  }

  setCount(n) {
    const changed = n !== this.count;
    this.count = n;
    if (changed) this.place();
  }

  send(channel, payload) { if (this.alive) this.win.webContents.send(channel, payload); }
  owns(webContents) { return this.alive && webContents === this.win.webContents; }
}

module.exports = { ShelfWindow };
