'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { detectGraphIssues, evolutionForEdge } = require('./consistency-engine');

const CORRECTIONS_SCHEMA = 'writcraft.graph-corrections/v1';
const COMMAND_SCHEMA = 'writcraft.graph-correction-command/v1';
const GRAPH_SCHEMA = 'writcraft.graph/v2';
const CORRECTIONS_RELATIVE_PATH = '.writcraft/graph-corrections.json';
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CORRECTIONS = 2000;
const MAX_ATTRIBUTE_VALUE_CHARS = 500;
const ID_RE = /^(?:node|edge|ev)_[a-f0-9]{16}$/;
const GRAPH_ID_RE = /^graph_[a-f0-9]{32}$/;
const CORRECTION_ID_RE = /^corr_[a-f0-9]{24}$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const CONTENT_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const ATTRIBUTE_RE = /^[^\0\r\n]{1,80}$/u;
const FORBIDDEN_ATTRIBUTE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RECORD_TYPES = new Set(['merge_alias', 'decide_fact', 'edit_attribute']);
const COMMAND_TYPES = new Set([...RECORD_TYPES, 'remove_correction']);

class GraphCorrectionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GraphCorrectionError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new GraphCorrectionError(code, message);
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, length);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareCorrectionRecency(left, right) {
  return compareText(left.updatedAt, right.updatedAt) || compareText(left.createdAt, right.createdAt) || compareText(left.id, right.id);
}

function validTimestamp(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('INVALID_CORRECTIONS_FILE', '纠错时间无效');
  return new Date(value).toISOString();
}

function validId(value, label) {
  if (typeof value !== 'string' || !ID_RE.test(value)) fail('INVALID_COMMAND', `${label} 无效`);
  return value;
}

function validKey(value, label) {
  if (typeof value !== 'string' || !value || value.length > 500 || value.includes('\0')) {
    fail('INVALID_CORRECTIONS_FILE', `${label} 无效`);
  }
  return value;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validAttribute(value, code) {
  if (typeof value !== 'string' || !ATTRIBUTE_RE.test(value) || !value.trim() || FORBIDDEN_ATTRIBUTE_KEYS.has(value.trim())) {
    fail(code, '属性名无效或不允许');
  }
  return value.trim();
}

function assertExactCommand(command) {
  if (!isPlainObject(command)) fail('INVALID_COMMAND', '图谱纠错命令必须是普通对象');
  const specific = command.type === 'merge_alias' ? ['sourceNodeId', 'targetNodeId']
    : command.type === 'decide_fact' ? ['edgeId', 'decision']
    : command.type === 'edit_attribute' ? ['nodeId', 'attribute', 'value']
    : command.type === 'remove_correction' ? ['correctionId']
    : [];
  const allowed = new Set(['schema', 'graphIdentity', 'type', ...specific]);
  const keys = Object.keys(command);
  if (keys.length !== allowed.size || keys.some(key => !allowed.has(key))) fail('INVALID_COMMAND', '图谱纠错命令字段无效');
}

function stateLocation(rootPath, createMetadataDirectory = false) {
  if (typeof rootPath !== 'string' || !rootPath) fail('INVALID_ROOT', '项目目录无效');
  const absolute = path.resolve(rootPath);
  let rootStat;
  try { rootStat = fs.statSync(absolute); } catch (_) { fail('INVALID_ROOT', '项目目录不存在'); }
  if (!rootStat.isDirectory()) fail('INVALID_ROOT', '项目路径不是目录');
  const root = fs.realpathSync(absolute);
  const metadata = path.join(root, '.writcraft');
  if (!fs.existsSync(metadata)) {
    if (!createMetadataDirectory) {
      return { root, metadata, file: path.join(metadata, 'graph-corrections.json'), exists: false };
    }
    fs.mkdirSync(metadata, { mode: 0o700 });
  }
  const metadataStat = fs.lstatSync(metadata);
  if (metadataStat.isSymbolicLink() || !metadataStat.isDirectory() || fs.realpathSync(metadata) !== metadata) {
    fail('UNSAFE_CORRECTIONS_PATH', '.writcraft 必须是项目内普通目录');
  }
  const file = path.join(metadata, 'graph-corrections.json');
  if (fs.existsSync(file)) {
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
      fail('UNSAFE_CORRECTIONS_PATH', 'graph-corrections.json 必须是普通文件');
    }
  }
  return { root, metadata, file, exists: fs.existsSync(file) };
}

function atomicWrite(filePath, content) {
  const temporary = path.join(path.dirname(filePath),
    `.graph-corrections.json.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, filePath);
    try {
      const directoryFd = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (_) {}
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
    try { fs.unlinkSync(temporary); } catch (_) {}
    throw error;
  }
}

function graphIdentity(graph) {
  if (!graph || graph.schema !== GRAPH_SCHEMA || !graph.manifest || !Array.isArray(graph.manifest.inputFiles)) {
    fail('INVALID_GRAPH', '当前图谱契约无效');
  }
  const inputs = graph.manifest.inputFiles.map(item => {
    if (!item || typeof item.path !== 'string' || !REVISION_RE.test(item.revision || '')) {
      fail('INVALID_GRAPH', '图谱文件 revision 无效');
    }
    return { path: item.path, revision: item.revision };
  }).sort((a, b) => compareText(a.path, b.path));
  return `graph_${hash(JSON.stringify({ schema: graph.schema, inputs }), 32)}`;
}

function normalizeEvidenceBinding(raw) {
  if (!isPlainObject(raw) || !ID_RE.test(raw.id || '') || typeof raw.path !== 'string' || !raw.path ||
      !REVISION_RE.test(raw.revision || '') || !CONTENT_HASH_RE.test(raw.contentHash || '') ||
      typeof raw.blockId !== 'string' || !/^blk_[a-f0-9]{16}$/.test(raw.blockId)) {
    fail('INVALID_CORRECTIONS_FILE', '纠错证据绑定无效');
  }
  return { id: raw.id, path: raw.path, revision: raw.revision, contentHash: raw.contentHash, blockId: raw.blockId };
}

function normalizeRecord(raw) {
  if (!isPlainObject(raw) || !CORRECTION_ID_RE.test(raw.id || '') || !RECORD_TYPES.has(raw.type) ||
      !GRAPH_ID_RE.test(raw.createdAgainst || '') || !Array.isArray(raw.evidence) || raw.evidence.length > 100) {
    fail('INVALID_CORRECTIONS_FILE', '纠错记录无效');
  }
  const record = {
    id: raw.id,
    type: raw.type,
    createdAgainst: raw.createdAgainst,
    createdAt: validTimestamp(raw.createdAt),
    updatedAt: validTimestamp(raw.updatedAt),
    evidence: raw.evidence.map(normalizeEvidenceBinding),
  };
  if (raw.type === 'merge_alias') {
    if (!isPlainObject(raw.source) || !isPlainObject(raw.target)) fail('INVALID_CORRECTIONS_FILE', '别名节点绑定无效');
    record.source = { id: validId(raw.source?.id, '别名源节点'), key: validKey(raw.source?.key, '别名源 key'), label: validKey(raw.source?.label, '别名源标签'), type: validKey(raw.source?.type, '别名源类型') };
    record.target = { id: validId(raw.target?.id, '别名目标节点'), key: validKey(raw.target?.key, '别名目标 key'), label: validKey(raw.target?.label, '别名目标标签'), type: validKey(raw.target?.type, '别名目标类型') };
    if (record.source.key === record.target.key) fail('INVALID_CORRECTIONS_FILE', '别名节点不能合并到自身');
  } else if (raw.type === 'decide_fact') {
    if (!isPlainObject(raw.edge)) fail('INVALID_CORRECTIONS_FILE', '事实关系绑定无效');
    if (!['confirmed', 'rejected'].includes(raw.decision)) fail('INVALID_CORRECTIONS_FILE', '事实决定无效');
    record.edge = {
      id: validId(raw.edge?.id, '事实关系'),
      fromKey: validKey(raw.edge?.fromKey, '事实主体'),
      toKey: validKey(raw.edge?.toKey, '事实宾语'),
      relation: validKey(raw.edge?.relation, '事实关系'),
      property: raw.edge?.property === null ? null : validKey(raw.edge?.property, '事实属性'),
      source: ['project_prompt', 'manuscript'].includes(raw.edge?.source) ? raw.edge.source : fail('INVALID_CORRECTIONS_FILE', '事实来源无效'),
    };
    record.decision = raw.decision;
  } else {
    if (!isPlainObject(raw.node)) fail('INVALID_CORRECTIONS_FILE', '属性节点绑定无效');
    record.node = { id: validId(raw.node?.id, '属性节点'), key: validKey(raw.node?.key, '属性节点 key'), label: validKey(raw.node?.label, '属性节点标签') };
    if (!(raw.value === null || typeof raw.value === 'string') || (typeof raw.value === 'string' && raw.value.length > MAX_ATTRIBUTE_VALUE_CHARS)) {
      fail('INVALID_CORRECTIONS_FILE', '属性值无效');
    }
    record.attribute = validAttribute(raw.attribute, 'INVALID_CORRECTIONS_FILE');
    record.value = raw.value;
  }
  return record;
}

function assertAliasAcyclic(records, code = 'INVALID_CORRECTIONS_FILE') {
  const targets = new Map(records.filter(record => record.type === 'merge_alias')
    .map(record => [record.source.key, record.target.key]));
  for (const start of targets.keys()) {
    const seen = new Set();
    let current = start;
    while (targets.has(current)) {
      if (seen.has(current)) fail(code, '别名合并不能形成循环');
      seen.add(current);
      current = targets.get(current);
    }
  }
}

function emptyDocument() {
  return { schema: CORRECTIONS_SCHEMA, graphSchema: GRAPH_SCHEMA, updatedAt: new Date().toISOString(), corrections: [] };
}

function normalizeDocument(raw) {
  if (!isPlainObject(raw) || raw.schema !== CORRECTIONS_SCHEMA || raw.graphSchema !== GRAPH_SCHEMA ||
      !Array.isArray(raw.corrections) || raw.corrections.length > MAX_CORRECTIONS) {
    fail('INVALID_CORRECTIONS_FILE', '纠错文件 schema 或结构无效');
  }
  const seen = new Set();
  const corrections = raw.corrections.map(normalizeRecord).sort((a, b) => compareText(a.id, b.id));
  for (const correction of corrections) {
    if (seen.has(correction.id)) fail('INVALID_CORRECTIONS_FILE', '纠错记录重复');
    seen.add(correction.id);
  }
  assertAliasAcyclic(corrections);
  return { schema: CORRECTIONS_SCHEMA, graphSchema: GRAPH_SCHEMA, updatedAt: validTimestamp(raw.updatedAt), corrections };
}

function loadCorrections(rootPath) {
  let location;
  try { location = stateLocation(rootPath, false); } catch (error) {
    if (error instanceof GraphCorrectionError && error.code === 'UNSAFE_CORRECTIONS_PATH') {
      return { document: emptyDocument(), reason: 'UNSAFE_PATH', persistenceBlocked: true };
    }
    throw error;
  }
  if (!location.exists) return { document: emptyDocument(), reason: 'MISSING', persistenceBlocked: false };
  try {
    const stat = fs.statSync(location.file);
    if (stat.size > MAX_FILE_BYTES) return { document: emptyDocument(), reason: 'TOO_LARGE', persistenceBlocked: true };
    return { document: normalizeDocument(JSON.parse(fs.readFileSync(location.file, 'utf8'))), reason: null, persistenceBlocked: false };
  } catch (error) {
    return { document: emptyDocument(), reason: error instanceof GraphCorrectionError ? 'INVALID' : 'CORRUPT', persistenceBlocked: true };
  }
}

function saveCorrections(rootPath, document) {
  const normalized = normalizeDocument(document);
  const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_FILE_BYTES) fail('CORRECTIONS_FILE_TOO_LARGE', '纠错文件超过大小上限');
  const location = stateLocation(rootPath, true);
  atomicWrite(location.file, serialized);
  return normalized;
}

function graphMaps(graph) {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.evidence)) fail('INVALID_GRAPH', '图谱结构无效');
  return {
    nodes: new Map(graph.nodes.map(node => [node.id, node])),
    evidence: new Map(graph.evidence.map(item => [item.id, item])),
  };
}

function evidenceBindings(ids, evidenceMap) {
  return [...new Set(ids || [])].map(id => {
    const item = evidenceMap.get(id);
    if (!item) fail('STALE_GRAPH', '图谱证据已变更，请重新分析');
    return normalizeEvidenceBinding(item);
  }).sort((a, b) => compareText(a.id, b.id)).slice(0, 100);
}

function correctionKey(record) {
  if (record.type === 'merge_alias') return `merge_alias\0${record.source.key}`;
  if (record.type === 'decide_fact') return `decide_fact\0${record.edge.fromKey}\0${record.edge.relation}\0${record.edge.property || ''}\0${record.edge.toKey}\0${record.edge.source}`;
  return `edit_attribute\0${record.node.key}\0${record.attribute}`;
}

function aliasTypesCompatible(sourceType, targetType) {
  if (sourceType === targetType) return true;
  const entitySpecific = new Set(['person', 'organization', 'place', 'concept']);
  return sourceType === 'entity' && entitySpecific.has(targetType) || targetType === 'entity' && entitySpecific.has(sourceType);
}

function createRecord(graph, command) {
  assertExactCommand(command);
  if (!command || typeof command !== 'object' || command.schema !== COMMAND_SCHEMA || !RECORD_TYPES.has(command.type) ||
      !GRAPH_ID_RE.test(command.graphIdentity || '')) fail('INVALID_COMMAND', '图谱纠错命令无效');
  const identity = graphIdentity(graph);
  if (command.graphIdentity !== identity) fail('STALE_GRAPH', '图谱已变更，请重新分析后纠错');
  const { nodes, evidence } = graphMaps(graph);
  const now = new Date().toISOString();
  let record;
  if (command.type === 'merge_alias') {
    const source = nodes.get(validId(command.sourceNodeId, '别名源节点'));
    const target = nodes.get(validId(command.targetNodeId, '别名目标节点'));
    if (!source || !target || source.id === target.id) fail('STALE_GRAPH', '别名节点已变更');
    if (!aliasTypesCompatible(source.type, target.type)) fail('INCOMPATIBLE_ALIAS_TYPES', '只能合并同类节点或将通用实体与具体实体合并');
    record = {
      type: command.type,
      source: { id: source.id, key: source.key, label: source.label, type: source.type },
      target: { id: target.id, key: target.key, label: target.label, type: target.type },
      evidence: evidenceBindings([...(source.evidenceIds || []), ...(target.evidenceIds || [])], evidence),
    };
  } else if (command.type === 'decide_fact') {
    if (!['confirmed', 'rejected'].includes(command.decision)) fail('INVALID_COMMAND', '事实决定只能是确认或否定');
    const edgeId = validId(command.edgeId, '事实关系');
    const edge = graph.edges.find(item => item.id === edgeId);
    const from = edge ? nodes.get(edge.from) : null;
    const to = edge ? nodes.get(edge.to) : null;
    if (!edge || !from || !to) fail('STALE_GRAPH', '事实关系已变更');
    record = {
      type: command.type,
      edge: { id: edge.id, fromKey: from.key, toKey: to.key, relation: edge.relation, property: edge.property || null, source: edge.source },
      decision: command.decision,
      evidence: evidenceBindings(edge.evidenceIds, evidence),
    };
  } else {
    const node = nodes.get(validId(command.nodeId, '属性节点'));
    if (!node) fail('STALE_GRAPH', '节点已变更');
    const attribute = validAttribute(command.attribute, 'INVALID_COMMAND');
    const value = command.value === null ? null : typeof command.value === 'string' ? command.value.trim() : fail('INVALID_COMMAND', '属性值无效');
    if (value !== null && value.length > MAX_ATTRIBUTE_VALUE_CHARS) fail('INVALID_COMMAND', '属性值超过 500 个字符');
    record = {
      type: command.type,
      node: { id: node.id, key: node.key, label: node.label },
      attribute,
      value,
      evidence: evidenceBindings(node.evidenceIds, evidence),
    };
  }
  const semanticKey = correctionKey(record);
  return normalizeRecord({
    ...record,
    id: `corr_${hash(semanticKey)}`,
    createdAgainst: identity,
    createdAt: now,
    updatedAt: now,
  });
}

function evidenceState(record, evidenceMap) {
  if (!record.evidence.length) return 'unbound';
  return record.evidence.every(binding => {
    const current = evidenceMap.get(binding.id);
    return current && current.revision === binding.revision && current.contentHash === binding.contentHash && current.blockId === binding.blockId;
  }) ? 'current' : 'stale';
}

function mergeEdgeStatus(left, right) {
  if (left === right) return left;
  if (left === 'confirmed' || right === 'confirmed') return 'confirmed';
  if (left === 'proposed' || right === 'proposed') return 'proposed';
  return 'rejected';
}

function collapseSemanticEdges(edges, evidenceMap) {
  const merged = new Map();
  for (const edge of [...edges].sort((left, right) => compareText(left.id, right.id))) {
    const key = `${edge.from}\0${edge.relation}\0${edge.to}\0${edge.source}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...edge,
        evidenceIds: [...new Set(edge.evidenceIds || [])].sort(compareText),
        correctionIds: [...new Set([...(edge.correctionIds || []), edge.correctionId].filter(Boolean))].sort(compareText),
      });
      continue;
    }
    existing.evidenceIds = [...new Set([...existing.evidenceIds, ...(edge.evidenceIds || [])])].sort(compareText);
    existing.confidence = Math.max(existing.confidence || 0, edge.confidence || 0);
    existing.status = mergeEdgeStatus(existing.status, edge.status);
    existing.correctionIds = [...new Set([
      ...(existing.correctionIds || []), ...(edge.correctionIds || []), edge.correctionId,
    ].filter(Boolean))].sort(compareText);
  }
  return [...merged.values()].map(edge => {
    const correctionIds = [...new Set(edge.correctionIds || [])].sort(compareText);
    const corrected = { ...edge, correctionIds, evolution: evolutionForEdge(edge, evidenceMap) };
    if (correctionIds.length === 1) corrected.correctionId = correctionIds[0];
    else delete corrected.correctionId;
    return corrected;
  }).sort((left, right) => compareText(left.id, right.id));
}

function applyCorrectionsDocument(graph, document, state = {}) {
  const identity = graphIdentity(graph);
  const nodes = graph.nodes.map(node => ({
    ...node,
    aliases: [...(node.aliases || [])],
    attributes: { ...(node.attributes || {}) },
    evidenceIds: [...(node.evidenceIds || [])],
    declarationEvidenceIds: [...(node.declarationEvidenceIds || [])],
    declarationTypes: [...(node.declarationTypes || [])],
  }));
  let edges = graph.edges.map(edge => ({ ...edge, evidenceIds: [...(edge.evidenceIds || [])] }));
  const evidenceMap = new Map(graph.evidence.map(item => [item.id, item]));
  const nodeByKey = new Map(nodes.map(node => [node.key, node]));
  const statuses = [];

  const replacement = new Map();
  const aliasRecords = [];
  for (const correction of document.corrections.filter(item => item.type === 'merge_alias')) {
    const source = nodeByKey.get(correction.source.key);
    const target = nodeByKey.get(correction.target.key);
    const active = Boolean(source && target && source.id !== target.id && aliasTypesCompatible(source.type, target.type));
    if (active) {
      replacement.set(source.id, target.id);
      aliasRecords.push({ correction, source });
    }
    statuses.push({ id: correction.id, type: correction.type, active, evidenceState: evidenceState(correction, evidenceMap), label: `${correction.source.label} → ${correction.target.label}` });
  }

  function finalNodeId(id) {
    const seen = new Set();
    while (replacement.has(id) && !seen.has(id)) { seen.add(id); id = replacement.get(id); }
    return id;
  }
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  for (const { correction, source } of aliasRecords) {
    const target = nodeById.get(finalNodeId(source.id));
    if (!target || target.id === source.id) continue;
    target.aliases = [...new Set([...target.aliases, source.label, ...source.aliases])].filter(alias => alias && alias !== target.label).sort(compareText);
    target.attributes = { ...source.attributes, ...target.attributes };
    target.confidence = Math.max(target.confidence || 0, source.confidence || 0);
    target.evidenceIds = [...new Set([...target.evidenceIds, ...source.evidenceIds])].sort(compareText);
    target.explicitDeclaration = target.explicitDeclaration === true || source.explicitDeclaration === true;
    target.declarationEvidenceIds = [...new Set([
      ...(target.declarationEvidenceIds || []), ...(source.declarationEvidenceIds || []),
    ])].sort(compareText);
    target.declarationTypes = [...new Set([
      ...(target.declarationTypes || []), ...(source.declarationTypes || []),
    ])].sort(compareText);
    target.correctionIds = [...new Set([...(target.correctionIds || []), ...(source.correctionIds || []), correction.id])];
    target.status = 'confirmed';
  }
  edges = collapseSemanticEdges(
    edges.map(edge => ({ ...edge, from: finalNodeId(edge.from), to: finalNodeId(edge.to) })).filter(edge => edge.from !== edge.to),
    evidenceMap
  );
  const hiddenNodeIds = new Set([...replacement.keys()]);
  const correctedNodes = nodes.filter(node => !hiddenNodeIds.has(node.id));
  const correctedNodeById = new Map(correctedNodes.map(node => [node.id, node]));
  function canonicalCorrectionKey(key) {
    const rawNode = nodeByKey.get(key);
    if (!rawNode) return key;
    return nodeById.get(finalNodeId(rawNode.id))?.key || key;
  }

  // Attribute edits are author-owned constraints. Apply them after alias
  // canonicalization so extracted attributes on the surviving target cannot
  // silently override a decision authored on the merged source node.
  const attributeWinnerBySlot = new Map();
  const supersededAttributeIds = new Set();
  const attributeCorrections = document.corrections.filter(item => item.type === 'edit_attribute').sort(compareCorrectionRecency);
  for (const correction of attributeCorrections) {
    const canonicalKey = canonicalCorrectionKey(correction.node.key);
    const node = correctedNodes.find(item => item.key === canonicalKey);
    if (node) {
      const slot = `${canonicalKey}\0${correction.attribute}`;
      const previousId = attributeWinnerBySlot.get(slot);
      if (previousId) {
        supersededAttributeIds.add(previousId);
        node.correctionIds = (node.correctionIds || []).filter(id => id !== previousId);
      }
      if (correction.value === null) delete node.attributes[correction.attribute];
      else node.attributes[correction.attribute] = correction.value;
      node.status = 'confirmed';
      node.correctionIds = [...new Set([...(node.correctionIds || []), correction.id])];
      attributeWinnerBySlot.set(slot, correction.id);
    }
    statuses.push({ id: correction.id, type: correction.type, active: Boolean(node), evidenceState: evidenceState(correction, evidenceMap), label: `${correction.attribute}：${correction.value === null ? '已删除' : correction.value}` });
  }

  // Fact decisions are authored against the graph the user actually sees.
  // Resolve aliases first, then match the post-alias semantic endpoints so a
  // decision made after A→B remains bound when the raw index still emits A.
  const factWinnerBySlot = new Map();
  const supersededFactIds = new Set();
  for (const correction of document.corrections.filter(item => item.type === 'decide_fact').sort(compareCorrectionRecency)) {
    const edge = edges.find(item => {
      const from = correctedNodeById.get(item.from);
      const to = correctedNodeById.get(item.to);
      const identityMatches = item.id === correction.edge.id ||
        from?.key === canonicalCorrectionKey(correction.edge.fromKey) &&
        to?.key === canonicalCorrectionKey(correction.edge.toKey);
      return identityMatches && item.relation === correction.edge.relation &&
        (item.property || null) === correction.edge.property && item.source === correction.edge.source;
    });
    if (edge) {
      const slot = `${edge.from}\0${edge.relation}\0${edge.to}\0${edge.source}`;
      const previousId = factWinnerBySlot.get(slot);
      if (previousId) supersededFactIds.add(previousId);
      edge.status = correction.decision;
      edge.correctionId = correction.id;
      edge.correctionIds = [...new Set([...(edge.correctionIds || []), correction.id])].sort(compareText);
      factWinnerBySlot.set(slot, correction.id);
    }
    statuses.push({ id: correction.id, type: correction.type, active: Boolean(edge), evidenceState: evidenceState(correction, evidenceMap), label: correction.decision === 'confirmed' ? '事实已确认' : '事实已否定' });
  }
  // A rejected fact remains visible for audit, but it is not an input to
  // diagnostics. Recompute every issue from the surviving corrected graph so
  // timeline cycles and alias rewrites cannot leave stale or dangling IDs.
  const diagnosticEdges = edges.filter(edge => edge.status !== 'rejected');
  const issues = detectGraphIssues(correctedNodes, diagnosticEdges, graph.evidence || []);
  for (const status of statuses) {
    status.active = status.type === 'decide_fact' ? edges.some(edge => edge.correctionId === status.id)
      : status.type === 'edit_attribute' ? [...attributeWinnerBySlot.values()].includes(status.id)
      : correctedNodes.some(node => (node.correctionIds || []).includes(status.id));
    if (status.type === 'edit_attribute' && supersededAttributeIds.has(status.id)) status.superseded = true;
    if (status.type === 'decide_fact' && supersededFactIds.has(status.id)) status.superseded = true;
  }
  return {
    ...graph,
    nodes: correctedNodes,
    edges,
    issues,
    correctionState: {
      schema: CORRECTIONS_SCHEMA,
      graphIdentity: identity,
      persistenceBlocked: state.persistenceBlocked === true,
      recoveryReason: state.reason || null,
      corrections: statuses.sort((a, b) => compareText(a.id, b.id)),
    },
  };
}

function applyCorrections(rootPath, graph) {
  const loaded = loadCorrections(rootPath);
  return applyCorrectionsDocument(graph, loaded.document, loaded);
}

function submitCorrection(rootPath, graph, command) {
  const loaded = loadCorrections(rootPath);
  if (loaded.persistenceBlocked) fail('CORRECTIONS_PERSISTENCE_BLOCKED', '纠错存储不可用，未修改任何内容');
  assertExactCommand(command);
  if (command.schema !== COMMAND_SCHEMA || !COMMAND_TYPES.has(command.type) || !GRAPH_ID_RE.test(command.graphIdentity || '')) {
    fail('INVALID_COMMAND', '图谱纠错命令无效');
  }
  if (command.graphIdentity !== graphIdentity(graph)) fail('STALE_GRAPH', '图谱已变更，请重新分析后纠错');
  if (command.type === 'remove_correction') {
    if (typeof command.correctionId !== 'string' || !CORRECTION_ID_RE.test(command.correctionId)) fail('INVALID_COMMAND', '纠错记录 ID 无效');
    const kept = loaded.document.corrections.filter(item => item.id !== command.correctionId);
    if (kept.length === loaded.document.corrections.length) fail('CORRECTION_NOT_FOUND', '当前项目不存在该纠错记录');
    const document = saveCorrections(rootPath, {
      schema: CORRECTIONS_SCHEMA,
      graphSchema: GRAPH_SCHEMA,
      updatedAt: new Date().toISOString(),
      corrections: kept,
    });
    return { correction: null, removedCorrectionId: command.correctionId, graph: applyCorrectionsDocument(graph, document) };
  }
  const record = createRecord(graph, command);
  const bySemanticKey = new Map(loaded.document.corrections.map(item => [correctionKey(item), item]));
  const prior = bySemanticKey.get(correctionKey(record));
  if (!prior && loaded.document.corrections.length >= MAX_CORRECTIONS) fail('TOO_MANY_CORRECTIONS', '纠错记录已达上限');
  const latestUpdatedAt = loaded.document.corrections.reduce((latest, item) => Math.max(latest, Date.parse(item.updatedAt)), 0);
  const causalUpdatedAt = new Date(Math.max(Date.now(), latestUpdatedAt + 1)).toISOString();
  if (prior) record.createdAt = prior.createdAt;
  else record.createdAt = causalUpdatedAt;
  record.updatedAt = causalUpdatedAt;
  bySemanticKey.set(correctionKey(record), record);
  assertAliasAcyclic([...bySemanticKey.values()], 'INVALID_COMMAND');
  const document = saveCorrections(rootPath, {
    schema: CORRECTIONS_SCHEMA,
    graphSchema: GRAPH_SCHEMA,
    updatedAt: new Date().toISOString(),
    corrections: [...bySemanticKey.values()],
  });
  return { correction: document.corrections.find(item => item.id === record.id), graph: applyCorrectionsDocument(graph, document) };
}

module.exports = {
  CORRECTIONS_SCHEMA,
  COMMAND_SCHEMA,
  GRAPH_SCHEMA,
  CORRECTIONS_RELATIVE_PATH,
  MAX_FILE_BYTES,
  MAX_CORRECTIONS,
  GraphCorrectionError,
  graphIdentity,
  loadCorrections,
  saveCorrections,
  applyCorrections,
  applyCorrectionsDocument,
  submitCorrection,
};
