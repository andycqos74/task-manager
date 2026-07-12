import { diffDays } from './dates.js';

// Rule-based prioritisation. Used to order task lists everywhere, and as the
// fallback for the AI endpoints when no ANTHROPIC_API_KEY is configured.
// Returns { score, reasons, blocked } for a task; higher score = do sooner.
export function scoreTask(task, today) {
  let score = 0;
  const reasons = [];

  if (task.blocked) {
    reasons.push('blocked by an incomplete dependency');
  }

  if (task.due_date) {
    const days = diffDays(today, task.due_date);
    if (days < 0) {
      score += 100 + Math.min(-days * 2, 40);
      reasons.push(`overdue by ${-days} day${days === -1 ? '' : 's'}`);
    } else if (days === 0) {
      score += 80;
      reasons.push('due today');
    } else if (days === 1) {
      score += 50;
      reasons.push('due tomorrow');
    } else if (days <= 3) {
      score += 30;
      reasons.push(`due in ${days} days`);
    } else if (days <= 7) {
      score += 15;
      reasons.push(`due in ${days} days`);
    }
  }

  if (task.do_date) {
    const days = diffDays(today, task.do_date);
    if (days <= 0) {
      score += 40;
      reasons.push(days === 0 ? 'scheduled to start today' : 'start date has passed');
    }
  }

  const priorityWeight = { urgent: 40, high: 25, medium: 10, low: 0 };
  score += priorityWeight[task.priority] ?? 0;
  if (task.priority === 'urgent' || task.priority === 'high') {
    reasons.push(`${task.priority} priority`);
  }

  if (task.my_day_date === today) {
    score += 20;
    reasons.push('flagged for My Day');
  }

  if (task.status === 'in_progress') {
    score += 15;
    reasons.push('already in progress');
  }

  // Blocked tasks sink to the bottom regardless of other signals.
  if (task.blocked) score -= 1000;

  return { score, reasons, blocked: !!task.blocked };
}

export function rankTasks(tasks, today) {
  return tasks
    .map((t) => ({ task: t, ...scoreTask(t, today) }))
    .sort((a, b) => b.score - a.score);
}

// Fallback "plan my day": pick unblocked, actionable tasks whose combined
// estimate fits the workday, in score order.
export function fallbackPlanDay(tasks, today, workdayMinutes) {
  const ranked = rankTasks(tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled'), today);
  const suggestions = [];
  let usedMinutes = 0;
  for (const { task, score, reasons, blocked } of ranked) {
    if (blocked || score <= 0) continue;
    const est = task.estimated_minutes || 0;
    if (suggestions.length >= 3 && est > 0 && usedMinutes + est > workdayMinutes) continue;
    usedMinutes += est;
    suggestions.push({ task_id: task.id, reason: reasons.join('; ') || 'next highest priority' });
    if (suggestions.length >= 8) break;
  }
  return {
    source: 'rules',
    summary: 'Suggested by built-in rules (deadlines, start dates, priority and workload). Set ANTHROPIC_API_KEY to enable AI planning.',
    suggestions,
  };
}

export function fallbackPrioritise(tasks, today) {
  const ranked = rankTasks(tasks, today);
  return {
    source: 'rules',
    summary: 'Ordered by built-in rules (deadlines, start dates, priority). Set ANTHROPIC_API_KEY to enable AI prioritisation.',
    ranking: ranked.map(({ task, reasons }, i) => ({
      task_id: task.id,
      rank: i + 1,
      reason: reasons.join('; ') || 'no urgency signals',
    })),
  };
}
