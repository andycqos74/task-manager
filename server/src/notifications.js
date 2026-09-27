// The in-app notification feed behind the header bell.
//
// Notifications are derived, not stored: they are whatever needs attention
// right now across all of the person's workspaces — the same things the
// morning push digest summarises (see push.js), listed one by one. Only what
// has been *seen* is stored: a per-user list of item keys. A key includes the
// date it applies to, so a task that was "due today" and is now "overdue"
// comes back as new.
import { todayISO } from './dates.js';
import { getSettings, setSetting } from './data/settings.js';
import * as Workspaces from './data/workspaces.js';
import * as Tasks from './data/tasks.js';

const READ_KEY = 'notifications_read';
const MAX_ITEMS = 50;
const KIND_ORDER = { overdue: 0, due_today: 1, starts_today: 2 };

function readKeys(scope) {
  try {
    const keys = JSON.parse(getSettings(scope)[READ_KEY] || '[]');
    return new Set(Array.isArray(keys) ? keys : []);
  } catch {
    return new Set();
  }
}

// Everything currently needing attention, newest-kind-first, unread flagged.
export function listNotifications(scope, today = todayISO()) {
  const items = [];
  for (const ws of Workspaces.listWorkspaces(scope)) {
    for (const t of Tasks.listOpenTasks({ userId: scope.userId, workspaceId: ws.id })) {
      let kind = null;
      let on = null;
      if (t.due_date && t.due_date < today) { kind = 'overdue'; on = t.due_date; }
      else if (t.due_date === today) { kind = 'due_today'; on = today; }
      else if (t.do_date === today) { kind = 'starts_today'; on = today; }
      if (!kind) continue;
      items.push({
        key: `${kind}:${t.id}:${on}`,
        kind,
        task_id: t.id,
        title: t.title,
        priority: t.priority,
        due_date: t.due_date,
        do_date: t.do_date,
        project_name: t.project_name,
        project_color: t.project_color,
        workspace_id: ws.id,
        workspace_name: ws.name,
      });
    }
  }
  items.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]
    || (a.due_date || '').localeCompare(b.due_date || '') || a.task_id - b.task_id);

  const read = readKeys(scope);
  const shown = items.slice(0, MAX_ITEMS).map((i) => ({ ...i, read: read.has(i.key) }));
  return {
    date: today,
    total: items.length,
    unread: items.filter((i) => !read.has(i.key)).length,
    items: shown,
  };
}

// Mark keys as seen (all current ones when `keys` is omitted). Only keys that
// are still current are kept, so the stored list never outgrows the feed.
export function markRead(scope, keys = null, today = todayISO()) {
  const current = listNotifications(scope, today);
  const currentKeys = new Set(current.items.map((i) => i.key));
  const read = readKeys(scope);
  for (const k of keys ?? currentKeys) if (currentKeys.has(k)) read.add(k);
  setSetting(scope, READ_KEY, JSON.stringify([...read].filter((k) => currentKeys.has(k))));
  return listNotifications(scope, today);
}
