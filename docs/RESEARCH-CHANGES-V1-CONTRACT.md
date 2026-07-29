# Research → Changes v1 Contract

> Status: product chain and committed-warning boundary signed, P0 = 0 / P1 = 0 / P2 = 0. The forced Electron 20/20 result below is historical focused evidence, including reject-only and a true late-open A→B race; it is not the current project-wide total. The production Research apply transaction remains signed; project-wide current totals and restart order live only in `v0/DEVELOPMENT-STATUS.md`.
> Schema: `writcraft.research-handoff/v1`

## 1. Product journey

1. The user selects 1–8 Sources and asks a Research question.
2. Main returns bounded Claim / Source / Boundary cards from authoritative snapshots.
3. The user opens the exact quote, then makes the explicit author judgment **主张匹配** or **主张不匹配**. The judgment protocol, privacy boundary and recorded-but-locked behavior are defined by `RESEARCH-ACCURACY-V1-CONTRACT.md`.
4. Only a successfully persisted, current **主张匹配** judgment unlocks “带入修改”. A persisted mismatch, stale evidence, watcher-degraded project, failed record, or recorded-but-locked result keeps Changes locked; the author may correct the verdict through the Accuracy contract.
5. Changes enters an exclusive Research mode, resolves the card again from Main, locks its display, and asks the user to select 1–8 writable targets.
6. Main reconstructs all evidence by `cardId`, generates localized Changes, and returns preview-only review data.
7. Disk content changes only after an explicit Changes decision. Apply revalidates every frozen dependency.

A–D grades are metadata declarations, not truth scores. User confirmation means “reviewed”, not “verified by WritCraft”.

## 2. Renderer request and Main authority

The exact handoff request is at most 8 KiB:

```json
{
  "schema": "writcraft.research-handoff/v1",
  "cardId": "rc_0123456789abcdef0123456789abcdef",
  "targetPaths": ["chapters/01.md"]
}
```

`cardId` is the only evidence authority. It matches `^rc_[a-f0-9]{32}$` and is generated from 128 bits of cryptographic randomness. `targetPaths` are only the user's write-scope authorization. Renderer must never submit claim, boundary, source identity/path/revision, quote, locator, grade, instruction, target revision, root path, run ID, binding digest, or model context.

Main owns the current project/root, canonical card, source mapping and grade, exact quote/locator, `edit.md`, target snapshots, prompt, localized parsing, ChangeSet, provenance, and review capability. Claim and boundary remain untrusted model data even when Main stores them: the second model prompt JSON-encodes and delimits them as data, never as instructions.

Paths are POSIX-relative, NFC-normalized, case-folded for duplicate/overlap checks, and resolved through guarded no-symlink project APIs. `edit.md`, `references/**`, `sources/**`, and the selected evidence source itself are read-only. Alias, case-only, Unicode-equivalent, inode or symlink overlap fails closed.

## 3. Canonical store, lifecycle and ownership

After Research succeeds and late validation passes, Main stores canonical cards keyed by `cardId`. Internal records include `rr_[a-f0-9]{24}` run ID, binding digest, project instance/root, in-flight mutation generation, selected-source mapping/digest, exact evidence, bounded card data, retry count, absolute `expiresAt`, and current child capability/lease.

The store uses injectable clock/ID factories, at most 16 runs, 256 cards and 2 MiB serialized canonical data, with a per-run limit of 20 cards/256 KiB. Records expire after two hours; LRU eviction is terminal. Main holds one active-run pointer per project. When a new Research request is admitted, Main—not Renderer—atomically terminates the previous READY run and all owned children before installing the new run. A prior GENERATING or REVIEW card blocks a new run with `RESEARCH_RUN_ACTIVE`; it must first be canceled/discarded explicitly. Project close/switch clears records and owned children. Global Source Index revision is audit metadata only: unrelated-source drift does not stale a card. Durable validity compares the selected source ID→path/revision/metadata-grade digest and exact quote; mutation generation only fences in-flight work.

```text
READY → GENERATING → REVIEW_PENDING_ACK → REVIEW → CONSUMED
  ↑          │                 │              │
  └─ retry ──┘                 └─ ack timeout └─ cancel after child revoke

Terminal: STALE · EXPIRED · DISCARDED · FAILED
```

Admission creates an exclusive request lease and abort controller. Concurrent/replayed leases fail. A card stores `issuedCapability` before a review can be returned. It first enters `REVIEW_PENDING_ACK`; Renderer must acknowledge the exact card/capability after safe review transfer within 30 seconds. Timeout, sender destruction, renderer-process loss, or main-frame reload/navigation revokes the child and returns the card to `READY` only while dependencies/retry rules remain valid. Main binds records to the trusted `webContents` owner and navigation epoch; it never waits for the two-hour TTL to recover a dead Renderer. Apply is accepted only in `REVIEW`.

Apply/discard/cancel, rerun, TTL/LRU prune, project switch and exception cleanup revoke both sides atomically. A Research `pc_*` and every residual inherit the original absolute expiry; `get` and apply prune expired entries.

Only Main-classified retryable failures (`NO_KEY`, `AUTH_FAILED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`, `TIMEOUT`, `REQUEST_ABORTED`, `REQUEST_FAILED`, `NO_TEXT_BLOCK`, `INVALID_MODEL_OUTPUT`) may return to `READY`, and only when the lease still owns the card, no capability/write exists, all dependencies remain current, and retry count is below 2. Project/source/edit/target drift is `STALE`; expiry is `EXPIRED`; unknown exceptions are `FAILED`. A valid no-op is `CONSUMED`.

`cancelResearchHandoff(projectInstanceId, cardId)` aborts a matching generation or revokes its un-applied child, then returns to `READY` only if the retry rules pass. `discardResearchCard` is terminal. Renderer never enumerates or decides which prior-run cards survive a rerun; the Main active-run transition above is authoritative.

## 4. Main-only dependencies and validation gates

Pending Changes stores a strict, frozen `researchDependencies` authority separate from public provenance:

- project instance/root binding, internal run ID, card ID and binding digest;
- source ID/path/revision, exact UTF-16 offset/end/quote and metadata-grade digest;
- `edit.md` path/revision;
- ordered target paths/revisions;
- absolute expiry and current child capability.

Main validates at four boundaries:

1. **Before model:** exact request/store/lease, current project, selected-source mapping, exact quote/locator, `edit.md`, target allowlist/revisions and byte budgets.
2. **After model:** origin ownership plus fresh evidence, `edit.md` and targets before capability allocation.
3. **Before apply:** atomically lease and burn the valid old `pc_*` use attempt; repeat expiry, evidence/locator, `edit.md` and target validation. Foreign-project or malformed decisions cannot burn another project's token.
4. **After commit, before residual:** revalidate evidence mapping/quote, `edit.md`, and remaining targets. Refresh only actually applied target revisions. A new residual receives a new capability with the original expiry.

If writes/history committed but post-commit validation or residual caching fails, return `ok:true`, authoritative `applied`, and `residualUnavailable/refreshRequired`; never report ordinary failure, mint a stale residual, or allow replay of the old decision.

The production transaction dynamically proves this boundary against real scratch-project writes and History. Coverage includes source/edit/target drift, absolute expiry, residual cache and finish failures (including failure after the card already entered `REVIEW`), tree refresh, reject-only review History, result-reading faults, conflict, History rollback, provenance retention, old-child replay rejection and undo.

Stable terminal errors include `INVALID_RESEARCH_HANDOFF`, `RESEARCH_CARD_NOT_FOUND`, `RESEARCH_HANDOFF_BUSY`, `RESEARCH_HANDOFF_CONSUMED`, `RESEARCH_HANDOFF_STALE`, `RESEARCH_HANDOFF_EXPIRED`, `RESEARCH_HANDOFF_FAILED`, and `SOURCE_TARGET_CONFLICT`.

## 5. Response, provenance and history

No-op and review responses both include `proposalKind: "research_card"` and Main-authored provenance whose `schema/kind/cardId` must match the active Renderer transaction. A no-op has no capability and consumes the card. A review response additionally contains `changeSetId`, review and file count; Renderer acknowledges that exact pair only after the review becomes its active pending identity.

Internal dependencies keep the complete quote (maximum 2,000 characters). Public/review/history provenance is at most 16 KiB and contains internal run/card/binding identifiers, original `expiresAt`, source ID/path/revision, locator, grade/grade rule, `sha256:` quote digest, a maximum 240-character excerpt, and target path/revision—never the question, full quote, claim, boundary, prompt, file content, absolute path or API key.

Change history upgrades to `writcraft.changes/v3`. V1/V2 load in memory as V3 with `provenance: null`; new application and reject-only review records require bounded `provenance`. Integrity covers provenance. Residual, final history, public history and undo retain the same Research provenance and original expiry identity.

## 6. Renderer state and old-path removal

The old path is removed: preload no longer exposes a full-evidence `validateResearchEvidence`, `sources-view.js` no longer concatenates Research prose into `openWithInstruction`, and normal Changes cannot claim Research provenance. Read-only card/source resolution accepts only `(projectInstanceId, cardId)` and Main reconstructs the locator.

Research mode is exclusive with normal, Plan, Graph, Chapter, Onboarding and an existing review. It displays locked Claim / Source / Boundary plus “来源只读” and “当前仅生成预览”; its data is refreshed by card ID from Main. The free-form instruction is hidden/disabled.

Before handoff, Renderer calls `persistCurrent(true)`. After that save it captures the current editor binding: project instance, current path, editor session, `editVersion`, dirty generation/state, and ordered target fingerprint. It rechecks the binding immediately before IPC and after IPC, settle and review transfer. If the open file is a target, any input/editVersion/dirty/session change—including typing after persist without autosave—invalidates the transaction and invokes Main cancel; if autosave reaches disk, Main's target revision gate independently catches it. The same save-and-binding gate runs before apply so an unpersisted target draft cannot be overwritten.

The transaction also binds card ID, pending identity, proposal epoch and destroyed state. Project switch, Main-authoritative rerun, detach, destroy, target/scope change or newer proposal invokes Main cancel/discard. Any late `pc_*` is discarded against its origin project. Cancellation cleanup is all-settled so one failed revoke does not block the other.

## 7. Acceptance gates

Required coverage includes:

- exact schema, ID entropy/regex, injection/oversize, forged/missing/cross-project/expired/concurrent/replayed cards;
- clock/LRU/card/byte/retry limits, lease/abort, delivery-loss and card↔capability cleanup;
- selected-source mapping/metadata, quote/locator, `edit.md` and target drift before/after model, before apply and post-commit;
- reserved/alias/source-target overlap and unrelated Source Index drift;
- strict pending dependencies, expiry inheritance, no-op/provenance match, residual replacement and committed-warning faults;
- full-text strict JSON plus `stopReason: end_turn` for both initial Research cards and the localized handoff; preview and failure paths produce zero disk writes;
- 30-second review delivery acknowledgement, wrong/stale ack rejection, sender reload/crash cleanup and retry without waiting for TTL;
- Renderer persist failure and every project/rerun/detach/destroy/target-change/late-result race, including `persist → unsaved typing → late result` with zero surviving capability;
- V1/V2→V3 history migration, provenance integrity/size/privacy, application/reject-only/undo retention;
- forced Electron: Research → confirmation → dedicated Changes → preview zero-write → accept/reject → history → undo, including stale and A→B races.

Sign-off order: service/store → Main/preload/apply/history → Renderer state/UI/dynamic → independent review → full `npm test`/`npm run verify` → forced Electron → current-source App manual journey.
