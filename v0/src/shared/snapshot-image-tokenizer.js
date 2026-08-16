// WritCraft sealed-snapshot image token adapter (UMD, pure and authority-free).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WritCraftSnapshotImageTokenizer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TOKEN_PASS_SCHEMA = 'writcraft.snapshot-image-token-pass/v1';
  const TOKEN_LOCATOR_SCHEMA = 'writcraft.snapshot-image-token-locator/v1';
  const PARSER_ID = 'marked@18.0.6+sha256:62ad5de5bea6d79b4c47e5c0b5cbe4be61e25ee8994595c2cc0969b2a144cc5d';
  const DIGEST_DOMAIN = 'writcraft-digest/v1';
  const MARKED_OPTIONS = Object.freeze({
    gfm: true,
    pedantic: false,
    breaks: false,
    async: false
  });
  const LIMITS = Object.freeze({
    maxCandidates: 300,
    maxMarkdownBytes: 4 * 1024 * 1024,
    maxMarkdownTotalBytes: 64 * 1024 * 1024,
    maxHrefBytes: 4096,
    maxImageTokens: 10000,
    maxCanonicalBytes: 4 * 1024 * 1024
  });
  const INPUT_KEYS = Object.freeze(['transactionId', 'candidates']);
  const INPUT_CANDIDATE_KEYS = Object.freeze([
    'candidateId', 'captureDigest', 'fileId', 'revision', 'markdownBytes'
  ]);
  const PASS_KEYS = Object.freeze(['schema', 'transactionId', 'parserId', 'candidates']);
  const CANDIDATE_KEYS = Object.freeze([
    'candidateId', 'captureDigest', 'fileId', 'revision', 'tokens'
  ]);
  const TOKEN_KEYS = Object.freeze([
    'tokenOrdinal', 'rawTokenSha256', 'hrefUtf8Base64', 'locatorDigest'
  ]);
  const LOCATOR_KEYS = Object.freeze([
    'schema', 'fileId', 'revision', 'tokenOrdinal', 'rawTokenSha256', 'hrefSha256'
  ]);
  const SCHEMA_KEYS = Object.freeze({
    pass: PASS_KEYS,
    candidate: CANDIDATE_KEYS,
    token: TOKEN_KEYS,
    locator: LOCATOR_KEYS
  });
  const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
  const REVISION_RE = /^[a-f0-9]{64}$/;
  const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  const C0_RE = /[\u0000-\u001f]/u;
  const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
  const TYPED_ARRAY_TAG_GETTER = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE, Symbol.toStringTag
  ).get;
  const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE, 'buffer'
  ).get;
  const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE, 'byteOffset'
  ).get;
  const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
    TYPED_ARRAY_PROTOTYPE, 'byteLength'
  ).get;

  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }

  function hasUnpairedSurrogate(value) {
    for (let index = 0; index < value.length; index += 1) {
      const unit = value.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        index += 1;
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        return true;
      }
    }
    return false;
  }

  function utf8(value) {
    return new TextEncoder().encode(value);
  }

  function concatBytes(parts) {
    let length = 0;
    for (const part of parts) length += part.byteLength;
    const result = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.byteLength;
    }
    return result;
  }

  function plainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.getOwnPropertySymbols(value).length !== 0 ||
        Reflect.ownKeys(value).length !== Object.keys(value).length) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null || Object.getPrototypeOf(prototype) !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return Object.values(descriptors).every(descriptor =>
      Object.prototype.hasOwnProperty.call(descriptor, 'value') && descriptor.enumerable === true
    );
  }

  function assertExactKeys(value, expected, code, field) {
    let valid = false;
    try {
      if (plainRecord(value)) {
        const actual = Object.keys(value).sort();
        const wanted = [...expected].sort();
        valid = actual.length === wanted.length &&
          actual.every((key, index) => key === wanted[index]);
      }
    } catch {
      valid = false;
    }
    if (!valid) fail(code, `${field} must be an exact plain data record`);
  }

  function assertSafeString(value, field, options = {}) {
    if (typeof value !== 'string' || hasUnpairedSurrogate(value) || C0_RE.test(value)) {
      fail(options.code || 'INVALID_TOKEN_PASS', `${field} is not safe Unicode`);
    }
    const bytes = utf8(value).byteLength;
    if ((options.ascii && /[^\x20-\x7e]/u.test(value)) ||
        (options.pattern && !options.pattern.test(value)) ||
        (options.maxBytes && bytes > options.maxBytes) ||
        (options.minBytes && bytes < options.minBytes)) {
      fail(options.code || 'INVALID_TOKEN_PASS', `${field} exceeds the frozen boundary`);
    }
    return value;
  }

  function assertOpaqueId(value, field, code = 'INVALID_TOKEN_CANDIDATE') {
    return assertSafeString(value, field, { ascii: true, pattern: OPAQUE_ID_RE, code });
  }

  function assertDigest(value, field, code = 'INVALID_TOKEN_CANDIDATE') {
    return assertSafeString(value, field, { ascii: true, pattern: DIGEST_RE, code });
  }

  function canonicalJson(value) {
    const ancestors = new Set();
    let nodes = 0;

    function encode(current, field) {
      if (current === null) return 'null';
      if (typeof current === 'boolean') return current ? 'true' : 'false';
      if (typeof current === 'string') {
        assertSafeString(current, field);
        return JSON.stringify(current);
      }
      if (typeof current === 'number') {
        if (!Number.isSafeInteger(current)) fail('INVALID_TOKEN_PASS', `${field} is not a safe integer`);
        return String(current);
      }
      if (!current || typeof current !== 'object' || nodes >= 100000 || ancestors.has(current)) {
        fail('INVALID_TOKEN_PASS', `${field} is not canonical data`);
      }
      nodes += 1;
      ancestors.add(current);
      let result;
      if (Array.isArray(current)) {
        if (Object.getOwnPropertySymbols(current).length !== 0 ||
            Object.getOwnPropertyNames(current).length !== current.length + 1 ||
            Object.keys(current).length !== current.length) {
          fail('INVALID_TOKEN_PASS', `${field} must be a dense array`);
        }
        result = `[${Array.from(current, (item, index) => encode(item, `${field}[${index}]`)).join(',')}]`;
      } else {
        if (!plainRecord(current)) fail('INVALID_TOKEN_PASS', `${field} must be a plain data record`);
        const keys = Object.keys(current).sort();
        result = `{${keys.map(key => {
          assertSafeString(key, `${field} key`);
          const descriptor = Object.getOwnPropertyDescriptor(current, key);
          return `${JSON.stringify(key)}:${encode(descriptor.value, `${field}.${key}`)}`;
        }).join(',')}}`;
      }
      ancestors.delete(current);
      return result;
    }

    return encode(value, 'value');
  }

  function base64(bytes) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let result = '';
    for (let index = 0; index < bytes.length; index += 3) {
      const a = bytes[index];
      const hasB = index + 1 < bytes.length;
      const hasC = index + 2 < bytes.length;
      const b = hasB ? bytes[index + 1] : 0;
      const c = hasC ? bytes[index + 2] : 0;
      result += alphabet[a >>> 2];
      result += alphabet[((a & 3) << 4) | (b >>> 4)];
      result += hasB ? alphabet[((b & 15) << 2) | (c >>> 6)] : '=';
      result += hasC ? alphabet[c & 63] : '=';
    }
    return result;
  }

  function decodeBase64(value) {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    if (typeof value !== 'string' || value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
      fail('INVALID_TOKEN_PASS', 'hrefUtf8Base64 is not canonical RFC 4648 base64');
    }
    const padding = value.endsWith('==') ? 2 : (value.endsWith('=') ? 1 : 0);
    const result = new Uint8Array((value.length / 4) * 3 - padding);
    let output = 0;
    for (let index = 0; index < value.length; index += 4) {
      const a = alphabet.indexOf(value[index]);
      const b = alphabet.indexOf(value[index + 1]);
      const c = value[index + 2] === '=' ? 0 : alphabet.indexOf(value[index + 2]);
      const d = value[index + 3] === '=' ? 0 : alphabet.indexOf(value[index + 3]);
      if (a < 0 || b < 0 || c < 0 || d < 0) {
        fail('INVALID_TOKEN_PASS', 'hrefUtf8Base64 contains invalid alphabet');
      }
      const bits = (a << 18) | (b << 12) | (c << 6) | d;
      if (output < result.length) result[output++] = (bits >>> 16) & 255;
      if (output < result.length) result[output++] = (bits >>> 8) & 255;
      if (output < result.length) result[output++] = bits & 255;
    }
    if (base64(result) !== value) {
      fail('INVALID_TOKEN_PASS', 'hrefUtf8Base64 has non-zero pad bits');
    }
    return result;
  }

  function exactBytes(value) {
    try {
      if (!value || typeof value !== 'object' || !ArrayBuffer.isView(value) ||
          Object.getOwnPropertyDescriptor(value, Symbol.toStringTag) !== undefined ||
          TYPED_ARRAY_TAG_GETTER.call(value) !== 'Uint8Array') {
        fail('INVALID_TOKEN_CANDIDATE', 'markdownBytes must be sealed Uint8Array bytes');
      }
      const buffer = TYPED_ARRAY_BUFFER_GETTER.call(value);
      const byteOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value);
      const byteLength = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(value);
      if (byteLength > LIMITS.maxMarkdownBytes) {
        fail('MARKDOWN_BUDGET_EXCEEDED', 'sealed Markdown exceeds 4 MiB');
      }
      const view = new Uint8Array(buffer, byteOffset, byteLength);
      const copy = new Uint8Array(byteLength);
      copy.set(view);
      return copy;
    } catch (error) {
      if (error && typeof error.code === 'string') throw error;
      fail('INVALID_TOKEN_CANDIDATE', 'markdownBytes typed-array validation failed');
    }
  }

  function decodeMarkdown(bytes) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('INVALID_MARKDOWN_UTF8', 'sealed Markdown is not exact UTF-8');
    }
  }

  function createAdapter(dependencies) {
    assertExactKeys(dependencies, ['marked', 'sha256Bytes'], 'INVALID_ADAPTER_DEPENDENCY', 'dependencies');
    const marked = dependencies.marked;
    const hash = dependencies.sha256Bytes;
    if (!marked || typeof marked.lexer !== 'function' || typeof marked.walkTokens !== 'function' ||
        typeof hash !== 'function') {
      fail('INVALID_ADAPTER_DEPENDENCY', 'marked and sha256Bytes are required');
    }

    function hashBytes(bytes) {
      const result = hash(bytes);
      if (typeof result !== 'string' || !DIGEST_RE.test(result)) {
        fail('INVALID_HASH_RESULT', 'sha256Bytes returned a non-canonical digest');
      }
      return result;
    }

    function locatorDigest(fileId, revision, tokenOrdinal, rawTokenSha256, hrefSha256) {
      const locator = {
        schema: TOKEN_LOCATOR_SCHEMA,
        fileId,
        revision,
        tokenOrdinal,
        rawTokenSha256,
        hrefSha256
      };
      const preimage = concatBytes([
        utf8(DIGEST_DOMAIN), new Uint8Array([0]), utf8(TOKEN_LOCATOR_SCHEMA),
        new Uint8Array([0]), utf8(canonicalJson(locator))
      ]);
      return hashBytes(preimage);
    }

    function canonicalBytes(value) {
      return utf8(canonicalJson(value)).byteLength;
    }

    function createOutputBudget(transactionId) {
      const emptyEnvelopeBytes = canonicalBytes({
        schema: TOKEN_PASS_SCHEMA,
        transactionId,
        parserId: PARSER_ID,
        candidates: []
      });
      let candidateBytes = 0;
      let candidateCount = 0;

      function assertWithinBudget(projectedCandidateBytes) {
        if (emptyEnvelopeBytes + projectedCandidateBytes > LIMITS.maxCanonicalBytes) {
          fail('TOKEN_PASS_BUDGET_EXCEEDED', 'canonical token pass exceeds 4 MiB');
        }
      }

      return Object.freeze({
        beginCandidate(candidate) {
          const baseBytes = canonicalBytes({
            candidateId: candidate.candidateId,
            captureDigest: candidate.captureDigest,
            fileId: candidate.fileId,
            revision: candidate.revision,
            tokens: []
          });
          const separatorBytes = candidateCount === 0 ? 0 : 1;
          assertWithinBudget(candidateBytes + separatorBytes + baseBytes);
          candidateBytes += separatorBytes + baseBytes;
          candidateCount += 1;
          return { tokenCount: 0 };
        },
        reserveToken(candidateState, token) {
          const addition = canonicalBytes(token) + (candidateState.tokenCount === 0 ? 0 : 1);
          assertWithinBudget(candidateBytes + addition);
          candidateBytes += addition;
          candidateState.tokenCount += 1;
        }
      });
    }

    function prepareCandidate(input) {
      assertExactKeys(input, INPUT_CANDIDATE_KEYS, 'INVALID_TOKEN_CANDIDATE', 'candidate');
      assertOpaqueId(input.candidateId, 'candidateId');
      assertDigest(input.captureDigest, 'captureDigest');
      assertOpaqueId(input.fileId, 'fileId');
      assertSafeString(input.revision, 'revision', {
        ascii: true,
        pattern: REVISION_RE,
        code: 'INVALID_TOKEN_CANDIDATE'
      });
      return {
        candidateId: input.candidateId,
        captureDigest: input.captureDigest,
        fileId: input.fileId,
        revision: input.revision,
        markdownBytes: exactBytes(input.markdownBytes)
      };
    }

    function tokenizeCandidate(input, totals, outputBudget) {
      const markdown = decodeMarkdown(input.markdownBytes);
      let tokenStream;
      try {
        tokenStream = marked.lexer(markdown, { ...MARKED_OPTIONS });
      } catch {
        fail('MARKDOWN_TOKENIZE_FAILED', 'marked rejected sealed Markdown');
      }
      const tokens = [];
      const candidateState = outputBudget.beginCandidate(input);
      let ordinal = 0;
      try {
        marked.walkTokens(tokenStream, token => {
          const tokenOrdinal = ordinal;
          ordinal += 1;
          if (token.type !== 'image') return;
          if (totals.imageTokens >= LIMITS.maxImageTokens) {
            fail('IMAGE_TOKEN_BUDGET_EXCEEDED', 'image token count exceeds 10,000');
          }
          if (typeof token.raw !== 'string' || typeof token.href !== 'string' ||
              hasUnpairedSurrogate(token.raw) || hasUnpairedSurrogate(token.href)) {
            fail('INVALID_IMAGE_TOKEN', 'marked image token is incomplete');
          }
          const href = token.href;
          const rawTokenSha256 = hashBytes(utf8(token.raw));
          const hrefBytes = utf8(href);
          if (hrefBytes.byteLength > LIMITS.maxHrefBytes) {
            fail('TOKEN_PASS_BUDGET_EXCEEDED', 'raw image href exceeds 4096 bytes');
          }
          const hrefSha256 = hashBytes(hrefBytes);
          const outputToken = {
            tokenOrdinal,
            rawTokenSha256,
            hrefUtf8Base64: base64(hrefBytes),
            locatorDigest: locatorDigest(
              input.fileId, input.revision, tokenOrdinal, rawTokenSha256, hrefSha256
            )
          };
          outputBudget.reserveToken(candidateState, outputToken);
          tokens.push(outputToken);
          totals.imageTokens += 1;
        });
      } catch (error) {
        if (error && typeof error.code === 'string') throw error;
        fail('MARKDOWN_TOKENIZE_FAILED', 'marked token walk failed');
      }
      return {
        candidateId: input.candidateId,
        captureDigest: input.captureDigest,
        fileId: input.fileId,
        revision: input.revision,
        tokens
      };
    }

    function assertTokenPass(value) {
      assertExactKeys(value, PASS_KEYS, 'INVALID_TOKEN_PASS', 'token pass');
      if (value.schema !== TOKEN_PASS_SCHEMA || value.parserId !== PARSER_ID) {
        fail('INVALID_TOKEN_PASS', 'token pass schema/parser does not match');
      }
      assertOpaqueId(value.transactionId, 'transactionId', 'INVALID_TOKEN_PASS');
      if (!Array.isArray(value.candidates) || value.candidates.length > LIMITS.maxCandidates) {
        fail('INVALID_TOKEN_PASS', 'token pass candidate count exceeds the boundary');
      }
      let totalTokens = 0;
      const candidateIds = new Set();
      const fileIds = new Set();
      let captureDigest = null;
      for (const candidate of value.candidates) {
        assertExactKeys(candidate, CANDIDATE_KEYS, 'INVALID_TOKEN_PASS', 'token pass candidate');
        assertOpaqueId(candidate.candidateId, 'candidateId', 'INVALID_TOKEN_PASS');
        assertDigest(candidate.captureDigest, 'captureDigest', 'INVALID_TOKEN_PASS');
        assertOpaqueId(candidate.fileId, 'fileId', 'INVALID_TOKEN_PASS');
        assertSafeString(candidate.revision, 'revision', {
          ascii: true, pattern: REVISION_RE, code: 'INVALID_TOKEN_PASS'
        });
        if (candidateIds.has(candidate.candidateId) || fileIds.has(candidate.fileId)) {
          fail('INVALID_TOKEN_PASS', 'token pass has duplicate candidate/file binding');
        }
        if (captureDigest === null) captureDigest = candidate.captureDigest;
        else if (candidate.captureDigest !== captureDigest) {
          fail('INVALID_TOKEN_PASS', 'token pass candidates must share one captureDigest');
        }
        candidateIds.add(candidate.candidateId);
        fileIds.add(candidate.fileId);
        if (!Array.isArray(candidate.tokens)) fail('INVALID_TOKEN_PASS', 'candidate tokens must be an array');
        let previousOrdinal = -1;
        for (const token of candidate.tokens) {
          assertExactKeys(token, TOKEN_KEYS, 'INVALID_TOKEN_PASS', 'image token');
          if (!Number.isSafeInteger(token.tokenOrdinal) || token.tokenOrdinal < 0 ||
              token.tokenOrdinal <= previousOrdinal) {
            fail('INVALID_TOKEN_PASS', 'image token ordinals are not strictly increasing');
          }
          previousOrdinal = token.tokenOrdinal;
          assertDigest(token.rawTokenSha256, 'rawTokenSha256', 'INVALID_TOKEN_PASS');
          assertSafeString(token.hrefUtf8Base64, 'hrefUtf8Base64', {
            ascii: true,
            pattern: /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
            code: 'INVALID_TOKEN_PASS'
          });
          assertDigest(token.locatorDigest, 'locatorDigest', 'INVALID_TOKEN_PASS');
          const hrefBytes = decodeBase64(token.hrefUtf8Base64);
          if (hrefBytes.byteLength > LIMITS.maxHrefBytes) {
            fail('TOKEN_PASS_BUDGET_EXCEEDED', 'raw image href exceeds 4096 bytes');
          }
          let href;
          try {
            href = new TextDecoder('utf-8', { fatal: true }).decode(hrefBytes);
          } catch {
            fail('INVALID_TOKEN_PASS', 'hrefUtf8Base64 is not exact UTF-8');
          }
          const expectedLocator = locatorDigest(
            candidate.fileId,
            candidate.revision,
            token.tokenOrdinal,
            token.rawTokenSha256,
            hashBytes(hrefBytes)
          );
          if (token.locatorDigest !== expectedLocator) {
            fail('INVALID_TOKEN_PASS', 'image token locatorDigest is not reproducible');
          }
          totalTokens += 1;
          if (totalTokens > LIMITS.maxImageTokens) {
            fail('IMAGE_TOKEN_BUDGET_EXCEEDED', 'image token count exceeds 10,000');
          }
        }
      }
      const serialized = canonicalJson(value);
      if (utf8(serialized).byteLength > LIMITS.maxCanonicalBytes) {
        fail('TOKEN_PASS_BUDGET_EXCEEDED', 'canonical token pass exceeds 4 MiB');
      }
      return deepFreeze(value);
    }

    function createTokenPass(input) {
      assertExactKeys(input, INPUT_KEYS, 'INVALID_TOKEN_PASS', 'token pass input');
      assertOpaqueId(input.transactionId, 'transactionId', 'INVALID_TOKEN_PASS');
      if (!Array.isArray(input.candidates) || input.candidates.length > LIMITS.maxCandidates) {
        fail('INVALID_TOKEN_PASS', 'candidate count exceeds 300');
      }
      const candidateIds = new Set();
      const fileIds = new Set();
      let captureDigest = null;
      let markdownBytes = 0;
      const prepared = input.candidates.map(candidate => {
        const validated = prepareCandidate(candidate);
        if (candidateIds.has(validated.candidateId) || fileIds.has(validated.fileId)) {
          fail('INVALID_TOKEN_PASS', 'input has duplicate candidate/file binding');
        }
        if (captureDigest === null) captureDigest = validated.captureDigest;
        else if (validated.captureDigest !== captureDigest) {
          fail('INVALID_TOKEN_PASS', 'input candidates must share one captureDigest');
        }
        candidateIds.add(validated.candidateId);
        fileIds.add(validated.fileId);
        markdownBytes += validated.markdownBytes.byteLength;
        if (!Number.isSafeInteger(markdownBytes) || markdownBytes > LIMITS.maxMarkdownTotalBytes) {
          fail('MARKDOWN_BUDGET_EXCEEDED', 'sealed Markdown aggregate exceeds 64 MiB');
        }
        return validated;
      });
      const totals = { imageTokens: 0 };
      const outputBudget = createOutputBudget(input.transactionId);
      const candidates = prepared.map(candidate => tokenizeCandidate(candidate, totals, outputBudget));
      return assertTokenPass({
        schema: TOKEN_PASS_SCHEMA,
        transactionId: input.transactionId,
        parserId: PARSER_ID,
        candidates
      });
    }

    return Object.freeze({
      PARSER_ID,
      MARKED_OPTIONS,
      LIMITS,
      SCHEMA_KEYS,
      canonicalJson,
      assertTokenPass,
      createTokenPass
    });
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object') return value;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if (Object.prototype.hasOwnProperty.call(descriptor, 'value')) deepFreeze(descriptor.value);
    }
    return Object.isFrozen(value) ? value : Object.freeze(value);
  }

  return Object.freeze({
    TOKEN_PASS_SCHEMA,
    TOKEN_LOCATOR_SCHEMA,
    PARSER_ID,
    MARKED_OPTIONS,
    LIMITS,
    SCHEMA_KEYS,
    createAdapter
  });
});
