import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { createFileBatches } from "../src/batches.mjs";
import { readAndProcessFile } from "../src/file-processor.mjs";
import { processFileBatches, resolveWorkerCount } from "../src/worker-pool.mjs";

const delayedWorkerUrl = new URL("./fixtures/workers/delayed-worker.mjs", import.meta.url);
const crashWorkerUrl = new URL("./fixtures/workers/crash-worker.mjs", import.meta.url);

async function projectFiles(t, entries) {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [];
  for (const [relativePath, content, extra = {}] of entries) {
    const absolutePath = path.join(root, ...relativePath.split("/"));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(absolutePath), { recursive: true }));
    await writeFile(absolutePath, content);
    const metadata = await stat(absolutePath);
    const extension = path.extname(relativePath).toLowerCase();
    const language = extension === ".java"
      ? "java"
      : extension === ".jsp"
        ? "jsp"
        : extension === ".js"
          ? "javascript"
          : extension === ".xml"
            ? "xml"
            : "markdown";
    files.push({
      path: relativePath,
      relativePath,
      absolutePath,
      language,
      category: language === "markdown" ? "docs" : "code",
      size: metadata.size,
      mtimeMs: metadata.mtimeMs,
      ...extra,
    });
  }
  return { root, files };
}

function plan(files, options = {}) {
  return createFileBatches(files, {
    targetBytes: options.targetBytes ?? 1024 * 1024,
    maxFiles: options.maxFiles ?? 1,
  });
}

function assertPortableResults(results, forbiddenPaths = []) {
  assert.deepEqual(structuredClone(results), results);
  assert.deepEqual(JSON.parse(JSON.stringify(results)), results);
  const serialized = JSON.stringify(results);
  for (const forbidden of forbiddenPaths) {
    assert.equal(serialized.includes(forbidden), false, `result leaked ${forbidden}`);
  }
  for (let index = 1; index < results.length; index += 1) {
    assert.equal(results[index - 1].relativePath < results[index].relativePath, true);
  }
}

async function waitForCounter(view, index, expected, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(view, index) < expected) {
    if (Date.now() >= deadline) throw new Error(`counter ${index} did not reach ${expected}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function processorGate(result) {
  let release;
  let markStarted;
  let calls = 0;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const pending = new Promise((resolve) => { release = () => resolve(result); });
  return {
    started,
    release,
    get calls() { return calls; },
    async processor() {
      calls += 1;
      markStarted();
      return pending;
    },
  };
}

test("resolveWorkerCount uses the bounded CPU default and validates overrides", () => {
  assert.equal(
    resolveWorkerCount(),
    Math.min(8, Math.max(1, availableParallelism() - 1)),
  );
  for (const workers of [1, 2, 8]) assert.equal(resolveWorkerCount(workers), workers);
  for (const workers of [0, -1, 1.5, "2", Number.POSITIVE_INFINITY]) {
    assert.throws(() => resolveWorkerCount(workers), /positive integer/i);
  }
});

test("main-thread compatibility mode constructs no workers", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/A.java", "class A {}"],
    ["src/B.java", "class B {}"],
  ]);
  let constructorCalls = 0;
  const processed = [];

  const results = await processFileBatches(plan(files), {
    mainThread: true,
    workerFactory() {
      constructorCalls += 1;
      throw new Error("worker construction must be bypassed");
    },
    async mainThreadProcessor(file, options) {
      processed.push(file.relativePath);
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(constructorCalls, 0);
  assert.deepEqual(processed, ["src/A.java", "src/B.java"]);
  assert.deepEqual(results.map((result) => result.relativePath), ["src/A.java", "src/B.java"]);
});

test("main-thread compatibility mode isolates an invalid file result", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/Broken.java", "class Broken {}"],
    ["src/Healthy.java", "class Healthy {}"],
  ]);

  const results = await processFileBatches(plan(files), {
    mainThread: true,
    async mainThreadProcessor(file, options) {
      if (file.relativePath === "src/Broken.java") {
        return { status: "malformed-worker-result", absolutePath: file.absolutePath };
      }
      return readAndProcessFile(file, options);
    },
  });

  assert.deepEqual(results.map((result) => [result.relativePath, result.status]), [
    ["src/Broken.java", "operational-error"],
    ["src/Healthy.java", "parsed"],
  ]);
  assert.deepEqual(results[0].diagnostics, [{
    code: "file-processing-contract-error",
    relativePath: "src/Broken.java",
    operation: "process",
    message: "Unable to validate processed source file",
  }]);
  assert.equal(JSON.stringify(results).includes(files[0].absolutePath), false);
});

test("real workers return identical sorted facts with 1, 2, or 8 workers and reversed completion", async (t) => {
  const entries = Array.from({ length: 10 }, (_, index) => [
    `src/F${String(index).padStart(2, "0")}.java`,
    `package sample; class F${index} { void run${index}() {} }`,
    { workerDelayMs: index === 0 ? 120 : (10 - index) * 3 },
  ]);
  entries.push(["docs/README.md", "legacy project"]);
  const { root, files } = await projectFiles(t, entries);
  const batches = plan(files);
  const baseline = await processFileBatches(batches, {
    workers: 1,
    workerUrl: delayedWorkerUrl,
  });

  for (const workers of [2, 8]) {
    const actual = await processFileBatches(batches, { workers, workerUrl: delayedWorkerUrl });
    assert.deepEqual(actual, baseline);
  }

  const reversed = await processFileBatches({
    batches: [...batches.batches].reverse().map((batch) => ({
      ...batch,
      files: [...batch.files].reverse(),
    })),
    metadata: [...batches.metadata].reverse(),
  }, { workers: 8, workerUrl: delayedWorkerUrl });
  assert.deepEqual(reversed, baseline);
  assert.equal(baseline.length, files.length);
  assertPortableResults(baseline, [root]);
});

test("one parser failure remains an isolated file result inside a successful batch", async (t) => {
  const { root, files } = await projectFiles(t, [
    ["src/Broken.java", "class Broken {}", { workerParserError: true }],
    ["src/Healthy.java", "class Healthy { void run() {} }"],
  ]);
  const results = await processFileBatches(plan(files, { maxFiles: 8 }), {
    workers: 1,
    workerUrl: delayedWorkerUrl,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].relativePath, "src/Broken.java");
  assert.equal(results[0].status, "error");
  assert.equal(results[1].relativePath, "src/Healthy.java");
  assert.equal(results[1].status, "parsed");
  assertPortableResults(results, [root]);
});

test("source-derived absolute-looking paths do not trigger worker failure", async (t) => {
  const { root, files } = await projectFiles(t, [
    [
      "WEB-INF/web.xml",
      "<web-app><servlet><servlet-name>home</servlet-name><servlet-class>com.acme.HomeServlet</servlet-class></servlet><servlet-mapping><servlet-name>home</servlet-name><url-pattern>/home/*</url-pattern></servlet-mapping></web-app>",
    ],
    [
      "src/com/acme/LegacyPaths.java",
      'package com.acme; class LegacyPaths { String root = "C:\\\\company\\\\app"; }',
    ],
  ]);
  let fallbacks = 0;

  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: delayedWorkerUrl,
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(results.length, files.length);
  assert.equal(fallbacks, 0);
  assert.deepEqual(results.map((result) => result.status), ["parsed", "parsed"]);
  const webResult = results.find((result) => result.relativePath === "WEB-INF/web.xml");
  const javaResult = results.find((result) => result.relativePath === "src/com/acme/LegacyPaths.java");
  assert.equal(webResult.record.facts.web.routes[0].url, "/home/*");
  assert.equal(javaResult.record.facts.stringConstants[0].value, "C:\\\\company\\\\app");
  assertPortableResults(results, [root]);
});

test("source-derived JSP parameter names do not trigger worker failure", async (t) => {
  const { root, files } = await projectFiles(t, [[
    "web/edit.jsp",
    [
      '<form action="/save">',
      '  <input type="hidden" name="duration" value="30">',
      '  <input type="hidden" name="worker" value="legacy">',
      '  <input type="hidden" name="node" value="primary">',
      "</form>",
    ].join("\n"),
  ]]);
  let fallbacks = 0;

  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: delayedWorkerUrl,
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 0);
  assert.deepEqual(results[0].record.facts.requests[0].parameters, {
    duration: "30",
    worker: "legacy",
    node: "primary",
  });
  assertPortableResults(results, [root]);
});

test("source-derived iBATIS path-like identifiers do not trigger worker failure", async (t) => {
  const { root, files } = await projectFiles(t, [[
    "sql/jobs.xml",
    '<sqlMap><procedure id="/home/job">select 1</procedure></sqlMap>',
  ]]);
  let fallbacks = 0;

  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: delayedWorkerUrl,
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 0);
  assert.equal(results[0].record.facts.ibatis.statements[0].fullId, "/home/job");
  assert.match(results[0].record.warnings[0], /statement \/home\/job/);
  assertPortableResults(results, [root]);
});

test("a crashed batch is retried once on a fresh real worker", async (t) => {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const { files } = await projectFiles(t, [
    ["src/Retry.java", "class Retry {}", { workerCrashAttempts: 1 }],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { control: control.buffer },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].status, "parsed");
  assert.equal(Atomics.load(control, 0), 2);
  assert.equal(Atomics.load(control, 1), 2);
  assert.equal(fallbacks, 0);
});

test("a twice-crashed batch is deterministically split until its files succeed", async (t) => {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const { files } = await projectFiles(t, [
    ["src/A.java", "class A {}", { workerCrashAtSize: 2 }],
    ["src/B.java", "class B {}", { workerCrashAtSize: 2 }],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files, { maxFiles: 8 }), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { control: control.buffer },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.deepEqual(results.map((result) => result.relativePath), ["src/A.java", "src/B.java"]);
  assert.equal(Atomics.load(control, 0), 3);
  assert.equal(Atomics.load(control, 1), 4);
  assert.equal(fallbacks, 0);
});

test("a singleton that keeps crashing falls back once on the main thread", async (t) => {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const { files } = await projectFiles(t, [
    ["src/Fallback.java", "class Fallback {}", { workerCrashAlways: true }],
  ]);
  const fallbackPaths = [];
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { control: control.buffer },
    async mainThreadProcessor(file, options) {
      fallbackPaths.push(file.relativePath);
      return readAndProcessFile(file, options);
    },
  });

  assert.deepEqual(fallbackPaths, ["src/Fallback.java"]);
  assert.equal(Atomics.load(control, 0), 2);
  assert.equal(Atomics.load(control, 1), 2);
  assert.equal(results.length, 1);
  assert.equal(results[0].relativePath, "src/Fallback.java");
});

test("a real startup failure terminates started workers and switches the whole run to main thread", async (t) => {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const { files } = await projectFiles(t, [
    ["src/A.java", "class A {}"],
    ["src/B.java", "class B {}"],
  ]);
  const created = [];
  const exited = [];
  let createdCount = 0;
  const fallbackPaths = [];

  const results = await processFileBatches(plan(files), {
    workers: 2,
    workerUrl: crashWorkerUrl,
    workerFactory(url, options) {
      const index = createdCount++;
      const worker = new Worker(url, {
        ...options,
        workerData: {
          control: control.buffer,
          startupMode: index === 1 ? "throw" : undefined,
        },
      });
      created.push(worker);
      exited.push(new Promise((resolve) => worker.once("exit", resolve)));
      return worker;
    },
    async mainThreadProcessor(file, options) {
      fallbackPaths.push(file.relativePath);
      return readAndProcessFile(file, options);
    },
  });

  await Promise.all(exited);
  assert.equal(created.length, 2);
  assert.equal(Atomics.load(control, 1), 0);
  assert.deepEqual(fallbackPaths.sort(), ["src/A.java", "src/B.java"]);
  assert.deepEqual(results.map((result) => result.relativePath), ["src/A.java", "src/B.java"]);
  for (const worker of created) {
    assert.equal(worker.listenerCount("message"), 0);
    assert.equal(worker.listenerCount("error"), 0);
    assert.equal(worker.listenerCount("online"), 0);
    assert.equal(worker.listenerCount("exit"), 0);
  }
});

test("one startup failure immediately terminates a sibling that never becomes ready", { timeout: 10_000 }, async (t) => {
  const { files } = await projectFiles(t, [
    ["src/A.java", "class A {}"],
    ["src/B.java", "class B {}"],
  ]);
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(), 5_000);
  const exited = [];
  let createdCount = 0;
  const fallbackPaths = [];
  try {
    const results = await processFileBatches(plan(files), {
      workers: 2,
      signal: controller.signal,
      startupTimeoutMs: 60_000,
      workerUrl: crashWorkerUrl,
      workerFactory(url, options) {
        const index = createdCount++;
        const worker = new Worker(url, {
          ...options,
          workerData: { startupMode: index === 0 ? "hang" : "throw" },
        });
        exited.push(new Promise((resolve) => worker.once("exit", resolve)));
        return worker;
      },
      async mainThreadProcessor(file, options) {
        fallbackPaths.push(file.relativePath);
        return readAndProcessFile(file, options);
      },
    });
    assert.deepEqual(results.map((result) => result.relativePath), ["src/A.java", "src/B.java"]);
  } finally {
    controller.abort();
    clearTimeout(guard);
  }
  await Promise.all(exited);
  assert.deepEqual(fallbackPaths.sort(), ["src/A.java", "src/B.java"]);
});

test("a constructor failure switches the whole run to main-thread processing", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/A.java", "class A {}"],
    ["src/B.java", "class B {}"],
  ]);
  let constructorCalls = 0;
  const fallbackPaths = [];
  const results = await processFileBatches(plan(files), {
    workers: 2,
    workerFactory() {
      constructorCalls += 1;
      throw new Error("synthetic constructor failure");
    },
    async mainThreadProcessor(file, options) {
      fallbackPaths.push(file.relativePath);
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(constructorCalls, 2);
  assert.deepEqual(fallbackPaths.sort(), ["src/A.java", "src/B.java"]);
  assert.equal(results.length, 2);
});

test("replacement startup failure discards partial worker results before whole-run fallback", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/A.java", "class A {}", { workerCrashAlways: true, workerCrashDelayMs: 120 }],
    ["src/B.java", "class B {}"],
    ["src/C.java", "class C {}"],
  ]);
  let created = 0;
  const fallbackPaths = [];
  const results = await processFileBatches(plan(files), {
    workers: 2,
    workerFactory(_url, options) {
      const index = created++;
      if (index === 0) return new Worker(crashWorkerUrl, options);
      if (index === 1) return new Worker(delayedWorkerUrl, options);
      return new Worker(crashWorkerUrl, {
        ...options,
        workerData: { startupMode: "throw" },
      });
    },
    async mainThreadProcessor(file, options) {
      fallbackPaths.push(file.relativePath);
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(created, 3);
  assert.deepEqual(fallbackPaths, ["src/A.java", "src/B.java", "src/C.java"]);
  assert.deepEqual(results.map((result) => result.relativePath), [
    "src/A.java",
    "src/B.java",
    "src/C.java",
  ]);
});

test("invalid worker messages are isolated and cannot leak absolute paths", async (t) => {
  const { root, files } = await projectFiles(t, [
    ["src/Safe.java", "class Safe {}"],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { protocolMode: "absolute-result-path" },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 1);
  assert.equal(results[0].relativePath, "src/Safe.java");
  assertPortableResults(results, [root]);
});

test("a worker result cannot hide another source file absolute path in diagnostics", async (t) => {
  const { root, files } = await projectFiles(t, [
    ["src/A.java", "class A {}"],
    ["src/B.java", "class B {}"],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files, { maxFiles: 8 }), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { protocolMode: "cross-file-absolute-diagnostic" },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 2);
  assertPortableResults(results, [root]);
});

test("Windows absolute paths from worker diagnostics trigger isolated fallback", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/Safe.java", "class Safe {}"],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { protocolMode: "windows-absolute-diagnostic" },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 1);
  assert.equal(JSON.stringify(results).includes("C:\\\\company"), false);
});

test("valid worker diagnostics containing machine paths trigger isolated fallback", async (t) => {
  const { root, files } = await projectFiles(t, [
    ["src/Safe.java", "class Safe {}"],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { protocolMode: "absolute-valid-diagnostic" },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 1);
  assert.equal(results[0].status, "parsed");
  assertPortableResults(results, [root, "/private/company/legacy-project"]);
});

test("valid serialized worker errors containing machine paths trigger isolated fallback", async (t) => {
  const { root, files } = await projectFiles(t, [
    ["src/Safe.java", "class Safe {}"],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { protocolMode: "absolute-valid-error" },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 1);
  assert.equal(results[0].status, "parsed");
  assertPortableResults(results, [root, "/private/company/legacy-project"]);
});

test("strict result and record protocol rejects malformed scheduler and graph data", async (t) => {
  const invalidModes = [
    "missing-result-field",
    "extra-result-graph",
    "missing-record-field",
    "invalid-parser-kind",
    "invalid-fingerprint",
    "invalid-metadata-shape",
    "invalid-record-facts",
    "invalid-record-facts-array",
    "mismatched-diagnostics",
    "invalid-error-object",
  ];

  for (const protocolMode of invalidModes) {
    await t.test(protocolMode, async (t) => {
      const { root, files } = await projectFiles(t, [
        ["src/Safe.java", "class Safe {}"],
      ]);
      let fallbacks = 0;
      const results = await processFileBatches(plan(files), {
        workers: 1,
        workerUrl: crashWorkerUrl,
        workerData: { protocolMode },
        async mainThreadProcessor(file, options) {
          fallbacks += 1;
          return readAndProcessFile(file, options);
        },
      });

      assert.equal(fallbacks, 1, `${protocolMode} bypassed worker isolation`);
      assertPortableResults(results, [root, "/private/other-project", "D:\\other-project", "\\\\server\\share"]);
    });
  }
});

test("source fact keys that resemble scheduler metadata remain inert data", async (t) => {
  const protocolModes = ["deep-graph-builder", "deep-worker-id", "deep-timing"];

  for (const protocolMode of protocolModes) {
    await t.test(protocolMode, async (t) => {
      const { root, files } = await projectFiles(t, [[
        "src/Safe.java",
        "class Safe {}",
      ]]);
      let fallbacks = 0;
      const results = await processFileBatches(plan(files), {
        workers: 1,
        workerUrl: crashWorkerUrl,
        workerData: { protocolMode },
        async mainThreadProcessor(file, options) {
          fallbacks += 1;
          return readAndProcessFile(file, options);
        },
      });

      assert.equal(fallbacks, 0);
      assert.equal(Object.hasOwn(results[0].record.facts, "nested"), true);
      assertPortableResults(results, [root]);
    });
  }
});

test("strict path validation permits routes and HTTP URLs in facts", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/Safe.java", "class Safe {}"],
  ]);
  let fallbacks = 0;
  const results = await processFileBatches(plan(files), {
    workers: 1,
    workerUrl: crashWorkerUrl,
    workerData: { protocolMode: "valid-route-and-http-url" },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });

  assert.equal(fallbacks, 0);
  assert.equal(results[0].record.facts.route, "/api/orders/list");
  assert.equal(results[0].record.facts.documentation, "https://example.com/private/reference");
});

test("metadata-only processing rejects when abort wins before an ignoring processor resolves", async (t) => {
  const { files } = await projectFiles(t, [
    ["docs/README.md", "legacy project"],
  ]);
  const accepted = await readAndProcessFile(files[0]);
  const gate = processorGate(accepted);
  const controller = new AbortController();
  const outcome = processFileBatches(plan(files), {
    signal: controller.signal,
    mainThreadProcessor: gate.processor,
  });

  await gate.started;
  controller.abort();
  gate.release();

  await assert.rejects(outcome, { name: "AbortError", code: "ABORT_ERR" });
  assert.equal(gate.calls, 1);
});

test("startup whole-run fallback rejects when abort wins before an ignoring processor resolves", async (t) => {
  const { files } = await projectFiles(t, [
    ["src/Fallback.java", "class Fallback {}"],
  ]);
  const accepted = await readAndProcessFile(files[0]);
  const gate = processorGate(accepted);
  const controller = new AbortController();
  let constructors = 0;
  const outcome = processFileBatches(plan(files), {
    signal: controller.signal,
    workerFactory() {
      constructors += 1;
      throw new Error("startup failure");
    },
    mainThreadProcessor: gate.processor,
  });

  await gate.started;
  controller.abort();
  gate.release();

  await assert.rejects(outcome, { name: "AbortError", code: "ABORT_ERR" });
  assert.equal(constructors, 1);
  assert.equal(gate.calls, 1);
});

test("worker success followed by metadata processing still rejects a late abort without redispatch", async (t) => {
  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const { files } = await projectFiles(t, [
    ["src/Parsed.java", "class Parsed {}"],
    ["docs/README.md", "legacy project"],
  ]);
  const metadataFile = files.find((file) => file.language === "markdown");
  const accepted = await readAndProcessFile(metadataFile);
  const gate = processorGate(accepted);
  const controller = new AbortController();
  const outcome = processFileBatches(plan(files), {
    workers: 1,
    signal: controller.signal,
    workerUrl: delayedWorkerUrl,
    workerData: { control: control.buffer },
    mainThreadProcessor: gate.processor,
  });

  await gate.started;
  assert.equal(Atomics.load(control, 1), 1);
  controller.abort();
  gate.release();

  await assert.rejects(outcome, { name: "AbortError", code: "ABORT_ERR" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Atomics.load(control, 1), 1);
  assert.equal(gate.calls, 1);
});

test("pre-abort starts no workers and mid-run abort terminates every worker without redispatch", async (t) => {
  const { files } = await projectFiles(t, Array.from({ length: 8 }, (_, index) => [
    `src/F${index}.java`,
    `class F${index} {}`,
    { workerDelayMs: 1_000 },
  ]));
  const pre = new AbortController();
  pre.abort();
  let preWorkers = 0;
  await assert.rejects(
    processFileBatches(plan(files), {
      signal: pre.signal,
      workerFactory() {
        preWorkers += 1;
        throw new Error("must not construct");
      },
    }),
    { name: "AbortError", code: "ABORT_ERR" },
  );
  assert.equal(preWorkers, 0);

  const control = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2));
  const controller = new AbortController();
  const created = [];
  const exited = [];
  let fallbacks = 0;
  const outcome = processFileBatches(plan(files), {
    workers: 2,
    signal: controller.signal,
    workerUrl: delayedWorkerUrl,
    workerData: { control: control.buffer },
    workerFactory(url, options) {
      const worker = new Worker(url, options);
      created.push(worker);
      exited.push(new Promise((resolve) => worker.once("exit", resolve)));
      return worker;
    },
    async mainThreadProcessor(file, options) {
      fallbacks += 1;
      return readAndProcessFile(file, options);
    },
  });
  await waitForCounter(control, 1, 2);
  controller.abort();

  await assert.rejects(outcome, { name: "AbortError", code: "ABORT_ERR" });
  await Promise.all(exited);
  const dispatchesAfterTermination = Atomics.load(control, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(created.length, 2);
  assert.equal(Atomics.load(control, 1), dispatchesAfterTermination);
  assert.equal(fallbacks, 0);
  for (const worker of created) {
    assert.equal(worker.listenerCount("message"), 0);
    assert.equal(worker.listenerCount("error"), 0);
    assert.equal(worker.listenerCount("online"), 0);
    assert.equal(worker.listenerCount("exit"), 0);
  }
});
