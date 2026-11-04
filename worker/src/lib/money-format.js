// Calendar days describe bank records, so never shift them through UTC. Only
// instants (the injected clock and sync time) use the owner's time zone.
const months = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const calendarDay = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(0); date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day } : null;
};
const localParts = (value, timeZone) => {
  if (!timeZone || value == null || value === '') return null;
  if (typeof value === 'string' && (!calendarDay(value.slice(0, 10)) ||
      (!calendarDay(value) && !/(?:Z|[+-]\d{2}:\d{2})$/.test(value)))) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(value));
    const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return { year: Number(fields.year), month: Number(fields.month), day: Number(fields.day),
      time: `${fields.hour}:${fields.minute} ${fields.dayPeriod}` };
  } catch { return null; }
};
export function moneyAccount(account = {}, { label = false } = {}) {
  account = account && typeof account === 'object' ? account : {};
  const ending = /^\d{1,4}$/.test(account.mask || '') ? `your account ending ${account.mask}` : 'your account (ending unavailable)';
  const name = label ? String(account.label || '').replace(/\d(?:[\s-]*\d){4,}/g, '[redacted]')
    .replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  return name ? `${name} (${ending})` : ending;
}
export const moneyAccounts = accounts => [...new Set(accounts.map(account => moneyAccount(account)))].join(', ');
export function moneyPresentation({ now, timeZone }) {
  const today = localParts(now, timeZone);
  const yearSuffix = day => day.year === today?.year ? '' : ` ${day.year}`;
  const month = value => { const day = calendarDay(value); return day ? `${months[day.month - 1]}${yearSuffix(day)}` : 'date unavailable'; };
  const date = value => {
    const day = calendarDay(value);
    return day ? `${months[day.month - 1]} ${day.day}${day.year === today?.year ? '' : `, ${day.year}`}` : 'date unavailable';
  };
  const period = (from, to) => {
    const start = calendarDay(from), end = calendarDay(to);
    if (!start || !end || from > to) return 'dates unavailable';
    if (from === to) return date(from);
    const last = new Date(0); last.setUTCFullYear(end.year, end.month, 0);
    if (start.day === 1 && end.day === last.getUTCDate()) {
      if (start.year === end.year && start.month === end.month) return month(from);
      return `${month(from)} through ${month(to)}`;
    }
    if (start.year === end.year && start.month === end.month)
      return `${months[start.month - 1]} ${start.day} to ${end.day}${end.year === today?.year ? '' : `, ${end.year}`}`;
    return `${date(from)} to ${date(to)}`;
  };
  const updated = value => {
    if (calendarDay(value)) return `last updated ${date(value)}`;
    const day = localParts(value, timeZone);
    if (!day) return 'last update unavailable';
    const sameDay = today && day.year === today.year && day.month === today.month && day.day === today.day;
    const text = `${months[day.month - 1]} ${day.day}${day.year === today?.year ? '' : `, ${day.year}`}`;
    return `last updated ${text}${sameDay ? ` at ${day.time}` : ''}`;
  };
  const history = accounts => {
    if (!accounts.length) return '';
    const [account] = accounts;
    const from = account.covered_from || account.empty_provider_from;
    const span = from && account.covered_to ? `from ${period(from, account.covered_to)}`
      : from ? `from ${date(from)} onward` : account.covered_to ? `through ${date(account.covered_to)} (start unknown)` : 'with dates unavailable';
    // A refusal stays readable even at the account limit. The count makes
    // the bounded display explicit; the caller keeps every machine account.
    const more = accounts.length > 1 ? `; ${accounts.length - 1} more account${accounts.length === 2 ? '' : 's'}` : '';
    return `${moneyAccount(account).replace(/^your/, 'Your')} has records ${span}, ${updated(account.last_synced_at)}${more}.`;
  };
  return { date, month, period, updated, history };
}
