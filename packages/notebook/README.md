# @ai-factory/notebook

Notebook / interactive cells (round-7 task R7-#2).

## What it is

A notebook is a versionable JSON document stored under
`<AI_FACTORY_DATA_DIR>/notebooks/` (`index.json` + `<id>.json`): an
ordered list of cells. Code cells run, markdown cells render. The
desktop Notebook panel edits, runs, reorders, and exports notebooks
over `/api/notebooks`.

## Execution model (honest)

- **No Jupyter kernel.** Each code cell runs as its own `node`
  process through the SHARED exec safety channel (same
  `checkCommandPolicy` + isolated temp dir + control-dir guard as
  scratch runs). There is no shared kernel state between cells:
  run-all runs cells in source order, one process each, and continues
  past failures — ordering, not a session.
- Only node-runnable languages (TypeScript/JavaScript) can run; the
  shared policy whitelists `node` only. Markdown cells return 400 on
  run. Runs are synchronous with a 30s timeout; env is
  credential-scrubbed; output is capped at 64K chars per stream with
  `truncated: true`.
- Notebooks are NOT git-tracked, NOT indexed, NOT snapshotted, NOT
  audited, and NOT covered by the pre-send prompt secret scan — the
  panel warns against pasting secrets.

## Outputs, separated

Outputs are stored with the notebook by default. Two ways to drop
them: `POST /api/notebooks/:id/clear-outputs` (in place) and
`GET /api/notebooks/:id/export?stripOutputs=1` (export copy without
outputs, for committing a clean notebook).

## Limits

100 notebooks, 200 cells per notebook, 256KB per cell source, 64K
chars per output stream, 30s per cell run. All fail-closed.
