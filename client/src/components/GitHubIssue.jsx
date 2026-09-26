import React, { useState } from 'react';
import { api } from '../api.js';

const PATHS = { epic: 'epics', story: 'stories', task: 'tasks', idea: 'ideas' };

// The GitHub issue control shown on an epic, story, task or idea/bug. A linked
// item shows its issue number (opening it on GitHub) with a button to push the
// latest title/description/status to it; an unlinked one offers "Push to
// GitHub" when its project has a repository and a token is configured.
// `compact` is for the dense dev-tree rows: no unlink, shorter labels.
export default function GitHubIssue({ type, item, canPush, compact = false, onChanged, onError }) {
  const [busy, setBusy] = useState(false);
  const path = `/${PATHS[type]}/${item.id}/github`;

  async function push(e) {
    e?.stopPropagation();
    setBusy(true);
    try {
      const { item: updated } = await api.post(path);
      onChanged?.(updated);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    if (!confirm(`Unlink issue #${item.github_issue_number}? The issue stays on GitHub; pushing again files a new one.`)) return;
    try {
      const { item: updated } = await api.delete(path);
      onChanged?.(updated);
    } catch (err) {
      onError?.(err);
    }
  }

  if (item.github_issue_number) {
    const state = item.github_issue_state === 'closed' ? 'closed' : 'open';
    return (
      <span className="gh-issue">
        <a
          className={`badge gh-badge ${state}`}
          href={item.github_issue_url}
          target="_blank"
          rel="noreferrer"
          title={`${item.github_repo}#${item.github_issue_number} (${state}) — open on GitHub`}
          onClick={(e) => e.stopPropagation()}
        >
          <GitHubMark /> #{item.github_issue_number}
        </a>
        <button className="link" onClick={push} disabled={busy} title="Push the latest title, description and status to this issue">
          {busy ? '…' : compact ? '↻' : 'update issue'}
        </button>
        {!compact && <button className="link" onClick={unlink}>unlink</button>}
      </span>
    );
  }

  if (!canPush) return null;
  return (
    <button className={compact ? 'link gh-push' : 'btn-outline gh-push'} onClick={push} disabled={busy} title="Create a GitHub issue for this">
      <GitHubMark /> {busy ? 'Pushing…' : compact ? 'push' : 'Push to GitHub'}
    </button>
  );
}

export function GitHubMark() {
  return (
    <svg className="gh-mark" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
