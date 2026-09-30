import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { API } from '../constants';
import { accountOptions, evaluateMath, getToken, buildDescriptionIndex, categoriesForType, descriptionOptions } from '../utils';
import { useLatestMoneyMeta, EMPTY_META } from '../api/money';
import CustomSelect from './CustomSelect';
import AutocompleteInput from './AutocompleteInput';

export default function EditTransactionModal({ tx, categories, onClose, onRefresh, isCopy }) {
  const meta = useLatestMoneyMeta().data || EMPTY_META;
  const descriptionIndex = useMemo(() => buildDescriptionIndex(meta.descriptions), [meta.descriptions]);
  const [form, setForm] = useState({
    date: isCopy ? new Date().toISOString().split('T')[0] : (tx.date ? new Date(tx.date).toISOString().split('T')[0] : ''),
    account: tx.account,
    type: tx.type,
    heading: tx.heading,
    amount: tx.amount,
    description: tx.description || '',
    exclude_analytics: tx.exclude_analytics || false
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);


  const updateField = (field, value) => setForm(prev => ({ ...prev, [field]: value }));

  const submit = async () => {
    const eAmt = evaluateMath(form.amount);
    const finalForm = { ...form, amount: eAmt !== null ? eAmt : form.amount };
    setForm(finalForm);

    if (form.amount && evaluateMath(form.amount) === null) {
      return alert("The amount field contains an invalid math calculation.");
    }
    if (!finalForm.amount || isNaN(finalForm.amount) || !finalForm.heading.trim()) {
      return alert("Missing a valid amount or category.");
    }
    setLoading(true);
    try {
      const url = isCopy ? `${API}/transactions` : `${API}/transactions/${tx.id}`;
      const method = isCopy ? "POST" : "PUT";
      const payload = isCopy ? [{ ...finalForm, amount: parseFloat(finalForm.amount) }] : { ...finalForm, amount: parseFloat(finalForm.amount) };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        onRefresh();
        setSuccess(true);
        setTimeout(() => { setSuccess(false); onClose(); }, 1200);
      } else {
        alert(isCopy ? "Failed to duplicate transaction." : "Failed to update transaction.");
      }
    } catch (e) {
      alert("Network error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content bulk-modal" style={{ maxWidth: '600px' }} onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{isCopy ? '📋 Duplicate Transaction' : '✏️ Edit Transaction'}</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">

          <div className="modal-form-grid">
            <div className="form-group">
              <label style={{ fontSize: '0.75rem', color: 'var(--text2)', marginBottom: '4px' }}>Account</label>
              <CustomSelect
                value={form.account}
                onChange={val => updateField('account', val)}
                options={accountOptions([...meta.accounts, tx.account])}
                width="100%"
              />
            </div>

            <div className="form-group">
              <label style={{ fontSize: '0.75rem', color: 'var(--text2)', marginBottom: '4px' }}>Date</label>
              <input type="date" className="bulk-inp" style={{ background: 'var(--card)', padding: '0.75rem', height: '36px' }} value={form.date} onChange={e => updateField('date', e.target.value)} />
            </div>

            <div className="form-group">
              <label style={{ fontSize: '0.75rem', color: 'var(--text2)', marginBottom: '4px' }}>Type</label>
              <CustomSelect
                value={form.type}
                onChange={val => updateField('type', val)}
                options={[
                  { label: '🔴 Debit', value: 'Debit' },
                  { label: '🟢 Credit', value: 'Credit' },
                  { label: '💰 Savings', value: 'Savings' },
                  { label: '💸 Investment', value: 'Investment' }
                ]}
                width="100%"
              />
            </div>

            <div className="form-group">
              <label style={{ fontSize: '0.75rem', color: 'var(--text2)', marginBottom: '4px' }}>Amount (₹)</label>
              <input type="text" className={`bulk-inp ${form.amount && evaluateMath(form.amount) === null ? 'invalid-math' : ''}`} style={{ background: 'var(--bg3)', padding: '0.75rem' }} value={form.amount} onChange={e => updateField('amount', e.target.value)} onBlur={e => {
                const evalAmt = evaluateMath(e.target.value);
                if (evalAmt !== null && evalAmt !== '') updateField('amount', evalAmt);
              }} />
            </div>

            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text2)', marginBottom: '4px' }}>Category</label>
              <AutocompleteInput value={form.heading} onChange={val => updateField('heading', val)} options={categoriesForType(form.type, meta.categories_by_type, categories)} placeholder="Category" />
            </div>

            <div className="form-group" style={{ gridColumn: 'span 2' }}>
              <label style={{ fontSize: '0.75rem', color: 'var(--text2)', marginBottom: '4px' }}>Note</label>
              <AutocompleteInput
                value={form.description}
                onChange={val => updateField('description', val)}
                options={descriptionOptions(form.type, form.heading, descriptionIndex)}
                placeholder="Optional note..."
              />
            </div>

            <div className="form-group" style={{ gridColumn: 'span 2', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '0.85rem', marginTop: '0.5rem', background: 'var(--bg3)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border)' }}>
              <div
                onClick={() => updateField('exclude_analytics', !form.exclude_analytics)}
                style={{
                  width: '44px', height: '24px', borderRadius: '12px',
                  background: form.exclude_analytics ? 'var(--neg)' : 'var(--border2)',
                  position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0
                }}
              >
                <div style={{
                  width: '18px', height: '18px', borderRadius: '50%', background: '#fff',
                  position: 'absolute', top: '3px', left: form.exclude_analytics ? '23px' : '3px',
                  transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
                }} />
              </div>
              <div>
                <div style={{ fontSize: '0.9rem', color: 'var(--text)', fontWeight: 600 }}>Exclude from Analyser</div>
                <div style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>Hide this transaction from the pie chart and stats</div>
              </div>
            </div>
          </div>

          <button className={`submit-btn ${success ? 'success' : ''}`} onClick={submit} disabled={loading} style={{ width: '100%', marginTop: '1.5rem' }}>
            {loading ? "Saving..." : success ? "✅ Saved!" : (isCopy ? "📋 Add Duplicated Transaction" : "Save Changes")}
          </button>

        </div>
      </div>
    </div>
  );
}
