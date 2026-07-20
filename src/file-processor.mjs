import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";

import { raceWithAbort, throwIfAborted } from "./concurrency.mjs";
import {
  FACT_SCHEMA,
  PARSER_VERSIONS,
  metadataFact,
  parseFileBuffer as defaultParseFileBuffer,
  parserKindFor,
} from "./file-facts.mjs";

function relativePathFor(file) {
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

function metadataSize(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("size must be a non-negative safe integer");
  }
  return Object.is(value, -0) ? 0 : value;
}

function metadataMtime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError("mtimeMs must be a finite number");
  }
  return Object.is(value, -0) ? 0 : value;
}

function metadataFrom(value) {
  return {
    size: metadataSize(value?.size),
    mtimeMs: metadataMtime(value?.mtimeMs),
  };
}

function sameMetadata(left, right) {
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function errorPropertyEquals(error, property, expected) {
  try {
    return error?.[property] === expected;
  } catch {
    return false;
  }
}

function isAbortError(error) {
  return errorPropertyEquals(error, "name", "AbortError")
    || errorPropertyEquals(error, "code", "ABORT_ERR");
}

async function abortableIo(callback, signal) {
  throwIfAborted(signal);
  const operation = Promise.resolve().then(() => {
    throwIfAborted(signal);
    return callback();
  });
  const result = await raceWithAbort(operation, signal);
  throwIfAborted(signal);
  return result;
}

function errorCode(error) {
  let code;
  try {
    code = error?.code;
  } catch {
    return undefined;
  }
  if (!["string", "number"].includes(typeof code)) return undefined;
  const normalized = String(code);
  return /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : undefined;
}

function operationalResult(relativePath, parserKind, metadata, operation, error) {
  const diagnostic = {
    code: operation === "read" ? "file-read-error" : "file-stat-error",
    relativePath,
    operation,
  };
  const code = errorCode(error);
  if (code !== undefined) diagnostic.errorCode = code;
  diagnostic.message = operation === "read"
    ? "Unable to read source file"
    : "Unable to read source file metadata";
  return {
    status: "operational-error",
    relativePath,
    parserKind,
    fingerprint: null,
    metadata,
    record: null,
    reused: false,
    diagnostics: [diagnostic],
  };
}

function resultForRecord(relativePath, parserKind, fingerprint, metadata, record, reused) {
  return {
    status: record.status,
    relativePath,
    parserKind,
    fingerprint,
    metadata,
    record,
    reused,
    diagnostics: record.diagnostics ?? [],
  };
}

function cloneJsonSafe(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new TypeError("cached record must contain JSON-safe data");
    }
    return value;
  }
  if (typeof value !== "object" || isProxy(value) || Buffer.isBuffer(value)) {
    throw new TypeError("cached record must contain JSON-safe data");
  }
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("cached record must contain JSON-safe data");
  }
  if (ancestors.has(value)) throw new TypeError("cached record must not contain cycles");
  ancestors.add(value);

  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some((key) => typeof key === "symbol")) {
        throw new TypeError("cached record must contain JSON-safe data");
      }
      const elementKeys = keys.filter((key) => key !== "length");
      if (elementKeys.length !== value.length) {
        throw new TypeError("cached record must contain dense arrays");
      }
      const clone = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new TypeError("cached record must not contain accessors");
        }
        clone.push(cloneJsonSafe(descriptor.value, ancestors));
      }
      return clone;
    }

    const clone = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === "symbol") throw new TypeError("cached record must contain JSON-safe data");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("cached record must not contain accessors");
      }
      Object.defineProperty(clone, key, {
        value: cloneJsonSafe(descriptor.value, ancestors),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function hasValidRecordSchema(record) {
  if (typeof record.language !== "string"
    || typeof record.category !== "string"
    || typeof record.size !== "number"
    || !Number.isSafeInteger(record.size)
    || record.size < 0
    || !Array.isArray(record.warnings)
    || !Array.isArray(record.diagnostics)) {
    return false;
  }

  if (record.status === "parsed") {
    return record.facts !== null && typeof record.facts === "object";
  }
  if (record.status === "binary") return record.facts === null;
  if (record.status !== "error"
    || record.facts !== null
    || !record.error
    || Array.isArray(record.error)
    || Object.getPrototypeOf(record.error) !== Object.prototype
    || typeof record.error.name !== "string"
    || typeof record.error.message !== "string") {
    return false;
  }
  return !Object.hasOwn(record.error, "code") || typeof record.error.code === "string";
}

function reusableRecord(cached, fingerprint, metadata, relativePath, parserKind) {
  let record;
  try {
    if (!cached
      || typeof cached !== "object"
      || isProxy(cached)
      || Object.getPrototypeOf(cached) !== Object.prototype) {
      return null;
    }
    const fingerprintDescriptor = Object.getOwnPropertyDescriptor(cached, "fingerprint");
    const recordDescriptor = Object.getOwnPropertyDescriptor(cached, "record");
    if (!fingerprintDescriptor
      || !("value" in fingerprintDescriptor)
      || fingerprintDescriptor.value !== fingerprint
      || !recordDescriptor
      || !("value" in recordDescriptor)) {
      return null;
    }
    record = cloneJsonSafe(recordDescriptor.value);
  } catch {
    return null;
  }
  if (!record
    || record.factSchema !== FACT_SCHEMA
    || record.parserKind !== parserKind
    || record.parserVersion !== PARSER_VERSIONS[parserKind]
    || record.relativePath !== relativePath
    || !hasValidRecordSchema(record)) {
    return null;
  }
  record.size = metadata.size;
  return record;
}

export async function readAndProcessFile(file, options = {}) {
  const signal = options.signal;
  throwIfAborted(signal);
  const parserKind = parserKindFor(file);
  if (!parserKind) throw new TypeError(`no parser for source language: ${file?.language ?? ""}`);
  const relativePath = relativePathFor(file);
  const initialMetadata = metadataFrom(file);

  if (parserKind === "metadata") {
    const record = metadataFact({
      ...file,
      path: relativePath,
      relativePath,
      size: initialMetadata.size,
    });
    return resultForRecord(relativePath, parserKind, null, initialMetadata, record, false);
  }

  const io = {
    readFile: options.io?.readFile ?? readFile,
    stat: options.io?.stat ?? stat,
  };
  const parse = options.parseFileBuffer ?? defaultParseFileBuffer;
  const readOptions = signal ? { signal } : null;
  let expectedMetadata = initialMetadata;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let buffer;
    try {
      buffer = await abortableIo(
        () => readOptions
          ? io.readFile(file.absolutePath, readOptions)
          : io.readFile(file.absolutePath),
        signal,
      );
      if (!Buffer.isBuffer(buffer)) throw new TypeError("readFile must return a Buffer");
    } catch (error) {
      if (isAbortError(error)) throw error;
      return operationalResult(relativePath, parserKind, expectedMetadata, "read", error);
    }

    let finalMetadata;
    try {
      const rawMetadata = await abortableIo(() => io.stat(file.absolutePath), signal);
      finalMetadata = metadataFrom(rawMetadata);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return operationalResult(relativePath, parserKind, expectedMetadata, "stat", error);
    }

    if (!sameMetadata(expectedMetadata, finalMetadata) || buffer.length !== finalMetadata.size) {
      if (attempt === 0) {
        expectedMetadata = finalMetadata;
        continue;
      }
      return {
        status: "unstable",
        relativePath,
        parserKind,
        fingerprint: null,
        metadata: finalMetadata,
        record: null,
        reused: false,
        diagnostics: [{
          code: "unstable-file",
          relativePath,
          message: "File metadata or byte length changed during both read attempts",
        }],
      };
    }

    throwIfAborted(signal);
    const fingerprint = createHash("sha256").update(buffer).digest("hex");
    const cachedRecord = reusableRecord(
      options.cached,
      fingerprint,
      finalMetadata,
      relativePath,
      parserKind,
    );
    if (cachedRecord) {
      return resultForRecord(
        relativePath,
        parserKind,
        fingerprint,
        finalMetadata,
        cachedRecord,
        true,
      );
    }

    throwIfAborted(signal);
    const record = parse({
      ...file,
      path: relativePath,
      relativePath,
      size: finalMetadata.size,
      mtimeMs: finalMetadata.mtimeMs,
    }, buffer, { parsers: options.parsers });
    throwIfAborted(signal);
    return resultForRecord(
      relativePath,
      parserKind,
      fingerprint,
      finalMetadata,
      record,
      false,
    );
  }

  throw new Error("unreachable file processing state");
}
