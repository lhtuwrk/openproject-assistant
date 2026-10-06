// reminder.js — log-time deadline reminders (imported by background.js)
//
// Rule: every user must have their time logged before the end of each sprint
// and the end of each month. On the deadline day (and the working day before)
// every user gets a "log your time" task, purely from the calendar — no server
// calls. It stays until the user clicks Done. The task is computed here only
// and written to chrome.storage.local under TASK_KEY; every surface renders it:
//   · toolbar badge        (this file)
//   · Windows notification (this file, throttled)
//   · popup task card      (popup.js)
//   · floating card        (reminder-banner.js, every website, from 16:00)

import { sprintCalendar } from '../shared/api.js';

export const TASK_KEY          = '__blm_logtime_task';     // { updatedAt, items:[…] }
export const ACK_KEY           = '__blm_logtime_ack';      // { [deadlineKey]: isoTime } — user marked done
const NOTIFIED_KEY             = '__blm_logtime_notified'; // { [deadlineKey]: epochMs } — last notification
export const CFG_REMINDER      = '__blm_logtime_reminder'; // default: true
const LEGACY_TEST_KEY          = '__blm_logtime_test';     // removed test-mode flag
const SCHEMA_KEY               = '__blm_logtime_schema';   // bumped when stored reminder state must reset
const FLOAT_KEY                = '__blm_logtime_float';    // floating card hide/snooze state

const ALARM            = 'blm-logtime-check';
const CHECK_EVERY_MIN  = 30;
const NOTIFY_EVERY_MS  = 3 * 3600 * 1000;
const SNOOZE_MS        = 3600 * 1000;
const WORK_HOURS       = [8, 18];      // notifications only inside this local window
const LEAD_WORKDAYS    = 1;            // also remind this many working days before the deadline
const NOTIFICATION_ID  = 'blm-logtime';
const DOW   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
               'August', 'September', 'October', 'November', 'December'];

// ─── Dates (local calendar, YYYY-MM-DD strings) ───────────────────────────────

function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const utc = s => new Date(s + 'T12:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
const isWeekend = s => [0, 6].includes(utc(s).getUTCDay());

function addDays(s, n) { const d = utc(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }

function lastWorkday(s) { while (isWeekend(s)) s = addDays(s, -1); return s; }

function workdaysBefore(s, n) {
  while (n > 0) { s = addDays(s, -1); if (!isWeekend(s)) n--; }
  return s;
}

function daysBetween(from, to) {
  const out = [];
  for (let s = from; s <= to; s = addDays(s, 1)) out.push(s);
  return out;
}

const mmdd  = s => `${s.slice(5, 7)}/${s.slice(8, 10)}`;
const label = s => `${DOW[utc(s).getUTCDay()]} ${mmdd(s)}`;

// ─── Deadlines ────────────────────────────────────────────────────────────────

/** Deadlines whose reminder window contains today. */
function dueDeadlines(today, sprints) {
  const inWindow = deadline => today <= deadline && today >= workdaysBefore(deadline, LEAD_WORKDAYS);
  const out = [];

  const sprint = sprints.find(p => inWindow(lastWorkday(p.endDate)));
  if (sprint) {
    out.push({ key: `sprint:${sprint.key}`, kind: 'sprint', name: `Sprint ${sprint.name}`,
               start: sprint.startDate, end: sprint.endDate, deadline: lastWorkday(sprint.endDate) });
  }

  const [y, m] = today.split('-').map(Number);
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const monthEnd   = iso(new Date(Date.UTC(y, m, 0, 12)));
  const monthDue   = lastWorkday(monthEnd);
  if (inWindow(monthDue)) {
    out.push({ key: `month:${monthStart.slice(0, 7)}`, kind: 'month', name: `${MONTH[m - 1]} ${y}`,
               start: monthStart, end: monthEnd, deadline: monthDue });
  }
  return out;
}

// ─── Check ────────────────────────────────────────────────────────────────────

async function reminderEnabled() {
  return (await chrome.storage.local.get(CFG_REMINDER))[CFG_REMINDER] ?? true;
}

/** One-off cleanup after the test-mode rollout: Done/snooze clicks made while
 *  testing must not silence the real deadlines. */
async function migrate() {
  if ((await chrome.storage.local.get(SCHEMA_KEY))[SCHEMA_KEY] >= 2) return;
  await chrome.storage.local.remove([LEGACY_TEST_KEY, ACK_KEY, NOTIFIED_KEY, FLOAT_KEY]);
  await chrome.storage.local.set({ [SCHEMA_KEY]: 2 });
}

/**
 * Recomputes the task, updates the badge and (when due) shows a notification.
 * @param {{notify?: boolean}} opts  notify=false for popup-triggered refreshes
 */
export async function checkLogTime({ notify = true } = {}) {
  await migrate();
  if (!(await reminderEnabled())) {
    await chrome.storage.local.set({ [TASK_KEY]: { updatedAt: new Date().toISOString(), items: [] } });
    await updateBadge([]);
    return;
  }

  const today = localDateStr();
  const ack   = (await chrome.storage.local.get(ACK_KEY))[ACK_KEY] ?? {};
  const items = dueDeadlines(today, sprintCalendar(today)).map(d => ({
    ...d,
    daysLeft: Math.max(0, daysBetween(addDays(today, 1), d.deadline).filter(s => !isWeekend(s)).length),
    acked: Boolean(ack[d.key]),
  }));
  const task = { updatedAt: new Date().toISOString(), items };

  await chrome.storage.local.set({ [TASK_KEY]: task });
  const open = openItems(task);
  await updateBadge(open);
  if (notify) await maybeNotify(open);
}

export function openItems(task) {
  return (task?.items ?? []).filter(i => !i.acked);
}

// ─── Badge + notification ─────────────────────────────────────────────────────

async function updateBadge(open) {
  await chrome.action.setBadgeText({ text: open.length ? String(open.length) : '' });
  if (open.length) await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
}

function dueText(item) {
  if (item.daysLeft <= 0) return 'ends today';
  if (item.daysLeft === 1) return 'ends tomorrow';
  return `ends ${label(item.deadline)}`;
}

async function maybeNotify(open) {
  const hour = new Date().getHours();
  if (!open.length || hour < WORK_HOURS[0] || hour >= WORK_HOURS[1]) return;

  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] ?? {};
  const now = Date.now();
  const due = open.filter(i => now - (notified[i.key] ?? 0) >= NOTIFY_EVERY_MS);
  if (!due.length) return;

  const first = due[0];
  await chrome.notifications.create(NOTIFICATION_ID, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/reminder-128.png'),
    title: `Log your time — ${first.name} ${dueText(first)}`,
    message: 'Complete your log time, then click Done in Backlog Monitor.',
    contextMessage: due.length > 1 ? `Also due: ${due.slice(1).map(i => i.name).join(', ')}` : 'Backlog Monitor',
    buttons: [{ title: 'Done' }, { title: 'Snooze 1 h' }],
    priority: 2,
    requireInteraction: true,
  });
  for (const i of due) notified[i.key] = now;
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
}

async function snooze() {
  const task = (await chrome.storage.local.get(TASK_KEY))[TASK_KEY];
  const notified = (await chrome.storage.local.get(NOTIFIED_KEY))[NOTIFIED_KEY] ?? {};
  const at = Date.now() - NOTIFY_EVERY_MS + SNOOZE_MS;       // next notification in 1 h
  for (const i of openItems(task)) notified[i.key] = at;
  await chrome.storage.local.set({ [NOTIFIED_KEY]: notified });
}

/** Opens the toolbar popup when Chrome allows it, else the Time Log page. */
export async function openReminderUi() {
  try { await chrome.action.openPopup(); }
  catch { await chrome.tabs.create({ url: chrome.runtime.getURL('pages/timelog.html') }); }
}

async function ackAllOpen() {
  const task = (await chrome.storage.local.get(TASK_KEY))[TASK_KEY];
  const ack  = (await chrome.storage.local.get(ACK_KEY))[ACK_KEY] ?? {};
  for (const i of openItems(task)) ack[i.key] = new Date().toISOString();
  await chrome.storage.local.set({ [ACK_KEY]: ack });
  await checkLogTime({ notify: false });
}

export async function ackItem(key) {
  const ack = (await chrome.storage.local.get(ACK_KEY))[ACK_KEY] ?? {};
  ack[key] = new Date().toISOString();
  await chrome.storage.local.set({ [ACK_KEY]: ack });
  await checkLogTime({ notify: false });
}

// ─── Wiring ───────────────────────────────────────────────────────────────────

export function setupReminder() {
  // Create the alarm only if missing: re-creating on every service-worker wake
  // would keep pushing the first run back.
  chrome.alarms.get(ALARM).then(a => {
    if (!a) chrome.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: CHECK_EVERY_MIN });
  });

  chrome.alarms.onAlarm.addListener(alarm => {
    if (alarm.name === ALARM) checkLogTime();
  });

  chrome.runtime.onStartup.addListener(() => checkLogTime());
  chrome.runtime.onInstalled.addListener(() => checkLogTime());

  chrome.notifications.onClicked.addListener(id => {
    if (id !== NOTIFICATION_ID) return;
    chrome.notifications.clear(id);
    openReminderUi();
  });
  chrome.notifications.onButtonClicked.addListener((id, index) => {
    if (id !== NOTIFICATION_ID) return;
    chrome.notifications.clear(id);
    if (index === 0) ackAllOpen(); else snooze();
  });

  // Settings toggled in the popup take effect immediately.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && CFG_REMINDER in changes) {
      checkLogTime({ notify: false });
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'logtime-refresh') {
      checkLogTime({ notify: false }).then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'logtime-ack') {
      ackItem(msg.key).then(() => sendResponse({ ok: true }));
      return true;
    }
  });
}
