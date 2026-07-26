# WritCraft V0 · Image Review v1

> Status: **automated implementation signed on 2026-07-26; independent review P0=0/P1=0/P2=1; pending real paid-provider/author evidence**. The disclosed P2 is the missing in-app restore/empty-trash UI.
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
- V0 does not automatically purge private image trash. The file remains recoverable from the project folder; a visible restore/empty-trash UI and retention policy are a disclosed non-blocking follow-up, not part of the current terminal decision.

## 4. Failure and committed-state matrix

- API/decode/ratio/path failure: no token, no review evidence, no Markdown mutation.
- Insert save failure: token remains live and no terminal review is recorded.
- Markdown committed but evidence recording fails: report committed warning, retain asset, and allow exact evidence retry without repeating insertion.
- Trash move failure or identity mismatch: token remains live and the UI stays blocked on the same preview.
- Delete committed but response is lost: exact retry returns `deleted` without touching any other file.

## 5. Sign-off

Directed service/store/handler/Renderer tests cover malformed metadata, ratio mismatch, directory drift, hard-link/replacement, replay, expiry, project/navigation drift, regeneration settlement, all three decisions, post-commit retry, and forbidden evidence fields. Current evidence is Generation 15/15, Review Service 16/16, Handler 9/9, Renderer 8/8, Metrics Renderer 20/20, `npm test` and Electron-enabled `npm run verify` exit 0, real-Electron 31/31, persistent watcher 3/3, and independent review P0=0/P1=0/P2=1. Real `sk-api-`, real author rating/cost, and release signing remain explicit gates.
