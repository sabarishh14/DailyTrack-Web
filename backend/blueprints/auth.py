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
    jwt, firebase_auth,
)
from models import *
from access import require_api_key, require_admin, require_access, current_access, get_access, invalidate_access, MODULES
from blueprints.media import letterboxd_username, save_letterboxd_username, LETTERBOXD_NAME


auth_bp = Blueprint("auth", __name__)

@auth_bp.route('/api/auth/firebase-login', methods=['POST'])
def firebase_login():
    try:
        id_token = request.json.get('id_token')
        if not id_token:
            return jsonify({"success": False, "message": "No token provided"}), 400

        # Verify the Firebase token with clock skew tolerance
        decoded = firebase_auth.verify_id_token(id_token, clock_skew_seconds=60)
        email = (decoded.get('email') or '').strip().lower()

        # Always read fresh at login so a just-added user isn't stuck behind a cached "denied"
        invalidate_access(email)
        access = get_access(email)
        if access is None:
            # Not in yet: ask an admin. Signing in again later just refreshes the request.
            if email:
                row = db.session.get(AccessRequest, email) or AccessRequest(email=email)
                row.name = (decoded.get('name') or '')[:120] or row.name
                row.requested_at = datetime.utcnow()
                db.session.add(row)
                db.session.commit()
            return jsonify({"success": False, "code": "REQUESTED", "email": email,
                            "message": "Request sent. You'll be able to sign in once it's approved."}), 403

        # Issue our own JWT. Permissions are NOT baked in; they're looked up per
        # request so changes and revocations apply without re-login.
        token = jwt.encode({
            "sub": email,
            "email": email,
            "iat": datetime.now(timezone.utc),
            "exp": datetime.now(timezone.utc) + timedelta(days=30)
        }, JWT_SECRET, algorithm="HS256")

        return jsonify({"success": True, "token": token, "isAdmin": access.is_admin, "access": access.to_dict()})

    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 401


@auth_bp.route('/api/auth/me', methods=['GET'])
@require_api_key
def get_me():
    """The caller's current role, permissions and settings, and whose data is
    shared with them. Clients poll this to stay in sync. While viewing someone
    else's data (X-View-As), access describes that view."""
    access = current_access()
    return jsonify({
        "success": True,
        "access": access.to_dict(),
        "settings": _my_settings(),
        "shared_with_me": _shared_with_me(),
        # Admins get a nudge when someone is waiting to join.
        "pending_requests": AccessRequest.query.count() if access.is_admin and access.email else 0,
    })


def _shared_with_me():
    me = current_access().email
    if not me:
        return []
    rows = Share.query.filter_by(viewer_email=me).order_by(Share.owner_email).all()
    return [{"owner": r.owner_email, "modules": _clean_modules(r.modules)} for r in rows if _clean_modules(r.modules)]


def _clean_modules(modules):
    return [m for m in MODULES if m in (modules or [])]


# ---- Sharing: let someone view some of your data, read-only ----
@auth_bp.route('/api/shares', methods=['GET'])
@require_api_key
def list_shares():
    me = current_access().email
    if not me:
        return jsonify({"success": False, "message": "Sharing belongs to a signed-in person"}), 403
    mine = Share.query.filter_by(owner_email=me).order_by(Share.created_at).all()
    return jsonify({
        "success": True,
        "mine": [{"viewer": r.viewer_email, "modules": _clean_modules(r.modules)} for r in mine],
        "with_me": _shared_with_me(),
    })


@auth_bp.route('/api/shares/<path:viewer>', methods=['PUT', 'DELETE'])
@require_api_key
def set_share(viewer):
    me = current_access().email
    viewer = (viewer or '').strip().lower()
    if not me:
        return jsonify({"success": False, "message": "Sharing belongs to a signed-in person"}), 403
    if not re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", viewer):
        return jsonify({"success": False, "message": "Enter a valid email"}), 400
    if viewer == me:
        return jsonify({"success": False, "message": "That's you"}), 400

    row = db.session.get(Share, {"owner_email": me, "viewer_email": viewer})
    modules = _clean_modules((request.json or {}).get('modules')) if request.method == 'PUT' else []
    if not modules:
        if row:
            db.session.delete(row)
            db.session.commit()
        return jsonify({"success": True, "share": None})
    if row is None:
        row = Share(owner_email=me, viewer_email=viewer)
        db.session.add(row)
    row.modules = modules
    db.session.commit()
    return jsonify({"success": True, "share": {"viewer": viewer, "modules": modules}})


def _my_settings():
    """The signed-in person's own settings, even while viewing someone else's data."""
    me = current_access().email
    row = db.session.get(UserSettings, me) if me else None
    return {"letterboxd_username": (row.letterboxd_username or None) if row else None}


@auth_bp.route('/api/me/settings', methods=['PUT'])
@require_api_key
def update_my_settings():
    """Change the signed-in person's own settings; keys left out stay as they are."""
    data = request.json or {}
    if 'letterboxd_username' in data:
        name = str(data.get('letterboxd_username') or '').strip()
        if name and not LETTERBOXD_NAME.match(name):
            return jsonify({"success": False, "message": "That isn't a Letterboxd username"}), 400
        save_letterboxd_username(name)
    return jsonify({"success": True, "settings": _my_settings()})
