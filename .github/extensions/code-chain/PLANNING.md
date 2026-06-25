# Planning

The tenets every plan must satisfy before any code is written — regardless of language, framework, or stack. This is **not** the spec and **not** the design itself; it is the short list of things that have to be true of *any* plan code-chain produces. The planner builds to these; the plan reviewer checks against them. A plan that violates one of these is sent back before building starts — a bad plan is the cheapest thing to fix and the most expensive thing to ship.

This is the **stack-agnostic baseline** that ships with code-chain. A project may add a `PLANNING.md` at its own root with its own conventions (how chunks map to backlog items, required checklists, house ordering rules); those extend — they never relax — this baseline.

---

## 0. Posture (read first)

- **The plan carries the judgment.** A good plan is detailed enough that a cheaper model can execute it without re-deciding anything. Ambiguity resolved here is a bug avoided later.
- **Plan to stay green.** The unit of work is the *chunk*: the smallest change that leaves the tree green (compiles + its own tests pass) and is independently committable. Every plan is a sequence of chunks, not a pile of files.
- **Surface unknowns, don't paper over them.** If the spec is ambiguous or underspecified, the plan names the gap and proposes a resolution — it never silently invents requirements or gold-plates beyond what's asked.

---

## 1. Completeness

- **Every requirement maps to a chunk *and* a test.** Each entity, rule, endpoint, and edge case in the spec is traceable to the chunk that builds it and the test that proves it. Nothing in the spec is unaccounted for.
- **No invented scope.** Nothing in the plan lacks a basis in the spec. Extra "nice to have" work is flagged as out-of-scope, not folded in.
- **Negatives and edges are planned, not assumed.** Error paths, boundary values, and abuse cases get their own planned tests alongside the happy path.

---

## 2. Chunking

- **Right-sized by risk.** A chunk is **as large as it can be** while still leaving the tree green, staying independently committable, and reviewable in one pass — *not* the smallest possible slice. Low-risk, same-layer, mutually-independent units are merged into one chunk; a leaf utility or pure-function file never gets its own chunk. HIGH-RISK units go the other way: isolated, and split finer for deeper review. **Loop count should track risk, not file count.**
- **One acceptance check per chunk.** A chunk proves itself green with a *single* acceptance check. Needing more than one independent check — or spanning more than one layer, bundling independently-failing rules, or combining two risk surfaces — means it's too big; split at the seam. A check that's trivially satisfiable (a leaf utility with no independent risk) means it's too small; merge it into the chunk that uses it.
- **One concern per chunk.** A chunk does one coherent thing; it never bundles unrelated work to save a step.
- **Independently verifiable.** Each chunk names its acceptance check — the exact test or command that proves it green — so "done" is observable, not asserted.

---

## 3. Ordering & dependencies

- **Dependency-ordered.** Each chunk builds only on chunks before it. No forward references, no cycles.
- **Contracts named at the seams.** Where one chunk depends on another, the plan states the interface between them (types, function signatures, schemas, routes) so chunks compose instead of colliding.
- **Sequenced for early validation.** Foundational and high-risk assumptions are scheduled early, so the riskiest unknowns are proven (or disproven) before later work piles on top of them.

---

## 4. Risk

- **High-risk chunks are flagged.** Anything touching a security boundary, auth, money/discount/coupon math, data migration, or concurrency is marked so it earns deeper, per-task review during the build.
- **Risk drives review depth, not the default.** Normal chunks get one review each; flagged chunks get the heavier treatment. The plan makes that call up front rather than reviewing everything at maximum cost.

---

## 5. Traceability

- **Each chunk cites the spec.** A chunk references the rule(s) or requirement(s) it satisfies, so coverage is auditable and the reviewer can confirm nothing was dropped.
- **The plan is the contract for the build.** The finalized plan — after review — is what the coder implements. Deviations during the build are surfaced and folded back into the plan, not made silently.
