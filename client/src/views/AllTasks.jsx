import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import QuickAdd from '../components/QuickAdd.jsx';
import TaskList from '../components/TaskList.jsx';

export default function AllTasks({ refreshKey, refresh, settings, onSelectTask, onError }) {
  const [tasks, setTasks] = useState([]);
  const [tags, setTags] = useState([]);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('');
  const [showDone, setShowDone] = useState(false);
  const [ranking, setRanking] = useState(null);
  const [ranking_busy, setRankingBusy] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (tag) params.set('tag', tag);
    if (showDone) params.set('include_done', '1');
    api.get(`/tasks?${params}`).then(setTasks).catch(onError);
    api.get('/tags').then(setTags).catch(() => {});
  }, [refreshKey, q, tag, showDone]);

  async function prioritise() {
    setRankingBusy(true);
    try {
      setRanking(await api.post('/ai/prioritise'));
    } catch (err) {
      onError(err);
    } finally {
      setRankingBusy(false);
    }
  }

  let shown = tasks;
  const reasonById = {};
  if (ranking) {
    const rankById = {};
    for (const r of ranking.ranking) {
      rankById[r.task_id] = r.rank;
      reasonById[r.task_id] = r.reason;
    }
    shown = [...tasks].sort((a, b) => (rankById[a.id] ?? 1e9) - (rankById[b.id] ?? 1e9));
  }

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h2>📋 All Tasks</h2>
        </div>
        <button onClick={prioritise} disabled={ranking_busy}>
          {ranking_busy ? 'Thinking…' : settings.ai_available ? '✨ Prioritise (AI)' : '✨ Prioritise'}
        </button>
      </header>

      <div className="filters">
        <input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={tag} onChange={(e) => setTag(e.target.value)}>
          <option value="">All tags</option>
          {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
        </select>
        <label className="inline">
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> show done
        </label>
        {ranking && <button className="link" onClick={() => setRanking(null)}>clear ranking</button>}
      </div>

      {ranking && <div className="banner info">{ranking.summary}</div>}

      <QuickAdd onCreated={refresh} onError={onError} />
      {ranking ? (
        <div className="task-list">
          {shown.map((t) => (
            <div key={t.id}>
              <TaskList tasks={[t]} onSelect={onSelectTask} onChanged={refresh} onError={onError} />
              {reasonById[t.id] && <div className="rank-reason">→ {reasonById[t.id]}</div>}
            </div>
          ))}
        </div>
      ) : (
        <TaskList tasks={shown} empty="No tasks match." onSelect={onSelectTask} onChanged={refresh} onError={onError} />
      )}
    </div>
  );
}
