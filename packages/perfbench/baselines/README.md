# perfbench baselines

`baseline.json` is the archived gate baseline: the last run the
coordinator accepted as the reference. `run-*.json` files are
individual runs (kept for repeatability evidence, not gated).

Gate policy (V3-#4): threshold 20%, mode `warn` at landing.
Tighten to `block` only after the baseline has proven stable: at
least three runs on the same machine with per-task spread inside the
threshold band. Record the decision (date + runs) here when it happens.

Machine note: every report records node version, platform, arch,
CPU count, memory, and git revision. Never compare numbers across
machines without noting it; never present a synthetic-repo number
as a real-repo measurement.
