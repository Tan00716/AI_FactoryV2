/**
 * Policy engine demo — §43 override denial + §98/§99 YAML parsing.
 *
 *  1. Global layer locks `security.production_write: denied`.
 *  2. The project layer tries to loosen it to `allowed` → the attempt is
 *     DENIED and recorded as an overrideDenied event (never silent).
 *  3. Print the final effective policy for the project scope.
 *  4. Parse the §98/§99 example YAML (valid) and one invalid document.
 *
 * Run after building the package:
 *   npx tsc -p packages/policy/tsconfig.json
 *   node packages/policy/dist/demo/policy.demo.js
 */
import {
  GLOBAL_SCOPE_ID,
  OverrideAttempt,
  PolicyStore,
  parseOrganizationPolicy,
  parseProjectPolicy,
} from '../src/index';

const PROJECT_YAML = `project:
  name: MyApp

workflow:
  production_approval: human

security:
  production_write: denied

agents:
  max_concurrent: 8

deployment:
  auto_uat: true
  auto_prod: false

testing:
  require_unit: true
  require_e2e: true
  require_security: true
`;

const ORG_YAML = `organization:
  agent_creation:
    enabled: true
    max_depth: 3
    max_children: 5

permissions:
  production:
    default: denied

skills:
  auto_publish: false

mcp:
  unknown_servers: denied
`;

function showAttempt(a: OverrideAttempt): void {
  console.log(`  key      : ${a.key}`);
  console.log(`  attempted: ${a.attempted.layer}@${a.attempted.scopeId} → ${JSON.stringify(a.attempted.value)}`);
  console.log(`  winner   : ${a.winner.layer}@${a.winner.scopeId} → ${JSON.stringify(a.winner.value)} (locked=${a.winnerLocked})`);
  console.log(`  allowed  : ${a.allowed}`);
}

function main(): void {
  const store = new PolicyStore();
  store.on('overrideDenied', (e) => console.log(`\n[EVENT] overrideDenied → ${e.attempt.key}`));

  // 1. Global forbids production writes (locked by default).
  store.set('global', GLOBAL_SCOPE_ID, { 'security.production_write': 'denied' });
  console.log('global: security.production_write = denied (locked)');

  // 2. Project tries to loosen it — this must be denied, never silent.
  store.set('project', 'MyApp', { 'security.production_write': 'allowed' });
  console.log('project MyApp: attempts security.production_write = allowed');

  const { policy, denials } = store.resolveEffectivePolicy({ layer: 'project', project: 'MyApp' });

  console.log(`\ndenials: ${denials.length}`);
  for (const d of denials) showAttempt(d);

  console.log('\neffective policy for project/MyApp:');
  console.log(JSON.stringify(policy, null, 2));

  // 4a. Valid §98 / §99 documents.
  const proj = parseProjectPolicy(PROJECT_YAML);
  const org = parseOrganizationPolicy(ORG_YAML);
  console.log(`\nproject.yaml  → ok=${proj.ok}, errors=${proj.errors.length}`);
  console.log(`organization.yaml → ok=${org.ok}, errors=${org.errors.length}`);

  // 4b. Invalid document → structured errors.
  const bad = parseProjectPolicy(
    PROJECT_YAML.replace('production_approval: human', 'production_approval: nobody').replace(
      'max_concurrent: 8',
      'max_concurrent: 500',
    ),
  );
  console.log(`\ninvalid project.yaml → ok=${bad.ok}`);
  for (const e of bad.errors) console.log(`  [${e.code}] ${e.path}: ${e.message}`);
}

main();
