import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const IDEA_STATUSES = [
  ['open', 'Open'],
  ['promoted', 'Promoted'],
  ['archived', 'Archived'],
];

// Per-kind display copy. Bugs and ideas share the same machinery; only the
// wording (and a card accent) differ.
const COPY = {
  idea: {
    heading: 'Backlog',
    subtitle: 'Raw ideas — promote the good ones into epics, stories or tasks',
    placeholder: 'Capture an idea — press Enter',
    empty: 'No ideas here yet. Capture one above, or turn a note or task into an idea.',
    search: 'Search ideas…',
  },
  bug: {
    heading: 'Bugs',
    subtitle: 'Reported bugs — attach to a project and promote into fix tasks',
    placeholder: 'Report a bug — press Enter',
    empty: 'No bugs here. Report one above, or turn a note or task into a bug.',
    search: 'Search bugs…',
  },
};

// Backlog list, shared by the Ideas Backlog (kind="idea") and Bugs (kind="bug").
export default function Backlog({ kind = 'idea', refreshKey, refresh, projects, onError }) {
  const copy = COPY[kind] || COPY.idea;
  const [items, setItems] = useState([]);
  const [status, setStatus] = useState('open');
  const [projectFilter, setProjectFilter] = useState('');
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [newProject, setNewProject] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const devProjects = projects.filter((p) => p.track_dev);

  function load() {
    const params = new URLSearchParams({ kind });
    if (status) params.set('status', status);
    if (projectFilter) params.set('project_id', projectFilter);
    if (q) params.set('q', q);
    api.get(`/ideas?${params}`).then(setItems).catch(onError);
  }
  useEffect(load, [kind, refreshKey, status, projectFilter, q]);

  async function addItem(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    try {
      await api.post('/ideas', { kind, title: t, project_id: newProject ? Number(newProject) : null });
      setTitle('');
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function patchItem(id, body) {
    try {
      await api.patch(`/ideas/${id}`, body);
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function removeItem(id) {
    if (!confirm(`Delete this ${kind}?`)) return;
    try {
      await api.delete(`/ideas/${id}`);
      load();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h2>{copy.heading}</h2>
          <div className="subtitle">{copy.subtitle}</div>
        </div>
      </header>

      <div className="filters">
        <input className="search-input" placeholder={copy.search} value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          {IDEA_STATUSES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          <option value="">All</option>
        </select>
        <select value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
          <option value="">Any project</option>
          <option value="none">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      <form className="quick-add" onSubmit={addItem}>
        <span className="quick-add-plus">＋</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={copy.placeholder} />
        <select className="quick-add-project" value={newProject} onChange={(e) => setNewProject(e.target.value)} title="Attach to a project">
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </form>

      {items.length === 0 ? (
        <div className="empty">{copy.empty}</div>
      ) : (
        <div className="idea-list">
          {items.map((item) => (
            <BacklogCard
              key={item.id}
              item={item}
              kind={kind}
              projects={projects}
              devProjects={devProjects}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              onPatch={(body) => patchItem(item.id, body)}
              onRemove={() => removeItem(item.id)}
              onPromoted={() => { load(); refresh(); }}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function BacklogCard({ item, kind, projects, devProjects, expanded, onToggle, onPatch, onRemove, onPromoted, onError }) {
  return (
    <div className={`idea-card ${kind} ${item.status}`}>
      <div className="idea-head" onClick={onToggle}>
        <div className="idea-main">
          <div className="idea-title">{item.title}</div>
          {item.description && <div className="idea-desc">{item.description.split('\n')[0]}</div>}
        </div>
        <div className="idea-meta">
          {item.project_name && <span className="badge project" style={{ '--c': item.project_color }}>{item.project_name}</span>}
          <span className={`badge idea-status idea-status-${item.status}`}>{item.status}</span>
        </div>
      </div>
      {expanded && (
        <PromotePanel item={item} projects={projects} devProjects={devProjects} onPatch={onPatch} onRemove={onRemove} onPromoted={onPromoted} onError={onError} />
      )}
    </div>
  );
}

function PromotePanel({ item, projects, devProjects, onPatch, onRemove, onPromoted, onError }) {
  const [level, setLevel] = useState('epic');
  const [projectId, setProjectId] = useState(item.project_id || (devProjects[0] && devProjects[0].id) || '');
  const [epics, setEpics] = useState([]);
  const [epicId, setEpicId] = useState('');
  const [busy, setBusy] = useState(false);

  // For story promotion we need the chosen project's epics.
  useEffect(() => {
    if ((level === 'story') && projectId) {
      api.get(`/epics?project_id=${projectId}`).then((es) => {
        setEpics(es);
        setEpicId(es[0] ? String(es[0].id) : '');
      }).catch(onError);
    }
  }, [level, projectId]);

  async function promote() {
    setBusy(true);
    try {
      const body = { level };
      if (level === 'epic') {
        if (!projectId) { onError(new Error('Pick a project first')); setBusy(false); return; }
        body.project_id = Number(projectId);
      } else if (level === 'story') {
        if (!epicId) { onError(new Error('Pick an epic first')); setBusy(false); return; }
        body.epic_id = Number(epicId);
      } else if (level === 'task') {
        if (projectId) body.project_id = Number(projectId);
      }
      await api.post(`/ideas/${item.id}/promote`, body);
      onPromoted();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="idea-panel">
      {item.description && item.description.includes('\n') && (
        <pre className="idea-fulldesc">{item.description}</pre>
      )}

      <div className="idea-project">
        <label>Project</label>
        <select value={item.project_id || ''} onChange={(e) => onPatch({ project_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">No project</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {item.status !== 'promoted' && (
        <div className="idea-promote">
          <label>Promote to</label>
          <select value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="epic">Epic</option>
            <option value="story">Story</option>
            <option value="task">Task</option>
          </select>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {level === 'task' && <option value="">No project</option>}
            {devProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {level === 'story' && (
            <select value={epicId} onChange={(e) => setEpicId(e.target.value)}>
              {epics.length === 0 && <option value="">No epics — create one first</option>}
              {epics.map((ep) => <option key={ep.id} value={ep.id}>{ep.title}</option>)}
            </select>
          )}
          <button className="ai-action-btn" onClick={promote} disabled={busy}>Promote</button>
        </div>
      )}
      <div className="idea-actions">
        {item.status !== 'archived' ? (
          <button className="link" onClick={() => onPatch({ status: 'archived' })}>Archive</button>
        ) : (
          <button className="link" onClick={() => onPatch({ status: 'open' })}>Reopen</button>
        )}
        <button className="link danger-link" onClick={onRemove}>Delete</button>
      </div>
    </div>
  );
}
