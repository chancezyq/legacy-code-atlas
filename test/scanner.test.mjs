import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runBoundedQueue } from "../src/concurrency.mjs";
import { scanProject } from "../src/scanner.mjs";

function dirent(name, kind) {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symbolic-link",
  };
}

function errorWithCode(code) {
  return Object.assign(new Error(`injected ${code}`), { code });
}

function relativeTo(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}

function noIgnoreFile() {
  throw errorWithCode("ENOENT");
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("scanner keeps legacy source files and excludes generated and unsupported files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const files = {
    "web/order/audit.jsp": "<form action='/order/audit.do'></form>\n",
    "web/js/order.js": "fetch('/order/status.do');\n",
    "src/OrderAction.java": "class OrderAction {}\n",
    "WEB-INF/web.xml": "<web-app/>\n",
    "sqlmap/order.xml": "<sqlMap namespace='order'/>\n",
    "README.md": "documentation\n",
    "target/OrderAction.class": "compiled\n",
    "node_modules/pkg/index.js": "vendor\n",
    ".git/config": "git metadata\n",
  };

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(root, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content);
  }
  await writeFile(path.join(root, "web/logo.png"), Buffer.from([0, 1, 2, 0, 255]));

  const result = await scanProject(root);

  assert.deepEqual(
    result.files.map((file) => [file.path, file.language, file.category]),
    [
      ["README.md", "markdown", "docs"],
      ["sqlmap/order.xml", "xml", "config"],
      ["src/OrderAction.java", "java", "code"],
      ["WEB-INF/web.xml", "xml", "config"],
      ["web/js/order.js", "javascript", "code"],
      ["web/order/audit.jsp", "jsp", "markup"],
    ],
  );
  assert.equal(result.skipped.some((entry) => entry.path === "web/logo.png"), true);
  assert.equal(result.root, root);
});

test("scanner applies additional ignore patterns without following symlinks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-ignore-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "generated"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "generated", "Old.java"), "class Old {}\n");
  await writeFile(path.join(root, "src", "Keep.java"), "class Keep {}\n");

  const result = await scanProject(root, { ignore: ["generated/**"] });

  assert.deepEqual(result.files.map((file) => file.path), ["src/Keep.java"]);
});

test("scanner reads project-local .legacy-code-atlasignore patterns", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-ignore-file-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "generated"), { recursive: true });
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, ".legacy-code-atlasignore"), "# generated code\ngenerated/**\n");
  await writeFile(path.join(root, "generated", "Old.java"), "class Old {}\n");
  await writeFile(path.join(root, "src", "Keep.java"), "class Keep {}\n");

  const result = await scanProject(root);

  assert.deepEqual(result.files.map((file) => file.path), ["src/Keep.java"]);
});

test("scanner preserves primitive ignore-file read failures", async () => {
  const io = {
    readFile: async () => { throw null; },
    readdir: async () => [],
    stat: async () => ({ size: 0, mtimeMs: 0 }),
  };

  await assert.rejects(
    scanProject("virtual-ignore-read-failure", { io }),
    (error) => error === null,
  );
});

test("scanner bounds directory and stat I/O with one shared concurrency limit", async () => {
  const root = path.resolve("virtual-concurrent-project");
  const tree = new Map([
    ["", [
      dirent("a-dir", "directory"),
      dirent("b.java", "file"),
      dirent("c-dir", "directory"),
      dirent("d.java", "file"),
      dirent("e.java", "file"),
      dirent("f.java", "file"),
    ]],
    ["a-dir", []],
    ["c-dir", []],
  ]);
  let active = 0;
  let maximum = 0;
  const activeOperations = new Set();
  let mixedOperationsOverlapped = false;

  async function tracked(operation, work) {
    active += 1;
    maximum = Math.max(maximum, active);
    activeOperations.add(operation);
    mixedOperationsOverlapped ||= activeOperations.has("readdir") && activeOperations.has("stat");
    await new Promise((resolve) => setTimeout(resolve, 5));
    try {
      return work();
    } finally {
      active -= 1;
      activeOperations.delete(operation);
    }
  }

  const io = {
    readFile: noIgnoreFile,
    readdir: (absolutePath) => tracked("readdir", () => tree.get(relativeTo(root, absolutePath))),
    stat: () => tracked("stat", () => ({ size: 12, mtimeMs: 1234 })),
  };

  const result = await scanProject(root, { io, workers: 8, scanConcurrency: 3 });

  assert.equal(maximum, 3);
  assert.equal(mixedOperationsOverlapped, true);
  assert.deepEqual(result.files.map((file) => file.path), ["b.java", "d.java", "e.java", "f.java"]);
});

test("workers controls default scan concurrency and scanConcurrency overrides it", async () => {
  const root = path.resolve("virtual-concurrency-options");

  async function observedMaximum(options) {
    let active = 0;
    let maximum = 0;
    const io = {
      readFile: noIgnoreFile,
      readdir: async () => Array.from({ length: 8 }, (_, index) => dirent(`${index}.java`, "file")),
      stat: async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await nextTurn();
        active -= 1;
        return { size: 1, mtimeMs: 1 };
      },
    };
    await scanProject(root, { io, ...options });
    return maximum;
  }

  assert.equal(await observedMaximum({ workers: 1 }), 4);
  assert.equal(await observedMaximum({ workers: 8, scanConcurrency: 2 }), 2);
});

test("scanner rejects non-positive or non-integer concurrency options before I/O", async () => {
  for (const option of ["workers", "scanConcurrency"]) {
    for (const value of [0, -1, 1.5, Number.NaN, "2"]) {
      let calls = 0;
      const io = {
        readFile: async () => { calls += 1; },
        readdir: async () => { calls += 1; return []; },
        stat: async () => { calls += 1; return { size: 0, mtimeMs: 0 }; },
      };

      await assert.rejects(
        scanProject("virtual-invalid-options", { io, [option]: value }),
        new RegExp(`${option} must be a positive integer`),
      );
      assert.equal(calls, 0);
    }
  }
});

test("scanner sorts files, skipped entries, and diagnostics despite out-of-order completion", async () => {
  const root = path.resolve("virtual-order-project");
  const tree = new Map([
    ["", [
      dirent("z-locked", "directory"),
      dirent("z-big.java", "file"),
      dirent("z.java", "file"),
      dirent("m-link", "symbolic-link"),
      dirent("a-locked", "directory"),
      dirent("a-big.java", "file"),
      dirent("a.bin", "file"),
      dirent("a.java", "file"),
    ]],
  ]);
  const delays = new Map([
    ["z-locked", 1],
    ["z-big.java", 1],
    ["z.java", 1],
    ["a-locked", 8],
    ["a-big.java", 8],
    ["a.java", 8],
  ]);
  const io = {
    readFile: noIgnoreFile,
    readdir: async (absolutePath) => {
      const relativePath = relativeTo(root, absolutePath);
      await new Promise((resolve) => setTimeout(resolve, delays.get(relativePath) ?? 0));
      if (relativePath.endsWith("locked")) throw errorWithCode("EACCES");
      return tree.get(relativePath);
    },
    stat: async (absolutePath) => {
      const relativePath = relativeTo(root, absolutePath);
      await new Promise((resolve) => setTimeout(resolve, delays.get(relativePath) ?? 0));
      return { size: relativePath.endsWith("big.java") ? 100 : 1, mtimeMs: 10 };
    },
  };

  const result = await scanProject(root, { io, maxFileBytes: 10, scanConcurrency: 4 });

  assert.deepEqual(result.files.map((file) => file.path), ["a.java", "z.java"]);
  assert.deepEqual(result.skipped, [
    { path: "a-big.java", reason: "file-too-large", size: 100 },
    { path: "a.bin", reason: "unsupported-file-type" },
    { path: "m-link", reason: "symbolic-link" },
    { path: "z-big.java", reason: "file-too-large", size: 100 },
  ]);
  assert.deepEqual(result.diagnostics, [
    { path: "a-locked", operation: "readdir", code: "EACCES", message: "Unable to read directory" },
    { path: "z-locked", operation: "readdir", code: "EACCES", message: "Unable to read directory" },
  ]);
});

test("scanner keeps subdirectory readdir failures as operational diagnostics", async () => {
  const root = path.resolve("virtual-unreadable-subdirectory");
  const io = {
    readFile: noIgnoreFile,
    readdir: async (absolutePath) => {
      const relativePath = relativeTo(root, absolutePath);
      if (relativePath === "") {
        return [dirent("locked", "directory"), dirent("Keep.java", "file")];
      }
      throw errorWithCode("EACCES");
    },
    stat: async () => ({ size: 7, mtimeMs: 99 }),
  };

  const result = await scanProject(root, { io });

  assert.deepEqual(result.files.map((file) => file.path), ["Keep.java"]);
  assert.deepEqual(result.diagnostics, [
    { path: "locked", operation: "readdir", code: "EACCES", message: "Unable to read directory" },
  ]);
  assert.equal(JSON.stringify(result.diagnostics).includes(root), false);
});

test("scanner rejects when the project root cannot be read", async () => {
  const root = path.resolve("virtual-unreadable-root");
  const rootError = errorWithCode("EACCES");
  const io = {
    readFile: noIgnoreFile,
    readdir: async () => { throw rootError; },
    stat: async () => ({ size: 0, mtimeMs: 0 }),
  };

  await assert.rejects(scanProject(root, { io }), (error) => error === rootError);
});

test("scanner excludes symlinks without following them and records file metadata", async () => {
  const root = path.resolve("virtual-metadata-project");
  const operations = [];
  const io = {
    readFile: noIgnoreFile,
    readdir: async (absolutePath) => {
      operations.push(["readdir", relativeTo(root, absolutePath)]);
      return [dirent("Alias.java", "symbolic-link"), dirent("Source.java", "file")];
    },
    stat: async (absolutePath) => {
      operations.push(["stat", relativeTo(root, absolutePath)]);
      return { size: 321, mtimeMs: 456.75 };
    },
  };

  const result = await scanProject(root, { io });

  assert.deepEqual(result.skipped, [{ path: "Alias.java", reason: "symbolic-link" }]);
  assert.deepEqual(
    result.files.map(({ path: relativePath, size, mtimeMs }) => ({ path: relativePath, size, mtimeMs })),
    [{ path: "Source.java", size: 321, mtimeMs: 456.75 }],
  );
  assert.deepEqual(operations, [["readdir", ""], ["stat", "Source.java"]]);
});

test("scanner rejects an already-aborted scan before scheduling I/O", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const io = {
    readFile: async () => { calls += 1; },
    readdir: async () => { calls += 1; return []; },
    stat: async () => { calls += 1; return { size: 0, mtimeMs: 0 }; },
  };

  await assert.rejects(
    scanProject("virtual-pre-abort", { io, signal: controller.signal }),
    { name: "AbortError" },
  );
  assert.equal(calls, 0);
});

test("bounded queue supports reentrant enqueue, rejects workers, and cleans abort listeners", async () => {
  const seen = [];
  await runBoundedQueue(["root"], async (item, enqueue) => {
    seen.push(item);
    if (item === "root") enqueue("child-a", "child-b");
    await nextTurn();
  }, { concurrency: 2 });
  assert.deepEqual(seen, ["root", "child-a", "child-b"]);

  const rejected = [];
  await assert.rejects(
    runBoundedQueue(["reject", "queued"], async (item) => {
      rejected.push(item);
      if (item === "reject") throw new Error("worker failed");
    }, { concurrency: 1 }),
    /worker failed/,
  );
  assert.deepEqual(rejected, ["reject"]);

  let markSlowStarted;
  let releaseSlow;
  const slowStarted = new Promise((resolve) => { markSlowStarted = resolve; });
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const lifecycle = [];
  const failedWithActiveWorker = runBoundedQueue(["reject", "slow", "queued"], async (item) => {
    lifecycle.push(`${item}:started`);
    if (item === "reject") {
      await nextTurn();
      throw new Error("active worker failure");
    }
    if (item === "slow") {
      markSlowStarted();
      await slowGate;
      lifecycle.push("slow:finished");
    }
  }, { concurrency: 2 });
  await slowStarted;
  await assert.rejects(failedWithActiveWorker, /active worker failure/);
  assert.equal(lifecycle.includes("queued:started"), false);
  releaseSlow();
  await nextTurn();
  assert.equal(lifecycle.includes("slow:finished"), true);

  const controller = new AbortController();
  await runBoundedQueue(["complete"], async () => {}, { concurrency: 1, signal: controller.signal });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  controller.abort();
});

test("scanner promptly aborts in progress and stops scheduling new I/O", async () => {
  const root = path.resolve("virtual-mid-abort");
  const controller = new AbortController();
  let statsStarted = 0;
  let releaseStats;
  const statsGate = new Promise((resolve) => { releaseStats = resolve; });
  const io = {
    readFile: noIgnoreFile,
    readdir: async () => Array.from({ length: 12 }, (_, index) => dirent(`${index}.java`, "file")),
    stat: async () => {
      statsStarted += 1;
      if (statsStarted === 2) controller.abort();
      await statsGate;
      return { size: 1, mtimeMs: 1 };
    },
  };

  const aborted = new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
  const scan = scanProject(root, { io, signal: controller.signal, scanConcurrency: 2 });
  await aborted;
  const outcome = await scan.then(
    () => ({ status: "resolved" }),
    (error) => ({ status: "rejected", error }),
  );

  assert.equal(outcome.status, "rejected");
  assert.equal(outcome.error.name, "AbortError");
  assert.equal(statsStarted, 2);
  releaseStats();
  await nextTurn();
  assert.equal(statsStarted, 2);
});

test("scanner never reads source contents and leaves NUL detection to parsing", async () => {
  const root = path.resolve("virtual-metadata-only-scan");
  const reads = [];
  const io = {
    readFile: async (absolutePath) => {
      reads.push(relativeTo(root, absolutePath));
      if (path.basename(absolutePath) === ".legacy-code-atlasignore") throw errorWithCode("ENOENT");
      return Buffer.from("class Binary {\0}\n");
    },
    readdir: async () => [dirent("Binary.java", "file"), dirent("Source.java", "file")],
    stat: async () => ({ size: 18, mtimeMs: 2 }),
  };

  const result = await scanProject(root, { io });

  assert.deepEqual(reads, [".legacy-code-atlasignore"]);
  assert.deepEqual(result.files.map((file) => file.path), ["Binary.java", "Source.java"]);
  assert.equal(result.skipped.some((entry) => entry.reason === "binary-file"), false);
});
