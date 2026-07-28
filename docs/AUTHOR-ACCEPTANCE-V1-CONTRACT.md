# WritCraft V0 · Real Author Acceptance v1

> Status: **frozen contract; local technical prerequisites remain signed, while real-author and paid acceptance remain open**. Current evidence is author preflight **48/48**, real-API offline **15/15** (**63/63, 0 network**), native worker **18/18**, Watcher **31/31**, package **8/8**, local release **7/7**, full test/verify, Persistent **3/3**, forced Electron **33/33**, and independent review **P0=0/P1=0/P2=0**. The configured credential is Coding Plan and the recent project remains ineligible; real-author and paid gates remain closed.
> Boundary update: 0.0V traverses below a bound project-root fd, 0.0W adds an exact 16 MiB serialized-request cap, and 0.0X binds every external project-root component from a trusted filesystem-root fd and revalidates the chain before and after each batch. This closes the former initial root-open race after Main identity capture; it does not cover pre-selection state, make `readdir`/`fs.watch` atomic, prevent a same-UID writer using an already-held fd, or remove the 0.0U same-UID 0700 empty-directory residual.

Research accuracy instrumentation is governed by `RESEARCH-ACCURACY-V1-CONTRACT.md`; it records the author’s match judgment, never a platform truth score.

## 1. Project and privacy boundary

Use an author-owned working copy containing `edit.md`, at least five chapter Markdown files, source material, and at least 2,000 visible Chinese characters. Take a reversible snapshot before testing. The application may persist only normal project files, `.writcraft` metadata, generated assets, and Change History.

Evidence may contain timestamps, stable error codes, durations, token counts, file counts, character counts, acceptance decisions, ratings, and before/after SHA-256 revisions. It must never contain API keys, prompts, answers, manuscript text, model text, quotes, base64, absolute paths, or key fingerprints. Samples below 20 must be labelled directional.

### 1.1 Safe project preparation

Preflight is read-only and prints only the allowlisted counts, stable errors, and snapshot digest:

```bash
npm run acceptance:author:prepare -- --project "/author-selected/project"
```

After it is eligible, create a separately named working copy in an author-selected parent:

```bash
npm run acceptance:author:prepare -- --project "/author-selected/project" \
  --copy-to "/author-selected/acceptance-parent" --name "WritCraft 作者验收"
```

`src/main/author-acceptance-preflight-service.js` enforces a valid root `edit.md`, at least five Markdown files under `chapters/`, 2,000 visible Chinese characters, and at least one `references/` file. Its synchronous CLI-only transaction binds cwd and source/destination identities, reads eligibility and copy bytes from one scan, and prepares a random private stage with an invalid manifest. Main passes an anonymous `0600 O_RDWR` receipt fd 5 to the helper; after exact stage identity and parent fsync, the helper writes and fsyncs the receipt. Lost stdout/status can therefore recover only the recorded `{name,dev,ino,mode}`; lost stdout plus lost receipt fails closed and leaves the unknown stage untouched. The helper rejects a missing/read-only receipt before `mkdirat`; after identity is known, a parent-fsync or receipt-write failure rechecks exact identity before cleanup and never adopts/deletes a replacement. It then commits readiness while the stage is private, performs the final source scan, and uses a parent-fd-relative macOS `renameatx_np(RENAME_EXCL)` helper to publish atomically without clobbering. Primary and secondary helper evidence form a three-state commit truth; unknown publication is reported as committed-risk and never enters precommit cleanup. A postcommit scan reports the narrow commit-window source race. Do not scan unrelated home folders or treat fixtures as author evidence.

## 2. Paid-network gate

Opening settings or the acceptance UI must not cause network traffic. Real calls require the author-configured credential and an explicit gate:

```bash
WRITCRAFT_REAL_API_ACCEPTANCE=1 npm run acceptance:api
WRITCRAFT_REAL_API_ACCEPTANCE=1 WRITCRAFT_REAL_API_SCOPE=image WRITCRAFT_REAL_API_IMAGE=1 npm run acceptance:api
```

The image run additionally requires a complete `sk-api-` credential and may consume paid quota. Coding Plan credentials are text-only for this product boundary.

## 3. Required journeys

1. **Project definition:** submit the project card with the real provider. A malformed or incomplete structured response preserves all answers and offers a manual retry. A successful proposal leaves disk unchanged until the author reviews and accepts the `edit.md` ChangeSet. Acceptance must change the authoritative revision, create History, reload `edit.md`, and require a separate confirmation before creating suggested files.
2. **File and paragraph work:** complete one Inline Rewrite reject, one accept, Safe Undo, one chapter proposal, and one Plan task handoff. Preview and rejection are zero-write; accepted changes survive restart.
3. **Research:** inspect Claim / Source / Boundary, explicitly rate evidence as matching or not matching, then accept or reject a Research→Changes proposal. Exact-quote validation proves location only, not factual truth.
4. **Image:** generate `image-01`, verify decoded dimensions/aspect ratio and local asset persistence, give a 1–5 quality rating, then explicitly insert, keep, or move the exact asset to recoverable project trash. Generation alone must not modify Markdown. Generic metrics record latency/safe outcome; the separate review record contains only operation, rating, terminal decision, optional manually checked cost/currency, and time.
5. **Graph and recovery:** inspect people, variables, relations, and time; open both sides of a conflict; make one author correction; send one issue to Changes; restart and verify corrections, History, tabs, current file, and accepted manuscript changes.

## 4. Sign-off criteria

- No silent manuscript write, cross-project result, stale apply, secret/content log, or unresolved P0/P1.

### 7.1 Current blocking review matrix (2026-07-27)

Before any real-author copy is created, implementation and adversarial tests must prove:

1. eligibility and copied bytes derive from one authoritative source snapshot;
2. source ancestor identities remain bound, and the final source recheck is the last pre-commit step;
3. destination parent/stage identities cannot be replaced to redirect writes;
4. publication is atomic no-clobber rather than `existsSync` followed by replacing `rename`;
5. committed-then-threw publication is reconciled from disk and never reported as an ordinary pre-commit failure;
6. internal resource bounds cannot exceed contract maxima and duplicate CLI arguments fail closed.

The current 48/48 suite dynamically exercises snapshot and ancestor replacement, stage identity, private readiness, parent-fd publication, no-clobber, exact cleanup, mode/empty-directory fidelity, committed-then-threw, lost/malformed helper reports, committed-unknown truth, universal binary shape, successful operation with an empty `PATH`, and rejection of embedded-NUL/trailing helper input before mutation. It additionally proves missing/read-only reserve receipt rejection before stage creation, stdout/status recovery from a durable exact receipt, dual-evidence fail-closed preservation, replacement non-adoption/non-deletion, 0755 pre-open replacement rejection without mutating either directory, and shared/setgid parent compatibility. The bundled author-copy and project-hash helpers share a signed source/build/App/standard-unzip ZIP attestation chain. Project hashing has an independently tested 16 MiB serialized cap, trusted-root external-ancestor traversal, deterministic async-close handling, and module-local constructor error redaction. The same-UID 0700 reserve micro-window remains an accepted separate residual. Real-author execution still requires an eligible user-selected project, complete `sk-api-` credential, explicit user gate, a fresh post-journey release build, and independent review.
- Onboarding structured success/failure and manual-retry outcomes, Inline acceptance, Plan use/task adoption, Research accuracy/adoption, and image generation/adoption are visible as private project-scoped aggregates.
- Full `npm test`, Electron-enabled `npm run verify`, forced Electron E2E, and an independent review pass after the real journey.
- Only then rebuild from current source, run `npm run release:verify`, test Finder launch on a clean macOS account, and proceed to signing/notarization/Gatekeeper review.
