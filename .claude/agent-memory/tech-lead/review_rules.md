---
name: review-rules
description: Recurring review checks for this extension (write paths, display-only claims, rAF/MutationObserver render passes)
metadata:
  type: project
---

**Rule:** jira-skin's write scope is described in two places; any write feature added to it must update both.
**Evidence:** content/jira-skin.js:8-10 header, pages/dashboard.html:243 Jira style desc ("only things it writes") (review 2026-10-20).

**Rule:** jira-skin's window capture-phase pageTarget swallows clicks on OpenProject fields before validating the id: check that rows with no numeric id (inline-create "new", missing attribute) don't fall back to viewWpId() or get eaten silently.
**Evidence:** jira-skin.js pageTarget ~2345 (review 2026-10-20).

**Rule:** Writes from an isolated-world content script (content.js, jira-skin.js) bypass progress-hook.js (MAIN-world fetch/XHR hook), so they emit no `wp-updated` and leave Angular's cached lockVersion stale, so the user's next inline edit of that WP can hit 409.
**Evidence:** progress-hook.js:10-13 comment; content.js setProgressDone ~589.

**Rule:** In jira-skin's rAF passes (schedule() runs on every body mutation), a fetch that fails and deletes its cache entry gets retried on every DOM mutation with no backoff. Look for `.catch(() => cache.delete(...))`.
**Evidence:** jira-skin.js renderChildren (2026-10-02 review).

**Rule:** Extension pages that PATCH OpenProject need other actions blocked or scoped while a write is in flight; async completions must write to the state object captured at start (planning.js rt.sub is replaced on story change), and Undo must pop by id.
**Evidence:** planning.js commit()/undo() and createSubtask reviews 2026-10-05.

**Rule:** planning.js re-renders via innerHTML with single-letter shortcuts (P/D/S/V/U, Space): a control disabled while saving loses focus to body, so the next keystrokes trigger game actions; a `<select>` that writes on `change` fires on Windows arrow keys. Check both on any new write control.
**Evidence:** planning.js writeField/statusSelect/createSubtask review 2026-10-05.

**Rule:** planning.js commit-on-focusout fields (sub-subject, comment-edit) must ignore focus moving to sibling controls of the same form row, and must not refocus the field after a blur-triggered write (pulls focus back so shortcut keys get typed in and the next blur creates junk).
**Evidence:** planning.js focusout ~2826 + createSubtask finally ~736 (review 2026-10-15).

**Rule:** Async writes whose tray/state can be dismissed mid-flight (Esc, story switch) must toast on failure when their state object is no longer current; createSubtask does, cloneStory/createSuggested didn't.
**Evidence:** planning.js cloneStory ~1384, createSuggested ~763 (review 2026-10-15).

**Rule:** patchWorkPackage reads lockVersion then PATCHes; two writes to the same WP in flight (different fields) 409. Writes must be serialized per WP id, not per field.
**Evidence:** shared/api.js patchWorkPackage; planning.js rt.saving keyed `${wp}:${field}`.
