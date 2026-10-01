import { useEffect, useMemo, useRef, useState } from 'react';
import { ACCENT_PALETTES } from '../constants';
import { useAccess } from '../access/AccessContext';
import { apiGet, apiPost, useMoneyMeta, EMPTY_META } from '../api/money';
import { API } from '../constants';
import { accountColor, fmt, getBankEmoji, getToken, isCcAccount } from '../utils';
import { MinBalanceChip } from '../components/BalanceImpact';
import ReconciliationModal from '../components/ReconciliationModal';
import BudgetManagerModal from '../components/BudgetManagerModal';
import CategoryExclusionModal from '../components/CategoryExclusionModal';
import AddAccountModal from './settings-components/AddAccountModal';

// Everything you can set on the web, in one place. [keywords] feed the search box.
const SECTIONS = [
  {
    id: 'accounts', icon: '🏦', title: 'Accounts', desc: 'Savings accounts and credit cards',
    keywords: 'bank banks savings credit card cards cc minimum min balance add new account',
    show: (a) => a.money.fullAccess,
  },
  {
    id: 'appearance', icon: '🎨', title: 'Appearance', desc: 'Theme and accent colour',
    keywords: 'theme dark light mode accent colour color palette look',
    show: () => true,
  },
  {
    id: 'money', icon: '💸', title: 'Money', desc: 'Budgets and hidden categories',
    keywords: 'budget budgets limits hidden categories exclude analytics',
    show: (a) => a.can('money', 'edit') && !a.isOwner,
  },
  {
    id: 'money', icon: '💸', title: 'Money & sync', desc: 'Google Sheets, reconciling, budgets and hidden categories',
    keywords: 'google sheets sheet sync balances transactions send reconcile budget budgets limits hidden categories exclude analytics',
    show: (a) => a.isOwner,
  },
  {
    id: 'sabdekho', icon: '🎬', title: 'SabDekho', desc: 'Films and Letterboxd',
    keywords: 'movies films letterboxd rss diary tv shows sabdekho',
    show: (a) => a.can('sabdekho'),
  },
  {
    id: 'nagapandi', icon: '✨', title: 'Nagapandi', desc: 'Your AI assistant',
    keywords: 'ai chat assistant nagapandi ask',
    show: (a) => a.isOwner,
  },
  {
    id: 'access', icon: '🛡️', title: 'People', desc: 'Who can sign in',
    keywords: 'access control people users invite admin roles email sign in',
    show: (a) => a.isAdmin,
  },
  {
    id: 'about', icon: 'ℹ️', title: 'About', desc: 'Version and signing out',
    keywords: 'version build about sign out logout log out email',
    show: () => true,
  },
];

const ROLE_LABELS = { owner: 'Owner', admin: 'Admin', member: 'Member', service: 'Service' };
const roleLabel = (role) => ROLE_LABELS[role] || role;

export default function SettingsPage(props) {
  const access = useAccess();
  const [query, setQuery] = useState('');
  const [toast, setToast] = useState('');
  const sections = useMemo(() => SECTIONS.filter(s => s.show(access)), [access]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sections;
    return sections.filter(s => `${s.title} ${s.desc} ${s.keywords}`.toLowerCase().includes(q));
  }, [sections, query]);
  const [active, setActive] = useState(null);
  const rootRef = useRef(null);
  const navRef = useRef(null);

  // The nav follows the section being read; the last one wins once the page is scrolled to the end.
  useEffect(() => {
    const scroller = rootRef.current?.closest('.page-body');
    if (!scroller) return undefined;
    const spy = () => {
      const els = shown.map(s => document.getElementById(`st-${s.id}`)).filter(Boolean);
      if (!els.length) return;
      const top = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.35;
      const atEnd = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
      let current = els[0];
      for (const el of els) if (el.getBoundingClientRect().top <= top) current = el;
      if (atEnd) current = els[els.length - 1];
      setActive(current.id.slice(3));
    };
    spy();
    scroller.addEventListener('scroll', spy, { passive: true });
    return () => scroller.removeEventListener('scroll', spy);
  }, [shown]);

  // On a phone the nav is a row of chips: keep the current one in view. Only the row scrolls.
  useEffect(() => {
    const list = navRef.current;
    const chip = list?.querySelector('.st-nav-item.on');
    if (!chip || list.scrollWidth <= list.clientWidth) return;
    const offset = chip.getBoundingClientRect().left - list.getBoundingClientRect().left;
    list.scrollTo({ left: list.scrollLeft + offset - (list.clientWidth - chip.offsetWidth) / 2, behavior: 'smooth' });
  }, [active]);

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const jump = (id) => {
    document.getElementById(`st-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="st-page" ref={rootRef}>
      <Profile access={access} onLogout={props.logout} />

      <div className="st-layout">
        <aside className="st-nav">
          <label className="st-search">
            <span aria-hidden="true">🔍</span>
            <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search settings" aria-label="Search settings" />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="Clear search">×</button>}
          </label>
          <nav className="st-nav-list" aria-label="Settings sections" ref={navRef}>
            {shown.map(s => (
              <button
                key={s.id}
                className={`st-nav-item ${active === s.id ? 'on' : ''}`}
                aria-current={active === s.id ? 'true' : undefined}
                onClick={() => jump(s.id)}
              >
                <span className="st-nav-icon">{s.icon}</span>
                <span>{s.title}</span>
              </button>
            ))}
          </nav>
        </aside>

        <div className="st-content">
          {shown.length === 0 && (
            <div className="st-card st-empty">
              <span>🔎</span>
              No settings match “{query}”.
            </div>
          )}
          {shown.map(s => (
            <section key={s.id} id={`st-${s.id}`} className="st-section">
              <header className="st-section-head">
                <span className="st-section-icon">{s.icon}</span>
                <div>
                  <h2>{s.title}</h2>
                  <p>{s.desc}</p>
                </div>
              </header>
              {s.id === 'accounts' && <AccountsSection accounts={props.accounts} onRefresh={props.onRefresh} onToast={setToast} />}
              {s.id === 'appearance' && <AppearanceSection {...props} />}
              {s.id === 'money' && <MoneySection {...props} full={access.isOwner} onToast={setToast} />}
              {s.id === 'sabdekho' && <SabDekhoSection {...props} canSync={access.can('sabdekho', 'edit')} />}
              {s.id === 'nagapandi' && <NagapandiSection {...props} />}
              {s.id === 'access' && <AccessSection onOpen={props.onOpenAccessControl} />}
              {s.id === 'about' && <AboutSection access={access} onLogout={props.logout} />}
            </section>
          ))}
        </div>
      </div>

      {toast && <div className="rt-toast st-toast" role="status" onClick={() => setToast('')}>{toast}</div>}
    </div>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Profile({ access, onLogout }) {
  const email = access.email || 'Signed in';
  return (
    <div className="st-profile">
      <span className="st-avatar">{(email[0] || '?').toUpperCase()}</span>
      <div className="st-profile-text">
        <span className="st-kicker">Signed in as</span>
        <b>{email}</b>
        <span className="st-role">{roleLabel(access.role)}</span>
      </div>
      <button className="st-profile-out" onClick={() => onLogout()}>Sign out</button>
    </div>
  );
}

function Row({ icon, title, desc, children, status }) {
  return (
    <div className="st-row">
      <span className="st-row-icon">{icon}</span>
      <div className="st-row-text">
        <b>{title}</b>
        {desc && <span>{desc}</span>}
        {status && <span className={`st-status ${status.kind || ''}`}>{status.text}</span>}
      </div>
      {children && <div className="st-row-action">{children}</div>}
    </div>
  );
}

function Toggle({ on, onChange, label }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} className="st-toggle" onClick={onChange}>
      <span className={`toggle-switch ${on ? 'active' : ''}`}><span className="toggle-knob" /></span>
    </button>
  );
}

// ── Accounts ─────────────────────────────────────────────────────────────────

function AccountsSection({ accounts = [], onRefresh, onToast }) {
  const [adding, setAdding] = useState(false);
  const byName = (a, b) => a.account.localeCompare(b.account);
  const savings = accounts.filter(a => !isCcAccount(a.account)).sort(byName);
  const cards = accounts.filter(a => isCcAccount(a.account)).sort(byName);
  const total = savings.filter(a => a.balance_tracked).reduce((sum, a) => sum + (a.balance || 0), 0);
  const names = useMemo(() => new Set(accounts.map(a => a.account.toLowerCase())), [accounts]);

  return (
    <div className="st-card">
      <div className="st-acc-summary">
        <div className="st-acc-total">
          <span className="st-kicker">In your savings</span>
          <b>{fmt(total)}</b>
          <span className="st-muted">
            {savings.length} {savings.length === 1 ? 'account' : 'accounts'} · {cards.length} {cards.length === 1 ? 'card' : 'cards'}
          </span>
        </div>
        <button className="action-btn" onClick={() => setAdding(true)}>＋ Add account</button>
      </div>

      <div className="st-subhead">Savings accounts</div>
      <div className="st-list">
        {savings.length === 0 && <div className="st-muted st-pad">No savings accounts yet.</div>}
        {savings.map(a => (
          <div key={a.account} className="st-acc-row" style={{ '--acc': accountColor(a.account) || 'var(--accent)' }}>
            <span className="st-acc-badge">{getBankEmoji(a.account)}</span>
            <div className="st-acc-text">
              <b>{a.account}</b>
              {a.balance_tracked
                ? <MinBalanceChip account={a.account} min={a.min_balance} editable onSaved={onRefresh} />
                : <span className="st-muted">Balance not tracked</span>}
            </div>
            {a.balance_tracked && <BalanceEdit account={a} onSaved={onRefresh} onToast={onToast} />}
          </div>
        ))}
      </div>

      <div className="st-subhead">Credit cards</div>
      <div className="st-list">
        {cards.length === 0 && <div className="st-muted st-pad">No credit cards yet.</div>}
        {cards.map(a => (
          <div key={a.account} className="st-acc-row" style={{ '--acc': accountColor(a.account) }}>
            <span className="st-acc-badge">💳</span>
            <div className="st-acc-text">
              <b>{a.account}</b>
              <span className="st-muted">Credit card</span>
            </div>
          </div>
        ))}
      </div>

      {adding && (
        <AddAccountModal
          existingNames={names}
          onClose={() => setAdding(false)}
          onAdded={(account) => {
            setAdding(false);
            onToast(`✅ ${account.account} added`);
            onRefresh();
          }}
        />
      )}
    </div>
  );
}

/** A savings account's balance: tap to set it to what the bank shows. */
function BalanceEdit({ account, onSaved, onToast }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const start = () => { setValue(String(account.balance ?? 0)); setEditing(true); };
  const save = async () => {
    const n = Number(String(value).trim());
    if (!String(value).trim() || !Number.isFinite(n)) return;
    if (n === Number(account.balance ?? 0)) { setEditing(false); return; }
    setSaving(true);
    try {
      const res = await fetch(`${API}/accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ account: account.account, balance: n }),
      });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setEditing(false);
      onToast(`✅ ${account.account} set to ${fmt(n)}`);
      onSaved();
    } catch (e) {
      onToast(`Couldn't save: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <button className="st-acc-balance st-balance-btn" onClick={start} title="Edit balance">
        {fmt(account.balance || 0)}
      </button>
    );
  }
  return (
    <span className="st-balance-edit">
      <span>₹</span>
      <input
        autoFocus inputMode="decimal" value={value} disabled={saving}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
        onBlur={() => { if (!saving) setEditing(false); }}
      />
      <button onMouseDown={e => e.preventDefault()} onClick={save} disabled={saving} aria-label="Save">{saving ? '…' : '✓'}</button>
    </span>
  );
}

// ── Appearance ───────────────────────────────────────────────────────────────

function AppearanceSection({ theme, setTheme, accent, setAccent }) {
  return (
    <div className="st-card">
      <div className="st-subhead first">Theme</div>
      <div className="st-theme-grid">
        {[['dark', '🌙', 'Dark'], ['light', '☀️', 'Light']].map(([id, icon, label]) => (
          <button key={id} className={`st-theme ${id} ${theme === id ? 'on' : ''}`} onClick={() => setTheme(id)} aria-pressed={theme === id}>
            <span className="st-theme-preview" aria-hidden="true">
              <i className="side" /><i className="hero" /><i className="row" /><i className="row short" />
            </span>
            <span className="st-theme-label">
              <span>{icon} {label}</span>
              <span className="st-check" aria-hidden="true">✓</span>
            </span>
          </button>
        ))}
      </div>

      <div className="st-subhead">Accent colour</div>
      <div className="st-accents">
        {ACCENT_PALETTES.map(p => (
          <button
            key={p.id}
            className={`st-accent ${accent === p.id ? 'on' : ''}`}
            style={{ '--swatch': p.color }}
            onClick={() => setAccent(p.id)}
            aria-pressed={accent === p.id}
          >
            <span className="st-accent-dot">{accent === p.id ? '✓' : ''}</span>
            <span>{p.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Money & sync ─────────────────────────────────────────────────────────────

function MoneySection({ accounts = [], budgets = [], refreshBudgets, onRefresh, dataVersion, full, onToast }) {
  const meta = useMoneyMeta(dataVersion).data || EMPTY_META;
  const [pending, setPending] = useState(null);
  const [balanceSync, setBalanceSync] = useState({ busy: false, status: null });
  const [txSync, setTxSync] = useState({ busy: false, status: null });
  const [open, setOpen] = useState(null); // 'reconcile' | 'budgets' | 'categories'

  const checkPending = () => {
    if (!full) return;
    apiGet('/sync/check-transactions').then(r => { if (r.success) setPending(r.count); }).catch(() => {});
  };
  useEffect(checkPending, [full, dataVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncBalances = async () => {
    setBalanceSync({ busy: true, status: { text: 'Reading the Sheet…' } });
    try {
      const res = await apiPost('/sync/sheet-balances', {});
      if (!res.success) throw new Error(res.message || 'Sheet sync failed');
      await onRefresh();
      setBalanceSync({ busy: false, status: { kind: 'ok', text: `Updated ${res.updated} ${res.updated === 1 ? 'account' : 'accounts'}` } });
    } catch (e) {
      setBalanceSync({ busy: false, status: { kind: 'error', text: e.message } });
    }
  };

  const sendToSheets = async () => {
    const total = pending || 0;
    let sent = 0;
    setTxSync({ busy: true, status: { text: `Sending 0 of ${total}…`, progress: 0 } });
    try {
      for (let more = true; more;) {
        const res = await apiPost('/sync/db-to-sheets', {});
        if (!res.success) throw new Error(res.message || 'Sending failed');
        sent += res.synced_count || 0;
        more = res.has_more;
        setTxSync({ busy: true, status: { text: `Sending ${sent} of ${total}…`, progress: total ? sent / total : 0 } });
      }
      setTxSync({ busy: false, status: { kind: 'ok', text: `Sent ${sent} ${sent === 1 ? 'transaction' : 'transactions'}` } });
      onToast(`✅ Sent ${sent} to Google Sheets`);
    } catch (e) {
      setTxSync({ busy: false, status: { kind: 'error', text: `${e.message}${sent ? ` (after sending ${sent})` : ''}` } });
    }
    checkPending();
  };

  const excluded = meta.excluded_headings.length;

  return (
    <div className="st-card st-rows">
      {full && (
        <>
          <Row
            icon="📥" title="Balances from Google Sheet"
            desc="Pull each bank's real balance from your Sheet, to reconcile against."
            status={balanceSync.status}
          >
            <button className="action-btn secondary" onClick={syncBalances} disabled={balanceSync.busy}>
              {balanceSync.busy ? 'Syncing…' : 'Sync now'}
            </button>
          </Row>
          <Row
            icon="📤" title="Transactions to Google Sheets"
            desc={pending == null ? 'Checking what’s waiting…' : pending === 0 ? 'Everything is in the Sheet.' : `${pending} waiting to be sent.`}
            status={txSync.status}
          >
            <button className={`action-btn ${pending ? '' : 'secondary'}`} onClick={sendToSheets} disabled={txSync.busy || !pending}>
              {txSync.busy ? 'Sending…' : pending ? `Send ${pending}` : 'Up to date'}
            </button>
          </Row>
          {txSync.busy && (
            <div className="st-progress" aria-hidden="true"><span style={{ width: `${Math.round((txSync.status?.progress || 0) * 100)}%` }} /></div>
          )}
          <Row icon="⚖️" title="Reconcile balances" desc="Compare the balances here with your bank's, and see what to fix.">
            <button className="action-btn secondary" onClick={() => setOpen('reconcile')}>Open</button>
          </Row>
        </>
      )}
      <Row
        icon="🎯" title="Budgets"
        desc={budgets.length ? `${budgets.length} monthly ${budgets.length === 1 ? 'limit' : 'limits'} set` : 'Monthly limits for your categories'}
      >
        <button className="action-btn secondary" onClick={() => setOpen('budgets')}>Manage</button>
      </Row>
      <Row
        icon="🙈" title="Hidden categories"
        desc={excluded ? `${excluded} left out of the analytics` : 'Leave categories out of the analytics'}
      >
        <button className="action-btn secondary" onClick={() => setOpen('categories')}>Manage</button>
      </Row>

      {open === 'reconcile' && <ReconciliationModal accounts={accounts} onClose={() => setOpen(null)} onRefresh={onRefresh} />}
      {open === 'budgets' && (
        <BudgetManagerModal allHeadings={meta.headings} budgets={budgets} onClose={() => setOpen(null)} onRefresh={refreshBudgets} />
      )}
      {open === 'categories' && (
        <CategoryExclusionModal
          excludedHeadings={meta.excluded_headings}
          allHeadings={meta.headings}
          onClose={() => setOpen(null)}
          onRefresh={onRefresh}
        />
      )}
    </div>
  );
}

// ── SabDekho, Nagapandi, access, about ───────────────────────────────────────

function lbxStatus(text) {
  if (!text) return null;
  const kind = /error|fail/i.test(text) ? 'error' : /^synced/i.test(text) ? 'ok' : '';
  return { text, kind };
}

function SabDekhoSection({ showMovies, toggleShowMovies, canSync, lbxUsername, setLbxUsername, lbxSyncing, lbxSyncStatus, syncLetterboxd }) {
  return (
    <div className="st-card st-rows">
      <Row icon="🎬" title="Films" desc="Show films alongside TV shows in SabDekho.">
        <Toggle on={showMovies} onChange={toggleShowMovies} label="Films" />
      </Row>
      {showMovies && canSync && (
        <Row icon="📼" title="Letterboxd" desc="Bring in your diary from Letterboxd's RSS feed." status={lbxStatus(lbxSyncStatus)}>
          <form className="st-inline-form" onSubmit={e => { e.preventDefault(); syncLetterboxd(); }}>
            <input value={lbxUsername} onChange={e => setLbxUsername(e.target.value)} placeholder="Username" aria-label="Letterboxd username" />
            <button className="action-btn secondary" type="submit" disabled={lbxSyncing}>{lbxSyncing ? 'Syncing…' : 'Sync'}</button>
          </form>
        </Row>
      )}
    </div>
  );
}

function NagapandiSection({ enableNagapandi, toggleNagapandi }) {
  return (
    <div className="st-card st-rows">
      <Row icon="✨" title="Nagapandi AI" desc="The chat bubble, and answers from Nagapandi in search (Ctrl K).">
        <Toggle on={enableNagapandi} onChange={toggleNagapandi} label="Nagapandi AI" />
      </Row>
    </div>
  );
}

function AccessSection({ onOpen }) {
  return (
    <div className="st-card st-rows">
      <Row icon="🛡️" title="People" desc="Add or remove who can sign in. Everyone has their own data.">
        <button className="action-btn secondary" onClick={onOpen}>Manage</button>
      </Row>
    </div>
  );
}

function AboutSection({ access, onLogout }) {
  return (
    <div className="st-card st-rows">
      <Row icon="🧩" title="Version" desc={`${__COMMIT_SHA__} · built ${__BUILD_TIME__}`} />
      <Row icon="👤" title="Signed in" desc={`${access.email || 'Unknown'} · ${roleLabel(access.role)}`}>
        <button className="action-btn secondary st-danger" onClick={() => onLogout()}>Sign out</button>
      </Row>
    </div>
  );
}
