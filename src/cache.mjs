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
    const record = cloneJson(entry.record);
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
