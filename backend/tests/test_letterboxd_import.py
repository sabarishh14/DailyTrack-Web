"""Importing a Letterboxd data export (letterboxd_export.py and the endpoint in
blueprints/media.py). No network: TMDB's matches are stand-ins.

    cd backend && python -m unittest tests.test_letterboxd_import
"""
import io
import json
import os
import sys
import unittest
import zipfile
from datetime import date
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import test_routines_api as setup  # noqa: E402  (stubs the environment and access)
from flask import Flask  # noqa: E402

import letterboxd_export  # noqa: E402
from blueprints import media  # noqa: E402
from extensions import db  # noqa: E402
from models import Movie, MovieDiaryLog  # noqa: E402

DIARY = ("Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n"
         "2026-03-15,Dune: Part Two,2024,https://boxd.it/a,4.5,,\"overall-theatres, theatres-pvr\",2026-03-14\n"
         "2026-03-20,Dune: Part Two,2024,https://boxd.it/b,5,Yes,,2026-03-19\n"
         "2026-04-01,Past Lives,2023,https://boxd.it/c,,,,2026-04-01\n")
REVIEWS = ("Date,Name,Year,Letterboxd URI,Rating,Rewatch,Review,Tags,Watched Date\n"
           "2026-03-20,Dune: Part Two,2024,https://boxd.it/b,5,Yes,\"Even better, twice.\",,2026-03-19\n")
LIKES = "Date,Name,Year,Letterboxd URI\n2026-03-20,Dune: Part Two,2024,https://boxd.it/x\n"


WATCHED = ("Date,Name,Year,Letterboxd URI\n"
           "2021-01-01,Dune: Part Two,2024,https://boxd.it/x\n"
           "2021-01-01,Kaithi,2019,https://boxd.it/y\n")
GONE = ("Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n"
        "2025-01-01,Deleted Film,2020,https://boxd.it/z,1,,,2025-01-01\n")


def export_zip(files=None, root=""):
    """A Letterboxd export as it comes, deleted and orphaned copies too."""
    files = files or {"diary.csv": DIARY, "reviews.csv": REVIEWS, "likes/films.csv": LIKES,
                      "watched.csv": WATCHED, "watchlist.csv": "Date,Name,Year,Letterboxd URI\n",
                      "deleted/diary.csv": GONE, "orphaned/diary.csv": GONE, "deleted/reviews.csv": REVIEWS}
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, text in files.items():
            z.writestr(root + name, text)
    return buf.getvalue()


class ParseTest(unittest.TestCase):
    def test_the_zip_joins_reviews_and_likes_to_the_diary(self):
        result = letterboxd_export.parse(export_zip(), "letterboxd.zip")
        entries = result["watches"]
        self.assertEqual([(e["title"], e["date"]) for e in entries],
                         [("Dune: Part Two", date(2026, 3, 14)), ("Dune: Part Two", date(2026, 3, 19)),
                          ("Past Lives", date(2026, 4, 1))])
        first, second, third = entries
        self.assertEqual((first["rating"], first["tags"], first["liked"]), (4.5, "overall-theatres,theatres-pvr", False))
        self.assertEqual((second["rewatch"], second["review"], second["liked"]), (True, "Even better, twice.", True))
        self.assertEqual((third["rating"], third["review"]), (None, None))
        self.assertEqual(result["watched"], [("Kaithi", "2019")])    # watched, never logged

    def test_deleted_and_orphaned_copies_are_left_out(self):
        for root in ("", "letterboxd-someone-2026/"):           # however the ZIP is laid out
            titles = {e["title"] for e in letterboxd_export.parse(export_zip(root=root))["watches"]}
            self.assertEqual(titles, {"Dune: Part Two", "Past Lives"})

    def test_only_marked_watched_still_imports(self):
        empty_diary = "Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n"
        result = letterboxd_export.parse(export_zip({"diary.csv": empty_diary, "watched.csv": WATCHED}))
        self.assertEqual((result["watches"], result["watched"]),
                         ([], [("Dune: Part Two", "2024"), ("Kaithi", "2019")]))

    def test_letterboxd_theatre_tags_count_as_theatre_trips(self):
        diary = ("Date,Name,Year,Letterboxd URI,Rating,Rewatch,Tags,Watched Date\n"
                 "2026-05-02,Thug Life,2025,https://boxd.it/t,3,,\"IMAX, In Theaters\",2026-05-01\n"
                 "2026-05-03,At Home,2024,https://boxd.it/h,3,,netflix,2026-05-02\n")
        theatre, home = letterboxd_export.parse(diary.encode())["watches"]
        self.assertEqual(theatre["tags"], "IMAX,In Theaters,overall-theatres,theatres-2026")
        self.assertEqual(home["tags"], "netflix")

    def test_diary_csv_alone(self):
        result = letterboxd_export.parse(("﻿" + DIARY).encode(), "diary.csv")
        self.assertEqual(len(result["watches"]), 3)

    def test_what_isnt_an_export_says_so(self):
        for data in (b"just,some,columns\n1,2,3\n", b"PK\x03\x04broken"):
            with self.assertRaises(letterboxd_export.ExportError):
                letterboxd_export.parse(data, "x")


class ImportApiTest(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.app.config.update(SQLALCHEMY_DATABASE_URI="sqlite://", TESTING=True)
        db.init_app(self.app)
        self.app.register_blueprint(media.media_bp)
        with self.app.app_context():
            db.create_all()
        self.client = self.app.test_client()

        def find(title, year, session, checked, fast_mode=False):   # TMDB's first match, stood in
            movie = Movie.query.filter_by(name=title).first()
            if movie:
                return movie, 0
            movie = Movie(tmdb_id=abs(hash(title)) % 10**6, name=title, status="WATCHED")
            db.session.add(movie)
            db.session.flush()
            return movie, 1
        for patch in (mock.patch.object(media, "_find_or_add_film", find), mock.patch.object(media, "TMDB_API_KEY", "k")):
            patch.start()
            self.addCleanup(patch.stop)

    def tearDown(self):
        with self.app.app_context():
            db.session.remove()
            db.drop_all()
            db.engine.dispose()

    def upload(self, data, name="letterboxd.zip"):
        resp = self.client.post("/api/movies/import/letterboxd", content_type="multipart/form-data",
                                data={"file": (io.BytesIO(data), name)},
                                headers={"Authorization": f"Bearer {setup._token(setup.OWNER)}"})
        lines = [json.loads(line) for line in resp.get_data(as_text=True).splitlines() if line.strip()]
        return resp.status_code, lines[-1] if lines else resp.get_json()

    def test_watches_become_diary_logs_once(self):
        status, done = self.upload(export_zip())
        self.assertEqual((status, done["added_movies"], done["added_logs"], done["marked_watched"]), (200, 3, 3, 1))
        with self.app.app_context():
            logs = {(l.movie.name, l.date): l for l in MovieDiaryLog.query.all()}
            rewatch = logs[("Dune: Part Two", date(2026, 3, 19))]
            self.assertEqual((rewatch.rating, rewatch.rewatch, rewatch.liked, rewatch.review), (5, True, True, "Even better, twice."))
            self.assertEqual(logs[("Dune: Part Two", date(2026, 3, 14))].tags, "overall-theatres,theatres-pvr")
            kaithi = Movie.query.filter_by(name="Kaithi").one()     # marked watched: in the library, no diary
            self.assertEqual((kaithi.status, kaithi.diary_logs), ("WATCHED", []))
        _, again = self.upload(export_zip())
        self.assertEqual((again["added_movies"], again["added_logs"], again["updated_logs"], again["marked_watched"]), (0, 0, 0, 0))

    def test_not_an_export(self):
        status, body = self.upload(b"nope", "notes.txt")
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
