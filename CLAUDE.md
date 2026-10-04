# BookSwap

Peer-to-peer lending of physical books between friends. pnpm workspaces + Turbo monorepo:
`apps/api` (NestJS), `apps/web` (Next.js), `packages/shared` (zod schemas, API contracts).

Read this file fully before the first action of every session. It defines how you work here;
`docs/CONVENTIONS.md` defines how the code must look. Both are binding.

## Sources of truth

| Question                                | Source                    | Priority                                             |
| --------------------------------------- | ------------------------- | ---------------------------------------------------- |
| What the system must do                 | `docs/specification.md`   | Wins over code. Never modify it.                     |
| What to build next, what's in a release | `docs/plan/roadmap-v2.md` | Wins over older plans and README.                    |
| How to build the current stage          | `docs/plan/<stage>.md`    | Implement only the current sub-stage.                |
| How code must look                      | `docs/CONVENTIONS.md`     | Binding; this file only adds to it.                  |
| How you work                            | this file                 | Wins over a task prompt — say so when they conflict. |

`docs/plan/archive/` is not a plan. Never implement from it without an explicit product decision.

When code and spec disagree, the spec wins — but don't make destructive changes without explaining
them first.

## Language

- Code, identifiers, comments, docstrings, commit messages: English.
- `README.md` and `docs/`: Ukrainian.
- UI copy: Ukrainian. Don't change user-facing text unless the task asks.
- Talk to me in Ukrainian.
- Existing Ukrainian code comments: translate a comment when you move or rewrite the code it
  belongs to. No translation sweeps over code you aren't otherwise touching.

## Domain invariants

- The catalog model is `Work → Translation → Edition → Copy`. Do not collapse or simplify it.
- Only a `Copy` is ever borrowed.
- A merged `Work` keeps `mergedIntoId` and is never deleted.
- Loan status transitions go through one transition table and one check function
  (CONVENTIONS §8.3) — never a scattered `if (status === …)`.

## Stack

Fixed: NestJS, Next.js, Prisma, PostgreSQL. Don't swap any of it without demonstrating an
actual incompatibility.

Do not introduce Redis, JWT, GraphQL, or microservices.

## Repository map

```
apps/api/src/<module>/        one domain per Nest module: controller → service → repository → prisma
apps/web/app/                 routes only (CONVENTIONS §1.1); app/lib/ — app-wide hooks and helpers
apps/web/features/<feature>/  api/ · components/ · model/ (pure logic + feature hooks, no JSX) · lib/
                              public surface only via index.ts / index.client.ts (enforced by
                              eslint-feature-boundaries.mjs)
apps/web/components/ui/       design system, zero business logic
packages/shared/              zod schemas, types, constants — no runtime-specific dependencies
docs/plan/                    roadmap and stage execution plans
```

## Commands

```
pnpm install
pnpm lint | pnpm typecheck | pnpm test        # whole repo through turbo
pnpm --filter @bookswap/web test -- <path>    # one web spec
pnpm --filter @bookswap/api test -- <path>    # one api unit spec
pnpm db:up && pnpm test:db                    # e2e + db tests, need PostgreSQL (docker compose)
./gate.sh                                     # full read-only gate; the definition of "verified"
```

`gate.sh` never formats or fixes anything. If it fails on formatting, report it — don't run
`pnpm format` over files you didn't touch.

## Code

- All endpoints live under `/api/v1` and return errors with a machine-readable `code` field.
- Shared zod schemas and API contracts belong in `packages/shared`.
- Nest DTOs are runtime-validated.
- `any` requires a stated reason.
- Never suppress a TypeScript, ESLint, or test error — fix the cause.
- No speculative abstractions. Build what the current stage needs.
- New client-side server state uses TanStack Query (CONVENTIONS §3.9, TD-03). Existing
  `useKeyedRequest` / `useApiResource` hooks are a documented legacy exception: keep using them
  where they already are, don't migrate them as a side effect of another task.

### Design rules this file adds to CONVENTIONS

The test behind each one: **how much must a reader hold in their head to safely change this code?**

- **Modes are components.** A second screen is never hidden behind `if (mode)` after a dozen
  shared hooks. A thin component picks the mode; state that must survive a mode switch lives there.
- **Guards before dependents.** Hooks that need an authenticated user or a valid param run below
  the guard that guarantees it. A sentinel (`''`, `?? ''`) that exists only because of hook order
  is a bug in the structure.
- **Invariants are owned, not remembered.** If every call site must do X before Y ("mark the
  address, then navigate"), one hook or function does both. Discipline across call sites is not
  an invariant.
- **Decisions in pure functions.** More than ~3 derived values in a component body → a pure
  view-model in `model/` with unit tests; the component renders from it.
- **One concept, one computation.** Two values with the same name (`finished`, `isEmpty`) must
  have the same meaning, or be renamed to say how they differ.
- **No `setState` during render** outside a named hook that owns that mechanism.
- **Comments move with their code.** A comment explains WHY; when the code moves, so does it.
- **Don't over-split.** No new file under ~25 lines unless it's a reusable pure module; tiny helpers
  join the module whose type or state they serve.

## Tests

- e2e files share one database and one process. Background schedulers
  (`NotificationDispatcher`, `NotificationDigestService`, `SessionCleanupService`) are
  therefore off by default there: `createTestApp()` overrides `BACKGROUND_MODE`, which
  disables both the interval and `wake()`. Never re-enable them by deleting a service from
  `AppModule` — `createTestApp()` must stay the same app as `main.ts`.
- A test that needs a delivery pass calls `run()` explicitly. Use
  `createTestApp({ background: true })` only where `wake()` itself is the subject.
- Invariant across file boundaries: no non-terminal `NotificationDelivery` rows survive a
  file. `test/e2e-setup.ts` enforces it — it fails the next file loudly instead of leaking.
- `createTestApp()` calls `app.listen(0)`, not `app.init()`: one listener per file. Never let
  supertest open and close a listener per request. This is backed by measurement, not by a
  proven mechanism — transport-class failures (`socket hang up`, `Parse Error`, 401 from a
  route that has no guard) went from 3 of 14 runs to 0 of 12. Keep-alive is NOT the cause:
  superagent defaults to `agent: false`, and `http.globalAgent` gets no sockets at all.
- Pure `model/` functions: unit tests without mocks. Hooks: hook tests in the existing style.
  Screens: interaction tests by role, label and text.
- A refactor never changes an existing test's expectation. If one has to change, behavior changed —
  that is a decision for me (see Escalation).
- Text split across DOM nodes: use a matcher function or `toHaveTextContent`; never weaken the
  assertion to make it pass.

## Workflow

- Work on the branch named in the stage prompt. Check with `git branch --show-current`;
  if it's anything else, stop and tell me — change nothing.
- Never run `commit`, `push`, `merge`, `rebase`, or `stash`. I do those.
- Run `git status` at start. Uncommitted changes you didn't make are mine: work with them as they
  are, never discard or overwrite them, and mention them in the report.
- Never modify `docs/specification.md`.
- Implement only the current sub-stage from `docs/plan/`. Don't start the next one.
- **Baseline first.** Before changing code, run the specs that cover it. Anything already red is
  reported and fixed as a separate step (or I mark it as known) — red tests prove nothing about
  preserved behavior.
- **Small steps.** One logical change per step. After each step: the relevant specs plus
  `pnpm lint` and `pnpm typecheck`. When the task is step-by-step, stop after each step and wait.
- Don't refactor unrelated code silently. Problems you notice outside the task go to the report.
- Verify with `./gate.sh`.

## Escalation

Stop and describe the options — (a)/(b), consequences of each, your recommendation — instead of
deciding on your own when:

- The work requires designing a subsystem that appears in neither `docs/specification.md` nor the
  stage plan — a queue, a cache, a shutdown/drain policy, a retry scheme.
- The stage plan leaves a real choice open. Name the choice, don't resolve it.
- A change alters observable behavior: UI copy, routing or URLs, which requests are sent or _when_,
  persisted data, API contracts — even when the change is an improvement.
- Code contradicts its own comments, docstrings, the plan or the spec. Report both sides; fix
  neither.
- Code looks dead — e.g. reachable only because a test mocks the router. Report it; don't delete it.
- The fix needs a change outside the task's scope: a shared component, another feature,
  `packages/shared`, `app/lib`.
- A Prisma migration, a schema change, a new dependency, or anything touching existing data.

## Reviews

For a single-file review or refactor, use the `/review-file` command
(`.claude/commands/review-file.md`). In review mode change no files.

## Reporting

End each sub-stage with: what was implemented, key files touched, each DoD item with the
test or command that proves it, assumptions made, open decisions (per Escalation), `./gate.sh`
exit code (or why it couldn't run), and confirmation that nothing was committed or pushed.
