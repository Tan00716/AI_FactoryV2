# @ai-factory/diagpack — diagnostics bundle builder (V3-#10)

Server-only package. The desktop consumes it over the HTTP API
(`GET /api/diagnostics/preview`, `POST /api/diagnostics/export`); it is
never imported by browser code, so it ships CJS only (like perfbench).

## What a bundle contains

- meta: app/server version, platform, arch, node version, bundle id, time
- privacy: includes/excludes lists + zh/en notice (also the preview)
- auditSummary: total + by-action counts + newest records, stripped
  fields only (id, ts, actor, action, entityType, entityId, result);
  `details` payloads are never read into a bundle
- taskEvidence: project count, task count, tasks by status (no titles)
- configSnapshot: auth mode + egress summary (modes and counts only)
- errorExcerpt: failure-shaped audit records (non-ok result, or an
  action naming BLOCKED/FAILED/DENIED/ERROR/REJECTED — heuristic, the
  audit log has no severity column)
- perfBaseline: per-task milliseconds from the V3-#4 baseline summary
- reportHtml: an HTML rendering of the same redacted sections

## What a bundle never contains

Secret/token values, audit details, task titles/descriptions, file
contents, environment variable names or values. Nothing is uploaded:
the bundle is returned to the caller, who downloads it.

## Redaction (redact.ts)

Rules come from the shared `@ai-factory/security` SECRET_PATTERNS
table — none are invented here:

- `specific` shapes (token formats, private keys, JWTs) are replaced
  wholesale with `[REDACTED:<name>]`.
- `generic` assignment shapes keep the key name and mask only the
  value with the shared `maskSecret` (first 4 + last 2, the same
  convention as the .env list). Masked values are under 8 characters,
  so they cannot re-trigger the generic patterns.

`buildBundle` runs `selfCheckSecretPatterns` over the serialized
bundle (including the HTML) and throws when any pattern still matches;
the route turns that into a 409 and ships nothing.

## Tests

```
npm run build -w @ai-factory/diagpack
node --test packages/diagpack/dist/tests/*.test.js   # 12/12
```

Fixtures are synthetic secret shapes, not real credentials.
