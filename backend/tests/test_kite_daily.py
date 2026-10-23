"""Kite's holdings repriced each day (kite_daily.py), on Daily in Settings: the
last sync's holdings copied onto today at today's prices, until a real sync
replaces them. No network: Yahoo's prices and AMFI's NAVs are stand-ins.

    cd backend && python -m unittest tests.test_kite_daily
"""
import os
import sys
import unittest
from datetime import datetime, timedelta
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_funds_api import FRIEND, NAVS, OWNER, TODAY, ApiCase, scheme  # noqa: E402

import funds_service  # noqa: E402
import kite_daily  # noqa: E402
from blueprints import invest  # noqa: E402
from blueprints.auth import auth_bp  # noqa: E402
from extensions import db  # noqa: E402
from models import EquityHolding, MutualFundHolding, PortfolioSnapshot, UserSettings  # noqa: E402

SYNCED = TODAY - timedelta(days=2)
YAHOO = {"INFY.NS": 1600.0, "IDEA.BO": 7.5}


class KiteDailyCase(ApiCase):
    def setUp(self):
        super().setUp()
        self.app.register_blueprint(auth_bp)
        self.asked = []

        def spark(tickers):
            self.asked.append(list(tickers))
            return {t: YAHOO[t] for t in tickers if t in YAHOO}
        patch = mock.patch.object(kite_daily, "_spark", spark)
        patch.start()
        self.addCleanup(patch.stop)

    def daily(self, who=OWNER):
        self.ok("PUT", "/api/me/settings", who, {"kite_valuation": "daily"})

    def today(self, model, **filters):
        return self.rows(model, date=TODAY, **filters)


class RepriceTest(KiteDailyCase):
    def test_manual_leaves_the_last_sync_alone(self):
        self.kite_synced(OWNER, SYNCED)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual((self.today(EquityHolding), self.today(MutualFundHolding), self.asked), ([], [], []))

    def test_daily_copies_the_last_sync_onto_today_at_todays_prices(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        self.assertEqual((snap["date"], snap["inv_stocks"], snap["curr_stocks"]), (TODAY.isoformat(), 2000, 3200))
        self.assertEqual((snap["inv_mf"], snap["curr_mf"]), (100, 90.0))     # 1 unit at AMFI's 90
        stocks = self.ok("GET", f"/api/investments/{TODAY.isoformat()}/equity_holdings", OWNER)
        self.assertEqual([(s["symbol"], s["ltp"], s["quantity"]) for s in stocks], [("INFY", 1600.0, 2)])
        fund = self.today(MutualFundHolding)[0]
        self.assertEqual((fund.isin, fund.nav, fund.repriced), ("INF879O01027", 90.0, True))
        # The sync's own day is left as it was.
        self.assertEqual([e.ltp for e in self.rows(EquityHolding, date=SYNCED)], [1500])

    def test_a_second_look_soon_after_asks_for_nothing(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(len(self.asked), 1)
        self.assertEqual(len(self.today(EquityHolding)), 1)

    def test_each_day_carries_on_from_the_last(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        with self.app.app_context():   # that was yesterday's look; now today's
            for model in (EquityHolding, MutualFundHolding):
                for row in model.query.filter_by(date=TODAY).all():
                    row.date = TODAY - timedelta(days=1)
            PortfolioSnapshot.query.delete()
            settings = db.session.get(UserSettings, OWNER)
            settings.kite_priced_at = settings.kite_priced_at - timedelta(days=1)
            db.session.commit()
        YAHOO["INFY.NS"] = 1700.0
        self.addCleanup(YAHOO.__setitem__, "INFY.NS", 1600.0)
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        self.assertEqual((snap["date"], snap["curr_stocks"]), (TODAY.isoformat(), 3400))

    def test_a_sync_today_stands(self):
        self.kite_synced(OWNER, TODAY)
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(self.asked, [])
        self.assertEqual([e.repriced for e in self.today(EquityHolding)], [False])

    def test_nothing_priced_means_nothing_written(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily()
        with mock.patch.object(kite_daily, "_spark", lambda tickers: None), \
                mock.patch.object(kite_daily, "_fund_nav", lambda isin: None):
            self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(self.today(EquityHolding), [])
        self.ok("GET", "/api/investments", OWNER)     # back online: the next look does it
        self.assertEqual([e.ltp for e in self.today(EquityHolding)], [1600.0])

    def test_a_stock_yahoo_doesnt_know_keeps_its_price(self):
        self.kite_synced(OWNER, SYNCED)
        with self.app.app_context():
            db.session.add(EquityHolding(id=3, owner_email=OWNER, date=SYNCED, symbol="SGBMAR28-GB", quantity=1,
                                         average_price=5000, ltp=7000, invested_value=5000, current_value=7000))
            db.session.commit()
        self.daily()
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(sorted((e.symbol, e.ltp) for e in self.today(EquityHolding)),
                         [("INFY", 1600.0), ("SGBMAR28-GB", 7000)])

    def test_its_personal(self):
        self.kite_synced(OWNER, SYNCED)
        self.daily(who=FRIEND)
        self.ok("GET", "/api/investments", OWNER)
        self.assertEqual(self.today(EquityHolding), [])


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
        stocks = self.today(EquityHolding)
        self.assertEqual([(e.quantity, e.ltp, e.repriced) for e in stocks], [(3, 1650, False)])
        funds = self.today(MutualFundHolding)
        self.assertEqual([(f.quantity, f.isin, f.repriced) for f in funds], [(2, "INF879O01027", False)])
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        self.assertEqual((snap["curr_stocks"], snap["curr_mf"]), (4950, 182.0))


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
        self.assertEqual([(f.isin, f.nav) for f in self.today(MutualFundHolding)], [("INF879O01019", 81.0)])


class PricesTest(unittest.TestCase):
    def test_nse_then_bse_then_without_the_series(self):
        self.assertEqual(kite_daily._tickers("IDEA-BE"), ["IDEA-BE.NS", "IDEA-BE.BO", "IDEA.NS", "IDEA.BO"])
        self.assertEqual(kite_daily._tickers("BAJAJ-AUTO"), ["BAJAJ-AUTO.NS", "BAJAJ-AUTO.BO"])
        with mock.patch.object(kite_daily, "_spark", lambda tickers: {t: YAHOO[t] for t in tickers if t in YAHOO}):
            self.assertEqual(kite_daily.stock_prices(["INFY", "IDEA-BE", "NOPE"]), {"INFY": 1600.0, "IDEA-BE": 7.5})

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
