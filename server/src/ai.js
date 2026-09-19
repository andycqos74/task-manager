import Anthropic from '@anthropic-ai/sdk';
import { fallbackPlanDay, fallbackPrioritise } from './scoring.js';
import { getSettings } from './data/settings.js';

// AI-assisted planning and prioritisation via the Claude API.
// If no API key is configured (or a call fails), the rule-based fallback in
// scoring.js is used instead, so the app works either way.
//
// The key can come from Settings (stored in the database, entered in the UI)
// or from the ANTHROPIC_API_KEY environment variable. A key saved in
// Settings takes precedence, so it can be added/changed without restarting
// the container.
//
// Settings are per-user, so each account uses its own key. The environment
// variable remains an instance-wide fallback — on a shared deployment that
// means everyone spends the operator's key, so set AI_ENV_KEY_SHARED=0 to
// restrict it to accounts that have supplied their own.

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-8';

export function effectiveApiKey(scope) {
  const stored = getSettings(scope).anthropic_api_key;
  if (stored && stored.trim()) return stored.trim();
  if (process.env.AI_ENV_KEY_SHARED === '0') return null;
  return process.env.ANTHROPIC_API_KEY || null;
}

export function aiAvailable(scope) {
  return !!effectiveApiKey(scope);
}

function client(scope) {
  return new Anthropic({ apiKey: effectiveApiKey(scope) });
}

// Compact representation of tasks for the prompt — only decision-relevant fields.
function tasksForPrompt(tasks) {
  return tasks.map((t) => ({
    id: t.id,
    title: t.title,
    project: t.project_name || null,
    status: t.status,
    priority: t.priority,
    due_date: t.due_date,
    do_date: t.do_date,
    estimated_minutes: t.estimated_minutes,
    tags: t.tags,
    in_my_day: !!t.in_my_day,
    blocked: !!t.blocked,
    notes: t.notes ? t.notes.slice(0, 200) : undefined,
  }));
}

async function structuredCall(scope, system, userText, schema) {
  const response = await client(scope).messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: 'adaptive' },
    system,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: userText }],
  });
  if (response.stop_reason === 'refusal') {
    throw new Error('Model declined the request');
  }
  const text = response.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Empty model response');
  return JSON.parse(text);
}

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences explaining the overall plan for today.' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task_id: { type: 'integer' },
          reason: { type: 'string', description: 'Short reason this task should be done today.' },
        },
        required: ['task_id', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'suggestions'],
  additionalProperties: false,
};

const PRIORITISE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task_id: { type: 'integer' },
          rank: { type: 'integer' },
          reason: { type: 'string' },
        },
        required: ['task_id', 'rank', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'ranking'],
  additionalProperties: false,
};

// Keep only suggestions that reference real task ids the model was given.
function validIds(items, tasks) {
  const known = new Set(tasks.map((t) => t.id));
  return items.filter((s) => known.has(s.task_id));
}

// User-supplied guidance from Settings, appended to the system prompt so it
// can steer both planning and prioritisation (e.g. preferences, focus areas).
function customInstructions(scope) {
  const prompt = (getSettings(scope).ai_prompt || '').trim();
  return prompt ? `\n\nAdditional instructions from the user, which take priority over the general guidance above: ${prompt}` : '';
}

export async function planMyDay(scope, tasks, today, workdayMinutes) {
  if (!aiAvailable(scope)) return fallbackPlanDay(tasks, today, workdayMinutes);
  try {
    const result = await structuredCall(
      scope,
      'You are a pragmatic personal task planner. You pick which tasks a person should work on today. ' +
        'Weigh due dates (never let things slip), do/start dates, priority, dependencies (never suggest blocked tasks), ' +
        'and total estimated time versus the length of the working day. Prefer finishing started work and quick overdue items. ' +
        'Suggest a realistic set — not everything.' + customInstructions(scope),
      `Today is ${today}. The working day is ${workdayMinutes} minutes.\n` +
        `Pick the tasks I should do today, in the order I should do them, with a short reason for each.\n\n` +
        `Tasks:\n${JSON.stringify(tasksForPrompt(tasks), null, 2)}`,
      PLAN_SCHEMA,
    );
    return { source: 'ai', summary: result.summary, suggestions: validIds(result.suggestions, tasks) };
  } catch (err) {
    console.error('AI plan-day failed, falling back to rules:', err.message);
    const fb = fallbackPlanDay(tasks, today, workdayMinutes);
    fb.summary = `AI unavailable (${err.message}). ` + fb.summary;
    return fb;
  }
}

export async function prioritise(scope, tasks, today) {
  if (!aiAvailable(scope)) return fallbackPrioritise(tasks, today);
  try {
    const result = await structuredCall(
      scope,
      'You are a pragmatic personal task planner. Rank ALL of the given tasks from most to least important to act on, ' +
        'weighing due dates, do/start dates, priority levels, dependencies (blocked tasks rank last) and estimated effort. ' +
        'Give a short reason for each ranking.' + customInstructions(scope),
      `Today is ${today}. Rank these tasks:\n${JSON.stringify(tasksForPrompt(tasks), null, 2)}`,
      PRIORITISE_SCHEMA,
    );
    return { source: 'ai', summary: result.summary, ranking: validIds(result.ranking, tasks) };
  } catch (err) {
    console.error('AI prioritise failed, falling back to rules:', err.message);
    const fb = fallbackPrioritise(tasks, today);
    fb.summary = `AI unavailable (${err.message}). ` + fb.summary;
    return fb;
  }
}
