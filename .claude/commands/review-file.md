---
description: Review (and optionally refactor step by step) one file against CLAUDE.md and docs/CONVENTIONS.md
argument-hint: <file path> [review | refactor | review+refactor]
---

# Review / refactor ONE file

Arguments: `$ARGUMENTS` — the target file path, then the mode (default: `review`).

Everything in `CLAUDE.md` applies (branch check, no git writes, baseline first, escalation,
reporting). This command adds the scope and the output format.

## Scope

- Only the target file and NEW files extracted from it (hooks, pure functions, subcomponents,
  constants), placed next to it in the feature's `components/`, `model/`, `lib/`, `api/`.
- Other files change only to update an import after a move. Everything else → "Outside scope".
- Behavior is preserved exactly: rendered output, UI copy, accessibility attributes, URL and
  routing behavior, which requests are sent and when, persisted state. A fix that must change any
  of these goes to "Decisions for you", even if it's an improvement.
- Public API (exported names, props, the feature barrel) stays unless I say otherwise.
- `review` mode changes no files.

## Before evaluating

1. Branch, `git status`, uncommitted changes in or around the target.
2. Find and run the specs covering the target. Report pass/fail; for each failure, its cause and
   whether it lies in the target file.
3. Read the stage plan the file implements (its docstrings usually name it) and note every place
   where code, comments and plan disagree.

## What to evaluate

1. Responsibilities, with line ranges. Count hooks and derived values in the main body.
2. Modes rendered via `if (mode)` after shared hooks; which state must survive a mode switch.
3. Hooks running before the guard that makes their input valid; sentinels caused by that order.
4. Invariants held by discipline across call sites.
5. Derived state that belongs in a pure view-model; parallel computations of the same concept.
6. `setState` during render, synced state that could be derived.
7. Duplication: repeated JSX, repeated prop wiring, identity/key formats built in several places,
   repeated literals (routes, separators, sizes).
8. Readability: vague names, nested ternaries, magic values, shadowing, inner render functions
   that should be components, empty wrappers, CSS reaching into child internals, orphaned comments.
9. Violations of `docs/CONVENTIONS.md` (cite the section).
10. Suspected dead code (verify against the plan; report, don't delete).
11. Strengths that must survive the refactor.

## Output

1. **Baseline** — branch, uncommitted changes, spec results with causes, plan read.
2. **Responsibility map** — table: responsibility → lines. Totals.
3. **Verdict** — 1–2 sentences + score /10 (cost of safely changing this file, not quality of the
   logic).
4. **Strengths** — 3–6 points with identifiers.
5. **Issues by impact** — groups Architecture → Correctness/fragility → Duplication → Readability;
   each with an ID (A1, B2…): Problem (identifiers + lines) → Why it matters (concrete cost or
   failure scenario) → Fix (minimal sketch). No padding with nits when structural issues exist.
6. **Target structure** — tree with files, approximate line counts, one-line roles; where each
   piece of state lives and why.
7. **Refactor plan** — Step 0 = baseline failures, if any. Then behavior-preserving steps ordered
   by effect/risk (pure extractions first, risky mechanism moves later, structural splits after
   their blockers are decided). Per step: what moves where, issue IDs closed, existing specs that
   prove nothing changed (by name), new tests, blockers.
8. **Decisions for you** — numbered, options (a)/(b), consequences, recommendation.
9. **Outside scope** — file:line and reason. Not performed.
10. **Confirmation** — commands run with results, files changed (review: none), nothing committed.

## Refactor mode

One step per turn. Before it: the issue IDs it closes. After it: the covering specs +
`pnpm lint` + `pnpm typecheck`, results, changed/created files — then stop and wait. If a spec
fails, report why and propose a fix; don't continue. Anything new you discover mid-step goes to
"Decisions for you" — don't work around it.
