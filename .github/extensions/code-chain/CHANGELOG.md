# code-chain changelog

## v23
- Logging framed as a REQUIRED DELIVERABLE in the build and review prompts:
  builders and reviewers are told to assume no human will step through the code
  with a debugger, so the diagnostic logging must ship in the code itself. The
  CONCRETE logging mechanism (which logger to import, level meanings, field
  names, redaction rules) is explicitly deferred to the LOCAL project's own
  ./CONSTITUTION.md / ./CODING.md — NOT code-chain's docs. The review
  observability gate now also flags ad-hoc prints or a logger other than the one
  the local constitution mandates. Applied to build-chunk, review-chunk, the
  width>1 child-session kickoff mirror, and CODING.md §6.

## v22
- REVIEWER role upgraded from `claude-sonnet-4.6` to `claude-sonnet-5` (reasoning
  high) across all review stages: plan-critique, per-chunk review-chunk, and
  integration-review (plus the mirrored width>1 child-session review dispatch).
  BUILDER (`gpt-5.3-codex`) and PLANNER (`claude-opus-4.8`) unchanged; the
  builder/reviewer decorrelation property is preserved (different model families).
  Note: the coordinator/"main" session model is chosen at launch (kickoff), not in
  the engine — run it on `claude-sonnet-5` via the session kickoff to match.

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
