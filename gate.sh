#!/usr/bin/env bash
# Local quality gate. Read-only: never formats, fixes, or commits anything —
# only pnpm format:check, never pnpm format.
set -euo pipefail

# Runnable from any cwd: resolve to the script's own directory (repo root),
# not the directory the caller happens to be in.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pnpm format:check
pnpm turbo run lint typecheck --force
# Tests run one package at a time and before the build, never alongside it. Each package's Jest
# starts (cores - 1) workers; together with `next build`, the Nest build and the dev servers that
# oversubscribed the CPU enough for jsdom tests that take ~1s to pass 5s and time out. A timed-out
# test is not cancelled: its remaining clicks and typing land in the next test's DOM, so one timeout
# also fails the test after it. Timeouts stay as they are — the load is what was wrong.
pnpm turbo run test --force --concurrency=1
pnpm turbo run build --force
# Deliberately not chained with `&&`: under `set -e`, a failure in any command
# but the *last* one of an AND-OR list is invisible — POSIX exempts every
# non-final member of such a list from errexit. `db:up && db:deploy && ...`
# would silently swallow a failed `db:up` and fall through to `test:db` against
# a database that was never brought up. Separate statements don't have that
# exemption: each one's failure is the *whole* statement's failure.
pnpm db:up
pnpm db:deploy
pnpm db:seed
pnpm db:seed
pnpm test:db

# --- Git hygiene ------------------------------------------------------------
# Whitespace errors, in every place they can hide: unstaged tracked changes,
# staged changes, and untracked text files (§ below). `docs/specification.md`
# must never change (CLAUDE.md) — checked against HEAD so a *staged* edit is
# caught too, not just an unstaged one.

git diff --check
git diff --cached --check

# Untracked files aren't covered by `git diff`, and staging them for the check
# would touch the real index. `git diff --no-index` compares two paths without
# touching the index at all. Comparing against /dev/null always reports a
# "difference" (exit 1), so the exit code can't distinguish "clean" from
# "has whitespace errors" here — only `--check`'s own output can. Binary files
# are handled correctly by the same mechanism: git detects them and prints
# "Binary files differ" instead of running the whitespace check, so this loop
# never reads binary content as text.
while IFS= read -r -d '' file; do
  problems="$(git diff --no-index --check -- /dev/null "$file" || true)"
  if [ -n "$problems" ]; then
    echo "$problems" >&2
    echo "gate.sh: whitespace error in untracked file: $file" >&2
    exit 1
  fi
done < <(git ls-files --others --exclude-standard -z)

git diff HEAD --exit-code -- docs/specification.md

git status --short --branch
