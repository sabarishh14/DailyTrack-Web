"""API tests for blueprints/routines.py on a throwaway in-memory SQLite database.

Isolated from the real environment: no .env file is read, Firebase is stubbed and
every secret is a dummy, so running these never touches Postgres or real keys.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import types
import unittest
from datetime import datetime, timedelta, timezone

BACKEND = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND)

import dotenv  # noqa: E402

dotenv.load_dotenv = lambda *args, **kwargs: False
os.environ.update({
    "API_SECRET_KEY": "test-api-key",
    "DATABASE_URL": "sqlite://",
    "SHEETS_URL": "http://sheets.invalid",
    "JWT_SECRET": "test-jwt-secret-long-enough-for-hs256-signing",
    "ADMIN_PASS": "test",
    "OWNER_EMAILS": "owner@test.dev",
    "ALLOWED_EMAILS": "",
})
_firebase = types.ModuleType("firebase_admin")
_firebase.initialize_app = lambda *args, **kwargs: None
_firebase.credentials = types.SimpleNamespace(Certificate=lambda *args, **kwargs: None)
_firebase.auth = types.SimpleNamespace()
sys.modules["firebase_admin"] = _firebase

import jwt  # noqa: E402
import pytz  # noqa: E402
from flask import Flask  # noqa: E402

import access  # noqa: E402
import models  # noqa: E402,F401 - registers the tables
from access import Access  # noqa: E402
from blueprints.routines import routines_bp  # noqa: E402
from extensions import db  # noqa: E402

VIEWER = "viewer@test.dev"     # gym: view - enough for their own routines
OTHER = "other@test.dev"       # gym: edit - a second person
NO_GYM = "nogym@test.dev"      # no gym access at all
OWNER = "owner@test.dev"

_PERMISSIONS = {
    VIEWER: {"modules": {"gym": "view"}},
    OTHER: {"modules": {"gym": "edit"}},
    NO_GYM: {"modules": {"money": "edit"}},
}


def _fake_get_access(email):
    email = (email or "").strip().lower()
    if email == OWNER:
        return Access(email, "owner")
    if email in _PERMISSIONS:
        return Access(email, "member", _PERMISSIONS[email])
    return None


access.get_access = _fake_get_access


def _token(email):
    payload = {"email": email, "exp": datetime.now(timezone.utc) + timedelta(hours=1)}
    return jwt.encode(payload, os.environ["JWT_SECRET"], algorithm="HS256")


def _ist_today():
    return datetime.now(pytz.timezone("Asia/Kolkata")).date()


class RoutinesApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(routines_bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, email=VIEWER, body=None, api_key=False):
        headers = {"X-API-KEY": "test-api-key"} if api_key else {"Authorization": f"Bearer {_token(email)}"}
        return self.client.open(path, method=method, json=body, headers=headers)

    def create(self, email=VIEWER, **fields):
        resp = self.call("POST", "/api/routines", email, {"name": "Read", **fields})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()["routine"]

    def checkin(self, routine_id, day, status, email=VIEWER, note=None):
        body = {"checkins": [{"routine_id": routine_id, "date": day, "status": status, "note": note}]}
        return self.call("POST", "/api/routines/checkins", email, body).get_json()

    def listing(self, email=VIEWER):
        resp = self.call("GET", "/api/routines", email)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    # ---- access ----

    def test_service_key_cannot_reach_routines(self):
        self.assertEqual(self.call("GET", "/api/routines", api_key=True).status_code, 403)
        self.assertEqual(self.call("POST", "/api/routines", body={"name": "x"}, api_key=True).status_code, 403)

    def test_needs_the_routines_module(self):
        self.assertEqual(self.call("GET", "/api/routines", NO_GYM).status_code, 403)
        self.assertEqual(self.call("GET", "/api/routines", OWNER).status_code, 200)

    def test_view_access_is_enough_for_your_own_routines(self):
        routine = self.create(VIEWER)
        result = self.checkin(routine["id"], _ist_today().isoformat(), "done")
        self.assertEqual(result["saved"], 1)

    # ---- creating and validating ----

    def test_create_keeps_only_the_schedules_own_fields(self):
        routine = self.create(schedule="daily", days=5, target=3, every=2, unit="day")
        self.assertEqual(
            (routine["days"], routine["target"], routine["every"], routine["unit"]),
            (None, None, None, None),
        )
        self.assertEqual(routine["start_date"], _ist_today().isoformat())
        self.assertEqual(routine["created_at"], _ist_today().isoformat())
        self.assertEqual(routine["kind"], "build")
        self.assertFalse(routine["archived"])

        weekly = self.create(schedule="weekly", target=4, days=3)
        self.assertEqual((weekly["target"], weekly["days"]), (4, None))
        chore = self.create(schedule="interval", every=3, unit="month", start_date="2026-10-01")
        self.assertEqual((chore["every"], chore["unit"], chore["start_date"]), (3, "month", "2026-10-01"))

    def test_create_rejects_bad_input(self):
        bad = [
            {"name": ""},
            {"name": "x" * 61},
            {"name": "A", "schedule": "hourly"},
            {"name": "A", "kind": "maybe"},
            {"name": "A", "schedule": "days"},
            {"name": "A", "schedule": "days", "days": 0},
            {"name": "A", "schedule": "days", "days": 128},
            {"name": "A", "schedule": "weekly", "target": 8},
            {"name": "A", "schedule": "monthly", "target": 0},
            {"name": "A", "schedule": "interval", "every": 3},
            {"name": "A", "schedule": "interval", "every": 0, "unit": "day"},
            {"name": "A", "start_date": "2026-09-30", "end_date": "2026-09-01"},
            {"name": "A", "start_date": "30/09/2026"},
        ]
        for body in bad:
            with self.subTest(body=body):
                self.assertEqual(self.call("POST", "/api/routines", body=body).status_code, 400)
        self.assertEqual(self.listing()["routines"], [])

    def test_new_routines_go_to_the_end(self):
        orders = [self.create(name=f"R{i}")["sort_order"] for i in range(3)]
        self.assertEqual(orders, [0, 1, 2])

    # ---- updating ----

    def test_update_rechecks_the_schedule(self):
        routine = self.create(schedule="weekly", target=3)
        resp = self.call("PUT", f"/api/routines/{routine['id']}", body={"schedule": "daily"})
        self.assertEqual(resp.get_json()["routine"]["target"], None)

        resp = self.call("PUT", f"/api/routines/{routine['id']}", body={"schedule": "days"})
        self.assertEqual(resp.status_code, 400)
        stored = self.listing()["routines"][0]
        self.assertEqual(stored["schedule"], "daily")

        resp = self.call("PUT", f"/api/routines/{routine['id']}", body={"name": "Read 20 min", "archived": True})
        self.assertEqual(resp.get_json()["routine"]["name"], "Read 20 min")
        self.assertTrue(resp.get_json()["routine"]["archived"])

    # ---- people can't see or touch each other's routines ----

    def test_routines_are_personal(self):
        mine = self.create(VIEWER)
        self.assertEqual(self.listing(OTHER)["routines"], [])
        self.assertEqual(self.call("PUT", f"/api/routines/{mine['id']}", OTHER, {"name": "Hacked"}).status_code, 404)
        self.assertEqual(self.call("DELETE", f"/api/routines/{mine['id']}", OTHER).status_code, 404)

        result = self.checkin(mine["id"], _ist_today().isoformat(), "done", email=OTHER)
        self.assertEqual(result["saved"], 0)
        self.assertEqual(result["ignored"][0]["reason"], "unknown routine")
        self.assertEqual(self.listing(VIEWER)["checkins"], [])
        self.assertEqual(self.listing(VIEWER)["routines"][0]["name"], "Read")

    # ---- check-ins ----

    def test_checkins_upsert_change_and_clear(self):
        routine = self.create()
        day = _ist_today().isoformat()
        self.checkin(routine["id"], day, "done")
        self.checkin(routine["id"], day, "skipped", note="  Sick " + "x" * 200)
        checkins = self.listing()["checkins"]
        self.assertEqual(len(checkins), 1)
        self.assertEqual(checkins[0]["status"], "skipped")
        self.assertEqual(len(checkins[0]["note"]), 120)
        self.assertTrue(checkins[0]["note"].startswith("Sick"))

        self.checkin(routine["id"], day, None)
        self.assertEqual(self.listing()["checkins"], [])

    def test_a_retried_batch_changes_nothing(self):
        routine = self.create()
        body = {"checkins": [
            {"routine_id": routine["id"], "date": "2026-09-01", "status": "done"},
            {"routine_id": routine["id"], "date": "2026-09-02", "status": "missed"},
        ]}
        for _ in range(2):
            self.assertEqual(self.call("POST", "/api/routines/checkins", body=body).get_json()["saved"], 2)
        self.assertEqual(
            [(c["date"], c["status"]) for c in self.listing()["checkins"]],
            [("2026-09-01", "done"), ("2026-09-02", "missed")],
        )

    def test_bad_entries_are_ignored_not_fatal(self):
        routine = self.create()
        too_far = (_ist_today() + timedelta(days=3)).isoformat()
        body = {"checkins": [
            {"routine_id": routine["id"], "date": _ist_today().isoformat(), "status": "done"},
            {"routine_id": routine["id"], "date": "yesterday", "status": "done"},
            {"routine_id": routine["id"], "date": too_far, "status": "done"},
            {"routine_id": routine["id"], "date": "2026-09-01", "status": "maybe"},
            "not a check-in",
        ]}
        result = self.call("POST", "/api/routines/checkins", body=body).get_json()
        self.assertEqual(result["saved"], 1)
        self.assertEqual(
            [i["reason"] for i in result["ignored"]],
            ["bad date", "bad date", "bad status", "unknown routine"],
        )

    def test_tomorrow_is_allowed_for_phones_ahead_of_ist(self):
        routine = self.create()
        tomorrow = (_ist_today() + timedelta(days=1)).isoformat()
        self.assertEqual(self.checkin(routine["id"], tomorrow, "done")["saved"], 1)

    def test_batch_size_is_capped(self):
        routine = self.create()
        body = {"checkins": [{"routine_id": routine["id"], "date": "2026-09-01", "status": "done"}] * 501}
        self.assertEqual(self.call("POST", "/api/routines/checkins", body=body).status_code, 400)
        self.assertEqual(self.call("POST", "/api/routines/checkins", body={"checkins": "x"}).status_code, 400)

    # ---- deleting and archiving ----

    def test_delete_removes_only_that_routines_history(self):
        gone = self.create(name="Gone")
        kept = self.create(name="Kept")
        self.checkin(gone["id"], "2026-09-01", "done")
        self.checkin(kept["id"], "2026-09-01", "done")
        self.assertEqual(self.call("DELETE", f"/api/routines/{gone['id']}").status_code, 200)
        listing = self.listing()
        self.assertEqual([r["name"] for r in listing["routines"]], ["Kept"])
        self.assertEqual([c["routine_id"] for c in listing["checkins"]], [kept["id"]])

    def test_archiving_keeps_history(self):
        routine = self.create()
        self.checkin(routine["id"], "2026-09-01", "done")
        self.call("PUT", f"/api/routines/{routine['id']}", body={"archived": True})
        listing = self.listing()
        self.assertTrue(listing["routines"][0]["archived"])
        self.assertEqual(len(listing["checkins"]), 1)


if __name__ == "__main__":
    unittest.main()
