import { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../../constants';
import {
  fmt, getToken, evaluateMath, balanceDelta, isCcAccount,
  buildDescriptionIndex, categoriesForType, descriptionOptions,
} from '../../utils';
import { useAccountOptions, useLatestMoneyMeta, EMPTY_META } from '../../api/money';
import {
  SheetSelect, SheetSuggest, toDisplayDate, parseDisplayDate,
  TYPE_OPTIONS, renderAccount, renderType,
} from './SheetCells';

const today = () => new Date().toISOString().split('T')[0];

// An empty row at the top of the transactions table, filled in like a sheet:
// type in the cells, Tab across, Enter saves. Its text sits exactly where the
// values of the rows below do. Date, account and type carry over to the next.
export default function SheetEntryRow({ gridColumns, tableMinWidth, withBalances, accounts, categories, onSaved, onClose }) {
  const meta = useLatestMoneyMeta().data || EMPTY_META;
  const descriptionIndex = useMemo(() => buildDescriptionIndex(meta.descriptions), [meta.descriptions]);

  const blank = (prev) => ({
    date: prev?.date || today(),
    account: prev?.account || 'KOTAK',
    type: prev?.type || 'Debit',
    amount: '',
    heading: '',
    description: '',
  });
  const [row, setRow] = useState(() => blank());
  const accountOptions = useAccountOptions(row.account);
  const [status, setStatus] = useState(null); // null | 'saving' | 'saved' | { error }
  const [dateText, setDateText] = useState(() => toDisplayDate(row.date));
  const dateInvalid = parseDisplayDate(dateText) === null;
  const amountRef = useRef(null);
  useEffect(() => { amountRef.current?.focus(); }, []);

  const set = (field) => (value) => { setRow(r => ({ ...r, [field]: value })); setStatus(null); };
  const evaluated = evaluateMath(row.amount);
  const amount = parseFloat(evaluated !== null && evaluated !== '' ? evaluated : row.amount);
  const valid = !isNaN(amount) && amount > 0 && row.heading.trim() && row.date && row.account && !dateInvalid;
  const month = row.date ? new Date(row.date).toLocaleString('default', { month: 'long' }) : '';

  const acc = accounts.find(a => a.account === row.account);
  const projected = acc && acc.balance_tracked && acc.balance != null && !isCcAccount(row.account) && !isNaN(amount)
    ? acc.balance + balanceDelta(row.type, amount) : null;
  const belowMin = projected != null && acc?.min_balance != null && projected < acc.min_balance;

  const save = async () => {
    if (!valid || status === 'saving') return;
    setStatus('saving');
    try {
      const res = await fetch(`${API}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify([{
          account: row.account,
          date: row.date,
          type: row.type,
          heading: row.heading.trim(),
          description: row.description.trim(),
          amount,
          exclude_analytics: false,
        }]),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.message || `Server returned ${res.status}`);
      setRow(r => blank(r));
      setDateText(toDisplayDate(row.date));
      setStatus('saved');
      onSaved?.();
      amountRef.current?.focus();
    } catch (e) {
      setStatus({ error: e.message });
    }
  };

  const onKeyDown = (e) => {
    if (e.defaultPrevented) return; // a cell's own list handled it
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') {
      if (!row.amount && !row.heading && !row.description) onClose?.();
      else { setRow(r => blank(r)); setStatus(null); }
    }
  };

  return (
    <div
      className={`tx-row sheet-entry-row ${withBalances ? 'with-bal' : ''}`}
      style={{ gridTemplateColumns: gridColumns, minWidth: tableMinWidth }}
      onKeyDown={onKeyDown}
    >
      <span className="sheet-entry-mark" title="New transaction: fill the cells, press Enter">+</span>
      <span className="tx-date">
        <input
          className={`sheet-cell ${dateInvalid ? 'invalid' : ''}`}
          value={dateText}
          placeholder="d/m/yy"
          aria-label="Date (d/m/yy)"
          title="Day/month, year optional: 25/9 or 25/9/26"
          onChange={e => {
            setDateText(e.target.value);
            const iso = parseDisplayDate(e.target.value);
            if (iso) set('date')(iso);
          }}
          onBlur={() => { if (!dateInvalid) setDateText(toDisplayDate(row.date)); }}
        />
      </span>
      <span className="tx-account">
        <SheetSelect
          label="Account"
          value={row.account}
          onChange={set('account')}
          options={accountOptions}
          renderValue={renderAccount}
        />
      </span>
      <span className="tx-type-cell">
        <SheetSelect
          label="Type"
          className="sheet-type"
          value={row.type}
          onChange={set('type')}
          options={TYPE_OPTIONS}
          renderValue={renderType}
        />
      </span>
      <span className="tx-month sheet-derived">{month}</span>
      <span className={`tx-amount ${row.type === 'Credit' ? 'pos' : ''}`}>
        <input
          ref={amountRef}
          className={`sheet-cell ${row.amount && evaluated === null ? 'invalid' : ''}`}
          value={row.amount}
          placeholder="0"
          inputMode="decimal"
          aria-label="Amount"
          onChange={e => set('amount')(e.target.value)}
          onBlur={() => { if (evaluated !== null && evaluated !== '' && String(evaluated) !== row.amount) set('amount')(String(evaluated)); }}
        />
      </span>
      <span className="tx-heading">
        <SheetSuggest
          label="Category"
          value={row.heading}
          onChange={set('heading')}
          options={categoriesForType(row.type, meta.categories_by_type, categories)}
          placeholder="Category"
        />
      </span>
      <span className="tx-desc">
        <SheetSuggest
          label="Note"
          value={row.description}
          onChange={set('description')}
          options={descriptionOptions(row.type, row.heading, descriptionIndex)}
          placeholder="Note"
        />
      </span>
      <span className="tx-actions sheet-entry-actions">
        {status === 'saving' ? <span className="sheet-entry-status">Saving…</span>
          : status === 'saved' ? <span className="sheet-entry-status ok">✓ Saved</span>
          : status?.error ? <span className="sheet-entry-status err" title={status.error}>⚠ Failed</span>
          : <span className={`sheet-entry-status ${valid ? 'ready' : ''}`}>{valid ? '↵ Enter' : ''}</span>}
        <button className="sheet-entry-close" onClick={onClose} title="Close (Esc on an empty row)">✕</button>
      </span>
      {withBalances && (
        <span
          className={`tx-balance sheet-derived ${belowMin ? 'below' : ''}`}
          title={projected != null ? `${row.account} after this entry${belowMin ? ` · below the ${fmt(acc.min_balance)} minimum` : ''}` : undefined}
        >
          {projected != null && row.amount ? fmt(projected) : ''}
        </span>
      )}
    </div>
  );
}
