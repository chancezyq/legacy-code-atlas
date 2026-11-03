import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function setFromSource(source, name) {
  const match = source.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\);`));
  assert.ok(match, `${name} must be declared as a Set literal`);
  return new Set([...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]));
}

test("graph schema and index validation agree on node and edge shapes", async () => {
  const [schemaText, validationSource] = await Promise.all([
    readFile(new URL("../docs/graph.schema.json", import.meta.url), "utf8"),
    readFile(new URL("../src/index-validation.mjs", import.meta.url), "utf8"),
  ]);
  const schema = JSON.parse(schemaText);
  const nodeDef = schema.$defs.node;
  const edgeDef = schema.$defs.edge;

  assert.deepEqual([...setFromSource(validationSource, "NODE_TYPES")].sort(), [...nodeDef.properties.type.enum].sort());
  assert.deepEqual([...setFromSource(validationSource, "EDGE_TYPES")].sort(), [...edgeDef.properties.type.enum].sort());
  assert.deepEqual([...setFromSource(validationSource, "NODE_KEYS")].sort(), Object.keys(nodeDef.properties).sort());
  assert.deepEqual([...setFromSource(validationSource, "EDGE_KEYS")].sort(), Object.keys(edgeDef.properties).sort());
  assert.deepEqual([...nodeDef.required].sort(), ["data", "evidence", "id", "name", "searchText", "type"].sort());
  assert.equal(schema.properties.schemaVersion.const, "1.0.0");
});
