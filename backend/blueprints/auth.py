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
from access import require_api_key, require_admin, require_access, current_access, get_access, invalidate_access
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
            return jsonify({"success": False, "message": f"Access denied for {email}"}), 403

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
    """The caller's current role, permissions and settings. Clients poll this to stay in sync."""
    return jsonify({"success": True, "access": current_access().to_dict(), "settings": _my_settings()})


def _my_settings():
    return {"letterboxd_username": letterboxd_username()}


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
