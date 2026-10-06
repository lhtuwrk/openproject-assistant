// progress-hook-relay.js — isolated-world bridge for progress-hook.js.
//
// MAIN-world scripts can't read chrome.storage, so this mirrors the popup's toggles
// onto <html> data attributes:
//   "Auto 100% progress"                 → data-blm-auto-progress="on|off"
//   "Confirm Resolve with open subtasks" → data-blm-confirm-subtasks="on|off"
//   "Short list cache"                   → data-blm-list-cache="on|off"

'use strict';

const FLAGS = {
  __blm_auto_progress:      'blmAutoProgress',      // default: true
  __blm_confirm_subtasks:   'blmConfirmSubtasks',   // default: true
  __blm_list_cache:         'blmListCache',         // default: true
};

function applyFlag(key, value) {
  document.documentElement.dataset[FLAGS[key]] = (value ?? true) ? 'on' : 'off';
}

chrome.storage.local.get(Object.keys(FLAGS)).then(s => {
  for (const key of Object.keys(FLAGS)) applyFlag(key, s[key]);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(FLAGS)) {
    if (key in changes) applyFlag(key, changes[key].newValue);
  }
});
