import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { parseFileBuffer } from "../src/file-facts.mjs";
import { readAndProcessFile } from "../src/file-processor.mjs";

function source(relativePath, language, content, overrides = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    path: relativePath,
    absolutePath: `/private/company/legacy/${relativePath}`,
    language,
    category: language === "xml" ? "config" : "code",
    size: buffer.length,
    mtimeMs: 100,
    ...overrides,
  };
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertJsonSafe(value, forbidden = []) {
  assert.deepEqual(JSON.parse(JSON.stringify(value)), value);
  assert.deepEqual(structuredClone(value), value);
  const serialized = JSON.stringify(value);
  for (const text of forbidden) assert.equal(serialized.includes(text), false);
}

test("readAndProcessFile returns metadata facts without reading or stating the file", async () => {
  const file = source("docs/README.md", "markdown", "hello", { category: "docs" });
  let ioCalls = 0;
  let parseCalls = 0;

  const result = await readAndProcessFile(file, {
    io: {
      readFile: async () => { ioCalls += 1; throw new Error("must not read"); },
      stat: async () => { ioCalls += 1; throw new Error("must not stat"); },
    },
    parseFileBuffer: () => { parseCalls += 1; throw new Error("must not parse"); },
  });

  assert.equal(ioCalls, 0);
  assert.equal(parseCalls, 0);
  assert.deepEqual(result, {
    status: "metadata",
    relativePath: "docs/README.md",
    parserKind: "metadata",
    fingerprint: null,
    metadata: { size: 5, mtimeMs: 100 },
    record: {
      factSchema: "1.0.0",
      relativePath: "docs/README.md",
      language: "markdown",
      category: "docs",
      size: 5,
      parserKind: "metadata",
      parserVersion: "1.0.0",
      status: "metadata",
      facts: {},
      warnings: [],
      diagnostics: [],
    },
    reused: false,
    diagnostics: [],
  });
});

test("a stable parsed source is read exactly once and hashes and parses the same Buffer", async () => {
  const buffer = Buffer.from("package demo; public class App {}\n");
  const file = source("src/demo/App.java", "java", buffer);
  const reads = [];
  const stats = [];
  let parsedBuffer;
  let decoded;
  let parseCalls = 0;

  const result = await readAndProcessFile(file, {
    io: {
      readFile: async (...args) => { reads.push(args); return buffer; },
      stat: async (...args) => { stats.push(args); return { size: buffer.length, mtimeMs: 100 }; },
    },
    parseFileBuffer(fileArg, bufferArg) {
      parseCalls += 1;
      parsedBuffer = bufferArg;
      return parseFileBuffer(fileArg, bufferArg, {
        parsers: { java: (content) => { decoded = content; return { content }; } },
      });
    },
  });

  assert.deepEqual(reads, [[file.absolutePath]]);
  assert.deepEqual(stats, [[file.absolutePath]]);
  assert.equal(parseCalls, 1);
  assert.equal(parsedBuffer, buffer);
  assert.equal(decoded, buffer.toString("utf8"));
  assert.equal(result.status, "parsed");
  assert.equal(result.fingerprint, sha256(buffer));
  assert.deepEqual(result.metadata, { size: buffer.length, mtimeMs: 100 });
  assert.equal(result.record.facts.content, decoded);
  assert.equal(result.reused, false);
  assert.deepEqual(result.diagnostics, []);
  assertJsonSafe(result, [file.absolutePath]);
});

test("NUL detection and fingerprinting use the single full-read Buffer", async () => {
  const buffer = Buffer.from([0x63, 0x6c, 0x61, 0x73, 0x73, 0x00, 0x41]);
  const file = source("src/Binary.java", "java", buffer);
  let reads = 0;

  const result = await readAndProcessFile(file, {
    io: {
      readFile: async () => { reads += 1; return buffer; },
      stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
    },
  });

  assert.equal(reads, 1);
  assert.equal(result.status, "binary");
  assert.equal(result.fingerprint, sha256(buffer));
  assert.equal(result.record.status, "binary");
});

test("one metadata mismatch retries one full read and parses only the stable second Buffer", async () => {
  const oldBuffer = Buffer.from("old");
  const newBuffer = Buffer.from("new source");
  const file = source("src/Changing.java", "java", oldBuffer, { mtimeMs: 1 });
  const buffers = [oldBuffer, newBuffer];
  const metadata = [
    { size: newBuffer.length, mtimeMs: 2 },
    { size: newBuffer.length, mtimeMs: 2 },
  ];
  let reads = 0;
  let stats = 0;
  let parseCalls = 0;
  let parsedBuffer;

  const result = await readAndProcessFile(file, {
    io: {
      readFile: async () => buffers[reads++],
      stat: async () => metadata[stats++],
    },
    parseFileBuffer(fileArg, bufferArg) {
      parseCalls += 1;
      parsedBuffer = bufferArg;
      return parseFileBuffer(fileArg, bufferArg, { parsers: { java: () => ({ stable: true }) } });
    },
  });

  assert.equal(reads, 2);
  assert.equal(stats, 2);
  assert.equal(parseCalls, 1);
  assert.equal(parsedBuffer, newBuffer);
  assert.equal(result.fingerprint, sha256(newBuffer));
  assert.deepEqual(result.metadata, metadata[1]);
  assert.equal(result.record.size, newBuffer.length);
});

test("a second metadata mismatch returns deterministic unstable output without parsing facts", async () => {
  const first = Buffer.from("first");
  const second = Buffer.from("second version");
  const file = source("src/Changing.java", "java", first, { mtimeMs: 1 });
  let reads = 0;
  let stats = 0;
  let parseCalls = 0;
  const metadata = [
    { size: second.length, mtimeMs: 2 },
    { size: second.length + 1, mtimeMs: 3 },
  ];

  const result = await readAndProcessFile(file, {
    io: {
      readFile: async () => [first, second][reads++],
      stat: async () => metadata[stats++],
    },
    parseFileBuffer: () => { parseCalls += 1; throw new Error("must not parse"); },
  });

  assert.equal(reads, 2);
  assert.equal(stats, 2);
  assert.equal(parseCalls, 0);
  assert.deepEqual(result, {
    status: "unstable",
    relativePath: "src/Changing.java",
    parserKind: "java",
    fingerprint: null,
    metadata: metadata[1],
    record: null,
    reused: false,
    diagnostics: [{
      code: "unstable-file",
      relativePath: "src/Changing.java",
      message: "File metadata or byte length changed during both read attempts",
    }],
  });
  assertJsonSafe(result, [file.absolutePath]);
});

test("a matching cached fingerprint reuses facts without parsing and refreshes metadata", async () => {
  const buffer = Buffer.from("package demo; public class Cached {}\n");
  const file = source("src/demo/Cached.java", "java", buffer, { mtimeMs: 200 });
  const cachedRecord = parseFileBuffer(
    { ...file, size: 1 },
    buffer,
    { parsers: { java: () => ({ cached: true }) } },
  );
  let parseCalls = 0;

  const result = await readAndProcessFile(file, {
    cached: { fingerprint: sha256(buffer), record: cachedRecord },
    io: {
      readFile: async () => buffer,
      stat: async () => ({ size: buffer.length, mtimeMs: 200 }),
    },
    parseFileBuffer: () => { parseCalls += 1; throw new Error("must not parse"); },
  });

  assert.equal(parseCalls, 0);
  assert.equal(result.status, "parsed");
  assert.equal(result.reused, true);
  assert.notEqual(result.record, cachedRecord);
  assert.notEqual(result.record.facts, cachedRecord.facts);
  result.record.facts.cached = false;
  assert.equal(cachedRecord.facts.cached, true);
  assert.equal(result.record.size, buffer.length);
  assert.equal(cachedRecord.size, 1);
  assert.deepEqual(result.metadata, { size: buffer.length, mtimeMs: 200 });
});

test("cache reuse requires matching fact schema, parser contract, relative path, and legal status", async () => {
  const buffer = Buffer.from("class Current {}");
  const file = source("src/Current.java", "java", buffer);
  const valid = parseFileBuffer(
    file,
    buffer,
    { parsers: { java: () => ({ cached: true }) } },
  );
  const invalidRecords = [
    { ...valid, factSchema: "0.0.0" },
    { ...valid, parserKind: "xml" },
    { ...valid, parserVersion: "0.0.0" },
    { ...valid, relativePath: "src/Other.java" },
    { ...valid, status: "metadata" },
    { ...valid, status: "unknown" },
  ];
  let parseCalls = 0;

  for (const record of invalidRecords) {
    const result = await readAndProcessFile(file, {
      cached: { fingerprint: sha256(buffer), record },
      io: {
        readFile: async () => buffer,
        stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
      },
      parseFileBuffer(fileArg, bufferArg) {
        parseCalls += 1;
        return parseFileBuffer(fileArg, bufferArg, {
          parsers: { java: () => ({ fresh: true }) },
        });
      },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(result.record.facts, { fresh: true });
  }

  assert.equal(parseCalls, invalidRecords.length);
});

test("cache reuse rejects missing or mistyped common fact-record fields", async () => {
  const buffer = Buffer.from("class Current {}");
  const file = source("src/Current.java", "java", buffer);
  const valid = parseFileBuffer(
    file,
    buffer,
    { parsers: { java: () => ({ cached: true }) } },
  );
  const without = (key) => Object.fromEntries(
    Object.entries(valid).filter(([candidate]) => candidate !== key),
  );
  const invalidRecords = [
    without("language"),
    { ...valid, language: 1 },
    without("category"),
    { ...valid, category: null },
    without("size"),
    { ...valid, size: "17" },
    { ...valid, size: -1 },
    { ...valid, size: 1.5 },
    without("warnings"),
    { ...valid, warnings: {} },
    without("diagnostics"),
    { ...valid, diagnostics: {} },
  ];
  let parseCalls = 0;

  for (const record of invalidRecords) {
    const result = await readAndProcessFile(file, {
      cached: { fingerprint: sha256(buffer), record },
      io: {
        readFile: async () => buffer,
        stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
      },
      parseFileBuffer(fileArg, bufferArg) {
        parseCalls += 1;
        return parseFileBuffer(fileArg, bufferArg, {
          parsers: { java: () => ({ fresh: true }) },
        });
      },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(result.record.facts, { fresh: true });
  }

  assert.equal(parseCalls, invalidRecords.length);
});

test("cache reuse rejects malformed parsed, binary, and error status payloads", async () => {
  const buffer = Buffer.from("class Current {}");
  const file = source("src/Current.java", "java", buffer);
  const parsed = parseFileBuffer(
    file,
    buffer,
    { parsers: { java: () => ({ cached: true }) } },
  );
  const binary = parseFileBuffer(file, Buffer.from([0x00]));
  const failed = parseFileBuffer(file, buffer, {
    parsers: { java: () => { throw new Error("broken parser"); } },
  });
  const without = (record, key) => Object.fromEntries(
    Object.entries(record).filter(([candidate]) => candidate !== key),
  );
  const invalidRecords = [
    without(parsed, "facts"),
    { ...parsed, facts: null },
    { ...parsed, facts: "not-an-object" },
    without(binary, "facts"),
    { ...binary, facts: {} },
    without(failed, "facts"),
    { ...failed, facts: {} },
    without(failed, "error"),
    { ...failed, error: [] },
    { ...failed, error: { message: "missing name" } },
    { ...failed, error: { name: 1, message: "bad name" } },
    { ...failed, error: { name: "Error" } },
    { ...failed, error: { name: "Error", message: 1 } },
    { ...failed, error: { name: "Error", message: "bad code", code: 500 } },
  ];
  let parseCalls = 0;

  for (const record of invalidRecords) {
    const result = await readAndProcessFile(file, {
      cached: { fingerprint: sha256(buffer), record },
      io: {
        readFile: async () => buffer,
        stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
      },
      parseFileBuffer(fileArg, bufferArg) {
        parseCalls += 1;
        return parseFileBuffer(fileArg, bufferArg, {
          parsers: { java: () => ({ fresh: true }) },
        });
      },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(result.record.facts, { fresh: true });
  }

  assert.equal(parseCalls, invalidRecords.length);
});

test("well-formed binary and error cache records remain reusable", async () => {
  const file = source("src/Current.java", "java", "class Current {}");
  const cases = [
    {
      buffer: Buffer.from([0x00]),
      record: parseFileBuffer(
        { ...file, size: 1 },
        Buffer.from([0x00]),
      ),
      status: "binary",
    },
    {
      buffer: Buffer.from("class Current {}"),
      record: parseFileBuffer(file, Buffer.from("class Current {}"), {
        parsers: { java: () => { throw new Error("broken parser"); } },
      }),
      status: "error",
    },
  ];

  for (const item of cases) {
    const currentFile = { ...file, size: item.buffer.length };
    const result = await readAndProcessFile(currentFile, {
      cached: { fingerprint: sha256(item.buffer), record: item.record },
      io: {
        readFile: async () => item.buffer,
        stat: async () => ({ size: item.buffer.length, mtimeMs: 100 }),
      },
      parseFileBuffer: () => { throw new Error("must reuse cache"); },
    });
    assert.equal(result.reused, true);
    assert.equal(result.status, item.status);
  }
});

test("non-JSON, cyclic, accessor, and Proxy cache records are misses instead of failures", async () => {
  const buffer = Buffer.from("class Current {}");
  const file = source("src/Current.java", "java", buffer);
  const valid = parseFileBuffer(
    file,
    buffer,
    { parsers: { java: () => ({ cached: true }) } },
  );
  const cyclic = { ...valid, facts: { cached: true } };
  cyclic.facts.self = cyclic.facts;
  const accessorFacts = {};
  Object.defineProperty(accessorFacts, "value", {
    enumerable: true,
    get() { throw new Error("cache accessor must not run"); },
  });
  const invalidRecords = [
    { ...valid, facts: { value: 1n } },
    { ...valid, facts: new Map([["cached", true]]) },
    cyclic,
    { ...valid, facts: accessorFacts },
    { ...valid, facts: new Proxy({ cached: true }, {
      ownKeys() { throw new Error("cache Proxy must not be inspected"); },
    }) },
  ];
  const accessorCache = { fingerprint: sha256(buffer) };
  Object.defineProperty(accessorCache, "record", {
    enumerable: true,
    get() { throw new Error("cache record accessor must not run"); },
  });
  const invalidCaches = [
    ...invalidRecords.map((record) => ({ fingerprint: sha256(buffer), record })),
    accessorCache,
    new Proxy({ fingerprint: sha256(buffer), record: valid }, {
      get() { throw new Error("cache container Proxy must not be inspected"); },
    }),
  ];
  let parseCalls = 0;

  for (const cached of invalidCaches) {
    const result = await readAndProcessFile(file, {
      cached,
      io: {
        readFile: async () => buffer,
        stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
      },
      parseFileBuffer(fileArg, bufferArg) {
        parseCalls += 1;
        return parseFileBuffer(fileArg, bufferArg, {
          parsers: { java: () => ({ fresh: true }) },
        });
      },
    });
    assert.equal(result.reused, false);
    assert.deepEqual(result.record.facts, { fresh: true });
  }

  assert.equal(parseCalls, invalidCaches.length);
});

test("a changed fingerprint parses exactly once instead of reusing cached facts", async () => {
  const buffer = Buffer.from("changed");
  const file = source("src/Changed.java", "java", buffer);
  let parseCalls = 0;

  const result = await readAndProcessFile(file, {
    cached: { fingerprint: "0".repeat(64), record: { status: "parsed", facts: { stale: true } } },
    io: {
      readFile: async () => buffer,
      stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
    },
    parseFileBuffer(fileArg, bufferArg) {
      parseCalls += 1;
      return parseFileBuffer(fileArg, bufferArg, { parsers: { java: () => ({ fresh: true }) } });
    },
  });

  assert.equal(parseCalls, 1);
  assert.equal(result.reused, false);
  assert.deepEqual(result.record.facts, { fresh: true });
});

test("parser failures remain isolated per-file records", async () => {
  const buffer = Buffer.from("broken");
  const file = source("src/Broken.java", "java", buffer);
  const result = await readAndProcessFile(file, {
    io: {
      readFile: async () => buffer,
      stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
    },
    parsers: {
      java: () => { throw new Error(`bad declaration in ${file.absolutePath}`); },
    },
  });

  assert.equal(result.status, "error");
  assert.equal(result.record.status, "error");
  assert.equal(result.diagnostics[0].code, "parser-error");
  assertJsonSafe(result, [file.absolutePath]);
});

test("read and stat I/O failures become deterministic operational results without absolute paths", async () => {
  const buffer = Buffer.from("class App {}");
  const file = source("src/App.java", "java", buffer);
  const readError = Object.assign(new Error(`missing ${file.absolutePath}`), { code: "ENOENT" });
  let parses = 0;

  const failedRead = await readAndProcessFile(file, {
    io: {
      readFile: async () => { throw readError; },
      stat: async () => { throw new Error("must not stat"); },
    },
    parseFileBuffer: () => { parses += 1; },
  });
  const failedStat = await readAndProcessFile(file, {
    io: {
      readFile: async () => buffer,
      stat: async () => { throw Object.assign(new Error("blocked"), { code: "EACCES" }); },
    },
    parseFileBuffer: () => { parses += 1; },
  });

  assert.deepEqual(failedRead, {
    status: "operational-error",
    relativePath: "src/App.java",
    parserKind: "java",
    fingerprint: null,
    metadata: { size: buffer.length, mtimeMs: 100 },
    record: null,
    reused: false,
    diagnostics: [{
      code: "file-read-error",
      relativePath: "src/App.java",
      operation: "read",
      errorCode: "ENOENT",
      message: "Unable to read source file",
    }],
  });
  assert.equal(failedStat.status, "operational-error");
  assert.equal(failedStat.diagnostics[0].code, "file-stat-error");
  assert.equal(failedStat.diagnostics[0].errorCode, "EACCES");
  assert.equal(failedStat.fingerprint, null);
  assert.equal(parses, 0);
  assertJsonSafe(failedRead, [file.absolutePath]);
  assertJsonSafe(failedStat, [file.absolutePath]);
});

test("hostile read and stat rejections become operational results without inspecting getters", async () => {
  const buffer = Buffer.from("class App {}");
  const file = source("src/App.java", "java", buffer);
  const hostileRead = new Proxy({}, {
    get() { throw new Error("read rejection getter must not escape"); },
  });
  const hostileStat = {};
  Object.defineProperties(hostileStat, {
    name: { get() { throw new Error("stat name getter must not escape"); } },
    code: { get() { throw new Error("stat code getter must not escape"); } },
  });

  const failedRead = await readAndProcessFile(file, {
    io: {
      readFile: async () => { throw hostileRead; },
      stat: async () => { throw new Error("must not stat"); },
    },
  });
  const failedStat = await readAndProcessFile(file, {
    io: {
      readFile: async () => buffer,
      stat: async () => { throw hostileStat; },
    },
  });

  assert.equal(failedRead.status, "operational-error");
  assert.deepEqual(failedRead.diagnostics, [{
    code: "file-read-error",
    relativePath: "src/App.java",
    operation: "read",
    message: "Unable to read source file",
  }]);
  assert.equal(failedStat.status, "operational-error");
  assert.deepEqual(failedStat.diagnostics, [{
    code: "file-stat-error",
    relativePath: "src/App.java",
    operation: "stat",
    message: "Unable to read source file metadata",
  }]);
});

test("one hostile error field cannot hide a valid abort marker in the other field", async () => {
  const buffer = Buffer.from("class App {}");
  const file = source("src/App.java", "java", buffer);
  const abortByName = { name: "AbortError" };
  Object.defineProperty(abortByName, "code", {
    get() { throw new Error("code getter must not hide abort name"); },
  });
  const abortByCode = { code: "ABORT_ERR" };
  Object.defineProperty(abortByCode, "name", {
    get() { throw new Error("name getter must not hide abort code"); },
  });

  for (const abortError of [abortByName, abortByCode]) {
    await assert.rejects(
      readAndProcessFile(file, {
        io: {
          readFile: async () => { throw abortError; },
          stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
        },
      }),
      (error) => error === abortError,
    );
  }
});

test("AbortSignal stops before I/O and interrupts an in-flight read without stat, retry, or parse", async () => {
  const buffer = Buffer.from("class App {}");
  const file = source("src/App.java", "java", buffer);
  const pre = new AbortController();
  pre.abort();
  let calls = 0;

  await assert.rejects(
    readAndProcessFile(file, {
      signal: pre.signal,
      io: {
        readFile: async () => { calls += 1; return buffer; },
        stat: async () => { calls += 1; return { size: buffer.length, mtimeMs: 100 }; },
      },
    }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
  assert.equal(calls, 0);

  const mid = new AbortController();
  let releaseRead;
  const pendingRead = new Promise((resolve) => { releaseRead = resolve; });
  let reads = 0;
  let stats = 0;
  let parses = 0;
  const outcome = readAndProcessFile(file, {
    signal: mid.signal,
    io: {
      readFile: async () => { reads += 1; return pendingRead; },
      stat: async () => { stats += 1; return { size: buffer.length, mtimeMs: 100 }; },
    },
    parseFileBuffer: () => { parses += 1; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  mid.abort();
  await assert.rejects(outcome, { name: "AbortError", code: "ABORT_ERR" });
  releaseRead(buffer);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reads, 1);
  assert.equal(stats, 0);
  assert.equal(parses, 0);
});

test("readAndProcessFile passes its AbortSignal to readFile while retaining abort racing", async () => {
  const buffer = Buffer.from("class App {}");
  const file = source("src/App.java", "java", buffer);
  const controller = new AbortController();
  let readOptions;

  await readAndProcessFile(file, {
    signal: controller.signal,
    io: {
      readFile: async (_absolutePath, options) => { readOptions = options; return buffer; },
      stat: async () => ({ size: buffer.length, mtimeMs: 100 }),
    },
    parseFileBuffer(fileArg, bufferArg) {
      return parseFileBuffer(fileArg, bufferArg, { parsers: { java: () => ({}) } });
    },
  });

  assert.deepEqual(readOptions, { signal: controller.signal });
});

test("same coarse metadata still retries when the first Buffer length is truncated", async () => {
  const complete = Buffer.from("class Complete {}");
  const truncated = complete.subarray(0, complete.length - 2);
  const file = source("src/Complete.java", "java", complete);
  const buffers = [truncated, complete];
  let reads = 0;
  let stats = 0;
  let parses = 0;
  let parsedBuffer;

  const result = await readAndProcessFile(file, {
    io: {
      readFile: async () => buffers[reads++],
      stat: async () => { stats += 1; return { size: complete.length, mtimeMs: 100 }; },
    },
    parseFileBuffer(fileArg, bufferArg) {
      parses += 1;
      parsedBuffer = bufferArg;
      return parseFileBuffer(fileArg, bufferArg, { parsers: { java: () => ({ complete: true }) } });
    },
  });

  assert.equal(reads, 2);
  assert.equal(stats, 2);
  assert.equal(parses, 1);
  assert.equal(parsedBuffer, complete);
  assert.equal(result.fingerprint, sha256(complete));
});

test("readAndProcessFile rejects NUL paths and does not coerce size or mtime metadata", async () => {
  const buffer = Buffer.from("class App {}");
  const noIo = {
    readFile: async () => { throw new Error("must not read"); },
    stat: async () => { throw new Error("must not stat"); },
  };

  await assert.rejects(
    readAndProcessFile(source("src/NUL\0.java", "java", buffer), { io: noIo }),
    /relative path/i,
  );
  for (const size of [String(buffer.length), 1.5, -1, Number.MAX_SAFE_INTEGER + 1, 1n]) {
    await assert.rejects(
      readAndProcessFile(source("src/App.java", "java", buffer, { size }), { io: noIo }),
      /size must be a non-negative safe integer/i,
    );
  }
  for (const mtimeMs of ["100", Number.NaN, Number.POSITIVE_INFINITY, 1n]) {
    await assert.rejects(
      readAndProcessFile(source("src/App.java", "java", buffer, { mtimeMs }), { io: noIo }),
      /mtimeMs must be a finite number/i,
    );
  }
});
