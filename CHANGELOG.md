# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.6.2]

### Added
- A sprint or saved view in the project sidebar can be pinned for one-click access from anywhere on the backlog, via a pin icon on the entry and quick-jump tabs added to the header.
- Planning: your own comments on a story can be edited in place, @mentions included.
- Planning: a subtask's title and type can be edited in place on the Subtasks tab, next to its status and assignee.
- Planning: the Subtasks tab suggests the subtasks the team usually creates, learned from the project's last three sprints (or a per-project template the facilitator can edit), each with a readable title of its own.
- Planning: a story can be written straight into the sprint, or cloned from an existing one, in a large dialog laid out like the story: its title, type, story points, assignee, version and rendered description can be changed first, and subtasks (the suggested ones, the original's own or new ones) created with it. A new story also picks its priority and label, which is what puts it in a level, and it joins that level as soon as it is created — mid-session too.
- Resolving a Bug, or a story related to a Bug, asks for its Fixed in version with the sprint's release already added (2.47 for sprint 26.10.B, one up each sprint), and saves it with the status. The starting sprint, release and types are set in Settings.

- The current sprint's version is now tracked from its first day even if the chart is never opened, so everyone's Burndown names the same stories that moved out. Someone who starts late sees the chart at once, and the stories that left before, including ones handed to another project, are looked up a few a minute in the background and added when done, so the chart ends up the same as their teammates'.

### Changed
- Burndown keeps the current sprint and the one before it; older sprints are cleared.
- Planning: planning a story that is still New or Reopened asks for confirmation first.
- Planning: a new subtask is created when you click outside its title field, not only on Enter.
- Planning: how long a story gets no longer depends on its points or its priority — planning is what produces the estimates, and a story's priority has already had its say by choosing the level it sits in. Each level now carries a Min/story rate, set under Edit grouping, so a sprint-goal story is always worth more of the session than a side quest by the ratio you chose. A sprint that fits gets exactly those minutes and ends early; a crowded one shrinks every level together, and the lobby warns when a level is down to under 2 minutes a story.
- Opening the status menu or a field's dropdown (assignee, priority, version…) on a work package shows a spinner on it while its choices load, instead of looking frozen.
- Status changes save faster: the open-subtasks and auto-progress checks reuse the work package already on screen and no longer hold the save for extra requests.
- Jira style: after a status change in the work-package list, the row pulses while it saves, then moves itself into the matching status group with a flying animation, scrolls into view and highlights for a second. If the new status takes it out of the list's filters, a note says so.
- Jira style: status, assignee and accountable open the same searchable picker everywhere (work-package header, list rows, Details sidebar, Relations tab), not OpenProject's own menus.
- Jira style: status lozenges, ticket keys (#123), priority icons, avatars and "Unassigned" look the same in the list, Backlogs, Child work items, Relations and the sidebar; "in progress" is blue everywhere, the subtask bar and its popover included.
- Jira style: the Relations tab is laid out like Child work items, and the confirmation dialogs and settings drawer follow the Jira style look in light and dark.

### Fixed
- Planning: after creating a subtask or posting a comment, the field no longer keeps the old text, so the next subtask doesn't reuse the previous title.
- Jira style: a subtask's status picker on the story page offers the moves allowed from its current status and assignee, not the ones from before its last change.
- Planning: a subtask's or story's status list refreshes after its assignee changes, and no longer shows the moves from its previous status.
- Jira style: after changing a subtask's status, assignee or title on the story page, the story's own status button opens again instead of doing nothing.
- Burndown: removing a tracked version while the versions sheet is still loading no longer leaves the list of versions to add empty and stuck.
- Burndown: today's Scope tab keeps naming the stories that moved in, moved out or changed points; the live sync no longer wipes them a second after the chart opens, and a scope change during the day is named at the next sync.
- Jira style dark mode: avatar initials, error states and popup shadows are readable on the dark background.
- Jira style: the quote no longer overlaps the page count, the work-package page no longer scrolls sideways, the heading above the tabs names the open tab, and child rows you can't edit no longer look clickable.

## [1.6.1] - 2026-10-14

### Changed
- Burndown: the chart is taller with a grid line every few points, so a change of a few points shows as a clear turn of the line.

### Fixed
- Burndown drawer: the sidebar resize bar no longer shows over the chart (the drawer has no sidebar).

## [1.6.0] - 2026-10-14

### Added
- Planning: the facilitator can edit how stories are grouped into levels (labels, priority, type, status, assignee), add or remove levels, and choose how stories are sorted inside a level (priority then label order, story points, or ticket number).

### Changed
- Burndown: each day counts from 00:00 to 23:59 ICT and is locked when it ends; today is live. The cutoff time settings are gone, and stored days of tracked versions are rebuilt once on update.
- Burndown: each date on the chart is the start of that day, so the segment to the next date is that day's progress; today is a dashed live point. Clicking a segment names the day(s) it covers.
- Burndown: the chart covers the whole version, from its first day; a version's start and end dates are taken from OpenProject.
- Burndown: the current sprint's version is always tracked and shown, also when other versions are tracked.
- Burndown: a loading state (spinner and placeholder tiles) shows while the page or the drawer gathers its data.
- Burndown drawer: shows the same dates as the page; plans saved with the old Monday start move to the version's first day, which "Hide first day" then hides.
- Burndown: the Ideal line starts from what was left when the sprint's work started, instead of from today's total scope.
- Burndown: a sprint runs to its version's last working day (Thursday), as in OpenProject, instead of the next planning Friday.
- Burndown redesign: a pace strip (remaining, burned today, days left); Done statuses and weekend days in menus on one line; the legend's Done chip shows the Done line; a day strip under the chart; clicking a day opens its burned, scope and status-move detail full width below; Snapshot table, CFD and Flow open as rows under the chart.
- Burndown: the chart leaves out the version's first day (the planning day) by default; Days menu → Hide first day turns it back on (remembered). The menu also holds the weekend days.
- Burndown page bar: a sprint stepper (‹ sprint ›, Custom range… for any dates) and a Main view switch.
- Versions open as a side sheet: tracked versions (the current sprint marked always shown), search, project filter, closed versions and work package types; changes save at once.

### Fixed
- "Show burndown chart" on a backlog tab left open while the extension was updated reloads the page instead of failing.
- Burndown: the chart redraws when today's numbers change (hourly sync, or opening today's stories), so the burned count matches the stories listed; the open day stays open.
- Burndown day detail lists one story per row, so story titles show in full.
- Popup: Burndown opens again; Chrome blocked its page ("ERR_BLOCKED_BY_CLIENT") because the drawer had made it reachable only through a per-session address.
- Popup: Burndown, Time log and Planning reuse only a tab where the page is running; tabs left on Chrome's "blocked" page after the extension was reloaded are closed and the page opens in a new tab.
- The current sprint is found when its version name has a double space (e.g. "Credit Utility  26.12.C").
- Planning: the time bank in the top bar counts down live and turns red once the current level runs over its budget.
- #123 chips: a reference OpenProject shows twice in a row (link plus its title) shows as one chip, and text being edited in the rich text editor is no longer turned into chips.

## [1.5.4] - 2026-10-06

### Added
- With Jira style on, a floating "Child work items" button on work-package pages (full page and split view) jumps to the child work items, so they are one click away under a long description.

### Changed
- The quote of the day in the work-package list's bottom bar is larger, in the main text colour and kept to one line.

### Fixed
- Dark mode: the Time and costs report table (cells, headers, links, hover) and its group-by bars now follow the dark theme instead of staying light.

## [1.5.3] - 2026-10-06

### Changed
- The OpenProject host is no longer built in. A setup page opens on install (and after updating) to enter it and allow Chrome access to that one site; change it any time from Settings → Change host. Backlog content scripts are now registered at runtime for the chosen host.

## [1.5.2]

### Added
- With Jira style on, work-package pages (full page and split view) list the child work items under the description, with their progress, assignee and status.
- With Jira style on, the Relations tab no longer repeats the children (nor counts them in its label); the Child work items section (shown even before the first child) has Create child (a new-item row: type, subject, Enter to create) and Add existing (search the project, make it a child).
- A child work item's assignee and status can be changed straight from that list; Confirm open subtasks and Auto 100 % on resolve still apply.
- The Children table in a work package's Relations tab has an Assignee column for reassigning children, with or without Jira style (own Settings switch).
- Dark mode for the backlog (Catppuccin Mocha, with Jira style on), following the Theme choice in Settings.
- Smoother backlog: the side menu and the story detail glide in, menus, dialogs and drop-downs ease in, buttons give press feedback, rows and avatars react to hover, and the subtask bar animates when counts change (off when reduced motion is requested).
- The Activity tab can show All, Comments or History and hide the automatic progress updates children cause, with or without Jira style (own Settings switch).
- The popup's settings button opens Quick settings in a drawer on the right of the page: every feature switch and the theme, saved on click, with a link to all settings (Chrome's side panel where a page can't host it).
- The Files tab shows attachments as cards with image thumbnails, file-type tiles, size, date and uploader, with a toggle back to OpenProject's list (own Settings switch).
- With Jira style on, a "Welcome back" greeting sits beside the work-package list title.
- A random motivational quote shows in the work-package list's bottom bar, a new one each time you open the list (own Settings switch).
- An Animations switch in Settings turns the slide, fade and hover effects off; they also pause while you drag.
- Going back from a story to the work-package list within 15 seconds no longer reloads it (own Settings switch); saving clears it at once.

### Fixed
- Assignee avatars in the work-package list are round again instead of stretched.
- Subtask progress bars show correct counts for parents with more than 200 subtasks, and retry after a failed load instead of staying blank.
- The subtask bar of the open work package refreshes in the work-package list after an edit.
- The subtask popover no longer jumps to the top-left of the screen after scrolling.
- Time log opens for projects that hide their member list instead of showing "Session expired".
- Time log hover popover closes when the grid is refreshed.
- A time log group that fails to save no longer appears saved.
- The profile picture is kept when the backlog is briefly unreachable.
- "My time" in the popup always matches the selected sprint.

### Changed
- Page changes in the work-package views are handled once per frame instead of piling up repeated checks, and failed subtask lookups wait a few seconds before retrying.
- Time log loads large time-entry ranges in parallel and switches groups without reloading.
- Settings uses two columns on wide screens, with each switch next to its feature name.
