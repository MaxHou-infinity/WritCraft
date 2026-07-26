'use strict';

const path = require('path');
const diagnosticExportService = require('./diagnostic-export-service');

const REQUEST_KEYS = new Set(['schema', 'token']);

function fail(code, message) {
  throw new diagnosticExportService.DiagnosticExportError(code, message);
}

function exactRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Object.getPrototypeOf(request) !== Object.prototype) {
    fail('INVALID_DIAGNOSTIC_EXPORT', '诊断导出请求无效');
  }
  for (const key of Object.keys(request)) {
    if (!REQUEST_KEYS.has(key)) fail('INVALID_DIAGNOSTIC_EXPORT', '诊断导出请求包含禁止字段');
  }
  if (request.schema !== diagnosticExportService.EXPORT_SCHEMA ||
      typeof request.token !== 'string' || !/^[a-f0-9]{32,128}$/.test(request.token)) {
    fail('INVALID_DIAGNOSTIC_EXPORT', '诊断导出请求无效');
  }
  return Object.freeze({ schema: request.schema, token: request.token });
}

function defaultFileName(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `WritCraft-diagnostics-${stamp}.json`;
}

function sameBinding(left, right) {
  return left?.webContentsId === right?.webContentsId &&
    left?.projectInstanceId === right?.projectInstanceId &&
    left?.mutationGeneration === right?.mutationGeneration &&
    left?.navigationEpoch === right?.navigationEpoch;
}

function createDiagnosticExportHandler(options = {}) {
  const {
    assertTrustedSender,
    captureBinding,
    createBundleInput,
    previewStore,
    showSaveDialog,
    writeFile = diagnosticExportService.writeDiagnosticFileExclusive,
    now = () => new Date(),
  } = options;
  for (const [name, value] of Object.entries({
    assertTrustedSender,
    captureBinding,
    createBundleInput,
    showSaveDialog,
    writeFile,
  })) {
    if (typeof value !== 'function') throw new TypeError(`${name} is required`);
  }
  if (!previewStore || typeof previewStore.issue !== 'function' ||
      typeof previewStore.get !== 'function' ||
      typeof previewStore.consumeCommitted !== 'function') {
    throw new TypeError('previewStore is required');
  }

  const inFlightTokens = new Set();

  async function preview(event) {
    assertTrustedSender(event);
    const binding = captureBinding(event);
    const input = await createBundleInput();
    const currentBinding = captureBinding(event);
    if (!sameBinding(binding, currentBinding)) {
      fail('DIAGNOSTIC_PREVIEW_STALE', '项目状态已经变化，请重新预览');
    }
    const bundle = diagnosticExportService.buildDiagnosticBundle(input);
    const serialized = diagnosticExportService.serializeDiagnosticBundle(bundle);
    const issued = previewStore.issue({ serialized, binding: currentBinding });
    return Object.freeze({
      ok: true,
      schema: diagnosticExportService.PREVIEW_SCHEMA,
      token: issued.token,
      expiresAt: issued.expiresAt,
      serialized,
    });
  }

  async function exportPreview(event, rawRequest) {
    assertTrustedSender(event);
    const request = exactRequest(rawRequest);
    const binding = captureBinding(event);
    const previewRecord = previewStore.get(request.token, binding);
    if (inFlightTokens.has(request.token)) {
      fail('DIAGNOSTIC_EXPORT_IN_PROGRESS', '这份诊断正在导出');
    }
    inFlightTokens.add(request.token);
    try {
      const selected = await showSaveDialog({
        defaultName: defaultFileName(now()),
      });
      if (!selected || selected.canceled === true) {
        return Object.freeze({ ok: true, canceled: true, saved: false });
      }
      if (typeof selected.filePath !== 'string' || !path.isAbsolute(selected.filePath)) {
        fail('INVALID_DIAGNOSTIC_TARGET', '诊断导出位置无效');
      }

      // The native dialog is an asynchronous authority boundary. A project
      // switch or navigation while it is open invalidates the preview before
      // any filesystem write.
      const currentBinding = captureBinding(event);
      const currentRecord = previewStore.get(request.token, currentBinding);
      if (currentRecord.serialized !== previewRecord.serialized) {
        fail('DIAGNOSTIC_PREVIEW_STALE', '诊断预览已经失效，请重新预览');
      }

      writeFile(selected.filePath, currentRecord.serialized);
      // writeFile is synchronous and fsyncs before returning. Once it returns,
      // the durable filesystem result is authoritative; a TTL boundary crossed
      // during fsync must not be reported as a failed export.
      previewStore.consumeCommitted(
        request.token,
        currentBinding,
        currentRecord.serialized
      );
      return Object.freeze({
        ok: true,
        schema: diagnosticExportService.EXPORT_SCHEMA,
        canceled: false,
        saved: true,
        basename: path.basename(selected.filePath),
      });
    } finally {
      inFlightTokens.delete(request.token);
    }
  }

  return Object.freeze({ preview, exportPreview });
}

module.exports = {
  createDiagnosticExportHandler,
  exactRequest,
  defaultFileName,
};
