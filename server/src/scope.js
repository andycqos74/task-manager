// The scope is the answer to "whose data is this request allowed to touch?".
//
// Every data accessor takes one and filters on it, so an endpoint cannot read
// or write a row outside the caller's reach even if the handler forgets to
// think about it. Today a scope is just the active workspace; when user
// accounts land (see MULTI_USER_PLAN.md) it gains `userId` and the accessors
// filter on that too — this file and server/src/data/* are the only places
// that have to change.
//
// Two levels of reach, both needed:
//
//   scope.workspaceId — the active workspace. Almost everything is scoped to
//                       this: a task, note or board outside it is invisible.
//   the owner's whole set of workspaces — what the *Anywhere accessors use.
//                       Only the move endpoints need it, because a move's
//                       destination is by definition another workspace.
//
// In single-tenant mode the second level is "every workspace in the database";
// with accounts it becomes "every workspace with this user_id". Keeping the
// distinction explicit now means phase 1 adds a WHERE clause rather than
// having to work out, per query, which of the two was meant.

import { activeWorkspaceId } from './db.js';

export function currentScope() {
  return { workspaceId: activeWorkspaceId() };
}

// Express middleware: resolve the scope once per request, rather than calling
// activeWorkspaceId() from every handler.
export function attachScope(req, res, next) {
  req.scope = currentScope();
  next();
}
