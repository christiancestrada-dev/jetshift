/**
 * Turns a flight plus a set of preferences into dated, timezone-correct
 * calendar entries. All circadian reasoning lives in circadian.js; this file
 * is responsible for placing that reasoning on a real calendar.
 */

import {
  getTimezoneOffsetHours,
  civilInZone,
  addDays,
  civilKey,
  zonedTimeToUtc,
  parseClock,
  formatHour,
  formatDuration,
  parseWallClock,
} from './time.js';

import {
  requiredShift,
  buildShiftPlan,
  lightWindow,
  avoidWindow,
  melatoninTime,
  caffeineCutoff,
  eatingWindow,
  sleepWindow,
  amplitudeBoostWindow,
  prcWindows,
} from './circadian.js';

/**
 * Higher wins when two blocks collide. Sleep is non-negotiable; a light
 * instruction that overlaps it gets trimmed, never the other way round.
 */
const PRIORITY = {
  sleep: 100,
  light_avoidance: 80,
  bright_light: 70,
  amplitude_boost: 60,
  dim_light: 40,
};

/** Point-in-time or background blocks, exempt from collision trimming. */
const NON_BLOCKING = new Set(['melatonin', 'caffeine_cutoff', 'eating']);

const MIN_BLOCK_MS = 10 * 60 * 1000;

// --- Interval bookkeeping -------------------------------------------------

/** Subtract a set of [start,end] ms intervals from one interval. */
function subtractIntervals(interval, occupied) {
  let pieces = [interval];
  for (const [os, oe] of occupied) {
    const next = [];
    for (const [ps, pe] of pieces) {
      if (oe <= ps || os >= pe) {
        next.push([ps, pe]);
        continue;
      }
      if (os > ps) next.push([ps, os]);
      if (oe < pe) next.push([oe, pe]);
    }
    pieces = next;
  }
  return pieces;
}

/**
 * Resolve collisions by priority. Blocking entries are laid down strongest
 * first; weaker ones are cut around whatever is already on the calendar and
 * may end up split into several pieces or dropped entirely.
 */
function resolveOverlaps(entries) {
  const passthrough = entries.filter((e) => NON_BLOCKING.has(e.activity_type));
  const blocking = entries
    .filter((e) => !NON_BLOCKING.has(e.activity_type))
    .sort((a, b) => (PRIORITY[b.activity_type] ?? 0) - (PRIORITY[a.activity_type] ?? 0)
      || a.start - b.start);

  const occupied = [];
  const kept = [];

  for (const entry of blocking) {
    const pieces = subtractIntervals(
      [entry.start.getTime(), entry.end.getTime()],
      occupied
    );
    for (const [s, e] of pieces) {
      if (e - s < MIN_BLOCK_MS) continue;
      kept.push({ ...entry, start: new Date(s), end: new Date(e) });
      occupied.push([s, e]);
    }
  }

  return [...kept, ...passthrough].sort((a, b) => a.start - b.start);
}

// --- Entry construction ---------------------------------------------------

function makeEntry({ day, civil, startH, endH, type, description, timezone, meta }) {
  return {
    dayOffset: day.dayOffset,
    dateKey: civilKey(civil),
    start: zonedTimeToUtc(civil, startH, timezone),
    end: zonedTimeToUtc(civil, endH, timezone),
    activity_type: type,
    description,
    timezone,
    ...meta,
  };
}

// --- Main -----------------------------------------------------------------

/**
 * Resolve the two `datetime-local` values into real instants.
 *
 * The takeoff string is wall-clock time at the origin and the landing string is
 * wall-clock time at the destination, so each is converted in its own zone.
 * Comparing the raw strings instead — which the UI used to do — rejects any
 * transpacific flight that lands at an earlier clock time than it left.
 */
export function resolveFlight(flight, airports) {
  const depCode = flight.departureAirport?.toUpperCase();
  const arrCode = flight.arrivalAirport?.toUpperCase();
  const dep = airports[depCode];
  const arr = airports[arrCode];
  if (!dep) throw new Error(`Unknown airport: ${depCode || '—'}`);
  if (!arr) throw new Error(`Unknown airport: ${arrCode || '—'}`);

  const depWall = parseWallClock(flight.departureDatetime);
  const arrWall = parseWallClock(flight.arrivalDatetime);
  if (!depWall) throw new Error('Invalid takeoff time');
  if (!arrWall) throw new Error('Invalid landing time');

  return {
    depCode,
    arrCode,
    dep,
    arr,
    depInstant: zonedTimeToUtc(depWall.civil, depWall.hour, dep.timezone),
    arrInstant: zonedTimeToUtc(arrWall.civil, arrWall.hour, arr.timezone),
  };
}

export function generateSchedule(flight, prefs, airports) {
  const { depCode, arrCode, dep, arr, depInstant, arrInstant } = resolveFlight(flight, airports);

  const depOff = getTimezoneOffsetHours(dep.timezone, depInstant);
  const arrOff = getTimezoneOffsetHours(arr.timezone, arrInstant);
  const tzDiff = arrOff - depOff;

  const currentWakeH = parseClock(prefs.currentWakeTime, 7);
  const goalWakeH = parseClock(prefs.goalWakeTime, currentWakeH);
  const mode = prefs.mode === 'respond' ? 'respond' : 'prepare';
  const prepDays = mode === 'respond' ? 0 : Math.max(0, Math.min(7, prefs.daysPrep ?? 3));

  const shift = requiredShift({ tzDiff, currentWakeH, goalWakeH });
  const plan = buildShiftPlan({ shift, prepDays, currentWakeH, tzDiff, goalWakeH });

  // Every day is indexed off the landing date, which is what the UI promises.
  const landingCivil = civilInZone(arrInstant, arr.timezone);
  const dir = shift.direction;
  const dirVerb = dir === 'advance' ? 'earlier' : 'later';
  const entries = [];

  for (const day of plan.days) {
    const civil = addDays(landingCivil, day.dayOffset);
    const tz = day.atDestination ? arr.timezone : dep.timezone;
    const place = day.atDestination ? arr.city : dep.city;
    const cbt = day.cbtMinH;
    const add = (startH, endH, type, description, meta) => {
      if (endH - startH <= 0) return;
      entries.push(makeEntry({ day, civil, startH, endH, type, description, timezone: tz, meta }));
    };

    const cbtLabel = formatHour(cbt);

    // Sleep — the anchor everything else is placed around.
    const [bedH, wakeH] = sleepWindow(cbt);
    add(bedH, wakeH, 'sleep',
      day.shiftedToday > 0.01
        ? `Sleep ${formatHour(bedH)}–${formatHour(wakeH)} ${place} time. That is ${formatDuration(day.shiftedTotal)} ${dirVerb} than your usual night, ${formatDuration(day.shiftedToday)} of it added today.`
        : `Sleep ${formatHour(bedH)}–${formatHour(wakeH)} ${place} time. Your clock is where it needs to be — hold this.`,
      { amplitude: day.amplitude, intensity: day.intensity });

    // Bright light in the reachable part of the correct PRC zone.
    const light = lightWindow(cbt, dir);
    add(light.start, light.end, 'bright_light',
      dir === 'advance'
        ? `Get outside within minutes of waking. CBTmin is ${cbtLabel}, so this sits in the advance zone and pulls your clock ${dirVerb}. The stronger part of that zone falls while you are still asleep, which is why advancing only manages ${formatDuration(day.rate)} a day.`
        : `Bright light in the ${formatDuration(light.end - light.start)} before bed. CBTmin is ${cbtLabel}, so light here lands in the delay zone and pushes your clock ${dirVerb}.`,
      { band: light.band, intensity: day.intensity });

    // The mirror-image window that would undo the day's work.
    const avoid = avoidWindow(cbt, dir);
    add(avoid.start, avoid.end, 'light_avoidance',
      dir === 'advance'
        ? `Keep it dark. Light now falls in the delay zone on the far side of CBTmin (${cbtLabel}) and cancels the advance you earned this morning.`
        : `Keep it dark and wear sunglasses if you go out. Light this soon after waking falls in the advance zone and cancels last night's delay.`,
      { intensity: day.intensity });

    // Wind-down. Placed in the dead zone immediately before the avoidance
    // window, where dimming costs no phase shift. On a delay day the evening
    // light *is* the treatment and runs to bedtime, so there is nothing to
    // taper — winding down early would work against the shift.
    if (dir === 'advance') {
      add(bedH - 4, bedH - 2, 'dim_light',
        `Start dropping the lights, roughly below 50 lux. This sits in the PRC dead zone so it moves nothing by itself — it is the run-up to the dark window that follows, and it lets melatonin rise on time.`);
    } else if (day.shiftedToday < 0.01) {
      add(bedH - 1.5, bedH, 'dim_light',
        `Ordinary wind-down. Nothing left to shift today, so the only job is protecting the phase you have reached.`);
    }

    // Amplitude: daylight across the subjective day strengthens the rhythm
    // without moving it, because this stretch is the PRC's dead zone.
    const [boostStart, boostEnd] = amplitudeBoostWindow(cbt);
    add(boostStart, boostEnd, 'amplitude_boost',
      `Daylight in the middle of your subjective day. This lands in the PRC dead zone so it barely moves your phase — what it does is raise amplitude, which is what makes the new schedule stick. Rhythm strength is tracking at ${Math.round(day.amplitude * 100)}%.`,
      { amplitude: day.amplitude });

    // Melatonin, on the arm of its own PRC that matches the direction.
    const mel = melatoninTime(cbt, dir);
    add(mel, mel + 0.25, 'melatonin',
      dir === 'advance'
        ? `0.5mg, about 5 hours before bed. The melatonin PRC runs roughly antiphase to the light PRC, so an early-evening dose advances while an evening-of-bedtime dose does almost nothing.`
        : `0.5mg on waking. The delay arm of the melatonin PRC sits in the morning, opposite where you would take it to advance.`,
      { pointInTime: true });

    const caf = caffeineCutoff(cbt);
    add(caf, caf + 0.25, 'caffeine_cutoff',
      `Last caffeine. With a 5–6 hour half-life, anything later is still circulating at ${formatHour(bedH)} and will fragment the sleep this whole plan depends on.`,
      { pointInTime: true });

    const [eatStart, eatEnd] = eatingWindow(cbt);
    add(eatStart, eatEnd, 'eating',
      `Eating window. Peripheral clocks in the liver and gut entrain to food, so moving meals with the schedule keeps them from dragging against your central clock.`);
  }

  const resolved = resolveOverlaps(entries);

  // Flag anything that lands mid-flight so the UI can say so.
  const depMs = depInstant.getTime();
  const arrMs = arrInstant.getTime();
  for (const e of resolved) {
    e.inFlight = e.start.getTime() < arrMs && e.end.getTime() > depMs;
  }

  const windows = prcWindows(plan.goalCbtMinH);

  return {
    entries: resolved,
    summary: {
      departure: `${depCode} (${dep.city})`,
      arrival: `${arrCode} (${arr.city})`,
      direction: dir,
      tzDiffHours: tzDiff,
      prepDays,
      mode,
      totalEvents: resolved.length,
      daysToAdapt: plan.days.filter((d) => d.shiftedToday > 0.01).length,
    },
    flight: {
      departureInstant: depInstant.toISOString(),
      arrivalInstant: arrInstant.toISOString(),
      departureTimezone: dep.timezone,
      arrivalTimezone: arr.timezone,
    },
    model: {
      cbtMinHomeH: plan.homeCbtMin,
      cbtMinGoalH: plan.goalCbtMinH,
      shiftHours: shift.hours,
      shiftMagnitude: shift.magnitude,
      direction: dir,
      wrapped: shift.wrapped,
      rawShift: shift.raw,
      tzDiff,
      currentWakeH,
      goalWakeH,
      leftover: plan.leftover,
      finalAmplitude: plan.days.length ? plan.days[plan.days.length - 1].amplitude : 1,
      days: plan.days,
      windows,
    },
  };
}

/** Calendar event for the flight itself. */
export function buildFlightEvent(trip, airports) {
  const { depInstant, arrInstant, dep, arr } = resolveFlight(trip, airports);
  return {
    summary: `${trip.departureAirport} → ${trip.arrivalAirport}`,
    description: 'Flight tracked by JetShift.',
    start: { dateTime: depInstant.toISOString(), timeZone: dep.timezone },
    end: { dateTime: arrInstant.toISOString(), timeZone: arr.timezone },
    colorId: '8',
  };
}
