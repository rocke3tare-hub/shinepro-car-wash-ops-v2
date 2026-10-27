import { AppError } from '../lib/errors.js';

export const JOB_STATUSES = ['waiting', 'assigned', 'in_progress', 'paused', 'ready_for_quality', 'rework_required', 'ready_for_payment', 'completed', 'cancelled', 'refunded'];

export const STATUS_LABELS = {
  waiting: 'Waiting',
  assigned: 'Assigned',
  in_progress: 'In progress',
  paused: 'Paused',
  ready_for_quality: 'Quality check',
  rework_required: 'Rework required',
  ready_for_payment: 'Ready for payment',
  completed: 'Completed',
  cancelled: 'Cancelled',
  refunded: 'Refunded'
};

/**
 * The workflow. Each action names its source states, target state and the
 * permission it needs. Payment and refund are deliberately absent: they are
 * financial events that move the job as a side effect of their own services.
 */
export const JOB_ACTIONS = {
  start: { from: ['assigned', 'rework_required', 'paused'], to: 'in_progress', permission: 'jobs.work', label: 'Start work' },
  pause: { from: ['in_progress'], to: 'paused', permission: 'jobs.work', label: 'Pause' },
  submit_for_quality: { from: ['in_progress'], to: 'ready_for_quality', permission: 'jobs.work', label: 'Tasks complete' },
  approve_quality: { from: ['ready_for_quality'], to: 'ready_for_payment', permission: 'jobs.quality', label: 'Approve quality' },
  request_rework: { from: ['ready_for_quality'], to: 'rework_required', permission: 'jobs.quality', label: 'Request rework' },
  cancel: { from: ['waiting', 'assigned', 'in_progress', 'paused', 'rework_required'], to: 'cancelled', permission: 'jobs.cancel', label: 'Cancel job' }
};

/** States in which commercial fields (assignments, bay, notes) may still change. */
export const EDITABLE_STATES = ['waiting', 'assigned', 'in_progress', 'paused', 'rework_required', 'ready_for_quality'];

export function nextStatus(job, action) {
  const rule = JOB_ACTIONS[action];
  if (!rule) throw new AppError('UNKNOWN_ACTION', `Unknown job action: ${action}.`, 422);
  if (!rule.from.includes(job.status)) {
    throw new AppError('INVALID_STATUS_TRANSITION', `"${rule.label}" is not allowed while the job is ${STATUS_LABELS[job.status] || job.status}.`, 422);
  }
  return rule.to;
}

/**
 * Business guards beyond the transition table. Returns a reason string when
 * the action is blocked, or null when it may proceed.
 */
export function guard(job, action, { assignments = [], actorWorkerId = null, checklistComplete = true } = {}) {
  const active = assignments.filter(a => a.status !== 'removed');
  if (action === 'start' && active.length === 0) return 'Assign at least one worker before starting.';
  if (action === 'approve_quality') {
    if (actorWorkerId && active.some(a => a.worker_id === actorWorkerId)) return 'A worker who took part in this job cannot approve its quality.';
    if (!checklistComplete) return 'Every checklist item must pass before approval.';
  }
  if (action === 'cancel' && job.payment_status !== 'unpaid') return 'A paid job cannot be cancelled; request a refund instead.';
  return null;
}

/** Which assignment status follows a job transition. */
export const ASSIGNMENT_STATUS_ON = {
  start: { from: ['assigned', 'completed'], to: 'started' },
  submit_for_quality: { from: ['started'], to: 'completed' },
  approve_quality: { from: ['completed'], to: 'approved' },
  request_rework: { from: ['completed', 'approved'], to: 'completed' }
};

/** Actions a given actor can see as available for this job (UI hint; server re-checks). */
export function availableActions(job, actor, context = {}) {
  const permissions = new Set(actor.permissions);
  const result = [];
  for (const [action, rule] of Object.entries(JOB_ACTIONS)) {
    if (!rule.from.includes(job.status) || !permissions.has(rule.permission)) continue;
    const blocked = guard(job, action, context);
    result.push({ action, label: rule.label, blocked });
  }
  return result;
}
