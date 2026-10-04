import { useEffect, useRef, useState } from 'react';
import { WEEKDAYS_LONG, peakIndex, plural, starsLabel, weekLabel } from './statsFormat';

// ═══════════════════════════════════════════════════════════════════════
// Charts shared by the movie and TV stats sections. Every bar opens the
// Library filtered to exactly what it counted.
// ═══════════════════════════════════════════════════════════════════════

const RATING_KEYS = ['0.5', '1.0', '1.5', '2.0', '2.5', '3.0', '3.5', '4.0', '4.5', '5.0'];
const DAY_INITIALS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up when it first shows, and eases to the new value when it changes (another year). */
export function CountUp({ value, decimals = 0 }) {
  const [shown, setShown] = useState(() => (reducedMotion() ? value : 0));
  const shownRef = useRef(shown);

  useEffect(() => {
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
    if (reducedMotion()) {
      shownRef.current = value;
      setShown(value);
      return undefined;
    }
    const from = shownRef.current || 0;
    const startedAt = performance.now();
    let frame;
    const tick = (now) => {
      const t = Math.min(1, (now - startedAt) / 900);
      const next = from + (value - from) * (1 - Math.pow(1 - t, 3));
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value]);

  if (typeof value !== 'number' || Number.isNaN(value)) return <>{value ?? '—'}</>;
  return <>{decimals > 0 ? shown.toFixed(decimals) : Math.round(shown).toLocaleString('en-IN')}</>;
}

/** Bar entrance: grows from the baseline, a few milliseconds after its neighbour. */
const growStyle = (index, step) => ({ '--grow-delay': `${index * step}ms` });

/**
 * All 52 weeks, Letterboxd style. Hovering a week names its dates in the
 * header; clicking opens the Library on that week.
 */
export function WeekChart({ byWeek, year, one, many, onOpenWeek }) {
  const [hovered, setHovered] = useState(null);
  const weeks = (byWeek || []).slice(0, 52);
  const max = Math.max(...weeks, 1);
  const peak = peakIndex(weeks);
  const shownWeek = hovered ?? (peak >= 0 ? peak : null);

  return (
    <div className="stats-section">
      <div className="stats-section-header">
        <span className="stats-section-title">📈 By Week</span>
        {shownWeek != null && (
          <span className={`stats-section-hint keep ${hovered != null ? 'is-live' : ''}`}>
            {hovered == null && 'Busiest: '}
            {weekLabel(year, shownWeek + 1)} · {plural(weeks[shownWeek], one, many)}
          </span>
        )}
      </div>
      <div className="stats-week-chart">
        <div className="stats-week-bars" onMouseLeave={() => setHovered(null)}>
          {weeks.map((count, i) => {
            const clickable = onOpenWeek && count > 0;
            return (
              <div
                key={i}
                className={`stats-week-bar stats-grow ${i === peak ? 'is-peak' : ''} ${clickable ? 'is-clickable' : ''}`}
                style={{ height: count > 0 ? `${Math.max(4, (count / max) * 100)}%` : '0', ...growStyle(i, 8) }}
                data-count={`${weekLabel(year, i + 1)} · ${plural(count, one, many)}`}
                onMouseEnter={() => setHovered(i)}
                onClick={() => clickable && onOpenWeek(i + 1)}
              />
            );
          })}
        </div>
        <div className="stats-week-labels">
          <span>Jan</span><span>Apr</span><span>Jul</span><span>Oct</span><span>Dec</span>
        </div>
      </div>
    </div>
  );
}

/** Monday to Sunday; clicking a day opens the Library on everything watched on that weekday. */
export function DayChart({ byDay, one, many, onOpenDay }) {
  const days = byDay || [];
  const max = Math.max(...days, 1);
  const peak = peakIndex(days);
  return (
    <div>
      <div className="stats-section-header">
        <span className="stats-section-title">📅 By Day</span>
        {peak >= 0 && <span className="stats-section-hint">Busiest: {WEEKDAYS_LONG[peak]}</span>}
      </div>
      <div className="stats-day-chart">
        {days.map((count, i) => {
          const clickable = onOpenDay && count > 0;
          return (
            <div
              key={i}
              className={`stats-day-bar-wrap ${clickable ? 'is-clickable' : ''}`}
              onClick={() => clickable && onOpenDay(i)}
              title={clickable ? `See what you watched on ${WEEKDAYS_LONG[i]}s` : undefined}
            >
              <div
                className={`stats-day-bar stats-grow ${i >= 5 ? 'weekend' : ''} ${i === peak ? 'is-peak' : ''}`}
                style={{ height: count > 0 ? `${Math.max(4, (count / max) * 80)}px` : '4px', ...growStyle(i, 40) }}
                data-count={`${WEEKDAYS_LONG[i]}: ${plural(count, one, many)}`}
              />
              <span className="stats-day-label">{DAY_INITIALS[i]}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Letterboxd's half-star histogram; clicking a bar opens the Library on what got that rating. */
export function RatingChart({ distribution, onOpenRating }) {
  const values = RATING_KEYS.map(k => distribution?.[k] || distribution?.[String(parseFloat(k))] || 0);
  const max = Math.max(...values, 1);
  const total = values.reduce((a, b) => a + b, 0);
  const average = total > 0 ? values.reduce((sum, n, i) => sum + n * (i + 1) * 0.5, 0) / total : null;
  return (
    <div>
      <div className="stats-section-header">
        <span className="stats-section-title">⭐ Ratings</span>
        {average != null && (
          <span className="stats-section-hint">★ {average.toFixed(1)} avg · {plural(total, 'rating', 'ratings')}</span>
        )}
      </div>
      <div className="stats-rating-chart">
        {RATING_KEYS.map((k, i) => {
          const clickable = onOpenRating && values[i] > 0;
          return (
            <div
              key={k}
              className={`stats-rating-bar-wrap ${clickable ? 'is-clickable' : ''}`}
              onClick={() => clickable && onOpenRating(k)}
              title={clickable ? `See what you rated ${starsLabel(k)}` : undefined}
            >
              <div
                className="stats-rating-bar stats-grow"
                style={{ height: values[i] > 0 ? `${Math.max(4, (values[i] / max) * 80)}px` : '4px', ...growStyle(i, 30) }}
                data-count={`${starsLabel(k)} · ${values[i]}`}
              />
              <span className="stats-rating-label">{k.replace('.0', '').replace('.5', '½')}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
