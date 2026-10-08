import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatsForInstant, parseDateInput, formatSeconds, validTimeZone, timeZones } from '../src/lib/datetime.ts';
const parse = (field, value, zone = 'UTC') => parseDateInput(field, value, zone);
const at = text => Date.parse(text);

for (const [zone, iso, rfc] of [
  ['UTC', '2024-01-01T00:00:00.123Z', 'Mon, 01 Jan 2024 00:00:00 +0000'],
  ['America/New_York', '2023-12-31T19:00:00.123-05:00', 'Sun, 31 Dec 2023 19:00:00 -0500'],
  ['Asia/Kolkata', '2024-01-01T05:30:00.123+05:30', 'Mon, 01 Jan 2024 05:30:00 +0530'],
  ['Asia/Kathmandu', '2024-01-01T05:45:00.123+05:45', 'Mon, 01 Jan 2024 05:45:00 +0545'],
  ['Pacific/Chatham', '2024-01-01T13:45:00.123+13:45', 'Mon, 01 Jan 2024 13:45:00 +1345'],
]) test(`all representations round-trip in ${zone}`, () => {
  const ms = 1704067200123, values = formatsForInstant(ms, zone);
  assert.equal(values.iso8601, iso); assert.equal(values.rfc2822, rfc);
  assert.equal(values['unix-sec'], '1704067200.123'); assert.equal(values['unix-ms'], String(ms));
  for (const field of ['unix-sec', 'unix-ms', 'iso8601', 'human', 'datepicker']) assert.equal(parse(field, values[field], zone).instant, ms, field);
  assert.equal(parse('rfc2822', values.rfc2822, zone).instant, ms - 123);
});
test('local ISO, date picker, human and RFC input use the chosen zone, not the machine zone', () => {
  for (const [field, text] of [['iso8601', '2024-01-01T09:00:00.025'], ['datepicker', '2024-01-01T09:00:00.025'], ['human', 'January 1, 2024 9:00:00.025 AM']]) {
    assert.equal(parse(field, text, 'Asia/Kolkata').instant, at('2024-01-01T03:30:00.025Z'));
  }
  assert.equal(parse('rfc2822', '01 Jan 2024 09:00:00', 'Asia/Kolkata').instant, at('2024-01-01T03:30:00Z'));
  assert.equal(parse('iso8601', '2024-01-01', 'Asia/Kolkata').instant, at('2023-12-31T18:30:00Z'));
});
test('explicit ISO and RFC offsets override the selected input zone', () => {
  assert.equal(parse('iso8601', '2024-01-01T09:00:00+05:30', 'America/New_York').instant, at('2024-01-01T03:30:00Z'));
  assert.equal(parse('iso8601', '2024-01-01T09:00:00Z', 'Asia/Kolkata').instant, at('2024-01-01T09:00:00Z'));
  assert.equal(parse('rfc2822', 'Mon, 01 Jan 2024 09:00:00 +0530', 'UTC').instant, at('2024-01-01T03:30:00Z'));
});
test('parsing distinguishes source wall times from explicit-offset dates and epochs', () => {
  for (const [field, text] of [['iso8601', '2024-01-01T09:00'], ['datepicker', '2024-01-01T09:00'], ['human', 'January 1, 2024 9:00 AM'], ['rfc2822', '01 Jan 2024 09:00:00']]) {
    assert.equal(parse(field, text, 'Asia/Kolkata').wallTime, true);
  }
  for (const [field, text] of [['iso8601', '2024-01-01T09:00Z'], ['iso8601', '2024-01-01T09:00+0530'], ['human', 'January 1, 2024 9:00 AM GMT+05:30'], ['rfc2822', '01 Jan 2024 09:00:00 +0530'], ['unix-sec', '0'], ['unix-ms', '0']]) {
    assert.equal(parse(field, text, 'Asia/Kolkata').wallTime, false);
  }
});
test('offsets follow the date and daylight-saving transition', () => {
  assert.equal(formatsForInstant(at('2024-01-01T00:00Z'), 'America/New_York').offset, '-05:00');
  assert.equal(formatsForInstant(at('2024-07-01T00:00Z'), 'America/New_York').offset, '-04:00');
  assert.equal(formatsForInstant(at('2024-03-10T06:59:59Z'), 'America/New_York').iso8601, '2024-03-10T01:59:59.000-05:00');
  assert.equal(formatsForInstant(at('2024-03-10T07:00:00Z'), 'America/New_York').iso8601, '2024-03-10T03:00:00.000-04:00');
  assert.equal(formatsForInstant(at('2024-01-01T00:00Z'), 'Europe/London').iso8601, '2024-01-01T00:00:00.000+00:00');
});
test('DST gaps and a skipped calendar day are rejected, never rolled forward', () => {
  assert.throws(() => parse('datepicker', '2024-03-10T02:30', 'America/New_York'), /does not exist/);
  assert.throws(() => parse('datepicker', '2024-10-06T02:15', 'Australia/Lord_Howe'), /does not exist/);
  assert.throws(() => parse('datepicker', '2011-12-30T12:00', 'Pacific/Apia'), /does not exist/);
});
test('DST repeats return both exact instants, including half-hour transitions', () => {
  assert.deepEqual(parse('datepicker', '2024-11-03T01:30', 'America/New_York').candidates, [at('2024-11-03T05:30Z'), at('2024-11-03T06:30Z')]);
  assert.deepEqual(parse('datepicker', '2024-04-07T01:45', 'Australia/Lord_Howe').candidates, [at('2024-04-06T14:45Z'), at('2024-04-06T15:15Z')]);
});
test('negative, zero, fractional and large supported epochs retain exact milliseconds', () => {
  for (const ms of [-2208988800123, -1001, -999, -1, 0, 1, 999, 1001, 1704067200123, 253402300799999]) {
    const seconds = formatSeconds(ms);
    assert.equal(parse('unix-sec', seconds).instant, ms);
    assert.equal(parse('unix-ms', String(ms)).instant, ms);
    assert.equal(parse('iso8601', formatsForInstant(ms, 'UTC').iso8601).instant, ms);
  }
  assert.equal(formatSeconds(-1), '-0.001'); assert.equal(formatSeconds(-1001), '-1.001');
  assert.equal(parse('unix-sec', '+1704067200.010').instant, 1704067200010);
});
test('calendar boundaries and year 0001 work without JavaScript’s 1900-year coercion', () => {
  for (const iso of ['0001-01-01T00:00:00.000Z', '0099-12-31T23:59:59.001Z', '2000-02-29T12:00:00.000Z', '9999-12-31T23:59:59.999Z']) {
    const ms = parse('iso8601', iso).instant; assert.equal(formatsForInstant(ms, 'UTC').iso8601, iso);
  }
  assert.equal(parse('datepicker', '0001-01-01T00:00', 'UTC').instant, at('0001-01-01T00:00:00Z'));
});
for (const [field, text] of [
  ['unix-sec', '12oops'], ['unix-sec', '1e9'], ['unix-sec', 'NaN'], ['unix-sec', '1.0001'], ['unix-ms', '1.5'], ['unix-ms', '99999999999999999'],
  ['iso8601', '2024-02-30T12:00Z'], ['iso8601', '2023-02-29T12:00Z'], ['iso8601', '2024-01-01T24:00Z'], ['iso8601', '2024-01-01T00:00:60Z'], ['iso8601', '2024-01-01T00:00+05:99'], ['iso8601', '2024-01-01T00:00+24:00'], ['iso8601', '0000-01-01T00:00Z'],
  ['human', 'February 30, 2024 12:00 AM'], ['human', 'Januarish 1, 2024 12:00 AM'], ['human', 'January 1, 2024 13:00 PM'],
  ['rfc2822', '30 Feb 2024 00:00:00 +0000'],
]) test(`reject malformed ${field}: ${text}`, () => assert.throws(() => parse(field, text)));
test('unsupported zones and seconds-based historical offsets fail clearly', () => {
  assert.equal(validTimeZone('not/a-zone'), false); assert.ok(timeZones('Asia/Kathmandu').includes('Asia/Kathmandu'));
  assert.throws(() => parse('datepicker', '2024-01-01T00:00', 'not/a-zone'), /timezone/);
  assert.throws(() => formatsForInstant(at('1900-01-01T00:00Z'), 'Europe/Paris'), /seconds-based/);
});
test('round trips across modern dates and published browser timezone choices', () => {
  const zones = timeZones('UTC').filter((_, i) => i % 7 === 0);
  for (const zone of zones) for (const iso of ['2024-01-15T12:34:56.789Z', '2024-07-15T12:34:56.789Z']) {
    const ms = at(iso), values = formatsForInstant(ms, zone);
    assert.equal(parse('iso8601', values.iso8601, zone).instant, ms, zone);
    assert.equal(parse('datepicker', values.datepicker, zone).instant, ms, zone);
  }
});
