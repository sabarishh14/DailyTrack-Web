"""Who may sign in, and what they may do.

See ACCESS_CONTROL.md at the repo root for the full model. In short:

  Everyone signed in has their own, separate data and full use of it. Every query
  on personal tables is limited to the request's data owner (tenancy.py).

  role   owner   - permanent, from OWNER_EMAILS; also the only one with the
                   features wired to the owner's own accounts (Google Sheets,
                   Drive OCR, Kite, Nagapandi)
         admin   - manages who can sign in; sees nobody else's data
         member  - everyone else

  levels none < view < edit, and the money scope (categories / accounts
  allow-lists), describe what someone may do with the data they're looking at.
  For their own data that's everything.

Every request re-checks the user against the allow-list (through a short
per-worker cache), so removing an email logs that person out everywhere
within CACHE_TTL seconds without adding a DB round-trip to normal requests.
"""
import time
from functools import wraps

import jwt
from flask import request, jsonify, g
from sqlalchemy import func, text

from extensions import db, API_SECRET_KEY, JWT_SECRET, ALLOWED_EMAILS, OWNER_EMAILS, PRIMARY_OWNER
from models import AllowedEmail, Transaction

MODULES = ("money", "gym", "invest", "sabdekho")
LEVELS = {"none": 0, "view": 1, "edit": 2}
ROLES = ("admin", "member")

# Pre-access-control guests had full access; rows without a role keep that
# until an admin edits them, so the upgrade doesn't lock anyone out.
FULL_EDIT_PERMISSIONS = {
    "modules": {m: "edit" for m in MODULES},
    "money_scope": {"categories": None, "accounts": None},
}

CACHE_TTL = 30  # seconds


def _normalize_list(value):
    """None means "no restriction"; anything else becomes a clean, sorted list."""
    if value is None:
        return None
    return sorted({str(v).strip() for v in value if str(v).strip()})


def normalize_permissions(raw):
    """Coerce admin-supplied permissions into the stored shape, dropping junk."""
    raw = raw or {}
    modules_in = raw.get("modules") or {}
    modules = {m: (modules_in.get(m) if modules_in.get(m) in LEVELS else "none") for m in MODULES}
    scope_in = raw.get("money_scope") or {}
    return {
        "modules": modules,
        "money_scope": {
            "categories": _normalize_list(scope_in.get("categories")),
            "accounts": _normalize_list(scope_in.get("accounts")),
        },
    }


class Access:
    """The resolved permissions of whoever is making the current request."""

    def __init__(self, email, role, permissions=None):
        self.email = email
        self.role = role  # owner | admin | member | service
        # Whose data requests read and write: your own. Scripts using the API key
        # work on the first owner's.
        self.data_owner = PRIMARY_OWNER if role == "service" else email
        perms = normalize_permissions(permissions if permissions is not None else FULL_EDIT_PERMISSIONS)
        self.modules = perms["modules"]
        self.categories = perms["money_scope"]["categories"]
        self.accounts = perms["money_scope"]["accounts"]
        if self.is_admin:
            self.modules = {m: "edit" for m in MODULES}
            self.categories = None
            self.accounts = None

    @property
    def is_owner(self):
        return self.role in ("owner", "service")

    @property
    def is_admin(self):
        return self.role in ("owner", "admin", "service")

    def level(self, module):
        return LEVELS.get(self.modules.get(module, "none"), 0)

    def can(self, module, level="view"):
        return self.level(module) >= LEVELS[level]

    # ---- money scope ----
    @property
    def money_restricted(self):
        return self.categories is not None or self.accounts is not None

    @property
    def balances_visible(self):
        # An account balance is the sum of every category, so showing it to a
        # category-restricted user would leak what they're not allowed to see.
        return self.can("money") and self.categories is None

    @property
    def full_money_edit(self):
        """Whole-ledger operations: Sheets sync, balance overrides, OCR balances."""
        return self.can("money", "edit") and not self.money_restricted

    def category_allowed(self, heading):
        return self.categories is None or heading in self.categories

    def account_allowed(self, account):
        return self.accounts is None or account in self.accounts

    def tx_allowed(self, heading, account):
        return self.category_allowed(heading) and self.account_allowed(account)

    def scope_transactions(self, query):
        if self.categories is not None:
            query = query.filter(Transaction.heading.in_(self.categories))
        if self.accounts is not None:
            query = query.filter(Transaction.account.in_(self.accounts))
        return query

    @classmethod
    def viewing(cls, viewer, owner, modules):
        """viewer looking at what owner shared with them: those modules, read-only."""
        shared = {m: "view" for m in (modules or []) if m in MODULES}
        access = cls(viewer, "member", {"modules": shared})
        access.data_owner = owner
        access.viewing_owner = owner
        return access

    viewing_owner = None

    def to_dict(self):
        return {
            "email": self.email,
            "role": self.role,
            "isOwner": self.is_owner,
            "isAdmin": self.is_admin,
            "viewing": self.viewing_owner,
            "modules": dict(self.modules),
            "money": {
                "categories": self.categories,
                "accounts": self.accounts,
                "restricted": self.money_restricted,
                "balancesVisible": self.balances_visible,
                "fullAccess": self.full_money_edit,
            },
        }


SERVICE_ACCESS = Access(None, "service")

# ---- schema bootstrap ----
# Adds the role/permissions columns on first use so a deploy never depends on
# a manual migration having been run first. Idempotent and cheap.
_schema_ready = False


def ensure_access_schema():
    global _schema_ready
    if _schema_ready:
        return
    try:
        db.session.execute(text("ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS role VARCHAR(20)"))
        db.session.execute(text("ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS permissions JSON"))
        db.session.execute(text("ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS updated_on TIMESTAMP"))
        db.session.commit()
        _schema_ready = True
    except Exception as e:
        db.session.rollback()
        print(f"⚠️ Could not ensure access-control columns: {e}")


# ---- per-worker cache ----
_cache = {}  # email -> (expires_at, Access | None)


def invalidate_access(email=None):
    if email is None:
        _cache.clear()
    else:
        _cache.pop(email.strip().lower(), None)


def _load_access(email):
    if email in OWNER_EMAILS:
        return Access(email, "owner")
    ensure_access_schema()
    row = AllowedEmail.query.filter(func.lower(AllowedEmail.email) == email).first()
    if row is not None:
        # Everyone works on their own data, with full use of it.
        return Access(email, row.role if row.role in ROLES else "member", FULL_EDIT_PERMISSIONS)
    if email in ALLOWED_EMAILS:
        # .env fallback list, managed outside the admin UI.
        return Access(email, "member", FULL_EDIT_PERMISSIONS)
    return None


def get_access(email):
    """Access for an email, or None if it is no longer allowed. Cached briefly."""
    email = (email or "").strip().lower()
    if not email:
        return None
    now = time.monotonic()
    hit = _cache.get(email)
    if hit and hit[0] > now:
        return hit[1]
    access = _load_access(email)
    _cache[email] = (now + CACHE_TTL, access)
    return access


def current_access():
    return getattr(g, "access", None)


# POSTs that only read: their filters are too big for a query string. Allowed
# while viewing someone's shared data, which otherwise takes no writes.
READ_ONLY_POSTS = frozenset({"/api/money/analyze", "/api/transactions/query"})


# ---- decorators ----
def _authenticate():
    """Resolve the caller into g.access. Returns an error response or None."""
    api_key = request.headers.get("X-API-KEY")
    if api_key and api_key == API_SECRET_KEY:
        g.access = SERVICE_ACCESS
        g.data_owner = SERVICE_ACCESS.data_owner
        return None

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        return jsonify({"success": False, "message": "Unauthorized"}), 401
    try:
        payload = jwt.decode(auth_header.split(" ")[1], JWT_SECRET, algorithms=["HS256"], leeway=60)
    except jwt.ExpiredSignatureError:
        return jsonify({"success": False, "message": "Token expired"}), 401
    except jwt.InvalidTokenError:
        return jsonify({"success": False, "message": "Invalid token"}), 401

    access = get_access(payload.get("email") or payload.get("sub"))
    if access is None:
        return jsonify({"success": False, "code": "ACCESS_REVOKED", "message": "Your access has been revoked"}), 401

    # X-View-As: someone else's data they've shared with this person, read-only.
    view_as = (request.headers.get("X-View-As") or "").strip().lower()
    if view_as and view_as != access.email:
        from models import Share
        share = db.session.get(Share, {"owner_email": view_as, "viewer_email": access.email})
        if share is None:
            return jsonify({"success": False, "code": "NOT_SHARED", "message": "That isn't shared with you"}), 403
        if request.method not in ("GET", "HEAD") and request.path not in READ_ONLY_POSTS:
            return _forbidden("This is shared with you to view only")
        access = Access.viewing(access.email, view_as, share.modules)

    g.access = access
    g.data_owner = access.data_owner
    return None


def _forbidden(message="You don't have permission to do that"):
    return jsonify({"success": False, "code": "FORBIDDEN", "message": message}), 403


def owner_only():
    """Google Sheets, Drive OCR and Kite are wired to the owner's own accounts.
    Returns a 403 response for anyone else, or None."""
    if not current_access().is_owner:
        return _forbidden("Only the app's owner can use this")
    return None


def require_owner(f):
    """Signed in as the owner (or the owner's scripts)."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if request.method == "OPTIONS":
            return "", 200
        err = _authenticate()
        if err:
            return err
        if not g.access.is_owner:
            return _forbidden("Only the app's owner can use this")
        return f(*args, **kwargs)
    return decorated_function


def require_api_key(f):
    """Any signed-in user whose email is still allowed."""
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if request.method == "OPTIONS":
            return "", 200
        err = _authenticate()
        if err:
            return err
        return f(*args, **kwargs)
    return decorated_function


def require_access(module, level=None):
    """Signed-in user with at least `level` on `module`.

    When level is omitted it follows the HTTP method: GET reads need "view",
    anything that writes needs "edit".
    """
    def wrapper(f):
        @wraps(f)
        def decorated_function(*args, **kwargs):
            if request.method == "OPTIONS":
                return "", 200
            err = _authenticate()
            if err:
                return err
            needed = level or ("view" if request.method in ("GET", "HEAD") else "edit")
            if not g.access.can(module, needed):
                return _forbidden(f"You need {needed} access to {module}")
            return f(*args, **kwargs)
        return decorated_function
    return wrapper


def require_admin(f):
    @wraps(f)
    def decorated_function(*args, **kwargs):
        if request.method == "OPTIONS":
            return "", 200
        err = _authenticate()
        if err:
            return err
        if not g.access.is_admin:
            return _forbidden("Admin access required")
        return f(*args, **kwargs)
    return decorated_function
