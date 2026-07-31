'use strict';

// Deterministic Main-process provider for the real Electron E2E only. Main
// loads this module behind both !app.isPackaged and WRITCRAFT_E2E_AI_FIXTURE=1;
// no fixture object or control channel is exposed to the renderer.

const TEXT_ENDPOINT = 'https://api.minimaxi.com/anthropic/v1/messages';
const IMAGE_ENDPOINT = 'https://api.minimaxi.com/v1/image_generation';
const API_KEY = 'sk-api-writcraft-e2e-fixture-only';
const IMAGE_PROMPT = 'WritCraft E2E 配图验收：旧港档案室';
const ONBOARDING_MARKER = 'E2E 项目卡已确认写入';
const ONBOARDING_RERUN_MARKER = 'E2E 项目卡已重新整理并生成新授权';
const ONBOARDING_CHANGED_REQUEST = '用真实 GUI 验证项目卡写入边界';
const ONBOARDING_NOOP_REQUEST = 'E2E 通过完整十题向导验证 no-op 与零选择授权';
const CHAT_QUESTION = 'E2E 验证默认文件级上下文';
const CHAT_RESPONSE = 'E2E Chat 已且仅收到项目 Prompt 与当前文件。';
const SECTIONED_CHAT_QUESTION = 'E2E 验证超长 edit.md 分区上下文';
const SECTIONED_CHAT_RESPONSE = 'E2E Chat 已收到超长 edit.md 的必需章节，并省略可选溢出章节。';
const MULTI_TURN_FIRST_QUESTION = 'E2E 多轮第一问：本章的核心矛盾是什么？';
const MULTI_TURN_FIRST_RESPONSE = 'E2E 多轮第一答：核心矛盾是公开承诺与执行证据之间的落差。';
const MULTI_TURN_SECOND_QUESTION = 'E2E 多轮第二问：沿用刚才的矛盾给出一个小标题。';
const MULTI_TURN_SECOND_RESPONSE = 'E2E 多轮第二答：建议小标题为“承诺与证据之间”。';
const MULTI_TURN_RESET_QUESTION = 'E2E 新对话验证：不要沿用旧摘要。';
const MULTI_TURN_RESET_RESPONSE = 'E2E 新对话已确认没有沿用旧摘要。';
const SAME_PROJECT_REOPEN_QUESTION = 'E2E 同项目重开验证：必须建立空白会话。';
const SAME_PROJECT_REOPEN_RESPONSE = 'E2E 同项目重开已清除旧摘要和在途请求。';
const CHAT_CURRENT_PATH = 'chapters/07-electron-e2e.md';
const STALE_CHAT_QUESTION = 'E2E 验证失效预检上下文';
const STALE_CHAT_RESPONSE = 'E2E 失效请求不应显示此响应。';
const STALE_REOPEN_CHAT_QUESTION = 'E2E 验证重开失效预检上下文';
const STALE_REOPEN_CHAT_RESPONSE = 'E2E 重开失效请求不应显示此响应。';
const STALE_WORKSPACE_CHAT_QUESTION = 'E2E 验证工作区失效预检上下文';
const STALE_WORKSPACE_CHAT_RESPONSE = 'E2E 工作区失效请求不应显示此响应。';
const STALE_SELECTION_CHAT_QUESTION = 'E2E 验证失效选区预检上下文';
const STALE_SELECTION_CHAT_RESPONSE = 'E2E 失效选区请求不应显示此响应。';
const PROJECT_CHAT_QUESTION = '@file:chapters/03-archive-room.md @section:"第三章 · 档案室" @entity:node_0d771a1daf6cfddb @source:"海岬城旧港公开听证纪要" 季度复核为什么重要？';
const PROJECT_CHAT_QUERY = '季度复核为什么重要？';
const PROJECT_CHAT_RESPONSE = 'E2E 项目作用域已收到显式引用与受限检索片段。';
const SELECTION_CHAT_QUESTION = 'E2E 验证选区与相邻段落';
const SELECTION_CHAT_RESPONSE = 'E2E 选区作用域已精确收到前后相邻段落。';
const REWRITE_BEFORE = 'E2E_INLINE_NEIGHBOR_BEFORE';
const REWRITE_TARGET = 'E2E_INLINE_TARGET 这句话需要校改。';
const REWRITE_AFTER = 'E2E_INLINE_NEIGHBOR_AFTER';
const REWRITE_FAR = 'E2E_INLINE_FAR_MUST_NOT_REACH_PROVIDER';
const REWRITE_OUTPUT = 'E2E Inline Rewrite 已由 Main 权威上下文生成。';
const RESEARCH_TARGET_PATH = CHAT_CURRENT_PATH;
const RESEARCH_BEFORE = REWRITE_FAR;
const RESEARCH_AFTER = 'E2E_RESEARCH_APPLIED_WITH_PROVENANCE';
const CHANGES_REVIEW_GOAL = 'E2E 验证两个文件三块修改的独立审阅';
const CHANGES_SECOND_PATH = 'chapters/01-arrival.md';
const CHANGES_BEFORE = Object.freeze([
  'E2E_CHANGES_HUNK_ONE_BEFORE',
  'E2E_CHANGES_HUNK_TWO_BEFORE',
  'E2E_CHANGES_HUNK_THREE_BEFORE',
]);
const CHANGES_AFTER = Object.freeze([
  'E2E_CHANGES_HUNK_ONE_AFTER',
  'E2E_CHANGES_HUNK_TWO_AFTER',
  'E2E_CHANGES_HUNK_THREE_AFTER',
]);
const CHAPTER_GOAL = 'E2E 分阶段生成并整体重写当前章节';
const CHAPTER_GENERATED_MARKER = 'E2E_CHAPTER_PLANNED_BLOCK_GENERATED';
const PLAN_GOAL = 'E2E 通过计划任务更新锁定章节';
const PLAN_STRICT_RETRY_GOAL = 'E2E Plan strict 失败后可重试';
const PLAN_BEFORE = 'E2E_PLAN_TARGET_BEFORE';
const PLAN_AFTER = 'E2E_PLAN_TARGET_AFTER';
const PROPOSAL_RACE_GOAL = 'E2E 延迟普通提案不得覆盖 Plan';
const PROPOSAL_RACE_BEFORE = 'E2E_PROPOSAL_RACE_BEFORE';
const PROPOSAL_RACE_AFTER = 'E2E_PROPOSAL_RACE_AFTER';
const GRAPH_ISSUE_BEFORE_ONE = '正式签约早于社区调查。';
const GRAPH_ISSUE_AFTER_ONE = '正式签约晚于社区调查。';
const GRAPH_ISSUE_BEFORE_TWO = '之后每次引用效率数字，都必须同时说明时间范围和统计口径。';
const GRAPH_ISSUE_AFTER_TWO = '之后每次引用效率数字，都必须同时说明时间范围、统计口径与对应证据。';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAAFklEQVR4nGPQ9wz/TwlmGDVg1AAgBgBNoQPwF6IA3wAAAABJRU5ErkJggg==';

function jsonResponse(payload) {
  const body = JSON.stringify(payload);
  return {
    ok: true,
    status: 200,
    headers: { get(name) { return String(name).toLowerCase() === 'content-length' ? String(Buffer.byteLength(body)) : null; } },
    async text() { return body; },
  };
}

function parseBody(options, expectedMethod) {
  if (!options || options.method !== expectedMethod || options.redirect !== 'error' || typeof options.body !== 'string') {
    throw new Error('E2E_FIXTURE_INVALID_REQUEST');
  }
  try { return JSON.parse(options.body); }
  catch (_) { throw new Error('E2E_FIXTURE_INVALID_JSON'); }
}

function researchCard(prompt) {
  if (typeof prompt !== 'string' || !prompt.includes('WritCraft 的本地证据 Research 助手')) {
    throw new Error('E2E_FIXTURE_UNHANDLED_TEXT');
  }
  const match = prompt.match(/<local-source id=("src_[a-f0-9]{20}")[^>]*>\n([\s\S]*?)\n<\/local-source>/);
  if (!match) throw new Error('E2E_FIXTURE_MISSING_SOURCE');
  const sourceId = JSON.parse(match[1]);
  const content = match[2];
  const preferred = '决议：调度系统进入六个月附条件试运行。';
  const quote = content.includes(preferred)
    ? preferred
    : content.split(/\r?\n/).map(line => line.trim()).find(line => line && !line.startsWith('#'));
  if (!quote) throw new Error('E2E_FIXTURE_MISSING_QUOTE');
  const offset = content.indexOf(quote);
  return {
    cards: [{
      claim: '公开听证纪要支持“调度系统仅进入附条件试运行”这一主张。',
      sourceId,
      quote,
      offset,
      end: offset + quote.length,
      boundary: '该证据不能支持系统已正式验收，也不能证明试运行的最终效果。',
    }],
  };
}

function researchChangesAnswer(prompt) {
  if (!prompt.includes('WritCraft 的 Research→Changes 局部修订执行器') ||
      !prompt.includes('<research-card-data>') || !prompt.includes('<evidence-source-readonly') ||
      !prompt.includes('<project-prompt-readonly') || !prompt.includes('不得返回完整 after 文件')) {
    throw new Error('E2E_FIXTURE_INVALID_RESEARCH_HANDOFF');
  }
  const target = prompt.match(/<target path=("[^"]+") revision="[a-f0-9]{64}">\n([\s\S]*?)\n<\/target>/);
  if (!target) throw new Error('E2E_FIXTURE_MISSING_RESEARCH_TARGET');
  const filePath = JSON.parse(target[1]);
  if (filePath !== RESEARCH_TARGET_PATH || !target[2].includes(RESEARCH_BEFORE)) {
    throw new Error('E2E_FIXTURE_INVALID_RESEARCH_TARGET');
  }
  return { edits: [{
    path: filePath,
    oldText: RESEARCH_BEFORE,
    newText: RESEARCH_AFTER,
    summary: '依据人工核对的来源卡片补入有边界的修改',
  }] };
}

function onboardingProposal(rerun = false, options = {}) {
  return {
    summary: '根据项目卡更新项目主旨',
    sections: [
      { id: 'premise', content: rerun ? ONBOARDING_RERUN_MARKER : ONBOARDING_MARKER },
    ],
    fileSuggestions: options.noSuggestions === true ? [] : [
      { path: 'onboarding-a.md', title: '项目卡初始文件 A', reason: '验证原子批量创建' },
      { path: 'onboarding-b.md', title: '项目卡初始文件 B', reason: '验证冲突时零部分创建' },
    ],
  };
}

function onboardingRequestKind(prompt, callNumber) {
  const answers = [...prompt.matchAll(/<project-answer id="([^"]+)" label="([^"]+)">\n([\s\S]*?)\n<\/project-answer>/g)];
  const projectPrompts = [...prompt.matchAll(/<project-file role="project_prompt" path="edit\.md" revision="[a-f0-9]{64}">/g)];
  const existingPaths = [...prompt.matchAll(/<existing-project-paths>/g)];
  if (answers.length !== 1 || answers[0][1] !== 'premise' || answers[0][2] !== '内容主旨' ||
      projectPrompts.length !== 1 || (prompt.match(/<\/project-file>/g) || []).length !== 1 ||
      existingPaths.length !== 1 || (prompt.match(/<\/existing-project-paths>/g) || []).length !== 1 ||
      !prompt.includes('严禁返回完整 edit.md、editContent、文件 content、Front Matter、初稿或任何文件正文。') ||
      !prompt.includes('严禁 edit.md（含大小写变体）') ||
      !prompt.includes('.writcraft/**、references/**、sources/**') ||
      !prompt.includes('如果没有安全建议，必须返回空数组')) {
    throw new Error('E2E_FIXTURE_INVALID_ONBOARDING_V2_PROMPT');
  }
  const answer = answers[0][3];
  const expected = callNumber <= 3 ? ONBOARDING_CHANGED_REQUEST : ONBOARDING_NOOP_REQUEST;
  if (answer !== expected) throw new Error('E2E_FIXTURE_INVALID_ONBOARDING_V2_SEQUENCE');
  return answer === ONBOARDING_NOOP_REQUEST ? 'no_op' : 'changed';
}

function hasCurrentOnboardingMarkers(prompt) {
  const count = needle => prompt.split(needle).length - 1;
  return count(ONBOARDING_MARKER) === 1 && count(ONBOARDING_RERUN_MARKER) === 1;
}

function chatAnswer(prompt) {
  const scopeHeader = '[上下文 · scope · file]';
  const projectHeader = '[上下文 · project prompt · edit.md]';
  const fileHeader = `[上下文 · file · ${CHAT_CURRENT_PATH}]`;
  const count = needle => prompt.split(needle).length - 1;
  if (count(scopeHeader) !== 1 || count(projectHeader) !== 1 || count(fileHeader) !== 1 ||
      prompt.includes('[权威项目 Prompt · edit.md]') ||
      !hasCurrentOnboardingMarkers(prompt) ||
      !prompt.includes('Electron project lifecycle')) {
    throw new Error('E2E_FIXTURE_INVALID_CHAT_CONTEXT');
  }
  return CHAT_RESPONSE;
}

function sectionedChatAnswer(prompt) {
  const requiredMarkers = [
    'E2E_SECTIONED_PREMISE',
    'E2E_SECTIONED_SCOPE',
    'E2E_SECTIONED_ENTITY',
    'E2E_SECTIONED_TIMELINE',
  ];
  const count = needle => prompt.split(needle).length - 1;
  if (requiredMarkers.some(marker => count(marker) !== 1) ||
      prompt.includes('E2E_OPTIONAL_OVERFLOW_MUST_BE_OMITTED') ||
      count('[上下文 · project prompt · edit.md]') !== 1 ||
      count(`[上下文 · file · ${CHAT_CURRENT_PATH}]`) !== 1) {
    throw new Error('E2E_FIXTURE_INVALID_SECTIONED_CHAT_CONTEXT');
  }
  return SECTIONED_CHAT_RESPONSE;
}

function firstMultiTurnChatAnswer(prompt) {
  chatAnswer(prompt);
  if (prompt.includes('最近对话摘要') ||
      prompt.includes(MULTI_TURN_FIRST_RESPONSE) ||
      prompt.includes(MULTI_TURN_SECOND_QUESTION)) {
    throw new Error('E2E_FIXTURE_MULTI_TURN_FIRST_NOT_EMPTY');
  }
  return MULTI_TURN_FIRST_RESPONSE;
}

function secondMultiTurnChatAnswer(prompt) {
  chatAnswer(prompt);
  const count = needle => prompt.split(needle).length - 1;
  if (count('最近对话摘要（由 Main 有界保存') !== 1 ||
      count(MULTI_TURN_FIRST_QUESTION) !== 1 ||
      count(MULTI_TURN_FIRST_RESPONSE) !== 1 ||
      count(MULTI_TURN_SECOND_QUESTION) !== 1) {
    throw new Error('E2E_FIXTURE_MULTI_TURN_SUMMARY_INVALID');
  }
  return MULTI_TURN_SECOND_RESPONSE;
}

function resetMultiTurnChatAnswer(prompt) {
  chatAnswer(prompt);
  if (prompt.includes('最近对话摘要') ||
      prompt.includes(MULTI_TURN_FIRST_QUESTION) ||
      prompt.includes(MULTI_TURN_FIRST_RESPONSE) ||
      prompt.includes(MULTI_TURN_SECOND_QUESTION) ||
      prompt.includes(MULTI_TURN_SECOND_RESPONSE)) {
    throw new Error('E2E_FIXTURE_MULTI_TURN_RESET_FAILED');
  }
  return MULTI_TURN_RESET_RESPONSE;
}

function sameProjectReopenChatAnswer(prompt) {
  chatAnswer(prompt);
  for (const forbidden of [
    '最近对话摘要',
    MULTI_TURN_RESET_QUESTION,
    MULTI_TURN_RESET_RESPONSE,
    STALE_REOPEN_CHAT_QUESTION,
    STALE_REOPEN_CHAT_RESPONSE,
  ]) {
    if (prompt.includes(forbidden)) throw new Error('E2E_FIXTURE_SAME_PROJECT_REOPEN_HISTORY_LEAK');
  }
  return SAME_PROJECT_REOPEN_RESPONSE;
}

function projectChatAnswer(prompt) {
  const required = [
    '[上下文 · scope · project]',
    '[上下文 · project prompt · edit.md]',
    '[上下文 · file · chapters/03-archive-room.md]',
    '[上下文 · section · chapters/03-archive-room.md]',
    '[上下文 · entity · 周鹭]',
    '[上下文 · source · 海岬城旧港公开听证纪要]',
    '[上下文 · retrieval ·',
  ];
  if (required.some(value => !prompt.includes(value)) ||
      prompt.includes(`[上下文 · file · ${CHAT_CURRENT_PATH}]`) ||
      prompt.includes(STALE_CHAT_QUESTION) ||
      prompt.includes(STALE_CHAT_RESPONSE) ||
      !prompt.includes('确定性检索匹配')) {
    throw new Error('E2E_FIXTURE_INVALID_PROJECT_CHAT_CONTEXT');
  }
  return PROJECT_CHAT_RESPONSE;
}

function selectionChatAnswer(prompt) {
  const required = [
    '[上下文 · scope · selection]',
    '[上下文 · project prompt · edit.md]',
    `[上下文 · selection · ${CHAT_CURRENT_PATH}]`,
    `[上下文 · neighbor · ${CHAT_CURRENT_PATH}]`,
  ];
  const count = needle => prompt.split(needle).length - 1;
  if (required.some(value => !prompt.includes(value)) || count(`[上下文 · neighbor · ${CHAT_CURRENT_PATH}]`) !== 2 ||
      !prompt.includes(REWRITE_BEFORE) || !prompt.includes(REWRITE_OUTPUT) || !prompt.includes(REWRITE_AFTER) ||
      prompt.includes(REWRITE_FAR) || prompt.includes(`[上下文 · file · ${CHAT_CURRENT_PATH}]`)) {
    throw new Error('E2E_FIXTURE_INVALID_SELECTION_CHAT_CONTEXT');
  }
  return SELECTION_CHAT_RESPONSE;
}

function rewriteAnswer(prompt) {
  const count = needle => prompt.split(needle).length - 1;
  if (!hasCurrentOnboardingMarkers(prompt) ||
      count(REWRITE_BEFORE) !== 1 ||
      count(REWRITE_TARGET) !== 1 ||
      count(REWRITE_AFTER) !== 1 ||
      count('<project-prompt>') !== 1 ||
      count('<rewrite-selection>') !== 1 ||
      !prompt.includes('作者改写要求："精简表达，同时保留原意"') ||
      !prompt.includes('<previous-block>') || !prompt.includes('<next-block>') ||
      prompt.includes(REWRITE_FAR) || prompt.includes('[当前编辑器上下文]') ||
      prompt.includes('[权威项目 Prompt · edit.md]')) {
    throw new Error('E2E_FIXTURE_INVALID_REWRITE_CONTEXT');
  }
  console.log('[e2e-fixture] INLINE_REWRITE_PROVIDER_CALL');
  return JSON.stringify({
    schema: 'writcraft.inline-rewrite-result/v1',
    replacement: REWRITE_OUTPUT,
    summary: 'E2E 严格 JSON 改写',
  });
}

function normalFile(prompt, marker) {
  const files = [...prompt.matchAll(/<project-file role="target" path="([^"]+)" revision="[a-f0-9]{64}">\n([\s\S]*?)\n<\/project-file>/g)];
  const match = files.find(item => item[2].includes(marker));
  if (!match) throw new Error('E2E_FIXTURE_MISSING_CHANGE_TARGET');
  return { path: match[1], content: match[2] };
}

function planTargetFile(prompt, marker) {
  const files = [...prompt.matchAll(/<project-file roles=[^>]+ path="([^"]+)" revision="[a-f0-9]{64}">\n([\s\S]*?)\n<\/project-file>/g)];
  const match = files.find(item => item[2].includes(marker));
  if (!match) throw new Error('E2E_FIXTURE_MISSING_PLAN_TARGET');
  return { path: match[1], content: match[2] };
}

function issueTargetFile(prompt, marker) {
  const files = [...prompt.matchAll(/<project-file role="target" path="([^"]+)" revision="[a-f0-9]{64}">\n([\s\S]*?)\n<\/project-file>/g)];
  const match = files.find(item => item[2].includes(marker));
  if (!match) throw new Error('E2E_FIXTURE_MISSING_GRAPH_ISSUE_TARGET');
  return { path: match[1], content: match[2] };
}

function changesReviewAnswer(prompt) {
  const primary = normalFile(prompt, CHANGES_BEFORE[0]);
  const secondary = normalFile(prompt, CHANGES_BEFORE[2]);
  if (!primary.content.includes(CHANGES_BEFORE[1]) || primary.path === secondary.path ||
      secondary.path !== CHANGES_SECOND_PATH) throw new Error('E2E_FIXTURE_INVALID_CHANGE_TARGET');
  return { edits: [
    ...CHANGES_BEFORE.slice(0, 2).map((marker, index) => ({
      path: primary.path,
      oldText: marker,
      newText: CHANGES_AFTER[index],
      summary: '主文件的两个独立审阅修改块',
    })),
    {
      path: secondary.path,
      oldText: CHANGES_BEFORE[2],
      newText: CHANGES_AFTER[2],
      summary: '第二文件的独立审阅修改块',
    },
  ] };
}

function chapterPlanAnswer(prompt) {
  if (!prompt.includes(`用户指令：${CHAPTER_GOAL}`) ||
      !prompt.includes(`<project-file role="project_prompt" path="edit.md"`) ||
      !prompt.includes(`<project-file role="target" path="${CHAT_CURRENT_PATH}"`)) {
    throw new Error('E2E_FIXTURE_INVALID_CHAPTER_PLAN');
  }
  return {
    schema: 'writcraft.chapter-generation-plan/v1',
    summary: 'E2E 分阶段整体重写章节',
    blocks: [{ id: 'whole', heading: '完整章节', goal: '保留正文并追加分阶段生成标记', targetChars: 3200 }],
  };
}

function chapterBlockAnswer(prompt) {
  if (!prompt.includes(`用户指令：${CHAPTER_GOAL}`) ||
      !prompt.includes('"id":"whole"') || !prompt.includes('当前区块序号：1/1') ||
      !prompt.includes('"schema":"writcraft.chapter-generation-block/v1","blockId":"whole"')) {
    throw new Error('E2E_FIXTURE_INVALID_CHAPTER_BLOCK');
  }
  const escapedPath = CHAT_CURRENT_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = prompt.match(new RegExp(`<project-file role="target" path="${escapedPath}" revision="[a-f0-9]{64}">\\n([\\s\\S]*?)\\n<\\/project-file>`));
  if (!match || match[1].includes(CHAPTER_GENERATED_MARKER)) throw new Error('E2E_FIXTURE_MISSING_CHAPTER_TARGET');
  return {
    schema: 'writcraft.chapter-generation-block/v1',
    blockId: 'whole',
    content: `${match[1].trimEnd()}\n\n${CHAPTER_GENERATED_MARKER}`,
  };
}

function proposalRaceAnswer(prompt) {
  const file = normalFile(prompt, PROPOSAL_RACE_BEFORE);
  if (!file.content.includes(PROPOSAL_RACE_BEFORE)) throw new Error('E2E_FIXTURE_INVALID_RACE_TARGET');
  return { edits: [{
    path: file.path,
    oldText: PROPOSAL_RACE_BEFORE,
    newText: PROPOSAL_RACE_AFTER,
    summary: '这个延迟提案必须在进入 Plan 后被丢弃',
  }] };
}

function planAnswer(prompt) {
  if (!prompt.includes(`用户目标：${PLAN_GOAL}`)) throw new Error('E2E_FIXTURE_INVALID_PLAN_GOAL');
  const pathMatch = prompt.match(/项目中可引用的 Markdown 路径：(\[[^\n]+\])/);
  const paths = pathMatch ? JSON.parse(pathMatch[1]) : [];
  const targetPath = paths.find(filePath => filePath === CHAT_CURRENT_PATH);
  if (!targetPath) throw new Error('E2E_FIXTURE_MISSING_PLAN_PATH');
  return {
    title: 'E2E 锁定章节计划',
    summary: '验证项目计划只通过审阅后的 Changes 写入。',
    assumptions: [],
    openQuestions: [],
    milestones: [{
      id: 'm1',
      title: '锁定章节',
      objective: '更新指定章节中的计划标记。',
      acceptanceCriteria: ['目标标记经人工接受后落盘'],
      tasks: [{
        id: 't1',
        title: '更新计划标记',
        description: '只修改锁定章节的计划验收标记。',
        scope: 'file',
        targetPaths: [targetPath],
        dependsOn: [],
        acceptanceCriteria: ['保留章节其他正文'],
      }],
    }],
  };
}

function planStrictRetryAnswer(prompt) {
  if (!prompt.includes(`用户目标：${PLAN_STRICT_RETRY_GOAL}`)) {
    throw new Error('E2E_FIXTURE_INVALID_PLAN_STRICT_RETRY_GOAL');
  }
  const pathMatch = prompt.match(/项目中可引用的 Markdown 路径：(\[[^\n]+\])/);
  const paths = pathMatch ? JSON.parse(pathMatch[1]) : [];
  const targetPath = paths.find(filePath => filePath === CHAT_CURRENT_PATH);
  if (!targetPath) throw new Error('E2E_FIXTURE_MISSING_PLAN_STRICT_RETRY_PATH');
  return {
    title: 'E2E strict 重试计划',
    summary: '验证严格 JSON 失败后可以使用同一目标重试。',
    assumptions: [],
    openQuestions: [],
    milestones: [{
      id: 'strict_retry_m1',
      title: '恢复计划生成',
      objective: '证明无效输出不会污染后续请求。',
      acceptanceCriteria: ['同一目标重试后显示任务卡'],
      tasks: [{
        id: 'strict_retry_t1',
        title: '验证 strict 恢复',
        description: '只绑定现有章节，不执行任何写入。',
        scope: 'file',
        targetPaths: [targetPath],
        dependsOn: [],
        acceptanceCriteria: ['任务卡可见且磁盘保持不变'],
      }],
    }],
  };
}

function assertPlanToolRequest(request) {
  const tool = request.tools?.[0];
  const targetPathsSchema = tool?.input_schema?.properties?.milestones?.items
    ?.properties?.tasks?.items?.properties?.targetPaths;
  if (request.max_tokens !== 8_192 || request.thinking !== undefined ||
      request.tools?.length !== 1 || tool?.name !== 'submit_project_plan' ||
      request.tool_choice?.type !== 'tool' || request.tool_choice?.name !== 'submit_project_plan' ||
      tool?.input_schema?.type !== 'object' || tool?.input_schema?.additionalProperties !== false ||
      targetPathsSchema?.type !== 'array' || targetPathsSchema?.maxItems !== 2) {
    throw new Error('E2E_FIXTURE_INVALID_PLAN_TOOL_PROTOCOL');
  }
}

function planChangesAnswer(prompt) {
  if (!prompt.includes(`"planGoal":"${PLAN_GOAL}"`)) throw new Error('E2E_FIXTURE_INVALID_PLAN_HANDOFF');
  const file = planTargetFile(prompt, PLAN_BEFORE);
  if (!prompt.includes('oldText') || !prompt.includes('不得返回完整 after 文件') ||
      !file.content.includes(PLAN_BEFORE)) throw new Error('E2E_FIXTURE_INVALID_PLAN_TARGET');
  return { edits: [{
    path: file.path,
    oldText: PLAN_BEFORE,
    newText: PLAN_AFTER,
    summary: '执行 Main 锁定的计划任务',
  }] };
}

function graphIssueChangesAnswer(prompt) {
  console.log('[e2e-fixture] GRAPH_ISSUE_PROVIDER_CALL');
  if (!prompt.includes('Graph Issue→Changes 修订执行器') ||
      !prompt.includes('edit.md 始终只读') || !prompt.includes('只读来源证据摘录')) {
    throw new Error('E2E_FIXTURE_INVALID_GRAPH_ISSUE_HANDOFF');
  }
  const file = issueTargetFile(prompt, GRAPH_ISSUE_BEFORE_ONE);
  if (!prompt.includes('oldText') || !prompt.includes('不得返回完整 after 文件') ||
      !file.content.includes(GRAPH_ISSUE_BEFORE_ONE) || !file.content.includes(GRAPH_ISSUE_BEFORE_TWO)) {
    throw new Error('E2E_FIXTURE_INVALID_GRAPH_ISSUE_TARGET');
  }
  return { edits: [
    {
      path: file.path,
      oldText: GRAPH_ISSUE_BEFORE_ONE,
      newText: GRAPH_ISSUE_AFTER_ONE,
      summary: '修正时间闭环',
    },
    {
      path: file.path,
      oldText: GRAPH_ISSUE_BEFORE_TWO,
      newText: GRAPH_ISSUE_AFTER_TWO,
      summary: '强化后续证据约束',
    },
  ] };
}

function createElectronAiProvider() {
  let onboardingCalls = 0;
  let planStrictRetryCalls = 0;
  let chapterBlockCalls = 0;
  return Object.freeze({
    apiKey: API_KEY,
    async textFetch(url, options) {
      if (url !== TEXT_ENDPOINT) throw new Error('E2E_FIXTURE_UNHANDLED_TEXT_ENDPOINT');
      const request = parseBody(options, 'POST');
      if (request.model !== 'MiniMax-M3' || !Array.isArray(request.messages) || request.messages.length !== 1 ||
          request.messages[0]?.role !== 'user' || typeof request.messages[0]?.content !== 'string') {
        throw new Error('E2E_FIXTURE_UNHANDLED_TEXT');
      }
      const prompt = request.messages[0].content;
      if ((prompt.includes('WritCraft 的普通 Project Changes 跨文件修订执行器') ||
          prompt.includes('WritCraft 的 Plan→Changes 修订执行器') ||
          prompt.includes('WritCraft 的 Graph Issue→Changes 修订执行器')) && request.max_tokens !== 8192) {
        throw new Error('E2E_FIXTURE_INVALID_LOCALIZED_MAX_TOKENS');
      }
      if (prompt.includes('WritCraft 的完整章节生成规划器') && request.max_tokens !== 4096) {
        throw new Error('E2E_FIXTURE_INVALID_CHAPTER_PLAN_MAX_TOKENS');
      }
      if (prompt.includes('WritCraft 的完整章节区块生成器') && request.max_tokens !== 6832) {
        throw new Error('E2E_FIXTURE_INVALID_CHAPTER_BLOCK_MAX_TOKENS');
      }
      let output;
      let planToolInput = null;
      if (prompt.includes('WritCraft Onboarding v2 项目建立助手')) {
        if (request.max_tokens !== 4096) throw new Error('E2E_FIXTURE_INVALID_ONBOARDING_V2_MAX_TOKENS');
        onboardingCalls += 1;
        const onboardingKind = onboardingRequestKind(prompt, onboardingCalls);
        if (onboardingCalls === 1) await new Promise(resolve => setTimeout(resolve, 1400));
        output = onboardingCalls === 1
          ? '{ malformed project proposal'
          : JSON.stringify(onboardingProposal(onboardingCalls >= 3, {
            noSuggestions: onboardingKind === 'no_op',
          }));
      } else if (prompt.includes('<rewrite-selection>')) {
        if (request.max_tokens !== 4096) throw new Error('E2E_FIXTURE_INVALID_REWRITE_MAX_TOKENS');
        await new Promise(resolve => setTimeout(resolve, 60));
        output = rewriteAnswer(prompt);
      } else if (prompt.includes('WritCraft 的项目级 Plan Mode 助手')) {
        assertPlanToolRequest(request);
        if (prompt.includes(`用户目标：${PLAN_STRICT_RETRY_GOAL}`)) {
          planStrictRetryCalls += 1;
          if (planStrictRetryCalls === 1 && prompt.includes('唯一一次结构重试')) {
            throw new Error('E2E_FIXTURE_EARLY_PLAN_FORMAT_RETRY');
          }
          if (planStrictRetryCalls === 2 && !prompt.includes('唯一一次结构重试')) {
            throw new Error('E2E_FIXTURE_MISSING_PLAN_FORMAT_RETRY');
          }
          const strictAnswer = planStrictRetryAnswer(prompt);
          if (planStrictRetryCalls === 1) {
            strictAnswer.milestones = Array.from({ length: 2 }, (_, index) => ({
              id: `strict_retry_m${index + 1}`,
              title: `复核里程碑 ${index + 1}`,
              objective: '验证长计划中每一个重复任务字段都受结构约束。',
              acceptanceCriteria: ['结构错误必须被严格拒绝'],
              tasks: [{
                id: `strict_retry_t${index + 1}`,
                title: `复核任务 ${index + 1}`,
                description: index === 1
                  ? '末里程碑目标路径故意为字符串'
                  : '验证前置任务保持数组结构',
                scope: 'file',
                targetPaths: index === 1 ? CHAT_CURRENT_PATH : [CHAT_CURRENT_PATH],
                dependsOn: [],
                acceptanceCriteria: ['结构正确且磁盘保持不变'],
              }],
            }));
          }
          planToolInput = strictAnswer;
        } else {
          planToolInput = planAnswer(prompt);
        }
      } else if (prompt.includes('WritCraft 的 Plan→Changes 修订执行器')) {
        output = JSON.stringify(planChangesAnswer(prompt));
      } else if (prompt.includes('WritCraft 的 Graph Issue→Changes 修订执行器')) {
        output = JSON.stringify(graphIssueChangesAnswer(prompt));
      } else if (prompt.includes('WritCraft 的 Research→Changes 局部修订执行器')) {
        output = JSON.stringify(researchChangesAnswer(prompt));
      } else if (prompt.includes(`用户指令：${PROPOSAL_RACE_GOAL}`)) {
        await new Promise(resolve => setTimeout(resolve, 700));
        output = JSON.stringify(proposalRaceAnswer(prompt));
      } else if (prompt.includes(`用户指令：${CHANGES_REVIEW_GOAL}`)) {
        output = JSON.stringify(changesReviewAnswer(prompt));
      } else if (prompt.includes('WritCraft 的完整章节生成规划器')) {
        output = JSON.stringify(chapterPlanAnswer(prompt));
      } else if (prompt.includes('WritCraft 的完整章节区块生成器')) {
        chapterBlockCalls += 1;
        const answer = chapterBlockAnswer(prompt);
        if (chapterBlockCalls === 1) {
          if (prompt.includes('唯一一次区块重试')) throw new Error('E2E_FIXTURE_PREMATURE_CHAPTER_RETRY');
          output = JSON.stringify({ ...answer, content: '' });
        } else {
          if (chapterBlockCalls !== 2 || !prompt.includes('唯一一次区块重试') ||
              !prompt.includes('empty 门禁')) {
            throw new Error('E2E_FIXTURE_MISSING_CHAPTER_CONTENT_RETRY');
          }
          output = JSON.stringify(answer);
        }
      } else if (prompt.includes(`问题：${STALE_CHAT_QUESTION}`)) {
        await new Promise(resolve => setTimeout(resolve, 700));
        chatAnswer(prompt);
        output = STALE_CHAT_RESPONSE;
      } else if (prompt.includes(`问题：${STALE_REOPEN_CHAT_QUESTION}`)) {
        await new Promise(resolve => setTimeout(resolve, 700));
        chatAnswer(prompt);
        output = STALE_REOPEN_CHAT_RESPONSE;
      } else if (prompt.includes(`问题：${STALE_WORKSPACE_CHAT_QUESTION}`)) {
        await new Promise(resolve => setTimeout(resolve, 700));
        chatAnswer(prompt);
        output = STALE_WORKSPACE_CHAT_RESPONSE;
      } else if (prompt.includes(`问题：${STALE_SELECTION_CHAT_QUESTION}`)) {
        await new Promise(resolve => setTimeout(resolve, 700));
        selectionChatAnswer(prompt);
        output = STALE_SELECTION_CHAT_RESPONSE;
      } else if (prompt.includes(`问题：${CHAT_QUESTION}`)) {
        output = chatAnswer(prompt);
      } else if (prompt.includes(`问题：${SECTIONED_CHAT_QUESTION}`)) {
        output = sectionedChatAnswer(prompt);
      } else if (prompt.includes(`问题：${MULTI_TURN_FIRST_QUESTION}`)) {
        output = firstMultiTurnChatAnswer(prompt);
      } else if (prompt.includes(`问题：${MULTI_TURN_SECOND_QUESTION}`)) {
        output = secondMultiTurnChatAnswer(prompt);
      } else if (prompt.includes(`问题：${MULTI_TURN_RESET_QUESTION}`)) {
        output = resetMultiTurnChatAnswer(prompt);
      } else if (prompt.includes(`问题：${SAME_PROJECT_REOPEN_QUESTION}`)) {
        output = sameProjectReopenChatAnswer(prompt);
      } else if (prompt.includes(`问题：${PROJECT_CHAT_QUERY}`)) {
        output = projectChatAnswer(prompt);
      } else if (prompt.includes(`问题：${SELECTION_CHAT_QUESTION}`)) {
        output = selectionChatAnswer(prompt);
      } else {
        output = JSON.stringify(researchCard(prompt));
      }
      if (planToolInput) {
        return jsonResponse({
          model: 'MiniMax-M3',
          content: [
            { type: 'thinking', thinking: 'E2E tool protocol reasoning' },
            { type: 'text', text: 'E2E 计划已提交。' },
            {
              type: 'tool_use',
              id: `call_plan_${planStrictRetryCalls || 1}`,
              name: 'submit_project_plan',
              input: planToolInput,
            },
          ],
          stop_reason: 'tool_use',
          usage: { input_tokens: 128, output_tokens: 64 },
        });
      }
      return jsonResponse({
        model: 'MiniMax-M3',
        content: [{ type: 'text', text: output }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 128, output_tokens: 64 },
      });
    },
    async imageFetch(url, options) {
      if (url !== IMAGE_ENDPOINT) throw new Error('E2E_FIXTURE_UNHANDLED_IMAGE_ENDPOINT');
      const request = parseBody(options, 'POST');
      if (request.model !== 'image-01' || request.prompt !== IMAGE_PROMPT || request.response_format !== 'base64' ||
          request.n !== 1 || !['1:1', '16:9', '4:3', '3:4', '9:16'].includes(request.aspect_ratio)) {
        throw new Error('E2E_FIXTURE_UNHANDLED_IMAGE');
      }
      // Keep the request in flight beyond native debounce and a full 1200 ms
      // polling round so E2E covers both own-save echo paths.
      await new Promise(resolve => setTimeout(resolve, 1700));
      return jsonResponse({ data: { image_base64: [PNG_BASE64] }, base_resp: { status_code: 0, status_msg: 'success' } });
    },
  });
}

module.exports = {
  TEXT_ENDPOINT,
  IMAGE_ENDPOINT,
  API_KEY,
  IMAGE_PROMPT,
  ONBOARDING_MARKER,
  ONBOARDING_RERUN_MARKER,
  ONBOARDING_CHANGED_REQUEST,
  ONBOARDING_NOOP_REQUEST,
  CHAT_QUESTION,
  CHAT_RESPONSE,
  SECTIONED_CHAT_QUESTION,
  SECTIONED_CHAT_RESPONSE,
  MULTI_TURN_FIRST_QUESTION,
  MULTI_TURN_FIRST_RESPONSE,
  MULTI_TURN_SECOND_QUESTION,
  MULTI_TURN_SECOND_RESPONSE,
  MULTI_TURN_RESET_QUESTION,
  MULTI_TURN_RESET_RESPONSE,
  SAME_PROJECT_REOPEN_QUESTION,
  SAME_PROJECT_REOPEN_RESPONSE,
  CHAT_CURRENT_PATH,
  STALE_CHAT_QUESTION,
  STALE_CHAT_RESPONSE,
  STALE_REOPEN_CHAT_QUESTION,
  STALE_REOPEN_CHAT_RESPONSE,
  STALE_WORKSPACE_CHAT_QUESTION,
  STALE_WORKSPACE_CHAT_RESPONSE,
  STALE_SELECTION_CHAT_QUESTION,
  STALE_SELECTION_CHAT_RESPONSE,
  PROJECT_CHAT_QUESTION,
  PROJECT_CHAT_QUERY,
  PROJECT_CHAT_RESPONSE,
  SELECTION_CHAT_QUESTION,
  SELECTION_CHAT_RESPONSE,
  REWRITE_BEFORE,
  REWRITE_TARGET,
  REWRITE_AFTER,
  REWRITE_FAR,
  REWRITE_OUTPUT,
  RESEARCH_TARGET_PATH,
  RESEARCH_BEFORE,
  RESEARCH_AFTER,
  CHANGES_REVIEW_GOAL,
  CHANGES_SECOND_PATH,
  CHANGES_BEFORE,
  CHANGES_AFTER,
  CHAPTER_GOAL,
  CHAPTER_GENERATED_MARKER,
  PLAN_GOAL,
  PLAN_STRICT_RETRY_GOAL,
  PLAN_BEFORE,
  PLAN_AFTER,
  PROPOSAL_RACE_GOAL,
  PROPOSAL_RACE_BEFORE,
  PROPOSAL_RACE_AFTER,
  GRAPH_ISSUE_BEFORE_ONE,
  GRAPH_ISSUE_AFTER_ONE,
  GRAPH_ISSUE_BEFORE_TWO,
  GRAPH_ISSUE_AFTER_TWO,
  PNG_BASE64,
  createElectronAiProvider,
};
