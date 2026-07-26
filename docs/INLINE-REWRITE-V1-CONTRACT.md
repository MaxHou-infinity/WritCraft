# Inline Rewrite v1 Contract

> Status: product chain signed. The 21/21 forced-Electron result below is this contract's historical focused evidence; it is not the current project-wide total. The current final source passed full `npm test`, Electron-enabled `npm run verify`, and controlled forced Electron **30/30**; authoritative current status is `v0/DEVELOPMENT-STATUS.md`.
> Request schema: `writcraft.inline-rewrite/v1`
> Result schema: `writcraft.inline-rewrite-result/v1`

## 1. Product journey and terminal truth

1. The user selects non-empty text inside one Markdown block and chooses a rewrite style.
2. Before its first `await`, Renderer freezes project instance, path, open generation, editor session, editVersion, dirty generation/state, DOM Range identity, UTF-16 offsets, selected-text digest, block proof, and allowlisted style. It then persists the document.
3. That persist may advance the target revision exactly once as the direct result of this save. After persist, after watcher settle, and immediately before IPC, Renderer rechecks every frozen field and the exact selection; selection-only movement, unsaved typing, or file/session drift terminates the request.
4. Main reconstructs `edit.md`, the exact target selection, and bounded neighboring context from authoritative disk snapshots.
5. Main accepts only a strict model result, locally assembles the complete proposed file, and returns a preview plus a one-time capability in `REVIEW_PENDING_ACK`. Disk is unchanged.
6. Renderer safely installs and binds the preview, then acknowledges the exact rewrite within 30 seconds. Only an acknowledged `REVIEW` may be accepted.
7. The user may accept, reject, regenerate, change style, switch file/project, or close the preview. Only explicit accept may write.
8. Main burns the capability, revalidates every dependency, applies one ChangeSet, writes History, and returns authoritative committed truth. Renderer then reloads the file from disk and places a collapsed caret at the replacement end only if the original binding is still current.

An empty `replacement` is an explicit deletion. An identical replacement is a no-op: no capability, write, or History entry. Reject/cancel/expiry/stale and every pre-commit failure preserve disk bytes. Post-write failure follows the truth matrix in §6 and never invites an unsafe retry.

## 2. Authority matrix

| Concern | Renderer may provide | Main owns and verifies |
|---|---|---|
| Project | current instance ID | canonical root/session, mutation generation |
| Target | relative path, expected revision | canonical path, realpath/inode, content/revision |
| Selection | UTF-16 range, compact block proof | exact selected bytes, block and neighbor locators |
| Style | one allowlisted identifier | system prompt and model request |
| Context | nothing else | saved `edit.md`, target and bounded neighbors |
| Proposal | ACK/reject/cancel associated rewrite + capability IDs | strict parsing, full after-content, ChangeSet |
| Write | associated rewrite + one-time capability IDs | revalidation, rollback-capable write, History and undo |

Renderer must never submit root paths, file contents, replacement text for application, ChangeSet contents, dependency revisions other than the initial target revision, or claimed model metadata.

## 3. Exact request and model result

The existing public request remains exact-key and at most 4 KiB:

```json
{
  "schema": "writcraft.inline-rewrite/v1",
  "currentFilePath": "chapters/01.md",
  "expectedRevision": "64-lowercase-hex",
  "style": "concise",
  "selection": {
    "startOffset": 120,
    "endOffset": 180,
    "proof": {
      "schema": "writcraft.block-anchor/v1",
      "id": "block_89abcdef",
      "filePath": "chapters/01.md",
      "type": "paragraph",
      "headingKey": "intro",
      "ordinal": 1,
      "blockFingerprint": "0123abcd",
      "quoteFingerprint": "4567cdef",
      "relativeStart": 10,
      "relativeEnd": 70
    }
  }
}
```

The request, selection, and proof are plain exact-key objects. Proof keys are exactly `schema,id,filePath,type,headingKey,ordinal,blockFingerprint,quoteFingerprint,relativeStart,relativeEnd`: `id` matches `^block_[a-f0-9]{8}$`; other strings are non-empty except `headingKey`; `ordinal >= 1`; relative offsets are safe integers with `0 <= relativeStart <= relativeEnd`; both fingerprints are eight lowercase hex characters. `filePath` must equal `currentFilePath`. Paths are POSIX-relative and path identity is exactly `value.normalize('NFC').toLocaleLowerCase('en-US')`. Request selection is at most 8 KiB; Main-built model context is at most 32 KiB.

The model must return exactly one JSON object, with no fences or outer text:

```json
{
  "schema": "writcraft.inline-rewrite-result/v1",
  "replacement": "改写后的文字",
  "summary": "精简重复表达"
}
```

The provider result must contain exactly one text content block and no tool or additional block. Main validates in this order: `stopReason`, raw text type/16 KiB byte limit, duplicate/prototype-key-safe JSON syntax, JSON parse, plain-object/exact keys, then field bounds. `stopReason === "end_turn"` is mandatory; `max_tokens` maps to `MODEL_OUTPUT_TRUNCATED`, all other endings to `MODEL_OUTPUT_INCOMPLETE`. `replacement` must be a string, may be empty, is not trimmed, rejects NUL, and is at most 12 KiB UTF-8. `summary` must be a non-empty string equal to its trim, reject NUL/newlines, and be at most 240 Unicode code points using `Array.from` and 1 KiB UTF-8. There is no JSON repair, looser retry, plain-text fallback, or model-text echo in errors.

### 3.1 Public IPC schemas

`ir_[a-f0-9]{32}` is a 128-bit immutable rewrite identity; it is audit identity only and never authorizes an operation. `irc_[a-f0-9]{32}` is a separate 128-bit one-time capability and is never persisted to History. All objects below are plain exact-key objects. Generation success is at most 96 KiB and always has the same keys:

```json
{
  "ok": true,
  "schema": "writcraft.inline-rewrite-review/v1",
  "outcome": "review",
  "rewriteId": "ir_0123456789abcdef0123456789abcdef",
  "capabilityId": "irc_0123456789abcdef0123456789abcdef",
  "expiresAt": 2000000000000,
  "replacement": "改写后的文字",
  "summary": "精简重复表达",
  "contextManifest": { "schema": "writcraft.context-manifest/v1" }
}
```

For `outcome: "no_op"`, `rewriteId` remains present for metrics/audit, while `capabilityId` and `expiresAt` are `null`; replacement, summary, and the Main-authored context manifest remain present. A review requires both IDs and an absolute positive safe-integer `expiresAt` epoch millisecond. A historical `rewriteId`, by itself or paired with any consumed/foreign capability, can never authorize ACK, discard, or apply.

Preview acknowledgement payload/result are exact:

```json
{"schema":"writcraft.inline-rewrite-ack/v1","rewriteId":"ir_…","capabilityId":"irc_…"}
{"ok":true,"schema":"writcraft.inline-rewrite-ack-result/v1","status":"review"}
```

Apply payload/result are exact and at most 8 KiB:

```json
{"schema":"writcraft.inline-rewrite-apply/v1","rewriteId":"ir_…","capabilityId":"irc_…"}
{"ok":true,"schema":"writcraft.inline-rewrite-apply-result/v1","status":"applied","path":"chapters/01.md","revision":"64-lowercase-hex","historyEntryId":"change_00000000-0000-4000-8000-000000000000","refreshRequired":false,"historyUnavailable":false,"manualRecoveryRequired":false,"message":"已应用"}
```

`status` is `applied` or `committed_warning`; non-null History IDs match `^change_[0-9a-f-]{36}$` and validate as UUIDs. A warning permits `historyEntryId: null`; all other keys remain present and `revision` is an authoritative post-attempt re-read. Renderer reloads content through the existing Main file-read API instead of trusting preview text.

Reject/discard/cancel share one exact payload and result:

```json
{"schema":"writcraft.inline-rewrite-discard/v1","rewriteId":"ir_…","capabilityId":"irc_…"}
{"ok":true,"schema":"writcraft.inline-rewrite-discard-result/v1","status":"discarded"}
```

During `GENERATING`, both IDs are `null`; because there is exactly one active rewrite per trusted owner, this cancels that owner's provider request. Regenerate/style change first awaits discard (or all-settled cleanup after transport loss), then submits a fresh original generation request; there is no mutable regenerate endpoint. Every error is exact `{ok:false,schema:"writcraft.inline-rewrite-error/v1",error:{code,message,recoverable}}`. Stable codes are `INVALID_INLINE_REWRITE`, `INLINE_REWRITE_TOO_LARGE`, `INLINE_REWRITE_BUSY`, `INLINE_REWRITE_NOT_FOUND`, `INLINE_REWRITE_ACK_TIMEOUT`, `INLINE_REWRITE_NOT_ACKNOWLEDGED`, `INLINE_REWRITE_STALE`, `INLINE_REWRITE_EXPIRED`, `INLINE_REWRITE_REPLAYED`, `INLINE_REWRITE_PROTECTED_TARGET`, `MODEL_OUTPUT_TRUNCATED`, `MODEL_OUTPUT_INCOMPLETE`, `INVALID_MODEL_OUTPUT`, `INLINE_REWRITE_WRITE_FAILED`, and `INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED`. Messages never contain content, prompt, model text, key, or absolute path.

Renderer bootstrap and apply-outcome recovery use a read-only reconciliation API before autosave or mutation is enabled:

```json
{"schema":"writcraft.inline-rewrite-reconciliation/v1"}
{"ok":true,"schema":"writcraft.inline-rewrite-reconciliation-result/v1","status":"terminal","marker":{"rewriteId":"ir_…","path":"chapters/01.md","state":"terminal","outcome":"applied","revision":"64-lowercase-hex","historyEntryId":"change_00000000-0000-4000-8000-000000000000","errorCode":null,"updatedAt":2000000000000}}
```

`status` is `none`, `applying`, or `terminal`; `marker` is `null` only for `none`. Marker fields are exact. For `applying`, `outcome/revision/historyEntryId/errorCode` are null. Terminal `outcome` is `applied`, `committed_warning`, `zero_write_error`, or `manual_recovery`; fields not applicable to that outcome are null. Clearing after successful reconciliation is exact and read-state-only:

```json
{"schema":"writcraft.inline-rewrite-reconciliation-clear/v1","rewriteId":"ir_…"}
{"ok":true,"schema":"writcraft.inline-rewrite-reconciliation-clear-result/v1","status":"cleared"}
```

Main accepts clear only from the trusted BrowserWindow, current matching project, and exact `rewriteId` of a `terminal` marker. It rejects `applying`, foreign-project/window, stale, malformed, and non-matching clears without changing any marker. Clear deletes only the recovery marker; it never modifies manuscript or History.

## 4. Writable scope and dependency proof

Inline Rewrite writes exactly one public Markdown target. The requested path must resolve to exactly one current tree entry under `value.normalize('NFC').toLocaleLowerCase('en-US')`. `.writcraft/**`, `references/**`, `sources/**`, hidden paths, symlinks, aliases, case-only or Unicode-equivalent collisions, and hard-link overlap with any internal/hidden/source/reference file fail closed. A non-`edit.md` target whose inode equals root `edit.md` also fails. Main re-enumerates canonical and protected identities before model, after model, and before apply. `edit.md` is allowed only when it is the explicit target, but the selection may not intersect its Front Matter. The complete before/after Front Matter byte slice, including delimiters, must be identical; `inspectEditFrontMatter(after).data.schema` must equal `writcraft.edit/v1` and no diagnostic may have `severity === "error"`. Warnings and unknown fields therefore remain byte-for-byte preserved.

The frozen internal proposal records project instance/root, mutation generation, target path/revision/realpath/inode, exact range and selected-text digest, block proof, bounded neighbor locators/digests, `edit.md` revision when it is a separate dependency, full after-content, ChangeSet, style, expiry, and owner webContents/navigation epoch. Public provenance is bounded and excludes file contents, selected text, prompt, model output, absolute paths, and keys.

Validation runs before the model, after the model, and immediately before apply. Accept-time drift in project, target revision/path/inode, `edit.md`, proof, selection, or frozen neighbor dependency returns `INLINE_REWRITE_STALE` and performs zero writes.

## 5. Capability, state machine, and lifecycle

The Main store is process-global and holds at most eight live records across windows. Each trusted BrowserWindow/project may hold exactly one `GENERATING`, `REVIEW_PENDING_ACK`, `REVIEW`, or `APPLYING` record; webContents navigation changes the sender epoch but not the BrowserWindow reconciliation owner. The current V0 window therefore has at most one. The global LRU limit is reachable only with multiple trusted owners/windows or injected-store tests. IDs expire after 10 minutes. Injectable clock/ID factories make TTL, replay, owner scope, and eviction deterministic. Records bind project instance/root, trusted BrowserWindow, sender/navigation epoch until apply begins, rewrite identity, capability, and dependency digest. `now >= expiresAt` is expired. LRU may evict only another owner's non-`APPLYING` record and eviction is terminal; when every slot is `APPLYING`, admission fails with `INLINE_REWRITE_BUSY`.

Before burning an associated capability, Main atomically writes a bounded reconciliation marker to `.writcraft/recovery/inline-rewrite-apply.json`. The exact internal marker contains schema, project ID, rewrite ID, target path, before/expected-after revisions, `applying|terminal` state, bounded terminal classification/History ID/error code, and timestamps—never capability, content, prompt, summary, model text, key, or absolute path. One project has at most one marker; an unresolved marker blocks another apply. It is updated to terminal before Main returns any apply result. It survives Renderer navigation/crash and app restart. On project open or reconciliation query, an `applying` marker with no live Main transaction is resolved only by authoritative target revision plus History provenance: expected-after + matching History is applied; before + no matching History is zero-write; every inconsistent combination is manual recovery. Marker I/O failure before target write produces zero writes; failure after target write follows §6.1.

```text
Renderer: idle → preparing → generating → installing → reviewing → applying → applied
             │            │          │            │          └→ committed-warning
             │            │          │            ├→ regenerating → generating
             │            │          │            └→ rejected / discarded / expired
             │            └→ no-op / failed / stale / project-switched
             └→ selection-changed / canceled          applying → APPLY_OUTCOME_UNKNOWN → reconciled / reopen-required

Main: GENERATING → REVIEW_PENDING_ACK → REVIEW → APPLYING → APPLIED
          │                 │             │          ├→ STALE
          │                 └→ ACK_TIMEOUT│          ├→ FAILED_ROLLED_BACK
          └→ CANCELED                     └→ DISCARDED└→ COMMITTED_WARNING
```

Main stores the capability before returning a review, enters `REVIEW_PENDING_ACK`, and starts a 30-second delivery timer. Renderer ACKs only after the exact preview and frozen binding are active. Wrong/late ACK, timeout, delivery exception, reload, navigation, or crash revokes a `GENERATING`, `REVIEW_PENDING_ACK`, or `REVIEW` record; apply is valid only in `REVIEW`. One editor has at most one active rewrite transaction. A new generation first aborts and terminally revokes the prior request/review. Style change is regeneration, not mutation. Every ACK/apply/discard first validates exact schema and ID syntax, then trusted owner/navigation, project instance/root, and rewrite↔capability association without consuming any foreign record. Only a fully associated apply atomically persists its reconciliation marker and enters `beginApply`, which leases and burns the capability before dependency revalidation or target write. Once state is `APPLYING`, Renderer reload/navigation/crash does not cancel Main's transaction; Main completes or rolls back, saves terminal truth to the marker, and exposes it to the replacement Renderer. Stale and every pre-commit failure are terminal, so concurrent, expired and replayed accepts fail. Reject, cancel, project/file/session switch, revision/editVersion/selection drift, renderer reload/crash, destroy, and request replacement abort only pre-apply states. Cleanup is all-settled.

## 6. ChangeSet, History, and Renderer behavior

Main creates a single-file localized ChangeSet and applies it through the same reviewed-write and rollback-capable History boundary as other AI edits. History uses `writcraft.changes/v3`; successful apply supports ordinary safe undo. History integrity validation, public History, and undo retain the exact same provenance below, whose serialized size is at most 16 KiB:

```json
{
  "schema": "writcraft.inline-rewrite/v1",
  "kind": "inline_rewrite",
  "rewriteId": "ir_0123456789abcdef0123456789abcdef",
  "style": "concise",
  "summary": "精简重复表达",
  "target": {"path":"chapters/01.md","revision":"64-lowercase-hex"},
  "selection": {"startOffset":120,"endOffset":180,"blockId":"block_89abcdef","blockFingerprint":"0123abcd","quoteDigest":"sha256:64-lowercase-hex"},
  "projectPrompt": {"path":"edit.md","revision":"64-lowercase-hex"},
  "neighbors": [{"role":"previous","path":"chapters/01.md","revision":"64-lowercase-hex","offset":80,"endOffset":120,"digest":"sha256:64-lowercase-hex"}],
  "expiresAt": 2000000000000
}
```

All objects and neighbor items are exact-key plain objects. `neighbors` has at most four items in the fixed order `previous`, `before_selection`, `after_selection`, `next`; an absent or zero-byte context is omitted without a placeholder, and no role may repeat. Offsets are safe and ordered. Digests are `sha256:` plus 64 lowercase hex. When target is `edit.md`, `projectPrompt` is exactly `null`; otherwise it is required. Provenance contains `rewriteId` but never `capabilityId`, selection/replacement text, prompt/model text, absolute path, or key. Reject-only and no-op do not create History.

### 6.1 Write/History truth matrix

1. History load, validation, size, or preflight failure occurs before target write: target bytes stay unchanged.
2. Target write failure produces zero net target change and no History.
3. Target write succeeds, History write fails, and target rollback succeeds: terminal `INLINE_REWRITE_WRITE_FAILED`; original target bytes are restored and no History exists.
4. History write fails and rollback fails: Main authoritatively re-reads disk. If the proposed after-content is present, return `ok:true`, `status:"committed_warning"`, `historyEntryId:null`, and all three flags true, with “已应用但历史不可用，请人工恢复；不要重试”. Any other disk state returns `INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED` with `recoverable:false`; it still forbids replay.
5. Target and History commit, but Main-owned watcher/tree bookkeeping or other pre-response post-commit refresh fails: return `ok:true`, `status:"committed_warning"`, the History ID, `refreshRequired:true`, and the other warning flags false, with “已应用，请重开项目；不要重试”.
6. After an ordinary Main `applied` response, Renderer file reload, caret, focus, or UI refresh may fail locally. It must preserve Main's `applied` truth, show “已应用，但界面刷新失败；请重开项目，不要重试”, disable the stale preview, and must not relabel the Main result as `committed_warning`.
7. Apply responses route into four disjoint cases. A trusted exact success uses its Main truth. Exact `INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED` enters manual recovery. Any other trusted exact error is contractually zero-write/rolled-back and may restore the current original binding. Absence of any trusted exact IPC response—or a malformed/untrusted response—enters `APPLY_OUTCOME_UNKNOWN`; it must not be used for commit inference. Renderer assumes the capability is consumed and must not retry apply/discard, restore the old fragment, autosave, focus the stale editor, emit accepted/failed metrics, or permit any mutation. It stops pending saves, destroys the transient preview without copying preview/original bytes, and queries Main's durable marker. While `applying`, it remains blocked and re-queries after Main's completion signal or bounded polling. At `terminal`, it authoritatively reloads target, tree, and public History. Only after all three loads succeed may it clear the matching marker, replace the editor with disk truth, and leave as `reconciled`, displaying “提交结果曾中断，已按磁盘和历史重新同步；请核对后继续”. If any query/load fails or outcome is `manual_recovery`, mutation remains blocked and project reopen is mandatory. A newly created Renderer performs this same query before enabling autosave or mutation. Reconciliation never writes manuscript/History and never infers truth from old DOM.
8. Every apply route owns an explicit marker lifecycle. Trusted `applied` or `committed_warning` with `manualRecoveryRequired:false` must authoritatively reload target, tree, and public History, then exact-clear the terminal marker before mutation is enabled. A trusted exact zero-write/rolled-back error exact-clears its terminal marker before restoring/refocusing the current binding. Trusted success with `manualRecoveryRequired:true` and exact manual-recovery error never clear. No-trusted-response uses the reconciliation/clear path in item 7. Any required reload or clear failure keeps mutation blocked and requires project reopen; it cannot become an ordinary UI error. A replacement Renderer applies the same lifecycle at bootstrap. This permits consecutive successful rewrites without leaving a false busy marker.
9. Every branch consumes the capability permanently. Committed-warning metrics/history truth derive from Main's authoritative re-read, never Renderer inference.

Renderer keeps the inline red/green Diff and context chips, but the transient DOM is never write authority. Accept disables all controls, sets `aria-busy`, calls Main apply with the associated rewrite/capability IDs, and reloads content only from Main's file-read API after authoritative success. Reject restores the original fragment without autosave. On `INLINE_REWRITE_MANUAL_RECOVERY_REQUIRED`, Renderer enters a blocking recovery state: it disables editor/AI mutation, destroys the stale preview without restoring its original fragment, authoritatively re-reads the target, and requires project reopen if that read fails. It must never re-enable accept, reconstruct the old preview, autosave the old DOM, or offer retry. The same no-restore/no-autosave rule applies to `APPLY_OUTCOME_UNKNOWN` under §6.1. Restore/refocus is allowed only for reject, a known pre-send failure, or a trusted exact zero-write/rolled-back apply error after its terminal marker was successfully cleared; manual recovery, outcome unknown, and reload/clear failure never restore or refocus. Late results may not render, focus, emit accepted metrics, or leave a capability. Regeneration, style change, and destroy actively abort the provider through discard before ignoring late output. Buttons and keyboard actions expose accurate disabled/busy states; the live region announces generating/reviewing/applying/applied/stale/warning. Success places a collapsed caret at the replacement end and focuses only while the original binding is current; allowed restore paths focus only that current binding. `generated` is emitted after ACK, `accepted` only after trusted Main commit truth, and `stale`/`discarded` only from terminal state transitions; metrics contain no text or paths.

## 7. Required acceptance scenarios

- **Success:** Given a saved selection, when generation returns strict JSON and the user accepts, then preview is zero-write, exactly one file and one History entry commit, provenance is `inline_rewrite`, and undo restores the original bytes.
- **No-op/delete/reject:** identical output creates no capability; empty output previews an explicit deletion; reject/cancel preserves target and `edit.md` bytes and creates no History.
- **Drift:** editing the target, `edit.md`, selected block, neighbors, path identity, file/project/session, or renderer navigation before delivery/apply makes the result stale and leaves no live capability. Dynamic cases include `persist → selection-only change` and `persist → unsaved typing` before IPC/result/apply.
- **Regeneration:** changing style or reloading A→B aborts/revokes A; a late A result cannot replace B or write.
- **Protected paths:** sources, references, hidden paths, symlink/case/NFC/hard-link aliases and invalid `edit.md` proposals fail before capability issuance.
- **Model quality:** malformed/extra-key/fenced/oversize JSON and every non-`end_turn` ending fail with zero writes.
- **Commit honesty:** inject History preflight, target write, History commit, rollback, logical-commit refresh, and “target + History committed but apply response lost” faults separately; assert every exact branch in §6.1, blocking reconciliation, authoritative reload, and no replay/autosave. Also cover two consecutive successful applies, success/zero-write marker-clear failure, and rejection of foreign, stale, malformed, or `applying` clear.
- **Lifecycle:** TTL/LRU, concurrent accept, replay, sender destroy/reload and abort are dynamically verified.
- **Electron:** real UI covers accept, reject, delete, no-op, regenerate A→B, stale edit/project switch, History/undo, caret/focus, and zero renderer HTTP(S).

Sign-off order: contract review → service/store → Main/preload/history → Renderer state/UI/dynamic → independent implementation review → full `npm test`/`npm run verify` → forced Electron → current-source App manual journey.

Every new verification script must appear exactly once in `npm test` and exactly once in `npm run verify`; it must not be duplicated through `pretest` or `preverify`.
