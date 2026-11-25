# Design — Backlog Monitor

The locked design system for every extension page (popup, Settings, Burndown,
Time log). Read this before changing any page. Extend this file when the system
needs to grow; don't override it on one page.

## Genre
modern-minimal: a quiet internal tool. Function carries the page.

## Macrostructure family
- App pages (Settings, Burndown, Time log, Planning): **Workbench**. A fixed left rail
  (`shell.css` / `shell.js`) holds the brand, the profile card, the nav and the
  rail foot. Each page has a page bar with an `h1.page-title`, then its own
  filters and actions.
- Popup: a short companion column of cards (account, task, My time, Burndown)
  above a nav to the dashboard pages (Burndown, Time log). Its settings button
  opens Quick settings as a 380 px drawer on the right of the page
  (`content/quick-settings-host.js`, Chrome's side panel as fallback): one compact
  column of the Settings switches (read from dashboard.html) and the theme.

## Theme
**Graphite and cobalt**: neutral greys and one cobalt signal, in dark and light
modes chosen in Settings (`theme.js`). All values live in `tokens.css`; pages
reference tokens by name. Canvas charts (`getChartColors()` in `viewer.js`) and
the floating reminder card (`reminder-banner.js`, which runs on other websites)
can't read CSS variables, so they repeat these values. Keep them in step.
- Paper `--bg` #111214 / #f7f7f8, panels `--surface` / `--surface2`, controls `--overlay`
- Ink `--text` / `--text2`, quiet `--muted` / `--subtle`
- Rules `--border` / `--border2`
- Accent `--accent` #4c7dff / #2f5fe0: nav, focus, the current-page mark, meters,
  and the single primary action per view (`--accent2` is the same cobalt)
- Signals `--red` (missing), `--warn` (under target), `--green*` (synced or met)

## Typography
- Body and display: Geist 400–650, bundled in `fonts/` (Latin, Latin-ext and
  Vietnamese subsets, so member names render correctly offline).
- Numbers, dates, logins: Geist Mono with tabular figures (`.num`, `--font-mono`).
- Scale: `--text-2xs` 10 → `--text-2xl` 22 px. Page titles 18–22 px, weight 650,
  tracking −0.02em. Headings are never italic.

## Spacing
4-pt named scale (`--space-3xs` 2 px → `--space-2xl` 48 px).

## Motion
- Easings: `--ease-out`, `--ease-in`, `--ease-in-out`; durations `--dur-short` 140 ms
  and `--dur-med` 220 ms.
- Only colour, background and transform change. No reveals.
- `prefers-reduced-motion`: transitions drop to 0.

## Microinteractions stance
- Settings save on change. No Save button, no "Saved!" toast (silent success).
- Switches are real checkboxes (`.switch`); the theme picker is a radio group.
- Focus rings: 2 px `--focus`, shown at once, never animated.

## CTA voice
- Primary (one per view): `--accent2` fill, 6 px radius, 28–30 px tall.
- Secondary: `--surface` / `--surface2` fill, `--border2` outline, same size.
- Text links: `--accent`, weight 600, ending in → for in-app or ↗ for external.

## What pages MUST share
The rail, the tokens, Geist + Geist Mono, the button sizes and radii, and the
page-bar pattern.

## What pages MAY differ on
Their filters, data views (charts, ledger grid) and page-specific signal tokens
(`--miss`, `--wk-bg` in Time log; `--lvl-goal` · `--lvl-big3` · `--lvl-break` ·
`--lvl-fire` · `--lvl-high` in Planning, all aliases of palette tokens).

## Burndown
The same layout on the page and in the drawer opened from "Show burndown chart"
(1100 px), whose page bar keeps only the dates, Sync Now, Copy Charts and ×.
- Page bar: a sprint stepper (‹ 26.10.B · 10-09 → 10-22 ›; its menu ends with "Custom
  range…", which shows the two date inputs), the project, a Main view switch, then
  Versions, Sync Now, the primary Copy Charts and ⋯ More. A sprint runs from its
  planning Friday to the version's last working day (Thursday).
- Version header: name in cobalt, a sync chip (green "synced 14:05", amber "not synced
  today"), Copy chart and Delete all as quiet outline buttons.
- Pace strip: three tiles in Geist Mono (Remaining, Burned today, Days left).
- Toolbar: Done and Days menus (the summary shows the choice in cobalt; Done holds the
  status checkboxes, Days holds "Hide first day" (the version's own first day, offered only when it is in the
  range; on by default and remembered), and the weekend days), and the
  legend on the right; its Done chip toggles the Done line.
- Chart: full width. Each date is the start of that day; the segment to the next date
  is that day's work; a closing tick follows the last day. Today is a dashed segment to a
  hollow "now" point. The Ideal line runs from what was left at the start of the work (the
  first point, or the one after the planning day when that day is shown) to 0 at the closing
  tick. Scope and ⇄ pills sit under the middle of their segment. Hovering
  lights the day's band; the selected day keeps an --accent-bg band.
- Day strip: one cell per day under its segment (weekday, burned in green, scope change
  on the right, days to come dashed). Clicking a cell or band opens the day detail.
- Day detail: full width under the chart, never beside it (the chart keeps its width):
  one story per row so titles show in full; day label, Burned · Scope · Status moves tabs, ‹ ›, ↻ Refresh, Collapse. ← → walk the
  days while the chart has focus; Escape stays with the drawer.
- Snapshot table, CFD and Flow are disclosure rows under the chart.
- Versions is a 420 px side sheet over a scrim (Escape or the scrim closes it): Tracking
  (the current sprint marked "always shown", others with ×), Add a version (search,
  project chips, Show closed, + Track per row), Work package filter, Days. Changes save
  at once, like Settings.

## Time log: logging time
The ledger is also where you log your own time. Your row's cells are buttons (a
dash turns cobalt on hover); the single primary action in the page bar, Log time,
covers days you can't click. Both open one panel docked to the right edge (the grid is pushed aside and stays
clickable, so more days can be picked with cells while it is open): Date,
Work package (search; Recent and Assigned to me when empty), Hours (1.5 · 1h30 ·
90m), Activity, Comment. It opens with the work package list showing (the last
one used leads Recent) and the hours left of the 8 h day filled in. Nothing is
chosen for the user: a ticket is only set by a click or by arrow keys plus Enter,
so a hurried Enter can't log on the wrong ticket. No confirm dialog:
the grid updates and a toast offers Undo. Existing entries of the day are listed in
a left column of the popover (Edit changes an entry's hours or moves it to another
day, Delete asks once, inline); the right column adds time. Without entries the
popover is one column. The chosen work package shows as a chip with Change, so the
search list reopens with Change; a meter shows the day against 8 h and
quick-hour buttons (Rest, 0.5, 1, 2, 4) sit under Hours. A Days row of chips (one
per day you can log on; amber = under 8 h) turns the form into a range form when
more than one is on; All missing ticks every day under 8 h. Shift+click a second
cell does the same from the grid. Only your own row is writable.

Several tickets in one go: Add another ticket (Shift+Enter) puts the ticket and its hours on a
To log list and opens a fresh form; Enter then logs the whole list, on every selected day.
The save button counts them (Log 3 tickets), one toast and one Undo cover all entries, and
a failed run keeps the panel open and skips what was already created when you retry.
Several tickets can also be ticked in the picker (a box before each row) and added to the list
together; "+ Add another ticket" sits under Hours so it is not missed.
Smart log time is a hidden, experimental feature: tapping your avatar in the rail seven
times (like Android's developer mode) reveals Settings → Experimental, whose switch turns
it on. Off, tickets are logged with the hours typed for each. On, with two or more tickets
the hours of each selected day are topped up to 8 h and shared between them in
proportion to story points, within the time left on each story, in quarter-hours; the
Hours per day table shows what every ticket gets on every day (and its Day total row is
editable), and the picker gets tick boxes to add several tickets together.
Work packages in the picker read like Jira work items: a type icon (bug red, story green,
task cobalt, other amber), the key, the title, an upper-case status lozenge (grey to do,
cobalt in progress, green done) and the assignee's avatar (ringed when it is you, dashed
when unassigned), with project · sprint underneath.

## Planning (sprint planning game)
One facilitator shares the page; the team plays the backlog level by level in
priority order (label goal → pilot/chiron/VAB → coffee break → Immediate → High →
side quests: every other story, by priority). The play order is the facilitator's
to change in the lobby (drag a level, or ↑ ↓); which level a card belongs to
stays fixed by that precedence.
Playful inside the quiet system: the fun is in the copy (level names, "Boss
defeated", loot, badges computed from real numbers), the pacing (a countdown per
level, a time bank) and the numbers, never in extra colour or motion. Each level
has one signal colour, used only for its mark, the card's top rule and the meter.
The story on the table is the focus: levels and a compact level clock share one
strip on top; below, the story takes the wide column (id, type, points, tags,
title, then the Description · Subtasks · Relations · Attachments · Comments tabs at full
length) and a sticky 320 px side column holds the story's own clock, Planned /
Defer, Prev / Next, Status · Assignee · Author · Updated, the planned tally and
what's up next. Under 1100 px the side column moves above the story. The
story's own clock is the side column's headline: elapsed in 40 px Geist Mono over
its share, with a meter that turns red past it.
The lobby also sets the planning window (Starts / Ends, a time field each; stories
are scaled down to fit it) and lets the facilitator split the quest: "+ Add break" (or right-click a level)
inserts a named break of any length, and × removes it. A long level can be cut from the inside: Split on its row asks how many
stories stay in the first part, then makes two parts ("High voltage 1/2", "2/2") with a
break between them; the first part's story count stays editable, Merge joins a part back, and each part has its own clock and time range. Every level row, and each level in the arena's strip, shows its minutes
and when it runs (from the start time, summing the sections before it).
The wrap-up (after End game) reads like a report with one way out: a headline
that says where the sprint stands ("Nothing decided yet" / "3 of 14 decided" /
"… is planned"), one planned · deferred · not-planned bar, a row per level, and
a Next panel (Copy summary, Review all stories, Back to the arena) ending in
"Start a new planning…", which asks once, inline, only when decisions would be
lost.
A level's minutes can also be set by hand in the lobby (its minutes field turns cobalt, ↺ returns it
to automatic): that level keeps them, the others share what is left of the window, and each
story's clock in it is its share of those minutes.
Time follows the stories: each story gets minutes by its priority (set in the
lobby), a level's timebox is the sum over its stories, and when the sprint
doesn't fit the session every story is scaled down by the same share. The
current story's own clock sits under its title.
The card has ← Previous and Next → around Planned / Defer (also ← → or B / N,
S for Next): the table walks the level in its fixed order, Next leaves a story
unplanned, Previous goes back to any story, decided ones included (shown with
their Planned / Deferred mark and Mark not planned). Planned / Defer / Undo
answer to P / D / U; V opens View all,
Space pauses. Only the sprint being planned is chosen; its open stories are the
deck (a subtask of a story in the same sprint comes with its story). Planned and
Defer are the game's own bookkeeping and write nothing, with one exception: Defer's tray has a searchable "Move to" version picker, and a story deferred with a version chosen is moved there (with its open subtasks of this sprint); Undo or Mark not planned moves them back. Under the card, the
story's detail panel (Status · Assignee · Author · Updated, then Description ·
Subtasks · Relations · Attachments · Comments tabs) is where the team reads and edits the
story: status, assignee, new subtasks (type · subject · assignee, created in the
sprint) and subtask status/assignee are written to OpenProject at once with no
confirm dialog. The description is OpenProject's HTML, sanitized; images and
attachment thumbnails are fetched with the session cookie. View all lists every
story by level with a Planned / Deferred / On the table / Not planned chip and
opens the same detail panel beside the list.
A work package reference (#12345, or a link to one) in a description or a comment shows as a chip: a
type icon (bug red, story green, task cobalt, other amber), the id and the title, in Planning and, with
the Jira skin, on the backlog's own work package page (shared/wp-chips.js).
The Comments tab lists a story's comments newest first and posts a new one (Ctrl+Enter); typing @ opens the same
people list as the assignee picker (picture, name, search by typing on), and a chosen name is sent as an
OpenProject mention so that person is notified.

### Claude on Planning (Experimental)
A "Claude" strip above a story's tabs, behind `__blm_claude_ai`, asks the local claude-bridge to
summarize the requirement with rocket:story-summary's reading rules (a "Requirement summary"
heading with a size chip and an EN | VI switch (English first), then one goal sentence, 3–6 short bullets and up
to 3 blocking questions; Copy and Post write both languages), suggest subtasks (they land in Suggested subtasks) or design the main test cases with
rocket:design-test-case: a "QA notes" heading over one bullet per case (ID, one-line title,
priority chip; no steps), open questions folded below, Copy · Post as comment (posted as
`## QA notes` and a bullet list). It is the one
deliberate exception to "no extra motion": only while Claude works, the strip's rim turns
(conic gradient), an orb breathes, the phase line shimmers and the stage list advances; results
arrive row by row. The strip's Chat opens a streamed conversation about the story (user bubbles in `--accent2`, Claude's
on `--surface2`; the reply being written gets the gradient rim, a blinking caret and bouncing dots
before its first word; Enter sends, ■ Stop aborts). The model picker (Settings, and the chat head)
sets one model for every ask, Sonnet 5 by default. The extra hues are shared tokens `--ai-1..3` (cobalt mixed with violet and
teal), `--ai-glow` and `--claude` (its fixed brand orange, in `tokens.css`). Under `prefers-reduced-motion` all of it stops; the phase text and stages
still change. The stages are timed, not real progress.

**The AI mark** (`shared/claude-icon.js`, motion in `shared/ai-mark.css`): OpenProject's one-line
o·p mark in `--op-blue` (#1a67a3 light, #4a95d6 dark) with Claude's four-point spark in `--claude`
in its empty top-left corner. A `data-mark` attribute on an ancestor sets its motion by task —
`idle` (spark twinkles, one bead strolls the line), `thinking` (two beads chase round the line,
spark spins), `writing` (light runs down the line, spark beats), `drafting` (the line redraws),
`applying` (the line pulses, a bead rushes through), `done` (line drawn once, spark bursts, plays
once), `error`/`offline` (greyed; error shakes once); without it the mark is still. Past chat
replies stay still. Reduced motion stops all of it.

The same switch also shows a floating round button (bottom-right, `--claude` fill, the AI mark in white with an orange bead,
turning into × while open) on the backlog's work-package list and detail pages, behind
`content/assistant-fab.js`. It opens a small chat popup (`pages/assistant.html`, same bubble/caret
look as the strip's Chat, no skill picker) anchored above the button — a card, not the full-height
drawer the Burndown button and quick settings use, so the backlog page stays visible and usable
behind it (Escape closes it; a stray click on the page does not). Its system prompt is whatever the
user is looking at — the open story's description, subtasks and comments, or, on a list with a
saved view, its actual rows (id, type, subject, status, priority, assignee, points; capped at 60,
the rest only counted) — and follows along live as they navigate the SPA, without reopening the popup.

The popup opens 460 × 640 px (capped to the window) and resizes from a grip in its top-left corner
(it is anchored bottom-right); the size is kept in `__blm_assistant_size`, and a double-click on the
grip resets it. Beyond the screen it also reads, through `shared/assistant-context.js`: the sprint's
day-by-day burndown from this extension's own snapshots (only for tracked sprints; on a list, the
sprint most rows belong to), and on a story its parent, relations and attachments, with the text of
up to three small text files. The starter questions follow the screen (story vs list).

Replies render a small markdown subset (paragraphs, `-`/`1.` lists, `**bold**`, `code`, fenced
code, http(s) links), escaped first. The conversation lives only in the open popup; nothing is
stored. The button turns grey (`#6b6f78`) with a
tooltip while the bridge doesn't answer, and text selected on the page when it is pressed is
quoted into the input.

Writes stay with the user: Claude may end a reply with a fenced `blm-actions` JSON block, and the
popup shows it as a "Proposed change" card (`--claude` rim, the AI gradient rim while applying) and
writes it through `shared/api.js` only on **Apply**, for the story (or list) open at that moment.
The kinds live in one table, `shared/assistant-tools.js`, each with a shape allow-list and a check
against what OpenProject itself allows (the story's edit form, its allowed next statuses, the
project's assignees, types and sprints), so a value OpenProject would refuse shows up skipped, with
the reason, instead of failing at Apply. On a **story**: rename, replace the description, add
subtasks, post a comment, status, assignee, story points (the team scale 0–100: 0, 1, 2, 3, 5, 8, 13,
20, 40, 100), priority, label, sprint (or none), a relation to another story, rename/retype one of
its own subtasks, and change one of its subtasks' status. On a **list**: create a story in the
project. Nothing else; no time logging, no deleting, no bulk edits. Each row of the card reads
`old → new` (struck-through old value), a closing status or leaving a sprint adds a `--claude`
warning line, and a skipped row says why and is left out of "Apply n of m". After Apply, the card
offers **Undo** for everything that can be reversed (a patch is put back, a relation deleted;
comments, new subtasks and new stories have none, since removing them is not something to offer).
After applying, OpenProject's
own app re-reads the story in place (`OpenProject.getPluginContext()` →
`apiV3Service.work_packages.id(id).refresh()`, run in the page world by background.js; a full
reload only where that isn't available), the popup stays open, and each changed text on the page glows in `--claude`
with a light sweep three times (~4 s) — the second exception to "no extra motion"; with reduced
motion it is a static outline instead. A new story on a list is the one change that reloads the
page (a list has no per-story refresh), and the popup then stays closed.

Claude can also ask to read more, with a `blm-read` block: another story (with its subtasks and
relations), a search, a story's comments, another sprint's burndown, hours logged on a story or in
a sprint, and the workload per person. Reads change nothing, so they run without a click: the chat
shows one quiet line per read (a ring that turns, then a green dot, or red when it failed), the
results go back to Claude, and it answers. At most 3 rounds of up to 5 reads, then it must answer.
`docs/ai-assistant-tools.check.mjs` runs every tool's checks in node (`node docs/ai-assistant-tools.check.mjs`).

## Injected skin on OpenProject
`jira-skin.js` dresses OpenProject itself, not an extension page, so it follows
Jira instead of this system: a white top bar and a light left sidebar on every
page; on work-package lists, the split view and the full page, white paper,
#172b4d ink, #0c66e4 links and primary button, upper-case status lozenges
(grey to do, blue in progress, green done), a status button in the same three
colours, 16 px type and priority icons, 40 px rows. Its tokens (`--jx-*`) live in
that file, scoped under `html.blm-jira` (top bar), `html.blm-jira-wp` (work
packages) and `html.blm-jira-bl` (Backlogs), so nothing leaks into OpenProject
when the switch is off. On the full work-package page the status block and attribute groups move
into a right sidebar (`aside.blm-jx-side`), Jira-style, and move back when the
switch is turned off. A "Child work items" section (progress bar, then one row per
child with type icon, ID, subject, assignee and status lozenge) sits under the
description on the full page and in the split view, as in Jira, instead of only
in the Relations tab (whose Children table is then hidden). The section's + Create
child adds a new-item row (type · subject · Create / Cancel; Enter creates and keeps
the row open, Escape closes); Add existing searches the
project and sets the chosen work package's parent. Clicking a child's
assignee or status lozenge opens a picker
(search; Assign to me and Unassigned for people; the workflow's allowed statuses);
the change shows at once, dims while saving, then shows what OpenProject saved, or
reverts with the reason if it refuses. These are the skin's only writes, sent
through progress-hook.js so Confirm open subtasks and Auto 100 % still apply.
The Children table in the Relations tab gets an Assignee column (avatar + the same
picker) under its own switch, "Assign from the Children table", which also works
with Jira style off (`html.blm-assign` then carries the `--jx-*` tokens).
The Activity tab gets a Jira-style filter bar (Show All · Comments · History, Hide
automatic updates, remembered in `__blm_activity_filter`); one date heading per day.
It has its own switch ("Activity filter", `html.blm-activity`) and works with Jira
style off.
The Files tab shows attachments as cards (thumbnail or file-type tile, name,
size · date · uploader) with a Grid | List toggle (`__blm_file_view`); own switch
("Attachment cards", `html.blm-files`), works with Jira style off. Backlogs versions become grey sprint containers of white rows.

## Injected skin 2.0 (Apple OS 26/27)
Planned replacement for the Jira skin on work packages, behind its own switch
("UI 2.0", `__blm_ui2`, default off while it rolls out; mutually exclusive with Jira
style). Covers the work-package list, split view, full page and the Backlogs page;
boards and Gantt stay native. Unlike the rest of this system it deliberately
follows Apple's OS 26/27 look rather than graphite and cobalt: tokens `--g-*` in
`content/ui2/tokens.css` are Apple's system colours (systemGroupedBackground
#f2f2f7 / #000, grouped cards #fff / #1c1c1e, labels, fills, separators, systemBlue
#007aff / #0a84ff, systemGreen), scoped under `html.blm-ui2` so nothing leaks when
the switch is off. Light and dark follow `html[data-blm-ui2-theme]` (its own copy of
the theme: the Jira skin deletes `data-blm-theme` when it switches off).
The Planning page's components (facts panels, uppercase lozenges, accent card
edges) stay on the Planning page; UI 2.0 does not borrow them.
- Grouped grey canvas; content sits in white inset-grouped cards (16 px radius,
  no border, a near-invisible shadow). The work-package table is one such card.
- The story page reads like iOS Settings: a 28 px bold title, the description in
  one card, each attribute group a list with its header in secondary text above,
  label left and value right on one line, separators inset 16 px, at most two
  lists side by side. Empty values and all-empty groups fade until hovered.
- Controls are capsules: grey-fill buttons, one filled blue for Create, status
  as a tinted capsule in sentence case. Tabs are a segmented control.
- Glass (blur 30 px, saturate 180 %) only on menus, popovers and pickers, the one
  place something floats over content; nowhere else (blur over a flat canvas
  shows nothing and repaints on scroll). `prefers-reduced-transparency` makes it opaque.
- Motion answers the user, never plays on its own: the segmented thumb glides on
  the iOS spring curve (`cubic-bezier(.32,.72,0,1)`) to the hovered tab, capsules
  give (scale .96) under a press, rows highlight while pressed, a dragged backlog
  row lifts. Colour, opacity and transform only; off with the Animations setting
  and `prefers-reduced-motion`.
- Type: the system font stack (SF on macOS, Segoe UI Variable on Windows).
- Edits read as applied the moment the user acts (an option picked, Enter, the
  check button): the editor drops its chrome while OpenProject saves; a status
  just picked shows on its button at once. progress-hook.js announces each save's
  start / success / failure; a failed save puts the editor back with a short shake.
- Long-text fields (description, formattable custom fields) apply when you leave
  them: unchanged closes with no request; changed saves through OpenProject's own
  check button after confirming nobody else changed that field meanwhile (if they
  did, nothing is saved and an inline note explains). The CKEditor toolbar keeps a
  transparent 1 px border: its "do the buttons fit" check needs it.
- Each skin caches its on/off switch in the host page's localStorage so the first
  paint is already the chosen skin.
- Selectors that depend on OpenProject internals are listed once per CSS file so
  an OpenProject upgrade is a one-place fix; `!important` only to beat ng-select
  and Angular specificity.

## Injected skin: iOS
A second experimental skin, `content/ios/`, chosen like the others under Settings →
Appearance → Style (`__blm_ios`, default off; Jira style, UI 2.0 and iOS are
mutually exclusive). Same graphite and cobalt `--g-*` tokens as the original
UI 2.0, scoped under `html.blm-ios`, with light and dark from
`html[data-blm-ios-theme]`; its JS hooks use a `blm-i-` prefix
(`.blm-i-chip`, `data-blm-i-empty`…) so it never fights UI 2.0's `ui2.js`.
- Work-package detail (split view and full page) follows iOS grouped lists:
  the panel is the grouped background (`--g-grouped`, #f2f2f7 / near-black, glass),
  content sits on solid `--g-card` cards with 12 px radii. Title 28 px bold (22 px
  in the split view); type and status are capsules (type tinted with its own
  OpenProject colour via `currentColor`). Attribute groups: upper-case 12 px grey
  header, one card, 44 px rows, label left in `--g-text`, value right in
  `--g-text2`, `--g-row-sep` hairlines inset 16 px on both sides (half a pixel on
  2× screens). While a field is edited its value goes full width and left-aligned
  so OpenProject's pickers open in place.
  Empty values ("-") hide behind a "Show N empty fields" footer under the card
  (`ios.js`); required fields and a field being edited always show. Tabs are a
  segmented control (`--g-fill` track, `--g-card` thumb); activity entries are
  cards under upper-case date headers; the comment field is a 20 px-radius
  message field. Overdue dates use `--g-red`.
- Editable text (title, description) shows a soft `--g-fill` rounded highlight on
  hover, never an outline. The status menu is a frosted pull-down: 14 px radius,
  36 px rows, an inset 8 px hover pill, plain 10 px colour dots.
- Work-package list follows an inset-grouped list on the same `--g-grouped-solid`
  page: each group is its own `--g-card` card with 12 px corners, its name above
  it in upper-case 12 px `--g-text3` with a chevron and a `--g-fill` count capsule
  (no grey band); without grouping the whole list is one card. 44 px rows,
  `--g-row-sep` hairlines inset 16 px from the leading edge, none under a card's
  last row; the Sum row is the card's faintly tinted footer. Column titles sit
  on the grey above the cards, translucent while sticky. Priority is a dot (red
  for urgent names, `--g-orange` for high, a ring for low); a lone "-" fades to
  `--g-text3`. Large title 28 px bold; filter counts are `--g-accent` capsules.
