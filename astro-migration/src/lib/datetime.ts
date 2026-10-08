export type DateTimeField = 'unix-sec' | 'unix-ms' | 'iso8601' | 'human' | 'datepicker' | 'rfc2822';
type WallTime = { year: number; month: number; day: number; hour: number; minute: number; second: number; millisecond: number };
export type ParsedTime = { instant: number; candidates: number[]; wallTime: boolean };
const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fullMonths = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fullWeekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const formatters = new Map<string, Intl.DateTimeFormat>();
const zoneValidity = new Map<string, boolean>();

export function validTimeZone(zone: string): boolean {
  if (!zoneValidity.has(zone)) {
    try { new Intl.DateTimeFormat('en', { timeZone: zone }); zoneValidity.set(zone, true); } catch { zoneValidity.set(zone, false); }
  }
  return zoneValidity.get(zone)!;
}
export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}
export function timeZones(local: string): string[] {
  const fallback = ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Tokyo', 'Asia/Shanghai', 'Asia/Kolkata', 'Asia/Kathmandu', 'Asia/Dubai', 'Australia/Sydney', 'Australia/Lord_Howe', 'Pacific/Auckland', 'Pacific/Chatham'];
  const intl = Intl as typeof Intl & { supportedValuesOf?: (key: string) => string[] };
  return [...new Set([local, ...fallback, ...(intl.supportedValuesOf?.('timeZone') ?? [])])].filter(validTimeZone).sort();
}
function utcWall(wall: WallTime): number {
  const date = new Date(0);
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  date.setUTCHours(wall.hour, wall.minute, wall.second, wall.millisecond);
  return date.getTime();
}
function checkedWall(wall: WallTime): WallTime {
  const date = new Date(utcWall(wall));
  if (wall.year < 1 || wall.year > 9999 || date.getUTCFullYear() !== wall.year || date.getUTCMonth() + 1 !== wall.month || date.getUTCDate() !== wall.day || date.getUTCHours() !== wall.hour || date.getUTCMinutes() !== wall.minute || date.getUTCSeconds() !== wall.second || date.getUTCMilliseconds() !== wall.millisecond) {
    throw new Error('Enter a real calendar date and time between years 0001 and 9999. Leap seconds are not supported.');
  }
  return wall;
}
function checkedInstant(ms: number): number {
  const year = new Date(ms).getUTCFullYear();
  if (!Number.isSafeInteger(ms) || !Number.isFinite(year) || year < 1 || year > 9999) throw new Error('That timestamp is outside the supported range (years 0001–9999).');
  return ms;
}
function zonedWall(ms: number, zone: string): WallTime {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn', era: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
  if (parts.era !== 'AD') throw new Error('This timezone puts the date outside years 0001–9999. Choose another timezone.');
  return checkedWall({ year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), millisecond: ((ms % 1000) + 1000) % 1000 });
}
function offsetMinutes(ms: number, zone: string): number {
  const offset = (utcWall(zonedWall(ms, zone)) - ms) / 60_000;
  if (!Number.isInteger(offset)) throw new Error('This historical timezone used a seconds-based offset. Choose UTC or a more recent date for ISO 8601 output.');
  return offset;
}
function offsetText(offset: number): string {
  return `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
function wallText(w: WallTime): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(w.millisecond, 3)}`;
}
export function formatSeconds(ms: number): string {
  const magnitude = BigInt(Math.abs(checkedInstant(ms)));
  const fraction = magnitude % 1000n;
  return `${ms < 0 ? '-' : ''}${magnitude / 1000n}${fraction ? '.' + String(fraction).padStart(3, '0').replace(/0+$/, '') : ''}`;
}
export function formatsForInstant(ms: number, zone: string): Record<DateTimeField, string> & { offset: string } {
  checkedInstant(ms);
  const w = zonedWall(ms, zone), offset = offsetText(offsetMinutes(ms, zone));
  const weekday = new Date(utcWall(w)).getUTCDay();
  return {
    'unix-sec': formatSeconds(ms), 'unix-ms': String(ms),
    iso8601: wallText(w) + (zone === 'UTC' ? 'Z' : offset), datepicker: wallText(w),
    human: `${fullWeekdays[weekday]}, ${fullMonths[w.month - 1]} ${w.day}, ${pad(w.year, 4)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}.${pad(w.millisecond, 3)} GMT${offset}`,
    rfc2822: `${weekdays[weekday]}, ${pad(w.day)} ${months[w.month - 1]} ${pad(w.year, 4)} ${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)} ${offset.replace(':', '')}`, offset,
  };
}
function parseOffset(text: string): number {
  if (/^(Z|UTC|GMT)$/i.test(text)) return 0;
  const match = text.replace(/^GMT/i, '').match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) throw new Error('Use a timezone offset such as Z, +05:30, or -07:00.');
  return (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}
function resolveWall(wall: WallTime, zone: string, offset?: string): ParsedTime {
  const nominal = utcWall(checkedWall(wall));
  if (offset) return { instant: checkedInstant(nominal - parseOffset(offset) * 60_000), candidates: [], wallTime: false };
  // Sample both sides of a clock change, then accept only exact wall-clock
  // round trips. This detects gaps and overlaps without the browser's local zone.
  const offsets = new Set([offsetMinutes(nominal, zone)]);
  for (const hours of [-48, -24, -12, 12, 24, 48]) {
    try { offsets.add(offsetMinutes(nominal + hours * 3_600_000, zone)); }
    catch { /* Nearby samples can leave the supported calendar at its endpoints. */ }
  }
  const candidates = [...offsets].map(minutes => nominal - minutes * 60_000).filter(ms => {
    const actual = zonedWall(ms, zone);
    return Object.keys(wall).every(key => wall[key as keyof WallTime] === actual[key as keyof WallTime]);
  }).sort((a, b) => a - b);
  if (!candidates.length) throw new Error(`This local time does not exist in ${zone} because the clock jumps forward. Choose a time before or after the jump.`);
  return { instant: checkedInstant(candidates[0]), candidates: candidates.length > 1 ? candidates : [], wallTime: true };
}
export function parseDateInput(field: DateTimeField, input: string, zone: string): ParsedTime {
  const text = input.trim();
  if (!text || text.length > 256) throw new Error('Enter a timestamp or a date and time.');
  if (!validTimeZone(zone)) throw new Error('Choose a supported IANA timezone.');
  if (field === 'unix-sec' || field === 'unix-ms') {
    const match = text.match(field === 'unix-sec' ? /^([+-]?)(\d{1,17})(?:\.(\d{1,3}))?$/ : /^([+-]?)(\d{1,17})$/);
    if (!match) throw new Error(field === 'unix-sec' ? 'Enter epoch seconds, optionally with up to three decimal places.' : 'Enter an integer Unix timestamp in milliseconds.');
    const ms = (BigInt(match[2]) * (field === 'unix-sec' ? 1000n : 1n) + BigInt((match[3] || '').padEnd(3, '0') || '0')) * (match[1] === '-' ? -1n : 1n);
    return { instant: checkedInstant(Number(ms)), candidates: [], wallTime: false };
  }
  if (field === 'datepicker' || field === 'iso8601' || /^\d{4}-/.test(text)) {
    const match = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?([Zz]|[+-]\d{2}:?\d{2})?$/);
    if (!match || (match[8] && !match[4])) throw new Error('Use YYYY-MM-DDTHH:mm:ss, with an optional Z or ±HH:mm offset. Millisecond precision is supported.');
    return resolveWall({ year: +match[1], month: +match[2], day: +match[3], hour: +(match[4] || 0), minute: +(match[5] || 0), second: +(match[6] || 0), millisecond: Number((match[7] || '').padEnd(3, '0')) }, zone, match[8]);
  }
  const match = field === 'rfc2822'
    ? text.match(/^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun),?\s+)?(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(Z|UTC|GMT(?:[+-]\d{2}:?\d{2})?|[+-]\d{2}:?\d{2})?$/i)
    : text.match(/^(?:(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?\s+)?([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(AM|PM)?\s*(Z|UTC|GMT(?:[+-]\d{2}:?\d{2})?|[+-]\d{2}:?\d{2})?$/i);
  if (!match) throw new Error(field === 'rfc2822' ? 'Use a date such as Mon, 01 Jan 2024 00:00:00 +0000.' : 'Use a date such as January 1, 2024 12:00:00 AM, or an ISO 8601 date.');
  const isRfc = field === 'rfc2822';
  const monthText = match[isRfc ? 2 : 1].toLowerCase();
  const month = months.findIndex((m, i) => m.toLowerCase() === monthText || fullMonths[i].toLowerCase() === monthText) + 1;
  let hour = Number(match[4]);
  if (!isRfc && match[8]) {
    if (hour < 1 || hour > 12) throw new Error('Use hours 1–12 with AM or PM.');
    hour = hour % 12 + (match[8].toUpperCase() === 'PM' ? 12 : 0);
  }
  return resolveWall({ year: +match[3], month, day: +match[isRfc ? 1 : 2], hour, minute: +match[5], second: +(match[6] || 0), millisecond: isRfc ? 0 : Number((match[7] || '').padEnd(3, '0')) }, zone, match[isRfc ? 7 : 9]);
}
