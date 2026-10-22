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
export { mergeVariables, substituteVars, validateEnvironments } from './envs';
export {
  BODY_CAP_BYTES,
  DEFAULT_TIMEOUT_MS,
  REQUEST_BODY_CAP_BYTES,
  evaluateAssertion,
  lookupJsonPath,
  sendHttpRequest,
  type SendOptions,
} from './client';
