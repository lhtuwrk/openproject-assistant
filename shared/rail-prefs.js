// rail-prefs.js — the dashboard rail's width and collapsed state.
//
// Loaded as a classic <script> in <head> (like theme.js) so the rail's size is set
// before first paint and switching pages doesn't make it jump. The choice lives in
// localStorage, which every extension page shares; the 'storage' event carries a
// change made on one open page to the others. shell.js draws the controls.

'use strict';

(() => {
  const KEY = 'blm-rail';
  const MIN = 200, MAX = 420, DEFAULT = 248, COLLAPSED = 60;
  const clamp = w => Math.min(MAX, Math.max(MIN, Math.round(Number(w)) || DEFAULT));
  const read = () => {
    try {
      const o = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      return { w: clamp(o.w), collapsed: o.collapsed === true };
    } catch { return { w: DEFAULT, collapsed: false }; }
  };
  const apply = ({ w, collapsed }) => {
    const root = document.documentElement;
    root.style.setProperty('--rail-w', `${collapsed ? COLLAPSED : w}px`);
    root.dataset.rail = collapsed ? 'collapsed' : 'open';
  };

  window.blmRail = {
    MIN, MAX, DEFAULT,
    get: read,
    /** Shows a width while dragging, without saving it. */
    preview: w => document.documentElement.style.setProperty('--rail-w', `${clamp(w)}px`),
    set(patch) {
      const next = { ...read(), ...patch };
      next.w = clamp(next.w);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked */ }
      apply(next);
      document.dispatchEvent(new CustomEvent('blm-rail-change', { detail: next }));
    },
  };

  apply(read());
  window.addEventListener('storage', e => {
    if (e.key !== KEY) return;
    apply(read());
    document.dispatchEvent(new CustomEvent('blm-rail-change', { detail: read() }));
  });
})();
