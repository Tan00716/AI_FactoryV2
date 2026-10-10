/**
 * @ai-factory/knowledge — distribution eligibility (spec §44).
 *
 * Every knowledge record carries source metadata (URL, publisher, retrieval
 * time, publication time, applicable version, content hash, citation scope,
 * license — see types.ts). Redistribution has one hard rule:
 *
 *   An external script WITHOUT a recorded license MUST NOT enter
 *   distribution.
 *
 * An "external script" is a knowledge item whose tags contain
 * 'external_script': material authored outside the factory that could be
 * copied into production code. Unknown license = unknown reuse rights, so
 * the item stays out of any distribution path until the license is
 * recorded on its source.
 */
import type { KnowledgeItem } from './types';

/** Tag marking a knowledge item as an external script. */
export const EXTERNAL_SCRIPT_TAG = 'external_script';

export class DistributionError extends Error {
  readonly code = 'MISSING_LICENSE';
  constructor(
    message: string,
    readonly itemId: string,
  ) {
    super(message);
    this.name = 'DistributionError';
  }
}

/** True when the item is an external script that needs a license check. */
export function isExternalScript(item: Pick<KnowledgeItem, 'tags'>): boolean {
  return item.tags.some((t) => t.trim().toLowerCase() === EXTERNAL_SCRIPT_TAG);
}

/**
 * Assert that a knowledge item may enter distribution.
 * Throws DistributionError when an external script has no license recorded
 * on its source. Pure check — does not mutate the item.
 */
export function assertDistributable(item: KnowledgeItem): void {
  if (isExternalScript(item) && !item.source.license) {
    throw new DistributionError(
      `Knowledge item ${item.id} is an external script with no license recorded ` +
        'on its source — refusing distribution. Record source.license before ' +
        'redistributing external scripts.',
      item.id,
    );
  }
}

/** Non-throwing variant: true when the item may enter distribution. */
export function canDistribute(item: KnowledgeItem): boolean {
  try {
    assertDistributable(item);
    return true;
  } catch {
    return false;
  }
}
