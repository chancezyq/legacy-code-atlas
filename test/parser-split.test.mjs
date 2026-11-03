import assert from "node:assert/strict";
import test from "node:test";

import {
  extractJavaScriptRequests as extractFromJsp,
  normalizeRequestUrl as normalizeFromJsp,
} from "../src/parsers/jsp.mjs";
import { extractJavaScriptRequests } from "../src/parsers/javascript-requests.mjs";
import { normalizeRequestUrl } from "../src/parsers/request-target.mjs";
import { maskedSource, sourceWithinRanges } from "../src/parsers/source-masking.mjs";

test("parser split preserves the public JSP parser API by re-export", () => {
  // The split must not fork behavior: the JSP parser re-exports the exact
  // same functions as the new modules, so a fix in one place reaches all.
  assert.equal(extractFromJsp, extractJavaScriptRequests);
  assert.equal(normalizeFromJsp, normalizeRequestUrl);
  assert.equal(normalizeRequestUrl("order/list.do?a=1", "/app/"), "/app/order/list.do");
  assert.equal(normalizeRequestUrl("/order/list.do?a=1", "/app"), "/order/list.do");
  assert.equal(normalizeRequestUrl("https://example.com/x.do", "/app"), "");
});

test("source masking preserves offsets while blanking ranges", () => {
  assert.equal(maskedSource("abcdef", [[2, 4]]), "ab  ef");
  assert.equal(maskedSource("abcdef", []), "abcdef");
  assert.equal(sourceWithinRanges("abcdef", [[2, 4]]), "  cd  ");
  assert.equal(maskedSource("a\nb\nc", [[2, 3]]), "a\n \nc");
});
