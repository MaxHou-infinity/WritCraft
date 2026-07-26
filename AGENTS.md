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

## Testing Guidelines

Tests use Node's built-in `assert` and executable scripts rather than a test framework. Add failure, stale revision, project-switch, no-op, and async-destroy coverage where relevant. Directed tests are not sign-off: run full verification, real Electron behavior, manual user journeys, and independent review as required by Phase A §11.4.

## Documentation Discipline

Before resuming work, read `v0/DEVELOPMENT-STATUS.md`, the relevant contract in `docs/`, and `v0/package.json`; source and current test evidence override historical snapshots. In the same change set as every completed feature, review, or verification result, update the status ledger and any affected contract/README/roadmap. Mark old figures as **historical focused evidence** with scope and date—never present them as the current total. Do not begin a follow-up fix from an old TODO until the status ledger confirms it remains open.

## Delegation & Efficiency Guardrails

Split delegated work into one independently testable layer: contract, Main service, Main/IPC wiring, Renderer state/UI, or verification. Do not assign an entire cross-layer feature to one lane. Each lane must surface a runnable checkpoint within 5–10 minutes: changed files, tests run, remaining work, and blockers.

Wait for a delegated lane at most once without new evidence. After the first timeout, request an immediate checkpoint; after a second timeout or another vague update, interrupt, take over, or split the task. Never spend repeated turns polling an agent that has not produced inspectable work.

Freeze the failure/state matrix and authority boundary before implementation. Require a minimal runnable result before expanding scope. Report only changed facts, failures, and the next action; avoid repeating full logs. Synchronize `v0/DEVELOPMENT-STATUS.md` and Nowledge Mem at durable milestones—contract freeze, independently verified implementation, and final sign-off—not after every mechanical edit.

## Commit & Pull Request Guidelines

Local Git history begins with the 2026-07-26 V0 baseline, so it does not describe earlier development conventions. Use concise imperative commits, for example `fix(onboarding): preserve committed state`. Keep source, tests, and affected documentation in the same commit. PRs should explain user impact, authority/state-machine changes, tests run, and remaining risks; include screenshots for UI changes and never attach secrets or stale release artifacts.
