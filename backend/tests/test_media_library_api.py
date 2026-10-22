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

    def quick_tags(self, query=""):
        resp = self.client.get(f"/api/media/tags{query}",
                               headers={"Authorization": f"Bearer {setup._token(OWNER)}"})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        return resp.get_json()["tags"]

    def test_quick_tags_are_my_most_used_first(self):
        mine = dict(owner_email=OWNER)
        with self.app.app_context():
            db.session.add_all([
                MovieDiaryLog(movie_id=1, date=date(2026, 4, 1), tags="IMAX, overall-theatres, theatres-2026", **mine),
                MovieDiaryLog(movie_id=2, date=date(2026, 4, 2), tags="imax, Friends", **mine),
                MovieDiaryLog(movie_id=2, date=date(2026, 4, 9), tags="IMAX", **mine),
                # Five episodes on one day is one viewing; another day is a second one.
                *[TvDiaryLog(tv_show_id=10, date=date(2026, 4, 3), season_number=1, episode_number=n,
                             tags="Netflix", **mine) for n in range(1, 6)],
                TvDiaryLog(tv_show_id=10, date=date(2026, 4, 10), season_number=1, episode_number=6,
                           tags="Netflix", **mine),
                # Someone else's diary never shows up here.
                MovieDiaryLog(movie_id=1, date=date(2026, 4, 4), tags="Secret", owner_email=setup.OTHER),
            ])
            db.session.commit()
        # IMAX 3 times (spelled IMAX twice); Netflix twice; Friends once. Theatre tags are Money's.
        self.assertEqual(self.quick_tags(), ["IMAX", "Netflix", "Friends"])
        self.assertEqual(self.quick_tags("?limit=1"), ["IMAX"])

    def rematch(self, show_id, body):
        return self.client.post(f"/api/tv/shows/{show_id}/rematch", json=body,
                                headers={"Authorization": f"Bearer {setup._token(OWNER)}"})

    def test_a_show_can_be_rematched_and_keeps_its_logs(self):
        resp = self.rematch(10, {"tmdb_id": 299, "name": "Dark (2017)", "poster_path": "/dark.jpg"})
        self.assertEqual(resp.status_code, 200, resp.get_json())
        self.assertEqual(resp.get_json()["show"], {"id": 10, "tmdb_id": 299, "name": "Dark (2017)",
                                                   "poster_path": "/dark.jpg", "status": "WATCHING", "type": "tv"})
        self.assertEqual(self.names(rating="4.5", type="tv"), ["Dark (2017)"])  # its log came along

    def test_rematching_onto_a_show_already_in_the_library_is_refused(self):
        with self.app.app_context():
            db.session.add(TvShow(id=11, tmdb_id=300, name="Other", owner_email=OWNER))
            db.session.commit()
        self.assertEqual(self.rematch(10, {"tmdb_id": 300, "name": "Other"}).status_code, 400)
        self.assertEqual(self.rematch(99, {"tmdb_id": 400, "name": "Nope"}).status_code, 404)


if __name__ == "__main__":
    unittest.main()
