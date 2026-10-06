---
name: trust-model-openproject-origin
description: Threat model for content scripts on the configured OpenProject host - page scripts already hold the session, so page-forged messages/events are not escalation
metadata:
  type: project
---

**Rule:** jira-skin.js, content.js and progress-hook*.js run only on the configured OpenProject origin (`__blm_host`, registered at runtime by background.js `registerHostScripts`), and their API_BASE is `location.origin`, so their fetches carry no power beyond what any OpenProject page script already has. Forged `blm-progress-hook` postMessages or synthetic click events from page script are not privilege escalation; the attacker that matters is another OpenProject user whose API strings (subject, names, status titles, error messages) reach our DOM.
**Evidence:** background.js `registerHostScripts` matches; jira-skin.js `API_BASE`; review of child-assignee picker 2026-10-02.

**How to apply:** check API strings reach DOM via textContent/attributes only; check writes are limited to ids the extension itself fetched (jira-skin.js `assignKid` returns unless kidId is in `childCache`). Escalate if a script is ever matched on another origin or a page-derived value is fed into chrome.* or extension storage. See [[write-path-guards]].
