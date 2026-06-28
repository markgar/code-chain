# code-chain changelog

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
