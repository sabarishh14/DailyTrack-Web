import { useEffect, useMemo, useRef, useState } from 'react';
import { API } from '../../constants';
import { fmt, formatDate, getBankEmoji, getToken, buildDescriptionIndex, categoriesForType, descriptionOptions } from '../../utils';
import { useLatestMoneyMeta, EMPTY_META } from '../../api/money';
import { CellEditor } from './SheetCells';
import MultiSelectDropdown from './MultiSelectDropdown';
import RowsPerPageDropdown from './RowsPerPageDropdown';
import BulkEditTransactionModal from '../../components/BulkEditTransactionModal';
import SheetEntryRow from './SheetEntryRow';
import { useAccess } from '../../access/AccessContext';

let measureCtx;
/**
 * Width the Account column needs for its longest name, measured in the cell's
 * own font: emoji + gap + name + the cell's side padding (see .tx-row>span).
 */
function accountColumnWidth(names, compact) {
  if (!names.length || typeof document === 'undefined') return 0;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  const size = (compact ? 0.8 : 0.85) * rem;
  measureCtx = measureCtx || document.createElement('canvas').getContext('2d');
  if (!measureCtx) return 0;
  measureCtx.font = `500 ${size}px 'DM Sans', sans-serif`;
  const longest = Math.max(...names.map(n => measureCtx.measureText(n).width));
  const padding = (compact ? 0.9 : 1.5) * rem * 2;
  return Math.ceil(longest + size * 1.4 + 0.5 * rem + padding + 6);
}

export default function TransactionsTableSection({
  dropdownRef,
  openDropdown,
  setOpenDropdown,

  filterVisibility, setFilterVisibility,
  allAccountsList, filterAccounts, setFilterAccounts,
  allTypes, filterTypes, setFilterTypes,
  allMonths, filterMonths, setFilterMonths,
  allYears, filterYears, setFilterYears,
  allHeadings, filterHeadings, setFilterHeadings,
  allFYs, filterFY, handleFilterFYChange,
  filterDateFrom, setFilterDateFrom,
  filterDateTo, setFilterDateTo,
  setFilterFY,
  filterDesc, setFilterDesc,

  tableTotal,
  tableSums,
  tableFirstLoad = false,
  tableRefreshing = false,
  totalPages,
  paginatedRows,
  currentPage, setCurrentPage,
  rowsPerPage, setRowsPerPage,

  colWidths,
  handleStartResize,
  handleSortClick,
  sortBy,
  sortDir,

  selectedIds, setSelectedIds,
  handleSelectAll,
  handleRowSelect,
  handleRowClick,

  setActionMenuTx,
  setEditingTx,
  setCopyingTx,
  handleDelete,
  handleBulkDelete,

  isBulkEditOpen, setIsBulkEditOpen,
  isBulkCopyOpen, setIsBulkCopyOpen,

  selectedTransactions,
  categories,
  onRefresh,

  balancesAllowed = false,
  withBalances = false,
  onToggleBalances,
  accounts = [],
}) {
  const canEdit = useAccess().can('money', 'edit');
  // The entry row only shows when asked for, from the button by the page size.
  const [addingRow, setAddingRow] = useState(false);
  // Sheet-like density: same columns, tighter rows. Remembered per browser.
  const [compact, setCompact] = useState(() => {
    try { return localStorage.getItem('dt_tx_compact') === '1'; } catch { return false; }
  });
  const toggleCompact = () => setCompact(v => {
    try { localStorage.setItem('dt_tx_compact', v ? '0' : '1'); } catch { /* per-browser nicety only */ }
    return !v;
  });
  // The balance column sits right after Amount; its cell comes last in the
  // markup (see .with-bal in index.css) so the phone card layout is untouched.
  // Compact rows have less padding, so their columns shrink with them.
  const w = (col, min) => compact ? Math.max(min, Math.round(colWidths[col] * 0.8)) : colWidths[col];
  // Never narrower than the longest account name on hand (card names run long).
  const accountNames = useMemo(
    () => [...new Set([...accounts.map(a => a.account), ...paginatedRows.map(t => t.account)].filter(Boolean))],
    [accounts, paginatedRows]
  );
  const accountFit = useMemo(() => accountColumnWidth(accountNames, compact), [accountNames, compact]);
  const fixedCols = [
    w('checkbox', 40), w('date', 76), Math.max(w('account', 130), accountFit), w('type', 84), w('month', 84), w('amount', 96),
    ...(withBalances ? [compact ? 112 : 140] : []), w('heading', 100),
  ];
  const descMin = compact ? 180 : 220;
  const actionsWidth = w('actions', 90);
  const gridColumns = [...fixedCols.map(px => `${px}px`), `minmax(${descMin}px, 1fr)`, `${actionsWidth}px`].join(' ');
  // Every row gets this exact minimum, so all rows are equally wide however
  // long a description is: columns stay aligned and Actions stays inside the row.
  const tableMinWidth = fixedCols.reduce((a, b) => a + b, 0) + descMin + actionsWidth;
  // Mouse and trackpad: click selects, double-click opens (like Sheets). Touch: a tap opens.
  // View-only users have nothing to select for, so a click opens for them too.
  const sheetClicks = canEdit && typeof window !== 'undefined' &&
    window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  const minByAccount = Object.fromEntries(accounts.map(a => [a.account, a.min_balance]));

  // ── Sheet behaviour (mouse/trackpad): edit in place, keyboard, copy/paste ──
  const finePointer = typeof window !== 'undefined' && window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
  const meta = useLatestMoneyMeta().data || EMPTY_META;
  const descriptionIndex = useMemo(() => buildDescriptionIndex(meta.descriptions), [meta.descriptions]);
  const wrapRef = useRef(null);
  const [editing, setEditing] = useState(null);   // { id, field } being edited
  const [pending, setPending] = useState({});     // id -> saved-but-not-yet-reloaded values
  const [activeIdx, setActiveIdx] = useState(null); // keyboard cursor row
  const [pasteRows, setPasteRows] = useState(null); // rows for the duplicate dialog via Ctrl+V
  const copiedRef = useRef([]);
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);
  const showToast = (text) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  };

  // A reload brings the saved values, so the optimistic ones can go.
  useEffect(() => { setPending(p => (Object.keys(p).length ? {} : p)); }, [paginatedRows]);
  useEffect(() => { setActiveIdx(null); setEditing(null); }, [currentPage]);
  useEffect(() => {
    if (activeIdx == null) return;
    wrapRef.current?.querySelector(`[data-row-idx="${activeIdx}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const rows = paginatedRows.map(t => (pending[t.id] ? { ...t, ...pending[t.id] } : t));
  const EDITABLE = ['date', 'account', 'type', 'amount', 'heading', 'description'];

  const saveCell = async (tx, field, value) => {
    const payload = {
      date: String(tx.date).slice(0, 10), account: tx.account, type: tx.type, heading: tx.heading,
      description: tx.description || '', amount: Number(tx.amount), exclude_analytics: !!tx.exclude_analytics,
      [field]: value,
    };
    if (payload[field] === (field === 'date' ? String(tx.date).slice(0, 10) : tx[field] ?? '')) return;
    setPending(p => ({ ...p, [tx.id]: { ...(p[tx.id] || {}), [field]: value } }));
    try {
      const res = await fetch(`${API}/transactions/${tx.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success === false) throw new Error(data.message || `Server returned ${res.status}`);
      onRefresh?.();
    } catch (e) {
      setPending(p => { const next = { ...p }; delete next[tx.id]; return next; });
      showToast(`Couldn't save: ${e.message}`);
    }
  };
  const commitCell = (tx, field, value, move) => {
    saveCell(tx, field, value);
    const next = EDITABLE[EDITABLE.indexOf(field) + move];
    setEditing(move && next ? { id: tx.id, field: next } : null);
    if (!move || !next) wrapRef.current?.focus({ preventScroll: true });
  };

  // Tab-separated, the way Sheets and Excel paste rows.
  const copyRows = () => {
    const picked = selectedTransactions.length
      ? selectedTransactions
      : activeIdx != null && rows[activeIdx] ? [rows[activeIdx]] : [];
    if (!picked.length) return;
    const tsv = picked.map(t => {
      const [y, m, d] = String(t.date).slice(0, 10).split('-');
      const month = new Date(t.date).toLocaleString('default', { month: 'long' });
      const cols = [`${d}/${m}/${y}`, t.account, t.type, month, t.amount, t.heading, t.description || ''];
      if (withBalances) cols.push(t.balance_after ?? '');
      return cols.map(c => String(c).replace(/[\t\n]/g, ' ')).join('\t');
    }).join('\n');
    navigator.clipboard?.writeText(tsv).catch(() => {});
    copiedRef.current = picked;
    showToast(`Copied ${picked.length} ${picked.length === 1 ? 'row' : 'rows'}${canEdit ? ' · Ctrl+V to duplicate' : ''}`);
  };

  const onTableKeyDown = (e) => {
    if (!finePointer || editing) return;
    // Typing in the entry row or a cell editor isn't table navigation.
    if (e.target.closest?.('.sheet-entry-row, .sheet-editing') || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const mod = e.ctrlKey || e.metaKey;
    const last = rows.length - 1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (last < 0) return;
      e.preventDefault();
      const next = activeIdx == null ? 0 : Math.max(0, Math.min(last, activeIdx + (e.key === 'ArrowDown' ? 1 : -1)));
      setActiveIdx(next);
      if (e.shiftKey && canEdit) setSelectedIds(prev => new Set([...prev, rows[next].id, ...(activeIdx != null ? [rows[activeIdx].id] : [])]));
    } else if (e.key === ' ' && activeIdx != null && canEdit) {
      e.preventDefault();
      const id = rows[activeIdx].id;
      setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
    } else if (e.key === 'Enter' && activeIdx != null) {
      e.preventDefault();
      setActionMenuTx(rows[activeIdx]);
    } else if (e.key === 'Escape') {
      setSelectedIds(new Set());
    } else if (mod && e.key.toLowerCase() === 'a' && canEdit) {
      e.preventDefault();
      setSelectedIds(new Set(rows.map(t => t.id)));
    } else if (mod && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyRows();
    } else if (mod && e.key.toLowerCase() === 'v' && canEdit && copiedRef.current.length) {
      // Paste = the Duplicate dialog, prefilled with what was copied.
      e.preventDefault();
      setPasteRows(copiedRef.current);
    }
  };

  return (
    <section className="section" style={{ marginTop: '3rem' }}>
      <h2 className="section-title" style={{ marginBottom: '1.5rem' }}>💳 All Transactions</h2>

      {/* Table Filters */}
      <div className="filter-bar" ref={dropdownRef}>
        <MultiSelectDropdown
          label="Visibility"
          icon="👁️"
          options={["Active", "Excluded"]}
          filterState={filterVisibility}
          setFilterState={setFilterVisibility}
          dropdownKey="tableVisibility"
          openDropdown={openDropdown}
          setOpenDropdown={setOpenDropdown}
        />
        <MultiSelectDropdown
          label="Account"
          icon="🏦"
          options={allAccountsList}
          filterState={filterAccounts}
          setFilterState={setFilterAccounts}
          dropdownKey="tableAccount"
          openDropdown={openDropdown}
          setOpenDropdown={setOpenDropdown}
        />
        <MultiSelectDropdown
          label="Type"
          icon="💳"
          options={allTypes}
          filterState={filterTypes}
          setFilterState={setFilterTypes}
          dropdownKey="tableType"
          openDropdown={openDropdown}
          setOpenDropdown={setOpenDropdown}
        />
        <MultiSelectDropdown
          label="Month"
          icon="📅"
          options={allMonths}
          filterState={filterMonths}
          setFilterState={setFilterMonths}
          dropdownKey="tableMonth"
          openDropdown={openDropdown}
          setOpenDropdown={setOpenDropdown}
        />
        <MultiSelectDropdown
          label="Year"
          icon="📆"
          options={allYears}
          filterState={filterYears}
          setFilterState={setFilterYears}
          dropdownKey="tableYear"
          openDropdown={openDropdown}
          setOpenDropdown={setOpenDropdown}
        />
        <MultiSelectDropdown
          label="Heading"
          icon="🏷️"
          options={allHeadings}
          filterState={filterHeadings}
          setFilterState={setFilterHeadings}
          dropdownKey="tableHeading"
          openDropdown={openDropdown}
          setOpenDropdown={setOpenDropdown}
        />
        {/* Financial Year Filter */}
        <div style={{ position: 'relative' }}>
          <button
            className={`filter-chip ${filterFY ? 'active' : ''} ${openDropdown === 'tableFY' ? 'open' : ''}`}
            onClick={() => setOpenDropdown(openDropdown === 'tableFY' ? null : 'tableFY')}
          >
            <span>📋</span>
            <span>{filterFY || 'FY'}</span>
            {filterFY && (
              <span
                className="chip-clear"
                onClick={(e) => { e.stopPropagation(); handleFilterFYChange(''); }}
                title="Clear FY"
              >
                ×
              </span>
            )}
            <span className="chip-arrow">▼</span>
          </button>
          {openDropdown === 'tableFY' && (
            <div className="chip-dropdown">
              {allFYs.map(fy => (
                <div
                  key={fy}
                  className={`chip-dropdown-item ${filterFY === fy ? 'included' : ''}`}
                  onClick={() => { handleFilterFYChange(filterFY === fy ? '' : fy); setOpenDropdown(null); }}
                >
                  <div className={`chip-checkbox ${filterFY === fy ? 'included' : ''}`} />
                  <span>{fy}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="date-filter-chip">
          <span style={{ fontSize: '0.8rem', color: 'var(--text2)' }}>📅</span>
          <input
            type="date"
            value={filterDateFrom}
            onChange={e => { setFilterDateFrom(e.target.value); setFilterFY(""); }}
            style={{ background: 'transparent', border: 'none', outline: 'none', color: filterDateFrom ? 'var(--text)' : 'var(--text2)', fontSize: '0.8rem', fontFamily: "'DM Sans', sans-serif", width: filterDateFrom ? '100px' : '90px', cursor: 'pointer' }}
          />
          <span style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>→</span>
          <input
            type="date"
            value={filterDateTo}
            onChange={e => { setFilterDateTo(e.target.value); setFilterFY(""); }}
            min={filterDateFrom}
            style={{ background: 'transparent', border: 'none', outline: 'none', color: filterDateTo ? 'var(--text)' : 'var(--text2)', fontSize: '0.8rem', fontFamily: "'DM Sans', sans-serif", width: filterDateTo ? '100px' : '90px', cursor: 'pointer' }}
          />
          {(filterDateFrom || filterDateTo) && (
            <button onClick={() => { setFilterDateFrom(''); setFilterDateTo(''); setFilterFY(''); }} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: '0.9rem', padding: 0, lineHeight: 1 }}>×</button>
          )}
        </div>
        <input
          className="inp"
          placeholder="🔍 Description"
          value={filterDesc}
          onChange={e => setFilterDesc(e.target.value)}
          style={{ fontSize: '0.8rem', width: '200px', padding: '0.45rem 0.75rem', borderRadius: '999px' }}
        />
        <button
          className={`filter-chip ${compact ? 'active' : ''}`}
          onClick={toggleCompact}
          title="Tighter rows, like a spreadsheet"
        >
          <span>▤</span><span>Compact</span>
        </button>
        {balancesAllowed && (
          <button
            className={`filter-chip ${withBalances ? 'active' : ''}`}
            onClick={onToggleBalances}
            title="Show each account's balance right after every transaction"
          >
            <span>💰</span><span>{withBalances ? 'Hide balances' : 'Show balances'}</span>
          </button>
        )}
        {(filterAccounts.included.size > 0 || filterAccounts.excluded.size > 0 ||
          filterTypes.included.size > 0 || filterTypes.excluded.size > 0 ||
          filterMonths.included.size > 0 || filterMonths.excluded.size > 0 ||
          filterYears.included.size > 0 || filterYears.excluded.size > 0 ||
          filterHeadings.included.size > 0 || filterHeadings.excluded.size > 0 ||
          filterVisibility.included.size > 0 || filterVisibility.excluded.size > 0 ||
          filterDateFrom || filterDateTo || filterDesc || filterFY) && (
            <button
              className="filter-chip"
              onClick={() => {
                const empty = { included: new Set(), excluded: new Set() };
                setFilterAccounts(empty); setFilterTypes(empty); setFilterMonths(empty);
                setFilterYears(empty); setFilterHeadings(empty); setFilterVisibility(empty);
                setFilterDateFrom(""); setFilterDateTo(""); setFilterDesc(""); setFilterFY("");
              }}
              style={{ border: '1px dashed var(--neg)', color: 'var(--neg)', background: 'transparent' }}
            >
              <span>❌</span><span>Clear All</span>
            </button>
          )}
      </div>

      {/* Same height as the stats bar and pager below, so the table doesn't
          jump down when the first page arrives. */}
      {tableFirstLoad && (
        <div style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }} aria-hidden="true">
          <div className="tx-stats-bar" style={{ marginBottom: '1.5rem' }}>
            <span className="skeleton-line" style={{ width: 220 }} />
            <span className="skeleton-line" style={{ width: 160 }} />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="skeleton-block" style={{ width: 150, height: 34, borderRadius: 8 }} />
            <span className="skeleton-block" style={{ width: 260, height: 34, borderRadius: 8 }} />
          </div>
        </div>
      )}

      {/* Stats Bar & Pagination - Above Table */}
      {tableTotal > 0 && (
        <div style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }}>
          <div className="tx-stats-bar" style={{ marginBottom: '1.5rem' }}>
            <span>
              Page <strong style={{ color: 'var(--text)' }}>{currentPage + 1} of {totalPages}</strong> · Showing <strong style={{ color: 'var(--text)' }}>{paginatedRows.length}</strong> of {tableTotal} transactions
            </span>
            <span>
              <span className="pos" style={{ fontWeight: 600 }}>{fmt(tableSums.credit)}</span>
              {' '}in &nbsp;·&nbsp;
              <span className="neg" style={{ fontWeight: 600 }}>{fmt(tableSums.debit)}</span>
              {' '}out
            </span>
          </div>

          {/* Pagination Controls */}
          <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <RowsPerPageDropdown
                value={rowsPerPage}
                onChange={setRowsPerPage}
                openDropdown={openDropdown}
                setOpenDropdown={setOpenDropdown}
                setCurrentPage={setCurrentPage}
              />
              {canEdit && (
                <button
                  className={`filter-chip tx-new-row-toggle ${addingRow ? 'active' : ''}`}
                  onClick={() => setAddingRow(v => !v)}
                  title="Type a transaction straight into the table"
                >
                  <span>＋</span><span>New row</span>
                </button>
              )}
            </div>

            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <button
                onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
                disabled={currentPage === 0}
                style={{
                  padding: '0.45rem 0.85rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  background: currentPage === 0 ? 'rgba(255,255,255,0.05)' : 'var(--bg-input)',
                  color: currentPage === 0 ? 'var(--text2)' : 'var(--text)',
                  cursor: currentPage === 0 ? 'not-allowed' : 'pointer',
                  fontSize: '0.85rem',
                  opacity: currentPage === 0 ? 0.5 : 1
                }}
              >
                ← Prev
              </button>

              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 5) {
                    pageNum = i;
                  } else if (currentPage < 2) {
                    pageNum = i;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 5 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }

                  return (
                    <button
                      key={pageNum}
                      onClick={() => setCurrentPage(pageNum)}
                      style={{
                        padding: '0.35rem 0.65rem',
                        borderRadius: '6px',
                        border: pageNum === currentPage ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: pageNum === currentPage ? 'rgba(var(--accent-rgb), 0.2)' : 'var(--bg-input)',
                        color: pageNum === currentPage ? 'var(--accent)' : 'var(--text2)',
                        cursor: 'pointer',
                        fontSize: '0.8rem',
                        fontWeight: pageNum === currentPage ? 600 : 400
                      }}
                    >
                      {pageNum + 1}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => setCurrentPage(Math.min(totalPages - 1, currentPage + 1))}
                disabled={currentPage === totalPages - 1}
                style={{
                  padding: '0.45rem 0.85rem',
                  borderRadius: '8px',
                  border: '1px solid var(--border)',
                  background: currentPage === totalPages - 1 ? 'rgba(255,255,255,0.05)' : 'var(--bg-input)',
                  color: currentPage === totalPages - 1 ? 'var(--text2)' : 'var(--text)',
                  cursor: currentPage === totalPages - 1 ? 'not-allowed' : 'pointer',
                  fontSize: '0.85rem',
                  opacity: currentPage === totalPages - 1 ? 0.5 : 1
                }}
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transactions List */}
      <div
        ref={wrapRef}
        className={`tx-table-wrap ${compact ? 'compact' : ''} ${tableRefreshing ? 'is-refreshing' : ''}`}
        tabIndex={finePointer ? 0 : undefined}
        onKeyDown={onTableKeyDown}
      >
        <div className={`tx-table-head ${withBalances ? 'with-bal' : ''}`} style={{ gridTemplateColumns: gridColumns, minWidth: tableMinWidth }}>
          <div className="tx-col-header" style={{ justifyContent: 'center', paddingLeft: 0, paddingRight: 0 }} onClick={canEdit ? handleSelectAll : undefined}>
            {canEdit && <div className={`chip-checkbox ${selectedIds.size > 0 && selectedIds.size === paginatedRows.length ? 'included' : ''}`} />}
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('date')}>
            <span>Date</span>
            {sortBy === 'date' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            <div className="col-resize" onMouseDown={(e) => handleStartResize('date', e)}></div>
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('account')}>
            <span>Account</span>
            {sortBy === 'account' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            <div className="col-resize" onMouseDown={(e) => handleStartResize('account', e)}></div>
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('type')}>
            <span>Type</span>
            {sortBy === 'type' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            <div className="col-resize" onMouseDown={(e) => handleStartResize('type', e)}></div>
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('month')}>
            <span>Month</span>
            {sortBy === 'month' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            <div className="col-resize" onMouseDown={(e) => handleStartResize('month', e)}></div>
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('amount')}>
            <span>Amount</span>
            {sortBy === 'amount' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            <div className="col-resize" onMouseDown={(e) => handleStartResize('amount', e)}></div>
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('heading')}>
            <span>Category</span>
            {sortBy === 'heading' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
            <div className="col-resize" onMouseDown={(e) => handleStartResize('heading', e)}></div>
          </div>
          <div className="tx-col-header" onClick={() => handleSortClick('desc')}>
            <span>Description</span>
            {sortBy === 'desc' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}
          </div>
          <div className="tx-col-header">
            <span>Actions</span>
          </div>
          {withBalances && (
            <div className="tx-col-header tx-col-balance" title="Account balance right after this transaction">
              <span>Balance</span>
            </div>
          )}
        </div>
        {canEdit && addingRow && !tableFirstLoad && (
          <SheetEntryRow
            gridColumns={gridColumns}
            tableMinWidth={tableMinWidth}
            withBalances={withBalances}
            accounts={accounts}
            categories={categories || []}
            onSaved={onRefresh}
            onClose={() => setAddingRow(false)}
          />
        )}
        {tableFirstLoad ? (
          <div aria-busy="true" aria-label="Loading transactions">
            {Array.from({ length: Math.min(rowsPerPage, 8) }).map((_, i) => (
              <div key={i} className="tx-row tx-row-skeleton">
                <span className="skeleton-line" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
              </div>
            ))}
          </div>
        ) : rows.length > 0 ? (
          rows.map((t, i) => {
            const d = new Date(t.date);
            const monthLabel = d.toLocaleString('default', { month: 'long' });
            // Double-click edits a cell in place (like Sheets); the rest of the row opens the card.
            const cell = (field, className, content, style) => (
              editing?.id === t.id && editing.field === field ? (
                <span className={`${className} sheet-editing`}>
                  <CellEditor
                    tx={t}
                    field={field}
                    suggestions={field === 'heading'
                      ? categoriesForType(t.type, meta.categories_by_type, categories || [])
                      : field === 'description' ? descriptionOptions(t.type, t.heading, descriptionIndex) : []}
                    onCommit={(value, move) => commitCell(t, field, value, move)}
                    onCancel={() => { setEditing(null); wrapRef.current?.focus({ preventScroll: true }); }}
                  />
                </span>
              ) : (
                <span
                  className={className}
                  style={style}
                  onDoubleClick={sheetClicks ? (e) => { e.stopPropagation(); setEditing({ id: t.id, field }); } : undefined}
                >
                  {content}
                </span>
              )
            );
            return (
              <div
                key={t.id}
                data-row-idx={i}
                className={`tx-row ${withBalances ? 'with-bal' : ''} ${selectedIds.has(t.id) ? 'selected' : ''} ${activeIdx === i ? 'active' : ''} ${pending[t.id] ? 'saving' : ''}`}
                style={{ gridTemplateColumns: gridColumns, minWidth: tableMinWidth, cursor: 'pointer' }}
                onClick={(e) => {
                  if (e.target.closest('.sheet-editing')) return;
                  if (finePointer) { setActiveIdx(i); wrapRef.current?.focus({ preventScroll: true }); }
                  if (sheetClicks) handleRowClick(e, t.id, i); else setActionMenuTx(t);
                }}
                onDoubleClick={sheetClicks ? () => setActionMenuTx(t) : undefined}
                title={sheetClicks ? 'Click to select · double-click a cell to edit · Enter opens' : undefined}
              >
                <span style={{ justifyContent: 'center', paddingLeft: 0, paddingRight: 0, cursor: canEdit ? 'pointer' : 'inherit' }} onClick={canEdit ? (e) => handleRowSelect(e, t.id, i) : undefined} onDoubleClick={(e) => e.stopPropagation()}>
                  {canEdit && <div className={`chip-checkbox ${selectedIds.has(t.id) ? 'included' : ''}`} />}
                </span>
                {cell('date', 'tx-date', formatDate(t.date))}
                {cell('account', 'tx-account', <>
                  <span>{getBankEmoji(t.account)}</span>
                  <span className="tx-account-name" title={t.account}>{t.account}</span>
                </>)}
                {cell('type', 'tx-type-cell', <span className={`tx-badge ${t.type.toLowerCase()}`}>{t.type.charAt(0).toUpperCase() + t.type.slice(1)}</span>)}
                <span className="tx-month">{monthLabel}</span>
                {cell('amount', `tx-amount ${t.type === 'Credit' ? 'pos' : t.type === 'Investment' ? 'blue-text' : t.type === 'Savings' ? 'accent' : 'neg'}`, <>
                  {t.type === 'Credit' ? '+' : '−'}{fmt(t.amount)}
                </>)}
                {cell('heading', 'tx-heading', t.heading)}
                {cell('description', 'tx-desc', <>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t.description || '—'}
                  </span>
                  <span style={{ display: 'flex', gap: '8px', flexShrink: 0 }}>
                    {t.split && (
                      <span title="Contains Split Details" style={{ fontSize: '0.9rem', cursor: 'help' }}>
                        👥
                      </span>
                    )}
                    {t.exclude_analytics && (
                      <span title="Excluded from Analytics" style={{ fontSize: '0.9rem', cursor: 'help' }}>
                        🙈
                      </span>
                    )}
                  </span>
                </>, { display: 'flex', alignItems: 'center', justifyContent: 'space-between' })}
                <span className="tx-actions" onDoubleClick={(e) => e.stopPropagation()}>
                  {canEdit ? (
                    <>
                      <button className="action-icon-btn edit" onClick={(e) => { e.stopPropagation(); setEditingTx(t); }} title="Edit">✏️</button>
                      <button className="action-icon-btn copy" onClick={(e) => { e.stopPropagation(); setCopyingTx(t); }} title="Duplicate">📋</button>
                      <button className="action-icon-btn delete" onClick={(e) => { e.stopPropagation(); handleDelete(t.id); }} title="Delete">🗑️</button>
                    </>
                  ) : (
                    <span className="view-only-pill" title="You have view-only access">View only</span>
                  )}
                </span>
                {withBalances && (
                  t.balance_after == null ? (
                    <span className="tx-balance none" title="Credit cards and untracked accounts have no running balance">—</span>
                  ) : (
                    <span
                      className={`tx-balance ${minByAccount[t.account] != null && t.balance_after < minByAccount[t.account] ? 'below' : ''}`}
                      title={`${t.account} balance after this transaction`}
                    >
                      {fmt(t.balance_after)}
                    </span>
                  )
                )}
              </div>
            );
          })
        ) : (
          <div className="empty-state">📭 No transactions match your filters</div>
        )}
        {/* Floating Action Bar */}
        {canEdit && selectedIds.size > 0 && (
          <div className="floating-action-bar">
            <span className="fab-text">{selectedIds.size} selected</span>
            <div className="fab-actions">
              <button className="action-btn" onClick={() => setIsBulkEditOpen(true)} style={{ padding: '0.45rem 1rem' }}>✏️ <span className="hide-mobile">Edit</span></button>
              <button className="action-btn" onClick={() => setIsBulkCopyOpen(true)} style={{ padding: '0.45rem 1rem' }}>📋 <span className="hide-mobile">Duplicate</span></button>
              {finePointer && (
                <button className="action-btn secondary" onClick={copyRows} style={{ padding: '0.45rem 1rem' }} title="Copy as rows for Sheets (Ctrl+C)">⧉ <span className="hide-mobile">Copy</span></button>
              )}
              <button className="action-btn" onClick={handleBulkDelete} style={{ padding: '0.45rem 1rem', background: '#dc2626', boxShadow: 'none' }}>🗑️ <span className="hide-mobile">Delete</span></button>
              <button className="action-btn secondary" onClick={() => setSelectedIds(new Set())} style={{ padding: '0.45rem 1rem' }}>✕</button>
            </div>
          </div>
        )}

        {/* Bulk Edit Modal */}
        {isBulkEditOpen && (
          <BulkEditTransactionModal transactions={selectedTransactions} categories={categories} onClose={() => { setIsBulkEditOpen(false); setSelectedIds(new Set()); }} onRefresh={onRefresh} />
        )}

        {/* Ctrl+V: duplicate what was copied, in the same dialog */}
        {pasteRows && (
          <BulkEditTransactionModal transactions={pasteRows} categories={categories} isCopy={true} onClose={() => setPasteRows(null)} onRefresh={onRefresh} />
        )}
        {toast && <div className="sheet-toast" role="status">{toast}</div>}

        {/* Bulk Copy Modal */}
        {isBulkCopyOpen && (
          <BulkEditTransactionModal transactions={selectedTransactions} categories={categories} isCopy={true} onClose={() => { setIsBulkCopyOpen(false); setSelectedIds(new Set()); }} onRefresh={onRefresh} />
        )}
      </div>
    </section>
  );
}
