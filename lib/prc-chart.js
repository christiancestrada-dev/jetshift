/**
 * SVG rendering of the light phase response curve.
 *
 * The drawn curve is illustrative, not the model: it crosses zero at CBTmin,
 * peaks about 90 minutes either side, and decays to nothing by six hours out,
 * which is the shape the banded model in circadian.js approximates. Shading
 * and window markers come from the real numbers.
 */

import { wrap24, wrap12, formatHour } from './time.js';
import { PRC_MODERATE_H } from './circadian.js';

const NS = 'http://www.w3.org/2000/svg';

/** Kept in step with the custom properties in popup.css. */
export const PALETTE = {
  sleep: '#5b7fa6',
  advance: '#7fc9b6',
  delay: '#a9a3d8',
  cbtMin: '#dcc482',
  curve: '#c5d8d5',
  rule: '#55635f',
  label: '#93a8a4',
  seek: '#dcc482',
  avoid: '#5b7fa6',
};

const W = 320;
const H = 120;
const PAD_TOP = 21;   // headroom for the CBTmin label
const PAD_BOT = 20;
const MID = PAD_TOP + (H - PAD_TOP - PAD_BOT) / 2;
const AMP = (H - PAD_TOP - PAD_BOT) / 2;

const xOf = (hour) => (wrap24(hour) / 24) * W;

/** Illustrative PRC shape. Zero at CBTmin, peak near 1.5h, zero by 6h. */
function response(tau) {
  const t = wrap12(tau);
  const mag = Math.abs(t);
  if (mag >= PRC_MODERATE_H) return 0;
  const rise = (mag / 1.5) * Math.exp(1 - mag / 1.5);
  const taper = Math.cos((Math.PI * mag) / (PRC_MODERATE_H * 2));
  return Math.sign(t) * rise * taper;
}

function el(tag, attrs) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/**
 * Split a possibly midnight-crossing window into drawable [x, width] pieces.
 * A window wider than 24h is clamped; a zero-width one yields nothing.
 */
function segments(start, end) {
  const span = Math.min(Math.max(end - start, 0), 24);
  if (span <= 0) return [];
  const from = wrap24(start);
  const to = from + span;
  if (to <= 24) return [[(from / 24) * W, (span / 24) * W]];
  return [
    [(from / 24) * W, ((24 - from) / 24) * W],
    [0, ((to - 24) / 24) * W],
  ];
}

function addBand(svg, start, end, fill, opacity) {
  for (const [x, w] of segments(start, end)) {
    if (w <= 0.5) continue;
    svg.appendChild(el('rect', {
      x, y: PAD_TOP, width: w, height: H - PAD_TOP - PAD_BOT,
      fill, opacity,
    }));
  }
}

function addMarker(svg, start, end, color) {
  for (const [x, w] of segments(start, end)) {
    if (w <= 0.5) continue;
    svg.appendChild(el('rect', {
      x, y: H - PAD_BOT + 4, width: w, height: 4, rx: 2, fill: color,
    }));
  }
}

/**
 * @param {SVGElement} svg   target, expected to use viewBox "0 0 320 120"
 * @param {object} opts
 * @param {number} opts.cbtMinH   CBTmin on the local clock, decimal hours
 * @param {string} opts.direction 'advance' | 'delay' | 'none'
 * @param {[number,number]} [opts.seek]   light window to seek
 * @param {[number,number]} [opts.avoid]  window to keep dark
 * @param {[number,number]} [opts.sleep]  sleep window
 */
export function renderPRC(svg, { cbtMinH, direction, seek, avoid, sleep }) {
  svg.textContent = '';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  // Sleep sits behind everything else.
  // Kept faint: it underlays the PRC arms and must not muddy them.
  if (sleep) addBand(svg, sleep[0], sleep[1], PALETTE.sleep, 0.14);

  // The two active arms of the curve.
  addBand(svg, cbtMinH, cbtMinH + PRC_MODERATE_H, PALETTE.advance, 0.2);
  addBand(svg, cbtMinH - PRC_MODERATE_H, cbtMinH, PALETTE.delay, 0.2);

  // Zero line.
  svg.appendChild(el('line', {
    x1: 0, y1: MID, x2: W, y2: MID,
    stroke: PALETTE.rule, 'stroke-width': 1,
  }));

  // Curve. Sampled left to right across the clock, so x rises monotonically and
  // there is no wrap to handle — `response` already wraps the phase for us, and
  // it returns the same value at t=0 and t=24 so the ends line up.
  const STEPS = 240;
  const points = [];
  for (let i = 0; i <= STEPS; i++) {
    const t = (i / STEPS) * 24;
    const y = MID - response(t - cbtMinH) * AMP;
    points.push([(t / 24) * W, y]);
  }
  const d = points
    .map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(' ');
  svg.appendChild(el('path', {
    d, fill: 'none', stroke: PALETTE.curve, 'stroke-width': 1.75,
    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
  }));

  // CBTmin.
  const cx = xOf(cbtMinH);
  svg.appendChild(el('line', {
    x1: cx, y1: PAD_TOP - 6, x2: cx, y2: H - PAD_BOT,
    stroke: PALETTE.cbtMin, 'stroke-width': 1.5, 'stroke-dasharray': '3 3',
  }));
  const label = el('text', {
    x: Math.min(Math.max(cx, 24), W - 24), y: PAD_TOP - 9,
    fill: PALETTE.label, 'font-size': 10, 'text-anchor': 'middle',
    'font-family': "'Fraunces', Georgia, serif", 'font-weight': 600,
  });
  label.textContent = 'CBTmin';
  svg.appendChild(label);

  // Prescription markers along the base.
  if (seek) addMarker(svg, seek[0], seek[1], PALETTE.seek);
  if (avoid) addMarker(svg, avoid[0], avoid[1], PALETTE.avoid);

  svg.setAttribute(
    'aria-label',
    `Phase response curve. CBTmin at ${formatHour(cbtMinH)}. ` +
    (seek ? `Seek light ${formatHour(seek[0])} to ${formatHour(seek[1])}. ` : '') +
    (avoid ? `Avoid light ${formatHour(avoid[0])} to ${formatHour(avoid[1])}.` : '')
  );
}
