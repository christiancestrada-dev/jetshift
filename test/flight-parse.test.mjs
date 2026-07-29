import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { parseFlightText, parseDateTime, makeResolver } from '../lib/flight-parse.js';

const here = dirname(fileURLToPath(import.meta.url));
const airports = JSON.parse(readFileSync(join(here, '../data/airports.json'), 'utf8'));

const resolve = makeResolver(airports);

const NOW = new Date('2026-04-01T12:00:00Z');
const parse = (text) => parseFlightText(text, resolve, NOW);

test('parses the arrow form', () => {
  const r = parse(`BA215 BOS → LHR
Departs: May 15 18:30
Arrives: May 16 06:45`);
  assert.equal(r.dep, 'BOS');
  assert.equal(r.arr, 'LHR');
  assert.equal(r.depDatetime, '2026-05-15T18:30');
  assert.equal(r.arrDatetime, '2026-05-16T06:45');
});

test('parses day-before-month dates', () => {
  const r = parse(`BOS - LHR
Departs 15 May 2026, 18:30
Arrives 16 May 2026, 06:45`);
  assert.equal(r.depDatetime, '2026-05-15T18:30');
  assert.equal(r.arrDatetime, '2026-05-16T06:45');
});

test('parses 12-hour clock times', () => {
  const r = parse(`JFK to LAX
Departs: Jun 3 6:05 PM
Arrives: Jun 3 9:20 PM`);
  assert.equal(r.depDatetime, '2026-06-03T18:05');
  assert.equal(r.arrDatetime, '2026-06-03T21:20');
});

test('parses midnight correctly as 12 AM', () => {
  const r = parse(`SFO to JFK
Departs: Jul 4 12:30 AM
Arrives: Jul 4 8:55 AM`);
  assert.equal(r.depDatetime, '2026-07-04T00:30');
  assert.equal(r.arrDatetime, '2026-07-04T08:55');
});

test('parses ISO timestamps', () => {
  const r = parse(`BOS -> LHR
Departure 2026-05-15T18:30
Arrival 2026-05-16T06:45`);
  assert.equal(r.depDatetime, '2026-05-15T18:30');
  assert.equal(r.arrDatetime, '2026-05-16T06:45');
});

test('parses slash dates', () => {
  const r = parse(`BOS/LHR
Departs 5/15 18:30
Arrives 5/16 06:45`);
  assert.equal(r.depDatetime, '2026-05-15T18:30');
  assert.equal(r.arrDatetime, '2026-05-16T06:45');
});

test('resolves city names', () => {
  const r = parse(`Boston to London
Departs May 15 18:30
Arrives May 16 06:45`);
  assert.equal(r.dep, 'BOS');
  assert.equal(r.arr, 'LHR');
});

test('a multi-airport city resolves to the primary airport', () => {
  assert.equal(resolve('London'), 'LHR');
  assert.equal(resolve('London (Gatwick)'), 'LGW');
  assert.equal(resolve('New York'), 'JFK');
});

test('IATA codes resolve regardless of case', () => {
  assert.equal(resolve('bos'), 'BOS');
  assert.equal(resolve('BOS'), 'BOS');
  assert.equal(resolve('zzz'), null);
});

test('an arrival time with no date inherits the departure date', () => {
  const r = parse(`BOS -> LHR
Departs May 15 18:30
Arrives 23:45`);
  assert.equal(r.depDatetime, '2026-05-15T18:30');
  assert.equal(r.arrDatetime, '2026-05-15T23:45');
});

test('an overnight leg rolls the arrival to the next day', () => {
  const r = parse(`BOS -> LHR
Departs May 15 22:30
Arrives 06:45`);
  assert.equal(r.depDatetime, '2026-05-15T22:30');
  assert.equal(r.arrDatetime, '2026-05-16T06:45');
});

test('a date already in the past rolls to next year', () => {
  // NOW is April 2026, so a January flight means January 2027.
  const r = parse(`BOS -> LHR
Departs Jan 10 18:30
Arrives Jan 11 06:45`);
  assert.equal(r.depDatetime, '2027-01-10T18:30');
});

test('a recently-past date stays in the current year', () => {
  // Within 60 days of NOW, so March 2026 rather than March 2027.
  const r = parse(`BOS -> LHR
Departs Mar 20 18:30
Arrives Mar 21 06:45`);
  assert.equal(r.depDatetime, '2026-03-20T18:30');
});

test('an explicit year is respected', () => {
  const r = parse(`BOS -> LHR
Departs Jan 10, 2029 18:30
Arrives Jan 11, 2029 06:45`);
  assert.equal(r.depDatetime, '2029-01-10T18:30');
});

test('unlabelled lines fall back to document order', () => {
  const r = parse(`BOS -> LHR
May 15 18:30
May 16 06:45`);
  assert.equal(r.depDatetime, '2026-05-15T18:30');
  assert.equal(r.arrDatetime, '2026-05-16T06:45');
});

test('rejects text with no route', () => {
  assert.throws(() => parse('Departs May 15 18:30\nArrives May 16 06:45'), /airport pair/);
});

test('rejects an unknown airport code', () => {
  assert.throws(() => parse('ZZZ -> QQQ\nDeparts May 15 18:30\nArrives May 16 06:45'), /airport pair/);
});

test('rejects a route to the same airport', () => {
  assert.throws(() => parse('BOS -> BOS\nDeparts May 15 18:30\nArrives May 16 06:45'), /same/);
});

test('rejects text with only one time', () => {
  assert.throws(() => parse('BOS -> LHR\nDeparts May 15 18:30'), /departure and an arrival/);
});

test('rejects empty input', () => {
  assert.throws(() => parse('   '), /Nothing to parse/);
});

test('parseDateTime rejects impossible clock values', () => {
  assert.equal(parseDateTime('Departs May 15 25:70', NOW), null);
  assert.equal(parseDateTime('Departs May 15 19:99', NOW), null);
});

test('parseDateTime reports a bare time as dateless', () => {
  const r = parseDateTime('Arrives 06:45', NOW);
  assert.equal(r.hasDate, false);
  assert.equal(r.hh, 6);
  assert.equal(r.mm, 45);
});

test('a flight number is not mistaken for a date', () => {
  const r = parse(`BA215 BOS -> LHR
Departs: May 15 18:30
Arrives: May 16 06:45`);
  assert.equal(r.depDatetime, '2026-05-15T18:30');
});
