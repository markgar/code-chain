# code-chain changelog

## v21
- observability as a first-class build + review concern. CODE stage instruments
  non-trivial control flow in the same change ("explainable from logs alone");
  CODE-REVIEW adds an enumerated observability gate (non-success without a reason
  log, untraced multi-step/cross-service paths, bare-status cross-service calls,
  level/redaction violations) as a blocking correctness check. Mirrored into the
  width>1 child-session kickoff. Standard strengthened in CODING.md §6; specifics
  stay deferred to each target repo's own conventions — no repo-specific logging
  details hard-coded in the engine.

## v20
- fix: include required `name` on all `task()` sub-agent dispatches (host rejected
  calls with `"name": Required`, failing the PLAN stage); add a global rule and
  harden the width>1 child review dispatch.

## v19
- flat model roles: PLANNER=claude-opus-4.8 (medium), BUILDER=gpt-5.3-codex,
  REVIEWER=claude-sonnet-4.6 (high). Dropped risk-based CHEAP/STRONG tier routing;
  safety now comes from author/reviewer decorrelation. Chunk risk tunes plan detail
  and review depth only, not model choice.

## v18
- Opus 4.8 (medium) as the default planner.
