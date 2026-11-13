// The private vault's screens: the 🔒 on Investments (with what it means), the
// card that unlocks it, and its part of Settings (turning it on, the recovery
// key, friends, turning it off). The work is in ../vault/.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import * as vault from '../vault/store';
import { newRecoveryKey, normalizePassphrase } from '../vault/crypto';
import { suggestPassphrase } from '../vault/words';

let version = 0;
let cached = null;
vault.subscribe(() => { version++; });
const read = () => {
  if (!cached || cached.v !== version) cached = { v: version, s: vault.snapshot() };
  return cached.s;
};

/** The vault's state for what's on screen, kept current. */
export function useVault() {
  const s = useSyncExternalStore(vault.subscribe, read);
  useEffect(() => {
    vault.status().then(() => vault.tryRemembered()).catch(() => {});
  }, []);
  return s;
}

const MIN_PASSPHRASE = 12;

// ── On Investments ──────────────────────────────────────────────────────────

/** 🔒 Private (or a quiet 🔓): tap or hover for what it means. */
export function VaultBadge({ canChange }) {
  const v = useVault();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return undefined;
    const close = () => setOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [open]);
  if (v.state === 'unknown') return null;
  const on = v.state === 'on';
  if (!on && !canChange) return null;
  const text = on
    ? (v.viewing
      ? `${v.owner} keeps these in a private vault. Only their devices, and yours, can read them; not even the app's admin.`
      : 'Locked with your passphrase. Only your devices can read your investments; not even the app’s admin.')
    : 'Stored readable on the server. Turn on the private vault in Settings › Investments to lock them with a passphrase only you know.';
  return (
    <span className="vault-badge-wrap">
      <button
        type="button"
        className={`vault-badge ${on ? 'on' : ''}`}
        title={text}
        aria-label={on ? 'Private vault on' : 'Private vault off'}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
      >
        {on ? '🔒 Private' : '🔓'}
      </button>
      {open && <span className="vault-tip" role="tooltip" onClick={e => e.stopPropagation()}>{text}</span>}
    </span>
  );
}

/** Unlock form: the passphrase, or the recovery key. */
function UnlockForm({ onDone, compact }) {
  const [secret, setSecret] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (!secret.trim()) return;
    setBusy(true);
    setError('');
    try {
      await vault.unlock(secret, { recovery, remember });
      onDone?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className={`vault-unlock ${compact ? 'compact' : ''}`} onSubmit={submit}>
      <span className="st-input-wrap">
        <input
          type={recovery ? 'text' : 'password'} value={secret} autoFocus={!compact} autoComplete={recovery ? 'off' : 'current-password'}
          onChange={e => setSecret(e.target.value)} disabled={busy}
          placeholder={recovery ? 'XXXX-XXXX-XXXX-…' : 'Your passphrase'}
          aria-label={recovery ? 'Recovery key' : 'Passphrase'}
        />
      </span>
      <button type="submit" className="action-btn" disabled={busy || !secret.trim()}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      <div className="vault-unlock-row">
        <label className="vault-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember on this device</label>
        <button type="button" className="vault-link" onClick={() => { setRecovery(r => !r); setSecret(''); setError(''); }}>
          {recovery ? 'Use passphrase' : 'Use recovery key'}
        </button>
      </div>
      {error && <div className="st-error">{error}</div>}
    </form>
  );
}

/** Over Investments while the vault is locked (or a friend's can't be opened yet). */
export function VaultGate({ onUnlocked }) {
  const v = useVault();
  if (v.state !== 'on' || v.open || v.reason === 'opening') return null;
  return (
    <div className="vault-gate">
      <div className="vault-gate-card">
        <div className="vault-gate-icon">🔒</div>
        {v.reason === 'no-keys' && (
          <>
            <h3>Private</h3>
            <p>{v.owner} keeps Investments in a private vault. Turn on your own vault in Settings › Investments, and it opens for you next time they use the app.</p>
          </>
        )}
        {v.reason === 'no-grant' && (
          <>
            <h3>Almost there</h3>
            <p>It opens for you next time {v.owner} uses the app.</p>
          </>
        )}
        {v.reason === 'locked' && (
          <>
            <h3>Your investments are locked</h3>
            <p>{v.viewing ? `Unlock your own vault to open ${v.owner}'s.` : 'Enter your passphrase to open them on this device.'}</p>
            <UnlockForm onDone={onUnlocked} />
          </>
        )}
      </div>
    </div>
  );
}

// ── In Settings ─────────────────────────────────────────────────────────────

function HowItWorks() {
  return (
    <details className="vault-how">
      <summary>How it works</summary>
      <ul>
        <li>Your passphrase never leaves your device. It unlocks a key that encrypts your investments before they're saved.</li>
        <li>The server keeps only scrambled data: nobody running it, the admin included, can read it.</li>
        <li>Prices are looked up by stock and fund name, never with your amounts. A Kite sync or a CAS import passes through the server once and isn't kept.</li>
        <li>Friends you share Investments with get their own copy of the key once they turn on their vault.</li>
        <li>Forgot the passphrase? Your recovery key opens it. Lose both, and nobody can get them back.</li>
      </ul>
    </details>
  );
}

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function RecoveryKeyBox({ code, email }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="vault-recovery">
      <code>{code}</code>
      <div className="vault-recovery-actions">
        <button type="button" className="action-btn secondary" onClick={() => navigator.clipboard?.writeText(code).then(() => setCopied(true))}>
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
        <button
          type="button" className="action-btn secondary"
          onClick={() => download('DailyTrack recovery key.txt',
            `DailyTrack private vault: recovery key for ${email}\n\n${code}\n\nIt opens your investments if you forget your passphrase. Keep it somewhere safe.\n`)}
        >
          Download
        </button>
      </div>
    </div>
  );
}

/** Turning the vault on: passphrase, recovery key, then the move. */
function TurnOnModal({ email, hasKeys, onClose, onDone }) {
  const [step, setStep] = useState(1);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [shown, setShown] = useState(false);
  const [remember, setRemember] = useState(true);
  const [code] = useState(newRecoveryKey);
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const busy = !!progress;

  const tooShort = normalizePassphrase(pass).length < MIN_PASSPHRASE;
  const mismatch = !hasKeys && again && normalizePassphrase(again) !== normalizePassphrase(pass);
  const canNext = !tooShort && (hasKeys || normalizePassphrase(again) === normalizePassphrase(pass));

  const startOver = async () => {
    try {
      await vault.startOver();
      setPass('');
      setAgain('');
    } catch (e) {
      setError(e.message);
    }
  };

  const suggest = () => {
    const p = suggestPassphrase();
    setPass(p);
    setAgain(p);
    setShown(true);
  };

  const go = async () => {
    setError('');
    setProgress('Starting…');
    try {
      await vault.turnOn({ passphrase: pass, recoveryKey: code, remember, progress: setProgress });
      onDone();
    } catch (e) {
      setError(`${e.message} Your investments weren't changed.`);
      setProgress('');
    }
  };

  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-content st-modal vault-modal" role="dialog" aria-modal="true" aria-labelledby="vault-on-title">
        <div className="modal-header">
          <div>
            <div className="modal-title" id="vault-on-title">🔒 Private vault</div>
            <div className="st-modal-sub">Only you can read your investments; not even the app's admin.</div>
          </div>
          {!busy && <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>}
        </div>

        <div className="st-modal-body">
          {step === 1 && (
            <>
              <label className="st-field">
                <span className="st-label">{hasKeys ? 'Your vault passphrase' : 'Passphrase'}</span>
                <span className={`st-input-wrap ${pass && tooShort ? 'invalid' : ''}`}>
                  <input type={shown ? 'text' : 'password'} value={pass} onChange={e => setPass(e.target.value)} autoFocus autoComplete="new-password" />
                  <button type="button" className="vault-link" onClick={() => setShown(s => !s)}>{shown ? 'Hide' : 'Show'}</button>
                </span>
                <span className={`st-hint ${pass && tooShort ? 'error' : ''}`}>
                  {hasKeys ? 'The one you picked when you set it up before.' : `At least ${MIN_PASSPHRASE} characters. A few words is easier to remember than symbols.`}
                  {!hasKeys && <> <button type="button" className="vault-link" onClick={suggest}>Suggest one</button></>}
                  {hasKeys && <> <button type="button" className="vault-link" onClick={startOver}>Forgot it? Start over</button></>}
                </span>
              </label>
              {!hasKeys && (
                <label className="st-field">
                  <span className="st-label">Once more</span>
                  <span className={`st-input-wrap ${mismatch ? 'invalid' : ''}`}>
                    <input type={shown ? 'text' : 'password'} value={again} onChange={e => setAgain(e.target.value)} autoComplete="new-password" />
                  </span>
                  {mismatch && <span className="st-hint error">They don't match</span>}
                </label>
              )}
              <label className="vault-check"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember on this device</label>
            </>
          )}

          {step === 2 && (
            <>
              <p className="st-note">
                Your <b>recovery key</b>. It opens your investments if you forget the passphrase. Save it somewhere safe,
                away from this device: without it and your passphrase, nobody can get them back.
              </p>
              <RecoveryKeyBox code={code} email={email} />
              <label className="vault-check"><input type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)} disabled={busy} /> I've saved my recovery key</label>
              {busy && <div className="vault-progress"><span className="vault-spinner" aria-hidden="true" />{progress}</div>}
              {!busy && !error && (
                <p className="st-hint">Your investments are copied into the vault and checked. Only then is the readable copy removed.</p>
              )}
            </>
          )}
          {error && <div className="st-error">{error}</div>}
        </div>

        <div className="st-modal-foot">
          {step === 1 && (
            <>
              <button type="button" className="action-btn secondary" onClick={onClose}>Cancel</button>
              <button type="button" className="action-btn" disabled={!canNext} onClick={() => (hasKeys ? go() : setStep(2))}>
                {hasKeys ? 'Lock my investments' : 'Next'}
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <button type="button" className="action-btn secondary" onClick={() => setStep(1)} disabled={busy}>Back</button>
              <button type="button" className="action-btn" disabled={!saved || busy} onClick={go}>
                {busy ? 'Locking…' : 'Lock my investments'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** A new passphrase, or a new recovery key: same vault, nothing locked again. */
function KeyModal({ kind, email, onClose, onToast }) {
  const [pass, setPass] = useState('');
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      if (kind === 'passphrase') {
        await vault.changePassphrase(pass);
        onToast('✅ Passphrase changed');
        onClose();
      } else {
        setCode(await vault.newRecoveryKey());
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const tooShort = normalizePassphrase(pass).length < MIN_PASSPHRASE;
  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-content st-modal vault-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="modal-title">{kind === 'passphrase' ? 'New passphrase' : 'New recovery key'}</div>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="st-modal-body">
          {kind === 'passphrase' && (
            <label className="st-field">
              <span className="st-label">New passphrase</span>
              <span className="st-input-wrap"><input type="text" value={pass} onChange={e => setPass(e.target.value)} autoFocus autoComplete="new-password" /></span>
              <span className="st-hint">At least {MIN_PASSPHRASE} characters. <button type="button" className="vault-link" onClick={() => setPass(suggestPassphrase())}>Suggest one</button></span>
            </label>
          )}
          {kind === 'recovery' && !code && <p className="st-note">Your old recovery key stops working, and this one takes its place.</p>}
          {code && <RecoveryKeyBox code={code} email={email} />}
          {error && <div className="st-error">{error}</div>}
        </div>
        <div className="st-modal-foot">
          {code ? (
            <button type="button" className="action-btn" onClick={onClose}>I've saved it</button>
          ) : (
            <>
              <button type="button" className="action-btn secondary" onClick={onClose} disabled={busy}>Cancel</button>
              <button type="button" className="action-btn" onClick={save} disabled={busy || (kind === 'passphrase' && tooShort)}>
                {busy ? 'Saving…' : kind === 'passphrase' ? 'Change' : 'Make a new one'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

/** Settings › Investments: the vault's rows. */
export function VaultSettings({ Row, onRefresh, onToast }) {
  const v = useVault();
  const [modal, setModal] = useState(null);   // 'on' | 'passphrase' | 'recovery'
  const [friends, setFriends] = useState(null);
  const [busy, setBusy] = useState('');

  useEffect(() => {
    if (v.state === 'on' && v.open && !v.viewing) vault.syncGrants().then(setFriends).catch(() => setFriends(null));
  }, [v.state, v.open, v.viewing]);

  if (v.state === 'unknown') return <Row icon="🔒" title="Private vault" desc="Checking…" />;

  const turnOff = async () => {
    if (!window.confirm('Turn off encryption? Your investments are decrypted and stored readable on the server again, for every device. You can turn it on again any time.')) return;
    setBusy('Putting them back…');
    try {
      await vault.turnOff({ progress: setBusy });
      onToast('Private vault off');
      onRefresh();
    } catch (e) {
      onToast(`Couldn't turn it off: ${e.message}`);
    } finally {
      setBusy('');
    }
  };

  const lock = async () => {
    await vault.lockNow();
    onToast('🔒 Locked on this device');
    onRefresh();
  };

  return (
    <>
      {v.state !== 'on' ? (
        <Row
          icon="🔒" title="Private vault"
          desc={v.moving ? 'Moving your investments in…' : 'Lock your investments with a passphrase only you know. Not even the app’s admin can read them.'}
        >
          <button className="action-btn" onClick={() => setModal('on')} disabled={v.moving}>Turn on</button>
        </Row>
      ) : v.open ? (
        <Row icon="🔒" title="Private vault" desc="On. Your investments are encrypted; only your devices can read them."
             status={busy ? { text: busy } : { kind: 'ok', text: 'Unlocked on this device' }} />
      ) : v.reason === 'opening' ? (
        <Row icon="🔒" title="Private vault" desc="On." status={{ text: 'Opening…' }} />
      ) : (
        <Row icon="🔒" title="Private vault" desc="On, and locked on this device.">
          <UnlockForm compact onDone={onRefresh} />
        </Row>
      )}

      {v.state === 'on' && v.open && (
        <>
          <Row icon="🔑" title="Passphrase" desc="Change it any time; nothing is locked again.">
            <button className="action-btn secondary" onClick={() => setModal('passphrase')}>Change</button>
          </Row>
          <Row icon="🧾" title="Recovery key" desc="Opens the vault if you forget the passphrase.">
            <button className="action-btn secondary" onClick={() => setModal('recovery')}>New key</button>
          </Row>
          {friends && friends.length > 0 && (
            <Row
              icon="🤝" title="Friends"
              desc={friends.map(f => `${f.viewer}: ${f.granted ? 'can open it' : 'once they turn on their vault'}`).join(' · ')}
            />
          )}
          <Row icon="🔐" title="Lock this device" desc="They stay encrypted. This device asks for the passphrase next time.">
            <button className="action-btn secondary" onClick={lock} disabled={!!busy}>Lock</button>
          </Row>
          <Row icon="🔓" title="Turn off encryption" desc="Decrypts your investments and stores them readable on the server again, for every device.">
            <button className="action-btn secondary" onClick={turnOff} disabled={!!busy}>Turn off</button>
          </Row>
        </>
      )}
      <div className="vault-how-row"><HowItWorks /></div>

      {modal === 'on' && (
        <TurnOnModal
          email={v.email} hasKeys={v.hasKeys}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); onToast('🔒 Your investments are in your private vault'); onRefresh(); }}
        />
      )}
      {(modal === 'passphrase' || modal === 'recovery') && (
        <KeyModal kind={modal} email={v.email} onClose={() => setModal(null)} onToast={onToast} />
      )}
    </>
  );
}
