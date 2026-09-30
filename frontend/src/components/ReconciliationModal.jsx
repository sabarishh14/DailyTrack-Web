import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { API } from '../constants';
import { getToken, fmt, getBankEmoji, accountColor } from '../utils';

export default function ReconciliationModal({ accounts, onClose, onRefresh }) {
  const [scanning, setScanning] = useState(false);

  const scanBalances = async () => {
    setScanning(true);
    try {
      const res = await fetch(`${API}/sync/ocr-balances`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await res.json();
      alert(data.message);
      if (data.success) onRefresh();
    } catch (e) {
      alert("Error: " + e.message + "\n(This might take a moment, check back later)");
    } finally {
      setScanning(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '750px', width: '95%' }}>
        <div className="modal-header">
          <div className="modal-title">⚖️ Reconcile Balances</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body" style={{ padding: '1.5rem', overflowY: 'auto', maxHeight: '70vh' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '1rem' }}>
            <div style={{ fontSize: '0.85rem', color: 'var(--text2)', maxWidth: '400px', lineHeight: 1.5 }}>
              Upload UPI screenshots to your specific Drive folder, then click Scan to detect discrepancies.
            </div>
            <button className="action-btn" onClick={scanBalances} disabled={scanning} style={{ background: 'linear-gradient(135deg, #a855f7 0%, #7e22ce 100%)' }}>
              {scanning ? '⏳ Scanning Drive...' : '📸 Scan Screenshots'}
            </button>
          </div>

          <div className="reconcile-list">
            {accounts.filter(a => a.balance_tracked && a.account !== 'CC-PINNACLE 6360').map((acc) => {
              const tracked = acc.balance || 0;
              const real = acc.real_balance;
              const diff = real !== null && real !== undefined ? tracked - real : null;

              let status = "";
              let statusClass = "";

              if (diff === null) {
                status = "Not Scanned";
                statusClass = "unscanned";
              } else if (diff === 0) {
                status = "✅ Matched";
                statusClass = "matched";
              } else if (diff < 0) {
                // C4 - D4 < 0: Move money OUT of real account
                status = `🔴 Reduce ${fmt(Math.abs(diff))}`;
                statusClass = "reduce";
              } else {
                // C4 - D4 > 0: Move money INTO real account
                status = `🟢 Increase ${fmt(Math.abs(diff))}`;
                statusClass = "increase";
              }

              return (
                <div key={acc.account} className="reconcile-row" style={{ '--accent': accountColor(acc.account) }}>
                  <div className="reconcile-row-id">
                    <span className="acc-emoji">{getBankEmoji(acc.account)}</span>
                    <div className="reconcile-row-text">
                      <span className="reconcile-account-name">{acc.account}</span>
                      <span className="reconcile-row-figures">
                        {fmt(tracked)}
                        <span className="reconcile-arrow">→</span>
                        <span style={{ color: real !== null ? 'var(--accent2)' : 'var(--text3)' }}>
                          {real !== null ? fmt(real) : "—"}
                        </span>
                      </span>
                    </div>
                  </div>
                  <span className={`reconcile-status-badge ${statusClass}`}>{status}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
