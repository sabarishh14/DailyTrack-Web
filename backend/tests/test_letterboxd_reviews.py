"""Letterboxd reviews from the RSS sync (blueprints/media.py): plain text with
its punctuation decoded, and old ones that weren't, repaired.

    cd backend && python -m unittest tests.test_letterboxd_reviews
"""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
from flask import Flask  # noqa: E402

from blueprints.media import media_bp, repair_letterboxd_reviews, review_from_rss  # noqa: E402
from extensions import db  # noqa: E402
from models import Movie, MovieDiaryLog  # noqa: E402

POSTER = '<p><img src="https://a.ltrbxd.com/resized/film-poster.jpg"/></p> '


class ReviewTextTest(unittest.TestCase):
    def test_codes_are_decoded(self):
        self.assertEqual(review_from_rss(POSTER + "<p>It&#039;s a &quot;must&quot; &amp; then some</p>"),
                         'It\'s a "must" & then some')

    def test_paragraphs_and_line_breaks_stay(self):
        self.assertEqual(review_from_rss(POSTER + "<p>First.</p> <p>Second<br />line.</p>"), "First.\nSecond\nline.")

    def test_no_review_is_empty(self):
        self.assertEqual(review_from_rss(POSTER + "<p>Watched on Saturday October 4, 2026.</p>"), "")
        self.assertEqual(review_from_rss(None), "")


class RepairTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(media_bp)
        with self.app.app_context():
            db.create_all()
            mine = dict(owner_email=setup.OWNER)
            db.session.add(Movie(id=1, tmdb_id=101, name="Dune", status="WATCHED", **mine))
            db.session.add_all([
                MovieDiaryLog(movie_id=1, date=date(2026, 3, 14), review="It&#039;s Dune &amp; it&#039;s big", **mine),
                MovieDiaryLog(movie_id=1, date=date(2026, 3, 15), review="Already fine; no codes", **mine),
                MovieDiaryLog(movie_id=1, date=date(2026, 3, 16), review="Watched on Monday March 16, 2026.", **mine),
            ])
            db.session.commit()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def test_old_reviews_are_decoded_once(self):
        with self.app.app_context():
            self.assertEqual(repair_letterboxd_reviews(), 2)
            self.assertEqual(repair_letterboxd_reviews(), 0)
            reviews = sorted(log.review or "" for log in MovieDiaryLog.query.all())
            self.assertEqual(reviews, ["", "Already fine; no codes", "It's Dune & it's big"])   # the date-only one is no review


if __name__ == "__main__":
    unittest.main()
