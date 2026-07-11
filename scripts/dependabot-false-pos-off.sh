#!/usr/bin/env bash

set -euo pipefail

REPO="lockgraph/lockgraph"
PREFIX="src/test/resources/fixtures/"
SLEEP_SECONDS="${SLEEP_SECONDS:-8}"

command -v gh >/dev/null 2>&1 || {
  echo "Error: GitHub CLI (gh) is not installed or not available in PATH." >&2
  exit 1
}

gh auth status >/dev/null 2>&1 || {
  echo "Error: GitHub CLI is not authenticated. Run: gh auth login" >&2
  exit 1
}

LIST="$(mktemp)"

cleanup() {
  rm -f "$LIST"
}

trap cleanup EXIT
trap 'echo; echo "Interrupted. Restart the script to continue."; exit 130' INT TERM

echo "Fetching open Dependabot alerts..."

gh api --paginate \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "repos/$REPO/dependabot/alerts?state=open&per_page=100" \
  --jq ".[] |
    select(
      (.dependency.manifest_path // \"\") |
      startswith(\"$PREFIX\")
    ) |
    [.number, .dependency.manifest_path] |
    @tsv" \
  > "$LIST"

COUNT="$(wc -l < "$LIST" | tr -d ' ')"

if [[ "$COUNT" == "0" ]]; then
  echo "No matching open alerts found."
  exit 0
fi

echo
echo "Matched open alerts: $COUNT"
echo
echo "First 20:"
head -20 "$LIST"
echo

printf 'Dismiss all matched alerts? [y/N] '
IFS= read -r ANSWER

case "$ANSWER" in
  y|Y|yes|YES|Yes|у|У|да|Да|ДА)
    ;;
  *)
    printf 'Cancelled. Received: %q\n' "$ANSWER"
    exit 0
    ;;
esac

PROCESSED=0

while IFS=$'\t' read -r ALERT MANIFEST_PATH; do
  PROCESSED=$((PROCESSED + 1))

  printf '[%d/%d] Dismissing #%s: %s\n' \
    "$PROCESSED" \
    "$COUNT" \
    "$ALERT" \
    "$MANIFEST_PATH"

  gh api --method PATCH \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "repos/$REPO/dependabot/alerts/$ALERT" \
    -f state="dismissed" \
    -f dismissed_reason="not_used" \
    -f dismissed_comment="Fixture manifest used only as test input." \
    >/dev/null

  sleep "$SLEEP_SECONDS"
done < "$LIST"

echo
echo "Done. Dismissed alerts: $PROCESSED"