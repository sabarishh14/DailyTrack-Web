"""Kite's holdings priced every day: Settings > Investments > Daily, for whoever
would rather not sync Kite each day to see the day's worth.

The app can't fetch holdings from Kite by itself (its access token needs a login
every morning), so what the last sync held stands until the next one, and each
day it's repriced: stocks at the market's price (Yahoo Finance's, unofficial and
free), funds at AMFI's NAV (funds_service). Those days' rows are marked
`repriced`, and a real sync that day replaces them. On Manual (the default) a
day's worth changes only with a sync, as it always has.
"""
import bisect
import re
import time
from datetime import datetime, time as clock, timedelta

import requests

import funds_service
from extensions import db
from funds_service import IST, NavUnavailable
from models import EquityHolding, MutualFundHolding, UserSettings
from tenancy import data_owner

MODES = ("manual", "daily")
PRICES_URL = "https://query1.finance.yahoo.com/v7/finance/spark"
BATCH = 20                        # symbols Yahoo prices in one request
MARKET_CLOSE = clock(15, 45)      # NSE closes at 15:30; its closing prices settle soon after
REFRESH = timedelta(minutes=30)   # how old a day's prices may get while the market's open
STALE_AFTER = timedelta(minutes=45)   # quotes older than this while it's open: Yahoo isn't answering


def kite_mode(email=None):
    """'daily' or 'manual' (the default), for `email` or the data owner."""
    email = email or data_owner()
    row = db.session.get(UserSettings, email) if email else None
    return row.kite_valuation if row and row.kite_valuation in MODES else "manual"


# ---- prices ----

def _tickers(symbol):
    """Yahoo's names for a Kite symbol, likeliest first: on NSE, on BSE, then
    both again without a series suffix (IDEA-BE trades as IDEA)."""
    names = [symbol]
    base = re.sub(r"-[A-Z0-9]{1,2}$", "", symbol)
    if base != symbol:
        names.append(base)
    return [name + exchange for name in names for exchange in (".NS", ".BO")]


def _spark(tickers):
    """{ticker: (last price, when it traded, IST)} for those Yahoo knows; None
    when it can't be reached (it turns some servers away)."""
    try:
        resp = requests.get(PRICES_URL, params={"symbols": ",".join(tickers), "range": "1d", "interval": "1d"},
                            timeout=15, headers={"User-Agent": "Mozilla/5.0"})
        resp.raise_for_status()
        results = resp.json()["spark"]["result"] or []
    except (requests.RequestException, ValueError, KeyError, TypeError) as e:
        print(f"⚠️ Yahoo gave no stock prices: {e!r}")
        return None
    prices = {}
    for result in results:
        meta = ((result.get("response") or [{}])[0] or {}).get("meta") or {}
        price, traded = meta.get("regularMarketPrice"), meta.get("regularMarketTime")
        if isinstance(price, (int, float)) and price > 0:
            at = datetime.fromtimestamp(traded, IST).replace(tzinfo=None) if isinstance(traded, (int, float)) else None
            prices[result.get("symbol")] = (float(price), at)
    return prices


def stock_prices(symbols):
    """({Kite symbol: last traded price}, when the latest of them traded) for the
    ones Yahoo knows. One it doesn't (an SGB, a bond) keeps the price it had."""
    prices, latest = {}, None
    for attempt in range(4):
        asked = {}
        for symbol in symbols:
            tickers = _tickers(symbol)
            if symbol not in prices and attempt < len(tickers):
                asked.setdefault(tickers[attempt], []).append(symbol)
        names = list(asked)
        for i in range(0, len(names), BATCH):
            found = _spark(names[i:i + BATCH])
            if found is None:
                return prices, latest     # offline: no point asking again
            for ticker, (price, at) in found.items():
                for symbol in asked.get(ticker, ()):
                    prices[symbol] = price
                if at and (latest is None or at > latest):
                    latest = at
    return prices, latest


def _fund_nav(isin):
    try:
        scheme = funds_service.scheme_for(isin=isin) if isin else None
    except NavUnavailable:
        return None
    return scheme["nav"] if scheme else None


def _fund_isin(holding):
    """A fund from an older sync, stored by name alone: the scheme of that name
    (Direct or Regular, Growth or IDCW) whose NAV around the sync's day is the
    one Kite valued it at."""
    try:
        candidates = [s for s in funds_service.latest_navs().values()
                      if s["isins"] and s["name"].lower() == holding.symbol.lower()]
    except NavUnavailable:
        return None
    if len(candidates) <= 1:
        return candidates[0]["isins"][0] if candidates else None

    def gap(scheme):
        try:
            navs, days = funds_service.nav_history(scheme["code"])
        except NavUnavailable:
            return float("inf")
        end = bisect.bisect_right(days, holding.date)
        # The sync priced it at AMFI's latest NAV then: that day's, or a day or two before.
        return min((abs(navs[d] - holding.nav) / holding.nav for d in days[max(0, end - 5):end]), default=float("inf"))

    best = min(((gap(s), s) for s in candidates), key=lambda pair: pair[0])
    return best[1]["isins"][0] if best[0] < 0.01 else None


# ---- the day's holdings ----

def _stale(priced_at, now):
    """Whether prices set at `priced_at` (IST) are due again at `now`."""
    if priced_at is None or priced_at.date() != now.date():
        return True
    if now.weekday() >= 5 or priced_at.time() >= MARKET_CLOSE:
        return False      # no market today, or its closing prices are in
    return now - priced_at >= REFRESH


def reprice_if_due(now=None):
    """On Daily, the first look each day copies the last sync's holdings onto
    today at today's prices; later looks reprice them until the market's closing
    prices are in, and when AMFI publishes newer NAVs. Never stops the page loading."""
    owner = data_owner()
    settings = db.session.get(UserSettings, owner) if owner else None
    if settings is None or settings.kite_valuation != "daily":
        return
    now = (now or datetime.now(IST)).replace(tzinfo=None)
    today, priced_at = now.date(), settings.kite_priced_at
    try:
        day = funds_service.last_kite_day(today)
        if day is None:
            return        # never synced Kite
        equity = EquityHolding.query.filter_by(date=day).all()
        funds = MutualFundHolding.query.filter_by(date=day).all()
        if day == today:
            if not all(h.repriced for h in equity + funds):
                return    # synced today: Kite's own prices stand
            if not _stale(priced_at, now) and not any((_fund_nav(f.isin) or f.nav) != f.nav for f in funds):
                return
        _reprice(owner, priced_at, today, equity, funds, now)
    except Exception as e:   # a bad answer from Yahoo or AMFI: next look tries again
        db.session.rollback()
        print(f"⚠️ Couldn't reprice Kite holdings: {e!r}")


def _reprice(owner, priced_at, today, equity, funds, now):
    prices, quoted = stock_prices(sorted({e.symbol for e in equity})) if equity else ({}, None)
    isins = {f.id: f.isin or _fund_isin(f) for f in funds}
    navs = {f.id: _fund_nav(isins[f.id]) for f in funds}
    if not prices and not any(navs.values()):
        return            # nothing could be priced (offline): next look tries again

    base = int(time.time() * 1000) * 1000   # clear of the ids a sync picks (milliseconds, plus a little)
    rows = []
    for e in equity:
        ltp = prices.get(e.symbol, e.ltp)
        rows.append(EquityHolding(
            id=base + len(rows), date=today, symbol=e.symbol, quantity=e.quantity, average_price=e.average_price,
            ltp=ltp, invested_value=e.invested_value, current_value=e.quantity * ltp, repriced=True))
    for f in funds:
        nav = navs[f.id] or f.nav
        rows.append(MutualFundHolding(
            id=base + len(rows), date=today, symbol=f.symbol, isin=isins[f.id], quantity=f.quantity,
            average_price=f.average_price, nav=nav, invested_value=f.invested_value,
            current_value=f.quantity * nav, repriced=True))

    # The prices were fetched unlocked, so another request may have stored
    # today's meanwhile: only the first to take the lock writes.
    settings = UserSettings.query.filter_by(email=owner).populate_existing().with_for_update().first()
    if settings.kite_priced_at != priced_at:
        db.session.rollback()
        return
    EquityHolding.query.filter_by(date=today, repriced=True).delete(synchronize_session=False)
    MutualFundHolding.query.filter_by(date=today, repriced=True).delete(synchronize_session=False)
    db.session.add_all(rows)
    db.session.flush()
    funds_service.recompute_snapshot(today)
    settings.kite_priced_at = now
    if quoted:
        settings.kite_quoted_at = quoted
    db.session.commit()


def _market_open(now):
    return now.weekday() < 5 and clock(9, 15) <= now.time() <= clock(15, 30)


def price_times(now=None):
    """What the Investments page says about prices: on Daily, when the stocks'
    prices are from (stale when the market's open and they're well behind, as
    when Yahoo turns the server away); on Manual, the last Kite sync."""
    owner = data_owner()
    settings = db.session.get(UserSettings, owner) if owner else None
    mode = settings.kite_valuation if settings and settings.kite_valuation in MODES else "manual"
    now = (now or datetime.now(IST)).replace(tzinfo=None)
    synced = max((d for d in (
        db.session.query(db.func.max(model.date))
        .filter(model.owner_email == owner, model.repriced.is_(False)).scalar()
        for model in (EquityHolding, MutualFundHolding)) if d is not None), default=None)
    quoted = settings.kite_quoted_at if settings else None
    day = funds_service.last_kite_day(now.date())
    held = day is not None and EquityHolding.query.filter_by(date=day).first() is not None
    return {
        "mode": mode,
        "synced": synced.isoformat() if synced else None,
        "stocks_at": quoted.isoformat() if quoted and mode == "daily" else None,
        "checked_at": settings.kite_priced_at.isoformat() if settings and settings.kite_priced_at and mode == "daily" else None,
        "stale": bool(mode == "daily" and held and _market_open(now) and (quoted is None or now - quoted > STALE_AFTER)),
    }
