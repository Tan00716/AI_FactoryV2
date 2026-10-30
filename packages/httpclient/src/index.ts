/**
 * @ai-factory/httpclient — public surface (round-4 task A6).
 */
export {
  HttpClientError,
  type AssertionResult,
  type AssertionSpec,
  type HttpEnvironment,
  type HttpMethod,
  type HttpRequestSpec,
  type HttpRunOptions,
  type HttpRunResult,
} from './types';
export { parseHttpFile } from './parse';
export {
  findUnresolvedVars,
  mergeVariables,
  substituteVars,
  substituteVarsStrict,
  substituteVarsStrictDeep,
  validateEnvironments,
} from './envs';
export {
  MAX_AUTH_PROFILES,
  MAX_COLLECTIONS,
  MAX_ENVIRONMENTS,
  MAX_HISTORY,
  MAX_REQUESTS_PER_COLLECTION,
  REDACTED,
  redactApiEnvironment,
  stripAuthHeaders,
  validateApiEnvironment,
  validateAuthProfile,
  validateCollection,
  validateSavedRequest,
  type ApiEnvironment,
  type AuthKind,
  type AuthProfile,
  type HistoryEntry,
  type HttpCollection,
  type SavedRequest,
} from './collections';
export { applyAuth, redactHeaders, type ResolvedAuthProfile } from './auth';
export { buildGraphqlBody, sendGraphqlRequest, type GraphqlRequest, type GraphqlResult } from './graphql';
export { WS_MAX_FRAME_BYTES, WsError, wsConnect, type WsClient } from './ws';
export {
  BODY_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  REQUEST_BODY_CAP_BYTES,
  evaluateAssertion,
  lookupJsonPath,
  sendHttpRequest,
  type SendOptions,
} from './client';
