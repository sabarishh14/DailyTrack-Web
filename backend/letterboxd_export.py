"""Reading a Letterboxd data export (Settings > Import & Export > Export your
data): the ZIP, or its diary.csv on its own. Its diary is every logged watch;
reviews.csv adds the review written for a watch, and likes/films.csv the ♥.

Nothing here touches the database: blueprints/media.py turns the entries into
diary logs.
"""
import csv
import io
import zipfile
from datetime import date

MAX_BYTES = 20 * 1024 * 1024


class ExportError(Exception):
    """An upload that isn't a Letterboxd export, with a message fit to show."""


def _rows(text):
    return list(csv.DictReader(io.StringIO(text.lstrip("﻿"))))


def _day(value):
    try:
        return date.fromisoformat((value or "").strip()[:10])
    except ValueError:
        return None


def _rating(value):
    try:
        rating = float(value)
    except (TypeError, ValueError):
        return None
    return rating if 0 < rating <= 5 else None


def _film(row):
    return (row.get("Name") or "").strip(), (row.get("Year") or "").strip()


def parse(data, filename=""):
    """[{title, year, date, rating, rewatch, liked, review, tags}], oldest first."""
    if len(data) > MAX_BYTES:
        raise ExportError("That file is too big for a Letterboxd export")
    files = {}
    if data[:2] == b"PK":
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                for name in z.namelist():
                    base = name.lower().rsplit("/", 2)
                    key = "/".join(base[-2:]) if base[-1] == "films.csv" else base[-1]
                    if key in ("diary.csv", "reviews.csv", "likes/films.csv", "watched.csv"):
                        files[key] = z.read(name).decode("utf-8", errors="replace")
        except zipfile.BadZipFile:
            raise ExportError("That ZIP can't be opened")
    else:
        text = data.decode("utf-8", errors="replace")
        header = text.lstrip("﻿").split("\n", 1)[0]
        if "Name" not in header or "Year" not in header:
            raise ExportError("That isn't a Letterboxd export: pick its ZIP or diary.csv")
        files["reviews.csv" if "Review" in header else "diary.csv" if "Watched Date" in header else "watched.csv"] = text

    reviews, liked = {}, set()
    for row in _rows(files.get("reviews.csv", "")):
        day = _day(row.get("Watched Date")) or _day(row.get("Date"))
        if row.get("Review", "").strip() and day:
            reviews[(*_film(row), day)] = row["Review"].strip()
    for row in _rows(files.get("likes/films.csv", "")):
        liked.add(_film(row))

    entries = []
    # The diary has every logged watch; an export without one (or a lone
    # reviews.csv) falls back to what it does have.
    source = files.get("diary.csv") or files.get("reviews.csv") or files.get("watched.csv")
    if source is None:
        raise ExportError("No diary.csv in that export")
    for row in _rows(source):
        title, year = _film(row)
        day = _day(row.get("Watched Date")) or _day(row.get("Date"))
        if not title or not day:
            continue
        tags = ",".join(t.strip() for t in (row.get("Tags") or "").split(",") if t.strip())
        entries.append({
            "title": title, "year": year, "date": day,
            "rating": _rating(row.get("Rating")),
            "rewatch": (row.get("Rewatch") or "").strip().lower() == "yes",
            "liked": False,
            "review": (row.get("Review") or "").strip() or reviews.get((title, year, day)) or None,
            "tags": tags or None,
        })
    entries.sort(key=lambda e: e["date"])
    # A like is for the film, not a watch: it goes on its latest one.
    latest = {}
    for e in entries:
        latest[(e["title"], e["year"])] = e
    for film, e in latest.items():
        e["liked"] = film in liked
    if not entries:
        raise ExportError("No watches with a date in that export")
    return entries
