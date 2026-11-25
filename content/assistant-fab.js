// assistant-fab.js — a floating button that opens the Claude assistant as a small chat popup,
// not a full-page drawer: the user stays able to see and use the backlog page behind it (so that
// if the assistant ever edits something directly, that edit is visible as it happens).
//
// Runs on: <backlog host>/projects/*/work_packages* (registered by background.js, same route as
// content.js), so it shows on the backlog list and on a story's own detail view. Shown only while
// Settings → Experimental → "Claude on Planning" is on. The popup is an iframe of its own
// (pages/assistant.html) inside a closed shadow root, anchored above the button; this script owns
// that iframe directly, so it can postMessage context updates into it without going through
// quick-settings-host.js's shared drawer.

'use strict';

const AI_KEY = '__blm_claude_ai';
let enabled = false;
let fabHost = null;    // the button's shadow host, always present while enabled
let fabRoot = null;    // its closed shadow root's live handle — attachShadow's return value is the
                        // only way to reach back into a closed root later, so it's kept here
let panel = null;      // { host, frame } while the popup is open, else null

// Same spark as shared/claude-icon.js — duplicated because a content script can't import an ES
// module; keep the two in step (see also getChartColors() in viewer.js and reminder-banner.js,
// which duplicate token values for the same reason).
const CLAUDE_ICON_PATH = (() => {
  const RAYS = [
    [0, 10.6, 2.9], [33, 8.3, 2.5], [63, 9.9, 2.8], [96, 7.6, 2.4], [127, 10.3, 2.9], [160, 8.7, 2.6],
    [191, 10.0, 2.8], [222, 7.7, 2.4], [253, 10.5, 2.9], [287, 8.1, 2.5], [318, 9.5, 2.7],
  ];
  const R0 = 1.0, W0 = 0.75, f = n => +n.toFixed(2);
  const petal = ([deg, len, w]) => {
    const a = (deg - 90) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    const P = (x, y) => `${f(x * c - y * s)} ${f(x * s + y * c)}`;
    const r = w / 2, tip = len - r;
    return `M${P(R0, -W0 / 2)}L${P(tip, -r)}A${f(r)} ${f(r)} 0 0 1 ${P(tip, r)}L${P(R0, W0 / 2)}Z`;
  };
  return RAYS.map(petal).join('') + 'M-1.7 0a1.7 1.7 0 1 0 3.4 0a1.7 1.7 0 1 0 -3.4 0Z';
})();

const CLOSE_PATH = 'M-6 -6L6 6M6 -6L-6 6';   // an × of the same stroke weight as the spark's lines

/** The work package shown in the detail view, from /work_packages/(details/)<id> — same regex content.js uses. */
function detailWpId() {
  const m = /\/work_packages\/(?:details\/)?(\d+)/.exec(location.pathname);
  return m ? m[1] : null;
}

function projectSlug() {
  const m = /\/projects\/([^/]+)\/work_packages/.exec(location.pathname);
  return m ? decodeURIComponent(m[1]) : null;
}

const context = () => ({ wp: detailWpId(), project: projectSlug() });

function assistantUrl() {
  const { wp, project } = context();
  const params = new URLSearchParams({ embedded: '1' });
  if (wp) params.set('wp', wp);
  if (project) params.set('project', project);
  return chrome.runtime.getURL('pages/assistant.html') + '?' + params.toString();
}

// ─── The button ───────────────────────────────────────────────────────────────

function createFab() {
  if (fabHost) return;
  fabHost = document.createElement('div');
  fabHost.style.cssText = 'all: initial; position: fixed; z-index: 2147483646;';
  fabRoot = fabHost.attachShadow({ mode: 'closed' });
  fabRoot.innerHTML = `
    <style>
      button {
        all: initial; position: fixed; right: 20px; bottom: 20px; width: 48px; height: 48px;
        border-radius: 50%; background: #d97757; display: flex; align-items: center; justify-content: center;
        cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.3), 0 0 0 1px rgba(255,255,255,.08);
        transition: transform 140ms cubic-bezier(0.16,1,0.3,1);
      }
      button:hover { transform: translateY(-2px); }
      button:active { transform: translateY(0) scale(0.96); }
      svg { width: 24px; height: 24px; fill: none; stroke: #fff; stroke-width: 2; stroke-linecap: round; display: block; pointer-events: none; }
      path.spark { fill: #fff; stroke: none; }
      @media (prefers-reduced-motion: reduce) { button { transition: none; } }
    </style>
    <button type="button" aria-label="Ask Claude about this" aria-expanded="false">
      <svg viewBox="-12 -12 24 24" aria-hidden="true"><path class="spark" d="${CLAUDE_ICON_PATH}" /></svg>
    </button>`;
  document.documentElement.append(fabHost);
  fabRoot.querySelector('button').addEventListener('click', togglePanel);
}

function removeFab() {
  closePanel();
  fabHost?.remove();
  fabHost = null;
  fabRoot = null;
}

/** Swaps the button between the spark (closed) and an × (open) in place. */
function setFabState(open) {
  const btn = fabRoot?.querySelector('button');
  const path = fabRoot?.querySelector('path');
  if (!btn || !path) return;
  btn.setAttribute('aria-expanded', String(open));
  btn.setAttribute('aria-label', open ? 'Close the Claude assistant' : 'Ask Claude about this');
  path.setAttribute('class', open ? '' : 'spark');
  path.setAttribute('d', open ? CLOSE_PATH : CLAUDE_ICON_PATH);
}

// ─── The popup ────────────────────────────────────────────────────────────────

function openPanel() {
  if (panel) return;
  const host = document.createElement('div');
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483645;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .card {
        position: fixed; right: 20px; bottom: 80px;
        width: min(380px, calc(100vw - 40px)); height: min(600px, calc(100vh - 110px));
        border-radius: 16px; overflow: hidden; box-shadow: 0 12px 40px rgba(0,0,0,.35), 0 0 0 1px rgba(0,0,0,.08);
        transform-origin: bottom right; transform: scale(.94) translateY(8px); opacity: 0;
        transition: transform 160ms cubic-bezier(0.16,1,0.3,1), opacity 160ms cubic-bezier(0.16,1,0.3,1);
      }
      :host([data-open="true"]) .card { transform: none; opacity: 1; }
      iframe { border: 0; width: 100%; height: 100%; display: block; color-scheme: normal; }
      @media (prefers-reduced-motion: reduce) { .card { transition: none; } }
    </style>
    <div class="card" role="dialog" aria-label="Claude assistant"></div>`;
  const frame = document.createElement('iframe');
  frame.title = 'Claude assistant';
  frame.src = assistantUrl();
  root.querySelector('.card').append(frame);
  document.documentElement.append(host);
  requestAnimationFrame(() => requestAnimationFrame(() => { host.dataset.open = 'true'; }));
  frame.addEventListener('load', () => frame.focus());
  panel = { host, frame };
  lastCtx = context();
  setFabState(true);
}

function closePanel() {
  if (!panel) return;
  const { host } = panel;
  panel = null;
  host.dataset.open = 'false';
  setTimeout(() => host.remove(), 160);
  setFabState(false);
}

function togglePanel() {
  if (!chrome.runtime?.id) { location.reload(); return; }   // the extension was reloaded while this tab stayed open
  if (panel) closePanel(); else openPanel();
}

// Closing with Escape matches quick-settings-host.js's drawer; outside clicks do NOT close the
// popup, on purpose — the point of a popup over the drawer is that the page stays usable while it
// is open, so a stray click on the backlog must not dismiss it.
document.addEventListener('keydown', e => { if (e.key === 'Escape' && panel) closePanel(); });

// The panel asks to close (its own × button). Only a message from its own iframe counts.
window.addEventListener('message', e => {
  if (!panel || e.source !== panel.frame.contentWindow || e.data?.type !== 'blm-assistant-close') return;
  closePanel();
});

function syncVisibility() {
  if (enabled) createFab(); else removeFab();
}

chrome.storage.local.get(AI_KEY).then(s => { enabled = s[AI_KEY] === true; syncVisibility(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && AI_KEY in changes) { enabled = changes[AI_KEY].newValue === true; syncVisibility(); }
});

// ─── Keep the open popup's context in step with SPA navigation ───────────────
// OpenProject is an Angular SPA: opening/closing a story or switching the query changes the URL
// without a full reload, so this script is never re-injected — watch for it instead.

let lastCtx = null;

function pushContextIfOpen() {
  if (!panel) return;
  const c = context();
  if (lastCtx && lastCtx.wp === c.wp && lastCtx.project === c.project) return;
  lastCtx = c;
  panel.frame.contentWindow.postMessage({ type: 'blm-assistant-context', ...c }, '*');
}

let navDebounce = null;
function onNavigationDetected() {
  clearTimeout(navDebounce);
  navDebounce = setTimeout(pushContextIfOpen, 300);
}

if (typeof window.navigation !== 'undefined') {
  window.navigation.addEventListener('navigate', onNavigationDetected);
}
(function patchHistory() {
  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = function (...args) { _push(...args); onNavigationDetected(); };
  history.replaceState = function (...args) { _replace(...args); onNavigationDetected(); };
})();
