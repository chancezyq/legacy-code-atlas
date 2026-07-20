import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import {
  FACT_SCHEMA,
  PARSER_VERSIONS,
  metadataFact,
  parseFileBuffer,
  parserKindFor,
} from "../src/file-facts.mjs";

function sourceFile(relativePath, language, category = "code", size = 0) {
  return {
    path: relativePath,
    absolutePath: path.resolve("/private/company/legacy-project", relativePath),
    language,
    category,
    size,
  };
}

function assertJsonSafe(value, forbiddenText = []) {
  const seen = new Set();
  function visit(current) {
    if (current === null || ["string", "boolean"].includes(typeof current)) return;
    if (typeof current === "number") {
      assert.equal(Number.isFinite(current), true);
      return;
    }
    assert.notEqual(typeof current, "undefined");
    assert.notEqual(typeof current, "function");
    assert.equal(Buffer.isBuffer(current), false);
    assert.equal(current instanceof Map, false);
    assert.equal(current instanceof Set, false);
    assert.equal(Array.isArray(current) || Object.getPrototypeOf(current) === Object.prototype, true);
    if (seen.has(current)) assert.fail("fact contains a cycle");
    seen.add(current);
    for (const nested of Object.values(current)) visit(nested);
    seen.delete(current);
  }

  visit(value);
  const serialized = JSON.stringify(value);
  for (const text of forbiddenText) assert.equal(serialized.includes(text), false, `fact leaked ${text}`);
  assert.deepEqual(JSON.parse(serialized), value);
  assert.deepEqual(structuredClone(value), value);
}

test("parserKindFor selects explicit versioned parsers and scanner-compatible metadata", () => {
  assert.equal(typeof FACT_SCHEMA, "string");
  assert.match(FACT_SCHEMA, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(
    ["java", "jsp", "javascript", "xml"].map((language) => parserKindFor(sourceFile(`source.${language}`, language))),
    ["java", "jsp", "javascript", "xml"],
  );
  for (const language of ["html", "properties", "markdown", "text"]) {
    assert.equal(parserKindFor(sourceFile(`source.${language}`, language)), "metadata");
  }
  assert.equal(parserKindFor(sourceFile("image.png", "unknown")), null);
  assert.deepEqual(Object.keys(PARSER_VERSIONS).sort(), ["java", "javascript", "jsp", "metadata", "sql", "xml"]);
  assert.equal(PARSER_VERSIONS.java, "1.4.2");
  assert.equal(PARSER_VERSIONS.jsp, "1.2.0");
  assert.equal(PARSER_VERSIONS.xml, "1.3.4");
  assert.equal(PARSER_VERSIONS.sql, "1.0.0");
  for (const version of Object.values(PARSER_VERSIONS)) assert.match(version, /^\d+\.\d+\.\d+$/);
});

test("parseFileBuffer emits Java, JSP, JavaScript, SQL, and XML parser facts", () => {
  const java = parseFileBuffer(
    sourceFile("src/com/acme/OrderAction.java", "java"),
    Buffer.from("package com.acme; public class OrderAction { public void execute() {} }\n"),
  );
  assert.equal(java.parserKind, "java");
  assert.equal(java.parserVersion, PARSER_VERSIONS.java);
  assert.equal(java.facts.types[0].fullName, "com.acme.OrderAction");

  const jsp = parseFileBuffer(
    sourceFile("web/order.jsp", "jsp", "markup"),
    Buffer.from("<form action='/order.do' method='post'><input name='id' value='42'></form>"),
  );
  assert.equal(jsp.facts.requests[0].url, "/order.do");
  assert.deepEqual(jsp.facts.requests[0].parameters, { id: "42" });

  const javascript = parseFileBuffer(
    sourceFile("web/order.js", "javascript"),
    Buffer.from("fetch('/order/status.do');\n"),
  );
  assert.equal(javascript.facts.requests[0].url, "/order/status.do");

  const sql = parseFileBuffer(
    sourceFile("db/procedures/order.sql", "sql", "database"),
    Buffer.from("CREATE PROCEDURE dbo.usp_OrderAudit @OrderId int AS SELECT * FROM dbo.T_ORDER\nGO\n"),
  );
  assert.equal(sql.parserKind, "sql");
  assert.equal(sql.parserVersion, PARSER_VERSIONS.sql);
  assert.equal(sql.facts.procedures[0].fullName, "dbo.usp_orderaudit");

  const xml = parseFileBuffer(
    sourceFile("WEB-INF/all.xml", "xml", "config"),
    Buffer.from([
      "<sqlMap namespace='orders'><select id='find'>SELECT * FROM dbo.t_order</select></sqlMap>",
      "<web-app><servlet><servlet-name>api</servlet-name><servlet-class>com.acme.Api</servlet-class></servlet><servlet-mapping><servlet-name>api</servlet-name><url-pattern>/api/*</url-pattern></servlet-mapping></web-app>",
      "<struts-config><action path='/order' type='com.acme.OrderAction'/></struts-config>",
      "<struts><package namespace='/order'><action name='save' class='com.acme.OrderAction'/></package></struts>",
      "<tiles-definitions><definition name='order.page' template='/layout.jsp'><put name='body' value='/order.jsp'/></definition></tiles-definitions>",
      "<beans><bean id='controller' class='com.acme.Controller'/></beans>",
    ].join("\n")),
  );
  assert.equal(xml.parserKind, "xml");
  assert.equal(xml.facts.ibatis.statements[0].fullId, "orders.find");
  assert.equal(xml.facts.web.routes[0].targetClass, "com.acme.Api");
  assert.equal(xml.facts.struts.actions[0].type, "com.acme.OrderAction");
  assert.equal(xml.facts.struts2.actions[0].url, "/order/save.action");
  assert.equal(xml.facts.tiles.definitions[0].template, "/layout.jsp");
  assert.equal(xml.facts.spring.beans[0].id, "controller");

  for (const record of [java, jsp, javascript, xml]) {
    assert.equal(record.factSchema, FACT_SCHEMA);
    assert.equal(record.status, "parsed");
    assertJsonSafe(record, ["/private/company/legacy-project"]);
  }
});

test("XML parser does not treat sqlMapConfig resource entries as SQL maps", () => {
  const record = parseFileBuffer(
    sourceFile("WEB-INF/sql-map-config.xml", "xml", "config"),
    Buffer.from([
      "<sqlMapConfig>",
      "  <sqlMap resource='com/acme/Order.xml'/>",
      "</sqlMapConfig>",
    ].join("\n")),
  );

  assert.equal(record.facts.ibatis, null);
  assert.deepEqual(record.warnings, []);
});

test("metadataFact needs no Buffer and omits absolute source paths", () => {
  const record = metadataFact(sourceFile("docs\\README.md", "markdown", "docs", 123));

  assert.deepEqual(record, {
    factSchema: FACT_SCHEMA,
    relativePath: "docs/README.md",
    language: "markdown",
    category: "docs",
    size: 123,
    parserKind: "metadata",
    parserVersion: PARSER_VERSIONS.metadata,
    status: "metadata",
    facts: {},
    warnings: [],
    diagnostics: [],
  });
  assertJsonSafe(record, ["/private/company/legacy-project"]);
});

test("per-file paths are canonical relative paths and cannot escape the project", () => {
  assert.equal(metadataFact(sourceFile("src\\main\\App.java", "markdown")).relativePath, "src/main/App.java");
  for (const candidate of ["../secret.java", "src/../../secret.java", "/etc/passwd", "C:secret.java", "C:\\secret.java", "\\\\server\\share\\secret.java", ""] ) {
    assert.throws(() => metadataFact(sourceFile(candidate, "markdown")), /relative path/i);
  }
});

test("parseFileBuffer detects NUL from the supplied Buffer without retaining it", () => {
  const buffer = Buffer.from([99, 108, 97, 115, 115, 0, 123, 125]);
  const record = parseFileBuffer(sourceFile("src/Binary.java", "java", "code", buffer.length), buffer);

  assert.equal(record.status, "binary");
  assert.equal(record.facts, null);
  assert.equal(record.diagnostics[0].code, "binary-file");
  assertJsonSafe(record);
});

test("parseFileBuffer isolates parser exceptions as serializable diagnostics", () => {
  const record = parseFileBuffer(
    sourceFile("src/Broken.java", "java"),
    Buffer.from("class Broken {}"),
    {
      parsers: {
        java() {
          const error = new Error("synthetic parser failure");
          error.code = "SYNTHETIC";
          throw error;
        },
      },
    },
  );

  assert.equal(record.status, "error");
  assert.equal(record.facts, null);
  assert.deepEqual(record.error, { name: "Error", message: "synthetic parser failure", code: "SYNTHETIC" });
  assert.equal(record.diagnostics[0].relativePath, "src/Broken.java");
  assertJsonSafe(record, [process.cwd(), "/private/company/legacy-project"]);
});

test("parseFileBuffer isolates thrown values whose error fields cannot be read", () => {
  const thrownValues = [
    Object.defineProperty({}, "message", { get() { throw new Error("getter escaped"); } }),
    { toString() { throw new Error("toString escaped"); } },
  ];

  for (const thrown of thrownValues) {
    const record = parseFileBuffer(
      sourceFile("src/Broken.java", "java"),
      Buffer.from("class Broken {}"),
      { parsers: { java: () => { throw thrown; } } },
    );

    assert.equal(record.status, "error");
    assert.deepEqual(record.error, { name: "Error", message: "parser failed" });
    assert.equal(record.diagnostics[0].message, "parser failed");
    assertJsonSafe(record);
  }
});

test("parseFileBuffer redacts machine-specific absolute paths from parser diagnostics", () => {
  const parseWithMessage = (message) => parseFileBuffer(
    sourceFile("src/Broken.java", "java"),
    Buffer.from("class Broken {}"),
    {
      parsers: {
        java() {
          const error = new Error(message);
          error.code = "SYNTHETIC_PATH_FAILURE";
          throw error;
        },
      },
    },
  );

  const posix = parseWithMessage(
    "failure at /private/company/legacy-project/src/Broken.java: malformed declaration",
  );
  const posixWithoutWhitespace = parseWithMessage(
    "failure:/private/company/legacy-project/src/Broken.java: malformed declaration",
  );
  const windows = parseWithMessage(
    "failure at C:\\company\\legacy-project\\src\\Broken.java: malformed declaration",
  );
  const windowsRooted = parseWithMessage(
    "failure at \\company\\legacy-project\\src\\Broken.java: malformed declaration",
  );
  const windowsFileUrl = parseWithMessage(
    "failure at file:///C:/company/legacy-project/src/Broken.java: malformed declaration",
  );

  for (const record of [posix, windows, windowsRooted, windowsFileUrl]) {
    assert.equal(record.error.name, "Error");
    assert.equal(record.error.code, "SYNTHETIC_PATH_FAILURE");
    assert.equal(record.error.message, "failure at <absolute-path>: malformed declaration");
    assert.equal(record.diagnostics[0].message, record.error.message);
    assertJsonSafe(record, [
      "/private/company/legacy-project",
      "C:\\company\\legacy-project",
    ]);
  }
  assert.equal(posixWithoutWhitespace.error.message, "failure:<absolute-path>: malformed declaration");
  assert.equal(posixWithoutWhitespace.diagnostics[0].message, posixWithoutWhitespace.error.message);
  assert.equal(posix.error.message, windows.error.message);
  assert.equal(posix.error.message, windowsRooted.error.message);
  assert.equal(posix.error.message, windowsFileUrl.error.message);
});

test("parseFileBuffer isolates a parser that returns non-JSON fact values", () => {
  const record = parseFileBuffer(
    sourceFile("src/Unsafe.java", "java"),
    Buffer.from("class Unsafe {}"),
    { parsers: { java: () => ({ index: new Map([["Unsafe", 1]]) }) } },
  );

  assert.equal(record.status, "error");
  assert.equal(record.diagnostics[0].code, "parser-error");
  assert.match(record.error.message, /JSON-safe/i);
  assertJsonSafe(record);
});

test("parseFileBuffer isolates JSON values that change during serialization", () => {
  for (const facts of [{ values: [, 1] }, { value: -0 }]) {
    const record = parseFileBuffer(
      sourceFile("src/Unsafe.java", "java"),
      Buffer.from("class Unsafe {}"),
      { parsers: { java: () => facts } },
    );

    assert.equal(record.status, "error");
    assert.equal(record.diagnostics[0].code, "parser-error");
    assert.match(record.error.message, /JSON-safe/i);
    assertJsonSafe(record);
  }
});

test("parseFileBuffer redacts the known source path even when it contains spaces", () => {
  for (const absolutePath of [
    "/private/company/legacy project/src/Broken.java",
    "C:\\company\\legacy project\\src\\Broken.java",
  ]) {
    const file = sourceFile("src/Broken.java", "java");
    file.absolutePath = absolutePath;
    const record = parseFileBuffer(
      file,
      Buffer.from("class Broken {}"),
      { parsers: { java: () => { throw new Error(`failure at ${absolutePath}: malformed declaration`); } } },
    );

    assert.equal(record.error.message, "failure at <absolute-path>: malformed declaration");
    assert.equal(record.diagnostics[0].message, record.error.message);
    assertJsonSafe(record, [absolutePath]);
  }
});

test("metadataFact rejects invalid sizes and keeps JSON round-trip and structured-clone stability", () => {
  for (const size of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1]) {
    assert.throws(
      () => metadataFact(sourceFile("docs/README.md", "markdown", "docs", size)),
      { name: "TypeError" },
    );
  }

  const record = metadataFact(sourceFile("docs/README.md", "markdown", "docs", -0));
  assert.equal(Object.is(record.size, -0), false);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
  assert.deepEqual(structuredClone(record), record);
});
