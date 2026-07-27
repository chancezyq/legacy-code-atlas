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

function normalizedForProvenRequestParameters(graph) {
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
  return normalized;
}

test("frozen baseline differs only by newly proven request parameters", async (t) => {
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
  const normalizedSerialized = serializeGraph(normalizedForProvenRequestParameters(actual));
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
