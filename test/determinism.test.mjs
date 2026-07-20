import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeProject, analyzeProjectDetailed } from "../src/analyzer.mjs";
import { serializeGraph } from "../src/graph.mjs";
import { processFileBatches } from "../src/worker-pool.mjs";

const projectRoot = path.resolve(fileURLToPath(new URL("./fixtures/legacy-shop", import.meta.url)));

test("workers 1, 2, and 8 serialize the complete Graph to identical bytes", async () => {
  const serialized = await Promise.all(
    [1, 2, 8].map(async (workers) => serializeGraph(await analyzeProject(projectRoot, { workers }))),
  );
  assert.equal(serialized[1], serialized[0]);
  assert.equal(serialized[2], serialized[0]);
});

test("reversed file-processing completion cannot change serialized Graph bytes", async () => {
  const expected = serializeGraph(await analyzeProject(projectRoot, { workers: 2 }));
  const detailed = await analyzeProjectDetailed(projectRoot, {
    workers: 2,
    dependencies: {
      async processFileBatches(plan, options) {
        return (await processFileBatches(plan, options)).reverse();
      },
    },
  });

  assert.equal(serializeGraph(detailed.graph), expected);
  assert.equal(Object.hasOwn(detailed.graph, "diagnostics"), false);
  assert.equal(Object.hasOwn(detailed.graph, "timings"), false);
  assert.equal(Object.hasOwn(detailed.graph, "stats"), false);
});

test("ten repeated parallel analyses serialize byte-identically", async () => {
  let expected;
  for (let run = 0; run < 10; run += 1) {
    const serialized = serializeGraph(await analyzeProject(projectRoot, { workers: 2 }));
    expected ??= serialized;
    assert.equal(serialized, expected, `run ${run + 1} changed serialized Graph bytes`);
  }
});
