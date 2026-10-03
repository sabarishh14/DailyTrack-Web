import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EmojiBadge, HistoryCalendar, ItemRow, Legend, MixRing, WeekBars } from './routines-components/RoutineParts';
import { DayModal, RoutineModal } from './routines-components/RoutineModals';
import RoutineEditor from './routines-components/RoutineEditor';
import { useAccess } from '../access/AccessContext';
import {
  addDays, dayMonth, fetchSummary, mix, percent, saveAnswer, scoreMix, trendPoints, verdict, weekday,
} from './routines-components/routines';

// Per-viewer conveniences only; the page works the same without them.
const readPref = (key, fallback) => {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
};
const writePref = (key, value) => {
  try { localStorage.setItem(key, value); } catch { /* storage blocked */ }
};

function RoutinesTab() {
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState(null);
  const [month, setMonth] = useState(null);
  const [historyOpen, setHistoryOpen] = useState(() => readPref('dt_routines_history', '0') === '1');
  const [showArchived, setShowArchived] = useState(false);
  const [openDay, setOpenDay] = useState(null);
  const [openRoutine, setOpenRoutine] = useState(null);
  // null, or { routine } to edit one (routine null to add a new one).
  const [editing, setEditing] = useState(null);
  // Viewing someone else's routines: everything shows, nothing changes.
  const viewing = !!useAccess().raw?.viewing;
  const [saving, setSaving] = useState(false);
  const latest = useRef(0);
  const monthRef = useRef(month);
  monthRef.current = month;

  const load = useCallback(async () => {
    const id = ++latest.current;
    try {
      const res = await fetchSummary(monthRef.current);
      if (id !== latest.current) return;
      if (res.success === false) setError(res.message || "Couldn't load your routines");
      else { setSummary(res); setError(''); }
    } catch {
      if (id === latest.current) setError("Couldn't reach the server");
    }
  }, []);

  useEffect(() => { load(); }, [load, month]);

  // Answers made on the phone show up when you come back to this tab.
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Confirmations fade on their own; errors stay until the next change.
  useEffect(() => {
    if (!toast || toast.error) return undefined;
    const timer = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const edited = (message) => {
    setEditing(null);
    setToast({ text: message });
    load();
  };

  const routinesById = useMemo(
    () => Object.fromEntries((summary?.routines || []).map(r => [r.id, r])),
    [summary]
  );

  const answer = async (item, status, note) => {
    setSummary(s => ({
      ...s,
      items: s.items.map(i => (i.routine_id === item.routine_id ? { ...i, status, note } : i)),
    }));
    setSaving(true);
    try {
      await saveAnswer(item.routine_id, item.date, status, note);
      setToast(t => (t?.error ? null : t));
    } catch (e) {
      setToast({ text: `Couldn't save that: ${e.message}`, error: true });
    }
    setSaving(false);
    load();
  };

  const toggleHistory = () => {
    setHistoryOpen(open => { writePref('dt_routines_history', open ? '0' : '1'); return !open; });
  };

  if (!summary) {
    return error
      ? <div className="rt-card rt-empty"><div className="rt-empty-icon">⚠️</div><div className="rt-empty-title">{error}</div><button className="action-btn secondary" onClick={load}>Try again</button></div>
      : <div className="rt-card rt-empty"><div className="rt-muted">Loading your routines…</div></div>;
  }

  const editor = editing && (
    <RoutineEditor
      routine={editing.routine}
      today={summary.today}
      onClose={() => setEditing(null)}
      onDone={edited}
      onChanged={load}
    />
  );
  const toastView = toast && (
    <div className={`rt-toast ${toast.error ? 'error' : ''}`} role="status" onClick={() => setToast(null)}>{toast.text}</div>
  );

  const { today, stats, items, upcoming, week, routines } = summary;
  const active = routines.filter(r => !r.archived);
  const archived = routines.filter(r => r.archived);

  if (active.length === 0) {
    return (
      <div className="rt-card rt-empty">
        <div className="rt-empty-icon">🌱</div>
        <div className="rt-empty-title">No routines yet</div>
        <div className="rt-muted">
          Habits to build, things to quit, challenges with a finish line and chores that come round again.
          Check in here or on the phone.
        </div>
        {!viewing && <button className="action-btn" style={{ marginTop: '0.75rem' }} onClick={() => setEditing({ routine: null })}>＋ Add a routine</button>}
        {archived.length > 0 && (
          <div className="rt-list rt-archived" style={{ marginTop: '1rem', width: '100%', maxWidth: 380 }}>
            {archived.map(r => (
              <button key={r.id} className="rt-row" onClick={() => !viewing && setEditing({ routine: r })}>
                <EmojiBadge routine={r} size={30} />
                <span className="rt-row-text">
                  <span className="rt-item-name">{r.name}</span>
                  <span className="rt-item-line">Archived · {r.schedule_text}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {editor}
        {toastView}
      </div>
    );
  }

  const left = items.filter(i => i.needs_answer).length;
  const hasDue = stats.total > 0;
  const todayLine = left > 0 ? `${left} left to answer`
    : !hasDue ? 'Nothing due today'
      : stats.missed === 0 ? 'All done 🎉' : 'All answered';
  const perfect = summary.perfect_days;
  const streakLine = perfect.best === 0 ? '🌱 Your first perfect day starts a streak'
    : perfect.current >= 2 ? `🔥 ${perfect.current}-day streak · best ${perfect.best}`
      : perfect.current === 1 ? `🔥 1 perfect day · best ${perfect.best}`
        : `Best streak: ${perfect.best} ${perfect.best === 1 ? 'day' : 'days'}`;
  const trend = trendPoints(summary.consistency, summary.previous_consistency);

  return (
    <>
      <div className="rt-grid">
        <div className="rt-col">
          {/* Consistency leads; today sits right under it. */}
          <section className="rt-card rt-hero">
            <div className="rt-hero-top">
              <MixRing mix={scoreMix(summary.consistency)} size={148} stroke={12}>
                <span className="rt-hero-count">{percent(summary.consistency)}</span>
                <span className="rt-hero-caption">30 days</span>
              </MixRing>
              <div className="rt-hero-text">
                <div className="rt-hero-date">Consistency</div>
                <div className="rt-hero-title">{verdict(summary.consistency)}</div>
                <div className="rt-muted">
                  {summary.consistency.fraction == null ? 'Shows up after your first day' : 'Over the last 30 days'}
                </div>
                {trend != null && (
                  <div className="rt-trend">
                    {trend > 0 && <b className="up">▲ {trend}%</b>}
                    {trend < 0 && <b className="down">▼ {-trend}%</b>}
                    {trend === 0 ? '= same as previous 30 days' : ' vs previous 30 days'}
                  </div>
                )}
                <span className="rt-streak-chip">{streakLine}</span>
              </div>
            </div>
            <div className="rt-today">
              {hasDue ? <MixRing mix={mix(stats, today)} size={34} stroke={4} /> : <span className="rt-today-icon">☀️</span>}
              <span className="rt-today-text">
                <b>Today · {weekday(today)}, {dayMonth(today)}</b>
                <span>{todayLine}</span>
              </span>
              <span className="rt-today-count">{hasDue ? <>{stats.done}<small>/{stats.total}</small></> : '—'}</span>
            </div>
          </section>

          <section className="rt-card">
            <div className="rt-card-head">
              <h3>Today</h3>
              {items.length > 0 && <span className="rt-muted">{left > 0 ? `${left} to answer` : 'All answered'}</span>}
            </div>
            {items.length === 0
              ? <div className="rt-muted rt-pad">Nothing's due today. Enjoy it.</div>
              : (
                <div className="rt-list">
                  {items.map(item => (
                    <ItemRow
                      key={item.routine_id}
                      item={item}
                      routine={routinesById[item.routine_id]}
                      onAnswer={(status, note) => answer(item, status, note)}
                      onOpen={() => setOpenRoutine(item.routine_id)}
                      disabled={saving}
                    />
                  ))}
                </div>
              )}
            <button className="rt-link" onClick={() => setOpenDay(addDays(today, -1))}>Fill in an earlier day →</button>
          </section>

          {upcoming.length > 0 && (
            <section className="rt-card">
              <div className="rt-card-head"><h3>Coming up</h3></div>
              <div className="rt-list">
                {upcoming.map(u => {
                  const r = routinesById[u.routine_id];
                  return (
                    <button key={`${u.routine_id}-${u.date}`} className="rt-row" onClick={() => setOpenRoutine(u.routine_id)}>
                      <EmojiBadge routine={r} size={34} />
                      <span className="rt-row-text"><span className="rt-item-name">{r?.name}</span></span>
                      <span className="rt-when">{u.when.charAt(0).toUpperCase() + u.when.slice(1)}</span>
                    </button>
                  );
                })}
              </div>
            </section>
          )}
        </div>

        <div className="rt-col">
          <section className="rt-card">
            <div className="rt-card-head">
              <h3>This week</h3>
              <Legend />
            </div>
            <WeekBars week={week} today={today} onDay={setOpenDay} />
            <button className="rt-link" onClick={toggleHistory} aria-expanded={historyOpen}>
              {historyOpen ? 'Hide history ▴' : 'Show history ▾'}
            </button>
            {historyOpen && (
              <HistoryCalendar
                month={summary.month}
                history={summary.history}
                today={today}
                firstDay={summary.first_day}
                onMonth={setMonth}
                onDay={setOpenDay}
              />
            )}
          </section>

          <section className="rt-card">
            <div className="rt-card-head">
              <h3>Your routines <span className="rt-count">{active.length}</span></h3>
              {!viewing && <button className="rt-add" onClick={() => setEditing({ routine: null })}>＋ Add</button>}
            </div>
            <div className="rt-list">
              {active.map(r => (
                <button key={r.id} className="rt-row" onClick={() => setOpenRoutine(r.id)}>
                  <EmojiBadge routine={r} size={38} />
                  <span className="rt-row-text">
                    <span className="rt-item-name">{r.name}</span>
                    <span className="rt-item-line">{r.line}</span>
                  </span>
                  <span className="rt-row-side">
                    {r.streak?.current >= 2 && <span className="rt-flame">🔥 {r.streak.current}</span>}
                    <span className="rt-pct" title="Last 30 days">{percent(r.consistency)}</span>
                  </span>
                </button>
              ))}
            </div>
            {archived.length > 0 && (
              <>
                <button className="rt-link" onClick={() => setShowArchived(s => !s)} aria-expanded={showArchived}>
                  {showArchived ? 'Hide archived ▴' : `Archived (${archived.length}) ▾`}
                </button>
                {showArchived && (
                  <div className="rt-list rt-archived">
                    {archived.map(r => (
                      <button key={r.id} className="rt-row" onClick={() => !viewing && setEditing({ routine: r })} title="Restore or delete">
                        <EmojiBadge routine={r} size={30} />
                        <span className="rt-row-text">
                          <span className="rt-item-name">{r.name}</span>
                          <span className="rt-item-line">{r.schedule_text}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>

      {openDay && (
        <DayModal
          date={openDay}
          today={today}
          routinesById={routinesById}
          onClose={() => setOpenDay(null)}
          onChanged={load}
          onOpenRoutine={(id) => { setOpenDay(null); setOpenRoutine(id); }}
        />
      )}
      {openRoutine && (
        <RoutineModal
          id={openRoutine}
          today={today}
          onClose={() => setOpenRoutine(null)}
          onChanged={load}
          onEdit={viewing ? undefined : () => { setEditing({ routine: routinesById[openRoutine] }); setOpenRoutine(null); }}
        />
      )}
      {editor}
      {toastView}
    </>
  );
}

export default memo(RoutinesTab);
