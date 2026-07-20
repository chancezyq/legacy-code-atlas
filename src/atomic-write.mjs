import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const defaultFs = { mkdir, open, rename, rm, stat };
const TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error && signal.reason.name === "AbortError") throw signal.reason;
  const error = new Error("operation aborted");
  error.name = "AbortError";
  throw error;
}

async function renameWithRetry(io, source, target, {
  signal,
  renameRetries,
  retryDelayMs,
  sleep,
}) {
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    try {
      await io.rename(source, target);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_CODES.has(error?.code) || attempt >= renameRetries) throw error;
      await sleep(retryDelayMs);
    }
  }
}

async function targetMode(io, target, explicitMode) {
  if (explicitMode !== undefined) return explicitMode;
  try {
    return (await io.stat(target)).mode & 0o777;
  } catch (error) {
    if (error?.code === "ENOENT") return 0o666;
    throw error;
  }
}

/**
 * Write a file through a same-directory temporary and atomic rename.
 * The optional fs object exists to make failure cleanup testable.
 */
export async function writeFileAtomic(filePath, data, {
  io = defaultFs,
  mode,
  renameRetries = 4,
  retryDelayMs = 10,
  signal,
  sleep = defaultSleep,
} = {}) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    throw new TypeError("file path is required");
  }
  if (!Number.isInteger(renameRetries) || renameRetries < 0) {
    throw new TypeError("renameRetries must be a nonnegative integer");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
    throw new TypeError("retryDelayMs must be a nonnegative finite number");
  }
  const target = path.resolve(filePath);
  const parent = path.dirname(target);
  const basename = path.basename(target).slice(0, 96);
  const temporary = path.join(
    parent,
    `.${basename}.legacy-code-atlas-${process.pid}-${randomUUID()}.tmp`,
  );

  throwIfAborted(signal);
  await io.mkdir(parent, { recursive: true });
  throwIfAborted(signal);
  const temporaryMode = await targetMode(io, target, mode);
  let handle = null;
  try {
    throwIfAborted(signal);
    handle = await io.open(temporary, "wx", temporaryMode);
    throwIfAborted(signal);
    await handle.writeFile(data, signal ? { signal } : undefined);
    throwIfAborted(signal);
    await handle.sync();
    throwIfAborted(signal);
    await handle.close();
    handle = null;
    await renameWithRetry(io, temporary, target, {
      signal,
      renameRetries,
      retryDelayMs,
      sleep,
    });
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        // Preserve the original write or rename error.
      }
    }
    try {
      await io.rm(temporary, { force: true });
    } catch {
      // Cleanup is best effort and must not hide the original error.
    }
    throw error;
  }
}
