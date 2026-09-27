// GitHub integration: a minimal REST client plus the mapping between the dev
// hierarchy (epics, stories, tasks, ideas/bugs) and GitHub issues.
//
// The app stays the source of truth for an item's text: pushing creates the
// issue, or rewrites its title/body/state if the item is already linked.
// Syncing reads back only the open/closed state, so an issue closed on GitHub
// (by a PR's "Fixes #12", say) marks the item done here.
//
// Tokens are per user, like the Anthropic key. The GITHUB_TOKEN environment
// variable is a fallback in single-user mode; in multi mode it would let every
// account write to the operator's repositories, so it is only used there when
// GITHUB_ENV_TOKEN_SHARED=1.
import { getSettings } from './data/settings.js';
import { AUTH_MODE } from './auth.js';

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

// owner/name, as GitHub allows them. Anchored and character-limited so a
// stored value can only ever form a path under /repos/.
export const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export function isValidRepo(value) {
  return typeof value === 'string' && REPO_PATTERN.test(value) && !value.endsWith('/.') && !value.endsWith('/..');
}

// Accept a pasted URL too: https://github.com/owner/name(.git)
export function normaliseRepo(value) {
  if (value == null) return null;
  let s = String(value).trim();
  if (!s) return null;
  const m = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?(?:[#?].*)?$/i);
  if (m) s = m[1];
  return s;
}

export function effectiveToken(scope) {
  const stored = (getSettings(scope).github_token || '').trim();
  if (stored) return stored;
  if (AUTH_MODE === 'multi' && process.env.GITHUB_ENV_TOKEN_SHARED !== '1') return null;
  return process.env.GITHUB_TOKEN || null;
}

export function githubAvailable(scope) {
  return !!effectiveToken(scope);
}

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function gh(scope, method, path, body) {
  const token = effectiveToken(scope);
  if (!token) throw new GitHubError('No GitHub token configured — add one in Settings', 0);
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'task-manager',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new GitHubError('Could not reach GitHub', 0);
  }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const detail = data?.errors?.map((e) => e.message || e.code).filter(Boolean).join('; ');
    throw new GitHubError(`${data?.message || res.statusText}${detail ? ` (${detail})` : ''}`, res.status);
  }
  return data;
}

// A GitHub failure, phrased for the person who has to fix it.
export function describeError(err) {
  if (!(err instanceof GitHubError)) return 'GitHub request failed';
  if (err.status === 401) return 'GitHub rejected the token — check it in Settings';
  if (err.status === 403) return `GitHub refused the request: ${err.message}`;
  if (err.status === 404) return 'Repository or issue not found, or the token has no access to it';
  if (err.status === 410) return 'Issues are disabled on this repository';
  return err.message;
}

export async function getViewer(scope) {
  const u = await gh(scope, 'GET', '/user');
  return { login: u.login, name: u.name, avatar_url: u.avatar_url, html_url: u.html_url };
}

// Repositories the token can push issues to, most recently updated first.
export async function listRepos(scope) {
  const repos = await gh(scope, 'GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member');
  return repos.map((r) => ({
    full_name: r.full_name, private: r.private, html_url: r.html_url,
    has_issues: r.has_issues, description: r.description || '',
  }));
}

export async function getRepo(scope, repo) {
  const r = await gh(scope, 'GET', `/repos/${repo}`);
  return { full_name: r.full_name, private: r.private, html_url: r.html_url, has_issues: r.has_issues };
}

export async function createIssue(scope, repo, issue) {
  return gh(scope, 'POST', `/repos/${repo}/issues`, issue);
}

export async function updateIssue(scope, repo, number, issue) {
  return gh(scope, 'PATCH', `/repos/${repo}/issues/${Number(number)}`, issue);
}

export async function getIssue(scope, repo, number) {
  return gh(scope, 'GET', `/repos/${repo}/issues/${Number(number)}`);
}

// ---------- mapping items to issues ----------

const LABELS = { epic: 'epic', story: 'user story', task: 'task', idea: 'enhancement', bug: 'bug' };

const DONE_STAGES = new Set(['done', 'deployed']);

// { state, state_reason } the issue should have, given the item.
export function issueStateFor(type, item) {
  if (type === 'task') {
    if (item.status === 'cancelled') return { state: 'closed', state_reason: 'not_planned' };
    if (item.status === 'done') return { state: 'closed', state_reason: 'completed' };
  } else if (type === 'idea') {
    if (item.status === 'archived') return { state: 'closed', state_reason: 'not_planned' };
  } else if (DONE_STAGES.has(item.status)) {
    return { state: 'closed', state_reason: 'completed' };
  }
  return { state: 'open' };
}

// Reference a parent issue: "#12" in the same repo, "owner/name#12" across.
function issueRef(parent, repo) {
  if (!parent?.github_issue_number) return null;
  return parent.github_repo === repo ? `#${parent.github_issue_number}` : `${parent.github_repo}#${parent.github_issue_number}`;
}

// Title, body and labels for an item. `ctx` carries whatever the item hangs
// off: { project, epic, story }.
export function issueFor(type, item, repo, ctx = {}) {
  const kind = type === 'idea' ? (item.kind === 'bug' ? 'bug' : 'idea') : type;
  const text = (type === 'task' ? item.notes : item.description) || '';
  const lines = [];
  if (text.trim()) lines.push(text.trim(), '');

  const context = [];
  if (ctx.project) context.push(`**Project:** ${ctx.project.name}`);
  if (ctx.epic) {
    const ref = issueRef(ctx.epic, repo);
    context.push(`**Epic:** ${ctx.epic.title}${ref ? ` (${ref})` : ''}`);
  }
  if (ctx.story) {
    const ref = issueRef(ctx.story, repo);
    context.push(`**User story:** ${ctx.story.title}${ref ? ` (${ref})` : ''}`);
  }
  if (type === 'task') {
    if (item.priority && item.priority !== 'medium') context.push(`**Priority:** ${item.priority}`);
    if (item.due_date) context.push(`**Due:** ${item.due_date}`);
  } else if (type === 'epic') {
    if (item.start_date) context.push(`**Start:** ${item.start_date}`);
    if (item.target_date) context.push(`**Target:** ${item.target_date}`);
  } else if (type === 'story' && item.due_date) {
    context.push(`**Due:** ${item.due_date}`);
  }
  if (context.length) lines.push(context.join('  \n'), '');

  if (type === 'task' && item.subtasks?.length) {
    lines.push('### Checklist');
    for (const s of item.subtasks) lines.push(`- [${s.done ? 'x' : ' '}] ${s.title}`);
    lines.push('');
  }
  lines.push(`<sub>Pushed from Task Manager (${kind} #${item.id})</sub>`);

  return {
    title: String(item.title).slice(0, 256),
    body: lines.join('\n'),
    labels: [LABELS[kind]],
  };
}
