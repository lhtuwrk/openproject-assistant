# Backlog Monitor

A Chrome (Manifest V3) extension that snapshots and tracks OpenProject backlog data
from your OpenProject instance, so daily burndown history is preserved even
though OpenProject itself doesn't retain it.

## Features

- **Daily snapshots** — extracts work-package state from tracked backlog/version
  pages and stores one snapshot per day in `chrome.storage.local`.
- **Automatic sync** — an hourly alarm keeps today's snapshot fresh; a midnight
  alarm reconstructs any days that were missed (browser closed, no sync that day)
  by replaying each tracked version's activity feed.
- **Burndown viewer** — a standalone page (`viewer.html`) charts stored snapshots
  over time per tracked version.
- **Time log** — `timelog.html` shows a Member × Day grid of hours logged in a
  project over a sprint (or custom range), flagging missing and under-8h days.
  Member groups are saved to `chrome.storage.sync`.
- **Log-time reminders** — on the last working day of each sprint and month (and
  the working day before) you get a "log your time" task until you click Done:
  a badge on the toolbar icon, a task card in the popup, a floating card on every
  website (from 16:00 only) and a Windows notification (at most every 3 h, 08:00–18:00).
- **Import/export** — `import.html` supports bringing in previously exported
  snapshot data.
- **Dashboard** — three pages behind one side rail showing your account (avatar,
  sprint day, hours logged so far): **Settings** (every feature with a description
  and an on/off switch), **Burndown** and **Time log**. Also opens from
  `chrome://extensions` → Details → Extension options.
- **Popup** — your account, the log-time task, My time for a sprint, burndown
  sync status, and shortcuts to the three dashboard pages.

## Project layout

| File | Purpose |
|---|---|
| `manifest.json` | Extension manifest (MV3) |
| `background/background.js` | Service worker: hourly sync + midnight reconstruction alarms |
| `content/content.js` | Injected into backlog work-package pages to read live data |
| `content/jira-skin.js` | Jira-style look for OpenProject: white top bar and light sidebar on every page, work-package lists, the work-package page (Details sidebar, Child work items with assignee and status pickers) and Backlogs (sprint containers); toggled in Settings |
| `shared/api.js` | OpenProject API client helpers used by the background worker |
| `pages/popup.html` / `pages/popup.js` | Toolbar popup UI |
| `pages/sidepanel.html` / `pages/sidepanel.js` | Quick settings, opened from the popup's settings button |
| `content/quick-settings-host.js` | Shows Quick settings as a drawer on the right of the current page (every http(s) site; acts only on the popup's message) |
| `pages/dashboard.html` / `pages/dashboard.js` | Dashboard: Settings page (feature switches) |
| `shared/shell.css` / `shared/shell.js` | Dashboard side rail (profile, nav) shared by Settings, Burndown, Time log |
| `shared/tokens.css` / `fonts/` | Shared design tokens (palette, type, spacing) and bundled Geist fonts |
| `shared/me.js` | Signed-in user profile cache and own-hours summary (popup + rail) |
| `design.md` | The locked design system every page follows |
| `pages/viewer.html` / `pages/viewer.js` | Dashboard: Burndown chart viewer |
| `pages/import.html` / `pages/import.js` | Snapshot import UI |
| `pages/timelog.html` / `pages/timelog.js` | Dashboard: Time log, Member × Day spent-time grid + member groups |
| `background/reminder.js` | Log-time deadline check, badge and notifications (background) |
| `content/reminder-banner.js` | Floating reminder card on every website (reads only extension storage) |

## Installing (unpacked, for development)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this repository's folder.
4. A setup page opens: enter your OpenProject address (e.g.
   `https://openproject.example.com`) and allow Chrome access to that site.
   You can change it later under Settings → Change host.
5. Navigate to a backlog work-packages page on your OpenProject host to start
   collecting snapshots.

## Packaging a release

Pushing a tag runs `.gitea/workflows/release.yml`, which zips
`manifest.json` plus the `background/`, `content/`, `pages/`, `shared/`,
`icons/` and `fonts/` folders, checks that every path the manifest references
exists inside the zip, and attaches it to a Gitea release. To package by hand:

```
zip -r backlog-monitor.zip manifest.json background content pages shared icons fonts
```

Load the result via `chrome://extensions` -> **Load unpacked** (after unzipping)
or upload it to the Chrome Web Store dashboard. `manifest.json` must stay at the
repository root: moving the extension root changes the unpacked extension ID and
wipes users' stored data.
