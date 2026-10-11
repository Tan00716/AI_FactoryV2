// API smoke test — v2 round. Hits apps/server HTTP API.
// Expects: positive checks -> 2xx, negative checks -> 4xx with clear error.
const PORT = Number(process.env.SMOKE_PORT ?? 3210);
const BASE = `http://127.0.0.1:${PORT}`;

const CHECKS = [
  // [group, name, method, path, body, expect]
  ['health', 'positive', 'GET', '/api/health', null, '2xx'],
  ['tasks', 'positive', 'GET', '/api/tasks?projectId=proj-myapp', null, '2xx'],
  ['tasks', 'negative', 'POST', '/api/tasks/00000000-0000-0000-0000-000000000000/transition', { to: 'DONE' }, '4xx'],
  ['git', 'positive', 'GET', '/api/git/status?repo=/home/hatch/workspace/ai-factory', null, '2xx'],
  ['git', 'negative', 'GET', '/api/git/status', null, '4xx'],
  ['qa', 'positive', 'GET', '/api/qa/org', null, '2xx'],
  ['qa', 'negative', 'POST', '/api/qa/specialists', {}, '4xx'],
  ['approvals', 'positive', 'GET', '/api/approvals', null, '2xx'],
  ['approvals', 'negative', 'POST', '/api/approvals/evaluate', {}, '4xx'],
  ['cicd', 'positive', 'GET', '/api/environments', null, '2xx'],
  ['cicd', 'negative', 'GET', '/api/pipelines/does-not-exist', null, '4xx'],
  ['skills', 'positive', 'GET', '/api/skills', null, '2xx'],
  ['skills', 'negative', 'POST', '/api/skills/install', {}, '4xx'],
  ['memory', 'positive', 'GET', '/api/memory', null, '2xx'],
  ['memory', 'negative', 'POST', '/api/memory', {}, '4xx'],
  ['mcp', 'positive', 'GET', '/api/mcp', null, '2xx'],
  ['mcp', 'negative', 'POST', '/api/mcp/install', {}, '4xx'],
  ['knowledge', 'positive', 'GET', '/api/knowledge', null, '2xx'],
  ['knowledge', 'negative', 'POST', '/api/knowledge', {}, '4xx'],
  ['evaluation', 'positive', 'GET', '/api/evaluations', null, '2xx'],
  ['evaluation', 'negative', 'POST', '/api/evaluations', {}, '4xx'],
  ['models', 'positive', 'GET', '/api/models', null, '2xx'],
  ['models', 'negative', 'POST', '/api/router/route', {}, '4xx'],
  ['events', 'positive', 'GET', '/api/events', null, '2xx'],
  ['events', 'negative', 'POST', '/api/events/emit', {}, '4xx'],
  ['activity', 'positive', 'GET', '/api/activity', null, '2xx'],
  ['runs', 'positive', 'GET', '/api/runs', null, '2xx'],
  ['runs', 'negative', 'GET', '/api/runs/does-not-exist', null, '4xx'],
  ['stats', 'positive', 'GET', '/api/stats', null, '2xx'],
  ['projects', 'positive', 'GET', '/api/projects/templates', null, '2xx'],
  ['projects', 'negative', 'POST', '/api/projects/exec', {}, '4xx'],
  ['review', 'positive', 'GET', '/api/review/dimensions', null, '2xx'],
  ['review', 'negative', 'POST', '/api/review', {}, '4xx'],
  ['releases', 'positive', 'GET', '/api/releases', null, '2xx'],
  ['releases', 'negative', 'POST', '/api/releases', {}, '4xx'],
  ['policy', 'positive', 'GET', '/api/policy/layers', null, '2xx'],
  ['policy', 'negative', 'POST', '/api/policy/validate', {}, '4xx'],
  ['security', 'positive', 'POST', '/api/security/scan',
    { manifest: { name: 'test-skill', instructions: 'do benign things', scripts: ['run.sh'], declared: { network: false, fileAccess: 'workspace', shell: false } } }, '2xx'],
  ['security', 'negative', 'POST', '/api/security/scan', {}, '4xx'],
  ['recovery', 'positive', 'GET', '/api/recovery/snapshots', null, '2xx'],
  ['recovery', 'negative', 'POST', '/api/recovery/snapshots/nope/restore', {}, '4xx'],
  ['resources', 'positive', 'GET', '/api/resources/usage', null, '2xx'],
  ['resources', 'negative', 'POST', '/api/resources/consume', {}, '4xx'],
  ['autonomy', 'positive', 'GET', '/api/autonomy/mode', null, '2xx'],
  ['autonomy', 'negative', 'POST', '/api/autonomy/decide', {}, '4xx'],
  ['coordination', 'positive', 'POST', '/api/coordination/schedule', { tasks: ['t1'] }, '2xx'],
  ['coordination', 'negative', 'POST', '/api/coordination/locks', {}, '4xx'],
  ['disputes', 'positive', 'GET', '/api/disputes', null, '2xx'],
  ['disputes', 'negative', 'POST', '/api/disputes', {}, '4xx'],
  ['notifications', 'positive', 'GET', '/api/notifications', null, '2xx'],
  ['notifications', 'negative', 'POST', '/api/notifications/nope/read', null, '4xx'],
  // ---- v2 new route groups ----
  ['requirements', 'positive', 'POST', '/api/requirements',
    { title: 'smoke req', acceptanceCriteria: [{ id: 'ac1', text: 'works', expectedEvidence: 'log' }] }, '2xx'],
  ['requirements', 'negative', 'POST', '/api/requirements', {}, '4xx'],
  ['factory', 'positive', 'GET', '/api/factory/status', null, '2xx'],
  ['factory', 'negative', 'POST', '/api/factory/control', {}, '4xx'],
  ['incidents', 'positive', 'GET', '/api/incidents', null, '2xx'],
  ['incidents', 'negative', 'POST', '/api/incidents', {}, '4xx'],
  ['quota', 'positive', 'GET', '/api/quota/buckets', null, '2xx'],
  ['quota', 'negative', 'POST', '/api/quota', {}, '4xx'],
  ['watchdog', 'positive', 'POST', '/api/watchdog/workers', { worker_id: 'w-smoke' }, '2xx'],
  ['watchdog', 'negative', 'POST', '/api/watchdog/workers', {}, '4xx'],
  ['takeovers', 'positive', 'POST', '/api/takeovers', { runId: 'run-1', resourceId: 'res-1' }, '2xx'],
  ['takeovers', 'negative', 'POST', '/api/takeovers', {}, '4xx'],
  ['leases', 'positive', 'POST', '/api/leases/acquire', { resource_id: 'r-smoke2', owner_run_id: 'run1', ttlMs: 60000 }, '2xx'],
  ['leases', 'negative', 'POST', '/api/leases/acquire', {}, '4xx'],
  ['tools', 'positive', 'GET', '/api/tools', null, '2xx'],
  ['tools', 'negative', 'POST', '/api/tools', {}, '4xx'],
  ['isolation', 'positive', 'GET', '/api/isolation/backends', null, '2xx'],
  ['isolation', 'negative', 'POST', '/api/isolation/backends', {}, '4xx'],
  ['orchestrator', 'positive', 'POST', '/api/orchestrator/pattern', {}, '2xx'],
  ['orchestrator', 'negative', 'POST', '/api/orchestrator/decompose', {}, '4xx'],
  ['progress', 'positive', 'POST', '/api/progress/plans', { items: [{ id: 'a', weight: 100 }] }, '2xx'],
  ['progress', 'negative', 'POST', '/api/progress/compute', { planId: 'nope' }, '4xx'],
];

async function run() {
  const results = [];
  for (const [group, name, method, path, body, expect] of CHECKS) {
    const url = BASE + path;
    let status = 0, respBody = '';
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      status = res.status;
      respBody = (await res.text()).slice(0, 160);
    } catch (e) {
      respBody = 'CONN_FAIL:' + e.message;
    }
    const cls = status >= 200 && status < 300 ? '2xx' : status >= 400 && status < 500 ? '4xx' : String(status);
    const pass = cls === expect;
    results.push({ group, name, method, path, status, expect, pass, resp: respBody });
    const tag = pass ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${group.padEnd(13)} ${name.padEnd(9)} ${method.padEnd(5)} ${path.padEnd(52)} -> ${status} ${respBody.slice(0, 70)}`);
  }
  const passed = results.filter(r => r.pass).length;
  console.log(`\n==== ${passed}/${results.length} checks passed ====`);
  const fs = await import('fs');
  fs.writeFileSync(process.env.SMOKE_JSON ?? '/tmp/api-smoke-v2.json', JSON.stringify({ passed, total: results.length, results }, null, 1));
  process.exit(passed === results.length ? 0 : 1);
}
run();
