---
name: write-path-guards
description: Convention for OpenProject PATCH writes from content scripts (CSRF meta, lockVersion, id allow-list)
metadata:
  type: project
---

**Rule:** OpenProject writes re-read lockVersion, send X-Requested-With + X-CSRF-TOKEN from `meta[name="csrf-token"]`, credentials 'include', to the hard-coded same-origin API_BASE. Ids used in write URLs must come from an API response the script fetched, not from DOM/data attributes alone; data-kid ids are not regex-validated (defense-in-depth gap, not exploitable while the childCache check holds).
Extension pages write via shared/api.js `patchWorkPackage` (X-Requested-With only, no CSRF meta available; hrefs/ids taken from fetched API lists, select values resolved against rt.projects/rt.versions). Session state in `__blm_planning_session` is extension-owned, so stored hrefs replayed by undo are trusted.
**Evidence:** content.js:601 setProgressDone; jira-skin.js patchAssignee/assignKid (child-assignee picker, 2026-10-02).
