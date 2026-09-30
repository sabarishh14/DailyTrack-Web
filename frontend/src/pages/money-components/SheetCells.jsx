import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAccountOptions } from '../../api/money';
import { evaluateMath, getBankEmoji } from '../../utils';

// Spreadsheet-style cells for the transactions table: they look like the
// table's own text until focused, and open the app's dropdown list.

export const TX_TYPES = ['Debit', 'Credit', 'Savings', 'Investment'];
export const TYPE_OPTIONS = TX_TYPES.map(t => ({ value: t, label: t }));

export const renderAccount = (v) => (
  <span className="sheet-account-value">
    <span>{getBankEmoji(v)}</span>
    <span>{v}</span>
  </span>
);
export const renderType = (v) => <span className={`tx-badge ${v.toLowerCase()}`}>{v}</span>;

// The table shows dates as d/m/yy, so the cells read and take the same.
const pad = (n) => String(n).padStart(2, '0');
export const toDisplayDate = (iso) => {
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  return `${d}/${m}/${String(y).slice(2)}`;
};
// "25/9", "25/9/26", "25-09-2026" → "2026-09-25"; null if it isn't a real date.
export const parseDisplayDate = (text) => {
  const parts = text.trim().split(/[/.-]/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 3 || parts.some(p => !/^[0-9]+$/.test(p))) return null;
  const [d, m] = parts.map(Number);
  let y = parts[2] ? Number(parts[2]) : new Date().getFullYear();
  if (y < 100) y += 2000;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

// Where a portaled list opens: under the cell, or above it near the bottom.
function listPosition(el) {
  const rect = el.getBoundingClientRect();
  const below = rect.bottom + 260 < window.innerHeight;
  return {
    position: 'fixed',
    left: `${rect.left}px`,
    minWidth: `${Math.max(rect.width, 160)}px`,
    top: below ? `${rect.bottom + 2}px` : 'auto',
    bottom: below ? 'auto' : `${window.innerHeight - rect.top + 2}px`,
    zIndex: 999999,
  };
}

// Shows its value as text and opens the app's dropdown list. Enter/Space
// opens; ↑/↓ step through values without opening, like a sheet. [autoOpen]
// opens it on mount (editing an existing cell); [onDismiss] fires when the
// list closes without a pick.
export function SheetSelect({ value, options, onChange, label, renderValue, className = '', autoOpen = false, onDismiss }) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState({});
  const cellRef = useRef(null);
  const listRef = useRef(null);
  const current = options.find(o => o.value === value);

  const openList = () => { setStyle(listPosition(cellRef.current)); setOpen(true); };
  const closeList = () => { setOpen(false); onDismiss?.(); };

  useEffect(() => {
    if (autoOpen) { cellRef.current?.focus(); openList(); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (!cellRef.current?.contains(e.target) && !listRef.current?.contains(e.target)) closeList();
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }); // re-bound each render so it sees the current onDismiss

  const step = (dir) => {
    const i = options.findIndex(o => o.value === value);
    onChange(options[(i + dir + options.length) % options.length].value);
  };

  return (
    <>
      <button
        ref={cellRef}
        type="button"
        className={`sheet-cell sheet-select ${className} ${open ? 'open' : ''}`}
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={(e) => {
          if (e.key === ' ' || (e.key === 'Enter' && !open)) { e.preventDefault(); open ? closeList() : openList(); }
          else if (e.key === 'ArrowDown' && !open) { e.preventDefault(); step(1); }
          else if (e.key === 'ArrowUp' && !open) { e.preventDefault(); step(-1); }
          else if (e.key === 'Escape' && open) { e.preventDefault(); closeList(); }
        }}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="sheet-select-value">{renderValue ? renderValue(value) : (current?.label ?? value)}</span>
        <span className="sheet-select-caret">▾</span>
      </button>
      {open && createPortal(
        <div className="chip-dropdown portaled" ref={listRef} style={style} role="listbox">
          {options.map(o => (
            <div
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              className={`chip-dropdown-item ${o.value === value ? 'included' : ''}`}
              onClick={() => { setOpen(false); onChange(o.value); cellRef.current?.focus(); }}
            >
              <div className={`chip-checkbox ${o.value === value ? 'included' : ''}`} style={{ borderRadius: '50%' }} />
              <span>{o.label}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

// A text cell with suggestions in the app's dropdown list. ↑/↓ move through
// them and Enter picks (marking the key handled, so it doesn't also save).
export function SheetSuggest({ value, onChange, options, placeholder, label, inputRef, autoFocus = false, onBlur }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [style, setStyle] = useState({});
  const ref = useRef(null);
  const setRefs = (el) => { ref.current = el; if (inputRef) inputRef.current = el; };

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const starts = options.filter(o => o.toLowerCase().startsWith(q));
    const contains = options.filter(o => !o.toLowerCase().startsWith(q) && o.toLowerCase().includes(q));
    return [...starts, ...contains].filter(o => o !== value).slice(0, 8);
  }, [value, options]);

  const show = () => { setStyle(listPosition(ref.current)); setOpen(true); setActive(-1); };
  useEffect(() => { if (autoFocus) { ref.current?.focus(); ref.current?.select(); } }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <input
        ref={setRefs}
        className="sheet-cell"
        value={value}
        placeholder={placeholder}
        aria-label={label}
        onFocus={show}
        onChange={(e) => { onChange(e.target.value); show(); }}
        onBlur={() => { setTimeout(() => setOpen(false), 150); onBlur?.(); }}
        onKeyDown={(e) => {
          if (!open || matches.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, matches.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, -1)); }
          else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); onChange(matches[active]); setOpen(false); }
          else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
        }}
      />
      {open && matches.length > 0 && createPortal(
        <div className="chip-dropdown portaled" style={style} role="listbox">
          {matches.map((m, i) => (
            <div
              key={m}
              role="option"
              aria-selected={i === active}
              className={`chip-dropdown-item ${i === active ? 'included' : ''}`}
              onMouseDown={(e) => { e.preventDefault(); onChange(m); setOpen(false); }}
              onMouseEnter={() => setActive(i)}
            >
              <span>{m}</span>
            </div>
          ))}
        </div>,
        document.body
      )}
    </>
  );
}

/**
 * Editing one cell of an existing transaction. Enter or leaving the cell
 * saves, Tab / Shift+Tab save and move to the next / previous cell, Esc
 * cancels. Pickers (account, type) save on pick.
 */
export function CellEditor({ tx, field, suggestions = [], onCommit, onCancel }) {
  const accountOptions = useAccountOptions(tx.account);
  const initial = field === 'date' ? toDisplayDate(tx.date)
    : field === 'amount' ? String(tx.amount)
    : String(tx[field] ?? '');
  const [draft, setDraft] = useState(initial);
  const done = useRef(false);
  const inputRef = useRef(null);

  // The value to save, or undefined while the draft isn't valid.
  const parsed = () => {
    if (field === 'date') return parseDisplayDate(draft) ?? undefined;
    if (field === 'amount') {
      const v = parseFloat(evaluateMath(draft) ?? draft);
      return !isNaN(v) && v > 0 ? v : undefined;
    }
    if (field === 'heading') return draft.trim() || undefined;
    return draft.trim();
  };
  const finish = (move = 0, fromBlur = false) => {
    if (done.current) return;
    const value = parsed();
    // Invalid: keep editing (the cell shows it) — unless the user clicked away.
    if (value === undefined) { if (fromBlur) cancel(); return; }
    done.current = true;
    onCommit(value, move);
  };
  const cancel = () => { if (!done.current) { done.current = true; onCancel(); } };

  useEffect(() => {
    if (field === 'date' || field === 'amount') { inputRef.current?.focus(); inputRef.current?.select(); }
  }, [field]);

  const onKeyDown = (e) => {
    if (e.defaultPrevented) return;
    if (e.key === 'Enter') { e.preventDefault(); finish(0); }
    else if (e.key === 'Tab') { e.preventDefault(); finish(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  if (field === 'account' || field === 'type') {
    return (
      <div className="sheet-editor" onKeyDown={onKeyDown}>
        <SheetSelect
          autoOpen
          label={field}
          value={tx[field]}
          options={field === 'account' ? accountOptions : TYPE_OPTIONS}
          renderValue={field === 'account' ? renderAccount : renderType}
          className={field === 'type' ? 'sheet-type' : ''}
          onChange={(v) => { if (!done.current) { done.current = true; onCommit(v, 0); } }}
          onDismiss={cancel}
        />
      </div>
    );
  }
  const invalid = parsed() === undefined;
  if (field === 'heading' || field === 'description') {
    return (
      <div className={`sheet-editor ${invalid ? 'invalid' : ''}`} onKeyDown={onKeyDown}>
        <SheetSuggest
          autoFocus
          label={field}
          value={draft}
          onChange={setDraft}
          options={suggestions}
          onBlur={() => setTimeout(() => finish(0, true), 160)}
        />
      </div>
    );
  }
  return (
    <div className="sheet-editor" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className={`sheet-cell ${invalid ? 'invalid' : ''}`}
        value={draft}
        inputMode={field === 'amount' ? 'decimal' : undefined}
        aria-label={field}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => finish(0, true)}
      />
    </div>
  );
}
