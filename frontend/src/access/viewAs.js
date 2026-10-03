// Whose data this browser is looking at: null for your own, or the email of
// someone who shared theirs with you (read-only; the server enforces it).
// Every request to the API carries it as X-View-As, so no call site needs to know.

const KEY = 'dt_view_as';

export const getViewAs = () => {
  try { return localStorage.getItem(KEY) || null; } catch { return null; }
};

export const setViewAs = (email) => {
  try {
    if (email) localStorage.setItem(KEY, email);
    else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: falls back to your own data */ }
};

let installed = false;

export function installViewAsFetch(apiBase) {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    const viewAs = getViewAs();
    if (!viewAs || !url.startsWith(apiBase)) return original(input, init);
    const headers = new Headers(init.headers || (typeof input !== 'string' ? input.headers : undefined));
    headers.set('X-View-As', viewAs);
    return original(input, { ...init, headers });
  };
}
