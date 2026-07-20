import path from "node:path";
import { performance } from "node:perf_hooks";
import { isProxy } from "node:util/types";

import { createFileBatches } from "./batches.mjs";
import { throwIfAborted } from "./concurrency.mjs";
import { materializeRecords } from "./materializer.mjs";
import { scanProject } from "./scanner.mjs";
import { processFileBatches, validateFileProcessingResults } from "./worker-pool.mjs";

const DEFAULT_DEPENDENCIES = Object.freeze({
  scanProject,
  createFileBatches,
  processFileBatches,
  materializeRecords,
  now: () => performance.now(),
});

const RESULT_STATUSES = new Set([
  "metadata",
  "parsed",
  "binary",
  "error",
  "unstable",
  "operational-error",
]);
const RECORD_REQUIRED_STATUSES = new Set(["metadata", "parsed", "binary", "error"]);
const RECORDLESS_STATUSES = new Set(["unstable", "operational-error"]);
const SKIPPED_REASONS = new Set([
  "symbolic-link",
  "unsupported-file-type",
  "file-too-large",
]);

function selectDefined(options, keys) {
  return Object.fromEntries(
    keys.filter((key) => options[key] !== undefined).map((key) => [key, options[key]]),
  );
}

function resolveDependencies(overrides) {
  if (overrides !== undefined
    && (overrides === null || typeof overrides !== "object" || Array.isArray(overrides))) {
    throw new TypeError("dependencies must be an object");
  }
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  for (const name of Object.keys(DEFAULT_DEPENDENCIES)) {
    if (typeof dependencies[name] !== "function") {
      throw new TypeError(`dependencies.${name} must be a function`);
    }
  }
  return dependencies;
}

function readClock(now) {
  const value = now();
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("dependencies.now must return a finite number");
  }
  return Object.is(value, -0) ? 0 : value;
}

function elapsed(start, end) {
  if (end <= start) return 0;
  const difference = end - start;
  return Number.isFinite(difference) ? difference : Number.MAX_VALUE;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function diagnosticErrorCode(error) {
  try {
    const code = error?.code;
    if (["string", "number"].includes(typeof code) && /^[A-Za-z0-9_-]+$/.test(String(code))) {
      return String(code);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function canonicalRelativePath(value, label = "diagnostic path") {
  if (typeof value !== "string") {
    throw new TypeError(`${label} must be a canonical relative path`);
  }
  const raw = value;
  if (!raw || raw.includes("\0") || raw.includes("\\") || raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) {
    throw new TypeError(`${label} must be a canonical relative path`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== raw) {
    throw new TypeError(`${label} must be a canonical relative path`);
  }
  return normalized;
}

function looksLikeMachineAbsolutePath(value, forbiddenPaths) {
  let withoutHttpUrls = value.replace(/\bhttps?:\/\/[^\s"'`<>()]+/gi, "");
  withoutHttpUrls = withoutHttpUrls
    .replace(/\bROUTE_\/[^\s,;"'`<>()]+/gi, "ROUTE_")
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/[^\s,;"'`<>()]+/gi, "HTTP_METHOD")
    .replace(/\bRequest\s+\/[^\s,;"'`<>()]+/gi, "Request");
  if (forbiddenPaths.some((candidate) => withoutHttpUrls.includes(candidate))) return true;
  return /file:\/\//i.test(withoutHttpUrls)
    || /(?:^|[\s:(="'])[A-Za-z]:[\\/]/.test(withoutHttpUrls)
    || /(?:^|[\s:(="'])(?:\\\\|\/\/)[^\\/\s]+[\\/][^\\/\s]+/.test(withoutHttpUrls)
    || /(?:^|[^A-Za-z0-9._~!$&'*+\-=?@%])\/[^\s,;"'`<>()]+/.test(withoutHttpUrls);
}

function diagnosticForbiddenPaths(scan) {
  return [...new Set([
    scan.root,
    scan.root.replaceAll("\\", "/"),
    scan.root.replaceAll("/", "\\"),
  ].filter((value) => typeof value === "string" && value.length > 1))];
}

function assertDiagnosticText(field, value, relativePath, forbiddenPaths) {
  if (looksLikeMachineAbsolutePath(value, forbiddenPaths)) {
    throw new TypeError(`diagnostic ${field} must not contain an absolute path (${relativePath})`);
  }
}

function normalizeDiagnostic(diagnostic, fallbackPath, forbiddenPaths = []) {
  if (!isPlainObject(diagnostic)) throw new TypeError("diagnostic must be an object");
  const relativePath = canonicalRelativePath(
    diagnostic.relativePath ?? diagnostic.path ?? fallbackPath,
  );
  if (typeof diagnostic.code !== "string" || diagnostic.code.length === 0) {
    throw new TypeError(`diagnostic code is required: ${relativePath}`);
  }
  assertDiagnosticText("code", diagnostic.code, relativePath, forbiddenPaths);
  if (typeof diagnostic.message !== "string") {
    throw new TypeError(`diagnostic message is required: ${relativePath}`);
  }
  assertDiagnosticText("message", diagnostic.message, relativePath, forbiddenPaths);
  const normalized = { code: diagnostic.code, relativePath };
  if (diagnostic.operation !== undefined) {
    if (typeof diagnostic.operation !== "string") {
      throw new TypeError(`diagnostic operation must be a string: ${relativePath}`);
    }
    assertDiagnosticText("operation", diagnostic.operation, relativePath, forbiddenPaths);
    normalized.operation = diagnostic.operation;
  }
  if (diagnostic.errorCode !== undefined) {
    if (!["string", "number"].includes(typeof diagnostic.errorCode)) {
      throw new TypeError(`diagnostic errorCode must be text or a number: ${relativePath}`);
    }
    normalized.errorCode = String(diagnostic.errorCode);
    assertDiagnosticText("errorCode", normalized.errorCode, relativePath, forbiddenPaths);
  }
  normalized.message = diagnostic.message;
  return normalized;
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function fileInsideRoot(root, absolutePath) {
  let relative;
  try {
    relative = path.relative(root, absolutePath);
  } catch {
    return false;
  }
  return relative !== ""
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function assertFileContract(file, label, root) {
  if (!isPlainObject(file)) throw new TypeError(`${label} must be a plain object`);
  const relativePath = canonicalRelativePath(file.path, `${label}.path`);
  if (typeof file.absolutePath !== "string"
    || !path.isAbsolute(file.absolutePath)
    || !fileInsideRoot(root, file.absolutePath)
    || toPosix(path.relative(root, file.absolutePath)) !== relativePath) {
    throw new TypeError(`${label}.absolutePath must be inside scanProject result.root`);
  }
  if (typeof file.language !== "string") throw new TypeError(`${label}.language must be a string`);
  if (typeof file.category !== "string") throw new TypeError(`${label}.category must be a string`);
  if (!Number.isSafeInteger(file.size) || file.size < 0 || Object.is(file.size, -0)) {
    throw new TypeError(`${label}.size must be a non-negative safe integer`);
  }
  if (!Number.isFinite(file.mtimeMs) || Object.is(file.mtimeMs, -0)) {
    throw new TypeError(`${label}.mtimeMs must be finite`);
  }
  return relativePath;
}

function compareFileMetadata(left, right) {
  return left.absolutePath === right.absolutePath
    && left.language === right.language
    && left.category === right.category
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs;
}

function hasExactKeys(value, keys) {
  const actual = Reflect.ownKeys(value);
  return actual.length === keys.length
    && actual.every((key) => typeof key === "string" && keys.includes(key));
}

function assertSkippedEntries(skipped) {
  skipped.forEach((entry, index) => {
    const label = `scanProject result.skipped[${index}]`;
    if (!isPlainObject(entry)) throw new TypeError(`${label} must be a plain object`);
    canonicalRelativePath(entry.path, `${label}.path`);
    if (!SKIPPED_REASONS.has(entry.reason)) throw new TypeError(`${label}.reason is invalid`);
    if (entry.reason === "file-too-large") {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0 || Object.is(entry.size, -0)) {
        throw new TypeError(`${label}.size must be a non-negative safe integer`);
      }
      if (!hasExactKeys(entry, ["path", "reason", "size"])) {
        throw new TypeError(`${label} has an invalid shape`);
      }
    } else if (!hasExactKeys(entry, ["path", "reason"])) {
      throw new TypeError(`${label} has an invalid shape`);
    }
  });
}

function assertScanResult(scan) {
  if (!isPlainObject(scan)) throw new TypeError("scanProject result must be a plain object");
  if (typeof scan.root !== "string" || !scan.root || !path.isAbsolute(scan.root) || scan.root.includes("\0")) {
    throw new TypeError("scanProject result.root must be an absolute path string");
  }
  for (const field of ["files", "skipped", "diagnostics"]) {
    if (!Array.isArray(scan[field])) throw new TypeError(`scanProject result.${field} must be an array`);
  }
  assertSkippedEntries(scan.skipped);
  const filesByPath = new Map();
  scan.files.forEach((file, index) => {
    const relativePath = assertFileContract(file, `scanProject result.files[${index}]`, scan.root);
    if (filesByPath.has(relativePath)) {
      throw new TypeError(`scanProject result.files contains duplicate path: ${relativePath}`);
    }
    filesByPath.set(relativePath, file);
  });
  return filesByPath;
}

function assertBatchPlan(plan, scanFilesByPath, root) {
  if (!isPlainObject(plan)) throw new TypeError("createFileBatches result must be a plain object");
  for (const field of ["batches", "metadata"]) {
    if (!Array.isArray(plan[field])) throw new TypeError(`createFileBatches result.${field} must be an array`);
  }
  const planFilesByPath = new Map();
  const addFile = (file, label) => {
    const relativePath = assertFileContract(file, label, root);
    if (planFilesByPath.has(relativePath)) {
      throw new TypeError(`createFileBatches result contains duplicate path: ${relativePath}`);
    }
    planFilesByPath.set(relativePath, file);
  };
  plan.batches.forEach((batch, index) => {
    if (!isPlainObject(batch)
      || typeof batch.id !== "string"
      || !batch.id
      || batch.id.includes("\0")
      || !Array.isArray(batch.files)
      || batch.files.length === 0) {
      throw new TypeError(`createFileBatches result.batches[${index}] must contain an id and non-empty files array`);
    }
    batch.files.forEach((file, fileIndex) => addFile(
      file,
      `createFileBatches result.batches[${index}].files[${fileIndex}]`,
    ));
  });
  plan.metadata.forEach((file, index) => addFile(file, `createFileBatches result.metadata[${index}]`));
  if (planFilesByPath.size !== scanFilesByPath.size
    || [...scanFilesByPath.keys()].some((relativePath) => !planFilesByPath.has(relativePath))) {
    throw new TypeError("createFileBatches result paths must exactly match scanProject result.files");
  }
  for (const [relativePath, file] of planFilesByPath) {
    if (!compareFileMetadata(file, scanFilesByPath.get(relativePath))) {
      throw new TypeError("createFileBatches file metadata must match scanProject result.files");
    }
  }
  return planFilesByPath;
}

function assertProcessingResults(results, planFilesByPath) {
  if (!Array.isArray(results)) throw new TypeError("processFileBatches result must be an array");
  const paths = new Set();
  results.forEach((result, index) => {
    const label = `processFileBatches result[${index}]`;
    if (!isPlainObject(result)) throw new TypeError(`${label} must be a plain object`);
    if (!RESULT_STATUSES.has(result.status)) throw new TypeError(`${label}.status is invalid`);
    let relativePath;
    try {
      relativePath = canonicalRelativePath(result.relativePath, `${label}.relativePath`);
    } catch {
      throw new TypeError(`${label}.relativePath must be a canonical relative path`);
    }
    if (paths.has(relativePath) || !planFilesByPath.has(relativePath)) {
      throw new TypeError("processFileBatches result paths must exactly match createFileBatches result");
    }
    paths.add(relativePath);
    if (result.record !== null && !isPlainObject(result.record)) {
      throw new TypeError(`${label}.record must be null or a plain object`);
    }
    if (result.record !== null) {
      if (result.record.relativePath !== result.relativePath) {
        throw new TypeError(`${label}.record.relativePath must match result.relativePath`);
      }
      if (result.record.status !== result.status) {
        throw new TypeError(`${label}.record.status must match result.status`);
      }
    }
    if (RECORD_REQUIRED_STATUSES.has(result.status) && result.record === null) {
      throw new TypeError(`${label}.record must be non-null for ${result.status}`);
    }
    if (RECORDLESS_STATUSES.has(result.status) && result.record !== null) {
      throw new TypeError(`${label}.record must be null for ${result.status}`);
    }
    if (typeof result.reused !== "boolean") throw new TypeError(`${label}.reused must be a boolean`);
    if (!Array.isArray(result.diagnostics)) throw new TypeError(`${label}.diagnostics must be an array`);
  });
  if (paths.size !== planFilesByPath.size) {
    throw new TypeError("processFileBatches result paths must exactly match createFileBatches result");
  }
  return validateFileProcessingResults(results, [...planFilesByPath.values()]);
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareDiagnostics(left, right) {
  return compareText(left.relativePath, right.relativePath)
    || compareText(left.code, right.code)
    || compareText(left.operation ?? "", right.operation ?? "")
    || compareText(left.errorCode ?? "", right.errorCode ?? "")
    || compareText(left.message, right.message);
}

function collectDiagnostics(scanDiagnostics, results, forbiddenPaths) {
  const diagnostics = scanDiagnostics.map((diagnostic) => normalizeDiagnostic(diagnostic, undefined, forbiddenPaths));
  for (const result of results) {
    if (!["operational-error", "unstable"].includes(result.status)) continue;
    for (const diagnostic of result.diagnostics ?? []) {
      diagnostics.push(normalizeDiagnostic(diagnostic, result.relativePath, forbiddenPaths));
    }
  }
  return diagnostics.sort(compareDiagnostics);
}

function countStatuses(results) {
  const counts = new Map();
  for (const result of results) {
    const status = String(result.status);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => compareText(left, right)));
}

export async function analyzeProjectDetailed(projectRoot, options = {}) {
  const dependencies = resolveDependencies(options.dependencies);
  if (options.cacheWriter !== undefined && typeof options.cacheWriter !== "function") {
    throw new TypeError("cacheWriter must be a function");
  }
  const signal = options.signal;
  throwIfAborted(signal);

  const startedAt = readClock(dependencies.now);
  const scan = await dependencies.scanProject(projectRoot, selectDefined(options, [
    "workers",
    "scanConcurrency",
    "ignore",
    "maxFileBytes",
    "io",
    "signal",
  ]));
  throwIfAborted(signal);
  const scanFilesByPath = assertScanResult(scan);
  const scannedAt = readClock(dependencies.now);

  const plan = dependencies.createFileBatches(scan.files, selectDefined(options, [
    "targetBytes",
    "maxFiles",
  ]));
  throwIfAborted(signal);
  const planFilesByPath = assertBatchPlan(plan, scanFilesByPath, scan.root);
  const batchedAt = readClock(dependencies.now);

  const rawResults = await dependencies.processFileBatches(plan, selectDefined(options, [
    "workers",
    "workerUrl",
    "workerFactory",
    "workerData",
    "startupTimeoutMs",
    "mainThreadProcessor",
    "cached",
    "signal",
  ]));
  throwIfAborted(signal);
  const results = assertProcessingResults(rawResults, planFilesByPath);
  const processedAt = readClock(dependencies.now);

  const diagnostics = collectDiagnostics(
    scan.diagnostics,
    results,
    diagnosticForbiddenPaths(scan),
  );
  const records = results.flatMap((result) => result.record === null ? [] : [result.record]);
  const graph = dependencies.materializeRecords({
    projectRoot: scan.root,
    records,
    skipped: scan.skipped,
  });
  throwIfAborted(signal);
  if (options.cacheWriter) {
    try {
      await options.cacheWriter(results, { signal });
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      const cacheErrorCode = diagnosticErrorCode(error);
      diagnostics.push({
        code: "cache-write-error",
        relativePath: ".legacy-code-atlas/cache.json",
        operation: "cache-write",
        ...(cacheErrorCode === undefined ? {} : { errorCode: cacheErrorCode }),
        message: "Unable to write file cache",
      });
      diagnostics.sort(compareDiagnostics);
    }
  }
  const completedAt = readClock(dependencies.now);

  return {
    graph,
    diagnostics,
    timings: {
      scanMs: elapsed(startedAt, scannedAt),
      batchMs: elapsed(scannedAt, batchedAt),
      processMs: elapsed(batchedAt, processedAt),
      materializeMs: elapsed(processedAt, completedAt),
      totalMs: elapsed(startedAt, completedAt),
    },
    stats: {
      scanned: scan.files.length,
      skipped: scan.skipped.length,
      batches: plan.batches.length,
      results: results.length,
      records: records.length,
      reused: results.filter((result) => result.reused === true).length,
      statuses: countStatuses(results),
    },
  };
}

export async function analyzeProject(projectRoot, options = {}) {
  const { graph } = await analyzeProjectDetailed(projectRoot, options);
  return graph;
}
