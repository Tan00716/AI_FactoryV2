/**
 * @ai-factory/httpclient — GraphQL request builder + sender (round-7 R7-#9).
 *
 * Thin layer over the existing node:http(s) sender: a GraphQL operation
 * is just a POST with a JSON body `{ query, variables, operationName }`.
 * The response is surfaced as the normal HttpRunResult plus
 * `graphqlErrors` (the `errors` array of a GraphQL response, if any) so
 * callers can tell "HTTP 200 but GraphQL failed" apart from success.
 */
import { HttpClientError, type HttpRunResult } from './types';
import { sendHttpRequest } from './client';

export interface GraphqlRequest {
  endpoint: string;
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

export interface GraphqlResult extends HttpRunResult {
  graphqlErrors?: Array<{ message: string; [k: string]: unknown }>;
}

/** Validate + build the JSON body. Variables must be a plain object. */
export function buildGraphqlBody(req: GraphqlRequest): string {
  if (typeof req.endpoint !== 'string' || req.endpoint.length === 0 || req.endpoint.length > 4096) {
    throw new HttpClientError('graphql endpoint is required (max 4096 chars)', 'bad-graphql');
  }
  if (typeof req.query !== 'string' || req.query.trim().length === 0) {
    throw new HttpClientError('graphql query is required', 'bad-graphql');
  }
  if (req.variables !== undefined && (typeof req.variables !== 'object' || req.variables === null || Array.isArray(req.variables))) {
    throw new HttpClientError('graphql variables must be an object', 'bad-graphql');
  }
  if (req.operationName !== undefined && (typeof req.operationName !== 'string' || req.operationName.length > 256)) {
    throw new HttpClientError('graphql operationName must be a short string', 'bad-graphql');
  }
  return JSON.stringify({
    query: req.query,
    variables: req.variables ?? {},
    ...(req.operationName ? { operationName: req.operationName } : {}),
  });
}

/**
 * Send a GraphQL operation. `extraHeaders` are applied as-is (auth is
 * applied by the caller first). Egress gating stays the caller's job,
 * exactly like sendHttpRequest.
 */
export async function sendGraphqlRequest(
  req: GraphqlRequest,
  extraHeaders: Record<string, string> = {},
  timeoutMs?: number,
): Promise<GraphqlResult> {
  const body = buildGraphqlBody(req);
  const result = await sendHttpRequest(
    {
      id: 'graphql',
      name: req.operationName ?? '',
      method: 'POST',
      url: req.endpoint,
      headers: { 'content-type': 'application/json', ...extraHeaders },
      body,
      assertions: [],
    },
    { defaultTimeoutMs: timeoutMs },
  );
  const out: GraphqlResult = { ...result };
  const json = result.bodyJson;
  if (json !== undefined && typeof json === 'object' && json !== null && Array.isArray((json as { errors?: unknown }).errors)) {
    const errs = (json as { errors: unknown[] }).errors;
    out.graphqlErrors = errs.map((e) => {
      if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') {
        return e as { message: string; [k: string]: unknown };
      }
      return { message: String(e) };
    });
    // A GraphQL-level failure is not a transport success.
    out.ok = false;
    out.error = `graphql errors: ${out.graphqlErrors.map((e) => e.message).join('; ').slice(0, 512)}`;
  }
  return out;
}
