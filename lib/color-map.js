/**
 * Activity types, their display colours, and how they map onto the eleven
 * colours Google Calendar allows. Every type gets a distinct calendar colour
 * so a synced week is readable at a glance.
 */

export const COLOR_MAP = {
  sleep: {
    colorId: '9', // Blueberry
    label: 'Sleep',
    short: 'Sleep',
    css: '--c-sleep',
    icon: '◐',
  },
  bright_light: {
    colorId: '5', // Banana
    label: 'Bright light',
    short: 'Light',
    css: '--c-light',
    icon: '☀',
  },
  amplitude_boost: {
    colorId: '7', // Peacock
    label: 'Daylight — amplitude',
    short: 'Amplitude',
    css: '--c-amp',
    icon: '◈',
  },
  light_avoidance: {
    colorId: '11', // Tomato
    label: 'Avoid light',
    short: 'Dark',
    css: '--c-avoid',
    icon: '⊘',
  },
  dim_light: {
    colorId: '1', // Lavender
    label: 'Dim light',
    short: 'Dim',
    css: '--c-dim',
    icon: '◑',
  },
  melatonin: {
    colorId: '3', // Grape
    label: 'Melatonin',
    short: 'Melatonin',
    css: '--c-mel',
    icon: '◆',
  },
  caffeine_cutoff: {
    colorId: '6', // Tangerine
    label: 'Caffeine cutoff',
    short: 'Caffeine',
    css: '--c-caf',
    icon: '▲',
  },
  eating: {
    colorId: '2', // Sage
    label: 'Eating window',
    short: 'Meals',
    css: '--c-eat',
    icon: '▬',
  },
};

/** Order used for legends and any list that should read consistently. */
export const ACTIVITY_ORDER = [
  'sleep',
  'bright_light',
  'amplitude_boost',
  'light_avoidance',
  'dim_light',
  'melatonin',
  'caffeine_cutoff',
  'eating',
];

export function activityMeta(type) {
  return COLOR_MAP[type] || { colorId: '8', label: type, short: type, css: '--c-dim', icon: '·' };
}

/** Build a Google Calendar event payload from a schedule entry. */
export function toCalendarEvent(entry) {
  const meta = activityMeta(entry.activity_type);
  const suffix = entry.inFlight ? ' (in flight)' : '';

  return {
    summary: `JetShift · ${meta.label}${suffix}`,
    description: entry.description,
    start: { dateTime: entry.start.toISOString(), timeZone: entry.timezone },
    end: { dateTime: entry.end.toISOString(), timeZone: entry.timezone },
    colorId: meta.colorId,
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 10 }],
    },
  };
}
