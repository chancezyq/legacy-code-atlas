import { readFile } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write.mjs";

export const CACHE_SCHEMA = "legacy-code-atlas/cache/1";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const REUSABLE_STATUSES = new Set(["parsed", "binary", "error"]);

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function isCanonicalRelativePath(value) {
  if (typeof value !== "string"
    || !value
    || value.includes("\0")
    || value.includes("\\")
    || value.startsWith("/")
    || /^[A-Za-z]:/.test(value)) return false;
  const normalized = path.posix.normalize(value).replace(/^\.\//, "");
  return normalized === value
    && normalized !== "."
    && normalized !== ".."
    && !normalized.startsWith("../");
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return null;
  }
}

// A value passes only when serializing it directly is observably identical to
// serializing its cloneJson copy: plain data, no accessors, no toJSON hooks,
// no symbol keys, no cycles. Anything doubtful falls back to cloneJson.
function safeForDirectSerialization(value, ancestors) {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "boolean" || type === "number") return true;
  if (type !== "object") return false;
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype) return false;
  if (ancestors.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  ancestors.add(value);
  try {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (isArray && key === "length") continue;
      if (key === "toJSON") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      if (!safeForDirectSerialization(descriptor.value, ancestors)) return false;
    }
  } finally {
    ancestors.delete(value);
  }
  return true;
}

function reusableRecordCopy(record) {
  if (safeForDirectSerialization(record, new Set())) return record;
  return cloneJson(record);
}

function validEntry(relativePath, entry) {
  return isCanonicalRelativePath(relativePath)
    && isPlainObject(entry)
    && typeof entry.fingerprint === "string"
    && FINGERPRINT.test(entry.fingerprint)
    && isPlainObject(entry.record)
    && entry.record.relativePath === relativePath;
}

function entriesFrom(value) {
  if (value instanceof Map) return [...value.entries()];
  if (!isPlainObject(value)) return [];
  return Object.entries(value);
}

function normalizedEntries(value) {
  const entries = new Map();
  const candidates = entriesFrom(value)
    .filter(([relativePath]) => typeof relativePath === "string")
    .sort(([left], [right]) => left.localeCompare(right, "en"));
  for (const [relativePath, entry] of candidates) {
    if (!validEntry(relativePath, entry)) continue;
    const record = reusableRecordCopy(entry.record);
    if (record === null) continue;
    entries.set(relativePath, {
      fingerprint: entry.fingerprint,
      record,
    });
  }
  return entries;
}

export function cacheEntriesFromResults(results) {
  const entries = new Map();
  for (const result of results ?? []) {
    if (!REUSABLE_STATUSES.has(result?.status)
      || !validEntry(result.relativePath, { fingerprint: result.fingerprint, record: result.record })) continue;
    entries.set(result.relativePath, {
      fingerprint: result.fingerprint,
      record: result.record,
    });
  }
  return new Map([...entries.entries()]
    .filter(([relativePath]) => typeof relativePath === "string")
    .sort(([left], [right]) => left.localeCompare(right, "en")));
}

export async function loadFileCache(filePath, { io = { readFile } } = {}) {
  let parsed;
  try {
    parsed = JSON.parse(await io.readFile(filePath, "utf8"));
  } catch {
    return new Map();
  }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== CACHE_SCHEMA) return new Map();
  return normalizedEntries(parsed.entries);
}

export async function saveFileCache(filePath, entries, options = {}) {
  const normalized = normalizedEntries(entries);
  const serializable = Object.fromEntries(normalized);
  const payload = `${JSON.stringify({ schemaVersion: CACHE_SCHEMA, entries: serializable }, null, 2)}\n`;
  await writeFileAtomic(filePath, payload, options);
}
