import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { API } from '../constants';
import { getToken } from '../utils';
import { searchRank } from '../utils/search';

export default function TagPillInput({ value, onChange }) {
  const [inputVal, setInputVal] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [allTags, setAllTags] = useState([]);
  const [isOpen, setIsOpen] = useState(false);
  const wrapperRef = useRef(null);

  const tags = Array.isArray(value) ? value : [];

  useEffect(() => {
    fetch(`${API}/movies/tags`, { headers: { 'Authorization': `Bearer ${getToken()}` } })
      .then(r => r.json())
      .then(d => { if (d.success) setAllTags(d.tags); })
      .catch(e => console.error(e));
  }, []);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) setIsOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (e) => {
    const val = e.target.value;
    if (val.includes(',')) {
      const newTags = val.split(',').map(t => t.trim()).filter(Boolean);
      if (newTags.length > 0) {
        onChange([...tags, ...newTags]);
      }
      setInputVal('');
      setIsOpen(false);
    } else {
      setInputVal(val);
      if (val.trim()) {
        const filtered = searchRank(allTags, val).filter(t => !tags.includes(t));
        setSuggestions(filtered);
        setIsOpen(filtered.length > 0);
      } else {
        setIsOpen(false);
      }
    }
  };

  const removeTag = (indexToRemove) => {
    onChange(tags.filter((_, i) => i !== indexToRemove));
  };

  const addSuggestion = (tag) => {
    if (!tags.includes(tag)) {
      onChange([...tags, tag]);
    }
    setInputVal('');
    setIsOpen(false);
  };

  const [activeIndex, setActiveIndex] = useState(-1);

  useEffect(() => {
    if (!isOpen) setActiveIndex(-1);
  }, [isOpen]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' }}>
      {tags.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {tags.map((t, i) => (
            <div key={i} style={{ background: 'var(--accent)', color: '#fff', padding: '4px 10px', borderRadius: '16px', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '6px' }}>
              {t}
              <span onClick={() => removeTag(i)} style={{ cursor: 'pointer', fontWeight: 'bold' }}>×</span>
            </div>
          ))}
        </div>
      )}
      <div ref={wrapperRef} style={{ position: 'relative' }}>
        <input
          type="text"
          className="bulk-inp"
          placeholder="Add tag and press comma..."
          value={inputVal}
          onChange={handleInputChange}
          onKeyDown={e => {
            if (isOpen && suggestions.length > 0) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : prev));
                return;
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(prev => (prev > 0 ? prev - 1 : -1));
                return;
              } else if (e.key === 'Enter' && activeIndex >= 0) {
                e.preventDefault();
                addSuggestion(suggestions[activeIndex]);
                return;
              } else if (e.key === 'Escape') {
                setIsOpen(false);
                return;
              }
            }
            if (e.key === 'Enter' && inputVal.trim()) {
              e.preventDefault();
              addSuggestion(inputVal.trim());
            }
          }}
          style={{ width: '100%', maxWidth: '400px' }}
        />
        {isOpen && (
          <div className="custom-dropdown" style={{ maxWidth: '400px' }}>
            {suggestions.map((s, idx) => (
              <div
                key={s}
                className={`custom-dropdown-item ${idx === activeIndex ? 'active-item' : ''}`}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => addSuggestion(s)}
              >
                {s}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
