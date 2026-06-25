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
// read these directly; a project may add its own ./PLANNING.md or ./CODING.md to extend.
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PLANNING_DOC = join(EXT_DIR, "PLANNING.md");
const CODING_DOC = join(EXT_DIR, "CODING.md");

const SKILL_CONTEXT = `
## Code Chain Workflow (chunked: plan → plan-review → [code → review → fix] per chunk)

You are a COORDINATOR. You NEVER write plans or code yourself. You orchestrate
sub-agents, each spawned with the \`task\` tool run SYNCHRONOUSLY (mode: "sync") so the
full result returns inline AND the pipeline logger captures each stage's content +
token cost to .code-chain/.

The spec is broken into CHUNKS up front, reviewed ONCE, then each chunk is built,
reviewed, and fixed in its own short loop before the next chunk starts. Review depth is
per-CHUNK by default — only HIGH-RISK chunks get deeper per-task review.

### House rules (two baseline docs ship with code-chain)
- PLANNING — tenets of a good plan — ${PLANNING_DOC}
- CODING — the code/quality baseline — ${CODING_DOC}
Planning stages build to / review against PLANNING; coding stages conform to / review
against CODING. Each sub-agent reads the doc itself — pass the path in its prompt (below).
If the target project has its own ./PLANNING.md or ./CODING.md at its repo root, read that
too — project docs EXTEND, never relax, the baselines.

Specify the \`model\` on EVERY task call. Default to "claude-sonnet-4.6" for every
stage; raise an individual stage to a stronger model only when it clearly warrants it.
Use the exact \`description\` strings below — the logger classifies stages from them.

### Loop 1 — PLAN (spec → chunks)
task({ agent_type: "general-purpose", model: "claude-sonnet-4.6", mode: "sync",
       description: "Plan build chunks",
       prompt: "FIRST read the planning rubric at ${PLANNING_DOC} (and ./PLANNING.md at the repo root if it exists) and produce a plan that satisfies every tenet. <Break the task into the natural number of CHUNKS. A chunk is the smallest unit of work that leaves the tree GREEN (compiles + its own tests pass) and is independently committable. For each chunk give: an ordered id/name, the files it touches, a one-line acceptance check (the test or command that proves it green), the spec rule(s) it satisfies, and its dependencies on earlier chunks. Order chunks so each builds only on earlier ones. Mark any chunk that is HIGH-RISK (security boundary, auth, money/coupon/discount math, data migration, concurrency) — these get deeper per-task review later. Do NOT state a target number of chunks.>" })

### Loop 2 — PLAN REVIEW (review the chunk breakdown ONCE)
task({ agent_type: "general-purpose", model: "claude-sonnet-4.6", mode: "sync",
       description: "Critique the chunk plan",
       prompt: "CHUNK-PLAN CRITIQUE ONLY — do not write code. Review the plan against the planning rubric at ${PLANNING_DOC} (and ./PLANNING.md if present) AND the spec. Plan: <plan>. Confirm every entity and EVERY business rule maps to a chunk AND to a test inside that chunk. Flag every rubric violation: missing requirements, bad ordering, circular-import risk, chunks too large to stay green in one pass, chunks bundling unrelated work, unnamed seams/contracts, and any high-risk chunk that was not marked. Return concrete revisions." })
Then fold the critique into a FINAL chunk plan before any building.

### Per-chunk loop — run CODE → CODE REVIEW → (FIX) for EACH chunk, in order
Do NOT start a chunk until the previous one is green and committed.
Before each chunk's CODE, record the current HEAD sha (\`git rev-parse HEAD\`) as
<chunk-base> so the review can diff exactly that chunk.

  #### CODE (build ONE chunk)
  task({ agent_type: "general-purpose", model: "claude-sonnet-4.6", mode: "sync",
         description: "Build chunk <id>: <name>",
         prompt: "FIRST read the coding baseline at ${CODING_DOC} (and ./CODING.md at the repo root if it exists) and conform to it. Implement ONLY this chunk: <chunk>. Touch only its listed files plus their tests. Commit per logical step with conventional-commit messages. Then run this chunk's acceptance check and report pass/fail. Earlier chunks are already built and committed — do NOT rebuild them. Final chunk plan for context: <final plan>" })

  #### CODE REVIEW (review THIS chunk's diff only)
  task({ agent_type: "code-review", model: "claude-sonnet-4.6", mode: "sync",
         description: "Review chunk <id>: <name>",
         prompt: "Review ONLY this chunk's diff — \`git diff <chunk-base>..HEAD\` — against the coding baseline at ${CODING_DOC} (and ./CODING.md if present). Look for bugs, logic errors, races, baseline violations, and any requirement for THIS chunk that was dropped or under-implemented. Run the chunk's tests. List issues by severity with concrete fixes; treat security/correctness violations as blocking." })
  If blocking issues: dispatch another CODE task to fix them, then re-review.

  #### Adaptive depth
  For a chunk marked HIGH-RISK, split it into tasks and review EACH task's diff (same
  CODE REVIEW prompt scoped to that task's <task-base>..HEAD). For normal chunks, one
  review per chunk is enough — do NOT review every file separately.

### Rules
- NEVER write plans or code yourself — every stage is a \`task\` sub-agent.
- Specify model + mode "sync" on every task call. Default model "claude-sonnet-4.6".
- Planning stages obey PLANNING; coding stages obey CODING. Project-root docs extend the baselines.
- Review per CHUNK by default, not per file. Escalate to per-task review ONLY for HIGH-RISK chunks.
- Do NOT anchor a chunk count in any prompt — let the work decide.
- A clean build does NOT imply correct code: review every chunk; treat dropped requirements / races as blocking.
- Each chunk must be green + committed before the next chunk starts.
- After the LAST chunk, read .code-chain/metrics.csv and report per-stage AND per-chunk token cost, total cost, plus a short quality summary.

### Benchmarking builders
To compare builders, vary ONLY the CODE stage's \`model\` and keep PLAN, PLAN_REVIEW,
and CODE_REVIEW constant — so planning and review quality stay fixed while you measure
the coder. Every stage's per-chunk tokens land in .code-chain/metrics.csv for comparison.
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
      const triggers = ["build", "create", "implement", "make", "add", "refactor", "fix"];
      const promptLower = input.prompt.toLowerCase();
      if (triggers.some((t) => promptLower.includes(t))) {
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
