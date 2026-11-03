import assert from "node:assert/strict";
import test from "node:test";

import { compareLocale, compareText } from "../src/compare.mjs";

test("compareText is code-point order and compareLocale is English locale order", () => {
  // Code-point order puts uppercase before lowercase; English locale order
  // compares letters primarily without case, so the two must not be merged.
  assert.ok(compareText("Z", "a") < 0);
  assert.ok(compareLocale("Z", "a") > 0);
  assert.ok(compareText("a", "b") < 0);
  assert.ok(compareLocale("a", "b") < 0);
  assert.equal(compareText("a", "a"), 0);
  assert.equal(compareLocale("a", "a"), 0);
});
