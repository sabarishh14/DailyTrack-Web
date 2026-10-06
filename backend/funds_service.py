"""Mutual funds held outside Kite: valued daily from AMFI's NAVs, imported from
CAS statements or added by hand, with SIPs that add their own instalments.

They live in their own tables (models.py: Fund, FundTransaction, FundSip,
FundValue) and join Kite's numbers in just two places: the day's
PortfolioSnapshot, and the holdings the Investments page reads (invest.py). So
the two never collide, and a fund Kite already tracks is never imported again.

NAVs: AMFI's daily file (official) for today's; mfapi.in (community, free) only
for past days, to turn an old purchase or a SIP instalment into units.
"""
import bisect
import hashlib
import re
import threading
import time
from collections import Counter
from datetime import date, datetime, timedelta

import pytz
import requests
from dateutil.relativedelta import relativedelta
from sqlalchemy.exc import IntegrityError

from extensions import db
from models import (EquityHolding, Fund, FundSip, FundTransaction, FundValue, ManualAsset,
                    MutualFundHolding, PortfolioSnapshot)
from tenancy import data_owner

IST = pytz.timezone("Asia/Kolkata")
AMFI_URLS = ("https://portal.amfiindia.com/spages/NAVAll.txt", "https://www.amfiindia.com/spages/NAVAll.txt")
HISTORY_URL = "https://api.mfapi.in/mf/{code}"
NAV_REFRESH_SECONDS = 3 * 3600
STAMP_DUTY = 0.00005      # 0.005% of a purchase since July 2020; units are bought with the rest
MANUAL_FOLIO = "manual"   # folio_ref of a fund added by hand
MANUAL_GROUPS = {
    "fixed": ("FD", "RD", "Cash"),
    "provident": ("EPF", "PPF", "NPS"),
    "gold": ("SGB", "RealEstate"),
}


class NavUnavailable(Exception):
    """AMFI (or the history source) couldn't be reached; try again on the next look."""


class StatementError(Exception):
    """A CAS that can't be read, with a message fit to show."""


def ist_today():
    return datetime.now(IST).date()


def clean_name(name):
    """A fund's name without its plan and option, the way Kite's holdings are named."""
    for pattern in (r"\s*-\s*Direct.*", r"\s*-\s*Regular.*", r"\s*-\s*Growth.*", r"\s*-\s*IDCW.*", r"\s*-\s*Dividend.*"):
        name = re.sub(pattern, "", name, flags=re.I)
    return name.strip()


# ---- today's NAVs (AMFI) ----

_lock = threading.Lock()
_navs = {"at": 0.0, "by_code": {}, "by_isin": {}}


def parse_amfi(text):
    """{scheme code: scheme} from AMFI's NAVAll.txt, read by column name: its
    columns have moved before (Plan and Option arrived in 2026)."""
    lines = text.splitlines()
    header = [h.strip() for h in lines[0].split(";")]
    col = {h: i for i, h in enumerate(header)}
    if any(k not in col for k in ("Scheme Code", "Scheme Name", "Net Asset Value", "Date")):
        raise NavUnavailable("AMFI's NAV file has changed shape")
    isin_cols = [i for h, i in col.items() if h.startswith("ISIN")]
    by_code, amc = {}, None
    for line in lines[1:]:
        parts = [p.strip() for p in line.split(";")]
        if len(parts) != len(header):
            if line.strip().endswith("Mutual Fund"):
                amc = line.strip()      # each fund house's schemes follow its name
            continue
        if not parts[0].isdigit():
            continue
        try:
            nav = float(parts[col["Net Asset Value"]])
            nav_date = datetime.strptime(parts[col["Date"]], "%d-%b-%Y").date()
        except ValueError:
            continue
        name = parts[col["Scheme Name"]]
        detail = [parts[col[k]] for k in ("Plan", "Option") if k in col and parts[col[k]]]
        by_code[parts[0]] = {
            "code": parts[0],
            "name": clean_name(name),
            "full_name": " - ".join([name, *detail]),
            "amc": amc,
            "isins": [parts[i] for i in isin_cols if parts[i] not in ("", "-")],
            "nav": nav,
            "date": nav_date,
        }
    return by_code


def latest_navs():
    """{scheme code: scheme} with today's NAVs, fetched at most every few hours.
    A failed fetch keeps serving the last good copy."""
    now = time.time()
    with _lock:
        if _navs["by_code"] and now - _navs["at"] < NAV_REFRESH_SECONDS:
            return _navs["by_code"]
    text = None
    for url in AMFI_URLS:
        try:
            resp = requests.get(url, timeout=20, headers={"User-Agent": "DailyTrack"})
            if resp.ok and "Scheme Code" in resp.text[:300]:
                text = resp.text
                break
        except requests.RequestException:
            continue
    if text is None:
        if _navs["by_code"]:
            return _navs["by_code"]
        raise NavUnavailable("Couldn't reach AMFI for today's NAVs")
    by_code = parse_amfi(text)
    by_isin = {isin: s for s in by_code.values() for isin in s["isins"]}
    with _lock:
        _navs.update(at=now, by_code=by_code, by_isin=by_isin)
    return by_code


def scheme_for(code=None, isin=None):
    by_code = latest_navs()
    return by_code.get(str(code or "")) or _navs["by_isin"].get(str(isin or ""))


def search(query, limit=20):
    """Funds still being priced whose name has every word typed, Direct-Growth first."""
    words = [w for w in query.lower().split() if w]
    by_code = latest_navs()
    newest = max((s["date"] for s in by_code.values()), default=ist_today())
    live = newest - timedelta(days=30)
    hits = [s for s in by_code.values()
            if s["date"] >= live and all(w in s["full_name"].lower() or w in (s["amc"] or "").lower() for w in words)]
    hits.sort(key=lambda s: ("direct" not in s["full_name"].lower(), "growth" not in s["full_name"].lower(), s["full_name"]))
    return hits[:limit]


# ---- past NAVs (mfapi.in) ----

_history = {}


def nav_history(code):
    """(NAV by day, sorted days) for one fund, fetched at most once a day."""
    today = ist_today()
    hit = _history.get(code)
    if hit and hit[0] == today:
        return hit[1], hit[2]
    try:
        resp = requests.get(HISTORY_URL.format(code=code), timeout=20, headers={"User-Agent": "DailyTrack"})
        resp.raise_for_status()
        rows = resp.json().get("data") or []
    except (requests.RequestException, ValueError) as e:
        raise NavUnavailable("Couldn't fetch past NAVs") from e
    navs = {}
    for row in rows:
        try:
            navs[datetime.strptime(row["date"], "%d-%m-%Y").date()] = float(row["nav"])
        except (KeyError, ValueError):
            continue
    days = sorted(navs)
    _history[code] = (today, navs, days)
    return navs, days


def nav_on(code, day):
    """(day priced, NAV) that a purchase on `day` gets: that day's, or the next
    one published (weekends, holidays). None while it isn't out yet."""
    latest = latest_navs().get(code)
    if latest and latest["date"] == day:
        return day, latest["nav"]
    navs, days = nav_history(code)
    i = bisect.bisect_left(days, day)
    if i < len(days):
        return days[i], navs[days[i]]
    if latest and latest["date"] >= day:
        return latest["date"], latest["nav"]
    return None


def purchase_units(amount, nav):
    return round(amount * (1 - STAMP_DUTY) / nav, 3)


def _key(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()


def folio_ref(folio):
    return hashlib.sha256(str(folio).encode()).hexdigest()[:16]


def folio_tail(folio):
    """The last 4 of the folio number itself: CAMS writes "12345678 / 0", and
    the " / 0" is a check digit, not the number."""
    main = str(folio).split("/")[0]
    return re.sub(r"[^0-9A-Za-z]", "", main)[-4:] or None


# ---- SIPs ----

def next_instalment(sip, after):
    return after + relativedelta(months=1, day=sip.day)


def first_instalment(day, since):
    """The first instalment on or after `since`, on day `day` of the month."""
    first = since + relativedelta(day=day)
    return first if first >= since else first + relativedelta(months=1, day=day)


def process_sips(today):
    """Adds every instalment that's fallen due, at its own day's NAV. Stops
    where a NAV isn't out yet; the next look carries on from there."""
    added = 0
    for sip in FundSip.query.filter(FundSip.active.is_(True), FundSip.next_date <= today).all():
        fund = Fund.query.filter_by(id=sip.fund_id).first()
        if fund is None:
            sip.active = False
            continue
        for _ in range(600):   # 50 years of months, at most
            if sip.next_date > today:
                break
            priced = nav_on(fund.amfi_code, sip.next_date)
            if priced is None or priced[0] > today:
                break
            nav = priced[1]
            units = purchase_units(float(sip.amount), nav)
            db.session.add(FundTransaction(
                fund_id=fund.id, date=sip.next_date, kind="PURCHASE_SIP", amount=sip.amount,
                units=units, nav=nav, source="sip", key=_key("sip", fund.id, sip.next_date),
            ))
            fund.units = round((fund.units or 0) + units, 3)
            fund.invested = float(fund.invested or 0) + float(sip.amount)
            sip.next_date = next_instalment(sip, sip.next_date)
            added += 1
    return added


# ---- valuing, and the day's snapshot ----

def value_funds(today):
    """Today's worth of every fund held (folios merged), then today's snapshot."""
    owner = data_owner()
    navs = latest_navs()
    held = {}
    for f in Fund.query.filter(Fund.units > 0).all():
        row = held.setdefault(f.amfi_code, {"name": f.name, "units": 0.0, "invested": 0.0})
        row["units"] += f.units or 0
        row["invested"] += float(f.invested or 0)
    FundValue.query.filter(FundValue.owner_email == owner, FundValue.date == today).delete(synchronize_session=False)
    for code, row in held.items():
        scheme = navs.get(code)
        if scheme:
            nav, nav_date = scheme["nav"], scheme["date"]
        else:   # merged or wound up: its last known NAV
            last = FundValue.query.filter_by(amfi_code=code).order_by(FundValue.date.desc()).first()
            if last is None:
                continue
            nav, nav_date = last.nav, last.nav_date
        db.session.add(FundValue(
            date=today, amfi_code=code, name=row["name"], units=round(row["units"], 3), nav=nav,
            nav_date=nav_date, invested=round(row["invested"], 2), value=round(row["units"] * nav, 2),
        ))
    db.session.flush()
    recompute_snapshot(today)


def last_kite_day(day):
    """The latest day on or before `day` with a Kite sync: its holdings stand
    until the next sync, like the snapshots always showed them."""
    owner = data_owner()
    days = [d for d in (
        db.session.query(db.func.max(EquityHolding.date))
        .filter(EquityHolding.owner_email == owner, EquityHolding.date <= day).scalar(),
        db.session.query(db.func.max(MutualFundHolding.date))
        .filter(MutualFundHolding.owner_email == owner, MutualFundHolding.date <= day).scalar(),
    ) if d is not None]
    return max(days) if days else None


def recompute_snapshot(day):
    """The day's totals: Kite's latest sync, funds held outside it, and manual assets."""
    kite_day = last_kite_day(day)
    equity = EquityHolding.query.filter_by(date=kite_day).all() if kite_day else []
    kite_funds = MutualFundHolding.query.filter_by(date=kite_day).all() if kite_day else []
    own_funds = FundValue.query.filter_by(date=day).all()
    manual = ManualAsset.query.all()

    snap = PortfolioSnapshot.query.filter_by(date=day).first()
    if snap is None:
        if not (equity or kite_funds or own_funds or manual):
            return None
        snap = PortfolioSnapshot(id=int(time.time() * 1000), date=day)
        db.session.add(snap)

    def manual_total(group, field):
        return sum(getattr(a, field) or 0 for a in manual if a.category in MANUAL_GROUPS[group])

    snap.total_equity_inv = sum(e.invested_value for e in equity)
    snap.total_equity_curr = sum(e.current_value for e in equity)
    snap.total_mf_inv = sum(m.invested_value for m in kite_funds) + sum(f.invested for f in own_funds)
    snap.total_mf_curr = sum(m.current_value for m in kite_funds) + sum(f.value for f in own_funds)
    snap.total_fixed_income_inv = manual_total("fixed", "invested_value")
    snap.total_fixed_income_curr = manual_total("fixed", "current_value")
    snap.total_provident_inv = manual_total("provident", "invested_value")
    snap.total_provident_curr = manual_total("provident", "current_value")
    snap.total_gold_inv = manual_total("gold", "invested_value")
    snap.total_gold_curr = manual_total("gold", "current_value")
    snap.grand_total_inv = (snap.total_equity_inv + snap.total_mf_inv + snap.total_fixed_income_inv
                            + snap.total_provident_inv + snap.total_gold_inv)
    snap.grand_total_curr = (snap.total_equity_curr + snap.total_mf_curr + snap.total_fixed_income_curr
                             + snap.total_provident_curr + snap.total_gold_curr)
    snap.synced = False
    return snap


def refresh_if_due():
    """The first look each day (and after AMFI publishes a newer NAV) adds due SIP
    instalments and values the funds. Cheap when there's nothing to do; never
    stops the page loading."""
    if not (Fund.query.filter(Fund.units > 0).first() or FundSip.query.filter(FundSip.active.is_(True)).first()):
        return
    today = ist_today()
    due = FundSip.query.filter(FundSip.active.is_(True), FundSip.next_date <= today).first()
    valued = FundValue.query.filter_by(date=today).all()
    try:
        if valued and not due:
            navs = latest_navs()
            # Only when AMFI has a newer NAV for something held: a fund priced
            # less often than daily never sets this off on every look.
            if not any((navs.get(v.amfi_code) or {}).get("date", v.nav_date) > v.nav_date for v in valued):
                return
        process_sips(today)
        value_funds(today)
        db.session.commit()
    except (NavUnavailable, IntegrityError):
        # Offline, or another request did it a moment ago: either way, next look.
        db.session.rollback()


# ---- adding by hand ----

def kite_tracked_names():
    """Names of the funds in the latest Kite sync, so imports and adds skip them."""
    day = (db.session.query(db.func.max(MutualFundHolding.date))
           .filter(MutualFundHolding.owner_email == data_owner()).scalar())
    if day is None:
        return set()
    return {clean_name(h.symbol).lower() for h in MutualFundHolding.query.filter_by(date=day).all()}


def manual_fund(scheme):
    fund = Fund.query.filter_by(amfi_code=scheme["code"], folio_ref=MANUAL_FOLIO).first()
    if fund is None:
        fund = Fund(amfi_code=scheme["code"], isin=(scheme["isins"] or [None])[0], name=scheme["name"],
                    amc=scheme["amc"], folio_ref=MANUAL_FOLIO, units=0.0, invested=0, source="manual")
        db.session.add(fund)
        db.session.flush()
    return fund


def add_lumpsum(fund, amount, day):
    priced = nav_on(fund.amfi_code, day)
    if priced is None:
        raise NavUnavailable("That day's NAV isn't out yet")
    units = purchase_units(amount, priced[1])
    db.session.add(FundTransaction(
        fund_id=fund.id, date=day, kind="PURCHASE", amount=amount, units=units, nav=priced[1],
        source="manual", key=_key("manual", fund.id, day, amount, time.time()),
    ))
    fund.units = round((fund.units or 0) + units, 3)
    fund.invested = float(fund.invested or 0) + amount
    return units


def start_sip(fund, amount, day, since):
    sip = FundSip(fund_id=fund.id, amount=amount, day=day, next_date=first_instalment(day, since), active=True)
    db.session.add(sip)
    db.session.flush()
    return sip


# ---- CAS statements ----

def parse_cas(stream, password):
    """casparser's reading of a CAMS / KFintech CAS, as plain dicts. The PDF and
    its password go no further than this call."""
    try:
        from casparser import read_cas_pdf
        from casparser.exceptions import CASParseError, IncorrectPasswordError
    except ImportError as e:
        raise StatementError("Statement import isn't set up on the server yet") from e
    try:
        data = read_cas_pdf(stream, password)
    except IncorrectPasswordError as e:
        raise StatementError("That password didn't open the PDF") from e
    except CASParseError as e:
        message = str(e)
        if "password" in message.lower():
            raise StatementError("That password didn't open the PDF") from e
        raise StatementError("Couldn't read that statement. Use the Detailed CAS from CAMS or KFintech.") from e
    except Exception as e:  # a damaged or unexpected PDF
        raise StatementError("Couldn't read that PDF") from e
    if not hasattr(data, "folios"):
        raise StatementError("That's a demat (NSDL/CDSL) statement. For funds, use the CAS from CAMS or KFintech.")
    return data.model_dump(mode="python", by_alias=True)


def _as_date(value):
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    for fmt in ("%Y-%m-%d", "%d-%b-%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(str(value), fmt).date()
        except ValueError:
            continue
    raise StatementError(f"Unreadable date in the statement: {value}")


def _number(value):
    return float(value) if value is not None else None


def import_statement(cas, today):
    """Adds or updates every fund in the statement, with its transactions.
    Re-importing (or an overlapping statement) changes nothing it's already got.
    Funds Kite already tracks are skipped, so nothing counts twice."""
    period_to = _as_date(cas["statement_period"]["to"])
    kite = kite_tracked_names()
    summary = {"added": [], "updated": [], "closed": [], "skipped_kite": [], "unknown": [],
               "period": {"from": str(_as_date(cas["statement_period"]["from"])), "to": str(period_to)}}

    for folio in cas.get("folios") or []:
        ref, tail = folio_ref(folio["folio"]), folio_tail(folio["folio"])
        for s in folio.get("schemes") or []:
            scheme = scheme_for(s.get("amfi"), s.get("isin"))
            if scheme is None:
                summary["unknown"].append(s.get("scheme"))
                continue
            if scheme["name"].lower() in kite:
                summary["skipped_kite"].append(scheme["name"])
                continue

            fund = Fund.query.filter_by(amfi_code=scheme["code"], folio_ref=ref).first()
            is_new = fund is None
            if is_new:
                fund = Fund(amfi_code=scheme["code"], folio_ref=ref, name=scheme["name"], units=0.0, invested=0, source="cas")
                db.session.add(fund)
            fund.name, fund.isin, fund.amc = scheme["name"], s.get("isin") or fund.isin, folio.get("amc") or scheme["amc"]
            fund.folio_tail, fund.source = tail, "cas"
            fund.statement_to = max(period_to, fund.statement_to or period_to)
            db.session.flush()

            existing = {k for (k,) in db.session.query(FundTransaction.key).filter(FundTransaction.fund_id == fund.id)}
            seen = Counter()
            for t in s.get("transactions") or []:
                day, kind = _as_date(t["date"]), str(getattr(t["type"], "name", t["type"]))
                amount, units = _number(t.get("amount")), _number(t.get("units"))
                ident = (day, kind, amount, units)
                seen[ident] += 1   # two identical rows on one day are both real
                key = _key("cas", ref, scheme["code"], *ident, seen[ident])
                if key in existing:
                    continue
                existing.add(key)
                db.session.add(FundTransaction(fund_id=fund.id, date=day, kind=kind, amount=amount,
                                               units=units, nav=_number(t.get("nav")), source="cas", key=key))

            # The statement is the truth up to its last day: instalments the app
            # added for days it covers give way to it; later ones stay on top.
            FundTransaction.query.filter(FundTransaction.fund_id == fund.id, FundTransaction.source == "sip",
                                         FundTransaction.date <= period_to).delete(synchronize_session=False)
            later = FundTransaction.query.filter(FundTransaction.fund_id == fund.id, FundTransaction.source == "sip",
                                                 FundTransaction.date > period_to).all()
            close = float(s["close"])
            cost = _number((s.get("valuation") or {}).get("cost"))
            fund.units = round(close + sum(t.units or 0 for t in later), 3)
            fund.invested = (cost if cost is not None else float(fund.invested or 0)) + sum(float(t.amount or 0) for t in later)

            # Added by hand before: the statement has all of it now, so its copy
            # goes (its SIP carries on, in the statement's folio).
            by_hand = Fund.query.filter_by(amfi_code=scheme["code"], folio_ref=MANUAL_FOLIO).first()
            if by_hand is not None:
                FundSip.query.filter(FundSip.fund_id == by_hand.id).update({"fund_id": fund.id}, synchronize_session=False)
                FundTransaction.query.filter(FundTransaction.fund_id == by_hand.id).delete(synchronize_session=False)
                db.session.delete(by_hand)

            if close <= 0 and not later:
                fund.invested = 0
                summary["closed"].append(scheme["name"])
            else:
                summary["added" if is_new else "updated"].append(scheme["name"])

    db.session.flush()
    value_funds(today)
    return summary


# ---- what the Funds list shows ----

def funds_overview():
    """Each fund held (folios merged) with today's worth, and its SIPs."""
    navs = _navs["by_code"] or {}
    try:
        navs = latest_navs()
    except NavUnavailable:
        pass
    sips = {}
    for sip in FundSip.query.filter(FundSip.active.is_(True)).all():
        sips.setdefault(sip.fund_id, []).append(sip)
    grouped = {}
    for f in Fund.query.order_by(Fund.name).all():
        row = grouped.setdefault(f.amfi_code, {
            "code": f.amfi_code, "name": f.name, "amc": f.amc, "units": 0.0, "invested": 0.0,
            "folios": [], "sold_folios": [], "sources": set(), "sips": [],
        })
        row["units"] += f.units or 0
        row["invested"] += float(f.invested or 0)
        if f.folio_tail:
            row["folios" if (f.units or 0) > 0 else "sold_folios"].append(f.folio_tail)
        row["sources"].add(f.source)
        row["sips"] += [{"id": s.id, "amount": float(s.amount), "day": s.day, "next": s.next_date.isoformat()}
                        for s in sips.get(f.id, [])]
    out = []
    for row in grouped.values():
        scheme = navs.get(row["code"])
        nav = scheme["nav"] if scheme else None
        # A fund still held shows the folios holding it; a sold one, where it was.
        sold_folios = row.pop("sold_folios")
        out.append({
            **row,
            "folios": row["folios"] or sold_folios,
            "units": round(row["units"], 3),
            "invested": round(row["invested"], 2),
            "sources": sorted(row["sources"]),
            "nav": nav,
            "nav_date": scheme["date"].isoformat() if scheme else None,
            "value": round(row["units"] * nav, 2) if nav is not None else None,
        })
    out.sort(key=lambda r: (r["units"] <= 0, -(r["value"] or 0)))
    return out
