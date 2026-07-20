import { availableParallelism } from "node:os";

export function createAbortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function positiveInteger(name, value) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

export function resolveConcurrencyOptions(options = {}) {
  const workers = options.workers === undefined
    ? Math.min(8, Math.max(1, availableParallelism() - 1))
    : positiveInteger("workers", options.workers);
  const scanConcurrency = options.scanConcurrency === undefined
    ? Math.min(32, workers * 4)
    : positiveInteger("scanConcurrency", options.scanConcurrency);
  return { workers, scanConcurrency };
}

export function raceWithAbort(value, signal) {
  throwIfAborted(signal);
  if (!signal) return Promise.resolve(value);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback(result);
    };
    const onAbort = () => finish(reject, createAbortError());

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(value).then(
      (result) => finish(resolve, result),
      (error) => finish(reject, error),
    );
  });
}

export function runBoundedQueue(initialItems, worker, options = {}) {
  const concurrency = positiveInteger("concurrency", options.concurrency);
  const { signal } = options;
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const queue = [...initialItems];
    let active = 0;
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = () => {
      if (settled || active !== 0 || queue.length !== 0) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      queue.length = 0;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(createAbortError());

    const enqueue = (...items) => {
      throwIfAborted(signal);
      if (settled || items.length === 0) return;
      queue.push(...items);
      pump();
    };

    function pump() {
      while (!settled && active < concurrency && queue.length > 0) {
        const item = queue.shift();
        active += 1;
        Promise.resolve()
          .then(() => {
            throwIfAborted(signal);
            if (settled) return undefined;
            return worker(item, enqueue);
          })
          .then(
            () => {
              active -= 1;
              if (settled) return;
              pump();
              finish();
            },
            (error) => {
              active -= 1;
              fail(error);
            },
          );
      }
      finish();
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    pump();
  });
}
