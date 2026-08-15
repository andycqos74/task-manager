import { Router } from 'express';
import { db, getSettings, setSetting, deleteSetting, activeWorkspaceId, seedBoard } from './db.js';
import { todayISO, addDays, computeDoDate, nextOccurrence, isValidISODate } from './dates.js';
import { rankTasks } from './scoring.js';
import { aiAvailable, planMyDay, prioritise } from './ai.js';

export const router = Router();

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'];
const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'archived'];
// Pipeline stages for the dev-tracking tiers (epics + user stories).
const DEV_STATUSES = ['backlog', 'in_progress', 'in_review', 'done', 'deployed'];
const IDEA_STATUSES = ['open', 'promoted', 'archived'];
const IDEA_KINDS = ['idea', 'bug'];
const CARD_TYPES = ['epic', 'story', 'task'];

// Tasks carry both a `status` (todo/in_progress/done/cancelled, used by My Day,
// scoring and the task lists) and a finer-grained kanban `dev_stage`. These keep
// the two consistent whichever one the user changes.
function statusFromStage(stage) {
  if (stage === 'done' || stage === 'deployed') return 'done';
  if (stage === 'in_progress' || stage === 'in_review') return 'in_progress';
  return 'todo';
}
function stageFromStatus(status) {
  if (status === 'done') return 'done';
  if (status === 'in_progress') return 'in_progress';
  return 'backlog';
}
const DEV_TAG = 'development';

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// ---------- task loading helpers ----------

function hydrateTasks(rows) {
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

const TASK_SELECT = `SELECT t.*, p.name AS project_name, p.color AS project_color,
                     s.title AS story_title, s.epic_id AS epic_id, e.title AS epic_title
                     FROM tasks t
                     LEFT JOIN projects p ON p.id = t.project_id
                     LEFT JOIN user_stories s ON s.id = t.story_id
                     LEFT JOIN epics e ON e.id = s.epic_id`;

// Resolve a story to its owning project (via its epic). Returns the row
// { id, project_id } or null (story not found). Used when a task is linked
// to a story so the task inherits the right project.
function storyOwner(storyId) {
  return db
    .prepare('SELECT s.id, e.project_id FROM user_stories s JOIN epics e ON e.id = s.epic_id WHERE s.id = ?')
    .get(storyId);
}

function getEpic(id) {
  return db
    .prepare(`SELECT e.*, p.name AS project_name, p.color AS project_color,
        (SELECT COUNT(*) FROM user_stories s WHERE s.epic_id = e.id) AS story_count,
        (SELECT COUNT(*) FROM tasks t JOIN user_stories s ON s.id = t.story_id WHERE s.epic_id = e.id) AS task_count
      FROM epics e LEFT JOIN projects p ON p.id = e.project_id WHERE e.id = ?`)
    .get(id);
}

function getStory(id) {
  return db
    .prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id AND t.status = 'done') AS done_count
      FROM user_stories s WHERE s.id = ?`)
    .get(id);
}

function getTask(id) {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  return row ? hydrateTasks([row])[0] : null;
}

function listOpenTasks() {
  const rows = db
    .prepare(`${TASK_SELECT} WHERE t.workspace_id = ? AND t.status IN ('todo','in_progress') ORDER BY t.id`)
    .all(activeWorkspaceId());
  return hydrateTasks(rows);
}

// ---------- workspaces ----------
// The top level: every project, task, note, idea/bug, epic and board belongs to
// exactly one. Settings (incl. the AI key) and the scratch pad stay global.

router.get('/workspaces', (req, res) => {
  res.json({
    active_id: activeWorkspaceId(),
    workspaces: db.prepare('SELECT * FROM workspaces ORDER BY sort_order, id').all(),
  });
});

router.post('/workspaces', (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'name is required');
  const ws = db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM workspaces').get().m;
    const id = db.prepare('INSERT INTO workspaces (name, color, sort_order) VALUES (?,?,?)')
      .run(String(b.name).trim(), b.color || 'oklch(60% 0.13 66)', max + 1).lastInsertRowid;
    seedBoard(id); // every workspace starts with its own default board
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  })();
  res.status(201).json(ws);
});

router.patch('/workspaces/:id', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  const b = req.body || {};
  if ('name' in b && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
  const updates = {};
  if ('name' in b) updates.name = String(b.name).trim();
  if ('color' in b) updates.color = b.color;
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) db.prepare(`UPDATE workspaces SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), ws.id);
  res.json(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id));
});

// Deleting a workspace removes everything inside it (FK cascade).
router.delete('/workspaces/:id', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  if (db.prepare('SELECT COUNT(*) AS c FROM workspaces').get().c <= 1) {
    return badRequest(res, 'cannot delete the only workspace');
  }
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
  res.json({ ok: true, active_id: activeWorkspaceId() }); // self-heals if the active one went
});

router.post('/workspaces/:id/activate', (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.params.id);
  if (!ws) return res.status(404).json({ error: 'workspace not found' });
  setSetting('active_workspace_id', ws.id);
  res.json({ active_id: ws.id, workspace: ws });
});

// ---------- projects ----------

router.get('/projects', (req, res) => {
  const projects = db
    .prepare(`SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_tasks
      FROM projects p WHERE p.workspace_id = ? ORDER BY p.status = 'archived', p.name`)
    .all(activeWorkspaceId());
  res.json(projects);
});

router.post('/projects', (req, res) => {
  const { name, description = '', status = 'active', color = '#5b7c99', start_date = null, target_date = null } = req.body || {};
  if (!name || !String(name).trim()) return badRequest(res, 'name is required');
  if (!PROJECT_STATUSES.includes(status)) return badRequest(res, 'invalid status');
  for (const d of [start_date, target_date]) if (d != null && !isValidISODate(d)) return badRequest(res, 'invalid date');
  const info = db
    .prepare('INSERT INTO projects (workspace_id, name, description, status, color, start_date, target_date) VALUES (?,?,?,?,?,?,?)')
    .run(activeWorkspaceId(), String(name).trim(), description, status, color, start_date, target_date);
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const allowed = ['name', 'description', 'status', 'color', 'start_date', 'target_date'];
  const updates = {};
  for (const key of allowed) if (key in (req.body || {})) updates[key] = req.body[key];
  if ('track_dev' in (req.body || {})) updates.track_dev = req.body.track_dev ? 1 : 0;
  if ('status' in updates && !PROJECT_STATUSES.includes(updates.status)) return badRequest(res, 'invalid status');
  for (const key of ['start_date', 'target_date'])
    if (key in updates && updates[key] != null && !isValidISODate(updates[key])) return badRequest(res, 'invalid date');
  if ('name' in updates && !String(updates.name).trim()) return badRequest(res, 'name cannot be empty');
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) {
    db.prepare(`UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
      ...Object.values(updates),
      project.id,
    );
  }
  res.json(db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id));
});

router.delete('/projects/:id', (req, res) => {
  const mode = req.query.tasks === 'delete' ? 'delete' : 'keep';
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  db.transaction(() => {
    if (mode === 'delete') db.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(project.id);
  })();
  res.json({ ok: true });
});

// ---------- tasks ----------

router.get('/tasks', (req, res) => {
  const clauses = ['t.workspace_id = ?'];
  const params = [activeWorkspaceId()];
  if (req.query.project_id === 'none') {
    clauses.push('t.project_id IS NULL');
  } else if (req.query.project_id) {
    clauses.push('t.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  if (req.query.status) {
    clauses.push('t.status = ?');
    params.push(req.query.status);
  } else if (req.query.include_done !== '1') {
    clauses.push(`t.status IN ('todo','in_progress')`);
  }
  if (req.query.q) {
    clauses.push('(t.title LIKE ? OR t.notes LIKE ?)');
    const like = `%${req.query.q}%`;
    params.push(like, like);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db.prepare(`${TASK_SELECT} ${where} ORDER BY t.due_date IS NULL, t.due_date, t.id`).all(...params);
  let tasks = hydrateTasks(rows);
  if (req.query.tag) tasks = tasks.filter((t) => t.tags.includes(req.query.tag));
  res.json(tasks);
});

function normaliseTags(tags) {
  if (!Array.isArray(tags)) return null;
  return [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
}

function validateRecurrence(rec) {
  if (rec == null) return null;
  if (typeof rec !== 'object' || !['daily', 'weekly', 'monthly'].includes(rec.freq)) return undefined;
  const interval = Number.isInteger(rec.interval) && rec.interval > 0 ? rec.interval : 1;
  return { freq: rec.freq, interval };
}

// Quick add: only `title` is required. Everything else is optional detail.
router.post('/tasks', (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.priority && !PRIORITIES.includes(b.priority)) return badRequest(res, 'invalid priority');
  if (b.status && !TASK_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  for (const key of ['due_date', 'do_date'])
    if (b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  const recurrence = validateRecurrence(b.recurrence);
  if (recurrence === undefined) return badRequest(res, 'invalid recurrence');
  const tags = normaliseTags(b.tags) || [];
  const settings = getSettings();

  // A task linked to a user story is a dev task: it inherits the story's
  // project and gets the "development" tag so it stays findable in the
  // ordinary task lists while being clearly separated.
  let projectId = b.project_id || null;
  let storyId = null;
  if (b.story_id != null) {
    const story = storyOwner(b.story_id);
    if (!story) return badRequest(res, 'story not found');
    storyId = story.id;
    projectId = story.project_id;
    if (!tags.includes(DEV_TAG)) tags.push(DEV_TAG);
  }

  const dueDate = b.due_date || null;
  const manual = b.do_date != null;
  const doDate = manual ? b.do_date : computeDoDate(dueDate, b.estimated_minutes, settings.workday_minutes);

  const info = db
    .prepare(`INSERT INTO tasks (workspace_id, project_id, story_id, title, notes, status, priority, due_date, do_date, do_date_is_manual,
              estimated_minutes, my_day_date, tags, recurrence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      activeWorkspaceId(),
      projectId,
      storyId,
      String(b.title).trim(),
      b.notes || '',
      b.status || 'todo',
      b.priority || 'medium',
      dueDate,
      doDate,
      manual ? 1 : 0,
      Number.isInteger(b.estimated_minutes) && b.estimated_minutes > 0 ? b.estimated_minutes : null,
      b.my_day ? todayISO() : null,
      JSON.stringify(tags),
      recurrence ? JSON.stringify(recurrence) : null,
    );
  res.status(201).json(getTask(info.lastInsertRowid));
});

router.get('/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  res.json(task);
});

// Create the next instance of a recurring task when it is completed.
function spawnRecurrence(task) {
  const rule = task.recurrence;
  const settings = getSettings();
  const baseDue = task.due_date || todayISO();
  const nextDue = nextOccurrence(baseDue, rule);
  if (!nextDue) return;
  const nextDo = task.do_date_is_manual && task.do_date && task.due_date
    ? addDays(nextDue, -Math.max(0, Math.round((new Date(task.due_date) - new Date(task.do_date)) / 86400000)))
    : computeDoDate(nextDue, task.estimated_minutes, settings.workday_minutes);
  const info = db
    .prepare(`INSERT INTO tasks (workspace_id, project_id, title, notes, status, priority, due_date, do_date, do_date_is_manual,
              estimated_minutes, tags, recurrence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      task.workspace_id, // the recurrence stays where the original task lives
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
    );
  const newId = info.lastInsertRowid;
  const copySub = db.prepare('INSERT INTO subtasks (task_id, title, done, sort_order) VALUES (?,?,0,?)');
  for (const s of task.subtasks) copySub.run(newId, s.title, s.sort_order);
  return newId;
}

router.patch('/tasks/:id', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const b = req.body || {};
  const settings = getSettings();

  if ('priority' in b && !PRIORITIES.includes(b.priority)) return badRequest(res, 'invalid priority');
  if ('status' in b && !TASK_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if ('dev_stage' in b && !DEV_STATUSES.includes(b.dev_stage)) return badRequest(res, 'invalid dev_stage');
  for (const key of ['due_date', 'do_date'])
    if (key in b && b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');

  const updates = {};
  for (const key of ['title', 'notes', 'status', 'priority', 'project_id']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);

  // Keep dev_stage and status in step. An explicit value for one derives the
  // other, unless the caller set both. 'cancelled' is never inferred away.
  if ('dev_stage' in b) {
    updates.dev_stage = b.dev_stage;
    if (!('status' in b) && task.status !== 'cancelled') {
      const derived = statusFromStage(b.dev_stage);
      if (derived !== task.status) updates.status = derived;
    }
  } else if ('status' in b && b.status !== 'cancelled') {
    const derived = stageFromStatus(b.status);
    // Preserve the finer stage when it already agrees with the new status
    // (e.g. in_review stays in_review when status stays in_progress).
    if (statusFromStage(task.dev_stage) !== b.status) updates.dev_stage = derived;
  }

  if ('tags' in b) {
    const tags = normaliseTags(b.tags);
    if (!tags) return badRequest(res, 'tags must be an array');
    updates.tags = JSON.stringify(tags);
  }

  // Linking/unlinking a user story. Linking makes it a dev task: inherit the
  // story's project (unless project_id was also passed explicitly) and add the
  // "development" tag. Unlinking (story_id: null) just clears the link.
  if ('story_id' in b) {
    if (b.story_id == null) {
      updates.story_id = null;
    } else {
      const story = storyOwner(b.story_id);
      if (!story) return badRequest(res, 'story not found');
      updates.story_id = story.id;
      if (!('project_id' in updates)) updates.project_id = story.project_id;
      const currentTags = 'tags' in updates ? JSON.parse(updates.tags) : task.tags;
      if (!currentTags.includes(DEV_TAG)) updates.tags = JSON.stringify([...currentTags, DEV_TAG]);
    }
  }
  if ('recurrence' in b) {
    const rec = validateRecurrence(b.recurrence);
    if (rec === undefined) return badRequest(res, 'invalid recurrence');
    updates.recurrence = rec ? JSON.stringify(rec) : null;
  }
  if ('estimated_minutes' in b) {
    updates.estimated_minutes =
      Number.isInteger(b.estimated_minutes) && b.estimated_minutes > 0 ? b.estimated_minutes : null;
  }
  if ('due_date' in b) updates.due_date = b.due_date;

  // Do Date rules: setting it directly makes it manual; passing
  // do_date_is_manual=false resets it to the computed default.
  let manual = task.do_date_is_manual;
  if ('do_date' in b) {
    updates.do_date = b.do_date;
    manual = b.do_date != null;
  }
  if (b.do_date_is_manual === false) manual = false;

  const newDue = 'due_date' in updates ? updates.due_date : task.due_date;
  const newEst = 'estimated_minutes' in updates ? updates.estimated_minutes : task.estimated_minutes;
  if (!manual) {
    updates.do_date = computeDoDate(newDue, newEst, settings.workday_minutes);
  }
  updates.do_date_is_manual = manual ? 1 : 0;

  // Completion bookkeeping + recurrence.
  let spawnedId = null;
  if ('status' in updates && updates.status !== task.status) {
    if (updates.status === 'done') {
      updates.completed_at = new Date().toISOString();
      if (task.recurrence) spawnedId = db.transaction(() => spawnRecurrence(task))();
    } else {
      updates.completed_at = null;
    }
  }

  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) {
    db.prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
      ...Object.values(updates),
      task.id,
    );
  }
  const result = getTask(task.id);
  if (spawnedId) result.spawned_task = getTask(spawnedId);
  res.json(result);
});

router.delete('/tasks/:id', (req, res) => {
  const info = db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'task not found' });
  res.json({ ok: true });
});

// One-click My Day toggle.
router.post('/tasks/:id/my-day', (req, res) => {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const on = (req.body || {}).on !== false;
  db.prepare(`UPDATE tasks SET my_day_date = ?, updated_at = datetime('now') WHERE id = ?`).run(
    on ? todayISO() : null,
    task.id,
  );
  res.json(getTask(task.id));
});

// ---------- subtasks ----------

router.post('/tasks/:id/subtasks', (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const title = String((req.body || {}).title || '').trim();
  if (!title) return badRequest(res, 'title is required');
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM subtasks WHERE task_id = ?').get(task.id).m;
  db.prepare('INSERT INTO subtasks (task_id, title, sort_order) VALUES (?,?,?)').run(task.id, title, max + 1);
  res.status(201).json(getTask(task.id));
});

router.patch('/subtasks/:id', (req, res) => {
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'subtask not found' });
  const b = req.body || {};
  if ('title' in b) {
    const title = String(b.title).trim();
    if (!title) return badRequest(res, 'title cannot be empty');
    db.prepare('UPDATE subtasks SET title = ? WHERE id = ?').run(title, sub.id);
  }
  if ('done' in b) db.prepare('UPDATE subtasks SET done = ? WHERE id = ?').run(b.done ? 1 : 0, sub.id);
  res.json(getTask(sub.task_id));
});

router.delete('/subtasks/:id', (req, res) => {
  const sub = db.prepare('SELECT * FROM subtasks WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'subtask not found' });
  db.prepare('DELETE FROM subtasks WHERE id = ?').run(sub.id);
  res.json(getTask(sub.task_id));
});

// ---------- dependencies ----------

function wouldCreateCycle(taskId, dependsOnIds) {
  // DFS from each new dependency; if we can reach taskId, adding the edge cycles.
  const edges = db.prepare('SELECT task_id, depends_on_id FROM task_dependencies WHERE task_id != ?').all(taskId);
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

router.put('/tasks/:id/dependencies', (req, res) => {
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const ids = (req.body || {}).depends_on_ids;
  if (!Array.isArray(ids)) return badRequest(res, 'depends_on_ids must be an array');
  const unique = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n !== task.id);
  const placeholders = unique.map(() => '?').join(',');
  const existing = unique.length
    ? db.prepare(`SELECT id FROM tasks WHERE id IN (${placeholders})`).all(...unique).map((r) => r.id)
    : [];
  if (existing.length !== unique.length) return badRequest(res, 'unknown task in depends_on_ids');
  if (wouldCreateCycle(task.id, unique)) return badRequest(res, 'dependency would create a cycle');
  db.transaction(() => {
    db.prepare('DELETE FROM task_dependencies WHERE task_id = ?').run(task.id);
    const ins = db.prepare('INSERT INTO task_dependencies (task_id, depends_on_id) VALUES (?,?)');
    for (const id of unique) ins.run(task.id, id);
  })();
  res.json(getTask(task.id));
});

// ---------- views ----------

// My Day: tasks flagged for today plus tasks whose do date has arrived.
router.get('/views/my-day', (req, res) => {
  const today = todayISO();
  const settings = getSettings();
  const tasks = listOpenTasks().filter((t) => t.in_my_day);
  const ranked = rankTasks(tasks, today).map((r) => ({ ...r.task, score_reasons: r.reasons }));

  const totalEstimated = tasks.reduce((sum, t) => sum + (t.estimated_minutes || 0), 0);
  const overdue = listOpenTasks().filter((t) => t.due_date && t.due_date < today);
  const doneToday = db
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE workspace_id = ? AND status = 'done' AND date(completed_at) = ?`)
    .get(activeWorkspaceId(), today).n;

  res.json({
    date: today,
    tasks: ranked,
    done_today: doneToday,
    warnings: {
      overdue_count: overdue.length,
      total_estimated_minutes: totalEstimated,
      workday_minutes: settings.workday_minutes,
      overloaded: totalEstimated > settings.workday_minutes,
    },
  });
});

// Rolling schedule grouped into day/week buckets keyed on the do date
// (falling back to due date for tasks with no do date).
router.get('/views/schedule', (req, res) => {
  const today = todayISO();
  const tasks = listOpenTasks();
  const buckets = { overdue: [], today: [], tomorrow: [], this_week: [], next_week: [], later: [], unscheduled: [] };
  const endOfWeek = addDays(today, 7 - ((new Date().getDay() + 6) % 7) - 1); // upcoming Sunday
  const endOfNextWeek = addDays(endOfWeek, 7);

  for (const t of tasks) {
    const anchor = t.do_date || t.due_date;
    if (t.due_date && t.due_date < today) buckets.overdue.push(t);
    else if (!anchor) buckets.unscheduled.push(t);
    else if (anchor <= today) buckets.today.push(t);
    else if (anchor === addDays(today, 1)) buckets.tomorrow.push(t);
    else if (anchor <= endOfWeek) buckets.this_week.push(t);
    else if (anchor <= endOfNextWeek) buckets.next_week.push(t);
    else buckets.later.push(t);
  }
  for (const key of Object.keys(buckets)) {
    buckets[key] = rankTasks(buckets[key], today).map((r) => r.task);
  }
  res.json({ date: today, buckets });
});

// Gantt data: projects with their date-bearing tasks and dependency edges.
router.get('/gantt', (req, res) => {
  const clauses = ['t.workspace_id = ?', `t.status IN ('todo','in_progress','done')`];
  const params = [activeWorkspaceId()];
  if (req.query.project_id) {
    clauses.push('t.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  const rows = db.prepare(`${TASK_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.project_id, t.do_date, t.due_date`).all(...params);
  const tasks = hydrateTasks(rows).filter((t) => t.due_date || t.do_date);
  const projects = db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY name').all(activeWorkspaceId());
  res.json({
    today: todayISO(),
    projects,
    tasks: tasks.map((t) => ({
      id: t.id,
      title: t.title,
      project_id: t.project_id,
      project_name: t.project_name,
      project_color: t.project_color,
      status: t.status,
      priority: t.priority,
      start: t.do_date || t.due_date,
      end: t.due_date || t.do_date,
      dependencies: t.dependencies.map((d) => d.id),
    })),
  });
});

// ---------- notes ----------
// Notes can be standalone (memonotepad-style scratch) or attached to a single
// task OR project. A well-known singleton "scratch" note backs the always-
// visible notepad.

const NOTE_SELECT = `SELECT n.*, p.name AS project_name, t.title AS task_title
                     FROM notes n
                     LEFT JOIN projects p ON p.id = n.project_id
                     LEFT JOIN tasks t ON t.id = n.task_id`;

// A note's content is a set of freely-positioned text blocks. Parse them, and
// for legacy notes that only have plain `body` text, seed a single block so
// nothing is lost when the free-canvas editor loads them.
function hydrateNote(row) {
  if (!row) return null;
  let blocks = [];
  try { blocks = JSON.parse(row.blocks || '[]'); } catch { blocks = []; }
  if ((!Array.isArray(blocks) || blocks.length === 0) && row.body) {
    blocks = [{ id: 'seed', x: 16, y: 16, text: row.body }];
  }
  return { ...row, blocks: Array.isArray(blocks) ? blocks : [] };
}

function getNote(id) {
  return hydrateNote(db.prepare(`${NOTE_SELECT} WHERE n.id = ?`).get(id) || null);
}

// Validate/clamp incoming blocks. Returns null if the shape is wrong.
function sanitizeBlocks(input) {
  if (!Array.isArray(input)) return null;
  const clamp = (v) => Math.max(0, Math.min(Number.isFinite(+v) ? +v : 0, 100000));
  return input.slice(0, 500).map((b, i) => {
    const block = {
      id: typeof b?.id === 'string' && b.id ? b.id.slice(0, 64) : `b${Date.now()}_${i}`,
      x: clamp(b?.x),
      y: clamp(b?.y),
      text: typeof b?.text === 'string' ? b.text.slice(0, 20000) : '',
    };
    // Horizontal resize (drag handle on the note box). Optional — omitted
    // entirely when unset so old blocks fall back to the CSS default width.
    if (Number.isFinite(+b?.width)) block.width = Math.max(100, Math.min(+b.width, 1200));
    return block;
  });
}

// Plain-text mirror of the blocks (top-to-bottom, left-to-right) kept in `body`
// for search and backward compatibility.
function blocksToBody(blocks) {
  return [...blocks]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((b) => b.text)
    .filter((t) => t.trim())
    .join('\n');
}

// Validate an effective attachment: at most one of task/project, and it must exist.
function validateAttachment(attach, res) {
  const hasTask = attach.task_id != null;
  const hasProject = attach.project_id != null;
  if (hasTask && hasProject) { badRequest(res, 'a note can attach to a task or a project, not both'); return false; }
  if (hasTask && !db.prepare('SELECT id FROM tasks WHERE id = ?').get(attach.task_id)) { badRequest(res, 'unknown task'); return false; }
  if (hasProject && !db.prepare('SELECT id FROM projects WHERE id = ?').get(attach.project_id)) { badRequest(res, 'unknown project'); return false; }
  return true;
}

router.get('/notes', (req, res) => {
  // Saved notes belong to a workspace; the scratch pad is global and has its
  // own endpoint, so it never appears in these lists.
  const clauses = ['n.workspace_id = ?'];
  const params = [activeWorkspaceId()];
  if (req.query.standalone === '1') clauses.push('n.project_id IS NULL AND n.task_id IS NULL AND n.is_scratch = 0');
  if (req.query.task_id) { clauses.push('n.task_id = ?'); params.push(Number(req.query.task_id)); }
  if (req.query.project_id) { clauses.push('n.project_id = ?'); params.push(Number(req.query.project_id)); }
  const where = `WHERE ${clauses.join(' AND ')}`;
  res.json(db.prepare(`${NOTE_SELECT} ${where} ORDER BY n.updated_at DESC`).all(...params).map(hydrateNote));
});

// Defined before /notes/:id so "scratch" isn't matched as an id.
router.get('/notes/scratch', (req, res) => {
  let row = db.prepare('SELECT id FROM notes WHERE is_scratch = 1 ORDER BY id LIMIT 1').get();
  if (!row) {
    const info = db.prepare("INSERT INTO notes (title, is_scratch) VALUES ('Scratch', 1)").run();
    row = { id: info.lastInsertRowid };
  }
  res.json(getNote(row.id));
});

router.post('/notes', (req, res) => {
  const b = req.body || {};
  if (!validateAttachment({ task_id: b.task_id ?? null, project_id: b.project_id ?? null }, res)) return;
  let blocks = [];
  if ('blocks' in b) {
    blocks = sanitizeBlocks(b.blocks);
    if (blocks === null) return badRequest(res, 'blocks must be an array');
  } else if (b.body) {
    blocks = [{ id: 'seed', x: 16, y: 16, text: String(b.body) }];
  }
  const info = db
    .prepare('INSERT INTO notes (workspace_id, title, body, blocks, project_id, task_id) VALUES (?,?,?,?,?,?)')
    .run(activeWorkspaceId(), b.title || '', blocksToBody(blocks), JSON.stringify(blocks), b.project_id || null, b.task_id || null);
  res.status(201).json(getNote(info.lastInsertRowid));
});

router.get('/notes/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  res.json(note);
});

router.patch('/notes/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  const b = req.body || {};

  // Resolve the effective owner after this patch. A note has at most one owner,
  // so attaching to one target clears the other — apply that BEFORE validating,
  // otherwise switching a project-note to a task looks like "both set".
  const touchesAttachment = 'task_id' in b || 'project_id' in b;
  let effTask = 'task_id' in b ? (b.task_id || null) : note.task_id;
  let effProject = 'project_id' in b ? (b.project_id || null) : note.project_id;
  if (b.task_id && b.project_id) return badRequest(res, 'a note can attach to a task or a project, not both');
  if (b.task_id) effProject = null;
  if (b.project_id) effTask = null;
  if (!validateAttachment({ task_id: effTask, project_id: effProject }, res)) return;

  const updates = {};
  if ('title' in b) updates.title = b.title;
  // `blocks` is the source of truth for content; keep `body` as a plain mirror.
  if ('blocks' in b) {
    const blocks = sanitizeBlocks(b.blocks);
    if (blocks === null) return badRequest(res, 'blocks must be an array');
    updates.blocks = JSON.stringify(blocks);
    updates.body = blocksToBody(blocks);
  } else if ('body' in b) {
    updates.body = b.body;
  }
  if (touchesAttachment) { updates.task_id = effTask; updates.project_id = effProject; }

  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) {
    db.prepare(`UPDATE notes SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(
      ...Object.values(updates),
      note.id,
    );
  }
  res.json(getNote(note.id));
});

router.delete('/notes/:id', (req, res) => {
  const note = getNote(req.params.id);
  if (!note) return res.status(404).json({ error: 'note not found' });
  if (note.is_scratch) return badRequest(res, 'the scratch note cannot be deleted');
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
  res.json({ ok: true });
});

// ---------- development tracking: epics / stories / roadmap ----------

// Epics
router.get('/epics', (req, res) => {
  const clauses = ['p.workspace_id = ?'];
  const params = [activeWorkspaceId()];
  if (req.query.project_id) {
    clauses.push('e.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT e.*, p.name AS project_name, p.color AS project_color,
        (SELECT COUNT(*) FROM user_stories s WHERE s.epic_id = e.id) AS story_count,
        (SELECT COUNT(*) FROM tasks t JOIN user_stories s ON s.id = t.story_id WHERE s.epic_id = e.id) AS task_count
      FROM epics e JOIN projects p ON p.id = e.project_id ${where} ORDER BY e.sort_order, e.id`)
    .all(...params);
  res.json(rows);
});

router.post('/epics', (req, res) => {
  const b = req.body || {};
  if (!b.project_id) return badRequest(res, 'project_id is required');
  if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(b.project_id)) return badRequest(res, 'project not found');
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.status && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  for (const key of ['start_date', 'target_date'])
    if (b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  const info = db
    .prepare('INSERT INTO epics (project_id, title, description, status, start_date, target_date) VALUES (?,?,?,?,?,?)')
    .run(b.project_id, String(b.title).trim(), b.description || '', b.status || 'backlog', b.start_date || null, b.target_date || null);
  res.status(201).json(getEpic(info.lastInsertRowid));
});

router.patch('/epics/:id', (req, res) => {
  const epic = db.prepare('SELECT * FROM epics WHERE id = ?').get(req.params.id);
  if (!epic) return res.status(404).json({ error: 'epic not found' });
  const b = req.body || {};
  if ('status' in b && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  for (const key of ['start_date', 'target_date'])
    if (key in b && b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');
  const updates = {};
  for (const key of ['title', 'description', 'status', 'start_date', 'target_date', 'sort_order']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) {
    db.prepare(`UPDATE epics SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), epic.id);
  }
  res.json(getEpic(epic.id));
});

router.delete('/epics/:id', (req, res) => {
  const epic = db.prepare('SELECT * FROM epics WHERE id = ?').get(req.params.id);
  if (!epic) return res.status(404).json({ error: 'epic not found' });
  db.prepare('DELETE FROM epics WHERE id = ?').run(epic.id); // cascades to stories; tasks.story_id -> null
  res.json({ ok: true });
});

// User stories
router.get('/stories', (req, res) => {
  const clauses = ['e2.workspace_id = ?'];
  const params = [activeWorkspaceId()];
  if (req.query.epic_id) {
    clauses.push('s.epic_id = ?');
    params.push(Number(req.query.epic_id));
  } else if (req.query.project_id) {
    clauses.push('e.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT s.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id AND t.status = 'done') AS done_count
      FROM user_stories s JOIN epics e ON e.id = s.epic_id JOIN projects e2 ON e2.id = e.project_id
      ${where} ORDER BY s.sort_order, s.id`)
    .all(...params);
  res.json(rows);
});

router.post('/stories', (req, res) => {
  const b = req.body || {};
  if (!b.epic_id) return badRequest(res, 'epic_id is required');
  if (!db.prepare('SELECT id FROM epics WHERE id = ?').get(b.epic_id)) return badRequest(res, 'epic not found');
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.status && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if (b.due_date != null && !isValidISODate(b.due_date)) return badRequest(res, 'invalid due_date');
  const info = db
    .prepare('INSERT INTO user_stories (epic_id, title, description, status, due_date) VALUES (?,?,?,?,?)')
    .run(b.epic_id, String(b.title).trim(), b.description || '', b.status || 'backlog', b.due_date || null);
  res.status(201).json(getStory(info.lastInsertRowid));
});

router.patch('/stories/:id', (req, res) => {
  const story = db.prepare('SELECT * FROM user_stories WHERE id = ?').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'story not found' });
  const b = req.body || {};
  if ('status' in b && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if ('due_date' in b && b.due_date != null && !isValidISODate(b.due_date)) return badRequest(res, 'invalid due_date');
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');
  if ('epic_id' in b && !db.prepare('SELECT id FROM epics WHERE id = ?').get(b.epic_id)) return badRequest(res, 'epic not found');
  const updates = {};
  for (const key of ['title', 'description', 'status', 'due_date', 'sort_order', 'epic_id']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) {
    db.prepare(`UPDATE user_stories SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), story.id);
  }
  res.json(getStory(story.id));
});

router.delete('/stories/:id', (req, res) => {
  const story = db.prepare('SELECT * FROM user_stories WHERE id = ?').get(req.params.id);
  if (!story) return res.status(404).json({ error: 'story not found' });
  db.prepare('DELETE FROM user_stories WHERE id = ?').run(story.id); // tasks.story_id -> null
  res.json({ ok: true });
});

// Full dev tree for a project's Development tab.
router.get('/projects/:id/dev', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const epics = db.prepare('SELECT * FROM epics WHERE project_id = ? ORDER BY sort_order, id').all(project.id);
  const stories = db
    .prepare('SELECT * FROM user_stories WHERE epic_id IN (SELECT id FROM epics WHERE project_id = ?) ORDER BY sort_order, id')
    .all(project.id);
  const taskRows = db
    .prepare(`${TASK_SELECT} WHERE t.story_id IN
        (SELECT s.id FROM user_stories s JOIN epics e ON e.id = s.epic_id WHERE e.project_id = ?) ORDER BY t.id`)
    .all(project.id);
  const tasks = hydrateTasks(taskRows);

  const storyById = new Map(stories.map((s) => [s.id, { ...s, tasks: [] }]));
  for (const t of tasks) storyById.get(t.story_id)?.tasks.push(t);
  const epicById = new Map(epics.map((e) => [e.id, { ...e, stories: [] }]));
  for (const s of storyById.values()) epicById.get(s.epic_id)?.stories.push(s);
  res.json({ project, epics: [...epicById.values()] });
});

// Roadmap: epic-level timeline across dev-enabled projects (shaped like /gantt).
router.get('/roadmap', (req, res) => {
  const rows = db
    .prepare(`SELECT e.*, p.name AS project_name, p.color AS project_color
      FROM epics e JOIN projects p ON p.id = e.project_id
      WHERE p.track_dev = 1 AND p.workspace_id = ? ORDER BY e.project_id, e.start_date, e.target_date`)
    .all(activeWorkspaceId());
  const epics = rows
    .filter((e) => e.start_date || e.target_date)
    .map((e) => ({
      id: e.id,
      title: e.title,
      project_id: e.project_id,
      project_name: e.project_name,
      project_color: e.project_color,
      status: e.status,
      start: e.start_date || e.target_date,
      end: e.target_date || e.start_date,
    }));
  const projects = db.prepare('SELECT * FROM projects WHERE track_dev = 1 AND workspace_id = ? ORDER BY name').all(activeWorkspaceId());
  res.json({ today: todayISO(), projects, epics });
});

// ---------- ideas + bugs backlog ----------

router.get('/ideas', (req, res) => {
  const clauses = ['i.workspace_id = ?'];
  const params = [activeWorkspaceId()];
  if (req.query.kind) {
    clauses.push('i.kind = ?');
    params.push(req.query.kind);
  }
  if (req.query.status) {
    clauses.push('i.status = ?');
    params.push(req.query.status);
  }
  if (req.query.project_id === 'none') {
    clauses.push('i.project_id IS NULL');
  } else if (req.query.project_id) {
    clauses.push('i.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  if (req.query.q) {
    clauses.push('(i.title LIKE ? OR i.description LIKE ?)');
    const like = `%${req.query.q}%`;
    params.push(like, like);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  const rows = db
    .prepare(`SELECT i.*, p.name AS project_name, p.color AS project_color
      FROM ideas i LEFT JOIN projects p ON p.id = i.project_id ${where}
      ORDER BY i.created_at DESC, i.id DESC`)
    .all(...params);
  res.json(rows);
});

function getIdea(id) {
  return db
    .prepare('SELECT i.*, p.name AS project_name, p.color AS project_color FROM ideas i LEFT JOIN projects p ON p.id = i.project_id WHERE i.id = ?')
    .get(id);
}

router.post('/ideas', (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.kind && !IDEA_KINDS.includes(b.kind)) return badRequest(res, 'invalid kind');
  if (b.status && !IDEA_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if (b.project_id != null && !db.prepare('SELECT id FROM projects WHERE id = ?').get(b.project_id)) return badRequest(res, 'project not found');
  const info = db
    .prepare('INSERT INTO ideas (workspace_id, kind, title, description, project_id, status) VALUES (?,?,?,?,?,?)')
    .run(activeWorkspaceId(), b.kind || 'idea', String(b.title).trim(), b.description || '', b.project_id || null, b.status || 'open');
  res.status(201).json(getIdea(info.lastInsertRowid));
});

router.patch('/ideas/:id', (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'idea not found' });
  const b = req.body || {};
  if ('status' in b && !IDEA_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');
  if ('project_id' in b && b.project_id != null && !db.prepare('SELECT id FROM projects WHERE id = ?').get(b.project_id)) return badRequest(res, 'project not found');
  const updates = {};
  for (const key of ['title', 'description', 'status', 'project_id']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) {
    db.prepare(`UPDATE ideas SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), idea.id);
  }
  res.json(getIdea(idea.id));
});

router.delete('/ideas/:id', (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'idea not found' });
  db.prepare('DELETE FROM ideas WHERE id = ?').run(idea.id);
  res.json({ ok: true });
});

// Promote an idea into the dev hierarchy (epic / story / task), marking the
// idea as promoted. The idea's title/description seed the new entity.
router.post('/ideas/:id/promote', (req, res) => {
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  if (!idea) return res.status(404).json({ error: 'idea not found' });
  const b = req.body || {};
  const level = b.level;
  if (!['epic', 'story', 'task'].includes(level)) return badRequest(res, 'level must be epic, story or task');
  const markPromoted = () => db.prepare(`UPDATE ideas SET status = 'promoted', updated_at = datetime('now') WHERE id = ?`).run(idea.id);

  if (level === 'epic') {
    const projectId = b.project_id || idea.project_id;
    if (!projectId) return badRequest(res, 'project_id is required to promote to an epic');
    if (!db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId)) return badRequest(res, 'project not found');
    const epic = db.transaction(() => {
      const info = db.prepare('INSERT INTO epics (project_id, title, description) VALUES (?,?,?)').run(projectId, idea.title, idea.description);
      markPromoted();
      return getEpic(info.lastInsertRowid);
    })();
    return res.status(201).json({ level, epic });
  }
  if (level === 'story') {
    if (!b.epic_id) return badRequest(res, 'epic_id is required to promote to a story');
    if (!db.prepare('SELECT id FROM epics WHERE id = ?').get(b.epic_id)) return badRequest(res, 'epic not found');
    const story = db.transaction(() => {
      const info = db.prepare('INSERT INTO user_stories (epic_id, title, description) VALUES (?,?,?)').run(b.epic_id, idea.title, idea.description);
      markPromoted();
      return getStory(info.lastInsertRowid);
    })();
    return res.status(201).json({ level, story });
  }
  // task
  let projectId = b.project_id || idea.project_id || null;
  let storyId = null;
  const tags = [];
  if (b.story_id != null) {
    const story = storyOwner(b.story_id);
    if (!story) return badRequest(res, 'story not found');
    storyId = story.id;
    projectId = story.project_id;
    tags.push(DEV_TAG);
  }
  const task = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO tasks (workspace_id, project_id, story_id, title, notes, tags) VALUES (?,?,?,?,?,?)')
      .run(idea.workspace_id, projectId, storyId, idea.title, idea.description, JSON.stringify(tags));
    markPromoted();
    return getTask(info.lastInsertRowid);
  })();
  return res.status(201).json({ level, task });
});

// Convert an existing task into a backlog idea or bug (move: task is removed).
function convertTaskToBacklog(req, res, kind) {
  const task = getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const item = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO ideas (workspace_id, kind, title, description, project_id) VALUES (?,?,?,?,?)')
      .run(task.workspace_id, kind, task.title, task.notes || '', task.project_id || null);
    db.prepare('DELETE FROM tasks WHERE id = ?').run(task.id);
    return getIdea(info.lastInsertRowid);
  })();
  res.status(201).json(item);
}
router.post('/tasks/:id/convert-to-idea', (req, res) => convertTaskToBacklog(req, res, 'idea'));
router.post('/tasks/:id/convert-to-bug', (req, res) => convertTaskToBacklog(req, res, 'bug'));

// ---------- kanban boards ----------

const DEFAULT_COLUMNS = [
  ['Backlog', 'backlog'], ['In Progress', 'in_progress'], ['In Review', 'in_review'],
  ['Done', 'done'], ['Deployed', 'deployed'],
];

function boardColumns(boardId) {
  return db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY sort_order, id').all(boardId);
}
function getBoard(id) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(id);
  return board ? { ...board, columns: boardColumns(board.id) } : null;
}

router.get('/boards', (req, res) => {
  const boards = db.prepare('SELECT * FROM boards WHERE workspace_id = ? ORDER BY sort_order, id').all(activeWorkspaceId());
  res.json(boards.map((b) => ({ ...b, columns: boardColumns(b.id) })));
});

router.post('/boards', (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'name is required');
  const board = db.transaction(() => {
    const ws = activeWorkspaceId();
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM boards WHERE workspace_id = ?').get(ws).m;
    const id = db.prepare('INSERT INTO boards (workspace_id, name, sort_order) VALUES (?,?,?)').run(ws, String(b.name).trim(), max + 1).lastInsertRowid;
    const addCol = db.prepare('INSERT INTO board_columns (board_id, name, stage, sort_order) VALUES (?,?,?,?)');
    DEFAULT_COLUMNS.forEach(([name, stage], i) => addCol.run(id, name, stage, i));
    return getBoard(id);
  })();
  res.status(201).json(board);
});

router.patch('/boards/:id', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  if (!board) return res.status(404).json({ error: 'board not found' });
  const b = req.body || {};
  if ('name' in b && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
  const updates = {};
  if ('name' in b) updates.name = String(b.name).trim();
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) db.prepare(`UPDATE boards SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), board.id);
  res.json(getBoard(board.id));
});

router.delete('/boards/:id', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  if (!board) return res.status(404).json({ error: 'board not found' });
  db.prepare('DELETE FROM boards WHERE id = ?').run(board.id); // cascades to columns
  res.json({ ok: true });
});

router.post('/boards/:id/columns', (req, res) => {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(req.params.id);
  if (!board) return res.status(404).json({ error: 'board not found' });
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'name is required');
  if (!DEV_STATUSES.includes(b.stage)) return badRequest(res, 'invalid stage');
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM board_columns WHERE board_id = ?').get(board.id).m;
  db.prepare('INSERT INTO board_columns (board_id, name, stage, sort_order) VALUES (?,?,?,?)')
    .run(board.id, String(b.name).trim(), b.stage, max + 1);
  res.status(201).json(getBoard(board.id));
});

router.patch('/board-columns/:id', (req, res) => {
  const col = db.prepare('SELECT * FROM board_columns WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'column not found' });
  const b = req.body || {};
  if ('stage' in b && !DEV_STATUSES.includes(b.stage)) return badRequest(res, 'invalid stage');
  if ('name' in b && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
  const updates = {};
  if ('name' in b) updates.name = String(b.name).trim();
  if ('stage' in b) updates.stage = b.stage;
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  const sets = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
  if (sets) db.prepare(`UPDATE board_columns SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), col.id);
  res.json(getBoard(col.board_id));
});

router.delete('/board-columns/:id', (req, res) => {
  const col = db.prepare('SELECT * FROM board_columns WHERE id = ?').get(req.params.id);
  if (!col) return res.status(404).json({ error: 'column not found' });
  db.prepare('DELETE FROM board_columns WHERE id = ?').run(col.id);
  res.json(getBoard(col.board_id));
});

// Unified card feed for a board: epics, stories and tasks in one normalised
// shape. Cross-project by default; `levels`, `project_id` and `q` narrow it.
router.get('/boards/:id/cards', (req, res) => {
  const board = getBoard(req.params.id);
  // Reject boards from another workspace, so a board id left over from before a
  // workspace switch can't render that workspace's cards.
  if (!board || board.workspace_id !== activeWorkspaceId()) return res.status(404).json({ error: 'board not found' });

  const levels = req.query.levels
    ? String(req.query.levels).split(',').map((s) => s.trim()).filter((s) => CARD_TYPES.includes(s))
    : CARD_TYPES;
  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  const q = req.query.q ? `%${req.query.q}%` : null;
  const cards = [];
  const ws = activeWorkspaceId();

  if (levels.includes('epic')) {
    const where = ['p.workspace_id = ?'];
    const params = [ws];
    if (projectId) { where.push('e.project_id = ?'); params.push(projectId); }
    if (q) { where.push('(e.title LIKE ? OR e.description LIKE ?)'); params.push(q, q); }
    for (const e of db.prepare(`SELECT e.*, p.name AS project_name, p.color AS project_color,
        (SELECT COUNT(*) FROM user_stories s WHERE s.epic_id = e.id) AS story_count
        FROM epics e JOIN projects p ON p.id = e.project_id
        WHERE ${where.join(' AND ')} ORDER BY e.sort_order, e.id`).all(...params)) {
      cards.push({
        type: 'epic', id: e.id, title: e.title, stage: e.status, sort_order: e.sort_order,
        project_id: e.project_id, project_name: e.project_name, project_color: e.project_color,
        epic_id: e.id, parent_title: null, target_date: e.target_date, child_count: e.story_count,
      });
    }
  }

  if (levels.includes('story')) {
    const where = ['p.workspace_id = ?'];
    const params = [ws];
    if (projectId) { where.push('e.project_id = ?'); params.push(projectId); }
    if (q) { where.push('(s.title LIKE ? OR s.description LIKE ?)'); params.push(q, q); }
    for (const s of db.prepare(`SELECT s.*, e.title AS epic_title, e.project_id AS project_id,
        p.name AS project_name, p.color AS project_color,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id) AS task_count
        FROM user_stories s JOIN epics e ON e.id = s.epic_id JOIN projects p ON p.id = e.project_id
        WHERE ${where.join(' AND ')} ORDER BY s.sort_order, s.id`).all(...params)) {
      cards.push({
        type: 'story', id: s.id, title: s.title, stage: s.status, sort_order: s.sort_order,
        project_id: s.project_id, project_name: s.project_name, project_color: s.project_color,
        epic_id: s.epic_id, parent_title: s.epic_title, due_date: s.due_date, child_count: s.task_count,
      });
    }
  }

  if (levels.includes('task')) {
    const where = ['t.workspace_id = ?', `t.status != 'cancelled'`];
    const params = [ws];
    if (projectId) { where.push('t.project_id = ?'); params.push(projectId); }
    if (q) { where.push('(t.title LIKE ? OR t.notes LIKE ?)'); params.push(q, q); }
    for (const t of db.prepare(`${TASK_SELECT} WHERE ${where.join(' AND ')} ORDER BY t.sort_order, t.id`).all(...params)) {
      cards.push({
        type: 'task', id: t.id, title: t.title, stage: t.dev_stage, sort_order: t.sort_order,
        project_id: t.project_id, project_name: t.project_name, project_color: t.project_color,
        epic_id: t.epic_id, parent_title: t.story_title, due_date: t.due_date,
        priority: t.priority, status: t.status,
      });
    }
  }

  res.json({ board, cards });
});

// Single place where a drag-and-drop move is applied, so the per-type rules
// (and the task status sync) live in one spot.
router.post('/kanban/move', (req, res) => {
  const b = req.body || {};
  if (!CARD_TYPES.includes(b.type)) return badRequest(res, 'invalid type');
  if (!DEV_STATUSES.includes(b.stage)) return badRequest(res, 'invalid stage');
  const id = Number(b.id);
  const sortOrder = Number.isFinite(+b.sort_order) ? Math.trunc(+b.sort_order) : null;

  if (b.type === 'epic') {
    const epic = db.prepare('SELECT * FROM epics WHERE id = ?').get(id);
    if (!epic) return res.status(404).json({ error: 'epic not found' });
    db.prepare(`UPDATE epics SET status = ?, sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`)
      .run(b.stage, sortOrder, id);
    return res.json({ type: 'epic', card: getEpic(id) });
  }
  if (b.type === 'story') {
    const story = db.prepare('SELECT * FROM user_stories WHERE id = ?').get(id);
    if (!story) return res.status(404).json({ error: 'story not found' });
    db.prepare(`UPDATE user_stories SET status = ?, sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`)
      .run(b.stage, sortOrder, id);
    return res.json({ type: 'story', card: getStory(id) });
  }

  // Tasks: move the stage and keep status/completed_at consistent so My Day,
  // scoring and the task lists agree with the board.
  const task = getTask(id);
  if (!task) return res.status(404).json({ error: 'task not found' });
  const nextStatus = task.status === 'cancelled' ? task.status : statusFromStage(b.stage);
  const completedAt = nextStatus === 'done'
    ? (task.completed_at || new Date().toISOString())
    : null;
  db.prepare(`UPDATE tasks SET dev_stage = ?, status = ?, completed_at = ?,
      sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`)
    .run(b.stage, nextStatus, completedAt, sortOrder, id);
  res.json({ type: 'task', card: getTask(id) });
});

// ---------- tags / settings / ai ----------

router.get('/tags', (req, res) => {
  const rows = db.prepare(`SELECT tags FROM tasks WHERE workspace_id = ? AND status IN ('todo','in_progress')`).all(activeWorkspaceId());
  const all = new Set();
  for (const r of rows) for (const t of JSON.parse(r.tags || '[]')) all.add(t);
  res.json([...all].sort());
});

// The stored Anthropic API key is write-only from the client's perspective —
// GET/PATCH never echo it back, only whether one is configured, where it
// came from, and its last 4 characters so the user can confirm which key is
// active without re-reading the secret itself.
function publicSettings() {
  const s = getSettings();
  const dbKey = (s.anthropic_api_key || '').trim();
  const hasDbKey = !!dbKey;
  const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
  return {
    workday_minutes: s.workday_minutes,
    workday_start: s.workday_start,
    ai_available: aiAvailable(),
    ai_key_source: hasDbKey ? 'settings' : hasEnvKey ? 'env' : 'none',
    ai_key_last4: hasDbKey ? dbKey.slice(-4) : null,
    ai_prompt: s.ai_prompt || '',
  };
}

router.get('/settings', (req, res) => res.json(publicSettings()));

router.patch('/settings', (req, res) => {
  const b = req.body || {};
  if ('workday_minutes' in b) {
    const v = Number(b.workday_minutes);
    if (!Number.isInteger(v) || v < 60 || v > 1440) return badRequest(res, 'workday_minutes must be 60-1440');
    setSetting('workday_minutes', v);
  }
  if ('workday_start' in b) setSetting('workday_start', String(b.workday_start));
  if ('anthropic_api_key' in b) {
    if (typeof b.anthropic_api_key !== 'string') return badRequest(res, 'anthropic_api_key must be a string');
    const key = b.anthropic_api_key.trim();
    if (key.length > 300) return badRequest(res, 'API key is too long');
    if (key) setSetting('anthropic_api_key', key);
    else deleteSetting('anthropic_api_key');
  }
  if ('ai_prompt' in b) {
    if (typeof b.ai_prompt !== 'string') return badRequest(res, 'ai_prompt must be a string');
    const prompt = b.ai_prompt.trim();
    if (prompt.length > 2000) return badRequest(res, 'AI instructions are too long (max 2000 characters)');
    if (prompt) setSetting('ai_prompt', prompt);
    else deleteSetting('ai_prompt');
  }
  res.json(publicSettings());
});

router.get('/ai/status', (req, res) => res.json({ available: aiAvailable() }));

router.post('/ai/plan-day', async (req, res) => {
  const settings = getSettings();
  const result = await planMyDay(listOpenTasks(), todayISO(), settings.workday_minutes);
  res.json(result);
});

router.post('/ai/prioritise', async (req, res) => {
  let tasks = listOpenTasks();
  if (req.body?.project_id) tasks = tasks.filter((t) => t.project_id === Number(req.body.project_id));
  const result = await prioritise(tasks, todayISO());
  res.json(result);
});
