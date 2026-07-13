import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const RULE = 28; // px between ruled lines; also the block text line-height
const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 240;
const EXPAND_FRACTION = 0.65; // "expand" preset as a fraction of viewport height

function maxHeight() {
  return Math.max(300, window.innerHeight - 220);
}

function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) || `b${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function autosize(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.max(RULE, el.scrollHeight)}px`;
}

// A single free-floating text block on the page. Auto-sizes to its content and
// can be dragged around by its handle.
function NoteBlock({ block, onChange, onMove, onRemove, onActive, autofocus }) {
  const ref = useRef(null);
  const everTyped = useRef(false);
  useEffect(() => { autosize(ref.current); }, [block.text]);
  // Focus a freshly-created block synchronously (before the browser paints /
  // control returns from the click) so it's ready to type into immediately and
  // the click that made it doesn't blur an empty box.
  useLayoutEffect(() => {
    if (autofocus && ref.current) { ref.current.focus(); onActive(ref.current); }
  }, []);
  if (block.text.trim()) everTyped.current = true;

  function startDrag(e) {
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const ox = block.x;
    const oy = block.y;
    const move = (ev) => onMove(Math.max(0, ox + ev.clientX - startX), Math.max(0, oy + ev.clientY - startY));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  return (
    <div className="note-block" style={{ left: block.x, top: block.y }}>
      <span className="note-block-handle" onPointerDown={startDrag} title="Drag to move">⠿</span>
      <button className="note-block-x" onMouseDown={(e) => e.preventDefault()} onClick={onRemove} title="Delete note">✕</button>
      <textarea
        ref={ref}
        data-block-id={block.id}
        className="note-block-text"
        value={block.text}
        rows={1}
        placeholder="note…"
        onFocus={() => onActive(ref.current)}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => { if (!block.text.trim() && everTyped.current) onRemove(); }}
      />
    </div>
  );
}

// Always-visible notepad. A ruled "page" you can click anywhere on to start a
// separate note (OneNote / paper-notepad style), auto-saving as you type.
// A note can be standalone or attached to a task/project, and any line or
// selection can be turned into a task.
export default function Notepad({ projects, context, refresh, onError }) {
  const [collapsed, setCollapsed] = useState(false);
  const [pageHeight, setPageHeight] = useState(() => {
    const saved = Number(localStorage.getItem('notepad-height'));
    return saved >= MIN_HEIGHT ? saved : DEFAULT_HEIGHT;
  });
  const [note, setNote] = useState(null);
  const [options, setOptions] = useState([]);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState('');
  const [newBlockId, setNewBlockId] = useState(null); // block to auto-focus on create
  const dirtyRef = useRef(false);
  const activeRef = useRef(null);   // textarea of the focused block (for → Task)
  const pageRef = useRef(null);

  useEffect(() => {
    api.get('/notes/scratch').then((n) => { setNote(n); dirtyRef.current = false; }).catch(onError);
  }, []);

  useEffect(() => {
    localStorage.setItem('notepad-height', String(pageHeight));
  }, [pageHeight]);

  // Drag the handle above the page to resize it vertically.
  function startResize(e) {
    e.preventDefault();
    const startY = e.clientY;
    const startHeight = pageHeight;
    const max = maxHeight();
    const move = (ev) => {
      const next = startHeight + (startY - ev.clientY); // drag up = taller
      setPageHeight(Math.min(max, Math.max(MIN_HEIGHT, next)));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Quick "big/small" alternative to dragging.
  function toggleSize() {
    const max = maxHeight();
    setPageHeight((h) => (h < max * 0.6 ? max : DEFAULT_HEIGHT));
  }

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

  // Debounced auto-save, keyed on a signature of the editable content.
  const sig = note ? JSON.stringify({ t: note.title, b: note.blocks }) : '';
  useEffect(() => {
    if (!note || !dirtyRef.current) return;
    const { id, title, blocks } = note;
    setSaving(true);
    const timer = setTimeout(async () => {
      try { await api.patch(`/notes/${id}`, { title, blocks }); reloadOptions(); }
      catch (err) { onError(err); }
      finally { setSaving(false); }
    }, 600);
    return () => clearTimeout(timer);
  }, [sig]);

  async function flush() {
    if (note && dirtyRef.current) {
      try { await api.patch(`/notes/${note.id}`, { title: note.title, blocks: note.blocks }); }
      catch { /* surfaced on next save */ }
      dirtyRef.current = false;
    }
  }

  async function switchTo(id) {
    await flush();
    try { const n = await api.get(`/notes/${id}`); setNote(n); dirtyRef.current = false; activeRef.current = null; }
    catch (err) { onError(err); }
  }

  function mutateBlocks(fn) {
    setNote((n) => ({ ...n, blocks: fn(n.blocks) }));
    dirtyRef.current = true;
  }

  // Click on empty page space -> start a new note block there.
  function onPageMouseDown(e) {
    if (e.target !== pageRef.current) return; // ignore clicks on existing blocks
    // Stop the browser moving focus to the non-focusable page, which would
    // otherwise blur the block we're about to create and focus.
    e.preventDefault();
    const rect = pageRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left + pageRef.current.scrollLeft;
    const y = Math.round((e.clientY - rect.top + pageRef.current.scrollTop) / RULE) * RULE; // snap to a line
    const id = uid();
    setNewBlockId(id);
    mutateBlocks((blocks) => [...blocks, { id, x: Math.round(x), y: Math.max(0, y), text: '' }]);
  }

  const editBlock = (id, text) => mutateBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, text } : b)));
  const moveBlock = (id, x, y) => mutateBlocks((bs) => bs.map((b) => (b.id === id ? { ...b, x, y } : b)));
  const removeBlock = (id) => mutateBlocks((bs) => bs.filter((b) => b.id !== id));

  async function newNote() {
    await flush();
    try {
      const n = await api.post('/notes', { title: '', blocks: [] });
      setNote(n); dirtyRef.current = false; activeRef.current = null; reloadOptions();
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
      setNote(scratch); dirtyRef.current = false; activeRef.current = null; reloadOptions();
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

  function flashMsg(msg) {
    setFlash(msg);
    setTimeout(() => setFlash(''), 4000);
  }

  // Turn the focused block's current line (or its selection) into a task.
  async function lineToTask() {
    const ta = activeRef.current;
    if (!ta || !ta.isConnected) { flashMsg('Click into a note first, then “→ Task”.'); return; }
    const value = ta.value || '';
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
    if (!lines.length) { flashMsg('Put the cursor on a line, or select text, first.'); return; }
    try {
      const task = await api.post('/tasks', {
        title: lines[0],
        notes: lines.slice(1).join('\n'),
        project_id: note.project_id || context?.projectId || null,
      });
      refresh?.();
      flashMsg(`Created task: “${task.title}”`);
    } catch (err) {
      onError(err);
    }
  }

  const attachValue = note?.task_id
    ? `task:${note.task_id}`
    : note?.project_id
      ? `project:${note.project_id}`
      : 'standalone';

  const isExpanded = pageHeight >= maxHeight() * 0.6;

  return (
    <div className={`notepad-dock ${collapsed ? 'collapsed' : ''}`}>
      {!collapsed && (
        <div className="notepad-resize-handle" onPointerDown={startResize} title="Drag to resize">
          <span className="notepad-resize-grip" />
        </div>
      )}
      <div className="notepad-bar">
        <button className="notepad-toggle" onClick={() => setCollapsed((c) => !c)}>
          🗒 Notepad {collapsed ? '▲' : '▼'}
        </button>
        {!collapsed && note && (
          <>
            <button className="small" onClick={toggleSize} title="Expand or shrink the notepad">
              {isExpanded ? '⤡ Shrink' : '⤢ Expand'}
            </button>
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
                onChange={(e) => { setNote((n) => ({ ...n, title: e.target.value })); dirtyRef.current = true; }}
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
        <div className="notepad-page" ref={pageRef} onMouseDown={onPageMouseDown} style={{ height: pageHeight }}>
          {note.blocks.length === 0 && (
            <div className="notepad-hint">Click anywhere on the page to start a note.</div>
          )}
          {note.blocks.map((block) => (
            <NoteBlock
              key={block.id}
              block={block}
              onChange={(text) => editBlock(block.id, text)}
              onMove={(x, y) => moveBlock(block.id, x, y)}
              onRemove={() => removeBlock(block.id)}
              onActive={(el) => { activeRef.current = el; }}
              autofocus={block.id === newBlockId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
