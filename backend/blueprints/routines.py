"""Routines: personal habits, challenges and recurring chores, with a daily check-in.

Only storage lives here. Everything derived from it (what's due on a day, streaks,
the consistency score) is worked out on the phone, which needs it offline anyway
for the nightly check-in notification.

Routines are personal: every query is scoped to the signed-in person's email, so
the shared API key, which has no person behind it, can't reach them. Anyone who can
view the "gym" module (shown as Routines) manages their own list, so writes only
need view access too.
"""
from datetime import datetime, timedelta, timezone

import pytz
from flask import Blueprint, request, jsonify

from extensions import db
from models import Routine, RoutineCheckIn
from access import require_access, current_access

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
    """The signed-in person's email, or None for the service key."""
    return (current_access().email or "").strip().lower() or None


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


def _created_on(r):
    """The IST day it was added. The phone doesn't hold unanswered days before
    then against it: nobody could have answered them."""
    if not r.created_at:
        return None
    return r.created_at.replace(tzinfo=timezone.utc).astimezone(IST).date().isoformat()


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
