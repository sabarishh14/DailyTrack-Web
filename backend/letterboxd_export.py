"""Reading a Letterboxd data export (Settings > Import & Export > Export your
data): the ZIP, or its diary.csv on its own. Its diary is every logged watch;
reviews.csv adds the review written for a watch, likes/films.csv the ♥, and
watched.csv the films marked watched without a diary entry (no date to log).

The export also has deleted/ and orphaned/ copies of the diary and reviews:
those are gone from the account and are left out.

Nothing here touches the database: blueprints/media.py turns the result into
diary logs and library films.
"""
import csv
import io
import zipfile
from datetime import date

MAX_BYTES = 20 * 1024 * 1024
WANTED = ("diary.csv", "reviews.csv", "likes/films.csv", "watched.csv")


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


def _zip_files(data):
    """{"diary.csv": text, ...} by their path in the export, so deleted/diary.csv
    is never taken for diary.csv. A ZIP that wraps it all in one folder counts
    from inside it."""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = [n for n in z.namelist() if not n.endswith("/")]
            roots = {n.split("/", 1)[0] for n in names}
            strip = len(roots) == 1 and all("/" in n for n in names)
            files = {}
            for name in names:
                path = name.split("/", 1)[1] if strip else name
                if path.lower() in WANTED:
                    files[path.lower()] = z.read(name).decode("utf-8", errors="replace")
            return files
    except zipfile.BadZipFile:
        raise ExportError("That ZIP can't be opened")


def parse(data, filename=""):
    """{"watches": [{title, year, date, rating, rewatch, liked, review, tags}]
    oldest first, "watched": [(title, year)] marked watched with no diary entry}."""
    if len(data) > MAX_BYTES:
        raise ExportError("That file is too big for a Letterboxd export")
    if data[:2] == b"PK":
        files = _zip_files(data)
    else:
        text = data.decode("utf-8", errors="replace")
        header = text.lstrip("﻿").split("\n", 1)[0]
        if "Name" not in header or "Year" not in header:
            raise ExportError("That isn't a Letterboxd export: pick its ZIP or diary.csv")
        kind = "reviews.csv" if "Review" in header else "diary.csv" if "Watched Date" in header else "watched.csv"
        files = {kind: text}
    if not any(files.get(f) for f in ("diary.csv", "reviews.csv", "watched.csv")):
        raise ExportError("That isn't a Letterboxd export: pick its ZIP or diary.csv")

    reviews, liked = {}, set()
    for row in _rows(files.get("reviews.csv", "")):
        day = _day(row.get("Watched Date")) or _day(row.get("Date"))
        if row.get("Review", "").strip() and day:
            reviews[(*_film(row), day)] = row["Review"].strip()
    for row in _rows(files.get("likes/films.csv", "")):
        liked.add(_film(row))

    # The diary has every logged watch; a lone reviews.csv is its own.
    watches = []
    for row in _rows(files.get("diary.csv") or files.get("reviews.csv") or ""):
        title, year = _film(row)
        day = _day(row.get("Watched Date")) or _day(row.get("Date"))
        if not title or not day:
            continue
        tags = ",".join(t.strip() for t in (row.get("Tags") or "").split(",") if t.strip())
        watches.append({
            "title": title, "year": year, "date": day,
            "rating": _rating(row.get("Rating")),
            "rewatch": (row.get("Rewatch") or "").strip().lower() == "yes",
            "liked": False,
            "review": (row.get("Review") or "").strip() or reviews.get((title, year, day)) or None,
            "tags": tags or None,
        })
    watches.sort(key=lambda e: e["date"])
    # A like is for the film, not a watch: it goes on its latest one.
    latest = {}
    for e in watches:
        latest[(e["title"], e["year"])] = e
    for film, e in latest.items():
        e["liked"] = film in liked

    # Marked watched but never logged: Letterboxd has no date for those.
    watched, seen = [], set(latest)
    for row in _rows(files.get("watched.csv", "")):
        film = _film(row)
        if film[0] and film not in seen:
            seen.add(film)
            watched.append(film)

    if not watches and not watched:
        raise ExportError("No films in that export")
    return {"watches": watches, "watched": watched}
