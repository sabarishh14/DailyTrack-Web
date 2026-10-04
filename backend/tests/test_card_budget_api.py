"""Credit cards: what's been used this month and a monthly budget for it (in
blueprints/money.py), on a throwaway in-memory SQLite database with the
routines tests' isolated setup.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import types
import unittest
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
import pytz  # noqa: E402
from flask import Flask  # noqa: E402

sys.modules["firebase_admin"].messaging = types.SimpleNamespace()

import push  # noqa: E402
from blueprints.money import money_bp  # noqa: E402
from extensions import db  # noqa: E402
from models import DeviceToken  # noqa: E402

OWNER = setup.OWNER
TODAY = datetime.now(pytz.timezone("Asia/Kolkata")).date()
LAST_MONTH = TODAY.replace(day=1) - timedelta(days=1)


class CardBudgetApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(money_bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()
        self.ok("POST", "/api/accounts", {"name": "AXIS", "type": "credit_card"})
        self.ok("POST", "/api/accounts", {"name": "KOTAK", "type": "savings", "balance": 5000})

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, body=None):
        return self.client.open(path, method=method, json=body,
                                headers={"Authorization": f"Bearer {setup._token(OWNER)}"})

    def ok(self, method, path, body=None):
        resp = self.call(method, path, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def spend(self, amount, account="CC-AXIS", when=TODAY, kind="Debit"):
        return self.ok("POST", "/api/transactions", {
            "account": account, "date": when.isoformat(), "type": kind, "heading": "Food", "amount": amount})

    def accounts(self):
        return {a["account"]: a for a in self.ok("GET", "/api/accounts")}

    def test_used_this_month_counts_this_months_spends_less_refunds(self):
        self.spend(1200)
        self.spend(300)
        self.spend(200, kind="Credit")          # a refund on the card
        self.spend(9999, when=LAST_MONTH)       # last month's bill doesn't count
        self.spend(500, account="KOTAK")        # nor does a savings account
        accounts = self.accounts()
        self.assertEqual(accounts["CC-AXIS"]["used_this_month"], 1300)
        self.assertEqual(accounts["CC-AXIS"]["balance"], 0)  # cards still keep no balance
        self.assertIsNone(accounts["KOTAK"]["used_this_month"])
        self.assertEqual(accounts["KOTAK"]["balance"], 4500)

    def test_a_card_with_more_refunds_than_spends_has_used_nothing(self):
        self.spend(100)
        self.spend(400, kind="Credit")
        self.assertEqual(self.accounts()["CC-AXIS"]["used_this_month"], 0)

    def test_setting_and_clearing_a_monthly_budget(self):
        self.ok("PUT", "/api/accounts", {"account": "CC-AXIS", "monthly_budget": 20000})
        self.assertEqual(self.accounts()["CC-AXIS"]["monthly_budget"], 20000)
        self.ok("PUT", "/api/accounts", {"account": "CC-AXIS", "monthly_budget": None})
        self.assertIsNone(self.accounts()["CC-AXIS"]["monthly_budget"])

    def test_only_cards_take_a_positive_budget(self):
        self.assertEqual(self.call("PUT", "/api/accounts", {"account": "KOTAK", "monthly_budget": 100}).status_code, 400)
        self.assertEqual(self.call("PUT", "/api/accounts", {"account": "CC-AXIS", "monthly_budget": 0}).status_code, 400)
        self.assertEqual(self.call("PUT", "/api/accounts", {"account": "CC-AXIS", "monthly_budget": "lots"}).status_code, 400)

    def test_a_new_card_can_start_with_a_budget(self):
        card = self.ok("POST", "/api/accounts", {"name": "HDFC", "type": "credit_card", "monthly_budget": 15000})["account"]
        self.assertEqual((card["account"], card["monthly_budget"], card["used_this_month"]), ("CC-HDFC", 15000, 0))

    def test_adding_a_spend_reports_the_card_and_alerts_once_over_budget(self):
        self.ok("PUT", "/api/accounts", {"account": "CC-AXIS", "monthly_budget": 1000})
        sent = []
        original_send, original_threading = push._send, push.threading
        push._send = lambda app, tokens, kind, title, body: sent.append((kind, title, body))
        push.threading = types.SimpleNamespace(
            Thread=lambda target, args, daemon: types.SimpleNamespace(start=lambda: target(*args)))
        try:
            with self.app.app_context():
                db.session.add(DeviceToken(token="phone", email=OWNER))
                db.session.commit()
            under = self.spend(600)
            over = self.spend(700)
        finally:
            push._send, push.threading = original_send, original_threading

        self.assertEqual(under["cards"], [{"account": "CC-AXIS", "before": 0, "after": 600,
                                            "monthly_budget": 1000, "over_budget": False}])
        self.assertEqual(under["balances"], [])  # older apps read balances as money left
        self.assertTrue(over["cards"][0]["over_budget"])
        self.assertEqual(sent, [("card_budget", "CC-AXIS is over its monthly budget",
                                 "CC-AXIS: ₹1,300 used · ₹300 over ₹1,000")])


if __name__ == "__main__":
    unittest.main()
