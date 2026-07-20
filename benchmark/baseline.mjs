import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

const TAR_BLOCK_BYTES = 512;

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function tarString(header, offset, length) {
  const field = header.subarray(offset, offset + length);
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}

function tarOctal(header, offset, length, fieldName) {
  const field = header.subarray(offset, offset + length);
  if ((field[0] & 0x80) !== 0) throw new Error(`Unsupported base-256 tar ${fieldName}`);
  const value = field.toString("ascii").replaceAll("\0", "").trim();
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) throw new Error(`Invalid tar ${fieldName}: ${JSON.stringify(value)}`);
  return Number.parseInt(value, 8);
}

function assertTarChecksum(header, entryName) {
  const expected = tarOctal(header, 148, 8, "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) throw new Error(`Invalid tar checksum for ${entryName}`);
}

function safeArchivePath(rawName) {
  const portableName = rawName.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (
    portableName === ""
    || portableName.startsWith("/")
    || /^[A-Za-z]:/.test(portableName)
    || portableName.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Unsafe tar entry path: ${JSON.stringify(rawName)}`);
  }
  return portableName;
}

function isMacMetadata(entryPath) {
  const parts = entryPath.split("/");
  return parts[0] === "__MACOSX" || parts.some((part) => part.startsWith("._"));
}

function parseTarGzip(archive) {
  const tar = gunzipSync(archive);
  const entries = [];
  let offset = 0;

  while (offset + TAR_BLOCK_BYTES <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      if (!tar.subarray(offset).every((byte) => byte === 0)) {
        throw new Error("Unexpected non-zero data after tar end marker");
      }
      return entries;
    }

    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const rawName = prefix ? `${prefix}/${name}` : name;
    const entryPath = safeArchivePath(rawName);
    assertTarChecksum(header, entryPath);
    const size = tarOctal(header, 124, 12, "size");
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar size for ${entryPath}`);
    const dataStart = offset + TAR_BLOCK_BYTES;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error(`Truncated tar entry: ${entryPath}`);
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    entries.push({
      path: entryPath,
      type,
      mode: tarOctal(header, 100, 8, "mode"),
      data: tar.subarray(dataStart, dataEnd),
    });
    offset = dataStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
  }

  throw new Error("Tar archive has no end marker");
}

function runtimeFiles(entries) {
  const files = new Map();
  for (const entry of entries) {
    if (["x", "g"].includes(entry.type) || entry.type === "5" || isMacMetadata(entry.path)) continue;
    if (entry.type !== "0") throw new Error(`Unsupported tar entry type ${entry.type} for ${entry.path}`);
    if (files.has(entry.path)) throw new Error(`Duplicate runtime file in archive: ${entry.path}`);
    files.set(entry.path, entry);
  }
  return files;
}

function validateManifestFiles(files) {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("Baseline manifest files must be an object");
  }
  const validated = new Map();
  for (const [filePath, digest] of Object.entries(files)) {
    const normalized = safeArchivePath(filePath);
    if (normalized !== filePath) throw new Error(`Baseline manifest has a non-canonical path: ${filePath}`);
    if (typeof digest !== "string" || !/^[a-fA-F0-9]{64}$/.test(digest)) {
      throw new Error(`Baseline manifest has an invalid SHA-256 for ${filePath}`);
    }
    validated.set(filePath, digest.toLowerCase());
  }
  return validated;
}

function sortedDifference(left, right) {
  return [...left.keys()].filter((key) => !right.has(key)).sort((a, b) => a.localeCompare(b, "en"));
}

async function loadVerifiedBaseline({ archivePath, manifestPath }) {
  const [archive, manifestSource] = await Promise.all([
    readFile(archivePath),
    readFile(manifestPath, "utf8"),
  ]);
  const manifest = JSON.parse(manifestSource);
  const expectedArchiveSha256 = manifest?.archive?.sha256;
  if (typeof expectedArchiveSha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(expectedArchiveSha256)) {
    throw new Error("Baseline manifest has an invalid archive SHA-256");
  }
  const archiveSha256 = sha256(archive);
  if (archiveSha256 !== expectedArchiveSha256.toLowerCase()) {
    throw new Error(`Baseline archive SHA-256 mismatch: expected ${expectedArchiveSha256}, received ${archiveSha256}`);
  }

  const archivedFiles = runtimeFiles(parseTarGzip(archive));
  const manifestFiles = validateManifestFiles(manifest.files);
  const archiveOnly = sortedDifference(archivedFiles, manifestFiles);
  const manifestOnly = sortedDifference(manifestFiles, archivedFiles);
  if (archiveOnly.length > 0 || manifestOnly.length > 0) {
    throw new Error(
      `Baseline runtime file set mismatch: archive-only=[${archiveOnly.join(", ")}], manifest-only=[${manifestOnly.join(", ")}]`,
    );
  }

  for (const [filePath, entry] of archivedFiles) {
    const actual = sha256(entry.data);
    const expected = manifestFiles.get(filePath);
    if (actual !== expected) {
      throw new Error(`Baseline runtime file SHA-256 mismatch for ${filePath}: expected ${expected}, received ${actual}`);
    }
  }

  return { archiveSha256, files: archivedFiles };
}

export async function verifyBaseline({ archivePath, manifestPath }) {
  const verified = await loadVerifiedBaseline({ archivePath, manifestPath });
  return { archiveSha256: verified.archiveSha256, fileCount: verified.files.size };
}

function inferredManifestPath(archivePath) {
  return archivePath.endsWith(".tar.gz")
    ? `${archivePath.slice(0, -".tar.gz".length)}.manifest.json`
    : `${archivePath}.manifest.json`;
}

export async function extractBaseline({ archivePath, destination, manifestPath = inferredManifestPath(archivePath) }) {
  const verified = await loadVerifiedBaseline({ archivePath, manifestPath });
  const root = path.resolve(destination);
  let rootCreated = false;
  try {
    await mkdir(path.dirname(root), { recursive: true });
    try {
      await mkdir(root, { mode: 0o700 });
      rootCreated = true;
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error(`Baseline extraction destination must not exist: ${root}`, { cause: error });
      }
      throw error;
    }

    for (const entry of verified.files.values()) {
      const target = path.resolve(root, ...entry.path.split("/"));
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Tar entry escapes extraction root: ${entry.path}`);
      }
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, entry.data, { flag: "wx", mode: entry.mode & 0o777 });
      if (process.platform !== "win32") await chmod(target, entry.mode & 0o777);
    }

    return root;
  } catch (error) {
    if (rootCreated) await rm(root, { recursive: true, force: true });
    throw error;
  }
}

function runProcess(executable, argumentsList, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argumentsList, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else {
        const detail = Buffer.concat(stderr).toString("utf8").trim();
        reject(new Error(`Baseline process failed (${signal ? `signal ${signal}` : `exit ${code}`}): ${detail}`));
      }
    });
  });
}

export async function runBaselineGraph({ baselineRoot, projectRoot }) {
  if (!path.isAbsolute(projectRoot)) throw new Error("projectRoot must be absolute for Graph equivalence");
  const root = path.resolve(baselineRoot);
  const cli = path.join(root, "bin", "legacy-code-atlas.mjs");
  const outputRoot = await mkdtemp(path.join(tmpdir(), "legacy-atlas-baseline-graph-"));
  const outputPath = path.join(outputRoot, "index.json");
  try {
    await runProcess(
      process.execPath,
      [cli, "analyze", projectRoot, "--output", outputPath],
      { cwd: root },
    );
    const serialized = await readFile(outputPath, "utf8");
    return { graph: JSON.parse(serialized), serialized };
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

function serializedGraph(value, label) {
  if (typeof value === "string") return value;
  if (value && typeof value.serialized === "string") return value.serialized;
  throw new TypeError(`${label} must be a serialized Graph string or an object with serialized bytes`);
}

export function assertGraphEquivalent(expected, actual) {
  assert.strictEqual(
    serializedGraph(actual, "actual"),
    serializedGraph(expected, "expected"),
    "Graph serialization mismatch",
  );
}
