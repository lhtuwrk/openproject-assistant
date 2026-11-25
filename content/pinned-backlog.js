// pinned-backlog.js — pin any link on the host so it's one click away from the header:
// a sprint/saved-view from the project sidebar (entries like "Credit Utility 26.11.A",
// each really a saved query: /work_packages?query_id=NNN), or anything else via the
// right-click menu ("Pin this link" / "Pin this page", registered by background.js,
// which messages us) or the "+" tab (pins the current page). A pin can be renamed,
// given a colour (pencil on the tab) and dragged into a new order.
//
// Builds its UI out of OpenProject's own header classes (op-app-menu--item,
// op-app-menu--item-action, op-app-menu--dropdown, op-menu--item, …) so it matches the
// native look without us shipping any theme CSS of our own. Runs on every page of the
// configured host, independent of the Jira skin / UI 2.0 toggles.
//
// State: chrome.storage.local.__blm_pinned_backlog, an array of
// { href, title, pinnedAt, color? }, in display order (new pins go first).

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
    return list.findIndex(p => sameTarget(p.href, href));
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

  /** Same-origin URLs are kept as path+query+hash (what the sidebar's own hrefs look like). */
  function normalizeHref(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin ? u.pathname + u.search + u.hash : u.href;
    } catch { return url; }
  }
  async function addPin(url, title) {
    const href = normalizeHref(url);
    const list = await getPinned();
    let pin = list.find(p => sameTarget(p.href, href));
    const existed = !!pin;
    if (!pin) {
      pin = { href, title, pinnedAt: Date.now() };
      list.unshift(pin);
      if (list.length > MAX_PINS) list.length = MAX_PINS;
      await setPinned(list);
    }
    return { list, pin, existed };
  }
  async function updatePin(href, patch) {
    const list = await getPinned();
    const pin = list.find(p => p.href === href);
    if (!pin) return list;
    Object.assign(pin, patch);
    await setPinned(list);
    return list;
  }
  async function movePin(fromHref, toHref, after) {
    const list = await getPinned();
    const from = list.findIndex(p => p.href === fromHref);
    if (from < 0 || fromHref === toHref) return list;
    const [item] = list.splice(from, 1);
    const to = list.findIndex(p => p.href === toHref);
    if (to < 0) { list.splice(from, 0, item); return list; }
    list.splice(to + (after ? 1 : 0), 0, item);
    await setPinned(list);
    return list;
  }

  /** Same destination: same path, and the same saved view when it is one (OpenProject appends
   *  query_props etc. to a saved view's URL, so the whole query string can't be compared); the
   *  #hash is ignored. Used to spot the page you are on and to refuse a duplicate pin. */
  function sameTarget(a, b) {
    try {
      const x = new URL(a, location.origin);
      const y = new URL(b, location.origin);
      if (x.origin !== y.origin || x.pathname !== y.pathname) return false;
      const qid = x.searchParams.get('query_id');
      return qid ? y.searchParams.get('query_id') === qid : x.search === y.search;
    } catch { return a === b; }
  }
  const isCurrent = p => sameTarget(p.href, location.href);

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
.blm-pin-tab {
  --blm-pin-tab-bg: var(--blm-pin-hover); --blm-pin-mix: 0%; --blm-pin-ease: cubic-bezier(.2, .8, .2, 1); --blm-pin-dur: .22s;
  --blm-pin-ce: var(--blm-pin-c);
  position: relative; display: inline-flex !important; align-items: center; flex: none;
}
.blm-pin-tab[data-c] { --blm-pin-mix: 18%; }
.blm-pin-tab:hover { --blm-pin-tab-bg: var(--blm-pin-border); }
.blm-pin-tab[data-c]:hover { --blm-pin-mix: 30%; }
html[data-blm-theme="dark"] .blm-pin-tab, html[data-blm-ios-theme="dark"] .blm-pin-tab, html[data-blm-ui2-theme="dark"] .blm-pin-tab,
html[data-blm-theme="dark"] .blm-pinned-row, html[data-blm-ios-theme="dark"] .blm-pinned-row, html[data-blm-ui2-theme="dark"] .blm-pinned-row {
  --blm-pin-ce: color-mix(in srgb, var(--blm-pin-c) 75%, white);   /* softer in dark */
}
.blm-pin-tab > .op-app-menu--item-action,
.blm-pin-tab > .blm-pin-tab-link {
  position: relative !important; display: inline-flex !important; align-items: center; gap: 6px;
  height: 32px; padding: 0 10px !important; margin: 0 2px; border-radius: 16px; max-width: 180px;
  background: color-mix(in srgb, var(--blm-pin-c, #000) var(--blm-pin-mix, 0%), var(--blm-pin-tab-bg, var(--blm-pin-hover))); color: var(--blm-pin-text) !important;
  font: 500 13px/1 system-ui, sans-serif !important; text-decoration: none !important;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  transition: background-color .12s ease-out, box-shadow .15s ease-out, transform .15s ease-out,
    padding-right var(--blm-pin-dur, .22s) var(--blm-pin-ease, ease-out), max-width var(--blm-pin-dur, .22s) var(--blm-pin-ease, ease-out);
}
.blm-pin-tab-link > span:last-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.blm-pin-tab:hover > .blm-pin-tab-link, .blm-pin-tab:focus-within > .blm-pin-tab-link { max-width: min(380px, 40vw); }
.blm-pin-tab:hover > .op-app-menu--item-action,
.blm-pin-tab:hover > .blm-pin-tab-link { padding-right: 48px !important; }
.blm-pin-tab[data-c] .blm-pin-icon { color: var(--blm-pin-ce); }
.blm-pin-tab[aria-current] > .blm-pin-tab-link { box-shadow: inset 0 0 0 1.5px var(--blm-pin-ce, var(--blm-pin-accent)); font-weight: 600 !important; }
.blm-pin-tab[draggable], .blm-pinned-row[draggable] { cursor: grab; }
.blm-pin-tab.is-dragging, .blm-pinned-row.is-dragging { opacity: .45; }
.blm-pin-tab.is-dragging { transform: scale(.96) rotate(-1.5deg); }
.blm-pin-tab.is-drop-before::after, .blm-pin-tab.is-drop-after::after {
  content: ''; position: absolute; top: 4px; bottom: 4px; width: 3px; border-radius: 2px; background: var(--blm-pin-accent); pointer-events: none;
}
.blm-pin-tab.is-drop-before::after { left: -3px; }
.blm-pin-tab.is-drop-after::after { right: -3px; }
.blm-pinned-row { position: relative; }
.blm-pinned-row.is-drop-before::after, .blm-pinned-row.is-drop-after::after {
  content: ''; position: absolute; left: 8px; right: 8px; height: 2px; border-radius: 1px; background: var(--blm-pin-accent); pointer-events: none;
}
.blm-pinned-row.is-drop-before::after { top: 0; }
.blm-pinned-row.is-drop-after::after { bottom: 0; }
@keyframes blm-pin-enter { from { opacity: 0; transform: scale(.88); } to { opacity: 1; transform: none; } }
.blm-pin-tab.blm-pin-enter { animation: blm-pin-enter var(--blm-pin-dur) var(--blm-pin-ease) both; }
.blm-pin-add { display: inline-flex !important; align-items: center; flex: none; }
.blm-pin-add > button {
  width: 28px; height: 28px; border: none; border-radius: 50%; background: transparent;
  color: var(--blm-pin-text2); font: 500 18px/1 system-ui, sans-serif; cursor: pointer;
}
.blm-pin-add > button:hover { background: var(--blm-pin-hover); color: var(--blm-pin-text); }
.blm-pin-add > button:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 1px; }
.blm-pin-tab > .op-app-menu--item-action:focus-visible,
.blm-pin-tab > .blm-pin-tab-link:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 2px; }
.blm-pin-tab .blm-pin-icon { display: inline-flex !important; position: relative; flex: none; color: var(--blm-pin-accent); }
.blm-pin-tab-unpin {
  position: absolute; right: 4px; top: 50%; transform: translateY(-50%); z-index: 1;
  display: none; align-items: center; justify-content: center; width: 20px; height: 20px;
  border: none; border-radius: 50%; background: transparent; color: var(--blm-pin-muted); cursor: pointer;
}
.blm-pin-tab-edit { right: 24px !important; }
.blm-pin-tab:hover .blm-pin-tab-unpin, .blm-pin-tab-unpin:focus-visible { display: inline-flex; }
.blm-pin-tab-unpin:hover { background: var(--blm-pin-danger-bg); color: var(--blm-pin-danger); }
.blm-pin-tab-edit:hover { background: var(--blm-pin-accent-bg); color: var(--blm-pin-accent); }
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
.blm-pinned-row[data-c] { box-shadow: inset 3px 0 0 var(--blm-pin-ce, var(--blm-pin-c)); }
.blm-pinned-row .blm-pinned-edit:hover { background: var(--blm-pin-accent-bg); color: var(--blm-pin-accent); }

/* ── rename / colour popover ─────────────────────────────────────────────── */
.blm-pin-editor {
  position: fixed; z-index: 100000; width: 260px; padding: 12px; box-sizing: border-box;
  background: var(--blm-pin-surface); color: var(--blm-pin-text); border: 1px solid var(--blm-pin-border);
  border-radius: 10px; box-shadow: 0 8px 24px var(--blm-pin-shadow); font: 400 13px/1.4 system-ui, sans-serif;
  animation: blm-pin-editor-in .16s cubic-bezier(.2, .8, .2, 1);
}
@keyframes blm-pin-editor-in { from { opacity: 0; transform: translateY(-6px) scale(.97); } }
.blm-pin-editor label { display: block; margin-bottom: 4px; font-weight: 600; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: var(--blm-pin-muted); }
.blm-pin-editor input {
  width: 100%; box-sizing: border-box; height: 32px; padding: 0 8px; margin: 4px 0 10px;
  border: 1px solid var(--blm-pin-border); border-radius: 6px; background: var(--blm-pin-surface); color: var(--blm-pin-text); font: inherit;
}
.blm-pin-editor input:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 0; }
.blm-pin-editor-note { margin-bottom: 8px; color: var(--blm-pin-accent); font-weight: 600; }
.blm-pin-swatches { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.blm-pin-swatch {
  width: 22px; height: 22px; padding: 0; border-radius: 50%; border: 2px solid transparent; cursor: pointer;
  background: var(--sw); box-shadow: inset 0 0 0 1px rgba(0,0,0,.15);
}
.blm-pin-swatch.is-none { background: var(--blm-pin-hover); }
.blm-pin-swatch[aria-pressed="true"] { border-color: var(--blm-pin-text); }
.blm-pin-swatch:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 2px; }
.blm-pin-editor-actions { display: flex; justify-content: flex-end; gap: 8px; }
.blm-pin-editor-actions button {
  height: 30px; padding: 0 12px; border-radius: 6px; border: 1px solid var(--blm-pin-border);
  background: var(--blm-pin-surface); color: var(--blm-pin-text); font: 500 13px/1 system-ui, sans-serif; cursor: pointer;
}
.blm-pin-editor-actions button:hover { background: var(--blm-pin-hover); }
.blm-pin-editor-actions .primary { background: var(--blm-pin-accent); border-color: var(--blm-pin-accent); color: #fff; }
.blm-pin-editor-actions .primary:hover { filter: brightness(1.1); background: var(--blm-pin-accent); }
.blm-pinned-unpin:focus-visible { outline: 2px solid var(--blm-pin-focus); outline-offset: 1px; }
.blm-pinned-unpin[disabled] { opacity: .35 !important; cursor: progress; pointer-events: none; }

/* ── per-skin looks: the skin classes are on <html> (jira-skin.js / ios.js / ui2.js) ── */
/* iOS: frosted pills, spring motion */
html.blm-ios .blm-pin-tab { --blm-pin-tab-bg: rgba(255,255,255,.72); --blm-pin-ease: cubic-bezier(.34, 1.56, .64, 1); --blm-pin-dur: .4s; }
html.blm-ios .blm-pin-tab:hover { --blm-pin-tab-bg: rgba(255,255,255,.95); }
html.blm-ios[data-blm-ios-theme="dark"] .blm-pin-tab { --blm-pin-tab-bg: rgba(60,60,67,.6); }
html.blm-ios[data-blm-ios-theme="dark"] .blm-pin-tab:hover { --blm-pin-tab-bg: rgba(84,84,90,.7); }
html.blm-ios .blm-pin-tab > .blm-pin-tab-link {
  -webkit-backdrop-filter: blur(14px) saturate(1.6); backdrop-filter: blur(14px) saturate(1.6);
  box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 0 0 .5px rgba(0,0,0,.06);
}
html.blm-ios .blm-pin-tab > .blm-pin-tab-link:active { transform: scale(.96); }
html.blm-ios .blm-pin-tab[aria-current] > .blm-pin-tab-link { box-shadow: 0 1px 2px rgba(0,0,0,.08), inset 0 0 0 1.5px var(--blm-pin-ce, var(--blm-pin-accent)); }
html.blm-ios .blm-sidebar-pin-btn.blm-pin-pulse { animation: blm-pin-spring .45s cubic-bezier(.34, 1.56, .64, 1); }
@keyframes blm-pin-spring { 0% { transform: translateY(-50%) scale(1); } 40% { transform: translateY(-50%) scale(1.4); } 70% { transform: translateY(-50%) scale(.92); } 100% { transform: translateY(-50%) scale(1); } }

/* UI 2.0: liquid glass, a coloured glow instead of a flat tint, a shine sweep on hover */
html.blm-ui2 .blm-pin-tab { --blm-pin-tab-bg: rgba(255,255,255,.45); --blm-pin-dur: .32s; }
html.blm-ui2 .blm-pin-tab:hover { --blm-pin-tab-bg: rgba(255,255,255,.65); }
html.blm-ui2[data-blm-ui2-theme="dark"] .blm-pin-tab { --blm-pin-tab-bg: rgba(255,255,255,.08); }
html.blm-ui2[data-blm-ui2-theme="dark"] .blm-pin-tab:hover { --blm-pin-tab-bg: rgba(255,255,255,.15); }
html.blm-ui2 .blm-pin-tab[data-c] { --blm-pin-mix: 10%; }
html.blm-ui2 .blm-pin-tab > .blm-pin-tab-link {
  -webkit-backdrop-filter: blur(16px) saturate(1.5); backdrop-filter: blur(16px) saturate(1.5);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 0 0 1px rgba(255,255,255,.3);
}
html.blm-ui2 .blm-pin-tab[data-c] > .blm-pin-tab-link {
  box-shadow: inset 0 1px 0 rgba(255,255,255,.55), 0 0 0 1px rgba(255,255,255,.3), 0 4px 14px -4px color-mix(in srgb, var(--blm-pin-ce) 60%, transparent);
}
html.blm-ui2 .blm-pin-tab > .blm-pin-tab-link::before {
  content: ''; position: absolute; inset: 0; pointer-events: none; transform: translateX(-120%);
  background: linear-gradient(100deg, transparent 30%, rgba(255,255,255,.55) 50%, transparent 70%); transition: transform .6s ease-out;
}
html.blm-ui2 .blm-pin-tab:hover > .blm-pin-tab-link { transform: translateY(-1px); }
html.blm-ui2 .blm-pin-tab:hover > .blm-pin-tab-link::before { transform: translateX(120%); }
html.blm-ui2 .blm-pin-tab[aria-current] > .blm-pin-tab-link { box-shadow: inset 0 1px 0 rgba(255,255,255,.55), inset 0 0 0 1.5px var(--blm-pin-ce, var(--blm-pin-accent)), 0 4px 14px -4px color-mix(in srgb, var(--blm-pin-ce, var(--blm-pin-accent)) 60%, transparent); }
html.blm-ui2 .blm-sidebar-pin-btn.blm-pin-pulse { animation: blm-pin-glow .5s ease-out; }
@keyframes blm-pin-glow { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--blm-pin-accent) 55%, transparent); } 100% { box-shadow: 0 0 0 10px transparent; } }
html.blm-ios .blm-pin-editor, html.blm-ui2 .blm-pin-editor {
  border-radius: 14px; background: color-mix(in srgb, var(--blm-pin-surface) 82%, transparent);
  -webkit-backdrop-filter: blur(20px) saturate(1.6); backdrop-filter: blur(20px) saturate(1.6);
}

/* Jira: flat square tabs, a coloured underbar that draws in, quick linear motion */
html.blm-jira .blm-pin-tab { --blm-pin-ease: linear; --blm-pin-dur: .15s; --blm-pin-mix: 0%; }
html.blm-jira .blm-pin-tab[data-c] { --blm-pin-mix: 7%; }
html.blm-jira .blm-pin-tab > .blm-pin-tab-link { height: 30px; border-radius: 4px; }
html.blm-jira .blm-pin-tab > .blm-pin-tab-link::after {
  content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 3px; pointer-events: none;
  background: var(--blm-pin-ce, var(--blm-pin-accent)); transform: scaleX(0); transform-origin: left; transition: transform .18s ease-out;
}
html.blm-jira .blm-pin-tab[data-c] > .blm-pin-tab-link::after,
html.blm-jira .blm-pin-tab:hover > .blm-pin-tab-link::after,
html.blm-jira .blm-pin-tab[aria-current] > .blm-pin-tab-link::after { transform: scaleX(1); }
html.blm-jira .blm-pin-tab[aria-current] > .blm-pin-tab-link { box-shadow: none; }
html.blm-jira .blm-pin-tab.blm-pin-enter { animation-name: blm-pin-fade; }
@keyframes blm-pin-fade { from { opacity: 0; } to { opacity: 1; } }
html.blm-jira .blm-sidebar-pin-btn.blm-pin-pulse { animation: blm-pin-stab .3s ease-out; }
@keyframes blm-pin-stab { 0% { transform: translateY(-50%) rotate(-40deg) scale(1.2); } 60% { transform: translateY(-50%) rotate(8deg); } 100% { transform: translateY(-50%) rotate(0); } }

@media (prefers-reduced-motion: reduce) {
  .blm-pin-tab, .blm-pin-editor { animation: none !important; }
  .blm-pin-tab > .blm-pin-tab-link, .blm-pin-tab > .blm-pin-tab-link::before, .blm-pin-tab > .blm-pin-tab-link::after { transition: none !important; }
  .blm-sidebar-pin-btn, .blm-pinned-unpin, .blm-pinned-row, .blm-pin-tab-link { transition: none !important; }
  .blm-sidebar-pin-btn.blm-pin-pulse, .blm-sidebar-pin-btn.blm-pin-err { animation: none !important; }
}
`;
    document.head.appendChild(style);
  }

  const pinGlyph = on => `<svg width="14" height="14" viewBox="0 0 24 24" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>`;
  const editGlyph = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4Z"/></svg>';
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

  const PIN_COLORS = ['#2f5fe0', '#0f9d8a', '#2e9e4f', '#d99a00', '#e8702a', '#d6336c', '#8e44ad', '#6b7280'];

  function applyColor(el, p) {
    if (p.color) { el.dataset.c = '1'; el.style.setProperty('--blm-pin-c', p.color); }
  }

  /** Drag a tab / overflow row onto another to put it in that one's place. */
  function wireDrag(el, p, vertical) {
    const MIME = 'text/x-blm-pin';
    const side = e => {
      const r = el.getBoundingClientRect();
      return (vertical ? e.clientY - r.top > r.height / 2 : e.clientX - r.left > r.width / 2) ? 'after' : 'before';
    };
    const clear = () => el.classList.remove('is-drop-before', 'is-drop-after');
    el.draggable = true;
    el.addEventListener('dragstart', e => {
      e.dataTransfer.setData(MIME, p.href);
      e.dataTransfer.effectAllowed = 'move';
      requestAnimationFrame(() => el.classList.add('is-dragging'));   // after the drag image is taken
    });
    el.addEventListener('dragend', () => el.classList.remove('is-dragging'));
    el.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes(MIME)) return;
      e.preventDefault();
      const s = side(e);
      el.classList.toggle('is-drop-before', s === 'before');
      el.classList.toggle('is-drop-after', s === 'after');
    });
    el.addEventListener('dragleave', clear);
    el.addEventListener('drop', async e => {
      e.preventDefault();
      const s = side(e);
      clear();
      const from = e.dataTransfer.getData(MIME);
      if (from) onPinnedChanged(await movePin(from, p.href, s === 'after'));
    });
  }

  let closeEditor = () => {};
  function openEditor(p, note) {
    closeEditor();
    const box = document.createElement('div');
    box.className = 'blm-pin-editor';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Edit pin');
    const label = document.createElement('label');
    label.textContent = 'Name';
    const input = document.createElement('input');
    input.value = p.title || '';
    input.maxLength = 60;
    label.append(input);
    let color = p.color || '';
    const swatches = document.createElement('div');
    swatches.className = 'blm-pin-swatches';
    for (const c of ['', ...PIN_COLORS]) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = 'blm-pin-swatch' + (c ? '' : ' is-none');
      sw.title = c || 'No colour';
      sw.style.setProperty('--sw', c);
      sw.setAttribute('aria-pressed', String(c === color));
      sw.addEventListener('click', () => {
        color = c;
        for (const s of swatches.children) s.setAttribute('aria-pressed', String(s === sw));
      });
      swatches.append(sw);
    }
    const actions = document.createElement('div');
    actions.className = 'blm-pin-editor-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = 'Save';
    actions.append(cancel, save);
    if (note) {
      const n = document.createElement('div');
      n.className = 'blm-pin-editor-note';
      n.textContent = note;
      box.prepend(n);
    }
    box.append(label, swatches, actions);

    const anchor = document.querySelector('.blm-pin-tabs')?.getBoundingClientRect();
    box.style.top = `${(anchor?.bottom ?? 48) + 6}px`;
    box.style.left = `${Math.max(8, Math.min(anchor?.left ?? 16, innerWidth - 268))}px`;
    installStyles();
    document.body.append(box);
    input.focus();
    input.select();

    const onDown = e => { if (!box.contains(e.target)) closeEditor(); };
    const onKey = e => {
      if (e.key === 'Escape') closeEditor();
      else if (e.key === 'Enter' && document.activeElement === input) doSave();
    };
    closeEditor = () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      box.remove();
      closeEditor = () => {};
    };
    const doSave = async () => {
      const title = input.value.trim() || p.title;
      closeEditor();
      onPinnedChanged(await updatePin(p.href, { title, color: color || undefined }));
    };
    cancel.addEventListener('click', closeEditor);
    save.addEventListener('click', doSave);
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }

  function makeEditBtn(cls, p) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.title = 'Rename / colour';
    b.innerHTML = editGlyph;
    b.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      openEditor(p);
    });
    return b;
  }

  function makeTab(p) {
    const li = document.createElement('li');
    li.className = 'op-app-menu--item blm-pin-tab';
    applyColor(li, p);
    wireDrag(li, p, false);
    li.dataset.href = p.href;
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
    li.append(link, makeEditBtn('blm-pin-tab-unpin blm-pin-tab-edit', p), unpin);
    return li;
  }

  function makeOverflowRow(p) {
    const row = document.createElement('li');
    row.className = 'op-menu--item blm-pinned-row';
    applyColor(row, p);
    wireDrag(row, p, true);
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
    row.append(link, makeEditBtn('blm-pinned-unpin blm-pinned-edit', p), unpin);
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
    const sig = list.map(p => [p.href, p.title, p.color].join('|')).join('\n');
    if (tabs.dataset.sig === sig) { markCurrent(tabs, list); return; }   // avoid re-triggering our own MutationObserver every frame
    tabs.dataset.sig = sig;

    // FLIP: remember where each tab was, rebuild, then slide the survivors from there to where they are now
    const before = new Map([...tabs.querySelectorAll('.blm-pin-tab')].map(li => [li.dataset.href, li.getBoundingClientRect().left]));
    const animate = pinsShown;
    tabs.replaceChildren();
    menuOpen = false;
    const visible = list.slice(0, MAX_VISIBLE_TABS);
    const rest = list.slice(MAX_VISIBLE_TABS);
    for (const p of visible) tabs.append(makeTab(p));

    const add = document.createElement('li');
    add.className = 'op-app-menu--item blm-pin-add';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.title = 'Pin this page';
    addBtn.setAttribute('aria-label', 'Pin this page');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); pinUrl(location.href, document.title); });
    add.append(addBtn);

    if (rest.length) {
      const item = document.createElement('li');
      item.className = 'op-app-menu--item op-app-menu--item_has-dropdown blm-pin-overflow';
      const trigger = document.createElement('a');
      trigger.href = '#';
      trigger.className = 'op-app-menu--item-action';
      trigger.setAttribute('aria-haspopup', 'true');
      trigger.title = 'More pins';
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
      headline.innerHTML = '<div class="blm-pinned-headline">More pins</div>';
      dropdown.append(headline);
      for (const p of rest) dropdown.append(makeOverflowRow(p));
      item.append(trigger, dropdown);
      tabs.append(item);
      if (!menuListenersBound) {
        menuListenersBound = true;
        document.addEventListener('click', closeMenu);
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(); });
      }
    }
    tabs.append(add);

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const li of tabs.querySelectorAll('.blm-pin-tab')) {
      const h = li.dataset.href;
      if (!seen.has(h)) {
        if (animate && !reduce) li.classList.add('blm-pin-enter');
      } else if (before.has(h) && !reduce) {
        const dx = before.get(h) - li.getBoundingClientRect().left;
        if (dx) li.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 240, easing: 'cubic-bezier(.2, .8, .2, 1)' });
      }
      seen.add(h);
    }
    if (loaded) pinsShown = true;   // the first render of the stored pins doesn't animate them in
    markCurrent(tabs, list);
  }
  let menuListenersBound = false;
  const seen = new Set();
  let loaded = false;
  let pinsShown = false;

  function markCurrent(tabs, list) {
    for (const li of tabs.querySelectorAll('.blm-pin-tab')) {
      const p = list.find(x => x.href === li.dataset.href);
      const on = !!p && isCurrent(p);
      if (li.hasAttribute('aria-current') !== on) on ? li.setAttribute('aria-current', 'page') : li.removeAttribute('aria-current');
    }
  }

  async function pinUrl(url, title) {
    const { list, pin, existed } = await addPin(url, title);
    onPinnedChanged(list);
    openEditor(pin, existed ? 'Already pinned' : '');
  }

  // The right-click entries live in background.js (chrome.contextMenus); it can't see which link
  // was clicked, so remember it here and take its text as the pin's name.
  let lastLink = null;
  document.addEventListener('contextmenu', e => { lastLink = e.target.closest?.('a[href]') ?? null; }, true);
  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type !== 'blm-pin-add' || !msg.url) return;
    const a = !msg.page && lastLink?.href === msg.url ? lastLink : null;
    const text = (a?.textContent || a?.getAttribute('aria-label') || a?.title || '').replace(/\s+/g, ' ').trim()
      || (msg.page ? document.title : decodeURIComponent(normalizeHref(msg.url)).split(/[/?#]/).filter(Boolean).pop() || msg.url);
    pinUrl(msg.url, text.slice(0, 60));
  });

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

  getPinned().then(list => { currentList = list; loaded = true; schedule(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !(PINNED_KEY in changes)) return;
    currentList = Array.isArray(changes[PINNED_KEY].newValue) ? changes[PINNED_KEY].newValue : [];
    onPinnedChanged(currentList);
  });

  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  if (globalThis.navigation) globalThis.navigation.addEventListener('navigatesuccess', schedule);
  window.addEventListener('popstate', schedule);
})();
