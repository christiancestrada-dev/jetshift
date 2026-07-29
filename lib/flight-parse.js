/**
 * Best-effort parsing of a pasted booking confirmation.
 *
 * Airline emails have no common format, so this reads loosely: an IATA pair or
 * two city names for the route, then any two parseable timestamps, preferring
 * ones on lines that say "departs" or "arrives". Anything it cannot work out
 * is left for the user rather than guessed at.
 */

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const pad = (n, w = 2) => String(n).padStart(w, '0');

/**
 * Names a city can be written as. Entries are labelled "London (Heathrow)",
 * but people paste "London", so index both.
 */
function cityAliases(city) {
  const full = city.toLowerCase().trim();
  const base = full.replace(/\s*\(.*\)\s*$/, '').trim();
  return base && base !== full ? [full, base] : [full];
}

/**
 * Build a token resolver: IATA code, full city label, or bare city name to a
 * code. Where a city has several airports the first listed wins, which puts
 * "London" on LHR rather than LGW.
 */
export function makeResolver(airports) {
  const byCity = new Map();
  for (const [code, info] of Object.entries(airports)) {
    for (const alias of cityAliases(info.city)) {
      if (!byCity.has(alias)) byCity.set(alias, code);
    }
  }
  return (token) => {
    const t = token.trim();
    const upper = t.toUpperCase();
    if (airports[upper]) return upper;
    return byCity.get(t.toLowerCase()) || null;
  };
}

function toIso({ y, m, d, hh, mm }) {
  return `${pad(y, 4)}-${pad(m + 1)}-${pad(d)}T${pad(hh)}:${pad(mm)}`;
}

/**
 * Pull a date and time out of one line.
 * Returns `hasDate: false` when only a clock time was found, so the caller can
 * inherit the date from the other leg.
 */
export function parseDateTime(line, now = new Date()) {
  const iso = line.match(/(\d{4})-(\d{2})-(\d{2})[T\s]+(\d{1,2}):(\d{2})/);
  if (iso) {
    const hh = +iso[4];
    const mm = +iso[5];
    if (hh > 23 || mm > 59) return null;
    return { y: +iso[1], m: +iso[2] - 1, d: +iso[3], hh, mm, hasDate: true };
  }

  const time = line.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)?/i);
  if (!time) return null;
  let hh = +time[1];
  const mm = +time[2];
  const ampm = time[3]?.toLowerCase();
  if (ampm === 'pm' && hh < 12) hh += 12;
  if (ampm === 'am' && hh === 12) hh = 0;
  if (hh > 23 || mm > 59) return null;

  let month = null;
  let day = null;
  let year = null;

  let m = line.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})\b(?:,?\s*(\d{4}))?/);
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)] !== undefined) {
    month = MONTHS[m[1].toLowerCase().slice(0, 3)];
    day = +m[2];
    year = m[3] ? +m[3] : null;
  }
  if (month === null) {
    m = line.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\b(?:,?\s*(\d{4}))?/);
    if (m && MONTHS[m[2].toLowerCase().slice(0, 3)] !== undefined) {
      month = MONTHS[m[2].toLowerCase().slice(0, 3)];
      day = +m[1];
      year = m[3] ? +m[3] : null;
    }
  }
  if (month === null) {
    m = line.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) {
      month = +m[1] - 1;
      day = +m[2];
      year = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : null;
    }
  }

  if (month === null || month > 11 || day < 1 || day > 31) {
    return { y: 0, m: 0, d: 0, hh, mm, hasDate: false };
  }

  if (year === null) {
    // No year printed: choose the next occurrence rather than one in the past.
    year = now.getFullYear();
    if (new Date(year, month, day).getTime() < now.getTime() - 60 * 86400000) year += 1;
  }

  return { y: year, m: month, d: day, hh, mm, hasDate: true };
}

/**
 * @param {string} text     pasted booking
 * @param {(token: string) => string|null} resolve  token to IATA code
 * @param {Date} [now]      reference for year inference
 */
export function parseFlightText(text, resolve, now = new Date()) {
  if (!text || !text.trim()) throw new Error('Nothing to parse yet.');
  const clean = text.replace(/→/g, '->').replace(/[–—]/g, '-');

  let dep = null;
  let arr = null;

  const pair = clean.match(/\b([A-Z]{3})\b\s*(?:->|to|-|\/)\s*\b([A-Z]{3})\b/i);
  if (pair) {
    const a = resolve(pair[1]);
    const b = resolve(pair[2]);
    if (a && b) { dep = a; arr = b; }
  }

  if (!dep) {
    const cities = clean.match(/([A-Za-z][A-Za-z .'-]{2,24}?)\s+(?:->|to)\s+([A-Za-z][A-Za-z .'-]{2,24})/);
    if (cities) {
      dep = resolve(cities[1].trim());
      arr = resolve(cities[2].trim());
    }
  }

  if (!dep || !arr) throw new Error('Could not find an airport pair. Try "BOS -> LHR".');
  if (dep === arr) throw new Error('Origin and destination are the same.');

  const times = [];
  for (const line of clean.split('\n')) {
    const parsed = parseDateTime(line, now);
    if (parsed) times.push({ line, ...parsed });
  }
  if (times.length < 2) throw new Error('Need both a departure and an arrival time.');

  const labelled = (re) => times.find((t) => re.test(t.line));
  let depTime = labelled(/depart|takeoff|leaves?\b|outbound/i) || times[0];
  let arrTime = labelled(/arriv|land|touchdown/i) || times.find((t) => t !== depTime);
  if (!arrTime || arrTime === depTime) throw new Error('Need both a departure and an arrival time.');

  if (!arrTime.hasDate && depTime.hasDate) {
    arrTime = { ...arrTime, y: depTime.y, m: depTime.m, d: depTime.d, hasDate: true };
  }
  if (!depTime.hasDate && arrTime.hasDate) {
    depTime = { ...depTime, y: arrTime.y, m: arrTime.m, d: arrTime.d, hasDate: true };
  }
  if (!depTime.hasDate || !arrTime.hasDate) throw new Error('Could not find a date for the flight.');

  const depDatetime = toIso(depTime);
  let arrDatetime = toIso(arrTime);

  // An overnight leg lands on the following calendar day.
  if (new Date(arrDatetime) <= new Date(depDatetime)) {
    const next = new Date(Date.UTC(arrTime.y, arrTime.m, arrTime.d) + 86400000);
    arrDatetime = toIso({
      ...arrTime,
      y: next.getUTCFullYear(),
      m: next.getUTCMonth(),
      d: next.getUTCDate(),
    });
  }

  return { dep, arr, depDatetime, arrDatetime };
}
