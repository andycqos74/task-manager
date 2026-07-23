import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const IDEA_STATUSES = [
  ['open', 'Open'],
  ['promoted', 'Promoted'],
  ['archived', 'Archived'],
];

// Ideas backlog: a capture pool separate from the to-do task lists. Ideas can
// be promoted into the dev hierarchy (epic / story / task).
export default function Backlog({ refreshKey, refresh, projects, onError }) {
  const [ideas, setIdeas] = useState([]);
  const [status, setStatus] = useState('open');
  const [projectFilter, setProjectFilter] = useState('');
  const [q, setQ] = useState('');
  const [title, setTitle] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  const devProjects = projects.filter((p) => p.track_dev);

  function load() {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (projectFilter) params.set('project_id', projectFilter);
    if (q) params.set('q', q);
    api.get(`/ideas?${params}`).then(setIdeas).catch(onError);
  }
  useEffect(load, [refreshKey, status, projectFilter, q]);

  async function addIdea(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    try {
      await api.post('/ideas', { title: t });
      setTitle('');
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function patchIdea(id, body) {
    try {
      await api.patch(`/ideas/${id}`, body);
      load();
    } catch (err) {
      onError(err);
    }
  }

  async function removeIdea(id) {
    if (!confirm('Delete this idea?')) return;
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
          <h2>Backlog</h2>
          <div className="subtitle">Raw ideas — promote the good ones into epics, stories or tasks</div>
        </div>
      </header>

      <div className="filters">
        <input className="search-input" placeholder="Search ideas…" value={q} onChange={(e) => setQ(e.target.value)} />
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

      <form className="quick-add" onSubmit={addIdea}>
        <span className="quick-add-plus">＋</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Capture an idea — press Enter" />
      </form>

      {ideas.length === 0 ? (
        <div className="empty">No ideas here yet. Capture one above, or turn a note or task into an idea.</div>
      ) : (
        <div className="idea-list">
          {ideas.map((idea) => (
            <IdeaCard
              key={idea.id}
              idea={idea}
              devProjects={devProjects}
              expanded={expandedId === idea.id}
              onToggle={() => setExpandedId(expandedId === idea.id ? null : idea.id)}
              onPatch={(body) => patchIdea(idea.id, body)}
              onRemove={() => removeIdea(idea.id)}
              onPromoted={() => { load(); refresh(); }}
              onError={onError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function IdeaCard({ idea, devProjects, expanded, onToggle, onPatch, onRemove, onPromoted, onError }) {
  return (
    <div className={`idea-card ${idea.status}`}>
      <div className="idea-head" onClick={onToggle}>
        <div className="idea-main">
          <div className="idea-title">{idea.title}</div>
          {idea.description && <div className="idea-desc">{idea.description.split('\n')[0]}</div>}
        </div>
        <div className="idea-meta">
          {idea.project_name && <span className="badge project" style={{ '--c': idea.project_color }}>{idea.project_name}</span>}
          <span className={`badge idea-status idea-status-${idea.status}`}>{idea.status}</span>
        </div>
      </div>
      {expanded && (
        <PromotePanel idea={idea} devProjects={devProjects} onPatch={onPatch} onRemove={onRemove} onPromoted={onPromoted} onError={onError} />
      )}
    </div>
  );
}

function PromotePanel({ idea, devProjects, onPatch, onRemove, onPromoted, onError }) {
  const [level, setLevel] = useState('epic');
  const [projectId, setProjectId] = useState(idea.project_id || (devProjects[0] && devProjects[0].id) || '');
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
      await api.post(`/ideas/${idea.id}/promote`, body);
      onPromoted();
    } catch (err) {
      onError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="idea-panel">
      {idea.description && idea.description.includes('\n') && (
        <pre className="idea-fulldesc">{idea.description}</pre>
      )}
      {idea.status !== 'promoted' && (
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
        {idea.status !== 'archived' ? (
          <button className="link" onClick={() => onPatch({ status: 'archived' })}>Archive</button>
        ) : (
          <button className="link" onClick={() => onPatch({ status: 'open' })}>Reopen</button>
        )}
        <button className="link danger-link" onClick={onRemove}>Delete</button>
      </div>
    </div>
  );
}
