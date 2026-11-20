// claude-bridge.js — talks to the local claude-bridge container (POST /ask and the streaming
// POST /chat run `claude -p` with every tool off on the user's own subscription). No API key lives in the extension.

export const BRIDGE_KEY = '__blm_claude_bridge';   // local: { url, token, model }
export const AI_KEY = '__blm_claude_ai';           // local: Settings → Experimental switch
const DEFAULT_URL = 'http://127.0.0.1:8787';

/** The models a user can pick; every ask uses the chosen one. */
export const MODELS = [
  { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
];
export const DEFAULT_MODEL = 'claude-sonnet-5';

export async function bridgeConfig() {
  const c = (await chrome.storage.local.get(BRIDGE_KEY))[BRIDGE_KEY] ?? {};
  return { url: c.url || DEFAULT_URL, token: c.token || '', model: MODELS.some(m => m.id === c.model) ? c.model : DEFAULT_MODEL };
}

export async function setModel(model) {
  const c = (await chrome.storage.local.get(BRIDGE_KEY))[BRIDGE_KEY] ?? {};
  await chrome.storage.local.set({ [BRIDGE_KEY]: { ...c, model } });
}

async function open(path, init = {}) {
  const { url, token } = await bridgeConfig();
  if (!token) throw new Error('Set the bridge token in Settings → Experimental');
  let res;
  try {
    res = await fetch(url + path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error(`The Claude bridge isn't running at ${url} (docker compose up -d in its folder)`);
  }
  if (res.ok) return res;
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('The bridge refused the token: check it in Settings → Experimental');
  throw new Error(body.error || `Bridge error ${res.status}`);
}

const post = async (path, body, signal) => open(path, {
  method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...body, model: (await bridgeConfig()).model }),
});

export const bridgeHealth = async () => (await open('/health')).json();

/** Asks Claude, optionally following a plugin skill the bridge has mounted (e.g. 'rocket:design-test-case');
 *  with a JSON schema, resolves to the object it filled, else to its text. */
export async function askClaude(prompt, schema, skill) {
  const r = await (await post('/ask', { prompt, schema, skill })).json();
  if (schema && !r.structured) throw new Error("Claude's answer didn't come back in the expected shape; try again");
  return schema ? r.structured : r.result;
}

/** Streams one chat turn: calls onDelta with each piece of text as Claude writes it; resolves when it's done.
 *  Aborting the signal stops Claude on the bridge too. */
export async function streamChat(prompt, system, onDelta, signal) {
  const res = await post('/chat', { prompt, system }, signal);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      if (ev.t === 'delta') onDelta(ev.text);
      else if (ev.t === 'error') throw new Error(ev.error);
      else if (ev.t === 'done') return;
    }
  }
  throw new Error('The bridge closed the stream before Claude finished');
}
