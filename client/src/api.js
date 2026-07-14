// Thin fetch wrapper for the task manager API.

async function request(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch { /* keep default message */ }
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  delete: (path) => request('DELETE', path),
};

// Parse a human TTC string like "2h", "90m", "1d 2h", "1:30" into minutes.
export function parseEstimate(input, workdayMinutes = 480) {
  if (!input || !input.trim()) return null;
  const s = input.trim().toLowerCase();
  const clock = s.match(/^(\d+):(\d{2})$/);
  if (clock) return parseInt(clock[1], 10) * 60 + parseInt(clock[2], 10);
  let minutes = 0;
  let matched = false;
  const re = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes)\b/g;
  let m;
  while ((m = re.exec(s))) {
    matched = true;
    const value = parseFloat(m[1]);
    if (m[2].startsWith('d')) minutes += value * workdayMinutes;
    else if (m[2].startsWith('h')) minutes += value * 60;
    else minutes += value;
  }
  if (!matched) {
    const bare = parseFloat(s);
    if (!Number.isNaN(bare)) return Math.round(bare * 60); // bare number = hours
    return null;
  }
  return Math.round(minutes);
}

export function formatEstimate(minutes, workdayMinutes = 480) {
  if (!minutes) return '';
  const parts = [];
  let rest = minutes;
  if (rest >= workdayMinutes) {
    parts.push(`${Math.floor(rest / workdayMinutes)}d`);
    rest %= workdayMinutes;
  }
  if (rest >= 60) {
    parts.push(`${Math.floor(rest / 60)}h`);
    rest %= 60;
  }
  if (rest > 0) parts.push(`${rest}m`);
  return parts.join(' ');
}

export function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((date - today) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff === -1) return 'Yesterday';
  if (diff > 1 && diff < 7) return date.toLocaleDateString(undefined, { weekday: 'long' });
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: y === today.getFullYear() ? undefined : 'numeric' });
}

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 };
const NO_DATE = '9999-99-99'; // sorts after any real ISO date

export const TASK_SORTS = [
  ['due_date', 'Due date'],
  ['do_date', 'Do date'],
  ['priority', 'Priority'],
  ['created', 'Recently added'],
  ['title', 'Title (A–Z)'],
];

export function sortTasks(tasks, sort) {
  const arr = [...tasks];
  switch (sort) {
    case 'priority':
      return arr.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9));
    case 'do_date':
      return arr.sort((a, b) => (a.do_date || NO_DATE).localeCompare(b.do_date || NO_DATE));
    case 'created':
      return arr.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
    case 'title':
      return arr.sort((a, b) => a.title.localeCompare(b.title));
    case 'due_date':
    default:
      return arr.sort((a, b) => (a.due_date || NO_DATE).localeCompare(b.due_date || NO_DATE));
  }
}

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
