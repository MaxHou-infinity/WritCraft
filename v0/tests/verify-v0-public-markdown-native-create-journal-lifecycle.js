#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const evidence = require('../src/main/evidence-delivery-schema');
const journal = require('../src/main/changes-history-marker-journal-schema');
const schema = require('../src/main/public-markdown-native-schema');
const lifecycle = require('../src/main/public-markdown-native-lifecycle');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-create-journal-native-'));
const source = path.join(__dirname, '..', 'native', 'public-markdown-create-helper.c');
const helper = path.join(scratch, 'public-markdown-create-helper');
const compileHelper = (output, definitions = []) => childProcess.execFileSync('xcrun', [
  '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
  '-mmacosx-version-min=11.0', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
  '-Wframe-larger-than=2097152', ...definitions.map(value => `-D${value}`), source, '-o', output,
]);
compileHelper(helper);

const digest = value => `sha256:${String(value).repeat(64)}`;
const operationId = `chr_${'a'.repeat(48)}`;
const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'project-')));
const recovery = path.join(rootPath, '.writcraft', 'recovery');
fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
fs.chmodSync(path.join(rootPath, '.writcraft'), 0o700);
fs.chmodSync(recovery, 0o700);
const artifactBytes = Buffer.from('hello journal\n');
const artifactPath = path.join(recovery, 'artifact.bin');
fs.writeFileSync(artifactPath, artifactBytes, { flag: 'wx', mode: 0o600 });
fs.chmodSync(artifactPath, 0o600);
const artifactFd = fs.openSync(artifactPath, fs.constants.O_RDONLY);
const artifactStat = fs.fstatSync(artifactFd, { bigint: true });
const objectIdentity = (stat, contentSha256, nlink = Number(stat.nlink)) => ({
  schema: evidence.SCHEMAS.OBJECT_IDENTITY,
  dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
  mode: Number(stat.mode & 0o7777n), nlink, size: stat.size.toString(),
  mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString(), contentSha256,
});
const artifactDigest = evidence.sha256(artifactBytes);
const request = {
  schema: schema.SCHEMAS.CREATE_REQUEST,
  operationId,
  artifactDigest,
  artifactIdentityDigest: evidence.digestObjectIdentity(objectIdentity(artifactStat, artifactDigest)),
  artifactByteLength: artifactBytes.length,
  precreatePhaseDigest: digest(3),
  selectionDigest: digest(4),
  items: [{
    selectedId: 'missing:1', path: 'chapter.md', artifactOffset: 0,
    byteLength: artifactBytes.length, contentDigest: artifactDigest,
    ancestorIdentityDigest: evidence.digestAncestorIdentity({
      schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
      components: [],
    }),
  }],
};
const prepared = schema.buildLatchedCreatePublication(request);
const activeMarker = {
  schema: 'writcraft.changes-history-recovery/v1', operationId,
  projectId: 'project-create-journal', kind: 'snapshot_restore', state: 'applying',
  outcome: null, files: [], baseHistoryState: { exists: true, digest: '1'.repeat(64) },
  preparedHistoryState: { exists: true, digest: '2'.repeat(64) },
  recoveryWritePending: false, createdAt: '2026-08-10T00:00:00.000Z',
  updatedAt: '2026-08-10T00:00:01.000Z', integrity: '3'.repeat(64),
};
const base = {
  schema: journal.SCHEMAS.VALUE, journalId: `chrj_${'d'.repeat(48)}`, generation: '0',
  previousValueDigest: null, state: 'IDLE', projectId: activeMarker.projectId,
  activeOperationId: null,
  activeKind: null, activeMarker: null, activeMarkerDigest: null, nativePublication: null,
  existingTerminalPublication: null, rollbackCreatePublication: null,
  terminalCleanup: null, terminalCleanupDigest: null, valueDigest: null,
};
base.valueDigest = journal.valueDigest(base);
const baseValue = journal.assertJournalValue(base);
const active = {
  ...baseValue, generation: '1', previousValueDigest: baseValue.valueDigest,
  state: 'ACTIVE', projectId: activeMarker.projectId, activeOperationId: operationId,
  activeKind: 'snapshot_restore', activeMarker,
  activeMarkerDigest: journal.activeMarkerDigest(activeMarker), nativePublication: prepared,
  valueDigest: null,
};
active.valueDigest = journal.valueDigest(active);
const activeValue = journal.assertJournalValue(active);
const journalFd = fs.openSync(path.join(recovery, journal.JOURNAL_BASENAME), 'wx+', 0o600);
fs.writeSync(journalFd, journal.encodeSlotFrame(baseValue, 'A'), 0, undefined, journal.SLOT_OFFSETS.A);
fs.writeSync(journalFd, journal.encodeSlotFrame(activeValue, 'B'), 0, undefined, journal.SLOT_OFFSETS.B);
fs.fsyncSync(journalFd);
fs.closeSync(journalFd);
const authority = schema.buildCreateJournalAuthority(request, activeValue);
const rootStat = fs.statSync(rootPath, { bigint: true });
const recoveryStat = fs.statSync(recovery, { bigint: true });
const rootIdentity = stat => ({
  schema: evidence.SCHEMAS.ROOT_IDENTITY,
  dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
  mode: Number(stat.mode & 0o7777n),
});
const rootBind = schema.encodeRootBind(schema.assertRootBind({
  schema: schema.SCHEMAS.ROOT_BIND,
  canonicalRoot: rootPath,
  expectedRootIdentityDigest: evidence.digestRootIdentity(rootIdentity(rootStat)),
  expectedRecoveryIdentityDigest: evidence.digestRootIdentity(rootIdentity(recoveryStat)),
}));
const commandWire = schema.encodeCreateMissingJournalCommand(
  authority, request, activeValue
);
const resignHeadWire = changes => {
  const lines = commandWire.trimEnd().split('\n');
  const fields = lines[0].split('\t');
  const binding = {
    ...authority.journalPhysicalBinding,
    slot: changes.slot ?? authority.journalPhysicalBinding.slot,
    head: {
      ...authority.journalPhysicalBinding.head,
      journalId: changes.journalId ?? authority.journalPhysicalBinding.head.journalId,
    },
    frameByteLength: changes.frame?.length ?? authority.journalPhysicalBinding.frameByteLength,
    frameSha256: changes.frame
      ? evidence.sha256(changes.frame)
      : authority.journalPhysicalBinding.frameSha256,
  };
  const bindingDigest = evidence.digestObject(
    schema.SCHEMAS.CREATE_JOURNAL_PHYSICAL_BINDING, binding
  );
  const slicesDigest = evidence.digestObject(
    schema.SCHEMAS.CREATE_CURRENT_PAYLOAD_SLICES,
    authority.currentPayloadSlices
  );
  const token = {
    schema: schema.SCHEMAS.CREATE_JOURNAL_COMMAND_TOKEN,
    command: 'CREATE_MISSING',
    operationId,
    requestDigest: authority.requestDigest,
    preparedPublicationDigest: authority.preparedPublication.publicationDigest,
    bindingDigest,
    currentPayloadSlicesDigest: slicesDigest,
    commandDigest: null,
  };
  token.commandDigest = evidence.digestObject(
    schema.SCHEMAS.CREATE_JOURNAL_COMMAND_TOKEN, token, 'commandDigest'
  );
  fields[2] = token.commandDigest;
  fields[8] = bindingDigest;
  fields[9] = binding.slot;
  fields[10] = binding.head.journalId;
  fields[13] = String(binding.frameByteLength);
  fields[14] = binding.frameSha256;
  return [fields.join('\t'), ...lines.slice(1)].join('\n') + '\n';
};
const invokeRaw = wire => {
  const trusted = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    return childProcess.spawnSync(helper, [], {
      input: `${rootBind}${wire}`,
      maxBuffer: schema.LIMITS.maxCreateJournalResponseBytes,
      stdio: ['pipe', 'pipe', 'pipe', trusted, artifactFd],
    });
  } finally {
    fs.closeSync(trusted);
  }
};
const pauseFixture = (label, itemCount = 1) => {
  const pauseRoot = fs.realpathSync(fs.mkdtempSync(path.join(scratch, `pause-${label}-`)));
  const pauseRecovery = path.join(pauseRoot, '.writcraft', 'recovery');
  fs.mkdirSync(pauseRecovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(pauseRoot, '.writcraft'), 0o700);
  fs.chmodSync(pauseRecovery, 0o700);
  const itemBytes = Array.from({ length: itemCount }, (_, index) =>
    Buffer.from(`guard ${label} item ${index}\n`));
  const bytes = Buffer.concat(itemBytes);
  const pauseArtifact = path.join(pauseRecovery, 'artifact.bin');
  fs.writeFileSync(pauseArtifact, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(pauseArtifact, 0o600);
  const pauseArtifactFd = fs.openSync(pauseArtifact, fs.constants.O_RDONLY);
  const artifactIdentity = objectIdentity(
    fs.fstatSync(pauseArtifactFd, { bigint: true }), evidence.sha256(bytes)
  );
  const pauseOperation = `chr_${crypto.randomBytes(24).toString('hex')}`;
  const pauseRequest = {
    ...request,
    operationId: pauseOperation,
    artifactDigest: evidence.sha256(bytes),
    artifactIdentityDigest: evidence.digestObjectIdentity(artifactIdentity),
    artifactByteLength: bytes.length,
    items: itemBytes.map((content, index) => ({
      ...request.items[0], selectedId: `missing:${label}:${index}`,
      path: itemCount === 1 ? 'created.md' : `created-${index}.md`,
      artifactOffset: itemBytes.slice(0, index).reduce((sum, item) => sum + item.length, 0),
      byteLength: content.length, contentDigest: evidence.sha256(content),
    })),
  };
  const pauseMarker = {
    ...activeMarker, operationId: pauseOperation, projectId: `project-${label}`,
  };
  const pauseBase = {
    ...baseValue, journalId: `chrj_${crypto.randomBytes(24).toString('hex')}`,
    projectId: pauseMarker.projectId, valueDigest: null,
  };
  pauseBase.valueDigest = journal.valueDigest(pauseBase);
  const validBase = journal.assertJournalValue(pauseBase);
  const pauseActive = {
    ...validBase, generation: '1', previousValueDigest: validBase.valueDigest,
    state: 'ACTIVE', activeOperationId: pauseOperation, activeKind: 'snapshot_restore',
    activeMarker: pauseMarker, activeMarkerDigest: journal.activeMarkerDigest(pauseMarker),
    nativePublication: schema.buildLatchedCreatePublication(pauseRequest), valueDigest: null,
  };
  pauseActive.valueDigest = journal.valueDigest(pauseActive);
  const validActive = journal.assertJournalValue(pauseActive);
  const pauseJournal = path.join(pauseRecovery, journal.JOURNAL_BASENAME);
  const baseFrameForPause = journal.encodeSlotFrame(validBase, 'A');
  const activeFrameForPause = journal.encodeSlotFrame(validActive, 'B');
  const pauseJournalFd = fs.openSync(pauseJournal, 'wx+', 0o600);
  fs.writeSync(pauseJournalFd, baseFrameForPause, 0, baseFrameForPause.length, journal.SLOT_OFFSETS.A);
  fs.writeSync(pauseJournalFd, activeFrameForPause, 0, activeFrameForPause.length, journal.SLOT_OFFSETS.B);
  fs.fsyncSync(pauseJournalFd);
  fs.closeSync(pauseJournalFd);
  const pauseAuthority = schema.buildCreateJournalAuthority(
    pauseRequest, validActive
  );
  const pauseRootStat = fs.statSync(pauseRoot, { bigint: true });
  const pauseRecoveryStat = fs.statSync(pauseRecovery, { bigint: true });
  const pauseRootBind = schema.encodeRootBind(schema.assertRootBind({
    schema: schema.SCHEMAS.ROOT_BIND, canonicalRoot: pauseRoot,
    expectedRootIdentityDigest: evidence.digestRootIdentity(rootIdentity(pauseRootStat)),
    expectedRecoveryIdentityDigest: evidence.digestRootIdentity(rootIdentity(pauseRecoveryStat)),
  }));
  const newer = {
    ...validActive, generation: '2', previousValueDigest: validActive.valueDigest,
    valueDigest: null,
  };
  newer.valueDigest = journal.valueDigest(newer);
  return {
    rootPath: pauseRoot, recovery: pauseRecovery, bytes, itemBytes,
    request: pauseRequest, authority: pauseAuthority, activeValue: validActive,
    input: pauseRootBind + schema.encodeCreateMissingJournalCommand(
      pauseAuthority, pauseRequest, validActive
    ),
    artifactFd: pauseArtifactFd,
    newerFrame: journal.encodeSlotFrame(journal.assertJournalValue(newer), 'A'),
  };
};
const runPausedJournal = ({ helperPath, fixture, syncName, mutation, recordName = '-' }) => {
  const driver = String.raw`
    const childProcess = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const [helperPath, rootPath, input64, syncRoot, syncName, mutation, frame64,
      recordName] =
      process.argv.slice(1);
    fs.mkdirSync(syncRoot, { recursive: true, mode: 0o700 });
    const trusted = fs.openSync('/', fs.constants.O_RDONLY);
    const child = childProcess.spawn(helperPath, [], {
      stdio: ['pipe', 'pipe', 'pipe', trusted, 3],
      env: { ...process.env, WRITCRAFT_TEST_SYNC_DIR: syncRoot },
    });
    fs.closeSync(trusted);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    let closedResult = null;
    const closed = new Promise(resolve => child.on('close', (status, signal) => {
      closedResult = { status, signal, stdout, stderr };
      resolve(closedResult);
    }));
    child.stdin.end(Buffer.from(input64, 'base64'));
    const ready = path.join(syncRoot, syncName + '.ready');
    (async () => {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(ready)) {
        if (closedResult) throw new Error('helper closed before pause: ' + JSON.stringify(closedResult));
        if (Date.now() >= deadline) throw new Error('pause timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      const recovery = path.join(rootPath, '.writcraft', 'recovery');
      const journalPath = path.join(recovery, 'changes-history-transaction.json');
      if (mutation === 'journal-newer') {
        const fd = fs.openSync(journalPath, 'r+');
        const frame = Buffer.from(frame64, 'base64');
        fs.writeSync(fd, frame, 0, frame.length, 0);
        fs.fsyncSync(fd); fs.closeSync(fd);
      } else if (mutation === 'journal-new-inode') {
        const bytes = fs.readFileSync(journalPath);
        fs.renameSync(journalPath, journalPath + '.moved');
        fs.writeFileSync(journalPath, bytes, { flag: 'wx', mode: 0o600 });
      } else if (mutation === 'recovery-replace') {
        fs.renameSync(recovery, recovery + '.moved');
        fs.mkdirSync(recovery, { mode: 0o700 });
      } else if (mutation === 'control-same-rewrite') {
        const target = path.join(recovery, recordName);
        const bytes = fs.readFileSync(target);
        fs.writeFileSync(target, bytes);
      } else if (mutation === 'control-new-inode') {
        const target = path.join(recovery, recordName);
        const bytes = fs.readFileSync(target);
        fs.renameSync(target, target + '.moved');
        fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
      } else if (mutation === 'artifact-slice-rewrite') {
        const target = path.join(recovery, 'artifact.bin');
        const fd = fs.openSync(target, 'r+');
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, 0);
        byte[0] ^= 1;
        fs.writeSync(fd, byte, 0, 1, 0);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } else if (mutation === 'final-same-rewrite') {
        const target = path.join(recovery, recordName);
        const bytes = fs.readFileSync(target);
        const fd = fs.openSync(target, 'r+');
        fs.writeSync(fd, Buffer.alloc(bytes.length, 0x7a), 0, bytes.length, 0);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } else {
        throw new Error('unknown mutation');
      }
      fs.writeFileSync(path.join(syncRoot, syncName + '.release'), '', { flag: 'wx', mode: 0o600 });
      process.stdout.write(JSON.stringify(await closed));
    })().catch(error => {
      try { child.kill('SIGKILL'); } catch (_) {}
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
  `;
  const syncRoot = path.join(scratch, `sync-${crypto.randomBytes(8).toString('hex')}`);
  const result = childProcess.spawnSync(process.execPath, [
    '-e', driver, helperPath, fixture.rootPath,
    Buffer.from(fixture.input).toString('base64'), syncRoot, syncName, mutation,
    fixture.newerFrame.toString('base64'), recordName,
  ], {
    encoding: 'utf8', timeout: 20000,
    stdio: ['ignore', 'pipe', 'pipe', fixture.artifactFd],
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};
const closePauseFixture = fixture => {
  fs.closeSync(fixture.artifactFd);
};
const prepareCleanupAuthority = (fixture, publicationResult, scopedLifecycle) => {
  const capture = schema.buildCreateCapture(fixture.request, publicationResult);
  const latched = schema.buildLatchedCreatePublication(fixture.request);
  const armed = {
    ...latched,
    state: 'ARMED',
    previousPublicationDigest: latched.publicationDigest,
    createCapture: capture,
    publicationDigest: null,
  };
  armed.publicationDigest = journal.publicationDigest(armed);
  const validArmed = journal.assertPublicationTransition(latched, armed);
  const committed = {
    ...validArmed,
    state: 'COMMITTED',
    previousPublicationDigest: validArmed.publicationDigest,
    publicationDigest: null,
  };
  committed.publicationDigest = journal.publicationDigest(committed);
  const validCommitted = journal.assertPublicationTransition(validArmed, committed);
  const finalizationAuthority = {
    schema: schema.SCHEMAS.CREATE_FINALIZATION_AUTHORITY,
    createRequest: fixture.request,
    committedPublication: validCommitted,
    historyCommittedPhaseDigest: digest(8),
    rawPreparedHistoryStateDigest: digest(9),
    artifactIdentity: objectIdentity(
      fs.fstatSync(fixture.artifactFd, { bigint: true }),
      fixture.request.artifactDigest
    ),
  };
  const prepared = schema.buildPreparedCreateFinalization(finalizationAuthority);
  scopedLifecycle.finalizeCreate(prepared.finalizeRequest, fixture.request);
  const finalPath = path.join(fixture.recovery, prepared.finalBasename);
  const finalBytes = fs.readFileSync(finalPath);
  const finalRecordIdentity = objectIdentity(
    fs.statSync(finalPath, { bigint: true }),
    evidence.sha256(finalBytes)
  );
  return schema.buildCreateCleanupAuthority(finalizationAuthority, finalRecordIdentity);
};
assert.strictEqual(invokeRaw(resignHeadWire({
  journalId: 'badj_' + 'd'.repeat(48),
})).status, 4);
const forgedCommandLines = commandWire.trimEnd().split('\n');
const forgedCommandHeader = forgedCommandLines[0].split('\t');
forgedCommandHeader[2] = digest(9);
assert.strictEqual(invokeRaw(
  [forgedCommandHeader.join('\t'), ...forgedCommandLines.slice(1)].join('\n') + '\n'
).status, 4);
const alternateWire = (requestPatch, markerPatch = {}) => {
  const changedRequest = { ...request, ...requestPatch };
  const changedMarker = { ...activeMarker, ...markerPatch };
  const changedPrepared = schema.buildLatchedCreatePublication(changedRequest);
  const changedValue = {
    ...activeValue,
    projectId: changedMarker.projectId,
    activeOperationId: changedRequest.operationId,
    activeMarker: changedMarker,
    activeMarkerDigest: journal.activeMarkerDigest(changedMarker),
    nativePublication: changedPrepared,
    valueDigest: null,
  };
  changedValue.valueDigest = journal.valueDigest(changedValue);
  const validValue = journal.assertJournalValue(changedValue);
  const changedAuthority = schema.buildCreateJournalAuthority(
    changedRequest, validValue
  );
  return {
    wire: schema.encodeCreateMissingJournalCommand(
      changedAuthority, changedRequest, validValue
    ),
  };
};
for (const alternate of [
  alternateWire({}, { projectId: 'project-forged-journal' }),
  alternateWire({ precreatePhaseDigest: digest(8) }),
  alternateWire({}, { updatedAt: '2026-08-10T00:00:02.000Z' }),
]) {
  assert.strictEqual(invokeRaw(alternate.wire).status, 4);
}
let journalCreateCalls = 0;
const scoped = lifecycle.createPublicMarkdownNativeTransport({
  helperPath: helper,
  spawnSync(command, args, options) {
    journalCreateCalls += 1;
    assert.match(options.input, /\nCJ\tCREATE_MISSING\t/);
    assert.doesNotMatch(options.input, /\nR\t/);
    return childProcess.spawnSync(command, args, options);
  },
})
  .forProject(rootPath);

assert.strictEqual(typeof scoped.createMissingJournal, 'function');
const result = scoped.createMissingJournal(
  authority, request, activeValue, artifactFd
);
assert.strictEqual(result.state, 'COMMITTED');
assert.strictEqual(result.command, 'CREATE_MISSING');
assert.strictEqual(journalCreateCalls, 1);
assert.deepStrictEqual(fs.readFileSync(path.join(rootPath, 'chapter.md')), artifactBytes);
const publicationItem = result.publicationResult.items[0];
const createdStat = fs.statSync(path.join(rootPath, 'chapter.md'), { bigint: true });
assert.strictEqual(publicationItem.createdLeafIdentity.dev, createdStat.dev.toString());
assert.strictEqual(publicationItem.createdLeafIdentity.ino, createdStat.ino.toString());
const recordNames = schema.recordNames(request, 0);
for (const [name, identity] of [
  [recordNames.controlBasename, publicationItem.controlRecordIdentity],
  [recordNames.receiptBasename, publicationItem.receiptRecordIdentity],
]) {
  const stat = fs.statSync(path.join(recovery, name), { bigint: true });
  assert.strictEqual(identity.dev, stat.dev.toString());
  assert.strictEqual(identity.ino, stat.ino.toString());
  assert.strictEqual(identity.mode, 0o600);
  assert.strictEqual(identity.nlink, 1);
}

{
  const cleanup = pauseFixture('cleanup-real-journal');
  try {
    const cleanupScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
      .forProject(cleanup.rootPath);
    const created = cleanupScoped.createMissingJournal(
      cleanup.authority, cleanup.request, cleanup.activeValue, cleanup.artifactFd
    );
    assert.strictEqual(created.state, 'COMMITTED');
    const cleanupAuthority = prepareCleanupAuthority(
      cleanup, created.publicationResult, cleanupScoped
    );
    assert.strictEqual(cleanupScoped.reconcileCreateCleanup(cleanupAuthority).state, 'UNCOMMITTED');
    const cleaned = cleanupScoped.cleanupCreate(cleanupAuthority);
    assert.strictEqual(cleaned.state, 'COMMITTED');
    assert.strictEqual(cleaned.items.length, cleanupAuthority.items.length);
    for (const item of cleanupAuthority.items) {
      assert.strictEqual(fs.existsSync(path.join(cleanup.recovery, item.sourceBasename)), false);
      assert.strictEqual(fs.existsSync(path.join(cleanup.recovery, item.cleanupBasename)), true);
    }
    const restarted = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
      .forProject(cleanup.rootPath);
    assert.deepStrictEqual(restarted.reconcileCreateCleanup(cleanupAuthority), {
      ...cleaned,
      command: schema.CREATE_CLEANUP_COMMANDS.RECONCILE,
    });
    assert.strictEqual(restarted.ackCreateCleanup(cleanupAuthority).state, 'ACKED');
    assert.strictEqual(restarted.ackCreateCleanup(cleanupAuthority).state, 'ACKED');
    for (const item of cleanupAuthority.items) {
      assert.strictEqual(fs.existsSync(path.join(cleanup.recovery, item.cleanupBasename)), false);
    }
  } finally {
    closePauseFixture(cleanup);
  }
}

{
  const responseLoss = pauseFixture('cleanup-response-loss');
  try {
    const createScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
      .forProject(responseLoss.rootPath);
    const created = createScoped.createMissingJournal(
      responseLoss.authority,
      responseLoss.request,
      responseLoss.activeValue,
      responseLoss.artifactFd
    );
    const cleanupAuthority = prepareCleanupAuthority(
      responseLoss, created.publicationResult, createScoped
    );
    let cleanupLoss = true;
    let ackLoss = true;
    const lossScoped = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: helper,
      spawnSync(binary, argv, options) {
        const nativeResult = childProcess.spawnSync(binary, argv, options);
        const input = Buffer.isBuffer(options.input)
          ? options.input.toString('utf8')
          : String(options.input);
        if (cleanupLoss && input.includes('\nG\tCREATE_CLEANUP\t')) {
          cleanupLoss = false;
          return {
            ...nativeResult,
            status: 17,
            signal: null,
            error: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        }
        if (ackLoss && input.includes('\nA\tCREATE_CLEANUP\t')) {
          ackLoss = false;
          return {
            ...nativeResult,
            status: 17,
            signal: null,
            error: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
          };
        }
        return nativeResult;
      },
    }).forProject(responseLoss.rootPath);
    assert.strictEqual(lossScoped.cleanupCreate(cleanupAuthority).state, 'COMMITTED');
    assert.strictEqual(cleanupLoss, false);
    assert.strictEqual(lossScoped.ackCreateCleanup(cleanupAuthority).state, 'ACKED');
    assert.strictEqual(ackLoss, false);
  } finally {
    closePauseFixture(responseLoss);
  }
}

for (const window of [
  {
    command: schema.CREATE_CLEANUP_COMMANDS.CLEANUP,
    macro: 'WRITCRAFT_TEST_PAUSE_CREATE_CLEANUP_AFTER_G_FSYNC',
    syncName: 'create-cleanup-after-g-fsync',
    letter: 'G',
  },
  {
    command: schema.CREATE_CLEANUP_COMMANDS.ACK,
    macro: 'WRITCRAFT_TEST_PAUSE_CREATE_CLEANUP_AFTER_A_FSYNC',
    syncName: 'create-cleanup-after-a-fsync',
    letter: 'A',
  },
]) {
  const lateFinal = pauseFixture(`cleanup-late-final-${window.letter}`);
  try {
    const normalScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
      .forProject(lateFinal.rootPath);
    const created = normalScoped.createMissingJournal(
      lateFinal.authority,
      lateFinal.request,
      lateFinal.activeValue,
      lateFinal.artifactFd
    );
    const cleanupAuthority = prepareCleanupAuthority(
      lateFinal,
      created.publicationResult,
      normalScoped
    );
    if (window.command === schema.CREATE_CLEANUP_COMMANDS.ACK) {
      assert.strictEqual(normalScoped.cleanupCreate(cleanupAuthority).state, 'COMMITTED');
    }
    const pausedHelper = path.join(scratch, `public-markdown-${window.syncName}`);
    compileHelper(pausedHelper, [window.macro]);
    const rootLineEnd = lateFinal.input.indexOf('\n') + 1;
    lateFinal.input = lateFinal.input.slice(0, rootLineEnd) +
      schema.encodeCreateCleanupCommand(window.command, cleanupAuthority);
    const finalPath = path.join(lateFinal.recovery, cleanupAuthority.finalBasename);
    const result = runPausedJournal({
      helperPath: pausedHelper,
      fixture: lateFinal,
      syncName: window.syncName,
      mutation: 'final-same-rewrite',
      recordName: cleanupAuthority.finalBasename,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, new RegExp(`${window.letter}\\tOK\\tUNKNOWN\\t`));
    assert.deepStrictEqual(
      fs.readFileSync(finalPath),
      Buffer.alloc(fs.statSync(finalPath).size, 0x7a)
    );
    for (const item of cleanupAuthority.items) {
      if (window.letter === 'G') {
        assert.strictEqual(fs.existsSync(path.join(
          lateFinal.recovery,
          item.cleanupBasename
        )), true);
      } else {
        assert.strictEqual(fs.existsSync(path.join(
          lateFinal.recovery,
          item.cleanupBasename
        )), false);
      }
    }
  } finally {
    closePauseFixture(lateFinal);
  }
}

for (const command of [
  ['G', 'cleanupCreate'],
  ['R', 'reconcileCreateCleanup'],
  ['A', 'ackCreateCleanup'],
]) {
  for (const mutation of ['same-inode-rewrite', 'new-inode-exact', 'delete']) {
    const drift = pauseFixture(`cleanup-final-${command[0]}-${mutation}`);
    try {
      const driftScoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
        .forProject(drift.rootPath);
      const created = driftScoped.createMissingJournal(
        drift.authority,
        drift.request,
        drift.activeValue,
        drift.artifactFd
      );
      const cleanupAuthority = prepareCleanupAuthority(
        drift,
        created.publicationResult,
        driftScoped
      );
      const finalPath = path.join(drift.recovery, cleanupAuthority.finalBasename);
      const original = fs.readFileSync(finalPath);
      if (mutation === 'same-inode-rewrite') {
        const fd = fs.openSync(finalPath, 'r+');
        fs.writeSync(fd, Buffer.alloc(original.length, 0x78), 0, original.length, 0);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      } else if (mutation === 'new-inode-exact') {
        fs.renameSync(finalPath, `${finalPath}.old`);
        fs.writeFileSync(finalPath, original, { flag: 'wx', mode: 0o600 });
      } else {
        fs.unlinkSync(finalPath);
      }
      const result = driftScoped[command[1]](cleanupAuthority);
      assert.strictEqual(result.state, 'UNKNOWN');
      for (const item of cleanupAuthority.items) {
        assert.strictEqual(
          fs.existsSync(path.join(drift.recovery, item.sourceBasename)),
          true,
          `${command[0]} ${mutation} must preserve ${item.sourceBasename}`
        );
        assert.strictEqual(
          fs.existsSync(path.join(drift.recovery, item.cleanupBasename)),
          false,
          `${command[0]} ${mutation} must not create ${item.cleanupBasename}`
        );
      }
    } finally {
      closePauseFixture(drift);
    }
  }
}

const preControlHelper = path.join(scratch, 'public-markdown-create-journal-pre-control');
compileHelper(preControlHelper, ['WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_GUARD']);
for (const mutation of ['journal-newer']) {
  const paused = pauseFixture(`pre-${mutation}`);
  try {
    const pausedResult = runPausedJournal({
      helperPath: preControlHelper, fixture: paused,
      syncName: 'create-journal-after-guard', mutation,
    });
    assert.strictEqual(pausedResult.status, 0, pausedResult.stderr || pausedResult.stdout);
    assert.match(pausedResult.stdout, /"state":"UNKNOWN"/);
    assert.strictEqual(fs.existsSync(path.join(paused.rootPath, 'created.md')), false);
    const names = schema.recordNames(paused.request, 0);
    assert.strictEqual(fs.existsSync(path.join(paused.recovery, names.controlBasename)), false);
    assert.strictEqual(fs.existsSync(path.join(paused.recovery, names.receiptBasename)), false);
  } finally {
    closePauseFixture(paused);
  }
}

for (const window of [
  {
    macro: 'WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_SECOND_CONTROL',
    syncName: 'create-journal-second-control',
    label: 'second-control',
  },
  {
    macro: 'WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_SECOND_LEAF',
    syncName: 'create-journal-second-leaf',
    label: 'second-leaf',
  },
]) {
  const pausedHelper = path.join(scratch, `public-markdown-create-journal-${window.label}`);
  compileHelper(pausedHelper, [window.macro]);
  const paused = pauseFixture(window.label, 2);
  try {
    const pausedResult = runPausedJournal({
      helperPath: pausedHelper, fixture: paused,
      syncName: window.syncName, mutation: 'journal-newer',
    });
    assert.strictEqual(pausedResult.status, 0, pausedResult.stderr || pausedResult.stdout);
    assert.match(pausedResult.stdout, /"state":"UNKNOWN"/);
    const firstNames = schema.recordNames(paused.request, 0);
    const secondNames = schema.recordNames(paused.request, 1);
    assert.strictEqual(fs.existsSync(path.join(paused.recovery, firstNames.controlBasename)), true);
    assert.strictEqual(
      fs.existsSync(path.join(paused.recovery, secondNames.controlBasename)),
      window.label === 'second-leaf'
    );
    assert.strictEqual(fs.existsSync(path.join(paused.rootPath, 'created-1.md')), false);
    if (window.label === 'second-leaf') {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(paused.rootPath, 'created-0.md')), paused.itemBytes[0]
      );
      assert.strictEqual(fs.existsSync(path.join(paused.recovery, firstNames.receiptBasename)), true);
      assert.strictEqual(fs.existsSync(path.join(paused.recovery, secondNames.receiptBasename)), false);
    }
  } finally {
    closePauseFixture(paused);
  }
}

for (const definition of [
  'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE',
  'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE',
  'WRITCRAFT_TEST_CONTROL_PATH_RECHECK_FAILURE',
  'WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE',
]) {
  const faultHelper = path.join(scratch, `public-markdown-cj-${definition.toLowerCase()}`);
  compileHelper(faultHelper, [definition]);
  const fault = pauseFixture(definition.toLowerCase());
  try {
    const result = lifecycle.createPublicMarkdownNativeTransport({ helperPath: faultHelper })
      .forProject(fault.rootPath).createMissingJournal(
        fault.authority, fault.request, fault.activeValue, fault.artifactFd
      );
    assert.strictEqual(result.state, 'UNKNOWN');
    assert.strictEqual(fs.existsSync(path.join(fault.rootPath, 'created.md')), false);
    const names = schema.recordNames(fault.request, 0);
    assert.strictEqual(
      fs.existsSync(path.join(fault.recovery, names.controlBasename)), false, definition
    );
    assert.strictEqual(fs.existsSync(path.join(fault.recovery, names.receiptBasename)), false);
  } finally {
    closePauseFixture(fault);
  }
}

const replacementHelper = path.join(scratch, 'public-markdown-cj-control-replacement');
compileHelper(replacementHelper, [
  'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE',
  'WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP',
]);
for (const mutation of ['control-same-rewrite', 'control-new-inode']) {
  const replacement = pauseFixture(mutation);
  try {
    const names = schema.recordNames(replacement.request, 0);
    const result = runPausedJournal({
      helperPath: replacementHelper, fixture: replacement,
      syncName: 'control-failure-before-cleanup', mutation,
      recordName: names.controlBasename,
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"state":"UNKNOWN"/);
    assert.strictEqual(fs.existsSync(path.join(replacement.rootPath, 'created.md')), false);
    assert.strictEqual(fs.existsSync(path.join(replacement.recovery, names.controlBasename)), true);
  } finally {
    closePauseFixture(replacement);
  }
}

{
  const sliceHelper = path.join(scratch, 'public-markdown-cj-slice-drift');
  compileHelper(sliceHelper, ['WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_LEAF_GUARD']);
  const slice = pauseFixture('slice-drift');
  try {
    const result = runPausedJournal({
      helperPath: sliceHelper, fixture: slice,
      syncName: 'create-journal-after-leaf-guard', mutation: 'artifact-slice-rewrite',
    });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /"state":"UNKNOWN"/);
    assert.strictEqual(fs.existsSync(path.join(slice.rootPath, 'created.md')), false);
  } finally {
    closePauseFixture(slice);
  }
}

{
  const foreign = pauseFixture('wrong-basename');
  try {
    const wrongName = `.changes-history-native-create-control.${'f'.repeat(64)}`;
    fs.writeFileSync(
      path.join(foreign.recovery, wrongName),
      schema.encodeControlRecord(schema.buildControl(foreign.request, 0)),
      { flag: 'wx', mode: 0o600 }
    );
    const result = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
      .forProject(foreign.rootPath).createMissingJournal(
        foreign.authority, foreign.request, foreign.activeValue, foreign.artifactFd
      );
    assert.strictEqual(result.state, 'UNKNOWN');
    assert.strictEqual(fs.existsSync(path.join(foreign.rootPath, 'created.md')), false);
    assert.strictEqual(fs.existsSync(path.join(foreign.recovery, wrongName)), true);
  } finally {
    closePauseFixture(foreign);
  }
}

for (const responseFault of [
  'WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE',
  'WRITCRAFT_TEST_MALFORMED_CREATE_JOURNAL_RESPONSE',
]) {
  const responseHelper = path.join(scratch, `public-markdown-cj-${responseFault.toLowerCase()}`);
  compileHelper(responseHelper, [responseFault]);
  const response = pauseFixture(responseFault.toLowerCase(), 2);
  let calls = 0;
  try {
    const scopedFault = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: responseHelper,
      spawnSync(command, args, options) {
        calls += 1;
        assert.doesNotMatch(options.input, /\nR\t/);
        return childProcess.spawnSync(command, args, options);
      },
    }).forProject(response.rootPath);
    const faultResult = scopedFault.createMissingJournal(
      response.authority, response.request, response.activeValue, response.artifactFd
    );
    assert.strictEqual(faultResult.state, 'UNKNOWN');
    assert.strictEqual(faultResult.publicationResult, null);
    assert.strictEqual(calls, 1);
    for (let index = 0; index < 2; index += 1) {
      assert.deepStrictEqual(
        fs.readFileSync(path.join(response.rootPath, `created-${index}.md`)),
        response.itemBytes[index]
      );
      const names = schema.recordNames(response.request, index);
      assert.strictEqual(fs.existsSync(path.join(response.recovery, names.controlBasename)), true);
      assert.strictEqual(fs.existsSync(path.join(response.recovery, names.receiptBasename)), true);
    }
  } finally {
    closePauseFixture(response);
  }
}

{
  const maximumHelper = path.join(scratch, 'public-markdown-cj-maximum-bounded');
  compileHelper(maximumHelper, ['WRITCRAFT_TEST_REQUIRE_CREATE_JOURNAL_BOUNDED_HASHES']);
  const maximum = pauseFixture('maximum', 300);
  let maximumSpawn = null;
  try {
    const result = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: maximumHelper,
      spawnSync(...args) {
        maximumSpawn = childProcess.spawnSync(...args);
        return maximumSpawn;
      },
    })
      .forProject(maximum.rootPath).createMissingJournal(
        maximum.authority, maximum.request, maximum.activeValue, maximum.artifactFd
      );
    assert.strictEqual(result.state, 'COMMITTED', maximumSpawn?.stdout?.toString('utf8'));
    assert.strictEqual(result.publicationResult.items.length, 300);
    const responseHeader = maximumSpawn.stdout.subarray(Buffer.byteLength('P\tOK\n'))
      .toString('utf8', 0, 160).split('\n')[0].split('\t');
    assert(Number(responseHeader[1]) > schema.LIMITS.maxResponseBytes);
    assert(Number(responseHeader[1]) < schema.LIMITS.maxCreateJournalResponseBytes);
    for (let index = 0; index < 300; index += 1) {
      const item = result.publicationResult.items[index];
      assert.strictEqual(item.selectedId, maximum.request.items[index].selectedId);
      assert.deepStrictEqual(
        fs.readFileSync(path.join(maximum.rootPath, `created-${index}.md`)),
        maximum.itemBytes[index]
      );
      for (const identity of [
        item.createdLeafIdentity, item.controlRecordIdentity, item.receiptRecordIdentity,
      ]) {
        assert.strictEqual(identity.nlink, 1);
        assert.match(identity.dev, /^(0|[1-9][0-9]*)$/);
        assert.match(identity.ino, /^(0|[1-9][0-9]*)$/);
      }
    }
  } finally {
    closePauseFixture(maximum);
  }
}

const preResponseHelper = path.join(scratch, 'public-markdown-create-journal-pre-response');
compileHelper(preResponseHelper, ['WRITCRAFT_TEST_PAUSE_CREATE_JOURNAL_AFTER_COMMIT']);
for (const mutation of ['journal-new-inode', 'recovery-replace']) {
  const paused = pauseFixture(`response-${mutation}`);
  try {
    const pausedResult = runPausedJournal({
      helperPath: preResponseHelper, fixture: paused,
      syncName: 'create-journal-after-commit', mutation,
    });
    assert.strictEqual(pausedResult.status, 0, pausedResult.stderr || pausedResult.stdout);
    assert.match(pausedResult.stdout, /"state":"UNKNOWN"/);
    assert.deepStrictEqual(fs.readFileSync(path.join(paused.rootPath, 'created.md')), paused.bytes);
    const evidenceRecovery = mutation === 'recovery-replace'
      ? `${paused.recovery}.moved`
      : paused.recovery;
    const names = schema.recordNames(paused.request, 0);
    assert.strictEqual(fs.existsSync(path.join(evidenceRecovery, names.controlBasename)), true);
    assert.strictEqual(fs.existsSync(path.join(evidenceRecovery, names.receiptBasename)), true);
  } finally {
    closePauseFixture(paused);
  }
}

const journalPath = path.join(recovery, journal.JOURNAL_BASENAME);
const journalHandle = fs.openSync(journalPath, 'r+');
const corruptOffset = journal.SLOT_OFFSETS.B + authority.currentPayloadSlices.projectId.offset +
  journal.encodeSlotFrame(activeValue, 'B').indexOf(0x0a) + 1;
const originalByte = Buffer.alloc(1);
fs.readSync(journalHandle, originalByte, 0, 1, corruptOffset);
fs.writeSync(journalHandle, Buffer.from([originalByte[0] ^ 1]), 0, 1, corruptOffset);
fs.fsyncSync(journalHandle);
assert.strictEqual(invokeRaw(commandWire).status, 4);
fs.writeSync(journalHandle, originalByte, 0, 1, corruptOffset);
fs.fsyncSync(journalHandle);
fs.closeSync(journalHandle);

const newer = {
  ...activeValue,
  generation: '2',
  previousValueDigest: activeValue.valueDigest,
  valueDigest: null,
};
newer.valueDigest = journal.valueDigest(newer);
const newerFrame = journal.encodeSlotFrame(journal.assertJournalValue(newer), 'A');
const journalNewer = fs.openSync(journalPath, 'r+');
fs.writeSync(journalNewer, newerFrame, 0, newerFrame.length, journal.SLOT_OFFSETS.A);
fs.fsyncSync(journalNewer);
assert.strictEqual(invokeRaw(commandWire).status, 4);
const baseFrame = journal.encodeSlotFrame(baseValue, 'A');
fs.writeSync(journalNewer, baseFrame, 0, baseFrame.length, journal.SLOT_OFFSETS.A);
fs.ftruncateSync(
  journalNewer,
  journal.SLOT_OFFSETS.B + journal.encodeSlotFrame(activeValue, 'B').length
);
fs.fsyncSync(journalNewer);
fs.closeSync(journalNewer);

const swappedA = journal.encodeSlotFrame(activeValue, 'A');
const swappedB = journal.encodeSlotFrame(baseValue, 'B');
const journalSwapped = fs.openSync(journalPath, 'r+');
fs.writeSync(journalSwapped, swappedA, 0, swappedA.length, journal.SLOT_OFFSETS.A);
fs.writeSync(journalSwapped, swappedB, 0, swappedB.length, journal.SLOT_OFFSETS.B);
fs.ftruncateSync(journalSwapped, journal.SLOT_OFFSETS.B + swappedB.length);
fs.fsyncSync(journalSwapped);
assert.strictEqual(invokeRaw(resignHeadWire({ slot: 'A', frame: swappedA })).status, 4);
fs.writeSync(journalSwapped, baseFrame, 0, baseFrame.length, journal.SLOT_OFFSETS.A);
const activeFrame = journal.encodeSlotFrame(activeValue, 'B');
fs.writeSync(journalSwapped, activeFrame, 0, activeFrame.length, journal.SLOT_OFFSETS.B);
fs.ftruncateSync(journalSwapped, journal.SLOT_OFFSETS.B + activeFrame.length);
fs.fsyncSync(journalSwapped);
fs.closeSync(journalSwapped);

let spawnCalls = 0;
const nfdScoped = lifecycle.createPublicMarkdownNativeTransport({
  helperPath: helper,
  spawnSync() {
    spawnCalls += 1;
    throw new Error('must not spawn');
  },
}).forProject(rootPath);
const nfdRequest = {
  ...request,
  items: [{ ...request.items[0], path: 'cafe\u0301.md' }],
};
assert.throws(() => nfdScoped.createMissingJournal(
  authority, nfdRequest, activeValue, artifactFd
));
assert.strictEqual(spawnCalls, 0);

fs.closeSync(artifactFd);
console.log('28/28 native CREATE_MISSING journal Phase2 focused verifications passed');
