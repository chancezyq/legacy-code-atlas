import assert from "node:assert/strict";
import test from "node:test";

import { createFileBatches } from "../src/batches.mjs";

const MiB = 1024 * 1024;

function source(relativePath, language, size, overrides = {}) {
  return {
    path: relativePath,
    absolutePath: `/private/company/legacy/${relativePath}`,
    language,
    category: language === "xml" ? "config" : "code",
    size,
    mtimeMs: 100,
    ...overrides,
  };
}

function batchShape(result) {
  return result.batches.map((batch) => ({
    parserKind: batch.parserKind,
    totalBytes: batch.totalBytes,
    paths: batch.files.map((file) => file.path),
  }));
}

test("createFileBatches groups parsers and packs size-desc/path-asc files deterministically", () => {
  const files = [
    source("src/z.java", "java", 40),
    source("web/view.jsp", "jsp", 7),
    source("src/b.java", "java", 50),
    source("config/sql-map.xml", "xml", 9),
    source("src/a.java", "java", 50),
    source("src/c.java", "java", 30),
  ];

  const forward = createFileBatches(files, { targetBytes: 100, maxFiles: 2 });
  const reversed = createFileBatches([...files].reverse(), { targetBytes: 100, maxFiles: 2 });

  assert.deepEqual(batchShape(forward), [
    { parserKind: "java", totalBytes: 100, paths: ["src/a.java", "src/b.java"] },
    { parserKind: "java", totalBytes: 70, paths: ["src/z.java", "src/c.java"] },
    { parserKind: "jsp", totalBytes: 7, paths: ["web/view.jsp"] },
    { parserKind: "xml", totalBytes: 9, paths: ["config/sql-map.xml"] },
  ]);
  assert.deepEqual(reversed, forward);
});

test("createFileBatches keeps metadata separate and orders it by canonical relative path", () => {
  const result = createFileBatches([
    source("docs/z.txt", "text", 2, { category: "docs" }),
    source("src/App.java", "java", 3),
    source("docs/a.md", "markdown", 1, { category: "docs" }),
    source("assets/logo.png", "unknown", 4),
  ]);

  assert.deepEqual(result.metadata.map((file) => file.path), ["docs/a.md", "docs/z.txt"]);
  assert.deepEqual(batchShape(result), [
    { parserKind: "java", totalBytes: 3, paths: ["src/App.java"] },
  ]);
});

test("createFileBatches applies the 8 MiB target and 128-file defaults", () => {
  const files = [
    source("src/large.java", "java", 5 * MiB),
    source("src/medium.java", "java", 4 * MiB),
    ...Array.from({ length: 129 }, (_, index) => source(
      `web/view-${String(index).padStart(3, "0")}.jsp`,
      "jsp",
      0,
    )),
  ];

  const result = createFileBatches(files);
  const javaBatches = result.batches.filter((batch) => batch.parserKind === "java");
  const jspBatches = result.batches.filter((batch) => batch.parserKind === "jsp");

  assert.deepEqual(javaBatches.map((batch) => batch.totalBytes), [5 * MiB, 4 * MiB]);
  assert.deepEqual(jspBatches.map((batch) => batch.files.length), [128, 1]);
});

test("createFileBatches lets one oversized source occupy a batch by itself", () => {
  const result = createFileBatches([
    source("src/oversized.java", "java", 101),
    source("src/small.java", "java", 2),
  ], { targetBytes: 100, maxFiles: 128 });

  assert.deepEqual(batchShape(result), [
    { parserKind: "java", totalBytes: 101, paths: ["src/oversized.java"] },
    { parserKind: "java", totalBytes: 2, paths: ["src/small.java"] },
  ]);
});

test("batch IDs are canonical SHA-256 descriptors without machine or timing inputs", () => {
  const portable = [
    source("src/A.java", "java", 10),
    source("src/B.java", "java", 9),
  ];
  const anotherMachine = portable.map((file) => ({
    ...file,
    absolutePath: `C:\\company\\legacy\\${file.path.replaceAll("/", "\\")}`,
    mtimeMs: 999_999,
  }));

  const first = createFileBatches(portable, { targetBytes: 100 }).batches[0];
  const second = createFileBatches(anotherMachine, { targetBytes: 100 }).batches[0];
  const changed = createFileBatches([
    { ...portable[0], size: 11 },
    portable[1],
  ], { targetBytes: 100 }).batches[0];

  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(second.id, first.id);
  assert.notEqual(changed.id, first.id);
  assert.equal(first.id.includes("private"), false);
  assert.equal(first.id.includes("company"), false);
});

test("createFileBatches validates positive safe integer limits", () => {
  for (const option of ["targetBytes", "maxFiles"]) {
    for (const value of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1", 1n]) {
      assert.throws(
        () => createFileBatches([], { [option]: value }),
        new RegExp(`${option} must be a positive safe integer`),
      );
    }
  }
});

test("createFileBatches rejects duplicate canonical paths before grouping independent of input order", () => {
  const files = [
    source("src/a/../Shared.java", "java", 10),
    source("src/Shared.java", "java", 9),
    source("docs/z/../README.md", "markdown", 2, { category: "docs" }),
    source("docs/README.md", "markdown", 1, { category: "docs" }),
  ];
  const capture = (input) => {
    try {
      createFileBatches(input);
      assert.fail("expected duplicate canonical path rejection");
    } catch (error) {
      return { name: error.name, message: error.message };
    }
  };

  const forward = capture(files);
  const reversed = capture([...files].reverse());
  assert.deepEqual(forward, reversed);
  assert.deepEqual(forward, {
    name: "TypeError",
    message: "duplicate canonical relative path: docs/README.md",
  });
});

test("createFileBatches rejects NUL paths and coerced or unsafe file sizes", () => {
  assert.throws(
    () => createFileBatches([source("src/NUL\0.java", "java", 1)]),
    /relative path/i,
  );
  for (const size of ["1", 1.5, -1, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1n]) {
    assert.throws(
      () => createFileBatches([source("src/App.java", "java", size)]),
      /non-negative safe integer/i,
    );
  }
});
