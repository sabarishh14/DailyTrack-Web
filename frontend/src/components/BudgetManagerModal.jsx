import { useState, useMemo, useEffect } from "react";
import { API } from '../constants';
import { getToken, fmt } from '../utils';
import { searchRank } from '../utils/search';

export default function BudgetManagerModal({ allHeadings, budgets, onClose, onRefresh }) {
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [suggestions, setSuggestions] = useState({});

  // Initialize local state from the passed budgets prop
  const [localBudgets, setLocalBudgets] = useState(() => {
    const map = {};
    budgets.forEach(b => {
      map[b.category] = b.monthly_limit;
    });
    return map;
  });

  // Suggested budgets, computed server-side from spending history. Purely
  // additive — if this fails or is slow, the modal works exactly as before.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API}/budgets/suggestions`, {
      headers: { 'Authorization': `Bearer ${getToken()}` }
    })
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (!cancelled && data?.success) setSuggestions(data.suggestions || {});
      })
      .catch(() => {}); // suggestions are a bonus, never block or error out the modal
    return () => { cancelled = true; };
  }, []);

  // Only surface a suggestion when it actually differs from what's set now
  const suggestionFor = (cat) => {
    const s = suggestions[cat]?.suggested;
    if (s == null) return null;
    const current = parseFloat(localBudgets[cat]);
    if (!isNaN(current) && Math.abs(current - s) < 1) return null;
    return s;
  };

  const handleValueChange = (cat, val) => {
    setLocalBudgets(prev => ({
      ...prev,
      [cat]: val
    }));
  };

  const handleSaveAll = async () => {
    setSaving(true);
    try {
      const payload = Object.entries(localBudgets).map(([category, val]) => ({
        category,
        monthly_limit: val === "" || val === null ? null : parseFloat(val)
      }));

      const res = await fetch(`${API}/budgets/bulk`, {
        method: "PUT",
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        onRefresh();
        onClose();
      } else {
        alert("Failed to save budgets.");
      }
    } catch (err) {
      alert("Error: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  // Filter by search, sort categories with active budgets to top, then alphabetical
  const displayHeadings = useMemo(() => {
    return searchRank(allHeadings, search)
      .sort((a, b) => {
        const aHasBudget = localBudgets[a] > 0;
        const bHasBudget = localBudgets[b] > 0;
        if (aHasBudget && !bHasBudget) return -1;
        if (!aHasBudget && bHasBudget) return 1;
        return a.localeCompare(b); 
      });
  }, [allHeadings, search, localBudgets]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-content" onClick={e => e.stopPropagation()} style={{ maxWidth: '500px', padding: 0, display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header" style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div className="modal-title" style={{ fontSize: '1.2rem', color: 'var(--text)', fontWeight: 600 }}>🎯 Manage Budgets</div>
          <button className="modal-close" onClick={onClose} style={{ background: 'transparent', border: 'none', color: 'var(--text2)', fontSize: '1.5rem', cursor: 'pointer' }}>×</button>
        </div>

        <div style={{ padding: '1.5rem 1.5rem 0' }}>
          <input
            className="inp"
            placeholder="🔍 Search categories..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', padding: '0.6rem 1rem', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text)' }}
          />
        </div>

        <div className="modal-body" style={{ maxHeight: '50vh', overflowY: 'auto', padding: '1.5rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text2)', marginBottom: '1.5rem', lineHeight: 1.6, background: 'rgba(99,102,241,0.05)', padding: '1rem', borderRadius: '8px', border: '1px solid rgba(99,102,241,0.1)' }}>
            Set monthly budget limits for your categories. Leave blank or 0 to remove a budget goal.
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {displayHeadings.map(cat => (
              <div key={cat} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.8rem 1.25rem', background: 'var(--bg2)', borderRadius: '10px', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
                  <span style={{ fontSize: '0.95rem', color: 'var(--text)', fontWeight: 600 }}>
                    {cat}
                  </span>
                  {suggestionFor(cat) != null && (
                    <button
                      type="button"
                      onClick={() => handleValueChange(cat, suggestionFor(cat))}
                      title={`Based on the last ${suggestions[cat].months_of_history} months of spending in this category`}
                      style={{ alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '4px', background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: '0.78rem', color: 'var(--accent)' }}
                    >
                      <span aria-hidden="true">✦</span> Suggest {fmt(suggestionFor(cat))}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text2)', fontSize: '0.9rem' }}>₹</span>
                  <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                    <input
                      type="number"
                      className="no-spinners"
                      value={localBudgets[cat] || ''}
                      onChange={e => handleValueChange(cat, e.target.value)}
                      placeholder="0"
                      style={{
                        width: '100px',
                        background: 'var(--bg-input)',
                        border: '1px solid var(--border)',
                        color: 'var(--text)',
                        padding: '0.4rem 1.8rem 0.4rem 0.6rem',
                        borderRadius: '6px',
                        fontSize: '0.9rem',
                        textAlign: 'right'
                      }}
                    />
                    {localBudgets[cat] && (
                      <button
                        onClick={() => handleValueChange(cat, '')}
                        style={{
                          position: 'absolute',
                          right: '6px',
                          background: 'rgba(255,255,255,0.1)',
                          border: 'none',
                          color: 'var(--text2)',
                          cursor: 'pointer',
                          borderRadius: '50%',
                          width: '16px',
                          height: '16px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '10px'
                        }}
                        title="Clear"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                </div>
              </div>
            ))}

            {displayHeadings.length === 0 && (
              <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--text3)', fontSize: '0.9rem' }}>
                No categories found matching "{search}"
              </div>
            )}
          </div>
        </div>
        
        <div className="modal-footer" style={{ padding: '1.25rem 1.5rem', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end', gap: '1rem', background: 'var(--bg2)', borderRadius: '0 0 var(--radius-lg) var(--radius-lg)' }}>
          <button className="action-btn secondary" onClick={onClose} disabled={saving} style={{ padding: '0.5rem 1rem', background: 'transparent', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '8px', cursor: 'pointer' }}>Cancel</button>
          <button className="action-btn" onClick={handleSaveAll} disabled={saving} style={{ padding: '0.5rem 1rem', background: 'var(--accent)', border: 'none', color: '#fff', borderRadius: '8px', cursor: 'pointer', fontWeight: 600 }}>
            {saving ? 'Saving...' : 'Save Budgets'}
          </button>
        </div>
      </div>
    </div>
  );
}
