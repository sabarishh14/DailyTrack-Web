import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import CustomSelect from '../components/CustomSelect';
import { StarRating, StarDisplay } from './sabdekho-components/StarRating';
import StatsView from './sabdekho-components/StatsView';
import { MONTHS_LONG, WEEKDAYS_LONG, weekLabel, starsLabel } from './sabdekho-components/statsFormat';
import { useAccess } from '../access/AccessContext';

const TMDB_IMG = 'https://image.tmdb.org/t/p';
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Library poster size — the TMDB width actually requested per tier, so
// "small" genuinely downloads a smaller image instead of just squeezing a
// full w185 into a tighter grid cell.
const POSTER_IMG_SIZE = { small: 'w92', medium: 'w154', large: 'w342' };

// A tiny "n x n squares" icon standing in for how many columns that density gives you.
function GridSizeIcon({ cols }) {
  const box = 14;
  const gap = 2;
  const cell = (box - gap * (cols - 1)) / cols;
  const squares = [];
  for (let r = 0; r < cols; r++) {
    for (let c = 0; c < cols; c++) {
      squares.push(
        <rect key={`${r}-${c}`} x={c * (cell + gap)} y={r * (cell + gap)} width={cell} height={cell} rx={cell > 5 ? 1.5 : 1} />
      );
    }
  }
  return <svg width={box} height={box} viewBox={`0 0 ${box} ${box}`} fill="currentColor">{squares}</svg>;
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────
function SabDekho({ API, getToken, showMovies, refreshTrigger }) {
  const canEdit = useAccess().can('sabdekho', 'edit');
const [view, setView] = useState('library'); // library | diary | stats
  const [shows, setShows] = useState([]);
  const [diaryLogs, setDiaryLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  // Search
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef(null);
  const searchTimer = useRef(null);

  // Modal
  const [selectedShow, setSelectedShow] = useState(null);
  const [showDetails, setShowDetails] = useState(null);
  const [showDetailsLoading, setShowDetailsLoading] = useState(false);

  // Log form
  const [logDate, setLogDate] = useState(new Date().toISOString().split('T')[0]);
  const [logSeasons, setLogSeasons] = useState([]); // array of ints
  const [logEpisodes, setLogEpisodes] = useState([]); // multi-select
  const [logRating, setLogRating] = useState(0);
  const [logReview, setLogReview] = useState('');
  const [logTags, setLogTags] = useState('');
  const [logLiked, setLogLiked] = useState(false);
  const [logRewatch, setLogRewatch] = useState(false);
  const [logSaving, setLogSaving] = useState(false);
  const [modalView, setModalView] = useState('log'); // log | details
  const [editingLogIds, setEditingLogIds] = useState(null);
  const [editingLog, setEditingLog] = useState(null);
  const [rematchMode, setRematchMode] = useState(false);
  const [rematchQuery, setRematchQuery] = useState('');
  const [rematchResults, setRematchResults] = useState([]);
  const [rematchLoading, setRematchLoading] = useState(false);
  const [rematchSaving, setRematchSaving] = useState(null);
  const rematchTimer = useRef(null);

  // Filter
  const [mediaType, setMediaType] = useState('all'); // 'movies', 'all', 'tv'
  const [statusFilter, setStatusFilter] = useState('WATCHING');
  const [yearFilter, setYearFilter] = useState('all');
  const [monthFilter, setMonthFilter] = useState('all');
  const [weekFilter, setWeekFilter] = useState('all');
  const [languageFilter, setLanguageFilter] = useState('all');
  // Set by the Stats "By Day" and "Ratings" bars: a day of the week (0 = Monday) and a log's rating.
  const [weekdayFilter, setWeekdayFilter] = useState('all');
  const [ratingFilter, setRatingFilter] = useState('all');
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [filterOptions, setFilterOptions] = useState(null); // { years, languages } — lazy-loaded
  const hasActiveLibraryFilters = [yearFilter, monthFilter, weekFilter, languageFilter, weekdayFilter, ratingFilter].some(f => f !== 'all');
  const clearLibraryFilters = () => {
    setYearFilter('all'); setMonthFilter('all'); setWeekFilter('all');
    setLanguageFilter('all'); setWeekdayFilter('all'); setRatingFilter('all');
  };
  const trackerRef = useRef(null);

  // Poster size — remembered across visits, like theme/accent.
  const [posterSize, setPosterSize] = useState(() => localStorage.getItem('dt_poster_size') || 'medium');
  useEffect(() => { localStorage.setItem('dt_poster_size', posterSize); }, [posterSize]);

  // Diary expanded reviews
  const [expandedLogs, setExpandedLogs] = useState({});

  // Pagination (Frontend)
  const [showsPage, setShowsPage] = useState(1);
  const [diaryPage, setDiaryPage] = useState(1);
  const [showsTotalCount, setShowsTotalCount] = useState(0);
  const [diaryTotalCount, setDiaryTotalCount] = useState(0);
  const [selectedShowLogs, setSelectedShowLogs] = useState([]);
  const ITEMS_PER_PAGE = 60;

  // Stats
  const [statsData, setStatsData] = useState(null);
  const [statsYear, setStatsYear] = useState(String(new Date().getFullYear()));
  const [statsLoading, setStatsLoading] = useState(false);

  // Reset pagination when filters change
  useEffect(() => {
    setShowsPage(1);
    setDiaryPage(1);
  }, [mediaType, statusFilter, yearFilter, monthFilter, weekFilter, languageFilter, weekdayFilter, ratingFilter, view, showMovies]);

  // Reset media type if movies are disabled while in movie mode
  useEffect(() => {
    if (!showMovies && mediaType === 'movie') {
      setMediaType('all');
    }
  }, [showMovies, mediaType]);

  // Calendar
  const [calMonth, setCalMonth] = useState(new Date().getMonth());
  const [calYear, setCalYear] = useState(new Date().getFullYear());

  const hdrs = useCallback(() => ({
    'Authorization': `Bearer ${getToken()}`,
    'Content-Type': 'application/json'
  }), [getToken]);

  // ─── FETCHERS ─────────────────────────────────────────────────────────
  const fetchShows = useCallback(async () => {
    try {
      // Determine what to ask the backend based on toggles
      const typeParam = mediaType === 'all' ? (showMovies ? 'all' : 'tv') : mediaType;
      const r = await fetch(`${API}/media/library?limit=${ITEMS_PER_PAGE}&offset=${(showsPage - 1) * ITEMS_PER_PAGE}&type=${typeParam}&status=${statusFilter}&year=${yearFilter}&month=${monthFilter}&week=${weekFilter}&language=${languageFilter}&weekday=${weekdayFilter}&rating=${ratingFilter}`, { headers: hdrs() });
      const data = await r.json();
      if (data.success) {
        setShows(data.shows || []);
        setShowsTotalCount(data.total_count || 0);
      }
    } catch (e) { console.error(e); }
  }, [API, hdrs, showMovies, mediaType, statusFilter, yearFilter, monthFilter, weekFilter, languageFilter, weekdayFilter, ratingFilter, showsPage]);

  const fetchFilterOptions = useCallback(async () => {
    try {
      const r = await fetch(`${API}/media/filters`, { headers: hdrs() });
      const data = await r.json();
      if (data.success) setFilterOptions({ years: data.years || [], languages: data.languages || [] });
    } catch (e) { console.error(e); }
  }, [API, hdrs]);

  // Jump here from a Stats chart bar. Each click is a fresh, complete slice —
  // any dimension it doesn't mention (month/week/language/...) resets to 'all'
  // rather than merging with whatever was already set in the Library. The
  // slice shows as chips above the grid; the filter panel stays as it was.
  const handleFilterLibrary = useCallback(({ year, month, week, language, weekday, rating, mediaType: mt }) => {
    if (!filterOptions) fetchFilterOptions();
    const facet = v => (v != null && v !== 'all' ? String(v) : 'all');
    setYearFilter(facet(year));
    setMonthFilter(facet(month));
    setWeekFilter(facet(week));
    setLanguageFilter(language || 'all');
    setWeekdayFilter(facet(weekday));
    setRatingFilter(facet(rating));
    if (mt) setMediaType(mt);
    setStatusFilter('all');
    setView('library');
    // The bar may have been far down the Stats page.
    requestAnimationFrame(() => trackerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [filterOptions, fetchFilterOptions]);

  const fetchDiary = useCallback(async () => {
    try {
      const typeParam = mediaType === 'all' ? (showMovies ? 'all' : 'tv') : mediaType;
      // We limit diary to 20 per page so it's not too long
      const DIARY_PER_PAGE = 20;
      const r = await fetch(`${API}/media/diary?limit=${DIARY_PER_PAGE}&offset=${(diaryPage - 1) * DIARY_PER_PAGE}&type=${typeParam}`, { headers: hdrs() });
      const data = await r.json();
      if (data.success) {
        setDiaryLogs(data.logs || []);
        setDiaryTotalCount(data.total_count || 0);
      }
    } catch (e) { console.error(e); }
  }, [API, hdrs, showMovies, mediaType, diaryPage]);

  useEffect(() => {
    if (!loading) setIsSyncing(true);
    if (view === 'library') {
      fetchShows().then(() => { setLoading(false); setIsSyncing(false); });
    } else if (view === 'diary') {
      fetchDiary().then(() => { setLoading(false); setIsSyncing(false); });
    } else if (view === 'stats') {
      setLoading(false); setIsSyncing(false);
    }
  }, [fetchShows, fetchDiary, refreshTrigger, view]);

  // ─── DEBOUNCED SEARCH ─────────────────────────────────────────────────
  useEffect(() => {
    if (!searchQuery.trim()) { setSearchResults([]); setShowDropdown(false); return; }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const r = await fetch(`${API}/media/search?q=${encodeURIComponent(searchQuery)}`, { headers: hdrs() });
        const d = await r.json();
        if (d.success) {
          let results = d.data.results || [];
          results = results.filter(r => r.media_type === 'tv' || r.media_type === 'movie');
          setSearchResults(results);
          setShowDropdown(true);
        }
      } catch (e) { console.error(e); }
      setSearchLoading(false);
    }, 350);
    return () => clearTimeout(searchTimer.current);
  }, [searchQuery]);

  useEffect(() => {
    if (!rematchQuery.trim()) { setRematchResults([]); return; }
    if (rematchTimer.current) clearTimeout(rematchTimer.current);
    rematchTimer.current = setTimeout(async () => {
      setRematchLoading(true);
      try {
        const searchType = selectedShow?.type || 'movie';
        const r = await fetch(`${API}/media/search?q=${encodeURIComponent(rematchQuery)}&type=${searchType}`, { headers: hdrs() });
        const data = await r.json();
        if (data.success && data.data && data.data.results) {
          setRematchResults(data.data.results);
        }
      } catch (e) { console.error(e); }
      setRematchLoading(false);
    }, 500);
    return () => clearTimeout(rematchTimer.current);
  }, [rematchQuery, selectedShow]);

  useEffect(() => {
    const fn = (e) => { if (searchRef.current && !searchRef.current.contains(e.target)) setShowDropdown(false); };
    document.addEventListener('mousedown', fn);
    return () => document.removeEventListener('mousedown', fn);
  }, []);

  // ─── ACTIONS ──────────────────────────────────────────────────────────
  const addShow = async (tmdbShow) => {
    setShowDropdown(false); setSearchQuery('');
    setSearchLoading(true);

    try {
      const endpoint = tmdbShow.media_type === 'movie' ? '/movies' : '/tv/shows';
      const r = await fetch(`${API}${endpoint}`, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ tmdb_id: tmdbShow.id, name: tmdbShow.title || tmdbShow.name, poster_path: tmdbShow.poster_path, status: 'NONE' })
      });
      const d = await r.json();
      if (d.success && d.show) {
        // Open the modal with the DB object without forcing a reload or optimistic UI update yet
        openModal(d.show);
      }
    } catch (e) {
      console.error(e);
    }
    setSearchLoading(false);
  };

  const openModal = async (show) => {
    setSelectedShow(show); setShowDetails(null); setShowDetailsLoading(true);
    setLogDate(new Date().toISOString().split('T')[0]);
    setLogSeasons([]); setLogEpisodes([]); setLogRating(0); setLogReview(''); setLogTags(''); setLogLiked(false);
    setEditingLogIds(null);
    setEditingLog(null);

    if (show.type !== 'movie') {
      setLogRewatch(false);
    }
    setModalView(canEdit ? 'log' : 'details');
    try {
      const endpoint = show.type === 'movie' ? `/movies/details/${show.tmdb_id}` : `/tv/details/${show.tmdb_id}`;
      const [r, logsR] = await Promise.all([
        fetch(`${API}${endpoint}`, { headers: hdrs() }),
        fetch(`${API}/media/diary?type=${show.type}&show_id=${show.id}`, { headers: hdrs() })
      ]);
      const d = await r.json();
      const logsD = await logsR.json();

      let fetchedLogs = [];
      if (logsD.success) {
        fetchedLogs = logsD.logs || [];
        setSelectedShowLogs(fetchedLogs);
      } else {
        setSelectedShowLogs([]);
      }

      if (show.type === 'movie') {
        setLogRewatch(fetchedLogs.length > 0);
      }
      if (d.success) {
        setShowDetails(d.data);
        if (show.type === 'tv') {
          const validSeasons = d.data.seasons?.filter(s => s.season_number > 0 && s.episode_count > 0) || [];
          if (validSeasons.length > 0) {
            const latestSeason = Math.max(...validSeasons.map(s => s.season_number));
            setLogSeasons([latestSeason]);
          }
        }
      }
    } catch (e) { console.error(e); }
    setShowDetailsLoading(false);
  };

  const closeModal = () => {
    setSelectedShow(null);
    setRematchMode(false);
    setRematchQuery('');
    setRematchResults([]);
  };

  const handleRematch = async (result) => {
    if (!selectedShow || rematchSaving) return;
    setRematchSaving(result.id);
    try {
      const typeStr = selectedShow.type === 'movie' ? 'movies' : 'tv';
      const r = await fetch(`${API}/${typeStr}/${selectedShow.id}/rematch`, {
        method: 'POST',
        headers: hdrs(),
        body: JSON.stringify({
          tmdb_id: result.id,
          name: result.name || result.title,
          poster_path: result.poster_path,
          year: (result.release_date || result.first_air_date || '')
        })
      });
      const data = await r.json();
      if (data.success) {
        setRematchResults([]);
        setRematchQuery('');
        setRematchMode(false);
        // Re-open modal with updated show to refresh details (overview, director, etc.)
        await openModal(data.show);
        fetchShows();
        fetchDiary();
      } else {
        alert(data.message || 'Error re-matching.');
      }
    } catch (e) {
      console.error('Rematch error:', e);
      alert('Error: ' + e.message);
    }
    setRematchSaving(null);
  };

  const exportToLetterboxd = () => {
    const movies = diaryLogs.filter(log => log.type === 'movie' && log.tmdb_id);
    if (movies.length === 0) return alert('No movies found in diary to export!');

    let csvContent = "data:text/csv;charset=utf-8,tmdbID,Rating,WatchedDate,Rewatch,Tags,Review\n";

    movies.forEach(log => {
      const tmdbId = log.tmdb_id || '';
      const rating = log.rating ? log.rating : '';
      const date = log.date || '';
      const rewatch = log.rewatch ? 'Yes' : 'No';
      const tags = `"${(log.tags || '').replace(/"/g, '""')}"`;
      const review = `"${(log.review || '').replace(/"/g, '""')}"`;
      csvContent += `${tmdbId},${rating},${date},${rewatch},${tags},${review}\n`;
    });

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "watchtrack_export.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.open("https://letterboxd.com/import/", "_blank");
  };

  const canMarkAsWatched = () => {
    if (selectedShow.type === 'movie') return true;
    if (!showDetails) return false;
    const showLogs = diaryLogs.filter(l => l.show_id === selectedShow.id && l.type === 'tv');
    if (showLogs.some(l => !l.season_number && !l.episode_number)) return true;
    let watchedCount = 0;
    const loggedSeasons = new Set(showLogs.filter(l => l.season_number && !l.episode_number).map(l => l.season_number));
    if (showDetails.seasons) {
      showDetails.seasons.forEach(s => {
        if (loggedSeasons.has(s.season_number)) watchedCount += s.episode_count;
      });
    }
    const loggedEps = new Set(showLogs.filter(l => l.season_number && l.episode_number).map(l => `${l.season_number}-${l.episode_number}`));
    watchedCount += loggedEps.size;
    return watchedCount >= showDetails.number_of_episodes;
  };

  const updateStatus = async (status, force = false) => {
    if (!selectedShow) return;
    if (!force && status === 'WATCHED' && selectedShow.type === 'tv' && !canMarkAsWatched()) {
      alert("You can only mark this show as WATCHED if you have logged all episodes or an entire season.");
      return;
    }
    try {
      const endpoint = selectedShow.type === 'movie' ? `/movies/${selectedShow.id}` : `/tv/shows/${selectedShow.id}`;
      await fetch(`${API}${endpoint}`, {
        method: 'PUT', headers: hdrs(),
        body: JSON.stringify({ status })
      });
      setSelectedShow(prev => prev ? { ...prev, status } : null);
      setShows(prev => {
        if (prev.some(s => s.id === selectedShow.id)) {
          return prev.map(s => s.id === selectedShow.id ? { ...s, status } : s);
        } else {
          return [{ ...selectedShow, status }, ...prev];
        }
      });
    } catch (e) { console.error(e); }
  };

  const deleteShow = async () => {
    if (!selectedShow || !confirm(`Remove "${selectedShow.name}"?`)) return;
    try {
      const endpoint = selectedShow.type === 'movie' ? `/movies/${selectedShow.id}` : `/tv/shows/${selectedShow.id}`;
      await fetch(`${API}${endpoint}`, { method: 'DELETE', headers: hdrs() });
      fetchShows(); fetchDiary(); closeModal();
    } catch (e) { console.error(e); }
  };

  const saveDiaryLog = async () => {
    if (!selectedShow) return;
    if (selectedShow.type === 'tv' && logSeasons.length === 1 && logEpisodes.length === 0) {
      alert("Please select at least one episode to log, or deselect the season to log the entire show.");
      return;
    }
    setLogSaving(true);
    try {
      const endpoint = selectedShow.type === 'movie' ? '/movies/diary' : '/tv/diary';

      if (editingLogIds) {
        if (selectedShow.type === 'tv') {
          // For TV shows, editing might involve changing seasons or episode counts (e.g., 3 logs to 1 "Entire Show" log)
          // It's safest to delete the old logs and recreate them
          await fetch(`${API}${endpoint}`, { method: 'DELETE', headers: hdrs(), body: JSON.stringify({ log_ids: editingLogIds }) });
        } else {
          // Movies are always 1:1, a PUT is perfectly fine
          await fetch(`${API}${endpoint}`, {
            method: 'PUT', headers: hdrs(),
            body: JSON.stringify({ log_ids: editingLogIds, rating: logRating || null, review: logReview || null, liked: logLiked, rewatch: logRewatch, tags: logTags.trim() || null })
          });
        }
      }

      if (!editingLogIds || selectedShow.type === 'tv') {
        if (selectedShow.type === 'tv') {
          const seasonsToLog = logSeasons.length > 0 ? logSeasons : [null];

          for (const s of seasonsToLog) {
            const episodesToLog = (s !== null && logSeasons.length === 1 && logEpisodes.length > 0) ? logEpisodes : [null];
            for (const ep of episodesToLog) {
              await fetch(`${API}${endpoint}`, {
                method: 'POST', headers: hdrs(),
                body: JSON.stringify({
                  tv_show_id: selectedShow.id, date: logDate,
                  season_number: s, episode_number: ep,
                  rating: logRating || null, review: logReview || null,
                  liked: logLiked, rewatch: logRewatch, tags: logTags.trim() || null
                })
              });
            }
          }
        } else if (!editingLogIds) {
          // Movie log
          await fetch(`${API}${endpoint}`, {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({
              movie_id: selectedShow.id, date: logDate,
              rating: logRating || null, review: logReview || null,
              liked: logLiked, rewatch: logRewatch, tags: logTags.trim() || null
            })
          });
        }
      }
      setEditingLogIds(null);
      setEditingLog(null);

      // Auto-update status
      if (selectedShow.type === 'movie' && selectedShow.status !== 'WATCHED') {
        updateStatus('WATCHED', true);
      } else if (selectedShow.type === 'tv' && selectedShow.status !== 'WATCHED') {
        if (logSeasons.length === 0) {
          updateStatus('WATCHED', true);
        } else {
          const tvRes = await fetch(`${API}/tv/diary`, { headers: hdrs() }).then(r => r.json());
          if (tvRes.success) {
            const showLogs = tvRes.logs.filter(l => l.show_id === selectedShow.id);
            let watchedCount = 0;
            const loggedSeasons = new Set(showLogs.filter(l => l.season_number && !l.episode_number).map(l => l.season_number));
            if (showDetails?.seasons) {
              showDetails.seasons.forEach(s => {
                if (loggedSeasons.has(s.season_number)) watchedCount += s.episode_count;
              });
            }
            const loggedEps = new Set(showLogs.filter(l => l.season_number && l.episode_number).map(l => `${l.season_number}-${l.episode_number}`));
            watchedCount += loggedEps.size;
            if (watchedCount >= (showDetails?.number_of_episodes || 9999)) {
              updateStatus('WATCHED', true);
            }
          }
        }
      }

      fetchDiary();
      closeModal(); // close modal after saving
    } catch (e) { console.error(e); }
    setLogSaving(false);
  };

  const editLog = async (log) => {
    let show = shows.find(s => s.id === log.show_id && s.type === log.type);
    if (!show) {
      show = {
        id: log.show_id,
        tmdb_id: log.tmdb_id,
        name: log.show_name,
        poster_path: log.poster_path,
        type: log.type,
      };
    }
    await openModal(show);
    setEditingLogIds(log.log_ids || [log.id]);
    setEditingLog(log);
    setLogDate(log.date);
    setLogSeasons(log.seasons || (log.season_number != null ? [log.season_number] : []));
    setLogEpisodes(log.episodes || (log.episode_number != null ? [log.episode_number] : []));
    setLogRating(log.rating || 0);
    setLogReview(log.review || '');
    setLogTags(log.tags || '');
    setLogLiked(log.liked || false);
    setLogRewatch(log.rewatch || false);
  };

  const deleteLog = async (log_ids, logType) => {
    if (!confirm("Delete this diary entry?")) return;
    try {
      const endpoint = logType === 'movie' ? '/movies/diary' : '/tv/diary';
      await fetch(`${API}${endpoint}`, { method: 'DELETE', headers: hdrs(), body: JSON.stringify({ log_ids }) });
      fetchDiary();
    } catch (e) { console.error(e); }
  };

  // ─── HELPERS ──────────────────────────────────────────────────────────
  const getSeasons = () => {
    if (!showDetails?.seasons) return [];
    return showDetails.seasons.filter(s => s.season_number > 0 && s.episode_count > 0);
  };

  const getEpisodes = () => {
    if (!showDetails?.seasons || logSeasons.length !== 1) return [];
    const seasonData = showDetails.seasons.find(s => s.season_number === logSeasons[0]);
    if (!seasonData) return [];
    return Array.from({ length: seasonData.episode_count }, (_, i) => i + 1);
  };

  const isEpisodeWatched = (ep) => {
    if (!selectedShow || logSeasons.length !== 1) return false;
    const showLogs = selectedShowLogs;
    return showLogs.some(l => {
      if (l.seasons && l.seasons.includes(logSeasons[0])) return true;
      if (l.season_number === null) return true; // Entire show logged
      if (l.season_number === logSeasons[0] && (!l.episodes || l.episodes.length === 0) && l.episode_number === undefined) return true;
      if (l.season_number === logSeasons[0] && l.episodes && l.episodes.includes(ep)) return true;
      if (l.season_number === logSeasons[0] && l.episode_number === ep) return true;
      if (l.season_number === logSeasons[0] && l.episode_number === null) return true;
      return false;
    });
  };

  const isSeasonWatched = (seasonNum) => {
    if (!selectedShow || !showDetails) return false;
    const showLogs = selectedShowLogs.filter(l => l.type === 'tv');

    // Check if full show or multiple seasons logged
    if (showLogs.some(l => l.seasons && l.seasons.includes(seasonNum))) return true;
    if (showLogs.some(l => l.season_number === null)) return true; // Entire show logged

    // Check if full season is logged
    const fullSeasonLogged = showLogs.some(l =>
      (l.season_number === seasonNum && (!l.episodes || l.episodes.length === 0) && l.episode_number === undefined) ||
      (l.season_number === seasonNum && l.episode_number === null)
    );
    if (fullSeasonLogged) return true;

    // Check if all episodes are logged
    const seasonData = showDetails.seasons.find(s => s.season_number === seasonNum);
    if (!seasonData || seasonData.episode_count === 0) return false;

    const loggedEps = new Set();
    showLogs.forEach(l => {
      if (l.season_number === seasonNum) {
        if (l.episodes && l.episodes.length > 0) {
          l.episodes.forEach(e => loggedEps.add(e));
        } else if (l.episode_number !== null && l.episode_number !== undefined) {
          loggedEps.add(l.episode_number);
        }
      }
    });

    return loggedEps.size >= seasonData.episode_count;
  };

  const toggleEpisode = (ep) => {
    setLogEpisodes(prev => {
      const newEps = prev.includes(ep) ? prev.filter(e => e !== ep) : [...prev, ep].sort((a, b) => a - b);
      if (newEps.length > 0) {
        const firstEp = newEps[0];
        const hasLogged = diaryLogs.some(l => l.show_id === selectedShow.id && l.type === 'tv' &&
          l.season_number === logSeasons[0] &&
          (l.episode_number === firstEp || l.episode_number === null));
        setLogRewatch(hasLogged);
      } else {
        setLogRewatch(false);
      }
      return newEps;
    });
  };

  const selectAllEpisodes = () => {
    const all = getEpisodes();
    if (logEpisodes.length === all.length) setLogEpisodes([]);
    else setLogEpisodes(all);
  };

  // We no longer need local filtering since the backend handles it. 
  // However, we still need to process the diary logs into dates safely using useMemo!
  const fmtDate = (str) => { const d = new Date(str); return `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`; };

  const filteredShows = shows;

  const filteredDiaryLogs = diaryLogs;

  const groupedDiary = useMemo(() => {
    return filteredDiaryLogs.reduce((acc, l) => {
      if (!acc[l.date]) acc[l.date] = [];

      const existing = acc[l.date].find(e =>
        e.type === l.type &&
        e.show_id === l.show_id &&
        e.review === l.review &&
        e.rating === l.rating &&
        e.tags === l.tags &&
        (
          (e.episode_number !== null && l.episode_number !== null && e.season_number === l.season_number) ||
          (e.episode_number === null && l.episode_number === null && e.season_number !== null && l.season_number !== null)
        )
      );

      if (existing) {
        existing.log_ids.push(l.id);
        if (existing.episode_number !== null) {
          if (!existing.episodes) existing.episodes = [existing.episode_number];
          if (!existing.episodes.includes(l.episode_number)) {
            existing.episodes.push(l.episode_number);
            existing.episodes.sort((a, b) => a - b);
          }
        } else {
          if (!existing.seasons) existing.seasons = [existing.season_number];
          if (!existing.seasons.includes(l.season_number)) {
            existing.seasons.push(l.season_number);
            existing.seasons.sort((a, b) => a - b);
          }
        }
      } else {
        acc[l.date].push({
          ...l,
          log_ids: [l.id],
          episodes: l.episode_number !== null ? [l.episode_number] : null,
          seasons: (l.season_number !== null && l.episode_number === null) ? [l.season_number] : null
        });
      }

      return acc;
    }, {});
  }, [filteredDiaryLogs]);

  const groupedModalLogs = useMemo(() => {
    const grouped = selectedShowLogs.reduce((acc, l) => {
      if (!acc[l.date]) acc[l.date] = [];
      const existing = acc[l.date].find(e =>
        e.type === l.type && e.show_id === l.show_id && e.review === l.review && e.rating === l.rating && e.tags === l.tags &&
        ((e.episode_number !== null && l.episode_number !== null && e.season_number === l.season_number) ||
          (e.episode_number === null && l.episode_number === null && e.season_number !== null && l.season_number !== null))
      );
      if (existing) {
        existing.log_ids.push(l.id);
        if (existing.episode_number !== null) {
          if (!existing.episodes) existing.episodes = [existing.episode_number];
          if (!existing.episodes.includes(l.episode_number)) { existing.episodes.push(l.episode_number); existing.episodes.sort((a, b) => a - b); }
        } else {
          if (!existing.seasons) existing.seasons = [existing.season_number];
          if (!existing.seasons.includes(l.season_number)) { existing.seasons.push(l.season_number); existing.seasons.sort((a, b) => a - b); }
        }
      } else {
        acc[l.date].push({ ...l, log_ids: [l.id], episodes: l.episode_number !== null ? [l.episode_number] : null, seasons: (l.season_number !== null && l.episode_number === null) ? [l.season_number] : null });
      }
      return acc;
    }, {});
    return Object.values(grouped).flat().sort((a, b) => new Date(b.date) - new Date(a.date));
  }, [selectedShowLogs]);

  if (loading) return (
    <div className="tv-loading-screen">
      <div className="tv-loading-spinner" />
      <p>Loading your library...</p>
    </div>
  );

  // ─── RENDER ───────────────────────────────────────────────────────────
  // --- CALCULATE MODAL SUMMARY ---
  const selectedShowRated = selectedShowLogs.filter(l => l.rating > 0);
  const selectedShowAvg = selectedShowRated.length > 0 ? (selectedShowRated.reduce((acc, l) => acc + l.rating, 0) / selectedShowRated.length).toFixed(1) : null;

  // 🎨 RENDER 🎨
  return (
    <div className="tv-tracker" ref={trackerRef}>
      {/* NAV */}
      <div className="tv-header">
        <div className="tv-header-left">
          <div className="tv-tabs">
            {[
              { id: 'library', icon: '📚', label: 'Library' },
              { id: 'diary', icon: '📅', label: 'Diary' },
              { id: 'stats', icon: '📊', label: 'Stats' }
            ].map(t => (
              <button key={t.id} className={`tv-tab ${view === t.id ? 'active' : ''}`} onClick={() => setView(t.id)}>
                <span className="tv-tab-icon">{t.icon}</span> {t.label}
              </button>
            ))}
          </div>
          {(isSyncing || loading || searchLoading) && (
            <div className="tv-sync-indicator">
              <div className="tv-loading-spinner" style={{ width: '14px', height: '14px', borderWidth: '2px' }} />
              Loading...
            </div>
          )}
        </div>
        <div className="tv-header-actions">
          {showMovies && (
            <div className="tv-media-toggle">
              <button className={mediaType === 'all' ? 'active' : ''} onClick={() => { setMediaType('all'); }}>🍿 All</button>
              <button className={mediaType === 'movie' ? 'active' : ''} onClick={() => { setMediaType('movie'); if (statusFilter === 'DROPPED') setStatusFilter('WATCHED'); }}>🎬 Movies</button>
              <button className={mediaType === 'tv' ? 'active' : ''} onClick={() => { setMediaType('tv'); }}>📺 TV Shows</button>
            </div>
          )}
        </div>
      </div>

      {/* ─── LIBRARY ─── */}
      {view === 'library' && (
        <div>
          {/* Search */}
          {canEdit && (
          <div className="tv-search-wrap" ref={searchRef}>
            <div className="tv-search-bar">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              <input type="text" placeholder="Search TMDB to add a show..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} onFocus={() => searchResults.length > 0 && setShowDropdown(true)} />
              {searchLoading && <span className="tv-search-spinner" />}
            </div>
            {showDropdown && searchResults.length > 0 && (
              <div className="tv-search-dropdown">
                {searchResults.slice(0, 8).map(r => {
                  const added = shows.some(s => s.tmdb_id === r.id);
                  return (
                    <div key={r.id} className={`tv-search-item ${added ? 'added' : ''}`} onClick={() => addShow(r)}>
                      {r.poster_path ? <img src={`${TMDB_IMG}/w92${r.poster_path}`} alt="" /> : <div className="tv-search-item-noposter">{r.media_type === 'movie' ? '🎬' : '📺'}</div>}
                      <div className="tv-search-item-info">
                        <span className="tv-search-item-name">{r.name || r.title}</span>
                        <span className="tv-search-item-year">{r.media_type === 'movie' ? '🎬' : '📺'} {(r.first_air_date || r.release_date)?.split('-')[0] || 'N/A'}</span>
                      </div>
                      {added && <span className="tv-search-item-badge">In Library</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          )}

          {/* Filters & Pagination */}
          <div className="tv-controls-header">
            <div className="tv-filters" style={{ marginBottom: 0 }}>
              {[
                { key: 'WATCHING', label: 'Watching' },
                { key: 'TO WATCH', label: 'To Watch' },
                { key: 'WATCHED', label: 'Watched' },
                { key: 'DROPPED', label: 'Dropped' },
              ].map(f => (
                <button key={f.key} className={`tv-filter-pill ${statusFilter === f.key ? 'active' : ''}`} onClick={() => setStatusFilter(f.key)}>
                  {f.label}
                </button>
              ))}
              <button
                className={`tv-filter-pill ${showMoreFilters ? 'active' : ''}`}
                onClick={() => { if (!filterOptions) fetchFilterOptions(); setShowMoreFilters(v => !v); }}
              >
                ⚙️ More Filters
                {hasActiveLibraryFilters && (
                  <span style={{ width: '6px', height: '6px', borderRadius: '50%', background: 'var(--accent)', display: 'inline-block' }} />
                )}
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <div className="tv-media-toggle tv-size-toggle">
                {['small', 'medium', 'large'].map((size, i) => (
                  <button
                    key={size}
                    className={posterSize === size ? 'active' : ''}
                    onClick={() => setPosterSize(size)}
                    title={`${size.charAt(0).toUpperCase()}${size.slice(1)} thumbnails`}
                  >
                    <GridSizeIcon cols={4 - i} />
                  </button>
                ))}
              </div>

              {showsTotalCount > ITEMS_PER_PAGE && (
                <div className="tv-pagination">
                  <button
                    onClick={() => setShowsPage(prev => Math.max(1, prev - 1))}
                    disabled={showsPage === 1}
                    style={{ padding: '0.35rem 0.65rem', borderRadius: '6px', border: '1px solid var(--border)', background: showsPage === 1 ? 'rgba(255,255,255,0.05)' : 'var(--bg-input)', color: showsPage === 1 ? 'var(--text2)' : 'var(--text)', cursor: showsPage === 1 ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}
                  >
                    ←
                  </button>

                  {Array.from({ length: Math.min(5, Math.ceil(showsTotalCount / ITEMS_PER_PAGE)) }, (_, i) => {
                    const totalPages = Math.ceil(showsTotalCount / ITEMS_PER_PAGE);
                    let pageNum;
                    if (totalPages <= 5) pageNum = i + 1;
                    else if (showsPage < 3) pageNum = i + 1;
                    else if (showsPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                    else pageNum = showsPage - 2 + i;

                    return (
                      <button
                        key={pageNum}
                        onClick={() => setShowsPage(pageNum)}
                        style={{
                          padding: '0.35rem 0.65rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
                          border: pageNum === showsPage ? '1px solid var(--accent)' : '1px solid var(--border)',
                          background: pageNum === showsPage ? 'rgba(var(--accent-rgb), 0.2)' : 'var(--bg-input)',
                          color: pageNum === showsPage ? 'var(--accent)' : 'var(--text2)',
                          fontWeight: pageNum === showsPage ? 600 : 400
                        }}
                      >
                        {pageNum}
                      </button>
                    );
                  })}

                  <button
                    onClick={() => setShowsPage(prev => Math.min(Math.ceil(showsTotalCount / ITEMS_PER_PAGE), prev + 1))}
                    disabled={showsPage === Math.ceil(showsTotalCount / ITEMS_PER_PAGE)}
                    style={{ padding: '0.35rem 0.65rem', borderRadius: '6px', border: '1px solid var(--border)', background: showsPage === Math.ceil(showsTotalCount / ITEMS_PER_PAGE) ? 'rgba(255,255,255,0.05)' : 'var(--bg-input)', color: showsPage === Math.ceil(showsTotalCount / ITEMS_PER_PAGE) ? 'var(--text2)' : 'var(--text)', cursor: showsPage === Math.ceil(showsTotalCount / ITEMS_PER_PAGE) ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}
                  >
                    →
                  </button>
                </div>
              )}
            </div>
          </div>

          {showMoreFilters && (
            <div className="tv-filters" style={{ marginTop: '-0.75rem' }}>
              <CustomSelect
                icon="📅"
                value={yearFilter}
                onChange={setYearFilter}
                options={[{ value: 'all', label: 'All Years' }, ...(filterOptions?.years || []).map(y => ({ value: String(y), label: String(y) }))]}
                minWidth="110px"
              />
              <CustomSelect
                icon="📊"
                value={monthFilter}
                onChange={setMonthFilter}
                options={[{ value: 'all', label: 'All Months' }, ...MONTHS_SHORT.map((m, i) => ({ value: String(i + 1), label: m }))]}
                minWidth="120px"
              />
              <CustomSelect
                icon="📈"
                value={weekFilter}
                onChange={setWeekFilter}
                options={[{ value: 'all', label: 'All Weeks' }, ...Array.from({ length: 52 }, (_, i) => ({ value: String(i + 1), label: weekLabel(yearFilter, i + 1) }))]}
                minWidth={yearFilter === 'all' ? '110px' : '170px'}
              />
              <CustomSelect
                icon="🗓️"
                value={weekdayFilter}
                onChange={setWeekdayFilter}
                options={[{ value: 'all', label: 'Any Day' }, ...WEEKDAYS_LONG.map((d, i) => ({ value: String(i), label: d }))]}
                minWidth="120px"
              />
              <CustomSelect
                icon="⭐"
                value={ratingFilter}
                onChange={setRatingFilter}
                options={[{ value: 'all', label: 'Any Rating' }, ...['5.0', '4.5', '4.0', '3.5', '3.0', '2.5', '2.0', '1.5', '1.0', '0.5'].map(r => ({ value: r, label: starsLabel(r) }))]}
                minWidth="120px"
              />
              <CustomSelect
                icon="🌐"
                value={languageFilter}
                onChange={setLanguageFilter}
                options={[{ value: 'all', label: 'All Languages' }, ...(filterOptions?.languages || []).map(l => ({ value: l.code, label: l.label }))]}
                minWidth="140px"
              />
              {hasActiveLibraryFilters && (
                <button className="tv-filter-pill" onClick={clearLibraryFilters}>
                  ✕ Clear
                </button>
              )}
            </div>
          )}

          {/* The active slice as removable chips — how a Stats jump shows what it filtered. */}
          {!showMoreFilters && hasActiveLibraryFilters && (
            <div className="tv-active-filters">
              {[
                yearFilter !== 'all' && { key: 'year', label: yearFilter, clear: () => setYearFilter('all') },
                monthFilter !== 'all' && { key: 'month', label: MONTHS_LONG[Number(monthFilter) - 1] || monthFilter, clear: () => setMonthFilter('all') },
                weekFilter !== 'all' && { key: 'week', label: weekLabel(yearFilter, Number(weekFilter)), clear: () => setWeekFilter('all') },
                weekdayFilter !== 'all' && { key: 'weekday', label: `${WEEKDAYS_LONG[Number(weekdayFilter)] || weekdayFilter}s`, clear: () => setWeekdayFilter('all') },
                ratingFilter !== 'all' && { key: 'rating', label: `Rated ${starsLabel(ratingFilter)}`, clear: () => setRatingFilter('all') },
                languageFilter !== 'all' && {
                  key: 'language',
                  label: filterOptions?.languages?.find(l => l.code === languageFilter)?.label || languageFilter.toUpperCase(),
                  clear: () => setLanguageFilter('all'),
                },
              ].filter(Boolean).map(chip => (
                <button key={chip.key} className="tv-active-chip" onClick={chip.clear} title="Remove this filter">
                  {chip.label}
                  <span className="tv-active-chip-x" aria-hidden="true">✕</span>
                </button>
              ))}
              <button className="tv-active-clear" onClick={clearLibraryFilters}>Clear all</button>
            </div>
          )}

          {/* Grid */}
          <div className="tv-poster-grid" data-size={posterSize}>
            {filteredShows.map(show => (
              <div key={`${show.type}-${show.id}`} className="tv-poster-card" onClick={() => openModal(show)}>
                <div className="tv-poster-img-wrap">
                  {show.poster_path ? <img src={`${TMDB_IMG}/${POSTER_IMG_SIZE[posterSize]}${show.poster_path}`} alt={show.name} loading="lazy" style={show.isAdding ? { filter: 'blur(4px) grayscale(0.5)' } : {}} /> : <div className="tv-poster-fallback"><span>{show.type === 'movie' ? '🎬' : '📺'}</span>{show.name}</div>}
                  <div className="tv-poster-gradient" />
                  {show.isAdding && (
                    <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.4)', zIndex: 10 }}>
                      <div className="tv-loading-spinner" style={{ width: '32px', height: '32px', borderWidth: '3px' }} />
                    </div>
                  )}
                  {mediaType === 'all' && <div className="tv-poster-type-badge">{show.type === 'movie' ? '🎬' : '📺'}</div>}
                  <div className="tv-poster-status"><span className={`tv-status-chip ${show.status.toLowerCase().replace(/\s/g, '-')}`}>{show.status}</span></div>
                </div>
                <div className="tv-poster-name">{show.name}</div>
              </div>
            ))}
            {filteredShows.length === 0 && (
              <div className="tv-empty-state">
                <span style={{ fontSize: '2.5rem' }}>{mediaType === 'movie' ? '🎬' : mediaType === 'tv' ? '📺' : '🍿'}</span>
                <p>
                  {hasActiveLibraryFilters
                    ? `No ${mediaType === 'movie' ? 'movies' : mediaType === 'tv' ? 'shows' : 'titles'} match these filters.`
                    : statusFilter === 'all'
                      ? `Your library is empty. Search above to add ${mediaType === 'movie' ? 'movies' : mediaType === 'tv' ? 'shows' : 'titles'}!`
                      : `No "${statusFilter}" ${mediaType === 'movie' ? 'movies' : mediaType === 'tv' ? 'shows' : 'titles'}`}
                </p>
              </div>
            )}
          </div>

          {/* Empty Space for bottom padding since pagination is moved to top */}
          <div style={{ height: '6rem' }} />
        </div>
      )}

      {/* ─── DIARY ─── */}
      {view === 'diary' && (
        <div className="tv-diary-view" style={{ paddingBottom: '6rem' }}>
          {Object.keys(groupedDiary).length === 0 ? (
            <div className="tv-empty-state"><span style={{ fontSize: '2.5rem' }}>📅</span><p>Your diary is empty. Log what you watch!</p></div>
          ) : (
            <>
              <div className="tv-diary-list-container">
                {Object.keys(groupedDiary)
                  .sort((a, b) => new Date(b) - new Date(a))
                  .map(date => {
                    const logs = groupedDiary[date];
                    return (
                      <div key={date} className="tv-diary-group">
                        <div className="tv-diary-date-header"><span className="tv-diary-date-dot" />{fmtDate(date)}</div>
                        <div className="tv-diary-entries-grid">
                          {logs.map(log => (
                            <div key={log.id} className="tv-diary-entry">
                              <div className="tv-diary-entry-poster">
                                {log.poster_path ? <img src={`${TMDB_IMG}/w154${log.poster_path}`} alt={log.show_name} /> : <div className="tv-diary-entry-noposter">📺</div>}
                              </div>
                              <div className="tv-diary-entry-content">
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem', marginBottom: '0.3rem', minWidth: 0 }}>
                                  <h4 className="tv-diary-entry-title" style={{ margin: 0, flex: 1, minWidth: 0, wordBreak: 'break-word' }}>
                                    {log.show_name}
                                    {log.liked && <span style={{ marginLeft: '6px', fontSize: '0.9em', color: '#ff4d4f' }}>❤️</span>}
                                    {log.rewatch && <span style={{ marginLeft: '6px', fontSize: '0.9em' }}>🔄</span>}
                                  </h4>
                                  {canEdit && (
                                  <div className="tv-diary-entry-actions">
                                    <button onClick={() => editLog(log)} title="Edit Log">✏️</button>
                                    <button onClick={() => deleteLog(log.log_ids || [log.id], log.type)} title="Delete Log">🗑️</button>
                                  </div>
                                  )}
                                </div>
                                <div className="tv-diary-entry-meta">
                                  {log.type === 'movie' ? (
                                    <span className="tv-ep-badge tv-ep-badge-movie">🎬 Movie</span>
                                  ) : log.season_number !== null && log.episodes ? (
                                    <span className="tv-ep-badge">S{String(log.season_number).padStart(2, '0')} E{log.episodes.join(', ')}</span>
                                  ) : log.seasons && log.seasons.length > 1 ? (
                                    <span className="tv-ep-badge">Seasons {log.seasons.join(', ')}</span>
                                  ) : log.season_number !== null ? (
                                    <span className="tv-ep-badge">Season {log.season_number}</span>
                                  ) : (
                                    <span className="tv-ep-badge tv-ep-badge-show">📺 Entire Show</span>
                                  )}
                                  {log.rating > 0 && <StarDisplay value={log.rating} />}
                                </div>
                                {log.review && (
                                  <p className="tv-diary-entry-review">
                                    "{expandedLogs[log.id] || log.review.length <= 150 ? log.review : `${log.review.substring(0, 150).trim()}...`}"
                                    {log.review.length > 150 && (
                                      <span
                                        onClick={() => setExpandedLogs(prev => ({ ...prev, [log.id]: !prev[log.id] }))}
                                        style={{ display: 'block', marginTop: '0.4rem', color: 'var(--accent)', cursor: 'pointer', fontWeight: 600, fontSize: '0.75rem' }}
                                      >
                                        {expandedLogs[log.id] ? 'Show less' : 'Read more'}
                                      </span>
                                    )}
                                  </p>
                                )}
                                {log.tags && (
                                  <div className="tv-diary-tags-row">
                                    {log.tags.split(',').map((t, i) => <span key={i} className="tv-diary-tag">{t.trim()}</span>)}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
              </div>

              <div className="tv-pagination" style={{ marginTop: '1.5rem', marginBottom: '4rem' }}>
                <button
                  onClick={() => setDiaryPage(prev => Math.max(1, prev - 1))}
                  disabled={diaryPage === 1}
                  style={{ padding: '0.35rem 0.65rem', borderRadius: '6px', border: '1px solid var(--border)', background: diaryPage === 1 ? 'rgba(255,255,255,0.05)' : 'var(--bg-input)', color: diaryPage === 1 ? 'var(--text2)' : 'var(--text)', cursor: diaryPage === 1 ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}
                >
                  ← Prev
                </button>

                {Array.from({ length: Math.min(5, Math.ceil(diaryTotalCount / 20)) }, (_, i) => {
                  const totalPages = Math.ceil(diaryTotalCount / 20);
                  let pageNum;
                  if (totalPages <= 5) pageNum = i + 1;
                  else if (diaryPage < 3) pageNum = i + 1;
                  else if (diaryPage >= totalPages - 2) pageNum = totalPages - 4 + i;
                  else pageNum = diaryPage - 2 + i;

                  return (
                    <button
                      key={pageNum}
                      onClick={() => setDiaryPage(pageNum)}
                      style={{
                        padding: '0.35rem 0.65rem', borderRadius: '6px', cursor: 'pointer', fontSize: '0.8rem',
                        border: pageNum === diaryPage ? '1px solid var(--accent)' : '1px solid var(--border)',
                        background: pageNum === diaryPage ? 'rgba(var(--accent-rgb), 0.2)' : 'var(--bg-input)',
                        color: pageNum === diaryPage ? 'var(--accent)' : 'var(--text2)',
                        fontWeight: pageNum === diaryPage ? 600 : 400
                      }}
                    >
                      {pageNum}
                    </button>
                  );
                })}

                <button
                  onClick={() => setDiaryPage(prev => Math.min(Math.ceil(diaryTotalCount / 20), prev + 1))}
                  disabled={diaryPage === Math.ceil(diaryTotalCount / 20) || diaryTotalCount === 0}
                  style={{ padding: '0.35rem 0.65rem', borderRadius: '6px', border: '1px solid var(--border)', background: diaryPage === Math.ceil(diaryTotalCount / 20) || diaryTotalCount === 0 ? 'rgba(255,255,255,0.05)' : 'var(--bg-input)', color: diaryPage === Math.ceil(diaryTotalCount / 20) || diaryTotalCount === 0 ? 'var(--text2)' : 'var(--text)', cursor: diaryPage === Math.ceil(diaryTotalCount / 20) || diaryTotalCount === 0 ? 'not-allowed' : 'pointer', fontSize: '0.8rem' }}
                >
                  Next →
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* ─── SHOW MODAL ─── */}
      {selectedShow && (
        <div className="tv-modal-overlay" onClick={closeModal}>
          <div className="tv-modal-panel" onClick={e => e.stopPropagation()}>
            <button className="tv-modal-x" onClick={closeModal}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
            </button>

            {/* Hero */}
            <div className="tv-modal-hero">
              {selectedShow.poster_path && <img className="tv-modal-hero-poster" src={`${TMDB_IMG}/w300${selectedShow.poster_path}`} alt="" />}
              <div className="tv-modal-hero-info">
                <h2>{selectedShow.name}</h2>
                {showDetailsLoading ? (
                  <div className="tv-modal-hero-meta" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span className="tv-search-spinner" style={{ width: '16px', height: '16px', borderTopColor: 'var(--accent)' }} /> Loading info...
                  </div>
                ) : showDetails && (
                  <div className="tv-modal-hero-meta">
                    {selectedShow.type === 'tv' ? (
                      <>
                        <span>{showDetails.number_of_seasons} Season{showDetails.number_of_seasons !== 1 ? 's' : ''}</span>
                        <span className="tv-meta-dot">·</span>
                        <span>{showDetails.number_of_episodes} Episodes</span>
                      </>
                    ) : (
                      <>
                        {showDetails.release_date && <span>{showDetails.release_date.split('-')[0]}</span>}
                        {showDetails.runtime && (
                          <>
                            <span className="tv-meta-dot">·</span>
                            <span>{Math.floor(showDetails.runtime / 60)}h {showDetails.runtime % 60}m</span>
                          </>
                        )}
                        {showDetails.aggregate_credits?.crew?.find(c => c.job === 'Director') && (
                          <>
                            <span className="tv-meta-dot">·</span>
                            <span>Dir. {showDetails.aggregate_credits.crew.find(c => c.job === 'Director').name}</span>
                          </>
                        )}
                      </>
                    )}
                    <span className="tv-meta-dot">·</span>
                    <span>{showDetails.status}</span>
                  </div>
                )}
                <div className="tv-modal-status-row">
                  {(selectedShow.type === 'movie' ? ['WATCHED', 'TO WATCH'] : ['WATCHING', 'WATCHED', 'TO WATCH', 'DROPPED']).filter(s => canEdit || selectedShow.status === s).map(s => (
                    <button key={s} className={`tv-status-option ${selectedShow.status === s ? 'active' : ''}`} onClick={canEdit ? () => updateStatus(s) : undefined} style={canEdit ? undefined : { cursor: 'default' }}>
                      {s === 'WATCHING' ? '👁️' : s === 'WATCHED' ? '✅' : s === 'TO WATCH' ? '📋' : '🗑️'} {s}
                    </button>
                  ))}
                </div>
                {selectedShowLogs.length > 0 && (
                  <div className="tv-modal-stats-row" style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', gap: '12px', fontSize: '0.85rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: 'var(--accent)', fontWeight: 600 }}>
                      <span>📝</span>
                      <span>{groupedModalLogs.length} Log{groupedModalLogs.length !== 1 ? 's' : ''}</span>
                    </div>
                    {selectedShowAvg && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '4px', color: '#f59e0b', fontWeight: 600 }}>
                        <span>⭐️</span>
                        <span>{selectedShowAvg} - My Avg Rating</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {showDetails?.overview && <p className="tv-modal-overview">{showDetails.overview}</p>}

            {/* Tabs */}
            <div className="tv-modal-tabs">
              {canEdit && (
              <button className={modalView === 'log' ? 'active' : ''} onClick={() => setModalView('log')}>
                <span>📝</span><span>Log</span>
              </button>
              )}
              {selectedShowLogs.length > 0 && (
                <button className={modalView === 'diary' ? 'active' : ''} onClick={() => setModalView('diary')}>
                  <span>📖</span><span> Diary ({groupedModalLogs.length})</span>
                </button>
              )}
              <button className={modalView === 'details' ? 'active' : ''} onClick={() => setModalView('details')}>
                <span>👥</span><span>Details</span>
              </button>
              {canEdit && selectedShow.type === 'movie' && (
                <button className={modalView === 'rematch' ? 'active' : ''}onClick={() => { setModalView('rematch'); setRematchQuery(''); setRematchResults([]); }}>
                  <span>🔄</span><span>Fix Match</span>
                </button>
              )}
            </div>

            {modalView === 'log' && (
              <div className="tv-modal-log-section">
                {editingLog && (
                  <div style={{ background: 'rgba(var(--accent-rgb), 0.1)', color: 'var(--accent)', padding: '0.75rem 1rem', borderRadius: '8px', marginBottom: '1.25rem', fontSize: '0.85rem', fontWeight: 700, display: 'flex', justifyContent: 'space-between', alignItems: 'center', border: '1px solid rgba(var(--accent-rgb), 0.2)' }}>
                    <span>
                      ✏️ Editing {editingLog.type === 'tv' ? (editingLog.season_number ? (editingLog.episode_number ? `S${editingLog.season_number} E${editingLog.episode_number}` : `Season ${editingLog.season_number}`) : 'Show') : 'Movie'} Log
                    </span>
                    <button onClick={() => {
                      setEditingLog(null); setEditingLogIds([]); setLogRating(0); setLogReview(''); setLogTags(''); setLogLiked(false); setLogRewatch(false); setLogEpisodes([]); setLogSeasons([]);
                    }} style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', cursor: 'pointer', fontSize: '0.75rem', fontWeight: 700, padding: '0.35rem 0.75rem', borderRadius: '6px' }}>Cancel</button>
                  </div>
                )}
                <div className="tv-log-grid">
                  <div className="tv-log-field">
                    <label>Date</label>
                    <input type="date" value={logDate} onChange={e => setLogDate(e.target.value)} />
                  </div>
                  {selectedShow.type === 'tv' && (
                    <div className="tv-log-field tv-log-field-full">
                      <label>Seasons</label>
                      <div className="tv-ep-grid" style={{ marginBottom: '0.75rem' }}>
                        <button type="button" className={`tv-ep-btn ${logSeasons.length === 0 ? 'selected' : ''}`} onClick={() => { setLogSeasons([]); setLogEpisodes([]); }}>
                          All
                        </button>
                        {getSeasons().map(s => (
                          <button
                            key={s.season_number}
                            type="button"
                            className={`tv-ep-btn ${logSeasons.includes(s.season_number) ? 'selected' : ''} ${isSeasonWatched(s.season_number) ? 'watched' : ''}`}
                            onClick={() => {
                              setLogSeasons(prev => {
                                const newSeasons = prev.includes(s.season_number) ? prev.filter(x => x !== s.season_number) : [...prev, s.season_number];
                                return newSeasons;
                              });
                              setLogEpisodes([]);
                            }}
                          >
                            S{s.season_number}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedShow.type === 'tv' && logSeasons.length === 1 && (
                    <div className="tv-log-field tv-log-field-full">
                      <label>Episodes for Season {logSeasons[0]}</label>
                      <div className="tv-ep-grid">
                        <button type="button" className={`tv-ep-btn ${logEpisodes.length === getEpisodes().length ? 'selected' : ''}`} onClick={selectAllEpisodes}>
                          All
                        </button>
                        {getEpisodes().map(ep => (
                          <button key={ep} type="button" className={`tv-ep-btn ${logEpisodes.includes(ep) ? 'selected' : ''} ${isEpisodeWatched(ep) ? 'watched' : ''}`} onClick={() => toggleEpisode(ep)}>
                            {ep}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="tv-log-field tv-log-field-full">
                    <label>Rating & Like</label>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                      <StarRating value={logRating} onChange={setLogRating} size={26} />
                      <button
                        type="button"
                        onClick={() => setLogLiked(!logLiked)}
                        style={{ background: 'none', border: 'none', fontSize: '1.6rem', cursor: 'pointer', filter: logLiked ? 'none' : 'grayscale(1) opacity(0.3)' }}
                        title="Like"
                      >❤️</button>
                      <button
                        type="button"
                        onClick={() => setLogRewatch(!logRewatch)}
                        style={{ background: 'none', border: 'none', fontSize: '1.6rem', cursor: 'pointer', filter: logRewatch ? 'none' : 'grayscale(1) opacity(0.3)' }}
                        title="Rewatch"
                      >🔄</button>
                    </div>
                  </div>
                  <div className="tv-log-field tv-log-field-full" style={{ flexGrow: 1, display: 'flex', flexDirection: 'column' }}>
                    <label>Review</label>
                    <textarea style={{ flexGrow: 1, minHeight: '120px', resize: 'vertical' }} value={logReview} onChange={e => setLogReview(e.target.value)} placeholder="What did you think?" />
                  </div>
                  <div className="tv-log-field tv-log-field-full">
                    <label>Tags</label>
                    <input type="text" value={logTags} onChange={e => setLogTags(e.target.value)} placeholder="Comma separated (e.g. Rewatch, Comfort)" />
                  </div>
                </div>
                <div className="tv-log-actions">
                  <button className="tv-log-save" onClick={saveDiaryLog} disabled={logSaving || (!editingLogIds && logSeasons.length === 1 && logEpisodes.length === 0)}>{logSaving ? 'Saving...' : '💾 Save to Diary'}</button>
                  <button className="tv-log-delete" onClick={deleteShow}>🗑️ Remove</button>
                </div>
              </div>
            )}

            {modalView === 'details' && (
              <div className="tv-modal-details-section">
                {showDetails?.aggregate_credits?.cast && showDetails.aggregate_credits.cast.length > 0 ? (
                  <div>
                    <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1rem' }}>Top Cast</h3>
                    <div className="tv-cast-grid">
                      {showDetails.aggregate_credits.cast.slice(0, 8).map(actor => (
                        <div key={actor.id} className="tv-cast-card">
                          {actor.profile_path ? (
                            <img src={`${TMDB_IMG}/w138_and_h175_face${actor.profile_path}`} alt={actor.name} />
                          ) : (
                            <div className="tv-cast-nopfp">👤</div>
                          )}
                          <div className="tv-cast-info">
                            <div className="tv-cast-name">{actor.name}</div>
                            <div className="tv-cast-role">{actor.roles ? actor.roles[0]?.character : actor.character}</div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p style={{ color: 'var(--text2)' }}>No cast information available.</p>
                )}

                {showDetails?.aggregate_credits?.crew && showDetails.aggregate_credits.crew.length > 0 && (
                  <div style={{ marginTop: '1.5rem' }}>
                    <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1rem' }}>Key Crew</h3>
                    <div className="tv-cast-grid">
                      {showDetails.aggregate_credits.crew
                        .filter(c => ['Director', 'Executive Producer', 'Writer', 'Creator'].includes(c.job || c.department))
                        .reduce((unique, item) => unique.some(u => u.id === item.id) ? unique : [...unique, item], [])
                        .slice(0, 8)
                        .map(crew => (
                          <div key={`crew-${crew.id}`} className="tv-cast-card">
                            {crew.profile_path ? (
                              <img src={`${TMDB_IMG}/w138_and_h175_face${crew.profile_path}`} alt={crew.name} />
                            ) : (
                              <div className="tv-cast-nopfp">👤</div>
                            )}
                            <div className="tv-cast-info">
                              <div className="tv-cast-name">{crew.name}</div>
                              <div className="tv-cast-role">{crew.jobs ? crew.jobs[0]?.job : crew.job}</div>
                            </div>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {modalView === 'diary' && (
              <div className="tv-modal-details-section" style={{ padding: '1.25rem 1.5rem 1.5rem' }}>
                <h3 style={{ marginTop: 0, marginBottom: '1rem', fontSize: '1rem' }}>Your Logs</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', maxHeight: '50vh', overflowY: 'auto', paddingRight: '0.5rem' }}>
                  {groupedModalLogs.map(log => (
                    <div key={log.id} className="tv-modal-diary-entry" style={{ display: 'flex', flexDirection: 'column', background: 'var(--bg2)', borderRadius: '12px', padding: '1.25rem', border: '1px solid var(--border)', transition: 'transform 0.2s, border-color 0.2s' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: log.review || log.tags ? '0.65rem' : '0' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                          <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--text)', fontFamily: "'Syne', sans-serif" }}>
                            {log.type === 'tv' ? (
                              log.season_number !== null && log.episodes ? `S${log.season_number} E${log.episodes.join(', ')}`
                                : log.seasons && log.seasons.length > 1 ? `Seasons ${log.seasons.join(', ')}`
                                  : log.season_number !== null ? `Season ${log.season_number}`
                                    : 'Show'
                            ) : 'Movie'}
                            <span style={{ color: 'var(--text3)', marginLeft: '8px', fontSize: '0.75rem', fontWeight: 500, fontFamily: "'DM Sans', sans-serif" }}>{fmtDate(log.date)}</span>
                          </div>

                          {(log.rating > 0 || log.liked || log.rewatch) && (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', paddingLeft: '6px', borderLeft: '1px solid var(--border)' }}>
                              <StarDisplay value={log.rating} size={14} />
                              {log.liked && <span title="Liked" style={{ fontSize: '0.8rem' }}>❤️</span>}
                              {log.rewatch && <span title="Rewatch" style={{ fontSize: '0.8rem' }}>🔄</span>}
                            </div>
                          )}
                        </div>
                        {canEdit && <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                          <button onClick={() => { editLog(log); setModalView('log'); }}style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', cursor: 'pointer', width: '28px', height: '28px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Edit Log">✏️</button>
                          <button onClick={() => deleteLog(log.log_ids || [log.id], log.type)} style={{ background: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', cursor: 'pointer', width: '28px', height: '28px', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="Delete Log">🗑️</button>
                        </div>}
                      </div>

                      {log.review && (
                        <p style={{ fontSize: '0.85rem', color: 'var(--text2)', margin: '0 0 0.75rem 0', lineHeight: 1.6, whiteSpace: 'pre-wrap', background: 'var(--bg)', padding: '0.75rem', borderRadius: '8px', borderLeft: '2px solid var(--accent)', fontStyle: 'italic' }}>{log.review}</p>
                      )}
                      {log.tags && (
                        <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                          {log.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => (
                            <span key={t} style={{ background: 'var(--bg)', padding: '2px 6px', borderRadius: '4px', fontSize: '0.7rem', color: 'var(--text3)', border: '1px solid var(--border)' }}>{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {modalView === 'rematch' && (
              <div className="tv-modal-details-section" style={{ padding: '1.25rem 1.5rem 1.5rem' }}>
                <p style={{ margin: '0 0 1rem 0', fontSize: '0.85rem', color: 'var(--text2)', lineHeight: 1.5 }}>
                  Wrong movie? Search for the correct one below. Add the release year for better results (e.g. <strong>Prince 2022</strong>).
                </p>
                <div className="tv-search-bar" style={{ marginBottom: '1rem' }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text2)" strokeWidth="2"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                  <input
                    type="text"
                    value={rematchQuery}
                    onChange={e => setRematchQuery(e.target.value)}
                    placeholder="e.g. Prince 2022"
                    autoFocus
                    style={{ width: '100%' }}
                    disabled={!!rematchSaving}
                  />
                  {rematchLoading && <span className="tv-search-spinner" />}
                </div>
                <div style={{ maxHeight: '40vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  {rematchResults.map(r => {
                    const isSaving = rematchSaving === r.id;
                    return (
                      <div
                        key={r.id}
                        onClick={() => handleRematch(r)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: '12px', padding: '0.6rem 0.75rem',
                          borderRadius: '10px', cursor: rematchSaving ? 'wait' : 'pointer',
                          border: isSaving ? '1.5px solid var(--accent)' : '1px solid var(--border)',
                          background: isSaving ? 'rgba(var(--accent-rgb), 0.1)' : 'var(--bg2)',
                          opacity: rematchSaving && !isSaving ? 0.4 : 1,
                          transition: 'all 0.15s ease',
                          pointerEvents: rematchSaving ? 'none' : 'auto'
                        }}
                        onMouseEnter={e => { if (!rematchSaving) { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.background = 'rgba(var(--accent-rgb), 0.06)'; } }}
                        onMouseLeave={e => { if (!rematchSaving) { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.background = 'var(--bg2)'; } }}
                      >
                        {r.poster_path ? (
                          <img src={`${TMDB_IMG}/w92${r.poster_path}`} alt="" style={{ width: '40px', borderRadius: '4px', flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: '40px', height: '60px', background: 'var(--bg)', borderRadius: '4px', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem' }}>🎬</div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: '0.95rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name || r.title}</div>
                          <div style={{ color: 'var(--text2)', fontSize: '0.8rem' }}>{(r.release_date || r.first_air_date)?.split('-')[0] || 'N/A'}{r.vote_average ? ` · ⭐ ${r.vote_average.toFixed(1)}` : ''}</div>
                          {r.overview && <div style={{ color: 'var(--text3)', fontSize: '0.75rem', marginTop: '2px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{r.overview}</div>}
                        </div>
                        {isSaving && (
                          <span className="tv-search-spinner" style={{ width: '18px', height: '18px', flexShrink: 0, borderTopColor: 'var(--accent)' }} />
                        )}
                      </div>
                    );
                  })}
                  {!rematchLoading && rematchResults.length === 0 && rematchQuery.trim() && (
                    <p style={{ textAlign: 'center', color: 'var(--text3)', fontSize: '0.85rem', padding: '2rem 0' }}>No results found. Try adding the year (e.g. "Prince 2022").</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {/* ─── STATS ─── */}
      {view === 'stats' && (
        <StatsView API={API} getToken={getToken} statsData={statsData} setStatsData={setStatsData} statsYear={statsYear} setStatsYear={setStatsYear} statsLoading={statsLoading} setStatsLoading={setStatsLoading} openModal={openModal} onFilterLibrary={handleFilterLibrary} refreshTrigger={refreshTrigger} mediaType={mediaType} showMovies={showMovies} />
      )}
    </div>
  );
}

export default memo(SabDekho);
