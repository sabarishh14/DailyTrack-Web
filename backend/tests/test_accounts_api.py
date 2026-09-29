"""API tests for adding accounts (POST /api/accounts in blueprints/money.py), on a
throwaway in-memory SQLite database with the routines tests' isolated setup:
no .env, dummy secrets, stubbed Firebase.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
from flask import Flask  # noqa: E402

# The money blueprint sends low-balance pushes; nothing here sends one.
sys.modules["firebase_admin"].messaging = types.SimpleNamespace()

from blueprints.money import money_bp  # noqa: E402
from extensions import db  # noqa: E402

OWNER = setup.OWNER                      # full money access
SCOPED = "scoped@test.dev"               # money edit, but only some categories
READER = "reader@test.dev"               # money view only
setup._PERMISSIONS[SCOPED] = {"modules": {"money": "edit"}, "money_scope": {"categories": ["Food"]}}
setup._PERMISSIONS[READER] = {"modules": {"money": "view"}}


class AccountsApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(money_bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def add(self, email=OWNER, **body):
        return self.client.post("/api/accounts", json=body, headers={"Authorization": f"Bearer {setup._token(email)}"})

    def accounts(self):
        resp = self.client.get("/api/accounts", headers={"Authorization": f"Bearer {setup._token(OWNER)}"})
        return {a["account"]: a for a in resp.get_json()}

    def test_a_savings_account_tracks_its_balance_and_floor(self):
        resp = self.add(name="  hdfc   bank ", type="savings", balance="1500.456", min_balance=1000)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        account = resp.get_json()["account"]
        self.assertEqual(account["account"], "hdfc bank")
        self.assertTrue(account["balance_tracked"])
        self.assertAlmostEqual(account["balance"], 1500.46)
        self.assertEqual(account["min_balance"], 1000)
        self.assertIn("hdfc bank", self.accounts())

    def test_a_savings_account_needs_no_balance_or_floor(self):
        account = self.add(name="Cash", type="savings", balance="", min_balance=None).get_json()["account"]
        self.assertEqual((account["balance"], account["min_balance"]), (0, None))

    def test_a_credit_card_is_named_cc_and_left_untracked(self):
        for typed, expected in [("AXIS REWARDS", "CC-AXIS REWARDS"), ("cc sbi 1234", "CC-sbi 1234"), ("CC-HDFC", "CC-HDFC")]:
            with self.subTest(typed=typed):
                resp = self.add(name=typed, type="credit_card", balance=5000, min_balance=100)
                self.assertEqual(resp.status_code, 200, resp.get_json())
                account = resp.get_json()["account"]
                self.assertEqual(account["account"], expected)
                self.assertFalse(account["balance_tracked"])
                self.assertEqual((account["balance"], account["min_balance"]), (0, None))

    def test_names_are_unique_whatever_the_case(self):
        self.add(name="KOTAK", type="savings")
        resp = self.add(name="kotak", type="savings")
        self.assertEqual(resp.status_code, 409)
        self.assertIn("KOTAK", resp.get_json()["message"])
        self.add(name="AXIS", type="credit_card")
        self.assertEqual(self.add(name="cc-axis", type="credit_card").status_code, 409)

    def test_bad_input_is_refused(self):
        bad = [
            {"name": "X", "type": "current"},
            {"name": "", "type": "savings"},
            {"name": "CC Cheat", "type": "savings"},
            {"name": "cc-", "type": "credit_card"},
            {"name": "x" * 51, "type": "savings"},
            {"name": "Y", "type": "savings", "balance": "lots"},
            {"name": "Y", "type": "savings", "min_balance": -5},
            {"name": "Y", "type": "savings", "balance": "nan"},
        ]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(self.add(**body).status_code, 400)
        self.assertEqual(self.accounts(), {})

    def test_only_full_money_access_can_add(self):
        self.assertEqual(self.add(SCOPED, name="Z", type="savings").status_code, 403)
        self.assertEqual(self.add(READER, name="Z", type="savings").status_code, 403)
        self.assertEqual(self.accounts(), {})


if __name__ == "__main__":
    unittest.main()
