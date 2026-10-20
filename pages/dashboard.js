// dashboard.js — the Settings page: one switch per feature, saved on change.
// Each .feature[data-key] maps to a chrome.storage.local flag; data-default is
// the value a missing key means (a missing key is "never set", not "off").

import { currentSprint, todayStr } from '../shared/me.js';
import { getHost } from '../shared/config.js';

getHost().then(h => { if (h) document.getElementById('host-label').textContent = new URL(h).host; });

const META_KEY    = '__blm_sync_meta';
const TRACKED_KEY = '__blm_tracked';
const TASK_KEY    = '__blm_logtime_task';
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const features = [...document.querySelectorAll('.feature[data-key]')];

function relativeTime(iso) {
  if (!iso) return '';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function setStatus(el, text, tone = '') {
  el.textContent = text;
  el.className = `status${tone ? ' ' + tone : ''}`;
}

const dayLabel = ds => `${DOW[new Date(ds + 'T12:00:00Z').getUTCDay()]} ${ds.slice(8)}/${ds.slice(5, 7)}`;

function lastWorkdayOfMonth(today) {
  const [y, m] = today.split('-').map(Number);
  const d = new Date(Date.UTC(y, m, 0, 12));
  while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function renderStatuses() {
  const s = await chrome.storage.local.get([META_KEY, TRACKED_KEY, TASK_KEY]);

  const burnEl  = document.getElementById('burndown-status');
  const burnOn  = document.getElementById('f-burndown').checked;
  const tracked = (s[TRACKED_KEY] ?? []).length;
  const meta    = s[META_KEY];
  if (!burnOn)                      setStatus(burnEl, 'Off');
  else if (meta?.status === 'error') setStatus(burnEl, meta.error === 'not-authenticated' ? 'Last sync failed: signed out' : 'Last sync failed', 'err');
  else if (meta?.status === 'syncing') setStatus(burnEl, 'Syncing…');
  else if (!tracked)                setStatus(burnEl, 'No versions tracked yet', 'warn');
  else setStatus(burnEl, `${tracked} version${tracked === 1 ? '' : 's'} · synced ${relativeTime(meta?.lastSync) || 'not yet'}`, 'ok');

  const remEl = document.getElementById('reminder-status');
  if (!document.getElementById('f-reminder').checked) { setStatus(remEl, 'Off'); return; }
  const open = (s[TASK_KEY]?.items ?? []).filter(i => !i.acked);
  if (open.length) {
    setStatus(remEl, `Due now: ${open.map(i => i.name).join(', ')}`, 'warn');
    return;
  }
  const today  = todayStr();
  const sprint = currentSprint(today);
  const next = [
    sprint && { name: `Sprint ${sprint.name}`, date: sprint.endDate },
    { name: 'month end', date: lastWorkdayOfMonth(today) },
  ].filter(Boolean).filter(d => d.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (next) setStatus(remEl, `Next: ${next.name}, ${dayLabel(next.date)}`);
}

const DEV_KEY = '__blm_dev_unlocked';
const lab = document.getElementById('group-lab');

async function initLab() {
  lab.hidden = !(await chrome.storage.local.get(DEV_KEY))[DEV_KEY];
  document.getElementById('lab-hide').addEventListener('click', async e => {
    e.preventDefault();
    await chrome.storage.local.set({ [DEV_KEY]: false, __blm_smart_log: false });   // hiding them also turns them off
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && DEV_KEY in changes) lab.hidden = !changes[DEV_KEY].newValue;
  });
}

// Keep in step with FIXED_CFG_DEFAULTS in content/progress-hook-relay.js.
const FIXED_KEY      = '__blm_fixed_version_cfg';
const FIXED_DEFAULTS = { sprint: '26.10.B', version: '2.47', types: 'Bug', related: true };
const SPRINT_RE      = /^(\d{4}|\d{2})\.(0?[1-9]|1[0-2])\.[AB]$/i;
const RELEASE_RE     = /^\d+\.\d+$/;

async function initFixedVersion() {
  const el = {
    sprint:  document.getElementById('fx-sprint'),
    version: document.getElementById('fx-version'),
    types:   document.getElementById('fx-types'),
    related: document.getElementById('fx-related'),
    status:  document.getElementById('fx-status'),
  };
  const cfg = { ...FIXED_DEFAULTS, ...(await chrome.storage.local.get(FIXED_KEY))[FIXED_KEY] };
  el.sprint.value    = cfg.sprint;
  el.version.value   = cfg.version;
  el.types.value     = cfg.types;
  el.related.checked = cfg.related;

  const save = async () => {
    const cfg = {
      sprint:  el.sprint.value.trim().toUpperCase(),
      version: el.version.value.trim(),
      types:   el.types.value.split(',').map(s => s.trim()).filter(Boolean).join(', '),
      related: el.related.checked,
    };
    const badSprint  = !SPRINT_RE.test(cfg.sprint);
    const badRelease = !RELEASE_RE.test(cfg.version);
    el.sprint.setAttribute('aria-invalid', String(badSprint));
    el.version.setAttribute('aria-invalid', String(badRelease));
    el.types.setAttribute('aria-invalid', String(!cfg.types));
    if (badSprint)  return setStatus(el.status, 'Sprint looks like 26.10.B (year.month.A or B)', 'err');
    if (badRelease) return setStatus(el.status, 'Release looks like 2.47', 'err');
    if (!cfg.types) return setStatus(el.status, 'Name at least one type, e.g. Bug', 'err');
    await chrome.storage.local.set({ [FIXED_KEY]: cfg });
    setStatus(el.status, 'Saved', 'ok');
  };
  for (const input of [el.sprint, el.version, el.types]) input.addEventListener('change', save);
  el.related.addEventListener('change', save);
}

async function init() {
  initLab();
  initFixedVersion();
  const stored = await chrome.storage.local.get(features.map(f => f.dataset.key));
  for (const f of features) {
    const input = f.querySelector('.switch');
    input.checked = stored[f.dataset.key] ?? (f.dataset.default === 'true');
    f.classList.toggle('off', !input.checked);
    input.addEventListener('change', async () => {
      f.classList.toggle('off', !input.checked);
      await chrome.storage.local.set({ [f.dataset.key]: input.checked });
      renderStatuses();
    });
  }

  const theme = window.blmTheme.get();
  for (const r of document.querySelectorAll('input[name="theme"]')) {
    r.checked = r.value === theme;
    r.addEventListener('change', () => { if (r.checked) window.blmTheme.set(r.value); });
  }
  document.addEventListener('blm-theme-change', e => {
    const r = document.querySelector(`input[name="theme"][value="${e.detail}"]`);
    if (r) r.checked = true;
  });

  renderStatuses();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const f of features) {
      if (f.dataset.key in changes) {
        const input = f.querySelector('.switch');
        input.checked = changes[f.dataset.key].newValue ?? (f.dataset.default === 'true');
        f.classList.toggle('off', !input.checked);
      }
    }
    if ([META_KEY, TRACKED_KEY, TASK_KEY].some(k => k in changes)) renderStatuses();
  });
}

init();
