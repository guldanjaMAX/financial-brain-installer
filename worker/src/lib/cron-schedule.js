const FIELDS = Object.freeze([
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "weekday", min: 0, max: 7, normalize: (value) => value === 7 ? 0 : value },
]);

function expandField(text, field) {
  const raw = String(text || "").trim();
  if (!raw) throw new TypeError(`missing cron ${field.name}`);
  const values = new Set();
  for (const segment of raw.split(",")) {
    const pieces = segment.split("/");
    if (pieces.length > 2 || (pieces.length === 2 && !/^\d+$/.test(pieces[1]))) {
      throw new TypeError(`invalid cron ${field.name}`);
    }
    const step = Number(pieces[1] || 1);
    if (step < 1) throw new TypeError(`invalid cron ${field.name}`);
    const base = pieces[0];
    let start;
    let end;
    if (base === "*") {
      start = field.min;
      end = field.max;
    } else if (/^\d+-\d+$/.test(base)) {
      [start, end] = base.split("-").map(Number);
    } else if (/^\d+$/.test(base)) {
      start = Number(base);
      end = pieces.length === 2 ? field.max : start;
    } else {
      throw new TypeError(`invalid cron ${field.name}`);
    }
    if (start < field.min || end > field.max || start > end) {
      throw new TypeError(`invalid cron ${field.name}`);
    }
    for (let value = start; value <= end; value += step) {
      values.add(field.normalize ? field.normalize(value) : value);
    }
  }
  return { values, wildcard: raw.startsWith("*") };
}

function parseCron(expression) {
  const pieces = String(expression || "").trim().split(/\s+/).filter(Boolean);
  if (pieces.length !== 5) throw new TypeError("schedule_cron must be a five-field cron expression");
  return pieces.map((piece, index) => expandField(piece, FIELDS[index]));
}

function formatterFor(timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    throw new TypeError("schedule_timezone must be a valid IANA time zone");
  }
}

function partsAt(formatter, timestamp) {
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp))
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function sameLocalMinute(left, right) {
  return left.year === right.year && left.month === right.month && left.day === right.day &&
    left.hour === right.hour && left.minute === right.minute;
}

function utcCandidatesForLocal(local, formatter) {
  const nominal = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = nominal + hours * 3_600_000;
    const parts = partsAt(formatter, sample);
    const represented = Date.UTC(
      parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second,
    );
    offsets.add(represented - sample);
  }
  return [...offsets]
    .map((offset) => nominal - offset)
    .filter((candidate) => sameLocalMinute(partsAt(formatter, candidate), local))
    .sort((left, right) => left - right);
}

/** Return the next actual firing after `afterMs` in the scheduler machine's timezone. */
export function nextCronFiring(expression, { afterMs = Date.now(), timeZone } = {}) {
  if (!Number.isFinite(afterMs)) throw new TypeError("afterMs must be a finite timestamp");
  const zone = String(timeZone || "");
  if (!zone || zone.length > 128) throw new TypeError("schedule_timezone must be a valid IANA time zone");
  const formatter = formatterFor(zone);
  const [minute, hour, day, month, weekday] = parseCron(expression);
  const afterLocal = partsAt(formatter, afterMs);
  const firstDay = Date.UTC(afterLocal.year, afterLocal.month - 1, afterLocal.day);
  const times = [...hour.values].sort((a, b) => a - b).flatMap((hourValue) =>
    [...minute.values].sort((a, b) => a - b).map((minuteValue) => ({
      hour: hourValue,
      minute: minuteValue,
    }))
  );

  // A valid five-field cron can need eight years to reach the next leap-day
  // firing across a non-leap century. Scheduler installation separately
  // rejects expressions with no firing in the full Gregorian cycle.
  for (let dayOffset = 0; dayOffset <= 366 * 8 + 2; dayOffset++) {
    const date = new Date(firstDay + dayOffset * 86_400_000);
    const monthMatches = month.values.has(date.getUTCMonth() + 1);
    const domMatches = day.values.has(date.getUTCDate());
    const dowMatches = weekday.values.has(date.getUTCDay());
    const dateMatches = !day.wildcard && !weekday.wildcard
      ? domMatches || dowMatches
      : domMatches && dowMatches;
    if (!monthMatches || !dateMatches) continue;
    for (const time of times) {
      const local = {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
        ...time,
      };
      for (const candidate of utcCandidatesForLocal(local, formatter)) {
        if (candidate > afterMs) return new Date(candidate).toISOString();
      }
    }
  }
  return null;
}

export function scheduleMetadataFromDetail(detail) {
  if (typeof detail !== "string" || !detail.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(detail);
    if (typeof parsed?.schedule_cron !== "string" || typeof parsed?.schedule_timezone !== "string") return null;
    return {
      cron: parsed.schedule_cron,
      timeZone: parsed.schedule_timezone,
    };
  } catch {
    return null;
  }
}
