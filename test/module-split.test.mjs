import assert from "node:assert/strict";
import test from "node:test";

import { pageArrivalContexts } from "../src/arrival-contexts.mjs";
import { GraphBuilder } from "../src/graph.mjs";
import { stripJavaComments as stripFromJava } from "../src/parsers/java.mjs";
import { stripJavaComments } from "../src/parsers/java-source.mjs";

test("materializer arrival contexts work from their own module", () => {
  const graph = new GraphBuilder({ projectRoot: "/repo" });
  const route = graph.addNode({ type: "route", key: "/a.do", name: "/a.do" });
  const page = graph.addNode({ type: "page", key: "web/a.jsp", name: "a.jsp", filePath: "web/a.jsp" });
  graph.addEdge({ source: route.id, target: page.id, type: "forwards_to", confidence: 1, reason: "forward" });
  const contexts = pageArrivalContexts(graph);
  // A page reached from a route seed takes itself as its top page.
  assert.deepEqual(contexts.get(page.id), [{ routeUrl: "/a.do", topPageId: page.id }]);
});

test("java parser re-exports the java-source preprocessing API", () => {
  assert.equal(stripFromJava, stripJavaComments);
  const stripped = stripJavaComments("class A { /* x */ int y; }");
  assert.equal(stripped.includes("/*"), false);
  assert.equal(stripped.includes("int y;"), true);
  assert.equal(stripped.length, "class A { /* x */ int y; }".length);
});
