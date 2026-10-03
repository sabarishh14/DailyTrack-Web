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
from access import (
    require_api_key, require_admin, require_access, current_access,
    MODULES, LEVELS, ROLES, normalize_permissions, invalidate_access, ensure_access_schema,
)
from extensions import OWNER_EMAILS


admin_bp = Blueprint("admin", __name__)

# ==========================================
# 🚀 ACCESS CONTROL (admin only) — see ACCESS_CONTROL.md
# ==========================================
VIEWER_PERMISSIONS = {"modules": {m: "view" for m in MODULES}, "money_scope": {"categories": None, "accounts": None}}


def _clean_email(email):
    return (email or "").strip().lower()


def _serialize(row):
    return {
        "email": row.email,
        "role": row.role or "member",
        "legacy": row.role is None,  # pre-access-control guest, still has full access
        "permissions": normalize_permissions(row.permissions) if row.role else normalize_permissions(
            {"modules": {m: "edit" for m in MODULES}}),
        "added_on": row.added_on.isoformat() if row.added_on else None,
        "updated_on": row.updated_on.isoformat() if getattr(row, "updated_on", None) else None,
    }


def _find(email):
    return AllowedEmail.query.filter(db.func.lower(AllowedEmail.email) == email).first()


def _validate(email, role):
    if not email or "@" not in email:
        return "A valid email is required"
    if email in OWNER_EMAILS:
        return "Owners are permanent and can't be changed here"
    if role not in ROLES:
        return f"Role must be one of: {', '.join(ROLES)}"
    return None


@admin_bp.route('/api/admin/users', methods=['GET'])
@require_admin
def list_users():
    ensure_access_schema()
    rows = AllowedEmail.query.order_by(AllowedEmail.added_on.asc()).all()
    allowed = {_clean_email(r.email) for r in rows} | OWNER_EMAILS
    requests_ = [r for r in AccessRequest.query.order_by(AccessRequest.requested_at.desc()).all()
                 if _clean_email(r.email) not in allowed]
    return jsonify({
        "success": True,
        "owners": sorted(OWNER_EMAILS),
        "users": [_serialize(r) for r in rows if _clean_email(r.email) not in OWNER_EMAILS],
        "requests": [{"email": r.email, "name": r.name,
                      "requested_on": r.requested_at.isoformat() if r.requested_at else None} for r in requests_],
    })


def _drop_request(email):
    row = db.session.get(AccessRequest, email)
    if row is not None:
        db.session.delete(row)


@admin_bp.route('/api/admin/requests/<path:email>/approve', methods=['POST'])
@require_admin
def approve_request(email):
    """Lets someone who asked sign in, as a member with their own data."""
    ensure_access_schema()
    email = _clean_email(email)
    if not _find(email) and email not in OWNER_EMAILS:
        row = AllowedEmail(email=email)
        row.role = "member"
        row.permissions = normalize_permissions(VIEWER_PERMISSIONS)
        row.updated_on = datetime.utcnow()
        db.session.add(row)
    _drop_request(email)
    db.session.commit()
    invalidate_access(email)
    return jsonify({"success": True})


@admin_bp.route('/api/admin/requests/<path:email>', methods=['DELETE'])
@require_admin
def decline_request(email):
    _drop_request(_clean_email(email))
    db.session.commit()
    return jsonify({"success": True})


@admin_bp.route('/api/admin/access-options', methods=['GET'])
@require_admin
def access_options():
    """Everything the permission editor needs to render its pickers."""
    categories = [c[0] for c in db.session.query(Transaction.heading).distinct().all() if c[0]]
    accounts = [a.account for a in Account.query.all()]
    return jsonify({
        "success": True,
        "modules": list(MODULES),
        "levels": list(LEVELS),
        "roles": list(ROLES),
        "categories": sorted(categories),
        "accounts": sorted(accounts),
    })


@admin_bp.route('/api/admin/users', methods=['POST'])
@require_admin
def create_user():
    ensure_access_schema()
    data = request.json or {}
    email = _clean_email(data.get('email'))
    role = data.get('role', 'member')
    error = _validate(email, role)
    if error:
        return jsonify({"success": False, "message": error}), 400
    if _find(email):
        return jsonify({"success": False, "message": f"{email} already has access"}), 409

    row = AllowedEmail(email=email)
    row.role = role
    row.permissions = normalize_permissions(data.get('permissions') or VIEWER_PERMISSIONS)
    row.updated_on = datetime.utcnow()
    db.session.add(row)
    _drop_request(email)
    db.session.commit()
    invalidate_access(email)
    return jsonify({"success": True, "user": _serialize(row)})


@admin_bp.route('/api/admin/users/<path:email>', methods=['PUT'])
@require_admin
def update_user(email):
    ensure_access_schema()
    email = _clean_email(email)
    data = request.json or {}
    role = data.get('role', 'member')
    error = _validate(email, role)
    if error:
        return jsonify({"success": False, "message": error}), 400
    row = _find(email)
    if not row:
        return jsonify({"success": False, "message": "User not found"}), 404

    row.role = role
    row.permissions = normalize_permissions(data.get('permissions'))
    row.updated_on = datetime.utcnow()
    db.session.commit()
    invalidate_access(email)
    return jsonify({"success": True, "user": _serialize(row)})


@admin_bp.route('/api/admin/users/<path:email>', methods=['DELETE'])
@require_admin
def delete_user(email):
    ensure_access_schema()
    email = _clean_email(email)
    if email in OWNER_EMAILS:
        return jsonify({"success": False, "message": "Owners are permanent and can't be removed"}), 400
    row = _find(email)
    if row:
        db.session.delete(row)
        db.session.commit()
    # Drop the cached permissions so this worker rejects them right away;
    # other workers follow within the access cache TTL.
    invalidate_access(email)
    return jsonify({"success": True})


# ---- Legacy email-only endpoints (older app builds) ----
@admin_bp.route('/api/admin/emails', methods=['GET'])
@require_admin
def get_allowed_emails():
    ensure_access_schema()
    emails = AllowedEmail.query.all()
    return jsonify({"success": True, "emails": [e.email for e in emails]})

@admin_bp.route('/api/admin/emails', methods=['POST'])
@require_admin
def add_allowed_email():
    ensure_access_schema()
    new_email = _clean_email(request.json.get('email', ''))
    if not new_email:
        return jsonify({"success": False, "message": "Email is required"}), 400

    if not _find(new_email):
        # New users start as view-only; tighten or widen from the access editor.
        row = AllowedEmail(email=new_email)
        row.role = "member"
        row.permissions = normalize_permissions(VIEWER_PERMISSIONS)
        row.updated_on = datetime.utcnow()
        db.session.add(row)
        db.session.commit()
    invalidate_access(new_email)
    return jsonify({"success": True, "message": f"Added {new_email}"})

@admin_bp.route('/api/admin/emails/<path:email>', methods=['DELETE'])
@require_admin
def remove_allowed_email(email):
    return delete_user(email)
