"""The private vault (blueprints/vault.py): keys, locked items, moving what's
readable into the vault and back without losing any of it, and friends' grants.
The server never sees a key, so stand-in strings play the ciphertext.

    cd backend && python -m unittest tests.test_vault_api
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
from extensions import db  # noqa: E402

access._schema_ready = True
import blueprints.money as money  # noqa: E402
from blueprints.auth import auth_bp  # noqa: E402
from blueprints.funds import funds_bp  # noqa: E402
from blueprints.invest import invest_bp  # noqa: E402
from blueprints.vault import vault_bp  # noqa: E402

OWNER, FRIEND = setup.OWNER, tenancy.FRIEND


def keys(tag="a"):
    return {"salt": f"c2FsdC{tag}", "iterations": 600000, "wrapped_key": f"d3JhcHBlZC{tag}",
            "recovery_salt": f"cmVjb3Zlcnk{tag}", "recovery_wrapped_key": f"cmVjb3ZlcmVk{tag}",
            "public_key": f"cHVibGlj{tag}", "wrapped_private_key": f"cHJpdmF0ZQ{tag}"}


class VaultApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        for bp in (money.money_bp, invest_bp, funds_bp, auth_bp, vault_bp):
            self.app.register_blueprint(bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, who=OWNER, body=None, view_as=None):
        headers = {"Authorization": f"Bearer {setup._token(who)}"}
        if view_as:
            headers["X-View-As"] = view_as
        return self.client.open(path, method=method, json=body, headers=headers)

    def ok(self, method, path, who=OWNER, body=None, view_as=None):
        resp = self.call(method, path, who, body, view_as)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def owner_invests(self):
        self.ok("POST", "/api/manual_assets", body={"category": "FD", "name": "SBI FD", "invested_value": 50000,
                                                    "current_value": 52000})
        self.ok("POST", "/api/manual_assets", body={"category": "EPF", "name": "EPF", "invested_value": 90000})
        return self.ok("GET", "/api/investments")

    def move_in(self):
        """What a device does: read, lock away, read back, check, finish."""
        if self.ok("GET", "/api/vault")["me"] is None:
            self.ok("POST", "/api/vault/keys", body=keys())
        plain = self.ok("GET", "/api/vault/plain")
        self.ok("PUT", "/api/vault/items", body={"put": [
            {"id": "assets", "payload": "bG9ja2VkLWFzc2V0cw==", "rev": 0},
            {"id": "day:2026-11", "payload": "bG9ja2VkLWRheXM=", "rev": 0}]})
        return plain

    # ---- keys ----
    def test_keys_are_set_up_once_and_a_passphrase_changes_without_relocking(self):
        self.assertEqual(self.ok("GET", "/api/vault")["me"], None)
        self.ok("POST", "/api/vault/keys", body=keys())
        self.assertEqual(self.call("POST", "/api/vault/keys", body=keys("b")).status_code, 409)
        self.ok("PUT", "/api/vault/keys", body={"salt": "bmV3c2FsdA", "wrapped_key": "bmV3d3JhcA"})
        me = self.ok("GET", "/api/vault")["me"]
        self.assertEqual((me["salt"], me["wrapped_key"], me["public_key"]), ("bmV3c2FsdA", "bmV3d3JhcA", keys()["public_key"]))
        # A salt without its key (or the reverse) would lock the vault for good.
        self.assertEqual(self.call("PUT", "/api/vault/keys", body={"salt": "eA"}).status_code, 400)
        self.assertEqual(self.call("PUT", "/api/vault/keys", body={"public_key": "eA"}).status_code, 400)

    # ---- moving in ----
    def test_moving_in_keeps_everything_until_the_locked_copy_checks_out(self):
        before = self.owner_invests()
        plain = self.move_in()
        self.assertEqual({a["name"] for a in plain["tables"]["assets"]}, {"SBI FD", "EPF"})
        self.assertEqual(plain["fingerprints"]["assets"]["count"], 2)
        # Mid-move: no one changes what was read.
        moving = self.call("POST", "/api/manual_assets", body={"category": "FD", "name": "X", "invested_value": 1})
        self.assertEqual((moving.status_code, moving.get_json()["code"]), (409, "VAULT_MOVING"))

        # A copy that doesn't match: nothing goes.
        wrong = dict(plain["fingerprints"], assets={"count": 1, "ids": "nope"})
        resp = self.call("POST", "/api/vault/finish", body={"fingerprints": wrong})
        self.assertEqual((resp.status_code, resp.get_json()["tables"]), (409, ["assets"]))
        self.ok("POST", "/api/vault/cancel")
        self.assertEqual(self.ok("GET", "/api/investments"), before)
        self.assertEqual(self.ok("GET", "/api/vault/items")["items"], [])

        # Again, matching: the readable copy goes and the vault is on.
        plain = self.move_in()
        self.ok("POST", "/api/vault/finish", body={"fingerprints": plain["fingerprints"]})
        self.assertEqual(self.ok("GET", "/api/vault")["state"], "on")
        with self.app.app_context():
            from models import ManualAsset, PortfolioSnapshot
            from flask import g
            with self.app.test_request_context():
                g.data_owner = OWNER
                self.assertEqual((ManualAsset.query.count(), PortfolioSnapshot.query.count()), (0, 0))
        locked = self.call("GET", "/api/investments")
        self.assertEqual((locked.status_code, locked.get_json()["code"]), (409, "VAULT_ON"))
        self.assertEqual(self.call("GET", "/api/funds").status_code, 409)
        self.assertEqual(len(self.ok("GET", "/api/vault/items")["items"]), 2)
        # Keys that still lock something can't just be dropped.
        self.assertEqual(self.call("DELETE", "/api/vault/keys").status_code, 409)

    def test_finish_needs_a_move_under_way_and_something_locked(self):
        self.owner_invests()
        self.ok("POST", "/api/vault/keys", body=keys())
        self.assertEqual(self.call("POST", "/api/vault/finish", body={"fingerprints": {}}).status_code, 409)
        plain = self.ok("GET", "/api/vault/plain")
        resp = self.call("POST", "/api/vault/finish", body={"fingerprints": plain["fingerprints"]})
        self.assertEqual(resp.status_code, 409)     # nothing locked yet
        self.assertEqual(len(self.ok("GET", "/api/vault/plain")["tables"]["assets"]), 2)

    # ---- the items ----
    def test_two_devices_saving_at_once_dont_overwrite_each_other(self):
        self.ok("POST", "/api/vault/keys", body=keys())
        revs = self.ok("PUT", "/api/vault/items", body={"put": [{"id": "assets", "payload": "djE=", "rev": 0}]})["revs"]
        self.assertEqual(revs, {"assets": 1})
        self.ok("PUT", "/api/vault/items", body={"put": [{"id": "assets", "payload": "djI=", "rev": 1}]})
        late = self.call("PUT", "/api/vault/items", body={"put": [{"id": "assets", "payload": "djM=", "rev": 1}]})
        self.assertEqual((late.status_code, late.get_json()["stale"]), (409, ["assets"]))
        items = self.ok("GET", "/api/vault/items")["items"]
        self.assertEqual([(i["id"], i["payload"], i["rev"]) for i in items], [("assets", "djI=", 2)])
        self.ok("PUT", "/api/vault/items", body={"delete": [{"id": "assets", "rev": 2}]})
        self.assertEqual(self.ok("GET", "/api/vault/items")["items"], [])
        self.assertEqual(self.call("PUT", "/api/vault/items", body={"put": [{"id": "../x", "payload": "eA", "rev": 0}]}).status_code, 400)

    def test_items_are_each_persons_own(self):
        self.ok("POST", "/api/vault/keys", body=keys())
        self.ok("PUT", "/api/vault/items", body={"put": [{"id": "assets", "payload": "bWluZQ==", "rev": 0}]})
        self.ok("POST", "/api/vault/keys", FRIEND, body=keys("f"))
        self.assertEqual(self.ok("GET", "/api/vault/items", FRIEND)["items"], [])

    # ---- turning it off ----
    def owner_has_funds_and_kite(self):
        from datetime import date
        from flask import g
        from models import EquityHolding, Fund, FundSip, FundTransaction, FundValue, Stock, StockTrade, StockValue
        with self.app.test_request_context():
            g.data_owner = OWNER
            fund = Fund(id=7, amfi_code="120503", name="Axis ELSS", folio_ref="ab12", folio_tail="1234",
                        units=10.5, invested=1000.25, source="cas", statement_to=date(2026, 10, 31))
            db.session.add(fund)
            db.session.flush()
            db.session.add_all([
                FundTransaction(id=1, fund_id=7, date=date(2026, 1, 5), kind="PURCHASE", amount=1000.25,
                                units=10.5, nav=95.2, source="cas", key="k1"),
                FundSip(id=2, fund_id=7, amount=500, day=5, next_date=date(2026, 12, 5), active=True),
                FundValue(id=3, date=date(2026, 11, 10), amfi_code="120503", name="Axis ELSS", units=10.5,
                          nav=99.1, nav_date=date(2026, 11, 7), invested=1000.25, value=1040.55),
                Stock(id=1731000000000500, symbol="TCS", name="Tata Consultancy Services Limited", isin="INE467B01029",
                      quantity=2, invested=6000),
                StockValue(id=1731000000000502, date=date(2026, 11, 10), symbol="TCS", name="Tata Consultancy Services Limited",
                           quantity=2, price=3500, invested=6000, value=7000),
                EquityHolding(id=1731000000000123, date=date(2026, 11, 10), symbol="INFY", quantity=3,
                              average_price=1400, ltp=1500.5, invested_value=4200, current_value=4501.5, repriced=True),
            ])
            db.session.flush()
            db.session.add(StockTrade(id=1731000000000501, stock_id=1731000000000500, date=date(2026, 10, 1), kind="BUY",
                                      quantity=2, price=3000))
            db.session.commit()

    def test_turning_off_puts_everything_back(self):
        self.owner_invests()
        self.owner_has_funds_and_kite()
        before_funds = self.ok("GET", "/api/investments/2026-11-10/holdings")
        before_assets = self.ok("GET", "/api/manual_assets")
        plain = self.move_in()
        self.ok("POST", "/api/vault/finish", body={"fingerprints": plain["fingerprints"]})

        short = dict(plain["tables"], assets=plain["tables"]["assets"][:1])
        resp = self.call("POST", "/api/vault/restore", body={"tables": short, "fingerprints": plain["fingerprints"],
                                                             "state": plain["state"]})
        self.assertEqual(resp.status_code, 409)
        self.assertEqual(self.ok("GET", "/api/vault")["state"], "on")      # nothing changed

        self.ok("POST", "/api/vault/restore", body={"tables": plain["tables"], "fingerprints": plain["fingerprints"],
                                                    "state": plain["state"]})
        self.assertEqual(self.ok("GET", "/api/vault")["state"], "off")
        self.assertEqual(self.ok("GET", "/api/manual_assets"), before_assets)
        self.assertEqual(self.ok("GET", "/api/investments/2026-11-10/holdings"), before_funds)
        again = self.ok("GET", "/api/vault/plain")
        self.assertEqual(again["fingerprints"], plain["fingerprints"])
        self.assertEqual(again["tables"], plain["tables"])
        self.ok("POST", "/api/vault/cancel")
        self.assertEqual(self.ok("GET", "/api/vault/items")["items"], [])

    # ---- friends ----
    def test_a_friend_is_given_the_key_while_investments_is_shared(self):
        self.ok("POST", "/api/vault/keys", body=keys())
        self.ok("PUT", "/api/vault/items", body={"put": [{"id": "assets", "payload": "bG9ja2Vk", "rev": 0}]})
        self.assertEqual(self.call("GET", "/api/vault/items", FRIEND, view_as=OWNER).status_code, 403)

        self.ok("PUT", f"/api/shares/{FRIEND}", body={"modules": ["invest"]})
        self.assertEqual(self.ok("GET", "/api/vault/grants")["grants"],
                         [{"viewer": FRIEND, "public_key": None, "granted": False}])
        self.ok("POST", "/api/vault/keys", FRIEND, body=keys("f"))
        grants = self.ok("GET", "/api/vault/grants")["grants"]
        self.assertEqual((grants[0]["public_key"], grants[0]["granted"]), (keys("f")["public_key"], False))
        grant = {"viewer_key": keys("f")["public_key"], "ephemeral_key": "ZXBo", "wrapped_key": "d3JhcA"}
        self.ok("PUT", f"/api/vault/grants/{FRIEND}", body=grant)
        self.assertTrue(self.ok("GET", "/api/vault/grants")["grants"][0]["granted"])

        theirs = self.ok("GET", "/api/vault", FRIEND, view_as=OWNER)
        self.assertEqual((theirs["owner"], theirs["grant"]), (OWNER, {"ephemeral_key": "ZXBo", "wrapped_key": "d3JhcA"}))
        self.assertEqual(theirs["me"]["public_key"], keys("f")["public_key"])
        self.assertEqual(len(self.ok("GET", "/api/vault/items", FRIEND, view_as=OWNER)["items"]), 1)
        # Read-only, as everything shared is.
        self.assertEqual(self.call("PUT", "/api/vault/items", FRIEND, {"put": []}, view_as=OWNER).status_code, 403)
        self.assertEqual(self.call("GET", "/api/vault/plain", FRIEND, view_as=OWNER).status_code, 403)

        # Money stays shared, Investments doesn't: the key goes with it.
        self.ok("PUT", f"/api/shares/{FRIEND}", body={"modules": ["money"]})
        self.assertIsNone(self.ok("GET", "/api/vault", FRIEND, view_as=OWNER)["grant"])
        self.assertEqual(self.call("PUT", f"/api/vault/grants/{FRIEND}", body=grant).status_code, 403)

    def test_a_grant_for_old_keys_doesnt_open_anything(self):
        self.ok("POST", "/api/vault/keys", body=keys())
        self.ok("PUT", f"/api/shares/{FRIEND}", body={"modules": ["invest"]})
        self.ok("POST", "/api/vault/keys", FRIEND, body=keys("f"))
        self.ok("PUT", f"/api/vault/grants/{FRIEND}",
                body={"viewer_key": keys("f")["public_key"], "ephemeral_key": "ZXBo", "wrapped_key": "d3JhcA"})
        # They lost theirs and set up new ones: the old grant is for keys they don't have.
        self.ok("DELETE", "/api/vault/keys", FRIEND)
        self.ok("POST", "/api/vault/keys", FRIEND, body=keys("g"))
        self.assertIsNone(self.ok("GET", "/api/vault", FRIEND, view_as=OWNER)["grant"])
        self.assertEqual(self.call("PUT", f"/api/vault/grants/{FRIEND}",
                                   body={"viewer_key": keys("f")["public_key"], "ephemeral_key": "ZXBo", "wrapped_key": "d3JhcA"}).status_code, 409)


if __name__ == "__main__":
    unittest.main()
