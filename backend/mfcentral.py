"""MF Central's "CAS detailed report" (the Excel download): every folio linked to
a PAN, and each one's transactions. Read in memory and handed back in the shape
funds_service.import_statement takes.
Nothing of it is kept or logged: the name, mobile, email and PAN at its top
are never read, and folio numbers leave only as a hash and their last 4 digits.

What a fund cost is worked out the way Groww and Tickertape show it: units x
NAV of each purchase (or switch-in) still held, the oldest units going first
when some are sold or switched out. That leaves out stamp duty (0.005% of each
purchase since July 2020), which MF Central's own "Invested Value" includes.

The transaction sheet has no folio column, but each folio's rows for a fund
come together, oldest first: a run of one fund's rows is one folio, a new run
starts where the fund changes or the date goes back, and two runs that came
out as one are split where both halves hold what a folio holds."""
import io
import re
import zipfile
from collections import deque
from datetime import date, datetime, timedelta
from xml.etree import ElementTree as ET

from funds_service import NavUnavailable, StatementError, _growth, _plan, ist_today, match_scheme

MAX_PART_BYTES = 40 * 1024 * 1024
UNITS_MATCH = 0.0015
_M = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"


# ---- the Excel file ----

def _column(ref, fallback):
    letters = re.match(r"[A-Z]+", ref or "")
    if not letters:
        return fallback
    n = 0
    for ch in letters.group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def _sheets(data):
    """{sheet name: rows of cell text}."""
    try:
        book = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as e:
        raise StatementError("Couldn't open that file as MF Central's Excel") from e

    def part(name):
        try:
            info = book.getinfo(name)
        except KeyError:
            return None
        if info.file_size > MAX_PART_BYTES:
            raise StatementError("That Excel file is too large")
        raw = book.read(name)
        if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:
            raise StatementError("Couldn't read that Excel file")
        try:
            return ET.fromstring(raw)
        except ET.ParseError as e:
            raise StatementError("Couldn't read that Excel file") from e

    workbook, rels = part("xl/workbook.xml"), part("xl/_rels/workbook.xml.rels")
    if workbook is None or rels is None:
        raise StatementError("That isn't MF Central's Excel")
    targets = {r.get("Id"): r.get("Target") or "" for r in rels}
    strings = part("xl/sharedStrings.xml")
    shared = ["".join(t.text or "" for t in si.iter(f"{_M}t")) for si in strings.findall(f"{_M}si")] if strings is not None else []

    out = {}
    for sheet in workbook.iter(f"{_M}sheet"):
        target = targets.get(sheet.get(f"{_R}id"), "")
        root = part(target.lstrip("/") if target.startswith("/") else "xl/" + target)
        if root is None:
            continue
        rows = []
        for row in root.iter(f"{_M}row"):
            cells = {}
            for i, c in enumerate(row.findall(f"{_M}c")):
                v, kind = c.find(f"{_M}v"), c.get("t")
                if kind == "s" and v is not None:
                    text = shared[int(v.text)]
                elif kind == "inlineStr":
                    text = "".join(t.text or "" for t in c.iter(f"{_M}t"))
                else:
                    text = v.text if v is not None and v.text is not None else ""
                cells[_column(c.get("r"), i)] = text
            rows.append([cells.get(i, "") for i in range(max(cells) + 1)] if cells else [])
        out[sheet.get("name")] = rows
    return out


def _table(rows, first):
    """The rows under the header row starting with `first`, as {column: text}."""
    head = next((i for i, r in enumerate(rows) if r and r[0].strip() == first), None)
    if head is None:
        return None
    cols = [c.strip().lower() for c in rows[head]]
    return [{cols[i]: r[i] for i in range(min(len(cols), len(r))) if cols[i]}
            for r in rows[head + 1:] if r and r[0].strip()]


# ---- values ----

def _clean(text):
    return re.sub(r"\s+", " ", str(text or "")).strip()


def _num(text):
    text = str(text or "").replace(",", "").strip()
    if text in ("", "-"):
        return 0.0
    try:
        return float(text)
    except ValueError as e:
        raise StatementError(f"Unreadable number in the statement: {text}") from e


def _day(text):
    text = str(text or "").strip()
    if re.fullmatch(r"\d+(\.0+)?", text):          # an Excel date number
        return date(1899, 12, 30) + timedelta(days=int(float(text)))
    for fmt in ("%d-%b-%Y", "%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d %b %Y"):
        try:
            return datetime.strptime(text, fmt).date()
        except ValueError:
            continue
    raise StatementError(f"Unreadable date in the statement: {text}")


def _kind(description, units):
    d = description.lower()
    if "reversal" in d or "reject" in d:
        return "REVERSAL"
    if re.search(r"switch[\s-]*in\b", d):
        return "SWITCH_IN"
    if re.search(r"switch[\s-]*out", d):
        return "SWITCH_OUT"
    if units < 0:
        return "REDEMPTION"
    if "reinvest" in d:
        return "DIVIDEND_REINVEST"
    if re.search(r"\bsip\b|systematic|\bsys\b", d):
        return "PURCHASE_SIP"
    return "PURCHASE"


# ---- what the units still held cost ----

def _cost(rows):
    """(units still held, what they were bought for): units x NAV of each
    purchase or switch-in, sales and switch-outs taking the oldest first."""
    lots = deque()
    for row in rows:
        if row["units"] > 0:
            lots.append([row["units"], row["nav"]])
            continue
        out = -row["units"]
        while out > 1e-9 and lots:
            take = min(out, lots[0][0])
            lots[0][0] -= take
            out -= take
            if lots[0][0] <= 1e-9:
                lots.popleft()
    return round(sum(u for u, _ in lots), 3), sum(u * n for u, n in lots)


def _runs(transactions):
    """Each folio's rows for a fund: [{"scheme", "rows"}], in the sheet's order."""
    runs, prev = [], None
    for i, t in enumerate(transactions):
        units = _num(t.get("units"))
        if not units:
            continue                              # nominee, address, lien: no money moved
        name, day = _clean(t.get("scheme name")), _day(t.get("date"))
        between = prev is not None and any(_clean(transactions[j].get("scheme name")) != name for j in range(prev[2] + 1, i))
        if prev is None or name != prev[0] or day < prev[1] or between:
            runs.append({"scheme": name, "rows": []})
        runs[-1]["rows"].append({"date": day, "units": units, "nav": _num(t.get("nav")), "amount": _num(t.get("amount")),
                                 "type": _kind(_clean(t.get("transaction description")), units)})
        prev = (name, day, i)
    for run in runs:
        run["units"], run["cost"] = _cost(run["rows"])
    return runs


def _assign(runs, holdings):
    """The run behind each folio still holding a fund: {holding index: run}.
    A run no folio's units fit is split where both halves fit one."""
    wanted = {}
    for i, h in enumerate(holdings):
        if h["units"] > 0:
            wanted.setdefault(h["scheme"], []).append(i)
    fits = lambda scheme, units: any(abs(holdings[i]["units"] - units) < UNITS_MATCH for i in wanted.get(scheme, []))
    pieces = []
    for run in runs:
        if run["units"] > 0 and not fits(run["scheme"], run["units"]):
            for k in range(1, len(run["rows"])):
                head, tail = _cost(run["rows"][:k]), _cost(run["rows"][k:])
                if fits(run["scheme"], head[0]) and fits(run["scheme"], tail[0]):
                    pieces += [{"scheme": run["scheme"], "rows": run["rows"][:k], "units": head[0], "cost": head[1]},
                               {"scheme": run["scheme"], "rows": run["rows"][k:], "units": tail[0], "cost": tail[1]}]
                    break
            else:
                pieces.append(run)
        else:
            pieces.append(run)
    taken, out = set(), {}
    for scheme, indexes in wanted.items():
        for i in indexes:
            match = next((n for n, r in enumerate(pieces) if n not in taken and r["scheme"] == scheme
                          and abs(r["units"] - holdings[i]["units"]) < UNITS_MATCH), None)
            if match is not None:
                taken.add(match)
                out[i] = pieces[match]
    return out


# ---- the report ----

def _period(rows, transactions):
    found = {}
    for r in rows[:30]:
        if len(r) > 1 and r[0].strip().lower() in ("from date", "to date") and r[1].strip():
            try:
                found[r[0].strip().lower()] = _day(r[1])
            except StatementError:
                pass
    days = [_day(t.get("date")) for t in transactions if _num(t.get("units"))]
    start = found.get("from date") or (min(days) if days else ist_today())
    return start, found.get("to date") or ist_today()


def read(data):
    """MF Central's Excel as a statement for funds_service.import_statement (see the module's notes)."""
    sheets = _sheets(data)
    portfolio_rows = sheets.get("Portfolio Details") or next(iter(sheets.values()), [])
    portfolio = _table(portfolio_rows, "Scheme Name")
    if not portfolio or "folio no." not in portfolio[0] or "units" not in portfolio[0]:
        raise StatementError("That Excel isn't MF Central's statement. Download the detailed CAS as Excel from MF Central.")
    transactions = _table(sheets.get("Transaction Details") or [], "Scheme Name") or []

    holdings = [{"scheme": _clean(p.get("scheme name")), "folio": _clean(p.get("folio no.")), "amc": _clean(p.get("amc name")),
                 "units": _num(p.get("units")), "invested": _num(p.get("invested value")), "value": _num(p.get("current value"))}
                for p in portfolio if _clean(p.get("folio no."))]
    runs = _assign(_runs(transactions), holdings)
    start, end = _period(portfolio_rows, transactions)

    # Fund houses name a Direct plan "Direct"; a name without it is the Regular
    # plan ("ICICI Prudential Infrastructure Fund - Growth").
    # Held rows first: their NAV (value / units) settles which plan it is; a
    # sold-out row of the same name, with no NAV to go by, takes their answer.
    codes = {}
    try:
        for h in sorted(holdings, key=lambda h: h["units"] <= 0):
            if codes.get(h["scheme"]):
                continue
            nav = h["value"] / h["units"] if h["units"] > 0 and h["value"] > 0 else None
            found = match_scheme(h["scheme"], _plan(h["scheme"]) or "regular", _growth(h["scheme"]), nav)
            codes[h["scheme"]] = found["code"] if found else None
    except NavUnavailable as e:
        raise StatementError("Couldn't reach AMFI to look up the funds. Try again in a minute.") from e

    folios = {}
    for i, h in enumerate(holdings):
        code = codes.get(h["scheme"])
        if h["units"] <= 0 and not code:
            continue                              # sold out, and no longer priced: nothing to close
        run = runs.get(i)
        cost = run["cost"] if run else (h["invested"] if h["units"] > 0 else 0.0)
        folio = folios.setdefault(h["folio"], {"folio": h["folio"], "amc": h["amc"], "schemes": {}})
        # Two rows of one folio that are the same fund (a renamed scheme, say) are one holding.
        key = code or h["scheme"]
        s = folio["schemes"].setdefault(key, {
            "scheme": h["scheme"], "amfi": code, "isin": None, "close": 0.0,
            "valuation": {"date": end, "value": 0.0, "cost": 0.0, "nav": None}, "transactions": []})
        if h["units"] > 0 and s["close"] <= 0:
            s["scheme"] = h["scheme"]
        s["close"] = round(s["close"] + h["units"], 3)
        s["valuation"]["value"] = round(s["valuation"]["value"] + h["value"], 2)
        s["valuation"]["cost"] = round(s["valuation"]["cost"] + cost, 2)
        if s["close"] > 0:
            s["valuation"]["nav"] = round(s["valuation"]["value"] / s["close"], 4)
        s["transactions"] += [dict(r) for r in run["rows"]] if run else []
    for folio in folios.values():
        folio["schemes"] = list(folio["schemes"].values())
    return {"statement_period": {"from": start, "to": end}, "folios": list(folios.values()),
            "file_type": "MFCENTRAL", "cas_type": "DETAILED"}
