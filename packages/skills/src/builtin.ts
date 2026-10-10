/**
 * Built-in skills — spec §47 example tree (coding, testing, architecture,
 * security…). These OFFICIAL skills ship with the IDE and can be installed
 * into any SkillRegistry with installBuiltinSkills(). Their instructions are
 * the SKILL.md text the agent loads when the skill is selected (§48).
 */
import { InstallRequest, InstallResult, InstallSkillDef } from './types';
import type { SkillRegistry } from './registry';

type BaseDef = Omit<Partial<InstallSkillDef>, 'content'> & {
  id: string;
  content: { instructions: string; references: string[]; scripts: string[]; assets: string[] };
};

function base(def: BaseDef): InstallSkillDef {
  const { content, ...rest } = def;
  return {
    version: '1.0.0',
    description: '',
    compatibility: 'agent-skills >= 1.0',
    author: 'AI Factory',
    source: 'builtin',
    trustLevel: 'OFFICIAL',
    evaluationScore: 0.9,
    content,
    declared: { network: false, fileAccess: 'NONE', shell: false },
    keywords: [],
    ...rest,
  };
}

/** §47 coding/clean-code — write code a stranger can maintain. */
export const CLEAN_CODE: InstallSkillDef = base({
  id: 'clean-code',
  description: 'Write readable, maintainable code: naming, structure, small functions, no cleverness.',
  evaluationScore: 0.95,
  keywords: ['clean-code', 'readability', 'maintainability', 'naming', 'refactor', 'style', 'code-quality'],
  content: {
    instructions: `# Clean Code

Use this skill whenever you write or modify production code. Its goal is code a stranger can understand and change safely six months from now.

Choose names that say what the thing is and what it does — \`retryWithBackoff\` beats \`doStuff2\`. Keep functions small and single-purpose: if you cannot describe what a function does in one sentence without "and", split it. Prefer flat, early-return control flow over deep nesting, and make the happy path obvious at a glance. Avoid clever tricks, magic numbers, and boolean parameters that make call sites unreadable (\`process(true)\` tells the reader nothing).

Structure code so the important decisions are explicit. Push side effects to the edges, keep pure logic testable in isolation, and never let error handling be an afterthought — every failure mode should produce a useful error message, not a silent undefined. When you modify existing code, leave it cleaner than you found it, but keep the diff focused: drive-by refactors of unrelated code make reviews harder and blame histories useless.`,
    references: ['naming-guide.md', 'function-size-rubric.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 coding/debugging — reproduce, isolate, hypothesize, verify. */
export const DEBUGGING: InstallSkillDef = base({
  id: 'debugging',
  description: 'Systematic bug diagnosis: reproduce reliably, isolate the cause, form and test hypotheses.',
  evaluationScore: 0.94,
  keywords: ['debugging', 'bug', 'reproduce', 'isolate', 'root-cause', 'stacktrace', 'hypothesis', 'diagnose'],
  declared: { network: false, fileAccess: 'READ', shell: false },
  content: {
    instructions: `# Debugging

Use this skill when something behaves incorrectly. Do not guess and do not change code until you can reproduce the problem reliably.

First, reproduce: build the smallest reliable reproduction case — a failing test, a minimal script, or exact reproduction steps. If you cannot reproduce it, you cannot verify the fix; say so instead of patching blindly. Second, isolate: narrow the search space with binary search. Disable half the suspects, add logging or breakpoints at boundaries, and follow the data — print actual values at each step rather than assuming them. Read the stack trace carefully: the top frame is where it broke, but the cause is usually a few frames up where bad input entered.

Third, form one hypothesis at a time and test it with a single decisive experiment. When the experiment disproves the hypothesis, discard it and move on — sunk cost applies to debugging too. Common traps: assuming the bug is where the error surfaces, trusting caches and stale builds, and "fixing" a symptom while the root cause survives. Finally, turn the reproduction into a regression test before you close the bug, and verify the fix against it.`,
    references: ['repro-template.md', 'common-traps.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 coding/git — branch, commit, and review conventions. */
export const GIT: InstallSkillDef = base({
  id: 'git',
  description: 'Git workflows: branch strategy, atomic commits, clear messages, safe history handling.',
  evaluationScore: 0.92,
  keywords: ['git', 'branch', 'commit', 'merge', 'rebase', 'pull-request', 'history', 'version-control'],
  content: {
    instructions: `# Git

Use this skill for branching, committing, and sharing changes. Work on short-lived feature branches cut from the current main line, and keep branches focused on one change — a branch that does three things should have been three branches.

Make commits atomic: one logical change per commit, each commit building and passing tests on its own. Write messages with a short imperative summary line (\`Add retry to payment client\`) followed by a body explaining *why* the change exists when the reason is not obvious from the diff. Never commit secrets, credentials, or generated build artifacts; if you do, treat the secret as compromised and rotate it — deleting the commit does not undo the exposure.

Prefer rebasing private branches onto main for a clean, reviewable history, but never rewrite history that others have pulled — use merge in that case. Before pushing, run the full check suite locally; a red CI on a branch you own is your problem to fix first. For pull requests, keep the description focused on intent and risk, and request review from the person most familiar with the touched area.`,
    references: ['commit-message-format.md', 'branch-strategy.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 testing/unit-testing — fast, isolated, deterministic unit tests. */
export const UNIT_TESTING: InstallSkillDef = base({
  id: 'unit-testing',
  description: 'Write fast deterministic unit tests: arrange-act-assert, meaningful assertions, edge cases.',
  evaluationScore: 0.96,
  keywords: ['unit-testing', 'unit-test', 'test', 'testing', 'tdd', 'assertion', 'mock', 'edge-case'],
  content: {
    instructions: `# Unit Testing

Use this skill when writing tests for individual functions, classes, or modules. Unit tests must be fast (milliseconds), isolated (no network, no real filesystem, no clock dependence), and deterministic — a test that passes sometimes is worse than no test.

Structure every test as arrange-act-assert: set up the inputs, perform the single action under test, then assert the outcome. Assert behavior, not implementation: test the return value and the observable effects, not private method call counts, unless the call itself is the contract. Name tests as specifications — \`returns empty array when no matches found\` — so a failing test name tells you exactly what broke. Cover the edges: empty inputs, null/undefined, boundary numbers, and the error paths, not just the happy path; bugs live at boundaries.

Keep tests independent and order-free; shared mutable fixtures are a flakiness factory. Use fakes and stubs for collaborators, but prefer real implementations of pure helpers — over-mocking tests the mock, not the code. When fixing a bug, write the failing test first, watch it fail for the right reason, then fix the code. A test suite you cannot trust is technical debt that charges interest on every change.`,
    references: ['aaa-pattern.md', 'test-naming-guide.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 coding/refactoring — improve structure without changing behavior. */
export const REFACTORING: InstallSkillDef = base({
  id: 'refactoring',
  description: 'Safe restructuring: extract functions, eliminate duplication, keep behavior identical.',
  evaluationScore: 0.93,
  keywords: ['refactoring', 'restructure', 'extract', 'duplication', 'code-smell', 'simplify', 'design'],
  declared: { network: false, fileAccess: 'READ', shell: false },
  content: {
    instructions: `# Refactoring

Use this skill when restructuring code without changing its observable behavior. Refactoring is a means to an end — the end being code that is easier to understand and change — not an end in itself.

Work in small, behavior-preserving steps, and run the test suite after each step so a regression points at exactly one change. Fix one code smell at a time: extract a function when a block has its own coherent purpose, replace conditionals with polymorphism when the same switch appears in three places, and delete duplication at its root instead of patching each copy. If there are no tests, write characterization tests first that pin down current behavior — refactoring untested code is gambling.

Do not mix refactoring with feature changes in the same commit; reviewers cannot verify behavior preservation when behavior also changes. Resist the urge to rewrite from scratch — incremental improvement compounds, while rewrites reset all the hard-won knowledge encoded in the existing code. Stop when the code is clear enough for the next change; perfect is the enemy of shipped.`,
    references: ['code-smells.md', 'refactoring-catalog.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 testing/e2e-testing — end-to-end tests of full user journeys. */
export const E2E_TESTING: InstallSkillDef = base({
  id: 'e2e-testing',
  description: 'End-to-end testing: full user journeys, stable selectors, flaky-test triage, test environments.',
  evaluationScore: 0.91,
  keywords: ['e2e', 'e2e-testing', 'end-to-end', 'flaky', 'playwright', 'cypress', 'selector', 'user-journey', 'integration'],
  content: {
    instructions: `# E2E Testing

Use this skill when testing complete user journeys through the real application stack. E2E tests verify that the pieces work together — they are slow and expensive, so reserve them for critical paths: sign-up, checkout, core workflows. Everything else belongs in unit or integration tests.

Make tests stable by design: select elements by role, label, or test id — never by CSS class or DOM position, which change with every redesign. Never use fixed sleeps; wait on conditions (element visible, network idle, URL changed) with sensible timeouts. Each test must set up its own data and clean up after itself; shared state between tests is the number one source of flakiness. Run the suite in a hermetic environment — seeded database, stubbed third-party services — because a test that depends on the real world will fail on the real world's schedule.

Treat flaky tests as bugs, not noise: quarantine them, reproduce with repetition runs, and fix the root cause (usually timing or shared state) before re-enabling. A flaky suite teaches the team to ignore failures, and an ignored failure is where the real outage hides. Keep the suite fast enough to run on every pull request; if it cannot, you have too many E2E tests.`,
    references: ['selector-strategy.md', 'flaky-triage-runbook.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 security/security-review — review code for security vulnerabilities. */
export const SECURITY_REVIEW: InstallSkillDef = base({
  id: 'security-review',
  description: 'Security review: injection, auth flaws, secret handling, dependency risk, least privilege.',
  evaluationScore: 0.93,
  keywords: ['security', 'security-review', 'vulnerability', 'injection', 'xss', 'auth', 'secret', 'owasp', 'audit'],
  declared: { network: false, fileAccess: 'READ', shell: false },
  content: {
    instructions: `# Security Review

Use this skill when reviewing code, dependencies, or designs for security weaknesses. Think like an attacker: where does untrusted input enter, where does it go, and what trust boundaries does it cross.

Check the classics first. Injection: is user input ever concatenated into SQL, shell commands, or HTML without parameterization or escaping? Authentication and authorization: are checks performed server-side on every request, not just hidden in the UI? Secrets: are API keys, tokens, and passwords kept out of code, logs, and client bundles, loaded from a secret store instead? Data exposure: does any endpoint return more than the caller is entitled to see, and are errors generic to outsiders while detailed in logs?

Then check the supply chain and configuration: are dependencies pinned and audited for known CVEs, is the principle of least privilege applied to service accounts and file permissions, and are security headers and transport encryption (TLS) enforced rather than assumed? When you find an issue, report severity, exploitability, and a concrete fix — "this is insecure" without a remediation path is just anxiety. Distinguish must-fix vulnerabilities from hardening suggestions so teams can prioritize honestly.`,
    references: ['owasp-top10-checklist.md', 'secret-handling.md'],
    scripts: [],
    assets: [],
  },
});

/** §47 coding/code-review — thorough, kind, actionable code reviews. */
export const CODE_REVIEW: InstallSkillDef = base({
  id: 'code-review',
  description: 'Code review practice: correctness, design, readability; kind and actionable feedback.',
  evaluationScore: 0.94,
  keywords: ['code-review', 'review', 'pull-request', 'feedback', 'correctness', 'readability'],
  content: {
    instructions: `# Code Review

Use this skill when reviewing someone else's code. Your job is to make the change better and the author stronger — not to prove you are the smartest person in the diff.

Review in layers. First correctness: does it do what the description claims, are the edge cases and error paths handled, could any input break an invariant? Second design: does it fit the existing architecture, introduce the right abstractions, avoid duplicating something that already exists? Third readability: would a new teammate understand this without asking the author? Only then style — and if a style rule is automatable, let the linter enforce it instead of spending human attention.

Write feedback that is specific, kind, and actionable: quote the line, explain the concern, and suggest the fix or ask the question that leads to it. Distinguish blocking issues ("this leaks the connection on error") from suggestions ("consider extracting this") so the author knows what must change. Approve promptly when the change is good enough; perfection is not the bar, and a review that sits for three days costs more than the nit it was waiting on.`,
    references: ['review-checklist.md', 'feedback-phrasing.md'],
    scripts: [],
    assets: [],
  },
});

/** All built-in skills, in registry-tree order (§47). */
export const BUILTIN_SKILLS: InstallSkillDef[] = [
  CLEAN_CODE,
  DEBUGGING,
  GIT,
  UNIT_TESTING,
  REFACTORING,
  E2E_TESTING,
  SECURITY_REVIEW,
  CODE_REVIEW,
];

/** Install every built-in skill into a registry. Returns one InstallResult per skill. */
export function installBuiltinSkills(registry: SkillRegistry): InstallResult[] {
  return BUILTIN_SKILLS.map((skill) => {
    const req: InstallRequest = { skill, requestedBy: 'system:builtin' };
    return registry.install(req);
  });
}
