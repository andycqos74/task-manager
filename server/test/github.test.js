// GitHub integration, against an in-process fake of the GitHub REST API.
//
// github.js reads GITHUB_API_URL at import time, so the fake is started and
// the variable set before helpers.js (and through it the app) is imported.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const TOKEN = 'ghp_testtoken1234';
const issues = new Map(); // "owner/name#n" -> issue
const requests = [];
let nextNumber = 1;

const fake = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, url: req.url, body });
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { message: 'Bad credentials' });
    if (req.url === '/user') return send(200, { login: 'octocat', name: 'The Octocat' });
    if (req.url.startsWith('/user/repos')) return send(200, [{ full_name: 'octo/app', private: false, has_issues: true }]);
    const m = req.url.match(/^\/repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+))?$/);
    if (!m || m[1] === 'octo/missing') return send(404, { message: 'Not Found' });
    const repo = m[1];
    if (req.method === 'POST' && !m[2]) {
      const n = nextNumber++;
      const issue = { number: n, html_url: `https://github.com/${repo}/issues/${n}`, state: 'open', state_reason: null, ...body };
      issues.set(`${repo}#${n}`, issue);
      return send(201, issue);
    }
    const issue = issues.get(`${repo}#${m[2]}`);
    if (!issue) return send(404, { message: 'Not Found' });
    if (req.method === 'PATCH') Object.assign(issue, body);
    return send(200, issue);
  });
});
await new Promise((r) => fake.listen(0, r));
process.env.GITHUB_API_URL = `http://127.0.0.1:${fake.address().port}`;
delete process.env.GITHUB_TOKEN;

const h = await import('./helpers.js');
test.after(() => { h.cleanup(); fake.close(); });

const closeOnGitHub = (url, state_reason = 'completed') => {
  const [, repo, n] = url.match(/github\.com\/(.+)\/issues\/(\d+)$/);
  Object.assign(issues.get(`${repo}#${n}`), { state: 'closed', state_reason });
};

test('without a token, GitHub features report unavailable and refuse politely', async () => {
  assert.equal((await h.get('/settings')).github_available, false);
  assert.deepEqual(await h.get('/github/status'), { available: false });
  const project = await h.post('/projects', { name: 'No token', github_repo: 'octo/app' });
  const epic = await h.post('/epics', { project_id: project.id, title: 'E' });
  const res = await h.raw('POST', `/epics/${epic.id}/github`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /token/i);
});

test('the token is write-only: settings expose only its source and last four characters', async () => {
  const s = await h.patch('/settings', { github_token: TOKEN });
  assert.equal(s.github_available, true);
  assert.equal(s.github_token_source, 'settings');
  assert.equal(s.github_token_last4, '1234');
  assert.ok(!JSON.stringify(s).includes(TOKEN));
  assert.equal((await h.get('/github/status')).user.login, 'octocat');
  assert.equal((await h.get('/github/repos'))[0].full_name, 'octo/app');
});

test('project repo is validated and a pasted URL is normalised', async () => {
  const p = await h.post('/projects', { name: 'Repo check' });
  assert.equal((await h.patch(`/projects/${p.id}`, { github_repo: 'https://github.com/octo/app.git' })).github_repo, 'octo/app');
  assert.equal((await h.raw('PATCH', `/projects/${p.id}`, { github_repo: '../../etc' })).status, 400);
  assert.equal((await h.raw('PATCH', `/projects/${p.id}`, { github_repo: 'octo/app/issues' })).status, 400);
  assert.equal((await h.patch(`/projects/${p.id}`, { github_repo: '' })).github_repo, null);
});

test('pushing items creates issues with labels, parent references and checklists', async () => {
  const project = await h.post('/projects', { name: 'Shop', github_repo: 'octo/app' });
  const epic = await h.post('/epics', { project_id: project.id, title: 'Checkout', description: 'Pay for things' });
  const pushedEpic = await h.post(`/epics/${epic.id}/github`, {});
  assert.equal(pushedEpic.created, true);
  assert.equal(pushedEpic.item.github_repo, 'octo/app');
  const epicNumber = pushedEpic.item.github_issue_number;
  const epicIssue = issues.get(`octo/app#${epicNumber}`);
  assert.deepEqual(epicIssue.labels, ['epic']);
  assert.match(epicIssue.body, /Pay for things/);

  const story = await h.post('/stories', { epic_id: epic.id, title: 'Card payments' });
  const pushedStory = await h.post(`/stories/${story.id}/github`, {});
  const storyIssue = issues.get(`octo/app#${pushedStory.item.github_issue_number}`);
  assert.deepEqual(storyIssue.labels, ['user story']);
  assert.match(storyIssue.body, new RegExp(`Checkout \\(#${epicNumber}\\)`));

  const task = await h.post('/tasks', { title: 'Wire up Stripe', story_id: story.id });
  await h.post(`/tasks/${task.id}/subtasks`, { title: 'webhooks' });
  const pushedTask = await h.post(`/tasks/${task.id}/github`, {});
  const taskIssue = issues.get(`octo/app#${pushedTask.item.github_issue_number}`);
  assert.deepEqual(taskIssue.labels, ['task']);
  assert.match(taskIssue.body, /- \[ \] webhooks/);

  const bug = await h.post('/ideas', { kind: 'bug', title: 'Total is wrong', project_id: project.id });
  const pushedBug = await h.post(`/ideas/${bug.id}/github`, {});
  assert.deepEqual(issues.get(`octo/app#${pushedBug.item.github_issue_number}`).labels, ['bug']);

  // The link shows up on the dev tree and on board cards.
  const tree = await h.get(`/projects/${project.id}/dev`);
  assert.equal(tree.epics[0].github_issue_number, epicNumber);
  const board = (await h.get('/boards'))[0];
  const cards = (await h.get(`/boards/${board.id}/cards?project_id=${project.id}`)).cards;
  assert.ok(cards.every((c) => c.github_issue_url));
});

test('pushing again updates the same issue, closes it when done, and leaves labels alone', async () => {
  const project = await h.post('/projects', { name: 'Update', github_repo: 'octo/app' });
  const task = await h.post('/tasks', { title: 'First title', project_id: project.id });
  const first = await h.post(`/tasks/${task.id}/github`, {});
  const number = first.item.github_issue_number;
  const before = requests.length;

  await h.patch(`/tasks/${task.id}`, { title: 'Second title', status: 'done' });
  const second = await h.post(`/tasks/${task.id}/github`, {});
  assert.equal(second.created, false);
  assert.equal(second.item.github_issue_number, number);
  assert.equal(second.item.github_issue_state, 'closed');
  const patchReq = requests.slice(before).find((r) => r.method === 'PATCH');
  assert.equal(patchReq.body.title, 'Second title');
  assert.equal(patchReq.body.state, 'closed');
  assert.ok(!('labels' in patchReq.body));
});

test('an item outside a linked project cannot be pushed', async () => {
  const unlinked = await h.post('/projects', { name: 'Unlinked' });
  const idea = await h.post('/ideas', { title: 'orphan', project_id: unlinked.id });
  const res = await h.raw('POST', `/ideas/${idea.id}/github`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Link "Unlinked"/);
  const loose = await h.post('/tasks', { title: 'no project' });
  assert.equal((await h.raw('POST', `/tasks/${loose.id}/github`, {})).status, 400);
});

test('GitHub refusals come back as readable 400s', async () => {
  const project = await h.post('/projects', { name: 'Missing', github_repo: 'octo/missing' });
  const epic = await h.post('/epics', { project_id: project.id, title: 'E' });
  const res = await h.raw('POST', `/epics/${epic.id}/github`, {});
  assert.equal(res.status, 400);
  assert.match(res.body.error, /not found/i);
  assert.equal((await h.get(`/projects/${project.id}/dev`)).epics[0].github_issue_number, null);
});

test('sync completes items whose issues were closed on GitHub', async () => {
  const project = await h.post('/projects', { name: 'Sync', github_repo: 'octo/app' });
  const epic = await h.post('/epics', { project_id: project.id, title: 'E' });
  const story = await h.post('/stories', { epic_id: epic.id, title: 'S' });
  const done = await h.post('/tasks', { title: 'will be fixed', story_id: story.id });
  const dropped = await h.post('/tasks', { title: 'wont do', project_id: project.id });
  const stillOpen = await h.post('/tasks', { title: 'still open', project_id: project.id });
  const bug = await h.post('/ideas', { kind: 'bug', title: 'b', project_id: project.id });
  const urls = {};
  for (const [path, id] of [['stories', story.id], ['tasks', done.id], ['tasks', dropped.id], ['tasks', stillOpen.id], ['ideas', bug.id]]) {
    urls[`${path}${id}`] = (await h.post(`/${path}/${id}/github`, {})).item.github_issue_url;
  }
  closeOnGitHub(urls[`stories${story.id}`]);
  closeOnGitHub(urls[`tasks${done.id}`]);
  closeOnGitHub(urls[`tasks${dropped.id}`], 'not_planned');
  closeOnGitHub(urls[`ideas${bug.id}`]);

  const result = await h.post(`/projects/${project.id}/github/sync`, {});
  assert.equal(result.checked, 5);
  assert.equal(result.completed, 4);
  assert.deepEqual(result.failed, []);

  assert.equal((await h.get(`/tasks/${done.id}`)).status, 'done');
  assert.equal((await h.get(`/tasks/${done.id}`)).github_issue_state, 'closed');
  assert.equal((await h.get(`/tasks/${dropped.id}`)).status, 'cancelled');
  assert.equal((await h.get(`/tasks/${stillOpen.id}`)).status, 'todo');
  const tree = await h.get(`/projects/${project.id}/dev`);
  assert.equal(tree.epics[0].stories[0].status, 'done');
  assert.equal((await h.get('/ideas?kind=bug')).find((i) => i.id === bug.id).status, 'archived');

  // Running it again changes nothing further.
  assert.equal((await h.post(`/projects/${project.id}/github/sync`, {})).completed, 0);
});

test('unlinking forgets the issue so the next push files a new one', async () => {
  const project = await h.post('/projects', { name: 'Unlink', github_repo: 'octo/app' });
  const task = await h.post('/tasks', { title: 't', project_id: project.id });
  const first = (await h.post(`/tasks/${task.id}/github`, {})).item.github_issue_number;
  const cleared = (await h.del(`/tasks/${task.id}/github`)).item;
  assert.equal(cleared.github_issue_number, null);
  assert.equal(cleared.github_issue_url, null);
  const second = (await h.post(`/tasks/${task.id}/github`, {})).item.github_issue_number;
  assert.notEqual(second, first);
});

test('another workspace\'s items cannot be pushed, unlinked or synced — and GitHub is never called', async () => {
  const theirs = await h.post('/workspaces', { name: 'Theirs' });
  await h.post(`/workspaces/${theirs.id}/activate`);
  const project = await h.post('/projects', { name: 'Theirs', github_repo: 'octo/app' });
  const epic = await h.post('/epics', { project_id: project.id, title: 'E' });
  const story = await h.post('/stories', { epic_id: epic.id, title: 'S' });
  const task = await h.post('/tasks', { title: 'T', project_id: project.id });
  const idea = await h.post('/ideas', { title: 'I', project_id: project.id });
  const mine = (await h.get('/workspaces')).workspaces.find((w) => w.id !== theirs.id);
  await h.post(`/workspaces/${mine.id}/activate`);

  const before = requests.length;
  for (const [method, url] of [
    ['POST', `/epics/${epic.id}/github`], ['DELETE', `/epics/${epic.id}/github`],
    ['POST', `/stories/${story.id}/github`], ['DELETE', `/stories/${story.id}/github`],
    ['POST', `/tasks/${task.id}/github`], ['DELETE', `/tasks/${task.id}/github`],
    ['POST', `/ideas/${idea.id}/github`], ['DELETE', `/ideas/${idea.id}/github`],
    ['POST', `/projects/${project.id}/github/sync`],
  ]) {
    assert.equal((await h.raw(method, url, {})).status, 404, `${method} ${url}`);
  }
  assert.equal(requests.length, before);
});
