import { useEffect, useState } from 'react';
import { EmojiBadge, MixRing } from './RoutineParts';
import { fetchSummary, mix, percent } from './routines';

/** Today's routines at a glance on Home; opens the Routines tab. */
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

  let sub = 'Loading…';
  if (summary && active.length === 0) sub = 'Start one in the DailyTrack app';
  else if (summary && summary.items.length === 0) sub = 'Nothing due today';
  else if (summary) sub = open.length > 0 ? `${open.length} left for today` : stats.missed === 0 ? 'All done for today 🎉' : 'All answered for today';

  return (
    <button className="rt-home-card" onClick={onOpen}>
      <MixRing mix={summary && stats.total > 0 ? mix(stats, summary.today) : null} size={84} stroke={8}>
        {summary && active.length > 0
          ? <span className="rt-home-count">{stats.done}<small>/{stats.total}</small></span>
          : <span style={{ fontSize: '1.6rem' }}>🌱</span>}
      </MixRing>
      <span className="rt-home-text">
        <span className="rt-home-title">Routines</span>
        <span className="rt-home-sub">{sub}</span>
        {summary && active.length > 0 && (
          <span className="rt-home-chips">
            <span>📈 {percent(summary.consistency)} · 30 days</span>
            {summary.perfect_days.current > 0 && <span>🔥 {summary.perfect_days.current} perfect {summary.perfect_days.current === 1 ? 'day' : 'days'}</span>}
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
