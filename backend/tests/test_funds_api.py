"""Mutual funds held outside Kite (funds_service.py): CAS import, adding by
hand, SIPs, daily valuation, and how they join Kite's numbers. No network:
AMFI's NAVs and past NAVs are stand-ins.

    cd backend && python -m unittest tests.test_funds_api
"""
import io
import os
import sys
import time
import unittest
from datetime import date, timedelta
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
import test_tenancy_api as people  # noqa: E402  (FRIEND: a member with their own data)
from flask import Flask  # noqa: E402

import funds_service  # noqa: E402
from blueprints.funds import funds_bp  # noqa: E402
from blueprints.invest import invest_bp  # noqa: E402
from extensions import db  # noqa: E402
from models import EquityHolding, Fund, FundSip, FundTransaction, MutualFundHolding, PortfolioSnapshot  # noqa: E402

OWNER, FRIEND = setup.OWNER, people.FRIEND
TODAY = funds_service.ist_today()
PAST_NAV = 80.0      # every past day's NAV in the stand-in history (no Sundays in it)


def scheme(code, name, amc, isin, nav):
    return {"code": code, "name": name, "full_name": f"{name} - Direct Plan - Growth", "amc": amc,
            "isins": [isin], "nav": nav, "date": TODAY}


NAVS = {s["code"]: s for s in (
    scheme("122639", "Parag Parikh Flexi Cap Fund", "PPFAS Mutual Fund", "INF879O01027", 90.0),
    scheme("118950", "HDFC Focused Fund", "HDFC Mutual Fund", "INF179K01VX5", 250.0),
)}


def past_navs(code):
    days = sorted(TODAY - timedelta(days=n) for n in range(1, 500) if (TODAY - timedelta(days=n)).weekday() != 6)
    return {d: PAST_NAV for d in days}, days


def statement(units=10.0, cost=950.0, to=TODAY - timedelta(days=1), transactions=None):
    """A CAMS statement the way funds_service.parse_cas hands it over."""
    rows = transactions if transactions is not None else [
        {"date": date(2026, 4, 2), "amount": 500.0, "units": 5.0, "nav": 100.0, "type": "PURCHASE"},
        {"date": date(2026, 4, 2), "amount": 0.02, "units": None, "nav": None, "type": "STAMP_DUTY_TAX"},
        {"date": date(2026, 5, 2), "amount": 450.0, "units": 5.0, "nav": 90.0, "type": "PURCHASE"},
    ]
    return {
        "statement_period": {"from": "01-Apr-2026", "to": to.strftime("%d-%b-%Y")},
        "file_type": "CAMS", "cas_type": "DETAILED",
        "investor_info": {"name": "Someone", "email": "x@y.z", "address": "Somewhere", "mobile": "0"},
        "folios": [{"folio": "1234567/89", "amc": "PPFAS Mutual Fund", "schemes": [{
            "scheme": "Parag Parikh Flexi Cap Fund - Direct Plan Growth", "isin": "INF879O01027", "amfi": "122639",
            "open": 0, "close": units, "close_calculated": units,
            "valuation": {"date": to, "nav": 90.0, "value": units * 90.0, "cost": cost},
            "transactions": [{"description": "", "balance": None, **t} for t in rows],
        }]}],
    }


class ApiCase(unittest.TestCase):
    """The app with the investment endpoints, stand-in NAVs and request helpers."""

    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        for bp in (invest_bp, funds_bp):
            self.app.register_blueprint(bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()
        by_isin = {i: s for s in NAVS.values() for i in s["isins"]}
        for patch in (
            mock.patch.dict(funds_service._navs, {"at": time.time() + 10**9, "by_code": NAVS, "by_isin": by_isin}),
            mock.patch.object(funds_service, "nav_history", past_navs),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def call(self, method, path, who=FRIEND, body=None):
        return self.client.open(path, method=method, json=body,
                                headers={"Authorization": f"Bearer {setup._token(who)}"})

    def ok(self, method, path, who=FRIEND, body=None):
        resp = self.call(method, path, who, body)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def upload(self, cas, who=FRIEND, password="pw"):
        with mock.patch.object(funds_service, "parse_cas", lambda stream, pw: cas):
            return self.client.post(
                "/api/funds/import", content_type="multipart/form-data",
                data={"file": (io.BytesIO(b"%PDF-1.4 stand-in"), "cas.pdf"), "password": password},
                headers={"Authorization": f"Bearer {setup._token(who)}"})

    def imported(self, cas, who=FRIEND):
        resp = self.upload(cas, who)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()

    def rows(self, model, **filters):
        with self.app.app_context():
            return model.query.filter_by(**filters).all()

    def kite_synced(self, who, day, fund="Parag Parikh Flexi Cap Fund"):
        """A Kite sync's rows, written straight in (the real one calls Kite)."""
        with self.app.app_context():
            db.session.add(MutualFundHolding(id=1, owner_email=who, date=day, symbol=fund, quantity=1,
                                             average_price=100, nav=110, invested_value=100, current_value=110))
            db.session.add(EquityHolding(id=2, owner_email=who, date=day, symbol="INFY", quantity=2,
                                         average_price=1000, ltp=1500, invested_value=2000, current_value=3000))
            db.session.commit()


class FundsApiTest(ApiCase):
    # ---- statements ----
    def test_a_statement_brings_in_its_funds_valued_at_todays_nav(self):
        result = self.imported(statement())
        self.assertEqual(result["added"], ["Parag Parikh Flexi Cap Fund"])
        fund = self.ok("GET", "/api/funds")["funds"][0]
        self.assertEqual((fund["units"], fund["invested"], fund["value"], fund["folios"]), (10.0, 950.0, 900.0, ["4567"]))
        self.assertEqual(len(self.rows(FundTransaction)), 3)

        snap = self.ok("GET", "/api/investments")[0]
        self.assertEqual((snap["date"], snap["inv_mf"], snap["curr_mf"], snap["total_curr"]), (TODAY.isoformat(), 950.0, 900.0, 900.0))
        holdings = self.ok("GET", f"/api/investments/{TODAY.isoformat()}/holdings")
        self.assertEqual([(h["symbol"], h["quantity"], h["current_value"]) for h in holdings],
                         [("Parag Parikh Flexi Cap Fund", 10.0, 900.0)])

    def test_the_folio_itself_is_never_stored(self):
        self.imported(statement())
        fund = self.rows(Fund)[0]
        self.assertNotIn("1234567", f"{fund.folio_ref}{fund.folio_tail}")

    def test_a_folio_shows_as_the_last_4_of_its_number(self):
        # CAMS writes folios as "number / check digit".
        self.assertEqual([funds_service.folio_tail(f) for f in ("91012345678 / 0", "1234567/89", "AB12C34")],
                         ["5678", "4567", "2C34"])

    def test_importing_again_changes_nothing(self):
        self.imported(statement())
        again = self.imported(statement())
        self.assertEqual((again["added"], again["updated"]), ([], ["Parag Parikh Flexi Cap Fund"]))
        self.assertEqual(len(self.rows(FundTransaction)), 3)
        self.assertEqual(self.ok("GET", "/api/funds")["funds"][0]["units"], 10.0)

    def test_a_newer_statement_takes_over_the_days_the_apps_sip_covered(self):
        self.imported(statement(to=TODAY - timedelta(days=40)))
        sip_day = (TODAY - timedelta(days=30)).day
        self.ok("POST", "/api/funds/122639/sip", body={"amount": 1000, "day": sip_day,
                                                      "since": (TODAY - timedelta(days=35)).isoformat()})
        self.assertTrue(self.rows(FundTransaction, source="sip"))

        newer_to = TODAY - timedelta(days=1)
        self.imported(statement(units=21.0, cost=2000.0, to=newer_to))
        with self.app.app_context():
            sips = FundTransaction.query.filter_by(source="sip").all()
            self.assertFalse([t for t in sips if t.date <= newer_to], "the statement replaces what it covers")
            fund = Fund.query.one()
            self.assertAlmostEqual(fund.units, 21.0 + sum(t.units for t in sips), places=3)
            self.assertAlmostEqual(float(fund.invested), 2000.0 + sum(float(t.amount) for t in sips), places=2)

    def test_a_fund_added_by_hand_gives_way_to_the_statement(self):
        self.ok("POST", "/api/funds", body={"code": "122639", "amount": 1000, "date": (TODAY - timedelta(days=10)).isoformat()})
        self.imported(statement())
        funds = self.ok("GET", "/api/funds")["funds"]
        self.assertEqual([(f["units"], f["sources"]) for f in funds], [(10.0, ["cas"])])

    def test_funds_kite_tracks_are_left_to_kite(self):
        self.kite_synced(OWNER, TODAY - timedelta(days=2))
        result = self.imported(statement(), who=OWNER)
        self.assertEqual((result["added"], result["skipped_kite"]), ([], ["Parag Parikh Flexi Cap Fund"]))
        self.assertEqual(self.call("POST", "/api/funds", OWNER, {"code": "122639", "amount": 500}).status_code, 409)
        self.assertEqual(self.rows(Fund), [])

    def test_an_import_that_adds_nothing_leaves_the_days_totals_to_kite(self):
        synced = TODAY - timedelta(days=2)
        self.kite_synced(OWNER, synced)
        with self.app.app_context():
            for i, day in enumerate((synced, TODAY)):   # today's: copied over by an earlier import
                db.session.add(PortfolioSnapshot(id=10 + i, owner_email=OWNER, date=day, grand_total_curr=3110))
            db.session.commit()
        self.imported(statement(), who=OWNER)
        self.assertEqual([s["date"] for s in self.ok("GET", "/api/investments", OWNER)], [synced.isoformat()])

    def test_a_wrong_password_says_so(self):
        def refuse(stream, password):
            raise funds_service.StatementError("That password didn't open the PDF")
        with mock.patch.object(funds_service, "parse_cas", refuse):
            resp = self.client.post("/api/funds/import", content_type="multipart/form-data",
                                    data={"file": (io.BytesIO(b"%PDF-1.4"), "cas.pdf"), "password": "nope"},
                                    headers={"Authorization": f"Bearer {setup._token(FRIEND)}"})
        self.assertEqual((resp.status_code, resp.get_json()["message"]), (400, "That password didn't open the PDF"))

    def test_only_a_pdf_is_read(self):
        resp = self.client.post("/api/funds/import", content_type="multipart/form-data",
                                data={"file": (io.BytesIO(b"hello"), "cas.txt"), "password": "pw"},
                                headers={"Authorization": f"Bearer {setup._token(FRIEND)}"})
        self.assertEqual(resp.status_code, 400)

    # ---- by hand, and SIPs ----
    def test_a_sip_since_months_ago_fills_in_every_instalment(self):
        since = TODAY - timedelta(days=100)
        self.ok("POST", "/api/funds", body={"code": "118950", "sip": {"amount": 5000, "day": 5, "since": since.isoformat()}})

        # Every 5th from then to today, priced the way funds_service prices them.
        expected_units, count = 0.0, 0
        day = funds_service.first_instalment(5, since)
        while day <= TODAY:
            priced = day if day.weekday() != 6 else day + timedelta(days=1)
            if priced <= TODAY:
                nav = NAVS["118950"]["nav"] if priced == TODAY else PAST_NAV
                expected_units += funds_service.purchase_units(5000, nav)
                count += 1
            day = day + funds_service.relativedelta(months=1, day=5)

        with self.app.app_context():
            fund = Fund.query.one()
            self.assertEqual(len(FundTransaction.query.filter_by(source="sip").all()), count)
            self.assertAlmostEqual(fund.units, expected_units, places=3)
            self.assertAlmostEqual(float(fund.invested), 5000.0 * count, places=2)
            self.assertGreater(FundSip.query.one().next_date, TODAY)

    def test_stamp_duty_comes_off_before_units_are_bought(self):
        self.assertEqual(funds_service.purchase_units(5000, 80.0), round(5000 * 0.99995 / 80.0, 3))

    def test_stopping_a_sip_keeps_what_it_added(self):
        self.ok("POST", "/api/funds", body={"code": "118950", "sip": {"amount": 1000, "day": 1,
                                                                      "since": (TODAY - timedelta(days=60)).isoformat()}})
        sip_id = self.ok("GET", "/api/funds")["funds"][0]["sips"][0]["id"]
        added = len(self.rows(FundTransaction))
        self.ok("DELETE", f"/api/funds/sips/{sip_id}")
        self.assertEqual(self.ok("GET", "/api/funds")["funds"][0]["sips"], [])
        self.assertEqual(len(self.rows(FundTransaction)), added)

    def test_removing_a_fund(self):
        self.imported(statement())
        self.ok("DELETE", "/api/funds/122639")
        self.assertEqual(self.ok("GET", "/api/funds")["funds"], [])
        self.assertEqual(self.ok("GET", "/api/investments")[0]["curr_mf"], 0)

    # ---- alongside Kite, and between people ----
    def test_kites_last_sync_carries_forward_into_a_day_with_funds(self):
        self.kite_synced(OWNER, TODAY - timedelta(days=3))
        self.ok("POST", "/api/funds", OWNER, {"code": "118950", "amount": 2500,
                                              "date": (TODAY - timedelta(days=7)).isoformat()})
        snap = self.ok("GET", "/api/investments", OWNER)[0]
        fund_value = round(funds_service.purchase_units(2500, PAST_NAV) * 250.0, 2)
        self.assertEqual((snap["date"], snap["curr_stocks"]), (TODAY.isoformat(), 3000))
        self.assertAlmostEqual(snap["curr_mf"], 110 + fund_value, places=2)
        held = {h["symbol"] for h in self.ok("GET", f"/api/investments/{TODAY.isoformat()}/holdings", OWNER)}
        self.assertEqual(held, {"Parag Parikh Flexi Cap Fund", "HDFC Focused Fund"})
        stocks = self.ok("GET", f"/api/investments/{TODAY.isoformat()}/equity_holdings", OWNER)
        self.assertEqual([s["symbol"] for s in stocks], ["INFY"])

    def test_funds_are_personal(self):
        self.imported(statement())
        self.assertEqual(self.ok("GET", "/api/funds", OWNER)["funds"], [])
        self.assertEqual(self.ok("GET", f"/api/investments/{TODAY.isoformat()}/holdings", OWNER), [])
        self.assertEqual(self.call("DELETE", "/api/funds/122639", OWNER).status_code, 404)
        self.assertEqual(len(self.ok("GET", "/api/funds")["funds"]), 1)

    def test_no_funds_means_no_trip_to_amfi(self):
        def offline():
            raise AssertionError("fetched NAVs for someone with no funds")
        with mock.patch.object(funds_service, "latest_navs", offline):
            self.ok("GET", "/api/investments")

    def test_search_finds_funds_by_any_words(self):
        results = self.ok("GET", "/api/funds/search?q=parag%20flexi")["results"]
        self.assertEqual([r["code"] for r in results], ["122639"])


class RecurringDepositTest(ApiCase):
    """RDs (manual assets): one instalment a month, each compounding quarterly
    from its own day, until maturity. Nothing is typed in but the terms."""

    def rd(self, start, months=12, installment=5000, rate=7.0, who=FRIEND):
        body = {"category": "RD", "name": "SBI RD", "installment": installment, "interest_rate": rate,
                "start_date": start.isoformat(), "maturity_date": (start + funds_service.relativedelta(months=months)).isoformat(),
                "invested_value": "", "current_value": ""}
        return self.call("POST", "/api/manual_assets", who, body)

    @staticmethod
    def expected(start, months, installment, rate, on):
        maturity = start + funds_service.relativedelta(months=months)
        end = min(on, maturity)
        dues = [start + funds_service.relativedelta(months=k) for k in range(months)]
        dues = [d for d in dues if d <= end]
        worth = sum(installment * (1 + rate / 400) ** (4 * (end - d).days / 365.25) for d in dues)
        return round(installment * len(dues), 2), round(worth, 2)

    def asset(self, who=FRIEND):
        return self.ok("GET", "/api/manual_assets", who)[0]

    def test_an_rd_adds_its_instalments_and_their_interest(self):
        start = TODAY - timedelta(days=95)
        self.assertEqual(self.rd(start).status_code, 200)
        rd = self.asset()
        deposited, worth = self.expected(start, 12, 5000, 7.0, TODAY)
        self.assertEqual((rd["installment"], rd["invested_value"], rd["current_value"]), (5000, deposited, worth))
        self.assertGreater(rd["current_value"], rd["invested_value"])
        self.assertEqual(deposited, 5000 * 4)   # ~3 months in: the 4th instalment is paid

    def test_an_rd_stops_at_maturity(self):
        start = TODAY - timedelta(days=800)
        self.rd(start, months=12)
        rd = self.asset()
        self.assertEqual((rd["invested_value"], rd["current_value"]),
                         self.expected(start, 12, 5000, 7.0, start + funds_service.relativedelta(months=12)))
        self.assertEqual(rd["invested_value"], 60000)

    def test_an_rd_needs_its_instalment(self):
        resp = self.rd(TODAY - timedelta(days=10), installment="")
        self.assertEqual((resp.status_code, resp.get_json()["message"]), (400, "Enter the monthly instalment"))

    def test_the_daily_job_never_compounds_an_rd_like_an_fd(self):
        start = TODAY - timedelta(days=200)
        self.rd(start)
        self.ok("POST", "/api/cron/process-recurring")
        rd = self.asset()
        self.assertEqual((rd["invested_value"], rd["current_value"]), self.expected(start, 12, 5000, 7.0, TODAY))

    def test_an_rd_counts_as_fixed_income(self):
        start = TODAY - timedelta(days=95)
        self.rd(start)
        snap = self.ok("GET", "/api/investments")[0]
        self.assertEqual((snap["inv_fixed"], snap["curr_fixed"]), self.expected(start, 12, 5000, 7.0, TODAY))


class AmfiFileTest(unittest.TestCase):
    def test_columns_are_read_by_name(self):
        text = "\n".join([
            "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
            "",
            "Open Ended Schemes(Equity Scheme - Flexi Cap Fund)",
            "PPFAS Mutual Fund",
            "122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;88.7620;05-Oct-2026",
            "100027;INF000000000;-;Old Fund - Regular Plan - Growth;;;N.A.;02-Jul-2018",
        ])
        parsed = funds_service.parse_amfi(text)
        self.assertEqual(list(parsed), ["122639"])
        s = parsed["122639"]
        self.assertEqual((s["name"], s["full_name"], s["amc"], s["nav"], s["date"]),
                         ("Parag Parikh Flexi Cap Fund", "Parag Parikh Flexi Cap Fund - Direct Plan - Growth",
                          "PPFAS Mutual Fund", 88.762, date(2026, 10, 5)))

    def test_a_changed_file_is_refused_not_misread(self):
        with self.assertRaises(funds_service.NavUnavailable):
            funds_service.parse_amfi("Code;Name;Value\n1;X;2")


if __name__ == "__main__":
    unittest.main()
