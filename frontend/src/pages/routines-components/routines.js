import { apiGet, apiPost } from '../../api/money';
import { API } from '../../constants';
import { getToken } from '../../utils';

// Routines are worked out on the server (backend/routines_engine.py, the same
// rules as the phone), so this page shows, answers and edits them.

export const fetchSummary = (month) => apiGet(`/routines/summary${month ? `?month=${month}` : ''}`);
export const fetchDay = (date) => apiGet(`/routines/day?date=${date}`);
export const fetchDetail = (id, month) => apiGet(`/routines/${id}/detail${month ? `?month=${month}` : ''}`);

/** Sends a change; resolves with the response, or throws with the server's message. */
async function send(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${getToken()}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.success === false) throw new Error(json.message || "Couldn't save that");
  return json;
}

export const createRoutine = (body) => send('POST', '/routines', body);
export const updateRoutine = (id, body) => send('PUT', `/routines/${id}`, body);
export const deleteRoutine = (id) => send('DELETE', `/routines/${id}`);
/** Marks every blank due day before today done ("I've kept it up since then"). */
export const fillPast = (id) => send('POST', `/routines/${id}/fill-past`);

/** Saves one answer; a null status clears it. Resolves, or throws with a message. */
export async function saveAnswer(routineId, date, status, note = null) {
  const res = await apiPost('/routines/checkins', { checkins: [{ routine_id: routineId, date, status, note }] });
  if (!res || res.success === false) throw new Error(res?.message || 'Could not save');
  if (res.ignored?.length) throw new Error(res.ignored[0].reason);
  return res;
}

// Charts use colours anyone reads at a glance; the answer buttons keep their emoji.
export const COLORS = { done: '#34C759', skipped: '#FFC300', missed: '#FF453A' };

export const CHOICES = [
  { status: 'done', emoji: '❤️', label: 'Done' },
  { status: 'missed', emoji: '😭', label: 'Missed' },
  { status: 'skipped', emoji: '⏭️', label: 'Skip' },
];

export const SKIP_REASONS = ['🤒 Unwell', '✈️ Travelling', '😴 Rest day', '⏳ No time', '🌧️ Weather', '🎉 Occasion'];

/** A day's mix for drawing. Blanks are misses once the day is over, and still open today. */
export function mix(stats, today) {
  if (!stats) return null;
  const over = stats.date < today;
  return {
    done: stats.done,
    skipped: stats.skipped,
    missed: stats.missed + (over ? stats.unanswered : 0),
    open: over ? 0 : stats.unanswered,
  };
}

export const mixTotal = (m) => (m ? m.done + m.skipped + m.missed + m.open : 0);

// ---- dates: "2026-09-27" strings, read as local days so no timezone shifts them ----

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const LONG_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export const parseDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const isoOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (iso, days) => {
  const d = parseDay(iso);
  d.setDate(d.getDate() + days);
  return isoOf(d);
};

export const dayMonth = (iso) => {
  const d = parseDay(iso);
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
};

/** "Today", "Yesterday" or "Tuesday, 29 Sep". */
export const longDate = (iso, today) => {
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return `${WEEKDAYS[parseDay(iso).getDay()]}, ${dayMonth(iso)}`;
};

export const weekday = (iso) => WEEKDAYS[parseDay(iso).getDay()];

export const monthOf = (iso) => iso.slice(0, 7);

export const shiftMonth = (month, by) => {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

export const monthLabel = (month) => {
  const [y, m] = month.split('-').map(Number);
  return `${LONG_MONTHS[m - 1]} ${y}`;
};

/** Monday-first weeks for a month: day ISO strings, null for the padding. */
export function monthGrid(month) {
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const length = new Date(y, m, 0).getDate();
  const cells = Array((first.getDay() + 6) % 7).fill(null);
  for (let day = 1; day <= length; day++) cells.push(isoOf(new Date(y, m - 1, day)));
  while (cells.length % 7) cells.push(null);
  return cells;
}

// ---- wording ----

export const percent = (score) => (score && score.fraction != null ? `${Math.round(score.fraction * 100)}%` : '—');

/** A score as a ring's mix: kept in green, missed in red; skips are excused, so in neither. */
export const scoreMix = (score) => (score && score.fraction != null
  ? { done: score.fraction, skipped: 0, missed: 1 - score.fraction, open: 0 }
  : null);

/** The consistency score in a few words, as the phone puts it. */
export function verdict(score) {
  const f = score?.fraction;
  if (f == null) return 'No score yet';
  if (f >= 0.9) return 'Rock solid';
  if (f >= 0.75) return 'Going strong';
  if (f >= 0.5) return 'Building up';
  return 'Room to grow';
}

/** Points gained (or lost) on the stretch before, or null until both have a score. */
export function trendPoints(now, before) {
  if (now?.fraction == null || before?.fraction == null) return null;
  return Math.round((now.fraction - before.fraction) * 100);
}

export const streakLength = (count, unit) => {
  if (unit === 'time') return `${count} on time`;
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
};
