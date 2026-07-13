import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

// Always-visible scratch notepad (memonotepad-style): a plain textarea that
// auto-saves as you type. Notes can be standalone or attached to a single task
// or project, and any line/selection can be turned into a task.
export default function Notepad({ projects, context, refresh, onError }) {
  const [collapsed, setCollapsed] = useState(false);
  const [note, setNote] = useState(null); // the note currently being edited
  const [options, setOptions] = useState([]); // notes shown in the selector
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');
  const dirtyRef = useRef(false);
  const textareaRef = useRef(null);

  // Load the always-there scratch note once on mount.
  useEffect(() => {
    api.get('/notes/scratch').then((n) => { setNote(n); dirtyRef.current = false; }).catch(onError);
  }, []);

  // The selector shows: the scratch note, all standalone notes, and any notes
  // attached to whatever task/project is currently in context.
  async function reloadOptions() {
    try {
      const scratch = await api.get('/notes/scratch');
      const standalone = await api.get('/notes?standalone=1');
      let ctx = [];
      if (context?.taskId) ctx = await api.get(`/notes?task_id=${context.taskId}`);
      else if (context?.projectId) ctx = await api.get(`/notes?project_id=${context.projectId}`);
      const byId = new Map();
      for (const n of [scratch, ...standalone, ...ctx]) byId.set(n.id, n);
      setOptions([...byId.values()]);
    } catch (err) {
      onError(err);
    }
  }
  useEffect(() => { reloadOptions(); }, [context?.taskId, context?.projectId]);

  // Debounced auto-save. Fires only after a real edit (dirtyRef), not on load.
  useEffect(() => {
    if (!note || !dirtyRef.current) return;
    const { id, title, body } = note;
    setSaving(true);
    const timer = setTimeout(async () => {
      try { await api.patch(`/notes/${id}`, { title, body }); reloadOptions(); }
      catch (err) { onError(err); }
      finally { setSaving(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [note?.title, note?.body]);

  // Persist any pending edit immediately (before switching notes / attaching).
  async function flush() {
    if (note && dirtyRef.current) {
      try { await api.patch(`/notes/${note.id}`, { title: note.title, body: note.body }); }
      catch { /* surfaced on next real save */ }
      dirtyRef.current = false;
    }
  }

  async function switchTo(id) {
    await flush();
    try { const n = await api.get(`/notes/${id}`); setNote(n); dirtyRef.current = false; }
    catch (err) { onError(err); }
  }

  function edit(patch) {
    setNote((n) => ({ ...n, ...patch }));
    dirtyRef.current = true;
  }

  async function newNote() {
    await flush();
    try {
      const n = await api.post('/notes', { title: '', body: '' });
      setNote(n); dirtyRef.current = false; reloadOptions();
    } catch (err) {
      onError(err);
    }
  }

  async function deleteNote() {
    if (!note || note.is_scratch) return;
    if (!confirm('Delete this note?')) return;
    try {
      await api.delete(`/notes/${note.id}`);
      const scratch = await api.get('/notes/scratch');
      setNote(scratch); dirtyRef.current = false; reloadOptions();
    } catch (err) {
      onError(err);
    }
  }

  async function setAttachment(value) {
    if (!note) return;
    await flush();
    const patch = { task_id: null, project_id: null };
    if (value.startsWith('project:')) patch.project_id = Number(value.slice(8));
    else if (value.startsWith('task:')) patch.task_id = Number(value.slice(5));
    try {
      const n = await api.patch(`/notes/${note.id}`, patch);
      setNote(n); dirtyRef.current = false; reloadOptions();
    } catch (err) {
      onError(err);
    }
  }

  // Turn the current line (or the current selection) into a task. The first
  // non-empty line becomes the title; any remaining lines become task notes.
  async function lineToTask() {
    const ta = textareaRef.current;
    if (!ta || !note) return;
    const value = note.body || '';
    let chosen;
    if (ta.selectionStart !== ta.selectionEnd) {
      chosen = value.slice(ta.selectionStart, ta.selectionEnd);
    } else {
      const start = value.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      let end = value.indexOf('\n', ta.selectionStart);
      if (end === -1) end = value.length;
      chosen = value.slice(start, end);
    }
    const lines = chosen.split('\n').map((l) => l.trim()).filter(Boolean);
    if (!lines.length) {
      setFlash('Put the cursor on a line, or select text, first.');
      setTimeout(() => setFlash(''), 4000);
      return;
    }
    try {
      const task = await api.post('/tasks', {
        title: lines[0],
        notes: lines.slice(1).join('\n'),
        project_id: note.project_id || context?.projectId || null,
      });
      refresh?.();
      setFlash(`Created task: “${task.title}”`);
      setTimeout(() => setFlash(''), 4000);
    } catch (err) {
      onError(err);
    }
  }

  const attachValue = note?.task_id
    ? `task:${note.task_id}`
    : note?.project_id
      ? `project:${note.project_id}`
      : 'standalone';

  return (
    <div className={`notepad-dock ${collapsed ? 'collapsed' : ''}`}>
      <div className="notepad-bar">
        <button className="notepad-toggle" onClick={() => setCollapsed((c) => !c)}>
          🗒 Notepad {collapsed ? '▲' : '▼'}
        </button>
        {!collapsed && note && (
          <>
            <select value={note.id} onChange={(e) => switchTo(Number(e.target.value))} title="Choose note">
              {options.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.is_scratch ? '★ Scratch' : n.title || 'Untitled'}
                  {n.task_title ? ` · task: ${n.task_title}` : n.project_name ? ` · ${n.project_name}` : ''}
                </option>
              ))}
              {!options.some((n) => n.id === note.id) && (
                <option value={note.id}>{note.title || 'Untitled'}</option>
              )}
            </select>
            <button className="small" onClick={newNote}>＋ New</button>
            {!note.is_scratch && (
              <input
                className="notepad-title"
                value={note.title}
                placeholder="Untitled note"
                onChange={(e) => edit({ title: e.target.value })}
              />
            )}
            <select value={attachValue} onChange={(e) => setAttachment(e.target.value)} title="Attach this note">
              <option value="standalone">Standalone</option>
              {context?.taskId && <option value={`task:${context.taskId}`}>Attach to open task</option>}
              {note.task_id && note.task_id !== context?.taskId && (
                <option value={`task:${note.task_id}`}>Task: {note.task_title}</option>
              )}
              <optgroup label="Attach to project">
                {projects.map((p) => (
                  <option key={p.id} value={`project:${p.id}`}>{p.name}</option>
                ))}
              </optgroup>
            </select>
            <button className="small" onClick={lineToTask} title="Turn the current line or selection into a task">
              → Task
            </button>
            {!note.is_scratch && <button className="link" onClick={deleteNote}>delete</button>}
            <span className="notepad-status">{saving ? 'saving…' : flash || 'saved'}</span>
          </>
        )}
      </div>
      {!collapsed && note && (
        <textarea
          ref={textareaRef}
          className="notepad-body"
          value={note.body}
          placeholder="Jot anything here — it saves automatically. Put the cursor on a line (or select text) and click “→ Task”."
          onChange={(e) => edit({ body: e.target.value })}
        />
      )}
    </div>
  );
}
