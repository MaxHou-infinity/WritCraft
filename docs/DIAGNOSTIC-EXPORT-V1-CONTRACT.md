# WritCraft V0 · Diagnostic Preview and Export v1

> Status: **implemented and signed on 2026-07-26; independent review P0=0/P1=0/P2=0**. This closes the PRD §8.2 requirement that diagnostic exports are previewed and redacted before leaving the application. It is a user-visible product feature, not a release or real-author acceptance substitute.

## 1. Author journey

Settings exposes **诊断与隐私 → 预览诊断信息**. Opening it is read-only and makes no network request. The author sees the exact UTF-8 JSON that may be exported, a plain-language exclusion notice, and an explicit **导出这份诊断** action. Closing, refreshing, or cancelling the native save dialog writes nothing.

The preview contains only:

- schema and generation time;
- application/runtime versions, platform, architecture, packaged state;
- whether a project is open, file/Markdown counts, `edit.md` structural status and bounded diagnostic codes;
- watcher availability and private aggregate sample counts/rates;
- a bounded ring of timestamped stable diagnostic area/code pairs.

It never contains manuscript or source text, prompts, model output, quotes, base64, API keys or fingerprints, project/file names, relative or absolute paths, revisions/content hashes, raw errors, Renderer console messages, or unknown object fields.

## 2. Authority and protocol

Main constructs and serializes the bundle from explicit allowlisted primitives. Renderer receives only:

```text
writcraft.diagnostic-preview/v1
token + expiresAt + serialized exact preview
```

Renderer may later return only:

```text
writcraft.diagnostic-export/v1
token
```

The token is random, bounded, single-use after a successful write, expires after five minutes, and is bound to the trusted BrowserWindow, current project instance (or no project), and mutation generation. Project/navigation drift, malformed requests, expired tokens, or foreign senders fail before the save dialog or filesystem write. Renderer cannot supply bundle content, a URL, or an output path.

## 3. Write and logging safety

Only the Main-owned native save dialog selects the destination. Export uses a private `0600` file, refuses an existing target/symlink, fsyncs successful content, and removes a partial file on failure. The response exposes only a basename, never the selected absolute path.

Main records only stable diagnostic codes. Renderer console forwarding and load-failure logging must not print raw messages, source URLs, descriptions, manuscript content, provider bodies, paths, or secrets.

## 4. Required evidence

- Service adversarial tests: exact schemas, recursive key rejection, size/event bounds, token TTL/binding/single use, no-overwrite and partial-write cleanup.
- Main/preload tests: trusted sender, no Renderer content/path authority, project-drift rejection, and no network expansion.
- Renderer behavior: preview before export, exact `textContent` display, disabled export without a live preview, cancel/retry/error states, Escape/focus behavior.
- Real Electron: open the visible settings journey, inspect the exact preview, prove forbidden manuscript/path sentinels are absent, and confirm ordinary writing/AI journeys remain intact.
- Full `npm test`, Electron-enabled `npm run verify`, forced Electron E2E, then independent review with no unresolved P0/P1.

Final checkpoint, 2026-07-26: Service **12/12**, Handler **10/10**, Renderer **7/7**, and Main/Renderer Network Boundary **15/15** pass. Full `npm test` and Electron-enabled `npm run verify` exit 0; real DOM sanitizer is **13/13**; forced real-Electron E2E is **31/31** and persistent-watcher Main/IPC remains **3/3**. The visible preview excludes project, manuscript, file and path sentinels. Independent review found and closed one post-write TTL P1; final review is **P0=0, P1=0, P2=0**. Real paid API, real-author export, package rebuild and release review remain open.
