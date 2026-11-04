#!/usr/bin/env bash
# Local quality gate. Read-only: never formats, fixes, or commits anything —
# only pnpm format:check, never pnpm format.
set -euo pipefail

usage() {
  cat <<'USAGE'
Використання: ./gate.sh [--level fast|standard|full]

Рівень визначає лише обсяг тестів; решта перевірок виконується на кожному рівні.
  fast      unit-тести, яких торкаються зміни гілки   (pnpm test:fast)
  standard  усі unit-тести: Shared, Web, API           (pnpm test:standard) — за замовчуванням
  full      unit + E2E + DB + browser                  (pnpm test:full) — потрібні Docker і Chromium

Ліміти: BOOKSWAP_JEST_WORKERS, BOOKSWAP_TEST_CONCURRENCY, BOOKSWAP_TURBO_CONCURRENCY.
Докладно: docs/plan/bs-152-three-tier-testing.md.
USAGE
}

level=standard
while [ "$#" -gt 0 ]; do
  case "$1" in
    --level)
      if [ "$#" -lt 2 ]; then
        echo "gate.sh: --level потребує значення" >&2
        usage >&2
        exit 2
      fi
      level="$2"
      shift 2
      ;;
    --level=*)
      level="${1#--level=}"
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "gate.sh: невідомий аргумент: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$level" in
  fast | standard | full) ;;
  *)
    echo "gate.sh: невідомий рівень: $level (очікується fast, standard або full)" >&2
    usage >&2
    exit 2
    ;;
esac

# Runnable from any cwd: resolve to the script's own directory (repo root),
# not the directory the caller happens to be in.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Validated by the same code the test runner uses: an invalid value stops the gate here, before
# any work (an assignment's status is its command substitution's, so `set -e` applies).
turbo_concurrency="$(node tools/test-tiers/limits.mjs turboConcurrency)"

pnpm format:check
pnpm turbo run lint typecheck --force --concurrency="$turbo_concurrency"
# Build and tests run one after another, never alongside each other. Jest workers together with
# `next build`, the Nest build and the dev servers once oversubscribed the machine enough for jsdom
# tests that take ~1s to pass 5s and time out. A timed-out test is not cancelled: its remaining
# clicks and typing land in the next test's DOM, so one timeout also fails the test after it.
# Timeouts stay as they are — the load is what was wrong; tools/test-tiers/limits.mjs bounds it.
# The build goes first so that Full's database specs, which run the built API CLI, reuse it.
pnpm turbo run build --force --concurrency="$turbo_concurrency"

case "$level" in
  fast) node tools/test-tiers/run.mjs fast ;;
  standard) node tools/test-tiers/run.mjs standard --force ;;
  full)
    # Not chained with `&&`: under `set -e`, a failure in any command but the *last* one of an
    # AND-OR list is invisible — POSIX exempts every non-final member of such a list from errexit.
    # A separate statement has no such exemption: a failed `db:up` stops the gate right here
    # instead of falling through to tests against a database that was never brought up.
    pnpm db:up
    node tools/test-tiers/run.mjs full
    ;;
esac

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
