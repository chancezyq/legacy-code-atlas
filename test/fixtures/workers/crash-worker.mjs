import { parentPort, workerData } from "node:worker_threads";

import { readAndProcessFile } from "../../../src/file-processor.mjs";

if (!parentPort) throw new Error("crash-worker requires a parent port");

const counters = workerData?.control ? new Int32Array(workerData.control) : null;
if (counters) Atomics.add(counters, 0, 1);

function mutateProtocolResult(result, mode) {
  switch (mode) {
    case "missing-result-field":
      delete result.reused;
      break;
    case "extra-result-graph":
      result.graph = { nodes: [] };
      break;
    case "missing-record-field":
      delete result.record.parserVersion;
      break;
    case "deep-graph-builder":
      result.record.facts.nested = { GraphBuilder: { nodes: [] } };
      break;
    case "deep-worker-id":
      result.record.facts.nested = { Worker_ID: 7 };
      break;
    case "deep-timing":
      result.record.facts.nested = { Timings: { parse: 12 } };
      break;
    case "invalid-parser-kind":
      result.parserKind = "jsp";
      break;
    case "invalid-fingerprint":
      result.fingerprint = null;
      break;
    case "invalid-metadata-shape":
      result.metadata.extra = true;
      break;
    case "invalid-record-facts":
      result.record.facts = null;
      break;
    case "invalid-record-facts-array":
      result.record.facts = [];
      break;
    case "mismatched-diagnostics":
      result.diagnostics = [{ code: "forged-diagnostic" }];
      break;
    case "invalid-error-object":
      result.status = "error";
      result.record.status = "error";
      result.record.facts = null;
      result.record.error = { name: "Error" };
      break;
    case "absolute-record-warning":
      result.record.warnings = ["parser warning at D:\\other-project\\secret.java"];
      break;
    case "absolute-valid-diagnostic": {
      const diagnostics = [{
        code: "parser-note",
        relativePath: result.relativePath,
        message: "failure at C:\\company\\legacy-project\\src\\Broken.java",
      }];
      result.diagnostics = diagnostics;
      result.record.diagnostics = diagnostics;
      break;
    }
    case "absolute-valid-error": {
      const diagnostics = [{
        code: "parser-error",
        relativePath: result.relativePath,
        parserKind: result.parserKind,
        message: "parser failed",
      }];
      result.status = "error";
      result.record.status = "error";
      result.record.facts = null;
      result.record.diagnostics = diagnostics;
      result.diagnostics = diagnostics;
      result.record.error = {
        name: "Error",
        message: "failure at /private/company/legacy-project/src/Broken.java",
      };
      break;
    }
    case "unknown-posix-fact-path":
      result.record.facts.secret = "/private/other-project/secret.java";
      break;
    case "unknown-windows-fact-path":
      result.record.facts.secret = "D:\\other-project\\secret.java";
      break;
    case "unknown-unc-fact-path":
      result.record.facts.secret = "\\\\server\\share\\secret.java";
      break;
    case "valid-route-and-http-url":
      result.record.facts.route = "/api/orders/list";
      result.record.facts.documentation = "https://example.com/private/reference";
      break;
    default:
      break;
  }
}

if (workerData?.startupMode === "throw") {
  throw new Error("startup failure at /private/company/legacy-project");
}
if (workerData?.startupMode === "exit") process.exit(31);

if (workerData?.startupMode !== "hang") {
  parentPort.postMessage({ type: "ready", protocolVersion: 1 });
}
parentPort.on("message", async (message) => {
  const dispatch = counters ? Atomics.add(counters, 1, 1) + 1 : 1;
  if (workerData?.protocolMode === "unexpected") {
    parentPort.postMessage({ type: "unexpected", absolutePath: "/private/company/legacy-project" });
    return;
  }
  if (workerData?.protocolMode === "wrong-batch-id") {
    parentPort.postMessage({
      type: "batch-result",
      batchId: `${message.batchId}-wrong`,
      results: [],
    });
    return;
  }
  if (workerData?.protocolMode === "absolute-result-path") {
    parentPort.postMessage({
      type: "batch-result",
      batchId: message.batchId,
      results: [{
        status: "error",
        relativePath: message.files[0].absolutePath,
        diagnostics: [{ message: message.files[0].absolutePath }],
      }],
    });
    return;
  }
  if (workerData?.protocolMode === "cross-file-absolute-diagnostic") {
    parentPort.postMessage({
      type: "batch-result",
      batchId: message.batchId,
      results: message.files.map((file, index) => ({
        status: "error",
        relativePath: file.relativePath,
        diagnostics: [{
          message: message.files[(index + 1) % message.files.length].absolutePath,
        }],
      })),
    });
    return;
  }
  if (workerData?.protocolMode === "windows-absolute-diagnostic") {
    parentPort.postMessage({
      type: "batch-result",
      batchId: message.batchId,
      results: message.files.map((file) => ({
        status: "error",
        relativePath: file.relativePath,
        diagnostics: [{ message: "failure at C:\\company\\legacy-project\\src\\Broken.java" }],
      })),
    });
    return;
  }

  const crashesForAttempt = message.files.some(
    (file) => Number.isInteger(file.workerCrashAttempts) && dispatch <= file.workerCrashAttempts,
  );
  const crashesForSize = message.files.some(
    (file) => Number.isInteger(file.workerCrashAtSize) && message.files.length >= file.workerCrashAtSize,
  );
  if (crashesForAttempt || crashesForSize || message.files.some((file) => file.workerCrashAlways)) {
    const delayMs = Math.max(0, ...message.files.map((file) => file.workerCrashDelayMs ?? 0));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    process.exit(41);
  }

  const results = [];
  for (const file of message.files) {
    results.push(await readAndProcessFile(file, { cached: file.cached }));
  }
  for (const result of results) mutateProtocolResult(result, workerData?.protocolMode);
  parentPort.postMessage({
    type: "batch-result",
    batchId: message.batchId,
    results,
  });
});
