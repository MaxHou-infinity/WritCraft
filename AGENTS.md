# Repository Guidelines

## Project Structure & Module Organization

Product and engineering references live at the repository root: `README.md`, `docs/WRITCRAFT-PRD-V3.md`, `docs/ROADMAP.md`, and `docs/PHASE-A-IMPLEMENTATION.md`. Treat `docs/ROADMAP.md` as the only authority for target-version order and scope, and `v0/DEVELOPMENT-STATUS.md` as the current execution ledger. Read both before changing code.

The Electron application is under `v0/`. Main-process services and the narrow preload bridge live in `v0/src/main/`; UI, state machines, CSS, and vendored browser assets live in `v0/src/renderer/`. Standalone verification scripts are in `v0/tests/`, fixtures in `v0/tests/fixtures/`, and packaging utilities in `v0/scripts/`. Research inputs and historical product deliverables remain in `raw/` and `deliverables/`; do not mix them into runtime code or use them to dispatch current work.

## Build, Test, and Development Commands

Run commands from `v0/`:

- `npm ci` — install the locked dependency set.
- `npm run dev` — launch Electron with development behavior.
- `npm start` — launch the normal local application.
- `npm test` — run the main Node behavior suite.
- `npm run verify` — run the broader regression, security, and packaging checks.
- `npm run verify:full` — run verification plus forced real-Electron E2E.
- `npm run verify:npm-preview` — verify the CLI/package allowlist and inspect the preview tarball without publishing.
- `npm run verify:npm-preview:installed` — install the tarball in isolation and prove Main-observed page-load IPC, profile isolation, signal forwarding, and cleanup.
- `npm audit --omit=dev` — require zero known production vulnerabilities for every preview candidate and again immediately before publication.
- `npm run package:mac` and `npm run release:verify` — build and inspect the macOS artifact.

Real API checks require explicit gates; never enable them casually or log keys, prompts, or document content.

The initial distribution route is the macOS npm Developer Preview in `docs/NPM-DEVELOPER-PREVIEW-V1-CONTRACT.md`. `writ-craft@0.1.1` is already public under npm `preview`; `latest` intentionally remains `0.1.0`. Do not publish another version, move a dist-tag, or create a GitHub Release without explicit authorization.

Do not infer a validated platform matrix from manifest declarations or universal helper slices. Record the exact Node/npm/architecture used by installed-tarball evidence. The 0.1.1 candidate closed Node 22/npm 10 arm64 and Node 24/npm 11 x64 at 2/2 each; future candidates must repeat their own applicable matrix. Main-observed page-load IPC proves `did-finish-load`, not every workspace/bootstrap behavior.

## Coding Style & Naming Conventions

Use CommonJS JavaScript with `'use strict'`, two-space indentation, semicolons, single quotes, and `const` by default. Name modules in kebab-case (`onboarding-batch-service.js`), verification files `verify-v0-<feature>.js`, and constants in `UPPER_SNAKE_CASE`. No formatter or linter is enforced; preserve surrounding style and run `node --check <file>` for changed JavaScript.

Main owns filesystem, revision, capability, and network authority. Renderer code must not access Node APIs or make HTTP(S) requests directly. AI writes must remain reviewable through ChangeSet/History boundaries.

Never infer provider capability from a credential prefix. `sk-cp-` and `sk-api-` identify credential/billing families; current official documentation plus a gated, privacy-safe provider response decide whether `image-01` is available. Pin Electron to a currently supported stable release and re-run real-Electron behavior after every upgrade.

Before any paid call or irreversible side effect, complete authority/capacity preflight and acquire an owner-specific single-flight lease. Release only a lease this request actually acquired. After a commit, retries must preserve committed truth: do not rerun stale pre-commit validation or repeat the mutation; retry only missing evidence, fsync, or response reconstruction.

When a Main-owned reconciliation has already installed authoritative tree, current-file, and History state and cleared the exact recovery marker, publish the committed terminal UI from that result. Do not make success depend on a second unbounded refresh chain. Any optional follow-up refresh must not obscure committed truth; retain the old fail-closed refresh path when authoritative reload is absent or untrusted.

## Testing Guidelines

Tests use Node's built-in `assert` and executable scripts rather than a test framework. Add failure, stale revision, project-switch, no-op, and async-destroy coverage where relevant. Directed tests are not sign-off: run full verification, real Electron behavior, manual user journeys, and independent review as required by Phase A §11.4.

Fault injection must cross the claimed boundary. A “partial write” test must write bytes before throwing; a “rename committed, fsync failed” test must prove the retry performs another directory fsync. Readable files are not automatically durable. Verify cleanup against the exact inode so failures never delete a concurrent replacement.

Security precision belongs in a private authority record, not by silently changing a public compatibility field. For example, watcher identity may use BigInt `dev`/`ino` and nanosecond times while the public snapshot must retain its established numeric `mtimeMs` rounding. When changing stat representations, add a parity test against the old public contract and repeat the race test enough times to cross timestamp-boundary variance.

## Documentation Discipline

Before resuming work, read `docs/ROADMAP.md`, `v0/DEVELOPMENT-STATUS.md`, the relevant contract in `docs/`, and `v0/package.json`; source and current test evidence override historical snapshots. Work only inside the single current target version declared by the roadmap. New ideas go to its candidate pool unless they are P0/P1, data-safety issues, or required by the current version's acceptance. In the same change set as every completed feature, review, or verification result, update the status ledger and any affected contract/README/roadmap. Mark old figures as **historical focused evidence** with scope and date—never present them as the current total. Do not begin a follow-up fix from an old TODO until the status ledger confirms it remains open.

Do not use one green row or “module complete” sentence for a composite experience when any required sub-capability is absent. Split status by user-visible boundary—for example single-turn Chat versus conversation continuity, conflict recovery versus trash restore UI, and `edit.md` onboarding versus section-aware context compilation. A Main service without preload/IPC/Renderer access is not an App feature.

At each durable closeout, compare current `main`, test evidence, `README.md`, PRD, Phase A, feature contracts, PDCA, and the status ledger. Search for the superseded milestone and test totals, run `git diff --check`, then update and re-query the same Nowledge authority memory. Separate the next locally executable task from external gates such as paid API keys or real-author evidence.

When a shell search pattern contains Markdown backticks, `$()`, or other substitution syntax, use a single-quoted fixed string or pass the pattern as a literal argument. Never place such documentation text inside a double-quoted shell command; an audit must not execute the content it is searching for.

## Delegation & Efficiency Guardrails

Split delegated work into one independently testable layer: contract, Main service, Main/IPC wiring, Renderer state/UI, or verification. Do not assign an entire cross-layer feature to one lane. Each lane must surface a runnable checkpoint within 5–10 minutes: changed files, tests run, remaining work, and blockers.

Distinguish a tool polling timeout from the lane's 5–10 minute delivery window. A 10-second `wait`/poll result is only a transport checkpoint and must not be treated as a failed review. Give a newly started reviewer one real evidence window (normally 60 seconds first, then a bounded checkpoint request); interrupt or take over only after the agreed delivery window expires without inspectable work. Never spend repeated turns polling an agent that has not produced evidence.

Freeze the failure/state matrix and authority boundary before implementation. Require a minimal runnable result before expanding scope. Report only changed facts, failures, and the next action; avoid repeating full logs. Synchronize `v0/DEVELOPMENT-STATUS.md` and Nowledge Mem at durable milestones—contract freeze, independently verified implementation, and final sign-off—not after every mechanical edit.

Watcher-driven flows must not infer authority from elapsed time. A drained Renderer queue, one observed generation advance, or a stable window is only diagnostic evidence because native events, debounce, and polling fallback can arrive in separate waves. Before minting fresh AI authority, use a Main-owned barrier that waits in-flight polling, forces a new bounded snapshot, drains pending changes, and binds the exact project instance plus mutation generation; scan limits, watcher degradation, project drift, and barrier failure all fail closed. A time window may remain only as a temporary observation fallback and must be recorded as an open P2.

Progress UI is also an ownership boundary. Long-wait copy must describe the actual operation—local undo must never inherit an AI message—and every async progress/busy cleanup must carry an owner token. Unowned recovery-state refreshes may recompute controls but must not replace or release a live owner; project switch and unload explicitly invalidate the old owner. Test both the elapsed-time branch and an old-finally/new-project overlap through the real cross-component callback path.

Project-root authority starts from a trusted filesystem-root directory fd, not `open(rootPath)`. Keep the absolute canonical path private and bounded; pass it to the native helper only through the startup bind record. Native code must traverse every external component with no-follow `openat`, compare the final identity captured by Main, and rewalk the full root chain before and after each hash batch. A batch-level root drift invalidates the whole batch but may recover on the same worker after the original chain returns. Never claim this proves pre-file-picker selection, atomic `readdir`/`fs.watch`, or protection from a same-UID writer already holding an fd.

After any awaited worker readiness or test hook, recheck close state immediately before writing to child stdin. Filesystem errors at the worker module boundary must map to stable path-free codes even when current callers already redact them; future call sites must not inherit raw absolute-path exceptions.

Committed UI truth must survive optional follow-up decisions. If stage one has already applied `edit.md`, a later “skip initial files” action may settle only the file-creation capability; its terminal preview and status must state that the accepted edit remains committed. Branch copy on the recorded stage-one outcome, not on the stage-two button label, and dynamically test both changed-edit and no-op paths through the real Changes callbacks.

A forced tree walk is not automatically a complete authority scan. If ordinary polling rotates a small hash budget, an explicit flush must use an independent bounded full-Markdown hash budget or fail closed; otherwise a same-size, restored-mtime edit outside the rotation can be missed. Propagate flush failure as an explicit user-visible blocked state—never as an unhandled Renderer rejection.

Leaf-fd identity is not full path authority. An attacker can replace an ancestor while exposing the same hard-linked leaf, so a watcher hash must bind every project-internal ancestor identity and validate it through descriptor-relative traversal before and after the read. Keep the native project-root binding and helper attestation scope explicit: this does not prove the initial root-path open, make enumeration atomic, or eliminate concurrent same-UID fd writes.

Treat native-helper stdout as untrusted input even after a valid response prefix. Catch the complete parse inside the event callback and convert malformed numeric identity or protocol fields into a bounded fail-closed error; an exception must never escape an EventEmitter callback into Electron Main. Bound serialized metadata separately from candidate content bytes. Count the exact header/item/newline bytes incrementally and reject before appending the item to an aggregate payload; mirror the same byte definition and terminal budget error in the native parser.

Packaged and development resource lookup are different contracts. Use packaged helper paths only when `process.resourcesPath` exists **and** `process.defaultApp` is false; verify both a source-tree Electron launch and the packaged App so a local run cannot accidentally search inside Electron.app.

Real Electron harnesses must not let their own infrastructure self-certify. Register a child immediately after spawn; clean it up across discovery, CDP connect/enable/reload/readiness failures; latch both unexpected process exit and CDP failure; check that latch before/after every stage and before the final green line; compare against a fixed expected stage count.

Classify a real-Electron process signal before editing product code. A sandbox-denied GUI launch can exit with `code === null` and `SIGABRT`; rerun the identical probe in the approved unsandboxed GUI context and record both outcomes. Only a failure that reproduces there is product or harness evidence.

When an integration assertion fails after the product boundary already succeeded, verify that the test compares against runtime authority rather than fixture metadata. Preserve the red run, classify the faulty assertion, and rerun only after the test has been corrected; do not patch product code to satisfy an undefined or incidental fixture field.

When replacing a production synchronization primitive, search the test harness and diagnostics for every old wait/read before sign-off. Tests must call the new authority boundary; waiting on a removed private queue can overlap later work and create false performance or stale-state failures.

For macOS packages, sign nested executable code before the outer App and verify each nested executable independently after ZIP extraction. `codesign --deep` on the outer bundle is not evidence that code stored in an unexpected location is signed. Keep `LSMinimumSystemVersion` aligned with every Mach-O slice, and bind generated native binaries to their source hash in release evidence. Create ZIPs with `ditto --norsrc`, assert there are no `._*` AppleDouble entries, and verify an App extracted by standard `unzip`; a `ditto`-only round trip can hide a broken archive.

For fd-backed preflight, validate the opened descriptor's access mode as well as identity and permissions; adversarial tests must also attack failures after the private artifact is created, not only the pre-create path.

Build evidence is one hash chain, not parallel digests: attest the signed helper during the build, prove the App helper and standard-`unzip` helper equal that digest, and never re-sign the attested helper during outer-App signing.

For destructive filesystem work, an `lstat` followed by path-based `unlink` is not an identity guarantee. Move the path into a private unpredictable transaction quarantine, revalidate inode, size, canonical parent, and content digest, then remove only the quarantined identity. Snapshot deletion must bind content identity as well as inode; same-inode rewrites and late replacements fail closed. Once a mutation is committed, its exact retry truth must outlive the live capability TTL until fsync/partial recovery reaches a terminal state.

When a create syscall does not atomically return an fd, post-open `stat` checks prove only the object currently at the name, not that this process created it. Do not mutate, write receipts, or clean up before eligibility is established. Random names reduce likelihood but do not prove ownership. If the accepted threat model still includes an indistinguishable same-UID replacement, record that residual explicitly and change the protected-parent or privilege architecture before claiming closure; repeated after-the-fact checks are not a substitute for an atomic primitive.

Tests must derive expectations from the production contract, not incidental ordering. If production sorts candidates by metadata, a race/fault injection must target the first candidate actually processed or explicitly control the metadata; never assume fixture creation order. Before changing product code for a next-session failure, first prove whether the failure is implementation drift, environmental variance, or a brittle test assumption.

For strict structured model output, the prompt and scanner must state the same envelope: exact keys, first/last JSON characters, and no fences, peripheral prose, comments, or second object. Never strip or extract a plausible object locally. A bounded format retry may run only for an exact content-free classification, must not echo the rejected output, must revalidate every frozen dependency before the second provider call, and must stop after one retry. Confirm test entry paths from `package.json` or `rg --files tests` before invoking them; a remembered filename is not evidence.

Test-only helper bind and ordinary recovery budgets must be distinguished from injected operation deadlines. A one-second helper bind budget can fail only under the full compile/spawn load while focused tests stay green; preserve the red run, keep the production timeout unchanged, name the broader test bind/recovery budget accurately, and retain the short post-readiness deadline that creates the intended crash or unknown outcome. Do not call a shared test worker timeout “startup-only” when it also bounds ordinary requests.

Real-author acceptance is an explicit privacy boundary. Validate only an author-selected project; never crawl unrelated home folders to find a convenient manuscript. Preflight must remain read-only and path/content-free, and testing must use an isolated working copy whose source snapshot is proven unchanged. Synthetic fixtures can verify mechanics but can never count as author evidence.

An isolated npm/App profile also isolates credential configuration. Before a real AI acceptance journey, preflight only the public configured/not-configured status for the exact profile that will launch the App; never read, copy, print, or silently migrate the Key. A sub-100 ms `NO_KEY` failure is pre-provider evidence, not a provider/model-quality failure. Preserve zero-write evidence, switch to an already authorized configured profile or let the owner configure it, and record any generic Renderer fallback that hides the stable error code as a UX defect.

A stable pre-provider error must lead to an executable recovery action, not a generic retry. For `NO_KEY`, state that no AI call or file write occurred, open the existing Settings surface, and preserve the in-progress author form across that detour. Test the error copy, action routing, and retained draft together.

A fresh author copy may legitimately inherit private `.writcraft` History and metrics from its source. Bind journey evidence to the copy manifest `createdAt`: only later events and History entries count as the fresh run. Report inherited totals separately or omit them; never inflate a real-author sample with pre-copy activity.

Destructive History UX must identify the exact target at the decision point. Mark the newest record, name single-file paths directly, and warn separately when an author selects a non-latest record or `edit.md` because that changes the Project Prompt used by later AI calls. A generic file count, identical button labels, or a confirmation that omits the target is a P1 anti-misoperation gap; a green storage transaction does not make the user journey safe.

Progress UI is part of the operation authority boundary. A local History undo must never reuse AI-generation copy or leave an AI timer/generation flag alive after its promise settles. Name the actual operation, state whether AI/network is involved, and clear timers, busy controls, and generation state on every success, failure, cancellation, and recovery path. Real-Electron tests must assert both the terminal status and the absence of stale in-flight UI.

For filesystem copy/publish workflows, freeze the complete read/copy/commit matrix before implementing the happy path. Eligibility and copied bytes must come from one authoritative snapshot; bind every source ancestor and destination parent/stage identity; make the final source recheck the last pre-commit action; publish with atomic no-clobber semantics; and reconcile committed-then-threw outcomes from disk. `O_NOFOLLOW` protects only the final path component, and `existsSync` followed by `renameSync` is neither ancestor-safe nor no-clobber. Add adversarial tests for each boundary before treating full-suite green as sign-off.

Treat an external filesystem helper as a three-state transaction: proven uncommitted, proven committed, or unknown. If both the primary result and independent reconciliation are unavailable, report committed-risk and never enter precommit cleanup. Moving work into a native helper does not make `mkdir→open` atomic; attack the exact syscall gap or document the residual explicitly. Random names reduce likelihood but do not prove inode ownership.

Never erase a red integration run with a green retry. Record both, inspect the failed boundary, and keep a flake as an explicit P2/TODO until its timing cause is explained or repeated clean runs justify closing it. A retry is evidence about nondeterminism, not proof that the first failure was harmless.

## Commit & Pull Request Guidelines

Local Git history begins with the 2026-07-26 V0 baseline, so it does not describe earlier development conventions. Use concise imperative commits, for example `fix(onboarding): preserve committed state`. Keep source, tests, and affected documentation in the same commit. PRs should explain user impact, authority/state-machine changes, tests run, and remaining risks; include screenshots for UI changes and never attach secrets or stale release artifacts.

The public GitHub remote is `https://github.com/MaxHou-infinity/WritCraft.git`, with local `main` tracking `origin/main`. A local commit or merge is still not public until its exact commit is pushed and verified on GitHub. Never change repository visibility, rewrite public history, publish a release, or push credentials/artifacts without explicit authorization.
