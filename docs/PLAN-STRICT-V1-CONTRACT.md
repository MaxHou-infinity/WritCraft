# Project Plan Strict Output Contract

> Status: implemented and independently reviewed at the original boundary. The 21/21 and 26/26 results below are historical focused evidence. On 2026-07-31, real-author output exposed peripheral text and then a non-array second-task `targetPaths`; candidate `94e6099` retains strict parsing and zero local coercion while adding one shared, dependency-revalidated retry for those exact content-free envelope/array-shape classifications. Current Plan evidence is 22/22 plus forced Electron 37/37; the new delta still awaits independent review and one real same-goal rerun. Authoritative current status remains `v0/DEVELOPMENT-STATUS.md`.
> Public plan schema: `writcraft.plan/v2`

## 1. Product and authority boundary

Project Plan Mode is a read-only planning operation. Main reads the authoritative `edit.md` first, then only the Markdown context files explicitly selected by the user. The model may propose milestones, tasks, dependencies, and existing target paths; it cannot create content, return a ChangeSet, receive a write capability, or mutate the project. A later Plan→Changes request is a separate reviewable workflow and re-reads every authoritative dependency.

Plan generation must leave all public project bytes, History, pending ChangeSets, and mutation generations unchanged. A failed or rejected model result produces no cached handoff record.

Main serializes the final provider request before dispatch and rejects bodies above 1 MiB as `PLAN_PROMPT_TOO_LARGE`. This includes the complete sorted project-path allowlist and prevents the network adapter from becoming the first request-size gate.

## 2. Exact model envelope

The provider must report one text block and no additional or non-text blocks:

```json
{
  "ok": true,
  "stopReason": "end_turn",
  "contentBlockCount": 1,
  "textBlockCount": 1,
  "nonTextBlockCount": 0,
  "text": "{...}"
}
```

Main validates safe completion metadata before parsing model text. When `stopReason` is present, `"max_tokens"` maps to `MODEL_OUTPUT_TRUNCATED`, every unknown or non-`end_turn` ending maps to `MODEL_OUTPUT_INCOMPLETE`, and `"end_turn"` with an invalid content-block shape maps to `INVALID_MODEL_OUTPUT`, even if the provider also reports `ok:false`. An `ok:true` result with a missing `stopReason` is incomplete. Only failures without completion metadata remain bounded `{ok:false,error,message}` provider results. No error echoes model text, prompts, paths, or credentials.

## 3. Strict JSON result

`text` must be exactly one JSON object and at most 512 KiB UTF-8. Oversized output maps to the existing `MODEL_OUTPUT_TOO_LARGE` code. Markdown fences, prefixes, suffixes, concatenated values, NUL bytes, duplicate keys at any depth, `__proto__`, `prototype`, `constructor`, depth above 32, and more than 4096 JSON nodes are rejected before a complete model-controlled tree is materialized. There is no JSON extraction, repair, retry with a looser parser, local string-to-array coercion, or plain-text fallback.

The top-level keys are exactly `title`, `summary`, `assumptions`, `openQuestions`, and `milestones`. Milestones and tasks retain the existing exact shapes and bounds. Every listed key is required, even when an array is empty. `assumptions`, `openQuestions`, `milestones`, milestone `acceptanceCriteria`/`tasks`, and every task's `targetPaths`/`dependsOn`/`acceptanceCriteria` must be JSON arrays for every repeated item, not only the first example. IDs remain unique and ordered dependencies may reference only earlier tasks. `targetPaths` may contain only existing public Markdown files, with at most 60 unique targets across the whole plan. Main reads no more than 16 MiB of additional target snapshots, immediately discards their content, and exposes only revision-bound `targets`; exceeding the aggregate budget is `PLAN_TARGETS_TOO_LARGE`. Plan generation has no successful no-op outcome: empty milestones or tasks are `INVALID_MODEL_OUTPUT`, and every failure leaves no cached handoff record.

Main may make one and only one second provider call when the first completed output is classified exactly as peripheral JSON text or an invalid required-array shape/count. Both classifications share the same retry budget. The retry prompt contains no rejected output, restates the complete strict schema, and is dispatched only after Main revalidates the complete Markdown tree plus the frozen `edit.md` and explicit-context revisions/content. Drift returns `PLAN_DEPENDENCY_STALE` before the second call. Any second failure is terminal; no operation may make a third provider call.

Validation order is: safe `stopReason` metadata when present, content blocks, provider failure without completion metadata, required `stopReason`, raw text/type/byte limit, bounded duplicate-key/depth/node scan, JSON parse, plain-object/exact-key checks, then field and graph validation.

## 4. Acceptance evidence

Sign-off requires directed service tests covering all rejection classes, a mutation sentinel proving zero writes, Main/IPC integration coverage proving rejected plans are not cached, full `npm test`, Electron-enabled `npm run verify`, forced real-Electron Plan journey, and independent review with P0/P1 closed. Existing App/ZIP artifacts remain non-distributable until the later release gate.

The 2026-07-23 nonblocking handler gaps are closed: `src/main/project-plan-handler.js` owns an injectable production handler used by the actual IPC registration. Plan handoff 15/15 dynamically covers rejected results, successful cache binding and private-record stripping, post-model project/generation drift, and thrown error→`projectFailure`; the Main registration is also pinned to all ten injected dependencies. The same batch passed Project Plan 19/19, Assistant integration 11/11, Network boundary 13/13, and full `npm test`; final independent review found P0=0/P1=0/P2=0.
