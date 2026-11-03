import assert from "node:assert/strict";
import test from "node:test";

import { parseProperties } from "../src/parsers/properties.mjs";
import { containsUnsafeTextControl } from "../src/text-safety.mjs";

test("properties parser extracts bounded message entries with source evidence", () => {
  const result = parseProperties([
    "# audit validation messages",
    "error.audit.expired=Audit request has expired",
    "message.error.attachment.maxSize = File exceeds configured size",
    "lookup.audit.owner:Submitted by owner",
    "continued.value = first\\",
    "  second",
    "",
  ].join("\n"), "WEB-INF/classes/ApplicationResources.properties");

  assert.deepEqual(result.entries.map(({ key, value }) => [key, value]), [
    ["error.audit.expired", "Audit request has expired"],
    ["message.error.attachment.maxSize", "File exceeds configured size"],
    ["lookup.audit.owner", "Submitted by owner"],
    ["continued.value", "firstsecond"],
  ]);
  assert.equal(result.entries[0].evidence.file, "WEB-INF/classes/ApplicationResources.properties");
  assert.equal(result.entries[0].evidence.line, 2);
  assert.equal(result.entries[1].evidence.line, 3);
  assert.deepEqual(result.warnings, []);
});

test("properties parser decodes Java escapes without executing substitutions", () => {
  const result = parseProperties([
    "label.name=Audit\\ Name",
    "label.code=A\\u0055\\u0044\\u0049\\u0054",
    "dynamic=${external.value}",
  ].join("\n"), "messages.properties");

  assert.deepEqual(result.entries.map(({ key, value }) => [key, value]), [
    ["label.name", "Audit Name"],
    ["label.code", "AUDIT"],
    ["dynamic", "${external.value}"],
  ]);
});

test("properties parser preserves evidence lines and snippets for CRLF files", () => {
  const result = parseProperties(
    "# heading\r\nfirst.value=One\r\nsecond.value=Two\r\n",
    "WEB-INF/classes/messages.properties",
  );

  assert.deepEqual(result.entries.map(({ evidence }) => [evidence.line, evidence.snippet]), [
    [2, "first.value=One"],
    [3, "second.value=Two"],
  ]);
});

test("properties parser preserves evidence lines for bare carriage returns", () => {
  const result = parseProperties("first=One\rsecond=Two\rthird=Three", "legacy.properties");
  assert.deepEqual(result.entries.map(({ evidence }) => evidence.line), [1, 2, 3]);
});

test("properties parser replaces control characters instead of failing validation", () => {
  const result = parseProperties([
    "greeting=hello\\nworld",
    "bell=ring\\u0007bell",
    "separator=a\\u2028b",
    "tabbed=a\tb",
    "\\u0001=key with only a control character",
  ].join("\n"), "src/internet/app.properties");

  assert.deepEqual(result.entries.map(({ key, value }) => [key, value]), [
    ["greeting", "hello world"],
    ["bell", "ring bell"],
    ["separator", "a b"],
    ["tabbed", "a b"],
  ]);
  for (const entry of result.entries) {
    assert.equal(containsUnsafeTextControl(entry.key), false);
    assert.equal(containsUnsafeTextControl(entry.value), false);
    assert.equal(containsUnsafeTextControl(entry.evidence.snippet), false);
  }
  assert.equal(result.entries[3].evidence.snippet, "tabbed=a b");
  assert.deepEqual(result.warnings, [
    "properties control characters replaced in src/internet/app.properties (4 entries)",
    "properties entries omitted in src/internet/app.properties because the key became empty after control-character replacement (1 entries)",
  ]);
});
