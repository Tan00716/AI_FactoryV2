# Rule Priority Disclosure (AI Factory, baseline 1454295)

This document discloses how AI Factory merges rule files into the
effective view. It only describes current behavior; it does not change
the rule engine, and it does not claim any precedence order beyond what
the code implements.

Status date: 2026-11-06. Baseline commit: 1454295. R19 fidelity note:
H1 and body aligned to 1454295; packages/rules and
apps/server/src/routes/rules.ts are unchanged between 3f6d50c and
1454295 (git diff --name-only empty; the interval is 33 files: 9
documentation files, apps/server (m)+(n)+(o) source/routes/tests,
packages/debugger src/node-adapter.ts, packages/diagpack
src/redact.ts / tests/strip-userinfo.test.ts, packages/mutation
src/runner.ts / src/types.ts, and packages/remote src/transport.ts
(#6(m)/(n)/(o) changes), which touches no rule engine file), so
semantics are unchanged.
Fidelity review (V3R18 #8): the engine files were also unchanged between
f6641d5 and 3f6d50c (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 3f6d50c; semantics unchanged.
Review this document
whenever packages/rules or apps/server/src/routes/rules.ts changes.
Next review: the next V3.0 audit round, or immediately when
packages/rules or apps/server/src/routes/rules.ts changes, whichever
comes first.
Fidelity review (V3R17 #8): the engine files were also unchanged between
b8a9424 and f6641d5 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read f6641d5; semantics unchanged.
Fidelity review (V3R16 #8): the engine files were also unchanged between
46d0d66 and b8a9424 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read b8a9424; semantics unchanged.
Fidelity review (V3R15 #8): the engine files were also unchanged between
ff1308d and 46d0d66 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 46d0d66; semantics unchanged.
Fidelity review (V3R14 #8): the engine files were also unchanged between
cc7e499 and ff1308d (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read ff1308d; semantics unchanged.
Fidelity review (V3R13 #8): the engine files were also unchanged between
18d3ae9 and cc7e499 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read cc7e499; semantics unchanged.
Fidelity review (V3R12 #8): the engine files were also unchanged between
95a4dcc and 18d3ae9 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 18d3ae9; semantics unchanged.
Fidelity review (V3R11 #8): the engine files were also unchanged between
1078973 and 95a4dcc (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 95a4dcc; semantics unchanged.
Fidelity review (V3R10 #8): the engine files were also unchanged between
d87523c and 1078973 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 1078973; semantics unchanged.
Fidelity review (V3R8 #8): the engine files were also unchanged between
ba64414 and 7f6876d (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 7f6876d; semantics unchanged.
This document only discloses current behavior; it does not change the engine.
Fidelity review (V3R7 #8): the engine files were also unchanged between
5b93f74 and ba64414 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read ba64414; semantics unchanged.
This document only discloses current behavior; it does not change the engine.
Fidelity review (V3R6 #8): the engine files were also unchanged between
da648a1 and 5b93f74 (verified with git diff --name-only over
packages/rules and apps/server/src/routes/rules.ts: zero files).
Title baseline and body baseline now both read 5b93f74; semantics unchanged.
This document only discloses current behavior; it does not change the engine.
Fidelity review (V3R5 #9, kept as history): the only correction in that
revision was the section 1 title (five sources, not four). Every other
semantic below was re-checked against the code and against a compiled-dist
probe, and stands.

## 1. The five sources

| # | Source | Where it lives | Editable through the Rules API? |
|---|---|---|---|
| 1 | Managed global rules | `~/.ai-factory/rules/rules.json` (or `AI_FACTORY_GLOBAL_RULES_DIR` when set) | Yes |
| 2 | Managed project rules | `<project-root>/.ai-factory/rules.json` | Yes |
| 3 | Compat file AGENTS.md | `<project-root>/AGENTS.md` | No, read-only |
| 4 | Compat file .cursorrules | `<project-root>/.cursorrules` | No, read-only |
| 5 | Compat file .clinerules | `<project-root>/.clinerules` | No, read-only |

Sources 3-5 are read only because editing them through the API could
destroy their free-form formatting (packages/rules/src/types.ts).
Compat files are looked up only at the project root: no parent
directories and no nested subdirectories are scanned
(packages/rules/src/compat.ts).

Code references: packages/rules/src/types.ts (COMPAT_FILES),
packages/rules/src/store.ts, apps/server/src/routes/rules.ts
(globalFile / projectFile / loadLevel).

## 2. Order inside one managed level

Within the global level and within the project level, rules are sorted
by `order` ascending; ties break by name with locale comparison
(packages/rules/src/validate.ts, sortRules).

Rules are identified by name, case-insensitively: "Style" and "style"
are the same rule name (validate.ts, sameName). Within one level, two
rules may not share a name: add and rename both reject a duplicate
name at the same level (packages/rules/src/store.ts, addRule /
patchRule). Limits per level: at most 200 rules, name at most 120
characters, content at most 64 KiB (types.ts).

## 3. Effective-view merge (the only priority rule the code implements)

The effective list is built by mergeEffective
(packages/rules/src/merge.ts), in exactly this order:

1. Global managed rules, sorted as in section 2, form the base list.
2. Each project managed rule is applied in sorted order:
   - If a same-named (case-insensitive) global rule exists, the
     project rule replaces it IN PLACE: the entry keeps the global
     rule's position, but carries the project rule's content, and
     records the replaced global rule's id in `overrides`. The
     project rule wins; the global rule is NOT in the effective
     list.
   - If no same-named global rule exists, the project rule is
     appended to the end of the list.
3. Compat files are appended last, in the fixed order AGENTS.md,
   then .cursorrules, then .clinerules. A compat file that is
   absent, not a file, or unreadable is skipped silently; it is not
   an error.

So the effective list reads, top to bottom: surviving global rules
(with project overrides substituted in place), then new project rules,
then compat files in fixed order.

## 4. What "wins" means, and what it does not mean

- Managed project beats managed global, but ONLY for the same name
  (case-insensitive). Different names never override each other;
  both stay in the effective list.
- Compat files NEVER override anything. They are appended after all
  managed rules, even if a managed rule happens to share a file-like
  name. There is no compat-vs-managed conflict resolution in the
  code, because compat entries are never substituted in place.
- A disabled rule stays in the effective list with `enabled: false`
  and is greyed in the panel; it does not vanish
  (merge.ts; RulesPanel greys disabled entries). Disabling is not
  the same as deleting: a disabled project rule still replaces its
  same-named global rule in place.
- The losing global rule is not hidden: the level list shows it with
  `overriddenBy` set to the winning project rule's id
  (merge.ts, annotateOverridden). An override is labelled, never
  silent.
- No semantic validation of rule content is performed: content is
  the operator's prose, and the package deliberately does not judge
  it (types.ts). Two rules with contradictory prose are both kept;
  the code does not resolve prose conflicts.
- Compat content is returned verbatim and truncated at 512 KiB with
  a `truncated` flag, so a huge AGENTS.md cannot blow up the panel
  payload (compat.ts, MAX_COMPAT_BYTES).

## 5. How to verify the currently effective rules

1. Open the Rules panel and read the effective list: it shows each
   entry's scope (global / project), source (managed / agents /
   cursorrules / clinerules), enabled state, and read-only mark.
2. To check an override: find the global rule in the level list and
   read its `overriddenBy` field; it names the winning project
   rule's id. The losing global rule's content is NOT in effect.
3. To check programmatically: `GET /api/rules?root=<project-root>`
   returns `global` (annotated with overriddenBy), `project`,
   `compat`, and `effective` in one response
   (apps/server/src/routes/rules.ts, handleGet).
4. To test a conflict: create a global rule and a project rule with
   the same name (any case) and different content, then reload the
   effective list. The project content appears at the global rule's
   position, the global content does not appear, and the global
   entry carries `overriddenBy`.

## 6. Explicitly unknown (not disclosed as fact)

The following are NOT established by the code read for this document
and must not be quoted as priority rules:

- Managed-vs-compat total priority as a model-prompt precedence:
  the effective list is a panel view; no prompt-assembly consumer
  of the effective list was found in the server code during this
  review, so this document does not claim that list order equals
  prompt precedence. If a prompt consumer is added later, its
  precedence must be documented separately.
- Nested-directory rules: only the project root is scanned. A
  subdirectory AGENTS.md, .cursorrules, or .clinerules has no
  effect in this implementation.
- Cross-vendor filenames beyond the three listed in section 1
  (for example CLAUDE.md): not read, no effect.
- Any ordering between the three compat files beyond the fixed
  list order: they are appended, not ranked against each other.

## 7. Scope note

This document discloses the current effective-view merge only. It
does not restructure the rule engine, does not add a UI entry, and
does not cover the cost-aware writing guide, which is deferred to a
separate appendix pending measured evidence (R4 audit item #8,
split judgment).
