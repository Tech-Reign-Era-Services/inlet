'use strict';

/* global S, api, h, icon, navigate, plural, fmtBytes */

// First-run guided tour. Each step switches to its page, spotlights one part of the UI and explains it.
// The spotlighted element stays clickable so people can try things as they go; the rest is dimmed.
// Uses app.js globals at runtime only, so load order doesn't matter.

const TOUR_STEPS = [
  {
    target: '#nav',
    side: 'right',
    title: 'Find your way around',
    text: 'Inlet has six sections. Hover over anything with an icon to see what it does. Shortcuts: ⌘1 to ⌘6.',
  },
  {
    target: '#mode-card',
    side: 'right',
    title: 'Manual or Auto',
    text: () => (S.st.settings.mode === 'auto'
      ? 'You’re in Auto mode: every new download is sorted as soon as it finishes. Flip this switch to go back to Manual, where nothing moves until you say so.'
      : 'You’re in Manual mode: nothing moves until you click Tidy now. Turn this switch on for Auto mode, which sorts every new download as soon as it finishes.'),
  },
  {
    page: 'overview',
    target: '.status-card',
    side: 'bottom',
    title: 'What’s waiting in Downloads',
    text: () => (S.st.unsorted
      ? `You have ${plural(S.st.unsorted, 'file')} (${fmtBytes(S.st.unsortedBytes)}) waiting. The bar shows what kinds of files they are. “Tidy now” sorts them all in one go, but let’s review them first.`
      : 'This card shows how many files are waiting to be sorted and what kinds they are. Right now Downloads is clean.'),
  },
  {
    page: 'organize',
    target: '.file-list, .content .card.empty',
    side: 'top',
    title: 'Review before anything moves',
    text: () => (S.scan.items.length
      ? 'Each file shows where it will go and why. Untick a file to leave it where it is, or pick a different folder from its dropdown. Double-click a name to open the file.'
      : 'When files arrive, each one is listed here with where it will go and why. You can untick files or change their destination before anything moves.'),
  },
  {
    page: 'organize',
    target: '.sticky-bar',
    skipIf: () => !S.scan.items.length,
    side: 'top',
    title: 'Try it: tidy your files',
    text: 'When the list looks right, click the “Tidy files” button. Go ahead and try it now. Every move can be undone.',
  },
  {
    page: 'rules',
    target: '#page-actions',
    side: 'bottom',
    title: 'Make your own rules',
    text: 'Rules catch files before normal sorting. For example, send invoices to Documents/Finance or GitHub downloads to Code. Click “New rule” to make one.',
  },
  {
    page: 'rules',
    target: '.cat-grid',
    side: 'top',
    title: 'Categories',
    text: 'Anything no rule catches is sorted by file type. Add or remove extensions, change a destination folder, or switch a category off.',
  },
  {
    page: 'cleanup',
    target: '.toolbar',
    side: 'bottom',
    title: 'Clean up old files and duplicates',
    text: 'Find files you haven’t opened in months and identical copies. Archive them or remove them. Removed files wait in a holding area so you can still undo.',
  },
  {
    page: 'activity',
    target: '.content .card',
    side: 'top',
    title: 'Undo anything',
    text: 'Everything Inlet moves is listed here. Put back one file or a whole batch, or press ⌘Z to undo the last action.',
  },
  {
    page: 'settings',
    target: '.settings-group',
    side: 'bottom',
    title: 'Watch more folders',
    text: 'Inlet can look after your Desktop or a screenshots folder too. The rest of Settings covers the schedule, notifications and what gets ignored.',
  },
  {
    page: 'overview',
    title: 'You’re all set',
    text: 'That’s the tour. You can take it again any time from Help → Take the Tour, or from Settings.',
  },
];

const TOUR = { on: false, i: 0, raf: 0, els: null, lastRect: '', steps: [] };

function tourEls() {
  if (TOUR.els) return TOUR.els;
  const shade = () => h('div', { class: 'tour-shade', onclick: (e) => e.stopPropagation() });
  const els = {
    shades: [shade(), shade(), shade(), shade()],
    ring: h('div', { class: 'tour-ring' }),
    pop: h('div', { class: 'tour-pop', role: 'dialog', 'aria-live': 'polite' }),
  };
  els.root = h('div', { class: 'tour' }, els.shades, els.ring, els.pop);
  TOUR.els = els;
  return els;
}

/** Start the tour. Waits for any open modal (Welcome, What's new…) to close first. */
function startTour() {
  if (TOUR.on) return;
  if (document.getElementById('modal').children.length) {
    const mo = new MutationObserver(() => {
      if (document.getElementById('modal').children.length) return;
      mo.disconnect();
      setTimeout(startTour, 250);
    });
    mo.observe(document.getElementById('modal'), { childList: true });
    return;
  }
  TOUR.on = true;
  TOUR.steps = TOUR_STEPS;
  document.body.append(tourEls().root);
  document.addEventListener('keydown', tourKeys, true);
  goStep(0);
  const loop = () => { if (!TOUR.on) return; positionTour(); TOUR.raf = requestAnimationFrame(loop); };
  loop();
}

function endTour(finished) {
  if (!TOUR.on) return;
  TOUR.on = false;
  cancelAnimationFrame(TOUR.raf);
  document.removeEventListener('keydown', tourKeys, true);
  TOUR.els.root.remove();
  if (!S.st.settings.tourDone) api.updateSettings({ tourDone: true }).then((st) => { S.st = st; });
  if (finished) navigate('overview');
}

function tourKeys(e) {
  if (document.getElementById('modal').children.length) return; // let the modal handle keys
  if (e.key === 'Escape') { e.stopPropagation(); endTour(false); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); goStep(TOUR.i + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); goStep(TOUR.i - 1); }
}

function goStep(i) {
  // Steps that don't apply right now (e.g. "tidy your files" with nothing to tidy) are skipped in the right direction.
  const dir = i >= TOUR.i ? 1 : -1;
  while (TOUR.steps[i] && TOUR.steps[i].skipIf && TOUR.steps[i].skipIf()) i += dir;
  if (i < 0) return;
  if (i >= TOUR.steps.length) { endTour(true); return; }
  TOUR.i = i;
  const step = TOUR.steps[i];
  if (step.page && S.page !== step.page) navigate(step.page);
  TOUR.lastRect = '';
  drawPop();
  // Bring the spotlighted element into view once the page has rendered.
  setTimeout(() => {
    const t = findTarget(step);
    if (t) t.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, 60);
}

function findTarget(step) {
  if (!step.target) return null;
  for (const sel of step.target.split(',')) {
    const el = document.querySelector(sel.trim());
    if (el && el.getClientRects().length) return el;
  }
  return null;
}

function drawPop() {
  const step = TOUR.steps[TOUR.i];
  const shown = TOUR.steps.filter((s) => !(s.skipIf && s.skipIf()));
  const n = shown.indexOf(step);
  const last = TOUR.i === TOUR.steps.length - 1;
  const text = typeof step.text === 'function' ? step.text() : step.text;
  TOUR.els.pop.replaceChildren(
    h('div', { class: 'tour-top' },
      h('span', { class: 'tour-count' }, `${n + 1} of ${shown.length}`),
      h('button', { class: 'icon-btn', title: 'Close the tour (Esc)', onclick: () => endTour(false) }, icon('x', 14))),
    h('h3', {}, step.title),
    h('p', {}, text),
    h('div', { class: 'tour-dots' }, shown.map((s, k) => h('span', { class: k === n ? 'on' : '' }))),
    h('div', { class: 'tour-foot' },
      !last && h('button', { class: 'btn ghost sm', onclick: () => endTour(false) }, 'Skip tour'),
      h('span', { style: { flex: 1 } }),
      n > 0 && h('button', { class: 'btn sm', onclick: () => goStep(TOUR.i - 1) }, 'Back'),
      h('button', { class: 'btn primary sm', onclick: () => goStep(TOUR.i + 1) }, last ? 'Finish' : 'Next', !last && icon('arrow', 13))));
}

function positionTour() {
  const step = TOUR.steps[TOUR.i];
  const t = findTarget(step);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let r = null;
  if (t) {
    const b = t.getBoundingClientRect();
    const pad = 6;
    // Clamp to the visible area so tall targets (lists, the whole content pane) still leave room for the popover.
    const top = Math.max(b.top - pad, 8);
    const bottom = Math.min(b.bottom + pad, vh - 8);
    r = { left: Math.max(b.left - pad, 4), top, width: Math.min(b.width + pad * 2, vw - 8), height: Math.max(bottom - top, 0) };
  }
  const key = r ? `${r.left}|${r.top}|${r.width}|${r.height}` : 'none';
  const popKey = `${key}|${TOUR.els.pop.offsetHeight}`;
  if (popKey === TOUR.lastRect) return;
  TOUR.lastRect = popKey;

  const [top, bottom, left, right] = TOUR.els.shades;
  const set = (el, x, y, w, hgt) => Object.assign(el.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(w, 0)}px`, height: `${Math.max(hgt, 0)}px` });
  const ring = TOUR.els.ring;
  if (!r) {
    set(top, 0, 0, vw, vh); set(bottom, 0, 0, 0, 0); set(left, 0, 0, 0, 0); set(right, 0, 0, 0, 0);
    ring.style.display = 'none';
  } else {
    set(top, 0, 0, vw, r.top);
    set(bottom, 0, r.top + r.height, vw, vh - r.top - r.height);
    set(left, 0, r.top, r.left, r.height);
    set(right, r.left + r.width, r.top, vw - r.left - r.width, r.height);
    ring.style.display = '';
    set(ring, r.left, r.top, r.width, r.height);
  }

  // Popover: preferred side, then whichever side has room, else centred.
  const pop = TOUR.els.pop;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  const gap = 14;
  let x = (vw - pw) / 2;
  let y = (vh - ph) / 2;
  if (r) {
    const room = {
      bottom: vh - (r.top + r.height) - gap >= ph + 8,
      top: r.top - gap >= ph + 8,
      right: vw - (r.left + r.width) - gap >= pw + 8,
      left: r.left - gap >= pw + 8,
    };
    const side = [step.side, 'bottom', 'top', 'right', 'left'].find((s) => s && room[s]);
    if (side === 'bottom' || side === 'top') {
      x = r.left + r.width / 2 - pw / 2;
      y = side === 'bottom' ? r.top + r.height + gap : r.top - gap - ph;
    } else if (side) {
      x = side === 'right' ? r.left + r.width + gap : r.left - gap - pw;
      y = r.top + r.height / 2 - ph / 2;
    } else {
      // Target fills the window (e.g. a long list): float the popover inside it, bottom-right.
      x = vw - pw - 24;
      y = vh - ph - 24;
    }
  }
  x = Math.max(12, Math.min(x, vw - pw - 12));
  y = Math.max(12, Math.min(y, vh - ph - 12));
  pop.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
