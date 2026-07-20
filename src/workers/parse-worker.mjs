import { parentPort } from "node:worker_threads";

import { readAndProcessFile } from "../file-processor.mjs";

const PROTOCOL_VERSION = 1;

if (!parentPort) throw new Error("parse-worker requires a parent port");

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function validRequest(message) {
  return isPlainObject(message)
    && hasExactKeys(message, ["type", "batchId", "files"])
    && message.type === "process-batch"
    && typeof message.batchId === "string"
    && message.batchId.length > 0
    && Array.isArray(message.files)
    && message.files.length > 0;
}

let busy = false;

async function processMessage(message) {
  if (busy || !validRequest(message)) {
    throw new Error("invalid parse-worker request");
  }
  busy = true;
  try {
    const results = [];
    for (const file of message.files) {
      results.push(await readAndProcessFile(file, { cached: file?.cached }));
    }
    parentPort.postMessage({
      type: "batch-result",
      batchId: message.batchId,
      results,
    });
  } finally {
    busy = false;
  }
}

parentPort.on("message", (message) => {
  processMessage(message).catch((error) => {
    setImmediate(() => { throw error; });
  });
});
parentPort.postMessage({ type: "ready", protocolVersion: PROTOCOL_VERSION });
