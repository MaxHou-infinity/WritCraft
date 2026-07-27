# WritCraft V0 · Image Review v1

> Status: **2026-07-26 review settlement signed; 2026-07-27 in-app trash-management extension signed at P0=0/P1=0/P2=1; pending real paid-provider/author evidence**. The prior missing-UI P2 and five independent-review P1s in transaction races, digest identity, and committed TTL are closed. The remaining P2 is the non-blocking POSIX residual for a non-cooperating external process that already owns an open file descriptor.
> Provider parameter source: MiniMax official `POST /v1/image_generation` reference (`https://platform.minimax.io/docs/api-reference/image-generation-t2i`), checked 2026-07-26.

## 1. Product journey

1. The author explicitly requests one `image-01` asset and chooses an official aspect ratio.
2. Main decodes the returned JPEG/PNG, verifies that its width/height match the requested ratio, persists it inside `assets/generated/`, and issues one short-lived review token.
3. The preview shows decoded dimensions and the requested ratio. Generation alone never changes Markdown.
4. Before settlement, the author chooses a 1–5 quality rating and may enter a manually checked non-negative provider cost with a fixed currency.
5. The author then chooses exactly one terminal action:
   - **Insert into the current manuscript**: save the Markdown reference, retain the asset, and record `inserted`.
   - **Keep as material**: retain the asset without changing Markdown and record `kept`.
   - **Move to recoverable trash**: remove only the exact generated inode from the asset library, place it in the project’s private recoverable trash, and record `deleted`.
6. Regeneration must settle the previous preview first; it cannot silently accumulate orphan assets. Project switch, navigation, mutation-generation drift, expiry, replay, or foreign ownership fail closed.

## 2. Authority and privacy

- Renderer supplies only the review token plus bounded review metadata. It never supplies a root path, asset path, digest, API key, output URL, or diagnostic content.
- Main owns project/root authority, the decoded asset identity, review capability, deletion, and private evidence persistence.
- The review token binds trusted `webContents`, project instance/root, mutation generation, asset digest/path, and generation operation.
- Review evidence allowlist: operation ID, terminal decision, 1–5 rating, optional integer cost in minor units, currency enum, and timestamp. Existing generic AI metrics separately own generation latency and safe outcome; they are not duplicated into the review file.
- Evidence must never contain prompt, manuscript/model text, base64, key/fingerprint, project/file names, paths, digest, provider response, or raw error.

## 3. Image and filesystem invariants

- Official ratios are `1:1`, `16:9`, `4:3`, `3:2`, `2:3`, `3:4`, `9:16`, and `21:9`. The current official presets are respectively `1024×1024`, `1280×720`, `1152×864`, `1248×832`, `832×1248`, `864×1152`, `720×1280`, and `1344×576`.
- Decoded dimensions must be positive, bounded, and satisfy exact cross-multiplication for the requested ratio. Width, height, and ratio are safe response metadata. The live acceptance report also compares the decoded size with the current official preset so an upstream API change is visible instead of silently accepted.
- Generated-directory identity and canonical location are checked before and after exclusive creation/link. A symlink swap or inode drift writes no image bytes outside the project.
- Delete accepts only the token-owned SHA-256 asset, requires a regular single-link file at the canonical generated directory, re-hashes bytes, and atomically relocates it into a canonical private trash directory before fsyncing both directories. It never permanently unlinks a selected-path file. Missing exact assets are an idempotent deleted result; foreign or replaced files are never destroyed.
- V0 never purges private image trash in the background. The retention policy is explicit manual retention: an item remains until the author restores it or explicitly empties the trash.

## 4. Failure and committed-state matrix

- API/decode/ratio/path failure: no token, no review evidence, no Markdown mutation.
- Insert save failure: token remains live and no terminal review is recorded.
- Markdown committed but evidence recording fails: report committed warning, retain asset, and allow exact evidence retry without repeating insertion.
- Trash move failure or identity mismatch: token remains live and the UI stays blocked on the same preview.
- Delete committed but response is lost: exact retry returns `deleted` without touching any other file.

## 5. In-app trash management extension

1. Opening the image panel exposes a visible “图片废纸篓” control. Main returns only aggregate count/bytes, bounded display metadata, opaque item capabilities, and one opaque capability for the exact listed snapshot. Renderer never receives root, private trash path, digest, operation ID, inode, or image bytes.
2. The panel states the retention rule in plain language: **长期保留，不会自动删除；只有恢复或清空才会改变废纸篓。**
3. Restore is item-scoped. Main revalidates the trusted window, exact current project, navigation/mutation generation, canonical trash/generated directories, regular single-link inode, size, content type, and SHA-256. Exclusive publication plus a random private transaction quarantine closes path-replacement windows before the inode becomes `assets/generated/image-<digest>.png|jpg`; an existing destination, foreign publication, same-inode rewrite, or any drift fails closed without retaining the wrong target.
4. Empty is snapshot-scoped and requires an explicit destructive confirmation in Renderer. Main permanently removes only the exact inode+digest entries captured by the opaque snapshot capability, through the same private transaction quarantine. New arrivals, concurrent replacements, and same-inode same-size rewrites are never removed. Partial unlink or directory-fsync failure returns an honest committed warning; committed partial/pending-fsync truth survives the live token TTL so the exact action can retry without widening authority.
5. Restore/empty require the normal mutable-project gate and are blocked by watcher/reconciliation failures. List is read-only. Project switch, reload, foreign sender, expiry, replay, or stale generation/navigation invalidates capabilities. A late project-A result cannot alter project B.
6. Successful restore or empty refreshes count/bytes and visible entries. Restore reports only the safe relative generated-asset path; it does not insert Markdown or alter existing review evidence. Empty never rewrites prior `deleted` review decisions.

## 6. Sign-off

The 2026-07-26 historical focused evidence covers malformed metadata, ratio mismatch, directory drift, hard-link/replacement, replay, expiry, project/navigation drift, regeneration settlement, all three review decisions, post-commit retry, and forbidden evidence fields: Generation 15/15, Review Service 16/16, Handler 9/9, Renderer 8/8, Metrics Renderer 20/20, `npm test` and Electron-enabled `npm run verify` exit 0, real-Electron 31/31, persistent watcher 3/3, and independent review P0=0/P1=0/P2=1.

The §5 extension additionally requires adversarial service tests for corrupt/unknown/symlink/hard-link entries, destination conflict, directory replacement, partial empty, committed rename/unlink plus fsync retry, stale capability, A→B isolation, exact-snapshot preservation of new arrivals, and zero manuscript/evidence mutation. Handler/preload/Renderer tests must prove narrow IPC and no private fields. Real Electron must visibly list, restore, confirm empty, preserve a newly arrived item outside the snapshot, survive restart, and keep Renderer network at zero. Full `npm test`, Electron-enabled `npm run verify`, forced Electron, and independent review P0/P1 closure are required before the prior P2 can close. Real `sk-api-`, real author rating/cost, and release signing remain later explicit gates.

Current extension evidence, 2026-07-27: Trash Service **21/21**, Handler **7/7**, Main/preload Integration **4/4**, Renderer **7/7**, full image-focused chain **107/107**, `npm test` and Electron-enabled `npm run verify` exit 0, and forced real Electron **32/32**. The real journey visibly covers list → restore → restart → snapshot empty while preserving a new arrival and keeping manuscript/evidence bytes unchanged. A next-session stability rerun exposed only a test-order assumption; the corrected test injects into whichever snapshot item is actually processed first, preserves the original safety assertion, and passed 20 consecutive service runs. Final independent read-only review confirms all five P1 closures and signs the extension at **P0=0/P1=0/P2=1**.
