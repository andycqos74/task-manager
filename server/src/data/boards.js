// Kanban boards. Boards belong to a workspace; columns are reached only
// through their board, which is ownership-checked first.
import { db } from '../db.js';

const DEFAULT_COLUMNS = [
  ['Backlog', 'backlog'], ['In Progress', 'in_progress'], ['In Review', 'in_review'],
  ['Done', 'done'], ['Deployed', 'deployed'],
];

function columnsOf(boardId) {
  return db.prepare('SELECT * FROM board_columns WHERE board_id = ? ORDER BY sort_order, id').all(boardId);
}

export function getBoard(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  const board = db.prepare('SELECT * FROM boards WHERE id = ? AND workspace_id = ?').get(Number(id), scope.workspaceId);
  return board ? { ...board, columns: columnsOf(board.id) } : null;
}

// Only for the move endpoint, which re-reads the board after it has left the
// active workspace. Phase 1 restricts this to the owner's own workspaces.
export function getBoardAnywhere(scope, id) {
  const board = db.prepare('SELECT * FROM boards WHERE id = ?').get(Number(id));
  return board ? { ...board, columns: columnsOf(board.id) } : null;
}

export function listBoards(scope) {
  return db
    .prepare('SELECT * FROM boards WHERE workspace_id = ? ORDER BY sort_order, id')
    .all(scope.workspaceId)
    .map((b) => ({ ...b, columns: columnsOf(b.id) }));
}

export function createBoard(scope, name) {
  return db.transaction(() => {
    const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM boards WHERE workspace_id = ?')
      .get(scope.workspaceId).m;
    const id = db.prepare('INSERT INTO boards (workspace_id, name, sort_order) VALUES (?,?,?)')
      .run(scope.workspaceId, name, max + 1).lastInsertRowid;
    const addCol = db.prepare('INSERT INTO board_columns (board_id, name, stage, sort_order) VALUES (?,?,?,?)');
    DEFAULT_COLUMNS.forEach(([n, stage], i) => addCol.run(id, n, stage, i));
    return getBoard(scope, id);
  })();
}

const BOARD_UPDATABLE = new Set(['name', 'sort_order']);

export function updateBoard(scope, board, updates) {
  const keys = Object.keys(updates).filter((k) => BOARD_UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE boards SET ${sets}, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
      .run(...keys.map((k) => updates[k]), board.id, scope.workspaceId);
  }
  return getBoard(scope, board.id);
}

// Cascades to columns.
export function deleteBoard(scope, board) {
  db.prepare('DELETE FROM boards WHERE id = ? AND workspace_id = ?').run(board.id, scope.workspaceId);
}

// Move a board (with its columns) to another workspace. Boards are containers
// of columns, not of cards — the cards shown are always the ones living in the
// board's workspace, so a moved board renders the destination's work.
export function moveBoardToWorkspace(scope, board, targetId) {
  if (board.workspace_id === targetId) return;
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM boards WHERE workspace_id = ?').get(targetId).m;
  db.prepare(`UPDATE boards SET workspace_id = ?, sort_order = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(targetId, max + 1, board.id);
}

// ---------- columns ----------

export function addColumn(scope, board, { name, stage }) {
  const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM board_columns WHERE board_id = ?').get(board.id).m;
  db.prepare('INSERT INTO board_columns (board_id, name, stage, sort_order) VALUES (?,?,?,?)')
    .run(board.id, name, stage, max + 1);
  return getBoard(scope, board.id);
}

export function getColumn(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db
    .prepare(`SELECT c.* FROM board_columns c JOIN boards b ON b.id = c.board_id
              WHERE c.id = ? AND b.workspace_id = ?`)
    .get(Number(id), scope.workspaceId) || null;
}

const COLUMN_UPDATABLE = new Set(['name', 'stage', 'sort_order']);

export function updateColumn(scope, col, updates) {
  const keys = Object.keys(updates).filter((k) => COLUMN_UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE board_columns SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
      .run(...keys.map((k) => updates[k]), col.id);
  }
  return getBoard(scope, col.board_id);
}

export function deleteColumn(scope, col) {
  db.prepare('DELETE FROM board_columns WHERE id = ?').run(col.id);
  return getBoard(scope, col.board_id);
}
