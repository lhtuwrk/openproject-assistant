// setup.js — first-run page: asks for the OpenProject host, requests Chrome's
// permission for that one site, checks it answers like OpenProject, then saves
// it to __blm_host. background.js re-registers the backlog content scripts as
// soon as the key changes.

import { HOST_KEY, getHost, normalizeHost } from '../shared/config.js';

const form   = document.getElementById('setup-form');
const input  = document.getElementById('host');
const save   = document.getElementById('save');
const msg    = document.getElementById('msg');
const done   = document.getElementById('done');
const goBack = document.getElementById('go-return');
const goBl   = document.getElementById('go-backlog');

// Where to go after saving: the page that sent us here, else Settings.
const ret = new URLSearchParams(location.search).get('return');
// Only our own pages: a chrome-extension URL's origin is "null", so compare the prefix.
if (ret && ret.startsWith(chrome.runtime.getURL('pages/'))) goBack.href = ret;

function say(text, tone = '') {
  msg.textContent = text;
  msg.className = `msg${tone ? ' ' + tone : ''}`;
}

const current = await getHost();
if (current) {
  input.value = current;
  document.getElementById('title').textContent = 'Backlog host';
  save.textContent = 'Save';
}

/** Probes the OpenProject API. Returns { ok, name?, signedOut?, reason? }. */
async function probe(origin) {
  try {
    const res = await fetch(`${origin}/api/v3/users/me`, {
      credentials: 'include', cache: 'no-store', headers: { Accept: 'application/hal+json' },
    });
    const data = await res.json().catch(() => null);
    if (!data || typeof data._type !== 'string') return { ok: false, reason: 'That address doesn\'t answer like an OpenProject API.' };
    if (res.ok && data._type === 'User' && data.id) return { ok: true, name: data.name };
    return { ok: true, signedOut: true };
  } catch {
    return { ok: false, reason: 'Couldn\'t reach that address.' };
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const origin = normalizeHost(input.value);
  if (!origin) {
    input.setAttribute('aria-invalid', 'true');
    say('Enter a web address such as https://openproject.example.com.', 'err');
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  input.value = origin;

  // Must be the first await: Chrome only shows the prompt inside the click.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) { say('Chrome access to that site is needed to read the backlog.', 'err'); return; }

  save.disabled = true;
  say('Checking…');
  const r = await probe(origin);
  save.disabled = false;
  if (!r.ok) { say(r.reason, 'err'); return; }

  const previous = await getHost();
  await chrome.storage.local.set({ [HOST_KEY]: origin });
  if (previous && previous !== origin) {
    chrome.permissions.remove({ origins: [`${previous}/*`] }).catch(() => {});
  }

  say(r.signedOut
    ? `Saved. You're signed out of ${new URL(origin).host} — sign in there, then continue.`
    : `Connected as ${r.name}.`, r.signedOut ? 'warn' : 'ok');
  goBl.href = origin;
  done.classList.add('show');
});
