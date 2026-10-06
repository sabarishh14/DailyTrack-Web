import { fmt } from '../utils';

// A recurring deposit's terms, shared by the add and edit asset windows. The
// sums mirror the backend's (invest.recurring_deposit): one instalment a month
// from the first, each compounding quarterly from its own day, until maturity.

const parseDay = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** The first instalment's date plus k months; a short month takes its last day. */
const instalment = (startIso, k) => {
  const [y, m, d] = startIso.split('-').map(Number);
  const lastDay = new Date(y, m - 1 + k + 1, 0).getDate();
  return new Date(y, m - 1 + k, Math.min(d, lastDay));
};

export function rdPosition(installment, rate, startIso, maturityIso, on) {
  const amount = Number(installment);
  if (!amount || !startIso) return null;
  const today = on || new Date(new Date().setHours(0, 0, 0, 0));
  const maturity = maturityIso ? parseDay(maturityIso) : null;
  const end = maturity && maturity < today ? maturity : today;
  let deposited = 0;
  let worth = 0;
  for (let k = 0; k < 1200; k++) {
    const due = instalment(startIso, k);
    if (due > end || (maturity && due >= maturity)) break;
    const years = Math.round((end - due) / 86400000) / 365.25;
    deposited += amount;
    worth += amount * Math.pow(1 + (Number(rate) || 0) / 400, 4 * years);
  }
  return { deposited, worth };
}

export default function RdFields({ form, setForm }) {
  const now = rdPosition(form.installment, form.interest_rate, form.start_date, form.maturity_date);
  const atMaturity = form.maturity_date
    ? rdPosition(form.installment, form.interest_rate, form.start_date, form.maturity_date, parseDay(form.maturity_date))
    : null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <label style={{ fontSize: '0.75rem', color: 'var(--text2)', fontWeight: 600 }}>Monthly instalment (₹)</label>
      <input className="inp" type="number" placeholder="e.g. 5000" value={form.installment ?? ''}
             onChange={e => setForm({ ...form, installment: e.target.value })} />
      {now ? (
        <div className="rd-preview">
          <span>Deposited <b>{fmt(Math.round(now.deposited))}</b></span>
          <span>Worth today <b>{fmt(Math.round(now.worth))}</b></span>
          {atMaturity && <span>At maturity <b>{fmt(Math.round(atMaturity.worth))}</b></span>}
        </div>
      ) : (
        <span style={{ fontSize: '0.7rem', color: 'var(--text3)' }}>Adds itself every month; interest is worked out on each instalment.</span>
      )}
    </div>
  );
}
