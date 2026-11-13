// With the private vault on, the server can't read investments, so this does
// on the device what it did: answers the same Investments requests, in the
// same shapes, from the opened vault. Each piece follows its server original
// (backend/blueprints/invest.py, funds.py, funds_service.py, kite_daily.py);
// keep them in step. The phone's VaultEngine.kt does the same.
//
// What only the server can reach (Kite, AMFI's NAVs, stock prices, reading a
// CAS PDF) it asks for by name, never with amounts (blueprints/vault.py).
import { API } from '../constants';
import { getToken } from '../utils';
import { sha1Hex } from './crypto';
import { vaultCall } from './store';

// ---- days and times (IST, as the server keeps them) ----

const IST_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
export const istToday = () => IST_DAY.format(new Date());
/** Now in IST, as the server writes it: "2026-11-12T15:04:05". */
export function istNow() {
  const p = Object.fromEntries(IST_PARTS.formatToParts(new Date()).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
const ms = (stamp) => Date.parse(`${String(stamp).slice(0, 19)}Z`);
const dayMs = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const dayOf = (t) => new Date(t).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((dayMs(b) - dayMs(a)) / 86400000);
const addDays = (d, n) => dayOf(dayMs(d) + n * 86400000);
const weekday = (d) => (new Date(dayMs(d)).getUTCDay() + 6) % 7;     // Monday 0, as Python's
const monthLen = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
/** relativedelta(months=k, day=day): the month moved, the day kept (or set), short months clamped. */
function addMonths(d, k, day = null) {
  let y = +d.slice(0, 4), m = +d.slice(5, 7) - 1 + k;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  const dd = Math.min(day ?? +d.slice(8, 10), monthLen(y, m));
  return `${y}-${String(m + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
const minDay = (a, b) => (a < b ? a : b);
const clock = (stamp) => String(stamp).slice(11, 16);    // "HH:MM"
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v)) && dayOf(dayMs(String(v))) === String(v);

const r2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
const r3 = (x) => Math.round((x + Number.EPSILON) * 1000) / 1000;
const sum = (rows, f) => rows.reduce((s, r) => s + (Number(f(r)) || 0), 0);

let lastId = 0;
/** A new row's id: unique across everyone's rows, so turning the vault off puts it back as it is. */
function newId() {
  lastId = Math.max(lastId + 1, Date.now() * 1000);
  return lastId;
}

/** Python's str() of a number in a key (funds_service._key), so re-imports match keys made on the server. */
function pyStr(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e16) return `${v}.0`;
  if (v !== 0 && Math.abs(v) < 1e-4) return v.toExponential().replace(/e([+-])(\d)$/, 'e$10$2');
  return String(v);
}
const fundKey = (...parts) => sha1Hex(parts.join('|'));

class Refused extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// ---- what only the server can reach ----

let navCache = null;      // { at, byCode, byIsin, newest }
const history = new Map(); // code -> { day, rows: [[day, nav]] }
let kiteModeCache = null;  // { at, mode }

async function navs(fresh = false) {
  if (navCache && !fresh && Date.now() - navCache.at < 10 * 60 * 1000) return navCache;
  try {
    const { navs: rows } = await vaultCall('GET', `/vault/navs${fresh ? '?refresh=1' : ''}`);
    const byCode = {}, byIsin = {};
    let newest = '';
    for (const [code, name, fullName, amc, isins, nav, date] of rows) {
      const s = { code, name, full_name: fullName, amc, isins, nav, date };
      byCode[code] = s;
      for (const i of isins) byIsin[i] = s;
      if (date > newest) newest = date;
    }
    navCache = { at: Date.now(), byCode, byIsin, newest };
    return navCache;
  } catch (e) {
    if (navCache) return navCache;
    throw new Refused(e.message || 'Couldn’t reach AMFI for today’s NAVs', 503);
  }
}

async function navHistory(code) {
  const today = istToday();
  const hit = history.get(code);
  if (hit && hit.day === today) return hit.rows;
  try {
    const { navs: rows } = await vaultCall('GET', `/vault/nav-history/${encodeURIComponent(code)}`);
    history.set(code, { day: today, rows });
    return rows;
  } catch {
    throw new Refused('Couldn’t fetch past NAVs', 503);
  }
}

export function forgetSettings() { kiteModeCache = null; }

async function kiteMode() {
  if (kiteModeCache && Date.now() - kiteModeCache.at < 60 * 1000) return kiteModeCache.mode;
  try {
    const res = await fetch(`${API}/auth/me`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
    const me = await res.json();
    kiteModeCache = { at: Date.now(), mode: me?.settings?.kite_valuation === 'daily' ? 'daily' : 'manual' };
  } catch {
    return kiteModeCache?.mode || 'manual';
  }
  return kiteModeCache.mode;
}

// ---- funds held outside Kite (funds_service.py) ----

const STAMP_DUTY = 0.00005;
const MANUAL_FOLIO = 'manual';
const MANUAL_GROUPS = { fixed: ['FD', 'RD', 'Cash'], provident: ['EPF', 'PPF', 'NPS'], gold: ['SGB', 'RealEstate'] };

const cleanName = (name) => ['Direct', 'Regular', 'Growth', 'IDCW', 'Dividend']
  .reduce((n, w) => n.replace(new RegExp(`\\s*-\\s*${w}.*`, 'i'), ''), String(name)).trim();

const purchaseUnits = (amount, nav) => r3(amount * (1 - STAMP_DUTY) / nav);

async function navOn(code, day) {
  const latest = (await navs()).byCode[code];
  if (latest && latest.date === day) return [day, latest.nav];
  const rows = await navHistory(code);
  const hit = rows.find(([d]) => d >= day);
  if (hit) return hit;
  if (latest && latest.date >= day) return [latest.date, latest.nav];
  return null;
}

const nextInstalment = (sip, after) => addMonths(after, 1, sip.day);
function firstInstalment(day, since) {
  const first = addMonths(since, 0, day);
  return first >= since ? first : addMonths(first, 1, day);
}

async function processSips(t, today) {
  let added = 0;
  for (const sip of t.sips.filter(s => s.active && s.next_date <= today)) {
    const fund = t.funds.find(f => f.id === sip.fund_id);
    if (!fund) { sip.active = false; continue; }
    for (let i = 0; i < 600 && sip.next_date <= today; i++) {
      const priced = await navOn(fund.amfi_code, sip.next_date);
      if (!priced || priced[0] > today) break;
      const nav = priced[1];
      const units = purchaseUnits(Number(sip.amount), nav);
      t.fund_tx.push({
        id: newId(), fund_id: fund.id, date: sip.next_date, kind: 'PURCHASE_SIP', amount: sip.amount,
        units, nav, source: 'sip', key: await fundKey('sip', fund.id, sip.next_date),
      });
      fund.units = r3((fund.units || 0) + units);
      fund.invested = Number(fund.invested || 0) + Number(sip.amount);
      sip.next_date = nextInstalment(sip, sip.next_date);
      added++;
    }
  }
  return added;
}

function lastKiteDay(t, day) {
  let best = null;
  for (const r of t.equity) if (r.date <= day && (best === null || r.date > best)) best = r.date;
  for (const r of t.mf) if (r.date <= day && (best === null || r.date > best)) best = r.date;
  return best;
}

function newSnapshot(day) {
  return {
    id: newId(), date: day,
    total_equity_inv: 0, total_equity_curr: 0, total_mf_inv: 0, total_mf_curr: 0,
    total_fixed_income_inv: 0, total_fixed_income_curr: 0, total_provident_inv: 0, total_provident_curr: 0,
    total_gold_inv: 0, total_gold_curr: 0, grand_total_inv: 0, grand_total_curr: 0, synced: false,
  };
}

function setManualTotals(snap, manual) {
  const total = (group, field) => sum(manual.filter(a => MANUAL_GROUPS[group].includes(a.category)), a => a[field]);
  snap.total_fixed_income_inv = total('fixed', 'invested_value');
  snap.total_fixed_income_curr = total('fixed', 'current_value');
  snap.total_provident_inv = total('provident', 'invested_value');
  snap.total_provident_curr = total('provident', 'current_value');
  snap.total_gold_inv = total('gold', 'invested_value');
  snap.total_gold_curr = total('gold', 'current_value');
  snap.grand_total_inv = snap.total_equity_inv + snap.total_mf_inv + snap.total_fixed_income_inv
    + snap.total_provident_inv + snap.total_gold_inv;
  snap.grand_total_curr = snap.total_equity_curr + snap.total_mf_curr + snap.total_fixed_income_curr
    + snap.total_provident_curr + snap.total_gold_curr;
  snap.synced = false;
}

/** The latest day on or before `day` with values for stocks added by hand. */
function lastStockDay(t, day) {
  let best = null;
  for (const v of t.stock_values) if (v.date <= day && (best === null || v.date > best)) best = v.date;
  return best;
}

/** funds_service.recompute_snapshot: the day's totals from Kite's latest sync, funds and stocks held outside it, and manual assets. */
function recomputeSnapshot(t, day) {
  const kiteDay = lastKiteDay(t, day);
  const equity = kiteDay ? t.equity.filter(e => e.date === kiteDay) : [];
  const kiteFunds = kiteDay ? t.mf.filter(m => m.date === kiteDay) : [];
  const fundDay = lastFundDay(t, day);
  const own = fundDay ? t.fund_values.filter(f => f.date === fundDay) : [];
  const stockDay = lastStockDay(t, day);
  const ownStocks = stockDay ? t.stock_values.filter(v => v.date === stockDay) : [];
  let snap = t.snapshots.find(s => s.date === day);
  if (kiteDay !== null && kiteDay !== day && fundDay !== day && stockDay !== day) {
    if (snap && day === istToday()) t.snapshots = t.snapshots.filter(s => s !== snap);
    return null;
  }
  if (!snap) {
    if (!(equity.length || kiteFunds.length || own.length || ownStocks.length || t.assets.length)) return null;
    snap = newSnapshot(day);
    t.snapshots.push(snap);
  }
  snap.total_equity_inv = sum(equity, e => e.invested_value) + sum(ownStocks, s => s.invested);
  snap.total_equity_curr = sum(equity, e => e.current_value) + sum(ownStocks, s => s.value);
  snap.total_mf_inv = sum(kiteFunds, m => m.invested_value) + sum(own, f => f.invested);
  snap.total_mf_curr = sum(kiteFunds, m => m.current_value) + sum(own, f => f.value);
  setManualTotals(snap, t.assets);
  return snap;
}

/** The latest day on or before `day` with values for funds held outside Kite: they stand until the next. */
function lastFundDay(t, day) {
  let best = null;
  for (const v of t.fund_values) if (v.date <= day && (best === null || v.date > best)) best = v.date;
  return best;
}

/** funds_service.value_funds: every fund held at its latest NAV, filed under the day those NAVs are for. */
async function valueFunds(t, today) {
  const { byCode } = await navs();
  const held = new Map();
  for (const f of t.funds.filter(f => (f.units || 0) > 0)) {
    const row = held.get(f.amfi_code) || { name: f.name, units: 0, invested: 0 };
    row.units += f.units || 0;
    row.invested += Number(f.invested || 0);
    held.set(f.amfi_code, row);
  }
  const priced = new Map();
  for (const code of held.keys()) {
    const scheme = byCode[code];
    if (scheme) priced.set(code, [scheme.nav, scheme.date]);
    else {   // merged or wound up: its last known NAV
      const last = t.fund_values.filter(v => v.amfi_code === code).sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      if (last) priced.set(code, [last.nav, last.nav_date]);
    }
  }
  const navDays = [...priced.values()].map(p => p[1]).sort();
  const navDay = minDay(navDays.length ? navDays[navDays.length - 1] : today, today);
  const last = lastFundDay(t, today);
  // A later day already filed holds what's held now: the NAVs bring it up to date.
  const day = last ? (navDay > last ? navDay : last) : navDay;
  const previous = new Map(last ? t.fund_values.filter(v => v.date === last).map(v => [v.amfi_code, v]) : []);
  t.fund_values = t.fund_values.filter(v => v.date !== day);
  for (const [code, row] of held) {
    if (!priced.has(code)) continue;
    const [nav, navDate] = priced.get(code);
    t.fund_values.push({
      id: newId(), date: day, amfi_code: code, name: row.name, units: r3(row.units), nav,
      nav_date: navDate, invested: r2(row.invested), value: r2(row.units * nav),
    });
  }
  // Sold out since: a zero that day, so the days after don't carry it on.
  for (const [code, before] of previous) {
    if (before.units > 0 && !held.has(code)) {
      t.fund_values.push({ id: newId(), date: day, amfi_code: code, name: before.name, units: 0, nav: before.nav,
        nav_date: before.nav_date, invested: 0, value: 0 });
    }
  }
  recomputeSnapshot(t, day);
  for (const later of t.snapshots.filter(s => s.date > day).map(s => s.date)) {
    if (lastFundDay(t, later) === day) recomputeSnapshot(t, later);
  }
  return day;
}

// ---- tidying records filed before values went under their NAV's day ----

/** A record's stocks and funds from what was held on `day`; its manual assets as recorded (funds_service._held_totals). */
function heldTotals(t, snap, day) {
  const kiteDay = lastKiteDay(t, day), fundDay = lastFundDay(t, day), stockDay = lastStockDay(t, day);
  const equity = kiteDay ? t.equity.filter(e => e.date === kiteDay) : [];
  const kiteFunds = kiteDay ? t.mf.filter(m => m.date === kiteDay) : [];
  const own = fundDay ? t.fund_values.filter(v => v.date === fundDay) : [];
  const stocks = stockDay ? t.stock_values.filter(v => v.date === stockDay) : [];
  snap.total_equity_inv = sum(equity, e => e.invested_value) + sum(stocks, s => s.invested);
  snap.total_equity_curr = sum(equity, e => e.current_value) + sum(stocks, s => s.value);
  snap.total_mf_inv = sum(kiteFunds, m => m.invested_value) + sum(own, f => f.invested);
  snap.total_mf_curr = sum(kiteFunds, m => m.current_value) + sum(own, f => f.value);
  snap.grand_total_inv = ['total_equity_inv', 'total_mf_inv', 'total_fixed_income_inv', 'total_provident_inv', 'total_gold_inv']
    .reduce((s, f) => s + (snap[f] || 0), 0);
  snap.grand_total_curr = ['total_equity_curr', 'total_mf_curr', 'total_fixed_income_curr', 'total_provident_curr', 'total_gold_curr']
    .reduce((s, f) => s + (snap[f] || 0), 0);
  snap.synced = false;
}

/** funds_service.tidy_fund_days: each day's fund values once filed under the day the app was opened go to their NAV's day. */
function tidyFundDays(t) {
  const navDayOf = new Map();
  for (const v of t.fund_values) if (v.units > 0 && v.nav_date && (!navDayOf.has(v.date) || v.nav_date > navDayOf.get(v.date))) navDayOf.set(v.date, v.nav_date);
  const late = [...navDayOf].filter(([d, n]) => n < d).map(([d]) => d).sort();
  for (const day of late) {
    const moved = t.fund_values.filter(v => v.date === day);
    const target = moved.filter(v => v.units > 0).map(v => v.nav_date).sort().pop();
    t.fund_values = t.fund_values.filter(v => v.date !== target);
    for (const v of moved) v.date = target;
    const busy = t.equity.some(e => e.date === day) || t.mf.some(m => m.date === day) || t.stock_values.some(s => s.date === day);
    let left = t.snapshots.find(s => s.date === day);
    let there = t.snapshots.find(s => s.date === target);
    if (!there && left && !busy) {
      left.date = target;          // the record itself moves to its NAV's day
      there = left;
      left = null;
    } else if (!there && left) {
      there = newSnapshot(target);
      for (const f of ['total_fixed_income_inv', 'total_fixed_income_curr', 'total_provident_inv', 'total_provident_curr', 'total_gold_inv', 'total_gold_curr']) there[f] = left[f];
      t.snapshots.push(there);
    }
    if (there) heldTotals(t, there, target);
    if (left) {
      if (busy) heldTotals(t, left, day);
      else t.snapshots = t.snapshots.filter(s => s !== left);
    }
  }
  return late.length;
}

/** Funds held outside Kite as they stood on `day`: their last values on or before it, held ones. */
function ownFunds(t, day) {
  const d = lastFundDay(t, day);
  return d ? t.fund_values.filter(v => v.date === d && v.units > 0) : [];
}

/** The day of the latest NAV the funds held are valued at (kite_daily._funds_nav_day). */
function fundsNavDay(t, kiteDay, daily, today) {
  const days = ownFunds(t, today).map(v => v.nav_date);
  if (kiteDay && daily && navCache) {
    for (const f of t.mf.filter(m => m.date === kiteDay)) if (f.isin && navCache.byIsin[f.isin]) days.push(navCache.byIsin[f.isin].date);
  }
  return days.length ? days.sort()[days.length - 1] : null;
}

async function refreshFunds(t, fresh) {
  if (!(t.funds.some(f => (f.units || 0) > 0) || t.sips.some(s => s.active))) return false;
  const today = istToday();
  const due = t.sips.some(s => s.active && s.next_date <= today);
  const lastDay = lastFundDay(t, today);
  const valued = lastDay ? t.fund_values.filter(v => v.date === lastDay && v.units > 0) : [];
  const { byCode } = await navs(fresh);
  if (valued.length && !due && !valued.some(v => (byCode[v.amfi_code]?.date ?? v.nav_date) > v.nav_date)) return false;
  await processSips(t, today);
  await valueFunds(t, today);
  return true;
}

function kiteTrackedNames(t) {
  let day = null;
  for (const m of t.mf) if (day === null || m.date > day) day = m.date;
  return new Set(day === null ? [] : t.mf.filter(m => m.date === day).map(m => cleanName(m.symbol).toLowerCase()));
}

async function fundsOverview(t) {
  let byCode = navCache?.byCode || {};
  try { byCode = (await navs()).byCode; } catch { /* last copy, or none */ }
  const sips = new Map();
  for (const s of t.sips.filter(s => s.active)) sips.set(s.fund_id, [...(sips.get(s.fund_id) || []), s]);
  const grouped = new Map();
  for (const f of [...t.funds].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const row = grouped.get(f.amfi_code) || {
      code: f.amfi_code, name: f.name, amc: f.amc, units: 0, invested: 0,
      folios: [], sold_folios: [], sources: new Set(), sips: [],
    };
    row.units += f.units || 0;
    row.invested += Number(f.invested || 0);
    if (f.folio_tail) row[(f.units || 0) > 0 ? 'folios' : 'sold_folios'].push(f.folio_tail);
    row.sources.add(f.source);
    row.sips.push(...(sips.get(f.id) || []).map(s => ({ id: s.id, amount: Number(s.amount), day: s.day, next: s.next_date })));
    grouped.set(f.amfi_code, row);
  }
  const out = [...grouped.values()].map(({ sold_folios: sold, ...row }) => {
    const scheme = byCode[row.code];
    const nav = scheme ? scheme.nav : null;
    return {
      ...row,
      folios: row.folios.length ? row.folios : sold,
      units: r3(row.units), invested: r2(row.invested), sources: [...row.sources].sort(),
      nav, nav_date: scheme ? scheme.date : null, value: nav !== null ? r2(row.units * nav) : null,
    };
  });
  out.sort((a, b) => ((a.units <= 0) - (b.units <= 0)) || ((b.value || 0) - (a.value || 0)));
  return out;
}

// ---- Kite, repriced daily (kite_daily.py) ----

const MARKET_CLOSE = '15:45';
const REFRESH_MS = 30 * 60 * 1000;
const STALE_MS = 45 * 60 * 1000;
const FRESH_AFTER_MS = 60 * 1000;

function isStale(pricedAt, now) {
  if (!pricedAt || pricedAt.slice(0, 10) !== now.slice(0, 10)) return true;
  if (weekday(now.slice(0, 10)) >= 5 || clock(pricedAt) >= MARKET_CLOSE) return false;
  return ms(now) - ms(pricedAt) >= REFRESH_MS;
}

const marketOpen = (now) => weekday(now.slice(0, 10)) < 5 && clock(now) >= '09:15' && clock(now) <= '15:30';

function closedToday(quoted, seen, now) {
  return Boolean(marketOpen(now) && quoted && seen && quoted.slice(0, 10) < now.slice(0, 10)
    && seen.slice(0, 10) === now.slice(0, 10) && clock(seen) >= '09:30');
}

async function repriceIfDue(t, fresh) {
  if ((await kiteMode()) !== 'daily') return false;
  const now = istNow(), today = now.slice(0, 10);
  const pricedAt = t.state.priced_at;
  const day = lastKiteDay(t, today);
  if (day === null) return false;
  const equity = t.equity.filter(e => e.date === day);
  const funds = t.mf.filter(m => m.date === day);
  if (day === today && !equity.concat(funds).every(h => h.repriced)) return false;
  const nav = funds.length ? await navs(fresh).catch(() => null) : null;
  const quote = (f) => (nav && f.isin && nav.byIsin[f.isin] ? [nav.byIsin[f.isin].nav, nav.byIsin[f.isin].date] : null);
  const asked = fresh && (!pricedAt || ms(now) - ms(pricedAt) >= FRESH_AFTER_MS);
  if (!asked && !isStale(pricedAt, now) && !funds.some(f => { const q = quote(f); return q && q[0] !== f.nav; })) return false;

  let prices = {}, quoted = null;
  if (equity.length) {
    const symbols = [...new Set(equity.map(e => e.symbol))].sort();
    const r = await vaultCall('GET', `/vault/quotes?symbols=${encodeURIComponent(symbols.join(','))}`).catch(() => null);
    if (r) { prices = r.prices || {}; quoted = r.at; }
  }
  const quotes = new Map(funds.map(f => [f, quote(f)]));
  if (!Object.keys(prices).length && ![...quotes.values()].some(Boolean)) return false;
  const navDays = [...quotes.values()].filter(Boolean).map(q => q[1]).sort();
  const pricedOn = minDay(quoted ? quoted.slice(0, 10) : (navDays[navDays.length - 1] || today), today);
  const allRepriced = equity.concat(funds).every(h => h.repriced);
  const target = (pricedOn < day || (pricedOn === day && !allRepriced)) ? null : pricedOn;

  if (target) {
    const rows = [];
    for (const e of equity) {
      const ltp = prices[e.symbol] ?? e.ltp;
      rows.push(['equity', { ...e, id: newId(), date: target, ltp, current_value: e.quantity * ltp, repriced: true }]);
    }
    for (const f of funds) {
      const q = quotes.get(f);
      const fnav = q ? q[0] : f.nav;
      rows.push(['mf', { ...f, id: newId(), date: target, nav: fnav, current_value: f.quantity * fnav, repriced: true }]);
    }
    t.equity = t.equity.filter(e => !(e.date === target && e.repriced));
    t.mf = t.mf.filter(m => !(m.date === target && m.repriced));
    for (const [table, row] of rows) t[table].push(row);
    recomputeSnapshot(t, target);
    // Later days standing on these holdings take the new prices too.
    for (const later of t.snapshots.filter(s => s.date > target).map(s => s.date)) {
      if (lastKiteDay(t, later) === target) recomputeSnapshot(t, later);
    }
  }
  t.state.priced_at = now;
  if (quoted) t.state.quoted_at = quoted.slice(0, 19);
  if (Object.keys(prices).length) t.state.quotes_seen_at = now;
  return true;
}

async function priceTimes(t) {
  const mode = await kiteMode();
  const daily = mode === 'daily';
  const now = istNow();
  let synced = null;
  for (const r of t.equity.concat(t.mf)) if (!r.repriced && (synced === null || r.date > synced)) synced = r.date;
  const quoted = t.state.quoted_at;
  const closed = daily && closedToday(quoted, t.state.quotes_seen_at, now);
  const day = lastKiteDay(t, now.slice(0, 10));
  const held = day !== null && t.equity.some(e => e.date === day);
  const fundsAt = fundsNavDay(t, day, daily, now.slice(0, 10));
  const own = t.state.stocks_quoted_at;
  if (synced === null && own && t.stocks.some(s => s.quantity > 0)) {
    // No Kite, stocks added by hand: when their prices are from.
    const shut = closedToday(own, t.state.stocks_priced_at, now);
    return {
      mode: 'daily', synced: null, stocks_at: own, checked_at: t.state.stocks_priced_at || null,
      stale: Boolean(marketOpen(now) && !shut && ms(now) - ms(own) > STALE_MS), closed_today: Boolean(shut),
      funds_at: fundsAt,
    };
  }
  return {
    funds_at: fundsAt,
    mode, synced,
    stocks_at: quoted && daily ? quoted : null,
    checked_at: daily && t.state.priced_at ? t.state.priced_at : null,
    stale: Boolean(daily && held && marketOpen(now) && !closed && (!quoted || ms(now) - ms(quoted) > STALE_MS)),
    closed_today: Boolean(held && closed),
  };
}

// ---- stocks and ETFs added by hand (stocks_service.py) ----

let stockList = null;   // { at, rows: [{symbol, name, isin}] }

async function listedStocks() {
  if (stockList && Date.now() - stockList.at < 60 * 60 * 1000) return stockList.rows;
  try {
    const { stocks } = await vaultCall('GET', '/vault/stock-list');
    stockList = { at: Date.now(), rows: stocks.map(([symbol, name, isin]) => ({ symbol, name, isin })) };
    return stockList.rows;
  } catch (e) {
    if (stockList) return stockList.rows;
    throw new Refused(e.message || 'Couldn’t reach NSE’s list of stocks', 503);
  }
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDay = (d) => `${d.slice(8, 10)} ${MONTHS[+d.slice(5, 7) - 1]} ${d.slice(0, 4)}`;

/** Quantity and invested (average cost) from the trades, oldest first; a sale of more than was held then can't be. */
function replayStock(stock, trades) {
  let quantity = 0, invested = 0;
  const sorted = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id));
  for (const x of sorted) {
    if (x.kind === 'BUY') {
      quantity += x.quantity;
      invested += x.quantity * x.price;
    } else {
      if (x.quantity > quantity + 1e-9) throw new Refused(`You held ${Number(quantity.toPrecision(6))} ${stock.symbol} on ${longDay(x.date)}`);
      invested -= quantity ? invested / quantity * x.quantity : 0;
      quantity -= x.quantity;
      if (quantity <= 1e-9) { quantity = 0; invested = 0; }
    }
  }
  stock.quantity = Math.round(quantity * 1e6) / 1e6;
  stock.invested = r2(invested);
}

function stockTrade(t, stock, kind, quantity, price, day) {
  if (kind !== 'BUY' && kind !== 'SELL') throw new Refused('Buy or sell?');
  if (!(quantity > 0 && quantity <= 10_000_000)) throw new Refused('Enter how many');
  if (!(price > 0 && price <= 10_000_000)) throw new Refused('Enter the price');
  if (day > istToday()) throw new Refused('That date is in the future');
  t.stock_trades.push({ id: newId(), stock_id: stock.id, date: day, kind, quantity, price });
  replayStock(stock, t.stock_trades.filter(x => x.stock_id === stock.id));
}

/** Prices what's held and files it under the day the prices are from (or `on`, a day holdings changed). */
async function valueStocks(t, on = null) {
  const now = istNow(), today = now.slice(0, 10);
  const held = t.stocks.filter(s => s.quantity > 0);
  let prices = {}, quoted = null;
  if (held.length) {
    const symbols = [...new Set(held.map(s => s.symbol))].sort();
    const r = await vaultCall('GET', `/vault/quotes?symbols=${encodeURIComponent(symbols.join(','))}`).catch(() => null);
    if (r) { prices = r.prices || {}; quoted = r.at; }
  }
  if (held.length && !Object.keys(prices).length && on === null) return false;
  const last = lastStockDay(t, today);
  const quoteDay = minDay(quoted ? quoted.slice(0, 10) : today, today);
  // A later day already filed holds what's held now: the prices bring it up to date.
  const target = on || (last ? (quoteDay > last ? quoteDay : last) : quoteDay);
  const previous = new Map(last ? t.stock_values.filter(v => v.date === last).map(v => [v.symbol, v]) : []);
  t.stock_values = t.stock_values.filter(v => v.date !== target);
  for (const s of held) {
    const price = prices[s.symbol] || previous.get(s.symbol)?.price || Number(s.invested) / s.quantity;
    t.stock_values.push({ id: newId(), date: target, symbol: s.symbol, name: s.name, quantity: s.quantity, price,
      invested: Number(s.invested), value: r2(s.quantity * price) });
  }
  // Sold out since: a zero that day, so the day after doesn't carry it on.
  const heldNow = new Set(held.map(s => s.symbol));
  for (const [symbol, before] of previous) {
    if (before.quantity > 0 && !heldNow.has(symbol)) {
      t.stock_values.push({ id: newId(), date: target, symbol, name: before.name, quantity: 0, price: before.price, invested: 0, value: 0 });
    }
  }
  recomputeSnapshot(t, target);
  for (const later of t.snapshots.filter(s => s.date > target).map(s => s.date)) {
    if (lastStockDay(t, later) === target) recomputeSnapshot(t, later);
  }
  if (Object.keys(prices).length) t.state.stocks_priced_at = now;
  if (quoted) t.state.stocks_quoted_at = quoted.slice(0, 19);
  return true;
}

async function refreshStocks(t, fresh) {
  if (!t.stocks.some(s => s.quantity > 0)) return false;
  const now = istNow(), pricedAt = t.state.stocks_priced_at;
  const asked = fresh && (!pricedAt || ms(now) - ms(pricedAt) >= FRESH_AFTER_MS);
  if (!asked && !isStale(pricedAt, now)) return false;
  return valueStocks(t);
}

function stocksOverview(t) {
  // Each one's latest price, even when its latest day was since deleted.
  const values = new Map();
  for (const v of [...t.stock_values].filter(v => v.date <= istToday()).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))) values.set(v.symbol, v);
  const trades = new Map();
  for (const x of [...t.stock_trades].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id))) {
    trades.set(x.stock_id, [...(trades.get(x.stock_id) || []), { id: x.id, date: x.date, kind: x.kind, quantity: x.quantity, price: x.price }]);
  }
  const out = [...t.stocks].sort((a, b) => (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0)).map(s => {
    const price = values.get(s.symbol)?.price ?? null;
    return {
      symbol: s.symbol, name: s.name, quantity: s.quantity, invested: r2(Number(s.invested)),
      avg_price: s.quantity ? r2(Number(s.invested) / s.quantity) : null,
      price, value: price !== null ? r2(s.quantity * price) : null, trades: trades.get(s.id) || [],
    };
  });
  out.sort((a, b) => ((a.quantity <= 0) - (b.quantity <= 0)) || ((b.value || 0) - (a.value || 0)));
  return out;
}

/** Stocks added by hand as they stood on `day`, held ones (invest._own_stocks). */
function ownStocks(t, day) {
  const d = lastStockDay(t, day);
  return (d ? t.stock_values.filter(v => v.date === d && v.quantity > 0) : []).map(s => ({
    symbol: s.symbol, quantity: s.quantity, average_price: s.quantity ? Math.round(s.invested / s.quantity * 10000) / 10000 : 0,
    ltp: s.price, invested_value: s.invested, current_value: s.value, ret_pct: retPct(s.value, s.invested),
  }));
}

// ---- manual assets, RDs and automations (invest.py) ----

function recurringDeposit(installment, rate, start, maturity, today) {
  const end = maturity ? minDay(today, maturity) : today;
  let deposited = 0, worth = 0;
  for (let k = 0; k < 1200; k++) {
    const due = addMonths(start, k);
    if (due > end || (maturity && due >= maturity)) break;
    const years = daysBetween(due, end) / 365.25;
    deposited += installment;
    worth += installment * (1 + (rate || 0) / 400) ** (4 * years);
  }
  return [r2(deposited), r2(worth)];
}

function refreshRDs(t, today) {
  let changed = 0;
  for (const rd of t.assets.filter(a => a.category === 'RD' && a.installment != null && a.start_date)) {
    const [deposited, worth] = recurringDeposit(rd.installment, rd.interest_rate, rd.start_date, rd.maturity_date, today);
    if (deposited !== r2(rd.invested_value || 0) || worth !== r2(rd.current_value || 0)) {
      Object.assign(rd, { invested_value: deposited, current_value: worth, last_updated: today });
      changed++;
    }
  }
  return changed;
}

function latestSnapshot(t) {
  let best = null;
  for (const s of t.snapshots) if (!best || s.date > best.date) best = s;
  return best;
}

/** invest.update_latest_portfolio_snapshot: the latest day's manual totals, right away. */
function updateLatestSnapshot(t) {
  let snap = latestSnapshot(t);
  if (!snap) {
    if (!t.assets.length) return;
    snap = newSnapshot(istToday());
    t.snapshots.push(snap);
  }
  setManualTotals(snap, t.assets);
}

const amountOrZero = (v) => { const n = Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? 0 : n; };
const optNumber = (v) => (v ? Number(v) : null);
const optDay = (v) => (v ? String(v).slice(0, 10) : null);

function rdFields(data, asset) {
  const installment = Number(data.installment) || 0;
  if (installment <= 0) return 'Enter the monthly instalment';
  if (!asset.start_date) return 'Enter the date of the first instalment';
  asset.installment = installment;
  [asset.invested_value, asset.current_value] = recurringDeposit(installment, asset.interest_rate, asset.start_date, asset.maturity_date, istToday());
  return null;
}

function newTask(name, data, idOffset = 0) {
  return {
    id: newId() + idOffset, asset_name: name, amount_to_add: Number(data.amount_to_add),
    interval_value: parseInt(data.interval_value ?? 1, 10) || 1, interval_unit: data.interval_unit || 'months',
    next_run_date: optDay(data.next_run_date), is_active: true,
  };
}

function processRecurring(t, today) {
  let processed = 0;
  for (const a of t.assets.filter(a => a.interest_rate != null && a.start_date && a.category !== 'RD')) {
    const end = a.maturity_date ? minDay(today, a.maturity_date) : today;
    const days = daysBetween(a.start_date, end);
    if (days > 0) {
      const value = a.invested_value * (1 + a.interest_rate / 100 / 4) ** (4 * (days / 365.25));
      if (r2(value) > a.current_value) {
        a.current_value = r2(value);
        a.last_updated = today;
        processed++;
      }
    }
  }
  for (const task of t.tasks.filter(x => x.is_active && x.next_run_date && x.next_run_date <= today)) {
    const asset = t.assets.find(a => a.name === task.asset_name);
    if (!asset) continue;
    asset.invested_value += task.amount_to_add;
    if (!asset.interest_rate) asset.current_value += task.amount_to_add;
    asset.last_updated = today;
    const n = task.interval_value || 1;
    task.next_run_date = task.interval_unit === 'days' ? addDays(task.next_run_date, n)
      : task.interval_unit === 'years' ? addMonths(task.next_run_date, 12 * n)
        : addMonths(task.next_run_date, n);
    processed++;
  }
  processed += refreshRDs(t, today);
  if (processed > 0) updateLatestSnapshot(t);
  return processed;
}

function snapshotRow(r) {
  const pct = (curr, inv) => (inv > 0 ? (curr - inv) / inv * 100 : 0);
  return {
    id: r.id, date: r.date,
    inv_stocks: r.total_equity_inv, curr_stocks: r.total_equity_curr,
    inv_mf: r.total_mf_inv, curr_mf: r.total_mf_curr,
    total_inv: r.grand_total_inv, total_curr: r.grand_total_curr,
    inv_fixed: r.total_fixed_income_inv, curr_fixed: r.total_fixed_income_curr,
    inv_prov: r.total_provident_inv, curr_prov: r.total_provident_curr,
    inv_gold: r.total_gold_inv, curr_gold: r.total_gold_curr,
    ret_pct_stocks: pct(r.total_equity_curr, r.total_equity_inv),
    ret_pct_mf: pct(r.total_mf_curr, r.total_mf_inv),
    total_ret_pct: pct(r.grand_total_curr, r.grand_total_inv),
    status_stocks: '', status_mf: '', total_status: '',
  };
}

const retPct = (curr, inv) => (inv > 0 ? (curr - inv) / inv * 100 : 0);

/** pyxirr's XIRR: the yearly rate (Actual/365) that makes the flows' present value zero; null if none. */
function xirr(days, amounts) {
  const t0 = dayMs(days[0]);
  const years = days.map(d => (dayMs(d) - t0) / (365 * 86400000));
  const npv = (r) => amounts.reduce((s, a, i) => s + a / (1 + r) ** years[i], 0);
  const slope = (r) => amounts.reduce((s, a, i) => s - years[i] * a / (1 + r) ** (years[i] + 1), 0);
  let r = 0.1;
  for (let i = 0; i < 100; i++) {
    const f = npv(r), d = slope(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    const next = r - f / d;
    if (next <= -1) break;
    if (Math.abs(next - r) < 1e-10) return next;
    r = next;
  }
  let lo = -0.9999, hi = 100;           // bisection when Newton wanders
  if (npv(lo) * npv(hi) > 0) return null;
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2;
    if (npv(lo) * npv(mid) <= 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---- CAS statements ----

async function importStatement(t, cas, today) {
  const periodTo = cas.period.to;
  const kite = kiteTrackedNames(t);
  const { byCode, byIsin } = await navs();
  const summary = { added: [], updated: [], closed: [], skipped_kite: [], unknown: [], period: cas.period };
  for (const folio of cas.folios || []) {
    for (const s of folio.schemes || []) {
      const scheme = byCode[String(s.amfi || '')] || byIsin[String(s.isin || '')];
      if (!scheme) { summary.unknown.push(s.scheme); continue; }
      if (kite.has(scheme.name.toLowerCase())) { summary.skipped_kite.push(scheme.name); continue; }
      let fund = t.funds.find(f => f.amfi_code === scheme.code && f.folio_ref === folio.ref);
      const isNew = !fund;
      if (isNew) {
        fund = { id: newId(), amfi_code: scheme.code, isin: null, name: scheme.name, amc: null, folio_ref: folio.ref,
          folio_tail: null, units: 0, invested: 0, source: 'cas', statement_to: null, updated_at: null };
        t.funds.push(fund);
      }
      Object.assign(fund, {
        name: scheme.name, isin: s.isin || fund.isin, amc: folio.amc || scheme.amc, folio_tail: folio.tail, source: 'cas',
        statement_to: fund.statement_to && fund.statement_to > periodTo ? fund.statement_to : periodTo,
        updated_at: istNow(),
      });
      const existing = new Set(t.fund_tx.filter(x => x.fund_id === fund.id).map(x => x.key));
      const seen = new Map();
      for (const x of s.transactions || []) {
        const ident = [x.date, x.kind, pyStr(x.amount), pyStr(x.units)].join('|');
        seen.set(ident, (seen.get(ident) || 0) + 1);   // two identical rows on one day are both real
        const key = await fundKey('cas', folio.ref, scheme.code, x.date, x.kind, pyStr(x.amount), pyStr(x.units), seen.get(ident));
        if (existing.has(key)) continue;
        existing.add(key);
        t.fund_tx.push({ id: newId(), fund_id: fund.id, date: x.date, kind: x.kind, amount: x.amount, units: x.units,
          nav: x.nav, source: 'cas', key });
      }
      // The statement is the truth up to its last day: instalments added for
      // days it covers give way to it; later ones stay on top.
      t.fund_tx = t.fund_tx.filter(x => !(x.fund_id === fund.id && x.source === 'sip' && x.date <= periodTo));
      const later = t.fund_tx.filter(x => x.fund_id === fund.id && x.source === 'sip' && x.date > periodTo);
      const close = Number(s.close);
      fund.units = r3(close + sum(later, x => x.units));
      fund.invested = (s.cost !== null && s.cost !== undefined ? s.cost : Number(fund.invested || 0)) + sum(later, x => x.amount);
      // Added by hand before: the statement has all of it now.
      const byHand = t.funds.find(f => f.amfi_code === scheme.code && f.folio_ref === MANUAL_FOLIO);
      if (byHand) {
        for (const sip of t.sips) if (sip.fund_id === byHand.id) sip.fund_id = fund.id;
        t.fund_tx = t.fund_tx.filter(x => x.fund_id !== byHand.id);
        t.funds = t.funds.filter(f => f !== byHand);
      }
      if (close <= 0 && !later.length) {
        fund.invested = 0;
        summary.closed.push(scheme.name);
      } else {
        summary[isNew ? 'added' : 'updated'].push(scheme.name);
      }
    }
  }
  await valueFunds(t, today);
  return summary;
}

// ---- requests ----

const MAX_AMOUNT = 10_00_00_000;
const parseAmount = (v) => {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return null;
  const a = r2(n);
  return a > 0 && a <= MAX_AMOUNT ? a : null;
};
const parseDay = (v) => (isDay(v) ? String(v) : null);

function sipFields(body) {
  const amount = parseAmount(body.amount);
  const day = parseInt(body.day, 10) || 0;
  const since = parseDay(body.since) || istToday();
  if (amount === null) return [null, 'Enter the SIP amount'];
  if (!(day >= 1 && day <= 31)) return [null, 'Pick the SIP day (1–31)'];
  if (since > istToday()) return [null, 'A SIP can’t start in the future'];
  return [{ amount, day, since }, null];
}

function startSip(t, fund, { amount, day, since }) {
  t.sips.push({ id: newId(), fund_id: fund.id, amount, day, next_date: firstInstalment(day, since), active: true });
}

/**
 * The answer to one Investments request, from the opened vault:
 * {status, body}, or null when it isn't one of them.
 * `vault` is store.js: {transact, current}. `readOnly`: a friend's vault.
 */
export async function handle(vault, method, path, query, body, readOnly) {
  const read = () => vault.current().tables;
  const write = (fn) => vault.transact(fn);
  const ok = (b) => ({ status: 200, body: b });
  const today = istToday();
  let m;
  try {
    // ---- portfolio ----
    if (method === 'GET' && path === '/investments') {
      if (!readOnly) {
        const fresh = query.get('refresh') === '1';
        await write(t => tidyFundDays(t)).catch(() => {});
        await write(t => repriceIfDue(t, fresh)).catch(() => {});
        await write(t => refreshFunds(t, fresh)).catch(() => {});
        await write(t => refreshStocks(t, fresh)).catch(() => {});
        await write(t => { if (refreshRDs(t, today)) updateLatestSnapshot(t); }).catch(() => {});
      }
      const rows = [...read().snapshots].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return ok(rows.map(snapshotRow));
    }
    if (method === 'POST' && path === '/cron/process-recurring') {
      if (readOnly) return ok({ success: true, processed: 0 });
      return ok({ success: true, processed: await write(t => processRecurring(t, today)) });
    }
    if (method === 'GET' && path === '/investments/xirr') {
      const { flows } = await vaultCall('GET', '/vault/xirr-flows');
      const latest = latestSnapshot(read());
      if (!flows.length || !latest) return ok({ success: true, xirr: 0.0 });
      const rate = xirr([...flows.map(f => f[0]), today], [...flows.map(f => f[1]), latest.grand_total_curr]);
      return ok({ success: true, xirr: rate ? r2(rate * 100) : 0.0 });
    }
    if (method === 'GET' && path === '/investments/prices') return ok(await priceTimes(read()));
    if (method === 'GET' && path === '/investments/history') {
      const t = read(), symbol = query.get('symbol'), type = query.get('type');
      if (!symbol || !type) return ok([]);
      const point = (date, current, invested) => ({ date, Current: current, Invested: invested });
      const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
      if (type === 'EQUITY') {
        return ok([
          ...t.equity.filter(e => e.symbol === symbol).sort(byDate).map(e => point(e.date, e.current_value, e.invested_value)),
          ...t.stock_values.filter(s => s.symbol === symbol).sort(byDate).map(s => point(s.date, s.value, s.invested)),
        ].sort(byDate));
      }
      if (type === 'MF') {
        const data = [
          ...t.mf.filter(h => h.symbol === symbol).sort(byDate).map(h => point(h.date, h.current_value, h.invested_value)),
          ...t.fund_values.filter(f => f.name === symbol).sort(byDate).map(f => point(f.date, f.value, f.invested)),
        ];
        return ok(data.sort(byDate));
      }
      const asset = t.assets.find(a => a.name === symbol);
      return ok(asset ? [point(asset.last_updated, asset.current_value, asset.invested_value),
        point(today, asset.current_value, asset.invested_value)] : []);
    }
    if (method === 'GET' && path === '/assets/list') {
      const t = read();
      const latest = (rows) => rows.reduce((d, r) => (d === null || r.date > d ? r.date : d), null);
      const eqDay = latest(t.equity), mfDay = latest(t.mf), fundDay = latest(t.fund_values);
      const eq = [...(eqDay ? t.equity.filter(e => e.date === eqDay).map(e => e.symbol) : []), ...ownStocks(t, today).map(s => s.symbol)];
      const mf = [...(mfDay ? t.mf.filter(h => h.date === mfDay).map(h => h.symbol) : []),
        ...ownFunds(t, today).map(f => f.name)];
      const names = (cats) => t.assets.filter(a => cats.includes(a.category)).map(a => a.name);
      return ok({
        EQUITY: [...new Set(eq)].sort(), MF: [...new Set(mf)].sort(),
        PROVIDENT: names(['EPF', 'PPF', 'NPS']), FIXED_INCOME: names(['FD', 'RD', 'Cash']), GOLD: names(['SGB', 'RealEstate']),
      });
    }
    if (method === 'GET' && path === '/equity') {
      const t = read();
      const day = t.equity.reduce((d, r) => (d === null || r.date > d ? r.date : d), null);
      return ok([
        ...(day ? t.equity.filter(e => e.date === day).map(({ symbol, quantity, average_price, ltp, invested_value, current_value }) =>
          ({ symbol, quantity, average_price, ltp, invested_value, current_value })) : []),
        ...ownStocks(t, today).map(({ ret_pct: _, ...s }) => s),
      ]);
    }
    if ((m = path.match(/^\/investments\/(\d{4}-\d{2}-\d{2})\/(equity_holdings|holdings)$/)) && method === 'GET') {
      const t = read(), day = m[1], kiteDay = lastKiteDay(t, day);
      if (m[2] === 'equity_holdings') {
        return ok([...(kiteDay ? t.equity.filter(e => e.date === kiteDay) : []).map(h => ({
          symbol: h.symbol, quantity: h.quantity, average_price: h.average_price, ltp: h.ltp,
          invested_value: h.invested_value, current_value: h.current_value, ret_pct: retPct(h.current_value, h.invested_value),
        })), ...ownStocks(t, day)]);
      }
      return ok([
        ...(kiteDay ? t.mf.filter(h => h.date === kiteDay) : []).map(h => ({
          symbol: h.symbol, quantity: h.quantity, average_price: h.average_price, nav: h.nav,
          invested_value: h.invested_value, current_value: h.current_value, ret_pct: retPct(h.current_value, h.invested_value),
        })),
        ...ownFunds(t, day).map(f => ({
          symbol: f.name, quantity: f.units, average_price: f.units ? Math.round(f.invested / f.units * 10000) / 10000 : 0,
          nav: f.nav, invested_value: f.invested, current_value: f.value, ret_pct: retPct(f.value, f.invested),
        })),
      ]);
    }
    if ((m = path.match(/^\/investments\/([^/]+)$/)) && method === 'DELETE') {
      if (!isDay(m[1])) throw new Refused('That isn’t a date');
      return ok(await write(t => {
        if (!t.snapshots.some(s => s.date === m[1])) throw new Refused('No snapshot that day', 404);
        for (const name of ['snapshots', 'equity', 'mf', 'fund_values', 'stock_values']) t[name] = t[name].filter(r => r.date !== m[1]);
        return { success: true };
      }));
    }

    // ---- manual assets and automations ----
    if (path === '/manual_assets' && method === 'GET') {
      const t = read();
      const tasks = new Map(t.tasks.map(x => [x.asset_name, x]));
      const sorted = [...t.assets].sort((a, b) => (a.category < b.category ? -1 : a.category > b.category ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return ok(sorted.map(a => {
        const task = tasks.get(a.name);
        return {
          id: a.id, category: a.category, name: a.name, invested_value: a.invested_value, current_value: a.current_value,
          interest_rate: a.interest_rate, start_date: a.start_date, maturity_date: a.maturity_date, last_updated: a.last_updated,
          installment: a.installment, is_recurring: !!task,
          amount_to_add: task ? task.amount_to_add : null, interval_value: task ? task.interval_value : null,
          interval_unit: task ? task.interval_unit : null, next_run_date: task ? task.next_run_date : null,
        };
      }));
    }
    if (path === '/manual_assets' && method === 'POST') {
      return ok(await write(t => {
        const invested = amountOrZero(body.invested_value);
        const asset = {
          id: newId(), category: body.category, name: body.name, invested_value: invested,
          current_value: amountOrZero(body.current_value) || invested, interest_rate: optNumber(body.interest_rate),
          start_date: optDay(body.start_date), maturity_date: optDay(body.maturity_date), last_updated: today, installment: null,
        };
        if (asset.category === 'RD') {
          const error = rdFields(body, asset);
          if (error) throw new Refused(error);
        }
        t.assets.push(asset);
        if (body.is_recurring && asset.category !== 'RD') t.tasks.push(newTask(body.name, body, 1));
        updateLatestSnapshot(t);
        return { success: true, message: 'Asset & Automation added successfully' };
      }));
    }
    if ((m = path.match(/^\/manual_assets\/(\d+)$/)) && (method === 'PUT' || method === 'DELETE')) {
      const id = Number(m[1]);
      return ok(await write(t => {
        const asset = t.assets.find(a => a.id === id);
        if (!asset) throw new Refused('Asset not found', 404);
        if (method === 'DELETE') {
          t.assets = t.assets.filter(a => a !== asset);
          updateLatestSnapshot(t);
          return { success: true };
        }
        const oldName = asset.name;
        Object.assign(asset, {
          category: body.category, name: body.name, invested_value: amountOrZero(body.invested_value),
          current_value: amountOrZero(body.current_value), interest_rate: optNumber(body.interest_rate),
          start_date: optDay(body.start_date), maturity_date: optDay(body.maturity_date), last_updated: today,
        });
        if (asset.category === 'RD') {
          const error = rdFields(body, asset);
          if (error) throw new Refused(error);
        } else {
          asset.installment = null;
        }
        const task = t.tasks.find(x => x.asset_name === oldName);
        if (body.is_recurring && asset.category !== 'RD') {
          if (task) {
            Object.assign(task, {
              asset_name: asset.name, amount_to_add: Number(body.amount_to_add),
              interval_value: parseInt(body.interval_value ?? 1, 10) || 1, interval_unit: body.interval_unit || 'months',
              next_run_date: optDay(body.next_run_date),
            });
          } else {
            t.tasks.push(newTask(asset.name, body, 1));
          }
        } else if (task) {
          t.tasks = t.tasks.filter(x => x !== task);
        }
        updateLatestSnapshot(t);
        return { success: true };
      }));
    }
    if (path === '/cron/tasks' && method === 'GET') {
      return ok(read().tasks.map(x => ({ id: x.id, asset_name: x.asset_name, amount_to_add: x.amount_to_add,
        interval_value: x.interval_value, interval_unit: x.interval_unit, next_run_date: x.next_run_date, is_active: x.is_active })));
    }
    if (path === '/cron/tasks' && method === 'POST') {
      return ok(await write(t => {
        t.tasks.push({ ...newTask(body.asset_name, body), interval_value: parseInt(body.interval_months ?? body.interval_value ?? 1, 10) || 1 });
        return { success: true, message: 'Automation added' };
      }));
    }
    if ((m = path.match(/^\/cron\/tasks\/(\d+)$/)) && method === 'DELETE') {
      const id = Number(m[1]);
      return ok(await write(t => {
        if (!t.tasks.some(x => x.id === id)) throw new Refused('Task not found', 404);
        t.tasks = t.tasks.filter(x => x.id !== id);
        return { success: true };
      }));
    }

    // ---- Kite and Sheets ----
    if (path === '/sync/kite' && method === 'POST') {
      return ok(await write(async t => {
        const done = t.equity.concat(t.mf).some(h => h.date === today && !h.repriced);
        if (done) return { success: false, message: `Already synced investments for ${today.split('-').reverse().join('/')}!` };
        let got;
        try {
          got = await vaultCall('POST', '/vault/kite', { request_token: body?.request_token });
        } catch (e) {
          return { success: false, message: e.message };
        }
        const base = Date.now();
        t.equity = t.equity.filter(e => !(e.date === today && e.repriced));
        t.mf = t.mf.filter(h => !(h.date === today && h.repriced));
        got.funds.forEach((f, i) => t.mf.push({ id: base + i, date: today, ...f, repriced: false }));
        got.stocks.forEach(({ token, ...e }, i) => t.equity.push({ id: base + (token ?? i), date: today, ...e, repriced: false }));
        recomputeSnapshot(t, today);
        return { success: true, message: 'Successfully synced Combined Portfolio!' };
      }));
    }
    if (path === '/sync/investments-to-sheets' && method === 'POST') {
      return ok({ success: false, message: 'Your investments are in your private vault, so they aren’t sent to Google Sheets.' });
    }

    // ---- stocks and ETFs added by hand (stocks.py) ----
    const stocksDone = async (t, extra = {}) => {
      await valueStocks(t, today);
      return { success: true, ...extra, stocks: stocksOverview(t), quoted_at: t.state.stocks_quoted_at || null };
    };
    if (path === '/stocks' && method === 'GET') {
      if (!readOnly) await write(t => refreshStocks(t, false)).catch(() => {});
      const t = read();
      return ok({ success: true, stocks: stocksOverview(t), quoted_at: t.state.stocks_quoted_at || null });
    }
    if (path === '/stocks/search' && method === 'GET') {
      const q = (query.get('q') || '').trim();
      if (q.length < 2) return ok({ success: true, results: [] });
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const upper = q.toUpperCase();
      const hits = (await listedStocks()).filter(r => words.every(w => r.symbol.toLowerCase().includes(w) || r.name.toLowerCase().includes(w)));
      const rank = (r) => [r.symbol !== upper, !r.symbol.startsWith(upper), r.name.toLowerCase()];
      hits.sort((a, b) => {
        const x = rank(a), y = rank(b);
        for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
        return 0;
      });
      return ok({ success: true, results: hits.slice(0, 20) });
    }
    const tradeFields = (b) => {
      const day = b?.date === undefined || b?.date === null || b?.date === '' ? today : (isDay(b.date) ? b.date : null);
      if (day === null) throw new Refused('That isn’t a date');
      const num = (v) => { const n = Number(v); return v === null || v === '' || !Number.isFinite(n) ? 0 : n; };
      return { day, quantity: num(b?.quantity), price: num(b?.price) };
    };
    if (path === '/stocks' && method === 'POST') {
      const listed = (await listedStocks()).find(r => r.symbol === String(body?.symbol || '').trim().toUpperCase());
      if (!listed) throw new Refused('Pick a stock from the search');
      return ok(await write(async t => {
        const kiteDay = t.equity.reduce((d, r) => (d === null || r.date > d ? r.date : d), null);
        if (kiteDay && t.equity.some(e => e.date === kiteDay && e.symbol.toUpperCase() === listed.symbol)) throw new Refused('Kite already tracks this stock', 409);
        let stock = t.stocks.find(s => s.symbol === listed.symbol);
        if (!stock) {
          stock = { id: newId(), symbol: listed.symbol, name: listed.name, isin: listed.isin, quantity: 0, invested: 0, updated_at: istNow() };
          t.stocks.push(stock);
        }
        const { day, quantity, price } = tradeFields(body);
        stockTrade(t, stock, 'BUY', quantity, price, day);
        return stocksDone(t, { added: stock.symbol });
      }));
    }
    if ((m = path.match(/^\/stocks\/([^/]+)\/trades$/)) && method === 'POST') {
      const symbol = decodeURIComponent(m[1]).toUpperCase();
      return ok(await write(async t => {
        const stock = t.stocks.find(s => s.symbol === symbol);
        if (!stock) throw new Refused('No such stock', 404);
        const { day, quantity, price } = tradeFields(body);
        stockTrade(t, stock, String(body?.kind || '').toUpperCase(), quantity, price, day);
        return stocksDone(t);
      }));
    }
    const removeStock = (t, stock) => {
      t.stock_trades = t.stock_trades.filter(x => x.stock_id !== stock.id);
      t.stock_values = t.stock_values.filter(v => v.symbol !== stock.symbol);
      t.stocks = t.stocks.filter(s => s !== stock);
    };
    if ((m = path.match(/^\/stocks\/([^/]+)\/trades\/(\d+)$/)) && method === 'DELETE') {
      const symbol = decodeURIComponent(m[1]).toUpperCase(), id = Number(m[2]);
      return ok(await write(async t => {
        const stock = t.stocks.find(s => s.symbol === symbol);
        if (!stock || !t.stock_trades.some(x => x.id === id && x.stock_id === stock.id)) throw new Refused('No such trade', 404);
        t.stock_trades = t.stock_trades.filter(x => x.id !== id);
        const left = t.stock_trades.filter(x => x.stock_id === stock.id);
        try {
          replayStock(stock, left);
        } catch (e) {
          throw new Refused(`${e.message}, so that buy can’t go`);
        }
        if (!left.length) removeStock(t, stock);
        return stocksDone(t);
      }));
    }
    if ((m = path.match(/^\/stocks\/([^/]+)$/)) && method === 'DELETE') {
      const symbol = decodeURIComponent(m[1]).toUpperCase();
      return ok(await write(async t => {
        const stock = t.stocks.find(s => s.symbol === symbol);
        if (!stock) throw new Refused('No such stock', 404);
        removeStock(t, stock);
        return stocksDone(t);
      }));
    }

    // ---- funds held outside Kite (funds.py) ----
    const done = async (t, extra = {}) => {
      await valueFunds(t, today);
      return { success: true, ...extra, funds: await fundsOverview(t) };
    };
    if (path === '/funds' && method === 'GET') {
      if (!readOnly) await write(t => refreshFunds(t, false)).catch(() => {});
      return ok({ success: true, funds: await fundsOverview(read()) });
    }
    if (path === '/funds/search' && method === 'GET') {
      const q = (query.get('q') || '').trim();
      if (q.length < 2) return ok({ success: true, results: [] });
      const { byCode, newest } = await navs();
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const live = addDays(newest || today, -30);
      const hits = Object.values(byCode).filter(s => s.date >= live && words.every(w =>
        s.full_name.toLowerCase().includes(w) || (s.amc || '').toLowerCase().includes(w)));
      const rank = (s) => [!s.full_name.toLowerCase().includes('direct'), !s.full_name.toLowerCase().includes('growth'), s.full_name];
      hits.sort((a, b) => {
        const x = rank(a), y = rank(b);
        for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
        return 0;
      });
      return ok({ success: true, results: hits.slice(0, 20).map(s => ({ code: s.code, name: s.full_name, amc: s.amc, nav: s.nav, nav_date: s.date })) });
    }
    if (path === '/funds' && method === 'POST') {
      const scheme = (await navs()).byCode[String(body.code || '')];
      if (!scheme) throw new Refused('Pick a fund from the search');
      return ok(await write(async t => {
        if (kiteTrackedNames(t).has(scheme.name.toLowerCase())) throw new Refused('Kite already tracks this fund', 409);
        // What's held already, as a fund app shows it: units at an average NAV.
        const given = (v) => v !== null && v !== undefined && v !== '';
        const positive = (v, most) => { const n = Number(v); return given(v) && Number.isFinite(n) && n > 0 && n <= most ? n : null; };
        const holding = given(body.units) || given(body.avg_nav);
        const units = positive(body.units, 1_00_00_00_000), avgNav = positive(body.avg_nav, 10_00_000);
        if (holding && units === null) throw new Refused('Enter the units you hold');
        if (holding && avgNav === null) throw new Refused('Enter the average NAV');
        const lumpsum = body.amount !== null && body.amount !== undefined && body.amount !== '';
        const amount = parseAmount(body.amount), day = parseDay(body.date) || today;
        if (lumpsum && amount === null) throw new Refused('Enter the amount invested');
        if (lumpsum && day > today) throw new Refused('That date is in the future');
        const [sip, error] = body.sip ? sipFields(body.sip) : [null, null];
        if (error) throw new Refused(error);
        if (!lumpsum && !holding && !sip) throw new Refused('Enter what you hold, an amount, or a SIP');
        // A SIP belongs with the statement's folio when there is one.
        let fund = sip && !lumpsum && !holding
          ? t.funds.filter(f => f.amfi_code === scheme.code && f.folio_ref !== MANUAL_FOLIO).sort((a, b) => b.units - a.units)[0]
          : null;
        if (!fund) {
          fund = t.funds.find(f => f.amfi_code === scheme.code && f.folio_ref === MANUAL_FOLIO);
          if (!fund) {
            fund = { id: newId(), amfi_code: scheme.code, isin: scheme.isins[0] || null, name: scheme.name, amc: scheme.amc,
              folio_ref: MANUAL_FOLIO, folio_tail: null, units: 0, invested: 0, source: 'manual', statement_to: null, updated_at: istNow() };
            t.funds.push(fund);
          }
        }
        if (holding) {
          const amountHeld = r2(units * avgNav);
          t.fund_tx.push({ id: newId(), fund_id: fund.id, date: today, kind: 'HOLDING', amount: amountHeld, units, nav: avgNav,
            source: 'manual', key: await fundKey('holding', fund.id, today, pyStr(units), pyStr(avgNav), Date.now() / 1000) });
          fund.units = r3((fund.units || 0) + units);
          fund.invested = Number(fund.invested || 0) + amountHeld;
        }
        if (lumpsum) {
          const priced = await navOn(fund.amfi_code, day);
          if (!priced) throw new Refused('That day’s NAV isn’t out yet', 503);
          const units = purchaseUnits(amount, priced[1]);
          t.fund_tx.push({ id: newId(), fund_id: fund.id, date: day, kind: 'PURCHASE', amount, units, nav: priced[1],
            source: 'manual', key: await fundKey('manual', fund.id, day, pyStr(amount), Date.now() / 1000) });
          fund.units = r3((fund.units || 0) + units);
          fund.invested = Number(fund.invested || 0) + amount;
        }
        if (sip) {
          startSip(t, fund, sip);
          await processSips(t, today);
        }
        return done(t, { added: scheme.name });
      }));
    }
    if ((m = path.match(/^\/funds\/sips\/(\d+)$/)) && method === 'DELETE') {
      const id = Number(m[1]);
      return ok(await write(async t => {
        const sip = t.sips.find(s => s.id === id);
        if (!sip) throw new Refused('No such SIP', 404);
        sip.active = false;
        return { success: true, funds: await fundsOverview(t) };
      }));
    }
    if ((m = path.match(/^\/funds\/([^/]+)\/sip$/)) && method === 'POST') {
      const code = decodeURIComponent(m[1]);
      const [sip, error] = sipFields(body || {});
      if (error) throw new Refused(error);
      return ok(await write(async t => {
        const fund = t.funds.filter(f => f.amfi_code === code)
          .sort((a, b) => ((a.folio_ref === MANUAL_FOLIO) - (b.folio_ref === MANUAL_FOLIO)) || (b.units - a.units))[0];
        if (!fund) throw new Refused('No such fund', 404);
        startSip(t, fund, sip);
        await processSips(t, today);
        return done(t);
      }));
    }
    if ((m = path.match(/^\/funds\/([^/]+)$/)) && method === 'DELETE' && m[1] !== 'import') {
      const code = decodeURIComponent(m[1]);
      return ok(await write(async t => {
        const ids = new Set(t.funds.filter(f => f.amfi_code === code).map(f => f.id));
        if (!ids.size) throw new Refused('No such fund', 404);
        t.sips = t.sips.filter(s => !ids.has(s.fund_id));
        t.fund_tx = t.fund_tx.filter(x => !ids.has(x.fund_id));
        t.fund_values = t.fund_values.filter(v => v.amfi_code !== code);
        t.funds = t.funds.filter(f => !ids.has(f.id));
        return done(t);
      }));
    }
    if (path === '/funds/import' && method === 'POST') {
      // The PDF is read on the server and handed straight back (blueprints/vault.py).
      const res = await fetch(`${API}/vault/cas`, { method: 'POST', headers: { 'Authorization': `Bearer ${getToken()}` }, body });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) return { status: res.ok ? 400 : res.status, body: { success: false, message: json.message || 'Couldn’t read that PDF' } };
      return ok(await write(async t => {
        const summary = await importStatement(t, json.cas, today);
        return { success: true, ...summary, funds: await fundsOverview(t) };
      }));
    }
  } catch (e) {
    if (e instanceof Refused) return { status: e.status, body: { success: false, message: e.message } };
    return { status: e.status && e.status >= 400 ? e.status : 500, body: { success: false, message: e.message || 'Something went wrong' } };
  }
  return null;
}

/** What a locked vault answers: empty, so pages still load, and writes wait for the unlock. */
export function lockedAnswer(method, path) {
  if (method === 'GET') {
    if (path === '/assets/list') return { status: 200, body: {} };
    if (path === '/investments/xirr') return { status: 200, body: { success: true, xirr: 0 } };
    if (path === '/investments/prices') return { status: 200, body: { mode: 'manual', synced: null, stocks_at: null, checked_at: null, stale: false, closed_today: false } };
    if (path === '/funds') return { status: 200, body: { success: true, funds: [] } };
    if (path === '/stocks') return { status: 200, body: { success: true, stocks: [], quoted_at: null } };
    if (path === '/stocks/search') return { status: 200, body: { success: true, results: [] } };
    if (path === '/funds/search') return { status: 200, body: { success: true, results: [] } };
    return { status: 200, body: [] };
  }
  if (path === '/cron/process-recurring') return { status: 200, body: { success: true, processed: 0 } };
  return { status: 423, body: { success: false, message: 'Unlock your private vault first (Investments, 🔒)' } };
}

/** Whether a path is one of the Investments requests the vault answers. */
export const isInvestPath = (path) => /^\/(investments(\/|$)|manual_assets(\/|$)|assets\/list$|equity$|cron\/(process-recurring|tasks)(\/|$)|sync\/(kite|investments-to-sheets)$|funds(\/|$)|stocks(\/|$))/.test(path);
