# Project Plan Strict Output Contract

> Status: the strict-text protocol was superseded by the 0.0BU single-tool boundary. 0.0BW then closed the output envelope at two milestones × two tasks and a 6,120-byte maximum fixture. Real operation `b915291982d14f8bb5520674280b3d0d` exposed the next narrower contract gap: MiniMax placed natural-language prose in the first task's `dependsOn` array and Main rejected it after 13,590 ms with zero writes. 0.0BX makes milestone/task IDs and dependencies exact short ASCII identifiers in both Schema and Main, forbids local trim/coercion, marks repeated arrays unique, and states that the first task has no dependency. Dependency ID/reference failures share the existing one-retry structural budget, never echo rejected input, and never permit a third call. Plan 26/26, handoff 15/15, UI 16/16, full test/verify and forced Electron 37/37 pass; independent review is P0/P1/P2=0. Exact candidate `1c7f178` is restarted; one new provider canary remains required. Authoritative current status remains `v0/DEVELOPMENT-STATUS.md`.
> Public plan schema: `writcraft.plan/v2`

## 1. Product and authority boundary

Project Plan Mode is a read-only planning operation. Main reads the authoritative `edit.md` first, then only the Markdown context files explicitly selected by the user. The model may propose milestones, tasks, dependencies, and existing target paths; it cannot create content, return a ChangeSet, receive a write capability, or mutate the project. A later Plan→Changes request is a separate reviewable workflow and re-reads every authoritative dependency.

Plan generation must leave all public project bytes, History, pending ChangeSets, and mutation generations unchanged. A failed or rejected model result produces no cached handoff record.

Main serializes the final provider request before dispatch and rejects bodies above 1 MiB as `PLAN_PROMPT_TOO_LARGE`. This includes the complete sorted project-path allowlist, tool schema and named choice, and prevents the network adapter from becoming the first request-size gate.

## 2. Exact tool envelope

Production authority is exactly one matching tool call. Thinking and explanatory text may coexist but are ignored:

```json
{
  "ok": true,
  "stopReason": "tool_use",
  "contentBlockCount": 3,
  "textBlockCount": 1,
  "toolUseBlockCount": 1,
  "nonTextBlockCount": 2,
  "text": "optional explanation",
  "toolUse": {
    "id": "bounded provider id",
    "name": "submit_project_plan",
    "input": {}
  }
}
```

Main validates safe completion metadata before reading tool input. `"max_tokens"` maps to `MODEL_OUTPUT_TRUNCATED`; an `ok:true` result with missing, unknown or non-`tool_use` completion maps to `MODEL_OUTPUT_INCOMPLETE`. Missing, wrong-name, malformed or more than one raw `tool_use` block fails closed. Provider failures remain bounded `{ok:false,error,message}` results. No error echoes model text, tool input, prompts, paths, or credentials.

Plan does not use `thinking` as a capacity control. The production endpoint is the China Anthropic-compatible API, whose current documentation differs from the international API and warns that some compatibility parameters may be ignored. Capacity must therefore be closed by the enforceable tool schema, not by a provider default or prompt adjective. Plan and the adapter keep the 8192-token cap and existing deadline; a `max_tokens` response is terminal even if it contains a seemingly complete tool block, and it never receives the structure retry.

## 3. Strict tool input

The adapter accepts only bounded plain-JSON tool input: dangerous keys, non-plain objects, depth above 32, more than 4096 nodes, and serialized input above 512 KiB fail closed. There is no text extraction, JSON repair, retry with a looser parser, local string-to-array coercion, or plain-text fallback. The old duplicate-aware raw-text scanner remains only as a historical compatibility/test helper; production Plan does not parse `end_turn` text JSON.

The top-level keys are exactly `title`, `summary`, `assumptions`, `openQuestions`, and `milestones`. Production no longer accepts these keys from an `end_turn` text JSON response. The request defines exactly one tool, `submit_project_plan`, whose `input_schema` sets `additionalProperties: false`, required keys, item bounds and array types at top-level, milestone and task depth; named `tool_choice` requests that exact tool. Main accepts only `stop_reason: tool_use` plus exactly one raw `tool_use` block whose bounded plain-JSON input is valid and whose name matches. Thinking or text may coexist but never becomes plan authority; missing, wrong, multiple or malformed tool calls fail closed without a text fallback.

Milestones and tasks retain the exact shapes but use an iterative Plan-generation capacity envelope: 1–2 milestones, 1–2 tasks per milestone, no more than 4 tasks total, up to two targets and two prior dependencies per task, and two items in each narrative list. Titles, summary, objective, description, list items, IDs and paths use the shorter schema maxima enforced by Main and mirrored defensively by Renderer. Authors can generate another plan after completing or revising this bounded set; one response is not an exhaustive whole-project backlog. Every listed key is required, even when an array is empty. IDs remain unique and ordered dependencies may reference only earlier tasks. `targetPaths` may contain only existing public Markdown files, with at most 8 structurally reachable unique targets across the whole plan. Main reads no more than 16 MiB of additional target snapshots, immediately discards their content, and exposes only revision-bound `targets`; exceeding the aggregate budget is `PLAN_TARGETS_TOO_LARGE`. Plan generation has no successful no-op outcome: empty milestones or tasks are `INVALID_MODEL_OUTPUT`, and every failure leaves no cached handoff record.

Main may make one and only one second provider call when the first completed tool input is classified exactly as an invalid required-array shape/count or invalid ID/dependency-reference structure. Milestone/task IDs and every dependency must already be exact short ASCII IDs; Main does not trim or repair them. `dependsOn` may reference only an earlier task ID, the first task must use `[]`, and duplicate items are forbidden in Schema and Main. The retry prompt contains no rejected input, restates the complete tool schema, and is dispatched only after Main revalidates the complete Markdown tree plus the frozen `edit.md` and explicit-context revisions/content. Drift returns `PLAN_DEPENDENCY_STALE` before the second call. Provider/HTTP/auth/tool-envelope failures do not receive a format retry. Any second failure is terminal; no operation may make a third provider call.

Validation order is: provider response byte/JSON boundary, safe `stopReason`, raw tool-use count, matching bounded plain-JSON tool input, exact top-level/milestone/task keys, then field, path, dependency, revision and graph validation.

## 4. Acceptance evidence

Sign-off requires directed service tests covering all rejection classes, a mutation sentinel proving zero writes, Main/IPC integration coverage proving rejected plans are not cached, full `npm test`, Electron-enabled `npm run verify`, forced real-Electron Plan journey, and independent review with P0/P1 closed. Existing App/ZIP artifacts remain non-distributable until the later release gate.

The 2026-07-23 nonblocking handler gaps are closed: `src/main/project-plan-handler.js` owns an injectable production handler used by the actual IPC registration. Plan handoff 15/15 dynamically covers rejected results, successful cache binding and private-record stripping, post-model project/generation drift, and thrown error→`projectFailure`; the Main registration is also pinned to all ten injected dependencies. The same batch passed Project Plan 19/19, Assistant integration 11/11, Network boundary 13/13, and full `npm test`; final independent review found P0=0/P1=0/P2=0.
