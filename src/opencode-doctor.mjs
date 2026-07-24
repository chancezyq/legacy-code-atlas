import { createHash } from "node:crypto";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";

const MAX_TOOL_BYTES = 64 * 1024;
const MAX_TOOL_ENTRIES = 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const INSTALL_MANIFEST = ".legacy-code-atlas-owner.json";
const TOOL_FILE_PATTERN = /\.(?:js|ts)$/i;
const RELEASED_LEGACY_TOOL_HASHES = new Map([
  ["410c82a1cbc65a4fef185f8f2b6da506ab328997c505569e4a88a3667a9290ff", "legacy Bun tool (LF)"],
  ["17a88674fd7f9822b2d7dbf0320af8bbb3f6a7abdb7ef725ab6066a505310e57", "legacy Bun tool (CRLF)"],
  ["5a7985a2de64f6bc072c7890d2a3964d6645a3ed694c804f5896f615d8510235", "legacy Node tool (LF)"],
  ["1d683e03f06b0c1cdd80671174c5bc467bd4b871736de2728be3e530fb87d4cc", "legacy Node tool (CRLF)"],
]);

function compareText(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pathKey(value, platform) {
  return platform === "win32" ? value.toLowerCase() : value;
}

function nonempty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeKnownHashes(input) {
  const source = input ?? RELEASED_LEGACY_TOOL_HASHES;
  const entries = source instanceof Map ? [...source] : Object.entries(source);
  const normalized = new Map();
  for (const [rawHash, rawRelease] of entries) {
    const hash = String(rawHash).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError("known tool hash must be SHA-256");
    normalized.set(hash, String(rawRelease));
  }
  return normalized;
}

function addRoot(roots, rootPath, source, platform) {
  if (!nonempty(rootPath)) return;
  const absolute = path.resolve(rootPath);
  const key = pathKey(absolute, platform);
  let entry = roots.get(key);
  if (!entry) {
    entry = { path: absolute, sources: new Set(), status: "unchecked" };
    roots.set(key, entry);
  }
  entry.sources.add(source);
}

function isSameOrDescendant(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left, right, platform) {
  return pathKey(path.resolve(left), platform) === pathKey(path.resolve(right), platform);
}

function validSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function validOwnedFile(entry, kind, expectedPath, platform) {
  return entry
    && typeof entry === "object"
    && !Array.isArray(entry)
    && entry.kind === kind
    && nonempty(entry.path)
    && path.isAbsolute(entry.path)
    && samePath(entry.path, expectedPath, platform)
    && validSha256(entry.sha256);
}

function validInstallManifest(manifest, homeDir, platform) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const version = manifest.version;
  if (![1, 2, 3].includes(version)
    || manifest.owner !== `legacy-code-atlas-install-v${version}`
    || !nonempty(manifest.installDir)
    || !path.isAbsolute(manifest.installDir)
    || !samePath(manifest.installDir, path.join(homeDir, ".legacy-code-atlas"), platform)
    || !nonempty(manifest.configDir)
    || !path.isAbsolute(manifest.configDir)) {
    return false;
  }

  const toolTarget = path.join(manifest.configDir, "tools", "legacy_atlas.ts");
  const skillTarget = path.join(homeDir, ".agents", "skills", "atlas", "SKILL.md");
  if (version === 1) {
    return nonempty(manifest.commandTarget)
      && path.isAbsolute(manifest.commandTarget)
      && samePath(manifest.commandTarget, path.join(manifest.configDir, "commands", "understand.md"), platform)
      && nonempty(manifest.toolTarget)
      && path.isAbsolute(manifest.toolTarget)
      && samePath(manifest.toolTarget, toolTarget, platform)
      && validSha256(manifest.commandHash)
      && validSha256(manifest.toolHash);
  }

  if (!Array.isArray(manifest.ownedFiles)) return false;
  if (version === 2) {
    if (manifest.ownedFiles.length !== 2) return false;
    const byKind = new Map(manifest.ownedFiles.map((entry) => [entry?.kind, entry]));
    return byKind.size === 2
      && validOwnedFile(byKind.get("agent-skill"), "agent-skill", skillTarget, platform)
      && validOwnedFile(byKind.get("opencode-tool"), "opencode-tool", toolTarget, platform);
  }
  return manifest.ownedFiles.length === 1
    && validOwnedFile(manifest.ownedFiles[0], "agent-skill", skillTarget, platform);
}

async function detectWorktreeRoot(projectRoot) {
  let current = projectRoot;
  while (true) {
    if (await entryOrNull(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return projectRoot;
    current = parent;
  }
}

function addProjectRoots(roots, projectRoot, worktreeRoot, platform) {
  let current = projectRoot;
  let first = true;
  while (true) {
    addRoot(roots, path.join(current, ".opencode"), first ? "project" : "project-ancestor", platform);
    if (current === worktreeRoot) break;
    first = false;
    const parent = path.dirname(current);
    if (parent === current) throw new TypeError("worktree root must contain the project");
    current = parent;
  }
}

async function entryOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function manifestConfig(homeDir, platform) {
  const installDir = path.join(homeDir, ".legacy-code-atlas");
  const manifestPath = path.join(installDir, INSTALL_MANIFEST);
  const installEntry = await entryOrNull(installDir);
  if (installEntry && (!installEntry.isDirectory() || installEntry.isSymbolicLink())) {
    return {
      configDir: null,
      issue: { code: "invalid-install-manifest", path: manifestPath },
    };
  }
  const entry = await entryOrNull(manifestPath);
  if (!entry) {
    return {
      configDir: null,
      issue: installEntry ? { code: "invalid-install-manifest", path: manifestPath } : null,
    };
  }
  if (!entry.isFile() || entry.isSymbolicLink() || Number(entry.nlink) > 1 || entry.size > MAX_MANIFEST_BYTES) {
    return {
      configDir: null,
      issue: { code: "invalid-install-manifest", path: manifestPath },
    };
  }

  try {
    const inspected = await readToolFile(manifestPath, MAX_MANIFEST_BYTES);
    if (inspected.status !== "ok") throw new Error("invalid manifest file");
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(inspected.content);
    const manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    if (!validInstallManifest(manifest, homeDir, platform)) throw new Error("invalid manifest");
    return { configDir: manifest.configDir, issue: null };
  } catch {
    return {
      configDir: null,
      issue: { code: "invalid-install-manifest", path: manifestPath },
    };
  }
}

function conflictForUninspectable(candidatePath) {
  return {
    path: candidatePath,
    classification: "uninspectable-legacy-atlas-tool",
    sha256: null,
    release: null,
  };
}

function suspiciousLegacyName(fileName) {
  return path.parse(fileName).name.toLowerCase() === "legacy_atlas";
}

async function readToolFile(candidatePath, maxToolBytes) {
  let handle;
  try {
    handle = await open(candidatePath, "r");
    const before = await handle.stat();
    const current = await lstat(candidatePath);
    if (!before.isFile()
      || !current.isFile()
      || current.isSymbolicLink()
      || Number(before.nlink) > 1
      || (Number.isInteger(before.dev) && Number.isInteger(current.dev) && before.dev !== current.dev)
      || (Number.isInteger(before.ino) && Number.isInteger(current.ino) && before.ino !== current.ino)) {
      return { status: "uninspectable", content: null };
    }
    if (before.size > maxToolBytes) return { status: "oversized", content: null };

    const buffer = Buffer.alloc(maxToolBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const after = await handle.stat();
    if (bytesRead > maxToolBytes) return { status: "oversized", content: null };
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytesRead !== after.size) {
      return { status: "changed", content: null };
    }
    return { status: "ok", content: buffer.subarray(0, bytesRead) };
  } catch {
    return { status: "unreadable", content: null };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectToolDirectory(toolDirectory, context) {
  let directoryEntry;
  try {
    directoryEntry = await entryOrNull(toolDirectory);
  } catch {
    context.issues.push({ code: "unreadable-tool-directory", path: toolDirectory });
    return;
  }
  if (!directoryEntry) return;
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
    context.issues.push({ code: "uninspectable-tool-directory", path: toolDirectory });
    return;
  }

  let entries;
  try {
    entries = await readdir(toolDirectory, { withFileTypes: true });
  } catch {
    context.issues.push({ code: "unreadable-tool-directory", path: toolDirectory });
    return;
  }
  entries.sort((left, right) => compareText(left.name, right.name));
  if (entries.length > context.maxToolEntries) {
    context.issues.push({
      code: "too-many-tool-entries",
      path: toolDirectory,
      limit: context.maxToolEntries,
    });
    return;
  }

  for (const directoryItem of entries) {
    if (!TOOL_FILE_PATTERN.test(directoryItem.name)) continue;
    const candidatePath = path.join(toolDirectory, directoryItem.name);
    const suspiciousName = suspiciousLegacyName(directoryItem.name);
    if (directoryItem.isSymbolicLink() || !directoryItem.isFile()) {
      if (suspiciousName) context.conflicts.push(conflictForUninspectable(candidatePath));
      else context.issues.push({ code: "uninspectable-tool-file", path: candidatePath });
      continue;
    }

    let entry;
    try {
      entry = await lstat(candidatePath);
    } catch {
      if (suspiciousName) context.conflicts.push(conflictForUninspectable(candidatePath));
      else context.issues.push({ code: "uninspectable-tool-file", path: candidatePath });
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      if (suspiciousName) context.conflicts.push(conflictForUninspectable(candidatePath));
      else context.issues.push({ code: "uninspectable-tool-file", path: candidatePath });
      continue;
    }
    const inspected = await readToolFile(candidatePath, context.maxToolBytes);
    if (inspected.status !== "ok") {
      if (suspiciousName) {
        context.conflicts.push({
          ...conflictForUninspectable(candidatePath),
          classification: inspected.status === "oversized"
            ? "oversized-legacy-atlas-tool"
            : "uninspectable-legacy-atlas-tool",
        });
      } else if (inspected.status !== "oversized") {
        context.issues.push({ code: "uninspectable-tool-file", path: candidatePath });
      }
      continue;
    }
    const content = inspected.content;
    const digest = sha256(content);
    const release = context.knownToolHashes.get(digest) ?? null;
    if (!release && !suspiciousName) continue;
    context.conflicts.push({
      path: candidatePath,
      classification: release ? "known-legacy-atlas-tool" : "suspicious-legacy-atlas-tool",
      sha256: digest,
      release,
    });
  }
}

async function inspectRoot(root, context) {
  let entry;
  try {
    entry = await entryOrNull(root.path);
  } catch {
    root.status = "unreadable";
    context.issues.push({ code: "unreadable-opencode-root", path: root.path });
    return;
  }
  if (!entry) {
    root.status = "missing";
    return;
  }
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    root.status = "uninspectable";
    context.issues.push({ code: "uninspectable-opencode-root", path: root.path });
    return;
  }

  root.status = "present";
  await inspectToolDirectory(path.join(root.path, "tool"), context);
  await inspectToolDirectory(path.join(root.path, "tools"), context);
}

export async function checkWorkerThreads(options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("worker timeout must be a positive integer");
  }

  return new Promise((resolve) => {
    let worker;
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      Promise.resolve(worker?.terminate()).catch(() => undefined).finally(() => resolve(result));
    };
    try {
      worker = new Worker(
        'const { parentPort } = require("node:worker_threads"); parentPort.postMessage("ready");',
        { eval: true, execArgv: [] },
      );
    } catch {
      resolve({ status: "unavailable", reason: "worker construction failed" });
      return;
    }
    timer = setTimeout(() => finish({ status: "unavailable", reason: "worker startup timed out" }), timeoutMs);
    worker.once("message", (message) => finish(message === "ready"
      ? { status: "available" }
      : { status: "unavailable", reason: "unexpected worker response" }));
    worker.once("error", () => finish({ status: "unavailable", reason: "worker startup failed" }));
    worker.once("exit", (code) => {
      if (!settled) finish({ status: "unavailable", reason: `worker exited with status ${code}` });
    });
  });
}

async function atlasVersion() {
  const packageText = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const value = JSON.parse(packageText)?.version;
  if (!nonempty(value)) throw new Error("package version is missing");
  return value;
}

export async function inspectOpenCodeCompatibility(project, options = {}) {
  if (!nonempty(project)) throw new TypeError("doctor requires a project directory");
  const projectRoot = path.resolve(project);
  const projectEntry = await lstat(projectRoot);
  if (!projectEntry.isDirectory()) throw new TypeError("doctor requires a project directory");

  const platform = options.platform ?? process.platform;
  const homeDir = path.resolve(options.homeDir ?? homedir());
  const env = options.env ?? process.env;
  const knownToolHashes = normalizeKnownHashes(options.knownToolHashes);
  const worktreeRoot = path.resolve(options.worktreeRoot ?? await detectWorktreeRoot(projectRoot));
  if (!isSameOrDescendant(worktreeRoot, projectRoot)) {
    throw new TypeError("worktree root must contain the project");
  }
  const rootsByKey = new Map();
  const issues = [];
  const warnings = [];

  let savedConfig = options.manifestConfigDir ?? null;
  if (!savedConfig) {
    const manifest = await manifestConfig(homeDir, platform);
    savedConfig = manifest.configDir;
    if (manifest.issue) issues.push(manifest.issue);
  }
  addRoot(rootsByKey, savedConfig, "install-manifest", platform);
  addRoot(rootsByKey, env.OPENCODE_CONFIG_DIR, "OPENCODE_CONFIG_DIR", platform);
  addRoot(
    rootsByKey,
    nonempty(env.XDG_CONFIG_HOME)
      ? path.join(env.XDG_CONFIG_HOME, "opencode")
      : path.join(homeDir, ".config", "opencode"),
    nonempty(env.XDG_CONFIG_HOME) ? "XDG_CONFIG_HOME" : "xdg-default",
    platform,
  );
  addRoot(rootsByKey, path.join(homeDir, ".opencode"), "user-opencode", platform);
  addProjectRoots(rootsByKey, projectRoot, worktreeRoot, platform);

  const roots = [...rootsByKey.values()].sort((left, right) => compareText(left.path, right.path));
  const context = {
    conflicts: [],
    issues,
    knownToolHashes,
    maxToolBytes: options.maxToolBytes ?? MAX_TOOL_BYTES,
    maxToolEntries: options.maxToolEntries ?? MAX_TOOL_ENTRIES,
  };
  if (!Number.isInteger(context.maxToolBytes) || context.maxToolBytes <= 0) {
    throw new TypeError("maxToolBytes must be a positive integer");
  }
  if (!Number.isInteger(context.maxToolEntries) || context.maxToolEntries <= 0) {
    throw new TypeError("maxToolEntries must be a positive integer");
  }
  for (const root of roots) await inspectRoot(root, context);

  const workerCheck = options.workerCheck ?? checkWorkerThreads;
  if (typeof workerCheck !== "function") throw new TypeError("workerCheck must be a function");
  const workerThreads = await workerCheck();
  if (workerThreads?.status !== "available") {
    warnings.push({
      code: "worker-threads-unavailable",
      message: String(workerThreads?.reason ?? "worker threads unavailable"),
    });
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(String(nodeVersion).split(".")[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 20) {
    issues.push({ code: "unsupported-node-version", actual: String(nodeVersion), requiredMajor: 20 });
  }

  context.conflicts.sort((left, right) => compareText(left.path, right.path));
  issues.sort((left, right) => compareText(`${left.code}:${left.path ?? ""}`, `${right.code}:${right.path ?? ""}`));
  for (const root of roots) root.sources = [...root.sources].sort(compareText);

  return {
    schemaVersion: 1,
    atlasVersion: options.atlasVersion ?? await atlasVersion(),
    nodeVersion: String(nodeVersion),
    platform,
    projectRoot,
    ok: context.conflicts.length === 0 && issues.length === 0,
    workerThreads,
    roots,
    conflicts: context.conflicts,
    issues,
    warnings,
  };
}

export function renderOpenCodeDoctor(report) {
  const lines = [
    `Legacy Code Atlas ${report.atlasVersion}`,
    `Node.js ${report.nodeVersion}`,
    `OpenCode compatibility: ${report.ok ? "OK" : "BLOCKED"}`,
    `Checked roots: ${report.roots.length}`,
    `Worker threads: ${report.workerThreads?.status ?? "unknown"}`,
  ];
  if (report.roots.length > 0) {
    lines.push("", "Checked OpenCode roots:");
    for (const root of report.roots) {
      lines.push(`- ${JSON.stringify(root.path)} (${root.status}; sources: ${root.sources.join(", ")})`);
    }
  }
  if (report.conflicts.length > 0) {
    lines.push("", "Conflicting legacy Atlas tools:");
    for (const conflict of report.conflicts) {
      lines.push(`- ${JSON.stringify(conflict.path)}`);
      lines.push(`  classification: ${conflict.classification}`);
      lines.push(`  SHA-256: ${conflict.sha256 ?? "unavailable"}`);
    }
    lines.push("", "Back up and verify each reported file. Do not delete an entire OpenCode tool or config directory.");
  }
  if (report.issues.length > 0) {
    lines.push("", "Compatibility issues:");
    for (const issue of report.issues) {
      lines.push(`- ${issue.code}${issue.path ? `: ${JSON.stringify(issue.path)}` : ""}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of report.warnings) lines.push(`- ${warning.code}: ${warning.message}`);
  }
  return `${lines.join("\n")}\n`;
}
