import { useState } from 'react';
import { API, BANKS } from '../constants';
import { fmt, getToken, isCcAccount, balanceDelta, evaluateMath, getBankEmoji, accountColor } from '../utils';

// How close a balance is to its floor: 'danger' below it, 'warn' within half
// the floor above it, otherwise 'ok'. Without a floor, only overdraft warns.
export function balanceLevel(after, min) {
  if (min !== null && min !== undefined) {
    if (after < min) return 'danger';
    if (after < min * 1.5) return 'warn';
    return 'ok';
  }
  return after < 0 ? 'danger' : 'ok';
}

// How close a card's spending this month is to its budget: 'danger' over it,
// 'warn' from 80% of it, otherwise 'ok'. Without a budget nothing warns.
export function cardLevel(used, budget) {
  if (budget === null || budget === undefined) return 'ok';
  if (used > budget) return 'danger';
  if (used >= budget * 0.8) return 'warn';
  return 'ok';
}

const currentMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

// Like projectBalances, for credit cards: account -> { before, after } of each
// card's spending this month as the draft rows would leave it (a Credit is a
// refund and takes it back down). Rows dated in another month don't touch it.
export function projectCards(rows, accounts) {
  const byName = Object.fromEntries((accounts || []).map(a => [a.account, a]));
  const month = currentMonth();
  const out = {};
  for (const row of rows) {
    const acc = byName[row.account];
    if (!acc || !isCcAccount(row.account) || acc.used_this_month == null) continue;
    if (!String(row.date || '').startsWith(month)) continue;
    const entry = out[row.account] || (out[row.account] = { before: acc.used_this_month, after: acc.used_this_month });
    const evaluated = evaluateMath(row.amount);
    // Money out of a savings account is money onto the card.
    entry.after = Math.max(0, entry.after - balanceDelta(row.type, evaluated !== null && evaluated !== '' ? evaluated : row.amount));
  }
  return out;
}

// Totals the draft rows per account. Returns account -> { before, after } for
// every tracked account a row uses — picking the account is enough, so its
// balance shows before an amount is typed.
export function projectBalances(rows, accounts) {
  const byName = Object.fromEntries((accounts || []).map(a => [a.account, a]));
  const out = {};
  for (const row of rows) {
    const acc = byName[row.account];
    if (!acc || !acc.balance_tracked || acc.balance == null || isCcAccount(row.account)) continue;
    const entry = out[row.account] || (out[row.account] = { before: acc.balance, after: acc.balance });
    const evaluated = evaluateMath(row.amount);
    entry.after += balanceDelta(row.type, evaluated !== null && evaluated !== '' ? evaluated : row.amount);
  }
  return out;
}

function FloorBar({ before, after, min, level }) {
  const top = Math.max(before, after, min ?? 0, 1);
  const fill = Math.max(0, Math.min(100, (after / top) * 100));
  const floor = min != null ? Math.min(100, (min / top) * 100) : null;
  return (
    <div className="bal-bar" aria-hidden="true">
      <div className={`bal-bar-fill ${level}`} style={{ width: `${fill}%` }} />
      {floor !== null && <div className="bal-bar-floor" style={{ left: `${floor}%` }} />}
    </div>
  );
}

function floorNote(after, min, level) {
  if (min == null) return level === 'danger' ? 'Overdrawn' : null;
  if (level === 'danger') return `${fmt(min - after)} below your ${fmt(min)} minimum`;
  return `${fmt(after - min)} above minimum`;
}

// Only the balances that matter right now: accounts the drafts use (with where
// they'll land), the ones the last save moved, and any already under its floor.
// Credit cards the same way, by their spending this month against their budget.
export function BalancesPanel({ accounts, projected, saved, projectedCards = {}, savedCards }) {
  const order = Object.keys(BANKS);
  const savedBy = Object.fromEntries((saved || []).map(b => [b.account, b]));
  const savedCardsBy = Object.fromEntries((savedCards || []).map(c => [c.account, c]));
  const shown = (accounts || [])
    .filter(a => a.balance_tracked && a.balance != null && !isCcAccount(a.account))
    .filter(a => projected[a.account] || savedBy[a.account] || balanceLevel(a.balance, a.min_balance ?? null) === 'danger')
    .sort((a, b) => {
      const ia = order.indexOf(a.account), ib = order.indexOf(b.account);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib) || a.account.localeCompare(b.account);
    });
  const cardsShown = (accounts || [])
    .filter(a => isCcAccount(a.account) && a.used_this_month != null)
    .filter(a => projectedCards[a.account] || savedCardsBy[a.account] || cardLevel(a.used_this_month, a.monthly_budget ?? null) === 'danger')
    .sort((a, b) => a.account.localeCompare(b.account));
  if (shown.length === 0 && cardsShown.length === 0) return null;

  return (
    <div className="bal-panel">
      {shown.map(a => {
        const min = a.min_balance ?? null;
        const draft = projected[a.account];
        const recent = !draft && savedBy[a.account];
        const before = draft ? draft.before : recent ? recent.before : a.balance;
        const after = draft ? draft.after : recent ? recent.after : a.balance;
        const delta = after - before;
        const moved = Boolean(recent) || delta !== 0;
        const level = balanceLevel(after, min);
        const note = floorNote(after, min, level);
        return (
          <div
            key={a.account}
            className={`bal-chip ${level} ${draft ? 'drafting' : ''} ${moved ? 'moved' : ''}`}
            style={{ '--acc-color': accountColor(a.account) }}
            title={note ? `${a.account} · ${note}` : a.account}
          >
            <div className="bal-chip-top">
              <span className="bal-chip-acc">{getBankEmoji(a.account)} {a.account}</span>
              {moved && delta !== 0 && (
                <span className={`bal-chip-delta ${delta < 0 ? 'neg' : 'pos'}`}>
                  {delta < 0 ? '−' : '+'}{fmt(Math.abs(delta))}{recent ? ' saved' : ''}
                </span>
              )}
            </div>
            <div className="bal-chip-value">
              {draft && delta !== 0 && <span className="bal-muted">{fmt(before)} →</span>}
              <b>{level === 'danger' && moved ? '⚠ ' : ''}{fmt(after)}</b>
            </div>
            {(moved || min != null) && <FloorBar before={Math.max(before, after)} after={after} min={min} level={level} />}
          </div>
        );
      })}
      {cardsShown.map(a => {
        const budget = a.monthly_budget ?? null;
        const draft = projectedCards[a.account];
        const recent = !draft && savedCardsBy[a.account];
        const before = draft ? draft.before : recent ? recent.before : a.used_this_month;
        const after = draft ? draft.after : recent ? recent.after : a.used_this_month;
        const delta = after - before;
        const moved = Boolean(recent) || delta !== 0;
        const level = cardLevel(after, budget);
        const note = budget == null ? null
          : level === 'danger' ? `${fmt(after - budget)} over your ${fmt(budget)} monthly budget`
          : `${fmt(budget - after)} left of your ${fmt(budget)} monthly budget`;
        return (
          <div
            key={a.account}
            className={`bal-chip ${level} ${draft ? 'drafting' : ''} ${moved ? 'moved' : ''}`}
            style={{ '--acc-color': accountColor(a.account) }}
            title={note ? `${a.account} · ${note}` : `${a.account} · used this month`}
          >
            <div className="bal-chip-top">
              <span className="bal-chip-acc">{getBankEmoji(a.account)} {a.account}</span>
              {moved && delta !== 0 && (
                // More used on a card is money going out.
                <span className={`bal-chip-delta ${delta > 0 ? 'neg' : 'pos'}`}>
                  {delta > 0 ? '+' : '−'}{fmt(Math.abs(delta))}{recent ? ' saved' : ''}
                </span>
              )}
            </div>
            <div className="bal-chip-value">
              {draft && delta !== 0 && <span className="bal-muted">{fmt(before)} →</span>}
              <b>{level === 'danger' && moved ? '⚠ ' : ''}{fmt(after)}</b>
              <span className="bal-muted"> used this month</span>
            </div>
            {/* Filling towards the budget; once over, the tick marks where it was. */}
            {budget != null && <FloorBar before={budget} after={after} min={budget} level={level} />}
          </div>
        );
      })}
    </div>
  );
}

// One amount saved on an account (field: its minimum or a card's monthly
// budget), shown as a chip that turns into an input when clicked. Editable
// only for full-money users; blank clears it.
function AccountAmountChip({ account, field, value: saved, editable, onSaved, inputLabel, label, emptyLabel, hint, noun }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(saved ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = String(value).trim();
    if (trimmed !== '' && isNaN(parseFloat(trimmed))) return;
    setSaving(true);
    try {
      const res = await fetch(`${API}/accounts`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ account, [field]: trimmed === '' ? null : parseFloat(trimmed) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Server returned ${res.status}`);
      }
      setEditing(false);
      onSaved?.();
    } catch (e) {
      alert(`Could not save ${noun}: ${e.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <div className="min-chip editing" onClick={e => e.stopPropagation()}>
        <span>{inputLabel} ₹</span>
        <input
          autoFocus type="number" inputMode="decimal" value={value} placeholder="none"
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false); }}
          disabled={saving}
        />
        <button onClick={save} disabled={saving} title="Save">{saving ? '…' : '✓'}</button>
      </div>
    );
  }
  if (saved == null && !editable) return null;
  return (
    <button
      className="min-chip"
      disabled={!editable}
      onClick={() => { setValue(saved ?? ''); setEditing(true); }}
      title={editable ? hint : undefined}
    >
      {saved != null ? label : emptyLabel}
    </button>
  );
}

// The floor under an account card.
export function MinBalanceChip({ account, min, editable, onSaved }) {
  return (
    <AccountAmountChip
      account={account} field="min_balance" value={min} editable={editable} onSaved={onSaved}
      inputLabel="Min" label={min != null ? `Min ${fmt(min)}` : null} emptyLabel="+ Set minimum"
      hint="Set the minimum balance to keep in this account" noun="minimum"
    />
  );
}

// A credit card's monthly budget, read against what it's been used for this month.
export function CardBudgetChip({ account, budget, used, editable, onSaved }) {
  const over = budget != null && used > budget;
  return (
    <AccountAmountChip
      account={account} field="monthly_budget" value={budget} editable={editable} onSaved={onSaved}
      inputLabel="Budget"
      label={budget == null ? null : over ? `⚠ ${fmt(used - budget)} over ${fmt(budget)}` : `of ${fmt(budget)} budget`}
      emptyLabel="+ Set monthly budget"
      hint="Set the most to spend on this card in a month; it starts again on the 1st" noun="budget"
    />
  );
}
