import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractSqlTables, parseIbatisSqlMap } from "../src/parsers/ibatis.mjs";

test("iBATIS parser extracts statements, fragments, includes, and SQL Server tables", async () => {
  const content = await readFile(new URL("./fixtures/legacy-shop/sqlmap/order.xml", import.meta.url), "utf8");
  const result = parseIbatisSqlMap(content, "sqlmap/order.xml");

  assert.equal(result.namespace, "order");
  assert.deepEqual(result.fragments.map(({ id }) => id), ["baseColumns"]);
  assert.deepEqual(
    result.statements.map(({ id, fullId, type }) => [id, fullId, type]),
    [
      ["findForAudit", "order.findForAudit", "select"],
      ["updateStatus", "order.updateStatus", "update"],
      ["insertAuditLog", "order.insertAuditLog", "insert"],
      ["deleteDraft", "order.deleteDraft", "delete"],
    ],
  );
  assert.equal(result.statements[0].parameterClass, "java.lang.Long");
  assert.equal(result.statements[0].resultMap, "orderResult");
  assert.deepEqual(result.statements[0].includes, ["baseColumns"]);
  assert.deepEqual(result.statements[0].reads, ["dbo.t_customer", "dbo.t_order"]);
  assert.deepEqual(result.statements[0].writes, []);
  assert.deepEqual(result.statements[1].writes, ["dbo.t_order"]);
  assert.deepEqual(result.statements[2].writes, ["dbo.t_order_audit_log"]);
  assert.deepEqual(result.statements[3].writes, ["dbo.t_order_draft"]);
  assert.equal(result.statements[0].evidence.line, 10);
});

test("iBATIS parser supports non-namespaced and dynamic statements", () => {
  const content = `<sqlMap>\n<select id="findActive" resultClass="java.util.Map">\nSELECT * FROM T_USER\n<dynamic prepend="WHERE"><isNotNull property="name">NAME = #name#</isNotNull></dynamic>\n</select>\n</sqlMap>`;
  const result = parseIbatisSqlMap(content, "User.xml");

  assert.equal(result.namespace, "");
  assert.equal(result.statements[0].fullId, "findActive");
  assert.equal(result.statements[0].sql.includes("NAME = #name#"), true);
  assert.deepEqual(result.statements[0].reads, ["t_user"]);
});

test("table extraction distinguishes reads and writes", () => {
  assert.deepEqual(
    extractSqlTables("MERGE INTO [audit].[TARGET] t USING dbo.SOURCE s ON t.ID=s.ID WHEN MATCHED THEN UPDATE SET t.STATUS=s.STATUS", "update"),
    { reads: ["dbo.source"], writes: ["audit.target"] },
  );
});

test("table extraction does not report SQL Server CTE names as physical tables", () => {
  const sql = `WITH input_raw AS (SELECT id FROM dbo.SOURCE_TABLE), filtered AS (SELECT id FROM input_raw) SELECT f.id FROM filtered f JOIN dbo.TARGET_TABLE t ON t.id=f.id`;

  assert.deepEqual(extractSqlTables(sql, "select"), {
    reads: ["dbo.source_table", "dbo.target_table"],
    writes: [],
  });
});

test("iBATIS parser expands SQL fragments before extracting tables", () => {
  const content = `<sqlMap namespace="fragment"><sql id="fromTables">FROM dbo.T_MAIN m JOIN dbo.T_DETAIL d ON d.ID=m.ID</sql><select id="findAll" resultClass="java.util.Map">SELECT m.ID <include refid="fromTables" /></select></sqlMap>`;
  const result = parseIbatisSqlMap(content, "Fragment.xml");

  assert.deepEqual(result.statements[0].includes, ["fromTables"]);
  assert.deepEqual(result.statements[0].reads, ["dbo.t_detail", "dbo.t_main"]);
});

test("SQL Server alias UPDATE and DELETE resolve the physical target table", () => {
  assert.deepEqual(
    extractSqlTables("UPDATE o SET o.STATUS='X' FROM dbo.T_ORDER o JOIN dbo.T_USER u ON u.ID=o.USER_ID", "update"),
    { reads: ["dbo.t_user"], writes: ["dbo.t_order"] },
  );
  assert.deepEqual(
    extractSqlTables("DELETE o FROM dbo.T_ORDER o JOIN dbo.T_USER u ON u.ID=o.USER_ID", "delete"),
    { reads: ["dbo.t_user"], writes: ["dbo.t_order"] },
  );
});

test("table extraction ignores SQL comments and string literals", () => {
  const sql = `SELECT * FROM dbo.REAL_TABLE WHERE note = 'FROM dbo.FAKE_STRING' -- JOIN dbo.FAKE_LINE x\n/* FROM dbo.FAKE_BLOCK */`;

  assert.deepEqual(extractSqlTables(sql, "select"), {
    reads: ["dbo.real_table"],
    writes: [],
  });
});

test("iBATIS parser warns about a truncated SQL map while preserving complete statements", () => {
  const result = parseIbatisSqlMap(
    "<sqlMap namespace='broken'><select id='all'>SELECT * FROM T_USER</select>",
    "Broken.xml",
  );

  assert.equal(result.statements[0].fullId, "broken.all");
  assert.equal(result.warnings.some((warning) => warning.includes("unclosed <sqlMap>")), true);
});

test("iBATIS parser extracts generic statement SQL and inferred writes", () => {
  const result = parseIbatisSqlMap([
    "<sqlMap namespace='Order'>",
    "  <statement id='msSqlServerInsertOrder'>",
    "    INSERT INTO dbo.Orders (userid) VALUES (#username#);",
    "    SELECT @@identity AS value",
    "  </statement>",
    "</sqlMap>",
  ].join("\n"), "Order.xml");

  assert.deepEqual(result.statements.map((statement) => ({
    fullId: statement.fullId,
    type: statement.type,
    reads: statement.reads,
    writes: statement.writes,
  })), [{
    fullId: "Order.msSqlServerInsertOrder",
    type: "statement",
    reads: [],
    writes: ["dbo.orders"],
  }]);
});

test("generic iBATIS statements collect reads and writes from every SQL operation", () => {
  const result = parseIbatisSqlMap([
    "<sqlMap namespace='Order'>",
    "  <statement id='batch'>",
    "    WITH source_rows AS (SELECT id FROM dbo.SourceRows)",
    "    UPDATE dbo.TargetRows SET status = 1 FROM dbo.TargetRows JOIN source_rows ON source_rows.id = dbo.TargetRows.id;",
    "    DELETE FROM dbo.OldRows;",
    "    INSERT INTO dbo.NewRows (id) SELECT id FROM dbo.SourceRows;",
    "  </statement>",
    "</sqlMap>",
  ].join("\n"), "Order.xml");

  assert.deepEqual(result.statements[0].reads, ["dbo.sourcerows"]);
  assert.deepEqual(result.statements[0].writes, ["dbo.newrows", "dbo.oldrows", "dbo.targetrows"]);
});

test("generic iBATIS statements collect every alias-form DELETE target", () => {
  assert.deepEqual(
    extractSqlTables(
      "DELETE old_row FROM dbo.OldRows old_row; DELETE stale_row FROM dbo.StaleRows stale_row;",
      "statement",
    ),
    { reads: [], writes: ["dbo.oldrows", "dbo.stalerows"] },
  );
});
