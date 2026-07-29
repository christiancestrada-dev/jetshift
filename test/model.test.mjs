import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  zonedTimeToUtc,
  civilInZone,
  addDays,
  daysBetween,
  getTimezoneOffsetHours,
  wrap12,
  wrap24,
  parseClock,
  formatHour,
} from '../lib/time.js';

import {
  requiredShift,
  buildShiftPlan,
  prcAt,
  amplitudeAt,
  lightWindow,
  avoidWindow,
  intensityForDay,
  sleepWindow,
  CBTMIN_BEFORE_WAKE,
  SLEEP_HOURS,
  BASE_RATE,
  INTENSITY,
} from '../lib/circadian.js';

import { generateSchedule } from '../lib/schedule.js';

const here = dirname(fileURLToPath(import.meta.url));
const airports = JSON.parse(readFileSync(join(here, '../data/airports.json'), 'utf8'));

const NON_BLOCKING = new Set(['melatonin', 'caffeine_cutoff', 'eating']);
const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;

// --- time.js --------------------------------------------------------------

test('wrap12 gives the signed short way round the clock', () => {
  assert.equal(wrap12(0), 0);
  assert.equal(wrap12(5), 5);
  assert.equal(wrap12(14), -10);
  assert.equal(wrap12(12), -12);
  assert.equal(wrap12(-14), 10);
  assert.equal(wrap12(23), -1);
});

test('wrap24 normalises into [0,24)', () => {
  assert.equal(wrap24(-2), 22);
  assert.equal(wrap24(26), 2);
  assert.equal(wrap24(24), 0);
});

test('parseClock reads HH:MM as decimal hours', () => {
  assert.equal(parseClock('07:00'), 7);
  assert.equal(parseClock('06:30'), 6.5);
  assert.equal(parseClock('00:15'), 0.25);
  assert.equal(parseClock(''), 7);
});

test('formatHour round-trips midnight and noon correctly', () => {
  assert.equal(formatHour(0), '12:00 AM');
  assert.equal(formatHour(12), '12:00 PM');
  assert.equal(formatHour(13.5), '1:30 PM');
  assert.equal(formatHour(-2), '10:00 PM');
  assert.equal(formatHour(23.999), '12:00 AM');
});

test('zonedTimeToUtc is correct for positive UTC offsets', () => {
  // The old engine emitted this a day early: London midnight is the previous
  // day in UTC, and it read the UTC date off that.
  const utc = zonedTimeToUtc({ y: 2026, m: 4, d: 16 }, 9, 'Europe/London');
  assert.equal(utc.toISOString(), '2026-05-16T08:00:00.000Z'); // BST = UTC+1
  assert.equal(civilInZone(utc, 'Europe/London').d, 16);
});

test('zonedTimeToUtc is correct for large positive offsets', () => {
  const utc = zonedTimeToUtc({ y: 2026, m: 4, d: 16 }, 8, 'Asia/Tokyo');
  assert.equal(utc.toISOString(), '2026-05-15T23:00:00.000Z'); // JST = UTC+9
  assert.equal(civilInZone(utc, 'Asia/Tokyo').d, 16);
});

test('zonedTimeToUtc rolls negative hours back a day', () => {
  const utc = zonedTimeToUtc({ y: 2026, m: 4, d: 16 }, -3, 'America/New_York');
  // -3 means 9pm on the 15th, EDT = UTC-4
  assert.equal(utc.toISOString(), '2026-05-16T01:00:00.000Z');
  assert.equal(civilInZone(utc, 'America/New_York').d, 15);
});

test('zonedTimeToUtc rolls hours past 24 forward a day', () => {
  const utc = zonedTimeToUtc({ y: 2026, m: 4, d: 16 }, 26, 'America/New_York');
  assert.equal(civilInZone(utc, 'America/New_York').d, 17);
});

test('zonedTimeToUtc survives the spring-forward gap', () => {
  // US DST 2026 begins 8 March at 02:00. The two sides of the transition take
  // different offsets, which is the case the second correction pass exists for.
  const after = zonedTimeToUtc({ y: 2026, m: 2, d: 8 }, 3, 'America/New_York');
  assert.equal(after.toISOString(), '2026-03-08T07:00:00.000Z'); // EDT, UTC-4
  const before = zonedTimeToUtc({ y: 2026, m: 2, d: 8 }, 1, 'America/New_York');
  assert.equal(before.toISOString(), '2026-03-08T06:00:00.000Z'); // EST, UTC-5
});

test('a wall time inside the spring-forward gap resolves forward', () => {
  // 02:30 on 8 March 2026 does not exist in New York. It must become 03:30,
  // not slide back to 01:30 and put a sleep block an hour in the past.
  const t = zonedTimeToUtc({ y: 2026, m: 2, d: 8 }, 2.5, 'America/New_York');
  assert.equal(t.toISOString(), '2026-03-08T07:30:00.000Z'); // 03:30 EDT
});

test('zonedTimeToUtc survives the fall-back overlap', () => {
  // US DST 2026 ends 1 November at 02:00, so 01:30 local happens twice.
  const t = zonedTimeToUtc({ y: 2026, m: 10, d: 1 }, 1.5, 'America/New_York');
  assert.equal(civilInZone(t, 'America/New_York').d, 1);
  const later = zonedTimeToUtc({ y: 2026, m: 10, d: 1 }, 6, 'America/New_York');
  assert.equal(later.toISOString(), '2026-11-01T11:00:00.000Z'); // EST, UTC-5
});

test('civil date arithmetic crosses a DST boundary without drifting', () => {
  const start = { y: 2026, m: 2, d: 6 };
  const later = addDays(start, 5);
  assert.deepEqual(later, { y: 2026, m: 2, d: 11 });
  assert.equal(daysBetween(start, later), 5);
});

test('civil date arithmetic crosses month and year ends', () => {
  assert.deepEqual(addDays({ y: 2026, m: 11, d: 30 }, 3), { y: 2027, m: 0, d: 2 });
  assert.deepEqual(addDays({ y: 2026, m: 0, d: 2 }, -3), { y: 2025, m: 11, d: 30 });
});

test('getTimezoneOffsetHours reflects DST', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');
  assert.equal(getTimezoneOffsetHours('America/New_York', winter), -5);
  assert.equal(getTimezoneOffsetHours('America/New_York', summer), -4);
  assert.equal(getTimezoneOffsetHours('Europe/London', winter), 0);
  assert.equal(getTimezoneOffsetHours('Europe/London', summer), 1);
});

// --- required shift -------------------------------------------------------

test('Boston to London with an unchanged wake time is a 5h advance', () => {
  const s = requiredShift({ tzDiff: 5, currentWakeH: 8, goalWakeH: 8 });
  assert.equal(s.direction, 'advance');
  assert.equal(s.magnitude, 5);
});

test('an earlier goal wake time increases the advance', () => {
  // Body wants London 1pm; goal is 6am; so 7h of advance, not 3.
  const s = requiredShift({ tzDiff: 5, currentWakeH: 8, goalWakeH: 6 });
  assert.equal(s.direction, 'advance');
  assert.equal(s.magnitude, 7);
});

test('a later goal wake time reduces the advance', () => {
  const s = requiredShift({ tzDiff: 5, currentWakeH: 8, goalWakeH: 10 });
  assert.equal(s.direction, 'advance');
  assert.equal(s.magnitude, 3);
});

test('westward travel is a delay', () => {
  const s = requiredShift({ tzDiff: -3, currentWakeH: 8, goalWakeH: 8 });
  assert.equal(s.direction, 'delay');
  assert.equal(s.magnitude, 3);
});

test('a later goal wake time increases a westward delay', () => {
  const s = requiredShift({ tzDiff: -3, currentWakeH: 8, goalWakeH: 10 });
  assert.equal(s.direction, 'delay');
  assert.equal(s.magnitude, 5);
});

test('shifts beyond 12h take the short way round', () => {
  const s = requiredShift({ tzDiff: 14, currentWakeH: 8, goalWakeH: 8 });
  assert.equal(s.direction, 'delay');
  assert.equal(s.magnitude, 10);
  assert.equal(s.wrapped, true);
});

test('an exactly 12h shift is planned as a delay', () => {
  const s = requiredShift({ tzDiff: 12, currentWakeH: 8, goalWakeH: 8 });
  assert.equal(s.direction, 'delay');
  assert.equal(s.magnitude, 12);
});

test('no timezone change and no goal change needs no shift', () => {
  const s = requiredShift({ tzDiff: 0, currentWakeH: 8, goalWakeH: 8 });
  assert.equal(s.magnitude, 0);
});

// --- PRC ------------------------------------------------------------------

test('PRC advances after CBTmin and delays before it', () => {
  assert.equal(prcAt(1).direction, 'advance');
  assert.equal(prcAt(1).band, 'strong');
  assert.equal(prcAt(4.5).direction, 'advance');
  assert.equal(prcAt(4.5).band, 'moderate');
  assert.equal(prcAt(-1).direction, 'delay');
  assert.equal(prcAt(-1).band, 'strong');
  assert.equal(prcAt(-4.5).direction, 'delay');
  assert.equal(prcAt(-4.5).band, 'moderate');
});

test('PRC has a dead zone across the subjective day', () => {
  assert.equal(prcAt(8).band, 'dead');
  assert.equal(prcAt(12).band, 'dead');
  assert.equal(prcAt(-8).band, 'dead');
});

test('PRC is continuous across the wrap point', () => {
  assert.equal(prcAt(23).direction, prcAt(-1).direction);
  assert.equal(prcAt(25).direction, prcAt(1).direction);
});

// --- amplitude ------------------------------------------------------------

test('light at the nadir flattens amplitude', () => {
  assert.equal(amplitudeAt(0).effect, 'flatten');
  assert.equal(amplitudeAt(1).effect, 'flatten');
  assert.equal(amplitudeAt(23.5).effect, 'flatten');
});

test('light across the subjective day boosts amplitude', () => {
  assert.equal(amplitudeAt(7).effect, 'boost');
  assert.equal(amplitudeAt(10).effect, 'boost');
  assert.equal(amplitudeAt(14).effect, 'boost');
});

test('the boost window falls inside the PRC dead zone', () => {
  // This is the point of it: strengthen the rhythm without moving it.
  for (let tau = 7; tau <= 12; tau += 0.5) {
    assert.equal(prcAt(tau).band, 'dead', `tau=${tau} should not shift phase`);
  }
});

test('amplitude index falls while shifting and recovers when settled', () => {
  const plan = buildShiftPlan({
    shift: requiredShift({ tzDiff: 8, currentWakeH: 8, goalWakeH: 8 }),
    prepDays: 3,
    currentWakeH: 8,
    tzDiff: 8,
    goalWakeH: 8,
  });
  const amps = plan.days.map((d) => d.amplitude);
  const trough = Math.min(...amps);
  assert.ok(trough < 0.9, `an 8h shift should visibly cost amplitude, trough was ${trough}`);
  assert.ok(amps.every((a) => a >= 0.5 && a <= 1), 'stays in range');

  // Once the shifting stops, the index climbs back.
  const last = plan.days[plan.days.length - 1];
  const troughIndex = amps.indexOf(trough);
  assert.ok(last.shiftedToday < 0.01, 'final day should be a consolidation day');
  assert.ok(last.amplitude > trough || troughIndex === amps.length - 1, 'should recover after the trough');
});

test('gentle shifting with daylight barely costs amplitude', () => {
  const plan = buildShiftPlan({
    shift: requiredShift({ tzDiff: 2, currentWakeH: 8, goalWakeH: 8 }),
    prepDays: 4,
    currentWakeH: 8,
    tzDiff: 2,
    goalWakeH: 8,
  });
  const trough = Math.min(...plan.days.map((d) => d.amplitude));
  assert.ok(trough > 0.9, `a gentle 2h shift should stay robust, trough was ${trough}`);
});

// --- intensity ------------------------------------------------------------

test('intensity ramps gently before the flight and runs hard after landing', () => {
  const first = intensityForDay(-4, 4);
  const last = intensityForDay(-1, 4);
  const landing = intensityForDay(0, 4);
  assert.equal(first.factor, INTENSITY.gentle);
  assert.ok(last.factor > first.factor, 'ramps upward across prep days');
  assert.ok(last.factor <= INTENSITY.moderate, 'never exceeds moderate before flying');
  assert.equal(landing.factor, INTENSITY.aggressive);
});

test('respond mode with no prep days still runs aggressive on arrival', () => {
  assert.equal(intensityForDay(0, 0).factor, INTENSITY.aggressive);
});

// --- shift plan -----------------------------------------------------------

test('the plan delivers exactly the required shift and never overshoots', () => {
  const shift = requiredShift({ tzDiff: 5, currentWakeH: 8, goalWakeH: 8 });
  const plan = buildShiftPlan({ shift, prepDays: 3, currentWakeH: 8, tzDiff: 5, goalWakeH: 8 });
  const total = plan.days.reduce((s, d) => s + d.shiftedToday, 0);
  assert.ok(close(total, 5), `expected 5h total, got ${total}`);
  assert.ok(plan.days.every((d) => d.shiftedTotal <= shift.magnitude + 1e-9));
  assert.ok(close(plan.leftover, 0));
});

test('the plan lands on the goal CBTmin at the destination', () => {
  const shift = requiredShift({ tzDiff: 5, currentWakeH: 8, goalWakeH: 8 });
  const plan = buildShiftPlan({ shift, prepDays: 3, currentWakeH: 8, tzDiff: 5, goalWakeH: 8 });
  const final = plan.days[plan.days.length - 1];
  assert.ok(final.atDestination);
  assert.ok(close(final.cbtMinH, plan.goalCbtMinH), `${final.cbtMinH} vs ${plan.goalCbtMinH}`);
  assert.ok(close(final.wakeH, 8), `final wake should be the 8am goal, got ${final.wakeH}`);
});

test('post-arrival days keep shifting when prep was skipped', () => {
  // The old engine assumed you were fully adapted on landing. Check that a
  // zero-prep 8h shift is still being worked through after arrival.
  const shift = requiredShift({ tzDiff: 8, currentWakeH: 8, goalWakeH: 8 });
  const plan = buildShiftPlan({ shift, prepDays: 0, currentWakeH: 8, tzDiff: 8, goalWakeH: 8 });
  const arrival = plan.days.filter((d) => d.dayOffset >= 0);
  assert.ok(arrival.length > 2, 'should span more than two days');
  assert.ok(arrival[0].shiftedTotal < shift.magnitude, 'not adapted on landing day');
  const final = plan.days[plan.days.length - 1];
  assert.ok(close(final.cbtMinH, plan.goalCbtMinH), 'still reaches the goal eventually');
});

test('advancing is slower than delaying for the same magnitude', () => {
  const east = buildShiftPlan({
    shift: requiredShift({ tzDiff: 6, currentWakeH: 8, goalWakeH: 8 }),
    prepDays: 0, currentWakeH: 8, tzDiff: 6, goalWakeH: 8,
  });
  const west = buildShiftPlan({
    shift: requiredShift({ tzDiff: -6, currentWakeH: 8, goalWakeH: 8 }),
    prepDays: 0, currentWakeH: 8, tzDiff: -6, goalWakeH: 8,
  });
  const daysUsed = (p) => p.days.filter((d) => d.shiftedToday > 0.01).length;
  assert.ok(daysUsed(east) > daysUsed(west), 'a 6h advance should take longer than a 6h delay');
});

test('daily movement respects the rate for that day', () => {
  const shift = requiredShift({ tzDiff: 9, currentWakeH: 8, goalWakeH: 8 });
  const plan = buildShiftPlan({ shift, prepDays: 4, currentWakeH: 8, tzDiff: 9, goalWakeH: 8 });
  for (const d of plan.days) {
    assert.ok(d.shiftedToday <= d.rate + 1e-9, `day ${d.dayOffset} moved faster than its rate`);
    assert.ok(close(d.rate, BASE_RATE[shift.direction] * d.intensityFactor));
  }
});

// --- prescriptions --------------------------------------------------------

test('advance light starts at wake, not inside sleep', () => {
  const cbt = 4; // 8am wake
  const w = lightWindow(cbt, 'advance');
  const [bed, wake] = sleepWindow(cbt);
  assert.equal(wake, cbt + CBTMIN_BEFORE_WAKE);
  assert.equal(bed, wake - SLEEP_HOURS);
  assert.ok(w.start >= wake, 'light must not be scheduled while asleep');
  assert.equal(w.start, 8);
  assert.equal(w.end, 10);
});

test('delay light ends at bedtime, not inside sleep', () => {
  const cbt = 4;
  const w = lightWindow(cbt, 'delay');
  const [bed] = sleepWindow(cbt);
  assert.ok(w.end <= bed, 'light must not be scheduled while asleep');
  assert.equal(w.start, -2);
  assert.equal(w.end, 0);
});

test('the avoid window is on the opposite PRC arm from the light window', () => {
  const cbt = 4;
  const adv = { light: lightWindow(cbt, 'advance'), avoid: avoidWindow(cbt, 'advance') };
  assert.equal(prcAt(adv.light.start - cbt).direction, 'advance');
  assert.equal(prcAt(adv.avoid.start - cbt).direction, 'delay');

  const del = { light: lightWindow(cbt, 'delay'), avoid: avoidWindow(cbt, 'delay') };
  assert.equal(prcAt(del.light.start - cbt).direction, 'delay');
  assert.equal(prcAt(del.avoid.start - cbt).direction, 'advance');
});

test('light and avoid windows never overlap', () => {
  for (const dir of ['advance', 'delay']) {
    for (let cbt = 0; cbt < 24; cbt += 0.5) {
      const l = lightWindow(cbt, dir);
      const a = avoidWindow(cbt, dir);
      const overlap = Math.min(l.end, a.end) - Math.max(l.start, a.start);
      assert.ok(overlap <= 1e-9, `${dir} at cbt=${cbt} overlaps by ${overlap}`);
    }
  }
});

// --- end to end -----------------------------------------------------------

const BOS_LHR = {
  departureAirport: 'BOS',
  arrivalAirport: 'LHR',
  departureDatetime: '2026-05-15T18:30',
  arrivalDatetime: '2026-05-16T06:45',
};

test('Boston to London produces a 5h advance', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  assert.equal(r.model.direction, 'advance');
  assert.ok(close(r.model.shiftMagnitude, 5));
  assert.equal(r.model.cbtMinHomeH, 4, 'CBTmin is 4am for an 8am wake');
  assert.equal(r.model.cbtMinGoalH, 4, 'goal CBTmin is 4am London');
  assert.ok(r.entries.length > 0);
});

test('schedule days are anchored to the landing date', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  const prep = r.entries.filter((e) => e.dayOffset === -3);
  assert.ok(prep.length > 0, 'should have a day -3');
  // Landing is 16 May, so day -3 is 13 May at home.
  for (const e of prep) {
    assert.equal(e.timezone, 'America/New_York');
  }
  const keys = [...new Set(prep.map((e) => e.dateKey))];
  assert.deepEqual(keys, ['2026-05-13']);
});

test('post-arrival entries use the destination timezone', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  for (const e of r.entries.filter((x) => x.dayOffset >= 0)) {
    assert.equal(e.timezone, 'Europe/London');
  }
});

test('no two blocking entries overlap', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  const blocking = r.entries
    .filter((e) => !NON_BLOCKING.has(e.activity_type))
    .sort((a, b) => a.start - b.start);
  for (let i = 1; i < blocking.length; i++) {
    assert.ok(
      blocking[i].start >= blocking[i - 1].end,
      `${blocking[i - 1].activity_type} overlaps ${blocking[i].activity_type}`
    );
  }
});

test('every entry ends after it starts', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  for (const e of r.entries) {
    assert.ok(e.end > e.start, `${e.activity_type} has non-positive duration`);
  }
});

test('an eastward departure is not scheduled a day early', () => {
  // London to New York: the departure timezone is UTC+1, which broke the old
  // UTC-midnight arithmetic.
  const r = generateSchedule(
    { departureAirport: 'LHR', arrivalAirport: 'JFK', departureDatetime: '2026-05-15T11:00', arrivalDatetime: '2026-05-15T13:45' },
    { currentWakeTime: '07:00', goalWakeTime: '07:00', daysPrep: 2, mode: 'prepare' },
    airports
  );
  assert.equal(r.model.direction, 'delay');
  assert.ok(close(r.model.shiftMagnitude, 5));
  const prep = r.entries.filter((e) => e.dayOffset === -2);
  assert.deepEqual([...new Set(prep.map((e) => e.dateKey))], ['2026-05-13']);
});

test('a Tokyo departure is not scheduled a day early', () => {
  const r = generateSchedule(
    { departureAirport: 'NRT', arrivalAirport: 'LAX', departureDatetime: '2026-05-15T17:00', arrivalDatetime: '2026-05-15T10:30' },
    { currentWakeTime: '07:00', goalWakeTime: '07:00', daysPrep: 2, mode: 'prepare' },
    airports
  );
  const prep = r.entries.filter((e) => e.dayOffset === -1);
  assert.deepEqual([...new Set(prep.map((e) => e.dateKey))], ['2026-05-14']);
  for (const e of prep) assert.equal(e.timezone, 'Asia/Tokyo');
});

test('respond mode emits nothing before landing day', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'respond' }, airports);
  assert.ok(r.entries.every((e) => e.dayOffset >= 0));
  assert.equal(r.summary.prepDays, 0);
});

test('prepare mode emits the requested number of prep days', () => {
  for (const days of [0, 1, 3, 5, 7]) {
    const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: days, mode: 'prepare' }, airports);
    const offsets = [...new Set(r.entries.map((e) => e.dayOffset))];
    // === rather than assert.equal so that 0 and -0 compare as the same day.
    assert.ok(Math.min(...offsets) === -days, `daysPrep=${days}`);
  }
});

test('sleep blocks are always 8h before trimming and never zero after', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  const sleeps = r.entries.filter((e) => e.activity_type === 'sleep');
  assert.ok(sleeps.length > 0);
  for (const s of sleeps) {
    const hours = (s.end - s.start) / 3600000;
    assert.ok(close(hours, SLEEP_HOURS, 0.01), `sleep block was ${hours}h`);
  }
});

test('bright light is never scheduled during sleep', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  const sleeps = r.entries.filter((e) => e.activity_type === 'sleep');
  const lights = r.entries.filter((e) => e.activity_type === 'bright_light');
  for (const l of lights) {
    for (const s of sleeps) {
      const overlap = Math.min(l.end, s.end) - Math.max(l.start, s.start);
      assert.ok(overlap <= 0, 'light overlaps a sleep block');
    }
  }
});

test('entries during the flight are flagged', () => {
  const r = generateSchedule(BOS_LHR, { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 3, mode: 'prepare' }, airports);
  const dep = new Date(BOS_LHR.departureDatetime).getTime();
  const arr = new Date(BOS_LHR.arrivalDatetime).getTime();
  for (const e of r.entries) {
    const overlaps = e.start.getTime() < arr && e.end.getTime() > dep;
    assert.equal(e.inFlight, overlaps, `${e.activity_type} inFlight flag is wrong`);
  }
});

test('an unknown airport is rejected', () => {
  assert.throws(
    () => generateSchedule({ ...BOS_LHR, arrivalAirport: 'ZZZ' }, { currentWakeTime: '08:00' }, airports),
    /Unknown airport: ZZZ/
  );
});

test('a zero-shift trip still produces a maintenance schedule', () => {
  const r = generateSchedule(
    { departureAirport: 'BOS', arrivalAirport: 'MIA', departureDatetime: '2026-05-15T09:00', arrivalDatetime: '2026-05-15T12:30' },
    { currentWakeTime: '08:00', goalWakeTime: '08:00', daysPrep: 2, mode: 'prepare' },
    airports
  );
  assert.equal(r.model.shiftMagnitude, 0);
  assert.ok(r.entries.length > 0, 'should still schedule sleep and daylight');
});

test('a trip across the dateline is planned the short way', () => {
  const r = generateSchedule(
    { departureAirport: 'LAX', arrivalAirport: 'SYD', departureDatetime: '2026-05-15T22:30', arrivalDatetime: '2026-05-17T08:00' },
    { currentWakeTime: '07:00', goalWakeTime: '07:00', daysPrep: 3, mode: 'prepare' },
    airports
  );
  assert.ok(r.model.shiftMagnitude <= 12, `magnitude was ${r.model.shiftMagnitude}`);
  assert.equal(r.model.wrapped, true);
});
