import { useEffect, useRef, useState } from 'react';
import { API } from '../constants';
import { fmt, getToken } from '../utils';

// Mutual funds held outside Kite: import a CAS, add one by hand, SIPs. One
// focused column whose view changes (your funds / import / add); the backend
// values them daily at AMFI's NAV (backend/funds_service.py).

const CAMS_CAS = 'https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement';

const auth = () => ({ 'Authorization': `Bearer ${getToken()}` });
const today = () => new Date().toISOString().slice(0, 10);
const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const units = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;

async function send(method, path, body) {
  const form = body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: form ? auth() : { ...auth(), 'Content-Type': 'application/json' },
    body: form ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || 'Something went wrong');
  return data;
}

// ── Icons (stroke, 24 grid) ─────────────────────────────────────────────────
const Icon = ({ d, size = 18, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d ? <path d={d} /> : children}
  </svg>
);
const Back = () => <Icon d="M19 12H5M12 19l-7-7 7-7" />;
const Close = () => <Icon d="M18 6 6 18M6 6l12 12" />;
const Plus = (p) => <Icon {...p} d="M12 5v14M5 12h14" />;
const Search = () => <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
const Eye = () => <Icon><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></Icon>;
const EyeOff = () => (
  <Icon>
    <path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8" />
    <path d="M9.9 5.2A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17.4 17.4 0 0 1-2.4 3.3M6.6 6.6A17.2 17.2 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6" />
  </Icon>
);
const Doc = (p) => <Icon {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></Icon>;
const Upload = () => <Icon size={22}><path d="M12 15V4M7 9l5-5 5 5" /><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" /></Icon>;
const Lock = () => <Icon size={14}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Icon>;
const External = () => <Icon size={15}><path d="M14 4h6v6M20 4l-9 9" /><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" /></Icon>;
const Chevron = ({ open }) => <span className={`fd-chev ${open ? 'open' : ''}`}><Icon size={16} d="m6 9 6 6 6-6" /></span>;
const Trash = () => <Icon size={16}><path d="M4 7h16M10 11v6M14 11v6" /><path d="m5 7 1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Icon>;

function Field({ label, children, hint }) {
  return (
    <label className="fd-field">
      <span className="fd-label">{label}</span>
      {children}
      {hint && <span className="fd-hint">{hint}</span>}
    </label>
  );
}

function Switch({ on, onChange, label }) {
  return (
    <button type="button" className={`fd-switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} role="switch" aria-checked={on}>
      <span className="fd-switch-track"><span className="fd-switch-knob" /></span>
      <span>{label}</span>
    </button>
  );
}

function SipFields({ sip, onChange }) {
  return (
    <div className="fd-grid sip">
      <Field label="Every month">
        <input className="inp" inputMode="decimal" placeholder="₹ 5,000" value={sip.amount}
               onChange={e => onChange({ ...sip, amount: e.target.value })} />
      </Field>
      <Field label="On the">
        <select className="inp" value={sip.day} onChange={e => onChange({ ...sip, day: Number(e.target.value) })}>
          {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{ordinal(d)}</option>)}
        </select>
      </Field>
      <Field label="Since">
        <input className="inp" type="date" max={today()} value={sip.since} onChange={e => onChange({ ...sip, since: e.target.value })} />
      </Field>
    </div>
  );
}

// ── Import ──────────────────────────────────────────────────────────────────
const CAMS_STEPS = [
  ['Statement type', 'Detailed'],
  ['Period', <>Specific · from <span className="fd-nowrap">01-Jan-1990</span></>],
  ['Folio listing', 'With zero balance folios'],
  ['Password', 'Set your own; you’ll need it below'],
];

function ImportView({ onDone }) {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const picker = useRef(null);

  const pick = (f) => {
    setError('');
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) { setError('That isn’t a PDF'); return; }
    setFile(f);
  };

  const submit = async () => {
    if (!file || !password || busy) return;
    const form = new FormData();
    form.append('file', file);
    form.append('password', password);
    setBusy(true); setError('');
    try {
      const r = await send('POST', '/funds/import', form);
      const parts = [
        r.added.length && `${r.added.length} added`,
        r.updated.length && `${r.updated.length} updated`,
        r.skipped_kite.length && `${r.skipped_kite.length} already in Kite`,
        r.unknown.length && `${r.unknown.length} not found`,
      ].filter(Boolean);
      setPassword('');
      onDone(parts.length ? parts.join(' · ') : 'Nothing new in that statement', r.funds);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div className="fd-steps">
      <section className="fd-step">
        <span className="fd-step-no">1</span>
        <div className="fd-step-body">
          <h4>Get your statement from CAMS</h4>
          <p className="fd-muted">Tick the disclaimer, enter your email, then choose:</p>
          <dl className="fd-settings">
            {CAMS_STEPS.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
          </dl>
          <div className="fd-step-foot">
            <a className="fd-btn ghost" href={CAMS_CAS} target="_blank" rel="noopener noreferrer">Open CAMS <External /></a>
            <span className="fd-muted">Arrives by email in a few minutes.</span>
          </div>
        </div>
      </section>

      <section className="fd-step">
        <span className="fd-step-no">2</span>
        <div className="fd-step-body">
          <h4>Upload it</h4>
          <div
            className={`fd-drop ${dragging ? 'over' : ''} ${file ? 'has-file' : ''}`}
            onClick={() => picker.current?.click()}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0]); }}
            role="button" tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') picker.current?.click(); }}
          >
            <input ref={picker} type="file" accept="application/pdf,.pdf" hidden onChange={e => pick(e.target.files?.[0])} />
            {file ? (
              <>
                <span className="fd-drop-icon"><Doc size={22} /></span>
                <span className="fd-drop-name">{file.name}</span>
                <span className="fd-muted">{(file.size / 1024).toFixed(0)} KB · click to change</span>
              </>
            ) : (
              <>
                <span className="fd-drop-icon"><Upload /></span>
                <span><b>Drop your CAS PDF here</b></span>
                <span className="fd-muted">or click to choose</span>
              </>
            )}
          </div>
          <div className="fd-password">
            <input className="inp" type={showPassword ? 'text' : 'password'} autoComplete="off" placeholder="PDF password"
                   value={password} onChange={e => { setPassword(e.target.value); setError(''); }}
                   onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
            <button type="button" className="fd-eye" onClick={() => setShowPassword(s => !s)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}>
              {showPassword ? <EyeOff /> : <Eye />}
            </button>
          </div>
          {error && <p className="fd-error">{error}</p>}
          <button className="fd-btn primary wide" disabled={!file || !password || busy} onClick={submit}>
            {busy ? 'Reading your statement…' : 'Import'}
          </button>
          <p className="fd-privacy"><Lock /> Read once and never stored: not the PDF, not the password.</p>
        </div>
      </section>
    </div>
  );
}

// ── Add by hand ─────────────────────────────────────────────────────────────
function AddView({ onDone }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [fund, setFund] = useState(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [withSip, setWithSip] = useState(false);
  const [sip, setSip] = useState({ amount: '', day: new Date().getDate(), since: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    if (fund || query.trim().length < 2) { setResults(null); return undefined; }
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const r = await send('GET', `/funds/search?q=${encodeURIComponent(query.trim())}`);
        if (id === latest.current) setResults(r.results.slice(0, 8));
      } catch (e) { if (id === latest.current) setError(e.message); }
    }, 250);
    return () => clearTimeout(timer);
  }, [query, fund]);

  const ready = fund && (Number(amount) > 0 || (withSip && Number(sip.amount) > 0));
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await send('POST', '/funds', {
        code: fund.code,
        ...(Number(amount) > 0 ? { amount, date } : {}),
        ...(withSip && Number(sip.amount) > 0 ? { sip } : {}),
      });
      onDone(`${r.added} added`, r.funds);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  if (!fund) {
    return (
      <div className="fd-add">
        <div className="fd-search">
          <Search />
          <input autoFocus placeholder="Search by fund name, e.g. parag flexi" value={query}
                 onChange={e => { setQuery(e.target.value); setError(''); }} />
        </div>
        {results && results.length > 0 && (
          <ul className="fd-results">
            {results.map(r => (
              <li key={r.code}>
                <button onClick={() => setFund(r)}>
                  <span className="fd-result-name">{r.name}</span>
                  <span className="fd-muted">{r.amc ? `${r.amc} · ` : ''}NAV ₹{r.nav}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {results && results.length === 0 && <p className="fd-muted fd-center">No fund by that name</p>}
        {!results && <p className="fd-muted fd-center">Any fund with a daily NAV, Direct or Regular.</p>}
        {error && <p className="fd-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="fd-add">
      <div className="fd-picked">
        <div>
          <b>{fund.name}</b>
          <span className="fd-muted">{fund.amc ? `${fund.amc} · ` : ''}NAV ₹{fund.nav}</span>
        </div>
        <button className="fd-link" onClick={() => { setFund(null); setQuery(''); }}>Change</button>
      </div>

      <div className="fd-grid">
        <Field label="Amount invested">
          <input className="inp" inputMode="decimal" placeholder="₹ 0" value={amount} onChange={e => setAmount(e.target.value)} />
        </Field>
        <Field label="On">
          <input className="inp" type="date" max={today()} value={date} onChange={e => setDate(e.target.value)} />
        </Field>
      </div>

      <div className="fd-sip-box">
        <Switch on={withSip} onChange={setWithSip} label="Monthly SIP" />
        {withSip && (
          <>
            <SipFields sip={sip} onChange={setSip} />
            <p className="fd-muted">Past instalments are filled in at each day’s NAV; new ones add themselves.</p>
          </>
        )}
      </div>

      {error && <p className="fd-error">{error}</p>}
      <button className="fd-btn primary wide" disabled={!ready || busy} onClick={submit}>{busy ? 'Adding…' : 'Add fund'}</button>
    </div>
  );
}

// ── Your funds ──────────────────────────────────────────────────────────────
function FundRow({ fund, onChanged }) {
  const [addingSip, setAddingSip] = useState(false);
  const [sip, setSip] = useState({ amount: '', day: new Date().getDate(), since: today() });
  const [confirming, setConfirming] = useState(null);   // 'remove' | sip id
  const [error, setError] = useState('');
  const held = fund.units > 0;
  const gain = fund.value != null && fund.invested > 0 ? ((fund.value - fund.invested) / fund.invested) * 100 : null;

  const act = async (method, path, body) => {
    setError('');
    try {
      const r = await send(method, path, body);
      setConfirming(null); setAddingSip(false);
      onChanged(null, r.funds);
    } catch (e) { setError(e.message); }
  };

  const removing = confirming === 'remove';
  const remove = (
    <button className="fd-link quiet" onClick={() => setConfirming('remove')} aria-label="Remove" title="Remove"><Trash /></button>
  );
  // A sold fund has nothing to do but go: Remove sits beside its name, and the
  // row only grows a line to confirm. One being given a SIP shows just the form,
  // and an open question hides the other actions until it's answered.
  const actions = held ? !addingSip : removing;

  return (
    <li className={`fd-fund ${held ? '' : 'sold'} ${actions || addingSip ? '' : 'bare'}`}>
      <div className="fd-fund-main">
        <div className="fd-fund-name">
          <b title={fund.name}>{fund.name}</b>
          <span className="fd-muted">
            {held ? `${units(fund.units)} units` : 'Sold'}
            {fund.folios.length > 0 && ` · folio ${fund.folios.map(f => `••${f}`).join(', ')}`}
          </span>
        </div>
        {held ? (
          <div className="fd-fund-value">
            <b>{fund.value != null ? fmt(Math.round(fund.value)) : '—'}</b>
            {gain != null && <span className={`fd-gain ${gain >= 0 ? 'up' : 'down'}`}>{pct(gain)}</span>}
          </div>
        ) : !removing && remove}
      </div>

      {actions && (
        <div className="fd-fund-actions">
          {held && !removing && fund.sips.map(s => (confirming === s.id ? (
            <span key={s.id} className="fd-confirm">
              Stop this SIP?
              <button className="fd-link danger" onClick={() => act('DELETE', `/funds/sips/${s.id}`)}>Stop</button>
              <button className="fd-link" onClick={() => setConfirming(null)}>Keep</button>
            </span>
          ) : (
            <span key={s.id} className="fd-chip">
              SIP {fmt(s.amount)} · {ordinal(s.day)}
              <button onClick={() => setConfirming(s.id)} aria-label="Stop SIP"><Close /></button>
            </span>
          )))}
          {held && confirming == null && (
            <button className="fd-link" onClick={() => setAddingSip(true)}><Plus size={14} /> SIP</button>
          )}
          <span className="fd-spacer" />
          {removing ? (
            <span className="fd-confirm">
              Remove it and its history?
              <button className="fd-link danger" onClick={() => act('DELETE', `/funds/${fund.code}`)}>Remove</button>
              <button className="fd-link" onClick={() => setConfirming(null)}>Cancel</button>
            </span>
          ) : confirming == null && remove}
        </div>
      )}

      {addingSip && (
        <div className="fd-inline">
          <SipFields sip={sip} onChange={setSip} />
          <div className="fd-inline-actions">
            <button className="fd-btn ghost" onClick={() => setAddingSip(false)}>Cancel</button>
            <button className="fd-btn primary" disabled={!(Number(sip.amount) > 0)} onClick={() => act('POST', `/funds/${fund.code}/sip`, sip)}>Start SIP</button>
          </div>
        </div>
      )}
      {error && <p className="fd-error">{error}</p>}
    </li>
  );
}

function FundsList({ funds, note, onDismissNote, onImport, onAdd, onChanged }) {
  const [showSold, setShowSold] = useState(false);
  const held = funds.filter(f => f.units > 0);
  const sold = funds.filter(f => f.units <= 0);
  const value = held.reduce((s, f) => s + (f.value || 0), 0);
  const invested = held.reduce((s, f) => s + (f.invested || 0), 0);
  const gain = invested > 0 ? ((value - invested) / invested) * 100 : null;

  return (
    <div className="fd-list-view">
      <div className="fd-summary">
        <div>
          <span className="fd-summary-value">{fmt(Math.round(value))}</span>
          <span className="fd-muted">
            Invested {fmt(Math.round(invested))}
            {gain != null && <span className={`fd-gain ${gain >= 0 ? 'up' : 'down'}`}>{pct(gain)}</span>}
          </span>
        </div>
        <div className="fd-summary-actions">
          <button className="fd-btn ghost" onClick={onImport}><Doc size={16} /> Import</button>
          <button className="fd-btn primary" onClick={onAdd}><Plus size={16} /> Add</button>
        </div>
      </div>

      {note && (
        <button className="fd-note" onClick={onDismissNote}>
          <Icon size={16} d="M20 6 9 17l-5-5" /> {note}
        </button>
      )}

      <ul className="fd-funds">
        {held.map(f => <FundRow key={f.code} fund={f} onChanged={onChanged} />)}
      </ul>

      {sold.length > 0 && (
        <>
          <button className="fd-sold-toggle" onClick={() => setShowSold(s => !s)}>
            Sold ({sold.length}) <Chevron open={showSold} />
          </button>
          {showSold && <ul className="fd-funds">{sold.map(f => <FundRow key={f.code} fund={f} onChanged={onChanged} />)}</ul>}
        </>
      )}
    </div>
  );
}

function Welcome({ onImport, onAdd }) {
  return (
    <div className="fd-welcome">
      <h3>Track your mutual funds</h3>
      <p className="fd-muted">Valued every day at AMFI’s NAV, with SIPs that add themselves.</p>
      <div className="fd-options">
        <button className="fd-option" onClick={onImport}>
          <span className="fd-option-top">
            <span className="fd-option-icon"><Doc size={22} /></span>
            <span className="fd-badge">Recommended</span>
          </span>
          <span className="fd-option-title">Import statement</span>
          <span className="fd-muted">Every fund and transaction at once, from your CAS.</span>
        </button>
        <button className="fd-option" onClick={onAdd}>
          <span className="fd-option-top"><span className="fd-option-icon"><Plus size={22} /></span></span>
          <span className="fd-option-title">Add a fund</span>
          <span className="fd-muted">Search for one and add what you put in, or its SIP.</span>
        </button>
      </div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="fd-skeleton" aria-label="Loading">
      <div className="fd-sk big" />
      {[0, 1, 2].map(i => <div key={i} className="fd-sk row" />)}
    </div>
  );
}

const TITLES = { list: 'Mutual funds', import: 'Import statement', add: 'Add a fund' };

export default function FundsModal({ onClose, onChanged }) {
  const [funds, setFunds] = useState(null);
  const [view, setView] = useState('list');   // list | import | add
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    send('GET', '/funds').then(r => setFunds(r.funds)).catch(e => setError(e.message));
  }, []);

  const changed = (message, list) => {
    if (list) setFunds(list);
    if (message) { setNote(message); setView('list'); }
    onChanged();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content fd-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header fd-header">
          {view !== 'list' && (
            <button className="fd-icon-btn" onClick={() => setView('list')} aria-label="Back"><Back /></button>
          )}
          <div className="modal-title">{TITLES[view]}</div>
          <button className="fd-icon-btn fd-close" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="modal-body fd-body">
          {error && <p className="fd-error">{error}</p>}
          {view === 'import' && <ImportView onDone={changed} />}
          {view === 'add' && <AddView onDone={changed} />}
          {view === 'list' && funds === null && !error && <Skeleton />}
          {view === 'list' && funds && funds.length === 0 && (
            <Welcome onImport={() => setView('import')} onAdd={() => setView('add')} />
          )}
          {view === 'list' && funds && funds.length > 0 && (
            <FundsList funds={funds} note={note} onDismissNote={() => setNote('')}
                       onImport={() => setView('import')} onAdd={() => setView('add')} onChanged={changed} />
          )}
        </div>
      </div>
    </div>
  );
}
