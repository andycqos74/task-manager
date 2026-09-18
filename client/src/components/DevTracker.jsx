import React, { useEffect, useState } from 'react';
import { api, DEV_STATUSES } from '../api.js';
import QuickAdd from './QuickAdd.jsx';
import TaskList from './TaskList.jsx';

// The Development tab body for a project: an Epic → Story → Task accordion,
// fed by GET /projects/:id/dev. Epic/story fields edit inline; tasks open the
// shared TaskDetail panel via onSelectTask.
export default function DevTracker({ projectId, refreshKey, refresh, onSelectTask, onError }) {
  const [tree, setTree] = useState(null);
  const [newEpic, setNewEpic] = useState('');
  const [openEpics, setOpenEpics] = useState({});
  const [openStories, setOpenStories] = useState({});

  function reload() {
    api.get(`/projects/${projectId}/dev`).then(setTree).catch(onError);
  }
  useEffect(reload, [projectId, refreshKey]);

  function bump() { reload(); refresh(); }

  async function addEpic(e) {
    e.preventDefault();
    const t = newEpic.trim();
    if (!t) return;
    try {
      const ep = await api.post('/epics', { project_id: projectId, title: t });
      setNewEpic('');
      setOpenEpics((o) => ({ ...o, [ep.id]: true }));
      bump();
    } catch (err) { onError(err); }
  }

  const patchEpic = (id, body) => api.patch(`/epics/${id}`, body).then(bump).catch(onError);
  const delEpic = (id) => {
    if (confirm('Delete this epic and its stories? Any tasks are kept but unlinked.')) {
      api.delete(`/epics/${id}`).then(bump).catch(onError);
    }
  };
  const patchStory = (id, body) => api.patch(`/stories/${id}`, body).then(bump).catch(onError);
  const delStory = (id) => {
    if (confirm('Delete this story? Any tasks are kept but unlinked.')) {
      api.delete(`/stories/${id}`).then(bump).catch(onError);
    }
  };

  if (!tree) return <div className="empty">Loading…</div>;

  return (
    <div className="dev-tree">
      <form className="quick-add" onSubmit={addEpic}>
        <span className="quick-add-plus">＋</span>
        <input value={newEpic} onChange={(e) => setNewEpic(e.target.value)} placeholder="Add an epic — press Enter" />
      </form>

      {tree.epics.length === 0 && <div className="empty">No epics yet. Add one above to start planning this project’s work.</div>}

      {tree.epics.map((epic) => (
        <div key={epic.id} className="epic-block">
          <div className="epic-row">
            <button className="tree-toggle" onClick={() => setOpenEpics((o) => ({ ...o, [epic.id]: !o[epic.id] }))}>
              {openEpics[epic.id] ? '▾' : '▸'}
            </button>
            <input
              className="tree-title"
              key={`et-${epic.id}-${epic.updated_at}`}
              defaultValue={epic.title}
              onBlur={(e) => e.target.value.trim() && e.target.value !== epic.title && patchEpic(epic.id, { title: e.target.value })}
            />
            <EpicCounts epic={epic} />
            <select className={`dev-status dev-status-${epic.status}`} value={epic.status} onChange={(e) => patchEpic(epic.id, { status: e.target.value })}>
              {DEV_STATUSES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <input type="date" className="tree-date" title="Start" value={epic.start_date || ''} onChange={(e) => patchEpic(epic.id, { start_date: e.target.value || null })} />
            <input type="date" className="tree-date" title="Target" value={epic.target_date || ''} onChange={(e) => patchEpic(epic.id, { target_date: e.target.value || null })} />
            <button className="link danger-link" onClick={() => delEpic(epic.id)}>✕</button>
          </div>

          {openEpics[epic.id] && (
            <div className="epic-body">
              {epic.stories.map((story) => (
                <div key={story.id} className="story-block">
                  <div className="story-row">
                    <button className="tree-toggle" onClick={() => setOpenStories((o) => ({ ...o, [story.id]: !o[story.id] }))}>
                      {openStories[story.id] ? '▾' : '▸'}
                    </button>
                    <input
                      className="tree-title"
                      key={`st-${story.id}-${story.updated_at}`}
                      defaultValue={story.title}
                      onBlur={(e) => e.target.value.trim() && e.target.value !== story.title && patchStory(story.id, { title: e.target.value })}
                    />
                    <StoryCounts story={story} />
                    <select className={`dev-status dev-status-${story.status}`} value={story.status} onChange={(e) => patchStory(story.id, { status: e.target.value })}>
                      {DEV_STATUSES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                    </select>
                    <input type="date" className="tree-date" title="Due" value={story.due_date || ''} onChange={(e) => patchStory(story.id, { due_date: e.target.value || null })} />
                    <button className="link danger-link" onClick={() => delStory(story.id)}>✕</button>
                  </div>

                  {openStories[story.id] && (
                    <div className="story-body">
                      {story.tasks.length > 0 && (
                        <TaskList tasks={story.tasks} showProject={false} onSelect={onSelectTask} onChanged={bump} onError={onError} />
                      )}
                      <QuickAdd defaults={{ story_id: story.id }} onCreated={bump} onError={onError} placeholder="Add a task to this story" />
                    </div>
                  )}
                </div>
              ))}
              <StoryAdd epicId={epic.id} onAdded={bump} onError={onError} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// "1 story" / "4 stories" — the count badges read as English, not bare numbers.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// How much work an epic holds: its user stories, and the tasks under them.
// Counted from the tree the tab already has, so the badges always agree with
// the rows below them.
function EpicCounts({ epic }) {
  const tasks = epic.stories.reduce((n, s) => n + s.tasks.length, 0);
  return (
    <span className="tree-badges">
      <span className="badge count-badge stories" title="User stories in this epic">
        {plural(epic.stories.length, 'story', 'stories')}
      </span>
      <span className="badge count-badge tasks" title="Tasks across this epic's stories">
        {plural(tasks, 'task', 'tasks')}
      </span>
    </span>
  );
}

// Tasks in a story, as done / total.
function StoryCounts({ story }) {
  const done = story.tasks.filter((t) => t.status === 'done').length;
  const complete = story.tasks.length > 0 && done === story.tasks.length;
  return (
    <span className="tree-badges">
      <span className={`badge count-badge tasks ${complete ? 'complete' : ''}`} title="Tasks in this story (done / total)">
        {done}/{plural(story.tasks.length, 'task', 'tasks')}
      </span>
    </span>
  );
}

function StoryAdd({ epicId, onAdded, onError }) {
  const [title, setTitle] = useState('');
  async function submit(e) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    try { await api.post('/stories', { epic_id: epicId, title: t }); setTitle(''); onAdded(); }
    catch (err) { onError(err); }
  }
  return (
    <form className="quick-add story-add" onSubmit={submit}>
      <span className="quick-add-plus">＋</span>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a user story — press Enter" />
    </form>
  );
}
