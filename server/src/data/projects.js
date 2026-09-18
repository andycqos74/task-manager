// Project data access. Projects belong to a workspace, so every accessor here
// filters on scope.workspaceId.
import { db } from '../db.js';

const IDEA_KINDS = ['idea', 'bug'];

// The ids of every task that belongs to a project: filed against it directly,
// or hanging off one of its user stories (dev tasks). Used by the workspace
// move so both routes into the project travel together.
const PROJECT_TASK_IDS = `SELECT id FROM tasks WHERE project_id = @pid
  UNION
  SELECT t.id FROM tasks t
    JOIN user_stories s ON s.id = t.story_id
    JOIN epics e ON e.id = s.epic_id
   WHERE e.project_id = @pid`;

export function listProjects(scope) {
  return db
    .prepare(`SELECT p.*,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status NOT IN ('done','cancelled')) AS open_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.status = 'done') AS done_tasks,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_tasks
      FROM projects p WHERE p.workspace_id = ? ORDER BY p.status = 'archived', p.name`)
    .all(scope.workspaceId);
}

export function listProjectsByName(scope, { trackDevOnly = false } = {}) {
  const extra = trackDevOnly ? 'AND track_dev = 1' : '';
  return db.prepare(`SELECT * FROM projects WHERE workspace_id = ? ${extra} ORDER BY name`).all(scope.workspaceId);
}

export function getProject(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?').get(Number(id), scope.workspaceId) || null;
}

// Only for the move endpoints, which have to see the destination workspace's
// projects. Phase 1 restricts this to the owner's own workspaces.
export function getProjectAnywhere(scope, id) {
  if (!Number.isFinite(Number(id))) return null;
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(Number(id)) || null;
}

export function createProject(scope, f) {
  const id = db
    .prepare('INSERT INTO projects (workspace_id, name, description, status, color, start_date, target_date) VALUES (?,?,?,?,?,?,?)')
    .run(scope.workspaceId, f.name, f.description, f.status, f.color, f.start_date, f.target_date).lastInsertRowid;
  return getProject(scope, id);
}

const UPDATABLE = new Set(['name', 'description', 'status', 'color', 'start_date', 'target_date', 'track_dev']);

export function updateProject(scope, project, updates) {
  const keys = Object.keys(updates).filter((k) => UPDATABLE.has(k));
  if (keys.length) {
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE projects SET ${sets}, updated_at = datetime('now') WHERE id = ? AND workspace_id = ?`)
      .run(...keys.map((k) => updates[k]), project.id, scope.workspaceId);
  }
  return getProject(scope, project.id);
}

export function deleteProject(scope, project, { deleteTasks }) {
  db.transaction(() => {
    if (deleteTasks) db.prepare('DELETE FROM tasks WHERE project_id = ?').run(project.id);
    db.prepare('DELETE FROM projects WHERE id = ? AND workspace_id = ?').run(project.id, scope.workspaceId);
  })();
}

// Move a project to another workspace with everything it owns: its tasks
// (including the dev tasks reached through epic -> story), its epics and
// stories (which follow the project by project_id), the ideas and bugs filed
// against it, and the notes attached to it or to one of its tasks. Boards are
// workspace-level and cross-project, so they stay put — the moved cards simply
// show up on the destination workspace's boards (use POST /boards/:id/move to
// take a board across too).
export function moveProjectToWorkspace(scope, project, targetId) {
  const counts = { tasks: 0, epics: 0, stories: 0, ideas: 0, bugs: 0, notes: 0, dropped_dependencies: 0 };
  if (project.workspace_id === targetId) return counts;
  const pid = project.id;
  const params = { pid, ws: targetId };
  db.transaction(() => {
    // A dependency with one end in the project and the other outside it would
    // straddle two workspaces once the project has moved, so drop it.
    counts.dropped_dependencies = db
      .prepare(`DELETE FROM task_dependencies
                WHERE (task_id IN (${PROJECT_TASK_IDS})) <> (depends_on_id IN (${PROJECT_TASK_IDS}))`)
      .run({ pid }).changes;
    counts.notes = db
      .prepare(`UPDATE notes SET workspace_id = @ws, updated_at = datetime('now')
                WHERE project_id = @pid OR task_id IN (${PROJECT_TASK_IDS})`)
      .run(params).changes;
    // The project and story links are normally both inside the project, but a
    // task can be filed under one project while linked to a story in another.
    // Whichever link would be left pointing at the old workspace is cleared,
    // so nothing straddles the two.
    counts.tasks = db
      .prepare(`UPDATE tasks SET workspace_id = @ws,
                  project_id = CASE WHEN project_id = @pid THEN project_id ELSE NULL END,
                  story_id = CASE WHEN story_id IN (
                      SELECT s.id FROM user_stories s JOIN epics e ON e.id = s.epic_id WHERE e.project_id = @pid
                    ) THEN story_id ELSE NULL END,
                  updated_at = datetime('now')
                WHERE id IN (${PROJECT_TASK_IDS})`)
      .run(params).changes;
    for (const kind of IDEA_KINDS) {
      counts[kind === 'bug' ? 'bugs' : 'ideas'] = db
        .prepare(`UPDATE ideas SET workspace_id = @ws, updated_at = datetime('now')
                  WHERE project_id = @pid AND kind = @kind`)
        .run({ ...params, kind }).changes;
    }
    db.prepare(`UPDATE projects SET workspace_id = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(targetId, pid);
  })();
  counts.epics = db.prepare('SELECT COUNT(*) AS c FROM epics WHERE project_id = ?').get(pid).c;
  counts.stories = db
    .prepare('SELECT COUNT(*) AS c FROM user_stories WHERE epic_id IN (SELECT id FROM epics WHERE project_id = ?)')
    .get(pid).c;
  return counts;
}
