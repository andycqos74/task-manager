// Workspaces are the top level: they are not scoped to a workspace, they ARE
// the scope. This file is where ownership is established — every query filters
// on user_id — and the invariant documented in scope.js is what lets the rest
// of the data layer get away with filtering on workspace_id alone.
import { db, seedBoard } from '../db.js';
import { setActiveWorkspaceId } from '../scope.js';

export function listWorkspaces(scope) {
  return db.prepare('SELECT * FROM workspaces WHERE user_id = ? ORDER BY sort_order, id').all(scope.userId);
}

export function getWorkspace(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare('SELECT * FROM workspaces WHERE id = ? AND user_id = ?').get(Number(id), scope.userId) || null;
}

export function countWorkspaces(scope) {
  return db.prepare('SELECT COUNT(*) AS c FROM workspaces WHERE user_id = ?').get(scope.userId).c;
}

export function createWorkspace(scope, { name, color }) {
  return db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM workspaces WHERE user_id = ?')
      .get(scope.userId).m;
    const id = db
      .prepare('INSERT INTO workspaces (user_id, name, color, sort_order) VALUES (?,?,?,?)')
      .run(scope.userId, name, color || 'oklch(60% 0.13 66)', max + 1).lastInsertRowid;
    seedBoard(id); // every workspace starts with its own default board
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  })();
}

const UPDATABLE = new Set(['name', 'color', 'sort_order']);

export function updateWorkspace(scope, ws, updates) {
  const keys = Object.keys(updates).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE workspaces SET ${sets}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .run(...keys.map((k) => updates[k]), ws.id, scope.userId);
  }
  return getWorkspace(scope, ws.id);
}

// Removes everything inside it, by foreign-key cascade.
export function deleteWorkspace(scope, ws) {
  db.prepare('DELETE FROM workspaces WHERE id = ? AND user_id = ?').run(ws.id, scope.userId);
}

// Which workspace this user's subsequent requests are scoped to. Per-user, so
// two people signed in at once cannot overwrite each other's position.
export function setActiveWorkspace(scope, ws) {
  setActiveWorkspaceId(scope.userId, ws.id);
}
