---
name: review-rules
description: Recurring review checks for this extension (write paths, display-only claims, rAF/MutationObserver render passes)
metadata:
  type: project
---

**Rule:** jira-skin is advertised as "Display only" in two places; any write feature added to it must update both.
**Evidence:** content/jira-skin.js:8-9 header, pages/dashboard.html:175 Settings desc (child-assignee review 2026-10-02).

**Rule:** Writes from an isolated-world content script (content.js, jira-skin.js) bypass progress-hook.js (MAIN-world fetch/XHR hook), so they emit no `wp-updated` and leave Angular's cached lockVersion stale, so the user's next inline edit of that WP can hit 409.
**Evidence:** progress-hook.js:10-13 comment; content.js setProgressDone ~589.

**Rule:** In jira-skin's rAF passes (schedule() runs on every body mutation), a fetch that fails and deletes its cache entry gets retried on every DOM mutation with no backoff. Look for `.catch(() => cache.delete(...))`.
**Evidence:** jira-skin.js renderChildren (2026-10-02 review).

**Rule:** Extension pages that PATCH OpenProject need other actions blocked or scoped while a write is in flight; async completions must write to the state object captured at start (planning.js rt.sub is replaced on story change), and Undo must pop by id.
**Evidence:** planning.js commit()/undo() and createSubtask reviews 2026-10-05.

**Rule:** planning.js re-renders via innerHTML with single-letter shortcuts (P/D/S/V/U, Space): a control disabled while saving loses focus to body, so the next keystrokes trigger game actions; a `<select>` that writes on `change` fires on Windows arrow keys. Check both on any new write control.
**Evidence:** planning.js writeField/statusSelect/createSubtask review 2026-10-05.

**Rule:** jira-skin.js and content/ui2/ui2.js both tag the same nodes (td.status leaf, status button) and both skip when `data-blm-tone` already matches, so if both run, whichever is first suppresses the other's class. Check any change that lets both tag passes run at once.
**Evidence:** jira-skin.js tagCells ~137 vs ui2.js tagCells; commit 15ea3af review 2026-10-06.

**Rule:** patchWorkPackage reads lockVersion then PATCHes; two writes to the same WP in flight (different fields) 409. Writes must be serialized per WP id, not per field.
**Evidence:** shared/api.js patchWorkPackage; planning.js rt.saving keyed `${wp}:${field}`.
