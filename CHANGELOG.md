# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
