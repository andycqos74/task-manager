import React, { useEffect, useState } from 'react';
import { api, sortTasks } from '../api.js';
import QuickAdd from '../components/QuickAdd.jsx';
import TaskList from '../components/TaskList.jsx';
import TaskFilterBar from '../components/TaskFilterBar.jsx';

// Tasks with no project — a catch-all for anything quickly captured (e.g.
// from the notepad) that still needs triaging: a project, dates, etc.
export default function Review({ refreshKey, refresh, onSelectTask, onError }) {
  const [tasks, setTasks] = useState([]);
  const [tags, setTags] = useState([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [priority, setPriority] = useState('');
  const [sort, setSort] = useState('created');
  const [showDone, setShowDone] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams({ project_id: 'none' });
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    if (showDone) params.set('include_done', '1');
    api.get(`/tasks?${params}`).then(setTasks).catch(onError);
    api.get('/tags').then(setTags).catch(() => {});
  }, [refreshKey, q, tag, showDone]);

  const shown = sortTasks(priority ? tasks.filter((t) => t.priority === priority) : tasks, sort);

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h2>Review</h2>
          <div className="subtitle">Tasks with no project yet — give them a home, a date, or a priority</div>
        </div>
      </header>

      <TaskFilterBar
        q={q} onQChange={setQ}
        tags={tags} tag={tag} onTagChange={setTag}
        priority={priority} onPriorityChange={setPriority}
        sort={sort} onSortChange={setSort}
        showDone={showDone} onShowDoneChange={setShowDone}
      />

      <QuickAdd onCreated={refresh} onError={onError} placeholder="Quickly capture a task to review later" />
      <TaskList tasks={shown} empty="Nothing to review — every task has a project." onSelect={onSelectTask} onChanged={refresh} onError={onError} />
    </div>
  );
}
