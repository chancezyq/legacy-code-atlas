import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createEvidence } from "../src/evidence.mjs";
import { GraphBuilder, serializeGraph } from "../src/graph.mjs";
import { validateGraphIndex } from "../src/index-validation.mjs";
import { searchGraph } from "../src/query.mjs";

const MAX_SEARCH_TEXT_CHARACTERS = 256 * 1024;

test("graph creates stable nodes and deduplicates evidence-backed edges", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const pageEvidence = createEvidence("web\\order.jsp", 4, 3, "<form action='/order/audit.do'>");
  const routeEvidence = createEvidence("WEB-INF/struts-config.xml", 10, 5, "<action path='/order/audit'>");

  const page = graph.addNode({
    type: "page",
    key: "web/order.jsp",
    name: "order.jsp",
    filePath: "web\\order.jsp",
    evidence: [pageEvidence],
  });
  const route = graph.addNode({ type: "route", key: "/order/audit.do", name: "/order/audit.do" });
  graph.addEdge({
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "JSP form action",
    evidence: [pageEvidence, routeEvidence],
  });
  graph.addEdge({
    source: page.id,
    target: route.id,
    type: "submits_to",
    confidence: 1,
    reason: "JSP form action",
    evidence: [pageEvidence, routeEvidence],
  });

  const result = graph.toJSON();
  assert.equal(page.id, "page:web/order.jsp");
  assert.equal(page.filePath, "web/order.jsp");
  assert.deepEqual(pageEvidence, {
    file: "web/order.jsp",
    line: 4,
    column: 3,
    snippet: "<form action='/order/audit.do'>",
  });
  assert.equal(result.schemaVersion, "1.0.0");
  assert.equal(result.nodes.length, 2);
  assert.equal(result.edges.length, 1);
  assert.equal(result.edges[0].confidence, 1);
});

test("graph chunks oversized generated search text without losing boundary queries", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const boundaryQuery = "CROSS_BOUNDARY_QUERY";
  const tailQuery = "SEARCH_TEXT_TAIL";
  const oversized = `${"A".repeat(MAX_SEARCH_TEXT_CHARACTERS - 8)}${boundaryQuery}`
    + `${"B".repeat(MAX_SEARCH_TEXT_CHARACTERS)}${tailQuery}`;
  const node = graph.addNode({
    type: "page",
    key: "large.jsp",
    name: "large.jsp",
    filePath: "large.jsp",
    searchText: [oversized],
    data: { visibleText: oversized },
  });

  const result = graph.toJSON();

  assert.equal(node.searchText.length > 1, true);
  assert.equal(node.searchText.every((value) => value.length <= MAX_SEARCH_TEXT_CHARACTERS), true);
  assert.equal(searchGraph(result, boundaryQuery)[0]?.id, node.id);
  assert.equal(searchGraph(result, tailQuery)[0]?.id, node.id);
  assert.doesNotThrow(() => validateGraphIndex(result));
});

test("graph preserves multi-token search across chunks from one generated value", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const oversized = `alpha ${"X".repeat(MAX_SEARCH_TEXT_CHARACTERS + 1)} omega`;
  const node = graph.addNode({
    type: "page",
    key: "multi-token.jsp",
    name: "multi-token.jsp",
    filePath: "multi-token.jsp",
    searchText: [oversized],
    data: { visibleText: oversized },
  });

  const result = graph.toJSON();

  assert.equal(searchGraph(result, "alpha omega")[0]?.id, node.id);
});

test("multi-token search never combines text from different graph nodes", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  graph.addNode({ type: "page", key: "alpha.jsp", searchText: ["alpha"] });
  graph.addNode({ type: "page", key: "omega.jsp", searchText: ["omega"] });

  assert.deepEqual(searchGraph(graph.toJSON(), "alpha omega"), []);
});

test("graph chunks generated search text only at Unicode scalar boundaries", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const chunkStep = MAX_SEARCH_TEXT_CHARACTERS - (2 * 1024);
  const oversized = `${"A".repeat(chunkStep - 1)}😀${"B".repeat(3 * 1024)}`;
  const node = graph.addNode({
    type: "page",
    key: "unicode.jsp",
    name: "unicode.jsp",
    filePath: "unicode.jsp",
    searchText: [oversized],
  });

  const hasUnpairedSurrogate = (value) => [...value].some((character) => {
    if (character.length !== 1) return false;
    const codeUnit = character.charCodeAt(0);
    return codeUnit >= 0xD800 && codeUnit <= 0xDFFF;
  });

  assert.equal(node.searchText.some(hasUnpairedSurrogate), false);
});

test("graph sanitizes source controls before validating generated search text", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const node = graph.addNode({
    type: "page",
    key: "controls.jsp",
    name: "controls.jsp",
    filePath: "controls.jsp",
    searchText: ["Order\u200BReview\tPanel"],
  });

  const result = graph.toJSON();

  assert.deepEqual(node.searchText, ["Order Review Panel"]);
  assert.doesNotThrow(() => validateGraphIndex(result));
});

test("graph output is sorted and rejects invalid or dangling edges", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo", warnings: ["partial XML"] });
  const z = graph.addNode({ type: "table", key: "dbo.z_order", name: "dbo.z_order" });
  const a = graph.addNode({ type: "table", key: "dbo.a_order", name: "dbo.a_order" });

  assert.throws(
    () => graph.addEdge({ source: z.id, target: "missing:x", type: "calls", confidence: 1 }),
    /unknown target/,
  );
  assert.throws(
    () => graph.addEdge({ source: z.id, target: a.id, type: "calls", confidence: 1.5 }),
    /confidence/,
  );

  graph.addEdge({ source: z.id, target: a.id, type: "calls", confidence: 0.5, reason: "heuristic" });
  const first = serializeGraph(graph.toJSON());
  const second = serializeGraph(graph.toJSON());

  assert.equal(first, second);
  assert.deepEqual(graph.toJSON().nodes.map((node) => node.id), ["table:dbo.a_order", "table:dbo.z_order"]);
  assert.deepEqual(graph.toJSON().warnings, ["partial XML"]);
  assert.equal(first.endsWith("\n"), true);
});

test("graph retains the first edge object when a duplicate edge id is added", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const source = graph.addNode({ type: "page", key: "orders.jsp", name: "orders.jsp" });
  const target = graph.addNode({ type: "route", key: "/orders", name: "/orders" });
  const firstEvidence = createEvidence("web/orders.jsp", 2, 3, "<form>");
  const secondEvidence = createEvidence("web/other.jsp", 8, 1, "fetch('/orders')");

  const first = graph.addEdge({
    source: source.id,
    target: target.id,
    type: "requests",
    confidence: 1,
    reason: "same edge id",
    evidence: [firstEvidence],
    data: { method: "POST" },
  });
  const duplicate = graph.addEdge({
    source: source.id,
    target: target.id,
    type: "requests",
    confidence: 0.25,
    reason: "same edge id",
    evidence: [secondEvidence],
    data: { method: "GET" },
  });

  assert.equal(duplicate, first);
  assert.deepEqual(graph.toJSON().edges, [first]);
  assert.equal(first.confidence, 1);
  assert.deepEqual(first.evidence, [firstEvidence]);
  assert.deepEqual(first.data, { method: "POST" });
});

test("graph deterministically adds unique node data items in first-seen order", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders", name: "/orders" });
  const post = { method: "POST", parameters: { action: "save" } };
  const get = { method: "GET", parameters: { action: "list" } };

  assert.equal(graph.addNodeDataItem(route, "requestHints", post), post);
  assert.equal(
    graph.addNodeDataItem(route.id, "requestHints", { method: "POST", parameters: { action: "save" } }),
    post,
  );
  assert.equal(graph.addNodeDataItem(route, "requestHints", get), get);

  assert.deepEqual(route.data.requestHints, [post, get]);
  assert.deepEqual(Object.keys(graph), ["projectRoot", "warnings", "nodes", "edges"]);
  assert.deepEqual(Object.keys(route), ["id", "type", "name", "evidence", "data", "searchText"]);
  assert.equal(JSON.stringify(graph).includes("requestHints"), true);
  assert.equal(JSON.stringify(graph).includes("evidenceKeys"), false);
  assert.equal(JSON.stringify(graph).includes("dataItemKeys"), false);
  const cloned = structuredClone(graph.toJSON());
  assert.deepEqual(cloned.nodes.find((node) => node.id === route.id)?.data.requestHints, [post, get]);
});

test("graph de-duplicates 10,000 evidence entries with one key calculation per incoming item", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const first = createEvidence("src/Orders.java", 1, 1, "first");
  const second = createEvidence("src/Orders.java", 2, 1, "second");
  const retained = createEvidence("src/Orders.java", 3, 1, "retained");
  const node = graph.addNode({
    type: "java_type",
    key: "com.acme.Orders",
    name: "Orders",
    evidence: [first, second, retained],
  });
  let keyCalculations = 0;
  const observedDuplicate = {
    ...retained,
    toJSON() {
      keyCalculations += 1;
      return retained;
    },
  };

  graph.addNode({
    type: "java_type",
    key: "com.acme.Orders",
    name: "Orders",
    evidence: Array.from({ length: 10_000 }, () => observedDuplicate),
  });

  assert.deepEqual(node.evidence, [first, second, retained]);
  assert.ok(keyCalculations <= 10_001, `expected constant key work per item, observed ${keyCalculations}`);

  const sameOrder = { file: "src/Orders.java", line: 3, column: 1, snippet: "retained" };
  const differentPropertyOrder = { line: 3, file: "src/Orders.java", column: 1, snippet: "retained" };
  graph.addNode({ type: "java_type", key: "com.acme.Orders", name: "Orders", evidence: [sameOrder] });
  graph.addNode({ type: "java_type", key: "com.acme.Orders", name: "Orders", evidence: [differentPropertyOrder] });
  assert.equal(node.evidence.length, 4);
  assert.deepEqual(node.evidence.at(-1), differentPropertyOrder);
});

test("graph refreshes cached evidence and search keys after in-place array replacement", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const node = graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [createEvidence("Order.java", 1, 1, "old")],
    searchText: ["old"],
  });
  node.evidence[0] = createEvidence("Order.java", 2, 1, "new");
  node.searchText[0] = "new";
  graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [createEvidence("Order.java", 1, 1, "old")],
    searchText: ["old"],
  });

  assert.deepEqual(node.evidence.map((entry) => entry.snippet), ["new", "old"]);
  assert.deepEqual(node.searchText, ["new", "old"]);
  graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [createEvidence("Order.java", 2, 1, "new")],
    searchText: ["new"],
  });
  assert.deepEqual(node.evidence.map((entry) => entry.snippet), ["new", "old"]);
  assert.deepEqual(node.searchText, ["new", "old"]);
});

test("graph refreshes cached data-item keys after in-place item mutation", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders" });
  graph.addNodeDataItem(route, "requestHints", { action: "list" });
  route.data.requestHints[0].action = "save";
  graph.addNodeDataItem(route, "requestHints", { action: "list" });
  graph.addNodeDataItem(route, "requestHints", { action: "save" });

  assert.deepEqual(route.data.requestHints, [{ action: "save" }, { action: "list" }]);
});

test("graph refreshes evidence keys after adding or deleting object properties", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const evidence = createEvidence("Orders.java", 1, 1, "old");
  const node = graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence] });

  graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence] });
  node.evidence[0].extra = "added";
  graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [{ ...evidence, extra: "added" }] });
  assert.equal(node.evidence.length, 1);

  delete node.evidence[0].snippet;
  graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [{ file: "Orders.java", line: 1, column: 1, extra: "added" }],
  });
  assert.equal(node.evidence.length, 1);
  assert.equal("snippet" in node.evidence[0], false);
});

test("graph refreshes data-item keys after adding or deleting object properties", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders" });
  const hint = { action: "list" };
  graph.addNodeDataItem(route, "requestHints", hint);
  graph.addNodeDataItem(route, "requestHints", { action: "list" });
  const storedHint = route.data.requestHints[0];

  storedHint.method = "GET";
  graph.addNodeDataItem(route, "requestHints", { action: "list", method: "GET" });
  assert.equal(route.data.requestHints.length, 1);

  delete storedHint.action;
  graph.addNodeDataItem(route, "requestHints", { method: "GET" });
  assert.equal(route.data.requestHints.length, 1);
  assert.deepEqual(route.data.requestHints[0], { method: "GET" });
});

test("graph keeps anchor checks linear for shared evidence fields", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  let nestedKeyCalculations = 0;
  const evidence = (line) => ({
    file: "Orders.java",
    line,
    column: 1,
    snippet: `line ${line}`,
    meta: {
      id: line,
      toJSON() {
        nestedKeyCalculations += 1;
        return { id: this.id };
      },
    },
  });

  graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence(1)] });
  for (let line = 2; line <= 1_000; line += 1) {
    graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence(line)] });
  }

  assert.equal(graph.nodes.get("java_type:com.acme.Order").evidence.length, 1_000);
  assert.ok(nestedKeyCalculations <= 1_001, `expected linear anchor work, observed ${nestedKeyCalculations}`);
});

test("graph refreshes data-item keys when an object gains or loses its only property", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders" });
  const hint = {};
  graph.addNodeDataItem(route, "requestHints", hint);
  const storedHint = route.data.requestHints[0];

  storedHint.action = "list";
  graph.addNodeDataItem(route, "requestHints", { action: "list" });
  assert.equal(route.data.requestHints.length, 1);

  delete storedHint.action;
  graph.addNodeDataItem(route, "requestHints", {});
  assert.equal(route.data.requestHints.length, 1);
});

test("graph collapses mutated duplicates even when the resulting shape is already indexed", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const base = createEvidence("Orders.java", 1, 1, "same");
  const node = graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [base, { ...base, extra: "existing" }],
  });

  node.evidence[0].extra = "existing";
  graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [{ ...base, extra: "existing" }],
  });

  assert.equal(node.evidence.length, 1);

  const route = graph.addNode({ type: "route", key: "/orders" });
  graph.addNodeDataItem(route, "requestHints", { kind: "one" });
  graph.addNodeDataItem(route, "requestHints", { kind: "one", extra: true });
  route.data.requestHints[0].extra = true;
  graph.addNodeDataItem(route, "requestHints", { kind: "one", extra: true });
  assert.equal(route.data.requestHints.length, 1);
});

test("graph keeps key work linear when every request hint has a different nested shape", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders" });
  let nestedReads = 0;
  for (let index = 0; index < 1_000; index += 1) {
    const parameters = {};
    Object.defineProperty(parameters, `p${index}`, {
      enumerable: true,
      get() {
        nestedReads += 1;
        return "value";
      },
    });
    graph.addNodeDataItem(route, "requestHints", {
      method: "GET",
      parameters,
      evidence: { file: "orders.jsp", line: index + 1, column: 1, snippet: "same" },
    });
  }

  assert.equal(route.data.requestHints.length, 1_000);
  assert.ok(nestedReads <= 2_001, `expected linear nested key work, observed ${nestedReads}`);
});

test("graph snapshots nested evidence so caller aliases cannot bypass observation", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const meta = { id: 1 };
  const node = graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [{ ...createEvidence("Orders.java", 1, 1, "same"), meta }],
  });

  meta.id = 2;
  graph.addNode({
    type: "java_type",
    key: "com.acme.Order",
    evidence: [{ ...createEvidence("Orders.java", 1, 1, "same"), meta: { id: 2 } }],
  });

  assert.deepEqual(node.evidence.map((entry) => entry.meta.id), [1, 2]);
});

test("graph supports primitive node data items and keeps first-seen order", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders" });
  const items = [null, "GET", 42, true];
  for (const item of items) {
    assert.equal(graph.addNodeDataItem(route, "requestHints", item), item);
    assert.equal(graph.addNodeDataItem(route, "requestHints", item), item);
  }

  assert.deepEqual(route.data.requestHints, items);
});

test("graph snapshots preserve sparse array length and JSON bytes", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({
    type: "route",
    key: "/orders",
    data: { slots: Array(2) },
  });
  graph.addNodeDataItem(route, "requestHints", Array(2));

  const json = JSON.stringify(graph.toJSON());
  assert.equal(json.includes('"slots":[null,null]'), true);
  assert.equal(json.includes('"requestHints":[[null,null]]'), true);
});

test("first node insertion preserves duplicate evidence and does not stringify it", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  let keyCalculations = 0;
  const evidence = {
    file: "Orders.java",
    line: 1,
    column: 1,
    snippet: "old",
    toJSON() {
      keyCalculations += 1;
      return this;
    },
  };

  const node = graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence, evidence] });

  assert.equal(keyCalculations, 0);
  assert.equal(node.evidence.length, 2);
});

test("repeated route hint additions keep key work linear across node merges", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/orders" });
  let keyCalculations = 0;
  for (let index = 0; index < 1_000; index += 1) {
    graph.addNode({ type: "route", key: "/orders" });
    const hint = {
      index,
      toJSON() {
        keyCalculations += 1;
        return { index };
      },
    };
    graph.addNodeDataItem(route, "requestHints", hint);
  }

  assert.equal(route.data.requestHints.length, 1_000);
  assert.ok(keyCalculations <= 1_001, `expected one key calculation per hint, observed ${keyCalculations}`);
});

test("repeated unique evidence additions do not rescan historical evidence", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  let keyCalculations = 0;
  const evidence = (index) => ({
    file: "Orders.java",
    line: index + 1,
    column: 1,
    snippet: `line ${index}`,
    toJSON() {
      keyCalculations += 1;
      return { file: this.file, line: this.line, column: this.column, snippet: this.snippet };
    },
  });
  const node = graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence(0)] });
  for (let index = 1; index < 1_000; index += 1) {
    graph.addNode({ type: "java_type", key: "com.acme.Order", evidence: [evidence(index)] });
  }

  assert.equal(node.evidence.length, 1_000);
  assert.ok(keyCalculations <= 1_001, `expected linear evidence key work, observed ${keyCalculations}`);
});

test("published JSON Schema covers the graph contract", async () => {
  const schema = JSON.parse(await readFile(new URL("../docs/graph.schema.json", import.meta.url), "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.deepEqual(schema.required, ["schemaVersion", "project", "summary", "nodes", "edges", "warnings"]);
  assert.equal(schema.properties.schemaVersion.const, "1.0.0");
  assert.equal(schema.$defs.node.required.includes("id"), true);
  assert.equal(schema.$defs.edge.required.includes("confidence"), true);
  assert.equal(schema.$defs.evidence.required.includes("line"), true);
  assert.equal(schema.$defs.edge.properties.type.enum.includes("uses_tile"), true);
  assert.equal(schema.$defs.edge.properties.type.enum.includes("redirects_to"), true);
  assert.equal(schema.$defs.edge.properties.type.enum.includes("extends_tile"), true);
});
