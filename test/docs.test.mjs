import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, cp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { analyzeProject } from "../src/analyzer.mjs";
import { buildDocumentModel, scopeSlug } from "../src/doc-model.mjs";
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
  assert.ok(
    audit.triggers.every((trigger) => typeof trigger.confidence === "number"),
    "triggers must carry the edge confidence",
  );
  assert.deepEqual(audit.request.methods, ["POST"], "request methods must come from route requestHints");
  assert.ok(
    audit.request.parameters.includes("orderId") && audit.request.parameters.includes("method"),
    "request parameters must list submitted form parameters",
  );
  assert.ok(
    audit.outcomes.some((outcome) => outcome.reason.includes("success") && outcome.target.endsWith("auditSuccess.jsp")),
    "Struts success forward must become an outcome",
  );
  assert.ok(
    audit.outcomes.some((outcome) => outcome.reason.includes("error") && outcome.target.endsWith("audit.jsp")),
    "Struts error forward must become an alternate outcome",
  );
  assert.deepEqual(audit.inputs, ["orderId", "method", "decision"], "inputs must come from the trigger form evidence");
  assert.ok(
    audit.statements.some((statement) => statement.id === "order.insertAuditLog" && statement.operation === "insert"),
    "statements must carry the SQL operation type",
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
  assert.deepEqual(
    auditPage.fields.map((field) => field.name),
    ["orderId", "method", "decision"],
  );
  assert.equal(
    auditPage.fields.find((field) => field.name === "method")?.defaultValue,
    "audit",
    "field defaults must come from the submitted route requestHints",
  );
  assert.ok(auditPage.visibleText.includes("订单审核"));
  assert.ok(
    auditPage.actions.some((action) => action.kind === "submits_to" && action.target === "/order/audit.do" && action.method === "POST"),
    "page actions must include the form submission with its HTTP method",
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

  assert.match(markdown, /^# Use Case Specifications/m);
  assert.match(markdown, /## Module order/);
  assert.match(markdown, /\/order\/audit\.do/);
  assert.match(markdown, /web\/order\/audit\.jsp:\d+/);
  assert.match(markdown, /dbo\.t_order_audit_log/);
  assert.match(markdown, /\(write\)/);
  assertNoMachinePaths(markdown);
});

test("rendered UI spec covers page fields, actions, and arrival paths", async () => {
  const graph = await fixtureGraph();
  const markdown = renderUiSpec(buildDocumentModel(graph));

  assert.match(markdown, /^# UI Specifications/m);
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

  assert.match(markdown, /^# System Diagrams/m);
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
  assert.match(markdown, /truncated/);
});

test("navigation edge caps retain relationships and only their referenced nodes", () => {
  const outcomes = Array.from({ length: 60_000 }, (_, index) => ({
    kind: "forwards_to",
    reason: `result-${index}`,
    target: `page-${index}.jsp`,
    targetId: `page:generated/page-${index}.jsp`,
    targetPath: `generated/page-${index}.jsp`,
    targetType: "page",
  }));
  const useCase = {
    route: "/large/navigation.do",
    routeId: "route:/large/navigation.do",
    triggers: [],
    outcomes,
    mainFlow: [],
    tables: [],
  };
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules: [],
    useCases: [useCase],
  });
  const navigation = markdown.match(/## Screen navigation[\s\S]*?```mermaid\r?\n([\s\S]*?)```/u)?.[1] ?? "";
  const fences = markdown.match(/^```/gm) ?? [];
  const edges = navigation.match(/^  s\d+ (?:-->|-.->)\|[^|]+\| s\d+$/gmu) ?? [];
  const nodes = navigation.match(/^  s\d+(?:\(\[[^\]]*\]\)|\[[^\]]*\])$/gmu) ?? [];

  assert.ok(Buffer.byteLength(markdown) <= 1024 * 1024);
  assert.equal(edges.length, 120, "the navigation edge cap must retain actual relationships");
  assert.equal(nodes.length, 121, "only the route and retained edge targets should be declared");
  assert.equal(fences.length % 2, 0, "capped Markdown must close every code fence");
  assert.doesNotMatch(markdown, /output reached the safety limit/);
  assert.match(markdown, /number of entries exceeded the generation cap/);
});

test("module edge caps retain relationships and only their referenced nodes", () => {
  const route = "/large/module.do";
  const useCase = {
    route,
    routeId: `route:${route}`,
    triggers: Array.from({ length: 60_000 }, (_, index) => ({
      kind: "submits_to",
      pageId: `page:generated/module-${index}.jsp`,
      pagePath: `generated/module-${index}.jsp`,
      confidence: 1,
    })),
    outcomes: [],
    mainFlow: [{ nodeId: `route:${route}`, nodeType: "route", name: route, via: null, confidence: 1 }],
    tables: [],
  };
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules: [{ name: "large", useCases: [useCase] }],
    useCases: [],
  });
  const moduleBlock = markdown.match(/## Module overview: large[\s\S]*?```mermaid\r?\n([\s\S]*?)```/u)?.[1] ?? "";
  const edges = moduleBlock.match(/^  n\d+ (?:-->|-.->)\|[^|]+\| n\d+$/gmu) ?? [];
  const nodes = moduleBlock.match(/^  n\d+(?:\(\[[^\]]*\]\)|\[[^\]]*\])$/gmu) ?? [];

  assert.ok(Buffer.byteLength(markdown) <= 1024 * 1024);
  assert.equal(edges.length, 120, "the module edge cap must retain actual relationships");
  assert.equal(nodes.length, 121, "only the route and retained edge sources should be declared");
  assert.doesNotMatch(markdown, /output reached the safety limit/);
  assert.match(markdown, /number of entries exceeded the generation cap/);
});

test("route-only module diagrams retain their standalone route node", () => {
  const route = "/standalone/status.do";
  const useCase = {
    route,
    routeId: `route:${route}`,
    triggers: [],
    outcomes: [],
    mainFlow: [{ nodeId: `route:${route}`, nodeType: "route", name: route, via: null, confidence: 1 }],
    tables: [],
  };
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules: [{ name: "standalone", useCases: [useCase] }],
    useCases: [useCase],
  });
  const moduleBlock = markdown.match(/## Module overview: standalone[\s\S]*?```mermaid\r?\n([\s\S]*?)```/u)?.[1] ?? "";

  assert.match(moduleBlock, /^  n0\(\[\/standalone\/status[.]do\]\)$/mu);
  assert.doesNotMatch(moduleBlock, /^  n\d+ (?:-->|-.->)/mu);
});

test("diagram byte truncation closes the active Mermaid fence before its warning", () => {
  const modules = Array.from({ length: 30 }, (_, moduleIndex) => {
    const route = `/large/${moduleIndex}.do`;
    const useCase = {
      route,
      routeId: `route:${route}`,
      triggers: Array.from({ length: 120 }, (_, triggerIndex) => ({
        kind: "submits_to",
        pageId: `page:${moduleIndex}:${triggerIndex}`,
        pagePath: `generated/${moduleIndex}/${triggerIndex}.jsp`,
        confidence: 1,
      })),
      outcomes: [],
      mainFlow: [{ nodeId: `route:${route}`, nodeType: "route", name: route, via: null, confidence: 1 }],
      tables: [],
    };
    return { name: `${moduleIndex}-${"m".repeat(32 * 1024)}`, useCases: [useCase] };
  });
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules,
    useCases: modules.flatMap((module) => module.useCases),
  });
  const fences = markdown.match(/^```/gm) ?? [];
  const warningOffset = markdown.indexOf("> Warning: output reached the safety limit");

  assert.ok(Buffer.byteLength(markdown) <= 1024 * 1024);
  assert.ok(warningOffset >= 0, "the fixture must reach the byte limit");
  assert.equal(fences.length % 2, 0, "truncated Markdown must close every code fence");
  assert.ok(warningOffset > markdown.lastIndexOf("```"), "the warning must be outside Mermaid");
});

test("module overview diagrams retain the Java and SQL main-flow layers", () => {
  const useCase = {
    route: "/orders/save.do",
    routeId: "route:/orders/save.do",
    triggers: [{
      kind: "submits_to",
      pagePath: "web/orders/edit.jsp",
      confidence: 1,
    }],
    outcomes: [],
    tables: [{ name: "dbo.orders", access: "write" }],
    mainFlow: [
      { nodeId: "route:/orders/save.do", nodeType: "route", name: "/orders/save.do", via: null },
      { nodeId: "java_method:OrderAction#save/0", nodeType: "java_method", name: "OrderAction.save", via: "dispatches_to" },
      { nodeId: "statement:orders.save", nodeType: "statement", name: "orders.save", via: "uses_statement" },
      { nodeId: "table:dbo.orders", nodeType: "table", name: "dbo.orders", via: "writes_to" },
    ],
  };
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules: [{ name: "orders", useCases: [useCase] }],
    useCases: [useCase],
  });
  const moduleBlock = markdown.match(/## Module overview: orders[\s\S]*?```mermaid\n([\s\S]*?)```/)?.[1];

  assert.ok(moduleBlock, "module overview Mermaid block must exist");
  assert.match(moduleBlock, /OrderAction[.]save/);
  assert.match(moduleBlock, /orders[.]save/);
  assert.match(moduleBlock, /dbo[.]orders/);
  assert.match(moduleBlock, /-->|-.->/);
  assert.match(markdown, /Java methods/);
  assert.match(markdown, /SQL statements/);
});

test("module overview preserves aggregate read-write access when the main flow shows one access", () => {
  const useCase = {
    route: "/orders/sync.do",
    routeId: "route:/orders/sync.do",
    triggers: [],
    outcomes: [],
    tables: [{ name: "dbo.orders", access: "read-write" }],
    mainFlow: [
      { nodeId: "route:/orders/sync.do", nodeType: "route", name: "/orders/sync.do", via: null, confidence: 1 },
      { nodeId: "statement:orders.read", nodeType: "statement", name: "orders.read", via: "uses_statement", confidence: 1 },
      { nodeId: "table:dbo.orders", nodeType: "table", name: "dbo.orders", via: "reads_from", confidence: 1 },
    ],
  };
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules: [{ name: "orders", useCases: [useCase] }],
    useCases: [useCase],
  });
  const moduleBlock = markdown.match(/## Module overview: orders[\s\S]*?```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
  const routeId = moduleBlock.match(/^  (n\d+)\(\[\/orders\/sync[.]do\]\)$/mu)?.[1];
  const statementId = moduleBlock.match(/^  (n\d+)\{\{orders[.]read\}\}$/mu)?.[1];
  const tableId = moduleBlock.match(/^  (n\d+)\[\(dbo[.]orders\)\]$/mu)?.[1];

  assert.ok(routeId && statementId && tableId);
  assert.match(moduleBlock, new RegExp(`^  ${statementId} -->\\|reads_from\\| ${tableId}$`, "mu"));
  assert.match(moduleBlock, new RegExp(`^  ${routeId} -->\\|read-write\\| ${tableId}$`, "mu"));
});

test("module overview diagrams preserve confidence on main-flow edges", () => {
  const evidence = [{ file: "struts.xml", line: 4, column: 3, snippet: "action" }];
  const route = {
    id: "route:/orders/save.do",
    type: "route",
    name: "/orders/save.do",
    evidence,
    data: {},
    searchText: [],
  };
  const method = {
    id: "java_method:OrderAction#save/0",
    type: "java_method",
    name: "OrderAction.save",
    evidence,
    data: {},
    searchText: [],
  };
  const mapping = {
    id: "mapping",
    source: route.id,
    target: method.id,
    type: "maps_to",
    confidence: 0.8,
    reason: "inferred mapping",
    evidence,
    data: {},
  };

  const model = buildDocumentModel({ nodes: [route, method], edges: [mapping] });
  assert.equal(model.useCases[0].mainFlow[1].confidence, 0.8);

  const markdown = renderDiagrams(model);
  const moduleBlock = markdown.match(/## Module overview: orders[\s\S]*?```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
  assert.match(moduleBlock, /-.->\|maps_to\|/);
  assert.match(markdown, /dashed edges are heuristic relationships/);
  const sequenceBlock = markdown.match(/## Use case sequence: \/orders\/save[.]do[\s\S]*?```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
  assert.match(sequenceBlock, /P0-->>P1: maps_to \(heuristic\)/);
});

test("screen navigation preserves trigger and outcome confidence", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "route" }];
  const page = {
    id: "page:web/start.jsp",
    type: "page",
    name: "start.jsp",
    filePath: "web/start.jsp",
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  };
  const route = { id: "route:/start.do", type: "route", name: "/start.do", evidence, data: {}, searchText: [] };
  const result = {
    id: "page:web/result.jsp",
    type: "page",
    name: "result.jsp",
    filePath: "web/result.jsp",
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  };
  const edges = [
    { id: "trigger", source: page.id, target: route.id, type: "submits_to", confidence: 0.8, reason: "inferred form", evidence, data: {} },
    { id: "outcome", source: route.id, target: result.id, type: "forwards_to", confidence: 0.7, reason: "inferred forward", evidence, data: {} },
  ];

  const markdown = renderDiagrams(buildDocumentModel({ nodes: [page, route, result], edges }));
  const navigation = markdown.match(/## Screen navigation[\s\S]*?```mermaid\n([\s\S]*?)```/)?.[1] ?? "";

  assert.match(navigation, /-.->\|submits_to\|/);
  assert.match(navigation, /-.->\|inferred forward\|/);
  assert.match(markdown, /dashed edges are heuristic relationships/);
});

test("empty document models render explicit empty states", () => {
  const model = {
    scope: null,
    truncated: false,
    modules: [],
    useCases: [],
    pages: [],
    stats: { modules: 0, useCases: 0, pages: 0 },
  };

  assert.match(renderUseCases(model), /no use cases/i);
  assert.match(renderUiSpec(model), /no pages/i);
  assert.match(renderDiagrams(model), /no diagram relationships/i);
});

test("diagram edge and sequence caps are always reported", () => {
  const outcomes = Array.from({ length: 121 }, (_, index) => ({
    kind: "forwards_to",
    reason: `result-${index}`,
    target: `page-${index}.jsp`,
    targetId: `page:generated/page-${index}.jsp`,
    targetPath: `generated/page-${index}.jsp`,
    targetType: "page",
  }));
  const navigationUseCase = {
    route: "/capped/navigation.do",
    routeId: "route:/capped/navigation.do",
    triggers: [],
    outcomes,
    mainFlow: [],
    tables: [],
  };
  const sequenceUseCases = Array.from({ length: 21 }, (_, index) => ({
    route: `/sequence/${index}.do`,
    routeId: `route:/sequence/${index}.do`,
    triggers: [],
    outcomes: [],
    tables: [],
    mainFlow: [
      { nodeId: `route:/sequence/${index}.do`, nodeType: "route", name: `/sequence/${index}.do`, via: null },
      { nodeId: `java_method:Sequence${index}#run/0`, nodeType: "java_method", name: `Sequence${index}.run`, via: "dispatches_to" },
    ],
  }));
  const markdown = renderDiagrams({
    scope: null,
    truncated: false,
    modules: [],
    useCases: [navigationUseCase, ...sequenceUseCases],
  });

  assert.equal((markdown.match(/^## Use case sequence:/gm) ?? []).length, 20);
  assert.ok(
    (markdown.match(/number of entries exceeded the generation cap/g) ?? []).length >= 2,
    "both the navigation-edge cap and the sequence-diagram cap must be reported",
  );
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

test("docs CLI rejects a linked output directory without writing outside the project", {
  skip: process.platform === "win32",
}, async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-docs-link-"));
  const externalRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-docs-external-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  t.after(() => rm(externalRoot, { recursive: true, force: true }));
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await run(process.execPath, [cli, "analyze", projectRoot]);
  await symlink(externalRoot, path.join(projectRoot, ".legacy-code-atlas", "docs"), "dir");

  await assert.rejects(
    run(process.execPath, [cli, "docs", projectRoot]),
    (error) => /docs.*(?:真实目录|符号链接|junction)/u.test(error.stderr),
  );
  assert.deepEqual(await readdir(externalRoot), []);
});

test("CLI help documents the docs command", async () => {
  const help = await run(process.execPath, [cli, "--help"]);
  assert.match(help.stdout, /docs <project>[^\n]*--json/);
  assert.match(help.stdout, /docs <project>[^\n]*--query-file[^\n]*--no-match-ok/);
});

test("document model scopes to a module by exact name", async () => {
  const graph = await fixtureGraph();
  const scoped = buildDocumentModel(graph, { scopeQuery: "order" });

  assert.equal(scoped.scope.kind, "module");
  assert.equal(scoped.scope.query, "order");
  assert.ok(scoped.scope.matched);
  assert.deepEqual(scoped.modules.map((module) => module.name), ["order"]);
  assert.ok(scoped.useCases.every((useCase) => useCase.module === "order"));
  assert.ok(scoped.useCases.some((useCase) => useCase.route === "/order/audit.do"));
  assert.ok(
    scoped.pages.some((page) => page.filePath === "web/order/audit.jsp"),
    "pages reachable from scoped use cases must be included",
  );
  assert.ok(
    scoped.pages.every((page) => page.filePath !== "/common/tags.jsp" || scoped.useCases.length > 0),
  );
  assert.ok(scoped.stats.useCases < buildDocumentModel(graph).stats.useCases);
});

test("document model scopes to a feature by search when no module matches", async () => {
  const graph = await fixtureGraph();
  const scoped = buildDocumentModel(graph, { scopeQuery: "audit" });

  assert.equal(scoped.scope.kind, "feature");
  assert.ok(scoped.scope.matched);
  assert.deepEqual(scoped.useCases.map(({ route }) => route), [
    "/api/orders/list",
    "/order/audit.do",
    "/order/audit/history.do",
    "/order/audit/status.do",
    "/order/detail.do",
    "/order/permission/check.do",
  ]);
  assert.ok(scoped.pages.some((page) => page.filePath === "web/order/audit.jsp"));

  const noMatch = buildDocumentModel(graph, { scopeQuery: "nonexistent-feature-xyz" });
  assert.equal(noMatch.scope.matched, false);
  assert.deepEqual(noMatch.useCases, []);
  assert.deepEqual(noMatch.pages, []);
});

test("scoped renderers state the scope in the document header", async () => {
  const graph = await fixtureGraph();
  const scoped = buildDocumentModel(graph, { scopeQuery: "order" });
  const useCases = renderUseCases(scoped);
  const uiSpec = renderUiSpec(scoped);
  const diagrams = renderDiagrams(scoped);

  for (const markdown of [useCases, uiSpec, diagrams]) {
    assert.match(markdown, /Scope: module `order`/);
  }
  assert.doesNotMatch(useCases, /## Module api/);
});

test("docs CLI generates scoped documents from a query file", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-docs-scope-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await rm(path.join(projectRoot, ".legacy-code-atlas"), { recursive: true, force: true });

  await run(process.execPath, [cli, "analyze", projectRoot]);
  await run(process.execPath, [cli, "prepare-query", projectRoot]);
  const queryPath = path.join(projectRoot, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "order", "utf8");

  const result = await run(process.execPath, [
    cli, "docs", projectRoot, "--query-file", queryPath, "--no-match-ok",
  ]);
  assert.match(result.stdout, /scoped\/order\/use-cases\.md/);

  const scopedDir = path.join(projectRoot, ".legacy-code-atlas", "docs", "scoped", "order");
  const entries = (await readdir(scopedDir)).sort();
  assert.deepEqual(entries, ["diagrams.md", "ui-spec.md", "use-cases.md"]);
  const useCases = await readFile(path.join(scopedDir, "use-cases.md"), "utf8");
  assert.match(useCases, /Scope: module `order`/);
  assert.match(useCases, /\/order\/audit\.do/);
  assert.doesNotMatch(useCases, /## Module api/);
  assert.equal(useCases.includes(projectRoot), false);

  await run(process.execPath, [cli, "prepare-query", projectRoot]);
  await writeFile(queryPath, "OrderAudit", "utf8");
  const featureResult = await run(process.execPath, [
    cli, "docs", projectRoot, "--query-file", queryPath, "--no-match-ok", "--json",
  ]);
  const parsed = JSON.parse(featureResult.stdout);
  assert.equal(parsed.scope.kind, "feature");
  assert.ok(parsed.scope.matched);
  assert.ok(parsed.files.every((file) => file.includes("docs/scoped/orderaudit/")));

  await run(process.execPath, [cli, "prepare-query", projectRoot]);
  await writeFile(queryPath, "totally-missing-thing", "utf8");
  const noMatch = await run(process.execPath, [
    cli, "docs", projectRoot, "--query-file", queryPath, "--no-match-ok",
  ]);
  assert.match(noMatch.stdout, /no match/i);

  await run(process.execPath, [cli, "prepare-query", projectRoot]);
  await writeFile(queryPath, "totally-missing-thing", "utf8");
  await assert.rejects(
    run(process.execPath, [cli, "docs", projectRoot, "--query-file", queryPath]),
    (error) => {
      assert.equal(error.code, 3);
      return true;
    },
    "without --no-match-ok a no-match scope must exit 3",
  );
});

test("scoped docs directory names stay safe for hostile queries", async (t) => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-docs-slug-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await cp(fixtureRoot, projectRoot, { recursive: true });
  await rm(path.join(projectRoot, ".legacy-code-atlas"), { recursive: true, force: true });

  await run(process.execPath, [cli, "analyze", projectRoot]);
  await run(process.execPath, [cli, "prepare-query", projectRoot]);
  const queryPath = path.join(projectRoot, ".legacy-code-atlas", "query.txt");
  await writeFile(queryPath, "../..\\evil order", "utf8");

  const result = await run(process.execPath, [
    cli, "docs", projectRoot, "--query-file", queryPath, "--no-match-ok", "--json",
  ]);
  const parsed = JSON.parse(result.stdout);
  for (const file of parsed.files ?? []) {
    assert.match(file, /^\.legacy-code-atlas\/docs\/scoped\/[a-z0-9-]+\/[a-z-]+\.md$/);
  }
  const scopedRoot = path.join(projectRoot, ".legacy-code-atlas", "docs", "scoped");
  for (const entry of await readdir(scopedRoot)) {
    assert.match(entry, /^[a-z0-9-]+$/, "scope directory names must be slugs");
  }
});

test("scoped documents apply route and page caps after selecting a module", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "x" }];
  const nodes = [];
  const edges = [];
  for (let index = 0; index <= 200; index += 1) {
    const moduleName = `m${String(index).padStart(3, "0")}`;
    const routeId = `route:/${moduleName}/view.do`;
    const pageId = `page:web/${moduleName}/view.jsp`;
    nodes.push(
      {
        id: routeId,
        type: "route",
        name: `/${moduleName}/view.do`,
        evidence,
        data: {},
        searchText: [],
      },
      {
        id: pageId,
        type: "page",
        name: "view.jsp",
        filePath: `web/${moduleName}/view.jsp`,
        evidence,
        data: { fields: [], visibleText: moduleName },
        searchText: [],
      },
    );
    edges.push({
      id: `edge:${moduleName}`,
      source: pageId,
      target: routeId,
      type: "submits_to",
      confidence: 1,
      reason: "form request",
      evidence,
      data: {},
    });
  }

  const scoped = buildDocumentModel({ nodes, edges }, { scopeQuery: "m200" });

  assert.deepEqual(scoped.scope, {
    kind: "module",
    query: "m200",
    matched: true,
    slug: "m200",
  });
  assert.deepEqual(scoped.useCases.map((useCase) => useCase.route), ["/m200/view.do"]);
  assert.deepEqual(scoped.pages.map((page) => page.filePath), ["web/m200/view.jsp"]);
  assert.equal(scoped.truncated, false, "a one-route scope must not inherit whole-project truncation");
  assert.equal(scoped.stats.routesTotal, 201);
  assert.equal(scoped.stats.pagesTotal, 201);
});

test("feature scope follows every reachable flow branch instead of only the displayed main flow", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "x" }];
  const nodes = [
    { id: "route:/orders/view.do", type: "route", name: "/orders/view.do", evidence, data: {}, searchText: [] },
    { id: "statement:a", type: "statement", name: "a", evidence, data: { type: "select" }, searchText: [] },
    { id: "table:a", type: "table", name: "dbo.a", evidence, data: {}, searchText: [] },
    { id: "statement:z", type: "statement", name: "z", evidence, data: { type: "select" }, searchText: [] },
    { id: "table:z", type: "table", name: "dbo.z", evidence, data: {}, searchText: ["alternate-needle"] },
  ];
  const edge = (id, source, target, type) => ({
    id,
    source,
    target,
    type,
    confidence: 1,
    reason: "",
    evidence,
    data: {},
  });
  const edges = [
    edge("e1", "route:/orders/view.do", "statement:a", "uses_statement"),
    edge("e2", "statement:a", "table:a", "reads_from"),
    edge("e3", "route:/orders/view.do", "statement:z", "uses_statement"),
    edge("e4", "statement:z", "table:z", "reads_from"),
  ];

  const unscoped = buildDocumentModel({ nodes, edges });
  assert.deepEqual(unscoped.useCases[0].mainFlow.map((step) => step.nodeId), [
    "route:/orders/view.do",
    "statement:a",
    "table:a",
  ]);
  assert.ok(unscoped.useCases[0].tables.some((table) => table.name === "dbo.z"));

  const scoped = buildDocumentModel({ nodes, edges }, { scopeQuery: "alternate-needle" });
  assert.equal(scoped.scope.matched, true);
  assert.deepEqual(scoped.useCases.map((useCase) => useCase.route), ["/orders/view.do"]);
});

test("feature scope considers every search match before selecting routes", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "x" }];
  const route = {
    id: "route:/orders/only.do",
    type: "route",
    name: "/orders/only.do",
    evidence,
    data: {},
    searchText: [],
  };
  const unrelatedMatches = Array.from({ length: 500 }, (_, index) => ({
    id: `table:a${String(index).padStart(3, "0")}`,
    type: "table",
    name: `dbo.a${index}`,
    evidence,
    data: {},
    searchText: ["scope-needle"],
  }));
  const connectedMatch = {
    id: "table:z-connected",
    type: "table",
    name: "dbo.connected",
    evidence,
    data: {},
    searchText: ["scope-needle"],
  };
  const edges = [{
    id: "e-connected",
    source: route.id,
    target: connectedMatch.id,
    type: "reads_from",
    confidence: 1,
    reason: "query",
    evidence,
    data: {},
  }];

  const scoped = buildDocumentModel({ nodes: [route, ...unrelatedMatches, connectedMatch], edges }, {
    scopeQuery: "scope-needle",
  });

  assert.equal(scoped.scope.matched, true);
  assert.deepEqual(scoped.useCases.map((useCase) => useCase.route), ["/orders/only.do"]);
});

test("a matched page adds only its direct submission route", () => {
  const evidence = [{ file: "web/feature.jsp", line: 1, column: 1, snippet: "x" }];
  const page = {
    id: "page:web/feature.jsp",
    type: "page",
    name: "feature.jsp",
    filePath: "web/feature.jsp",
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: ["page-only-needle"],
  };
  const entryRoute = {
    id: "route:/feature/entry.do",
    type: "route",
    name: "/feature/entry.do",
    evidence,
    data: {},
    searchText: [],
  };
  const upstreamRoute = {
    id: "route:/feature/upstream.do",
    type: "route",
    name: "/feature/upstream.do",
    evidence,
    data: {},
    searchText: [],
  };
  const edge = (id, source, target, type) => ({
    id,
    source,
    target,
    type,
    confidence: 1,
    reason: "",
    evidence,
    data: {},
  });
  const edges = [
    edge("e-submit", page.id, entryRoute.id, "submits_to"),
    edge("e-redirect", upstreamRoute.id, entryRoute.id, "redirects_to"),
  ];

  const scoped = buildDocumentModel({ nodes: [page, entryRoute, upstreamRoute], edges }, {
    scopeQuery: "page-only-needle",
  });

  assert.deepEqual(scoped.useCases.map((useCase) => useCase.route), ["/feature/entry.do"]);
  assert.deepEqual(scoped.pages.map((entry) => entry.filePath), ["web/feature.jsp"]);
});

test("page request metadata is selected by action evidence for shared routes", () => {
  const requestEvidence = (file, line) => ({ file, line, column: 3, snippet: "form" });
  const firstEvidence = requestEvidence("web/a.jsp", 10);
  const secondEvidence = requestEvidence("web/b.jsp", 20);
  const route = {
    id: "route:/shared.do",
    type: "route",
    name: "/shared.do",
    evidence: [firstEvidence, secondEvidence],
    data: {
      requestHints: [
        { method: "POST", parameters: { mode: "save" }, evidence: firstEvidence },
        { method: "GET", parameters: { mode: "list" }, evidence: secondEvidence },
      ],
    },
    searchText: [],
  };
  const pages = [
    {
      id: "page:web/a.jsp",
      type: "page",
      name: "a.jsp",
      filePath: "web/a.jsp",
      evidence: [firstEvidence],
      data: { fields: ["mode"], visibleText: "A" },
      searchText: [],
    },
    {
      id: "page:web/b.jsp",
      type: "page",
      name: "b.jsp",
      filePath: "web/b.jsp",
      evidence: [secondEvidence],
      data: { fields: ["mode"], visibleText: "B" },
      searchText: [],
    },
  ];
  const edges = pages.map((page, index) => ({
    id: `edge:${index}`,
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [index === 0 ? firstEvidence : secondEvidence],
    data: {},
  }));

  const model = buildDocumentModel({ nodes: [...pages, route], edges });
  assert.deepEqual(
    model.pages.map((page) => ({
      filePath: page.filePath,
      defaultValue: page.fields[0].defaultValue,
      method: page.actions[0].method,
    })),
    [
      { filePath: "web/a.jsp", defaultValue: "save", method: "POST" },
      { filePath: "web/b.jsp", defaultValue: "list", method: "GET" },
    ],
  );
});

test("page request metadata preserves multiple forms targeting the same route", () => {
  const firstEvidence = { file: "web/order.jsp", line: 10, column: 3, snippet: "save form" };
  const secondEvidence = { file: "web/order.jsp", line: 20, column: 3, snippet: "list form" };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [firstEvidence, secondEvidence],
    data: { fields: ["mode"], visibleText: "Orders" },
    searchText: [],
  };
  const route = {
    id: "route:/order.do",
    type: "route",
    name: "/order.do",
    evidence: [firstEvidence, secondEvidence],
    data: {
      requestHints: [
        { method: "POST", parameters: { mode: "save" }, evidence: firstEvidence },
        { method: "GET", parameters: { mode: "list" }, evidence: secondEvidence },
      ],
    },
    searchText: [],
  };
  const submission = {
    id: "e-submit",
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [firstEvidence, secondEvidence],
    data: {},
  };

  const model = buildDocumentModel({ nodes: [page, route], edges: [submission] });

  assert.deepEqual(model.pages[0].actions.map(({ method, evidence }) => ({ method, evidence })), [
    { method: "GET", evidence: { file: "web/order.jsp", line: 20 } },
    { method: "POST", evidence: { file: "web/order.jsp", line: 10 } },
  ]);
  assert.equal(model.pages[0].fields[0].defaultValue, "", "conflicting defaults must remain unknown");
});

test("page request metadata restores repeated forms from legacy collapsed edge evidence", () => {
  const firstEvidence = { file: "web/order.jsp", line: 10, column: 3, snippet: "<form action=\"/order.do\" method=\"post\">" };
  const secondEvidence = { file: "web/order.jsp", line: 20, column: 3, snippet: "<form action=\"/order.do\" method=\"get\">" };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [firstEvidence, secondEvidence],
    data: { fields: ["mode", "mode"], visibleText: "Orders" },
    searchText: [],
  };
  const route = {
    id: "route:/order.do",
    type: "route",
    name: "/order.do",
    evidence: [firstEvidence, secondEvidence],
    data: {
      requestHints: [
        // The legacy parser attached the page-wide last value to every form.
        { method: "POST", parameters: { mode: "list" }, evidence: firstEvidence },
        { method: "GET", parameters: { mode: "list" }, evidence: secondEvidence },
      ],
    },
    searchText: [],
  };
  const legacyGraph = {
    schemaVersion: "1.0.0",
    project: { root: "/repo" },
    summary: {
      nodes: 2,
      edges: 1,
      nodeTypes: { page: 1, route: 1 },
      edgeTypes: { submits_to: 1 },
    },
    nodes: [page, route],
    edges: [{
      id: `${page.id}|submits_to|${route.id}|form request`,
      source: page.id,
      target: route.id,
      type: "submits_to",
      confidence: 1,
      reason: "form request",
      evidence: [firstEvidence],
      data: {},
    }],
    warnings: [],
  };

  const pageSpec = buildDocumentModel(legacyGraph).pages[0];

  assert.deepEqual(pageSpec.actions.map(({ method, evidence }) => ({ method, evidence })), [
    { method: "GET", evidence: { file: "web/order.jsp", line: 20 } },
    { method: "POST", evidence: { file: "web/order.jsp", line: 10 } },
  ]);
  assert.deepEqual(
    pageSpec.fields.map((field) => field.defaultValue),
    ["", ""],
    "legacy page-wide defaults must remain unknown",
  );
});

test("legacy form hint recovery does not absorb script request hints", () => {
  const firstFormEvidence = {
    file: "web/order.jsp",
    line: 10,
    column: 3,
    snippet: "<form action=\"/order.do\" method=\"post\">",
  };
  const secondFormEvidence = {
    file: "web/order.jsp",
    line: 20,
    column: 3,
    snippet: "<html:form action=\"/order.do\" method=\"get\">",
  };
  const ajaxEvidence = {
    file: "web/order.jsp",
    line: 30,
    column: 3,
    snippet: "$.ajax({ url: '/order.do', method: 'DELETE' });",
  };
  const secondAjaxEvidence = {
    file: "web/order.jsp",
    line: 40,
    column: 35,
    snippet: "<form data-example='x'></form> $.ajax({ url: '/order.do', method: 'PATCH' });",
  };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [firstFormEvidence, secondFormEvidence, ajaxEvidence, secondAjaxEvidence],
    data: { fields: ["mode", "mode"], visibleText: "Orders" },
    searchText: [],
  };
  const route = {
    id: "route:/order.do",
    type: "route",
    name: "/order.do",
    evidence: [firstFormEvidence, secondFormEvidence, ajaxEvidence, secondAjaxEvidence],
    data: {
      requestHints: [
        { method: "POST", parameters: { mode: "save" }, evidence: firstFormEvidence },
        { method: "GET", parameters: { mode: "list" }, evidence: secondFormEvidence },
        { method: "DELETE", parameters: {}, evidence: ajaxEvidence },
        { method: "PATCH", parameters: {}, evidence: secondAjaxEvidence },
      ],
    },
    searchText: [],
  };
  const edge = (type, reason, evidence) => ({
    id: `${page.id}|${type}|${route.id}|${reason}`,
    source: page.id,
    target: route.id,
    type,
    confidence: 1,
    reason,
    evidence: [evidence],
    data: {},
  });
  const legacyGraph = {
    schemaVersion: "1.0.0",
    project: { root: "/repo" },
    summary: {
      nodes: 2,
      edges: 2,
      nodeTypes: { page: 1, route: 1 },
      edgeTypes: { requests: 1, submits_to: 1 },
    },
    nodes: [page, route],
    edges: [
      edge("submits_to", "form request", firstFormEvidence),
      edge("requests", "ajax request", ajaxEvidence),
    ],
    warnings: [],
  };

  const pageSpec = buildDocumentModel(legacyGraph).pages[0];

  assert.deepEqual(pageSpec.actions.map(({ kind, method, evidence }) => ({ kind, method, evidence })), [
    { kind: "requests", method: "DELETE", evidence: { file: "web/order.jsp", line: 30 } },
    { kind: "submits_to", method: "GET", evidence: { file: "web/order.jsp", line: 20 } },
    { kind: "submits_to", method: "POST", evidence: { file: "web/order.jsp", line: 10 } },
  ]);
  assert.equal(pageSpec.fields[0].defaultValue, "", "mixed legacy form defaults must remain unknown");
});

test("page request metadata uses only unambiguous legacy hints without evidence", () => {
  const evidence = { file: "web/order.jsp", line: 10, column: 3, snippet: "form" };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [evidence],
    data: { fields: ["mode"], visibleText: "Orders" },
    searchText: [],
  };
  const route = (requestHints) => ({
    id: "route:/order.do",
    type: "route",
    name: "/order.do",
    evidence: [evidence],
    data: { requestHints },
    searchText: [],
  });
  const submission = {
    id: "e-submit",
    source: page.id,
    target: "route:/order.do",
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [evidence],
    data: {},
  };
  const pageSpec = (requestHints) => buildDocumentModel({
    nodes: [page, route(requestHints)],
    edges: [submission],
  }).pages[0];

  const legacy = pageSpec([{ method: "POST", parameters: { mode: "save" } }]);
  assert.equal(legacy.actions[0].method, "POST");
  assert.equal(legacy.fields[0].defaultValue, "save");

  const conflicting = pageSpec([
    { method: "POST", parameters: { mode: "save" } },
    { method: "GET", parameters: { mode: "list" } },
  ]);
  assert.equal(conflicting.actions[0].method, "");
  assert.equal(conflicting.fields[0].defaultValue, "");

  const mismatched = pageSpec([{
    method: "DELETE",
    parameters: { mode: "wrong" },
    evidence: { ...evidence, column: 99 },
  }]);
  assert.equal(mismatched.actions[0].method, "");
  assert.equal(mismatched.fields[0].defaultValue, "");
});

test("page request metadata keeps the HTTP method for script requests", () => {
  const evidence = { file: "web/order.jsp", line: 10, column: 3, snippet: "fetch" };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [evidence],
    data: { fields: [], visibleText: "Orders" },
    searchText: [],
  };
  const route = {
    id: "route:/api/order",
    type: "route",
    name: "/api/order",
    evidence: [evidence],
    data: { requestHints: [{ method: "DELETE", parameters: {}, evidence }] },
    searchText: [],
  };
  const request = {
    id: "e-request",
    source: page.id,
    target: route.id,
    type: "requests",
    confidence: 1,
    reason: "fetch request",
    evidence: [evidence],
    data: {},
  };

  const model = buildDocumentModel({ nodes: [page, route], edges: [request] });

  assert.equal(model.pages[0].actions[0].method, "DELETE");
});

test("use-case request summaries preserve partially unknown HTTP methods", () => {
  const evidence = { file: "web/app.js", line: 1, column: 1, snippet: "fetch" };
  const route = {
    id: "route:/api/order",
    type: "route",
    name: "/api/order",
    evidence: [evidence],
    data: {
      requestHints: [
        { method: "GET", parameters: {}, evidence },
        { method: "", parameters: {}, evidence: { ...evidence, line: 2 } },
      ],
    },
    searchText: [],
  };

  const model = buildDocumentModel({ nodes: [route], edges: [] });

  assert.deepEqual(model.useCases[0].request, {
    methods: ["GET"],
    parameters: [],
    hasUnknownMethod: true,
  });
  assert.match(renderUseCases(model), /Request: known methods GET; other methods unresolved/);
});

test("page links keep their evidence-scoped GET method", () => {
  const evidence = { file: "web/order.jsp", line: 10, column: 3, snippet: '<a href="/order/list.do">List</a>' };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [evidence],
    data: { fields: [], visibleText: "Orders" },
    searchText: [],
  };
  const route = {
    id: "route:/order/list.do",
    type: "route",
    name: "/order/list.do",
    evidence: [evidence],
    data: { requestHints: [{ method: "GET", parameters: {}, evidence }] },
    searchText: [],
  };
  const link = {
    id: "e-link",
    source: page.id,
    target: route.id,
    type: "links_to",
    confidence: 1,
    reason: "page link",
    evidence: [evidence],
    data: {},
  };

  const model = buildDocumentModel({ nodes: [page, route], edges: [link] });

  assert.equal(model.pages[0].actions[0].method, "GET");
});

test("use-case inputs stay scoped to the submitting form evidence", () => {
  const firstEvidence = { file: "web/shared.jsp", line: 2, column: 3, snippet: '<form action="/a.do">' };
  const secondEvidence = { file: "web/shared.jsp", line: 5, column: 3, snippet: '<form action="/b.do">' };
  const page = {
    id: "page:web/shared.jsp",
    type: "page",
    name: "shared.jsp",
    filePath: "web/shared.jsp",
    evidence: [firstEvidence, secondEvidence],
    data: { fields: ["a", "b"], visibleText: "Shared" },
    searchText: [],
  };
  const route = (name, evidence, parameter) => ({
    id: `route:${name}`,
    type: "route",
    name,
    evidence: [evidence],
    data: { requestHints: [{ method: "POST", parameters: { [parameter]: "" }, evidence }] },
    searchText: [],
  });
  const firstRoute = route("/a.do", firstEvidence, "a");
  const secondRoute = route("/b.do", secondEvidence, "b");
  const edge = (target, evidence) => ({
    id: `edge:${target.id}`,
    source: page.id,
    target: target.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [evidence],
    data: {},
  });

  const model = buildDocumentModel({
    nodes: [page, firstRoute, secondRoute],
    edges: [edge(firstRoute, firstEvidence), edge(secondRoute, secondEvidence)],
  });

  assert.deepEqual(model.useCases.find(({ route: name }) => name === "/a.do").inputs, ["a"]);
  assert.deepEqual(model.useCases.find(({ route: name }) => name === "/b.do").inputs, ["b"]);
});

test("one evidence-scoped form does not absorb unrelated page fields", () => {
  const evidence = { file: "web/edit.jsp", line: 1, column: 1, snippet: "form" };
  const page = {
    id: "page:web/edit.jsp",
    type: "page",
    name: "edit.jsp",
    filePath: "web/edit.jsp",
    evidence: [evidence],
    data: { fields: ["inside", "outside"], visibleText: "" },
    searchText: [],
  };
  const route = {
    id: "route:/save.do",
    type: "route",
    name: "/save.do",
    evidence: [evidence],
    data: { requestHints: [{ method: "POST", parameters: { inside: "" }, evidence }] },
    searchText: [],
  };
  const submission = {
    id: "submit",
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [evidence],
    data: {},
  };

  const model = buildDocumentModel({ nodes: [page, route], edges: [submission] });

  assert.deepEqual(model.useCases[0].inputs, ["inside"]);
});

test("explicit incomplete hints do not guess fields from an unrelated trigger page", () => {
  const evidence = { file: "web/fragment.jsp", line: 1, column: 7, snippet: '<form action="save.do?mode=">' };
  const triggerPage = {
    id: "page:web/top.jsp",
    type: "page",
    name: "top.jsp",
    filePath: "web/top.jsp",
    evidence: [],
    data: { fields: ["token", "topUnrelated"], visibleText: "" },
    searchText: [],
  };
  const route = {
    id: "route:/save.do",
    type: "route",
    name: "/save.do",
    evidence: [evidence],
    data: {
      requestHints: [{
        method: "POST",
        parameters: { mode: "" },
        parametersComplete: false,
        evidence,
      }],
    },
    searchText: [],
  };
  const submission = {
    id: "submit",
    source: triggerPage.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [evidence],
    data: {},
  };
  const duplicateSourcePages = ["first", "second"].map((name) => ({
    id: `page:web/${name}.jsp`,
    type: "page",
    name: `${name}.jsp`,
    filePath: "web/fragment.jsp",
    evidence: [],
    data: { fields: [name], visibleText: "" },
    searchText: [],
  }));

  for (const [label, sourcePages] of [
    ["missing evidence page", []],
    ["ambiguous evidence page", duplicateSourcePages],
  ]) {
    const model = buildDocumentModel({
      nodes: [triggerPage, route, ...sourcePages],
      edges: [submission],
    });
    assert.deepEqual(model.useCases[0].inputs, ["mode"], label);
  }
});

test("request-hint matching and input recovery stay linear for repeated same-route forms", () => {
  const count = 300;
  let sourceFileReads = 0;
  let fieldReads = 0;
  const fields = Array.from({ length: count });
  for (let index = 0; index < count; index += 1) {
    Object.defineProperty(fields, index, {
      enumerable: true,
      get() {
        fieldReads += 1;
        return `parameter${index}`;
      },
    });
  }
  const hintEvidence = Array.from({ length: count }, (_, index) => ({
    file: "web/forms.jsp",
    line: index + 1,
    column: 1,
    snippet: "form",
  }));
  const edgeEvidence = hintEvidence.map((entry) => ({
    get file() {
      sourceFileReads += 1;
      return entry.file;
    },
    line: entry.line,
    column: entry.column,
    snippet: entry.snippet,
  }));
  const page = {
    id: "page:web/forms.jsp",
    type: "page",
    name: "forms.jsp",
    filePath: "web/forms.jsp",
    evidence: hintEvidence,
    data: { fields, visibleText: "" },
    searchText: [],
  };
  const route = {
    id: "route:/same.do",
    type: "route",
    name: "/same.do",
    evidence: hintEvidence,
    data: {
      requestHints: hintEvidence.map((evidence, index) => ({
        method: index % 2 === 0 ? "POST" : "GET",
        parameters: { [`parameter${index}`]: "" },
        parametersComplete: true,
        evidence,
      })),
    },
    searchText: [],
  };
  const submission = {
    id: "submit-many",
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: edgeEvidence,
    data: {},
  };

  const model = buildDocumentModel({ nodes: [page, route], edges: [submission] });

  assert.equal(model.useCases[0].inputs.length, count);
  assert.ok(sourceFileReads < count * 20, `source evidence was rescanned ${sourceFileReads} times`);
  assert.ok(fieldReads <= count * 3, `page fields were rescanned ${fieldReads} times`);
});

test("request-hint selection stays linear across many trigger pages", () => {
  const count = 200;
  let hintFileReads = 0;
  const edgeEvidence = Array.from({ length: count }, (_, index) => ({
    file: `web/page${index}.jsp`,
    line: 1,
    column: 7,
    snippet: "form",
  }));
  const hintEvidence = edgeEvidence.map((entry) => ({
    get file() {
      hintFileReads += 1;
      return entry.file;
    },
    line: entry.line,
    column: entry.column,
    snippet: entry.snippet,
  }));
  const pages = edgeEvidence.map((evidence, index) => ({
    id: `page:web/page${index}.jsp`,
    type: "page",
    name: `page${index}.jsp`,
    filePath: evidence.file,
    evidence: [evidence],
    data: { fields: [`parameter${index}`], visibleText: "" },
    searchText: [],
  }));
  const route = {
    id: "route:/shared.do",
    type: "route",
    name: "/shared.do",
    evidence: edgeEvidence,
    data: {
      requestHints: hintEvidence.map((evidence, index) => ({
        method: "POST",
        parameters: { [`parameter${index}`]: "" },
        parametersComplete: true,
        evidence,
      })),
    },
    searchText: [],
  };
  const submissions = pages.map((page, index) => ({
    id: `submit-page-${index}`,
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [edgeEvidence[index]],
    data: {},
  }));

  const model = buildDocumentModel({ nodes: [...pages, route], edges: submissions });

  assert.equal(model.useCases[0].inputs.length, count);
  assert.ok(hintFileReads <= count * 20, `route hints were rescanned ${hintFileReads} times`);
});

test("deep flows report truncation while feature scope reaches every reverse flow layer", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "flow" }];
  const route = { id: "route:/deep/start.do", type: "route", name: "/deep/start.do", evidence, data: {}, searchText: [] };
  const methods = Array.from({ length: 27 }, (_, index) => ({
    id: `java_method:Deep.m${index}`,
    type: "java_method",
    name: `Deep.m${index}`,
    evidence,
    data: {},
    searchText: [],
  }));
  const table = {
    id: "table:deep_target_table",
    type: "table",
    name: "deep_target_table",
    evidence,
    data: {},
    searchText: ["deep_target_table"],
  };
  const edge = (id, source, target, type) => ({
    id,
    source,
    target,
    type,
    confidence: 1,
    reason: type,
    evidence,
    data: {},
  });
  const edges = [edge("deep:0", route.id, methods[0].id, "maps_to")];
  for (let index = 1; index < methods.length; index += 1) {
    edges.push(edge(`deep:${index}`, methods[index - 1].id, methods[index].id, "calls"));
  }
  edges.push(edge("deep:table", methods.at(-1).id, table.id, "reads_from"));
  const graph = { nodes: [route, ...methods, table], edges };

  const unscoped = buildDocumentModel(graph);
  assert.equal(unscoped.useCases[0].flowTruncated, true);
  assert.equal(unscoped.truncated, true);
  assert.match(renderUseCases(unscoped), /main flow exceeds the display limit and was truncated/);

  const scoped = buildDocumentModel(graph, { scopeQuery: "deep_target_table" });
  assert.equal(scoped.scope.matched, true);
  assert.deepEqual(scoped.useCases.map(({ route: name }) => name), ["/deep/start.do"]);
});

test("wide shallow flows report traversal truncation without claiming the main flow is too long", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "flow" }];
  const route = { id: "route:/wide.do", type: "route", name: "/wide.do", evidence, data: {}, searchText: [] };
  const leaves = Array.from({ length: 101 }, (_, index) => ({
    id: `java_method:Wide.m${index}`,
    type: "java_method",
    name: `Wide.m${index}`,
    evidence,
    data: {},
    searchText: [],
  }));
  const edges = leaves.map((leaf, index) => ({
    id: `wide:${index}`,
    source: route.id,
    target: leaf.id,
    type: "maps_to",
    confidence: 1,
    reason: "branch",
    evidence,
    data: {},
  }));

  const model = buildDocumentModel({ nodes: [route, ...leaves], edges });
  const markdown = renderUseCases(model);

  assert.equal(model.useCases[0].flowTruncated, true);
  assert.match(markdown, /flow traversal limit reached; additional branches may be omitted/);
  assert.doesNotMatch(markdown, /main flow exceeds the display limit/);
});

test("document main flows use the full 24-step display budget", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "flow" }];
  const nodes = Array.from({ length: 20 }, (_, index) => ({
    id: index === 0 ? "route:/twenty/start.do" : `java_method:Twenty.m${index}`,
    type: index === 0 ? "route" : "java_method",
    name: index === 0 ? "/twenty/start.do" : `Twenty.m${index}`,
    evidence,
    data: {},
    searchText: [],
  }));
  const edges = nodes.slice(1).map((node, index) => ({
    id: `twenty:${index}`,
    source: nodes[index].id,
    target: node.id,
    type: index === 0 ? "maps_to" : "calls",
    confidence: 1,
    reason: "flow",
    evidence,
    data: {},
  }));

  const model = buildDocumentModel({ nodes, edges });

  assert.equal(model.useCases[0].mainFlow.length, 20);
  assert.equal(model.useCases[0].flowTruncated, false);
});

test("scoped UI pages include pages reached through Tiles composition", () => {
  const evidence = [{ file: "tiles.xml", line: 1, column: 1, snippet: "definition" }];
  const route = {
    id: "route:/orders/view.do",
    type: "route",
    name: "/orders/view.do",
    evidence,
    data: {},
    searchText: [],
  };
  const tile = {
    id: "tiles_definition:orders.view",
    type: "tiles_definition",
    name: "orders.view",
    evidence,
    data: {},
    searchText: [],
  };
  const page = {
    id: "page:web/orders/view.jsp",
    type: "page",
    name: "view.jsp",
    filePath: "web/orders/view.jsp",
    evidence,
    data: { fields: [], visibleText: "Orders" },
    searchText: [],
  };
  const edge = (id, source, target, type) => ({
    id,
    source,
    target,
    type,
    confidence: 1,
    reason: type,
    evidence,
    data: {},
  });
  const graph = {
    nodes: [route, tile, page],
    edges: [
      edge("uses-tile", route.id, tile.id, "uses_tile"),
      edge("puts-body", tile.id, page.id, "puts"),
    ],
  };

  const model = buildDocumentModel(graph, { scopeQuery: "orders" });

  assert.equal(model.scope.kind, "module");
  assert.deepEqual(model.pages.map(({ filePath }) => filePath), ["web/orders/view.jsp"]);
  assert.deepEqual(model.pages[0].arrivals.map(({ kind, fromType }) => [kind, fromType]), [["puts", "tiles_definition"]]);
  assert.deepEqual(model.useCases[0].outcomes.map(({ kind, targetPath }) => [kind, targetPath]), [
    ["composes", "web/orders/view.jsp"],
  ]);
  assert.match(renderDiagrams(model), /uses_tile.*puts|Tiles composition/u);
});

test("scoped UI pages follow JSP includes and cite fragment arrivals", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "flow" }];
  const route = { id: "route:/orders/view.do", type: "route", name: "/orders/view.do", evidence, data: {}, searchText: [] };
  const parent = {
    id: "page:web/orders/view.jsp",
    type: "page",
    name: "view.jsp",
    filePath: "web/orders/view.jsp",
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  };
  const fragment = {
    id: "page:web/fragments/summary.jsp",
    type: "page",
    name: "summary.jsp",
    filePath: "web/fragments/summary.jsp",
    evidence,
    data: { fields: ["summary"], visibleText: "" },
    searchText: [],
  };
  const edges = [
    { id: "forward", source: route.id, target: parent.id, type: "forwards_to", confidence: 1, reason: "view", evidence, data: {} },
    { id: "include", source: parent.id, target: fragment.id, type: "includes", confidence: 1, reason: "include", evidence, data: {} },
  ];

  const model = buildDocumentModel({ nodes: [route, parent, fragment], edges }, { scopeQuery: "orders" });

  assert.deepEqual(model.pages.map(({ filePath }) => filePath), ["web/fragments/summary.jsp", "web/orders/view.jsp"]);
  const fragmentSpec = model.pages.find(({ filePath }) => filePath === "web/fragments/summary.jsp");
  assert.deepEqual(fragmentSpec.arrivals.map(({ kind, from }) => [kind, from]), [["includes", "view.jsp"]]);
});

test("scoped UI pages follow includes from a triggering page", () => {
  const evidence = [{ file: "web/orders/edit.jsp", line: 1, column: 1, snippet: "flow" }];
  const route = { id: "route:/orders/save.do", type: "route", name: "/orders/save.do", evidence, data: {}, searchText: [] };
  const page = {
    id: "page:web/orders/edit.jsp",
    type: "page",
    name: "edit.jsp",
    filePath: "web/orders/edit.jsp",
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  };
  const fragment = {
    id: "page:web/fragments/toolbar.jsp",
    type: "page",
    name: "toolbar.jsp",
    filePath: "web/fragments/toolbar.jsp",
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  };
  const edges = [
    { id: "submit", source: page.id, target: route.id, type: "submits_to", confidence: 1, reason: "form", evidence, data: {} },
    { id: "include", source: page.id, target: fragment.id, type: "includes", confidence: 1, reason: "include", evidence, data: {} },
  ];

  const model = buildDocumentModel({ nodes: [route, page, fragment], edges }, { scopeQuery: "orders" });

  assert.deepEqual(model.pages.map(({ filePath }) => filePath), [
    "web/fragments/toolbar.jsp",
    "web/orders/edit.jsp",
  ]);
});

test("Tiles inheritance excludes overridden parent attributes from scoped outcomes", () => {
  const evidence = [{ file: "tiles.xml", line: 1, column: 1, snippet: "definition" }];
  const route = { id: "route:/orders/view.do", type: "route", name: "/orders/view.do", evidence, data: {}, searchText: [] };
  const child = { id: "tiles_definition:child", type: "tiles_definition", name: "child", evidence, data: {}, searchText: [] };
  const base = { id: "tiles_definition:base", type: "tiles_definition", name: "base", evidence, data: {}, searchText: [] };
  const page = (name) => ({
    id: `page:web/${name}.jsp`,
    type: "page",
    name: `${name}.jsp`,
    filePath: `web/${name}.jsp`,
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  });
  const pages = ["child-template", "base-template", "new-body", "old-body", "footer"].map(page);
  const byName = new Map(pages.map((entry) => [entry.name.replace(/\.jsp$/u, ""), entry]));
  const edge = (id, source, target, type, data = {}) => ({
    id, source, target, type, confidence: 1, reason: type, evidence, data,
  });
  const edges = [
    edge("uses-child", route.id, child.id, "uses_tile"),
    edge("extends-base", child.id, base.id, "extends_tile"),
    edge("child-template", child.id, byName.get("child-template").id, "uses_template"),
    edge("base-template", base.id, byName.get("base-template").id, "uses_template"),
    edge("child-body", child.id, byName.get("new-body").id, "puts", { name: "body" }),
    edge("base-body", base.id, byName.get("old-body").id, "puts", { name: "body" }),
    edge("base-footer", base.id, byName.get("footer").id, "puts", { name: "footer" }),
  ];

  const model = buildDocumentModel({ nodes: [route, child, base, ...pages], edges }, { scopeQuery: "orders" });
  const expectedPages = ["web/child-template.jsp", "web/footer.jsp", "web/new-body.jsp"];

  assert.deepEqual(model.pages.map(({ filePath }) => filePath), expectedPages);
  assert.deepEqual(model.useCases[0].outcomes.map(({ targetPath }) => targetPath).sort(), expectedPages);
});

test("per-section model caps are explicit in generated documents", () => {
  const evidence = (file) => [{ file, line: 1, column: 1, snippet: "x" }];
  const mainRoute = {
    id: "route:/capped/main.do",
    type: "route",
    name: "/capped/main.do",
    evidence: evidence("routes.xml"),
    data: {},
    searchText: [],
  };
  const busyPage = {
    id: "page:web/busy.jsp",
    type: "page",
    name: "busy.jsp",
    filePath: "web/busy.jsp",
    evidence: evidence("web/busy.jsp"),
    data: { fields: [], visibleText: "Busy" },
    searchText: [],
  };
  const routes = [mainRoute];
  for (let index = 1; index < 41; index += 1) {
    routes.push({
      id: `route:/capped/r${index}.do`,
      type: "route",
      name: `/capped/r${index}.do`,
      evidence: evidence("routes.xml"),
      data: {},
      searchText: [],
    });
  }
  const triggerPages = Array.from({ length: 21 }, (_, index) => ({
    id: `page:web/trigger-${index}.jsp`,
    type: "page",
    name: `trigger-${index}.jsp`,
    filePath: `web/trigger-${index}.jsp`,
    evidence: evidence(`web/trigger-${index}.jsp`),
    data: { fields: [], visibleText: "" },
    searchText: [],
  }));
  const tables = Array.from({ length: 21 }, (_, index) => ({
    id: `table:dbo.cap_${index}`,
    type: "table",
    name: `dbo.cap_${index}`,
    evidence: evidence("sql.xml"),
    data: {},
    searchText: [],
  }));
  const edge = (id, source, target, type) => ({
    id,
    source,
    target,
    type,
    confidence: 1,
    reason: type,
    evidence: evidence("edges.xml"),
    data: {},
  });
  const edges = [];
  triggerPages.forEach((page, index) => edges.push(edge(`trigger:${index}`, page.id, mainRoute.id, "submits_to")));
  tables.forEach((table, index) => edges.push(edge(`table:${index}`, mainRoute.id, table.id, "reads_from")));
  routes.forEach((route, index) => edges.push(edge(`action:${index}`, busyPage.id, route.id, "links_to")));
  routes.slice(0, 21).forEach((route, index) => edges.push(edge(`arrival:${index}`, route.id, busyPage.id, "forwards_to")));

  const model = buildDocumentModel({ nodes: [...routes, busyPage, ...triggerPages, ...tables], edges });
  const cappedUseCase = model.useCases.find(({ route: name }) => name === mainRoute.name);
  const cappedPage = model.pages.find(({ filePath }) => filePath === busyPage.filePath);

  assert.equal(cappedUseCase.triggers.length, 20);
  assert.equal(cappedUseCase.triggersTruncated, true);
  assert.equal(cappedUseCase.tables.length, 20);
  assert.equal(cappedUseCase.tablesTruncated, true);
  assert.equal(cappedPage.actions.length, 40);
  assert.equal(cappedPage.actionsTruncated, true);
  assert.equal(cappedPage.arrivals.length, 20);
  assert.equal(cappedPage.arrivalsTruncated, true);
  assert.equal(model.truncated, true);
  assert.match(renderUseCases(model), /additional triggers were truncated/);
  assert.match(renderUseCases(model), /additional tables were truncated/);
  assert.match(renderUiSpec(model), /additional page actions were truncated/);
  assert.match(renderUiSpec(model), /additional arrival paths were truncated/);
  assert.match(renderDiagrams(model), /number of entries exceeded the generation cap/);
});

test("page fields leave mixed explicit and absent defaults unknown", () => {
  const firstEvidence = { file: "web/order.jsp", line: 10, column: 3, snippet: "save" };
  const secondEvidence = { file: "web/order.jsp", line: 20, column: 3, snippet: "blank" };
  const page = {
    id: "page:web/order.jsp",
    type: "page",
    name: "order.jsp",
    filePath: "web/order.jsp",
    evidence: [firstEvidence, secondEvidence],
    data: { fields: ["mode", "mode"], visibleText: "Orders" },
    searchText: [],
  };
  const route = {
    id: "route:/order.do",
    type: "route",
    name: "/order.do",
    evidence: [firstEvidence, secondEvidence],
    data: {
      requestHints: [
        { method: "POST", parameters: { mode: "save" }, evidence: firstEvidence },
        { method: "GET", parameters: {}, evidence: secondEvidence },
      ],
    },
    searchText: [],
  };
  const submission = {
    id: "e-submit",
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence: [firstEvidence, secondEvidence],
    data: {},
  };

  const model = buildDocumentModel({ nodes: [page, route], edges: [submission] });

  assert.deepEqual(model.pages[0].fields.map((field) => field.defaultValue), ["", ""]);
});

test("scope slugs remain safe and distinct for Unicode and long same-prefix queries", () => {
  assert.equal(scopeSlug("order"), "order", "already-safe identifiers should keep stable paths");
  assert.equal(scopeSlug("OrderAudit"), "orderaudit");
  const unicodeQuery = "订单审核";
  const slugs = [
    scopeSlug(unicodeQuery),
    scopeSlug("退款审批"),
    scopeSlug("order审核"),
    scopeSlug("order审批"),
    scopeSlug(`${"a".repeat(48)}x`),
    scopeSlug(`${"a".repeat(48)}y`),
  ];

  assert.equal(new Set(slugs).size, slugs.length);
  assert.equal(scopeSlug(unicodeQuery), slugs[0], "scope slugs must be deterministic");
  for (const slug of slugs) {
    assert.match(slug, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.ok(slug.length <= 48, `slug exceeds the 48-character limit: ${slug}`);
  }
  for (const reserved of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
    assert.doesNotMatch(scopeSlug(reserved), /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u);
  }
});

test("screen navigation keeps same-named pages distinct by project-relative path", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "x" }];
  const page = (id, filePath, name) => ({
    id,
    type: "page",
    name,
    filePath,
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  });
  const route = (id, name) => ({ id, type: "route", name, evidence, data: {}, searchText: [] });
  const nodes = [
    page("page:a/list.jsp", "a/list.jsp", "list.jsp"),
    page("page:b/list.jsp", "b/list.jsp", "list.jsp"),
    page("page:a/result.jsp", "a/result.jsp", "result.jsp"),
    page("page:b/result.jsp", "b/result.jsp", "result.jsp"),
    route("route:/a/go.do", "/a/go.do"),
    route("route:/b/go.do", "/b/go.do"),
  ];
  const edge = (id, source, target, type) => ({
    id,
    source,
    target,
    type,
    confidence: 1,
    reason: type === "forwards_to" ? "success" : "form request",
    evidence,
    data: {},
  });
  const edges = [
    edge("e1", "page:a/list.jsp", "route:/a/go.do", "submits_to"),
    edge("e2", "route:/a/go.do", "page:a/result.jsp", "forwards_to"),
    edge("e3", "page:b/list.jsp", "route:/b/go.do", "submits_to"),
    edge("e4", "route:/b/go.do", "page:b/result.jsp", "forwards_to"),
  ];

  const diagrams = renderDiagrams(buildDocumentModel({ nodes, edges }));
  const navigation = diagrams.match(/## Screen navigation[\s\S]*?```mermaid\r?\n([\s\S]*?)```/u)?.[1] ?? "";

  assert.match(navigation, /a\/list\.jsp/);
  assert.match(navigation, /b\/list\.jsp/);
  assert.match(navigation, /a\/result\.jsp/);
  assert.match(navigation, /b\/result\.jsp/);
  const pageIds = new Map(
    [...navigation.matchAll(/^  (s\d+)\[([^\]]+)\]$/gmu)]
      .map(([, id, label]) => [label, id]),
  );
  const routeIds = new Map(
    [...navigation.matchAll(/^  (s\d+)\(\[([^\]]+)\]\)$/gmu)]
      .map(([, id, label]) => [label, id]),
  );
  const actualEdges = new Set(
    [...navigation.matchAll(/^  (s\d+) -->\|([^|]+)\| (s\d+)$/gmu)]
      .map(([, from, label, to]) => `${from}|${label}|${to}`),
  );
  assert.equal(pageIds.size, 4, "same basenames must produce four distinct page nodes");
  assert.deepEqual(
    actualEdges,
    new Set([
      `${pageIds.get("a/list.jsp")}|submits_to|${routeIds.get("/a/go.do")}`,
      `${routeIds.get("/a/go.do")}|success|${pageIds.get("a/result.jsp")}`,
      `${pageIds.get("b/list.jsp")}|submits_to|${routeIds.get("/b/go.do")}`,
      `${routeIds.get("/b/go.do")}|success|${pageIds.get("b/result.jsp")}`,
    ]),
  );
});

test("screen navigation keeps long same-prefix page labels visibly distinct", () => {
  const evidence = [{ file: "routes.xml", line: 1, column: 1, snippet: "x" }];
  const commonPrefix = `web/${"shared-directory/".repeat(5)}`;
  const pages = ["alpha-entry.jsp", "beta-entry.jsp"].map((name) => ({
    id: `page:${commonPrefix}${name}`,
    type: "page",
    name,
    filePath: `${commonPrefix}${name}`,
    evidence,
    data: { fields: [], visibleText: "" },
    searchText: [],
  }));
  const routes = ["/alpha.do", "/beta.do"].map((name) => ({
    id: `route:${name}`,
    type: "route",
    name,
    evidence,
    data: {},
    searchText: [],
  }));
  const edges = pages.map((page, index) => ({
    id: `edge:${index}`,
    source: page.id,
    target: routes[index].id,
    type: "submits_to",
    confidence: 1,
    reason: "form request",
    evidence,
    data: {},
  }));

  const diagrams = renderDiagrams(buildDocumentModel({ nodes: [...pages, ...routes], edges }));
  const navigation = diagrams.match(/## Screen navigation[\s\S]*?```mermaid\r?\n([\s\S]*?)```/u)?.[1] ?? "";
  const pageLabels = [...navigation.matchAll(/^  s\d+\[([^\]]+)\]$/gmu)].map((match) => match[1]);

  assert.equal(pageLabels.length, 2);
  assert.equal(new Set(pageLabels).size, 2);
  assert.equal(pageLabels.some((label) => label.includes("alpha-entry.jsp")), true);
  assert.equal(pageLabels.some((label) => label.includes("beta-entry.jsp")), true);
  assert.equal(pageLabels.every((label) => label.length <= 60), true);
});

test("screen navigation renders route redirects as route nodes", () => {
  const evidence = [{ file: "struts.xml", line: 1, column: 1, snippet: "redirectAction" }];
  const start = {
    id: "route:/order/start.action",
    type: "route",
    name: "/order/start.action",
    evidence,
    data: {},
    searchText: [],
  };
  const next = {
    id: "route:/order/next.action",
    type: "route",
    name: "/order/next.action",
    evidence,
    data: {},
    searchText: [],
  };
  const redirect = {
    id: "e-redirect",
    source: start.id,
    target: next.id,
    type: "redirects_to",
    confidence: 1,
    reason: "success",
    evidence,
    data: {},
  };

  const model = buildDocumentModel({ nodes: [start, next], edges: [redirect] });
  const startUseCase = model.useCases.find((useCase) => useCase.routeId === start.id);
  assert.deepEqual(startUseCase.outcomes[0], {
    kind: "redirects_to",
    target: "/order/next.action",
    targetId: next.id,
    targetPath: "/order/next.action",
    targetType: "route",
    reason: "success",
    confidence: 1,
    evidence: { file: "struts.xml", line: 1 },
  });

  const diagrams = renderDiagrams(model);
  const navigation = diagrams.match(/## Screen navigation[\s\S]*?```mermaid\r?\n([\s\S]*?)```/u)?.[1] ?? "";
  const routeIds = new Map(
    [...navigation.matchAll(/^  (s\d+)\(\[([^\]]+)\]\)$/gmu)]
      .map(([, id, label]) => [label, id]),
  );

  assert.equal(routeIds.size, 2);
  assert.doesNotMatch(navigation, /^  s\d+\[\/order\/next\.action\]$/mu);
  assert.match(
    navigation,
    new RegExp(`^  ${routeIds.get("/order/start.action")} -->\\|success\\| ${routeIds.get("/order/next.action")}$`, "mu"),
  );
});

test("module flowcharts render later route steps instead of resetting to the origin", () => {
  const evidence = [{ file: "struts.xml", line: 1, column: 1, snippet: "redirectAction" }];
  const route = (name) => ({
    id: `route:${name}`,
    type: "route",
    name,
    evidence,
    data: {},
    searchText: [],
  });
  const start = route("/order/start.action");
  const next = route("/order/next.action");
  const redirect = {
    id: "redirect",
    source: start.id,
    target: next.id,
    type: "redirects_to",
    confidence: 1,
    reason: "success",
    evidence,
    data: {},
  };

  const diagrams = renderDiagrams(buildDocumentModel({ nodes: [start, next], edges: [redirect] }));
  const moduleBlock = diagrams.match(/## Module overview: order[\s\S]*?```mermaid\n([\s\S]*?)```/)?.[1] ?? "";
  const routes = new Map(
    [...moduleBlock.matchAll(/^  (n\d+)\(\[([^\]]+)\]\)$/gmu)]
      .map(([, id, label]) => [label, id]),
  );

  assert.equal(routes.size, 2);
  assert.equal((moduleBlock.match(/^  n\d+\(\[\/order\/(?:start|next)[.]action\]\)$/gmu) ?? []).length, 2);
  assert.match(
    moduleBlock,
    new RegExp(`^  ${routes.get("/order/start.action")} -->\\|redirects_to\\| ${routes.get("/order/next.action")}$`, "mu"),
  );
});


if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  // executed directly: nothing extra
}
