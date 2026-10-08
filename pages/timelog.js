// timelog.js — Member × Day spent-time grid for a project + sprint date range.
//
// Reads time entries live from the OpenProject API (session cookies, no key).
// Member groups live in chrome.storage.sync so they follow the Chrome profile;
// they are project-agnostic lists of user ids.

import {
  fetchActiveProjects, fetchTimeEntries,
  fetchProjectMembers, fetchUserName, fetchUserAvatar, sprintCalendar, fetchMyUserId,
  fetchMyOpenWorkPackages, searchWorkPackages, fetchWorkPackagesByIds, fetchWpTime, fetchTimeEntryForm, createTimeEntry, deleteTimeEntry, updateTimeEntry,
} from '../shared/api.js';

import { requireHost } from '../shared/config.js';
const BACKLOG_URL   = await requireHost();
const GROUPS_KEY    = '__blm_timelog_groups';   // sync:  [{ id, name, userIds:[] }]
const LAST_KEY      = '__blm_timelog_last';     // local: { projectIds, sprintKey, groupId }
const DEFAULT_PROJECT = 'creditutility';        // compared with spaces stripped, lower-cased
const DAILY_TARGET  = 8;
const OVER_TARGET   = 9;
const EPS           = 0.005;

const $ = id => document.getElementById(id);

const state = {
  projects:  [],
  projectIds: [],         // selected project ids (strings)
  sprints:   [],          // [{ key:'start|end', name, startDate, endDate }]
  members:   new Map(),   // projectId → Map(userId → name)
  userNames: new Map(),   // userId → name, from any source
  groups:    [],
  last:      {},
  entries:   [],
  sort:      { key: 'name', dir: 'ascending' },
  loadSeq:   0,
  meId:      null,        // signed-in user, highlighted in the grid
  editingId: null,        // group being edited in the drawer, null = new
};

// ─── Utils ────────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function datesInRange(from, to) {
  const out = [];
  const d = new Date(from + 'T12:00:00Z');
  const end = new Date(to + 'T12:00:00Z');
  while (d <= end && out.length < 370) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

function dayOfWeek(dateStr) { return new Date(dateStr + 'T12:00:00Z').getUTCDay(); }
function isWeekend(dateStr) { const w = dayOfWeek(dateStr); return w === 0 || w === 6; }
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function mmdd(dateStr)    { const [, m, d] = dateStr.split('-'); return `${m}/${d}`; }
function mmddyyyy(dateStr){ const [y, m, d] = dateStr.split('-'); return `${m}/${d}/${y}`; }
const fmtH = h => h.toFixed(2);

function nameFor(userId) { return state.userNames.get(userId) || `User #${userId}`; }

// ─── Avatars ──────────────────────────────────────────────────────────────────
// Rendered as an initials disc first, then swapped for the real image once it
// arrives. One fetch per user per page load; failures keep the initials.

const avatarCache = new Map();   // userId → Promise<string|null> (object URL)

function initials(name) {
  const parts = name.replace(/^User #/, '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0], last = parts.length > 1 ? parts[parts.length - 1][0] : '';
  return (first + last).toUpperCase();
}

function avatarHue(userId) {
  let h = 0;
  for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.round((h * 137.508) % 360);   // golden-angle spread: neighbouring ids get distant hues
}

function avatarHtml(userId, name) {
  return `<span class="avatar" data-uid="${esc(userId)}" style="--hue:${avatarHue(userId)}" aria-hidden="true">${esc(initials(name))}</span>`;
}

function avatarUrl(userId) {
  if (!avatarCache.has(userId)) {
    avatarCache.set(userId, fetchUserAvatar(userId).then(b => {
      if (b === undefined) avatarCache.delete(userId);   // transient failure: try again next render
      return b ? URL.createObjectURL(b) : null;
    }));
  }
  return avatarCache.get(userId);
}

function hydrateAvatars(root) {
  root.querySelectorAll('.avatar[data-uid]:not(.has-img)').forEach(async el => {
    const url = await avatarUrl(el.dataset.uid);
    if (!url || !el.isConnected) return;
    el.style.backgroundImage = `url("${url}")`;
    el.classList.add('has-img');
  });
}

async function saveLast(patch) {
  state.last = { ...state.last, ...patch };
  await chrome.storage.local.set({ [LAST_KEY]: state.last });
}

// ─── Banner / toast ───────────────────────────────────────────────────────────

function showBanner(msg, actionLabel, onAction) {
  $('banner-msg').textContent = msg;
  const btn = $('banner-action');
  btn.textContent = actionLabel;
  btn.onclick = onAction;
  $('banner').classList.add('show');
}
function hideBanner() { $('banner').classList.remove('show'); }

function handleError(err, retry) {
  if (err?.code === 'NOT_AUTHENTICATED') {
    showBanner(`Session expired — sign in at ${new URL(BACKLOG_URL).host}, then Refresh.`, 'Open backlog',
      () => chrome.tabs.create({ url: BACKLOG_URL }));
  } else {
    showBanner(`Could not load data: ${err?.message ?? err}`, 'Retry', retry);
  }
}

let toastTimer = null;
function showToast(msg, actionLabel, onAction, ms = 6000) {
  $('toast-msg').textContent = msg;
  const btn = $('toast-action');
  btn.textContent = actionLabel ?? '';
  btn.style.display = actionLabel ? '' : 'none';
  btn.onclick = () => { hideToast(); onAction?.(); };
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, ms);
}
function hideToast() { $('toast').classList.remove('show'); }

// ─── Selectors ────────────────────────────────────────────────────────────────

function renderGroupSelect() {
  const sel = $('sel-group');
  const current = sel.value || state.last.groupId || '';
  sel.innerHTML = '<option value="">Everyone who logged</option>' +
    state.groups.map(g => `<option value="${esc(g.id)}">${esc(g.name)} (${g.userIds.length})</option>`).join('');
  sel.value = state.groups.some(g => g.id === current) ? current : '';
}

const projectName = id => state.projects.find(p => String(p.id) === id)?.name ?? `#${id}`;
const selectedProjectNames = () => state.projectIds.map(projectName);

function renderProjectButton() {
  const names = selectedProjectNames();
  const btn = $('btn-projects');
  btn.textContent = names.length > 1 ? `${names[0]} +${names.length - 1}` : (names[0] ?? 'No project');
  btn.title = names.join(', ');
}

function renderProjectList() {
  const selected = new Set(state.projectIds);
  $('project-list').innerHTML = state.projects.map(p => `<label data-name="${esc(p.name.toLowerCase())}">
      <input type="checkbox" value="${p.id}" ${selected.has(String(p.id)) ? 'checked' : ''} /><span>${esc(p.name)}</span>
    </label>`).join('');
}

async function loadProjects() {
  state.projects = (await fetchActiveProjects()).sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(state.projects.map(p => String(p.id)));
  const saved = (state.last.projectIds ?? []).map(String).filter(id => known.has(id));
  const fallback = state.projects.find(p => p.name.replace(/\s+/g, '').toLowerCase() === DEFAULT_PROJECT)
                ?? state.projects[0];
  state.projectIds = saved.length ? saved : (fallback ? [String(fallback.id)] : []);
  renderProjectButton();
  $('btn-projects').disabled = !state.projects.length;
}

function loadSprints() {
  const sel = $('sel-sprint');
  const today = localDateStr();
  state.sprints = sprintCalendar(today);

  const isCurrent = p => p.startDate <= today && today <= p.endDate;
  sel.innerHTML = '<option value="">Custom range</option>' +
    state.sprints.map(p => `<option value="${p.key}" class="${isCurrent(p) ? 'current' : ''}">${esc(p.name)} · ${mmdd(p.startDate)} – ${mmdd(p.endDate)}</option>`).join('');

  const pick = state.sprints.find(p => p.key === state.last.sprintKey)
            ?? state.sprints.find(isCurrent)
            ?? state.sprints[0];
  if (pick) {
    sel.value = pick.key;
    $('inp-from').value = pick.startDate;
    $('inp-to').value   = pick.endDate;
  } else if (!$('inp-from').value) {
    $('inp-from').value = today;
    $('inp-to').value   = today;
  }
  sel.disabled = false;
}

async function projectMembers(projectId) {
  if (!state.members.has(projectId)) {
    const list = await fetchProjectMembers(projectId);
    state.members.set(projectId, new Map(list.map(m => [m.id, m.name])));
    list.forEach(m => m.name && state.userNames.set(m.id, m.name));
  }
  return state.members.get(projectId);
}

/** Union of members across the selected projects: Map(userId → name). */
async function selectedMembers() {
  const maps = await Promise.all(state.projectIds.map(projectMembers));
  return new Map(maps.flatMap(m => [...m]));
}

function cachedSelectedMembers() {
  return new Map(state.projectIds.flatMap(id => [...(state.members.get(id) ?? [])]));
}

// ─── Load + render grid ───────────────────────────────────────────────────────

function renderSkeleton() {
  const wrap = $('grid-wrap');
  if (wrap.querySelector('table.ledger:not(.skel-table)')) { wrap.classList.add('loading'); return; }
  const cols = 10;
  const row = `<tr class="skel">${'<td></td>'.repeat(cols)}</tr>`;
  wrap.innerHTML = `<table class="ledger skel-table"><tbody>${row.repeat(6)}</tbody></table>`;
}

// Names of group members nobody has seen yet (not in project, no entries). Ids that
// could not be resolved (hidden/deleted users) are remembered so they are asked once.
const unresolvedNames = new Set();
async function resolveGroupNames() {
  const group = state.groups.find(g => g.id === $('sel-group').value);
  const unknown = (group?.userIds ?? []).filter(id => !state.userNames.has(id) && !unresolvedNames.has(id));
  if (!unknown.length) return;
  const names = await Promise.all(unknown.map(fetchUserName));
  unknown.forEach((id, i) => {
    if (names[i]) state.userNames.set(id, names[i]); else unresolvedNames.add(id);
  });
}

// A group only filters rows already loaded, so switching groups re-renders instead of refetching.
async function showGroup() {
  await resolveGroupNames();
  renderGrid();
}

async function load() {
  const seq = ++state.loadSeq;
  const from = $('inp-from').value, to = $('inp-to').value;
  if (!state.projectIds.length || !from || !to) return;
  if (from > to) { $('summary').textContent = 'The From date is after the To date.'; $('grid-wrap').innerHTML = ''; return; }

  hideBanner();
  renderSkeleton();
  $('btn-refresh').disabled = true;

  try {
    const [entries] = await Promise.all([
      fetchTimeEntries(state.projectIds, from, to),
      selectedMembers().catch(() => {}),   // member list is optional (403 when memberships are hidden)
    ]);
    if (seq !== state.loadSeq) return;
    entries.forEach(e => e.userName && state.userNames.set(e.userId, e.userName));
    state.entries = entries;

    await resolveGroupNames();
    if (seq !== state.loadSeq) return;
    renderGrid();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    $('grid-wrap').innerHTML = '';
    $('summary').textContent = '';
    handleError(err, load);
  } finally {
    if (seq === state.loadSeq) {
      $('grid-wrap').classList.remove('loading');
      $('btn-refresh').disabled = false;
    }
  }
}

function renderGrid() {
  const from = $('inp-from').value, to = $('inp-to').value;
  const today = localDateStr();
  const group = state.groups.find(g => g.id === $('sel-group').value);
  const projectLabel = selectedProjectNames().join(', ');

  // hours[userId][date]
  const hours = new Map();
  for (const e of state.entries) {
    if (!hours.has(e.userId)) hours.set(e.userId, new Map());
    const m = hours.get(e.userId);
    m.set(e.spentOn, (m.get(e.spentOn) ?? 0) + e.hours);
  }

  const userIds = group ? [...new Set(group.userIds)] : [...hours.keys()];
  const hoursOf = (uid, d) => hours.get(uid)?.get(d) ?? 0;

  const days = datesInRange(from, to)
    .filter(d => !isWeekend(d) || userIds.some(uid => hoursOf(uid, d) > 0));
  const elapsedWeekdays = days.filter(d => !isWeekend(d) && d <= today).length;
  const expected = elapsedWeekdays * DAILY_TARGET;

  const rows = userIds.map(uid => {
    const total   = days.reduce((s, d) => s + hoursOf(uid, d), 0);
    const toDate  = days.filter(d => d <= today).reduce((s, d) => s + hoursOf(uid, d), 0);
    return { uid, name: nameFor(uid), total, toDate };
  });
  const { key, dir } = state.sort;
  const sign = dir === 'ascending' ? 1 : -1;
  rows.sort((a, b) => sign * (key === 'total' ? a.total - b.total : a.name.localeCompare(b.name)));

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);
  const grandToDate = rows.reduce((s, r) => s + r.toDate, 0);
  const grandExpected = expected * rows.length;
  const workingDays = days.filter(d => !isWeekend(d)).length;

  $('summary').innerHTML = rows.length
    ? `<strong>${rows.length}</strong> member${rows.length === 1 ? '' : 's'} · ` +
      `<strong>${workingDays}</strong> working day${workingDays === 1 ? '' : 's'} · ` +
      `<strong>${fmtH(grandToDate)} h</strong> logged of <strong>${fmtH(grandExpected)} h</strong> expected to date`
    : '';

  const wrap = $('grid-wrap');
  wrap.classList.remove('loading');
  if (!rows.length) {
    wrap.innerHTML = `<div class="state-msg">${group
      ? `Group “${esc(group.name)}” has no members.`
      : `No time logged in ${esc(projectLabel)} between ${mmdd(from)} and ${mmdd(to)}.`}</div>`;
    return;
  }

  const ariaSort = k => state.sort.key === k ? state.sort.dir : 'none';
  const head = `<tr>
      <th class="name sortable" data-sort="name" tabindex="0" aria-sort="${ariaSort('name')}">Member</th>
      ${days.map((d, i) => `<th data-col="${i}" class="${isWeekend(d) ? 'wk' : ''} ${d === today ? 'today' : ''}" title="${mmddyyyy(d)}">
        <span class="dow">${DOW[dayOfWeek(d)]}</span>${mmdd(d)}</th>`).join('')}
      <th class="total sortable" data-sort="total" tabindex="0" aria-sort="${ariaSort('total')}">Total</th>
    </tr>`;

  const body = rows.map(r => `<tr class="${r.uid === state.meId ? 'me' : ''}">
      <th class="name" scope="row"><span class="who">${avatarHtml(r.uid, r.name)}${esc(r.name)}${r.uid === state.meId ? '<span class="you">You</span>' : ''}</span></th>
      ${days.map((d, i) => {
        const h = hoursOf(r.uid, d);
        const wk = isWeekend(d);
        let cls = wk ? 'wk' : '', txt = '';
        if (h > 0) {
          txt = fmtH(h);
          if (h >= OVER_TARGET - EPS)       cls += ' over';
          else if (h >= DAILY_TARGET - EPS) cls += ' met';
          else if (!wk)                     cls += ' under';
        } else if (!wk && d <= today) {
          cls += ' miss'; txt = '—';
        } else if (d > today) {
          cls += ' future';
        }
        const mine = r.uid === state.meId;
        if (mine) cls += ' can-log';
        if (h > 0) cls += ' has-log';
        const who = h > 0 || mine ? ` data-uid="${esc(r.uid)}" data-day="${d}"` : '';
        const act = mine ? ` tabindex="0" role="button" aria-label="Log time on ${DOW[dayOfWeek(d)]} ${mmdd(d)}"` : '';
        const title = h > 0 ? '' : ` title="${mine ? 'Log time' : esc(r.name)} · ${DOW[dayOfWeek(d)]} ${mmdd(d)}${mine ? '' : ' · 0.00 h'}"`;
        return `<td data-col="${i}"${who} class="${cls}"${act}${title}>${txt}</td>`;
      }).join('')}
      <td class="total">${fmtH(r.total)}</td>
    </tr>`).join('');

  const foot = `<tr>
      <th class="name" scope="row">Total</th>
      ${days.map((d, i) => {
        const s = rows.reduce((acc, r) => acc + hoursOf(r.uid, d), 0);
        return `<td data-col="${i}" class="${isWeekend(d) ? 'wk' : ''}">${s > 0 ? fmtH(s) : ''}</td>`;
      }).join('')}
      <td class="total">${fmtH(grandTotal)}</td>
    </tr>`;

  clearTimeout(popShowT); pop.hidden = true; popKey = null;
  wrap.innerHTML = `<table class="ledger"><thead>${head}</thead><tbody>${body}</tbody><tfoot>${foot}</tfoot></table>`;
  hydrateAvatars(wrap);
  markLogCell();
}

// Column crosshair + sorting (delegated; the table is re-rendered on every load).
$('grid-wrap').addEventListener('mouseover', e => {
  const cell = e.target.closest('td[data-col], th[data-col]');
  const col = cell?.dataset.col;
  $('grid-wrap').querySelectorAll('.col-hover').forEach(c => c.classList.remove('col-hover'));
  if (col != null) $('grid-wrap').querySelectorAll(`tbody td[data-col="${col}"]`).forEach(c => c.classList.add('col-hover'));
});
$('grid-wrap').addEventListener('mouseleave', () => {
  $('grid-wrap').querySelectorAll('.col-hover').forEach(c => c.classList.remove('col-hover'));
  schedulePopHide();
});

// ─── Cell detail popover: which stories the hours went to ─────────────────────
// Built from the time entries already loaded — no extra API calls. Opens after a
// short hover delay, stays open while the pointer is over it (links clickable).

const WP_URL = `${BACKLOG_URL}/work_packages/`;
const pop = $('cell-pop');
let popShowT = null, popHideT = null, popKey = null;

function showPop(cell) {
  if (!cell.isConnected) return;
  const { uid, day } = cell.dataset;
  const byWp = new Map();
  for (const e of state.entries) {
    if (e.userId !== uid || e.spentOn !== day) continue;
    const k = e.wpId || '—';
    if (!byWp.has(k)) byWp.set(k, { id: e.wpId, title: e.wpTitle, hours: 0, notes: [] });
    const w = byWp.get(k);
    w.hours += e.hours;
    const note = [e.activity, e.comment].filter(Boolean).join(' · ');
    if (note) w.notes.push(note);
  }
  const items = [...byWp.values()].sort((a, b) => b.hours - a.hours);
  const total = items.reduce((s, w) => s + w.hours, 0);

  pop.innerHTML = `
    <div class="pop-head"><span>${esc(nameFor(uid))} · ${DOW[dayOfWeek(day)]} ${mmdd(day)}</span><b>${fmtH(total)} h</b></div>
    ${items.map(w => `<div class="pop-row">
        <div class="pop-wp">${w.id ? `<a href="${WP_URL}${esc(w.id)}" target="_blank" rel="noopener">#${esc(w.id)}</a> ` : ''}${esc(w.title || 'No work package')}</div>
        <b>${fmtH(w.hours)}</b>
        ${w.notes.length ? `<div class="pop-note">${esc([...new Set(w.notes)].join(' / '))}</div>` : ''}
      </div>`).join('')}`;

  pop.hidden = false;
  popKey = `${uid}|${day}`;
  const r = cell.getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight;
  const left = Math.min(Math.max(8, r.left + r.width / 2 - pw / 2), innerWidth - pw - 8);
  const below = r.bottom + 6 + ph <= innerHeight - 8;
  pop.style.left = `${left}px`;
  pop.style.top  = `${below ? r.bottom + 6 : Math.max(8, r.top - ph - 6)}px`;
}

function schedulePopShow(cell) {
  clearTimeout(popHideT);
  if (!logPop.hidden) return;
  if (`${cell.dataset.uid}|${cell.dataset.day}` === popKey) return;
  clearTimeout(popShowT);
  popShowT = setTimeout(() => showPop(cell), 500);
}

function schedulePopHide() {
  clearTimeout(popShowT);
  clearTimeout(popHideT);
  popHideT = setTimeout(() => { pop.hidden = true; popKey = null; }, 200);
}

$('grid-wrap').addEventListener('mouseover', e => {
  const cell = e.target.closest('td.has-log');
  if (cell) schedulePopShow(cell); else schedulePopHide();
});
pop.addEventListener('mouseenter', () => clearTimeout(popHideT));
pop.addEventListener('mouseleave', schedulePopHide);
$('grid-wrap').addEventListener('scroll', () => { pop.hidden = true; popKey = null; });

function toggleSort(key) {
  const flip = { ascending: 'descending', descending: 'ascending' };
  const dir = state.sort.key === key ? flip[state.sort.dir] : (key === 'total' ? 'descending' : 'ascending');
  state.sort = { key, dir };
  renderGrid();
}
$('grid-wrap').addEventListener('click', e => {
  const th = e.target.closest('th[data-sort]');
  if (th) toggleSort(th.dataset.sort);
});
$('grid-wrap').addEventListener('keydown', e => {
  const th = e.target.closest('th[data-sort]');
  if (th && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggleSort(th.dataset.sort); }
});

// ─── Log time ─────────────────────────────────────────────────────────────────
// Click a cell in your own row (or the Log time button). The day is known from the
// cell, the work package defaults to the last one used and the hours to what is left
// of the 8 h day, so the common case is: click, Enter. Saved without a confirm
// dialog; the toast offers Undo.

const logPop = $('log-pop');
const lp = { editIdx: null, queue: [], created: new Set(), left: null, groups: [], tab: 0, tabPinned: false, preselect: true, editing: null, days: null, open: false, anchor: null, wp: null, form: null, formReq: null, seq: 0, busy: false, hoursTouched: false, sel: -1, items: [] };
let myWps = null;      // Promise of my open work packages, fetched once
let mineLoaded = null; // the same list once it has arrived, so reopening the picker needs no placeholder
let wpSearchT = null, wpSearchSeq = 0;

const wpInfo = new Map();   // id → full row (project, type, status, sprint), filled as lists load
const remember = list => { list.forEach(w => wpInfo.set(w.id, w)); return list; };
async function withInfo(list) {
  const missing = list.filter(w => { const i = wpInfo.get(w.id); return !i || !i.type || i.spent === undefined; }).map(w => w.id);
  if (missing.length) { try { remember(await fetchWorkPackagesByIds(missing)); } catch { /* keep the bare rows */ } }
  return list.map(w => ({ ...w, ...wpInfo.get(w.id) }));
}

// Time already logged on a ticket: its total, your share, and the estimate when there is one.
const wpTime = new Map();   // id → { total, mine }, from the ticket's time entries

function leanWp(w) { const { spent, estimate, ...rest } = w; return rest; }   // totals go stale, so they are not remembered

function touchWp(id, delta) {
  if (!id || !delta) return;
  const t = wpTime.get(String(id));
  if (t) { t.total += delta; t.mine += delta; }
  const info = wpInfo.get(String(id));
  if (info && info.spent != null) info.spent += delta;
  if (lp.wp && lp.wp.id === String(id) && lp.wp.spent != null && lp.wp !== info) lp.wp.spent += delta;
  for (const g of lp.groups) for (const it of g.items) if (it.id === String(id) && it !== info && it.spent != null) it.spent += delta;
  renderWpTime();
  if (!$('lp-wp-list').hidden) renderWpList();
}

function renderWpTime() {
  const el = $('lp-wp-time');
  const w = lp.wp;
  const t = w && wpTime.get(w.id);
  const total = t?.total ?? w?.spent;
  if (!w || total == null) { el.innerHTML = ''; return; }
  const est = w.estimate || 0;
  el.innerHTML = `<span>Logged <b>${fmtH(total)} h</b>${est ? ` of ${fmtH(est)} h estimated` : ''}${t ? ` · you ${fmtH(t.mine)} h` : ''}</span>`
    + (est ? `<span class="tl-bar${total > est + EPS ? ' over' : ''}"><i style="width:${Math.min(100, (total / est) * 100)}%"></i></span>` : '');
}

async function loadWpTime(wp) {
  if (!wpTime.has(wp.id)) {
    try {
      const rows = await fetchWpTime(wp.id);
      wpTime.set(wp.id, { total: rows.reduce((t, e) => t + e.hours, 0), mine: rows.filter(e => e.userId === state.meId).reduce((t, e) => t + e.hours, 0) });
    } catch { return; }   // the total from the work package itself stays
  }
  if (lp.wp?.id === wp.id) renderWpTime();
}

const UNDO_MS = 12000;   // a wrong log should be easy to take back

const fmtIn = h => String(Math.round(h * 100) / 100);

function parseHours(str) {
  const t = str.trim().toLowerCase().replace(',', '.');
  let m;
  if ((m = /^(\d+(?:\.\d+)?)$/.exec(t)))  return Number(m[1]);
  if ((m = /^(\d+):(\d{1,2})$/.exec(t)))  return Number(m[1]) + Number(m[2]) / 60;
  if ((m = /^(\d+)h(\d{1,2})$/.exec(t)))  return Number(m[1]) + Number(m[2]) / 60;
  if ((m = /^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in)?)?$/.exec(t)) && (m[1] || m[2])) {
    return Number(m[1] ?? 0) + Number(m[2] ?? 0) / 60;
  }
  return NaN;
}

const myEntries = day => state.entries.filter(e => e.userId === state.meId && e.spentOn === day);

function placeLogPop() {
  if (lp.open) logPop.style.top = `${Math.max(0, $('top-bar').getBoundingClientRect().bottom)}px`;
}

function markLogCell() {
  $('grid-wrap').querySelectorAll('td.log-open').forEach(c => c.classList.remove('log-open'));
  if (!lp.open) return;
  let last = null;
  for (const d of lp.days ?? [$('lp-date').value]) {
    const cell = $('grid-wrap').querySelector(`td.can-log[data-day="${d}"]`);
    if (cell) { cell.classList.add('log-open'); last = cell; }
  }
  if (last && lp.anchor?.tagName === 'TD') lp.anchor = last;
}

function setLogMsg(msg) { $('lp-msg').textContent = msg; placeLogPop(); }

/** Header, the day's existing entries, and the hours prefill, all derived from the chosen date. */
function refreshLogDay() {
  if (lp.days) { refreshLogMulti(); return; }
  const day = $('lp-date').value;
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(day);
  const mine = valid ? myEntries(day) : [];
  const total = mine.reduce((s, e) => s + e.hours, 0);
  $('lp-title').textContent = valid ? `${DOW[dayOfWeek(day)]} ${mmdd(day)}` : 'Log time';
  $('lp-total').textContent = total > 0 ? `${fmtH(total)} h logged` : '';
  $('lp-left').hidden = !mine.length;
  logPop.classList.toggle('has-day', mine.length > 0);
  $('lp-day').innerHTML = mine.map(e => {
    const title = `<span class="t">${e.wpId ? `<span class="id">#${esc(e.wpId)}</span>` : ''}${esc(e.wpTitle || 'No work package')}</span>`;
    if (e.id === lp.editing) return `<div class="lp-entry editing">${title}
      <div class="ef">
        <label class="fld">Hours<input class="ctrl" data-f="hours" value="${fmtIn(e.hours)}" inputmode="decimal" /></label>
        <label class="fld">Day<input type="date" class="ctrl" data-f="date" value="${esc(e.spentOn)}" /></label>
      </div>
      <span class="acts"><button type="button" class="primary" data-save="${esc(e.id)}">Save</button><button type="button" class="ghost" data-cancel>Cancel</button></span>
    </div>`;
    return `<div class="lp-entry">${title}<b>${fmtH(e.hours)}</b>
      <span class="acts">
        <button type="button" class="ghost" data-edit="${esc(e.id)}">Edit</button>
        <button type="button" class="ghost" data-del="${esc(e.id)}">Delete</button>
      </span>
    </div>`;
  }).join('');
  const fill = $('lp-meter-fill');
  fill.style.width = `${Math.min(100, (total / DAILY_TARGET) * 100)}%`;
  fill.parentElement.classList.toggle('met', total >= DAILY_TARGET - EPS);

  const left = valid && !isWeekend(day) ? DAILY_TARGET - total - queuedHours() : 0;
  if (!lp.hoursTouched) $('lp-hours').value = left > EPS ? fmtIn(left) : '';
  const presets = [0.5, 1, 2, 4].filter(h => Math.abs(h - left) > EPS);
  $('lp-chips').innerHTML = (left > EPS ? `<button type="button" class="rest" data-h="${fmtIn(left)}" title="Fill the day up to ${DAILY_TARGET} h">Rest ${fmtIn(left)} h</button>` : '')
    + presets.map(h => `<button type="button" data-h="${h}">${h} h</button>`).join('');
  $('lp-hint').textContent = !valid ? '' : left > EPS ? `${fmtH(left)} h left to reach ${DAILY_TARGET} h`
    : total > 0 ? `Already ${fmtH(total)} h — this adds on top` : '';
  renderDayChips();
  placeLogPop();
}

// Several days at once: Shift+click a second cell in your row. Each selected working
// day (not in the future) gets the same work package; the hours are what you type per
// day, or, left empty, whatever is missing to 8 h on that day (days already at 8 h are skipped).

const dayTotal = d => myEntries(d).reduce((s, e) => s + e.hours, 0);

const queuedHours = () => lp.queue.reduce((t, l) => t + (l.hours ?? 0), 0);

/** The ticket currently in the form: {line} when complete, {} when there is none to add, {error} when half filled. */
function readLine(preview = false, forEdit = false) {
  if (lp.editIdx != null && !forEdit) return {};
  if (!lp.wp) {
    if (lp.queue.length) return {};
    if (!preview) return { error: 'Pick a work package.' };
  }
  const typed = $('lp-hours').value.trim();
  const hours = typed ? parseHours(typed) : null;
  if (typed && !(hours > 0 && hours <= 24)) return { error: 'Enter hours like 1.5, 1h30 or 90m.' };
  return { line: { wp: lp.wp ?? { id: '…' }, hours, comment: $('lp-comment').value.trim(), activityHref: $('lp-activity').value || null } };
}

/**
 * Every entry one go would create: each day selected × each ticket in the list (plus the one in the form).
 * A ticket without hours (only allowed when it is the only one) fills each day up to 8 h.
 * Entries already created by an earlier, partly failed attempt in this panel are skipped on retry.
 */
function buildPlan(preview = false) {
  const cur = readLine(preview);
  if (cur.error) return { plan: [], error: cur.error, skipped: 0, lines: [] };
  const lines = cur.line ? [...lp.queue, cur.line] : [...lp.queue];
  if (lines.length > 1 && lines.some(l => l.hours == null)) return { plan: [], error: 'Enter hours for each ticket.', skipped: 0, lines };
  const days = lp.days ?? [$('lp-date').value];
  const all = days.flatMap(day => lines.map(line => ({ day, line, hours: line.hours ?? DAILY_TARGET - dayTotal(day) })));
  const plan = all.filter(p => p.hours > EPS && !lp.created.has(`${p.day}|${p.line.wp.id}|${fmtIn(p.hours)}`));
  return { plan, error: null, skipped: all.length - plan.length, lines };
}

function refreshLogMulti() {
  logPop.classList.remove('has-day');
  const { plan, error, skipped } = buildPlan(true);
  const first = lp.days[0], last = lp.days[lp.days.length - 1];
  $('lp-title').textContent = `${DOW[dayOfWeek(first)]} ${mmdd(first)} – ${DOW[dayOfWeek(last)]} ${mmdd(last)}`;
  $('lp-total').textContent = `${lp.days.length} days`;
  const total = plan.reduce((t, p) => t + p.hours, 0);
  $('lp-hint').textContent = error ? error
    : plan.length ? `Logs ${plan.length} entr${plan.length === 1 ? 'y' : 'ies'} · ${fmtH(total)} h in total` + (skipped ? ` · ${skipped} already at ${DAILY_TARGET} h skipped` : '')
    : `Nothing to log: every selected day already has ${DAILY_TARGET} h.`;
  renderDayChips();
  placeLogPop();
}

function updateSaveLabel() {
  const n = lp.queue.length + (lp.wp && lp.editIdx == null ? 1 : 0);
  $('lp-save').textContent = n > 1 ? `Log ${n} tickets` : 'Log time';
}

function renderQueue() {
  const off = lp.editIdx != null ? ' disabled' : '';
  $('lp-queue-wrap').hidden = !lp.queue.length;
  $('lp-queue').innerHTML = lp.queue.map((l, i) => `<div class="q${lp.editIdx === i ? ' editing' : ''}">
      <span class="r1">${typeIcon(l.wp.type)}<span class="id">#${esc(l.wp.id)}</span><span class="ttl">${esc(l.wp.title)}</span></span>
      <input class="ctrl" data-qh="${i}" value="${l.hours == null ? '' : fmtIn(l.hours)}" inputmode="decimal" aria-label="Hours for #${esc(l.wp.id)}" placeholder="8"${off} />
      <button type="button" class="ghost" data-qedit="${i}" title="Change the ticket, hours or comment"${off}>Edit</button>
      <button type="button" class="ghost" data-q="${i}" aria-label="Remove from the list" title="Remove"${off}>✕</button>
    </div>`).join('');
  const editing = lp.editIdx != null ? lp.queue[lp.editIdx] : null;
  $('lp-editbar').hidden = !editing;
  if (editing) $('lp-editbar-t').textContent = `Editing #${editing.wp.id}`;
  updateSaveLabel();
  placeLogPop();
}

/** Empties the form for the next ticket and opens the list of work packages. */
function resetFormForNext() {
  lp.wp = null; lp.seq++; lp.form = null; lp.tabPinned = false; lp.mode = null;
  $('lp-wp').value = ''; $('lp-comment').value = ''; $('lp-activity').disabled = true;
  lp.hoursTouched = false;
  showWpSel();
  renderQueue();
  setLogMsg('');
  if (lp.days) { $('lp-hours').value = ''; refreshLogMulti(); } else refreshLogDay();
  $('lp-wp').focus();
  suggestWps();
}

/** Reads the ticket in the form as a complete line for the list, or says what is missing. */
async function completeLine() {
  const cur = readLine(false, true);
  if (cur.error)  { setLogMsg(cur.error); (lp.wp ? $('lp-hours') : $('lp-wp')).focus(); return null; }
  if (!cur.line)  { setLogMsg('Pick a work package.'); $('lp-wp').focus(); return null; }
  if (cur.line.hours == null) { setLogMsg('Enter the hours for this ticket.'); $('lp-hours').focus(); return null; }
  const line = cur.line;
  line.form = lp.form ?? await lp.formReq;
  line.activityName = line.form.activities.find(a => a.href === line.activityHref)?.name;
  return line;
}

/** Puts the ticket in the form on the To log list and opens a fresh form for the next one. */
async function stageLine() {
  if (lp.busy) return;
  if (lp.editIdx != null) { doneEdit(); return; }
  const line = await completeLine();
  if (!line) return;
  lp.queue.push(line);
  resetFormForNext();
}

/** Done: the edited line goes back on the list with the form's values, and the form is free for the next ticket. */
async function doneEdit() {
  const i = lp.editIdx;
  if (i == null || lp.busy) return;
  const line = await completeLine();
  if (!line) return;
  lp.queue[i] = line;
  lp.editIdx = null;
  resetFormForNext();
}

function cancelEdit() {
  if (lp.editIdx == null) return;
  lp.editIdx = null;
  resetFormForNext();
}

/** Working days of your row between two clicked cells, today or earlier. */
function daysBetween(fromDay, toDay) {
  const [a, b] = fromDay < toDay ? [fromDay, toDay] : [toDay, fromDay];
  const today = localDateStr();
  return [...$('grid-wrap').querySelectorAll('td.can-log')]
    .filter(c => !c.classList.contains('wk') && c.dataset.day >= a && c.dataset.day <= b && c.dataset.day <= today)
    .map(c => c.dataset.day);
}

function openLogRange(days, anchor) {
  openLog(days[0], anchor);
  lp.days = days;
  logPop.classList.add('multi');
  $('lp-hours').value = '';
  $('lp-hours').placeholder = `Empty = fill each day to ${DAILY_TARGET} h`;
  lp.hoursTouched = true;
  refreshLogMulti();
  markLogCell();
}

/** The days of your row you can log on (today and earlier), as chips: tick several to fill them in one go. */
function renderDayChips() {
  const today = localDateStr();
  const avail = [...$('grid-wrap').querySelectorAll('td.can-log')].map(c => c.dataset.day).filter(d => d <= today);
  const cur = new Set(lp.days ?? [$('lp-date').value]);
  const wrap = $('lp-days-wrap');
  wrap.hidden = avail.length < 2 || !avail.some(d => cur.has(d));
  if (wrap.hidden) return;
  const gap = d => !isWeekend(d) && dayTotal(d) < DAILY_TARGET - EPS;
  $('lp-days').innerHTML = avail.map(d => {
    const t = dayTotal(d);
    return `<button type="button" class="${cur.has(d) ? 'on' : gap(d) ? 'gap' : ''}" data-d="${d}" aria-pressed="${cur.has(d)}"
      title="${t > 0 ? `${fmtH(t)} h logged` : 'Nothing logged'}">${DOW[dayOfWeek(d)]} ${d.slice(8)}</button>`;
  }).join('') + `<button type="button" class="all" data-all title="Select every day under ${DAILY_TARGET} h">All missing</button>`;
}

/** One day = the normal form; two or more = the range form (hours empty tops each day up to 8 h). */
function setLogDays(days) {
  const arr = [...new Set(days)].sort();
  if (!arr.length) return;
  if (arr.length === 1) {
    lp.days = null;
    logPop.classList.remove('multi');
    $('lp-hours').placeholder = '1.5 · 1h30';
    $('lp-date').value = arr[0];
    lp.hoursTouched = false; lp.editing = null;
    refreshLogDay();
  } else {
    const entering = !lp.days;
    lp.days = arr;
    $('lp-date').value = arr[0];
    logPop.classList.add('multi');
    if (entering) {
      $('lp-hours').value = '';
      $('lp-hours').placeholder = `Empty = fill each day to ${DAILY_TARGET} h`;
      lp.hoursTouched = true;
    }
    refreshLogMulti();
  }
  markLogCell();
}

$('lp-days').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  const cur = lp.days ?? [$('lp-date').value];
  if (b.dataset.all !== undefined) {
    const today = localDateStr();
    const missing = [...$('grid-wrap').querySelectorAll('td.can-log')].map(c => c.dataset.day)
      .filter(d => d <= today && !isWeekend(d) && dayTotal(d) < DAILY_TARGET - EPS);
    if (missing.length) setLogDays(missing); else setLogMsg(`Every day already has ${DAILY_TARGET} h.`);
    return;
  }
  const d = b.dataset.d;
  if (cur.includes(d)) { if (cur.length > 1) setLogDays(cur.filter(x => x !== d)); }
  else setLogDays([...cur, d]);
});

function recentWps() {
  const seen = new Set(), out = [];
  for (const e of [...state.entries].filter(e => e.userId === state.meId && e.wpId).sort((a, b) => b.spentOn.localeCompare(a.spentOn))) {
    if (seen.has(e.wpId)) continue;
    seen.add(e.wpId);
    out.push({ id: e.wpId, title: e.wpTitle, project: '', projectId: '' });
    if (out.length === 5) break;
  }
  const last = state.last.lastWp;
  if (last) return [last, ...out.filter(w => w.id !== last.id)].slice(0, 5);
  return out;
}

const TYPE_GLYPH = {
  bug:   '<circle cx="8" cy="8" r="3.2" fill="currentColor"/>',
  story: '<path d="M5.2 3.2h5.6v9.6L8 10.6l-2.8 2.2z" fill="currentColor"/>',
  task:  '<path d="M4.6 8.4l2.3 2.3 4.5-4.8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  epic:  '<path d="M9 2.5L4.5 9h3L7 13.5 11.5 7h-3z" fill="currentColor"/>',
};

function typeIcon(type = '') {
  const t = type.toLowerCase();
  const k = t.includes('bug') ? 'bug' : t.includes('story') ? 'story' : t.includes('task') || !t ? 'task' : 'epic';
  return `<span class="ti ti-${k}" title="${esc(type || 'Work package')}"><svg viewBox="0 0 16 16" aria-hidden="true">${TYPE_GLYPH[k]}</svg></span>`;
}

function statusLozenge(status) {
  if (!status) return '';
  const s = status.toLowerCase();
  const k = /closed|resolved|done|finish|complete|reject/.test(s) ? 'done' : /progress|develop|review|test|implement|ready/.test(s) ? 'prog' : 'todo';
  return `<span class="lz lz-${k}">${esc(status)}</span>`;
}

function assigneeDot(w) {
  if (!w.type) return '';   // details not loaded yet
  if (!w.assigneeId) return '<span class="avatar none" title="Unassigned"></span>';
  const me = w.assigneeId === state.meId;
  return avatarHtml(w.assigneeId, w.assignee || '')
    .replace('class="avatar"', `class="avatar${me ? ' me' : ''}" title="${esc(w.assignee || '')}${me ? ' (you)' : ''}"`);
}

function spentChip(w) {
  if (w.spent == null) return '';
  const est = w.estimate || 0;
  return `<span class="spent${est && w.spent > est + EPS ? ' over' : ''}" title="Time already logged on this story${est ? ` (estimate ${fmtH(est)} h)` : ''}">${fmtH(w.spent)} h${est ? ` / ${fmtH(est)} h` : ''}</span>`;
}

const wpPlace = w => [w.project, w.version].filter(Boolean).join(' · ');

// Work package types that never show in the picker (suggestions and search alike).
const HIDDEN_TYPES = ['task'];
const isHiddenType = w => HIDDEN_TYPES.includes((w.type ?? '').toLowerCase());

function renderWpList() {
  const keepScroll = $('lp-wp-list').querySelector('.wp-sec-body')?.scrollTop ?? 0;
  const groups = lp.groups.map(g => ({ ...g, items: g.items.filter(w => !isHiddenType(w)) }));
  const tab = lp.tabPinned && groups[lp.tab] ? lp.tab : Math.max(0, groups.findIndex(g => g.items.length));
  lp.tab = tab;
  const g = groups[tab];
  lp.items = g.items;
  lp.sel = lp.preselect && g.items.length ? 0 : -1;
  $('lp-wp-list').innerHTML = `<div class="tabs" role="tablist">${groups.map((x, i) =>
      `<button type="button" class="tab" role="tab" data-tab="${i}" aria-selected="${i === tab}">${esc(x.label)}<span class="n">${x.items.length || ''}</span></button>`).join('')}</div>
    <div class="wp-sec-body">${g.items.map((w, i) => `
      <button type="button" class="opt" role="option" data-i="${i}" aria-selected="${i === lp.sel}">
        <span class="r1">${typeIcon(w.type)}<span class="id">#${esc(w.id)}</span><span class="ttl">${esc(w.title)}</span>${statusLozenge(w.status)}${assigneeDot(w)}</span>
        <span class="proj"><span class="pl">${esc(wpPlace(w))}</span>${spentChip(w)}</span>
      </button>`).join('') || `<div class="empty">${esc(g.note ?? 'No matching work package.')}</div>`}</div>`;
  const body = $('lp-wp-list').querySelector('.wp-sec-body');
  if (body) body.scrollTop = keepScroll;
  hydrateAvatars($('lp-wp-list'));
}

function showWpList(groups, preselect = true) {
  lp.groups = groups;
  lp.preselect = preselect;
  renderWpList();
  $('lp-wp-list').hidden = false;
  $('lp-wp').setAttribute('aria-expanded', 'true');
  placeLogPop();
}

function hideWpList() {
  lp.mode = null;
  $('lp-wp-list').hidden = true;
  $('lp-wp').setAttribute('aria-expanded', 'false');
  lp.items = []; lp.sel = -1;
  placeLogPop();
}

async function suggestWps() {
  const q = $('lp-wp').value.trim();
  const suggest = !q || lp.wp;
  // focus and click both ask for the list: if it is already showing, leave it (and the request in flight) alone
  if (suggest && !$('lp-wp-list').hidden && lp.mode === 'suggest') return;
  const seq = ++wpSearchSeq;
  if (suggest) {
    lp.mode = 'suggest';
    const recent = recentWps().map(w => ({ ...w, ...wpInfo.get(w.id) }));
    const groups = mine => [
      { label: 'Assigned to me', items: mine ?? [], note: mine ? 'Nothing open is assigned to you.' : 'Loading…' },
      // open work assigned to you leads; recents already in it are not repeated
      { label: 'Recent', items: recent.filter(w => !mine?.some(m => m.id === w.id)) },
    ];
    showWpList(groups(mineLoaded), false);
    if (mineLoaded && recent.every(w => w.type)) return;
    if (!myWps) myWps = fetchMyOpenWorkPackages().then(l => (mineLoaded = remember(l))).catch(() => (mineLoaded = []));
    const [richRecent, mineWps] = await Promise.all([withInfo(recent), myWps]);
    if (seq !== wpSearchSeq || $('lp-wp-list').hidden || lp.mode !== 'suggest') return;
    const mineIds = new Set(mineWps.map(w => w.id));
    showWpList([
      { label: 'Assigned to me', items: mineWps, note: 'Nothing open is assigned to you.' },
      { label: 'Recent', items: richRecent.filter(w => !mineIds.has(w.id)) },
    ], false);
    return;
  }
  try {
    const found = remember(await searchWorkPackages(q));
    if (seq !== wpSearchSeq) return;
    lp.mode = 'search';
    showWpList([{ label: 'Results', items: found }]);
  } catch { /* keep the previous list */ }
}

function showWpSel() {
  const w = lp.wp;
  logPop.classList.toggle('has-wp', !!w);
  $('lp-chip-t').innerHTML = w ? `${typeIcon(w.type)}<span class="id">#${esc(w.id)}</span><span class="ttl">${esc(w.title)}</span>` : '';
  const who = !w?.type ? '' : w.assigneeId === state.meId ? '<b class="mine">Assigned to you</b>' : esc(w.assignee || 'Unassigned');
  updateSaveLabel();
  renderWpTime();
  $('lp-wp-sel').innerHTML = w?.type ? `${statusLozenge(w.status)}<span class="sub">${[esc(wpPlace(w)), who].filter(Boolean).join(' · ')}</span>` : '';
}

function pickWp(wp) {
  lp.wp = wp;
  $('lp-wp').value = `#${wp.id} ${wp.title}`;
  showWpSel();
  hideWpList();
  if (!wp.type || wp.spent === undefined) withInfo([wp]).then(([full]) => { if (lp.wp?.id === wp.id) { lp.wp = full; showWpSel(); } });
  loadWpTime(wp);
  const seq = ++lp.seq;
  lp.form = null;
  const sel = $('lp-activity');
  sel.disabled = true; sel.innerHTML = '<option>Loading…</option>';
  lp.formReq = fetchTimeEntryForm(wp.id, $('lp-date').value || localDateStr())
    .catch(() => ({ linkKey: 'workPackage', activities: [], defaultHref: null }))
    .then(form => {
      if (seq !== lp.seq) return form;
      lp.form = form;
      sel.innerHTML = form.activities.map(a => `<option value="${esc(a.href)}">${esc(a.name)}</option>`).join('') || '<option value="">Default</option>';
      const remembered = form.activities.find(a => a.name === state.last.lastActivity);
      sel.value = remembered?.href ?? form.defaultHref ?? form.activities[0]?.href ?? '';
      sel.disabled = form.activities.length < 2;
      $('lp-more-sum').textContent = `· ${sel.selectedOptions[0]?.textContent ?? ''}`;
      return form;
    });
}

function openLog(day, anchor) {
  clearTimeout(popShowT); pop.hidden = true; popKey = null;
  lp.tabPinned = false; lp.left = null;
  lp.queue = []; lp.created = new Set(); lp.editIdx = null; renderQueue();
  lp.days = null; logPop.classList.remove('multi'); $('lp-hours').placeholder = '1.5 · 1h30 · 90m';
  lp.open = true; lp.anchor = anchor; lp.wp = null; lp.form = null; lp.seq++; lp.hoursTouched = false;
  $('lp-date').value = day;
  $('lp-more').open = anchor.tagName !== 'TD';
  $('lp-wp').value = ''; $('lp-comment').value = ''; $('lp-msg').textContent = ''; lp.editing = null; showWpSel();
  $('lp-activity').innerHTML = '<option value="">Default</option>'; $('lp-activity').disabled = true;
  hideWpList();
  logPop.hidden = false;
  document.body.classList.add('log-docked');
  refreshLogDay();
  markLogCell();
  if (anchor.tagName === 'TD') requestAnimationFrame(() => anchor.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  $('lp-more-sum').textContent = '';
  $('lp-wp').focus();
  suggestWps();
  placeLogPop();
}

function closeLog({ refocus = true } = {}) {
  if (!lp.open) return;
  lp.open = false;
  lp.queue = []; lp.created = new Set(); lp.editIdx = null;
  const day = $('lp-date').value;
  logPop.hidden = true;
  document.body.classList.remove('log-docked');
  markLogCell();
  lp.days = null;
  lp.editing = null;
  if (refocus) {
    const cell = $('grid-wrap').querySelector(`td.can-log[data-day="${day}"]`);
    (cell ?? $('btn-log')).focus();
  }
}

async function submitAll() {
  if (lp.busy) return;
  if (lp.editIdx != null) { doneEdit(); return; }
  const { plan, error, skipped, lines } = buildPlan();
  if (error) { setLogMsg(error); (/work package/.test(error) ? $('lp-wp') : $('lp-hours')).focus(); return; }
  if (!plan.length) {
    setLogMsg(lines.some(l => l.hours == null) ? `Nothing to log: every selected day already has ${DAILY_TARGET} h.` : 'Everything here is already logged.');
    return;
  }

  lp.busy = true;
  $('lp-save').disabled = $('lp-again').disabled = true;
  setLogMsg('');
  const made = [];
  let failure = null;
  try {
    for (const l of lines) l.form ??= await (lp.form ?? lp.formReq);
    for (const [i, p] of plan.entries()) {
      $('lp-save').textContent = `Logging ${i + 1}/${plan.length}…`;
      try {
        const entry = await createTimeEntry({
          wpId: p.line.wp.id, spentOn: p.day, hours: p.hours, linkKey: p.line.form.linkKey,
          activityHref: p.line.activityHref, comment: p.line.comment,
        });
        entry.userId ||= state.meId ?? '';
        made.push({ entry, wp: p.line.wp });
        touchWp(p.line.wp.id, p.hours);
        lp.created.add(`${p.day}|${p.line.wp.id}|${fmtIn(p.hours)}`);
        if (!p.line.wp.projectId || state.projectIds.includes(p.line.wp.projectId)) state.entries.push(entry);
      } catch (err) {
        failure = { p, err };
        break;
      }
    }
    if (made.length) {
      const last = lines[lines.length - 1];
      const activityName = last.activityName ?? last.form.activities.find(a => a.href === last.activityHref)?.name;
      saveLast({ lastWp: leanWp(last.wp), ...(activityName ? { lastActivity: activityName } : {}) });
      renderGrid();
    }
  } catch (err) {
    failure = { p: null, err };
  } finally {
    lp.busy = false;
    $('lp-save').disabled = $('lp-again').disabled = false;
    updateSaveLabel();
  }

  if (failure?.err?.code === 'NOT_AUTHENTICATED') { closeLog({ refocus: false }); handleError(failure.err, load); return; }
  if (failure) {
    // the panel stays open; entries already created are skipped when you try again
    const where = failure.p ? `${mmdd(failure.p.day)} #${failure.p.line.wp.id} failed: ` : '';
    setLogMsg(`Logged ${made.length} of ${plan.length}. ${where}${failure.err?.message ?? failure.err}`);
    if (lp.days) refreshLogMulti(); else refreshLogDay();
    return;
  }

  const firstDay = made[0].entry.spentOn;
  lp.created.clear(); lp.queue = [];
  closeLog({ refocus: false });
  $('grid-wrap').querySelector(`td.can-log[data-day="${firstDay}"]`)?.focus();
  const total = made.reduce((t, m) => t + m.entry.hours, 0);
  const tickets = new Set(made.map(m => m.wp.id)).size, days = new Set(made.map(m => m.entry.spentOn)).size;
  const hidden = made.filter(m => m.wp.projectId && !state.projectIds.includes(m.wp.projectId)).length;
  const label = made.length === 1
    ? `Logged ${fmtH(total)} h on #${made[0].wp.id} · ${DOW[dayOfWeek(firstDay)]} ${mmdd(firstDay)}`
    : `Logged ${fmtH(total)} h · ${made.length} entries on ${tickets} ticket${tickets === 1 ? '' : 's'} across ${days} day${days === 1 ? '' : 's'}`;
  showToast(label + (hidden ? ` (${hidden} in another project, not shown here)` : ''), 'Undo', async () => {
    const gone = new Set();
    for (const m of made) {
      try { await deleteTimeEntry(m.entry.id); gone.add(m.entry.id); touchWp(m.wp.id, -m.entry.hours); } catch { /* counted below */ }
    }
    state.entries = state.entries.filter(e => !gone.has(e.id));
    renderGrid();
    if (gone.size < made.length) showToast(`Undid ${gone.size} of ${made.length} entries`);
  }, UNDO_MS);
}

let lastPickDay = null;
function activateCell(cell, shift, mod) {
  const day = cell.dataset.day;
  if (lp.open) {
    // the panel stays open: cells change which days it logs on; the work package, hours and comment are kept
    const cur = lp.days ?? [$('lp-date').value];
    lp.anchor = cell;
    if (mod) {
      if (!cur.includes(day)) setLogDays([...cur, day]);
      else if (cur.length > 1) setLogDays(cur.filter(d => d !== day));
      return;
    }
    const range = shift ? daysBetween(lastPickDay ?? cur[0], day) : [];
    if (range.length > 1) { setLogDays(range); return; }
    lastPickDay = day;
    setLogDays([day]);
    return;
  }
  const range = shift && lastPickDay && lastPickDay !== day ? daysBetween(lastPickDay, day) : [];
  if (range.length > 1) { openLogRange(range, cell); return; }
  lastPickDay = day;
  openLog(day, cell);
}
$('grid-wrap').addEventListener('click', e => {
  const cell = e.target.closest('td.can-log');
  if (cell) activateCell(cell, e.shiftKey, e.ctrlKey || e.metaKey);
});
$('grid-wrap').addEventListener('keydown', e => {
  const cell = e.target.closest('td.can-log');
  if (cell && e.target === cell && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activateCell(cell, e.shiftKey, e.ctrlKey || e.metaKey); }
});
$('btn-log').addEventListener('click', () => (lp.open ? closeLog() : openLog(localDateStr(), $('btn-log'))));

logPop.addEventListener('submit', e => { e.preventDefault(); submitAll(); });
$('lp-cancel').addEventListener('click', () => closeLog());
$('lp-again').addEventListener('click', stageLine);
logPop.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.shiftKey) return;
  if (e.target === $('lp-wp') && !$('lp-wp-list').hidden) return;   // Enter there picks the highlighted work package
  e.preventDefault();
  stageLine();
});
document.addEventListener('keydown', e => { if (e.key === 'Escape' && lp.open) closeLog(); });
$('lp-close').addEventListener('click', () => closeLog());
function afterQueueChange() {
  renderQueue();
  if (lp.days) refreshLogMulti(); else { lp.hoursTouched = false; refreshLogDay(); }
}

/** Loads a list line into the form; the line stays on the list, marked as being edited, until Done or Cancel. */
async function editQueued(i) {
  const line = lp.queue[i];
  if (!line || lp.editIdx != null) return;
  const cur = readLine();
  if (cur.error) { setLogMsg(cur.error); return; }
  if (cur.line) {   // a ticket half-way through the form joins the list instead of being lost
    const pending = await completeLine();
    if (!pending) return;
    lp.queue.push(pending);
  }
  lp.editIdx = i;
  setLogMsg('');
  pickWp(line.wp);
  $('lp-comment').value = line.comment ?? '';
  lp.formReq.then(() => { if (line.activityHref && lp.wp?.id === line.wp.id) $('lp-activity').value = line.activityHref; });
  $('lp-hours').value = line.hours == null ? '' : fmtIn(line.hours);
  lp.hoursTouched = true;
  renderQueue();
  if (lp.days) refreshLogMulti(); else refreshLogDay();
  $('lp-hours').focus(); $('lp-hours').select();
}
$('lp-edit-done').addEventListener('click', doneEdit);
$('lp-edit-cancel').addEventListener('click', cancelEdit);

$('lp-queue').addEventListener('click', e => {
  const edit = e.target.closest('[data-qedit]');
  if (edit) { editQueued(Number(edit.dataset.qedit)); return; }
  const b = e.target.closest('[data-q]');
  if (!b) return;
  lp.queue.splice(Number(b.dataset.q), 1);
  afterQueueChange();
});
// hours typed straight into a line of the list
$('lp-queue').addEventListener('change', e => {
  const input = e.target.closest('[data-qh]');
  const line = input && lp.queue[Number(input.dataset.qh)];
  if (!line) return;
  const typed = input.value.trim();
  const hours = parseHours(typed);
  if (!(hours > 0 && hours <= 24)) {
    input.value = line.hours == null ? '' : fmtIn(line.hours);
    setLogMsg('Enter hours like 1.5, 1h30 or 90m.');
    return;
  }
  line.hours = hours;
  input.value = fmtIn(hours);
  setLogMsg('');
  if (lp.days) refreshLogMulti(); else { lp.hoursTouched = false; refreshLogDay(); }
});
$('lp-queue').addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.matches('[data-qh]')) return;
  e.preventDefault(); e.stopPropagation();
  e.target.blur();
});
addEventListener('resize', () => { lp.left = null; placeLogPop(); });

$('lp-date').addEventListener('change', () => { refreshLogDay(); markLogCell(); });
$('lp-hours').addEventListener('input', () => { lp.hoursTouched = true; if (lp.days) refreshLogMulti(); });

$('lp-wp').addEventListener('focus', () => { $('lp-wp').select(); suggestWps(); });
// The field can already have focus when the list was closed by a click elsewhere in the form: no focus event then.
$('lp-wp').addEventListener('click', () => { if ($('lp-wp-list').hidden && !lp.wp) suggestWps(); });
$('lp-wp').addEventListener('input', () => {
  lp.wp = null; lp.seq++; lp.form = null; lp.tabPinned = false; lp.mode = null;
  showWpSel();
  $('lp-activity').disabled = true;
  clearTimeout(wpSearchT);
  wpSearchT = setTimeout(suggestWps, 220);
});
$('lp-wp').addEventListener('keydown', e => {
  const open = !$('lp-wp-list').hidden && lp.items.length;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!open) { suggestWps(); return; }
    e.preventDefault();
    lp.sel = lp.sel < 0 ? (e.key === 'ArrowDown' ? 0 : lp.items.length - 1)
      : (lp.sel + (e.key === 'ArrowDown' ? 1 : -1) + lp.items.length) % lp.items.length;
    $('lp-wp-list').querySelectorAll('.opt').forEach((o, i) => {
      o.setAttribute('aria-selected', i === lp.sel);
      if (i === lp.sel) o.scrollIntoView({ block: 'nearest' });
    });
  } else if (e.key === 'Enter' && open && lp.sel >= 0) {
    e.preventDefault();
    pickWp(lp.items[lp.sel]);
    $('lp-hours').focus(); $('lp-hours').select();
  } else if (e.key === 'Escape' && !$('lp-wp-list').hidden) {
    e.stopPropagation(); hideWpList();
  }
});
$('lp-wp-list').addEventListener('click', e => {
  const tab = e.target.closest('.tab');
  if (tab) { lp.tab = Number(tab.dataset.tab); lp.tabPinned = true; renderWpList(); placeLogPop(); return; }
  const opt = e.target.closest('.opt');
  if (!opt) return;
  pickWp(lp.items[Number(opt.dataset.i)]);
  $('lp-hours').focus(); $('lp-hours').select();
});

$('lp-wp-change').addEventListener('click', () => {
  lp.tabPinned = false;
  lp.wp = null; lp.seq++; lp.form = null;
  showWpSel();
  $('lp-activity').disabled = true;
  $('lp-wp').value = '';
  $('lp-wp').focus();
  suggestWps();
});
$('lp-chips').addEventListener('click', e => {
  const b = e.target.closest('[data-h]');
  if (!b) return;
  $('lp-hours').value = b.dataset.h;
  lp.hoursTouched = true;
  $('lp-hours').focus(); $('lp-hours').select();
});

// ─ Entries of the day: change hours / move to another day, or delete (asks once, inline)
async function saveEdit() {
  const row = $('lp-day').querySelector('.lp-entry.editing');
  const old = state.entries.find(x => x.id === lp.editing);
  if (!row || !old) return;
  const hours = parseHours(row.querySelector('[data-f="hours"]').value);
  const date = row.querySelector('[data-f="date"]').value;
  if (!(hours > 0 && hours <= 24)) { setLogMsg('Enter hours like 1.5, 1h30 or 90m.'); return; }
  if (!date)                       { setLogMsg('Pick a date.'); return; }
  if (Math.abs(hours - old.hours) < EPS && date === old.spentOn) { lp.editing = null; refreshLogDay(); return; }

  row.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
  setLogMsg('');
  let saved;
  try { saved = await updateTimeEntry(old.id, { hours, spentOn: date }); }
  catch (err) { lp.editing = old.id; refreshLogDay(); setLogMsg(err?.message ?? String(err)); return; }
  applyEntryChange(old.id, saved);
  touchWp(old.wpId, saved.hours - old.hours);
  lp.editing = null;
  renderGrid();
  refreshLogDay();

  const moved = saved.spentOn !== old.spentOn;
  showToast(moved ? `Moved ${fmtH(saved.hours)} h to ${DOW[dayOfWeek(saved.spentOn)]} ${mmdd(saved.spentOn)}` : `Changed to ${fmtH(saved.hours)} h`, 'Undo', async () => {
    try { const back = await updateTimeEntry(old.id, { hours: old.hours, spentOn: old.spentOn }); applyEntryChange(old.id, back); touchWp(old.wpId, back.hours - saved.hours); }
    catch (err) { showToast(`Could not undo: ${err.message}`); return; }
    renderGrid();
    if (lp.open) refreshLogDay();
  }, UNDO_MS);
}

/** Replaces one entry in the loaded data; it drops out when it moved outside the shown dates. */
function applyEntryChange(id, saved) {
  state.entries = state.entries.filter(x => x.id !== id);
  if (saved.spentOn >= $('inp-from').value && saved.spentOn <= $('inp-to').value) state.entries.push(saved);
}

$('lp-day').addEventListener('click', async e => {
  const edit = e.target.closest('[data-edit]');
  if (edit) {
    lp.editing = edit.dataset.edit;
    refreshLogDay();
    const f = $('lp-day').querySelector('[data-f="hours"]');
    f?.focus(); f?.select();
    return;
  }
  if (e.target.closest('[data-cancel]')) { lp.editing = null; refreshLogDay(); return; }
  if (e.target.closest('[data-save]')) { saveEdit(); return; }
  const btn = e.target.closest('[data-del]');
  if (!btn) return;
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed', 'danger'); btn.classList.remove('ghost'); btn.textContent = 'Yes, delete';
    return;
  }
  btn.disabled = true;
  try { await deleteTimeEntry(btn.dataset.del); }
  catch (err) { btn.disabled = false; setLogMsg(err?.message ?? String(err)); return; }
  const removed = state.entries.find(x => x.id === btn.dataset.del);
  if (removed) touchWp(removed.wpId, -removed.hours);
  state.entries = state.entries.filter(x => x.id !== btn.dataset.del);
  renderGrid();
  refreshLogDay();
});
$('lp-day').addEventListener('keydown', e => {
  if (!lp.editing || !e.target.matches('[data-f]')) return;
  if (e.key === 'Enter')  { e.preventDefault(); e.stopPropagation(); saveEdit(); }
  if (e.key === 'Escape') { e.stopPropagation(); lp.editing = null; refreshLogDay(); }
});

// ─── Filter events ────────────────────────────────────────────────────────────

// Project picker: selection is applied when the popover closes, so ticking
// three projects triggers one reload, not three.
function openProjectPop() {
  renderProjectList();
  $('inp-project-search').value = '';
  $('project-pop').hidden = false;
  $('btn-projects').setAttribute('aria-expanded', 'true');
  $('inp-project-search').focus();
}

async function closeProjectPop() {
  if ($('project-pop').hidden) return;
  $('project-pop').hidden = true;
  $('btn-projects').setAttribute('aria-expanded', 'false');

  const picked = [...$('project-list').querySelectorAll('input:checked')].map(i => i.value);
  const next = picked.length ? picked : state.projectIds;   // never allow an empty selection
  if (next.join() === state.projectIds.join()) return;
  state.projectIds = next;
  renderProjectButton();
  await applyProjects();
}

// Sprints are a fixed calendar, so switching projects keeps the chosen range.
async function applyProjects() {
  await saveLast({ projectIds: state.projectIds });
  load();
}

$('btn-projects').addEventListener('click', () => {
  if ($('project-pop').hidden) openProjectPop(); else closeProjectPop();
});
$('inp-project-search').addEventListener('input', () => {
  const q = $('inp-project-search').value.trim().toLowerCase();
  $('project-list').querySelectorAll('label').forEach(l => { l.style.display = l.dataset.name.includes(q) ? '' : 'none'; });
});
document.addEventListener('click', e => {
  if (!e.target.closest('#project-picker')) closeProjectPop();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('project-pop').hidden) { closeProjectPop(); $('btn-projects').focus(); }
});

$('sel-sprint').addEventListener('change', async () => {
  const p = state.sprints.find(x => x.key === $('sel-sprint').value);
  if (p) { $('inp-from').value = p.startDate; $('inp-to').value = p.endDate; }
  await saveLast({ sprintKey: p ? p.key : null });
  load();
});

for (const id of ['inp-from', 'inp-to']) {
  $(id).addEventListener('change', () => {
    const p = state.sprints.find(x => x.key === $('sel-sprint').value);
    if (p && (p.startDate !== $('inp-from').value || p.endDate !== $('inp-to').value)) $('sel-sprint').value = '';
    load();
  });
}

$('sel-group').addEventListener('change', async () => {
  await saveLast({ groupId: $('sel-group').value || null });
  showGroup();
});

$('btn-refresh').addEventListener('click', () => {
  state.projectIds.forEach(id => state.members.delete(id));
  load();
});

// ─── Groups drawer ────────────────────────────────────────────────────────────

async function persistGroups(groups = state.groups) {
  await chrome.storage.sync.set({ [GROUPS_KEY]: groups });
}

function renderGroupList() {
  $('group-list').innerHTML =
    state.groups.map(g => `<button class="group-row" data-id="${esc(g.id)}" aria-current="${g.id === state.editingId}">
        <span>${esc(g.name)}</span><span class="cnt">${g.userIds.length}</span></button>`).join('') +
    `<button class="group-row new" data-id="" aria-current="${state.editingId === null}">+ New group</button>`;
}

function memberCandidates(group) {
  const projectMap = cachedSelectedMembers();
  const ids = new Set([...projectMap.keys(), ...state.entries.map(e => e.userId), ...(group?.userIds ?? [])]);
  return [...ids]
    .map(id => ({ id, name: nameFor(id), inProject: projectMap.has(id) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Refreshes the counter and the chip strip of selected members; the chips stay
 *  visible while the checklist is filtered, so the selection is never hidden. */
function updateMemberCount() {
  const checked = [...$('member-list').querySelectorAll('input:checked')];
  $('member-count').textContent = `${checked.length} selected`;
  $('member-chips').innerHTML = checked
    .map(i => ({ id: i.value, name: i.dataset.name }))
    .map(m => `<button type="button" class="chip" data-id="${esc(m.id)}" aria-label="Remove ${esc(m.name)}">
        ${avatarHtml(m.id, m.name)}${esc(m.name)}<span class="x" aria-hidden="true">✕</span></button>`)
    .join('');
  hydrateAvatars($('member-chips'));
}

function openEditor(groupId) {
  state.editingId = groupId;
  const group = state.groups.find(g => g.id === groupId);
  const selected = new Set(group?.userIds ?? []);
  $('inp-group-name').value = group?.name ?? '';
  $('inp-member-search').value = '';
  $('editor-msg').textContent = '';
  $('btn-group-delete').disabled = !group;

  $('member-list').innerHTML = memberCandidates(group).map(m => `<label data-name="${esc(m.name.toLowerCase())}">
      <input type="checkbox" value="${esc(m.id)}" data-name="${esc(m.name)}" ${selected.has(m.id) ? 'checked' : ''} />
      ${avatarHtml(m.id, m.name)}<span>${esc(m.name)}</span>${m.inProject ? '' : '<span class="extra">not in project</span>'}
    </label>`).join('') || '<div class="state-msg">No members found for this project.</div>';

  updateMemberCount();
  hydrateAvatars($('member-list'));
  renderGroupList();
}

function openDrawer() {
  document.body.classList.add('drawer-open');
  const current = $('sel-group').value;
  openEditor(state.groups.some(g => g.id === current) ? current : null);
  $('inp-group-name').focus();
}
function closeDrawer() {
  document.body.classList.remove('drawer-open');
  $('btn-groups').focus();
}

$('btn-groups').addEventListener('click', async () => {
  try { await selectedMembers(); } catch { /* checklist falls back to entry users */ }
  openDrawer();
});
$('btn-drawer-close').addEventListener('click', closeDrawer);
$('drawer-backdrop').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && document.body.classList.contains('drawer-open')) closeDrawer();
});

$('group-list').addEventListener('click', e => {
  const row = e.target.closest('.group-row');
  if (row) openEditor(row.dataset.id || null);
});

$('member-list').addEventListener('change', updateMemberCount);
$('member-chips').addEventListener('click', e => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  const box = [...$('member-list').querySelectorAll('input')].find(i => i.value === chip.dataset.id);
  if (box) box.checked = false;
  updateMemberCount();
});
$('inp-member-search').addEventListener('input', () => {
  const q = $('inp-member-search').value.trim().toLowerCase();
  $('member-list').querySelectorAll('label').forEach(l => { l.style.display = l.dataset.name.includes(q) ? '' : 'none'; });
});
$('btn-select-all').addEventListener('click', () => {
  $('member-list').querySelectorAll('label').forEach(l => { if (l.style.display !== 'none') l.querySelector('input').checked = true; });
  updateMemberCount();
});
$('btn-select-none').addEventListener('click', () => {
  $('member-list').querySelectorAll('label').forEach(l => { if (l.style.display !== 'none') l.querySelector('input').checked = false; });
  updateMemberCount();
});

$('btn-group-save').addEventListener('click', async () => {
  const name = $('inp-group-name').value.trim();
  const userIds = [...$('member-list').querySelectorAll('input:checked')].map(i => i.value);
  if (!name)           { $('editor-msg').textContent = 'Give the group a name.'; $('inp-group-name').focus(); return; }
  if (!userIds.length) { $('editor-msg').textContent = 'Select at least one member.'; return; }
  if (state.groups.some(g => g.id !== state.editingId && g.name.toLowerCase() === name.toLowerCase())) {
    $('editor-msg').textContent = 'A group with this name already exists.'; return;
  }

  const existing = state.groups.find(g => g.id === state.editingId);
  const group = existing ? { ...existing, name, userIds } : { id: crypto.randomUUID(), name, userIds };
  const next = existing ? state.groups.map(g => (g === existing ? group : g)) : [...state.groups, group];

  try { await persistGroups(next); }
  catch (err) { $('editor-msg').textContent = `Could not save: ${err.message}`; return; }
  state.groups = next;

  renderGroupSelect();
  $('sel-group').value = group.id;
  await saveLast({ groupId: group.id });
  closeDrawer();
  load();
});

$('btn-group-delete').addEventListener('click', async () => {
  const idx = state.groups.findIndex(g => g.id === state.editingId);
  if (idx < 0) return;
  const removed = state.groups[idx];
  const next = state.groups.filter((_, i) => i !== idx);
  try { await persistGroups(next); }
  catch (err) { showToast(`Could not delete: ${err.message}`); return; }
  state.groups = next;
  const wasSelected = $('sel-group').value === removed.id;
  renderGroupSelect();
  openEditor(null);
  if (wasSelected) { await saveLast({ groupId: null }); load(); }

  showToast(`Deleted “${removed.name}”`, 'Undo', async () => {
    const restored = [...state.groups];
    restored.splice(Math.min(idx, restored.length), 0, removed);
    try { await persistGroups(restored); }
    catch (err) { showToast(`Could not restore: ${err.message}`); return; }
    state.groups = restored;
    renderGroupSelect();
    if (document.body.classList.contains('drawer-open')) openEditor(removed.id);
    if (wasSelected) { $('sel-group').value = removed.id; await saveLast({ groupId: removed.id }); load(); }
  });
});

// Groups edited on another device/tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync' || !changes[GROUPS_KEY]) return;
  state.groups = changes[GROUPS_KEY].newValue ?? [];
  renderGroupSelect();
  if (document.body.classList.contains('drawer-open')) renderGroupList();
});

// The help folds away once you know it; the choice is remembered in this browser only.
const helpEl = $('log-help');
try { if (localStorage.getItem('blm-timelog-help') === 'closed') helpEl.open = false; else helpEl.open = true; } catch { helpEl.open = true; }
helpEl.addEventListener('toggle', () => {
  try { localStorage.setItem('blm-timelog-help', helpEl.open ? 'open' : 'closed'); } catch { /* private window */ }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(GROUPS_KEY),
    chrome.storage.local.get(LAST_KEY),
  ]);
  state.groups = sync[GROUPS_KEY] ?? [];
  state.last   = local[LAST_KEY] ?? {};
  renderGroupSelect();
  loadSprints();
  fetchMyUserId().then(id => { state.meId = id; if (id && state.entries.length) renderGrid(); });

  try {
    await loadProjects();
  } catch (err) {
    handleError(err, init);
    return;
  }
  load();
}

init();
