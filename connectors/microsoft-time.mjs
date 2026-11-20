/** Microsoft civil-time rendering. No mailbox-settings scope is required. */

// Windows names are stable labels, not fixed offsets. Intl applies the IANA
// zone's rules at the event instant, including DST and fractional-hour zones.
const WINDOWS_ZONES = Object.freeze({
  "UTC": "UTC", "Dateline Standard Time": "Etc/GMT+12", "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage", "Pacific Standard Time": "America/Los_Angeles",
  "US Mountain Standard Time": "America/Phoenix", "Mountain Standard Time": "America/Denver",
  "Central Standard Time": "America/Chicago", "Eastern Standard Time": "America/New_York",
  "US Eastern Standard Time": "America/Indianapolis", "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns", "SA Pacific Standard Time": "America/Bogota",
  "E. South America Standard Time": "America/Sao_Paulo", "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "GMT Standard Time": "Europe/London", "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin", "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest", "FLE Standard Time": "Europe/Kyiv",
  "South Africa Standard Time": "Africa/Johannesburg", "Israel Standard Time": "Asia/Jerusalem",
  "Arabian Standard Time": "Asia/Dubai", "India Standard Time": "Asia/Kolkata",
  "Nepal Standard Time": "Asia/Kathmandu", "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore", "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul", "W. Australia Standard Time": "Australia/Perth",
  "Cen. Australia Standard Time": "Australia/Adelaide", "AUS Central Standard Time": "Australia/Darwin",
  "AUS Eastern Standard Time": "Australia/Sydney", "E. Australia Standard Time": "Australia/Brisbane",
  "Tasmania Standard Time": "Australia/Hobart", "New Zealand Standard Time": "Pacific/Auckland",
});
function knownZone(value) {
  const zone = WINDOWS_ZONES[value] || value;
  if (!zone || /^(?:tzone:|Customized Time Zone)/i.test(zone)) return null;
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); return zone; } catch { return null; }
}
// Resolve a preferred zone, then a supported fallback and the machine zone.
// Timed calendar display passes the mailbox zone first; all-day recovery keeps
// the original civil-date zone. UTC is only a last-resort named fallback.
export function microsoftLocalTimeZone(original, owner = null) {
  return knownZone(original) || knownZone(owner) || knownZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";
}
function fields(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  return Object.fromEntries(parts.filter(part => part.type !== "literal").map(part => [part.type, part.value]));
}
export function microsoftLocalDateTime(instant, timeZone) {
  const date = new Date(instant);
  if (!Number.isFinite(date.getTime())) return null;
  const f = fields(date, timeZone);
  return `${f.year}-${f.month}-${f.day}T${f.hour}:${f.minute}:${f.second}`;
}
export function microsoftMailTime(value, owner) {
  const zone = microsoftLocalTimeZone(null, owner);
  const local = microsoftLocalDateTime(value, zone);
  return local ? { date: local.slice(0, 10), text: `${local.replace("T", " ")} (${zone})`, zone } : null;
}
export function microsoftEventTime(slot, targetZone) {
  if (!slot?.dateTime) return slot;
  const raw = String(slot.dateTime).replace(/(\.\d{3})\d+/, "$1");
  let instant;
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(raw)) instant = Date.parse(raw);
  else if (["UTC", "Etc/UTC", "GMT"].includes(slot.timeZone)) instant = Date.parse(`${raw}Z`);
  else {
    // A non-UTC naive response has no offset. Accept only a unique wall-time
    // interpretation. An ambiguous DST fold must never become a wrong instant.
    const sourceZone = knownZone(slot.timeZone);
    if (!sourceZone) return null;
    const wall = Date.parse(`${raw}Z`);
    const candidates = new Set();
    for (const shift of [-86400000, 0, 86400000]) {
      const probe = wall + shift;
      const offset = Date.parse(`${microsoftLocalDateTime(probe, sourceZone)}Z`) - probe;
      const candidate = wall - offset;
      if (microsoftLocalDateTime(candidate, sourceZone) === raw.split(".")[0]) candidates.add(candidate);
    }
    if (candidates.size !== 1) return null;
    instant = [...candidates][0];
  }
  const local = microsoftLocalDateTime(instant, targetZone);
  if (!local) return null;
  const offsetMinutes = Math.round((Date.parse(`${local}Z`) - instant) / 60_000);
  const offset = `${offsetMinutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0")}:${String(Math.abs(offsetMinutes) % 60).padStart(2, "0")}`;
  return { dateTime: `${local}${offset}`, timeZone: targetZone };
}
