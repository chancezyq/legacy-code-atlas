import assert from "node:assert/strict";
import test from "node:test";

import { assertMinimumSpeedup, median, speedupRatio } from "../benchmark/benchmark.mjs";

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
