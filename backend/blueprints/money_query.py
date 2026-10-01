"""Server-side money aggregation.

The web app used to download every transaction and total them in the browser.
These endpoints do the filtering, grouping and paging in SQL instead, so the
payload stays small no matter how long the history gets. Every query goes
through current_access().scope_transactions(), so a scoped user's totals only
count what they can see (ACCESS_CONTROL.md).

Filter payload shared by /analyze and /query. Each list filter is tri-state
like the UI chips: excluded values always lose; if anything is included, the
row must be included.

    {"accounts":  {"include": [...], "exclude": [...]},
     "types":     {...},   # "Debit", "Credit", ... (case-insensitive)
     "months":    {...},   # "January" ... "December"
     "years":     {...},   # "2025"
     "headings":  {...},
     "visibility":{...},   # "Active" / "Excluded"
     "date_from": "YYYY-MM-DD", "date_to": "YYYY-MM-DD",
     "description": "substring", "search": "free text"}
"""
from datetime import datetime, date

import requests
from flask import Blueprint, request, jsonify
from sqlalchemy import func, extract, or_, case, literal, String, cast, text as sql_text

from extensions import db, SHEETS_URL
from models import Transaction, Split, Account, BalanceAdjustment
from access import require_access, current_access, owner_only
from blueprints.money import set_balance
from tenancy import data_owner

money_query_bp = Blueprint("money_query", __name__)

MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
               "August", "September", "October", "November", "December"]
MAX_PAGE = 500


# ---- filtering ----
def _month_num(value):
    try:
        return MONTH_NAMES.index(str(value)) + 1
    except ValueError:
        return None


def _int_or_none(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _tri(query, expr, spec, conv=lambda v: v):
    spec = spec or {}
    include = [c for c in (conv(v) for v in spec.get("include") or []) if c is not None]
    exclude = [c for c in (conv(v) for v in spec.get("exclude") or []) if c is not None]
    if exclude:
        query = query.filter(or_(expr.is_(None), ~expr.in_(exclude)))
    if include:
        query = query.filter(expr.in_(include))
    return query


def _parse_date(value):
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


def apply_filters(query, f):
    f = f or {}
    excluded = func.coalesce(Transaction.exclude_analytics, False)
    query = _tri(query, Transaction.account, f.get("accounts"))
    query = _tri(query, func.lower(Transaction.type), f.get("types"), lambda v: str(v).lower())
    query = _tri(query, extract("month", Transaction.date), f.get("months"), _month_num)
    query = _tri(query, extract("year", Transaction.date), f.get("years"), _int_or_none)
    query = _tri(query, Transaction.heading, f.get("headings"))
    query = _tri(query, excluded, f.get("visibility"),
                 lambda v: {"Excluded": True, "Active": False}.get(v))

    date_from = _parse_date(f.get("date_from"))
    if date_from:
        date_to = _parse_date(f.get("date_to")) or date_from
        query = query.filter(Transaction.date >= date_from, Transaction.date <= date_to)

    if f.get("description"):
        query = query.filter(Transaction.description.ilike(f"%{f['description']}%"))
    if f.get("search"):
        term = f"%{f['search']}%"
        query = query.filter(or_(
            Transaction.description.ilike(term),
            Transaction.heading.ilike(term),
            cast(Transaction.amount, String).ilike(term),
        ))
    return query


def _scoped(*columns):
    return current_access().scope_transactions(db.session.query(*columns))


def serialize_transactions(transactions):
    ids = [t.id for t in transactions]
    splits = Split.query.filter(Split.transaction_id.in_(ids)).all() if ids else []
    split_map = {s.transaction_id: {"id": s.id, "total_amount": s.total_amount, "members": s.members} for s in splits}
    return [{
        "id": t.id,
        "account": t.account,
        "date": t.date.strftime("%Y-%m-%d"),
        "month": t.month.strftime("%Y-%m-%d"),
        "type": t.type,
        "heading": t.heading,
        "description": t.description,
        "amount": t.amount,
        "exclude_analytics": bool(t.exclude_analytics),
        "split": split_map.get(t.id),
    } for t in transactions]


def balances_after(rows):
    """Balance each row's account held right after it, keyed by transaction id.

    Worked backwards from today's balance: minus everything that happened on the
    account after the row (ledger order: date, then id, i.e. entry order within
    a day). Summed over the account's whole history, so filters and sorting on
    the table don't change the numbers. Credit cards and untracked accounts get
    none. Balances set by hand count too (see BalanceAdjustment), from when
    they were recorded; ones made before that was kept aren't known."""
    names = {t.account for t in rows if t.account and not t.account.strip().upper().startswith("CC")}
    current = {a.account: float(a.balance or 0)
               for a in Account.query.filter(Account.account.in_(names)).all() if a.balance_tracked} if names else {}
    if not current:
        return {}
    accounts = list(current)
    signed = case((func.lower(Transaction.type) == "credit", Transaction.amount), else_=-Transaction.amount)
    # One ledger of transactions and hand-set jumps, in the order they happened.
    moves = db.session.query(
        Transaction.id.label("id"), Transaction.account.label("account"), Transaction.date.label("date"),
        signed.label("amount"), literal(0).label("is_adjustment"),
    ).filter(Transaction.account.in_(accounts)).union_all(db.session.query(
        BalanceAdjustment.id, BalanceAdjustment.account, BalanceAdjustment.date,
        BalanceAdjustment.delta, literal(1),
    ).filter(BalanceAdjustment.account.in_(accounts))).subquery()
    later = func.sum(moves.c.amount).over(
        partition_by=moves.c.account,
        order_by=(moves.c.date.desc(), moves.c.id.desc()),
        rows=(None, -1),
    )
    ledger = db.session.query(moves.c.id, moves.c.account, moves.c.is_adjustment, later.label("later")).subquery()
    ids = [t.id for t in rows if t.account in current]
    return {tx_id: round(current[account] - float(later or 0), 2)
            for tx_id, account, later in db.session.query(ledger.c.id, ledger.c.account, ledger.c.later)
                                                   .filter(ledger.c.is_adjustment == 0, ledger.c.id.in_(ids)).all()}


# /money/meta scans the whole ledger seven ways and runs on every Money load and
# after every write. Cache it per person and access scope, alongside a
# fingerprint of the columns it reads: one cheap aggregate per request instead of
# seven scans, and correct on every gunicorn worker (and for writes made outside
# the API).
_meta_cache = {}
_META_FINGERPRINT_SQL = sql_text("""
SELECT md5(coalesce(string_agg(
  concat_ws('|', id, account, type, heading, md5(coalesce(description, '')), round(amount), month, date, exclude_analytics),
  ',' ORDER BY id), '')) FROM transactions WHERE owner_email = :owner
""")


def _meta_fingerprint():
    try:
        return db.session.execute(_META_FINGERPRINT_SQL, {"owner": data_owner()}).scalar()
    except Exception as e:
        db.session.rollback()
        print(f"Money meta fingerprint unavailable, serving uncached: {e}")
        return None


def _with_every_account(tx_accounts):
    """The accounts transactions use, plus every account that's been set up (and
    may be seen), so one added a moment ago, with nothing on it yet, can be picked
    straight away. Read fresh each time: the cache follows transactions only."""
    access = current_access()
    names = set(tx_accounts) | {a for (a,) in db.session.query(Account.account).all() if a}
    return sorted(n for n in names if access.account_allowed(n))


# ---- endpoints ----
@money_query_bp.route('/api/money/meta', methods=['GET'])
@require_access("money")
def money_meta():
    """Filter options, auto-excluded categories and description suggestions."""
    access = current_access()
    scope = (data_owner(),
             tuple(sorted(access.categories)) if access.categories is not None else None,
             tuple(sorted(access.accounts)) if access.accounts is not None else None)
    fingerprint = _meta_fingerprint()
    cached = _meta_cache.get(scope)
    if fingerprint and cached and cached[0] == fingerprint:
        return jsonify({**cached[1], "accounts": _with_every_account(cached[1]["accounts"])})

    months = [m for (m,) in _scoped(Transaction.month).distinct().all() if m]
    years = sorted({str(m.year) for m in months}, reverse=True)
    # Financial year runs April → March.
    fys = sorted({f"FY {m.year if m.month >= 4 else m.year - 1}-{(m.year if m.month >= 4 else m.year - 1) + 1}" for m in months}, reverse=True)

    headings = sorted(h for (h,) in _scoped(Transaction.heading).distinct().all() if h)
    accounts = sorted(a for (a,) in _scoped(Transaction.account).distinct().all() if a)
    types = sorted({t.capitalize() for (t,) in _scoped(Transaction.type).distinct().all() if t})

    excluded = func.coalesce(Transaction.exclude_analytics, False)
    excluded_headings = [h for (h,) in _scoped(Transaction.heading)
                         .group_by(Transaction.heading)
                         .having(func.count() == func.sum(case((excluded, 1), else_=0)))
                         .all() if h]

    # Categories each type has actually been used with, most used first.
    categories_by_type = {}
    for t, h, _ in (_scoped(Transaction.type, Transaction.heading, func.count())
                    .filter(Transaction.heading.isnot(None))
                    .group_by(Transaction.type, Transaction.heading)
                    .order_by(func.count().desc(), Transaction.heading).all()):
        categories_by_type.setdefault(t.capitalize(), []).append(h)

    desc = func.trim(Transaction.description)
    rows = (_scoped(Transaction.type, Transaction.heading, desc, func.round(Transaction.amount), func.count(), func.max(Transaction.date))
            .filter(Transaction.description.isnot(None), desc != "")
            .group_by(Transaction.type, Transaction.heading, desc, func.round(Transaction.amount))
            .order_by(func.max(Transaction.date).desc())
            .limit(5000).all())
    descriptions = [{"type": t.capitalize(), "heading": h, "description": d, "amount": float(a or 0), "count": int(c)}
                    for t, h, d, a, c, _ in rows]
    recent = list(dict.fromkeys(d for _, _, d, _, _, _ in rows))  # newest first, de-duplicated

    result = {
        "success": True,
        "years": years,
        "fys": fys,
        "headings": headings,
        "accounts": accounts,
        "types": types,
        "excluded_headings": excluded_headings,
        "categories_by_type": categories_by_type,
        "descriptions": descriptions,
        "recent_descriptions": recent,
    }
    if fingerprint:
        _meta_cache[scope] = (fingerprint, result)
    return jsonify({**result, "accounts": _with_every_account(accounts)})


@money_query_bp.route('/api/money/summary', methods=['GET'])
@require_access("money")
def money_summary():
    """Income/expense by account for ?month=YYYY-MM, and category spend for ?spend_month=YYYY-MM."""
    result = {"success": True, "income": {}, "expense": {}, "spending": {}}

    month = request.args.get('month')
    if month:
        try:
            month_start = datetime.strptime(month, '%Y-%m').date().replace(day=1)
            rows = (_scoped(Transaction.account, Transaction.type, func.sum(Transaction.amount))
                    .filter(Transaction.month == month_start, Transaction.type.in_(["Credit", "Debit"]))
                    .group_by(Transaction.account, Transaction.type).all())
            for account, tx_type, total in rows:
                bucket = result["income"] if tx_type == "Credit" else result["expense"]
                bucket[account] = float(total or 0)
        except ValueError:
            pass

    spend_month = request.args.get('spend_month')
    if spend_month:
        try:
            start = datetime.strptime(spend_month, '%Y-%m').date().replace(day=1)
            rows = (_scoped(Transaction.heading, func.sum(Transaction.amount))
                    .filter(Transaction.month == start, Transaction.type == "Debit",
                            func.coalesce(Transaction.exclude_analytics, False) == False)  # noqa: E712
                    .group_by(Transaction.heading).all())
            result["spending"] = {h: float(t or 0) for h, t in rows}
        except ValueError:
            pass

    return jsonify(result)


@money_query_bp.route('/api/money/analyze', methods=['POST'])
@require_access("money", level="view")
def money_analyze():
    """Spending analyser: pie groups plus income/expense counts for the filters."""
    f = (request.json or {}).get("filters") or {}
    not_excluded = func.coalesce(Transaction.exclude_analytics, False) == False  # noqa: E712

    # Exactly one included category → drill down into its descriptions.
    by_description = len((f.get("headings") or {}).get("include") or []) == 1
    desc = func.trim(Transaction.description)
    key = case((or_(Transaction.description.is_(None), desc == ""), "No Description"), else_=desc) if by_description else Transaction.heading

    groups = (apply_filters(_scoped(key, func.sum(func.abs(Transaction.amount))), f)
              .filter(not_excluded).group_by(key).all())
    pie = sorted(({"name": n, "value": float(v or 0)} for n, v in groups if n is not None), key=lambda g: -g["value"])

    stats_rows = (apply_filters(_scoped(func.lower(Transaction.type), func.count(), func.sum(Transaction.amount)), f)
                  .filter(not_excluded).group_by(func.lower(Transaction.type)).all())
    stats = {t: {"count": int(c), "sum": float(s or 0)} for t, c, s in stats_rows}

    return jsonify({
        "success": True,
        "groups": pie,
        "by_description": by_description,
        "count": sum(s["count"] for s in stats.values()),
        "credit": stats.get("credit", {"count": 0, "sum": 0.0}),
        "debit": stats.get("debit", {"count": 0, "sum": 0.0}),
    })


SORTS = {
    "date": Transaction.date,
    "month": Transaction.date,
    "amount": Transaction.amount,
    "account": func.lower(Transaction.account),
    "type": func.lower(Transaction.type),
    "heading": func.lower(Transaction.heading),
    "desc": func.lower(func.coalesce(Transaction.description, "")),
}


@money_query_bp.route('/api/transactions/query', methods=['POST'])
@require_access("money", level="view")
def query_transactions():
    """Filtered, sorted, paginated transactions for the table and search."""
    data = request.json or {}
    limit = max(1, min(int(data.get("limit") or 25), MAX_PAGE))
    offset = max(0, int(data.get("offset") or 0))
    sort_col = SORTS.get(data.get("sort_by"), Transaction.date)
    sort_expr = sort_col.asc() if data.get("sort_dir") == "asc" else sort_col.desc()

    filters = data.get("filters")
    query = apply_filters(current_access().scope_transactions(Transaction.query), filters)
    rows = query.order_by(sort_expr, Transaction.id.desc()).offset(offset).limit(limit).all()

    # Totals across every matching row (not just this page) for the stats bar.
    total, credit, debit = apply_filters(_scoped(
        func.count(Transaction.id),
        func.sum(case((Transaction.type == "Credit", Transaction.amount), else_=0)),
        func.sum(case((Transaction.type == "Debit", Transaction.amount), else_=0)),
    ), filters).one()
    transactions = serialize_transactions(rows)
    if data.get("with_balances") and current_access().balances_visible:
        after = balances_after(rows)
        for t in transactions:
            t["balance_after"] = after.get(t["id"])
    return jsonify({
        "success": True,
        "transactions": transactions,
        "total": int(total or 0),
        "credit_total": float(credit or 0),
        "debit_total": float(debit or 0),
    })


@money_query_bp.route('/api/splits/list', methods=['GET'])
@require_access("money")
def list_splits():
    """Every transaction that has a split, newest first."""
    rows = (current_access().scope_transactions(Transaction.query)
            .join(Split, Split.transaction_id == Transaction.id)
            .order_by(Transaction.date.desc(), Transaction.id.desc()).all())
    return jsonify({"success": True, "transactions": serialize_transactions(rows)})


@money_query_bp.route('/api/sync/sheet-balances', methods=['POST'])
@require_access("money", level="edit")
def sync_sheet_balances():
    """Pull account balances from the Sheet. Replaces the browser calling the
    Apps Script URL directly, which exposed it in the frontend bundle."""
    denied = owner_only()
    if denied:
        return denied
    try:
        data = requests.get(SHEETS_URL, timeout=30).json()
        if not isinstance(data, dict) or "error" in data:
            return jsonify({"success": False, "message": str(data.get("error") if isinstance(data, dict) else "Unexpected Sheet response")}), 502
        updated = 0
        for name, balance in data.items():
            account = Account.query.filter_by(account=name).first()
            if account is None or balance in ("", None):
                continue
            set_balance(account, balance, 'sheet sync')
            updated += 1
        db.session.commit()
        return jsonify({"success": True, "updated": updated})
    except Exception as e:
        db.session.rollback()
        return jsonify({"success": False, "message": str(e)}), 500
