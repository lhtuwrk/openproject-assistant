---
name: extension-page-html-sinks
description: How extension pages (planning.js) render OpenProject rich HTML and cookie-carrying images; what MV3 CSP does and does not cover
metadata:
  type: project
---

**Rule:** No manifest `content_security_policy`, so extension pages run under MV3 default CSP (script-src 'self'; no img-src limit). Inline handlers / javascript: can't run script, so for HTML sinks the residual risk is markup (meta refresh, form, base, external img beacons), not script. planning.js `safeHtml` = DOMParser + strip list then string re-parse via innerHTML; weak spot is parse/re-parse differences (noscript is not stripped; DOMParser parses it with scripting off, live innerHTML with scripting on). Upstream bound: description.html is already sanitized by OpenProject server-side.
**Evidence:** pages/planning.js safeHtml (~line 161), review 2026-10-05.

**Rule:** `fetchBacklogBlob` (shared/api.js) pins credentialed GETs to `${BASE}/` prefix; relative paths are prefixed by BASE so `//host` stays on backlog. Keep that prefix check if it is refactored. Blob URLs are only assigned to img.src.
**Evidence:** shared/api.js fetchBacklogBlob, review 2026-10-05. See [[trust-model-openproject-origin]], [[write-path-guards]].
