import { createHash } from "node:crypto";
import path from "node:path";

import { parserKindFor } from "./file-facts.mjs";

export const DEFAULT_BATCH_TARGET_BYTES = 8 * 1024 * 1024;
export const DEFAULT_BATCH_MAX_FILES = 128;

function positiveSafeInteger(name, value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

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

function fileSize(file) {
  const size = file?.size;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
    throw new TypeError(`file size must be a non-negative safe integer: ${relativePathFor(file)}`);
  }
  return size;
}

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareEntries(left, right) {
  return right.size - left.size
    || compareText(left.relativePath, right.relativePath);
}

function batchId(parserKind, entries) {
  const descriptor = {
    version: 1,
    parserKind,
    files: entries.map((entry) => ({
      relativePath: entry.relativePath,
      size: entry.size,
    })),
  };
  return createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
}

function createBatch(parserKind, entries, totalBytes) {
  return {
    id: batchId(parserKind, entries),
    parserKind,
    totalBytes,
    files: entries.map((entry) => entry.file),
  };
}

export function createFileBatches(files, options = {}) {
  if (!Array.isArray(files)) throw new TypeError("files must be an array");
  const targetBytes = positiveSafeInteger(
    "targetBytes",
    options.targetBytes ?? DEFAULT_BATCH_TARGET_BYTES,
  );
  const maxFiles = positiveSafeInteger(
    "maxFiles",
    options.maxFiles ?? DEFAULT_BATCH_MAX_FILES,
  );

  const entries = [];
  for (const file of files) {
    const parserKind = parserKindFor(file);
    if (parserKind) {
      entries.push({
        file,
        parserKind,
        relativePath: relativePathFor(file),
        size: fileSize(file),
      });
    }
  }
  entries.sort((left, right) => compareText(left.relativePath, right.relativePath));
  for (let index = 1; index < entries.length; index += 1) {
    if (entries[index - 1].relativePath === entries[index].relativePath) {
      throw new TypeError(`duplicate canonical relative path: ${entries[index].relativePath}`);
    }
  }

  const groups = new Map();
  const metadata = [];
  for (const entry of entries) {
    if (entry.parserKind === "metadata") {
      metadata.push(entry);
    } else {
      const { parserKind } = entry;
      const group = groups.get(parserKind) ?? [];
      group.push(entry);
      groups.set(parserKind, group);
    }
  }

  const batches = [];
  for (const parserKind of [...groups.keys()].sort(compareText)) {
    const ordered = groups.get(parserKind).sort(compareEntries);
    let current = [];
    let currentBytes = 0;

    const flush = () => {
      if (current.length === 0) return;
      batches.push(createBatch(parserKind, current, currentBytes));
      current = [];
      currentBytes = 0;
    };

    for (const entry of ordered) {
      const size = entry.size;
      if (current.length > 0
        && (current.length >= maxFiles || currentBytes + size > targetBytes)) {
        flush();
      }
      current.push(entry);
      currentBytes += size;
      if (!Number.isSafeInteger(currentBytes)) {
        throw new TypeError("batch totalBytes must be a safe integer");
      }
    }
    flush();
  }

  return { batches, metadata: metadata.map((entry) => entry.file) };
}
