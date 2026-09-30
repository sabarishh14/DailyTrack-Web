import { TAB_TITLES } from '../../constants';

// Everything that used to live in this menu (accent, films, Letterboxd,
// Nagapandi) is on the Settings page now.
export default function TopBar({
  tab,
  isRefreshing,
  onRefresh,
  onOpenSearch,
  theme,
  setTheme,
  isMenuOpen,
  setIsMenuOpen,
  menuRef,
  email,
  roleLabel,
  isAdmin,
  onOpenSettings,
  onOpenAccessControl,
  logout,
}) {
  return (
    <header className="topbar">
      <div className="topbar-title">{TAB_TITLES[tab]}</div>
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>

        {/* -1. Refresh Button */}
        <button
          className="action-btn secondary"
          style={{ padding: '0.4rem', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: '1.2rem', cursor: isRefreshing ? 'default' : 'pointer', transition: 'transform 0.3s' }}
          onClick={onRefresh}
          title="Reload Data"
        >
          <svg
            style={{ animation: isRefreshing ? 'spin 1s linear infinite' : 'none' }}
            width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.92-10.26l5.08 5.08" />
          </svg>
        </button>

        {/* 0. Global Search Button */}
        <button
          className="action-btn secondary"
          style={{ padding: '0.4rem', border: 'none', background: 'transparent', color: 'var(--text)', fontSize: '1.2rem', cursor: 'pointer' }}
          onClick={onOpenSearch}
          title="Global Search (Cmd+K)"
        >
          🔍
        </button>

        {/* 1. Theme Toggle (Animated Pill) */}
        <button
          className={`theme-toggle ${theme === 'light' ? 'light' : ''}`}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle theme"
        >
          <span className="theme-toggle-thumb" />
        </button>

        {/* 2. Menu Button */}
        <div ref={menuRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            aria-label="Menu"
            aria-expanded={isMenuOpen}
            style={{ background: 'transparent', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: '0.4rem', display: 'flex' }}
          >
            <svg width="26" height="26" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" /></svg>
          </button>

          {isMenuOpen && (
            <div className="menu-dropdown">
              {email && (
                <div className="menu-profile">
                  <b>{email}</b>
                  <span>{roleLabel}</span>
                </div>
              )}

              <div className="menu-section" style={{ padding: '0.35rem 0' }}>
                <button className="menu-item" onClick={() => { setIsMenuOpen(false); onOpenSettings(); }}>
                  <span>⚙️</span> Settings
                  <span className="menu-item-sub">›</span>
                </button>
                {isAdmin && (
                  <button className="menu-item" onClick={() => { setIsMenuOpen(false); onOpenAccessControl(); }}>
                    <span>🛡️</span> Access Control
                    <span className="menu-item-sub">›</span>
                  </button>
                )}
              </div>

              <div className="menu-section" style={{ padding: '0.35rem 0 0' }}>
                <button className="menu-item danger" onClick={() => { setIsMenuOpen(false); logout(); }}>
                  <span>🚪</span> Log out
                </button>
              </div>
            </div>
          )}
        </div>

      </div>
    </header>
  );
}
