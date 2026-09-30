import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiPost } from '../../api/money';
import { fmt, getBankEmoji } from '../../utils';

const MAX_NAME = 50;
const CARD_PINK = '#ec4899';

/**
 * "HDFC" for a savings account; "CC-AXIS REWARDS" for a card, whatever was typed before it.
 * In capitals like the others, as the field shows it.
 */
function finalName(typed, creditCard) {
  const name = typed.trim().split(/\s+/).filter(Boolean).join(' ').toUpperCase();
  if (!creditCard) return name;
  const bare = name.replace(/^CC[\s-]*/i, '').trim();
  return bare ? `CC-${bare}` : '';
}

const amount = (text) => {
  const t = String(text).trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Adds a savings account (with its balance now and an optional minimum) or a
 * credit card (named CC-…, like the others). The phone's "Add an account" sheet, on the web.
 */
export default function AddAccountModal({ existingNames, onClose, onAdded }) {
  const [creditCard, setCreditCard] = useState(false);
  const [name, setName] = useState('');
  const [balance, setBalance] = useState('');
  const [minimum, setMinimum] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState('');

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const final = finalName(name, creditCard);
  const nameProblem = !name.trim() ? null
    : !creditCard && /^cc/i.test(name.trim()) ? 'Names starting with CC are for credit cards'
    : !final ? 'Give the card a name'
    : final.length > MAX_NAME ? `Keep it under ${MAX_NAME} characters`
    : existingNames.has(final.toLowerCase()) ? `You already have ${final}`
    : null;
  const balanceValue = amount(balance);
  const minValue = amount(minimum);
  const amountProblem = creditCard ? null
    : Number.isNaN(balanceValue) ? 'The balance must be a number'
    : Number.isNaN(minValue) ? 'The minimum must be a number'
    : minValue != null && minValue < 0 ? "The minimum can't be negative"
    : null;
  const canAdd = final && !nameProblem && !amountProblem && !saving;

  const edit = (setter) => (e) => { setter(e.target.value); setServerError(''); };

  const submit = async (e) => {
    e?.preventDefault();
    if (!canAdd) return;
    setSaving(true);
    setServerError('');
    try {
      const res = await apiPost('/accounts', {
        name: final,
        type: creditCard ? 'credit_card' : 'savings',
        balance: creditCard ? null : balanceValue,
        min_balance: creditCard ? null : minValue,
      });
      if (!res || !res.success) throw new Error(res?.message || "Couldn't add the account");
      onAdded(res.account);
    } catch (err) {
      setServerError(err.message);
      setSaving(false);
    }
  };

  const accent = creditCard ? CARD_PINK : 'var(--accent)';
  const shownName = final || (creditCard ? 'CC-YOUR CARD' : 'YOUR BANK');

  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !saving) onClose(); }}>
      <form className="modal-content st-modal" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="add-account-title">
        <div className="modal-header">
          <div>
            <div className="modal-title" id="add-account-title">Add an account</div>
            <div className="st-modal-sub">It shows up everywhere straight away, on the web and the phone.</div>
          </div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="st-modal-body">
          <div className="st-type-grid" role="radiogroup" aria-label="Type">
            {[
              [false, '🏦', 'Savings account', 'Tracks its balance'],
              [true, '💳', 'Credit card', 'Spends on credit'],
            ].map(([card, icon, title, sub]) => (
              <button
                type="button"
                key={title}
                role="radio"
                aria-checked={creditCard === card}
                className={`st-type ${creditCard === card ? 'on' : ''} ${card ? 'card' : ''}`}
                onClick={() => { setCreditCard(card); setServerError(''); }}
              >
                <span className="st-type-icon">{icon}</span>
                <b>{title}</b>
                <span>{sub}</span>
              </button>
            ))}
          </div>

          <div className="st-preview" style={{ '--acc': accent }}>
            <span className="st-acc-badge">{creditCard ? '💳' : getBankEmoji(final || 'x')}</span>
            <span className="st-preview-text">
              <b className={final ? '' : 'placeholder'}>{shownName}</b>
              <span>
                {creditCard ? 'Credit card'
                  : minValue != null && !Number.isNaN(minValue) ? `Min ${fmt(minValue)}`
                  : 'Savings account'}
              </span>
            </span>
            {!creditCard && <span className="st-preview-balance">{fmt(Number.isNaN(balanceValue) ? 0 : balanceValue ?? 0)}</span>}
          </div>

          <label className="st-field">
            <span className="st-label">{creditCard ? 'Card name' : 'Account name'}</span>
            <span className={`st-input-wrap ${nameProblem ? 'invalid' : ''}`}>
              {creditCard && <span className="st-affix">CC-</span>}
              <input
                autoFocus
                value={name}
                onChange={edit(setName)}
                maxLength={MAX_NAME + 3}
                placeholder={creditCard ? 'AXIS REWARDS' : 'HDFC'}
                style={{ textTransform: 'uppercase' }}
              />
            </span>
            {nameProblem && <span className="st-hint error">{nameProblem}</span>}
          </label>

          {!creditCard ? (
            <div className="st-field-pair">
              <label className="st-field">
                <span className="st-label">Current balance</span>
                <span className="st-input-wrap">
                  <span className="st-affix">₹</span>
                  <input inputMode="decimal" value={balance} onChange={edit(setBalance)} placeholder="0" />
                </span>
                <span className="st-hint">What's in it right now. Transactions move it from here.</span>
              </label>
              <label className="st-field">
                <span className="st-label">Minimum balance <em>(optional)</em></span>
                <span className="st-input-wrap">
                  <span className="st-affix">₹</span>
                  <input inputMode="decimal" value={minimum} onChange={edit(setMinimum)} placeholder="2000" />
                </span>
                <span className="st-hint">Get an alert when a transaction takes it below this.</span>
              </label>
            </div>
          ) : (
            <p className="st-note">Spends are recorded against the card. Its balance stays at ₹0, so it doesn't change your totals.</p>
          )}

          {(amountProblem || serverError) && <div className="st-error">{serverError || amountProblem}</div>}
        </div>

        <div className="st-modal-foot">
          <button type="button" className="action-btn secondary" onClick={onClose} disabled={saving}>Cancel</button>
          <button type="submit" className="action-btn" disabled={!canAdd}>
            {saving ? 'Adding…' : creditCard ? 'Add card' : 'Add account'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
