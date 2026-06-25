# Constitution

What *this* project requires — its stack, the seams to reuse, the invariants not to break, and the domain rules that make it correct. This is the project's source of truth. code-chain reads it in every stage: the planner plans to it, the coder conforms to it, the reviewer flags violations as blocking. It complements the code-chain baselines (`PLANNING.md` / `CODING.md`), which cover good planning and code quality *in general*; this file covers what is specific to *here*. When the code and this doc disagree, the code wins and this doc gets fixed.

> This is a template. Fill in each section for your project and delete the guidance in parentheses. Keep it short — a load-bearing summary, not a manual. Lines are unwrapped (one bullet per line) so they reflow.

---

## Stack (reach for what's here first)

- Language / runtime: (e.g. Python 3.11+)
- Framework(s): (e.g. FastAPI + uvicorn)
- Validation: (e.g. Pydantic at every boundary)
- Persistence: (e.g. in-memory repo layer / Postgres via one store seam)
- Tests: (e.g. pytest + TestClient)
- Lint / format: (e.g. ruff + black)

Default to the libraries listed here; get a yes before adding a new dependency for something the stack already covers.

## Architecture invariants (never violate)

- (The spine the system bends around — e.g. domain types defined once and imported; all persistence through one data-access seam; dependencies point one way.)

## Domain constraints

- (The rules that make this product correct — e.g. all money is integer cents, never floats; orders follow the `pending → paid → fulfilled` state machine; read "now" through one injectable clock.)

## Security

- (Auth model, secret handling, input sanitization, trust boundaries — e.g. authorize per request fail-closed; secrets in env, never logged; sanitize untrusted input with an allow-list.)

## Config

- (How config is loaded and validated; env-driven behavior — e.g. validate all env at boot and throw on anything invalid; same code path in dev and prod.)

## Data

- (Query safety, migrations, id/time conventions — e.g. never build queries by string concatenation; forward-only migrations; lexicographically sortable ids.)

## Errors & observability

- (Error model, logging, redaction, health — e.g. one typed error with status + machine code + safe message; structured logging through one path; never log secrets/PII.)

## Testing

- (What must be covered and how state is isolated — e.g. one test per business rule including negatives; tests are fail-closed; isolate state with temp dirs/ephemeral ports.)

## Deployment

- (How it ships and what must hold after — e.g. infra-as-code is the source of truth; image builds belong to CI; post-deploy checks must pass.)

## Definition of done

- (The checks that must pass before a change is done — e.g. typecheck/build, lint, and the relevant tests all green; commit at coherent stopping points.)
