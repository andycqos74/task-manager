// The scope is the answer to "whose data is this request allowed to touch?".
//
// THE INVARIANT
// -------------
// Ownership is recorded in exactly one place: workspaces.user_id. Every other
// table reaches its owner through a workspace. So if `scope.workspaceId` is
// proven to belong to `scope.userId` when the scope is built — which is what
// this file does, on every request — then any query already filtered to that
// workspace is, for free, filtered to that user. That is why phase 0's
// workspace scoping did most of the work for phase 1.
//
// The only queries that need to name the user explicitly are the ones that
// deliberately reach outside the active workspace:
//
//   * the workspace accessors themselves (data/workspaces.js), which is where
//     the invariant is established;
//   * the *Anywhere accessors used by the move endpoints, whose destination is
//     by definition another workspace;
//   * the scratch note, the one row that is not workspace-scoped.
//
// That list is short and auditable on purpose. A second, denormalised user_id
// on every table was considered and rejected: two sources of truth can drift
// apart, and a drifted copy fails open.
import { db } from './db.js';
import { seedNewUser } from './db.js';

// Resolve the workspace this user is working in, validating that they own it.
// Self-heals: a workspace that was deleted (or never existed) falls back to
// their first one, and a user with none gets one.
export function scopeForUser(userId) {
  const stored = Number(
    db.prepare(`SELECT value FROM user_settings WHERE user_id = ? AND key = 'active_workspace_id'`).get(userId)?.value,
  );
  if (stored && db.prepare('SELECT 1 FROM workspaces WHERE id = ? AND user_id = ?').get(stored, userId)) {
    return { userId, workspaceId: stored };
  }
  const first = db.prepare('SELECT id FROM workspaces WHERE user_id = ? ORDER BY sort_order, id LIMIT 1').get(userId);
  const workspaceId = first ? first.id : seedNewUser(userId);
  setActiveWorkspaceId(userId, workspaceId);
  return { userId, workspaceId };
}

export function setActiveWorkspaceId(userId, workspaceId) {
  db.prepare(`INSERT INTO user_settings (user_id, key, value) VALUES (?, 'active_workspace_id', ?)
              ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value`)
    .run(userId, String(workspaceId));
}

// Express middleware. Runs after attachUser, so req.user is already resolved.
export function attachScope(req, res, next) {
  req.scope = scopeForUser(req.user.id);
  next();
}
