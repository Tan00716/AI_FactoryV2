/**
 * Tests for the §35 8-state skill lifecycle:
 * DRAFT → QUARANTINED → VALIDATED → EVALUATED → APPROVED → ACTIVE
 * → DEPRECATED → RETIRED, with legal transitions enforced.
 * Run: node --test dist/tests/lifecycle.test.js   (after tsc -p tsconfig.json)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SKILL_STATUS_TRANSITIONS,
  SkillRegistry,
  SkillStatusTransitionError,
  canTransitionSkillStatus,
  type InstallSkillDef,
  type SkillStatus,
} from '../src/index';

function cleanSkill(id = 'agent-built'): InstallSkillDef {
  return {
    id,
    version: '0.1.0',
    description: 'An agent-authored skill awaiting review.',
    compatibility: 'agent-skills >= 1.0',
    author: 'agent-7',
    source: 'agent-built',
    trustLevel: 'UNREVIEWED',
    evaluationScore: 0,
    content: {
      instructions: '# Agent Built\n\nDraft instructions.',
      references: [],
      scripts: [],
      assets: [],
    },
    declared: { network: false, fileAccess: 'NONE', shell: false },
    keywords: ['draft'],
  };
}

const ALL_EIGHT: SkillStatus[] = [
  'DRAFT',
  'QUARANTINED',
  'VALIDATED',
  'EVALUATED',
  'APPROVED',
  'ACTIVE',
  'DEPRECATED',
  'RETIRED',
];

describe('§35 skill status vocabulary', () => {
  it('defines exactly the 8 spec states', () => {
    assert.deepEqual(Object.keys(SKILL_STATUS_TRANSITIONS).sort(), [...ALL_EIGHT].sort());
  });

  it('RETIRED is terminal', () => {
    assert.deepEqual(SKILL_STATUS_TRANSITIONS.RETIRED, []);
    for (const s of ALL_EIGHT) {
      assert.equal(canTransitionSkillStatus('RETIRED', s), false);
    }
  });
});

describe('§35 proposal flow (agent self-built skill)', () => {
  it('propose() starts at DRAFT and walks the full approval chain', () => {
    const reg = new SkillRegistry();
    const v0 = reg.propose(cleanSkill());
    assert.equal(v0.status, 'DRAFT');

    const chain: Array<[SkillStatus, SkillStatus]> = [
      ['DRAFT', 'VALIDATED'], // security check passed
      ['VALIDATED', 'EVALUATED'], // independent evaluation
      ['EVALUATED', 'APPROVED'], // policy approval
      ['APPROVED', 'ACTIVE'], // activation
    ];
    for (const [from, to] of chain) {
      const cur = reg.get('agent-built', '0.1.0');
      assert.ok('status' in cur && cur.status === from);
      const next = reg.transitionStatus('agent-built', '0.1.0', to);
      assert.equal(next.status, to);
    }
  });

  it('illegal transitions throw SkillStatusTransitionError', () => {
    const reg = new SkillRegistry();
    reg.propose(cleanSkill());
    // DRAFT → ACTIVE skips security/eval/approval
    assert.throws(
      () => reg.transitionStatus('agent-built', '0.1.0', 'ACTIVE'),
      SkillStatusTransitionError,
    );
    // DRAFT → RETIRED is not a legal edge either
    assert.throws(
      () => reg.transitionStatus('agent-built', '0.1.0', 'RETIRED'),
      SkillStatusTransitionError,
    );
  });

  it('QUARANTINED versions go back to DRAFT for rework or to RETIRED', () => {
    const reg = new SkillRegistry();
    reg.propose(cleanSkill());
    reg.transitionStatus('agent-built', '0.1.0', 'QUARANTINED');
    const rework = reg.transitionStatus('agent-built', '0.1.0', 'DRAFT');
    assert.equal(rework.status, 'DRAFT');

    reg.transitionStatus('agent-built', '0.1.0', 'QUARANTINED');
    const dropped = reg.transitionStatus('agent-built', '0.1.0', 'RETIRED');
    assert.equal(dropped.status, 'RETIRED');
    // terminal: nothing leaves RETIRED
    assert.throws(
      () => reg.transitionStatus('agent-built', '0.1.0', 'DRAFT'),
      SkillStatusTransitionError,
    );
  });

  it('defective ACTIVE versions can be retired directly (§35 block new launches)', () => {
    const reg = new SkillRegistry();
    reg.propose(cleanSkill());
    reg.transitionStatus('agent-built', '0.1.0', 'VALIDATED');
    reg.transitionStatus('agent-built', '0.1.0', 'EVALUATED');
    reg.transitionStatus('agent-built', '0.1.0', 'APPROVED');
    reg.transitionStatus('agent-built', '0.1.0', 'ACTIVE');
    const r = reg.transitionStatus('agent-built', '0.1.0', 'RETIRED');
    assert.equal(r.status, 'RETIRED');
  });

  it('propose() refuses a duplicate version', () => {
    const reg = new SkillRegistry();
    reg.propose(cleanSkill());
    assert.throws(() => reg.propose(cleanSkill()));
  });
});
