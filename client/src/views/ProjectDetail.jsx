import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import QuickAdd from '../components/QuickAdd.jsx';
import TaskList from '../components/TaskList.jsx';
import DevTracker from '../components/DevTracker.jsx';

export default function ProjectDetail({ projectId, refreshKey, refresh, onSelectTask, onError, setView }) {
  const [project, setProject] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [showDone, setShowDone] = useState(false);
  const [tab, setTab] = useState('tasks');

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
        <DevTracker projectId={project.id} refreshKey={refreshKey} refresh={refresh} onSelectTask={onSelectTask} onError={onError} />
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
