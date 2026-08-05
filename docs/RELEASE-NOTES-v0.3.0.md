# WritCraft 0.3.0

WritCraft 0.3.0 is the transparent AI collaboration preview for macOS.

## What is new

- Main-owned AI task state across Chat, Navigation, Chapter, Research, Changes, Graph, and image flows, with real stages, cancellation, hard timeout, project/revision ownership, and late-result disposal.
- Request-bound opaque `@file`, `@folder`, `@chapter`, `@section`, `@source`, and `@entity` references with revision, project-instance, permission, and expiry checks.
- One Main-owned `edit.md` compiler and `writcraft.context-manifest/v2` envelope shared by Chat, Navigation, Research, Chapter, and ordinary Project Changes.
- Transparent task progress, context disclosure, reviewable Diff, conflict protection, author confirmation, History, and Safe Undo.
- Real-author acceptance evidence for Chat, Navigation, Chapter, Research, Changes, Graph, images, source recovery, cancellation, timeout, project switching, and zero-write preview boundaries.

## Safety and scope

AI output remains preview-only until the author explicitly confirms a Diff. `edit.md`, source files, and project rules remain read-only within AI generation and review. The preview does not add Autopilot, autonomous book generation, cloud collaboration, cross-project memory, or an external Research engine. Inline Rewrite keeps its existing v1 contract.

The package is distributed under the WritCraft Proprietary Evaluation License 1.0.

## Install

```bash
npx writ-craft@preview
npx writ-craft@preview --check
```

Requires macOS 12+, Node.js 22.12+, and npm 10 or 11. Use `@preview` explicitly; `latest` remains `0.1.0` and is not moved by this release.

## Publication

Published to npm `preview` on 2026-08-05 as `writ-craft@0.3.0`.

- Registry: `preview: 0.3.0`, `latest: 0.1.0`
- Shasum: `c3294a3f106119096751f8c2b67afa55e91bd702`
- GitHub prerelease: https://github.com/MaxHou-infinity/WritCraft/releases/tag/v0.3.0
- Tag and release commit: `v0.3.0` → `a747683`
- Public-registry isolated install verification: **2/2**

This remains a macOS Developer Preview. No signed App/ZIP distribution is included.
