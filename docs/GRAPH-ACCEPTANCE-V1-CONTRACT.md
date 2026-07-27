# Graph Extended Acceptance v1 Contract

> Status: **product contract, performance revalidation, and Graph resilience fully signed as of 2026-07-26**. As historical focused evidence for this contract, the resilience source passed full `npm test`, Electron-enabled `npm run verify`, forced real-Electron 28/28, directed Graph suites, and independent review P0/P1/P2=0. The current project total is 32/32; see `v0/DEVELOPMENT-STATUS.md`.
> Graph schema: `writcraft.graph/v2`

## 1. Product truth and write boundary

The Consistency Graph is a project diagnostic view for entities, variables, events, time, relationships, evidence, and writing constraints. It defaults to the current-file subgraph and exposes an explicit whole-project scope. Filters, author corrections, issue status, and evidence navigation must operate on the currently displayed project only.

The Graph never edits manuscript bytes. Author correction writes only the bounded project correction ledger. “Generate reviewable fix” may create a Main-owned Issue→Changes review; only a complete, explicit Changes decision may modify manuscript files and History. Stale evidence, stale issue bindings, project switches, and late async results fail closed with zero manuscript/History writes and no reusable capability.

## 2. Required real-Electron journeys

1. **Filters and evidence:** use keyboard and pointer input to switch current/project scope and person, variable, inclusive time-range, file, issue, and search filters. A one-ended time range remains open toward the earliest/latest available time. Open attribute, timeline, evidence-gap, and prompt-drift diagnostics. Conflict issues must expose two distinct clickable evidence locators; an evidence gap exposes one claim locator plus an explicit missing-source state.
2. **Stale evidence:** after Graph build, change a bound source. The stale state must be visible before navigation. A stale repair cannot open Changes, call the model, mutate manuscript/History, or retain a capability. Reanalysis may create a fresh binding.
3. **Author corrections:** perform alias merge, attribute edit, and fact confirm/reject from the real UI. Public Markdown hashes remain unchanged; the correction ledger persists through reindex and restart. A delayed A-project correction resolved after switching to B cannot alter B UI or state.
4. **Issue→Changes:** preserve the existing complete-decision, preview-zero-write, apply, History, and Safe Undo journey; add bound-evidence drift rejection.
5. **Keyboard and announcements:** every interactive node, issue, evidence, and correction control has a correct accessible role/name, visible focus, Enter/Space behavior, and no nested interactive role conflict. Loading, success, stale, and failure states are announced through a live region.
6. **Layout:** at 1400×900, the supported minimum 1000×600, and 200% zoom, all primary filters/actions remain reachable, the toolbar and stage have no horizontal overflow, and detail content remains scrollable.

## 3. Large-graph quality and performance gates

The reproducible fixture contains at least 300 Markdown files and 500 graph nodes. On the current supported macOS development machine:

- cold Graph build becomes interactive within 2.5 seconds;
- cache hit completes within 700 ms and one-file incremental rebuild within 800 ms;
- filter/search visual updates complete within 100 ms;
- Graph opening adds no more than 150 MiB renderer memory;
- keyboard/pointer pan and zoom remain usable, with no single measured interaction task above 100 ms;
- layout must not clamp many nodes to the same radius. Issue/time nodes retain at least 16 graph-coordinate pixels between centers, and every focusable node has at least a 24×24 graph-coordinate hit target.

Large project rendering must use deterministic level-of-detail, clustering, or equivalent bounded rendering when the complete graph cannot remain legible. Labels are reduced before evidence, issue, or keyboard access is removed.

Filter performance must not depend on rebuilding the evidence index, layout, or complete baseline DOM scene for every projection. A Graph snapshot may cache evidence/path derivations and stable full-graph positions. The exact graph/scope/current-path/selection baseline remains continuously attached; type projections use scene-level visibility and file/time/search projections use non-reparenting secondary visibility. Every edge with either endpoint absent is hidden. Clearing a projection must restore that baseline without recreating, detaching, or reparenting its nodes and edges, preserving focus, accessible identity, and event listeners.

The 100 ms filter gate ends only after the result has crossed visible animation frames and the test has read computed visibility plus SVG layout. Type, file, time start, time end, and search changes are measured individually; dispatch-only timings are not acceptance evidence.

Every Renderer Graph snapshot is a bounded plain-data clone frozen recursively before publication. Accessors, hidden or symbol fields, sparse or oversized arrays, custom prototypes, and cycles fail closed without executing getters. Main rebuilds a canonical per-file contribution from each authoritative file snapshot; cache reuse and injected analyzers must match its evidence and complete semantic graph exactly. Late build/correction/refresh results are owned by both project instance and request sequence. If a correction may already have committed its ledger but its returned Graph is invalid, Renderer clears stale Graph-derived state and announces recovery instead of retaining an obsolete view.

## 4. Evidence and sign-off order

Node/service tests must cover filter composition, issue evidence cardinality, stale bindings, correction persistence, zero-write guarantees, cache reuse, incremental rebuild, and measured budgets. Real Electron must cover the journeys above and verify viewport geometry from actual rendered rectangles. Source-string or VM checks alone are insufficient.

Sign-off order: frozen contract → implementation and directed tests → real-Electron journeys → independent accessibility/security/performance review with P0/P1 closed → full `npm test` → Electron-enabled `npm run verify` → forced Electron E2E. Existing App/ZIP artifacts remain non-distributable until the later real API (including image-01), real-author, clean-packaging and release gates are closed.

The 2026-07-23 revalidation intentionally retained the failure chain: file filtering first measured 233.8 ms, clearing it measured 163.8 ms after the first fix, and `issues → all` later measured 150.5 ms. These failures exposed repeated evidence indexing/layout, destructive baseline ownership, full-element reparenting, unconditional scene detach, and a dispatch-only timing blind spot. As historical focused evidence for this Graph performance batch, the source passed Graph Filter 16/16, Workbench 14/14, Renderer Dynamic 9/9, and Large 5/5; full `npm test` and Electron-enabled `npm run verify` exited 0; independent final review was P0=0/P1=0/P2=0. With no intervening source change, two consecutive forced-Electron runs both passed 26/26 under the visible-frame budget. The performance revalidation was therefore closed; one retry green was never used as sign-off.

As later historical focused evidence for the Graph resilience batch, Consistency 22/22, Graph Index 15/15, Filter 17/17, Workbench 14/14, Renderer Dynamic 14/14 and Large 5/5 passed; 300-file cold/cache/one-file incremental measurements were 92.2 ms, 60.5–66.9 ms and 80.7 ms. Independent final review was P0=0/P1=0/P2=0. Full `npm test` and Electron-enabled `npm run verify` exited 0, including real DOM sanitizer 13/13; the same-source forced real-Electron journey passed 28/28. The current cross-project total remains owned by `v0/DEVELOPMENT-STATUS.md`.
