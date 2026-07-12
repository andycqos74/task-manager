import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import MyDay from './views/MyDay.jsx';
import Schedule from './views/Schedule.jsx';
import AllTasks from './views/AllTasks.jsx';
import Projects from './views/Projects.jsx';
import ProjectDetail from './views/ProjectDetail.jsx';
import Gantt from './views/Gantt.jsx';
import Settings from './views/Settings.jsx';
import TaskDetail from './components/TaskDetail.jsx';

export default function App() {
  const [view, setView] = useState({ name: 'myday' });
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState({ workday_minutes: 480, ai_available: false });
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState(null);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const reportError = useCallback((err) => {
    setError(err.message || String(err));
    setTimeout(() => setError(null), 5000);
  }, []);

  useEffect(() => {
    api.get('/projects').then(setProjects).catch(reportError);
    api.get('/settings').then(setSettings).catch(reportError);
  }, [refreshKey, reportError]);

  const viewProps = {
    refreshKey,
    refresh,
    projects,
    settings,
    onSelectTask: setSelectedTaskId,
    onError: reportError,
    setView,
  };

  const navItem = (key, label, target) => (
    <button
      key={key}
      className={`nav-item ${view.name === key && (view.projectId ?? null) === (target?.projectId ?? null) ? 'active' : ''}`}
      onClick={() => setView(target || { name: key })}
    >
      {label}
    </button>
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <h1 className="logo">Tasks</h1>
        <nav>
          {navItem('myday', '☀️ My Day')}
          {navItem('schedule', '📅 Upcoming')}
          {navItem('all', '📋 All Tasks')}
          {navItem('gantt', '📊 Timeline')}
        </nav>
        <div className="sidebar-section">
          <div className="sidebar-heading">
            <span>Projects</span>
            <button className="link" onClick={() => setView({ name: 'projects' })}>manage</button>
          </div>
          <nav>
            {projects
              .filter((p) => p.status === 'active' || p.status === 'on_hold')
              .map((p) => (
                <button
                  key={p.id}
                  className={`nav-item ${view.name === 'project' && view.projectId === p.id ? 'active' : ''}`}
                  onClick={() => setView({ name: 'project', projectId: p.id })}
                >
                  <span className="dot" style={{ background: p.color }} />
                  <span className="nav-label">{p.name}</span>
                  {p.open_tasks > 0 && <span className="count">{p.open_tasks}</span>}
                </button>
              ))}
          </nav>
        </div>
        <div className="sidebar-footer">
          <button className="nav-item" onClick={() => setView({ name: 'settings' })}>⚙️ Settings</button>
          <div className={`ai-badge ${settings.ai_available ? 'on' : ''}`}>
            AI {settings.ai_available ? 'enabled' : 'off'}
          </div>
        </div>
      </aside>

      <main className="main">
        {error && <div className="toast error">{error}</div>}
        {view.name === 'myday' && <MyDay {...viewProps} />}
        {view.name === 'schedule' && <Schedule {...viewProps} />}
        {view.name === 'all' && <AllTasks {...viewProps} />}
        {view.name === 'gantt' && <Gantt {...viewProps} />}
        {view.name === 'projects' && <Projects {...viewProps} />}
        {view.name === 'project' && <ProjectDetail {...viewProps} projectId={view.projectId} key={view.projectId} />}
        {view.name === 'settings' && <Settings {...viewProps} />}
      </main>

      {selectedTaskId && (
        <TaskDetail
          taskId={selectedTaskId}
          projects={projects}
          settings={settings}
          onClose={() => setSelectedTaskId(null)}
          onChanged={refresh}
          onError={reportError}
        />
      )}
    </div>
  );
}
