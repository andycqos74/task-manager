import React, { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import MyDay from './views/MyDay.jsx';
import Schedule from './views/Schedule.jsx';
import AllTasks from './views/AllTasks.jsx';
import Review from './views/Review.jsx';
import Projects from './views/Projects.jsx';
import ProjectDetail from './views/ProjectDetail.jsx';
import Gantt from './views/Gantt.jsx';
import Settings from './views/Settings.jsx';
import TaskDetail from './components/TaskDetail.jsx';
import Notepad from './components/Notepad.jsx';
import { SunIcon, CalendarIcon, ListIcon, BarChartIcon, GearIcon, MenuIcon, InboxIcon } from './icons.jsx';
import logo from './assets/logo.jpg';

const NAV = [
  { key: 'myday', label: 'My Day', Icon: SunIcon },
  { key: 'schedule', label: 'Upcoming', Icon: CalendarIcon },
  { key: 'all', label: 'All Tasks', Icon: ListIcon },
  { key: 'review', label: 'Review', Icon: InboxIcon },
  { key: 'gantt', label: 'Timeline', Icon: BarChartIcon },
];

// Below this width the sidebar auto-collapses (matches the notepad's own
// mobile breakpoint so both switch layout together).
const NARROW_QUERY = '(max-width: 780px)';

export default function App() {
  const [view, setView] = useState({ name: 'myday' });
  const [projects, setProjects] = useState([]);
  const [settings, setSettings] = useState({ workday_minutes: 480, ai_available: false });
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [error, setError] = useState(null);
  const [isNarrow, setIsNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  const [collapsed, setCollapsed] = useState(isNarrow);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Auto-collapse (or re-expand) the sidebar when the viewport crosses the
  // narrow-screen breakpoint, independent of any manual toggle in between.
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (e) => { setIsNarrow(e.matches); setCollapsed(e.matches); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // On narrow screens the sidebar is a full overlay, so picking a
  // destination should close it again; on desktop it's a permanent rail/
  // panel and shouldn't collapse just because a link was clicked.
  const goTo = useCallback((v) => {
    setView(v);
    if (isNarrow) setCollapsed(true);
  }, [isNarrow]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-w', collapsed ? '72px' : '262px');
  }, [collapsed]);

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
        <aside className={`sidebar ${collapsed ? 'collapsed' : ''}`}>
          <div className="sidebar-brand">
            <button className="sidebar-toggle" onClick={() => setCollapsed((c) => !c)} aria-label="Toggle menu">
              <MenuIcon width={18} height={18} />
            </button>
            <img className="sidebar-logo" src={logo} alt="" />
            <span className="sidebar-wordmark">this-organiser</span>
          </div>

          <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {NAV.map(({ key, label, Icon }) => (
              <button
                key={key}
                className={`nav-item ${view.name === key ? 'active' : ''}`}
                onClick={() => goTo({ name: key })}
              >
                <Icon width={18} height={18} />
                <span className="nav-label">{label}</span>
              </button>
            ))}
          </nav>

          <div className="sidebar-section">
            <div className="sidebar-heading">
              <span>Projects</span>
              <button className="link" onClick={() => goTo({ name: 'projects' })}>Manage</button>
            </div>
            <nav style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {projects
                .filter((p) => p.status === 'active' || p.status === 'on_hold')
                .map((p) => (
                  <button
                    key={p.id}
                    className={`nav-item ${view.name === 'project' && view.projectId === p.id ? 'active' : ''}`}
                    onClick={() => goTo({ name: 'project', projectId: p.id })}
                  >
                    <span className="dot" style={{ background: p.color, boxShadow: `0 0 0 3px color-mix(in srgb, ${p.color} 22%, transparent)` }} />
                    <span className="nav-label">{p.name}</span>
                    {p.open_tasks > 0 && <span className="count">{p.open_tasks}</span>}
                  </button>
                ))}
            </nav>
          </div>

          <div className="sidebar-footer">
            <button className={`nav-item ${view.name === 'settings' ? 'active' : ''}`} onClick={() => goTo({ name: 'settings' })}>
              <GearIcon width={18} height={18} />
              <span className="nav-label">Settings</span>
            </button>
            <div className={`ai-badge ${settings.ai_available ? 'on' : ''}`}>
              AI {settings.ai_available ? 'enabled' : 'off'}
            </div>
          </div>
        </aside>

        {!collapsed && <div className="sidebar-backdrop" onClick={() => setCollapsed(true)} />}

        {collapsed && (
          <button className="sidebar-reopen" onClick={() => setCollapsed(false)} aria-label="Open menu">
            <MenuIcon width={18} height={18} />
          </button>
        )}

        <main className="main">
          {error && <div className="toast error">{error}</div>}
          {view.name === 'myday' && <MyDay {...viewProps} />}
          {view.name === 'schedule' && <Schedule {...viewProps} />}
          {view.name === 'all' && <AllTasks {...viewProps} />}
          {view.name === 'review' && <Review {...viewProps} />}
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
