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
import Notepad from './components/Notepad.jsx';
import { SunIcon, CalendarIcon, ListIcon, BarChartIcon, GearIcon } from './icons.jsx';

const NAV = [
  { key: 'myday', label: 'My Day', Icon: SunIcon },
  { key: 'schedule', label: 'Upcoming', Icon: CalendarIcon },
  { key: 'all', label: 'All Tasks', Icon: ListIcon },
  { key: 'gantt', label: 'Timeline', Icon: BarChartIcon },
];

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

  // What the always-visible notepad can attach a note to right now.
  const noteContext = {
    projectId: view.name === 'project' ? view.projectId : null,
    taskId: selectedTaskId,
  };

  return (
    <div className="app-shell">
      <div className="app">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <div className="sidebar-logo">T</div>
            <span className="sidebar-wordmark">Tasks</span>
          </div>

          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {NAV.map(({ key, label, Icon }) => (
              <button
                key={key}
                className={`nav-item ${view.name === key ? 'active' : ''}`}
                onClick={() => setView({ name: key })}
              >
                <Icon width={18} height={18} />
                <span className="nav-label">{label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-section">
            <div className="sidebar-heading">
              <span>Projects</span>
              <button className="link" onClick={() => setView({ name: 'projects' })}>Manage</button>
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {projects
                .filter((p) => p.status === 'active' || p.status === 'on_hold')
                .map((p) => (
                  <button
                    key={p.id}
                    className={`nav-item ${view.name === 'project' && view.projectId === p.id ? 'active' : ''}`}
                    onClick={() => setView({ name: 'project', projectId: p.id })}
                  >
                    <span className="dot" style={{ background: p.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${p.color} 22%, transparent)` }} />
                    <span className="nav-label">{p.name}</span>
                    {p.open_tasks > 0 && <span className="count">{p.open_tasks}</span>}
                  </button>
                ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <button className={`nav-item ${view.name === 'settings' ? 'active' : ''}`} onClick={() => setView({ name: 'settings' })}>
              <GearIcon width={18} height={18} />
              <span className="nav-label">Settings</span>
            </button>
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
      </div>

      {selectedTaskId && (
        <>
          <div className="detail-backdrop" onClick={() => setSelectedTaskId(null)} />
          <TaskDetail
            taskId={selectedTaskId}
            projects={projects}
            settings={settings}
            onClose={() => setSelectedTaskId(null)}
            onChanged={refresh}
            onError={reportError}
          />
        </>
      )}

      <Notepad
        projects={projects}
        context={noteContext}
        refresh={refresh}
        onError={reportError}
      />
    </div>
  );
}
