"""The Routines rules on a fixed calendar (mon is Monday 28 Sep 2026).

Mirrors the phone's RoutineEngineTest.kt scenario for scenario, so the web page
and Nagapandi report the same numbers the phone shows.

    cd backend && python -m unittest discover -s tests
"""
import os
import sys
import unittest
from datetime import date, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from routines_engine import CheckIn, DONE, MISSED, SKIPPED, Routine, RoutineEngine  # noqa: E402

MON = date(2026, 9, 28)


def day(offset):
    return MON + timedelta(days=offset)


def daily(rid, start=MON, end=None, **kw):
    return Routine(id=rid, name=f"R{rid}", start_date=start, end_date=end, **kw)


def weekly(rid, target, start=MON, **kw):
    return Routine(id=rid, name=f"W{rid}", schedule="weekly", target=target, start_date=start, **kw)


def chore(rid, first_due, every=7, unit="day", **kw):
    return Routine(id=rid, name=f"C{rid}", schedule="interval", every=every, unit=unit, start_date=first_due, **kw)


def at(routine, d, status, note=None):
    return CheckIn(routine.id, d, status, note)


def engine(routines, *checkins):
    return RoutineEngine(routines, list(checkins))


MONDAY, WEDNESDAY, FRIDAY = 1, 4, 16


class DayListTest(unittest.TestCase):
    def test_fixed_days_are_due_on_their_days_and_inside_a_challenge(self):
        challenge = daily(1, start=MON, end=day(2))
        mwf = Routine(id=2, name="Gym", schedule="days", days=MONDAY | WEDNESDAY | FRIDAY, start_date=MON)
        e = engine([challenge, mwf])
        ids = lambda d: [i.routine.id for i in e.day_items(d)]  # noqa: E731
        self.assertEqual(ids(day(-1)), [])
        self.assertEqual(ids(MON), [1, 2])
        self.assertEqual(ids(day(1)), [1])
        self.assertEqual(ids(day(2)), [1, 2])
        self.assertEqual(ids(day(3)), [])
        self.assertEqual(ids(day(4)), [2])
        self.assertEqual(challenge.challenge_day(day(1)), 2)
        self.assertEqual(challenge.challenge_length, 3)

    def test_a_day_counts_due_items_and_optional_ones_only_when_done(self):
        a, b, gym, flt = daily(1), daily(2), weekly(3, target=3), chore(4, first_due=day(2))
        today = day(2)
        stats = engine([a, b, gym, flt], at(a, today, DONE), at(b, today, SKIPPED), at(gym, today, DONE)).day_stats(today)
        self.assertEqual((stats.done, stats.total), (2, 3))
        self.assertEqual((stats.missed, stats.skipped, stats.unanswered), (0, 1, 1))

    def test_a_days_mix_separates_answered_misses_from_blanks(self):
        a, b, c = daily(1), daily(2), daily(3)
        stats = engine([a, b, c], at(a, MON, DONE), at(b, MON, MISSED)).day_stats(MON)
        self.assertEqual((stats.done, stats.missed, stats.unanswered, stats.skipped, stats.total), (1, 1, 1, 0, 3))

    def test_the_week_runs_monday_to_sunday_with_days_ahead_left_empty(self):
        week = engine([daily(1)]).week(day(2))
        self.assertEqual(len(week), 7)
        self.assertEqual([s.date for s in week[:3]], [MON, day(1), day(2)])
        self.assertTrue(all(s is None for s in week[3:]))

    def test_only_unanswered_things_still_worth_asking_are_asked_tonight(self):
        read, answered = daily(1), daily(2)
        met_gym, open_gym = weekly(3, target=1), weekly(4, target=2)
        flt = chore(5, first_due=day(1))
        today = day(1)
        e = engine([read, answered, met_gym, open_gym, flt], at(answered, today, MISSED), at(met_gym, MON, DONE))
        self.assertEqual([i.routine.id for i in e.day_items(today) if i.needs_answer], [1, 4, 5])

    def test_archived_routines_are_left_out_of_everything(self):
        gone = daily(1, archived=True)
        e = engine([gone], at(gone, MON, DONE))
        self.assertEqual(e.day_items(MON), [])
        self.assertIsNone(e.consistency(day(3)).fraction)
        self.assertEqual(e.perfect_days(day(3)).best, 0)


class ScoreTest(unittest.TestCase):
    def test_a_past_day_left_unanswered_counts_as_missed_while_today_waits(self):
        read = daily(1)
        self.assertAlmostEqual(engine([read], at(read, MON, DONE)).consistency(day(2)).fraction, 1 / 2)
        answered = engine([read], at(read, MON, DONE), at(read, day(2), MISSED))
        self.assertAlmostEqual(answered.consistency(day(2)).fraction, 1 / 3)

    def test_skips_are_excused(self):
        read = daily(1)
        e = engine([read], at(read, MON, DONE), at(read, day(1), SKIPPED), at(read, day(2), MISSED))
        self.assertAlmostEqual(e.consistency(day(3)).fraction, 1 / 2)

    def test_weekly_targets_are_judged_when_the_week_ends_with_partial_credit(self):
        gym = weekly(1, target=3)
        first = engine([gym], at(gym, MON, DONE), at(gym, day(2), DONE))
        self.assertIsNone(first.consistency(day(4)).fraction)
        self.assertAlmostEqual(first.consistency(day(7)).fraction, 2 / 3)
        second = engine([gym], at(gym, MON, DONE), at(gym, day(2), DONE),
                        at(gym, day(7), DONE), at(gym, day(8), DONE), at(gym, day(9), DONE))
        self.assertAlmostEqual(second.consistency(day(9)).fraction, 5 / 6)

    def test_skips_lower_a_weekly_target_only_once_too_few_days_are_left(self):
        late = weekly(1, target=4, start=day(3))
        e = engine([late], at(late, day(3), DONE), at(late, day(4), SKIPPED), at(late, day(5), DONE), at(late, day(6), DONE))
        self.assertAlmostEqual(e.consistency(day(7)).fraction, 1.0)
        full = weekly(2, target=4)
        two_skips = engine([full], at(full, MON, SKIPPED), at(full, day(1), SKIPPED), at(full, day(2), DONE), at(full, day(3), DONE))
        self.assertAlmostEqual(two_skips.consistency(day(7)).fraction, 2 / 4)

    def test_monthly_targets_count_calendar_months(self):
        calls = Routine(id=1, name="Call home", schedule="monthly", target=2, start_date=date(2026, 9, 1))
        e = engine([calls], at(calls, date(2026, 9, 10), DONE))
        today = date(2026, 10, 2)
        self.assertAlmostEqual(e.consistency(today).fraction, 0.5)
        self.assertEqual(e.streak(calls, today).current, 0)
        self.assertEqual(e.streak(calls, today).unit, "month")


class ChoreTest(unittest.TestCase):
    def test_a_chore_is_due_from_its_date_until_done_and_judged_against_it(self):
        flt = chore(1, first_due=day(2))
        before = engine([flt])
        self.assertEqual(before.day_items(day(1)), [])
        self.assertEqual([d for _, d in before.upcoming(day(1))], [day(2)])
        overdue = before.day_items(day(4))[0]
        self.assertTrue(overdue.required)
        self.assertEqual(overdue.due_date, day(2))

        late = engine([flt], at(flt, day(4), DONE))
        self.assertEqual(late.day_items(day(5)), [])
        self.assertEqual([d for _, d in late.upcoming(day(5))], [day(11)])
        self.assertEqual(late.streak(flt, day(5)).best, 0)

        on_time = engine([flt], at(flt, day(4), DONE), at(flt, day(11), DONE))
        self.assertEqual(on_time.streak(flt, day(12)).current, 1)
        self.assertEqual(on_time.streak(flt, day(12)).unit, "time")
        self.assertAlmostEqual(on_time.consistency(day(12)).fraction, 1 / 2)

    def test_a_skip_on_the_deadline_moves_it_by_a_day_an_earlier_one_doesnt(self):
        flt = chore(1, first_due=day(2))
        self.assertEqual(engine([flt], at(flt, day(2), SKIPPED), at(flt, day(3), DONE)).streak(flt, day(4)).current, 1)
        self.assertEqual(engine([flt], at(flt, day(1), SKIPPED), at(flt, day(3), DONE)).streak(flt, day(4)).current, 0)

    def test_doing_a_chore_early_counts_and_restarts_the_clock(self):
        sheets = chore(1, first_due=date(2026, 10, 15), every=1, unit="month")
        early = date(2026, 10, 10)
        e = engine([sheets], at(sheets, early, DONE))
        self.assertFalse(e.day_items(early)[0].required)
        self.assertEqual((e.day_stats(early).done, e.day_stats(early).total), (1, 1))
        self.assertEqual([d for _, d in e.upcoming(early + timedelta(days=1))], [date(2026, 11, 10)])
        self.assertAlmostEqual(e.consistency(early + timedelta(days=1)).fraction, 1.0)

    def test_routines_that_havent_started_are_coming_up(self):
        later = daily(1, start=day(5))
        self.assertEqual([d for _, d in engine([later]).upcoming(MON)], [day(5)])


class StreakTest(unittest.TestCase):
    def test_skips_and_todays_pending_answer_dont_break_a_streak_a_miss_does(self):
        read = daily(1)
        base = [at(read, MON, DONE), at(read, day(1), SKIPPED), at(read, day(2), DONE)]
        pending = engine([read], *base).streak(read, day(3))
        self.assertEqual((pending.current, pending.best), (2, 2))
        missed = engine([read], *base, at(read, day(3), MISSED)).streak(read, day(3))
        self.assertEqual((missed.current, missed.best), (0, 2))

    def test_a_weekly_streak_counts_weeks_that_hit_the_target(self):
        gym = weekly(1, target=1)
        e = engine([gym], at(gym, MON, DONE), at(gym, day(8), DONE))
        self.assertEqual(e.streak(gym, day(15)).current, 2)
        self.assertEqual(e.streak(gym, day(21)).current, 0)
        self.assertEqual(e.streak(gym, day(21)).best, 2)

    def test_perfect_days_need_everything_due_done_with_skips_excused(self):
        a, b = daily(1), daily(2)
        base = [at(a, MON, DONE), at(b, MON, DONE), at(a, day(1), DONE), at(b, day(1), SKIPPED),
                at(a, day(2), DONE), at(b, day(2), DONE), at(a, day(3), DONE)]
        in_progress = engine([a, b], *base).perfect_days(day(3))
        self.assertEqual((in_progress.current, in_progress.best), (3, 3))
        broken = engine([a, b], *base, at(b, day(3), MISSED)).perfect_days(day(3))
        self.assertEqual((broken.current, broken.best), (0, 3))

    def test_days_with_nothing_due_dont_count_either_way(self):
        mondays = Routine(id=1, name="Weekly review", schedule="days", days=MONDAY, start_date=MON)
        self.assertEqual(engine([mondays], at(mondays, MON, DONE), at(mondays, day(7), DONE)).perfect_days(day(10)).current, 2)


class BeforeItWasAddedTest(unittest.TestCase):
    def test_blank_days_before_a_routine_was_added_dont_count_as_missed(self):
        sugar = daily(1, created_on=day(3))
        blank = engine([sugar])
        self.assertAlmostEqual(blank.consistency(day(4)).fraction, 0.0)
        self.assertEqual(blank.day_stats(MON).total, 0)
        filled = engine([sugar], at(sugar, MON, DONE), at(sugar, day(1), DONE), at(sugar, day(3), DONE))
        self.assertAlmostEqual(filled.consistency(day(4)).fraction, 1.0)
        self.assertEqual(filled.streak(sugar, day(4)).current, 3)
        self.assertEqual(filled.perfect_days(day(4)).current, 3)

    def test_weeks_that_ended_before_a_routine_was_added_count_only_once_filled_in(self):
        gym = weekly(1, target=3, created_on=day(8))
        self.assertAlmostEqual(engine([gym], at(gym, day(9), DONE), at(gym, day(10), DONE)).consistency(day(14)).fraction, 2 / 3)
        backfilled = engine([gym], at(gym, day(1), DONE), at(gym, day(9), DONE), at(gym, day(10), DONE))
        self.assertAlmostEqual(backfilled.consistency(day(14)).fraction, 3 / 6)

    def test_unanswered_past_days_are_the_due_days_before_today_with_no_answer(self):
        read = daily(1)
        self.assertEqual(engine([read], at(read, day(1), DONE)).unanswered_past_days(read, day(3)), [MON, day(2)])
        mondays = Routine(id=2, name="Review", schedule="days", days=MONDAY, start_date=MON)
        self.assertEqual(engine([mondays]).unanswered_past_days(mondays, day(10)), [MON, day(7)])
        # Only fixed-day routines can be filled in wholesale.
        gym = weekly(3, target=2)
        self.assertEqual(engine([gym]).unanswered_past_days(gym, day(10)), [])

    def test_a_chore_already_overdue_when_added_isnt_a_failure(self):
        flt = chore(1, first_due=MON, created_on=day(5))
        e = engine([flt])
        self.assertIsNone(e.consistency(day(6)).fraction)
        self.assertTrue(e.day_items(day(6))[0].required)


class OneRoutineTest(unittest.TestCase):
    def test_a_routines_own_page_has_its_days_all_time_score_and_answers(self):
        read, other = daily(1), daily(2)
        e = engine([read, other], at(read, MON, DONE), at(read, day(1), SKIPPED, "Unwell"),
                   at(read, day(2), MISSED), at(other, MON, DONE))
        self.assertEqual(e.item_on(read, day(1)).status, SKIPPED)
        self.assertIsNone(e.item_on(read, day(-1)))
        self.assertAlmostEqual(e.all_time(read, day(3)).fraction, 1 / 2)
        self.assertEqual([c.date for c in e.answers_for(read)], [day(2), day(1), MON])
        self.assertEqual(next(c for c in e.answers_for(read) if c.status == SKIPPED).note, "Unwell")
        self.assertEqual(e.last_done(read), MON)

    def test_a_chores_next_due_date_is_the_open_one_even_if_overdue(self):
        flt = chore(1, first_due=day(2))
        self.assertEqual(engine([flt]).next_due(flt), day(2))
        self.assertEqual(engine([flt], at(flt, day(4), DONE)).next_due(flt), day(11))
        self.assertIsNone(engine([daily(2)]).next_due(daily(2)))


if __name__ == "__main__":
    unittest.main()
