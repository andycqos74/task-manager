// Note data access.
//
// Saved notes belong to a workspace. The scratch pad is the one deliberate
// exception: a single global note (workspace_id NULL, is_scratch 1) shared by
// every workspace, so it is reachable from any scope.
//
// NOTE FOR PHASE 1: that exception does not survive user accounts — a global
// scratch note would be shared between people. It has to become one scratch
// note per user (a user_id column, or a per-user settings key holding its id)
// at the same time as the rest of the ownership work.
import { db } from '../db.js';

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

export function getNote(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return hydrateNote(
    db.prepare(`${NOTE_SELECT} WHERE n.id = ? AND (n.workspace_id = ? OR n.is_scratch = 1)`)
      .get(Number(id), scope.workspaceId) || null,
  );
}

export function listNotes(scope, { standalone = false, taskId = null, projectId = null } = {}) {
  // The scratch pad has its own endpoint, so it never appears in these lists.
  const clauses = ['n.workspace_id = ?'];
  const params = [scope.workspaceId];
  if (standalone) clauses.push('n.project_id IS NULL AND n.task_id IS NULL AND n.is_scratch = 0');
  if (taskId) { clauses.push('n.task_id = ?'); params.push(Number(taskId)); }
  if (projectId) { clauses.push('n.project_id = ?'); params.push(Number(projectId)); }
  return db
    .prepare(`${NOTE_SELECT} WHERE ${clauses.join(' AND ')} ORDER BY n.updated_at DESC`)
    .all(...params)
    .map(hydrateNote);
}

export function getScratchNote(scope) {
  let row = db.prepare('SELECT id FROM notes WHERE is_scratch = 1 ORDER BY id LIMIT 1').get();
  if (!row) {
    row = { id: db.prepare("INSERT INTO notes (title, is_scratch) VALUES ('Scratch', 1)").run().lastInsertRowid };
  }
  return getNote(scope, row.id);
}

export function createNote(scope, f) {
  const id = db
    .prepare('INSERT INTO notes (workspace_id, title, body, blocks, project_id, task_id) VALUES (?,?,?,?,?,?)')
    .run(scope.workspaceId, f.title, f.body, f.blocks, f.project_id, f.task_id).lastInsertRowid;
  return getNote(scope, id);
}

const UPDATABLE = new Set(['title', 'body', 'blocks', 'task_id', 'project_id']);

export function updateNote(scope, note, updates) {
  const keys = Object.keys(updates).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE notes SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), note.id);
  }
  return getNote(scope, note.id);
}

export function deleteNote(scope, note) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
}
