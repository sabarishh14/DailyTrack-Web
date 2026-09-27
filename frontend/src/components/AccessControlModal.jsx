import { useState, useEffect, useMemo, useCallback } from "react";

import { API } from '../constants';
import { getToken } from '../utils';

// Admin-only people & permissions manager. Rules live in ACCESS_CONTROL.md
// and are enforced by backend/access.py; this is just the editor.

const MODULES = [
  { id: 'money', icon: '💰', label: 'Money', desc: 'Transactions, budgets, splits & the Add page' },
  { id: 'gym', icon: '🌱', label: 'Routines & Gym', desc: 'Their own routines on the phone, and the gym log' },
  { id: 'invest', icon: '📈', label: 'Investments', desc: 'Portfolio, holdings & manual assets' },
  { id: 'sabdekho', icon: '📺', label: 'SabDekho', desc: 'Movies, shows & watch diary' },
];

const LEVELS = [
  { id: 'none', label: 'None', hint: 'Hidden' },
  { id: 'view', label: 'View', hint: 'Read only' },
  { id: 'edit', label: 'Edit', hint: 'Add, change & delete' },
];

const PRESETS = [
  { id: 'view', label: 'View everything', level: 'view' },
  { id: 'edit', label: 'Edit everything', level: 'edit' },
  { id: 'none', label: 'Clear all', level: 'none' },
];

const blankPermissions = (level = 'view') => ({
  modules: Object.fromEntries(MODULES.map(m => [m.id, level])),
  money_scope: { categories: null, accounts: null },
});

const authHeaders = (json = false) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'Authorization': `Bearer ${getToken()}`,
});

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];
const avatarColor = (email) => AVATAR_COLORS[[...email].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

function Avatar({ email }) {
  return <div className="ac-avatar" style={{ background: avatarColor(email) }}>{email.charAt(0).toUpperCase()}</div>;
}

function RoleBadge({ role, legacy }) {
  if (legacy) return <span className="ac-badge legacy" title="Added before access control. Has full edit access until you review it.">Legacy · full</span>;
  return <span className={`ac-badge ${role}`}>{role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member'}</span>;
}

function Segmented({ value, options, onChange, size }) {
  return (
    <div className={`ac-seg ${size || ''}`} role="radiogroup">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`ac-seg-btn ${value === o.id ? 'active' : ''} level-${o.id}`}
          onClick={() => onChange(o.id)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <button type="button" className="ac-switch-row" onClick={() => onChange(!checked)} aria-pressed={checked}>
      <span>{label}</span>
      <span className={`toggle-switch ${checked ? 'active' : ''}`}><span className="toggle-knob" /></span>
    </button>
  );
}

// "All" switch + searchable chip picker. null = everything.
function ScopePicker({ title, noun, options, value, onChange }) {
  const [query, setQuery] = useState('');
  const all = value === null;
  const selected = new Set(value || []);
  const filtered = options.filter(o => o.toLowerCase().includes(query.toLowerCase()));

  const toggle = (opt) => {
    const next = new Set(selected);
    next.has(opt) ? next.delete(opt) : next.add(opt);
    onChange([...next].sort());
  };

  return (
    <div className="ac-scope">
      <div className="ac-scope-head">
        <div>
          <div className="ac-scope-title">{title}</div>
          <div className="ac-scope-sub">{all ? `Every ${noun}, including new ones` : `${selected.size} of ${options.length} selected`}</div>
        </div>
        <Switch checked={all} onChange={(on) => onChange(on ? null : [])} label={`All ${noun}s`} />
      </div>
      {!all && (
        <>
          {options.length > 8 && (
            <input className="inp ac-scope-search" placeholder={`Search ${noun}s…`} value={query} onChange={e => setQuery(e.target.value)} />
          )}
          <div className="ac-chips">
            {filtered.map(opt => (
              <button key={opt} type="button" className={`ac-chip ${selected.has(opt) ? 'on' : ''}`} onClick={() => toggle(opt)}>
                {selected.has(opt) && <span aria-hidden="true">✓ </span>}{opt}
              </button>
            ))}
            {filtered.length === 0 && <span className="ac-muted">No matches</span>}
          </div>
          <div className="ac-scope-actions">
            <button type="button" className="ac-link" onClick={() => onChange([...options].sort())}>Select all</button>
            <button type="button" className="ac-link" onClick={() => onChange([])}>Clear</button>
          </div>
          {selected.size === 0 && <div className="ac-warn">No {noun}s selected, so no transactions will be visible.</div>}
        </>
      )}
    </div>
  );
}

function summarize(user) {
  if (user.role === 'admin') return 'Full access to everything · manages people';
  const mods = user.permissions?.modules || {};
  const parts = MODULES.filter(m => mods[m.id] && mods[m.id] !== 'none').map(m => `${m.icon} ${mods[m.id] === 'edit' ? 'Edit' : 'View'}`);
  return parts.length ? parts.join('  ·  ') : 'No pages shared yet';
}

function scopeSummary(user) {
  if (user.role === 'admin') return null;
  const mods = user.permissions?.modules || {};
  const scope = user.permissions?.money_scope || {};
  if (!mods.money || mods.money === 'none') return null;
  const bits = [];
  if (scope.categories) bits.push(`${scope.categories.length} categor${scope.categories.length === 1 ? 'y' : 'ies'}`);
  if (scope.accounts) bits.push(`${scope.accounts.length} account${scope.accounts.length === 1 ? '' : 's'}`);
  return bits.length ? `Money limited to ${bits.join(' & ')}` : null;
}

export default function AccessControlModal({ onClose, currentEmail }) {
  const [users, setUsers] = useState([]);
  const [owners, setOwners] = useState([]);
  const [options, setOptions] = useState({ categories: [], accounts: [] });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(null); // { email, role, permissions, isNew, legacy }
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [u, o] = await Promise.all([
        fetch(`${API}/admin/users`, { headers: authHeaders() }).then(r => r.json()),
        fetch(`${API}/admin/access-options`, { headers: authHeaders() }).then(r => r.json()),
      ]);
      if (!u.success) throw new Error(u.message || 'Could not load people');
      setUsers(u.users);
      setOwners(u.owners);
      if (o.success) setOptions({ categories: o.categories, accounts: o.accounts });
    } catch (e) {
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  // Esc closes the editor first, then the modal.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (draft) setDraft(null); else onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [draft, onClose]);

  const openEditor = (user) => {
    setError(''); setConfirmRemove(false);
    setDraft({
      email: user.email,
      role: user.role,
      legacy: user.legacy,
      isNew: false,
      permissions: JSON.parse(JSON.stringify(user.permissions)),
    });
  };

  const startAdd = () => {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email address'); return; }
    if (owners.includes(email) || users.some(u => u.email.toLowerCase() === email)) {
      const existing = users.find(u => u.email.toLowerCase() === email);
      if (existing) openEditor(existing);
      else setError(`${email} is an owner and already has full access`);
      return;
    }
    setError(''); setConfirmRemove(false);
    setDraft({ email, role: 'member', legacy: false, isNew: true, permissions: blankPermissions('view') });
    setNewEmail('');
  };

  const setModule = (id, level) => setDraft(d => ({ ...d, permissions: { ...d.permissions, modules: { ...d.permissions.modules, [id]: level } } }));
  const setScope = (key, value) => setDraft(d => ({ ...d, permissions: { ...d.permissions, money_scope: { ...d.permissions.money_scope, [key]: value } } }));
  const applyPreset = (level) => setDraft(d => ({ ...d, permissions: { ...d.permissions, modules: blankPermissions(level).modules } }));

  const save = async () => {
    setSaving(true); setError('');
    try {
      const url = draft.isNew ? `${API}/admin/users` : `${API}/admin/users/${encodeURIComponent(draft.email)}`;
      const res = await fetch(url, {
        method: draft.isNew ? 'POST' : 'PUT',
        headers: authHeaders(true),
        body: JSON.stringify({ email: draft.email, role: draft.role, permissions: draft.permissions }),
      }).then(r => r.json());
      if (!res.success) throw new Error(res.message || 'Could not save');
      setToast(draft.isNew ? `${draft.email} can now sign in` : `Saved. ${draft.email} gets the new access within a minute.`);
      setDraft(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(draft.email)}`, { method: 'DELETE', headers: authHeaders() }).then(r => r.json());
      if (!res.success) throw new Error(res.message || 'Could not remove');
      setToast(`${draft.email} was removed and will be signed out within a minute.`);
      setDraft(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? users.filter(u => u.email.toLowerCase().includes(q)) : users;
  }, [users, query]);

  const isSelf = draft && currentEmail && draft.email.toLowerCase() === currentEmail.toLowerCase();
  const moneyLevel = draft?.permissions.modules.money || 'none';

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content ac-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Access control">
        <div className="modal-header ac-header">
          {draft ? (
            <button className="ac-back" onClick={() => setDraft(null)} aria-label="Back to people">‹</button>
          ) : (
            <div className="ac-header-icon">🛡️</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title ac-title">{draft ? (draft.isNew ? 'Add person' : 'Edit access') : 'Access Control'}</div>
            <div className="ac-subtitle">
              {draft ? draft.email : `${owners.length + users.length} ${owners.length + users.length === 1 ? 'person' : 'people'} can sign in`}
            </div>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        {toast && <div className="ac-toast">✓ {toast}</div>}

        {!draft ? (
          <div className="ac-body">
            <div className="ac-add">
              <input
                className="inp"
                type="email"
                placeholder="Add someone by email"
                value={newEmail}
                onChange={e => { setNewEmail(e.target.value); setError(''); }}
                onKeyDown={e => e.key === 'Enter' && startAdd()}
              />
              <button className="action-btn" onClick={startAdd} disabled={!newEmail.trim()}>Add</button>
            </div>
            {error && <div className="ac-error">{error}</div>}

            {users.length > 5 && (
              <input className="inp ac-filter" placeholder="Filter people…" value={query} onChange={e => setQuery(e.target.value)} />
            )}

            {loading ? (
              <div className="ac-loading">
                {[0, 1, 2].map(i => <div key={i} className="ac-skeleton" />)}
              </div>
            ) : loadError ? (
              <div className="ac-error">Couldn't load people: {loadError} <button className="ac-link" onClick={load}>Retry</button></div>
            ) : (
              <>
                <div className="ac-section-label">Owners</div>
                {owners.map(email => (
                  <div key={email} className="ac-user static">
                    <Avatar email={email} />
                    <div className="ac-user-main">
                      <div className="ac-user-email">{email}{currentEmail === email && <span className="ac-you">you</span>}</div>
                      <div className="ac-user-sub">Permanent · full access to everything</div>
                    </div>
                    <RoleBadge role="owner" />
                  </div>
                ))}

                <div className="ac-section-label">People</div>
                {visibleUsers.length === 0 && (
                  <div className="ac-empty">{users.length === 0 ? 'Nobody else has access yet. Add someone above.' : 'No one matches that filter.'}</div>
                )}
                {visibleUsers.map(u => (
                  <button key={u.email} className="ac-user" onClick={() => openEditor(u)}>
                    <Avatar email={u.email} />
                    <div className="ac-user-main">
                      <div className="ac-user-email">{u.email}{currentEmail === u.email && <span className="ac-you">you</span>}</div>
                      <div className="ac-user-sub">{summarize(u)}</div>
                      {scopeSummary(u) && <div className="ac-user-scope">🔎 {scopeSummary(u)}</div>}
                    </div>
                    <RoleBadge role={u.role} legacy={u.legacy} />
                    <span className="ac-chevron">›</span>
                  </button>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="ac-body">
              {draft.legacy && (
                <div className="ac-note warn">This person was added before access control and still has full edit access. Pick what they should have and save.</div>
              )}
              {isSelf && (
                <div className="ac-note warn">You're editing your own access. If you remove your admin role you won't be able to come back here.</div>
              )}

              <div className="ac-field">
                <div className="ac-field-label">Role</div>
                <Segmented
                  value={draft.role}
                  onChange={(role) => setDraft(d => ({ ...d, role }))}
                  options={[{ id: 'member', label: 'Member', hint: 'Only what you allow below' }, { id: 'admin', label: 'Admin', hint: 'Everything, plus managing people' }]}
                />
              </div>

              {draft.role === 'admin' ? (
                <div className="ac-note">Admins can see and change everything, manage who has access, and use Nagapandi AI. Owners stay permanent and can't be changed by admins.</div>
              ) : (
                <>
                  <div className="ac-field">
                    <div className="ac-field-row">
                      <div className="ac-field-label">Pages</div>
                      <div className="ac-presets">
                        {PRESETS.map(p => <button key={p.id} type="button" className="ac-link" onClick={() => applyPreset(p.level)}>{p.label}</button>)}
                      </div>
                    </div>
                    <div className="ac-modules">
                      {MODULES.map(m => (
                        <div key={m.id} className={`ac-module level-${draft.permissions.modules[m.id]}`}>
                          <div className="ac-module-icon">{m.icon}</div>
                          <div className="ac-module-text">
                            <div className="ac-module-name">{m.label}</div>
                            <div className="ac-module-desc">{m.desc}</div>
                          </div>
                          <Segmented size="sm" value={draft.permissions.modules[m.id]} options={LEVELS} onChange={(lvl) => setModule(m.id, lvl)} />
                        </div>
                      ))}
                    </div>
                  </div>

                  {moneyLevel !== 'none' && (
                    <div className="ac-field">
                      <div className="ac-field-label">Money scope</div>
                      <div className="ac-field-help">Limit which transactions they see. Totals, charts and budgets only count what they can see.</div>
                      <ScopePicker title="Categories" noun="category" options={options.categories} value={draft.permissions.money_scope.categories} onChange={(v) => setScope('categories', v)} />
                      <ScopePicker title="Accounts" noun="account" options={options.accounts} value={draft.permissions.money_scope.accounts} onChange={(v) => setScope('accounts', v)} />
                      {draft.permissions.money_scope.categories !== null && (
                        <div className="ac-note">🙈 Account balances and net worth are hidden while categories are limited, because a balance includes every category.</div>
                      )}
                      {(draft.permissions.money_scope.categories !== null || draft.permissions.money_scope.accounts !== null) && moneyLevel === 'edit' && (
                        <div className="ac-note">They can only add or edit transactions inside this scope. Syncing to Sheets and changing balances stays with full-access users.</div>
                      )}
                    </div>
                  )}
                </>
              )}
              {error && <div className="ac-error">{error}</div>}
            </div>

            <div className="ac-footer">
              {!draft.isNew && (
                <button className={`ac-danger ${confirmRemove ? 'confirm' : ''}`} onClick={remove} disabled={saving}>
                  {confirmRemove ? 'Tap again to remove' : 'Remove access'}
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button className="action-btn secondary" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
              <button className="action-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : draft.isNew ? 'Add person' : 'Save changes'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
