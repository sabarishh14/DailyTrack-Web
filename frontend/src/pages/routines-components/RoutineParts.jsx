import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CHOICES, COLORS, SKIP_REASONS, dayMonth, mix, mixTotal, monthGrid, monthLabel, monthOf, parseDay, shiftMonth } from './routines';
import { useAccess } from '../../access/AccessContext';

/** A thin ring split into done, skipped and missed, over a track for what's still open. */
export function MixRing({ mix: m, size = 44, stroke = 4, children }) {
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const all = mixTotal(m);
  let offset = 0;
  const arcs = all === 0 ? [] : ['done', 'skipped', 'missed'].filter(k => m[k] > 0).map(k => {
    const length = (circumference * m[k]) / all;
    const arc = { key: k, length, offset };
    offset += length;
    return arc;
  });
  const c = size / 2;
  return (
    <div className="rt-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--rt-track)" strokeWidth={stroke} />
        {arcs.map(a => (
          <circle
            key={a.key} cx={c} cy={c} r={r} fill="none"
            stroke={COLORS[a.key]} strokeWidth={stroke}
            strokeDasharray={`${a.length} ${circumference - a.length}`}
            strokeDashoffset={-a.offset}
            transform={`rotate(-90 ${c} ${c})`}
          />
        ))}
      </svg>
      {children != null && <div className="rt-ring-center">{children}</div>}
    </div>
  );
}

/** ● done ● skipped ● missed */
export function Legend() {
  return (
    <div className="rt-legend">
      {['done', 'skipped', 'missed'].map(k => (
        <span key={k}><i style={{ background: COLORS[k] }} />{k}</span>
      ))}
    </div>
  );
}

export function EmojiBadge({ routine, size = 40 }) {
  return (
    <span className={`rt-badge ${routine?.kind === 'avoid' ? 'avoid' : ''}`} style={{ width: size, height: size, fontSize: size * 0.5 }}>
      {routine?.emoji || (routine?.name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

const describe = (stats) => {
  if (!stats || stats.total === 0) return 'Nothing due';
  const parts = [`${stats.done} of ${stats.total} done`];
  if (stats.missed) parts.push(`${stats.missed} missed`);
  if (stats.skipped) parts.push(`${stats.skipped} skipped`);
  return parts.join(', ');
};

/** Monday to Sunday, each day a bar split by how it went. */
export function WeekBars({ week, today, onDay }) {
  const letters = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  return (
    <div className="rt-week">
      {week.map((stats, i) => {
        const m = mix(stats, today);
        const all = mixTotal(m);
        const isToday = stats?.date === today;
        return (
          <button
            key={i}
            className={`rt-week-day ${isToday ? 'today' : ''}`}
            disabled={!stats}
            onClick={() => stats && onDay(stats.date)}
            title={stats ? `${dayMonth(stats.date)}: ${describe(stats)}` : undefined}
          >
            <span className="rt-week-count">{stats && stats.total > 0 ? `${stats.done}/${stats.total}` : ''}</span>
            <span className="rt-bar">
              {all > 0 && ['done', 'skipped', 'missed'].map(k => m[k] > 0 && (
                <span key={k} style={{ height: `${(m[k] / all) * 100}%`, background: COLORS[k] }} />
              ))}
            </span>
            <span className="rt-week-letter">{letters[i]}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A month of days, each a small ring of how it went. */
export function HistoryCalendar({ month, history, today, firstDay, onMonth, onDay }) {
  const byDate = Object.fromEntries((history || []).map(s => [s.date, s]));
  const canBack = firstDay && month > monthOf(firstDay);
  const canForward = month < monthOf(today);
  return (
    <div className="rt-history">
      <div className="rt-history-head">
        <button className="rt-icon-btn" disabled={!canBack} onClick={() => onMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
        <span>{monthLabel(month)}</span>
        <button className="rt-icon-btn" disabled={!canForward} onClick={() => onMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
      </div>
      <div className="rt-cal">
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => <span key={i} className="rt-cal-dow">{d}</span>)}
        {monthGrid(month).map((iso, i) => {
          if (!iso) return <span key={i} />;
          const stats = byDate[iso];
          const m = mix(stats, today);
          const perfect = m && m.done > 0 && m.missed === 0 && m.open === 0;
          const future = iso > today;
          return (
            <button
              key={i}
              className={`rt-cal-day ${iso === today ? 'today' : ''} ${perfect ? 'perfect' : ''}`}
              disabled={future || !stats}
              onClick={() => onDay(iso)}
              title={stats ? `${dayMonth(iso)}: ${describe(stats)}` : undefined}
            >
              <MixRing mix={stats && stats.total > 0 ? m : null} size={34} stroke={3}>
                {parseDay(iso).getDate()}
              </MixRing>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** ❤️ 😭 ⏭️: picking the current answer again clears it. A skip asks why, optionally. */
export function AnswerButtons({ item, onAnswer, disabled }) {
  // Someone else's routines, shared with you: their answers show, but can't be changed.
  const viewing = !!useAccess().raw?.viewing;
  disabled = disabled || viewing;
  const [askingWhy, setAskingWhy] = useState(false);
  const [why, setWhy] = useState('');
  const pick = (status) => {
    if (item.status === status) return onAnswer(null);
    if (status === 'skipped') return setAskingWhy(true);
    onAnswer(status);
  };
  const skip = (note) => {
    setAskingWhy(false);
    setWhy('');
    onAnswer('skipped', note || null);
  };
  return (
    <>
      <div className="rt-answers" role="group" aria-label="Answer">
        {CHOICES.map(c => (
          <button
            key={c.status}
            className={`rt-answer ${item.status === c.status ? 'on' : ''} ${item.status && item.status !== c.status ? 'dim' : ''}`}
            style={{ '--rt-answer': COLORS[c.status] }}
            onClick={() => pick(c.status)}
            disabled={disabled}
            title={item.status === c.status ? `${c.label} (click to clear)` : c.label}
          >
            {c.emoji}
          </button>
        ))}
      </div>
      {askingWhy && (
        <div className="rt-why">
          <div className="rt-why-title">Why skip? <span>Skips don't count against you.</span></div>
          <div className="rt-why-chips">
            {SKIP_REASONS.map(r => <button key={r} className="rt-chip" onClick={() => skip(r)}>{r}</button>)}
          </div>
          <form className="rt-why-row" onSubmit={e => { e.preventDefault(); skip(why.trim()); }}>
            <input value={why} onChange={e => setWhy(e.target.value)} maxLength={120} placeholder="Or say why (optional)" autoFocus />
            <button type="submit" className="action-btn" style={{ padding: '0.5rem 1rem' }}>Skip</button>
            <button type="button" className="action-btn secondary" style={{ padding: '0.5rem 1rem' }} onClick={() => setAskingWhy(false)}>Cancel</button>
          </form>
        </div>
      )}
    </>
  );
}

/** One routine on a day's list, with its answer buttons. */
export function ItemRow({ item, routine, onAnswer, onOpen, disabled }) {
  return (
    <div className={`rt-item ${item.status ? 'answered' : ''}`}>
      <div className="rt-item-top">
        <button className="rt-item-main" onClick={onOpen} disabled={!onOpen}>
          <EmojiBadge routine={routine} />
          <span className="rt-item-text">
            <span className="rt-item-name">{routine?.name || 'Routine'}</span>
            <span className="rt-item-line">
              {item.line}
              {item.note && <em> · “{item.note}”</em>}
            </span>
          </span>
        </button>
        <AnswerButtons item={item} onAnswer={onAnswer} disabled={disabled} />
      </div>
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, headerExtra }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content rt-modal" role="dialog" aria-modal="true">
        <div className="modal-header">
          <div style={{ minWidth: 0 }}>
            <div className="modal-title">{title}</div>
            {subtitle && <div className="rt-modal-sub">{subtitle}</div>}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {headerExtra}
            <button className="modal-close" onClick={onClose} aria-label="Close">×</button>
          </div>
        </div>
        <div className="rt-modal-body">{children}</div>
      </div>
    </div>,
    document.body
  );
}
