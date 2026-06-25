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

// Pull model / agent_id / exec_mode / any real metrics out of a task tool result.
function extractTelemetry(rawResult) {
  const t = { model: "", agentId: "", agentType: "", execMode: "", metrics: null };
  try {
    const tel = rawResult && rawResult.toolTelemetry;
    if (tel) {
      const p = tel.properties || {};
      t.model = p.model || "";
      t.agentType = p.agent_type || p.agent_name || "";
      t.execMode = p.execution_mode || "";
      const rp = tel.restrictedProperties || {};
      t.agentId = rp.agent_id || "";
      if (tel.metrics && Object.keys(tel.metrics).length) t.metrics = tel.metrics;
    }
  } catch (e) {
    // ignore
  }
  return t;
}

// Classify a task call into one of the four pipeline stages from naming signals.
// The skill instructs the coordinator to use clear `description` strings so this
// is reliable (PLAN / PLAN_REVIEW / CODE / CODE_REVIEW).
function classifyStage({ agentType, description, agentId, prompt }) {
  const hay = `${description} ${agentId} ${agentType} ${String(prompt).slice(0, 200)}`.toLowerCase();
  const isReview = /review|critique/.test(hay);
  const isPlan = /plan/.test(hay);
  const isCode = /code|coder|coding|build|implement|write the/.test(hay);
  if (isPlan && isReview) return "PLAN_REVIEW";
  if (isPlan) return "PLAN";
  if (isReview) return "CODE_REVIEW";
  if (isCode) return "CODE";
  return "TASK";
}

// Per-process ordering counters (reset on extension reload; timestamps still order
// events across reloads).
let SEQ = 0;
let LAST_TS = Date.now();

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
    const description = args.description || "";
    const prompt = safeStr(args.prompt);
    const resultText = safeStr(rawResult);
    const ts = new Date().toISOString();

    const stage = classifyStage({ agentType, description, agentId: tel.agentId, prompt });
    const promptTok = estTokens(prompt);
    const resultTok = estTokens(resultText);
    const isReview = stage === "PLAN_REVIEW" || stage === "CODE_REVIEW";
    const named = isReview ? "review.md" : "plan.md";

    const block =
      `# ${stage} — ${ts}\n\n` +
      `- stage: ${stage}\n- model: ${model}\n- agent_type: ${agentType}\n` +
      `- agent_id: ${tel.agentId || "(n/a)"}\n- exec_mode: ${tel.execMode || "(n/a)"}\n` +
      `- description: ${description}\n- status: ${ok ? "success" : "FAILURE"}\n` +
      `- prompt_tokens_est: ${promptTok}\n- result_tokens_est: ${resultTok}\n` +
      (tel.metrics ? `- metrics: ${safeStr(tel.metrics)}\n` : "") +
      `\n## Prompt sent to sub-agent\n\n\`\`\`\n${prompt}\n\`\`\`\n\n` +
      `## Sub-agent result\n\n${resultText}\n`;

    writeFileSync(join(dir, named), block);
    appendFileSync(join(dir, "events.log"), `\n${"=".repeat(80)}\n${block}`);
    timeline(dir, stage, `model=${model} exec=${tel.execMode || "?"} ptok~${promptTok} rtok~${resultTok} status=${ok ? "ok" : "FAIL"} desc="${description}"`);
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

Specify the \`model\` on EVERY task call. Default to "claude-sonnet-4.6" for every
stage; raise an individual stage to a stronger model only when it clearly warrants it.
Use the exact \`description\` strings below — the logger classifies stages from them.

### Loop 1 — PLAN (spec → chunks)
task({ agent_type: "general-purpose", model: "claude-sonnet-4.6", mode: "sync",
       description: "Plan build chunks",
       prompt: "FIRST read the planning rubric at ${PLANNING_DOC} (and ./PLANNING.md at the repo root if it exists), and read ./CONSTITUTION.md at the repo root if present to learn the project's tech stack, architecture invariants, and domain constraints. Produce a plan that satisfies every PLANNING tenet AND fits the project's stack/constraints. <Break the task into the FEWEST CHUNKS that still build cleanly. SIZE EACH CHUNK BY RISK, NOT BY FILE. A chunk should be as LARGE as it can be while still (a) leaving the tree GREEN (compiles + its own tests pass), (b) being independently committable, and (c) reviewable in one pass with exactly ONE acceptance check. Do NOT give a leaf utility, pure-function, or single small low-risk file its own chunk — fold low-risk, same-layer, mutually-independent units together into one coherent chunk. CONVERSELY, HIGH-RISK units (security boundary, auth, money/coupon/discount math, data migration, concurrency, idempotency, state machines) get their OWN chunk and may be split FINER so each earns deep review; never bundle a high-risk unit with other work or combine two distinct risk surfaces. For each chunk give: an ordered id/name, the files it touches, a one-line acceptance check (the single test or command that proves it green), the spec rule(s) it satisfies, and its dependencies on earlier chunks. Order chunks so each builds only on earlier ones. Mark HIGH-RISK chunks. Do NOT state a target number of chunks — but prefer consolidation: if two adjacent low-risk chunks could be reviewed together without losing clarity, make them one. THEN compute the dependency graph and GROUP the chunks into ordered WAVES: a wave is a set of chunks that depend ONLY on chunks in EARLIER waves AND touch DISJOINT files, so a wave's chunks can be built in parallel and merged without conflict. Give every chunk an EXCLUSIVE set of OWNED files — no two chunks (especially within the same wave) may write the same file. Engineer this by structure: per-entity model modules, ONE router/module file per chunk, and an auto-include/registration seam so chunks never co-edit a shared app/models/router-registry file; if such shared scaffold is unavoidable, create it ONCE in an early width-1 wave that later waves only import (never edit). Present the plan as ordered WAVES (Wave 1, Wave 2, ...), each listing its chunks (a wave may hold a single chunk), and for each chunk list its OWNED files explicitly. EXPLICITLY name any SHARED or SCAFFOLD files (app entrypoint, models/router registry, conftest, dependency manifest, central config) and the SINGLE Wave-1 chunk that owns each, plus the auto-discovery/registration pattern that lets later chunks add behavior WITHOUT editing those shared files. For an EXISTING (non-greenfield) project, FIRST inspect the current layout: identify every pre-existing file that more than one chunk would need to modify, and either (a) repartition the work so each chunk owns a distinct file or region, or (b) place the colliding chunks in DIFFERENT waves so they never edit that file concurrently — two chunks in the SAME wave must NEVER touch the same file, new or pre-existing.>" })

### Loop 2 — PLAN REVIEW (review the chunk breakdown ONCE)
task({ agent_type: "general-purpose", model: "claude-sonnet-4.6", mode: "sync",
       description: "Critique the chunk plan",
       prompt: "CHUNK-PLAN CRITIQUE ONLY — do not write code. Review the plan against the planning rubric at ${PLANNING_DOC} (and ./PLANNING.md if present), the project's ./CONSTITUTION.md if present, AND the spec. Plan: <plan>. Confirm every entity and EVERY business rule maps to a chunk AND to a test inside that chunk, and that the plan fits the project's stack/constraints. Flag every rubric or constitution violation: missing requirements, bad ordering, circular-import risk, unnamed seams/contracts, wrong stack/dependency choices, and any high-risk chunk that was not marked. THEN audit chunk SIZING on BOTH ends. TOO SMALL: any low-risk chunk that only adds a leaf utility, pure function, or single small file with no independent risk — name exactly which adjacent chunks to MERGE. TOO BIG: flag a chunk as oversized if ANY of these hold — it lists or needs more than one independent acceptance check; it spans more than one layer or concern; it bundles multiple spec rules that can fail independently; it mixes a HIGH-RISK unit with other work or combines two distinct risk surfaces; or its diff is too large to review in one sitting — for each, name the exact seam to SPLIT on. AUDIT WAVE SAFETY: for each wave, confirm its chunks depend only on EARLIER waves and own DISJOINT files; flag any same-wave shared-file collision (it WILL cause a merge conflict) and prescribe the repartition — split the shared file, add an auto-include seam, or move a chunk to a later wave. Give an explicit chunk-count assessment: are any chunks over-split (merge them) or any high-risk chunk under-split (split it)? Return concrete revisions." })
Then fold the critique into a FINAL chunk plan before any building.

### Build loop — process the plan WAVE BY WAVE, in order
The FINAL plan groups chunks into ordered WAVES. A wave's chunks are mutually
independent and own DISJOINT files, so they can build in parallel. Never start a wave
until every chunk in the previous wave is merged, green, and committed on YOUR
(coordinator) branch. Before each wave record <wave-base> = \`git rev-parse HEAD\`.

#### Width-1 wave (a single chunk) — build IN-PROCESS (cheap, no child session)
Run the task sub-agents directly on your own worktree:

  CODE (build the chunk)
  task({ agent_type: "general-purpose", model: "claude-sonnet-4.6", mode: "sync",
         description: "Build chunk <id>: <name>",
         prompt: "FIRST read the coding baseline at ${CODING_DOC} (and ./CODING.md at the repo root if it exists) and the project's ./CONSTITUTION.md at the repo root if present, and conform to both. Implement ONLY this chunk: <chunk>. Touch only its OWNED files plus their tests. Commit per logical step with conventional-commit messages. Then run this chunk's acceptance check and report pass/fail. Earlier chunks are already built and committed — do NOT rebuild them. Final chunk plan for context: <final plan>" })

  CODE REVIEW (review THIS chunk's diff only)
  task({ agent_type: "code-review", model: "claude-sonnet-4.6", mode: "sync",
         description: "Review chunk <id>: <name>",
         prompt: "Review ONLY this chunk's diff — \`git diff <wave-base>..HEAD\` — against the coding baseline at ${CODING_DOC} (and ./CODING.md if present) and the project's ./CONSTITUTION.md if present. Look for bugs, logic errors, races, baseline/constitution violations, and any requirement for THIS chunk that was dropped or under-implemented. Run the chunk's tests. List issues by severity with concrete fixes; treat security/correctness/constitution violations as blocking." })
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
     kickoff: { mode: "autopilot", model: "claude-sonnet-4.6",
       prompt: "code-chain worker PARENT_RUN=<coord-run-id> — build EXACTLY ONE chunk and nothing else: <chunk>. Read the coding baseline at ${CODING_DOC} (and ./CODING.md if present) and ./CONSTITUTION.md if present; conform to both. Touch ONLY this chunk's OWNED files plus their tests — NEVER a file owned by another chunk. Commit per logical step (conventional commits). Run the chunk's acceptance check. THEN code-review your OWN diff \`git diff <wave-base>..HEAD\` (dispatch a code-review task, model gpt-5.4-mini) and FIX any blocking issue, re-reviewing until green; if this chunk is HIGH-RISK, review per task. Do NOT merge and do NOT touch other chunks' files. When green + committed, send your coordinator EXACTLY this message: 'CHUNK <id> DONE branch=<your branch> tests=<pass|fail>'." } })
  Record each child's chunk id + branch (\`get_session\`).

  BARRIER — wait for the whole wave. End your turn; each child reports via message (and an
  idle notification). On every wake, count how many of THIS wave's chunks have reported
  DONE. If not all, wait again. Do NOT merge anything until ALL wave chunks are DONE.

  MERGE-BACK — when all are DONE, for each child branch in chunk-id order run on YOUR branch:
  \`git merge --no-ff <child-branch>\`. With clean file ownership these never conflict. If one
  DOES conflict, that is a file-ownership violation: resolve minimally (or dispatch a CODE fix
  task) and record it for the final report.

  INTEGRATION — after merging the whole wave, dispatch ONE cross-cutting review:
  task({ agent_type: "code-review", model: "claude-sonnet-4.6", mode: "sync",
         description: "Integration review wave <n>",
         prompt: "Review the merged wave diff \`git diff <wave-base>..HEAD\` for CROSS-chunk breakage the isolated per-chunk reviews could not see: import/contract mismatches between chunks, duplicate or colliding registrations, and any spec rule that spans chunks. Run the FULL test suite. Treat security/correctness/contract breakage as blocking." })
  Fix blocking issues with an in-process CODE task before starting the next wave.

#### Session naming convention (keep the tree readable)
- The COORDINATOR session (this one) carries "COORD" in its name.
- Each child worker session is named "cc W<wave> <id> · <short name>" (e.g. "cc W3 C06 · books"),
  so the WAVE is visible in the title. Children nest under the coordinator in the session tree,
  so you can watch each wave's chunks build live.

### Rules
- NEVER write plans or code yourself — every stage is a \`task\` sub-agent or a child session.
- Specify model + mode "sync" on every task call. Default model "claude-sonnet-4.6".
- Planning stages obey PLANNING; coding stages obey CODING; every stage also honors the target project's ./CONSTITUTION.md (stack/domain/invariants) when present. Project-root docs extend the baselines.
- Review per CHUNK by default, not per file. Escalate to per-task review ONLY for HIGH-RISK chunks.
- Do NOT anchor a chunk count in any prompt — let the work decide.
- A clean build does NOT imply correct code: review every chunk; treat dropped requirements / races as blocking.
- Process the plan WAVE BY WAVE. Each wave must be merged + green + committed on your branch before the next wave starts. Width-1 waves build IN-PROCESS via task; width>1 waves spawn one CHILD SESSION per chunk and merge back, then get one integration review.
- Child worker sessions must touch ONLY their chunk's OWNED files and must NOT merge — the coordinator owns all merges. Name them "cc W<wave> <id> · <short name>" (wave number in the title); keep "COORD" in your own name. Each child's kickoff prompt MUST begin with the literal token "code-chain worker PARENT_RUN=<coord-run-id>" so the worker trigger fires and telemetry correlates.
- After the LAST wave, read .code-chain/metrics.csv and report per-stage AND per-chunk/per-wave token cost, total cost, plus a short quality summary. Child-session stages log to their OWN worktree's .code-chain/ — aggregate them from each child's reported result (and, if needed, by reading each child worktree's metrics.csv).

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
      // WORKER mode (checked FIRST): a child build session whose prompt STARTS with
      // "code-chain worker". Anchoring to the start is deliberate: a COORDINATOR prompt
      // often *describes* the worker protocol (mentions "code-chain worker" / "PARENT_RUN=")
      // in its instructions, so any whole-prompt scan would misclassify the coordinator as a
      // worker (v10 bug) and suppress child spawning. The coordinator MUST author each child
      // kickoff to BEGIN with "code-chain worker PARENT_RUN=<coord-run-id>" verbatim, so this
      // anchored match fires. Engage as a single-chunk worker — NOT a coordinator — and record
      // telemetry, stamping the parent run id so this child correlates back to it.
      if (/^\s*code[-\s]?chain\s+worker\b/.test(promptLower)) {
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
