// Drag and drop in a project's Development tab: reordering epics, moving
// stories between epics, and moving tasks between stories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, get, post, put, raw } from './helpers.js';

test.after(cleanup);

const idsOf = (rows) => rows.map((r) => r.id);

async function seed() {
  const project = await post('/projects', { name: `Dev ${Math.random()}` });
  const e1 = await post('/epics', { project_id: project.id, title: 'E1' });
  const e2 = await post('/epics', { project_id: project.id, title: 'E2' });
  const e3 = await post('/epics', { project_id: project.id, title: 'E3' });
  const s1 = await post('/stories', { epic_id: e1.id, title: 'S1' });
  const s2 = await post('/stories', { epic_id: e1.id, title: 'S2' });
  const s3 = await post('/stories', { epic_id: e2.id, title: 'S3' });
  const t1 = await post('/tasks', { title: 'T1', story_id: s1.id });
  const t2 = await post('/tasks', { title: 'T2', story_id: s1.id });
  const t3 = await post('/tasks', { title: 'T3', story_id: s3.id });
  return { project, e1, e2, e3, s1, s2, s3, t1, t2, t3 };
}

test('epics can be reordered, and the tree follows the new order', async () => {
  const { project, e1, e2, e3 } = await seed();
  const saved = await put(`/projects/${project.id}/epics/order`, { ids: [e3.id, e1.id, e2.id] });
  assert.deepEqual(idsOf(saved), [e3.id, e1.id, e2.id]);
  assert.deepEqual(idsOf((await get(`/projects/${project.id}/dev`)).epics), [e3.id, e1.id, e2.id]);
});

test('an epic order must name every epic of the project exactly once', async () => {
  const { project, e1, e2, e3 } = await seed();
  for (const ids of [[e1.id, e2.id], [e1.id, e2.id, e3.id, e3.id], [e1.id, e2.id, 999999], 'nope']) {
    const res = await raw('PUT', `/projects/${project.id}/epics/order`, { ids });
    assert.equal(res.status, 400, JSON.stringify(ids));
  }
});

test('stories reorder within an epic and move to another one', async () => {
  const { project, e1, e2, s1, s2, s3, t3 } = await seed();
  assert.deepEqual(idsOf(await put(`/epics/${e1.id}/stories/order`, { ids: [s2.id, s1.id] })), [s2.id, s1.id]);

  // S3 moves from E2 into E1, between S2 and S1, and keeps its tasks.
  assert.deepEqual(idsOf(await put(`/epics/${e1.id}/stories/order`, { ids: [s2.id, s3.id, s1.id] })), [s2.id, s3.id, s1.id]);
  const tree = await get(`/projects/${project.id}/dev`);
  const byId = Object.fromEntries(tree.epics.map((e) => [e.id, e]));
  assert.deepEqual(idsOf(byId[e1.id].stories), [s2.id, s3.id, s1.id]);
  assert.deepEqual(byId[e2.id].stories, []);
  assert.deepEqual(idsOf(byId[e1.id].stories[1].tasks), [t3.id]);
});

test('a story order cannot leave out a story the epic already has, or take one from another project', async () => {
  const { e1, s1, s2 } = await seed();
  const other = await seed();
  assert.equal((await raw('PUT', `/epics/${e1.id}/stories/order`, { ids: [s1.id] })).status, 400);
  const res = await raw('PUT', `/epics/${e1.id}/stories/order`, { ids: [s1.id, s2.id, other.s1.id] });
  assert.equal(res.status, 400);
});

test('tasks reorder within a story and move to another story', async () => {
  const { project, s1, s2, t1, t2 } = await seed();
  assert.deepEqual(idsOf(await put(`/stories/${s1.id}/tasks/order`, { ids: [t2.id, t1.id] })), [t2.id, t1.id]);

  const moved = await put(`/stories/${s2.id}/tasks/order`, { ids: [t2.id] });
  assert.deepEqual(idsOf(moved), [t2.id]);
  const task = await get(`/tasks/${t2.id}`);
  assert.equal(task.story_id, s2.id);
  assert.equal(task.project_id, project.id);
  assert.ok(task.tags.includes('development'));

  const tree = await get(`/projects/${project.id}/dev`);
  const stories = Object.fromEntries(tree.epics.flatMap((e) => e.stories).map((s) => [s.id, s]));
  assert.deepEqual(idsOf(stories[s1.id].tasks), [t1.id]);
  assert.deepEqual(idsOf(stories[s2.id].tasks), [t2.id]);
});

test('a task order only takes tasks already in the project\'s stories', async () => {
  const { s1, t1, t2 } = await seed();
  const loose = await post('/tasks', { title: 'Not a dev task' });
  const other = await seed();
  assert.equal((await raw('PUT', `/stories/${s1.id}/tasks/order`, { ids: [t1.id, t2.id, loose.id] })).status, 400);
  assert.equal((await raw('PUT', `/stories/${s1.id}/tasks/order`, { ids: [t1.id, t2.id, other.t1.id] })).status, 400);
  assert.equal((await raw('PUT', `/stories/${s1.id}/tasks/order`, { ids: [t1.id] })).status, 400);
});
