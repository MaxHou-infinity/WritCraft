# WritCraft V0 · Real Author Acceptance v1

> Status: **frozen contract; `writ-craft@0.1.1` Developer Preview is public, while real-author acceptance remains open and is the sole `RM-1.0 / 0.1.2` target**. Project Card, Inline, and Chapter are closed. The seventh-copy Plan now has eight zero-write failures. Latest operation `b915291982d14f8bb5520674280b3d0d` reached a structured tool input in 13,590 ms but put natural-language prose in the first task's dependency array; Main rejected it with before/after 0 and no Plan, task card, manuscript or History write. 0.0BX requires exact short ASCII milestone/task IDs and prior-task dependencies in Schema and Main, never trims or repairs them, and shares one bounded retry across array and dependency structure failures without a third call. Plan 26/26, handoff 15/15, UI 16/16, full test/verify and forced Electron 37/37 pass; independent review is P0/P1/P2=0. Candidate restart and one new provider canary remain required. The default model remains MiniMax-M3 and the local Plan context gate remains eight explicit files/240 KiB. The author must not repeat Project Card, Inline or Chapter, or click the stale error page's retry before the new candidate is restarted. Research, the authorized image journey, and Graph/recovery remain open; none of this authorizes publication.
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

The image run may consume Token Plan quota or paid Credits. Both `sk-cp-` and `sk-api-` credentials are admitted locally; actual `image-01` capability is decided by the provider plan and current quota, never inferred from the key prefix.

## 3. Required journeys

1. **Project definition:** submit the project card with the real provider. A malformed or incomplete structured response preserves all answers and offers a manual retry. A successful proposal leaves disk unchanged until the author reviews and accepts the `edit.md` ChangeSet. Acceptance must change the authoritative revision, create History, reload `edit.md`, and require a separate confirmation before creating suggested files.
2. **File and paragraph work:** complete one Inline Rewrite reject, one accept, Safe Undo, one chapter proposal, and one Plan task handoff. Preview and rejection are zero-write; accepted changes survive restart. Chapter generation may normalize only transport CRLF/outer line breaks and may regenerate the current block at most once for a classified content-boundary failure after dependency revalidation. It must not repair strict JSON/schema/id errors, echo rejected model content, reuse a stale dependency, or create a partial review/write.
3. **Research:** inspect Claim / Source / Boundary, explicitly rate evidence as matching or not matching, then accept or reject a Research→Changes proposal. Exact-quote validation proves location only, not factual truth.
4. **Image:** generate `image-01`, verify decoded dimensions/aspect ratio and local asset persistence, give a 1–5 quality rating, then explicitly insert, keep, or move the exact asset to recoverable project trash. Generation alone must not modify Markdown. Generic metrics record latency/safe outcome; the separate review record contains only operation, rating, terminal decision, optional manually checked cost/currency, and time.
5. **Graph and recovery:** inspect people, variables, relations, and time; open both sides of a conflict; make one author correction; send one issue to Changes; restart and verify corrections, History, tabs, current file, and accepted manuscript changes.

Any destructive History control must identify the exact target before confirmation. The newest record must be visibly distinguished; undoing a non-latest record must state that fact; undoing `edit.md` must explicitly warn that the Project Prompt and subsequent AI context will change. A generic file count or repeated “safe undo” label is not sufficient author evidence.

## 4. Sign-off criteria

- No silent manuscript write, cross-project result, stale apply, secret/content log, or unresolved P0/P1.

### 4.1 Technical preparation matrix (signed before real-author execution)

Before any real-author copy is created, implementation and adversarial tests must prove:

1. eligibility and copied bytes derive from one authoritative source snapshot;
2. source ancestor identities remain bound, and the final source recheck is the last pre-commit step;
3. destination parent/stage identities cannot be replaced to redirect writes;
4. publication is atomic no-clobber rather than `existsSync` followed by replacing `rename`;
5. committed-then-threw publication is reconciled from disk and never reported as an ordinary pre-commit failure;
6. internal resource bounds cannot exceed contract maxima and duplicate CLI arguments fail closed.

The historical focused 48/48 suite dynamically exercises snapshot and ancestor replacement, stage identity, private readiness, parent-fd publication, no-clobber, exact cleanup, mode/empty-directory fidelity, committed-then-threw, lost/malformed helper reports, committed-unknown truth, universal binary shape, successful operation with an empty `PATH`, and rejection of embedded-NUL/trailing helper input before mutation. It additionally proves missing/read-only reserve receipt rejection before stage creation, stdout/status recovery from a durable exact receipt, dual-evidence fail-closed preservation, replacement non-adoption/non-deletion, 0755 pre-open replacement rejection without mutating either directory, and shared/setgid parent compatibility. The bundled author-copy, project-hash, and Markdown-trash helpers share a signed source/build/App/standard-unzip ZIP attestation chain. Project hashing has an independently tested 16 MiB serialized cap, trusted-root external-ancestor traversal, deterministic async-close handling, and module-local constructor error redaction. Markdown trash adds fd-relative journal recovery and committing-rename ancestor revalidation. The same-UID 0700 reserve micro-window remains an accepted separate residual. Final real-author sign-off requires an eligible user-selected project, explicit user gate, an exact `0.1.2` candidate commit, and a fresh isolated copy. Any later production-code change invalidates affected journey evidence and requires a new candidate plus a new isolated-copy rerun; documentation-only closeout may follow the candidate.
- Onboarding structured success/failure and manual-retry outcomes, Inline acceptance, Plan use/task adoption, Research accuracy/adoption, and image generation/adoption are visible as private project-scoped aggregates.
- Full `npm test`, Electron-enabled `npm run verify`, forced Electron E2E, and an independent review pass after the real journey.
- Only then may the project sign off the already committed and journey-bound `0.1.2` candidate and request separate npm/GitHub publication authorization. The candidate must exist before the final journey as required above and by `ROADMAP.md` §10; this step approves its evidence rather than creating or changing it. The existing 0.1.1 Developer Preview remains immutable; Developer ID/notarization/Gatekeeper are deferred unless a standalone macOS App is later distributed.
