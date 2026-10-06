// quick-settings-host.js — the right-hand Quick settings drawer.
//
// Runs on: every http(s) page (top frame only). Does nothing until the popup's
// settings button sends { type: 'blm-quick-settings' } — page scripts can't send
// extension messages, so a site can't open it. The drawer is an iframe of
// pages/sidepanel.html inside a closed shadow root; it closes on ×, Escape, or a
// click on the dimmed page behind it. Chrome's own side panel can't be placed on
// the right by an extension (that's a browser setting), hence this drawer.

(() => {
  'use strict';

  const WIDTH = 380;
  let host = null;

  function close() {
    if (!host) return;
    const h = host;
    host = null;
    h.dataset.open = 'false';
    setTimeout(() => h.remove(), 200);
  }

  function open() {
    if (host) { close(); return; }                       // the gear toggles
    host = document.createElement('div');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .scrim { position: fixed; inset: 0; background: rgba(9, 30, 66, 0.25); opacity: 0;
          transition: opacity 180ms cubic-bezier(0.2, 0, 0, 1); }
        .drawer { position: fixed; top: 0; right: 0; height: 100vh; width: min(${WIDTH}px, 100vw);
          box-shadow: -8px 0 24px rgba(9, 30, 66, 0.18); transform: translateX(100%);
          transition: transform 200ms cubic-bezier(0.2, 0, 0, 1); background: transparent; }
        iframe { border: 0; width: 100%; height: 100%; display: block; color-scheme: normal; }
        :host([data-open="true"]) .scrim { opacity: 1; }
        :host([data-open="true"]) .drawer { transform: none; }
        @media (prefers-reduced-motion: reduce) { .scrim, .drawer { transition: none; } }
      </style>
      <div class="scrim"></div>
      <div class="drawer" role="dialog" aria-label="Quick settings"></div>`;
    const frame = document.createElement('iframe');
    frame.title = 'Quick settings';
    frame.src = chrome.runtime.getURL('pages/sidepanel.html') + '?embedded=1';
    root.querySelector('.drawer').append(frame);
    root.querySelector('.scrim').addEventListener('click', close);
    document.documentElement.append(host);
    requestAnimationFrame(() => requestAnimationFrame(() => { if (host) host.dataset.open = 'true'; }));
    frame.addEventListener('load', () => frame.focus());

    // The panel asks to close (× or Escape). Only a message from the panel itself
    // counts: its frame's window and its extension origin, never the host page.
    const panelOrigin = new URL(frame.src).origin;
    const onMessage = e => {
      if (!frame.contentWindow || e.source !== frame.contentWindow || e.origin !== panelOrigin) return;
      if (e.data?.type !== 'blm-quick-settings-close') return;
      window.removeEventListener('message', onMessage);
      close();
    };
    window.addEventListener('message', onMessage);
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && host) close(); });

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.type !== 'blm-quick-settings') return;
    open();
    reply({ ok: true });
  });
})();
