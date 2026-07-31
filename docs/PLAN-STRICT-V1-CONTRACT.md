# Project Plan Strict Output Contract

> Status: the original strict-text boundary was implemented and independently reviewed, but real-author evidence has superseded its generation protocol. After peripheral-text and second-task failures, operation `ef44ed234ceb417d9d8723fa918e3173` still failed at milestone 7 task 1 after 107,623 ms, proving prompt plus one retry cannot close repeated-field shape. 0.0BU therefore keeps all strict Main validation and zero local coercion while moving production Plan authority to one `submit_project_plan` tool input with a complete schema and named tool choice. Current focused evidence is MiniMax adapter 17/17, Plan 22/22, handoff 15/15 + 5/5, UI 16/16, Assistant 11/11 and forced Electron 37/37 after two preserved, non-reproduced timing red runs outside the changed Plan boundary. Independent review is P0=0/P1=0/P2=0; one real MiniMax named-tool canary remains required. Authoritative current status remains `v0/DEVELOPMENT-STATUS.md`.
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

## 3. Strict tool input

The adapter accepts only bounded plain-JSON tool input: dangerous keys, non-plain objects, depth above 32, more than 4096 nodes, and serialized input above 512 KiB fail closed. There is no text extraction, JSON repair, retry with a looser parser, local string-to-array coercion, or plain-text fallback. The old duplicate-aware raw-text scanner remains only as a historical compatibility/test helper; production Plan does not parse `end_turn` text JSON.

The top-level keys are exactly `title`, `summary`, `assumptions`, `openQuestions`, and `milestones`. Production no longer accepts these keys from an `end_turn` text JSON response. The request defines exactly one tool, `submit_project_plan`, whose `input_schema` sets `additionalProperties: false`, required keys, item bounds and array types at top-level, milestone and task depth; named `tool_choice` requests that exact tool. Main accepts only `stop_reason: tool_use` plus exactly one raw `tool_use` block whose bounded plain-JSON input is valid and whose name matches. Thinking or text may coexist but never becomes plan authority; missing, wrong, multiple or malformed tool calls fail closed without a text fallback.

Milestones and tasks retain the existing exact shapes and bounds. Every listed key is required, even when an array is empty. `assumptions`, `openQuestions`, `milestones`, milestone `acceptanceCriteria`/`tasks`, and every task's `targetPaths`/`dependsOn`/`acceptanceCriteria` must be arrays for every repeated item. IDs remain unique and ordered dependencies may reference only earlier tasks. `targetPaths` may contain only existing public Markdown files, with at most 60 unique targets across the whole plan. Main reads no more than 16 MiB of additional target snapshots, immediately discards their content, and exposes only revision-bound `targets`; exceeding the aggregate budget is `PLAN_TARGETS_TOO_LARGE`. Plan generation has no successful no-op outcome: empty milestones or tasks are `INVALID_MODEL_OUTPUT`, and every failure leaves no cached handoff record.

Main may make one and only one second provider call when the first completed tool input is classified exactly as an invalid required-array shape/count. The retry prompt contains no rejected input, restates the complete tool schema, and is dispatched only after Main revalidates the complete Markdown tree plus the frozen `edit.md` and explicit-context revisions/content. Drift returns `PLAN_DEPENDENCY_STALE` before the second call. Provider/HTTP/auth/tool-envelope failures do not receive a format retry. Any second failure is terminal; no operation may make a third provider call.

Validation order is: provider response byte/JSON boundary, safe `stopReason`, raw tool-use count, matching bounded plain-JSON tool input, exact top-level/milestone/task keys, then field, path, dependency, revision and graph validation.

## 4. Acceptance evidence

Sign-off requires directed service tests covering all rejection classes, a mutation sentinel proving zero writes, Main/IPC integration coverage proving rejected plans are not cached, full `npm test`, Electron-enabled `npm run verify`, forced real-Electron Plan journey, and independent review with P0/P1 closed. Existing App/ZIP artifacts remain non-distributable until the later release gate.

The 2026-07-23 nonblocking handler gaps are closed: `src/main/project-plan-handler.js` owns an injectable production handler used by the actual IPC registration. Plan handoff 15/15 dynamically covers rejected results, successful cache binding and private-record stripping, post-model project/generation drift, and thrown error→`projectFailure`; the Main registration is also pinned to all ten injected dependencies. The same batch passed Project Plan 19/19, Assistant integration 11/11, Network boundary 13/13, and full `npm test`; final independent review found P0=0/P1=0/P2=0.
