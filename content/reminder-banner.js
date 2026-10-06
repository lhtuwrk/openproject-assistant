// reminder-banner.js — floating log-time reminder, injected on every website
//
// Renders the task computed by reminder.js (chrome.storage.local TASK_KEY) as a
// small card in the bottom-right corner. It never reads the host page: it only
// reads/writes the extension's own storage. Lives in a shadow root so the
// page's CSS can't reach it (and ours can't leak out).
//
// Shown only from SHOW_FROM_HOUR on a due day (reminder.js already limits the
// task to the deadline day and the working day before). Snooze is stored in
// chrome.storage.local so it applies to every tab at once.

'use strict';

(() => {
  const TASK_KEY       = '__blm_logtime_task';
  const FLOAT_KEY      = '__blm_logtime_float';   // { snoozeUntil: epochMs }
  const SHOW_FROM_HOUR = 16;
  const SNOOZE_MS      = 3600 * 1000;
  const RECHECK_MS     = 60 * 1000;               // re-evaluate the hour gate / snooze expiry

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let host = null;
  let task = null;
  let float = {};
  let lastHtml = '';

  function remove() { host?.remove(); host = null; lastHtml = ''; }

  function render() {
    const open = (task?.items ?? []).filter(i => !i.acked);
    const visible = open.length
      && new Date().getHours() >= SHOW_FROM_HOUR
      && Date.now() >= (float.snoozeUntil ?? 0);
    if (!visible) { remove(); return; }

    if (!host) {
      host = document.createElement('div');
      host.id = 'blm-logtime-reminder';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }

    const due = i => i.daysLeft <= 0 ? 'ends today' : i.daysLeft === 1 ? 'ends tomorrow' : `ends ${i.deadline.slice(5).replace('-', '/')}`;
    // Collapsed to a small dot; the card opens after hovering 0.5 s (instantly on
    // keyboard focus) and stays open briefly after the pointer leaves so it can
    // be reached. Pure CSS, so there are no timers to leak.
    const clock = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`;
    const html = `
      <style>
        :host { all: initial; }
        .wrap {
          position: fixed; right: 20px; bottom: 20px; z-index: 2147483000;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #e6e7ea;
        }
        .dot {
          position: relative; width: 40px; height: 40px; border-radius: 50%; padding: 0; cursor: pointer;
          display: flex; align-items: center; justify-content: center; margin-left: auto;
          background: #18191c; color: #f2828f; border: 2px solid #f2828f;
          box-shadow: 0 4px 14px rgba(0,0,0,.35);
        }
        .dot:hover { background: #2a2c31; }
        .dot:focus-visible { outline: 2px solid #4c7dff; outline-offset: 2px; }
        .count {
          position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px; box-sizing: border-box;
          border-radius: 8px; background: #f2828f; color: #18191c; font-size: 10px; font-weight: 700; line-height: 16px; text-align: center;
        }
        /* Card sits above the dot; padding-bottom bridges the gap so hover isn't lost. */
        .pop {
          position: absolute; right: 0; bottom: 100%; padding-bottom: 10px;
          opacity: 0; visibility: hidden; transform: translateY(4px);
          transition: opacity .15s cubic-bezier(.4,0,1,1) .3s, transform .15s cubic-bezier(.4,0,1,1) .3s, visibility 0s linear .45s;
        }
        .wrap:hover .pop {
          opacity: 1; visibility: visible; transform: none;
          transition: opacity .15s cubic-bezier(0,0,.2,1) .5s, transform .15s cubic-bezier(0,0,.2,1) .5s, visibility 0s linear .5s;
        }
        .wrap:focus-within .pop { opacity: 1; visibility: visible; transform: none; transition: none; }
        .card {
          width: 300px; max-width: calc(100vw - 40px); box-sizing: border-box;
          background: #18191c; border: 1px solid #3a3d44; border-left: 3px solid #f2828f;
          border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.35); padding: 12px 14px;
        }
        .head { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 6px; }
        .item { margin: 4px 0; }
        .item b { color: #e6e7ea; }
        .due { color: #f2828f; font-weight: 600; }
        .days { color: #a0a3ab; font-size: 12px; margin-top: 4px; }
        .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
        button.act {
          font: inherit; font-size: 12px; font-weight: 600; border-radius: 5px; padding: 5px 10px; cursor: pointer;
          border: 1px solid #3a3d44; background: #2a2c31; color: #e6e7ea; white-space: nowrap;
        }
        button.act:hover { background: #3a3d44; }
        button.primary { background: #4c7dff; border-color: #4c7dff; color: #ffffff; }
        button.primary:hover { background: #3d6bf0; }
        button.act:focus-visible { outline: 2px solid #4c7dff; outline-offset: 2px; }
        @media (prefers-reduced-motion: reduce) { .pop, .wrap:hover .pop { transform: none; } }
      </style>
      <div class="wrap">
        <div class="pop">
          <div class="card" role="status">
            <div class="head">${clock} Log your time</div>
            ${open.map(i => `<div class="item"><b>${esc(i.name)}</b> <span class="due">${due(i)}</span></div>`).join('')}
            <div class="days">Complete your log time, then click Done.</div>
            <div class="actions">
              <button id="snooze" class="act">Snooze 1 h</button>
              <button id="done" class="act primary">Done</button>
            </div>
          </div>
        </div>
        <button class="dot" aria-label="Log your time reminder">${clock}${open.length > 1 ? `<span class="count">${open.length}</span>` : ''}</button>
      </div>`;
    if (html === lastHtml) return;       // periodic re-checks must not rebuild (keeps focus, no flicker)
    host.shadowRoot.innerHTML = lastHtml = html;

    const root = host.shadowRoot;
    root.getElementById('snooze').onclick = () => chrome.storage.local.set({ [FLOAT_KEY]: { ...float, snoozeUntil: Date.now() + SNOOZE_MS } });
    root.getElementById('done').onclick   = () => open.forEach(i => chrome.runtime.sendMessage({ type: 'logtime-ack', key: i.key }));
  }

  chrome.storage.local.get([TASK_KEY, FLOAT_KEY]).then(s => {
    task  = s[TASK_KEY] ?? null;
    float = s[FLOAT_KEY] ?? {};
    render();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (TASK_KEY in changes)  task  = changes[TASK_KEY].newValue ?? null;
    if (FLOAT_KEY in changes) float = changes[FLOAT_KEY].newValue ?? {};
    if (TASK_KEY in changes || FLOAT_KEY in changes) render();
  });
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); remove(); return; }   // extension reloaded/removed
    if (!document.hidden) render();
  }, RECHECK_MS);
})();
