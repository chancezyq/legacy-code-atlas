import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { inspectOpenCodeCompatibility } from "../src/opencode-doctor.mjs";

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function sandbox(t) {
  const root = await mkdtemp(path.join(tmpdir(), "legacy-atlas-doctor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home");
  const projectRoot = path.join(root, "workspace", "apps", "legacy-shop");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  return { root, homeDir, projectRoot };
}

async function writeTool(configRoot, directory, name, content) {
  const target = path.join(configRoot, directory, name);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  return target;
}

test("doctor discovers official global and project OpenCode tool roots without executing tools", async (t) => {
  const { root, homeDir, projectRoot } = await sandbox(t);
  const environmentRoot = path.join(root, "environment-opencode");
  const xdgRoot = path.join(root, "xdg");
  const manifestRoot = path.join(root, "manifest-opencode");
  const worktreeRoot = path.join(root, "workspace");
  const projectConfig = path.join(projectRoot, ".opencode");
  const ancestorConfig = path.join(worktreeRoot, ".opencode");
  const aboveWorktreeConfig = path.join(root, ".opencode");
  const knownContent = await readFile(
    new URL("./fixtures/opencode/released-legacy-atlas-bun-lf.fixture", import.meta.url),
  );
  assert.equal(sha256(knownContent), "410c82a1cbc65a4fef185f8f2b6da506ab328997c505569e4a88a3667a9290ff");

  const companyTool = await writeTool(
    environmentRoot,
    "tools",
    "company.ts",
    'throw new Error("doctor must never import this file");\n',
  );
  const suspiciousTool = await writeTool(
    path.join(xdgRoot, "opencode"),
    "tool",
    "legacy_atlas.ts",
    'export function legacy_atlas_analyze() { return Bun.which("node"); }\n',
  );
  const knownTool = await writeTool(
    path.join(homeDir, ".opencode"),
    "tools",
    "renamed.js",
    knownContent,
  );
  const projectTool = await writeTool(
    projectConfig,
    "tool",
    "legacy_atlas.js",
    "export const legacy_atlas_overview = true;\n",
  );
  const ancestorTool = await writeTool(
    ancestorConfig,
    "tools",
    "legacy_atlas.ts",
    "export const legacy_atlas_trace = true;\n",
  );
  await writeTool(
    projectConfig,
    path.join("tools", "nested"),
    "legacy_atlas.ts",
    "export const legacy_atlas_analyze = true;\n",
  );
  await writeTool(projectConfig, "tools", "legacy_atlas.mts", "export default {};\n");
  await writeTool(
    aboveWorktreeConfig,
    "tools",
    "legacy_atlas.ts",
    "export const legacy_atlas_analyze = true;\n",
  );

  const report = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {
      OPENCODE_CONFIG_DIR: environmentRoot,
      XDG_CONFIG_HOME: xdgRoot,
    },
    manifestConfigDir: manifestRoot,
    worktreeRoot,
    workerCheck: async () => ({ status: "available" }),
  });

  const checked = new Set(report.roots.map((rootEntry) => rootEntry.path));
  for (const expected of [
    environmentRoot,
    path.join(xdgRoot, "opencode"),
    manifestRoot,
    path.join(homeDir, ".opencode"),
    projectConfig,
    ancestorConfig,
  ]) assert.equal(checked.has(path.resolve(expected)), true, `missing root ${expected}`);
  assert.equal(checked.has(path.resolve(aboveWorktreeConfig)), false);

  assert.equal(report.ok, false);
  assert.equal(report.workerThreads.status, "available");
  assert.deepEqual(
    report.conflicts.map((conflict) => [conflict.path, conflict.classification]),
    [
      [ancestorTool, "suspicious-legacy-atlas-tool"],
      [knownTool, "known-legacy-atlas-tool"],
      [projectTool, "suspicious-legacy-atlas-tool"],
      [suspiciousTool, "suspicious-legacy-atlas-tool"],
    ].sort(([left], [right]) => left.localeCompare(right, "en")),
  );
  assert.equal(report.conflicts.find((entry) => entry.path === knownTool).release, "legacy Bun tool (LF)");
  assert.equal(report.conflicts.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), true);
  assert.equal(report.conflicts.some((entry) => entry.path === companyTool), false);
  assert.equal(await readFile(companyTool, "utf8"), 'throw new Error("doctor must never import this file");\n');
});

test("doctor uses the default XDG root, deduplicates paths, and tolerates worker fallback", async (t) => {
  const { homeDir, projectRoot } = await sandbox(t);
  const defaultConfig = path.join(homeDir, ".config", "opencode");
  await writeTool(defaultConfig, "tools", "company.js", "export const company = true;\n");

  const report = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: { OPENCODE_CONFIG_DIR: defaultConfig },
    workerCheck: async () => ({ status: "unavailable", reason: "worker threads blocked" }),
  });

  assert.equal(report.ok, true);
  assert.deepEqual(report.conflicts, []);
  assert.equal(report.workerThreads.status, "unavailable");
  assert.equal(report.warnings.some((warning) => warning.code === "worker-threads-unavailable"), true);
  const matchingRoots = report.roots.filter((entry) => entry.path === path.resolve(defaultConfig));
  assert.equal(matchingRoots.length, 1);
  assert.deepEqual(matchingRoots[0].sources, ["OPENCODE_CONFIG_DIR", "xdg-default"]);
});

test("doctor reports a suspicious symbolic legacy tool without following its target", {
  skip: process.platform === "win32" ? "symbolic-link creation is privilege-dependent on Windows" : false,
}, async (t) => {
  const { root, homeDir, projectRoot } = await sandbox(t);
  const target = path.join(root, "outside.ts");
  const tool = path.join(homeDir, ".opencode", "tool", "legacy_atlas.ts");
  await writeFile(target, "outside sentinel\n", "utf8");
  await mkdir(path.dirname(tool), { recursive: true });
  await symlink(target, tool);

  const report = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    workerCheck: async () => ({ status: "available" }),
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.conflicts.map((entry) => ({
    path: entry.path,
    classification: entry.classification,
    sha256: entry.sha256,
  })), [{
    path: tool,
    classification: "uninspectable-legacy-atlas-tool",
    sha256: null,
  }]);
  assert.equal(await readFile(target, "utf8"), "outside sentinel\n");
});

test("doctor does not silently accept an unrelated symbolic tool candidate", {
  skip: process.platform === "win32" ? "symbolic-link creation is privilege-dependent on Windows" : false,
}, async (t) => {
  const { root, homeDir, projectRoot } = await sandbox(t);
  const target = path.join(root, "outside-company-tool.js");
  const tool = path.join(homeDir, ".opencode", "tools", "company.js");
  await writeFile(target, "export const company = true;\n", "utf8");
  await mkdir(path.dirname(tool), { recursive: true });
  await symlink(target, tool);

  const report = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    workerCheck: async () => ({ status: "available" }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.conflicts.some((entry) => entry.path === tool), false);
  assert.equal(report.issues.some((issue) => issue.code === "uninspectable-tool-file" && issue.path === tool), true);
  assert.equal(await readFile(target, "utf8"), "export const company = true;\n");
});

test("doctor reports an oversized legacy Atlas tool without reading it", async (t) => {
  const { homeDir, projectRoot } = await sandbox(t);
  const tool = await writeTool(
    path.join(homeDir, ".opencode"),
    "tools",
    "legacy_atlas.js",
    "export const company = 'too large';\n",
  );

  const report = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    maxToolBytes: 8,
    workerCheck: async () => ({ status: "available" }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.conflicts.some((conflict) => (
    conflict.classification === "oversized-legacy-atlas-tool"
    && conflict.path === tool
    && conflict.sha256 === null
  )), true);
  assert.deepEqual(report.issues, []);
});

test("doctor accepts only a structurally valid install manifest config root", async (t) => {
  const { root, homeDir, projectRoot } = await sandbox(t);
  const installDir = path.join(homeDir, ".legacy-code-atlas");
  const marker = path.join(installDir, ".legacy-code-atlas-owner.json");
  const manifestRoot = path.join(root, "manifest-opencode");
  await mkdir(installDir, { recursive: true });

  const missing = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    workerCheck: async () => ({ status: "available" }),
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.issues.some((issue) => issue.code === "invalid-install-manifest"), true);

  await writeFile(marker, JSON.stringify({
    owner: "legacy-code-atlas-install-v3",
    version: 3,
    configDir: manifestRoot,
  }), "utf8");

  const invalid = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    workerCheck: async () => ({ status: "available" }),
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.some((issue) => issue.code === "invalid-install-manifest"), true);
  assert.equal(invalid.roots.some((entry) => entry.path === manifestRoot), false);

  await writeFile(marker, JSON.stringify({
    owner: "legacy-code-atlas-install-v3",
    version: 3,
    installDir,
    configDir: manifestRoot,
    ownedFiles: [{
      kind: "agent-skill",
      path: path.join(homeDir, ".agents", "skills", "understand", "SKILL.md"),
      sha256: "a".repeat(64),
    }],
  }), "utf8");
  const valid = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    workerCheck: async () => ({ status: "available" }),
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.issues.some((issue) => issue.code === "invalid-install-manifest"), false);
  assert.equal(valid.roots.some((entry) => (
    entry.path === manifestRoot && entry.sources.includes("install-manifest")
  )), true);
});

test("doctor rejects Node versions older than 20", async (t) => {
  const { homeDir, projectRoot } = await sandbox(t);
  const report = await inspectOpenCodeCompatibility(projectRoot, {
    homeDir,
    env: {},
    nodeVersion: "18.20.5",
    workerCheck: async () => ({ status: "available" }),
  });

  assert.equal(report.ok, false);
  assert.equal(report.issues.some((issue) => issue.code === "unsupported-node-version"), true);
});
