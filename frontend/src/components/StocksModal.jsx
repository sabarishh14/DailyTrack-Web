import { useEffect, useRef, useState } from 'react';
import { API } from '../constants';
import { fmt, getToken } from '../utils';

// Stocks and ETFs added by hand, for anyone (Kite or not): buy, sell, remove.
// Valued through the day at the market's price (backend/stocks_service.py). The
// same look as the Mutual funds window (FundsModal), and its fd-* styles.

const auth = () => ({ 'Authorization': `Bearer ${getToken()}` });
const today = () => new Date().toISOString().slice(0, 10);
const qty = (n) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 4 });
const money = (n) => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const signed = (n) => `${n >= 0 ? '+' : '-'}${fmt(Math.abs(Math.round(n)))}`;
const shortDay = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const clock = (stamp) => new Date(stamp).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

async function send(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) throw new Error(data.message || 'Something went wrong');
  return data;
}

const Icon = ({ d, size = 18, children }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d ? <path d={d} /> : children}
  </svg>
);
const Back = () => <Icon d="M19 12H5M12 19l-7-7 7-7" />;
const Close = () => <Icon d="M18 6 6 18M6 6l12 12" />;
const Plus = (p) => <Icon {...p} d="M12 5v14M5 12h14" />;
const Minus = (p) => <Icon {...p} d="M5 12h14" />;
const Search = () => <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Icon>;
const Chart = (p) => <Icon {...p} d="M3 17l6-6 4 4 8-8M15 7h6v6" />;
const Trash = () => <Icon size={16}><path d="M4 7h16M10 11v6M14 11v6" /><path d="m5 7 1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></Icon>;
const Chevron = ({ open }) => <span className={`fd-chev ${open ? 'open' : ''}`}><Icon size={16} d="m6 9 6 6 6-6" /></span>;

function Field({ label, children, hint }) {
  return (
    <label className="fd-field">
      <span className="fd-label">{label}</span>
      {children}
      {hint && <span className="fd-hint">{hint}</span>}
    </label>
  );
}

/** How many, at what price, on which day: a buy or a sale. */
function TradeFields({ value, onChange, sell }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="fd-grid sip">
      <Field label={sell ? 'Sold' : 'Quantity'}>
        <input className="inp" inputMode="decimal" placeholder="10" value={value.quantity} onChange={set('quantity')} />
      </Field>
      <Field label={sell ? 'At' : 'Average price'}>
        <input className="inp" inputMode="decimal" placeholder="₹ 0" value={value.price} onChange={set('price')} />
      </Field>
      <Field label="On">
        <input className="inp" type="date" max={today()} value={value.date} onChange={set('date')} />
      </Field>
    </div>
  );
}

const blankTrade = () => ({ quantity: '', price: '', date: today() });
const tradeReady = (t) => Number(t.quantity) > 0 && Number(t.price) > 0;

// ── Add a stock ─────────────────────────────────────────────────────────────
function AddView({ onDone }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState(null);
  const [stock, setStock] = useState(null);
  const [trade, setTrade] = useState(blankTrade);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = useRef(0);

  useEffect(() => {
    if (stock || query.trim().length < 2) { setResults(null); return undefined; }
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      try {
        const r = await send('GET', `/stocks/search?q=${encodeURIComponent(query.trim())}`);
        if (id === latest.current) setResults(r.results.slice(0, 8));
      } catch (e) { if (id === latest.current) setError(e.message); }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, stock]);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      const r = await send('POST', '/stocks', { symbol: stock.symbol, ...trade });
      onDone(`${r.added} added`, r);
    } catch (e) { setError(e.message); }
    setBusy(false);
  };

  if (!stock) {
    return (
      <div className="fd-add">
        <div className="fd-search">
          <Search />
          <input autoFocus placeholder="Search by name or symbol, e.g. infosys" value={query}
                 onChange={e => { setQuery(e.target.value); setError(''); }} />
        </div>
        {results && results.length > 0 && (
          <ul className="fd-results">
            {results.map(r => (
              <li key={r.symbol}>
                <button onClick={() => setStock(r)}>
                  <span className="fd-result-name">{r.symbol}</span>
                  <span className="fd-muted">{r.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {results && results.length === 0 && <p className="fd-muted fd-center">Nothing on NSE by that name</p>}
        {!results && <p className="fd-muted fd-center">Any NSE stock or ETF.</p>}
        {error && <p className="fd-error">{error}</p>}
      </div>
    );
  }

  return (
    <div className="fd-add picked">
      <div className="fd-picked">
        <div>
          <b>{stock.symbol}</b>
          <span className="fd-muted">{stock.name}</span>
        </div>
        <button className="fd-link" onClick={() => { setStock(null); setQuery(''); }}>Change</button>
      </div>
      <div className="fd-box">
        <span className="fd-box-title">What you hold</span>
        <TradeFields value={trade} onChange={setTrade} />
        <p className="fd-muted">Bought more than once? Add the total and its average price, or each buy later.</p>
      </div>
      {error && <p className="fd-error">{error}</p>}
      <button className="fd-btn primary wide" disabled={!tradeReady(trade) || busy} onClick={submit}>{busy ? 'Adding…' : 'Add stock'}</button>
    </div>
  );
}

// ── Your stocks ─────────────────────────────────────────────────────────────
function StockRow({ stock, open, onToggle, onChanged }) {
  const [trading, setTrading] = useState(null);   // 'BUY' | 'SELL'
  const [trade, setTrade] = useState(blankTrade);
  const [confirming, setConfirming] = useState(null);   // 'remove' | trade id
  const [error, setError] = useState('');
  const held = stock.quantity > 0;
  const gain = stock.value != null && stock.invested > 0 ? ((stock.value - stock.invested) / stock.invested) * 100 : null;

  useEffect(() => {
    if (!open) { setTrading(null); setConfirming(null); setError(''); }
  }, [open]);

  const act = async (method, path, body) => {
    setError('');
    try {
      const r = await send(method, path, body);
      setConfirming(null); setTrading(null); setTrade(blankTrade());
      onChanged(null, r);
    } catch (e) { setError(e.message); }
  };

  return (
    <li className={`fd-fund ${held ? '' : 'sold'} ${open ? 'open' : ''}`}>
      <div className="fd-fund-main" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}>
        <div className="fd-fund-name">
          <b title={stock.name}>{stock.symbol}</b>
          <span className="fd-muted fd-fund-meta">
            {held ? `${qty(stock.quantity)} · avg ${money(stock.avg_price)}` : 'Sold'}
          </span>
        </div>
        {held && (
          <>
            <span className="fd-cell units">{qty(stock.quantity)}</span>
            <span className="fd-cell avg">{money(stock.avg_price)}</span>
            <span className="fd-cell invested">{fmt(Math.round(stock.invested))}</span>
            <span className="fd-cell value">{stock.value != null ? fmt(Math.round(stock.value)) : '—'}</span>
            <span className={`fd-cell returns ${gain == null ? '' : gain >= 0 ? 'up' : 'down'}`}>
              {gain != null && <><span className="fd-amt">{signed(stock.value - stock.invested)}</span><span className="fd-pct">{pct(gain)}</span></>}
            </span>
          </>
        )}
      </div>

      {open && (
        <div className="fd-fund-more">
          <ul className="sk-trades">
            {stock.trades.map(t => (
              <li key={t.id}>
                <span className={`sk-kind ${t.kind === 'BUY' ? 'buy' : 'sell'}`}>{t.kind === 'BUY' ? 'Bought' : 'Sold'}</span>
                <span>{qty(t.quantity)} at {money(t.price)}</span>
                <span className="fd-muted">{shortDay(t.date)}</span>
                {confirming === t.id ? (
                  <span className="fd-confirm">
                    Delete?
                    <button className="fd-link danger" onClick={() => act('DELETE', `/stocks/${stock.symbol}/trades/${t.id}`)}>Delete</button>
                    <button className="fd-link" onClick={() => setConfirming(null)}>Keep</button>
                  </span>
                ) : (
                  <button className="fd-link quiet sk-x" onClick={() => setConfirming(t.id)} aria-label="Delete this trade" title="Entered by mistake? Delete it"><Close /></button>
                )}
              </li>
            ))}
          </ul>
          {!trading && (
            <div className="fd-fund-actions">
              {confirming !== 'remove' && (
                <>
                  <button className="fd-link" onClick={() => setTrading('BUY')}><Plus size={14} /> Buy</button>
                  {held && <button className="fd-link" onClick={() => setTrading('SELL')}><Minus size={14} /> Sell</button>}
                </>
              )}
              <span className="fd-spacer" />
              {confirming === 'remove' ? (
                <span className="fd-confirm">
                  Remove it and its history?
                  <button className="fd-link danger" onClick={() => act('DELETE', `/stocks/${stock.symbol}`)}>Remove</button>
                  <button className="fd-link" onClick={() => setConfirming(null)}>Cancel</button>
                </span>
              ) : confirming == null && (
                <button className="fd-link quiet" onClick={() => setConfirming('remove')} aria-label="Remove" title="Remove"><Trash /></button>
              )}
            </div>
          )}
          {trading && (
            <div className="fd-inline">
              <TradeFields value={trade} onChange={setTrade} sell={trading === 'SELL'} />
              <div className="fd-inline-actions">
                <button className="fd-btn ghost" onClick={() => setTrading(null)}>Cancel</button>
                <button className="fd-btn primary" disabled={!tradeReady(trade)}
                        onClick={() => act('POST', `/stocks/${stock.symbol}/trades`, { kind: trading, ...trade })}>
                  {trading === 'BUY' ? 'Buy' : 'Sell'}
                </button>
              </div>
            </div>
          )}
          {error && <p className="fd-error">{error}</p>}
        </div>
      )}
    </li>
  );
}

function StocksList({ stocks, quotedAt, note, onDismissNote, onAdd, onChanged }) {
  const [showSold, setShowSold] = useState(false);
  const [open, setOpen] = useState(null);
  const row = (s) => (
    <StockRow key={s.symbol} stock={s} open={open === s.symbol} onChanged={onChanged}
              onToggle={() => setOpen(o => (o === s.symbol ? null : s.symbol))} />
  );
  const held = stocks.filter(s => s.quantity > 0);
  const sold = stocks.filter(s => s.quantity <= 0);
  const value = held.reduce((s, x) => s + (x.value || 0), 0);
  const invested = held.reduce((s, x) => s + (x.invested || 0), 0);
  const gain = invested > 0 ? ((value - invested) / invested) * 100 : null;

  return (
    <div className="fd-list-view">
      <div className="fd-summary">
        <div className="fd-stat main">
          <span className="fd-stat-label">Current value</span>
          <span className="fd-summary-value">{fmt(Math.round(value))}</span>
          {quotedAt && <span className="fd-muted sk-asof">Prices as of {clock(quotedAt)}</span>}
        </div>
        <div className="fd-stat">
          <span className="fd-stat-label">Invested</span>
          <span className="fd-stat-value">{fmt(Math.round(invested))}</span>
        </div>
        {gain != null && (
          <div className="fd-stat">
            <span className="fd-stat-label">Returns</span>
            <span className={`fd-stat-value ${gain >= 0 ? 'up' : 'down'}`}>{signed(value - invested)} <small>{pct(gain)}</small></span>
          </div>
        )}
        <div className="fd-summary-actions">
          <button className="fd-btn primary" onClick={onAdd}><Plus size={16} /> Add</button>
        </div>
      </div>

      {note && (
        <button className="fd-note" onClick={onDismissNote}>
          <Icon size={16} d="M20 6 9 17l-5-5" /> {note}
        </button>
      )}

      {held.length > 0 && (
        <div className="fd-table">
          <div className="fd-thead" aria-hidden="true">
            <span>Stock</span><span>Qty</span><span>Avg price</span><span>Invested</span><span>Current</span><span>Returns</span>
          </div>
          <ul className="fd-funds">{held.map(row)}</ul>
        </div>
      )}

      {sold.length > 0 && (
        <>
          <button className="fd-sold-toggle" onClick={() => setShowSold(s => !s)}>
            Sold ({sold.length}) <Chevron open={showSold} />
          </button>
          {showSold && <div className="fd-table"><ul className="fd-funds">{sold.map(row)}</ul></div>}
        </>
      )}
    </div>
  );
}

function Welcome({ onAdd }) {
  return (
    <div className="fd-welcome">
      <h3>Track your stocks</h3>
      <p className="fd-muted">Any NSE stock or ETF, valued through the day at the market’s price.</p>
      <div className="fd-options one">
        <button className="fd-option" onClick={onAdd}>
          <span className="fd-option-top"><span className="fd-option-icon"><Chart size={22} /></span></span>
          <span className="fd-option-title">Add a stock</span>
          <span className="fd-muted">Search for it and add how many you hold, at what price.</span>
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

export default function StocksModal({ onClose, onChanged }) {
  const [data, setData] = useState(null);   // { stocks, quoted_at }
  const [view, setView] = useState('list');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    send('GET', '/stocks').then(setData).catch(e => setError(e.message));
  }, []);

  const changed = (message, result) => {
    if (result) setData(result);
    if (message) { setNote(message); setView('list'); }
    onChanged();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content fd-modal sk-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header fd-header">
          {view !== 'list' && (
            <button className="fd-icon-btn" onClick={() => setView('list')} aria-label="Back"><Back /></button>
          )}
          <div className="modal-title">{view === 'list' ? 'Stocks' : 'Add a stock'}</div>
          <button className="fd-icon-btn fd-close" onClick={onClose} aria-label="Close"><Close /></button>
        </div>
        <div className="modal-body fd-body">
          {error && <p className="fd-error">{error}</p>}
          {view === 'add' && <AddView onDone={changed} />}
          {view === 'list' && data === null && !error && <Skeleton />}
          {view === 'list' && data && data.stocks.length === 0 && <Welcome onAdd={() => setView('add')} />}
          {view === 'list' && data && data.stocks.length > 0 && (
            <StocksList stocks={data.stocks} quotedAt={data.quoted_at} note={note} onDismissNote={() => setNote('')}
                        onAdd={() => setView('add')} onChanged={changed} />
          )}
        </div>
      </div>
    </div>
  );
}
