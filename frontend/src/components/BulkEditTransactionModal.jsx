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

export default function BulkEditTransactionModal({ transactions, categories, onClose, onRefresh, isCopy }) {
  const meta = useLatestMoneyMeta().data || EMPTY_META;
  const descriptionIndex = useMemo(() => buildDescriptionIndex(meta.descriptions), [meta.descriptions]);
  // Pre-fill the grid with all selected transactions
  const [rows, setRows] = useState(
    transactions.map(tx => ({
      ...tx,
      date: isCopy ? new Date().toISOString().split('T')[0] : (tx.date ? new Date(tx.date).toISOString().split('T')[0] : ''),
      exclude_analytics: isCopy ? (tx.exclude_analytics || false) : (tx.exclude_analytics || false)
    }))
  );
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  const updateRow = (id, field, value) => {
    setRows(rows.map(row => row.id === id ? { ...row, [field]: value } : row));
  };

  const submit = async () => {
    const evaluatedRows = rows.map(r => {
      const eAmt = evaluateMath(r.amount);
      return { ...r, amount: eAmt !== null ? eAmt : r.amount };
    });
    setRows(evaluatedRows);

    for (let i = 0; i < evaluatedRows.length; i++) {
      if (rows[i].amount && evaluateMath(rows[i].amount) === null) {
        return alert(`Row ${i + 1} has an invalid math calculation in the amount field.`);
      }
      if (!evaluatedRows[i].amount || isNaN(evaluatedRows[i].amount) || !evaluatedRows[i].heading.trim()) {
        return alert(`Row ${i + 1} is missing a valid amount or category.`);
      }
    }
    setLoading(true);
    try {
      const payload = evaluatedRows.map(r => ({ ...r, amount: parseFloat(r.amount), exclude_analytics: r.exclude_analytics }))
      const url = isCopy ? `${API}/transactions` : `${API}/transactions/bulk-edit`;
      const method = isCopy ? "POST" : "PUT";

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        onRefresh();
        setSuccess(true);
        setTimeout(() => { setSuccess(false); onClose(); }, 1500);
      } else {
        alert(isCopy ? "Failed to duplicate transactions." : "Failed to update transactions.");
      }
    } catch (e) {
      alert("Network error: " + e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content bulk-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <div className="modal-title">{isCopy ? '📋 Bulk Duplicate Transactions' : '✏️ Bulk Edit Transactions'}</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body bulk-modal-body" style={{ maxHeight: '70vh', overflowY: 'auto', padding: '1rem' }}>

          <div className="bulk-grid bulk-header">
            <span>Account</span><span>Date</span><span>Type</span><span>Category</span><span>Amount (₹)</span><span>Note</span><span style={{ textAlign: 'center' }} title="Exclude from Analyser">🙈</span>
          </div>

          {rows.map((row) => (
            <div key={row.id} className="bulk-grid bulk-row" style={{ animation: 'fadeIn 0.2s ease' }}>
              <CustomSelect
                value={row.account}
                onChange={val => updateRow(row.id, 'account', val)}
                options={accountOptions([...meta.accounts, row.account])}
                minWidth="140px"
              />
              <input type="date" className="bulk-inp" style={{ height: '36px' }} value={row.date} onChange={e => updateRow(row.id, 'date', e.target.value)} />
              <CustomSelect
                value={row.type}
                onChange={val => updateRow(row.id, 'type', val)}
                options={[
                  { label: '🔴 Debit', value: 'Debit' },
                  { label: '🟢 Credit', value: 'Credit' },
                  { label: '💰 Savings', value: 'Savings' },
                  { label: '💸 Investment', value: 'Investment' }
                ]}
                minWidth="130px"
              />
              <AutocompleteInput value={row.heading} onChange={val => updateRow(row.id, 'heading', val)} options={categoriesForType(row.type, meta.categories_by_type, categories)} placeholder="Category" />              <input type="text" className={`bulk-inp ${row.amount && evaluateMath(row.amount) === null ? 'invalid-math' : ''}`} placeholder="0.00" value={row.amount} onChange={e => updateRow(row.id, 'amount', e.target.value)} onBlur={e => {
                const evalAmt = evaluateMath(e.target.value);
                if (evalAmt !== null && evalAmt !== '') updateRow(row.id, 'amount', evalAmt);
              }} />
              <AutocompleteInput value={row.description || ''} onChange={val => updateRow(row.id, 'description', val)} options={descriptionOptions(row.type, row.heading, descriptionIndex)} placeholder="Optional note..." />

              <div className="bulk-actions-wrapper">
                <button
                  className="bulk-hide-btn"
                  onClick={() => updateRow(row.id, 'exclude_analytics', !row.exclude_analytics)}
                  style={{
                    background: row.exclude_analytics ? 'rgba(239, 68, 68, 0.15)' : 'var(--bg3)',
                    border: row.exclude_analytics ? '1px solid var(--neg)' : '1px solid var(--border)',
                    color: row.exclude_analytics ? 'var(--neg)' : 'var(--text2)',
                    borderRadius: '8px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', height: '40px', padding: 0, transition: 'all 0.2s', margin: 0, width: '100%'
                  }}
                  title={row.exclude_analytics ? "Excluded from Analytics" : "Included in Analytics"}
                >
                  {row.exclude_analytics ? '🙈' : '👁️'}
                </button>
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
            <button className={`action-btn ${success ? 'success' : ''}`} onClick={submit} disabled={loading} style={{ flex: 1, justifyContent: 'center' }}>
              {loading ? "Saving..." : success ? "✅ Saved!" : (isCopy ? `📋 Duplicate All (${rows.length})` : `💾 Save All (${rows.length})`)}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}
