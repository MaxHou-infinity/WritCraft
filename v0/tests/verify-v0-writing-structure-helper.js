#!/usr/bin/env node
'use strict';

const assert = require('assert');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const nativeHelperBuild = require('../scripts/build-native-helper');

console.log('\nWritCraft writing structure native helper verification');

const HELPER = path.join(
  __dirname,
  '..',
  'src',
  'main',
  'native',
  'writing-structure-helper'
);
const OPERATION_ID = `wst_${'1'.repeat(48)}`;
const STAGE = `.writcraft-structure-stage-${'2'.repeat(48)}`;
const TARGET = 'chapters';
const RECEIPT_SCHEMA = 'writcraft.structure-stage-receipt/v1';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function withScratch(fn) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'writcraft-structure-helper-'));
  try {
    return fn(scratch);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function openRoot(rootPath) {
  return fs.openSync(rootPath, fs.constants.O_RDONLY);
}

function createReceipt(scratch, mode = 0o600, flags = fs.constants.O_RDWR) {
  const receiptPath = path.join(
    scratch,
    `receipt-${crypto.randomBytes(8).toString('hex')}.json`
  );
  const createFd = fs.openSync(
    receiptPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR,
    0o600
  );
  fs.fchmodSync(createFd, mode);
  fs.fsyncSync(createFd);
  fs.closeSync(createFd);
  return {
    path: receiptPath,
    fd: fs.openSync(receiptPath, flags),
  };
}

function runHelper({ rootFd, receiptFd, input }) {
  const stdio = ['pipe', 'pipe', 'pipe', rootFd];
  if (receiptFd !== undefined) stdio.push(receiptFd);
  return childProcess.spawnSync(HELPER, [], {
    input,
    encoding: 'utf8',
    stdio,
  });
}

function reserve(rootFd, receiptFd, operationId = OPERATION_ID, stage = STAGE) {
  return runHelper({
    rootFd,
    receiptFd,
    input: JSON.stringify({
      mode: 'reserve',
      operationId,
      stage,
    }),
  });
}

function inspect(rootFd, stage = STAGE, target = TARGET) {
  return runHelper({
    rootFd,
    input: JSON.stringify({
      mode: 'inspect',
      stage,
      target,
    }),
  });
}

function publish(rootFd, identity, stage = STAGE, target = TARGET) {
  return runHelper({
    rootFd,
    input: JSON.stringify({
      mode: 'publish',
      stage,
      target,
      dev: identity.dev,
      ino: identity.ino,
    }),
  });
}

function writeStage(rootFd, identity, content, name = '01.md') {
  return runHelper({
    rootFd,
    input: JSON.stringify({
      mode: 'write',
      directory: STAGE,
      dev: identity.dev,
      ino: identity.ino,
      name,
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    }),
  });
}

function removeStageFile(rootFd, stageIdentity, fileIdentity, content, name = '01.md') {
  return runHelper({
    rootFd,
    input: JSON.stringify({
      mode: 'remove',
      stage: STAGE,
      dev: stageIdentity.dev,
      ino: stageIdentity.ino,
      name,
      fileDev: fileIdentity.dev,
      fileIno: fileIdentity.ino,
      contentBase64: Buffer.from(content, 'utf8').toString('base64'),
    }),
  });
}

test('ships an executable universal helper', () => {
  assert.deepStrictEqual(
    nativeHelperBuild.NATIVE_HELPERS.writingStructure,
    {
      sourceName: 'writing-structure-helper.c',
      outputName: 'writing-structure-helper',
    }
  );
  fs.accessSync(HELPER, fs.constants.R_OK | fs.constants.X_OK);
  const architectures = childProcess.execFileSync('lipo', ['-archs', HELPER], {
    encoding: 'utf8',
  }).trim().split(/\s+/).sort();
  assert.deepStrictEqual(architectures, ['arm64', 'x86_64']);
});

test('reserves the exact private empty stage and fsyncs a strict durable receipt', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const result = reserve(rootFd, receipt.fd);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.deepStrictEqual(Object.keys(report), [
        'ok', 'operationId', 'stage', 'dev', 'ino', 'mode',
      ]);
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.operationId, OPERATION_ID);
      assert.strictEqual(report.stage, STAGE);
      assert.strictEqual(report.mode, 0o700);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, STAGE)), []);

      const receiptBytes = fs.readFileSync(receipt.path, 'utf8');
      const receiptValue = JSON.parse(receiptBytes);
      assert.deepStrictEqual(Object.keys(receiptValue), [
        'schema', 'operationId', 'stage', 'dev', 'ino', 'mode',
      ]);
      assert.strictEqual(receiptValue.schema, RECEIPT_SCHEMA);
      assert.strictEqual(receiptValue.operationId, OPERATION_ID);
      assert.strictEqual(receiptValue.stage, STAGE);
      assert.strictEqual(receiptValue.dev, report.dev);
      assert.strictEqual(receiptValue.ino, report.ino);
      assert.strictEqual(receiptValue.mode, 0o700);
      assert.strictEqual(receiptBytes, `${JSON.stringify(receiptValue)}\n`);
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('inspects optional stage and target identities without mutation', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const reserved = reserve(rootFd, receipt.fd);
      assert.strictEqual(reserved.status, 0);
      const result = inspect(rootFd);
      assert.strictEqual(result.status, 0);
      const report = JSON.parse(result.stdout);
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.stage.type, 'directory');
      assert.strictEqual(report.stage.dev, JSON.parse(reserved.stdout).dev);
      assert.strictEqual(report.stage.ino, JSON.parse(reserved.stdout).ino);
      assert.strictEqual(report.target, null);
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('publishes the expected stage to chapters with atomic no-clobber semantics', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const reserved = reserve(rootFd, receipt.fd);
      assert.strictEqual(reserved.status, 0);
      const identity = JSON.parse(reserved.stdout);
      fs.writeFileSync(
        path.join(root, STAGE, '01.md'),
        '# 第一章\n\n<!-- 写作目的：建立问题 -->\n',
        { flag: 'wx', mode: 0o600 }
      );
      const result = publish(rootFd, identity);
      assert.strictEqual(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout);
      assert.strictEqual(report.ok, true);
      assert.strictEqual(report.errno, 0);
      assert.strictEqual(report.stage, null);
      assert.strictEqual(report.target.type, 'directory');
      assert.strictEqual(report.target.dev, identity.dev);
      assert.strictEqual(report.target.ino, identity.ino);
      assert.strictEqual(report.expected, true);
      assert.strictEqual(
        fs.readFileSync(path.join(root, TARGET, '01.md'), 'utf8'),
        '# 第一章\n\n<!-- 写作目的：建立问题 -->\n'
      );
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('preserves both the reserved stage and an existing foreign target on EEXIST', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const reserved = reserve(rootFd, receipt.fd);
      assert.strictEqual(reserved.status, 0);
      const identity = JSON.parse(reserved.stdout);
      fs.mkdirSync(path.join(root, TARGET));
      fs.writeFileSync(path.join(root, TARGET, 'foreign.txt'), 'keep');
      const result = publish(rootFd, identity);
      assert.strictEqual(result.status, 2);
      const report = JSON.parse(result.stdout);
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.stage.ino, identity.ino);
      assert.strictEqual(report.target.type, 'directory');
      assert.strictEqual(report.expected, false);
      assert.strictEqual(
        fs.readFileSync(path.join(root, TARGET, 'foreign.txt'), 'utf8'),
        'keep'
      );
      assert(fs.existsSync(path.join(root, STAGE)));
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('rejects a mismatched expected identity with a strict report and no rename', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const reserved = reserve(rootFd, receipt.fd);
      assert.strictEqual(reserved.status, 0);
      const identity = JSON.parse(reserved.stdout);
      const result = publish(rootFd, {
        dev: identity.dev,
        ino: String(BigInt(identity.ino) + 1n),
      });
      assert.strictEqual(result.status, 1);
      const report = JSON.parse(result.stdout);
      assert.deepStrictEqual(Object.keys(report), [
        'ok', 'errno', 'stage', 'target', 'expected',
      ]);
      assert.strictEqual(report.ok, false);
      assert.strictEqual(report.stage.ino, identity.ino);
      assert.strictEqual(report.target, null);
      assert.strictEqual(report.expected, false);
      assert(fs.existsSync(path.join(root, STAGE)));
      assert(!fs.existsSync(path.join(root, TARGET)));
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('a reserved stage replaced by an outside symlink cannot receive any bytes', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    const outside = path.join(scratch, 'outside');
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const reserved = reserve(rootFd, receipt.fd);
      assert.strictEqual(reserved.status, 0);
      const identity = JSON.parse(reserved.stdout);
      fs.rmdirSync(path.join(root, STAGE));
      fs.symlinkSync(outside, path.join(root, STAGE));
      const result = writeStage(rootFd, identity, '# 禁止外写\n');
      assert.notStrictEqual(result.status, 0);
      assert.deepStrictEqual(fs.readdirSync(outside), []);
      assert.strictEqual(fs.lstatSync(path.join(root, STAGE)).isSymbolicLink(), true);
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('cleanup rejects a late file replacement and preserves the foreign object', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    const content = '# 第一章\n';
    try {
      const reserved = reserve(rootFd, receipt.fd);
      assert.strictEqual(reserved.status, 0);
      const stageIdentity = JSON.parse(reserved.stdout);
      const written = writeStage(rootFd, stageIdentity, content);
      assert.strictEqual(written.status, 0, written.stderr || written.stdout);
      const fileIdentity = JSON.parse(written.stdout);
      fs.unlinkSync(path.join(root, STAGE, '01.md'));
      fs.writeFileSync(path.join(root, STAGE, '01.md'), 'foreign', {
        flag: 'wx',
        mode: 0o600,
      });
      const result = removeStageFile(
        rootFd,
        stageIdentity,
        fileIdentity,
        content
      );
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(
        fs.readFileSync(path.join(root, STAGE, '01.md'), 'utf8'),
        'foreign'
      );
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

test('control cleanup rejects a non-private recovery directory', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    const recovery = path.join(root, '.writcraft', 'recovery');
    fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const markerPath = path.join(recovery, 'writing-structure-transaction.json');
    const receiptPath = path.join(recovery, 'writing-structure-stage-receipt.json');
    fs.writeFileSync(markerPath, 'marker', { mode: 0o600 });
    fs.writeFileSync(receiptPath, 'receipt', { mode: 0o600 });
    const marker = fs.lstatSync(markerPath);
    const receipt = fs.lstatSync(receiptPath);
    fs.chmodSync(recovery, 0o755);
    const rootFd = openRoot(root);
    const recoveryFd = fs.openSync(
      recovery,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      const result = runHelper({
        rootFd,
        receiptFd: recoveryFd,
        input: JSON.stringify({
          mode: 'cleanupControls',
          markerDev: String(marker.dev),
          markerIno: String(marker.ino),
          receiptDev: String(receipt.dev),
          receiptIno: String(receipt.ino),
        }),
      });
      assert.notStrictEqual(result.status, 0);
      assert.strictEqual(fs.readFileSync(markerPath, 'utf8'), 'marker');
      assert.strictEqual(fs.readFileSync(receiptPath, 'utf8'), 'receipt');
    } finally {
      fs.closeSync(recoveryFd);
      fs.closeSync(rootFd);
    }
  })
);

test('rejects malformed, trailing, NUL, oversized, and illegal-name requests before mutation', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const cases = [
      '{"mode":"reserve"}',
      `${JSON.stringify({ mode: 'reserve', operationId: OPERATION_ID, stage: STAGE })}x`,
      Buffer.from(`${JSON.stringify({
        mode: 'reserve',
        operationId: OPERATION_ID,
        stage: STAGE,
      })}\0`, 'utf8'),
      'x'.repeat(5000),
      JSON.stringify({
        mode: 'reserve',
        operationId: `wst_${'A'.repeat(48)}`,
        stage: STAGE,
      }),
      JSON.stringify({
        mode: 'reserve',
        operationId: OPERATION_ID,
        stage: '../chapters',
      }),
      JSON.stringify({
        mode: 'inspect',
        stage: STAGE,
        target: 'other',
      }),
    ];
    for (const input of cases) {
      const rootFd = openRoot(root);
      const receipt = createReceipt(scratch);
      try {
        const result = runHelper({ rootFd, receiptFd: receipt.fd, input });
        assert.notStrictEqual(result.status, 0);
        assert.deepStrictEqual(fs.readdirSync(root), []);
        assert.strictEqual(fs.readFileSync(receipt.path, 'utf8'), '');
      } finally {
        fs.closeSync(receipt.fd);
        fs.closeSync(rootFd);
      }
    }
  })
);

test('rejects read-only, non-0600, hard-linked, and non-empty receipt files before mkdirat', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    const scenarios = [
      () => createReceipt(scratch, 0o600, fs.constants.O_RDONLY),
      () => createReceipt(scratch, 0o644, fs.constants.O_RDWR),
      () => {
        const receipt = createReceipt(scratch);
        fs.linkSync(receipt.path, `${receipt.path}.hardlink`);
        return receipt;
      },
      () => {
        const receipt = createReceipt(scratch);
        fs.writeFileSync(receipt.path, '{}');
        return receipt;
      },
    ];
    for (const makeReceipt of scenarios) {
      const rootFd = openRoot(root);
      const receipt = makeReceipt();
      try {
        const result = reserve(rootFd, receipt.fd);
        assert.notStrictEqual(result.status, 0);
        assert.deepStrictEqual(fs.readdirSync(root), []);
      } finally {
        fs.closeSync(receipt.fd);
        fs.closeSync(rootFd);
      }
    }
  })
);

test('never removes a pre-existing stage object on reserve EEXIST', () =>
  withScratch(scratch => {
    const root = path.join(scratch, 'project');
    fs.mkdirSync(root);
    fs.mkdirSync(path.join(root, STAGE));
    fs.writeFileSync(path.join(root, STAGE, 'foreign.txt'), 'keep');
    const rootFd = openRoot(root);
    const receipt = createReceipt(scratch);
    try {
      const result = reserve(rootFd, receipt.fd);
      assert.strictEqual(result.status, 2);
      assert.strictEqual(
        fs.readFileSync(path.join(root, STAGE, 'foreign.txt'), 'utf8'),
        'keep'
      );
      assert.strictEqual(fs.readFileSync(receipt.path, 'utf8'), '');
    } finally {
      fs.closeSync(receipt.fd);
      fs.closeSync(rootFd);
    }
  })
);

console.log(`\n${passed}/${passed} writing structure native helper checks passed.`);
