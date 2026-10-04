import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from './SabDekho';

import { API, MONTHS, BANKS } from '../constants';
import { getToken, formatDate, fmt, fmtPct, getBankEmoji, accountColor, isCcAccount } from '../utils';
import CustomSelect from '../components/CustomSelect';
import ReconciliationModal from '../components/ReconciliationModal';
import FirstAccountPrompt from '../components/FirstAccountPrompt';
import { CardBudgetChip, MinBalanceChip, balanceLevel, cardLevel } from '../components/BalanceImpact';
import { useAccess } from '../access/AccessContext';
import RoutinesHomeCard from './routines-components/RoutinesHomeCard';
import { apiGet, apiPost, useApi, monthKey } from '../api/money';
import { yearOptions } from '../utils';

function HomeTab({ accounts = [], investments = [], budgets, onRefresh, dataVersion, showBalances, setShowBalances, onOpenRoutines }) {
  const access = useAccess();
  const canMoney= access.can('money');
  const canGym = access.can('gym');
  const canInvest = access.can('invest');
  const showBalancesSection = access.money.balancesVisible;
  const fullMoney = access.money.fullAccess;
  // Empty sections stay hidden until there's something to show in them.
  const hasMoney = accounts.length > 0;
  const hasInvestments = (investments || []).length > 0;
  const [isReconcileOpen, setIsReconcileOpen] = useState(false);
  const [moneyMonth, setMoneyMonth] = useState(new Date().getMonth());
  const [moneyYear, setMoneyYear] = useState(new Date().getFullYear());
  const [syncing, setSyncing] = useState(false);
  const [syncingSheetsTransactions, setSyncingSheetsTransactions] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');
const [showInvestments, setShowInvestments] = useState(false);

  // 🚀 GLOBAL ESCAPE: Closes Home-level Modals
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') setIsReconcileOpen(false);
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  // Income/expense for the picked month and this month's category spend are
  // totalled on the server, so Home never downloads the transaction history.
  const moneyML = `${moneyYear}-${String(moneyMonth + 1).padStart(2, '0')}`;
  const summaryRes = useApi(
    () => apiGet(`/money/summary?month=${moneyML}&spend_month=${monthKey()}`),
    `${moneyML}|${dataVersion}`,
    canMoney
  );
  const income = summaryRes.data?.income || {};
  const expense = summaryRes.data?.expense || {};
  const monthSpending = summaryRes.data?.spending || {};
  const summaryReady = !!summaryRes.data;
  // Shimmer instead of a misleading ₹0 until the numbers arrive.
  const money = (value) => summaryReady ? fmt(value) : <span className="skeleton-line" style={{ width: '64px' }} />;

  // The Sheet is read by the backend; its Apps Script URL no longer ships to the browser.
  const syncBalances = async () => {
    setSyncing(true); setSyncMsg('');
    try {
      const res = await apiPost('/sync/sheet-balances', {});
      if (!res.success) throw new Error(res.message || 'Sheet sync failed');
      await onRefresh();
      setSyncMsg(`✅ Balances synced! (${res.updated} accounts)`);
    } catch (e) {
      setSyncMsg('❌ Sync failed: ' + e.message);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(''), 3000);
    }
  };

  const syncTransactionsFromSheets = async () => {
    try {
      // 1. Ask the backend how many transactions are waiting
      const checkRes = await fetch(`${API}/sync/check-transactions`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      const checkData = await checkRes.json();

      if (!checkData.success) {
        return alert("❌ Error checking sync status: " + checkData.message);
      }

      if (checkData.count === 0) {
        return alert("👍 No new transactions to sync to Sheets.");
      }

      // 2. The Confirmation Prompt
      const isConfirmed = window.confirm(`You have ${checkData.count} unsynced transaction(s). Ready to send them to Google Sheets?`);
      if (!isConfirmed) return;

      // 3. If confirmed, lock the button and do the actual sync
      setSyncingSheetsTransactions(true);
      
      let hasMore = true;
      let totalSynced = 0;
      const totalCount = checkData.count;
      
      while (hasMore) {
        setSyncMsg(`⏳ Syncing ${totalSynced}/${totalCount} — sending batch...`);
        const res = await fetch(`${API}/sync/db-to-sheets`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } });
        const data = await res.json();
  
        if (data.success) {
          totalSynced += (data.synced_count || 0);
          hasMore = data.has_more;
          setSyncMsg(`⏳ Synced ${totalSynced}/${totalCount}...`);
        } else {
          setSyncMsg(`❌ Failed after ${totalSynced}/${totalCount}: ${data.message}`);
          hasMore = false;
        }
      }

      if (totalSynced > 0) {
        setSyncMsg(`✅ Done! Synced ${totalSynced} transactions to Sheets.`);
        setTimeout(() => setSyncMsg(''), 5000);
      }

    } catch (e) {
      setSyncMsg(`❌ Network Error: ${e.message}`);
      setTimeout(() => setSyncMsg(''), 5000);
    } finally {
      setSyncingSheetsTransactions(false);
    }
  };

  const netWorth = accounts
    .filter(a => a.balance_tracked)
    .reduce((s, a) => s + parseFloat(a.balance || 0), 0);

  // Grab the newest snapshot (index 0) and use your new total columns
  const latestInv = investments.length > 0 ? investments[0] : null;
  const latestDate = latestInv ? formatDate(latestInv.date) : "—";
  const totalInvested = latestInv ? parseFloat(latestInv.total_inv || 0) : 0;
  const totalCurrent = latestInv ? parseFloat(latestInv.total_curr || 0) : 0;
  const totalReturn = totalCurrent - totalInvested;
  const totalRetPct = latestInv ? parseFloat(latestInv.total_ret_pct || 0) : 0;

  const budgetSummary = useMemo(() => {
    if (!budgets || budgets.length === 0) return { over: 0, total: 0, active: false };

    const items = budgets.map(b => {
      const spent = monthSpending[b.category] || 0;
      const limit = b.monthly_limit;
      const percentage = Math.min((spent / limit) * 100, 100);
      const isOver = spent > limit;
      return { category: b.category, spent, limit, percentage, isOver };
    });
    
    // Sort so 'over' ones are at the top, then by highest percentage
    items.sort((a, b) => b.percentage - a.percentage);

    const overCount = items.filter(i => i.isOver).length;
    return { over: overCount, total: items.length, active: true, items };
  }, [budgets, monthSpending]);

  return (
    <div>
      {canMoney && fullMoney && accounts.length === 0 && <FirstAccountPrompt onAdded={() => onRefresh()} />}
      {!canMoney && !canGym && !canInvest && (
        <div className="access-empty-state">
          <div className="access-empty-icon">{access.can('sabdekho') ? '📺' : '🔒'}</div>
          <div className="access-empty-title">{access.can('sabdekho') ? 'SabDekho is shared with you' : 'Nothing shared with you here yet'}</div>
          <div className="access-empty-sub">
            {access.can('sabdekho')
              ? 'Open SabDekho from the menu to browse the library, diary and stats.'
              : "Your account is active, but the owner hasn't given you access to any dashboards. Ask them to update your permissions."}
          </div>
        </div>
      )}

      {/* Action buttons row: the owner's own Google Sheet */}
      {access.isOwner && (
      <div className="invest-action-buttons" style={{ display: 'flex', gap: '0.75rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
        <button className="action-btn" onClick={syncBalances} disabled={syncing} style={{ minWidth: '200px', justifyContent: 'center' }}>
          {syncing ? '⏳ Syncing...' : '🔄 Sync Balances from Sheet'}
        </button>
        <button className="action-btn" onClick={syncTransactionsFromSheets} disabled={syncingSheetsTransactions} style={{ minWidth: '200px', justifyContent: 'center', background: 'linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)' }}>
          {syncingSheetsTransactions ? '⏳ Syncing...' : '📥 Sync Transactions to Sheets'}
        </button>
        {syncMsg && <span style={{ alignSelf: 'center', fontSize: '0.85rem', color: syncMsg.startsWith('✅') ? 'var(--pos)' : syncMsg.startsWith('❌') ? 'var(--neg)' : 'var(--text2, #f59e0b)', width: '100%', textAlign: 'center', marginTop: '0.5rem' }}>{syncMsg}</span>}
      </div>
      )}

      {/* Hero row: Net Worth + Routines */}
      {((showBalancesSection && hasMoney) || canGym) && (
      <div className="home-hero" style={showBalancesSection && hasMoney && canGym ? undefined : { gridTemplateColumns: '1fr' }}>
        {showBalancesSection && hasMoney && (
        <div className="net-worth-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="nw-label">Overall Bank Balance</div>
              <div className="nw-value">{showBalances ? fmt(netWorth) : '₹ ••••••'}</div>
              <div className="nw-sub">Across {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'}</div>
            </div>
            <button
              onClick={() => setShowBalances(!showBalances)}
              style={{ position: 'relative', zIndex: 10, background: 'rgba(255,255,255,0.15)', border: 'none', borderRadius: '50%', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.2s', fontSize: '1.2rem' }}
              title={showBalances ? "Hide Balances" : "Show Balances"}
              onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.25)'}
              onMouseLeave={(e) => e.currentTarget.style.background = 'rgba(255,255,255,0.15)'}
            >
              {showBalances ? '🙈' : '👁️'}
            </button>
          </div>
        </div>
        )}
        {canGym && <RoutinesHomeCard onOpen={onOpenRoutines} dataVersion={dataVersion} />}
      </div>
      )}

      {/* Accounts */}
      {showBalancesSection && hasMoney && (
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <h2 className="section-title" style={{ margin: 0 }}>🏦 Account Balances</h2>
          {access.isOwner && (
          <button className="action-btn secondary" onClick={() => setIsReconcileOpen(true)} style={{ padding: '0.45rem 1rem' }}>
            ⚖️ Reconcile
          </button>
          )}
        </div>
        <div className="accounts-grid">
          {accounts
            // Cards keep no balance; they show what they've been used for this month instead.
            .filter(a => a.balance_tracked && (!isCcAccount(a.account) || a.used_this_month != null))
            .sort((a, b) => {
              // The familiar ones in their usual order, then cards, then any added since, alphabetically.
              const orderA = Object.keys(BANKS).indexOf(a.account);
              const orderB = Object.keys(BANKS).indexOf(b.account);
              const indexA = orderA === -1 ? (isCcAccount(a.account) ? 500 : 999) : orderA;
              const indexB = orderB === -1 ? (isCcAccount(b.account) ? 500 : 999) : orderB;
              return indexA - indexB || a.account.localeCompare(b.account);
            })
            .map(a => {
              const card = isCcAccount(a.account);
              const used = a.used_this_month || 0;
              const limit = card ? a.monthly_budget : a.min_balance;
              const level = card ? cardLevel(used, a.monthly_budget ?? null) : balanceLevel(a.balance || 0, a.min_balance);
              return (
                <div
                  className={`account-card ${showBalances && limit != null ? `floor-${level}` : ''}`}
                  key={a.account}
                  style={{ "--accent": accountColor(a.account) }}
                >
                  <div className="acc-top">
                    <span className="acc-emoji">{getBankEmoji(a.account)}</span>
                    <span className="acc-name">{a.account}</span>
                  </div>
                  <div className="acc-balance">
                    {!showBalances ? '₹ ••••••' : card ? (used > 0 ? `−${fmt(used)}` : fmt(0)) : fmt(a.balance)}
                    {showBalances && card && <span className="acc-caption">this month</span>}
                  </div>
                  {showBalances && (card
                    ? <CardBudgetChip account={a.account} budget={a.monthly_budget} used={used} editable={fullMoney} onSaved={onRefresh} />
                    : <MinBalanceChip account={a.account} min={a.min_balance} editable={fullMoney} onSaved={onRefresh} />)}
                </div>
              );
            })}
        </div>
      </section>
      )}

      {/* Budget Summary Section */}
      {canMoney && hasMoney && (
      <section className="section">
        <h2 className="section-title" style={{ margin: 0, marginBottom: '1.25rem' }}>🎯 Budget Goals {budgetSummary.active && <span style={{ fontSize: '0.85rem', fontWeight: 500, color: budgetSummary.over > 0 ? 'var(--neg)' : 'var(--text3)', marginLeft: '8px' }}>({budgetSummary.over === 0 ? 'All good this month!' : `${budgetSummary.over} over limit`})</span>}</h2>
        {budgetSummary.active ? (
          <div className="accounts-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))' }}>
            {budgetSummary.items.map(item => (
              <div key={item.category} className="budget-home-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '0.75rem', padding: '1.25rem' }} title="Manage Budgets in Money Tab">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.95rem', fontWeight: 600, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.category}</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '0.85rem' }}>
                    <span style={{ color: item.isOver ? 'var(--neg)' : 'var(--text)' }}>{summaryReady ? fmt(item.spent) : <span className="skeleton-line" style={{ width: '48px' }} />}</span>
                    <span style={{ color: 'var(--text3)' }}>/</span>
                    <span style={{ color: 'var(--text2)' }}>{fmt(item.limit)}</span>
                  </div>
                </div>
                <div style={{ width: '100%', height: '6px', background: 'var(--bg2)', borderRadius: '3px', overflow: 'hidden' }}>
                  <div style={{ width: `${item.percentage}%`, height: '100%', background: item.isOver ? 'var(--neg)' : (item.percentage >= 80 ? '#f59e0b' : 'var(--pos)'), transition: 'width 0.8s ease' }} />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="budget-home-card" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text3)' }}>
            No budgets set. Set them in the Money Tab!
          </div>
        )}
      </section>
      )}

      {/* Investments */}
      {canInvest && hasInvestments && (
      <section className="section">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem' }}>
          <h2 className="section-title" style={{ margin: 0, flex: 'none', display: 'flex' }}>📊 Investment Portfolio</h2>
          <button
            onClick={() => setShowInvestments(!showInvestments)}
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.1rem', padding: 0, lineHeight: 1, flexShrink: 0 }}
            title={showInvestments ? 'Hide' : 'Show'}
          >
            {showInvestments ? '🙈' : '👁️'}
          </button>
          <div style={{ flex: 1, height: '1px', background: 'var(--border)' }} />
        </div>
        <div className="inv-summary-grid">
          {[
            { label: "Date", val: latestDate, color: "text3" },
            { label: "Invested", val: showInvestments ? fmt(totalInvested) : '₹ ••••••', color: null },
            { label: "Current Value", val: showInvestments ? fmt(totalCurrent) : '₹ ••••••', color: null },
            { label: "Returns ₹", val: showInvestments ? fmt(totalReturn) : '₹ ••••••', color: totalReturn >= 0 ? "pos" : "neg" },
            { label: "Returns %", val: showInvestments ? fmtPct(totalRetPct) : '••••', color: totalRetPct >= 0 ? "pos" : "neg" },
          ].map(card => (
            <div className="inv-card" key={card.label}>
              <div className="inv-label">{card.label}</div>
              <div className={`inv-val ${card.color || ''}`}>{card.val}</div>
            </div>
          ))}
        </div>
      </section>
      )}

      {/* Money: Income & Expenses by Account */}
      {canMoney && hasMoney && (
      <section className="section">
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginBottom: '1.5rem' }}>
          <h2 className="section-title" style={{ margin: 0 }}>💰 Money</h2>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <CustomSelect
              value={moneyMonth}
              onChange={val => setMoneyMonth(parseInt(val))}
              options={MONTHS.map((m, i) => ({ label: m, value: i }))}
              minWidth="140px"
            />
            <CustomSelect
              value={moneyYear}
              onChange={val => setMoneyYear(parseInt(val))}
              options={yearOptions().map(y => ({ label: String(y), value: y }))}
              minWidth="100px"
            />
          </div>
        </div>
        <div className="money-top">
          <div className="money-col">
            <div className="col-title income-title">💚 Income by Account</div>
            {accounts
              .filter(a => a.balance_tracked) // only show balance-tracked accounts
              .map(a => (
                <div key={a.account} className="acc-row">
                  <div className="acc-row-left">{getBankEmoji(a.account)} {a.account}</div>
                  <span className="pos">{money(income[a.account] || 0)}</span>
                </div>
              ))}
            <div className="acc-row" style={{ fontWeight: 700 }}>
              <div>Total</div>
              <span className="pos">
                {money(
                  accounts
                    .filter(a => a.balance_tracked)
                    .reduce((sum, a) => sum + (income[a.account] || 0), 0)
                )}
              </span>
            </div>
          </div>

          <div className="money-col">
            <div className="col-title expense-title">❤️ Expenses by Account</div>
            {accounts
              .filter(a => a.balance_tracked) // only show balance-tracked accounts
              .map(a => (
                <div key={a.account} className="acc-row">
                  <div className="acc-row-left">{getBankEmoji(a.account)} {a.account}</div>
                  <span className="neg">{money(expense[a.account] || 0)}</span>
                </div>
              ))}
            <div className="acc-row" style={{ fontWeight: 700 }}>
              <div>Total</div>
              <span className="neg">
                {money(
                  accounts
                    .filter(a => a.balance_tracked)
                    .reduce((sum, a) => sum + (expense[a.account] || 0), 0)
                )}
              </span>
            </div>
          </div>
        </div>
      </section>
      )}
      {isReconcileOpen && (
        <ReconciliationModal
          accounts={accounts}
          onClose={() => setIsReconcileOpen(false)}
          onRefresh={onRefresh}
        />
      )}

      {/* 📱 Mobile Version Tag (at bottom of Home) */}
      <div className="mobile-version-tag">
        v:{__COMMIT_SHA__} • {__BUILD_TIME__}
      </div>
    </div> // This is the closing div of HomeTab
  );
}

export default memo(HomeTab);
