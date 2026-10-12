"""Smart search: the rules every search box follows, on the web, the phone
(SmartSearch.kt) and here (frontend/src/utils/search.js has the same).

- Words in any order, each matched anywhere: "dinner swiggy" finds "Swiggy dinner".
- Case, accents, spaces and punctuation don't matter: "supermoney" finds "super.money".
- Part of a word is enough: "swig" finds "Swiggy".
- A typo is forgiven in a word of 5+ letters (two in 8+), but only when the word
  as typed matches nothing: "swigy" finds "Swiggy", while "food" never finds "good".
"""
import re
import unicodedata

_NOT_WORD = re.compile(r"[\W_]+", re.UNICODE)


def normalize(text):
    text = unicodedata.normalize("NFKD", str(text or ""))
    text = "".join(c for c in text if not unicodedata.combining(c))
    return _NOT_WORD.sub(" ", text.lower()).strip()


def words(text):
    return normalize(text).split()


def typo_limit(word):
    return 2 if len(word) >= 8 else 1 if len(word) >= 5 else 0


def distance(a, b, limit):
    """Edits (insert, delete, change, swap two neighbours) from a to b, or
    limit + 1 once it's clearly more than limit."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2, prev = None, list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        row = [i] + [0] * len(b)
        for j, cb in enumerate(b, 1):
            row[j] = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ca != cb))
            if prev2 is not None and i > 1 and j > 1 and ca == b[j - 2] and a[i - 2] == cb:
                row[j] = min(row[j], prev2[j - 2] + 1)
        if min(row) > limit:
            return limit + 1
        prev2, prev = prev, row
    return prev[-1]


def near(word, vocabulary):
    """Words in `vocabulary` that `word` is a typo of, whole or as their start."""
    limit = typo_limit(word)
    if not limit:
        return []
    return sorted(v for v in vocabulary if distance(word, v, limit) <= limit
                  or (len(v) > len(word) and distance(word, v[:len(word)], limit) <= limit))
