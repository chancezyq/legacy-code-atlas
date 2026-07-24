import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { analyzeProject } from "../src/analyzer.mjs";
import { buildDocumentModel } from "../src/doc-model.mjs";
import { renderDiagrams, renderUiSpec, renderUseCases } from "../src/doc-render.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../bin/legacy-code-atlas.mjs", import.meta.url));
const fixtureRoot = fileURLToPath(new URL("./fixtures/legacy-shop", import.meta.url));

let cachedGraph = null;
async function fixtureGraph() {
  cachedGraph ??= await analyzeProject(fixtureRoot);
  return cachedGraph;
}

function assertNoMachinePaths(text) {
  assert.equal(text.includes(fixtureRoot), false, "output must not contain the project absolute path");
  assert.doesNotMatch(text, /(?:^|[\s:(="'`])\/(?:private|Users|home|tmp|var)\//u);
  assert.doesNotMatch(text, /[A-Za-z]:\\/u);
}

test("document model derives modules, use cases, and page specs from the graph", async () => {
  const graph = await fixtureGraph();
  const model = buildDocumentModel(graph);

  assert.ok(Array.isArray(model.modules) && model.modules.length > 0);
  const orderModule = model.modules.find((module) => module.name === "order");
  assert.ok(orderModule, "URL prefix /order must become module order");
  assert.ok(orderModule.useCases.length >= 4);

  const audit = model.useCases.find((useCase) => useCase.route === "/order/audit.do");
  assert.ok(audit, "route /order/audit.do must become a use case");
  assert.equal(audit.module, "order");
  assert.ok(
    audit.triggers.some((trigger) => trigger.kind === "submits_to" && trigger.pagePath === "web/order/audit.jsp"),
    "the audit form submission must be a trigger",
  );
  const flowNodeIds = audit.mainFlow.map((step) => step.nodeId);
  assert.ok(flowNodeIds.includes("statement:order.insertAuditLog"), "main flow must reach the iBATIS statement");
  assert.ok(flowNodeIds.includes("table:dbo.t_order_audit_log"), "main flow must reach the audit log table");
  assert.ok(audit.mainFlow.every((step) => Number.isInteger(step.index) && step.index >= 1));
  assert.ok(audit.mainFlow.every((step) => step.evidence === null || (
    typeof step.evidence.file === "string" && Number.isInteger(step.evidence.line)
  )));
  assert.deepEqual(
    audit.tables.map((table) => [table.name, table.access]).sort(),
    [["dbo.t_order", "write"], ["dbo.t_order_audit_log", "write"]],
    "audit use case must classify table access from reads_from/writes_to edges",
  );
  assert.equal(typeof audit.minConfidence, "number");

  const auditPage = model.pages.find((page) => page.filePath === "web/order/audit.jsp");
  assert.ok(auditPage, "audit.jsp must become a page spec");
  assert.deepEqual(auditPage.fields, ["orderId", "method", "decision"]);
  assert.ok(auditPage.visibleText.includes("订单审核"));
  assert.ok(
    auditPage.actions.some((action) => action.kind === "submits_to" && action.target === "/order/audit.do"),
    "page actions must include the form submission",
  );
  assert.ok(
    auditPage.actions.some((action) => action.kind === "links_to" && action.target === "/order/list.do"),
    "page actions must include the back link",
  );

  assert.ok(model.stats.useCases >= 10);
  assert.equal(model.stats.pages, 4);
});

test("document model and renderers are deterministic and ignore node order", async () => {
  const graph = await fixtureGraph();
  const shuffled = {
    ...graph,
    nodes: [...graph.nodes].reverse(),
    edges: [...graph.edges].reverse(),
  };
  const first = buildDocumentModel(graph);
  const second = buildDocumentModel(shuffled);
  assert.deepEqual(second, first);
  assert.equal(renderUseCases(second), renderUseCases(first));
  assert.equal(renderUiSpec(second), renderUiSpec(first));
  assert.equal(renderDiagrams(second), renderDiagrams(first));
});

test("rendered use cases cite evidence and never leak machine paths", async () => {
  const graph = await fixtureGraph();
  const markdown = renderUseCases(buildDocumentModel(graph));

  assert.match(markdown, /^# 用例规格/m);
  assert.match(markdown, /## 模块 order/);
  assert.match(markdown, /\/order\/audit\.do/);
  assert.match(markdown, /web\/order\/audit\.jsp:\d+/);
  assert.match(markdown, /dbo\.t_order_audit_log/);
  assert.match(markdown, /写/);
  assertNoMachinePaths(markdown);
});

test("rendered UI spec covers page fields, actions, and arrival paths", async () => {
  const graph = await fixtureGraph();
  const markdown = renderUiSpec(buildDocumentModel(graph));

  assert.match(markdown, /^# 界面规格/m);
  assert.match(markdown, /audit\.jsp/);
  assert.match(markdown, /orderId/);
  assert.match(markdown, /decision/);
  assert.match(markdown, /\/order\/audit\.do/);
  assert.match(markdown, /订单审核/);
  assertNoMachinePaths(markdown);
});

test("rendered diagrams are valid Mermaid with escaped labels", async () => {
  const graph = await fixtureGraph();
  const model = buildDocumentModel(graph);
  const markdown = renderDiagrams(model);

  assert.match(markdown, /^# 系统图/m);
  const mermaidBlocks = [...markdown.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)];
  assert.ok(mermaidBlocks.length >= 2, "must emit at least one flowchart and one sequence diagram");
  assert.ok(mermaidBlocks.some((block) => /^flowchart LR/m.test(block[1])));
  assert.ok(mermaidBlocks.some((block) => /^sequenceDiagram/m.test(block[1])));
  for (const block of mermaidBlocks) {
    assert.doesNotMatch(block[1], /```/, "mermaid content must not close its own fence");
  }
  assertNoMachinePaths(markdown);
});

test("hostile node names cannot escape Mermaid labels or Markdown structure", () => {
  const hostileGraph = {
    schemaVersion: "1.0.0",
    project: { root: "X" },
    summary: { nodes: 3, edges: 2, nodeTypes: { page: 1, route: 1, table: 1 }, edgeTypes: { submits_to: 1, writes_to: 1 } },
    warnings: [],
    nodes: [
      {
        id: "page:evil.jsp",
        type: "page",
        name: 'evil"]; click A href "https://x',
        filePath: "web/evil.jsp",
        evidence: [],
        data: { visibleText: "```mermaid\nflowchart LR", fields: ["a`b", 'c"d'] },
        searchText: [],
      },
      {
        id: "route:/evil[box]",
        type: "route",
        name: "/evil[box]--><script>",
        evidence: [{ file: "web/evil.jsp", line: 1, column: 1, snippet: "x" }],
        data: {},
        searchText: [],
      },
      { id: "table:dbo.t", type: "table", name: "dbo.t", evidence: [], data: {}, searchText: [] },
    ],
    edges: [
      {
        id: "e1", source: "page:evil.jsp", target: "route:/evil[box]", type: "submits_to",
        confidence: 1, reason: "form", evidence: [{ file: "web/evil.jsp", line: 1, column: 1, snippet: "x" }], data: {},
      },
      {
        id: "e2", source: "route:/evil[box]", target: "table:dbo.t", type: "writes_to",
        confidence: 1, reason: "sql", evidence: [], data: {},
      },
    ],
  };
  const model = buildDocumentModel(hostileGraph);
  const diagrams = renderDiagrams(model);
  const mermaidBlocks = [...diagrams.matchAll(/```mermaid\r?\n([\s\S]*?)```/g)];
  assert.ok(mermaidBlocks.length >= 1);
  for (const block of mermaidBlocks) {
    assert.doesNotMatch(block[1], /^\s*click /m, "hostile label must not produce a Mermaid click directive");
    assert.doesNotMatch(block[1], /"/, "raw double quotes must never reach Mermaid source");
    assert.doesNotMatch(block[1], /`/, "raw backticks must never reach Mermaid source");
  }
  const useCases = renderUseCases(model);
  assert.doesNotMatch(useCases, /```mermaid\r?\n```/, "visible text must not open stray fences");
  assert.doesNotMatch(`${useCases}${renderUiSpec(model)}`, /^```/m, "hostile content must not inject code fences at line start");
});

test("renderers cap output size with an explicit truncation notice", () => {
  const nodes = [];
  const edges = [];
  const routeCount = 1200;
  for (let index = 0; index < routeCount; index += 1) {
    nodes.push({
      id: `route:/m${index % 5}/u${index}.do`,
      type: "route",
      name: `/m${index % 5}/u${index}.do`,
      evidence: [{ file: "web/a.jsp", line: 1, column: 1, snippet: "x" }],
      data: {},
      searchText: [],
    });
  }
  const graph = {
    schemaVersion: "1.0.0",
    project: { root: "X" },
    summary: {
      nodes: nodes.length,
      edges: 0,
      nodeTypes: { route: routeCount },
      edgeTypes: {},
    },
    warnings: [],
    nodes,
    edges,
  };
  const model = buildDocumentModel(graph);
  assert.ok(model.truncated, "model must flag dropped use cases beyond the cap");
  assert.ok(model.useCases.length <= 200);
  const markdown = renderUseCases(model);
  assert.match(markdown, /已截断/);
});

test("table access classification distinguishes read, write, and read-write", () => {
  const evidence = [{ file: "web/a.jsp", line: 1, column: 1, snippet: "x" }];
  const graph = {
    schemaVersion: "1.0.0",
    project: { root: "X" },
    summary: {
      nodes: 4,
      edges: 3,
      nodeTypes: { route: 1, statement: 1, table: 2 },
      edgeTypes: { uses_statement: 1, reads_from: 1, writes_to: 1 },
    },
    warnings: [],
    nodes: [
      { id: "route:/r/a.do", type: "route", name: "/r/a.do", evidence, data: {}, searchText: [] },
      { id: "statement:s.q", type: "statement", name: "s.q", evidence, data: {}, searchText: [] },
      { id: "table:dbo.x", type: "table", name: "dbo.x", evidence: [], data: {}, searchText: [] },
      { id: "table:dbo.y", type: "table", name: "dbo.y", evidence: [], data: {}, searchText: [] },
    ],
    edges: [
      { id: "e1", source: "route:/r/a.do", target: "statement:s.q", type: "uses_statement", confidence: 1, reason: "", evidence, data: {} },
      { id: "e2", source: "statement:s.q", target: "table:dbo.x", type: "reads_from", confidence: 1, reason: "", evidence, data: {} },
      { id: "e3", source: "statement:s.q", target: "table:dbo.x", type: "writes_to", confidence: 0.9, reason: "", evidence, data: {} },
    ],
  };
  const readWrite = buildDocumentModel(graph);
  const useCase = readWrite.useCases.find((entry) => entry.route === "/r/a.do");
  assert.deepEqual(useCase.tables, [{ name: "dbo.x", access: "read-write" }]);

  const readOnly = buildDocumentModel({
    ...graph,
    summary: { ...graph.summary, edges: 2, edgeTypes: { uses_statement: 1, reads_from: 1 } },
    edges: graph.edges.slice(0, 2),
  });
  assert.deepEqual(
    readOnly.useCases.find((entry) => entry.route === "/r/a.do").tables,
    [{ name: "dbo.x", access: "read" }],
  );
});

test("docs CLI writes the three documents and reports them", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-docs-cli-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await rm(path.join(projectRoot, ".legacy-code-atlas"), { recursive: true, force: true });

  const result = await run(process.execPath, [cli, "docs", projectRoot]);
  assert.match(result.stdout, /use-cases\.md/);
  assert.match(result.stdout, /ui-spec\.md/);
  assert.match(result.stdout, /diagrams\.md/);

  const docsDir = path.join(projectRoot, ".legacy-code-atlas", "docs");
  const entries = (await readdir(docsDir)).sort();
  assert.deepEqual(entries, ["diagrams.md", "ui-spec.md", "use-cases.md"]);

  const useCases = await readFile(path.join(docsDir, "use-cases.md"), "utf8");
  assert.match(useCases, /\/order\/audit\.do/);
  assert.equal(useCases.includes(projectRoot), false, "generated docs must not embed the machine path");

  const jsonResult = await run(process.execPath, [cli, "docs", projectRoot, "--json"]);
  const parsed = JSON.parse(jsonResult.stdout);
  assert.deepEqual(
    parsed.files.map((file) => file.split("/").pop()).sort(),
    ["diagrams.md", "ui-spec.md", "use-cases.md"],
  );
  assert.ok(parsed.stats.useCases >= 10);
  assert.ok(parsed.stats.pages >= 4);
});

test("CLI help documents the docs command", async () => {
  const help = await run(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /docs <project>[^\n]*--json/);
});

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // executed directly: nothing extra
}
