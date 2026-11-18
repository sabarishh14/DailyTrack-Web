"""MF Central's Excel ("CAS detailed report") import (mfcentral.py): what each
holding cost, worked out from its transactions the way Groww and Tickertape
show it, imported like a CAS. Built from a small hand-made workbook.

    cd backend && python -m unittest discover -s tests
"""
import io
import json
import os
import sys
import time
import unittest
import zipfile
from datetime import date, timedelta
from unittest import mock
from xml.sax.saxutils import escape

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from test_funds_api import ApiCase, FRIEND, statement  # noqa: E402  (stubbed environment, request helpers)
from blueprints.vault import vault_bp  # noqa: E402
import funds_service  # noqa: E402
import mfcentral  # noqa: E402
from models import Fund, FundTransaction  # noqa: E402

TODAY = funds_service.ist_today()


def scheme(code, full_name, nav, day=TODAY):
    return {"code": code, "name": full_name.split(" - ")[0], "full_name": full_name, "amc": "Some Mutual Fund",
            "isins": [f"INF{code}"], "nav": nav, "date": day}


NAVS = {s["code"]: s for s in (
    scheme("122639", "Parag Parikh Flexi Cap Fund - Direct Plan - Growth", 90.0),
    scheme("122640", "Parag Parikh Flexi Cap Fund - Regular Plan - Growth", 85.0),
    scheme("200001", "HDFC Silver ETF Fund of Fund - Direct Plan - Growth", 30.0),
    scheme("200002", "HDFC Silver ETF Fund of Fund - Regular Plan - Growth", 29.0),
    scheme("200004", "HDFC Pharma and Healthcare Fund - Direct Plan - Growth", 25.0),
    scheme("200005", "Nippon India Small Cap Fund - Direct Plan - Growth Plan", 200.0),
    scheme("200006", "Old Closed Fund - Regular Plan - Growth", 10.0, date(2020, 4, 24)),
)}

PERSONAL = [["Name", "Somebody Private"], ["Mobile Number", "+919999999999"], ["Email", "private@example.com"],
            ["PAN", "ABCDE1234F"], [" ", " "], ["From Date", "01-Jan-2023"], ["To Date", "18-Nov-2026 "], [],
            ["Total Investments", "Current Portfolio Value", "Profit/Loss"], [1, 2, 1], []]
PORTFOLIO_HEAD = ["Scheme Name", "AMC Name", "Category", "Folio No.", "Invested Value", "Current Value", "Returns", "Units"]
TX_HEAD = ["Scheme Name", "Transaction Description", "Date", "NAV", "Units", "Amount"]


def holding(name, folio, units, invested, value):
    return [name, "Some Mutual Fund", "EQUITY", folio, invested, value, value - invested, units]


def xlsx(portfolio, transactions):
    """A workbook laid out like MF Central's: its strings shared, as Excel writes them."""
    shared, index = [], {}

    def cell(ref, v):
        if isinstance(v, (int, float)):
            return f'<c r="{ref}"><v>{v}</v></c>'
        if v not in index:
            index[v] = len(shared)
            shared.append(v)
        return f'<c r="{ref}" t="s"><v>{index[v]}</v></c>'

    def sheet(rows):
        body = "".join(f'<row r="{i}">' + "".join(cell(f"{chr(65 + j)}{i}", v) for j, v in enumerate(r) if v != "") + "</row>"
                       for i, r in enumerate(rows, 1))
        return ('<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                f"<sheetData>{body}</sheetData></worksheet>")

    sheets = {"Portfolio Details": sheet(PERSONAL + [PORTFOLIO_HEAD] + portfolio),
              "Transaction Details": sheet([TX_HEAD] + transactions)}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("xl/workbook.xml", '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                   'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
                   + "".join(f'<sheet name="{n}" sheetId="{i}" r:id="rId{i}"/>' for i, n in enumerate(sheets, 1))
                   + "</sheets></workbook>")
        z.writestr("xl/_rels/workbook.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                   + "".join(f'<Relationship Id="rId{i}" Target="worksheets/sheet{i}.xml"/>' for i in range(1, len(sheets) + 1))
                   + "</Relationships>")
        for i, body in enumerate(sheets.values(), 1):
            z.writestr(f"xl/worksheets/sheet{i}.xml", body)
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                   + "".join(f"<si><t>{escape(s)}</t></si>" for s in shared) + "</sst>")
    return buf.getvalue()


class MfCentralTest(ApiCase):
    def setUp(self):
        super().setUp()
        by_isin = {i: s for s in NAVS.values() for i in s["isins"]}
        patch = mock.patch.dict(funds_service._navs, {"at": time.time() + 10**9, "by_code": NAVS, "by_isin": by_isin})
        patch.start()
        self.addCleanup(patch.stop)

    def send(self, data, who=FRIEND, path="/api/funds/import"):
        return self.client.post(path, content_type="multipart/form-data",
                                data={"file": (io.BytesIO(data), "cas_detailed_report.xlsx")},
                                headers={"Authorization": f"Bearer {setup_token(who)}"})

    def funds(self):
        return {(f["code"], tuple(f["folios"])): f for f in self.ok("GET", "/api/funds")["funds"]}

    def test_invested_is_what_bought_the_units_still_held(self):
        # 10 at 100 and 10 at 50; 5 sold go from the first. Left: 5 x 100 + 10 x 50.
        # MF Central's own figure (1,500.08) has the stamp duty in it; this doesn't.
        name = "Parag Parikh Flexi Cap Fund - Direct Plan Growth (formerly Parag Parikh Long Term Value Fund)"
        data = xlsx([holding(name, "11112222", 15.0, 1500.08, 1350.0)], [
            [name, "Purchase Online", "02-JAN-2025", 100.0, 10.0, 999.95],
            [name, "Address Updated from KRA Data", "03-JAN-2025", 0, 0, 0],
            [name, "SIP Purchase Instalment No - 1 Online", "02-FEB-2025", 50.0, 10.0, 499.98],
            [name, "Redemption - ELECTRONIC PAYMENT less STT", "02-MAR-2025", 80.0, -5.0, -399.99],
        ])
        resp = self.send(data)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["added"], ["Parag Parikh Flexi Cap Fund"])
        fund = self.funds()[("122639", ("2222",))]
        self.assertEqual((fund["units"], fund["invested"], fund["value"]), (15.0, 1000.0, 1350.0))
        kinds = sorted(t.kind for t in self.rows(FundTransaction))
        self.assertEqual(kinds, ["PURCHASE", "PURCHASE_SIP", "REDEMPTION"])

    def test_one_funds_folios_are_told_apart_by_what_they_hold(self):
        silver, pharma = "HDFC Silver ETF Fund of Fund Direct Growth", "HDFC Pharma and Healthcare Fund Direct Growth"
        small = "NIPPON INDIA SMALL CAP FUND - DIRECT GROWTH PLAN GROWTH OPTION"
        data = xlsx([
            holding(silver, "31596515", 164.767, 4561.91, 4943.01),
            holding(silver, "35435675", 0, 0, 0),
            holding(pharma, "35435675", 521.77, 11904.77, 13044.25),
            holding(silver, "40074141", 155.085, 7500.0, 4652.55),
            holding(small, "477373545301", 5.228, 1000.0, 1045.6),
            holding(small, "477380167184", 128.448, 24000.0, 25689.6),
        ], [
            [silver, "Switch In - From HDFC Silver ETF Fund of Fund Regular Growth", "16-NOV-2026", 27.687, 164.767, 4561.91],
            [silver, "Purchase Online", "29-DEC-2025", 38.1528, 262.091, 9999.5],
            [silver, "SIP Purchase Instalment No - 1 Online", "30-JAN-2026", 51.4809, 9.712, 499.98],
            [silver, "Switch Out - To HDFC Pharma and Healthcare Fund Direct Growth", "04-NOV-2026", 30.4545, -271.803, -8277.6],
            [pharma, "Switch-In - From HDFC Silver ETF Fund of Fund", "06-NOV-2026", 22.815, 521.77, 11904.17],
            [silver, "Purchase Online", "22-JAN-2026", 48.3581, 155.085, 7499.63],
            # Two folios back to back, dates still rising: split where both fit.
            [small, "Purchase Online", "02-DEC-2024", 191.27, 5.228, 999.97],
            [small, "SIP Purchase Instalment No - 1 Online", "06-JAN-2025", 186.85, 128.448, 23998.68],
        ])
        self.assertEqual(self.send(data).status_code, 200)
        funds = self.funds()
        silver_row = funds[("200001", ("6515", "4141"))]
        self.assertAlmostEqual(silver_row["invested"], round(164.767 * 27.687 + 155.085 * 48.3581, 2), places=2)
        self.assertEqual(funds[("200004", ("5675",))]["invested"], round(521.77 * 22.815, 2))
        small_row = funds[("200005", ("5301", "7184"))]
        self.assertAlmostEqual(small_row["invested"], round(5.228 * 191.27 + 128.448 * 186.85, 2), places=2)
        # The folio switched out entirely was never held here, so it isn't added.
        with self.app.app_context():
            self.assertIsNone(Fund.query.filter_by(amfi_code="200001", folio_tail="5675").first())

    def test_a_name_without_direct_is_the_regular_plan_even_after_a_sold_out_row(self):
        name = "Parag Parikh Flexi Cap Fund - Growth"
        data = xlsx([holding(name, "55556666", 0, 0, 0), holding(name, "77778888", 2.0, 160.0, 170.0)], [
            [name, "Purchase", "02-JAN-2025", 80.0, 2.0, 159.99],
        ])
        self.assertEqual(self.send(data).status_code, 200)
        self.assertEqual(list(self.funds()), [("122640", ("8888",))])

    def test_a_scheme_no_longer_priced_is_never_matched(self):
        data = xlsx([holding("Old Closed Fund - Regular Growth", "12121212", 3.0, 30.0, 30.0)], [
            ["Old Closed Fund - Regular Growth", "Purchase", "02-JAN-2020", 10.0, 3.0, 30.0],
        ])
        resp = self.send(data)
        self.assertEqual(resp.get_json()["unknown"], ["Old Closed Fund - Regular Growth"])
        self.assertEqual(self.funds(), {})

    def test_personal_details_never_leave_the_reader_and_folios_only_as_hash_and_tail(self):
        name = "Parag Parikh Flexi Cap Fund - Direct Plan Growth"
        data = xlsx([holding(name, "11112222", 1.0, 100.0, 90.0)], [[name, "Purchase", "02-JAN-2025", 100.0, 1.0, 100.0]])
        with self.app.app_context():
            text = json.dumps(mfcentral.read(data), default=str)
        for secret in ("Somebody Private", "+919999999999", "private@example.com", "ABCDE1234F"):
            self.assertNotIn(secret, text)
        self.send(data)
        with self.app.app_context():
            fund = Fund.query.one()
            self.assertEqual((fund.folio_tail, len(fund.folio_ref)), ("2222", 16))
            self.assertNotIn("11112222", json.dumps({c.name: str(getattr(fund, c.name)) for c in Fund.__table__.columns}))

    def test_a_folio_imported_earlier_with_a_check_digit_is_updated_not_added_twice(self):
        self.imported(statement(units=10.0, cost=950.0))          # folio written "1234567/89"
        name = "Parag Parikh Flexi Cap Fund - Direct Plan Growth"
        data = xlsx([holding(name, "1234567", 12.0, 1150.0, 1080.0)], [
            [name, "Purchase", "02-APR-2026", 100.0, 5.0, 500.0],
            [name, "Purchase", "02-MAY-2026", 90.0, 5.0, 450.0],
            [name, "Purchase", "02-JUN-2026", 100.0, 2.0, 200.0],
        ])
        resp = self.send(data)
        self.assertEqual(resp.get_json()["updated"], ["Parag Parikh Flexi Cap Fund"])
        with self.app.app_context():
            fund = Fund.query.one()
            self.assertEqual((fund.units, float(fund.invested), fund.folio_tail), (12.0, 1150.0, "4567"))

    def test_funds_sold_out_before_they_were_ever_here_are_not_added(self):
        data = xlsx([holding("HDFC Pharma and Healthcare Fund Direct Growth", "35435675", 0, 0, 0)], [])
        resp = self.send(data)
        self.assertEqual(resp.status_code, 200, resp.get_json())
        with self.app.app_context():
            self.assertEqual(Fund.query.count(), 0)

    def test_what_isnt_mf_centrals_excel_is_refused(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as z:
            z.writestr("word/document.xml", "<doc/>")
        for data in (buf.getvalue(), b"just some text"):
            resp = self.send(data)
            self.assertEqual(resp.status_code, 400)
            self.assertIn("MF Central", resp.get_json()["message"])

    def test_the_vault_gets_it_read_in_the_same_shape(self):
        self.app.register_blueprint(vault_bp)
        name = "Parag Parikh Flexi Cap Fund - Direct Plan Growth"
        data = xlsx([holding(name, "11112222", 15.0, 1500.08, 1350.0)], [
            [name, "Purchase Online", "02-JAN-2025", 100.0, 10.0, 999.95],
            [name, "SIP Purchase Online", "02-FEB-2025", 50.0, 10.0, 499.98],
            [name, "Redemption", "02-MAR-2025", 80.0, -5.0, -399.99],
        ])
        resp = self.send(data, path="/api/vault/cas")
        self.assertEqual(resp.status_code, 200, resp.get_json())
        folio = resp.get_json()["cas"]["folios"][0]
        self.assertEqual((folio["tail"], len(folio["ref"])), ("2222", 16))
        s = folio["schemes"][0]
        self.assertEqual((s["amfi"], s["close"], s["cost"], len(s["transactions"])), ("122639", 15.0, 1000.0, 3))


def setup_token(who):
    import test_routines_api
    return test_routines_api._token(who)


if __name__ == "__main__":
    unittest.main()
