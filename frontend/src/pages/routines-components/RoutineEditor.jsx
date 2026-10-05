import { useMemo, useState } from 'react';
import { Modal } from './RoutineParts';
import { addDays, createRoutine, deleteRoutine, fillPast, parseDay, updateRoutine, weekday, dayMonth } from './routines';

// The phone's editor (RoutineEditorScreen.kt), on the web. Reminders stay on the
// phone: they're notifications it schedules itself.

const TEMPLATES = [
  { emoji: '🪥', name: 'Brush at night' },
  { emoji: '📖', name: 'Read 20 minutes' },
  { emoji: '🏋️', name: 'Gym', schedule: 'weekly', target: 4 },
  { emoji: '🍬', name: 'No sugar', kind: 'avoid', challengeDays: 30 },
  { emoji: '💧', name: 'Drink 3L water' },
  { emoji: '🧘', name: 'Meditate 10 minutes' },
  { emoji: '🚶', name: 'Walk 8,000 steps' },
  { emoji: '📵', name: 'No phone in bed', kind: 'avoid' },
];

const EMOJIS = [
  '✅', '🪥', '📖', '📚', '🏋️', '🏃', '🚶', '🚴', '🏊', '🧘', '🏸', '🏓',
  '🏏', '⚽', '💧', '🥗', '🍎', '🥛', '🍳', '🍬', '🍺', '☕', '🚭', '📵',
  '💤', '🛏️', '🌅', '🌙', '🧹', '🧺', '🌬️', '🪴', '🐶', '💊', '🦷', '🧴',
  '🛁', '💰', '📝', '🎸', '🎨', '🧠', '💻', '🙏', '📞', '❤️', '☀️', '🎯',
];

const SCHEDULES = [
  ['daily', 'Every day'], ['days', 'Some days'], ['weekly', 'Times a week'],
  ['monthly', 'Times a month'], ['interval', 'Chore'],
];
const UNITS = [['day', 'days'], ['week', 'weeks'], ['month', 'months']];
const CHALLENGE_LENGTHS = [7, 14, 21, 30, 60, 90];
const DAY_LETTERS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const WEEKDAYS = 0b0011111;
const WEEKENDS = 0b1100000;

const daysBetween = (from, to) => Math.round((parseDay(to) - parseDay(from)) / 86400000);

/** Every schedule's settings are kept, so switching back and forth loses nothing. */
function blankForm(today) {
  return {
    name: '', emoji: '✅', kind: 'build', schedule: 'daily', days: WEEKDAYS,
    weeklyTarget: 3, monthlyTarget: 4, every: 1, unit: 'week',
    startDate: today, isChallenge: false, challengeDays: 30,
  };
}

function formFromTemplate(t, startDate) {
  return {
    ...blankForm(startDate),
    name: t.name, emoji: t.emoji, kind: t.kind || 'build', schedule: t.schedule || 'daily',
    weeklyTarget: t.schedule === 'weekly' ? t.target : 3,
    monthlyTarget: t.schedule === 'monthly' ? t.target : 4,
    every: t.every || 1, unit: t.unit || 'week',
    isChallenge: !!t.challengeDays, challengeDays: t.challengeDays || 30,
  };
}

function formFromRoutine(r, today) {
  return {
    ...blankForm(today),
    name: r.name, emoji: r.emoji || '✅', kind: r.kind, schedule: r.schedule,
    days: r.days || WEEKDAYS,
    weeklyTarget: r.schedule === 'weekly' ? r.target : 3,
    monthlyTarget: r.schedule === 'monthly' ? r.target : 4,
    every: r.every || 1, unit: r.unit || 'week',
    startDate: r.start_date,
    isChallenge: !!r.end_date,
    challengeDays: r.end_date ? daysBetween(r.start_date, r.end_date) + 1 : 30,
  };
}

const canBeChallenge = (f) => f.schedule !== 'interval';
const challengeEnd = (f) => addDays(f.startDate, f.challengeDays - 1);

function toRequest(f) {
  return {
    name: f.name.trim(),
    emoji: f.emoji.trim(),
    kind: f.kind,
    schedule: f.schedule,
    days: f.schedule === 'days' ? f.days : null,
    target: f.schedule === 'weekly' ? f.weeklyTarget : f.schedule === 'monthly' ? f.monthlyTarget : null,
    every: f.schedule === 'interval' ? f.every : null,
    unit: f.schedule === 'interval' ? f.unit : null,
    start_date: f.startDate,
    end_date: f.isChallenge && canBeChallenge(f) ? challengeEnd(f) : '',
  };
}

function problem(f) {
  if (!f.name.trim()) return 'Give it a name';
  if (f.schedule === 'days' && f.days === 0) return 'Pick at least one day';
  if (!f.startDate) return 'Pick a date';
  return null;
}

/** Due days before today a new routine would already have: "kept it up since then". */
function pastDays(f, today) {
  if (f.schedule !== 'daily' && f.schedule !== 'days') return 0;
  const yesterday = addDays(today, -1);
  const last = f.isChallenge && challengeEnd(f) < yesterday ? challengeEnd(f) : yesterday;
  let count = 0;
  for (let d = f.startDate; d && d <= last; d = addDays(d, 1)) {
    if (f.schedule === 'daily' || (f.days & (1 << ((parseDay(d).getDay() + 6) % 7)))) count++;
  }
  return count;
}

const weekdayDate = (iso) => `${weekday(iso).slice(0, 3)}, ${dayMonth(iso)}`;

function Toggle({ checked, onChange, title, subtitle }) {
  return (
    <button type="button" role="switch" aria-checked={checked} className="rt-toggle-row" onClick={() => onChange(!checked)}>
      <span className="rt-toggle-text">
        <b>{title}</b>
        {subtitle && <span>{subtitle}</span>}
      </span>
      <span className={`rt-switch-ui ${checked ? 'on' : ''}`}><i /></span>
    </button>
  );
}

function Stepper({ value, min, max, suffix, onChange }) {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)));
  return (
    <div className="rt-stepper">
      <button type="button" onClick={() => set(value - 1)} disabled={value <= min} aria-label="Fewer">−</button>
      <input
        type="number" min={min} max={max} value={value}
        onChange={e => { const n = parseInt(e.target.value, 10); if (!Number.isNaN(n)) set(n); }}
      />
      <button type="button" onClick={() => set(value + 1)} disabled={value >= max} aria-label="More">+</button>
      {suffix && <span className="rt-stepper-suffix">{suffix}</span>}
    </div>
  );
}

function Pill({ selected, onClick, children }) {
  return <button type="button" className={`rt-pill ${selected ? 'on' : ''}`} onClick={onClick}>{children}</button>;
}

function Field({ label, children }) {
  return (
    <div className="rt-field">
      <div className="rt-subhead">{label}</div>
      {children}
    </div>
  );
}

/**
 * Adds a routine (routine is null) or edits one: a summary entry, archived ones included.
 * onDone(message) closes it after a change; onChanged() reloads without closing.
 */
export default function RoutineEditor({ routine, today, onClose, onDone, onChanged }) {
  const editing = !!routine;
  const initial = useMemo(() => (editing ? formFromRoutine(routine, today) : blankForm(today)), [routine, today, editing]);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [fillOnCreate, setFillOnCreate] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [blank, setBlank] = useState(routine?.past_blank || { count: 0, since: null });
  const [marked, setMarked] = useState(null);

  const update = (changes) => { setForm(f => ({ ...f, ...changes })); setError(''); };
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);
  const newPastDays = editing ? 0 : pastDays(form, today);

  const close = () => {
    if (dirty && !saving && !window.confirm('Discard your changes?')) return;
    onClose();
  };

  const run = async (work) => {
    setSaving(true);
    setError('');
    try {
      await work();
    } catch (e) {
      setError(e.message || "Couldn't save that");
      setSaving(false);
    }
  };

  const save = () => {
    const issue = problem(form);
    if (issue) return setError(issue);
    run(async () => {
      const body = toRequest(form);
      const label = `${form.emoji.trim()} ${form.name.trim()}`.trim();
      if (editing) {
        await updateRoutine(routine.id, body);
        onDone('Saved');
        return;
      }
      const { routine: created } = await createRoutine(body);
      let message = `${label} added`;
      if (fillOnCreate && newPastDays > 0) {
        try {
          const { filled } = await fillPast(created.id);
          if (filled) message += ` · ${filled} past ${filled === 1 ? 'day' : 'days'} marked done`;
        } catch {
          message += ". Couldn't fill in the past days; do it from History";
        }
      }
      onDone(message);
    });
  };

  const setArchived = (archived) => run(async () => {
    await updateRoutine(routine.id, { archived });
    onDone(archived ? 'Archived. Its history is kept.' : 'Restored');
  });

  const remove = () => run(async () => {
    await deleteRoutine(routine.id);
    onDone('Deleted');
  });

  const markPastDone = () => run(async () => {
    const { filled } = await fillPast(routine.id);
    setMarked(filled);
    setBlank({ count: 0, since: null });
    setSaving(false);
    onChanged();
  });

  const lengths = [...new Set([...CHALLENGE_LENGTHS, form.challengeDays])].sort((a, b) => a - b);
  const end = challengeEnd(form);

  return (
    <Modal title={editing ? 'Edit routine' : 'New routine'} subtitle={editing ? routine.name : 'A habit to build, or one to quit'} onClose={close}>
      <div className="rt-editor">
        {!editing && (
          <Field label="Start from a template">
            <div className="rt-pills">
              {TEMPLATES.map(t => (
                <Pill key={t.name} selected={form.name === t.name} onClick={() => { setForm(formFromTemplate(t, form.startDate)); setError(''); }}>
                  {t.emoji} {t.name}
                </Pill>
              ))}
            </div>
          </Field>
        )}

        <Field label="Name">
          <div className="rt-name-row">
            <button type="button" className="rt-emoji-btn" onClick={() => setEmojiOpen(o => !o)} aria-label="Pick an emoji" aria-expanded={emojiOpen}>
              {form.emoji || '✅'}
            </button>
            <input
              className="rt-input" value={form.name} maxLength={60} autoFocus={!editing}
              placeholder="Read 20 minutes" onChange={e => update({ name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') save(); }}
            />
          </div>
          {emojiOpen && (
            <div className="rt-emoji-grid">
              {EMOJIS.map(e => (
                <button type="button" key={e} className={form.emoji === e ? 'on' : ''} onClick={() => { update({ emoji: e }); setEmojiOpen(false); }}>{e}</button>
              ))}
              <input
                className="rt-input rt-emoji-own" maxLength={16} placeholder="Or type one"
                onChange={e => e.target.value.trim() && update({ emoji: e.target.value.trim() })}
              />
            </div>
          )}
        </Field>

        <Field label="Type">
          <div className="rt-options">
            {[['build', 'Build a habit', 'Something to do', '🌱'], ['avoid', 'Quit something', 'Something to stay off', '🚫']].map(([kind, title, sub, icon]) => (
              <button type="button" key={kind} className={`rt-option ${form.kind === kind ? 'on' : ''}`} onClick={() => update({ kind })}>
                <span className="rt-option-icon">{icon}</span>
                <b>{title}</b>
                <span>{sub}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="How often">
          <div className="rt-pills">
            {/* Chores are on hold for new routines; one that's already a chore stays editable. */}
            {SCHEDULES.filter(([schedule]) => schedule !== 'interval' || form.schedule === 'interval').map(([schedule, label]) => (
              <Pill key={schedule} selected={form.schedule === schedule} onClick={() => update({ schedule })}>{label}</Pill>
            ))}
          </div>
          <div className="rt-schedule">
            {form.schedule === 'daily' && <p className="rt-hint">Every day, from the day it starts.</p>}
            {form.schedule === 'days' && (
              <>
                <div className="rt-daypicker">
                  {DAY_LETTERS.map((letter, i) => (
                    <button
                      type="button" key={i} title={DAY_NAMES[i]}
                      className={form.days & (1 << i) ? 'on' : ''}
                      onClick={() => update({ days: form.days ^ (1 << i) })}
                    >{letter}</button>
                  ))}
                </div>
                <div className="rt-quick">
                  <button type="button" onClick={() => update({ days: WEEKDAYS })}>Weekdays</button>
                  <button type="button" onClick={() => update({ days: WEEKENDS })}>Weekends</button>
                </div>
              </>
            )}
            {form.schedule === 'weekly' && (
              <>
                <Stepper value={form.weeklyTarget} min={1} max={7} suffix="times a week" onChange={v => update({ weeklyTarget: v })} />
                <p className="rt-hint">Any days you like. It's judged when the week ends, so a slow Monday is fine.</p>
              </>
            )}
            {form.schedule === 'monthly' && (
              <>
                <Stepper value={form.monthlyTarget} min={1} max={31} suffix="times a month" onChange={v => update({ monthlyTarget: v })} />
                <p className="rt-hint">Any days you like. It's judged when the month ends.</p>
              </>
            )}
            {form.schedule === 'interval' && (
              <>
                <div className="rt-interval">
                  <span className="rt-stepper-suffix">Every</span>
                  <Stepper value={form.every} min={1} max={365} onChange={v => update({ every: v })} />
                  <div className="rt-pills">
                    {UNITS.map(([unit, label]) => (
                      <Pill key={unit} selected={form.unit === unit} onClick={() => update({ unit })}>
                        {form.every === 1 ? label.slice(0, -1) : label}
                      </Pill>
                    ))}
                  </div>
                </div>
                <label className="rt-date-row">
                  <span>Next due</span>
                  <input type="date" className="rt-input" value={form.startDate} onChange={e => update({ startDate: e.target.value })} />
                </label>
                <p className="rt-hint">Shows up when it's due and stays until it's done. The next one is counted from the day you do it.</p>
              </>
            )}
          </div>
        </Field>

        {canBeChallenge(form) && (
          <Field label="Challenge">
            <Toggle
              checked={form.isChallenge}
              onChange={isChallenge => update({ isChallenge })}
              title="Make it a challenge"
              subtitle="A countdown with a finish line"
            />
            {form.isChallenge && (
              <div className="rt-challenge">
                <div className="rt-pills">
                  {lengths.map(days => (
                    <Pill key={days} selected={form.challengeDays === days} onClick={() => update({ challengeDays: days })}>{days} days</Pill>
                  ))}
                </div>
                {end < today
                  ? <p className="rt-hint rt-warn">This challenge ended on {weekdayDate(end)}. Make it longer to keep it going.</p>
                  : <p className="rt-hint">Ends on {weekdayDate(end)}</p>}
              </div>
            )}
          </Field>
        )}

        {form.schedule !== 'interval' && (
          <Field label="Starts">
            <label className="rt-date-row">
              <span>First day</span>
              <input type="date" className="rt-input" value={form.startDate} onChange={e => update({ startDate: e.target.value })} />
            </label>
            {!editing && newPastDays > 0 && (
              <Toggle
                checked={fillOnCreate}
                onChange={setFillOnCreate}
                title="I've kept it up since then"
                subtitle={`Marks the ${newPastDays} ${newPastDays === 1 ? 'day' : 'days'} before today as done. Change any of them later from History.`}
              />
            )}
            {editing && !routine.archived && (blank.count > 0 || marked != null) && (
              <div className="rt-past">
                {marked != null && blank.count === 0 ? (
                  <>
                    <b>✓ Marked {marked} {marked === 1 ? 'day' : 'days'} as done</b>
                    <span>Change any single day from History on the Routines page.</span>
                  </>
                ) : (
                  <>
                    <b>🕰️ {blank.count === 1 ? '1 earlier day has' : `${blank.count} earlier days have`} no answer</b>
                    <span>Since {weekdayDate(blank.since)}. Kept it up? Fill them all in at once, then change any single day from History.</span>
                    <button type="button" className="action-btn" onClick={markPastDone} disabled={saving}>
                      {blank.count === 1 ? '❤️ Mark it as done' : `❤️ Mark all ${blank.count} as done`}
                    </button>
                  </>
                )}
              </div>
            )}
          </Field>
        )}

        {error && <div className="rt-error">{error}</div>}

        <div className="rt-editor-foot">
          {editing && (
            confirmDelete ? (
              <div className="rt-confirm">
                <span>Delete it and all its history?</span>
                <button type="button" className="action-btn rt-danger" onClick={remove} disabled={saving}>Delete</button>
                <button type="button" className="action-btn secondary" onClick={() => setConfirmDelete(false)}>Keep</button>
              </div>
            ) : (
              <div className="rt-foot-actions">
                <button type="button" className="action-btn secondary" onClick={() => setArchived(!routine.archived)} disabled={saving}>
                  {routine.archived ? '♻️ Restore' : '🗄️ Archive'}
                </button>
                <button type="button" className="action-btn secondary rt-danger-text" onClick={() => setConfirmDelete(true)} disabled={saving}>🗑️ Delete</button>
              </div>
            )
          )}
          {!confirmDelete && (
            <button type="button" className="action-btn rt-save" onClick={save} disabled={saving || (editing && !dirty)}>
              {saving ? 'Saving…' : editing ? 'Save' : 'Add routine'}
            </button>
          )}
        </div>
        {editing && routine.archived && <p className="rt-hint">Archived: it's left out of your days and scores until you restore it.</p>}
      </div>
    </Modal>
  );
}
