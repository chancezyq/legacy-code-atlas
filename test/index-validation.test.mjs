import assert from "node:assert/strict";
import test from "node:test";

import { validateGraphIndex } from "../src/index-validation.mjs";

function validGraph() {
  return {
    schemaVersion: "1.0.0",
    project: { root: "." },
    summary: {
      nodes: 2,
      edges: 1,
      nodeTypes: { page: 1, table: 1 },
      edgeTypes: { reads_from: 1 },
    },
    nodes: [
      {
        id: "page:web/order.jsp",
        type: "page",
        name: "Order",
        filePath: "web/order.jsp",
        evidence: [{ file: "web/order.jsp", line: 1, column: 1, snippet: "Order" }],
        data: {},
        searchText: ["Order"],
      },
      {
        id: "table:dbo.orders",
        type: "table",
        name: "dbo.orders",
        evidence: [],
        data: {},
        searchText: [],
      },
    ],
    edges: [{
      id: "page:web/order.jsp|reads_from|table:dbo.orders|query",
      source: "page:web/order.jsp",
      target: "table:dbo.orders",
      type: "reads_from",
      confidence: 1,
      reason: "query",
      evidence: [{ file: "web/order.jsp", line: 1, column: 1, snippet: "query" }],
      data: {},
    }],
    warnings: [],
  };
}

test("index paths reject Windows-ambiguous segments and device names", () => {
  const invalidPaths = [
    "src/.. /secret.jsp",
    "src/Order.java.",
    "src/Order.java:stream",
    "src/CON.java",
    "src/con .txt",
    "src/LPT9/output.txt",
    "src/COM\u00b9.log",
    "src/name?.jsp",
    "src/tab\tname.jsp",
  ];
  const citationTargets = [
    (graph, value) => { graph.nodes[0].filePath = value; },
    (graph, value) => { graph.nodes[0].evidence[0].file = value; },
    (graph, value) => { graph.edges[0].evidence[0].file = value; },
  ];

  for (const invalidPath of invalidPaths) {
    for (const setCitation of citationTargets) {
      const graph = validGraph();
      setCitation(graph, invalidPath);
      assert.throws(
        () => validateGraphIndex(graph),
        /项目相对 POSIX 路径|控制字符/,
        invalidPath,
      );
    }
  }
});

test("index validation errors cannot forge extra output lines", () => {
  const graph = validGraph();
  graph["forged\nSECOND-LINE\u202e"] = true;

  assert.throws(
    () => validateGraphIndex(graph),
    (error) => {
      assert.doesNotMatch(error.message, /[\r\n\u2028\u2029\u202a-\u202e\u2066-\u2069]/u);
      assert.doesNotMatch(error.message, /forged|SECOND-LINE/);
      return true;
    },
  );
});

test("index strings reject Unicode line separators and bidi controls", () => {
  for (const control of ["\u00ad", "\u200b", "\u2028", "\u2029", "\u202e", "\u2066", "\ufeff"]) {
    const graph = validGraph();
    graph.nodes[0].name = `Order${control}Forged`;
    assert.throws(() => validateGraphIndex(graph), /控制字符/);
  }
});

test("index strings reject unpaired UTF-16 surrogates", () => {
  for (const surrogate of ["\uD83D", "\uDE00"]) {
    const graph = validGraph();
    graph.nodes[0].searchText = [`Order${surrogate}Review`];
    assert.throws(() => validateGraphIndex(graph), /控制字符/);
  }
});

test("index bounds fields that are repeated in rendered trace output", () => {
  for (const mutate of [
    (graph) => { graph.nodes[0].name = "N".repeat((16 * 1024) + 1); },
    (graph) => { graph.edges[0].reason = "R".repeat((16 * 1024) + 1); },
    (graph) => { graph.warnings = ["W".repeat((16 * 1024) + 1)]; },
  ]) {
    const graph = validGraph();
    mutate(graph);
    assert.throws(() => validateGraphIndex(graph), /过长/);
  }
});

test("index validates technical-document evidence nested in node data", () => {
  const pageGraph = validGraph();
  pageGraph.nodes[0].data.fieldDetails = [{
    name: "decision",
    element: "select",
    inputType: "select",
    staticValue: "PASS",
    runtimeDerived: false,
    required: true,
    disabled: false,
    choice: true,
    submittable: true,
    evidence: { file: "../outside.jsp", line: 2, column: 1, snippet: "decision" },
  }];
  assert.throws(() => validateGraphIndex(pageGraph), /项目相对 POSIX 路径/);

  const propertiesGraph = validGraph();
  propertiesGraph.nodes[0] = {
    ...propertiesGraph.nodes[0],
    id: "file:WEB-INF/classes/messages.properties",
    type: "file",
    name: "messages.properties",
    filePath: "WEB-INF/classes/messages.properties",
    data: {
      properties: [{
        key: "error.audit",
        value: "Audit failed",
        evidence: { file: "file:///etc/passwd", line: 1, column: 1, snippet: "error.audit" },
      }],
    },
  };
  propertiesGraph.summary.nodeTypes = { file: 1, table: 1 };
  assert.throws(() => validateGraphIndex(propertiesGraph), /项目相对 POSIX 路径/);
});
