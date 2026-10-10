/**
 * Demo: MCP Registry lifecycle — GitHub MCP.
 *
 *  1. register the GitHub MCP server
 *  2. attempt install while its source is unknown → BLOCKED (§73)
 *  3. trust assessment + HUMAN_APPROVAL → approved → install succeeds
 *  4. a tool-call gate check (allowed, then denied after disabling)
 *
 * Run: node dist/demo/mcp.demo.js   (after tsc -p tsconfig.json)
 */
import { McpManager, McpRegistry, ToolCallGate } from '../src/index';

function main(): void {
  const registry = new McpRegistry();
  const manager = new McpManager(registry);
  const gate = new ToolCallGate({ registry, manager });

  // 1. Register the GitHub MCP server (spec §46 example list).
  registry.register({
    name: 'github-mcp',
    version: '1.2.0',
    provider: 'GitHub',
    transport: 'http',
    tools: [
      { name: 'create_issue', description: 'Open a GitHub issue', requiresPermissions: ['issues:write'] },
      { name: 'list_repos', description: 'List repositories' },
    ],
    resources: [{ uri: 'repos://{owner}/{repo}' }],
    scopes: ['repo'],
    permissions: ['issues:write'],
    networkRequirements: 'egress: api.github.com:443',
  });
  console.log('registered: github-mcp@1.2.0 (trust UNKNOWN, policy BLOCKED)');

  // 2. Install attempt with unknown source → BLOCKED.
  const first = manager.requestInstall('github-mcp', '1.2.0');
  console.log(`install attempt 1 → ok=${first.ok} status=${first.status}`);
  console.log(`  reason: ${first.reason}`);

  // 3. Trust assessment, then install via HUMAN_APPROVAL.
  manager.assessTrust('github-mcp', '1.2.0', {
    trustLevel: 'HIGH',
    approvalPolicy: 'HUMAN_APPROVAL',
    assessedBy: 'security-review',
    notes: 'official GitHub MCP distribution, pinned checksum',
  });
  const pending = manager.requestInstall('github-mcp', '1.2.0');
  console.log(`install attempt 2 → ok=${pending.ok} status=${pending.status}`);
  const decided = manager.decideReview('github-mcp', '1.2.0', { approved: true, reviewer: 'ops-lead' });
  console.log(`human approval → ok=${decided.ok} status=${decided.status}`);

  // 4. Tool-call gate: allowed call…
  const allowed = gate.checkCall({ server: 'github-mcp', tool: 'create_issue', agentId: 'agent-1', taskId: 'task-7' });
  console.log(`tool call create_issue → allowed=${allowed.allowed} reason=${allowed.reason} version=${allowed.usedVersion}`);
  console.log(`usage log: ${JSON.stringify(manager.usageLog('github-mcp').map((u) => `${u.tool}@${u.version}`))}`);

  // …then denied after disabling the server for that agent.
  manager.setEnabled('github-mcp', '1.2.0', false, { kind: 'agent', id: 'agent-1' });
  const denied = gate.checkCall({ server: 'github-mcp', tool: 'create_issue', agentId: 'agent-1' });
  console.log(`tool call create_issue (agent disabled) → allowed=${denied.allowed} reason=${denied.reason}`);
}

main();
