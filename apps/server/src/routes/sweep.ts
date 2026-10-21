/**
 * sweep.yaml routes — repository-level Issue → task automation convention.
 *
 *   GET  /api/sweep/config?projectId=…   parsed rules + validation state (viewer)
 *   POST /api/sweep/dry-run              { projectId, event } → matches, no side effects (viewer)
 *   POST /api/sweep/ingest               { projectId, event, actor? } → proposes a task (operator)
 *
 * Ingest NEVER starts a run: the created task is filed with
 * authorizationStatus 'WAITING_HUMAN_DISPATCH' (creator 'sweep') and lands
 * in the existing Dispatch panel for human confirm/reject. Event content
 * is declared external — params pass through sanitizeUntrusted in
 * sweep.ts's choke point; the task title is directive-stripped.
 *
 * RBAC: central gate (auth.ts requiredRoleFor) — GET → viewer,
 * POST → operator. No per-route role logic here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  loadSweepConfig,
  validateSweepEvent,
  matchSweepRules,
  buildLaunch,
  SweepError,
  type SweepConfigLoad,
  type SweepEvent,
  type SweepRule,
} from '../sweep';
import { renderPrompt, type TaskTemplate } from '../task-template-store';
import { resolveProjectDir } from './egress';
import type { RouteContext } from './context';

const PREFIX = '/api/sweep';

function projectDirOf(
  ctx: RouteContext,
  res: ServerResponse,
  projectId: unknown,
): string | null {
  if (typeof projectId !== 'string' || !projectId.trim()) {
    ctx.json(res, 400, { error: 'projectId is required', code: 'SWEEP_NO_PROJECT' });
    return null;
  }
  const rd = resolveProjectDir(ctx, projectId.trim());
  if (!rd.ok) {
    ctx.json(res, rd.status, { error: rd.error, code: rd.code });
    return null;
  }
  return rd.dir;
}

function configSummary(load: SweepConfigLoad): Record<string, unknown> {
  return {
    path: load.path,
    exists: load.exists,
    ...(load.loadError ? { loadError: load.loadError } : {}),
    ruleCount: load.config.rules.length,
    rules: load.config.rules.map((r) => ({
      id: r.id,
      ...(r.name ? { name: r.name } : {}),
      enabled: r.enabled,
      priority: r.priority,
      template: r.then.template,
      when: {
        ...(r.when.source ? { source: r.when.source } : {}),
        ...(r.when.labels ? { labels: r.when.labels } : {}),
        ...(r.when.labelsAll ? { labelsAll: r.when.labelsAll } : {}),
        ...(r.when.titleRegex ? { titleRegex: r.when.titleRegex } : {}),
        ...(r.when.bodyRegex ? { bodyRegex: r.when.bodyRegex } : {}),
      },
    })),
    invalidRules: load.invalidRules,
  };
}

function parseEvent(body: Record<string, unknown>): SweepEvent {
  return validateSweepEvent(body['event']);
}

function resolveTemplate(
  ctx: RouteContext,
  ref: string,
): TaskTemplate | undefined {
  if (ref.startsWith('name:')) {
    const name = ref.slice('name:'.length).trim();
    return ctx.taskTemplateStore.list().find((t) => t.name === name);
  }
  return ctx.taskTemplateStore.get(ref);
}

interface IngestAttempt {
  matched: Array<{ ruleId: string; templateId: string; title: string; taskId: string }>;
  skipped: Array<{ ruleId: string; reason: string }>;
}

/**
 * Evaluate rules against the event and, for ingest, file the task for the
 * first rule that fills completely. Pure routing logic shared by dry-run
 * and ingest; task creation happens only when `create` is true.
 */
function evaluate(
  ctx: RouteContext,
  projectId: string,
  event: SweepEvent,
  load: SweepConfigLoad,
  create: boolean,
  actor: string,
): IngestAttempt {
  const attempt: IngestAttempt = { matched: [], skipped: [] };
  const matches = matchSweepRules(load.config, event);
  for (const { rule } of matches) {
    const template = resolveTemplate(ctx, rule.then.template);
    if (!template) {
      attempt.skipped.push({ ruleId: rule.id, reason: `template not found: ${rule.then.template}` });
      continue;
    }
    const { params, title } = buildLaunch(rule, event, template.name);
    const { prompt, missing } = renderPrompt(template, params);
    if (missing.length > 0) {
      attempt.skipped.push({
        ruleId: rule.id,
        reason: `missing template variables: ${missing.join(', ')}`,
      });
      continue;
    }
    if (!create) {
      attempt.matched.push({ ruleId: rule.id, templateId: template.id, title, taskId: '' });
      continue;
    }
    let task;
    try {
      task = ctx.tasks.create({
        projectId,
        title,
        goal: prompt,
        description:
          `由 sweep 规则「${rule.name ?? rule.id}」从外部事件发起（source=${event.source}）。` +
          (event.url ? `事件链接：${event.url}。` : '') +
          `任务处于待人工派发确认状态，确认前不会执行。\n` +
          `Proposed by sweep rule "${rule.name ?? rule.id}" from an external event ` +
          `(source=${event.source})${event.url ? ` <${event.url}>` : ''}; ` +
          `awaiting human dispatch, never auto-executed.`,
        priority: rule.then.priority ?? template.defaultPriority ?? 'P2',
        creator: 'sweep',
        authorizationStatus: 'WAITING_HUMAN_DISPATCH',
      });
    } catch (e) {
      attempt.skipped.push({
        ruleId: rule.id,
        reason: `task creation failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      continue;
    }
    ctx.audit.record(actor, 'SWEEP_TASK_PROPOSED', 'sweep', rule.id, {
      taskId: task.id,
      templateId: template.id,
      projectId,
      source: event.source,
    });
    attempt.matched.push({ ruleId: rule.id, templateId: template.id, title, taskId: task.id });
    break; // first-match-wins
  }
  return attempt;
}

export async function handleSweepRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: RouteContext,
): Promise<boolean> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(PREFIX + '/')) return false;

  // GET /api/sweep/config?projectId=…
  if (method === 'GET' && path === `${PREFIX}/config`) {
    const dir = projectDirOf(ctx, res, url.searchParams.get('projectId'));
    if (dir === null) return true;
    const load = loadSweepConfig(dir);
    return ctx.json(res, 200, configSummary(load)), true;
  }

  if (method === 'POST' && (path === `${PREFIX}/dry-run` || path === `${PREFIX}/ingest`)) {
    const body = (await ctx.readBody(req).catch(() => ({}))) as Record<string, unknown>;
    const dir = projectDirOf(ctx, res, body['projectId']);
    if (dir === null) return true;
    let event: SweepEvent;
    try {
      event = parseEvent(body);
    } catch (e) {
      if (e instanceof SweepError) {
        return ctx.json(res, 400, { error: e.message, code: 'SWEEP_BAD_EVENT' }), true;
      }
      throw e;
    }
    const load = loadSweepConfig(dir);
    if (load.loadError) {
      return ctx.json(res, 409, {
        error: load.loadError,
        code: 'SWEEP_CONFIG_INVALID',
        path: load.path,
      }), true;
    }
    const actor =
      typeof body['actor'] === 'string' && body['actor'].trim() ? body['actor'].trim() : 'human';
    const attempt = evaluate(
      ctx,
      (body['projectId'] as string).trim(),
      event,
      load,
      path === `${PREFIX}/ingest`,
      actor,
    );
    if (path === `${PREFIX}/dry-run`) {
      return ctx.json(res, 200, {
        proposed: false,
        matches: attempt.matched,
        skipped: attempt.skipped,
        invalidRules: load.invalidRules,
      }), true;
    }
    const first = attempt.matched[0];
    if (!first) {
      return ctx.json(res, 200, {
        proposed: false,
        skipped: attempt.skipped,
        invalidRules: load.invalidRules,
      }), true;
    }
    const task = ctx.tasks.list().find((t) => t.id === first.taskId);
    return ctx.json(res, 200, {
      proposed: true,
      task,
      ruleId: first.ruleId,
      templateId: first.templateId,
      skipped: attempt.skipped,
    }), true;
  }

  return false;
}
