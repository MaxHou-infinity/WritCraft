# Unified Writing Task v1 Contract

> Status: **frozen for implementation** (2026-08-01, checkpoint 0.0CM)
> Product version: `writ-craft@0.1.2`
> Public journey: Writing Navigation suggestion → inline review → explicit decision

## 1. Product decision

The default author journey is one continuous writing task. Navigation, evidence checking, localized generation, Diff review, decision, and Safe Undo may retain separate internal services, but must not appear as a chain of public workspaces.

Each suggestion has one primary action: **处理这个建议**. A normal run uses the suggestion's Main-owned evidence anchors and defaults to its manuscript file. The author does not reselect that file, classify a Research card, or manually transfer evidence into Changes.

Only when Main receives and validates an explicit `needs_sources` outcome with zero edits may the task show **添加来源**. Source selection returns to the same task, preserving its goal, anchors, scope, and attempt history. Standalone Research and Changes remain advanced tools; they are not the default Navigation path.

## 2. Author-visible state machine

```text
READY
  → SAVING_CURRENT_CONTENT
  → CHECKING_EVIDENCE
  → GENERATING_LOCAL_CHANGES
  → PREPARING_DIFF
  → REVIEW
  → COMMITTING
  → COMMITTED

Recoverable: NEEDS_SOURCES · FAILED · TIMED_OUT · CANCELLED
Terminal: STALE · CONFLICT · DISCARDED
```

The task card always names the goal, for example “正在精简第一章开篇”, and states whether any project file has been written. After 15 seconds it exposes **取消**. One author click starts at most one paid provider request; there is no hidden retry. At 60 seconds the attempt loses authority, aborts, and settles as `TIMED_OUT`. Failure, cancellation, and timeout preserve the current goal, selected sources, and target scope and write nothing.

## 3. Generation envelope

Main reconstructs `edit.md`, canonical suggestion evidence, current target snapshots, revisions, locators, and explicitly selected sources. The model receives bounded request-local evidence/range IDs and returns exactly one named `submit_unified_writing_task` tool input.

The result is exactly one branch:

- `changes`: 1–3 localized, non-overlapping edits over at most 3 authorized manuscript files; or
- `needs_sources`: no edits, a bounded author-facing reason, and a focused source question.

Main performs exact-key, ID-membership, size, overlap, revision, project-instance, attempt-owner, deadline, and late-result validation. Free text is never parsed into authority. A timed-out, cancelled, stale, old-project, duplicated, or expired result is discarded.

## 4. Inline Diff review

The main editor is the primary review surface. Deletions use a pale red background plus strikethrough; additions use pale green plus an insertion marker. Colour is never the only signal: every hunk has an accessible change label and explicit status.

A compact sticky toolbar provides previous/next change, accept/reject current, accept/reject all, and exit review. Multi-file results use existing file tabs/tree badges and next-change navigation. The right panel contains only the task goal, real stage, collapsible evidence/source details, scope controls, and change index—not a second miniature Diff.

Inline review nodes are transient. Stable editor text, autosave, word count, search, source indexing, Graph, and History continue to observe the pre-review document. File writes occur only through the existing Main-owned ChangeSet decision protocol. Reject and exit write nothing; accept revalidates conflict/revision authority. Safe Undo remains available after commit.

## 5. Ownership and safety

- Renderer owns presentation and author intent only.
- Main owns files, project identity, source records, revision, locator, ranges, ChangeSet, capabilities, application, History, and recovery.
- `edit.md`, `references/**`, `sources/**`, and other protected origins remain read-only targets.
- Project switch and unload invalidate the old task owner. Every stage, timer, abort, and `finally` is bound to one opaque attempt ID; attempt A cannot clear attempt B.
- Progress copy describes the real operation. A settled promise cannot leave an AI timer, disabled controls, or “处理中”.

## 6. Acceptance matrix

Required automated and real-Electron coverage:

- one click from suggestion to inline Diff on the normal path;
- `needs_sources` recovery returns to the same task;
- 15-second cancel visibility and 60-second terminal deadline;
- cancel, timeout, provider failure, malformed output, stale revision, conflict, project switch, and late result all produce zero writes;
- 1–3 edit and 1–3 target limits, protected targets, overlap, and range validation;
- transient review survives file switching and refresh according to Main authority without entering autosave;
- per-hunk/all accept and reject, conflict blocking, History, and Safe Undo;
- no separate Research or Changes page transition in the normal journey;
- independent review P0 = 0 and P1 = 0, with P2 recorded;
- real-author isolated-copy journey from one suggestion to Diff, decision, and Safe Undo.

## 7. Non-goals and release boundary

This checkpoint does not add Autopilot, whole-book generation, a task dashboard, software-style Plan, external web research, or rewrites of already signed Chat, Inline, Chapter, Graph, Image, Project Card, or empty-project structure planning.

No npm publish, dist-tag change, GitHub Release, App/ZIP distribution, or repository visibility change is authorized by this contract.
