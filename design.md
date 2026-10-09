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

## Injected skin 2.0 (liquid glass)
Planned replacement for the Jira skin on work packages, behind its own switch
("UI 2.0", `__blm_ui2`, default off while it rolls out; mutually exclusive with Jira
style). Covers the work-package list, split view and full page only; Backlogs,
boards and Gantt stay native. Unlike the Jira skin it follows this system's
graphite and cobalt: tokens `--g-*` in `content/ui2/tokens.css` derive from
`tokens.css` (accent #4c7dff / #2f5fe0), scoped under `html.blm-ui2` so nothing
leaks when the switch is off. Light and dark follow `html[data-blm-ui2-theme]`
(its own copy of the theme: the Jira skin deletes `data-blm-theme` when it switches off).
- Glass is for chrome and floating panels only: top bar, toolbar, the split-view
  panel, pickers. Blur 20 px, saturate 160 %, a 1 px inner hairline
  (`rgba(255,255,255,.18)`), a soft layered shadow, 14–16 px radii. Never on
  table rows (OpenProject re-renders them constantly).
- A calm gradient canvas sits behind; content floats on it. Fewer borders, more
  whitespace, 44 px rows.
- Status, type and priority are small tinted glass chips, sentence case, not
  upper-case lozenges. One signal colour each, as in the rest of the system.
- Type: system font stack (Geist is not exposed to the host page).
- Motion: colour, background and transform only; `prefers-reduced-motion` drops
  transitions to 0. `prefers-reduced-transparency` and browsers without
  `backdrop-filter` get opaque `--surface` panels. Text on glass keeps 4.5:1
  contrast over both canvases.
- Selectors that depend on OpenProject internals are listed once per CSS file so
  an OpenProject upgrade is a one-place fix; `!important` only to beat ng-select
  and Angular specificity.
