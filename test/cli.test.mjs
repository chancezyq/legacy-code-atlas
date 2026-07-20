import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);
const cli = new URL("../bin/legacy-code-atlas.mjs", import.meta.url).pathname;
const fixture = new URL("./fixtures/legacy-shop", import.meta.url).pathname;

async function projectCopy(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fixture, root, { recursive: true });
  return root;
}

test("CLI analyzes a project and writes the default deterministic index", async (t) => {
  const project = await projectCopy(t);
  const first = await run(process.execPath, [cli, "analyze", project]);
  const indexPath = path.join(project, ".legacy-code-atlas", "index.json");
  const cachePath = path.join(project, ".legacy-code-atlas", "cache.json");
  await access(indexPath);
  await access(cachePath);
  const firstIndex = await readFile(indexPath, "utf8");
  const second = await run(process.execPath, [cli, "analyze", project]);
  const secondIndex = await readFile(indexPath, "utf8");

  assert.match(first.stdout, /分析完成/);
  assert.match(first.stdout, /index\.json/);
  assert.match(second.stdout, /分析完成/);
  assert.equal(firstIndex, secondIndex);
});

test("CLI supports overview, search, and all trace commands", async (t) => {
  const project = await projectCopy(t);
  await writeFile(path.join(project, "order.sql"), [
    "CREATE PROCEDURE dbo.usp_OrderAudit @OrderId int",
    "AS SELECT * FROM dbo.T_ORDER WHERE ORDER_ID = @OrderId;",
    "GO",
  ].join("\n"));
  await run(process.execPath, [cli, "analyze", project]);

  const overview = await run(process.execPath, [cli, "overview", project]);
  const search = await run(process.execPath, [cli, "search", project, "order.updateStatus", "--json"]);
  const feature = await run(process.execPath, [cli, "trace-feature", project, "订单审核"]);
  const url = await run(process.execPath, [cli, "trace-url", project, "/order/audit.do"]);
  const statement = await run(process.execPath, [cli, "trace-statement", project, "order.updateStatus"]);
  const table = await run(process.execPath, [cli, "trace-table", project, "dbo.t_order"]);
  const procedure = await run(process.execPath, [cli, "trace-procedure", project, "dbo.usp_OrderAudit"]);

  assert.match(overview.stdout, /节点/);
  assert.equal(JSON.parse(search.stdout)[0].id, "statement:order.updateStatus");
  assert.match(feature.stdout, /订单审核/);
  assert.match(feature.stdout, /dbo\.t_order/);
  assert.match(url.stdout, /OrderAuditAction/);
  assert.match(statement.stdout, /IbatisOrderDao/);
  assert.match(table.stdout, /web\/order\/audit\.jsp/);
  assert.match(procedure.stdout, /usp_orderaudit/i);
});

test("CLI returns a non-zero status when a query has no match", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);

  await assert.rejects(
    run(process.execPath, [cli, "trace-feature", project, "完全不存在的功能"]),
    (error) => error.code === 3 && /未找到/.test(error.stdout),
  );
});
