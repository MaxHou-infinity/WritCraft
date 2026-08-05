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
const UNIFIED_NAVIGATION_GOAL = 'E2E 一次点击进入正文内 Diff';
const UNIFIED_BEFORE = 'E2E_UNIFIED_TASK_BEFORE';
const UNIFIED_AFTER = 'E2E_UNIFIED_TASK_AFTER';
// The author-copy journey deliberately keeps its fixture marker in one new
// file inside the derived copy.  The surrounding prompt still comes from the
// selected real manuscript, so this provider can prove a real-author context
// without mutating or uploading the owner's source files.
const AUTHOR_CHAT_QUESTION = 'E2E 作者验收：请说明当前章节的目标。';
const AUTHOR_CHAT_RESPONSE = 'E2E 作者验收 Chat 已读取项目 Prompt 与当前章节。';
const AUTHOR_CANCEL_QUESTION = 'E2E 作者验收：取消一项长任务。';
const AUTHOR_CANCEL_RESPONSE = 'E2E 作者验收长任务不应显示。';
const AUTHOR_SWITCH_QUESTION = 'E2E 作者验收：切换项目后丢弃迟到结果。';
const AUTHOR_SWITCH_RESPONSE = 'E2E 项目 A 切换后迟到答案不应显示。';
const AUTHOR_TIMEOUT_QUESTION = 'E2E 作者验收：验证硬超时。';
const AUTHOR_TIMEOUT_RESPONSE = 'E2E 作者验收超时后的迟到答案不应显示。';
const AUTHOR_EDIT_REVISION_QUESTION = 'E2E 作者验收：edit.md revision 漂移后丢弃旧任务。';
const AUTHOR_EDIT_REVISION_RESPONSE = 'E2E edit.md revision 漂移后的迟到答案不应显示。';
const AUTHOR_NAVIGATION_GOAL = 'E2E 作者验收：压缩当前章节的一处重复表达。';
const AUTHOR_NAVIGATION_REVISION_GOAL = 'E2E 作者验收：Navigation edit.md revision 漂移后丢弃旧建议。';
const AUTHOR_NAVIGATION_REVISION_RESPONSE = 'E2E Navigation edit.md revision 漂移后的迟到建议不应显示。';
const AUTHOR_NAVIGATION_CANCEL_GOAL = 'E2E 作者验收：取消导航生成。';
const AUTHOR_NAVIGATION_CANCEL_RESPONSE = 'E2E 作者验收导航取消后的迟到答案不应显示。';
const AUTHOR_RESEARCH_REVISION_QUESTION = 'E2E 作者验收：Research edit.md revision 漂移后丢弃旧证据。';
const AUTHOR_RESEARCH_REVISION_RESPONSE = 'E2E Research edit.md revision 漂移后的迟到证据不应显示。';
const AUTHOR_RESEARCH_CANCEL_QUESTION = 'E2E 作者验收：取消 Research 证据检索。';
const AUTHOR_RESEARCH_CANCEL_RESPONSE = 'E2E 作者验收 Research 取消后的迟到答案不应显示。';
const AUTHOR_SOURCE_NEEDED_GOAL = 'E2E 作者验收：验证来源不足时显示添加来源。';
const AUTHOR_SOURCE_NEEDED_FINDING = 'E2E_SOURCE_NEEDED_FINDING';
let authorNeedsSourcesIssued = false;
const AUTHOR_BEFORE = 'E2E_AUTHOR_CROSS_ENTRY_BEFORE';
const AUTHOR_AFTER = 'E2E_AUTHOR_CROSS_ENTRY_AFTER';
const CHANGES_REVIEW_GOAL = 'E2E 验证两个文件三块修改的独立审阅';
const AUTHOR_CHANGES_REVISION_GOAL = 'E2E 作者验收：Changes edit.md revision 漂移后丢弃旧 Diff。';
const AUTHOR_CHANGES_REVISION_RESPONSE = 'E2E Changes edit.md revision 漂移后的迟到 Diff 不应显示。';
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
const AUTHOR_CHAPTER_REVISION_GOAL = 'E2E 作者验收：Chapter edit.md revision 漂移后丢弃旧计划。';
const AUTHOR_CHAPTER_REVISION_RESPONSE = 'E2E Chapter edit.md revision 漂移后的迟到计划不应显示。';
const CHAPTER_CANCEL_GOAL = 'E2E 作者验收：取消章节生成。';
const CHAPTER_CANCEL_RESPONSE = 'E2E 作者验收章节取消后的迟到答案不应显示。';
const CHAPTER_GENERATED_MARKER = 'E2E_CHAPTER_PLANNED_BLOCK_GENERATED';
const GRAPH_ISSUE_BEFORE_ONE = '正式签约早于社区调查。';
const GRAPH_ISSUE_AFTER_ONE = '正式签约晚于社区调查。';
const GRAPH_ISSUE_BEFORE_TWO = '之后每次引用效率数字，都必须同时说明时间范围和统计口径。';
const GRAPH_ISSUE_AFTER_TWO = '之后每次引用效率数字，都必须同时说明时间范围、统计口径与对应证据。';
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAAFklEQVR4nGPQ9wz/TwlmGDVg1AAgBgBNoQPwF6IA3wAAAABJRU5ErkJggg==';
let graphIssueCalls = 0;
let imageCalls = 0;

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
      claim: prompt.includes(AUTHOR_RESEARCH_REVISION_QUESTION)
        ? AUTHOR_RESEARCH_REVISION_RESPONSE
        : '公开听证纪要支持“调度系统仅进入附条件试运行”这一主张。',
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
      summary: prompt.includes(AUTHOR_CHANGES_REVISION_GOAL)
        ? AUTHOR_CHANGES_REVISION_RESPONSE
        : '主文件的两个独立审阅修改块',
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
  if (!prompt.includes(`用户指令：${CHAPTER_GOAL}`) &&
      !prompt.includes(`用户指令：${AUTHOR_CHAPTER_REVISION_GOAL}`) ||
      !prompt.includes(`<project-file role="project_prompt" path="edit.md"`) ||
      !prompt.includes(`<project-file role="target" path="${CHAT_CURRENT_PATH}"`)) {
    throw new Error('E2E_FIXTURE_INVALID_CHAPTER_PLAN');
  }
  return {
    schema: 'writcraft.chapter-generation-plan/v1',
    summary: prompt.includes(`用户指令：${AUTHOR_CHAPTER_REVISION_GOAL}`)
      ? AUTHOR_CHAPTER_REVISION_RESPONSE
      : 'E2E 分阶段整体重写章节',
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

function assertResearchToolRequest(request) {
  const tool = request.tools?.[0];
  const cardSchema = tool?.input_schema?.properties?.cards;
  if (request.max_tokens !== 4096 || request.tools?.length !== 1 ||
      tool?.name !== 'submit_research_cards' ||
      request.tool_choice?.type !== 'tool' || request.tool_choice?.name !== 'submit_research_cards' ||
      tool?.input_schema?.type !== 'object' || tool?.input_schema?.additionalProperties !== false ||
      cardSchema?.type !== 'array' || cardSchema?.minItems !== 1 || cardSchema?.maxItems !== 20) {
    throw new Error('E2E_FIXTURE_INVALID_RESEARCH_TOOL_PROTOCOL');
  }
}

function assertWritingNavigationToolRequest(request) {
  const tool = request.tools?.[0];
  const suggestionSchema = tool?.input_schema?.properties?.suggestions;
  const evidenceSchema = suggestionSchema?.items?.properties?.evidenceRefs;
  if (request.max_tokens !== 8_192 || request.tools?.length !== 1 ||
      tool?.name !== 'submit_writing_navigation' ||
      request.tool_choice?.type !== 'tool' || request.tool_choice?.name !== 'submit_writing_navigation' ||
      tool?.input_schema?.type !== 'object' || tool?.input_schema?.additionalProperties !== false ||
      suggestionSchema?.minItems !== 1 || suggestionSchema?.maxItems !== 3 ||
      !Array.isArray(evidenceSchema?.items?.enum) || !evidenceSchema.items.enum.length) {
    throw new Error('E2E_FIXTURE_INVALID_WRITING_NAVIGATION_TOOL_PROTOCOL');
  }
}

function writingNavigationAnswer(prompt, request) {
  if (!prompt.includes(`用户目标：${UNIFIED_NAVIGATION_GOAL}`) ||
      !prompt.includes('WRITCRAFT_EVIDENCE_REF') || !prompt.includes(UNIFIED_BEFORE)) {
    throw new Error('E2E_FIXTURE_INVALID_WRITING_NAVIGATION_PROMPT');
  }
  const candidates = request.tools[0].input_schema.properties.suggestions
    .items.properties.evidenceRefs.items.enum;
  const marker = [...prompt.matchAll(/<!-- WRITCRAFT_EVIDENCE_REF:(er_[a-f0-9]{16}_[1-9][0-9]{0,3}) -->\n([^\n]*)/g)]
    .find(match => match[2].includes(UNIFIED_BEFORE));
  if (!marker || !candidates.includes(marker[1])) {
    throw new Error('E2E_FIXTURE_MISSING_WRITING_NAVIGATION_EVIDENCE');
  }
  return {
    mode: 'navigation',
    suggestions: [{
      finding: '当前章节保留了一处待验证的冗余表达。',
      evidenceRefs: [marker[1]],
      whyNow: '这是验证统一写作任务流最小安全闭环的明确位置。',
      editIntent: 'compress',
      expectedResult: '作者可在正文中审阅一处有界修改。',
      action: 'changes',
    }],
  };
}

function assertUnifiedWritingTaskRequest(request) {
  const tool = request.tools?.[0];
  const changes = tool?.input_schema?.oneOf?.find(branch =>
    branch?.properties?.status?.const === 'changes');
  const needsSources = tool?.input_schema?.oneOf?.find(branch =>
    branch?.properties?.status?.const === 'needs_sources');
  const edits = changes?.properties?.edits;
  if (request.max_tokens !== 8_192 || request.tools?.length !== 1 ||
      tool?.name !== 'submit_unified_writing_task' ||
      request.tool_choice?.type !== 'tool' || request.tool_choice?.name !== 'submit_unified_writing_task' ||
      tool?.input_schema?.oneOf?.length !== 2 || changes?.additionalProperties !== false ||
      edits?.minItems !== 1 || edits?.maxItems !== 3 ||
      needsSources?.properties?.edits?.maxItems !== 0 ||
      !Array.isArray(edits?.items?.properties?.rangeId?.enum) ||
      edits.items.required.includes('oldText')) {
    throw new Error('E2E_FIXTURE_INVALID_UNIFIED_WRITING_TASK_PROTOCOL');
  }
}

function unifiedWritingTaskAnswer(prompt, request) {
  if (!prompt.includes('必须且只能调用 submit_unified_writing_task 一次') ||
      !prompt.includes(`建议动作：压缩这一处表达`) || !prompt.includes(UNIFIED_BEFORE)) {
    throw new Error('E2E_FIXTURE_INVALID_UNIFIED_WRITING_TASK_PROMPT');
  }
  const rangeIds = request.tools[0].input_schema.oneOf
    .find(branch => branch.properties.status.const === 'changes')
    .properties.edits.items.properties.rangeId.enum;
  const target = { rangeId: rangeIds[0] };
  if (rangeIds.length !== 1 ||
      !prompt.includes(`rangeId=${JSON.stringify(target.rangeId)}`) ||
      !prompt.includes(`content=${JSON.stringify(UNIFIED_BEFORE)}`) ||
      !prompt.includes('beforeContext=') || !prompt.includes('afterContext=')) {
    throw new Error('E2E_FIXTURE_MISSING_UNIFIED_WRITING_TASK_RANGE');
  }
  return {
    status: 'changes',
    edits: [{
      rangeId: target.rangeId,
      newText: UNIFIED_AFTER,
      summary: '验证正文内统一任务 Diff',
    }],
    reason: '',
    question: '',
  };
}

function authorChatAnswer(prompt) {
  const required = [
    '[上下文 · project prompt · edit.md]',
    '[上下文 · file · chapters/author-e2e.md]',
  ];
  console.log(`[e2e-fixture] AUTHOR_CHAT_PROVIDER_CALL required=${required.map(value => prompt.includes(value) ? '1' : '0').join('')} forbidden=${prompt.includes('[权威项目 Prompt · edit.md]') ? '1' : '0'}`);
  if (required.some(value => !prompt.includes(value)) ||
      prompt.includes('[权威项目 Prompt · edit.md]')) {
    throw new Error('E2E_FIXTURE_INVALID_AUTHOR_CHAT_CONTEXT');
  }
  return AUTHOR_CHAT_RESPONSE;
}

function authorNavigationAnswer(prompt, request) {
  if (!prompt.includes(`用户目标：${AUTHOR_NAVIGATION_GOAL}`) &&
      !prompt.includes(`用户目标：${AUTHOR_NAVIGATION_REVISION_GOAL}`) &&
      !prompt.includes(`用户目标：${AUTHOR_SOURCE_NEEDED_GOAL}`) ||
      !prompt.includes('WRITCRAFT_EVIDENCE_REF') || !prompt.includes(AUTHOR_BEFORE)) {
    throw new Error('E2E_FIXTURE_INVALID_AUTHOR_NAVIGATION_PROMPT');
  }
  assertWritingNavigationToolRequest(request);
  const candidates = request.tools[0].input_schema.properties.suggestions
    .items.properties.evidenceRefs.items.enum;
  const marker = [...prompt.matchAll(/<!-- WRITCRAFT_EVIDENCE_REF:(er_[a-f0-9]{16}_[1-9][0-9]{0,3}) -->\n([^\n]*)/g)]
    .find(match => match[2].includes(AUTHOR_BEFORE));
  if (!marker || !candidates.includes(marker[1])) {
    throw new Error('E2E_FIXTURE_MISSING_AUTHOR_NAVIGATION_EVIDENCE');
  }
  const sourceNeeded = prompt.includes(`用户目标：${AUTHOR_SOURCE_NEEDED_GOAL}`);
  return {
    mode: 'navigation',
    suggestions: [{
      finding: prompt.includes(`用户目标：${AUTHOR_NAVIGATION_REVISION_GOAL}`)
        ? AUTHOR_NAVIGATION_REVISION_RESPONSE
        : sourceNeeded ? AUTHOR_SOURCE_NEEDED_FINDING : '当前章节存在一处可以局部精简的重复表达。',
      evidenceRefs: [marker[1]],
      whyNow: '作者验收只处理一个明确、可撤销的局部任务。',
      editIntent: 'compress',
      expectedResult: '正文中出现一处可审阅的局部 Diff。',
      action: 'changes',
    }],
  };
}

function authorUnifiedWritingTaskAnswer(prompt, request) {
  if (!prompt.includes('必须且只能调用 submit_unified_writing_task 一次') ||
      !prompt.includes(AUTHOR_BEFORE)) {
    throw new Error('E2E_FIXTURE_INVALID_AUTHOR_UNIFIED_TASK_PROMPT');
  }
  assertUnifiedWritingTaskRequest(request);
  const rangeIds = request.tools[0].input_schema.oneOf
    .find(branch => branch.properties.status.const === 'changes')
    .properties.edits.items.properties.rangeId.enum;
  if (rangeIds.length !== 1 || !prompt.includes(`content=${JSON.stringify(AUTHOR_BEFORE)}`)) {
    throw new Error('E2E_FIXTURE_MISSING_AUTHOR_UNIFIED_RANGE');
  }
  return {
    status: 'changes',
    edits: [{
      rangeId: rangeIds[0],
      newText: AUTHOR_AFTER,
      summary: '真实作者隔离副本的局部精简 Diff',
    }],
    reason: '',
    question: '',
  };
}

function authorNeedsSourcesAnswer(prompt, request) {
  if (!prompt.includes('必须且只能调用 submit_unified_writing_task 一次') ||
      !prompt.includes(AUTHOR_SOURCE_NEEDED_FINDING)) {
    throw new Error('E2E_FIXTURE_INVALID_AUTHOR_NEEDS_SOURCES_PROMPT');
  }
  assertUnifiedWritingTaskRequest(request);
  authorNeedsSourcesIssued = true;
  return {
    status: 'needs_sources',
    edits: [],
    reason: '这项判断需要作者补充可核验来源。',
    question: '请添加支持该判断的来源后再继续。',
  };
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
      let researchToolInput = null;
      let writingNavigationToolInput = null;
      let unifiedWritingTaskToolInput = null;
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
      } else if (prompt.includes('WritCraft 的 Graph Issue→Changes 修订执行器')) {
        graphIssueCalls += 1;
        if (graphIssueCalls === 1) await new Promise(resolve => setTimeout(resolve, 18_000));
        output = JSON.stringify(graphIssueChangesAnswer(prompt));
        console.log('[e2e-fixture] GRAPH_ISSUE_PROVIDER_COMPLETE');
      } else if (prompt.includes('WritCraft 的 Research→Changes 局部修订执行器')) {
        output = JSON.stringify(researchChangesAnswer(prompt));
      } else if (prompt.includes(`用户指令：${AUTHOR_CHANGES_REVISION_GOAL}`)) {
        console.log('[e2e-fixture] AUTHOR_CHANGES_REVISION_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 2_200));
        output = JSON.stringify(changesReviewAnswer(prompt));
        console.log('[e2e-fixture] AUTHOR_CHANGES_REVISION_PROVIDER_COMPLETE');
      } else if (prompt.includes(`用户指令：${CHANGES_REVIEW_GOAL}`)) {
        output = JSON.stringify(changesReviewAnswer(prompt));
      } else if (prompt.includes('WritCraft 的完整章节生成规划器') && prompt.includes(`用户指令：${AUTHOR_CHAPTER_REVISION_GOAL}`)) {
        console.log('[e2e-fixture] AUTHOR_CHAPTER_REVISION_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 2_200));
        output = JSON.stringify(chapterPlanAnswer(prompt));
        console.log('[e2e-fixture] AUTHOR_CHAPTER_REVISION_PROVIDER_COMPLETE');
      } else if (prompt.includes('WritCraft 的完整章节生成规划器') && prompt.includes(`用户指令：${CHAPTER_CANCEL_GOAL}`)) {
        console.log('[e2e-fixture] AUTHOR_CHAPTER_CANCEL_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 18_000));
        output = CHAPTER_CANCEL_RESPONSE;
        console.log('[e2e-fixture] AUTHOR_CHAPTER_CANCEL_PROVIDER_COMPLETE');
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
      } else if (prompt.includes(AUTHOR_CANCEL_QUESTION)) {
        // Deliberately outlive the 15 s cancellation affordance. Main must
        // settle the task and discard this late answer without writing or
        // publishing it to the Renderer.
        console.log('[e2e-fixture] AUTHOR_CANCEL_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 18_000));
        output = AUTHOR_CANCEL_RESPONSE;
        console.log('[e2e-fixture] AUTHOR_CANCEL_PROVIDER_COMPLETE');
      } else if (prompt.includes(AUTHOR_SWITCH_QUESTION)) {
        // Project A is switched to B by the real E2E harness while this
        // promise is alive. Main must invalidate the owner and discard this
        // response without publishing it to B.
        console.log('[e2e-fixture] AUTHOR_SWITCH_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 18_000));
        console.log('[e2e-fixture] AUTHOR_SWITCH_PROVIDER_COMPLETE');
        output = AUTHOR_SWITCH_RESPONSE;
      } else if (prompt.includes(AUTHOR_TIMEOUT_QUESTION)) {
        // Deliberately outlive the 60 s Main deadline. The late provider
        // result must never reach the Renderer or mutate the author copy.
        console.log('[e2e-fixture] AUTHOR_TIMEOUT_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 61_000));
        output = AUTHOR_TIMEOUT_RESPONSE;
        console.log('[e2e-fixture] AUTHOR_TIMEOUT_PROVIDER_COMPLETE');
      } else if (prompt.includes(AUTHOR_EDIT_REVISION_QUESTION)) {
        console.log('[e2e-fixture] AUTHOR_EDIT_REVISION_PROVIDER_CALL');
        await new Promise(resolve => setTimeout(resolve, 18_000));
        output = AUTHOR_EDIT_REVISION_RESPONSE;
        console.log('[e2e-fixture] AUTHOR_EDIT_REVISION_PROVIDER_COMPLETE');
      } else if (prompt.includes(AUTHOR_CHAT_QUESTION)) {
        output = authorChatAnswer(prompt);
      } else if (prompt.includes(`问题：${PROJECT_CHAT_QUERY}`)) {
        output = projectChatAnswer(prompt);
      } else if (prompt.includes(`问题：${SELECTION_CHAT_QUESTION}`)) {
        output = selectionChatAnswer(prompt);
      } else if (prompt.includes('WritCraft 的本地证据 Research 助手')) {
        assertResearchToolRequest(request);
        if (prompt.includes(AUTHOR_RESEARCH_REVISION_QUESTION)) {
          console.log('[e2e-fixture] AUTHOR_RESEARCH_REVISION_PROVIDER_CALL');
          await new Promise(resolve => setTimeout(resolve, 2_200));
          researchToolInput = researchCard(prompt);
          console.log('[e2e-fixture] AUTHOR_RESEARCH_REVISION_PROVIDER_COMPLETE');
        } else if (prompt.includes(AUTHOR_RESEARCH_CANCEL_QUESTION)) {
          console.log('[e2e-fixture] AUTHOR_RESEARCH_CANCEL_PROVIDER_CALL');
          await new Promise(resolve => setTimeout(resolve, 18_000));
          output = AUTHOR_RESEARCH_CANCEL_RESPONSE;
          console.log('[e2e-fixture] AUTHOR_RESEARCH_CANCEL_PROVIDER_COMPLETE');
        } else {
          researchToolInput = researchCard(prompt);
        }
      } else if (prompt.includes('你是 WritCraft 的写作导航助手。')) {
        assertWritingNavigationToolRequest(request);
        if (prompt.includes(`用户目标：${AUTHOR_NAVIGATION_CANCEL_GOAL}`)) {
          console.log('[e2e-fixture] AUTHOR_NAVIGATION_CANCEL_PROVIDER_CALL');
          await new Promise(resolve => setTimeout(resolve, 18_000));
          output = AUTHOR_NAVIGATION_CANCEL_RESPONSE;
          console.log('[e2e-fixture] AUTHOR_NAVIGATION_CANCEL_PROVIDER_COMPLETE');
        } else if (prompt.includes(`用户目标：${AUTHOR_NAVIGATION_REVISION_GOAL}`)) {
          console.log('[e2e-fixture] AUTHOR_NAVIGATION_REVISION_PROVIDER_CALL');
          await new Promise(resolve => setTimeout(resolve, 2_200));
          writingNavigationToolInput = authorNavigationAnswer(prompt, request);
          console.log('[e2e-fixture] AUTHOR_NAVIGATION_REVISION_PROVIDER_COMPLETE');
        } else {
          writingNavigationToolInput = prompt.includes(`用户目标：${AUTHOR_NAVIGATION_GOAL}`) ||
            prompt.includes(`用户目标：${AUTHOR_SOURCE_NEEDED_GOAL}`)
            ? authorNavigationAnswer(prompt, request)
            : writingNavigationAnswer(prompt, request);
        }
      } else if (prompt.includes('必须且只能调用 submit_unified_writing_task 一次')) {
        assertUnifiedWritingTaskRequest(request);
        unifiedWritingTaskToolInput = prompt.includes(AUTHOR_SOURCE_NEEDED_FINDING) && !authorNeedsSourcesIssued
          ? authorNeedsSourcesAnswer(prompt, request)
          : prompt.includes(AUTHOR_BEFORE)
            ? authorUnifiedWritingTaskAnswer(prompt, request)
            : unifiedWritingTaskAnswer(prompt, request);
      } else {
        throw new Error('E2E_FIXTURE_UNHANDLED_TEXT');
      }
      if (researchToolInput) {
        return jsonResponse({
          model: 'MiniMax-M3',
          content: [{
            type: 'tool_use',
            id: 'call_research_1',
            name: 'submit_research_cards',
            input: researchToolInput,
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 128, output_tokens: 64 },
        });
      }
      if (writingNavigationToolInput) {
        return jsonResponse({
          model: 'MiniMax-M3',
          content: [{
            type: 'tool_use',
            id: 'call_writing_navigation_1',
            name: 'submit_writing_navigation',
            input: writingNavigationToolInput,
          }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 128, output_tokens: 64 },
        });
      }
      if (unifiedWritingTaskToolInput) {
        return jsonResponse({
          model: 'MiniMax-M3',
          content: [{
            type: 'tool_use',
            id: 'call_unified_writing_task_1',
            name: 'submit_unified_writing_task',
            input: unifiedWritingTaskToolInput,
          }],
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
      imageCalls += 1;
      if (imageCalls === 1) await new Promise(resolve => setTimeout(resolve, 18_000));
      // Keep normal requests in flight beyond native debounce and a full 1200 ms
      // polling round so E2E covers both own-save echo paths.
      if (imageCalls !== 1) await new Promise(resolve => setTimeout(resolve, 1700));
      console.log('[e2e-fixture] IMAGE_PROVIDER_COMPLETE');
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
  UNIFIED_NAVIGATION_GOAL,
  UNIFIED_BEFORE,
  UNIFIED_AFTER,
  AUTHOR_CHAT_QUESTION,
  AUTHOR_CHAT_RESPONSE,
  AUTHOR_CANCEL_QUESTION,
  AUTHOR_CANCEL_RESPONSE,
  AUTHOR_SWITCH_QUESTION,
  AUTHOR_SWITCH_RESPONSE,
  AUTHOR_TIMEOUT_QUESTION,
  AUTHOR_TIMEOUT_RESPONSE,
  AUTHOR_EDIT_REVISION_QUESTION,
  AUTHOR_EDIT_REVISION_RESPONSE,
  AUTHOR_NAVIGATION_CANCEL_GOAL,
  AUTHOR_NAVIGATION_CANCEL_RESPONSE,
  AUTHOR_NAVIGATION_REVISION_GOAL,
  AUTHOR_NAVIGATION_REVISION_RESPONSE,
  AUTHOR_RESEARCH_REVISION_QUESTION,
  AUTHOR_RESEARCH_REVISION_RESPONSE,
  AUTHOR_RESEARCH_CANCEL_QUESTION,
  AUTHOR_RESEARCH_CANCEL_RESPONSE,
  AUTHOR_NAVIGATION_GOAL,
  AUTHOR_SOURCE_NEEDED_GOAL,
  AUTHOR_SOURCE_NEEDED_FINDING,
  AUTHOR_BEFORE,
  AUTHOR_AFTER,
  CHANGES_REVIEW_GOAL,
  AUTHOR_CHANGES_REVISION_GOAL,
  AUTHOR_CHANGES_REVISION_RESPONSE,
  CHANGES_SECOND_PATH,
  CHANGES_BEFORE,
  CHANGES_AFTER,
  CHAPTER_GOAL,
  AUTHOR_CHAPTER_REVISION_GOAL,
  AUTHOR_CHAPTER_REVISION_RESPONSE,
  CHAPTER_CANCEL_GOAL,
  CHAPTER_CANCEL_RESPONSE,
  CHAPTER_GENERATED_MARKER,
  GRAPH_ISSUE_BEFORE_ONE,
  GRAPH_ISSUE_AFTER_ONE,
  GRAPH_ISSUE_BEFORE_TWO,
  GRAPH_ISSUE_AFTER_TWO,
  PNG_BASE64,
  createElectronAiProvider,
};
