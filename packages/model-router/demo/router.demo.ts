/**
 * Demo: route a handful of representative requests and print decisions.
 * Run: node packages/model-router/dist/demo/router.demo.js
 */
import { getAccountStatus, route, type RouteRequest } from '../src/index';

const requests: Array<[string, RouteRequest]> = [
  [
    'simple classification',
    {
      taskType: 'classification', complexity: 1, requiredTools: [],
      latencyPref: 'low', costPref: 'low', privacy: 'public',
      needsReasoning: false, contextNeeded: 'small', needsVision: false,
      currentUsage: { usedPct: 10 },
    },
  ],
  [
    'complex coding',
    {
      taskType: 'coding', complexity: 5, requiredTools: ['shell'],
      latencyPref: 'low', costPref: 'high', privacy: 'internal',
      needsReasoning: true, contextNeeded: 'large', needsVision: false,
      currentUsage: { usedPct: 35 },
    },
  ],
  [
    'sensitive local task',
    {
      taskType: 'review', complexity: 3, requiredTools: [],
      latencyPref: 'low', costPref: 'low', privacy: 'sensitive',
      needsReasoning: false, contextNeeded: 'medium', needsVision: false,
      currentUsage: { usedPct: 20 },
    },
  ],
  [
    'vision task',
    {
      taskType: 'vision', complexity: 3, requiredTools: [],
      latencyPref: 'low', costPref: 'high', privacy: 'public',
      needsReasoning: false, contextNeeded: 'medium', needsVision: true,
      currentUsage: { usedPct: 50 },
    },
  ],
  [
    'simple task but shared pool exhausted (§29)',
    {
      taskType: 'classification', complexity: 1, requiredTools: [],
      latencyPref: 'low', costPref: 'low', privacy: 'public',
      needsReasoning: false, contextNeeded: 'small', needsVision: false,
      currentUsage: { usedPct: 100 },
    },
  ],
];

for (const [label, req] of requests) {
  const d = route(req);
  console.log(`\n### ${label}`);
  if (d.unavailable || d.primary === null) {
    console.log(`unavailable: ${d.reason}`);
    continue;
  }
  console.log(`primary:   ${d.primary.model} (${d.primary.provider})`);
  console.log(`fallback:  ${d.fallback!.model}`);
  console.log(`emergency: ${d.emergency!.model}`);
  console.log(`reason:    ${d.reason}`);
}

console.log('\n### account status (stub, §29)');
console.log(JSON.stringify(getAccountStatus({ usedPct: 63 }), null, 2));
