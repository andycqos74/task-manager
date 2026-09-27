// GitHub issue links on dev items. The item itself has already been
// ownership-checked by the route (via Dev/Tasks/Ideas accessors) before it
// reaches here, and every write below still re-filters on the workspace, so a
// forged id reaches nothing.
import { db } from '../db.js';

// Item type -> table, and how that table reaches its workspace.
const TABLES = {
  epic: {
    table: 'epics',
    owned: 'id IN (SELECT e.id FROM epics e JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = @ws)',
  },
  story: {
    table: 'user_stories',
    owned: `id IN (SELECT s.id FROM user_stories s JOIN epics e ON e.id = s.epic_id
                   JOIN projects p ON p.id = e.project_id WHERE p.workspace_id = @ws)`,
  },
  task: { table: 'tasks', owned: 'workspace_id = @ws' },
  idea: { table: 'ideas', owned: 'workspace_id = @ws' },
};

export const ITEM_TYPES = Object.keys(TABLES);

export function setIssueLink(scope, type, id, { repo, number, url, state }) {
  const { table, owned } = TABLES[type];
  db.prepare(`UPDATE ${table} SET github_repo = @repo, github_issue_number = @number, github_issue_url = @url,
                github_issue_state = @state, github_synced_at = datetime('now')
              WHERE id = @id AND ${owned}`)
    .run({ repo, number, url, state, id, ws: scope.workspaceId });
}

export function setIssueState(scope, type, id, state) {
  const { table, owned } = TABLES[type];
  db.prepare(`UPDATE ${table} SET github_issue_state = @state, github_synced_at = datetime('now')
              WHERE id = @id AND ${owned}`)
    .run({ state, id, ws: scope.workspaceId });
}

export function clearIssueLink(scope, type, id) {
  const { table, owned } = TABLES[type];
  db.prepare(`UPDATE ${table} SET github_repo = NULL, github_issue_number = NULL, github_issue_url = NULL,
                github_issue_state = NULL, github_synced_at = NULL
              WHERE id = @id AND ${owned}`)
    .run({ id, ws: scope.workspaceId });
}

// Every item in a project that is linked to an issue, as { type, row }.
// Tasks count as the project's when filed under it or under one of its stories.
export function listLinkedItems(scope, projectId) {
  const params = { pid: projectId, ws: scope.workspaceId };
  const rows = [];
  const push = (type, list) => list.forEach((row) => rows.push({ type, row }));
  push('epic', db.prepare(`SELECT e.* FROM epics e JOIN projects p ON p.id = e.project_id
      WHERE e.project_id = @pid AND p.workspace_id = @ws AND e.github_issue_number IS NOT NULL`).all(params));
  push('story', db.prepare(`SELECT s.* FROM user_stories s JOIN epics e ON e.id = s.epic_id
      JOIN projects p ON p.id = e.project_id
      WHERE e.project_id = @pid AND p.workspace_id = @ws AND s.github_issue_number IS NOT NULL`).all(params));
  push('task', db.prepare(`SELECT t.* FROM tasks t WHERE t.workspace_id = @ws AND t.github_issue_number IS NOT NULL
      AND (t.project_id = @pid OR t.story_id IN (
        SELECT s.id FROM user_stories s JOIN epics e ON e.id = s.epic_id WHERE e.project_id = @pid))`).all(params));
  push('idea', db.prepare(`SELECT i.* FROM ideas i
      WHERE i.project_id = @pid AND i.workspace_id = @ws AND i.github_issue_number IS NOT NULL`).all(params));
  return rows;
}
