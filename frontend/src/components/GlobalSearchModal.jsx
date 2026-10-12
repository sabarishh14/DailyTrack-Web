import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { TABS, API } from '../constants';
import { getToken } from '../utils';
import { apiPost } from '../api/money';
import { searchMatches } from '../utils/search';

const GlobalSearchModal = ({ isOpen, onClose, onNavigate, onEditTx, onAction, getToken, enableNagapandi, tabs = TABS, canSearchMoney = false, canToggleBalances = false }) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatResponse, setChatResponse] = useState(null);
  const inputRef = useRef(null);
  const [txResults, setTxResults] = useState([]);

  // Transactions are searched on the server (description, category or amount),
  // debounced so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const term = query.trim();
    if (!isOpen || !canSearchMoney || term.length < 2) { setTxResults([]); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      apiPost('/transactions/query', { filters: { search: term }, sort_by: 'date', sort_dir: 'desc', limit: 10 })
        .then(res => { if (!cancelled && res.success) setTxResults(res.transactions); })
        .catch(() => { });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query, isOpen, canSearchMoney]);

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setActiveIndex(0);
      setChatResponse(null);
      setChatLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const q = query.toLowerCase();

  const navMatches = tabs.filter(t => searchMatches(t.label, q) || t.id.toString() === q)
    .map(t => ({ type: 'NAV', id: `nav-${t.id}`, label: `Go to ${t.label}`, action: () => onNavigate(t.id), icon: t.icon }));

  const quickActions = [
    { type: 'ACTION', id: 'act-1', label: 'Toggle Theme', action: () => onAction('theme'), icon: '🎨' },
    ...(canToggleBalances ? [{ type: 'ACTION', id: 'act-2', label: 'Toggle Balances Visibility', action: () => onAction('balances'), icon: '👁️' }] : []),
  ].filter(a => searchMatches(a.label, q));

  const txMatches = q ? txResults.map(t => ({
    type: 'TX', id: `tx-${t.id}`,
    label: `${t.description || t.heading} (₹${t.amount}) • ${t.heading} • ${new Date(t.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}`,
    action: () => onEditTx(t),
    icon: '💸'
  })) : [];

  const handleAskAI = async () => {
    if (!query.trim()) return;
    setChatLoading(true);
    setChatResponse(null);
    try {
      const res = await fetch(`${API}/chat`, {
        method: "POST",
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ query })
      });
      const data = await res.json();
      setChatResponse(data.success ? data.result : data.message);
    } catch (e) {
      setChatResponse("Failed to connect to Nagapandi.");
    }
    setChatLoading(false);
  };

  const aiMatch = (enableNagapandi && q.length > 2) ? [{
    type: 'NAGAPANDI',
    id: 'ai-ask',
    label: `Ask Nagapandi: "${query}"`,
    action: handleAskAI,
    icon: '✨'
  }] : [];

  const results = [...aiMatch, ...navMatches, ...quickActions, ...txMatches];

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(prev => (prev + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => (prev - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (results[activeIndex]) {
        if (results[activeIndex].type === 'NAGAPANDI') {
          results[activeIndex].action();
        } else {
          results[activeIndex].action();
          onClose();
        }
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="global-search-backdrop" onClick={onClose}>
      <div className="global-search-container" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="global-search-input"
          placeholder="Search anywhere or ask Nagapandi... (Cmd+K)"
          value={query}
          onChange={e => { setQuery(e.target.value); setActiveIndex(0); setChatResponse(null); }}
          onKeyDown={handleKeyDown}
        />

        {chatLoading && (
          <div className="nagapandi-response loading" style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text2)' }}>
            <span style={{ display: 'inline-block', animation: 'spin 1s linear infinite', marginRight: '8px' }}>✨</span> Nagapandi is thinking...
          </div>
        )}

        {chatResponse && (
          <div className="nagapandi-response" style={{ padding: '1.5rem', background: 'var(--bg2)', borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, color: 'var(--accent)', marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '1.2rem' }}>✨</span> Nagapandi
            </div>
            <div style={{ color: 'var(--text)', lineHeight: 1.5 }}>{chatResponse}</div>
          </div>
        )}

        {(!chatLoading && !chatResponse) && (
          <div className="global-search-results">
            {results.length === 0 && <div style={{ padding: '1rem', color: 'var(--text2)' }}>No results found.</div>}
            {results.map((res, idx) => (
              <div
                key={res.id}
                className={`global-search-item ${idx === activeIndex ? 'active' : ''}`}
                onClick={() => {
                  if (res.type === 'NAGAPANDI') res.action();
                  else { res.action(); onClose(); }
                }}
                onMouseEnter={() => setActiveIndex(idx)}
              >
                <span style={{ marginRight: '10px' }}>{res.icon}</span>
                <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: res.type === 'NAGAPANDI' ? 600 : 400 }}>{res.label}</span>
                <span style={{ marginLeft: 'auto', fontSize: '0.7rem', color: res.type === 'NAGAPANDI' ? '#fff' : 'var(--text2)', background: res.type === 'NAGAPANDI' ? 'linear-gradient(45deg, #a855f7, #ec4899)' : 'var(--bg3)', padding: '2px 6px', borderRadius: '4px' }}>{res.type}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
export default GlobalSearchModal;
