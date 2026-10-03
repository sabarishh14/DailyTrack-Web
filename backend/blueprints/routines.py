"""Routines: personal habits, challenges and recurring chores, with a daily check-in.

Storage, plus worked-out views of it for the web page and Nagapandi. The phone
works the same things out itself (it needs them offline for the nightly check-in);
routines_engine.py is a port of its rules, kept in step by mirrored tests.

Routines are personal: every query is scoped to the signed-in person's email, so
the shared API key, which has no person behind it, can't reach them. Anyone who can
view the "gym" module (shown as Routines) manages their own list, so writes only
need view access too.
"""
import calendar
from datetime import datetime, timedelta, timezone

import pytz
from flask import Blueprint, request, jsonify

import routines_engine as rules
from extensions import db
from models import Routine, RoutineCheckIn
from access import require_access, current_access
from tenancy import data_owner

routines_bp = Blueprint("routines", __name__)

IST = pytz.timezone("Asia/Kolkata")

KINDS = ("build", "avoid")
SCHEDULES = ("daily", "days", "weekly", "monthly", "interval")
UNITS = ("day", "week", "month")
STATUSES = ("done", "missed", "skipped")
TARGET_LIMITS = {"weekly": 7, "monthly": 31}
MAX_NAME, MAX_EMOJI, MAX_NOTE = 60, 16, 120
MAX_BATCH = 500


def _owner():
    """Whose routines: the signed-in person's, or someone's shared with them
    (read-only, enforced in access.py). None for the service key."""
    if current_access().email is None:
        return None
    return (data_owner() or "").strip().lower() or None


def _no_person():
    return jsonify({"success": False, "message": "Routines belong to a signed-in person"}), 403


def _bad(message):
    return jsonify({"success": False, "message": message}), 400


def _ist_today():
    return datetime.now(IST).date()


def _parse_date(value):
    return datetime.strptime(str(value), "%Y-%m-%d").date()


def _int_in(value, low, high):
    """value as an int within [low, high], or None."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if low <= number <= high else None


def _created_date(r):
    """The IST day it was added. Unanswered days before then aren't held against
    it: nobody could have answered them."""
    if not r.created_at:
        return None
    return r.created_at.replace(tzinfo=timezone.utc).astimezone(IST).date()


def _created_on(r):
    created = _created_date(r)
    return created.isoformat() if created else None


def _routine_dict(r):
    return {
        "id": r.id,
        "name": r.name,
        "emoji": r.emoji,
        "kind": r.kind,
        "schedule": r.schedule,
        "days": r.days,
        "target": r.target,
        "every": r.every,
        "unit": r.unit,
        "start_date": r.start_date.isoformat(),
        "end_date": r.end_date.isoformat() if r.end_date else None,
        "sort_order": r.sort_order,
        "archived": bool(r.archived),
        "created_at": _created_on(r),
    }


def _checkin_dict(c):
    return {"routine_id": c.routine_id, "date": c.date.isoformat(), "status": c.status, "note": c.note}


def _apply_fields(routine, data, creating):
    """Validates data onto routine; returns an error message, or None when it's fine.

    On an update only the fields present are changed, but the schedule's own
    fields are always re-checked against the (possibly new) schedule."""
    if creating or "name" in data:
        name = str(data.get("name") or "").strip()
        if not name:
            return "Give the routine a name"
        if len(name) > MAX_NAME:
            return f"Keep the name under {MAX_NAME} characters"
        routine.name = name
    if creating or "emoji" in data:
        emoji = str(data.get("emoji") or "").strip()
        if len(emoji) > MAX_EMOJI:
            return "That emoji is too long"
        routine.emoji = emoji or None
    if creating or "kind" in data:
        kind = data.get("kind") or "build"
        if kind not in KINDS:
            return "Unknown routine type"
        routine.kind = kind
    if creating or "schedule" in data:
        schedule = data.get("schedule") or "daily"
        if schedule not in SCHEDULES:
            return "Unknown schedule"
        routine.schedule = schedule

    schedule = routine.schedule
    if schedule == "days":
        days = _int_in(data.get("days", routine.days), 1, 127)
        if days is None:
            return "Pick at least one day"
        routine.days = days
    else:
        routine.days = None
    if schedule in TARGET_LIMITS:
        limit = TARGET_LIMITS[schedule]
        target = _int_in(data.get("target", routine.target), 1, limit)
        if target is None:
            return f"Times per {'week' if schedule == 'weekly' else 'month'} must be 1 to {limit}"
        routine.target = target
    else:
        routine.target = None
    if schedule == "interval":
        every = _int_in(data.get("every", routine.every), 1, 365)
        unit = data.get("unit", routine.unit)
        if every is None or unit not in UNITS:
            return "Say how often it repeats"
        routine.every, routine.unit = every, unit
    else:
        routine.every, routine.unit = None, None

    try:
        if creating or "start_date" in data:
            raw = data.get("start_date")
            routine.start_date = _parse_date(raw) if raw else _ist_today()
        if creating or "end_date" in data:
            raw = data.get("end_date")
            routine.end_date = _parse_date(raw) if raw else None
    except ValueError:
        return "Dates must look like 2026-09-30"
    if routine.end_date and routine.end_date < routine.start_date:
        return "A challenge can't end before it starts"

    if "sort_order" in data:
        order = _int_in(data.get("sort_order"), -1_000_000, 1_000_000)
        if order is None:
            return "Invalid order"
        routine.sort_order = order
    if "archived" in data:
        routine.archived = bool(data.get("archived"))
    return None


def _owned(routine_id, owner):
    return Routine.query.filter_by(id=routine_id, owner_email=owner).first()


@routines_bp.route('/api/routines', methods=['GET'])
@require_access("gym", "view")
def list_routines():
    """Every routine this person has (archived too) and all their check-ins."""
    owner = _owner()
    if not owner:
        return _no_person()
    routines = (Routine.query.filter_by(owner_email=owner)
                .order_by(Routine.sort_order, Routine.id).all())
    ids = [r.id for r in routines]
    checkins = []
    if ids:
        checkins = (RoutineCheckIn.query.filter(RoutineCheckIn.routine_id.in_(ids))
                    .order_by(RoutineCheckIn.date, RoutineCheckIn.routine_id).all())
    return jsonify({
        "success": True,
        "routines": [_routine_dict(r) for r in routines],
        "checkins": [_checkin_dict(c) for c in checkins],
    })


@routines_bp.route('/api/routines', methods=['POST'])
@require_access("gym", "view")
def create_routine():
    owner = _owner()
    if not owner:
        return _no_person()
    data = request.json or {}
    routine = Routine(owner_email=owner, archived=False)
    error = _apply_fields(routine, data, creating=True)
    if error:
        return _bad(error)
    if "sort_order" not in data:
        last = (db.session.query(db.func.max(Routine.sort_order))
                .filter(Routine.owner_email == owner).scalar())
        routine.sort_order = (last if last is not None else -1) + 1
    db.session.add(routine)
    db.session.commit()
    return jsonify({"success": True, "routine": _routine_dict(routine)})


@routines_bp.route('/api/routines/<int:routine_id>', methods=['PUT'])
@require_access("gym", "view")
def update_routine(routine_id):
    owner = _owner()
    if not owner:
        return _no_person()
    routine = _owned(routine_id, owner)
    if not routine:
        return jsonify({"success": False, "message": "Routine not found"}), 404
    error = _apply_fields(routine, request.json or {}, creating=False)
    if error:
        db.session.rollback()
        return _bad(error)
    db.session.commit()
    return jsonify({"success": True, "routine": _routine_dict(routine)})


@routines_bp.route('/api/routines/<int:routine_id>', methods=['DELETE'])
@require_access("gym", "view")
def delete_routine(routine_id):
    """Removes the routine and its whole history. Archiving keeps both."""
    owner = _owner()
    if not owner:
        return _no_person()
    routine = _owned(routine_id, owner)
    if not routine:
        return jsonify({"success": False, "message": "Routine not found"}), 404
    RoutineCheckIn.query.filter_by(routine_id=routine.id).delete(synchronize_session=False)
    db.session.delete(routine)
    db.session.commit()
    return jsonify({"success": True})


def _upsert_statement(values):
    """Insert-or-update on (routine_id, date), atomically, so a retried batch
    from the phone's offline queue can never trip the unique constraint."""
    if db.engine.dialect.name == "postgresql":
        from sqlalchemy.dialects.postgresql import insert
    else:  # SQLite, which the API tests run on
        from sqlalchemy.dialects.sqlite import insert
    stmt = insert(RoutineCheckIn).values(**values)
    return stmt.on_conflict_do_update(
        index_elements=["routine_id", "date"],
        set_={"status": stmt.excluded.status, "note": stmt.excluded.note, "updated_at": stmt.excluded.updated_at},
    )


@routines_bp.route('/api/routines/checkins', methods=['POST'])
@require_access("gym", "view")
def save_checkins():
    """Saves a batch of answers: {"checkins": [{routine_id, date, status, note}]}.

    A null status clears that day's answer. Entries that can't be saved (someone
    else's routine, one since deleted, a date too far ahead) are skipped and listed
    under "ignored" rather than failing the batch, so the phone can drop them from
    its queue instead of retrying forever."""
    owner = _owner()
    if not owner:
        return _no_person()
    entries = (request.json or {}).get("checkins")
    if not isinstance(entries, list):
        return _bad("Expected a list of check-ins")
    if len(entries) > MAX_BATCH:
        return _bad(f"At most {MAX_BATCH} check-ins at a time")

    own_ids = {r.id for r in Routine.query.with_entities(Routine.id).filter_by(owner_email=owner)}
    # A day ahead of IST, so a phone in a timezone past midnight isn't refused.
    latest = _ist_today() + timedelta(days=1)
    now = datetime.utcnow()
    saved, ignored = 0, []
    for entry in entries:
        entry = entry if isinstance(entry, dict) else {}
        routine_id = _int_in(entry.get("routine_id"), 1, 2**62)
        try:
            day = _parse_date(entry.get("date"))
        except ValueError:
            day = None
        status = entry.get("status")
        reason = None
        if routine_id not in own_ids:
            reason = "unknown routine"
        elif day is None or day > latest:
            reason = "bad date"
        elif status is not None and status not in STATUSES:
            reason = "bad status"
        if reason:
            ignored.append({"routine_id": entry.get("routine_id"), "date": entry.get("date"), "reason": reason})
            continue
        if status is None:
            RoutineCheckIn.query.filter_by(routine_id=routine_id, date=day).delete(synchronize_session=False)
        else:
            note = str(entry.get("note") or "").strip()[:MAX_NOTE] or None
            db.session.execute(_upsert_statement(
                {"routine_id": routine_id, "date": day, "status": status, "note": note, "updated_at": now}
            ))
        saved += 1
    db.session.commit()
    return jsonify({"success": True, "saved": saved, "ignored": ignored})


# ---- worked-out views: the web page and Nagapandi ----

WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
CHAT_ANSWER_DAYS = 60
CHAT_MAX_CHARS = 12000


def _to_rules(r):
    return rules.Routine(
        id=r.id, name=r.name, emoji=r.emoji, kind=r.kind, schedule=r.schedule,
        days=r.days, target=r.target, every=r.every, unit=r.unit,
        start_date=r.start_date, end_date=r.end_date, sort_order=r.sort_order or 0,
        archived=bool(r.archived), created_on=_created_date(r),
    )


def _load(owner):
    """(stored rows, the engine over them) for one person."""
    rows = (Routine.query.filter_by(owner_email=owner)
            .order_by(Routine.sort_order, Routine.id).all())
    ids = [r.id for r in rows]
    checkins = RoutineCheckIn.query.filter(RoutineCheckIn.routine_id.in_(ids)).all() if ids else []
    engine = rules.RoutineEngine(
        [_to_rules(r) for r in rows],
        [rules.CheckIn(c.routine_id, c.date, c.status, c.note) for c in checkins],
    )
    return rows, engine


# Wording, as the phone words it (RoutineText.kt).

def _day_month(d):
    return f"{d.day} {d.strftime('%b')}"


def _weekdays(mask):
    mask = mask or 0
    named = {0b1111111: "Every day", 0b0011111: "Weekdays", 0b1100000: "Weekends", 0: "No days picked"}
    if mask in named:
        return named[mask]
    return ", ".join(name for i, name in enumerate(WEEKDAYS) if mask & (1 << i))


def _schedule_text(r):
    if r.schedule == "daily":
        return "Every day"
    if r.schedule == "days":
        return _weekdays(r.days)
    if r.schedule in ("weekly", "monthly"):
        return f"{r.target or 1}× a {'week' if r.schedule == 'weekly' else 'month'}"
    every, word = r.every or 1, r.unit or "day"
    return f"Every {word}" if every == 1 else f"Every {every} {word}s"


def _due_in(d, today):
    days = (d - today).days
    if days <= 0:
        return "today"
    if days == 1:
        return "tomorrow"
    return f"in {days} days" if days < 7 else _day_month(d)


def _summary_line(r, today, next_due):
    """The line under a routine in "Your routines"."""
    parts = ["Quitting"] if r.kind == "avoid" else []
    if r.end_date and today > r.end_date:
        parts.append("Challenge finished")
    elif r.end_date and today < r.start_date:
        parts.append(f"{r.challenge_length}-day challenge")
    elif r.end_date:
        parts.append(f"Day {r.challenge_day(today)} of {r.challenge_length}")
    else:
        parts.append(_schedule_text(r))
    if next_due:
        parts.append(f"next {_due_in(next_due, today)}")
    return " · ".join(parts)


def _item_line(item, streak):
    """The line under a routine on a day's list."""
    r, parts = item.routine, []
    challenge_day = r.challenge_day(item.date)
    if challenge_day:
        parts.append(f"Day {challenge_day} of {r.challenge_length}")
    if r.schedule in ("weekly", "monthly"):
        p = item.progress
        if p:
            parts.append(f"Done for this {p.unit}" if p.met and p.needed > 0 else f"{p.done} of {p.needed} this {p.unit}")
    elif r.schedule == "interval":
        if item.due_date:
            late = (item.date - item.due_date).days
            if item.status == rules.DONE and late <= 0:
                parts.append("Done early")
            elif late < 0:
                parts.append(f"Due {_day_month(item.due_date)}")
            elif late == 0:
                parts.append("Due today")
            else:
                parts.append("Overdue by a day" if late == 1 else f"Overdue by {late} days")
    elif not parts:
        parts.append(_schedule_text(r))
    if streak and streak.current >= 2:
        parts.append(f"🔥 {streak.current}")
    return " · ".join(parts)


# JSON shapes.

def _iso(d):
    return d.isoformat() if d else None


def _stats_json(s):
    if s is None:
        return None
    return {"date": s.date.isoformat(), "done": s.done, "total": s.total,
            "missed": s.missed, "skipped": s.skipped, "unanswered": s.unanswered}


def _score_json(s):
    return {"fraction": s.fraction, "successes": s.successes, "chances": s.chances}


def _streak_json(s):
    return {"current": s.current, "best": s.best, "unit": s.unit}


def _item_json(item, streak=None):
    p = item.progress
    return {
        "routine_id": item.routine.id,
        "date": item.date.isoformat(),
        "status": item.status,
        "note": item.note,
        "required": item.required,
        "needs_answer": item.needs_answer,
        "progress": {"done": p.done, "needed": p.needed, "unit": p.unit, "met": p.met} if p else None,
        "due_date": _iso(item.due_date),
        "line": _item_line(item, streak),
    }


def _month_param(today):
    """?month=2026-09 as its first day; this month when absent. Raises ValueError."""
    raw = request.args.get("month")
    if not raw:
        return today.replace(day=1)
    first = datetime.strptime(raw, "%Y-%m").date()
    return min(first, today.replace(day=1))


def _month_days(first, today):
    last = first.replace(day=calendar.monthrange(first.year, first.month)[1])
    return list(rules.days_between(first, min(last, today)))


def build_summary(owner, today, month):
    rows, engine = _load(owner)
    active = {r.id: r for r in engine.routines}
    streaks = {r.id: engine.streak(r, today) for r in active.values()}
    routines = []
    for row in rows:
        entry = {**_routine_dict(row), "schedule_text": _schedule_text(row)}
        r = active.get(row.id)
        if r is not None:
            next_due = engine.next_due(r)
            blank = engine.unanswered_past_days(r, today)
            entry.update({
                "past_blank": {"count": len(blank), "since": _iso(blank[0]) if blank else None},
                "line": _summary_line(r, today, next_due),
                "streak": _streak_json(streaks[r.id]),
                "consistency": _score_json(engine.routine_consistency(r, today)),
                "all_time": _score_json(engine.all_time(r, today)),
                "last_done": _iso(engine.last_done(r)),
                "next_due": _iso(next_due),
            })
        routines.append(entry)
    return {
        "success": True,
        "today": today.isoformat(),
        "stats": _stats_json(engine.day_stats(today)),
        "consistency": _score_json(engine.consistency(today)),
        "previous_consistency": _score_json(engine.previous_consistency(today)),
        "perfect_days": _streak_json(engine.perfect_days(today)),
        "items": [_item_json(i, streaks.get(i.routine.id)) for i in engine.day_items(today)],
        "upcoming": [{"routine_id": r.id, "date": d.isoformat(), "when": _due_in(d, today)}
                     for r, d in engine.upcoming(today)],
        "week": [_stats_json(s) for s in engine.week(today)],
        "month": month.strftime("%Y-%m"),
        "history": [_stats_json(engine.day_stats(d)) for d in _month_days(month, today)],
        "first_day": _iso(min((r.start_date for r in active.values()), default=None)),
        "routines": routines,
    }


@routines_bp.route('/api/routines/summary', methods=['GET'])
@require_access("gym", "view")
def routines_summary():
    """Everything the web page shows, worked out the way the phone works it out."""
    owner = _owner()
    if not owner:
        return _no_person()
    today = _ist_today()
    try:
        month = _month_param(today)
    except ValueError:
        return _bad("month must look like 2026-09")
    return jsonify(build_summary(owner, today, month))


@routines_bp.route('/api/routines/<int:routine_id>/fill-past', methods=['POST'])
@require_access("gym", "view")
def fill_past(routine_id):
    """Marks every due day before today that has no answer as done: "I've kept it
    up since then". Any single day can still be changed afterwards."""
    owner = _owner()
    if not owner:
        return _no_person()
    _, engine = _load(owner)
    r = next((r for r in engine.routines if r.id == routine_id), None)
    if r is None:
        return jsonify({"success": False, "message": "Routine not found"}), 404
    days = engine.unanswered_past_days(r, _ist_today())
    now = datetime.utcnow()
    for d in days:
        db.session.execute(_upsert_statement(
            {"routine_id": r.id, "date": d, "status": "done", "note": None, "updated_at": now}
        ))
    db.session.commit()
    return jsonify({"success": True, "filled": len(days)})


@routines_bp.route('/api/routines/day', methods=['GET'])
@require_access("gym", "view")
def routines_day():
    """One day's list, to look back at or fill in: ?date=2026-09-27."""
    owner = _owner()
    if not owner:
        return _no_person()
    today = _ist_today()
    try:
        day = _parse_date(request.args.get("date"))
    except ValueError:
        return _bad("date must look like 2026-09-30")
    if day > today:
        return _bad("That day hasn't happened yet")
    _, engine = _load(owner)
    streaks = {r.id: engine.streak(r, today) for r in engine.routines}
    items = engine.day_items(day)
    return jsonify({
        "success": True,
        "today": today.isoformat(),
        "date": day.isoformat(),
        "stats": _stats_json(engine.stats_of(day, items)),
        "items": [_item_json(i, streaks.get(i.routine.id) if day == today else None) for i in items],
    })


@routines_bp.route('/api/routines/<int:routine_id>/detail', methods=['GET'])
@require_access("gym", "view")
def routine_detail(routine_id):
    """One routine's page: its scores, a month of its days, and its skips."""
    owner = _owner()
    if not owner:
        return _no_person()
    today = _ist_today()
    try:
        month = _month_param(today)
    except ValueError:
        return _bad("month must look like 2026-09")
    rows, engine = _load(owner)
    r = next((r for r in engine.routines if r.id == routine_id), None)
    row = next((row for row in rows if row.id == routine_id), None)
    if r is None or row is None:
        return jsonify({"success": False, "message": "Routine not found"}), 404
    answers = engine.answers_for(r)
    current = engine.item_on(r, today)
    next_due = engine.next_due(r)
    days = []
    for d in _month_days(month, today):
        item = engine.item_on(r, d)
        days.append(_item_json(item) if item else {"date": d.isoformat(), "status": None, "due": False})
    return jsonify({
        "success": True,
        "today": today.isoformat(),
        "routine": {**_routine_dict(row), "schedule_text": _schedule_text(row),
                    "line": _summary_line(r, today, next_due)},
        "streak": _streak_json(engine.streak(r, today)),
        "consistency": _score_json(engine.routine_consistency(r, today)),
        "all_time": _score_json(engine.all_time(r, today)),
        "done_count": sum(1 for c in answers if c.status == rules.DONE),
        "last_done": _iso(engine.last_done(r)),
        "next_due": _iso(next_due),
        "progress": _item_json(current)["progress"] if current else None,
        "month": month.strftime("%Y-%m"),
        "days": days,
        "skips": [{"date": c.date.isoformat(), "note": c.note} for c in answers if c.status == rules.SKIPPED][:30],
    })


# ---- Nagapandi ----

def _percent(score):
    return f"{round(score.fraction * 100)}%" if score.fraction is not None else "no data yet"


def _streak_text(s):
    unit = {"day": "days", "week": "weeks", "month": "months", "time": "on time in a row"}[s.unit]
    return f"{s.current} {unit} (best {s.best})"


def _status_text(item):
    if item is None:
        return "not due"
    if item.status:
        return item.status + (f' ("{item.note}")' if item.note else "")
    return "not answered yet"


def routine_names(owner):
    """(names, earliest start) of this person's routines, so Nagapandi can tell
    when a question is about them."""
    rows = (Routine.query.with_entities(Routine.name, Routine.start_date)
            .filter_by(owner_email=owner, archived=False).all())
    return [name for name, _ in rows], min((start for _, start in rows), default=None)


def chat_context(owner, today):
    """What Nagapandi is told about one person's routines: the worked-out numbers,
    never raw rows, and only ever the asking person's own."""
    rows, engine = _load(owner)
    if not rows:
        return "They haven't added any routines yet."
    s = engine.day_stats(today)
    lines = [
        f"Today is {today:%A} {_day_month(today)} {today.year} (India time).",
        "How it's scored: done counts, missed counts against, skipped is excused. A past day left "
        "unanswered counts as missed. Times-per-week/month routines are judged per week or month, "
        "with partial credit. Chores are on time when done by their due date.",
        f"Today: {s.done} of {s.total} done, {s.missed} missed, {s.skipped} skipped, {s.unanswered} not answered yet.",
        f"Consistency over the last 30 days, all routines: {_percent(engine.consistency(today))} "
        f"(the 30 days before that: {_percent(engine.previous_consistency(today))}). "
        f"Perfect days streak: {_streak_text(engine.perfect_days(today))}.",
        "This week: " + "; ".join(
            f"{w.date:%a} {w.done}/{w.total} done" + (f", {w.missed} missed" if w.missed else "")
            + (f", {w.skipped} skipped" if w.skipped else "")
            for w in engine.week(today) if w is not None),
    ]
    upcoming = engine.upcoming(today)
    if upcoming:
        lines.append("Coming up: " + "; ".join(f"{r.name} {_due_in(d, today)}" for r, d in upcoming) + ".")
    lines.append("Routines:")
    since = today - timedelta(days=CHAT_ANSWER_DAYS - 1)
    for r in engine.routines:
        answers = engine.answers_for(r)
        facts = [
            f"- {(r.emoji + ' ') if r.emoji else ''}{r.name}"
            + (" (quitting)" if r.kind == "avoid" else "")
            + f": {_schedule_text(r)}, since {_day_month(r.start_date)} {r.start_date.year}",
        ]
        if r.end_date:
            day = r.challenge_day(today)
            facts.append(f"{r.challenge_length}-day challenge ending {_day_month(r.end_date)} {r.end_date.year}"
                         + (f", today is day {day}" if day else ""))
        facts.append(f"today {_status_text(engine.item_on(r, today))}")
        facts.append(f"streak {_streak_text(engine.streak(r, today))}")
        facts.append(f"last 30 days {_percent(engine.routine_consistency(r, today))}, "
                     f"all time {_percent(engine.all_time(r, today))}")
        counts = {k: sum(1 for c in answers if c.status == k) for k in STATUSES}
        facts.append(f"answered done {counts['done']}×, missed {counts['missed']}×, skipped {counts['skipped']}× in total")
        last_done, next_due = engine.last_done(r), engine.next_due(r)
        if last_done:
            facts.append(f"last done {_day_month(last_done)} {last_done.year}")
        if next_due:
            facts.append(f"next due {_day_month(next_due)} {next_due.year}")
        if r.schedule in ("daily", "days"):
            blank = [d for d in rules.days_between(max(since, r.start_date), today - timedelta(days=1))
                     if engine.item_on(r, d) is not None and engine.check_in(r.id, d) is None
                     and r.counts_if_unanswered(d)]
            if blank:
                facts.append("left unanswered (counted as missed): " + ", ".join(_day_month(d) for d in blank))
        recent = [c for c in answers if c.date >= since]
        if recent:
            facts.append(f"answers in the last {CHAT_ANSWER_DAYS} days: " + ", ".join(
                f"{_day_month(c.date)} {c.status}" + (f' ("{c.note}")' if c.note else "") for c in recent))
        lines.append("; ".join(facts) + ".")
    archived = [row.name for row in rows if row.archived]
    if archived:
        lines.append("Archived, no longer tracked: " + ", ".join(archived) + ".")
    return "\n".join(lines)[:CHAT_MAX_CHARS]
