import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { searchRank } from '../../utils/search';

// Multi-select dropdown component (3-State Logic: neutral -> included -> excluded -> neutral)
export default function MultiSelectDropdown({ label, icon, options, filterState, setFilterState, dropdownKey, openDropdown, setOpenDropdown }) {
  const [searchTerm, setSearchTerm] = useState("");
  const { included, excluded } = filterState;
  const containerRef = useRef(null);
  const [dropdownStyle, setDropdownStyle] = useState({});

  // Clear search and set position when dropdown opens/closes
  useEffect(() => {
    if (openDropdown !== dropdownKey) {
      setSearchTerm("");
    } else if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const clientWidth = document.documentElement.clientWidth;
      const isRightSide = rect.left + 300 > clientWidth;
      const isOffBottom = rect.bottom + 300 > window.innerHeight;

      setDropdownStyle({
        position: 'fixed',
        top: isOffBottom ? 'auto' : `${rect.bottom + 4}px`,
        bottom: isOffBottom ? `${window.innerHeight - rect.top + 4}px` : 'auto',
        left: isRightSide ? 'auto' : `${rect.left}px`,
        right: isRightSide ? `${window.innerWidth - rect.right}px` : 'auto',
        minWidth: `${rect.width}px`,
        maxWidth: isRightSide ? `calc(100vw - ${window.innerWidth - rect.right + 16}px)` : `calc(100vw - ${rect.left + 16}px)`,
        zIndex: 999999
      });
    }
  }, [openDropdown, dropdownKey]);

  const filteredOptions = searchRank(options, searchTerm, String)
    .sort((a, b) => {
      const aSelected = included.has(a) || excluded.has(a);
      const bSelected = included.has(b) || excluded.has(b);
      if (aSelected && !bSelected) return -1;
      if (!aSelected && bSelected) return 1;
      return 0;
    });
  const allSelected = included.size === options.length && options.length > 0;

  // 3-State Toggle: Neutral -> Included -> Excluded -> Neutral
  const handleItemClick = (opt) => {
    const newInc = new Set(included);
    const newExc = new Set(excluded);

    if (newInc.has(opt)) {
      newInc.delete(opt);
      newExc.add(opt);
    } else if (newExc.has(opt)) {
      newExc.delete(opt);
    } else {
      newInc.add(opt);
    }
    setFilterState({ included: newInc, excluded: newExc });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setFilterState({ included: new Set(), excluded: new Set() });
    } else {
      setFilterState({ included: new Set(options), excluded: new Set() });
    }
  };

  const hasSelection = included.size > 0 || excluded.size > 0;
  const isExcludeOnly = included.size === 0 && excluded.size > 0;

  return (
    <div style={{ position: 'relative' }} ref={containerRef}>
      <button
        className={`filter-chip ${hasSelection ? (isExcludeOnly ? 'exclude-active' : 'active') : ''} ${openDropdown === dropdownKey ? 'open' : ''}`}
        onClick={() => setOpenDropdown(openDropdown === dropdownKey ? null : dropdownKey)}
      >
        <span>{icon}</span>
        <span style={{ textDecoration: isExcludeOnly ? 'line-through' : 'none', opacity: isExcludeOnly ? 0.8 : 1 }}>{label}</span>

        {/* Dual Status Counters */}
        {included.size > 0 && <span className="chip-count inc">{included.size}</span>}
        {excluded.size > 0 && <span className="chip-count exc">{excluded.size}</span>}

        {hasSelection && (
          <span
            className="chip-clear"
            onClick={(e) => { e.stopPropagation(); setFilterState({ included: new Set(), excluded: new Set() }); }}
            title="Clear filter"
          >
            ×
          </span>
        )}
        <span className="chip-arrow">▼</span>
      </button>

      {openDropdown === dropdownKey && createPortal(
        <div className="chip-dropdown portaled" style={{ ...dropdownStyle, maxHeight: '350px' }}>

          {/* 🚀 STICKY HEADER GROUP */}
          <div style={{ position: 'sticky', top: '-0.375rem', zIndex: 10, background: 'var(--card)', margin: '-0.375rem -0.375rem 0.2rem -0.375rem', borderRadius: '12px 12px 0 0', borderBottom: '1px solid var(--border)', display: 'flex', flexDirection: 'column' }}>
            <div className="chip-helper-text" style={{ margin: '0.4rem 0.5rem 0' }}>
              Tap once to include • Tap again to exclude
            </div>

            {options.length > 5 && (
              <div style={{ padding: '0.4rem 0.5rem' }}>
                <input
                  type="text"
                  placeholder={`Search ${label}...`}
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  className="chip-search-input"
                  onClick={e => e.stopPropagation()}
                />
              </div>
            )}
            {options.length > 0 && (
              <div
                className="chip-dropdown-item chip-select-all"
                onClick={toggleSelectAll}
                style={{ fontWeight: 600, borderRadius: 0, padding: '0.6rem 0.65rem', borderTop: options.length > 5 ? '1px solid rgba(255,255,255,0.05)' : 'none' }}
              >
                <div className={`chip-checkbox ${allSelected ? 'included' : ''}`} />
                <span>{allSelected ? 'Clear All' : 'Select All'}</span>
              </div>
            )}
          </div>

          {filteredOptions.map(opt => (
            <div
              key={opt}
              className={`chip-dropdown-item ${included.has(opt) ? 'included' : ''} ${excluded.has(opt) ? 'excluded' : ''}`}
              onClick={() => handleItemClick(opt)}
            >
              <div className={`chip-checkbox ${included.has(opt) ? 'included' : ''} ${excluded.has(opt) ? 'excluded' : ''}`} />
              <span>{opt}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}
