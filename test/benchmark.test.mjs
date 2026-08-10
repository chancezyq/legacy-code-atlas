import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMinimumSpeedup,
  median,
  normalizedBenchmarkCandidate,
  runBenchmark,
  speedupRatio,
} from "../benchmark/benchmark.mjs";

test("benchmark median is stable for odd and even samples", () => {
  assert.equal(median([9, 1, 5]), 5);
  assert.equal(median([8, 2, 4, 6]), 5);
  assert.throws(() => median([]), /sample/);
  assert.throws(() => median([1, Number.NaN]), /finite/);
});

test("benchmark enforces a minimum candidate speedup", () => {
  assert.equal(speedupRatio([12, 15, 18], [4, 5, 6]), 3);
  assert.doesNotThrow(() => assertMinimumSpeedup([12, 15, 18], [4, 5, 6], 3));
  assert.throws(
    () => assertMinimumSpeedup([12, 15, 18], [6, 7, 8], 3),
    /at least 3\.00x/,
  );
});

test("benchmark accepts current empty page detail fields as frozen-baseline equivalent", async () => {
  const result = await runBenchmark({ fileCount: 1, samples: 1, minimumSpeedup: 0.01 });

  assert.equal(result.fileCount, 1);
  assert.equal(result.samples, 1);
});

test("benchmark normalization preserves non-empty page detail evidence", () => {
  const graph = {
    nodes: [
      { id: "page:empty", type: "page", data: { fieldDetails: [] } },
      { id: "page:proven", type: "page", data: { fieldDetails: [{ name: "orderId" }] } },
      { id: "file:unexpected", type: "file", data: { fieldDetails: [] } },
    ],
  };

  const normalized = normalizedBenchmarkCandidate(graph);

  assert.equal(Object.hasOwn(normalized.nodes[0].data, "fieldDetails"), false);
  assert.deepEqual(normalized.nodes[1].data.fieldDetails, [{ name: "orderId" }]);
  assert.deepEqual(normalized.nodes[2].data.fieldDetails, [], "non-page graph changes must stay visible");
  assert.deepEqual(graph.nodes[0].data.fieldDetails, [], "normalization must not mutate the candidate graph");
});
