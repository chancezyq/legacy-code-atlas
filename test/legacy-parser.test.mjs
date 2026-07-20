import assert from "node:assert/strict";
import test from "node:test";

import { parseSqlServer } from "../src/parsers/sql-server.mjs";
import { parseIbatisSqlMap } from "../src/parsers/ibatis.mjs";
import { parseStruts2Config, parseStrutsConfig, parseTilesDefinitions } from "../src/parsers/web-config.mjs";

test("SQL Server parser extracts procedures, tables, and nested EXEC calls", () => {
  const result = parseSqlServer(`
CREATE OR ALTER PROCEDURE dbo.usp_OrderAudit @OrderId int
AS
BEGIN
  SELECT * FROM dbo.T_ORDER WHERE ORDER_ID = @OrderId;
  EXEC dbo.usp_WriteAudit @OrderId;
END
GO
`, "db/procedures/order.sql");

  assert.deepEqual(result.procedures.map(({ fullName, parameters, reads, writes, calls }) => [fullName, parameters, reads, writes, calls]), [
    ["dbo.usp_orderaudit", ["@OrderId int"], ["dbo.t_order"], [], ["dbo.usp_writeaudit"]],
  ]);
  assert.equal(result.procedures[0].evidence.file, "db/procedures/order.sql");
  assert.equal(result.procedures[0].evidence.line, 2);
});

test("SQL Server warns when EXEC target is dynamic", () => {
  const result = parseSqlServer(
    "CREATE PROCEDURE dbo.usp_Dynamic\nAS\nEXEC(@procedureName)\nGO\n",
    "db/procedures/dynamic.sql",
  );

  assert.equal(result.warnings.some((warning) => warning.includes("dynamic") && warning.includes("EXEC")), true);
  assert.equal(result.warnings.some((warning) => warning.includes("line 3")), true);
});

test("SQL Server treats EXEC return-code assignment as a static procedure call", () => {
  const result = parseSqlServer(
    "CREATE PROCEDURE dbo.usp_Parent\nAS\nEXEC @return_code = dbo.usp_Child @Id = 1\nGO\n",
    "db/procedures/parent.sql",
  );

  assert.deepEqual(result.procedures[0].calls, ["dbo.usp_child"]);
  assert.deepEqual(result.warnings, []);
});

test("iBATIS procedure statements expose the referenced SQL Server procedure", () => {
  const result = parseIbatisSqlMap(
    `<sqlMap namespace="order"><procedure id="audit">{call dbo.usp_OrderAudit(#id#)}</procedure></sqlMap>`,
    "sqlmap/order.xml",
  );

  assert.equal(result.statements[0].type, "procedure");
  assert.equal(result.statements[0].procedureName, "dbo.usp_orderaudit");
});

test("iBATIS procedure lookup ignores comments and SQL string literals", () => {
  const result = parseIbatisSqlMap(
    `<sqlMap namespace="order"><procedure id="audit"><![CDATA[
      -- call dbo.usp_BadLine
      SELECT '-- call dbo.usp_BadString';
      /* call dbo.usp_BadBlock */
      {call dbo.usp_OrderAudit(#id#)}
    ]]></procedure></sqlMap>`,
    "sqlmap/order.xml",
  );

  assert.equal(result.statements[0].procedureName, "dbo.usp_orderaudit");
});

test("iBATIS extracts procedure names from JDBC calls in any statement type", () => {
  const result = parseIbatisSqlMap(
    `<sqlMap namespace="order"><update id="audit"><![CDATA[{call dbo.usp_OrderAudit(#id#)}]]></update></sqlMap>`,
    "sqlmap/order.xml",
  );

  assert.equal(result.statements[0].procedureName, "dbo.usp_orderaudit");
});

test("iBATIS procedure lookup ignores XML attributes around SQL", () => {
  const result = parseIbatisSqlMap(
    `<sqlMap namespace="order"><procedure id="audit"><param note="call dbo.usp_Bad"/><![CDATA[{call dbo.usp_OrderAudit(#id#)}]]></procedure></sqlMap>`,
    "sqlmap/order.xml",
  );

  assert.equal(result.statements[0].procedureName, "dbo.usp_orderaudit");
});

test("iBATIS warns when a procedure statement has no static target", () => {
  const result = parseIbatisSqlMap(
    `<sqlMap namespace="order"><procedure id="audit"><![CDATA[{call ${"${procedureName}"}}]]></procedure></sqlMap>`,
    "sqlmap/order.xml",
  );

  assert.equal(result.statements[0].procedureName, undefined);
  assert.equal(result.warnings.some((warning) => warning.includes("audit") && warning.includes("procedure")), true);
});

test("Struts 2 parser extracts namespaced actions, methods, and results", () => {
  const result = parseStruts2Config(`
<struts><package name="orders" namespace="/order" extends="struts-default">
  <action name="save" class="com.acme.OrderAction" method="save">
    <result name="success">/order/success.jsp</result>
  </action>
</package></struts>`, "WEB-INF/struts.xml");

  assert.deepEqual(result.actions.map(({ name, namespace, url, className, method, methodExplicit, results }) => [name, namespace, url, className, method, methodExplicit, results.map((item) => item.path)]), [
    ["save", "/order", "/order/save.action", "com.acme.OrderAction", "save", true, ["/order/success.jsp"]],
  ]);
});

test("Struts 2 parser cites duplicate actions and results at their own offsets", () => {
  const result = parseStruts2Config([
    "<struts><package namespace='/order'>",
    "  <action name='save' class='com.acme.FirstAction'><result>/first.jsp</result></action>",
    "  <action name='save' class='com.acme.SecondAction'><result>/second.jsp</result></action>",
    "</package></struts>",
  ].join("\n"), "WEB-INF/struts.xml");

  assert.deepEqual(result.actions.map((action) => [action.className, action.evidence.line, action.results[0].evidence.line]), [
    ["com.acme.FirstAction", 2, 2],
    ["com.acme.SecondAction", 3, 3],
  ]);
});

test("Struts 2 parser normalizes action extensions and redirectAction params", () => {
  const result = parseStruts2Config([
    "<struts><package namespace='/order'>",
    "  <action name='save.action' class='com.acme.OrderAction'>",
    "    <result name='success' type='redirectAction'>",
    "      <param name='actionName'>review.action</param>",
    "      <param name='namespace'>/audit</param>",
    "    </result>",
    "  </action>",
    "</package></struts>",
  ].join("\n"), "WEB-INF/struts.xml");

  assert.equal(result.actions[0].url, "/order/save.action");
  assert.equal(result.actions[0].results[0].path, "review.action");
  assert.equal(result.actions[0].results[0].namespace, "/audit");
});

test("nested Struts 1 forwards use each repeated child offset", () => {
  const result = parseStrutsConfig([
    "<struts-config><action path='/order' type='com.acme.OrderAction'>",
    "  <forward name='ok' path='/same.jsp'/>",
    "  <forward name='ok' path='/same.jsp'/>",
    "</action></struts-config>",
  ].join("\n"), "WEB-INF/struts-config.xml");

  assert.deepEqual(result.actions[0].forwards.map((forward) => forward.evidence.line), [2, 3]);
});

test("Tiles parser extracts definitions, inheritance, templates, and puts", () => {
  const result = parseTilesDefinitions(`
<tiles-definitions>
  <definition name="order.page" extends="base.page" template="/WEB-INF/layout.jsp">
    <put name="body" value="/order.jsp"/>
  </definition>
</tiles-definitions>`, "WEB-INF/tiles.xml");

  assert.deepEqual(result.definitions.map(({ name, extendsName, template, puts }) => [name, extendsName, template, puts.map((put) => [put.name, put.value])]), [
    ["order.page", "base.page", "/WEB-INF/layout.jsp", [["body", "/order.jsp"]]],
  ]);
});

test("Tiles parser cites duplicate definitions and puts at their own offsets", () => {
  const result = parseTilesDefinitions([
    "<tiles-definitions>",
    "  <definition name='first' template='/first-layout.jsp'><put name='body' value='/first.jsp'/></definition>",
    "  <definition name='second' template='/second-layout.jsp'><put name='body' value='/second.jsp'/></definition>",
    "</tiles-definitions>",
  ].join("\n"), "WEB-INF/tiles.xml");

  assert.deepEqual(result.definitions.map((definition) => [definition.name, definition.evidence.line, definition.puts[0].evidence.line]), [
    ["first", 2, 2],
    ["second", 3, 3],
  ]);
});

test("nested Tiles puts use each repeated child offset", () => {
  const result = parseTilesDefinitions([
    "<tiles-definitions><definition name='order' template='/layout.jsp'>",
    "  <put name='body' value='/same.jsp'/>",
    "  <put name='body' value='/same.jsp'/>",
    "</definition></tiles-definitions>",
  ].join("\n"), "WEB-INF/tiles.xml");

  assert.deepEqual(result.definitions[0].puts.map((put) => put.evidence.line), [2, 3]);
});
