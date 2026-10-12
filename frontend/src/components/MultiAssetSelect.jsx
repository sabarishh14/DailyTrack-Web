import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';
import { searchRank } from '../utils/search';


export default function MultiAssetSelect({ selectedAssets, setSelectedAssets, options, placeholder }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const containerRef = useRef(null);
  const dropdownRef = useRef(null);
  const [dropdownStyle, setDropdownStyle] = useState({});

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (
        containerRef.current && !containerRef.current.contains(e.target) &&
        (!dropdownRef.current || !dropdownRef.current.contains(e.target))
      ) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleDropdown = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const isMobile = window.innerWidth <= 768;
      const isOffBottom = rect.bottom + 300 > window.innerHeight;
      const topStyle = isOffBottom ? 'auto' : `${rect.bottom + 4}px`;
      const bottomStyle = isOffBottom ? `${window.innerHeight - rect.top + 4}px` : 'auto';

      const clientWidth = document.documentElement.clientWidth;

      if (isMobile) {
        setDropdownStyle({
          position: 'fixed',
          top: topStyle,
          bottom: bottomStyle,
          left: '16px',
          right: '16px',
          width: 'auto',
          maxWidth: `${clientWidth - 32}px`,
          zIndex: 999999
        });
      } else {
        const isRightSide = rect.left + 300 > clientWidth;
        setDropdownStyle({
          position: 'fixed',
          top: topStyle,
          bottom: bottomStyle,
          left: isRightSide ? 'auto' : `${rect.left}px`,
          right: isRightSide ? `${clientWidth - rect.right}px` : 'auto',
          minWidth: `${rect.width}px`,
          maxWidth: isRightSide ? `${rect.right - 16}px` : `${clientWidth - rect.left - 16}px`,
          zIndex: 999999
        });
      }
    }
    setIsOpen(!isOpen);
  };

  const filtered = searchRank(options, searchTerm);

  return (
    <div style={{ position: 'relative', width: '100%' }} ref={containerRef}>
      <button
        className={`filter-chip ${isOpen ? 'open' : ''} ${selectedAssets.size > 0 ? 'active' : ''}`}
        onClick={toggleDropdown}
        style={{ width: '100%', minWidth: '180px', justifyContent: 'space-between', padding: '0.45rem 0.85rem', height: '36px', borderRadius: '8px', margin: 0 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
          <span>🎯</span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: 600 }}>
            {selectedAssets.size === 0 ? placeholder : `${selectedAssets.size} Selected`}
          </span>
        </div>
        <span className="chip-arrow">▼</span>
      </button>

      {isOpen && createPortal(
        <div className="chip-dropdown portaled" ref={dropdownRef} style={{ ...dropdownStyle, maxHeight: '300px' }}>

          {/* 🚀 STICKY HEADER GROUP */}
          <div style={{ position: 'sticky', top: '-0.375rem', zIndex: 10, background: 'var(--card)', margin: '-0.375rem -0.375rem 0.2rem -0.375rem', borderRadius: '12px 12px 0 0', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
            {options.length > 5 && (
              <div style={{ padding: '0.4rem 0.5rem' }}>
                <input type="text" placeholder="Search..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="chip-search-input" onClick={e => e.stopPropagation()} />
              </div>
            )}
            {selectedAssets.size > 0 && (
              <div
                className="chip-dropdown-item"
                onClick={(e) => { e.stopPropagation(); setSelectedAssets(new Set()); setIsOpen(false); setSearchTerm(""); }}
                style={{ fontWeight: 600, color: 'var(--neg)', justifyContent: 'center', borderRadius: 0, padding: '0.6rem 0.5rem', borderTop: options.length > 5 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}
              >
                ✕ Clear Selection
              </div>
            )}
          </div>

          {filtered.map(sym => {
            const isSelected = selectedAssets.has(sym);
            return (
              <div
                key={sym}
                className="chip-dropdown-item"
                onClick={(e) => {
                  e.stopPropagation();
                  const next = new Set(selectedAssets);
                  if (next.has(sym)) next.delete(sym); else next.add(sym);
                  setSelectedAssets(next);
                }}
                style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', whiteSpace: 'normal', wordBreak: 'break-word', lineHeight: '1.3' }}
              >
                {/* 4px border radius for square multi-select checkboxes */}
                <div className={`chip-checkbox ${isSelected ? 'included' : ''}`} style={{ borderRadius: '4px', flexShrink: 0, marginTop: '1px' }} />
                <span style={{ flex: 1, fontWeight: isSelected ? 700 : 500, color: isSelected ? 'var(--text)' : 'var(--text2)' }}>{sym}</span>
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
