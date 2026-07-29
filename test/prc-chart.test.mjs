import test from 'node:test';
import assert from 'node:assert/strict';

import { renderPRC } from '../lib/prc-chart.js';
import { lightWindow, avoidWindow, sleepWindow } from '../lib/circadian.js';

/**
 * Minimal SVG-ish DOM. The chart only ever creates elements, sets attributes
 * and appends, so this is enough to assert on the geometry it produces.
 */
function stubDocument() {
  const make = (tag) => {
    const node = {
      tag,
      attrs: {},
      children: [],
      setAttribute(k, v) { this.attrs[k] = String(v); },
      getAttribute(k) { return this.attrs[k]; },
      appendChild(child) { this.children.push(child); return child; },
    };
    // Mirror the real DOM: assigning textContent replaces all children.
    let text = '';
    Object.defineProperty(node, 'textContent', {
      get: () => text,
      set(v) { text = String(v); node.children.length = 0; },
    });
    return node;
  };
  globalThis.document = { createElementNS: (_ns, tag) => make(tag) };
  return make('svg');
}

const W = 320;
const within = (v, lo, hi) => v >= lo - 1e-6 && v <= hi + 1e-6;

function render(cbt, direction) {
  const svg = stubDocument();
  const seek = lightWindow(cbt, direction);
  const avoid = avoidWindow(cbt, direction);
  renderPRC(svg, {
    cbtMinH: cbt,
    direction,
    seek: [seek.start, seek.end],
    avoid: [avoid.start, avoid.end],
    sleep: sleepWindow(cbt),
  });
  return svg;
}

test('every rect stays inside the viewBox', () => {
  for (let cbt = 0; cbt < 24; cbt += 0.5) {
    for (const dir of ['advance', 'delay']) {
      const svg = render(cbt, dir);
      for (const node of svg.children.filter((c) => c.tag === 'rect')) {
        const x = Number(node.attrs.x);
        const w = Number(node.attrs.width);
        assert.ok(within(x, 0, W), `cbt=${cbt} ${dir}: rect x=${x} out of range`);
        assert.ok(w >= 0 && within(x + w, 0, W), `cbt=${cbt} ${dir}: rect spills to ${x + w}`);
      }
    }
  }
});

test('the curve is one continuous path spanning the full width', () => {
  const svg = render(4, 'advance');
  const paths = svg.children.filter((c) => c.tag === 'path');
  assert.equal(paths.length, 1, 'curve should not be split into runs');

  const coords = paths[0].attrs.d.match(/[ML]([\d.]+) ([\d.]+)/g).map((s) => {
    const [, x, y] = /[ML]([\d.]+) ([\d.]+)/.exec(s);
    return [Number(x), Number(y)];
  });
  assert.ok(Math.abs(coords[0][0] - 0) < 1e-6, 'starts at x=0');
  assert.ok(Math.abs(coords[coords.length - 1][0] - W) < 1e-6, 'ends at x=W');

  // x must rise monotonically — a wrap would send it backwards mid-path.
  for (let i = 1; i < coords.length; i++) {
    assert.ok(coords[i][0] >= coords[i - 1][0], `x went backwards at sample ${i}`);
  }
});

test('the curve meets itself at both ends of the day', () => {
  const svg = render(4, 'advance');
  const d = svg.children.find((c) => c.tag === 'path').attrs.d;
  const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
  assert.ok(Math.abs(ys[0] - ys[ys.length - 1]) < 1e-6, 'midnight discontinuity in the curve');
});

test('a window crossing midnight is drawn as two pieces', () => {
  // Advancing with CBTmin at 4am puts the avoid window at 10pm to midnight.
  const svg = render(4, 'advance');
  const rects = svg.children.filter((c) => c.tag === 'rect');
  const delayBand = rects.filter((r) => r.attrs.fill === '#e84060');
  assert.equal(delayBand.length, 2, 'the delay band spans midnight and should split');
  const total = delayBand.reduce((s, r) => s + Number(r.attrs.width), 0);
  assert.ok(Math.abs(total - (6 / 24) * W) < 1e-6, 'split pieces should still total 6 hours');
});

test('CBTmin is marked at the right position', () => {
  const svg = render(9, 'advance');
  const line = svg.children.find((c) => c.tag === 'line' && c.attrs.stroke === '#f0c040');
  assert.ok(line, 'CBTmin line missing');
  assert.ok(Math.abs(Number(line.attrs.x1) - (9 / 24) * W) < 1e-6);
});

test('the accessible label names both windows', () => {
  const svg = render(4, 'advance');
  const label = svg.getAttribute('aria-label');
  assert.match(label, /CBTmin at 4:00 AM/);
  assert.match(label, /Seek light/);
  assert.match(label, /Avoid light/);
});

test('re-rendering clears the previous drawing', () => {
  const svg = render(4, 'advance');
  const first = svg.children.length;
  renderPRC(svg, { cbtMinH: 6, direction: 'delay' });
  assert.ok(svg.children.length > 0);
  assert.ok(svg.children.length <= first, 'stale nodes left behind on re-render');
});
