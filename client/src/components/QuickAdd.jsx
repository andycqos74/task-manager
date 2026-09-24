import React, { useState } from 'react';
import { api } from '../api.js';
import { queueTask } from '../pwa.js';

// Quick capture: type a title, press Enter, done. Details can be added later
// by opening the task. `defaults` lets each view pre-fill context
// (project_id, my_day, due_date...).
export default function QuickAdd({ defaults = {}, onCreated, onError, placeholder }) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);

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
      // No connection: keep it on this device and send it on reconnect
      // (App flushes the queue), rather than losing what was typed.
      if (err.offline && queueTask({ title: trimmed, ...defaults })) {
        setTitle('');
        setQueued(true);
        setTimeout(() => setQueued(false), 4000);
      } else {
        onError?.(err);
      }
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
      {queued && <span className="quick-add-queued">Saved offline — it'll be added when you reconnect</span>}
    </form>
  );
}
