# code-chain

A [GitHub Copilot CLI](https://github.com/github/copilot-cli) extension that turns a
single build request into a coordinated **four-stage agent pipeline** and records
per-stage telemetry to disk for review.

```
PLAN  →  PLAN REVIEW  →  CODE  →  CODE REVIEW   (→ fix → re-review)
```

Each stage runs as a `task` sub-agent. The coordinator never writes plans or code
itself — it orchestrates the loops and the extension's hooks capture every stage's
prompt, result, and estimated token cost.

## Why

A single model doing "plan and build it all" tends to take oversized steps and quietly
drop requirements. Splitting the work into a planning pair and a building pair — each
with its own reviewer — catches dropped business rules and bad step-sizing before they
become bugs. The pipeline is **model-agnostic**: pin a model per stage and benchmark
builders by varying only the CODE loop while planning/review stay fixed.

## How it works

The extension contributes **no tools** (`tools: []`). It works through hooks:

| Hook | What it does |
|------|--------------|
| `onSessionStart` | Initializes the `.code-chain/` flight recorder for the active project |
| `onUserPromptSubmitted` | Injects the 4-loop coordination skill when the prompt looks like build/create/implement/refactor/fix work |
| `onPostToolUse` / `...Failure` | Captures every `task` sub-agent call (prompt, result, model, token estimates) |

### Portability

The extension derives its log directory from `input.workingDirectory` (the active
session's worktree) on **every hook**, so a single install at **user scope** works
across all your projects — no per-repo setup, no path assumptions.

### What it writes

Into `.code-chain/` of whatever project is active:

| File | Contents |
|------|----------|
| `timeline.log` | One ordered line per event — the flight recorder for a whole run |
| `metrics.csv` | Machine-readable per-event metrics (stage, model, token estimates, status) |
| `plan.md` / `review.md` | Latest plan / plan-review and latest code-review (prompt + result) |
| `events.log` | Append-only full history of every stage's I/O |
| `debug.log` | Low-level extension debug output |

> Token counts are **estimates** (~4 chars/token) computed from the prompt/result text,
> because local sub-agent sessions aren't reliably flushed to the session store. Add
> `.code-chain/` to your `.gitignore`.

## Install

### User scope (recommended — works in every project)

From a Copilot CLI session:

```
install_extension(url: "<gist-or-repo-folder-url>", scope: "user")
```

Or clone this repo and copy `.github/extensions/code-chain/` into
`~/.copilot/extensions/code-chain/`.

### Project scope

Copy `.github/extensions/code-chain/` into a repo's `.github/extensions/`. It loads for
sessions in that repo only.

## Usage

Just ask Copilot CLI to build something:

```
Build a Library Lending API with authors, books, members, and loan rules. Add tests.
```

The skill auto-injects, the four loops run, and a run report plus `.code-chain/metrics.csv`
land in the project.

## Customizing the pipeline

Edit `SKILL_CONTEXT` in `extension.mjs`:

- Change the default model (currently `claude-sonnet-4.6`) per stage.
- To benchmark builders, vary **only** the CODE loop's `model` and keep PLAN,
  PLAN_REVIEW, and CODE_REVIEW constant.
