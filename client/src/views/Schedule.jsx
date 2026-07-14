import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import QuickAdd from '../components/QuickAdd.jsx';
import TaskList from '../components/TaskList.jsx';

const BUCKETS = [
  ['overdue', 'Overdue'],
  ['today', 'Do today'],
  ['tomorrow', 'Do tomorrow'],
  ['this_week', 'This week'],
  ['next_week', 'Next week'],
  ['later', 'Later'],
  ['unscheduled', 'No date'],
];

// Rolling day/week view keyed on Do dates (when should I work on this?).
export default function Schedule({ refreshKey, refresh, onSelectTask, onError }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/views/schedule').then(setData).catch(onError);
  }, [refreshKey]);

  if (!data) return <div className="empty">Loading…</div>;

  return (
    <div className="view">
      <header className="view-header">
        <div>
          <h2>Upcoming</h2>
          <div className="subtitle">Grouped by Do date — when the work should happen</div>
        </div>
      </header>
      <QuickAdd onCreated={refresh} onError={onError} />
      {BUCKETS.map(([key, label]) => {
        const tasks = data.buckets[key];
        if (!tasks?.length) return null;
        return (
          <section key={key} className={`bucket ${key}`}>
            <h3>{label} <span className="count">{tasks.length}</span></h3>
            <TaskList tasks={tasks} onSelect={onSelectTask} onChanged={refresh} onError={onError} />
          </section>
        );
      })}
      {BUCKETS.every(([k]) => !data.buckets[k]?.length) && (
        <div className="empty">No open tasks. Add one above.</div>
      )}
    </div>
  );
}
