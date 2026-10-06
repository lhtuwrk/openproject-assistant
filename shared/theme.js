// theme.js — one dark/light theme for every extension page (popup, viewer, timelog)
//
// Loaded as a classic <script> in <head> so data-theme is set before first paint
// (MV3 forbids inline scripts). The choice lives in localStorage, which all
// extension pages share; the 'storage' event carries changes made in the popup
// to any other open page, which then gets a 'blm-theme-change' event to redraw
// canvas-based content.

'use strict';

(() => {
  const KEY = 'blm-theme';
  const read = () => { try { return localStorage.getItem(KEY) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };
  const apply = theme => {
    document.documentElement.dataset.theme = theme;
    // The backlog skin (a content script) can't read this page's localStorage.
    try { chrome.storage.local.set({ __blm_theme: theme })?.catch?.(() => {}); } catch { /* not an extension page */ }
    document.dispatchEvent(new CustomEvent('blm-theme-change', { detail: theme }));
  };

  apply(read());

  window.addEventListener('storage', e => { if (e.key === KEY) apply(read()); });

  window.blmTheme = {
    get: read,
    set(theme) {
      try { localStorage.setItem(KEY, theme); } catch { /* storage blocked */ }
      apply(theme);
    },
  };
})();
