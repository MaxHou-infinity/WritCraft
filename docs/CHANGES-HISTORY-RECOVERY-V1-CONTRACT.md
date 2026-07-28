# Changes / History Recovery v1 Contract

> Status: **implemented and signed on 2026-07-26; final review P0=0/P1=0/P2=0**
> Scope: ordinary Changes apply, reject-only review audit, History undo, process/Renderer response loss, and post-commit bookkeeping failure. Research and Inline retain their signed higher-level protocols but must obey the same project mutation guard.

## 1. Product truth

A failed IPC response is not proof that manuscript files were unchanged. Before the first manuscript or History write, Main must persist one project-scoped transaction marker at:

`/.writcraft/recovery/changes-history-transaction.json`

The marker is recovery intent, not manuscript truth. It binds a high-entropy operation ID, project ID, operation kind (`apply`, `review`, or `undo`), pending capability where applicable, exact affected paths, operation-before/after revisions and contents, the validated base History, the prepared History mutation, and timestamps. It never stores API keys, prompts, model responses, absolute paths, or renderer DOM.

One project may have at most one unresolved Changes/History transaction. Marker path, schema, byte limits, symlink/hard-link behavior, exact keys, NFC paths, revision hashes, History integrity, and atomic/fsync persistence fail closed.

## 2. State and authority matrix

The durable state is `applying` or `terminal`. Terminal outcomes are:

- `applied`, `reviewed`, or `undone`: every file and exact History state match the prepared transaction;
- `zero_write_error`: every file and History match the operation-before state;
- `committed_warning`: all manuscript files match operation-after but History remains at operation-before;
- `manual_recovery`: files are mixed/unknown, History contradicts files, or any authority cannot be proven.

Main never trusts the returned status from a write helper alone. It authoritatively rereads every affected file and the complete History after success, failure, thrown error, restart, or response loss.

`rollback_failed` and `history_failed_rollback_failed` are uncertain outcomes. They consume/isolate the original capability and may never return as ordinary retryable failures.

## 3. Recovery choices

While any marker exists, autosave, file lifecycle operations, AI mutations, Changes apply, History undo, migration writes, Graph correction writes, and Inline apply are blocked. Read-only file/tree/History access and recovery IPC remain available.

For `applied`, `reviewed`, `undone`, or `zero_write_error`, Renderer reloads authoritative tree, current file when affected, and History, then exact-clears the marker. A missing response follows this same query/reload/clear path.

`committed_warning` and `manual_recovery` keep the project blocked and show affected relative paths plus two explicit Main-owned actions:

1. **Restore operation-before** — write every affected file to the sealed before content and restore the sealed base History.
2. **Keep operation-after** — write every affected file to the sealed after content and commit the prepared History.

Main permits either action only when every current file is still exactly the sealed before or after revision and current History is exactly the sealed base or prepared state. A third file revision, foreign History state, corrupt marker, watcher degradation, or recovery write failure keeps the marker and project locked. Recovery actions are idempotent and never infer content from Renderer state.

## 4. Lifecycle

1. Main validates project, dependency, decision, History capacity, and recovery absence.
2. Main prepares the exact History mutation and atomically writes the `applying` marker.
3. After marker persistence succeeds and before the first manuscript/History write, a Main-owned begin callback consumes or isolates the pending apply capability. Callback failure is zero-write and terminal; it cannot be skipped or moved after the first write.
4. Main performs apply/review/undo, then classifies by authoritative files plus History.
5. Main persists the terminal marker before returning any result.
6. Renderer blocks mutation, reloads Main authority, exact-clears safe terminal outcomes, and only then resumes editing.
7. On navigation, crash, restart, malformed response, or IPC loss, project bootstrap queries and reconciles the marker before opening editable content.

Before either manual recovery action writes any file, Main persists an internal `recoveryWritePending` durability latch and changes the public outcome to `manual_recovery`. Visible target bytes cannot clear this latch: a file or History rename may have succeeded while its directory `fsync` failed. Query/classify keeps the project locked. A retry must rewrite the selected exact file/History targets and successfully complete their durability proof before classification may release the latch.

Post-commit failures in pending-store settlement, residual publication, tree refresh, metrics, or onboarding transition cannot turn a proven commit into an ordinary failure. They return a committed warning or are recovered from the marker.

Onboarding confirmations and residual review capabilities are one-time in-memory authorities, not durable transaction facts. If the commit response is lost or recovery happens after Renderer/process replacement, Main must terminate any hidden authority and report `confirmationUnavailable` and/or `residualUnavailable`; recovery never silently remints or exposes a token through query/resolve/clear. The author regenerates that follow-up operation after the manuscript/History truth is reconciled.

## 5. Public boundary

Preload exposes only:

- query current-project recovery;
- resolve the current opaque operation with `restore_before` or `keep_after`;
- exact-clear a safe terminal operation.

Renderer never submits root paths, file contents, revisions, History objects, capabilities, or commit claims through recovery IPC. Public results contain only fixed schemas, bounded relative paths, operation identity/kind/state/outcome, and safe messages.

Stable public errors include `CHANGES_RECOVERY_PENDING`, `CHANGES_RECOVERY_STALE`, `CHANGES_RECOVERY_CONFLICT`, `CHANGES_RECOVERY_WRITE_FAILED`, and `CHANGES_MANUAL_RECOVERY_REQUIRED`.

## 6. Required evidence

Dynamic scratch-project tests must cover:

- apply and undo `rollback_failed`;
- History failure + rollback success and rollback failure;
- History writer commits then throws;
- reject-only History response loss;
- apply/undo success response loss and restart reconciliation;
- mixed before/after files;
- base/target/foreign/corrupt History;
- restore-before and keep-after, including retry after recovery write failure;
- marker write/finish/clear failure, symlink, hard link, oversize, wrong project, wrong operation, and A→B isolation;
- capability replay prevention and post-commit residual/bookkeeping failure;
- Renderer bootstrap lock, autosave/mutation blocking, authoritative reload, explicit recovery controls, and no old-DOM restoration.

Sign-off order is: contract → Main services → adversarial service tests → Main/preload integration → Renderer state/UI → full Node suite → Electron-enabled verify → forced real-Electron recovery journeys → independent review P0/P1/P2=0. Existing App/ZIP remain non-distributable.

Historical focused checkpoint for this contract, 2026-07-26: Recovery **24/24**, Handler **10/10**, Change History **14/14**, ChangeSet Review **15/15**, Composite Mutation Guard **5/5**, Renderer protocol **16/16**, Workspace recovery **7/7**, Changes integration **6/6**, and prior Inline Integration **7/7** passed. Full `npm test` and Electron-enabled `npm run verify` exited 0, the real DOM sanitizer was **13/13**, and forced real-Electron E2E was **30/30**. Main/preload, Renderer bootstrap, both manual choices, same-action retry, response-loss reconciliation, exact clear, A→B isolation, and downstream Graph/Research/restart journeys were signed; final independent review was **P0=0, P1=0, P2=0**. The current project total is 34/34 in `v0/DEVELOPMENT-STATUS.md`.
