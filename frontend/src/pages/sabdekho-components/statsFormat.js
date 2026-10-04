// Labels shared by the Stats charts and the Library filters they jump to.

export const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// Monday first, like the backend's date.weekday() and the "By Day" chart.
export const WEEKDAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * The dates "week N" covers in a year, as the stats charts count weeks: ISO
 * weeks, with early-January days of last year's final week folded into
 * week 1 and late-December days of next year's week 1 folded into week 52.
 * Null for "all" years, where a week number spans many date ranges.
 */
export function weekDates(year, week) {
  const y = Number(year);
  const w = Number(week);
  if (!Number.isInteger(y) || !Number.isInteger(w) || w < 1 || w > 52) return null;
  // ISO week 1 starts on the Monday on or before 4 January, as a day of
  // January that may be zero or negative (a late-December Monday).
  const firstMonday = 4 - ((new Date(y, 0, 4).getDay() + 6) % 7);
  const monday = firstMonday + (w - 1) * 7;
  const start = w === 1 ? new Date(y, 0, 1) : new Date(y, 0, monday);
  const end = w === 52 ? new Date(y, 11, 31) : new Date(y, 0, monday + 6);
  return { start, end };
}

/** "16–22 Mar", or "28 Apr – 4 May" across a month; null when there's no single range. */
export function weekRangeLabel(year, week) {
  const range = weekDates(year, week);
  if (!range) return null;
  const { start, end } = range;
  if (start.getMonth() === end.getMonth()) {
    return `${start.getDate()}–${end.getDate()} ${MONTHS_SHORT[end.getMonth()]}`;
  }
  return `${start.getDate()} ${MONTHS_SHORT[start.getMonth()]} – ${end.getDate()} ${MONTHS_SHORT[end.getMonth()]}`;
}

/** "Week 12 · 16–22 Mar" for a year, "Week 12" across all years. */
export function weekLabel(year, week) {
  const range = weekRangeLabel(year, week);
  return range ? `Week ${week} · ${range}` : `Week ${week}`;
}

/** "★★★★½" for 4.5. */
export function starsLabel(rating) {
  const halves = Math.round(Number(rating) * 2);
  return '★'.repeat(Math.floor(halves / 2)) + (halves % 2 ? '½' : '');
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Index of the largest positive value, or -1 when everything is zero. */
export function peakIndex(values) {
  let best = -1;
  values.forEach((v, i) => { if (v > 0 && (best < 0 || v > values[best])) best = i; });
  return best;
}
