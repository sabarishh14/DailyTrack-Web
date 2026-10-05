"""The Routines rules in Python: a port of the phone's RoutineEngine
(DT-Android domain/routines/RoutineEngine.kt), kept in step by mirrored tests
(tests/test_routines_engine.py and RoutineEngineTest.kt run the same scenarios).

The phone works everything out itself, since it needs to offline. This copy
serves the web page and Nagapandi, so they report the same numbers.

  - Fixed days (every day, or chosen weekdays): each due day is one chance.
    Done counts, missed counts against, skipped is excused. A past day left
    unanswered counts as missed; today's waits until it's answered.
  - Times per week / month: each period is one chance, judged when it ends, or
    as soon as the target is hit. Skipped days lower the target only once too
    few days are left to reach it. Missing partway earns partial credit.
  - Chores (every N days/weeks/months): due from the due date until done, and on
    time if done by then. A skip on the deadline moves it a day. The next one
    falls due N after it was done.
  - Days before a routine was added count only once filled in: a blank one isn't
    a miss, and a week or chore deadline that passed before then isn't a failure.
  - Archived routines are left out of everything.
"""
from dataclasses import dataclass
from datetime import date, timedelta

from dateutil.relativedelta import relativedelta

DONE, MISSED, SKIPPED = "done", "missed", "skipped"
MAX_CYCLES = 5000


@dataclass(frozen=True)
class Routine:
    id: int
    name: str
    start_date: date
    emoji: str | None = None
    kind: str = "build"          # build | avoid
    schedule: str = "daily"      # daily | days | weekly | monthly | interval
    days: int | None = None      # "days": Mon=1 ... Sun=64
    target: int | None = None    # "weekly" / "monthly"
    every: int | None = None     # "interval": every N ...
    unit: str | None = None      # ... day | week | month
    end_date: date | None = None
    sort_order: int = 0
    archived: bool = False
    created_on: date | None = None

    def active_on(self, day):
        return not self.archived and day >= self.start_date and (self.end_date is None or day <= self.end_date)

    def counts_if_unanswered(self, day):
        """Whether leaving [day] blank counts as a miss: not before it was added."""
        return day >= (self.created_on or self.start_date)

    def challenge_day(self, day):
        if self.end_date is not None and self.start_date <= day <= self.end_date:
            return (day - self.start_date).days + 1
        return None

    @property
    def challenge_length(self):
        return (self.end_date - self.start_date).days + 1 if self.end_date else None

    def after_interval(self, day):
        count = max(self.every or 1, 1)
        if self.unit == "week":
            return day + timedelta(weeks=count)
        if self.unit == "month":
            return day + relativedelta(months=count)
        return day + timedelta(days=count)


@dataclass(frozen=True)
class CheckIn:
    routine_id: int
    date: date
    status: str
    note: str | None = None


@dataclass(frozen=True)
class PeriodProgress:
    done: int
    needed: int
    unit: str       # week | month
    answered: int = 0

    @property
    def met(self):
        return self.done >= self.needed


@dataclass(frozen=True)
class DayItem:
    routine: Routine
    date: date
    status: str | None
    note: str | None
    required: bool
    progress: PeriodProgress | None = None
    due_date: date | None = None

    @property
    def needs_answer(self):
        return self.status is None and (self.required or (self.progress is not None and not self.progress.met))


@dataclass(frozen=True)
class DayStats:
    date: date
    done: int
    total: int
    missed: int = 0
    skipped: int = 0
    unanswered: int = 0
    # Every required one with no answer, counted or not (a day from before the
    # routine was added): what the charts draw as not filled in.
    blank: int = 0

    @property
    def fraction(self):
        return self.done / self.total if self.total > 0 else None


@dataclass(frozen=True)
class Score:
    successes: float
    chances: float

    @property
    def fraction(self):
        return self.successes / self.chances if self.chances > 0 else None


@dataclass(frozen=True)
class Streak:
    current: int
    best: int
    unit: str       # day | week | month | time


@dataclass(frozen=True)
class _Cycle:
    due: date
    deadline: date
    completed: date | None


def days_between(start, end):
    """Each day from start to end, both included."""
    day = start
    while day <= end:
        yield day
        day += timedelta(days=1)


class RoutineEngine:
    def __init__(self, routines, checkins):
        self.routines = sorted((r for r in routines if not r.archived), key=lambda r: (r.sort_order, r.id))
        self._by = {}
        for c in checkins:
            self._by.setdefault(c.routine_id, {})[c.date] = c
        self._cycles = {}

    def check_in(self, routine_id, day):
        return self._by.get(routine_id, {}).get(day)

    def _status(self, routine, day):
        c = self.check_in(routine.id, day)
        return c.status if c else None

    # ---- day lists ----

    def day_items(self, day):
        return [item for item in (self._item_for(r, day) for r in self.routines) if item is not None]

    def day_stats(self, day):
        return self.stats_of(day, self.day_items(day))

    def week(self, today):
        monday = today - timedelta(days=today.weekday())
        return [None if monday + timedelta(days=i) > today else self.day_stats(monday + timedelta(days=i)) for i in range(7)]

    def upcoming(self, today):
        """[(routine, date)]: chores not yet due, and routines that haven't started."""
        out = []
        for r in self.routines:
            if r.schedule == "interval":
                cycles = self._cycles_of(r)
                last = cycles[-1] if cycles else None
                if last and last.completed is None and last.due > today:
                    out.append((r, last.due))
            elif r.start_date > today:
                out.append((r, r.start_date))
        return sorted(out, key=lambda pair: pair[1])

    def item_on(self, routine, day):
        return self._item_for(routine, day)

    # ---- score ----

    def consistency(self, today, days=30):
        return self.score(today - timedelta(days=days - 1), today, today)

    def previous_consistency(self, today, days=30):
        """The days before the last `days`: what consistency is compared with."""
        return self.score(today - timedelta(days=2 * days - 1), today - timedelta(days=days), today)

    def routine_consistency(self, routine, today, days=30):
        return self.score(today - timedelta(days=days - 1), today, today, [routine])

    def all_time(self, routine, today):
        return self.score(routine.start_date, today, today, [routine])

    def score(self, start, end, today, only=None):
        successes = chances = 0.0
        last = min(end, today)
        for r in (self.routines if only is None else only):
            if r.schedule in ("daily", "days"):
                stop = min(last, r.end_date or last)
                for day in days_between(max(start, r.start_date), stop):
                    if not self._due_on_fixed_day(r, day):
                        continue
                    status = self._status(r, day)
                    if status == DONE:
                        successes += 1
                        chances += 1
                    elif status == MISSED:
                        chances += 1
                    elif status is None and day < today and r.counts_if_unanswered(day):
                        chances += 1
            elif r.schedule in ("weekly", "monthly"):
                period = self._period_of(r, max(start, r.start_date))
                while period[0] <= last:
                    progress = self._progress(r, period)
                    if progress.needed > 0 and not self._before_it_was_added(r, period, progress):
                        ended = period[1] < today
                        if ended and start <= period[1] <= last:
                            chances += progress.needed
                            successes += min(progress.done, progress.needed)
                        elif not ended and progress.met and start <= today <= last:
                            chances += progress.needed
                            successes += progress.needed
                    period = self._period_of(r, period[1] + timedelta(days=1))
            else:
                for cycle in self._cycles_of(r):
                    judged = self._judge(r, cycle, today)
                    if judged and start <= judged[0] <= last:
                        chances += 1
                        if judged[1]:
                            successes += 1
        return Score(successes, chances)

    # ---- streaks ----

    def streak(self, routine, today):
        run = best = 0
        last = min(today, routine.end_date or today)
        if routine.schedule in ("daily", "days"):
            for day in days_between(routine.start_date, last):
                if not self._due_on_fixed_day(routine, day):
                    continue
                status = self._status(routine, day)
                if status == DONE:
                    run += 1
                    best = max(best, run)
                elif status == MISSED or (status is None and day < today and routine.counts_if_unanswered(day)):
                    run = 0
            return Streak(run, best, "day")
        if routine.schedule in ("weekly", "monthly"):
            period = self._period_of(routine, routine.start_date)
            while period[0] <= last:
                progress = self._progress(routine, period)
                if progress.needed > 0 and not self._before_it_was_added(routine, period, progress):
                    if progress.met:
                        run += 1
                        best = max(best, run)
                    elif period[1] < today:
                        run = 0
                period = self._period_of(routine, period[1] + timedelta(days=1))
            return Streak(run, best, "week" if routine.schedule == "weekly" else "month")
        for cycle in self._cycles_of(routine):
            judged = self._judge(routine, cycle, today)
            if judged is None:
                continue
            if judged[1]:
                run += 1
                best = max(best, run)
            else:
                run = 0
        return Streak(run, best, "time")

    def perfect_days(self, today):
        if not self.routines:
            return Streak(0, 0, "day")
        run = best = 0
        for day in days_between(min(r.start_date for r in self.routines), today):
            counted = [i for i in self._required_items(day) if self._counts(i)]
            if not counted:
                continue
            if all(i.status == DONE for i in counted):
                run += 1
                best = max(best, run)
            elif day == today and not any(i.status == MISSED for i in counted):
                continue
            else:
                run = 0
        return Streak(run, best, "day")

    # ---- one routine ----

    def answers_for(self, routine):
        return sorted(self._by.get(routine.id, {}).values(), key=lambda c: c.date, reverse=True)

    def last_done(self, routine):
        dates = [c.date for c in self._by.get(routine.id, {}).values() if c.status == DONE]
        return max(dates) if dates else None

    def next_due(self, routine):
        if routine.schedule != "interval":
            return None
        cycles = self._cycles_of(routine)
        return cycles[-1].due if cycles and cycles[-1].completed is None else None

    def unanswered_past_days(self, routine, today):
        """Due days before today with no answer at all, oldest first: what "mark
        them all done" fills in. Only for every-day and chosen-day routines; the
        others don't have a fixed list of days."""
        if routine.schedule not in ("daily", "days"):
            return []
        last = min(today - timedelta(days=1), routine.end_date or today)
        return [d for d in days_between(routine.start_date, last)
                if self._due_on_fixed_day(routine, d) and self.check_in(routine.id, d) is None]

    # ---- internals ----

    def _item_for(self, routine, day):
        c = self.check_in(routine.id, day)
        status, note = (c.status, c.note) if c else (None, None)
        if routine.schedule in ("daily", "days"):
            return DayItem(routine, day, status, note, required=True) if self._due_on_fixed_day(routine, day) else None
        if routine.schedule in ("weekly", "monthly"):
            if not routine.active_on(day):
                return None
            return DayItem(routine, day, status, note, required=False,
                           progress=self._progress(routine, self._period_of(routine, day)))
        for cycle in self._cycles_of(routine):
            if (cycle.due <= day and (cycle.completed is None or cycle.completed >= day)) or cycle.completed == day:
                return DayItem(routine, day, status, note, required=cycle.due <= day, due_date=cycle.due)
        return None

    def _required_items(self, day):
        items = []
        for r in self.routines:
            if r.schedule in ("weekly", "monthly"):
                continue
            item = self._item_for(r, day)
            if item and item.required:
                items.append(item)
        return items

    @staticmethod
    def _counts(item):
        if item.status == SKIPPED:
            return False
        if item.status is None:
            return item.routine.counts_if_unanswered(item.date)
        return True

    def stats_of(self, day, items):
        """Stats for a day whose items are already worked out."""
        done = sum(1 for i in items if i.status == DONE)
        total = sum(1 for i in items if i.required and self._counts(i)) + \
            sum(1 for i in items if not i.required and i.status == DONE)
        return DayStats(
            date=day, done=done, total=total,
            missed=sum(1 for i in items if i.required and i.status == MISSED),
            skipped=sum(1 for i in items if i.required and i.status == SKIPPED),
            unanswered=sum(1 for i in items if i.required and i.status is None and self._counts(i)),
            blank=sum(1 for i in items if i.required and i.status is None),
        )

    @staticmethod
    def _due_on_fixed_day(routine, day):
        if not routine.active_on(day):
            return False
        if routine.schedule == "daily":
            return True
        if routine.schedule == "days":
            return (routine.days or 0) & (1 << day.weekday()) != 0
        return False

    @staticmethod
    def _period_of(routine, day):
        if routine.schedule == "weekly":
            monday = day - timedelta(days=day.weekday())
            return monday, monday + timedelta(days=6)
        first = day.replace(day=1)
        return first, first + relativedelta(months=1) - timedelta(days=1)

    def _progress(self, routine, period):
        active = skipped = done = answered = 0
        for day in days_between(period[0], period[1]):
            if not routine.active_on(day):
                continue
            active += 1
            status = self._status(routine, day)
            if status is not None:
                answered += 1
            if status == DONE:
                done += 1
            elif status == SKIPPED:
                skipped += 1
        needed = max(min(routine.target or 1, active - skipped), 0)
        return PeriodProgress(done, needed, "week" if routine.schedule == "weekly" else "month", answered)

    @staticmethod
    def _before_it_was_added(routine, period, progress):
        return routine.created_on is not None and period[1] < routine.created_on and progress.answered == 0

    def _cycles_of(self, routine):
        if routine.id in self._cycles:
            return self._cycles[routine.id]
        done_dates = sorted(c.date for c in self._by.get(routine.id, {}).values() if c.status == DONE)
        cycles = []
        due = routine.start_date
        index = 0
        while len(cycles) < MAX_CYCLES:
            if routine.end_date is not None and due > routine.end_date:
                break
            completed = done_dates[index] if index < len(done_dates) else None
            cycles.append(_Cycle(due, self._deadline_for(routine, due), completed))
            if completed is None:
                break
            index += 1
            due = routine.after_interval(completed)
        self._cycles[routine.id] = cycles
        return cycles

    def _deadline_for(self, routine, due):
        deadline, guard = due, 0
        while self._status(routine, deadline) == SKIPPED and guard < 366:
            deadline += timedelta(days=1)
            guard += 1
        return deadline

    @staticmethod
    def _judge(routine, cycle, today):
        """(when it was decided, on time?), or None while it can still be done in time
        or when its deadline passed before the routine was even added."""
        if cycle.completed is not None and cycle.completed <= cycle.deadline:
            return cycle.completed, True
        if cycle.completed is not None or today > cycle.deadline:
            decided = (cycle.deadline, False)
        else:
            return None
        return decided if routine.counts_if_unanswered(decided[0]) else None
