import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeProject, analyzeProjectDetailed } from "../src/analyzer.mjs";
import { FACT_SCHEMA, PARSER_VERSIONS, parserKindFor } from "../src/file-facts.mjs";
import { serializeGraph } from "../src/graph.mjs";

const projectRoot = new URL("./fixtures/legacy-shop", import.meta.url).pathname;

function edge(graph, source, type, target) {
  return graph.edges.find((candidate) => candidate.source === source && candidate.type === type && candidate.target === target);
}

function processingResult(file, status = "parsed", options = {}) {
  const parserKind = parserKindFor(file);
  const diagnostics = options.diagnostics ?? [];
  const record = ["unstable", "operational-error"].includes(status)
    ? null
    : {
        factSchema: FACT_SCHEMA,
        relativePath: file.path,
        language: file.language,
        category: file.category,
        size: file.size,
        parserKind,
        parserVersion: PARSER_VERSIONS[parserKind],
        status,
        facts: ["binary", "error"].includes(status) ? null : {},
        warnings: [],
        diagnostics,
        ...(status === "error" ? { error: { name: "Error", message: "parser failed" } } : {}),
      };
  return {
    status,
    relativePath: file.path,
    parserKind,
    fingerprint: ["metadata", "unstable", "operational-error"].includes(status)
      ? null
      : "0".repeat(64),
    metadata: { size: file.size, mtimeMs: file.mtimeMs },
    record,
    reused: options.reused ?? false,
    diagnostics,
  };
}

test("detailed analyzer composes the parallel pipeline and keeps observations outside the graph", async () => {
  const root = path.resolve("virtual-detailed-project");
  const signal = new AbortController().signal;
  const files = [
    { path: "src/A.java", absolutePath: path.join(root, "src/A.java"), language: "java", category: "code", size: 12, mtimeMs: 1 },
    { path: "src/B.java", absolutePath: path.join(root, "src/B.java"), language: "java", category: "code", size: 13, mtimeMs: 2 },
    { path: "src/C.java", absolutePath: path.join(root, "src/C.java"), language: "java", category: "code", size: 14, mtimeMs: 3 },
    { path: "src/D.java", absolutePath: path.join(root, "src/D.java"), language: "java", category: "code", size: 15, mtimeMs: 4 },
  ];
  const results = [
    processingResult(files[2], "operational-error", { diagnostics: [{ code: "file-read-error", relativePath: "src/C.java", operation: "read", errorCode: "EACCES", message: "Unable to read source file" }] }),
    processingResult(files[0], "parsed", { reused: true }),
    processingResult(files[3], "error", { diagnostics: [{ code: "parser-error", relativePath: "src/D.java", message: "parser failed" }] }),
    processingResult(files[1], "unstable", { diagnostics: [{ code: "unstable-file", relativePath: "src/B.java", message: "File changed" }] }),
  ];
  const records = [results[1].record, results[2].record];
  const plan = { batches: [{ id: "batch-a", files: files.slice(0, 2) }, { id: "batch-b", files: files.slice(2) }], metadata: [] };
  const graph = { project: { root }, nodes: [], edges: [], warnings: ["skipped parser-error: src/D.java"] };
  const calls = [];
  const clock = [0, 2, 3, 7, 10];
  const dependencies = {
    now() { return clock.shift(); },
    async scanProject(actualRoot, options) {
      calls.push(["scan", actualRoot, options]);
      return {
        root,
        files,
        skipped: [{ path: "linked.java", reason: "symbolic-link" }],
        diagnostics: [{ path: "z-locked", operation: "readdir", code: "EACCES", message: "Unable to read directory" }],
      };
    },
    createFileBatches(actualFiles, options) {
      calls.push(["batch", actualFiles, options]);
      return plan;
    },
    async processFileBatches(actualPlan, options) {
      calls.push(["process", actualPlan, options]);
      return results;
    },
    materializeRecords(input) {
      calls.push(["materialize", input]);
      return graph;
    },
  };
  const workerFactory = () => {};
  const mainThreadProcessor = async () => {};
  const workerUrl = new URL("./fixtures/workers/delayed-worker.mjs", import.meta.url);
  const cached = { "src/A.java": { fingerprint: "0".repeat(64), record: {} } };
  const cacheWriter = async (actualResults) => {
    calls.push(["cache", actualResults]);
  };

  const detailed = await analyzeProjectDetailed(root, {
    workers: 2,
    scanConcurrency: 3,
    ignore: ["generated/**"],
    maxFileBytes: 99,
    targetBytes: 100,
    maxFiles: 4,
    workerUrl,
    workerFactory,
    workerData: { mode: "test" },
    startupTimeoutMs: 123,
    mainThreadProcessor,
    cached,
    cacheWriter,
    signal,
    dependencies,
  });

  assert.deepEqual(calls.map(([name]) => name), ["scan", "batch", "process", "materialize", "cache"]);
  assert.deepEqual(calls[0].slice(1), [root, {
    workers: 2,
    scanConcurrency: 3,
    ignore: ["generated/**"],
    maxFileBytes: 99,
    signal,
  }]);
  assert.deepEqual(calls[1].slice(1), [files, { targetBytes: 100, maxFiles: 4 }]);
  assert.deepEqual(calls[2].slice(1), [plan, {
    workers: 2,
    workerUrl,
    workerFactory,
    workerData: { mode: "test" },
    startupTimeoutMs: 123,
    mainThreadProcessor,
    cached,
    signal,
  }]);
  assert.deepEqual(calls[3][1], { projectRoot: root, records, skipped: [{ path: "linked.java", reason: "symbolic-link" }] });
  assert.deepEqual(calls[4][1], results);
  assert.equal(detailed.graph, graph);
  assert.deepEqual(detailed.diagnostics, [
    { code: "unstable-file", relativePath: "src/B.java", message: "File changed" },
    { code: "file-read-error", relativePath: "src/C.java", operation: "read", errorCode: "EACCES", message: "Unable to read source file" },
    { code: "EACCES", relativePath: "z-locked", operation: "readdir", message: "Unable to read directory" },
  ]);
  assert.deepEqual(detailed.timings, {
    scanMs: 2,
    batchMs: 1,
    processMs: 4,
    materializeMs: 3,
    totalMs: 10,
  });
  assert.deepEqual(detailed.stats, {
    scanned: 4,
    skipped: 1,
    batches: 2,
    results: 4,
    records: 2,
    reused: 1,
    statuses: { error: 1, "operational-error": 1, parsed: 1, unstable: 1 },
  });
  assert.deepEqual(Object.keys(detailed), ["graph", "diagnostics", "timings", "stats"]);
  assert.equal(Object.hasOwn(graph, "diagnostics"), false);
  assert.equal(Object.hasOwn(graph, "timings"), false);
  assert.equal(Object.hasOwn(graph, "stats"), false);
  assert.equal(serializeGraph(graph).includes(root + path.sep + "src"), false);
  assert.doesNotThrow(() => structuredClone(detailed));
  assert.doesNotThrow(() => JSON.stringify(detailed));
});

test("analyzeProject remains graph-only and the detailed analyzer honors cancellation between phases", async () => {
  const root = path.resolve("virtual-cancel-project");
  const compatibilityGraph = { project: { root }, nodes: [], edges: [], warnings: [] };
  const graphOnly = await analyzeProject(root, {
    dependencies: {
      now: () => 0,
      scanProject: async () => ({ root, files: [], skipped: [], diagnostics: [] }),
      createFileBatches: () => ({ batches: [], metadata: [] }),
      processFileBatches: async () => [],
      materializeRecords: () => compatibilityGraph,
    },
  });
  assert.equal(graphOnly, compatibilityGraph);

  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    analyzeProjectDetailed(root, { signal: preAborted.signal }),
    { name: "AbortError", code: "ABORT_ERR" },
  );

  const midAbort = new AbortController();
  let materialized = false;
  await assert.rejects(
    analyzeProjectDetailed(root, {
      signal: midAbort.signal,
      dependencies: {
        now: () => 0,
        scanProject: async () => ({ root, files: [], skipped: [], diagnostics: [] }),
        createFileBatches: () => ({ batches: [], metadata: [] }),
        processFileBatches: async () => { midAbort.abort(); return []; },
        materializeRecords: () => { materialized = true; return compatibilityGraph; },
      },
    }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
  assert.equal(materialized, false);
});

test("cache write failures become diagnostics without discarding the graph", async () => {
  const root = path.resolve("virtual-cache-write-project");
  const graph = { project: { root }, nodes: [], edges: [], warnings: [] };
  const detailed = await analyzeProjectDetailed(root, {
    cacheWriter: async () => {
      const error = new Error(`disk full at ${path.join(root, ".legacy-code-atlas", "cache.json")}`);
      error.code = "ENOSPC";
      throw error;
    },
    dependencies: {
      now: () => 0,
      scanProject: async () => ({ root, files: [], skipped: [], diagnostics: [] }),
      createFileBatches: () => ({ batches: [], metadata: [] }),
      processFileBatches: async () => [],
      materializeRecords: () => graph,
    },
  });

  assert.equal(detailed.graph, graph);
  assert.deepEqual(detailed.diagnostics, [{
    code: "cache-write-error",
    relativePath: ".legacy-code-atlas/cache.json",
    operation: "cache-write",
    errorCode: "ENOSPC",
    message: "Unable to write file cache",
  }]);
  assert.equal(JSON.stringify(detailed).includes(root), true);
  assert.equal(JSON.stringify(detailed.diagnostics).includes(root), false);
});

test("detailed timings stay finite and nonnegative for every finite clock reading", async () => {
  const root = path.resolve("virtual-clock-project");
  const readings = [
    -Number.MAX_VALUE,
    Number.MAX_VALUE,
    -10,
    -20,
    -30,
  ];
  const detailed = await analyzeProjectDetailed(root, {
    dependencies: {
      now: () => readings.shift(),
      scanProject: async () => ({ root, files: [], skipped: [], diagnostics: [] }),
      createFileBatches: () => ({ batches: [], metadata: [] }),
      processFileBatches: async () => [],
      materializeRecords: () => ({ project: { root }, nodes: [], edges: [], warnings: [] }),
    },
  });

  for (const duration of Object.values(detailed.timings)) {
    assert.equal(Number.isFinite(duration), true);
    assert.equal(duration >= 0, true);
  }
  assert.doesNotThrow(() => structuredClone(detailed.timings));
  assert.equal(JSON.stringify(detailed.timings).includes("null"), false);
});

function boundaryFixture(root, overrides = {}) {
  const file = {
    path: "src/A.java",
    absolutePath: path.join(root, "src/A.java"),
    language: "java",
    category: "code",
    size: 10,
    mtimeMs: 1,
  };
  const scan = Object.hasOwn(overrides, "scan")
    ? overrides.scan
    : { root, files: [file], skipped: [], diagnostics: [] };
  const plan = Object.hasOwn(overrides, "plan")
    ? overrides.plan
    : { batches: [{ id: "batch-a", files: [file] }], metadata: [] };
  const results = Object.hasOwn(overrides, "results")
    ? overrides.results
    : [processingResult(file)];
  return {
    now: () => 0,
    scanProject: async () => scan,
    createFileBatches: () => plan,
    processFileBatches: async () => results,
    materializeRecords: overrides.materializeRecords
      ?? (() => ({ project: { root }, nodes: [], edges: [], warnings: [] })),
  };
}

test("detailed diagnostics reject machine absolute paths in every published text field", async (t) => {
  const root = "/company/legacy-project";
  const cases = [
    ["POSIX code", "code", "ERR at /Users/alice/project/src/A.java"],
    ["Windows operation", "operation", "read C:\\Users\\alice\\project\\src\\A.java"],
    ["UNC errorCode", "errorCode", "\\\\server\\share\\project\\src\\A.java"],
    ["file URL message", "message", "failure at file:///Users/alice/project/src/A.java"],
    ["known project root", "message", `failure inside ${root}`],
    ["known absolute source", "message", `failure inside ${root}/src/A.java`],
    ["arbitrary data root", "message", "failed at /data/company/private.sql"],
    ["arbitrary workspace root", "message", "failed at /workspace/company/src/A.java"],
    ["route marker cannot hide a later path", "message", "Request /Users/profile failed at /data/company/private.sql"],
  ];

  for (const [name, field, value] of cases) {
    await t.test(name, async () => {
      const diagnostic = {
        code: "ERR_SCAN_IO",
        relativePath: "src/A.java",
        operation: "read",
        errorCode: "EACCES",
        message: "Unable to read source file",
        [field]: value,
      };
      await assert.rejects(
        analyzeProjectDetailed(root, {
          dependencies: boundaryFixture(root, {
            scan: {
              root,
              files: [{
                path: "src/A.java",
                absolutePath: `${root}/src/A.java`,
                language: "java",
                category: "code",
                size: 10,
                mtimeMs: 1,
              }],
              skipped: [],
              diagnostics: [diagnostic],
            },
          }),
        }),
        (error) => error instanceof TypeError
          && /diagnostic (code|operation|errorCode|message) must not contain an absolute path/.test(error.message)
          && !error.message.includes(value),
      );
    });
  }

  const legal = {
    code: "ROUTE_/api/orders/list",
    relativePath: "src/A.java",
    operation: "GET /api/orders/list",
    errorCode: "https://errors.example.test/E_ROUTE",
    message: "Request /Users/profile failed; see https://example.test/api/orders/list",
  };
  const detailed = await analyzeProjectDetailed(root, {
    dependencies: boundaryFixture(root, {
      scan: {
        root,
        files: [],
        skipped: [],
        diagnostics: [legal],
      },
      plan: { batches: [], metadata: [] },
      results: [],
    }),
  });
  assert.deepEqual(detailed.diagnostics, [legal]);
});

test("detailed analyzer validates every injected pipeline phase before using its output", async (t) => {
  const root = path.resolve("virtual-boundary-project");
  const file = {
    path: "src/A.java",
    absolutePath: path.join(root, "src/A.java"),
    language: "java",
    category: "code",
    size: 10,
    mtimeMs: 1,
  };
  const validScan = { root, files: [file], skipped: [], diagnostics: [] };
  const validPlan = { batches: [{ id: "batch", files: [file] }], metadata: [] };
  const validResult = processingResult(file);

  const cases = [
    ["scan plain object", { scan: null }, /scanProject result must be a plain object/],
    ["scan root", { scan: { ...validScan, root: "" } }, /scanProject result\.root must be an absolute path string/],
    ["scan files", { scan: { ...validScan, files: null } }, /scanProject result\.files must be an array/],
    ["scan skipped", { scan: { ...validScan, skipped: null } }, /scanProject result\.skipped must be an array/],
    ["scan diagnostics", { scan: { ...validScan, diagnostics: null } }, /scanProject result\.diagnostics must be an array/],
    ["plan plain object", { scan: validScan, plan: null }, /createFileBatches result must be a plain object/],
    ["plan batches", { scan: validScan, plan: { ...validPlan, batches: null } }, /createFileBatches result\.batches must be an array/],
    ["plan metadata", { scan: validScan, plan: { ...validPlan, metadata: null } }, /createFileBatches result\.metadata must be an array/],
    ["results array", { scan: validScan, plan: validPlan, results: null }, /processFileBatches result must be an array/],
    ["result plain object", { scan: validScan, plan: validPlan, results: [Object.create(null)] }, /processFileBatches result\[0\] must be a plain object/],
    ["result status", { scan: validScan, plan: validPlan, results: [{ ...validResult, status: "forged" }] }, /processFileBatches result\[0\]\.status is invalid/],
    ["result path", { scan: validScan, plan: validPlan, results: [{ ...validResult, relativePath: "../A.java" }] }, /processFileBatches result\[0\]\.relativePath must be a canonical relative path/],
    ["result Windows path", { scan: validScan, plan: validPlan, results: [{ ...validResult, relativePath: "src\\A.java", record: { ...validResult.record, relativePath: "src\\A.java" } }] }, /processFileBatches result\[0\]\.relativePath must be a canonical relative path/],
    ["missing record", { scan: validScan, plan: validPlan, results: [{ ...validResult, record: undefined }] }, /processFileBatches result\[0\]\.record must be null or a plain object/],
    ["array record", { scan: validScan, plan: validPlan, results: [{ ...validResult, record: [] }] }, /processFileBatches result\[0\]\.record must be null or a plain object/],
    ["record path", { scan: validScan, plan: validPlan, results: [{ ...validResult, record: { ...validResult.record, relativePath: "src/B.java" } }] }, /processFileBatches result\[0\]\.record\.relativePath must match/],
    ["record status", { scan: validScan, plan: validPlan, results: [{ ...validResult, record: { ...validResult.record, status: "error" } }] }, /processFileBatches result\[0\]\.record\.status must match/],
    ["reused", { scan: validScan, plan: validPlan, results: [{ ...validResult, reused: "false" }] }, /processFileBatches result\[0\]\.reused must be a boolean/],
    ["diagnostics", { scan: validScan, plan: validPlan, results: [{ ...validResult, diagnostics: null }] }, /processFileBatches result\[0\]\.diagnostics must be an array/],
    ["parsed null record", { scan: validScan, plan: validPlan, results: [{ ...validResult, record: null }] }, /processFileBatches result\[0\]\.record must be non-null for parsed/],
    ["operational record", { scan: validScan, plan: validPlan, results: [{ ...validResult, status: "operational-error", record: { status: "operational-error", relativePath: "src/A.java" } }] }, /processFileBatches result\[0\]\.record must be null for operational-error/],
  ];

  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        analyzeProjectDetailed(root, { dependencies: boundaryFixture(root, overrides) }),
        (error) => error instanceof TypeError && expected.test(error.message),
      );
    });
  }
});

test("detailed analyzer enforces one exact file set across scan, plan, and results", async (t) => {
  const root = path.resolve("virtual-file-set-project");
  const file = {
    path: "src/A.java",
    absolutePath: path.join(root, "src/A.java"),
    language: "java",
    category: "code",
    size: 10,
    mtimeMs: 1,
  };
  const another = {
    ...file,
    path: "src/B.java",
    absolutePath: path.join(root, "src/B.java"),
  };
  const result = processingResult(file);
  const scan = (files) => ({ root, files, skipped: [], diagnostics: [] });
  const plan = (files) => ({ batches: files.length === 0 ? [] : [{ id: "batch", files }], metadata: [] });
  const cases = [
    ["duplicate scan path", { scan: scan([file, { ...file }]), plan: plan([file]), results: [result] }, /scanProject result\.files contains duplicate path/],
    ["noncanonical scan path", { scan: scan([{ ...file, path: "src\\A.java" }]), plan: plan([file]), results: [result] }, /scanProject result\.files\[0\]\.path must be a canonical relative path/],
    ["source outside root", { scan: scan([{ ...file, absolutePath: path.resolve(root, "../outside/A.java") }]), plan: plan([file]), results: [result] }, /scanProject result\.files\[0\]\.absolutePath must be inside scanProject result\.root/],
    ["missing language", { scan: scan([{ ...file, language: null }]), plan: plan([file]), results: [result] }, /scanProject result\.files\[0\]\.language must be a string/],
    ["missing category", { scan: scan([{ ...file, category: null }]), plan: plan([file]), results: [result] }, /scanProject result\.files\[0\]\.category must be a string/],
    ["invalid size", { scan: scan([{ ...file, size: -1 }]), plan: plan([file]), results: [result] }, /scanProject result\.files\[0\]\.size must be a non-negative safe integer/],
    ["invalid mtime", { scan: scan([{ ...file, mtimeMs: Number.NaN }]), plan: plan([file]), results: [result] }, /scanProject result\.files\[0\]\.mtimeMs must be finite/],
    ["empty plan for scanned file", { scan: scan([file]), plan: plan([]), results: [] }, /createFileBatches result paths must exactly match scanProject result\.files/],
    ["extra plan file", { scan: scan([file]), plan: plan([file, another]), results: [result] }, /createFileBatches result paths must exactly match scanProject result\.files/],
    ["duplicate plan path", { scan: scan([file]), plan: { batches: [{ id: "a", files: [file] }, { id: "b", files: [{ ...file }] }], metadata: [] }, results: [result] }, /createFileBatches result contains duplicate path/],
    ["empty batch", { scan: scan([]), plan: { batches: [{ id: "empty", files: [] }], metadata: [] }, results: [] }, /createFileBatches result\.batches\[0\] must contain an id and non-empty files array/],
    ["plan metadata changed", { scan: scan([file]), plan: plan([{ ...file, size: 11 }]), results: [result] }, /createFileBatches file metadata must match scanProject result\.files/],
    ["missing result", { scan: scan([file]), plan: plan([file]), results: [] }, /processFileBatches result paths must exactly match createFileBatches result/],
    ["extra result", { scan: scan([]), plan: plan([]), results: [result] }, /processFileBatches result paths must exactly match createFileBatches result/],
    ["duplicate result path", { scan: scan([file]), plan: plan([file]), results: [result, { ...result }] }, /processFileBatches result paths must exactly match createFileBatches result/],
  ];

  for (const [name, overrides, expected] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        analyzeProjectDetailed(root, { dependencies: boundaryFixture(root, overrides) }),
        (error) => error instanceof TypeError && expected.test(error.message),
      );
    });
  }
});

test("detailed analyzer validates skipped entries before graph materialization", async (t) => {
  const root = path.resolve("virtual-skipped-contract-project");
  const baseScan = { root, files: [], skipped: [], diagnostics: [] };
  const invalid = [
    ["POSIX absolute path", { path: "/data/secret.sql", reason: "file-too-large", size: 1 }, /scanProject result\.skipped\[0\]\.path must be a canonical relative path/],
    ["Windows absolute path", { path: "C:\\Users\\alice\\secret.sql", reason: "symbolic-link" }, /scanProject result\.skipped\[0\]\.path must be a canonical relative path/],
    ["UNC absolute path", { path: "\\\\server\\share\\secret.sql", reason: "unsupported-file-type" }, /scanProject result\.skipped\[0\]\.path must be a canonical relative path/],
    ["unknown reason", { path: "secret.sql", reason: "binary-file" }, /scanProject result\.skipped\[0\]\.reason is invalid/],
    ["missing oversized size", { path: "secret.sql", reason: "file-too-large" }, /scanProject result\.skipped\[0\]\.size must be a non-negative safe integer/],
    ["negative oversized size", { path: "secret.sql", reason: "file-too-large", size: -1 }, /scanProject result\.skipped\[0\]\.size must be a non-negative safe integer/],
    ["non-finite oversized size", { path: "secret.sql", reason: "file-too-large", size: Number.NaN }, /scanProject result\.skipped\[0\]\.size must be a non-negative safe integer/],
    ["extra symbolic-link field", { path: "secret.sql", reason: "symbolic-link", size: 1 }, /scanProject result\.skipped\[0\] has an invalid shape/],
  ];

  for (const [name, skipped, expected] of invalid) {
    await t.test(name, async () => {
      await assert.rejects(
        analyzeProjectDetailed(root, {
          dependencies: boundaryFixture(root, {
            scan: { ...baseScan, skipped: [skipped] },
            plan: { batches: [], metadata: [] },
            results: [],
          }),
        }),
        (error) => error instanceof TypeError && expected.test(error.message),
      );
    });
  }

  const legal = [
    { path: "Alias.java", reason: "symbolic-link" },
    { path: "notes.bin", reason: "unsupported-file-type" },
    { path: "Huge.java", reason: "file-too-large", size: 0 },
  ];
  let materializedSkipped;
  await analyzeProjectDetailed(root, {
    dependencies: boundaryFixture(root, {
      scan: { ...baseScan, skipped: legal },
      plan: { batches: [], metadata: [] },
      results: [],
      materializeRecords(input) {
        materializedSkipped = input.skipped;
        return { project: { root }, nodes: [], edges: [], warnings: [] };
      },
    }),
  });
  assert.deepEqual(materializedSkipped, legal);
});

test("detailed analyzer rejects records that do not satisfy the materializer contract", async (t) => {
  const root = path.resolve("virtual-record-contract-project");
  const file = {
    path: "src/A.java",
    absolutePath: path.join(root, "src/A.java"),
    language: "java",
    category: "code",
    size: 10,
    mtimeMs: 1,
  };
  const record = {
    factSchema: FACT_SCHEMA,
    relativePath: "src/A.java",
    language: "java",
    category: "code",
    size: 10,
    parserKind: "java",
    parserVersion: PARSER_VERSIONS.java,
    status: "parsed",
    facts: {},
    warnings: [],
    diagnostics: [],
  };
  const result = {
    status: "parsed",
    relativePath: "src/A.java",
    parserKind: "java",
    fingerprint: "0".repeat(64),
    metadata: { size: 10, mtimeMs: 1 },
    record,
    reused: false,
    diagnostics: [],
  };
  const scan = { root, files: [file], skipped: [], diagnostics: [] };
  const plan = { batches: [{ id: "batch", files: [file] }], metadata: [] };
  const cases = [
    ["result parserKind", { ...result, parserKind: "xml" }],
    ["record language", { ...result, record: { ...record, language: "xml" } }],
    ["record category", { ...result, record: { ...record, category: "config" } }],
    ["record size", { ...result, record: { ...record, size: 11 } }],
    ["record parserKind", { ...result, record: { ...record, parserKind: "xml" } }],
    ["record warnings", { ...result, record: { ...record, warnings: null } }],
    ["record diagnostics", { ...result, record: { ...record, diagnostics: null } }],
    ["parsed facts", { ...result, record: { ...record, facts: null } }],
    ["binary facts", (() => {
      const binary = processingResult(file, "binary");
      return { ...binary, record: { ...binary.record, facts: {} } };
    })()],
    ["error shape", (() => {
      const failed = processingResult(file, "error");
      const { error: _error, ...withoutError } = failed.record;
      return { ...failed, record: withoutError };
    })()],
  ];

  for (const [name, invalid] of cases) {
    await t.test(name, async () => {
      await assert.rejects(
        analyzeProjectDetailed(root, {
          dependencies: boundaryFixture(root, { scan, plan, results: [invalid] }),
        }),
        (error) => error instanceof TypeError
          && error.message === "processFileBatches result violates the file-result contract",
      );
    });
  }
});

test("analyzer builds an evidence-backed JSP to iBATIS table chain", async () => {
  const graph = await analyzeProject(projectRoot);

  const expectedNodes = [
    "page:web/order/audit.jsp",
    "route:/order/audit.do",
    "java_type:com.acme.order.web.OrderAuditAction",
    "java_method:com.acme.order.web.OrderAuditAction#audit/4",
    "java_method:com.acme.order.service.OrderAuditService#audit/1",
    "java_method:com.acme.order.service.impl.OrderAuditServiceImpl#audit/1",
    "java_method:com.acme.order.dao.OrderDao#updateStatus/2",
    "java_method:com.acme.order.dao.IbatisOrderDao#updateStatus/2",
    "statement:order.updateStatus",
    "table:dbo.t_order",
  ];
  for (const id of expectedNodes) assert.equal(graph.nodes.some((node) => node.id === id), true, `missing ${id}`);

  assert.ok(edge(graph, "page:web/order/audit.jsp", "submits_to", "route:/order/audit.do"));
  assert.ok(edge(graph, "route:/order/audit.do", "maps_to", "java_type:com.acme.order.web.OrderAuditAction"));
  assert.ok(edge(
    graph,
    "route:/order/audit.do",
    "dispatches_to",
    "java_method:com.acme.order.web.OrderAuditAction#audit/4",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.order.web.OrderAuditAction#audit/4",
    "calls",
    "java_method:com.acme.order.service.OrderAuditService#audit/1",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.order.service.OrderAuditService#audit/1",
    "implemented_by",
    "java_method:com.acme.order.service.impl.OrderAuditServiceImpl#audit/1",
  ));
  assert.ok(edge(
    graph,
    "java_method:com.acme.order.dao.IbatisOrderDao#updateStatus/2",
    "uses_statement",
    "statement:order.updateStatus",
  ));
  const tableEdge = edge(graph, "statement:order.updateStatus", "writes_to", "table:dbo.t_order");
  assert.ok(tableEdge);
  assert.equal(tableEdge.confidence, 1);
  assert.equal(tableEdge.evidence[0].file, "sqlmap/order.xml");
  assert.equal(graph.nodes.some((node) => node.id === "page:order/audit.jsp"), false);
  assert.ok(edge(
    graph,
    "route:/order/audit.do",
    "forwards_to",
    "page:web/order/audit.jsp",
  ));
  assert.ok(edge(
    graph,
    "page:web/order/audit.jsp",
    "loads_script",
    "file:web/js/order.js",
  ));
  assert.ok(edge(
    graph,
    "page:web/order/audit.jsp",
    "includes",
    "page:common/header.jsp",
  ));
});

test("analyzer preserves ambiguous heuristic calls and scan warnings", async () => {
  const graph = await analyzeProject(projectRoot);
  const callEdges = graph.edges.filter((candidate) => candidate.type === "calls");

  assert.equal(callEdges.length > 0, true);
  assert.equal(callEdges.every((candidate) => candidate.confidence <= 0.9), true);
  assert.equal(graph.summary.nodeTypes.statement, 4);
  assert.equal(graph.summary.nodeTypes.table, 4);
  assert.equal(graph.warnings.some((warning) => warning.includes("order.missingStatement")), true);
  assert.equal(graph.warnings.some((warning) => warning.includes("com.acme.web.LegacyReportServlet")), true);
});

test("analyzer reports oversized, binary, and symbolic-link source files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-warnings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "TooLarge.java"), "class TooLarge {}\n");
  await writeFile(path.join(root, "Binary.java"), Buffer.from([99, 108, 97, 115, 115, 0, 123, 125]));
  await writeFile(path.join(root, "Real.java"), "class Real {}\n");
  await symlink(path.join(root, "Real.java"), path.join(root, "Linked.java"));

  const graph = await analyzeProject(root, { maxFileBytes: 15 });

  assert.deepEqual(graph.warnings, [
    "skipped binary-file: Binary.java",
    "skipped file-too-large: TooLarge.java",
    "skipped symbolic-link: Linked.java",
  ]);
});

test("analyzer propagates partial XML parser warnings into the graph", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-xml-warnings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "web.xml"), "<web-app><servlet></servlet>");
  await writeFile(path.join(root, "BrokenSqlMap.xml"), "<sqlMap><select id='all'>SELECT * FROM T_USER</select>");

  const graph = await analyzeProject(root);

  assert.equal(graph.warnings.some((warning) => warning.includes("unclosed <web-app>")), true);
  assert.equal(graph.warnings.some((warning) => warning.includes("unclosed <sqlMap>")), true);
});

test("analyzer does not attach every method to every type in a multi-type Java file", async () => {
  const graph = await analyzeProject(projectRoot);

  assert.ok(edge(
    graph,
    "java_type:com.acme.multi.FirstType",
    "declares",
    "java_method:com.acme.multi.FirstType#firstOnly/0",
  ));
  assert.ok(edge(
    graph,
    "java_type:com.acme.multi.SecondType",
    "declares",
    "java_method:com.acme.multi.SecondType#secondOnly/0",
  ));
  assert.equal(edge(
    graph,
    "java_type:com.acme.multi.FirstType",
    "declares",
    "java_method:com.acme.multi.FirstType#secondOnly/0",
  ), undefined);
});

test("analyzer uses Java imports to disambiguate same-named interfaces", async () => {
  const graph = await analyzeProject(projectRoot);

  const correct = edge(
    graph,
    "java_type:com.acme.impl.ImportedOrderDao",
    "implements",
    "java_type:com.acme.a.OrderDao",
  );
  assert.ok(correct);
  assert.equal(correct.confidence, 1);
  assert.equal(edge(
    graph,
    "java_type:com.acme.impl.ImportedOrderDao",
    "implements",
    "java_type:com.acme.b.OrderDao",
  ), undefined);
});

test("analyzer applies servlet wildcard mappings and HTTP-method entry selection", async () => {
  const graph = await analyzeProject(projectRoot);

  assert.ok(edge(
    graph,
    "route:/api/orders/list",
    "maps_to",
    "java_type:com.acme.api.ApiServlet",
  ));
  assert.ok(edge(
    graph,
    "route:/api/orders/list",
    "dispatches_to",
    "java_method:com.acme.api.ApiServlet#doGet/2",
  ));
  assert.equal(edge(
    graph,
    "route:/api/orders/list",
    "dispatches_to",
    "java_method:com.acme.api.ApiServlet#doPost/2",
  ), undefined);
});
