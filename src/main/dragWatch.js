'use strict';

// Notices when something is being dragged anywhere on the Mac, so the Shelf can open before the pointer
// reaches it. The closed Shelf is only as big as the notch, which is far too small to hit on purpose.
// A drag is: the left button is down and the drag pasteboard has changed since it went down (dragging a
// window or selecting text doesn't touch that pasteboard). Read through JavaScript for Automation in one
// long-lived osascript, which prints "drag" and "end" and quits by itself once Inlet has gone.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = `ObjC.import('AppKit');
ObjC.import('unistd');
const pb = $.NSPasteboard.pasteboardWithName($.NSPasteboardNameDrag);
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const say = (s) => out.writeData($(s + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
const parent = $.getppid();
let base = pb.changeCount;
let dragging = false;
while ($.getppid() === parent) {
  const down = ($.NSEvent.pressedMouseButtons & 1) === 1;
  const cc = pb.changeCount;
  if (!down) base = cc;
  const now = down && cc !== base;
  if (now !== dragging) { dragging = now; say(now ? 'drag' : 'end'); }
  delay(0.05);
}`;

const RESTART_MS = 2000;

class DragWatch extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.wanted = false;
    this.dragging = false;
    this.restartTimer = null;
  }

  start() {
    this.wanted = true;
    if (this.proc) return;
    const proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.proc = proc;
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line === 'drag' || line === 'end') this.set(line === 'drag');
      }
    });
    proc.on('error', () => {}); // 'exit' follows and handles it
    proc.on('exit', () => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.set(false);
      // It shouldn't stop on its own; if it does, try again in a moment rather than lose drag-to-open.
      if (this.wanted) this.restartTimer = setTimeout(() => this.wanted && this.start(), RESTART_MS);
    });
    proc.stdin.on('error', () => {});
    proc.stdin.end(SCRIPT);
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    const proc = this.proc;
    this.proc = null;
    if (proc) proc.kill();
    this.set(false);
  }

  set(dragging) {
    if (dragging === this.dragging) return;
    this.dragging = dragging;
    this.emit(dragging ? 'drag' : 'end');
  }
}

module.exports = { DragWatch };
