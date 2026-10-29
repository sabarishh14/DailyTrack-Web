"""Kite's holdings repriced each day (kite_daily.py), on Daily in Settings: the
last sync's holdings copied onto the day their prices are from, until a real
sync replaces them. No network: Yahoo's prices and AMFI's NAVs are stand-ins.

    cd backend && python -m unittest tests.test_kite_daily
"""
import os
import sys
import unittest
from datetime import date, datetime, time, timedelta
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_funds_api import FRIEND, NAVS, OWNER, TODAY, ApiCase, scheme  # noqa: E402

import funds_service  # noqa: E402
import kite_daily  # noqa: E402
from blueprints import invest  # noqa: E402
from blueprints.auth import auth_bp  # noqa: E402
from extensions import db  # noqa: E402
from models import EquityHolding, MutualFundHolding, PortfolioSnapshot, UserSettings  # noqa: E402

def weekday_before(day):
    """The latest weekday before `day`: when markets last traded, give or take a holiday."""
    day -= timedelta(days=1)
    while day.weekday() >= 5:
        day -= timedelta(days=1)
    return day


# Whatever day the tests run on, prices come from a weekday and the last real
# sync is two trading days before it.
TRADING_DAY = weekday_before(TODAY)
SYNCED = weekday_before(weekday_before(TRADING_DAY))
YAHOO = {"INFY.NS": 1600.0, "IDEA.BO": 7.5}
TRADED = datetime(2026, 10, 23, 15, 29)   # when Yahoo's prices are from


def quotes(tickers):
    """Yahoo's answer: each known ticker's price and when it traded."""
    return {t: (YAHOO[t], TRADED) for t in tickers if t in YAHOO}


class KiteDailyCase(ApiCase):
    def setUp(self):
        super().setUp()
        self.app.register_blueprint(auth_bp)
        self.asked = []
        self.traded = datetime.combine(TRADING_DAY, time(15, 29))   # when the stand-in prices traded

        def spark(tickers):
            self.asked.append(list(tickers))
            return {t: (YAHOO[t], self.traded) for t in tickers if t in YAHOO}
        patch = mock.patch.object(kite_daily, "_spark", spark)
        patch.start()
        self.addCleanup(patch.stop)

    def daily(self, who=OWNER):
        self.ok("PUT", "/api/me/settings", who, {"kite_valuation": "daily"})

    def priced(self, model, day=TRADING_DAY):
        """The rows repricing filed under `day`."""
        return self.rows(model, date=day, repriced=True)


class RepriceTest(KiteDailyCase):
    def test_manual_leaves_the_last_sync_alone(self):
        self.kite_synced(OWNER, SYNCED)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual((self.rows(EquityHolding, repriced=True), self.asked), ([], []))

    def test_daily_copies_the_last_sync_onto_the_day_its_prices_are_from(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        self.assertEqual((snap["date"], snap["inv_stocks"], snap["curr_stocks"]), (TRADING_DAY.isoformat(), 2000, 3200))
        self.assertEqual((snap["inv_mf"], snap["curr_mf"]), (100, 90.0))     # 1 unit at AMFI's 90
        stocks = self.ok("GET", f"/api/investments/{TRADING_DAY.isoformat()}/equity_holdings", OWNER)
        self.assertEqual([(s["symbol"], s["ltp"], s["quantity"]) for s in stocks], [("INFY", 1600.0, 2)])
        fund = self.priced(MutualFundHolding)[0]
        self.assertEqual((fund.isin, fund.nav, fund.repriced), ("INF879O01027", 90.0, True))
        # The sync's own day is left as it was.
        self.assertEqual([e.ltp for e in self.rows(EquityHolding, date=SYNCED)], [1500])

    def test_a_second_look_soon_after_asks_for_nothing(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(len(self.asked), 1)
        self.assertEqual(len(self.priced(EquityHolding)), 1)

    def test_each_day_carries_on_from_the_last(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        with self.app.app_context():   # that was the trading day before's look; now this one's
            for model in (EquityHolding, MutualFundHolding):
                for row in model.query.filter_by(date=TRADING_DAY).all():
                    row.date = weekday_before(TRADING_DAY)
            PortfolioSnapshot.query.delete()
            settings = db.session.get(UserSettings, OWNER)
            settings.kite_priced_at = settings.kite_priced_at - timedelta(days=1)
            db.session.commit()
        YAHOO["INFY.NS"] = 1700.0
        self.addCleanup(YAHOO.__setitem__, "INFY.NS", 1600.0)
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        self.assertEqual((snap["date"], snap["curr_stocks"]), (TRADING_DAY.isoformat(), 3400))

    def test_a_sync_today_stands(self):
        self.kite_synced(OWNER, TODAY)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(self.asked, [])
        self.assertEqual([e.repriced for e in self.rows(EquityHolding, date=TODAY)], [False])

    def test_nothing_priced_means_nothing_written(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        with mock.patch.object(kite_daily, "_spark", lambda tickers: None), \
                mock.patch.object(kite_daily, "_fund_quote", lambda isin: None):
            self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(self.rows(EquityHolding, repriced=True), [])
        self.ok("GET", "/api/investments", OWNER)     # back online: the next look does it
        self.assertEqual([e.ltp for e in self.priced(EquityHolding)], [1600.0])

    def test_a_stock_yahoo_doesnt_know_keeps_its_price(self):
        self.kite_synced(OWNER, SYNCED)
        with self.app.app_context():
            db.session.add(EquityHolding(id=3, owner_email=OWNER, date=SYNCED, symbol="SGBMAR28-GB", quantity=1,
                                         average_price=5000, ltp=7000, invested_value=5000, current_value=7000))
            db.session.commit()
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(sorted((e.symbol, e.ltp) for e in self.priced(EquityHolding)),
                         [("INFY", 1600.0), ("SGBMAR28-GB", 7000)])

    def test_its_personal(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily(who=FRIEND)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(self.rows(EquityHolding, repriced=True), [])


class TradingDayTest(KiteDailyCase):
    """A record belongs to the day its prices traded: no flat copies of weekends
    and holidays."""
    def stocks_on(self, day):
        return [(e.ltp, e.repriced) for e in self.rows(EquityHolding, date=day)]

    def test_a_look_after_trading_updates_that_days_record(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)    # today, with prices from the trading day before
        self.assertEqual((self.stocks_on(TRADING_DAY), self.stocks_on(TODAY)), ([(1600.0, True)], []))
        self.assertEqual([s.date for s in self.rows(PortfolioSnapshot)], [TRADING_DAY])

    def test_the_close_updates_the_days_record_in_place(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.traded = datetime.combine(TRADING_DAY, time(11, 0))
        self.ok("GET", "/api/investments", OWNER)
        with self.app.app_context():   # due again, and the market has closed since
            settings = db.session.get(UserSettings, OWNER)
            settings.kite_priced_at -= timedelta(days=1)
            db.session.commit()
        YAHOO["INFY.NS"] = 1650.0
        self.addCleanup(YAHOO.__setitem__, "INFY.NS", 1600.0)
        self.traded = datetime.combine(TRADING_DAY, time(15, 29))
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual((self.stocks_on(TRADING_DAY), self.stocks_on(TODAY)), ([(1650.0, True)], []))

    def test_a_real_sync_that_day_stands(self):
        self.kite_synced(OWNER, TRADING_DAY)
        self.daily()
        self.traded = datetime.combine(TRADING_DAY, time(15, 29))
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual((self.stocks_on(TRADING_DAY), self.stocks_on(TODAY)), ([(1500, False)], []))

    def test_old_weekend_records_fold_into_their_friday(self):
        friday = TODAY - timedelta(days=(TODAY.weekday() - 4) % 7 + 7)     # one at least a week ago
        thursday, saturday, sunday = (friday + timedelta(days=n) for n in (-1, 1, 2))
        with self.app.app_context():
            db.session.add(EquityHolding(id=1, owner_email=OWNER, date=thursday, symbol="INFY", quantity=2,
                                         average_price=1000, ltp=1500, invested_value=2000, current_value=3000))
            for i, (day, ltp) in enumerate(((friday, 1550), (saturday, 1560), (sunday, 1570))):
                db.session.add(EquityHolding(id=10 + i, owner_email=OWNER, date=day, symbol="INFY", quantity=2,
                                             average_price=1000, ltp=ltp, invested_value=2000,
                                             current_value=2 * ltp, repriced=True))
                db.session.add(PortfolioSnapshot(id=20 + i, owner_email=OWNER, date=day, grand_total_curr=2 * ltp))
            db.session.add(UserSettings(email=OWNER, kite_valuation="daily", kite_priced_at=datetime.now()))
            db.session.commit()
        with mock.patch.object(kite_daily, "_stale", lambda priced_at, now: False):
            snaps = self.ok("GET", "/api/investments", OWNER)
        self.assertEqual([(e.date, e.ltp) for e in self.rows(EquityHolding, repriced=True)], [(friday, 1570)])
        self.assertEqual([(s["date"], s["curr_stocks"]) for s in snaps], [(friday.isoformat(), 3140)])


class SyncTest(KiteDailyCase):
    """A real sync on a repriced day takes its place."""

    def kite(self):
        def get(url, **kwargs):
            data = {
                "https://api.kite.trade/mf/holdings": {"data": [
                    {"tradingsymbol": "INF879O01027", "quantity": 2, "average_price": 100}]},
                "https://api.kite.trade/portfolio/holdings": {"data": [
                    {"tradingsymbol": "INFY", "quantity": 3, "average_price": 1000, "last_price": 1650,
                     "instrument_token": 408065}]},
            }
            if "amfiindia" in url:
                return mock.Mock(text="Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date\n"
                                      "122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;91.0;22-Oct-2026")
            return mock.Mock(json=lambda: data[url])
        post = mock.Mock(return_value=mock.Mock(json=lambda: {"status": "success", "data": {"access_token": "t"}}))
        return mock.patch.multiple(invest, requests=mock.Mock(get=get, post=post),
                                   KITE_API_KEY="k", KITE_API_SECRET="s")

    def test_a_sync_replaces_todays_repriced_rows(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        with self.kite():
            result = self.ok("POST", "/api/sync/kite", OWNER, {"request_token": "r"})
        self.assertTrue(result["success"], result)
        stocks = self.rows(EquityHolding, date=TODAY)
        self.assertEqual([(e.quantity, e.ltp, e.repriced) for e in stocks], [(3, 1650, False)])
        funds = self.rows(MutualFundHolding, date=TODAY)
        self.assertEqual([(f.quantity, f.isin, f.repriced) for f in funds], [(2, "INF879O01027", False)])
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        self.assertEqual((snap["curr_stocks"], snap["curr_mf"]), (4950, 182.0))


class PriceTimesTest(KiteDailyCase):
    """What the Investments page says about how fresh the prices are."""

    def times(self, now):
        with mock.patch.object(kite_daily, "datetime", wraps=datetime) as clock:
            clock.now.return_value = now
            return self.ok("GET", "/api/investments/prices", OWNER)

    def test_manual_shows_the_last_sync(self):
        self.kite_synced(OWNER, SYNCED)
        times = self.ok("GET", "/api/investments/prices", OWNER)
        self.assertEqual((times["mode"], times["synced"], times["stocks_at"]), ("manual", SYNCED.isoformat(), None))

    def test_daily_shows_when_the_stock_prices_traded(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        times = self.ok("GET", "/api/investments/prices", OWNER)
        self.assertEqual((times["mode"], times["stocks_at"], times["synced"]), ("daily", self.traded.isoformat(), SYNCED.isoformat()))

    def test_stale_when_yahoo_is_quiet_while_the_market_is_open(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        with mock.patch.object(kite_daily, "_spark", lambda tickers: None):
            self.ok("GET", "/api/investments", OWNER)     # funds priced, stocks not
        monday = TODAY + timedelta(days=7 - TODAY.weekday())   # the next one, after the sync
        noon = datetime(monday.year, monday.month, monday.day, 12, 0, tzinfo=funds_service.IST)
        self.assertTrue(self.times(noon)["stale"])
        self.assertFalse(self.times(noon - timedelta(days=1))["stale"])    # Sunday: no market
        self.assertFalse(self.times(noon.replace(hour=18))["stale"])       # closed for the day


class RefreshTest(KiteDailyCase):
    """A refresh by hand (?refresh=1) asks for prices now, not within 30 minutes."""

    def test_a_refresh_reprices_now_but_not_twice_in_a_minute(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(len(self.asked), 1)                  # a plain look waits its turn
        with self.app.app_context():
            settings = db.session.get(UserSettings, OWNER)
            settings.kite_priced_at -= timedelta(minutes=2)
            db.session.commit()
        self.ok("GET", "/api/investments?refresh=1", OWNER)
        self.assertEqual(len(self.asked), 2)
        self.ok("GET", "/api/investments?refresh=1", OWNER)   # tapped again straight away
        self.assertEqual(len(self.asked), 2)

    def test_a_refresh_checks_amfi_for_the_funds_now(self):
        self.ok("POST", "/api/funds", OWNER, {"code": "122639", "amount": 1000})
        with mock.patch.object(funds_service, "latest_navs", wraps=funds_service.latest_navs) as navs:
            self.ok("GET", "/api/investments?refresh=1", OWNER)
        self.assertIn(mock.call(funds_service.FRESH_NAV_SECONDS), navs.call_args_list)


class SnapshotDeleteTest(KiteDailyCase):
    """Deleting a day's snapshot: its totals and the holdings behind them."""

    def setUp(self):
        super().setUp()
        self.kite_synced(OWNER, SYNCED)
        with self.app.app_context():
            for i, (who, day) in enumerate(((OWNER, SYNCED), (OWNER, TRADING_DAY), (FRIEND, SYNCED))):
                db.session.add(PortfolioSnapshot(id=50 + i, owner_email=who, date=day, grand_total_curr=1))
            db.session.commit()

    def test_the_day_and_its_holdings_go(self):
        self.ok("DELETE", f"/api/investments/{SYNCED.isoformat()}", OWNER)
        self.assertEqual([s["date"] for s in self.ok("GET", "/api/investments", OWNER)], [TRADING_DAY.isoformat()])
        self.assertEqual((self.rows(EquityHolding, date=SYNCED), self.rows(MutualFundHolding, date=SYNCED)), ([], []))
        self.assertEqual(len(self.rows(PortfolioSnapshot, owner_email=FRIEND)), 1)    # theirs is theirs

    def test_a_day_without_one_or_not_a_day(self):
        self.assertEqual(self.call("DELETE", f"/api/investments/{TODAY.isoformat()}", OWNER).status_code, 404)
        self.assertEqual(self.call("DELETE", "/api/investments/someday", OWNER).status_code, 400)


class SettingsTest(KiteDailyCase):
    def test_manual_until_changed(self):
        self.assertEqual(self.ok("GET", "/api/auth/me", OWNER)["settings"]["kite_valuation"], "manual")
        result = self.ok("PUT", "/api/me/settings", OWNER, {"kite_valuation": "daily"})
        self.assertEqual(result["settings"]["kite_valuation"], "daily")
        self.assertEqual(self.ok("GET", "/api/auth/me", OWNER)["settings"]["kite_valuation"], "daily")

    def test_only_manual_or_daily(self):
        self.assertEqual(self.call("PUT", "/api/me/settings", OWNER, {"kite_valuation": "hourly"}).status_code, 400)


class FundIsinTest(KiteDailyCase):
    def test_an_older_syncs_fund_is_found_by_its_name_and_nav(self):
        regular = scheme("122640", "Parag Parikh Flexi Cap Fund", "PPFAS Mutual Fund", "INF879O01019", 81.0)
        history = {"122639": 70.0, "122640": 64.0}    # what each was worth around the sync

        def past(code):
            days = [SYNCED - timedelta(days=n) for n in range(5, -1, -1)]
            return {d: history.get(code, 1.0) for d in days}, days
        with mock.patch.dict(NAVS, {"122640": regular}), \
                mock.patch.dict(funds_service._navs["by_isin"], {"INF879O01019": regular}), \
                mock.patch.object(funds_service, "nav_history", past):
            with self.app.app_context():
                db.session.add(MutualFundHolding(id=1, owner_email=OWNER, date=SYNCED, symbol="Parag Parikh Flexi Cap Fund",
                                                 quantity=1, average_price=60, nav=64.0, invested_value=60, current_value=64))
                db.session.commit()
            self.daily()
            self.ok("GET", "/api/investments", OWNER)
        self.assertEqual([(f.isin, f.nav) for f in self.rows(MutualFundHolding, repriced=True)], [("INF879O01019", 81.0)])


class PricesTest(unittest.TestCase):
    def test_nse_then_bse_then_without_the_series(self):
        self.assertEqual(kite_daily._tickers("IDEA-BE"), ["IDEA-BE.NS", "IDEA-BE.BO", "IDEA.NS", "IDEA.BO"])
        self.assertEqual(kite_daily._tickers("BAJAJ-AUTO"), ["BAJAJ-AUTO.NS", "BAJAJ-AUTO.BO"])
        with mock.patch.object(kite_daily, "_spark", quotes):
            self.assertEqual(kite_daily.stock_prices(["INFY", "IDEA-BE", "NOPE"]),
                             ({"INFY": 1600.0, "IDEA-BE": 7.5}, TRADED))

    def test_stale_until_the_closing_prices_are_in(self):
        monday = datetime(2026, 10, 19, 10, 0)
        self.assertTrue(kite_daily._stale(None, monday))
        self.assertFalse(kite_daily._stale(monday, monday + timedelta(minutes=10)))
        self.assertTrue(kite_daily._stale(monday, monday + timedelta(minutes=40)))
        self.assertFalse(kite_daily._stale(monday.replace(hour=16), monday.replace(hour=20)))
        self.assertTrue(kite_daily._stale(monday.replace(hour=16), monday + timedelta(days=1)))
        saturday = datetime(2026, 10, 24, 10, 0)
        self.assertFalse(kite_daily._stale(saturday, saturday.replace(hour=18)))


if __name__ == "__main__":
    unittest.main()
