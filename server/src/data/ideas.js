// Ideas and bugs: a capture pool that belongs to a workspace and can be
// promoted into the dev hierarchy.
import { db } from '../db.js';
import { createEpic, createStory } from './dev.js';
import { createTask, getTask } from './tasks.js';

const IDEA_SELECT = `SELECT i.*, p.name AS project_name, p.color AS project_color
                     FROM ideas i LEFT JOIN projects p ON p.id = i.project_id`;

export function getIdea(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare(`${IDEA_SELECT} WHERE i.id = ? AND i.workspace_id = ?`).get(Number(id), scope.workspaceId) || null;
}

export function listIdeas(scope, { kind = null, status = null, projectId = null, q = null } = {}) {
  const clauses = ['i.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (kind) { clauses.push('i.kind = ?'); params.push(kind); }
  if (status) { clauses.push('i.status = ?'); params.push(status); }
  if (projectId === 'none') {
    clauses.push('i.project_id IS NULL');
  } else if (projectId) {
    clauses.push('i.project_id = ?');
    params.push(Number(projectId));
  }
  if (q) {
    clauses.push('(i.title LIKE ? OR i.description LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like);
  }
  return db
    .prepare(`${IDEA_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY i.created_at DESC, i.id DESC`)
    .all(...params);
}

export function createIdea(scope, f) {
  const id = db
    .prepare('INSERT INTO ideas (workspace_id, kind, title, description, project_id, status) VALUES (?,?,?,?,?,?)')
    .run(scope.workspaceId, f.kind, f.title, f.description, f.project_id, f.status).lastInsertRowid;
  return getIdea(scope, id);
}

const UPDATABLE = new Set(['title', 'description', 'status', 'project_id']);

export function updateIdea(scope, idea, updates) {
  const keys = Object.keys(updates).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE ideas SET ${sets}, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
      .run(...keys.map((k) => updates[k]), idea.id, scope.workspaceId);
  }
  return getIdea(scope, idea.id);
}

export function deleteIdea(scope, idea) {
  db.prepare('DELETE FROM ideas WHERE id = ? AND workspace_id = ?').run(idea.id, scope.workspaceId);
}

export function markPromoted(scope, idea) {
  db.prepare(`UPDATE ideas SET status = 'promoted', updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
    .run(idea.id, scope.workspaceId);
}

// Convert a task into a backlog idea or bug: the task is removed, so the two
// halves travel in one transaction.
export function convertTaskToBacklog(scope, task, kind) {
  return db.transaction(() => {
    const id = db
      .prepare('INSERT INTO ideas (workspace_id, kind, title, description, project_id) VALUES (?,?,?,?,?)')
      .run(scope.workspaceId, kind, task.title, task.notes || '', task.project_id || null).lastInsertRowid;
    db.prepare('DELETE FROM tasks WHERE id = ? AND workspace_id = ?').run(task.id, scope.workspaceId);
    return getIdea(scope, id);
  })();
}

// ---------- promotion into the dev hierarchy ----------
// Each promotion creates the new entity and marks the idea promoted in one
// transaction, so an idea is never left promoted with nothing to show for it.
// The caller has already ownership-checked the idea and the destination.

export function promoteToEpic(scope, idea, projectId) {
  return db.transaction(() => {
    const epic = createEpic(scope, {
      project_id: projectId, title: idea.title, description: idea.description,
      status: 'backlog', start_date: null, target_date: null,
    });
    markPromoted(scope, idea);
    return epic;
  })();
}

export function promoteToStory(scope, idea, epicId) {
  return db.transaction(() => {
    const story = createStory(scope, {
      epic_id: epicId, title: idea.title, description: idea.description,
      status: 'backlog', due_date: null,
    });
    markPromoted(scope, idea);
    return story;
  })();
}

export function promoteToTask(scope, idea, { projectId, storyId, tags }) {
  return db.transaction(() => {
    const id = createTask(scope, {
      project_id: projectId, story_id: storyId, title: idea.title,
      notes: idea.description, tags: JSON.stringify(tags),
    });
    markPromoted(scope, idea);
    return getTask(scope, id);
  })();
}
