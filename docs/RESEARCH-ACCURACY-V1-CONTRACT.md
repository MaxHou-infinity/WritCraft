# WritCraft V0 · Research Accuracy v1

> Status: **signed; persistent-watcher regression closed, final independent review P0=0/P1=0/P2=0**. Transaction ordering, watcher fail-closed behavior, commit-boundary authority, exact-project degraded gates, same-root recovery and Renderer recorded-but-locked semantics passed independent review. As historical focused evidence for this contract, full Node/verify exited successfully, the standard controlled forced Electron E2E completed **30/30**, and the real Main/IPC persistent-restart-failure zero-side-effect harness completed **3/3**. Project-wide current totals live only in `v0/DEVELOPMENT-STATUS.md`; real-author Research judgment samples remain open under `RM-1.1 / 0.1.2`.

## 1. User journey

1. The author runs Research and opens the card’s Main-resolved source location.
2. Only after the authoritative source opens may the author choose **主张匹配** or **主张不匹配**.
3. A successful **主张匹配** judgment enables Research→Changes. **主张不匹配** is recorded but keeps Changes locked; the author may correct the judgment, and the latest value replaces the earlier value instead of creating a second sample.
4. Evidence already stale at the commit-boundary revalidation, project switching, destroyed UI, failed persistence, or an unknown card leaves the judgment unrecorded and Changes locked. If evidence changes only after that linearization point, the historically valid judgment may remain recorded, but the card must stay locked and the UI must say that the evidence changed after recording.

## 2. Authority and persistence

- Renderer sends only the current project instance plus an exact `{ schema, cardId, verdict }` request.
- Main re-resolves the live Research card, source revision, grade and exact quote before recording.
- The final revalidation immediately before the atomic metrics rename is the judgment linearization point. A post-commit authority check controls only whether the exact card may be rebound and handed to Changes; it must not silently reinterpret a previously valid historical judgment.
- The card capability supplies the stable operation identity. Repeated submissions are idempotent; changing the verdict atomically replaces that card’s prior judgment.
- Persistence reuses `.writcraft/metrics.json` and its v1 fixed event shape. No new manuscript or public project file is written.

## 3. Privacy and aggregation

Stored events retain only the existing fixed fields. They never contain the claim, quote, question, source title, filename, path, model text, prompt, error text or API key.

The aggregate exposes only sample count, matched count, mismatched count, match rate and the existing small-sample warning. Research→Changes adoption remains a separate metric; accuracy judgments must not change the global AI suggestion acceptance rate.

## 4. Sign-off gates

- Main service: exact schema, canonical-card validation, idempotency, correction replacement, old v1 compatibility, corruption/symlink safety and aggregate semantics.
- Renderer: source-open prerequisite, explicit mutually exclusive choices, failure/stale messaging, A→B and late-result ownership, and locked Changes until persistence succeeds.
- Integration: trusted sender, current project, narrow preload bridge, aggregate-only readback and fixed-field privacy.
- Final: directed tests, independent review, full `npm test`, Electron-enabled `npm run verify`, forced Electron E2E, then documentation synchronization.

## 5. Signed security gates

- Do not suppress a filename-less watcher event merely because public Markdown fingerprints compare equal. A delayed external event can otherwise be mistaken for an internal metrics echo.
- Revalidate the canonical card, live source revision, grade and exact quote at the atomic metrics commit boundary. A stale judgment must produce zero persisted sample and keep Changes locked.
- Restart the watcher before the post-commit fingerprint/authority check. Any change after the linearization point keeps the exact card locked even if the historical sample was already committed; sibling cards must never be rebound.
- A persistent watcher restart failure must mark the exact project instance/root degraded. Subsequent project AI and mutable operations fail with `PROJECT_WATCHER_UNAVAILABLE` until a reopened project instance successfully starts its watcher.
- Reopening the same canonical root is an explicit watcher recovery attempt even though its root-derived `instanceId` is stable. It must not reset health first: restart success clears the exact degraded binding; restart failure preserves it.
- Every direct or pre-model private write must cross the same gate. This includes Inline apply, an already-current legacy `edit.md` migration confirmation, Graph Issue indexing/reconciliation, and Inline reconciliation marker/history repair or clearing. A first legacy migration with no current project remains valid and establishes its watcher through the subsequent authoritative open.
- Renderer unlocks handoff only for an exact successful result with `recorded`, `handoffAvailable === true`, and `evidenceChanged === false`. A committed historical sample with changed evidence remains visible but permanently locks the old card.
- Adversarial coverage now includes delayed external filename-less events, private metrics debounce timing, source mutations at stop/commit/restart boundaries, one-shot and persistent watcher restart failure, an existing mutation, owner/navigation/state changes, same-run sibling isolation, degraded AI/write blocking, new-instance clearing, and recorded-but-locked Renderer behavior.
- The repository’s real Main/IPC harness launches isolated Electron processes, enters persistent watcher degradation, and proves rewrite apply, Graph Issue handoff, Changes recovery query/clear, and same-root legacy confirmation fail before any public or private project byte changes. A first migration with no current project remains atomic and permitted.
