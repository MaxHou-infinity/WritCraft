'use strict';

const defaultHistoryService = require('./change-history-service');
const defaultReviewService = require('./changeset-review-service');
const publicMarkdownPhaseSchema = require('./snapshot-public-markdown-phase-schema');
const {
  createChangesHistoryReconciliationService,
} = require('./changes-history-reconciliation-service');

function failHostileSnapshotInput(message) {
  const error = new Error(message);
  error.code = 'INVALID_SNAPSHOT_RESTORE_INPUT';
  throw error;
}

function descriptorRecord(raw, required, optional, label) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) {
    failHostileSnapshotInput(`${label} must be a plain record`);
  }
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(raw);
  if (keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
      required.some(key => !keys.includes(key))) {
    failHostileSnapshotInput(`${label} keys are invalid`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      failHostileSnapshotInput(`${label}.${key} must be enumerable plain data`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function descriptorLifecycleMethod(raw, name) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      Object.getPrototypeOf(raw) !== Object.prototype) return null;
  const descriptor = Object.getOwnPropertyDescriptor(raw, name);
  if (!descriptor || descriptor.enumerable !== true ||
      !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
      Object.hasOwn(descriptor, 'set') || typeof descriptor.value !== 'function') return null;
  return descriptor.value;
}

function denseSnapshotFiles(raw) {
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) {
    failHostileSnapshotInput('files must be a plain array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  const length = descriptors.length?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 300 ||
      Reflect.ownKeys(raw).length !== length + 1) {
    failHostileSnapshotInput('files must be a dense bounded array');
  }
  const cloneState = (state, label) => {
    const values = descriptorRecord(state, [
      'exists', 'revision', 'contentHash', 'byteLength', 'encoding', 'data',
    ], [], label);
    return Object.freeze({
      exists: values.exists,
      revision: values.revision,
      contentHash: values.contentHash,
      byteLength: values.byteLength,
      encoding: values.encoding,
      data: values.data,
    });
  };
  const files = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || descriptor.enumerable !== true ||
        !Object.hasOwn(descriptor, 'value') || Object.hasOwn(descriptor, 'get') ||
        Object.hasOwn(descriptor, 'set')) {
      failHostileSnapshotInput('files must be dense plain data');
    }
    const values = descriptorRecord(descriptor.value, [
      'path', 'summary', 'before', 'after', 'createdIdentityDigest',
    ], ['ancestorIdentityDigest'], `files[${index}]`);
    files.push(Object.freeze({
      path: values.path,
      summary: values.summary,
      before: cloneState(values.before, `files[${index}].before`),
      after: cloneState(values.after, `files[${index}].after`),
      createdIdentityDigest: values.createdIdentityDigest,
      ...(Object.hasOwn(values, 'ancestorIdentityDigest')
        ? { ancestorIdentityDigest: values.ancestorIdentityDigest }
        : {}),
    }));
  }
  return Object.freeze(files);
}

function cloneSnapshotRestoreArgs(raw) {
  const values = descriptorRecord(raw, [
    'rootPath', 'projectId', 'files', 'provenance',
  ], ['parentSelectionBinding', 'execute', 'options', 'onBegin'], 'snapshot restore args');
  return Object.freeze({
    rootPath: values.rootPath,
    projectId: values.projectId,
    files: denseSnapshotFiles(values.files),
    provenance: values.provenance,
    ...(Object.hasOwn(values, 'parentSelectionBinding')
      ? { parentSelectionBinding: values.parentSelectionBinding }
      : {}),
    ...(Object.hasOwn(values, 'execute') ? { execute: values.execute } : {}),
    ...(Object.hasOwn(values, 'options') ? { options: values.options } : {}),
    ...(Object.hasOwn(values, 'onBegin') ? { onBegin: values.onBegin } : {}),
  });
}

function cloneSnapshotRestoreUndoArgs(raw) {
  const values = descriptorRecord(raw, [
    'rootPath', 'projectId', 'entryId',
  ], ['options', 'onBegin'], 'snapshot restore undo args');
  return Object.freeze({
    rootPath: values.rootPath,
    projectId: values.projectId,
    entryId: values.entryId,
    ...(Object.hasOwn(values, 'options') ? { options: values.options } : {}),
    ...(Object.hasOwn(values, 'onBegin') ? { onBegin: values.onBegin } : {}),
  });
}

function createChangesHistoryTransaction(options = {}) {
  const projectService = options.projectService;
  const historyService = options.historyService || defaultHistoryService;
  const reviewService = options.reviewService || defaultReviewService;
  const publicMarkdownLifecycle = options.publicMarkdownLifecycle || null;
  const existingRestoreLifecycle = options.existingRestoreLifecycle || null;
  const reconciliationService = options.reconciliationService ||
    createChangesHistoryReconciliationService({
      projectService,
      historyService,
      exactArtifactLifecycle: options.exactArtifactLifecycle,
      exactMarkerLifecycle: options.exactMarkerLifecycle,
      publicMarkdownLifecycle,
      existingRestoreLifecycle,
      markerJournalLifecycle: options.markerJournalLifecycle,
      snapshotStateReader: options.snapshotStateReader,
    });
  if (!projectService || typeof projectService.atomicWriteFile !== 'function') {
    throw new TypeError('Changes/History transaction requires ProjectService');
  }

  function prepareApply(args) {
    const historyPrepared = historyService.prepareApplication(
      args.rootPath,
      args.changeSet,
      args.options || {}
    );
    return {
      kind: 'apply',
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyPrepared,
      executeOptions: args.options || {},
      execute() {
        return historyService.executePreparedApplication(
          projectService,
          args.rootPath,
          historyPrepared,
          args.options || {}
        );
      },
    };
  }

  function prepareReview(args) {
    const decisionOptions = {
      ...(args.options || {}),
      historyService,
    };
    const decisionPrepared = reviewService.prepareDecision(
      projectService,
      args.rootPath,
      args.changeSet,
      args.decision,
      decisionOptions
    );
    const writesManuscript = Boolean(decisionPrepared.resolution.acceptedChangeSet);
    return {
      // A decision containing accepted hunks is an application transaction:
      // files and History must both reach the prepared state before authority
      // can call it committed. Reject-only decisions remain History-only.
      kind: writesManuscript ? 'apply' : 'review',
      decisionOperation: true,
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyPrepared: decisionPrepared.historyPrepared,
      decisionPrepared,
      executeOptions: decisionOptions,
      execute() {
        return reviewService.executePreparedDecision(
          projectService,
          args.rootPath,
          decisionPrepared,
          decisionOptions
        );
      },
    };
  }

  function prepareUndo(args) {
    const historyPrepared = historyService.prepareUndo(
      projectService,
      args.rootPath,
      args.entryId
    );
    if (historyPrepared?.ok === false) return historyPrepared;
    return {
      kind: 'undo',
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyPrepared,
      executeOptions: args.options || {},
      execute() {
        return historyService.executePreparedUndo(
          projectService,
          args.rootPath,
          historyPrepared,
          args.options || {}
        );
      },
    };
  }

  function requireSnapshotExecutor(args, kind) {
    if (typeof args.execute !== 'function') {
      const error = new Error(`${kind} requires a Main-owned exact-identity executor`);
      error.code = 'SNAPSHOT_RESTORE_EXECUTOR_REQUIRED';
      throw error;
    }
    return args.execute;
  }

  function requirePublicMarkdownLifecycle(rootPath, kind, parentSelectionBinding) {
    const parent = publicMarkdownPhaseSchema.assertParentSelectionBinding(parentSelectionBinding);
    if (parent.kind !== kind) {
      const error = new Error('public Markdown selection kind does not match transaction');
      error.code = 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT';
      throw error;
    }
    const factory = descriptorLifecycleMethod(publicMarkdownLifecycle, 'forProject');
    const scoped = factory ? factory(rootPath) : publicMarkdownLifecycle;
    const methods = kind === 'snapshot_restore'
      ? [
        'create', 'createMissingJournal', 'reconcile', 'verifyCreate',
        'finalizeCreate', 'reconcileFinalize',
      ]
      : ['quarantine', 'restoreQuarantine', 'finalizeUndo', 'ackUndo', 'reconcileUndo'];
    if (!scoped || methods.some(method => descriptorLifecycleMethod(scoped, method) === null)) {
      const error = new Error('native public Markdown lifecycle is unavailable');
      error.code = 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE';
      throw error;
    }
    return Object.freeze({ parent, lifecycle: scoped });
  }

  function requireExistingRestoreLifecycle(rootPath, parentSelectionBinding) {
    const parent = publicMarkdownPhaseSchema.assertParentSelectionBinding(parentSelectionBinding);
    if (parent.kind !== 'snapshot_restore') {
      const error = new Error('existing restore selection kind does not match transaction');
      error.code = 'PUBLIC_MARKDOWN_AUTHORITY_CONFLICT';
      throw error;
    }
    const factory = descriptorLifecycleMethod(existingRestoreLifecycle, 'forProject');
    const scoped = factory ? factory(rootPath) : existingRestoreLifecycle;
    const methods = ['execute', 'reconcile', 'verify', 'finalize', 'reconcileFinalize'];
    if (!scoped || methods.some(method => descriptorLifecycleMethod(scoped, method) === null)) {
      const error = new Error('formal existing Markdown lifecycle is unavailable');
      error.code = 'SNAPSHOT_RESTORE_EXISTING_LIFECYCLE_UNAVAILABLE';
      throw error;
    }
    return Object.freeze({ parent, lifecycle: scoped });
  }

  function snapshotRecoveryFiles(files, invert = false) {
    return files.map(file => ({
      path: file.path,
      before: invert ? file.after : file.before,
      after: invert ? file.before : file.after,
      createdIdentityDigest: file.createdIdentityDigest,
    }));
  }

  function snapshotHistoryFiles(files, provenance, parent, kind) {
    const validProvenance = historyService.validateProvenance(provenance);
    if (validProvenance?.schema !== historyService.SNAPSHOT_RESTORE_PROVENANCE_SCHEMA ||
        validProvenance.selectedIds.length !== files.length ||
        parent.selected.length !== files.length || parent.kind !== kind) {
      failHostileSnapshotInput('snapshot History parent authority does not match selection');
    }
    return Object.freeze(files.map((file, index) => {
      const selected = parent.selected[index];
      const expectedAction = kind === 'snapshot_restore'
        ? (file.before.exists === false ? 'MISSING' : 'EXISTING')
        : (file.before.exists === false ? 'CREATED' : 'EXISTING');
      if (validProvenance.selectedIds[index] !== selected.selectedId ||
          file.path !== selected.path || file.after.revision !== selected.revision ||
          selected.action !== expectedAction ||
          (kind === 'snapshot_restore_undo' &&
           file.ancestorIdentityDigest !== selected.ancestorIdentityDigest)) {
        failHostileSnapshotInput('snapshot History file authority does not match parent selection');
      }
      return Object.freeze({
        ...file,
        ancestorIdentityDigest: selected.ancestorIdentityDigest,
      });
    }));
  }

  function prepareSnapshotRestore(args) {
    args = cloneSnapshotRestoreArgs(args);
    if (args.files.some(file => file.createdIdentityDigest !== null)) {
      failHostileSnapshotInput(
        'pre-native snapshot restore cannot assert a created Markdown identity'
      );
    }
    const missingLeaves = args.files.filter(file => file.before.exists === false);
    const needsPublicMarkdownPhase = missingLeaves.length > 0;
    const mixedRestore = needsPublicMarkdownPhase && missingLeaves.length !== args.files.length;
    const parentSelectionBinding = args.parentSelectionBinding === undefined
      ? null
      : publicMarkdownPhaseSchema.assertParentSelectionBinding(args.parentSelectionBinding);
    if (parentSelectionBinding !== null && parentSelectionBinding.kind !== 'snapshot_restore') {
      failHostileSnapshotInput('snapshot restore parent kind is invalid');
    }
    if (needsPublicMarkdownPhase && parentSelectionBinding === null) {
      failHostileSnapshotInput('snapshot restore parent selection is required');
    }
    let existingRestoreAuthority = null;
    if (mixedRestore) {
      existingRestoreAuthority = requireExistingRestoreLifecycle(
        args.rootPath,
        parentSelectionBinding
      );
    }
    const historyFiles = parentSelectionBinding === null
      ? args.files.map(file => Object.freeze({ ...file }))
      : snapshotHistoryFiles(
        args.files,
        args.provenance,
        parentSelectionBinding,
        'snapshot_restore'
      );
    let publicMarkdownAuthority = null;
    if (needsPublicMarkdownPhase) {
      // Gate and validate the complete parent selection before History
      // preparation. createdIdentityDigest may only be materialized from a
      // durable native CREATE receipt after the PRECREATE marker exists.
      publicMarkdownAuthority = requirePublicMarkdownLifecycle(
        args.rootPath,
        'snapshot_restore',
        parentSelectionBinding
      );
    }
    const executeMutation = needsPublicMarkdownPhase
      ? null
      : requireSnapshotExecutor(args, 'snapshot_restore');
    const historyPrepared = needsPublicMarkdownPhase
      ? historyService.prepareSnapshotRestoreHistoryTemplate(
        args.rootPath,
        historyFiles,
        args.provenance,
        args.options || {}
      )
      : historyService.prepareSnapshotRestoreHistory(
        args.rootPath,
        historyFiles,
        args.provenance,
        args.options || {}
      );
    const recoveryFiles = snapshotRecoveryFiles(
      needsPublicMarkdownPhase ? historyPrepared.files : historyPrepared.record.files
    );
    const historyEntryId = needsPublicMarkdownPhase
      ? historyPrepared.historyTemplate.id
      : historyPrepared.record.id;
    return Object.freeze({
      kind: 'snapshot_restore',
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyEntryId,
      historyPrepared,
      recoveryFiles,
      ...(needsPublicMarkdownPhase ? {
        publicMarkdownPhaseMode: true,
        parentSelectionBinding: publicMarkdownAuthority.parent,
        publicMarkdownLifecycle: publicMarkdownAuthority.lifecycle,
        ...(mixedRestore ? {
          mixedRestoreMode: true,
          existingRestoreLifecycle: existingRestoreAuthority.lifecycle,
        } : {}),
      } : {}),
      executeOptions: args.options || {},
      execute() {
        if (needsPublicMarkdownPhase) {
          const error = new Error('public Markdown phase must start from PRECREATE');
          error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
          throw error;
        }
        return executeMutation(Object.freeze({
          kind: 'snapshot_restore',
          rootPath: args.rootPath,
          projectId: args.projectId,
          files: recoveryFiles,
          historyPrepared,
        }));
      },
    });
  }

  function preparePublicMarkdownMarker(prepared) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true ||
        prepared.kind !== 'snapshot_restore') {
      const error = new Error('public Markdown PRECREATE transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.prepare(prepared.rootPath, {
      projectId: prepared.projectId,
      kind: prepared.kind,
      files: prepared.recoveryFiles,
      baseHistoryState: prepared.historyPrepared.baseHistoryState,
      preparedHistoryState: null,
      historyTemplate: prepared.historyPrepared.historyTemplate,
      parentSelectionBinding: prepared.parentSelectionBinding,
    });
  }

  function createMissingLeaves(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        marker.kind !== 'snapshot_restore') {
      const error = new Error('public Markdown CREATE transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.createMissingLeaves(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
  }

  function commitExistingRestore(prepared, marker) {
    if (!prepared || prepared.mixedRestoreMode !== true ||
        prepared.kind !== 'snapshot_restore' || !marker ||
        marker.kind !== 'snapshot_restore' ||
        marker.publicMarkdownPhase?.phase !== 'CREATED_RECEIPT') {
      const error = new Error('mixed EXISTING transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    const execute = descriptorLifecycleMethod(
      reconciliationService,
      'executeExistingRestore'
    );
    if (execute === null) {
      const error = new Error('mixed EXISTING journal CAS is unavailable');
      error.code = 'SNAPSHOT_RESTORE_EXISTING_LIFECYCLE_UNAVAILABLE';
      throw error;
    }
    return execute(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
  }

  function commitMissingRestoreHistory(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        marker.kind !== 'snapshot_restore') {
      const error = new Error('public Markdown History transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.commitMissingRestoreHistory(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
  }

  function finalizeMissingRestore(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        marker.kind !== 'snapshot_restore') {
      const error = new Error('public Markdown FINALIZE transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.finalizeMissingRestore(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
  }

  function executeMissingSnapshotRestore(prepared) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true ||
        prepared.kind !== 'snapshot_restore') {
      const error = new Error('public Markdown restore transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    let marker = preparePublicMarkdownMarker(prepared);
    let responseRecovered = false;
    let directError = null;

    const advanceWithoutCreateReplay = () => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const phase = marker.publicMarkdownPhase?.phase;
        if (phase === 'PRECREATE') {
          const beforeIntegrity = marker.integrity;
          reconciliationService.query(prepared.rootPath, prepared.projectId);
          marker = reconciliationService.readMarker(prepared.rootPath);
          if (!marker || marker.publicMarkdownPhase?.phase !== 'PRECREATE') continue;
          if (marker.integrity === beforeIntegrity) {
            const error = new Error('CREATE result is not durably reconcilable');
            error.code = 'CHANGES_MANUAL_RECOVERY_REQUIRED';
            throw error;
          }
          continue;
        }
        if (phase === 'CREATED_RECEIPT') {
          marker = commitMissingRestoreHistory(prepared, marker);
          continue;
        }
        if (phase === 'HISTORY_COMMITTED') {
          marker = finalizeMissingRestore(prepared, marker);
          continue;
        }
        if (phase === 'FINALIZED') {
          marker = reconciliationService.finish(
            prepared.rootPath,
            marker.operationId
          );
          if (marker.state !== 'terminal' || marker.outcome !== 'applied') {
            const error = new Error('FINALIZED restore is not terminal');
            error.code = 'CHANGES_MANUAL_RECOVERY_REQUIRED';
            throw error;
          }
          reconciliationService.clear(
            prepared.rootPath,
            prepared.projectId,
            marker.operationId
          );
          return marker;
        }
        const error = new Error('public Markdown restore phase is invalid');
        error.code = 'CHANGES_MANUAL_RECOVERY_REQUIRED';
        throw error;
      }
      const error = new Error('public Markdown restore did not converge');
      error.code = 'CHANGES_MANUAL_RECOVERY_REQUIRED';
      throw error;
    };

    try {
      marker = createMissingLeaves(prepared, marker);
      marker = commitMissingRestoreHistory(prepared, marker);
      marker = finalizeMissingRestore(prepared, marker);
      marker = advanceWithoutCreateReplay();
    } catch (error) {
      directError = error;
      responseRecovered = true;
      try {
        const current = reconciliationService.readMarker(prepared.rootPath);
        if (!current || current.operationId !== marker.operationId) throw error;
        marker = current;
        marker = advanceWithoutCreateReplay();
      } catch (reconcileError) {
        reconcileError.cause ||= directError;
        throw reconcileError;
      }
    }
    return resultFromAuthority(prepared, marker, responseRecovered
      ? {
        ok: true,
        status: 'applied',
        responseRecovered: true,
        residualUnavailable: false,
        confirmationUnavailable: true,
      }
      : { ok: true, status: 'applied' }, null);
  }

  function prepareSnapshotRestoreUndo(args) {
    args = cloneSnapshotRestoreUndoArgs(args);
    const historyPrepared = historyService.prepareSnapshotRestoreUndoHistory(
      args.rootPath,
      args.entryId,
      args.options || {}
    );
    const provenance = historyPrepared.record.provenance;
    const parentSelectionBinding = publicMarkdownPhaseSchema.assertParentSelectionBinding({
      schema: publicMarkdownPhaseSchema.SELECTION_SCHEMA,
      kind: 'snapshot_restore_undo',
      selected: historyPrepared.record.files.map((file, index) => ({
        selectedId: provenance.selectedIds[index],
        action: file.before.exists === false ? 'CREATED' : 'EXISTING',
        path: file.path,
        revision: file.after.revision,
        ancestorIdentityDigest: file.ancestorIdentityDigest,
      })),
    });
    const publicMarkdownAuthority = requirePublicMarkdownLifecycle(
      args.rootPath,
      'snapshot_restore_undo',
      parentSelectionBinding
    );
    const appliedFiles = snapshotHistoryFiles(
      historyPrepared.record.files,
      historyPrepared.record.provenance,
      publicMarkdownAuthority.parent,
      'snapshot_restore_undo'
    );
    const created = appliedFiles.filter(file => file.before.exists === false);
    if (!created.length || created.some(file => file.createdIdentityDigest === null)) {
      failHostileSnapshotInput('Safe Undo requires complete CREATED History authority');
    }
    return Object.freeze({
      kind: 'snapshot_restore_undo',
      rootPath: args.rootPath,
      projectId: args.projectId,
      historyEntryId: args.entryId,
      historyPrepared,
      historyTemplate: historyPrepared.historyTemplate,
      recoveryFiles: Object.freeze(snapshotRecoveryFiles(appliedFiles, true)),
      publicMarkdownPhaseMode: true,
      parentSelectionBinding: publicMarkdownAuthority.parent,
      publicMarkdownLifecycle: publicMarkdownAuthority.lifecycle,
      executeOptions: args.options || {},
    });
  }

  function preparePublicMarkdownUndoMarker(prepared) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true ||
        prepared.kind !== 'snapshot_restore_undo') {
      const error = new Error('Safe Undo PRECREATE transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.prepare(prepared.rootPath, {
      projectId: prepared.projectId,
      kind: prepared.kind,
      files: prepared.recoveryFiles,
      baseHistoryState: prepared.historyPrepared.baseHistoryState,
      preparedHistoryState: prepared.historyPrepared.preparedHistoryState,
      historyTemplate: prepared.historyTemplate,
      parentSelectionBinding: prepared.parentSelectionBinding,
    });
  }

  function quarantineSnapshotRestoreUndo(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        marker.kind !== 'snapshot_restore_undo') {
      const error = new Error('Safe Undo quarantine transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.quarantineSnapshotRestoreUndo(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
  }

  function restoreSnapshotRestoreUndo(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        prepared.kind !== 'snapshot_restore_undo' ||
        marker.kind !== 'snapshot_restore_undo' ||
        marker.publicMarkdownPhase?.phase !== 'QUARANTINED') {
      const error = new Error('Safe Undo B transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    const restored = reconciliationService.restoreSnapshotRestoreUndo(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
    if (restored.publicMarkdownPhase?.phase !== 'RESTORED') {
      const error = new Error('Safe Undo B did not reach RESTORED');
      error.code = 'CHANGES_MANUAL_RECOVERY_REQUIRED';
      throw error;
    }
    const terminal = reconciliationService.finish(
      prepared.rootPath,
      marker.operationId
    );
    reconciliationService.clear(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
    return terminal;
  }

  function commitSnapshotRestoreUndoHistory(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        prepared.kind !== 'snapshot_restore_undo' ||
        marker.kind !== 'snapshot_restore_undo' ||
        marker.publicMarkdownPhase?.phase !== 'QUARANTINED' ||
        marker.publicMarkdownUndoSettlement !== undefined) {
      const error = new Error('Safe Undo History transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    return reconciliationService.commitSnapshotRestoreUndoHistory(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
  }

  function finalizeSnapshotRestoreUndo(prepared, marker) {
    if (!prepared || prepared.publicMarkdownPhaseMode !== true || !marker ||
        prepared.kind !== 'snapshot_restore_undo' ||
        marker.kind !== 'snapshot_restore_undo' ||
        !['HISTORY_COMMITTED', 'FINALIZED'].includes(
          marker.publicMarkdownPhase?.phase
        ) || marker.publicMarkdownUndoSettlement !== undefined) {
      const error = new Error('Safe Undo finalization transaction is invalid');
      error.code = 'PUBLIC_MARKDOWN_PHASE_REQUIRED';
      throw error;
    }
    const finalized = reconciliationService.finalizeSnapshotRestoreUndo(
      prepared.rootPath,
      prepared.projectId,
      marker.operationId
    );
    const terminal = reconciliationService.finish(
      prepared.rootPath,
      finalized.operationId
    );
    if (terminal.state !== 'terminal' || terminal.outcome !== 'undone' ||
        terminal.publicMarkdownPhase?.phase !== 'FINALIZED') {
      const error = new Error('Safe Undo FINALIZED authority is not terminal');
      error.code = 'CHANGES_MANUAL_RECOVERY_REQUIRED';
      throw error;
    }
    reconciliationService.clear(
      prepared.rootPath,
      prepared.projectId,
      terminal.operationId
    );
    return terminal;
  }

  function resultFromAuthority(prepared, marker, executionResult, executionError) {
    const base = {
      operationId: marker.operationId,
      outcome: marker.outcome,
      affectedPaths: marker.files.map(file => file.path),
      recoveryRequired: ['committed_warning', 'manual_recovery'].includes(marker.outcome),
    };
    if (['applied', 'reviewed', 'undone'].includes(marker.outcome)) {
      if (executionResult?.ok === true) {
        return {
          ...executionResult,
          ...base,
          ok: true,
          status: executionResult.status || marker.outcome,
        };
      }
      return {
        ...base,
        ok: true,
        status: marker.outcome,
        responseRecovered: true,
        residualUnavailable: prepared.decisionOperation === true,
        confirmationUnavailable: true,
      };
    }
    if (marker.outcome === 'committed_warning') {
      return {
        ...base,
        ok: true,
        status: 'committed_warning',
        warning: true,
        residualUnavailable: prepared.decisionOperation === true,
        confirmationUnavailable: true,
      };
    }
    return {
      ...base,
      ok: false,
      status: marker.outcome,
      consumed: true,
      retryable: false,
      ...(executionError ? { error: executionError } : {}),
      ...(executionResult?.error && !executionError ? { error: executionResult.error } : {}),
    };
  }

  function execute(prepared, hooks = {}) {
    if (!prepared || prepared.ok === false) return prepared;
    const marker = reconciliationService.prepare(prepared.rootPath, {
      projectId: prepared.projectId,
      kind: prepared.kind,
      files: prepared.recoveryFiles || prepared.historyPrepared.files,
      baseHistoryState: prepared.historyPrepared.baseHistoryState,
      preparedHistoryState: prepared.historyPrepared.preparedHistoryState,
    });
    let executionResult = null;
    let executionError = null;
    try {
      // The caller isolates/deletes its one-time capability here. A failure is
      // classified from untouched disk/History and still leaves a terminal
      // marker, so a missing response can never replay the original token.
      if (typeof hooks.onBegin === 'function') hooks.onBegin({
        operationId: marker.operationId,
        projectId: marker.projectId,
        kind: marker.kind,
      });
      executionResult = prepared.execute();
    } catch (error) {
      executionError = error;
    }
    const classified = reconciliationService.finish(prepared.rootPath, marker.operationId);
    return resultFromAuthority(prepared, classified, executionResult, executionError);
  }

  function apply(args) {
    return execute(prepareApply(args), { onBegin: args.onBegin });
  }

  function review(args) {
    return execute(prepareReview(args), { onBegin: args.onBegin });
  }

  function undo(args) {
    const prepared = prepareUndo(args);
    return prepared?.ok === false
      ? prepared
      : execute(prepared, { onBegin: args.onBegin });
  }

  function snapshotRestore(args) {
    return execute(prepareSnapshotRestore(args), { onBegin: args.onBegin });
  }

  function snapshotRestoreUndo(args) {
    return execute(prepareSnapshotRestoreUndo(args), { onBegin: args.onBegin });
  }

  return Object.freeze({
    prepareApply,
    prepareReview,
    prepareUndo,
    prepareSnapshotRestore,
    prepareSnapshotRestoreUndo,
    preparePublicMarkdownUndoMarker,
    quarantineSnapshotRestoreUndo,
    commitSnapshotRestoreUndoHistory,
    finalizeSnapshotRestoreUndo,
    restoreSnapshotRestoreUndo,
    preparePublicMarkdownMarker,
    createMissingLeaves,
    commitExistingRestore,
    commitMissingRestoreHistory,
    finalizeMissingRestore,
    executeMissingSnapshotRestore,
    execute,
    apply,
    review,
    undo,
    snapshotRestore,
    snapshotRestoreUndo,
    reconciliation: reconciliationService,
  });
}

module.exports = {
  createChangesHistoryTransaction,
};
