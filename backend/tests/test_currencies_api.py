"""Accounts in other currencies (currencies.py, blueprints/money.py): entered in
the account's currency, stored in rupees too, on a throwaway in-memory SQLite
database with the routines tests' isolated setup. Rates are stubbed: nothing
here reaches the rates source.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import types
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
import pytz  # noqa: E402
from flask import Flask  # noqa: E402

sys.modules["firebase_admin"].messaging = types.SimpleNamespace()

import currencies  # noqa: E402
from blueprints.money import money_bp  # noqa: E402
from extensions import db  # noqa: E402

OWNER = setup.OWNER
TODAY = datetime.now(pytz.timezone("Asia/Kolkata")).date().isoformat()


class CurrenciesApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(money_bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()
        self.set_rates({"USD": 90.0, "AED": 25.0})
        self.addCleanup(self.restore_rates, currencies._fetch)
        self.ok("POST", "/api/accounts", {"name": "WISE", "type": "savings", "balance": 100, "currency": "usd"})
        self.ok("POST", "/api/accounts", {"name": "KOTAK", "type": "savings", "balance": 5000})

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def set_rates(self, rates):
        currencies._fetch = lambda: {**rates, "INR": 1.0}
        currencies._cached.update(at=0.0, rates=None)

    def restore_rates(self, fetch):
        currencies._fetch = fetch
        currencies._cached.update(at=0.0, rates=None)

    def call(self, method, path, body=None):
        return self.client.open(path, method=method, json=body,
                                headers={"Authorization": f"Bearer {setup._token(OWNER)}"})

    def ok(self, method, path, body=None):
        resp = self.call(method, path, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def spend(self, amount, account="WISE", kind="Debit"):
        return self.call("POST", "/api/transactions", {
            "account": account, "date": TODAY, "type": kind, "heading": "Food", "amount": amount})

    def accounts(self):
        return {a["account"]: a for a in self.ok("GET", "/api/accounts")}

    def transactions(self):
        return {t["id"]: t for t in self.ok("GET", "/api/transactions")["transactions"]}

    def only_transaction(self):
        (tx,) = self.transactions().values()
        return tx

    def edit(self, tx, **changes):
        body = {k: tx[k] for k in ("account", "date", "type", "heading", "description", "amount")}
        return self.ok("PUT", f"/api/transactions/{tx['id']}", {**body, **changes})

    def test_a_spend_is_entered_in_the_accounts_currency_and_stored_in_rupees(self):
        self.assertEqual(self.spend(10).status_code, 200)
        tx = self.only_transaction()
        self.assertEqual((tx["amount"], tx["original_amount"], tx["currency"]), (900, 10, "USD"))
        wise = self.accounts()["WISE"]
        self.assertEqual((wise["currency"], wise["balance"], wise["balance_inr"]), ("USD", 90, 8100))
        kotak = self.accounts()["KOTAK"]
        self.assertEqual((kotak["currency"], kotak["balance_inr"]), ("INR", 5000))

    def test_rupee_accounts_are_as_they_were(self):
        self.spend(250, account="KOTAK")
        tx = self.only_transaction()
        self.assertEqual((tx["amount"], tx["original_amount"], tx["currency"]), (250, None, None))
        self.assertEqual(self.accounts()["KOTAK"]["balance"], 4750)

    def test_an_edit_keeps_the_rate_it_was_stored_at(self):
        self.spend(10)
        self.set_rates({"USD": 95.0})
        self.edit(self.only_transaction(), amount=20)
        tx = self.only_transaction()
        self.assertEqual((tx["amount"], tx["original_amount"]), (1800, 20))
        self.assertEqual(self.accounts()["WISE"]["balance"], 80)

    def test_an_older_app_sending_back_the_rupees_it_showed_changes_nothing(self):
        self.spend(10)
        self.edit(self.only_transaction(), description="lunch")   # amount: the 900 it was shown
        tx = self.only_transaction()
        self.assertEqual((tx["amount"], tx["original_amount"], tx["description"]), (900, 10, "lunch"))
        self.assertEqual(self.accounts()["WISE"]["balance"], 90)

    def test_moving_one_to_a_rupee_account_takes_the_amount_as_rupees(self):
        self.spend(10)
        self.edit(self.only_transaction(), account="KOTAK", amount=900)
        tx = self.only_transaction()
        self.assertEqual((tx["amount"], tx["original_amount"], tx["currency"]), (900, None, None))
        accounts = self.accounts()
        self.assertEqual((accounts["WISE"]["balance"], accounts["KOTAK"]["balance"]), (100, 4100))

    def test_deleting_one_gives_back_what_it_took(self):
        self.spend(10)
        self.ok("DELETE", f"/api/transactions/{self.only_transaction()['id']}")
        self.assertEqual(self.accounts()["WISE"]["balance"], 100)

    def test_a_card_in_another_currency_counts_its_use_in_it(self):
        self.ok("POST", "/api/accounts", {"name": "AMEX", "type": "credit_card", "currency": "AED", "monthly_budget": 100})
        self.spend(60, account="CC-AMEX")
        self.spend(10, account="CC-AMEX", kind="Credit")
        card = self.accounts()["CC-AMEX"]
        self.assertEqual((card["used_this_month"], card["monthly_budget"], card["currency"]), (50, 100, "AED"))

    def test_without_a_rate_nothing_is_saved(self):
        def offline():
            raise OSError("no network")
        currencies._fetch = offline
        currencies._cached.update(at=0.0, rates=None)
        resp = self.spend(10)
        self.assertEqual((resp.status_code, resp.get_json()["code"]), (503, "NO_RATE"))
        self.assertEqual(self.transactions(), {})
        self.assertEqual(self.accounts()["WISE"]["balance"], 100)

    def test_the_last_rates_stand_when_the_source_fails(self):
        currencies.rates()                       # fetched once
        currencies._fetch = lambda: (_ for _ in ()).throw(OSError("down"))
        currencies._cached["at"] = 0.0           # due again, and the source fails
        self.assertEqual(currencies.rate("USD"), 90.0)

    def test_only_listed_currencies(self):
        resp = self.call("POST", "/api/accounts", {"name": "ODD", "type": "savings", "currency": "XYZ"})
        self.assertEqual(resp.status_code, 400)

    def test_the_currency_can_change_only_before_anything_is_entered(self):
        self.ok("PUT", "/api/accounts", {"account": "WISE", "currency": "AED"})
        self.assertEqual(self.accounts()["WISE"]["currency"], "AED")
        self.spend(10)
        self.assertEqual(self.call("PUT", "/api/accounts", {"account": "WISE", "currency": "USD"}).status_code, 400)

    def test_money_in_its_currency(self):
        self.assertEqual((currencies.money(1250), currencies.money(12.5, "USD"), currencies.money(40, "AED")),
                         ("₹1,250", "$12.50", "AED 40"))


if __name__ == "__main__":
    unittest.main()
