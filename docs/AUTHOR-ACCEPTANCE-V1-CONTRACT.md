# WritCraft V0 · Real Author Acceptance v1

> Status: **frozen; evidence instrumentation and offline acceptance contract signed, pending real paid-API and author execution**. Current implementation evidence (2026-07-26): full Node and Electron-enabled verification exit 0, standard forced-Electron **31/31**, persistent-watcher real Main/IPC **3/3**, Diagnostic Export v1 and Changes/History durable recovery signed, Onboarding dynamic 22/22, and no open P0/P1/P2 in these signed engineering chains. Fixture, source-string, and stub-provider results cannot satisfy the real journey.

Research accuracy instrumentation is governed by `RESEARCH-ACCURACY-V1-CONTRACT.md`; it records the author’s match judgment, never a platform truth score.

## 1. Project and privacy boundary

Use an author-owned working copy containing `edit.md`, at least five chapter Markdown files, source material, and at least 2,000 visible Chinese characters. Take a reversible snapshot before testing. The application may persist only normal project files, `.writcraft` metadata, generated assets, and Change History.

Evidence may contain timestamps, stable error codes, durations, token counts, file counts, character counts, acceptance decisions, ratings, and before/after SHA-256 revisions. It must never contain API keys, prompts, answers, manuscript text, model text, quotes, base64, absolute paths, or key fingerprints. Samples below 20 must be labelled directional.

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
4. **Image:** generate `image-01`, verify decoded dimensions/aspect ratio and local asset persistence, then explicitly insert or discard it. Generation alone must not modify Markdown. Record only latency, safe failure class, author quality rating, adoption decision, and a manually checked provider-cost value.
5. **Graph and recovery:** inspect people, variables, relations, and time; open both sides of a conflict; make one author correction; send one issue to Changes; restart and verify corrections, History, tabs, current file, and accepted manuscript changes.

## 4. Sign-off criteria

- No silent manuscript write, cross-project result, stale apply, secret/content log, or unresolved P0/P1.
- Onboarding structured success/failure and manual-retry outcomes, Inline acceptance, Plan use/task adoption, Research accuracy/adoption, and image generation/adoption are visible as private project-scoped aggregates.
- Full `npm test`, Electron-enabled `npm run verify`, forced Electron E2E, and an independent review pass after the real journey.
- Only then rebuild from current source, run `npm run release:verify`, test Finder launch on a clean macOS account, and proceed to signing/notarization/Gatekeeper review.
