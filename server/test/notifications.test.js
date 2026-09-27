// The notification feed behind the header bell (single-user mode; the
// cross-account check lives in user-isolation.test.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as h from './helpers.js';
import { todayISO, addDays } from '../src/dates.js';

test.after(h.cleanup);

const today = todayISO();
const kinds = (feed) => Object.fromEntries(feed.items.map((i) => [i.title, i.kind]));

test('the feed lists overdue, due-today and starting-today tasks, most urgent first', async () => {
  const project = await h.post('/projects', { name: 'Home' });
  await h.post('/tasks', { title: 'late', due_date: addDays(today, -2), project_id: project.id });
  await h.post('/tasks', { title: 'today', due_date: today });
  await h.post('/tasks', { title: 'start', due_date: addDays(today, 5), do_date: today });
  await h.post('/tasks', { title: 'later', due_date: addDays(today, 5), do_date: addDays(today, 3) });
  await h.post('/tasks', { title: 'undated' });
  const done = await h.post('/tasks', { title: 'finished', due_date: addDays(today, -1) });
  await h.patch(`/tasks/${done.id}`, { status: 'done' });

  const feed = await h.get('/notifications');
  assert.deepEqual(feed.items.map((i) => i.title), ['late', 'today', 'start']);
  assert.deepEqual(kinds(feed), { late: 'overdue', today: 'due_today', start: 'starts_today' });
  assert.equal(feed.unread, 3);
  assert.equal(feed.items[0].project_name, 'Home');
  assert.ok(feed.items.every((i) => i.workspace_name && !i.read));
});

test('tasks in other workspaces are included and say where they live', async () => {
  const mine = (await h.get('/workspaces')).active_id;
  const other = await h.post('/workspaces', { name: 'Side project' });
  await h.post(`/workspaces/${other.id}/activate`);
  await h.post('/tasks', { title: 'elsewhere', due_date: today });
  await h.post(`/workspaces/${mine}/activate`);
  const item = (await h.get('/notifications')).items.find((i) => i.title === 'elsewhere');
  assert.equal(item.workspace_id, other.id);
  assert.equal(item.workspace_name, 'Side project');
});

test('marking read clears the unread count; a task that becomes more urgent is new again', async () => {
  const before = await h.get('/notifications');
  assert.ok(before.unread > 0);
  const after = await h.post('/notifications/read', {});
  assert.equal(after.unread, 0);
  assert.ok(after.items.every((i) => i.read));

  // A new task shows up unread among the read ones.
  await h.post('/tasks', { title: 'fresh', due_date: today });
  const feed = await h.get('/notifications');
  assert.equal(feed.unread, 1);
  assert.equal(feed.items.find((i) => i.title === 'fresh').read, false);

  // Moving a read task's due date into the past makes it "overdue" — new info.
  const todayItem = feed.items.find((i) => i.title === 'today');
  await h.patch(`/tasks/${todayItem.task_id}`, { due_date: addDays(today, -1) });
  const moved = (await h.get('/notifications')).items.find((i) => i.title === 'today');
  assert.equal(moved.kind, 'overdue');
  assert.equal(moved.read, false);
});

test('specific keys can be marked read, and nonsense is refused', async () => {
  const feed = await h.get('/notifications');
  const target = feed.items.find((i) => !i.read);
  const after = await h.post('/notifications/read', { keys: [target.key, 'overdue:999999:2000-01-01'] });
  assert.equal(after.items.find((i) => i.key === target.key).read, true);
  assert.equal(after.unread, feed.unread - 1);
  assert.equal((await h.raw('POST', '/notifications/read', { keys: 'all' })).status, 400);
  assert.equal((await h.raw('POST', '/notifications/read', { keys: [1] })).status, 400);
});

test('completing a task removes it from the feed', async () => {
  const item = (await h.get('/notifications')).items.find((i) => i.title === 'late');
  await h.patch(`/tasks/${item.task_id}`, { status: 'done' });
  assert.ok(!(await h.get('/notifications')).items.some((i) => i.title === 'late'));
});
