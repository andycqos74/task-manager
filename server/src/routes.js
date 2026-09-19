// HTTP layer: validation, orchestration and response shaping.
//
// No SQL lives here. Every read and write goes through server/src/data/*,
// whose accessors take the request scope (server/src/scope.js) and filter on
// it, so an endpoint cannot reach a row outside the caller's workspace even if
// this file forgets to check. A test asserts that no statement is prepared in
// this file, so a new endpoint has to go through the same path.
import { Router } from 'express';
import { todayISO, addDays, computeDoDate, isValidISODate } from './dates.js';
import { rankTasks } from './scoring.js';
import { aiAvailable, planMyDay, prioritise } from './ai.js';
import { scopeForUser } from './scope.js';
import { getSettings, setSetting, deleteSetting } from './data/settings.js';
import * as Workspaces from './data/workspaces.js';
import * as Projects from './data/projects.js';
import * as Tasks from './data/tasks.js';
import * as Notes from './data/notes.js';
import * as Dev from './data/dev.js';
import * as Ideas from './data/ideas.js';
import * as Boards from './data/boards.js';

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
function notFound(res, what) {
  return res.status(404).json({ error: `${what} not found` });
}

// ---------- workspaces ----------
// The top level: every project, task, note, idea/bug, epic and board belongs to
// exactly one. Settings (incl. the AI key) and the scratch pad stay global.

router.get('/workspaces', (req, res) => {
  res.json({
    active_id: req.scope.workspaceId,
    workspaces: Workspaces.listWorkspaces(req.scope),
  });
});

router.post('/workspaces', (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'name is required');
  res.status(201).json(Workspaces.createWorkspace(req.scope, { name: String(b.name).trim(), color: b.color }));
});

router.patch('/workspaces/:id', (req, res) => {
  const ws = Workspaces.getWorkspace(req.scope, req.params.id);
  if (!ws) return notFound(res, 'workspace');
  const b = req.body || {};
  if ('name' in b && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
  const updates = {};
  if ('name' in b) updates.name = String(b.name).trim();
  if ('color' in b) updates.color = b.color;
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  res.json(Workspaces.updateWorkspace(req.scope, ws, updates));
});

// Deleting a workspace removes everything inside it (FK cascade).
router.delete('/workspaces/:id', (req, res) => {
  const ws = Workspaces.getWorkspace(req.scope, req.params.id);
  if (!ws) return notFound(res, 'workspace');
  if (Workspaces.countWorkspaces(req.scope) <= 1) return badRequest(res, 'cannot delete the only workspace');
  Workspaces.deleteWorkspace(req.scope, ws);
  // Re-resolve: the active workspace self-heals if the deleted one was it.
  res.json({ ok: true, active_id: scopeForUser(req.scope.userId).workspaceId });
});

router.post('/workspaces/:id/activate', (req, res) => {
  const ws = Workspaces.getWorkspace(req.scope, req.params.id);
  if (!ws) return notFound(res, 'workspace');
  Workspaces.setActiveWorkspace(req.scope, ws);
  res.json({ active_id: ws.id, workspace: ws });
});

// ---------- projects ----------

router.get('/projects', (req, res) => {
  res.json(Projects.listProjects(req.scope));
});

router.post('/projects', (req, res) => {
  const { name, description = '', status = 'active', color = '#5b7c99', start_date = null, target_date = null } = req.body || {};
  if (!name || !String(name).trim()) return badRequest(res, 'name is required');
  if (!PROJECT_STATUSES.includes(status)) return badRequest(res, 'invalid status');
  for (const d of [start_date, target_date]) if (d != null && !isValidISODate(d)) return badRequest(res, 'invalid date');
  res.status(201).json(Projects.createProject(req.scope, {
    name: String(name).trim(), description, status, color, start_date, target_date,
  }));
});

router.patch('/projects/:id', (req, res) => {
  const project = Projects.getProject(req.scope, req.params.id);
  if (!project) return notFound(res, 'project');
  const allowed = ['name', 'description', 'status', 'color', 'start_date', 'target_date'];
  const updates = {};
  for (const key of allowed) if (key in (req.body || {})) updates[key] = req.body[key];
  if ('track_dev' in (req.body || {})) updates.track_dev = req.body.track_dev ? 1 : 0;
  if ('status' in updates && !PROJECT_STATUSES.includes(updates.status)) return badRequest(res, 'invalid status');
  for (const key of ['start_date', 'target_date'])
    if (key in updates && updates[key] != null && !isValidISODate(updates[key])) return badRequest(res, 'invalid date');
  if ('name' in updates && !String(updates.name).trim()) return badRequest(res, 'name cannot be empty');
  res.json(Projects.updateProject(req.scope, project, updates));
});

router.delete('/projects/:id', (req, res) => {
  const project = Projects.getProject(req.scope, req.params.id);
  if (!project) return notFound(res, 'project');
  Projects.deleteProject(req.scope, project, { deleteTasks: req.query.tasks === 'delete' });
  res.json({ ok: true });
});

// Resolve the destination workspace of a move request. Answers the request
// itself (and returns null) when workspace_id is missing or out of reach.
function resolveMoveTarget(req, res) {
  const raw = (req.body || {}).workspace_id;
  if (raw == null || !Number.isFinite(Number(raw))) {
    badRequest(res, 'workspace_id is required');
    return null;
  }
  const ws = Workspaces.getWorkspace(req.scope, Number(raw));
  if (!ws) {
    badRequest(res, 'workspace not found');
    return null;
  }
  return ws;
}

// Move a project to another workspace with everything it owns.
router.post('/projects/:id/move', (req, res) => {
  const project = Projects.getProject(req.scope, req.params.id);
  if (!project) return notFound(res, 'project');
  const target = resolveMoveTarget(req, res);
  if (!target) return undefined;

  const counts = Projects.moveProjectToWorkspace(req.scope, project, target.id);
  res.json({
    // Re-read across workspaces: the project has just left the active one.
    project: Projects.getProjectAnywhere(req.scope, project.id),
    workspace: target,
    moved: counts,
    active_id: req.scope.workspaceId,
  });
});

// ---------- tasks ----------

router.get('/tasks', (req, res) => {
  let tasks = Tasks.listTasks(req.scope, {
    projectId: req.query.project_id,
    status: req.query.status,
    includeDone: req.query.include_done === '1',
    q: req.query.q,
  });
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
  const settings = getSettings(req.scope);

  // A task linked to a user story is a dev task: it inherits the story's
  // project and gets the "development" tag so it stays findable in the
  // ordinary task lists while being clearly separated.
  let projectId = null;
  if (b.project_id != null) {
    const project = Projects.getProject(req.scope, b.project_id);
    if (!project) return badRequest(res, 'project not found');
    projectId = project.id;
  }
  let storyId = null;
  if (b.story_id != null) {
    const story = Dev.storyOwner(req.scope, b.story_id);
    if (!story) return badRequest(res, 'story not found');
    storyId = story.id;
    projectId = story.project_id;
    if (!tags.includes(DEV_TAG)) tags.push(DEV_TAG);
  }

  const dueDate = b.due_date || null;
  const manual = b.do_date != null;
  const doDate = manual ? b.do_date : computeDoDate(dueDate, b.estimated_minutes, settings.workday_minutes);

  const id = Tasks.createTask(req.scope, {
    project_id: projectId,
    story_id: storyId,
    title: String(b.title).trim(),
    notes: b.notes || '',
    status: b.status || 'todo',
    priority: b.priority || 'medium',
    due_date: dueDate,
    do_date: doDate,
    do_date_is_manual: manual,
    estimated_minutes: Number.isInteger(b.estimated_minutes) && b.estimated_minutes > 0 ? b.estimated_minutes : null,
    my_day_date: b.my_day ? todayISO() : null,
    tags: JSON.stringify(tags),
    recurrence: recurrence ? JSON.stringify(recurrence) : null,
  });
  res.status(201).json(Tasks.getTask(req.scope, id));
});

router.get('/tasks/:id', (req, res) => {
  const task = Tasks.getTask(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  res.json(task);
});

router.patch('/tasks/:id', (req, res) => {
  const task = Tasks.getTask(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  const b = req.body || {};
  const settings = getSettings(req.scope);
  if ('priority' in b && !PRIORITIES.includes(b.priority)) return badRequest(res, 'invalid priority');
  if ('status' in b && !TASK_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if ('dev_stage' in b && !DEV_STATUSES.includes(b.dev_stage)) return badRequest(res, 'invalid dev_stage');
  for (const key of ['due_date', 'do_date'])
    if (key in b && b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');

  const updates = {};
  for (const key of ['title', 'notes', 'status', 'priority']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  if ('project_id' in b) {
    if (b.project_id == null) {
      updates.project_id = null;
    } else {
      const project = Projects.getProject(req.scope, b.project_id);
      if (!project) return badRequest(res, 'project not found');
      updates.project_id = project.id;
    }
  }

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
      const story = Dev.storyOwner(req.scope, b.story_id);
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
      if (task.recurrence) spawnedId = Tasks.spawnRecurrence(req.scope, task, settings.workday_minutes);
    } else {
      updates.completed_at = null;
    }
  }

  Tasks.updateTask(req.scope, task.id, updates);
  const result = Tasks.getTask(req.scope, task.id);
  if (spawnedId) result.spawned_task = Tasks.getTask(req.scope, spawnedId);
  res.json(result);
});

router.delete('/tasks/:id', (req, res) => {
  if (Tasks.deleteTask(req.scope, req.params.id) === 0) return notFound(res, 'task');
  res.json({ ok: true });
});

// Move a single task to another workspace. Its project and user story live in
// the old workspace, so those links are cleared unless `project_id` names a
// project in the destination to file it under. Subtasks and notes attached to
// the task travel with it; dependencies on tasks left behind are dropped.
router.post('/tasks/:id/move', (req, res) => {
  const task = Tasks.getTaskRow(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  const target = resolveMoveTarget(req, res);
  if (!target) return undefined;

  let projectId = null;
  const wanted = (req.body || {}).project_id;
  if (wanted != null) {
    const p = Projects.getProjectAnywhere(req.scope, wanted);
    if (!p) return badRequest(res, 'project not found');
    if (p.workspace_id !== target.id) return badRequest(res, 'project is not in the destination workspace');
    projectId = p.id;
  }

  const counts = Tasks.moveTaskToWorkspace(req.scope, task, target.id, projectId);
  res.json({
    task: Tasks.getTaskAnywhere(req.scope, task.id),
    workspace: target,
    moved: counts,
    active_id: req.scope.workspaceId,
  });
});

// One-click My Day toggle.
router.post('/tasks/:id/my-day', (req, res) => {
  const task = Tasks.getTask(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  Tasks.setMyDay(req.scope, task.id, (req.body || {}).on !== false);
  res.json(Tasks.getTask(req.scope, task.id));
});

// ---------- subtasks ----------
// Reached through their task, which is ownership-checked first.

router.post('/tasks/:id/subtasks', (req, res) => {
  const task = Tasks.getTask(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  const title = String((req.body || {}).title || '').trim();
  if (!title) return badRequest(res, 'title is required');
  Tasks.addSubtask(req.scope, task.id, title);
  res.status(201).json(Tasks.getTask(req.scope, task.id));
});

router.patch('/subtasks/:id', (req, res) => {
  const sub = Tasks.getSubtask(req.scope, req.params.id);
  if (!sub) return notFound(res, 'subtask');
  const b = req.body || {};
  const updates = {};
  if ('title' in b) {
    const title = String(b.title).trim();
    if (!title) return badRequest(res, 'title cannot be empty');
    updates.title = title;
  }
  if ('done' in b) updates.done = b.done;
  Tasks.updateSubtask(req.scope, sub, updates);
  res.json(Tasks.getTask(req.scope, sub.task_id));
});

router.delete('/subtasks/:id', (req, res) => {
  const sub = Tasks.getSubtask(req.scope, req.params.id);
  if (!sub) return notFound(res, 'subtask');
  Tasks.deleteSubtask(req.scope, sub);
  res.json(Tasks.getTask(req.scope, sub.task_id));
});

// ---------- dependencies ----------

router.put('/tasks/:id/dependencies', (req, res) => {
  const task = Tasks.getTask(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  const ids = (req.body || {}).depends_on_ids;
  if (!Array.isArray(ids)) return badRequest(res, 'depends_on_ids must be an array');
  const unique = [...new Set(ids.map(Number))].filter((n) => Number.isInteger(n) && n !== task.id);
  // Only tasks in the same workspace: a cross-workspace edge would have to be
  // dropped by the first move anyway.
  if (Tasks.existingTaskIds(req.scope, unique).length !== unique.length) {
    return badRequest(res, 'unknown task in depends_on_ids');
  }
  if (Tasks.wouldCreateCycle(req.scope, task.id, unique)) return badRequest(res, 'dependency would create a cycle');
  Tasks.setDependencies(req.scope, task.id, unique);
  res.json(Tasks.getTask(req.scope, task.id));
});

// ---------- views ----------

// My Day: tasks flagged for today plus tasks whose do date has arrived.
router.get('/views/my-day', (req, res) => {
  const today = todayISO();
  const settings = getSettings(req.scope);
  const open = Tasks.listOpenTasks(req.scope);
  const tasks = open.filter((t) => t.in_my_day);
  const ranked = rankTasks(tasks, today).map((r) => ({ ...r.task, score_reasons: r.reasons }));

  const totalEstimated = tasks.reduce((sum, t) => sum + (t.estimated_minutes || 0), 0);
  const overdue = open.filter((t) => t.due_date && t.due_date < today);

  res.json({
    date: today,
    tasks: ranked,
    done_today: Tasks.countDoneOn(req.scope, today),
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
  const tasks = Tasks.listOpenTasks(req.scope);
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
  const tasks = Tasks.listGanttTasks(req.scope, req.query.project_id).filter((t) => t.due_date || t.do_date);
  res.json({
    today: todayISO(),
    projects: Projects.listProjectsByName(req.scope),
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

// Validate an effective attachment: at most one of task/project, and it must
// exist *in this workspace* — attaching a note to someone else's task is how a
// note would otherwise straddle two scopes.
function validateAttachment(req, res, attach) {
  const hasTask = attach.task_id != null;
  const hasProject = attach.project_id != null;
  if (hasTask && hasProject) { badRequest(res, 'a note can attach to a task or a project, not both'); return false; }
  if (hasTask && !Tasks.getTaskRow(req.scope, attach.task_id)) { badRequest(res, 'unknown task'); return false; }
  if (hasProject && !Projects.getProject(req.scope, attach.project_id)) { badRequest(res, 'unknown project'); return false; }
  return true;
}

router.get('/notes', (req, res) => {
  res.json(Notes.listNotes(req.scope, {
    standalone: req.query.standalone === '1',
    taskId: req.query.task_id,
    projectId: req.query.project_id,
  }));
});

// Defined before /notes/:id so "scratch" isn't matched as an id.
router.get('/notes/scratch', (req, res) => {
  res.json(Notes.getScratchNote(req.scope));
});

router.post('/notes', (req, res) => {
  const b = req.body || {};
  if (!validateAttachment(req, res, { task_id: b.task_id ?? null, project_id: b.project_id ?? null })) return;
  let blocks = [];
  if ('blocks' in b) {
    blocks = sanitizeBlocks(b.blocks);
    if (blocks === null) return badRequest(res, 'blocks must be an array');
  } else if (b.body) {
    blocks = [{ id: 'seed', x: 16, y: 16, text: String(b.body) }];
  }
  res.status(201).json(Notes.createNote(req.scope, {
    title: b.title || '',
    body: blocksToBody(blocks),
    blocks: JSON.stringify(blocks),
    project_id: b.project_id || null,
    task_id: b.task_id || null,
  }));
});

router.get('/notes/:id', (req, res) => {
  const note = Notes.getNote(req.scope, req.params.id);
  if (!note) return notFound(res, 'note');
  res.json(note);
});

router.patch('/notes/:id', (req, res) => {
  const note = Notes.getNote(req.scope, req.params.id);
  if (!note) return notFound(res, 'note');
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
  if (!validateAttachment(req, res, { task_id: effTask, project_id: effProject })) return;

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

  res.json(Notes.updateNote(req.scope, note, updates));
});

router.delete('/notes/:id', (req, res) => {
  const note = Notes.getNote(req.scope, req.params.id);
  if (!note) return notFound(res, 'note');
  if (note.is_scratch) return badRequest(res, 'the scratch note cannot be deleted');
  Notes.deleteNote(req.scope, note);
  res.json({ ok: true });
});

// ---------- development tracking: epics / stories / roadmap ----------

router.get('/epics', (req, res) => {
  res.json(Dev.listEpics(req.scope, { projectId: req.query.project_id }));
});

router.post('/epics', (req, res) => {
  const b = req.body || {};
  if (!b.project_id) return badRequest(res, 'project_id is required');
  if (!Projects.getProject(req.scope, b.project_id)) return badRequest(res, 'project not found');
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.status && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  for (const key of ['start_date', 'target_date'])
    if (b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  res.status(201).json(Dev.createEpic(req.scope, {
    project_id: b.project_id,
    title: String(b.title).trim(),
    description: b.description || '',
    status: b.status || 'backlog',
    start_date: b.start_date || null,
    target_date: b.target_date || null,
  }));
});

router.patch('/epics/:id', (req, res) => {
  const epic = Dev.getEpic(req.scope, req.params.id);
  if (!epic) return notFound(res, 'epic');
  const b = req.body || {};
  if ('status' in b && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  for (const key of ['start_date', 'target_date'])
    if (key in b && b[key] != null && !isValidISODate(b[key])) return badRequest(res, `invalid ${key}`);
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');
  const updates = {};
  for (const key of ['title', 'description', 'status', 'start_date', 'target_date', 'sort_order']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  res.json(Dev.updateEpic(req.scope, epic, updates));
});

router.delete('/epics/:id', (req, res) => {
  const epic = Dev.getEpic(req.scope, req.params.id);
  if (!epic) return notFound(res, 'epic');
  Dev.deleteEpic(req.scope, epic);
  res.json({ ok: true });
});

router.get('/stories', (req, res) => {
  res.json(Dev.listStories(req.scope, { epicId: req.query.epic_id, projectId: req.query.project_id }));
});

router.post('/stories', (req, res) => {
  const b = req.body || {};
  if (!b.epic_id) return badRequest(res, 'epic_id is required');
  if (!Dev.getEpic(req.scope, b.epic_id)) return badRequest(res, 'epic not found');
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.status && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if (b.due_date != null && !isValidISODate(b.due_date)) return badRequest(res, 'invalid due_date');
  res.status(201).json(Dev.createStory(req.scope, {
    epic_id: b.epic_id,
    title: String(b.title).trim(),
    description: b.description || '',
    status: b.status || 'backlog',
    due_date: b.due_date || null,
  }));
});

router.patch('/stories/:id', (req, res) => {
  const story = Dev.getStory(req.scope, req.params.id);
  if (!story) return notFound(res, 'story');
  const b = req.body || {};
  if ('status' in b && !DEV_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if ('due_date' in b && b.due_date != null && !isValidISODate(b.due_date)) return badRequest(res, 'invalid due_date');
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');
  if ('epic_id' in b && !Dev.getEpic(req.scope, b.epic_id)) return badRequest(res, 'epic not found');
  const updates = {};
  for (const key of ['title', 'description', 'status', 'due_date', 'sort_order', 'epic_id']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  res.json(Dev.updateStory(req.scope, story, updates));
});

router.delete('/stories/:id', (req, res) => {
  const story = Dev.getStory(req.scope, req.params.id);
  if (!story) return notFound(res, 'story');
  Dev.deleteStory(req.scope, story);
  res.json({ ok: true });
});

// Full dev tree for a project's Development tab.
router.get('/projects/:id/dev', (req, res) => {
  const project = Projects.getProject(req.scope, req.params.id);
  if (!project) return notFound(res, 'project');
  const epics = Dev.listProjectEpics(req.scope, project.id);
  const stories = Dev.listProjectStories(req.scope, project.id);
  const tasks = Tasks.listProjectStoryTasks(req.scope, project.id);

  const storyById = new Map(stories.map((s) => [s.id, { ...s, tasks: [] }]));
  for (const t of tasks) storyById.get(t.story_id)?.tasks.push(t);
  const epicById = new Map(epics.map((e) => [e.id, { ...e, stories: [] }]));
  for (const s of storyById.values()) epicById.get(s.epic_id)?.stories.push(s);
  res.json({ project, epics: [...epicById.values()] });
});

// Roadmap: epic-level timeline across dev-enabled projects (shaped like /gantt).
router.get('/roadmap', (req, res) => {
  const epics = Dev.listRoadmapEpics(req.scope)
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
  res.json({
    today: todayISO(),
    projects: Projects.listProjectsByName(req.scope, { trackDevOnly: true }),
    epics,
  });
});

// ---------- ideas + bugs backlog ----------

router.get('/ideas', (req, res) => {
  res.json(Ideas.listIdeas(req.scope, {
    kind: req.query.kind,
    status: req.query.status,
    projectId: req.query.project_id,
    q: req.query.q,
  }));
});

router.post('/ideas', (req, res) => {
  const b = req.body || {};
  if (!b.title || !String(b.title).trim()) return badRequest(res, 'title is required');
  if (b.kind && !IDEA_KINDS.includes(b.kind)) return badRequest(res, 'invalid kind');
  if (b.status && !IDEA_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if (b.project_id != null && !Projects.getProject(req.scope, b.project_id)) return badRequest(res, 'project not found');
  res.status(201).json(Ideas.createIdea(req.scope, {
    kind: b.kind || 'idea',
    title: String(b.title).trim(),
    description: b.description || '',
    project_id: b.project_id || null,
    status: b.status || 'open',
  }));
});

router.patch('/ideas/:id', (req, res) => {
  const idea = Ideas.getIdea(req.scope, req.params.id);
  if (!idea) return notFound(res, 'idea');
  const b = req.body || {};
  if ('status' in b && !IDEA_STATUSES.includes(b.status)) return badRequest(res, 'invalid status');
  if ('title' in b && !String(b.title).trim()) return badRequest(res, 'title cannot be empty');
  if ('project_id' in b && b.project_id != null && !Projects.getProject(req.scope, b.project_id)) {
    return badRequest(res, 'project not found');
  }
  const updates = {};
  for (const key of ['title', 'description', 'status', 'project_id']) if (key in b) updates[key] = b[key];
  if ('title' in updates) updates.title = String(updates.title).trim();
  res.json(Ideas.updateIdea(req.scope, idea, updates));
});

router.delete('/ideas/:id', (req, res) => {
  const idea = Ideas.getIdea(req.scope, req.params.id);
  if (!idea) return notFound(res, 'idea');
  Ideas.deleteIdea(req.scope, idea);
  res.json({ ok: true });
});

// Promote an idea into the dev hierarchy (epic / story / task), marking the
// idea as promoted. The idea's title/description seed the new entity.
router.post('/ideas/:id/promote', (req, res) => {
  const idea = Ideas.getIdea(req.scope, req.params.id);
  if (!idea) return notFound(res, 'idea');
  const b = req.body || {};
  const level = b.level;
  if (!['epic', 'story', 'task'].includes(level)) return badRequest(res, 'level must be epic, story or task');

  if (level === 'epic') {
    const projectId = b.project_id || idea.project_id;
    if (!projectId) return badRequest(res, 'project_id is required to promote to an epic');
    const project = Projects.getProject(req.scope, projectId);
    if (!project) return badRequest(res, 'project not found');
    return res.status(201).json({ level, epic: Ideas.promoteToEpic(req.scope, idea, project.id) });
  }
  if (level === 'story') {
    if (!b.epic_id) return badRequest(res, 'epic_id is required to promote to a story');
    const epic = Dev.getEpic(req.scope, b.epic_id);
    if (!epic) return badRequest(res, 'epic not found');
    return res.status(201).json({ level, story: Ideas.promoteToStory(req.scope, idea, epic.id) });
  }

  let projectId = b.project_id || idea.project_id || null;
  if (projectId != null && !Projects.getProject(req.scope, projectId)) return badRequest(res, 'project not found');
  let storyId = null;
  const tags = [];
  if (b.story_id != null) {
    const story = Dev.storyOwner(req.scope, b.story_id);
    if (!story) return badRequest(res, 'story not found');
    storyId = story.id;
    projectId = story.project_id;
    tags.push(DEV_TAG);
  }
  return res.status(201).json({ level, task: Ideas.promoteToTask(req.scope, idea, { projectId, storyId, tags }) });
});

// Convert an existing task into a backlog idea or bug (move: task is removed).
function convertTaskToBacklog(req, res, kind) {
  const task = Tasks.getTask(req.scope, req.params.id);
  if (!task) return notFound(res, 'task');
  res.status(201).json(Ideas.convertTaskToBacklog(req.scope, task, kind));
}
router.post('/tasks/:id/convert-to-idea', (req, res) => convertTaskToBacklog(req, res, 'idea'));
router.post('/tasks/:id/convert-to-bug', (req, res) => convertTaskToBacklog(req, res, 'bug'));

// ---------- kanban boards ----------

router.get('/boards', (req, res) => {
  res.json(Boards.listBoards(req.scope));
});

router.post('/boards', (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'name is required');
  res.status(201).json(Boards.createBoard(req.scope, String(b.name).trim()));
});

router.patch('/boards/:id', (req, res) => {
  const board = Boards.getBoard(req.scope, req.params.id);
  if (!board) return notFound(res, 'board');
  const b = req.body || {};
  if ('name' in b && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
  const updates = {};
  if ('name' in b) updates.name = String(b.name).trim();
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  res.json(Boards.updateBoard(req.scope, board, updates));
});

router.delete('/boards/:id', (req, res) => {
  const board = Boards.getBoard(req.scope, req.params.id);
  if (!board) return notFound(res, 'board');
  Boards.deleteBoard(req.scope, board);
  res.json({ ok: true });
});

router.post('/boards/:id/move', (req, res) => {
  const board = Boards.getBoard(req.scope, req.params.id);
  if (!board) return notFound(res, 'board');
  const target = resolveMoveTarget(req, res);
  if (!target) return undefined;
  Boards.moveBoardToWorkspace(req.scope, board, target.id);
  res.json({
    board: Boards.getBoardAnywhere(req.scope, board.id),
    workspace: target,
    active_id: req.scope.workspaceId,
  });
});

router.post('/boards/:id/columns', (req, res) => {
  const board = Boards.getBoard(req.scope, req.params.id);
  if (!board) return notFound(res, 'board');
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return badRequest(res, 'name is required');
  if (!DEV_STATUSES.includes(b.stage)) return badRequest(res, 'invalid stage');
  res.status(201).json(Boards.addColumn(req.scope, board, { name: String(b.name).trim(), stage: b.stage }));
});

router.patch('/board-columns/:id', (req, res) => {
  const col = Boards.getColumn(req.scope, req.params.id);
  if (!col) return notFound(res, 'column');
  const b = req.body || {};
  if ('stage' in b && !DEV_STATUSES.includes(b.stage)) return badRequest(res, 'invalid stage');
  if ('name' in b && !String(b.name).trim()) return badRequest(res, 'name cannot be empty');
  const updates = {};
  if ('name' in b) updates.name = String(b.name).trim();
  if ('stage' in b) updates.stage = b.stage;
  if ('sort_order' in b && Number.isFinite(+b.sort_order)) updates.sort_order = Math.trunc(+b.sort_order);
  res.json(Boards.updateColumn(req.scope, col, updates));
});

router.delete('/board-columns/:id', (req, res) => {
  const col = Boards.getColumn(req.scope, req.params.id);
  if (!col) return notFound(res, 'column');
  res.json(Boards.deleteColumn(req.scope, col));
});

// Unified card feed for a board: epics, stories and tasks in one normalised
// shape. Cross-project by default; `levels`, `project_id` and `q` narrow it.
router.get('/boards/:id/cards', (req, res) => {
  // A board id left over from before a workspace switch resolves to nothing,
  // so it cannot render the other workspace's cards.
  const board = Boards.getBoard(req.scope, req.params.id);
  if (!board) return notFound(res, 'board');

  const levels = req.query.levels
    ? String(req.query.levels).split(',').map((s) => s.trim()).filter((s) => CARD_TYPES.includes(s))
    : CARD_TYPES;
  const projectId = req.query.project_id ? Number(req.query.project_id) : null;
  const q = req.query.q ? `%${req.query.q}%` : null;
  const cards = [];

  if (levels.includes('epic')) {
    for (const e of Dev.listBoardEpics(req.scope, { projectId, q })) {
      cards.push({
        type: 'epic', id: e.id, title: e.title, stage: e.status, sort_order: e.sort_order,
        project_id: e.project_id, project_name: e.project_name, project_color: e.project_color,
        epic_id: e.id, parent_title: null, target_date: e.target_date, child_count: e.story_count,
      });
    }
  }

  if (levels.includes('story')) {
    for (const s of Dev.listBoardStories(req.scope, { projectId, q })) {
      cards.push({
        type: 'story', id: s.id, title: s.title, stage: s.status, sort_order: s.sort_order,
        project_id: s.project_id, project_name: s.project_name, project_color: s.project_color,
        epic_id: s.epic_id, parent_title: s.epic_title, due_date: s.due_date, child_count: s.task_count,
      });
    }
  }

  if (levels.includes('task')) {
    for (const t of Tasks.listBoardTasks(req.scope, { projectId, q })) {
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
    const epic = Dev.getEpic(req.scope, id);
    if (!epic) return notFound(res, 'epic');
    return res.json({ type: 'epic', card: Dev.setEpicStage(req.scope, epic, b.stage, sortOrder) });
  }
  if (b.type === 'story') {
    const story = Dev.getStory(req.scope, id);
    if (!story) return notFound(res, 'story');
    return res.json({ type: 'story', card: Dev.setStoryStage(req.scope, story, b.stage, sortOrder) });
  }

  // Tasks: move the stage and keep status/completed_at consistent so My Day,
  // scoring and the task lists agree with the board.
  const task = Tasks.getTask(req.scope, id);
  if (!task) return notFound(res, 'task');
  const nextStatus = task.status === 'cancelled' ? task.status : statusFromStage(b.stage);
  Tasks.updateTask(req.scope, task.id, {
    dev_stage: b.stage,
    status: nextStatus,
    completed_at: nextStatus === 'done' ? (task.completed_at || new Date().toISOString()) : null,
    ...(sortOrder == null ? {} : { sort_order: sortOrder }),
  });
  res.json({ type: 'task', card: Tasks.getTask(req.scope, task.id) });
});

// ---------- tags / settings / ai ----------

router.get('/tags', (req, res) => {
  res.json(Tasks.listOpenTags(req.scope));
});

// The stored Anthropic API key is write-only from the client's perspective —
// GET/PATCH never echo it back, only whether one is configured, where it
// came from, and its last 4 characters so the user can confirm which key is
// active without re-reading the secret itself.
function publicSettings(scope) {
  const s = getSettings(scope);
  const dbKey = (s.anthropic_api_key || '').trim();
  const hasDbKey = !!dbKey;
  const hasEnvKey = !!process.env.ANTHROPIC_API_KEY;
  return {
    workday_minutes: s.workday_minutes,
    workday_start: s.workday_start,
    ai_available: aiAvailable(scope),
    ai_key_source: hasDbKey ? 'settings' : hasEnvKey ? 'env' : 'none',
    ai_key_last4: hasDbKey ? dbKey.slice(-4) : null,
    ai_prompt: s.ai_prompt || '',
  };
}

router.get('/settings', (req, res) => res.json(publicSettings(req.scope)));

router.patch('/settings', (req, res) => {
  const b = req.body || {};
  if ('workday_minutes' in b) {
    const v = Number(b.workday_minutes);
    if (!Number.isInteger(v) || v < 60 || v > 1440) return badRequest(res, 'workday_minutes must be 60-1440');
    setSetting(req.scope, 'workday_minutes', v);
  }
  if ('workday_start' in b) setSetting(req.scope, 'workday_start', String(b.workday_start));
  if ('anthropic_api_key' in b) {
    if (typeof b.anthropic_api_key !== 'string') return badRequest(res, 'anthropic_api_key must be a string');
    const key = b.anthropic_api_key.trim();
    if (key.length > 300) return badRequest(res, 'API key is too long');
    if (key) setSetting(req.scope, 'anthropic_api_key', key);
    else deleteSetting(req.scope, 'anthropic_api_key');
  }
  if ('ai_prompt' in b) {
    if (typeof b.ai_prompt !== 'string') return badRequest(res, 'ai_prompt must be a string');
    const prompt = b.ai_prompt.trim();
    if (prompt.length > 2000) return badRequest(res, 'AI instructions are too long (max 2000 characters)');
    if (prompt) setSetting(req.scope, 'ai_prompt', prompt);
    else deleteSetting(req.scope, 'ai_prompt');
  }
  res.json(publicSettings(req.scope));
});

router.get('/ai/status', (req, res) => res.json({ available: aiAvailable(req.scope) }));

router.post('/ai/plan-day', async (req, res) => {
  const settings = getSettings(req.scope);
  const result = await planMyDay(req.scope, Tasks.listOpenTasks(req.scope), todayISO(), settings.workday_minutes);
  res.json(result);
});

router.post('/ai/prioritise', async (req, res) => {
  let tasks = Tasks.listOpenTasks(req.scope);
  if (req.body?.project_id) tasks = tasks.filter((t) => t.project_id === Number(req.body.project_id));
  const result = await prioritise(req.scope, tasks, todayISO());
  res.json(result);
});
