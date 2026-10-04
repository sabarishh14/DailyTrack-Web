import { useState, useEffect, useCallback, useMemo } from 'react';
import CustomSelect from '../../components/CustomSelect';
import TvStatsSections from './TvStatsSections';
import { CountUp, DayChart, RatingChart, WeekChart } from './StatsCharts';
import { MONTHS_LONG, peakIndex } from './statsFormat';

// ═══════════════════════════════════════════════════════════════════════
// STATS VIEW — Letterboxd-Inspired Movie & TV Stats
// Follows the page's All / Movies / TV Shows switch: movie stats, TV stats,
// or both under one shared year picker.
// ═══════════════════════════════════════════════════════════════════════

const TMDB_IMG_STATS = 'https://image.tmdb.org/t/p';

// "2026-03-14" → "14 Mar 2026"; partial or missing dates fall back to the year.
const releaseLabel = (movie) => {
  if (!movie) return null;
  const raw = movie.release_date || '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00`);
    if (!isNaN(d)) return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  return movie.release_year;
};

// Poster grids (Highest Rated, Theatre Experiences, Most Rewatched) start
// collapsed to this many so a long history doesn't load/render dozens of
// posters up front; "Show More" reveals the rest on demand.
const POSTER_GRID_INITIAL_COUNT = 12;

function ShowMoreButton({ expanded, remaining, onToggle }) {
  return (
    <button className="stats-show-more-btn" onClick={onToggle}>
      {expanded ? '− Show Less' : `+ Show ${remaining} More`}
    </button>
  );
}

export default function StatsView({ API, getToken, statsData, setStatsData, statsYear, setStatsYear, statsLoading, setStatsLoading, openModal, onFilterLibrary, refreshTrigger, mediaType = 'movie', showMovies = true }) {
  const [error, setError] = useState(null);
  const [tvStats, setTvStats] = useState(null);
  const [tvLoading, setTvLoading] = useState(false);
  const [tvError, setTvError] = useState(null);

  const showMovieStats = showMovies && mediaType !== 'tv';
  const showTvStats = !showMovies || mediaType !== 'movie';
  const showBoth = showMovieStats && showTvStats;

  const fetchStats = useCallback(async (year) => {
    setStatsLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/movies/stats?year=${year}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await r.json();
      if (data.success) {
        setStatsData(data);
      } else {
        setError(data.message || 'Failed to load stats');
      }
    } catch (e) {
      setError(e.message);
    }
    setStatsLoading(false);
  }, [API, getToken, setStatsData, setStatsLoading]);

  const fetchTvStats = useCallback(async (year) => {
    setTvLoading(true);
    setTvError(null);
    try {
      const r = await fetch(`${API}/tv/stats?year=${year}`, {
        headers: { 'Authorization': `Bearer ${getToken()}` }
      });
      const data = await r.json();
      if (data.success) {
        setTvStats(data);
      } else {
        setTvError(data.message || 'Failed to load TV stats');
      }
    } catch (e) {
      setTvError(e.message);
    }
    setTvLoading(false);
  }, [API, getToken]);

  useEffect(() => {
    if (showMovieStats) fetchStats(statsYear);
  }, [statsYear, fetchStats, refreshTrigger, showMovieStats]);

  useEffect(() => {
    if (showTvStats) fetchTvStats(statsYear);
  }, [statsYear, fetchTvStats, refreshTrigger, showTvStats]);

  // Every year either kind of log exists in, newest first.
  const yearOptions = useMemo(() => {
    const years = new Set();
    if (showMovieStats) (statsData?.available_years || []).forEach(y => years.add(y));
    if (showTvStats) (tvStats?.available_years || []).forEach(y => years.add(y));
    years.add(new Date().getFullYear());
    return [
      { value: 'all', label: 'All Time' },
      ...[...years].sort((a, b) => b - a).map(y => ({ value: String(y), label: String(y) }))
    ];
  }, [statsData, tvStats, showMovieStats, showTvStats]);

  const waitingForMovies = showMovieStats && !statsData && !error;
  const waitingForTv = showTvStats && !tvStats && !tvError;

  if (waitingForMovies || waitingForTv) {
    return (
      <div className="stats-loading">
        <div className="tv-loading-spinner" style={{ width: '32px', height: '32px', borderWidth: '3px' }} />
        <span>Loading your stats...</span>
      </div>
    );
  }

  const movieUnavailable = showMovieStats && !statsData;
  const tvUnavailable = showTvStats && !tvStats;
  if ((!showMovieStats || movieUnavailable) && (!showTvStats || tvUnavailable)) {
    return (
      <div className="stats-loading">
        <span style={{ fontSize: '2rem' }}>😕</span>
        <span>{error || tvError || 'Stats are unavailable right now'}</span>
      </div>
    );
  }

  const subtitle = (() => {
    const kind = showBoth ? 'on screen' : showTvStats ? 'in TV' : 'in film';
    return statsYear === 'all'
      ? `Your all-time ${showBoth ? 'movie & TV' : showTvStats ? 'TV' : 'movie'} journey`
      : `Your ${statsYear} year ${kind}`;
  })();

  return (
    <div className="stats-container">
      {/* ─── HERO ─── */}
      <div className="stats-hero">
        <div className="stats-year-display">{statsYear === 'all' ? '∞' : statsYear}</div>
        <div style={{ width: '120px', margin: '0 auto 8px', position: 'relative', zIndex: 10 }}>
          <CustomSelect
            value={statsYear}
            onChange={(val) => setStatsYear(val)}
            options={yearOptions}
          />
        </div>
        <div className="stats-subtitle">{subtitle}</div>
        {(statsLoading || tvLoading) && (
          <div style={{ marginTop: '0.75rem' }}>
            <div className="tv-loading-spinner" style={{ width: '16px', height: '16px', borderWidth: '2px', display: 'inline-block' }} />
          </div>
        )}
      </div>

      {showMovieStats && (
        <>
          {showBoth && <div className="stats-media-divider"><span>🎬 Movies</span></div>}
          {statsData ? (
            <MovieStatsSections d={statsData} statsYear={statsYear} openModal={openModal} onFilterLibrary={onFilterLibrary} />
          ) : (
            <div className="stats-empty"><span className="stats-empty-icon">😕</span><span>{error}</span></div>
          )}
        </>
      )}

      {showTvStats && (
        <>
          {showBoth && <div className="stats-media-divider"><span>📺 TV Shows</span></div>}
          {tvStats ? (
            <TvStatsSections data={tvStats} statsYear={statsYear} openModal={openModal} onFilterLibrary={onFilterLibrary} />
          ) : (
            <div className="stats-empty"><span className="stats-empty-icon">😕</span><span>{tvError}</span></div>
          )}
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MOVIE SECTIONS
// ═══════════════════════════════════════════════════════════════════════

function MovieStatsSections({ d, statsYear, openModal, onFilterLibrary }) {
  const [highestRatedFilter, setHighestRatedFilter] = useState('current'); // 'current' | 'older'
  const [theatreFilter, setTheatreFilter] = useState('all');
  const [showAllTheatreTags, setShowAllTheatreTags] = useState(false);
  const [showAllHighestRated, setShowAllHighestRated] = useState(false);
  const [showAllTheatreMovies, setShowAllTheatreMovies] = useState(false);
  const [showAllRewatched, setShowAllRewatched] = useState(false);

  useEffect(() => {
    setHighestRatedFilter('current');
  }, [statsYear]);

  // Switching year or the current/older toggle changes the underlying list —
  // collapse back so a filter change doesn't suddenly dump a huge expanded
  // grid on screen.
  useEffect(() => {
    setShowAllHighestRated(false);
  }, [statsYear, highestRatedFilter]);

  useEffect(() => {
    setShowAllTheatreMovies(false);
  }, [theatreFilter]);

  // Render star icons for a given rating
  const renderStars = (rating) => {
    const stars = [];
    for (let i = 1; i <= 5; i++) {
      if (rating >= i) {
        stars.push(<span key={i} className="star-filled">★</span>);
      } else if (rating >= i - 0.5) {
        stars.push(<span key={i} className="star-filled">½</span>);
      }
    }
    return stars;
  };

  const filteredAndGroupedTheatreMovies = useMemo(() => {
    if (!d || !d.theatre_stats || !d.theatre_stats.movies) return [];

    // Filter first, so counts are accurate for the specific filter
    const filtered = d.theatre_stats.movies.filter(m =>
      theatreFilter === 'all' || m.tags.includes(theatreFilter)
    );

    const map = {};
    filtered.forEach(m => {
      if (!map[m.movie_id]) {
        map[m.movie_id] = { ...m, visitCount: 0, allTags: new Set() };
      }
      map[m.movie_id].visitCount += 1;
      m.tags.forEach(t => map[m.movie_id].allTags.add(t));
    });

    return Object.values(map).map(m => ({ ...m, tags: Array.from(m.allTags) }));
  }, [d, theatreFilter]);

  const maxMonth = Math.max(...(d.by_month || []), 1);
  const peakMonth = peakIndex(d.by_month || []);
  const maxYear = d.films_by_year ? Math.max(...d.films_by_year.map(y => y.count), 1) : 1;
  const maxLanguage = d.films_by_language ? Math.max(...d.films_by_language.map(l => l.count), 1) : 1;
  const monthLabels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  // Every chart bar opens the Library on exactly what it counted.
  const filterTo = onFilterLibrary ? (slice) => onFilterLibrary({ year: statsYear, mediaType: 'movie', ...slice }) : null;

  // Highest Rated Selection
  let highestRatedList = d.highest_rated || [];
  if (statsYear !== 'all') {
    highestRatedList = highestRatedFilter === 'current' ? (d.highest_rated_current || []) : (d.highest_rated_older || []);
  }
  const visibleHighestRated = showAllHighestRated ? highestRatedList : highestRatedList.slice(0, POSTER_GRID_INITIAL_COUNT);

  const rewatchedList = d.most_rewatched || [];
  const visibleRewatched = showAllRewatched ? rewatchedList : rewatchedList.slice(0, POSTER_GRID_INITIAL_COUNT);

  const visibleTheatreMovies = showAllTheatreMovies
    ? filteredAndGroupedTheatreMovies
    : filteredAndGroupedTheatreMovies.slice(0, POSTER_GRID_INITIAL_COUNT);

  return (
    <>
      {/* ─── SUMMARY COUNTERS ─── */}
      <div className="stats-counters">
        <div className="stats-counter-card">
          <div className="stats-counter-value"><CountUp value={d.films_logged} /></div>
          <div className="stats-counter-label">Films Watched</div>
        </div>
        <div className="stats-counter-card">
          <div className="stats-counter-value"><CountUp value={d.total_likes} /></div>
          <div className="stats-counter-label">Likes</div>
        </div>
        <div className="stats-counter-card">
          <div className="stats-counter-value"><CountUp value={d.total_hours} decimals={Number.isInteger(d.total_hours) ? 0 : 1} /></div>
          <div className="stats-counter-label">Hours</div>
        </div>
        {d.theatre_stats && d.theatre_stats.total_visits > 0 && (
          <div className="stats-counter-card">
            <div className="stats-counter-value"><CountUp value={d.theatre_stats.total_visits} /></div>
            <div className="stats-counter-label">Theatre Visits</div>
          </div>
        )}
      </div>

      {/* ─── HIGHEST RATED ─── */}
      {highestRatedList.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-header">
            <span className="stats-section-title">🏆 Highest Rated Films</span>
            {statsYear !== 'all' && (
              <div className="stats-section-toggles">
                <button
                  className={`stats-toggle-btn ${highestRatedFilter === 'current' ? 'active' : ''}`}
                  onClick={() => setHighestRatedFilter('current')}
                >
                  {statsYear}
                </button>
                <button
                  className={`stats-toggle-btn ${highestRatedFilter === 'older' ? 'active' : ''}`}
                  onClick={() => setHighestRatedFilter('older')}
                >
                  Older
                </button>
              </div>
            )}
          </div>
          <div className="stats-poster-grid">
            {visibleHighestRated.map(m => (
              <div
                key={m.movie_id}
                className="stats-poster-item"
                onClick={() => openModal({ id: m.movie_id, tmdb_id: m.tmdb_id, type: 'movie', name: m.name, poster_path: m.poster_path })}
                style={{ cursor: 'pointer' }}
              >
                <div className="stats-poster-img-wrap">
                  {m.poster_path ? (
                    <img src={`${TMDB_IMG_STATS}/w342${m.poster_path}`} alt={m.name} loading="lazy" />
                  ) : (
                    <div className="stats-no-poster">🎬</div>
                  )}
                  <span className="stats-poster-hover-name">{m.name}</span>
                </div>
                <div className="stats-poster-rating">{renderStars(m.rating)}</div>
              </div>
            ))}
          </div>
          {highestRatedList.length > POSTER_GRID_INITIAL_COUNT && (
            <ShowMoreButton
              expanded={showAllHighestRated}
              remaining={highestRatedList.length - POSTER_GRID_INITIAL_COUNT}
              onToggle={() => setShowAllHighestRated(v => !v)}
            />
          )}
        </div>
      )}

      {/* ─── THEATRE EXPERIENCES ─── */}
      {d.theatre_stats && d.theatre_stats.movies.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-header" style={{ marginBottom: '0.75rem' }}>
            <span className="stats-section-title">🍿 Theatre Experiences <span style={{ opacity: 0.6, fontSize: '0.85rem' }}>({d.theatre_stats.total_visits})</span></span>
          </div>

          {Object.keys(d.theatre_stats.supplementary_tags || {}).length > 0 && (
            <div className="stats-theatre-filters">
              <button
                className={`stats-theatre-pill ${theatreFilter === 'all' ? 'active' : ''}`}
                onClick={() => setTheatreFilter('all')}
              >
                ALL <span>{d.theatre_stats.total_visits}</span>
              </button>
              {Object.entries(d.theatre_stats.supplementary_tags)
                .sort((a, b) => b[1] - a[1]) // sort by frequency
                .slice(0, showAllTheatreTags ? undefined : 6)
                .map(([tag, count]) => (
                  <button
                    key={tag}
                    className={`stats-theatre-pill ${theatreFilter === tag ? 'active' : ''}`}
                    onClick={() => setTheatreFilter(tag)}
                  >
                    {tag.toUpperCase()} <span>{count}</span>
                  </button>
                ))}
              {Object.keys(d.theatre_stats.supplementary_tags).length > 6 && (
                <button
                  className="stats-theatre-pill"
                  onClick={() => setShowAllTheatreTags(!showAllTheatreTags)}
                  style={{ background: 'transparent', border: '1px dashed rgba(var(--accent-rgb), 0.4)', opacity: 0.8 }}
                >
                  {showAllTheatreTags ? '- Show Less' : '+ Show More'}
                </button>
              )}
            </div>
          )}

          <div className="stats-poster-grid stats-theatre-grid">
            {visibleTheatreMovies.map((m) => (
              <div
                key={m.movie_id}
                className="stats-poster-item"
                onClick={() => openModal({ id: m.movie_id, tmdb_id: m.tmdb_id, type: 'movie', name: m.name, poster_path: m.poster_path })}
                style={{ cursor: 'pointer' }}
              >
                <div className="stats-poster-img-wrap">
                  {m.poster_path ? (
                    <img src={`${TMDB_IMG_STATS}/w342${m.poster_path}`} alt={m.name} loading="lazy" />
                  ) : (
                    <div className="stats-no-poster">🎬</div>
                  )}
                  {m.visitCount > 1 && (
                    <div className="tv-ep-badge" style={{
                      position: 'absolute',
                      top: 6,
                      right: 6,
                      fontSize: '0.8rem',
                      padding: '0.2rem 0.5rem',
                      boxShadow: '0 4px 10px rgba(0,0,0,0.8)',
                      backgroundColor: 'var(--accent)',
                      color: '#000',
                      fontWeight: '800',
                      border: '1px solid rgba(255,255,255,0.4)',
                      borderRadius: '50%'
                    }}>
                      {m.visitCount}
                    </div>
                  )}
                  <span className="stats-poster-hover-name">{m.name}</span>
                </div>
                <div className="stats-poster-rating">{renderStars(m.rating)}</div>
              </div>
            ))}
          </div>
          {filteredAndGroupedTheatreMovies.length > POSTER_GRID_INITIAL_COUNT && (
            <ShowMoreButton
              expanded={showAllTheatreMovies}
              remaining={filteredAndGroupedTheatreMovies.length - POSTER_GRID_INITIAL_COUNT}
              onToggle={() => setShowAllTheatreMovies(v => !v)}
            />
          )}
        </div>
      )}

      {/* ─── BY WEEK ─── */}
      <WeekChart
        byWeek={d.by_week}
        year={statsYear}
        one="film"
        many="films"
        onOpenWeek={filterTo && (week => filterTo({ week }))}
      />
      {/* ─── BY YEAR ─── */}
      {d.year === 'all' && d.films_by_year && d.films_by_year.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-header">
            <span className="stats-section-title">📅 Films by Year</span>
          </div>
          <div className="stats-month-chart"> {/* Reusing month chart CSS for similar bar style */}
            <div className="stats-month-bars" style={{ overflowX: 'auto', paddingBottom: '8px', justifyContent: d.films_by_year.length > 12 ? 'flex-start' : 'center' }}>
              {d.films_by_year.map((item, i) => (
                <div
                  key={item.year}
                  className="stats-month-bar-wrap"
                  style={{ minWidth: '40px', flex: d.films_by_year.length > 12 ? '0 0 auto' : '1', cursor: onFilterLibrary ? 'pointer' : 'default' }}
                  onClick={() => onFilterLibrary && onFilterLibrary({ year: item.year, language: 'all', mediaType: 'movie' })}
                  title={onFilterLibrary ? `See films watched in ${item.year}` : undefined}
                >
                  <div className="stats-month-count">{item.count > 0 ? item.count : ''}</div>
                  <div
                    className="stats-month-bar stats-grow"
                    style={{ height: item.count > 0 ? `${Math.max(6, (item.count / maxYear) * 100)}%` : '4px' }}
                    data-count={`${item.year}: ${item.count} films`}
                  />
                  <span className="stats-month-label">{item.year}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── BY LANGUAGE ─── */}
      {d.films_by_language && d.films_by_language.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-header">
            <span className="stats-section-title">🌐 Films by Language</span>
          </div>
          <div className="stats-month-chart">
            <div className="stats-month-bars" style={{ overflowX: 'auto', paddingBottom: '8px', justifyContent: d.films_by_language.length > 12 ? 'flex-start' : 'center' }}>
              {d.films_by_language.map((item) => {
                const clickable = onFilterLibrary && item.code;
                return (
                  <div
                    key={item.language}
                    className="stats-month-bar-wrap"
                    style={{ minWidth: '48px', flex: d.films_by_language.length > 12 ? '0 0 auto' : '1', cursor: clickable ? 'pointer' : 'default', opacity: item.code ? 1 : 0.6 }}
                    onClick={() => clickable && onFilterLibrary({ year: statsYear, language: item.code, mediaType: 'movie' })}
                    title={clickable ? `See ${item.language} films` : item.code ? undefined : 'Mixed languages — pick a specific one to filter'}
                  >
                    <div className="stats-month-count">{item.count > 0 ? item.count : ''}</div>
                    <div
                      className="stats-month-bar stats-grow"
                      style={{ height: item.count > 0 ? `${Math.max(6, (item.count / maxLanguage) * 100)}%` : '4px' }}
                      data-count={`${item.language}: ${item.count} films`}
                    />
                    <span className="stats-month-label">{item.language}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ─── BY MONTH ─── */}
      {d.by_month && d.by_month.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-header">
            <span className="stats-section-title">📊 By Month</span>
            {peakMonth >= 0 && <span className="stats-section-hint">Busiest: {MONTHS_LONG[peakMonth]}</span>}
          </div>
          <div className="stats-month-chart">
            <div className="stats-month-bars">
              {d.by_month.map((count, i) => (
                <div
                  key={i}
                  className={`stats-month-bar-wrap ${filterTo && count > 0 ? 'is-clickable' : ''}`}
                  onClick={() => filterTo && count > 0 && filterTo({ month: i + 1 })}
                  title={filterTo && count > 0 ? `See films watched in ${MONTHS_LONG[i]}` : undefined}
                >
                  <div className="stats-month-count">{count > 0 ? count : ''}</div>
                  <div
                    className={`stats-month-bar stats-grow ${i === peakMonth ? 'is-peak' : ''}`}
                    style={{ height: count > 0 ? `${Math.max(6, (count / maxMonth) * 100)}%` : '4px', '--grow-delay': `${i * 30}ms` }}
                    data-count={`${monthLabels[i]}: ${count} films`}
                  />
                  <span className="stats-month-label">{monthLabels[i]}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ─── AVERAGES ─── */}
      <div className="stats-section">
        <div className="stats-averages">
          <div className="stats-avg-item">
            <div className="stats-avg-value"><CountUp value={d.films_logged} /></div>
            <div className="stats-avg-label">Films logged</div>
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

      {/* ─── THE EXTREMES ─── */}
      {d.extremes && (d.extremes.longest || d.extremes.shortest || d.extremes.oldest || d.extremes.newest) && (
        <div className="stats-section">
          <div className="stats-section-header">
            <span className="stats-section-title">⚖️ The Extremes</span>
          </div>
          <div className="stats-extremes-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1rem' }}>
            {[
              { label: "Longest Film", data: d.extremes.longest, val: d.extremes.longest?.runtime ? `${d.extremes.longest.runtime} mins` : null, icon: "⏳" },
              { label: "Shortest Film", data: d.extremes.shortest, val: d.extremes.shortest?.runtime ? `${d.extremes.shortest.runtime} mins` : null, icon: "⏱️" },
              { label: "Oldest Release", data: d.extremes.oldest, val: releaseLabel(d.extremes.oldest), icon: "🏛️" },
              { label: "Newest Release", data: d.extremes.newest, val: releaseLabel(d.extremes.newest), icon: "✨" },
              { label: "Longest Streak", data: d.longest_streak?.length > 0 ? { id: 'streak', name: d.longest_streak.start === d.longest_streak.end ? d.longest_streak.start : `${d.longest_streak.start} to ${d.longest_streak.end}` } : null, val: `${d.longest_streak?.length} days`, icon: "🔥", noClick: true },
            ].map((ext, i) => ext.data && (
              <div key={i} onClick={() => !ext.noClick && openModal({ id: ext.data.id, tmdb_id: ext.data.tmdb_id, type: 'movie', name: ext.data.name, poster_path: ext.data.poster_path })} style={{ display: 'flex', alignItems: 'center', gap: '1rem', background: 'var(--bg-input)', padding: '0.75rem', borderRadius: '8px', border: '1px solid var(--border)', cursor: ext.noClick ? 'default' : 'pointer' }}>
                <div style={{ width: '45px', flexShrink: 0, borderRadius: '4px', overflow: 'hidden', display: 'flex', justifyContent: 'center', alignItems: 'center', background: ext.noClick ? 'var(--bg2)' : 'transparent', aspectRatio: '2/3' }}>
                  {ext.data.poster_path ? <img src={`${TMDB_IMG_STATS}/w92${ext.data.poster_path}`} alt="" style={{ width: '100%', display: 'block' }} /> : <div style={{ fontSize: '1.5rem' }}>{ext.icon}</div>}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ color: 'var(--text2)', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>{ext.icon}</span> {ext.label}
                  </div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ext.data.name}</div>
                  <div style={{ color: 'var(--accent)', fontSize: '0.85rem', fontWeight: 600 }}>{ext.val}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── MOST REWATCHED ─── */}
      {d.most_rewatched && d.most_rewatched.length > 0 && (
        <div className="stats-section">
          <div className="stats-section-header">
            <span className="stats-section-title">🔁 Most Rewatched</span>
          </div>
          <div className="stats-poster-grid">
            {visibleRewatched.map((m) => (
              <div key={m.movie_id} className="stats-poster-item" style={{ cursor: 'pointer' }} onClick={() => openModal({ id: m.movie_id, tmdb_id: m.tmdb_id, type: 'movie', name: m.name, poster_path: m.poster_path })}>
                <div className="stats-poster-img-wrap">
                  {m.poster_path ? (
                    <img src={`${TMDB_IMG_STATS}/w185${m.poster_path}`} alt={m.name} loading="lazy" />
                  ) : (
                    <div className="stats-poster-placeholder">
                      <span>{m.name}</span>
                    </div>
                  )}
                  <div style={{
                    position: 'absolute',
                    top: '4px',
                    right: '4px',
                    fontSize: '0.7rem',
                    padding: '0.2rem 0.5rem',
                    boxShadow: '0 4px 10px rgba(0,0,0,0.8)',
                    backgroundColor: 'var(--accent)',
                    color: '#000',
                    fontWeight: '800',
                    border: '1px solid rgba(255,255,255,0.4)',
                    borderRadius: '50%'
                  }}>
                    {m.watch_count}
                  </div>
                  <span className="stats-poster-hover-name">{m.name}</span>
                </div>
              </div>
            ))}
          </div>
          {rewatchedList.length > POSTER_GRID_INITIAL_COUNT && (
            <ShowMoreButton
              expanded={showAllRewatched}
              remaining={rewatchedList.length - POSTER_GRID_INITIAL_COUNT}
              onToggle={() => setShowAllRewatched(v => !v)}
            />
          )}
        </div>
      )}

      {/* ─── BOTTOM GRID ─── */}
      <div className="stats-bottom-grid">
        <DayChart byDay={d.by_day} one="film" many="films" onOpenDay={filterTo && (weekday => filterTo({ weekday }))} />
        <RatingChart distribution={d.rating_distribution} onOpenRating={filterTo && (rating => filterTo({ rating }))} />
      </div>
    </>
  );
}
