import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, cp, link, lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
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

async function assertCliError(args, pattern, message) {
  await assert.rejects(
    run(process.execPath, [cli, ...args]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, pattern);
      return true;
    },
    message,
  );
}

async function mutateStandardIndex(project, mutate) {
  const indexPath = path.join(project, ".legacy-code-atlas", "index.json");
  const graph = JSON.parse(await readFile(indexPath, "utf8"));
  mutate(graph);
  await writeFile(indexPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

test("CLI help documents --query-file for every trace command", async () => {
  const help = await run(process.execPath, [cli, "--help"]);

  assert.match(help.stdout, /doctor <project>/);
  assert.match(help.stdout, /analyze <project>[^\n]+--main-thread/);
  assert.match(help.stdout, /prepare-query <project>/);

  for (const command of [
    "trace-feature",
    "trace-url",
    "trace-statement",
    "trace-procedure",
    "trace-table",
  ]) {
    assert.match(
      help.stdout,
      new RegExp(`${command} <project-or-standard-index> --query-file <path> \\[--no-match-ok\\]`),
    );
  }

  assert.doesNotMatch(
    help.stdout,
    /trace-[a-z-]+ <project-or-index> --query-file/,
    "query-file help must not imply that detached or custom indexes are accepted",
  );
  assert.match(help.stdout, /1024 characters/);
  assert.match(help.stdout, /64 tokens/);
  assert.match(help.stdout, /64 KiB/);
});

test("CLI doctor reports a clean runtime as JSON", async (t) => {
  const project = await projectCopy(t);
  const home = await mkdtemp(path.join(tmpdir(), "legacy-atlas-cli-doctor-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));

  const result = await run(process.execPath, [cli, "doctor", project, "--json"], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      OPENCODE_CONFIG_DIR: "",
    },
  });
  const report = JSON.parse(result.stdout);

  assert.equal(report.ok, true);
  assert.match(report.atlasVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(report.nodeVersion, process.versions.node);
  assert.equal(report.projectRoot, path.resolve(project));
  assert.equal(Array.isArray(report.roots), true);
  assert.deepEqual(report.conflicts, []);

  const text = await run(process.execPath, [cli, "doctor", project], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, "xdg"),
      OPENCODE_CONFIG_DIR: "",
    },
  });
  assert.equal(text.stdout.includes(path.join(home, ".opencode")), true);
  assert.match(text.stdout, /Checked OpenCode roots:/);
});

test("CLI rejects --output without a value before doctor dispatch", async (t) => {
  const project = await projectCopy(t);
  await assertCliError(
    ["doctor", project, "--output"],
    /--output[^\r\n]+(?:缺少|路径)/,
  );
});

test("CLI doctor reports a stale Bun-based Atlas tool with path and hash", async (t) => {
  const project = await projectCopy(t);
  const home = await mkdtemp(path.join(tmpdir(), "legacy-atlas-cli-doctor-conflict-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const staleTool = path.join(home, ".opencode", "tool", "legacy_atlas.ts");
  await mkdir(path.dirname(staleTool), { recursive: true });
  await writeFile(
    staleTool,
    'export function legacy_atlas_analyze() { return Bun.which("node"); }\n',
    "utf8",
  );

  await assert.rejects(
    run(process.execPath, [cli, "doctor", project, "--json"], {
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, "xdg"),
        OPENCODE_CONFIG_DIR: "",
      },
    }),
    (error) => {
      assert.equal(error.code, 4);
      const report = JSON.parse(error.stdout);
      assert.equal(report.ok, false);
      assert.deepEqual(report.conflicts.map((entry) => entry.path), [staleTool]);
      assert.match(report.conflicts[0].sha256, /^[a-f0-9]{64}$/);
      assert.match(report.conflicts[0].classification, /legacy-atlas-tool/);
      return true;
    },
  );
});

test("prepare-query atomically replaces unsafe query-file links without touching their targets", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  const sentinelPath = path.join(project, "source-sentinel.txt");
  const sentinel = "SOURCE_SENTINEL\n";
  await writeFile(sentinelPath, sentinel, "utf8");

  if (process.platform !== "win32") {
    await rm(queryPath, { force: true });
    await symlink(sentinelPath, queryPath);
    await run(process.execPath, [cli, "prepare-query", project]);
    assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
    assert.equal((await lstat(queryPath)).isSymbolicLink(), false);
    assert.equal(await readFile(queryPath, "utf8"), "");
  }

  await rm(queryPath, { force: true });
  await link(sentinelPath, queryPath);
  await run(process.execPath, [cli, "prepare-query", project]);
  assert.equal(await readFile(sentinelPath, "utf8"), sentinel);
  assert.equal((await stat(queryPath)).nlink, 1);
  assert.equal(await readFile(queryPath, "utf8"), "");
});

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

test("CLI analyzes source-derived reserved JSP fields and path-like iBATIS identifiers", async (t) => {
  const project = await projectCopy(t);
  await writeFile(
    path.join(project, "web", "order", "worker-fields.jsp"),
    '<form action="/save"><input name="duration" value="30"><input name="worker" value="legacy"><input name="node" value="primary"></form>',
    "utf8",
  );
  await writeFile(
    path.join(project, "sqlmap", "path-like-id.xml"),
    '<sqlMap><procedure id="/home/job">select 1</procedure></sqlMap>',
    "utf8",
  );

  const analyzed = await run(process.execPath, [cli, "analyze", project]);
  assert.equal(analyzed.stderr, "");
  await stat(path.join(project, ".legacy-code-atlas", "index.json"));
});

test("CLI auto-analyzes a fresh project when overview has no index", async (t) => {
  const project = await projectCopy(t);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  await rm(atlasDirectory, { recursive: true, force: true });

  const overview = await run(process.execPath, [cli, "overview", project]);

  assert.match(overview.stdout, /项目概览/);
  await access(path.join(atlasDirectory, "index.json"));
  await access(path.join(atlasDirectory, "cache.json"));
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

test("Skill query-file mode can keep no-match output on exit zero", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "NoSuchFeature", "utf8");

  const result = await run(process.execPath, [
    cli,
    "trace-feature",
    project,
    "--query-file",
    queryPath,
    "--no-match-ok",
  ]);

  assert.match(result.stdout, /未找到/);
  assert.equal(result.stderr, "");
  await assertCliError(
    ["trace-feature", project, "NoSuchFeature", "--no-match-ok"],
    /--no-match-ok[^\n]+--query-file/,
  );
  await assertCliError(
    ["overview", project, "--no-match-ok"],
    /overview[^\n]+--no-match-ok|--no-match-ok[^\n]+overview/,
  );
});

test("CLI reads a trace query from a project-local query file", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "订单审核", "utf8");

  const feature = await run(process.execPath, [
    cli,
    "trace-feature",
    project,
    "--query-file",
    queryPath,
  ]);

  assert.match(feature.stdout, /订单审核/);
  assert.match(feature.stdout, /dbo\.t_order/);
});

test("a concise English source candidate finds code when a conversational Chinese question does not", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");

  await writeFile(queryPath, "订单审核功能在哪里？", "utf8");
  await assert.rejects(
    run(process.execPath, [cli, "trace-feature", project, "--query-file", queryPath]),
    (error) => error.code === 3 && /未找到/.test(error.stdout),
  );

  await writeFile(queryPath, "OrderAudit", "utf8");
  const feature = await run(process.execPath, [
    cli,
    "trace-feature",
    project,
    "--query-file",
    queryPath,
  ]);

  assert.match(feature.stdout, /OrderAuditServiceImpl/);
  assert.match(feature.stdout, /dbo\.t_order/);
});

test("CLI derives the project root from a moved standard index path", async (t) => {
  const original = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", original]);

  const moved = await mkdtemp(path.join(tmpdir(), "legacy-atlas-cli-moved-"));
  t.after(() => rm(moved, { recursive: true, force: true }));
  await cp(original, moved, { recursive: true });
  const indexPath = path.join(moved, ".legacy-code-atlas", "index.json");
  const queryPath = path.join(moved, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "订单审核", "utf8");

  const feature = await run(process.execPath, [
    cli,
    "trace-feature",
    indexPath,
    "--query-file",
    queryPath,
  ]);

  assert.match(feature.stdout, /订单审核/);
  assert.match(feature.stdout, /dbo\.t_order/);
});

test("CLI rejects --query-file for detached or custom index paths", async (t) => {
  const project = await projectCopy(t);
  const detachedRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-cli-detached-"));
  t.after(() => rm(detachedRoot, { recursive: true, force: true }));
  const detachedIndex = path.join(detachedRoot, "custom-index.json");
  await run(process.execPath, [cli, "analyze", project, "--output", detachedIndex]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "订单审核", "utf8");

  await assertCliError(
    ["trace-feature", detachedIndex, "--query-file", queryPath],
    /--query-file.*<project>\/\.legacy-code-atlas\/index\.json/,
  );

  const customIndex = path.join(project, ".legacy-code-atlas", "custom-index.json");
  await cp(detachedIndex, customIndex);
  await assertCliError(
    ["trace-feature", customIndex, "--query-file", queryPath],
    /--query-file.*<project>\/\.legacy-code-atlas\/index\.json/,
  );

  const positional = await run(process.execPath, [
    cli,
    "trace-feature",
    detachedIndex,
    "订单审核",
  ]);
  assert.match(positional.stdout, /dbo\.t_order/);
});

test("CLI treats shell metacharacters in a query file as opaque query text", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  const query = "订单审核 & echo %PATH% | powershell";
  await writeFile(queryPath, query, "utf8");

  await assert.rejects(
    run(process.execPath, [
      cli,
      "trace-feature",
      project,
      "--query-file",
      queryPath,
      "--json",
    ]),
    (error) => {
      assert.equal(error.code, 3);
      assert.equal(error.stderr, "");
      assert.equal(JSON.parse(error.stdout).query, query);
      return true;
    },
  );
});

test("CLI rejects positional query text together with --query-file", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "订单审核", "utf8");

  await assertCliError(
    ["trace-feature", project, "订单审核", "--query-file", queryPath],
    /不能同时使用查询参数和 --query-file/,
  );
});

test("CLI confines query files to regular UTF-8 files under .legacy-code-atlas", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const externalRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-query-external-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));

  const traversalPath = `${atlasDirectory}${path.sep}..${path.sep}outside-query.txt`;
  await writeFile(path.join(project, "outside-query.txt"), "订单审核", "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", traversalPath],
    /必须位于项目的 \.legacy-code-atlas 目录内/,
  );

  const externalPath = path.join(externalRoot, "query.txt");
  await writeFile(externalPath, "订单审核", "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", externalPath],
    /必须位于项目的 \.legacy-code-atlas 目录内/,
  );

  const directoryPath = path.join(atlasDirectory, "query-directory");
  await mkdir(directoryPath);
  await assertCliError(
    ["trace-feature", project, "--query-file", directoryPath],
    /必须是普通文件/,
  );

  const emptyPath = path.join(atlasDirectory, "empty-query.txt");
  await writeFile(emptyPath, "", "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", emptyPath],
    /不能为空/,
  );

  const whitespacePath = path.join(atlasDirectory, "whitespace-query.txt");
  await writeFile(whitespacePath, " \r\n\t", "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", whitespacePath],
    /不能为空/,
  );

  const nulPath = path.join(atlasDirectory, "nul-query.txt");
  await writeFile(nulPath, "订单\0审核", "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", nulPath],
    /不能包含 NUL/,
  );

  const invalidUtf8Path = path.join(atlasDirectory, "invalid-utf8-query.txt");
  await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
  await assertCliError(
    ["trace-feature", project, "--query-file", invalidUtf8Path],
    /必须是有效的 UTF-8/,
  );

  const oversizedPath = path.join(atlasDirectory, "oversized-query.txt");
  await writeFile(oversizedPath, Buffer.alloc((64 * 1024) + 1, 0x61));
  await assertCliError(
    ["trace-feature", project, "--query-file", oversizedPath],
    /不能超过 64 KiB/,
  );
});

test("CLI bounds logical query length and token count before loading the index", async (t) => {
  const project = await projectCopy(t);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const queryPath = path.join(atlasDirectory, "query.txt");
  await mkdir(atlasDirectory, { recursive: true });
  await rm(path.join(atlasDirectory, "cache.json"), { force: true });
  await writeFile(path.join(atlasDirectory, "index.json"), "not-json", "utf8");

  await writeFile(queryPath, "a".repeat(1025), "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", queryPath],
    /不能超过 1024 个字符/,
  );

  await writeFile(queryPath, Array.from({ length: 65 }, () => "a").join(" "), "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", queryPath],
    /不能超过 64 个词/,
  );

  await assertCliError(
    ["trace-feature", project, "a".repeat(1025)],
    /不能超过 1024 个字符/,
  );

  await writeFile(queryPath, "OrderAudit\n# forged heading", "utf8");
  await assertCliError(
    ["trace-feature", project, "--query-file", queryPath],
    /控制字符/,
  );
  assert.equal(await readFile(path.join(atlasDirectory, "index.json"), "utf8"), "not-json");
  await assert.rejects(access(path.join(atlasDirectory, "cache.json")), { code: "ENOENT" });
});

test("CLI rejects standard indexes with citations outside the project", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const queryPath = path.join(project, ".legacy-code-atlas", "query.txt");
  const originalIndex = await readFile(path.join(project, ".legacy-code-atlas", "index.json"), "utf8");
  await writeFile(queryPath, "OrderAudit", "utf8");

  const cases = [
    ["node parent traversal", (graph) => { graph.nodes[0].filePath = "../../sensitive-file"; }],
    ["absolute evidence", (graph) => { graph.edges.find((edge) => edge.evidence.length).evidence[0].file = "/etc/passwd"; }],
    ["drive evidence", (graph) => { graph.edges.find((edge) => edge.evidence.length).evidence[0].file = "C:/company/secret.java"; }],
    ["UNC evidence", (graph) => { graph.edges.find((edge) => edge.evidence.length).evidence[0].file = "\\\\server\\share\\secret.java"; }],
    ["backslash evidence", (graph) => { graph.edges.find((edge) => edge.evidence.length).evidence[0].file = "src\\Secret.java"; }],
    ["file URL evidence", (graph) => { graph.edges.find((edge) => edge.evidence.length).evidence[0].file = "file:///etc/passwd"; }],
  ];

  for (const [name, mutate] of cases) {
    await writeFile(path.join(project, ".legacy-code-atlas", "index.json"), originalIndex, "utf8");
    await mutateStandardIndex(project, mutate);
    await assertCliError(
      ["trace-feature", project, "--query-file", queryPath],
      /索引[^\n]*(?:路径|引用)|(?:路径|引用)[^\n]*索引/,
      name,
    );
  }
});

test("CLI rejects malformed standard index structure before querying", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const indexPath = path.join(atlasDirectory, "index.json");
  const queryPath = path.join(atlasDirectory, "query.txt");
  const originalIndex = await readFile(indexPath, "utf8");
  await writeFile(queryPath, "OrderAudit", "utf8");

  await mutateStandardIndex(project, (graph) => { graph.schemaVersion = "9.9.9"; });
  await assertCliError(["trace-feature", project, "--query-file", queryPath], /schemaVersion|版本/);

  await writeFile(indexPath, originalIndex, "utf8");
  await mutateStandardIndex(project, (graph) => {
    graph.nodes.push(structuredClone(graph.nodes[0]));
    graph.summary.nodes += 1;
    graph.summary.nodeTypes[graph.nodes[0].type] += 1;
  });
  await assertCliError(["trace-feature", project, "--query-file", queryPath], /节点 ID[^\n]*(?:重复|唯一)|duplicate/i);

  await writeFile(indexPath, originalIndex, "utf8");
  await mutateStandardIndex(project, (graph) => { graph.edges[0].target = "table:missing"; });
  await assertCliError(["trace-feature", project, "--query-file", queryPath], /边[^\n]*(?:端点|节点)|edge[^\n]*(?:endpoint|node)/i);

  await writeFile(indexPath, originalIndex, "utf8");
  await mutateStandardIndex(project, (graph) => {
    graph.nodes[0].searchText[0] = "A".repeat((256 * 1024) + 1);
  });
  await assertCliError(["trace-feature", project, "--query-file", queryPath], /searchText[^\n]*过长|过长[^\n]*searchText/);
});

test("CLI keeps untrusted diagnostics on one bounded stderr line", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const maliciousCommand = `unknown-${"X".repeat(10_000)}\n# fake heading\u202e`;

  await assert.rejects(
    run(process.execPath, [cli, maliciousCommand, project, "query"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr.trimEnd().split(/\r?\n/u).length, 1);
      assert.doesNotMatch(error.stderr, /\u202e/u);
      assert.equal(error.stderr.length <= 4_200, true);
      return true;
    },
  );
});

test("CLI validates a cached auto-analysis graph before writing or tracing it", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const cachePath = path.join(atlasDirectory, "cache.json");
  const indexPath = path.join(atlasDirectory, "index.json");
  const poisoned = JSON.parse(await readFile(cachePath, "utf8"));
  poisoned.entries["sqlmap/order.xml"].record.facts.ibatis.statements[0].evidence.file = "../outside.sql";
  await writeFile(cachePath, `${JSON.stringify(poisoned, null, 2)}\n`, "utf8");
  await rm(indexPath);

  await assert.rejects(
    run(process.execPath, [cli, "trace-statement", project, "order.findForAudit"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.equal(error.stdout, "");
      assert.match(error.stderr, /项目索引[^\n]*(?:路径|引用)|(?:路径|引用)[^\n]*项目索引/);
      return true;
    },
  );
  await assert.rejects(access(indexPath), { code: "ENOENT" });
});

test("analyze bounds generated search text for large JSP and iBATIS source", async (t) => {
  const project = await projectCopy(t);
  const maxSearchTextCharacters = 256 * 1024;
  const jspTail = "JSP_SEARCH_TEXT_TAIL";
  const ibatisTail = "IBATIS_SEARCH_TEXT_TAIL";
  await writeFile(
    path.join(project, "large.jsp"),
    `<div>${"J".repeat(maxSearchTextCharacters + 64)} ${jspTail}</div>`,
    "utf8",
  );
  await writeFile(
    path.join(project, "sqlmap", "large.xml"),
    `<sqlMap namespace="large"><select id="lookup">SELECT * FROM dbo.T_ORDER WHERE NOTE = '${"S".repeat(maxSearchTextCharacters + 64)} ${ibatisTail}'</select></sqlMap>`,
    "utf8",
  );

  await run(process.execPath, [cli, "analyze", project]);
  const indexPath = path.join(project, ".legacy-code-atlas", "index.json");
  const graph = JSON.parse(await readFile(indexPath, "utf8"));
  const page = graph.nodes.find((node) => node.id === "page:large.jsp");
  const statement = graph.nodes.find((node) => node.id === "statement:large.lookup");

  assert.ok(page);
  assert.ok(statement);
  for (const node of [page, statement]) {
    assert.equal(node.searchText.every((value) => value.length <= maxSearchTextCharacters), true);
  }
  assert.equal(page.data.visibleText.includes(jspTail), true);
  assert.equal(statement.data.sql.includes(ibatisTail), true);
  assert.match((await run(process.execPath, [cli, "search", project, jspTail])).stdout, /page:large\.jsp/);
  assert.match((await run(process.execPath, [cli, "search", project, ibatisTail])).stdout, /statement:large\.lookup/);
});

test("analyze preserves the previous index when a cached generated graph is invalid", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const cachePath = path.join(atlasDirectory, "cache.json");
  const indexPath = path.join(atlasDirectory, "index.json");
  const previousIndex = await readFile(indexPath, "utf8");
  const poisoned = JSON.parse(await readFile(cachePath, "utf8"));
  poisoned.entries["sqlmap/order.xml"].record.facts.ibatis.statements[0].evidence.file = "../outside.sql";
  await writeFile(cachePath, `${JSON.stringify(poisoned, null, 2)}\n`, "utf8");

  await assertCliError(["analyze", project], /项目索引[^\n]*(?:路径|引用)|(?:路径|引用)[^\n]*项目索引/);
  assert.equal(await readFile(indexPath, "utf8"), previousIndex);
});

test("analyze normalizes source control characters before validating its index", async (t) => {
  const project = await projectCopy(t);
  await writeFile(path.join(project, "tab.jsp"), "<div>Tab\tcontent</div>\n", "utf8");

  await run(process.execPath, [cli, "analyze", project]);
  const indexPath = path.join(project, ".legacy-code-atlas", "index.json");
  const graph = JSON.parse(await readFile(indexPath, "utf8"));
  const page = graph.nodes.find((node) => node.id === "page:tab.jsp");
  assert.ok(page);
  assert.equal(page.evidence.some((entry) => /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(entry.snippet)), false);
  await run(process.execPath, [cli, "overview", project]);
});

test("CLI rejects oversized standard indexes before parsing", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const indexPath = path.join(atlasDirectory, "index.json");
  const queryPath = path.join(atlasDirectory, "query.txt");
  await writeFile(queryPath, "OrderAudit", "utf8");
  await truncate(indexPath, (512 * 1024 * 1024) + 1);

  await assertCliError(
    ["trace-feature", project, "--query-file", queryPath],
    /索引[^\n]*512 MiB|512 MiB[^\n]*索引/,
  );
});

test("CLI rejects an invalid query path before loading an invalid index or writing analysis files", async (t) => {
  const project = await projectCopy(t);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  await rm(atlasDirectory, { recursive: true, force: true });
  await mkdir(atlasDirectory, { recursive: true });
  await writeFile(path.join(atlasDirectory, "index.json"), "not-json", "utf8");

  const externalRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-query-preflight-"));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  const externalPath = path.join(externalRoot, "query.txt");
  await writeFile(externalPath, "OrderAudit", "utf8");

  await assertCliError(
    ["trace-feature", project, "--query-file", externalPath],
    /必须位于项目的 \.legacy-code-atlas 目录内/,
  );
  assert.equal(await readFile(path.join(atlasDirectory, "index.json"), "utf8"), "not-json");
  await assert.rejects(access(path.join(atlasDirectory, "cache.json")), { code: "ENOENT" });
});

test("CLI rejects a symlinked Atlas directory before analyzing or writing", { skip: process.platform === "win32" }, async (t) => {
  const project = await projectCopy(t);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const sourceDirectory = path.join(project, "src");
  const sourceIndex = path.join(sourceDirectory, "index.json");
  const sentinel = "SOURCE_SENTINEL\n";
  await rm(atlasDirectory, { recursive: true, force: true });
  await writeFile(sourceIndex, sentinel, "utf8");
  await symlink(sourceDirectory, atlasDirectory);

  await assertCliError(
    ["analyze", project],
    /\.legacy-code-atlas[^\n]*(?:符号链接|链接|symlink)/i,
  );
  assert.equal(await readFile(sourceIndex, "utf8"), sentinel);
  await assert.rejects(access(path.join(sourceDirectory, "cache.json")), { code: "ENOENT" });
});

test("CLI rejects a symlinked query file", { skip: process.platform === "win32" }, async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const sourcePath = path.join(project, "src", "com", "acme", "order", "dao", "OrderDao.java");

  const symlinkQuery = path.join(atlasDirectory, "symlink-query.txt");
  await symlink(sourcePath, symlinkQuery);
  await assertCliError(
    ["trace-feature", project, "--query-file", symlinkQuery],
    /问题文件必须是普通文件|问题文件不能是符号链接/i,
  );
});

test("CLI rejects a hardlinked query file", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const sourcePath = path.join(project, "src", "com", "acme", "order", "dao", "OrderDao.java");
  const hardlinkQuery = path.join(atlasDirectory, "hardlink-query.txt");
  await link(sourcePath, hardlinkQuery);
  await assertCliError(
    ["trace-feature", project, "--query-file", hardlinkQuery],
    /问题文件不能是硬链接|问题文件必须只有一个链接/i,
  );
});

test("CLI rejects a symlinked standard index before reading a query file", { skip: process.platform === "win32" }, async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const indexPath = path.join(atlasDirectory, "index.json");
  const externalIndex = path.join(project, "external-index.json");
  const queryPath = path.join(atlasDirectory, "query.txt");
  await rm(externalIndex, { force: true });
  await rm(indexPath);
  await writeFile(externalIndex, "not-json", "utf8");
  await symlink(externalIndex, indexPath);
  await writeFile(queryPath, "OrderAudit", "utf8");

  await assertCliError(
    ["trace-feature", project, "--query-file", queryPath],
    /项目索引必须是[^\n]*普通文件|项目索引不能是符号链接/i,
  );
  assert.equal(await readFile(externalIndex, "utf8"), "not-json");
});

test("CLI rejects a hardlinked standard index before reading a query file", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const indexPath = path.join(atlasDirectory, "index.json");
  const externalIndex = path.join(project, "external-index.json");
  const queryPath = path.join(atlasDirectory, "query.txt");
  await rm(externalIndex, { force: true });
  await rm(indexPath);
  await writeFile(externalIndex, "not-json", "utf8");
  await link(externalIndex, indexPath);
  await writeFile(queryPath, "OrderAudit", "utf8");

  await assertCliError(
    ["trace-feature", project, "--query-file", queryPath],
    /项目索引必须只有一个链接|项目索引不能是硬链接/i,
  );
  assert.equal(await readFile(externalIndex, "utf8"), "not-json");
});

test("prepare-query rejects linked standard indexes", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const indexPath = path.join(atlasDirectory, "index.json");
  const externalIndex = path.join(project, "external-index.json");
  const indexContents = await readFile(indexPath, "utf8");
  await writeFile(externalIndex, indexContents, "utf8");

  if (process.platform !== "win32") {
    await rm(indexPath);
    await symlink(externalIndex, indexPath);
    await assertCliError(
      ["prepare-query", project],
      /项目索引必须是[^\n]*普通文件|项目索引不能是符号链接/i,
    );
  }

  await rm(indexPath);
  await link(externalIndex, indexPath);
  await assertCliError(
    ["prepare-query", project],
    /项目索引必须只有一个链接|项目索引不能是硬链接/i,
  );
});

test("analyze rejects linked standard indexes without modifying their targets", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const indexPath = path.join(atlasDirectory, "index.json");
  const externalIndex = path.join(project, "external-index.json");
  const sentinel = "INDEX_SENTINEL\n";
  await writeFile(externalIndex, sentinel, "utf8");

  if (process.platform !== "win32") {
    await rm(indexPath);
    await symlink(externalIndex, indexPath);
    await assertCliError(
      ["analyze", project],
      /项目索引必须是[^\n]*普通文件|项目索引不能是符号链接/i,
    );
    assert.equal(await readFile(externalIndex, "utf8"), sentinel);
  }

  await rm(indexPath);
  await link(externalIndex, indexPath);
  await assertCliError(
    ["analyze", project],
    /项目索引必须只有一个链接|项目索引不能是硬链接/i,
  );
  assert.equal(await readFile(externalIndex, "utf8"), sentinel);
});

test("CLI ignores linked cache contents and replaces only the project-local cache entry", async (t) => {
  const project = await projectCopy(t);
  await run(process.execPath, [cli, "analyze", project]);
  const atlasDirectory = path.join(project, ".legacy-code-atlas");
  const cachePath = path.join(atlasDirectory, "cache.json");
  const indexPath = path.join(atlasDirectory, "index.json");
  const externalCache = path.join(project, "external-cache.json");
  const poisoned = JSON.parse(await readFile(cachePath, "utf8"));
  const statement = poisoned.entries["sqlmap/order.xml"].record.facts.ibatis.statements[0];
  statement.id = "cachePoison";
  statement.fullId = "cache.cachePoison";
  const externalContents = `${JSON.stringify(poisoned, null, 2)}\n`;
  await writeFile(externalCache, externalContents, "utf8");

  const linkKinds = process.platform === "win32" ? ["hardlink"] : ["symlink", "hardlink"];
  for (const linkKind of linkKinds) {
    await rm(atlasDirectory, { recursive: true, force: true });
    await mkdir(atlasDirectory, { recursive: true });
    if (linkKind === "symlink") await symlink(externalCache, cachePath);
    else await link(externalCache, cachePath);

    await run(process.execPath, [cli, "analyze", project]);

    assert.doesNotMatch(await readFile(indexPath, "utf8"), /cache\.cachePoison/);
    assert.equal(await readFile(externalCache, "utf8"), externalContents);
    assert.equal((await lstat(cachePath)).isSymbolicLink(), false);
    assert.equal(Number((await stat(cachePath)).nlink), 1);
  }
});
