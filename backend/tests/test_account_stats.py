"""The spending analyser by account (/api/money/analyze with "group": "account"):
each account's share, its average per month and its latest month against it.

    cd backend && python -m unittest tests.test_account_stats
"""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_tenancy_api as people  # noqa: E402  (the isolated app, and FRIEND)

FRIEND = people.FRIEND


class AccountStatsTest(unittest.TestCase):
    setUp, tearDown = people.TenancyApiTest.setUp, people.TenancyApiTest.tearDown
    call, ok, account, spend = (people.TenancyApiTest.call, people.TenancyApiTest.ok,
                                people.TenancyApiTest.account, people.TenancyApiTest.spend)

    def analyze(self, **body):
        return self.ok("POST", "/api/money/analyze", FRIEND, {"filters": {}, **body})

    def setUpData(self):
        self.account(FRIEND, "KOTAK")
        self.account(FRIEND, "HDFC")
        for account, day, amount in [("KOTAK", "2026-07-10", 300), ("KOTAK", "2026-09-02", 600),
                                     ("HDFC", "2026-08-15", 200), ("HDFC", "2026-09-20", 100)]:
            self.spend(FRIEND, amount=amount, account=account, date=day)
        # Left out of every chart, so out of the averages too.
        self.spend(FRIEND, amount=5000, account="KOTAK", date="2026-08-01", exclude_analytics=True)

    def test_the_latest_month_against_the_year_before_it(self):
        self.setUpData()
        result = self.analyze(group="account")
        self.assertTrue(result["by_account"])
        self.assertEqual([(g["name"], g["value"]) for g in result["groups"]], [("KOTAK", 900.0), ("HDFC", 300.0)])
        stats = result["accounts"]
        self.assertEqual((stats["latest"], stats["in_progress"], stats["months"][-1]), ("2026-09-01", False, "2026-09-01"))
        kotak, hdfc = stats["rows"]
        # KOTAK since July: 300 then 0, so 150 a month; September's 600 is 4x that.
        self.assertEqual((kotak["account"], kotak["average"], kotak["months"], kotak["latest"], kotak["change"],
                          kotak["share"], kotak["trend"]),
                         ("KOTAK", 150.0, 2, 600.0, 300.0, 75.0, [0.0, 0.0, 0.0, 300.0, 0.0, 600.0]))
        self.assertEqual((hdfc["account"], hdfc["average"], hdfc["months"], hdfc["latest"], hdfc["change"]),
                         ("HDFC", 200.0, 1, 100.0, -50.0))

    def test_this_month_so_far_is_measured_against_the_months_before(self):
        self.setUpData()
        self.spend(FRIEND, amount=150, account="KOTAK", date=date.today().isoformat())
        stats = self.analyze(group="account")["accounts"]
        kotak = next(r for r in stats["rows"] if r["account"] == "KOTAK")
        self.assertTrue(stats["in_progress"])
        self.assertEqual((kotak["average"], kotak["latest"], kotak["change"]), (300.0, 150.0, -50.0))

    def test_the_date_filters_only_pick_the_month(self):
        # Filtered to this month, the averages still come from the months before.
        self.setUpData()
        august = {"months": {"include": ["August"]}, "years": {"include": ["2026"]}}
        stats = self.ok("POST", "/api/money/analyze", FRIEND, {"filters": august, "group": "account"})["accounts"]
        self.assertEqual(stats["latest"], "2026-08-01")
        hdfc, kotak = stats["rows"]
        self.assertEqual((hdfc["account"], hdfc["latest"], hdfc["average"], hdfc["share"]), ("HDFC", 200.0, None, 100.0))
        self.assertEqual((kotak["account"], kotak["latest"], kotak["average"], kotak["change"]), ("KOTAK", 0.0, 300.0, -100.0))

    def test_the_category_view_is_unchanged(self):
        self.setUpData()
        result = self.analyze()
        self.assertFalse(result["by_account"])
        self.assertNotIn("accounts", result)
        self.assertEqual([g["name"] for g in result["groups"]], ["Food"])


if __name__ == "__main__":
    unittest.main()
