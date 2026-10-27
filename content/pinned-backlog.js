// pinned-backlog.js — pin a sprint/saved-view from the project sidebar (the "Work
// packages" sub-menu that lists entries like "Credit Utility 26.11.A", each really a
// saved query: /work_packages?query_id=NNN) so it's one click away from the header,
// no matter how far down the sidebar list it sits.
//
// Builds its UI out of OpenProject's own header classes (op-app-menu--item,
// op-app-menu--item-action, op-app-menu--dropdown, op-menu--item, …) so it matches the
// native look without us shipping any theme CSS of our own. Runs on every page of the
// configured host, independent of the Jira skin / UI 2.0 toggles.
//
// State: chrome.storage.local.__blm_pinned_backlog, an array of
// { href, title, pinnedAt }, newest first.

'use strict';

(() => {
  const PINNED_KEY = '__blm_pinned_backlog';
  const MAX_PINS = 20;

  async function getPinned() {
    const d = await chrome.storage.local.get(PINNED_KEY);
    return Array.isArray(d[PINNED_KEY]) ? d[PINNED_KEY] : [];
  }
  function setPinned(list) {
    return chrome.storage.local.set({ [PINNED_KEY]: list });
  }
  function findPin(list, href) {
    return list.findIndex(p => p.href === href);
  }
  async function togglePin(href, title) {
    const list = await getPinned();
    const idx = findPin(list, href);
    if (idx >= 0) {
      list.splice(idx, 1);
    } else {
      list.unshift({ href, title, pinnedAt: Date.now() });
      if (list.length > MAX_PINS) list.length = MAX_PINS;
    }
    await setPinned(list);
    return list;
  }

  /** Only the sidebar's saved-view entries (sprints among them) are pinnable, not every
   *  generic nav item ("Overview", "Roadmap", …) that happens to reuse op-sidemenu--item. */
  function isPinnableHref(href) {
    return /\bquery_id=\d+\b/.test(href ?? '');
  }

  /* Hallmark · component: dropdown+toggle · genre: modern-minimal · theme: graphite+cobalt (shared/tokens.css, duplicated — a content
   * script can't read the host page's own CSS variables, same reason jira-skin.js/reminder-banner.js keep local copies)
   * states: default · hover · focus-visible · active · disabled (write in flight) · loading (write in flight) · error (flash) · success (pulse)
   */
  const STYLE_ID = 'blm-pinned-backlog-style';
  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
:root {
  --blm-pin-accent: #2f5fe0; --blm-pin-accent-bg: #e8eefc; --blm-pin-accent-border: #b3c6f2;
  --blm-pin-text: #16171a; --blm-pin-text2: #5b5f68; --blm-pin-muted: #9a9ea6;
  --blm-pin-surface: #ffffff; --blm-pin-hover: #f0f1f3; --blm-pin-border: #e3e4e8;
  --blm-pin-danger: #c0283f; --blm-pin-danger-bg: #fbe9ec; --blm-pin-focus: #2f5fe0;
  --blm-pin-shadow: rgba(23, 27, 43, .16);
}
html[data-blm-theme="dark"] {
  --blm-pin-accent: #4c7dff; --blm-pin-accent-bg: #18233f; --blm-pin-accent-border: #2b3f75;
  --blm-pin-text: #e6e7ea; --blm-pin-text2: #a0a3ab; --blm-pin-muted: #7a7e87;
  --blm-pin-surface: #202226; --blm-pin-hover: #2a2c31; --blm-pin-border: #3a3d44;
  --blm-pin-danger: #f2828f; --blm-pin-danger-bg: #3a1c22; --blm-pin-focus: #4c7dff;
  --blm-pin-shadow: rgba(0, 0, 0, .45);
}
@media (prefers-color-scheme: dark) {
  html:not([data-blm-theme="light"]):not([data-blm-theme="dark"]) {
    --blm-pin-accent: #4c7dff; --blm-pin-accent-bg: #18233f; --blm-pin-accent-border: #2b3f75;
    --blm-pin-text: #e6e7ea; --blm-pin-text2: #a0a3ab; --blm-pin-muted: #7a7e87;
    --blm-pin-surface: #202226; --blm-pin-hover: #2a2c31; --blm-pin-border: #3a3d44;
    --blm-pin-danger: #f2828f; --blm-pin-danger-bg: #3a1c22; --blm-pin-focus: #4c7dff;
    --blm-pin-shadow: rgba(0, 0, 0, .45);
  }
}

/* ── pin toggle on each pinnable sidebar row ─────────────────────────────── */
li.op-sidemenu--item:has(> a[href*="query_id="]) { position: relative; }
.blm-sidebar-pin-btn {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  z-index: 1; display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; padding: 0; border: none; border-radius: 50%;
  background: transparent; color: var(--blm-pin-muted); opacity: 0; cursor: pointer;
  transition: opacity .12s var(--blm-pin-ease, ease-out), background-color .12s ease-out, color .12s ease-out, transform .12s ease-out;
}
li.op-sidemenu--item:hover .blm-sidebar-pin-btn,
.blm-sidebar-pin-btn.is-pinned,
.blm-sidebar-pin-btn:focus-visible { opacity: 1; }
.blm-sidebar-pin-btn:hover { background: var(--blm-pin-hover); color: var(--blm-pin-text); }
.blm-sidebar-pin-btn:active { transform: translateY(-50%) scale(.88); }
.blm-sidebar-pin-btn:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 1px; }
.blm-sidebar-pin-btn.is-pinned { color: var(--blm-pin-accent); }
.blm-sidebar-pin-btn[disabled] { opacity: .35; cursor: progress; pointer-events: none; }
.blm-sidebar-pin-btn.blm-pin-pulse { animation: blm-pin-pop .28s var(--blm-pin-ease, ease-out); }
.blm-sidebar-pin-btn.blm-pin-err { animation: blm-pin-shake .3s ease-out; color: var(--blm-pin-danger) !important; }
@keyframes blm-pin-pop { 0% { transform: translateY(-50%) scale(1); } 45% { transform: translateY(-50%) scale(1.35); } 100% { transform: translateY(-50%) scale(1); } }
@keyframes blm-pin-shake { 0%, 100% { transform: translateY(-50%) translateX(0); } 25% { transform: translateY(-50%) translateX(-2px); } 75% { transform: translateY(-50%) translateX(2px); } }

/* ── pinned items as one-click tabs in the header's left menu ────────────── */
/* Styled as our own buttons, not inherited OpenProject chrome: OP's own menu-item
 * CSS keys off its exact native markup shape (an <i> icon sibling, specific nesting),
 * so a bare .op-app-menu--item-action here renders as plain inline text. */
.blm-pin-tabs { display: inline-flex !important; align-items: center; gap: 4px; max-width: 46vw; overflow-x: auto; scrollbar-width: thin; }
.blm-pin-tab { display: inline-flex !important; align-items: center; flex: none; }
.blm-pin-tab > .op-app-menu--item-action,
.blm-pin-tab > .blm-pin-tab-link {
  position: relative !important; display: inline-flex !important; align-items: center; gap: 6px;
  height: 32px; padding: 0 10px !important; margin: 0 2px; border-radius: 16px; max-width: 180px;
  background: var(--blm-pin-hover); color: var(--blm-pin-text) !important;
  font: 500 13px/1 system-ui, sans-serif !important; text-decoration: none !important;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background-color .12s ease-out, padding-right .12s ease-out;
}
.blm-pin-tab:hover > .op-app-menu--item-action,
.blm-pin-tab:hover > .blm-pin-tab-link { background: var(--blm-pin-border); padding-right: 26px !important; }
.blm-pin-tab > .op-app-menu--item-action:focus-visible,
.blm-pin-tab > .blm-pin-tab-link:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 2px; }
.blm-pin-tab .blm-pin-icon { display: inline-flex !important; position: relative; flex: none; color: var(--blm-pin-accent); }
.blm-pin-tab-unpin {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%); z-index: 1;
  display: none; align-items: center; justify-content: center; width: 20px; height: 20px;
  border: none; border-radius: 50%; background: transparent; color: var(--blm-pin-muted); cursor: pointer;
}
.blm-pin-tab:hover .blm-pin-tab-unpin, .blm-pin-tab-unpin:focus-visible { display: inline-flex; }
.blm-pin-tab-unpin:hover { background: var(--blm-pin-danger-bg); color: var(--blm-pin-danger); }
.blm-pin-overflow > .op-app-menu--item-action {
  position: relative !important; display: inline-flex !important; align-items: center; gap: 4px;
  height: 32px; padding: 0 10px !important; margin: 0 2px; border-radius: 16px;
  background: var(--blm-pin-hover); color: var(--blm-pin-text) !important;
  font: 500 13px/1 system-ui, sans-serif !important; text-decoration: none !important;
}
.blm-pin-overflow > .op-app-menu--item-action:hover { background: var(--blm-pin-border); }
.blm-pin-overflow > .op-app-menu--item-action:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 2px; }

/* ── overflow dropdown panel (OpenProject's own op-app-menu--dropdown/op-menu shell) ── */
.blm-pin-overflow .op-app-menu--dropdown { width: 280px; max-height: 70vh; overflow-y: auto; padding: 4px 0; }
.blm-pinned-headline {
  display: flex; align-items: center; justify-content: space-between; padding: 8px 14px 6px;
  font: 600 11px/1.2 system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase; color: var(--blm-pin-muted);
}
.blm-pinned-empty { display: flex; align-items: center; gap: 10px; padding: 14px; color: var(--blm-pin-text2); font: 400 13px/1.4 system-ui, sans-serif; }
.blm-pinned-empty svg { flex: none; color: var(--blm-pin-muted); }
.blm-pinned-row {
  display: flex !important; align-items: center !important; gap: 4px; padding: 0 6px 0 14px !important;
  border-radius: 0; transition: background-color .1s ease-out;
}
.blm-pinned-row:hover, .blm-pinned-row:focus-within { background: var(--blm-pin-hover); }
.blm-pinned-row .op-menu--item-action {
  display: block !important; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  padding: 9px 4px 9px 0 !important; font: 500 13px/1.3 system-ui, sans-serif !important; color: var(--blm-pin-text) !important;
}
.blm-pinned-unpin {
  flex: none !important; display: inline-flex !important; align-items: center; justify-content: center; width: 24px; height: 24px;
  border: none; border-radius: 6px; background: transparent; color: var(--blm-pin-muted); opacity: 0; cursor: pointer;
  transition: opacity .12s ease-out, background-color .12s ease-out, color .12s ease-out;
}
.blm-pinned-row:hover .blm-pinned-unpin, .blm-pinned-unpin:focus-visible { opacity: 1; }
.blm-pinned-unpin:hover { background: var(--blm-pin-danger-bg); color: var(--blm-pin-danger); }
.blm-pinned-unpin:active { transform: scale(.9); }
.blm-pinned-unpin:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 1px; }
.blm-pinned-unpin[disabled] { opacity: .35 !important; cursor: progress; pointer-events: none; }

@media (prefers-reduced-motion: reduce) {
  .blm-sidebar-pin-btn, .blm-pinned-unpin, .blm-pinned-row { transition: none !important; }
  .blm-sidebar-pin-btn.blm-pin-pulse, .blm-sidebar-pin-btn.blm-pin-err { animation: none !important; }
}
`;
    document.head.appendChild(style);
  }

  const pinGlyph = on => `<svg width="14" height="14" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 3.5 20.5 9.5c.6.6.6 1.5 0 2.1l-2.1 2.1c-.5.5-1.3.6-1.9.2l-1-.7-4 4 .3 3-1.4 1.4-4-4-4-4 1.4-1.4 3 .3 4-4-.7-1c-.4-.6-.3-1.4.2-1.9l2.1-2.1c.6-.6 1.5-.6 2.1 0Z"/></svg>`;
  const closeGlyph = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  // ─── pin toggle on each pinnable sidebar row ────────────────────────────────────
  function ensureSidebarPinToggles(list) {
    installStyles();
    for (const a of document.querySelectorAll('li.op-sidemenu--item > a.op-sidemenu--item-action[href]')) {
      const href = a.getAttribute('href');
      if (!isPinnableHref(href)) continue;
      const li = a.parentElement;
      let btn = li.querySelector(':scope > .blm-sidebar-pin-btn');
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'blm-sidebar-pin-btn';
        btn.addEventListener('click', async e => {
          e.preventDefault();
          e.stopPropagation();
          btn.disabled = true;
          const title = a.querySelector('.op-sidemenu--item-title')?.textContent.trim() ?? a.textContent.trim();
          try {
            const updated = await togglePin(href, title);
            btn.classList.add('blm-pin-pulse');
            btn.addEventListener('animationend', () => btn.classList.remove('blm-pin-pulse'), { once: true });
            onPinnedChanged(updated);
          } catch {
            btn.classList.add('blm-pin-err');
            btn.addEventListener('animationend', () => btn.classList.remove('blm-pin-err'), { once: true });
          } finally {
            btn.disabled = false;
          }
        });
        li.append(btn);
      }
      const on = findPin(list, href) >= 0;
      if (btn.dataset.pinned === String(on)) continue;   // avoid re-triggering our own MutationObserver every frame
      btn.dataset.pinned = String(on);
      btn.classList.toggle('is-pinned', on);
      btn.title = on ? 'Unpin' : 'Pin to the header';
      btn.innerHTML = pinGlyph(on);
    }
  }

  // ─── pinned items as one-click tabs in the header's left menu ───────────────
  const MAX_VISIBLE_TABS = 4;   // beyond this, the rest collapse into a "+N" overflow dropdown
  let menuOpen = false;

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    const dropdown = document.querySelector('.blm-pin-overflow .op-app-menu--dropdown');
    if (dropdown) { dropdown.style.display = 'none'; dropdown.setAttribute('aria-expanded', 'false'); }
  }

  async function unpinWithFeedback(unpinBtn, href, title) {
    unpinBtn.disabled = true;
    try {
      const updated = await togglePin(href, title);
      onPinnedChanged(updated);
    } catch {
      unpinBtn.disabled = false;
    }
  }

  function makeTab(p) {
    const li = document.createElement('li');
    li.className = 'op-app-menu--item blm-pin-tab';
    const link = document.createElement('a');
    link.className = 'blm-pin-tab-link';
    link.href = p.href;
    link.title = p.title || p.href;
    const icon = document.createElement('span');
    icon.className = 'blm-pin-icon';
    icon.innerHTML = pinGlyph(true);
    const label = document.createElement('span');
    label.textContent = p.title || p.href;
    link.append(icon, label);
    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'blm-pin-tab-unpin';
    unpin.title = 'Unpin';
    unpin.innerHTML = closeGlyph;
    unpin.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      unpinWithFeedback(unpin, p.href, p.title);
    });
    li.append(link, unpin);
    return li;
  }

  function makeOverflowRow(p) {
    const row = document.createElement('li');
    row.className = 'op-menu--item blm-pinned-row';
    const link = document.createElement('a');
    link.className = 'op-menu--item-action';
    link.href = p.href;
    link.textContent = p.title || p.href;
    const unpin = document.createElement('button');
    unpin.type = 'button';
    unpin.className = 'blm-pinned-unpin';
    unpin.title = 'Unpin';
    unpin.innerHTML = pinGlyph(true);
    unpin.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      unpinWithFeedback(unpin, p.href, p.title);
    });
    row.append(link, unpin);
    return row;
  }

  function renderHeaderMenu(list) {
    const bar = document.querySelector('.op-app-header--start ul.op-app-menu');
    if (!bar) return;
    installStyles();

    // tabs is a SIBLING of bar (inserted via bar.after), not a child of it —
    // must be looked up from bar's parent, never from inside bar itself.
    let tabs = bar.parentElement?.querySelector(':scope > .blm-pin-tabs');
    if (!tabs) {
      tabs = document.createElement('ul');
      tabs.className = 'op-app-menu blm-pin-tabs';
      bar.after(tabs);
    }
    const sig = list.map(p => p.href).join('\n');
    if (tabs.dataset.sig === sig) return;   // avoid re-triggering our own MutationObserver every frame
    tabs.dataset.sig = sig;

    tabs.replaceChildren();
    const visible = list.slice(0, MAX_VISIBLE_TABS);
    const rest = list.slice(MAX_VISIBLE_TABS);
    for (const p of visible) tabs.append(makeTab(p));

    if (rest.length) {
      const item = document.createElement('li');
      item.className = 'op-app-menu--item op-app-menu--item_has-dropdown blm-pin-overflow';
      const trigger = document.createElement('a');
      trigger.href = '#';
      trigger.className = 'op-app-menu--item-action';
      trigger.setAttribute('aria-haspopup', 'true');
      trigger.title = 'More pinned backlogs';
      trigger.textContent = `+${rest.length}`;
      trigger.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        menuOpen = !menuOpen;
        const dropdown = item.querySelector('.op-app-menu--dropdown');
        dropdown.style.display = menuOpen ? 'block' : 'none';
        dropdown.setAttribute('aria-expanded', String(menuOpen));
      });
      const dropdown = document.createElement('ul');
      dropdown.className = 'op-app-menu--dropdown op-menu';
      dropdown.style.display = 'none';
      dropdown.setAttribute('aria-expanded', 'false');
      const headline = document.createElement('li');
      headline.className = 'op-menu--item';
      headline.innerHTML = '<div class="blm-pinned-headline">More pinned backlogs</div>';
      dropdown.append(headline);
      for (const p of rest) dropdown.append(makeOverflowRow(p));
      item.append(trigger, dropdown);
      tabs.append(item);
      document.addEventListener('click', closeMenu);
      document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
    }
  }

  function onPinnedChanged(list) {
    renderHeaderMenu(list);
    ensureSidebarPinToggles(list);
  }

  // ─── wiring: initial load, storage changes, SPA navigation, DOM churn ──────────
  let frame = 0;
  let currentList = [];
  function schedule() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = 0; renderHeaderMenu(currentList); ensureSidebarPinToggles(currentList); });
  }

  getPinned().then(list => { currentList = list; schedule(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(PINNED_KEY in changes)) return;
    currentList = Array.isArray(changes[PINNED_KEY].newValue) ? changes[PINNED_KEY].newValue : [];
    onPinnedChanged(currentList);
  });

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  if (globalThis.navigation) globalThis.navigation.addEventListener('navigatesuccess', schedule);
  window.addEventListener('popstate', schedule);
})();
