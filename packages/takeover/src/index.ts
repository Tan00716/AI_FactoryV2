/**
 * @ai-factory/takeover — human takeover (§31).
 *
 *  - types    TakeoverState machine, TakeoverDisplay (honest UI states),
 *             HumanEdit (author_type=HUMAN attribution), typed errors
 *  - manager  TakeoverManager: quiesce → fence (leases) → verify quiet →
 *             snapshot → human edits → return → 3-way merge → revalidate →
 *             fresh AI lease → resume. No silent overwrites, no hard resets.
 */
export * from './types';
export * from './manager';
