// Workspaces are the top level, so they are not scoped to a workspace — they
// are scoped to whoever owns them. In single-tenant mode that is everyone;
// phase 1 adds `AND user_id = ?` to each query here and nowhere else.
import { db, setSetting, seedBoard } from '../db.js';

export function listWorkspaces(scope) {
  return db.prepare('SELECT * FROM workspaces ORDER BY sort_order, id').all();
}

export function getWorkspace(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(id)) || null;
}

export function countWorkspaces(scope) {
  return db.prepare('SELECT COUNT(*) AS c FROM workspaces').get().c;
}

export function createWorkspace(scope, { name, color }) {
  return db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM workspaces').get().m;
    const id = db
      .prepare('INSERT INTO workspaces (name, color, sort_order) VALUES (?,?,?)')
      .run(name, color || 'oklch(60% 0.13 66)', max + 1).lastInsertRowid;
    seedBoard(id); // every workspace starts with its own default board
    return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id);
  })();
}

const UPDATABLE = new Set(['name', 'color', 'sort_order']);

export function updateWorkspace(scope, ws, updates) {
  const keys = Object.keys(updates).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE workspaces SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), ws.id);
  }
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(ws.id);
}

// Removes everything inside it, by foreign-key cascade.
export function deleteWorkspace(scope, ws) {
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
}

// Which workspace subsequent requests are scoped to. Global server state
// today; phase 1 moves it into the signed-in user's own settings, which is
// what stops two users fighting over one value.
export function setActiveWorkspace(scope, ws) {
  setSetting('active_workspace_id', ws.id);
}
