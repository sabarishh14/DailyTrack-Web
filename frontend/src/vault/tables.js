// The vault's contents: the same tables the server kept readable (rows with
// the same fields), split into items to lock away. A month of days per item,
// so a day's update re-locks one small item, not years of history.
import { sha256Hex } from './crypto';

export const TABLES = ['snapshots', 'equity', 'mf', 'assets', 'tasks', 'funds', 'fund_tx', 'sips', 'fund_values'];
const DAILY = ['snapshots', 'equity', 'mf', 'fund_values'];

export function emptyTables() {
  const t = Object.fromEntries(TABLES.map(name => [name, []]));
  t.state = { priced_at: null, quoted_at: null, quotes_seen_at: null };
  return t;
}

/** {item id: value}: "assets", "funds", "state", and "day:YYYY-MM" for each month. */
export function toItems(t) {
  const items = {
    assets: { assets: t.assets, tasks: t.tasks },
    funds: { funds: t.funds, fund_tx: t.fund_tx, sips: t.sips },
    state: t.state,
  };
  for (const name of DAILY) {
    for (const row of t[name]) {
      const id = `day:${String(row.date).slice(0, 7)}`;
      items[id] ||= Object.fromEntries(DAILY.map(n => [n, []]));
      items[id][name].push(row);
    }
  }
  return items;
}

export function fromItems(values) {
  const t = emptyTables();
  for (const [id, value] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (id === 'state') t.state = { ...t.state, ...value };
    else for (const [name, rows] of Object.entries(value || {})) if (t[name]) t[name].push(...rows);
  }
  return t;
}

const byId = (rows) => [...rows].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0));

/** {table: {count, ids}}, worked out as the server does (blueprints/vault.py). */
export async function fingerprints(t) {
  const out = {};
  for (const name of TABLES) {
    const ids = t[name].map(r => String(r.id)).sort();
    out[name] = { count: ids.length, ids: await sha256Hex(ids.join(',')) };
  }
  return out;
}

/** Whether two copies hold exactly the same rows. */
export function sameTables(a, b) {
  return TABLES.every(name => JSON.stringify(byId(a[name])) === JSON.stringify(byId(b[name])))
    && JSON.stringify(a.state) === JSON.stringify(b.state);
}
