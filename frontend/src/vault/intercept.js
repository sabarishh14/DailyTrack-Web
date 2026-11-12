// Puts the private vault in front of the Investments API. With the vault off,
// requests go to the server as always; with it on, the engine answers them from
// the opened vault, in the same shapes, so no page needs to know which it is.
import * as store from './store';
import { handle, lockedAnswer, isInvestPath, forgetSettings } from './engine';

const respond = ({ status, body }) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

let installed = false;

export function installVaultFetch(apiBase) {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const inner = window.fetch;

  const answer = async (method, path, query, init) => {
    const s = await store.status();
    if (s.state === 'on' && !store.isOpen()) await store.tryRemembered().catch(() => false);
    if (!store.isOpen()) return respond(lockedAnswer(method, path));
    let body = init.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* sent as it is */ }
    }
    const result = await handle(store, method, path, query, body ?? {}, store.current().readOnly);
    return result ? respond(result) : null;
  };

  window.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.startsWith(apiBase)) return inner(input, init);
    const [path, qs = ''] = url.slice(apiBase.length).split('?');
    const method = String(init.method || (typeof input !== 'string' && input?.method) || 'GET').toUpperCase();
    if (path === '/me/settings' && method === 'PUT') forgetSettings();
    if (!isInvestPath(path)) return inner(input, init);

    let state = 'off';
    try { state = (await store.status()).state; } catch { /* offline: the server's answer stands */ }
    if (state !== 'off') return (await answer(method, path, new URLSearchParams(qs), init)) || inner(input, init);

    const res = await inner(input, init);
    if (res.status !== 409) return res;
    // Turned on from another device since this page read the state: ask again.
    const code = await res.clone().json().then(j => j?.code).catch(() => null);
    if (code !== 'VAULT_ON' && code !== 'VAULT_MOVING') return res;
    await store.status(true).catch(() => {});
    return (await answer(method, path, new URLSearchParams(qs), init)) || res;
  };
}
