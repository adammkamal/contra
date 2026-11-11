#!/usr/bin/env sh
# Pre-commit hook: reject commits that touch protected files unless CONTRA_HUMAN=1.
# Install: ln -s ../../scripts/protect.sh .git/hooks/pre-commit
PROTECTED='^(INVARIANTS\.md|test/invariants\.test\.ts|test/demo\.test\.ts|bench/labels/|bench/heldout/labels/|bench/fresh/labels/)'
if [ "$CONTRA_HUMAN" != "1" ] && git diff --cached --name-only | grep -Eq "$PROTECTED"; then
  echo "Protected files changed (see AGENTS.md). Commit them yourself with CONTRA_HUMAN=1." >&2
  git diff --cached --name-only | grep -E "$PROTECTED" >&2
  exit 1
fi
