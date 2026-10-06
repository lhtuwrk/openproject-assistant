// config.js — which OpenProject instance this install talks to.
//
// The host is chosen once on pages/setup.html (opened automatically on install)
// and kept in chrome.storage.local under __blm_host as a bare origin such as
// "https://openproject.example.com". Nothing in the code base names a host.

'use strict';

export const HOST_KEY  = '__blm_host';
export const SETUP_URL = chrome.runtime.getURL('pages/setup.html');

let cached;   // undefined = not read yet, null = not set

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && HOST_KEY in changes) cached = changes[HOST_KEY].newValue || null;
});

/**
 * Turns what a user typed into an origin, or null when it isn't a web address.
 * "openproject.example.com/projects" → "https://openproject.example.com"
 */
export function normalizeHost(input) {
  let s = String(input ?? '').trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (!/^([a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/i.test(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** The configured origin, or null before setup. */
export async function getHost() {
  if (cached !== undefined) return cached;
  const { [HOST_KEY]: h } = await chrome.storage.local.get(HOST_KEY);
  cached = h || null;
  return cached;
}

/**
 * For extension pages: resolves to the host, or — before setup — sends the
 * user to the setup page and never resolves, so the page doesn't render
 * half-configured. The popup and side panel open setup in a tab instead.
 */
export async function requireHost() {
  const host = await getHost();
  if (host) return host;
  const inPanel = /\/pages\/(popup|sidepanel)\.html$/.test(location.pathname);
  if (inPanel) {
    chrome.tabs.create({ url: SETUP_URL });
    window.close();
  } else {
    location.replace(`${SETUP_URL}?return=${encodeURIComponent(location.href)}`);
  }
  return new Promise(() => {});
}
