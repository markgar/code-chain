#!/usr/bin/env node
// reconcile-tokens.mjs — post-run REAL token/cost reconciliation for a code-chain build.
//
// WHY: the live Copilot hooks the code-chain extension uses do NOT expose real provider
// token usage (toolTelemetry.metrics is empty), so the in-run ledger (.code-chain/) only
// has char/4 ESTIMATES and cannot see reasoning tokens. The host DOES, however, write the
// real per-model usage to each session's local event log at shutdown:
//   ~/.copilot/session-state/<sessionId>/events.jsonl  ->  {type:"session.shutdown"}.data.modelMetrics
// modelMetrics is keyed by model and carries the ground truth:
//   usage.{inputTokens,cacheReadTokens,cacheWriteTokens,outputTokens,reasoningTokens}
//   requests.count, totalNanoAiu  (nanoAIU = the platform's real billing unit; /1e9 = AIU)
//
// This script reads those shutdown events directly off disk (no cloud-sync lag, no MCP),
// finds the coordinator session for a build and any wave-parallel CHILD sessions that ran
// during its lifespan, and aggregates the real numbers per model. In-process pipeline
// stages (PLAN / PLAN_REVIEW / CODE / CODE_REVIEW / FIX dispatched as `task` sub-agents)
// all bill UNDER the coordinator session, so a width-1 run is fully captured by one file;
// only parallel child build sessions need separate aggregation.
//
// USAGE (run after a build completes — children must have shut down):
//   node reconcile-tokens.mjs                 # coordinator = current working directory
//   node reconcile-tokens.mjs --cwd <worktree>
//   node reconcile-tokens.mjs --branch <coordinator-branch>
//   node reconcile-tokens.mjs --child <branch> [--child <branch> ...]   # force-include children
//   node reconcile-tokens.mjs --auto-children # discover children by time-window (UNSAFE if
//                                             # other builds ran concurrently; prints a caveat)
//   node reconcile-tokens.mjs --no-children   # coordinator only
//   node reconcile-tokens.mjs --json          # machine-readable dump to stdout
//
// Children are included reliably from the coordinator's manifest
// .code-chain/latest/children.txt (one branch per line, written during spawn) plus any
// --child branches. Time-window auto-discovery is opt-in (--auto-children) because branches
// get reused and independent builds may overlap in time.
//
// Writes <coordinator-worktree>/.code-chain/latest/token-ledger.{md,csv} when that dir
// exists, and always prints a summary to stdout.

import { readFileSync, readdirSync, existsSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const STATE_DIR = join(homedir(), ".copilot", "session-state");

function parseArgs(argv) {
  const a = { autoChildren: false, json: false, child: [] };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--auto-children") a.autoChildren = true;
    else if (v === "--no-children") a.noChildren = true;
    else if (v === "--json") a.json = true;
    else if (v === "--cwd") a.cwd = argv[++i];
    else if (v === "--branch") a.branch = argv[++i];
    else if (v === "--child") a.child.push(argv[++i]);
    else if (v === "--out") a.out = argv[++i];
  }
  return a;
}

// A coordinator may record the child build branches it spawned in a manifest under its
// flight-recorder dir. One branch per line (txt) or a JSON array. This is the reliable,
// concurrency-safe way to know which sessions belong to THIS run (time-overlap alone is
// not safe when independent builds run in parallel, and branch names get reused).
function readChildManifest(coordCwd) {
  const base = join(coordCwd, ".code-chain", "latest");
  for (const name of ["children.txt", "children.json"]) {
    const f = join(base, name);
    if (!existsSync(f)) continue;
    try {
      const raw = readFileSync(f, "utf8").trim();
      if (name.endsWith(".json")) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.map((x) => (typeof x === "string" ? x : x.branch)).filter(Boolean);
      } else {
        return raw.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
      }
    } catch { /* ignore */ }
  }
  return [];
}

function safeRealpath(p) {
  try { return realpathSync(p); } catch { return p; }
}

// Read just the first JSON line (session.start) for cheap metadata.
function readStart(file) {
  try {
    const fd = readFileSync(file, "utf8");
    const nl = fd.indexOf("\n");
    const first = nl === -1 ? fd : fd.slice(0, nl);
    const e = JSON.parse(first);
    if (e && e.type === "session.start") return e;
    // Fallback: scan a few lines for session.start.
    for (const line of fd.split("\n").slice(0, 10)) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.type === "session.start") return o;
    }
  } catch { /* ignore */ }
  return null;
}

// Scan from the end for the session.shutdown event with modelMetrics.
function readShutdown(file) {
  try {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const ln = lines[i];
      if (!ln || ln.indexOf("session.shutdown") === -1) continue;
      const e = JSON.parse(ln);
      if (e.type === "session.shutdown" && e.data && e.data.modelMetrics) return e;
    }
  } catch { /* ignore */ }
  return null;
}

// Enumerate every local session with start metadata (+ shutdown if present).
function loadSessions() {
  let ids = [];
  try { ids = readdirSync(STATE_DIR); } catch { return []; }
  const out = [];
  for (const id of ids) {
    const file = join(STATE_DIR, id, "events.jsonl");
    if (!existsSync(file)) continue;
    const start = readStart(file);
    if (!start) continue;
    const ctx = (start.data && start.data.context) || {};
    out.push({
      id,
      file,
      cwd: ctx.cwd ? safeRealpath(ctx.cwd) : "",
      branch: ctx.branch || "",
      repository: ctx.repository || "",
      selectedModel: start.data.selectedModel || "",
      startTime: Date.parse(start.data.startTime || start.timestamp || 0) || 0,
    });
  }
  return out;
}

function metricsOf(sess) {
  const sd = readShutdown(sess.file);
  if (!sd) return null;
  return { modelMetrics: sd.data.modelMetrics, shutdownTime: Date.parse(sd.timestamp || 0) || 0 };
}

const ZERO = () => ({ requests: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, nanoAiu: 0 });

function addModelMetrics(acc, modelMetrics) {
  for (const [model, v] of Object.entries(modelMetrics || {})) {
    const u = v.usage || {};
    if (!acc[model]) acc[model] = ZERO();
    const m = acc[model];
    m.requests += (v.requests && v.requests.count) || 0;
    m.inputTokens += u.inputTokens || 0;
    m.cacheReadTokens += u.cacheReadTokens || 0;
    m.cacheWriteTokens += u.cacheWriteTokens || 0;
    m.outputTokens += u.outputTokens || 0;
    m.reasoningTokens += u.reasoningTokens || 0;
    m.nanoAiu += v.totalNanoAiu || 0;
  }
}

function fmt(n) { return n.toLocaleString("en-US"); }
function aiu(nano) { return (nano / 1e9).toFixed(2); }

function main() {
  const args = parseArgs(process.argv);
  const sessions = loadSessions();
  if (!sessions.length) {
    console.error("No local sessions found under " + STATE_DIR);
    process.exit(1);
  }

  // Resolve the coordinator worktree + branch.
  let coordCwd = args.cwd ? safeRealpath(args.cwd) : "";
  if (!coordCwd && !args.branch) coordCwd = safeRealpath(process.cwd());
  let coordBranch = args.branch || "";
  if (!coordBranch && coordCwd) {
    try { coordBranch = execSync(`git -C "${coordCwd}" rev-parse --abbrev-ref HEAD`, { encoding: "utf8" }).trim(); } catch { /* ignore */ }
  }

  // Pick the coordinator session: the most recent session matching cwd (preferred) or branch.
  const matches = sessions
    .filter((s) => (coordCwd && s.cwd === coordCwd) || (coordBranch && s.branch === coordBranch))
    .sort((a, b) => b.startTime - a.startTime);
  const coord = matches[0];
  if (!coord) {
    console.error(`No session found for cwd=${coordCwd || "(none)"} branch=${coordBranch || "(none)"}`);
    process.exit(1);
  }
  const coordMetrics = metricsOf(coord);
  const coordEnd = coordMetrics ? coordMetrics.shutdownTime : Date.now();

  // Discover children. Time-overlap alone is NOT safe (independent builds may run in
  // parallel, and branch names get reused), so by default we only include children we can
  // name reliably: branches listed in the coordinator's children manifest
  // (.code-chain/latest/children.{txt,json}) plus any --child branches. For each named
  // branch we pick the session whose start falls inside the coordinator's lifespan. Pure
  // time-window discovery is opt-in via --auto-children (prints a caveat).
  const windowEnd = coordEnd + 5 * 60 * 1000;
  const inWindow = (s) => s.startTime >= coord.startTime && s.startTime <= windowEnd;
  const manifestBranches = coord.cwd ? readChildManifest(coord.cwd) : [];
  const namedBranches = new Set([...manifestBranches, ...args.child]);

  let children = [];
  let childMode = "named";
  if (!args.noChildren) {
    if (namedBranches.size) {
      for (const br of namedBranches) {
        const cand = sessions
          .filter((s) => s.id !== coord.id && s.branch === br && inWindow(s))
          .sort((a, b) => b.startTime - a.startTime)[0]
          // fall back to the most recent session on that branch if none in-window
          || sessions.filter((s) => s.id !== coord.id && s.branch === br).sort((a, b) => b.startTime - a.startTime)[0];
        if (cand && !children.find((c) => c.id === cand.id)) children.push(cand);
      }
    } else if (args.autoChildren) {
      childMode = "auto";
      children = sessions.filter((s) =>
        s.id !== coord.id &&
        s.repository === coord.repository &&
        s.cwd !== coord.cwd &&
        inWindow(s));
    } else {
      childMode = "none";
    }
  } else {
    childMode = "off";
  }

  // Aggregate.
  const perSession = [];
  const grand = {};
  const consume = (sess, role) => {
    const mm = metricsOf(sess);
    const row = { id: sess.id, role, branch: sess.branch, models: {}, hasMetrics: !!mm };
    if (mm) {
      addModelMetrics(grand, mm.modelMetrics);
      const local = {};
      addModelMetrics(local, mm.modelMetrics);
      row.models = local;
    }
    perSession.push(row);
  };
  consume(coord, "coordinator");
  for (const c of children) consume(c, "child");

  const models = Object.keys(grand).sort((a, b) => grand[b].nanoAiu - grand[a].nanoAiu);
  const totalNano = models.reduce((s, m) => s + grand[m].nanoAiu, 0);
  const totalOut = models.reduce((s, m) => s + grand[m].outputTokens, 0);
  const totalReason = models.reduce((s, m) => s + grand[m].reasoningTokens, 0);

  if (args.json) {
    console.log(JSON.stringify({ coordinator: coord, children, perSession, grand, totals: { nanoAiu: totalNano, outputTokens: totalOut, reasoningTokens: totalReason } }, null, 2));
    return;
  }

  // Build a human-readable ledger.
  const L = [];
  L.push(`# code-chain token ledger (REAL usage from session-shutdown modelMetrics)`);
  L.push("");
  L.push(`- coordinator branch: ${coord.branch}  (session ${coord.id})`);
  L.push(`- coordinator loop model: ${coord.selectedModel}`);
  L.push(`- child sessions: ${children.length}${children.length ? " (" + children.map((c) => c.branch).join(", ") + ")" : ""}`);
  if (childMode === "auto") L.push(`- NOTE: children discovered by TIME-WINDOW (--auto-children). Unsafe if other builds ran concurrently — verify the branch list above.`);
  else if (childMode === "none") L.push(`- NOTE: no children manifest (.code-chain/latest/children.txt) and no --child given. Coordinator only. Pass --child <branch> or --auto-children to include parallel workers.`);
  if (!coordMetrics) L.push(`- NOTE: coordinator has not shut down yet — its own numbers are incomplete. Re-run after it exits.`);
  const noMetrics = perSession.filter((r) => !r.hasMetrics && r.role === "child");
  if (noMetrics.length) L.push(`- NOTE: ${noMetrics.length} child session(s) had no shutdown metrics yet (still running?).`);
  L.push("");
  L.push(`## Per-model totals (coordinator + ${children.length} child session[s])`);
  L.push("");
  L.push(`| model | reqs | input | cache_read | output | reasoning | AIU | %cost |`);
  L.push(`|---|--:|--:|--:|--:|--:|--:|--:|`);
  for (const m of models) {
    const g = grand[m];
    const pct = totalNano ? ((g.nanoAiu / totalNano) * 100).toFixed(1) : "0.0";
    L.push(`| ${m} | ${fmt(g.requests)} | ${fmt(g.inputTokens)} | ${fmt(g.cacheReadTokens)} | ${fmt(g.outputTokens)} | ${fmt(g.reasoningTokens)} | ${aiu(g.nanoAiu)} | ${pct}% |`);
  }
  L.push(`| **TOTAL** | | | | **${fmt(totalOut)}** | **${fmt(totalReason)}** | **${aiu(totalNano)}** | 100% |`);
  L.push("");
  L.push(`AIU = the platform's real billing unit (totalNanoAiu / 1e9). Reasoning tokens are`);
  L.push(`included in output billing; shown separately so high-reasoning stages are visible.`);
  L.push("");
  if (children.length) {
    L.push(`## Per-session breakdown`);
    L.push("");
    L.push(`| session | role | branch | models | AIU |`);
    L.push(`|---|---|---|---|--:|`);
    for (const r of perSession) {
      const sNano = Object.values(r.models).reduce((s, v) => s + v.nanoAiu, 0);
      L.push(`| ${r.id.slice(0, 8)} | ${r.role} | ${r.branch} | ${Object.keys(r.models).join(", ") || "(none)"} | ${aiu(sNano)} |`);
    }
    L.push("");
  }
  const md = L.join("\n");
  console.log(md);

  // Persist next to the coordinator's flight recorder if present.
  const ccLatest = join(coord.cwd, ".code-chain", "latest");
  const outDir = args.out ? null : (existsSync(ccLatest) ? ccLatest : null);
  if (outDir) {
    writeFileSync(join(outDir, "token-ledger.md"), md + "\n");
    const csv = ["scope,model,requests,input_tokens,cache_read_tokens,output_tokens,reasoning_tokens,nano_aiu"];
    for (const m of models) {
      const g = grand[m];
      csv.push(`total,${m},${g.requests},${g.inputTokens},${g.cacheReadTokens},${g.outputTokens},${g.reasoningTokens},${g.nanoAiu}`);
    }
    writeFileSync(join(outDir, "token-ledger.csv"), csv.join("\n") + "\n");
    console.log(`\nWrote ${join(outDir, "token-ledger.md")} and token-ledger.csv`);
  } else if (args.out) {
    writeFileSync(args.out, md + "\n");
    console.log(`\nWrote ${args.out}`);
  }
}

main();
