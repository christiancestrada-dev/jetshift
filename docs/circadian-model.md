# The JetShift circadian model

What the extension actually computes, why each constant is what it is, and
where the model stops being trustworthy.

All times are decimal hours on a local 24-hour clock. Everything is anchored to
**CBTmin**, the core body temperature minimum, because that is the reference
point the human light phase response curve is defined against.

---

## 1. Anchors

| Quantity | Value | Where |
|---|---|---|
| CBTmin | wake − 4h | `CBTMIN_BEFORE_WAKE` |
| Sleep opportunity | 8h, ending at wake | `SLEEP_HOURS` |
| Advance rate | 1.0 h/day | `BASE_RATE.advance` |
| Delay rate | 1.5 h/day | `BASE_RATE.delay` |
| Intensity multipliers | 0.6 / 1.0 / 1.4 | `INTENSITY` |

**On CBTmin = wake − 4.** The usual clinical figure is 2–3 hours before
habitual wake; wake − 4 is closer to mid-sleep than to the temperature minimum
proper. This is a deliberate choice, not an accident — it makes every window in
the app sit earlier than a textbook protocol would put it. If a schedule ever
feels like it is asking for light too early, this constant is the first thing to
change. One line, `CBTMIN_BEFORE_WAKE`, and the whole model moves with it.

---

## 2. The phase response curve

Light shifts the clock in a direction that depends entirely on *when* it
arrives relative to CBTmin.

```
                        CBTmin
                          │
   ── delay ──────────────┼────────────── advance ──
                          │
  -6h      -3h            0            +3h      +6h
   ░░░░░░░░░████████████  │  ████████████░░░░░░░░
   moderate   strong      │     strong    moderate

           ← everything later    everything earlier →
```

- **Strong**, within 3h of CBTmin: full effect.
- **Moderate**, 3–6h out: roughly half.
- **Dead zone**, beyond 6h: essentially nothing. This is most of your waking
  day, and it is what makes the amplitude trick in §5 possible.

The crossover sits *at* CBTmin. An hour either side of it is the difference
between pulling your clock earlier and shoving it later.

### Why advancing is slower than delaying

Two reasons compound.

The intrinsic human period runs slightly longer than 24 hours, so delaying goes
with the free-run and advancing fights it. That is the familiar half of the
answer.

The other half falls out of the geometry above. To advance you need light
**after** CBTmin — but CBTmin sits 4h before you wake, so the entire strong
core of the advance zone happens while you are asleep. What is actually
reachable is the moderate tail:

```
  CBTmin ──── 3h ──── 6h
    │  strong  │ moderate │
    │◄ asleep ►│◄ awake ►│
    04:00    07:00    10:00
              wake 08:00
```

Two hours of half-strength light, starting the moment you get up. That is the
whole budget, and it is why `BASE_RATE.advance` is 1.0 rather than 1.5.

Delaying has the mirror problem and gets a better deal: the delay zone runs
backwards from CBTmin into the evening, and you are awake for the last two
hours of it, right before bed.

`lightWindow()` computes this intersection. It never schedules light during
sleep, which the previous version of the engine did.

---

## 3. How much to shift

Left alone, your body wants to wake at `currentWake` home time, which reads as
`currentWake + tzDiff` on the destination clock. The gap between that and where
you want to wake is the work:

```
advance = tzDiff + currentWake − goalWake        (positive = earlify)
```

Then wrapped into (−12, +12] so the plan always takes the short way round. A
14h eastward trip is planned as a **10h delay**, not a 14h advance — fewer
hours, and in the cheaper direction. At exactly 12h the wrap resolves to a
delay, which is the right tiebreak.

**Worked case — Boston to London, 8am wake, 8am goal:**

```
tzDiff        = +5
advance       = 5 + 8 − 8       = 5h  (advance)
CBTmin home   = 8 − 4           = 4:00am Boston
CBTmin dest   = 4 + 5           = 9:00am London   ← where your body puts it
CBTmin goal   = 8 − 4           = 4:00am London   ← where it needs to go
```

Five hours of advance, confirmed two ways. Note that the goal-wake term is
*subtracted*: wanting to wake at 6am in London instead of 8am makes the job
harder (7h, not 3h). Getting that sign backwards was a real bug in the previous
engine, and it only showed up when goal wake differed from home wake.

---

## 4. Intensity ramp

Gentle before the flight, hard after landing — no user control, because the
right answer here does not vary much.

```
  day −4  ▁▁▁  0.6×    easing in at home
  day −2  ▃▃▃  0.8×
  day −1  ▅▅▅  0.9×
  ────────── fly ──────────
  day +1  ███  1.4×    destination light is now pulling the same way
  day +2  ███  1.4×
```

Before you leave, the destination's light-dark cycle is not helping and a
brutal schedule mostly costs you sleep you will need. After you land it is
working with you, and the sooner it is over the better.

---

## 5. Amplitude

Phase is *where* the rhythm sits. Amplitude is *how deep the trough and how
high the peak* — how emphatically the clock insists on anything. They move
independently, and almost all jet-lag advice ignores the second one.

### Flattening

Light delivered close to CBTmin drives the oscillator toward its singularity
and suppresses amplitude rather than shifting phase. A flattened clock
re-entrains faster — there is less inertia to overcome — but it holds its new
phase poorly and the subjective experience is worse: flat alertness, flat mood,
no strong signal telling you when to sleep.

`AMPLITUDE_FLATTEN_H = 1.5` marks that region. For an 8am riser it is roughly
2:30–5:30am, which is to say: **if you wake in the night, do not turn the
lights on.**

### Boosting

Across the subjective day — 6 to 14 hours after CBTmin — light reinforces
amplitude and barely touches phase, because that stretch *is* the dead zone.
This is the free lunch in the model. You get a stronger, more robust rhythm at
no cost in phase, which is why the schedule always includes a daylight block
there even on days when it is not trying to move anything.

```
 CBTmin        wake                                    bed
   │            │                                       │
   ▼            ▼                                       ▼
  04:00       08:00   10:00 ─── boost ─── 18:00       00:00
   ░░           ██        ████████████████
 flatten      shift          amplitude
```

### The index

The percentage shown in the UI is a **heuristic for communication, not a
physiological prediction**. It says "shifting fast costs robustness, daylight
buys some back", and the constants are tuned for a readable curve, not fitted
to data:

```
next = clamp(prev − 0.10·hoursShifted + 0.02 + 0.03·hasBoost, 0.5, 1.0)
```

Treat it as an argument for pacing yourself, not a measurement. If you want a
real amplitude estimate you need actual temperature or melatonin data, and
this app has neither.

---

## 6. Following the sun is sometimes exactly wrong

"Get outside, get some sun, you'll adjust" is good advice going west and
actively harmful going east. The reason is geometric, and it is worth working
through.

Take an 8am riser, so CBTmin sits at 4am body time. On the destination clock
your body's CBTmin lands at `4 + tzDiff`, and the zone you need to **avoid**
when advancing — the delay zone — runs the six hours before it:

```
delay zone (destination local) = [tzDiff − 2, tzDiff + 4]
```

### Eastward: the sun is in the wrong place

| Route | tzDiff | Body CBTmin | Delay zone | Morning sun (6–9am) |
|---|---|---|---|---|
| BOS → LHR | +5 | 9:00am | 3:00–9:00am | **in the delay zone** |
| BOS → CDG | +6 | 10:00am | 4:00–10:00am | **in the delay zone** |
| BOS → DXB | +8 | 12:00pm | 6:00am–12:00pm | **entirely in it** |
| BOS → DEL | +9.5 | 1:30pm | 7:30am–1:30pm | **entirely in it** |

For Boston to London the rule that falls out is the opposite of the folk
advice:

> **Stay dark until 9am London time. Then get as much light as you can from
> 9am to 3pm.**

Sunrise in London in May is around 5am. Those four hours of early morning sun
land squarely in your delay zone and push your clock the wrong way, undoing the
advance you are trying to build. The advance zone does not open until 9am.

Generalising: morning daylight sits in the delay zone whenever
`2 ≲ tzDiff ≲ 11`. Past 12 the planner wraps to a delay anyway. So the trap
covers **essentially every eastward trip that matters** — which is the answer
to "where does following the sun do the opposite of what you want".

### Westward: the sun cooperates

Going west you need to delay, so you want light *before* CBTmin — the evening.
Boston to Los Angeles, tzDiff = −3: body CBTmin lands at 1:00am LA time, delay
zone 7:00pm–1:00am. Afternoon and evening sun is exactly what you want, and it
is exactly what is available. Nothing to fight.

This is a second, independent reason eastward travel is harder, on top of the
long intrinsic period. Going west, the sky is on your side.

---

## 7. The worst possible schedule to follow the sun on

Make it as bad as it can get: maximise daylight landing in the wrong PRC arm,
and put the *right* arm somewhere you cannot use it.

Three things have to line up.

1. **Eastward**, so the delay zone occupies the destination's morning.
2. **tzDiff as large as possible while still under the 12h wrap** — past 12 the
   planner flips to a delay and the problem disappears.
3. **Body wake time landing in the destination's late afternoon**, so you sleep
   through the advance window and are awake for the delay window.

Boston to Delhi, tzDiff = +9.5, is close to the theoretical worst:

```
Body clock, expressed on Delhi's clock, before any adjustment:

  CBTmin        1:30pm
  wake          5:30pm          ← you want to get up as the sun goes down
  bed           9:30am          ← you want to sleep through the morning

  delay zone    7:30am – 1:30pm   ▓▓▓ full daylight, wrong direction
  advance zone  1:30pm – 7:30pm   ░░░ you are asleep for the first half
  strong delay 10:30am – 1:30pm   ▓▓▓ peak sun, peak wrong
```

Follow the sun here and every hour of it is working against you. You are awake
through the Delhi dawn, which delays a clock you need to advance; you sleep
through the early afternoon, which is the only advance light you could have
reached; and the brightest part of the day sits in the strong delay band where
it does maximum damage.

What makes it worse than a 12h shift is precisely that it is *not* a 12h shift.
At +12 the planner gives up on advancing and delays instead, and a delay puts
the useful window in the evening where the sun still is. At +9.5 you are
committed to the harder direction with no daylight to help.

**The practical rule:** on a large eastward trip, the first two days are about
what you refuse to look at, not what you seek out. Sunglasses before 9–10am
local, then get outside hard for the rest of the morning and early afternoon.

---

## 8. Where this model stops

- **One-size chronotype.** Everything derives from a single wake time. Real
  chronotype varies by hours, and larks and owls need different CBTmin offsets.
- **No light dosing.** The model treats light as binary. Real PRCs scale with
  illuminance and spectrum; 10,000 lux for 30 minutes is not 500 lux for
  10 hours.
- **Linear entrainment.** Shifts are assumed to accumulate at a fixed daily
  rate. Real re-entrainment is non-linear and slows as you approach the target.
- **The amplitude index is a heuristic.** See §5.
- **No individual variation.** Same schedule for everyone on the same route.

For background: the human light PRC is characterised in Khalsa et al. (2003);
the practical advance/delay protocols this follows are the Eastman and Burgess
jet-lag work; the melatonin PRC running roughly antiphase to light comes from
Lewy and colleagues; amplitude suppression and the singularity behaviour trace
to the Czeisler critical-pulse experiments and the Jewett–Kronauer models. Read
those before trusting any number in here.

---

## 9. Not medical advice

This is a scheduling tool built by a student, not a clinical device. Melatonin
timing in particular interacts with medication and with several conditions. Ask
someone qualified before acting on it.
