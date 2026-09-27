import { useEffect, useState } from 'react';
import { EmojiBadge, MixRing } from './RoutineParts';
import { fetchSummary, percent, scoreMix, trendPoints, verdict } from './routines';

/** Routines at a glance on Home: consistency leads, today's count under it. Opens the Routines tab. */
export default function RoutinesHomeCard({ onOpen, dataVersion }) {
  const [summary, setSummary] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    fetchSummary()
      .then(res => { if (live) { if (res.success === false) setFailed(true); else { setSummary(res); setFailed(false); } } })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [dataVersion]);

  if (failed) return null;

  const active = summary?.routines.filter(r => !r.archived) || [];
  const byId = Object.fromEntries(active.map(r => [r.id, r]));
  const open = summary?.items.filter(i => i.needs_answer) || [];
  const stats = summary?.stats;
  const scored = summary?.consistency.fraction != null;
  const trend = summary ? trendPoints(summary.consistency, summary.previous_consistency) : null;
  const streak = summary?.perfect_days.current || 0;

  let today = 'Loading…';
  if (summary && active.length === 0) today = 'Add a habit, a challenge or a chore';
  else if (summary && stats.total === 0 && open.length === 0) today = 'Nothing due today';
  else if (summary) {
    today = open.length > 0 ? `${stats.done} of ${stats.total} done today · ${open.length} left`
      : stats.missed === 0 ? 'All done today 🎉' : 'All answered today';
  }

  return (
    <button className="rt-home-card" onClick={onOpen}>
      <MixRing mix={scoreMix(summary?.consistency)} size={88} stroke={7}>
        {summary && active.length > 0
          ? <><span className="rt-home-count">{percent(summary.consistency)}</span><span className="rt-home-caption">30 days</span></>
          : <span style={{ fontSize: '1.6rem' }}>🌱</span>}
      </MixRing>
      <span className="rt-home-text">
        <span className="rt-home-title">
          {scored ? <>Routines · {verdict(summary.consistency)}</> : 'Routines'}
        </span>
        <span className="rt-home-sub">{today}</span>
        {summary && active.length > 0 && (trend != null || streak > 0) && (
          <span className="rt-home-chips">
            {trend != null && trend !== 0 && (
              <span className={trend > 0 ? 'up' : 'down'}>{trend > 0 ? `▲ ${trend}%` : `▼ ${-trend}%`} vs previous 30 days</span>
            )}
            {streak > 0 && <span>🔥 {streak} perfect {streak === 1 ? 'day' : 'days'}</span>}
          </span>
        )}
      </span>
      {open.length > 0 && (
        <span className="rt-home-open" aria-label="Still to answer">
          {open.slice(0, 4).map(i => <EmojiBadge key={i.routine_id} routine={byId[i.routine_id]} size={30} />)}
          {open.length > 4 && <span className="rt-home-more">+{open.length - 4}</span>}
        </span>
      )}
    </button>
  );
}
