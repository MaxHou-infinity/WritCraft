#!/usr/bin/env node
'use strict';

const path = require('path');
const service = require('../src/main/author-acceptance-preflight-service');

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--project', '--copy-to', '--name'].includes(argument)) {
      throw Object.assign(new Error('unknown argument'), { code: 'INVALID_ARGUMENT' });
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw Object.assign(new Error('missing argument value'), { code: 'INVALID_ARGUMENT' });
    }
    const key = argument.slice(2);
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      throw Object.assign(new Error('duplicate argument'), { code: 'DUPLICATE_ARGUMENT' });
    }
    result[key] = value;
    index += 1;
  }
  if (!result.project) {
    throw Object.assign(new Error('--project is required'), { code: 'PROJECT_REQUIRED' });
  }
  if ((result['copy-to'] && !result.name) || (!result['copy-to'] && result.name)) {
    throw Object.assign(new Error('--copy-to and --name must be used together'), { code: 'COPY_ARGUMENTS_INCOMPLETE' });
  }
  return result;
}

function safeError(error) {
  const allowed = new Set([
    'INVALID_ARGUMENT', 'DUPLICATE_ARGUMENT', 'PROJECT_REQUIRED', 'COPY_ARGUMENTS_INCOMPLETE',
    'INVALID_PATH', 'NOT_FOUND', 'NOT_DIRECTORY', 'SYMLINK_NOT_ALLOWED',
    'HARD_LINK_NOT_ALLOWED', 'UNSUPPORTED_ENTRY', 'PATH_TRAVERSAL',
    'PATH_IDENTITY_CHANGED', 'SOURCE_PATH_CHANGED', 'INVALID_LIMIT',
    'FILE_TOO_LARGE', 'TREE_TOO_LARGE', 'TREE_TOO_DEEP', 'PROJECT_TOO_LARGE',
    'SOURCE_CHANGED', 'INVALID_COPY_NAME', 'INVALID_RANDOM',
    'PROJECT_NOT_ELIGIBLE', 'COPY_DESTINATION_INSIDE_SOURCE',
    'COPY_ALREADY_EXISTS', 'COPY_RESERVATION_UNCERTAIN',
    'COPY_ATOMIC_PUBLISH_UNAVAILABLE', 'COPY_ATOMIC_PUBLISH_FAILED',
    'COPY_PUBLISH_UNCERTAIN',
    'COPY_VERIFY_FAILED', 'COPY_TARGET_CHANGED', 'COPY_WRITE_STALLED',
    'COPY_TREE_CONFLICT', 'COPY_MANIFEST_CONFLICT', 'COPY_COMMIT_FAILED',
    'COPY_CLEANUP_INCOMPLETE', 'COPY_COMMITTED_SOURCE_CHANGED',
    'COPY_COMMITTED_TARGET_CHANGED',
    'COPY_COMMITTED_FSYNC_FAILED', 'CWD_LEASE_BUSY', 'CWD_RESTORE_FAILED',
  ]);
  return allowed.has(error?.code) ? error.code : 'PREFLIGHT_FAILED';
}

function publicReport(result) {
  return {
    schema: result.schema,
    eligible: result.eligible,
    checks: result.checks,
    requirements: result.requirements,
    errors: result.errors,
    snapshotDigest: result.snapshotDigest,
  };
}

function main() {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (!args['copy-to']) {
      const result = service.inspectProject(path.resolve(args.project));
      console.log(JSON.stringify(publicReport(result), null, 2));
      process.exitCode = result.eligible ? 0 : 2;
      return;
    }
    const result = service.createWorkingCopy({
      rootPath: path.resolve(args.project),
      destinationParent: path.resolve(args['copy-to']),
      copyName: args.name,
    });
    console.log(JSON.stringify({
      schema: result.schema,
      ok: result.ok,
      copyCreated: result.copyCreated,
      sourceUnchanged: result.sourceUnchanged,
      sourceSnapshotDigest: result.sourceSnapshotDigest,
      fileCount: result.fileCount,
      totalBytes: result.totalBytes,
      preflight: publicReport(result.preflight),
    }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      schema: service.PREFLIGHT_SCHEMA,
      ok: false,
      error: safeError(error),
      committed: error?.committed === true,
    }));
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = { parseArguments, safeError, publicReport };
