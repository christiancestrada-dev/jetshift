/**
 * Timezone and civil-date helpers.
 *
 * The rule this module exists to enforce: a "day" in a schedule is a civil date
 * (year/month/day) in some timezone, not a UTC instant. Mixing the two is what
 * caused JetShift to emit every event a day early for departures east of
 * Greenwich, where local midnight falls on the previous UTC date.
 */

const MS_PER_HOUR = 3600000;

const offsetFormatters = new Map();

function offsetFormatter(timezone) {
  let fmt = offsetFormatters.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    offsetFormatters.set(timezone, fmt);
  }
  return fmt;
}

/**
 * UTC offset of `timezone` at the moment `date`, in hours.
 * Positive east of Greenwich. Correct across DST transitions.
 *
 * Reads the wall clock in `timezone` and reinterprets it as if it were UTC;
 * the gap between that and the real instant is the offset. The obvious
 * alternative — parsing two `toLocaleString` outputs and subtracting — is
 * wrong near a DST boundary, because `new Date(string)` resolves each string
 * against the *host* machine's timezone and the two can land on opposite
 * sides of the host's own transition.
 */
export function getTimezoneOffsetHours(timezone, date) {
  const parts = offsetFormatter(timezone).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asIfUtc = Date.UTC(
    get('year'), get('month') - 1, get('day'),
    get('hour') % 24, get('minute'), get('second')
  );
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return (asIfUtc - actual) / MS_PER_HOUR;
}

/**
 * A civil date is `{ y, m, d }` with m zero-indexed, carrying no timezone.
 * Represented internally as UTC midnight so day arithmetic is exact — UTC has
 * no DST, so adding 86400000ms always lands on the next calendar day.
 */
export function civilFromParts(y, m, d) {
  return { y, m, d };
}

/** Civil date of `date` as observed in `timezone`. */
export function civilInZone(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month') - 1, d: get('day') };
}

/** Civil date `n` days after `civil`. Negative `n` moves backwards. */
export function addDays(civil, n) {
  const ms = Date.UTC(civil.y, civil.m, civil.d) + n * 86400000;
  const dt = new Date(ms);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth(), d: dt.getUTCDate() };
}

/** Whole days from `a` to `b`, both civil dates. */
export function daysBetween(a, b) {
  return Math.round((Date.UTC(b.y, b.m, b.d) - Date.UTC(a.y, a.m, a.d)) / 86400000);
}

/** Stable key for grouping and comparison. */
export function civilKey(civil) {
  return `${civil.y}-${String(civil.m + 1).padStart(2, '0')}-${String(civil.d).padStart(2, '0')}`;
}

export function civilFromKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m: m - 1, d };
}

/**
 * Convert a wall-clock time in `timezone` to the UTC instant it names.
 *
 * `hour` may sit outside [0,24): 26.5 means 2:30am the following day, -3 means
 * 9pm the previous day. Callers rely on this for sleep windows that cross
 * midnight and for light sessions computed relative to CBTmin.
 *
 * Iterative because the offset depends on the instant we are solving for. We
 * guess using the offset at the naive timestamp, then check that the answer
 * round-trips. If neither candidate round-trips, the wall time names an hour
 * that does not exist — the spring-forward gap — and we resolve it forward,
 * so a 2:30am instruction on a transition day becomes 3:30am rather than
 * silently sliding back to 1:30am.
 */
export function zonedTimeToUtc(civil, hour, timezone) {
  const dayShift = Math.floor(hour / 24);
  const localHour = hour - dayShift * 24;
  const day = dayShift === 0 ? civil : addDays(civil, dayShift);

  const h = Math.floor(localHour);
  const min = Math.round((localHour - h) * 60);
  // Minutes are added separately so a rounded 60 carries into the next hour.
  const naive = Date.UTC(day.y, day.m, day.d, h, 0) + min * 60000;

  const offA = getTimezoneOffsetHours(timezone, new Date(naive));
  const candidateA = naive - offA * MS_PER_HOUR;
  if (getTimezoneOffsetHours(timezone, new Date(candidateA)) === offA) {
    return new Date(candidateA);
  }

  const offB = getTimezoneOffsetHours(timezone, new Date(candidateA));
  const candidateB = naive - offB * MS_PER_HOUR;
  if (getTimezoneOffsetHours(timezone, new Date(candidateB)) === offB) {
    return new Date(candidateB);
  }

  return new Date(Math.max(candidateA, candidateB));
}

/** Decimal hours since local midnight, e.g. 6.5 for 06:30. */
export function localDecimalHour(date, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const h = get('hour') % 24;
  return h + get('minute') / 60;
}

/** Parse "HH:MM" into decimal hours. */
export function parseClock(str, fallback = 7) {
  if (!str) return fallback;
  const [h, m] = str.split(':').map(Number);
  if (Number.isNaN(h)) return fallback;
  return h + (Number.isNaN(m) ? 0 : m) / 60;
}

/** Wrap decimal hours into [0,24). */
export function wrap24(h) {
  return ((h % 24) + 24) % 24;
}

/** Wrap decimal hours into [-12,12) — the signed distance around a 24h clock. */
export function wrap12(h) {
  return wrap24(h + 12) - 12;
}

/** Format decimal hours as a 12-hour clock string. */
export function formatHour(h) {
  const n = wrap24(h);
  let hh = Math.floor(n);
  let mm = Math.round((n - hh) * 60);
  if (mm === 60) {
    mm = 0;
    hh = (hh + 1) % 24;
  }
  const suffix = hh >= 12 ? 'PM' : 'AM';
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${suffix}`;
}

/** Format a duration in hours as "5h" or "5h 30m". */
export function formatDuration(h) {
  const total = Math.round(h * 60);
  const hh = Math.floor(total / 60);
  const mm = total % 60;
  if (hh === 0) return `${mm}m`;
  return mm === 0 ? `${hh}h` : `${hh}h ${mm}m`;
}
