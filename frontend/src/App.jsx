import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from './pages/SabDekho';

import { API, TABS } from './constants';
import { getToken } from './utils';
import { auth } from './config/firebase';
import MemoizedHomeTab from './pages/HomeTab';
import MemoizedMoneyTab from './pages/MoneyTab';
import MemoizedAddTab from './pages/AddTab';
import MemoizedRoutinesTab from './pages/RoutinesTab';
import MemoizedInvestTab from './pages/InvestTab';
import MemoizedSabDekho from './pages/SabDekho';
import LoginPage from './components/LoginPage';
import LoadingScreen from './components/LoadingScreen';
import AccessControlModal from './components/AccessControlModal';
import { AccessProvider, buildAccess, loadStoredAccess, storeAccess, canOpenTab } from './access/AccessContext';
import GlobalSearchModal from './components/GlobalSearchModal';
import EditTransactionModal from './components/EditTransactionModal';
import FloatingChatWidget from './components/FloatingChatWidget';
import Sidebar from './components/layout/Sidebar';
import TopBar from './components/layout/TopBar';
import MobileBottomNav from './components/layout/MobileBottomNav';

// Turns a 401 into the message shown on the login screen.
const revokedNotice = async (res) => {
  try {
    const body = await res.clone().json();
    if (body.code === 'ACCESS_REVOKED') return 'Your access to DailyTrack has been removed. Contact the owner if this is a mistake.';
  } catch { /* not JSON */ }
  return 'Your session has expired. Please sign in again.';
};

export default function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('dt_token'));
  const [appLoading, setAppLoading] = useState(!!localStorage.getItem('dt_token'));
  const [tab, setTab] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // 🚀 GLOBAL SEARCH STATES
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [globalSearchEditTx, setGlobalSearchEditTx] = useState(null);
  const [globalActionTx, setGlobalActionTx] = useState(null);

  // 🚀 GLOBAL SEARCH KEYBOARD LISTENER
  useEffect(() => {
    const handleCmdK = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsSearchOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleCmdK);
    return () => window.removeEventListener('keydown', handleCmdK);
  }, []);

  const [loadingLogs, setLoadingLogs] = useState([]);
  const [accounts, setAccounts] = useState([]);
  // Bumped after every full refresh; server-computed money views refetch on it.
  const [dataVersion, setDataVersion] = useState(0);
  // Lives here (not in Home) so Cmd+K "Toggle Balances Visibility" can flip it.
  const [showBalances, setShowBalances] = useState(false);
const [categories, setCategories] = useState([]);
  const [budgets, setBudgets] = useState([]); // 🚀 NEW STATE FOR BUDGETS
  const [investments, setInvestments] = useState([]);
  const [manualAssets, setManualAssets] = useState([]); // 🚀 NEW STATE
  const [assetList, setAssetList] = useState({}); // 🚀 NEW: Dropdown options

  // 🔐 ACCESS CONTROL: what this user may see/do (refreshed from /auth/me)
  const [accessRaw, setAccessRaw] = useState(loadStoredAccess);
  const access = useMemo(() => buildAccess(accessRaw), [accessRaw]);
  const accessRef = useRef(access);
  accessRef.current = access;
  const [authNotice, setAuthNotice] = useState('');
  const visibleTabs = useMemo(() => TABS.filter(t => canOpenTab(access, t.id)), [access]);

  // 🚀 SECRET DEV MENU STATES
  const [logoClicks, setLogoClicks] = useState(0);
  const [isSecretMenuOpen, setIsSecretMenuOpen] = useState(false);
  const isAdmin = access.isAdmin;
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // 🚀 GLOBAL ESCAPE: Closes App-level Modals
  useEffect(() => {
    const handleEsc = (e) => {
      if (e.key === 'Escape') {
        setIsSecretMenuOpen(false);
        setIsMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, []);

  // Close hamburger menu on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setIsMenuOpen(false);
      }
    };
    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  // The hidden trigger function
  const handleLogoClick = () => {
    setTab(0); // Maintain normal home navigation
    if (!isAdmin) return;

    setLogoClicks(prev => {
      if (prev + 1 >= 7) {
        setIsSecretMenuOpen(true);
        return 0;
      }
      return prev + 1;
    });
  };

  // --- Sidebar Resizing Logic ---
  const [sidebarWidth, setSidebarWidth] = useState(70);
  const [isResizing, setIsResizing] = useState(false);

  // --- Theme & Accent Logic ---
  const [theme, setTheme] = useState(localStorage.getItem('theme') || 'dark');
  const [accent, setAccent] = useState(localStorage.getItem('dt_accent') || 'indigo');

  // --- SabDekho Settings ---
  const [showMovies, setShowMovies] = useState(localStorage.getItem('dt_show_movies') === 'true');
  const [enableNagapandi, setEnableNagapandi] = useState(localStorage.getItem('dt_enable_nagapandi') === 'true');
  const toggleNagapandi = () => {
    const val = !enableNagapandi;
    setEnableNagapandi(val);
    localStorage.setItem('dt_enable_nagapandi', val);
  };
  const [lbxUsername, setLbxUsername] = useState(localStorage.getItem('dt_lbx_username') || 'sabarishh14');
  const [lbxSyncing, setLbxSyncing] = useState(false);
  const [lbxSyncStatus, setLbxSyncStatus] = useState('');
  const [sabDekhoRefresh, setSabDekhoRefresh] = useState(0);

  const toggleShowMovies = () => {
    const val = !showMovies;
    setShowMovies(val);
    localStorage.setItem('dt_show_movies', val);
  };

  const syncLetterboxd = async () => {
    if (!lbxUsername) return alert("Please enter Letterboxd username");
    setLbxSyncing(true);
    setLbxSyncStatus('Syncing...');
    localStorage.setItem('dt_lbx_username', lbxUsername);
    try {
      const response = await fetch(`${API}/movies/sync/rss`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getToken()}`
        },
        body: JSON.stringify({ username: lbxUsername })
      });

      if (!response.body) throw new Error("No response body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let finalData = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.status === 'complete') {
              finalData = data;
            } else if (data.status) {
              setLbxSyncStatus(data.status);
            } else if (data.message) {
              setLbxSyncStatus(`Error: ${data.message}`);
            }
          } catch (e) { }
        }
      }

      if (finalData && finalData.success) {
        setLbxSyncStatus(`Synced! Added ${finalData.added_movies} movies, ${finalData.added_logs} logs.`);
        setSabDekhoRefresh(prev => prev + 1); // Trigger SabDekho refresh
      } else if (finalData && !finalData.success) {
        setLbxSyncStatus(`Error: ${finalData.message}`);
      }
    } catch (e) {
      setLbxSyncStatus(`Sync failed: ${e.message}`);
    }
    setLbxSyncing(false);
  };

  const logout = useCallback((notice = '') => {
    signOut(auth);
    localStorage.removeItem('dt_token');
    localStorage.removeItem('dt_is_admin'); // <-- ADD THIS LINE
    storeAccess(null);
    setAccessRaw(null);
    setAuthNotice(typeof notice === 'string' ? notice : '');
    setIsLoggedIn(false);
setAccounts([]);
    setInvestments([]);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('dt_accent', accent);
  }, [accent]);

  // Re-check permissions: picks up role changes live and logs out a removed user.
  const refreshAccess = useCallback(async () => {
    if (!getToken()) return;
    try {
      const r = await fetch(`${API}/auth/me`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      if (r.status === 401) return logout(await revokedNotice(r));
      const res = await r.json();
      if (res.success) {
        setAccessRaw(prev => JSON.stringify(prev) === JSON.stringify(res.access) ? prev : res.access);
        storeAccess(res.access);
      }
    } catch { /* offline or server waking up: keep the last known access */ }
  }, [logout]);

  useEffect(() => {
    if (!isLoggedIn) return;
    const tick = () => { if (document.visibilityState === 'visible') refreshAccess(); };
    const interval = setInterval(tick, 60 * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', tick); };
  }, [isLoggedIn, refreshAccess]);

  // If a permission change hides the open tab, fall back to Home.
  useEffect(() => {
    if (!canOpenTab(access, tab)) setTab(0);
  }, [access, tab]);

  // Keep Hugging Face Space awake while the tab is open!
  useEffect(() => {
    if (!isLoggedIn) return;
    const pingInterval = setInterval(() => {
      // Pings the /test-db route every 3 minutes
      fetch(API.replace('/api', '/test-db')).catch(() => { });
    }, 3 * 60 * 1000);
    return () => clearInterval(pingInterval);
  }, [isLoggedIn]);

  const startResizing = useCallback((e) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (!isResizing) return;
      let newWidth = e.clientX;
      if (newWidth < 70) newWidth = 70;   // Minimum shrink
      if (newWidth > 400) newWidth = 400; // Maximum expand
      setSidebarWidth(newWidth);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      // Snap to mini mode if they drag it really small
      setSidebarWidth(w => w < 120 ? 70 : w);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none'; // Prevents highlighting text while dragging
    } else {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);

  // Dynamically calculate if we are in "mini" mode based on width!
  const sidebarMinimized = sidebarWidth < 140;

  const refreshBudgets = useCallback(async () => {
    if (!getToken()) return;
    try {
      const res = await fetch(`${API}/budgets`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      }).then(r => r.json());
      if (res && res.success) {
        setBudgets(res.budgets);
      }
    } catch (e) {
      console.error("Failed to load budgets", e);
    }
  }, []);

  const fetchAll = useCallback(async (showLoading = false, attempt = 1) => {
    if (showLoading) setAppLoading(true);

    const addLog = (msg) => {
      setLoadingLogs(prev => {
        const time = new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return [...prev, `[${time}] ${msg}`];
      });
    };

    try {
      if (showLoading) {
        setLoadingLogs([]); // reset
        addLog("Initializing startup sequence...");
      }

      // Helper function that explicitly throws an error if the server is throwing 500/503 during wake-up
      const fetchWithCheck = async (url, name) => {
        if (showLoading) addLog(`Fetching ${name}...`);
        const r = await fetch(url, { headers: { 'Authorization': `Bearer ${getToken()}` } });
        if (r.status === 401) {
          logout(await revokedNotice(r));
          throw new Error("UNAUTHORIZED");
        }
        if (!r.ok) throw new Error(`Server waking up: ${r.status}`);
        if (showLoading) addLog(`${name} loaded OK.`);
        return r.json();
      };

      // Trigger Lazy Cron before fetching data so UI gets the updated values.
      // It runs alongside the access check (not after it) so startup isn't slower;
      // skipped when the last known access says this user can't edit investments.
      const known = accessRef.current;
      const cron = (!known.email || known.can('invest', 'edit'))
        ? fetch(`${API}/cron/process-recurring`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` } }).catch(() => console.log("Cron passed"))
        : Promise.resolve();

      // Permissions first: they decide which data this user is allowed to load.
      if (showLoading) addLog("Authenticating & checking access...");
      const [me] = await Promise.all([fetchWithCheck(`${API}/auth/me`, 'Access'), cron]);
      const acl = buildAccess(me.access);
      setAccessRaw(me.access);
      storeAccess(me.access);

      if (showLoading) addLog("Connecting to LifeTrack database...");

      // Only ask for what this user can see; everything else resolves empty.
      const when = (allowed, url, name, empty) => allowed ? fetchWithCheck(url, name) : Promise.resolve(empty);
      const money = acl.can('money'), invest = acl.can('invest');
      const [acc, inv, manAssets, listRes, catRes, budRes] = await Promise.all([
        when(money, `${API}/accounts`, 'Accounts', []),
        when(invest, `${API}/investments`, 'Investments', []),
        when(invest, `${API}/manual_assets`, 'Manual Assets', []),
when(invest, `${API}/assets/list`, 'Market Symbols', {}),
        when(money, `${API}/transactions/categories`, 'Categories', { success: true, categories: [] }),
        when(money, `${API}/budgets`, 'Budgets', { success: true, budgets: [] })
      ]);

      if (showLoading) addLog("Data parsed successfully. Finalizing UI...");

      setAccounts(acc);
      setInvestments(inv);
      setManualAssets(manAssets);
      setAssetList(listRes); // 🚀 SAVE SYMBOLS
      // A category-scoped user may add to allowed categories that have no history yet.
      if (acl.money.categories) setCategories(acl.money.categories);
      else if (catRes && catRes.success) setCategories(catRes.categories);
      if (budRes && budRes.success) setBudgets(budRes.budgets);

      // Also trigger SabDekho refresh
      setSabDekhoRefresh(prev => prev + 1);
      setDataVersion(v => v + 1);

      if (showLoading) setAppLoading(false);
    } catch (e) {
      if (e.message === "UNAUTHORIZED") {
        setAppLoading(false);
        return;
      }
      if (showLoading) {
        addLog(`Server unavailable (${e.message.split(':')[0] || 'timeout'}). Retrying in 3s... (Attempt ${attempt}/5)`);
      }
      console.warn("Server is asleep or database is booting. Retrying in 3 seconds...", e.message);

      if (attempt >= 5) {
        if (showLoading) addLog("Max connection attempts reached. Backend is unreachable. Please try again later.");
        return;
      }

      // The loading screen stays up, and we try again automatically!
      setTimeout(() => fetchAll(showLoading, attempt + 1), 3000);
    }
  }, [logout]);

  useEffect(() => { if (isLoggedIn) fetchAll(true); }, [fetchAll, isLoggedIn]);

const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Stable, so the memoised Home tab doesn't re-render for it.
  const openRoutines = useCallback(() => setTab(3), []);

  const renderTab = () => {
    return (
      <>
        {tab === 0 && <MemoizedHomeTab accounts={accounts ?? []} investments={investments ?? []} budgets={budgets ?? []} onRefresh={fetchAll} dataVersion={dataVersion} showBalances={showBalances} setShowBalances={setShowBalances} onOpenRoutines={openRoutines} />}
        {access.can('money') && (
          <div style={{ display: tab === 1 ? 'contents' : 'none' }}>
            <MemoizedMoneyTab accounts={accounts} categories={categories} budgets={budgets} onRefresh={fetchAll} refreshBudgets={refreshBudgets} globalActionTx={globalActionTx} setGlobalActionTx={setGlobalActionTx} dataVersion={dataVersion} isActive={tab === 1} />
          </div>
        )}
        {tab === 2 && <MemoizedAddTab accounts={accounts} categories={categories} onAdd={fetchAll} dataVersion={dataVersion} />}
        {tab === 3 && <MemoizedRoutinesTab />}
        {tab === 4 && <MemoizedInvestTab investments={investments} manualAssets={manualAssets} assetList={assetList} onAdd={fetchAll} />}
        {tab === 5 && <MemoizedSabDekho API={API} getToken={getToken} showMovies={showMovies} refreshTrigger={sabDekhoRefresh} />}
      </>
    );
  };



  if (!isLoggedIn) return <LoginPage notice={authNotice} onLogin={(acc) => { setAuthNotice(''); if (acc) { setAccessRaw(acc); storeAccess(acc); } setIsLoggedIn(true); }} />;
  if (appLoading) return <LoadingScreen logs={loadingLogs} />;

  return (
    <AccessProvider access={accessRaw}>
    <div className="app">
      {/* Sidebar */}
      <Sidebar
        sidebarWidth={sidebarWidth}
        setSidebarWidth={setSidebarWidth}
        isResizing={isResizing}
        startResizing={startResizing}
        handleLogoClick={handleLogoClick}
        sidebarMinimized={sidebarMinimized}
        tabs={visibleTabs}
        tab={tab}
        setTab={setTab}
        today={today}
      />

      {/* Main */}
      <div className="main-area">
        <TopBar
          tab={tab}
          isRefreshing={isRefreshing}
          onRefresh={async () => {
            if (isRefreshing) return;
            setIsRefreshing(true);
            await fetchAll(false);
            setIsRefreshing(false);
          }}
          onOpenSearch={() => setIsSearchOpen(true)}
          theme={theme}
          setTheme={setTheme}
          isMenuOpen={isMenuOpen}
          setIsMenuOpen={setIsMenuOpen}
          menuRef={menuRef}
          accent={accent}
          setAccent={setAccent}
          isAdmin={isAdmin}
          onOpenAccessControl={() => setIsSecretMenuOpen(true)}
          canSyncLetterboxd={access.can('sabdekho', 'edit')}
          enableNagapandi={enableNagapandi}
          toggleNagapandi={toggleNagapandi}
          showMovies={showMovies}
          toggleShowMovies={toggleShowMovies}
          lbxUsername={lbxUsername}
          setLbxUsername={setLbxUsername}
          lbxSyncing={lbxSyncing}
          lbxSyncStatus={lbxSyncStatus}
          syncLetterboxd={syncLetterboxd}
          logout={logout}
        />
        <main className="page-body">
          {renderTab()}
        </main>
      </div>

      {/* 🚀 HIDDEN DEVELOPER MENU */}
      {isSecretMenuOpen && isAdmin && (
        <AccessControlModal currentEmail={access.email} onClose={() => { setIsSecretMenuOpen(false); refreshAccess(); }} />
      )}


      {/* 🚀 GLOBAL SEARCH UI */}
      <GlobalSearchModal getToken={getToken}
        tabs={visibleTabs}
        enableNagapandi={isAdmin && enableNagapandi}
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        canSearchMoney={access.can('money')}
        canToggleBalances={access.money.balancesVisible}
onNavigate={(id) => setTab(id)}
        onEditTx={(tx) => { setTab(1); setGlobalActionTx(tx); }}
        onAction={(action) => {
          if (action === 'theme') setTheme(theme === 'dark' ? 'light' : 'dark');
          if (action === 'balances') { setShowBalances(v => !v); setTab(0); }
        }}
      />

      {globalSearchEditTx && (
        <EditTransactionModal
          tx={globalSearchEditTx}
          categories={categories}
          onClose={() => setGlobalSearchEditTx(null)}
          onRefresh={fetchAll}
          isCopy={false}
        />
      )}

      {isAdmin && enableNagapandi && <FloatingChatWidget getToken={getToken} />}
      {/* 📱 Mobile Bottom Navigation */}
      <MobileBottomNav tabs={visibleTabs} tab={tab} setTab={setTab} handleLogoClick={handleLogoClick} />
    </div>
    </AccessProvider>


  );
}
