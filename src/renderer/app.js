'use strict';

/* global icon */
const api = window.tidy;

const S = {
  page: 'overview',
  st: null, // state from main: settings, stats, unsorted, scanId…
  scan: { items: [], skipped: [], error: null },
  scanId: -1,
  deselected: new Set(), // paths the user unticked on the Organize page (new files start ticked)
  overrides: {}, // path → categoryId chosen by the user
  filter: 'all',
  query: '',
  history: [],
  expanded: new Set(), // activity batches showing all moves
  busy: false,
  cleanupTab: 'stale',
  staleDays: null,
  stale: null, // null = not scanned yet
  dupes: null,
  cleanupLoading: false,
  cleanupDeselected: new Set(), // stale: unticked paths
  keepers: {}, // duplicates: hash → path to keep
};

// ---------- tiny DOM helper ----------

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
    }
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

// ---------- formatting ----------

function fmtBytes(n) {
  if (!n) return '0 KB';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
function fmtAgo(ms) {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
const fmtTime = (ms) => new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function dayLabel(ms) {
  const d = new Date(ms); const today = new Date();
  const diff = Math.round((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
function fmtWhen(ms) {
  const d = new Date(ms); const today = new Date();
  const diff = Math.round((new Date(d.toDateString()) - new Date(today.toDateString())) / 86400000);
  const day = diff === 0 ? 'today' : diff === 1 ? 'tomorrow' : d.toLocaleDateString(undefined, { weekday: 'long' });
  return `${day} at ${fmtTime(ms)}`;
}
const listJoin = (a) => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
/** "Images" for a folder inside Downloads, "Desktop/Images" inside another watched folder. */
function relPath(p) {
  const list = [...(S.st.folders || [])].sort((a, b) => b.path.length - a.path.length);
  for (const f of list) {
    if (p === f.path) return f.label;
    if (p.startsWith(f.path + '/')) {
      const rest = p.slice(f.path.length + 1);
      return f.primary ? rest : `${f.label}/${rest}`;
    }
  }
  return p.replace(/^\/Users\/[^/]+/, '~');
}
const folderLabel = (id) => (S.st.folders || []).find((f) => f.id === id)?.label || '';
const multiFolder = () => (S.st.folders || []).filter((f) => f.enabled !== false).length > 1;

// ---------- categories ----------

const PSEUDO = {
  folders: { id: 'folders', name: 'Folders', icon: 'folder', color: '#0A84FF' },
  rule: { id: 'rule', name: 'Custom rule', icon: 'rules', color: '#5E5CE6' },
  old: { id: 'old', name: 'Old Downloads', icon: 'archive', color: '#AC8E68' },
  removed: { id: 'removed', name: 'Removed', icon: 'trash', color: '#FF453A' },
};
const cats = () => S.st.settings.categories;
const cat = (id) => cats().find((c) => c.id === id) || PSEUDO[id] || PSEUDO.rule;
const catChip = (c, label) => h('span', { class: 'cat-chip', style: { '--c': c.color } }, icon(c.icon, 13), label || c.name);
const catIcon = (c, size = 16) => h('span', { class: 'cat-icon', title: c.name, style: { '--c': c.color } }, icon(c.icon, size));

// ---------- controls ----------

function toggle(checked, onChange, label) {
  return h('label', { class: 'switch', title: label || '' },
    h('input', { type: 'checkbox', checked, 'aria-label': label || 'Toggle', onchange: (e) => onChange(e.target.checked) }),
    h('span', { class: 'track' }, h('span', { class: 'thumb' })));
}
function segmented(options, value, onChange) {
  return h('div', { class: 'segmented', role: 'group' },
    options.map(([v, label]) => h('button', { class: v === value ? 'on' : '', onclick: () => onChange(v) }, label)));
}
function select(options, value, onChange, cls = '', title) {
  const el = h('select', { class: `select ${cls}`, title, onchange: (e) => onChange(e.target.value) },
    options.map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  return el;
}
function button(label, onClick, { cls = '', iconName, disabled, title } = {}) {
  return h('button', { class: `btn ${cls}`, onclick: onClick, disabled, title }, iconName && icon(iconName, 15), label);
}
function iconButton(name, title, onClick, cls = '') {
  return h('button', { class: `icon-btn ${cls}`, title, 'aria-label': title, onclick: onClick }, icon(name, 15));
}

// ---------- toasts & modals ----------

function toast(message, { action, error, ms = 6000 } = {}) {
  const el = h('div', { class: `toast ${error ? 'error' : ''}` },
    icon(error ? 'x' : 'check', 16), h('span', {}, message),
    action && h('button', { onclick: () => { action.fn(); dismiss(); } }, action.label));
  const dismiss = () => { el.classList.add('out'); setTimeout(() => el.remove(), 200); };
  $('toasts').append(el);
  setTimeout(dismiss, ms);
}

function closeModal() { $('modal').replaceChildren(); }
function openModal({ title, sub, body, foot, cls = '' }) {
  const modal = h('div', { class: `modal ${cls}`, role: 'dialog', 'aria-modal': 'true' },
    title && h('div', { class: 'modal-head' }, h('h2', { text: title }), sub && h('p', { text: sub })),
    h('div', { class: 'modal-body' }, body),
    foot && h('div', { class: 'modal-foot' }, foot));
  $('modal').replaceChildren(modal);
  $('modal').onclick = (e) => { if (e.target === $('modal') && S.st.settings.onboarded) closeModal(); };
  const first = modal.querySelector('input, select');
  if (first) setTimeout(() => first.focus(), 30);
  return modal;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('modal').children.length && S.st.settings.onboarded) closeModal();
});

// ---------- data ----------

async function saveSettings(patch) {
  S.st = await api.updateSettings(patch);
  await refreshScan(true);
  render();
}

async function refreshScan(force) {
  if (!force && S.st && S.st.scanId === S.scanId) return;
  const res = await api.getScan();
  S.scan = res;
  S.scanId = res.scanId;
  const present = new Set(res.items.map((i) => i.path));
  for (const p of S.deselected) if (!present.has(p)) S.deselected.delete(p);
  for (const p of Object.keys(S.overrides)) if (!present.has(p)) delete S.overrides[p];
  // Files you dragged back out of an Inlet folder start unticked — you've already said where they go.
  S.seenReturned = S.seenReturned || new Set();
  for (const it of res.items) {
    if (it.returned && !S.seenReturned.has(it.path)) { S.deselected.add(it.path); S.seenReturned.add(it.path); }
  }
}

async function tidyFiles(paths) {
  if (S.busy) return;
  S.busy = true; render();
  try {
    const overrides = {};
    for (const p of paths || []) if (S.overrides[p]) overrides[p] = S.overrides[p];
    const batch = await api.organize({ paths, overrides });
    S.busy = false;
    await refreshScan(true);
    render();
    if (batch.moves.length) {
      toast(`Moved ${plural(batch.moves.length, 'file')}`, { action: { label: 'Undo', fn: () => undo(batch.id) } });
    }
    if (batch.errors.length) toast(`${plural(batch.errors.length, 'file')} couldn't be moved`, { error: true });
  } catch (err) {
    S.busy = false; render();
    toast(err.message, { error: true });
  }
}

async function undo(batchId, moveId) {
  const res = await api.undo({ batchId, moveId });
  if (res.restored.length) toast(`Restored ${plural(res.restored.length, 'file')} to Downloads`);
  if (res.failed.length) toast(`${res.failed[0].message}${res.failed.length > 1 ? ` (+${res.failed.length - 1} more)` : ''}`, { error: true });
  S.history = await api.getHistory();
  await refreshScan(true);
  render();
}

function setMode(mode) {
  const { settings, unsorted } = S.st;
  if (mode === settings.mode) return;
  if (mode === 'auto' && unsorted > 0) {
    openModal({
      title: 'Turn on Auto mode?',
      sub: 'From now on, every new download is sorted once it finishes downloading.',
      body: h('p', { class: 'muted' }, `There ${unsorted === 1 ? 'is' : 'are'} also ${plural(unsorted, 'file')} (${fmtBytes(S.st.unsortedBytes)}) already sitting in Downloads. Auto mode leaves them alone unless you tidy them now.`),
      foot: [
        button('Cancel', closeModal, { cls: 'ghost' }),
        button('Only new downloads', async () => { closeModal(); await saveSettings({ mode }); toast('Auto mode is on'); }),
        button(`Also tidy ${plural(unsorted, 'file')}`, async () => { closeModal(); await saveSettings({ mode }); await tidyFiles(); }, { cls: 'primary' }),
      ],
    });
    return;
  }
  saveSettings({ mode }).then(() => toast(mode === 'auto' ? 'Auto mode is on' : 'Manual mode — nothing moves until you say so'));
}

// ---------- chrome: nav + mode card ----------

const NAV_TIPS = {
  overview: 'Overview: what’s waiting in Downloads and what Inlet has done (⌘1)',
  organize: 'Organize: review files and tidy them (⌘2)',
  cleanup: 'Cleanup: find old files and duplicates (⌘3)',
  rules: 'Rules: custom rules and file-type categories (⌘4)',
  activity: 'Activity: everything Inlet moved, with undo (⌘5)',
  settings: 'Settings (⌘6)',
};
const TRIGGER_TIPS = { manual: 'Tidied by you', auto: 'Sorted by Auto mode', scheduled: 'Scheduled tidy', cleanup: 'Removed in Cleanup' };

const PAGES = {
  overview: { title: 'Overview', icon: 'overview', render: renderOverview },
  organize: { title: 'Organize', icon: 'organize', render: renderOrganize },
  cleanup: { title: 'Cleanup', icon: 'trash', render: renderCleanup },
  rules: { title: 'Rules', icon: 'rules', render: renderRules },
  activity: { title: 'Activity', icon: 'activity', render: renderActivity },
  settings: { title: 'Settings', icon: 'settings', render: renderSettings },
};

function navigate(page) {
  if (!PAGES[page]) return;
  S.page = page;
  if (page === 'activity') api.getHistory().then((b) => { S.history = b; render(); });
  if (page === 'cleanup') loadCleanup(false);
  render();
  $('content').scrollTop = 0;
}

function renderChrome() {
  $('nav').replaceChildren(...Object.entries(PAGES).map(([id, p]) => h('button', {
    class: `nav-item ${S.page === id ? 'active' : ''}`, title: NAV_TIPS[id], onclick: () => navigate(id),
  }, icon(p.icon, 17), p.title,
  id === 'organize' && S.st.unsorted > 0 && h('span', { class: 'badge', title: `${plural(S.st.unsorted, 'file')} waiting to be sorted` }, S.st.unsorted),
  id === 'rules' && (S.st.suggestions || []).length > 0 && h('span', { class: 'badge soft', title: 'Suggested rules' }, S.st.suggestions.length))));

  const auto = S.st.settings.mode === 'auto';
  $('mode-card').replaceChildren(h('div', { class: 'mode-card' },
    h('div', { class: 'mode-card-row' },
      h('span', { class: `pulse ${auto && S.st.autoRunning ? 'on' : ''}`, title: auto && S.st.autoRunning ? 'Watching for new downloads' : 'Not watching. Files only move when you tidy.' }),
      h('span', { class: 'mode-card-title', style: { flex: 1 } }, auto ? 'Auto mode' : 'Manual mode'),
      toggle(auto, (v) => setMode(v ? 'auto' : 'manual'), auto ? 'Turn off Auto mode (switch to Manual)' : 'Turn on Auto mode: sort new downloads automatically')),
    h('div', { class: 'mode-card-sub' }, auto
      ? (S.st.autoRunning ? 'Watching Downloads. New files are sorted as they finish.' : 'Couldn’t watch the folder — check permissions in Settings.')
      : 'Files stay put until you click Tidy now.'),
    (() => {
      const odd = (S.st.folders || []).filter((f) => !f.primary && f.enabled !== false && f.effectiveMode !== S.st.settings.mode);
      return odd.length > 0 && h('div', { class: 'mode-card-sub', style: { marginTop: '4px' } },
        odd.map((f) => `${f.label}: always ${f.effectiveMode}`).join(' · '));
    })()));
}

function render() {
  if (!S.st) return;
  renderChrome();
  const page = PAGES[S.page];
  const { sub, actions, body } = page.render();
  $('page-title').textContent = page.title;
  $('page-sub').textContent = sub || '';
  $('page-actions').replaceChildren(...(actions || []));
  const scroll = $('content').scrollTop;
  const wrap = h('div', { class: S.lastPage === S.page ? '' : 'page-enter' }, body);
  $('content').replaceChildren(wrap);
  $('content').scrollTop = scroll;
  S.lastPage = S.page;
  loadThumbs();
}

// ---------- thumbnails ----------

const thumbCache = new Map();
const thumbObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    thumbObserver.unobserve(e.target);
    const p = e.target.dataset.path;
    const apply = (url) => { if (url) e.target.replaceChildren(h('img', { src: url, alt: '' })); };
    if (thumbCache.has(p)) apply(thumbCache.get(p));
    else api.fileIcon(p).then((url) => { thumbCache.set(p, url); apply(url); });
  }
}, { root: null, rootMargin: '200px' });
function loadThumbs() {
  document.querySelectorAll('.thumb[data-path]').forEach((el) => {
    const p = el.dataset.path;
    if (thumbCache.has(p) && thumbCache.get(p)) el.replaceChildren(h('img', { src: thumbCache.get(p), alt: '' }));
    else thumbObserver.observe(el);
  });
}
function thumb(item) {
  const c = cat(item.categoryId);
  return h('div', { class: 'thumb', 'data-path': item.path }, catIcon(c, 15));
}

// ---------- overview ----------

function breakdown(items) {
  const map = new Map();
  for (const it of items) {
    const id = S.overrides[it.path] || it.categoryId;
    const e = map.get(id) || { id, count: 0, bytes: 0 };
    e.count++; e.bytes += it.size;
    map.set(id, e);
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function renderOverview() {
  const { settings, stats, unsorted, unsortedBytes } = S.st;
  const auto = settings.mode === 'auto';

  const modeTile = (mode, iconName, title, desc) => h('button', {
    class: `mode-tile ${settings.mode === mode ? 'on' : ''}`, onclick: () => setMode(mode),
  }, h('span', { class: 'tile-icon' }, icon(iconName, 18)), h('span', { class: 'check' }, icon('check', 12)),
  h('h3', {}, title), h('p', {}, desc));

  const parts = breakdown(S.scan.items);
  let status;
  if (S.scan.error) {
    status = h('div', { class: 'card status-card' }, h('div', { class: 'clean-state' },
      h('div', { class: 'clean-badge', style: { background: 'var(--danger-soft)', color: 'var(--danger)' } }, icon('shield', 26)),
      h('div', {}, h('h3', { text: 'Inlet can’t read your Downloads folder' }),
        h('p', { class: 'muted' }, 'Open System Settings → Privacy & Security → Files and Folders and allow Inlet to access Downloads.'))));
  } else if (!unsorted) {
    status = h('div', { class: 'card status-card' }, h('div', { class: 'clean-state' },
      h('div', { class: 'clean-badge' }, icon('sparkle', 28)),
      h('div', {}, h('div', { class: 'big-number', style: { fontSize: '26px' } }, 'All clean'),
        h('div', { class: 'big-label' }, auto ? 'New downloads will be sorted automatically.' : 'Nothing to sort in Downloads right now.'))));
  } else {
    status = h('div', { class: 'card status-card' },
      h('div', { class: 'status-top' },
        h('div', {}, h('div', { class: 'big-number' }, unsorted.toLocaleString()),
          h('div', { class: 'big-label' }, `${unsorted === 1 ? 'file' : 'files'} waiting in Downloads · ${fmtBytes(unsortedBytes)}`)),
        h('div', { class: 'status-actions' },
          button('Review', () => navigate('organize')),
          button(S.busy ? 'Tidying…' : 'Tidy now', () => tidyFiles(), { cls: 'primary large', iconName: 'organize', disabled: S.busy }))),
      h('div', { class: 'stackbar' }, parts.map((p) => h('span', { title: `${cat(p.id).name}: ${p.count}`, style: { flexGrow: p.count, background: cat(p.id).color } }))),
      h('div', { class: 'legend' }, parts.slice(0, 10).map((p) => h('span', { class: 'legend-item' },
        h('span', { class: 'dot', style: { background: cat(p.id).color } }), cat(p.id).name, h('b', {}, p.count)))));
  }

  const stat = (iconName, value, label) => h('div', { class: 'card stat' },
    h('div', { class: 'stat-icon' }, icon(iconName, 18)), h('div', {}, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label)));

  const recentMoves = [];
  for (const b of S.st.recent || []) for (const m of b.moves) if (recentMoves.length < 6) recentMoves.push({ ...m, time: b.time });

  const recent = h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', { text: 'Recently sorted' }),
      h('div', { class: 'inline' },
        S.st.lastUndoable && button(`Undo last (${S.st.lastUndoable.count})`, () => undoLast(), { cls: 'ghost sm', iconName: 'undo', title: 'Undo the most recent action (⌘Z)' }),
        button('View all', () => navigate('activity'), { cls: 'ghost sm' }))),
    recentMoves.length
      ? h('ul', { class: 'recent' }, recentMoves.map((m) => h('li', {},
        catIcon(cat(m.categoryId), 14),
        h('span', { class: 'name', title: m.name, style: m.undone ? { textDecoration: 'line-through', opacity: 0.5 } : null }, m.name),
        catChip(cat(m.categoryId), relPath(m.to.slice(0, m.to.lastIndexOf('/')))),
        h('span', { class: 'when' }, fmtAgo(m.time)),
        iconButton('reveal', 'Show in Finder', () => api.reveal(m.undone ? m.from : m.to)))))
      : h('div', { class: 'empty', style: { padding: '28px' } }, h('p', {}, 'Sorted files will show up here.')));

  return {
    sub: `Keeping ${listJoin((S.st.folders || []).filter((f) => f.enabled !== false).map((f) => f.label))} clean`,
    actions: [button('Rescan', async () => { await api.scan(); await refreshScan(true); render(); }, { iconName: 'search', cls: 'ghost', title: 'Look for new files in your watched folders' })],
    body: [
      h('div', { class: 'mode-tiles' },
        modeTile('manual', 'hand', 'Manual', S.st.nextScheduled
          ? `Preview, then tidy with one click. Scheduled tidy runs ${fmtWhen(S.st.nextScheduled)}.`
          : 'Preview what will move, then tidy with one click. Nothing happens on its own.'),
        modeTile('auto', 'bolt', 'Auto', 'Every new download is sorted the moment it finishes downloading.')),
      h('div', { class: 'grid main-side' }, status,
        h('div', { class: 'stat-list' },
          stat('check', stats.total.toLocaleString(), 'files sorted all-time'),
          stat('activity', stats.week.toLocaleString(), 'sorted in the last 7 days'),
          stat('archive', fmtBytes(stats.bytes), 'organized so far'))),
      (S.st.suggestions || []).length > 0 && suggestionCard(S.st.suggestions[0], S.st.suggestions.length - 1),
      recent,
    ],
  };
}

// ---------- organize ----------

function visibleItems() {
  const q = S.query.trim().toLowerCase();
  return S.scan.items.filter((it) => (!S.folderFilter || S.folderFilter === 'all' || it.folderId === S.folderFilter)
    && (S.filter === 'all' || (S.overrides[it.path] || it.categoryId) === S.filter)
    && (!q || it.name.toLowerCase().includes(q) || (it.host || '').includes(q)));
}

function renderOrganize() {
  const items = S.scan.items;
  const selected = items.filter((i) => !S.deselected.has(i.path));
  const selBytes = selected.reduce((s, i) => s + i.size, 0);
  const parts = breakdown(items);

  const list = h('div', { class: 'card file-list' });
  const drawList = () => {
    const vis = visibleItems();
    const allOn = vis.length > 0 && vis.every((i) => !S.deselected.has(i.path));
    const head = h('div', { class: 'file-head' },
      h('input', { type: 'checkbox', class: 'checkbox', checked: allOn, 'aria-label': 'Select all', title: 'Select or deselect every file shown', onchange: (e) => {
        vis.forEach((i) => (e.target.checked ? S.deselected.delete(i.path) : S.deselected.add(i.path)));
        render();
      } }),
      h('span'), h('span', {}, `${plural(vis.length, 'file')}`), h('span', {}, 'Why'), h('span', {}, 'Moves to'), h('span'));
    const rows = vis.map((it) => {
      const on = !S.deselected.has(it.path);
      const planIsCategory = cats().some((c) => c.id === it.categoryId && it.dest.endsWith('/' + c.folder));
      const options = [];
      if (!planIsCategory) options.push(['__plan', relPath(it.dest)]);
      cats().filter((c) => c.enabled).forEach((c) => options.push([c.id, c.name]));
      const current = S.overrides[it.path] || (planIsCategory ? it.categoryId : '__plan');
      const reason = S.overrides[it.path] ? 'Chosen by you' : it.returned ? 'You moved this back — kept here' : it.reason;
      return h('div', { class: `file-row ${on ? '' : 'off'}` },
        h('input', { type: 'checkbox', class: 'checkbox', checked: on, 'aria-label': `Include ${it.name}`, onchange: (e) => {
          if (e.target.checked) S.deselected.delete(it.path); else S.deselected.add(it.path);
          render();
        } }),
        thumb(it),
        h('div', { style: { minWidth: 0 } },
          h('div', { class: 'file-name', title: it.name, ondblclick: () => api.openPath(it.path) }, it.name),
          h('div', { class: 'file-meta' },
            multiFolder() && [h('span', { class: 'host', title: 'Found in' }, icon('folder', 11), folderLabel(it.folderId)), '·'],
            h('span', {}, it.isDir ? 'Package' : fmtBytes(it.size)), '·', h('span', {}, fmtAgo(it.addedMs)),
            it.host && ['·', h('span', { class: 'host', title: 'Downloaded from' }, icon('globe', 11), it.host)],
            it.newName && !S.overrides[it.path] && ['·', h('span', { class: 'host', title: 'Renamed by rule', style: { color: 'var(--accent)' } }, icon('edit', 11), it.newName)])),
        h('div', { class: `reason ${reason.startsWith('Rule') || S.overrides[it.path] ? 'custom' : ''}`, title: reason }, reason),
        select(options, current, (v) => {
          if (v === '__plan' || (planIsCategory && v === it.categoryId)) delete S.overrides[it.path];
          else S.overrides[it.path] = v;
          render();
        }, 'target-select', 'Where this file will go. Pick another folder to override.'),
        h('div', { class: 'row-actions' }, iconButton('reveal', 'Show in Finder', () => api.reveal(it.path))));
    });
    list.replaceChildren(head, ...(rows.length ? rows : [h('div', { class: 'empty', style: { padding: '32px' } }, h('p', {}, 'No files match.'))]));
  };

  let body;
  if (!items.length) {
    body = [h('div', { class: 'card empty' }, h('div', { class: 'clean-badge' }, icon('sparkle', 28)),
      h('h3', { text: 'Downloads is clean' }),
      h('p', { text: S.scan.skipped.length ? `${plural(S.scan.skipped.length, 'item')} left alone on purpose (see below).` : 'Nothing to organize.' })),
    skippedSection()];
  } else {
    drawList();
    const search = h('div', { class: 'search' }, icon('search', 14),
      h('input', { class: 'input', type: 'search', placeholder: 'Search files or websites', value: S.query, oninput: (e) => { S.query = e.target.value; drawList(); loadThumbs(); } }));
    body = [
      h('div', { class: 'toolbar' }, search,
        multiFolder() && segmented([['all', 'All folders'], ...(S.st.folders || []).filter((f) => f.enabled !== false).map((f) => [f.id, f.label])],
          S.folderFilter || 'all', (v) => { S.folderFilter = v; render(); }),
        h('div', { class: 'filters' },
          h('button', { class: `filter ${S.filter === 'all' ? 'on' : ''}`, onclick: () => { S.filter = 'all'; render(); } }, 'All', h('span', { class: 'n' }, items.length)),
          parts.map((p) => h('button', { class: `filter ${S.filter === p.id ? 'on' : ''}`, onclick: () => { S.filter = p.id; render(); } },
            h('span', { class: 'dot', style: { background: cat(p.id).color } }), cat(p.id).name, h('span', { class: 'n' }, p.count))))),
      list,
      h('div', { class: 'sticky-bar' },
        h('div', {}, h('b', {}, `${selected.length.toLocaleString()} of ${plural(items.length, 'file')}`), h('span', { class: 'muted' }, ` selected · ${fmtBytes(selBytes)}`),
          Object.keys(S.overrides).length > 0 && h('div', { class: 'faint', style: { fontSize: '11.5px' } }, icon('sparkle', 11), ` Inlet learns from the ${plural(Object.keys(S.overrides).length, 'destination')} you changed and may suggest a rule.`)),
        h('div', { class: 'inline' },
          S.deselected.size > 0 && button('Select all', () => { S.deselected.clear(); render(); }, { cls: 'ghost' }),
          button(S.busy ? 'Tidying…' : `Tidy ${plural(selected.length, 'file')}`, () => tidyFiles(selected.map((i) => i.path)), { cls: 'primary', iconName: 'organize', disabled: !selected.length || S.busy }))),
      skippedSection(),
    ];
  }
  return {
    sub: 'Preview exactly what moves where. Untick anything you want to keep, or change its destination.',
    actions: [button('Rescan', async () => { await api.scan(); await refreshScan(true); render(); }, { iconName: 'search', title: 'Look for new files in your watched folders' })],
    body,
  };
}

function skippedSection() {
  const sk = S.scan.skipped;
  if (!sk.length) return null;
  const labels = { folder: 'folder', downloading: 'still downloading', 'tidy folder': 'Inlet folder', ignored: 'ignore list', 'unknown type': 'unknown type' };
  return h('details', { class: 'skipped' },
    h('summary', {}, icon('down', 14), `${plural(sk.length, 'item')} left alone`),
    h('div', { class: 'skipped-list' }, sk.map((s) => h('div', {}, h('span', { class: 'n', title: s.name }, s.name), h('span', { class: 'r' }, labels[s.reason] || s.reason)))));
}

// ---------- rules ----------

const FIELDS = {
  name: { label: 'Name', ops: [['contains', 'contains'], ['startsWith', 'starts with'], ['endsWith', 'ends with'], ['is', 'is'], ['matches', 'matches regex']], placeholder: 'invoice' },
  extension: { label: 'Extension', ops: [['is', 'is one of'], ['isNot', 'is not']], placeholder: 'pdf, docx' },
  kind: { label: 'Kind', ops: [['contains', 'contains'], ['isNot', 'isn’t']], placeholder: 'image, PDF document' },
  content: { label: 'File text', ops: [['contains', 'contains'], ['isNot', 'doesn’t contain']], placeholder: 'invoice number' },
  source: { label: 'Website', ops: [['contains', 'contains'], ['isNot', 'doesn’t contain']], placeholder: 'github.com' },
  size: { label: 'Size (MB)', ops: [['gt', 'is larger than'], ['lt', 'is smaller than']], placeholder: '100' },
  age: { label: 'Age (days)', ops: [['gt', 'is older than'], ['lt', 'is newer than']], placeholder: '30' },
};

function ruleSummary(rule) {
  const conds = rule.conditions.filter((c) => String(c.value).trim());
  const parts = [];
  conds.forEach((c, i) => {
    const f = FIELDS[c.field];
    if (i) parts.push(rule.match === 'any' ? ' or ' : ' and ');
    parts.push(`${f.label.replace(/ \(.*\)/, '').toLowerCase()} ${(f.ops.find((o) => o[0] === c.op) || f.ops[0])[1]} `, h('code', {}, c.value));
  });
  if (!parts.length) parts.push('No conditions yet');
  return h('div', { class: 'rule-summary' }, 'If ', parts, ' → ', h('code', {}, rule.target || '?'),
    rule.rename && [', renamed to ', h('code', {}, rule.rename)],
    rule.folders && rule.folders.length > 0 && ` · only in ${listJoin(rule.folders.map(folderLabel).filter(Boolean)) || 'a removed folder'}`);
}

async function saveRules(rules) { await saveSettings({ rules }); }

function renderRules() {
  const { rules } = S.st.settings;
  const ruleCards = rules.map((r, i) => {
    const pill = h('span', { class: 'pill' }, '…');
    api.testRule(r).then((res) => {
      pill.textContent = `${res.count} now`;
      pill.title = res.count ? `Matches in Downloads now: ${res.sample.join(', ')}` : 'No files in Downloads match right now';
      if (res.count && r.enabled) pill.classList.add('accent');
    });
    const move = (d) => { const next = [...rules]; [next[i], next[i + d]] = [next[i + d], next[i]]; saveRules(next); };
    return h('div', { class: `card rule ${r.enabled ? '' : 'disabled'}` },
      toggle(r.enabled, (v) => saveRules(rules.map((x) => (x.id === r.id ? { ...x, enabled: v } : x))), `Turn “${r.name}” on or off`),
      h('div', { class: 'rule-body', style: { minWidth: 0 } }, h('div', { class: 'rule-name' }, r.name, pill), ruleSummary(r)),
      h('div', { class: 'rule-actions' },
        i > 0 && iconButton('up', 'Move up (checked earlier)', () => move(-1)),
        i < rules.length - 1 && iconButton('down', 'Move down (checked later)', () => move(1)),
        iconButton('edit', 'Edit rule', () => editRule(r)),
        iconButton('trash', 'Delete rule', () => saveRules(rules.filter((x) => x.id !== r.id)), 'danger')));
  });

  const catCards = cats().map((c) => catCard(c));

  return {
    sub: 'Custom rules are checked first, top to bottom. Anything they don’t catch is sorted by file type.',
    actions: [button('New rule', () => editRule(null), { cls: 'primary', iconName: 'plus' })],
    body: [
      (S.st.suggestions || []).length > 0 && h('div', {},
        h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Suggested for you'), h('span', { class: 'muted' }, 'Based on where you moved files by hand')),
        h('div', { class: 'rule-list' }, S.st.suggestions.map(suggestionCard))),
      h('div', {}, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Custom rules'), h('span', { class: 'muted' }, 'Match by name, kind, file text, website, size or age')),
        rules.length ? h('div', { class: 'rule-list' }, ruleCards)
          : h('div', { class: 'card empty', style: { padding: '28px' } }, h('p', {}, 'No custom rules yet.'))),
      h('div', {}, h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Categories'),
        button('Add category', () => editCategory(null), { cls: 'sm', iconName: 'plus' })),
      h('div', { class: 'cat-grid' }, catCards)),
    ],
  };
}

function catCard(c) {
  const update = (patch) => saveSettings({ categories: cats().map((x) => (x.id === c.id ? { ...x, ...patch } : x)) });
  const addExt = (raw) => {
    const exts = raw.split(/[\s,]+/).map((e) => e.replace(/^\./, '').toLowerCase()).filter(Boolean);
    if (!exts.length) return;
    // An extension belongs to one category — take it from wherever it was.
    saveSettings({ categories: cats().map((x) => (x.id === c.id
      ? { ...x, extensions: [...new Set([...x.extensions, ...exts])] }
      : { ...x, extensions: x.extensions.filter((e) => !exts.includes(e)) })) });
  };
  const isOther = c.id === 'other';
  return h('div', { class: `card cat-card ${c.enabled ? '' : 'disabled'}` },
    h('div', { class: 'cat-card-head' }, catIcon(c, 16),
      h('div', { class: 't' }, h('div', { class: 'n' }, c.name),
        h('button', { class: 'folder-link', title: 'Change destination', onclick: () => editCategory(c) }, icon('folder', 12), h('span', {}, relPath(resolveFolder(c.folder))))),
      iconButton('edit', 'Edit category', () => editCategory(c)),
      toggle(c.enabled, (v) => update({ enabled: v }), `Turn ${c.name} sorting on or off`)),
    isOther
      ? h('div', { class: 'muted', style: { fontSize: '12px' } }, S.st.settings.unknownFiles === 'other' ? 'Files with types no category claims.' : 'Unknown files are left in place (see Settings).')
      : h('div', { class: 'chips' },
        c.extensions.map((e) => h('span', { class: 'chip' }, e, h('button', { title: `Remove .${e}`, 'aria-label': `Remove ${e}`, onclick: () => update({ extensions: c.extensions.filter((x) => x !== e) }) }, icon('x', 10)))),
        h('input', { class: 'chip-input', placeholder: '+ add', 'aria-label': `Add extension to ${c.name}`,
          onkeydown: (e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addExt(e.target.value); } },
          onblur: (e) => e.target.value && addExt(e.target.value) })));
}

function resolveFolder(folder) {
  if (folder.startsWith('/')) return folder;
  if (folder.startsWith('~/')) return folder; // shown as-is
  return `${S.st.settings.watchDir}/${folder}`;
}

function editRule(existing) {
  const rule = existing ? JSON.parse(JSON.stringify(existing)) : {
    id: `rule-${Date.now()}`, name: '', enabled: true, match: 'all',
    conditions: [{ field: 'name', op: 'contains', value: '' }], target: '',
  };
  const preview = h('div', { class: 'match-preview none' }, 'Add a condition to see what matches.');
  let t;
  const refreshPreview = () => {
    clearTimeout(t);
    t = setTimeout(async () => {
      const usesContent = rule.conditions.some((c) => c.field === 'content' && String(c.value).trim());
      if (usesContent) preview.textContent = 'Reading file text…';
      const res = await api.testRule(rule);
      preview.className = `match-preview ${res.count ? '' : 'none'}`;
      const where = multiFolder() ? 'your watched folders' : 'Downloads';
      preview.replaceChildren(...[res.count
        ? `Matches ${plural(res.count, 'file')} in ${where} right now: ${res.sample.join(', ')}${res.count > res.sample.length ? '…' : ''}`
        : `No files in ${where} match right now.`,
      res.renameExample && h('div', { style: { marginTop: '6px' } }, 'Example rename: ', h('span', { class: 'mono' }, res.renameExample.from), ' → ', h('span', { class: 'mono' }, res.renameExample.to)),
      usesContent && h('div', { class: 'faint', style: { marginTop: '6px', fontSize: '11.5px' } }, 'File text is read with Spotlight’s importers: PDFs, text, Word, Pages, Excel and more.')].filter(Boolean));
    }, 200);
  };
  const conds = h('div', { style: { display: 'grid', gap: '8px' } });
  const matchSeg = h('div', { class: 'inline' });
  const drawMatch = () => matchSeg.replaceChildren(segmented([['all', 'All conditions match'], ['any', 'Any condition matches']], rule.match,
    (v) => { rule.match = v; drawMatch(); refreshPreview(); }));
  drawMatch();
  const drawConds = () => {
    conds.replaceChildren(...rule.conditions.map((c, i) => {
      const f = FIELDS[c.field];
      return h('div', { class: 'cond-row' },
        select(Object.entries(FIELDS).map(([k, v]) => [k, v.label]), c.field, (v) => { c.field = v; c.op = FIELDS[v].ops[0][0]; drawConds(); refreshPreview(); }),
        select(f.ops, c.op, (v) => { c.op = v; refreshPreview(); }),
        h('input', { class: 'input', value: c.value, placeholder: f.placeholder, type: ['size', 'age'].includes(c.field) ? 'number' : 'text', oninput: (e) => { c.value = e.target.value; refreshPreview(); } }),
        iconButton('x', 'Remove condition', () => { rule.conditions.splice(i, 1); drawConds(); refreshPreview(); }, 'danger'));
    }));
  };
  drawConds();
  refreshPreview();

  const nameInput = h('input', { class: 'input', value: rule.name, placeholder: 'e.g. Invoices', oninput: (e) => { rule.name = e.target.value; } });
  const targetInput = h('input', { class: 'input', value: rule.target, placeholder: 'Documents/Finance or /Users/you/Invoices', oninput: (e) => { rule.target = e.target.value; } });
  const renameInput = h('input', { class: 'input', value: rule.rename || '', placeholder: 'Leave empty to keep the original name', oninput: (e) => { rule.rename = e.target.value; refreshPreview(); } });
  const insertToken = (tok) => {
    const at = renameInput.selectionStart ?? renameInput.value.length;
    renameInput.value = `${renameInput.value.slice(0, at)}{${tok}}${renameInput.value.slice(renameInput.selectionEnd ?? at)}`;
    rule.rename = renameInput.value;
    renameInput.focus();
    refreshPreview();
  };
  const error = h('span', { class: 'left', style: { color: 'var(--danger)' } });
  rule.folders = rule.folders || [];
  const appliesTo = h('div', { class: 'chips' });
  const drawApplies = () => appliesTo.replaceChildren(
    h('button', { class: `filter ${rule.folders.length ? '' : 'on'}`, onclick: () => { rule.folders = []; drawApplies(); refreshPreview(); } }, 'All folders'),
    ...(S.st.folders || []).filter((f) => f.enabled !== false).map((f) => h('button', {
      class: `filter ${rule.folders.includes(f.id) ? 'on' : ''}`,
      onclick: () => {
        rule.folders = rule.folders.includes(f.id) ? rule.folders.filter((x) => x !== f.id) : [...rule.folders, f.id];
        drawApplies(); refreshPreview();
      },
    }, icon('folder', 12), f.label)));
  drawApplies();

  openModal({
    title: existing ? 'Edit rule' : 'New rule',
    sub: 'Rules run before file-type sorting. The first rule that matches wins.',
    body: [
      h('div', { class: 'field' }, h('label', {}, 'Name'), nameInput),
      h('div', { class: 'field' }, h('label', {}, 'When'),
        matchSeg,
        conds,
        h('div', {}, button('Add condition', () => { rule.conditions.push({ field: 'name', op: 'contains', value: '' }); drawConds(); }, { cls: 'sm ghost', iconName: 'plus' }))),
      multiFolder() && h('div', { class: 'field' }, h('label', {}, 'Applies to'), appliesTo),
      h('div', { class: 'field' }, h('label', {}, 'Move to'),
        h('div', { class: 'inline' }, targetInput, button('Browse…', async () => {
          const p = await api.pickFolder();
          if (p) { rule.target = p; targetInput.value = p; }
        })),
        h('div', { class: 'chips' }, cats().filter((c) => c.enabled).map((c) => h('button', { class: 'filter', onclick: () => { rule.target = c.folder; targetInput.value = c.folder; targetInput.focus(); } },
          h('span', { class: 'dot', style: { background: c.color } }), c.folder)))),
      h('div', { class: 'field' }, h('label', {}, 'Rename to (optional)'), renameInput,
        h('div', { class: 'chips' }, [['name', 'original name'], ['date', 'download date'], ['year', 'year'], ['month', 'month'], ['source', 'website']]
          .map(([tok, label]) => h('button', { class: 'filter', title: `Insert {${tok}}`, onclick: () => insertToken(tok) }, h('span', { class: 'mono' }, `{${tok}}`), label)))),
      preview,
    ],
    foot: [error, button('Cancel', closeModal, { cls: 'ghost' }), button(existing ? 'Save rule' : 'Create rule', async () => {
      rule.conditions = rule.conditions.filter((c) => String(c.value).trim());
      if (!rule.name.trim()) { error.textContent = 'Give the rule a name.'; return; }
      if (!rule.conditions.length) { error.textContent = 'Add at least one condition.'; return; }
      if (!rule.target.trim()) { error.textContent = 'Choose where matching files go.'; return; }
      const rules = S.st.settings.rules;
      await saveRules(existing ? rules.map((r) => (r.id === rule.id ? rule : r)) : [...rules, rule]);
      closeModal();
      toast(existing ? 'Rule saved' : 'Rule created');
    }, { cls: 'primary' })],
  });
}

const SWATCHES = ['#0A84FF', '#30D158', '#FF9F0A', '#FF375F', '#BF5AF2', '#5E5CE6', '#64D2FF', '#FFD60A', '#AC8E68', '#8E8E93'];
const ICON_CHOICES = ['doc', 'image', 'video', 'music', 'archive', 'box', 'code', 'table', 'slides', 'pen', 'type', 'key', 'folder', 'inbox', 'globe', 'dots'];

function editCategory(existing) {
  const c = existing ? { ...existing } : { id: `cat-${Date.now()}`, name: '', icon: 'folder', color: SWATCHES[0], folder: '', extensions: [], enabled: true };
  const error = h('span', { class: 'left', style: { color: 'var(--danger)' } });
  const folderInput = h('input', { class: 'input', value: c.folder, placeholder: 'Folder name inside Downloads, or a full path', oninput: (e) => { c.folder = e.target.value; } });
  const swatches = h('div', { class: 'color-row' });
  const icons = h('div', { class: 'color-row' });
  const draw = () => {
    swatches.replaceChildren(...SWATCHES.map((s) => h('button', { class: `swatch ${c.color === s ? 'on' : ''}`, style: { background: s }, 'aria-label': s, title: 'Use this color', onclick: () => { c.color = s; draw(); } })));
    icons.replaceChildren(...ICON_CHOICES.map((n) => h('button', { class: `icon-pick ${c.icon === n ? 'on' : ''}`, 'aria-label': n, title: `Use the ${n} icon`, onclick: () => { c.icon = n; draw(); } }, icon(n, 16))));
  };
  draw();
  const builtIn = existing && !existing.id.startsWith('cat-');
  openModal({
    title: existing ? `Edit ${existing.name}` : 'New category',
    body: [
      h('div', { class: 'field' }, h('label', {}, 'Name'), h('input', { class: 'input', value: c.name, placeholder: 'e.g. Invoices', oninput: (e) => { c.name = e.target.value; if (!existing && !folderInput.dataset.touched) { c.folder = e.target.value; folderInput.value = e.target.value; } } })),
      h('div', { class: 'field' }, h('label', {}, 'Destination folder'),
        h('div', { class: 'inline' }, folderInput, button('Browse…', async () => {
          const p = await api.pickFolder();
          if (p) { c.folder = p; folderInput.value = p; folderInput.dataset.touched = '1'; }
        })),
        h('div', { class: 'faint', style: { fontSize: '12px' } }, 'A plain name like “Invoices” lives inside Downloads. Pick any folder to send files elsewhere.')),
      !existing && h('div', { class: 'field' }, h('label', {}, 'Extensions'),
        h('input', { class: 'input', placeholder: 'e.g. ofx, qif', oninput: (e) => { c.extensions = e.target.value.split(/[\s,]+/).map((x) => x.replace(/^\./, '').toLowerCase()).filter(Boolean); } })),
      h('div', { class: 'field' }, h('label', {}, 'Color'), swatches),
      h('div', { class: 'field' }, h('label', {}, 'Icon'), icons),
    ],
    foot: [
      existing && !builtIn && existing.id !== 'other' ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
        await saveSettings({ categories: cats().filter((x) => x.id !== c.id) }); closeModal(); toast(`Deleted ${c.name}`);
      } }, icon('trash', 14), 'Delete') : error,
      button('Cancel', closeModal, { cls: 'ghost' }),
      button(existing ? 'Save' : 'Create category', async () => {
        if (!c.name.trim()) { error.textContent = 'Name the category.'; return; }
        if (!c.folder.trim()) { error.textContent = 'Choose a destination folder.'; return; }
        const next = existing
          ? cats().map((x) => (x.id === c.id ? c : x))
          : [...cats().filter((x) => x.id !== 'other').map((x) => ({ ...x, extensions: x.extensions.filter((e) => !c.extensions.includes(e)) })), c, cats().find((x) => x.id === 'other')].filter(Boolean);
        await saveSettings({ categories: next });
        closeModal();
        toast(existing ? 'Category saved' : `Created ${c.name}`);
      }, { cls: 'primary' }),
    ],
  });
}

// ---------- activity ----------

function renderActivity() {
  const batches = S.history;
  const body = [];
  if (!batches.length) {
    body.push(h('div', { class: 'card empty' }, h('div', { class: 'clean-badge', style: { background: 'var(--accent-soft)', color: 'var(--accent)' } }, icon('activity', 26)),
      h('h3', { text: 'No activity yet' }), h('p', { text: 'Every file Inlet moves shows up here, and you can undo any of it.' })));
  }
  let lastDay = '';
  for (const b of batches) {
    const day = dayLabel(b.time);
    if (day !== lastDay) { body.push(h('div', { class: 'day-label' }, day)); lastDay = day; }
    const live = b.moves.filter((m) => !m.undone && !m.purged && !m.userMoved);
    const open = S.expanded.has(b.id);
    const shown = open ? b.moves : b.moves.slice(0, 5);
    const catsInBatch = [...new Set(b.moves.map((m) => cat(m.categoryId).name))];
    body.push(h('div', { class: 'card batch' },
      h('div', { class: 'batch-head' },
        h('div', { class: `trigger-icon ${isArchive(b) ? 'archive' : b.trigger}`, title: isArchive(b) ? 'Archived in Cleanup' : TRIGGER_TIPS[b.trigger] }, icon(isArchive(b) ? 'archive' : TRIGGERS[b.trigger]?.icon || 'hand', 15)),
        h('div', { class: 't' },
          h('div', { class: 'batch-title' }, batchTitle(b),
            (() => {
              const undoneN = b.moves.filter((m) => m.undone).length;
              const yoursN = b.moves.filter((m) => !m.undone && m.userMoved).length;
              return [
                undoneN > 0 && h('span', { class: 'pill' }, undoneN === b.moves.length ? 'Undone' : `${undoneN} undone`),
                yoursN > 0 && h('span', { class: 'pill', title: 'You moved these yourself afterwards, so Inlet won’t undo them' }, `${yoursN} moved by you`),
              ];
            })()),
          h('div', { class: 'batch-sub' }, b.trigger === 'cleanup'
            ? `${fmtTime(b.time)} · ${fmtBytes(b.moves.reduce((sum, m) => sum + (m.size || 0), 0))}${isArchive(b) ? ' moved to Old Downloads' : ''}`
            : `${fmtTime(b.time)} · ${catsInBatch.slice(0, 4).join(', ')}${catsInBatch.length > 4 ? '…' : ''}`)),
        live.length > 0 && button(live.length === b.moves.length ? 'Undo all' : `Undo ${live.length}`, () => undo(b.id), { cls: 'sm', iconName: 'undo', title: 'Put these files back where they were' })),
      h('div', { class: 'moves' }, shown.map((m) => h('div', { class: `move ${m.undone ? 'undone' : ''}` },
        h('span', { style: { color: cat(m.categoryId).color } }, icon(cat(m.categoryId).icon, 14)),
        h('span', { class: 'name', title: `${m.from} → ${m.to}` }, m.name),
        h('span', { class: 'faint', style: { fontSize: '12px' } }, moveStatus(m, b)),
        h('span', { class: 'acts' },
          !m.purged && iconButton('reveal', 'Show in Finder', () => api.reveal(m.undone ? m.from : m.userMoved?.to || m.to)),
          !m.undone && !m.purged && !m.userMoved && iconButton('undo', 'Undo this file', () => undo(b.id, m.id)))))),
      b.moves.length > 5 && h('button', { class: 'more-btn', onclick: () => { if (open) S.expanded.delete(b.id); else S.expanded.add(b.id); render(); } },
        open ? 'Show less' : `Show ${b.moves.length - 5} more`)));
  }
  return {
    sub: 'Everything Inlet has moved or removed. Undo puts files back exactly where they were. Shortcut: ⌘Z.',
    actions: batches.length ? [
      S.st.lastUndoable && button('Undo last', () => undoLast(), { iconName: 'undo', title: 'Undo the most recent action (⌘Z)' }),
      button('Clear history', () => openModal({
      title: 'Clear activity history?',
      sub: S.st.holding.count
        ? `Your sorted files stay where they are. The ${plural(S.st.holding.count, 'removed file')} waiting in Inlet's holding area will go to the macOS Trash. You won’t be able to undo any of this from Inlet.`
        : 'Your files stay where they are. You just won’t be able to undo these moves any more.',
      foot: [button('Cancel', closeModal, { cls: 'ghost' }), button('Clear history', async () => {
        await api.clearHistory(); S.history = []; closeModal(); render();
      }, { cls: 'primary' })],
    }), { cls: 'ghost' })] : [],
    body,
  };
}

const TRIGGERS = {
  manual: { icon: 'hand', verb: 'Tidied' },
  auto: { icon: 'bolt', verb: 'Auto-sorted' },
  scheduled: { icon: 'activity', verb: 'Scheduled tidy ·' },
  cleanup: { icon: 'trash', verb: 'Cleaned up' },
};
const isArchive = (b) => b.trigger === 'cleanup' && b.moves.every((m) => m.kind !== 'remove');
function batchTitle(b) {
  if (b.trigger === 'cleanup') {
    const removed = b.moves.filter((m) => m.kind === 'remove').length;
    return removed ? `Removed ${plural(removed, 'file')}` : `Archived ${plural(b.moves.length, 'file')}`;
  }
  return `${(TRIGGERS[b.trigger] || TRIGGERS.manual).verb} ${plural(b.moves.length, 'file')}`;
}
function moveStatus(m, b) {
  if (m.undone) return 'put back';
  if (m.purged) return 'in the macOS Trash (use Put Back in Finder)';
  if (m.userMoved) {
    if (m.userMoved.returned) return 'you moved it back — Inlet leaves it there';
    if (!m.userMoved.to) return 'you moved or deleted it';
    return `you moved it to ${relPath(m.userMoved.to.slice(0, m.userMoved.to.lastIndexOf('/')))}`;
  }
  if (m.kind === 'remove') {
    const until = new Date(b.time + S.st.settings.retentionDays * 86400000);
    return `removed · undo until ${until.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  }
  return `→ ${relPath(m.to.slice(0, m.to.lastIndexOf('/')))}${m.originalName ? ` (was ${m.originalName})` : ''}`;
}

async function undoLast() {
  const res = await api.undoLast();
  if (res.nothing) { toast('Nothing to undo'); return; }
  if (res.restored.length) toast(`Undid ${TRIGGERS[res.trigger] ? batchVerb(res.trigger) : 'last action'} · ${plural(res.restored.length, 'file')} put back`);
  if (res.failed.length) toast(res.failed[0].message, { error: true });
  S.history = await api.getHistory();
  await refreshScan(true);
  render();
}
const batchVerb = (t) => ({ manual: 'tidy', auto: 'auto-sort', scheduled: 'scheduled tidy', cleanup: 'cleanup' }[t]);

// ---------- suggestions ----------

function suggestionCard(sg, more = 0) {
  const c = cat(sg.categoryId);
  return h('div', { class: 'card suggestion' },
    h('div', { class: 'sg-icon', title: 'Suggested from files you moved by hand' }, icon('sparkle', 16)),
    h('div', { class: 't' },
      h('div', { class: 'sg-title' }, sg.title),
      h('div', { class: 'sg-detail' }, sg.detail, sg.examples.length > 0 && [' For example ', sg.examples.map((e, i) => [i ? ', ' : '', h('span', { class: 'mono' }, e)])]),
      more > 0 && h('button', { class: 'link-btn', onclick: () => navigate('rules') }, `${plural(more, 'more suggestion')} in Rules`)),
    h('div', { class: 'inline' },
      button('Not now', () => dismissSuggestion(sg), { cls: 'ghost sm' }),
      button(sg.kind === 'extension' ? `Add to ${c.name}` : 'Create rule', () => acceptSuggestion(sg), { cls: 'primary sm', iconName: 'check' })));
}

async function acceptSuggestion(sg) {
  const res = await api.applySuggestion(sg.id);
  if (res.error) { toast(res.error, { error: true }); return; }
  S.st = res.state;
  await refreshScan(true);
  render();
  toast(sg.kind === 'extension' ? `.${sg.apply.ext} files now go to ${cat(sg.categoryId).name}` : 'Rule created', {
    action: { label: 'Undo', fn: async () => { await saveSettings(res.previous); toast('Suggestion undone'); } },
  });
}

async function dismissSuggestion(sg) {
  S.st = await api.dismissSuggestion(sg.id);
  render();
}

// ---------- cleanup ----------

async function loadCleanup(force) {
  const tab = S.cleanupTab;
  if (!force && (tab === 'stale' ? S.stale : S.dupes)) return;
  S.cleanupLoading = true;
  render();
  try {
    if (tab === 'stale') {
      S.stale = await api.findStale(S.staleDays || S.st.settings.staleDays);
      S.cleanupDeselected.clear();
    } else {
      S.dupes = await api.findDuplicates();
      S.keepers = {};
    }
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    S.cleanupLoading = false;
    render();
  }
}

async function applyCleanup(action, paths, source) {
  const run = async () => {
    const batch = await api.applyCleanup({ action, paths, source });
    const gone = new Set(batch.moves.map((m) => m.from));
    if (S.stale) S.stale = S.stale.filter((f) => !gone.has(f.path));
    if (S.dupes) S.dupes = S.dupes.map((g) => ({ ...g, files: g.files.filter((f) => !gone.has(f.path)) })).filter((g) => g.files.length > 1);
    render();
    const n = batch.moves.length;
    toast(action === 'archive' ? `Archived ${plural(n, 'file')} to Old Downloads` : `Removed ${plural(n, 'file')}`, {
      action: { label: 'Undo', fn: async () => { await undo(batch.id); S.stale = null; S.dupes = null; loadCleanup(true); } },
      ms: 8000,
    });
    if (batch.errors.length) toast(`${plural(batch.errors.length, 'file')} couldn't be moved`, { error: true });
  };
  if (action !== 'remove') return run();
  const bytes = [...(S.stale || []), ...(S.dupes || []).flatMap((g) => g.files.map((f) => ({ ...f, size: g.size })))]
    .filter((f) => paths.includes(f.path)).reduce((sum, f) => sum + (f.size || 0), 0);
  openModal({
    title: `Remove ${plural(paths.length, 'file')}?`,
    sub: `${fmtBytes(bytes)} will be moved to Inlet's holding area. You can undo from Activity (or ⌘Z) for the next ${S.st.settings.retentionDays} days — after that they go to the macOS Trash.`,
    foot: [button('Cancel', closeModal, { cls: 'ghost' }), button('Remove', async () => { closeModal(); await run(); }, { cls: 'primary', iconName: 'trash' })],
  });
}

function confirmEmptyHolding() {
  const { count, bytes } = S.st.holding;
  openModal({
    title: 'Empty the holding area?',
    sub: `${plural(count, 'file')} (${fmtBytes(bytes)}) will go to the macOS Trash. Inlet won't be able to undo them any more, but Finder's Put Back still works until you empty the Trash.`,
    foot: [button('Cancel', closeModal, { cls: 'ghost' }), button('Move to Trash', async () => {
      closeModal(); await api.emptyHolding(); S.history = await api.getHistory(); render(); toast('Sent to the macOS Trash');
    }, { cls: 'primary' })],
  });
}

function cleanupThumb(f) {
  return h('div', { class: 'thumb', 'data-path': f.path }, catIcon(PSEUDO.old, 15));
}

function renderCleanup() {
  const tab = S.cleanupTab;
  const tabs = segmented([['stale', 'Old files'], ['dupes', 'Duplicates']], tab, (v) => { S.cleanupTab = v; render(); loadCleanup(false); });
  const { count: hCount, bytes: hBytes } = S.st.holding;
  const holdingNote = h('div', { class: 'card holding-note' }, icon('shield', 18),
    h('div', { style: { flex: 1 } },
      h('b', {}, 'Nothing is deleted straight away. '),
      `Removed files wait in a hidden holding folder for ${S.st.settings.retentionDays} days, so you can undo from Activity or with ⌘Z. Then they go to the macOS Trash.`,
      hCount > 0 && h('span', { class: 'faint' }, ` Holding ${plural(hCount, 'file')} · ${fmtBytes(hBytes)}.`)),
    hCount > 0 && button('Empty now', () => confirmEmptyHolding(), { cls: 'sm ghost' }));

  let content;
  if (S.cleanupLoading) {
    content = h('div', { class: 'card empty' }, h('div', { class: 'spinner', style: { margin: '0 auto 14px', color: 'var(--accent)', width: '22px', height: '22px' } }),
      h('h3', {}, tab === 'stale' ? 'Checking when files were last opened…' : 'Comparing files…'),
      h('p', {}, tab === 'stale' ? 'Looking through Downloads and Inlet’s folders.' : 'Files with the same size are compared byte for byte.'));
  } else if (tab === 'stale') {
    content = renderStale();
  } else {
    content = renderDupes();
  }
  return {
    sub: 'Find files you’re done with. Archive them out of the way, or remove them — everything here can be undone.',
    actions: [button('Rescan', () => loadCleanup(true), { iconName: 'search', disabled: S.cleanupLoading, title: 'Check again for old files and duplicates' })],
    body: [h('div', { class: 'toolbar' }, tabs), holdingNote, content],
  };
}

function renderStale() {
  const files = S.stale || [];
  const days = S.staleDays || S.st.settings.staleDays;
  const picker = select([['30', '30 days'], ['60', '60 days'], ['90', '90 days'], ['180', '6 months'], ['365', '1 year']], String(days), (v) => {
    S.staleDays = Number(v);
    api.updateSettings({ staleDays: Number(v) }).then((st) => { S.st = st; });
    loadCleanup(true);
  });
  const head = h('div', { class: 'inline muted' }, 'Show files not opened or changed in', picker);
  if (!files.length) {
    return h('div', {}, head, h('div', { class: 'card empty', style: { marginTop: '14px' } }, h('div', { class: 'clean-badge' }, icon('sparkle', 28)),
      h('h3', {}, 'Nothing stale'), h('p', {}, `Every file has been used in the last ${days} days.`)));
  }
  const selected = files.filter((f) => !S.cleanupDeselected.has(f.path));
  const selBytes = selected.reduce((sum, f) => sum + f.size, 0);
  const allOn = selected.length === files.length;
  const list = h('div', { class: 'card file-list', style: { marginTop: '14px' } },
    h('div', { class: 'file-head' },
      h('input', { type: 'checkbox', class: 'checkbox', checked: allOn, 'aria-label': 'Select all', onchange: (e) => {
        if (e.target.checked) S.cleanupDeselected.clear(); else files.forEach((f) => S.cleanupDeselected.add(f.path));
        render();
      } }),
      h('span'), h('span', {}, `${plural(files.length, 'file')} · ${fmtBytes(files.reduce((x, f) => x + f.size, 0))}`), h('span', {}, 'Where'), h('span', {}, 'Last used'), h('span')),
    files.map((f) => {
      const on = !S.cleanupDeselected.has(f.path);
      return h('div', { class: `file-row ${on ? '' : 'off'}` },
        h('input', { type: 'checkbox', class: 'checkbox', checked: on, 'aria-label': `Include ${f.name}`, onchange: (e) => {
          if (e.target.checked) S.cleanupDeselected.delete(f.path); else S.cleanupDeselected.add(f.path);
          render();
        } }),
        cleanupThumb(f),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'file-name', title: f.name, ondblclick: () => api.openPath(f.path) }, f.name),
          h('div', { class: 'file-meta' }, fmtBytes(f.size))),
        h('div', { class: 'reason', title: f.folder || 'Downloads' }, icon('folder', 12), ' ', f.folder || 'Downloads'),
        h('div', { class: 'reason' }, `${f.opened ? 'Opened' : 'Added'} ${fmtAgo(f.lastUsedMs)}`),
        h('div', { class: 'row-actions' }, iconButton('reveal', 'Show in Finder', () => api.reveal(f.path))));
    }));
  const bar = h('div', { class: 'sticky-bar' },
    h('div', {}, h('b', {}, `${selected.length.toLocaleString()} of ${plural(files.length, 'file')}`), h('span', { class: 'muted' }, ` selected · ${fmtBytes(selBytes)}`)),
    h('div', { class: 'inline' },
      button('Archive', () => applyCleanup('archive', selected.map((f) => f.path), 'stale'), { iconName: 'archive', disabled: !selected.length, title: 'Move to Downloads/Old Downloads' }),
      button('Remove', () => applyCleanup('remove', selected.map((f) => f.path), 'stale'), { cls: 'primary', iconName: 'trash', disabled: !selected.length })));
  return h('div', {}, head, list, bar);
}

function renderDupes() {
  const groups = S.dupes || [];
  if (!groups.length) {
    return h('div', { class: 'card empty' }, h('div', { class: 'clean-badge' }, icon('sparkle', 28)),
      h('h3', {}, 'No duplicates'), h('p', {}, 'No two files in Downloads or Inlet’s folders have identical contents.'));
  }
  const keeperOf = (g) => S.keepers[g.hash] || g.files[0].path;
  const toRemove = groups.flatMap((g) => g.files.filter((f) => f.path !== keeperOf(g)).map((f) => f.path));
  const freed = groups.reduce((sum, g) => sum + g.size * (g.files.length - 1), 0);
  const cards = groups.map((g) => h('div', { class: 'card file-list dupe-group' },
    h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, `${g.files.length} identical copies`), h('div', { class: 'muted', style: { fontSize: '12px' } }, `${fmtBytes(g.size)} each · removing the extras frees ${fmtBytes(g.size * (g.files.length - 1))}`))),
    g.files.map((f) => {
      const keep = f.path === keeperOf(g);
      return h('div', { class: `file-row ${keep ? '' : 'off'}` },
        h('input', { type: 'radio', class: 'checkbox', name: g.hash, checked: keep, 'aria-label': `Keep ${f.name}`, title: 'Keep this copy', onchange: () => { S.keepers[g.hash] = f.path; render(); } }),
        cleanupThumb(f),
        h('div', { style: { minWidth: 0 } }, h('div', { class: 'file-name', title: f.name }, f.name), h('div', { class: 'file-meta' }, `Added ${fmtAgo(f.addedMs)}`)),
        h('div', { class: 'reason', title: f.folder || 'Downloads' }, icon('folder', 12), ' ', f.folder || 'Downloads'),
        h('div', {}, keep ? h('span', { class: 'pill accent' }, 'Keep') : h('span', { class: 'pill' }, 'Remove')),
        h('div', { class: 'row-actions' }, iconButton('reveal', 'Show in Finder', () => api.reveal(f.path))));
    })));
  const bar = h('div', { class: 'sticky-bar' },
    h('div', {}, h('b', {}, plural(toRemove.length, 'extra copy').replace('copys', 'copies')), h('span', { class: 'muted' }, ` in ${plural(groups.length, 'group')} · frees ${fmtBytes(freed)}`)),
    button(`Remove ${plural(toRemove.length, 'copy').replace('copys', 'copies')}`, () => applyCleanup('remove', toRemove, 'duplicates'), { cls: 'primary', iconName: 'trash', disabled: !toRemove.length }));
  return h('div', {}, h('p', { class: 'muted', style: { marginBottom: '12px' } }, 'Pick the copy to keep in each group. The rest are removed (and can be undone).'),
    h('div', { style: { display: 'grid', gap: '12px' } }, cards), bar);
}

// ---------- settings ----------

function renderSettings() {
  const s = S.st.settings;
  const row = (label, desc, control) => h('div', { class: 'setting' },
    h('div', { class: 't' }, h('div', { class: 'label' }, label), desc && h('div', { class: 'desc' }, desc)),
    h('div', { class: 'control' }, control));
  const group = (title, ...rows) => [h('div', { class: 'group-title' }, title), h('div', { class: 'card settings-group' }, rows)];

  const ignoreChips = h('div', { class: 'chips', style: { justifyContent: 'flex-end', maxWidth: '360px' } },
    s.ignorePatterns.map((p) => h('span', { class: 'chip' }, p, h('button', { 'aria-label': `Remove ${p}`, title: `Stop ignoring ${p}`, onclick: () => saveSettings({ ignorePatterns: s.ignorePatterns.filter((x) => x !== p) }) }, icon('x', 10)))),
    h('input', { class: 'chip-input wide', placeholder: '+ pattern', 'aria-label': 'Add ignore pattern', onkeydown: (e) => {
      if (e.key === 'Enter' && e.target.value.trim()) saveSettings({ ignorePatterns: [...new Set([...s.ignorePatterns, e.target.value.trim()])] });
    } }));

  return {
    sub: 'Inlet only ever moves files. It never deletes anything, and never overwrites.',
    actions: [],
    body: [
      h('div', {}, ...group('Watched folders', ...folderRows())),
      h('div', {}, ...group('General',
        row('Launch at login', 'Start Inlet quietly in the menu bar when you log in. Takes effect in the installed app.', toggle(s.launchAtLogin, (v) => saveSettings({ launchAtLogin: v }))),
        row('Show in Dock', 'Turn off to keep Inlet in the menu bar only.', toggle(s.showDockIcon, (v) => saveSettings({ showDockIcon: v }))),
        row('Notifications', 'Get a notification when Auto mode sorts something.', toggle(s.notifications, (v) => saveSettings({ notifications: v }))))),
      h('div', {}, ...group('Auto mode',
        row('Wait before sorting', 'Extra time after a file stops changing, in case you want to open it first.',
          select([...new Map([[3, '3 seconds'], [5, '5 seconds'], [10, '10 seconds'], [30, '30 seconds'], [60, '1 minute'], [300, '5 minutes'], [s.autoDelaySec, `${s.autoDelaySec} seconds`]])]
            .sort((a, b) => a[0] - b[0]).map(([v, l]) => [String(v), l]), String(s.autoDelaySec), (v) => saveSettings({ autoDelaySec: Number(v) }))))),
      h('div', {}, ...group('Schedule',
        row('Inlet on a schedule', S.st.nextScheduled ? `Next run ${fmtWhen(S.st.nextScheduled)}. Works in Manual mode too, as a daily sweep.` : 'Sort everything in Downloads at a set time. A middle ground between Manual and Auto.',
          toggle(s.schedule.enabled, (v) => saveSettings({ schedule: { enabled: v } }))),
        s.schedule.enabled && row('Time', 'If your Mac is asleep then, Inlet runs when it wakes (same day).',
          h('input', { class: 'input', type: 'time', value: s.schedule.time, style: { width: '120px' }, onchange: (e) => e.target.value && saveSettings({ schedule: { time: e.target.value } }) })),
        s.schedule.enabled && row('Days', null, h('div', { class: 'segmented' }, ['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => h('button', {
          class: s.schedule.days.includes(i) ? 'on' : '',
          title: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i],
          onclick: () => saveSettings({ schedule: { days: s.schedule.days.includes(i) ? s.schedule.days.filter((x) => x !== i) : [...s.schedule.days, i].sort() } }),
        }, d)))))),
      h('div', {}, ...group('Removed files',
        row('Keep removed files for', 'Files you remove in Cleanup wait in a hidden holding folder so you can undo. After this, they go to the macOS Trash.',
          select([['7', '7 days'], ['30', '30 days'], ['90', '90 days']], String(s.retentionDays), (v) => saveSettings({ retentionDays: Number(v) }))),
        row('Holding area', S.st.holding.count ? `${plural(S.st.holding.count, 'file')} · ${fmtBytes(S.st.holding.bytes)} waiting. Emptying sends them to the macOS Trash — Inlet can no longer undo them.` : 'Empty.',
          button('Empty now', () => confirmEmptyHolding(), { cls: 'sm', disabled: !S.st.holding.count })))),
      h('div', {}, ...group('Sorting',
        row('Date subfolders', 'Group files inside each category by the date they were downloaded.',
          segmented([['none', 'None'], ['year', 'Year'], ['year-month', 'Year-Month']], s.dateSubfolders, (v) => saveSettings({ dateSubfolders: v }))),
        row('Unknown file types', 'Files no category claims.',
          segmented([['other', 'Move to Other'], ['leave', 'Leave them']], s.unknownFiles, (v) => saveSettings({ unknownFiles: v }))),
        row('Folders in Downloads', 'Folders are often projects or unzipped archives, so Inlet leaves them alone by default.',
          segmented([['skip', 'Leave them'], ['move', 'Move to Folders']], s.folderPolicy, (v) => saveSettings({ folderPolicy: v }))),
        row('Ignore', 'Files matching these patterns are never moved. Use * as a wildcard.', ignoreChips))),
      h('div', {}, ...group('Rules on other Macs', ...shareRows())),
      h('div', {}, ...group('Help',
        row('Take the tour', 'A quick walk through each part of Inlet. Also in the Help menu.',
          button('Start tour', () => startTour(), { cls: 'sm', iconName: 'sparkle' })))),
      h('div', {}, ...group('Reset',
        row('Restore defaults', 'Resets categories, rules and settings. Your files and activity history are kept.',
          button('Restore defaults', () => openModal({
            title: 'Restore default settings?',
            sub: 'Your custom rules and category changes will be lost.',
            foot: [button('Cancel', closeModal, { cls: 'ghost' }), button('Restore defaults', async () => {
              S.st = await api.resetSettings(); closeModal(); await refreshScan(true); render(); toast('Defaults restored');
            }, { cls: 'primary' })],
          }), { cls: 'danger sm' })))),
      h('p', { class: 'faint', style: { textAlign: 'center', fontSize: '12px', paddingTop: '8px' } }, `Inlet ${S.st.version} · `,
        h('button', { class: 'link-btn', onclick: () => showWhatsNew(S.st.changelog, false) }, 'What’s new')),
    ],
  };
}

function folderRows() {
  const primaryName = (S.st.folders || [])[0]?.label || 'Downloads';
  const errors = new Map((S.st.scanErrors || []).map((e) => [e.folderId, e.error]));
  const rows = (S.st.folders || []).map((f) => h('div', { class: 'setting folder-row' },
    h('div', { class: 'cat-icon', title: f.primary ? 'Main folder: sorted files go into folders here' : 'Also watched by Inlet', style: { '--c': f.primary ? '#3d63f5' : '#30D158' } }, icon(f.primary ? 'inbox' : 'folder', 16)),
    h('div', { class: 't', style: { flex: 1 } },
      h('div', { class: 'label' }, f.label, f.primary && h('span', { class: 'pill', style: { marginLeft: '8px' } }, 'Main')),
      h('div', { class: 'desc mono-path', title: f.path }, f.path.replace(/^\/Users\/[^/]+/, '~')),
      errors.get(f.id) && h('div', { class: 'desc', style: { color: 'var(--danger)' } },
        errors.get(f.id) === 'permission' ? 'Inlet doesn’t have permission to read this folder. Allow it in System Settings → Privacy & Security → Files and Folders.' : errors.get(f.id))),
    h('div', { class: 'control' },
      f.primary
        ? button('Change…', async () => { const p = await api.pickFolder(f.path); if (p) saveSettings({ watchDir: p }); }, { cls: 'sm' })
        : [
          select([['self', `Sort inside ${f.label}`], ['primary', `Sort into ${primaryName}’s folders`]], f.sortInto, async (v) => { S.st = await api.updateFolder({ id: f.id, patch: { sortInto: v } }); await refreshScan(true); render(); }),
          select([['inherit', `Mode: same as Inlet (${S.st.settings.mode})`], ['auto', 'Mode: always Auto'], ['manual', 'Mode: always Manual']], f.mode || 'inherit',
            async (v) => { S.st = await api.updateFolder({ id: f.id, patch: { mode: v } }); render(); toast(`${f.label}: ${v === 'inherit' ? `follows Inlet’s mode` : `always ${v}`}`); }),
          toggle(f.enabled !== false, async (v) => { S.st = await api.updateFolder({ id: f.id, patch: { enabled: v } }); await refreshScan(true); render(); }, `Watch ${f.label}`),
          iconButton('trash', `Stop watching ${f.label}`, async () => { S.st = await api.removeFolder(f.id); await refreshScan(true); render(); toast(`Stopped watching ${f.label} — its files stay where they are`); }, 'danger'),
        ])));

  const suggestions = h('div', { class: 'inline', style: { flexWrap: 'wrap' } });
  api.suggestFolders().then((list) => suggestions.replaceChildren(...list.map((sg) => button(`Add ${sg.label}`, () => addFolder(sg.path), { cls: 'sm', iconName: 'plus', title: sg.why }))));
  rows.push(h('div', { class: 'setting' },
    h('div', { class: 't' }, h('div', { class: 'label' }, 'Watch another folder'),
      h('div', { class: 'desc' }, 'Keep Desktop or a screenshots folder tidy too. Mode, rules and categories apply to every folder.')),
    h('div', { class: 'control' }, suggestions, button('Choose…', async () => { const p = await api.pickFolder(); if (p) addFolder(p); }, { cls: 'sm' }))));
  return rows;
}

async function addFolder(p) {
  const res = await api.addFolder(p);
  if (res.error) { toast(res.error, { error: true }); return; }
  S.st = res.state;
  await refreshScan(true);
  render();
  const f = S.st.folders[S.st.folders.length - 1];
  toast(S.st.settings.mode === 'auto' ? `Watching ${f.label} — new files there will be sorted` : `Added ${f.label} — its files now show in Organize`);
}

function shareRows() {
  const s = S.st.settings;
  const syncing = !!s.syncFile;
  return [
    h('div', { class: 'setting' },
      h('div', { class: 't' }, h('div', { class: 'label' }, 'Export or import'),
        h('div', { class: 'desc' }, 'Save your categories and rules to a file, or load them from one. Folder paths stay on this Mac.')),
      h('div', { class: 'control' },
        button('Export…', async () => { const r = await api.exportRules(); if (r.path) toast(`Saved ${r.path.split('/').pop()}`); }, { cls: 'sm' }),
        button('Import…', () => importRules(), { cls: 'sm' }))),
    h('div', { class: 'setting' },
      h('div', { class: 't' }, h('div', { class: 'label' }, 'Keep rules in sync'),
        h('div', { class: 'desc' }, syncing
          ? [h('span', { class: 'mono' }, s.syncFile.replace(/^\/Users\/[^/]+/, '~').replace('/Library/Mobile Documents/com~apple~CloudDocs', '/iCloud Drive')),
            s.syncUpdatedAt ? ` · last synced ${fmtAgo(s.syncUpdatedAt)}` : '']
          : 'Share one set of rules between your Macs through a folder that syncs, like iCloud Drive. No account needed.'),
        s.syncError && h('div', { class: 'desc', style: { color: 'var(--danger)' } }, s.syncError)),
      h('div', { class: 'control' }, syncing
        ? button('Stop syncing', async () => { S.st = await api.setSync({ file: '' }); render(); toast('Rules are no longer synced — they stay as they are'); }, { cls: 'sm' })
        : button('Set up…', () => setUpSync(), { cls: 'sm', iconName: 'globe' }))),
  ];
}

async function importRules() {
  const pick = await api.pickImport();
  if (pick.canceled) return;
  if (pick.error) { toast(pick.error, { error: true }); return; }
  openModal({
    title: 'Replace your rules?',
    sub: `This file has ${plural(pick.summary.categories, 'category')} and ${plural(pick.summary.rules, 'rule').replace('rules', 'rules')}. They’ll replace yours on this Mac — you can undo right after.`.replace('categorys', 'categories'),
    foot: [button('Cancel', closeModal, { cls: 'ghost' }), button('Import', async () => {
      closeModal();
      const res = await api.applyImport(pick.path);
      if (res.error) { toast(res.error, { error: true }); return; }
      S.st = res.state; await refreshScan(true); render();
      toast('Rules imported', { action: { label: 'Undo', fn: async () => { await saveSettings(res.previous); toast('Import undone'); } } });
    }, { cls: 'primary' })],
  });
}

async function setUpSync() {
  const pick = await api.pickSyncFolder();
  if (pick.canceled) return;
  const start = async (prefer) => {
    closeModal();
    S.st = await api.setSync({ file: pick.path, prefer });
    await refreshScan(true); render();
    toast(prefer === 'file' ? 'Using the synced rules' : 'Syncing — other Macs can now use this Mac’s rules');
  };
  if (!pick.exists) { await start('mine'); return; }
  if (pick.error) { toast(pick.error, { error: true }); return; }
  openModal({
    title: 'This folder already has Inlet rules',
    sub: `Saved ${pick.updatedAt ? fmtAgo(pick.updatedAt) : 'earlier'} with ${plural(pick.summary.rules, 'rule')}. Which rules should both Macs use?`,
    foot: [button('Cancel', closeModal, { cls: 'ghost' }),
      button('Use this Mac’s rules', () => start('mine')),
      button('Use the synced rules', () => start('file'), { cls: 'primary' })],
  });
}

function showWhatsNew(entries, markSeen = true) {
  if (!entries || !entries.length) return;
  openModal({
    cls: 'whatsnew',
    title: markSeen ? `What’s new in Inlet ${S.st.version}` : 'Release notes',
    body: entries.map((e) => h('div', { class: 'release' },
      h('div', { class: 'release-head' }, h('span', { class: 'pill accent' }, e.version), h('b', {}, e.title)),
      h('ul', {}, e.items.map((i) => h('li', {}, i))))),
    foot: [button(markSeen ? 'Got it' : 'Close', async () => { closeModal(); if (markSeen) S.st = await api.markWhatsNewSeen(); }, { cls: 'primary' })],
  });
}

// ---------- welcome ----------

function showWelcome() {
  let mode = 'manual';
  const tiles = h('div', { class: 'mode-tiles' });
  const draw = () => tiles.replaceChildren(
    ...[['manual', 'hand', 'Manual', 'Preview, then tidy with one click.'], ['auto', 'bolt', 'Auto', 'Sort every new download as it lands.']]
      .map(([m, ic, t, d]) => h('button', { class: `mode-tile ${mode === m ? 'on' : ''}`, onclick: () => { mode = m; draw(); } },
        h('span', { class: 'tile-icon' }, icon(ic, 18)), h('span', { class: 'check' }, icon('check', 12)), h('h3', {}, t), h('p', {}, d))));
  draw();
  const mark = h('div', { class: 'brand-mark' }, icon('inbox', 32));
  const modal = openModal({
    cls: 'welcome',
    body: [
      h('div', { class: 'welcome-hero' }, mark, h('h2', {}, 'Welcome to Inlet'),
        h('p', {}, S.st.unsorted
          ? `Your Downloads folder has ${plural(S.st.unsorted, 'file')} (${fmtBytes(S.st.unsortedBytes)}) that could be sorted into neat folders.`
          : 'Inlet keeps your Downloads folder clean by sorting files into neat folders.')),
      h('div', { class: 'promises' },
        h('div', { class: 'promise' }, h('b', {}, icon('shield', 14), 'Never deletes'), 'Files are only ever moved, and name clashes get renamed.'),
        h('div', { class: 'promise' }, h('b', {}, icon('undo', 14), 'Always undoable'), 'Every move is logged. Put anything back in one click.'),
        h('div', { class: 'promise' }, h('b', {}, icon('folder', 14), 'Leaves folders alone'), 'Your project folders and half-finished downloads are skipped.')),
      h('div', { class: 'field' }, h('label', {}, 'How should Inlet work?'), tiles),
    ],
    foot: [h('span', { class: 'left faint' }, 'You can switch modes any time from the sidebar or menu bar.'),
      button('Get started', async () => {
        closeModal();
        await saveSettings({ onboarded: true, mode });
        if (!S.st.settings.tourDone) startTour();
        else if (mode === 'manual' && S.st.unsorted) navigate('organize');
      }, { cls: 'primary large' })],
  });
  modal.querySelector('.modal-body').style.paddingTop = '0';
}

// ---------- boot ----------

async function boot() {
  $('brand-mark').append(icon('inbox', 19));
  S.st = await api.getState();
  await refreshScan(true);
  render();
  if (!S.st.settings.onboarded) showWelcome();
  else if (S.st.whatsNew && S.st.whatsNew.length) showWhatsNew(S.st.whatsNew);
  // Set up but never finished the tour (e.g. quit halfway): pick it up again once any modal is closed.
  if (S.st.settings.onboarded && !S.st.settings.tourDone) startTour();
  api.onMenuTour(() => { closeModal(); startTour(); });
  api.onSyncApplied((summary) => toast(`Rules updated from another Mac (${plural(summary.rules, 'rule')})`));

  api.onStateChanged(async (st) => {
    S.st = st;
    await refreshScan();
    if (S.page === 'activity') S.history = await api.getHistory();
    // Don't yank the UI from under someone typing in a modal or input.
    const typing = document.activeElement && ['INPUT', 'SELECT'].includes(document.activeElement.tagName);
    if (!typing) render(); else renderChrome();
  });
  api.onNavigate((page) => { closeModal(); navigate(page); });
  // ⌘Z: undo typing inside a text field, otherwise undo Inlet's last action.
  api.onMenuUndo(() => {
    const el = document.activeElement;
    if (el && ['INPUT', 'TEXTAREA'].includes(el.tagName) && !['checkbox', 'radio'].includes(el.type)) document.execCommand('undo');
    else if (!$('modal').children.length) undoLast();
  });
}

boot();
