#!/bin/bash
# RecallNest error recall for Claude Code's PostToolUseFailure hook.
# Reads the hook JSON on stdin and passes it to scripts/error-recall.ts. When the error's specific signature
# exactly matches one recorded in an earlier session ledger, it prints additionalContext; otherwise nothing.
# Never blocks the tool call: any failure exits 0 with no output.
REPO="${RECALLNEST_REPO:-$HOME/recallnest}"
BUN="$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")"
[ -x "$BUN" ] && [ -f "$REPO/scripts/error-recall.ts" ] || exit 0
"$BUN" run "$REPO/scripts/error-recall.ts" --data-dir "${RECALLNEST_DATA_DIR:-$REPO/data}" 2>/dev/null
exit 0
