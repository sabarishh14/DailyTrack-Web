import { useCallback, useEffect, useRef, useState } from 'react';
import { AnswerButtons, ItemRow, Modal } from './RoutineParts';
import {
  addDays, dayMonth, fetchDay, fetchDetail, longDate, monthGrid, monthLabel, monthOf,
  parseDay, percent, saveAnswer, shiftMonth, shortDate, streakLength,
} from './routines';

/** Loads with `fetcher(key)`, dropping answers to requests that were overtaken. */
function useLoader(fetcher, key) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const latest = useRef(0);
  const load = useCallback(async () => {
    const id = ++latest.current;
    try {
      const res = await fetcher(key);
      if (id !== latest.current) return;
      if (res.success === false) setError(res.message || "Couldn't load this");
      else { setData(res); setError(''); }
    } catch {
      if (id === latest.current) setError("Couldn't reach the server");
    }
  }, [fetcher, key]);
  useEffect(() => { load(); }, [load]);
  return { data, setData, error, setError, load };
}

/** One day's list, to look back at or fill in. */
export function DayModal({ date, today, unfilled = [], routinesById, onClose, onChanged, onOpenRoutine }) {
  const [day, setDay] = useState(date);
  const { data, setData, error, setError, load } = useLoader(fetchDay, day);
  const [saving, setSaving] = useState(false);
  const shown = data?.date === day ? data : null;

  const answer = async (item, status, note) => {
    setData(d => ({ ...d, items: d.items.map(i => (i.routine_id === item.routine_id ? { ...i, status, note } : i)) }));
    setSaving(true);
    try {
      await saveAnswer(item.routine_id, day, status, note);
    } catch (e) {
      setError(`Couldn't save: ${e.message}`);
    }
    setSaving(false);
    load();
    onChanged();
  };

  const stats = shown?.stats;
  // Once this day has nothing left open, on to the next blank one.
  const next = unfilled.find(d => d !== day);
  const filled = shown && !shown.items.some(i => i.required && !i.status);
  return (
    <Modal
      title={longDate(day, today)}
      subtitle={day === today || day === addDays(today, -1) ? `${dayMonth(day)} ${parseDay(day).getFullYear()}` : String(parseDay(day).getFullYear())}
      onClose={onClose}
      headerExtra={(
        <>
          <button className="rt-icon-btn" onClick={() => setDay(addDays(day, -1))} aria-label="Previous day">‹</button>
          <button className="rt-icon-btn" onClick={() => setDay(addDays(day, 1))} disabled={day >= today} aria-label="Next day">›</button>
        </>
      )}
    >
      {error && <div className="rt-error">{error}</div>}
      {!shown && !error && <div className="rt-muted rt-pad">Loading…</div>}
      {shown && (
        <>
          {stats && stats.total > 0 && (
            <div className="rt-day-summary">
              <b>{stats.done}</b> of {stats.total} done
              {stats.missed > 0 && <> · {stats.missed} missed</>}
              {stats.skipped > 0 && <> · {stats.skipped} skipped</>}
              {day < today && (stats.blank ?? stats.unanswered) > 0 && (
                <> · {stats.blank ?? stats.unanswered} not filled in{stats.unanswered > 0 ? ', counted as missed' : ''}</>
              )}
            </div>
          )}
          {shown.items.length === 0
            ? <div className="rt-muted rt-pad">Nothing was due {day === today ? 'today' : 'that day'}.</div>
            : (
              <div className="rt-list">
                {shown.items.map(item => (
                  <ItemRow
                    key={item.routine_id}
                    item={item}
                    routine={routinesById[item.routine_id]}
                    onAnswer={(status, note) => answer(item, status, note)}
                    onOpen={() => onOpenRoutine(item.routine_id)}
                    disabled={saving}
                  />
                ))}
              </div>
            )}
          {next && filled && (
            <button className="action-btn rt-fill-next" onClick={() => setDay(next)}>
              Next: {shortDate(next, today)} →
            </button>
          )}
        </>
      )}
    </Modal>
  );
}

const ANSWERED = { done: 'Done ❤️', missed: 'Missed 😭', skipped: 'Skipped ⏭️' };

/** How the picked day went, plus its progress or due line where there is one. */
const pickedText = (d, today, schedule) => {
  if (!d?.routine_id) return 'Not due that day';
  const how = ANSWERED[d.status] || (d.date < today && d.required ? 'Left blank, counted as missed' : 'Not answered yet');
  return schedule === 'daily' || schedule === 'days' || !d.line ? how : `${how} · ${d.line}`;
};

const dayClass = (d, today) => {
  if (!d.routine_id) return 'off';
  if (d.status) return d.status;
  if (d.date < today && d.required) return 'blank';
  return 'open';
};

/** One routine's own page: its scores, a month of its days, and its skips. */
export function RoutineModal({ id, today, onClose, onChanged, onEdit }) {
  const [month, setMonth] = useState(monthOf(today));
  const key = `${id}|${month}`;
  const fetcher = useCallback((k) => { const [rid, m] = k.split('|'); return fetchDetail(rid, m); }, []);
  const { data, setData, error, setError, load } = useLoader(fetcher, key);
  const [selected, setSelected] = useState(today);
  const [saving, setSaving] = useState(false);
  const shown = data?.month === month && data?.routine?.id === id ? data : null;
  const byDate = Object.fromEntries((shown?.days || []).map(d => [d.date, d]));
  const picked = selected && byDate[selected];

  const answer = async (status, note) => {
    setData(d => ({ ...d, days: d.days.map(x => (x.date === selected ? { ...x, status, note } : x)) }));
    setSaving(true);
    try {
      await saveAnswer(id, selected, status, note);
    } catch (e) {
      setError(`Couldn't save: ${e.message}`);
    }
    setSaving(false);
    load();
    onChanged();
  };

  const r = shown?.routine;
  const createdMonth = r ? monthOf(r.start_date) : month;
  return (
    <Modal
      title={r ? `${r.emoji ? `${r.emoji} ` : ''}${r.name}` : 'Routine'}
      subtitle={r?.line}
      onClose={onClose}
      headerExtra={onEdit && <button className="rt-add" onClick={onEdit}>✏️ Edit</button>}
    >
      {error && <div className="rt-error">{error}</div>}
      {!shown && !error && <div className="rt-muted rt-pad">Loading…</div>}
      {shown && (
        <>
          <div className="rt-stats">
            <div className="rt-stat">
              <span className="rt-stat-value">🔥 {shown.streak.current}</span>
              <span className="rt-stat-label">Current streak · {streakLength(shown.streak.current, shown.streak.unit)}</span>
            </div>
            <div className="rt-stat">
              <span className="rt-stat-value">🏆 {shown.streak.best}</span>
              <span className="rt-stat-label">Best streak</span>
            </div>
            <div className="rt-stat">
              <span className="rt-stat-value">{percent(shown.consistency)}</span>
              <span className="rt-stat-label">Last 30 days</span>
            </div>
            <div className="rt-stat">
              <span className="rt-stat-value">{percent(shown.all_time)}</span>
              <span className="rt-stat-label">All time · {shown.done_count} done</span>
            </div>
          </div>

          <div className="rt-facts">
            <span>🗓️ {r.schedule_text}</span>
            {shown.progress && (
              <span>
                {shown.progress.met && shown.progress.needed > 0
                  ? `✅ Done for this ${shown.progress.unit}`
                  : `🎯 ${shown.progress.done} of ${shown.progress.needed} this ${shown.progress.unit}`}
              </span>
            )}
            {shown.next_due && <span>⏳ Due {dayMonth(shown.next_due)}</span>}
            {shown.last_done && <span>❤️ Last done {shown.last_done === today ? 'today' : longDate(shown.last_done, today) === 'Yesterday' ? 'yesterday' : dayMonth(shown.last_done)}</span>}
          </div>

          <div className="rt-history-head">
            <button className="rt-icon-btn" disabled={month <= createdMonth} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
            <span>{monthLabel(month)}</span>
            <button className="rt-icon-btn" disabled={month >= monthOf(today)} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
          </div>
          <div className="rt-cal rt-cal-status">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="rt-cal-dow">{d}</span>)}
            {monthGrid(month).map((iso, i) => {
              if (!iso) return <span key={i} />;
              const d = byDate[iso];
              const kind = d ? dayClass(d, today) : 'off';
              return (
                <button
                  key={i}
                  className={`rt-dot ${kind} ${iso === today ? 'today' : ''} ${iso === selected ? 'selected' : ''}`}
                  disabled={iso > today || !d}
                  onClick={() => setSelected(iso)}
                >
                  {parseDay(iso).getDate()}
                </button>
              );
            })}
          </div>

          {selected && monthOf(selected) === month && (
            <div className="rt-picked">
              <div className="rt-picked-text">
                <b>{longDate(selected, today)}</b>
                <span>
                  {pickedText(picked, today, r.schedule)}
                  {picked?.note && <em> · “{picked.note}”</em>}
                </span>
              </div>
              {picked?.routine_id && (
                <AnswerButtons key={selected} item={picked} onAnswer={answer} disabled={saving} />
              )}
            </div>
          )}

          {shown.skips.length > 0 && (
            <div className="rt-skips">
              <div className="rt-subhead">Skips</div>
              {shown.skips.map(s => (
                <div key={s.date} className="rt-skip">
                  <span>{dayMonth(s.date)}</span>
                  <span className="rt-muted">{s.note || 'No reason given'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
