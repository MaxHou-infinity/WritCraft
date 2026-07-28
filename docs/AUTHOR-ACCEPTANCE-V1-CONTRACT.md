# WritCraft V0 · Real Author Acceptance v1

> Status: **frozen contract; 0.0S local reserve/build-attestation closure passed third independent review at P0=0/P1=0/P2=3**. Current evidence (2026-07-28): author preflight **47/47**, real-API offline contract **15/15** (**62/62, 0 network**), package **8/8**, local release **7/7**, `npm test` and sandbox-external Electron-enabled `npm run verify` exit 0, Persistent Watcher **3/3**, and two consecutive same-source full Electron runs **32/32** after status diagnostics. The first Plan write timeout in this round did not recur, but its timing cause remains an explicit P2; later green runs do not erase it. The configured credential is Coding Plan and the recent project fails the five-chapter/2,000-character/source requirements; real-author and paid gates remain closed.
> 0.0S boundary: Main owns an anonymous `0600 O_RDWR` reserve receipt on fd 5. The helper verifies it before any `mkdirat`, then writes and fsyncs the exact stage identity only after identity verification and parent fsync. Lost stdout/status can recover only from that receipt; missing dual evidence fails closed and preserves the unknown stage. Read-only receipt input is rejected pre-mutation; a known identity after parent-fsync/receipt-write failure is rechecked before cleanup, never adopted or deleted after replacement. Build signature is now part of the recipe and attestation binds build helper → App helper → ZIP helper/full App tree. Local ad-hoc App/ZIP were rebuilt from current source but remain non-distributable. Third independent review is **P0=0/P1=0/P2=3**; the residual P2s are pure-Node ancestor traversal, the native `mkdirat→openat/fstat` micro-window, and the unexplained Plan-write timing.

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

The current 47/47 suite dynamically exercises snapshot and ancestor replacement, stage identity, private readiness, parent-fd publication, no-clobber, exact cleanup, mode/empty-directory fidelity, committed-then-threw, lost/malformed helper reports, committed-unknown truth, universal binary shape, successful operation with an empty `PATH`, and rejection of embedded-NUL/trailing helper input before mutation. It additionally proves missing/read-only reserve receipt rejection before stage creation, stdout/status recovery from a durable exact receipt, dual-evidence fail-closed preservation, and replacement non-adoption/non-deletion. The bundled Mach-O helper replaces the former `/usr/bin/python3 -I` runtime dependency; its build signature is included in the recipe and attested through the App helper, ZIP helper, and full App tree. Remaining known P2: pure-Node ancestor traversal, the native `mkdirat→openat/fstat` external-process micro-window, and the unexplained Plan-write timing. Real-author execution still requires an eligible user-selected project, complete `sk-api-` credential, explicit user gate, a fresh post-journey release build, and independent review.
- Onboarding structured success/failure and manual-retry outcomes, Inline acceptance, Plan use/task adoption, Research accuracy/adoption, and image generation/adoption are visible as private project-scoped aggregates.
- Full `npm test`, Electron-enabled `npm run verify`, forced Electron E2E, and an independent review pass after the real journey.
- Only then rebuild from current source, run `npm run release:verify`, test Finder launch on a clean macOS account, and proceed to signing/notarization/Gatekeeper review.
