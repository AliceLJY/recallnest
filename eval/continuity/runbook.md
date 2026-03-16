# Continuity Eval Runbook

## Goal

Measure whether a fresh window can recover stable background through `resume_context`, instead of depending on manual reminders.

## Command

```bash
bun run eval:continuity
```

Generate a dated markdown report:

```bash
bun run src/eval.ts --mode continuity \
  --cases eval/continuity/cases.json \
  --output eval/continuity/results-YYYY-MM-DD.md
```

Generate JSON for tooling:

```bash
bun run src/eval.ts --mode continuity \
  --cases eval/continuity/cases.json \
  --json \
  --output /tmp/recallnest-continuity.json
```

## What To Check

- Pass rate
- Average score
- Which cases only recover `stableContext`
- Which cases still fail on `relevantPatterns` or `recentCases`
- Whether a checkpoint is present when `scope` or `sessionId` is provided

## Before Running

1. Confirm your normal memory index is available.
2. Seed the canonical workflow patterns if you want continuity eval to use durable `patterns` memory instead of only fallback logic:

```bash
bun run seed:patterns
```

3. If you want to test checkpoint-aware continuity, write a checkpoint first with `checkpoint_session` or `POST /v1/checkpoint`.
4. Keep the cases file small and high-signal. Four to eight cases is enough.

## After Running

1. Save the markdown report into `eval/continuity/results-YYYY-MM-DD.md`.
2. Compare it with the previous run instead of eyeballing one score in isolation.
3. If a case fails, decide which layer is missing:
   - capture gap
   - checkpoint gap
   - composition gap
   - retrieval gap

## Reading Failures

- Stable context missing:
  durable memories are not strong enough yet
- Patterns missing:
  reusable workflow knowledge has not been promoted enough
- Cases missing:
  solved problems are still trapped in raw transcripts
- Checkpoint missing:
  active work state was not written for the tested `scope` or `sessionId`
