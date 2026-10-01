"""Each person's data is their own: API tests with two (and more) people on one
throwaway in-memory SQLite database, using the routines tests' isolated setup.

Nothing of one person's may show up for, or be changed by, another; the owner's
own features (Sheets, Drive OCR, Kite, Nagapandi) stay the owner's.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import types
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
from flask import Flask, g  # noqa: E402

sys.modules["firebase_admin"].messaging = types.SimpleNamespace()

import access  # noqa: E402
import push  # noqa: E402
from access import Access, FULL_EDIT_PERMISSIONS  # noqa: E402
from extensions import db  # noqa: E402
from models import DeviceToken, Transaction  # noqa: E402
import blueprints.money as money  # noqa: E402
from blueprints.money_query import money_query_bp  # noqa: E402
from blueprints.media import media_bp  # noqa: E402
from blueprints.invest import invest_bp  # noqa: E402
from blueprints.activities import activities_bp  # noqa: E402
from blueprints.auth import auth_bp  # noqa: E402
from blueprints import chat  # noqa: E402

OWNER = setup.OWNER
FRIEND = "friend@test.dev"     # a member: their own data, nothing else
ADMIN = "admin@test.dev"       # manages people, but sees only their own data

_previous_get_access = access.get_access


def _get_access(email):
    email = (email or "").strip().lower()
    if email == FRIEND:
        return Access(email, "member", FULL_EDIT_PERMISSIONS)
    if email == ADMIN:
        return Access(email, "admin")
    return _previous_get_access(email)


access.get_access = _get_access


class TenancyApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        for bp in (money.money_bp, money_query_bp, media_bp, invest_bp, activities_bp, auth_bp, chat.chat_bp):
            self.app.register_blueprint(bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, who, body=None):
        return self.client.open(path, method=method, json=body,
                                headers={"Authorization": f"Bearer {setup._token(who)}"})

    def ok(self, method, path, who, body=None):
        resp = self.call(method, path, who, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        body = resp.get_json()
        # Some endpoints report failure as 200 + success: false.
        self.assertIsNot(body.get("success") if isinstance(body, dict) else None, False, body)
        return body

    def account(self, who, name="KOTAK", balance=1000):
        self.ok("POST", "/api/accounts", who, {"name": name, "type": "savings", "balance": balance})

    def spend(self, who, amount=100, heading="Food", account="KOTAK", **extra):
        return self.ok("POST", "/api/transactions", who, {
            "account": account, "date": "2026-09-05", "type": "Debit", "heading": heading,
            "description": f"{who} spend", "amount": amount, **extra})

    def balances(self, who):
        return {a["account"]: a["balance"] for a in self.ok("GET", "/api/accounts", who)}

    def transactions(self, who):
        return self.ok("GET", "/api/transactions", who)["transactions"]

    # ---- money ----
    def test_money_is_only_ever_your_own(self):
        self.account(OWNER)
        self.spend(OWNER, heading="Rent")
        self.ok("PUT", "/api/budgets", OWNER, {"category": "Rent", "monthly_limit": 9000})

        self.assertEqual(self.ok("GET", "/api/accounts", FRIEND), [])
        self.assertEqual(self.transactions(FRIEND), [])
        self.assertEqual(self.ok("POST", "/api/transactions/query", FRIEND, {"filters": {}})["total"], 0)
        self.assertEqual(self.ok("GET", "/api/transactions/categories", FRIEND)["categories"], [])
        self.assertEqual(self.ok("GET", "/api/budgets", FRIEND)["budgets"], [])
        meta = self.ok("GET", "/api/money/meta", FRIEND)
        self.assertEqual((meta["headings"], meta["accounts"], meta["descriptions"]), ([], [], []))
        summary = self.ok("GET", "/api/money/summary?month=2026-09&spend_month=2026-09", FRIEND)
        self.assertEqual((summary["expense"], summary["spending"]), ({}, {}))
        self.assertEqual(self.ok("GET", "/api/splits/list", FRIEND)["transactions"], [])

    def test_two_people_can_both_have_a_kotak(self):
        self.account(OWNER, balance=1000)
        self.account(FRIEND, balance=300)
        self.spend(FRIEND, amount=50)
        self.assertEqual(self.balances(OWNER)["KOTAK"], 1000)
        self.assertEqual(self.balances(FRIEND)["KOTAK"], 250)
        self.assertEqual(len(self.transactions(OWNER)), 0)
        # Identical spends on one day are fine, for anyone (two ₹50 snacks).
        self.spend(OWNER, amount=50)
        self.spend(OWNER, amount=50)
        self.assertEqual(len(self.transactions(OWNER)), 2)

    def test_you_cant_spend_from_someone_elses_account(self):
        self.account(OWNER)
        resp = self.call("POST", "/api/transactions", FRIEND, {
            "account": "KOTAK", "date": "2026-09-05", "type": "Debit", "heading": "Food", "amount": 1})
        self.assertEqual((resp.status_code, resp.get_json()["code"]), (400, "UNKNOWN_ACCOUNT"))
        self.assertEqual(self.balances(OWNER)["KOTAK"], 1000)

    def test_nothing_of_anothers_can_be_changed_by_id(self):
        self.account(OWNER)
        self.spend(OWNER, amount=100)
        tx = self.transactions(OWNER)[0]
        edit = {"account": "KOTAK", "date": "2026-09-05", "type": "Debit", "heading": "Food", "amount": 1}
        self.account(FRIEND)

        self.assertEqual(self.call("PUT", f"/api/transactions/{tx['id']}", FRIEND, edit).status_code, 404)
        self.assertEqual(self.call("DELETE", f"/api/transactions/{tx['id']}", FRIEND).status_code, 404)
        self.ok("PUT", "/api/transactions/bulk-edit", FRIEND, [{"id": tx["id"], **edit}])
        self.ok("POST", "/api/transactions/bulk-delete", FRIEND, [tx["id"]])
        self.assertEqual(self.call("POST", "/api/splits", FRIEND, {"transaction_id": tx["id"], "total_amount": 1}).status_code, 404)
        self.ok("DELETE", f"/api/splits/{tx['id']}", FRIEND)
        self.ok("PUT", "/api/transactions/category/exclude", FRIEND, {"heading": "Food", "exclude": True})
        self.ok("PUT", "/api/accounts", FRIEND, {"account": "KOTAK", "min_balance": 5})

        after = self.transactions(OWNER)
        self.assertEqual([(t["id"], t["amount"], t["exclude_analytics"]) for t in after], [(tx["id"], 100, False)])
        self.assertEqual(self.balances(OWNER)["KOTAK"], 900)
        self.assertIsNone(self.ok("GET", "/api/accounts", OWNER)[0]["min_balance"])

    def test_hiding_a_category_is_your_own_choice(self):
        self.account(OWNER)
        self.account(FRIEND)
        self.spend(OWNER, heading="Rent")
        self.ok("PUT", "/api/transactions/category/exclude", OWNER, {"heading": "Rent", "exclude": True})
        self.spend(FRIEND, heading="Rent")
        self.assertFalse(self.transactions(FRIEND)[0]["exclude_analytics"])
        self.spend(OWNER, heading="Rent", amount=7)
        self.assertTrue(all(t["exclude_analytics"] for t in self.transactions(OWNER)))

    def test_ids_never_collide_across_people(self):
        self.account(OWNER)
        with self.app.test_request_context():
            g.data_owner = OWNER
            ahead = int(datetime.now().timestamp() * 1000) + 5000
            db.session.add(Transaction(id=ahead, account="KOTAK", date=datetime(2026, 9, 5), month=datetime(2026, 9, 1),
                                       type="Debit", heading="Food", amount=1))
            db.session.commit()
            g.data_owner = FRIEND
            self.assertGreater(min(money.new_transaction_ids(2)), ahead)

    # ---- alerts ----
    def test_low_balance_alerts_reach_only_your_phones(self):
        sent = []
        original_send, original_threading = push._send, push.threading
        push._send = lambda app, tokens, title, body: sent.append(sorted(tokens))
        push.threading = types.SimpleNamespace(
            Thread=lambda target, args, daemon: types.SimpleNamespace(start=lambda: target(*args)))
        try:
            with self.app.test_request_context():
                db.session.add_all([DeviceToken(token="owner-phone", email=OWNER),
                                    DeviceToken(token="friend-phone", email=FRIEND)])
                db.session.commit()
                change = [{"account": "KOTAK", "after": 10, "min_balance": 500, "below_min": True}]
                push.send_low_balance_alert(change, FRIEND)
        finally:
            push._send, push.threading = original_send, original_threading
        self.assertEqual(sent, [["friend-phone"]])

    def test_a_phone_can_stop_its_alerts(self):
        with self.app.app_context():
            db.session.add_all([DeviceToken(token="phone", email=FRIEND), DeviceToken(token="other", email=OWNER)])
            db.session.commit()
        self.ok("POST", "/api/devices/unregister", OWNER, {"token": "phone"})   # not theirs: kept
        self.ok("POST", "/api/devices/unregister", FRIEND, {"token": "phone"})
        with self.app.app_context():
            self.assertEqual(sorted(t.token for t in DeviceToken.query.all()), ["other"])

    # ---- SabDekho ----
    def test_films_shows_and_diaries_are_your_own(self):
        film = self.ok("POST", "/api/movies", OWNER, {"tmdb_id": 27205, "name": "Inception", "status": "WATCHED"})["id"]
        show = self.ok("POST", "/api/tv/shows", OWNER, {"tmdb_id": 1396, "name": "Breaking Bad"})["id"]
        self.ok("POST", "/api/movies/diary", OWNER, {"movie_id": film, "date": "2026-09-01", "rating": 5})

        self.assertEqual(self.ok("GET", "/api/movies", FRIEND)["movies"], [])
        self.assertEqual(self.ok("GET", "/api/tv/shows", FRIEND)["shows"], [])
        self.assertEqual(self.ok("GET", "/api/movies/diary", FRIEND)["logs"], [])
        self.assertEqual(self.call("POST", "/api/movies/diary", FRIEND, {"movie_id": film}).status_code, 404)
        self.assertEqual(self.call("POST", "/api/tv/diary", FRIEND, {"tv_show_id": show}).status_code, 404)
        self.assertEqual(self.call("DELETE", f"/api/movies/{film}", FRIEND).status_code, 404)
        self.assertEqual(self.call("PUT", f"/api/tv/shows/{show}", FRIEND, {"status": "DROPPED"}).status_code, 404)

        mine = self.ok("POST", "/api/movies", FRIEND, {"tmdb_id": 27205, "name": "Inception"})["id"]
        self.assertNotEqual(mine, film)
        self.assertEqual(len(self.ok("GET", "/api/movies", OWNER)["movies"]), 1)

    def test_letterboxd_is_your_own(self):
        self.assertIsNone(self.ok("GET", "/api/auth/me", FRIEND)["settings"]["letterboxd_username"])
        self.ok("PUT", "/api/me/settings", FRIEND, {"letterboxd_username": "friendfilms"})
        self.assertEqual(self.ok("GET", "/api/auth/me", FRIEND)["settings"]["letterboxd_username"], "friendfilms")
        self.assertIsNone(self.ok("GET", "/api/auth/me", OWNER)["settings"]["letterboxd_username"])
        self.assertEqual(self.call("PUT", "/api/me/settings", FRIEND, {"letterboxd_username": "a/../b"}).status_code, 400)
        self.ok("PUT", "/api/me/settings", FRIEND, {"letterboxd_username": ""})
        self.assertIsNone(self.ok("GET", "/api/auth/me", FRIEND)["settings"]["letterboxd_username"])

    def test_a_cinema_spend_syncs_your_own_letterboxd_not_the_one_sent(self):
        synced = []
        original = money._perform_rss_sync_generator
        money._perform_rss_sync_generator = lambda username, fast_mode=False: iter(synced.append(username) or [])
        try:
            self.account(FRIEND)
            self.spend(FRIEND, heading="Cinema", lbx_username="sabarishh14")
            self.assertEqual(synced, [])                     # no username of their own yet
            self.ok("PUT", "/api/me/settings", FRIEND, {"letterboxd_username": "friendfilms"})
            self.spend(FRIEND, heading="Cinema", amount=200, lbx_username="sabarishh14")
            self.assertEqual(synced, ["friendfilms"])
        finally:
            money._perform_rss_sync_generator = original

    # ---- investments and gym ----
    def test_investments_are_your_own(self):
        asset = {"category": "FD", "name": "SBI FD", "invested_value": 1000, "current_value": 1100}
        self.ok("POST", "/api/manual_assets", OWNER, asset)
        self.assertEqual(self.ok("GET", "/api/manual_assets", FRIEND), [])
        self.assertEqual(self.ok("GET", "/api/investments", FRIEND), [])

        # Someone who never synced Kite still gets totals for what they add.
        self.ok("POST", "/api/manual_assets", FRIEND, {**asset, "invested_value": 50, "current_value": 60})
        friend_totals = self.ok("GET", "/api/investments", FRIEND)
        self.assertEqual([(s["total_inv"], s["total_curr"]) for s in friend_totals], [(50, 60)])
        self.assertEqual([(s["total_inv"], s["total_curr"]) for s in self.ok("GET", "/api/investments", OWNER)], [(1000, 1100)])

        friend_asset = self.ok("GET", "/api/manual_assets", FRIEND)[0]["id"]
        owner_asset = self.ok("GET", "/api/manual_assets", OWNER)[0]["id"]
        self.assertEqual(self.call("DELETE", f"/api/manual_assets/{owner_asset}", FRIEND).status_code, 404)
        self.assertEqual(self.call("PUT", f"/api/manual_assets/{owner_asset}", FRIEND, asset).status_code, 404)
        self.ok("DELETE", f"/api/manual_assets/{friend_asset}", FRIEND)
        self.assertEqual(len(self.ok("GET", "/api/manual_assets", OWNER)), 1)

    def test_gym_days_are_your_own(self):
        self.ok("POST", "/api/physical", OWNER, {"date": "2026-09-01", "gym": True})
        self.assertEqual(self.ok("GET", "/api/physical", FRIEND), [])
        self.ok("POST", "/api/physical", FRIEND, {"date": "2026-09-01", "badminton": True})
        self.assertTrue(self.ok("GET", "/api/physical", OWNER)[0]["gym"])

    # ---- the owner's own features ----
    def test_sheets_kite_ocr_and_nagapandi_are_the_owners(self):
        for who in (FRIEND, ADMIN):
            self.assertEqual(self.call("GET", "/api/sync/check-transactions", who).status_code, 403)
            for path in ("/api/sync/db-to-sheets", "/api/sync/sheet-balances", "/api/sync/ocr-balances",
                         "/api/sync/ocr-split", "/api/sync/kite", "/api/sync/investments-to-sheets", "/api/chat"):
                self.assertEqual(self.call("POST", path, who, {}).status_code, 403, (who, path))
        self.assertEqual(self.ok("GET", "/api/sync/check-transactions", OWNER)["count"], 0)

    def test_an_admin_sees_only_their_own_data(self):
        self.account(OWNER)
        self.spend(OWNER)
        self.assertEqual(self.ok("GET", "/api/accounts", ADMIN), [])
        self.assertEqual(self.transactions(ADMIN), [])

    def test_nagapandi_can_only_name_tables_it_is_narrowed_on(self):
        self.assertIn("transactions", chat.OWNED_TABLES)
        self.assertIn("movie_diary_logs", chat.OWNED_TABLES)
        narrowed = chat._owner_rows_only("SELECT count(*) FROM transactions")
        self.assertTrue(narrowed.startswith("WITH "))
        self.assertIn("transactions AS (SELECT * FROM public.transactions WHERE owner_email = :owner)", narrowed)
        recursive = chat._owner_rows_only("WITH RECURSIVE n AS (SELECT 1) SELECT * FROM n")
        self.assertTrue(recursive.startswith("WITH RECURSIVE accounts AS"))
        for sql in ("SELECT * FROM public.transactions", 'SELECT * FROM "public"."transactions"',
                    "SELECT * FROM user_settings", "SELECT * FROM device_tokens"):
            self.assertIsNotNone(chat._validate_generated_sql(sql)[1], sql)
        self.assertIsNone(chat._validate_generated_sql(
            "SELECT sum(amount) FROM transactions WHERE description ILIKE '%public transport%'")[1])

    # ---- the filter itself ----
    def test_a_signed_out_request_sees_no_personal_rows(self):
        self.account(OWNER)
        with self.app.test_request_context():
            self.assertEqual(Transaction.query.count(), 0)
            from models import Account
            self.assertEqual(Account.query.all(), [])

    def test_rows_cant_be_created_without_a_person(self):
        with self.app.test_request_context():
            from models import Budget
            db.session.add(Budget(category="x", monthly_limit=1))
            with self.assertRaises(Exception):
                db.session.flush()
            db.session.rollback()


if __name__ == "__main__":
    unittest.main()
