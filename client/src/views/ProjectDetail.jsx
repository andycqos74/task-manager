import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import QuickAdd from '../components/QuickAdd.jsx';
import TaskList from '../components/TaskList.jsx';
import DevTracker from '../components/DevTracker.jsx';
import WorkspaceMove from '../components/WorkspaceMove.jsx';
import { GitHubMark } from '../components/GitHubIssue.jsx';

export default function ProjectDetail({ projectId, refreshKey, refresh, onSelectTask, onError, setView, workspaces, activeWorkspaceId, settings }) {
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [tab, setTab] = useState('tasks');
  const githubReady = !!settings?.github_available;

  useEffect(() => {
    api.get('/projects').then((all) => {
      const p = all.find((x) => x.id === projectId);
      if (!p) return setView({ name: 'projects' });
      setProject(p);
    }).catch(onError);
    api.get(`/tasks?project_id=${projectId}${showDone ? '&include_done=1' : ''}`).then(setTasks).catch(onError);
  }, [refreshKey, projectId, showDone]);

  if (!project) return <div className="empty">Loading…</div>;
  const devTab = project.track_dev && tab === 'dev';

  async function patch(body) {
    try {
      await api.patch(`/projects/${project.id}`, body);
      refresh();
    } catch (err) {
      onError(err);
    }
  }

  // Moving takes the whole project with it — tasks, epics, stories, and the
  // ideas, bugs and notes filed against it — so the project leaves the current
  // workspace entirely and this view has nothing left to show.
  async function moveToWorkspace(workspaceId) {
    const target = workspaces.find((w) => w.id === workspaceId);
    if (!confirm(`Move "${project.name}" to ${target ? target.name : 'another workspace'}? Its tasks, epics, stories, ideas, bugs and notes move with it.`)) return;
    try {
      await api.post(`/projects/${project.id}/move`, { workspace_id: workspaceId });
      refresh();
      setView({ name: 'projects' });
    } catch (err) {
      onError(err);
    }
  }

  async function remove() {
    if (!confirm(`Delete project "${project.name}"? Its tasks will be kept without a project.`)) return;
    try {
      await api.delete(`/projects/${project.id}`);
      refresh();
      setView({ name: 'projects' });
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div className="project-title">
          <span className="dot big" style={{ background: project.color }} />
          <input
            className="detail-title"
            key={project.updated_at}
            defaultValue={project.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== project.name && patch({ name: e.target.value })}
          />
        </div>
        <button className="danger" onClick={remove}>Delete</button>
      </header>

      <div className="field-grid project-fields">
        <label>Description</label>
        <input
          key={`d-${project.updated_at}`}
          defaultValue={project.description}
          placeholder="What is this goal about?"
          onBlur={(e) => e.target.value !== project.description && patch({ description: e.target.value })}
        />
        <label>Status</label>
        <select value={project.status} onChange={(e) => patch({ status: e.target.value })}>
          <option value="active">Active</option>
          <option value="on_hold">On hold</option>
          <option value="completed">Completed</option>
          <option value="archived">Archived</option>
        </select>
        <label>Start date</label>
        <input type="date" value={project.start_date || ''} onChange={(e) => patch({ start_date: e.target.value || null })} />
        <label>Target date</label>
        <input type="date" value={project.target_date || ''} onChange={(e) => patch({ target_date: e.target.value || null })} />
        <label>Workspace</label>
        <WorkspaceMove
          workspaces={workspaces}
          currentId={project.workspace_id ?? activeWorkspaceId}
          onMove={moveToWorkspace}
          hint="Moving takes the project's tasks, epics, stories, ideas, bugs and notes with it"
        />
        <label>GitHub repo</label>
        <GitHubRepoField project={project} githubReady={githubReady} onSave={(repo) => patch({ github_repo: repo })}
          refresh={refresh} onError={onError} />
        <label>Track development</label>
        <label className="inline">
          <input type="checkbox" checked={!!project.track_dev} onChange={(e) => patch({ track_dev: e.target.checked })} />
          <span className="hint">Enable epics, user stories and a roadmap for this project</span>
        </label>
      </div>

      {project.track_dev && (
        <div className="tabs">
          <button className={`tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>Tasks</button>
          <button className={`tab ${tab === 'dev' ? 'active' : ''}`} onClick={() => setTab('dev')}>Development</button>
        </div>
      )}

      {devTab ? (
        <DevTracker projectId={project.id} refreshKey={refreshKey} refresh={refresh} onSelectTask={onSelectTask} onError={onError}
          canPush={githubReady && !!project.github_repo} />
      ) : (
        <>
          <div className="filters">
            <span className="subtitle">{project.done_tasks}/{project.total_tasks} tasks done</span>
            <label className="inline">
              <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show done
            </label>
          </div>

          <QuickAdd defaults={{ project_id: project.id }} onCreated={refresh} onError={onError}
            placeholder={`Add a task to ${project.name}`} />
          <TaskList tasks={tasks} showProject={false} empty="No tasks in this project yet."
            onSelect={onSelectTask} onChanged={refresh} onError={onError} />
        </>
      )}
    </div>
  );
}

// The repository this project's epics, stories, tasks and bugs are pushed to,
// picked from the token's repos (or typed / pasted as a URL), plus a sync that
// pulls issue state back: issues closed on GitHub complete their items here.
function GitHubRepoField({ project, githubReady, onSave, refresh, onError }) {
  const [repos, setRepos] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState(null);

  useEffect(() => {
    if (githubReady) api.get('/github/repos').then(setRepos).catch(() => setRepos([]));
  }, [githubReady]);

  async function sync() {
    setSyncing(true);
    setNotice(null);
    try {
      const r = await api.post(`/projects/${project.id}/github/sync`);
      const parts = [`Checked ${r.checked} issue${r.checked === 1 ? '' : 's'}`];
      if (r.completed) parts.push(`${r.completed} closed on GitHub and marked done here`);
      if (r.failed.length) parts.push(`${r.failed.length} failed: ${r.failed.map((f) => `${f.title} (${f.error})`).join('; ')}`);
      setNotice(parts.join(' · '));
      refresh();
    } catch (err) {
      onError(err);
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div>
      <div className="inline">
        <input
          key={`gh-${project.updated_at}`}
          list={`gh-repos-${project.id}`}
          defaultValue={project.github_repo || ''}
          placeholder="owner/repository"
          onBlur={(e) => e.target.value.trim() !== (project.github_repo || '') && onSave(e.target.value.trim() || null)}
          onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
        />
        <datalist id={`gh-repos-${project.id}`}>
          {repos.map((r) => <option key={r.full_name} value={r.full_name} />)}
        </datalist>
        {project.github_repo && (
          <a className="link" href={`https://github.com/${project.github_repo}`} target="_blank" rel="noreferrer">
            <GitHubMark /> open
          </a>
        )}
        {project.github_repo && githubReady && (
          <button className="btn-outline" onClick={sync} disabled={syncing} title="Mark items done whose issues were closed on GitHub">
            {syncing ? 'Syncing…' : 'Sync from GitHub'}
          </button>
        )}
      </div>
      <div className="hint" style={{ marginTop: 4 }}>
        {githubReady
          ? 'Epics, stories, tasks and bugs in this project can be pushed to this repository as issues.'
          : 'Add a GitHub token in Settings to push this project\'s work to GitHub as issues.'}
      </div>
      {notice && <div className="hint" style={{ marginTop: 4 }}>{notice}</div>}
    </div>
  );
}
