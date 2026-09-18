// Cross-workspace isolation, in single-user mode.
//
// Two workspaces are seeded with identical fixtures. With A active, every
// endpoint that takes an id is called with B's ids and must refuse: 404 for an
// id in the path, 400 for one in a request body. Then B is re-activated and its
// fixtures are checked to still be there, so a refusal that nevertheless wrote
// something would be caught too.
//
// user-isolation.test.js runs the same table against two separate accounts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as h from './helpers.js';
import {
  assertFixturesIntact, assertKanbanRefused, assertListsAreClean, assertRefused,
  bodyCases, pathCases, seedFixtures,
} from './cross-scope.js';

test.after(h.cleanup);

const a = await seedFixtures(h, 'Alpha');
const b = await seedFixtures(h, 'Bravo');
await h.post(`/workspaces/${a.ws.id}/activate`); // act as A for everything below

test('every endpoint taking an id in the path refuses another workspace\'s id', async () => {
  await assertRefused(h, pathCases(b, a.ws.id), 404, 'path id');
});

test('an id in a request body cannot reach across workspaces either', async () => {
  await assertRefused(h, bodyCases(b, a), 400, 'body id');
});

test('a kanban drag cannot move another workspace\'s card', async () => {
  await assertKanbanRefused(h, b);
});

test('list endpoints return only the active workspace\'s rows', async () => {
  await assertListsAreClean(h, a, b);
});

test('B\'s data survived every attempt above', async () => {
  await h.post(`/workspaces/${b.ws.id}/activate`);
  await assertFixturesIntact(h, b);
  await h.post(`/workspaces/${a.ws.id}/activate`);
});

test('the scratch pad is shared across one person\'s workspaces', async () => {
  // Deliberate: the scratch pad follows the person, not the workspace. What
  // must NOT happen is sharing it between people — user-isolation.test.js
  // covers that side.
  await h.patch(`/notes/${a.scratch.id}`, { body: 'note to self' });
  await h.post(`/workspaces/${b.ws.id}/activate`);
  assert.equal((await h.get('/notes/scratch')).id, a.scratch.id);
  assert.equal((await h.get('/notes/scratch')).body, 'note to self');
  await h.post(`/workspaces/${a.ws.id}/activate`);
});

test('routes.js contains no SQL of its own', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'routes.js'), 'utf8');
  // Every read and write has to go through the scoped accessors in src/data/*,
  // so that adding an endpoint cannot quietly add an unscoped query.
  assert.ok(!/db\s*\.\s*prepare/.test(src), 'routes.js prepares its own statements');
  assert.ok(!/from '\.\/db\.js'/.test(src), 'routes.js imports the database directly');
});
