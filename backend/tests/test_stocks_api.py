"""Stocks and ETFs added by hand (stocks_service.py, blueprints/stocks.py): the
search, buys and sells at average cost, daily prices filed under the day they're
from, and how they join Kite's numbers. No network: NSE's list and the prices
are stand-ins.

    cd backend && python -m unittest tests.test_stocks_api
"""
import os
import sys
import unittest
from datetime import datetime, timedelta
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
import test_tenancy_api as people  # noqa: E402  (FRIEND: a member with their own data)
from flask import Flask  # noqa: E402

import funds_service  # noqa: E402
import kite_daily  # noqa: E402
import stocks_service  # noqa: E402
from blueprints.auth import auth_bp  # noqa: E402
from blueprints.invest import invest_bp  # noqa: E402
from blueprints.stocks import stocks_bp  # noqa: E402
from extensions import db  # noqa: E402
from models import EquityHolding, StockValue, UserSettings  # noqa: E402

OWNER, FRIEND = setup.OWNER, people.FRIEND
TODAY = funds_service.ist_today()
LISTED = [
    {"symbol": "INFY", "name": "Infosys Limited", "isin": "INE009A01021"},
    {"symbol": "TCS", "name": "Tata Consultancy Services Limited", "isin": "INE467B01029"},
    {"symbol": "NIFTYBEES", "name": "Nifty 50", "isin": "INF204KB14I2"},
    {"symbol": "INFIBEAM", "name": "Infibeam Avenues Limited", "isin": "INE483S01020"},
]


class StocksCase(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        for bp in (invest_bp, stocks_bp, auth_bp):
            self.app.register_blueprint(bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()
        self.prices = {"INFY": 1600.0, "TCS": 3500.0, "NIFTYBEES": 280.0}
        self.traded = datetime.combine(TODAY, datetime.min.time()).replace(hour=10)
        for patch in (
            mock.patch.dict(stocks_service._list, {"at": 10**12, "rows": LISTED}),
            mock.patch.object(kite_daily, "stock_prices", lambda symbols: (
                {s: self.prices[s] for s in symbols if s in self.prices}, self.traded)),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, body=None, who=FRIEND):
        return self.client.open(path, method=method, json=body, headers={"Authorization": f"Bearer {setup._token(who)}"})

    def ok(self, method, path, body=None, who=FRIEND):
        resp = self.call(method, path, body, who)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def buy(self, symbol, quantity, price, day=None, who=FRIEND):
        return self.ok("POST", "/api/stocks", {"symbol": symbol, "quantity": quantity, "price": price,
                                               **({"date": day.isoformat()} if day else {})}, who)

    def stock(self, symbol, who=FRIEND):
        return next(s for s in self.ok("GET", "/api/stocks", who=who)["stocks"] if s["symbol"] == symbol)


class StocksApiTest(StocksCase):
    def test_search_finds_by_symbol_first_then_name(self):
        results = self.ok("GET", "/api/stocks/search?q=inf")["results"]
        self.assertEqual([r["symbol"] for r in results][:2], ["INFIBEAM", "INFY"])
        self.assertEqual(self.ok("GET", "/api/stocks/search?q=INFY")["results"][0]["symbol"], "INFY")
        self.assertEqual([r["symbol"] for r in self.ok("GET", "/api/stocks/search?q=tata consultancy")["results"]], ["TCS"])

    def test_a_buy_is_valued_and_joins_the_portfolio(self):
        result = self.buy("INFY", 10, 1400)
        row = result["stocks"][0]
        self.assertEqual((row["symbol"], row["quantity"], row["invested"], row["avg_price"], row["price"], row["value"]),
                         ("INFY", 10, 14000, 1400, 1600, 16000))
        snap = self.ok("GET", "/api/investments")[0]
        self.assertEqual((snap["date"], snap["inv_stocks"], snap["curr_stocks"]), (TODAY.isoformat(), 14000, 16000))
        holdings = self.ok("GET", f"/api/investments/{TODAY.isoformat()}/equity_holdings")
        self.assertEqual([(h["symbol"], h["quantity"], h["ltp"]) for h in holdings], [("INFY", 10, 1600)])
        self.assertEqual(self.ok("GET", "/api/assets/list")["EQUITY"], ["INFY"])
        self.assertEqual([(p["Current"], p["Invested"]) for p in self.ok("GET", "/api/investments/history?symbol=INFY&type=EQUITY")],
                         [(16000, 14000)])
        self.assertEqual([e["symbol"] for e in self.ok("GET", "/api/equity")], ["INFY"])

    def test_buys_and_sells_at_average_cost(self):
        self.buy("INFY", 10, 1400, TODAY - timedelta(days=30))
        self.ok("POST", "/api/stocks/INFY/trades", {"kind": "BUY", "quantity": 10, "price": 1600, "date": (TODAY - timedelta(days=10)).isoformat()})
        self.ok("POST", "/api/stocks/INFY/trades", {"kind": "SELL", "quantity": 5, "price": 1700})
        infy = self.stock("INFY")
        self.assertEqual((infy["quantity"], infy["invested"], infy["avg_price"]), (15, 22500, 1500))
        self.assertEqual([t["kind"] for t in infy["trades"]], ["SELL", "BUY", "BUY"])   # newest first
        too_many = self.call("POST", "/api/stocks/INFY/trades", {"kind": "SELL", "quantity": 16, "price": 1700})
        self.assertEqual(too_many.status_code, 400)
        # A sale back-dated to before the shares were bought can't be.
        early = self.call("POST", "/api/stocks/INFY/trades", {"kind": "SELL", "quantity": 1, "price": 1, "date": (TODAY - timedelta(days=40)).isoformat()})
        self.assertEqual(early.status_code, 400)
        self.assertEqual(self.stock("INFY")["quantity"], 15)

    def test_a_trade_entered_by_mistake_goes(self):
        self.buy("TCS", 2, 3000)
        wrong = self.ok("POST", "/api/stocks/TCS/trades", {"kind": "BUY", "quantity": 200, "price": 3000})
        mistake = next(t for s in wrong["stocks"] for t in s["trades"] if t["quantity"] == 200)
        self.ok("DELETE", f"/api/stocks/TCS/trades/{mistake['id']}")
        self.assertEqual(self.stock("TCS")["quantity"], 2)
        # The last one goes with the stock.
        only = self.stock("TCS")["trades"][0]
        self.assertEqual(self.ok("DELETE", f"/api/stocks/TCS/trades/{only['id']}")["stocks"], [])

    def test_selling_everything_leaves_nothing_behind_on_later_days(self):
        self.buy("NIFTYBEES", 100, 250, TODAY - timedelta(days=5))
        self.ok("POST", "/api/stocks/NIFTYBEES/trades", {"kind": "SELL", "quantity": 100, "price": 280})
        snap = self.ok("GET", "/api/investments")[0]
        self.assertEqual((snap["inv_stocks"], snap["curr_stocks"]), (0, 0))
        self.assertEqual(self.ok("GET", f"/api/investments/{TODAY.isoformat()}/equity_holdings"), [])
        self.assertEqual(self.stock("NIFTYBEES")["quantity"], 0)

    def test_removing_takes_its_history(self):
        self.buy("INFY", 1, 1000)
        self.ok("DELETE", "/api/stocks/INFY")
        self.assertEqual(self.ok("GET", "/api/stocks")["stocks"], [])
        self.assertEqual(self.ok("GET", "/api/investments/history?symbol=INFY&type=EQUITY"), [])
        self.assertEqual(self.ok("GET", "/api/investments")[0]["curr_stocks"], 0)

    def test_what_cant_be_added(self):
        self.assertEqual(self.call("POST", "/api/stocks", {"symbol": "NOPE", "quantity": 1, "price": 1}).status_code, 400)
        for body in ({"quantity": 0, "price": 1}, {"quantity": 1, "price": 0}, {"quantity": "x", "price": 1},
                     {"quantity": 1, "price": 1, "date": (TODAY + timedelta(days=1)).isoformat()}):
            self.assertEqual(self.call("POST", "/api/stocks", {"symbol": "INFY", **body}).status_code, 400, body)
        self.assertEqual(self.ok("GET", "/api/stocks")["stocks"], [])

    def test_a_stock_kite_tracks_isnt_added_again(self):
        with self.app.app_context():
            db.session.add(EquityHolding(id=1, owner_email=OWNER, date=TODAY, symbol="INFY", quantity=1, average_price=1,
                                         ltp=1, invested_value=1, current_value=1))
            db.session.commit()
        self.assertEqual(self.call("POST", "/api/stocks", {"symbol": "INFY", "quantity": 1, "price": 1}, who=OWNER).status_code, 409)
        self.buy("INFY", 1, 1000)    # someone else's Kite doesn't count

    def test_each_persons_own(self):
        self.buy("INFY", 1, 1000)
        self.assertEqual(self.ok("GET", "/api/stocks", who=OWNER)["stocks"], [])


class PricingTest(StocksCase):
    def test_prices_are_filed_under_the_day_they_traded(self):
        self.buy("INFY", 10, 1400, TODAY - timedelta(days=7))
        with self.app.app_context():
            from flask import g
            with self.app.test_request_context():
                g.data_owner = FRIEND
                StockValue.query.delete()
                db.session.get(UserSettings, FRIEND).stocks_priced_at = None   # last priced long ago
                db.session.commit()
        # The market's last close is from an earlier day (a weekend, say): that day's record.
        self.traded = self.traded - timedelta(days=2)
        self.prices["INFY"] = 1650.0
        self.ok("GET", "/api/investments?refresh=1")
        days = {s["date"]: s["curr_stocks"] for s in self.ok("GET", "/api/investments")}
        self.assertEqual(days.get(self.traded.date().isoformat()), 16500)

    def test_the_price_time_shows_without_kite(self):
        self.buy("INFY", 1, 1000)
        times = self.ok("GET", "/api/investments/prices")
        self.assertEqual((times["mode"], times["stocks_at"]), ("daily", self.traded.isoformat()))

    def test_offline_keeps_what_was_filed(self):
        self.buy("INFY", 10, 1400)
        self.prices.clear()
        self.ok("GET", "/api/investments?refresh=1")
        self.assertEqual(self.stock("INFY")["price"], 1600)


if __name__ == "__main__":
    unittest.main()
