"""Accounts in other currencies: a USD account beside the rupee ones.

A transaction on one is entered in its account's currency, but stored in
rupees too: `amount` stays the rupee figure everything adds up (budgets, the
analyser, Sheets, Nagapandi), and `original_amount`, `currency` and `fx_rate`
keep what was entered and the rate it was turned into rupees at. The account's
own balance, minimum and card budget stay in its currency.

Rates are ExchangeRate-API's free daily ones (no key; they ask to be credited
where rates are shown), held for a few hours by each worker.
"""
import threading
import time

import requests

HOME = "INR"

# What the apps offer, and how each is written before an amount.
SYMBOLS = {
    "INR": "₹", "USD": "$", "EUR": "€", "GBP": "£", "AED": "AED ", "SGD": "S$",
    "AUD": "A$", "CAD": "C$", "NZD": "NZ$", "JPY": "¥", "CHF": "CHF ", "HKD": "HK$",
    "SAR": "SAR ", "QAR": "QAR ", "KWD": "KWD ", "BHD": "BHD ", "MYR": "RM ", "THB": "฿",
}

RATES_URL = "https://open.er-api.com/v6/latest/INR"
KEEP_FOR = 6 * 60 * 60   # seconds: the source updates once a day

_lock = threading.Lock()
_cached = {"at": 0.0, "rates": None}


class RateUnavailable(Exception):
    """No rate for a currency: the source isn't answering and none was ever fetched."""


def _fetch():
    """Rupees per unit of each supported currency."""
    response = requests.get(RATES_URL, timeout=10)
    response.raise_for_status()
    data = response.json()
    if data.get("result") != "success":
        raise ValueError(f"rates source said {data.get('result')!r}")
    per_rupee = data.get("rates") or {}
    rates = {code: 1 / per_rupee[code] for code in SYMBOLS if per_rupee.get(code)}
    rates[HOME] = 1.0
    return rates


def rates():
    """Rupees per unit of each supported currency, fetched at most every few
    hours. When the source fails, the last rates stand rather than none."""
    with _lock:
        fresh = _cached["rates"] is not None and time.time() - _cached["at"] < KEEP_FOR
        if fresh:
            return _cached["rates"]
        try:
            _cached["rates"], _cached["at"] = _fetch(), time.time()
        except Exception as e:
            if _cached["rates"] is None:
                raise RateUnavailable(f"Couldn't get exchange rates: {e}") from e
            print(f"⚠️ Exchange rates not refreshed, keeping the last ones: {e!r}")
        return _cached["rates"]


def rate(code):
    """Rupees for one unit of `code`; 1 for rupees (or no currency)."""
    if not code or code == HOME:
        return 1.0
    found = rates().get(code)
    if not found:
        raise RateUnavailable(f"No exchange rate for {code}")
    return found


def to_home(amount, code):
    """`amount` of `code` in rupees, or None when there's no rate for it."""
    if amount is None:
        return None
    try:
        return round(float(amount) * rate(code), 2)
    except RateUnavailable:
        return None


def money(amount, code=HOME):
    """"₹1,250" / "$12.50": an amount written in its currency, for messages."""
    value = float(amount)
    text = f"{value:,.0f}" if value == int(value) else f"{value:,.2f}"
    return f"{SYMBOLS.get(code or HOME, (code or HOME) + ' ')}{text}"
