import React, { useState } from 'react';
import { api } from '../api.js';

const COLORS = ['#5b7c99', '#7c9a5b', '#b0763c', '#9a5b7c', '#5b9a94', '#8a6dbb', '#b05252'];

export default function Projects({ projects, refresh, onError, setView }) {
  const [name, setName] = useState('');

  async function create(e) {
    e.preventDefault();
    if (!name.trim()) return;
    try {
      const p = await api.post('/projects', {
        name: name.trim(),
        color: COLORS[projects.length % COLORS.length],
      });
      setName('');
      refresh();
      setView({ name: 'project', projectId: p.id });
    } catch (err) {
      onError(err);
    }
  }

  async function setStatus(p, status) {
    try {
      await api.patch(`/projects/${p.id}`, { status });
      refresh();
    } catch (err) {
      onError(err);
    }
  }

  return (
    <div className="view">
      <header className="view-header">
        <h2>Projects &amp; Goals</h2>
      </header>
      <form className="quick-add" onSubmit={create}>
        <span className="quick-add-plus">＋</span>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New project or goal — press Enter" />
      </form>
      <div className="project-grid">
        {projects.map((p) => (
          <div key={p.id} className={`project-card ${p.status}`}>
            <div className="project-card-head" onClick={() => setView({ name: 'project', projectId: p.id })}>
              <span className="dot big" style={{ background: p.color }} />
              <h3>{p.name}</h3>
            </div>
            <div className="subtitle">{p.description || 'No description'}</div>
            <div className="progress">
              <div className="progress-bar" style={{ width: p.total_tasks ? `${(p.done_tasks / p.total_tasks) * 100}%` : 0 }} />
            </div>
            <div className="project-card-meta">
              <span>{p.done_tasks}/{p.total_tasks} done</span>
              <span>{p.target_date ? `target ${p.target_date}` : ''}</span>
            </div>
            <div className="project-card-actions">
              <select value={p.status} onChange={(e) => setStatus(p, e.target.value)}>
                <option value="active">Active</option>
                <option value="on_hold">On hold</option>
                <option value="completed">Completed</option>
                <option value="archived">Archived</option>
              </select>
            </div>
          </div>
        ))}
        {projects.length === 0 && <div className="empty">No projects yet — create one above to group tasks under a larger goal.</div>}
      </div>
    </div>
  );
}
