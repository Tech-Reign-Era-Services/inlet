'use strict';

(() => {
  const REPO = 'Tech-Reign-Era-Services/inlet';

  // Point every download button straight at the latest .pkg, and show its version and size.
  // Without JS (or if GitHub's API is unavailable) the buttons still go to the Releases page.
  async function loadRelease() {
    try {
      const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
      if (!res.ok) return;
      const release = await res.json();
      const pkg = (release.assets || []).find((a) => a.name.endsWith('.pkg'));
      if (!pkg) return;
      const version = release.tag_name.replace(/^v/, '');
      const mb = Math.round(pkg.size / 1048576);
      document.querySelectorAll('[data-download]').forEach((a) => { a.href = pkg.browser_download_url; });
      document.querySelectorAll('[data-pkg-name]').forEach((el) => { el.textContent = pkg.name; });
      document.querySelectorAll('[data-release-meta]').forEach((el) => {
        el.textContent = `Free · Version ${version} · ${mb} MB · Apple silicon and Intel · macOS 13 or later`;
      });
    } catch { /* keep the Releases page links */ }
  }

  // Phones, tablets and other computers can't run Inlet: say so instead of starting a download.
  function flagNonMac() {
    const ua = navigator.userAgent;
    const isMac = /Macintosh/.test(ua) && navigator.maxTouchPoints <= 1; // iPads also say Macintosh, but have touch
    if (isMac) return;
    const note = document.querySelector('.not-mac');
    if (note) note.hidden = false;
    const btn = document.querySelector('[data-copy-link]');
    if (btn && navigator.clipboard) {
      btn.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(location.href.split('#')[0]); btn.textContent = 'link copied'; } catch { /* ignore */ }
      });
    } else if (btn) {
      btn.replaceWith(document.createTextNode('share this page to yourself'));
    }
  }

  function navShadow() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    const update = () => nav.classList.toggle('scrolled', window.scrollY > 8);
    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  // The Find demo types example searches and shows what Inlet would understand.
  const EXAMPLES = [
    {
      q: 'pdfs from github last week',
      chips: ['.pdf', 'from github.com', 'last week'],
      results: [['doc', 'api-reference.pdf', 'PDF · from github.com · 3 days ago'], ['doc', 'release-notes.pdf', 'PDF · from github.com · 5 days ago']],
    },
    {
      q: 'big videos I haven’t opened in a month',
      chips: ['videos', 'over 50 MB', 'not opened in 30 days'],
      results: [['video', 'screen-recording.mov', 'Video · 1.2 GB · last opened in July'], ['video', 'webinar-final.mp4', 'Video · 640 MB · never opened']],
    },
    {
      q: 'the contract I signed in July',
      chips: ['“contract” or “signed”', 'July'],
      results: [['doc', 'Lease agreement - signed.pdf', '“signed” in the name · July 14'], ['doc', 'Freelance terms.docx', '“contract” in the text · July 3']],
    },
    {
      q: 'airdropped photos',
      chips: ['images', 'AirDrop'],
      results: [['image', 'IMG_4821.HEIC', 'Image · received with AirDrop'], ['image', 'IMG_4822.HEIC', 'Image · received with AirDrop'], ['image', 'beach.jpg', 'Image · received with AirDrop']],
    },
    {
      q: 'spreadsheets from this year',
      chips: ['spreadsheets', 'this year'],
      results: [['sheet', 'budget-2026.xlsx', 'Spreadsheet · March 2'], ['sheet', 'team-roster.numbers', 'Spreadsheet · January 19']],
    },
  ];

  function findDemo() {
    const text = document.querySelector('[data-find-text]');
    const chips = document.querySelector('[data-find-chips]');
    const results = document.querySelector('[data-find-results]');
    const demo = document.querySelector('.find-demo');
    if (!text || !chips || !results || !demo) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const el = (tag, cls, content) => { const n = document.createElement(tag); if (cls) n.className = cls; if (content) n.textContent = content; return n; };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let visible = false;
    let running = false;

    function show(ex) {
      chips.replaceChildren(...ex.chips.map((c) => el('span', 'chip', c)));
      results.replaceChildren(...ex.results.map(([kind, name, why]) => {
        const li = el('li');
        li.append(el('span', `ficon ficon-${kind}`), el('span', 'fname', name), el('span', 'why', why));
        return li;
      }));
    }

    async function loop() {
      if (running) return;
      running = true;
      let i = 1;
      while (visible) {
        const ex = EXAMPLES[i % EXAMPLES.length];
        await wait(2600);
        if (!visible) break;
        for (let n = text.textContent.length; n >= 0; n--) { text.textContent = text.textContent.slice(0, n); await wait(18); }
        chips.replaceChildren();
        results.replaceChildren();
        for (let n = 1; n <= ex.q.length; n++) { text.textContent = ex.q.slice(0, n); await wait(45); }
        await wait(250);
        show(ex);
        i++;
      }
      running = false;
    }

    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) loop();
    }, { threshold: 0.4 }).observe(demo);
  }

  // Looping videos (hero, Shelf): respect reduced motion, play only on screen, and give people a pause button.
  function loopVideo(video) {
    const toggle = video.parentElement.querySelector('[data-video-toggle]');
    if (!toggle) return;
    let userPaused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const sync = () => {
      toggle.classList.toggle('paused', video.paused);
      toggle.setAttribute('aria-label', video.paused ? 'Play video' : 'Pause video');
    };
    if (userPaused) { video.removeAttribute('autoplay'); video.pause(); }
    toggle.addEventListener('click', () => {
      if (video.paused) { userPaused = false; video.play().catch(() => {}); } else { userPaused = true; video.pause(); }
    });
    video.addEventListener('play', sync);
    video.addEventListener('pause', sync);
    new IntersectionObserver(([entry]) => {
      if (userPaused) return;
      if (entry.isIntersecting) video.play().catch(() => {}); else video.pause();
    }, { threshold: 0.25 }).observe(video);
    sync();
  }

  loadRelease();
  document.querySelectorAll('[data-hero-video], [data-loop-video]').forEach(loopVideo);
  flagNonMac();
  navShadow();
  findDemo();
})();
