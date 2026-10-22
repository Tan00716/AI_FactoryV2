/**
 * @ai-factory/termhistory — R4-A8 终端命令历史搜索.
 *
 * Shell-integration (OSC 133) command tracking for interactive bash
 * sessions: per-command exit codes, persistent cross-session history
 * with fuzzy search. Zero dependencies.
 */
export {
  findMarkers,
  generateBashIntegrationRc,
  bashIntegrationWrapper,
  INTEGRATION_ENV_VAR,
  INTEGRATION_RC_PATH,
} from './markers.js';
export type { ShellMarker, ShellMarkerKind } from './markers.js';
export { CommandTracker } from './tracker.js';
export type { TrackedCommand, TrackerState, CommandTrackerOptions } from './tracker.js';
export { HistoryStore } from './store.js';
export type { HistoryEntry, NewHistoryEntry, HistoryStoreOptions } from './store.js';
export { fuzzyScore } from './fuzzy.js';
