# Handoff — UI 2.0 (liquid glass) work-packages skin

- **Story**: none (no OpenProject ticket)
- **Plan**: approved plan at `C:\Users\nvtthien\.claude\plans\the-current-workpackages-ui-breezy-sutherland.md` (outside the repo; summarised below)
- **Branch**: `main` (fast-forwarded and pushed; local branch `ui2-liquid-glass` is an identical leftover)
- **Updated**: 2026-10-06
- **State**: shipped to `main` as commit `8a7b94f` (v1.6.0, no tag), but the user is **not satisfied with the look**. Never seen on a live OpenProject; all CSS was written blind.

## Goal
The old work-packages UI (Jira skin, `content/jira-skin.js`) is not modern or minimal. Build "UI 2.0": a liquid-glass, minimal skin behind its own feature switch, for the **WP list + split view + full-page work package** only (not Backlogs, boards, Gantt).

## Current Progress
All committed and pushed; tree clean. Phases 1-5 of the plan are done:
- `design.md`: new section "Injected skin 2.0 (liquid glass)" (glass only on chrome/floating panels, never rows; chips; fallbacks).
- `pages/dashboard.html`: switch "UI 2.0 (glass)", key `__blm_ui2`, default off.
- `background/background.js` (`registerHostScripts`, ~line 571): registers `blm-host-ui2` on `${host}/work_packages*` and `${host}/projects/*/work_packages*` with css `tokens/base/list/detail.css` + `ui2.js`. Same file's `storage.onChanged` makes UI 2.0 and Jira style mutually exclusive (turning one on flips the other off; turning UI 2.0 off does NOT restore Jira style).
- `content/ui2/ui2.js`: toggles `html.blm-ui2` / `html.blm-ui2-wp`, sets `data-blm-ui2-theme` (own attribute, because `jira-skin.js:3554` deletes `data-blm-theme` when it switches off), tags `td.status` text leaves `.blm-g-chip` and status buttons `.blm-g-status` via a MutationObserver + rAF (tone guessed from English status names).
- `content/ui2/tokens.css` (`--g-*` tokens, light/dark, opaque fallbacks for `prefers-reduced-transparency` / no `backdrop-filter`), `base.css` (canvas gradient, glass top bar + sidebar, dark repaint of white surfaces), `list.css` (toolbar pills, table card, 44px rows, chips), `detail.css` (glass split/full panels, pill tabs, attribute cards; maps `--jx-*` tokens for the independent sub-features `blm-assign`/`blm-activity`/`blm-files` onto `--g-*`).
- README layout table, CLAUDE.md architecture note, `manifest.json` version 1.6.0.
- Checks run: manifest JSON parses, `node --check` on all JS passes. `.gitea/` (CI, `check-manifest.js`, `release.yml`) is **not in this checkout** although CLAUDE.md describes it; remote is `github.com/lhtuwrk/openproject-assistant`.

## What Worked
- Additive skin instead of rewriting the 3644-line `jira-skin.js`: zero risk to the old skin, instant rollback by the switch.
- Reusing the selectors and the dark "surfaces that hard-code white" list from `jira-skin.js` (CSS at ~320-760 and DARK block ~2905-3135); those are known to match OpenProject's DOM.
- Giving UI 2.0 its own theme attribute (see above).

## What Didn't Work
- **Nothing was ever visually verified.** No access to the user's OpenProject host, so every rule is unverified; the user's dissatisfaction is the first real feedback and its specifics were not captured (ask them what is wrong, ideally with screenshots).
- Custom type/priority icons: dropped. `jira-skin.js` tagging is inside an IIFE and can't be shared without refactoring, so UI 2.0 keeps OpenProject's native icons.
- Rebuilding the full-page layout (Jira moves nodes into `aside.blm-jx-side` via `arrangeFullView`): deliberately not copied (fragile with Angular). UI 2.0 keeps the native layout and only restyles surfaces, so the page may look barely changed structurally.
- No "Child work items" section: that is part of the Jira skin, absent under UI 2.0 (children only in the Relations tab).
- Glass is barely perceptible: the table is a solid card and only the top bar/sidebar/detail panels blur, over a mild gradient canvas. This may be a main reason the result feels underwhelming.
- Header/sidebar glass only applies on work-package routes (script is registered only there).

## Next Steps
1. Ask the user concretely what they dislike (look, density, glass strength, layout, bugs); get screenshots of list, split view and full page in light and dark.
2. Load the unpacked extension (`chrome://extensions` → reload), enable Settings → UI 2.0, and inspect the real DOM in DevTools; fix selectors/white patches (filter bar, pagination, quote bar, modals, ng-select) in `content/ui2/*.css`.
3. Decide design changes in `design.md` first (it is the locked system), e.g. stronger glass, different layout for the full page, custom type/priority icons, a children section.
4. If the direction changes a lot, consider reverting: `git revert 8a7b94f` removes the whole feature cleanly (the old skin is untouched). If keeping it, leave the switch default off until approved.
5. Re-run checks: `node -e "JSON.parse(require('fs').readFileSync('manifest.json','utf8'))"` and `node --check` on each JS file. Don't tag/release until the user approves the look.

## Open Questions
- What exactly is unsatisfying (look, glass effect, layout, specific broken areas)?
- Should turning UI 2.0 off restore Jira style (currently both end up off)?
- Geist font vs system stack (currently system stack)?
- Should UI 2.0 get a Child work items section and custom icons, or stay CSS-only?
- Is `.gitea/` meant to exist in this repo (CLAUDE.md says yes)?
