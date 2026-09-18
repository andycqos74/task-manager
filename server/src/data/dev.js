// Epics and user stories. Neither carries a workspace of its own — an epic
// belongs to a project and a story to an epic — so every accessor reaches the
// workspace through that chain and filters on it. A story id from another
// workspace therefore resolves to nothing rather than to someone else's row.
import { db } from '../db.js';

const EPIC_SELECT = `SELECT e.*, p.name AS project_name, p.color AS project_color,
        (SELECT COUNT(*) FROM user_stories s WHERE s.epic_id = e.id) AS story_count,
        (SELECT COUNT(*) FROM tasks t JOIN user_stories s ON s.id = t.story_id WHERE s.epic_id = e.id) AS task_count
      FROM epics e JOIN projects p ON p.id = e.project_id`;

const STORY_SELECT = `SELECT s.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id) AS task_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id AND t.status = 'done') AS done_count
      FROM user_stories s JOIN epics e ON e.id = s.epic_id JOIN projects p ON p.id = e.project_id`;

// ---------- epics ----------

export function getEpic(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare(`${EPIC_SELECT} WHERE e.id = ? AND p.workspace_id = ?`).get(Number(id), scope.workspaceId) || null;
}

export function listEpics(scope, { projectId = null } = {}) {
  const clauses = ['p.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (projectId) {
    clauses.push('e.project_id = ?');
    params.push(Number(projectId));
  }
  return db.prepare(`${EPIC_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY e.sort_order, e.id`).all(...params);
}

export function listProjectEpics(scope, projectId) {
  return db
    .prepare(`SELECT e.* FROM epics e JOIN projects p ON p.id = e.project_id
              WHERE e.project_id = ? AND p.workspace_id = ? ORDER BY e.sort_order, e.id`)
    .all(projectId, scope.workspaceId);
}

export function createEpic(scope, f) {
  const id = db
    .prepare('INSERT INTO epics (project_id, title, description, status, start_date, target_date) VALUES (?,?,?,?,?,?)')
    .run(f.project_id, f.title, f.description, f.status, f.start_date, f.target_date).lastInsertRowid;
  return getEpic(scope, id);
}

const EPIC_UPDATABLE = new Set(['title', 'description', 'status', 'start_date', 'target_date', 'sort_order']);

export function updateEpic(scope, epic, updates) {
  const keys = Object.keys(updates).filter((k) => EPIC_UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE epics SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), epic.id);
  }
  return getEpic(scope, epic.id);
}

// Cascades to stories; tasks.story_id becomes null.
export function deleteEpic(scope, epic) {
  db.prepare('DELETE FROM epics WHERE id = ?').run(epic.id);
}

// Epic-level timeline across dev-enabled projects, for the roadmap.
export function listRoadmapEpics(scope) {
  return db
    .prepare(`SELECT e.*, p.name AS project_name, p.color AS project_color
      FROM epics e JOIN projects p ON p.id = e.project_id
      WHERE p.track_dev = 1 AND p.workspace_id = ? ORDER BY e.project_id, e.start_date, e.target_date`)
    .all(scope.workspaceId);
}

export function listBoardEpics(scope, { projectId = null, q = null } = {}) {
  const where = ['p.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (projectId) { where.push('e.project_id = ?'); params.push(projectId); }
  if (q) { where.push('(e.title LIKE ? OR e.description LIKE ?)'); params.push(q, q); }
  return db.prepare(`SELECT e.*, p.name AS project_name, p.color AS project_color,
      (SELECT COUNT(*) FROM user_stories s WHERE s.epic_id = e.id) AS story_count
      FROM epics e JOIN projects p ON p.id = e.project_id
      WHERE ${where.join(' AND ')} ORDER BY e.sort_order, e.id`).all(...params);
}

export function setEpicStage(scope, epic, stage, sortOrder) {
  db.prepare(`UPDATE epics SET status = ?, sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`)
    .run(stage, sortOrder, epic.id);
  return getEpic(scope, epic.id);
}

// ---------- user stories ----------

export function getStory(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare(`${STORY_SELECT} WHERE s.id = ? AND p.workspace_id = ?`).get(Number(id), scope.workspaceId) || null;
}

// Resolve a story to its owning project (via its epic). Used when a task is
// linked to a story so the task inherits the right project.
export function storyOwner(scope, storyId) {
  if (!Number.isFinite(Number(storyId))) return null;
  return db
    .prepare(`SELECT s.id, e.project_id FROM user_stories s
              JOIN epics e ON e.id = s.epic_id
              JOIN projects p ON p.id = e.project_id
              WHERE s.id = ? AND p.workspace_id = ?`)
    .get(Number(storyId), scope.workspaceId) || null;
}

export function listStories(scope, { epicId = null, projectId = null } = {}) {
  const clauses = ['p.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (epicId) {
    clauses.push('s.epic_id = ?');
    params.push(Number(epicId));
  } else if (projectId) {
    clauses.push('e.project_id = ?');
    params.push(Number(projectId));
  }
  return db.prepare(`${STORY_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY s.sort_order, s.id`).all(...params);
}

export function listProjectStories(scope, projectId) {
  return db
    .prepare(`SELECT s.* FROM user_stories s JOIN epics e ON e.id = s.epic_id JOIN projects p ON p.id = e.project_id
              WHERE e.project_id = ? AND p.workspace_id = ? ORDER BY s.sort_order, s.id`)
    .all(projectId, scope.workspaceId);
}

export function createStory(scope, f) {
  const id = db
    .prepare('INSERT INTO user_stories (epic_id, title, description, status, due_date) VALUES (?,?,?,?,?)')
    .run(f.epic_id, f.title, f.description, f.status, f.due_date).lastInsertRowid;
  return getStory(scope, id);
}

const STORY_UPDATABLE = new Set(['title', 'description', 'status', 'due_date', 'sort_order', 'epic_id']);

export function updateStory(scope, story, updates) {
  const keys = Object.keys(updates).filter((k) => STORY_UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE user_stories SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), story.id);
  }
  return getStory(scope, story.id);
}

// tasks.story_id becomes null.
export function deleteStory(scope, story) {
  db.prepare('DELETE FROM user_stories WHERE id = ?').run(story.id);
}

export function listBoardStories(scope, { projectId = null, q = null } = {}) {
  const where = ['p.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (projectId) { where.push('e.project_id = ?'); params.push(projectId); }
  if (q) { where.push('(s.title LIKE ? OR s.description LIKE ?)'); params.push(q, q); }
  return db.prepare(`SELECT s.*, e.title AS epic_title, e.project_id AS project_id,
      p.name AS project_name, p.color AS project_color,
      (SELECT COUNT(*) FROM tasks t WHERE t.story_id = s.id) AS task_count
      FROM user_stories s JOIN epics e ON e.id = s.epic_id JOIN projects p ON p.id = e.project_id
      WHERE ${where.join(' AND ')} ORDER BY s.sort_order, s.id`).all(...params);
}

export function setStoryStage(scope, story, stage, sortOrder) {
  db.prepare(`UPDATE user_stories SET status = ?, sort_order = COALESCE(?, sort_order), updated_at = datetime('now') WHERE id = ?`)
    .run(stage, sortOrder, story.id);
  return getStory(scope, story.id);
}
