import { Router } from 'express';
import { db, getSettings, setSetting, deleteSetting } from './db.js';
import { todayISO, addDays, computeDoDate, nextOccurrence, isValidISODate } from './dates.js';
import { rankTasks } from './scoring.js';
import { aiAvailable, planMyDay, prioritise } from './ai.js';

export const router = Router();

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'];
const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'archived'];

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

const TASK_SELECT = `SELECT t.*, p.name AS project_name, p.color AS project_color
                     FROM tasks t LEFT JOIN projects p ON p.id = t.project_id`;

function getTask(id) {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id);
  return row ? hydrateTasks([row])[0] : null;
}

function listOpenTasks() {
  const rows = db.prepare(`${TASK_SELECT} WHERE t.status IN ('todo','in_progress') ORDER BY t.id`).all();
  return hydrateTasks(rows);
}

// ---------- projects ----------

router.get('/projects', (req, res) => {
  const projects = db
    .prepare(`SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_tasks
      FROM projects p ORDER BY p.status = 'archived', p.name`)
    .all();
  res.json(projects);
});

router.post('/projects', (req, res) => {
  const { name, description = '', status = 'active', color = '#5b7c99', start_date = null, target_date = null } = req.body || {};
  if (!name || !String(name).trim()) return badRequest(res, 'name is required');
  if (!PROJECT_STATUSES.includes(status)) return badRequest(res, 'invalid status');
  for (const d of [start_date, target_date]) if (d != null && !isValidISODate(d)) return badRequest(res, 'invalid date');
  const info = db
    .prepare('INSERT INTO projects (name, description, status, color, start_date, target_date) VALUES (?,?,?,?,?,?)')
    .run(String(name).trim(), description, status, color, start_date, target_date);
  res.status(201).json(db.prepare('SELECT * FROM projects WHERE id = ?').get(info.lastInsertRowid));
});

router.patch('/projects/:id', (req, res) => {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'project not found' });
  const allowed = ['name', 'description', 'status', 'color', 'start_date', 'target_date'];
  const updates = {};
  for (const key of allowed) if (key in (req.body || {})) updates[key] = req.body[key];
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
  const clauses = [];
  const params = [];
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
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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

  const dueDate = b.due_date || null;
  const manual = b.do_date != null;
  const doDate = manual ? b.do_date : computeDoDate(dueDate, b.estimated_minutes, settings.workday_minutes);

  const info = db
    .prepare(`INSERT INTO tasks (project_id, title, notes, status, priority, due_date, do_date, do_date_is_manual,
              estimated_minutes, my_day_date, tags, recurrence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      b.project_id || null,
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
    .prepare(`INSERT INTO tasks (project_id, title, notes, status, priority, due_date, do_date, do_date_is_manual,
              estimated_minutes, tags, recurrence)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
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
  for (const key of ['due_date', 'do_date'])
    if (key in b && b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');

  const updates = {};
  for (const key of ['title', 'notes', 'status', 'priority', 'project_id']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();

  if ('tags' in b) {
    const tags = normaliseTags(b.tags);
    if (!tags) return badRequest(res, 'tags must be an array');
    updates.tags = JSON.stringify(tags);
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
    .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'done' AND date(completed_at) = ?`)
    .get(today).n;

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
  const clauses = [`t.status IN ('todo','in_progress','done')`];
  const params = [];
  if (req.query.project_id) {
    clauses.push('t.project_id = ?');
    params.push(Number(req.query.project_id));
  }
  const rows = db.prepare(`${TASK_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY t.project_id, t.do_date, t.due_date`).all(...params);
  const tasks = hydrateTasks(rows).filter((t) => t.due_date || t.do_date);
  const projects = db.prepare('SELECT * FROM projects ORDER BY name').all();
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
  const clauses = [];
  const params = [];
  if (req.query.standalone === '1') clauses.push('n.project_id IS NULL AND n.task_id IS NULL AND n.is_scratch = 0');
  if (req.query.task_id) { clauses.push('n.task_id = ?'); params.push(Number(req.query.task_id)); }
  if (req.query.project_id) { clauses.push('n.project_id = ?'); params.push(Number(req.query.project_id)); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
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
    .prepare('INSERT INTO notes (title, body, blocks, project_id, task_id) VALUES (?,?,?,?,?)')
    .run(b.title || '', blocksToBody(blocks), JSON.stringify(blocks), b.project_id || null, b.task_id || null);
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

// ---------- tags / settings / ai ----------

router.get('/tags', (req, res) => {
  const rows = db.prepare(`SELECT tags FROM tasks WHERE status IN ('todo','in_progress')`).all();
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
