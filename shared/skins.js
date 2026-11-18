// skins.js — the Style choice (Settings and Quick settings): one value over three
// exclusive chrome.storage.local flags. A missing key is "never set": Jira style
// defaults on, the other two off. "none" turns all three off.

export const SKINS = { jira: '__blm_jira_skin', ui2: '__blm_ui2', ios: '__blm_ios' };
export const SKIN_KEYS = Object.values(SKINS);
const DEFAULTS = { __blm_jira_skin: true, __blm_ui2: false, __blm_ios: false };

/** 'ios' | 'ui2' | 'jira' | 'none' from stored flags (missing keys use the defaults). */
export function currentSkin(stored) {
  const on = k => stored[k] ?? DEFAULTS[k];
  if (on(SKINS.ios)) return 'ios';
  if (on(SKINS.ui2)) return 'ui2';
  if (on(SKINS.jira)) return 'jira';
  return 'none';
}

/** Writes all three flags so exactly the chosen one (or none) is on. */
export function setSkin(value) {
  return chrome.storage.local.set(Object.fromEntries(SKIN_KEYS.map(k => [k, SKINS[value] === k])));
}

/** Calls fn(skin) whenever any of the flags changes, with the merged state. */
export async function watchSkin(fn) {
  const state = await chrome.storage.local.get(SKIN_KEYS);
  fn(currentSkin(state));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !SKIN_KEYS.some(k => k in changes)) return;
    for (const k of SKIN_KEYS) if (k in changes) state[k] = changes[k].newValue;
    fn(currentSkin(state));
  });
}
