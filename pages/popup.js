import { cachedMe, refreshMe, paintAvatar, sprints, sprintHours, todayStr } from '../shared/me.js';

const TASK_KEY          = '__blm_logtime_task';      // written by reminder.js
const DATE_KEY_PATTERN  = /^\d{4}-\d{2}-\d{2}__.+$/;
const META_KEY          = '__blm_sync_meta';
const TRACKED_KEY       = '__blm_tracked';
const CFG_SYNC_BURNDOWN = '__blm_sync_burndown';     // default: true
import { requireHost } from '../shared/config.js';
const BACKLOG_URL       = await requireHost();

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function relativeTime(isoStr) {
  if (!isoStr) return null;
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}

/** Focuses an open dashboard tab for `page`, or opens one. */
async function openPage(page) {
  const url  = chrome.runtime.getURL('pages/' + page);
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
}

document.querySelectorAll('[data-open]').forEach(btn =>
  btn.addEventListener('click', () => openPage(btn.dataset.open)));

// Quick settings open as a drawer on the right of the current page (content
// script quick-settings-host.js). Where no content script can run (chrome://
// pages, tabs opened before the extension was reloaded), Chrome's side panel is
// used instead, then the Settings page.
document.getElementById('btn-settings').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const own = tab?.url?.startsWith(chrome.runtime.getURL(''));   // the dashboard pages load the same drawer script
    if (!own && !/^https?:/.test(tab?.url ?? '')) throw new Error('no content script here');
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'blm-quick-settings' });
    if (!res?.ok) throw new Error('drawer not available');
    window.close();
    return;
  } catch { /* fall through */ }
  try {
    await chrome.sidePanel.open({ windowId: tab?.windowId ?? (await chrome.windows.getCurrent()).id });
    window.close();
  } catch {
    openPage('dashboard.html');
  }
});

// ─── Account ─────────────────────────────────────────────────────────────────

function renderMe(me) {
  document.getElementById('me-name').textContent = me.name;
  document.getElementById('me-sub').textContent  = me.email ?? me.login ?? '';
  paintAvatar(document.getElementById('me-avatar'), me);
}

function renderSignedOut() {
  document.getElementById('me-name').textContent = 'Not signed in';
  document.getElementById('me-sub').innerHTML = `<a href="#" id="me-login">Sign in to the backlog ↗</a>`;
  document.getElementById('me-login').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: BACKLOG_URL });
  });
  const av = document.getElementById('me-avatar');
  av.textContent = '?';
}

async function initMe() {
  const cached = await cachedMe();
  if (cached) renderMe(cached);
  try {
    const me = await refreshMe();
    if (!cached || cached.id !== me.id || cached.name !== me.name) renderMe(me);
  } catch (err) {
    if (err?.code === 'NOT_AUTHENTICATED') renderSignedOut();
  }
}

// ─── Burndown ────────────────────────────────────────────────────────────────

function renderSyncStatus(meta) {
  const el = document.getElementById('sync-status');
  if (!meta) { el.innerHTML = ''; return; }
  el.className = `sync-line ${meta.status}`;
  let text;
  if (meta.status === 'syncing') {
    text = 'Syncing…';
  } else if (meta.status === 'error') {
    text = meta.error === 'not-authenticated' ? 'Signed out' : 'Sync failed';
  } else {
    text = relativeTime(meta.lastSync) ?? 'Synced';
  }
  el.title = meta.status === 'error' ? String(meta.error) : '';
  el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
}

async function loadBurndown() {
  const all  = await chrome.storage.local.get(null);
  const card = document.getElementById('burndown-card');
  card.hidden = !(all[CFG_SYNC_BURNDOWN] ?? true);
  document.querySelector('.nav [data-open="viewer.html"]').hidden = card.hidden;
  if (card.hidden) return;

  const today   = todayStr();
  const tracked = (all[TRACKED_KEY] ?? []).map(v => v.versionName);
  renderSyncStatus(all[META_KEY] ?? null);

  const list    = document.getElementById('backlog-list');
  const copyBtn = document.getElementById('btn-copy-charts');

  if (!tracked.length) {
    list.innerHTML = `<li class="empty">No versions tracked yet. <a href="#" id="link-configure">Choose versions →</a></li>`;
    document.getElementById('link-configure').addEventListener('click', e => { e.preventDefault(); openPage('viewer.html'); });
    copyBtn.disabled = true;
    return;
  }

  const syncedToday = new Map();
  for (const [key, snap] of Object.entries(all)) {
    if (!DATE_KEY_PATTERN.test(key) || !snap?.backlogVersion) continue;
    const name = snap.backlogVersion;
    if (!syncedToday.has(name)) syncedToday.set(name, false);
    if (key.slice(0, 10) === today) syncedToday.set(name, true);
  }

  list.innerHTML = tracked
    .map(name => [name, syncedToday.get(name) ?? false])
    .sort((a, b) => Number(b[1]) - Number(a[1]) || a[0].localeCompare(b[0]))
    .map(([name, ok]) =>
      `<li><span class="vname" title="${esc(name)}">${esc(name)}</span>` +
      `<span class="tag ${ok ? 'ok' : 'warn'}">${ok ? 'Synced' : 'Not synced'}</span></li>`)
    .join('');

  copyBtn.disabled = false;
  copyBtn.onclick = async () => {
    await chrome.storage.local.set({ '__blm_copy_req': { versions: tracked, ts: Date.now() } });
    openPage('viewer.html');
  };
}

document.getElementById('btn-sync').addEventListener('click', async () => {
  const btn = document.getElementById('btn-sync');
  btn.disabled = true;
  btn.textContent = 'Syncing…';

  try { chrome.runtime.sendMessage({ type: 'sync-now' }); } catch { /* sw may be asleep */ }

  let polls = 0;
  const timer = setInterval(async () => {
    polls++;
    const meta = (await chrome.storage.local.get(META_KEY))[META_KEY];
    renderSyncStatus(meta ?? null);
    if (meta?.status === 'ok' || meta?.status === 'error' || polls >= 60) {
      clearInterval(timer);
      btn.disabled    = false;
      btn.textContent = 'Sync now';
      if (meta?.status === 'ok') loadBurndown();
    }
  }, 500);
});

// ─── Log-time task (computed by reminder.js in the background) ───────────────

function renderTask(task) {
  const card = document.getElementById('task-card');
  const open = (task?.items ?? []).filter(i => !i.acked);
  if (!open.length) { card.hidden = true; return; }

  const due = i => i.daysLeft <= 0 ? 'ends today' : i.daysLeft === 1 ? 'ends tomorrow' : `ends ${i.deadline.slice(5).replace('-', '/')}`;
  card.hidden = false;
  card.innerHTML = `
    <div class="card-head"><h2 class="card-title">Log your time</h2></div>
    ${open.map(i => `<div class="task-item">
        <div class="body">
          <div><strong>${esc(i.name)}</strong> <span class="due">${due(i)}</span></div>
          <div class="hint">Log your hours, then click Done.</div>
        </div>
        <button class="btn" data-key="${esc(i.key)}" title="I have logged my time for this period">Done</button>
      </div>`).join('')}`;
}

document.getElementById('task-card').addEventListener('click', e => {
  const btn = e.target.closest('button[data-key]');
  if (!btn) return;
  btn.disabled = true;
  chrome.runtime.sendMessage({ type: 'logtime-ack', key: btn.dataset.key });
});

chrome.storage.local.get(TASK_KEY).then(s => renderTask(s[TASK_KEY]));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && TASK_KEY in changes) renderTask(changes[TASK_KEY].newValue);
});
chrome.runtime.sendMessage({ type: 'logtime-refresh' });   // fresh numbers every time the popup opens

// ─── My time: the signed-in user's hours per weekday of a sprint ─────────────

let mySprints = [];

function mtMessage(html) {
  document.getElementById('mt-grid').innerHTML = `<div class="mt-msg">${html}</div>`;
  document.getElementById('mt-summary').textContent = '';
}

function mtError(err) {
  if (err?.code === 'NOT_AUTHENTICATED') {
    mtMessage('<a href="#" id="mt-login">Sign in to the backlog</a> to see your time.');
    document.getElementById('mt-login')?.addEventListener('click', e => {
      e.preventDefault();
      chrome.tabs.create({ url: BACKLOG_URL });
    });
  } else {
    mtMessage(`Could not load your time: ${esc(err?.message ?? err)}`);
  }
}

function loadMySprints() {
  const today = todayStr();
  mySprints = sprints(today);
  const isCurrent = p => p.startDate <= today && today <= p.endDate;
  const sel = document.getElementById('mt-sprint');
  sel.innerHTML = mySprints.map(p => {
    const [, sm, sd] = p.startDate.split('-'), [, em, ed] = p.endDate.split('-');
    return `<option value="${p.key}" class="${isCurrent(p) ? 'current' : ''}">${p.name} · ${sm}/${sd}–${em}/${ed}</option>`;
  }).join('');
  const pick = mySprints.find(isCurrent) ?? mySprints[0];
  if (pick) sel.value = pick.key;
  sel.disabled = !mySprints.length;
}

let myTimeSeq = 0;
async function renderMyTime() {
  const seq = ++myTimeSeq;
  const p = mySprints.find(x => x.key === document.getElementById('mt-sprint').value);
  if (!p) { mtMessage('No sprints found.'); return; }

  let h;
  try { h = await sprintHours(p); }
  catch (err) { if (seq !== myTimeSeq) return; throw err; }   // a stale failure must not replace a newer result
  if (seq !== myTimeSeq) return;   // a newer sprint pick superseded this one
  document.getElementById('mt-grid').innerHTML = h.weekdays.map(d => {
    const dow = DOW[new Date(d.date + 'T12:00:00Z').getUTCDay()];
    const txt = d.state === 'miss' ? '—' : d.state === 'future' ? '·' : d.hours.toFixed(2);
    return `<div class="mt-day ${d.state}${d.today ? ' today' : ''}" title="${dow} ${d.date} · ${d.hours.toFixed(2)} h">` +
           `<span class="d">${dow} ${d.date.slice(8)}</span><b>${txt}</b></div>`;
  }).join('');

  document.getElementById('mt-summary').innerHTML =
    `<strong>${h.logged.toFixed(2)} h</strong> of ${h.expected.toFixed(2)} h to date` +
    (h.missing ? ` · <strong>${h.missing}</strong> day${h.missing === 1 ? '' : 's'} missing` : '') +
    (h.weekend > 0 ? ` · +${h.weekend.toFixed(2)} h weekend` : '');
}

async function initMyTime() {
  try {
    loadMySprints();
    await renderMyTime();
  } catch (err) { mtError(err); }
}

document.getElementById('mt-sprint').addEventListener('change', () => {
  renderMyTime().catch(mtError);
});

initMe();
initMyTime();
loadBurndown();
