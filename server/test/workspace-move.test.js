import test from 'node:test';
import assert from 'node:assert/strict';
import { call, cleanup, get, patch, post, raw } from './helpers.js';

test.after(cleanup);

test('moving a project carries its tasks, dev tiers, ideas, bugs and notes to the other workspace', async () => {
  const { active_id: home } = await get('/workspaces');
  const away = await post('/workspaces', { name: 'Away' });

  const project = await post('/projects', { name: 'Ported' });
  await patch(`/projects/${project.id}`, { track_dev: true });
  const epic = await post('/epics', { project_id: project.id, title: 'Epic one' });
  const story = await post('/stories', { epic_id: epic.id, title: 'Story one' });
  // Two tasks: one filed against the project, one hanging off the story.
  const plain = await post('/tasks', { title: 'Plain task', project_id: project.id });
  const devTask = await post('/tasks', { title: 'Dev task', story_id: story.id });
  // A task outside the project, depended on by one inside it: that dependency
  // would straddle two workspaces after the move, so it must be dropped.
  const outside = await post('/tasks', { title: 'Stays behind' });
  await call('PUT', `/tasks/${plain.id}/dependencies`, { depends_on_ids: [outside.id] });
  const idea = await post('/ideas', { kind: 'idea', title: 'An idea', project_id: project.id });
  const bug = await post('/ideas', { kind: 'bug', title: 'A bug', project_id: project.id });
  const note = await post('/notes', { title: 'Project note', project_id: project.id });

  const moved = await post(`/projects/${project.id}/move`, { workspace_id: away.id });
  assert.equal(moved.project.workspace_id, away.id);
  assert.deepEqual(
    { ...moved.moved },
    { tasks: 2, epics: 1, stories: 1, ideas: 1, bugs: 1, notes: 1, dropped_dependencies: 1 },
  );

  // Gone from the workspace it left, apart from the task that stayed behind.
  assert.deepEqual((await get('/projects')).map((p) => p.id), []);
  assert.deepEqual((await get('/tasks')).map((t) => t.id), [outside.id]);
  assert.deepEqual(await get('/ideas?status='), []);
  assert.deepEqual((await get('/notes')).map((n) => n.id), []);

  await post(`/workspaces/${away.id}/activate`);
  assert.deepEqual((await get('/projects')).map((p) => p.id), [project.id]);
  assert.deepEqual((await get('/tasks')).map((t) => t.id).sort(), [plain.id, devTask.id].sort());
  assert.deepEqual((await get('/ideas?kind=idea')).map((i) => i.id), [idea.id]);
  assert.deepEqual((await get('/ideas?kind=bug')).map((i) => i.id), [bug.id]);
  assert.deepEqual((await get('/notes')).map((n) => n.id), [note.id]);
  // The dev hierarchy follows the project, and the dev task keeps its story.
  const tree = await get(`/projects/${project.id}/dev`);
  assert.equal(tree.epics.length, 1);
  assert.equal(tree.epics[0].stories[0].tasks[0].id, devTask.id);
  assert.deepEqual((await get(`/tasks/${plain.id}`)).dependencies, []);

  await post(`/workspaces/${home}/activate`);
});

test('moving a project clears a task link that would point back at the old workspace', async () => {
  const { active_id: home } = await get('/workspaces');
  const away = await post('/workspaces', { name: 'Split' });
  const moving = await post('/projects', { name: 'Moving' });
  const staying = await post('/projects', { name: 'Staying' });
  const epic = await post('/epics', { project_id: moving.id, title: 'Epic' });
  const story = await post('/stories', { epic_id: epic.id, title: 'Story' });
  // Linked to the moving project's story, but filed under the one staying put:
  // the task travels with its story, so the project link has to go.
  const task = await post('/tasks', { title: 'Odd one out', story_id: story.id });
  await patch(`/tasks/${task.id}`, { project_id: staying.id });

  await post(`/projects/${moving.id}/move`, { workspace_id: away.id });
  // The task left the active workspace with its project, so it is only
  // readable from the destination now.
  assert.equal((await raw('GET', `/tasks/${task.id}`)).status, 404);
  await post(`/workspaces/${away.id}/activate`);
  const moved = await get(`/tasks/${task.id}`);
  assert.equal(moved.workspace_id, away.id);
  assert.equal(moved.story_id, story.id);
  assert.equal(moved.project_id, null);
  await post(`/workspaces/${home}/activate`);
});

test('moving a task clears links to the workspace it left, or files it under a project in the new one', async () => {
  const { active_id: home } = await get('/workspaces');
  const away = await post('/workspaces', { name: 'Elsewhere' });
  const hostProject = await post('/projects', { name: 'Host' });
  await post(`/workspaces/${away.id}/activate`);
  const awayProject = await post('/projects', { name: 'Away project' });
  await post(`/workspaces/${home}/activate`);

  const loose = await post('/tasks', { title: 'Loose task', project_id: hostProject.id });
  const note = await post('/notes', { title: 'Task note', task_id: loose.id });
  const moved = await post(`/tasks/${loose.id}/move`, { workspace_id: away.id });
  assert.equal(moved.task.workspace_id, away.id);
  assert.equal(moved.task.project_id, null); // the old project stayed behind
  assert.equal(moved.task.story_id, null);
  assert.equal(moved.moved.notes, 1);

  const filed = await post('/tasks', { title: 'Filed task' });
  await post(`/tasks/${filed.id}/move`, { workspace_id: away.id, project_id: awayProject.id });

  await post(`/workspaces/${away.id}/activate`);
  const tasks = await get('/tasks');
  assert.deepEqual(tasks.map((t) => t.id).sort(), [loose.id, filed.id].sort());
  assert.equal(tasks.find((t) => t.id === filed.id).project_id, awayProject.id);
  assert.deepEqual((await get('/notes')).map((n) => n.id), [note.id]);
  await post(`/workspaces/${home}/activate`);
});

test('a task cannot be filed under a project from another workspace', async () => {
  const { active_id: home } = await get('/workspaces');
  const away = await post('/workspaces', { name: 'Third' });
  const hereProject = await post('/projects', { name: 'Here' });
  const task = await post('/tasks', { title: 'Wrong project' });
  const res = await raw('POST', `/tasks/${task.id}/move`, { workspace_id: away.id, project_id: hereProject.id });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /destination workspace/);
  assert.equal((await get(`/tasks/${task.id}`)).workspace_id, home);
});

test('moving a board takes its columns to the other workspace', async () => {
  const { active_id: home } = await get('/workspaces');
  const away = await post('/workspaces', { name: 'Board home' });
  const board = await post('/boards', { name: 'Ported board' });
  const moved = await post(`/boards/${board.id}/move`, { workspace_id: away.id });
  assert.equal(moved.board.workspace_id, away.id);
  assert.equal(moved.board.columns.length, board.columns.length);
  assert.ok(!(await get('/boards')).some((b) => b.id === board.id));

  await post(`/workspaces/${away.id}/activate`);
  assert.ok((await get('/boards')).some((b) => b.id === board.id));
  await post(`/workspaces/${home}/activate`);
});

test('a move needs a workspace that exists', async () => {
  const task = await post('/tasks', { title: 'Nowhere to go' });
  for (const body of [{}, { workspace_id: 987654 }]) {
    assert.equal((await raw('POST', `/tasks/${task.id}/move`, body)).status, 400);
  }
});
