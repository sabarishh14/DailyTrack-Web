// Smart search: the rules every search box follows, here, on the phone
// (SmartSearch.kt) and on the server (backend/smart_search.py).
// - Words in any order, each matched anywhere: "dinner swiggy" finds "Swiggy dinner".
// - Case, accents, spaces and punctuation don't matter: "supermoney" finds "super.money".
// - Part of a word is enough: "swig" finds "Swiggy".
// - A typo is forgiven in a word of 5+ letters (two in 8+), but only when the word
//   as typed matches nothing: "swigy" finds "Swiggy", while "food" never finds "good".
// Best matches come first: the whole text, then its start, whole words, word starts.

const normalize = (text) => String(text ?? '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export const searchWords = (text) => { const n = normalize(text); return n ? n.split(' ') : []; };

const typoLimit = (word) => (word.length >= 8 ? 2 : word.length >= 5 ? 1 : 0);

// Edits (insert, delete, change, swap two neighbours) from a to b; limit + 1 once it's more.
function distance(a, b, limit) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev2 = null, prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (prev2 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], prev2[j - 2] + 1);
    }
    if (Math.min(...row) > limit) return limit + 1;
    prev2 = prev; prev = row;
  }
  return prev[b.length];
}

const prepare = (text) => {
  const flat = normalize(text);
  return { flat, words: flat ? flat.split(' ') : [], joined: flat.replace(/ /g, '') };
};

// How well one search word matches a text as typed (null: it doesn't).
function asTyped(word, doc) {
  if (doc.words.includes(word)) return 10;
  if (doc.words.some(w => w.startsWith(word))) return 8;
  if (doc.flat.includes(word)) return 5;
  if (doc.joined.includes(word)) return 4;
  return null;
}

function withTypo(word, doc) {
  const k = typoLimit(word);
  if (!k) return null;
  return doc.words.some(w => distance(word, w, k) <= k || (w.length > word.length && distance(word, w.slice(0, word.length), k) <= k))
    ? 2 : null;
}

function score(query, doc, loose) {
  let total = 0;
  for (let i = 0; i < query.length; i++) {
    const s = asTyped(query[i], doc) ?? (loose[i] ? withTypo(query[i], doc) : null);
    if (s == null) return null;
    total += s;
  }
  const phrase = query.join(' ');
  return total + (doc.flat === phrase ? 100 : doc.flat.startsWith(phrase) ? 50 : doc.flat.includes(phrase) ? 20 : 0);
}

/** The items whose text matches `query`, best first (ties keep their order). */
export function searchRank(items, query, toText = (item) => item) {
  const words = searchWords(query);
  if (!words.length) return [...items];
  const docs = items.map(item => prepare(toText(item)));
  const loose = words.map(w => !docs.some(d => asTyped(w, d) != null));
  return docs
    .map((doc, i) => ({ i, s: score(words, doc, loose) }))
    .filter(r => r.s != null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map(r => items[r.i]);
}

/** One text against `query`, typos allowed (no list to check them against). */
export const searchMatches = (text, query) => {
  const words = searchWords(query);
  return !words.length || score(words, prepare(text), words.map(() => true)) != null;
};
