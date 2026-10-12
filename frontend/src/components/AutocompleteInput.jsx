import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';
import { searchRank } from '../utils/search';


export default function AutocompleteInput({ value, onChange, options, placeholder, className, onBlur }) {
  const [filtered, setFiltered] = useState([]);
  const [show, setShow] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const listRef = useRef(null);

  useEffect(() => {
    if (activeIndex >= 0 && listRef.current) {
      const activeEl = listRef.current.children[activeIndex];
      if (activeEl) {
        activeEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [activeIndex]);

  const handleType = (e) => {
    const val = e.target.value;
    onChange(val);
    setFiltered(searchRank(options, val));
    setShow(true);
    setActiveIndex(-1);
  };

  const handleKeyDown = (e) => {
    if (!show) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault(); // Prevents cursor from moving
      setActiveIndex(prev => (prev < filtered.length - 1 ? prev + 1 : prev));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(prev => (prev > 0 ? prev - 1 : -1));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      onChange(filtered[activeIndex]);
      setShow(false);
      setActiveIndex(-1);
    } else if (e.key === 'Escape') {
      setShow(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '40px' }}>
      <input
        type="text" className={`bulk-inp${className ? ' ' + className : ''}`} placeholder={placeholder}
        value={value} onChange={handleType} onKeyDown={handleKeyDown}
        onFocus={() => {
          setFiltered(searchRank(options, value));
          setShow(true);
        }}
        onBlur={() => {
          setTimeout(() => { setShow(false); setActiveIndex(-1); }, 200);
          if (onBlur) onBlur();
        }}
      />
      {show && filtered.length > 0 && (
        <div className="custom-dropdown" ref={listRef}>
          {filtered.map((opt, idx) => (
            <div
              key={opt}
              className={`custom-dropdown-item ${idx === activeIndex ? 'active-item' : ''}`}
              onClick={() => { onChange(opt); setShow(false); setActiveIndex(-1); }}
              onMouseEnter={() => setActiveIndex(idx)}
            >
              {opt}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
