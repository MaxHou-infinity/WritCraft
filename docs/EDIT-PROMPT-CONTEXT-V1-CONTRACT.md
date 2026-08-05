# Edit Prompt Context v1 Contract

> Status: implemented and independently signed on 2026-07-28 as milestone 0.0Z, P0/P1/P2=0. Context Resolver 26/26, Inspector 8/8, Chat 11/11, Policy 10/10, full test/verify, final-source forced real Electron twice 33/33, Persistent 3/3, package 8/8 and release 7/7 passed. Two earlier final-source Electron runs timed out in different legacy stages; both red runs remain recorded in `v0/DEVELOPMENT-STATUS.md` and were followed by two consecutive clean runs without product changes.

## User outcome

An oversized root `edit.md` must no longer make Chat/Context requests fail merely because the whole file exceeds 6,000 characters or 18 KiB. Main compiles a bounded, revision-bound project Prompt and the Context Inspector shows which Markdown sections actually entered that request. Other AI modes retain their existing contracts until they explicitly adopt this compiler.

## Main authority

- Main reads one authoritative `edit.md` snapshot and binds every result to its revision.
- ATX headings outside fenced code define sections. Text before the first heading is a bounded preamble section.
- Required headings are normalized aliases of: 项目主旨/主旨, 范围与非目标, 关键实体与不变量, 时间与关系约束.
- Required sections are selected before optional sections. Selected output is emitted in original source order.
- A section is either included whole or omitted whole. Main never silently cuts a required section.
- If required sections alone exceed 6,000 characters or 18 KiB, the request fails closed with a stable, path-free error.
- Optional sections fill the remaining budget in source order. Empty or excessive heading catalogs are bounded.
- A short `edit.md` preserves the existing full-file output and manifest semantics.
- 0.3.0 的统一 v2 迁移只覆盖 Chat、Navigation、Research、Chapter 和普通 Project Changes 五个提案入口；Inline Rewrite（`⌘K`）明确保留本合同的 v1 Context Manifest 和独立 capability/写入边界，除非未来版本另行批准迁移。

## Manifest and Inspector

The required `project_prompt` Chip remains non-removable and contains a bounded `sections` ledger. Each entry carries a stable id, heading, level, `used` or `omitted` status, reason, source locator and emitted bytes. The Chip also reports total, used and omitted section counts.

Inspector displays the ledger inside the `edit.md` card using text-only DOM APIs. Used and omitted sections are visually distinct; locator activation opens the exact heading. The Renderer may normalize and display Main fields but may not invent section authority.

## Failure and verification matrix

- Short prompt parity: unchanged full content, one Prompt Chip, no omitted sections.
- Oversized prompt: all required sections enter whole; optional overflow is omitted and disclosed.
- Required overflow: stable fail-closed error, no partial context.
- Fenced `#` text is not parsed as a heading.
- Duplicate headings keep stable source-order identities.
- Manifest/state are bounded, deeply frozen and safe against malformed nested values.
- Directed Main and Renderer tests, full Node/verify, forced real Electron, independent review, documentation and Nowledge synchronization are required for sign-off.
