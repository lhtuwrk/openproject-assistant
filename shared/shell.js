// shell.js — builds the dashboard rail (brand · profile · nav · foot) on every
// dashboard page. The page says which nav item is current with
// <body data-page="settings|burndown|timelog|planning">.

import { ME_KEY, AVATAR_KEY, refreshMe, paintAvatar, currentSprint, sprintHours } from './me.js';

import { requireHost } from './config.js';
const BACKLOG_URL       = await requireHost();
const META_KEY          = '__blm_sync_meta';
const TRACKED_KEY       = '__blm_tracked';
const CFG_SYNC_BURNDOWN = '__blm_sync_burndown';
const STATS_KEY         = '__blm_me_stats';   // last sprint stats, painted before the refetch

const ICONS = {
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  burndown: '<path d="M3 3v18h18"/><path d="M7 7l4 4 3-2 5 6"/>',
  timelog:  '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4M12 13v3l2 1"/>',
  planning: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
};
const NAV = [
  { page: 'settings', href: 'dashboard.html', label: 'Settings' },
  { page: 'burndown', href: 'viewer.html',    label: 'Burndown' },
  { page: 'timelog',  href: 'timelog.html',   label: 'Time log' },
  { page: 'planning', href: 'planning.html',  label: 'Planning' },
];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = name => `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

function relativeTime(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

// The rail is built once, from cached state, so switching pages repaints it
// identically. Fresh data then only touches the DOM when a value changed.

function buildRail() {
  const current = document.body.dataset.page;
  const rail = document.createElement('aside');
  rail.className = 'rail';
  rail.setAttribute('aria-label', 'Backlog Monitor');
  rail.innerHTML = `
    <div class="rail-top">
      <a class="rail-brand" href="dashboard.html" title="Backlog Monitor">
        <img src="/icons/icon-32.png" alt="" width="22" height="22" />
        <span>Backlog Monitor</span>
        <span class="ver">v${esc(chrome.runtime.getManifest().version)}</span>
      </a>
      <button type="button" class="rail-toggle" aria-expanded="true" aria-label="Collapse the sidebar" title="Collapse the sidebar"></button>
    </div>
    <section class="profile loading" aria-label="Your account">
      <div class="profile-id">
        <span class="avatar" aria-hidden="true"></span>
        <div class="profile-who"><div class="profile-name">Loading account</div><div class="profile-login">&nbsp;</div></div>
      </div>
      <div class="profile-stats" hidden></div>
    </section>
    <nav class="rail-nav" aria-label="Dashboard">
      ${NAV.map(n => `<a href="${n.href}" data-nav="${n.page}" title="${n.label}"${n.page === current ? ' aria-current="page"' : ''}>${icon(n.page)}<span>${n.label}</span></a>`).join('')}
    </nav>
    <div class="rail-foot">
      <div class="sync-line" hidden><span class="dot"></span><span class="txt"></span></div>
      <a href="${BACKLOG_URL}" target="_blank" rel="noopener">Open the backlog ↗</a>
    </div>`;
  return rail;
}

// ── Profile ──────────────────────────────────────────────────────────────────

function renderIdentity(rail, me, avatar) {
  const card = rail.querySelector('.profile');
  card.classList.remove('loading');
  card.querySelector('.profile-name').textContent = me.name;
  card.querySelector('.profile-name').title = me.name;
  card.querySelector('.profile-login').textContent = me.email ?? me.login ?? '';
  paintAvatar(card.querySelector('.avatar'), me, avatar);
}

function renderSignedOut(rail) {
  const card = rail.querySelector('.profile');
  card.classList.remove('loading');
  card.innerHTML = `<p class="profile-signin">You're signed out of the backlog. <a href="${BACKLOG_URL}" target="_blank" rel="noopener">Sign in ↗</a> to see your account and time.</p>`;
}

function statsHtml(st) {
  const sprintPc = st.total ? Math.round((st.elapsed / st.total) * 100) : 0;
  const hoursPc  = st.expected ? Math.min(100, Math.round((st.logged / st.expected) * 100)) : 0;
  const note = st.missing
    ? `<div class="profile-note">${st.missing} day${st.missing === 1 ? '' : 's'} not logged yet</div>`
    : st.elapsed ? '<div class="profile-note ok">Every day logged so far</div>' : '';
  return `
    <div class="stat">
      <div class="stat-row"><span>Sprint ${esc(st.name)}</span><b>day ${st.elapsed}<small> / ${st.total}</small></b></div>
      <div class="meter" role="presentation"><i style="--fill:${sprintPc}%"></i></div>
    </div>
    <div class="stat">
      <div class="stat-row"><span>Logged</span><b>${st.logged.toFixed(1)}<small> / ${st.expected.toFixed(0)} h</small></b></div>
      <div class="meter${st.logged + 0.005 < st.expected ? ' short' : ''}" role="presentation"><i style="--fill:${hoursPc}%"></i></div>
    </div>
    ${note}`;
}

function paintStats(rail, st) {
  const box = rail.querySelector('.profile-stats');
  if (!box) return;
  const html = statsHtml(st);
  if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }
  box.hidden = false;
}

async function refreshProfile(rail, cached) {
  try {
    const me = await refreshMe();
    if (!cached.me || cached.me.id !== me.id || cached.me.name !== me.name || cached.me.email !== me.email) {
      renderIdentity(rail, me, cached.me?.id === me.id ? cached.avatar : null);
    }
    const sprint = currentSprint();
    if (!sprint) return;
    const h = await sprintHours(sprint);
    const st = { sprint: sprint.key, name: sprint.name, elapsed: h.elapsedDays, total: h.weekdays.length,
                 logged: h.logged, expected: h.expected, missing: h.missing };
    paintStats(rail, st);
    await chrome.storage.local.set({ [STATS_KEY]: st });
  } catch (err) {
    if (err?.code === 'NOT_AUTHENTICATED') renderSignedOut(rail);
    else if (!cached.me) rail.querySelector('.profile-name').textContent = 'Account unavailable';
  }
}

// ── Burndown status ──────────────────────────────────────────────────────────

function renderSync(rail, s) {
  const on = s[CFG_SYNC_BURNDOWN] ?? true;
  const line = rail.querySelector('.sync-line');
  const navLink = rail.querySelector('[data-nav="burndown"]');

  // Sync off → Burndown leaves the nav (kept while you're on it, so you're not stranded).
  navLink.hidden = !on && document.body.dataset.page !== 'burndown';

  const tracked = on ? (s[TRACKED_KEY] ?? []).length : 0;
  let count = navLink.querySelector('.count');
  if (tracked && !count) {
    count = document.createElement('span');
    count.className = 'count';
    count.title = 'Tracked versions';
    navLink.append(count);
  }
  if (count) { if (tracked) count.textContent = tracked; else count.remove(); }

  const meta = s[META_KEY];
  line.hidden = !on || !meta;
  if (line.hidden) return;
  line.className = `sync-line ${meta.status}`;
  line.querySelector('.txt').textContent =
    meta.status === 'syncing' ? 'Syncing burndown…'
    : meta.status === 'error' ? (meta.error === 'not-authenticated' ? 'Sync failed: signed out' : 'Sync failed')
    : `Burndown synced ${relativeTime(meta.lastSync)}`;
}

const SYNC_KEYS = [META_KEY, TRACKED_KEY, CFG_SYNC_BURNDOWN];
const state = await chrome.storage.local.get([ME_KEY, AVATAR_KEY, STATS_KEY, ...SYNC_KEYS]);
const rail = buildRail();
const cached = { me: state[ME_KEY] ?? null, avatar: state[AVATAR_KEY] ?? null };
if (cached.me) renderIdentity(rail, cached.me, cached.avatar);
if (state[STATS_KEY]?.sprint === currentSprint()?.key) paintStats(rail, state[STATS_KEY]);
renderSync(rail, state);
document.body.prepend(rail);

// ── Collapse and resize ──────────────────────────────────────────────────────
// The state lives in rail-prefs.js (window.blmRail), which sets --rail-w before first paint.
{
  const prefs = window.blmRail;
  const toggle = rail.querySelector('.rail-toggle');
  toggle.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
  const handle = document.createElement('div');
  handle.className = 'rail-resize';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the sidebar (drag, or use the arrow keys)');
  handle.tabIndex = 0;
  rail.after(handle);

  const sync = () => {
    const { w, collapsed } = prefs.get();
    const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', label);
    toggle.title = label;
    handle.hidden = collapsed;
    handle.setAttribute('aria-valuemin', prefs.MIN);
    handle.setAttribute('aria-valuemax', prefs.MAX);
    handle.setAttribute('aria-valuenow', w);
  };
  sync();
  document.addEventListener('blm-rail-change', sync);
  toggle.addEventListener('click', () => prefs.set({ collapsed: !prefs.get().collapsed }));

  // Drag the edge to resize; dragging far enough in collapses it. Double-click resets the width.
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('rail-resizing');
    let x = e.clientX;
    const move = ev => { x = ev.clientX; prefs.preview(x); };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.documentElement.classList.remove('rail-resizing');
      if (x < prefs.MIN - 60) prefs.set({ collapsed: true });
      else prefs.set({ w: x, collapsed: false });
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => prefs.set({ w: prefs.DEFAULT }));
  handle.addEventListener('keydown', e => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); prefs.set({ w: prefs.get().w - step }); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); prefs.set({ w: prefs.get().w + step }); }
    else if (e.key === 'Home') { e.preventDefault(); prefs.set({ w: prefs.MIN }); }
    else if (e.key === 'End') { e.preventDefault(); prefs.set({ w: prefs.MAX }); }
  });
}

// ── Experimental options: tap your avatar seven times, like Android's developer mode ──
const DEV_KEY = '__blm_dev_unlocked';
let railToastEl = null, railToastT = null;

function railToast(msg) {
  railToastEl ??= Object.assign(document.createElement('div'), { className: 'rail-toast', role: 'status' });
  if (!railToastEl.isConnected) document.body.append(railToastEl);
  railToastEl.textContent = msg;
  railToastEl.classList.add('show');
  clearTimeout(railToastT);
  railToastT = setTimeout(() => railToastEl.classList.remove('show'), 2200);
}

{
  let taps = 0, last = 0;
  rail.querySelector('.profile').addEventListener('click', async e => {   // delegated: the card is rebuilt when signed out
    if (!e.target.closest('.avatar')) return;
    const now = Date.now();
    taps = now - last > 2000 ? 1 : taps + 1;
    last = now;
    if (taps < 7) {
      if (taps >= 3) railToast(`${7 - taps} more tap${7 - taps === 1 ? '' : 's'} to unlock experimental options`);
      return;
    }
    taps = 0;
    if ((await chrome.storage.local.get(DEV_KEY))[DEV_KEY]) { railToast('Experimental options are already unlocked. Find them in Settings.'); return; }
    await chrome.storage.local.set({ [DEV_KEY]: true });
    railToast('Experimental options unlocked. Find them in Settings.');
  });
}

refreshProfile(rail, cached);
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'local' && SYNC_KEYS.some(k => k in changes)) renderSync(rail, await chrome.storage.local.get(SYNC_KEYS));
});
