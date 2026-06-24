import { joinSession } from "@github/copilot-sdk/extension";
import { execFileSync } from "child_process";

// branch-freshness
// -----------------
// A warn-only freshness checker for the active worktree. On every session start
// and (throttled) on every user prompt, it compares the current branch against
// its remote default branch (origin/main by default) and, if the branch is
// BEHIND, surfaces a nudge to the user and hidden context to the agent. It never
// rebases, fetches destructively, or modifies files — it only tells you that you
// should refresh before doing more work.
//
// Portable: every hook reads `workingDirectory`, so one install works across
// worktrees and projects.

const FETCH_INTERVAL_MS = 3 * 60 * 1000; // throttle network fetches to once / 3 min
let lastFetch = 0;

// Run a git command in `cwd`, returning trimmed stdout, or null on any failure
// (offline, no remote, not a repo, etc.). Never throws.
function git(cwd, args, timeout = 8000) {
  try {
    return execFileSync("git", args, {
      cwd,
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch (e) {
    return null;
  }
}

// Determine the remote default branch ref (e.g. "origin/main"). Falls back to
// origin/main if it can't be resolved.
function remoteDefault(cwd) {
  const head = git(cwd, ["rev-parse", "--abbrev-ref", "origin/HEAD"]);
  if (head && head.includes("/")) return head; // "origin/main"
  return "origin/main";
}

// Best-effort network refresh of the remote ref, throttled across the process.
function maybeFetch(cwd, force = false) {
  const now = Date.now();
  if (!force && now - lastFetch < FETCH_INTERVAL_MS) return;
  lastFetch = now;
  git(cwd, ["fetch", "--quiet", "origin"], 10000);
}

// Compute how far the current HEAD is behind/ahead of the remote default branch.
// Returns { ref, behind, ahead } or null when it can't be computed.
function divergence(cwd) {
  const ref = remoteDefault(cwd);
  if (!git(cwd, ["rev-parse", "--verify", "--quiet", ref])) return null;
  const counts = git(cwd, ["rev-list", "--left-right", "--count", `${ref}...HEAD`]);
  if (!counts) return null;
  const [behind, ahead] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ref, behind, ahead };
}

// Build the warning strings (user-facing + agent context) when behind, else null.
function staleness(cwd) {
  const d = divergence(cwd);
  if (!d || d.behind === 0) return null;
  const plural = d.behind === 1 ? "commit" : "commits";
  const aheadNote = d.ahead > 0 ? ` (and ${d.ahead} ahead)` : "";
  const userMsg =
    `⚠️  This worktree is ${d.behind} ${plural} behind ${d.ref}${aheadNote}. ` +
    `Refresh before doing more work:  git fetch origin && git rebase ${d.ref}`;
  const agentMsg =
    `[branch-freshness] The current branch is ${d.behind} ${plural} behind ${d.ref}${aheadNote}. ` +
    `Work done now may be based on stale code. If the user is about to plan, build, or ` +
    `launch a code-chain trial, remind them to refresh first with ` +
    `\`git fetch origin && git rebase ${d.ref}\` — do NOT rebase on their behalf.`;
  return { userMsg, agentMsg, ...d };
}

const session = await joinSession({
  tools: [],
  hooks: {
    onSessionStart: async (input) => {
      const cwd = (input && input.workingDirectory) || process.cwd();
      maybeFetch(cwd, true); // always refresh on session start
      const s = staleness(cwd);
      if (s) {
        await session.log(s.userMsg);
        return { additionalContext: s.agentMsg };
      }
      await session.log("✅ Branch is up to date with its remote default branch.");
    },
    onUserPromptSubmitted: async (input) => {
      const cwd = (input && input.workingDirectory) || process.cwd();
      maybeFetch(cwd); // throttled; no network if fetched recently
      const s = staleness(cwd);
      if (s) {
        await session.log(s.userMsg);
        return { additionalContext: s.agentMsg };
      }
    },
  },
});
