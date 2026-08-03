# WritCraft 0.2.0

WritCraft 0.2.0 is the Daily Writing Workspace preview for macOS.

## What is new

- Project Home with recent work, manuscript summary, current-session pending Diff, and deterministic local status.
- Current-document outline with hierarchy, active-section tracking, and accurate navigation.
- `⌘P` quick open for files, headings, entities, issues, and current-session review objects.
- Resumable tabs, caret, selection, scroll position, outline state, and safe return paths across project navigation.
- Main-owned pending review hydration with accept, reject, discard, residual review, expiry, conflict protection, and Safe Undo boundaries.
- A unified daily journey: view project status → locate work → edit or review → return to project status.

## Safety and scope

The preview remains local-first. It does not add cloud sync, collaboration, multi-model routing, external web research, or autonomous book generation. AI-generated text remains preview-only until the author explicitly confirms a Diff. The package is distributed under the WritCraft Proprietary Evaluation License 1.0.

## Install

```bash
npx writ-craft@preview
npx writ-craft@preview --check
```

Requires macOS 12+, Node.js 22.12+, and npm 10 or 11. Use `@preview` explicitly; `latest` is not the stable-release pointer for this preview.
