"""Smart search (smart_search.py): the rules, and the transactions search that
uses them. frontend/src/utils/search.js and the phone's SmartSearch.kt follow
the same rules.

    cd backend && python -m unittest tests.test_smart_search
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_tenancy_api as people  # noqa: E402  (the isolated app, and FRIEND)
import smart_search  # noqa: E402

FRIEND = people.FRIEND


class RulesTest(unittest.TestCase):
    def test_words_ignore_case_accents_and_punctuation(self):
        self.assertEqual(smart_search.words("  Café-Coffee_Day / super.money "), ["cafe", "coffee", "day", "super", "money"])

    def test_typos_allowed_grow_with_the_word(self):
        self.assertEqual([smart_search.typo_limit(w) for w in ("uber", "swigy", "flipkrt", "restaurnt")], [0, 1, 1, 2])

    def test_distance_counts_a_swap_as_one(self):
        self.assertEqual(smart_search.distance("zomtao", "zomato", 1), 1)
        self.assertEqual(smart_search.distance("swigy", "swiggy", 1), 1)
        self.assertEqual(smart_search.distance("amazon", "flipkart", 2), 3)

    def test_near_finds_whole_words_and_starts(self):
        vocab = {"swiggy", "instamart", "salary", "zomato"}
        self.assertEqual(smart_search.near("swigy", vocab), ["swiggy"])
        self.assertEqual(smart_search.near("instma", vocab), ["instamart"])   # still typing, one slip
        self.assertEqual(smart_search.near("food", vocab), [])                # short: as typed only


class TransactionsSearchTest(unittest.TestCase):
    setUp, tearDown = people.TenancyApiTest.setUp, people.TenancyApiTest.tearDown
    call, ok, account = people.TenancyApiTest.call, people.TenancyApiTest.ok, people.TenancyApiTest.account

    def add(self, description, heading="Food", amount=250, account="KOTAK"):
        self.ok("POST", "/api/transactions", FRIEND, {"account": account, "date": "2026-09-05", "type": "Debit",
                                                      "heading": heading, "description": description, "amount": amount})

    def found(self, text, field="description"):
        rows = self.ok("POST", "/api/transactions/query", FRIEND, {"filters": {field: text}})["transactions"]
        return sorted(r["description"] for r in rows)

    def test_words_in_any_order_and_any_field(self):
        self.account(FRIEND)
        self.add("Swiggy dinner with Arun")
        self.add("Ola to airport", heading="Travel", amount=640)
        self.add("Dinner at home", heading="Groceries")
        self.assertEqual(self.found("arun swiggy"), ["Swiggy dinner with Arun"])
        self.assertEqual(self.found("dinner food"), ["Swiggy dinner with Arun"])     # Food is its category
        self.assertEqual(self.found("travel 640"), ["Ola to airport"])               # and the amount
        self.assertEqual(self.found("kotak dinner"), ["Dinner at home", "Swiggy dinner with Arun"])
        self.assertEqual(self.found("swig"), ["Swiggy dinner with Arun"])            # part of a word
        self.assertEqual(self.found("swiggy", "search"), ["Swiggy dinner with Arun"])  # the global search too

    def test_spacing_and_punctuation_dont_matter(self):
        self.account(FRIEND)
        self.add("Recharge via super.money")
        self.add("PAY TM wallet")
        self.assertEqual(self.found("supermoney"), ["Recharge via super.money"])
        self.assertEqual(self.found("super money"), ["Recharge via super.money"])
        self.assertEqual(self.found("paytm"), ["PAY TM wallet"])

    def test_a_typo_is_forgiven_only_when_nothing_matches_as_typed(self):
        self.account(FRIEND)
        self.add("Swiggy dinner")
        self.add("Zomato lunch")
        self.add("Good day biscuits", heading="Groceries")
        self.assertEqual(self.found("swigy"), ["Swiggy dinner"])
        self.assertEqual(self.found("zomtao lunch"), ["Zomato lunch"])
        self.assertEqual(self.found("good"), ["Good day biscuits"])
        self.assertEqual(self.found("biscuts"), ["Good day biscuits"])
        self.assertEqual(self.found("pizza"), [])
        self.assertEqual(self.found("food"), ["Swiggy dinner", "Zomato lunch"])   # never "Good"


if __name__ == "__main__":
    unittest.main()
