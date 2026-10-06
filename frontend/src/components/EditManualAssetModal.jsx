import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { API } from '../constants';
import { getToken } from '../utils';
import CustomSelect from './CustomSelect';
import RdFields from './RdFields';

export default function EditManualAssetModal({ asset, onClose, onRefresh }) {
  const [form, setForm] = useState({
    ...asset,
    installment: asset.installment ?? '',
    is_recurring: asset.is_recurring || false,
    amount_to_add: asset.amount_to_add || '',
    interval_value: asset.interval_value || 1,
    interval_unit: asset.interval_unit || 'months',
    next_run_date: asset.next_run_date || new Date().toISOString().split('T')[0]
  });
  const [loading, setLoading] = useState(false);

  // 🚀 Determine the Asset Bucket to lock/unlock fields
  const isLedgerOrMarket = ['EPF', 'PPF', 'NPS', 'SGB', 'RSU', 'RealEstate', 'Cash'].includes(form.category);
  const isMath = ['FD', 'RD'].includes(form.category);

  const isRd = form.category === 'RD';

  const submit = async () => {
    if (isRd && (!form.installment || !form.start_date)) {
      return alert("Enter the monthly instalment and the first instalment's date.");
    }
    if (form.is_recurring && (!form.amount_to_add || !form.next_run_date)) {
      return alert("Please fill in the recurring amount and next date.");
    }
    setLoading(true);
    try {
      const res = await fetch(`${API}/manual_assets/${asset.id}`, {
        method: "PUT", headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(form)
      });
      const result = await res.json().catch(() => ({}));
      if (res.ok && result.success !== false) { onRefresh(); onClose(); }
      else alert(result.message || "Failed to update asset");
    } catch (e) { alert("Network error: " + e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()}>
        <div className="modal-header"><div className="modal-title">✏️ Edit Asset</div></div>
        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '75vh', overflowY: 'auto' }}>

          <CustomSelect
            value={form.category}
            onChange={val => {
              const becomingMath = ['FD', 'RD'].includes(val);
              const becomingMarket = ['EPF', 'PPF', 'NPS', 'SGB', 'RSU', 'RealEstate', 'Cash'].includes(val);
              setForm({
                ...form, category: val,
                interest_rate: becomingMarket ? '' : form.interest_rate,
                is_recurring: becomingMath ? false : form.is_recurring
              });
            }}
            options={['FD', 'RD', 'EPF', 'PPF', 'NPS', 'SGB', 'RSU', 'RealEstate', 'Cash'].map(c => ({ label: c, value: c }))}
            placeholder="Select Category" width="100%"
          />

          <input className="inp" placeholder="Asset Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />

          {/* An RD is its monthly instalment; the rest is worked out. */}
          {isRd ? <RdFields form={form} setForm={setForm} /> : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            {/* 1. Invested Amount */}
            <input className="inp" type="number" placeholder="Invested Amount" value={form.invested_value} onChange={e => setForm({ ...form, invested_value: e.target.value })} />

            {/* 2. Current Value (Smart & Centralized) */}
            <div style={{ position: 'relative' }}>
              <input
                className="inp" type="number" placeholder="Current Value"
                value={form.current_value}
                onChange={e => setForm({ ...form, current_value: e.target.value })}
                disabled={!!form.interest_rate}
                style={{
                  opacity: form.interest_rate ? 0.5 : 1,
                  cursor: form.interest_rate ? 'not-allowed' : 'text',
                  background: form.interest_rate ? 'var(--bg3)' : 'var(--card)'
                }}
              />
              {!!form.interest_rate && (
                <div style={{ position: 'absolute', right: '10px', top: '10px', fontSize: '0.65rem', color: 'var(--text3)' }}>Auto</div>
              )}
            </div>
          </div>
          )}

          {/* 3. Interest Rate Row */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text2)', fontWeight: 600 }}>Interest Rate %</span>
              {isLedgerOrMarket && (
                <span title="Market/Ledger assets fluctuate. Leave this blank and update Current Value manually."
                  style={{ cursor: 'help', background: 'var(--bg3)', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--text2)', border: '1px solid var(--border)' }}>?</span>
              )}
            </div>
            <input className="inp" type="number" placeholder="e.g. 7.1" value={form.interest_rate} onChange={e => setForm({ ...form, interest_rate: e.target.value })} disabled={isLedgerOrMarket} style={{ opacity: isLedgerOrMarket ? 0.3 : 1, cursor: isLedgerOrMarket ? 'not-allowed' : 'text' }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text2)', fontWeight: 600 }}>{isRd ? 'First instalment' : 'Start Date'}</span>
              <input className="inp" type="date" value={form.start_date} onChange={e => setForm({ ...form, start_date: e.target.value })} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text2)', fontWeight: 600 }}>{isRd ? 'Maturity' : 'Maturity Date'}</span>
              <input className="inp" type="date" value={form.maturity_date} onChange={e => setForm({ ...form, maturity_date: e.target.value })} />
            </div>
          </div>

          {/* Automate toggle (an RD adds its own instalments) */}
          {!isRd && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', marginTop: '0.5rem', background: 'var(--bg3)', padding: '1rem', borderRadius: '8px', border: '1px solid var(--border)', opacity: isMath ? 0.4 : 1 }}>
            <div onClick={() => !isMath && setForm({ ...form, is_recurring: !form.is_recurring })} style={{ width: '44px', height: '24px', borderRadius: '12px', background: form.is_recurring ? 'var(--pos)' : 'var(--border2)', position: 'relative', cursor: isMath ? 'not-allowed' : 'pointer', transition: 'background 0.2s', flexShrink: 0 }}>
              <div style={{ width: '18px', height: '18px', borderRadius: '50%', background: '#fff', position: 'absolute', top: '3px', left: form.is_recurring ? '23px' : '3px', transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)' }} />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <div style={{ fontSize: '0.9rem', color: 'var(--text)', fontWeight: 600 }}>Automate Recurring Additions</div>
              {isMath && (
                <span title="Math assets auto-compound daily using the Interest Rate. Recurring additions are meant for Ledger/Market assets."
                  style={{ cursor: 'help', background: 'var(--bg2)', borderRadius: '50%', width: '16px', height: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.65rem', color: 'var(--text2)', border: '1px solid var(--border)' }}>?</span>
              )}
            </div>
          </div>

          )}

          {/* New Flexbox Recurring Section */}
          {form.is_recurring && !isMath && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', padding: '1.25rem', background: 'rgba(52, 211, 153, 0.05)', border: '1px solid rgba(52, 211, 153, 0.2)', borderRadius: '8px', animation: 'fadeIn 0.2s ease' }}>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 100%' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--pos)', fontWeight: 600 }}>Amount to Add (₹)</label>
                <input className="inp" type="number" placeholder="0.00" value={form.amount_to_add} onChange={e => setForm({ ...form, amount_to_add: e.target.value })} style={{ borderColor: 'rgba(52, 211, 153, 0.3)' }} />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 220px' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--pos)', fontWeight: 600 }}>Frequency</label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', background: 'var(--card)', borderRadius: '8px', border: '1px solid rgba(52, 211, 153, 0.3)', padding: '0 0.5rem', height: '36px', flex: '1 1 80px' }}>
                    <span style={{ fontSize: '0.8rem', color: 'var(--text2)', paddingRight: '0.5rem' }}>Every</span>
                    <input type="number" min="1" value={form.interval_value} onChange={e => setForm({ ...form, interval_value: parseInt(e.target.value) })} style={{ border: 'none', width: '100%', background: 'transparent', color: 'var(--text)', outline: 'none' }} />
                  </div>
                  <div style={{ flex: '1 1 140px' }}>
                    <CustomSelect
                      value={form.interval_unit}
                      onChange={val => setForm({ ...form, interval_unit: val })}
                      options={[{ label: 'Days', value: 'days' }, { label: 'Months', value: 'months' }, { label: 'Years', value: 'years' }]}
                      placeholder="Unit"
                    />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', flex: '1 1 140px' }}>
                <label style={{ fontSize: '0.75rem', color: 'var(--pos)', fontWeight: 600 }}>Next Trigger</label>
                <input className="inp" type="date" value={form.next_run_date} onChange={e => setForm({ ...form, next_run_date: e.target.value })} style={{ borderColor: 'rgba(52, 211, 153, 0.3)', height: '36px' }} />
              </div>

            </div>
          )}

          <div style={{ display: 'flex', gap: '1rem', marginTop: '0.5rem' }}>
            <button className="submit-btn" onClick={submit} style={{ flex: 1 }}>{loading ? 'Saving...' : 'Update Asset'}</button>
            <button className="submit-btn" onClick={onClose} style={{ flex: 1, background: 'transparent', border: '1px solid var(--border2)', color: 'var(--text)' }}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
