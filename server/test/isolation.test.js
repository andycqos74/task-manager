// Cross-scope isolation.
//
// Two workspaces are seeded with identical fixtures. With A active, every
// endpoint that takes an id is called with B's ids and must refuse: 404 for an
// id in the path, 400 for one in a request body. Then B is re-activated and its
// fixtures are checked to still be there, so a refusal that nevertheless wrote
// something would be caught too.
//
// Today this proves workspace isolation. When user accounts land the same
// table runs a second time with two users instead of two workspaces — which is
// why it is written as a table rather than as prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanup, get, patch, post, raw } from './helpers.js';

test.after(cleanup);

// A full set of fixtures inside one workspace.
async function seed(name) {
  const ws = await post('/workspaces', { name });
  await post(`/workspaces/${ws.id}/activate`);
  const project = await post('/projects', { name: `${name} project` });
  const epic = await post('/epics', { project_id: project.id, title: `${name} epic` });
  const story = await post('/stories', { epic_id: epic.id, title: `${name} story` });
  const task = await post('/tasks', { title: `${name} task`, project_id: project.id });
  const withSub = await post(`/tasks/${task.id}/subtasks`, { title: 'a subtask' });
  const note = await post('/notes', { title: `${name} note`, task_id: task.id });
  const idea = await post('/ideas', { title: `${name} idea`, project_id: project.id });
  const board = (await get('/boards'))[0];
  return {
    ws, project, epic, story, task, note, idea, board,
    subtask: withSub.subtasks[0],
    column: board.columns[0],
  };
}

const a = await seed('Alpha');
const b = await seed('Bravo');
await post(`/workspaces/${a.ws.id}/activate`); // act as A for everything below

// ---------- ids in the path: 404, as if the row did not exist ----------
// 404 rather than 403: telling the caller "exists, but not yours" is itself a
// disclosure.

test('every endpoint taking an id in the path refuses another workspace\'s id', async () => {
  const cases = [
    ['PATCH', `/projects/${b.project.id}`, { name: 'hijacked' }],
    ['DELETE', `/projects/${b.project.id}`],
    ['POST', `/projects/${b.project.id}/move`, { workspace_id: a.ws.id }],
    ['GET', `/projects/${b.project.id}/dev`],
    ['GET', `/tasks/${b.task.id}`],
    ['PATCH', `/tasks/${b.task.id}`, { title: 'hijacked' }],
    ['DELETE', `/tasks/${b.task.id}`],
    ['POST', `/tasks/${b.task.id}/move`, { workspace_id: a.ws.id }],
    ['POST', `/tasks/${b.task.id}/my-day`, { on: true }],
    ['POST', `/tasks/${b.task.id}/subtasks`, { title: 'hijacked' }],
    ['POST', `/tasks/${b.task.id}/convert-to-idea`, {}],
    ['POST', `/tasks/${b.task.id}/convert-to-bug`, {}],
    ['PUT', `/tasks/${b.task.id}/dependencies`, { depends_on_ids: [] }],
    ['PATCH', `/subtasks/${b.subtask.id}`, { done: true }],
    ['DELETE', `/subtasks/${b.subtask.id}`],
    ['GET', `/notes/${b.note.id}`],
    ['PATCH', `/notes/${b.note.id}`, { title: 'hijacked' }],
    ['DELETE', `/notes/${b.note.id}`],
    ['PATCH', `/epics/${b.epic.id}`, { title: 'hijacked' }],
    ['DELETE', `/epics/${b.epic.id}`],
    ['PATCH', `/stories/${b.story.id}`, { title: 'hijacked' }],
    ['DELETE', `/stories/${b.story.id}`],
    ['PATCH', `/ideas/${b.idea.id}`, { title: 'hijacked' }],
    ['DELETE', `/ideas/${b.idea.id}`],
    ['POST', `/ideas/${b.idea.id}/promote`, { level: 'task' }],
    ['PATCH', `/boards/${b.board.id}`, { name: 'hijacked' }],
    ['DELETE', `/boards/${b.board.id}`],
    ['POST', `/boards/${b.board.id}/move`, { workspace_id: a.ws.id }],
    ['POST', `/boards/${b.board.id}/columns`, { name: 'hijacked', stage: 'done' }],
    ['GET', `/boards/${b.board.id}/cards`],
    ['PATCH', `/board-columns/${b.column.id}`, { name: 'hijacked' }],
    ['DELETE', `/board-columns/${b.column.id}`],
  ];
  for (const [method, url, body] of cases) {
    const res = await raw(method, url, body);
    assert.equal(res.status, 404, `${method} ${url} returned ${res.status}, expected 404`);
  }
});

// ---------- ids in a request body: rejected as unknown ----------

test('an id in a request body cannot reach across workspaces either', async () => {
  const cases = [
    ['POST', '/tasks', { title: 'x', project_id: b.project.id }],
    ['POST', '/tasks', { title: 'x', story_id: b.story.id }],
    ['PATCH', `/tasks/${a.task.id}`, { project_id: b.project.id }],
    ['PATCH', `/tasks/${a.task.id}`, { story_id: b.story.id }],
    ['PUT', `/tasks/${a.task.id}/dependencies`, { depends_on_ids: [b.task.id] }],
    ['POST', '/epics', { project_id: b.project.id, title: 'x' }],
    ['POST', '/stories', { epic_id: b.epic.id, title: 'x' }],
    ['PATCH', `/stories/${a.story.id}`, { epic_id: b.epic.id }],
    ['POST', '/ideas', { title: 'x', project_id: b.project.id }],
    ['PATCH', `/ideas/${a.idea.id}`, { project_id: b.project.id }],
    ['POST', '/notes', { title: 'x', task_id: b.task.id }],
    ['POST', '/notes', { title: 'x', project_id: b.project.id }],
    ['PATCH', `/notes/${a.note.id}`, { task_id: b.task.id }],
    ['POST', `/ideas/${a.idea.id}/promote`, { level: 'epic', project_id: b.project.id }],
    ['POST', `/ideas/${a.idea.id}/promote`, { level: 'story', epic_id: b.epic.id }],
    ['POST', `/ideas/${a.idea.id}/promote`, { level: 'task', story_id: b.story.id }],
  ];
  for (const [method, url, body] of cases) {
    const res = await raw(method, url, body);
    assert.equal(res.status, 400, `${method} ${url} ${JSON.stringify(body)} returned ${res.status}, expected 400`);
  }
});

test('a kanban drag cannot move another workspace\'s card', async () => {
  for (const [type, id] of [['epic', b.epic.id], ['story', b.story.id], ['task', b.task.id]]) {
    const res = await raw('POST', '/kanban/move', { type, id, stage: 'done' });
    assert.equal(res.status, 404, `${type} move returned ${res.status}`);
  }
});

// ---------- list endpoints ----------

test('list endpoints return only the active workspace\'s rows', async () => {
  const has = (rows, id) => rows.some((r) => r.id === id);

  const projects = await get('/projects');
  assert.ok(has(projects, a.project.id) && !has(projects, b.project.id));

  const tasks = await get('/tasks');
  assert.ok(has(tasks, a.task.id) && !has(tasks, b.task.id));

  const notes = await get('/notes');
  assert.ok(has(notes, a.note.id) && !has(notes, b.note.id));

  const ideas = await get('/ideas');
  assert.ok(has(ideas, a.idea.id) && !has(ideas, b.idea.id));

  const boards = await get('/boards');
  assert.ok(has(boards, a.board.id) && !has(boards, b.board.id));

  const epics = await get('/epics');
  assert.ok(has(epics, a.epic.id) && !has(epics, b.epic.id));

  const stories = await get('/stories');
  assert.ok(has(stories, a.story.id) && !has(stories, b.story.id));

  const gantt = await get('/gantt');
  assert.ok(!has(gantt.projects, b.project.id));

  const cards = await get(`/boards/${a.board.id}/cards`);
  assert.ok(!cards.cards.some((c) => c.type === 'task' && c.id === b.task.id));
  assert.ok(!cards.cards.some((c) => c.type === 'epic' && c.id === b.epic.id));

  const schedule = await get('/views/schedule');
  const scheduled = Object.values(schedule.buckets).flat();
  assert.ok(!has(scheduled, b.task.id));
});

// ---------- nothing was written along the way ----------

test('B\'s data survived every attempt above', async () => {
  await post(`/workspaces/${b.ws.id}/activate`);
  assert.equal((await get(`/tasks/${b.task.id}`)).title, 'Bravo task');
  assert.equal((await get(`/tasks/${b.task.id}`)).subtasks.length, 1);
  assert.equal((await get(`/notes/${b.note.id}`)).title, 'Bravo note');
  assert.ok((await get('/projects')).some((p) => p.id === b.project.id && p.name === 'Bravo project'));
  assert.ok((await get('/epics')).some((e) => e.id === b.epic.id && e.title === 'Bravo epic'));
  assert.ok((await get('/stories')).some((s) => s.id === b.story.id && s.title === 'Bravo story'));
  assert.ok((await get('/ideas')).some((i) => i.id === b.idea.id && i.status === 'open'));
  const board = (await get('/boards')).find((x) => x.id === b.board.id);
  assert.equal(board.name, a.board.name); // untouched default board
  assert.equal(board.columns.length, b.board.columns.length);
  await post(`/workspaces/${a.ws.id}/activate`);
});

// ---------- structural guard ----------

test('routes.js contains no SQL of its own', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = fs.readFileSync(path.join(here, '..', 'src', 'routes.js'), 'utf8');
  // Every read and write has to go through the scoped accessors in src/data/*,
  // so that adding an endpoint cannot quietly add an unscoped query.
  assert.ok(!/db\s*\.\s*prepare/.test(src), 'routes.js prepares its own statements');
  assert.ok(!/from '\.\/db\.js'/.test(src), 'routes.js imports the database directly');
});
