'use strict';

const crypto = require('crypto');
const blockAnchor = require('../renderer/block-anchor');

const SCHEMA = 'writcraft.graph/v2';
const NODE_TYPES = Object.freeze([
  'person', 'organization', 'place', 'event', 'time', 'concept', 'principle', 'claim',
  'variable', 'case', 'datum', 'source', 'foreshadow', 'open_question',
  // v2 keeps these presentation/diagnostic nodes so existing graph views do
  // not lose headings or explicit project-scope signals.
  'section', 'entity', 'value', 'diagnostic_anchor', 'declared_topic',
]);
const EDGE_TYPES = Object.freeze([
  'supports', 'contradicts', 'causes', 'influences', 'depends_on', 'before', 'after',
  'example_of', 'cites', 'explains', 'foreshadows', 'resolves', 'belongs_to',
  'participates_in', 'mentions', 'has_attribute', 'occurs_at', 'starts_at', 'ends_at',
  'birth', 'death', 'location', 'is',
]);
const ISSUE_TYPES = Object.freeze([
  'attribute_conflict', 'timeline_conflict', 'variable_drift', 'claim_conflict',
  'evidence_gap', 'unresolved_foreshadow', 'orphan_entity', 'prompt_drift',
]);
// These diagnostics assert that two author-visible facts cannot both be true.
// Publishing one from a single citation would turn an inference into a false
// conflict. The gate is deliberately shared by direct and incremental graph
// analysis so every UI route receives the same evidence contract.
const TWO_EVIDENCE_ISSUE_TYPES = new Set([
  'attribute_conflict', 'timeline_conflict', 'variable_drift', 'claim_conflict', 'prompt_drift',
]);
const DEFAULT_LIMITS = Object.freeze({
  maxFiles: 500,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 12 * 1024 * 1024,
  maxFacts: 5000,
  maxEvidenceQuote: 240
});
// A relation can occur in many files, but renderer metadata must remain
// bounded. Paths are sorted lexically for determinism; they are not a story
// timeline.
const MAX_EVOLUTION_PATHS = 32;

function hash(kind, value) {
  return `${kind}_${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function sha256(value) {
  return `sha256:${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')}`;
}

function normalized(value) {
  return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
}

function cleanToken(value) {
  return normalized(value)
    .replace(/^[\s#>*_`~\-—:：,，;；。.!！?？]+|[\s#>*_`~\-—:：,，;；。.!！?？]+$/g, '')
    .replace(/^(?:“|”|「|」|『|』|"|'|‘|’)+|(?:“|”|「|」|『|』|"|'|‘|’)+$/g, '')
    .trim();
}

function utf8Bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function stableSort(items) {
  return items.sort((a, b) => a.id.localeCompare(b.id));
}

const NODE_TYPE_PRIORITY = Object.freeze({
  entity: 0, value: 0, concept: 1, datum: 2, event: 4, place: 4,
  organization: 5, time: 5, variable: 6, person: 7,
});

function strongerNodeType(current, candidate) {
  return (NODE_TYPE_PRIORITY[candidate] || 0) > (NODE_TYPE_PRIORITY[current] || 0) ? candidate : current;
}

function capturedTimestamp(value) {
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function analyzeProject(inputFiles, options = {}) {
  if (!Array.isArray(inputFiles)) throw new TypeError('files must be an array');
  const directLimits = Object.fromEntries(Object.keys(DEFAULT_LIMITS)
    .filter(key => Object.prototype.hasOwnProperty.call(options, key)).map(key => [key, options[key]]));
  const limits = { ...DEFAULT_LIMITS, ...directLimits, ...(options.limits || {}) };
  const capturedAt = capturedTimestamp(options.capturedAt);
  const warnings = [];
  const files = inputFiles.map((file, index) => normalizeFile(file, index)).sort((a, b) => a.path.localeCompare(b.path));
  const accepted = [];
  let totalBytes = 0;

  for (const file of files) {
    if (accepted.length >= limits.maxFiles) {
      warnings.push({ code: 'MAX_FILES', path: file.path });
      continue;
    }
    const bytes = utf8Bytes(file.content);
    if (bytes > limits.maxFileBytes) {
      warnings.push({ code: 'FILE_TOO_LARGE', path: file.path, bytes });
      continue;
    }
    if (totalBytes + bytes > limits.maxTotalBytes) {
      warnings.push({ code: 'TOTAL_SIZE_LIMIT', path: file.path, bytes });
      continue;
    }
    accepted.push({ ...file, bytes });
    totalBytes += bytes;
  }

  const nodeMap = new Map();
  const evidenceMap = new Map();
  const facts = [];
  const blocksByPath = new Map();
  let factLimitReached = false;

  function addEvidence(file, start, end, quote, confidence, _signature) {
    const quoteLimit = Math.max(0, Math.min(limits.maxEvidenceQuote, end - start));
    let boundedQuote = String(quote).slice(0, quoteLimit);
    // Keep the hard limit in UTF-16 code units because start/end are renderer
    // string offsets, but never manufacture an unpaired surrogate at the
    // truncation boundary. Every locator and ID below uses this final quote.
    if (/[\uD800-\uDBFF]$/.test(boundedQuote)) boundedQuote = boundedQuote.slice(0, -1);
    const boundedEnd = start + boundedQuote.length;
    let blocks = blocksByPath.get(file.path);
    if (!blocks) {
      blocks = blockAnchor.parseBlocks(file.content, file.path);
      blocksByPath.set(file.path, blocks);
    }
    const block = blocks.find(item => start >= item.start && start <= item.end && boundedEnd <= item.end);
    if (!block) throw new TypeError(`evidence is outside a Markdown block: ${file.path}`);
    // Reuse the shared Markdown block model but count only indistinguishable
    // blocks. Inserting an unrelated paragraph before this one must not change
    // its identity.
    const duplicateOrdinal = blocks.filter(item => item.start <= block.start &&
      item.headingKey === block.headingKey && item.type === block.type && item.fingerprint === block.fingerprint).length;
    const blockId = hash('blk', `${file.path}\0${block.headingKey}\0${block.type}\0${block.fingerprint}\0${duplicateOrdinal}`);
    const evidence = {
      // Evidence identifies a source span, not the individual fact inferred
      // from it. Multiple edges extracted from one sentence therefore share
      // one citation and one stable block anchor.
      id: hash('ev', `${file.path}\0${start}\0${boundedEnd}\0${file.revision}`),
      filePath: file.path,
      path: file.path,
      blockId,
      start,
      end: boundedEnd,
      quote: boundedQuote,
      contentHash: sha256(block.text),
      capturedAt,
      revision: file.revision,
      confidence
    };
    const existing = evidenceMap.get(evidence.id);
    // A shared citation keeps the most conservative extraction confidence;
    // another detector seeing the same span must not inflate its certainty.
    if (existing) existing.confidence = Math.min(existing.confidence, evidence.confidence);
    else evidenceMap.set(evidence.id, evidence);
    return evidence.id;
  }

  function addNode(type, key, label, evidenceId, extra = {}) {
    const date = type === 'time' ? canonicalDate(key) : null;
    const canonical = date
      ? `date:${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`
      : normalized(key).toLocaleLowerCase('zh-CN');
    const id = hash('node', canonical);
    const existing = nodeMap.get(id);
    if (existing) {
      if (evidenceId && !existing.evidenceIds.includes(evidenceId)) existing.evidenceIds.push(evidenceId);
      existing.type = strongerNodeType(existing.type, type);
      existing.confidence = Math.max(existing.confidence, Number(extra.confidence) || 0);
      existing.updatedAt = capturedAt;
      const surface = normalized(label);
      existing.aliases = [...new Set([
        ...existing.aliases,
        ...(extra.aliases || []),
        ...(surface && surface !== existing.label ? [surface] : []),
      ])].sort();
      existing.attributes = { ...existing.attributes, ...(extra.attributes || {}) };
      if (extra.explicitDeclaration === true) existing.explicitDeclaration = true;
      existing.declarationEvidenceIds = [...new Set([
        ...(existing.declarationEvidenceIds || []),
        ...(extra.declarationEvidenceIds || []),
      ])].sort();
      existing.declarationTypes = [...new Set([
        ...(existing.declarationTypes || []),
        ...(extra.declarationTypes || []),
      ])].sort();
      Object.assign(existing, Object.fromEntries(Object.entries(extra)
        .filter(([key]) => ![
          'aliases', 'attributes', 'confidence', 'explicitDeclaration',
          'declarationEvidenceIds', 'declarationTypes',
        ].includes(key))));
      return id;
    }
    nodeMap.set(id, {
      id,
      type: NODE_TYPES.includes(type) ? type : 'entity',
      label: normalized(label),
      aliases: [...new Set(extra.aliases || [])].sort(),
      summary: typeof extra.summary === 'string' ? extra.summary : '',
      attributes: extra.attributes && typeof extra.attributes === 'object' ? { ...extra.attributes } : {},
      confidence: Number.isFinite(extra.confidence) ? extra.confidence : 0.9,
      status: extra.status || 'proposed',
      evidenceIds: evidenceId ? [evidenceId] : [],
      explicitDeclaration: extra.explicitDeclaration === true,
      declarationEvidenceIds: [...new Set(extra.declarationEvidenceIds || [])].sort(),
      declarationTypes: [...new Set(extra.declarationTypes || [])].sort(),
      updatedAt: capturedAt,
      key: canonical,
      ...Object.fromEntries(Object.entries(extra).filter(([key]) => ![
        'aliases', 'summary', 'attributes', 'confidence', 'status',
        'explicitDeclaration', 'declarationEvidenceIds', 'declarationTypes',
      ].includes(key))),
    });
    return id;
  }

  function addFact(file, statement, relation, subject, object, confidence, property = null) {
    if (facts.length >= limits.maxFacts) {
      factLimitReached = true;
      return;
    }
    subject = cleanToken(subject);
    object = cleanToken(object);
    property = property ? cleanToken(property) : null;
    if (!validFactTerms(relation, subject, object, property) || subject === object && !['before', 'after'].includes(relation)) return;
    const subjectType = detectSubjectType(relation, subject, property);
    const objectType = detectObjectType(relation, object, property);
    const signature = `${subject}\0${relation}\0${property || ''}\0${object}`;
    const evidenceId = addEvidence(file, statement.start, statement.end, statement.quote, confidence, signature);
    const from = addNode(subjectType, subject, subject, evidenceId, { confidence });
    const to = addNode(objectType, object, object, evidenceId, { confidence });
    const edgeRelation = property ? `value:${cleanToken(property)}` : relation;
    const id = hash('edge', `${from}\0${edgeRelation}\0${to}\0${file.path}\0${statement.start}`);
    facts.push({
      id,
      type: property ? 'has_attribute' : EDGE_TYPES.includes(relation) ? relation : 'mentions',
      from,
      to,
      directed: true,
      label: property ? `属性：${property}` : humanRelation(relation),
      relation: edgeRelation,
      property,
      evidenceIds: [evidenceId],
      confidence,
      status: 'proposed',
      source: file.path.toLocaleLowerCase('en-US') === 'edit.md' ? 'project_prompt' : 'manuscript',
      ...(['supports', 'contradicts'].includes(relation) ? { assertionMode: 'explicit_statement' } : {}),
    });
  }

  function addDiagnosticSignal(file, signal) {
    if (facts.length >= limits.maxFacts) {
      factLimitReached = true;
      return;
    }
    const evidenceId = addEvidence(
      file,
      signal.start,
      signal.end,
      signal.quote,
      signal.confidence,
      `${signal.relation}\0${signal.anchorKey}\0${signal.targetKey}`
    );
    const from = addNode('diagnostic_anchor', signal.anchorKey, signal.anchorLabel, evidenceId, { path: file.path, confidence: signal.confidence });
    const to = addNode(signal.targetType, signal.targetKey, signal.targetLabel, evidenceId, { confidence: signal.confidence });
    facts.push({
      id: hash('edge', `${from}\0${signal.relation}\0${to}\0${file.path}`),
      type: EDGE_TYPES.includes(signal.relation) ? signal.relation : 'mentions',
      from,
      to,
      directed: true,
      label: signal.label || (signal.relation === 'diagnostic:evidence_gap' ? '待补来源' : '项目范围约束'),
      relation: signal.relation,
      evidenceIds: [evidenceId],
      confidence: signal.confidence,
      status: 'proposed',
      source: signal.source,
      ...(['foreshadows', 'resolves'].includes(signal.relation) ? { assertionMode: 'explicit_marker' } : {}),
    });
  }

  function addDeclaredTopic(file, topic) {
    const canonicalTopic = normalized(topic.topic).toLocaleLowerCase('zh-CN');
    const evidenceId = addEvidence(
      file, topic.start, topic.end, topic.quote, topic.confidence,
      `declared-topic\0${file.path}\0${canonicalTopic}`
    );
    addNode(
      'declared_topic',
      `${file.path}\0${canonicalTopic}`,
      topic.topic,
      evidenceId,
      { path: file.path, topicKey: `excluded-topic:${canonicalTopic}`, confidence: topic.confidence }
    );
  }

  for (const file of accepted) {
    extractHeadings(file, addEvidence, addNode);
    extractExplicitEntitiesAndTimes(file, addEvidence, addNode);
    extractExplicitDeclarations(file, addEvidence, addNode);
    extractDiagnosticSignals(file, addDiagnosticSignal, addDeclaredTopic);
    extractVariableDefinitions(file, addFact);
    for (const statement of statements(file.content)) {
      for (const fact of parseStatement(statement.quote)) {
        addFact(file, evidenceStatementForFact(statement, fact), fact.relation, fact.subject, fact.object, fact.confidence, fact.property);
      }
      if (factLimitReached) break;
    }
    if (factLimitReached) break;
  }

  const edges = mergeExactFacts(facts, evidenceMap);
  applyDerivedNodeAttributes(nodeMap, edges);
  const issues = detectIssues(edges, nodeMap, evidenceMap);
  for (const node of nodeMap.values()) {
    node.evidenceIds.sort();
    node.declarationEvidenceIds = [...new Set(node.declarationEvidenceIds || [])].sort();
    node.declarationTypes = [...new Set(node.declarationTypes || [])].sort();
  }
  if (factLimitReached) warnings.push({ code: 'MAX_FACTS', limit: limits.maxFacts });
  warnings.sort((a, b) => `${a.code}\0${a.path || ''}`.localeCompare(`${b.code}\0${b.path || ''}`));

  return {
    schema: SCHEMA,
    nodes: stableSort([...nodeMap.values()]),
    edges: stableSort(edges),
    evidence: stableSort([...evidenceMap.values()]),
    issues: stableSort(issues),
    manifest: {
      generatedBy: 'writcraft-consistency-engine',
      schema: SCHEMA,
      inputFiles: accepted.map(file => ({ path: file.path, revision: file.revision, bytes: file.bytes })),
      stats: { files: accepted.length, nodes: nodeMap.size, edges: edges.length, evidence: evidenceMap.size, issues: issues.length },
      limits: { ...limits },
      truncated: warnings.length > 0,
      warnings
    }
  };
}

function normalizeFile(file, index) {
  if (!file || typeof file !== 'object') throw new TypeError(`files[${index}] must be an object`);
  const path = normalized(file.path).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:\//.test(path) || path.split('/').includes('..')) {
    throw new TypeError(`files[${index}].path must be project-relative`);
  }
  if (typeof file.content !== 'string') throw new TypeError(`files[${index}].content must be a string`);
  return { path, content: file.content, revision: normalized(file.revision) || 'unknown' };
}

function validToken(token) {
  if (!token || token.length > 120) return false;
  if (token.length === 1 && !/^[甲乙丙丁戊己庚辛壬癸A-Za-z0-9]$/.test(token)) return false;
  if (/^(?:这|那|其|它|他|她|我们|他们|内容|文章|项目|本章|这里)$/.test(token)) return false;
  return /[\p{L}\p{N}]/u.test(token);
}

function validObject(value) {
  return validToken(value) && !/^(?:一个|一种|某个|这里|那里|未知|待定|暂无)$/.test(value);
}

const ATTRIBUTE_PROPERTIES = new Set([
  '年龄', '身份', '职业', '位置', '状态', '出生时间', '死亡时间', '所属', '负责人',
  '定义', '单位', '统计口径', '口径', '计算方式', '测量范围', '时间范围', '范围',
  '上限', '下限', '目标', '比例', '数值',
]);
const VARIABLE_PROPERTIES = new Set(['定义', '单位', '统计口径', '口径', '计算方式', '测量范围', '时间范围', '范围', '上限', '下限', '比例', '数值']);
const PERSON_PROPERTIES = new Set(['年龄', '身份', '职业', '出生时间', '死亡时间']);

function simpleTerm(value, max = 40) {
  const text = cleanToken(value);
  return validToken(text) && text.length <= max && !/[\n\r，,;；！!？？“”「」『』<>]/.test(text);
}

function validFactTerms(relation, subject, object, property) {
  const eventSubject = ['occurs_at', 'starts_at', 'ends_at'].includes(relation)
    && subject.length >= 2 && subject.length <= 30
    && /[\p{L}\p{N}]/u.test(subject)
    && !/[\n\r，,;；！!?？]/.test(subject);
  if ((!simpleTerm(subject, 30) && !eventSubject) || !validObject(object)) return false;
  if (property) {
    if (!ATTRIBUTE_PROPERTIES.has(property) || object.length > 120 || /[\n\r<>]/.test(object)) return false;
    // Attribute extraction is intentionally strict. Comma-heavy prose was the
    // source of v1's false "value:*" graph edges.
    return !/[；;!?！？]/.test(object);
  }
  if (['before', 'after'].includes(relation)) return simpleTerm(object, 40);
  if (['occurs_at', 'starts_at', 'ends_at', 'birth', 'death'].includes(relation)) return isDate(object);
  if (['location', 'belongs_to', 'is', 'supports', 'contradicts', 'causes', 'influences', 'depends_on', 'explains', 'foreshadows', 'resolves'].includes(relation)) {
    return simpleTerm(object, 40);
  }
  return false;
}

function canonicalDate(value) {
  const clean = normalized(value).replace(/\s+/g, '');
  let match = clean.match(/^(\d{4})(?:[-/.](\d{1,2})(?:[-/.](\d{1,2}))?)?$/);
  if (!match) match = clean.match(/^(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2] || 1);
  const day = Number(match[3] || 1);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  return { year, month, day, value: Date.UTC(year, month - 1, day) };
}

function isDate(value) {
  return Boolean(canonicalDate(value));
}

function detectSubjectType(relation, subject, property) {
  if (isDate(subject)) return 'time';
  if (PERSON_PROPERTIES.has(property) || ['birth', 'death'].includes(relation)) return 'person';
  if (property && VARIABLE_PROPERTIES.has(property)) return 'variable';
  if (['occurs_at', 'starts_at', 'ends_at'].includes(relation)) return 'event';
  return 'entity';
}

function detectObjectType(relation, object, property) {
  if (isDate(object) || ['birth', 'death', 'occurs_at', 'starts_at', 'ends_at'].includes(relation) && /\d{4}/.test(object)) return 'time';
  if (property) return 'datum';
  if (relation === 'location') return 'place';
  return 'entity';
}

function statements(content) {
  const result = [];
  // Relationship extraction must use the same visible-Markdown boundary as
  // diagnostics and declarations: YAML Front Matter and both ``` / ~~~
  // fenced blocks are metadata/examples, never authoritative prose facts.
  for (const line of meaningfulLines(content)) {
    if (!/^\s{0,3}#/.test(line.text)) {
      const regex = /[^。！？!?；;\n]+[。！？!?；;]?/g;
      let match;
      while ((match = regex.exec(line.text))) {
        const raw = match[0];
        const lead = raw.match(/^\s*/)[0].length;
        const quote = raw.trim();
        if (!quote) continue;
        const start = line.start + match.index + lead;
        result.push({ start, end: start + quote.length, quote });
      }
    }
  }
  return result;
}

function evidenceStatementForFact(statement, fact) {
  const needles = Array.isArray(fact?.evidenceNeedles) ? fact.evidenceNeedles : [];
  for (const candidate of needles) {
    const needle = String(candidate || '');
    if (!needle) continue;
    const relativeStart = statement.quote.indexOf(needle);
    if (relativeStart < 0) continue;
    return {
      start: statement.start + relativeStart,
      end: statement.start + relativeStart + needle.length,
      quote: statement.quote.slice(relativeStart, relativeStart + needle.length),
    };
  }
  // If Markdown decoration or Unicode normalization prevents an exact
  // sub-range match, retain the full statement. The two-evidence issue gate
  // below will then suppress any would-be conflict whose citations collapse
  // to the same locator.
  return statement;
}

function parseStatement(raw) {
  const text = cleanToken(raw.replace(/^\s*(?:[-+*]|\d+[.)、])\s*/, '').replace(/[*_`]/g, ''));
  if (!text) return [];
  const interval = text.match(/^([^,;。！!？?]{1,24}?)从(.{4,24}?)(到|至)(.{4,24})$/);
  if (interval && isDate(interval[2]) && isDate(interval[4])) {
    return [
      {
        subject: interval[1], object: interval[2], relation: 'starts_at', confidence: 0.99,
        evidenceNeedles: [`从${interval[2]}`, interval[2]],
      },
      {
        subject: interval[1], object: interval[4], relation: 'ends_at', confidence: 0.99,
        evidenceNeedles: [`${interval[3]}${interval[4]}`, interval[4]],
      },
    ];
  }
  const patterns = [
    // “发生于”必须先于“生于”判断，否则后者会把主语尾部的“发”吞掉。
    { re: /^(.{1,30}?)(?:发生于)(.{1,40})$/, relation: 'occurs_at', confidence: 0.97 },
    { re: /^(.{1,30}?)(?:出生于|生于)(.{1,40})$/, relation: 'birth', confidence: 0.98 },
    { re: /^(.{1,30}?)(?:死亡于|逝世于|卒于)(.{1,40})$/, relation: 'death', confidence: 0.98 },
    { re: /^(.{1,30}?)(?:位于|居住于|所在地是|所在地为)(.{1,40})$/, relation: 'location', confidence: 0.96 },
    { re: /^(.{1,30}?)(?:属于)(.{1,40})$/, relation: 'belongs_to', confidence: 0.95 },
    { re: /^(.{1,30}?)(?:早于)(.{1,40})$/, relation: 'before', confidence: 0.98 },
    { re: /^(.{1,30}?)(?:晚于)(.{1,40})$/, relation: 'after', confidence: 0.98 },
    { re: /^(.{1,30}?)(?:开始于)(.{1,40})$/, relation: 'starts_at', confidence: 0.99 },
    { re: /^(.{1,30}?)(?:结束于)(.{1,40})$/, relation: 'ends_at', confidence: 0.99 },
    { re: /^([^，,；;。！!？?“”]{1,24}?)的([^，,；;。！!？?“”]{1,12}?)(?:是|为|：:)([^；;。！!？?]{1,120})$/, relation: 'attribute', confidence: 0.97, property: true },
    { re: /^([^，,；;。！!？?]{1,24}?)(?:支持)([^，,；;。！!？?]{1,40})$/, relation: 'supports', confidence: 0.94 },
    { re: /^([^，,；;。！!？?]{1,24}?)(?:反驳|否定)([^，,；;。！!？?]{1,40})$/, relation: 'contradicts', confidence: 0.94 },
    { re: /^([^，,；;。！!？?]{1,24}?)(?:导致)([^，,；;。！!？?]{1,40})$/, relation: 'causes', confidence: 0.94 },
    { re: /^([^，,；;。！!？?]{1,24}?)(?:影响)([^，,；;。！!？?]{1,40})$/, relation: 'influences', confidence: 0.93 },
    { re: /^([^，,；;。！!？?]{1,24}?)(?:依赖于|依赖)([^，,；;。！!？?]{1,40})$/, relation: 'depends_on', confidence: 0.94 },
    { re: /^([^，,；;。！!？?]{1,12}?)\s+(?:是|为)\s+([^，,；;。！!？?]{1,24})$/, relation: 'is', confidence: 0.93 },
    { re: /^([^，,；;。！!？?]{1,12}?)(是|为)([^，,；;。！!？?]{1,24})$/, relation: 'is', confidence: 0.91, compactIs: true }
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern.re);
    if (!match) continue;
    if (pattern.compactIs && /(?:只|于|但|可|还|总|便|就|若|像|算|应|或|因|作|成|认|不)$/.test(match[1])) continue;
    const fact = {
      subject: match[1],
      property: pattern.property ? match[2] : null,
      object: pattern.property || pattern.compactIs ? match[3] : match[2],
      relation: pattern.property ? 'attribute' : pattern.relation,
      confidence: pattern.confidence
    };
    if (!validFactTerms(fact.relation, cleanToken(fact.subject), cleanToken(fact.object), fact.property ? cleanToken(fact.property) : null)) continue;
    return [fact];
  }
  return [];
}

function extractHeadings(file, addEvidence, addNode) {
  for (const line of meaningfulLines(file.content)) {
    const match = line.text.match(/^(#{1,6})\s+(.+)$/);
    if (!match) continue;
    const label = cleanToken(match[2]);
    if (!label) continue;
    const start = line.start;
    const end = start + line.text.length;
    const ev = addEvidence(file, start, end, match[0], 1, `section\0${label}`);
    addNode('section', `${file.path}#${label}`, label, ev, { path: file.path, level: match[1].length });
  }
}

function extractExplicitEntitiesAndTimes(file, addEvidence, addNode) {
  const patterns = [
    { re: /[“「『"]([^”」』"\n]{2,40})[”」』"]/g, type: 'entity', confidence: 0.86 },
    { re: /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\b/g, type: 'entity', confidence: 0.84 },
    { re: /\d{4}\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?|\b\d{4}(?:[-/.]\d{1,2}(?:[-/.]\d{1,2})?)?\b/g, type: 'time', confidence: 0.99 }
  ];
  for (const line of meaningfulLines(file.content)) {
    for (const pattern of patterns) {
      pattern.re.lastIndex = 0;
      let match;
      while ((match = pattern.re.exec(line.text))) {
        const label = cleanToken(match[1] || match[0]);
        if (!validToken(label)) continue;
        const start = line.start + match.index;
        const ev = addEvidence(file, start, start + match[0].length, match[0], pattern.confidence, `${pattern.type}\0${label}`);
        addNode(pattern.type, label, label, ev, { confidence: pattern.confidence });
      }
    }
  }
}

// Only labelled declarations participate in orphan diagnostics. Quoted terms
// and capitalised English words remain useful search nodes, but are not strong
// enough evidence that the author intended to declare a story entity.
function extractExplicitDeclarations(file, addEvidence, addNode) {
  const definitions = [
    { labels: '(?:人物|角色|主体)', type: 'person', max: 40, confidence: 0.98 },
    { labels: '(?:组织|机构)', type: 'organization', max: 60, confidence: 0.98 },
    { labels: '(?:地点|地名|场所)', type: 'place', max: 60, confidence: 0.98 },
    { labels: '(?:变量|指标)', type: 'variable', max: 60, confidence: 0.99 },
  ];
  for (const line of meaningfulLines(file.content)) {
    for (const definition of definitions) {
      const match = line.text.match(new RegExp(`^\\s*(?:(?:[-*+]|\\d+[.)、])\\s*)?${definition.labels}\\s*[：:]\\s*(.{2,${definition.max}}?)\\s*$`));
      if (!match) continue;
      const labels = [...new Set(match[1].split(/[、,，;；]/).map(cleanToken))];
      if (!labels.length || labels.length > 20 || labels.some(label => !simpleTerm(label, definition.max))) continue;
      const evidenceId = addEvidence(
        file, line.start, line.end, line.text, definition.confidence,
        `declaration\0${definition.type}\0${labels.join('\0')}`
      );
      for (const label of labels) {
        addNode(definition.type, label, label, evidenceId, {
          confidence: definition.confidence,
          explicitDeclaration: true,
          declarationEvidenceIds: [evidenceId],
          declarationTypes: [definition.type],
        });
      }
      break;
    }
  }
}

// High-confidence prose pattern for an important non-fiction case: two source
// systems define the same named metric with different measurement windows.
// Keeping this separate from the generic sentence grammar prevents v1's broad
// "X的Y是Z" regex from turning arbitrary narrative clauses into variables.
function extractVariableDefinitions(file, addFact) {
  const definition = /([^，。。\n]{1,20})记录的是([^，。。\n]{2,100})，([^，。。\n]{1,20})记录的则是([^。。\n]{2,100})[。.]/g;
  for (const line of meaningfulLines(file.content)) {
    definition.lastIndex = 0;
    let match;
    while ((match = definition.exec(line.text))) {
      const following = line.text.slice(definition.lastIndex, definition.lastIndex + 180);
      const named = following.match(/(?:被称为|名为)[“"]([^”"\n]{2,30})[”"]/);
      if (!named) continue;
      const variable = cleanToken(named[1]);
      const first = cleanToken(`${match[1]}：${match[2]}`);
      const second = cleanToken(`${match[3]}：${match[4]}`);
      const firstQuote = `${match[1]}记录的是${match[2]}`;
      const secondQuote = `${match[3]}记录的则是${match[4]}`;
      const firstStart = line.start + match.index + match[0].indexOf(firstQuote);
      const secondStart = line.start + match.index + match[0].indexOf(secondQuote);
      addFact(file, { start: firstStart, end: firstStart + firstQuote.length, quote: firstQuote }, 'attribute', variable, first, 0.97, '统计口径');
      addFact(file, { start: secondStart, end: secondStart + secondQuote.length, quote: secondQuote }, 'attribute', variable, second, 0.97, '统计口径');
    }
  }
}

function meaningfulLines(content) {
  const lines = [];
  let offset = 0;
  let fence = null;
  let listIndents = [];
  let frontMatter = content.startsWith('---\n') || content.startsWith('---\r\n');
  function indentColumns(prefix) {
    let columns = 0;
    for (const character of prefix) columns = character === '\t' ? columns + (4 - columns % 4) : columns + 1;
    return columns;
  }
  for (const raw of content.split(/(?<=\n)/)) {
    const text = raw.replace(/\r?\n$/, '');
    if (frontMatter) {
      if (offset > 0 && /^(?:---|\.\.\.)\s*$/.test(text)) frontMatter = false;
      offset += raw.length;
      continue;
    }
    const fenceLine = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenceLine && fenceLine[1][0] === fence.character && fenceLine[1].length >= fence.length && /^\s*$/.test(fenceLine[2])) {
        fence = null;
      }
      offset += raw.length;
      continue;
    }
    if (fenceLine) {
      fence = { character: fenceLine[1][0], length: fenceLine[1].length };
      listIndents = [];
      offset += raw.length;
      continue;
    }
    if (!text.trim()) {
      listIndents = [];
      lines.push({ text, start: offset, end: offset + text.length });
      offset += raw.length;
      continue;
    }
    // Root-level CommonMark indented code is not visible prose. An indented
    // list marker is visible only when a preceding shallower list item opened
    // its container. This avoids treating root `    - example` code as prose.
    const prefix = text.match(/^[ \t]*/)[0];
    const indent = indentColumns(prefix);
    const listMarker = text.match(/^[ \t]*(?:[-+*]|\d+[.)、])\s+/);
    if (listMarker) {
      while (listIndents.length && listIndents[listIndents.length - 1] >= indent) listIndents.pop();
      const nested = indent >= 4;
      if (!nested || listIndents.some(parent => parent < indent)) {
        listIndents.push(indent);
        lines.push({ text, start: offset, end: offset + text.length });
      }
    } else {
      while (listIndents.length && listIndents[listIndents.length - 1] >= indent) listIndents.pop();
      if (indent === 0) listIndents = [];
      if (indent < 4) lines.push({ text, start: offset, end: offset + text.length });
    }
    offset += raw.length;
  }
  return lines;
}

function splitTopics(value) {
  return String(value || '')
    .split(/[、,，;；]/)
    .map(cleanToken)
    .filter(topic => validToken(topic) && topic.length <= 40);
}

function extractDiagnosticSignals(file, addSignal, addDeclaredTopic) {
  const lines = meaningfulLines(file.content);
  const isPrompt = file.path.toLocaleLowerCase('en-US') === 'edit.md';
  for (const line of lines) {
    const declared = line.text.match(/^\s*(?:(?:[-*+]|\d+[.)、])\s*)?伏笔\s*[：:]\s*(.{1,80}?)\s*$/);
    const resolved = line.text.match(/^\s*(?:(?:[-*+]|\d+[.)、])\s*)?(?:回收(?:伏笔)?|回应(?:伏笔)?|回收或回应伏笔|伏笔回收|伏笔回应)\s*[：:]\s*(.{1,80}?)\s*$/);
    const match = resolved || declared;
    if (!match) continue;
    const label = cleanToken(match[1]);
    if (!simpleTerm(label, 80)) continue;
    const relation = resolved ? 'resolves' : 'foreshadows';
    addSignal(file, {
      relation,
      label: resolved ? '回收伏笔' : '埋下伏笔',
      anchorKey: `${file.path}#${relation}`,
      anchorLabel: `${file.path} · ${resolved ? '伏笔回收' : '伏笔声明'}`,
      targetType: 'foreshadow',
      targetKey: `foreshadow:${normalized(label).toLocaleLowerCase('zh-CN')}`,
      targetLabel: label,
      start: line.start,
      end: line.end,
      quote: line.text,
      confidence: 1,
      source: isPrompt ? 'project_prompt' : 'manuscript',
    });
  }
  if (isPrompt) {
    for (const line of lines) {
      const directive = line.text.match(/^\s*(?:(?:[-*+]|\d+[.)、])\s*)?(?:不写|非目标|排除主题|禁止主题)\s*[：:]\s*(.{1,120}?)\s*$/);
      if (!directive) continue;
      for (const topic of splitTopics(directive[1])) {
        addSignal(file, {
          relation: 'diagnostic:excluded_topic',
          anchorKey: 'edit.md#scope',
          anchorLabel: 'edit.md 范围约束',
          targetType: 'concept',
          targetKey: `excluded-topic:${normalized(topic).toLocaleLowerCase('zh-CN')}`,
          targetLabel: topic,
          start: line.start,
          end: line.end,
          quote: line.text,
          confidence: 1,
          source: 'project_prompt'
        });
      }
    }
    return;
  }

  let currentSection = '文档开头';
  let currentSectionKey = 'root';
  const gapCounts = new Map();
  for (const line of lines) {
    const heading = line.text.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      currentSection = cleanToken(heading[2]) || currentSection;
      currentSectionKey = normalized(currentSection).toLocaleLowerCase('zh-CN');
      if (heading[1].length <= 3 && validToken(currentSection)) {
        addDeclaredTopic(file, {
          topic: currentSection,
          start: line.start,
          end: line.end,
          quote: line.text,
          confidence: 0.99
        });
      }
    }

    const declaration = line.text.match(/^\s*(?:(?:[-*+]|\d+[.)、])\s*)?(?:本章主题|章节主题|主题)\s*[：:]\s*(.{1,80}?)\s*$/);
    if (declaration) {
      for (const topic of splitTopics(declaration[1])) {
        addDeclaredTopic(file, {
          topic,
          start: line.start,
          end: line.end,
          quote: line.text,
          confidence: 1
        });
      }
    }

    const marker = /(?:【\s*待补来源\s*】|\[\s*待补来源\s*\]|\[\s*citation\s+needed\s*\]|<!--\s*citation-needed\s*-->)/gi;
    let match;
    while ((match = marker.exec(line.text))) {
      const countKey = `${currentSectionKey}\0evidence-gap`;
      const occurrence = (gapCounts.get(countKey) || 0) + 1;
      gapCounts.set(countKey, occurrence);
      addSignal(file, {
        relation: 'diagnostic:evidence_gap',
        anchorKey: `${file.path}#${currentSectionKey}`,
        anchorLabel: `${file.path} · ${currentSection}`,
        targetType: 'open_question',
        targetKey: `${file.path}#${currentSectionKey}#evidence-gap-${occurrence}`,
        targetLabel: '待补来源',
        start: line.start,
        end: line.end,
        quote: line.text,
        confidence: 1,
        source: 'manuscript'
      });
    }
  }
}

function evolutionForEdge(edge, evidenceMap) {
  const evidenceIds = [...new Set(edge.evidenceIds || [])].sort();
  const allPaths = [...new Set(evidenceIds
    .map(id => evidenceMap.get(id)?.path)
    .filter(value => typeof value === 'string' && value))].sort();
  return {
    evidenceCount: evidenceIds.length,
    pathCount: allPaths.length,
    paths: allPaths.slice(0, MAX_EVOLUTION_PATHS),
    firstPath: allPaths[0] || '',
    lastPath: allPaths[allPaths.length - 1] || '',
  };
}

function mergeExactFacts(facts, evidenceMap) {
  const merged = new Map();
  for (const fact of facts) {
    const key = `${fact.from}\0${fact.relation}\0${fact.to}\0${fact.source}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, { ...fact });
    } else {
      existing.evidenceIds = [...new Set([...existing.evidenceIds, ...fact.evidenceIds])].sort();
      existing.confidence = Math.max(existing.confidence, fact.confidence);
      existing.id = hash('edge', key);
    }
  }
  return [...merged.values()].map(edge => ({
    ...edge,
    id: hash('edge', `${edge.from}\0${edge.relation}\0${edge.to}\0${edge.source}`),
    evidenceIds: [...new Set(edge.evidenceIds || [])].sort(),
    evolution: evolutionForEdge(edge, evidenceMap),
  }));
}

function applyDerivedNodeAttributes(nodeMap, edges) {
  const grouped = new Map();
  for (const edge of edges.filter(item => item.property)) {
    const key = `${edge.from}\0${edge.property}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(edge);
  }
  for (const [key, group] of grouped) {
    const [from, property] = key.split('\0');
    const targets = [...new Set(group.map(edge => edge.to))];
    const node = nodeMap.get(from);
    if (!node) continue;
    // Per-file contributions may carry a previously derived single value.
    // Recompute from the unified edge set so a cross-file conflict never leaves
    // one arbitrary value presented as authoritative.
    const attributes = { ...(node.attributes || {}) };
    delete attributes[property];
    node.attributes = attributes;
    if (targets.length !== 1) continue;
    node.attributes = { ...node.attributes, [property]: nodeMap.get(targets[0])?.label || targets[0] };
  }
}

function detectIssues(edges, nodeMap, evidenceMap) {
  const issues = new Map();
  const high = edges.filter(edge => edge.confidence >= 0.9);
  const attributes = new Map();
  for (const edge of high) {
    const property = edge.property || ({ birth: '出生时间', death: '死亡时间', location: '位置' })[edge.relation];
    if (!property) continue;
    const key = `${edge.from}\0${property}`;
    if (!attributes.has(key)) attributes.set(key, []);
    attributes.get(key).push({ ...edge, property });
  }
  for (const [key, group] of attributes) {
    const targets = [...new Set(group.map(edge => edge.to))];
    if (targets.length < 2) continue;
    const subject = nodeMap.get(group[0].from);
    const variable = subject?.type === 'variable' || VARIABLE_PROPERTIES.has(group[0].property);
    const hasPrompt = group.some(edge => edge.source === 'project_prompt');
    const type = variable ? 'variable_drift' : 'attribute_conflict';
    const title = variable
      ? `${subject?.label || '变量'} 的${group[0].property}发生漂移`
      : `${subject?.label || '实体'} 的${group[0].property}前后不一致`;
    const description = hasPrompt
      ? `正文与 edit.md 中对「${group[0].property}」的声明不一致`
      : `不同文件对「${group[0].property}」给出了多个互斥值`;
    const conflictIdentity = `${key}\0${[...targets].sort().join('\0')}`;
    addIssue(issues, type, 'error', conflictIdentity, group, nodeMap, evidenceMap, title, description, [], {
      kind: hasPrompt ? 'project_invariant' : 'cross_file', property: group[0].property,
    });
  }

  // A claim conflict requires two explicit, high-confidence facts with the
  // same directed endpoints and opposite polarity. General mentions and
  // inferred similarity never enter this diagnostic.
  const claimPairs = new Map();
  for (const edge of high.filter(item =>
    (item.relation === 'supports' || item.relation === 'contradicts') && item.assertionMode === 'explicit_statement')) {
    const key = `${edge.from}\0${edge.to}`;
    if (!claimPairs.has(key)) claimPairs.set(key, []);
    claimPairs.get(key).push(edge);
  }
  for (const [key, group] of claimPairs) {
    if (!group.some(edge => edge.relation === 'supports') || !group.some(edge => edge.relation === 'contradicts')) continue;
    const evidenceIds = new Set(group.flatMap(edge => edge.evidenceIds || []));
    if (evidenceIds.size < 2) continue;
    const [from, to] = key.split('\0');
    addIssue(issues, 'claim_conflict', 'error', key, group, nodeMap, evidenceMap,
      '同一论断同时被支持和反驳',
      `「${nodeMap.get(from)?.label || from}」对「${nodeMap.get(to)?.label || to}」存在方向相反的明确论断`,
      [], { kind: 'explicit_polarity', from, to });
  }

  const temporal = high.filter(edge => edge.relation === 'before' || edge.relation === 'after');
  const arcs = temporal.map(edge => edge.relation === 'before' ? { from: edge.from, to: edge.to, edge } : { from: edge.to, to: edge.from, edge });
  const cyclicEdges = findCycleEdges(arcs);
  if (cyclicEdges.length) {
    addIssue(issues, 'timeline_conflict', 'error', `cycle\0${cyclicEdges.map(edge => edge.id).sort().join('\0')}`, cyclicEdges, nodeMap, evidenceMap,
      '时间先后关系形成闭环', '时间先后关系形成自相矛盾的闭环', [], { kind: 'cycle' });
  }

  for (const edge of temporal) {
    const from = canonicalDate(nodeMap.get(edge.from)?.label);
    const to = canonicalDate(nodeMap.get(edge.to)?.label);
    if (!from || !to) continue;
    const invalid = edge.relation === 'before' ? from.value >= to.value : from.value <= to.value;
    if (!invalid) continue;
    addIssue(issues, 'timeline_conflict', 'error', `date-order\0${edge.from}\0${edge.relation}\0${edge.to}`, [edge], nodeMap, evidenceMap,
      '时间日期顺序倒置', `明确日期与「${humanRelation(edge.relation)}」关系无法同时成立`, [], { kind: 'date_order' });
  }

  const intervals = new Map();
  for (const edge of high.filter(item => item.relation === 'starts_at' || item.relation === 'ends_at')) {
    if (!intervals.has(edge.from)) intervals.set(edge.from, []);
    intervals.get(edge.from).push(edge);
  }
  for (const [subjectId, group] of intervals) {
    const starts = group.filter(edge => edge.relation === 'starts_at');
    const ends = group.filter(edge => edge.relation === 'ends_at');
    for (const start of starts) for (const end of ends) {
      const startDate = canonicalDate(nodeMap.get(start.to)?.label);
      const endDate = canonicalDate(nodeMap.get(end.to)?.label);
      if (!startDate || !endDate || startDate.value <= endDate.value) continue;
      addIssue(issues, 'timeline_conflict', 'error', `interval\0${subjectId}`, [start, end], nodeMap, evidenceMap,
        `${nodeMap.get(subjectId)?.label || '事件'} 的时间区间不可能`, '结束日期早于开始日期', [], { kind: 'impossible_interval' });
    }
  }

  const occurrences = new Map();
  for (const edge of high.filter(item => item.relation === 'occurs_at')) {
    if (!occurrences.has(edge.from)) occurrences.set(edge.from, []);
    occurrences.get(edge.from).push(edge);
  }
  for (const [subjectId, group] of occurrences) {
    if (new Set(group.map(edge => edge.to)).size < 2) continue;
    addIssue(issues, 'timeline_conflict', 'error', `occurs-at\0${subjectId}`, group, nodeMap, evidenceMap,
      `${nodeMap.get(subjectId)?.label || '事件'} 出现多个互斥日期`, '同一事件被声明为发生于不同日期', [], { kind: 'event_date' });
  }

  for (const edge of high.filter(item => item.relation === 'diagnostic:evidence_gap')) {
    addIssue(issues, 'evidence_gap', 'warning', `${edge.from}\0${edge.to}`, [edge], nodeMap, evidenceMap,
      '论点尚未补充来源', `${nodeMap.get(edge.from).label} 存在明确标记但尚未补充的来源`);
  }

  const resolvedForeshadows = new Set(high
    .filter(edge => edge.relation === 'resolves' && edge.assertionMode === 'explicit_marker')
    .map(edge => edge.to));
  const foreshadowDeclarations = new Map();
  for (const edge of high.filter(item => item.relation === 'foreshadows' && item.assertionMode === 'explicit_marker')) {
    if (!foreshadowDeclarations.has(edge.to)) foreshadowDeclarations.set(edge.to, []);
    foreshadowDeclarations.get(edge.to).push(edge);
  }
  for (const [targetId, group] of foreshadowDeclarations) {
    if (resolvedForeshadows.has(targetId)) continue;
    const label = nodeMap.get(targetId)?.label || '未命名伏笔';
    addIssue(issues, 'unresolved_foreshadow', 'warning', targetId, group, nodeMap, evidenceMap,
      `伏笔「${label}」尚未回收`, '存在明确的伏笔标记，但全项目没有对应的回收或回应标记',
      [], { kind: 'explicit_marker', foreshadowNodeId: targetId });
  }

  const semanticNodeIds = new Set(edges
    .filter(edge => !String(edge.relation || '').startsWith('diagnostic:'))
    .flatMap(edge => [edge.from, edge.to]));
  const orphanTypes = new Set(['person', 'organization', 'place', 'variable']);
  for (const node of nodeMap.values()) {
    const declaredTypes = (node.declarationTypes || []).filter(type => orphanTypes.has(type));
    if (node.explicitDeclaration !== true || !declaredTypes.length || semanticNodeIds.has(node.id)) continue;
    const declarationEvidenceIds = [...new Set(node.declarationEvidenceIds || [])].sort();
    if (!declarationEvidenceIds.length) continue;
    const displayType = orphanTypes.has(node.type) ? node.type : declaredTypes[0];
    addIssue(issues, 'orphan_entity', 'info', node.id, [], nodeMap, evidenceMap,
      `显式声明的${humanNodeType(displayType)}「${node.label}」尚未建立关系`,
      '该节点来自明确声明，但在全项目图谱中没有任何语义关系',
      [{ ...node, evidenceIds: declarationEvidenceIds }],
      { kind: 'explicit_declaration', declaredTypes });
  }

  const exclusions = high.filter(edge => edge.relation === 'diagnostic:excluded_topic' && edge.source === 'project_prompt');
  const declarations = [...nodeMap.values()].filter(node => node.type === 'declared_topic');
  for (const exclusion of exclusions) {
    const topicKey = nodeMap.get(exclusion.to)?.key;
    for (const declaration of declarations.filter(node => node.topicKey === topicKey)) {
      addIssue(issues, 'prompt_drift', 'warning', `${exclusion.to}\0${declaration.id}`, [exclusion], nodeMap, evidenceMap,
        '章节主题偏离 edit.md 范围', `${declaration.path} 明确写入了 edit.md 排除的主题「${nodeMap.get(exclusion.to).label}」`, [declaration], { kind: 'excluded_topic' });
    }
  }
  return [...issues.values()];
}

function detectGraphIssues(nodes, edges, evidence) {
  // This diagnostic entry point accepts only a graph already constructed and
  // snapshot-validated by Main. Renderer labels, paths, revisions, evidence
  // spans, or other caller-authored graph fragments are never authority.
  if (!Array.isArray(nodes) || !Array.isArray(edges) || !Array.isArray(evidence)) {
    throw new TypeError('nodes, edges and evidence must be arrays');
  }
  const nodeMap = new Map(nodes.map(node => [node.id, node]));
  const evidenceMap = new Map(evidence.map(item => [item.id, item]));
  return stableSort(detectIssues(edges, nodeMap, evidenceMap));
}

function findCycleEdges(arcs) {
  const adjacency = new Map();
  for (const arc of arcs) {
    if (!adjacency.has(arc.from)) adjacency.set(arc.from, []);
    adjacency.get(arc.from).push(arc);
  }
  for (const list of adjacency.values()) list.sort((a, b) => a.edge.id.localeCompare(b.edge.id));
  const state = new Map();
  const stack = [];
  const found = new Map();
  function visit(node) {
    state.set(node, 1);
    for (const arc of adjacency.get(node) || []) {
      if (arc.from === arc.to) found.set(arc.edge.id, arc.edge);
      else if (!state.has(arc.to)) {
        stack.push(arc); visit(arc.to); stack.pop();
      } else if (state.get(arc.to) === 1) {
        found.set(arc.edge.id, arc.edge);
        for (let index = stack.length - 1; index >= 0; index--) {
          found.set(stack[index].edge.id, stack[index].edge);
          if (stack[index].from === arc.to) break;
        }
      }
    }
    state.set(node, 2);
  }
  for (const node of [...adjacency.keys()].sort()) if (!state.has(node)) visit(node);
  return [...found.values()];
}

function addIssue(map, type, severity, key, edges, nodeMap, evidenceMap, title, description, evidenceNodes = [], details = {}) {
  if (!ISSUE_TYPES.includes(type)) throw new TypeError(`unsupported issue type: ${type}`);
  const evidenceIds = [...new Set([
    ...edges.flatMap(edge => edge.evidenceIds),
    ...evidenceNodes.flatMap(node => node.evidenceIds || [])
  ])].sort();
  if (!evidenceIds.length) return;
  if (evidenceIds.some(id => (evidenceMap.get(id)?.confidence || 0) < 0.9)) return;
  if (TWO_EVIDENCE_ISSUE_TYPES.has(type)) {
    const locatable = evidenceIds.map(id => evidenceMap.get(id)).filter(item => evidenceLocatorKey(item));
    if (!hasIndependentEvidencePair(locatable)) return;
  }
  const nodeIds = [...new Set([
    ...edges.flatMap(edge => [edge.from, edge.to]),
    ...evidenceNodes.map(node => node.id)
  ])].sort();
  // Identity describes the logical diagnostic, not its current evidence
  // offsets/revisions. This lets acknowledged/dismissed decisions survive a
  // re-index when surrounding prose moves but the same conflict still exists.
  const id = hash('issue', `${type}\0${key}`);
  map.set(id, {
    id,
    type,
    severity,
    title,
    description,
    message: description,
    nodeIds,
    edgeIds: [...new Set(edges.map(edge => edge.id))].sort(),
    evidenceIds,
    confidence: Math.min(...evidenceIds.map(id => evidenceMap.get(id).confidence)),
    status: 'open',
    resolution: null,
    details,
  });
}

function evidenceLocatorKey(evidence) {
  if (!evidence || typeof evidence.path !== 'string' || !evidence.path ||
      !Number.isSafeInteger(evidence.start) || !Number.isSafeInteger(evidence.end) ||
      evidence.start < 0 || evidence.end <= evidence.start ||
      typeof evidence.quote !== 'string' || evidence.quote.length !== evidence.end - evidence.start) return '';
  return `${evidence.path}\0${evidence.revision || ''}\0${evidence.start}\0${evidence.end}`;
}

function hasIndependentEvidencePair(evidence) {
  for (let left = 0; left < evidence.length; left += 1) {
    for (let right = left + 1; right < evidence.length; right += 1) {
      const a = evidence[left];
      const b = evidence[right];
      if (evidenceLocatorKey(a) === evidenceLocatorKey(b)) continue;
      if (a.path !== b.path || a.end <= b.start || b.end <= a.start) return true;
    }
  }
  return false;
}

function humanRelation(relation) {
  return ({ birth: '出生时间', death: '死亡时间', location: '位置', occurs_at: '发生时间', starts_at: '开始时间', ends_at: '结束时间', belongs_to: '归属', before: '早于', after: '晚于', is: '定义', supports: '支持', contradicts: '反驳', causes: '导致', influences: '影响', depends_on: '依赖' })[relation] || relation.replace(/^value:/, '属性：');
}

function humanNodeType(type) {
  return ({ person: '人物', organization: '组织', place: '地点', variable: '变量' })[type] || '实体';
}

// Merge independently analyzed file contributions and deliberately recompute
// issues from the unified edge set. This is the correctness boundary that lets
// the graph index reuse unchanged files without losing cross-file conflicts.
function mergeAnalyzedGraphs(graphs) {
  if (!Array.isArray(graphs)) throw new TypeError('graphs must be an array');
  const nodeMap = new Map();
  const edgeMap = new Map();
  const evidenceMap = new Map();

  for (const [index, graph] of graphs.entries()) {
    if (!graph || graph.schema !== SCHEMA) throw new TypeError(`graphs[${index}] has an unsupported schema`);
    if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.evidence)) {
      throw new TypeError(`graphs[${index}] is incomplete`);
    }
    for (const evidence of graph.evidence) {
      const existing = evidenceMap.get(evidence.id);
      if (existing && JSON.stringify(existing) !== JSON.stringify(evidence)) {
        throw new TypeError(`evidence id collision: ${evidence.id}`);
      }
      evidenceMap.set(evidence.id, { ...evidence });
    }
    for (const node of graph.nodes) {
      const normalizedType = NODE_TYPES.includes(node.type) ? node.type : 'entity';
      const existing = nodeMap.get(node.id);
      if (!existing) {
        nodeMap.set(node.id, {
          ...node,
          type: normalizedType,
          aliases: [...(node.aliases || [])],
          attributes: { ...(node.attributes || {}) },
          evidenceIds: [...(node.evidenceIds || [])],
          explicitDeclaration: node.explicitDeclaration === true,
          declarationEvidenceIds: [...(node.declarationEvidenceIds || [])],
          declarationTypes: [...(node.declarationTypes || [])],
        });
      } else {
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...(node.evidenceIds || [])])].sort();
        existing.aliases = [...new Set([...(existing.aliases || []), ...(node.aliases || [])])].sort();
        existing.attributes = { ...(existing.attributes || {}), ...(node.attributes || {}) };
        existing.explicitDeclaration = existing.explicitDeclaration === true || node.explicitDeclaration === true;
        existing.declarationEvidenceIds = [...new Set([
          ...(existing.declarationEvidenceIds || []),
          ...(node.declarationEvidenceIds || []),
        ])].sort();
        existing.declarationTypes = [...new Set([
          ...(existing.declarationTypes || []),
          ...(node.declarationTypes || []),
        ])].sort();
        existing.type = strongerNodeType(existing.type, normalizedType);
        existing.confidence = Math.max(existing.confidence || 0, node.confidence || 0);
        if (String(node.updatedAt || '') > String(existing.updatedAt || '')) existing.updatedAt = node.updatedAt;
      }
    }
    for (const edge of graph.edges) {
      const existing = edgeMap.get(edge.id);
      if (!existing) {
        edgeMap.set(edge.id, { ...edge, evidenceIds: [...(edge.evidenceIds || [])] });
      } else {
        existing.evidenceIds = [...new Set([...existing.evidenceIds, ...(edge.evidenceIds || [])])].sort();
        existing.confidence = Math.max(existing.confidence, edge.confidence);
      }
    }
  }

  const edges = stableSort([...edgeMap.values()].map(edge => ({
    ...edge,
    evidenceIds: [...new Set(edge.evidenceIds)].sort(),
    evolution: evolutionForEdge(edge, evidenceMap),
  })));
  applyDerivedNodeAttributes(nodeMap, edges);
  const nodes = stableSort([...nodeMap.values()].map(node => ({
    ...node,
    evidenceIds: [...new Set(node.evidenceIds)].sort(),
    explicitDeclaration: node.explicitDeclaration === true,
    declarationEvidenceIds: [...new Set(node.declarationEvidenceIds || [])].sort(),
    declarationTypes: [...new Set(node.declarationTypes || [])].sort(),
  })));
  const issues = stableSort(detectIssues(edges, nodeMap, evidenceMap));
  return {
    schema: SCHEMA,
    nodes,
    edges,
    evidence: stableSort([...evidenceMap.values()]),
    issues
  };
}

module.exports = {
  SCHEMA,
  NODE_TYPES,
  EDGE_TYPES,
  ISSUE_TYPES,
  DEFAULT_LIMITS,
  MAX_EVOLUTION_PATHS,
  analyzeProject,
  mergeAnalyzedGraphs,
  detectGraphIssues,
  evolutionForEdge,
  parseStatement,
};
