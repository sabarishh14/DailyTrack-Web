import { CountUp, DayChart, RatingChart, WeekChart } from './StatsCharts';
import { MONTHS_LONG, peakIndex, plural } from './statsFormat';

// ═══════════════════════════════════════════════════════════════════════
// TV STATS — the TV counterpart to the movie sections in StatsView.
// Pure render: StatsView owns fetching, the year and the hero.
// ═══════════════════════════════════════════════════════════════════════

const TMDB_IMG = 'https://image.tmdb.org/t/p';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const shortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const renderStars = (rating) => {
  const stars = [];
  for (let i = 1; i <= 5; i++) {
    if (rating >= i) stars.push(<span key={i} className="star-filled">★</span>);
    else if (rating >= i - 0.5) stars.push(<span key={i} className="star-filled">½</span>);
  }
  return stars;
};

function PosterTile({ show, badge, caption, onOpen, children }) {
  return (
    <div className="stats-poster-item" onClick={() => onOpen(show)} style={{ cursor: 'pointer' }} title={show.name}>
      <div className="stats-poster-img-wrap">
        {show.poster_path ? (
          <img src={`${TMDB_IMG}/w342${show.poster_path}`} alt={show.name} loading="lazy" />
        ) : (
          <div className="stats-no-poster">📺</div>
        )}
        {badge != null && <div className="stats-poster-badge">{badge}</div>}
        <span className="stats-poster-hover-name">{show.name}</span>
      </div>
      {children}
      {caption && <div className="stats-poster-name">{caption}</div>}
    </div>
  );
}

function Section({ icon, title, hint, children }) {
  return (
    <div className="stats-section">
      <div className="stats-section-header">
        <span className="stats-section-title">{icon} {title}</span>
        {hint && <span className="stats-section-hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export default function TvStatsSections({ data, statsYear, openModal, onFilterLibrary }) {
  const d = data;
  const isCurrentYear = statsYear === 'all' || statsYear === String(new Date().getFullYear());

  const openShow = (s) => openModal({
    id: s.show_id, tmdb_id: s.tmdb_id, type: 'tv', name: s.name, poster_path: s.poster_path, status: s.status,
  });

  const hasActivity = d.total_entries > 0;
  const maxMonth = Math.max(...(d.by_month || []), 1);
  const peakMonth = peakIndex(d.by_month || []);
  const maxYear = Math.max(...(d.episodes_by_year || []).map(y => y.count), 1);
  // Every chart bar opens the Library on exactly what it counted.
  const filterTo = onFilterLibrary ? (slice) => onFilterLibrary({ year: statsYear, mediaType: 'tv', ...slice }) : null;
  const maxLanguage = Math.max(...(d.shows_by_language || []).map(l => l.count), 1);

  const highlights = [
    d.biggest_binge && {
      icon: '🍿', label: 'Biggest Binge', show: d.biggest_binge,
      title: d.biggest_binge.name,
      value: `${plural(d.biggest_binge.episodes, 'episode', 'episodes')} on ${shortDate(d.biggest_binge.date)}`,
    },
    d.longest_streak?.length > 0 && {
      icon: '🔥', label: 'Longest Streak',
      title: d.longest_streak.start === d.longest_streak.end ? d.longest_streak.start : `${d.longest_streak.start} – ${d.longest_streak.end}`,
      value: plural(d.longest_streak.length, 'day', 'days'),
    },
    d.seasons_watched > 0 && { icon: '🗂️', label: 'Seasons Touched', title: 'Across all shows', value: plural(d.seasons_watched, 'season', 'seasons') },
    d.total_reviews > 0 && { icon: '✍️', label: 'Reviews Written', title: 'Thoughts logged', value: plural(d.total_reviews, 'review', 'reviews') },
    d.total_rewatches > 0 && { icon: '🔁', label: 'Rewatches', title: 'Worth another look', value: plural(d.total_rewatches, 'rewatch', 'rewatches') },
  ].filter(Boolean);

  return (
    <>
      {/* ─── SUMMARY COUNTERS ─── */}
      <div className="stats-counters">
        <div className="stats-counter-card">
          <div className="stats-counter-value"><CountUp value={d.episodes_watched} /></div>
          <div className="stats-counter-label">Episodes</div>
        </div>
        <div className="stats-counter-card">
          <div className="stats-counter-value"><CountUp value={d.shows_watched} /></div>
          <div className="stats-counter-label">Shows</div>
        </div>
        <div className="stats-counter-card">
          <div className="stats-counter-value"><CountUp value={d.shows_completed} /></div>
          <div className="stats-counter-label">Completed</div>
        </div>
        <div className="stats-counter-card">
          <div className="stats-counter-value">
            {d.average_rating != null ? <>★ <CountUp value={d.average_rating} decimals={1} /></> : '—'}
          </div>
          <div className="stats-counter-label">Avg Rating</div>
        </div>
      </div>

      {/* ─── CURRENTLY WATCHING (a live snapshot, so only for this year / all time) ─── */}
      {isCurrentYear && d.in_progress?.length > 0 && (
        <Section icon="▶️" title="Currently Watching" hint="Episodes logged so far">
          <div className="stats-poster-grid">
            {d.in_progress.map(s => (
              <PosterTile
                key={s.show_id}
                show={s}
                badge={s.episodes_watched || null}
                caption={s.last_watched ? `Last ${shortDate(s.last_watched)}` : 'Not logged yet'}
                onOpen={openShow}
              />
            ))}
          </div>
        </Section>
      )}

      {!hasActivity ? (
        <div className="stats-empty">
          <span className="stats-empty-icon">📺</span>
          <span>No TV logged {statsYear === 'all' ? 'yet' : `in ${statsYear}`}.</span>
        </div>
      ) : (
        <>
          {/* ─── MOST WATCHED ─── */}
          {d.most_watched?.length > 0 && (
            <Section icon="📺" title="Most Watched Shows" hint="Whole-season logs count every episode">
              <div className="stats-poster-grid">
                {d.most_watched.map(s => (
                  <PosterTile
                    key={s.show_id}
                    show={s}
                    badge={s.episodes || null}
                    caption={s.episodes ? plural(s.episodes, 'episode', 'episodes') : plural(s.logs, 'log', 'logs')}
                    onOpen={openShow}
                  />
                ))}
              </div>
            </Section>
          )}

          {/* ─── HIGHEST RATED ─── */}
          {d.highest_rated?.length > 0 && (
            <Section icon="🏆" title="Highest Rated Shows" hint="Average of your ratings">
              <div className="stats-poster-grid">
                {d.highest_rated.map(s => (
                  <PosterTile key={s.show_id} show={s} onOpen={openShow}>
                    <div className="stats-poster-rating" title={`${s.rating} from ${plural(s.ratings_count, 'rating', 'ratings')}`}>
                      {renderStars(s.rating)}
                    </div>
                  </PosterTile>
                ))}
              </div>
            </Section>
          )}

          {/* ─── HIGHLIGHTS ─── */}
          {highlights.length > 0 && (
            <Section icon="✨" title="Highlights">
              <div className="stats-highlight-grid">
                {highlights.map(h => (
                  <div
                    key={h.label}
                    className={`stats-highlight-card ${h.show ? 'clickable' : ''}`}
                    onClick={() => h.show && openShow(h.show)}
                  >
                    <div className="stats-highlight-thumb">
                      {h.show?.poster_path
                        ? <img src={`${TMDB_IMG}/w92${h.show.poster_path}`} alt="" />
                        : <span>{h.icon}</span>}
                    </div>
                    <div className="stats-highlight-body">
                      <div className="stats-highlight-label">{h.icon} {h.label}</div>
                      <div className="stats-highlight-title">{h.title}</div>
                      <div className="stats-highlight-value">{h.value}</div>
                    </div>
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* ─── COMPLETED ─── */}
          {d.completed?.length > 0 && (
            <Section icon="✅" title="Finished" hint={statsYear === 'all' ? 'All time' : `In ${statsYear}`}>
              <div className="stats-poster-grid">
                {d.completed.map(s => (
                  <PosterTile key={s.show_id} show={s} caption={shortDate(s.completed_on)} onOpen={openShow} />
                ))}
              </div>
            </Section>
          )}

          {/* ─── BY WEEK ─── */}
          <WeekChart
            byWeek={d.by_week}
            year={statsYear}
            one="episode"
            many="episodes"
            onOpenWeek={filterTo && (week => filterTo({ week }))}
          />

          {/* ─── EPISODES BY YEAR (all time) ─── */}
          {statsYear === 'all' && d.episodes_by_year?.length > 0 && (
            <Section icon="📅" title="Episodes by Year">
              <div className="stats-month-chart">
                <div className="stats-month-bars" style={{ overflowX: 'auto', paddingBottom: '8px', justifyContent: d.episodes_by_year.length > 12 ? 'flex-start' : 'center' }}>
                  {d.episodes_by_year.map(item => (
                    <div
                      key={item.year}
                      className="stats-month-bar-wrap"
                      style={{ minWidth: '40px', flex: d.episodes_by_year.length > 12 ? '0 0 auto' : '1', cursor: onFilterLibrary ? 'pointer' : 'default' }}
                      onClick={() => onFilterLibrary && onFilterLibrary({ year: item.year, language: 'all', mediaType: 'tv' })}
                      title={onFilterLibrary ? `See shows watched in ${item.year}` : undefined}
                    >
                      <div className="stats-month-count">{item.count > 0 ? item.count : ''}</div>
                      <div
                        className="stats-month-bar stats-grow"
                        style={{ height: item.count > 0 ? `${Math.max(6, (item.count / maxYear) * 100)}%` : '4px' }}
                        data-count={`${item.year}: ${plural(item.count, 'episode', 'episodes')}`}
                      />
                      <span className="stats-month-label">{item.year}</span>
                    </div>
                  ))}
                </div>
              </div>
            </Section>
          )}

          {/* ─── BY LANGUAGE ─── */}
          {d.shows_by_language?.length > 0 && (
            <Section icon="🌐" title="Shows by Language">
              <div className="stats-month-chart">
                <div className="stats-month-bars" style={{ overflowX: 'auto', paddingBottom: '8px', justifyContent: d.shows_by_language.length > 12 ? 'flex-start' : 'center' }}>
                  {d.shows_by_language.map(item => {
                    const clickable = onFilterLibrary && item.code;
                    return (
                      <div
                        key={item.language}
                        className="stats-month-bar-wrap"
                        style={{ minWidth: '48px', flex: d.shows_by_language.length > 12 ? '0 0 auto' : '1', cursor: clickable ? 'pointer' : 'default', opacity: item.code ? 1 : 0.6 }}
                        onClick={() => clickable && onFilterLibrary({ year: statsYear, language: item.code, mediaType: 'tv' })}
                        title={clickable ? `See ${item.language} shows` : item.code ? undefined : 'Mixed languages — pick a specific one to filter'}
                      >
                        <div className="stats-month-count">{item.count > 0 ? item.count : ''}</div>
                        <div
                          className="stats-month-bar"
                          style={{ height: item.count > 0 ? `${Math.max(6, (item.count / maxLanguage) * 100)}%` : '4px' }}
                          data-count={`${item.language}: ${plural(item.count, 'show', 'shows')}`}
                        />
                        <span className="stats-month-label">{item.language}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </Section>
          )}

          {/* ─── BY MONTH ─── */}
          <Section icon="📊" title="By Month" hint={peakMonth >= 0 ? `Busiest: ${MONTHS_LONG[peakMonth]}` : null}>
            <div className="stats-month-chart">
              <div className="stats-month-bars">
                {d.by_month.map((count, i) => (
                  <div
                    key={i}
                    className={`stats-month-bar-wrap ${filterTo && count > 0 ? 'is-clickable' : ''}`}
                    onClick={() => filterTo && count > 0 && filterTo({ month: i + 1 })}
                    title={filterTo && count > 0 ? `See shows watched in ${MONTHS_LONG[i]}` : undefined}
                  >
                    <div className="stats-month-count">{count > 0 ? count : ''}</div>
                    <div
                      className={`stats-month-bar stats-grow ${i === peakMonth ? 'is-peak' : ''}`}
                      style={{ height: count > 0 ? `${Math.max(6, (count / maxMonth) * 100)}%` : '4px', '--grow-delay': `${i * 30}ms` }}
                      data-count={`${MONTHS[i]}: ${plural(count, 'episode', 'episodes')}`}
                    />
                    <span className="stats-month-label">{MONTHS[i]}</span>
                  </div>
                ))}
              </div>
            </div>
          </Section>

          {/* ─── AVERAGES ─── */}
          <div className="stats-section">
            <div className="stats-averages">
              <div className="stats-avg-item">
                <div className="stats-avg-value"><CountUp value={d.episodes_watched} /></div>
                <div className="stats-avg-label">Episodes logged</div>
              </div>
              <span className="stats-avg-arrow">→</span>
              <div className="stats-avg-item">
                <div className="stats-avg-value"><CountUp value={d.avg_per_month} decimals={1} /></div>
                <div className="stats-avg-label">Average per month</div>
              </div>
              <span className="stats-avg-arrow">→</span>
              <div className="stats-avg-item">
                <div className="stats-avg-value"><CountUp value={d.avg_per_week} decimals={1} /></div>
                <div className="stats-avg-label">Average per week</div>
              </div>
            </div>
          </div>

          {/* ─── BOTTOM GRID ─── */}
          <div className="stats-bottom-grid">
            <DayChart byDay={d.by_day} one="episode" many="episodes" onOpenDay={filterTo && (weekday => filterTo({ weekday }))} />
            <RatingChart distribution={d.rating_distribution} onOpenRating={filterTo && (rating => filterTo({ rating }))} />
          </div>
        </>
      )}
    </>
  );
}
