import { useState, useEffect, useCallback, useRef, useMemo, memo } from "react";
import { createPortal } from "react-dom";
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Legend } from "recharts";
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider, signOut } from 'firebase/auth';
import SabDekho from '../pages/SabDekho';

import { API } from '../constants';
import { auth, googleProvider } from '../config/firebase';

export default function LoginPage({ onLogin, notice }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Not in yet: the server sent a request to the admin.
  const [requested, setRequested] = useState(null);

  const handleGoogleLogin = async () => {
    setLoading(true); setError('');
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const idToken = await result.user.getIdToken();

      // Send Firebase token to our backend to verify + get our JWT
      const res = await fetch(`${API}/auth/firebase-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id_token: idToken })
      });
      const data = await res.json();

      if (data.success) {
        localStorage.setItem('dt_token', data.token);
        if (data.isAdmin) localStorage.setItem('dt_is_admin', 'true');
        onLogin(data.access);
      } else if (data.code === 'REQUESTED') {
        setRequested(data.email || result.user.email || '');
        signOut(auth).catch(() => {});
      } else {
        setError(data.message || 'Login failed.');
      }
    } catch (e) {
      setError(e.message || 'Google sign-in failed.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <div style={{ background: 'var(--card)', border: '1px solid var(--border)', borderRadius: '20px', padding: '2.5rem', width: '100%', maxWidth: '380px', boxShadow: '0 24px 60px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.5rem' }}>

        <div style={{ textAlign: 'center' }}>
          <span className="logo-name" style={{ fontSize: '2rem' }}>DailyTrack</span>
          <div style={{ fontSize: '0.8rem', color: 'var(--text2)', marginTop: '0.4rem' }}>Personal Dashboard</div>
        </div>

        {requested !== null ? (
          <div className="login-requested">
            <span aria-hidden="true">📨</span>
            <b>Request sent</b>
            <span>{requested ? `${requested} can sign in once it's approved.` : "You can sign in once it's approved."}</span>
          </div>
        ) : (
          <>
            {notice && !error && <div className="login-notice">{notice}</div>}
            {error && <div style={{ fontSize: '0.8rem', color: 'var(--neg)', textAlign: 'center', width: '100%' }}>{error}</div>}
          </>
        )}

        <button
          onClick={handleGoogleLogin}
          disabled={loading}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem',
            padding: '0.85rem 1.5rem', borderRadius: '12px', border: '1px solid var(--border)',
            background: 'var(--bg3)', color: 'var(--text)', cursor: loading ? 'not-allowed' : 'pointer',
            fontFamily: "'DM Sans', sans-serif", fontSize: '0.95rem', fontWeight: 600,
            transition: 'all 0.2s', opacity: loading ? 0.7 : 1
          }}
          onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent)'}
          onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
        >
          {loading ? '⏳ Signing in...' : (
            <>
              <svg width="18" height="18" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.6 20H24v8h11.3C33.6 33.1 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34.1 6.5 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20c11 0 19.7-8 19.7-20 0-1.3-.1-2.7-.1-4z" />
                <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.5 16 19 13 24 13c3 0 5.7 1.1 7.8 2.9l5.7-5.7C34.1 6.5 29.3 4 24 4 16.3 4 9.7 8.4 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-1.9 13.5-5l-6.2-5.2C29.4 35.6 26.8 36 24 36c-5.2 0-9.6-2.9-11.3-7.1l-6.5 5C9.5 39.6 16.3 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20H24v8h11.3c-.9 2.4-2.5 4.4-4.6 5.8l6.2 5.2C40.7 35.7 44 30.3 44 24c0-1.3-.1-2.7-.4-4z" />
              </svg>
              Sign in with Google
            </>
          )}
        </button>

        <div style={{ fontSize: '0.75rem', color: 'var(--text2)', textAlign: 'center' }}>
          Only authorized Google accounts can access this dashboard.
        </div>
      </div>
    </div>
  );
}
