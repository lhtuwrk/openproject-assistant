---
name: path-resolution-traps
description: Path strings in this extension that resolve against something other than the file containing them (shell.js markup, popup data-open, getURL)
metadata:
  type: project
---

**Rule:** URLs inside markup injected by shell.js resolve against the host page's URL, not shell.js; ES import specifiers resolve against the importing module; `chrome.runtime.getURL(...)` and manifest paths are extension-root-relative; CSS `url()` resolves against the stylesheet.
**Evidence:** shell.js:19-21,45-46 (nav hrefs + `icons/icon-32.png`), popup.html `data-open` -> popup.js:24 getURL(page) and popup.js:90 selector on the literal `data-open="viewer.html"`, reminder.js:155/178, viewer.js:2841, tokens.css:11-36.
**How to apply:** Any move of pages/shared files: check each class separately; grep for `.html'` alone misses the selector coupling.

**Rule:** manifest.json has no `key`, so the unpacked extension ID is derived from the load folder path; changing the folder users select loses chrome.storage (daily snapshot history, which OpenProject cannot rebuild beyond activity replay).
**Evidence:** manifest.json (no "key"); README "Installing" step 3.
