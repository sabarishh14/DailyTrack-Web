import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';
import { searchRank } from '../utils/search';


export default function CustomSelect({ value, onChange, options, icon, placeholder, width = 'auto', minWidth = '120px' }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const containerRef = useRef(null);
  const dropdownRef = useRef(null);
  const [dropdownStyle, setDropdownStyle] = useState({});

  useEffect(() => {
    const handleClickOutside = (e) => {
      // Close if clicking outside the button AND outside the portal dropdown
      if (
        containerRef.current && !containerRef.current.contains(e.target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(e.target))
      ) {
        setIsOpen(false);
      }
    };

    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEsc);

    // 🚨 REMOVED the window.addEventListener('scroll') because it instantly 
    // closes the dropdown on mobile when trying to swipe through the options!

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, []);

  const toggleDropdown = (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();

      const clientWidth = document.documentElement.clientWidth;
      // Smart Alignment: Align right if there isn't enough space (~300px) on the left
      const isRightSide = rect.left + 300 > clientWidth;
      // Smart Vertical: Open upwards if there's no space below (assuming max dropdown height ~300px)
      const isOffBottom = rect.bottom + 300 > window.innerHeight;

      setDropdownStyle({
        position: 'fixed',
        top: isOffBottom ? 'auto' : `${rect.bottom + 4}px`,
        bottom: isOffBottom ? `${window.innerHeight - rect.top + 4}px` : 'auto',
        left: isRightSide ? 'auto' : `${rect.left}px`,
        right: isRightSide ? `${clientWidth - rect.right}px` : 'auto',
        minWidth: `${rect.width}px`,
        maxWidth: isRightSide ? `${rect.right - 16}px` : `${clientWidth - rect.left - 16}px`,
        zIndex: 999999
      });
    }
    setIsOpen(!isOpen);
  };

  const filtered = searchRank(options, searchTerm, o => (typeof o === 'object' ? o.label : o));

  const displayValue = options.find(o => (typeof o === 'object' ? o.value : o) === value);
  const displayLabel = displayValue ? (typeof displayValue === 'object' ? displayValue.label : displayValue) : placeholder;

  return (
    <div style={{ position: 'relative', width }} ref={containerRef}>
      <button
        className={`filter-chip ${isOpen ? 'open' : ''}`}
        onClick={toggleDropdown}
        style={{
          width: '100%', minWidth, justifyContent: 'space-between', padding: '0.45rem 0.85rem',
          height: '36px', borderRadius: '8px', margin: 0,
          border: isOpen ? '1px solid var(--accent)' : '1px solid var(--border)',
          color: isOpen ? 'var(--accent)' : 'var(--text)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
          {icon && <span>{icon}</span>}
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 }}>{displayLabel}</span>
        </div>
        <span className="chip-arrow">▼</span>
      </button>

      {isOpen && createPortal(
        <div
          className="chip-dropdown portaled"
          ref={dropdownRef}
          style={{ ...dropdownStyle }}
        >
          {options.length > 5 && (
            <div className="chip-search-container">
              <input type="text" placeholder="Search..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="chip-search-input" onClick={e => e.stopPropagation()} />
            </div>
          )}
          {filtered.map((opt, i) => {
            const val = typeof opt === 'object' ? opt.value : opt;
            const lbl = typeof opt === 'object' ? opt.label : opt;
            const isSelected = val === value;
            return (
              <div
                key={i}
                className={`chip-dropdown-item ${isSelected ? 'selected' : ''}`}
                onClick={() => { onChange(val); setIsOpen(false); setSearchTerm(""); }}
                // ⬇️ FIXED: Removed the massive inline padding so CSS can correctly shrink the rows
                style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.3' }}
              >
                <div className={`chip-checkbox ${isSelected ? 'included' : ''}`} style={{ borderRadius: '50%', flexShrink: 0, marginTop: '1px' }} />
                <span style={{ flex: 1, fontWeight: isSelected ? 700 : 500, color: isSelected ? 'var(--text)' : 'var(--text2)' }}>{lbl}</span>
              </div>
            );
          })}
          {filtered.length === 0 && <div style={{ padding: '0.75rem', textAlign: 'center', color: 'var(--text2)', fontSize: '0.8rem' }}>No results found</div>}
        </div>,
        document.body
      )}
    </div>
  );
}
