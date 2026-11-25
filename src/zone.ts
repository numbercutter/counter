const OFFSET = /^([+-])(\d{2}):(\d{2})$/;
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const formats = new Map<string, Intl.DateTimeFormat>();

export { WEEKDAYS };

export function isZone(zone: string) {
  if (OFFSET.test(zone)) return true;
  try {
    formatter(zone);
    return true;
  } catch {
    return false;
  }
}

function formatter(zone: string) {
  let f = formats.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formats.set(zone, f);
  }
  return f;
}

function fixedOffset(zone: string) {
  const m = OFFSET.exec(zone);
  if (!m) return null;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function offsetMinutes(ms: number, zone: string) {
  const fixed = fixedOffset(zone);
  if (fixed !== null) return fixed;
  const p = Object.fromEntries(formatter(zone).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60000);
}

export function wallClock(ms: number, zone: string) {
  const local = new Date(ms + offsetMinutes(ms, zone) * 60000);
  return {
    date: local.toISOString().slice(0, 10),
    hour: local.getUTCHours(),
    weekday: (local.getUTCDay() + 6) % 7,
  };
}

export function startOfDay(day: string, zone: string) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  const first = guess - offsetMinutes(guess, zone) * 60000;
  return guess - offsetMinutes(first, zone) * 60000;
}

export function addDays(day: string, n: number) {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export function weekStart(day: string) {
  const shift = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -shift);
}
