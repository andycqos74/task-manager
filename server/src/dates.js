// Date helpers. All dates are ISO strings (YYYY-MM-DD), interpreted in the
// server's local timezone since this is a single-user tool.

export function todayISO(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return todayISO(dt);
}

export function diffDays(fromISO, toISO) {
  const [fy, fm, fd] = fromISO.split('-').map(Number);
  const [ty, tm, td] = toISO.split('-').map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  return Math.round((to - from) / 86400000);
}

export function isValidISODate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

// Default Do Date rule: Due Date minus Estimated TTC.
// TTC is stored in minutes; it is converted to working days (rounded up
// against the configured workday length) so a 2h task defaults to starting
// one day before it is due, a 2-day task two days before, etc.
// No due date -> no default do date. No estimate -> do date = due date.
export function computeDoDate(dueDate, estimatedMinutes, workdayMinutes = 480) {
  if (!dueDate) return null;
  if (!estimatedMinutes || estimatedMinutes <= 0) return dueDate;
  const leadDays = Math.ceil(estimatedMinutes / workdayMinutes);
  return addDays(dueDate, -leadDays);
}

// Advance a recurrence rule from a base date. rule = { freq, interval }
export function nextOccurrence(baseISO, rule) {
  const interval = Math.max(1, rule.interval || 1);
  if (rule.freq === 'daily') return addDays(baseISO, interval);
  if (rule.freq === 'weekly') return addDays(baseISO, 7 * interval);
  if (rule.freq === 'monthly') {
    const [y, m, d] = baseISO.split('-').map(Number);
    const dt = new Date(y, m - 1 + interval, 1);
    // Clamp day-of-month so Jan 31 + 1 month -> Feb 28, not Mar 3.
    const lastDay = new Date(dt.getFullYear(), dt.getMonth() + 1, 0).getDate();
    dt.setDate(Math.min(d, lastDay));
    return todayISO(dt);
  }
  return null;
}
