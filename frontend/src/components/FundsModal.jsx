import { useEffect, useRef, useState } from 'react';
import { API } from '../constants';
import { fmt, getToken } from '../utils';

// Mutual funds held outside Kite: import a CAS, add one by hand, SIPs.
// The backend values them daily at AMFI's NAV (backend/funds_service.py).

const auth = () => ({ 'Authorization': `Bearer ${getToken()}` });
const today = () => new Date().toISOString().slice(0, 10);
const ordinal = (n) => `${n}${(n % 100 >= 11 && n % 100 <= 13) ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;

async function send(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: body instanceof FormData ? auth() : { ...auth(), 'Content-Type': 'application/json' },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || 'Something went wrong');
  return data;
}

function SipFields({ sip, onChange }) {
  return (
    <div className="fd-row">
      <input className="inp" inputMode="decimal" placeholder="₹ per month" value={sip.amount}
             onChange={e => onChange({ ...sip, amount: e.target.value })} />
      <select className="inp fd-day" value={sip.day} onChange={e => onChange({ ...sip, day: Number(e.target.value) })} aria-label="SIP day">
        {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{ordinal(d)}</option>)}
      </select>
      <label className="fd-since">since
        <input className="inp" type="date" max={today()} value={sip.since} onChange={e => onChange({ ...sip, since: e.target.value })} />
      </label>
    </div>
  );
}

const CAMS_CAS = 'https://www.camsonline.com/Investors/Statements/Consolidated-Account-Statement';

/** The CAMS form, field by field: one statement covers every fund (CAMS and KFintech). */
function HowToGetCas({ open }) {
  return (
    <details className="fd-howto" open={open}>
      <summary>How to get your CAS</summary>
      <ol>
        <li>Open <a href={CAMS_CAS} target="_blank" rel="noopener noreferrer">CAMS → Consolidated Account Statement ↗</a> and tick the disclaimer.</li>
        <li>Statement type: <b>Detailed</b></li>
        <li>Period: <b>Specific Period</b>, from <b>01-Jan-1990</b> to today. Any date before your first investment works; earlier just means complete history.</li>
        <li>Folio listing: <b>With zero balance folios</b></li>
        <li>Your email (PAN is optional).</li>
        <li>Set a <b>password</b> and confirm it. You'll type it here.</li>
        <li>Submit. The PDF arrives by email in a few minutes; upload it below.</li>
      </ol>
    </details>
  );
}

function ImportStatement({ onDone, firstTime }) {
  const [file, setFile] = useState(null);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
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
    <div className="fd-panel">
      <HowToGetCas open={firstTime && !file} />
      <label className={`fd-file ${file ? 'picked' : ''}`}>
        <input type="file" accept="application/pdf,.pdf" onChange={e => { setFile(e.target.files?.[0] || null); setError(''); }} />
        <span>{file ? `📄 ${file.name}` : '📄 Choose your CAS PDF'}</span>
      </label>
      <div className="fd-password">
        <input className="inp" type={showPassword ? 'text' : 'password'} autoComplete="off" placeholder="PDF password" value={password}
               onChange={e => { setPassword(e.target.value); setError(''); }}
               onKeyDown={e => { if (e.key === 'Enter' && file && password && !busy) submit(); }} />
        <button type="button" className="fd-eye" onClick={() => setShowPassword(s => !s)}
                aria-label={showPassword ? 'Hide password' : 'Show password'} title={showPassword ? 'Hide' : 'Show'}>
          {showPassword ? '🙈' : '👁️'}
        </button>
      </div>
      {error && <div className="fd-error">{error}</div>}
      <button className="action-btn" disabled={!file || !password || busy} onClick={submit}>
        {busy ? '⏳ Reading…' : 'Import'}
      </button>
      <p className="fd-hint">Read once, never stored: not the PDF, not the password.</p>
    </div>
  );
}

function AddByHand({ onDone }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [fund, setFund] = useState(null);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today());
  const [withSip, setWithSip] = useState(false);
  const [sip, setSip] = useState({ amount: '', day: new Date().getDate(), since: today() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    if (fund || query.trim().length < 2) { setResults([]); return undefined; }
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const r = await send('GET', `/funds/search?q=${encodeURIComponent(query.trim())}`);
        if (id === latest.current) setResults(r.results.slice(0, 8));
      } catch (e) { if (id === latest.current) setError(e.message); }
    }, 300);
    return () => clearTimeout(timer);
  }, [query, fund]);

  const ready = fund && (amount || (withSip && sip.amount));
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await send('POST', '/funds', {
        code: fund.code,
        ...(amount ? { amount, date } : {}),
        ...(withSip && sip.amount ? { sip } : {}),
      });
      onDone(`${r.added} added`, r.funds);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  return (
    <div className="fd-panel">
      {fund ? (
        <div className="fd-picked">
          <span>{fund.name}</span>
          <button className="fd-x" onClick={() => { setFund(null); setQuery(''); }} aria-label="Change fund">✕</button>
        </div>
      ) : (
        <>
          <input className="inp" autoFocus placeholder="Search a fund, e.g. parag flexi" value={query}
                 onChange={e => { setQuery(e.target.value); setError(''); }} />
          {results.length > 0 && (
            <div className="fd-results">
              {results.map(r => (
                <button key={r.code} className="fd-result" onClick={() => setFund(r)}>
                  <span>{r.name}</span>
                  <small>NAV ₹{r.nav}</small>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {fund && (
        <>
          <div className="fd-row">
            <input className="inp" inputMode="decimal" placeholder="₹ invested" value={amount} onChange={e => setAmount(e.target.value)} />
            <input className="inp" type="date" max={today()} value={date} onChange={e => setDate(e.target.value)} aria-label="Invested on" />
          </div>
          <label className="fd-check">
            <input type="checkbox" checked={withSip} onChange={e => setWithSip(e.target.checked)} /> Monthly SIP
          </label>
          {withSip && <SipFields sip={sip} onChange={setSip} />}
          {withSip && <p className="fd-hint">Past instalments are filled in at each day's NAV, and new ones add themselves.</p>}
        </>
      )}
      {error && <div className="fd-error">{error}</div>}
      {fund && <button className="action-btn" disabled={!ready || busy} onClick={submit}>{busy ? '⏳' : 'Add'}</button>}
    </div>
  );
}

function FundRow({ fund, onChanged }) {
  const [addingSip, setAddingSip] = useState(false);
  const [sip, setSip] = useState({ amount: '', day: new Date().getDate(), since: today() });
  const [error, setError] = useState('');
  const gain = fund.value != null && fund.invested > 0 ? ((fund.value - fund.invested) / fund.invested) * 100 : null;

  const act = async (method, path, body, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setError('');
    try { onChanged(null, (await send(method, path, body)).funds); setAddingSip(false); } catch (e) { setError(e.message); }
  };

  return (
    <div className={`fd-fund ${fund.units > 0 ? '' : 'sold'}`}>
      <div className="fd-fund-top">
        <div className="fd-fund-name">
          <b>{fund.name}</b>
          <small>{fund.units > 0 ? `${fund.units} units${fund.folios.length ? ` · folio ${fund.folios.join(', ')}` : ''}` : 'Sold'}</small>
        </div>
        {fund.units > 0 && (
          <div className="fd-fund-value">
            <b>{fund.value != null ? fmt(fund.value) : '—'}</b>
            {gain != null && <small className={gain >= 0 ? 'up' : 'down'}>{gain >= 0 ? '+' : ''}{gain.toFixed(1)}%</small>}
          </div>
        )}
      </div>
      <div className="fd-fund-actions">
        {fund.sips.map(s => (
          <span key={s.id} className="fd-chip">
            SIP {fmt(s.amount)} · {ordinal(s.day)}
            <button onClick={() => act('DELETE', `/funds/sips/${s.id}`, null, 'Stop this SIP? Instalments already added stay.')} aria-label="Stop SIP">✕</button>
          </span>
        ))}
        {fund.units > 0 && !addingSip && <button className="fd-link" onClick={() => setAddingSip(true)}>＋ SIP</button>}
        <button className="fd-link danger" onClick={() => act('DELETE', `/funds/${fund.code}`, null, `Remove ${fund.name} and its history?`)}>Remove</button>
      </div>
      {addingSip && (
        <div className="fd-panel inline">
          <SipFields sip={sip} onChange={setSip} />
          <div className="fd-row">
            <button className="action-btn" disabled={!sip.amount} onClick={() => act('POST', `/funds/${fund.code}/sip`, sip)}>Start SIP</button>
            <button className="action-btn secondary" onClick={() => setAddingSip(false)}>Cancel</button>
          </div>
        </div>
      )}
      {error && <div className="fd-error">{error}</div>}
    </div>
  );
}

export default function FundsModal({ onClose, onChanged }) {
  const [funds, setFunds] = useState(null);
  const [mode, setMode] = useState(null);   // null | 'import' | 'add'
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    send('GET', '/funds')
      .then(r => {
        setFunds(r.funds);
        if (!r.funds.length) setMode('import');   // nothing yet: straight to the steps
      })
      .catch(e => setError(e.message));
  }, []);

  const changed = (message, list) => {
    if (list) setFunds(list);
    if (message) { setNote(message); setMode(null); }
    onChanged();
  };

  const held = (funds || []).filter(f => f.units > 0);
  const total = held.reduce((sum, f) => sum + (f.value || 0), 0);
  const firstTime = funds !== null && funds.length === 0;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content fd-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">Mutual funds</div>
          {held.length > 0 && <span className="fd-total">{fmt(Math.round(total))}</span>}
          <button className="fd-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {/* Phone: one column. Wide screens: actions on the left, the funds on the right. */}
        <div className={`modal-body fd-body ${mode ? 'panel-open' : ''}`}>
          <div className="fd-side">
            <div className="fd-tabs">
              <button className={mode === 'import' ? 'on' : ''} onClick={() => setMode(m => (m === 'import' ? null : 'import'))}>📄 Import statement</button>
              <button className={mode === 'add' ? 'on' : ''} onClick={() => setMode(m => (m === 'add' ? null : 'add'))}>＋ Add a fund</button>
            </div>
            {mode === 'import' && <ImportStatement onDone={changed} firstTime={firstTime} />}
            {mode === 'add' && <AddByHand onDone={changed} />}
            {note && <div className="fd-note" onClick={() => setNote('')}>✓ {note}</div>}
            {error && <div className="fd-error">{error}</div>}
          </div>

          <div className="fd-main">
            {funds === null && !error && <div className="fd-hint">Loading…</div>}
            {firstTime && (
              <div className="fd-empty">
                <div className="fd-empty-icon">📄</div>
                Import your CAS to bring in every fund at once, or add them one by one.
                <br />They update daily at AMFI's NAV.
              </div>
            )}
            {funds && funds.length > 0 && (
              <div className="fd-list">
                {funds.map(f => <FundRow key={f.code} fund={f} onChanged={changed} />)}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
