import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertGraphEquivalent,
  extractBaseline,
  runBaselineGraph,
  verifyBaseline,
} from "../benchmark/baseline.mjs";
import { analyzeProject } from "../src/analyzer.mjs";
import { serializeGraph } from "../src/graph.mjs";

const archivePath = fileURLToPath(
  new URL("../benchmark/baselines/legacy-code-atlas-0.1.0.tar.gz", import.meta.url),
);
const manifestPath = fileURLToPath(
  new URL("../benchmark/baselines/legacy-code-atlas-0.1.0.manifest.json", import.meta.url),
);
const projectRoot = path.resolve(fileURLToPath(new URL("./fixtures/legacy-shop", import.meta.url)));

function nodeById(graph, id) {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  assert.ok(node, `missing node: ${id}`);
  return node;
}

function normalizedForExpectedEvidenceAdditions(graph) {
  const normalized = structuredClone(graph);
  const expectedAdditions = [
    ["route:/order/audit.do", "decision", "PASS"],
    ["route:/order/audit/status.do", "id", ""],
    ["route:/order/detail.do", "id", ""],
  ];
  for (const [routeId, parameter, value] of expectedAdditions) {
    const route = nodeById(normalized, routeId);
    const hint = route.data.requestHints?.find((candidate) => candidate.parameters?.[parameter] === value);
    assert.ok(hint, `${routeId} must retain proven ${parameter}=${JSON.stringify(value)}`);
    delete hint.parameters[parameter];
  }

  const auditRoute = nodeById(normalized, "route:/order/audit.do");
  const auditHint = auditRoute.data.requestHints?.find(
    (candidate) => candidate.parameters?.orderId === "",
  );
  assert.ok(auditHint, "runtime-derived orderId default must remain an unresolved static parameter");
  auditHint.parameters.orderId = "${order.id}";

  const expectedOutcomes = new Map([
    [
      "route:/order/audit.do|forwards_to|page:order/auditSuccess.jsp|Struts forward success",
      {
        framework: "struts1",
        name: "success",
        classification: "code-confirmed",
        codeEvidence: [{
          file: "src/com/acme/order/web/OrderAuditAction.java",
          line: 17,
          column: 9,
          snippet: 'return mapping.findForward("success");',
        }],
      },
    ],
    [
      "route:/order/audit.do|forwards_to|page:web/order/audit.jsp|Struts forward error",
      {
        framework: "struts1",
        name: "error",
        classification: "configured-candidate",
        codeEvidence: [],
      },
    ],
  ]);
  const outcomeEdges = normalized.edges.filter((edge) => edge.data?.outcome);
  assert.deepEqual(
    outcomeEdges.map((edge) => edge.id).sort(),
    [...expectedOutcomes.keys()].sort(),
    "only the expected Struts outcomes may gain classification metadata",
  );
  for (const edge of outcomeEdges) {
    assert.deepEqual(edge.data.outcome, expectedOutcomes.get(edge.id));
    delete edge.data.outcome;
  }
  const auditPage = nodeById(normalized, "page:web/order/audit.jsp");
  assert.deepEqual(
    auditPage.data.fieldDetails?.map((field) => ({
      name: field.name,
      element: field.element,
      inputType: field.inputType,
      staticValue: field.staticValue,
      runtimeDerived: field.runtimeDerived,
      submittable: field.submittable,
      file: field.evidence?.file,
      line: field.evidence?.line,
    })),
    [
      { name: "orderId", element: "input", inputType: "hidden", staticValue: "", runtimeDerived: true, submittable: true, file: "web/order/audit.jsp", line: 9 },
      { name: "method", element: "input", inputType: "hidden", staticValue: "audit", runtimeDerived: false, submittable: true, file: "web/order/audit.jsp", line: 10 },
      { name: "decision", element: "select", inputType: "select", staticValue: "PASS", runtimeDerived: false, submittable: true, file: "web/order/audit.jsp", line: 11 },
    ],
    "only the expected audit page may gain rich technical-document field facts",
  );
  const pagesWithFieldDetails = normalized.nodes.filter((node) => node.data?.fieldDetails);
  assert.deepEqual(pagesWithFieldDetails.map(({ id }) => id), ["page:web/order/audit.jsp"]);
  const { fieldDetails: retainedFieldDetails, ...baselinePageData } = auditPage.data;
  assert.ok(retainedFieldDetails.length > 0);
  auditPage.data = baselinePageData;
  return normalized;
}

test("frozen baseline differs only by expected request evidence and outcome classifications", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "legacy-atlas-baseline-"));
  const baselineRoot = path.join(parent, "runtime");
  t.after(() => rm(parent, { recursive: true, force: true }));
  assert.equal(path.isAbsolute(projectRoot), true);
  await verifyBaseline({ archivePath, manifestPath });
  await extractBaseline({ archivePath, manifestPath, destination: baselineRoot });

  const baseline = await runBaselineGraph({ baselineRoot, projectRoot });
  const actual = await analyzeProject(projectRoot);
  const candidateSerialized = serializeGraph(actual);

  assert.equal(baseline.graph.project.root, projectRoot);
  assert.equal(actual.project.root, projectRoot);
  assert.notEqual(baseline.serialized, candidateSerialized);
  const normalizedSerialized = serializeGraph(normalizedForExpectedEvidenceAdditions(actual));
  assert.doesNotThrow(() => assertGraphEquivalent(baseline, normalizedSerialized));
});

test("assertGraphEquivalent rejects whitespace-only and trailing-newline byte differences", () => {
  const serialized = "{\n  \"schemaVersion\": \"1.0.0\"\n}\n";
  const baseline = { graph: { schemaVersion: "1.0.0" }, serialized };

  assert.doesNotThrow(() => assertGraphEquivalent(baseline, serialized));
  for (const changed of ["{\n \"schemaVersion\": \"1.0.0\"\n}\n", serialized.trimEnd()]) {
    assert.throws(
      () => assertGraphEquivalent(baseline, changed),
      /Graph serialization mismatch/i,
    );
  }
});
