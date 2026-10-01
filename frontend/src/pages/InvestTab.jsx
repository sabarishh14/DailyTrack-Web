import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from './SabDekho';

import { API } from '../constants';
import { getToken, formatDate, fmt } from '../utils';
import MultiAssetSelect from '../components/MultiAssetSelect';
import CustomSelect from '../components/CustomSelect';
import AddManualAssetModal from '../components/AddManualAssetModal';
import EditManualAssetModal from '../components/EditManualAssetModal';
import PinLockOverlay from './invest-components/PinLockOverlay';
import { useAccess } from '../access/AccessContext';

function InvestTab({ investments, manualAssets, assetList, onAdd }) {
  const access = useAccess();
  const canEdit = access.can('invest', 'edit');
  const isOwner = access.isOwner;
// 🚀 PIN LOCK STATES
  const [savedPin, setSavedPin] = useState(localStorage.getItem('dt_inv_pin'));
  const [isUnlocked, setIsUnlocked] = useState(sessionStorage.getItem('dt_inv_unlocked') === 'true');
  const [pinInput, setPinInput] = useState('');
  const [pinError, setPinError] = useState(false);
  const [editingAsset, setEditingAsset] = useState(null);

  const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6366f1';

  const [showPin, setShowPin] = useState(false);
  const inputRefs = useRef([]);

  // 🚀 GLOBAL ESCAPE: Closes Invest-level Modals
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setIsAddModalOpen(false);
        setEditingAsset(null);
        setDrillDownDate(null);
        setShowAssetSettings(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  const handlePinChange = (index, value) => {
    if (!/^[0-9]*$/.test(value)) return;
    let newPin = (pinInput || '').split('');
    while (newPin.length < 4) newPin.push('');
    newPin[index] = value;
    const resultingPin = newPin.slice(0, 4).join('');
    setPinInput(resultingPin);
    setPinError(false);

    if (value !== '' && index < 3) {
      inputRefs.current[index + 1]?.focus();
    }

    // Auto-submit when all 4 digits are filled
    if (value !== '' && index === 3 && resultingPin.length === 4) {
      setTimeout(() => {
        // Inline the submit logic to use resultingPin directly
        if (!savedPin) {
          localStorage.setItem('dt_inv_pin', resultingPin);
          sessionStorage.setItem('dt_inv_unlocked', 'true');
          setSavedPin(resultingPin);
          setIsUnlocked(true);
        } else {
          if (resultingPin === savedPin) {
            sessionStorage.setItem('dt_inv_unlocked', 'true');
            setIsUnlocked(true);
            setPinError(false);
          } else {
            setPinError(true);
            setPinInput('');
            inputRefs.current[0]?.focus();
          }
        }
      }, 150); // Small delay for visual feedback
    }
  };

  const handlePinKeyDown = (index, e) => {
    if (e.key === 'Backspace' && (!pinInput[index] || pinInput[index] === '') && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === 'Enter') {
      handlePinSubmit();
    }
  };

  // ---> ADD THIS NEW BLOCK HERE <---
  const [xirr, setXirr] = useState(null);
  const [loadingXirr, setLoadingXirr] = useState(false);
  const [isAnalyserOpen, setIsAnalyserOpen] = useState(true);
  useEffect(() => {
    if (isUnlocked) {
      const fetchXirr = async () => {
        setLoadingXirr(true);
        try {
          const res = await fetch(`${API}/investments/xirr`, {
            headers: { 'Authorization': `Bearer ${getToken()}` }
          });
          const data = await res.json();
          if (data.success) setXirr(data.xirr);
        } catch (e) {
          console.error("Failed to fetch XIRR", e);
        } finally {
          setLoadingXirr(false);
        }
      };
      fetchXirr();
    }
  }, [isUnlocked, investments]);

  const handlePinSubmit = () => {
    if (!savedPin) {
      if (pinInput.length === 4) {
        localStorage.setItem('dt_inv_pin', pinInput);
        sessionStorage.setItem('dt_inv_unlocked', 'true');
        setSavedPin(pinInput);
        setIsUnlocked(true);
      } else {
        setPinError(true);
      }
    } else {
      if (pinInput === savedPin) {
        sessionStorage.setItem('dt_inv_unlocked', 'true');
        setIsUnlocked(true);
        setPinError(false);
      } else {
        setPinError(true);
        setPinInput('');
      }
    }
  };

  const [syncing, setSyncing] = useState(false);
  const [filterMonth, setFilterMonth] = useState("");
  const [sortBy, setSortBy] = useState("date");
  const [sortDir, setSortDir] = useState("desc");
  const [showTokenInput, setShowTokenInput] = useState(false);
  const [tokenStr, setTokenStr] = useState("");
  const [syncingSheets, setSyncingSheets] = useState(false);

  // 🚀 MASTER CHART & MULTI-SELECT STATES
  const [chartCategory, setChartCategory] = useState('ALL');
  const [timeframe, setTimeframe] = useState('3M');
  const [chartMode, setChartMode] = useState('PERCENTAGE'); // 🚀 NEW: 'ABSOLUTE' or 'PERCENTAGE'
  const [selectedAssets, setSelectedAssets] = useState(new Set());
  const segRef = useRef(null);
  const segBtnRefs = useRef([]);

  // 🚀 OPTIMIZATION: IN-MEMORY CACHE
  const assetHistoryCache = useRef({});
  const drilldownCache = useRef({});
  const [isDrillDownLoading, setIsDrillDownLoading] = useState(false);
  const [triggerRender, setTriggerRender] = useState(0);

  // Fetch history specifically when multiple micro-assets are selected
  useEffect(() => {
    // Only clear when something is selected: a fresh empty Set every time re-ran this forever.
    if (chartCategory === 'ALL') { setSelectedAssets(prev => (prev.size ? new Set() : prev)); return; }

    if (selectedAssets.size > 0) {
      // Find which assets we don't have cached yet
      const missing = Array.from(selectedAssets).filter(sym => !assetHistoryCache.current[sym]);
      if (missing.length > 0) {
        Promise.all(missing.map(sym =>
          fetch(`${API}/investments/history?symbol=${encodeURIComponent(sym)}&type=${chartCategory}`, {
            headers: { 'Authorization': `Bearer ${getToken()}` }
          }).then(r => r.json())
        )).then(results => {
          missing.forEach((sym, i) => { assetHistoryCache.current[sym] = results[i]; });
          setTriggerRender(prev => prev + 1); // Force chart to redraw with new cache
        });
      }
    }
  }, [selectedAssets, chartCategory]);

  const [expandedSection, setExpandedSection] = useState('MARKET');
  const [isAddModalOpen, setIsAddModalOpen] = useState(false);
  const [showBalances, setShowBalances] = useState(false);
  const [invCurrentPage, setInvCurrentPage] = useState(0);
  const [invRowsPerPage, setInvRowsPerPage] = useState(5);
  const [isMobile, setIsMobile] = useState(window.innerWidth <= 768);

  // 🚀 ASSET VISIBILITY TOGGLES
  const [hiddenCategories, setHiddenCategories] = useState(() => {
    try {
      const stored = localStorage.getItem('dt_inv_hidden_cats');
      if (stored) return JSON.parse(stored);
      return ['PROVIDENT', 'GOLD'];
    }
    catch { return ['PROVIDENT', 'GOLD']; }
  });
  const [showAssetSettings, setShowAssetSettings] = useState(false);

  const ASSET_CATEGORIES = [
    { id: 'EQUITY', label: 'Stocks', field_curr: 'curr_stocks', field_inv: 'inv_stocks', color: 'var(--accent)', icon: '📈' },
    { id: 'MF', label: 'Mutual Funds', field_curr: 'curr_mf', field_inv: 'inv_mf', color: '#8b5cf6', icon: '🏦' },
    { id: 'FIXED_INCOME', label: 'Fixed Income', field_curr: 'curr_fixed', field_inv: 'inv_fixed', color: '#10b981', icon: '💰' },
    { id: 'PROVIDENT', label: 'Retirement', field_curr: 'curr_prov', field_inv: 'inv_prov', color: '#f59e0b', icon: '🛡️' },
    { id: 'GOLD', label: 'Gold', field_curr: 'curr_gold', field_inv: 'inv_gold', color: '#eab308', icon: '🥇' },
  ];

  const toggleCategory = (catId) => {
    setHiddenCategories(prev => {
      const next = prev.includes(catId) ? prev.filter(c => c !== catId) : [...prev, catId];
      localStorage.setItem('dt_inv_hidden_cats', JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleDeleteManualAsset = async (id) => {
    if (!window.confirm("Are you sure you want to delete this asset?")) return;
    try {
      const res = await fetch(`${API}/manual_assets/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${getToken()}` } });
      if (res.ok) onAdd();
    } catch (e) { alert("Error deleting asset: " + e.message); }
  };

  const [drillDownDate, setDrillDownDate] = useState(null);
  const [drillDownData, setDrillDownData] = useState([]);
  const [drillDownType, setDrillDownType] = useState(null);
  const [drillSortBy, setDrillSortBy] = useState("symbol");
  const [drillSortDir, setDrillSortDir] = useState("asc");
  const [viewMode, setViewMode] = useState("ALL");

  // 🚀 COMPARISON STATES
  const [drillDownCompareDate, setDrillDownCompareDate] = useState(null);
  const [drillDownCompareData, setDrillDownCompareData] = useState([]);
  const [isCompareLoading, setIsCompareLoading] = useState(false);

  // Reusable Diff Badge for the UI
  const DiffBadge = ({ diff, isCurrency = true, isPct = false }) => {
    if (!diff || Math.abs(diff) < 0.01) return <span style={{ fontSize: '0.65rem', color: 'var(--text3)' }}>= No Change</span>;
    const isPos = diff > 0;
    const formatted = isPct ? diff.toFixed(2) + '%' : (isCurrency ? '₹' + Math.abs(diff).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : Math.abs(diff).toFixed(2));
    return (
      <span className={isPos ? 'pos' : 'neg'} style={{ fontSize: '0.7rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '2px', background: isPos ? 'rgba(52,211,153,0.1)' : 'rgba(248,113,113,0.1)', padding: '2px 6px', borderRadius: '4px', width: 'fit-content' }}>
        {isPos ? '▲' : '▼'} {formatted}
      </span>
    );
  };

  // 🚀 DYNAMIC CHART DATA PROCESSOR (Handles Multi-Line Overlaps & Percentages)
  const chartData = useMemo(() => {
    let data = [];

    if (selectedAssets.size > 0) {
      // 1. MULTI-LINE MODE: Merge cached timelines
      let dates = new Set();
      const assetsData = {};

      selectedAssets.forEach(sym => {
        const history = assetHistoryCache.current[sym] || [];
        history.forEach(d => {
          dates.add(d.date);
          if (!assetsData[d.date]) assetsData[d.date] = { date: formatDate(d.date), rawDate: new Date(d.date) };
          assetsData[d.date][sym] = d.Current;
          assetsData[d.date][`${sym}_Inv`] = d.Invested; // Hidden field for tooltip math
          assetsData[d.date][`${sym}_Pct`] = d.Invested > 0 ? ((d.Current - d.Invested) / d.Invested) * 100 : 0; // 🚀 Calculate % Return
        });
      });
      data = Array.from(dates).sort((a, b) => new Date(a) - new Date(b)).map(d => assetsData[d]);

    } else {
      // 2. CATEGORY TOTALS MODE
      let baseData = [...investments].reverse();
      if (!baseData || baseData.length === 0) return [];
      data = baseData.map(d => {
        let curr = 0; let inv = 0;
        if (chartCategory === 'ALL') { curr = d.total_curr; inv = d.total_inv; }
        else if (chartCategory === 'EQUITY') { curr = d.curr_stocks; inv = d.inv_stocks; }
        else if (chartCategory === 'MF') { curr = d.curr_mf; inv = d.inv_mf; }
        else if (chartCategory === 'PROVIDENT') { curr = d.curr_prov; inv = d.inv_prov; }
        else if (chartCategory === 'FIXED_INCOME') { curr = d.curr_fixed; inv = d.inv_fixed; }
        else if (chartCategory === 'GOLD') { curr = d.curr_gold; inv = d.inv_gold; }

        const pct = inv > 0 ? ((curr - inv) / inv) * 100 : 0;
        return { date: formatDate(d.date), rawDate: new Date(d.date), Current: curr || 0, Invested: inv || 0, ReturnPct: pct };
      });
    }

    // 3. APPLY TIMEFRAME
    if (timeframe !== 'ALL') {
      const now = new Date();
      let cutoffDate = new Date();
      if (timeframe === '1M') cutoffDate.setMonth(now.getMonth() - 1);
      else if (timeframe === '3M') cutoffDate.setMonth(now.getMonth() - 3);
      else if (timeframe === '6M') cutoffDate.setMonth(now.getMonth() - 6);
      else if (timeframe === '1Y') cutoffDate.setFullYear(now.getFullYear() - 1);
      else if (timeframe === 'YTD') cutoffDate = new Date(now.getFullYear(), 0, 1);
      data = data.filter(d => d.rawDate >= cutoffDate);
    }
    return data;
  }, [investments, chartCategory, timeframe, selectedAssets, triggerRender]);

  // 🚀 HIGH-CONTRAST PALETTE FOR MULTI-LINES
  const PIE_COLORS = [
    accentColor, // Dynamic accent
    "#f59e0b", // Amber
    "#10b981", // Emerald
    "#ec4899", // Pink
    "#06b6d4", // Cyan
    "#f97316", // Orange
    "#a855f7", // Purple
    "#84cc16", // Lime
    "#ef4444", // Red
    "#3b82f6"  // Blue
  ];

  // 🚀 UPGRADED TOOLTIP (Supports 10+ Multi-lines)
  const CustomInvestTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      return (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', minWidth: '220px' }}>
          <div style={{ fontSize: '0.8rem', color: 'var(--text3)', marginBottom: '10px', fontWeight: 600 }}>{label}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {payload.map((p, i) => {
              const sym = p.name;
              const curr = p.value || 0;
              const inv = selectedAssets.size > 0 ? (p.payload[`${sym}_Inv`] || 0) : (payload.find(x => x.dataKey === 'Invested')?.value || 0);
              const retAmt = curr - inv;
              const isPos = retAmt >= 0;
              const pct = selectedAssets.size > 0 ? (inv > 0 ? (retAmt / inv) * 100 : 0) : (payload[0].payload.ReturnPct || 0);

              // If in single mode, skip drawing the "Invested Amount" block as its own entity since we merge it above
              if (selectedAssets.size === 0 && sym === 'Invested Amount') return null;

              return (
                <div key={sym} style={{ borderBottom: (selectedAssets.size > 0 && i < payload.length - 1) ? '1px solid rgba(255,255,255,0.05)' : 'none', paddingBottom: (selectedAssets.size > 0 && i < payload.length - 1) ? '8px' : '0' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                    <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: p.color }}></div>
                    <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text)' }}>{sym === 'Current Value' ? 'Total Portfolio' : sym}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                    <span style={{ color: 'var(--text3)', fontSize: '0.75rem' }}>Current:</span>
                    <span style={{ color: 'var(--text)', fontWeight: 700 }}>{showBalances ? `₹${curr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '₹ ••••••'}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                    <span style={{ color: 'var(--text3)', fontSize: '0.75rem' }}>Return:</span>
                    <span className={isPos ? 'pos' : 'neg'} style={{ fontWeight: 600, fontSize: '0.75rem' }}>
                      {isPos ? '+' : '-'}{showBalances ? `₹${Math.abs(retAmt).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '₹ ••••••'} ({Math.abs(pct).toFixed(1)}%)
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      );
    }
    return null;
  };

  // 🚀 OPTIMIZED DRILL-DOWN FETCHER (Instant Caching)
  const fetchDrillDownData = async (dateStr, type) => {
    const cacheKey = `${dateStr}_${type}`;
    if (drilldownCache.current[cacheKey]) {
      setDrillDownData(drilldownCache.current[cacheKey]);
      setDrillDownType(type);
      setDrillDownDate(dateStr);
      setDrillSortBy("symbol"); setDrillSortDir("asc");
      return;
    }

    setIsDrillDownLoading(true);
    setDrillDownType(type);
    setDrillDownDate(dateStr);

    try {
      const endpoint = type === "EQUITY" ? "equity_holdings" : "holdings";
      const res = await fetch(`${API}/investments/${dateStr}/${endpoint}`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      const data = await res.json();

      const dataWithRet = data.map(d => ({
        ...d,
        ret_pct: d.ret_pct !== undefined ? d.ret_pct : (d.invested_value > 0 ? ((d.current_value - d.invested_value) / d.invested_value) * 100 : 0)
      }));

      drilldownCache.current[cacheKey] = dataWithRet;
      setDrillDownData(dataWithRet);
      setDrillSortBy("symbol"); setDrillSortDir("asc");
    } catch (e) {
      console.error(e);
    } finally {
      setIsDrillDownLoading(false);
    }
  };

  const fetchCompareData = async (dateStr, type) => {
    if (!dateStr) { setDrillDownCompareDate(null); setDrillDownCompareData([]); return; }
    const cacheKey = `${dateStr}_${type}`;
    if (drilldownCache.current[cacheKey]) {
      setDrillDownCompareData(drilldownCache.current[cacheKey]); setDrillDownCompareDate(dateStr); return;
    }
    setIsCompareLoading(true); setDrillDownCompareDate(dateStr);
    try {
      const endpoint = type === "EQUITY" ? "equity_holdings" : "holdings";
      const res = await fetch(`${API}/investments/${dateStr}/${endpoint}`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      const data = await res.json();
      const dataWithRet = data.map(d => ({ ...d, ret_pct: d.ret_pct !== undefined ? d.ret_pct : (d.invested_value > 0 ? ((d.current_value - d.invested_value) / d.invested_value) * 100 : 0) }));
      drilldownCache.current[cacheKey] = dataWithRet;
      setDrillDownCompareData(dataWithRet);
    } catch (e) { console.error(e); } finally { setIsCompareLoading(false); }
  };

  const openDrillDown = (dateStr) => {
    fetchDrillDownData(dateStr, 'EQUITY');

    const currentDate = new Date(dateStr);
    const earlierDates = investments
      .map(inv => inv.date.split('T')[0])
      .filter(dt => new Date(dt) < currentDate)
      .sort((a, b) => new Date(b) - new Date(a));

    if (earlierDates.length > 0) {
      const prevDate = earlierDates[0];
      setDrillDownCompareDate(prevDate);
      fetchCompareData(prevDate, 'EQUITY');
    } else {
      setDrillDownCompareDate(null);
      setDrillDownCompareData([]);
    }
  };

  const handleDrillSort = (col) => {
    if (drillSortBy === col) setDrillSortDir(drillSortDir === 'asc' ? 'desc' : 'asc');
    else { setDrillSortBy(col); setDrillSortDir('desc'); }
  };

  // 🚀 MERGED COMPARISON ENGINE
  const comparisonData = useMemo(() => {
    if (!drillDownCompareDate) return null;
    const mapB = {}; // Baseline (Older Date)
    drillDownCompareData.forEach(item => { mapB[item.symbol] = item; });
    const mapA = {}; // Target (Newer Date)
    drillDownData.forEach(item => { mapA[item.symbol] = item; });

    const allSymbols = Array.from(new Set([...Object.keys(mapA), ...Object.keys(mapB)]));
    return allSymbols.map(sym => {
      const a = mapA[sym] || { quantity: 0, invested_value: 0, current_value: 0, average_price: 0, ltp: 0, nav: 0, ret_pct: 0 };
      const b = mapB[sym] || { quantity: 0, invested_value: 0, current_value: 0, average_price: 0, ltp: 0, nav: 0, ret_pct: 0 };
      const priceA = drillDownType === 'EQUITY' ? a.ltp : a.nav;
      const priceB = drillDownType === 'EQUITY' ? b.ltp : b.nav;
      return {
        symbol: sym,
        qty_A: a.quantity, qty_diff: a.quantity - b.quantity, is_new: b.quantity === 0 && a.quantity > 0, is_exited: a.quantity === 0 && b.quantity > 0,
        price_A: priceA, price_diff: priceA - priceB,
        inv_A: a.invested_value, inv_diff: a.invested_value - b.invested_value,
        curr_A: a.current_value, curr_diff: a.current_value - b.current_value,
        ret_A: a.current_value - a.invested_value, ret_diff: (a.current_value - a.invested_value) - (b.current_value - b.invested_value),
        sort_val: a.current_value > 0 ? a.current_value : b.current_value
      };
    }).sort((x, y) => y.sort_val - x.sort_val);
  }, [drillDownData, drillDownCompareData, drillDownCompareDate, drillDownType]);

  // 🚀 COMPARISON SUMMARY TOTALS
  const comparisonSummary = useMemo(() => {
    if (!comparisonData || !drillDownCompareDate) return null;
    const totals = comparisonData.reduce((acc, h) => {
      acc.inv_A += h.inv_A;
      acc.curr_A += h.curr_A;
      acc.inv_B += (h.inv_A - h.inv_diff);  // B = A - diff
      acc.curr_B += (h.curr_A - h.curr_diff);
      return acc;
    }, { inv_A: 0, curr_A: 0, inv_B: 0, curr_B: 0 });
    totals.ret_A = totals.curr_A - totals.inv_A;
    totals.ret_B = totals.curr_B - totals.inv_B;
    totals.inv_diff = totals.inv_A - totals.inv_B;
    totals.curr_diff = totals.curr_A - totals.curr_B;
    totals.ret_diff = totals.ret_A - totals.ret_B;
    totals.ret_pct_A = totals.inv_A > 0 ? (totals.ret_A / totals.inv_A) * 100 : 0;
    totals.ret_pct_B = totals.inv_B > 0 ? (totals.ret_B / totals.inv_B) * 100 : 0;
    totals.stocks_new = comparisonData.filter(h => h.is_new).length;
    totals.stocks_exited = comparisonData.filter(h => h.is_exited).length;
    totals.total_stocks = comparisonData.length;
    return totals;
  }, [comparisonData, drillDownCompareDate]);

  const availableCompareDates = useMemo(() => {
    if (!drillDownDate) return [];
    return investments.filter(inv => inv.date.split('T')[0] !== drillDownDate).map(inv => ({
      label: formatDate(inv.date), value: inv.date.split('T')[0], rawDate: new Date(inv.date)
    })).sort((a, b) => b.rawDate - a.rawDate);
  }, [investments, drillDownDate]);

  const processedDrillDownData = useMemo(() => {
    let data = [...drillDownData];
    data.sort((a, b) => {
      let aVal = a[drillSortBy]; let bVal = b[drillSortBy];
      if (drillSortBy === 'price') {
        aVal = drillDownType === "EQUITY" ? a.ltp : a.nav;
        bVal = drillDownType === "EQUITY" ? b.ltp : b.nav;
      }
      if (typeof aVal === 'string') return drillSortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      return drillSortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });
    return data;
  }, [drillDownData, drillSortBy, drillSortDir, drillDownType]);

  const allMonths = useMemo(() => {
    return [...new Set(investments.map(inv => {
      if (!inv.date) return null;
      const d = new Date(inv.date);
      if (isNaN(d.getTime())) return null;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }))].filter(Boolean).sort().reverse().map(ym => {
      const [y, m] = ym.split('-');
      const d = new Date(y, m - 1, 1);
      return { val: ym, label: `${d.toLocaleString('default', { month: 'long' })} ${y}` };
    });
  }, [investments]);

  const processedData = useMemo(() => {
    let data = [...investments];
    if (filterMonth) {
      data = data.filter(inv => {
        if (!inv.date) return false;
        const d = new Date(inv.date);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === filterMonth;
      });
    }
    data.sort((a, b) => {
      const getVal = (item, key) => {
        if (key === 'date') return new Date(item.date).getTime();
        const invVal = viewMode === 'ALL' ? parseFloat(item.total_inv || 0) : viewMode === 'EQUITY' ? parseFloat(item.inv_stocks || 0) : parseFloat(item.inv_mf || 0);
        const currVal = viewMode === 'ALL' ? parseFloat(item.total_curr || 0) : viewMode === 'EQUITY' ? parseFloat(item.curr_stocks || 0) : parseFloat(item.curr_mf || 0);
        const retPct = viewMode === 'ALL' ? parseFloat(item.total_ret_pct || 0) : viewMode === 'EQUITY' ? parseFloat(item.ret_pct_stocks || 0) : parseFloat(item.ret_pct_mf || 0);
        const statusStr = viewMode === 'ALL' ? item.total_status : viewMode === 'EQUITY' ? item.status_stocks : item.status_mf;

        if (key === 'inv') return invVal; if (key === 'curr') return currVal;
        if (key === 'ret_amount') return currVal - invVal; if (key === 'ret_pct') return retPct;
        if (key === 'status') return statusStr; return 0;
      };
      const aVal = getVal(a, sortBy); const bVal = getVal(b, sortBy);
      if (typeof aVal === 'string') return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });
    return data;
  }, [investments, filterMonth, sortBy, sortDir, viewMode]);

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortBy(col); setSortDir('desc'); }
  };

  const handleOpenKite = () => { window.open("https://kite.zerodha.com/connect/LOGIN?api_key=6gcxnf0qycaphw5k", "_blank", "width=500,height=600"); setShowTokenInput(true); };

  const handleSubmitToken = async () => {
    let token = tokenStr.trim();
    if (token.includes("request_token=")) {
      const match = token.match(/request_token=([^&]+)/);
      if (match) token = match[1];
    }
    if (!token) return alert("❌ Please paste the full URL containing the request_token.");
    setSyncing(true);
    try {
      const res = await fetch(`${API}/sync/kite`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` }, body: JSON.stringify({ request_token: token }) });
      const data = await res.json();
      if (data.success) { alert("✅ " + data.message); onAdd(); setShowTokenInput(false); setTokenStr(""); }
      else alert("❌ Sync Failed: " + data.message);
    } catch (e) { alert("❌ Network Error: " + e.message); }
    finally { setSyncing(false); }
  };

  const handleSyncToSheets = async () => {
    setSyncingSheets(true);
    try {
      const res = await fetch(`${API}/sync/investments-to-sheets`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } });
      const data = await res.json();
      alert(data.success ? (data.message.includes("No new") ? "👍 " + data.message : "✅ " + data.message) : "❌ Sync Failed: " + data.message);
    } catch (e) { alert("❌ Network Error: " + e.message); }
    finally { setSyncingSheets(false); }
  };

  const invTotalPages = Math.ceil(processedData.length / invRowsPerPage);
  const invPaginatedRows = processedData.slice(invCurrentPage * invRowsPerPage, (invCurrentPage + 1) * invRowsPerPage);
  useEffect(() => { setInvCurrentPage(0); }, [filterMonth, sortBy, sortDir, viewMode]);

  const latest = investments.length > 0 ? investments[0] : null;

  // 🚀 FILTERED TOTALS (Respects hidden categories)
  const filteredTotals = useMemo(() => {
    if (!latest) return { curr: 0, inv: 0, ret: 0, retPct: 0 };
    let curr = 0, inv = 0;
    ASSET_CATEGORIES.forEach(cat => {
      if (!hiddenCategories.includes(cat.id)) {
        curr += parseFloat(latest[cat.field_curr] || 0);
        inv += parseFloat(latest[cat.field_inv] || 0);
      }
    });
    const ret = curr - inv;
    const retPct = inv > 0 ? (ret / inv) * 100 : 0;
    return { curr, inv, ret, retPct };
  }, [latest, hiddenCategories]);

  const pieData = latest ? ASSET_CATEGORIES
    .filter(cat => !hiddenCategories.includes(cat.id))
    .map(cat => ({ name: cat.label, value: parseFloat(latest[cat.field_curr] || 0), fill: cat.color }))
    .filter(d => d.value > 0) : [];

  return (
    <div style={{ position: 'relative', minHeight: '80vh' }}>

      {/* 🚀 THE PIN LOCK OVERLAY (Now Perfectly Centered) */}
      {!isUnlocked && (
        <PinLockOverlay
          savedPin={savedPin}
          pinInput={pinInput}
          pinError={pinError}
          showPin={showPin}
          setShowPin={setShowPin}
          inputRefs={inputRefs}
          handlePinChange={handlePinChange}
          handlePinKeyDown={handlePinKeyDown}
          handlePinSubmit={handlePinSubmit}
        />
      )}

      {/* 🚀 BLUR WRAPPER AROUND EXISTING CONTENT */}
      <div className="invest-layout" style={{
        display: 'block',
        filter: !isUnlocked ? 'blur(12px) grayscale(50%)' : 'none',
        pointerEvents: !isUnlocked ? 'none' : 'auto',
        userSelect: !isUnlocked ? 'none' : 'auto',
        transition: 'filter 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
        opacity: !isUnlocked ? 0.4 : 1
      }}>

        {/* 🚀 NEW HERO SECTION: Metrics & Allocation */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1.5rem', marginBottom: '2rem' }}>

          {/* Summary Metrics Card */}
          <div style={{ flex: '1 1 320px', background: 'var(--card)', padding: '1.5rem', borderRadius: '16px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '0.85rem', color: 'var(--text2)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px', whiteSpace: 'nowrap' }}>Combined Net Worth</span>
                    {hiddenCategories.length > 0 && (
                      <span className="filtered-badge">
                        ⚡ ({ASSET_CATEGORIES.length - hiddenCategories.length}/{ASSET_CATEGORIES.length})
                      </span>
                    )}
                  </div>
                  <div style={{ fontFamily: "'Syne', sans-serif", fontSize: 'clamp(1.4rem, 7vw, 2.8rem)', fontWeight: 800, color: 'var(--text)', lineHeight: 1.2, marginTop: '0.2rem', whiteSpace: 'nowrap' }}>
                    {showBalances ? fmt(filteredTotals.curr) : '₹ ••••••'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.25rem', flexShrink: 0, marginTop: '-4px' }}>
                  <button
                    onClick={() => setShowAssetSettings(!showAssetSettings)}
                    style={{
                      background: showAssetSettings ? 'rgba(99,102,241,0.15)' : 'transparent',
                      border: showAssetSettings ? '1px solid rgba(99,102,241,0.3)' : '1px solid transparent',
                      cursor: 'pointer', fontSize: '1.1rem', padding: '0.35rem',
                      opacity: showAssetSettings ? 1 : 0.7, transition: 'all 0.2s',
                      borderRadius: '8px', position: 'relative'
                    }}
                    onMouseEnter={e => e.currentTarget.style.opacity = 1}
                    onMouseLeave={e => { if (!showAssetSettings) e.currentTarget.style.opacity = 0.7; }}
                    title="Configure Net Worth Categories"
                  >
                    ⚙️
                    {hiddenCategories.length > 0 && (
                      <span style={{ position: 'absolute', top: '-2px', right: '-2px', width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)', border: '2px solid var(--card)' }} />
                    )}
                  </button>
                  <button
                    onClick={() => setShowBalances(!showBalances)}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.3rem', padding: '0.4rem', opacity: 0.7, transition: 'opacity 0.2s' }}
                    onMouseEnter={e => e.currentTarget.style.opacity = 1}
                    onMouseLeave={e => e.currentTarget.style.opacity = 0.7}
                    title={showBalances ? "Hide Balances" : "Show Balances"}
                  >
                    {showBalances ? '🙈' : '👁️'}
                  </button>
                </div>
              </div>

              {/* 🚀 ASSET VISIBILITY SETTINGS PANEL */}
              {showAssetSettings && (
                <div className="asset-settings-panel">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text2)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Include in Net Worth</span>
                    <button
                      onClick={() => {
                        if (hiddenCategories.length > 0) {
                          setHiddenCategories([]);
                          localStorage.setItem('dt_inv_hidden_cats', '[]');
                        } else {
                          const allIds = ASSET_CATEGORIES.map(c => c.id);
                          setHiddenCategories(allIds);
                          localStorage.setItem('dt_inv_hidden_cats', JSON.stringify(allIds));
                        }
                      }}
                      style={{ fontSize: '0.7rem', color: 'var(--accent)', background: 'transparent', border: 'none', cursor: 'pointer', fontWeight: 700, fontFamily: "'DM Sans', sans-serif", textDecoration: 'underline', textUnderlineOffset: '2px' }}
                    >
                      {hiddenCategories.length > 0 ? 'Show All' : 'Hide All'}
                    </button>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    {ASSET_CATEGORIES.map(cat => {
                      const isVisible = !hiddenCategories.includes(cat.id);
                      const catValue = latest ? parseFloat(latest[cat.field_curr] || 0) : 0;
                      return (
                        <div
                          key={cat.id}
                          className="asset-setting-row"
                          onClick={() => toggleCategory(cat.id)}
                          style={{ opacity: isVisible ? 1 : 0.5 }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flex: 1, minWidth: 0 }}>
                            <div style={{ width: '10px', height: '10px', borderRadius: '3px', background: cat.color, flexShrink: 0 }} />
                            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: isVisible ? 'var(--text)' : 'var(--text3)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', transition: 'color 0.2s', textDecoration: isVisible ? 'none' : 'line-through' }}>
                              {cat.icon} {cat.label}
                            </span>
                            {showBalances && catValue > 0 && (
                              <span style={{ fontSize: '0.75rem', color: 'var(--text3)', fontWeight: 500, flexShrink: 0 }}>
                                {fmt(catValue)}
                              </span>
                            )}
                          </div>
                          <button
                            onClick={(e) => { e.stopPropagation(); toggleCategory(cat.id); }}
                            style={{
                              width: '40px', height: '22px', borderRadius: '11px',
                              background: isVisible ? 'var(--pos)' : 'var(--border2)',
                              position: 'relative', border: 'none', cursor: 'pointer', transition: 'background 0.25s',
                              flexShrink: 0
                            }}
                          >
                            <div style={{
                              width: '16px', height: '16px', borderRadius: '50%', background: '#fff',
                              position: 'absolute', top: '3px',
                              left: isVisible ? '21px' : '3px',
                              transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                              boxShadow: '0 1px 4px rgba(0,0,0,0.25)'
                            }} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: '1.5rem', marginTop: '1rem', background: 'var(--bg2)', padding: '1rem', borderRadius: '12px', border: '1px solid var(--border)', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: '100px' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Total Invested</span>
                  <div style={{ fontWeight: 700, fontSize: '1.1rem', color: 'var(--text)', marginTop: '2px' }}>
                    {showBalances ? fmt(filteredTotals.inv) : '₹ ••••••'}
                  </div>
                </div>
                <div style={{ width: '1px', background: 'var(--border)' }}></div>
                <div style={{ flex: 1, minWidth: '100px' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Returns & XIRR</span>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginTop: '2px', flexWrap: 'wrap' }}>
                    <span className={filteredTotals.ret >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 800, fontSize: '1.1rem' }}>
                      {showBalances ? (filteredTotals.ret >= 0 ? '+' : '-') + fmt(Math.abs(filteredTotals.ret)) : '₹ ••••••'}
                    </span>
                    <span className={filteredTotals.retPct >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 700, fontSize: '0.85rem', opacity: 0.9 }}>
                      {latest ? `(${filteredTotals.retPct >= 0 ? '+' : '-'}${Math.abs(filteredTotals.retPct).toFixed(2)}% Abs)` : ''}
                    </span>

                    {/* ---> NEW XIRR BADGE <--- */}
                    {xirr !== null && (
                      <span className={xirr >= 0 ? 'pos' : 'neg'} style={{
                        fontWeight: 700, fontSize: '0.75rem',
                        background: xirr >= 0 ? 'rgba(52, 211, 153, 0.15)' : 'rgba(248, 113, 113, 0.15)',
                        padding: '0.2rem 0.5rem', borderRadius: '6px', border: `1px solid ${xirr >= 0 ? 'rgba(52, 211, 153, 0.3)' : 'rgba(248, 113, 113, 0.3)'}`,
                        marginLeft: '4px'
                      }}>
                        {loadingXirr ? '⏳' : `${xirr >= 0 ? '+' : ''}${xirr}% XIRR`}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Action Buttons */}
            {canEdit && (
            <div className="invest-action-buttons" style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem', flexWrap: 'wrap' }}>
              {!showTokenInput ? (
                <>
                  <button className="action-btn" style={{ flex: 1, minWidth: '120px', justifyContent: 'center', background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text)', boxShadow: 'none' }} onClick={() => setIsAddModalOpen(true)}>
                    ➕ Add Asset
                  </button>
                  {isOwner && (
                  <>
                  <button className="action-btn" style={{ flex: 1, minWidth: '120px', justifyContent: 'center', background: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)', boxShadow: '0 4px 15px rgba(20, 184, 166, 0.2)' }} onClick={handleSyncToSheets} disabled={syncingSheets}>
                    {syncingSheets ? '⏳ Syncing...' : '📥 Sync Sheets'}
                  </button>
                  <button className="action-btn" style={{ flex: 1, minWidth: '120px', justifyContent: 'center', background: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)', boxShadow: '0 4px 15px rgba(239, 68, 68, 0.3)' }} onClick={handleOpenKite}>
                    ⚡ Sync Broker
                  </button>
                  </>
                  )}
                </>
              ) : (
                <div style={{ display: 'flex', gap: '0.5rem', width: '100%', animation: 'fadeIn 0.3s ease', flexWrap: 'wrap' }}>
                  <input className="inp" placeholder="Paste request_token URL..." value={tokenStr} onChange={e => setTokenStr(e.target.value)} style={{ flex: '1 1 200px' }} />
                  <button className="action-btn" onClick={handleSubmitToken} disabled={syncing}>{syncing ? '⏳' : 'Sync'}</button>
                  <button className="action-btn secondary" onClick={() => { setShowTokenInput(false); setTokenStr(""); }}>✕</button>
                </div>
              )}
            </div>
            )}
          </div>

          {/* Allocation Donut Card - Mobile Wrapped */}
          <div style={{ flex: '1 1 320px', background: 'var(--card)', padding: '1.5rem', borderRadius: '16px', border: '1px solid var(--border)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '2rem', boxShadow: '0 4px 20px rgba(0,0,0,0.1)' }}>
            <div style={{ width: '220px', height: '220px', position: 'relative', flexShrink: 0 }}>
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pieData} dataKey="value" cx="50%" cy="50%" innerRadius={75} outerRadius={105} paddingAngle={3} cornerRadius={6} stroke="none">
                    {pieData.map((entry, index) => <Cell key={index} fill={entry.fill} />)}
                  </Pie>
                  <Tooltip
                    position={{ x: 110, y: 110 }}
                    wrapperStyle={{ pointerEvents: 'none', zIndex: 10 }}
                    cursor={false}
                    content={({ active, payload }) => {
                      if (active && payload && payload.length) {
                        const data = payload[0].payload;
                        return (
                          <div style={{
                            transform: 'translate(-50%, -50%)', textAlign: 'center', background: 'var(--card)', borderRadius: '50%',
                            width: '140px', height: '140px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
                            boxShadow: '0 4px 20px rgba(0,0,0,0.15)'
                          }}>
                            <div style={{
                              fontSize: '0.65rem', color: data.fill, fontWeight: 700, letterSpacing: '0.5px',
                              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                              overflow: 'hidden', textOverflow: 'ellipsis',
                              maxWidth: '120px', padding: '0 8px', lineHeight: 1.2, marginBottom: '4px'
                            }}>
                              {data.name.toUpperCase()}
                            </div>
                            <div style={{ fontFamily: "'Syne', sans-serif", fontSize: '0.9rem', fontWeight: 800, color: 'var(--text)', lineHeight: 1.2 }}>
                              {showBalances ? fmt(data.value) : '₹ ••••••'}
                            </div>
                          </div>
                        );
                      }
                      return null;
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
              <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center', pointerEvents: 'none' }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text2)', fontWeight: 700, letterSpacing: '0.5px' }}>ASSETS</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontSize: '1.4rem', fontWeight: 800, color: 'var(--text)', lineHeight: 1 }}>{pieData.length}</div>
              </div>
            </div>

            {/* Legend - Responsive Flex layout */}
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '0.75rem', width: '100%', maxWidth: '900px' }}>
              {pieData.map(d => {
                const pct = filteredTotals.curr > 0 ? ((d.value / filteredTotals.curr) * 100).toFixed(1) : 0;
                return (
                  <div key={d.name} className="invest-legend-item" style={{ flex: '1 1 220px', maxWidth: '300px' }}>

                    {/* Left Side: Name - Allows shrinking and ellipses */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: 1 }}>
                      <div style={{ width: '10px', height: '10px', borderRadius: '3px', background: d.fill, flexShrink: 0 }}></div>
                      <span style={{ fontSize: '0.85rem', color: 'var(--text2)', fontWeight: 600, fontFamily: "'DM Sans', sans-serif", whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{d.name}</span>
                    </div>

                    {/* Right Side: Values - Protected from shrinking */}
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', flexShrink: 0 }}>
                      <span style={{ fontSize: 'clamp(0.9rem, 1.5vw, 1.05rem)', fontWeight: 700, color: 'var(--text)', fontFamily: "'Syne', sans-serif", whiteSpace: 'nowrap' }}>
                        {showBalances ? fmt(d.value) : '₹ ••••••'}
                      </span>
                      <span style={{ fontSize: '0.75rem', color: 'var(--text3)', fontWeight: 600, minWidth: '38px', textAlign: 'right' }}>
                        {pct}%
                      </span>
                    </div>

                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* 🚀 THE COMMAND CENTER: MASTER CHART */}
        <div className="analyser-card" style={{ marginBottom: '2rem' }}>
          <div
            className={`analyser-header ${isAnalyserOpen ? 'open' : ''}`}
            onClick={() => setIsAnalyserOpen(!isAnalyserOpen)}
            style={{ cursor: 'pointer' }}
          >
            <div className="analyser-header-left">
              <div className="analyser-header-icon" style={{ fontSize: '1.2rem', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>📈</div>
              <div className="analyser-header-title" style={{ fontSize: '1.1rem' }}>Investment Analyser</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
              <span className={`analyser-chevron ${isAnalyserOpen ? 'open' : ''}`}>▼</span>
            </div>
          </div>

          {isAnalyserOpen && (
            <div className="analyser-body" style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>

              {/* 🚀 REDESIGNED: Split Analyser Toolbar */}
              <div className="analyser-toolbar">

                {/* Left Side: What am I looking at? */}
                <div className="toolbar-left-group">
                  <div className="category-tabs">
                    {[
                      { id: 'ALL', label: 'Overall', icon: '🌐' },
                      { id: 'EQUITY', label: 'Stocks', icon: '📈' },
                      { id: 'MF', label: 'Mutual Funds', icon: '🏦' },
                      { id: 'PROVIDENT', label: 'Retirement', icon: '🛡️' },
                      { id: 'FIXED_INCOME', label: 'Fixed Income', icon: '💰' },
                      { id: 'GOLD', label: 'Gold', icon: '🥇' }
                    ].map(cat => (
                      <button
                        key={cat.id}
                        className={`category-tab ${chartCategory === cat.id ? 'active' : ''}`}
                        onClick={() => setChartCategory(cat.id)}
                      >
                        <span className="cat-icon">{cat.icon}</span>
                        <span className="cat-label">{cat.label}</span>
                      </button>
                    ))}
                  </div>

                  {/* Asset Filter — inline with categories, only when category selected */}
                  {chartCategory !== 'ALL' && assetList && assetList[chartCategory] && assetList[chartCategory].length > 0 && (
                    <div className="asset-filter-wrapper">
                      <MultiAssetSelect
                        selectedAssets={selectedAssets}
                        setSelectedAssets={setSelectedAssets}
                        options={assetList[chartCategory]}
                        placeholder="Filter Assets..."
                      />
                    </div>
                  )}
                </div>

                {/* Right Side: How am I viewing it? */}
                <div className="toolbar-right-group">
                  {/* Segmented Control — Sliding Thumb */}
                  <div className="segmented-control" ref={segRef}>
                    <div
                      className="segmented-control-thumb"
                      style={(() => {
                        const modes = ['ABSOLUTE', 'PERCENTAGE'];
                        const activeIdx = modes.indexOf(chartMode);
                        const btn = segBtnRefs.current[activeIdx];
                        if (btn && segRef.current) {
                          const parentRect = segRef.current.getBoundingClientRect();
                          const btnRect = btn.getBoundingClientRect();
                          return {
                            left: `${btnRect.left - parentRect.left}px`,
                            width: `${btnRect.width}px`
                          };
                        }
                        return {
                          left: activeIdx === 0 ? '3px' : '50%',
                          width: '50%'
                        };
                      })()}
                    />
                    {[
                      { id: 'ABSOLUTE', label: '₹ Value', icon: '₹' },
                      { id: 'PERCENTAGE', label: '% Return', icon: '📊' }
                    ].map((mode, i) => (
                      <button
                        key={mode.id}
                        ref={el => segBtnRefs.current[i] = el}
                        className={`seg-btn ${chartMode === mode.id ? 'active' : ''}`}
                        onClick={() => setChartMode(mode.id)}
                      >
                        <span className="seg-icon">{mode.icon}</span>
                        {mode.label}
                      </button>
                    ))}
                  </div>

                  {/* Timeframe Toggle */}
                  <div className="timeframe-group">
                    {['1M', '3M', '6M', '1Y', 'YTD', 'ALL'].map(tf => (
                      <button
                        key={tf}
                        className={`tf-btn ${timeframe === tf ? 'active' : ''}`}
                        onClick={() => setTimeframe(tf)}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Selected chips — full width row below controls if assets are selected */}
                {selectedAssets.size > 0 && (
                  <div className="selected-chips" style={{ width: '100%', marginTop: '-0.25rem' }}>
                    {Array.from(selectedAssets).slice(0, 8).map(sym => (
                      <span key={sym} className="selected-chip">
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sym}</span>
                        <button
                          className="selected-chip-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            const next = new Set(selectedAssets);
                            next.delete(sym);
                            setSelectedAssets(next);
                          }}
                          title={`Remove ${sym}`}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                    {selectedAssets.size > 8 && (
                      <span className="selected-chip" style={{ opacity: 0.7 }}>
                        +{selectedAssets.size - 8} more
                      </span>
                    )}
                  </div>
                )}

              </div>



              {/* The Recharts Graph */}
              <div style={{ height: '350px', width: '100%', marginTop: '0.5rem' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                    <XAxis dataKey="date" stroke="var(--text3)" fontSize={11} tickMargin={10} axisLine={false} tickLine={false} />
                    <YAxis
                      stroke="var(--text3)"
                      fontSize={11}
                      tickFormatter={v => chartMode === 'PERCENTAGE' ? `${v.toFixed(0)}%` : `₹${(v / 1000).toFixed(0)}k`}
                      axisLine={false}
                      tickLine={false}
                      domain={['auto', 'auto']}
                    />
                    {/* 🚀 DYNAMIC TOOLTIP: Renders Both Metrics Gracefully */}
                    <Tooltip
                      cursor={{ stroke: 'var(--border)', strokeWidth: 1, strokeDasharray: '5 5' }}
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '12px 16px', boxShadow: '0 10px 30px rgba(0,0,0,0.5)', minWidth: '220px' }}>
                              <div style={{ fontSize: '0.8rem', color: 'var(--text3)', marginBottom: '10px', fontWeight: 600 }}>{label}</div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                                {payload.map((p, i) => {
                                  // 🚀 NEW: Ignore the dotted "Invested" line so we don't get duplicate tooltip blocks
                                  if (p.dataKey && p.dataKey.endsWith('_Inv')) return null;

                                  let sym = p.name;
                                  let curr = 0, inv = 0, pct = 0, retAmt = 0;

                                  if (selectedAssets.size > 0) {
                                    sym = p.dataKey.replace('_Pct', '');
                                    curr = p.payload[sym] || 0;
                                    inv = p.payload[`${sym}_Inv`] || 0;
                                    pct = p.payload[`${sym}_Pct`] || 0;
                                  } else {
                                    if (i > 0) return null; // Avoid duplicate tooltip rows for single mode
                                    curr = p.payload.Current || 0;
                                    inv = p.payload.Invested || 0;
                                    pct = p.payload.ReturnPct || 0;
                                    sym = "Total Portfolio";
                                  }
                                  retAmt = curr - inv;
                                  const isPos = retAmt >= 0;

                                  return (
                                    <div key={sym} style={{ borderBottom: (selectedAssets.size > 0 && i < payload.length - 1) ? '1px solid rgba(255,255,255,0.05)' : 'none', paddingBottom: (selectedAssets.size > 0 && i < payload.length - 1) ? '8px' : '0' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                                        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: p.color }}></div>
                                        <span style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--text)' }}>{sym}</span>
                                      </div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                                        <span style={{ color: 'var(--text3)', fontSize: '0.75rem' }}>Current:</span>
                                        <span style={{ color: 'var(--text)', fontWeight: 700 }}>{showBalances ? `₹${curr.toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '₹ ••••••'}</span>
                                      </div>
                                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: '16px' }}>
                                        <span style={{ color: 'var(--text3)', fontSize: '0.75rem' }}>Return:</span>
                                        <span className={isPos ? 'pos' : 'neg'} style={{ fontWeight: 600, fontSize: '0.75rem' }}>
                                          {isPos ? '+' : '-'}{showBalances ? `₹${Math.abs(retAmt).toLocaleString('en-IN', { maximumFractionDigits: 0 })}` : '₹ ••••••'} ({Math.abs(pct).toFixed(1)}%)
                                        </span>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Legend iconType="circle" wrapperStyle={{ paddingTop: '10px' }} />

                    {/* 🚀 DYNAMIC LINES BASED ON MODE */}
                    {selectedAssets.size > 0 ? (
                      <>
                        {Array.from(selectedAssets).map((sym, i) => (
                          <Line
                            key={sym}
                            type="monotone"
                            name={sym}
                            dataKey={chartMode === 'PERCENTAGE' ? `${sym}_Pct` : sym}
                            stroke={PIE_COLORS[i % PIE_COLORS.length]}
                            strokeWidth={3}
                            dot={chartData.length <= 1}
                            activeDot={{ r: 6, strokeWidth: 0 }}
                            animationDuration={800}
                          />
                        ))}
                        {/* 🚀 NEW: If exactly ONE asset is selected and we are in ₹ Value mode, show the dotted Invested line! */}
                        {selectedAssets.size === 1 && chartMode !== 'PERCENTAGE' && (
                          <Line
                            key={`${Array.from(selectedAssets)[0]}_Inv`}
                            type="monotone"
                            name="Invested Amount"
                            dataKey={`${Array.from(selectedAssets)[0]}_Inv`}
                            stroke="var(--text3)"
                            strokeWidth={2}
                            strokeDasharray="5 5"
                            dot={chartData.length <= 1}
                            activeDot={false}
                            animationDuration={800}
                          />
                        )}
                      </>
                    ) : (
                      chartMode === 'PERCENTAGE' ? (
                        <Line type="monotone" name="Return %" dataKey="ReturnPct" stroke="var(--accent)" strokeWidth={3} dot={chartData.length <= 1} activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--accent)' }} animationDuration={800} />
                      ) : (
                        <>
                          <Line type="monotone" name="Current Value" dataKey="Current" stroke="var(--accent)" strokeWidth={3} dot={chartData.length <= 1} activeDot={{ r: 6, strokeWidth: 0, fill: 'var(--accent)' }} animationDuration={800} />
                          <Line type="monotone" name="Invested Amount" dataKey="Invested" stroke="var(--text3)" strokeWidth={2} strokeDasharray="5 5" dot={chartData.length <= 1} activeDot={false} animationDuration={800} />
                        </>
                      )
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}
        </div>

        {/* 🚀 THE ASSET CLASS GRID (ACCORDIONS) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {[
            { title: "Stocks & MFs (Brokerage)", id: "MARKET" },
            { title: "Provident Funds & Retirement", id: "PROVIDENT", categories: ['EPF', 'PPF', 'NPS'] },
            { title: "Fixed Income & Savings", id: "FIXED", categories: ['FD', 'RD', 'Cash'] },
            { title: "Gold & Real Estate", id: "GOLD", categories: ['SGB', 'RealEstate'] }
          ].map(section => {

            // Filter manual assets for this specific section
            const sectionAssets = manualAssets ? manualAssets.filter(a => section.categories?.includes(a.category)) : [];

            return (
              <div key={section.id} className="analyser-card" style={{ marginBottom: 0 }}>
                <div
                  className={`analyser-header ${expandedSection === section.id ? 'open' : ''}`}
                  onClick={() => setExpandedSection(expandedSection === section.id ? null : section.id)}
                >
                  <div className="analyser-header-left">
                    <div className="analyser-header-icon">{section.id === 'MARKET' ? '📈' : section.id === 'PROVIDENT' ? '🛡️' : section.id === 'FIXED' ? '🏦' : '🥇'}</div>
                    <div className="analyser-header-title">{section.title}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0 }}>
                    {section.id === 'MARKET' && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (investments && investments.length >= 2) {
                            const latestDate = investments[0].date.split('T')[0];
                            const previousDate = investments[1].date.split('T')[0];
                            setDrillDownDate(latestDate);
                            setDrillDownCompareDate(previousDate);
                            fetchDrillDownData(latestDate, 'EQUITY');
                            fetchCompareData(previousDate, 'EQUITY');
                          } else if (investments && investments.length === 1) {
                            const latestDate = investments[0].date.split('T')[0];
                            setDrillDownDate(latestDate);
                            fetchDrillDownData(latestDate, 'EQUITY');
                          }
                        }}
                        className="action-btn secondary"
                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.7rem', background: 'var(--bg3)', border: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap', flexShrink: 0 }}
                        title="Compare Snapshots"
                      >
                        <span style={{ fontSize: '0.85rem' }}>⚖️</span>
                        <span className="manage-btn-text">Compare</span>
                      </button>
                    )}
                    <span className={`analyser-chevron ${expandedSection === section.id ? 'open' : ''}`}>▼</span>
                  </div>
                </div>

                {expandedSection === section.id && (
                  <div className="analyser-body" style={{ padding: '1.5rem', animation: 'fadeIn 0.2s ease' }}>

                    {section.id === "MARKET" ? (
                      /* 🚀 UPGRADED MARKET CARDS (Mobile-First Layout) */
                      <div>
                        {!isMobile ? (
                          /* 🖥️ DESKTOP: Classic Data Table */
                          <div style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '8px' }}>
                            <div className="data-table" style={{ minWidth: '750px' }}>
                              <div className="table-header" style={{ cursor: 'pointer', userSelect: 'none', gridTemplateColumns: '1.2fr 1.5fr 1.5fr 1.5fr' }}>
                                <span onClick={() => handleSort('date')}>SYNC DATE {sortBy === 'date' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                                <span onClick={() => handleSort('inv')}>TOTAL INV {sortBy === 'inv' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                                <span onClick={() => handleSort('curr')}>TOTAL CURR {sortBy === 'curr' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                                <span onClick={() => handleSort('ret_amount')}>RETURNS {sortBy === 'ret_amount' && <span className="sort-indicator">{sortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                              </div>
                              {invPaginatedRows && invPaginatedRows.length > 0 ? invPaginatedRows.map((inv, i) => {
                                const broker_inv = (parseFloat(inv.inv_stocks) || 0) + (parseFloat(inv.inv_mf) || 0);
                                const broker_curr = (parseFloat(inv.curr_stocks) || 0) + (parseFloat(inv.curr_mf) || 0);
                                const ret = broker_curr - broker_inv;
                                const broker_ret_pct = broker_inv > 0 ? (ret / broker_inv) * 100 : 0;
                                return (
                                  <div
                                    key={i}
                                    className={`table-row ${i % 2 === 0 ? 'row-even' : ''}`}
                                    onClick={() => openDrillDown(inv.date.split('T')[0])}
                                    style={{ cursor: 'pointer', gridTemplateColumns: '1.2fr 1.5fr 1.5fr 1.5fr', transition: 'background 0.2s' }}
                                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                    title="Click to view split"
                                  >
                                    <span style={{ fontWeight: 600, color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                                      🔍 {formatDate(inv.date)}
                                    </span>
                                    <span style={{ textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: '4px', textDecorationColor: 'var(--border2)' }}>{showBalances ? fmt(broker_inv) : '₹ ••••••'}</span>
                                    <span style={{ textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: '4px', textDecorationColor: 'var(--border2)' }}>{showBalances ? fmt(broker_curr) : '₹ ••••••'}</span>

                                    {/* Stacked Returns Column */}
                                    <span className={ret >= 0 ? 'pos' : 'neg'} style={{ display: 'flex', flexDirection: 'column', gap: '2px', justifyContent: 'center', alignItems: 'flex-start' }}>
                                      <span style={{ fontWeight: 700 }}>{showBalances ? (ret >= 0 ? '+' : '-') + fmt(Math.abs(ret)) : '₹ ••••••'}</span>
                                      <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>({broker_ret_pct >= 0 ? '+' : '-'}{Math.abs(broker_ret_pct).toFixed(2)}%)</span>
                                    </span>
                                  </div>
                                );
                              }) : <div className="empty-state">No brokerage snapshots match your filters.</div>}
                            </div>
                          </div>
                        ) : (
                          /* 📱 MOBILE: Clean Vertical Cards */
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                            {invPaginatedRows && invPaginatedRows.length > 0 ? invPaginatedRows.map((inv, i) => {
                              const broker_inv = (parseFloat(inv.inv_stocks) || 0) + (parseFloat(inv.inv_mf) || 0);
                              const broker_curr = (parseFloat(inv.curr_stocks) || 0) + (parseFloat(inv.curr_mf) || 0);
                              const ret = broker_curr - broker_inv;
                              const broker_ret_pct = broker_inv > 0 ? (ret / broker_inv) * 100 : 0;
                              const isPos = ret >= 0;
                              return (
                                <div
                                  key={i}
                                  onClick={() => openDrillDown(inv.date.split('T')[0])}
                                  style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', cursor: 'pointer', transition: 'all 0.2s', display: 'flex', flexDirection: 'column', gap: '1rem' }}
                                  onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
                                  onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
                                >
                                  {/* Top Row: Date & Action */}
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                      <span style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text)' }}>{formatDate(inv.date)}</span>
                                      <span style={{ background: 'var(--bg3)', padding: '0.2rem 0.5rem', borderRadius: '6px', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase' }}>Market Sync</span>
                                    </div>
                                  </div>
                                  {/* Metrics Grid */}
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', rowGap: '1.25rem' }}>
                                    <div style={{ flex: '1 1 30%', minWidth: '85px' }}>
                                      <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Invested</div>
                                      <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap' }}>{showBalances ? fmt(broker_inv) : '₹ ••••••'}</div>
                                    </div>
                                    <div style={{ flex: '1 1 30%', minWidth: '85px' }}>
                                      <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Current Value</div>
                                      <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap' }}>{showBalances ? fmt(broker_curr) : '₹ ••••••'}</div>
                                    </div>
                                    <div style={{ flex: '1 1 30%', minWidth: '85px' }}>
                                      <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Returns</div>
                                      <div className={isPos ? 'pos' : 'neg'} style={{ fontWeight: 700, fontSize: '0.9rem', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                        <span style={{ whiteSpace: 'nowrap' }}>{showBalances ? (isPos ? '+' : '-') + fmt(Math.abs(ret)) : '₹ ••••••'}</span>
                                        <span style={{ fontSize: '0.7rem', opacity: 0.9, whiteSpace: 'nowrap' }}>({isPos ? '+' : '-'}{Math.abs(broker_ret_pct).toFixed(2)}%)</span>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              );
                            }) : <div className="empty-state">No brokerage snapshots match your filters.</div>}
                          </div>
                        )}

                        {/* 🚀 PAGINATION CONTROLS */}
                        {invTotalPages > 1 && (
                          <div style={{
                            display: 'flex',
                            flexDirection: isMobile ? 'column' : 'row',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            marginTop: '1.5rem',
                            padding: '0.85rem 1.25rem',
                            background: 'var(--bg2)',
                            borderRadius: '12px',
                            border: '1px solid var(--border)',
                            gap: '1rem'
                          }}>

                            {/* Left Side: Row Selector & Count */}
                            <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
                              <CustomSelect
                                value={invRowsPerPage}
                                onChange={val => { setInvRowsPerPage(Number(val)); setInvCurrentPage(0); }}
                                options={[5, 10, 25, 50].map(r => ({ label: `${r} rows`, value: r }))}
                                minWidth="110px"
                              />
                              <span style={{ fontSize: '0.8rem', color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                                Showing {invCurrentPage * invRowsPerPage + 1} - {Math.min((invCurrentPage + 1) * invRowsPerPage, processedData.length)} of {processedData.length}
                              </span>
                            </div>

                            {/* Right Side: Navigation Buttons */}
                            <div style={{
                              display: 'flex',
                              gap: '0.5rem',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: isMobile ? '100%' : 'auto'
                            }}>
                              <button
                                onClick={() => setInvCurrentPage(Math.max(0, invCurrentPage - 1))}
                                disabled={invCurrentPage === 0}
                                className="action-btn secondary"
                                style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem', flex: isMobile ? 1 : 'none', justifyContent: 'center' }}
                              >
                                ← Prev
                              </button>

                              <span style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: 600, margin: '0 0.5rem', whiteSpace: 'nowrap' }}>
                                Page {invCurrentPage + 1} of {invTotalPages}
                              </span>

                              <button
                                onClick={() => setInvCurrentPage(Math.min(invTotalPages - 1, invCurrentPage + 1))}
                                disabled={invCurrentPage === invTotalPages - 1}
                                className="action-btn secondary"
                                style={{ padding: '0.4rem 0.85rem', fontSize: '0.85rem', flex: isMobile ? 1 : 'none', justifyContent: 'center' }}
                              >
                                Next →
                              </button>
                            </div>

                          </div>
                        )}
                      </div>
                    ) : (
                      /* 🚀 FIXED CARD STRUCTURE FOR MANUAL ASSETS */
                      <div>
                        <div>
                          {!isMobile ? (
                            /* 🖥️ DESKTOP: Classic Data Table */
                            <div style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: '8px' }}>
                              <div className="data-table" style={{ minWidth: '1500px' }}>
                                {sectionAssets.length > 0 ? (
                                  <>
                                    <div className="table-header" style={{ gridTemplateColumns: 'minmax(0, 2.5fr) minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1fr)' }}>
                                      <span>Asset Name</span>
                                      <span>Type</span>
                                      <span>Invested</span>
                                      <span>Current Value</span>
                                      <span>Returns</span>
                                      <span>Details</span>
                                      <span>Automation</span>
                                      <span style={{ justifyContent: 'flex-end' }}>Actions</span>
                                    </div>
                                    {sectionAssets.map((asset, i) => {
                                      const ret = asset.current_value - asset.invested_value;
                                      const isPos = ret >= 0;
                                      return (
                                        <div key={asset.id} className={`table-row ${i % 2 === 0 ? 'row-even' : ''}`} style={{ gridTemplateColumns: 'minmax(0, 2.5fr) minmax(0, 1fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1fr)' }}>
                                          <span style={{ fontWeight: 600 }}>{asset.name}</span>
                                          <span><span style={{ background: 'var(--bg3)', padding: '0.2rem 0.5rem', borderRadius: '6px', fontSize: '0.75rem' }}>{asset.category}</span></span>
                                          <span style={{ textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: '4px', textDecorationColor: 'var(--border2)' }}>{showBalances ? fmt(asset.invested_value) : '₹ ••••••'}</span>
                                          <span style={{ fontWeight: 700, textDecoration: 'underline', textDecorationStyle: 'dashed', textUnderlineOffset: '4px', textDecorationColor: 'var(--border2)' }}>{showBalances ? fmt(asset.current_value) : '₹ ••••••'}</span>
                                          <span className={isPos ? 'pos' : 'neg'} style={{ display: 'flex', flexDirection: 'column', gap: '2px', justifyContent: 'center', alignItems: 'flex-start' }}>
                                            <span style={{ fontWeight: 700 }}>{showBalances ? (isPos ? '+' : '-') + fmt(Math.abs(ret)) : '₹ ••••••'}</span>
                                            {asset.invested_value > 0 && <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>({isPos ? '+' : '-'}{((Math.abs(ret) / asset.invested_value) * 100).toFixed(2)}%)</span>}
                                          </span>

                                          {/* New Details Column */}
                                          <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                                            {asset.interest_rate ? <span style={{ fontSize: '0.75rem', color: 'var(--text)', fontWeight: 600 }}>{asset.interest_rate}% Interest</span> : <span style={{ fontSize: '0.75rem', color: 'var(--text3)' }}>No Interest</span>}
                                            <span style={{ fontSize: '0.7rem', color: 'var(--text2)' }}>Start: {asset.start_date || '—'}</span>
                                            <span style={{ fontSize: '0.7rem', color: 'var(--text2)' }}>Ends: {asset.maturity_date || '—'}</span>
                                          </span>

                                          {/* New Automation Column */}
                                          <span style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                                            {asset.is_recurring ? (
                                              <>
                                                <span style={{ fontSize: '0.75rem', color: 'var(--pos)', fontWeight: 600 }}>{showBalances ? '+ ' + fmt(asset.amount_to_add) : '₹ ••••••'}</span>
                                                <span style={{ fontSize: '0.7rem', color: 'var(--text2)' }}>Every {asset.interval_value} {asset.interval_unit}</span>
                                                <span style={{ fontSize: '0.7rem', color: 'var(--text3)' }}>Next: {asset.next_run_date}</span>
                                              </>
                                            ) : <span style={{ fontSize: '0.75rem', color: 'var(--text3)' }}>Not Automated</span>}
                                          </span>

                                          <span style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
                                            {canEdit && (
                                              <>
                                                <button className="action-icon-btn edit" onClick={(e) => { e.stopPropagation(); setEditingAsset(asset); }} title="Edit">✏️</button>
                                                <button className="action-icon-btn delete" onClick={(e) => { e.stopPropagation(); handleDeleteManualAsset(asset.id); }} title="Delete">🗑️</button>
                                              </>
                                            )}
                                          </span>
                                        </div>
                                      );
                                    })}
                                  </>
                                ) : (
                                  <div className="empty-state">No assets added in this category yet.</div>
                                )}
                              </div>
                            </div>
                          ) : (
                            /* 📱 MOBILE: Clean Vertical Cards */
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                              {sectionAssets.length > 0 ? sectionAssets.map((asset, i) => {
                                const ret = asset.current_value - asset.invested_value;
                                const isPos = ret >= 0;
                                return (
                                  <div key={asset.id} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                                    {/* Top Row: Name */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
                                        <span style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text)' }}>{asset.name}</span>
                                        <span style={{ background: 'var(--bg3)', padding: '0.2rem 0.5rem', borderRadius: '6px', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text2)', textTransform: 'uppercase' }}>{asset.category}</span>
                                      </div>
                                    </div>
                                    {/* Metrics Grid */}
                                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', rowGap: '1.25rem' }}>
                                      <div style={{ flex: '1 1 30%', minWidth: '85px' }}>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Invested</div>
                                        <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap' }}>{showBalances ? fmt(asset.invested_value) : '₹ ••••••'}</div>
                                      </div>
                                      <div style={{ flex: '1 1 30%', minWidth: '85px' }}>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Current Value</div>
                                        <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap' }}>{showBalances ? fmt(asset.current_value) : '₹ ••••••'}</div>
                                      </div>
                                      <div style={{ flex: '1 1 30%', minWidth: '85px' }}>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Returns</div>
                                        <div className={isPos ? 'pos' : 'neg'} style={{ fontWeight: 700, fontSize: '0.9rem', marginTop: '4px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
                                          <span style={{ whiteSpace: 'nowrap' }}>{showBalances ? (isPos ? '+' : '-') + fmt(Math.abs(ret)) : '₹ ••••••'}</span>
                                          {asset.invested_value > 0 && <span style={{ fontSize: '0.7rem', opacity: 0.9, whiteSpace: 'nowrap' }}>({isPos ? '+' : '-'}{((Math.abs(ret) / asset.invested_value) * 100).toFixed(2)}%)</span>}
                                        </div>
                                      </div>
                                    </div>

                                    {/* 🚀 NEW Additional Details row for Mobile */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem', marginTop: '0.5rem' }}>
                                      <div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Details</div>
                                        <div style={{ fontSize: '0.8rem', color: 'var(--text)', marginTop: '4px' }}>{asset.interest_rate ? `${asset.interest_rate}% Rate` : 'No Interest'}</div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text2)', marginTop: '2px' }}>{asset.start_date ? `Start: ${asset.start_date}` : ''}</div>
                                        <div style={{ fontSize: '0.75rem', color: 'var(--text2)', marginTop: '2px' }}>{asset.maturity_date ? `Ends: ${asset.maturity_date}` : ''}</div>
                                      </div>
                                      <div>
                                        <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Automation</div>
                                        {asset.is_recurring ? (
                                          <>
                                            <div style={{ fontSize: '0.85rem', color: 'var(--pos)', fontWeight: 600, marginTop: '4px' }}>{showBalances ? '+' + fmt(asset.amount_to_add) : '₹ ••••••'}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text2)', marginTop: '2px' }}>Every {asset.interval_value} {asset.interval_unit}</div>
                                            <div style={{ fontSize: '0.75rem', color: 'var(--text3)', marginTop: '2px' }}>Next: {asset.next_run_date}</div>
                                          </>
                                        ) : <div style={{ fontSize: '0.8rem', color: 'var(--text3)', marginTop: '4px' }}>Off</div>}
                                      </div>
                                    </div>

                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: '0.75rem', marginTop: '0.5rem' }}>
                                      <div style={{ fontSize: '0.7rem', color: 'var(--text3)', fontWeight: 500 }}>Last updated: {asset.last_updated}</div>
                                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        {canEdit && (
                                          <>
                                            <button className="action-icon-btn edit" onClick={(e) => { e.stopPropagation(); setEditingAsset(asset); }} title="Edit" style={{ fontSize: '1.2rem', padding: '0.4rem' }}>✏️</button>
                                            <button className="action-icon-btn delete" onClick={(e) => { e.stopPropagation(); handleDeleteManualAsset(asset.id); }} title="Delete" style={{ fontSize: '1.2rem', padding: '0.4rem' }}>🗑️</button>
                                          </>
                                        )}
                                      </div>
                                    </div>
                                  </div>
                                );
                              }) : (
                                <div className="empty-state">No assets added in this category yet.</div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Render the Add Modal if state is true */}
        {isAddModalOpen && <AddManualAssetModal onClose={() => setIsAddModalOpen(false)} onAdd={onAdd} />}
        {editingAsset && <EditManualAssetModal asset={editingAsset} onClose={() => setEditingAsset(null)} onRefresh={onAdd} />}

        {/* Drill-down Modal (Shared for MF & Equity) */}
        {drillDownDate && (
          <div className="modal-backdrop" onClick={() => { setDrillDownDate(null); setDrillDownCompareDate(null); }}>
            <div className="modal-content bulk-modal" onClick={e => e.stopPropagation()}>
              <div className="modal-header" style={{ padding: '1rem 1.25rem', display: 'flex', flexDirection: 'column', gap: '0.75rem', alignItems: 'flex-start', borderBottom: '1px solid var(--border)' }}>

                <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                  <div className="modal-title" style={{ fontSize: '1.1rem', fontWeight: 700, fontFamily: "'Syne', sans-serif" }}>
                    Portfolio Snapshot
                    {(isDrillDownLoading || isCompareLoading) && <span className="loader-spinner" style={{ width: '16px', height: '16px', borderWidth: '2px', marginLeft: '0.5rem', display: 'inline-block', verticalAlign: 'middle' }} />}
                  </div>
                  <button className="modal-close" onClick={() => { setDrillDownDate(null); setDrillDownCompareDate(null); }}>×</button>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flex: isMobile ? '1 1 100%' : '0 0 auto' }}>
                    <CustomSelect
                      value={drillDownDate}
                      onChange={(val) => {
                        setDrillDownDate(val);
                        setDrillDownCompareDate(null);
                        setDrillDownCompareData([]);
                        fetchDrillDownData(val, drillDownType);
                      }}
                      options={[...investments].sort((a, b) => new Date(b.date) - new Date(a.date)).map(inv => ({ label: formatDate(inv.date), value: inv.date.split('T')[0] }))}
                      width={isMobile ? '100%' : 'auto'}
                      minWidth="130px"
                    />
                    <CustomSelect
                      value={drillDownCompareDate || ""}
                      onChange={(val) => fetchCompareData(val, drillDownType)}
                      options={[
                        { label: 'No Compare', value: '' },
                        ...availableCompareDates
                      ]}
                      placeholder="⚖️ vs..."
                      width={isMobile ? '100%' : 'auto'}
                      minWidth="130px"
                    />
                  </div>
                  <div style={{ display: 'flex', gap: '0.4rem', flex: isMobile ? '1 1 100%' : '0 0 auto' }}>
                    <button
                      onClick={() => { fetchDrillDownData(drillDownDate, 'EQUITY'); if (drillDownCompareDate) fetchCompareData(drillDownCompareDate, 'EQUITY'); }}
                      style={{ padding: '0.35rem 0.75rem', borderRadius: '8px', fontSize: '0.8rem', fontFamily: "'DM Sans', sans-serif", fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', background: drillDownType === 'EQUITY' ? 'var(--card)' : 'transparent', color: drillDownType === 'EQUITY' ? 'var(--accent)' : 'var(--text2)', border: drillDownType === 'EQUITY' ? '1px solid var(--accent)' : '1px solid transparent', boxShadow: drillDownType === 'EQUITY' ? '0 4px 12px rgba(99,102,241,0.15)' : 'none', flex: isMobile ? 1 : 'none' }}
                    >📈 Stocks</button>
                    <button
                      onClick={() => { fetchDrillDownData(drillDownDate, 'MF'); if (drillDownCompareDate) fetchCompareData(drillDownCompareDate, 'MF'); }}
                      style={{ padding: '0.35rem 0.75rem', borderRadius: '8px', fontSize: '0.8rem', fontFamily: "'DM Sans', sans-serif", fontWeight: 600, cursor: 'pointer', transition: 'all 0.2s', background: drillDownType === 'MF' ? 'var(--card)' : 'transparent', color: drillDownType === 'MF' ? 'var(--accent)' : 'var(--text2)', border: drillDownType === 'MF' ? '1px solid var(--accent)' : '1px solid transparent', boxShadow: drillDownType === 'MF' ? '0 4px 12px rgba(99,102,241,0.15)' : 'none', flex: isMobile ? 1 : 'none' }}
                    >🏦 MFs</button>
                  </div>
                </div>

              </div>

              <div className="modal-body" style={{ padding: '1.5rem', overflowY: 'auto', maxHeight: '65vh' }}>
                {(isDrillDownLoading || isCompareLoading) ? (
                  <div style={{ padding: '4rem 1rem', textAlign: 'center', color: 'var(--text2)' }}>
                    <div className="loader-spinner" style={{ marginBottom: '1rem' }} />
                    <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Analyzing and Crunching Deltas...</div>
                  </div>
                ) : drillDownCompareDate && comparisonData ? (
                  /* 🚀 COMPARISON VIEW 🚀 */
                  <>
                    {/* Summary Banner */}
                    {comparisonSummary && (
                      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '0.75rem', marginBottom: '1.25rem' }}>
                        {[
                          { label: 'Invested', valA: comparisonSummary.inv_A, valB: comparisonSummary.inv_B, diff: comparisonSummary.inv_diff },
                          { label: 'Current Value', valA: comparisonSummary.curr_A, valB: comparisonSummary.curr_B, diff: comparisonSummary.curr_diff },
                          { label: 'Returns', valA: comparisonSummary.ret_A, valB: comparisonSummary.ret_B, diff: comparisonSummary.ret_diff, pctA: comparisonSummary.ret_pct_A, pctB: comparisonSummary.ret_pct_B },
                        ].map((card, ci) => (
                          <div key={ci} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1rem 1.25rem' }}>
                            <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 700, letterSpacing: '0.5px', marginBottom: '0.6rem' }}>{card.label}</div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '0.5rem' }}>
                              <div>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text3)', marginBottom: '2px' }}>{formatDate(drillDownDate)}</div>
                                <div style={{ fontSize: '1.1rem', fontWeight: 700, color: card.label === 'Returns' ? (card.valA >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text)', fontFamily: "'DM Sans', sans-serif" }}>
                                  {card.label === 'Returns' && (card.valA >= 0 ? '+' : '-')}₹{Math.abs(card.valA).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                  {card.pctA !== undefined && <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: '4px' }}>({card.pctA >= 0 ? '+' : ''}{card.pctA.toFixed(1)}%)</span>}
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <div style={{ fontSize: '0.65rem', color: 'var(--text3)', marginBottom: '2px' }}>{formatDate(drillDownCompareDate)}</div>
                                <div style={{ fontSize: '0.9rem', fontWeight: 600, color: 'var(--text2)', fontFamily: "'DM Sans', sans-serif" }}>
                                  {card.label === 'Returns' && (card.valB >= 0 ? '+' : '-')}₹{Math.abs(card.valB).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                  {card.pctB !== undefined && <span style={{ fontSize: '0.65rem', opacity: 0.7, marginLeft: '3px' }}>({card.pctB >= 0 ? '+' : ''}{card.pctB.toFixed(1)}%)</span>}
                                </div>
                              </div>
                            </div>
                            <div style={{ marginTop: '0.5rem', borderTop: '1px solid var(--border)', paddingTop: '0.5rem' }}>
                              <DiffBadge diff={card.diff} isCurrency={true} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {comparisonSummary && (
                      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text3)', fontWeight: 600, fontFamily: "'DM Sans', sans-serif" }}>
                          {comparisonSummary.total_stocks} {drillDownType === 'EQUITY' ? 'stocks' : 'funds'}
                        </span>
                        {comparisonSummary.stocks_new > 0 && <span style={{ fontSize: '0.7rem', background: 'rgba(52,211,153,0.1)', color: 'var(--pos)', padding: '2px 8px', borderRadius: '4px', fontWeight: 700 }}>+{comparisonSummary.stocks_new} New</span>}
                        {comparisonSummary.stocks_exited > 0 && <span style={{ fontSize: '0.7rem', background: 'rgba(248,113,113,0.1)', color: 'var(--neg)', padding: '2px 8px', borderRadius: '4px', fontWeight: 700 }}>{comparisonSummary.stocks_exited} Exited</span>}
                      </div>
                    )}
                    {!isMobile ? (
                      <div style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                        <div className="data-table" style={{ minWidth: '850px' }}>
                          <div className="table-header" style={{ gridTemplateColumns: '2fr 1fr 1fr 1.2fr 1.2fr 1.2fr', userSelect: 'none' }}>
                            <span>Symbol</span>
                            <span>Qty Δ</span>
                            <span>{drillDownType === 'EQUITY' ? 'LTP' : 'NAV'} Δ</span>
                            <span>Invested Δ</span>
                            <span>Current Δ</span>
                            <span>Returns Δ</span>
                          </div>
                          {comparisonData.map((h, i) => (
                            <div key={i} className={`table-row ${i % 2 === 0 ? 'row-even' : ''}`} style={{ gridTemplateColumns: '2fr 1fr 1fr 1.2fr 1.2fr 1.2fr' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: '600', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: '4px' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                                  {h.symbol}
                                  {h.is_new && <span style={{ background: 'var(--pos)', color: '#fff', fontSize: '0.55rem', padding: '2px 4px', borderRadius: '4px' }}>NEW</span>}
                                  {h.is_exited && <span style={{ background: 'var(--neg)', color: '#fff', fontSize: '0.55rem', padding: '2px 4px', borderRadius: '4px' }}>EXITED</span>}
                                </div>
                              </span>
                              <span style={{ flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: '4px' }}>
                                <span>{h.qty_A.toFixed(2)}</span>
                                <DiffBadge diff={h.qty_diff} isCurrency={false} />
                              </span>
                              <span style={{ flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: '4px' }}>
                                <span>₹{h.price_A.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                                <DiffBadge diff={h.price_diff} isCurrency={true} />
                              </span>
                              <span style={{ flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: '4px' }}>
                                <span>₹{h.inv_A.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                                <DiffBadge diff={h.inv_diff} isCurrency={true} />
                              </span>
                              <span style={{ flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: '4px' }}>
                                <span style={{ fontWeight: 600, color: 'var(--text)' }}>₹{h.curr_A.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                                <DiffBadge diff={h.curr_diff} isCurrency={true} />
                              </span>
                              <span style={{ flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', gap: '4px' }}>
                                <span className={h.ret_A >= 0 ? 'pos' : 'neg'} style={{ fontWeight: 700 }}>{h.ret_A >= 0 ? '+' : '-'}₹{Math.abs(h.ret_A).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
                                <DiffBadge diff={h.ret_diff} isCurrency={true} />
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                        {comparisonData.map((h, i) => {
                          const isPosRet = h.ret_A >= 0;
                          return (
                            <div key={i} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', transition: 'all 0.2s' }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
                                  <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text)', lineHeight: 1.3 }}>{h.symbol}</div>
                                  {h.is_new && <span style={{ background: 'var(--pos)', color: '#fff', fontSize: '0.55rem', padding: '2px 4px', borderRadius: '4px' }}>NEW</span>}
                                  {h.is_exited && <span style={{ background: 'var(--neg)', color: '#fff', fontSize: '0.55rem', padding: '2px 4px', borderRadius: '4px' }}>EXITED</span>}
                                </div>
                                <div className={isPosRet ? 'pos' : 'neg'} style={{ fontWeight: 700, fontSize: '0.85rem', background: isPosRet ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)', padding: '0.3rem 0.6rem', borderRadius: '6px', whiteSpace: 'nowrap' }}>
                                  Ret: {isPosRet ? '+' : '-'}₹{Math.abs(h.ret_A).toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                                </div>
                              </div>

                              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                                <div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Quantity</div>
                                  <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px' }}>{h.qty_A.toFixed(2)}</div>
                                  <div style={{ marginTop: '4px' }}><DiffBadge diff={h.qty_diff} isCurrency={false} /></div>
                                </div>
                                <div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>{drillDownType === 'EQUITY' ? 'LTP' : 'NAV'}</div>
                                  <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px' }}>₹{h.price_A.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
                                  <div style={{ marginTop: '4px' }}><DiffBadge diff={h.price_diff} isCurrency={true} /></div>
                                </div>
                                <div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Invested</div>
                                  <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px' }}>₹{h.inv_A.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                                  <div style={{ marginTop: '4px' }}><DiffBadge diff={h.inv_diff} isCurrency={true} /></div>
                                </div>
                                <div>
                                  <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Current Val</div>
                                  <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px' }}>₹{h.curr_A.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</div>
                                  <div style={{ marginTop: '4px' }}><DiffBadge diff={h.curr_diff} isCurrency={true} /></div>
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  /* 🚀 STANDARD VIEW (Original Logic) 🚀 */
                  !isMobile ? (
                    <div style={{ width: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                      <div className="data-table" style={{ minWidth: '750px' }}>
                        <div className="table-header" style={{ gridTemplateColumns: '2.5fr 1fr 1fr 1fr 1fr 1fr 1.2fr', cursor: 'pointer', userSelect: 'none' }}>
                          <span onClick={() => handleDrillSort('symbol')}>Symbol {drillSortBy === 'symbol' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                          <span onClick={() => handleDrillSort('quantity')}>Qty {drillSortBy === 'quantity' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                          <span onClick={() => handleDrillSort('average_price')}>Avg Price {drillSortBy === 'average_price' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                          <span onClick={() => handleDrillSort('price')}>{drillDownType === 'EQUITY' ? 'LTP' : 'NAV'} {drillSortBy === 'price' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                          <span onClick={() => handleDrillSort('invested_value')}>Invested {drillSortBy === 'invested_value' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                          <span onClick={() => handleDrillSort('current_value')}>Current {drillSortBy === 'current_value' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                          <span onClick={() => handleDrillSort('ret_pct')}>Returns {drillSortBy === 'ret_pct' && <span className="sort-indicator">{drillSortDir === 'asc' ? '↑' : '↓'}</span>}</span>
                        </div>
                        {processedDrillDownData.map((h, i) => {
                          const isPos = h.ret_pct >= 0;
                          return (
                            <div key={i} className={`table-row ${i % 2 === 0 ? 'row-even' : ''}`} style={{ gridTemplateColumns: '2.5fr 1fr 1fr 1fr 1fr 1fr 1.2fr' }}>
                              <span style={{ fontSize: '0.75rem', fontWeight: '600' }}>{h.symbol}</span>
                              <span>{h.quantity.toFixed(2)}</span>
                              <span>₹{h.average_price.toFixed(2)}</span>
                              <span>₹{(drillDownType === 'EQUITY' ? h.ltp : h.nav).toFixed(2)}</span>
                              <span>₹{h.invested_value.toFixed(0)}</span>
                              <span style={{ fontWeight: 600, color: 'var(--text)' }}>₹{h.current_value.toFixed(0)}</span>
                              <span className={isPos ? 'pos' : 'neg'} style={{ display: 'flex', flexDirection: 'column', gap: '2px', justifyContent: 'center' }}>
                                <span style={{ fontWeight: 700 }}>{isPos ? '+' : '-'}₹{Math.abs(h.current_value - h.invested_value).toFixed(0)}</span>
                                <span style={{ fontSize: '0.75rem', opacity: 0.8 }}>({isPos ? '+' : '-'}{Math.abs(h.ret_pct).toFixed(2)}%)</span>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                      {processedDrillDownData.map((h, i) => {
                        const isPos = h.ret_pct >= 0;
                        return (
                          <div key={i} style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: '12px', padding: '1.25rem', display: 'flex', flexDirection: 'column', gap: '1rem', transition: 'all 0.2s' }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                              <div>
                                <div style={{ fontWeight: 700, fontSize: '1.05rem', color: 'var(--text)', lineHeight: 1.3 }}>{h.symbol}</div>
                                <div style={{ fontSize: '0.8rem', color: 'var(--text3)', marginTop: '6px' }}>
                                  {h.quantity.toFixed(2)} units • Avg: ₹{h.average_price.toFixed(2)} • {drillDownType === 'EQUITY' ? 'LTP' : 'NAV'}: ₹{(drillDownType === 'EQUITY' ? h.ltp : h.nav).toFixed(2)}
                                </div>
                              </div>
                              <div className={isPos ? 'pos' : 'neg'} style={{ fontWeight: 700, fontSize: '0.85rem', background: isPos ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)', padding: '0.3rem 0.6rem', borderRadius: '6px', whiteSpace: 'nowrap' }}>
                                {isPos ? '+' : '-'}{Math.abs(h.ret_pct).toFixed(2)}%
                              </div>
                            </div>
                            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem', borderTop: '1px solid var(--border)', paddingTop: '1rem' }}>
                              <div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Invested</div>
                                <div style={{ fontWeight: 600, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap' }}>₹{h.invested_value.toFixed(0)}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Current</div>
                                <div style={{ fontWeight: 700, color: 'var(--text)', fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap' }}>₹{h.current_value.toFixed(0)}</div>
                              </div>
                              <div>
                                <div style={{ fontSize: '0.7rem', color: 'var(--text3)', textTransform: 'uppercase', fontWeight: 600 }}>Return ₹</div>
                                <div className={h.current_value >= h.invested_value ? 'pos' : 'neg'} style={{ fontWeight: 700, fontSize: '0.9rem', marginTop: '4px', whiteSpace: 'nowrap', display: 'flex', flexDirection: 'column' }}>
                                  <span>{h.current_value >= h.invested_value ? '+' : '-'}₹{Math.abs(h.current_value - h.invested_value).toFixed(0)}</span>
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )
                )}
              </div>
            </div>
          </div>
        )}

        {/* 🚀 FLOATING HIDE/SHOW TOGGLE */}
        <button
          onClick={() => setShowBalances(!showBalances)}
          title={showBalances ? "Hide Balances" : "Show Balances"}
          style={{
            position: 'fixed',
            bottom: isMobile ? '85px' : '30px', /* Stays above mobile bottom nav */
            right: '20px',
            zIndex: 999,
            width: '50px',
            height: '50px',
            borderRadius: '25px',
            background: 'var(--card)',
            border: '1px solid var(--accent)',
            fontSize: '1.5rem',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxShadow: '0 8px 25px rgba(0,0,0,0.4)',
            cursor: 'pointer',
            transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
          }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-3px)'; e.currentTarget.style.boxShadow = '0 12px 30px rgba(99,102,241,0.4)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 8px 25px rgba(0,0,0,0.4)'; }}
        >
          {showBalances ? '🙈' : '👁️'}
        </button>

      </div>
    </div>
  );
}

export default memo(InvestTab);
