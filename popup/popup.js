import { generateSchedule, buildFlightEvent, resolveFlight } from '../lib/schedule.js';
import {
  requiredShift, buildShiftPlan, lightWindow, avoidWindow, sleepWindow,
  CBTMIN_BEFORE_WAKE,
} from '../lib/circadian.js';
import {
  getTimezoneOffsetHours, civilInZone, civilKey, localDecimalHour,
  parseClock, formatHour, formatDuration, wrap24,
} from '../lib/time.js';
import { activityMeta, ACTIVITY_ORDER, toCalendarEvent } from '../lib/color-map.js';
import { renderPRC } from '../lib/prc-chart.js';
import { parseFlightText, makeResolver } from '../lib/flight-parse.js';

// ── State ────────────────────────────────────────────────

let airports = {};
let resolveAirport = () => null;
let trips = [];
let tripIndex = -1;
let dayIndex = 0;
let dayTz = null;
let dayCache = null;
let goalWakeTouched = false;

const $ = (id) => document.getElementById(id);

/** Mirrors NON_BLOCKING in schedule.js — these never claim a full track row. */
const PASSIVE_TYPES = new Set(['melatonin', 'caffeine_cutoff', 'eating']);

// ── Init ─────────────────────────────────────────────────

async function init() {
  airports = await (await fetch(chrome.runtime.getURL('data/airports.json'))).json();

  const datalist = $('airport-list');
  for (const [code, info] of Object.entries(airports)) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = `${code} — ${info.city}`;
    datalist.appendChild(opt);
  }
  resolveAirport = makeResolver(airports);

  trips = (await chrome.storage.local.get('trips')).trips || [];
  renderTrips();
  buildLegend();
  showView('trips-view');
}

// ── Views ────────────────────────────────────────────────

function showView(id) {
  for (const section of document.querySelectorAll('.view')) {
    section.classList.toggle('view-active', section.id === id);
  }
}

// ── Trip list ────────────────────────────────────────────

function renderTrips() {
  const list = $('trips-list');
  list.textContent = '';

  if (trips.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No trips yet. Add a flight and Clairo will work out when to chase light and when to hide from it.';
    list.appendChild(empty);
    return;
  }

  trips.forEach((trip, i) => {
    const dir = trip.model?.direction ?? 'none';
    const mag = trip.model?.shiftMagnitude ?? 0;
    const tagClass = mag < 0.01 ? 'none' : dir;
    const tagText = mag < 0.01 ? 'no shift' : `${dir === 'advance' ? '←' : '→'} ${formatDuration(mag)}`;

    const card = document.createElement('div');
    card.className = 'trip-card';
    card.style.animationDelay = `${i * 50}ms`;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.innerHTML = `
      <div class="trip-route">
        <div class="trip-codes">${trip.departureAirport}<span class="sep">→</span>${trip.arrivalAirport}</div>
        <div class="trip-when">${dateShort(trip.departureDatetime)} · ${dateShort(trip.arrivalDatetime)}</div>
      </div>
      <span class="trip-tag ${tagClass}">${tagText}</span>
    `;
    card.addEventListener('click', () => openTrip(i));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openTrip(i); }
    });
    list.appendChild(card);
  });
}

function dateShort(dt) {
  return new Date(dt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function buildLegend() {
  const legend = $('legend');
  legend.textContent = '';
  for (const type of ACTIVITY_ORDER) {
    const meta = activityMeta(type);
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<span class="legend-dot" style="background:var(${meta.css})"></span>${meta.short}`;
    legend.appendChild(item);
  }
}

// ── Form ─────────────────────────────────────────────────

$('add-trip-btn').addEventListener('click', () => {
  goalWakeTouched = false;
  showView('form-view');
});
$('form-back').addEventListener('click', () => showView('trips-view'));

$('goal-wake-input').addEventListener('change', () => { goalWakeTouched = true; });
$('current-wake-input').addEventListener('change', () => {
  if (!goalWakeTouched) $('goal-wake-input').value = $('current-wake-input').value;
  updateBlink();
});

for (const id of ['dep-airport', 'arr-airport', 'dep-datetime', 'arr-datetime', 'current-wake-input', 'goal-wake-input']) {
  $(id).addEventListener('input', updateBlink);
}

$('days-prep-input').addEventListener('input', (e) => {
  $('days-prep-display').textContent = e.target.value;
  updateBlink();
});

for (const radio of document.querySelectorAll('input[name="schedule-mode"]')) {
  radio.addEventListener('change', () => {
    $('days-prep-group').hidden = radio.value === 'respond' && radio.checked;
    updateBlink();
  });
}

/** Live preview of the phase problem, before any schedule exists. */
function updateBlink() {
  const panel = $('phase-blink');
  const note = $('route-note');
  const depCode = $('dep-airport').value.trim().toUpperCase();
  const arrCode = $('arr-airport').value.trim().toUpperCase();
  const dep = airports[depCode];
  const arr = airports[arrCode];

  note.hidden = true;
  if (!dep || !arr || depCode === arrCode) { panel.hidden = true; return; }

  const ref = $('dep-datetime').value ? new Date($('dep-datetime').value) : new Date();
  const when = Number.isNaN(ref.getTime()) ? new Date() : ref;
  const tzDiff = getTimezoneOffsetHours(arr.timezone, when) - getTimezoneOffsetHours(dep.timezone, when);

  note.textContent = `${dep.city} → ${arr.city} · ${tzDiff === 0 ? 'same clock' : `${tzDiff > 0 ? '+' : ''}${formatDuration(Math.abs(tzDiff))} ${tzDiff > 0 ? 'ahead' : 'behind'}`}`;
  note.hidden = false;

  const currentWakeH = parseClock($('current-wake-input').value, 7);
  const goalWakeH = parseClock($('goal-wake-input').value, currentWakeH);
  const shift = requiredShift({ tzDiff, currentWakeH, goalWakeH });

  const mode = document.querySelector('input[name="schedule-mode"]:checked').value;
  const prepDays = mode === 'respond' ? 0 : Number($('days-prep-input').value);
  const plan = buildShiftPlan({ shift, prepDays, currentWakeH, tzDiff, goalWakeH });
  const working = plan.days.filter((d) => d.shiftedToday > 0.01).length;

  const cbtHome = currentWakeH - CBTMIN_BEFORE_WAKE;
  const dirPill = $('pb-direction');

  if (shift.magnitude < 0.01) {
    dirPill.textContent = 'aligned';
    dirPill.className = 'pill none';
    $('pb-note').innerHTML = 'Your clock already matches the destination. The plan just protects the rhythm you have.';
  } else {
    dirPill.textContent = shift.direction === 'advance' ? 'advance · earlify' : 'delay · lateify';
    dirPill.className = `pill ${shift.direction}`;
    $('pb-note').innerHTML = shift.direction === 'advance'
      ? `Advancing means everything moves <b>earlier</b>. Light after CBTmin pulls the clock back; light before it pushes forward, so the evening is what you protect.`
      : `Delaying means everything moves <b>later</b>. Light before CBTmin pushes the clock forward; light after it pulls back, so the morning is what you protect.`;
  }

  if (shift.wrapped) {
    $('pb-note').innerHTML += ` The raw gap is ${formatDuration(Math.abs(shift.raw))}, but going the other way round the clock is shorter, so the plan ${shift.direction}s ${formatDuration(shift.magnitude)} instead.`;
  }

  const seek = lightWindow(cbtHome, shift.direction);
  const avoid = avoidWindow(cbtHome, shift.direction);
  const sleep = sleepWindow(cbtHome);

  $('pb-cbtmin').textContent = formatHour(cbtHome);
  $('pb-shift').textContent = shift.magnitude < 0.01 ? 'none' : formatDuration(shift.magnitude);
  $('pb-days').textContent = working === 0 ? '—' : `${working}d`;
  $('pb-seek').textContent = `${formatHour(seek.start)} – ${formatHour(seek.end)}`;
  $('pb-avoid').textContent = `${formatHour(avoid.start)} – ${formatHour(avoid.end)}`;

  renderPRC($('pb-chart'), {
    cbtMinH: cbtHome,
    direction: shift.direction,
    seek: [seek.start, seek.end],
    avoid: [avoid.start, avoid.end],
    sleep,
  });

  panel.hidden = false;
}

// ── Flight text import ───────────────────────────────────

$('import-parse-btn').addEventListener('click', () => {
  const err = $('import-error');
  const ok = $('import-ok');
  err.hidden = true;
  ok.hidden = true;
  try {
    const parsed = parseFlightText($('import-text').value, resolveAirport);
    $('dep-airport').value = parsed.dep;
    $('arr-airport').value = parsed.arr;
    $('dep-datetime').value = parsed.depDatetime;
    $('arr-datetime').value = parsed.arrDatetime;
    ok.textContent = `Filled ${parsed.dep} → ${parsed.arr}. Check the dates before building.`;
    ok.hidden = false;
    updateBlink();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
});

// ── Submit ───────────────────────────────────────────────

function readForm(prefix = '') {
  const id = (base) => (prefix ? `${prefix}-${base}` : base);
  return {
    depAirport: $(id('dep-airport')).value.trim().toUpperCase(),
    arrAirport: $(id('arr-airport')).value.trim().toUpperCase(),
    depDatetime: $(id('dep-datetime')).value,
    arrDatetime: $(id('arr-datetime')).value,
    currentWakeTime: $(prefix ? 'edit-current-wake' : 'current-wake-input').value || '07:00',
    goalWakeTime: $(prefix ? 'edit-goal-wake' : 'goal-wake-input').value || '07:00',
    daysPrep: Number($(prefix ? 'edit-days-prep' : 'days-prep-input').value),
    mode: document.querySelector(`input[name="${prefix ? 'edit-schedule-mode' : 'schedule-mode'}"]:checked`).value,
  };
}

function validate(f) {
  if (!airports[f.depAirport]) return `Unknown airport: ${f.depAirport || '—'}`;
  if (!airports[f.arrAirport]) return `Unknown airport: ${f.arrAirport || '—'}`;
  if (f.depAirport === f.arrAirport) return 'Origin and destination must differ.';
  if (!f.depDatetime || !f.arrDatetime) return 'Both flight times are required.';

  // Compare real instants, not the clock strings. Tokyo to Los Angeles lands at
  // an earlier local time than it departs and is perfectly valid.
  let flight;
  try {
    flight = resolveFlight(
      {
        departureAirport: f.depAirport,
        arrivalAirport: f.arrAirport,
        departureDatetime: f.depDatetime,
        arrivalDatetime: f.arrDatetime,
      },
      airports
    );
  } catch (ex) {
    return ex.message;
  }

  const hours = (flight.arrInstant - flight.depInstant) / 3600000;
  if (hours <= 0) return 'Landing must be after takeoff.';
  if (hours > 26) return 'That is over 26 hours in the air — check the dates.';
  return null;
}

function buildTrip(f) {
  const result = generateSchedule(
    {
      departureAirport: f.depAirport,
      arrivalAirport: f.arrAirport,
      departureDatetime: f.depDatetime,
      arrivalDatetime: f.arrDatetime,
    },
    {
      currentWakeTime: f.currentWakeTime,
      goalWakeTime: f.goalWakeTime,
      daysPrep: f.daysPrep,
      mode: f.mode,
    },
    airports
  );

  return {
    departureAirport: f.depAirport,
    arrivalAirport: f.arrAirport,
    departureDatetime: f.depDatetime,
    arrivalDatetime: f.arrDatetime,
    currentWakeTime: f.currentWakeTime,
    goalWakeTime: f.goalWakeTime,
    daysPrep: f.daysPrep,
    mode: f.mode,
    entries: result.entries.map(serialize),
    summary: result.summary,
    model: result.model,
    flight: result.flight,
    syncedEventIds: [],
    flightEventId: null,
  };
}

const serialize = (e) => ({ ...e, start: e.start.toISOString(), end: e.end.toISOString() });
const deserialize = (e) => ({ ...e, start: new Date(e.start), end: new Date(e.end) });

$('flight-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('form-error');
  err.hidden = true;

  const f = readForm();
  const problem = validate(f);
  if (problem) { err.textContent = problem; err.hidden = false; return; }

  try {
    trips.push(buildTrip(f));
    await chrome.storage.local.set({ trips });
    renderTrips();
    openTrip(trips.length - 1);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ── Trip detail ──────────────────────────────────────────

function openTrip(index) {
  tripIndex = index;
  dayIndex = 0;
  dayTz = null;
  const trip = trips[index];
  const entries = trip.entries.map(deserialize);

  $('detail-title').textContent = `${trip.departureAirport} → ${trip.arrivalAirport}`;
  const mag = trip.model?.shiftMagnitude ?? 0;
  $('detail-meta').textContent = mag < 0.01
    ? `${dateShort(trip.departureDatetime)} · no shift needed`
    : `${dateShort(trip.departureDatetime)} · ${formatDuration(mag)} ${trip.model.direction}`;

  activateTab('timeline');
  renderTimeline(entries, trip);
  renderDayPlan(entries, trip);
  renderClock(entries, trip);
  showView('detail-view');
}

for (const btn of document.querySelectorAll('.tab')) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
}

function activateTab(tab) {
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll('.panel')) p.classList.toggle('active', p.id === `panel-${tab}`);
}

/** Group entries into per-local-date bands, splitting anything that crosses midnight. */
function bandsByDate(entries) {
  const map = new Map();
  const push = (key, band) => {
    if (!map.has(key)) map.set(key, { bands: [], dayOffset: band.dayOffset });
    map.get(key).bands.push(band);
  };

  for (const e of entries) {
    const tz = e.timezone;
    const startKey = civilKey(civilInZone(e.start, tz));
    const endKey = civilKey(civilInZone(e.end, tz));
    const startH = localDecimalHour(e.start, tz);
    const endH = localDecimalHour(e.end, tz);
    const base = { type: e.activity_type, inFlight: e.inFlight, dayOffset: e.dayOffset };

    if (startKey === endKey) {
      push(startKey, { ...base, from: startH, to: Math.max(endH, startH + 0.15) });
    } else {
      push(startKey, { ...base, from: startH, to: 24 });
      if (endH > 0.01) push(endKey, { ...base, from: 0, to: endH });
    }
  }

  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

function renderTimeline(entries, trip) {
  const rows = $('timeline-rows');
  rows.textContent = '';

  const byDate = bandsByDate(entries);
  const cbtByOffset = new Map((trip.model?.days || []).map((d) => [d.dayOffset, d.cbtMinH]));
  // Instants resolved in the airports' own zones, not the viewer's machine.
  const depTz = trip.flight?.departureTimezone || airports[trip.departureAirport]?.timezone;
  const arrTz = trip.flight?.arrivalTimezone || airports[trip.arrivalAirport]?.timezone;
  const depAt = trip.flight ? new Date(trip.flight.departureInstant) : null;
  const arrAt = trip.flight ? new Date(trip.flight.arrivalInstant) : null;
  const depKey = depAt && depTz ? civilKey(civilInZone(depAt, depTz)) : null;
  const arrKey = arrAt && arrTz ? civilKey(civilInZone(arrAt, arrTz)) : null;

  let i = 0;
  for (const [key, { bands, dayOffset }] of byDate) {
    const row = document.createElement('div');
    row.className = 'tl-row';
    row.style.animationDelay = `${i * 30}ms`;

    const isFlightDay = key === depKey || key === arrKey;
    const phase = dayOffset < 0 ? `T${dayOffset}` : dayOffset === 0 ? 'landing' : `+${dayOffset}`;

    const label = document.createElement('div');
    label.className = 'tl-label';
    label.innerHTML = `
      <span class="tl-date">${labelDate(key)}</span>
      <span class="tl-phase ${isFlightDay ? 'flight' : ''}">${isFlightDay ? '✈ ' : ''}${phase}</span>
    `;

    const track = document.createElement('div');
    track.className = 'tl-track';

    for (const band of bands) {
      const meta = activityMeta(band.type);
      const block = document.createElement('div');
      // Background and point-in-time activities ride a strip along the bottom
      // so an 11-hour eating window cannot swamp the blocks that matter.
      const passive = PASSIVE_TYPES.has(band.type);
      block.className = `tl-block${passive ? ' passive' : ''}${band.inFlight ? ' in-flight' : ''}`;
      block.style.left = `${(band.from / 24) * 100}%`;
      block.style.width = `${Math.max(((band.to - band.from) / 24) * 100, 0.8)}%`;
      block.style.background = `var(${meta.css})`;
      block.title = `${meta.label} · ${formatHour(band.from)}–${formatHour(band.to)}`;
      track.appendChild(block);
    }

    if (cbtByOffset.has(dayOffset)) {
      const mark = document.createElement('div');
      mark.className = 'tl-cbt';
      mark.style.left = `${(wrap24(cbtByOffset.get(dayOffset)) / 24) * 100}%`;
      mark.title = `CBTmin ${formatHour(cbtByOffset.get(dayOffset))}`;
      track.appendChild(mark);
    }

    for (const [k, tz, at, name] of [
      [depKey, depTz, depAt, 'Takeoff'],
      [arrKey, arrTz, arrAt, 'Landing'],
    ]) {
      if (k !== key || !tz || !at) continue;
      const hour = localDecimalHour(at, tz);
      const mark = document.createElement('div');
      mark.className = 'tl-mark';
      mark.style.left = `${(hour / 24) * 100}%`;
      mark.title = `${name} ${formatHour(hour)}`;
      track.appendChild(mark);
    }

    row.append(label, track);
    rows.appendChild(row);
    i++;
  }
}

function labelDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric',
  });
}

// ── Day plan ─────────────────────────────────────────────

function renderDayPlan(entries, trip) {
  const groups = new Map();
  for (const e of entries) {
    const key = civilKey(civilInZone(e.start, e.timezone));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  const days = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, items] of days) items.sort((a, b) => a.start - b.start);

  dayCache = { days, trip };
  dayIndex = Math.min(dayIndex, Math.max(days.length - 1, 0));

  const depCode = trip.departureAirport;
  const arrCode = trip.arrivalAirport;
  const depZone = airports[depCode]?.timezone || 'UTC';
  const arrZone = airports[arrCode]?.timezone || 'UTC';
  const [a, b] = document.querySelectorAll('#tz-toggle button');
  a.textContent = depCode;
  b.textContent = arrCode;
  a.dataset.zone = depZone;
  b.dataset.zone = arrZone;

  // Nothing to switch between on a same-timezone route, and leaving it visible
  // would light up both buttons at once.
  $('tz-toggle').hidden = depZone === arrZone;

  renderDayPage();
}

function renderDayPage() {
  if (!dayCache || dayCache.days.length === 0) return;
  const { days, trip } = dayCache;
  const [key, items] = days[dayIndex];
  const offset = items[0]?.dayOffset ?? 0;
  const ownTz = items[0]?.timezone;
  const tz = dayTz || ownTz;

  $('day-title').textContent = labelDate(key);
  $('day-sub').textContent = offset < 0
    ? `${-offset} day${offset === -1 ? '' : 's'} before landing`
    : offset === 0 ? 'Landing day' : `${offset} day${offset === 1 ? '' : 's'} after landing`;
  $('day-prev').disabled = dayIndex === 0;
  $('day-next').disabled = dayIndex === days.length - 1;

  for (const btn of document.querySelectorAll('#tz-toggle button')) {
    btn.classList.toggle('active', btn.dataset.zone === tz);
  }

  const container = $('day-activities');
  container.textContent = '';

  items.forEach((item, idx) => {
    const meta = activityMeta(item.activity_type);
    const card = document.createElement('div');
    card.className = 'act';
    card.style.setProperty('--accent', `var(${meta.css})`);
    card.style.animationDelay = `${idx * 30}ms`;
    card.innerHTML = `
      <span class="act-glyph">${meta.icon}</span>
      <div class="act-body">
        <div class="act-time">${clock(item.start, tz)} – ${clock(item.end, tz)}</div>
        <div class="act-name-row">
          <span class="act-name">${meta.label}</span>
          ${item.inFlight ? '<span class="act-flag">in flight</span>' : ''}
          <button class="act-why" aria-label="Why this?" aria-expanded="false">?</button>
        </div>
        <div class="act-desc" hidden></div>
      </div>
    `;
    const desc = card.querySelector('.act-desc');
    desc.textContent = item.description;
    const why = card.querySelector('.act-why');
    why.addEventListener('click', () => {
      const open = desc.hidden;
      desc.hidden = !open;
      why.setAttribute('aria-expanded', String(open));
      why.classList.toggle('open', open);
    });
    container.appendChild(card);
  });
}

function clock(date, tz) {
  return date.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
}

$('day-prev').addEventListener('click', () => { if (dayIndex > 0) { dayIndex--; dayTz = null; renderDayPage(); } });
$('day-next').addEventListener('click', () => {
  if (dayCache && dayIndex < dayCache.days.length - 1) { dayIndex++; dayTz = null; renderDayPage(); }
});

for (const btn of document.querySelectorAll('#tz-toggle button')) {
  btn.addEventListener('click', () => { dayTz = btn.dataset.zone; renderDayPage(); });
}

// ── Clock tab ────────────────────────────────────────────

function renderClock(entries, trip) {
  const model = trip.model;
  if (!model) return;

  const dir = model.direction;
  const pill = $('ck-direction');
  const aligned = model.shiftMagnitude < 0.01;
  pill.textContent = aligned ? 'aligned' : dir === 'advance' ? 'advance · earlify' : 'delay · lateify';
  pill.className = `pill ${aligned ? 'none' : dir}`;

  const goalCbt = model.cbtMinGoalH;
  const seek = lightWindow(goalCbt, dir);
  const avoid = avoidWindow(goalCbt, dir);

  renderPRC($('ck-chart'), {
    cbtMinH: goalCbt,
    direction: dir,
    seek: [seek.start, seek.end],
    avoid: [avoid.start, avoid.end],
    sleep: sleepWindow(goalCbt),
  });

  $('ck-cbt-home').textContent = formatHour(model.cbtMinHomeH);
  $('ck-cbt-goal').textContent = formatHour(goalCbt);
  $('ck-shift').textContent = aligned ? 'none' : formatDuration(model.shiftMagnitude);

  const working = (model.days || []).filter((d) => d.shiftedToday > 0.01).length;
  const arrivalWork = (model.days || []).filter((d) => d.shiftedToday > 0.01 && d.dayOffset >= 0).length;
  $('ck-note').innerHTML = aligned
    ? 'Nothing to move. The schedule keeps your existing rhythm intact across the trip.'
    : `The curve is drawn on <b>${trip.arrivalAirport}</b> time, where CBTmin needs to end up at <b>${formatHour(goalCbt)}</b>. ` +
      `Shifting takes <b>${working} day${working === 1 ? '' : 's'}</b>, ${arrivalWork} of them after you land.` +
      (model.leftover > 0.01 ? ` ${formatDuration(model.leftover)} is left unfinished at the end of the plan — start earlier to close it.` : '');

  // Amplitude strip
  const strip = $('amp-strip');
  strip.textContent = '';
  for (const day of model.days || []) {
    const col = document.createElement('div');
    col.className = 'amp-col';
    const bar = document.createElement('div');
    bar.className = `amp-bar${day.amplitude < 0.7 ? ' low' : ''}`;
    bar.style.height = `${Math.round(day.amplitude * 100)}%`;
    bar.title = `${Math.round(day.amplitude * 100)}% on day ${day.dayOffset >= 0 ? `+${day.dayOffset}` : day.dayOffset}`;
    const tick = document.createElement('span');
    tick.className = 'amp-tick';
    tick.textContent = day.dayOffset === 0 ? '✈' : day.dayOffset;
    col.append(bar, tick);
    strip.appendChild(col);
  }

  $('display-current-wake').textContent = formatHour(model.currentWakeH);
  $('display-goal-wake').textContent = formatHour(model.goalWakeH);

  // Sleep bars
  const bars = $('sleep-bars');
  bars.textContent = '';
  const sleepBands = new Map();
  for (const e of entries.filter((x) => x.activity_type === 'sleep')) {
    const key = civilKey(civilInZone(e.start, e.timezone));
    const from = localDecimalHour(e.start, e.timezone);
    const endKey = civilKey(civilInZone(e.end, e.timezone));
    const to = endKey === key ? localDecimalHour(e.end, e.timezone) : 24;
    if (!sleepBands.has(key)) sleepBands.set(key, { spans: [], ms: 0 });
    sleepBands.get(key).spans.push([from, to]);
    sleepBands.get(key).ms += e.end - e.start;
    if (endKey !== key) {
      const tail = localDecimalHour(e.end, e.timezone);
      if (tail > 0.01) {
        if (!sleepBands.has(endKey)) sleepBands.set(endKey, { spans: [], ms: 0 });
        sleepBands.get(endKey).spans.push([0, tail]);
      }
    }
  }

  let i = 0;
  for (const [key, { spans, ms }] of [...sleepBands.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const row = document.createElement('div');
    row.className = 'sleep-row';
    row.style.animationDelay = `${i * 30}ms`;

    const label = document.createElement('span');
    label.className = 'sleep-label';
    label.textContent = labelDate(key);

    const track = document.createElement('div');
    track.className = 'sleep-track';
    for (const [from, to] of spans) {
      const fill = document.createElement('div');
      fill.className = 'sleep-fill';
      fill.style.left = `${(from / 24) * 100}%`;
      fill.style.width = `${Math.max(((to - from) / 24) * 100, 1)}%`;
      track.appendChild(fill);
    }

    const dur = document.createElement('span');
    dur.className = 'sleep-dur';
    dur.textContent = ms > 0 ? formatDuration(ms / 3600000) : '';

    row.append(label, track, dur);
    bars.appendChild(row);
    i++;
  }
}

// ── Settings ─────────────────────────────────────────────

$('detail-back').addEventListener('click', () => { renderTrips(); showView('trips-view'); });
$('settings-back').addEventListener('click', () => openTrip(tripIndex));

$('trip-settings-btn').addEventListener('click', () => {
  const trip = trips[tripIndex];
  $('edit-dep-airport').value = trip.departureAirport;
  $('edit-arr-airport').value = trip.arrivalAirport;
  $('edit-dep-datetime').value = trip.departureDatetime;
  $('edit-arr-datetime').value = trip.arrivalDatetime;
  $('edit-current-wake').value = trip.currentWakeTime || '07:00';
  $('edit-goal-wake').value = trip.goalWakeTime || '07:00';
  const daysPrep = trip.daysPrep ?? 3;
  $('edit-days-prep').value = daysPrep;
  $('edit-days-prep-display').textContent = daysPrep;
  const mode = trip.mode || 'prepare';
  document.querySelector(`input[name="edit-schedule-mode"][value="${mode}"]`).checked = true;
  $('edit-days-prep-group').hidden = mode === 'respond';
  $('settings-error').hidden = true;
  $('settings-note').hidden = true;
  showView('settings-view');
});

$('edit-days-prep').addEventListener('input', (e) => {
  $('edit-days-prep-display').textContent = e.target.value;
});

for (const radio of document.querySelectorAll('input[name="edit-schedule-mode"]')) {
  radio.addEventListener('change', () => {
    $('edit-days-prep-group').hidden = radio.value === 'respond' && radio.checked;
  });
}

$('update-trip-btn').addEventListener('click', async () => {
  const err = $('settings-error');
  err.hidden = true;

  const f = readForm('edit');
  const problem = validate(f);
  if (problem) { err.textContent = problem; err.hidden = false; return; }

  try {
    const rebuilt = buildTrip(f);
    trips[tripIndex] = {
      ...rebuilt,
      syncedEventIds: trips[tripIndex].syncedEventIds || [],
      flightEventId: trips[tripIndex].flightEventId || null,
    };
    await chrome.storage.local.set({ trips });
    renderTrips();
    openTrip(tripIndex);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

$('delete-trip-btn').addEventListener('click', async () => {
  trips.splice(tripIndex, 1);
  tripIndex = -1;
  await chrome.storage.local.set({ trips });
  renderTrips();
  showView('trips-view');
});

$('delete-calendar-btn').addEventListener('click', async () => {
  const note = $('settings-note');
  const err = $('settings-error');
  note.hidden = true;
  err.hidden = true;

  const trip = trips[tripIndex];
  const ids = [...(trip.syncedEventIds || []), ...(trip.flightEventId ? [trip.flightEventId] : [])];
  if (ids.length === 0) {
    note.textContent = 'Nothing synced for this trip yet.';
    note.hidden = false;
    return;
  }

  try {
    const res = await chrome.runtime.sendMessage({ action: 'deleteEvents', eventIds: ids });
    if (res?.success) {
      trips[tripIndex].syncedEventIds = [];
      trips[tripIndex].flightEventId = null;
      await chrome.storage.local.set({ trips });
      note.textContent = `Removed ${res.deleted} event${res.deleted === 1 ? '' : 's'}.`;
      note.hidden = false;
    } else {
      err.textContent = res?.error || 'Could not reach Google Calendar.';
      err.hidden = false;
    }
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
});

// ── Sync ─────────────────────────────────────────────────

$('sync-btn').addEventListener('click', runSync);
$('retry-btn').addEventListener('click', runSync);

async function runSync() {
  showView('sync-view');
  $('sync-progress').hidden = false;
  $('sync-done').hidden = true;
  $('sync-error-view').hidden = true;
  $('progress-fill').style.width = '0%';
  $('sync-count').textContent = '';

  const trip = trips[tripIndex];
  const entries = trip.entries.map(deserialize);
  const events = [buildFlightEvent(trip, airports), ...entries.map(toCalendarEvent)];

  try {
    const res = await chrome.runtime.sendMessage({ action: 'syncToCalendar', events });
    if (res?.success) {
      if (res.eventIds?.length) {
        trips[tripIndex].flightEventId = res.eventIds[0];
        trips[tripIndex].syncedEventIds = res.eventIds.slice(1);
        await chrome.storage.local.set({ trips });
      }
      $('sync-progress').hidden = true;
      $('sync-done').hidden = false;
      $('sync-result').textContent = res.warning
        ? `${res.created} events synced. ${res.warning}.`
        : `${res.created} events are on your calendar.`;
    } else {
      syncError(res?.error || 'Unknown error.');
    }
  } catch (ex) {
    syncError(ex.message);
  }
}

function syncError(msg) {
  $('sync-progress').hidden = true;
  $('sync-done').hidden = true;
  $('sync-error-view').hidden = false;
  $('sync-error-msg').textContent = msg;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action !== 'syncProgress') return;
  const pct = Math.round((message.current / message.total) * 100);
  $('progress-fill').style.width = `${pct}%`;
  $('sync-count').textContent = `${message.current} of ${message.total}`;
});

$('open-calendar-btn').addEventListener('click', () => chrome.tabs.create({ url: 'https://calendar.google.com' }));
$('done-btn').addEventListener('click', () => openTrip(tripIndex));
$('back-to-trip-btn').addEventListener('click', () => openTrip(tripIndex));

init();
