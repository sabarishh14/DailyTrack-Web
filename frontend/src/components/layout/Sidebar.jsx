import { SETTINGS_TAB, TABS } from '../../constants';

export default function Sidebar({
  sidebarWidth,
  setSidebarWidth,
  isResizing,
  startResizing,
  handleLogoClick,
  sidebarMinimized,
  tabs = TABS,
  tab,
  setTab,
  today,
}) {
  return (
    <aside className="sidebar" style={{ width: `${sidebarWidth}px`, transition: isResizing ? 'none' : 'width 0.3s ease', position: 'relative' }}>

      {/* Invisible Drag Handle */}
      <div
        onMouseDown={startResizing}
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          width: '6px',
          height: '100%',
          cursor: 'col-resize',
          background: isResizing ? 'var(--accent)' : 'transparent',
          zIndex: 100,
          transition: 'background 0.2s',
        }}
        onMouseEnter={(e) => { if (!isResizing) e.target.style.background = 'rgba(99,102,241,0.3)'; }}
        onMouseLeave={(e) => { if (!isResizing) e.target.style.background = 'transparent'; }}
      />

      <div className="sidebar-logo" onClick={handleLogoClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100px', position: 'relative', cursor: 'pointer', overflow: 'hidden' }}>
        <div style={{ textAlign: 'center', opacity: sidebarMinimized ? 0 : 1, transition: 'opacity 0.3s ease 0.05s', pointerEvents: sidebarMinimized ? 'none' : 'auto', width: '100%', padding: '0 10px' }}>
          <span className="logo-name" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>DailyTrack</span>
          <span className="logo-sub" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Personal Dashboard</span>
        </div>
        <div style={{ opacity: sidebarMinimized ? 1 : 0, transition: 'opacity 0.3s ease 0.05s', pointerEvents: sidebarMinimized ? 'auto' : 'none', position: 'absolute' }}>
          <span className="logo-name" style={{ fontSize: '1.2rem' }}>DT</span>
        </div>
      </div>
      <nav className="sidebar-nav" style={{ overflowX: 'hidden' }}>
        {tabs.map(t => (
          <button
            key={t.id}
            className={`nav-item ${tab === t.id ? 'active' : ''} ${t.add ? 'add-item' : ''}`}
            onClick={() => setTab(t.id)}
            title={sidebarMinimized ? t.label : ''}
            style={{
              justifyContent: sidebarMinimized ? 'center' : (t.add ? 'center' : 'flex-start'),
              gap: sidebarMinimized ? 0 : '0.75rem',
              padding: sidebarMinimized ? '0.7rem 0' : '0.7rem 0.85rem',
              overflow: 'hidden',
              width: '100%'
            }}
          >
            <span className="nav-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: sidebarMinimized ? '100%' : 'auto' }}>{t.icon}</span>
            <span className="nav-label" style={{
              opacity: sidebarMinimized ? 0 : 1,
              flex: sidebarMinimized ? 'none' : 1,
              minWidth: 0,
              width: sidebarMinimized ? 0 : 'auto',
              overflow: 'hidden',
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              transition: 'opacity 0.2s ease',
              display: 'block'
            }}>
              {t.label}
            </span>
          </button>
        ))}
      </nav>
      <div className="sidebar-settings">
        <button
          className={`nav-item ${tab === SETTINGS_TAB ? 'active' : ''}`}
          onClick={() => setTab(SETTINGS_TAB)}
          title={sidebarMinimized ? 'Settings' : ''}
          style={{
            justifyContent: sidebarMinimized ? 'center' : 'flex-start',
            gap: sidebarMinimized ? 0 : '0.75rem',
            padding: sidebarMinimized ? '0.7rem 0' : '0.7rem 0.85rem',
            overflow: 'hidden',
          }}
        >
          <span className="nav-icon" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, width: sidebarMinimized ? '100%' : 'auto' }}>⚙️</span>
          <span className="nav-label" style={{
            opacity: sidebarMinimized ? 0 : 1,
            flex: sidebarMinimized ? 'none' : 1,
            width: sidebarMinimized ? 0 : 'auto',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            transition: 'opacity 0.2s ease',
            display: 'block'
          }}>
            Settings
          </span>
        </button>
      </div>
      <div className="sidebar-footer" style={{ padding: sidebarMinimized ? '1rem 0' : '1rem 1.5rem', transition: 'padding 0.3s ease', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <button
          onClick={() => setSidebarWidth(sidebarMinimized ? 280 : 70)} // <-- Increased from 250
          style={{
            width: '100%',
            padding: '0',
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            cursor: 'pointer',
            fontSize: '1.2rem',
            fontWeight: 700,
            transition: 'all 0.3s ease',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: sidebarMinimized ? 0 : '0.4rem',
            fontFamily: "'Syne', sans-serif",
            marginBottom: '1rem',
            height: '32px'
          }}
          onMouseEnter={(e) => e.target.style.color = 'var(--accent)'}
          onMouseLeave={(e) => e.target.style.color = 'var(--text)'}
          title={sidebarMinimized ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{sidebarMinimized ? '➡' : '⬅'}</span>
          <span style={{
            opacity: sidebarMinimized ? 0 : 1,
            maxWidth: sidebarMinimized ? 0 : '50px',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            transition: 'all 0.3s ease',
            fontSize: '0.75rem',
            letterSpacing: '0.5px',
            pointerEvents: sidebarMinimized ? 'none' : 'auto'
          }}>
            HIDE
          </span>
        </button>

        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          overflow: 'hidden',
          whiteSpace: 'nowrap'
        }}>
          <div className="sidebar-date" style={{ fontSize: sidebarMinimized ? '0.7rem' : '0.75rem', transition: 'all 0.3s ease', color: 'var(--text3)', fontWeight: 500 }}>
            {sidebarMinimized
              ? today.toLocaleDateString('en-IN', { day: 'numeric', month: 'numeric', year: '2-digit' })
              : today.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
            }
          </div>
          <div style={{
            opacity: sidebarMinimized ? 0 : 1,
            maxHeight: sidebarMinimized ? 0 : '20px',
            marginTop: sidebarMinimized ? 0 : '2px',
            fontSize: '0.75rem',
            color: 'var(--text2)',
            transition: 'all 0.3s ease',
            overflow: 'hidden'
          }}>
            {today.toLocaleDateString('en-IN', { weekday: 'long' })}
          </div>

          {/* NEW: Version and Build Time */}
          <div style={{
            opacity: sidebarMinimized ? 0 : 1,
            maxHeight: sidebarMinimized ? 0 : '20px',
            marginTop: '8px',
            fontSize: '0.6rem',
            color: 'var(--border2)',
            transition: 'all 0.3s ease',
            overflow: 'hidden',
            fontFamily: "'DM Sans', monospace"
          }}>
            v:{__COMMIT_SHA__} • {__BUILD_TIME__}
          </div>
        </div>
      </div>
    </aside>
  );
}
