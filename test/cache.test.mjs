import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CACHE_SCHEMA,
  cacheEntriesFromResults,
  loadFileCache,
  saveFileCache,
} from "../src/cache.mjs";

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const record = {
  factSchema: "legacy-code-atlas/1",
  relativePath: "src/Order.java",
  language: "java",
  category: "code",
  size: 12,
  parserKind: "java",
  parserVersion: "1",
  status: "parsed",
  facts: { types: [] },
  warnings: [],
  diagnostics: [],
};

function recordFor(relativePath, status = "parsed") {
  return { ...record, relativePath, status, facts: status === "binary" ? null : record.facts };
}

test("file cache saves deterministic entries and loads them as a Map", async (t) => {
  const root = await temporaryDirectory(t);
  const cachePath = path.join(root, ".legacy-code-atlas", "cache.json");
  const entries = new Map([
    ["src/Z.java", { fingerprint: "b".repeat(64), record: recordFor("src/Z.java") }],
    ["src/A.java", { fingerprint: "a".repeat(64), record: recordFor("src/A.java") }],
  ]);

  await saveFileCache(cachePath, entries);
  const loaded = await loadFileCache(cachePath);

  assert.equal(loaded instanceof Map, true);
  assert.deepEqual([...loaded.keys()], ["src/A.java", "src/Z.java"]);
  const json = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(json.schemaVersion, CACHE_SCHEMA);
  assert.deepEqual(Object.keys(json.entries), ["src/A.java", "src/Z.java"]);
});

test("file cache treats missing or malformed files as an empty cache", async (t) => {
  const root = await temporaryDirectory(t);
  const missing = await loadFileCache(path.join(root, "missing.json"));
  assert.equal(missing.size, 0);

  const malformedPath = path.join(root, "malformed.json");
  await saveFileCache(malformedPath, new Map([["src/A.java", { fingerprint: "a".repeat(64), record: recordFor("src/A.java") }]]));
  const malformed = JSON.parse(await readFile(malformedPath, "utf8"));
  malformed.entries["bad\\path.java"] = malformed.entries["src/A.java"];
  malformed.entries["src/Bad.java"] = { fingerprint: "not-a-fingerprint", record };
  await import("node:fs/promises").then(({ writeFile }) => writeFile(malformedPath, JSON.stringify(malformed)));

  const loaded = await loadFileCache(malformedPath);
  assert.deepEqual([...loaded.keys()], ["src/A.java"]);
});

test("cache entries include only reusable file results", () => {
  const entries = cacheEntriesFromResults([
    {
      status: "parsed",
      relativePath: "src/A.java",
      fingerprint: "a".repeat(64),
      record: recordFor("src/A.java"),
    },
    {
      status: "binary",
      relativePath: "assets/logo.png",
      fingerprint: "b".repeat(64),
      record: recordFor("assets/logo.png", "binary"),
    },
    { status: "unstable", relativePath: "src/C.java", fingerprint: null, record: null },
    { status: "metadata", relativePath: "src/Pom.xml", fingerprint: null, record: null },
  ]);

  assert.deepEqual([...entries.keys()], ["assets/logo.png", "src/A.java"]);
});

test("file cache ignores non-string Map keys instead of throwing", async (t) => {
  const root = await temporaryDirectory(t);
  const cachePath = path.join(root, "cache.json");
  const entries = new Map([
    [41, { fingerprint: "b".repeat(64), record: recordFor("src/Bad.java") }],
    [42, { fingerprint: "c".repeat(64), record: recordFor("src/Other.java") }],
    ["src/A.java", { fingerprint: "a".repeat(64), record: recordFor("src/A.java") }],
  ]);

  await saveFileCache(cachePath, entries);

  assert.deepEqual([...await loadFileCache(cachePath).then((cache) => cache.keys())], ["src/A.java"]);
});
