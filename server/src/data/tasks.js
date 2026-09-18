// Task data access. Every accessor takes a scope and filters on it, so a task
// belonging to another workspace is invisible rather than merely unlinked.
import { db } from '../db.js';
import { todayISO, addDays, computeDoDate, nextOccurrence } from '../dates.js';

const TASK_SELECT = `SELECT t.*, p.name AS project_name, p.color AS project_color,
                     s.title AS story_title, s.epic_id AS epic_id, e.title AS epic_title
                     FROM tasks t
                     LEFT JOIN projects p ON p.id = t.project_id
                     LEFT JOIN user_stories s ON s.id = t.story_id
                     LEFT JOIN epics e ON e.id = s.epic_id`;

// Columns a PATCH may set. The route validates the values; this list bounds
// which columns can be reached at all, so a stray key in the request body can
// never become part of the UPDATE.
const UPDATABLE = new Set([
  'title', 'notes', 'status', 'priority', 'project_id', 'story_id', 'tags', 'recurrence',
  'due_date', 'do_date', 'do_date_is_manual', 'estimated_minutes', 'completed_at',
  'dev_stage', 'sort_order', 'my_day_date',
]);

export function hydrateTasks(rows) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const subtasks = db
    .prepare(`SELECT * FROM subtasks WHERE task_id IN (${placeholders}) ORDER BY sort_order, id`)
    .all(...ids);
  const deps = db
    .prepare(`SELECT td.task_id, td.depends_on_id, t.title AS depends_on_title, t.status AS depends_on_status
              FROM task_dependencies td JOIN tasks t ON t.id = td.depends_on_id
              WHERE td.task_id IN (${placeholders})`)
    .all(...ids);
  const dependents = db
    .prepare(`SELECT depends_on_id, task_id FROM task_dependencies WHERE depends_on_id IN (${placeholders})`)
    .all(...ids);

  const today = todayISO();
  return rows.map((r) => {
    const taskDeps = deps.filter((d) => d.task_id === r.id);
    const blocked =
      r.status !== 'done' &&
      r.status !== 'cancelled' &&
      taskDeps.some((d) => d.depends_on_status !== 'done' && d.depends_on_status !== 'cancelled');
    return {
      ...r,
      tags: JSON.parse(r.tags || '[]'),
      recurrence: r.recurrence ? JSON.parse(r.recurrence) : null,
      do_date_is_manual: !!r.do_date_is_manual,
      in_my_day: r.my_day_date === today || (r.do_date && r.do_date <= today && r.status !== 'done' && r.status !== 'cancelled'),
      blocked,
      subtasks: subtasks
        .filter((s) => s.task_id === r.id)
        .map((s) => ({ id: s.id, title: s.title, done: !!s.done, sort_order: s.sort_order })),
      dependencies: taskDeps.map((d) => ({
        id: d.depends_on_id,
        title: d.depends_on_title,
        done: d.depends_on_status === 'done' || d.depends_on_status === 'cancelled',
      })),
      dependent_ids: dependents.filter((d) => d.depends_on_id === r.id).map((d) => d.task_id),
    };
  });
}

// ---------- reads ----------

export function getTask(scope, id) {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ? AND t.workspace_id = ?`).get(id, scope.workspaceId);
  return row ? hydrateTasks([row])[0] : null;
}

// Reaches outside the active workspace, so it is only for the move endpoints:
// once a task has moved, re-reading it by the active workspace would find
// nothing. Still bounded by the owner — it joins workspaces to say so.
export function getTaskAnywhere(scope, id) {
  const row = db
    .prepare(`${TASK_SELECT} JOIN workspaces w ON w.id = t.workspace_id
              WHERE t.id = ? AND w.user_id = ?`)
    .get(id, scope.userId);
  return row ? hydrateTasks([row])[0] : null;
}

export function getTaskRow(scope, id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ? AND workspace_id = ?').get(id, scope.workspaceId) || null;
}

export function listTasks(scope, filters = {}) {
  const clauses = ['t.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (filters.projectId === 'none') {
    clauses.push('t.project_id IS NULL');
  } else if (filters.projectId) {
    clauses.push('t.project_id = ?');
    params.push(Number(filters.projectId));
  }
  if (filters.status) {
    clauses.push('t.status = ?');
    params.push(filters.status);
  } else if (!filters.includeDone) {
    clauses.push(`t.status IN ('todo','in_progress')`);
  }
  if (filters.q) {
    clauses.push('(t.title LIKE ? OR t.notes LIKE ?)');
    const like = `%${filters.q}%`;
    params.push(like, like);
  }
  const rows = db
    .prepare(`${TASK_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.due_date IS NULL, t.due_date, t.id`)
    .all(...params);
  return hydrateTasks(rows);
}

export function listOpenTasks(scope) {
  const rows = db
    .prepare(`${TASK_SELECT} WHERE t.workspace_id = ? AND t.status IN ('todo','in_progress') ORDER BY t.id`)
    .all(scope.workspaceId);
  return hydrateTasks(rows);
}

export function listGanttTasks(scope, projectId) {
  const clauses = ['t.workspace_id = ?', `t.status IN ('todo','in_progress','done')`];
  const params = [scope.workspaceId];
  if (projectId) {
    clauses.push('t.project_id = ?');
    params.push(Number(projectId));
  }
  const rows = db
    .prepare(`${TASK_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.project_id, t.do_date, t.due_date`)
    .all(...params);
  return hydrateTasks(rows);
}

// Tasks hanging off any story of a project, for the project's Development tab.
export function listProjectStoryTasks(scope, projectId) {
  const rows = db
    .prepare(`${TASK_SELECT} WHERE t.workspace_id = ? AND t.story_id IN
        (SELECT s.id FROM user_stories s JOIN epics e ON e.id = s.epic_id WHERE e.project_id = ?) ORDER BY t.id`)
    .all(scope.workspaceId, projectId);
  return hydrateTasks(rows);
}

export function listBoardTasks(scope, { projectId = null, q = null } = {}) {
  const where = ['t.workspace_id = ?', `t.status != 'cancelled'`];
  const params = [scope.workspaceId];
  if (projectId) { where.push('t.project_id = ?'); params.push(projectId); }
  if (q) { where.push('(t.title LIKE ? OR t.notes LIKE ?)'); params.push(q, q); }
  return db.prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.sort_order, t.id`).all(...params);
}

export function countDoneOn(scope, date) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND status = 'done' AND date(completed_at) = ?`)
    .get(scope.workspaceId, date).n;
}

export function listOpenTags(scope) {
  const rows = db
    .prepare(`SELECT tags FROM tasks WHERE workspace_id = ? AND status IN ('todo','in_progress')`)
    .all(scope.workspaceId);
  const all = new Set();
  for (const r of rows) for (const t of JSON.parse(r.tags || '[]')) all.add(t);
  return [...all].sort();
}

// ---------- writes ----------

export function createTask(scope, fields) {
  return db
    .prepare(`INSERT INTO tasks (workspace_id, project_id, story_id, title, notes, status, priority, due_date, do_date,
              do_date_is_manual, estimated_minutes, my_day_date, tags, recurrence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      scope.workspaceId,
      fields.project_id ?? null,
      fields.story_id ?? null,
      fields.title,
      fields.notes ?? '',
      fields.status ?? 'todo',
      fields.priority ?? 'medium',
      fields.due_date ?? null,
      fields.do_date ?? null,
      fields.do_date_is_manual ? 1 : 0,
      fields.estimated_minutes ?? null,
      fields.my_day_date ?? null,
      fields.tags ?? '[]',
      fields.recurrence ?? null,
    ).lastInsertRowid;
}

export function updateTask(scope, id, updates) {
  const keys = Object.keys(updates).filter((k) => UPDATABLE.has(k));
  if (keys.length === 0) return 0;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  return db
    .prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(...keys.map((k) => updates[k]), id, scope.workspaceId).changes;
}

export function deleteTask(scope, id) {
  return db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(id, scope.workspaceId).changes;
}

export function setMyDay(scope, id, on) {
  return db
    .prepare(`UPDATE tasks SET my_day_date = ?, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(on ? todayISO() : null, id, scope.workspaceId).changes;
}

// Move one task to another workspace. Its project and story live in the old
// workspace, so those links are cleared unless `projectId` names a project in
// the destination. Notes attached to the task travel with it; dependencies on
// tasks left behind are dropped.
export function moveTaskToWorkspace(scope, task, targetId, projectId) {
  const counts = { notes: 0, dropped_dependencies: 0 };
  if (task.workspace_id === targetId) return counts;
  db.transaction(() => {
    counts.dropped_dependencies = db
      .prepare('DELETE FROM task_dependencies WHERE task_id = ? OR depends_on_id = ?')
      .run(task.id, task.id).changes;
    counts.notes = db
      .prepare(`UPDATE notes SET workspace_id = ?, updated_at = datetime('now') WHERE task_id = ?`)
      .run(targetId, task.id).changes;
    db.prepare(`UPDATE tasks SET workspace_id = ?, project_id = ?, story_id = NULL, updated_at = datetime('now')
                WHERE id = ?`)
      .run(targetId, projectId, task.id);
  })();
  return counts;
}

// Create the next instance of a recurring task when it is completed. The copy
// stays in the workspace the original lives in.
export function spawnRecurrence(scope, task, workdayMinutes) {
  return db.transaction(() => spawnRecurrenceRow(task, workdayMinutes))();
}

function spawnRecurrenceRow(task, workdayMinutes) {
  const rule = task.recurrence;
  const baseDue = task.due_date || todayISO();
  const nextDue = nextOccurrence(baseDue, rule);
  if (!nextDue) return null;
  const nextDo = task.do_date_is_manual && task.do_date && task.due_date
    ? addDays(nextDue, -Math.max(0, Math.round((new Date(task.due_date) - new Date(task.do_date)) / 86400000)))
    : computeDoDate(nextDue, task.estimated_minutes, workdayMinutes);
  const newId = db
    .prepare(`INSERT INTO tasks (workspace_id, project_id, title, notes, status, priority, due_date, do_date,
              do_date_is_manual, estimated_minutes, tags, recurrence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      task.workspace_id,
      task.project_id,
      task.title,
      task.notes,
      'todo',
      task.priority,
      nextDue,
      nextDo,
      task.do_date_is_manual ? 1 : 0,
      task.estimated_minutes,
      JSON.stringify(task.tags),
      JSON.stringify(rule),
    ).lastInsertRowid;
  const copySub = db.prepare('INSERT INTO subtasks (task_id, title, done, sort_order) VALUES (?,?,0,?)');
  for (const s of task.subtasks) copySub.run(newId, s.title, s.sort_order);
  return newId;
}

// ---------- subtasks ----------
// Reached only through their task, which is ownership-checked first.

export function addSubtask(scope, taskId, title) {
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM subtasks WHERE task_id = ?').get(taskId).m;
  db.prepare('INSERT INTO subtasks (task_id, title, sort_order) VALUES (?,?,?)').run(taskId, title, max + 1);
}

export function getSubtask(scope, id) {
  return db
    .prepare(`SELECT s.* FROM subtasks s JOIN tasks t ON t.id = s.task_id
              WHERE s.id = ? AND t.workspace_id = ?`)
    .get(id, scope.workspaceId) || null;
}

export function updateSubtask(scope, sub, updates) {
  if ('title' in updates) db.prepare('UPDATE subtasks SET title = ? WHERE id = ?').run(updates.title, sub.id);
  if ('done' in updates) db.prepare('UPDATE subtasks SET done = ? WHERE id = ?').run(updates.done ? 1 : 0, sub.id);
}

export function deleteSubtask(scope, sub) {
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(sub.id);
}

// ---------- dependencies ----------

// Which of these ids are tasks the caller can see. Used to reject a dependency
// on a task in another workspace, which a move would have to drop anyway.
export function existingTaskIds(scope, ids) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db
    .prepare(`SELECT id FROM tasks WHERE workspace_id = ? AND id IN (${placeholders})`)
    .all(scope.workspaceId, ...ids)
    .map((r) => r.id);
}

export function wouldCreateCycle(scope, taskId, dependsOnIds) {
  // DFS from each new dependency; if we can reach taskId, adding the edge cycles.
  const edges = db
    .prepare(`SELECT td.task_id, td.depends_on_id FROM task_dependencies td
              JOIN tasks t ON t.id = td.task_id
              WHERE t.workspace_id = ? AND td.task_id != ?`)
    .all(scope.workspaceId, taskId);
  const graph = new Map();
  for (const e of edges) {
    if (!graph.has(e.task_id)) graph.set(e.task_id, []);
    graph.get(e.task_id).push(e.depends_on_id);
  }
  const stack = [...dependsOnIds];
  const seen = new Set();
  while (stack.length) {
    const node = stack.pop();
    if (node === taskId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of graph.get(node) || []) stack.push(next);
  }
  return false;
}

export function setDependencies(scope, taskId, ids) {
  db.transaction(() => {
    db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(taskId);
    const ins = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?,?)');
    for (const id of ids) ins.run(taskId, id);
  })();
}
