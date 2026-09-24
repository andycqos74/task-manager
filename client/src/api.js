// Thin fetch wrapper for the task manager API.

// Called when the server says the session is gone, so the app can drop back to
// the login screen instead of every view throwing its own error. Set by
// App.jsx; a no-op in single-user mode, where requests never 401.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

export class ApiError extends Error {
  constructor(message, status, { offline = false } = {}) {
    super(message);
    this.status = status;
    // The server couldn't be reached at all (or, for a read, only the service
    // worker's saved copy was missing) — as opposed to it saying no.
    this.offline = offline;
  }
}

// Tells the app whether the last answer came live from the server or from the
// service worker's offline copy (sw.js marks those with X-Offline-Cache).
function reportConnection(offline) {
  window.dispatchEvent(new CustomEvent('api-connection', { detail: { offline } }));
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      // Always declared, even with no body: the server requires it on every
      // state-changing request as its CSRF defence, because a bodyless
      // cross-origin POST would otherwise be a "simple request" the browser
      // sends with our cookie attached.
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects when no response arrived at all.
    reportConnection(true);
    throw new ApiError("You're offline — that change wasn't saved. Try again once you're reconnected.", 0, { offline: true });
  }
  const cached = res.headers.get('X-Offline-Cache');
  reportConnection(!!cached);
  if (cached === 'miss') {
    throw new ApiError("You're offline and this view hasn't been saved on this device yet.", 0, { offline: true });
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let body = null;
    try {
      body = await res.json();
      if (body.error) message = body.error;
    } catch { /* keep default message */ }
    if (res.status === 401) onUnauthorized(body || {});
    throw new ApiError(message, res.status);
  }
  // 204 No Content — logout and the like.
  if (res.status === 204) return null;
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

// Dev-tracking pipeline stages for epics + user stories, with display labels
// and a CSS token driving the status badge color (see styles.css .dev-badge.*).
export const DEV_STATUSES = [
  ['backlog', 'Backlog'],
  ['in_progress', 'In progress'],
  ['in_review', 'In review'],
  ['done', 'Done'],
  ['deployed', 'Deployed'],
];
export const DEV_STATUS_LABEL = Object.fromEntries(DEV_STATUSES);

// Kanban card levels (the three draggable tiers).
export const LEVELS = [
  ['epic', 'Epics'],
  ['story', 'Stories'],
  ['task', 'Tasks'],
];

export function todayISO() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
