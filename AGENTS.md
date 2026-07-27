# Repository Guidelines

## Project Structure & Module Organization

Product and engineering references live at the repository root: `README.md`, `docs/WRITCRAFT-PRD-V3.md`, and `docs/PHASE-A-IMPLEMENTATION.md`. Treat `v0/DEVELOPMENT-STATUS.md` as the current execution ledger and read it before changing code.

The Electron application is under `v0/`. Main-process services and the narrow preload bridge live in `v0/src/main/`; UI, state machines, CSS, and vendored browser assets live in `v0/src/renderer/`. Standalone verification scripts are in `v0/tests/`, fixtures in `v0/tests/fixtures/`, and packaging utilities in `v0/scripts/`. Research inputs and product deliverables remain in `raw/` and `deliverables/`; do not mix them into runtime code.

## Build, Test, and Development Commands

Run commands from `v0/`:

- `npm ci` — install the locked dependency set.
- `npm run dev` — launch Electron with development behavior.
- `npm start` — launch the normal local application.
- `npm test` — run the main Node behavior suite.
- `npm run verify` — run the broader regression, security, and packaging checks.
- `npm run verify:full` — run verification plus forced real-Electron E2E.
- `npm run package:mac` and `npm run release:verify` — build and inspect the macOS artifact.

Real API checks require explicit gates; never enable them casually or log keys, prompts, or document content.

## Coding Style & Naming Conventions

Use CommonJS JavaScript with `'use strict'`, two-space indentation, semicolons, single quotes, and `const` by default. Name modules in kebab-case (`onboarding-batch-service.js`), verification files `verify-v0-<feature>.js`, and constants in `UPPER_SNAKE_CASE`. No formatter or linter is enforced; preserve surrounding style and run `node --check <file>` for changed JavaScript.

Main owns filesystem, revision, capability, and network authority. Renderer code must not access Node APIs or make HTTP(S) requests directly. AI writes must remain reviewable through ChangeSet/History boundaries.

Before any paid call or irreversible side effect, complete authority/capacity preflight and acquire an owner-specific single-flight lease. Release only a lease this request actually acquired. After a commit, retries must preserve committed truth: do not rerun stale pre-commit validation or repeat the mutation; retry only missing evidence, fsync, or response reconstruction.

## Testing Guidelines

Tests use Node's built-in `assert` and executable scripts rather than a test framework. Add failure, stale revision, project-switch, no-op, and async-destroy coverage where relevant. Directed tests are not sign-off: run full verification, real Electron behavior, manual user journeys, and independent review as required by Phase A §11.4.

Fault injection must cross the claimed boundary. A “partial write” test must write bytes before throwing; a “rename committed, fsync failed” test must prove the retry performs another directory fsync. Readable files are not automatically durable. Verify cleanup against the exact inode so failures never delete a concurrent replacement.

## Documentation Discipline

Before resuming work, read `v0/DEVELOPMENT-STATUS.md`, the relevant contract in `docs/`, and `v0/package.json`; source and current test evidence override historical snapshots. In the same change set as every completed feature, review, or verification result, update the status ledger and any affected contract/README/roadmap. Mark old figures as **historical focused evidence** with scope and date—never present them as the current total. Do not begin a follow-up fix from an old TODO until the status ledger confirms it remains open.

At each durable closeout, compare current `main`, test evidence, `README.md`, PRD, Phase A, feature contracts, PDCA, and the status ledger. Search for the superseded milestone and test totals, run `git diff --check`, then update and re-query the same Nowledge authority memory. Separate the next locally executable task from external gates such as paid API keys or real-author evidence.

## Delegation & Efficiency Guardrails

Split delegated work into one independently testable layer: contract, Main service, Main/IPC wiring, Renderer state/UI, or verification. Do not assign an entire cross-layer feature to one lane. Each lane must surface a runnable checkpoint within 5–10 minutes: changed files, tests run, remaining work, and blockers.

Distinguish a tool polling timeout from the lane's 5–10 minute delivery window. A 10-second `wait`/poll result is only a transport checkpoint and must not be treated as a failed review. Give a newly started reviewer one real evidence window (normally 60 seconds first, then a bounded checkpoint request); interrupt or take over only after the agreed delivery window expires without inspectable work. Never spend repeated turns polling an agent that has not produced evidence.

Freeze the failure/state matrix and authority boundary before implementation. Require a minimal runnable result before expanding scope. Report only changed facts, failures, and the next action; avoid repeating full logs. Synchronize `v0/DEVELOPMENT-STATUS.md` and Nowledge Mem at durable milestones—contract freeze, independently verified implementation, and final sign-off—not after every mechanical edit.

For destructive filesystem work, an `lstat` followed by path-based `unlink` is not an identity guarantee. Move the path into a private unpredictable transaction quarantine, revalidate inode, size, canonical parent, and content digest, then remove only the quarantined identity. Snapshot deletion must bind content identity as well as inode; same-inode rewrites and late replacements fail closed. Once a mutation is committed, its exact retry truth must outlive the live capability TTL until fsync/partial recovery reaches a terminal state.

Tests must derive expectations from the production contract, not incidental ordering. If production sorts candidates by metadata, a race/fault injection must target the first candidate actually processed or explicitly control the metadata; never assume fixture creation order. Before changing product code for a next-session failure, first prove whether the failure is implementation drift, environmental variance, or a brittle test assumption.

Real-author acceptance is an explicit privacy boundary. Validate only an author-selected project; never crawl unrelated home folders to find a convenient manuscript. Preflight must remain read-only and path/content-free, and testing must use an isolated working copy whose source snapshot is proven unchanged. Synthetic fixtures can verify mechanics but can never count as author evidence.

For filesystem copy/publish workflows, freeze the complete read/copy/commit matrix before implementing the happy path. Eligibility and copied bytes must come from one authoritative snapshot; bind every source ancestor and destination parent/stage identity; make the final source recheck the last pre-commit action; publish with atomic no-clobber semantics; and reconcile committed-then-threw outcomes from disk. `O_NOFOLLOW` protects only the final path component, and `existsSync` followed by `renameSync` is neither ancestor-safe nor no-clobber. Add adversarial tests for each boundary before treating full-suite green as sign-off.

Treat an external filesystem helper as a three-state transaction: proven uncommitted, proven committed, or unknown. If both the primary result and independent reconciliation are unavailable, report committed-risk and never enter precommit cleanup. Moving work into a native helper does not make `mkdir→open` atomic; attack the exact syscall gap or document the residual explicitly. Random names reduce likelihood but do not prove inode ownership.

Never erase a red integration run with a green retry. Record both, inspect the failed boundary, and keep a flake as an explicit P2/TODO until its timing cause is explained or repeated clean runs justify closing it. A retry is evidence about nondeterminism, not proof that the first failure was harmless.

## Commit & Pull Request Guidelines

Local Git history begins with the 2026-07-26 V0 baseline, so it does not describe earlier development conventions. Use concise imperative commits, for example `fix(onboarding): preserve committed state`. Keep source, tests, and affected documentation in the same commit. PRs should explain user impact, authority/state-machine changes, tests run, and remaining risks; include screenshots for UI changes and never attach secrets or stale release artifacts.

This repository currently has no Git remote. A local commit or merge does not mean GitHub upload or deployment.
