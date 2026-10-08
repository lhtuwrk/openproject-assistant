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
title, then the Description · Subtasks · Relations · Attachments tabs at full
length) and a sticky 320 px side column holds the story's own clock, Planned /
Defer, Prev / Next, Status · Assignee · Author · Updated, the planned tally and
what's up next. Under 1100 px the side column moves above the story. The
story's own clock is the side column's headline: elapsed in 40 px Geist Mono over
its share, with a meter that turns red past it.
The wrap-up (after End game) reads like a report with one way out: a headline
that says where the sprint stands ("Nothing decided yet" / "3 of 14 decided" /
"… is planned"), one planned · deferred · not-planned bar, a row per level, and
a Next panel (Copy summary, Review all stories, Back to the arena) ending in
"Start a new planning…", which asks once, inline, only when decisions would be
lost.
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
Defer are the game's own bookkeeping and write nothing. Under the card, the
story's detail panel (Status · Assignee · Author · Updated, then Description ·
Subtasks · Relations · Attachments tabs) is where the team reads and edits the
story: status, assignee, new subtasks (type · subject · assignee, created in the
sprint) and subtask status/assignee are written to OpenProject at once with no
confirm dialog. The description is OpenProject's HTML, sanitized; images and
attachment thumbnails are fetched with the session cookie. View all lists every
story by level with a Planned / Deferred / On the table / Not planned chip and
opens the same detail panel beside the list.

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

## Injected skin 2.0
A second look for work packages, behind its own switch ("UI 2.0", `__blm_ui2`,
default off until the look is approved). It is mutually exclusive with Jira style:
turning UI 2.0 on turns Jira style off and remembers it (`__blm_jira_before_ui2`);
turning UI 2.0 off brings Jira style back if it was on.

**Direction: a professional Linear/Jira hybrid.** White surfaces, very light grey
separators, one cobalt, semantic status colours, restrained shadows. Hierarchy
does the work, not decoration. (An earlier "liquid glass" direction was dropped:
pastel canvases and translucent cards cut contrast and made cards blend.)

**Separate look, shared behaviour.** UI 2.0 has its own CSS (`content/ui2/*.css`,
every selector under `html.blm-ui2`) but reuses the Jira skin's DOM work, which is
proven on the live site: type and priority icons (`.blm-jx-icon`), the Child work
items section with its writes (`.blm-jx-children`), and the full-page sidebar
(`aside.blm-jx-side`). `jira-skin.js` runs that work when either skin is on; its
own `blm-jira*` classes and CSS stay tied to Jira style alone. Scope:
`html.blm-ui2` (top bar and sidebar) on every page of the host, `html.blm-ui2-wp`
(content) on work-package routes only. Backlogs, boards and Gantt keep native content.
Light and dark follow `html[data-blm-ui2-theme]` (its own copy: the Jira skin
deletes `data-blm-theme` when it switches off).

### Surfaces and colour
- Paper #f6f7f9 light / #0f1014 dark; surfaces #fff / #17191e; separators
  #eceef2 / rgba(255,255,255,.07). Shadow only on floating things (menus, the
  split panel edge): `0 1px 2px` + `0 8px 24px` at low alpha.
- Pills are reserved for state: status, priority, type. Counts, labels, versions
  and everything else are plain text.
- Status tones: to do grey, in progress cobalt, done green. Type: 16 px glyph
  tile in its type colour. Priority: a small glyph (▲ red / orange, ═ amber, ▼ blue).
- Primary action: cobalt fill, white text, 32 px tall, 8 px radius, one per view.
  Radii: 6 px controls, 8 px cards and the split panel, full pill for status.
- Geist, loaded from the extension (`fonts/*.woff2` web-accessible); tabular
  figures for IDs, points, hours, percentages.

### Typography and density
Page title 22 px / 650. Section headings 13 px / 600 in full ink. Group headers
14 px / 600 with a plain count. Body and rows 13 px; secondary metadata 12 px in
`--text2`. Rows 40 px.

### Layout
- **List**: compact toolbar band (title, then actions) above the table; the
  column header is OpenProject's own sticky `thead`. Group headers are strong
  section rows (chevron, name, count) on a light band. Rows: clear hover tint,
  selected row = accent-tinted fill plus a 3 px cobalt bar on the left, painted on
  the row and its cells. IDs and subjects read as links. Progress is a slim bar +
  right-aligned percentage; spent time right-aligned.
- **Split view**: docked beside the list (OpenProject's own split, resizer kept),
  styled as one white workspace with a hairline edge. Compact header: type icon,
  ID, subject, status pill; tabs as an underline bar.
- **Full page**: Back link; compact header card (type icon, ID, subject, status,
  actions) with a one-line meta strip (assignee, priority, type, points,
  progress). Two columns: main (Description → Child work items → Activity) and a
  compact sticky Details sidebar. Child work items are the visual anchor: progress
  bar, status icon per child, status pill, chevron. Activity is a timeline:
  avatar, name, time, then the comment; the comment box sits at the end. One
  column below 1100 px.

### Fallbacks and motion
Motion: colour, background, transform only; `prefers-reduced-motion` drops it to 0.
Selectors that depend on OpenProject internals are listed at the top of each CSS
file. `!important` only to beat OpenProject's own `!important` and inline sizes.
