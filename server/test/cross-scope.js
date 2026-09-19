// The cross-scope refusal table, shared by two suites.
//
// isolation.test.js runs it with two workspaces belonging to one person.
// user-isolation.test.js runs the very same cases with two separate accounts.
// One table, two threat models — so an endpoint that is safe against a
// workspace switch but not against another user cannot slip through.
import assert from 'node:assert/strict';

// A full set of fixtures inside the caller's active workspace.
export async function seedFixtures(h, name, { newWorkspace = true } = {}) {
  const ws = newWorkspace
    ? await h.post('/workspaces', { name })
    : (await h.get('/workspaces')).workspaces[0];
  await h.post(`/workspaces/${ws.id}/activate`);
  const project = await h.post('/projects', { name: `${name} project` });
  const epic = await h.post('/epics', { project_id: project.id, title: `${name} epic` });
  const story = await h.post('/stories', { epic_id: epic.id, title: `${name} story` });
  const task = await h.post('/tasks', { title: `${name} task`, project_id: project.id });
  const withSub = await h.post(`/tasks/${task.id}/subtasks`, { title: 'a subtask' });
  const note = await h.post('/notes', { title: `${name} note`, task_id: task.id });
  const idea = await h.post('/ideas', { title: `${name} idea`, project_id: project.id });
  const scratch = await h.get('/notes/scratch');
  const board = (await h.get('/boards'))[0];
  return { name, ws, project, epic, story, task, note, idea, board, scratch, subtask: withSub.subtasks[0] };
}

// Endpoints that take an id in the path. Out of reach must read as "not
// there" — 404, never 403, because 403 confirms the row exists.
export function pathCases(victim, attackerWorkspaceId) {
  return [
    ['PATCH', `/projects/${victim.project.id}`, { name: 'hijacked' }],
    ['DELETE', `/projects/${victim.project.id}`],
    ['POST', `/projects/${victim.project.id}/move`, { workspace_id: attackerWorkspaceId }],
    ['GET', `/projects/${victim.project.id}/dev`],
    ['GET', `/tasks/${victim.task.id}`],
    ['PATCH', `/tasks/${victim.task.id}`, { title: 'hijacked' }],
    ['DELETE', `/tasks/${victim.task.id}`],
    ['POST', `/tasks/${victim.task.id}/move`, { workspace_id: attackerWorkspaceId }],
    ['POST', `/tasks/${victim.task.id}/my-day`, { on: true }],
    ['POST', `/tasks/${victim.task.id}/subtasks`, { title: 'hijacked' }],
    ['POST', `/tasks/${victim.task.id}/convert-to-idea`, {}],
    ['POST', `/tasks/${victim.task.id}/convert-to-bug`, {}],
    ['PUT', `/tasks/${victim.task.id}/dependencies`, { depends_on_ids: [] }],
    ['PATCH', `/subtasks/${victim.subtask.id}`, { done: true }],
    ['DELETE', `/subtasks/${victim.subtask.id}`],
    ['GET', `/notes/${victim.note.id}`],
    ['PATCH', `/notes/${victim.note.id}`, { title: 'hijacked' }],
    ['DELETE', `/notes/${victim.note.id}`],
    ['PATCH', `/epics/${victim.epic.id}`, { title: 'hijacked' }],
    ['DELETE', `/epics/${victim.epic.id}`],
    ['PATCH', `/stories/${victim.story.id}`, { title: 'hijacked' }],
    ['DELETE', `/stories/${victim.story.id}`],
    ['PATCH', `/ideas/${victim.idea.id}`, { title: 'hijacked' }],
    ['DELETE', `/ideas/${victim.idea.id}`],
    ['POST', `/ideas/${victim.idea.id}/promote`, { level: 'task' }],
    ['PATCH', `/boards/${victim.board.id}`, { name: 'hijacked' }],
    ['DELETE', `/boards/${victim.board.id}`],
    ['POST', `/boards/${victim.board.id}/move`, { workspace_id: attackerWorkspaceId }],
    ['POST', `/boards/${victim.board.id}/columns`, { name: 'hijacked', stage: 'done' }],
    ['GET', `/boards/${victim.board.id}/cards`],
    ['PATCH', `/board-columns/${victim.board.columns[0].id}`, { name: 'hijacked' }],
    ['DELETE', `/board-columns/${victim.board.columns[0].id}`],
  ];
}

// Endpoints that take an id in a request body. These are the ones a naive
// ownership check misses: the row being written is the caller's own.
export function bodyCases(victim, mine) {
  return [
    ['POST', '/tasks', { title: 'x', project_id: victim.project.id }],
    ['POST', '/tasks', { title: 'x', story_id: victim.story.id }],
    ['PATCH', `/tasks/${mine.task.id}`, { project_id: victim.project.id }],
    ['PATCH', `/tasks/${mine.task.id}`, { story_id: victim.story.id }],
    ['PUT', `/tasks/${mine.task.id}/dependencies`, { depends_on_ids: [victim.task.id] }],
    ['POST', '/epics', { project_id: victim.project.id, title: 'x' }],
    ['POST', '/stories', { epic_id: victim.epic.id, title: 'x' }],
    ['PATCH', `/stories/${mine.story.id}`, { epic_id: victim.epic.id }],
    ['POST', '/ideas', { title: 'x', project_id: victim.project.id }],
    ['PATCH', `/ideas/${mine.idea.id}`, { project_id: victim.project.id }],
    ['POST', '/notes', { title: 'x', task_id: victim.task.id }],
    ['POST', '/notes', { title: 'x', project_id: victim.project.id }],
    ['PATCH', `/notes/${mine.note.id}`, { task_id: victim.task.id }],
    ['POST', `/ideas/${mine.idea.id}/promote`, { level: 'epic', project_id: victim.project.id }],
    ['POST', `/ideas/${mine.idea.id}/promote`, { level: 'story', epic_id: victim.epic.id }],
    ['POST', `/ideas/${mine.idea.id}/promote`, { level: 'task', story_id: victim.story.id }],
  ];
}

export async function assertRefused(h, cases, expected, label) {
  for (const [method, url, body] of cases) {
    const res = await h.raw(method, url, body);
    assert.equal(res.status, expected, `${label}: ${method} ${url} returned ${res.status}, expected ${expected}`);
  }
}

// Dragging a card that is not yours must not move it.
export async function assertKanbanRefused(h, victim) {
  for (const [type, id] of [['epic', victim.epic.id], ['story', victim.story.id], ['task', victim.task.id]]) {
    const res = await h.raw('POST', '/kanban/move', { type, id, stage: 'done' });
    assert.equal(res.status, 404, `kanban ${type} move returned ${res.status}`);
  }
}

// Nothing above wrote anything: the fixtures are exactly as they were.
export async function assertFixturesIntact(h, f) {
  assert.equal((await h.get(`/tasks/${f.task.id}`)).title, `${f.name} task`);
  assert.equal((await h.get(`/tasks/${f.task.id}`)).subtasks.length, 1);
  assert.equal((await h.get(`/notes/${f.note.id}`)).title, `${f.name} note`);
  assert.ok((await h.get('/projects')).some((p) => p.id === f.project.id && p.name === `${f.name} project`));
  assert.ok((await h.get('/epics')).some((e) => e.id === f.epic.id && e.title === `${f.name} epic`));
  assert.ok((await h.get('/stories')).some((s) => s.id === f.story.id && s.title === `${f.name} story`));
  assert.ok((await h.get('/ideas')).some((i) => i.id === f.idea.id && i.status === 'open'));
  const board = (await h.get('/boards')).find((x) => x.id === f.board.id);
  assert.equal(board.columns.length, f.board.columns.length);
}

// Lists show the caller's rows and nobody else's.
export async function assertListsAreClean(h, mine, theirs) {
  const has = (rows, id) => rows.some((r) => r.id === id);
  const checks = [
    ['/projects', mine.project.id, theirs.project.id],
    ['/tasks', mine.task.id, theirs.task.id],
    ['/notes', mine.note.id, theirs.note.id],
    ['/ideas', mine.idea.id, theirs.idea.id],
    ['/boards', mine.board.id, theirs.board.id],
    ['/epics', mine.epic.id, theirs.epic.id],
    ['/stories', mine.story.id, theirs.story.id],
  ];
  for (const [url, mineId, theirsId] of checks) {
    const rows = await h.get(url);
    assert.ok(has(rows, mineId), `${url} is missing the caller's own row`);
    assert.ok(!has(rows, theirsId), `${url} leaked a row that is not the caller's`);
  }
  assert.ok(!has((await h.get('/gantt')).projects, theirs.project.id));
  const cards = (await h.get(`/boards/${mine.board.id}/cards`)).cards;
  assert.ok(!cards.some((c) => c.type === 'task' && c.id === theirs.task.id));
  assert.ok(!cards.some((c) => c.type === 'epic' && c.id === theirs.epic.id));
  const scheduled = Object.values((await h.get('/views/schedule')).buckets).flat();
  assert.ok(!has(scheduled, theirs.task.id));
}
