import { availableParallelism } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";
import { Worker } from "node:worker_threads";

import { createAbortError, throwIfAborted } from "./concurrency.mjs";
import { FACT_SCHEMA, PARSER_VERSIONS, parserKindFor } from "./file-facts.mjs";
import { readAndProcessFile } from "./file-processor.mjs";

const DEFAULT_WORKER_URL = new URL("./workers/parse-worker.mjs", import.meta.url);
const PROTOCOL_VERSION = 1;
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;
const RESULT_KEYS = [
  "status",
  "relativePath",
  "parserKind",
  "fingerprint",
  "metadata",
  "record",
  "reused",
  "diagnostics",
];
const RECORD_KEYS = [
  "factSchema",
  "relativePath",
  "language",
  "category",
  "size",
  "parserKind",
  "parserVersion",
  "status",
  "facts",
  "warnings",
  "diagnostics",
];
const RECORD_ERROR_KEYS = [...RECORD_KEYS, "error"];
const RESULT_STATUSES = new Set([
  "metadata",
  "parsed",
  "binary",
  "error",
  "unstable",
  "operational-error",
]);
const FORBIDDEN_KEYS = new Set([
  "graph",
  "graphbuilder",
  "node",
  "nodes",
  "edge",
  "edges",
  "worker",
  "workers",
  "workerid",
  "workerindex",
  "timing",
  "timings",
  "duration",
  "durationms",
  "elapsed",
  "elapsedms",
  "batchid",
  "dispatchid",
  "startedat",
  "completedat",
  "absolutepath",
]);

class StartupFailure extends Error {
  constructor() {
    super("worker startup failed");
    this.name = "StartupFailure";
  }
}

class WorkerFailure extends Error {
  constructor() {
    super("worker failed");
    this.name = "WorkerFailure";
  }
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && !isProxy(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) return false;
  const actual = ownKeys.sort(compareText);
  const expected = [...keys].sort(compareText);
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function normalizedKey(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function resolveWorkerCount(value) {
  return value === undefined
    ? Math.min(8, Math.max(1, availableParallelism() - 1))
    : positiveInteger("workers", value);
}

function canonicalRelativePath(file) {
  const raw = String(file?.relativePath ?? file?.path ?? "").replaceAll("\\", "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || raw.startsWith("//") || /^[A-Za-z]:/.test(raw)) {
    throw new TypeError(`file path must be a relative path: ${raw}`);
  }
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new TypeError(`file path must be a relative path: ${raw}`);
  }
  return normalized;
}

function normalizePlan(input) {
  const batches = Array.isArray(input) ? input : input?.batches;
  const metadata = Array.isArray(input) ? [] : input?.metadata ?? [];
  if (!Array.isArray(batches)) throw new TypeError("batches must be an array");
  if (!Array.isArray(metadata)) throw new TypeError("metadata must be an array");

  const paths = new Set();
  const normalizedBatches = batches.map((batch, batchIndex) => {
    if (!isPlainObject(batch)
      || typeof batch.id !== "string"
      || batch.id.length === 0
      || batch.id.includes("\0")
      || !Array.isArray(batch.files)
      || batch.files.length === 0) {
      throw new TypeError(`invalid batch at index ${batchIndex}`);
    }
    const files = [...batch.files].sort(
      (left, right) => compareText(canonicalRelativePath(left), canonicalRelativePath(right)),
    );
    for (const file of files) {
      const relativePath = canonicalRelativePath(file);
      if (paths.has(relativePath)) throw new TypeError(`duplicate relative path: ${relativePath}`);
      paths.add(relativePath);
    }
    return {
      id: batch.id,
      files,
      sortKey: files.map(canonicalRelativePath).join("\0"),
    };
  });

  const normalizedMetadata = [...metadata].sort(
    (left, right) => compareText(canonicalRelativePath(left), canonicalRelativePath(right)),
  );
  for (const file of normalizedMetadata) {
    const relativePath = canonicalRelativePath(file);
    if (paths.has(relativePath)) throw new TypeError(`duplicate relative path: ${relativePath}`);
    paths.add(relativePath);
  }

  normalizedBatches.sort((left, right) => compareText(left.sortKey, right.sortKey)
    || compareText(left.id, right.id));
  const allFiles = [
    ...normalizedBatches.flatMap((batch) => batch.files),
    ...normalizedMetadata,
  ].sort((left, right) => compareText(canonicalRelativePath(left), canonicalRelativePath(right)));

  return { batches: normalizedBatches, metadata: normalizedMetadata, allFiles };
}

function assertJsonSafe(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw new WorkerFailure();
    return;
  }
  if (typeof value !== "object"
    || isProxy(value)
    || Buffer.isBuffer(value)
    || value instanceof Map
    || value instanceof Set
    || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)
    || ancestors.has(value)) {
    throw new WorkerFailure();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Reflect.ownKeys(value).length !== value.length + 1) throw new WorkerFailure();
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new WorkerFailure();
        }
        assertJsonSafe(descriptor.value, ancestors);
      }
      return;
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || FORBIDDEN_KEYS.has(normalizedKey(key))) {
        throw new WorkerFailure();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new WorkerFailure();
      }
      assertJsonSafe(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function containsString(value, predicate) {
  if (typeof value === "string") return predicate(value);
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => containsString(item, predicate));
  return Object.values(value).some((item) => containsString(item, predicate));
}

function looksLikeMachineAbsolutePath(value) {
  const withoutWebUrls = value.replace(/\bhttps?:\/\/[^\s"'`<>()]+/gi, "");
  return /file:\/\//i.test(withoutWebUrls)
    || /(?:^|[\s:(="'])[A-Za-z]:[\\/]/.test(withoutWebUrls)
    || /(?:^|[\s:(="'])(?:\\\\|\/\/)[^\\/\s]+[\\/][^\\/\s]+/.test(withoutWebUrls)
    || /(?:^|[\s:(="'])\/(?:private|Users|home|tmp|var|etc|opt|usr|mnt|srv|root|Volumes)(?:\/|$)/.test(withoutWebUrls);
}

function sourceRootFor(file) {
  if (typeof file?.absolutePath !== "string" || file.absolutePath.length === 0) return null;
  let root = file.absolutePath;
  for (const _part of canonicalRelativePath(file).split("/")) root = path.dirname(root);
  return root;
}

function forbiddenPathVariants(files) {
  const roots = [...new Set(files.map(sourceRootFor).filter(Boolean))];
  if (roots.length !== 1 || roots[0].length <= 1) return [];
  return [...new Set([
    roots[0],
    roots[0].replaceAll("\\", "/"),
  ])];
}

function assertNoAbsolutePathLeaks(result, pathVariants) {
  if (containsString(result, (value) => pathVariants.some((candidate) => value.includes(candidate)))) {
    throw new WorkerFailure();
  }
  if (containsString(result, looksLikeMachineAbsolutePath)) throw new WorkerFailure();
}

function safeMetadata(metadata) {
  if (!hasExactKeys(metadata, ["size", "mtimeMs"])) throw new WorkerFailure();
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0) throw new WorkerFailure();
  if (!Number.isFinite(metadata.mtimeMs) || Object.is(metadata.mtimeMs, -0)) throw new WorkerFailure();
}

function safeFingerprint(fingerprint) {
  if (typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new WorkerFailure();
  }
}

function validateError(error) {
  if (!isPlainObject(error)
    || ![2, 3].includes(Reflect.ownKeys(error).length)
    || !hasExactKeys(error, Object.hasOwn(error, "code")
      ? ["name", "message", "code"]
      : ["name", "message"])
    || typeof error.name !== "string"
    || typeof error.message !== "string"
    || (Object.hasOwn(error, "code") && typeof error.code !== "string")) {
    throw new WorkerFailure();
  }
}

function validateRecord(record, result, file) {
  const recordKeys = result.status === "error" ? RECORD_ERROR_KEYS : RECORD_KEYS;
  if (!isPlainObject(record) || !hasExactKeys(record, recordKeys)) throw new WorkerFailure();
  const expectedParserKind = parserKindFor(file);
  const expectedLanguage = String(file?.language ?? "");
  const expectedCategory = String(file?.category ?? "");
  if (record.factSchema !== FACT_SCHEMA
    || record.relativePath !== result.relativePath
    || record.language !== expectedLanguage
    || record.category !== expectedCategory
    || record.size !== result.metadata.size
    || record.parserKind !== expectedParserKind
    || record.parserVersion !== PARSER_VERSIONS[expectedParserKind]
    || record.status !== result.status
    || !Array.isArray(record.warnings)
    || !Array.isArray(record.diagnostics)
    || !isDeepStrictEqual(record.diagnostics, result.diagnostics)) {
    throw new WorkerFailure();
  }
  if (result.status === "metadata") {
    if (expectedParserKind !== "metadata"
      || !isPlainObject(record.facts)
      || Reflect.ownKeys(record.facts).length !== 0) throw new WorkerFailure();
  } else if (result.status === "parsed") {
    if (!isPlainObject(record.facts)) throw new WorkerFailure();
  } else if (result.status === "binary" || result.status === "error") {
    if (record.facts !== null) throw new WorkerFailure();
  }
  if (result.status === "error") validateError(record.error);
}

function validateResults(results, files, options = {}) {
  if (!Array.isArray(results) || results.length !== files.length) throw new WorkerFailure();
  const expected = new Map(files.map((file) => [canonicalRelativePath(file), file]));
  const pathVariants = forbiddenPathVariants(files);
  const seen = new Set();
  for (const result of results) {
    assertJsonSafe(result);
    if (!hasExactKeys(result, RESULT_KEYS)
      || typeof result.relativePath !== "string"
      || !expected.has(result.relativePath)
      || seen.has(result.relativePath)
      || !RESULT_STATUSES.has(result.status)
      || typeof result.parserKind !== "string"
      || result.parserKind !== parserKindFor(expected.get(result.relativePath))
      || typeof result.reused !== "boolean"
      || !Array.isArray(result.diagnostics)) {
      throw new WorkerFailure();
    }
    safeMetadata(result.metadata);
    const file = expected.get(result.relativePath);
    if (result.status === "metadata") {
      if (result.fingerprint !== null || result.reused || result.record === null) throw new WorkerFailure();
    } else if (result.status === "unstable" || result.status === "operational-error") {
      if (result.fingerprint !== null || result.reused || result.record !== null) throw new WorkerFailure();
    } else {
      if (result.record === null) throw new WorkerFailure();
      safeFingerprint(result.fingerprint);
    }
    if (result.record !== null) validateRecord(result.record, result, file);
    assertNoAbsolutePathLeaks(result, pathVariants);
    seen.add(result.relativePath);
  }
  if (seen.size !== expected.size) throw new WorkerFailure();
  return options.sort === false
    ? results
    : [...results].sort(
        (left, right) => compareText(left.relativePath, right.relativePath),
      );
}

export function validateFileProcessingResults(results, files) {
  try {
    return validateResults(results, files, { sort: false });
  } catch {
    throw new TypeError("processFileBatches result violates the file-result contract");
  }
}

function readyMessage(message) {
  return hasExactKeys(message, ["type", "protocolVersion"])
    && message.type === "ready"
    && message.protocolVersion === PROTOCOL_VERSION;
}

function resultMessage(message, batchId, files) {
  if (!hasExactKeys(message, ["type", "batchId", "results"])
    || message.type !== "batch-result"
    || message.batchId !== batchId) {
    throw new WorkerFailure();
  }
  return validateResults(message.results, files);
}

function workerLike(worker) {
  return worker
    && typeof worker.on === "function"
    && typeof worker.off === "function"
    && typeof worker.postMessage === "function"
    && typeof worker.terminate === "function";
}

function createWorkerHandle(workerFactory, workerUrl, workerOptions, startupTimeoutMs) {
  let worker;
  try {
    worker = workerFactory(workerUrl, workerOptions);
  } catch {
    throw new StartupFailure();
  }
  if (!workerLike(worker)) throw new StartupFailure();

  let phase = "starting";
  let online = false;
  let dead = false;
  let intentional = false;
  let current = null;
  let readyResolve;
  let readyReject;
  let terminationPromise;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const startupTimer = setTimeout(() => fail(new StartupFailure()), startupTimeoutMs);
  startupTimer.unref?.();

  function detach() {
    clearTimeout(startupTimer);
    worker.off("online", onOnline);
    worker.off("message", onMessage);
    worker.off("error", onError);
    worker.off("exit", onExit);
  }

  function rejectPending(error) {
    if (phase === "starting") readyReject(error);
    if (current) {
      const pending = current;
      current = null;
      pending.reject(error);
    }
  }

  function fail(error) {
    if (dead) return;
    dead = true;
    clearTimeout(startupTimer);
    rejectPending(error);
  }

  function onOnline() {
    if (phase !== "starting" || online) {
      fail(phase === "starting" ? new StartupFailure() : new WorkerFailure());
      return;
    }
    online = true;
  }

  function onMessage(message) {
    if (dead || intentional) return;
    if (phase === "starting") {
      if (!online || !readyMessage(message)) {
        fail(new StartupFailure());
        return;
      }
      phase = "idle";
      clearTimeout(startupTimer);
      readyResolve();
      return;
    }
    if (!current) {
      fail(new WorkerFailure());
      return;
    }
    try {
      const results = resultMessage(message, current.batchId, current.files);
      const pending = current;
      current = null;
      phase = "idle";
      pending.resolve(results);
    } catch {
      fail(new WorkerFailure());
    }
  }

  function onError() {
    if (intentional) return;
    fail(phase === "starting" ? new StartupFailure() : new WorkerFailure());
  }

  function onExit() {
    if (intentional) return;
    fail(phase === "starting" ? new StartupFailure() : new WorkerFailure());
  }

  worker.on("online", onOnline);
  worker.on("message", onMessage);
  worker.on("error", onError);
  worker.on("exit", onExit);

  function dispatch(batchId, files) {
    if (dead || intentional || phase !== "idle" || current) {
      return Promise.reject(new WorkerFailure());
    }
    phase = "busy";
    return new Promise((resolve, reject) => {
      current = { batchId, files, resolve, reject };
      try {
        worker.postMessage({ type: "process-batch", batchId, files });
      } catch {
        fail(new WorkerFailure());
      }
    });
  }

  function terminate(reason = new WorkerFailure()) {
    if (terminationPromise) return terminationPromise;
    intentional = true;
    dead = true;
    rejectPending(reason);
    terminationPromise = Promise.resolve()
      .then(() => worker.terminate())
      .catch(() => undefined)
      .finally(detach);
    return terminationPromise;
  }

  return { ready, dispatch, terminate };
}

function cachedFor(file, cached) {
  if (Object.hasOwn(file, "cached")) return file.cached;
  const relativePath = canonicalRelativePath(file);
  if (typeof cached === "function") return cached(file);
  if (cached instanceof Map) return cached.get(relativePath);
  if (isPlainObject(cached)) return cached[relativePath];
  return undefined;
}

function prepareWorkerFile(file, cached) {
  const value = cachedFor(file, cached);
  return value === undefined || Object.hasOwn(file, "cached")
    ? file
    : { ...file, cached: value };
}

async function processOnMain(files, options) {
  const results = [];
  for (const file of files) {
    throwIfAborted(options.signal);
    const result = await options.mainThreadProcessor(file, {
      signal: options.signal,
      cached: cachedFor(file, options.cached),
    });
    throwIfAborted(options.signal);
    results.push(...validateResults([result], [file]));
  }
  return results;
}

async function runWorkers(plan, options) {
  const workerCount = Math.min(options.workers, plan.batches.length);
  const handles = new Set();
  const queue = plan.batches.map((batch, index) => ({
    id: batch.id,
    protocolId: `${batch.id}:${index}`,
    files: batch.files,
    crashes: 0,
  }));
  const results = [];
  let stopped = false;
  let aborted = false;
  let startupFailed = false;
  let terminationPromise;

  const terminateAll = (reason) => {
    if (!terminationPromise) {
      terminationPromise = Promise.allSettled([...handles].map((handle) => handle.terminate(reason)));
    }
    return terminationPromise;
  };
  const onAbort = () => {
    if (stopped) return;
    stopped = true;
    aborted = true;
    queue.length = 0;
    void terminateAll(createAbortError());
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  const spawn = async () => {
    if (stopped) throw aborted ? createAbortError() : new StartupFailure();
    let handle;
    try {
      handle = createWorkerHandle(
        options.workerFactory,
        options.workerUrl,
        { workerData: options.workerData },
        options.startupTimeoutMs,
      );
    } catch {
      throw new StartupFailure();
    }
    handles.add(handle);
    try {
      await handle.ready;
      if (stopped) throw aborted ? createAbortError() : new StartupFailure();
      return handle;
    } catch (error) {
      await handle.terminate(error);
      throw error?.name === "AbortError" ? error : new StartupFailure();
    }
  };

  try {
    const startupAttempts = Array.from({ length: workerCount }, () => spawn());
    const initial = await Promise.allSettled(startupAttempts.map((attempt) => attempt.catch((error) => {
      if (!stopped && error?.name !== "AbortError") {
        stopped = true;
        queue.length = 0;
        void terminateAll(new StartupFailure());
      }
      throw error;
    })));
    if (aborted) {
      await terminateAll(createAbortError());
      throw createAbortError();
    }
    if (initial.some((outcome) => outcome.status === "rejected")) {
      stopped = true;
      queue.length = 0;
      await terminateAll(new StartupFailure());
      throw new StartupFailure();
    }

    async function workerLoop(initialHandle) {
      let handle = initialHandle;
      while (!stopped) {
        const job = queue.shift();
        if (!job) return;
        const workerFiles = job.files.map((file) => prepareWorkerFile(file, options.cached));
        try {
          const batchResults = await handle.dispatch(job.protocolId, workerFiles);
          if (stopped) return;
          results.push(...batchResults);
        } catch {
          await handle.terminate(new WorkerFailure());
          if (stopped) return;

          if (job.crashes === 0) {
            queue.unshift({ ...job, crashes: 1 });
          } else if (job.files.length > 1) {
            const midpoint = Math.ceil(job.files.length / 2);
            const left = job.files.slice(0, midpoint);
            const right = job.files.slice(midpoint);
            queue.unshift(
              {
                id: `${job.id}.1`,
                protocolId: `${job.protocolId}.1`,
                files: right,
                crashes: 0,
              },
            );
            queue.unshift(
              {
                id: `${job.id}.0`,
                protocolId: `${job.protocolId}.0`,
                files: left,
                crashes: 0,
              },
            );
          } else {
            results.push(...await processOnMain(job.files, options));
          }

          if (stopped || queue.length === 0) return;
          try {
            handle = await spawn();
          } catch (error) {
            if (error?.name === "AbortError") return;
            startupFailed = true;
            stopped = true;
            queue.length = 0;
            void terminateAll(new StartupFailure());
            return;
          }
        }
      }
    }

    await Promise.all(initial.map((outcome) => workerLoop(outcome.value)));
    if (aborted) {
      await terminateAll(createAbortError());
      throw createAbortError();
    }
    if (startupFailed) {
      await terminateAll(new StartupFailure());
      throw new StartupFailure();
    }
    stopped = true;
    await terminateAll(new WorkerFailure());
    results.push(...await processOnMain(plan.metadata, options));
    return validateResults(results, plan.allFiles);
  } finally {
    stopped = true;
    queue.length = 0;
    options.signal?.removeEventListener("abort", onAbort);
    await terminateAll(aborted ? createAbortError() : new WorkerFailure());
  }
}

export async function processFileBatches(input, options = {}) {
  throwIfAborted(options.signal);
  const plan = normalizePlan(input);
  const resolved = {
    workers: resolveWorkerCount(options.workers),
    workerUrl: options.workerUrl ?? DEFAULT_WORKER_URL,
    workerFactory: options.workerFactory ?? ((url, workerOptions) => new Worker(url, workerOptions)),
    workerData: options.workerData,
    startupTimeoutMs: positiveInteger(
      "startupTimeoutMs",
      options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
    ),
    mainThreadProcessor: options.mainThreadProcessor ?? readAndProcessFile,
    cached: options.cached,
    signal: options.signal,
  };
  if (typeof resolved.workerFactory !== "function") throw new TypeError("workerFactory must be a function");
  if (typeof resolved.mainThreadProcessor !== "function") {
    throw new TypeError("mainThreadProcessor must be a function");
  }
  if (plan.batches.length === 0) {
    return processOnMain(plan.metadata, resolved);
  }

  try {
    return await runWorkers(plan, resolved);
  } catch (error) {
    if (error?.name === "AbortError" || options.signal?.aborted) throw createAbortError();
    if (!(error instanceof StartupFailure)) throw error;
    throwIfAborted(options.signal);
    return processOnMain(plan.allFiles, resolved)
      .then((results) => validateResults(results, plan.allFiles));
  }
}

export const runWorkerPool = processFileBatches;
