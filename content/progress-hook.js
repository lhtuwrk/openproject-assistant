// progress-hook.js — runs in the page's MAIN world (see manifest.json).
//
// Hooks the app's own work-package status PATCH (XHR / fetch) for two features:
//
//  - Confirm open subtasks: moving a work package to Resolved / Closed / Done while
//    some of its subtasks are still open first asks the user. Cancelling never sends
//    the request — the app gets the unchanged work package back, so it shows the old
//    status again.
//  - Auto progress: when a Task moves to Resolved / Closed / Done, adds
//    `percentageDone: 100` (and `0` when it is reopened from one of those at 100%)
//    to the same PATCH, so OpenProject's native parent progress rises without a
//    second request (a follow-up PATCH would bump lockVersion behind the app's back
//    and cause "conflicting modifications" on the next edit).
//  - Fixed in version: moving a Bug (or a work package related to a Bug) to Resolved
//    while its "Fixed in version" lacks the current sprint's release asks for it,
//    prefilled, and writes it in the same PATCH. The release is counted from an
//    anchor in Settings (e.g. sprint 26.10.B = 2.47), one up per sprint.
//
// Clicking the status button or an inline field shows a spinner on it while the
// form and values it loads are in flight (see "Loading feedback").
//
// Every successful work-package PATCH is also announced to content.js via
// window.postMessage, so it can refresh cached subtask stats (independent of the flags).
// It also sends jira-skin.js's status/assignee edits on its behalf (see the end).
//
// The on/off flags are relayed from chrome.storage by progress-hook-relay.js as
// <html data-blm-auto-progress="on|off" data-blm-confirm-subtasks="on|off" …>. Any
// failure in a check falls back to sending the original request untouched — the
// user's status change is never blocked by an error of ours.

(() => {
  'use strict';

  const WP_PATH_RE         = /^\/api\/v3\/work_packages\/(\d+)\/?$/;
  const AUTO_DONE_STATUSES = new Set(['resolved', 'closed', 'done']);   // not "rejected"
  const SUBTASK_CLOSED     = new Set(['resolved', 'closed', 'done', 'rejected']);
  const AUTO_TYPES         = new Set(['task']);

  // Longest we hold back the user's save for our pre-checks; past it, the original
  // request goes out untouched. The confirm dialog itself is not time-limited.
  const CHECK_TIMEOUT_MS = 2000;

  const FIXED_FIELD    = 'customField7';   // "Fixed in version", e.g. "2.35, 2.40, 2.47"
  const FIXED_STATUS   = 'resolved';

  const nativeFetch = window.fetch.bind(window);
  let statusNames = null;   // Promise<Map<id, name>>, loaded once per page
  const schemas = new Map();   // schema href -> Promise<schema>, once per page

  const autoProgressOn = () => document.documentElement.dataset.blmAutoProgress !== 'off';
  const confirmOn      = () => document.documentElement.dataset.blmConfirmSubtasks !== 'off';
  const fixedOn        = () => document.documentElement.dataset.blmFixedVersion !== 'off';

  function idFromHref(href) {
    const m = /(\d+)\s*$/.exec(href ?? '');
    return m ? m[1] : null;
  }

  async function getJson(path) {
    const res = await nativeFetch(path, {
      credentials: 'include',
      cache: 'no-store',   // must see the current status/progress, not a cached copy
      headers: { Accept: 'application/hal+json' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
    return res.json();
  }

  function loadStatusNames() {
    statusNames ??= getJson('/api/v3/statuses')
      .then(data => new Map(
        (data._embedded?.elements ?? []).map(s => [String(s.id), String(s.name)])
      ))
      .catch(err => { statusNames = null; throw err; });
    return statusNames;
  }

  const isDoneStatus = (name) => AUTO_DONE_STATUSES.has(String(name).toLowerCase());

  // The skin's lozenge tone (statusTone in jira-skin.js); open subtasks are never done.
  const statusTone = (name) => (/progress|review|test|develop|implement/i.test(name) ? 'progress' : 'todo');

  // ─── Work packages already seen ───────────────────────────────────────────────
  // The checks below need the work package's type, children, progress and status.
  // The app has just loaded it to show it, so its GET (and every PATCH answer) is
  // kept here and reused while its lockVersion matches the one the PATCH carries:
  // a PATCH with that lockVersion only succeeds if the work package is unchanged
  // since, so the copy is exactly what the server will check against.

  const WP_SEEN_MAX = 50;
  const wpSeen = new Map();   // id -> work package JSON
  const typeNames = new Map();   // type href -> Promise<name>

  // A write elsewhere (e.g. adding a child) may change what the checks read without
  // bumping this lockVersion, so every completed save drops all copies. The app's
  // edit forms (POST …/form) save nothing and keep them.
  const savesData = (method, url) =>
    isApiWrite(method, url) && !/\/form\/?$/.test(new URL(url, location.href).pathname);

  const forgetWps = () => wpSeen.clear();

  function rememberWp(wp) {
    if (wp?._type !== 'WorkPackage' || wp.id == null) return;
    const id = String(wp.id);
    wpSeen.delete(id);
    wpSeen.set(id, wp);
    if (wpSeen.size > WP_SEEN_MAX) wpSeen.delete(wpSeen.keys().next().value);
    // What a status change will need, loaded now instead of while the user waits.
    loadStatusNames().catch(() => {});
    if (fixedOn() || AUTO_TYPES.has(String(wp._links?.type?.title).toLowerCase())) {
      schemaOf(wp._links?.schema?.href).catch(() => {});
    }
  }

  /** The work package as the PATCH's lockVersion knows it: the copy already seen, else a GET. */
  async function wpAt(wpId, lockVersion) {
    const seen = wpSeen.get(wpId);
    if (seen && lockVersion != null && seen.lockVersion === lockVersion) return seen;
    const wp = await getJson(`/api/v3/work_packages/${wpId}`);
    rememberWp(wp);
    return wp;
  }

  function typeName(href) {
    if (!typeNames.has(href)) {
      typeNames.set(href, getJson(href)
        .then(t => t.name)
        .catch(err => { typeNames.delete(href); throw err; }));
    }
    return typeNames.get(href);
  }

  /** Resolves to null after ms, or on error — callers then fall back to the original request. */
  function bounded(promise, ms) {
    let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(resolve, ms, null); });
    return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Whether the schema lets Progress be written. False when OpenProject derives it
   * (status-based progress, field disabled, newer progress models) — injecting it
   * then would make the server reject the user's whole status change.
   */
  async function canWriteProgress(schemaHref) {
    return (await schemaOf(schemaHref))?.percentageDone?.writable === true;
  }

  function schemaOf(href) {
    if (!href) return Promise.resolve(null);
    if (!schemas.has(href)) {
      schemas.set(href, getJson(href).catch(err => { schemas.delete(href); throw err; }));
    }
    return schemas.get(href);
  }

  /** The work-package id if this is a PATCH to /api/v3/work_packages/<id>. */
  function wpPatchId(method, url) {
    if (String(method).toUpperCase() !== 'PATCH') return null;
    const m = WP_PATH_RE.exec(new URL(url, location.href).pathname);
    return m ? m[1] : null;
  }

  /** Cheap synchronous pre-filter so unrelated requests are never delayed. */
  function wpIdIfCandidate(method, url, body) {
    if (!(autoProgressOn() || confirmOn() || fixedOn())) return null;
    if (typeof body !== 'string' || !body.includes('status')) return null;
    return wpPatchId(method, url);
  }

  function notifyUpdated(wpId) {
    window.postMessage({ source: 'blm-progress-hook', type: 'wp-updated', id: wpId }, location.origin);
  }

  // ─── Confirm resolving with open subtasks ─────────────────────────────────────

  /** { statusName, open: [{id, subject, status}] } when this PATCH resolves a WP with open subtasks. */
  async function openSubtasksIfResolving(wpId, payload, wpReady) {
    const statusId = idFromHref(payload._links?.status?.href);
    if (!statusId) return null;
    const statusName = (await loadStatusNames()).get(statusId);
    if (!isDoneStatus(statusName)) return null;
    const wp = await wpReady.catch(() => null);
    if (wp && !wp._links?.children?.length) return null;   // no subtasks: nothing to ask

    const filter = encodeURIComponent(JSON.stringify([{ parent: { operator: '=', values: [wpId] } }]));
    const data   = await getJson(`/api/v3/work_packages?filters=${filter}&pageSize=200`);
    const open   = (data._embedded?.elements ?? [])
      .map(k => ({ id: k.id, subject: k.subject ?? `#${k.id}`, status: k._links?.status?.title ?? '?' }))
      .filter(k => !SUBTASK_CLOSED.has(k.status.toLowerCase()));
    return open.length ? { statusName, open } : null;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  // The skin's look (light and Catppuccin Mocha dark). A closed shadow root can't
  // read the page's --jx-* variables, so the values are copied here: keep them in
  // step with the token blocks in jira-skin.js.
  const DIALOG_CSS = `
    :host { all:initial;
      --font:ui-sans-serif, -apple-system, "Segoe UI", system-ui, Roboto, "Helvetica Neue", sans-serif;
      --text:#172b4d; --text-subtle:#44546f; --surface:#ffffff; --border:rgba(9,30,66,.14);
      --btn:rgba(9,30,66,.06); --btn-hover:rgba(9,30,66,.14); --btn-press:rgba(9,30,66,.22);
      --primary:#0c66e4; --primary-hover:#0055cc; --on-primary:#ffffff; --focus:#388bff;
      --todo-bg:rgba(9,30,66,.08); --todo-fg:#44546f; --progress-bg:#e9f2ff; --progress-fg:#0055cc;
      --scrim:rgba(9,30,66,.25);
      --shadow:0 8px 12px rgba(9,30,66,.15), 0 0 1px rgba(9,30,66,.31); }
    :host-context(html.blm-jira[data-blm-theme="dark"]) {
      --text:#cdd6f4; --text-subtle:#a6adc8; --surface:#1e1e2e; --border:rgba(205,214,244,.09);
      --btn:rgba(205,214,244,.07); --btn-hover:rgba(205,214,244,.13); --btn-press:rgba(205,214,244,.19);
      --primary:#89b4fa; --primary-hover:#b4befe; --on-primary:#11111b; --focus:#89b4fa;
      --todo-bg:rgba(205,214,244,.09); --todo-fg:#bac2de; --progress-bg:rgba(137,180,250,.16); --progress-fg:#89b4fa;
      --scrim:rgba(17,17,27,.6);
      --shadow:0 8px 24px rgba(17,17,27,.6), 0 0 0 1px rgba(205,214,244,.06); }
    .backdrop { position:fixed; inset:0; z-index:2147483647; background:var(--scrim);
      display:flex; align-items:center; justify-content:center; padding:16px;
      font:14px/20px var(--font); color:var(--text); }
    .dlg { background:var(--surface); border-radius:6px; box-shadow:var(--shadow);
      width:min(460px, 100%); max-height:calc(100vh - 32px); display:flex; flex-direction:column; }
    .head { padding:20px 24px 4px; font-size:16px; font-weight:600; line-height:24px; }
    .sub { padding:0 24px 12px; color:var(--text-subtle); }
    ul { list-style:none; margin:0; padding:0 24px; overflow:auto; }
    li { display:flex; align-items:center; gap:8px; padding:6px 0; }
    li + li { border-top:1px solid var(--border); }
    .id { color:var(--text-subtle); font-weight:600; min-width:52px; font-variant-numeric:tabular-nums; }
    .st { flex:none; max-width:140px; overflow:hidden; text-overflow:ellipsis; height:16px; padding:0 4px;
      border-radius:3px; font-size:11px; font-weight:700; line-height:16px; text-transform:uppercase;
      white-space:nowrap; background:var(--todo-bg); color:var(--todo-fg); }
    .st.progress { background:var(--progress-bg); color:var(--progress-fg); }
    .subj { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .actions { display:flex; justify-content:flex-end; gap:8px; padding:16px 24px 20px; }
    button { font:inherit; font-weight:500; height:32px; padding:0 12px; border:0; border-radius:3px;
      cursor:pointer; background:var(--btn); color:var(--text); }
    button:hover { background:var(--btn-hover); }
    button:active { background:var(--btn-press); }
    button.go { background:var(--primary); color:var(--on-primary); }
    button.go:hover { background:var(--primary-hover); }
    button:focus-visible { outline:2px solid var(--focus); outline-offset:1px; }
    .fld { display:flex; flex-direction:column; gap:4px; padding:0 24px; font-size:12px; font-weight:600;
      line-height:16px; color:var(--text-subtle); }
    .val { font:inherit; font-size:14px; font-weight:400; line-height:20px; color:var(--text); height:32px;
      padding:0 8px; border:2px solid var(--border); border-radius:3px; background:var(--surface); outline:none; }
    .val:focus { border-color:var(--focus); }
  `;

  /**
   * Shows a modal dialog and resolves with what `wire(root, done)` passes to done;
   * Esc / backdrop resolve with `cancelValue`. `focus` is the selector focused first.
   */
  function showDialog(inner, { cancelValue, focus, wire }) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>${DIALOG_CSS}</style>
        <div class="backdrop">
          <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="h">${inner}</div>
        </div>`;

      const prevFocus = document.activeElement;
      const backdrop  = root.querySelector('.backdrop');
      const done = (value) => {
        host.remove();
        prevFocus?.focus?.();
        resolve(value);
      };
      wire(root, done);
      backdrop.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) done(cancelValue);
      });
      // Keys stop at the dialog (after its controls got them), so OpenProject's own
      // Esc/Enter handlers on the edit field never react while it is open.
      backdrop.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); done(cancelValue); }
      });
      document.body.appendChild(host);
      root.querySelector(focus).focus();
    });
  }

  /** Resolves true to go ahead, false to cancel. Cancel is focused; Esc / backdrop cancel. */
  function confirmResolve(wpId, { statusName, open }) {
    const n    = open.length;
    const rows = open.map(k => `
      <li><span class="id">#${k.id}</span><span class="st ${statusTone(k.status)}">${escapeHtml(k.status)}</span>
      <span class="subj" title="${escapeHtml(k.subject)}">${escapeHtml(k.subject)}</span></li>`).join('');
    return showDialog(`
      <div class="head" id="h">${escapeHtml(statusName)} #${wpId} with ${n} open subtask${n === 1 ? '' : 's'}?</div>
      <div class="sub">These subtasks are not resolved or closed yet:</div>
      <ul>${rows}</ul>
      <div class="actions">
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="go">${escapeHtml(statusName)} anyway</button>
      </div>`, {
      cancelValue: false,
      focus: '.cancel',
      wire: (root, done) => {
        root.querySelector('.cancel').addEventListener('click', () => done(false));
        root.querySelector('.go').addEventListener('click', () => done(true));
      },
    });
  }

  // ─── Fixed in version ─────────────────────────────────────────────────────────
  // A sprint is named "<team> YY.MM.A" (first half of the month) or "….B" (second
  // half), e.g. "BlueBirds 26.11.A" or "MigrosBank 2026.10.B - v2.47". Each sprint
  // ships one release, so the release is the Settings anchor plus the sprints since.

  const SPRINT_CODE_RE = /(?:^|\D)(\d{4}|\d{2})\.(\d{1,2})\.([AB])(?![A-Za-z0-9])/i;

  function fixedCfg() {
    try { return JSON.parse(document.documentElement.dataset.blmFixedVersionCfg ?? ''); } catch { return null; }
  }

  /** Sprints since year 0, or null when the name has no YY.MM.A/B code. */
  function sprintIndex(name) {
    const m = SPRINT_CODE_RE.exec(String(name ?? ''));
    if (!m) return null;
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    return ((Number(m[1]) % 100) * 12 + month - 1) * 2 + (m[3].toUpperCase() === 'B' ? 1 : 0);
  }

  /** The release the sprint ships ("2.48"), counted from the anchor; null if unknown. */
  function releaseFor(sprintName, cfg) {
    const at   = sprintIndex(sprintName);
    const base = sprintIndex(cfg?.sprint);
    const m    = /^\s*(\d+)\.(\d+)\s*$/.exec(String(cfg?.version ?? ''));
    if (at == null || base == null || !m) return null;
    const minor = Number(m[2]) + at - base;
    return minor < 0 ? null : `${m[1]}.${String(minor).padStart(m[2].length, '0')}`;
  }

  const releaseList = (text) => [...new Set(String(text ?? '').split(',').map(s => s.trim()).filter(Boolean))];

  const typeSet = (cfg) => new Set(String(cfg?.types ?? '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));

  /** The related work package of one of the configured types, or null. */
  async function relatedOfType(wpId, types) {
    const rels = await getJson(`/api/v3/work_packages/${wpId}/relations?pageSize=100`);
    const ids  = new Set();
    for (const r of rels._embedded?.elements ?? []) {
      for (const end of [r._links?.from?.href, r._links?.to?.href]) {
        const id = idFromHref(end);
        if (id && id !== String(wpId)) ids.add(id);
      }
    }
    if (!ids.size) return null;
    const filter = encodeURIComponent(JSON.stringify([
      { id: { operator: '=', values: [...ids] } },
      { status: { operator: '*', values: [] } },
    ]));
    const data = await getJson(`/api/v3/work_packages?filters=${filter}&pageSize=${ids.size}`);
    const hit  = (data._embedded?.elements ?? [])
      .find(k => types.has(String(k._links?.type?.title).toLowerCase()));
    return hit ? { id: hit.id, type: hit._links.type.title } : null;
  }

  /**
   * What the dialog needs when this PATCH resolves a Bug (or a work package related
   * to one) whose Fixed in version lacks the sprint's release; null otherwise.
   */
  async function fixedVersionIfResolving(wpId, payload, wpReady) {
    const cfg      = fixedCfg();
    const statusId = idFromHref(payload._links?.status?.href);
    if (!cfg || !statusId || FIXED_FIELD in payload) return null;
    const names = await loadStatusNames();
    if (String(names.get(statusId)).toLowerCase() !== FIXED_STATUS) return null;

    const wp     = await wpReady;
    const field  = (await schemaOf(wp._links?.schema?.href))?.[FIXED_FIELD];
    if (!field?.writable) return null;   // not a field of this project/type
    const formattable = field.type === 'Formattable';
    const current     = formattable ? wp[FIXED_FIELD]?.raw : wp[FIXED_FIELD];
    const sprint      = payload._links?.version?.title ?? wp._links?.version?.title;
    const release     = releaseFor(sprint, cfg);
    const have        = releaseList(current);
    if (release ? have.includes(release) : have.length) return null;

    const types    = typeSet(cfg);
    const typeHref = payload._links?.type?.href;
    const type     = typeHref ? await typeName(typeHref) : wp._links?.type?.title;
    let reason = null;
    if (types.has(String(type).toLowerCase())) reason = String(type);
    else if (cfg.related) {
      const rel = await relatedOfType(wpId, types);
      if (rel) reason = `Related to ${rel.type} #${rel.id}`;
    }
    if (!reason) return null;

    return {
      label: field.name || 'Fixed in version',
      formattable,
      reason,
      sprint,
      release,
      value: releaseList([...have, release].filter(Boolean).join(',')).join(', '),
    };
  }

  /** Resolves { value } to save it with the status, { skip: true }, or { cancel: true }. */
  function askFixedVersion(wpId, info) {
    const label = escapeHtml(info.label);
    const why   = info.release
      ? `${escapeHtml(info.reason)}. Sprint ${escapeHtml(info.sprint)} ships ${escapeHtml(info.release)}.`
      : `${escapeHtml(info.reason)}. No release is known for ${info.sprint ? `sprint ${escapeHtml(info.sprint)}` : 'this work package (no sprint)'}.`;
    return showDialog(`
      <div class="head" id="h">Resolve #${wpId}: set ${label}?</div>
      <div class="sub">${why}</div>
      <label class="fld">${label}
        <input type="text" class="val" value="${escapeHtml(info.value)}" spellcheck="false" autocomplete="off" />
      </label>
      <div class="actions">
        <button type="button" class="cancel">Cancel</button>
        <button type="button" class="skip">Resolve without</button>
        <button type="button" class="go">Save and resolve</button>
      </div>`, {
      cancelValue: { cancel: true },
      focus: '.val',
      wire: (root, done) => {
        const input = root.querySelector('.val');
        const save  = () => {
          const value = releaseList(input.value).join(', ');
          done(value ? { value } : { skip: true });
        };
        root.querySelector('.cancel').addEventListener('click', () => done({ cancel: true }));
        root.querySelector('.skip').addEventListener('click', () => done({ skip: true }));
        root.querySelector('.go').addEventListener('click', save);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); save(); }
        });
        input.addEventListener('focus', () => input.setSelectionRange(input.value.length, input.value.length));
      },
    });
  }

  /**
   * The answer to a cancelled PATCH, never sent to the server: the work package as it
   * is now, with 200 — the app takes it as a save, closes the editor and shows the old
   * status again. Its "Successful update" toast is hidden. If the current state can't
   * be read, falls back to a 422 on `status` (editor stays open, error toast shown).
   */
  async function cancelledResponse(wpId, message) {
    try {
      const wp = await getJson(`/api/v3/work_packages/${wpId}`);
      suppressSuccessToast();
      return { status: 200, statusText: 'OK', json: wp };
    } catch {
      return {
        status: 422, statusText: 'Unprocessable Entity',
        json: {
          _type: 'Error',
          errorIdentifier: 'urn:openproject-org:api:v3:errors:PropertyConstraintViolation',
          message,
          _embedded: { details: { attribute: 'status' } },
        },
      };
    }
  }

  const TOAST_SUPPRESS_MS = 3000;
  const SUCCESS_TOAST     = '.op-toast.-success';

  /** Hides (and dismisses) the success toast the app shows for our fake save. */
  function suppressSuccessToast() {
    const style = document.createElement('style');
    style.textContent = `${SUCCESS_TOAST} { display:none !important; }`;
    document.head.appendChild(style);

    // Close it through its own button too, so it doesn't reappear when the style goes.
    const dismiss = () => {
      for (const t of document.querySelectorAll(SUCCESS_TOAST)) {
        const close = t.querySelector('.op-toast--close, [class*="close"]');
        if (close) close.click(); else t.remove();
      }
    };
    const obs = new MutationObserver(dismiss);
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => { obs.disconnect(); dismiss(); style.remove(); }, TOAST_SUPPRESS_MS);
  }

  // ─── Auto progress ────────────────────────────────────────────────────────────

  /** Returns the fields to add to the PATCH, or null to add none. */
  async function augmentBody(payload, wpReady) {
    if ('percentageDone' in payload) return null;

    const statusId = idFromHref(payload._links?.status?.href);
    if (!statusId) return null;

    const [names, wp] = await Promise.all([loadStatusNames(), wpReady]);
    const typeHref = payload._links?.type?.href;
    const type     = typeHref ? await typeName(typeHref) : wp._links?.type?.title;
    if (!AUTO_TYPES.has(String(type).toLowerCase())) return null;
    if (wp._links?.children?.length) return null;   // derived progress, not writable
    if (!(await canWriteProgress(wp._links?.schema?.href))) return null;

    const current     = wp.percentageDone ?? 0;
    const wasDone     = isDoneStatus(names.get(idFromHref(wp._links?.status?.href)));
    const becomesDone = isDoneStatus(names.get(statusId));

    // Resolve/Close → 100%. Reopen → back to 0%, but only if the 100% is ours to undo
    // (a value someone set by hand is left alone).
    let target = null;
    if (becomesDone && current < 100)                     target = 100;
    else if (!becomesDone && wasDone && current === 100)  target = 0;
    if (target === null) return null;

    return { percentageDone: target };
  }

  // ─── Pipeline ─────────────────────────────────────────────────────────────────

  /** { cancel: {status, statusText, json} } to answer without sending, else { body } to send. */
  // The checks share one read of the work package and run side by side; the
  // dialogs come one after the other, and Auto progress is only used once the
  // user has confirmed (or nothing was asked).
  async function prepare(wpId, body) {
    const payload  = JSON.parse(body);
    const wpReady  = wpAt(wpId, payload.lockVersion);
    wpReady.catch(() => {});   // each check handles a failed read itself
    const found    = confirmOn() ? bounded(openSubtasksIfResolving(wpId, payload, wpReady), CHECK_TIMEOUT_MS) : null;
    const fixed    = fixedOn() ? bounded(fixedVersionIfResolving(wpId, payload, wpReady), CHECK_TIMEOUT_MS) : null;
    const augmented = autoProgressOn() ? bounded(augmentBody(payload, wpReady), CHECK_TIMEOUT_MS) : null;
    const open = await found;
    if (open && !(await confirmResolve(wpId, open))) {
      const n = open.open.length;
      return { cancel: await cancelledResponse(wpId, `Status not changed: ${n} subtask${n === 1 ? ' is' : 's are'} still open.`) };
    }
    const extra = {};
    const info  = await fixed;
    if (info) {
      const answer = await askFixedVersion(wpId, info);
      if (answer.cancel) return { cancel: await cancelledResponse(wpId, `Status not changed: ${info.label} is not set.`) };
      if (answer.value) extra[FIXED_FIELD] = info.formattable ? { format: 'markdown', raw: answer.value } : answer.value;
    }
    Object.assign(extra, await augmented);
    return { body: Object.keys(extra).length ? JSON.stringify({ ...payload, ...extra }) : body };
  }

  // ─── XMLHttpRequest (Angular HttpClient) ──────────────────────────────────────

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  /** Completes an XHR with a local response, as if the server had sent it. */
  function respondXhr(xhr, { status, statusText, json }) {
    const text = JSON.stringify(json);
    const type = 'application/hal+json; charset=utf-8';
    const props = {
      readyState:  4,
      status,
      statusText,
      responseURL: new URL(xhr.__blmReq.url, location.href).href,
      responseText: text,
      response:    xhr.responseType === 'json' ? json : text,
    };
    for (const [k, value] of Object.entries(props)) Object.defineProperty(xhr, k, { value, configurable: true });
    xhr.getAllResponseHeaders = () => `content-type: ${type}\r\n`;
    xhr.getResponseHeader = (name) => String(name).toLowerCase() === 'content-type' ? type : null;
    for (const ev of ['readystatechange', 'load', 'loadend']) {
      xhr.dispatchEvent(ev === 'readystatechange' ? new Event(ev) : new ProgressEvent(ev));
    }
  }

  // ─── Short list cache ─────────────────────────────────────────────────────────
  // Going from a story back to the list makes the app refetch the same query and
  // show a spinner. Identical list/query GETs within LIST_TTL_MS are answered
  // locally instead. Any write to the API empties the cache, and a page reload
  // starts empty; changes made by other people show up after the TTL.

  const LIST_TTL_MS  = 15000;
  const LIST_MAX     = 20;
  const LIST_PATH_RE = /^\/api\/v3\/(projects\/[^/]+\/)?(work_packages|queries(\/[^/]+)?)\/?$/;
  const listCache    = new Map();   // path + query -> { at, text }
  let listGen        = 0;           // bumped by every write; a GET started before it is not stored
  const listCacheOn  = () => document.documentElement.dataset.blmListCache !== 'off';

  function listKey(req) {
    if (!listCacheOn() || !req?.async || req.method.toUpperCase() !== 'GET') return null;
    const u = new URL(req.url, location.href);
    return u.origin === location.origin && LIST_PATH_RE.test(u.pathname) ? u.pathname + u.search : null;
  }

  function listCached(key) {
    const hit = listCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at < LIST_TTL_MS) return hit.text;
    listCache.delete(key);
    return null;
  }

  function listStore(xhr, key, gen) {
    if (gen !== listGen || xhr.status !== 200) return;
    const type = xhr.responseType;
    if (type !== '' && type !== 'text' && type !== 'json') return;
    const text = type === 'json' ? JSON.stringify(xhr.response) : xhr.responseText;
    if (!text) return;
    listCache.delete(key);
    listCache.set(key, { at: Date.now(), text });
    if (listCache.size > LIST_MAX) listCache.delete(listCache.keys().next().value);
  }

  /** Any non-GET to the API may change what a list shows. */
  const isApiWrite = (method, url) => method.toUpperCase() !== 'GET' && String(url).startsWith('/api/v3/');

  function listClear() {
    listGen++;
    listCache.clear();
  }

  const isWpGet = (method, url) =>
    String(method).toUpperCase() === 'GET' && WP_PATH_RE.test(new URL(url, location.href).pathname);

  function xhrJson(xhr) {
    try {
      if (xhr.responseType === 'json') return xhr.response;
      if (xhr.responseType === '' || xhr.responseType === 'text') return JSON.parse(xhr.responseText);
    } catch { /* not JSON */ }
    return null;
  }

  // ─── Loading feedback ─────────────────────────────────────────────────────────
  // Opening the status menu or an inline field (assignee, priority, version…) first
  // loads the edit form and its allowed values, with nothing on screen meanwhile.
  // The clicked control shows a spinner while the API requests that started right
  // after the click (and the follow-ups they trigger) are in flight.

  const BUSY_TRIGGER  = 'wp-status-button button, .wp-status-button button, '
                      + 'button[class*="__hl_background_status"], .inline-edit--display-field';
  const BUSY_SHOW_MS  = 150;     // quicker loads never flash a spinner
  const BUSY_START_MS = 300;     // a click that starts no request by then needs none
  const BUSY_QUIET_MS = 250;     // idle this long after the last answer = loaded
  const BUSY_MAX_MS   = 15000;
  const BUSY_CSS = `
    .blm-busy { cursor:progress !important; }
    .blm-busy::after { content:""; display:inline-block; flex:none; width:.8em; height:.8em; margin-left:.45em;
      vertical-align:-.1em; border:2px solid currentColor; border-right-color:transparent; border-radius:50%;
      opacity:.75; animation:blm-busy-spin .7s linear infinite; }
    @keyframes blm-busy-spin { to { transform:rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .blm-busy::after { animation:none; border-right-color:currentColor; opacity:.4; } }`;

  let busy = null;   // { el, pending: Set, timers }

  function endBusy() {
    if (!busy) return;
    for (const t of Object.values(busy.timers)) clearTimeout(t);
    busy.el.classList.remove('blm-busy');
    busy.el.removeAttribute('aria-busy');
    busy = null;
  }

  function startBusy(el) {
    endBusy();
    if (!document.getElementById('blm-busy-css')) {
      const style = Object.assign(document.createElement('style'), { id: 'blm-busy-css', textContent: BUSY_CSS });
      document.head.appendChild(style);
    }
    const b = busy = { el, pending: new Set(), timers: {} };
    b.timers.show  = setTimeout(() => {
      if (b !== busy || !b.pending.size) return;
      el.classList.add('blm-busy');
      el.setAttribute('aria-busy', 'true');
    }, BUSY_SHOW_MS);
    b.timers.quiet = setTimeout(() => { if (b === busy && !b.pending.size) endBusy(); }, BUSY_START_MS);
    b.timers.max   = setTimeout(() => { if (b === busy) endBusy(); }, BUSY_MAX_MS);
  }

  /** Counts an API request toward the current click; returns its done callback, or null. */
  function trackBusy(url) {
    if (!busy) return null;
    const u = new URL(url, location.href);
    if (u.origin !== location.origin || !u.pathname.startsWith('/api/')) return null;
    const b = busy;
    const token = {};
    b.pending.add(token);
    clearTimeout(b.timers.quiet);
    return () => {
      b.pending.delete(token);
      if (b !== busy || b.pending.size) return;
      b.timers.quiet = setTimeout(() => { if (b === busy && !b.pending.size) endBusy(); }, BUSY_QUIET_MS);
    };
  }

  document.addEventListener('click', (e) => {
    const el = e.target instanceof Element && e.target.closest(BUSY_TRIGGER);
    if (el) startBusy(el);
  }, true);

  XMLHttpRequest.prototype.open = function (method, url, async = true, ...rest) {
    this.__blmReq = { method, url: String(url), async };
    return origOpen.call(this, method, url, async, ...rest);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const req     = this.__blmReq;
    if (req && isApiWrite(req.method, req.url)) {
      listClear();
      this.addEventListener('loadend', listClear);   // lists fetched mid-write predate it
    }
    const busyDone = req && trackBusy(req.url);
    if (busyDone) this.addEventListener('loadend', busyDone);
    const listHit = listKey(req);
    const cached  = listHit && listCached(listHit);
    if (cached) {
      setTimeout(() => respondXhr(this, { status: 200, statusText: 'OK', json: JSON.parse(cached) }), 0);
      return;
    }
    if (listHit) {
      const gen = listGen;
      this.addEventListener('load', () => listStore(this, listHit, gen));
    }
    const patchId = req && wpPatchId(req.method, req.url);
    if (patchId) {
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) notifyUpdated(patchId);
      });
    }
    // Forget first, then keep this answer: a PATCH returns the work package as saved.
    if (req && savesData(req.method, req.url)) this.addEventListener('loadend', forgetWps);
    if (patchId || (req && isWpGet(req.method, req.url))) {
      this.addEventListener('loadend', () => { if (this.status === 200) rememberWp(xhrJson(this)); });
    }

    const wpId = req?.async && wpIdIfCandidate(req.method, req.url, body);
    if (!wpId) return origSend.call(this, body);

    prepare(wpId, body)
      .catch(() => ({ body }))
      .then(r => r.cancel ? respondXhr(this, r.cancel) : origSend.call(this, r.body));
  };

  // ─── fetch ────────────────────────────────────────────────────────────────────

  window.fetch = function (input, init) {
    // Request objects carry a stream body we can't cheaply rewrite — pass through.
    if (input instanceof Request) return nativeFetch(input, init);
    const method  = init?.method ?? 'GET';
    const write   = isApiWrite(method, String(input));
    if (write) listClear();
    const patchId = wpPatchId(method, String(input));
    const wpId    = wpIdIfCandidate(method, String(input), init?.body);

    const sent = wpId
      ? prepare(wpId, init.body)
          .catch(() => ({ body: init.body }))
          .then(r => r.cancel
            ? new Response(JSON.stringify(r.cancel.json), {
                status:     r.cancel.status,
                statusText: r.cancel.statusText,
                headers: { 'Content-Type': 'application/hal+json; charset=utf-8' },
              })
            : nativeFetch(input, r.body === init.body ? init : { ...init, body: r.body }))
      : nativeFetch(input, init);
    const busyDone = trackBusy(String(input));
    if (busyDone) sent.then(busyDone, busyDone);
    if (write) sent.then(listClear, listClear);
    if (savesData(method, String(input))) sent.then(forgetWps, forgetWps);
    if (!patchId) return sent;
    return sent.then(res => {
      if (res.ok) {
        notifyUpdated(patchId);
        res.clone().json().then(rememberWp, () => {});
      }
      return res;
    });
  };

  // ─── Writes requested by jira-skin.js ─────────────────────────────────────────
  //
  // The Jira skin runs in the isolated world. It asks for its edits (a child's
  // status, assignee or parent) here, so they go through the hooked window.fetch above —
  // Confirm open subtasks, Auto progress and the wp-updated notice apply exactly
  // as for the app's own edits. Only that one shape of request is accepted.

  const WRITE_HREF = {
    status:   /^\/api\/v3\/statuses\/\d+$/,
    assignee: /^\/api\/v3\/(users|groups|placeholder_users)\/\d+$/,
    responsible: /^\/api\/v3\/(users|groups|placeholder_users)\/\d+$/,
    parent:   /^\/api\/v3\/work_packages\/\d+$/,    // Add existing child
  };

  // A child's write also bumps its parent's lockVersion (derived progress, dates).
  // OpenProject's own cache would keep the old one, and its next edit of either —
  // e.g. opening the story's status menu, which POSTs /form — fails with 409
  // "conflicting modifications" and silently does nothing. So both are reloaded
  // into the app's cache, the way OpenProject does after its own child edits.
  async function refreshAppCache(wpId, res) {
    try {
      const parentId = idFromHref((await res.json())._links?.parent?.href);
      const { apiV3Service } = (await window.OpenProject?.getPluginContext?.())?.services ?? {};
      if (!apiV3Service) return;
      for (const id of [wpId, parentId]) {
        if (id) apiV3Service.work_packages.id(String(id)).refresh().catch(() => {});
      }
    } catch { /* no plugin context: the app refreshes on the next page load */ }
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (d?.source !== 'blm-jira-skin' || d.type !== 'write-wp') return;
    const reply = (r) => window.postMessage(
      { source: 'blm-progress-hook', type: 'write-result', reqId: d.reqId, ...r }, location.origin);

    const isSubject = d.field === 'subject';
    const hrefOk = isSubject
      ? typeof d.value === 'string' && d.value.trim() !== '' && d.value.length <= 255
      : WRITE_HREF[d.field] && (
          (typeof d.href === 'string' && WRITE_HREF[d.field].test(d.href)) ||
          (d.href === null && (d.field === 'assignee' || d.field === 'responsible')));
    if (!/^\d+$/.test(String(d.id)) || !hrefOk) { reply({ ok: false, message: 'invalid request' }); return; }

    try {
      const current = await getJson(`/api/v3/work_packages/${d.id}`);
      rememberWp(current);   // the status checks below then reuse it
      const { lockVersion } = current;
      const headers = {
        Accept:             'application/hal+json',
        'Content-Type':     'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
      if (csrf) headers['X-CSRF-TOKEN'] = csrf;
      const res = await window.fetch(`/api/v3/work_packages/${d.id}`, {
        method: 'PATCH', credentials: 'include', headers,
        body: JSON.stringify(isSubject
          ? { lockVersion, subject: d.value.trim() }
          : { lockVersion, _links: { [d.field]: { href: d.href } } }),
      });
      let message = '';
      if (!res.ok) { try { message = (await res.json()).message ?? ''; } catch { /* not JSON */ } }
      else refreshAppCache(d.id, res.clone());
      reply({ ok: res.ok, status: res.status, message });
    } catch (err) {
      reply({ ok: false, message: err.message });
    }
  });
})();
