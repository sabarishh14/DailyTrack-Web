import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from './SabDekho';

import { API } from '../constants';
import { getToken, fmt } from '../utils';
import CustomSelect from '../components/CustomSelect';
import CustomPieTooltip from '../components/CustomPieTooltip';
import EditTransactionModal from '../components/EditTransactionModal';
import CategoryExclusionModal from '../components/CategoryExclusionModal';
import BudgetManagerModal from '../components/BudgetManagerModal';
import MultiSelectDropdown from './money-components/MultiSelectDropdown';
import BudgetGoalsSection from './money-components/BudgetGoalsSection';
import SplitsSection from './money-components/SplitsSection';
import TransactionDetailsModal from './money-components/TransactionDetailsModal';
import SnapshotPoster from './money-components/SnapshotPoster';
import TransactionsTableSection from './money-components/TransactionsTableSection';
import { SectionCardSkeleton } from './money-components/SectionCardSkeleton';
import { useAccess } from '../access/AccessContext';
import { apiGet, apiPost, tri, useApi, useMoneyMeta, EMPTY_META, monthKey } from '../api/money';
import AccountAverages from './money-components/AccountAverages';

function MoneyTab({ accounts, categories, budgets = [], onRefresh, refreshBudgets, globalActionTx, setGlobalActionTx, dataVersion, isActive = true }) {
  const canEdit = useAccess().can('money', 'edit');
  // Everything below is computed server-side. It starts loading in the
  // background right after startup (not when the tab is first opened), so the
  // Money tab is usually ready by the time you get to it.
  const [hasOpened, setHasOpened] = useState(isActive);
  useEffect(() => {
    if (isActive) { setHasOpened(true); return; }
    const timer = setTimeout(() => setHasOpened(true), 300);
    return () => clearTimeout(timer);
  }, [isActive]);
  const metaRes = useMoneyMeta(dataVersion, hasOpened);
  const meta = metaRes.data || EMPTY_META;
const currentMonthLabel = new Date().toLocaleString('default', { month: 'long' });
  const currentYearLabel = new Date().getFullYear().toString();

  const [expanded, setExpanded] = useState(false);
  const [splitsExpanded, setSplitsExpanded] = useState(false);
  const [settlingPerson, setSettlingPerson] = useState(null);
  const [editingTx, setEditingTx] = useState(null);
  const [copyingTx, setCopyingTx] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState(null); // Tracks last click for Shift-Select
  const [isBulkEditOpen, setIsBulkEditOpen] = useState(false);
  const [isBulkCopyOpen, setIsBulkCopyOpen] = useState(false);
  const [isCategoryModalOpen, setIsCategoryModalOpen] = useState(false);

  const [budgetExpanded, setBudgetExpanded] = useState(false);
  const [isBudgetModalOpen, setIsBudgetModalOpen] = useState(false);
  const [editingBudgetCategory, setEditingBudgetCategory] = useState(null);
  const [editingBudgetValue, setEditingBudgetValue] = useState("");
  const dropdownRef = useRef(null);
  // Analyzer filters - 3-State Multi-select
  const [chartAccounts, setChartAccounts] = useState({ included: new Set(), excluded: new Set() });
  const [chartTypes, setChartTypes] = useState({ included: new Set(['Debit']), excluded: new Set() }); // Defaults to Debit
  const [chartMonths, setChartMonths] = useState({ included: new Set([currentMonthLabel]), excluded: new Set() });
  const [chartYears, setChartYears] = useState({ included: new Set([currentYearLabel]), excluded: new Set() });
  const [chartHeadings, setChartHeadings] = useState({ included: new Set(), excluded: new Set() });
  const [chartDateFrom, setChartDateFrom] = useState("");
  const [chartDateTo, setChartDateTo] = useState("");
  const [chartDateFromDebounced, setChartDateFromDebounced] = useState("");
  const [chartDateToDebounced, setChartDateToDebounced] = useState("");
  const [chartFY, setChartFY] = useState(""); // Financial Year for Analyzer

  // Table filters - 3-State Multi-select
  const [filterYears, setFilterYears] = useState({ included: new Set([currentYearLabel]), excluded: new Set() });
  const [filterAccounts, setFilterAccounts] = useState({ included: new Set(), excluded: new Set() });
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterDateFromDebounced, setFilterDateFromDebounced] = useState("");
  const [filterDateToDebounced, setFilterDateToDebounced] = useState("");
  const [filterMonths, setFilterMonths] = useState({ included: new Set([currentMonthLabel]), excluded: new Set() });
  const [filterTypes, setFilterTypes] = useState({ included: new Set(), excluded: new Set() });
  const [filterHeadings, setFilterHeadings] = useState({ included: new Set(), excluded: new Set() });
  const [filterDesc, setFilterDesc] = useState("");
  const [filterDescDebounced, setFilterDescDebounced] = useState("");
  const [filterVisibility, setFilterVisibility] = useState({ included: new Set(), excluded: new Set() }); // NEW STATE
  const [filterFY, setFilterFY] = useState(""); // Financial Year for Table

  // Dropdown visibility
  const [openDropdown, setOpenDropdown] = useState(null);

  // Table sorting
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");

  // Pagination
  const [currentPage, setCurrentPage] = useState(0);
  // Compact rows fit more on screen, so they start at 25 a page (TransactionsTableSection).
  const [rowsPerPage, setRowsPerPage] = useState(() => {
    try { return localStorage.getItem('dt_tx_compact') === '1' ? 25 : 10; } catch { return 10; }
  });

  const [actionMenuTx, setActionMenuTx] = useState(null);
  useEffect(() => {
    if (globalActionTx) {
      setActionMenuTx(globalActionTx);
      setGlobalActionTx(null);
    }
  }, [globalActionTx, setGlobalActionTx]);
  // <-- ADD THIS NEW STATE
  const [captureMode, setCaptureMode] = useState(null);
  const [captureColors, setCaptureColors] = useState(null);
  const posterRef = useRef(null);

  /// Change actions: 90 to actions: 130
  // Sized to their content (dates are d/m/yy, the longest account is "CC-PINNACLE 6360").
  const [colWidths, setColWidths] = useState({ checkbox: 48, date: 100, account: 190, type: 110, month: 110, amount: 130, heading: 150, desc: 0, actions: 130 });

  // 🚀 GLOBAL ESCAPE: Closes Money-level Modals
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setEditingTx(null);
        setCopyingTx(null);
        setIsBulkEditOpen(false);
        setIsBulkCopyOpen(false);
        setIsCategoryModalOpen(false);
        setIsBudgetModalOpen(false);
        setActionMenuTx(null);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  // Reset to page 0 when filters change
  useEffect(() => {
    setCurrentPage(0);
  }, [filterAccounts, filterDateFromDebounced, filterDateToDebounced, filterMonths, filterYears, filterTypes, filterHeadings, filterDescDebounced]);

  // Close dropdowns when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      const isClickOnFilter = e.target.closest('.filter-bar') || e.target.closest('.chip-dropdown');
      if (!isClickOnFilter) {
        setOpenDropdown(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Debounce filter inputs (300ms delay)
  useEffect(() => {
    const timer = setTimeout(() => setFilterDateFromDebounced(filterDateFrom), 300);
    return () => clearTimeout(timer);
  }, [filterDateFrom]);

  useEffect(() => {
    const timer = setTimeout(() => setFilterDateToDebounced(filterDateTo), 300);
    return () => clearTimeout(timer);
  }, [filterDateTo]);

  useEffect(() => {
    if (!filterDateFromDebounced) return;
    const from = new Date(filterDateFromDebounced);
    const to = filterDateToDebounced ? new Date(filterDateToDebounced) : from;

    // Collect all months between from and to
    const months = new Set();
    const cursor = new Date(from.getFullYear(), from.getMonth(), 1);
    const end = new Date(to.getFullYear(), to.getMonth(), 1);
    while (cursor <= end) {
      const label = cursor.toLocaleString('default', { month: 'long' });
      months.add(label);
      cursor.setMonth(cursor.getMonth() + 1);
    }
    setFilterMonths(prev => ({ ...prev, included: months }));
  }, [filterDateFromDebounced, filterDateToDebounced]);

  // Debounce analyzer date filters
  useEffect(() => {
    const timer = setTimeout(() => setChartDateFromDebounced(chartDateFrom), 300);
    return () => clearTimeout(timer);
  }, [chartDateFrom]);

  useEffect(() => {
    const timer = setTimeout(() => setChartDateToDebounced(chartDateTo), 300);
    return () => clearTimeout(timer);
  }, [chartDateTo]);

  useEffect(() => {
    const timer = setTimeout(() => setFilterDescDebounced(filterDesc), 300);
    return () => clearTimeout(timer);
  }, [filterDesc]);

  // Filter options (years, FYs, categories, accounts, types) come from the server.
  const allMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const allYears = meta.years;
  const allFYs = meta.fys;
  const allHeadings = meta.headings;
  const allAccountsList = meta.accounts;
  const allTypes = meta.types;

  // Optimistic split overrides — local state for instant UI
  const [splitOverrides, setSplitOverrides] = useState({});

  // Only transactions that have splits are fetched for the splits dashboard.
  const splitsRes = useApi(() => apiGet('/splits/list'), dataVersion, hasOpened);
  const splitTransactions = splitsRes.data?.transactions || [];
  useEffect(() => { setSplitOverrides({}); }, [splitsRes.data]);

  // Split dashboard computed data (merges optimistic overrides)
  const { activeSplits, settledSplits, splitBalances, totalOwed } = useMemo(() => {
    const active = [];
    const settled = [];
    const bals = {};
    let owed = 0;

    splitTransactions.forEach(t => {
      const effectiveSplit = splitOverrides[t.id] || t.split;
      if (!effectiveSplit || !effectiveSplit.members || effectiveSplit.members.length === 0) return;
      const txWithSplit = { ...t, split: effectiveSplit };
      const allPaid = effectiveSplit.members.every(m => m.paid);
      if (allPaid) {
        settled.push(txWithSplit);
      } else {
        active.push(txWithSplit);
        effectiveSplit.members.forEach(m => {
          if (!m.paid && m.name.toLowerCase() !== 'you') {
            const amt = parseFloat(m.amount) || 0;
            if (amt > 0) {
              bals[m.name] = (bals[m.name] || 0) + amt;
              owed += amt;
            }
          }
        });
      }
    });

    active.sort((a, b) => new Date(b.date) - new Date(a.date));
    settled.sort((a, b) => new Date(b.date) - new Date(a.date));

    const balsArr = Object.entries(bals)
      .map(([name, amount]) => ({ name, amount }))
      .sort((a, b) => b.amount - a.amount);

    return { activeSplits: active, settledSplits: settled, splitBalances: balsArr, totalOwed: owed };
  }, [splitTransactions, splitOverrides]);

  // Multi-select toggle functions
  // Helper to check match based on 3-State filtering
  const checkMatch = (filterState, value) => {
    const { included, excluded } = filterState;
    if (excluded.has(value)) return false; // Exclusion always wins
    if (included.size > 0 && !included.has(value)) return false; // If there are inclusions, MUST be included
    return true;
  };

  // Spending analyser: filtering and grouping run in SQL (/api/money/analyze).
  const analyzerFilters = useMemo(() => ({
    accounts: tri(chartAccounts),
    types: tri(chartTypes),
    months: tri(chartMonths),
    years: tri(chartYears),
    headings: tri(chartHeadings),
    date_from: chartDateFromDebounced || null,
    date_to: chartDateToDebounced || null,
  }), [chartAccounts, chartTypes, chartMonths, chartYears, chartHeadings, chartDateFromDebounced, chartDateToDebounced]);
  // Category or account slices; remembered per browser.
  const [analyzerGroup, setAnalyzerGroupState] = useState(() => {
    try { return localStorage.getItem('dt_analyzer_group') === 'account' ? 'account' : 'heading'; } catch { return 'heading'; }
  });
  const setAnalyzerGroup = (group) => {
    setAnalyzerGroupState(group);
    try { localStorage.setItem('dt_analyzer_group', group); } catch { /* per-browser nicety only */ }
  };
  const byAccount = analyzerGroup === 'account';
  const analyzerKey = `${JSON.stringify(analyzerFilters)}|${analyzerGroup}|${dataVersion}`;
  const analyzerRes = useApi(() => apiPost('/money/analyze', { filters: analyzerFilters, group: analyzerGroup }), analyzerKey, hasOpened);
  const pieArr = analyzerRes.data?.groups || [];
  const analyzerLoading = !analyzerRes.data;
  const analyzerRefreshing = !!analyzerRes.data && analyzerRes.loading; // filters changed → dim old numbers
  const isShowingDescriptions = !byAccount && chartHeadings.included.size === 1;
  // Each drill-down (a category, or an account's categories) remembers where it
  // came from, so Back undoes it in one go instead of clearing filters by hand.
  const [drillStack, setDrillStack] = useState([]);
  const drillInto = (label) => setDrillStack(stack => [...stack, {
    label,
    was: { chartAccounts, chartHeadings, analyzerGroup, filterAccounts, filterHeadings, filterTypes, filterMonths, filterYears, filterDesc },
  }]);
  const drillBack = () => {
    const last = drillStack[drillStack.length - 1];
    if (!last) return;
    const w = last.was;
    setChartAccounts(w.chartAccounts); setChartHeadings(w.chartHeadings); setAnalyzerGroup(w.analyzerGroup);
    setFilterAccounts(w.filterAccounts); setFilterHeadings(w.filterHeadings); setFilterTypes(w.filterTypes);
    setFilterMonths(w.filterMonths); setFilterYears(w.filterYears); setFilterDesc(w.filterDesc);
    setDrillStack(drillStack.slice(0, -1));
  };
  // An account's categories: the donut narrows to it and goes back to categories.
  const pickAnalyzerAccount = (account) => {
    drillInto(account);
    const only = { included: new Set([account]), excluded: new Set() };
    setChartAccounts(only);
    setFilterAccounts(only);
    setAnalyzerGroup('heading');
  };
  const analyzerStats = {
    count: analyzerRes.data?.count || 0,
    credit: analyzerRes.data?.credit || { count: 0, sum: 0 },
    debit: analyzerRes.data?.debit || { count: 0, sum: 0 },
  };

  const renderActiveFilters = (c) => {
    const filters = [];
    if (chartFY) filters.push({ label: 'FY', val: chartFY });
    if (chartMonths.included.size > 0) filters.push({ label: 'Month', val: Array.from(chartMonths.included).join(', ') });
    if (chartYears.included.size > 0) filters.push({ label: 'Year', val: Array.from(chartYears.included).join(', ') });
    if (chartAccounts.included.size > 0) filters.push({ label: 'Account', val: Array.from(chartAccounts.included).join(', ') });
    if (chartTypes.included.size > 0) filters.push({ label: 'Type', val: Array.from(chartTypes.included).join(', ') });
    if (chartHeadings.included.size > 0) filters.push({ label: 'Category', val: Array.from(chartHeadings.included).join(', ') });
    if (chartDateFromDebounced) filters.push({ label: 'Date', val: `${chartDateFromDebounced}${chartDateToDebounced ? ' → ' + chartDateToDebounced : ''}` });

    if (filters.length === 0) return 'All Transactions';

    const color2 = c ? c.text2 : 'rgba(255,255,255,0.6)';
    const color3 = c ? c.text3 : 'rgba(255,255,255,0.4)';
    const accent = c ? c.accent : '#818cf8';

    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center', gap: '8px' }}>
        <span style={{ color: color3 }}>Filtered by:</span>
        {filters.map((f, i) => (
          <span key={f.label} style={{ display: 'inline-flex', alignItems: 'center' }}>
            <span style={{ color: color2, marginRight: '4px' }}>{f.label}:</span>
            <span style={{ color: accent }}>{f.val}</span>
            {i < filters.length - 1 && <span style={{ color: color3, marginLeft: '8px' }}>|</span>}
          </span>
        ))}
      </span>
    );
  };

  // FY selection handler for Spending Analyser
  const handleChartFYChange = (fy) => {
    if (!fy) {
      setChartFY("");
      setChartDateFrom(""); setChartDateTo("");
      setChartDateFromDebounced(""); setChartDateToDebounced("");
      return;
    }
    setChartFY(fy);
    // Parse "FY 2025-2026" → startYear=2025
    const match = fy.match(/FY (\d{4})-(\d{4})/);
    if (match) {
      const startYear = parseInt(match[1]);
      const endYear = parseInt(match[2]);
      setChartDateFrom(`${startYear}-04-01`);
      setChartDateTo(`${endYear}-03-31`);
      setChartDateFromDebounced(`${startYear}-04-01`);
      setChartDateToDebounced(`${endYear}-03-31`);
      // Clear month and year filters since FY covers the full range
      const empty = { included: new Set(), excluded: new Set() };
      setChartMonths(empty);
      setChartYears(empty);
    }
  };

  // FY selection handler for All Transactions table
  const handleFilterFYChange = (fy) => {
    if (!fy) {
      setFilterFY("");
      setFilterDateFrom(""); setFilterDateTo("");
      setFilterDateFromDebounced(""); setFilterDateToDebounced("");
      return;
    }
    setFilterFY(fy);
    const match = fy.match(/FY (\d{4})-(\d{4})/);
    if (match) {
      const startYear = parseInt(match[1]);
      const endYear = parseInt(match[2]);
      setFilterDateFrom(`${startYear}-04-01`);
      setFilterDateTo(`${endYear}-03-31`);
      setFilterDateFromDebounced(`${startYear}-04-01`);
      setFilterDateToDebounced(`${endYear}-03-31`);
      // Clear month and year filters since FY covers the full range
      const empty = { included: new Set(), excluded: new Set() };
      setFilterMonths(empty);
      setFilterYears(empty);
    }
  };

  const handleExportPDF = async (e) => {
    if (e) e.stopPropagation();

    const rs = getComputedStyle(document.body);
    const tColors = {
      bg: rs.getPropertyValue('--bg').trim() || '#080b12',
      card: rs.getPropertyValue('--bg2').trim() || '#0d1117',
      border: rs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.07)',
      text: rs.getPropertyValue('--text').trim() || '#e2e8f0',
      text2: rs.getPropertyValue('--text2').trim() || '#94a3b8',
      text3: rs.getPropertyValue('--text3').trim() || 'rgba(255,255,255,0.3)',
      accent: rs.getPropertyValue('--accent').trim() || '#6366f1',
      accent2: rs.getPropertyValue('--accent2').trim() || '#06b6d4',
      accentRgb: rs.getPropertyValue('--accent-rgb').trim() || '99, 102, 241',
      accent2Rgb: rs.getPropertyValue('--accent2-rgb').trim() || '6, 182, 212',
    };

    setCaptureColors(tColors);
    setCaptureMode('pdf');
    try {
      await new Promise(r => setTimeout(r, 150)); // wait for DOM resize
      const { toJpeg } = await import('html-to-image');
      const { jsPDF } = await import('jspdf');

      const pdf = new jsPDF({
        orientation: 'portrait',
        unit: 'px',
        format: 'a4'
      });
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = pdf.internal.pageSize.getHeight();

      const totalPages = Math.max(1, Math.ceil(pieArr.length / 30));

      for (let i = 0; i < totalPages; i++) {
        const node = document.getElementById(`pdf-poster-${i}`);
        if (!node) continue;

        const dataUrl = await toJpeg(node, {
          quality: 0.95,
          pixelRatio: 1,
          cacheBust: true,
          backgroundColor: tColors.bg,
          canvasWidth: 1358,
          canvasHeight: 1920,
          style: {
            width: '1358px',
            height: '1920px',
            left: '0',
            top: '0',
            position: 'static',
            transform: 'none'
          }
        });

        if (i > 0) pdf.addPage('a4', 'portrait');

        // Draw dark background to fill A4 page
        pdf.setFillColor(tColors.bg);
        pdf.rect(0, 0, pdfWidth, pdfHeight, 'F');

        // Center the 1358x1920 image on A4
        const imgRatio = 1358 / 1920;
        const finalH = pdfHeight;
        const finalW = finalH * imgRatio;
        const xOffset = (pdfWidth - finalW) / 2;
        const yOffset = (pdfHeight - finalH) / 2;

        pdf.addImage(dataUrl, 'JPEG', xOffset, yOffset, finalW, finalH, undefined, 'FAST');
      }

      pdf.save(`DailyTrack-Report-${new Date().getTime()}.pdf`);
    } catch (err) {
      console.error(err);
      alert("Failed to capture PDF.");
    }
    setCaptureMode(null);
  };

  const handleShareSnapshot = async (e) => {
    if (e) e.stopPropagation();

    if (pieArr.length > 30) {
      return handleExportPDF(e);
    }

    const rs = getComputedStyle(document.body);
    const tColors = {
      bg: rs.getPropertyValue('--bg').trim() || '#080b12',
      card: rs.getPropertyValue('--bg2').trim() || '#0d1117',
      border: rs.getPropertyValue('--border').trim() || 'rgba(255,255,255,0.07)',
      text: rs.getPropertyValue('--text').trim() || '#e2e8f0',
      text2: rs.getPropertyValue('--text2').trim() || '#94a3b8',
      text3: rs.getPropertyValue('--text3').trim() || 'rgba(255,255,255,0.3)',
      accent: rs.getPropertyValue('--accent').trim() || '#6366f1',
      accent2: rs.getPropertyValue('--accent2').trim() || '#06b6d4',
      accentRgb: rs.getPropertyValue('--accent-rgb').trim() || '99, 102, 241',
      accent2Rgb: rs.getPropertyValue('--accent2-rgb').trim() || '6, 182, 212',
    };
    setCaptureColors(tColors);

    setCaptureMode('snapshot');
    try {
      await new Promise(r => setTimeout(r, 150)); // wait for DOM resize
      const node = document.getElementById('pdf-poster-0');
      if (!node) return;

      const { toPng } = await import('html-to-image');
      const dataUrl = await toPng(node, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: tColors.bg,
        canvasWidth: 1080,
        canvasHeight: 1920,
        style: {
          width: '1080px',
          height: '1920px',
          left: '0',
          top: '0',
          position: 'static',
          transform: 'none',
          backgroundImage: `radial-gradient(circle at top right, rgba(${tColors.accentRgb}, 0.15), transparent 400px), radial-gradient(circle at bottom left, rgba(${tColors.accent2Rgb}, 0.1), transparent 400px)`
        }
      });

      const filename = `DailyTrack-Snapshot-${new Date().getTime()}.png`;
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], filename, { type: 'image/png' });

      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ title: `Spending Snapshot`, files: [file] }) }
        catch (shareErr) { console.log('User canceled share') }
      } else {
        const link = document.createElement('a');
        link.download = filename;
        link.href = dataUrl;
        link.click();
      }
    } catch (err) {
      console.error('Failed to capture snapshot', err);
      alert('Failed to generate snapshot.');
    }
    setCaptureMode(null);
  };

  // Transactions table: filtered, sorted and paged on the server (/api/transactions/query).
  const tableFilters = useMemo(() => ({
    accounts: tri(filterAccounts),
    types: tri(filterTypes),
    months: tri(filterMonths),
    years: tri(filterYears),
    headings: tri(filterHeadings),
    visibility: tri(filterVisibility),
    date_from: filterDateFromDebounced || null,
    date_to: filterDateToDebounced || null,
    description: filterDescDebounced || null,
  }), [filterAccounts, filterTypes, filterMonths, filterYears, filterHeadings, filterVisibility, filterDateFromDebounced, filterDateToDebounced, filterDescDebounced]);
  // "Show balances": each row's account balance right after it, like a sheet's balance column.
  const balancesAllowed = useAccess().money.balancesVisible;
  const [showTxBalances, setShowTxBalances] = useState(() => {
    try { return localStorage.getItem('dt_show_tx_balances') === '1'; } catch { return false; }
  });
  const toggleTxBalances = () => setShowTxBalances(v => {
    try { localStorage.setItem('dt_show_tx_balances', v ? '0' : '1'); } catch { /* per-browser nicety only */ }
    return !v;
  });
  const withBalances = balancesAllowed && showTxBalances;
  const tableKey = `${JSON.stringify(tableFilters)}|${sortBy}|${sortDir}|${currentPage}|${rowsPerPage}|${dataVersion}|${withBalances}`;
  const tableRes = useApi(() => apiPost('/transactions/query', {
    filters: tableFilters, sort_by: sortBy, sort_dir: sortDir,
    offset: currentPage * rowsPerPage, limit: rowsPerPage,
    with_balances: withBalances,
  }), tableKey, hasOpened);
  const paginatedRows = tableRes.data?.transactions || [];
  const tableTotal = tableRes.data?.total || 0;
  const tableSums = { credit: tableRes.data?.credit_total || 0, debit: tableRes.data?.debit_total || 0 };
  const tableFirstLoad = !tableRes.data;                    // nothing to show yet → skeleton rows
  const tableRefreshing = !!tableRes.data && tableRes.loading; // filters changed → dim old rows
  const totalPages = Math.ceil(tableTotal / rowsPerPage);

  // Selection can span pages, so remember every row we've shown for bulk edit.
  const seenRowsRef = useRef({});
  paginatedRows.forEach(t => { seenRowsRef.current[t.id] = t; });
  const selectedTransactions = [...selectedIds].map(id => seenRowsRef.current[id]).filter(Boolean);

  // Reset to page 0 when filters change
  useEffect(() => {
    setCurrentPage(0);
  }, [filterAccounts, filterDateFromDebounced, filterDateToDebounced, filterMonths, filterTypes, filterHeadings, filterDescDebounced]);

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6366f1';
  const PIE_COLORS = [accentColor, "#8b5cf6", "#d946ef", "#ec4899", "#f43f5e", "#f97316", "#eab308", "#84cc16", "#22c55e", "#10b981", "#14b8a6", "#06b6d4"];

  // Handle column resize
  const handleStartResize = (col, e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = colWidths[col];

    const handleMouseMove = (me) => {
      const diff = me.clientX - startX;
      const minWidths = { date: 80, account: 140, type: 90, month: 90, amount: 100, heading: 100, desc: 100 };
      const newWidth = Math.max(minWidths[col] || 60, startWidth + diff);
      setColWidths(w => ({ ...w, [col]: newWidth }));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  const handleSortClick = (col) => {
    if (sortBy === col) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(col);
      setSortDir('asc');
    }
  };

  const handleSelectAll = () => {
    if (selectedIds.size === paginatedRows.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(paginatedRows.map(t => t.id)));
    }
  };

  const handleRowSelect = (e, id, index) => {
    e.stopPropagation();
    const newSet = new Set(selectedIds);

    if (e.shiftKey && lastSelectedIdx !== null) {
      // Shift-Click Bulk Select
      const start = Math.min(lastSelectedIdx, index);
      const end = Math.max(lastSelectedIdx, index);
      for (let j = start; j <= end; j++) {
        newSet.add(paginatedRows[j].id);
      }
    } else {
      // Normal Click Toggle
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
    }

    setSelectedIds(newSet);
    setLastSelectedIdx(index); // Remember this click
  };

  // Row click on a laptop, like a spreadsheet: select just this row (again to
  // deselect), Ctrl/⌘ to add or remove one, Shift for a range.
  const handleRowClick = (e, id, index) => {
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      if (e.shiftKey) return handleRowSelect(e, id, index);
      e.stopPropagation();
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      setSelectedIds(next);
      setLastSelectedIdx(index);
      return;
    }
    const onlyThis = selectedIds.size === 1 && selectedIds.has(id);
    setSelectedIds(onlyThis ? new Set() : new Set([id]));
    setLastSelectedIdx(index);
  };

  const handleBulkDelete = async () => {
    if (!window.confirm(`Are you sure you want to delete ${selectedIds.size} transactions?`)) return;
    try {
      // Send ONE single array of IDs to the backend
      const res = await fetch(`${API}/transactions/bulk-delete`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify(Array.from(selectedIds))
      });

      if (res.ok) {
        setSelectedIds(new Set());
        onRefresh(); // Refresh balances and list
      } else {
        alert("Failed to delete transactions.");
      }
    } catch (e) {
      alert("Error deleting some transactions: " + e.message);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Are you sure you want to delete this transaction? This will also update your account balance.")) return;
    try {
      const res = await fetch(`${API}/transactions/${id}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      if (res.ok) {
        onRefresh(); // Refresh balances and transactions!
      } else {
        alert("Failed to delete transaction.");
      }
    } catch (e) {
      alert("Error deleting: " + e.message);
    }
  };

  // Splits: Settle all for a person (optimistic)
  const handleSettlePerson = (personName) => {
    if (!window.confirm(`Settle all splits for ${personName}?`)) return;
    setSettlingPerson(personName);

    // Build all overrides + API calls at once
    const overrides = {};
    const apiCalls = [];
    for (const t of activeSplits) {
      let changed = false;
      const newMembers = t.split.members.map(m => {
        if (m.name === personName && !m.paid) { changed = true; return { ...m, paid: true }; }
        return m;
      });
      if (changed) {
        overrides[t.id] = { ...t.split, members: newMembers };
        let myAmount = 0;
        const youMember = newMembers.find(m => m.name.toLowerCase() === 'you');
        if (youMember) myAmount += parseFloat(youMember.amount) || 0;
        myAmount += newMembers.filter(m => m.name.toLowerCase() !== 'you' && !m.paid).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0);
        const finalAmount = myAmount > 0 ? Math.round(myAmount) : t.amount;
        apiCalls.push(
          fetch(`${API}/splits`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
            body: JSON.stringify({ transaction_id: t.id, total_amount: t.split.total_amount, members: newMembers, transaction_amount: finalAmount })
          })
        );
      }
    }

    // Instant UI update
    setSplitOverrides(prev => ({ ...prev, ...overrides }));
    setSettlingPerson(null);

    // Fire all APIs in parallel in background
    Promise.all(apiCalls).catch(err => alert('Error settling: ' + err.message));
  };

  // Splits: Toggle individual member paid status (optimistic)
  const handleToggleSplitPaid = (t, memberIdx) => {
    const newMembers = [...t.split.members];
    newMembers[memberIdx] = { ...newMembers[memberIdx], paid: !newMembers[memberIdx].paid };

    // Instant UI update
    setSplitOverrides(prev => ({ ...prev, [t.id]: { ...t.split, members: newMembers } }));

    // Fire API in background
    let myAmount = 0;
    const youMember = newMembers.find(m => m.name.toLowerCase() === 'you');
    if (youMember) myAmount += parseFloat(youMember.amount) || 0;
    myAmount += newMembers.filter(m => m.name.toLowerCase() !== 'you' && !m.paid).reduce((s, m) => s + (parseFloat(m.amount) || 0), 0);
    const finalAmount = myAmount > 0 ? Math.round(myAmount) : t.amount;
    fetch(`${API}/splits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
      body: JSON.stringify({ transaction_id: t.id, total_amount: t.split.total_amount, members: newMembers, transaction_amount: finalAmount })
    }).catch(err => {
      // Revert on error
      setSplitOverrides(prev => { const n = { ...prev }; delete n[t.id]; return n; });
      alert('Error updating split: ' + err.message);
    });
  };

  const spendRes = useApi(() => apiGet(`/money/summary?spend_month=${monthKey()}`), dataVersion, hasOpened);
  const currentMonthSpending = spendRes.data?.spending || {};


  const handleInlineBudgetSave = async (category) => {
    try {
      const res = await fetch(`${API}/budgets`, {
        method: "PUT",
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
        body: JSON.stringify({ category, monthly_limit: editingBudgetValue === "" ? null : parseFloat(editingBudgetValue) })
      });
      if (res.ok) {
        refreshBudgets();
        setEditingBudgetCategory(null);
      } else {
        alert("Failed to save budget.");
      }
    } catch (err) {
      alert("Error: " + err.message);
    }
  };

  // The page's frame (headers, filters) needs no data, so it shows at once; only
  // the parts waiting on a request show a placeholder of the same size.
  return (
    <div>
      {/* Spending Analyzer Section - Collapsible */}
      <div className="analyser-card">
        <div
          className={`analyser-header ${expanded ? 'open' : ''}`}
          onClick={() => setExpanded(!expanded)}
        >
          <div className="analyser-header-left">
            <div className="analyser-header-icon">📊</div>
            <div>
              <div className="analyser-header-title">Spending Analyser</div>
              <div className="analyser-header-sub" style={{ display: 'none' }}></div>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button
              onClick={handleShareSnapshot}
              className="action-btn secondary"
              disabled={!!captureMode}
              style={{ padding: '0', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', color: 'var(--text2)' }}
              title="Share Snapshot"
            >
              {captureMode ? (
                <span style={{ fontSize: '12px' }}>⏳</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="18" cy="5" r="3" /><circle cx="6" cy="12" r="3" /><circle cx="18" cy="19" r="3" /><line x1="8.59" y1="13.51" x2="15.42" y2="17.49" /><line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
                </svg>
              )}
            </button>
            <button
              onClick={handleExportPDF}
              className="action-btn secondary"
              disabled={!!captureMode}
              style={{ padding: '0', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px', color: 'var(--text2)' }}
              title="Save PDF"
            >
              {captureMode ? (
                <span style={{ fontSize: '12px' }}>⏳</span>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /><line x1="16" y1="13" x2="8" y2="13" /><line x1="16" y1="17" x2="8" y2="17" /><polyline points="10 9 9 9 8 9" />
                </svg>
              )}
            </button>
            {canEdit && (
            <button
              onClick={(e) => { e.stopPropagation(); setIsCategoryModalOpen(true); }}
              className="action-btn secondary"
              style={{ padding: '0', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: '32px', height: '32px', borderRadius: '8px' }}
              title="Manage Categories"
            >
              <span style={{ fontSize: '14px' }}>⚙️</span>
            </button>
            )}
            <span className={`analyser-chevron ${expanded ? 'open' : ''}`} style={{ marginLeft: '4px' }}>▼</span>
          </div>
        </div>

        {expanded && (
          <div style={{ animation: 'fadeIn 0.3s ease', padding: '1.5rem' }}>

            {/* Analyzer Filters */}
            <div className="filter-bar" style={{ marginBottom: '1.5rem' }} ref={dropdownRef}>
              {/* What the slices are, and the way back out of a drill-down */}
              <div className="ac-seg sm" role="tablist" aria-label="Breakdown by">
                {[['heading', 'Category'], ['account', 'Account']].map(([group, label]) => (
                  <button key={group} type="button" role="tab" aria-selected={analyzerGroup === group}
                          className={`ac-seg-btn ${analyzerGroup === group ? 'active' : ''}`}
                          onClick={() => setAnalyzerGroup(group)}>{label}</button>
                ))}
              </div>
              {drillStack.length > 0 && (
                <button type="button" className="an-back" onClick={drillBack}
                        title={`Back from ${drillStack.map(d => d.label).join(' › ')}`}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
                  <span>Back</span>
                  <span className="an-crumbs">
                    {drillStack.map((d, i) => (
                      <span key={i}>{i > 0 && <i>›</i>}{i === drillStack.length - 1 ? <b>{d.label}</b> : d.label}</span>
                    ))}
                  </span>
                </button>
              )}
              <span className="an-divider" aria-hidden="true" />
              <MultiSelectDropdown
                label="Account"
                icon="🏦"
                options={allAccountsList}
                filterState={chartAccounts}
                setFilterState={setChartAccounts}
                dropdownKey="analyzerAccount"
              openDropdown={openDropdown}
            setOpenDropdown={setOpenDropdown}
          />
              <MultiSelectDropdown
                label="Type"
                icon="💳"
                options={allTypes}
                filterState={chartTypes}
                setFilterState={setChartTypes}
                dropdownKey="analyzerType"
              openDropdown={openDropdown}
            setOpenDropdown={setOpenDropdown}
          />
              <MultiSelectDropdown
                label="Month"
                icon="📅"
                options={allMonths}
                filterState={chartMonths}
                setFilterState={setChartMonths}
                dropdownKey="analyzerMonth"
                maxWidth="160px"
              openDropdown={openDropdown}
            setOpenDropdown={setOpenDropdown}
          />
              <MultiSelectDropdown
                label="Year"
                icon="📆"
                options={allYears}
                filterState={chartYears}
                setFilterState={setChartYears}
                dropdownKey="analyzerYear"
                maxWidth="160px"
              openDropdown={openDropdown}
            setOpenDropdown={setOpenDropdown}
          />
              <MultiSelectDropdown
                label="Heading"
                icon="🏷️"
                options={allHeadings}
                filterState={chartHeadings}
                setFilterState={setChartHeadings}
                dropdownKey="analyzerHeading"
              openDropdown={openDropdown}
            setOpenDropdown={setOpenDropdown}
          />
              {/* FY Filter upgraded to CustomSelect for portal support */}
              <CustomSelect
                value={chartFY}
                onChange={(fy) => handleChartFYChange(fy === chartFY ? '' : fy)}
                options={allFYs.map(fy => ({ label: `FY ${fy}`, value: fy }))}
                placeholder="All FYs"
                minWidth="110px"
                icon={<span style={{ fontSize: '0.8rem', color: 'var(--text2)' }}>📅</span>}
              />
              {/* Date Range Filter */}
              <div className="date-filter-chip">
                <span style={{ fontSize: '0.8rem', color: 'var(--text2)' }}>📅</span>
                <input
                  type="date"
                  value={chartDateFrom}
                  onChange={e => { setChartDateFrom(e.target.value); setChartFY(""); }}
                  style={{ background: 'transparent', border: 'none', outline: 'none', color: chartDateFrom ? 'var(--text)' : 'var(--text2)', fontSize: '0.8rem', fontFamily: "'DM Sans', sans-serif", width: chartDateFrom ? '100px' : '90px', cursor: 'pointer' }}
                />
                <span style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>→</span>
                <input
                  type="date"
                  value={chartDateTo}
                  onChange={e => { setChartDateTo(e.target.value); setChartFY(""); }}
                  min={chartDateFrom}
                  style={{ background: 'transparent', border: 'none', outline: 'none', color: chartDateTo ? 'var(--text)' : 'var(--text2)', fontSize: '0.8rem', fontFamily: "'DM Sans', sans-serif", width: chartDateTo ? '100px' : '90px', cursor: 'pointer' }}
                />
                {(chartDateFrom || chartDateTo) && (
                  <button onClick={() => { setChartDateFrom(''); setChartDateTo(''); setChartFY(''); }} style={{ background: 'none', border: 'none', color: 'var(--text2)', cursor: 'pointer', fontSize: '0.9rem', padding: 0, lineHeight: 1 }}>×</button>
                )}
              </div>
              {(chartAccounts.included.size > 0 || chartAccounts.excluded.size > 0 ||
                chartTypes.included.size > 0 || chartTypes.excluded.size > 0 ||
                chartMonths.included.size > 0 || chartMonths.excluded.size > 0 ||
                chartYears.included.size > 0 || chartYears.excluded.size > 0 ||
                chartHeadings.included.size > 0 || chartHeadings.excluded.size > 0 ||
                chartDateFrom || chartDateTo || chartFY) && (
                  <button
                    className="filter-chip"
                    onClick={() => {
                      const empty = { included: new Set(), excluded: new Set() };
                      setChartAccounts(empty); setChartTypes(empty); setChartMonths(empty);
                      setChartYears(empty); setChartHeadings(empty);
                      setChartDateFrom(""); setChartDateTo(""); setChartFY("");
                      setDrillStack([]);
                    }}
                    style={{ border: '1px dashed var(--neg)', color: 'var(--neg)', background: 'transparent' }}
                  >
                    <span>❌</span><span>Clear</span>
                  </button>
                )}
            </div>

            {/* While new numbers are worked out: the old ones dim under a moving line. */}
            <div className={`load-line ${analyzerRefreshing ? 'on' : ''}`} style={{ margin: '-0.95rem 0 calc(0.95rem - 3px)' }} aria-hidden="true" />
            <div className={`an-body ${analyzerRefreshing ? 'is-refreshing' : ''}`} aria-busy={analyzerRefreshing}>
            {/* Pie Chart + Legend Grid */}
            {pieArr.length > 0 ? (
              <div className="pie-grid">
                {/* Pie Chart */}
                {/* 3D Modern Donut Chart */}
                <div style={{ position: 'relative', background: 'rgba(var(--accent-rgb), 0.04)', borderRadius: '16px', padding: '1.5rem', border: '1px solid rgba(var(--accent-rgb), 0.1)', height: '380px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {/* A new set of slices (a drill-down, Category ↔ Account) fades in whole: the
                      chart's own sweep showed half-drawn slivers. New amounts just update. */}
                  <div key={pieArr.slice(0, 10).map(d => d.name).join('|')} className="donut-in">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      {/* 1. The 3D "Depth" Base Layer (Shifted down and darkened) */}
                      <Pie
                        data={pieArr.slice(0, 10)}
                        dataKey="value"
                        cx="50%"
                        cy="54%" /* Shifted down to create thickness */
                        outerRadius={125}
                        innerRadius={80}
                        paddingAngle={5}
                        cornerRadius={8}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {pieArr.slice(0, 10).map((_, i) => (
                          <Cell
                            key={`depth-${i}`}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                            style={{ filter: 'brightness(0.45)' }} /* Darkens the sides for realistic shadow */
                          />
                        ))}
                      </Pie>

                      {/* 2. The Main "Top" Glassy Layer */}
                      <Pie
                        data={pieArr.slice(0, 10)}
                        dataKey="value"
                        cx="50%"
                        cy="54%" /* Shifted down to create thickness */
                        outerRadius={125}
                        innerRadius={80}
                        paddingAngle={5}
                        cornerRadius={8}
                        stroke="none"
                        isAnimationActive={false}
                      >
                        {pieArr.slice(0, 10).map((_, i) => (
                          <Cell
                            key={i}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                            style={{
                              filter: 'drop-shadow(0px 8px 12px rgba(0,0,0,0.5))', /* Floats the top layer */
                              transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                              cursor: 'pointer'
                            }}
                          />
                        ))}
                      </Pie>
                      <Tooltip
                        content={<CustomPieTooltip pieData={pieArr} />}
                        wrapperStyle={{ zIndex: 100 }} /* Forces tooltip above the center text */
                        cursor={{ fill: 'transparent' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                  </div>

                  {/* Floating Total Label perfectly centered in the Donut hole */}
                  <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 600 }}>Total</div>
                    {(() => {
                      const sumStr = '₹' + pieArr.reduce((sum, item) => sum + item.value, 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
                      return (
                        <div style={{ fontFamily: 'Syne, sans-serif', fontSize: sumStr.length > 7 ? '1rem' : '1.3rem', fontWeight: 800, color: 'var(--text)' }}>
                          {sumStr}
                        </div>
                      );
                    })()}
                  </div>
                </div>

                {/* Legend - Scrollable Container */}
                <div
                  className="pie-legend-container"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    height: '380px',
                    background: 'rgba(var(--accent-rgb), 0.04)',
                    border: '1px solid rgba(var(--accent-rgb), 0.1)',
                    borderRadius: '16px',
                    padding: '1.5rem 1rem',
                    position: 'relative',
                    overflow: 'hidden'
                  }}
                >
                  {/* Scroll Indicator Top */}
                  <div style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    height: '20px',
                    background: 'linear-gradient(to bottom, rgba(var(--accent-rgb), 0.1), rgba(var(--accent-rgb), 0))',
                    borderRadius: '16px 16px 0 0',
                    pointerEvents: 'none',
                    zIndex: 5
                  }} />

                  {/* Legend Items */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.65rem',
                      overflowY: 'auto',
                      paddingRight: '0.5rem',
                      flex: 1,
                      paddingTop: '0.5rem'
                    }}
                    className="pie-legend-scroll"
                  >
                    {pieArr.map((d, i) => {
                      const total = pieArr.reduce((s, x) => s + x.value, 0);
                      const pct = total > 0 ? ((d.value / total) * 100).toFixed(1) : '0';

                      // Highlight based on whether we are looking at Headings or Descriptions
                      const isSelected = byAccount ? false : isShowingDescriptions
                        ? filterDesc === d.name
                        : filterHeadings.included.has(d.name);

                      return (
                        <div
                          key={d.name}
                          className={`pie-legend-item ${isSelected ? 'selected' : ''}`}
                          style={{ flexShrink: 0 }}
                          onClick={() => {
                            if (byAccount) { pickAnalyzerAccount(d.name); return; }
                            if (isShowingDescriptions) {
                              // Toggles the description filter for the table below
                              if (filterDesc === d.name) {
                                setFilterDesc("");
                              } else {
                                setFilterDesc(d.name === "No Description" ? "" : d.name);
                                setFilterHeadings({ ...chartHeadings });
                              }
                            } else {
                              // Drills down the chart AND filters the table below!
                              drillInto(d.name);
                              setChartHeadings({ included: new Set([d.name]), excluded: new Set() });
                              setFilterHeadings({ included: new Set([d.name]), excluded: new Set() });
                              setFilterDesc("");
                            }

                            // Sync base table filters with the chart
                            setFilterAccounts({ ...chartAccounts });
                            setFilterTypes({ ...chartTypes });
                            setFilterMonths({ ...chartMonths });
                            setFilterYears({ ...chartYears });
                            document.querySelector('.tx-table-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                          }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                background: PIE_COLORS[i % PIE_COLORS.length],
                                width: '12px',
                                height: '12px',
                                borderRadius: '4px',
                                flexShrink: 0,
                                boxShadow: `0 2px 8px ${PIE_COLORS[i % PIE_COLORS.length]}40`
                              }}
                            />
                            <span style={{ color: 'var(--text3)', fontSize: '0.85rem', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.75rem', marginLeft: '0.75rem', flexShrink: 0 }}>
                            <span style={{ color: 'var(--text)', fontWeight: 700, fontSize: '0.85rem', minWidth: '75px', textAlign: 'right', fontFamily: 'Syne, sans-serif' }}>₹{Number(d.value).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                            <span style={{ color: 'var(--text2)', fontSize: '0.7rem', minWidth: '38px', textAlign: 'right', fontWeight: 600 }}>{pct}%</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Scroll Indicator Bottom - shows scrollable state */}
                  <div style={{
                    position: 'absolute',
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: '30px',
                    background: 'linear-gradient(to top, rgba(var(--accent-rgb), 0.1), rgba(var(--accent-rgb), 0))',
                    borderRadius: '0 0 16px 16px',
                    pointerEvents: 'none',
                    zIndex: 5
                  }} />
                </div>
              </div>
            ) : analyzerLoading ? (
              <div className="pie-grid" aria-busy="true">
                <div className="skeleton-block" style={{ height: '380px', borderRadius: '16px' }} />
                <div className="skeleton-block" style={{ height: '380px', borderRadius: '16px' }} />
              </div>
            ) : (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#94a3b8', fontSize: '0.9rem', gridColumn: '1 / -1' }}>
                📭 No transactions match your filters
              </div>
            )}

            {byAccount && pieArr.length > 0 && (
              <AccountAverages
                stats={analyzerRes.data?.accounts}
                colorFor={(account) => {
                  const i = pieArr.findIndex(g => g.name === account);
                  return i >= 0 ? PIE_COLORS[i % PIE_COLORS.length] : 'var(--text3)';
                }}
                spending={chartTypes.included.size === 1 && chartTypes.included.has('Debit')}
                onPick={pickAnalyzerAccount}
              />
            )}

            {/* Transaction Count Stats */}
            {analyzerStats.count > 0 && (
              <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(99,102,241,0.08)', borderRadius: '10px', border: '1px solid rgba(99,102,241,0.2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-around', textAlign: 'center', gap: '1rem' }}>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '0.5rem' }}>Income Txns</div>
                    <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--pos)' }}>
                      {analyzerStats.credit.count}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                      {fmt(analyzerStats.credit.sum)}
                    </div>
                  </div>
                  <div style={{ width: '1px', background: 'rgba(255,255,255,0.1)' }}></div>
                  <div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text2)', textTransform: 'uppercase', letterSpacing: '0.3px', marginBottom: '0.5rem' }}>Expense Txns</div>
                    <div style={{ fontSize: '1.3rem', fontWeight: 700, color: 'var(--neg)' }}>
                      {analyzerStats.debit.count}
                    </div>
                    <div style={{ fontSize: '0.8rem', color: 'var(--text2)', marginTop: '0.25rem' }}>
                      {fmt(analyzerStats.debit.sum)}
                    </div>
                  </div>
                </div>
              </div>
            )}
            </div>
          </div>
        )}
      </div>


      {/* 🎯 Budget Goals Section - Collapsible */}
      <BudgetGoalsSection
        budgetExpanded={budgetExpanded}
        setBudgetExpanded={setBudgetExpanded}
        budgets={budgets}
        currentMonthSpending={currentMonthSpending}
        setIsBudgetModalOpen={setIsBudgetModalOpen}
        editingBudgetCategory={editingBudgetCategory}
        setEditingBudgetCategory={setEditingBudgetCategory}
        editingBudgetValue={editingBudgetValue}
        setEditingBudgetValue={setEditingBudgetValue}
        handleInlineBudgetSave={handleInlineBudgetSave}
        spendingLoaded={!!spendRes.data}
      />

      {/* Splits Section - Collapsible, same style as Spending Analyser */}
      {!splitsRes.data ? <SectionCardSkeleton /> : <SplitsSection
        splitsExpanded={splitsExpanded}
        setSplitsExpanded={setSplitsExpanded}
        activeSplits={activeSplits}
        settledSplits={settledSplits}
        splitBalances={splitBalances}
        totalOwed={totalOwed}
        settlingPerson={settlingPerson}
        handleSettlePerson={handleSettlePerson}
        handleToggleSplitPaid={handleToggleSplitPaid}
      />}

      {/* Transactions Table */}
      <TransactionsTableSection
        balancesAllowed={balancesAllowed}
        withBalances={withBalances}
        onToggleBalances={toggleTxBalances}
        accounts={accounts}
        dropdownRef={dropdownRef}
        openDropdown={openDropdown}
        setOpenDropdown={setOpenDropdown}
        filterVisibility={filterVisibility} setFilterVisibility={setFilterVisibility}
        allAccountsList={allAccountsList} filterAccounts={filterAccounts} setFilterAccounts={setFilterAccounts}
        allTypes={allTypes} filterTypes={filterTypes} setFilterTypes={setFilterTypes}
        allMonths={allMonths} filterMonths={filterMonths} setFilterMonths={setFilterMonths}
        allYears={allYears} filterYears={filterYears} setFilterYears={setFilterYears}
        allHeadings={allHeadings} filterHeadings={filterHeadings} setFilterHeadings={setFilterHeadings}
        allFYs={allFYs} filterFY={filterFY} handleFilterFYChange={handleFilterFYChange}
        filterDateFrom={filterDateFrom} setFilterDateFrom={setFilterDateFrom}
        filterDateTo={filterDateTo} setFilterDateTo={setFilterDateTo}
        setFilterFY={setFilterFY}
        filterDesc={filterDesc} setFilterDesc={setFilterDesc}
        tableTotal={tableTotal}
        tableSums={tableSums}
        tableFirstLoad={tableFirstLoad}
        tableRefreshing={tableRefreshing}
        totalPages={totalPages}
        paginatedRows={paginatedRows}
        currentPage={currentPage} setCurrentPage={setCurrentPage}
        rowsPerPage={rowsPerPage} setRowsPerPage={setRowsPerPage}
        colWidths={colWidths}
        handleRowClick={handleRowClick}
        handleStartResize={handleStartResize}
        handleSortClick={handleSortClick}
        sortBy={sortBy}
        sortDir={sortDir}
        selectedIds={selectedIds} setSelectedIds={setSelectedIds}
        handleSelectAll={handleSelectAll}
        handleRowSelect={handleRowSelect}
        setActionMenuTx={setActionMenuTx}
        setEditingTx={setEditingTx}
        setCopyingTx={setCopyingTx}
        handleDelete={handleDelete}
        handleBulkDelete={handleBulkDelete}
        isBulkEditOpen={isBulkEditOpen} setIsBulkEditOpen={setIsBulkEditOpen}
        isBulkCopyOpen={isBulkCopyOpen} setIsBulkCopyOpen={setIsBulkCopyOpen}
        selectedTransactions={selectedTransactions}
        categories={categories}
        onRefresh={onRefresh}
      />

      {editingTx && (
        <EditTransactionModal
          tx={editingTx}
          categories={categories}
          onClose={() => setEditingTx(null)}
          onRefresh={onRefresh}
        />
      )}

      {copyingTx && (
        <EditTransactionModal
          tx={copyingTx}
          categories={categories}
          onClose={() => setCopyingTx(null)}
          onRefresh={onRefresh}
          isCopy={true}
        />
      )}

      {/* CATEGORY MANAGER MODAL */}
      {isCategoryModalOpen && (
        <CategoryExclusionModal
          excludedHeadings={meta.excluded_headings}
          allHeadings={allHeadings}
          onClose={() => setIsCategoryModalOpen(false)}
          onRefresh={onRefresh}
        />
      )}

      {/* BUDGET MANAGER MODAL */}
      {isBudgetModalOpen && (
        <BudgetManagerModal
          allHeadings={allHeadings}
          budgets={budgets}
          onClose={() => setIsBudgetModalOpen(false)}
          onRefresh={refreshBudgets}
        />
      )}

      {/* TRANSACTION DETAILS / ACTION MENU MODAL */}
      <TransactionDetailsModal
        actionMenuTx={actionMenuTx}
        setActionMenuTx={setActionMenuTx}
        setEditingTx={setEditingTx}
        setCopyingTx={setCopyingTx}
        handleDelete={handleDelete}
        setSplitOverrides={setSplitOverrides}
        onRefresh={onRefresh}
      />

      {/* 📸 HIDDEN SNAPSHOT POSTER CHUNKS 📸 */}
      <SnapshotPoster
        pieArr={pieArr}
        captureColors={captureColors}
        captureMode={captureMode}
        isShowingDescriptions={isShowingDescriptions}
        filterDesc={filterDesc}
        chartHeadings={chartHeadings}
        analyzerCount={analyzerStats.count}
        renderActiveFilters={renderActiveFilters}
        PIE_COLORS={PIE_COLORS}
      />

    </div>
  );
}

export default memo(MoneyTab);
