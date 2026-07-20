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
