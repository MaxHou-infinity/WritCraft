#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const schema = require('../src/main/public-markdown-native-schema');
const lifecycle = require('../src/main/public-markdown-native-lifecycle');
const nativeBuild = require('../scripts/build-native-helper');
const evidence = require('../src/main/evidence-delivery-schema');
const phaseSchema = require('../src/main/snapshot-public-markdown-phase-schema');
const existingSchema = require('../src/main/snapshot-existing-restore-native-schema');

const SOURCE = path.join(__dirname, '..', 'native', 'public-markdown-create-helper.c');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-public-markdown-native-'));

const digest = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const phaseDigest = `sha256:${'3'.repeat(64)}`;
const selectionDigest = `sha256:${'4'.repeat(64)}`;
let passed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    throw error;
  }
}

test('A1b production adapter exposes formal existing E/R/V/F boundary', () => {
  const production = lifecycle.createPublicMarkdownNativeLifecycle();
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'a1b-production-')));
  fs.mkdirSync(path.join(rootPath, '.writcraft', 'recovery'), { recursive: true, mode: 0o700 });
  try {
    const scoped = production.forProject(rootPath);
    for (const method of ['execute', 'reconcile', 'verify', 'finalize', 'reconcileFinalize']) {
      assert.strictEqual(typeof scoped.existingRestore?.[method], 'function',
        `production existing lifecycle must expose ${method}`);
    }
  } finally {
    fs.rmSync(rootPath, { recursive: true, force: true });
  }
});

function compile(name, definitions = []) {
  const output = path.join(scratch, name);
  childProcess.execFileSync('xcrun', [
    '--sdk', 'macosx', 'clang', '-std=c11', '-Wall', '-Wextra', '-Werror', '-Os',
    '-mmacosx-version-min=11.0', '-arch', process.arch === 'arm64' ? 'arm64' : 'x86_64',
    ...definitions.map(value => `-D${value}`), SOURCE, '-o', output,
  ]);
  return output;
}

function objectIdentity(stat, contentSha256) {
  return {
    schema: require('../src/main/evidence-delivery-schema').SCHEMAS.OBJECT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
    nlink: Number(stat.nlink),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    contentSha256,
  };
}

function snapshotAuthorityFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath, { bigint: true });
  return { bytes, identity: objectIdentity(stat, digest(bytes)) };
}

function snapshotExistingAuthority(item) {
  return {
    marker: snapshotAuthorityFile(path.join(
      item.rootPath, '.writcraft', 'recovery', 'changes-history-transaction.json'
    )),
    history: snapshotAuthorityFile(item.historyPath),
  };
}

function assertExistingAuthoritySnapshot(item, snapshot) {
  const marker = snapshotAuthorityFile(path.join(
    item.rootPath, '.writcraft', 'recovery', 'changes-history-transaction.json'
  ));
  const history = snapshotAuthorityFile(item.historyPath);
  assert.deepStrictEqual(marker.bytes, snapshot.marker.bytes);
  assert.deepStrictEqual(marker.identity, snapshot.marker.identity);
  assert.deepStrictEqual(history.bytes, snapshot.history.bytes);
  assert.deepStrictEqual(history.identity, snapshot.history.identity);
}

function fixture(helperPath, label = 'hello native\n') {
  const evidence = require('../src/main/evidence-delivery-schema');
  const parent = fs.mkdtempSync(path.join(scratch, 'project-'));
  const rootPath = fs.realpathSync(parent);
  const recovery = path.join(rootPath, '.writcraft', 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(recovery, 0o700);
  const bytes = Buffer.from(label, 'utf8');
  const artifactPath = path.join(recovery, 'held-artifact.bin');
  fs.writeFileSync(artifactPath, bytes, { flag: 'wx', mode: 0o600 });
  fs.chmodSync(artifactPath, 0o600);
  const artifactFd = fs.openSync(artifactPath, fs.constants.O_RDONLY);
  const stat = fs.fstatSync(artifactFd, { bigint: true });
  const artifactDigest = digest(bytes);
  const request = {
    schema: schema.SCHEMAS.CREATE_REQUEST,
    operationId: `chr_${crypto.randomBytes(24).toString('hex')}`,
    artifactDigest,
    artifactIdentityDigest: evidence.digestObjectIdentity(objectIdentity(stat, artifactDigest)),
    artifactByteLength: bytes.length,
    precreatePhaseDigest: phaseDigest,
    selectionDigest,
    items: [{
      selectedId: 'missing_one',
      path: 'created.md',
      artifactOffset: 0,
      byteLength: bytes.length,
      contentDigest: artifactDigest,
      ancestorIdentityDigest: evidence.digestAncestorIdentity({
        schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
        components: [],
      }),
    }],
  };
  const scoped = lifecycle.createPublicMarkdownNativeTransport({ helperPath }).forProject(rootPath);
  return { rootPath, recovery, bytes, artifactPath, artifactFd, request, scoped };
}

function closeFixture(item) {
  try { fs.closeSync(item.artifactFd); } catch (_) {}
}

function publicCreateRequest(item) {
  return {
    schema: 'writcraft.public-markdown-create-request/v1',
    operationId: item.request.operationId,
    projectId: 'project-native-adapter',
    artifactDigest: item.request.artifactDigest,
    selectionDigest: item.request.selectionDigest,
    items: item.request.items.map((nativeItem, index) => ({
      selectedId: nativeItem.selectedId,
      path: nativeItem.path,
      afterRevision: nativeItem.contentDigest.slice(7),
      ancestorIdentityDigest: nativeItem.ancestorIdentityDigest,
      bytes: item.bytes.subarray(
        nativeItem.artifactOffset,
        nativeItem.artifactOffset + nativeItem.byteLength
      ),
      index,
    })).map(({ index: _index, ...value }) => value),
  };
}

function bindNestedRequest(item, directories) {
  const evidence = require('../src/main/evidence-delivery-schema');
  let current = item.rootPath;
  const components = directories.map(name => {
    current = path.join(current, name);
    fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.statSync(current, { bigint: true });
    return {
      nameSha256: digest(Buffer.from(name, 'utf8')),
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      uid: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n),
    };
  });
  item.request = schema.assertCreateRequest({
    ...item.request,
    items: [{
      ...item.request.items[0],
      path: `${directories.join('/')}/created.md`,
      ancestorIdentityDigest: evidence.digestAncestorIdentity({
        schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
        components,
      }),
    }],
  });
  return current;
}

function directoryIdentityDigest(target) {
  const evidence = require('../src/main/evidence-delivery-schema');
  const stat = fs.statSync(target, { bigint: true });
  return evidence.digestRootIdentity({
    schema: evidence.SCHEMAS.ROOT_IDENTITY,
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
  });
}

function identityForWire(wire, seed = 1) {
  return {
    schema: evidence.SCHEMAS.OBJECT_IDENTITY,
    dev: String(10 + seed),
    ino: String(100 + seed),
    uid: process.geteuid(),
    mode: 0o600,
    nlink: 1,
    size: String(Buffer.byteLength(wire, 'utf8')),
    mtimeNs: String(1000000000 + seed),
    ctimeNs: String(2000000000 + seed),
    contentSha256: evidence.sha256(Buffer.from(wire, 'utf8')),
  };
}

function existingProductionFixture(
  helperPath,
  existingCount = 1,
  materializeAfter = false,
  baseHistoryExists = true,
  historyWritable = false,
  nestedExistingPath = false
) {
  const rootPath = fs.realpathSync(fs.mkdtempSync(path.join(scratch, 'existing-production-')));
  const metadata = path.join(rootPath, '.writcraft');
  const recovery = path.join(metadata, 'recovery');
  fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
  fs.chmodSync(metadata, 0o700);
  fs.chmodSync(recovery, 0o700);
  const operationId = `chr_${'1'.repeat(48)}`;
  const beforeBytes = Array.from({ length: existingCount }, (_, index) =>
    Buffer.from(`before chapter ${index}\n`, 'utf8'));
  const afterBytes = Array.from({ length: existingCount }, (_, index) =>
    Buffer.from(`after chapter ${index}\n`, 'utf8'));
  const beforeOffsets = [];
  const afterOffsets = [];
  const artifactParts = [];
  let artifactOffset = 0;
  for (let index = 0; index < existingCount; index += 1) {
    beforeOffsets.push(artifactOffset);
    artifactParts.push(beforeBytes[index]);
    artifactOffset += beforeBytes[index].length;
    afterOffsets.push(artifactOffset);
    artifactParts.push(afterBytes[index]);
    artifactOffset += afterBytes[index].length;
  }
  const artifactBytes = Buffer.concat(artifactParts);
  const markerBytes = Buffer.from('existing marker\n', 'utf8');
  const historyBytes = baseHistoryExists ? Buffer.from('{}\n', 'utf8') : Buffer.alloc(0);
  const chaptersDir = nestedExistingPath ? path.join(rootPath, 'chapters') : rootPath;
  if (nestedExistingPath) fs.mkdirSync(chaptersDir, { mode: 0o700 });
  const chapterPaths = Array.from({ length: existingCount }, (_, index) =>
    path.join(chaptersDir, `chapter-${index}.md`));
  const artifactPath = path.join(recovery, `changes-history-${operationId}.bin`);
  const markerPath = path.join(recovery, 'changes-history-transaction.json');
  const historyPath = path.join(metadata, 'changes.json');
  for (let index = 0; index < existingCount; index += 1) {
    fs.writeFileSync(chapterPaths[index], beforeBytes[index], { flag: 'wx', mode: 0o600 });
  }
  fs.writeFileSync(artifactPath, artifactBytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(markerPath, markerBytes, { flag: 'wx', mode: 0o600 });
  if (baseHistoryExists) {
    fs.writeFileSync(historyPath, historyBytes, { flag: 'wx', mode: 0o600 });
  }
  const artifactFd = fs.openSync(artifactPath, fs.constants.O_RDONLY);
  const markerFd = fs.openSync(markerPath, fs.constants.O_RDONLY);
  const historyParentFd = fs.openSync(metadata, fs.constants.O_RDONLY);
  const historyFd = baseHistoryExists
    ? fs.openSync(historyPath, historyWritable ? fs.constants.O_RDWR : fs.constants.O_RDONLY)
    : fs.openSync(metadata, fs.constants.O_RDONLY);
  const historyParentStat = fs.fstatSync(historyParentFd, { bigint: true });
  const historyParentIdentityDigest = existingSchema.digestHistoryParentIdentity({
    dev: historyParentStat.dev.toString(), ino: historyParentStat.ino.toString(),
    uid: Number(historyParentStat.uid), mode: Number(historyParentStat.mode & 0o7777n),
  });
  const close = () => {
    for (const fd of [artifactFd, markerFd, historyParentFd, historyFd]) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    fs.rmSync(rootPath, { recursive: true, force: true });
  };
  const ancestorIdentityDigest = evidence.digestAncestorIdentity({
    schema: evidence.SCHEMAS.ANCESTOR_IDENTITY,
    components: nestedExistingPath ? (() => {
      const stat = fs.statSync(chaptersDir, { bigint: true });
      return [{
        nameSha256: digest(Buffer.from('chapters', 'utf8')),
        dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
        mode: Number(stat.mode & 0o7777n),
      }];
    })() : [],
  });
  const selectedExisting = Array.from({ length: existingCount }, (_, index) => ({
    selectedId: `existing:${index}`,
    action: 'EXISTING',
    path: nestedExistingPath ? `chapters/chapter-${index}.md` : `chapter-${index}.md`,
    revision: digest(afterBytes[index]).slice('sha256:'.length),
    ancestorIdentityDigest,
  }));
  const selection = {
    schema: phaseSchema.SELECTION_SCHEMA,
    kind: 'snapshot_restore',
    selected: [...selectedExisting, {
      selectedId: 'missing:0',
      action: 'MISSING',
      path: 'new.md',
      revision: digest(Buffer.from('missing')).slice('sha256:'.length),
      ancestorIdentityDigest: digest(Buffer.from('missing-ancestor')),
    }],
  };
  const phase = {
    schema: phaseSchema.SCHEMA,
    operationId,
    kind: 'snapshot_restore',
    phase: 'CREATED_RECEIPT',
    artifactDigest: digest(artifactBytes),
    selectionDigest: phaseSchema.digestSelection(selection),
    items: [{
      selectedId: 'missing:0',
      path: 'new.md',
      afterRevision: selection.selected[existingCount].revision,
      ancestorIdentityDigest: selection.selected[existingCount].ancestorIdentityDigest,
      createdIdentityDigest: digest(Buffer.from('created')),
      creationReceiptDigest: digest(Buffer.from('creation')),
      quarantineReceiptDigest: null,
    }],
    preparedHistoryDigest: digest(Buffer.from('prepared')),
    finalReceiptDigest: null,
    existingReceiptSetDigest: null,
    rollbackReceiptDigest: null,
    updatedAt: '2026-08-12T00:00:00.000Z',
  };
  const beforeBindings = selectedExisting.map((item, index) => ({
    selectedId: item.selectedId,
    path: item.path,
    revision: digest(beforeBytes[index]).slice('sha256:'.length),
    ancestorIdentityDigest: item.ancestorIdentityDigest,
    byteLength: beforeBytes[index].length,
    contentDigest: digest(beforeBytes[index]),
  }));
  const beforeIdentities = beforeBindings.map((binding, index) => {
    const stat = fs.statSync(chapterPaths[index], { bigint: true });
    return existingSchema.buildExistingLeafIdentity(binding, {
      dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
      mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink),
      size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
      ctimeNs: stat.ctimeNs.toString(), contentSha256: binding.contentDigest,
    });
  });
  const request = {
    schema: existingSchema.SCHEMAS.REQUEST,
    operationId,
    markerDigest: digest(markerBytes),
    artifactDigest: digest(artifactBytes),
    artifactIdentityDigest: evidence.digestObjectIdentity(objectIdentity(
      fs.fstatSync(artifactFd, { bigint: true }), digest(artifactBytes)
    )),
    artifactByteLength: artifactBytes.length,
    createdReceiptPhaseDigest: evidence.digestObject(phaseSchema.SCHEMA, phase),
    selectionDigest: phase.selectionDigest,
    ...existingSchema.buildBaseHistoryAuthority(historyBytes, baseHistoryExists),
    historyParentIdentityDigest,
    items: selectedExisting.map((item, index) => ({
      selectedId: item.selectedId,
      path: item.path,
      beforeRevision: beforeBindings[index].revision,
      afterRevision: item.revision,
      beforeArtifactOffset: beforeOffsets[index],
      beforeByteLength: beforeBytes[index].length,
      beforeContentDigest: beforeBindings[index].contentDigest,
      afterArtifactOffset: afterOffsets[index],
      afterByteLength: afterBytes[index].length,
      afterContentDigest: digest(afterBytes[index]),
      ancestorIdentityDigest: item.ancestorIdentityDigest,
      beforeLeafIdentityDigest: existingSchema.digestExistingLeafIdentity(
        beforeIdentities[index], beforeBindings[index]
      ),
    })),
  };
  const bound = existingSchema.buildAuthority({
    schema: existingSchema.SCHEMAS.MARKER_AUTHORITY,
    operationId,
    markerDigest: request.markerDigest,
    artifactDigest: request.artifactDigest,
    artifactIdentityDigest: request.artifactIdentityDigest,
    artifactByteLength: request.artifactByteLength,
    baseHistoryDigest: request.baseHistoryDigest,
    baseHistoryByteLength: request.baseHistoryByteLength,
    baseHistoryExists: request.baseHistoryExists,
    baseHistoryContentDigest: request.baseHistoryContentDigest,
    historyParentIdentityDigest: request.historyParentIdentityDigest,
  }, selection, phase, request);
  if (materializeAfter) {
    for (let index = 0; index < existingCount; index += 1) {
      fs.writeFileSync(chapterPaths[index], afterBytes[index]);
    }
  }
  const afterLeafDigests = selectedExisting.map((item, index) => {
    if (!materializeAfter) return digest(Buffer.from(`after-leaf-identity-${index}`));
    const stat = fs.statSync(chapterPaths[index], { bigint: true });
    const binding = bound.request.items[index];
    return existingSchema.digestExistingLeafIdentity(
      existingSchema.buildExistingLeafIdentity(binding, {
        dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
        mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink),
        size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
        ctimeNs: stat.ctimeNs.toString(), contentSha256: binding.afterContentDigest,
      }),
      binding
    );
  });
  const applyTokens = bound.request.items.map((_item, index) => {
    const applyReceipt = existingSchema.buildApplyReceipt(bound, index, afterLeafDigests[index]);
    const controlRecord = existingSchema.encodeControlRecord(
      existingSchema.buildControl(bound, index), bound, index
    );
    return existingSchema.buildApplyToken(
      bound, index, applyReceipt,
      identityForWire(controlRecord, 31 + index * 2),
      identityForWire(existingSchema.encodeApplyReceiptRecord(applyReceipt, bound, index), 32 + index * 2)
    );
  });
  const committed = existingSchema.buildTerminalReceipt(bound, 'COMMITTED', applyTokens);
  const canonicalBundle = existingSchema.buildCanonicalBundle(bound, committed);
  const scoped = lifecycle.createPublicMarkdownNativeLifecycle({
    transportLifecycle: lifecycle.createPublicMarkdownNativeTransport({ helperPath }),
  }).forProject(rootPath);
  return {
    rootPath,
    artifactPath,
    historyPath,
    chapterPaths,
    beforeBytes,
    afterBytes,
    afterLeafIdentityDigests: afterLeafDigests,
    bound,
    applyTokens,
    canonicalBundle,
    descriptors: { artifactFd, markerFd, historyParentFd, historyFd },
    scoped,
    close,
  };
}

function runExistingCanonical(helperPath, item) {
  const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    const bind = schema.encodeRootBind({
      schema: schema.SCHEMAS.ROOT_BIND,
      canonicalRoot: item.rootPath,
      expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
      expectedRecoveryIdentityDigest: directoryIdentityDigest(
        path.join(item.rootPath, '.writcraft', 'recovery')
      ),
    });
    const wire = existingSchema.encodeExecuteCommand(item.bound);
    const identityFields = identity => [
      identity.schema, identity.dev, identity.ino, String(identity.uid),
      String(identity.mode), String(identity.nlink), identity.size,
      identity.mtimeNs, identity.ctimeNs, identity.contentSha256,
    ].join('\t');
    const testAfterTrailer = item.afterLeafIdentityDigests
      .map((afterLeafIdentityDigest, index) => {
        const record = item.canonicalBundle.records[index];
        const token = item.applyTokens[index];
        return `K\tAFTER\t${afterLeafIdentityDigest}\nK\tIDENTITY\t${
          identityFields(token.controlRecordIdentity)}\t${
          identityFields(token.receiptRecordIdentity)}\n`;
      })
      .join('');
    return childProcess.spawnSync(helperPath, [], {
      input: `${bind}${wire}${testAfterTrailer}`,
      encoding: 'utf8',
      stdio: [
        'pipe', 'pipe', 'pipe', rootFd, item.descriptors.artifactFd,
        item.descriptors.markerFd, item.descriptors.historyParentFd, item.descriptors.historyFd,
      ],
    });
  } finally {
    fs.closeSync(rootFd);
  }
}

function assertCanonicalTerminalParity(lines, item) {
  const tokenLines = lines.filter(line => line.startsWith('K\tTOKEN\t'));
  const setLine = lines.find(line => line.startsWith('K\tRECEIPT_SET\t'));
  const terminalLine = lines.find(line => line.startsWith('K\tTERMINAL\t'));
  const responseLine = lines.find(line => line.startsWith('K\tRESPONSE\t'));
  const terminal = existingSchema.buildTerminalReceipt(
    item.bound, 'COMMITTED', item.applyTokens
  );
  assert.strictEqual(tokenLines.length, item.applyTokens.length,
    'native terminal parity must emit one K TOKEN per item');
  assert.ok(setLine, 'native terminal parity must emit one K RECEIPT_SET');
  assert.ok(terminalLine, 'native terminal parity must emit one K TERMINAL');
  assert.ok(responseLine, 'native terminal parity must emit one K RESPONSE');
  tokenLines.forEach((line, index) => {
    const fields = line.split('\t');
    assert.strictEqual(fields.length, 4, `K TOKEN field count mismatch at item ${index}`);
    const expected = item.applyTokens[index];
    assert.strictEqual(fields[2], evidence.digestObject(
      existingSchema.SCHEMAS.APPLY_TOKEN, expected
    ), `K TOKEN digest mismatch at item ${index}`);
    assert.deepStrictEqual(JSON.parse(fields[3]), expected,
      `K TOKEN JSON mismatch at item ${index}`);
  });
  const expectedSet = {
    schema: existingSchema.SCHEMAS.TERMINAL_RECEIPT,
    operationId: item.bound.request.operationId,
    requestDigest: existingSchema.requestDigest(item.bound),
    state: 'COMMITTED',
    items: terminal.items,
  };
  {
    const fields = setLine.split('\t');
    assert.strictEqual(fields.length, 4, 'K RECEIPT_SET field count mismatch');
    assert.strictEqual(fields[2], evidence.digestObject(
      existingSchema.SCHEMAS.TERMINAL_RECEIPT, expectedSet
    ), 'K RECEIPT_SET digest mismatch');
    assert.deepStrictEqual(JSON.parse(fields[3]), expectedSet,
      'K RECEIPT_SET JSON mismatch');
  }
  {
    const fields = terminalLine.split('\t');
    assert.strictEqual(fields.length, 4, 'K TERMINAL field count mismatch');
    const expectedBase = { ...terminal };
    delete expectedBase.terminalReceiptDigest;
    assert.strictEqual(fields[2], terminal.terminalReceiptDigest,
      'K TERMINAL digest mismatch');
    assert.deepStrictEqual(JSON.parse(fields[3]), expectedBase,
      'K TERMINAL JSON mismatch');
  }
  {
    const expectedResult = existingSchema.buildRunResult(
      item.bound, 'E', 'COMMITTED', terminal
    );
    const expectedResponse = existingSchema.encodeRunResponse(
      expectedResult, item.bound, 'E'
    );
    const fields = responseLine.split('\t');
    assert.strictEqual(fields.length, 3, 'K RESPONSE field count mismatch');
    assert.strictEqual(fields[2], digest(Buffer.from(expectedResponse, 'utf8')),
      'K RESPONSE digest mismatch');
  }
}

function runExistingProduction(helperPath, item) {
  const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    const bind = schema.encodeRootBind({
      schema: schema.SCHEMAS.ROOT_BIND,
      canonicalRoot: item.rootPath,
      expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
      expectedRecoveryIdentityDigest: directoryIdentityDigest(
        path.join(item.rootPath, '.writcraft', 'recovery')
      ),
    });
    const wire = existingSchema.encodeExecuteCommand(item.bound);
    return childProcess.spawnSync(helperPath, [], {
      input: `${bind}${wire}`,
      encoding: 'utf8',
      stdio: [
        'pipe', 'pipe', 'pipe', rootFd, item.descriptors.artifactFd,
        item.descriptors.markerFd, item.descriptors.historyParentFd, item.descriptors.historyFd,
      ],
    });
  } finally {
    fs.closeSync(rootFd);
  }
}

function runExistingReconcileProduction(helperPath, item) {
  const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    const bind = schema.encodeRootBind({
      schema: schema.SCHEMAS.ROOT_BIND,
      canonicalRoot: item.rootPath,
      expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
      expectedRecoveryIdentityDigest: directoryIdentityDigest(
        path.join(item.rootPath, '.writcraft', 'recovery')
      ),
    });
    return childProcess.spawnSync(helperPath, [], {
      input: `${bind}${existingSchema.encodeReconcileCommand(item.bound)}`,
      encoding: 'utf8',
      stdio: [
        'pipe', 'pipe', 'pipe', rootFd, item.descriptors.artifactFd,
        item.descriptors.markerFd, item.descriptors.historyParentFd, item.descriptors.historyFd,
      ],
    });
  } finally {
    fs.closeSync(rootFd);
  }
}

function assertCommittedExistingProduction(item, result, authoritySnapshot = null) {
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const parsed = existingSchema.parseRunResponse(
    result.stdout, item.bound, existingSchema.COMMANDS.EXECUTE
  );
  assert.strictEqual(parsed.state, 'COMMITTED');
  assert.ok(parsed.terminalReceipt);
  assert.strictEqual(parsed.terminalReceipt.items.length, 1);
  const terminalItem = parsed.terminalReceipt.items[0];
  const token = terminalItem.applyToken;
  const record = item.canonicalBundle.records[0];
  const names = record.names;
  const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
  const controlPath = path.join(recovery, names.controlBasename);
  const applyPath = path.join(recovery, names.applyReceiptBasename);
  const actualIdentity = (targetPath, bytes) => {
    const stat = fs.statSync(targetPath, { bigint: true });
    return objectIdentity(stat, digest(bytes));
  };
  const actualApplyReceipt = existingSchema.buildApplyReceipt(
    item.bound, 0, token.afterLeafIdentityDigest
  );
  const actualApplyRecord = existingSchema.encodeApplyReceiptRecord(
    actualApplyReceipt, item.bound, 0
  );
  assert.strictEqual(terminalItem.selectedId, 'existing:0');
  assert.strictEqual(terminalItem.finalContentDigest, digest(item.afterBytes[0]));
  assert.strictEqual(token.selectedId, 'existing:0');
  assert.strictEqual(token.controlBasename, names.controlBasename);
  assert.strictEqual(token.receiptBasename, names.applyReceiptBasename);
  assert.strictEqual(token.controlDigest, record.control.controlDigest);
  assert.strictEqual(token.applyReceiptDigest, actualApplyReceipt.receiptDigest);
  assert.strictEqual(token.afterLeafIdentityDigest, terminalItem.finalLeafIdentityDigest);
  assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.afterBytes[0]);
  assert.deepStrictEqual(fs.readFileSync(controlPath, 'utf8'), record.controlRecord);
  assert.deepStrictEqual(fs.readFileSync(applyPath, 'utf8'), actualApplyRecord);
  assert.deepStrictEqual(
    token.controlRecordIdentity,
    actualIdentity(controlPath, Buffer.from(record.controlRecord, 'utf8'))
  );
  assert.deepStrictEqual(
    token.receiptRecordIdentity,
    actualIdentity(applyPath, Buffer.from(actualApplyRecord, 'utf8'))
  );
  const requestItem = item.bound.request.items[0];
  const afterBinding = {
    selectedId: requestItem.selectedId,
    path: requestItem.path,
    revision: requestItem.afterRevision,
    ancestorIdentityDigest: requestItem.ancestorIdentityDigest,
    byteLength: requestItem.afterByteLength,
    contentDigest: requestItem.afterContentDigest,
  };
  const afterLeafIdentity = existingSchema.buildExistingLeafIdentity(
    afterBinding,
    (({ schema: _schema, ...observation }) => observation)(
      actualIdentity(item.chapterPaths[0], item.afterBytes[0])
    )
  );
  assert.strictEqual(
    token.afterLeafIdentityDigest,
    existingSchema.digestExistingLeafIdentity(afterLeafIdentity, afterBinding)
  );
  for (const basename of [
    names.beforeQuarantineBasename,
    names.afterStageBasename,
    names.rollbackReceiptBasename,
  ]) assert.strictEqual(fs.existsSync(path.join(recovery, basename)), false, basename);
  if (authoritySnapshot) assertExistingAuthoritySnapshot(item, authoritySnapshot);
  return parsed;
}

function existingProductionInput(item) {
  const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
  const bind = schema.encodeRootBind({
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: item.rootPath,
    expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
    expectedRecoveryIdentityDigest: directoryIdentityDigest(
      path.join(item.rootPath, '.writcraft', 'recovery')
    ),
  });
  return `${bind}${existingSchema.encodeExecuteCommand(item.bound)}`;
}

function nativeInput(item, command, finalize = null) {
  const bind = schema.encodeRootBind({
    schema: schema.SCHEMAS.ROOT_BIND,
    canonicalRoot: item.rootPath,
    expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
    expectedRecoveryIdentityDigest: directoryIdentityDigest(item.recovery),
  });
  const wire = command === 'FINALIZE_CREATE'
    ? schema.encodeFinalizeCommand(finalize, item.request)
    : schema.encodeCreateCommand(command, item.request);
  return `${bind}${wire}`;
}

function runRawHelper(helperPath, item, input, withArtifact = true) {
  const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
  try {
    return childProcess.spawnSync(helperPath, [], {
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe', rootFd, withArtifact ? item.artifactFd : rootFd],
    });
  } finally {
    fs.closeSync(rootFd);
  }
}

function runPausedHelper({
  helperPath, item, input, syncName, mutation, target, withArtifact = true, existing = false,
}) {
  const driver = String.raw`
    const childProcess = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const [helperPath, rootPath, artifactPath, input64, syncName, mutation, relativeTarget, withArtifact, existing] =
      process.argv.slice(1);
    const sync = path.join(rootPath, '.native-create-sync');
    fs.mkdirSync(sync, { mode: 0o700 });
    const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
    const artifactFd = withArtifact === '1'
      ? fs.openSync(artifactPath, fs.constants.O_RDONLY)
      : rootFd;
    const metadataPath = path.join(rootPath, '.writcraft');
    const markerPath = path.join(metadataPath, 'recovery', 'changes-history-transaction.json');
    const historyPath = path.join(metadataPath, 'changes.json');
    const markerFd = existing === '1' ? fs.openSync(markerPath, fs.constants.O_RDONLY) : rootFd;
    const historyParentFd = existing === '1' ? fs.openSync(metadataPath, fs.constants.O_RDONLY) : rootFd;
    const historyFd = existing === '1'
      ? fs.openSync(fs.existsSync(historyPath) ? historyPath : metadataPath, fs.constants.O_RDONLY)
      : rootFd;
    const child = childProcess.spawn(helperPath, [], {
      stdio: existing === '1'
        ? ['pipe', 'pipe', 'pipe', rootFd, artifactFd, markerFd, historyParentFd, historyFd]
        : ['pipe', 'pipe', 'pipe', rootFd, artifactFd],
      env: { ...process.env, WRITCRAFT_TEST_SYNC_DIR: sync },
    });
    if (artifactFd !== rootFd) fs.closeSync(artifactFd);
    for (const fd of [markerFd, historyParentFd, historyFd]) {
      if (fd !== rootFd) fs.closeSync(fd);
    }
    fs.closeSync(rootFd);
    let stdout = '';
    let stderr = '';
    let pauseSnapshot = null;
    let pauseIdentity = null;
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    let closedResult = null;
    const closed = new Promise(resolve => child.on('close', (status, signal) => {
      closedResult = { status, signal, stdout, stderr };
      resolve(closedResult);
    }));
    child.stdin.end(Buffer.from(input64, 'base64'));
    async function waitFor(target) {
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(target)) {
        if (closedResult) throw new Error('helper closed before sync: ' + JSON.stringify(closedResult));
        if (Date.now() >= deadline) throw new Error('native create sync timeout');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    }
    (async () => {
      await waitFor(path.join(sync, syncName + '.ready'));
      const target = path.join(rootPath, relativeTarget);
      if (mutation.startsWith('observe-state:')) {
        const observed = JSON.parse(mutation.slice('observe-state:'.length));
        pauseSnapshot = Object.fromEntries(Object.entries(observed).map(([key, relativePath]) => {
          const bytes = fs.readFileSync(path.join(rootPath, relativePath));
          return [key, bytes.toString('base64')];
        }));
        pauseIdentity = Object.fromEntries(Object.entries(observed).map(([key, relativePath]) => {
          const stat = fs.statSync(path.join(rootPath, relativePath), { bigint: true });
          return [key, {
            dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
            mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink),
            size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
            ctimeNs: stat.ctimeNs.toString(),
          }];
        }));
      } else if (mutation === 'same-inode-rewrite') {
        const stat = fs.statSync(target);
        fs.writeFileSync(target, Buffer.alloc(stat.size, 0x78));
      } else if (mutation === 'same-inode-same-bytes') {
        const bytes = fs.readFileSync(target);
        fs.writeFileSync(target, bytes);
      } else if (mutation === 'new-inode-exact') {
        const bytes = fs.readFileSync(target);
        const mode = fs.statSync(target).mode & 0o777;
        fs.renameSync(target, target + '.moved');
        fs.writeFileSync(target, bytes, { flag: 'wx', mode });
      } else if (mutation === 'ancestor-replace') {
        const mode = fs.statSync(target).mode & 0o777;
        fs.renameSync(target, target + '-moved');
        fs.mkdirSync(target, { mode });
      } else if (mutation === 'late-foreign') {
        fs.renameSync(target, target + '.moved');
        fs.writeFileSync(target, 'foreign native record\n', { flag: 'wx', mode: 0o600 });
      } else if (mutation === 'foreign-create') {
        fs.writeFileSync(target, 'foreign original-name replacement\n', { flag: 'wx', mode: 0o600 });
      } else {
        throw new Error('unknown mutation');
      }
      fs.writeFileSync(path.join(sync, syncName + '.release'), '', { flag: 'wx', mode: 0o600 });
      const result = await closed;
      result.pauseSnapshot = pauseSnapshot;
      result.pauseIdentity = pauseIdentity;
      process.stdout.write(JSON.stringify(result));
    })().catch(error => {
      try { child.kill('SIGKILL'); } catch (_) {}
      console.error(error.stack || error.message);
      process.exitCode = 1;
    });
  `;
  const result = childProcess.spawnSync(process.execPath, [
    '-e', driver, helperPath, item.rootPath, item.artifactPath,
    Buffer.from(input).toString('base64'), syncName, mutation,
    path.relative(item.rootPath, target), withArtifact ? '1' : '0', existing ? '1' : '0',
  ], { encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

console.log('\nPublic Markdown native lifecycle verification');

const helper = compile('public-markdown-create-helper');
const canonicalHelper = compile('public-markdown-create-helper-canonical', [
  'WRITCRAFT_TEST_EXISTING_CANONICAL',
]);
const pausedExistingHelper = compile('public-markdown-create-helper-existing-preflight-pause', [
  'WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_PREFLIGHT',
]);
const pausedExistingControlHelper = compile('public-markdown-helper-existing-control-pause', [
  'WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_CONTROL',
]);
const existingControlFaultHelpers = [
  ['partial-write', 'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE'],
  ['file-fsync-failure', 'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE'],
  ['path-recheck-failure', 'WRITCRAFT_TEST_CONTROL_PATH_RECHECK_FAILURE'],
  ['directory-fsync-failure', 'WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE'],
].map(([label, definition]) => ({
  label,
  helper: compile(`public-markdown-helper-existing-${label}`, [definition]),
}));
const pausedExistingStageHelper = compile('public-markdown-helper-existing-stage-pause', [
  'WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_STAGE',
]);
const pausedExistingSwapHelper = compile('public-markdown-helper-existing-swap-pause', [
  'WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_SWAP',
]);
const pausedExistingBeforeQuarantineHelper = compile(
  'public-markdown-helper-existing-before-quarantine-pause',
  ['WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_BEFORE_QUARANTINE']
);
const pausedExistingApplyHelper = compile('public-markdown-helper-existing-apply-pause', [
  'WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_APPLY',
]);
const pausedExistingCommitCleanupHelper = compile(
  'public-markdown-helper-existing-commit-cleanup-pause',
  ['WRITCRAFT_TEST_PAUSE_EXISTING_AFTER_COMMIT_CLEANUP']
);
const existingApplyFaultHelpers = [
  ['partial-write', 'WRITCRAFT_TEST_EXISTING_APPLY_PARTIAL_WRITE'],
  ['file-fsync-failure', 'WRITCRAFT_TEST_EXISTING_APPLY_FILE_FSYNC_FAILURE'],
  ['path-recheck-failure', 'WRITCRAFT_TEST_EXISTING_APPLY_PATH_RECHECK_FAILURE'],
  ['directory-fsync-failure', 'WRITCRAFT_TEST_EXISTING_APPLY_DIR_FSYNC_FAILURE'],
].map(([label, definition]) => ({
  label,
  helper: compile(`public-markdown-helper-existing-apply-${label}`, [definition]),
}));
const existingStageFaultHelpers = [
  ['partial-write', 'WRITCRAFT_TEST_EXISTING_STAGE_PARTIAL_WRITE'],
  ['file-fsync-failure', 'WRITCRAFT_TEST_EXISTING_STAGE_FILE_FSYNC_FAILURE'],
  ['path-recheck-failure', 'WRITCRAFT_TEST_EXISTING_STAGE_PATH_RECHECK_FAILURE'],
  ['directory-fsync-failure', 'WRITCRAFT_TEST_EXISTING_STAGE_DIR_FSYNC_FAILURE'],
].map(([label, definition]) => ({
  label,
  helper: compile(`public-markdown-helper-existing-stage-${label}`, [definition]),
}));

if (process.env.WRC_A1B_CANONICAL_ONLY !== '1') {
  if (process.env.WRC_A1B_E2A_BASELINE === '1') {
    test('A1b E-2a production baseline present History is UNKNOWN without mutation', () => {
      const item = existingProductionFixture(helper, 1, false, true);
      try {
        const result = runExistingProduction(helper, item);
        assert.strictEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /^P\tOK\nE\tRESULT\tUNKNOWN\t/);
        assert.ok(fs.existsSync(item.chapterPaths[0]));
        assert.ok(fs.existsSync(item.artifactPath));
      } finally { item.close(); }
    });

    test('A1b E-2a production baseline absent History is UNKNOWN without mutation', () => {
      const item = existingProductionFixture(helper, 1, false, false);
      try {
        const result = runExistingProduction(helper, item);
        assert.strictEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /^P\tOK\nE\tRESULT\tUNKNOWN\t/);
        assert.ok(!fs.existsSync(item.historyPath));
        assert.ok(fs.existsSync(item.chapterPaths[0]));
      } finally { item.close(); }
    });

    test('A1b E-2a writable held History fd rejects before mutation', () => {
      const item = existingProductionFixture(helper, 1, false, true, true);
      try {
        const result = runExistingProduction(helper, item);
        assert.notStrictEqual(result.status, 0);
        assert.ok(fs.existsSync(item.chapterPaths[0]));
        assert.ok(fs.existsSync(item.artifactPath));
      } finally { item.close(); }
    });

    test('A1b E-2a unsafe History parent mode rejects before mutation', () => {
      const item = existingProductionFixture(helper, 1, false, true);
      try {
        fs.chmodSync(path.join(item.rootPath, '.writcraft'), 0o755);
        const result = runExistingProduction(helper, item);
        assert.notStrictEqual(result.status, 0);
        assert.ok(fs.existsSync(item.chapterPaths[0]));
        assert.ok(fs.existsSync(item.artifactPath));
      } finally { item.close(); }
    });
  }

  if (process.env.WRC_A1B_E2A_PAUSED === '1') {
    const pausedCases = [
      ['present History same-inode rewrite', true, 'same-inode-rewrite', '.writcraft/changes.json'],
      ['present History exact-byte new inode', true, 'new-inode-exact', '.writcraft/changes.json'],
      ['absent History foreign create', false, 'foreign-create', '.writcraft/changes.json'],
      ['public leaf same-inode rewrite', true, 'same-inode-rewrite', 'chapter-0.md'],
      ['public leaf exact-byte new inode', true, 'new-inode-exact', 'chapter-0.md'],
      ['marker same-inode rewrite', true, 'same-inode-rewrite', '.writcraft/recovery/changes-history-transaction.json'],
      ['marker exact-byte new inode', true, 'new-inode-exact', '.writcraft/recovery/changes-history-transaction.json'],
      ['recovery directory ancestor replacement', true, 'ancestor-replace', '.writcraft/recovery'],
    ];
    for (const [label, baseHistoryExists, mutation, target] of pausedCases) {
      test(`A1b E-2a paused ${label} rejects drift before UNKNOWN`, () => {
        const item = existingProductionFixture(pausedExistingHelper, 1, false, baseHistoryExists);
        const input = (() => {
          const rootFd = fs.openSync('/', fs.constants.O_RDONLY);
          try {
            const bind = schema.encodeRootBind({
              schema: schema.SCHEMAS.ROOT_BIND,
              canonicalRoot: item.rootPath,
              expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
              expectedRecoveryIdentityDigest: directoryIdentityDigest(
                path.join(item.rootPath, '.writcraft', 'recovery')
              ),
            });
            return `${bind}${existingSchema.encodeExecuteCommand(item.bound)}`;
          } finally { fs.closeSync(rootFd); }
        })();
        try {
          const result = runPausedHelper({
            helperPath: pausedExistingHelper,
            item,
            input,
            syncName: 'existing-after-preflight',
            mutation,
            target: path.join(item.rootPath, target),
            existing: true,
          });
          assert.notStrictEqual(result.status, 0, result.stdout);
          assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED)/.test(result.stdout));
          assert.ok(fs.existsSync(item.chapterPaths[0]));
          if (mutation !== 'ancestor-replace') assert.ok(fs.existsSync(item.artifactPath));
          assert.ok(!fs.readdirSync(path.join(item.rootPath, '.writcraft', 'recovery'))
            .some(name => name.includes('native-existing-control') || name.includes('native-existing-apply')));
        } finally { item.close(); }
      });
    }
    test('A1b E-2a paused nested public ancestor replacement rejects drift before UNKNOWN', () => {
      const item = existingProductionFixture(
        pausedExistingHelper, 1, false, true, false, true
      );
      const input = (() => {
        const bind = schema.encodeRootBind({
          schema: schema.SCHEMAS.ROOT_BIND,
          canonicalRoot: item.rootPath,
          expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
          expectedRecoveryIdentityDigest: directoryIdentityDigest(
            path.join(item.rootPath, '.writcraft', 'recovery')
          ),
        });
        return `${bind}${existingSchema.encodeExecuteCommand(item.bound)}`;
      })();
      try {
        const result = runPausedHelper({
          helperPath: pausedExistingHelper,
          item,
          input,
          syncName: 'existing-after-preflight',
          mutation: 'ancestor-replace',
          target: path.join(item.rootPath, 'chapters'),
          existing: true,
        });
        assert.notStrictEqual(result.status, 0, result.stdout);
        assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED)/.test(result.stdout));
        assert.ok(fs.existsSync(item.artifactPath));
      } finally { item.close(); }
    });
  }

  if (process.env.WRC_A1B_E2B_CONTROL === '1') {
    test('A1b E-2b control publication reaches COMMITTED with exact records', () => {
      const item = existingProductionFixture(helper);
      const beforeArtifact = fs.readFileSync(item.artifactPath);
      const beforeHistory = fs.readFileSync(item.historyPath);
      const authoritySnapshot = snapshotExistingAuthority(item);
      try {
        const result = runExistingProduction(helper, item);
        assertCommittedExistingProduction(item, result, authoritySnapshot);
        assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
        assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
      } finally { item.close(); }
    });

    for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
      test(`A1b E-2b control identity drift (${mutation}) rejects and preserves foreign`, () => {
        const item = existingProductionFixture(pausedExistingControlHelper);
        const controlName = item.canonicalBundle.records[0].names.controlBasename;
        const input = (() => {
          const bind = schema.encodeRootBind({
            schema: schema.SCHEMAS.ROOT_BIND,
            canonicalRoot: item.rootPath,
            expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
            expectedRecoveryIdentityDigest: directoryIdentityDigest(
              path.join(item.rootPath, '.writcraft', 'recovery')
            ),
          });
          return `${bind}${existingSchema.encodeExecuteCommand(item.bound)}`;
        })();
        const beforeChapter = fs.readFileSync(item.chapterPaths[0]);
        const beforeArtifact = fs.readFileSync(item.artifactPath);
        try {
          const result = runPausedHelper({
            helperPath: pausedExistingControlHelper,
            item,
            input,
            syncName: 'existing-after-control',
            mutation,
            target: path.join(item.rootPath, '.writcraft', 'recovery', controlName),
            existing: true,
          });
          assert.notStrictEqual(result.status, 0, result.stdout);
          assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED)/.test(result.stdout));
          assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), beforeChapter);
          assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
          assert.strictEqual(fs.existsSync(path.join(item.rootPath, '.writcraft', 'recovery', controlName)), true);
          assert.strictEqual(fs.existsSync(path.join(
            item.rootPath, '.writcraft', 'recovery', controlName + '.moved'
          )), mutation === 'new-inode-exact');
          assert.strictEqual(fs.readdirSync(path.join(item.rootPath, '.writcraft', 'recovery'))
            .some(name => name.startsWith('.changes-history-native-existing-apply.')), false);
        } finally { item.close(); }
      });
    }

    for (const { label, helper: faultHelper } of existingControlFaultHelpers) {
      test(`A1b E-2b control fault (${label}) never mutates public or foreign state`, () => {
        const item = existingProductionFixture(faultHelper);
        const beforeChapter = fs.readFileSync(item.chapterPaths[0]);
        const beforeArtifact = fs.readFileSync(item.artifactPath);
        const beforeHistory = fs.readFileSync(item.historyPath);
        try {
          const result = runExistingProduction(faultHelper, item);
          assert.notStrictEqual(result.status, 0, result.stdout);
          assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
          assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), beforeChapter);
          assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
          assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
          const recoveryEntries = fs.readdirSync(path.join(item.rootPath, '.writcraft', 'recovery'));
          assert.strictEqual(recoveryEntries.some(name =>
            name.startsWith('.changes-history-native-existing-apply.')), false);
          assert.strictEqual(recoveryEntries.some(name =>
            name.startsWith('.changes-history-native-existing-control.')), false);
        } finally { item.close(); }
      });
    }

    test('A1b E-2b multi-item production E remains UNKNOWN without records', () => {
      const item = existingProductionFixture(helper, 2, false);
      const beforeChapters = item.chapterPaths.map(chapterPath => fs.readFileSync(chapterPath));
      const beforeArtifact = fs.readFileSync(item.artifactPath);
      const beforeHistory = fs.readFileSync(item.historyPath);
      try {
        const result = runExistingProduction(helper, item);
        assert.strictEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /^P\tOK\nE\tRESULT\tUNKNOWN\t/);
        item.chapterPaths.forEach((chapterPath, index) =>
          assert.deepStrictEqual(fs.readFileSync(chapterPath), beforeChapters[index]));
        assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
        assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
        assert.strictEqual(fs.readdirSync(path.join(item.rootPath, '.writcraft', 'recovery'))
          .some(name => name.startsWith('.changes-history-native-existing-')), false);
      } finally { item.close(); }
    });

    if (process.env.WRC_A1B_E2B_STAGE === '1') {
      test('A1b E-2b stage publication reaches COMMITTED with exact records', () => {
        const item = existingProductionFixture(helper);
        const beforeArtifact = fs.readFileSync(item.artifactPath);
        const beforeHistory = fs.readFileSync(item.historyPath);
        const authoritySnapshot = snapshotExistingAuthority(item);
        try {
          const result = runExistingProduction(helper, item);
          assertCommittedExistingProduction(item, result, authoritySnapshot);
          assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
          assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
        } finally { item.close(); }
      });

      for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
        test(`A1b E-2b stage identity drift (${mutation}) fails closed and preserves foreign`, () => {
          const item = existingProductionFixture(pausedExistingStageHelper);
          const stageName = item.canonicalBundle.records[0].names.afterStageBasename;
          const input = (() => {
            const bind = schema.encodeRootBind({
              schema: schema.SCHEMAS.ROOT_BIND,
              canonicalRoot: item.rootPath,
              expectedRootIdentityDigest: directoryIdentityDigest(item.rootPath),
              expectedRecoveryIdentityDigest: directoryIdentityDigest(
                path.join(item.rootPath, '.writcraft', 'recovery')
              ),
            });
            return `${bind}${existingSchema.encodeExecuteCommand(item.bound)}`;
          })();
          const beforeChapter = fs.readFileSync(item.chapterPaths[0]);
          const beforeArtifact = fs.readFileSync(item.artifactPath);
          const beforeHistory = fs.readFileSync(item.historyPath);
          try {
            const result = runPausedHelper({
              helperPath: pausedExistingStageHelper,
              item,
              input,
              syncName: 'existing-after-stage',
              mutation,
              target: path.join(item.rootPath, '.writcraft', 'recovery', stageName),
              existing: true,
            });
            assert.notStrictEqual(result.status, 0, result.stdout);
            assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
            assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), beforeChapter);
            assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
            assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
            assert.strictEqual(fs.existsSync(path.join(
              item.rootPath, '.writcraft', 'recovery', stageName
            )), true);
            assert.strictEqual(fs.existsSync(path.join(
              item.rootPath, '.writcraft', 'recovery', stageName + '.moved'
            )), mutation === 'new-inode-exact');
          } finally { item.close(); }
        });
      }

      for (const { label, helper: faultHelper } of existingStageFaultHelpers) {
        test(`A1b E-2b stage fault (${label}) leaves no public mutation`, () => {
          const item = existingProductionFixture(faultHelper);
          const names = item.canonicalBundle.records[0].names;
          const recoveryPath = path.join(item.rootPath, '.writcraft', 'recovery');
          const controlPath = path.join(recoveryPath, names.controlBasename);
          const stagePath = path.join(recoveryPath, names.afterStageBasename);
          const beforePath = path.join(recoveryPath, names.beforeQuarantineBasename);
          const applyPath = path.join(recoveryPath, names.applyReceiptBasename);
          const rollbackPath = path.join(recoveryPath, names.rollbackReceiptBasename);
          const beforeChapter = fs.readFileSync(item.chapterPaths[0]);
          const beforeArtifact = fs.readFileSync(item.artifactPath);
          const beforeHistory = fs.readFileSync(item.historyPath);
          const requestItem = item.bound.request.items[0];
          const expectedAfter = beforeArtifact.subarray(
            requestItem.afterArtifactOffset,
            requestItem.afterArtifactOffset + requestItem.afterByteLength
          );
          try {
            const result = runExistingProduction(faultHelper, item);
            assert.notStrictEqual(result.status, 0, result.stdout);
            assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
            assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), beforeChapter);
            assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
            assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
            assert.strictEqual(fs.existsSync(controlPath), true);
            assert.strictEqual(fs.existsSync(stagePath), true);
            assert.strictEqual(fs.existsSync(beforePath), false);
            assert.strictEqual(fs.existsSync(applyPath), false);
            assert.strictEqual(fs.existsSync(rollbackPath), false);
            const stageBytes = fs.readFileSync(stagePath);
            if (label === 'partial-write') {
              assert.ok(stageBytes.length > 0 && stageBytes.length < requestItem.afterByteLength);
            } else {
              assert.deepStrictEqual(stageBytes, expectedAfter);
            }
          } finally { item.close(); }
        });
      }

      if (process.env.WRC_A1B_E2B_SWAP === '1') {
        const recoveryRelative = path.join('.writcraft', 'recovery');
        const swapInput = item => existingProductionInput(item);

        for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
          test(`A1b E-2b after-swap public drift (${mutation}) fails closed`, () => {
            const item = existingProductionFixture(pausedExistingSwapHelper);
            const names = item.canonicalBundle.records[0].names;
            const recoveryPath = path.join(item.rootPath, recoveryRelative);
            const chapterPath = item.chapterPaths[0];
            const controlPath = path.join(recoveryPath, names.controlBasename);
            const stagePath = path.join(recoveryPath, names.afterStageBasename);
            const beforePath = path.join(recoveryPath, names.beforeQuarantineBasename);
            const beforeArtifact = fs.readFileSync(item.artifactPath);
            try {
              const result = runPausedHelper({
                helperPath: pausedExistingSwapHelper,
                item,
                input: swapInput(item),
                syncName: 'existing-after-swap',
                mutation,
                target: chapterPath,
                existing: true,
              });
              assert.notStrictEqual(result.status, 0, result.stdout);
              assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
              assert.deepStrictEqual(fs.readFileSync(chapterPath),
                mutation === 'same-inode-rewrite' ? Buffer.alloc(item.afterBytes[0].length, 0x78)
                  : item.afterBytes[0]);
              assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
              assert.strictEqual(fs.existsSync(controlPath), true);
              assert.strictEqual(fs.existsSync(stagePath), true);
              assert.strictEqual(fs.existsSync(beforePath), false);
              assert.strictEqual(fs.existsSync(path.join(recoveryPath, names.applyReceiptBasename)), false);
              assert.strictEqual(fs.existsSync(path.join(recoveryPath, names.rollbackReceiptBasename)), false);
            } finally { item.close(); }
          });
        }

        for (const targetKind of ['public-after', 'before-locator']) {
          for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
            test(`A1b E-2b after-before-quarantine ${targetKind} drift (${mutation}) fails closed`, () => {
              const item = existingProductionFixture(pausedExistingBeforeQuarantineHelper);
              const names = item.canonicalBundle.records[0].names;
              const recoveryPath = path.join(item.rootPath, recoveryRelative);
              const target = targetKind === 'public-after'
                ? item.chapterPaths[0]
                : path.join(recoveryPath, names.beforeQuarantineBasename);
              const controlPath = path.join(recoveryPath, names.controlBasename);
              const beforePath = path.join(recoveryPath, names.beforeQuarantineBasename);
              try {
                const result = runPausedHelper({
                  helperPath: pausedExistingBeforeQuarantineHelper,
                  item,
                  input: swapInput(item),
                  syncName: 'existing-after-before-quarantine',
                  mutation,
                  target,
                  existing: true,
                });
                assert.notStrictEqual(result.status, 0, result.stdout);
                assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
                assert.strictEqual(fs.existsSync(controlPath), true);
                assert.strictEqual(fs.existsSync(beforePath), true);
                assert.strictEqual(fs.existsSync(path.join(recoveryPath, names.applyReceiptBasename)), false);
                assert.strictEqual(fs.existsSync(path.join(recoveryPath, names.rollbackReceiptBasename)), false);
                if (mutation === 'new-inode-exact') {
                  assert.strictEqual(fs.existsSync(`${target}.moved`), true);
                }
              } finally { item.close(); }
            });
          }
        }

        test('A1b E-2b swap pause observes after/public and before/stage bytes before self-rollback', () => {
          const item = existingProductionFixture(pausedExistingBeforeQuarantineHelper);
          const names = item.canonicalBundle.records[0].names;
          const recoveryPath = path.join(item.rootPath, recoveryRelative);
          const publicRelative = path.relative(item.rootPath, item.chapterPaths[0]);
          const beforeRelative = path.relative(
            item.rootPath, path.join(recoveryPath, names.beforeQuarantineBasename)
          );
          const snapshotMutation = `observe-state:${JSON.stringify({
            public: publicRelative,
            before: beforeRelative,
          })}`;
          try {
            const result = runPausedHelper({
              helperPath: pausedExistingBeforeQuarantineHelper,
              item,
              input: swapInput(item),
              syncName: 'existing-after-before-quarantine',
              mutation: snapshotMutation,
              target: item.chapterPaths[0],
              existing: true,
            });
            assert.strictEqual(result.status, 0, result.stderr || result.stdout);
            assert.deepStrictEqual(Buffer.from(result.pauseSnapshot.public, 'base64'), item.afterBytes[0]);
            assert.deepStrictEqual(Buffer.from(result.pauseSnapshot.before, 'base64'), item.beforeBytes[0]);
            assert.match(result.stdout, /^P\tOK\nE\tRESULT\tUNKNOWN\t/);
            assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.beforeBytes[0]);
            assert.strictEqual(fs.readdirSync(recoveryPath).some(name =>
              name.startsWith('.changes-history-native-existing-')), false);
          } finally { item.close(); }
        });
      }

      if (process.env.WRC_A1B_E2B_APPLY === '1') {
        const recoveryRelative = path.join('.writcraft', 'recovery');
        const applyExpected = (item, observation) => {
          const binding = item.bound.request.items[0];
          const identity = existingSchema.buildExistingLeafIdentity({
            selectedId: binding.selectedId,
            path: binding.path,
            revision: binding.afterContentDigest.slice('sha256:'.length),
            ancestorIdentityDigest: binding.ancestorIdentityDigest,
            byteLength: binding.afterByteLength,
            contentDigest: binding.afterContentDigest,
          }, {
            ...observation,
            contentSha256: binding.afterContentDigest,
          });
          const leafDigest = existingSchema.digestExistingLeafIdentity(identity, {
            selectedId: binding.selectedId,
            path: binding.path,
            revision: binding.afterContentDigest.slice('sha256:'.length),
            ancestorIdentityDigest: binding.ancestorIdentityDigest,
            byteLength: binding.afterByteLength,
            contentDigest: binding.afterContentDigest,
          });
          return existingSchema.encodeApplyReceiptRecord(
            existingSchema.buildApplyReceipt(item.bound, 0, leafDigest), item.bound, 0
          );
        };

        test('A1b E-2b apply pause publishes canonical receipt before self-rollback', () => {
          const item = existingProductionFixture(pausedExistingApplyHelper);
          const names = item.canonicalBundle.records[0].names;
          const recoveryPath = path.join(item.rootPath, recoveryRelative);
          const publicRelative = path.relative(item.rootPath, item.chapterPaths[0]);
          const beforeRelative = path.join(recoveryRelative, names.beforeQuarantineBasename);
          const applyRelative = path.join(recoveryRelative, names.applyReceiptBasename);
          const input = existingProductionInput(item);
          try {
            const result = runPausedHelper({
              helperPath: pausedExistingApplyHelper,
              item,
              input,
              syncName: 'existing-after-apply',
              mutation: `observe-state:${JSON.stringify({
                public: publicRelative, before: beforeRelative, apply: applyRelative,
              })}`,
              target: item.chapterPaths[0],
              existing: true,
            });
            assert.strictEqual(result.status, 0, result.stderr || result.stdout);
            assert.deepStrictEqual(Buffer.from(result.pauseSnapshot.public, 'base64'), item.afterBytes[0]);
            assert.deepStrictEqual(Buffer.from(result.pauseSnapshot.before, 'base64'), item.beforeBytes[0]);
            assert.strictEqual(
              Buffer.from(result.pauseSnapshot.apply, 'base64').toString('utf8'),
              applyExpected(item, result.pauseIdentity.public)
            );
            assert.match(result.stdout, /^P\tOK\nE\tRESULT\tUNKNOWN\t/);
            assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.beforeBytes[0]);
            assert.strictEqual(fs.readdirSync(recoveryPath).some(name =>
              name.startsWith('.changes-history-native-existing-')), false);
          } finally { item.close(); }
        });

        for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
          test(`A1b E-2b apply receipt drift (${mutation}) fails closed`, () => {
            const item = existingProductionFixture(pausedExistingApplyHelper);
            const names = item.canonicalBundle.records[0].names;
            const recoveryPath = path.join(item.rootPath, recoveryRelative);
            const applyPath = path.join(recoveryPath, names.applyReceiptBasename);
            try {
              const result = runPausedHelper({
                helperPath: pausedExistingApplyHelper,
                item,
                input: existingProductionInput(item),
                syncName: 'existing-after-apply',
                mutation,
                target: applyPath,
                existing: true,
              });
              assert.notStrictEqual(result.status, 0, result.stdout);
              assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
              assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.afterBytes[0]);
              assert.strictEqual(fs.existsSync(applyPath), true);
              assert.strictEqual(fs.existsSync(path.join(
                recoveryPath, names.beforeQuarantineBasename
              )), true);
              assert.strictEqual(fs.existsSync(path.join(
                recoveryPath, names.controlBasename
              )), true);
              if (mutation === 'new-inode-exact') assert.strictEqual(fs.existsSync(`${applyPath}.moved`), true);
            } finally { item.close(); }
          });
        }

        for (const { label, helper: faultHelper } of existingApplyFaultHelpers) {
          test(`A1b E-2b apply fault (${label}) preserves exact committed-risk authority`, () => {
            const item = existingProductionFixture(faultHelper);
            const names = item.canonicalBundle.records[0].names;
            const recoveryPath = path.join(item.rootPath, recoveryRelative);
            const applyPath = path.join(recoveryPath, names.applyReceiptBasename);
            const controlPath = path.join(recoveryPath, names.controlBasename);
            const beforePath = path.join(recoveryPath, names.beforeQuarantineBasename);
            try {
              const result = runExistingProduction(faultHelper, item);
              assert.notStrictEqual(result.status, 0, result.stdout);
              assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
              assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.afterBytes[0]);
              assert.strictEqual(fs.existsSync(controlPath), true);
              assert.strictEqual(fs.existsSync(beforePath), true);
              assert.strictEqual(fs.existsSync(applyPath), true);
              const applyBytes = fs.readFileSync(applyPath);
              if (label === 'partial-write') {
                assert.strictEqual(applyBytes.length, 1);
              } else {
                assert.strictEqual(applyBytes.toString('utf8'), applyExpected(item, (() => {
                  const stat = fs.statSync(item.chapterPaths[0], { bigint: true });
                  return {
                    dev: stat.dev.toString(), ino: stat.ino.toString(), uid: Number(stat.uid),
                    mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink),
                    size: stat.size.toString(), mtimeNs: stat.mtimeNs.toString(),
                    ctimeNs: stat.ctimeNs.toString(),
                  };
                })()));
              }
              assert.strictEqual(fs.existsSync(path.join(
                recoveryPath, names.rollbackReceiptBasename
              )), false);
            } finally { item.close(); }
          });
        }
      }
  }
}

if (process.env.WRC_A1B_E2B_COMMIT_CLEANUP === '1') {
  for (const [targetKind, targetLabel] of [
    ['public', 'public after'],
    ['control', 'control record'],
    ['apply', 'apply record'],
    ['marker', 'transaction marker'],
  ]) {
    for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
      test(`A1b E-2b commit-cleanup ${targetLabel} ${mutation} fails closed`, () => {
        const item = existingProductionFixture(pausedExistingCommitCleanupHelper);
        const names = item.canonicalBundle.records[0].names;
        const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
        const target = targetKind === 'public'
          ? item.chapterPaths[0]
          : path.join(recovery, targetKind === 'control'
            ? names.controlBasename
            : targetKind === 'apply'
              ? names.applyReceiptBasename
              : 'changes-history-transaction.json');
        const beforeArtifact = fs.readFileSync(item.artifactPath);
        const beforeHistory = fs.readFileSync(item.historyPath);
        try {
          const result = runPausedHelper({
            helperPath: pausedExistingCommitCleanupHelper,
            item,
            input: existingProductionInput(item),
            syncName: 'existing-after-commit-cleanup',
            mutation,
            target,
            existing: true,
          });
          assert.notStrictEqual(result.status, 0, result.stdout);
          assert.ok(!/E\tRESULT\t(?:UNKNOWN|COMMITTED|UNCOMMITTED)/.test(result.stdout));
          assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
          assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
          assert.strictEqual(fs.existsSync(path.join(recovery, names.controlBasename)), true);
          assert.strictEqual(fs.existsSync(path.join(recovery, names.applyReceiptBasename)), true);
          assert.strictEqual(fs.existsSync(path.join(recovery, names.beforeQuarantineBasename)), false);
          assert.strictEqual(fs.existsSync(path.join(recovery, names.afterStageBasename)), false);
          assert.strictEqual(fs.existsSync(path.join(recovery, names.rollbackReceiptBasename)), false);
          if (targetKind !== 'public') {
            assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.afterBytes[0]);
          }
          if (mutation === 'new-inode-exact') {
            assert.strictEqual(fs.existsSync(`${target}.moved`), true);
          }
        } finally { item.close(); }
      });
    }
  }
}

test('A1b production E consumes valid marker/artifact/history descriptor authority and commits', () => {
    const item = existingProductionFixture(helper);
    try {
      const result = item.scoped.existingRestore.execute(item.bound, item.descriptors);
      assert.strictEqual(result.command, 'E');
      assert.strictEqual(result.state, 'COMMITTED');
      assert.ok(result.terminalReceipt);
      assert.strictEqual(result.terminalReceipt.items.length, 1);
      const terminalItem = result.terminalReceipt.items[0];
      const token = terminalItem.applyToken;
      const record = item.canonicalBundle.records[0];
      const names = record.names;
      const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
      const controlPath = path.join(recovery, names.controlBasename);
      const applyPath = path.join(recovery, names.applyReceiptBasename);
      assert.strictEqual(terminalItem.selectedId, 'existing:0');
      assert.strictEqual(terminalItem.finalContentDigest, digest(item.afterBytes[0]));
      assert.strictEqual(token.selectedId, 'existing:0');
      assert.strictEqual(token.controlBasename, names.controlBasename);
      assert.strictEqual(token.receiptBasename, names.applyReceiptBasename);
      assert.strictEqual(token.controlDigest, record.control.controlDigest);
      const actualApplyReceipt = existingSchema.buildApplyReceipt(
        item.bound, 0, token.afterLeafIdentityDigest
      );
      const actualApplyRecord = existingSchema.encodeApplyReceiptRecord(
        actualApplyReceipt, item.bound, 0
      );
      assert.strictEqual(token.applyReceiptDigest, actualApplyReceipt.receiptDigest);
      assert.strictEqual(token.afterLeafIdentityDigest, terminalItem.finalLeafIdentityDigest);
      assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.afterBytes[0]);
      assert.deepStrictEqual(fs.readFileSync(controlPath, 'utf8'), record.controlRecord);
      assert.deepStrictEqual(fs.readFileSync(applyPath, 'utf8'), actualApplyRecord);
      const actualIdentity = (targetPath, bytes) => {
        const stat = fs.statSync(targetPath, { bigint: true });
        return objectIdentity(stat, digest(bytes));
      };
      assert.deepStrictEqual(
        token.controlRecordIdentity,
        actualIdentity(controlPath, Buffer.from(record.controlRecord, 'utf8'))
      );
      assert.deepStrictEqual(
        token.receiptRecordIdentity,
        actualIdentity(applyPath, Buffer.from(actualApplyRecord, 'utf8'))
      );
      const afterRequestItem = item.bound.request.items[0];
      const afterBinding = {
        selectedId: afterRequestItem.selectedId,
        path: afterRequestItem.path,
        revision: afterRequestItem.afterRevision,
        ancestorIdentityDigest: afterRequestItem.ancestorIdentityDigest,
        byteLength: afterRequestItem.afterByteLength,
        contentDigest: afterRequestItem.afterContentDigest,
      };
      const afterLeafIdentity = existingSchema.buildExistingLeafIdentity(
        afterBinding,
        (({ schema: _schema, ...observation }) => observation)(
          actualIdentity(item.chapterPaths[0], item.afterBytes[0])
        )
      );
      assert.strictEqual(
        token.afterLeafIdentityDigest,
        existingSchema.digestExistingLeafIdentity(afterLeafIdentity, afterBinding)
      );
      assert.deepStrictEqual(fs.readFileSync(item.artifactPath), Buffer.concat([
        item.beforeBytes[0], item.afterBytes[0],
      ]));
      assert.strictEqual(fs.readFileSync(item.historyPath, 'utf8'), '{}\n');
      for (const basename of [
        names.beforeQuarantineBasename,
        names.afterStageBasename,
        names.rollbackReceiptBasename,
      ]) assert.strictEqual(fs.existsSync(path.join(recovery, basename)), false, basename);
    } finally {
      item.close();
    }
  });
}

if (process.env.WRC_A1B_E3_R === '1') {
  test('A1b E-3 fresh R rebuilds a committed one-leaf E after response loss', () => {
    const item = existingProductionFixture(helper);
    try {
      const oldScoped = item.scoped;
      const lostPrimary = oldScoped.existingRestore.execute(item.bound, item.descriptors);
      assert.strictEqual(lostPrimary.state, 'COMMITTED');
      const expectedTerminal = lostPrimary.terminalReceipt;
      const beforeArtifact = fs.readFileSync(item.artifactPath);
      const beforeHistory = fs.readFileSync(item.historyPath);
      const authoritySnapshot = snapshotExistingAuthority(item);

      const freshLifecycle = lifecycle.createPublicMarkdownNativeLifecycle({
        transportLifecycle: lifecycle.createPublicMarkdownNativeTransport({
          helperPath: helper,
        }),
      });
      const freshScoped = freshLifecycle.forProject(item.rootPath);
      const rawReconcile = runExistingReconcileProduction(helper, item);
      assert.strictEqual(rawReconcile.status, 0, rawReconcile.stderr || rawReconcile.stdout);
      const reconciled = freshScoped.existingRestore.reconcile(item.bound, item.descriptors);
      assert.strictEqual(reconciled.command, existingSchema.COMMANDS.RECONCILE);
      assert.strictEqual(reconciled.state, 'COMMITTED');
      assert.deepStrictEqual(reconciled.terminalReceipt, expectedTerminal);
      assert.deepStrictEqual(fs.readFileSync(item.chapterPaths[0]), item.afterBytes[0]);
      assert.deepStrictEqual(fs.readFileSync(item.artifactPath), beforeArtifact);
      assert.deepStrictEqual(fs.readFileSync(item.historyPath), beforeHistory);
      assertExistingAuthoritySnapshot(item, authoritySnapshot);
    } finally {
      item.close();
    }
  });

  for (const targetKind of ['public', 'control', 'apply', 'marker']) {
    for (const mutation of ['same-inode-rewrite', 'new-inode-exact']) {
      test(`A1b E-3 fresh R ${targetKind} ${mutation} returns UNKNOWN and preserves drift`, () => {
      const item = existingProductionFixture(helper);
      try {
        assert.strictEqual(item.scoped.existingRestore.execute(item.bound, item.descriptors).state,
          'COMMITTED');
        const names = item.canonicalBundle.records[0].names;
        const recovery = path.join(item.rootPath, '.writcraft', 'recovery');
        const target = targetKind === 'public'
          ? item.chapterPaths[0]
          : path.join(recovery, targetKind === 'control'
            ? names.controlBasename
            : targetKind === 'apply'
              ? names.applyReceiptBasename
              : 'changes-history-transaction.json');
        const original = fs.readFileSync(target);
        let expected = original;
        if (mutation === 'same-inode-rewrite') {
          expected = Buffer.alloc(original.length, 0x78);
          fs.writeFileSync(target, expected);
        } else {
          const mode = fs.statSync(target).mode & 0o777;
          fs.renameSync(target, `${target}.moved`);
          fs.writeFileSync(target, original, { flag: 'wx', mode });
        }
        const freshLifecycle = lifecycle.createPublicMarkdownNativeLifecycle({
          transportLifecycle: lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper }),
        });
        const result = freshLifecycle.forProject(item.rootPath).existingRestore.reconcile(
          item.bound, item.descriptors
        );
        assert.strictEqual(result.command, existingSchema.COMMANDS.RECONCILE);
        assert.strictEqual(result.state, 'UNKNOWN');
        assert.deepStrictEqual(fs.readFileSync(target), expected);
        if (mutation === 'new-inode-exact') {
          assert.strictEqual(fs.existsSync(`${target}.moved`), true);
          assert.deepStrictEqual(fs.readFileSync(`${target}.moved`), original);
        }
      } finally { item.close(); }
      });
    }
  }

  for (const locatorKind of ['beforeQuarantineBasename', 'afterStageBasename']) {
    test(`A1b E-3 fresh R preserves foreign ${locatorKind} transient as UNKNOWN`, () => {
      const item = existingProductionFixture(helper);
      try {
        assert.strictEqual(item.scoped.existingRestore.execute(item.bound, item.descriptors).state,
          'COMMITTED');
        const transient = path.join(
          item.rootPath,
          '.writcraft',
          'recovery',
          item.canonicalBundle.records[0].names[locatorKind]
        );
        const foreign = Buffer.from('foreign existing transient\n');
        fs.writeFileSync(transient, foreign, { flag: 'wx', mode: 0o600 });
        const freshLifecycle = lifecycle.createPublicMarkdownNativeLifecycle({
          transportLifecycle: lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper }),
        });
        const result = freshLifecycle.forProject(item.rootPath).existingRestore.reconcile(
          item.bound, item.descriptors
        );
        assert.strictEqual(result.command, existingSchema.COMMANDS.RECONCILE);
        assert.strictEqual(result.state, 'UNKNOWN');
        assert.deepStrictEqual(fs.readFileSync(transient), foreign);
      } finally { item.close(); }
    });
  }
}

test('A1b native canonical control/apply parity matches the JS golden byte-for-byte', () => {
  const item = existingProductionFixture(canonicalHelper);
  try {
    const result = runExistingCanonical(canonicalHelper, item);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = String(result.stdout).trimEnd().split('\n');
    const nameLine = lines.find(line => line.startsWith('K\tNAME\t'));
    const controlLine = lines.find(line => line.startsWith('K\tCONTROL\t'));
    const applyLine = lines.find(line => line.startsWith('K\tAPPLY\t'));
    const identityLine = lines.find(line => line.startsWith('K\tIDENTITY\t'));
    assert.ok(nameLine, 'test-mode native output must contain K NAME');
    assert.ok(controlLine, 'test-mode native output must contain K CONTROL');
    assert.ok(applyLine, 'test-mode native output must contain K APPLY');
    assert.ok(identityLine, 'test-mode native output must contain K IDENTITY');
    assert.strictEqual(
      nameLine.slice('K\tNAME\t'.length),
      item.canonicalBundle.records[0].names.controlBasename
    );
    assert.strictEqual(
      `${controlLine.slice('K\tCONTROL\t'.length)}\n`,
      item.canonicalBundle.records[0].controlRecord
    );
    assert.strictEqual(
      `${applyLine.slice('K\tAPPLY\t'.length)}\n`,
      item.canonicalBundle.records[0].applyRecord
    );
    const identityFields = identity => [
      identity.schema, identity.dev, identity.ino, String(identity.uid),
      String(identity.mode), String(identity.nlink), identity.size,
      identity.mtimeNs, identity.ctimeNs, identity.contentSha256,
    ].join('\t');
    assert.strictEqual(
      identityLine,
      `K\tIDENTITY\t${identityFields(item.applyTokens[0].controlRecordIdentity)}\t${
        identityFields(item.applyTokens[0].receiptRecordIdentity)}`
    );
    assertCanonicalTerminalParity(lines, item);
  } finally {
    item.close();
  }
});

test('A1b native canonical control/apply parity preserves two-item order and bytes', () => {
  const item = existingProductionFixture(canonicalHelper, 2, false);
  try {
    const result = runExistingCanonical(canonicalHelper, item);
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    const lines = String(result.stdout).trimEnd().split('\n');
    const nameLines = lines.filter(line => line.startsWith('K\tNAME\t'));
    const controlLines = lines.filter(line => line.startsWith('K\tCONTROL\t'));
    const applyLines = lines.filter(line => line.startsWith('K\tAPPLY\t'));
    const identityLines = lines.filter(line => line.startsWith('K\tIDENTITY\t'));
    assert.strictEqual(nameLines.length, 2, 'two-item fixture must emit exactly two K NAME records');
    assert.strictEqual(controlLines.length, 2, 'two-item fixture must emit exactly two K CONTROL records');
    assert.strictEqual(applyLines.length, 2, 'two-item fixture must emit exactly two K APPLY records');
    assert.strictEqual(identityLines.length, 2, 'two-item fixture must emit exactly two K IDENTITY records');
    assert.strictEqual(item.canonicalBundle.records.length, 2);
    for (let index = 0; index < 2; index += 1) {
      const record = item.canonicalBundle.records[index];
      assert.strictEqual(
        nameLines[index].slice('K\tNAME\t'.length),
        record.names.controlBasename,
        `K NAME order mismatch at item ${index}`
      );
      assert.strictEqual(
        `${controlLines[index].slice('K\tCONTROL\t'.length)}\n`,
        record.controlRecord,
        `K CONTROL parity mismatch at item ${index}`
      );
      assert.strictEqual(
        `${applyLines[index].slice('K\tAPPLY\t'.length)}\n`,
        record.applyRecord,
        `K APPLY parity mismatch at item ${index}`
      );
      const identityFields = identity => [
        identity.schema, identity.dev, identity.ino, String(identity.uid),
        String(identity.mode), String(identity.nlink), identity.size,
        identity.mtimeNs, identity.ctimeNs, identity.contentSha256,
      ].join('\t');
      assert.strictEqual(
        identityLines[index],
        `K\tIDENTITY\t${identityFields(item.applyTokens[index].controlRecordIdentity)}\t${
          identityFields(item.applyTokens[index].receiptRecordIdentity)}`,
        `K IDENTITY parity mismatch at item ${index}`
      );
    }
    assertCanonicalTerminalParity(lines, item);
  } finally {
    item.close();
  }
});

test('strict helper is present in the signed native build allowlist', () => {
  assert.strictEqual(typeof lifecycle.createPublicMarkdownNativeLifecycle, 'function');
  assert.strictEqual(typeof lifecycle.createPublicMarkdownNativeTransport, 'function');
  assert.deepStrictEqual(nativeBuild.NATIVE_HELPERS.publicMarkdownCreate, {
    sourceName: 'public-markdown-create-helper.c',
    outputName: 'public-markdown-create-helper',
  });
});

test('production scoped adapter exposes the complete reconciliation lifecycle shape', () => {
  const item = fixture(helper, 'production shape\n');
  try {
    const scoped = lifecycle.createPublicMarkdownNativeLifecycle({ helperPath: helper })
      .forProject(item.rootPath);
    for (const method of [
      'create', 'createMissingJournal', 'reconcile', 'verifyCreate',
      'finalizeCreate', 'reconcileFinalize',
      'cleanupCreate', 'reconcileCreateCleanup', 'ackCreateCleanup',
      'quarantine', 'reconcileUndo', 'restoreQuarantine', 'finalizeUndo', 'ackUndo',
    ]) assert.strictEqual(typeof scoped[method], 'function', method);
  } finally { closeFixture(item); }
});

test('production scoped adapter rejects an Undo accessor without invoking it', () => {
  let getterCalls = 0;
  const method = () => null;
  const rawScoped = {
    create: method,
    reconcile: method,
    finalizeCreate: method,
    reconcileFinalize: method,
    cleanupCreate: method,
    reconcileCreateCleanup: method,
    ackCreateCleanup: method,
    quarantine: method,
    restoreQuarantine: method,
    finalizeUndo: method,
    ackUndo: method,
  };
  Object.defineProperty(rawScoped, 'reconcileUndo', {
    enumerable: true,
    get() { getterCalls += 1; return method; },
  });
  Object.freeze(rawScoped);
  const high = lifecycle.createPublicMarkdownNativeLifecycle({
    transportLifecycle: Object.freeze({
      forProject() { return rawScoped; },
    }),
  });
  assert.throws(() => high.forProject('/unused'), error =>
    error?.code === 'PUBLIC_MARKDOWN_HELPER_UNAVAILABLE');
  assert.strictEqual(getterCalls, 0);
});

test('production adapter maps held-fd CREATE and private final ACK to public envelopes', () => {
  const item = fixture(helper, 'production adapter\n');
  try {
    const scoped = lifecycle.createPublicMarkdownNativeLifecycle({ helperPath: helper })
      .forProject(item.rootPath);
    const publicRequest = publicCreateRequest(item);
    const created = scoped.create(publicRequest, item.request, item.artifactFd);
    assert.strictEqual(created.status, 'CREATED');
    assert.strictEqual(created.projectId, publicRequest.projectId);
    assert.strictEqual(Object.hasOwn(created.items[0], 'bytes'), false);
    assert.deepStrictEqual(
      scoped.verifyCreate(publicRequest, item.request, item.artifactFd, created),
      created
    );
    assert.deepStrictEqual(
      scoped.reconcile(publicRequest, item.request, item.artifactFd),
      created
    );
    const control = schema.buildControl(item.request, 0);
    const receipt = schema.buildReceipt(control, created.items[0].createdIdentityDigest);
    const token = schema.buildToken(item.request, 0, receipt);
    const finalize = {
      schema: schema.SCHEMAS.FINALIZE_REQUEST,
      operationId: item.request.operationId,
      artifactDigest: item.request.artifactDigest,
      selectionDigest: item.request.selectionDigest,
      historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
      tokens: [token],
    };
    const absent = scoped.reconcileFinalize(finalize, item.request, publicRequest);
    assert.strictEqual(absent.status, 'ABSENT');
    assert.strictEqual(absent.receiptName, null);
    const finalized = scoped.finalizeCreate(finalize, item.request, publicRequest);
    assert.strictEqual(finalized.status, 'FINALIZED');
    assert.strictEqual(finalized.finalReceiptDigest,
      schema.buildFinalAck(finalize, item.request).finalAckDigest);
    assert.deepStrictEqual(
      scoped.reconcileFinalize(finalize, item.request, publicRequest),
      finalized
    );
  } finally { closeFixture(item); }
});

test('production adapter accepts only fresh native RECONCILE truth after lost CREATE response', () => {
  const fault = compile('public-markdown-production-drop', [
    'WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE',
  ]);
  const item = fixture(fault, 'production response loss\n');
  try {
    const scoped = lifecycle.createPublicMarkdownNativeLifecycle({ helperPath: fault })
      .forProject(item.rootPath);
    const created = scoped.create(publicCreateRequest(item), item.request, item.artifactFd);
    assert.strictEqual(created.status, 'CREATED');
    assert(fs.readFileSync(path.join(item.rootPath, 'created.md')).equals(item.bytes));
  } finally { closeFixture(item); }
});

test('CREATE writes exact artifact bytes and fresh RECONCILE proves COMMITTED', () => {
  const item = fixture(helper);
  try {
    const result = item.scoped.create(item.request, item.artifactFd);
    assert.strictEqual(result.state, 'COMMITTED');
    assert(fs.readFileSync(path.join(item.rootPath, 'created.md')).equals(item.bytes));
    const truth = item.scoped.reconcile(item.request);
    assert.strictEqual(truth.state, 'COMMITTED');
    assert.deepStrictEqual(truth.tokens, result.tokens);
  } finally { closeFixture(item); }
});

test('batch CREATE binds two non-overlapping artifact ranges in selection order', () => {
  const first = Buffer.from('first\n');
  const second = Buffer.from('second\n');
  const item = fixture(helper, Buffer.concat([first, second]).toString('utf8'));
  try {
    const ancestor = item.request.items[0].ancestorIdentityDigest;
    item.request = schema.assertCreateRequest({
      ...item.request,
      items: [{
        selectedId: 'missing_first', path: 'first.md', artifactOffset: 0,
        byteLength: first.length, contentDigest: digest(first), ancestorIdentityDigest: ancestor,
      }, {
        selectedId: 'missing_second', path: 'second.md', artifactOffset: first.length,
        byteLength: second.length, contentDigest: digest(second), ancestorIdentityDigest: ancestor,
      }],
    });
    const result = item.scoped.create(item.request, item.artifactFd);
    assert.strictEqual(result.state, 'COMMITTED');
    assert.deepStrictEqual(result.tokens.map(token => token.selectedId), [
      'missing_first', 'missing_second',
    ]);
    assert(fs.readFileSync(path.join(item.rootPath, 'first.md')).equals(first));
    assert(fs.readFileSync(path.join(item.rootPath, 'second.md')).equals(second));
  } finally { closeFixture(item); }
});

test('committed response loss uses a fresh RECONCILE and never replays CREATE', () => {
  const fault = compile('public-markdown-create-drop', ['WRITCRAFT_TEST_DROP_COMMITTED_RESPONSE']);
  const item = fixture(fault, 'response loss\n');
  try {
    const result = item.scoped.create(item.request, item.artifactFd);
    assert.strictEqual(result.command, 'RECONCILE');
    assert.strictEqual(result.state, 'COMMITTED');
    assert(fs.readFileSync(path.join(item.rootPath, 'created.md')).equals(item.bytes));
  } finally { closeFixture(item); }
});

test('pre-O_EXCL response loss reconciles exact controls to UNCOMMITTED', () => {
  const fault = compile('public-markdown-create-pre-excl', ['WRITCRAFT_TEST_CRASH_PRE_EXCL']);
  const item = fixture(fault, 'pre excl\n');
  try {
    const result = item.scoped.create(item.request, item.artifactFd);
    assert.strictEqual(result.command, 'RECONCILE');
    assert.strictEqual(result.state, 'UNCOMMITTED');
    assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
    assert.strictEqual(
      fs.readdirSync(item.recovery).some(name => name.startsWith('.changes-history-native-create-')),
      false
    );
  } finally { closeFixture(item); }
});

test('preexisting foreign current control is preserved and cannot return UNCOMMITTED', () => {
  const item = fixture(helper, 'foreign current control\n');
  try {
    const names = schema.recordNames(item.request, 0);
    const control = path.join(item.recovery, names.controlBasename);
    fs.writeFileSync(control, 'foreign deterministic control\n', { flag: 'wx', mode: 0o600 });
    assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' && error?.transactionState === 'UNKNOWN');
    assert.strictEqual(fs.readFileSync(control, 'utf8'), 'foreign deterministic control\n');
    assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
  } finally { closeFixture(item); }
});

for (const fault of [
  {
    label: 'partial control write',
    macro: 'WRITCRAFT_TEST_CONTROL_PARTIAL_WRITE',
    state: 'UNKNOWN',
    residue: true,
  },
  {
    label: 'control file-fsync failure',
    macro: 'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE',
    state: 'UNCOMMITTED',
    residue: false,
  },
  {
    label: 'control path-recheck failure',
    macro: 'WRITCRAFT_TEST_CONTROL_PATH_RECHECK_FAILURE',
    state: 'UNCOMMITTED',
    residue: false,
  },
  {
    label: 'control directory-fsync failure',
    macro: 'WRITCRAFT_TEST_CONTROL_DIR_FSYNC_FAILURE',
    state: 'UNCOMMITTED',
    residue: false,
  },
]) {
  test(`${fault.label} reconciles the current deterministic name exactly`, () => {
    const faultHelper = compile(`public-markdown-${fault.macro.toLowerCase()}`, [fault.macro]);
    const item = fixture(faultHelper, `${fault.label}\n`);
    try {
      const names = schema.recordNames(item.request, 0);
      const control = path.join(item.recovery, names.controlBasename);
      if (fault.state === 'UNKNOWN') {
        assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
          error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' && error?.transactionState === 'UNKNOWN');
      } else {
        const result = item.scoped.create(item.request, item.artifactFd);
        assert.strictEqual(result.state, fault.state);
      }
      assert.strictEqual(fs.existsSync(control), fault.residue);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
    } finally { closeFixture(item); }
  });
}

for (const mutation of ['same-inode-same-bytes', 'new-inode-exact']) {
  test(`failed control write cleanup preserves real ${mutation} replacement`, () => {
    const faultHelper = compile(`public-markdown-control-owned-${mutation}`, [
      'WRITCRAFT_TEST_CONTROL_FILE_FSYNC_FAILURE',
      'WRITCRAFT_TEST_PAUSE_CONTROL_FAILURE_BEFORE_CLEANUP',
    ]);
    const item = fixture(faultHelper, `control owned ${mutation}\n`);
    try {
      const names = schema.recordNames(item.request, 0);
      const control = path.join(item.recovery, names.controlBasename);
      const result = runPausedHelper({
        helperPath: faultHelper,
        item,
        input: nativeInput(item, 'CREATE'),
        syncName: 'control-failure-before-cleanup',
        mutation,
        target: control,
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /C\tRESULT\tUNKNOWN\t/);
      assert.strictEqual(fs.existsSync(control), true);
      if (mutation === 'new-inode-exact') assert.strictEqual(fs.existsSync(`${control}.moved`), true);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
    } finally { closeFixture(item); }
  });
}

test('late control replacement during UNCOMMITTED cleanup is preserved and returns UNKNOWN', () => {
  const fault = compile('public-markdown-create-late-control-cleanup', [
    'WRITCRAFT_TEST_CRASH_PRE_EXCL',
    'WRITCRAFT_TEST_LATE_CONTROL_CLEANUP_REPLACEMENT',
  ]);
  const item = fixture(fault, 'late cleanup replacement\n');
  try {
    assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' && error?.transactionState === 'UNKNOWN');
    const names = schema.recordNames(item.request, 0);
    assert.strictEqual(
      fs.readFileSync(path.join(item.recovery, names.controlBasename), 'utf8'),
      'foreign control replacement\n'
    );
    assert.strictEqual(
      fs.existsSync(path.join(item.recovery, '.changes-history-cleanup.test-held-control')),
      true
    );
    assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
  } finally { closeFixture(item); }
});

for (const window of [
  { macro: 'WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_RENAME', syncName: 'cleanup-after-rename' },
  { macro: 'WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_UNLINK', syncName: 'cleanup-after-unlink' },
  { macro: 'WRITCRAFT_TEST_PAUSE_CLEANUP_AFTER_FSYNC', syncName: 'cleanup-after-fsync' },
]) {
  test(`${window.syncName} original-name replacement prevents UNCOMMITTED`, () => {
    const crash = compile(`public-markdown-${window.syncName}-prepare`, ['WRITCRAFT_TEST_CRASH_PRE_EXCL']);
    const paused = compile(`public-markdown-${window.syncName}`, [window.macro]);
    const item = fixture(paused, `${window.syncName}\n`);
    try {
      const prepared = runRawHelper(crash, item, nativeInput(item, 'CREATE'));
      assert.notStrictEqual(prepared.status, 0);
      const names = schema.recordNames(item.request, 0);
      const control = path.join(item.recovery, names.controlBasename);
      assert.strictEqual(fs.existsSync(control), true);
      const result = runPausedHelper({
        helperPath: paused,
        item,
        input: nativeInput(item, 'RECONCILE'),
        syncName: window.syncName,
        mutation: 'foreign-create',
        target: control,
        withArtifact: false,
      });
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      assert.match(result.stdout, /R\tRESULT\tUNKNOWN\t/);
      assert.strictEqual(fs.readFileSync(control, 'utf8'), 'foreign original-name replacement\n');
    } finally { closeFixture(item); }
  });
}

test('partial write remains UNKNOWN and is never path-deleted', () => {
  const fault = compile('public-markdown-create-partial', ['WRITCRAFT_TEST_PARTIAL_WRITE']);
  const item = fixture(fault, 'partial bytes\n');
  try {
    assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' && error?.transactionState === 'UNKNOWN');
    const created = path.join(item.rootPath, 'created.md');
    assert.strictEqual(fs.existsSync(created), true);
    assert.strictEqual(fs.statSync(created).size, 1);
  } finally { closeFixture(item); }
});

test('FINALIZE_CREATE verifies original authority and durably returns exact final ACK', () => {
  const item = fixture(helper, 'finalize me\n');
  try {
    const created = item.scoped.create(item.request, item.artifactFd);
    const finalize = {
      schema: schema.SCHEMAS.FINALIZE_REQUEST,
      operationId: item.request.operationId,
      artifactDigest: item.request.artifactDigest,
      selectionDigest: item.request.selectionDigest,
      historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
      tokens: created.tokens,
    };
    const ack = item.scoped.finalizeCreate(finalize, item.request);
    assert.deepStrictEqual(ack, schema.buildFinalAck(finalize, item.request));
    assert.strictEqual(
      fs.existsSync(path.join(item.recovery, schema.finalRecordName(finalize, item.request))),
      true
    );
  } finally { closeFixture(item); }
});

test('FINALIZE_CREATE response loss retries only the same deterministic final authority', () => {
  const fault = compile('public-markdown-final-drop', ['WRITCRAFT_TEST_DROP_FINAL_RESPONSE']);
  const item = fixture(fault, 'final response loss\n');
  try {
    const created = item.scoped.create(item.request, item.artifactFd);
    const finalize = {
      schema: schema.SCHEMAS.FINALIZE_REQUEST,
      operationId: item.request.operationId,
      artifactDigest: item.request.artifactDigest,
      selectionDigest: item.request.selectionDigest,
      historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
      tokens: created.tokens,
    };
    assert.deepStrictEqual(
      item.scoped.finalizeCreate(finalize, item.request),
      schema.buildFinalAck(finalize, item.request)
    );
    assert.strictEqual(
      fs.readdirSync(item.recovery)
        .filter(name => name.startsWith('.changes-history-native-create-final.')).length,
      1
    );
  } finally { closeFixture(item); }
});

test('moved or duplicated final ACK record cannot authorize finalization', () => {
  for (const mode of ['moved', 'duplicate']) {
    const item = fixture(helper, `${mode} final ACK\n`);
    try {
      const created = item.scoped.create(item.request, item.artifactFd);
      const finalize = {
        schema: schema.SCHEMAS.FINALIZE_REQUEST,
        operationId: item.request.operationId,
        artifactDigest: item.request.artifactDigest,
        selectionDigest: item.request.selectionDigest,
        historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
        tokens: created.tokens,
      };
      item.scoped.finalizeCreate(finalize, item.request);
      const expected = path.join(item.recovery, schema.finalRecordName(finalize, item.request));
      const hostile = path.join(
        item.recovery,
        `.changes-history-native-create-final.${'f'.repeat(64)}`
      );
      if (mode === 'moved') fs.renameSync(expected, hostile);
      else fs.copyFileSync(expected, hostile, fs.constants.COPYFILE_EXCL);
      assert.throws(() => item.scoped.finalizeCreate(finalize, item.request), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' &&
          error?.transactionState === 'COMMITTED');
      assert.strictEqual(fs.existsSync(hostile), true);
    } finally { closeFixture(item); }
  }
});

test('wrong-basename duplicate receipt blocks FINALIZE_CREATE', () => {
  const item = fixture(helper, 'finalize duplicate receipt\n');
  try {
    const created = item.scoped.create(item.request, item.artifactFd);
    const receipt = path.join(item.recovery, created.tokens[0].receiptBasename);
    const duplicate = path.join(
      item.recovery,
      `.changes-history-native-create-receipt.${'f'.repeat(64)}`
    );
    fs.copyFileSync(receipt, duplicate, fs.constants.COPYFILE_EXCL);
    const finalize = {
      schema: schema.SCHEMAS.FINALIZE_REQUEST,
      operationId: item.request.operationId,
      artifactDigest: item.request.artifactDigest,
      selectionDigest: item.request.selectionDigest,
      historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
      tokens: created.tokens,
    };
    assert.throws(() => item.scoped.finalizeCreate(finalize, item.request), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' &&
        error?.transactionState === 'COMMITTED');
    assert.strictEqual(
      fs.existsSync(path.join(item.recovery, schema.finalRecordName(finalize, item.request))),
      false
    );
  } finally { closeFixture(item); }
});

for (const window of [
  {
    label: 'records to final ACK write',
    macro: 'WRITCRAFT_TEST_PAUSE_FINALIZE_AFTER_RECORDS',
    syncName: 'finalize-after-records',
    finalPresent: false,
  },
  {
    label: 'durable final ACK to response',
    macro: 'WRITCRAFT_TEST_PAUSE_FINALIZE_AFTER_ACK',
    syncName: 'finalize-after-ack',
    finalPresent: true,
  },
]) {
  for (const mutation of ['same-inode-rewrite', 'new-inode-exact', 'late-foreign']) {
    test(`${window.label} rejects real ${mutation} record drift`, () => {
      const paused = compile(`public-markdown-${window.syncName}-${mutation}`, [window.macro]);
      const item = fixture(helper, `${window.label} ${mutation}\n`);
      try {
        const created = item.scoped.create(item.request, item.artifactFd);
        const finalize = {
          schema: schema.SCHEMAS.FINALIZE_REQUEST,
          operationId: item.request.operationId,
          artifactDigest: item.request.artifactDigest,
          selectionDigest: item.request.selectionDigest,
          historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
          tokens: created.tokens,
        };
        const token = created.tokens[0];
        const targetName = mutation === 'new-inode-exact'
          ? token.receiptBasename
          : token.controlBasename;
        const result = runPausedHelper({
          helperPath: paused,
          item,
          input: nativeInput(item, 'FINALIZE_CREATE', finalize),
          syncName: window.syncName,
          mutation,
          target: path.join(item.recovery, targetName),
          withArtifact: false,
        });
        assert.notStrictEqual(result.status, 0);
        assert.strictEqual(result.stdout.includes('F\tOK\tACKED\t'), false);
        assert.strictEqual(
          fs.existsSync(path.join(item.recovery, schema.finalRecordName(finalize, item.request))),
          window.finalPresent
        );
      } finally { closeFixture(item); }
    });
  }
}

for (const [label, definition, expectedSize] of [
  ['post-O_EXCL crash', 'WRITCRAFT_TEST_CRASH_POST_EXCL', 0],
  ['pre-file-fsync crash', 'WRITCRAFT_TEST_CRASH_FILE_FSYNC', null],
  ['pre-parent-fsync crash', 'WRITCRAFT_TEST_CRASH_PARENT_FSYNC', null],
  ['pre-receipt crash', 'WRITCRAFT_TEST_CRASH_RECEIPT', null],
]) {
  test(`${label} remains UNKNOWN and preserves the exact created inode`, () => {
    const fault = compile(`public-markdown-${definition.toLowerCase()}`, [definition]);
    const item = fixture(fault, `${label}\n`);
    try {
      assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' && error?.transactionState === 'UNKNOWN');
      const created = path.join(item.rootPath, 'created.md');
      assert.strictEqual(fs.existsSync(created), true);
      if (expectedSize !== null) assert.strictEqual(fs.statSync(created).size, expectedSize);
    } finally { closeFixture(item); }
  });
}

for (const [label, definition] of [
  ['post-file-fsync crash', 'WRITCRAFT_TEST_CRASH_AFTER_FILE_FSYNC'],
  ['post-parent-fsync crash', 'WRITCRAFT_TEST_CRASH_AFTER_PARENT_FSYNC'],
]) {
  test(`${label} remains UNKNOWN without a formal receipt`, () => {
    const fault = compile(`public-markdown-${definition.toLowerCase()}`, [definition]);
    const item = fixture(fault, `${label}\n`);
    try {
      assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' && error?.transactionState === 'UNKNOWN');
      assert(fs.readFileSync(path.join(item.rootPath, 'created.md')).equals(item.bytes));
    } finally { closeFixture(item); }
  });
}

test('post-receipt response loss fresh-reconciles COMMITTED without replaying CREATE', () => {
  const fault = compile('public-markdown-post-receipt', ['WRITCRAFT_TEST_CRASH_AFTER_RECEIPT']);
  const item = fixture(fault, 'post receipt\n');
  try {
    const result = item.scoped.create(item.request, item.artifactFd);
    assert.strictEqual(result.command, 'RECONCILE');
    assert.strictEqual(result.state, 'COMMITTED');
    assert(fs.readFileSync(path.join(item.rootPath, 'created.md')).equals(item.bytes));
  } finally { closeFixture(item); }
});

for (const window of [
  {
    label: 'parent-fsync to receipt',
    macro: 'WRITCRAFT_TEST_PAUSE_CREATE_AFTER_PARENT_FSYNC',
    syncName: 'create-after-parent-fsync',
  },
  {
    label: 'receipt to response',
    macro: 'WRITCRAFT_TEST_PAUSE_CREATE_AFTER_RECEIPT',
    syncName: 'create-after-receipt',
  },
]) {
  for (const mutation of ['same-inode-rewrite', 'new-inode-exact', 'ancestor-replace']) {
    test(`${window.label} rejects real ${mutation} drift as UNKNOWN`, () => {
      const paused = compile(`public-markdown-${window.syncName}-${mutation}`, [window.macro]);
      const item = fixture(paused, `${window.label} ${mutation}\n`);
      try {
        let target = path.join(item.rootPath, 'created.md');
        if (mutation === 'ancestor-replace') {
          target = bindNestedRequest(item, ['chapters', 'section']);
        }
        const result = runPausedHelper({
          helperPath: paused,
          item,
          input: nativeInput(item, 'CREATE'),
          syncName: window.syncName,
          mutation,
          target,
        });
        assert.strictEqual(result.status, 0, result.stderr || result.stdout);
        assert.match(result.stdout, /C\tRESULT\tUNKNOWN\t/);
        const truth = lifecycle.createPublicMarkdownNativeTransport({ helperPath: helper })
          .forProject(item.rootPath).reconcile(item.request);
        assert.strictEqual(truth.state, 'UNKNOWN');
      } finally { closeFixture(item); }
    });
  }
}

test('same-inode rewrite after receipt makes fresh reconciliation UNKNOWN', () => {
  const item = fixture(helper, 'same inode A\n');
  try {
    item.scoped.create(item.request, item.artifactFd);
    const created = path.join(item.rootPath, 'created.md');
    const before = fs.statSync(created);
    fs.writeFileSync(created, Buffer.alloc(item.bytes.length, 0x78));
    const after = fs.statSync(created);
    assert.strictEqual(after.ino, before.ino);
    assert.strictEqual(item.scoped.reconcile(item.request).state, 'UNKNOWN');
    assert.strictEqual(fs.statSync(created).ino, before.ino);
  } finally { closeFixture(item); }
});

test('late foreign receipt replacement is never accepted or removed', () => {
  const item = fixture(helper, 'late receipt\n');
  try {
    const created = item.scoped.create(item.request, item.artifactFd);
    const receipt = path.join(item.recovery, created.tokens[0].receiptBasename);
    const moved = `${receipt}.moved`;
    fs.renameSync(receipt, moved);
    fs.writeFileSync(receipt, 'foreign receipt\n', { flag: 'wx', mode: 0o600 });
    assert.strictEqual(item.scoped.reconcile(item.request).state, 'UNKNOWN');
    assert.strictEqual(fs.readFileSync(receipt, 'utf8'), 'foreign receipt\n');
    assert.strictEqual(fs.existsSync(moved), true);
  } finally { closeFixture(item); }
});

test('moved-only or duplicated formal receipt never authorizes COMMITTED', () => {
  for (const mode of ['moved-only', 'duplicate']) {
    const item = fixture(helper, `${mode} receipt\n`);
    try {
      const created = item.scoped.create(item.request, item.artifactFd);
      const receipt = path.join(item.recovery, created.tokens[0].receiptBasename);
      const hostile = path.join(
        item.recovery,
        `.changes-history-native-create-receipt.${'f'.repeat(64)}`
      );
      if (mode === 'moved-only') fs.renameSync(receipt, hostile);
      else fs.copyFileSync(receipt, hostile, fs.constants.COPYFILE_EXCL);
      assert.strictEqual(item.scoped.reconcile(item.request).state, 'UNKNOWN');
      assert.strictEqual(fs.existsSync(hostile), true);
      assert.strictEqual(fs.existsSync(receipt), mode === 'duplicate');
    } finally { closeFixture(item); }
  }
});

test('project-root replacement cannot redirect CREATE into a foreign tree', () => {
  const item = fixture(helper, 'root drift\n');
  const moved = `${item.rootPath}-moved`;
  try {
    fs.renameSync(item.rootPath, moved);
    fs.mkdirSync(item.rootPath, { mode: 0o700 });
    fs.mkdirSync(path.join(item.rootPath, '.writcraft', 'recovery'), {
      recursive: true,
      mode: 0o700,
    });
    fs.chmodSync(path.join(item.rootPath, '.writcraft', 'recovery'), 0o700);
    fs.writeFileSync(path.join(item.rootPath, 'created.md'), 'foreign\n');
    assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.readFileSync(path.join(item.rootPath, 'created.md'), 'utf8'), 'foreign\n');
    assert.strictEqual(fs.existsSync(path.join(moved, 'created.md')), false);
  } finally { closeFixture(item); }
});

for (const [label, replacedIndex] of [
  ['public ancestor replacement', 0],
  ['final parent replacement', 1],
]) {
  test(`${label} fails closed before leaf mutation`, () => {
    const item = fixture(helper, `${label}\n`);
    try {
      bindNestedRequest(item, ['chapters', 'section']);
      const target = path.join(item.rootPath, ...['chapters', 'section'].slice(0, replacedIndex + 1));
      const moved = `${target}-moved`;
      fs.renameSync(target, moved);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fs.existsSync(path.join(target, 'created.md')), false);
      assert.strictEqual(fs.existsSync(path.join(moved, 'created.md')), false);
    } finally { closeFixture(item); }
  });
}

test('pre-existing leaf replacement survives O_EXCL conflict untouched', () => {
  const item = fixture(helper, 'leaf replacement source\n');
  const leaf = path.join(item.rootPath, 'created.md');
  try {
    fs.writeFileSync(leaf, 'foreign leaf\n', { flag: 'wx' });
    assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.readFileSync(leaf, 'utf8'), 'foreign leaf\n');
  } finally { closeFixture(item); }
});

test('late foreign control replacement is never accepted or removed', () => {
  const item = fixture(helper, 'late control\n');
  try {
    const created = item.scoped.create(item.request, item.artifactFd);
    const control = path.join(item.recovery, created.tokens[0].controlBasename);
    const moved = `${control}.moved`;
    fs.renameSync(control, moved);
    fs.writeFileSync(control, 'foreign control\n', { flag: 'wx', mode: 0o600 });
    assert.strictEqual(item.scoped.reconcile(item.request).state, 'UNKNOWN');
    assert.strictEqual(fs.readFileSync(control, 'utf8'), 'foreign control\n');
    assert.strictEqual(fs.existsSync(moved), true);
  } finally { closeFixture(item); }
});

test('duplicate exact control under a wrong basename blocks reconciliation', () => {
  const item = fixture(helper, 'duplicate control\n');
  try {
    const created = item.scoped.create(item.request, item.artifactFd);
    const control = path.join(item.recovery, created.tokens[0].controlBasename);
    const duplicate = path.join(
      item.recovery,
      `.changes-history-native-create-control.${'f'.repeat(64)}`
    );
    fs.copyFileSync(control, duplicate, fs.constants.COPYFILE_EXCL);
    assert.strictEqual(item.scoped.reconcile(item.request).state, 'UNKNOWN');
    assert.strictEqual(fs.existsSync(control), true);
    assert.strictEqual(fs.existsSync(duplicate), true);
  } finally { closeFixture(item); }
});

test('cross-command and malformed helper output cannot mint terminal truth', () => {
  const item = fixture(helper, 'adapter hostile\n');
  let calls = 0;
  const fake = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: helper,
    spawnSync(_helperPath, _args, options) {
      calls += 1;
      const letter = calls === 1 ? 'R' : 'R';
      const state = calls === 1 ? 'UNCOMMITTED' : 'UNKNOWN';
      const code = state === 'UNKNOWN' ? 'UNKNOWN' : '-';
      return {
        status: 0,
        signal: null,
        stdout: Buffer.from(
          `P\tOK\n${letter}\tRESULT\t${state}\t${item.request.operationId}\t` +
          `${item.request.artifactDigest}\t${item.request.precreatePhaseDigest}\t` +
          `${item.request.selectionDigest}\t0\t${code}\n`
        ),
        stderr: Buffer.alloc(0),
      };
    },
  }).forProject(item.rootPath);
  try {
    assert.throws(() => fake.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(calls, 2, 'misrouted CREATE must trigger only one fresh R');
    assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
  } finally { closeFixture(item); }
});

test('abnormal CREATE process truth is ignored and only fresh R may settle truth', () => {
  for (const abnormal of [
    { status: 17, signal: null },
    { status: null, signal: 'SIGKILL' },
    { status: 0, signal: null, error: new Error('spawn result error') },
  ]) {
    const item = fixture(helper, 'hostile process status\n');
    let calls = 0;
    const fake = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: helper,
      spawnSync() {
        calls += 1;
        const command = calls === 1 ? 'C' : 'R';
        return {
          status: calls === 1 ? abnormal.status : 0,
          signal: calls === 1 ? abnormal.signal : null,
          ...(calls === 1 && abnormal.error ? { error: abnormal.error } : {}),
          stdout: Buffer.from(
            `P\tOK\n${command}\tRESULT\tUNCOMMITTED\t${item.request.operationId}\t` +
            `${item.request.artifactDigest}\t${item.request.precreatePhaseDigest}\t` +
            `${item.request.selectionDigest}\t0\t-\n`
          ),
          stderr: Buffer.alloc(0),
        };
      },
    }).forProject(item.rootPath);
    try {
      const result = fake.create(item.request, item.artifactFd);
      assert.strictEqual(result.command, 'RECONCILE');
      assert.strictEqual(result.state, 'UNCOMMITTED');
      assert.strictEqual(calls, 2);
    } finally { closeFixture(item); }
  }
});

test('CREATE-attempted plus unavailable fresh R is UNKNOWN, never helper-unavailable', () => {
  const item = fixture(helper, 'fresh reconcile unavailable\n');
  let calls = 0;
  const fake = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: helper,
    spawnSync() {
      calls += 1;
      if (calls === 2) throw new Error('/private/tmp/secret body');
      return {
        status: 17,
        signal: null,
        stdout: Buffer.from(
          `P\tOK\nC\tRESULT\tUNCOMMITTED\t${item.request.operationId}\t` +
          `${item.request.artifactDigest}\t${item.request.precreatePhaseDigest}\t` +
          `${item.request.selectionDigest}\t0\t-\n`
        ),
        stderr: Buffer.alloc(0),
      };
    },
  }).forProject(item.rootPath);
  try {
    assert.throws(() => fake.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED' &&
      error?.transactionState === 'UNKNOWN' &&
      !error.message.includes('/private/') && !error.message.includes('body'));
    assert.strictEqual(calls, 2);
  } finally { closeFixture(item); }
});

test('abnormal RECONCILE process truth always maps to path-free UNKNOWN', () => {
  for (const abnormal of [
    { status: 23, signal: null },
    { status: null, signal: 'SIGABRT' },
    { status: 0, signal: null, error: new Error('/private/tmp/secret') },
  ]) {
    const item = fixture(helper, 'hostile reconcile status\n');
    let calls = 0;
    const fake = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: helper,
      spawnSync() {
        calls += 1;
        return {
          ...abnormal,
          stdout: Buffer.from(
            `P\tOK\nR\tRESULT\tUNCOMMITTED\t${item.request.operationId}\t` +
            `${item.request.artifactDigest}\t${item.request.precreatePhaseDigest}\t` +
            `${item.request.selectionDigest}\t0\t-\n`
          ),
          stderr: Buffer.alloc(0),
        };
      },
    }).forProject(item.rootPath);
    try {
      const result = fake.reconcile(item.request);
      assert.strictEqual(result.state, 'UNKNOWN');
      assert.strictEqual(result.errorCode, 'PUBLIC_MARKDOWN_NATIVE_UNKNOWN');
      assert.strictEqual(calls, 1);
    } finally { closeFixture(item); }
  }
});

test('abnormal FINALIZE process truth is ignored before deterministic F retry', () => {
  for (const abnormal of [
    { status: 29, signal: null },
    { status: null, signal: 'SIGKILL' },
    { status: 0, signal: null, error: new Error('/private/tmp/final') },
  ]) {
    const item = fixture(helper, 'hostile finalize status\n');
    const control = schema.buildControl(item.request, 0);
    const receipt = schema.buildReceipt(control, `sha256:${'7'.repeat(64)}`);
    const token = schema.buildToken(item.request, 0, receipt);
    const finalize = {
      schema: schema.SCHEMAS.FINALIZE_REQUEST,
      operationId: item.request.operationId,
      artifactDigest: item.request.artifactDigest,
      selectionDigest: item.request.selectionDigest,
      historyCommittedPhaseDigest: `sha256:${'8'.repeat(64)}`,
      tokens: [token],
    };
    const ack = schema.buildFinalAck(finalize, item.request);
    const name = schema.finalRecordName(finalize, item.request);
    let calls = 0;
    const fake = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: helper,
      spawnSync() {
        calls += 1;
        return {
          status: calls === 1 ? abnormal.status : 0,
          signal: calls === 1 ? abnormal.signal : null,
          ...(calls === 1 && abnormal.error ? { error: abnormal.error } : {}),
          stdout: Buffer.from(
            `P\tOK\nF\tOK\tACKED\t${finalize.operationId}\t${finalize.artifactDigest}\t` +
            `${finalize.selectionDigest}\t${finalize.historyCommittedPhaseDigest}\t` +
            `${ack.receiptSetDigest}\t${name}\t${ack.finalAckDigest}\n`
          ),
          stderr: Buffer.alloc(0),
        };
      },
    }).forProject(item.rootPath);
    try {
      assert.strictEqual(
        fake.finalizeCreate(finalize, item.request).finalAckDigest,
        ack.finalAckDigest
      );
      assert.strictEqual(calls, 2);
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
    } finally { closeFixture(item); }
  }
});

for (const [label, transform] of [
  ['extra input line', input => `${input}X\textra\n`],
  ['malformed UTF-8 path', input => input.split('\n').map(line => {
    if (!line.startsWith('I\t')) return line;
    const fields = line.split('\t');
    fields[2] = 'c080';
    return fields.join('\t');
  }).join('\n')],
]) {
  test(`${label} fails before native record or public-leaf mutation`, () => {
    const item = fixture(helper, `${label}\n`);
    const hostile = lifecycle.createPublicMarkdownNativeTransport({
      helperPath: helper,
      spawnSync(helperPath, args, options) {
        return childProcess.spawnSync(helperPath, args, {
          ...options,
          input: transform(options.input),
        });
      },
    }).forProject(item.rootPath);
    try {
      assert.throws(() => hostile.create(item.request, item.artifactFd), error =>
        error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
      assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
      assert.strictEqual(
        fs.readdirSync(item.recovery)
          .some(name => name.startsWith('.changes-history-native-create-')),
        false
      );
    } finally { closeFixture(item); }
  });
}

test('private recovery scan-budget exhaustion fails closed before mutation', () => {
  const item = fixture(helper, 'scan budget\n');
  try {
    for (let index = 0; index < 2048; index += 1) {
      fs.writeFileSync(path.join(item.recovery, `unrelated-${index}`), '', { flag: 'wx', mode: 0o600 });
    }
    assert.throws(() => item.scoped.create(item.request, item.artifactFd), error =>
      error?.code === 'CHANGES_MANUAL_RECOVERY_REQUIRED');
    assert.strictEqual(fs.existsSync(path.join(item.rootPath, 'created.md')), false);
    assert.strictEqual(
      fs.readdirSync(item.recovery)
        .some(name => name.startsWith('.changes-history-native-create-')),
      false
    );
  } finally { closeFixture(item); }
});

test('stderr/body-like malformed output is redacted and bounded before trust', () => {
  const item = fixture(helper, 'redaction hostile\n');
  let calls = 0;
  const fake = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: helper,
    spawnSync() {
      calls += 1;
      return {
        status: 1,
        signal: null,
        stdout: calls === 1
          ? Buffer.alloc(schema.LIMITS.maxResponseBytes + 1, 0x61)
          : Buffer.from('P\tOK\n'),
        stderr: Buffer.from('/private/tmp/secret.md\nmarkdown body'),
      };
    },
  }).forProject(item.rootPath);
  try {
    let caught;
    try { fake.create(item.request, item.artifactFd); } catch (error) { caught = error; }
    assert(caught);
    assert(!caught.message.includes('/private/'));
    assert(!caught.message.includes('markdown body'));
    assert.strictEqual(calls, 2);
  } finally { closeFixture(item); }
});

test('request accessor fails before helper spawn with zero getter calls', () => {
  const item = fixture(helper, 'getter hostile\n');
  let getters = 0;
  let spawns = 0;
  const hostile = { ...item.request };
  Object.defineProperty(hostile, 'artifactDigest', {
    enumerable: true,
    get() { getters += 1; return item.request.artifactDigest; },
  });
  const fake = lifecycle.createPublicMarkdownNativeTransport({
    helperPath: helper,
    spawnSync() { spawns += 1; throw new Error('must not spawn'); },
  }).forProject(item.rootPath);
  try {
    assert.throws(() => fake.create(hostile, item.artifactFd));
    assert.strictEqual(getters, 0);
    assert.strictEqual(spawns, 0);
  } finally { closeFixture(item); }
});

fs.rmSync(scratch, { recursive: true, force: true });
console.log(`${passed}/${passed} Public Markdown native lifecycle checks passed.`);
