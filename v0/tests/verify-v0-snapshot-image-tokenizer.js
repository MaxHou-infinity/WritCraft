'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ADAPTER_PATH = path.join(ROOT, 'src/shared/snapshot-image-tokenizer.js');
const MARKED_PATH = path.join(ROOT, 'src/shared/marked.umd.js');
const PARSER_ID = 'marked@18.0.6+sha256:62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d';

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

function sha256Bytes(bytes) {
  return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

function code(error) {
  return error && error.code;
}

function expectCode(expected, fn) {
  assert.throws(fn, error => code(error) === expected, expected);
}

function candidate(overrides = {}) {
  return {
    candidateId: 'candidate_a',
    captureDigest: sha256Bytes(Buffer.from('capture-a')),
    fileId: 'file_a',
    revision: 'a'.repeat(64),
    markdownBytes: Buffer.from('正文 ![图](assets/a.png "图注")。', 'utf8'),
    ...overrides
  };
}

function createApi() {
  const marked = require(MARKED_PATH);
  const moduleApi = require(ADAPTER_PATH);
  return moduleApi.createAdapter({ marked, sha256Bytes });
}

function pass(api, candidates, overrides = {}) {
  return api.createTokenPass({
    transactionId: 'transaction_a',
    candidates,
    ...overrides
  });
}

test('adapter 是 authority-free UMD，且冻结 parser identity/limits', () => {
  const source = fs.readFileSync(ADAPTER_PATH, 'utf8');
  assert(!/\brequire\s*\(|\bprocess\s*[.[]|\bwindow\s*[.[]|\bdocument\s*[.[]|\bfetch\s*\(/.test(source));
  const moduleApi = require(ADAPTER_PATH);
  assert.strictEqual(moduleApi.PARSER_ID, PARSER_ID);
  assert.deepStrictEqual(moduleApi.SCHEMA_KEYS, {
    pass: ['schema', 'transactionId', 'parserId', 'candidates'],
    candidate: ['candidateId', 'captureDigest', 'fileId', 'revision', 'tokens'],
    token: ['tokenOrdinal', 'rawTokenSha256', 'hrefUtf8Base64', 'locatorDigest'],
    locator: ['schema', 'fileId', 'revision', 'tokenOrdinal', 'rawTokenSha256', 'hrefSha256']
  });
  assert.deepStrictEqual(moduleApi.LIMITS, {
    maxCandidates: 300,
    maxMarkdownBytes: 4 * 1024 * 1024,
    maxMarkdownTotalBytes: 64 * 1024 * 1024,
    maxHrefBytes: 4096,
    maxImageTokens: 10000,
    maxCanonicalBytes: 4 * 1024 * 1024
  });
});

test('direct/reference images use all-token DFS ordinals and exact token identities', () => {
  const api = createApi();
  const markdown = [
    '# 标题',
    '',
    '开头 **粗体** ![direct](assets/a.png "说明")。',
    '',
    '- 列表 ![ref][pic]',
    '',
    '[pic]: images/%E5%9B%BE.jpg "引用图"',
    ''
  ].join('\n');
  const result = pass(api, [candidate({ markdownBytes: Buffer.from(markdown) })]);
  assert.deepStrictEqual(Object.keys(result), ['schema', 'transactionId', 'parserId', 'candidates']);
  assert.strictEqual(result.schema, 'writcraft.snapshot-image-token-pass/v1');
  assert.strictEqual(result.parserId, PARSER_ID);
  assert.strictEqual(result.candidates.length, 1);
  assert.deepStrictEqual(Object.keys(result.candidates[0]), [
    'candidateId', 'captureDigest', 'fileId', 'revision', 'tokens'
  ]);
  const tokens = result.candidates[0].tokens;
  assert.strictEqual(tokens.length, 2);
  assert.deepStrictEqual(tokens.map(token => token.tokenOrdinal), [8, 16]);
  assert.strictEqual(tokens[0].rawTokenSha256,
    'sha256:886f2821ea3b79706ceee70812bb07e2b0ce161499147701c9e8e02164836027');
  assert.strictEqual(tokens[0].locatorDigest,
    'sha256:b832a0d217d3355b435e1791db0b6cc6122727c7fbe06a23663a396515e505a6');
  assert.deepStrictEqual(tokens.map(token => Buffer.from(token.hrefUtf8Base64, 'base64').toString('utf8')), [
    'assets/a.png', 'images/%E5%9B%BE.jpg'
  ]);
  assert(tokens.every(token => /^sha256:[a-f0-9]{64}$/.test(token.rawTokenSha256)));
  assert(tokens.every(token => /^sha256:[a-f0-9]{64}$/.test(token.locatorDigest)));
  assert.strictEqual(Buffer.byteLength(api.canonicalJson(result), 'utf8') <= api.LIMITS.maxCanonicalBytes, true);
});

test('escaped syntax, fenced code and HTML img are not image tokens; duplicates remain distinct', () => {
  const api = createApi();
  const markdown = [
    '\\![escaped](assets/escaped.png)',
    '',
    '```md',
    '![code](assets/code.png)',
    '```',
    '',
    '<img src="assets/html.png">',
    '',
    '![one](assets/same.png) ![two](assets/same.png)',
    ''
  ].join('\n');
  const tokens = pass(api, [candidate({ markdownBytes: Buffer.from(markdown) })]).candidates[0].tokens;
  assert.deepStrictEqual(tokens.map(token => Buffer.from(token.hrefUtf8Base64, 'base64').toString()), [
    'assets/same.png', 'assets/same.png'
  ]);
  assert.notStrictEqual(tokens[0].tokenOrdinal, tokens[1].tokenOrdinal);
  assert.notStrictEqual(tokens[0].rawTokenSha256, tokens[1].rawTokenSha256);
  assert.notStrictEqual(tokens[0].locatorDigest, tokens[1].locatorDigest);
});

test('shared pass binds exact href bytes without inventing a second path policy', () => {
  const api = createApi();
  const hrefs = [
    '../assets/generated/x.png',
    '../assets/x.png#fragment',
    'assets/%E5%9B%BE%20a.webp',
    'https://example.com/a.png',
    '/tmp/a.png',
    'assets/%2e%2e/a.png',
    'assets/%ZZ/a.png',
    'assets/a.png?query=1'
  ];
  const markdown = hrefs.map((href, index) => `![x${index}](<${href}>)`).join(' ');
  const tokens = pass(api, [candidate({ markdownBytes: Buffer.from(markdown) })]).candidates[0].tokens;
  assert.deepStrictEqual(tokens.map(token => Buffer.from(token.hrefUtf8Base64, 'base64').toString()), hrefs);
});

test('input is exact-key sealed bytes only; invalid UTF-8 and oversized Markdown fail closed', () => {
  const api = createApi();
  expectCode('INVALID_TOKEN_CANDIDATE', () => pass(api, [{ ...candidate(), absolutePath: '/secret' }]));
  expectCode('INVALID_TOKEN_CANDIDATE', () => pass(api, [candidate({ markdownBytes: '正文' })]));
  expectCode('INVALID_MARKDOWN_UTF8', () => pass(api, [candidate({
    markdownBytes: Buffer.from([0xed, 0xa0, 0x80])
  })]));
  const c0Href = 'assets/a\0.png';
  const c0Token = pass(api, [candidate({
    markdownBytes: Buffer.from(`![x](<${c0Href}>)`)
  })]).candidates[0].tokens[0];
  assert.strictEqual(Buffer.from(c0Token.hrefUtf8Base64, 'base64').toString(), c0Href);
  expectCode('MARKDOWN_BUDGET_EXCEEDED', () => pass(api, [candidate({
    markdownBytes: Buffer.alloc(api.LIMITS.maxMarkdownBytes + 1, 0x61)
  })]));
});

test('candidate/schema budgets, duplicate bindings and hash dependency fail closed', () => {
  const api = createApi();
  expectCode('INVALID_TOKEN_PASS', () => pass(api, [candidate(), candidate()]));
  const tooManyCandidates = Array.from({ length: api.LIMITS.maxCandidates + 1 }, (_, index) => candidate({
    candidateId: `candidate_${index}`,
    fileId: `file_${index}`,
    markdownBytes: Buffer.alloc(0)
  }));
  expectCode('INVALID_TOKEN_PASS', () => pass(api, tooManyCandidates));
  expectCode('INVALID_TOKEN_CANDIDATE', () => pass(api, [candidate({ revision: 'A'.repeat(64) })]));
  const badApi = require(ADAPTER_PATH).createAdapter({ marked: require(MARKED_PATH), sha256Bytes: () => 'bad' });
  expectCode('INVALID_HASH_RESULT', () => pass(badApi, [candidate()]));
});

test('image-token and canonical JSON limits reject before an oversized pass becomes authority', () => {
  const api = createApi();
  const tooManyImages = Buffer.from('![](a.png) '.repeat(api.LIMITS.maxImageTokens + 1));
  expectCode('IMAGE_TOKEN_BUDGET_EXCEEDED', () => pass(api, [candidate({ markdownBytes: tooManyImages })]));

  const longHref = `images/${'a'.repeat(1000)}.png`;
  const amplified = Buffer.from(`![](${longHref}) `.repeat(3900));
  assert(amplified.byteLength <= api.LIMITS.maxMarkdownBytes);
  expectCode('TOKEN_PASS_BUDGET_EXCEEDED', () => pass(api, [candidate({ markdownBytes: amplified })]));
});

test('raw href over 4096 bytes fails without truncation or digest-only fallback', () => {
  const api = createApi();
  const href = `${'a'.repeat(5007)}.png`;
  assert.strictEqual(Buffer.byteLength(href), 5011);
  expectCode('TOKEN_PASS_BUDGET_EXCEEDED', () => pass(api, [candidate({
    markdownBytes: Buffer.from(`![](<${href}>)`)
  })]));
});

test('aggregate sealed Markdown budget is checked before any candidate tokenization', () => {
  let lexerCalls = 0;
  const fakeMarked = {
    lexer() {
      lexerCalls += 1;
      return [];
    },
    walkTokens() {}
  };
  const api = require(ADAPTER_PATH).createAdapter({ marked: fakeMarked, sha256Bytes });
  const fourMiB = new Uint8Array(api.LIMITS.maxMarkdownBytes);
  fourMiB.fill(0x61);
  const candidates = Array.from({ length: 17 }, (_, index) => candidate({
    candidateId: `candidate_${index}`,
    fileId: `file_${index}`,
    markdownBytes: fourMiB
  }));
  expectCode('MARKDOWN_BUDGET_EXCEEDED', () => pass(api, candidates));
  assert.strictEqual(lexerCalls, 0);
});

test('output envelope is rejected incrementally before visiting every oversized token', () => {
  let visited = 0;
  const imageTokens = Array.from({ length: 1200 }, (_, index) => ({
    type: 'image',
    raw: `![${index}](x)`,
    href: `${'a'.repeat(3996)}.png`
  }));
  const fakeMarked = {
    lexer() {
      return imageTokens;
    },
    walkTokens(tokens, callback) {
      for (const token of tokens) {
        visited += 1;
        callback(token);
      }
    }
  };
  const api = require(ADAPTER_PATH).createAdapter({ marked: fakeMarked, sha256Bytes });
  expectCode('TOKEN_PASS_BUDGET_EXCEEDED', () => pass(api, [candidate({ markdownBytes: Buffer.from('x') })]));
  assert(visited < imageTokens.length, 'incremental gate must stop before visiting every token');
});

test('standalone schema validation rejects locator/base64 tampering', () => {
  const api = createApi();
  const result = pass(api, [candidate()]);
  const badLocator = JSON.parse(JSON.stringify(result));
  badLocator.candidates[0].tokens[0].locatorDigest = `sha256:${'0'.repeat(64)}`;
  expectCode('INVALID_TOKEN_PASS', () => api.assertTokenPass(badLocator));
  const badBase64 = JSON.parse(JSON.stringify(result));
  badBase64.candidates[0].tokens[0].hrefUtf8Base64 = 'YR==';
  expectCode('INVALID_TOKEN_PASS', () => api.assertTokenPass(badBase64));
});

test('returned and validated token-pass authority is recursively frozen', () => {
  const api = createApi();
  const result = pass(api, [candidate()]);
  assert(Object.isFrozen(result));
  assert(Object.isFrozen(result.candidates));
  assert(Object.isFrozen(result.candidates[0]));
  assert(Object.isFrozen(result.candidates[0].tokens));
  assert(Object.isFrozen(result.candidates[0].tokens[0]));
  const clone = JSON.parse(JSON.stringify(result));
  assert.strictEqual(api.assertTokenPass(clone), clone);
  assert(Object.isFrozen(clone));
  assert(Object.isFrozen(clone.candidates[0].tokens[0]));
});

test('shallow-frozen valid pass still recursively freezes mutable nested authority', () => {
  const api = createApi();
  const shallow = JSON.parse(JSON.stringify(pass(api, [candidate()])));
  Object.freeze(shallow);
  assert.strictEqual(Object.isFrozen(shallow.candidates[0].tokens[0]), false);
  assert.strictEqual(api.assertTokenPass(shallow), shallow);
  assert(Object.isFrozen(shallow.candidates));
  assert(Object.isFrozen(shallow.candidates[0]));
  assert(Object.isFrozen(shallow.candidates[0].tokens));
  assert(Object.isFrozen(shallow.candidates[0].tokens[0]));
  assert.throws(() => {
    shallow.candidates[0].tokens[0].tokenOrdinal = 99;
  }, TypeError);
});

test('hostile typed-array/accessor probes fail without touching Symbol.toStringTag getters', () => {
  const api = createApi();
  let touched = 0;
  const hostileBytes = new Uint8Array([0x61]);
  Object.defineProperty(hostileBytes, Symbol.toStringTag, {
    get() {
      touched += 1;
      throw new Error('must not escape');
    }
  });
  expectCode('INVALID_TOKEN_CANDIDATE', () => pass(api, [candidate({ markdownBytes: hostileBytes })]));
  assert.strictEqual(touched, 0);

  const hostileCandidate = candidate();
  Object.defineProperty(hostileCandidate, 'markdownBytes', {
    enumerable: true,
    get() {
      touched += 1;
      throw new Error('must not escape');
    }
  });
  expectCode('INVALID_TOKEN_CANDIDATE', () => pass(api, [hostileCandidate]));
  assert.strictEqual(touched, 0);
});

test('captureDigest is an external native binding shared unchanged by every candidate', () => {
  const api = createApi();
  const captureDigest = sha256Bytes(Buffer.from('sealed-capture'));
  const result = pass(api, [
    candidate({ candidateId: 'candidate_a', fileId: 'file_a', captureDigest }),
    candidate({ candidateId: 'candidate_b', fileId: 'file_b', captureDigest })
  ]);
  assert.deepStrictEqual(result.candidates.map(item => item.captureDigest), [captureDigest, captureDigest]);
  expectCode('INVALID_TOKEN_PASS', () => pass(api, [
    candidate({ candidateId: 'candidate_a', fileId: 'file_a', captureDigest }),
    candidate({
      candidateId: 'candidate_b',
      fileId: 'file_b',
      captureDigest: sha256Bytes(Buffer.from('other-capture'))
    })
  ]));
});

test('Node and browser UMD adapters produce byte-identical canonical output', () => {
  const mainApi = createApi();
  const sandbox = { TextDecoder, TextEncoder };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(fs.readFileSync(MARKED_PATH, 'utf8'), sandbox, { filename: MARKED_PATH });
  vm.runInNewContext(fs.readFileSync(ADAPTER_PATH, 'utf8'), sandbox, { filename: ADAPTER_PATH });
  const rendererApi = sandbox.WritCraftSnapshotImageTokenizer.createAdapter({
    marked: sandbox.marked,
    sha256Bytes
  });
  const inputs = [candidate({ markdownBytes: Buffer.from('![图](图片/%E5%9B%BE.png "说明")') })];
  assert.strictEqual(
    rendererApi.canonicalJson(pass(rendererApi, inputs)),
    mainApi.canonicalJson(pass(mainApi, inputs))
  );
});

console.log(`snapshot image tokenizer verification: ${passed}/${passed} passed`);
