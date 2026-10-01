import { createContext, useContext, useMemo } from 'react';

// Mirrors backend/access.py — see ACCESS_CONTROL.md. The backend is the real
// gate; this only decides what the UI shows so people don't hit dead ends.
const LEVELS = { none: 0, view: 1, edit: 2 };

const STORAGE_KEY = 'dt_access';

export const loadStoredAccess = () => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || null; } catch { return null; }
};

export const storeAccess = (access) => {
  try {
    if (access) localStorage.setItem(STORAGE_KEY, JSON.stringify(access));
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* storage unavailable: access is re-fetched on load anyway */ }
};

// What one person leaves in this browser that the next person mustn't inherit.
const PERSONAL_KEYS = ['dt_draft_txs', 'dt_inv_pin', 'dt_inv_hidden_cats', 'dt_lbx_username'];
const LAST_USER_KEY = 'dt_last_user';

/** Once the signed-in email is known: someone other than last time starts clean. */
export const claimBrowserFor = (email) => {
  if (!email) return;
  try {
    const last = localStorage.getItem(LAST_USER_KEY);
    if (last && last !== email) PERSONAL_KEYS.forEach(k => localStorage.removeItem(k));
    localStorage.setItem(LAST_USER_KEY, email);
  } catch { /* storage unavailable: nothing was kept either */ }
};

export const buildAccess = (raw) => {
  const a = raw || {};
  const modules = a.modules || {};
  const money = a.money || {};
  const can = (module, level = 'view') => (LEVELS[modules[module]] || 0) >= LEVELS[level];
  return {
    raw: a,
    email: a.email || '',
    role: a.role || 'member',
    isAdmin: !!a.isAdmin,
    isOwner: !!a.isOwner,
    can,
    money: {
      categories: money.categories ?? null,
      accounts: money.accounts ?? null,
      restricted: !!money.restricted,
      balancesVisible: !!money.balancesVisible,
      fullAccess: !!money.fullAccess,
    },
  };
};

const AccessContext = createContext(buildAccess(null));

export function AccessProvider({ access, children }) {
  const value = useMemo(() => buildAccess(access), [access]);
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

export const useAccess = () => useContext(AccessContext);

// Which app tab needs which module. Home (0) is always available and trims its
// own sections instead.
export const TAB_REQUIREMENTS = {
  1: ['money', 'view'],
  2: ['money', 'edit'],
  3: ['gym', 'view'],
  4: ['invest', 'view'],
  5: ['sabdekho', 'view'],
};

export const canOpenTab = (access, tabId) => {
  const req = TAB_REQUIREMENTS[tabId];
  return !req || access.can(req[0], req[1]);
};
