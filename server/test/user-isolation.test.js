// Cross-USER isolation, in multi-user mode.
//
// The same refusal table isolation.test.js runs against two workspaces, run
// again against two accounts. That is the point of sharing it: an endpoint
// that is safe against a workspace switch but not against a different person
// cannot pass one suite and fail silently in the other.
//
// Also covers the parts that only exist once there are accounts: sessions,
// per-user settings and API keys, the per-user scratch pad, and login
// throttling.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers-multi.js';
import {
  assertFixturesIntact, assertKanbanRefused, assertListsAreClean, assertRefused,
  bodyCases, pathCases, seedFixtures,
} from './cross-scope.js';

test.after(h.cleanup);

const PASSWORD_A = 'correct-horse-battery';
const PASSWORD_B = 'another-long-passphrase';

// The first account is the owner and adopts anything already in the database;
// the second starts empty.
const alice = await h.createAccount('alice@example.com', PASSWORD_A, { setup: true });
const a = await seedFixtures(h, 'Alpha', { newWorkspace: false });

const bob = await h.createAccount('bob@example.com', PASSWORD_B);
const b = await seedFixtures(h, 'Bravo', { newWorkspace: false });

// ---------- the shared table, now between people ----------

test('an endpoint taking an id in the path refuses another user\'s id', async () => {
  h.useCookie(alice.cookie);
  await assertRefused(h, pathCases(b, a.ws.id), 404, 'path id across users');
});

test('an id in a request body cannot reach another user\'s data', async () => {
  h.useCookie(alice.cookie);
  await assertRefused(h, bodyCases(b, a), 400, 'body id across users');
});

test('a kanban drag cannot move another user\'s card', async () => {
  h.useCookie(alice.cookie);
  await assertKanbanRefused(h, b);
});

test('list endpoints return only the signed-in user\'s rows', async () => {
  h.useCookie(alice.cookie);
  await assertListsAreClean(h, a, b);
  h.useCookie(bob.cookie);
  await assertListsAreClean(h, b, a);
});

test('neither account could write to the other', async () => {
  h.useCookie(bob.cookie);
  await assertFixturesIntact(h, b);
  h.useCookie(alice.cookie);
  await assertFixturesIntact(h, a);
});

// ---------- things that only exist with accounts ----------

test('workspaces are not visible to another user', async () => {
  h.useCookie(alice.cookie);
  const mine = await h.get('/workspaces');
  assert.ok(!mine.workspaces.some((w) => w.id === b.ws.id), 'another user\'s workspace was listed');
  // Nor reachable by id, including as a move destination.
  assert.equal((await h.raw('PATCH', `/workspaces/${b.ws.id}`, { name: 'hijacked' })).status, 404);
  assert.equal((await h.raw('POST', `/workspaces/${b.ws.id}/activate`)).status, 404);
  assert.equal((await h.raw('POST', `/projects/${a.project.id}/move`, { workspace_id: b.ws.id })).status, 400);
});

test('a stale or tampered active workspace does not grant access', async () => {
  // The scope invariant (see src/scope.js) is that scope.workspaceId is proven
  // to belong to scope.userId, which is what lets every other query filter on
  // workspace alone. Prove it holds even when the stored value is wrong —
  // a workspace deleted since, a database edited by hand, a bug elsewhere.
  const { db } = await import('../src/db.js');
  db.prepare(`UPDATE user_settings SET value = ? WHERE user_id = ? AND key = 'active_workspace_id'`)
    .run(String(b.ws.id), alice.user.id);

  h.useCookie(alice.cookie);
  const workspaces = await h.get('/workspaces');
  assert.notEqual(workspaces.active_id, b.ws.id, 'the scope accepted a workspace the user does not own');
  assert.ok(workspaces.workspaces.some((w) => w.id === workspaces.active_id), 'it healed to a workspace she owns');
  const tasks = await h.get('/tasks');
  assert.ok(!tasks.some((t) => t.id === b.task.id), 'another user\'s tasks became visible');

  await h.post(`/workspaces/${a.ws.id}/activate`);
});

test('the scratch pad is per user, not global', async () => {
  h.useCookie(alice.cookie);
  await h.patch(`/notes/${a.scratch.id}`, { body: 'alice private thoughts' });
  h.useCookie(bob.cookie);
  const bobScratch = await h.get('/notes/scratch');
  assert.notEqual(bobScratch.id, a.scratch.id, 'both users share one scratch note');
  assert.equal(bobScratch.body, '');
  // And Alice's is not readable by id either.
  assert.equal((await h.raw('GET', `/notes/${a.scratch.id}`)).status, 404);
});

test('settings and API keys are per user', async () => {
  h.useCookie(alice.cookie);
  await h.patch('/settings', { workday_minutes: 300, anthropic_api_key: 'sk-ant-aaaaaaaaaaaa1111' });
  const aliceSettings = await h.get('/settings');
  assert.equal(aliceSettings.workday_minutes, 300);
  assert.equal(aliceSettings.ai_key_last4, '1111');

  h.useCookie(bob.cookie);
  const bobSettings = await h.get('/settings');
  assert.equal(bobSettings.workday_minutes, 480, 'a setting leaked between users');
  assert.equal(bobSettings.ai_key_source, 'none', 'an API key leaked between users');
  assert.equal(bobSettings.ai_key_last4, null);
});

test('the API refuses an unauthenticated caller', async () => {
  h.signOutLocally();
  for (const [method, url] of [['GET', '/tasks'], ['GET', '/settings'], ['POST', '/tasks'], ['GET', '/workspaces']]) {
    const res = await h.raw(method, url, method === 'POST' ? { title: 'x' } : undefined);
    assert.equal(res.status, 401, `${method} ${url} was served without a session`);
  }
  // A forged cookie is not a session.
  h.useCookie('tm_session=not-a-real-token');
  assert.equal((await h.raw('GET', '/tasks')).status, 401);
  h.signOutLocally();
});

test('the API key is never echoed back', async () => {
  const { user } = await h.loginAs('alice@example.com', PASSWORD_A);
  assert.equal(user.email, 'alice@example.com');
  const settings = await h.get('/settings');
  assert.ok(!JSON.stringify(settings).includes('sk-ant-aaaaaaaaaaaa1111'), 'the stored API key was returned');
  assert.equal(settings.ai_key_source, 'settings');
});

test('logging out revokes the session', async () => {
  await h.loginAs('bob@example.com', PASSWORD_B);
  const cookie = h.currentCookie();
  await h.post('/auth/logout');
  // Even replaying the exact cookie is dead, because the row is gone.
  h.useCookie(cookie);
  assert.equal((await h.raw('GET', '/tasks')).status, 401);
  h.signOutLocally();
});

test('changing a password signs out the other devices', async () => {
  const first = await h.loginAs('bob@example.com', PASSWORD_B);
  const second = await h.loginAs('bob@example.com', PASSWORD_B); // a "second device"
  h.useCookie(second.cookie);
  await h.post('/auth/password', { current_password: PASSWORD_B, new_password: 'a-brand-new-passphrase' });

  h.useCookie(first.cookie);
  assert.equal((await h.raw('GET', '/tasks')).status, 401, 'the other device stayed signed in');
  h.useCookie(second.cookie);
  assert.equal((await h.raw('GET', '/tasks')).status, 200, 'the device that changed it got signed out');

  // And the old password no longer works.
  h.signOutLocally();
  assert.equal((await h.raw('POST', '/auth/login', { email: 'bob@example.com', password: PASSWORD_B })).status, 401);
  await h.loginAs('bob@example.com', 'a-brand-new-passphrase');
});

test('a wrong password is refused, and repeated guesses lock the account', async () => {
  h.signOutLocally();
  const attempt = () => h.raw('POST', '/auth/login', { email: 'alice@example.com', password: 'wrong-password-here' });
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt()).status, 401);
  // Locked: even the correct password is refused now, with the same message,
  // so the response does not reveal that the guess was right.
  const res = await h.raw('POST', '/auth/login', { email: 'alice@example.com', password: PASSWORD_A });
  assert.equal(res.status, 401);
  assert.match(res.body.error, /invalid email or password/);
});

test('an unknown email is refused the same way as a wrong password', async () => {
  h.signOutLocally();
  const unknown = await h.raw('POST', '/auth/login', { email: 'nobody@example.com', password: 'whatever-long-enough' });
  assert.equal(unknown.status, 401);
  assert.match(unknown.body.error, /invalid email or password/);
});

test('registration rejects weak passwords and duplicate emails without confirming them', async () => {
  h.signOutLocally();
  assert.equal((await h.raw('POST', '/auth/register', { email: 'new@example.com', password: 'short' })).status, 400);
  const dupe = await h.raw('POST', '/auth/register', { email: 'bob@example.com', password: 'a-perfectly-fine-passphrase' });
  assert.equal(dupe.status, 400);
  assert.doesNotMatch(dupe.body.error, /exists|taken|already/i, 'the error confirms the address is registered');
});

test('setup cannot be re-run to mint a second owner', async () => {
  h.signOutLocally();
  const res = await h.raw('POST', '/auth/setup', { email: 'usurper@example.com', password: 'a-long-enough-passphrase' });
  assert.equal(res.status, 409);
});

test('a state-changing request must declare JSON, which is what blocks cross-site forms', async () => {
  // Self-contained: its own account and its own task, so it does not care
  // whether an earlier test locked or re-passworded anyone.
  h.signOutLocally();
  const carol = await h.createAccount('carol@example.com', 'yet-another-long-passphrase');
  const task = await h.post('/tasks', { title: 'CSRF target' });

  // What a form on another site can send. The bodyless case matters most: it
  // is a "simple request", so the browser sends it with the cookie attached
  // and only hides the response — no comfort when the point is the side effect.
  for (const headers of [
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    { 'Content-Type': 'text/plain' },
    {},
  ]) {
    const res = await fetch(`${h.baseUrl}/tasks/${task.id}/convert-to-idea`, {
      method: 'POST',
      headers: { ...headers, cookie: carol.cookie },
    });
    assert.equal(res.status, 415, `a ${headers['Content-Type'] || 'bodyless'} request was accepted`);
  }

  // The task was not converted.
  h.useCookie(carol.cookie);
  assert.equal((await h.raw('GET', `/tasks/${task.id}`)).status, 200);
});
