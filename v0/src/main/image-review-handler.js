'use strict';

const path = require('path');
const imageReviewServiceModule = require('./image-review-service');

const ASSET_RE = /^assets\/generated\/image-([a-f0-9]{64})\.(?:png|jpg)$/;
const REVISION_RE = /^[a-f0-9]{64}$/;
const REVIEW_TOKEN_RE = /^irv_[a-f0-9]{48}$/;
const REVIEW_DECISIONS = new Set(['inserted', 'kept', 'deleted']);

function fail(code, message) {
  throw new imageReviewServiceModule.ImageReviewError(code, message);
}

function plainDataObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) {
    fail('IMAGE_REVIEW_REQUEST_INVALID', `${label}无效`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(descriptor =>
    !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true)) {
    fail('IMAGE_REVIEW_REQUEST_INVALID', `${label}包含禁止字段`);
  }
  return descriptors;
}

function exactInsertionProof(raw) {
  const descriptors = plainDataObject(raw, '图片插入证明');
  const keys = Object.keys(descriptors).sort();
  if (keys.length !== 2 || keys[0] !== 'revision' || keys[1] !== 'targetPath') {
    fail('IMAGE_REVIEW_PROOF_INVALID', '图片插入证明包含禁止或缺失字段');
  }
  const targetPath = descriptors.targetPath.value;
  const revision = descriptors.revision.value;
  if (typeof targetPath !== 'string' || !targetPath || targetPath.length > 512 ||
      targetPath !== targetPath.normalize('NFC') || targetPath.includes('\\') ||
      path.posix.isAbsolute(targetPath) || /^[A-Za-z]:/.test(targetPath)) {
    fail('IMAGE_REVIEW_PROOF_INVALID', '图片插入目标无效');
  }
  const parts = targetPath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      !/\.(?:md|markdown)$/i.test(parts.at(-1)) ||
      targetPath.toLowerCase() === 'edit.md' ||
      !REVISION_RE.test(revision || '')) {
    fail('IMAGE_REVIEW_PROOF_INVALID', '图片插入证明无效');
  }
  return Object.freeze({ targetPath: parts.join('/'), revision });
}

function reviewIdentity(raw) {
  const descriptors = plainDataObject(raw, '图片审阅请求');
  const token = descriptors.token?.value;
  const decision = descriptors.decision?.value;
  if (!REVIEW_TOKEN_RE.test(token || '') || !REVIEW_DECISIONS.has(decision)) {
    fail('IMAGE_REVIEW_REQUEST_INVALID', '图片审阅身份或决定无效');
  }
  return { token, decision };
}

function safeGeneration(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('IMAGE_REVIEW_STALE', '图片审阅项目状态无效');
  }
  return value;
}

function senderId(event) {
  const value = event?.sender?.id;
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('IMAGE_REVIEW_STALE', '图片审阅窗口已经失效');
  }
  return value;
}

function publicIssue(result) {
  return Object.freeze({
    ok: result.ok === true,
    schema: result.schema,
    token: result.token,
    expiresAt: result.expiresAt,
  });
}

function publicSettlement(result) {
  return Object.freeze({
    ok: result.ok === true,
    schema: result.schema,
    decision: result.decision,
    operationId: result.operationId,
    committed: result.committed === true,
    responseRecovered: result.responseRecovered === true,
  });
}

function createImageReviewHandler(options = {}) {
  const {
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    getNavigationEpoch,
    projectService,
    reviewService,
  } = options;
  for (const [name, value] of Object.entries({
    assertTrustedSender,
    getCurrentProject,
    getMutationGeneration,
    getNavigationEpoch,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!projectService || typeof projectService.readFileWithRevision !== 'function') {
    throw new TypeError('projectService is required');
  }
  if (!reviewService || typeof reviewService.issue !== 'function' ||
      typeof reviewService.settle !== 'function' ||
      typeof reviewService.assertIssueAvailable !== 'function' ||
      typeof reviewService.inspect !== 'function' ||
      typeof reviewService.aggregate !== 'function') {
    throw new TypeError('reviewService is required');
  }

  const issued = new Map();

  function purgeIssued() {
    const current = getCurrentProject();
    const navigationEpoch = safeGeneration(getNavigationEpoch());
    for (const [token, record] of issued) {
      const state = reviewService.inspect(token);
      if (!state || !current ||
          current.instanceId !== record.binding.projectInstanceId ||
          current.rootPath !== record.binding.rootPath ||
          navigationEpoch !== record.binding.navigationEpoch) {
        issued.delete(token);
      }
    }
  }

  function currentProjectFor(projectInstanceId, expectedRoot = null) {
    const current = getCurrentProject();
    if (!current || typeof current.instanceId !== 'string' ||
        typeof current.rootPath !== 'string' ||
        current.instanceId !== projectInstanceId ||
        (expectedRoot !== null && current.rootPath !== expectedRoot)) {
      fail('IMAGE_REVIEW_STALE', '图片审阅不属于当前项目');
    }
    return current;
  }

  function bindingFor(event, project) {
    return Object.freeze({
      webContentsId: senderId(event),
      projectInstanceId: project.instanceId,
      rootPath: project.rootPath,
      mutationGeneration: safeGeneration(getMutationGeneration()),
      navigationEpoch: safeGeneration(getNavigationEpoch()),
    });
  }

  function issue(event, project, operationId, image) {
    assertTrustedSender(event);
    if (!project || typeof project.instanceId !== 'string' ||
        typeof project.rootPath !== 'string') {
      fail('IMAGE_REVIEW_ISSUE_INVALID', '图片审阅项目无效');
    }
    purgeIssued();
    const current = currentProjectFor(project.instanceId, project.rootPath);
    if (current !== project &&
        (current.instanceId !== project.instanceId || current.rootPath !== project.rootPath)) {
      fail('IMAGE_REVIEW_STALE', '图片审阅项目已经变化');
    }
    const imageDescriptors = plainDataObject(image, '生成图片结果');
    const assetPath = imageDescriptors.filePath?.value;
    const assetMatch = typeof assetPath === 'string' ? assetPath.match(ASSET_RE) : null;
    if (!assetMatch) fail('IMAGE_REVIEW_ISSUE_INVALID', '生成图片身份无效');
    const binding = bindingFor(event, current);
    const result = reviewService.issue({
      ...binding,
      operationId,
      assetPath,
      assetDigest: assetMatch[1],
    });
    issued.set(result.token, Object.freeze({
      binding,
      assetPath,
      assetDigest: assetMatch[1],
      expiresAt: result.expiresAt,
    }));
    return publicIssue(result);
  }

  function assertCanIssue(event, project, operationId) {
    assertTrustedSender(event);
    if (!project || typeof project.instanceId !== 'string' ||
        typeof project.rootPath !== 'string') {
      fail('IMAGE_REVIEW_ISSUE_INVALID', '图片审阅项目无效');
    }
    purgeIssued();
    const current = currentProjectFor(project.instanceId, project.rootPath);
    reviewService.assertIssueAvailable(bindingFor(event, current), operationId);
    return true;
  }

  function settle(event, projectInstanceId, review, insertionProof) {
    assertTrustedSender(event);
    purgeIssued();
    const identity = reviewIdentity(review);
    const record = issued.get(identity.token);
    if (!record) fail('IMAGE_REVIEW_STALE', '图片审阅已经过期或不存在');
    const current = currentProjectFor(projectInstanceId, record.binding.rootPath);
    const currentNavigation = safeGeneration(getNavigationEpoch());
    const currentGeneration = safeGeneration(getMutationGeneration());
    const serviceState = reviewService.inspect(identity.token);
    const committedRetry = serviceState?.phase === 'terminal' ||
      serviceState?.phase === 'committed_pending_evidence';
    if (senderId(event) !== record.binding.webContentsId ||
        current.instanceId !== record.binding.projectInstanceId ||
        currentNavigation !== record.binding.navigationEpoch) {
      fail('IMAGE_REVIEW_STALE', '图片审阅不属于当前窗口或项目状态');
    }
    if (identity.decision !== 'inserted' &&
        currentGeneration !== record.binding.mutationGeneration &&
        !committedRetry) {
      fail('IMAGE_REVIEW_STALE', '项目内容已经变化，请重新生成图片');
    }
    if (identity.decision === 'inserted' &&
        currentGeneration < record.binding.mutationGeneration) {
      fail('IMAGE_REVIEW_STALE', '项目内容代际无效');
    }
    if (committedRetry) {
      if (identity.decision !== 'inserted' &&
          insertionProof !== undefined && insertionProof !== null) {
        fail('IMAGE_REVIEW_PROOF_FORBIDDEN', '当前图片决定不接受插入证明');
      }
      return publicSettlement(reviewService.settle(record.binding, review, {}));
    }

    let settlement;
    if (identity.decision === 'inserted') {
      const proof = exactInsertionProof(insertionProof);
      let authoritative;
      try {
        authoritative = projectService.readFileWithRevision(
          current.rootPath,
          proof.targetPath
        );
      } catch (_) {
        fail('IMAGE_REVIEW_PROOF_INVALID', '无法核验图片插入目标');
      }
      if (!authoritative || authoritative.revision !== proof.revision ||
          typeof authoritative.content !== 'string') {
        fail('IMAGE_REVIEW_PROOF_STALE', '图片插入证明已经过期');
      }
      const fromDirectory = path.posix.dirname(proof.targetPath);
      const relativeAssetPath = path.posix.relative(
        fromDirectory === '.' ? '' : fromDirectory,
        record.assetPath
      );
      const escapedAssetPath = relativeAssetPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const imageLink = new RegExp(`!\\[[^\\]\\r\\n]{0,500}\\]\\(${escapedAssetPath}\\)`);
      if (!imageLink.test(authoritative.content)) {
        fail('IMAGE_REVIEW_PROOF_MISSING', '正文中没有找到本次生成图片的引用');
      }
      settlement = {
        commitInserted() {
          return { ok: true, committed: true };
        },
      };
    } else {
      if (insertionProof !== undefined && insertionProof !== null) {
        fail('IMAGE_REVIEW_PROOF_FORBIDDEN', '当前图片决定不接受插入证明');
      }
      settlement = {};
    }
    return publicSettlement(reviewService.settle(record.binding, review, settlement));
  }

  function aggregate(event, projectInstanceId) {
    assertTrustedSender(event);
    purgeIssued();
    const current = currentProjectFor(projectInstanceId);
    return reviewService.aggregate(current.rootPath);
  }

  return Object.freeze({ assertCanIssue, issue, settle, aggregate });
}

module.exports = {
  createImageReviewHandler,
};
