import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createEvidenceLocator, evidenceAt } from "../src/evidence.mjs";
import { extractJavaScriptRequests } from "../src/parsers/jsp.mjs";
import { findXmlElements } from "../src/parsers/xml-utils.mjs";

function legacyEvidenceAt(content, filePath, offset) {
  const prefix = content.slice(0, offset);
  const line = prefix.split("\n").length;
  const lastNewline = prefix.lastIndexOf("\n");
  const column = offset - lastNewline;
  const lineStart = lastNewline + 1;
  const nextNewline = content.indexOf("\n", offset);
  const lineEnd = nextNewline === -1 ? content.length : nextNewline;
  return {
    file: String(filePath).replaceAll("\\", "/").replace(/^\.\//, ""),
    line,
    column,
    snippet: String(content.slice(lineStart, lineEnd)).trim(),
  };
}

function assertMatchesLegacy(content, offsets) {
  const filePath = ".\\legacy\\Evidence.java";
  const locator = createEvidenceLocator(content, filePath);

  for (const offset of offsets) {
    for (const length of [0, 1, 17]) {
      const expected = legacyEvidenceAt(content, filePath, offset, length);
      assert.deepEqual(
        locator.at(offset, length),
        expected,
        `locator offset ${offset}, length ${length}`,
      );
      assert.deepEqual(
        evidenceAt(content, filePath, offset, length),
        expected,
        `wrapper offset ${offset}, length ${length}`,
      );
    }
  }
}

test("evidence locator preserves legacy LF boundaries for unordered offsets", () => {
  const content = "first\n\nthird\n";

  assertMatchesLegacy(content, [7, 0, 5, content.length, 6, 12, 1, content.length + 3]);
});

test("evidence locator preserves legacy CRLF line, column, and snippet behavior", () => {
  const content = "one\r\n\r\ntwo";

  assertMatchesLegacy(content, [8, 4, 0, content.length, 5, 6, 3]);
});

test("offsetAt reverses evidence line and column at first character, line boundaries, empty lines, and EOF", () => {
  const content = "first\n\nthird\n";
  const locator = createEvidenceLocator(content, "Evidence.java");

  for (const offset of [0, 5, 6, 7, 12, content.length]) {
    const evidence = locator.at(offset, 99);
    assert.equal(locator.offsetAt(evidence.line, evidence.column), offset);
  }
});

test("offsetAt treats CR as a column character and LF as the line boundary", () => {
  const content = "one\r\nnext";
  const locator = createEvidenceLocator(content, "Evidence.java");

  assert.equal(locator.offsetAt(1, 1), 0);
  assert.equal(locator.offsetAt(1, 5), 4);
  assert.equal(locator.offsetAt(2, 1), 5);
  assert.equal(locator.offsetAt(2, 5), content.length);
});

test("offsetAt accepts the only source position in an empty file", () => {
  const locator = createEvidenceLocator("", "Empty.java");

  assert.equal(locator.offsetAt(1, 1), 0);
});

test("offsetAt rejects lines and columns beyond LF, CRLF, empty-line, and EOF boundaries", () => {
  const lfLocator = createEvidenceLocator("a\n\nbc", "Lf.java");
  const crlfLocator = createEvidenceLocator("a\r\nb", "Crlf.java");
  const emptyLocator = createEvidenceLocator("", "Empty.java");

  assert.throws(() => lfLocator.offsetAt(4, 1), RangeError);
  assert.throws(() => lfLocator.offsetAt(1, 3), RangeError);
  assert.throws(() => lfLocator.offsetAt(2, 2), RangeError);
  assert.throws(() => lfLocator.offsetAt(3, 4), RangeError);
  assert.throws(() => crlfLocator.offsetAt(1, 4), RangeError);
  assert.throws(() => crlfLocator.offsetAt(2, 3), RangeError);
  assert.throws(() => emptyLocator.offsetAt(1, 2), RangeError);
});

test("optional locator consumers reject a locator bound to a different source", () => {
  const xmlContent = "<bean id='right'/>";
  const scriptContent = "fetch('/right.do')";
  const xmlLocator = createEvidenceLocator(xmlContent, "config.xml");
  const scriptLocator = createEvidenceLocator(scriptContent, "app.js");

  assert.throws(
    () => findXmlElements("<bean id='wrong'/>", "bean", "config.xml", xmlLocator),
    TypeError,
  );
  assert.throws(
    () => extractJavaScriptRequests("fetch('/wrong.do')", "app.js", "", scriptLocator),
    TypeError,
  );
});

test("optional locator consumers reject a locator bound to a different normalized file", () => {
  const xmlContent = "<bean id='right'/>";
  const scriptContent = "fetch('/right.do')";
  const xmlLocator = createEvidenceLocator(xmlContent, ".\\WEB-INF\\config.xml");
  const scriptLocator = createEvidenceLocator(scriptContent, ".\\web\\app.js");

  assert.doesNotThrow(() => xmlLocator.assertSource(xmlContent, "WEB-INF/config.xml"));
  assert.equal(findXmlElements(xmlContent, "bean", "WEB-INF/config.xml", xmlLocator).length, 1);
  assert.equal(extractJavaScriptRequests(scriptContent, "web/app.js", "", scriptLocator).length, 1);
  assert.throws(
    () => findXmlElements(xmlContent, "bean", "WEB-INF/other.xml", xmlLocator),
    TypeError,
  );
  assert.throws(
    () => extractJavaScriptRequests(scriptContent, "web/other.js", "", scriptLocator),
    TypeError,
  );
});

test("parser source structure reuses one locator per top-level source", async () => {
  const [javaSource, jspSource, xmlSource, webConfigSource, ibatisSource] = await Promise.all([
    "java.mjs",
    "jsp.mjs",
    "xml-utils.mjs",
    "web-config.mjs",
    "ibatis.mjs",
  ].map((fileName) => readFile(new URL(`../src/parsers/${fileName}`, import.meta.url), "utf8")));
  const occurrenceCount = (source, value) => source.split(value).length - 1;

  assert.equal(occurrenceCount(javaSource, "createEvidenceLocator(content, filePath)"), 1);
  assert.match(javaSource, /const locator = createEvidenceLocator\(content, filePath\);/);

  assert.equal(occurrenceCount(jspSource, "createEvidenceLocator(content, filePath)"), 2);
  assert.match(jspSource, /locator = createEvidenceLocator\(content, filePath\)/);
  assert.match(jspSource, /const locator = createEvidenceLocator\(content, filePath\);/);
  assert.match(jspSource, /extractJavaScriptRequests\(content, filePath, pageWebPath, locator\)/);

  assert.match(xmlSource, /findXmlElements\(content, tagName, filePath, locator = createEvidenceLocator\(content, filePath\)\)/);
  assert.equal(occurrenceCount(webConfigSource, "createEvidenceLocator(source, filePath)"), 1);
  assert.match(webConfigSource, /function webConfigContext\(content, filePath, context(?: = \{\})?\)/);
  assert.equal(occurrenceCount(webConfigSource, "webConfigContext(content, filePath, context)"), 5);
  assert.match(webConfigSource, /findXmlElements\(source, "servlet", filePath, locator\)/);
  assert.match(webConfigSource, /findXmlElements\(source, "servlet-mapping", filePath, locator\)/);
  assert.match(webConfigSource, /findXmlElements\(source, "action", filePath, locator\)/);
  assert.match(webConfigSource, /findXmlElements\(source, "bean", filePath, locator\)/);

  assert.equal(occurrenceCount(ibatisSource, "createEvidenceLocator(source, filePath)"), 1);
  assert.match(ibatisSource, /const locator = createEvidenceLocator\(source, filePath\);/);
  assert.match(ibatisSource, /findXmlElements\(source, "sql", filePath, locator\)/);
  assert.match(ibatisSource, /findXmlElements\(source, type, filePath, locator\)/);
});
