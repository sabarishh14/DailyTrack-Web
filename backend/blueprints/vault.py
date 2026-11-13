"""The private vault: investments locked with a key only their owner's devices
hold, so nobody running the server (its admin included) can read them.

How the keys fit (all of it happens on the devices; see the web's vault/crypto.js
and the phone's VaultCrypto.kt):

- A random data key encrypts every item (AES-256-GCM).
- The data key is stored twice, wrapped: once under a key derived from the
  owner's passphrase (PBKDF2-SHA256), once under their recovery key.
- Each person also has a key pair (ECDH P-256); its private half is wrapped
  under their data key. To let a friend Investments is shared with read the
  vault, the owner's device wraps the data key for the friend's public key: a
  grant. Unsharing Investments deletes the grant.

The server stores only those wrapped keys and ciphertext. It still does what
can't happen on a device, without keeping anything: reading a CAS statement,
asking Kite for holdings, and looking up prices (stock names and fund codes
only, never amounts).

Turning the vault on moves what's stored readable today into it: the device
reads it (GET /api/vault/plain), locks it away, reads the locked copy back and
checks it, and only then (POST /api/vault/finish, which checks again) are the
readable rows deleted. Turning it off moves everything back the same way.
"""
import hashlib
import io
import re
from datetime import date, datetime, timedelta

from flask import Blueprint, jsonify, request
from sqlalchemy.exc import IntegrityError

import funds_service
import kite_daily
from access import current_access, require_api_key
from extensions import db
from models import (EquityHolding, Fund, FundSip, FundTransaction, FundValue, ManualAsset, MutualFundHolding,
                    PortfolioSnapshot, RecurringTask, Share, Stock, StockTrade, StockValue, Transaction, UserSettings,
                    VaultGrant, VaultItem, VaultKey)
from tenancy import data_owner

vault_bp = Blueprint("vault", __name__)

# What moves into the vault, by the names the devices use for it.
TABLES = {
    "snapshots": PortfolioSnapshot,
    "equity": EquityHolding,
    "mf": MutualFundHolding,
    "assets": ManualAsset,
    "tasks": RecurringTask,
    "funds": Fund,
    "fund_tx": FundTransaction,
    "sips": FundSip,
    "fund_values": FundValue,
    "stocks": Stock,
    "stock_trades": StockTrade,
    "stock_values": StockValue,
}
STATE_FIELDS = {"priced_at": "kite_priced_at", "quoted_at": "kite_quoted_at", "quotes_seen_at": "kite_quotes_seen_at",
                "stocks_priced_at": "stocks_priced_at", "stocks_quoted_at": "stocks_quoted_at"}
ITEM_ID = re.compile(r"^[a-z_]{1,16}(:[0-9A-Za-z_-]{1,20})?$")
B64 = re.compile(r"^[A-Za-z0-9+/=_-]+$")
MAX_ITEM = 4 * 1024 * 1024
MOVING_FOR = timedelta(minutes=15)    # a move left half-way (a closed tab) stops blocking after this
MAX_STATEMENT_BYTES = 10 * 1024 * 1024


def _bad(message, status=400, **extra):
    return jsonify({"success": False, "message": message, **extra}), status


def vault_state(email):
    """'off', 'moving' or 'on' for whoever owns `email`'s data."""
    row = db.session.get(VaultKey, email) if email else None
    if row is None:
        return "off"
    if row.state == "moving" and row.state_at and datetime.utcnow() - row.state_at > MOVING_FOR:
        return "off"
    return row.state


def locked_response():
    """For the readable investments routes while the vault holds them: an app
    too old to open the vault says so, instead of showing an empty portfolio."""
    owner = data_owner()
    state = vault_state(owner)
    if state == "off":
        return None
    if state == "moving":
        return _bad("Your investments are moving into your private vault. Try again in a minute.", 409, code="VAULT_MOVING")
    return _bad("Your investments are in your private vault. Update the app to open them.", 409, code="VAULT_ON")


def _me():
    return current_access().email


def _viewing():
    access = current_access()
    return getattr(access, "viewing_owner", None) is not None


def _can_view_invest():
    return current_access().can("invest", "view")


def _owner_writing():
    """None when the caller may change their own vault, else an error response."""
    access = current_access()
    if not access.email:
        return _bad("The vault belongs to a signed-in person", 403)
    if _viewing():
        return _bad("This is shared with you to view only", 403)
    if not access.can("invest", "edit"):
        return _bad("You need edit access to Investments", 403)
    return None


def _keys_dict(row):
    if row is None:
        return None
    return {
        "salt": row.salt, "iterations": row.iterations, "wrapped_key": row.wrapped_key,
        "recovery_salt": row.recovery_salt, "recovery_wrapped_key": row.recovery_wrapped_key,
        "public_key": row.public_key, "wrapped_private_key": row.wrapped_private_key,
    }


def _blob(value, limit=4096):
    return isinstance(value, str) and 0 < len(value) <= limit and B64.match(value) is not None


# ---- status and keys ----

@vault_bp.route('/api/vault', methods=['GET'])
@require_api_key
def get_vault():
    """The data owner's vault state; the caller's own keys; and, while viewing a
    friend's, the grant that opens theirs."""
    me, owner = _me(), data_owner()
    mine = db.session.get(VaultKey, me) if me else None
    grant = None
    if owner and owner != me and _can_view_invest():
        row = db.session.get(VaultGrant, {"owner_email": owner, "viewer_email": me})
        if row is not None and mine is not None and row.viewer_key == mine.public_key:
            grant = {"ephemeral_key": row.ephemeral_key, "wrapped_key": row.wrapped_key}
    return jsonify({
        "success": True,
        "email": me,
        "owner": owner,
        "state": vault_state(owner),
        "me": _keys_dict(mine),
        "my_state": vault_state(me),
        "grant": grant,
    })


KEY_FIELDS = ("salt", "iterations", "wrapped_key", "recovery_salt", "recovery_wrapped_key",
              "public_key", "wrapped_private_key")


@vault_bp.route('/api/vault/keys', methods=['POST', 'PUT'])
@require_api_key
def save_keys():
    """POST: set up the caller's keys (once). PUT: a new passphrase, or a new
    recovery key: the data key itself never changes, so nothing is re-locked."""
    me = _me()
    if not me or _viewing():
        return _bad("Your vault is yours to set up", 403)
    body = request.json or {}
    row = db.session.get(VaultKey, me)
    if request.method == 'POST':
        if row is not None:
            return _bad("Your vault is already set up", 409)
        fields = KEY_FIELDS
    else:
        if row is None:
            return _bad("Set up your vault first", 404)
        fields = [f for f in ("salt", "iterations", "wrapped_key", "recovery_salt", "recovery_wrapped_key") if f in body]
        pairs = (("salt", "wrapped_key"), ("recovery_salt", "recovery_wrapped_key"))
        if not fields or any((a in fields) != (b in fields) for a, b in pairs):
            return _bad("Send a salt with its wrapped key")
    for f in fields:
        value = body.get(f)
        if f == "iterations":
            if not isinstance(value, int) or not 100_000 <= value <= 10_000_000:
                return _bad("Bad iterations")
        elif not _blob(value):
            return _bad(f"Bad {f}")
    if row is None:
        row = VaultKey(email=me, state="off")
        db.session.add(row)
    for f in fields:
        setattr(row, f, body[f])
    db.session.commit()
    return jsonify({"success": True, "me": _keys_dict(row)})


@vault_bp.route('/api/vault/keys', methods=['DELETE'])
@require_api_key
def delete_keys():
    """Forget the caller's keys: only while nothing of theirs is locked with
    them (?erase=1 also erases what is, for keys that are lost for good)."""
    me = _me()
    if not me or _viewing():
        return _bad("Your vault is yours to change", 403)
    row = db.session.get(VaultKey, me)
    if row is None:
        return jsonify({"success": True})
    if vault_state(me) != "off" and request.args.get("erase") != "1":
        return _bad("Your investments are locked with these keys", 409)
    VaultItem.query.filter(VaultItem.owner_email == me).delete(synchronize_session=False)
    VaultGrant.query.filter_by(owner_email=me).delete(synchronize_session=False)
    VaultGrant.query.filter_by(viewer_email=me).delete(synchronize_session=False)
    db.session.delete(row)
    db.session.commit()
    return jsonify({"success": True})


# ---- the locked items ----

@vault_bp.route('/api/vault/items', methods=['GET'])
@require_api_key
def get_items():
    if not _can_view_invest():
        return _bad("You need access to Investments", 403)
    rows = VaultItem.query.order_by(VaultItem.item_id).all()
    return jsonify({"success": True, "items": [{"id": r.item_id, "payload": r.payload, "rev": r.rev} for r in rows]})


@vault_bp.route('/api/vault/items', methods=['PUT'])
@require_api_key
def put_items():
    """{"put": [{id, payload, rev}], "delete": [{id, rev}]}, all or nothing.
    `rev` is the revision the device last read (0 for a new item): when another
    device has saved since, nothing is saved and the answer is 409, to read again."""
    denied = _owner_writing()
    if denied:
        return denied
    if db.session.get(VaultKey, data_owner()) is None:
        return _bad("Set up your vault first", 404)
    body = request.json or {}
    puts, deletes = body.get("put") or [], body.get("delete") or []
    if not isinstance(puts, list) or not isinstance(deletes, list) or len(puts) + len(deletes) > 2000:
        return _bad("Bad items")
    current = {r.item_id: r for r in VaultItem.query.with_for_update().all()}
    stale = []
    for change in puts + deletes:
        if not isinstance(change, dict) or not ITEM_ID.match(str(change.get("id", ""))):
            return _bad("Bad item id")
        expected = change.get("rev", 0)
        have = current.get(change["id"])
        if (have.rev if have else 0) != expected:
            stale.append(change["id"])
    if stale:
        db.session.rollback()
        return _bad("Changed on another device", 409, code="VAULT_STALE", stale=stale)
    revs = {}
    for change in puts:
        payload = change.get("payload")
        if not isinstance(payload, str) or not 0 < len(payload) <= MAX_ITEM or not B64.match(payload):
            db.session.rollback()
            return _bad("Bad item payload")
        row = current.get(change["id"])
        if row is None:
            row = VaultItem(item_id=change["id"], payload=payload, rev=1)
            db.session.add(row)
        else:
            row.payload, row.rev = payload, row.rev + 1
        revs[change["id"]] = row.rev
    for change in deletes:
        row = current.get(change["id"])
        if row is not None:
            db.session.delete(row)
        revs[change["id"]] = 0
    db.session.commit()
    return jsonify({"success": True, "revs": revs})


# ---- moving what's readable today into the vault, and back ----

def _value(value):
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return value


def _columns(model):
    return [c for c in model.__table__.columns if c.name != "owner_email"]


def _export_rows(model):
    cols = _columns(model)
    return [{c.name: _value(getattr(r, c.name)) for c in cols} for r in model.query.all()]


def fingerprint(rows):
    """{count, ids}: what a copy must match before the original goes. The ids,
    sorted as text, hashed: the devices work it out the same way."""
    ids = sorted(str(r["id"]) for r in rows)
    return {"count": len(ids), "ids": hashlib.sha256(",".join(ids).encode()).hexdigest()}


def _plain_tables():
    return {name: _export_rows(model) for name, model in TABLES.items()}


@vault_bp.route('/api/vault/plain', methods=['GET'])
@require_api_key
def get_plain():
    """Everything readable today, for the device to lock away (and a start: no
    one can change it meanwhile, so what's checked at the end is what was read)."""
    denied = _owner_writing()
    if denied:
        return denied
    me = _me()
    row = db.session.get(VaultKey, me)
    if row is None:
        return _bad("Set up your vault first", 404)
    if vault_state(me) == "on":
        return _bad("Your investments are already in your vault", 409)
    try:
        kite_daily._fold_weekends(funds_service.ist_today())   # an old repair, done before it's out of reach
    except Exception:
        db.session.rollback()
    tables = _plain_tables()
    # Kite funds from syncs before their ISIN was kept: found now, while the server
    # can still look, so the device can price them.
    found = {}
    for mf in sorted(tables["mf"], key=lambda m: m["date"], reverse=True):
        if not mf.get("isin"):
            if mf["symbol"] not in found:
                holding = MutualFundHolding.query.filter_by(id=mf["id"]).first()
                try:
                    found[mf["symbol"]] = kite_daily._fund_isin(holding) if holding is not None else None
                except Exception:
                    found[mf["symbol"]] = None
            mf["isin"] = found[mf["symbol"]]
    settings = db.session.get(UserSettings, me)
    state = {k: _value(getattr(settings, col)) if settings else None for k, col in STATE_FIELDS.items()}
    row.state, row.state_at = "moving", datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True, "tables": tables, "state": state,
                    "fingerprints": {name: fingerprint(rows) for name, rows in tables.items()}})


@vault_bp.route('/api/vault/finish', methods=['POST'])
@require_api_key
def finish_move():
    """{"fingerprints": {table: {count, ids}}} of the locked copy, read back and
    opened on the device. When every one matches what's readable here, the
    readable rows go and the vault is on; otherwise nothing changes."""
    denied = _owner_writing()
    if denied:
        return denied
    me = _me()
    row = db.session.get(VaultKey, me)
    if row is None or vault_state(me) != "moving":
        return _bad("Start again: the move wasn't under way", 409)
    if VaultItem.query.first() is None:
        return _bad("Nothing was locked away yet", 409)
    theirs = (request.json or {}).get("fingerprints") or {}
    mismatched = [name for name, model in TABLES.items() if theirs.get(name) != fingerprint(_export_rows(model))]
    if mismatched:
        return _bad("The locked copy didn't match, so nothing was removed. Try again.", 409,
                    code="VAULT_MISMATCH", tables=mismatched)
    # Children before parents (fund transactions and SIPs belong to funds).
    for name in ("fund_tx", "sips", "fund_values", "funds", "stock_trades", "stock_values", "stocks",
                 "equity", "mf", "snapshots", "tasks", "assets"):
        TABLES[name].query.delete(synchronize_session=False)
    settings = db.session.get(UserSettings, me)
    if settings is not None:
        for col in STATE_FIELDS.values():
            setattr(settings, col, None)
    row.state, row.state_at = "on", datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True, "state": "on"})


@vault_bp.route('/api/vault/cancel', methods=['POST'])
@require_api_key
def cancel_move():
    """A move that stopped half-way: what's readable stays, the half-locked copy goes."""
    denied = _owner_writing()
    if denied:
        return denied
    me = _me()
    row = db.session.get(VaultKey, me)
    if row is None or row.state != "moving":
        return jsonify({"success": True, "state": vault_state(me)})
    VaultItem.query.delete(synchronize_session=False)
    row.state, row.state_at = "off", datetime.utcnow()
    db.session.commit()
    return jsonify({"success": True, "state": "off"})


def _parse_value(column, value):
    if value is None:
        return None
    try:
        kind = column.type.python_type
    except NotImplementedError:
        kind = None
    if kind is datetime:
        return datetime.fromisoformat(str(value))
    if kind is date:
        return date.fromisoformat(str(value)[:10])
    return value


@vault_bp.route('/api/vault/restore', methods=['POST'])
@require_api_key
def restore():
    """Turning the vault off: {"tables": ..., "state": ...} as the device opened
    them. They're stored readable again, checked against their fingerprints,
    and only then are the locked items (and friends' grants) deleted."""
    denied = _owner_writing()
    if denied:
        return denied
    me = _me()
    row = db.session.get(VaultKey, me)
    if row is None or vault_state(me) != "on":
        return _bad("Your vault isn't on", 409)
    body = request.json or {}
    tables, theirs = body.get("tables") or {}, body.get("fingerprints") or {}
    if any(model.query.first() is not None for model in TABLES.values()):
        return _bad("There are readable investments already; nothing was changed", 409)
    try:
        for name in ("assets", "tasks", "snapshots", "equity", "mf", "funds", "fund_tx", "sips", "fund_values",
                     "stocks", "stock_trades", "stock_values"):
            model, cols = TABLES[name], _columns(TABLES[name])
            names = {c.name: c for c in cols}
            for rec in tables.get(name) or []:
                db.session.add(model(**{k: _parse_value(names[k], v) for k, v in rec.items() if k in names}))
            db.session.flush()
        mismatched = [name for name, model in TABLES.items() if theirs.get(name) != fingerprint(_export_rows(model))]
        if mismatched:
            db.session.rollback()
            return _bad("What arrived didn't match, so nothing was changed. Try again.", 409,
                        code="VAULT_MISMATCH", tables=mismatched)
        state = body.get("state") or {}
        settings = db.session.get(UserSettings, me)
        if settings is None:
            settings = UserSettings(email=me)
            db.session.add(settings)
        for key, col in STATE_FIELDS.items():
            setattr(settings, col, datetime.fromisoformat(state[key]) if state.get(key) else None)
        VaultItem.query.delete(synchronize_session=False)
        VaultGrant.query.filter_by(owner_email=me).delete(synchronize_session=False)
        row.state, row.state_at = "off", datetime.utcnow()
        db.session.commit()
    except (TypeError, ValueError, KeyError, IntegrityError) as e:
        db.session.rollback()
        return _bad(f"Couldn't put that back, so nothing was changed: {e.__class__.__name__}", 409)
    return jsonify({"success": True, "state": "off"})


# ---- friends Investments is shared with ----

def _invest_viewers(owner):
    return [s.viewer_email for s in Share.query.filter_by(owner_email=owner).all() if "invest" in (s.modules or [])]


@vault_bp.route('/api/vault/grants', methods=['GET'])
@require_api_key
def list_grants():
    """Friends Investments is shared with: their public key (once they've set up
    a vault of their own) and whether they've been given the data key for it."""
    denied = _owner_writing()
    if denied:
        return denied
    me = _me()
    out = []
    for viewer in _invest_viewers(me):
        keys = db.session.get(VaultKey, viewer)
        grant = db.session.get(VaultGrant, {"owner_email": me, "viewer_email": viewer})
        out.append({"viewer": viewer, "public_key": keys.public_key if keys else None,
                    "granted": bool(grant and keys and grant.viewer_key == keys.public_key)})
    return jsonify({"success": True, "grants": out})


@vault_bp.route('/api/vault/grants/<path:viewer>', methods=['PUT'])
@require_api_key
def put_grant(viewer):
    denied = _owner_writing()
    if denied:
        return denied
    me, viewer = _me(), (viewer or "").strip().lower()
    if viewer not in _invest_viewers(me):
        return _bad("Investments isn't shared with them", 403)
    keys = db.session.get(VaultKey, viewer)
    body = request.json or {}
    if keys is None or body.get("viewer_key") != keys.public_key:
        return _bad("Their vault keys have changed", 409)
    if not (_blob(body.get("ephemeral_key")) and _blob(body.get("wrapped_key"))):
        return _bad("Bad grant")
    grant = db.session.get(VaultGrant, {"owner_email": me, "viewer_email": viewer})
    if grant is None:
        grant = VaultGrant(owner_email=me, viewer_email=viewer)
        db.session.add(grant)
    grant.viewer_key, grant.ephemeral_key, grant.wrapped_key = keys.public_key, body["ephemeral_key"], body["wrapped_key"]
    db.session.commit()
    return jsonify({"success": True})


def drop_grant(owner, viewer):
    """Investments no longer shared: the friend's copy of the data key goes."""
    VaultGrant.query.filter_by(owner_email=owner, viewer_email=viewer).delete(synchronize_session=False)


# ---- what only the server can do, keeping nothing ----

@vault_bp.route('/api/vault/navs', methods=['GET'])
@require_api_key
def navs():
    """Every fund's latest NAV (all of them: asking for some would say which
    are held). [code, name, full name, fund house, ISINs, NAV, its day]."""
    if not _can_view_invest():
        return _bad("You need access to Investments", 403)
    fresh = request.args.get("refresh") == "1"
    try:
        by_code = funds_service.latest_navs(funds_service.FRESH_NAV_SECONDS if fresh else funds_service.NAV_REFRESH_SECONDS)
    except funds_service.NavUnavailable as e:
        return _bad(str(e), 503)
    newest = max((s["date"] for s in by_code.values()), default=funds_service.ist_today())
    since = newest - timedelta(days=400)
    rows = [[s["code"], s["name"], s["full_name"], s["amc"], s["isins"], s["nav"], s["date"].isoformat()]
            for s in by_code.values() if s["date"] >= since]
    resp = jsonify({"success": True, "navs": rows})
    resp.headers["Cache-Control"] = "private, max-age=600"
    return resp


@vault_bp.route('/api/vault/stock-list', methods=['GET'])
@require_api_key
def stock_list():
    """Every NSE stock and ETF, [symbol, name, ISIN]: searched on the device, so
    the server never learns which one was looked for."""
    if not _can_view_invest():
        return _bad("You need access to Investments", 403)
    import stocks_service
    try:
        rows = stocks_service.stock_list()
    except stocks_service.ListUnavailable as e:
        return _bad(str(e), 503)
    resp = jsonify({"success": True, "stocks": [[r["symbol"], r["name"], r["isin"]] for r in rows]})
    resp.headers["Cache-Control"] = "private, max-age=3600"
    return resp


@vault_bp.route('/api/vault/nav-history/<code>', methods=['GET'])
@require_api_key
def nav_history(code):
    """One fund's past NAVs, to price a purchase or a SIP instalment on its day."""
    if not _can_view_invest() or not str(code).isdigit():
        return _bad("No such fund", 404)
    try:
        navs, days = funds_service.nav_history(str(code))
    except funds_service.NavUnavailable as e:
        return _bad(str(e), 503)
    return jsonify({"success": True, "navs": [[d.isoformat(), navs[d]] for d in days]})


@vault_bp.route('/api/vault/quotes', methods=['GET'])
@require_api_key
def quotes():
    """Stock prices by name (?symbols=INFY,TCS): no quantities, no amounts."""
    denied = _owner_writing()
    if denied:
        return denied
    symbols = sorted({s.strip() for s in (request.args.get("symbols") or "").split(",") if s.strip()})[:200]
    if not symbols:
        return jsonify({"success": True, "prices": {}, "at": None})
    prices, at = kite_daily.stock_prices(symbols)
    return jsonify({"success": True, "prices": prices, "at": at.isoformat() if at else None})


@vault_bp.route('/api/vault/kite', methods=['POST'])
@require_api_key
def kite_sync():
    """Kite's holdings now, handed straight back to be locked away: Kite only
    talks to the server, and the server keeps none of it."""
    denied = _owner_writing()
    if denied:
        return denied
    if not current_access().is_owner:
        return _bad("Only the app's owner can use this", 403)
    from blueprints.invest import KiteError, kite_holdings
    try:
        funds, stocks = kite_holdings((request.json or {}).get("request_token"))
    except KiteError as e:
        return _bad(str(e))
    except Exception as e:  # Kite or AMFI answered oddly
        return _bad(f"Kite sync failed: {e}")
    return jsonify({"success": True, "funds": funds, "stocks": stocks})


@vault_bp.route('/api/vault/cas', methods=['POST'])
@require_api_key
def read_cas():
    """A CAS PDF ("file") and its password ("password"), read in memory and
    handed back plain: neither is kept or logged, and each folio number leaves
    only as a hash to match re-imports and its last 4 digits."""
    denied = _owner_writing()
    if denied:
        return denied
    upload = request.files.get("file")
    if upload is None:
        return _bad("Choose your CAS PDF")
    data = upload.read(MAX_STATEMENT_BYTES + 1)
    if len(data) > MAX_STATEMENT_BYTES:
        return _bad("That PDF is too large")
    if not data.startswith(b"%PDF"):
        return _bad("That isn't a PDF")
    try:
        cas = funds_service.parse_cas(io.BytesIO(data), request.form.get("password") or "")
    except funds_service.StatementError as e:
        return _bad(str(e))
    finally:
        del data
    try:
        out = {"period": {"from": funds_service._as_date(cas["statement_period"]["from"]).isoformat(),
                          "to": funds_service._as_date(cas["statement_period"]["to"]).isoformat()},
               "folios": []}
        for folio in cas.get("folios") or []:
            schemes = []
            for s in folio.get("schemes") or []:
                schemes.append({
                    "scheme": s.get("scheme"), "amfi": s.get("amfi"), "isin": s.get("isin"),
                    "close": float(s["close"]),
                    "cost": funds_service._number((s.get("valuation") or {}).get("cost")),
                    "transactions": [{
                        "date": funds_service._as_date(t["date"]).isoformat(),
                        "kind": str(getattr(t["type"], "name", t["type"])),
                        "amount": funds_service._number(t.get("amount")),
                        "units": funds_service._number(t.get("units")),
                        "nav": funds_service._number(t.get("nav")),
                    } for t in s.get("transactions") or []],
                })
            out["folios"].append({"ref": funds_service.folio_ref(folio["folio"]),
                                  "tail": funds_service.folio_tail(folio["folio"]),
                                  "amc": folio.get("amc"), "schemes": schemes})
    except funds_service.StatementError as e:
        return _bad(str(e))
    return jsonify({"success": True, "cas": out})


@vault_bp.route('/api/vault/xirr-flows', methods=['GET'])
@require_api_key
def xirr_flows():
    """Money's Investment transactions (they aren't in the vault): with the
    vault's latest worth, the device works out the XIRR."""
    if not _can_view_invest():
        return _bad("You need access to Investments", 403)
    rows = Transaction.query.filter_by(type='Investment').order_by(Transaction.date.asc()).all()
    return jsonify({"success": True, "flows": [[r.date.isoformat(), -abs(float(r.amount))] for r in rows]})
