# WritCraft Markdown Trash v1 Contract

> Status: implemented and independently signed on 2026-07-28 as milestone 0.0AB, P0/P1/P2=0. Native worker 20/20, Trash service/handler 11/11, full `npm test`, non-sandbox `npm run verify`, Persistent Main/IPC 3/3, forced real Electron 35/35, package 8/8, and release 7/7 passed. Scope is the ordinary Markdown project trash list and single-item restore UI. Permanent empty/purge remains explicitly out of scope.

## Product outcome

Explorer exposes a visible “项目回收区” panel. It lists the original relative path, deletion time, and size of recoverable Markdown files. The author may refresh or restore one item to its original path. Restoring never opens the file automatically and never changes Changes/History.

## Main authority and privacy

- Renderer submits only the current project instance and an opaque one-time item token.
- Main derives canonical root, window owner, navigation epoch, and mutation generation.
- A list operation validates the private `.writcraft/trash` directory chain, bounded manifest, regular single-link item, size, inode, and SHA-256 before minting tokens.
- Public items contain only `token`, `originalPath`, `deletedAt`, and `sizeBytes`. Root, trash path, manifest entry ID, revision, digest, inode, and operation identifiers never cross preload.
- Tokens are bounded, expire, bind the exact list authority, and cannot be replayed after successful restore or project/navigation/content drift.

## Lifecycle transaction

List token issuance first crosses the Main-owned watcher flush barrier, then binds the resulting project instance, root identity, mutation generation, and navigation epoch. Refresh and restore share one Renderer single-flight owner: a refresh disables every older action until the newest list is installed.

Ordinary Markdown trash and restore both use a native helper beneath a Main-opened, identity-checked project-root descriptor. Every path component is traversed relative to bound directory descriptors with `O_NOFOLLOW`; immediately before the first committing rename, the helper must rewalk the same named ancestor chain from the trusted root and prove every reopened directory still matches the already-open descriptor. A detached but still-open parent fd is not project authority. Source identity/content, manifest M0, destination absence, and manifest M1 are then rechecked as the last pre-commit actions. Source quarantine, exclusive publication, manifest replacement, and directory durability use private random names, `renameatx_np(RENAME_EXCL)`, exact identity rechecks, and `fsync`.

The helper persists the complete rollback/commit material, including the next manifest, before the first mutation. Recovery must cover every gap between a filesystem rename and its following journal-state write: journal P/Q/D may lag disk reality for both Trash and Restore. Results are `UNCOMMITTED`, `COMMITTED`, or `RECOVERY_REQUIRED`; response loss is reconciled from the exact journal and disk state without repeating a committed mutation. Any unresolved or unknown journal blocks every project write path—including Changes/History recovery, Research, image insertion and legacy migration—across token expiry and restart. Existing `.writcraft` and `trash` directories must be real current-euid private directories with exact `0700` permissions and stable fd/path identity; only a proven `ENOENT` may mean an empty recovery state. A destination conflict, corrupt manifest, symlink/hard-link, identity/content drift, stale token, project switch, reload, or incomplete reconciliation fails closed and preserves or locks the recoverable truth.

Only committed success refreshes the authoritative tree, invalidates derived AI state, and updates the visible list. Failure keeps the previous list visible with an actionable message; Renderer never removes an item optimistically.

## Renderer and acceptance

The Explorer panel uses native buttons, `aria-expanded`, `aria-controls`, `aria-busy`, and a polite live status. One global busy state prevents concurrent restores. Request sequence plus project instance rejects late A→B results.

Acceptance requires directed native worker, service, handler, and Renderer tests; directory/leaf replacement, response-loss and recovery-state attacks; narrow preload and no-private-field assertions; destination-conflict and stale/replay coverage; full test/verify; real Electron list → restore with disk-byte/tree proof and zero Renderer network; and App/standard-unzip helper attestation, signing, execution, and source-hash binding. Historical image-trash evidence does not sign this contract.
