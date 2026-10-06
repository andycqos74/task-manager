// The combined My Day: every workspace's day in one list, and acting on a
// task in another workspace without switching to it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl, cleanup, get, post } from './helpers.js';

test.after(cleanup);

// A request acting in a named workspace via the X-Workspace-Id header.
async function inWorkspace(method, url, workspaceId, body) {
  const res = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': String(workspaceId) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('scope=all lists My Day across workspaces, labelled with where each task lives', async () => {
  const { active_id: home } = await get('/workspaces');
  const here = await post('/tasks', { title: 'Home task', my_day: true, estimated_minutes: 60 });
  const away = await post('/workspaces', { name: 'Side gig' });
  await post(`/workspaces/${away.id}/activate`);
  const there = await post('/tasks', { title: 'Away task', my_day: true, estimated_minutes: 30 });
  await post('/tasks', { title: 'Not today' });
  await post(`/workspaces/${home}/activate`);

  const single = await get('/views/my-day');
  assert.equal(single.combined, false);
  assert.deepEqual(single.tasks.map((t) => t.id), [here.id]);

  const all = await get('/views/my-day?scope=all');
  assert.equal(all.combined, true);
  assert.deepEqual(all.tasks.map((t) => t.id).sort(), [here.id, there.id].sort());
  const away1 = all.tasks.find((t) => t.id === there.id);
  assert.equal(away1.workspace_id, away.id);
  assert.equal(away1.workspace_name, 'Side gig');
  assert.equal(all.warnings.total_estimated_minutes, 90);

  // Completing the away task through the header counts toward today.
  const done = await inWorkspace('PATCH', `/tasks/${there.id}`, away.id, { status: 'done' });
  assert.equal(done.status, 200);
  const after = await get('/views/my-day?scope=all');
  assert.deepEqual(after.tasks.map((t) => t.id), [here.id]);
  assert.equal(after.done_today, 1);
  // ...and the active workspace never changed.
  assert.equal((await get('/workspaces')).active_id, home);
});

test('the workspace header can unflag a task in another workspace, but only that workspace\'s tasks', async () => {
  const { active_id: home } = await get('/workspaces');
  const other = await post('/workspaces', { name: 'Other' });
  await post(`/workspaces/${other.id}/activate`);
  const task = await post('/tasks', { title: 'Flagged elsewhere', my_day: true });
  await post(`/workspaces/${home}/activate`);

  // Without the header the task is out of reach, as before.
  assert.equal((await fetch(`${baseUrl}/tasks/${task.id}`)).status, 404);
  // Naming the wrong workspace doesn't reach it either.
  assert.equal((await inWorkspace('POST', `/tasks/${task.id}/my-day`, home, { on: false })).status, 404);

  const res = await inWorkspace('POST', `/tasks/${task.id}/my-day`, other.id, { on: false });
  assert.equal(res.status, 200);
  assert.equal(res.body.my_day_date, null);
});

test('a malformed or unknown workspace header is refused', async () => {
  for (const value of ['abc', '1.5', '999999']) {
    assert.equal((await inWorkspace('GET', '/tasks', value)).status, 404, value);
  }
});
