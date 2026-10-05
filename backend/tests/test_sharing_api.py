"""Sharing (view-only) and asking to join: API tests on a throwaway in-memory
SQLite database, with the routines tests' isolated setup.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import types
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
import test_tenancy_api as tenancy  # noqa: E402,F401  (adds FRIEND and ADMIN people)
from flask import Flask  # noqa: E402

sys.modules["firebase_admin"].messaging = types.SimpleNamespace()

import access  # noqa: E402
import extensions  # noqa: E402
from extensions import db  # noqa: E402

# create_all already makes the columns; the Postgres-only bootstrap can't run on SQLite.
access._schema_ready = True
from models import AccessRequest, AllowedEmail  # noqa: E402
import blueprints.money as money  # noqa: E402
from blueprints.money_query import money_query_bp  # noqa: E402
from blueprints.invest import invest_bp  # noqa: E402
from blueprints.auth import auth_bp  # noqa: E402
from blueprints.admin import admin_bp  # noqa: E402
from blueprints.routines import routines_bp  # noqa: E402

OWNER, FRIEND, ADMIN = setup.OWNER, tenancy.FRIEND, tenancy.ADMIN


class SharingApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        for bp in (money.money_bp, money_query_bp, invest_bp, auth_bp, admin_bp, routines_bp):
            self.app.register_blueprint(bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, who, body=None, view_as=None):
        headers = {"Authorization": f"Bearer {setup._token(who)}"}
        if view_as:
            headers["X-View-As"] = view_as
        return self.client.open(path, method=method, json=body, headers=headers)

    def ok(self, method, path, who, body=None, view_as=None):
        resp = self.call(method, path, who, body, view_as)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def owner_has_money(self):
        self.ok("POST", "/api/accounts", OWNER, {"name": "KOTAK", "type": "savings", "balance": 1000})
        self.ok("POST", "/api/transactions", OWNER, {
            "account": "KOTAK", "date": "2026-09-05", "type": "Debit", "heading": "Food", "amount": 100})

    def share(self, modules, viewer=FRIEND):
        return self.ok("PUT", f"/api/shares/{viewer}", OWNER, {"modules": modules})

    # ---- viewing ----
    def test_a_friend_sees_only_what_was_shared(self):
        self.owner_has_money()
        self.assertEqual(self.call("GET", "/api/accounts", FRIEND, view_as=OWNER).status_code, 403)

        self.share(["money"])
        accounts = self.ok("GET", "/api/accounts", FRIEND, view_as=OWNER)
        self.assertEqual([(a["account"], a["balance"]) for a in accounts], [("KOTAK", 900)])
        self.assertEqual(len(self.ok("GET", "/api/transactions", FRIEND, view_as=OWNER)["transactions"]), 1)
        # Investments weren't shared.
        self.assertEqual(self.call("GET", "/api/investments", FRIEND, view_as=OWNER).status_code, 403)
        # Their own view is still their own, and empty.
        self.assertEqual(self.ok("GET", "/api/accounts", FRIEND), [])

    def test_viewing_is_read_only(self):
        self.owner_has_money()
        self.share(["money"])
        tx = self.ok("GET", "/api/transactions", OWNER)["transactions"][0]
        attempts = [
            ("POST", "/api/transactions", {"account": "KOTAK", "date": "2026-09-06", "type": "Debit", "heading": "x", "amount": 1}),
            ("PUT", f"/api/transactions/{tx['id']}", {"account": "KOTAK", "date": "2026-09-05", "type": "Debit", "heading": "Food", "amount": 1}),
            ("DELETE", f"/api/transactions/{tx['id']}", None),
            ("PUT", "/api/accounts", {"account": "KOTAK", "balance": 1}),
            ("POST", "/api/accounts", {"name": "NEW", "type": "savings"}),
            ("PUT", "/api/budgets", {"category": "Food", "monthly_limit": 1}),
        ]
        for method, path, body in attempts:
            self.assertEqual(self.call(method, path, FRIEND, body, view_as=OWNER).status_code, 403, (method, path))
        self.assertEqual(self.ok("GET", "/api/accounts", OWNER)[0]["balance"], 900)
        self.assertEqual(len(self.ok("GET", "/api/transactions", OWNER)["transactions"]), 1)

    def test_the_money_page_loads_while_viewing(self):
        # Its table and analyzer read through POST (the filters ride in the body).
        self.owner_has_money()
        self.share(["money"])
        rows = self.ok("POST", "/api/transactions/query", FRIEND, {}, view_as=OWNER)
        self.assertTrue(rows["success"], rows)
        self.assertTrue(self.ok("POST", "/api/money/analyze", FRIEND, {}, view_as=OWNER)["success"])

    def test_shared_routines_are_visible(self):
        self.ok("POST", "/api/routines", OWNER, {"name": "Gym", "schedule": "daily", "start_date": "2026-09-01"})
        self.assertEqual(self.call("GET", "/api/routines", FRIEND, view_as=OWNER).status_code, 403)
        self.share(["gym"])
        names = [r["name"] for r in self.ok("GET", "/api/routines", FRIEND, view_as=OWNER)["routines"]]
        self.assertEqual(names, ["Gym"])
        self.assertEqual(self.ok("GET", "/api/routines", FRIEND)["routines"], [])

    def test_me_says_what_is_shared_and_what_is_being_viewed(self):
        self.share(["money", "invest"])
        me = self.ok("GET", "/api/auth/me", FRIEND)
        self.assertEqual(me["shared_with_me"], [{"owner": OWNER, "modules": ["money", "invest"]}])
        self.assertIsNone(me["access"]["viewing"])

        viewing = self.ok("GET", "/api/auth/me", FRIEND, view_as=OWNER)["access"]
        self.assertEqual(viewing["viewing"], OWNER)
        self.assertEqual(viewing["email"], FRIEND)
        self.assertFalse(viewing["isOwner"])
        self.assertFalse(viewing["isAdmin"])
        self.assertEqual(viewing["modules"], {"money": "view", "gym": "none", "invest": "view", "sabdekho": "none"})

    def test_the_owners_own_features_stay_theirs(self):
        self.share(["money", "invest"])
        self.assertEqual(self.call("GET", "/api/sync/check-transactions", FRIEND, view_as=OWNER).status_code, 403)
        self.assertEqual(self.call("GET", "/api/admin/users", FRIEND, view_as=OWNER).status_code, 403)

    def test_stopping_a_share(self):
        self.owner_has_money()
        self.share(["money"])
        self.ok("DELETE", f"/api/shares/{FRIEND}", OWNER)
        self.assertEqual(self.call("GET", "/api/accounts", FRIEND, view_as=OWNER).status_code, 403)
        self.assertEqual(self.ok("GET", "/api/auth/me", FRIEND)["shared_with_me"], [])
        # Sharing nothing is the same as stopping.
        self.share(["money"])
        self.share([])
        self.assertEqual(self.ok("GET", "/api/shares", OWNER)["mine"], [])

    def test_managing_shares(self):
        self.assertEqual(self.call("PUT", f"/api/shares/{OWNER}", OWNER, {"modules": ["money"]}).status_code, 400)
        self.assertEqual(self.call("PUT", "/api/shares/not-an-email", OWNER, {"modules": ["money"]}).status_code, 400)
        self.share(["money", "bogus", "gym"])
        self.assertEqual(self.ok("GET", "/api/shares", OWNER)["mine"], [{"viewer": FRIEND, "modules": ["money", "gym"]}])
        self.assertEqual(self.ok("GET", "/api/shares", FRIEND)["with_me"], [{"owner": OWNER, "modules": ["money", "gym"]}])
        # Nobody can change shares while viewing someone else's data.
        self.assertEqual(self.call("PUT", f"/api/shares/{ADMIN}", FRIEND, {"modules": ["money"]}, view_as=OWNER).status_code, 403)

    # ---- asking to join ----
    def test_an_unknown_person_asks_to_join_and_an_admin_approves(self):
        extensions.firebase_auth.verify_id_token = lambda token, **kw: {"email": "Stranger@Test.dev", "name": "Stranger"}
        resp = self.client.post("/api/auth/firebase-login", json={"id_token": "x"})
        self.assertEqual((resp.status_code, resp.get_json()["code"]), (403, "REQUESTED"))

        people = self.ok("GET", "/api/admin/users", ADMIN)
        self.assertEqual([(r["email"], r["name"]) for r in people["requests"]], [("stranger@test.dev", "Stranger")])
        self.assertEqual(self.call("GET", "/api/admin/users", FRIEND).status_code, 403)

        self.ok("POST", "/api/admin/requests/stranger@test.dev/approve", ADMIN)
        with self.app.app_context():
            self.assertIsNotNone(db.session.get(AllowedEmail, "stranger@test.dev"))
            self.assertIsNone(db.session.get(AccessRequest, "stranger@test.dev"))
        self.assertEqual(self.ok("GET", "/api/admin/users", ADMIN)["requests"], [])

    def test_declining_a_request(self):
        extensions.firebase_auth.verify_id_token = lambda token, **kw: {"email": "nope@test.dev"}
        self.client.post("/api/auth/firebase-login", json={"id_token": "x"})
        self.ok("DELETE", "/api/admin/requests/nope@test.dev", ADMIN)
        self.assertEqual(self.ok("GET", "/api/admin/users", ADMIN)["requests"], [])


if __name__ == "__main__":
    unittest.main()
