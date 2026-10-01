from flask import Blueprint, request, jsonify
from datetime import datetime, date, timedelta, timezone
import os
import re
import json
import pytz
import requests
from extensions import (
    db,
    SHEETS_URL, JWT_SECRET, ALLOWED_EMAILS, ADMIN_USER, ADMIN_PASS,
    KITE_API_KEY, KITE_API_SECRET, TMDB_API_KEY,
)
from models import *
from access import require_api_key, require_admin, require_access, current_access
from tenancy import data_owner

from sqlalchemy.orm import joinedload
import xml.etree.ElementTree as ET
from flask import stream_with_context, Response

media_bp = Blueprint("media", __name__)

from sqlalchemy import text as sql_text
from sqlalchemy.sql import func as sql_func

IST = pytz.timezone('Asia/Kolkata')


def _ist_today():
    """Today's date where the user is — the server itself runs on UTC."""
    return datetime.now(IST).date()


# ISO 639-1 -> display name for the languages that actually show up in this
# library. An unmapped code just renders as its uppercase form.
_LANGUAGE_NAMES = {
    "en": "English", "hi": "Hindi", "ta": "Tamil", "te": "Telugu", "ml": "Malayalam",
    "kn": "Kannada", "bn": "Bengali", "mr": "Marathi", "pa": "Punjabi", "gu": "Gujarati",
    "ja": "Japanese", "ko": "Korean", "zh": "Chinese", "cn": "Chinese", "fr": "French",
    "es": "Spanish", "de": "German", "it": "Italian", "pt": "Portuguese", "ru": "Russian",
    "ar": "Arabic", "th": "Thai", "id": "Indonesian", "tr": "Turkish", "nl": "Dutch",
    "sv": "Swedish", "da": "Danish", "no": "Norwegian", "fi": "Finnish", "pl": "Polish",
    "he": "Hebrew", "vi": "Vietnamese", "fa": "Persian", "ur": "Urdu",
    "tl": "Tagalog", "si": "Sinhala", "lv": "Latvian", "ro": "Romanian",
    "cs": "Czech", "el": "Greek", "hu": "Hungarian", "uk": "Ukrainian", "ms": "Malay",
    "ne": "Nepali", "as": "Assamese", "or": "Odia", "sr": "Serbian", "sk": "Slovak",
    "bg": "Bulgarian", "hr": "Croatian", "lt": "Lithuanian", "et": "Estonian",
}


def _language_label(code):
    """A display name for an ISO 639-1 code, or "Unknown" when unset."""
    if not code:
        return "Unknown"
    return _LANGUAGE_NAMES.get(code.lower(), code.upper())


def _group_top_languages(counts, limit=10):
    """
    {code: count} -> a chart-ready list, the biggest `limit - 1` languages plus
    everything else folded into a single "Other" bar. Keeps the chart to a size
    that still centers instead of forcing a scrollable, left-aligned row.

    `code` is the raw ISO 639-1 code (or "unknown" for unset), kept alongside
    the display label so a bar click can filter the library by the exact same
    value. The "Other" bucket has no single code — it isn't a valid filter, so
    its `code` is None and the frontend disables clicking it.
    """
    def entry(code, count):
        label = "Unknown" if code == "unknown" else _language_label(code)
        return {"code": code, "language": label, "count": count}

    items = sorted(counts.items(), key=lambda kv: -kv[1])
    if len(items) <= limit:
        return [entry(c, v) for c, v in items]
    top = items[:limit - 1]
    other_count = sum(v for _, v in items[limit - 1:])
    result = [entry(c, v) for c, v in top]
    result.append({"code": None, "language": "Other", "count": other_count})
    return result


def fetch_tmdb_tv_language(tmdb_id, session=None, timeout=5):
    """Original language (ISO 639-1) for a show from TMDB, or None on failure."""
    if not TMDB_API_KEY or not tmdb_id:
        return None
    url = f"https://api.themoviedb.org/3/tv/{tmdb_id}?language=en-US"
    try:
        if session is not None:
            resp = session.get(url, timeout=timeout)
        else:
            resp = requests.get(
                url,
                headers={"accept": "application/json", "Authorization": f"Bearer {TMDB_API_KEY}"},
                timeout=timeout,
            )
        if resp.status_code != 200:
            return None
        return resp.json().get('original_language') or None
    except Exception as e:
        print(f"TMDB language fetch failed for {tmdb_id}: {e}")
        return None


def fetch_tmdb_movie_details(tmdb_id, session=None, timeout=5):
    """
    Fetch the details every movie row should carry (runtime, release date/year,
    director, top 3 cast, original language) in one TMDB call.

    Shared by every path that creates or re-matches a Movie — manual add,
    rematch, Letterboxd import and Cinema transactions — so they all store the
    same fields. Never raises: on any failure it returns the same shape with
    None values and `fetched` False, so callers can tell "TMDB has no director"
    apart from "the request failed".
    """
    result = {
        "fetched": False, "runtime": None, "release_date": None,
        "release_year": None, "director": None, "top_cast": None, "language": None,
    }
    if not TMDB_API_KEY or not tmdb_id:
        return result

    url = f"https://api.themoviedb.org/3/movie/{tmdb_id}?append_to_response=credits&language=en-US"
    try:
        if session is not None:
            resp = session.get(url, timeout=timeout)
        else:
            resp = requests.get(
                url,
                headers={"accept": "application/json", "Authorization": f"Bearer {TMDB_API_KEY}"},
                timeout=timeout,
            )
        if resp.status_code != 200:
            return result
        d = resp.json()
    except Exception as e:
        print(f"TMDB details fetch failed for {tmdb_id}: {e}")
        return result

    release_date = d.get('release_date') or None
    release_year = None
    if release_date and len(release_date) >= 4:
        try:
            release_year = int(release_date[:4])
        except ValueError:
            release_year = None

    credits = d.get('credits') or {}
    director = next((c.get('name') for c in credits.get('crew', []) if c.get('job') == 'Director'), None)
    cast = credits.get('cast', [])[:3]
    top_cast = [
        {"id": c.get("id"), "name": c.get("name"), "character": c.get("character"), "profile_path": c.get("profile_path")}
        for c in cast
    ] or None

    result.update({
        "fetched": True,
        "runtime": d.get('runtime') or None,
        "release_date": release_date,
        "release_year": release_year,
        "director": director,
        "top_cast": top_cast,
        "language": d.get('original_language') or None,
    })
    return result


def _release_sort_date(movie):
    """
    A comparable release date for a movie: the full date when known, otherwise
    1 Jan of its release year, otherwise None.
    """
    raw = (movie.release_date or "").strip()
    if raw:
        parts = raw.split("-")
        try:
            year = int(parts[0])
            month = int(parts[1]) if len(parts) > 1 and parts[1] else 1
            day = int(parts[2]) if len(parts) > 2 and parts[2] else 1
            return date(year, month, day)
        except (ValueError, IndexError):
            pass
    if movie.release_year:
        try:
            return date(int(movie.release_year), 1, 1)
        except (TypeError, ValueError):
            return None
    return None


def _longest_streak(dates):
    """Longest run of consecutive days in an iterable of dates."""
    ordered = sorted(set(d for d in dates if d))
    if not ordered:
        return {"length": 0, "start": None, "end": None}

    best_len, best_start, best_end = 1, ordered[0], ordered[0]
    run_len, run_start = 1, ordered[0]
    for prev, cur in zip(ordered, ordered[1:]):
        if (cur - prev).days == 1:
            run_len += 1
        else:
            run_len, run_start = 1, cur
        if run_len > best_len:
            best_len, best_start, best_end = run_len, run_start, cur

    return {
        "length": best_len,
        "start": best_start.strftime("%b %d, %Y"),
        "end": best_end.strftime("%b %d, %Y"),
    }


def _period_units(year_param, available_years):
    """(weeks, months) covered by a stats period, for per-week/per-month averages."""
    today = _ist_today()
    if year_param == 'all':
        if not available_years:
            return 52, 12
        months = max(1, (today.year - min(available_years)) * 12 + today.month)
        return max(1, months * 4.33), months
    try:
        yr = int(year_param)
    except ValueError:
        return 52, 12
    if yr == today.year:
        days_elapsed = max(1, (today - date(yr, 1, 1)).days)
        return max(1, days_elapsed / 7), max(1, days_elapsed / 30.44)
    return 52, 12


def _week_month_day_counts(dated_items):
    """Bucket (date, weight) pairs into 52 ISO weeks, 12 months and 7 weekdays."""
    by_week = [0] * 54
    by_month = [0] * 12
    by_day = [0] * 7
    for d, weight in dated_items:
        if not d:
            continue
        wk = d.isocalendar()[1]
        if d.month == 1 and wk >= 52:
            wk = 1
        elif d.month == 12 and wk == 1:
            wk = 53
        if 1 <= wk <= 53:
            by_week[wk] += weight
        by_month[d.month - 1] += weight
        by_day[d.weekday()] += weight
    by_week[52] += by_week[53]
    return by_week[1:53], by_month, by_day

# ==========================================
# 📺 TV TRACKER ENDPOINTS
# ==========================================

@media_bp.route('/api/media/search', methods=['GET'])
@require_access("sabdekho")
def search_media():
    query = request.args.get('q', '')
    if not query:
        return jsonify({"success": False, "message": "Query required"}), 400
    if not TMDB_API_KEY:
        return jsonify({"success": False, "message": "TMDB_API_KEY not set"}), 500
    media_type = request.args.get('type', '')
    
    # Extract year from query like "Prince 2022" -> query="Prince", year=2022
    search_year = None
    search_query = query
    year_match = re.search(r'\b(19\d{2}|20\d{2})\s*$', query.strip())
    if year_match:
        search_year = year_match.group(1)
        search_query = query[:year_match.start()].strip()
        if not search_query:
            search_query = query  # fallback if query was just a year
            search_year = None
    
    year_param = f"&year={search_year}" if search_year and media_type == 'movie' else ""
    year_param_tv = f"&first_air_date_year={search_year}" if search_year and media_type == 'tv' else ""
    
    if media_type == 'movie':
        url = f"https://api.themoviedb.org/3/search/movie?query={search_query}&include_adult=false&language=en-US&page=1{year_param}"
    elif media_type == 'tv':
        url = f"https://api.themoviedb.org/3/search/tv?query={search_query}&include_adult=false&language=en-US&page=1{year_param_tv}"
    else:
        url = f"https://api.themoviedb.org/3/search/multi?query={query}&include_adult=false&language=en-US&page=1"
    headers = {
        "accept": "application/json",
        "Authorization": f"Bearer {TMDB_API_KEY}",
        "User-Agent": "Mozilla/5.0",
        "Connection": "close"
    }
    
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(max_retries=requests.packages.urllib3.util.retry.Retry(total=3, backoff_factor=0.5))
    session.mount('https://', adapter)
    
    try:
        response = session.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        return jsonify({"success": True, "data": response.json()})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@media_bp.route('/api/tv/details/<int:tmdb_id>', methods=['GET'])
@require_access("sabdekho")
def get_tv_details(tmdb_id):
    if not TMDB_API_KEY:
        return jsonify({"success": False, "message": "TMDB_API_KEY not set"}), 500
        
    url = f"https://api.themoviedb.org/3/tv/{tmdb_id}?append_to_response=aggregate_credits,videos&language=en-US"
    headers = {
        "accept": "application/json",
        "Authorization": f"Bearer {TMDB_API_KEY}",
        "User-Agent": "Mozilla/5.0",
        "Connection": "close"
    }
    
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(max_retries=requests.packages.urllib3.util.retry.Retry(total=3, backoff_factor=0.5))
    session.mount('https://', adapter)
    
    try:
        response = session.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        return jsonify({"success": True, "data": response.json()})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@media_bp.route('/api/tv/shows', methods=['GET'])
@require_access("sabdekho")
def get_tv_shows():
    shows = TvShow.query.order_by(TvShow.added_on.desc()).all()
    result = []
    for s in shows:
        result.append({
            "id": s.id,
            "tmdb_id": s.tmdb_id,
            "name": s.name,
            "poster_path": s.poster_path,
            "status": s.status,
            "watched_episodes": s.watched_episodes,
            "added_on": s.added_on.isoformat() if s.added_on else None
        })
    return jsonify({"success": True, "shows": result})

@media_bp.route('/api/tv/shows', methods=['POST'])
@require_access("sabdekho")
def add_tv_show():
    data = request.json
    tmdb_id = data.get('tmdb_id')
    name = data.get('name')
    poster_path = data.get('poster_path')
    status = data.get('status', 'TO WATCH')
    
    if not tmdb_id or not name:
        return jsonify({"success": False, "message": "tmdb_id and name are required"}), 400
        
    existing = TvShow.query.filter_by(tmdb_id=tmdb_id).first()
    if existing:
        if existing.status == 'NONE' and status != 'NONE':
            existing.status = status
            db.session.commit()
            
        return jsonify({
            "success": True, 
            "message": "Show already tracked", 
            "id": existing.id,
            "show": {
                "id": existing.id, "tmdb_id": existing.tmdb_id, "name": existing.name, 
                "poster_path": existing.poster_path, "status": existing.status, "type": "tv"
            }
        })
        
    new_show = TvShow(
        tmdb_id=tmdb_id,
        name=name,
        poster_path=poster_path,
        status=status,
        watched_episodes={},
        language=fetch_tmdb_tv_language(tmdb_id),
    )
    db.session.add(new_show)
    db.session.flush() # to get new_show.id
    
    if status != 'NONE':
        activity = TvActivityLog(tv_show_id=new_show.id, action=f"Added to library as {status}")
        db.session.add(activity)
    
    db.session.commit()
    
    return jsonify({
        "success": True, 
        "message": "Show added", 
        "id": new_show.id,
        "show": {
            "id": new_show.id, "tmdb_id": new_show.tmdb_id, "name": new_show.name, 
            "poster_path": new_show.poster_path, "status": new_show.status, "type": "tv"
        }
    })

@media_bp.route('/api/tv/shows/<int:show_id>', methods=['PUT', 'DELETE'])
@require_access("sabdekho")
def update_tv_show(show_id):
    show = TvShow.query.get(show_id)
    if not show:
        return jsonify({"success": False, "message": "Show not found"}), 404
        
    if request.method == 'DELETE':
        db.session.delete(show)
        db.session.commit()
        invalidate_stats_cache()
        return jsonify({"success": True, "message": "Show deleted"})
        
    # PUT
    data = request.json
    if 'status' in data and show.status != data['status']:
        show.status = data['status']
        activity = TvActivityLog(tv_show_id=show.id, action=f"Status changed to {data['status']}")
        db.session.add(activity)
        
    if 'watched_episodes' in data:
        show.watched_episodes = data['watched_episodes']

    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True, "message": "Show updated"})

@media_bp.route('/api/tv/diary', methods=['GET'])
@require_access("sabdekho")
def get_tv_diary():
    logs = TvDiaryLog.query.order_by(TvDiaryLog.date.desc(), TvDiaryLog.created_at.desc()).all()
    result = []
    for log in logs:
        result.append({
            "id": log.id,
            "show_id": log.tv_show_id,
            "show_name": log.tv_show.name if log.tv_show else "Unknown",
            "poster_path": log.tv_show.poster_path if log.tv_show else None,
            "season_number": log.season_number,
            "episode_number": log.episode_number,
            "date": log.date.isoformat(),
            "rating": log.rating,
            "review": log.review,
            "liked": log.liked,
            "rewatch": log.rewatch,
            "tags": log.tags,
            "created_at": log.created_at.isoformat()
        })
    return jsonify({"success": True, "logs": result})

@media_bp.route('/api/tv/diary', methods=['POST'])
@require_access("sabdekho")
def add_tv_diary():
    data = request.json
    tv_show_id = data.get('tv_show_id')
    
    if not tv_show_id:
        return jsonify({"success": False, "message": "tv_show_id is required"}), 400
    if not TvShow.query.get(tv_show_id):
        return jsonify({"success": False, "message": "Show not found"}), 404
        
    log_date_str = data.get('date')
    log_date = datetime.strptime(log_date_str, "%Y-%m-%d").date() if log_date_str else date.today()
        
    new_log = TvDiaryLog(
        tv_show_id=tv_show_id,
        season_number=data.get('season_number'),
        episode_number=data.get('episode_number'),
        date=log_date,
        rating=data.get('rating'),
        review=data.get('review'),
        liked=data.get('liked', False),
        rewatch=data.get('rewatch', False),
        tags=data.get('tags')
    )
    
    db.session.add(new_log)
    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True, "message": "Logged successfully", "id": new_log.id})


def _diary_date_and_episode_updates(data, include_episode):
    """
    Optional date / season / episode changes for a diary PUT. Returns
    (updates, error_message). A key that's absent is left alone; an explicit
    null season/episode clears it (e.g. an episode log becoming a season log).
    """
    updates = {}
    if data.get('date'):
        try:
            updates['date'] = datetime.strptime(str(data['date'])[:10], "%Y-%m-%d").date()
        except ValueError:
            return None, "date must be YYYY-MM-DD"
    if include_episode:
        for key in ('season_number', 'episode_number'):
            if key in data:
                value = data[key]
                if value in (None, ''):
                    updates[key] = None
                else:
                    try:
                        updates[key] = int(value)
                    except (TypeError, ValueError):
                        return None, f"{key} must be a number"
    return updates, None

@media_bp.route('/api/tv/diary', methods=['PUT'])
@require_access("sabdekho")
def update_tv_diary():
    data = request.json
    log_ids = data.get('log_ids', [])
    if not log_ids:
        return jsonify({"success": False, "message": "log_ids required"}), 400
    
    update_data = {}
    if 'rating' in data: update_data['rating'] = data['rating'] or None
    if 'review' in data: update_data['review'] = data['review'] or None
    if 'liked' in data: update_data['liked'] = data['liked']
    if 'rewatch' in data: update_data['rewatch'] = data['rewatch']
    if 'tags' in data: update_data['tags'] = data['tags'] or None

    extra, error = _diary_date_and_episode_updates(data, include_episode=True)
    if error:
        return jsonify({"success": False, "message": error}), 400
    update_data.update(extra)
    if not update_data:
        return jsonify({"success": True})

    TvDiaryLog.query.filter(TvDiaryLog.id.in_(log_ids)).update(update_data, synchronize_session=False)
    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True})

@media_bp.route('/api/tv/diary', methods=['DELETE'])
@require_access("sabdekho")
def delete_tv_diary():
    log_ids = request.json.get('log_ids', [])
    if not log_ids:
        return jsonify({"success": False, "message": "log_ids required"}), 400
        
    TvDiaryLog.query.filter(TvDiaryLog.id.in_(log_ids)).delete(synchronize_session=False)
    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True})

# --- TV STATS ---
# Actions TvActivityLog records when a show becomes finished.
_TV_COMPLETION_ACTIONS = ("Status changed to WATCHED", "Added to library as WATCHED")


# tmdb_id -> (fetched_at, {season_number: episode_count}). Season sizes barely
# change, so a day per worker is plenty; a failed lookup is cached briefly too
# so one bad show can't slow every stats request.
_tv_season_sizes_cache = {}
_TV_SEASON_SIZES_TTL = timedelta(hours=24)
_TV_SEASON_SIZES_FAILURE_TTL = timedelta(minutes=10)


def _fetch_tv_season_sizes(tmdb_id):
    """{season_number: episode_count} for a show from TMDB, or None if unavailable."""
    if not TMDB_API_KEY or not tmdb_id:
        return None
    cached = _tv_season_sizes_cache.get(tmdb_id)
    now = datetime.utcnow()
    if cached:
        fetched_at, sizes = cached
        ttl = _TV_SEASON_SIZES_TTL if sizes is not None else _TV_SEASON_SIZES_FAILURE_TTL
        if now - fetched_at < ttl:
            return sizes

    sizes = None
    try:
        resp = requests.get(
            f"https://api.themoviedb.org/3/tv/{tmdb_id}?language=en-US",
            headers={"accept": "application/json", "Authorization": f"Bearer {TMDB_API_KEY}"},
            timeout=6,
        )
        if resp.status_code == 200:
            sizes = {
                int(season["season_number"]): int(season.get("episode_count") or 0)
                for season in resp.json().get("seasons", [])
                if season.get("season_number") is not None
            }
    except Exception as e:
        print(f"TMDB season sizes fetch failed for {tmdb_id}: {e}")

    _tv_season_sizes_cache[tmdb_id] = (now, sizes)
    return sizes


def _season_sizes_for(tmdb_ids):
    """Season sizes for several shows at once, fetched in parallel."""
    from concurrent.futures import ThreadPoolExecutor
    ids = sorted({t for t in tmdb_ids if t})
    if not ids:
        return {}
    with ThreadPoolExecutor(max_workers=min(8, len(ids))) as pool:
        return dict(zip(ids, pool.map(_fetch_tv_season_sizes, ids)))


def _episodes_in_log(log, season_sizes):
    """
    How many episodes a diary log stands for.

    An episode log is one episode. A season log (season set, no episode) is every
    episode of that season, and a whole-show log (neither set) is every episode
    outside specials — the same way the web app decides a show is finished.
    When TMDB can't tell us the size, the log still counts as one.
    """
    if log.episode_number is not None:
        return 1
    if not season_sizes:
        return 1
    if log.season_number is not None:
        return season_sizes.get(log.season_number) or 1
    return sum(count for number, count in season_sizes.items() if number > 0) or 1


def _count_watched_episodes(watched_episodes):
    """Episodes marked watched in a show's {"season": [episodes]} progress map."""
    if not isinstance(watched_episodes, dict):
        return 0
    return sum(len(eps) for eps in watched_episodes.values() if isinstance(eps, (list, tuple)))


@media_bp.route('/api/tv/stats', methods=['GET'])
@require_access("sabdekho")
def get_tv_stats():
    """
    Year-in-TV stats, the counterpart to /api/movies/stats.

    Counts are episode-based wherever a log names an episode; season- or
    show-level logs still count towards activity, shows and ratings. Hours
    aren't reported because episode runtimes aren't stored.
    """
    from sqlalchemy.sql import extract

    year_param = request.args.get('year', str(_ist_today().year))

    fingerprint = _stats_fingerprint(_TV_STATS_FINGERPRINT_SQL)
    cache_key = (data_owner(), year_param)
    cached = _tv_stats_cache.get(cache_key)
    if fingerprint and cached and cached[0] == fingerprint:
        return jsonify(cached[1])

    try:
        year_rows = db.session.query(extract('year', TvDiaryLog.date).label('yr')).distinct().all()
        available_years = sorted({int(r.yr) for r in year_rows if r.yr}, reverse=True)

        selected_year = None
        query = TvDiaryLog.query.options(joinedload(TvDiaryLog.tv_show))
        if year_param != 'all':
            try:
                selected_year = int(year_param)
                query = query.filter(extract('year', TvDiaryLog.date) == selected_year)
            except ValueError:
                selected_year = None
        logs = [l for l in query.all() if l.tv_show]

        def show_summary(show):
            return {
                "show_id": show.id,
                "tmdb_id": show.tmdb_id,
                "name": show.name,
                "poster_path": show.poster_path,
                "status": show.status,
            }

        # --- Headline counts ---
        # Season and whole-show logs expand to the episodes they cover, so
        # logging "Season 2" counts all of Season 2 rather than one entry.
        needs_sizes = {l.tv_show.tmdb_id for l in logs if l.episode_number is None}
        season_sizes = _season_sizes_for(needs_sizes)
        episode_weight = {l.id: _episodes_in_log(l, season_sizes.get(l.tv_show.tmdb_id)) for l in logs}

        episode_logs = [l for l in logs if l.episode_number is not None]
        episodes_watched = sum(episode_weight.values())
        shows_watched = len({l.tv_show_id for l in logs})
        seasons_watched = len({
            (l.tv_show_id, l.season_number) for l in logs if l.season_number is not None
        })
        total_likes = sum(1 for l in logs if l.liked)
        total_reviews = sum(1 for l in logs if l.review and l.review.strip())
        total_rewatches = sum(1 for l in logs if l.rewatch)
        ratings = [l.rating for l in logs if l.rating and l.rating > 0]
        average_rating = round(sum(ratings) / len(ratings), 2) if ratings else None

        num_weeks, num_months = _period_units(year_param, available_years)
        avg_per_week = round(episodes_watched / num_weeks, 1)
        avg_per_month = round(episodes_watched / num_months, 1)

        # --- Activity charts (every log counts, so season logs still show up) ---
        by_week, by_month, by_day = _week_month_day_counts((l.date, episode_weight[l.id]) for l in logs)

        episodes_by_year_map = {}
        for l in logs:
            episodes_by_year_map[l.date.year] = episodes_by_year_map.get(l.date.year, 0) + episode_weight[l.id]
        episodes_by_year = [{"year": y, "count": c} for y, c in sorted(episodes_by_year_map.items())]

        # Shows by language (unique shows per language)
        show_language_map = {}
        for l in logs:
            if l.tv_show and l.tv_show_id not in show_language_map:
                show_language_map[l.tv_show_id] = l.tv_show.language
        shows_by_language_dict = {}
        for lang in show_language_map.values():
            key = (lang or "").lower() or "unknown"
            shows_by_language_dict[key] = shows_by_language_dict.get(key, 0) + 1
        shows_by_language = _group_top_languages(shows_by_language_dict)

        # --- Per-show rollups ---
        per_show = {}
        for l in logs:
            entry = per_show.get(l.tv_show_id)
            if entry is None:
                entry = {
                    **show_summary(l.tv_show),
                    "episodes": 0,
                    "logs": 0,
                    "first_watched": l.date,
                    "last_watched": l.date,
                    "_ratings": [],
                }
                per_show[l.tv_show_id] = entry
            entry["logs"] += 1
            entry["episodes"] += episode_weight[l.id]
            if l.date < entry["first_watched"]:
                entry["first_watched"] = l.date
            if l.date > entry["last_watched"]:
                entry["last_watched"] = l.date
            if l.rating and l.rating > 0:
                entry["_ratings"].append(l.rating)

        def public(entry, **extra):
            out = {k: v for k, v in entry.items() if not k.startswith("_")}
            out["first_watched"] = entry["first_watched"].isoformat()
            out["last_watched"] = entry["last_watched"].isoformat()
            out.update(extra)
            return out

        most_watched = [
            public(e) for e in sorted(
                per_show.values(),
                key=lambda e: (-e["episodes"], -e["logs"], e["name"].lower())
            )[:12]
        ]

        rated_shows = [e for e in per_show.values() if e["_ratings"]]
        highest_rated = [
            public(
                e,
                rating=round(sum(e["_ratings"]) / len(e["_ratings"]), 1),
                ratings_count=len(e["_ratings"]),
            )
            for e in sorted(
                rated_shows,
                key=lambda e: (-(sum(e["_ratings"]) / len(e["_ratings"])), -len(e["_ratings"]), e["name"].lower())
            )[:12]
        ]

        # --- Biggest binge: most episodes of one show on a single day ---
        # Only individual episode logs count here: logging a whole season on one
        # day records when it was logged, not that it was watched that day.
        per_day = {}
        for l in episode_logs:
            key = (l.tv_show_id, l.date)
            per_day[key] = per_day.get(key, 0) + 1
        biggest_binge = None
        if per_day:
            (binge_show_id, binge_date), binge_count = max(
                per_day.items(), key=lambda kv: (kv[1], kv[0][1])
            )
            if binge_count >= 2:
                show = per_show[binge_show_id]
                biggest_binge = {
                    "show_id": show["show_id"],
                    "tmdb_id": show["tmdb_id"],
                    "name": show["name"],
                    "poster_path": show["poster_path"],
                    "date": binge_date.isoformat(),
                    "episodes": binge_count,
                }

        longest_streak = _longest_streak(l.date for l in logs)

        # --- Rating distribution ---
        rating_distribution = {}
        for r in ratings:
            key = str(r)
            rating_distribution[key] = rating_distribution.get(key, 0) + 1

        # --- Shows finished in this period ---
        completion_query = TvActivityLog.query.options(joinedload(TvActivityLog.tv_show)).filter(
            TvActivityLog.action.in_(_TV_COMPLETION_ACTIONS)
        )
        if selected_year is not None:
            completion_query = completion_query.filter(extract('year', TvActivityLog.created_at) == selected_year)
        latest_completion = {}
        for act in completion_query.all():
            if not act.tv_show or not act.created_at:
                continue
            previous = latest_completion.get(act.tv_show_id)
            if previous is None or act.created_at > previous.created_at:
                latest_completion[act.tv_show_id] = act
        completed = sorted(
            (
                {**show_summary(act.tv_show), "completed_on": act.created_at.date().isoformat()}
                for act in latest_completion.values()
            ),
            key=lambda c: c["completed_on"],
            reverse=True,
        )

        # --- Currently watching (a live snapshot, not tied to the year) ---
        watching_shows = TvShow.query.filter(TvShow.status == 'WATCHING').all()
        last_logged = {}
        diary_episodes = {}
        if watching_shows:
            watching_logs = TvDiaryLog.query.filter(
                TvDiaryLog.tv_show_id.in_([s.id for s in watching_shows])
            ).all()
            watching_by_id = {s.id: s for s in watching_shows}
            watching_sizes = _season_sizes_for(
                watching_by_id[l.tv_show_id].tmdb_id for l in watching_logs if l.episode_number is None
            )
            # Distinct episodes seen so far: a rewatched episode, or an episode
            # that's also inside a logged season, only counts once.
            seen = {}
            for l in watching_logs:
                if l.date and (l.tv_show_id not in last_logged or l.date > last_logged[l.tv_show_id]):
                    last_logged[l.tv_show_id] = l.date
                show_seen = seen.setdefault(l.tv_show_id, {"episodes": set(), "seasons": set(), "whole": False})
                if l.episode_number is not None:
                    show_seen["episodes"].add((l.season_number, l.episode_number))
                elif l.season_number is not None:
                    show_seen["seasons"].add(l.season_number)
                else:
                    show_seen["whole"] = True
            for show_id, show_seen in seen.items():
                sizes = watching_sizes.get(watching_by_id[show_id].tmdb_id) or {}
                if show_seen["whole"] and sizes:
                    diary_episodes[show_id] = sum(c for n, c in sizes.items() if n > 0)
                    continue
                # Unknown season size: count at least the episodes logged inside it.
                from_seasons = sum(
                    sizes[n] if sizes.get(n) else max(1, sum(1 for (season, _ep) in show_seen["episodes"] if season == n))
                    for n in show_seen["seasons"]
                )
                loose = sum(1 for (season, _ep) in show_seen["episodes"] if season not in show_seen["seasons"])
                diary_episodes[show_id] = from_seasons + loose
        in_progress = sorted(
            (
                {
                    **show_summary(show),
                    "episodes_watched": max(
                        diary_episodes.get(show.id, 0),
                        _count_watched_episodes(show.watched_episodes),
                    ),
                    "last_watched": last_logged[show.id].isoformat() if last_logged.get(show.id) else None,
                }
                for show in watching_shows
            ),
            key=lambda s: (s["last_watched"] is not None, s["last_watched"] or ""),
            reverse=True,
        )

        status_counts = {
            status: count for status, count in db.session.query(TvShow.status, sql_func.count(TvShow.id))
            .group_by(TvShow.status).all()
            if status and status != 'NONE'
        }

        result = {
            "success": True,
            "year": year_param,
            "available_years": available_years,
            "episodes_watched": episodes_watched,
            "shows_watched": shows_watched,
            "seasons_watched": seasons_watched,
            "total_entries": len(logs),
            "total_likes": total_likes,
            "total_reviews": total_reviews,
            "total_rewatches": total_rewatches,
            "average_rating": average_rating,
            "shows_completed": len(completed),
            "avg_per_week": avg_per_week,
            "avg_per_month": avg_per_month,
            "by_week": by_week,
            "by_month": by_month,
            "by_day": by_day,
            "episodes_by_year": episodes_by_year,
            "shows_by_language": shows_by_language,
            "rating_distribution": rating_distribution,
            "most_watched": most_watched,
            "highest_rated": highest_rated,
            "biggest_binge": biggest_binge,
            "longest_streak": longest_streak,
            "completed": completed,
            "in_progress": in_progress,
            "status_counts": status_counts,
        }

        if fingerprint:
            _tv_stats_cache[cache_key] = (fingerprint, result)

        return jsonify(result)
    except Exception as e:
        print(f"TV stats error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500


# ==========================================
# 🎬 MOVIE TRACKER ENDPOINTS
# ==========================================

@media_bp.route('/api/movies/search', methods=['GET'])
@require_access("sabdekho")
def search_tmdb_movies():
    query = request.args.get('q', '').strip()
    if not query:
        return jsonify({"success": True, "results": []})
        
    if not TMDB_API_KEY:
        return jsonify({"success": False, "message": "TMDB_API_KEY not set"}), 500
        
    search_url = f"https://api.themoviedb.org/3/search/movie?query={requests.utils.quote(query)}"
    headers = {
        "accept": "application/json",
        "Authorization": f"Bearer {TMDB_API_KEY}",
        "User-Agent": "Mozilla/5.0"
    }
    
    try:
        session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(max_retries=requests.packages.urllib3.util.retry.Retry(total=2, backoff_factor=0.5))
        session.mount('https://', adapter)
        r = session.get(search_url, headers=headers, timeout=5)
        if r.status_code == 200:
            data = r.json()
            results = data.get('results', [])[:5] # Top 5
            return jsonify({
                "success": True, 
                "results": [{
                    "tmdb_id": m.get('id'),
                    "title": m.get('title'),
                    "year": m.get('release_date', '')[:4] if m.get('release_date') else '',
                    "poster_path": m.get('poster_path')
                } for m in results]
            })
        return jsonify({"success": False, "message": "TMDB API Error"}), 500
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@media_bp.route('/api/movies/tags', methods=['GET'])
@require_access("sabdekho")
def get_movie_tags():
    try:
        logs = MovieDiaryLog.query.filter(MovieDiaryLog.tags.isnot(None)).all()
        tags_set = set()
        for log in logs:
            if log.tags:
                for tag in log.tags.split(','):
                    t = tag.strip()
                    if t:
                        tags_set.add(t)
        return jsonify({"success": True, "tags": sorted(list(tags_set))})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

# --- STATS CACHES ---
# The backend runs as several gunicorn worker processes, each with its own
# memory. Clearing a plain in-process cache on write only clears the worker that
# handled that write, so the others kept serving stale stats indefinitely.
#
# Each cached entry is therefore stored alongside a fingerprint of the data it
# was computed from. Every stats request recomputes that fingerprint (one cheap
# aggregate query) and only reuses the cache when it still matches — correct on
# every worker, and for writes made outside the API (utils scripts, direct SQL).
_stats_cache = {}
_tv_stats_cache = {}

_MOVIE_STATS_FINGERPRINT_SQL = """
SELECT
  (SELECT md5(coalesce(string_agg(
      concat_ws('|', id, movie_id, date, rating, liked, rewatch, md5(coalesce(review, '')), tags),
      ',' ORDER BY id), '')) FROM movie_diary_logs WHERE owner_email = :owner)
  || (SELECT md5(coalesce(string_agg(
      concat_ws('|', id, tmdb_id, name, poster_path, runtime, release_year, release_date, language),
      ',' ORDER BY id), '')) FROM movies WHERE owner_email = :owner)
"""

_TV_STATS_FINGERPRINT_SQL = """
SELECT
  (SELECT md5(coalesce(string_agg(
      concat_ws('|', id, tv_show_id, season_number, episode_number, date, rating, liked, rewatch,
                md5(coalesce(review, '')), tags),
      ',' ORDER BY id), '')) FROM tv_diary_logs WHERE owner_email = :owner)
  || (SELECT md5(coalesce(string_agg(
      concat_ws('|', id, tmdb_id, name, poster_path, status, watched_episodes::text, language),
      ',' ORDER BY id), '')) FROM tv_shows WHERE owner_email = :owner)
  || (SELECT md5(coalesce(string_agg(
      concat_ws('|', id, tv_show_id, action, created_at),
      ',' ORDER BY id), '')) FROM tv_activity_logs WHERE owner_email = :owner)
"""


def _stats_fingerprint(sql):
    """Fingerprint of the signed-in person's rows a stats payload depends on, or None if unavailable."""
    try:
        return db.session.execute(sql_text(sql), {"owner": data_owner()}).scalar()
    except Exception as e:
        db.session.rollback()
        print(f"Stats fingerprint unavailable, serving uncached: {e}")
        return None


def invalidate_stats_cache():
    """
    Drop this worker's cached stats for the signed-in person straight away after
    a write it handled. Other workers notice the change through the fingerprint check.
    """
    owner = data_owner()
    for cache in (_stats_cache, _tv_stats_cache):
        for key in [k for k in cache if owner is None or k[0] == owner]:
            cache.pop(key, None)

@media_bp.route('/api/movies/stats', methods=['GET'])
@require_access("sabdekho")
def get_movie_stats():
    from sqlalchemy.sql import func, extract
    
    year_param = request.args.get('year', str(_ist_today().year))

    fingerprint = _stats_fingerprint(_MOVIE_STATS_FINGERPRINT_SQL)
    cache_key = (data_owner(), year_param)
    cached = _stats_cache.get(cache_key)
    if fingerprint and cached and cached[0] == fingerprint:
        return jsonify(cached[1])
    
    try:
        # Get available years
        year_rows = db.session.query(
            extract('year', MovieDiaryLog.date).label('yr')
        ).distinct().all()
        available_years = sorted([int(r.yr) for r in year_rows if r.yr], reverse=True)
        
        # Base query
        query = db.session.query(MovieDiaryLog).options(joinedload(MovieDiaryLog.movie))
        
        if year_param != 'all':
            try:
                yr = int(year_param)
                query = query.filter(extract('year', MovieDiaryLog.date) == yr)
            except ValueError:
                pass
        
        logs = query.all()
        
        # --- Compute stats ---
        total_entries = len(logs)
        total_reviews = sum(1 for l in logs if l.review and l.review.strip())
        total_likes = sum(1 for l in logs if l.liked)
        
        # Total hours from runtime
        total_minutes = 0
        for l in logs:
            if l.movie and l.movie.runtime:
                total_minutes += l.movie.runtime
        total_hours = round(total_minutes / 60, 1)
        
        # Unique films
        unique_movie_ids = set(l.movie_id for l in logs)
        films_logged = len(unique_movie_ids)
        
        # Averages
        if year_param == 'all' and available_years:
            num_months = max(1, (datetime.now().year - min(available_years)) * 12 + datetime.now().month)
            num_weeks = max(1, num_months * 4.33)
        elif year_param != 'all':
            try:
                yr = int(year_param)
                if yr == datetime.now().year:
                    from datetime import date as dt_date
                    jan1 = dt_date(yr, 1, 1)
                    today = dt_date.today()
                    days_elapsed = max(1, (today - jan1).days)
                    num_months = max(1, days_elapsed / 30.44)
                    num_weeks = max(1, days_elapsed / 7)
                else:
                    num_months = 12
                    num_weeks = 52
            except ValueError:
                num_months = 12
                num_weeks = 52
        else:
            num_months = 12
            num_weeks = 52
        
        avg_per_month = round(films_logged / num_months, 1)
        avg_per_week = round(films_logged / num_weeks, 1)
        
        # Highest rated films (top 14, unique movies, highest rating first)
        # To include rewatches that might not have been rated this year, we get the all-time max rating for all movies logged this year.
        unique_movie_ids = list(set(l.movie_id for l in logs))
        movie_best_rating = {}
        
        if unique_movie_ids:
            all_time_ratings = db.session.query(
                MovieDiaryLog.movie_id, func.max(MovieDiaryLog.rating)
            ).filter(
                MovieDiaryLog.movie_id.in_(unique_movie_ids),
                MovieDiaryLog.rating > 0
            ).group_by(MovieDiaryLog.movie_id).all()
            
            best_rating_map = {r[0]: r[1] for r in all_time_ratings if r[1]}
            
            for l in logs:
                mid = l.movie_id
                if mid in best_rating_map and mid not in movie_best_rating:
                    movie_best_rating[mid] = {
                        'movie_id': mid,
                        'tmdb_id': l.movie.tmdb_id if l.movie else None,
                        'name': l.movie.name if l.movie else 'Unknown',
                        'poster_path': l.movie.poster_path if l.movie else None,
                        'rating': best_rating_map[mid],
                        'release_year': l.movie.release_year if l.movie else None
                    }
        
        all_rated = sorted(movie_best_rating.values(), key=lambda x: -x['rating'])
        highest_rated = all_rated[:20]
        highest_rated_current = []
        highest_rated_older = []
        
        if year_param != 'all':
            yr = int(year_param)
            current = [m for m in all_rated if m['release_year'] == yr][:20]
            older = [m for m in all_rated if m['release_year'] is not None and m['release_year'] < yr][:20]
            # Fallback if release_year is missing: treat as older
            older += [m for m in all_rated if m['release_year'] is None][:20 - len(older)]
            highest_rated_current = sorted(current, key=lambda x: -x['rating'])
            highest_rated_older = sorted(older, key=lambda x: -x['rating'])
        else:
            highest_rated_current = highest_rated
            highest_rated_older = []
        
        # Films by week (ISO week number -> count)
        by_week = [0] * 54  # weeks 0-53
        for l in logs:
            if l.date:
                iso_yr, iso_wk, _ = l.date.isocalendar()
                wk = iso_wk
                
                # If early Jan falls in previous year's week 52/53, bundle into week 1
                if l.date.month == 1 and wk >= 52:
                    wk = 1
                # If late Dec falls in next year's week 1, bundle into week 53
                elif l.date.month == 12 and wk == 1:
                    wk = 53
                    
                if 1 <= wk <= 53:
                    by_week[wk] += 1
                    
        # Bundle week 53 into 52 so chart has exactly 52 bars
        by_week[52] += by_week[53]
        by_week = by_week[1:53]  # weeks 1-52
        
        # By day of week (Monday=0 ... Sunday=6)
        by_day = [0] * 7
        for l in logs:
            if l.date:
                dow = l.date.weekday()  # Monday=0, Sunday=6
                by_day[dow] += 1
        
        # By month (Jan=0 ... Dec=11)
        by_month = [0] * 12
        for l in logs:
            if l.date:
                by_month[l.date.month - 1] += 1
        
        # Films by year (for all-time bar chart and year context)
        films_by_year_dict = {}
        for l in logs:
            if l.date:
                y = l.date.year
                if y not in films_by_year_dict:
                    films_by_year_dict[y] = set()
                films_by_year_dict[y].add(l.movie_id)
        films_by_year = [{"year": y, "count": len(ids)} for y, ids in sorted(films_by_year_dict.items())]

        # Films by language (unique movies per language)
        movie_language_map = {}
        for l in logs:
            if l.movie and l.movie_id not in movie_language_map:
                movie_language_map[l.movie_id] = l.movie.language
        films_by_language_dict = {}
        for lang in movie_language_map.values():
            key = (lang or "").lower() or "unknown"
            films_by_language_dict[key] = films_by_language_dict.get(key, 0) + 1
        films_by_language = _group_top_languages(films_by_language_dict)

        # Most rewatched (movies with the most diary entries, minimum 2)
        rewatch_count = {}
        for l in logs:
            if l.movie_id:
                rewatch_count[l.movie_id] = rewatch_count.get(l.movie_id, 0) + 1
        rewatched_ids = [(mid, cnt) for mid, cnt in rewatch_count.items() if cnt >= 2]
        rewatched_ids.sort(key=lambda x: -x[1])
        most_rewatched = []
        movies_by_id = {l.movie_id: l.movie for l in logs if l.movie}
        for mid, cnt in rewatched_ids[:50]:
            m = movies_by_id.get(mid)
            if m:
                most_rewatched.append({
                    "movie_id": m.id, "tmdb_id": m.tmdb_id, "name": m.name,
                    "poster_path": m.poster_path, "watch_count": cnt
                })
        
        # Longest streak (consecutive days with at least one film logged)
        log_dates = sorted(set(l.date for l in logs if l.date))
        longest_streak_len = 0
        longest_streak_start = None
        longest_streak_end = None
        
        if log_dates:
            current_streak = 1
            current_start = log_dates[0]
            current_end = log_dates[0]
            
            longest_streak_len = 1
            longest_streak_start = log_dates[0]
            longest_streak_end = log_dates[0]
            
            for i in range(1, len(log_dates)):
                if (log_dates[i] - log_dates[i - 1]).days == 1:
                    current_streak += 1
                    current_end = log_dates[i]
                else:
                    if current_streak > longest_streak_len:
                        longest_streak_len = current_streak
                        longest_streak_start = current_start
                        longest_streak_end = current_end
                    current_streak = 1
                    current_start = log_dates[i]
                    current_end = log_dates[i]
                    
            if current_streak > longest_streak_len:
                longest_streak_len = current_streak
                longest_streak_start = current_start
                longest_streak_end = current_end
                
        longest_streak = {
            "length": longest_streak_len,
            "start": longest_streak_start.strftime("%b %d, %Y") if longest_streak_start else None,
            "end": longest_streak_end.strftime("%b %d, %Y") if longest_streak_end else None
        }
        
        # Rating distribution (0.5, 1, 1.5, ..., 5)
        rating_dist = {}
        for l in logs:
            if l.rating and l.rating > 0:
                r_key = str(l.rating)
                rating_dist[r_key] = rating_dist.get(r_key, 0) + 1
        
        # --- Theatre Stats ---
        theatre_movies = []
        supplementary_tags = {}
        total_visits = 0
        
        for l in logs:
            if not l.tags:
                continue
            tags = [t.strip().lower() for t in l.tags.split(',') if t.strip()]
            is_theatre = any(t == 'overall-theatres' or t.startswith('theatres-') for t in tags)
            
            if is_theatre:
                total_visits += 1
                movie_tags = [t for t in tags if t != 'overall-theatres' and not t.startswith('theatres-')]
                for mt in movie_tags:
                    supplementary_tags[mt] = supplementary_tags.get(mt, 0) + 1
                
                if l.movie:
                    visit = {
                        'log_id': l.id,
                        'movie_id': l.movie_id,
                        'tmdb_id': l.movie.tmdb_id,
                        'name': l.movie.name,
                        'poster_path': l.movie.poster_path,
                        'release_year': l.movie.release_year,
                        'tags': movie_tags
                    }
                    # Left out rather than null while unrated: app builds up to
                    # 1.0.19 model it as a non-null number and drop the whole
                    # stats payload on a null.
                    if l.rating is not None:
                        visit['rating'] = l.rating
                    theatre_movies.append(visit)
                    
        theatre_stats = {
            "total_visits": total_visits,
            "supplementary_tags": supplementary_tags,
            "movies": theatre_movies
        }
        
        # --- Extremes ---
        # Oldest/newest compare full release dates, so two films from the same
        # year order correctly (a year-only film counts as 1 Jan). "Newest" is the
        # watched film released most recently up to today — never a date that
        # hasn't happened yet, which only festival screenings or bad data produce.
        today = _ist_today()
        last_watched = {}
        for l in logs:
            if l.movie_id and l.date and (l.movie_id not in last_watched or l.date > last_watched[l.movie_id]):
                last_watched[l.movie_id] = l.date

        longest_film = None
        shortest_film = None
        oldest_film, oldest_key = None, None
        newest_film, newest_key = None, None
        seen_movie_ids = set()

        for l in logs:
            m = l.movie
            if not m or m.id in seen_movie_ids:
                continue
            seen_movie_ids.add(m.id)

            released_on = _release_sort_date(m)
            watched_on = last_watched.get(m.id)
            movie_obj = {
                "id": m.id, "tmdb_id": m.tmdb_id, "name": m.name,
                "poster_path": m.poster_path, "runtime": m.runtime,
                "release_year": released_on.year if released_on else m.release_year,
                "release_date": m.release_date,
                "watched_date": watched_on.isoformat() if watched_on else None,
            }

            if m.runtime:
                if not longest_film or m.runtime > longest_film["runtime"]:
                    longest_film = movie_obj
                if not shortest_film or m.runtime < shortest_film["runtime"]:
                    shortest_film = movie_obj

            if released_on and released_on <= today:
                tie_break = m.tmdb_id or 0
                if oldest_key is None or (released_on, -tie_break) < oldest_key:
                    oldest_key, oldest_film = (released_on, -tie_break), movie_obj
                if newest_key is None or (released_on, tie_break) > newest_key:
                    newest_key, newest_film = (released_on, tie_break), movie_obj

        extremes = {
            "longest": longest_film,
            "shortest": shortest_film,
            "oldest": oldest_film,
            "newest": newest_film
        }
        
        result = {
            "success": True,
            "year": year_param,
            "available_years": available_years,
            "total_entries": total_entries,
            "total_reviews": total_reviews,
            "total_likes": total_likes,
            "total_hours": total_hours,
            "films_logged": films_logged,
            "avg_per_month": avg_per_month,
            "avg_per_week": avg_per_week,
            "highest_rated": highest_rated,
            "highest_rated_current": highest_rated_current,
            "highest_rated_older": highest_rated_older,
            "by_week": by_week,
            "by_month": by_month,
            "by_day": by_day,
            "rating_distribution": rating_dist,
            "theatre_stats": theatre_stats,
            "extremes": extremes,
            "films_by_year": films_by_year,
            "films_by_language": films_by_language,
            "most_rewatched": most_rewatched,
            "longest_streak": longest_streak
        }
        
        if fingerprint:
            _stats_cache[cache_key] = (fingerprint, result)
        
        return jsonify(result)
    except Exception as e:
        print(f"Stats error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({"success": False, "message": str(e)}), 500

@media_bp.route('/api/movies/details/<int:tmdb_id>', methods=['GET'])
@require_access("sabdekho")
def get_movie_details(tmdb_id):
    if not TMDB_API_KEY:
        return jsonify({"success": False, "message": "TMDB_API_KEY not set"}), 500
        
    url = f"https://api.themoviedb.org/3/movie/{tmdb_id}?append_to_response=credits,videos&language=en-US"
    headers = {
        "accept": "application/json",
        "Authorization": f"Bearer {TMDB_API_KEY}",
        "User-Agent": "Mozilla/5.0",
        "Connection": "close"
    }
    session = requests.Session()
    adapter = requests.adapters.HTTPAdapter(max_retries=requests.packages.urllib3.util.retry.Retry(total=3, backoff_factor=0.5))
    session.mount('https://', adapter)
    try:
        response = session.get(url, headers=headers, timeout=10)
        response.raise_for_status()
        data = response.json()
        if 'credits' in data:
            data['aggregate_credits'] = data['credits']
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500

@media_bp.route('/api/movies', methods=['GET'])
@require_access("sabdekho")
def get_movies():
    movies = Movie.query.filter(Movie.status != 'NONE').order_by(Movie.added_on.desc()).all()
    result = []
    for m in movies:
        result.append({
            "id": m.id,
            "tmdb_id": m.tmdb_id,
            "name": m.name,
            "poster_path": m.poster_path,
            "status": m.status,
            "added_on": m.added_on.isoformat() if m.added_on else None
        })
    return jsonify({"success": True, "movies": result})

@media_bp.route('/api/movies', methods=['POST'])
@require_access("sabdekho")
def add_movie():
    data = request.json
    tmdb_id = data.get('tmdb_id')
    name = data.get('name')
    poster_path = data.get('poster_path')
    status = data.get('status', 'TO WATCH')
    if not tmdb_id or not name:
        return jsonify({"success": False, "message": "tmdb_id and name are required"}), 400
    
    existing = Movie.query.filter_by(tmdb_id=tmdb_id).first()
    if existing:
        if existing.status == 'NONE' and status != 'NONE':
            existing.status = status
            db.session.commit()
            
        return jsonify({
            "success": True, 
            "message": "Movie already tracked", 
            "id": existing.id,
            "show": {
                "id": existing.id, "tmdb_id": existing.tmdb_id, "name": existing.name, 
                "poster_path": existing.poster_path, "status": existing.status, "type": "movie"
            }
        })

    rel_year = None
    try:
        if data.get('year'):
            rel_year = int(str(data['year'])[:4])
    except (TypeError, ValueError):
        rel_year = None

    details = fetch_tmdb_movie_details(tmdb_id)
    new_movie = Movie(
        tmdb_id=tmdb_id,
        name=name,
        poster_path=poster_path,
        status=status,
        release_year=rel_year or details["release_year"],
        release_date=details["release_date"],
        director=details["director"],
        top_cast=details["top_cast"],
        runtime=details["runtime"],
        language=details["language"],
    )

    db.session.add(new_movie)
    db.session.commit()
    return jsonify({
        "success": True, 
        "message": "Movie added", 
        "id": new_movie.id,
        "show": {
            "id": new_movie.id, "tmdb_id": new_movie.tmdb_id, "name": new_movie.name, 
            "poster_path": new_movie.poster_path, "status": new_movie.status, "type": "movie"
        }
    })

@media_bp.route('/api/movies/<int:movie_id>', methods=['PUT', 'DELETE'])
@require_access("sabdekho")
def update_movie(movie_id):
    movie = Movie.query.get(movie_id)
    if not movie:
        return jsonify({"success": False, "message": "Movie not found"}), 404
    if request.method == 'DELETE':
        db.session.delete(movie)
        db.session.commit()
        invalidate_stats_cache()
        return jsonify({"success": True, "message": "Movie deleted"})
    data = request.json
    if 'status' in data and movie.status != data['status']:
        movie.status = data['status']
    db.session.commit()
    return jsonify({"success": True, "message": "Movie updated"})

@media_bp.route('/api/movies/<int:movie_id>/rematch', methods=['POST'])
@require_access("sabdekho")
def rematch_movie(movie_id):
    movie = Movie.query.get(movie_id)
    if not movie:
        return jsonify({"success": False, "message": "Movie not found"}), 404
        
    data = request.json
    tmdb_id = data.get('tmdb_id')
    name = data.get('name')
    poster_path = data.get('poster_path')
    
    if not tmdb_id or not name:
        return jsonify({"success": False, "message": "tmdb_id and name required"}), 400
        
    existing = Movie.query.filter_by(tmdb_id=tmdb_id).first()
    if existing and existing.id != movie_id:
        return jsonify({"success": False, "message": "This TMDB movie is already in your library."}), 400

    movie.tmdb_id = tmdb_id
    movie.name = name
    movie.poster_path = poster_path
    
    rel_year = None
    try:
        if data.get('year'):
            rel_year = int(str(data['year'])[:4])
    except (TypeError, ValueError):
        rel_year = None

    details = fetch_tmdb_movie_details(tmdb_id)
    if details["fetched"]:
        # Everything describes the newly matched film, so replace it outright —
        # keeping the old film's release date or director would be wrong.
        movie.runtime = details["runtime"]
        movie.release_date = details["release_date"]
        movie.release_year = rel_year or details["release_year"]
        movie.director = details["director"]
        movie.top_cast = details["top_cast"]
        movie.language = details["language"]
    else:
        movie.release_year = rel_year

    db.session.commit()
    invalidate_stats_cache()
    
    return jsonify({
        "success": True, 
        "message": "Movie re-matched", 
        "show": {
            "id": movie.id, "tmdb_id": movie.tmdb_id, "name": movie.name, 
            "poster_path": movie.poster_path, "status": movie.status, "type": "movie"
        }
    })

@media_bp.route('/api/movies/diary', methods=['GET'])
@require_access("sabdekho")
def get_movie_diary():
    logs = MovieDiaryLog.query.order_by(MovieDiaryLog.date.desc(), MovieDiaryLog.created_at.desc()).all()
    result = []
    for log in logs:
        result.append({
            "id": log.id,
            "show_id": log.movie_id,
            "tmdb_id": log.movie.tmdb_id if log.movie else None,
            "show_name": log.movie.name if log.movie else "Unknown",
            "poster_path": log.movie.poster_path if log.movie else None,
            "date": log.date.isoformat(),
            "rating": log.rating,
            "review": log.review,
            "liked": log.liked,
            "rewatch": log.rewatch,
            "tags": log.tags,
            "created_at": log.created_at.isoformat()
        })
    return jsonify({"success": True, "logs": result})

@media_bp.route('/api/movies/diary', methods=['POST'])
@require_access("sabdekho")
def add_movie_diary():
    data = request.json
    movie_id = data.get('movie_id') or data.get('tv_show_id') # keeping tv_show_id property name for frontend compatibility
    if not movie_id:
        return jsonify({"success": False, "message": "movie_id is required"}), 400
    if not Movie.query.get(movie_id):
        return jsonify({"success": False, "message": "Movie not found"}), 404
    log_date_str = data.get('date')
    log_date = datetime.strptime(log_date_str, "%Y-%m-%d").date() if log_date_str else date.today()
    new_log = MovieDiaryLog(
        movie_id=movie_id,
        date=log_date,
        rating=data.get('rating'),
        review=data.get('review'),
        liked=data.get('liked', False),
        rewatch=data.get('rewatch', False),
        tags=data.get('tags')
    )
    db.session.add(new_log)
    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True, "message": "Logged successfully", "id": new_log.id})

@media_bp.route('/api/movies/diary', methods=['PUT'])
@require_access("sabdekho")
def update_movie_diary():
    data = request.json
    log_ids = data.get('log_ids', [])
    if not log_ids:
        return jsonify({"success": False, "message": "log_ids required"}), 400
    update_data = {}
    if 'rating' in data: update_data['rating'] = data['rating'] or None
    if 'review' in data: update_data['review'] = data['review'] or None
    if 'liked' in data: update_data['liked'] = data['liked']
    if 'rewatch' in data: update_data['rewatch'] = data['rewatch']
    if 'tags' in data: update_data['tags'] = data['tags'] or None

    extra, error = _diary_date_and_episode_updates(data, include_episode=False)
    if error:
        return jsonify({"success": False, "message": error}), 400
    update_data.update(extra)
    if not update_data:
        return jsonify({"success": True})

    MovieDiaryLog.query.filter(MovieDiaryLog.id.in_(log_ids)).update(update_data, synchronize_session=False)
    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True})

@media_bp.route('/api/movies/diary', methods=['DELETE'])
@require_access("sabdekho")
def delete_movie_diary():
    log_ids = request.json.get('log_ids', [])
    if not log_ids:
        return jsonify({"success": False, "message": "log_ids required"}), 400
    MovieDiaryLog.query.filter(MovieDiaryLog.id.in_(log_ids)).delete(synchronize_session=False)
    db.session.commit()
    invalidate_stats_cache()
    return jsonify({"success": True})

from flask import stream_with_context, Response
def _perform_rss_sync_generator(username, fast_mode=False):
    import json
    yield json.dumps({"status": "Fetching RSS feed..."}) + "\n"
    
    try:
        headers = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Connection': 'close'}
        r = requests.get(f'https://letterboxd.com/{username}/rss/', headers=headers, timeout=10)
        if r.status_code != 200:
            yield json.dumps({"success": False, "message": f"Failed to fetch RSS: {r.status_code}"}) + "\n"
            return
        
        root = ET.fromstring(r.content)
        items = root.findall('.//item')
        if fast_mode:
            items = items[:5] # Only check the 5 most recent logs in fast mode
        
        yield json.dumps({"status": f"Found {len(items)} logs. Processing..."}) + "\n"
        
        added_movies = 0
        added_logs = 0
        detail_checked = set()  # movie ids whose TMDB details were already looked up this sync

        # Namespaces in Letterboxd RSS
        ns = {'letterboxd': 'https://letterboxd.com'}
    
        tmdb_session = requests.Session()
        tmdb_session.headers.update({
            "accept": "application/json",
            "Authorization": f"Bearer {TMDB_API_KEY}",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
        })

        for i, item in enumerate(items):
            title = item.find('letterboxd:filmTitle', ns)
            year = item.find('letterboxd:filmYear', ns)
            if title is None:
                continue
            
            film_title = title.text
            film_year = year.text if year is not None else ""
        
            if i % 5 == 0:
                yield json.dumps({"status": f"Processing {i+1}/{len(items)}: {film_title}..."}) + "\n"
        
            watched_date_node = item.find('letterboxd:watchedDate', ns)
            watched_date_str = watched_date_node.text if watched_date_node is not None else ""
            if not watched_date_str:
                pub_date = item.find('pubDate')
                if pub_date is not None:
                    # Very simple fallback for pubdate string parsing
                    watched_date_str = datetime.strptime(pub_date.text[5:16], "%d %b %Y").strftime("%Y-%m-%d")
                else:
                    watched_date_str = date.today().strftime("%Y-%m-%d")
                
            rating_node = item.find('letterboxd:memberRating', ns)
            rating = float(rating_node.text) if rating_node is not None else 0
        
            rewatch_node = item.find('letterboxd:rewatch', ns)
            rewatch = True if rewatch_node is not None and rewatch_node.text == 'Yes' else False
        
            liked_node = item.find('letterboxd:memberLike', ns)
            liked = True if liked_node is not None and liked_node.text == 'Yes' else False

            import re
            description_node = item.find('description')
            review_text = ""
            if description_node is not None and description_node.text:
                review_html = description_node.text
                review_text = re.sub(r'<[^>]+>', '', review_html).strip()

            # Check if this movie exists in our local DB by name (basic check first)
            movie = Movie.query.filter_by(name=film_title).first()
            if not movie:
                # Query TMDB
                import time
                time.sleep(0.1) # Small delay
            
                search_url = f"https://api.themoviedb.org/3/search/movie?query={requests.utils.quote(film_title)}"
                if film_year:
                    search_url += f"&year={film_year}"
            
                try:
                    max_attempts = 1 if fast_mode else 3
                    timeout_secs = 3 if fast_mode else 10
                    for attempt in range(max_attempts):
                        try:
                            tmdb_r = tmdb_session.get(search_url, timeout=timeout_secs).json()
                            break
                        except requests.exceptions.ConnectionError:
                            if attempt == max_attempts - 1:
                                print(f"Skipping {film_title} due to ConnectionError after {max_attempts} attempts")
                                tmdb_r = None
                            else:
                                time.sleep(1) # wait longer before retry
                except Exception as e:
                    print(f"Error fetching {film_title}: {e}")
                    continue
                
                if tmdb_r and tmdb_r.get('results'):
                    first_result = tmdb_r['results'][0]
                    tmdb_id = first_result['id']
                    movie = Movie.query.filter_by(tmdb_id=tmdb_id).first()
                    if not movie:
                        details = fetch_tmdb_movie_details(tmdb_id, session=tmdb_session, timeout=timeout_secs)
                        fallback_year = None
                        if first_result.get('release_date'):
                            try:
                                fallback_year = int(first_result['release_date'][:4])
                            except (TypeError, ValueError):
                                fallback_year = None

                        movie = Movie(
                            tmdb_id=tmdb_id,
                            name=first_result.get('title') or film_title,
                            poster_path=first_result.get('poster_path'),
                            status='WATCHED',
                            runtime=details["runtime"],
                            release_year=details["release_year"] or fallback_year,
                            release_date=details["release_date"] or first_result.get('release_date') or None,
                            director=details["director"],
                            top_cast=details["top_cast"],
                            language=details["language"],
                        )
                        db.session.add(movie)
                        db.session.flush() # Get ID
                        detail_checked.add(movie.id)  # details were just fetched
                    added_movies += 1
                else:
                    continue # Couldn't find in TMDB
        
            # Fill in details older imports never stored, so stats like Newest
            # Release have a real date to work with. Only runs while something
            # is missing, and at most once per film per sync.
            if movie.tmdb_id and movie.id not in detail_checked and (movie.runtime is None or not movie.release_date):
                detail_checked.add(movie.id)
                details = fetch_tmdb_movie_details(movie.tmdb_id, session=tmdb_session, timeout=3 if fast_mode else 10)
                if details["fetched"]:
                    movie.runtime = movie.runtime or details["runtime"]
                    movie.release_date = movie.release_date or details["release_date"]
                    movie.release_year = movie.release_year or details["release_year"]
                    movie.director = movie.director or details["director"]
                    movie.top_cast = movie.top_cast or details["top_cast"]
                    movie.language = movie.language or details["language"]

            # Ensure movie status is WATCHED if we are importing a log
            if movie.status != 'WATCHED':
                movie.status = 'WATCHED'
                db.session.commit()
            
            # Create or update diary log
            log_date = datetime.strptime(watched_date_str, "%Y-%m-%d").date()
            existing_log = MovieDiaryLog.query.filter_by(movie_id=movie.id, date=log_date).first()
            if not existing_log:
                log = MovieDiaryLog(
                    movie_id=movie.id,
                    date=log_date,
                    rating=rating,
                    rewatch=rewatch,
                    liked=liked,
                    review=review_text
                )
                db.session.add(log)
                added_logs += 1
            else:
                # If log exists but review is empty and we have a review now, update it
                updated = False
                if review_text and not existing_log.review:
                    existing_log.review = review_text
                    updated = True
                if rating and not existing_log.rating:
                    existing_log.rating = rating
                    updated = True
                if liked and not existing_log.liked:
                    existing_log.liked = True
                    updated = True
            
                if updated:
                    added_logs += 1 # Count as a modified log for user feedback

        db.session.commit()
        invalidate_stats_cache()
        yield json.dumps({"status": "complete", "success": True, "added_movies": added_movies, "added_logs": added_logs}) + "\n"

    except Exception as e:
        import traceback
        traceback.print_exc()
        print("RSS SYNC ERROR", repr(e))
        yield json.dumps({"success": False, "message": str(e)}) + "\n"

LETTERBOXD_NAME = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


def letterboxd_username():
    """The signed-in person's Letterboxd username, or None."""
    owner = data_owner()
    row = db.session.get(UserSettings, owner) if owner else None
    return (row.letterboxd_username or None) if row else None


def save_letterboxd_username(username):
    """Remember (or with a blank, forget) the signed-in person's Letterboxd username."""
    owner = data_owner()
    if not owner:
        return
    row = db.session.get(UserSettings, owner)
    if row is None:
        row = UserSettings(email=owner)
        db.session.add(row)
    row.letterboxd_username = (username or "").strip() or None
    db.session.commit()


@media_bp.route('/api/movies/sync/rss', methods=['POST'])
@require_access("sabdekho")
def sync_letterboxd_rss():
    data = request.json or {}
    username = (data.get('username') or '').strip() or letterboxd_username()
    if not username:
        return jsonify({"success": False, "message": "Username required"}), 400
    if not LETTERBOXD_NAME.match(username):
        return jsonify({"success": False, "message": "That isn't a Letterboxd username"}), 400
    if not TMDB_API_KEY:
        return jsonify({"success": False, "message": "TMDB API Key missing on server"}), 500
    # Syncing a username makes it this person's, for later syncs and cinema spends.
    if username != letterboxd_username():
        save_letterboxd_username(username)

    return Response(stream_with_context(_perform_rss_sync_generator(username)), mimetype='application/x-ndjson')

def _matches_language(item_language, language_filter):
    """language_filter is a raw ISO code, "unknown", or "all" (no filter)."""
    if language_filter == 'all':
        return True
    lang = (item_language or '').lower()
    if language_filter == 'unknown':
        return not lang
    return lang == language_filter.lower()


def _iso_week_bucket(d):
    """
    ISO week (1-52) for a date, folding the year-boundary weeks the same way
    the stats charts do: an early-Jan date in ISO week 52/53 counts as week 1,
    a late-Dec date in ISO week 1 counts as week 53 which then folds into 52.
    Keeps a "week N" library filter pointing at exactly the dates a "week N"
    chart bar counted.
    """
    wk = d.isocalendar()[1]
    if d.month == 1 and wk >= 52:
        wk = 1
    elif d.month == 12 and wk == 1:
        wk = 53
    return 52 if wk == 53 else wk


def _diary_filtered_ids(rows, year_filter, month_filter, week_filter):
    """
    rows: iterable of (item_id, date) from a diary log table. Returns the set
    of ids with at least one log matching every active filter ('all' skips
    that dimension), or None if no date filter is active at all.
    """
    if year_filter == 'all' and month_filter == 'all' and week_filter == 'all':
        return None
    try:
        yr = int(year_filter) if year_filter != 'all' else None
        mo = int(month_filter) if month_filter != 'all' else None
        wk = int(week_filter) if week_filter != 'all' else None
    except ValueError:
        return set()

    ids = set()
    for item_id, d in rows:
        if not d:
            continue
        if yr is not None and d.year != yr:
            continue
        if mo is not None and d.month != mo:
            continue
        if wk is not None and _iso_week_bucket(d) != wk:
            continue
        ids.add(item_id)
    return ids


@media_bp.route('/api/media/library', methods=['GET'])
@require_access("sabdekho")
def get_media_library():
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    media_type = request.args.get('type', 'all')
    status_filter = request.args.get('status', 'all')
    year_filter = request.args.get('year', 'all')
    month_filter = request.args.get('month', 'all')
    week_filter = request.args.get('week', 'all')
    language_filter = request.args.get('language', 'all')

    # "By year/month/week" means "watched then" (from diary logs), not a
    # release date — the same thing the stats charts count. Resolved once per
    # media kind as a set of ids so the item loop below stays a membership test.
    movie_date_ids = _diary_filtered_ids(
        db.session.query(MovieDiaryLog.movie_id, MovieDiaryLog.date).all(),
        year_filter, month_filter, week_filter,
    )
    show_date_ids = _diary_filtered_ids(
        db.session.query(TvDiaryLog.tv_show_id, TvDiaryLog.date).all(),
        year_filter, month_filter, week_filter,
    )

    combined = []

    if media_type in ['all', 'movie']:
        from sqlalchemy.sql import func
        movies = db.session.query(Movie, func.max(MovieDiaryLog.date).label('latest_log')).outerjoin(MovieDiaryLog, Movie.id == MovieDiaryLog.movie_id).group_by(Movie.id).all()
        for m, latest_log in movies:
            if m.status == 'NONE':
                continue
            if status_filter != 'all' and m.status != status_filter:
                continue
            if movie_date_ids is not None and m.id not in movie_date_ids:
                continue
            if not _matches_language(m.language, language_filter):
                continue

            sort_date = m.added_on
            if latest_log:
                sort_date = datetime.combine(latest_log, datetime.min.time())

            combined.append({
                "id": m.id,
                "tmdb_id": m.tmdb_id,
                "name": m.name,
                "poster_path": m.poster_path,
                "status": m.status,
                "added_on": sort_date,
                "type": "movie"
            })

    if media_type in ['all', 'tv']:
        from sqlalchemy.sql import func
        shows = db.session.query(TvShow, func.max(TvDiaryLog.date).label('latest_log')).outerjoin(TvDiaryLog, TvShow.id == TvDiaryLog.tv_show_id).group_by(TvShow.id).all()
        for s, latest_log in shows:
            if s.status == 'NONE':
                continue
            if status_filter != 'all' and s.status != status_filter:
                continue
            if show_date_ids is not None and s.id not in show_date_ids:
                continue
            if not _matches_language(s.language, language_filter):
                continue

            sort_date = s.added_on
            if latest_log:
                sort_date = datetime.combine(latest_log, datetime.min.time())

            combined.append({
                "id": s.id,
                "tmdb_id": s.tmdb_id,
                "name": s.name,
                "poster_path": s.poster_path,
                "status": s.status,
                "added_on": sort_date,
                "type": "tv"
            })

    # Sort by added_on DESC, then by id DESC
    combined.sort(key=lambda x: (x['added_on'] or datetime.min, x['id']), reverse=True)

    # Now convert datetime to string after sorting
    for item in combined:
        if item['added_on']:
            item['added_on'] = item['added_on'].isoformat()

    total_count = len(combined)
    paginated = combined[offset:offset+limit]

    return jsonify({
        "success": True,
        "shows": paginated,
        "total_count": total_count,
        "hasMore": (offset + limit) < total_count
    })


@media_bp.route('/api/media/filters', methods=['GET'])
@require_access("sabdekho")
def get_media_filters():
    """Years and languages the Library's 'More filters' dropdowns can offer."""
    from sqlalchemy.sql import extract

    movie_years = {int(r[0]) for r in db.session.query(extract('year', MovieDiaryLog.date)).distinct() if r[0]}
    tv_years = {int(r[0]) for r in db.session.query(extract('year', TvDiaryLog.date)).distinct() if r[0]}
    years = sorted(movie_years | tv_years, reverse=True)

    movie_langs = {r[0] for r in db.session.query(Movie.language).distinct()}
    tv_langs = {r[0] for r in db.session.query(TvShow.language).distinct()}
    all_langs = movie_langs | tv_langs

    languages = sorted(
        ({"code": c.lower(), "label": _language_label(c)} for c in all_langs if c),
        key=lambda x: x["label"]
    )
    if any(not c for c in all_langs):
        languages.append({"code": "unknown", "label": "Unknown"})

    return jsonify({"success": True, "years": years, "languages": languages})

@media_bp.route('/api/media/diary', methods=['GET'])
@require_access("sabdekho")
def get_media_diary():
    limit = request.args.get('limit', 50, type=int)
    offset = request.args.get('offset', 0, type=int)
    media_type = request.args.get('type', 'all')
    
    show_id = request.args.get('show_id', type=int)
    
    combined = []
    
    if media_type in ['all', 'movie']:
        query = MovieDiaryLog.query.options(joinedload(MovieDiaryLog.movie))
        if show_id and media_type == 'movie':
            query = query.filter_by(movie_id=show_id)
        logs = query.all()
        for log in logs:
            combined.append({
                "id": log.id,
                "show_id": log.movie_id,
                "tmdb_id": log.movie.tmdb_id if log.movie else None,
                "show_name": log.movie.name if log.movie else "Unknown",
                "poster_path": log.movie.poster_path if log.movie else None,
                "date": log.date,
                "rating": log.rating,
                "review": log.review,
                "liked": log.liked,
                "rewatch": log.rewatch,
                "tags": log.tags,
                "created_at": log.created_at,
                "type": "movie"
            })
            
    if media_type in ['all', 'tv']:
        query = TvDiaryLog.query.options(joinedload(TvDiaryLog.tv_show))
        if show_id and media_type == 'tv':
            query = query.filter_by(tv_show_id=show_id)
        logs = query.all()
        for log in logs:
            combined.append({
                "id": log.id,
                "show_id": log.tv_show_id,
                "tmdb_id": log.tv_show.tmdb_id if log.tv_show else None,
                "show_name": log.tv_show.name if log.tv_show else "Unknown",
                "poster_path": log.tv_show.poster_path if log.tv_show else None,
                "season_number": log.season_number,
                "episode_number": log.episode_number,
                "date": log.date,
                "rating": log.rating,
                "review": log.review,
                "liked": log.liked,
                "rewatch": log.rewatch,
                "tags": log.tags,
                "created_at": log.created_at,
                "type": "tv"
            })
            
    # Sort by date DESC, then created_at DESC
    combined.sort(key=lambda x: (x['date'] or date.min, x['created_at'] or datetime.min), reverse=True)
    
    for item in combined:
        if item['date']:
            item['date'] = item['date'].isoformat() if hasattr(item['date'], 'isoformat') else str(item['date'])
        if item['created_at']:
            item['created_at'] = item['created_at'].isoformat() if hasattr(item['created_at'], 'isoformat') else str(item['created_at'])
    
    total_count = len(combined)
    paginated = combined[offset:offset+limit]
    
    return jsonify({
        "success": True, 
        "logs": paginated, 
        "total_count": total_count,
        "hasMore": (offset + limit) < total_count
    })
