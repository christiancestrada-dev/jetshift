/**
 * The circadian model. Pure math — no dates, no DOM, no storage.
 *
 * Everything here is expressed in decimal hours on a local 24h clock, relative
 * to CBTmin (core body temperature minimum), which is the reference point the
 * human light phase response curve is anchored to.
 *
 * Parameters were chosen deliberately; see docs/circadian-model.md for sources
 * and for the reasoning behind each number.
 */

import { wrap12, wrap24 } from './time.js';

// --- Anchors -------------------------------------------------------------

/** CBTmin sits this many hours before habitual wake time. */
export const CBTMIN_BEFORE_WAKE = 4;

/** Assumed sleep opportunity. Wake and bed are both derived from CBTmin. */
export const SLEEP_HOURS = 8;

/**
 * Baseline entrainment rate in hours per day, before the intensity ramp.
 *
 * Advances are slower than delays for two reasons that compound: the intrinsic
 * human period is slightly longer than 24h, so delaying moves with the free-run
 * and advancing fights it; and the advance portion of the PRC that you can
 * actually reach while awake is only its weaker tail (see lightWindow below).
 */
export const BASE_RATE = { advance: 1.0, delay: 1.5 };

/** Multipliers applied to BASE_RATE. Gentle before the flight, hard after. */
export const INTENSITY = { gentle: 0.6, moderate: 1.0, aggressive: 1.4 };

/** Cap on how many days of post-arrival schedule to emit. */
export const MAX_ARRIVAL_DAYS = 7;

// --- Phase response curve ------------------------------------------------

/**
 * Window half-widths, in hours either side of CBTmin.
 * Strong core out to 3h, weaker tail out to 6h, dead zone beyond.
 */
export const PRC_STRONG_H = 3;
export const PRC_MODERATE_H = 6;

export const PRC_STRENGTH = { strong: 1.0, moderate: 0.5, dead: 0.1 };

/**
 * Effect of bright light applied `tau` hours after CBTmin.
 * Negative tau is before CBTmin. Returns the direction the clock moves.
 */
export function prcAt(tau) {
  const t = wrap12(tau);
  const mag = Math.abs(t);

  if (mag > PRC_MODERATE_H) {
    return { direction: 'none', band: 'dead', strength: PRC_STRENGTH.dead };
  }

  const direction = t >= 0 ? 'advance' : 'delay';
  const band = mag <= PRC_STRONG_H ? 'strong' : 'moderate';
  return { direction, band, strength: PRC_STRENGTH[band] };
}

/**
 * The four PRC windows as absolute local clock times, given CBTmin.
 * Each is `[start, end]` in decimal hours, unwrapped (may exceed 24 or go
 * negative) so callers can reason about ordering before normalising.
 */
export function prcWindows(cbtMinH) {
  return {
    strongAdvance: [cbtMinH, cbtMinH + PRC_STRONG_H],
    moderateAdvance: [cbtMinH + PRC_STRONG_H, cbtMinH + PRC_MODERATE_H],
    strongDelay: [cbtMinH - PRC_STRONG_H, cbtMinH],
    moderateDelay: [cbtMinH - PRC_MODERATE_H, cbtMinH - PRC_STRONG_H],
    deadZone: [cbtMinH + PRC_MODERATE_H, cbtMinH + 24 - PRC_MODERATE_H],
  };
}

// --- Amplitude -----------------------------------------------------------

/**
 * Amplitude is the peak-to-trough size of the rhythm, distinct from its phase.
 * Light does different things to it depending on where in the cycle it lands.
 *
 *  - Right at the trough, light drives the oscillator toward its singularity
 *    and suppresses amplitude. A flattened clock re-entrains faster but holds
 *    its new phase poorly and feels worse doing it.
 *  - Across the subjective day, light reinforces amplitude without moving
 *    phase much, because that stretch is the PRC's dead zone.
 */
export const AMPLITUDE_FLATTEN_H = 1.5;
export const AMPLITUDE_BOOST_WINDOW = [6, 14];

export function amplitudeAt(tau) {
  const t24 = wrap24(tau);
  const distanceFromNadir = Math.min(t24, 24 - t24);

  if (distanceFromNadir <= AMPLITUDE_FLATTEN_H) {
    return { effect: 'flatten', strength: 1 - distanceFromNadir / AMPLITUDE_FLATTEN_H };
  }
  const [lo, hi] = AMPLITUDE_BOOST_WINDOW;
  if (t24 >= lo && t24 <= hi) {
    return { effect: 'boost', strength: 1 };
  }
  return { effect: 'neutral', strength: 0 };
}

/** Two-hour bright-light slice inside the boosting window. */
export function amplitudeBoostWindow(cbtMinH) {
  return [cbtMinH + 7, cbtMinH + 9];
}

/**
 * Qualitative rhythm-strength index in [0,1], starting at 1.0.
 *
 * This is a heuristic for the UI, not a physiological prediction: it says
 * "shifting fast costs you robustness, daylight buys some back". The constants
 * are tuned for a readable curve, not fitted to data.
 */
export const AMPLITUDE_COST_PER_HOUR_SHIFTED = 0.10;
export const AMPLITUDE_BOOST_GAIN = 0.03;
export const AMPLITUDE_DAILY_RECOVERY = 0.02;
export const AMPLITUDE_FLOOR = 0.5;

export function nextAmplitude(previous, { hoursShifted, hasBoost }) {
  let a = previous;
  a -= AMPLITUDE_COST_PER_HOUR_SHIFTED * hoursShifted;
  a += AMPLITUDE_DAILY_RECOVERY;
  if (hasBoost) a += AMPLITUDE_BOOST_GAIN;
  return Math.max(AMPLITUDE_FLOOR, Math.min(1, a));
}

// --- Required shift ------------------------------------------------------

/**
 * How far the clock has to move, in hours. Positive means advance (earlify),
 * negative means delay (lateify).
 *
 * Derivation: left alone, your body will want to wake at `currentWakeH` home
 * time, which reads as `currentWakeH + tzDiff` on the destination clock. The
 * gap between that and `goalWakeH` is the work to be done.
 *
 *   advance = (currentWakeH + tzDiff) - goalWakeH
 *
 * Wrapped into (-12, 12] so a 14h eastward trip is planned as a 10h delay
 * rather than a 14h advance — going the short way round is always less work,
 * and delays are the cheaper direction besides.
 */
export function requiredShift({ tzDiff, currentWakeH, goalWakeH }) {
  const raw = tzDiff + currentWakeH - goalWakeH;
  const hours = wrap12(raw);
  return {
    hours,
    magnitude: Math.abs(hours),
    direction: hours >= 0 ? 'advance' : 'delay',
    raw,
    wrapped: Math.abs(raw - hours) > 1e-9,
  };
}

// --- Intensity ramp ------------------------------------------------------

/**
 * Intensity by trip phase. Pre-flight days ease in from gentle to moderate so
 * you are not wrecked before you leave; from landing day onward the schedule
 * runs aggressive, because that is when adaptation actually matters and when
 * the destination's light-dark cycle is pulling in the same direction.
 *
 * `dayOffset` is relative to the landing date: negative before, 0 on the day.
 */
export function intensityForDay(dayOffset, prepDays) {
  if (dayOffset >= 0) return { factor: INTENSITY.aggressive, label: 'aggressive' };
  if (prepDays <= 0) return { factor: INTENSITY.moderate, label: 'moderate' };

  const progress = (dayOffset + prepDays) / prepDays;
  const factor = INTENSITY.gentle + (INTENSITY.moderate - INTENSITY.gentle) * progress;
  return { factor, label: factor < 0.8 ? 'gentle' : 'moderate' };
}

export function dailyRate(direction, factor) {
  return BASE_RATE[direction] * factor;
}

// --- Day-by-day plan -----------------------------------------------------

/**
 * Walk the trip day by day, moving the clock as fast as that day's intensity
 * allows until the required shift is used up.
 *
 * Returns one entry per day with the body clock's position expressed on the
 * local clock of wherever you physically are that day.
 */
export function buildShiftPlan({ shift, prepDays, currentWakeH, tzDiff, goalWakeH }) {
  const homeCbtMin = currentWakeH - CBTMIN_BEFORE_WAKE;
  const sign = shift.direction === 'advance' ? 1 : -1;
  const days = [];

  let advanced = 0;
  let amplitude = 1;
  let remaining = shift.magnitude;

  const push = (dayOffset, atDestination) => {
    const { factor, label } = intensityForDay(dayOffset, prepDays);
    const rate = dailyRate(shift.direction, factor);
    const applied = Math.min(rate, remaining);
    remaining -= applied;
    advanced += applied;

    // Body clock position on the home clock, then rebased to wherever we are.
    const cbtHome = homeCbtMin - sign * advanced;
    const cbtLocal = atDestination ? cbtHome + tzDiff : cbtHome;

    amplitude = nextAmplitude(amplitude, { hoursShifted: applied, hasBoost: true });

    days.push({
      dayOffset,
      atDestination,
      intensity: label,
      intensityFactor: factor,
      rate,
      shiftedToday: applied,
      shiftedTotal: advanced,
      remaining,
      amplitude,
      cbtMinH: cbtLocal,
      wakeH: cbtLocal + CBTMIN_BEFORE_WAKE,
      bedH: cbtLocal + CBTMIN_BEFORE_WAKE - SLEEP_HOURS,
    });
  };

  for (let d = -prepDays; d < 0; d++) push(d, false);

  // Landing day plus however many days it takes to finish, plus one to settle.
  let d = 0;
  while (d < MAX_ARRIVAL_DAYS) {
    push(d, true);
    d++;
    if (remaining <= 1e-9) break;
  }
  if (d < MAX_ARRIVAL_DAYS) push(d, true); // consolidation day at goal phase

  return { days, homeCbtMin, goalCbtMinH: goalWakeH - CBTMIN_BEFORE_WAKE, leftover: remaining };
}

// --- Prescriptions -------------------------------------------------------

/**
 * The stretch of the PRC you can actually use, clipped to the hours you are
 * awake. This clipping is the whole reason advances are hard: to advance you
 * need light after CBTmin, but CBTmin sits 4h before you wake, so the strong
 * core of the advance zone is unreachable without getting up in the dark. What
 * is left is the moderate tail — 2 hours starting at wake.
 */
export function lightWindow(cbtMinH, direction) {
  const wake = cbtMinH + CBTMIN_BEFORE_WAKE;
  const bed = wake - SLEEP_HOURS;

  if (direction === 'advance') {
    // Ideal is [CBTmin, CBTmin+6]; you are only awake for the tail of it.
    const start = Math.max(cbtMinH, wake);
    const end = Math.max(start, cbtMinH + PRC_MODERATE_H);
    return { start, end, band: prcAt(start - cbtMinH).band };
  }

  // Ideal is [CBTmin-6, CBTmin]; you are asleep from bedtime onward.
  const start = cbtMinH - PRC_MODERATE_H;
  const end = Math.min(cbtMinH, bed);
  return { start: Math.min(start, end), end, band: prcAt((start + end) / 2 - cbtMinH).band };
}

/** The window to keep dark, because light there pushes the wrong way. */
export function avoidWindow(cbtMinH, direction) {
  const wake = cbtMinH + CBTMIN_BEFORE_WAKE;
  const bed = wake - SLEEP_HOURS;

  if (direction === 'advance') {
    // Evening light lands in the delay zone and undoes the day's work.
    return { start: Math.max(cbtMinH - PRC_MODERATE_H, bed - 2), end: bed };
  }
  // Morning light lands in the advance zone and undoes the day's work.
  return { start: wake, end: Math.min(cbtMinH + PRC_MODERATE_H, wake + 2) };
}

/**
 * Melatonin timing. The melatonin PRC runs roughly antiphase to the light PRC:
 * taking it in the early evening advances, taking it on waking delays.
 */
export function melatoninTime(cbtMinH, direction) {
  const wake = cbtMinH + CBTMIN_BEFORE_WAKE;
  const bed = wake - SLEEP_HOURS;
  return direction === 'advance' ? bed - 5 : wake;
}

export function caffeineCutoff(cbtMinH) {
  return cbtMinH + CBTMIN_BEFORE_WAKE + 8;
}

export function eatingWindow(cbtMinH) {
  const wake = cbtMinH + CBTMIN_BEFORE_WAKE;
  return [wake + 0.5, wake + 11.5];
}

export function sleepWindow(cbtMinH) {
  const wake = cbtMinH + CBTMIN_BEFORE_WAKE;
  return [wake - SLEEP_HOURS, wake];
}
