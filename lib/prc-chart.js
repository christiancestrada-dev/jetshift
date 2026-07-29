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

const W = 320;
const H = 120;
const PAD_TOP = 14;
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
  if (sleep) addBand(svg, sleep[0], sleep[1], '#2b4a80', 0.28);

  // The two active arms of the curve.
  addBand(svg, cbtMinH, cbtMinH + PRC_MODERATE_H, '#00c4a8', 0.09);
  addBand(svg, cbtMinH - PRC_MODERATE_H, cbtMinH, '#e84060', 0.09);

  // Zero line.
  svg.appendChild(el('line', {
    x1: 0, y1: MID, x2: W, y2: MID,
    stroke: '#1e3050', 'stroke-width': 1,
  }));

  // Curve, sampled on the clock so the midnight wrap is handled by splitting.
  const step = 0.1;
  let run = [];
  const runs = [];
  for (let t = 0; t <= 24 + 1e-9; t += step) {
    const r = response(t - cbtMinH);
    const point = [xOf(t === 24 ? 23.999 : t), MID - r * AMP];
    if (t > 0 && xOf(t) < xOf(t - step)) {
      // Crossed midnight mid-sample; close the run and start a new one.
      if (run.length > 1) runs.push(run);
      run = [];
    }
    run.push(point);
  }
  if (run.length > 1) runs.push(run);

  for (const points of runs) {
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    svg.appendChild(el('path', {
      d, fill: 'none', stroke: '#8fa8c8', 'stroke-width': 1.5,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    }));
  }

  // CBTmin.
  const cx = xOf(cbtMinH);
  svg.appendChild(el('line', {
    x1: cx, y1: PAD_TOP - 6, x2: cx, y2: H - PAD_BOT,
    stroke: '#f0c040', 'stroke-width': 1, 'stroke-dasharray': '2 3',
  }));
  const label = el('text', {
    x: Math.min(Math.max(cx, 22), W - 22), y: PAD_TOP - 8,
    fill: '#f0c040', 'font-size': 9, 'text-anchor': 'middle',
    'font-family': "ui-monospace, 'SF Mono', Menlo, monospace",
  });
  label.textContent = 'CBTmin';
  svg.appendChild(label);

  // Prescription markers along the base.
  if (seek) addMarker(svg, seek[0], seek[1], direction === 'delay' ? '#e84060' : '#00c4a8');
  if (avoid) addMarker(svg, avoid[0], avoid[1], '#46587a');

  svg.setAttribute(
    'aria-label',
    `Phase response curve. CBTmin at ${formatHour(cbtMinH)}. ` +
    (seek ? `Seek light ${formatHour(seek[0])} to ${formatHour(seek[1])}. ` : '') +
    (avoid ? `Avoid light ${formatHour(avoid[0])} to ${formatHour(avoid[1])}.` : '')
  );
}
