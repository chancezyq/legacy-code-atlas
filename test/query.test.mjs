import assert from "node:assert/strict";
import test from "node:test";

import { analyzeProject } from "../src/analyzer.mjs";
import { renderTraceMarkdown } from "../src/render.mjs";
import { parseFileBuffer } from "../src/file-facts.mjs";
import { materializeRecords } from "../src/materializer.mjs";
import { searchGraph, traceFeature, traceProcedure, traceStatement, traceTable, traceUrl } from "../src/query.mjs";

const projectRoot = new URL("./fixtures/legacy-shop", import.meta.url).pathname;

test("feature trace follows the request-to-database chain", async () => {
  const graph = await analyzeProject(projectRoot);
  const result = traceFeature(graph, "订单审核");
  const orderUpdatePath = result.paths.find((path) => path.nodes.includes("statement:order.updateStatus"));

  assert.equal(result.matches[0].id, "page:web/order/audit.jsp");
  assert.ok(orderUpdatePath);
  assert.equal(orderUpdatePath.nodes[0], "page:web/order/audit.jsp");
  assert.equal(orderUpdatePath.nodes.includes("route:/order/audit.do"), true);
  assert.equal(orderUpdatePath.nodes.at(-1), "table:dbo.t_order");
  assert.equal(orderUpdatePath.edges.includes("uses_statement"), true);
  assert.equal(result.nodes.some((node) => node.id.includes("setOrderAuditService")), false);
  assert.equal(result.nodes.some((node) => node.id === "route:/api/orders/list"), true);
});

test("URL, statement, and table traces include both downstream and upstream evidence", async () => {
  const graph = await analyzeProject(projectRoot);
  const url = traceUrl(graph, "/order/audit.do");
  const statement = traceStatement(graph, "order.updateStatus");
  const table = traceTable(graph, "dbo.t_order");

  assert.equal(url.nodes.some((node) => node.id === "table:dbo.t_order"), true);
  assert.equal(statement.nodes.some((node) => node.id.includes("IbatisOrderDao#updateStatus")), true);
  assert.equal(statement.nodes.some((node) => node.id === "table:dbo.t_order"), true);
  assert.equal(table.nodes.some((node) => node.id === "page:web/order/audit.jsp"), true);
});

test("statement and table traces do not jump through shared container files", async () => {
  const graph = await analyzeProject(projectRoot);
  const statement = traceStatement(graph, "order.updateStatus");
  const table = traceTable(graph, "dbo.t_order");

  assert.equal(statement.nodes.some((node) => node.id === "statement:order.insertAuditLog"), false);
  assert.equal(statement.nodes.some((node) => node.id === "statement:order.findForAudit"), false);
  assert.equal(table.nodes.some((node) => node.type === "file"), false);
});

test("search ranks exact identifiers above fuzzy supporting text", async () => {
  const graph = await analyzeProject(projectRoot);
  const results = searchGraph(graph, "order.updateStatus");

  assert.equal(results[0].id, "statement:order.updateStatus");
  assert.equal(results[0].score > results.at(-1).score, true);
});

test("search normalizes and tokenizes a query only once", () => {
  let conversions = 0;
  const query = {
    toString() {
      conversions += 1;
      return "OrderAudit";
    },
  };
  const graph = {
    nodes: Array.from({ length: 100 }, (_, index) => ({
      id: `java_type:OrderAudit${index}`,
      type: "java_type",
      name: `OrderAudit${index}`,
      filePath: `src/OrderAudit${index}.java`,
      searchText: [],
    })),
    edges: [],
  };

  assert.equal(searchGraph(graph, query).length, 25);
  assert.equal(conversions, 1);
});

test("dense call graphs stop at a bounded traversal state limit", () => {
  const size = 9;
  const nodes = Array.from({ length: size }, (_, index) => ({
    id: `java_method:Dense#method${index}/0`,
    type: "java_method",
    name: index === 0 ? "Dense.entry" : `Dense.method${index}`,
    filePath: `src/Dense${index}.java`,
    evidence: [],
    searchText: [],
  }));
  const edges = [];
  for (const source of nodes) {
    for (const target of nodes) {
      if (source.id === target.id) continue;
      edges.push({
        id: `calls:${source.id}->${target.id}`,
        type: "calls",
        source: source.id,
        target: target.id,
        evidence: [],
        confidence: 1,
      });
    }
  }

  const result = traceFeature({ nodes, edges, warnings: [] }, "Dense.entry");

  assert.equal(result.truncated, true);
  assert.equal(result.paths.length, 100);
  assert.equal(result.stateLimitReached, true);
  assert.equal(result.pathLimitReached, true);
  assert.match(result.warnings.join("\n"), /(?:状态|state)[^\n]*(?:上限|limit)/i);
  assert.match(result.warnings.join("\n"), /(?:路径|path)[^\n]*(?:上限|limit)/i);
});

test("duplicate state-limit frontier entries do not falsely report the path limit", () => {
  const root = {
    id: "java_method:DuplicateFrontier#entry/0",
    type: "java_method",
    name: "DuplicateFrontier.entry",
    filePath: "src/DuplicateFrontier.java",
    evidence: [],
    searchText: [],
  };
  const tables = Array.from({ length: 100 }, (_, index) => ({
    id: `table:dbo.duplicate_frontier_${index}`,
    type: "table",
    name: `dbo.duplicate_frontier_${index}`,
    filePath: "db/schema.sql",
    evidence: [],
    searchText: [],
  }));
  const uniqueEdges = tables.map((table) => ({
    id: `reads_from:${root.id}->${table.id}`,
    type: "reads_from",
    source: root.id,
    target: table.id,
    confidence: 1,
    reason: "duplicate frontier fixture",
    evidence: [],
  }));
  const edges = uniqueEdges.flatMap((edge) => Array.from({ length: 50 }, () => edge));

  const result = traceFeature({ nodes: [root, ...tables], edges, warnings: [] }, root.name);

  assert.equal(result.stateLimitReached, true);
  assert.equal(result.paths.length, 100);
  assert.equal(result.pathLimitReached, false);
  assert.doesNotMatch(result.warnings.join("\n"), /100[^\n]*(?:路径|path)|(?:路径|path)[^\n]*100/i);
});

test("truncated dense branches remain visible beside completed short paths", () => {
  const methods = Array.from({ length: 9 }, (_, index) => ({
    id: `java_method:Mixed#method${index}/0`,
    type: "java_method",
    name: index === 0 ? "Mixed.entry" : `Mixed.method${index}`,
    filePath: `src/Mixed${index}.java`,
    evidence: [],
    searchText: [],
  }));
  const table = {
    id: "table:dbo.short_result",
    type: "table",
    name: "dbo.short_result",
    filePath: "db/schema.sql",
    evidence: [],
    searchText: [],
  };
  const edges = [{
    id: `writes_to:${methods[0].id}->${table.id}`,
    type: "writes_to",
    source: methods[0].id,
    target: table.id,
    evidence: [],
    confidence: 1,
  }];
  for (const source of methods) {
    for (const target of methods) {
      if (source.id === target.id) continue;
      edges.push({
        id: `calls:${source.id}->${target.id}`,
        type: "calls",
        source: source.id,
        target: target.id,
        evidence: [],
        confidence: 1,
      });
    }
  }

  const result = traceFeature({ nodes: [...methods, table], edges, warnings: [] }, "Mixed.entry");

  assert.equal(result.truncated, true);
  assert.equal(result.paths.some((path) => path.nodes.at(-1) === table.id), true);
  assert.equal(
    result.paths.some((path) => path.truncated === true && path.nodes.includes(methods[8].id)),
    true,
  );
});

test("split traces report the per-direction state limit", () => {
  const statement = {
    id: "statement:dense.lookup",
    type: "statement",
    name: "dense.lookup",
    filePath: "sqlmap/dense.xml",
    evidence: [],
    searchText: [],
  };
  const methods = Array.from({ length: 9 }, (_, index) => ({
    id: `java_method:DenseCaller#method${index}/0`,
    type: "java_method",
    name: `DenseCaller.method${index}`,
    filePath: `src/DenseCaller${index}.java`,
    evidence: [],
    searchText: [],
  }));
  const edges = [];
  for (const source of methods) {
    edges.push({
      id: `uses_statement:${source.id}->${statement.id}`,
      type: "uses_statement",
      source: source.id,
      target: statement.id,
      evidence: [],
      confidence: 1,
    });
    for (const target of methods) {
      if (source.id === target.id) continue;
      edges.push({
        id: `calls:${source.id}->${target.id}`,
        type: "calls",
        source: source.id,
        target: target.id,
        evidence: [],
        confidence: 1,
      });
    }
  }

  const result = traceStatement({ nodes: [statement, ...methods], edges, warnings: [] }, "dense.lookup");

  assert.equal(result.truncated, true);
  assert.equal(result.stateLimit, 5_000);
  assert.match(result.warnings.join("\n"), /每个方向[^\n]*5000|5000[^\n]*每个方向/);
});

test("path-count truncation is not reported as the traversal state limit", () => {
  const root = {
    id: "java_method:Wide#entry/0",
    type: "java_method",
    name: "Wide.entry",
    filePath: "src/Wide.java",
    evidence: [],
    searchText: [],
  };
  const tables = Array.from({ length: 101 }, (_, index) => ({
    id: `table:dbo.result_${index}`,
    type: "table",
    name: `dbo.result_${index}`,
    filePath: "db/schema.sql",
    evidence: [],
    searchText: [],
  }));
  const edges = tables.map((table, index) => ({
    id: `reads_from:${root.id}->${table.id}`,
    type: "reads_from",
    source: root.id,
    target: table.id,
    confidence: 1,
    reason: "wide result",
    evidence: [{ file: "src/Wide.java", line: index + 1, column: 1, snippet: "query" }],
  }));

  const result = traceFeature({ nodes: [root, ...tables], edges, warnings: [] }, "Wide.entry");

  assert.equal(result.truncated, true);
  assert.equal(result.paths.length, 100);
  assert.equal(result.statesExpanded < result.stateLimit, true);
  assert.match(result.warnings.join("\n"), /100[^\n]*(?:路径|path)|(?:路径|path)[^\n]*100/i);
  assert.doesNotMatch(result.warnings.join("\n"), /5000[^\n]*(?:状态|state)|(?:状态|state)[^\n]*5000/i);
});

test("Markdown renderer distinguishes proven and heuristic edges and cites source lines", async () => {
  const graph = await analyzeProject(projectRoot);
  const trace = traceFeature(graph, "订单审核");
  const markdown = renderTraceMarkdown(trace, { title: "功能：订单审核" });

  assert.match(markdown, /功能：订单审核/);
  assert.match(markdown, /web\/order\/audit\.jsp:8/);
  assert.match(markdown, /确定关系/);
  assert.match(markdown, /启发式关系/);
  assert.match(markdown, /order\.updateStatus/);
});

test("Markdown renderer keeps control characters from forging output structure", () => {
  const trace = {
    mode: "feature",
    query: "OrderAudit\r\n# forged query heading\u2028# forged Unicode heading",
    matches: [{ id: "java_method:entry", type: "java_method", name: "Entry\u001b[31m", score: 1000 }],
    nodes: [
      { id: "java_method:entry", type: "java_method", name: "Entry\u001b[31m" },
      { id: "table:orders", type: "table", name: "Orders" },
    ],
    edges: [{
      id: "edge:1",
      source: "java_method:entry",
      target: "table:orders",
      type: "reads_from",
      confidence: 1,
      reason: "verified\r\n# forged reason heading\u202eTXT",
      evidence: [{ file: "src/Order.java", line: 10 }],
    }],
    paths: [{ nodes: ["java_method:entry", "table:orders"], edges: ["reads_from"], edgeIds: ["edge:1"] }],
    warnings: ["partial\r\n# forged warning heading\u2066TXT"],
  };

  const markdown = renderTraceMarkdown(trace);

  assert.doesNotMatch(markdown, /\u001b/);
  assert.doesNotMatch(markdown, /[\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
  assert.doesNotMatch(markdown, /^# forged/m);
  assert.match(markdown, /forged query heading/);
  assert.match(markdown, /forged reason heading/);
  assert.match(markdown, /forged warning heading/);
});

test("Markdown renderer enforces a total output budget", () => {
  const root = {
    id: "java_method:Wide#entry/0",
    type: "java_method",
    name: "中".repeat(32 * 1024),
    score: 1000,
  };
  const tables = Array.from({ length: 1_000 }, (_, index) => ({
    id: `table:dbo.result_${index}`,
    type: "table",
    name: `dbo.result_${index}`,
  }));
  const trace = {
    mode: "feature",
    query: "Wide.entry",
    matches: [root],
    nodes: [root, ...tables],
    edges: tables.map((table, index) => ({
      id: `reads_from:${index}`,
      source: root.id,
      target: table.id,
      type: "reads_from",
      confidence: 1,
      reason: "verified",
      evidence: [],
    })),
    paths: tables.map((table, index) => ({
      nodes: [root.id, table.id],
      edges: ["reads_from"],
      edgeIds: [`reads_from:${index}`],
    })),
    warnings: [],
  };

  const markdown = renderTraceMarkdown(trace);

  assert.equal(Buffer.byteLength(markdown) <= 256 * 1024, true);
  assert.match(markdown, /(?:输出|output)[^\n]*(?:截断|truncat)/i);
});

test("Markdown renderer reports when the primary path display reaches its item cap", () => {
  const root = {
    id: "java_method:Paths#entry/0",
    type: "java_method",
    name: "Paths.entry",
    score: 1000,
  };
  const tables = Array.from({ length: 13 }, (_, index) => ({
    id: `table:dbo.path_${index}`,
    type: "table",
    name: `dbo.path_${index}`,
  }));
  const trace = {
    mode: "feature",
    query: "Paths.entry",
    matches: [root],
    nodes: [root, ...tables],
    edges: [],
    paths: tables.map((table, index) => ({
      nodes: [root.id, table.id],
      edges: ["reads_from"],
      edgeIds: [`reads_from:${index}`],
    })),
    warnings: [],
  };

  const markdown = renderTraceMarkdown(trace);
  const primaryPaths = markdown.slice(
    markdown.indexOf("## 主要链路"),
    markdown.indexOf("## 确定关系"),
  );

  assert.equal(primaryPaths.match(/^- /gm)?.length, 12);
  assert.equal(primaryPaths.includes("table:dbo.path_12"), false);
  assert.match(markdown, /(?:输出|output)[^\n]*(?:截断|truncat)/i);
});

test("Markdown renderer bounds no-match warnings and does not read omitted items", () => {
  const warnings = Array.from({ length: 201 }, (_, index) => `warning ${index}`);
  Object.defineProperty(warnings, "200", {
    enumerable: true,
    get() {
      throw new Error("renderer read an omitted warning");
    },
  });
  const trace = {
    mode: "feature",
    query: "missing",
    matches: [],
    nodes: [],
    edges: [],
    paths: [],
    warnings,
  };

  const markdown = renderTraceMarkdown(trace);

  assert.equal(Buffer.byteLength(markdown) <= 256 * 1024, true);
  assert.match(markdown, /(?:输出|output)[^\n]*(?:截断|truncat)/i);
});

test("Markdown renderer caps relation work before reading omitted edge details", () => {
  const root = { id: "java_method:Bounded#entry/0", type: "java_method", name: "Bounded.entry", score: 1000 };
  const tables = Array.from({ length: 501 }, (_, index) => ({
    id: `table:dbo.bounded_${index}`,
    type: "table",
    name: `dbo.bounded_${index}`,
  }));
  const edges = tables.map((table, index) => ({
    id: `reads_from:${index}`,
    source: root.id,
    target: table.id,
    type: "reads_from",
    confidence: 1,
    reason: "verified",
    evidence: [],
  }));
  Object.defineProperty(edges[500], "reason", {
    enumerable: true,
    get() {
      throw new Error("renderer read an omitted relation");
    },
  });
  const trace = {
    mode: "feature",
    query: "Bounded.entry",
    matches: [root],
    nodes: [root, ...tables],
    edges,
    paths: [],
    warnings: [],
  };

  const markdown = renderTraceMarkdown(trace);

  assert.equal(Buffer.byteLength(markdown) <= 256 * 1024, true);
  assert.match(markdown, /(?:输出|output)[^\n]*(?:截断|truncat)/i);
});

function record(relativePath, language, content, category = "code") {
  return parseFileBuffer(
    { path: relativePath, language, category, size: Buffer.byteLength(content) },
    Buffer.from(content),
  );
}

test("procedure and Tiles traces expose new legacy framework relationships", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("db/order.sql", "sql", [
        "CREATE PROCEDURE dbo.usp_OrderAudit @OrderId int",
        "AS SELECT * FROM dbo.T_ORDER WHERE ORDER_ID = @OrderId; EXEC dbo.usp_WriteAudit @OrderId;",
        "GO",
        "CREATE PROCEDURE dbo.usp_WriteAudit @OrderId int",
        "AS INSERT INTO dbo.T_AUDIT (ORDER_ID) VALUES (@OrderId);",
      ].join("\n"), "database"),
      record("sqlmap/order.xml", "xml", "<sqlMap namespace='order'><procedure id='audit'>{call dbo.usp_OrderAudit(#id#)}</procedure></sqlMap>", "config"),
      record("WEB-INF/tiles.xml", "xml", "<tiles-definitions><definition name='base.page' template='/layout.jsp'/><definition name='order.page' extends='base.page' template='/layout.jsp'><put name='body' value='/order.jsp'/></definition></tiles-definitions>", "config"),
      record("web/layout.jsp", "jsp", "<div>layout</div>", "markup"),
      record("web/order.jsp", "jsp", "<div>order</div>", "markup"),
    ],
  });

  const statement = traceStatement(graph, "order.audit");
  assert.equal(statement.nodes.some((node) => node.id === "procedure:dbo.usp_orderaudit"), true);
  assert.equal(statement.nodes.some((node) => node.id === "table:dbo.t_order"), true);
  const table = traceTable(graph, "dbo.t_audit");
  assert.equal(table.nodes.some((node) => node.id === "procedure:dbo.usp_writeaudit"), true);
  const tiles = traceFeature(graph, "order.page");
  assert.equal(tiles.matches[0].id, "tiles_definition:order.page");
  assert.equal(tiles.nodes.some((node) => node.id === "page:web/layout.jsp"), true);
  assert.equal(tiles.nodes.some((node) => node.id === "page:web/order.jsp"), true);
});

test("procedure trace follows callers, nested procedures, and database tables", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("db/order.sql", "sql", [
        "CREATE PROCEDURE dbo.usp_OrderAudit @OrderId int",
        "AS SELECT * FROM dbo.T_ORDER WHERE ORDER_ID = @OrderId; EXEC dbo.usp_WriteAudit @OrderId;",
        "GO",
        "CREATE PROCEDURE dbo.usp_WriteAudit @OrderId int",
        "AS INSERT INTO dbo.T_AUDIT (ORDER_ID) VALUES (@OrderId);",
      ].join("\n"), "database"),
      record("sqlmap/order.xml", "xml", "<sqlMap namespace='order'><procedure id='audit'>{call dbo.usp_OrderAudit(#id#)}</procedure></sqlMap>", "config"),
    ],
  });

  const result = traceProcedure(graph, "dbo.usp_OrderAudit");

  assert.equal(result.mode, "procedure");
  assert.equal(result.matches[0].id, "procedure:dbo.usp_orderaudit");
  assert.equal(result.nodes.some((node) => node.id === "statement:order.audit"), true);
  assert.equal(result.nodes.some((node) => node.id === "procedure:dbo.usp_writeaudit"), true);
  assert.equal(result.nodes.some((node) => node.id === "table:dbo.t_order"), true);
  assert.equal(result.nodes.some((node) => node.id === "table:dbo.t_audit"), true);
  assert.equal(result.edges.some((edge) => edge.type === "calls_procedure"), true);
});

test("URL traces include Tiles forwards and Struts 2 redirects", () => {
  const graph = materializeRecords({
    projectRoot,
    records: [
      record("WEB-INF/struts-config.xml", "xml", "<struts-config><action path='/order' type='com.acme.OrderAction'><forward name='success' path='order.page'/></action></struts-config>", "config"),
      record("WEB-INF/struts.xml", "xml", "<struts><package namespace='/order'><action name='save' class='com.acme.OrderAction'><result type='redirectAction'>review</result></action></package></struts>", "config"),
      record("WEB-INF/tiles.xml", "xml", "<tiles-definitions><definition name='order.page' template='/layout.jsp'/></tiles-definitions>", "config"),
      record("web/layout.jsp", "jsp", "<div>layout</div>", "markup"),
    ],
  });

  const tile = traceUrl(graph, "/order.do");
  const redirect = traceUrl(graph, "/order/save.action");

  assert.equal(tile.nodes.some((node) => node.id === "tiles_definition:order.page"), true);
  assert.equal(tile.nodes.some((node) => node.id === "page:web/layout.jsp"), true);
  assert.equal(redirect.nodes.some((node) => node.id === "route:/order/review.action"), true);
});
