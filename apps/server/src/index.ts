/**
 * Local backend for the AI Engineering Factory prototype.
 * Plain node:http JSON API (no framework) over the SQLite database.
 * The React UI (and later the Electron main process) talks to this.
 *
 *   GET  /api/health
 *   GET  /api/projects            POST /api/projects {name, description?, path?}
 *   GET  /api/tasks?projectId=    POST /api/tasks {projectId, title, goal?, ...}
 *   GET  /api/tasks/:id
 *   POST /api/tasks/:id/transition   {to, actor?}
 *   POST /api/tasks/:id/evidence     {type, title, payload?, createdBy?}
 *   POST /api/tasks/:id/subtasks     {title, ...}
 *   POST /api/tasks/:id/dependencies {kind, taskId}
 *   GET  /api/agents              POST /api/agents {...}
 *   GET  /api/org
 *   GET  /api/board?projectId=
 *   GET  /api/evidence?taskId=
 *   GET  /api/audit?limit=
 */
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  AgentRegistry,
  AuditLog,
  EvidenceEngine,
  Task,
  TaskManager,
  TaskStatus,
  WorkflowEngine,
  allowedNextStates,
  nowIso,
} from '@ai-factory/core';
import { FactoryDatabase, seedIfEmpty } from '@ai-factory/db';
import { NotificationEngine } from '@ai-factory/notifications';
import type { RouteContext } from './routes/context';
import { handleGitRoutes } from './routes/git';
import { handleQaRoutes } from './routes/qa';
import { handleApprovalRoutes } from './routes/approvals';
import { handleCicdRoutes } from './routes/cicd';
import { handleSkillsRoutes } from './routes/skills';
import { handleMemoryRoutes } from './routes/memory';
import { handleModelRouterRoutes } from './routes/model-router';
import { handleRuntimeRoutes } from './routes/runtime';
import { handleOrchestratorRoutes } from './routes/orchestrator';
import { handleWorkforceRoutes } from './routes/workforce';
import { handleMcpRoutes } from './routes/mcp';
import { handleKnowledgeRoutes } from './routes/knowledge';
import { handleEvaluationRoutes } from './routes/evaluation';
import { handleProjectsRoutes } from './routes/projects';
import { handleProjectIoRoutes } from './routes/project-io';
import { handleReviewRoutes } from './routes/review';
import { handleReleaseRoutes } from './routes/releases';
import { handlePolicyRoutes } from './routes/policy';
import { handleExecRoutes } from './routes/exec';
import { handleFileRoutes } from './routes/files';
import { handleChangesRoutes } from './routes/changes';
import { handleSecurityRoutes } from './routes/security';
import { handleRecoveryRoutes } from './routes/recovery';
import { handleResourceRoutes } from './routes/resources';
import { handleAutonomyRoutes } from './routes/autonomy';
import { handleCoordinationRoutes } from './routes/coordination';
import { handleRequirementRoutes } from './routes/requirements';
import { handleProgressRoutes } from './routes/progress';
import { handleIsolationRoutes } from './routes/isolation';
import { handleToolRoutes } from './routes/tools';
import { handleLeaseRoutes } from './routes/leases';
import { handleFactoryControlRoutes } from './routes/factory-control';
import { handleIncidentsRoutes } from './routes/incidents';
import { handleQuotaRoutes } from './routes/quota';
import { handleWatchdogRoutes } from './routes/watchdog';
import { handleTakeoverRoutes } from './routes/takeover';
import { handleDisputeRoutes } from './routes/disputes';
import { handleReportRoutes } from './routes/reports';
import { handleDashboardRoutes } from './routes/dashboard';
import { handleNotificationRoutes } from './routes/notifications';
import { handleEventRoutes } from './routes/events';
import { handleActivityRoutes } from './routes/activity';
import { EventBus } from '@ai-factory/events';

const PORT = Number(process.env.PORT ?? 3100);
// SPEC §7.4 — the control-plane API binds loopback by default. Override
// only for an explicitly planned deployment (AI_FACTORY_HOST).
const HOST = process.env.AI_FACTORY_HOST ?? '127.0.0.1';
const DB_PATH = process.env.DB_PATH ?? './data/factory.db';

function ensureDir(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

ensureDir(DB_PATH);
const fdb = new FactoryDatabase(DB_PATH);

const tasks = new TaskManager(fdb.tasks);
const evidence = new EvidenceEngine(fdb.evidence);
const audit = new AuditLog(fdb.audit);
const agents = new AgentRegistry(fdb.agents);
const engine = new WorkflowEngine({ tasks, evidence, audit });
const notify = new NotificationEngine();
/** System Event Bus — spec §91; shared by all route modules via RouteContext. */
const bus = new EventBus({ retention: 2000 });

seedIfEmpty(fdb);

// ---------------------------------------------------------------- helpers -
function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(data),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>);
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function taskView(id: string) {
  const t = tasks.get(id);
  return {
    ...t,
    evidence: evidence.listByTask(id),
    nextStates: allowedNextStates(t.status).map((d) => ({
      to: d.to,
      note: d.note,
      requires: d.requires.map((r) => r.label),
    })),
  };
}

// ---------------------------------------------------------------- routes --
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    // Health
    if (method === 'GET' && path === '/api/health') {
      return json(res, 200, { ok: true, ts: nowIso() });
    }

    // Modular routes: git (§34), qa (§36–§38), approvals (§45, §69),
    // cicd (§39–§41, §77), skills (§47–§49, §74), memory (§54–§58),
    // model-router (§28–§30), runtime (§24–§27), orchestrator (§92–§95, §21),
    // workforce (§14, §18–§20, §59), mcp (§46, §73), knowledge (§50–§53),
    // evaluation (§57–§58).
    // Each handler returns true when it owned the path.
    const routeCtx: RouteContext = {
      tasks, evidence, audit, agents, engine, fdb, notify, bus, json, readBody,
    };
    if (await handleGitRoutes(req, res, url, routeCtx)) return;
    if (await handleQaRoutes(req, res, url, routeCtx)) return;
    if (await handleApprovalRoutes(req, res, url, routeCtx)) return;
    if (await handleCicdRoutes(req, res, url, routeCtx)) return;
    if (await handleSkillsRoutes(req, res, url, routeCtx)) return;
    if (await handleMemoryRoutes(req, res, url, routeCtx)) return;
    if (await handleModelRouterRoutes(req, res, url, routeCtx)) return;
    if (await handleRuntimeRoutes(req, res, url, routeCtx)) return;
    if (await handleOrchestratorRoutes(req, res, url, routeCtx)) return;
    if (await handleWorkforceRoutes(req, res, url, routeCtx)) return;
    if (await handleMcpRoutes(req, res, url, routeCtx)) return;
    if (await handleKnowledgeRoutes(req, res, url, routeCtx)) return;
    if (await handleEvaluationRoutes(req, res, url, routeCtx)) return;
    if (await handleProjectsRoutes(req, res, url, routeCtx)) return;
    if (await handleProjectIoRoutes(req, res, url, routeCtx)) return;
    if (await handleReviewRoutes(req, res, url, routeCtx)) return;
    if (await handleReleaseRoutes(req, res, url, routeCtx)) return;
    if (await handlePolicyRoutes(req, res, url, routeCtx)) return;
    if (await handleExecRoutes(req, res, url, routeCtx)) return;
    if (await handleFileRoutes(req, res, url, routeCtx)) return;
    if (await handleChangesRoutes(req, res, url, routeCtx)) return;
    if (await handleSecurityRoutes(req, res, url, routeCtx)) return;
    if (await handleRecoveryRoutes(req, res, url, routeCtx)) return;
    if (await handleResourceRoutes(req, res, url, routeCtx)) return;
    if (await handleAutonomyRoutes(req, res, url, routeCtx)) return;
    if (await handleCoordinationRoutes(req, res, url, routeCtx)) return;
    if (await handleRequirementRoutes(req, res, url, routeCtx)) return;
    if (await handleProgressRoutes(req, res, url, routeCtx)) return;
    if (await handleIsolationRoutes(req, res, url, routeCtx)) return;
    if (await handleToolRoutes(req, res, url, routeCtx)) return;
    if (await handleLeaseRoutes(req, res, url, routeCtx)) return;
    if (await handleFactoryControlRoutes(req, res, url, routeCtx)) return;
    if (await handleIncidentsRoutes(req, res, url, routeCtx)) return;
    if (await handleQuotaRoutes(req, res, url, routeCtx)) return;
    if (await handleWatchdogRoutes(req, res, url, routeCtx)) return;
    if (await handleTakeoverRoutes(req, res, url, routeCtx)) return;
    if (await handleDisputeRoutes(req, res, url, routeCtx)) return;
    if (await handleReportRoutes(req, res, url, routeCtx)) return;
    if (await handleDashboardRoutes(req, res, url, routeCtx)) return;
    if (await handleNotificationRoutes(req, res, url, routeCtx)) return;
    if (await handleEventRoutes(req, res, url, routeCtx)) return;
    if (await handleActivityRoutes(req, res, url, routeCtx)) return;

    // Projects
    if (path === '/api/projects' && method === 'GET') {
      return json(res, 200, fdb.listProjects());
    }
    if (path === '/api/projects' && method === 'POST') {
      const b = await readBody(req);
      if (!b['name']) return json(res, 400, { error: 'name is required' });
      const p = fdb.createProject({
        id: randomUUID(),
        name: String(b['name']),
        description: String(b['description'] ?? ''),
        path: String(b['path'] ?? ''),
      });
      audit.record('human', 'PROJECT_CREATED', 'project', p.id, { name: p.name });
      return json(res, 201, p);
    }

    // Task board (§85 simplified): tasks grouped by status column.
    if (path === '/api/board' && method === 'GET') {
      const projectId = url.searchParams.get('projectId') ?? 'proj-myapp';
      const all = tasks.listByProject(projectId);
      const columns: Record<string, unknown[]> = {};
      for (const t of all) {
        const list = columns[t.status] ?? (columns[t.status] = []);
        const agent = t.currentAgentId ? agents.get(t.currentAgentId) : null;
        list.push({
          id: t.id, title: t.title, priority: t.priority,
          status: t.status, risk: t.risk,
          agent: agent ? agent.displayName : null,
          agentCount: t.assignedAgentIds.length,
          updatedAt: t.updatedAt,
        });
      }
      return json(res, 200, { projectId, columns });
    }

    // Tasks
    if (path === '/api/tasks' && method === 'GET') {
      const projectId = url.searchParams.get('projectId');
      const all = projectId ? tasks.listByProject(projectId) : tasks.list();
      return json(res, 200, all);
    }
    if (path === '/api/tasks' && method === 'POST') {
      const b = await readBody(req);
      if (!b['projectId'] || !b['title']) {
        return json(res, 400, { error: 'projectId and title are required' });
      }
      const t = tasks.create({
        projectId: String(b['projectId']),
        title: String(b['title']),
        goal: String(b['goal'] ?? ''),
        description: String(b['description'] ?? ''),
        priority: (b['priority'] as Task['priority'] | undefined) ?? 'P2',
        acceptanceCriteria: Array.isArray(b['acceptanceCriteria']) ? (b['acceptanceCriteria'] as string[]) : [],
        constraints: Array.isArray(b['constraints']) ? (b['constraints'] as string[]) : [],
        creator: 'human',
      });
      audit.record('human', 'TASK_CREATED', 'task', t.id, { title: t.title });
      bus.emit('TASK_CREATED', { taskId: t.id, title: t.title, projectId: t.projectId }, 'tasks');
      return json(res, 201, taskView(t.id));
    }

    const taskMatch = path.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
    if (taskMatch) {
      const id = decodeURIComponent(taskMatch[1]);
      const suffix = taskMatch[2] ?? '';
      if (method === 'GET' && suffix === '') {
        return json(res, 200, taskView(id));
      }
      if (method === 'POST' && suffix === '/transition') {
        const b = await readBody(req);
        const to = b['to'] as TaskStatus;
        const actor = String(b['actor'] ?? 'human');
        if (!to) return json(res, 400, { error: 'to (target state) is required' });
        try {
          const r = engine.requestTransition(id, to, actor);
          if (!r.ok) return json(res, 422, r);
          // Notification trigger (module 30): a task entering BLOCKED pings
          // the human with a HIGH-priority in-app notification.
          if (to === 'BLOCKED') {
            const t = tasks.get(id);
            notify.emit({
              type: 'TASK_BLOCKED',
              actor,
              entity: { kind: 'task', id, label: t.title },
              detail: { from: r.from ?? undefined },
            });
          }
          // §91 — task lifecycle events on the system bus.
          bus.emit(
            'WORKFLOW_TRANSITIONED',
            { taskId: id, from: r.from ?? undefined, to, actor },
            'workflow',
          );
          if (to === 'DONE') {
            bus.emit('TASK_COMPLETED', { taskId: id, actor }, 'workflow');
          }
          return json(res, 200, { ...r, task: taskView(id) });
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (method === 'POST' && suffix === '/evidence') {
        const b = await readBody(req);
        if (!b['type'] || !b['title']) {
          return json(res, 400, { error: 'type and title are required' });
        }
        try {
          const ev = evidence.create({
            taskId: id,
            type: b['type'] as 'plan',
            title: String(b['title']),
            payload: (b['payload'] as Record<string, unknown>) ?? {},
            createdBy: String(b['createdBy'] ?? 'human'),
          });
          audit.record(String(b['createdBy'] ?? 'human'), 'EVIDENCE_ATTACHED', 'evidence', ev.id, {
            taskId: id, type: ev.type,
          });
          return json(res, 201, ev);
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (method === 'POST' && suffix === '/subtasks') {
        const b = await readBody(req);
        if (!b['title']) return json(res, 400, { error: 'title is required' });
        try {
          const sub = tasks.createSubtask(id, {
            title: String(b['title']),
            goal: String(b['goal'] ?? ''),
            priority: (b['priority'] as 'P0' | 'P1' | 'P2' | 'P3' | 'P4') ?? 'P2',
          });
          audit.record('human', 'TASK_CREATED', 'task', sub.id, { title: sub.title, parent: id });
          return json(res, 201, sub);
        } catch (e) {
          return json(res, 404, { error: (e as Error).message });
        }
      }
      if (method === 'POST' && suffix === '/dependencies') {
        const b = await readBody(req);
        try {
          const t = tasks.addDependency(
            id,
            b['kind'] as 'depends_on',
            String(b['taskId']),
          );
          return json(res, 200, t);
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }
    }

    // Agents
    if (path === '/api/agents' && method === 'GET') {
      return json(res, 200, agents.list());
    }
    if (path === '/api/agents' && method === 'POST') {
      const b = await readBody(req);
      try {
        const a = agents.register({
          name: String(b['name'] ?? ''),
          displayName: b['displayName'] ? String(b['displayName']) : undefined,
          jobTitle: String(b['jobTitle'] ?? ''),
          department: b['department'] ? String(b['department']) : undefined,
          parentAgentId: b['parentAgentId'] ? String(b['parentAgentId']) : null,
          mission: b['mission'] ? String(b['mission']) : undefined,
          autonomyLevel: b['autonomyLevel'] as 0 | 1 | 2 | 3 | 4 | 5 | undefined,
          permissions: Array.isArray(b['permissions']) ? (b['permissions'] as never[]) : undefined,
          skills: Array.isArray(b['skills']) ? (b['skills'] as string[]) : undefined,
        });
        audit.record('human', 'AGENT_CREATED', 'agent', a.id, { name: a.name, jobTitle: a.jobTitle });
        bus.emit('AGENT_CREATED', { agentId: a.id, name: a.name, jobTitle: a.jobTitle }, 'workforce');
        return json(res, 201, a);
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
    }
    if (path === '/api/org' && method === 'GET') {
      return json(res, 200, agents.orgTree());
    }

    // Evidence + audit
    if (path === '/api/evidence' && method === 'GET') {
      const taskId = url.searchParams.get('taskId');
      if (!taskId) return json(res, 400, { error: 'taskId is required' });
      return json(res, 200, evidence.listByTask(taskId));
    }
    if (path === '/api/audit' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return json(res, 200, audit.list().slice(-limit).reverse());
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[ai-factory] API listening on http://${HOST}:${PORT} (db: ${DB_PATH})`);
});
