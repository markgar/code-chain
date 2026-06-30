import { joinSession } from "@github/copilot-sdk/extension";
import { appendFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// A "run" == one extension/session process. Every stage of a session lands in the
// same per-run folder under .code-chain/runs/<RUN_ID>/ so each trial is preserved
// and comparable, instead of the latest run overwriting plan.md / review.md and
// re-using one timeline. RUN_ID is time-sortable and tagged with the session id.
const RUN_STARTED = new Date();
const SESSION_ID = process.env.SESSION_ID || "";
const RUN_ID = (() => {
  const ts = RUN_STARTED.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const sid = SESSION_ID ? SESSION_ID.slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${ts}_${sid}`;
})();

// PORTABLE BY DESIGN: this extension does not assume it lives inside the repo it
// observes. Every hook input carries `workingDirectory` — the active session's
// worktree — so we write the .code-chain/ flight recorder into whatever project
// is currently active. That means the SAME installed copy works at user scope
// (one install, all projects) or project scope, with no path assumptions.
//
// Each run (one session) writes into its own .code-chain/runs/<RUN_ID>/ folder,
// and .code-chain/latest symlinks to the most recent run:
//   runs/<RUN_ID>/debug.log    — low-level extension debug output
//   runs/<RUN_ID>/plan.md      — latest plan / plan-review (prompt + result)
//   runs/<RUN_ID>/review.md    — latest code-review (prompt + result)
//   runs/<RUN_ID>/events.log   — append-only history of every stage's full I/O
//   runs/<RUN_ID>/timeline.log — one ordered line per event (the flight recorder)
//   runs/<RUN_ID>/metrics.csv  — machine-readable per-event metrics for analysis

// Resolve (and create) the .code-chain dir for the active project. Falls back to
// process.cwd() only if a hook ever omits workingDirectory.
function chainDir(workingDirectory) {
  const base = workingDirectory || process.cwd();
  const dir = join(base, ".code-chain");
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
  return dir;
}

// Per-run directory: .code-chain/runs/<RUN_ID>/ inside the active project. Also
// refreshes a convenient .code-chain/latest pointer to the current run so
// `cat .code-chain/latest/timeline.log` always shows the most recent trial.
function runDir(workingDirectory) {
  const base = chainDir(workingDirectory);
  const dir = join(base, "runs", RUN_ID);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
  try {
    const link = join(base, "latest");
    try {
      rmSync(link, { force: true });
    } catch (e) {
      // ignore
    }
    symlinkSync(join("runs", RUN_ID), link);
  } catch (e) {
    // symlinks may be unavailable on some filesystems; fall back to a text pointer
    try {
      writeFileSync(join(base, "latest.txt"), RUN_ID + "\n");
    } catch (e2) {
      // ignore
    }
  }
  return dir;
}

function debug(dir, msg) {
  try {
    appendFileSync(join(dir, "debug.log"), `[${new Date().toISOString()}] ${msg}\n`);
  } catch (e) {
    // ignore
  }
}

function safeStr(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch (e) {
    return String(v);
  }
}

// ~4 chars/token heuristic. The session store never reliably flushes these
// sub-agent sessions, so estimating from the actual prompt/result text we already
// hold in the hook is our most dependable token signal.
function estTokens(str) {
  if (!str) return 0;
  return Math.ceil(String(str).length / 4);
}

// Pull model / agent_id / exec_mode / real char-length counts out of a task result.
// The host exposes EXACT prompt and response character counts in
// `toolTelemetry.properties.{prompt_length,response_length}` (as strings) — this is
// our authoritative token signal. The large `prompt` text itself is stripped from
// toolArgs, but these length counts always come through, so we estimate tokens
// directly from them (chars/4) instead of trying to recover the prompt text.
function extractTelemetry(rawResult) {
  const t = { model: "", agentId: "", agentType: "", execMode: "", metrics: null, promptLen: 0, responseLen: 0, toolCalls: null };
  try {
    const tel = rawResult && rawResult.toolTelemetry;
    if (tel) {
      const p = tel.properties || {};
      t.model = p.model || "";
      t.agentType = p.agent_type || p.agent_name || "";
      t.execMode = p.execution_mode || "";
      t.promptLen = Number(p.prompt_length) || 0;
      t.responseLen = Number(p.response_length) || 0;
      const rp = tel.restrictedProperties || {};
      t.agentId = rp.agent_id || "";
      if (tel.metrics && Object.keys(tel.metrics).length) {
        t.metrics = tel.metrics;
        if (typeof tel.metrics.numberOfToolCallsMadeByAgent === "number") {
          t.toolCalls = tel.metrics.numberOfToolCallsMadeByAgent;
        }
      }
    }
  } catch (e) {
    // ignore
  }
  return t;
}

// Estimate tokens from a raw character count (host-provided lengths are authoritative).
function tokFromLen(n) {
  return n > 0 ? Math.ceil(n / 4) : 0;
}

// Classify a task call into a pipeline stage. The host strips `description` and the
// `prompt` from toolArgs and omits agent_id for sync tasks, so the only reliable
// signal left in the post-hook is the model's RESULT text. Reviews announce a verdict
// (BLOCKING / CHANGES_REQUIRED / APPROVE / LGTM); plans emit a file layout / wave /
// chunk design; code stages report tests created/passing. This is best-effort — the
// authoritative per-phase axis is `model` (each pipeline phase uses a distinct model).
function classifyStage({ resultText, prevStage }) {
  const hay = String(resultText || "").slice(0, 1200).toLowerCase();
  const isReview = /blocking|changes_required|changes required|\bverdict\b|\blgtm\b|approve|reject|looks good|review (?:summary|verdict)|non-blocking/.test(hay);
  const isPlan = /file layout|## models|wave \d|chunk c?\d|directory layout|## file|test cases|boot ?\/ ?startup|## plan/.test(hay);
  const isCode = /tests? (?:pass|passed|green)|\d+ passed|all \d+ tests|implemented|created under|created the|wrote |files? created|\bpytest\b/.test(hay);
  if (isReview) {
    // A review that follows a PLAN is a PLAN_REVIEW; one that follows CODE is CODE_REVIEW.
    return prevStage === "PLAN" || prevStage === "PLAN_REVIEW" ? "PLAN_REVIEW" : "CODE_REVIEW";
  }
  if (isPlan && !isCode) return "PLAN";
  if (isCode) return "CODE";
  return "TASK";
}

// Per-process ordering counters (reset on extension reload; timestamps still order
// events across reloads). PREV_STAGE lets a review be attributed to the phase it
// follows (PLAN_REVIEW vs CODE_REVIEW).
let SEQ = 0;
let LAST_TS = Date.now();
let PREV_STAGE = "";

// The model's actual returned text. For a SYNC task this is the agent's full answer;
// for a BACKGROUND dispatch it is just the "Agent started…" ack (correct: a background
// dispatch produces no inline output — that work is billed in the child's own ledger).
function resultOutputText(rawResult) {
  if (rawResult && typeof rawResult.textResultForLlm === "string") return rawResult.textResultForLlm;
  return safeStr(rawResult);
}

// Unified, append-only timeline. One ordered line per event with a sequence number
// and elapsed-since-previous gap. A single `cat timeline.log` reconstructs a run:
//   SESSION -> PLAN -> PLAN_REVIEW -> CODE -> CODE_REVIEW -> CODE(fix) -> CODE_REVIEW
function timeline(dir, kind, summary) {
  try {
    SEQ += 1;
    const now = Date.now();
    const elapsed = ((now - LAST_TS) / 1000).toFixed(1);
    LAST_TS = now;
    const ts = new Date(now).toISOString();
    const seqStr = String(SEQ).padStart(3, "0");
    appendFileSync(
      join(dir, "timeline.log"),
      `${ts}  #${seqStr}  +${String(elapsed).padStart(6)}s  ${kind.padEnd(11)}  ${summary}\n`
    );
  } catch (e) {
    // ignore
  }
}

// Machine-readable per-event metrics so runs can be analyzed in SQL/pandas.
function metricRow(dir, { stage, model, agentId, execMode, promptTok, resultTok, ok }) {
  try {
    const csv = join(dir, "metrics.csv");
    if (!existsSync(csv)) {
      writeFileSync(csv, "ts,seq,stage,model,agent_id,exec_mode,prompt_tok_est,result_tok_est,status\n");
    }
    const ts = new Date().toISOString();
    appendFileSync(
      csv,
      `${ts},${SEQ},${stage},${model || ""},${agentId || ""},${execMode || ""},${promptTok || 0},${resultTok || 0},${ok ? "ok" : "fail"}\n`
    );
  } catch (e) {
    // ignore
  }
}

// Capture a `task` sub-agent call (any of the four loops) to disk.
function captureTaskCall(dir, toolArgs, rawResult, ok) {
  try {
    const args = toolArgs || {};
    const tel = extractTelemetry(rawResult);
    const agentType = args.agent_type || tel.agentType || "unknown";
    const model = args.model || tel.model || "(default)";
    const ts = new Date().toISOString();

    // The model's actual output (sync: full answer; background: the dispatch ack).
    const resultText = resultOutputText(rawResult);
    const background = (tel.execMode || "").toLowerCase() === "background";

    // Token estimates come from the host's authoritative char counts (prompt_length /
    // response_length). Fall back to measuring the result text only if absent. The
    // prompt text itself is stripped from the hook, so we never have it — only its length.
    const promptTok = tel.promptLen ? tokFromLen(tel.promptLen) : 0;
    const resultTok = tel.responseLen ? tokFromLen(tel.responseLen) : estTokens(resultText);

    // Classify from the result content (only reliable post-hook signal); a background
    // dispatch returns only an ack, so it can't be classified — label it DISPATCH.
    const stage = background ? "DISPATCH" : classifyStage({ resultText, prevStage: PREV_STAGE });
    if (!background && stage !== "TASK") PREV_STAGE = stage;
    const isReview = stage === "PLAN_REVIEW" || stage === "CODE_REVIEW";
    const named = isReview ? "review.md" : "plan.md";

    // For a background dispatch the real agent output isn't returned inline (it lands
    // asynchronously and isn't hookable); flag it so result-token totals aren't
    // misread as "this stage was nearly free."
    const resultNote = background ? " (background dispatch — output billed in child ledger)" : "";

    const block =
      `# ${stage} — ${ts}\n\n` +
      `- stage: ${stage}\n- model: ${model}\n- agent_type: ${agentType}\n` +
      `- agent_id: ${tel.agentId || "(n/a)"}\n- exec_mode: ${tel.execMode || "(n/a)"}\n` +
      `- status: ${ok ? "success" : "FAILURE"}\n` +
      `- prompt_chars: ${tel.promptLen} -> prompt_tokens_est: ${promptTok}\n` +
      `- result_chars: ${tel.responseLen || (resultText || "").length} -> result_tokens_est: ${resultTok}${resultNote}\n` +
      (tel.toolCalls != null ? `- agent_tool_calls: ${tel.toolCalls}\n` : "") +
      (tel.metrics ? `- metrics: ${safeStr(tel.metrics)}\n` : "") +
      `\n## Note\n\nThe host strips the prompt text from the hook; only its character length\n` +
      `(prompt_chars above) is available. Token counts are chars/4 estimates.\n\n` +
      `## Sub-agent result (output)\n\n${resultText}\n`;

    writeFileSync(join(dir, named), block);
    appendFileSync(join(dir, "events.log"), `\n${"=".repeat(80)}\n${block}`);
    timeline(dir, stage, `model=${model} exec=${tel.execMode || "?"} ptok~${promptTok} rtok~${resultTok}${background ? "(bg)" : ""} status=${ok ? "ok" : "FAIL"}`);
    metricRow(dir, { stage, model, agentId: tel.agentId, execMode: tel.execMode, promptTok, resultTok, ok });
  } catch (e) {
    debug(dir, `captureTaskCall error: ${e.message}`);
  }
}

// Absolute paths to the baseline docs that ship beside this extension, resolved from
// the module's own location so they work at user scope or project scope. Sub-agents
// read these directly. The TARGET project may also keep its own ./CONSTITUTION.md
// (stack/domain/invariants) and optional ./PLANNING.md / ./CODING.md at its repo root.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PLANNING_DOC = join(EXT_DIR, "PLANNING.md");
const CODING_DOC = join(EXT_DIR, "CODING.md");
// Starter that shows the SHAPE of a project ./CONSTITUTION.md. Ships beside the
// extension; the coordinator consults it to author/validate a project's constitution.
const CONSTITUTION_TEMPLATE = join(EXT_DIR, "CONSTITUTION.template.md");

const SKILL_CONTEXT = `
## Code Chain Workflow (chunked: plan → plan-review → [code → review → fix] per chunk)

You are a COORDINATOR. You NEVER write plans or code yourself. You orchestrate
workers. PLAN, PLAN REVIEW, and sequential (width-1) build stages run as \`task\`
sub-agents SYNCHRONOUSLY (mode: "sync") so the full result returns inline AND the
pipeline logger captures each stage's content + token cost to .code-chain/. Parallel
build WAVES additionally spawn one child SESSION per chunk (each in its OWN worktree)
so independent chunks build concurrently and merge back — see the build loop below.

CRITICAL — every in-process \`task\` stage (PLAN, PLAN REVIEW, and every width-1
CODE/CODE_REVIEW/FIX) MUST be dispatched with mode: "sync". NEVER mode: "background"
for these. A background dispatch returns only an "Agent started…" ack, so the stage's
real output — and its token cost — is NOT captured in this run's ledger; it also
forces you to stall waiting for a notification. Sync is both cheaper to observe and
simpler to act on. Background is ONLY ever correct for spawning parallel child build
SESSIONS via create_session in a width>1 wave — never for a \`task\` sub-agent stage.

CRITICAL — the host's \`task\` tool REQUIRES a \`name\` field (a short kebab-case agent
label); its schema requires ["name", "prompt", "agent_type", "description"]. EVERY
\`task({…})\` call you make MUST include \`name\`, or the host REJECTS the call with
\`"name": Required\` and the stage fails (e.g. the very first PLAN stage dies and the
build never starts). The templates below show the exact \`name\` to use for each stage
(plan-chunks, plan-critique, build-chunk, review-chunk, integration-review); pass it
as the FIRST argument. This applies to task calls a child worker makes too.

The spec is broken into CHUNKS up front, reviewed ONCE, then each chunk is built,
reviewed, and fixed in its own short loop before the next chunk starts. Review depth is
per-CHUNK by default — only HIGH-RISK chunks get deeper per-task review.

### House rules (baseline docs ship with code-chain; the project speaks for itself)
- PLANNING — tenets of a good plan — ${PLANNING_DOC}
- CODING — the code/quality baseline — ${CODING_DOC}
Planning stages build to / review against PLANNING; coding stages conform to / review
against CODING. Each sub-agent reads the doc itself — pass the path in its prompt (below).

EVERY stage also reads the TARGET project's own \`./CONSTITUTION.md\` at its repo root if
present: its tech stack, architecture invariants, domain constraints, and deployment
rules. The baselines say how to plan and code well *in general*; the project
CONSTITUTION says what *THIS* project specifically requires — it is the project's source
of truth. Plans must fit it, code must conform to it, and reviewers flag violations as
blocking. (A project may also drop its own \`./PLANNING.md\` or \`./CODING.md\` to
EXTEND — never relax — the baselines.)

If the target repo has NO \`./CONSTITUTION.md\`, the project's stack/domain/invariants are
undeclared. A template showing the SHAPE of one ships at ${CONSTITUTION_TEMPLATE} — its
sections (Stack, Architecture invariants, Domain constraints, Security, Config, Data,
Errors, Testing, Deployment, Definition of done) are the checklist of what a good
constitution covers. If the spec makes the project's stack/domain clear, OFFER to scaffold
a \`./CONSTITUTION.md\` from that template (filled in from the spec) before planning, so this
and future runs are grounded — but never block on it; proceed from the spec if declined.

Specify the \`model\` on EVERY task call — the model is FIXED per stage by ROLE (see
Fixed model roles below). The \`model\` is the authoritative per-phase axis in telemetry
(the host strips \`description\` from the hook, so the logger classifies stages from
result content and keys cost by model). Keep the \`description\` strings below for your
own readability.

### Fixed model roles (decorrelated author vs reviewer)
Every run uses three fixed roles, assigned by STAGE, never by chunk:
- PLANNER  = "claude-opus-4.8" (reasoning medium) — authors the plan, runs ONCE.
- BUILDER  = "gpt-5.3-codex" — writes EVERY chunk's code, every wave.
- REVIEWER = "claude-sonnet-5" (reasoning high) — reviews EVERY chunk, EVERY
  integration, and the plan.
The safety property is DECORRELATION: the BUILDER and REVIEWER are different model
FAMILIES, so the reviewer RE-DERIVES each rule from the spec instead of sharing the
coder's blind spots — it catches spec-divergence and concurrency bugs the builder's
own tests miss. A strong-but-cheap coder grinds all the volume; a different-family
oracle guards every chunk. This is the entire economic thesis: top-tier reasoning only
at the PLAN, decorrelated review everywhere, no Opus on the build/review mass.

CHUNK RISK still matters — but it tunes PLAN DETAIL and REVIEW DEPTH, NEVER model
choice. A HIGH-RISK chunk (money/coupon/discount math, auth or security boundary,
concurrency, idempotency, state machine, data migration) gets (a) its own finer-grained
chunk with a TRANSCRIBE-READY blueprint so the BUILDER designs nothing, and (b)
per-TASK review depth — each task's diff reviewed, not just the whole chunk. LOW-RISK
chunks get a single review pass. The SAME two models are used throughout either way.

WHY Opus only at PLAN: a plan error — a dropped business rule or a wrong high-risk
blueprint — is the LEAST RECOVERABLE defect in the pipeline: the BUILDER transcribes
the blueprint faithfully, and a chunk-scoped REVIEWER never looks for a rule the plan
omitted. One Opus call upstream is therefore the cheapest, highest-leverage place to
spend top-tier reasoning; every build and review stage stays on the BUILDER/REVIEWER.

### Loop 1 — PLAN (spec → chunks)
task({ name: "plan-chunks", agent_type: "general-purpose", model: "claude-opus-4.8", reasoning_effort: "medium", mode: "sync",
       description: "Plan build chunks",
       prompt: "FIRST read the planning rubric at ${PLANNING_DOC} (and ./PLANNING.md at the repo root if it exists), and read ./CONSTITUTION.md at the repo root if present to learn the project's tech stack, architecture invariants, and domain constraints. Produce a plan that satisfies every PLANNING tenet AND fits the project's stack/constraints. <Break the task into the FEWEST CHUNKS that still build cleanly. SIZE EACH CHUNK BY RISK, NOT BY FILE. A chunk should be as LARGE as it can be while still (a) leaving the tree GREEN (compiles + its own tests pass), (b) being independently committable, and (c) reviewable in one pass with exactly ONE acceptance check. Do NOT give a leaf utility, pure-function, or single small low-risk file its own chunk — fold low-risk, same-layer, mutually-independent units together into one coherent chunk. CONVERSELY, HIGH-RISK units (security boundary, auth, money/coupon/discount math, data migration, concurrency, idempotency, state machines) get their OWN chunk and may be split FINER so each earns deep review; never bundle a high-risk unit with other work or combine two distinct risk surfaces. For every HIGH-RISK chunk, write a TRANSCRIBE-READY BLUEPRINT so the coder designs NOTHING: give the exact function signatures, the precise formula/algorithm for each business rule (INCLUDING the rounding mode — e.g. ROUND_HALF_UP — and the single money/util helper to call), the spec rule id each piece satisfies, and the exact BOUNDARY cases (half-cent rounding, threshold edges, off-by-one, tie-breaks) its tests must cover. If any high-risk decision (rounding, tie-break, ordering, units, null-handling) is left open, the plan is INCOMPLETE — pin it. For each chunk give: an ordered id/name, the files it touches, a one-line acceptance check (the single test or command that proves it green), the spec rule(s) it satisfies, and its dependencies on earlier chunks. Order chunks so each builds only on earlier ones. Mark HIGH-RISK chunks. Do NOT state a target number of chunks — but prefer consolidation: if two adjacent low-risk chunks could be reviewed together without losing clarity, make them one. THEN compute the dependency graph and GROUP the chunks into ordered WAVES: a wave is a set of chunks that depend ONLY on chunks in EARLIER waves AND touch DISJOINT files, so a wave's chunks can be built in parallel and merged without conflict. Give every chunk an EXCLUSIVE set of OWNED files — no two chunks (especially within the same wave) may write the same file. Engineer this by structure: per-entity model modules, ONE router/module file per chunk, and an auto-include/registration seam so chunks never co-edit a shared app/models/router-registry file; if such shared scaffold is unavoidable, create it ONCE in an early width-1 wave that later waves only import (never edit). Present the plan as ordered WAVES (Wave 1, Wave 2, ...), each listing its chunks (a wave may hold a single chunk), and for each chunk list its OWNED files explicitly. EXPLICITLY name any SHARED or SCAFFOLD files (app entrypoint, models/router registry, conftest, dependency manifest, central config) and the SINGLE Wave-1 chunk that owns each, plus the auto-discovery/registration pattern that lets later chunks add behavior WITHOUT editing those shared files. For an EXISTING (non-greenfield) project, FIRST inspect the current layout: identify every pre-existing file that more than one chunk would need to modify, and either (a) repartition the work so each chunk owns a distinct file or region, or (b) place the colliding chunks in DIFFERENT waves so they never edit that file concurrently — two chunks in the SAME wave must NEVER touch the same file, new or pre-existing.>" })

### Loop 2 — PLAN REVIEW (review the chunk breakdown ONCE)
task({ name: "plan-critique", agent_type: "general-purpose", model: "claude-sonnet-5", reasoning_effort: "high", mode: "sync",
       description: "Critique the chunk plan",
       prompt: "CHUNK-PLAN CRITIQUE ONLY — do not write code. Review the plan against the planning rubric at ${PLANNING_DOC} (and ./PLANNING.md if present), the project's ./CONSTITUTION.md if present, AND the spec. Plan: <plan>. Confirm every entity and EVERY business rule maps to a chunk AND to a test inside that chunk, and that the plan fits the project's stack/constraints. For EVERY high-risk chunk, verify the plan PINS the exact formula, signature, rounding mode, tie-break, units, and boundary cases so the coder can TRANSCRIBE with zero open decisions; flag any high-risk chunk whose rule math is left to coder discretion as a BLOCKING plan gap. Flag every rubric or constitution violation: missing requirements, bad ordering, circular-import risk, unnamed seams/contracts, wrong stack/dependency choices, and any high-risk chunk that was not marked. THEN audit chunk SIZING on BOTH ends. TOO SMALL: any low-risk chunk that only adds a leaf utility, pure function, or single small file with no independent risk — name exactly which adjacent chunks to MERGE. TOO BIG: flag a chunk as oversized if ANY of these hold — it lists or needs more than one independent acceptance check; it spans more than one layer or concern; it bundles multiple spec rules that can fail independently; it mixes a HIGH-RISK unit with other work or combines two distinct risk surfaces; or its diff is too large to review in one sitting — for each, name the exact seam to SPLIT on. AUDIT WAVE SAFETY: for each wave, confirm its chunks depend only on EARLIER waves and own DISJOINT files; flag any same-wave shared-file collision (it WILL cause a merge conflict) and prescribe the repartition — split the shared file, add an auto-include seam, or move a chunk to a later wave. Give an explicit chunk-count assessment: are any chunks over-split (merge them) or any high-risk chunk under-split (split it)? Return concrete revisions." })
Then fold the critique into a FINAL chunk plan before any building.

### Build loop — process the plan WAVE BY WAVE, in order
The FINAL plan groups chunks into ordered WAVES. A wave's chunks are mutually
independent and own DISJOINT files, so they can build in parallel. Never start a wave
until every chunk in the previous wave is merged, green, and committed on YOUR
(coordinator) branch. Before each wave record <wave-base> = \`git rev-parse HEAD\`.

#### Width-1 wave (a single chunk) — build IN-PROCESS (cheap, no child session)
Run the task sub-agents directly on your own worktree:

  CODE (build the chunk) — Model: BUILDER ("gpt-5.3-codex"), every chunk regardless of risk.
  task({ name: "build-chunk", agent_type: "general-purpose", model: "gpt-5.3-codex", mode: "sync",
         description: "Build chunk <id>: <name>",
         prompt: "FIRST read the coding baseline at ${CODING_DOC} (and ./CODING.md at the repo root if it exists) and the project's ./CONSTITUTION.md at the repo root if present, and conform to both. Implement ONLY this chunk: <chunk>. Touch only its OWNED files plus their tests. INSTRUMENT AS YOU BUILD — diagnosability is part of 'done', not a follow-up: whenever you implement non-trivial control flow (error and early-return paths, branches, multi-step operations, or any call that crosses a service/process/network boundary) add structured logging in the SAME change so any failure is explainable from logs ALONE — without reading the code, eyeballing raw output, or correlating two processes by timestamp. Every non-success returned to a caller gets a server-side log line naming the machine reason; a cross-service call logs the callee's reason + correlation/request id, not just its status. Follow the target repo's OWN logging conventions (its structured logger, level meanings, and redaction rules) exactly as its baseline/constitution states them — be generous at its verbose/debug level; if the repo states no convention, say so in your chunk notes rather than inventing a divergent one. Do NOT instrument trivial pure functions. Commit per logical step with conventional-commit messages. Then run this chunk's acceptance check and report pass/fail. Earlier chunks are already built and committed — do NOT rebuild them. Final chunk plan for context: <final plan>" })

  CODE REVIEW (review THIS chunk's diff only) — Model: REVIEWER ("claude-sonnet-5", reasoning high; a DIFFERENT model family from the BUILDER, so it re-derives from spec rather than sharing the coder's blind spots).
  task({ name: "review-chunk", agent_type: "code-review", model: "claude-sonnet-5", reasoning_effort: "high", mode: "sync",
         description: "Review chunk <id>: <name>",
         prompt: "SPEC-CONFORMANCE REVIEW of ONLY this chunk's diff — \`git diff <wave-base>..HEAD\`. You are given THIS chunk's governing spec rule(s): <chunk spec rules>. For EACH rule, RE-DERIVE the expected behavior and concrete expected VALUES from the spec text YOURSELF — do NOT infer correctness from the code, and do NOT trust the chunk's own tests (they may be written by the same author and can encode the SAME mistake). Pick ADVERSARIAL / BOUNDARY inputs (half-cent rounding, free-shipping/threshold edges, off-by-one stock, empty/null, tie-breaks) and check the code's ACTUAL output against your spec-derived expectation. A rule IMPLEMENTED BUT DIVERGENT from the spec (wrong rounding mode, floor-vs-round, wrong tie-break, wrong unit) is BLOCKING even if every test passes. OBSERVABILITY GATE (a correctness check, NOT a style nit): ask 'if this code failed in production, could I determine WHY from the logs alone, or would I have to add logging and redeploy?' — REQUEST CHANGES if (a) a failure/early-return/error-to-caller path returns a non-success with no structured server-side log naming the reason for that request; (b) a new multi-step or cross-service/cross-process path has no trace coverage at the repo's verbose level; (c) a cross-service call logs only a bare status, not the callee's reason + correlation id; or (d) logging violates the repo's stated level or redaction rules (e.g. PII/secrets above the verbose level). A surface that returns an error while staying silent about WHY is a defect even when the status code is right; do NOT flag missing logging on trivial pure functions or where the repo's conventions don't call for it. ALSO check the coding baseline at ${CODING_DOC} (and ./CODING.md if present) and ./CONSTITUTION.md if present for bugs, races, and constitution violations. Run the chunk's tests, but treat GREEN as necessary-not-sufficient. List issues by severity with concrete fixes; treat security/correctness/spec-divergence/observability-gate/constitution violations as blocking." })
  If blocking issues: dispatch another CODE task to fix them, then re-review.
  Adaptive depth: a HIGH-RISK chunk is split into tasks and EACH task's diff is reviewed
  (same prompt scoped to <task-base>..HEAD); normal chunks get one review.

#### Width>1 wave (parallel chunks) — one CHILD SESSION per chunk
Spawn an isolated worker SESSION per chunk so they build concurrently, each in its own
worktree branched off YOUR branch:

  Read YOUR coordinator run id ONCE: \`cat .code-chain/latest.txt\` → <coord-run-id>; pass it
  to every child as PARENT_RUN=<coord-run-id> so each child's telemetry correlates back to
  this run. For each chunk in the wave:
  create_session({ project_id: "<THIS project's id>", base_branch: "<your current branch>",
     name: "cc W<wave> <id> · <short name>", notify_on_idle: "once", coordinate_with_creator: true,
     kickoff: { mode: "autopilot", model: "gpt-5.3-codex",
       prompt: "code-chain worker PARENT_RUN=<coord-run-id> — build EXACTLY ONE chunk and nothing else: <chunk>. Read the coding baseline at ${CODING_DOC} (and ./CODING.md if present) and ./CONSTITUTION.md if present; conform to both. Touch ONLY this chunk's OWNED files plus their tests — NEVER a file owned by another chunk. INSTRUMENT AS YOU BUILD — diagnosability is part of 'done': add structured logging in the SAME change for non-trivial control flow (error/early-return paths, branches, multi-step ops, cross-service/process boundaries) so any failure is explainable from logs ALONE — every non-success returned to a caller gets a server-side log line naming the machine reason, and a cross-service call logs the callee's reason + correlation id, not just status; follow the repo's OWN logging conventions/redaction rules (or note their absence). Commit per logical step (conventional commits). Run the chunk's acceptance check. THEN code-review your OWN diff \`git diff <wave-base>..HEAD\` with a SPEC-CONFORMANCE review: dispatch a code-review task with name \"review-chunk\" (the host REQUIRES the \`name\` field — a call without it is rejected with \`\\\"name\\\": Required\`), model \"claude-sonnet-5\" and reasoning_effort \"high\" — a DIFFERENT model family from you (the builder), so it re-derives from spec instead of sharing your blind spots. Hand the reviewer THIS chunk's spec rule(s) and instruct it to RE-DERIVE expected values from the spec, probe BOUNDARY inputs (half-cents, thresholds, off-by-one, tie-breaks), DISTRUST your own tests, treat any IMPLEMENTED-BUT-DIVERGENT rule as BLOCKING even when tests pass, AND apply the OBSERVABILITY GATE (request changes if a failure/error-to-caller path returns non-success with no structured log naming the reason, a multi-step/cross-service path lacks trace coverage at the repo's verbose level, a cross-service call logs only a bare status without callee reason + correlation id, or logging violates the repo's level/redaction rules — but not for trivial pure functions). FIX any blocking issue, re-reviewing until green; if this chunk is HIGH-RISK, review per task. Do NOT merge and do NOT touch other chunks' files. When green + committed, do BOTH of these as your FINAL steps so your coordinator can detect completion even if a message is missed: (1) write a sentinel at your worktree root — \`printf 'CHUNK <id> tests=<pass|fail> branch=%s\\n' \"\$(git rev-parse --abbrev-ref HEAD)\" > .cc-done\` (do NOT commit it); (2) send your coordinator EXACTLY this message: 'CHUNK <id> DONE branch=<your branch> tests=<pass|fail>'." } })
  Record each child's chunk id + branch (\`get_session\`). ALSO append each spawned child's
  branch (one per line) to \`.code-chain/latest/children.txt\` on YOUR worktree as you create
  it — this manifest lets the post-run token reconciler attribute child usage to this build
  reliably even when other builds run concurrently. E.g. per child:
  \`echo "<child-branch>" >> .code-chain/latest/children.txt\`.

  BARRIER — ACTIVELY POLL; do NOT simply end your turn waiting on inbound messages.
  Passively waiting for each child's DONE message can STALL the whole wave if a
  message fails to re-wake you (observed failure mode). Instead, drive a poll loop you
  control. Each child writes a sentinel file \`<child-worktree>/.cc-done\` as its FINAL
  step (its kickoff instructs this) in ADDITION to sending its DONE message. You hold
  every child's worktree path from \`get_session\`. Block on a bash loop until all
  sentinels exist, e.g.:

    for i in \$(seq 1 160); do n=0; for w in <child-wt-1> <child-wt-2> <child-wt-N>; do
      test -f "\$w/.cc-done" && n=\$((n+1)); done
      [ "\$n" -eq <N> ] && { echo ALL_DONE; break; }; sleep 15; done

  If the command times out before ALL_DONE, just run it again (it is idempotent) — keep
  polling, do NOT give up and do NOT merge early. Treat a child as ready only when its
  sentinel exists AND its branch has commits beyond <wave-base>. Read each child's DONE
  message (or its \`.cc-done\` contents) to confirm tests=pass; if a child reports
  tests=fail or never finishes, send it a corrective message and keep polling.

  MERGE-BACK — when ALL are ready, for each child branch in chunk-id order run on YOUR branch:
  \`git merge --no-ff <child-branch>\`. With clean file ownership these never conflict. If one
  DOES conflict, that is a file-ownership violation: resolve minimally (or dispatch a CODE fix
  task) and record it for the final report.

  INTEGRATION — after merging the whole wave, dispatch ONE cross-cutting review:
  task({ name: "integration-review", agent_type: "code-review", model: "claude-sonnet-5", reasoning_effort: "high", mode: "sync",
         description: "Integration review wave <n>",
         prompt: "Review the merged wave diff \`git diff <wave-base>..HEAD\` for CROSS-chunk breakage the isolated per-chunk reviews could not see: import/contract mismatches between chunks, duplicate or colliding registrations, and any spec rule that spans chunks. Run the FULL test suite. Treat security/correctness/contract breakage as blocking. ALSO do SPEC-CONFORMANCE on any rule that spans chunks: re-derive expected values from the spec, probe boundary inputs, and treat implemented-but-divergent (wrong rounding/tie-break/unit) as BLOCKING even if green. For EVERY HIGH-RISK chunk in this wave whose only prior review was a single self-review pass, RE-REVIEW its diff here — distrust the coder's tests." })
  Fix blocking issues with an in-process CODE task before starting the next wave.

#### Session naming convention (keep the tree readable)
- The COORDINATOR session (this one) carries "COORD" in its name.
- Each child worker session is named "cc W<wave> <id> · <short name>" (e.g. "cc W3 C06 · books"),
  so the WAVE is visible in the title. Children nest under the coordinator in the session tree,
  so you can watch each wave's chunks build live.

### Rules
- NEVER write plans or code yourself — every stage is a \`task\` sub-agent or a child session.
- Specify name + model + mode "sync" on every task call (the host REQUIRES \`name\` — a kebab label like plan-chunks/build-chunk/review-chunk — and rejects calls without it). Models are FIXED by ROLE: PLANNER="claude-opus-4.8" (medium), BUILDER="gpt-5.3-codex", REVIEWER="claude-sonnet-5" (high).
- Planning stages obey PLANNING; coding stages obey CODING; every stage also honors the target project's ./CONSTITUTION.md (stack/domain/invariants) when present. Project-root docs extend the baselines.
- Review per CHUNK by default, not per file. Escalate to per-task review ONLY for HIGH-RISK chunks.
- Do NOT anchor a chunk count in any prompt — let the work decide.
- A clean build does NOT imply correct code: review every chunk; treat dropped requirements / races as blocking.
- Models are assigned by STAGE/ROLE, NEVER by chunk: the BUILDER (gpt-5.3-codex) writes every chunk; the REVIEWER (claude-sonnet-5 high) reviews every chunk and integration. Builder and reviewer are DIFFERENT model families on purpose (decorrelation — the reviewer re-derives from spec). Chunk RISK tunes only plan-blueprint detail and review depth (per-task vs per-chunk), not model choice.
- Reviews are SPEC-CONFORMANCE, not just test-runs: the reviewer is given the chunk's spec rules, RE-DERIVES expected values from the spec, probes boundary inputs, DISTRUSTS the coder's own tests, and treats an implemented-but-spec-divergent rule (wrong rounding, tie-break, unit) as BLOCKING even when all tests pass.
- For every HIGH-RISK chunk the PLAN must be a transcribe-ready blueprint (exact formula, signature, rounding mode, tie-break, boundary cases); the coder makes NO design decision on a high-risk rule.
- Process the plan WAVE BY WAVE. Each wave must be merged + green + committed on your branch before the next wave starts. Width-1 waves build IN-PROCESS via task; width>1 waves spawn one CHILD SESSION per chunk and merge back, then get one integration review.
- Child worker sessions must touch ONLY their chunk's OWNED files and must NOT merge — the coordinator owns all merges. Name them "cc W<wave> <id> · <short name>" (wave number in the title); keep "COORD" in your own name. Each child's kickoff prompt MUST begin with the literal token "code-chain worker PARENT_RUN=<coord-run-id>" so the worker trigger fires and telemetry correlates.
- After the LAST wave, read .code-chain/metrics.csv and report per-stage AND per-chunk/per-wave token cost, total cost, plus a short quality summary. Child-session stages log to their OWN worktree's .code-chain/ — aggregate them from each child's reported result (and, if needed, by reading each child worktree's metrics.csv). NOTE: metrics.csv tokens are CHAR-COUNT ESTIMATES (host exposes prompt/response length, not real tokens; reasoning tokens are excluded). For REAL billed usage (per-model input/cache/output/reasoning tokens + AIU, reasoning included), run the post-run reconciler — it reads each session's on-disk shutdown modelMetrics:
  \`node .github/extensions/code-chain/reconcile-tokens.mjs --cwd <coordinator-worktree>\`
  Width-1 runs are fully captured by the coordinator session alone. For wave-parallel runs, child usage is auto-included from \`.code-chain/latest/children.txt\` (written during spawn); otherwise pass \`--child <branch>\` per worker or \`--auto-children\` (time-window heuristic, unsafe under concurrent builds). The reconciler must run AFTER all sessions have shut down (a session cannot read its own shutdown metrics).

### Benchmarking builders
To compare builders, vary ONLY the CODE stage's \`model\` and keep PLAN, PLAN_REVIEW,
and CODE_REVIEW constant — so planning and review quality stay fixed while you measure
the coder. Every stage's per-chunk tokens land in .code-chain/metrics.csv for comparison.
`;

// Injected into a CHILD WORKER session (one spawned per chunk in a width>1 wave). Unlike
// SKILL_CONTEXT this does NOT make the session a coordinator — it builds exactly one chunk,
// records its own stage telemetry, and reports back. Engaged when a prompt starts with
// "code-chain worker" (checked BEFORE the coordinator trigger).
const WORKER_CONTEXT = `
## Code Chain — WORKER (build ONE chunk; you are NOT a coordinator)
You are a code-chain WORKER session. Do EXACTLY what your kickoff prompt assigns: build the
ONE chunk it names and nothing else. You are NOT a coordinator — do NOT plan, do NOT break
work into waves, do NOT spawn sub-sessions, do NOT merge.
- Read the coding baseline at ${CODING_DOC} (and ./CODING.md at the repo root if present) and
  the project's ./CONSTITUTION.md if present; conform to both.
- Touch ONLY the files your chunk OWNS, plus their tests — never a file owned by another chunk.
- Commit per logical step with conventional-commit messages.
- Run your chunk's acceptance check; then code-review your OWN diff and FIX blocking issues
  until green, using the models named in your kickoff. HIGH-RISK chunk → review per task.
- When green + committed, report back to your coordinator EXACTLY as your kickoff instructs.
  As your FINAL steps ALSO write a sentinel file at your worktree root so the coordinator
  can detect completion by polling even if your message is missed: \`printf 'CHUNK <id>
  tests=<pass|fail> branch=%s\\n' "\$(git rev-parse --abbrev-ref HEAD)" > .cc-done\` (do NOT
  commit it), THEN send your DONE message.
Every CODE/REVIEW step is still a \`task\` sub-agent, so this worker session's .code-chain/
records its own stage telemetry (correlated to the parent run via PARENT_RUN).
`;

// Scope arbitration: a project-scope copy of code-chain (vendored in the active
// project's .github/extensions/code-chain/) always WINS over the user/global install.
// Without this, both copies load in the dev repo and every hook fires twice — doubled
// telemetry and a SKILL_CONTEXT injected twice. So if THIS instance does not live
// inside the active project yet a project-scope copy is present there, this instance
// yields: it registers its hooks but every hook no-ops, writing nothing and injecting
// nothing. Decided once per session and cached.
let YIELDED = null;
function shouldYield(workingDirectory) {
  if (YIELDED !== null) return YIELDED;
  try {
    const wd = workingDirectory || process.cwd();
    const projectExt = join(wd, ".github", "extensions", "code-chain");
    const inRepo = EXT_DIR === projectExt || EXT_DIR.startsWith(wd + "/");
    YIELDED = !inRepo && existsSync(projectExt);
  } catch (e) {
    YIELDED = false;
  }
  return YIELDED;
}

const session = await joinSession({
  tools: [],
  hooks: {
    onSessionStart: async (input) => {
      if (shouldYield(input && input.workingDirectory)) return;
      const dir = runDir(input && input.workingDirectory);
      debug(dir, `extension loaded. run=${RUN_ID} workingDirectory=${input && input.workingDirectory} cwd=${process.cwd()}`);
      timeline(dir, "SESSION", `start run=${RUN_ID} wd=${input && input.workingDirectory}`);
      await session.log(`🔗 Code Chain loaded — run ${RUN_ID} → .code-chain/runs/${RUN_ID}/`);
    },
    onUserPromptSubmitted: async (input) => {
      if (shouldYield(input && input.workingDirectory)) return;
      // Explicit, legible kickoff: engage ONLY when the prompt STARTS with the
      // word "code-chain" (also "code chain" / "codechain"), optionally followed
      // by a colon — e.g. `code-chain: build the API in specs/foo.md`. Anchoring
      // to the start means merely *mentioning* code-chain (as in this dev/harness
      // repo, where it comes up constantly) does NOT inject the coordinator
      // playbook — only a deliberate command does.
      const prompt = input.prompt || "";
      const promptLower = prompt.toLowerCase();
      // WORKER mode (checked FIRST): a child build session. Detected by the marker
      // "code-chain worker" OR a "PARENT_RUN=" tag appearing ANYWHERE in the prompt — NOT
      // anchored to the start. Reason (confirmed empirically): a child created with
      // coordinate_with_creator:true has a parent-identity/reply WRAPPER prepended to its
      // kickoff, so even though the coordinator authors the child prompt to BEGIN with
      // "code-chain worker PARENT_RUN=...", the runtime shifts that token off position 0 and
      // anchored matching (v9/v11) missed real workers. Un-anchored survives the wrapper.
      // The v10 failure (coordinator self-tripping because its kickoff *describes* the worker
      // protocol) is avoided by keeping these tokens OUT of the coordinator's own kickoff;
      // SKILL_CONTEXT carries the child-prompt template as injected context, which never
      // reaches this trigger. Engage as a single-chunk worker — NOT a coordinator — and record
      // telemetry, stamping the parent run id so this child correlates back to it.
      if (/\bcode[-\s]?chain\s+worker\b/.test(promptLower) || /parent_run=/.test(promptLower)) {
        try {
          const dir = runDir(input && input.workingDirectory);
          const m = prompt.match(/PARENT_RUN=(\S+)/);
          if (m) {
            try { writeFileSync(join(dir, "parent.txt"), m[1] + "\n"); } catch (e) { /* ignore */ }
          }
          timeline(dir, "WORKER", `engaged run=${RUN_ID} parent=${m ? m[1] : "?"}`);
          await session.log(
            `🔧 code-chain WORKER — building one chunk; telemetry → .code-chain/runs/${RUN_ID}/ (parent=${m ? m[1] : "?"})`
          );
        } catch (e) {
          // ignore
        }
        return { additionalContext: WORKER_CONTEXT };
      }
      if (/^\s*code[-\s]?chain\b:?/.test(promptLower)) {
        try {
          await session.log(
            "🔗 code-chain engaged — this session is now the COORDINATOR (PLAN → PLAN REVIEW → [CODE → REVIEW → FIX] per chunk/wave). Stages run as `task` sub-agents; telemetry → .code-chain/."
          );
        } catch (e) {
          // ignore
        }
        return { additionalContext: SKILL_CONTEXT };
      }
    },
    onPostToolUse: async (input) => {
      if (shouldYield(input && input.workingDirectory)) return;
      if (input.toolName === "task") {
        captureTaskCall(runDir(input.workingDirectory), input.toolArgs, input.toolResult, true);
      }
    },
    onPostToolUseFailure: async (input) => {
      if (shouldYield(input && input.workingDirectory)) return;
      if (input.toolName === "task") {
        captureTaskCall(runDir(input.workingDirectory), input.toolArgs, { error: safeStr(input.error) }, false);
      }
    },
  },
});
