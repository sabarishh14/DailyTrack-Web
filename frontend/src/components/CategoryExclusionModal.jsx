import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { API } from '../constants';
import { getToken } from '../utils';
import { searchRank } from '../utils/search';

export default function CategoryExclusionModal({ excludedHeadings = [], allHeadings, onClose, onRefresh }) {
  const [loadingCat, setLoadingCat] = useState(null);
  const [search, setSearch] = useState("");

  // 1. Compute exclusion status for all categories (Prevents recalculating during sorts)
  const exclusionMap = useMemo(() => {
    const excluded = new Set(excludedHeadings);
    const map = {};
    allHeadings.forEach(cat => { map[cat] = excluded.has(cat); });
    return map;
  }, [allHeadings, excludedHeadings]);

  // 2. Filter by search, then sort (Excluded items at the top, then Alphabetical)
  const displayHeadings = useMemo(() => {
    return searchRank(allHeadings, search)
      .sort((a, b) => {
        if (exclusionMap[a] && !exclusionMap[b]) return -1; // 'a' is excluded, move up
        if (!exclusionMap[a] && exclusionMap[b]) return 1;  // 'b' is excluded, move up
        return a.localeCompare(b); // Alphabetical tie-breaker
      });
  }, [allHeadings, search, exclusionMap]);

  const toggleCategory = async (heading, currentExcluded) => {
    setLoadingCat(heading);
    try {
      const res = await fetch(`${API}/transactions/category/exclude`, {
        method: "PUT",
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ heading, exclude: !currentExcluded })
      });
      if (res.ok) {
        onRefresh();
      } else {
        alert("Failed to update category.");
      }
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      setLoadingCat(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px' }}>
        <div className="modal-header">
          <div className="modal-title">⚙️ Manage Categories</div>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {/* Search Bar */}
        <div style={{ padding: '1rem 1.5rem 0' }}>
          <input
            className="inp"
            placeholder="🔍 Search categories..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>

        <div className="modal-body" style={{ maxHeight: '60vh', overflowY: 'auto', padding: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text2)', marginBottom: '1.5rem', lineHeight: 1.6, background: 'rgba(99,102,241,0.05)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(99,102,241,0.1)' }}>
            Exclude entire categories from the Spending Analyser pie chart and statistics.
            <br /><br /><strong style={{ color: 'var(--accent)' }}>✨ Magic Feature:</strong> If a category is hidden here, any <i>new</i> transactions you log in this category will be automatically excluded in the future!
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {displayHeadings.map(cat => {
              const isExcluded = exclusionMap[cat];

              return (
                <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', background: 'var(--bg2)', borderRadius: '10px', border: '1px solid var(--border)' }}>
                  <span style={{ fontSize: '0.95rem', color: isExcluded ? 'var(--text3)' : 'var(--text)', fontWeight: 600, textDecoration: isExcluded ? 'line-through' : 'none', transition: 'all 0.2s' }}>
                    {cat}
                  </span>
                  <button
                    onClick={() => toggleCategory(cat, isExcluded)}
                    disabled={loadingCat === cat}
                    style={{
                      width: '46px', height: '26px', borderRadius: '13px',
                      background: isExcluded ? 'var(--border2)' : 'var(--pos)',
                      position: 'relative', border: 'none', cursor: loadingCat === cat ? 'wait' : 'pointer', transition: 'background 0.2s',
                      opacity: loadingCat === cat ? 0.5 : 1, flexShrink: 0
                    }}
                  >
                    <div style={{
                      width: '20px', height: '20px', borderRadius: '50%', background: '#fff',
                      position: 'absolute', top: '3px',
                      left: isExcluded ? '3px' : '23px',
                      transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                      boxShadow: '0 2px 5px rgba(0,0,0,0.2)'
                    }} />
                  </button>
                </div>
              );
            })}

            {displayHeadings.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text3)', fontSize: '0.9rem' }}>
                No categories found matching "{search}"
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
