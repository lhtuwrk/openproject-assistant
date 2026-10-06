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
//
// Every successful work-package PATCH is also announced to content.js via
// window.postMessage, so it can refresh cached subtask stats (independent of the flags).
// It also sends jira-skin.js's status/assignee edits on its behalf (see the end).
//
// The on/off flags are relayed from chrome.storage by progress-hook-relay.js as
// <html data-blm-auto-progress="on|off" data-blm-confirm-subtasks="on|off">. Any
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

  const nativeFetch = window.fetch.bind(window);
  let statusNames = null;   // Promise<Map<id, name>>, loaded once per page
  const progressWritable = new Map();   // schema href -> Promise<boolean>, once per page

  const autoProgressOn = () => document.documentElement.dataset.blmAutoProgress !== 'off';
  const confirmOn      = () => document.documentElement.dataset.blmConfirmSubtasks !== 'off';

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
  function canWriteProgress(schemaHref) {
    if (!schemaHref) return Promise.resolve(false);
    if (!progressWritable.has(schemaHref)) {
      progressWritable.set(schemaHref, getJson(schemaHref)
        .then(schema => schema.percentageDone?.writable === true)
        .catch(err => { progressWritable.delete(schemaHref); throw err; }));
    }
    return progressWritable.get(schemaHref);
  }

  /** The work-package id if this is a PATCH to /api/v3/work_packages/<id>. */
  function wpPatchId(method, url) {
    if (String(method).toUpperCase() !== 'PATCH') return null;
    const m = WP_PATH_RE.exec(new URL(url, location.href).pathname);
    return m ? m[1] : null;
  }

  /** Cheap synchronous pre-filter so unrelated requests are never delayed. */
  function wpIdIfCandidate(method, url, body) {
    if (!(autoProgressOn() || confirmOn())) return null;
    if (typeof body !== 'string' || !body.includes('status')) return null;
    return wpPatchId(method, url);
  }

  function notifyUpdated(wpId) {
    window.postMessage({ source: 'blm-progress-hook', type: 'wp-updated', id: wpId }, location.origin);
  }

  // ─── Confirm resolving with open subtasks ─────────────────────────────────────

  /** { statusName, open: [{id, subject, status}] } when this PATCH resolves a WP with open subtasks. */
  async function openSubtasksIfResolving(wpId, body) {
    const statusId = idFromHref(JSON.parse(body)._links?.status?.href);
    if (!statusId) return null;
    const statusName = (await loadStatusNames()).get(statusId);
    if (!isDoneStatus(statusName)) return null;

    const filter = encodeURIComponent(JSON.stringify([{ parent: { operator: '=', values: [wpId] } }]));
    const data   = await getJson(`/api/v3/work_packages?filters=${filter}&pageSize=200`);
    const open   = (data._embedded?.elements ?? [])
      .map(k => ({ id: k.id, subject: k.subject ?? `#${k.id}`, status: k._links?.status?.title ?? '?' }))
      .filter(k => !SUBTASK_CLOSED.has(k.status.toLowerCase()));
    return open.length ? { statusName, open } : null;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g,
    (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));

  const DIALOG_CSS = `
    :host { all:initial; }
    .backdrop { position:fixed; inset:0; z-index:2147483647; background:rgba(15,23,42,.45);
      display:flex; align-items:center; justify-content:center; padding:16px;
      font:13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; color:#1f2328; }
    .dlg { background:#fff; border-radius:10px; box-shadow:0 12px 40px rgba(0,0,0,.25);
      width:min(460px, 100%); max-height:calc(100vh - 32px); display:flex; flex-direction:column; }
    .head { padding:16px 18px 6px; font-size:15px; font-weight:700; }
    .sub { padding:0 18px 10px; color:#57606a; }
    ul { list-style:none; margin:0; padding:0 18px; overflow:auto; }
    li { display:flex; align-items:center; gap:8px; padding:5px 0; }
    li + li { border-top:1px solid #f0f2f4; }
    .id { color:#57606a; font-weight:600; min-width:52px; font-variant-numeric:tabular-nums; }
    .st { font-size:10px; font-weight:700; padding:1px 6px; border-radius:3px;
      background:#eaeef2; color:#57606a; white-space:nowrap; }
    .subj { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .actions { display:flex; justify-content:flex-end; gap:8px; padding:14px 18px 16px; }
    button { font:inherit; font-weight:600; padding:6px 14px; border-radius:6px; cursor:pointer;
      border:1px solid #d0d7de; background:#f6f8fa; color:#1f2328; }
    button:hover { background:#eef1f4; }
    button.go { background:#1a67a3; border-color:#1a67a3; color:#fff; }
    button.go:hover { background:#155a8f; }
    button:focus-visible { outline:2px solid #1a67a3; outline-offset:2px; }
    /* Catppuccin Mocha, matching the backlog skin's dark mode */
    :host-context(html.blm-jira[data-blm-theme="dark"]) .backdrop { background:rgba(17,17,27,.65); color:#cdd6f4; }
    :host-context(html.blm-jira[data-blm-theme="dark"]) .dlg { background:#1e1e2e; border:1px solid rgba(205,214,244,.1); box-shadow:0 12px 40px rgba(0,0,0,.55); }
    :host-context(html.blm-jira[data-blm-theme="dark"]) .sub, :host-context(html.blm-jira[data-blm-theme="dark"]) .id { color:#a6adc8; }
    :host-context(html.blm-jira[data-blm-theme="dark"]) li + li { border-top-color:rgba(205,214,244,.1); }
    :host-context(html.blm-jira[data-blm-theme="dark"]) .st { background:rgba(205,214,244,.09); color:#bac2de; }
    :host-context(html.blm-jira[data-blm-theme="dark"]) button { background:rgba(205,214,244,.07); border-color:rgba(205,214,244,.14); color:#cdd6f4; }
    :host-context(html.blm-jira[data-blm-theme="dark"]) button:hover { background:rgba(205,214,244,.13); }
    :host-context(html.blm-jira[data-blm-theme="dark"]) button.go { background:#89b4fa; border-color:#89b4fa; color:#11111b; }
    :host-context(html.blm-jira[data-blm-theme="dark"]) button.go:hover { background:#b4befe; }
    :host-context(html.blm-jira[data-blm-theme="dark"]) button:focus-visible { outline-color:#89b4fa; }
  `;

  /** Resolves true to go ahead, false to cancel. Cancel is focused; Esc / backdrop cancel. */
  function confirmResolve(wpId, { statusName, open }) {
    return new Promise(resolve => {
      const host = document.createElement('div');
      const root = host.attachShadow({ mode: 'closed' });
      const n    = open.length;
      const rows = open.map(k => `
        <li><span class="id">#${k.id}</span><span class="st">${escapeHtml(k.status)}</span>
        <span class="subj" title="${escapeHtml(k.subject)}">${escapeHtml(k.subject)}</span></li>`).join('');
      root.innerHTML = `<style>${DIALOG_CSS}</style>
        <div class="backdrop">
          <div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="h">
            <div class="head" id="h">${escapeHtml(statusName)} #${wpId} with ${n} open subtask${n === 1 ? '' : 's'}?</div>
            <div class="sub">These subtasks are not resolved or closed yet:</div>
            <ul>${rows}</ul>
            <div class="actions">
              <button type="button" class="cancel">Cancel</button>
              <button type="button" class="go">${escapeHtml(statusName)} anyway</button>
            </div>
          </div>
        </div>`;

      const prevFocus = document.activeElement;
      const backdrop  = root.querySelector('.backdrop');
      const done = (ok) => {
        host.remove();
        prevFocus?.focus?.();
        resolve(ok);
      };
      root.querySelector('.cancel').addEventListener('click', () => done(false));
      root.querySelector('.go').addEventListener('click', () => done(true));
      backdrop.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) done(false);
      });
      // Keys stop at the dialog (after its buttons got them), so OpenProject's own
      // Esc/Enter handlers on the edit field never react while it is open.
      backdrop.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); done(false); }
      });
      document.body.appendChild(host);
      root.querySelector('.cancel').focus();
    });
  }

  /**
   * The answer to a cancelled PATCH, never sent to the server: the work package as it
   * is now, with 200 — the app takes it as a save, closes the editor and shows the old
   * status again. Its "Successful update" toast is hidden. If the current state can't
   * be read, falls back to a 422 on `status` (editor stays open, error toast shown).
   */
  async function cancelledResponse(wpId, n) {
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
          message: `Status not changed: ${n} subtask${n === 1 ? ' is' : 's are'} still open.`,
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

  /** Returns the augmented body, or null to send the original one. */
  async function augmentBody(wpId, body) {
    const payload = JSON.parse(body);
    if ('percentageDone' in payload) return null;

    const statusId = idFromHref(payload._links?.status?.href);
    if (!statusId) return null;

    const names    = await loadStatusNames();
    const wp       = await getJson(`/api/v3/work_packages/${wpId}`);
    const typeHref = payload._links?.type?.href;
    const typeName = typeHref ? (await getJson(typeHref)).name : wp._links?.type?.title;
    if (!AUTO_TYPES.has(String(typeName).toLowerCase())) return null;
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

    return JSON.stringify({ ...payload, percentageDone: target });
  }

  // ─── Pipeline ─────────────────────────────────────────────────────────────────

  /** { cancel: {status, statusText, json} } to answer without sending, else { body } to send. */
  async function prepare(wpId, body) {
    if (confirmOn()) {
      const found = await bounded(openSubtasksIfResolving(wpId, body), CHECK_TIMEOUT_MS);
      if (found && !(await confirmResolve(wpId, found))) {
        return { cancel: await cancelledResponse(wpId, found.open.length) };
      }
    }
    if (autoProgressOn()) {
      const augmented = await bounded(augmentBody(wpId, body), CHECK_TIMEOUT_MS);
      if (augmented) return { body: augmented };
    }
    return { body };
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
    if (write) sent.then(listClear, listClear);
    if (!patchId) return sent;
    return sent.then(res => {
      if (res.ok) notifyUpdated(patchId);
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
    parent:   /^\/api\/v3\/work_packages\/\d+$/,    // Add existing child
  };

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (d?.source !== 'blm-jira-skin' || d.type !== 'write-wp') return;
    const reply = (r) => window.postMessage(
      { source: 'blm-progress-hook', type: 'write-result', reqId: d.reqId, ...r }, location.origin);

    const hrefOk = WRITE_HREF[d.field] && (
      (typeof d.href === 'string' && WRITE_HREF[d.field].test(d.href)) ||
      (d.href === null && d.field === 'assignee'));
    if (!/^\d+$/.test(String(d.id)) || !hrefOk) { reply({ ok: false, message: 'invalid request' }); return; }

    try {
      const { lockVersion } = await getJson(`/api/v3/work_packages/${d.id}`);
      const headers = {
        Accept:             'application/hal+json',
        'Content-Type':     'application/json',
        'X-Requested-With': 'XMLHttpRequest',
      };
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content;
      if (csrf) headers['X-CSRF-TOKEN'] = csrf;
      const res = await window.fetch(`/api/v3/work_packages/${d.id}`, {
        method: 'PATCH', credentials: 'include', headers,
        body: JSON.stringify({ lockVersion, _links: { [d.field]: { href: d.href } } }),
      });
      let message = '';
      if (!res.ok) { try { message = (await res.json()).message ?? ''; } catch { /* not JSON */ } }
      reply({ ok: res.ok, status: res.status, message });
    } catch (err) {
      reply({ ok: false, message: err.message });
    }
  });
})();
