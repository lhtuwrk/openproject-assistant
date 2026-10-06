---
name: release-zip-drift
description: release.yml zips top-level folders and checks only manifest-referenced paths; adding a new top-level folder or relying on non-manifest files can still drift
metadata:
  type: project
---

**Rule:** release.yml zips `manifest.json background content pages shared icons fonts` (folder list, since the 2026-10-01 reorg); a new top-level folder must be added there by hand. `.gitea/scripts/check-manifest.js` only checks manifest-referenced paths, so files reached only through ES imports / HTML src/href (all of `shared/`) are NOT verified in the zip.
**Evidence:** Simulation 2026-10-01: zip without `shared/` passed check-manifest (14 refs) though background.js imports ../shared/api.js.
**How to apply:** On any diff adding a folder or touching release.yml, check the zip list and whether the post-zip check covers tracked files (e.g. diff against `git ls-files`).
