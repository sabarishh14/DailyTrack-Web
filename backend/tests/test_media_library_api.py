"""Library filters that Stats chart bars jump to: API tests on a throwaway
in-memory SQLite database, with the routines tests' isolated setup.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import unittest
from datetime import date

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
from flask import Flask  # noqa: E402

from extensions import db  # noqa: E402
from models import Movie, MovieDiaryLog, TvDiaryLog, TvShow  # noqa: E402
from blueprints.media import media_bp  # noqa: E402

OWNER = setup.OWNER


class MediaLibraryFilterTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(media_bp)
        with self.app.app_context():
            db.create_all()
            mine = dict(owner_email=OWNER)
            # 2026-03-14 is a Saturday in ISO week 11; 2026-03-16 a Monday in week 12.
            dune = Movie(id=1, tmdb_id=101, name="Dune", status="WATCHED", language="en", **mine)
            rrr = Movie(id=2, tmdb_id=102, name="RRR", status="WATCHED", language="te", **mine)
            show = TvShow(id=10, tmdb_id=201, name="Dark", status="WATCHING", language="de", **mine)
            db.session.add_all([dune, rrr, show])
            db.session.add_all([
                MovieDiaryLog(movie_id=1, date=date(2026, 3, 14), rating=4.5, **mine),
                MovieDiaryLog(movie_id=2, date=date(2026, 3, 16), rating=3.0, **mine),
                # A rewatch rated differently, a year earlier, on a Saturday.
                MovieDiaryLog(movie_id=2, date=date(2025, 5, 10), rating=5.0, **mine),
                TvDiaryLog(tv_show_id=10, date=date(2026, 3, 14), rating=4.5, **mine),
            ])
            db.session.commit()
        self.client = self.app.test_client()

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def names(self, **filters):
        query = "&".join(f"{k}={v}" for k, v in {"status": "all", **filters}.items())
        resp = self.client.get(
            f"/api/media/library?{query}",
            headers={"Authorization": f"Bearer {setup._token(OWNER)}"},
        )
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return sorted(item["name"] for item in resp.get_json()["shows"])

    def test_no_filters_lists_everything(self):
        self.assertEqual(self.names(), ["Dark", "Dune", "RRR"])

    def test_weekday_matches_the_by_day_chart(self):
        self.assertEqual(self.names(weekday=5), ["Dark", "Dune", "RRR"])  # Saturdays, any year
        self.assertEqual(self.names(weekday=5, year=2026), ["Dark", "Dune"])
        self.assertEqual(self.names(weekday=0, year=2026, type="movie"), ["RRR"])

    def test_rating_matches_the_ratings_chart(self):
        self.assertEqual(self.names(rating="4.5"), ["Dark", "Dune"])
        self.assertEqual(self.names(rating="5.0", year=2026), [])
        self.assertEqual(self.names(rating="5.0", year=2025), ["RRR"])

    def test_one_log_has_to_match_every_filter(self):
        # RRR has a Saturday log and a 3★ log, but no single 3★ Saturday log.
        self.assertEqual(self.names(weekday=5, rating="3.0"), [])
        self.assertEqual(self.names(week=12, rating="3.0"), ["RRR"])

    def test_bad_values_match_nothing(self):
        self.assertEqual(self.names(weekday="sat"), [])


if __name__ == "__main__":
    unittest.main()
