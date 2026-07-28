# WritCraft Chat Conversation v1 Contract

> Status: implemented and independently signed on 2026-07-28 as milestone 0.0AA, P0/P1/P2=0. Chat Conversation 8/8, Chat Context 12/12, Context Inspector 9/9, Network 15/15, Workspace Persistence 10/10, full `npm test`, Electron-enabled `npm run verify`, Persistent Main/IPC 3/3, package 8/8, release 7/7, and final-source forced Electron twice 34/34 passed.

## Product outcome

Chat preserves a bounded recent conversation across turns without making Renderer or project files the history authority. The author can see how many turns were used, start a visible new conversation, and trust that project, content, navigation, or context changes cannot silently carry old conversation into a new request.

## Main authority

- History exists only in Main memory; it is never read from Renderer and is not persisted to disk.
- One session is bound to exact `ownerId`, Renderer navigation epoch, project instance, canonical root, and project mutation generation.
- At most six completed turns are retained. User turns, assistant turns, the aggregate summary, UTF-8 bytes, TTL, and owner count all have fixed limits.
- The prompt receives a deterministic recent-turn digest. No extra paid summarization call is made.
- Project switch, same-project explicit reopen, Renderer reload/gone/destroyed, authoritative Markdown mutation, TTL expiry, and explicit “新对话” invalidate the appropriate session.

## Concurrency and publication

- A new Renderer submit calls the trusted, owner/project-bound `cancelPending` IPC before save, watcher flush, context resolution, or model work.
- `cancelPending` aborts only an in-flight lease and preserves completed turns.
- Only the latest live lease may commit. Failed, aborted, stale, or superseded requests never enter history.
- Same-root reopen invalidates only after tree and `edit.md` reads succeed and before installing the reopened project; a failed reopen has zero conversation side effects.
- Renderer request tokens still own preflight chips, Inspector publication, and visible answers. Safe Main messages are shown instead of internal error codes.

## Disclosure and privacy

Context Manifest exposes only included/total turn count and character/byte totals. It never exposes summary text, owner, path, project identity, generation, or internal session IDs. Context Inspector renders a required, non-removable “最近对话” item; explicit new chat clears the Inspector, while ordinary context invalidation preserves prior response provenance.

## Acceptance

Real Electron must prove first/second turn continuity, visible reset, no hidden duplicate history, new-submit cancellation, same-root reopen cancellation, stale late-response rejection, and zero Renderer network. Red runs remain recorded in `v0/DEVELOPMENT-STATUS.md`; a green retry cannot erase them.
