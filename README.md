# JetShift

A Chrome extension that plans a circadian phase shift around your flight and
writes it to Google Calendar as timed light, sleep, melatonin and meal blocks.

Not a jet lag checklist. It works out which direction your clock has to move,
how far, how fast that is actually possible, and which hours of daylight will
help you versus quietly undo the work.

---

## What it does

Give it two airports, two times, and when you normally wake up. It returns a
day-by-day schedule anchored to **CBTmin** — the core body temperature minimum,
which is the point the human light phase response curve is defined against.

- **Phase Blink** — live readout of the problem as you type: which direction,
  how many hours, how many days it will take, and the two windows that matter.
- **Phase response curve** — the advance and delay arms drawn against your own
  clock, with your prescribed light and dark windows marked on it.
- **Rhythm strength** — a running index of circadian amplitude across the trip,
  because shifting fast and shifting well are different things.
- **Prepare or respond** — start easing your clock over before you fly, or
  leave it all until you land.
- **Paste a booking** — pulls route and times out of most confirmation emails.

---

## The short version of the science

Light shifts your clock in a direction that depends on when it lands relative
to CBTmin. After CBTmin it pulls everything **earlier**; before CBTmin it
pushes everything **later**; across the middle of your day it does almost
nothing to phase.

```
                        CBTmin
   ── delay ──────────────┼────────────── advance ──
  -6h      -3h            0            +3h      +6h
   ░░░░░░░░░████████████  │  ████████████░░░░░░░░
```

Two consequences the app is built around:

**Advancing is harder than delaying.** CBTmin sits four hours before you wake,
so the strong core of the advance zone happens while you are asleep. All you
can reach is two hours of the weaker tail, starting the moment you get up.
Delays get the better end of the same geometry, in the evening before bed.

**Going east, the sun is in the wrong place.** Flying Boston to London you need
to advance, but London's early morning daylight lands in your delay zone and
pushes the wrong way. The rule that falls out is the opposite of the folk
advice: *stay dark until 9am London time, then get as much light as you can
until 3pm.* Going west, the sun cooperates — evening light is what you want and
what you have.

Full derivations, constants, the worst-case route analysis, and the model's
limits: **[docs/circadian-model.md](docs/circadian-model.md)**.

---

## Install

Needs a Google Cloud OAuth client before it can write to your calendar.

**1. Google Cloud Console**

1. Create or pick a project at [console.cloud.google.com](https://console.cloud.google.com/)
2. Enable the **Google Calendar API** under APIs & Services → Library
3. Configure the **OAuth consent screen**: External, add scope
   `https://www.googleapis.com/auth/calendar.events`, add your own account as a
   test user
4. Credentials → Create Credentials → OAuth client ID → **Chrome Extension**

**2. Load it**

1. `chrome://extensions/`, enable Developer mode
2. Load unpacked → select this folder
3. Copy the extension ID from the card, paste it into the Cloud Console client
4. Copy the client ID back into `oauth2.client_id` in `manifest.json`
5. Reload the extension

---

## Layout

```
manifest.json              MV3 config, OAuth scopes
popup/
  popup.html  .css  .js    UI — views, charts, wiring
lib/
  time.js                  timezone + civil-date arithmetic, DST-safe
  circadian.js             the model: PRC, amplitude, rates. Pure math.
  schedule.js              model + flight → dated calendar entries
  flight-parse.js          booking confirmation parser
  prc-chart.js             SVG phase response curve
  color-map.js             activity types → colours → Calendar events
  calendar-api.js          Google Calendar REST wrapper
background/
  service-worker.js        auth and batched event writes
data/
  airports.json            IATA → timezone, city
test/
  model.test.mjs           circadian + time correctness
  flight-parse.test.mjs    booking parser
docs/
  circadian-model.md       the science, the constants, the caveats
```

`circadian.js` holds no dates and `time.js` holds no biology, which is what
makes both testable without a browser.

---

## Tests

```sh
node --test 'test/*.test.mjs'
```

No dependencies, no build step. Covers the phase-shift arithmetic including
sign and wraparound, PRC window placement, DST transitions in both directions,
the spring-forward gap, timezone-correct day anchoring for eastward departures,
and the booking parser.

---

## Tuning

Every constant worth arguing about is at the top of `lib/circadian.js` with a
comment explaining the choice. `CBTMIN_BEFORE_WAKE` is the one to reach for
first — it anchors every window in the app, and moving it moves everything.

---

## Not medical advice

A student project, not a clinical device. Melatonin in particular interacts
with medication and with several conditions. Ask someone qualified.
