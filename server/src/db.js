import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'tasks.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
-- Workspaces are the top level: each keeps its own projects, tasks, notes,
-- ideas/bugs, dev hierarchy and boards, so work and personal stay separate.
-- Settings (incl. the AI key) and the scratch pad are deliberately global.
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT 'oklch(60% 0.13 66)',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','on_hold','completed','archived')),
  color TEXT NOT NULL DEFAULT '#5b7c99',
  track_dev INTEGER NOT NULL DEFAULT 0,
  start_date TEXT,
  target_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  story_id INTEGER REFERENCES user_stories(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','done','cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
  due_date TEXT,
  do_date TEXT,
  do_date_is_manual INTEGER NOT NULL DEFAULT 0,
  estimated_minutes INTEGER,
  my_day_date TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  recurrence TEXT,
  completed_at TEXT,
  -- Kanban board stage. Finer-grained than status (adds in_review/deployed)
  -- and kept in sync with it by the task routes.
  dev_stage TEXT NOT NULL DEFAULT 'backlog' CHECK (dev_stage IN ('backlog','in_progress','in_review','done','deployed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS subtasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- notes.workspace_id is NULL for the global scratch pad, set for saved notes.
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  blocks TEXT NOT NULL DEFAULT '[]',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  is_scratch INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Development planning tiers: project -> epic -> user story -> task (task.story_id).
CREATE TABLE IF NOT EXISTS epics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','in_progress','in_review','done','deployed')),
  start_date TEXT,
  target_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_id INTEGER NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog' CHECK (status IN ('backlog','in_progress','in_review','done','deployed')),
  due_date TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Ideas + bugs backlog: a separate capture pool, promotable into the dev
-- hierarchy. The kind column distinguishes the two lists (same shape otherwise).
CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea','bug')),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','promoted','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Kanban boards. Boards are cross-project; columns are configurable and each
-- maps to one development stage (several columns may share a stage).
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS board_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('backlog','in_progress','in_review','done','deployed')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_board_columns_board ON board_columns(board_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_do_date ON tasks(do_date);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_notes_project ON notes(project_id);
CREATE INDEX IF NOT EXISTS idx_notes_task ON notes(task_id);
CREATE INDEX IF NOT EXISTS idx_epics_project ON epics(project_id);
CREATE INDEX IF NOT EXISTS idx_stories_epic ON user_stories(epic_id);
CREATE INDEX IF NOT EXISTS idx_ideas_project ON ideas(project_id);
`);

// Lightweight migration: add a column to an existing table if it's missing.
// (CREATE TABLE IF NOT EXISTS won't alter tables created by earlier versions.)
function ensureColumn(table, column, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('notes', 'blocks', "blocks TEXT NOT NULL DEFAULT '[]'");
// Development-tracking additions (retrofit for pre-existing databases).
ensureColumn('projects', 'track_dev', 'track_dev INTEGER NOT NULL DEFAULT 0');
ensureColumn('tasks', 'story_id', 'story_id INTEGER REFERENCES user_stories(id) ON DELETE SET NULL');
ensureColumn('ideas', 'kind', "kind TEXT NOT NULL DEFAULT 'idea' CHECK (kind IN ('idea','bug'))");
// Kanban additions.
ensureColumn(
  'tasks',
  'dev_stage',
  "dev_stage TEXT NOT NULL DEFAULT 'backlog' CHECK (dev_stage IN ('backlog','in_progress','in_review','done','deployed'))",
);
ensureColumn('tasks', 'sort_order', 'sort_order INTEGER NOT NULL DEFAULT 0');
// Workspaces: every top-level entity belongs to one. Nullable with a NULL
// default, which is what SQLite requires when adding a REFERENCES column.
for (const table of ['projects', 'tasks', 'notes', 'ideas', 'boards']) {
  ensureColumn(table, 'workspace_id', 'workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE');
}
// Indexes on retrofitted columns created after the column is guaranteed to exist.
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_story ON tasks(story_id);');
db.exec('CREATE INDEX IF NOT EXISTS idx_ideas_kind ON ideas(kind);');
db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_dev_stage ON tasks(dev_stage);');
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_notes_workspace ON notes(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_ideas_workspace ON ideas(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_boards_workspace ON boards(workspace_id);
`);

// Align dev_stage with status for tasks predating the column (all default to
// 'backlog' on ALTER, which would wrongly park done/in-progress work there).
// Only touches rows still at the default, so it is safe to re-run.
db.exec(`
  UPDATE tasks SET dev_stage = 'done'
    WHERE dev_stage = 'backlog' AND status = 'done';
  UPDATE tasks SET dev_stage = 'in_progress'
    WHERE dev_stage = 'backlog' AND status = 'in_progress';
`);

// Ensure at least one workspace exists, then adopt any pre-workspace rows into
// it. Both steps are no-ops once done, so this is safe to re-run.
let defaultWorkspaceId = db.prepare('SELECT id FROM workspaces ORDER BY sort_order, id LIMIT 1').get()?.id;
if (!defaultWorkspaceId) {
  defaultWorkspaceId = db.prepare('INSERT INTO workspaces (name) VALUES (?)').run('My Workspace').lastInsertRowid;
}
// Saved notes get adopted; the scratch pad stays global (workspace_id NULL).
db.prepare('UPDATE projects SET workspace_id = ? WHERE workspace_id IS NULL').run(defaultWorkspaceId);
db.prepare('UPDATE tasks SET workspace_id = ? WHERE workspace_id IS NULL').run(defaultWorkspaceId);
db.prepare('UPDATE ideas SET workspace_id = ? WHERE workspace_id IS NULL').run(defaultWorkspaceId);
db.prepare('UPDATE boards SET workspace_id = ? WHERE workspace_id IS NULL').run(defaultWorkspaceId);
db.prepare('UPDATE notes SET workspace_id = ? WHERE workspace_id IS NULL AND is_scratch = 0').run(defaultWorkspaceId);

// Seed a default board for the first workspace only (leaves user edits alone).
export const DEFAULT_BOARD_COLUMNS = [
  ['Backlog', 'backlog'], ['In Progress', 'in_progress'], ['In Review', 'in_review'],
  ['Done', 'done'], ['Deployed', 'deployed'],
];
export function seedBoard(workspaceId, name = 'Development') {
  const boardId = db.prepare('INSERT INTO boards (workspace_id, name) VALUES (?,?)').run(workspaceId, name).lastInsertRowid;
  const addCol = db.prepare('INSERT INTO board_columns (board_id, name, stage, sort_order) VALUES (?,?,?,?)');
  DEFAULT_BOARD_COLUMNS.forEach(([n, stage], i) => addCol.run(boardId, n, stage, i));
  return boardId;
}
if (db.prepare('SELECT COUNT(*) AS c FROM boards').get().c === 0) seedBoard(defaultWorkspaceId);

const DEFAULT_SETTINGS = {
  workday_minutes: '480',
  workday_start: '09:00',
};

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(k, v);
// The active workspace is server-side state so every endpoint can scope to it
// without the client having to pass it (and risk leaking across workspaces).
insertSetting.run('active_workspace_id', String(defaultWorkspaceId));

export function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  out.workday_minutes = parseInt(out.workday_minutes, 10) || 480;
  return out;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

// The id of the workspace all scoped queries run against. Falls back to the
// first workspace if the stored one was deleted, self-healing the setting.
export function activeWorkspaceId() {
  const stored = Number(db.prepare(`SELECT value FROM settings WHERE key = 'active_workspace_id'`).get()?.value);
  if (stored && db.prepare('SELECT 1 FROM workspaces WHERE id = ?').get(stored)) return stored;
  const first = db.prepare('SELECT id FROM workspaces ORDER BY sort_order, id LIMIT 1').get();
  const id = first ? first.id : db.prepare('INSERT INTO workspaces (name) VALUES (?)').run('My Workspace').lastInsertRowid;
  setSetting('active_workspace_id', id);
  return id;
}

export function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
