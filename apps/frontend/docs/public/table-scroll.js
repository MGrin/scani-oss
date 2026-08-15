// Reveals the scroll hint on tables that actually overflow, and keeps the
// keyboard affordance off the ones that don't.
//
// The edge fade in `custom.css` is pure CSS and needs nothing from here — it
// is what a reader with JS disabled gets. This adds the part CSS cannot know:
// how many columns are currently out of view. "Scroll sideways for 2 more
// columns" is the sentence a reader on a 390px screen was missing (SC-102);
// iOS hides overlay scrollbars at rest, so without it the only cue that the
// `Notes` column exists is swiping on the off-chance.
//
// It also strips `tabindex` / `role` / `aria-label` from a region that fits,
// because a scroll region that cannot scroll is a tab stop that leads nowhere.
// Markup ships with them present so the keyboard path survives without JS.

(() => {
  const WRAPPERS = '.table-scroll';

  /** @param {Element} viewport */
  function columnsOutOfView(viewport) {
    const edge = viewport.getBoundingClientRect().right;
    let count = 0;
    for (const cell of viewport.querySelectorAll('thead th')) {
      if (cell.getBoundingClientRect().right > edge + 1) count += 1;
    }
    return count;
  }

  /** @param {Element} wrapper */
  function sync(wrapper) {
    const viewport = wrapper.querySelector('.table-scroll-viewport');
    const hint = wrapper.querySelector('.table-scroll-hint');
    if (!(viewport instanceof HTMLElement) || !(hint instanceof HTMLElement)) return;

    const scrollable = viewport.scrollWidth - viewport.clientWidth > 1;
    if (scrollable) {
      viewport.setAttribute('tabindex', '0');
      viewport.setAttribute('role', 'region');
    } else {
      viewport.removeAttribute('tabindex');
      viewport.removeAttribute('role');
    }

    const remaining = scrollable ? columnsOutOfView(viewport) : 0;
    hint.hidden = remaining === 0;
    if (remaining > 0) {
      hint.textContent =
        remaining === 1
          ? 'Scroll sideways for 1 more column'
          : `Scroll sideways for ${remaining} more columns`;
    }
  }

  function syncAll() {
    for (const wrapper of document.querySelectorAll(WRAPPERS)) sync(wrapper);
  }

  function start() {
    for (const wrapper of document.querySelectorAll(WRAPPERS)) {
      const viewport = wrapper.querySelector('.table-scroll-viewport');
      if (!viewport) continue;
      let queued = false;
      viewport.addEventListener(
        'scroll',
        () => {
          if (queued) return;
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            sync(wrapper);
          });
        },
        { passive: true }
      );
    }

    syncAll();

    // Fonts land after first paint and change column widths, so a count taken
    // at DOMContentLoaded can be one column out.
    if (document.fonts?.ready) document.fonts.ready.then(syncAll);
    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(syncAll);
      observer.observe(document.documentElement);
    } else {
      window.addEventListener('resize', syncAll);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
