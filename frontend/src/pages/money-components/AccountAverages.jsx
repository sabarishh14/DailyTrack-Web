import { fmt } from '../../utils';

// Under the analyser's donut when it's grouped by account: each account's latest
// month (normally this one) next to its usual month, the average over the 12
// before (/api/money/analyze, _account_months). Clicking one drills into it.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (iso) => MONTHS[Number(iso.slice(5, 7)) - 1];
const rupees = (n) => (n == null ? '—' : fmt(Math.round(n)));

/** "↑ 21%" in a tinted pill: bad when spending rises (or income falls). */
function ChangePill({ change, spending }) {
  if (change == null) return <span className="acct-avg-change" />;
  const r = Math.round(change);
  const tone = r === 0 ? 'flat' : (r > 0) === spending ? 'bad' : 'good';
  return (
    <span className="acct-avg-change">
      <span className={`acct-pill ${tone}`}>{r > 0 ? '↑ ' : r < 0 ? '↓ ' : ''}{Math.abs(r)}%</span>
    </span>
  );
}

/** stats: the analyser's "accounts"; colorFor: each account's donut colour; spending: a rise is bad news. */
export default function AccountAverages({ stats, colorFor, spending, onPick }) {
  if (!stats?.rows?.length) return null;
  const latest = monthName(stats.latest);
  return (
    <div className="acct-avg">
      <div className="acct-avg-row acct-avg-labels" aria-hidden="true">
        <span className="l-name">Account</span><span className="l-avg">Avg / month</span>
        <span className="l-latest">{latest}</span><span className="l-change">vs avg</span>
      </div>
      {stats.rows.map((row) => (
        <button type="button" key={row.account} className="acct-avg-row" onClick={() => onPick(row.account)}
                title={row.months ? `${row.account}: average over ${row.months} month${row.months === 1 ? '' : 's'}` : `${row.account}: new, nothing before to compare`}>
          <span className="acct-avg-name">
            <i style={{ background: colorFor(row.account) }} />
            <b>{row.account}</b>
            {row.share > 0 && <small>{row.share}%</small>}
          </span>
          <span className="acct-avg-num avg">{row.average == null ? <em className="new">New</em> : <><em>Avg</em>{rupees(row.average)}</>}</span>
          <span className="acct-avg-num latest">{rupees(row.latest)}</span>
          <ChangePill change={row.change} spending={spending} />
        </button>
      ))}
    </div>
  );
}
