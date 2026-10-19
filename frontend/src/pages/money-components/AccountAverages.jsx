import { fmt } from '../../utils';

// Under the analyser's donut when it's grouped by account: each account's latest
// month (normally this one) against its average over the 12 months before
// (/api/money/analyze, _account_months), and its last 6 months. Clicking one
// drills into it.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (iso) => MONTHS[Number(iso.slice(5, 7)) - 1];
const rupees = (n) => (n == null ? '—' : fmt(Math.round(n)));
const changeText = (change) => {
  if (change == null) return '—';
  const r = Math.round(change);
  return `${r > 0 ? '↑' : r < 0 ? '↓' : ''}${Math.abs(r)}%`;
};

function Sparkline({ values, color }) {
  const w = 76, h = 24, pad = 3;
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? (w - pad * 2) / (values.length - 1) : 0;
  const points = values.map((v, i) => [pad + i * step, h - pad - (v / max) * (h - pad * 2)]);
  const [lx, ly] = points[points.length - 1];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={points.map(p => p.join(',')).join(' ')} fill="none" stroke={color} strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={lx} cy={ly} r="2.6" fill={color} />
    </svg>
  );
}

/** stats: the analyser's "accounts"; colorFor: each account's donut colour; spending: a rise is bad news. */
export default function AccountAverages({ stats, colorFor, spending, onPick }) {
  if (!stats?.rows?.length) return null;
  const latest = stats.in_progress ? 'This month' : monthName(stats.latest);
  return (
    <div className="acct-avg">
      <div className="acct-avg-head">
        <h4>Per account</h4>
        <span>{stats.in_progress ? 'This month so far' : latest} against each one's average over the 12 months before</span>
      </div>
      <div className="acct-avg-row acct-avg-labels" aria-hidden="true">
        <span>Account</span><span>Avg / month</span><span>{latest}</span><span>vs avg</span>
        <span>{`${monthName(stats.months[0])}–${monthName(stats.months[stats.months.length - 1])}`}</span>
      </div>
      {stats.rows.map((row) => {
        const color = colorFor(row.account);
        const tone = row.change == null || Math.round(row.change) === 0 ? '' : (row.change > 0) === spending ? 'bad' : 'good';
        return (
          <button type="button" key={row.account} className="acct-avg-row" onClick={() => onPick(row.account)}
                  title={row.months ? `${row.account}: average over ${row.months} month${row.months === 1 ? '' : 's'}` : `${row.account}: new, nothing before to compare`}>
            <span className="acct-avg-name">
              <i style={{ background: color }} />
              <b>{row.account}</b>
              {row.share > 0 && <small>{row.share}%</small>}
            </span>
            <span className="acct-avg-num avg"><em>Avg</em>{rupees(row.average)}</span>
            <span className="acct-avg-num latest"><em>{latest}</em>{rupees(row.latest)}</span>
            <span className={`acct-avg-change ${tone}`}>{changeText(row.change)}</span>
            <span className="acct-avg-spark"><Sparkline values={row.trend} color={color} /></span>
          </button>
        );
      })}
    </div>
  );
}
