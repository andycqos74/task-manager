import React, { useState } from 'react';
import { api } from '../api.js';

// Quick capture: type a title, press Enter, done. Details can be added later
// by opening the task. `defaults` lets each view pre-fill context
// (project_id, my_day, due_date...).
export default function QuickAdd({ defaults = {}, onCreated, onError, placeholder }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      const task = await api.post('/tasks', { title: trimmed, ...defaults });
      setTitle('');
      onCreated?.(task);
    } catch (err) {
      onError?.(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="quick-add" onSubmit={submit}>
      <span className="quick-add-plus">＋</span>
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder || 'Add a task — press Enter'}
        disabled={busy}
      />
    </form>
  );
}
