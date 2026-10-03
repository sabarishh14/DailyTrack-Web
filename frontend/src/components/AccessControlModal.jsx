import { useState, useEffect, useMemo, useCallback } from "react";

import { API } from '../constants';
import { getToken } from '../utils';

// Admin-only: who can sign in. Everyone who can has their own, separate data,
// so there's nothing to share here. Rules live in ACCESS_CONTROL.md and are
// enforced by backend/access.py.

const ROLES = [
  { id: 'member', label: 'Member', hint: 'Their own data' },
  { id: 'admin', label: 'Admin', hint: 'Their own data, and manages people' },
];

const authHeaders = (json = false) => ({
  ...(json ? { 'Content-Type': 'application/json' } : {}),
  'Authorization': `Bearer ${getToken()}`,
});

const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6', '#14b8a6', '#f43f5e'];
const avatarColor = (email) => AVATAR_COLORS[[...email].reduce((h, c) => h + c.charCodeAt(0), 0) % AVATAR_COLORS.length];

function Avatar({ email }) {
  return <div className="ac-avatar" style={{ background: avatarColor(email) }}>{email.charAt(0).toUpperCase()}</div>;
}

function RoleBadge({ role }) {
  return <span className={`ac-badge ${role}`}>{role === 'owner' ? 'Owner' : role === 'admin' ? 'Admin' : 'Member'}</span>;
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="ac-seg" role="radiogroup">
      {options.map(o => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={`ac-seg-btn ${value === o.id ? 'active' : ''}`}
          onClick={() => onChange(o.id)}
          title={o.hint}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function AccessControlModal({ onClose, currentEmail }) {
  const [users, setUsers] = useState([]);
  const [owners, setOwners] = useState([]);
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState(null); // { email, role }
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const u = await fetch(`${API}/admin/users`, { headers: authHeaders() }).then(r => r.json());
      if (!u.success) throw new Error(u.message || 'Could not load people');
      setUsers(u.users);
      setOwners(u.owners);
      setRequests(u.requests || []);
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
    setDraft({ email: user.email, role: user.role === 'admin' ? 'admin' : 'member' });
  };

  const add = async () => {
    const email = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setError('Enter a valid email address'); return; }
    if (owners.includes(email)) { setError(`${email} is an owner`); return; }
    const existing = users.find(u => u.email.toLowerCase() === email);
    if (existing) { openEditor(existing); setNewEmail(''); return; }
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/admin/users`, {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ email, role: 'member' }),
      }).then(r => r.json());
      if (!res.success) throw new Error(res.message || 'Could not add');
      setToast(`${email} can now sign in`);
      setNewEmail('');
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/admin/users/${encodeURIComponent(draft.email)}`, {
        method: 'PUT', headers: authHeaders(true), body: JSON.stringify({ email: draft.email, role: draft.role }),
      }).then(r => r.json());
      if (!res.success) throw new Error(res.message || 'Could not save');
      setToast('Saved');
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
      setToast(`${draft.email} was removed`);
      setDraft(null);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  /** Approve lets them sign in as a member; decline just clears the request. */
  const answer = async (email, approve) => {
    setRequests(list => list.filter(r => r.email !== email));
    try {
      const res = await fetch(`${API}/admin/requests/${encodeURIComponent(email)}${approve ? '/approve' : ''}`, {
        method: approve ? 'POST' : 'DELETE', headers: authHeaders(),
      }).then(r => r.json());
      if (!res.success) throw new Error(res.message || 'Could not save');
      setToast(approve ? `${email} can now sign in` : 'Request declined');
      load();
    } catch (e) {
      setError(e.message);
      load();
    }
  };

  const visibleUsers = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? users.filter(u => u.email.toLowerCase().includes(q)) : users;
  }, [users, query]);

  const isSelf = draft && currentEmail && draft.email.toLowerCase() === currentEmail.toLowerCase();
  const total = owners.length + users.length;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content ac-modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="People">
        <div className="modal-header ac-header">
          {draft ? (
            <button className="ac-back" onClick={() => setDraft(null)} aria-label="Back to people">‹</button>
          ) : (
            <div className="ac-header-icon">🛡️</div>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="modal-title ac-title">{draft ? draft.email : 'People'}</div>
            <div className="ac-subtitle">
              {draft ? 'Role' : `${total} ${total === 1 ? 'person' : 'people'} can sign in`}
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
                onKeyDown={e => e.key === 'Enter' && add()}
              />
              <button className="action-btn" onClick={add} disabled={!newEmail.trim() || saving}>Add</button>
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
                {requests.length > 0 && (
                  <>
                    <div className="ac-section-label">Requests</div>
                    {requests.map(r => (
                      <div key={r.email} className="ac-user static">
                        <Avatar email={r.email} />
                        <div className="ac-user-main">
                          <div className="ac-user-email">{r.email}</div>
                          {r.name && <div className="ac-user-sub">{r.name}</div>}
                        </div>
                        <button className="action-btn secondary ac-req-btn" onClick={() => answer(r.email, false)}>Decline</button>
                        <button className="action-btn ac-req-btn" onClick={() => answer(r.email, true)}>Approve</button>
                      </div>
                    ))}
                  </>
                )}

                <div className="ac-section-label">Owners</div>
                {owners.map(email => (
                  <div key={email} className="ac-user static">
                    <Avatar email={email} />
                    <div className="ac-user-main">
                      <div className="ac-user-email">{email}{currentEmail === email && <span className="ac-you">you</span>}</div>
                    </div>
                    <RoleBadge role="owner" />
                  </div>
                ))}

                <div className="ac-section-label">People</div>
                {visibleUsers.length === 0 && (
                  <div className="ac-empty">{users.length === 0 ? 'Nobody else yet' : 'No one matches'}</div>
                )}
                {visibleUsers.map(u => (
                  <button key={u.email} className="ac-user" onClick={() => openEditor(u)}>
                    <Avatar email={u.email} />
                    <div className="ac-user-main">
                      <div className="ac-user-email">{u.email}{currentEmail === u.email && <span className="ac-you">you</span>}</div>
                    </div>
                    <RoleBadge role={u.role === 'admin' ? 'admin' : 'member'} />
                    <span className="ac-chevron">›</span>
                  </button>
                ))}
              </>
            )}
          </div>
        ) : (
          <>
            <div className="ac-body">
              <div className="ac-field">
                <Segmented value={draft.role} options={ROLES} onChange={(role) => setDraft(d => ({ ...d, role }))} />
              </div>
              <div className="ac-note">
                {draft.role === 'admin' ? 'Can add and remove people. Never sees anyone else’s data.' : 'Uses DailyTrack with their own data.'}
              </div>
              {isSelf && draft.role !== 'admin' && (
                <div className="ac-note warn">You won't be able to come back here.</div>
              )}
              {error && <div className="ac-error">{error}</div>}
            </div>

            <div className="ac-footer">
              <button className={`ac-danger ${confirmRemove ? 'confirm' : ''}`} onClick={remove} disabled={saving}>
                {confirmRemove ? 'Tap again to remove' : 'Remove'}
              </button>
              <div style={{ flex: 1 }} />
              <button className="action-btn secondary" onClick={() => setDraft(null)} disabled={saving}>Cancel</button>
              <button className="action-btn" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
