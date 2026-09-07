#!/usr/bin/env bash
#
# Dismisses Dependabot alerts raised against TEST FIXTURES.
#
# The fixture tree carries real lockfiles and real workspace manifests from real
# repositories, because the test bench runs real package managers against them.
# GitHub's dependency graph keys on the file BASENAME, so every fixture
# `yarn.lock` / `pnpm-lock.yaml` / `package-lock.json` / `package.json` is scanned
# as if it were this project's own — 1,683 of 1,784 open alerts at the time of
# writing, from 67 fixture files.
#
# Renaming the fixtures is not available: lockgraph itself reads `package.json`
# by its canonical name (the local-manifest rung), and the installed-tree oracle
# invokes npm/pnpm/yarn/bun on these very directories.
#
# `exclude-paths` in `.github/dependabot.yml` does NOT suppress these. That key
# governs version-update PRs; alerts come from the dependency graph, which has no
# path exclusion. Both are configured here anyway, and the alert count proves the
# split: the exclusion has been in place while all 1,683 alerts stood.
#
# So dismissal is the only lever, and it is per alert and permanent for that
# alert — but NOT for a future one, so every new real-world fixture raises a new
# batch. Re-run this after adding fixtures.
#
# Usage:
#   scripts/dependabot-false-pos-off.sh            # confirm, then dismiss
#   scripts/dependabot-false-pos-off.sh --yes      # no prompt (CI / re-runs)
#   scripts/dependabot-false-pos-off.sh --dry-run  # report only

set -euo pipefail

REPO="${REPO:-lockgraph/lockgraph}"
PREFIX="${PREFIX:-src/test/resources/fixtures/}"
# GitHub throttles mutating REST calls with a SECONDARY limit that no header
# announces up front; it answers 403/429 with `Retry-After` instead. So pace
# gently and let the backoff below discover the real ceiling rather than guessing
# a sleep that is either too slow to finish or too fast to survive.
SLEEP_SECONDS="${SLEEP_SECONDS:-1}"
MAX_RETRIES="${MAX_RETRIES:-6}"

ASSUME_YES=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --yes|-y)   ASSUME_YES=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

command -v gh >/dev/null 2>&1 || {
  echo "Error: GitHub CLI (gh) is not installed or not available in PATH." >&2
  exit 1
}

gh auth status >/dev/null 2>&1 || {
  echo "Error: GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
}

LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
trap 'echo; echo "Interrupted. Re-run to continue — dismissal is idempotent."; exit 130' INT TERM

echo "Fetching open Dependabot alerts for $REPO..."

# --paginate applies --jq per PAGE, so the filter must start by iterating the
# page array. `[.number, ...]` alone silently yields nothing on every page.
gh api --paginate \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
  --jq ".[] | select((.dependency.manifest_path // \"\") | startswith(\"$PREFIX\")) | [.number, .dependency.manifest_path] | @tsv" \
  > "$LIST"

COUNT="$(wc -l < "$LIST" | tr -d ' ')"

if [[ "$COUNT" == "0" ]]; then
  echo "No open alerts under $PREFIX. Nothing to dismiss."
  exit 0
fi

echo
echo "Open alerts under $PREFIX: $COUNT (from $(cut -f2 "$LIST" | sort -u | wc -l | tr -d ' ') files)"
cut -f2 "$LIST" | awk -F/ '{print $NF}' | sort | uniq -c | sort -rn | sed 's/^/  /'
echo
echo "Alerts OUTSIDE the fixture tree are left untouched — they are real."

if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry run: nothing dismissed."
  exit 0
fi

if [[ "$ASSUME_YES" != "1" ]]; then
  printf 'Dismiss all %s? [y/N] ' "$COUNT"
  IFS= read -r ANSWER
  case "$ANSWER" in
    y|Y|yes|YES|Yes|да|Да|ДА) ;;
    *) printf 'Cancelled. Received: %q\n' "$ANSWER"; exit 0 ;;
  esac
fi

dismiss () {
  local alert="$1" manifest="$2" attempt=1 delay="$SLEEP_SECONDS"
  while :; do
    if gh api --method PATCH \
        -H "Accept: application/vnd.github+json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "repos/$REPO/dependabot/alerts/$alert" \
        -f state="dismissed" \
        -f dismissed_reason="not_used" \
        -f dismissed_comment="Test fixture, not a dependency of this project: $manifest" \
        >/dev/null 2>&1; then
      return 0
    fi
    if (( attempt >= MAX_RETRIES )); then
      echo "  ! gave up on #$alert after $MAX_RETRIES attempts" >&2
      return 1
    fi
    delay=$(( delay * 2 ))
    echo "  … #$alert failed (attempt $attempt), backing off ${delay}s" >&2
    sleep "$delay"
    attempt=$(( attempt + 1 ))
  done
}

PROCESSED=0
FAILED=0
while IFS=$'\t' read -r ALERT MANIFEST_PATH; do
  PROCESSED=$((PROCESSED + 1))
  printf '[%d/%d] #%s %s\n' "$PROCESSED" "$COUNT" "$ALERT" "$MANIFEST_PATH"
  dismiss "$ALERT" "$MANIFEST_PATH" || FAILED=$((FAILED + 1))
  sleep "$SLEEP_SECONDS"
done < "$LIST"

echo
echo "Dismissed: $((PROCESSED - FAILED)) / $COUNT${FAILED:+  (failed: $FAILED)}"
[[ "$FAILED" == "0" ]] || { echo "Re-run to retry the failures."; exit 1; }
