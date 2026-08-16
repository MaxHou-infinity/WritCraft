# Repository Guidelines

## Project Structure and Authority

Use `docs/INDEX.md` to select only the documentation needed for the current task. Before implementation, read the current control block in `v0/DEVELOPMENT-STATUS.md`, the one directly relevant contract or matrix, and the affected source/tests. Read `docs/ROADMAP.md` only for version or scope decisions, and `docs/0.4.0-EXECUTION-PROTOCOL.md` when opening or signing a checkpoint. PRD, architecture, old review records, and frozen 0.1.x–0.3.0 contracts are on-demand compatibility evidence, not universal startup reading.

The Electron application is under `v0/`. Main-process services and the narrow preload bridge live in `v0/src/main/`; UI and state live in `v0/src/renderer/`; pure cross-process logic belongs in `v0/src/shared/`. Standalone verification scripts are in `v0/tests/`, fixtures in `v0/tests/fixtures/`, and packaging utilities in `v0/scripts/`. `raw/`, `deliverables/`, and `docs/archive/` never dispatch current work.

Source and reproducible tests establish current implementation facts. `docs/ROADMAP.md` alone decides version order and scope; `v0/DEVELOPMENT-STATUS.md` records the current checkpoint and open risks; the relevant current contract defines acceptance.

## Build, Test, and Development Commands

Run commands from `v0/`:

- `npm ci` — install the locked dependency set.
- `npm run dev` — launch Electron with development behavior.
- `npm start` — launch the normal local application.
- `npm test` — run the main Node behavior suite.
- `npm run verify` — run the broader regression, security, and packaging checks.
- `npm run verify:full` — add forced real-Electron E2E.
- `npm run verify:npm-preview` — verify the package allowlist and preview tarball without publishing.
- `npm run verify:npm-preview:installed` — verify the installed tarball in isolation.
- `npm audit --omit=dev` — require zero known production vulnerabilities for a preview candidate and before publication.
- `npm run package:mac` and `npm run release:verify` — build and inspect the macOS artifact.

Real API checks require explicit gates; never log keys, prompts, document content, or private paths. Do not publish, move a dist-tag, create a GitHub Release/Tag, push a release, or distribute App/ZIP without explicit owner authorization.

## Coding and Architecture

Use CommonJS JavaScript with `'use strict'`, two-space indentation, semicolons, single quotes, and `const` by default. Name modules in kebab-case, verification files `verify-v0-<feature>.js`, and constants in `UPPER_SNAKE_CASE`. Preserve surrounding style and run `node --check` for changed JavaScript.

Main owns filesystem, revision, capability, network, transaction, and recovery authority. Renderer must not access Node APIs, perform HTTP(S), submit absolute paths or content authority, or bypass ChangeSet/History review. Main must not import Renderer modules; shared code stays pure and has parity/static dependency coverage. New 0.4 IPC enters through a focused service/handler rather than expanding `main.js` without a boundary.

Before a paid call or irreversible side effect, complete authority/capacity preflight and acquire an owner-specific single-flight lease. Release only authority acquired by that operation. After a commit, retries must preserve committed truth and may only complete reconciliation, durability, or response reconstruction; never replay the mutation from stale pre-commit validation.

When Main reconciliation has installed authoritative tree, current-file, and History state, publish that committed truth. Optional refresh work must not obscure or invalidate it.

## Testing and Data Safety

Tests use Node's built-in `assert` and executable scripts. Add failure, stale revision, project-switch, no-op, and async-destroy coverage where relevant. Fault injection must cross the claimed production boundary: partial-write tests write bytes before throwing, committed-rename/fsync tests prove durability retry, and cleanup never deletes an unproven replacement.

Focused, schema, fake-adapter, direct-service, or seeded-storage green evidence is component evidence, not App, Stage, candidate, author, or release sign-off. Register every new or renamed `verify-v0-*.js` in the 0.4 inventory and active top-level gate in the same change set.

For destructive or public-file mutation, bind the exact project/owner, selected target, current revision, and recovery truth. Preserve unselected files. Cancellation, conflict, project switch, and proven pre-commit failure produce no unintended public write. Ambiguous post-commit outcomes fail closed without replay; automatic recovery is not required when safe manual recovery is the only provable result.

The blocking threat model covers accidental concurrency, external editor drift, symlink/path escape, crash/response loss, wrong-target writes, replay, and cross-project pollution. An active same-UID process defeating owner-only private storage is P2 hardening unless the owner explicitly upgrades that threat model.

## 0.4.0 Execution

`docs/0.4.0-EXECUTION-PROTOCOL.md` alone controls current checkpoint order, WIP, review, and Stage gates. A1a–A2d are the independently reviewed checkpoints. Their internal schema, wire, locator, native, E/R/V/F, and other implementation slices may have focused reds/greens but are not separate sign-offs and do not block adjacent work through chat-only final bindings.

Maintain one primary checkpoint and at most one support task that does not modify the same authority. A primary turn must produce an inspectable red, minimal implementation, test result, or explicit blocker. Run focused gates before full suites. Bind an independent checkpoint review to one clean local commit/tree; do not substitute cumulative binary-diff manifests.

Only Stage A may receive implementation work. Stage B remains frozen pending the real A→B journey; Stage C/D/E remain blocked. Push, Tag, Release, publication, and distribution remain separately authorized actions.

## Documentation and Delegation

Update roadmap, status, contracts, README, and Nowledge Mem only at a checkpoint opening, independently verified checkpoint close, Stage exit, or scope decision—not after mechanical edits or internal component greens. The current status control block stays concise; detailed rounds and superseded totals go to archive.

Split delegated work by one independently testable layer: contract, Main service, IPC wiring, Renderer, or verification. Writer and reviewer passes stay separate. Report changed facts, failures, commands, remaining work, and blockers; do not spend repeated turns polling without evidence.

Module-specific incident rules for watcher/UI ownership, native helpers, packaging, model output, real-author acceptance, and destructive History UX are archived in `docs/archive/engineering/INCIDENT-GUARDRAILS-THROUGH-2026-08-13.md`. Load them only when the current change touches that module; they do not expand current product scope or create new checkpoint gates.

When shell search text contains Markdown backticks, `$()`, or substitution syntax, pass it as a single-quoted literal. An audit must never execute the text it is searching for.

## Commit and Pull Request Guidelines

Use concise imperative commits, for example `fix(onboarding): preserve committed state`. Keep source, tests, and affected documentation in the same checkpoint commit. PRs explain user impact, authority/state-machine changes, tests run, and remaining risks; include screenshots for UI changes and never attach secrets or stale release artifacts.

Commit type discipline: conventional types (`feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `style`, `perf`) plus `release:` for publication/preview preparation. Do not commit WIP snapshots — every commit must be a self-consistent, reviewable state. The two LICENSE copies (`LICENSE` and `v0/LICENSE`) must stay byte-identical except for their contextually correct `THIRD_PARTY_NOTICES.md` path reference. Empty directories are not tracked by git; if a directory must exist, place a `.gitkeep` and document why.

The public remote is `https://github.com/MaxHou-infinity/WritCraft.git`, with local `main` tracking `origin/main`. A local commit is not public until its exact commit is pushed and verified. Never rewrite public history, change repository visibility, publish a release, or push credentials/artifacts without explicit authorization.
