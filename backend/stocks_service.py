"""Stocks and ETFs added by hand: for anyone, Kite or not. Each is bought (and
sold) at the price paid, held at average cost, and valued every day at the
market's last price, the same prices Kite's Daily uses (kite_daily.stock_prices).

They live in their own tables (models.py: Stock, StockTrade, StockValue) and
join Kite's numbers in just two places, like funds held outside Kite: the day's
PortfolioSnapshot, and the holdings the Investments page reads. A stock Kite
already tracks can't be added again, so nothing counts twice.

A day's values are filed under the day their prices are from, as Kite's Daily
does: a weekend or a holiday brings the last trading day up to its close, so the
history has no flat copies of days nothing traded. A change made on such a day
(a buy on Sunday) is filed under that day: what's held changed then.

The search reads NSE's list of equities and ETFs (public CSVs, fetched once a day).
"""
import csv
import io
import threading
import time
from datetime import datetime, timedelta

import requests

import funds_service
import kite_daily
from extensions import db
from funds_service import IST, ist_today
from models import EquityHolding, PortfolioSnapshot, Stock, StockTrade, StockValue, UserSettings
from tenancy import data_owner

LISTS = (
    ("https://archives.nseindia.com/content/equities/EQUITY_L.csv", "SYMBOL", "NAME OF COMPANY", "ISIN NUMBER"),
    ("https://archives.nseindia.com/content/equities/eq_etfseclist.csv", "Symbol", "Underlying Asset", "ISINNumber"),
)
LIST_REFRESH_SECONDS = 24 * 3600
MAX_QUANTITY = 10_000_000
MAX_PRICE = 10_000_000


class StockError(Exception):
    """Something about a trade that can't be, with a message fit to show."""


class ListUnavailable(Exception):
    """NSE's list couldn't be reached."""


# ---- NSE's list ----

_lock = threading.Lock()
_list = {"at": 0.0, "rows": []}


def parse_list(text, symbol_col, name_col, isin_col):
    rows = []
    for row in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        row = {(k or "").strip(): (v or "").strip() for k, v in row.items()}
        symbol, name = row.get(symbol_col), row.get(name_col)
        if symbol and name:
            rows.append({"symbol": symbol.upper(), "name": name, "isin": row.get(isin_col) or None})
    return rows


def stock_list():
    """[{symbol, name, isin}] of every NSE equity and ETF, fetched at most once a day.
    A failed fetch keeps serving the last good copy."""
    now = time.time()
    with _lock:
        if _list["rows"] and now - _list["at"] < LIST_REFRESH_SECONDS:
            return _list["rows"]
    rows, seen = [], set()
    for url, *cols in LISTS:
        try:
            resp = requests.get(url, timeout=20, headers={"User-Agent": "Mozilla/5.0"})
            resp.raise_for_status()
        except requests.RequestException:
            continue
        for r in parse_list(resp.text, *cols):
            if r["symbol"] not in seen:
                seen.add(r["symbol"])
                rows.append(r)
    if not rows:
        if _list["rows"]:
            return _list["rows"]
        raise ListUnavailable("Couldn't reach NSE's list of stocks")
    with _lock:
        _list.update(at=now, rows=rows)
    return rows


def lookup(symbol):
    symbol = str(symbol or "").strip().upper()
    return next((r for r in stock_list() if r["symbol"] == symbol), None)


def search(query, limit=20):
    """Stocks whose symbol or name has every word typed: the exact symbol first,
    then symbols starting with it, then the rest by name."""
    words = [w for w in query.lower().split() if w]
    if not words:
        return []
    q = query.strip().upper()
    hits = [r for r in stock_list()
            if all(w in r["symbol"].lower() or w in r["name"].lower() for w in words)]
    hits.sort(key=lambda r: (r["symbol"] != q, not r["symbol"].startswith(q), r["name"].lower()))
    return hits[:limit]


# ---- holdings from trades ----

def replay(stock, trades):
    """Quantity and invested (average cost) from the trades, oldest first. A sale
    of more than was held then is an error."""
    quantity = invested = 0.0
    for t in sorted(trades, key=lambda t: (t.date, t.id)):
        if t.kind == "BUY":
            quantity += t.quantity
            invested += t.quantity * t.price
        else:
            if t.quantity > quantity + 1e-9:
                raise StockError(f"You held {quantity:g} {stock.symbol} on {t.date.strftime('%d %b %Y')}")
            invested -= invested / quantity * t.quantity if quantity else 0
            quantity -= t.quantity
            if quantity <= 1e-9:
                quantity, invested = 0.0, 0.0
    stock.quantity = round(quantity, 6)
    stock.invested = round(invested, 2)


def trade(stock, kind, quantity, price, day):
    if kind not in ("BUY", "SELL"):
        raise StockError("Buy or sell?")
    if not 0 < quantity <= MAX_QUANTITY:
        raise StockError("Enter how many")
    if not 0 < price <= MAX_PRICE:
        raise StockError("Enter the price")
    if day > ist_today():
        raise StockError("That date is in the future")
    db.session.add(StockTrade(id=_new_id(), stock_id=stock.id, date=day, kind=kind, quantity=quantity, price=price))
    db.session.flush()
    replay(stock, StockTrade.query.filter_by(stock_id=stock.id).all())


_last_id = 0


def _new_id():
    """Unique across everyone's rows (as the devices make them for the vault)."""
    global _last_id
    _last_id = max(_last_id + 1, int(time.time() * 1000) * 1000)
    return _last_id


def kite_symbols():
    """Symbols in the latest Kite sync, so a stock it tracks isn't added again."""
    owner = data_owner()
    day = (db.session.query(db.func.max(EquityHolding.date))
           .filter(EquityHolding.owner_email == owner).scalar())
    return {h.symbol.upper() for h in EquityHolding.query.filter_by(date=day).all()} if day else set()


# ---- valuing them ----

last_stock_day = funds_service.last_stock_day


def _settings(owner):
    row = db.session.get(UserSettings, owner)
    if row is None:
        row = UserSettings(email=owner)
        db.session.add(row)
    return row


def value_stocks(now=None, on=None):
    """Prices what's held and files it under the day the prices are from (or
    `on`, a day holdings changed), then that day's snapshot and any later ones
    standing on it. Nothing (or offline): what was filed stands."""
    owner = data_owner()
    now = (now or datetime.now(IST)).replace(tzinfo=None)
    today = now.date()
    held = Stock.query.filter(Stock.quantity > 0).all()
    prices, quoted = kite_daily.stock_prices(sorted({s.symbol for s in held})) if held else ({}, None)
    if held and not prices and on is None:
        return False
    last = last_stock_day(today)
    quote_day = min(quoted.date() if quoted else today, today)
    # A later day already filed holds what's held now: the prices bring it up to date.
    target = on or (max(quote_day, last) if last else quote_day)
    previous = {v.symbol: v for v in StockValue.query.filter_by(date=last).all()} if last else {}
    StockValue.query.filter(StockValue.owner_email == owner, StockValue.date == target).delete(synchronize_session=False)
    for s in held:
        before = previous.get(s.symbol)
        price = prices.get(s.symbol) or (before.price if before else None) or (float(s.invested) / s.quantity)
        db.session.add(StockValue(id=_new_id(), date=target, symbol=s.symbol, name=s.name, quantity=s.quantity,
                                  price=price, invested=float(s.invested), value=round(s.quantity * price, 2)))
    # Sold out since: a zero that day, so the day after doesn't carry it on.
    for symbol, before in previous.items():
        if before.quantity > 0 and symbol not in {s.symbol for s in held}:
            db.session.add(StockValue(id=_new_id(), date=target, symbol=symbol, name=before.name, quantity=0.0,
                                      price=before.price, invested=0.0, value=0.0))
    db.session.flush()
    funds_service.recompute_snapshot(target)
    for later in PortfolioSnapshot.query.filter(PortfolioSnapshot.date > target).all():
        if last_stock_day(later.date) == target:
            funds_service.recompute_snapshot(later.date)
    settings = _settings(owner)
    if prices:
        settings.stocks_priced_at = now
    if quoted:
        settings.stocks_quoted_at = quoted
    return True


def refresh_if_due(fresh=False, now=None):
    """The first look each day, and again every half hour while the market's open
    (sooner when asked by hand): today's prices for stocks added by hand. Never
    stops the page loading."""
    owner = data_owner()
    if not owner or not Stock.query.filter(Stock.quantity > 0).first():
        return
    now = (now or datetime.now(IST)).replace(tzinfo=None)
    row = db.session.get(UserSettings, owner)
    priced_at = row.stocks_priced_at if row else None
    asked = fresh and (priced_at is None or now - priced_at >= kite_daily.FRESH_AFTER)
    if not asked and not kite_daily._stale(priced_at, now):
        return
    try:
        value_stocks(now)
        db.session.commit()
    except Exception as e:   # a bad answer from Yahoo: next look tries again
        db.session.rollback()
        print(f"⚠️ Couldn't price stocks: {e!r}")


def changed():
    """After a buy, a sale or a removal: today's values with what's held now."""
    value_stocks(on=ist_today())


# ---- what the Stocks list shows ----

def overview():
    """Each stock (held first, by worth), its latest price, and its trades."""
    owner = data_owner()
    # Each one's latest price, even when its latest day was since deleted.
    values = {}
    for v in StockValue.query.filter(StockValue.date <= ist_today()).order_by(StockValue.date.asc()).all():
        values[v.symbol] = v
    trades = {}
    for t in StockTrade.query.order_by(StockTrade.date.desc(), StockTrade.id.desc()).all():
        trades.setdefault(t.stock_id, []).append({"id": t.id, "date": t.date.isoformat(), "kind": t.kind,
                                                  "quantity": t.quantity, "price": t.price})
    out = []
    for s in Stock.query.order_by(Stock.symbol).all():
        v = values.get(s.symbol)
        price = v.price if v else None
        out.append({
            "symbol": s.symbol, "name": s.name, "quantity": s.quantity, "invested": round(float(s.invested), 2),
            "avg_price": round(float(s.invested) / s.quantity, 2) if s.quantity else None,
            "price": price, "value": round(s.quantity * price, 2) if price is not None else None,
            "trades": trades.get(s.id, []),
        })
    out.sort(key=lambda r: (r["quantity"] <= 0, -(r["value"] or 0)))
    row = db.session.get(UserSettings, owner) if owner else None
    return out, (row.stocks_quoted_at.isoformat() if row and row.stocks_quoted_at else None)
