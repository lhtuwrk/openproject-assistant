// me.js — the signed-in user and their own logged time, shared by the popup and
// the dashboard rail. The profile is cached in chrome.storage.local so both can
// paint a name immediately and refresh it in the background.

import { fetchMe, fetchUserAvatar, fetchTimeEntries, sprintCalendar } from './api.js';

export const ME_KEY     = '__blm_me';         // { id, name, login, email, at }
export const AVATAR_KEY = '__blm_me_avatar';  // { id, dataUrl } — painted at once, refreshed after

export const DAILY_TARGET = 8, OVER_TARGET = 9;
const EPS = 0.005;

export function todayStr() {
  const n = new Date();
  return [n.getFullYear(), String(n.getMonth() + 1).padStart(2, '0'), String(n.getDate()).padStart(2, '0')].join('-');
}

export async function cachedMe() {
  return (await chrome.storage.local.get(ME_KEY))[ME_KEY] ?? null;
}

/** Fetches the profile and updates the cache. Throws NOT_AUTHENTICATED when signed out. */
export async function refreshMe() {
  const me = { ...(await fetchMe()), at: new Date().toISOString() };
  await chrome.storage.local.set({ [ME_KEY]: me });
  return me;
}

export function initials(name) {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function avatarHue(userId) {
  let h = 0;
  for (const c of String(userId)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return Math.round((h * 137.508) % 360);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function applyAvatar(el, dataUrl) {
  el.style.backgroundImage = dataUrl ? `url("${dataUrl}")` : '';
  el.classList.toggle('has-img', !!dataUrl);
}

/**
 * Fills an .avatar element: the cached image (or initials) at once, then the
 * fresh image — the element only changes if the picture did.
 * @param {{id:string,dataUrl:string}|null} [cached]  pass when already read, to skip a storage round-trip
 */
export async function paintAvatar(el, me, cached) {
  el.textContent = initials(me.name);
  el.style.setProperty('--hue', avatarHue(me.id));
  if (cached === undefined) cached = (await chrome.storage.local.get(AVATAR_KEY))[AVATAR_KEY] ?? null;
  const known = cached?.id === me.id ? cached.dataUrl : null;
  applyAvatar(el, known);

  const blob = await fetchUserAvatar(me.id);
  if (blob === undefined) return;   // transient failure: keep the cached picture
  const fresh = blob ? await blobToDataUrl(blob) : null;
  if (fresh === known) return;
  if (el.isConnected) applyAvatar(el, fresh);
  await chrome.storage.local.set({ [AVATAR_KEY]: fresh ? { id: me.id, dataUrl: fresh } : null });
}

export function sprints(today = todayStr()) {
  return sprintCalendar(today);
}

export function currentSprint(today = todayStr()) {
  return sprints(today).find(p => p.startDate <= today && today <= p.endDate) ?? null;
}

const isWeekend = ds => [0, 6].includes(new Date(ds + 'T12:00:00Z').getUTCDay());

function daysOf(sprint) {
  const days = [];
  for (let d = new Date(sprint.startDate + 'T12:00:00Z'); d <= new Date(sprint.endDate + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

/**
 * The signed-in user's hours in a sprint.
 * Each weekday gets a state: over · met · under · miss · future.
 */
export async function sprintHours(sprint) {
  const entries = await fetchTimeEntries(null, sprint.startDate, sprint.endDate, { user: 'me' });
  const byDay = new Map();
  for (const e of entries) byDay.set(e.spentOn, (byDay.get(e.spentOn) ?? 0) + e.hours);

  const today    = todayStr();
  const days     = daysOf(sprint);
  const weekdays = days.filter(ds => !isWeekend(ds)).map(ds => {
    const hours = byDay.get(ds) ?? 0;
    let state;
    if (hours >= OVER_TARGET - EPS)       state = 'over';
    else if (hours >= DAILY_TARGET - EPS) state = 'met';
    else if (hours > 0)                   state = 'under';
    else if (ds <= today)                 state = 'miss';
    else                                  state = 'future';
    return { date: ds, hours, state, today: ds === today };
  });

  const elapsed = weekdays.filter(d => d.date <= today);
  return {
    weekdays,
    elapsedDays: elapsed.length,
    logged:   days.filter(ds => ds <= today).reduce((s, ds) => s + (byDay.get(ds) ?? 0), 0),
    expected: elapsed.length * DAILY_TARGET,
    missing:  elapsed.filter(d => d.state === 'miss').length,
    weekend:  days.filter(isWeekend).reduce((s, ds) => s + (byDay.get(ds) ?? 0), 0),
    todayHours: byDay.get(today) ?? 0,
  };
}
