# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A plain-JavaScript Chrome MV3 extension (no bundler, no npm, no package.json) that snapshots OpenProject backlog data from a user-chosen OpenProject host and reskins that site. The host is entered on `pages/setup.html` (opened on install), stored as an origin in `chrome.storage.local.__blm_host` and read through `shared/config.js`; never hard-code a host. The repo root **is** the extension root. The user-global/parent Java "banking system" instructions (`cb`, checkstyle, Javadoc rules) do not apply here.

## Commands

There is no build or test suite. CI (`.gitea/workflows/ci.yml`) only does:

```bash
node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"   # manifest is valid JSON
git ls-files '*.js' | while read f; do node --check "$f"; done              # syntax check every JS file
node .gitea/scripts/check-manifest.js                                       # every manifest-referenced path exists
```

Run those before pushing. To try changes: `chrome://extensions` → Developer mode → **Load unpacked** on the repo root, then reload the extension.

Release: pushing any tag runs `.gitea/workflows/release.yml` (zips `manifest.json background content pages shared icons fonts`, verifies the zip against `git ls-files`, publishes a Gitea release). Bump `version` in `manifest.json` yourself.

## Architecture

- **`background/`** — ES-module service worker (`background.js` imports `../shared/api.js` and `./reminder.js`). Two alarms: hourly `syncTracked()` (today's snapshot for each tracked version) and midnight `reconstructMissingDays()` (replays activity feeds to backfill missed days). `reminder.js` handles the log-time deadline badge/notifications.
- **`shared/api.js`** — OpenProject REST client; authenticates with the browser's session cookies (`credentials: 'include'`), no API key. `me.js` caches the signed-in profile; `shell.js/css` is the dashboard side rail; `tokens.css` + `theme.js` are the design tokens and light/dark switch.
- **`pages/`** — extension pages. `dashboard.html` (Settings, also the `options_page`), `viewer` (Burndown, `viewer.js` is ~2900 lines with canvas charts), `timelog`, `planning` (sprint planning game: deals the chosen sprint version's open work packages level by level by label `customField6` and priority, the story detail panel reads description/subtasks/relations/attachments and writes status, assignee and new subtasks via `patchWorkPackage` / `createWorkPackage` in `shared/api.js`; Planned/Defer write nothing; session in `__blm_planning_session`), `popup`, `import`. Dashboard pages share the rail from `shared/shell.*`.
- **`content/`** — registered at runtime by `background.js` (`chrome.scripting.registerContentScripts`) for the configured host, since it isn't known at build time: `content.js` (reads live data on work-package pages), `jira-skin.js` (Jira-style reskin), `progress-hook.js` (runs in `world: "MAIN"` to hook page requests) with `progress-hook-relay.js` (isolated world) mirroring the toggles onto `<html data-blm-*>` attributes because MAIN-world scripts can't read `chrome.storage`. `content/ui2/` (UI 2.0 "liquid glass", behind `__blm_ui2`, mutually exclusive with the Jira skin; background.js flips the other switch off) is registered only on work-package routes and is plain CSS files scoped under `html.blm-ui2`; its dark mode uses its own `data-blm-ui2-theme` attribute because `jira-skin.js` deletes `data-blm-theme` when it switches off. `reminder-banner.js` runs on **all** http(s) sites and may only read extension storage.
- **State** lives in `chrome.storage.local` under `__blm_*` keys (`__blm_tracked`, `__blm_sync_meta`, `__blm_members__*`, `__blm_flow__*`, feature toggles such as `__blm_sync_burndown`, which defaults OFF). Member groups use `chrome.storage.sync`. Snapshot history cannot be rebuilt from OpenProject beyond activity replay, so treat storage keys/shape as a compatibility contract.
- **Theme**: the Dark/Light choice is stored in `localStorage` (`blm-theme`) for extension pages; `shared/theme.js` mirrors it to `chrome.storage.local.__blm_theme` so the `jira-skin.js` content script (which cannot read that localStorage) can apply the Catppuccin Mocha dark skin via `html[data-blm-theme]`. The skin only themes the backlog while Jira style is on.
- **`design.md`** is the locked design system (graphite + cobalt, Geist fonts, token names). Read it before touching any page. Canvas charts (`getChartColors()` in `viewer.js`) and `reminder-banner.js` can't read CSS variables and duplicate token values — keep them in step with `tokens.css`.

## Gotchas

- **Don't move the extension root or add a manifest `key`-less relocation**: the unpacked extension ID derives from the load folder path, so moving it wipes users' stored snapshots. `manifest.json` stays at the repo root.
- **Path resolution differs by context**: markup injected by `shell.js` resolves URLs against the host *page*, ES imports against the importing module, `chrome.runtime.getURL` and manifest paths against the extension root, CSS `url()` against the stylesheet. When moving files, check each class; `popup.html` `data-open="…"` values are coupled to selectors in `popup.js`.
- **New top-level folder** → add it to the zip list in `release.yml` by hand. `check-manifest.js` only checks manifest-referenced paths, not files reached via imports/HTML (all of `shared/`); the release workflow's `git ls-files` comparison covers that.
- `README.md`'s feature/layout tables are partly stale (they still list `viewer.html`, `timelog.html`, `import.html` at the root; they live in `pages/`).
- `.claude/agents/` holds a project-tuned agent team (po, ba, architect, developer, investigator, qa, tech-lead, security-reviewer, ui-reviewer); prefer those over generic ones.
