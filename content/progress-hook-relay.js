// progress-hook-relay.js — isolated-world bridge for progress-hook.js.
//
// MAIN-world scripts can't read chrome.storage, so this mirrors the popup's toggles
// onto <html> data attributes:
//   "Auto 100% progress"                 → data-blm-auto-progress="on|off"
//   "Confirm Resolve with open subtasks" → data-blm-confirm-subtasks="on|off"
//   "Short list cache"                   → data-blm-list-cache="on|off"
//   "Ask for Fixed in version"           → data-blm-fixed-version="on|off"
// and the Fixed in version settings as JSON → data-blm-fixed-version-cfg.

'use strict';

const FLAGS = {
  __blm_auto_progress:      'blmAutoProgress',      // default: true
  __blm_confirm_subtasks:   'blmConfirmSubtasks',   // default: true
  __blm_list_cache:         'blmListCache',         // default: true
  __blm_fixed_version:      'blmFixedVersion',      // default: true
};

// Keep in step with FIXED_DEFAULTS in pages/dashboard.js.
const FIXED_CFG_KEY      = '__blm_fixed_version_cfg';
const FIXED_CFG_DEFAULTS = { sprint: '26.10.B', version: '2.47', types: 'Bug', related: true };

function applyFlag(key, value) {
  document.documentElement.dataset[FLAGS[key]] = (value ?? true) ? 'on' : 'off';
}

function applyFixedCfg(value) {
  document.documentElement.dataset.blmFixedVersionCfg = JSON.stringify({ ...FIXED_CFG_DEFAULTS, ...value });
}

chrome.storage.local.get([...Object.keys(FLAGS), FIXED_CFG_KEY]).then(s => {
  for (const key of Object.keys(FLAGS)) applyFlag(key, s[key]);
  applyFixedCfg(s[FIXED_CFG_KEY]);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const key of Object.keys(FLAGS)) {
    if (key in changes) applyFlag(key, changes[key].newValue);
  }
  if (FIXED_CFG_KEY in changes) applyFixedCfg(changes[FIXED_CFG_KEY].newValue);
});
