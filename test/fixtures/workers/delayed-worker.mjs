import { parentPort, workerData } from "node:worker_threads";

import { parserKindFor } from "../../../src/file-facts.mjs";
import { readAndProcessFile } from "../../../src/file-processor.mjs";

if (!parentPort) throw new Error("delayed-worker requires a parent port");

const control = workerData?.control;
if (control) Atomics.add(new Int32Array(control), 0, 1);

let busy = false;

parentPort.postMessage({ type: "ready", protocolVersion: 1 });
parentPort.on("message", async (message) => {
  if (busy) throw new Error("delayed-worker received overlapping batches");
  busy = true;
  try {
    if (control) Atomics.add(new Int32Array(control), 1, 1);
    const delayMs = Math.max(0, ...message.files.map((file) => file.workerDelayMs ?? 0));
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));

    const results = [];
    for (const file of message.files) {
      const parserKind = parserKindFor(file);
      const parsers = file.workerParserError
        ? {
            [parserKind]() {
              throw new Error(`fixture parser failure at ${file.absolutePath}`);
            },
          }
        : undefined;
      results.push(await readAndProcessFile(file, { cached: file.cached, parsers }));
    }
    parentPort.postMessage({
      type: "batch-result",
      batchId: message.batchId,
      results,
    });
  } finally {
    busy = false;
  }
});
