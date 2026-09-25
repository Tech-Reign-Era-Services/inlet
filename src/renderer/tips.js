'use strict';

// Hover tooltips. Any element with a `title` (or `data-tip`) gets a styled tooltip instead of the slow
// native one. The title is moved to data-tip on first hover so macOS doesn't show both.
// Optional data-tip-pos="top|bottom|left|right" picks a side; it flips if there isn't room.
(() => {
  const DELAY = 350;
  const GAP = 8;
  let tipEl = null;
  let target = null;
  let timer = null;
  let watch = null;

  function el() {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.append(tipEl);
    }
    return tipEl;
  }

  function adopt(node) {
    const t = node.getAttribute('title');
    if (t) {
      node.dataset.tip = t;
      node.removeAttribute('title');
      // Icon-only controls still need a name for VoiceOver.
      if (!node.getAttribute('aria-label') && !node.textContent.trim()) node.setAttribute('aria-label', t);
    }
    return node.dataset.tip;
  }

  function place(node) {
    const tip = el();
    const r = node.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fits = {
      top: r.top - h - GAP > 4,
      bottom: r.bottom + h + GAP < vh - 4,
      right: r.right + w + GAP < vw - 4,
      left: r.left - w - GAP > 4,
    };
    const want = node.dataset.tipPos || (node.closest('.sidebar') ? 'right' : 'top');
    const order = { top: ['top', 'bottom'], bottom: ['bottom', 'top'], right: ['right', 'top', 'bottom'], left: ['left', 'top', 'bottom'] }[want] || ['top', 'bottom'];
    const side = order.find((s) => fits[s]) || 'bottom';
    let x;
    let y;
    if (side === 'top' || side === 'bottom') {
      x = r.left + r.width / 2 - w / 2;
      y = side === 'top' ? r.top - h - GAP : r.bottom + GAP;
    } else {
      x = side === 'right' ? r.right + GAP : r.left - w - GAP;
      y = r.top + r.height / 2 - h / 2;
    }
    x = Math.max(6, Math.min(x, vw - w - 6));
    y = Math.max(6, Math.min(y, vh - h - 6));
    tip.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    tip.dataset.side = side;
  }

  function show(node) {
    const text = node.dataset.tip;
    if (!text || !node.isConnected) return;
    const tip = el();
    tip.textContent = text;
    tip.classList.add('on');
    place(node);
    // The UI re-renders often; drop the tooltip if its element disappears underneath it.
    clearInterval(watch);
    watch = setInterval(() => { if (!node.isConnected) hide(); }, 200);
  }

  function hide() {
    clearTimeout(timer);
    clearInterval(watch);
    target = null;
    if (tipEl) tipEl.classList.remove('on');
  }

  document.addEventListener('mouseover', (e) => {
    const node = e.target.closest && e.target.closest('[title], [data-tip]');
    if (node === target) return;
    hide();
    if (!node || !adopt(node)) return;
    target = node;
    timer = setTimeout(() => show(node), DELAY);
  });
  document.addEventListener('mouseout', (e) => {
    if (target && !target.contains(e.relatedTarget)) hide();
  });
  for (const ev of ['mousedown', 'keydown', 'wheel', 'blur']) window.addEventListener(ev, hide, true);
  // Keyboard users get the same hint when tabbing onto a control.
  document.addEventListener('focusin', (e) => {
    const node = e.target.closest && e.target.closest('[title], [data-tip]');
    if (!node || !e.target.matches(':focus-visible') || !adopt(node)) return;
    target = node;
    show(node);
  });
  document.addEventListener('focusout', hide);
})();
