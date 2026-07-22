import assert from "node:assert/strict";
import { access, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import * as windowsHarness from "./helpers/windows-installer-harness.mjs";

import {
  assertWindowsPowerShell51,
  createV1Install,
  createV3Install,
  createWindowsInstallerSandbox,
  readJson,
  runInstaller,
  readPublishedSkill,
  sha256,
  snapshotTree,
} from "./helpers/windows-installer-harness.mjs";

const installerPath = fileURLToPath(new URL("../install.ps1", import.meta.url));
const sourceSkillPath = fileURLToPath(new URL(
  "../integrations/opencode/skills/understand/SKILL.md",
  import.meta.url,
));
const sourceCliPath = fileURLToPath(new URL(
  "../bin/legacy-code-atlas.mjs",
  import.meta.url,
));
const sourcePackagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../", import.meta.url));
const windowsOnly = process.platform === "win32"
  ? false
  : "requires Windows and the built-in Windows PowerShell 5.1 executable";
const understandSkillCollisionMessage = /Understand-Anything[\s\S]*?两个\s*\/understand\s+Skill[\s\S]*?(?:不能|无法)[\s\S]*?同一\s+namespace[\s\S]*?(?:不会|不)[\s\S]*?覆盖[\s\S]*?删除[\s\S]*?先备份[\s\S]*?原插件[\s\S]*?(?:卸载|禁用)/i;

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function assertNoTransactionArtifacts(sandbox) {
  const residuals = (await snapshotTree(sandbox.root)).filter((entry) => (
    entry.path === "home/.legacy-code-atlas.transaction.json"
    || /(?:^|\/)\.legacy-code-atlas\.(?:stage|backup)-/.test(entry.path)
    || /\.legacy-code-atlas-(?:temp|backup)-/.test(entry.path)
  ));
  assert.deepEqual(residuals, []);
}

async function snapshotInstallerState(sandbox) {
  return (await snapshotTree(sandbox.root)).filter(
    (entry) => entry.path !== "assert-windows-powershell.ps1",
  );
}

async function assertInstallerRejectsWithUnchangedState({ sandbox, args = [], message }) {
  const before = await snapshotInstallerState(sandbox);
  await assert.rejects(
    runInstaller({ installerPath, sandbox, args }),
    (error) => {
      assert.equal(error.powerShellMajorVersion, 5);
      assert.equal(error.powerShellMinorVersion, 1);
      assert.match(`${error.message}\n${error.stderr ?? ""}`, message);
      return true;
    },
  );
  assert.deepEqual(await snapshotInstallerState(sandbox), before);
}

async function assertInstrumentedFailure({ instrumentedInstallerPath, sandbox, message }) {
  await assert.rejects(
    runInstaller({ installerPath: instrumentedInstallerPath, sandbox }),
    (error) => {
      assert.equal(error.powerShellMajorVersion, 5);
      assert.equal(error.powerShellMinorVersion, 1);
      assert.match(`${error.message}\n${error.stderr ?? ""}`, message);
      return true;
    },
  );
}

function legacyV1TransactionPaths({ sandbox, configDir, id }) {
  const installDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
  const ownerMarker = path.join(installDir, ".legacy-code-atlas-owner.json");
  const skillDir = path.join(sandbox.homeDir, ".agents", "skills", "understand");
  const skillTarget = path.join(skillDir, "SKILL.md");
  const toolTarget = path.join(configDir, "tools", "legacy_atlas.ts");
  const commandTarget = path.join(configDir, "commands", "understand.md");
  return {
    runtimeStage: path.join(sandbox.homeDir, `.legacy-code-atlas.stage-${id}`),
    runtimeBackup: path.join(sandbox.homeDir, `.legacy-code-atlas.backup-${id}`),
    skillTemp: `${skillDir}.legacy-code-atlas-temp-${id}`,
    skillBackup: `${skillTarget}.legacy-code-atlas-backup-${id}`,
    toolTemp: `${toolTarget}.legacy-code-atlas-temp-${id}`,
    toolBackup: `${toolTarget}.legacy-code-atlas-backup-${id}`,
    legacyCommandBackup: `${commandTarget}.legacy-code-atlas-backup-${id}`,
    manifestTemp: `${ownerMarker}.legacy-code-atlas-temp-${id}`,
  };
}

async function writeLegacyV1TransactionJournal({
  sandbox,
  configDir,
  id,
  manifestSha256,
  skillSha256,
  toolSha256,
}) {
  const paths = legacyV1TransactionPaths({ sandbox, configDir, id });
  const journal = {
    owner: "legacy-code-atlas-transaction-v1",
    version: 1,
    id,
    mode: "update-v2",
    configDir,
    manifestSha256,
    skillSha256,
    toolSha256,
    runtimeExisted: true,
    skillExisted: true,
    toolExisted: true,
    legacyCommandExisted: false,
    ...paths,
  };
  const journalPath = path.join(sandbox.homeDir, ".legacy-code-atlas.transaction.json");
  await writeFile(journalPath, `\uFEFF${JSON.stringify(journal, null, 2)}`, "utf8");
  return { journalPath, journal, ...paths };
}

async function assertSkillOnlyArtifacts({ skillTarget, toolTarget }) {
  const skillContent = await readPublishedSkill(skillTarget);
  assert.equal(await pathExists(toolTarget), false, "Skill-only installs must not publish a custom tool");
  assert.match(
    skillContent,
    /node\s+[`\"]?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas[.]mjs[`\"]?\s+analyze\s+[`\"]?\$PWD[`\"]?/i,
  );
  assert.match(skillContent, /node\s+[`\"]?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas[.]mjs[`\"]?\s+overview\s+[`\"]?\$PWD[`\"]?/i);
  assert.match(skillContent, /[.]legacy-code-atlas[\\/]query[.]txt/);
  assert.match(skillContent, /--query-file/);
  assert.match(skillContent, /--no-match-ok/);
  assert.doesNotMatch(skillContent, /legacy_atlas_/);
}

test("package exposes the explicit Windows installer release gate", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));

  assert.equal(
    packageJson.scripts["test:installer:windows"],
    "node --test test/installer-windows.test.mjs",
  );
});

test("harness accepts only Windows PowerShell 5.1 and reports the full actual version", () => {
  assert.doesNotThrow(() => assertWindowsPowerShell51({
    major: 5,
    minor: 1,
    version: "5.1.19041.5607",
  }));
  assert.throws(
    () => assertWindowsPowerShell51({
      major: 5,
      minor: 0,
      version: "5.0.10586.117",
    }),
    /Windows PowerShell 5\.1 is required; found 5\.0\.10586\.117/,
  );
  assert.throws(
    () => assertWindowsPowerShell51({
      major: 7,
      minor: 4,
      version: "7.4.6",
    }),
    /Windows PowerShell 5\.1 is required; found 7\.4\.6/,
  );
});

test("sandbox cleanup uses bounded Windows filesystem retries supported by Node 20", async () => {
  const harness = await readFile(
    new URL("./helpers/windows-installer-harness.mjs", import.meta.url),
    "utf8",
  );
  const cleanup = harness.match(/t\.after\(\(\) => rm\(root, \{([\s\S]*?)\}\)\);/);

  assert.ok(cleanup, "sandbox cleanup must remain registered with node:test");
  assert.match(cleanup[1], /recursive:\s*true/);
  assert.match(cleanup[1], /force:\s*true/);
  assert.match(cleanup[1], /maxRetries:\s*[1-9][0-9]*/);
  assert.match(cleanup[1], /retryDelay:\s*[1-9][0-9]*/);
});

test("installer fixture helpers preserve BOM JSON and deterministic v1 ownership", async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await createV1Install(sandbox);

  const rawJson = path.join(sandbox.root, "bom.json");
  await writeFile(rawJson, `\uFEFF${JSON.stringify({ status: "ok" })}`, "utf8");

  assert.deepEqual(await readJson(rawJson), { status: "ok" });
  assert.equal(await sha256(fixture.commandTarget), fixture.commandHash);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  assert.deepEqual(await readJson(fixture.ownerMarker), fixture.manifest);

  const first = await snapshotTree(sandbox.root);
  const second = await snapshotTree(sandbox.root);
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((entry) => entry.path), [...first.map((entry) => entry.path)].sort());
  assert.ok(first.some((entry) => entry.path === "home/.legacy-code-atlas/.legacy-code-atlas-owner.json"));
  assert.ok(first.some((entry) => entry.path === "opencode-config/commands/understand.md"));
  assert.ok(first.some((entry) => entry.path === "opencode-config/tools/legacy_atlas.ts"));
});

test("v1 fixture retains ownership hashes for already-missing command and tool files", async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const missingCommand = await createV1Install(sandbox, {
    omitCommand: true,
    commandContent: "# Previously owned command\n",
  });
  assert.equal(await pathExists(missingCommand.commandTarget), false);
  assert.match(missingCommand.commandHash, /^[0-9A-F]{64}$/);
  assert.equal(
    (await readJson(missingCommand.ownerMarker)).commandHash,
    missingCommand.commandHash,
  );

  const secondSandbox = await createWindowsInstallerSandbox(t);
  const missingTool = await createV1Install(secondSandbox, {
    omitTool: true,
    toolContent: "export const previouslyOwnedTool = true;\n",
  });
  assert.equal(await pathExists(missingTool.toolTarget), false);
  assert.match(missingTool.toolHash, /^[0-9A-F]{64}$/);
  assert.equal((await readJson(missingTool.ownerMarker)).toolHash, missingTool.toolHash);
});

test("sandbox helper can force a non-ASCII Windows path prefix", async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t, {
    prefix: "legacy-atlas-旧项目-",
  });

  assert.match(path.basename(sandbox.root), /^legacy-atlas-旧项目-/);
  assert.equal(await pathExists(sandbox.homeDir), true);
  assert.equal(await pathExists(sandbox.configDir), true);
});

test("junction helper is explicit off Windows and creates a real directory junction on Windows", async (t) => {
  assert.equal(typeof windowsHarness.createDirectoryJunction, "function");
  const sandbox = await createWindowsInstallerSandbox(t);
  const target = path.join(sandbox.root, "junction-target");
  const junction = path.join(sandbox.root, "junction-link");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "sentinel.txt"), "outside sentinel\n", "utf8");

  if (process.platform !== "win32") {
    await assert.rejects(
      windowsHarness.createDirectoryJunction({ target, junction }),
      /requires Windows/,
    );
    return;
  }

  await windowsHarness.createDirectoryJunction({ target, junction });
  assert.equal(
    await readFile(path.join(junction, "sentinel.txt"), "utf8"),
    "outside sentinel\n",
  );
});

test("v2 fixture records deterministic ownership even when an owned file is missing", async (t) => {
  assert.equal(typeof windowsHarness.createV2Install, "function");

  const sandbox = await createWindowsInstallerSandbox(t);
  const savedConfigDir = path.join(sandbox.root, "saved-opencode-config");
  const fixture = await windowsHarness.createV2Install(sandbox, {
    configDir: savedConfigDir,
    omitSkill: true,
    skillContent: "# Previously installed Skill\n",
  });
  const manifest = await readJson(fixture.ownerMarker);
  const ownedFiles = new Map(manifest.ownedFiles.map((entry) => [entry.kind, entry]));

  assert.equal(manifest.owner, "legacy-code-atlas-install-v2");
  assert.equal(manifest.version, 2);
  assert.equal(path.normalize(manifest.configDir), path.normalize(savedConfigDir));
  assert.equal(path.normalize(ownedFiles.get("agent-skill").path), path.normalize(fixture.skillTarget));
  assert.equal(path.normalize(ownedFiles.get("opencode-tool").path), path.normalize(fixture.toolTarget));
  assert.equal(ownedFiles.get("agent-skill").sha256, fixture.skillHash);
  assert.equal(ownedFiles.get("opencode-tool").sha256, await sha256(fixture.toolTarget));
  await assert.rejects(readFile(fixture.skillTarget), /ENOENT/);
});

test("v3 fixture owns only the Agent Skill and never creates an OpenCode tools directory", async (t) => {
  assert.equal(typeof createV3Install, "function");

  const sandbox = await createWindowsInstallerSandbox(t);
  const savedConfigDir = path.join(sandbox.root, "missing-saved-opencode-config");
  const fixture = await createV3Install(sandbox, { configDir: savedConfigDir });
  const manifest = await readJson(fixture.ownerMarker);

  assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(manifest.version, 3);
  assert.equal(path.normalize(manifest.configDir), path.normalize(savedConfigDir));
  assert.deepEqual(manifest.ownedFiles, [{
    kind: "agent-skill",
    path: fixture.skillTarget,
    sha256: fixture.skillHash,
  }]);
  assert.equal(await sha256(fixture.skillTarget), fixture.skillHash);
  assert.equal(await pathExists(path.join(savedConfigDir, "tools")), false);
});

test("failure instrumentation modifies only an isolated minimal installer source", async (t) => {
  assert.equal(typeof windowsHarness.createInstrumentedInstaller, "function");

  const sandbox = await createWindowsInstallerSandbox(t);
  const productionBefore = await readFile(installerPath);
  const instrumented = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-skill",
    action: "throw",
  });
  const [productionAfter, copiedInstaller, copiedSkill, originalSkill] = await Promise.all([
    readFile(installerPath),
    readFile(instrumented.installerPath),
    readFile(path.join(
      instrumented.sourceRoot,
      "integrations",
      "opencode",
      "skills",
      "understand",
      "SKILL.md",
    )),
    readFile(sourceSkillPath),
  ]);

  assert.deepEqual(productionAfter, productionBefore);
  assert.deepEqual([...copiedInstaller.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.match(copiedInstaller.toString("utf8"), /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-skill:throw/);
  assert.doesNotMatch(
    productionAfter.toString("utf8"),
    /LEGACY_CODE_ATLAS_TEST_FAILPOINT|(?:test[-_ ]?)?failpoint/i,
  );
  assert.deepEqual(copiedSkill, originalSkill);

  for (const phase of [
    "after-journal",
    "after-skill-stage-directory",
    "after-runtime",
    "after-legacy-tool",
    "after-legacy-command",
    "after-manifest",
    "after-recovery",
  ]) {
    const candidate = await windowsHarness.createInstrumentedInstaller({
      sandbox,
      sourceRoot,
      phase,
      action: "throw",
    });
    assert.match(
      await readFile(candidate.installerPath, "utf8"),
      new RegExp(`LEGACY_CODE_ATLAS_TEST_FAILPOINT:${phase}:throw`),
    );
  }

  const concurrentConflict = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "before-skill-recheck",
    action: "create-skill-conflict",
  });
  const conflictInstaller = await readFile(concurrentConflict.installerPath, "utf8");
  assert.match(
    conflictInstaller,
    /LEGACY_CODE_ATLAS_TEST_FAILPOINT:before-skill-recheck:create-skill-conflict/,
  );
  assert.match(conflictInstaller, /New-Item -ItemType Directory -Path \$SkillDir -Force/);
  assert.ok(
    conflictInstaller.indexOf("New-Item -ItemType Directory -Path $SkillDir -Force")
      < conflictInstaller.indexOf("$skillNamespaceBeforePublish = Get-PathEntryWithoutFollowingTarget $SkillDir"),
    "the race fixture must occupy the namespace before the installer's second check",
  );

  const crash = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-manifest",
    action: "crash",
  });
  const crashInstaller = await readFile(crash.installerPath, "utf8");
  assert.match(crashInstaller, /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-manifest:crash/);
  assert.match(crashInstaller, /GetCurrentProcess\(\)\.Kill\(\)/);
});

test("Windows smoke uses isolated Windows PowerShell 5.1 to install", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const result = await runInstaller({ installerPath, sandbox });
  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  const expectedPowerShell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );

  assert.equal(result.command, expectedPowerShell);
  assert.deepEqual(result.args.slice(0, 6), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    installerPath,
  ]);
  assert.equal(result.powerShellMajorVersion, 5);
  assert.equal(result.powerShellMinorVersion, 1);
  assert.match(result.stdout, /Legacy Code Atlas/);
  assert.match(`${result.stdout}\n${result.stderr ?? ""}`, /Agent Skill[^\r\n]*(?:唯一|唯一的)[^\r\n]*(?:入口|运行)/i);
  assert.match(`${result.stdout}\n${result.stderr ?? ""}`, /custom tool[^\r\n]*(?:不依赖|无需)/i);

  const runtimeDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
  const skillTarget = path.join(sandbox.homeDir, ".agents", "skills", "understand", "SKILL.md");
  const toolTarget = path.join(sandbox.configDir, "tools", "legacy_atlas.ts");
  const toolDir = path.dirname(toolTarget);
  const manifest = await readJson(path.join(runtimeDir, ".legacy-code-atlas-owner.json"));
  assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(manifest.version, 3);
  assert.equal(path.normalize(manifest.installDir), path.normalize(runtimeDir));
  assert.equal(path.normalize(manifest.configDir), path.normalize(sandbox.configDir));
  assert.equal(manifest.ownedFiles.length, 1);

  const ownedFiles = new Map(manifest.ownedFiles.map((entry) => [entry.kind, entry]));
  assert.deepEqual([...ownedFiles.keys()], ["agent-skill"]);
  assert.equal(path.normalize(ownedFiles.get("agent-skill").path), path.normalize(skillTarget));
  assert.equal(ownedFiles.get("agent-skill").sha256, await sha256(skillTarget));
  assert.equal(ownedFiles.get("agent-skill").sha256, await sha256(sourceSkillPath));
  assert.equal(await pathExists(toolDir), false);
  assert.equal(
    await sha256(path.join(runtimeDir, "bin", "legacy-code-atlas.mjs")),
    await sha256(sourceCliPath),
  );
  assert.equal(
    await sha256(path.join(runtimeDir, "package.json")),
    await sha256(sourcePackagePath),
  );
  await assertSkillOnlyArtifacts({ skillTarget, toolTarget });

  await assertNoTransactionArtifacts(sandbox);
});

test("Windows migrates an unchanged v1 install using its saved config directory", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const savedConfigDir = path.join(sandbox.root, "saved-v1-config");
  const fixture = await createV1Install(
    { ...sandbox, configDir: savedConfigDir },
    { toolContent: "export const legacyAtlasTool = { execute() { return Bun.spawn([]); } };\n" },
  );
  const commandSibling = path.join(savedConfigDir, "commands", "keep-command.md");
  const toolSibling = path.join(savedConfigDir, "tools", "keep-tool.ts");
  await Promise.all([
    writeFile(commandSibling, "keep command\n", "utf8"),
    writeFile(toolSibling, "keep tool\n", "utf8"),
  ]);

  await runInstaller({ installerPath, sandbox });

  const skillTarget = path.join(sandbox.homeDir, ".agents", "skills", "understand", "SKILL.md");
  const manifest = await readJson(fixture.ownerMarker);
  const ownedFiles = new Map(manifest.ownedFiles.map((entry) => [entry.kind, entry]));
  assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(manifest.version, 3);
  assert.equal(path.normalize(manifest.configDir), path.normalize(savedConfigDir));
  assert.equal(await pathExists(fixture.commandTarget), false);
  assert.equal(await pathExists(fixture.toolTarget), false);
  assert.equal(await sha256(skillTarget), await sha256(sourceSkillPath));
  await assertSkillOnlyArtifacts({ skillTarget, toolTarget: fixture.toolTarget });
  assert.deepEqual([...ownedFiles.keys()], ["agent-skill"]);
  assert.equal(await pathExists(path.join(sandbox.configDir, "tools", "legacy_atlas.ts")), false);
  assert.equal(await readFile(commandSibling, "utf8"), "keep command\n");
  assert.equal(await readFile(toolSibling, "utf8"), "keep tool\n");
  await assertNoTransactionArtifacts(sandbox);
});

for (const missingKind of ["command", "tool"]) {
  test(`Windows migrates v1 when its owned ${missingKind} is already missing`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const fixture = await createV1Install(sandbox, {
      omitCommand: missingKind === "command",
      omitTool: missingKind === "tool",
      commandContent: "# Previously owned command\n",
      toolContent: "export const previouslyOwnedTool = true;\n",
    });

    await runInstaller({ installerPath, sandbox });

    const manifest = await readJson(fixture.ownerMarker);
    const ownedFiles = new Map(manifest.ownedFiles.map((entry) => [entry.kind, entry]));
    const skillTarget = path.join(sandbox.homeDir, ".agents", "skills", "understand", "SKILL.md");
    assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
    assert.equal(manifest.version, 3);
    assert.deepEqual([...ownedFiles.keys()], ["agent-skill"]);
    assert.equal(await pathExists(fixture.commandTarget), false);
    assert.equal(await sha256(skillTarget), await sha256(sourceSkillPath));
    assert.equal(await pathExists(fixture.toolTarget), false);
    await assertNoTransactionArtifacts(sandbox);
  });
}

test("Windows migrates matching v2 files and retires its owned tool", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const savedConfigDir = path.join(sandbox.root, "saved-v2-config");
  const fixture = await windowsHarness.createV2Install(sandbox, {
    configDir: savedConfigDir,
    skillContent: "# Old owned Skill\n",
    toolContent: "export const oldOwnedTool = true;\n",
  });
  await runInstaller({ installerPath, sandbox });

  const manifest = await readJson(fixture.ownerMarker);
  assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(manifest.version, 3);
  assert.equal(path.normalize(manifest.configDir), path.normalize(savedConfigDir));
  assert.deepEqual(manifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
  assert.equal(await sha256(fixture.skillTarget), await sha256(sourceSkillPath));
  assert.equal(await pathExists(fixture.toolTarget), false);
  await assertSkillOnlyArtifacts({ skillTarget: fixture.skillTarget, toolTarget: fixture.toolTarget });
  assert.equal(
    await sha256(path.join(fixture.installDir, "bin", "legacy-code-atlas.mjs")),
    await sha256(sourceCliPath),
  );
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows preserves and rejects an unowned duplicate tool in another config directory", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const savedConfigDir = path.join(sandbox.root, "saved-v2-config-with-owned-tool");
  const fixture = await windowsHarness.createV2Install(sandbox, {
    configDir: savedConfigDir,
    skillContent: "# Old owned Skill\n",
    toolContent: "export const oldOwnedTool = true;\n",
  });
  const duplicateTool = path.join(sandbox.configDir, "tools", "legacy_atlas.ts");
  const duplicateToolContent = "export const staleCompanyTool = Bun.spawn;\n";
  await mkdir(path.dirname(duplicateTool), { recursive: true });
  await writeFile(duplicateTool, duplicateToolContent, "utf8");

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: /legacy_atlas[.]ts[\s\S]*保留[\s\S]*(?:停止|备份|确认来源)/i,
  });

  assert.equal(await readFile(duplicateTool, "utf8"), duplicateToolContent);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  assert.equal((await readJson(fixture.ownerMarker)).version, 2);
});

for (const missingKind of ["skill", "tool"]) {
  test(`Windows v2 migration accepts an already-missing owned ${missingKind}`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const fixture = await windowsHarness.createV2Install(sandbox, {
      omitSkill: missingKind === "skill",
      omitTool: missingKind === "tool",
      skillContent: "# Previously owned Skill\n",
      toolContent: "export const previouslyOwnedTool = true;\n",
    });

    await runInstaller({ installerPath, sandbox });

    assert.equal(await sha256(fixture.skillTarget), await sha256(sourceSkillPath));
    assert.equal(await pathExists(fixture.toolTarget), false);
    const manifest = await readJson(fixture.ownerMarker);
    assert.equal(manifest.version, 3);
    assert.deepEqual(manifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
    await assertNoTransactionArtifacts(sandbox);
  });
}

test("Windows updates v3 without creating or depending on an OpenCode tools directory", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const missingSavedConfigDir = path.join(sandbox.root, "removed-v3-config");
  const fixture = await createV3Install(sandbox, {
    configDir: missingSavedConfigDir,
    skillContent: "# Old v3 Skill\n",
  });
  const currentToolDir = path.join(sandbox.configDir, "tools");

  await runInstaller({ installerPath, sandbox });

  const manifest = await readJson(fixture.ownerMarker);
  assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(manifest.version, 3);
  assert.equal(path.normalize(manifest.configDir), path.normalize(missingSavedConfigDir));
  assert.deepEqual(manifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
  assert.equal(await sha256(fixture.skillTarget), await sha256(sourceSkillPath));
  assert.equal(await pathExists(path.join(missingSavedConfigDir, "tools")), false);
  assert.equal(await pathExists(currentToolDir), false);
  await assertNoTransactionArtifacts(sandbox);
});

for (const targetKind of ["command", "tool"]) {
  test(`Windows v1 migration rejects a modified owned ${targetKind} without changing state`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const fixture = await createV1Install(sandbox);
    const target = targetKind === "command" ? fixture.commandTarget : fixture.toolTarget;
    await writeFile(target, `user modified v1 ${targetKind}\n`, "utf8");

    await assertInstallerRejectsWithUnchangedState({
      sandbox,
      message: /已被修改[^\r\n]*拒绝/,
    });
  });
}

for (const targetKind of ["skill", "tool"]) {
  test(`Windows v2 update rejects a modified owned ${targetKind} without changing state`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const fixture = await windowsHarness.createV2Install(sandbox);
    const target = targetKind === "skill" ? fixture.skillTarget : fixture.toolTarget;
    await writeFile(target, `user modified v2 ${targetKind}\n`, "utf8");

    await assertInstallerRejectsWithUnchangedState({
      sandbox,
      message: /已被修改[^\r\n]*拒绝/,
    });
  });
}

test("Windows v3 update rejects a modified owned Skill without changing state", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await createV3Install(sandbox);
  await writeFile(fixture.skillTarget, "# User-modified v3 Skill\n", "utf8");

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: /已被修改[^\r\n]*拒绝/,
  });
});

test("Windows fresh install rejects an unowned understand Skill namespace without changing state", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const skillDir = path.join(sandbox.homeDir, ".agents", "skills", "understand");
  await mkdir(skillDir, { recursive: true });
  await writeFile(path.join(skillDir, "SKILL.md"), "# Understand-Anything\n", "utf8");

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: understandSkillCollisionMessage,
  });
});

test("Windows fresh install rejects a shadowing legacy command without changing state", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const legacyCommand = path.join(sandbox.configDir, "commands", "understand.md");
  await mkdir(path.dirname(legacyCommand), { recursive: true });
  await writeFile(legacyCommand, "# Unowned legacy command\n", "utf8");

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: /commands[\\/]understand[.]md[\s\S]*保留[\s\S]*停止/i,
  });
});

test("Windows fresh install preserves and rejects an unowned legacy tool", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const legacyTool = path.join(sandbox.configDir, "tools", "legacy_atlas.ts");
  const content = "export const companyTool = Bun.spawn;\n";
  await mkdir(path.dirname(legacyTool), { recursive: true });
  await writeFile(legacyTool, content, "utf8");

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: /legacy_atlas[.]ts[\s\S]*保留[\s\S]*(?:停止|备份|确认来源)/i,
  });
  assert.equal(await readFile(legacyTool, "utf8"), content);
});

test("Windows v1 migration rejects an existing Understand-Anything Skill without changing state", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  await createV1Install(sandbox);
  const skillTarget = path.join(sandbox.homeDir, ".agents", "skills", "understand", "SKILL.md");
  await mkdir(path.dirname(skillTarget), { recursive: true });
  await writeFile(skillTarget, "# Understand-Anything\n", "utf8");

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: understandSkillCollisionMessage,
  });
});

for (const maliciousKind of ["agent-skill", "opencode-tool"]) {
  test(`Windows rejects a v2 ${maliciousKind} ownership path outside its exact target`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const outsideTarget = path.join(sandbox.root, `outside-${maliciousKind}.txt`);
    await writeFile(outsideTarget, "outside target\n", "utf8");
    const fixture = await windowsHarness.createV2Install(sandbox);
    const maliciousManifest = structuredClone(fixture.manifest);
    maliciousManifest.ownedFiles.find((entry) => entry.kind === maliciousKind).path = outsideTarget;
    await writeFile(
      fixture.ownerMarker,
      `\uFEFF${JSON.stringify(maliciousManifest, null, 2)}`,
      "utf8",
    );

    await assertInstallerRejectsWithUnchangedState({
      sandbox,
      message: /拒绝覆盖已有目录/,
    });
    assert.equal(await readFile(outsideTarget, "utf8"), "outside target\n");
  });
}

test("Windows rejects a v3 Agent Skill ownership path outside its exact target", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const outsideTarget = path.join(sandbox.root, "outside-v3-skill.md");
  await writeFile(outsideTarget, "outside target\n", "utf8");
  const fixture = await createV3Install(sandbox);
  const maliciousManifest = structuredClone(fixture.manifest);
  maliciousManifest.ownedFiles[0].path = outsideTarget;
  await writeFile(
    fixture.ownerMarker,
    `\uFEFF${JSON.stringify(maliciousManifest, null, 2)}`,
    "utf8",
  );

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: /拒绝覆盖已有目录/,
  });
  assert.equal(await readFile(outsideTarget, "utf8"), "outside target\n");
});

for (const version of [1, 2, 3]) {
  for (const corruption of ["owner-case", "version-string", "version-fraction"]) {
    test(`Windows rejects malformed v${version} ${corruption} manifest for install and uninstall with unchanged state`, { skip: windowsOnly }, async (t) => {
      const sandbox = await createWindowsInstallerSandbox(t);
      const fixture = version === 1
        ? await createV1Install(sandbox)
        : version === 2
          ? await windowsHarness.createV2Install(sandbox)
          : await createV3Install(sandbox);
      const malformed = structuredClone(fixture.manifest);
      if (corruption === "owner-case") {
        malformed.owner = malformed.owner.toUpperCase();
      } else if (corruption === "version-string") {
        malformed.version = String(malformed.version);
      } else {
        malformed.version += 0.5;
      }
      await writeFile(
        fixture.ownerMarker,
        `\uFEFF${JSON.stringify(malformed, null, 2)}`,
        "utf8",
      );

      await assertInstallerRejectsWithUnchangedState({
        sandbox,
        message: /拒绝覆盖已有目录/,
      });
      await assertInstallerRejectsWithUnchangedState({
        sandbox,
        args: ["-Uninstall"],
        message: /没有有效的 Legacy Code Atlas ownership manifest/,
      });
    });
  }
}

test("Windows fresh install rejects a junction in an owned target path without following it", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const outside = path.join(sandbox.root, "outside-skill-directory");
  const skillDirectory = path.join(sandbox.homeDir, ".agents", "skills", "understand");
  await mkdir(outside, { recursive: true });
  await mkdir(path.dirname(skillDirectory), { recursive: true });
  await writeFile(path.join(outside, "sentinel.txt"), "outside sentinel\n", "utf8");
  await windowsHarness.createDirectoryJunction({ target: outside, junction: skillDirectory });

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    message: /重解析点|reparse point/i,
  });
  assert.equal(
    await readFile(path.join(outside, "sentinel.txt"), "utf8"),
    "outside sentinel\n",
  );
});

test("Windows uninstall rejects a junction inside private runtime before deleting owned files", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await createV3Install(sandbox);
  const outside = path.join(sandbox.root, "outside-runtime-directory");
  const runtimeJunction = path.join(fixture.installDir, "external-junction");
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "sentinel.txt"), "outside sentinel\n", "utf8");
  await windowsHarness.createDirectoryJunction({ target: outside, junction: runtimeJunction });

  await assertInstallerRejectsWithUnchangedState({
    sandbox,
    args: ["-Uninstall"],
    message: /重解析点|reparse point/i,
  });
  assert.equal(await pathExists(fixture.skillTarget), true);
  assert.equal(
    await readFile(path.join(outside, "sentinel.txt"), "utf8"),
    "outside sentinel\n",
  );
});

for (const phase of ["after-journal", "after-runtime", "after-skill"]) {
  test(`Windows fresh ${phase} throw rolls back without a blocking partial install`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const instrumented = await windowsHarness.createInstrumentedInstaller({
      sandbox,
      sourceRoot,
      phase,
      action: "throw",
    });

    await assertInstrumentedFailure({
      instrumentedInstallerPath: instrumented.installerPath,
      sandbox,
      message: new RegExp(`LEGACY_CODE_ATLAS_TEST_FAILPOINT:${phase}:throw`),
    });

    const installDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
    const skillDir = path.join(sandbox.homeDir, ".agents", "skills", "understand");
    const toolTarget = path.join(sandbox.configDir, "tools", "legacy_atlas.ts");
    assert.equal(await pathExists(installDir), false);
    assert.equal(await pathExists(skillDir), false);
    assert.equal(await pathExists(toolTarget), false);
    await assertNoTransactionArtifacts(sandbox);

    await runInstaller({ installerPath, sandbox });
    assert.equal(await pathExists(path.join(skillDir, "SKILL.md")), true);
    await assertNoTransactionArtifacts(sandbox);
  });
}

for (const version of [1, 2]) {
  test(`Windows v${version} throw after retiring the legacy tool restores it and permits retry`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const fixture = version === 1
      ? await createV1Install(sandbox)
      : await windowsHarness.createV2Install(sandbox);
    const before = await snapshotInstallerState(sandbox);
    const instrumented = await windowsHarness.createInstrumentedInstaller({
      sandbox,
      sourceRoot,
      phase: "after-legacy-tool",
      action: "throw",
    });

    await assertInstrumentedFailure({
      instrumentedInstallerPath: instrumented.installerPath,
      sandbox,
      message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-legacy-tool:throw/,
    });

    const instrumentedRoot = path.relative(sandbox.root, instrumented.sourceRoot)
      .split(path.sep)
      .join("/");
    const after = (await snapshotInstallerState(sandbox)).filter(
      (entry) => !entry.path.startsWith(instrumentedRoot),
    );
    assert.deepEqual(after, before);
    assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
    await assertNoTransactionArtifacts(sandbox);

    await runInstaller({ installerPath, sandbox });
    assert.equal(await pathExists(fixture.toolTarget), false);
    assert.equal((await readJson(fixture.ownerMarker)).version, 3);
    await assertNoTransactionArtifacts(sandbox);
  });
}

test("Windows v1 throw after moving the legacy command restores v1 and permits retry", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await createV1Install(sandbox);
  await mkdir(path.join(sandbox.homeDir, ".agents", "skills"), { recursive: true });
  const before = await snapshotInstallerState(sandbox);
  const instrumented = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-legacy-command",
    action: "throw",
  });

  await assertInstrumentedFailure({
    instrumentedInstallerPath: instrumented.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-legacy-command:throw/,
  });

  const after = (await snapshotInstallerState(sandbox)).filter(
    (entry) => !entry.path.startsWith(path.relative(sandbox.root, instrumented.sourceRoot).split(path.sep).join("/")),
  );
  assert.deepEqual(after, before);
  assert.equal(await sha256(fixture.commandTarget), fixture.commandHash);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  await assertNoTransactionArtifacts(sandbox);

  await runInstaller({ installerPath, sandbox });
  assert.equal(await pathExists(fixture.commandTarget), false);
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows rollback preserves an unowned empty Skill namespace created before the second check", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const instrumented = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "before-skill-recheck",
    action: "create-skill-conflict",
  });

  await assertInstrumentedFailure({
    instrumentedInstallerPath: instrumented.installerPath,
    sandbox,
    message: understandSkillCollisionMessage,
  });

  const skillDir = path.join(sandbox.homeDir, ".agents", "skills", "understand");
  assert.equal(await pathExists(skillDir), true);
  assert.deepEqual(await readdir(skillDir), []);
  assert.equal(await pathExists(path.join(sandbox.homeDir, ".legacy-code-atlas")), false);
  assert.equal(await pathExists(path.join(sandbox.configDir, "tools", "legacy_atlas.ts")), false);
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows recovers a pre-commit transaction-v1 journal before running the v3 installer", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await windowsHarness.createV2Install(sandbox, {
    skillContent: "# Original v2 Skill before legacy crash\n",
    toolContent: "export const originalV2Tool = true;\n",
  });
  const before = await snapshotInstallerState(sandbox);
  const id = "11111111111111111111111111111111";
  const paths = legacyV1TransactionPaths({ sandbox, configDir: sandbox.configDir, id });

  await rename(fixture.installDir, paths.runtimeBackup);
  await mkdir(fixture.installDir, { recursive: true });
  await rename(fixture.skillTarget, paths.skillBackup);
  await rename(fixture.toolTarget, paths.toolBackup);
  await Promise.all([
    writeFile(fixture.skillTarget, await readFile(sourceSkillPath)),
    writeFile(fixture.toolTarget, "export {};\n", "utf8"),
    writeFile(
      paths.manifestTemp,
      `\uFEFF${JSON.stringify({ owner: "legacy-code-atlas-install-v2", version: 2 })}`,
      "utf8",
    ),
  ]);
  await writeLegacyV1TransactionJournal({
    sandbox,
    configDir: sandbox.configDir,
    id,
    manifestSha256: await sha256(paths.manifestTemp),
    skillSha256: await sha256(fixture.skillTarget),
    toolSha256: await sha256(fixture.toolTarget),
  });

  const recoveryOnly = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-recovery",
    action: "throw",
  });
  await assertInstrumentedFailure({
    instrumentedInstallerPath: recoveryOnly.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-recovery:throw/,
  });

  const instrumentedRoot = path.relative(sandbox.root, recoveryOnly.sourceRoot)
    .split(path.sep)
    .join("/");
  const after = (await snapshotInstallerState(sandbox)).filter(
    (entry) => !entry.path.startsWith(instrumentedRoot),
  );
  assert.deepEqual(after, before);
  assert.equal(await sha256(fixture.skillTarget), fixture.skillHash);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows completes post-commit cleanup for a transaction-v1 journal", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await windowsHarness.createV2Install(sandbox);
  const id = "22222222222222222222222222222222";
  const paths = legacyV1TransactionPaths({ sandbox, configDir: sandbox.configDir, id });
  await mkdir(paths.runtimeBackup, { recursive: true });
  await Promise.all([
    writeFile(path.join(paths.runtimeBackup, "old-runtime.txt"), "old runtime\n", "utf8"),
    writeFile(paths.skillBackup, "# Previous Skill backup\n", "utf8"),
    writeFile(paths.toolBackup, "export const previousToolBackup = true;\n", "utf8"),
  ]);
  const legacyJournal = await writeLegacyV1TransactionJournal({
    sandbox,
    configDir: sandbox.configDir,
    id,
    manifestSha256: await sha256(fixture.ownerMarker),
    skillSha256: fixture.skillHash,
    toolSha256: fixture.toolHash,
  });

  const recoveryOnly = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-recovery",
    action: "throw",
  });
  await assertInstrumentedFailure({
    instrumentedInstallerPath: recoveryOnly.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-recovery:throw/,
  });

  assert.equal(await sha256(fixture.skillTarget), fixture.skillHash);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  assert.equal((await readJson(fixture.ownerMarker)).version, 2);
  assert.equal(await pathExists(legacyJournal.journalPath), false);
  assert.equal(await pathExists(paths.runtimeBackup), false);
  assert.equal(await pathExists(paths.skillBackup), false);
  assert.equal(await pathExists(paths.toolBackup), false);
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows next launch restores a retired v2 tool after a crash before manifest commit", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await windowsHarness.createV2Install(sandbox, {
    skillContent: "# Old v2 Skill before crash\n",
    toolContent: "export const oldV2ToolBeforeCrash = true;\n",
  });
  const before = await snapshotInstallerState(sandbox);
  const crashing = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-legacy-tool",
    action: "crash",
  });
  await assert.rejects(
    runInstaller({ installerPath: crashing.installerPath, sandbox }),
    (error) => {
      assert.equal(error.powerShellMajorVersion, 5);
      assert.equal(error.powerShellMinorVersion, 1);
      return true;
    },
  );
  assert.equal(
    await pathExists(path.join(sandbox.homeDir, ".legacy-code-atlas.transaction.json")),
    true,
  );
  const journal = await readJson(path.join(sandbox.homeDir, ".legacy-code-atlas.transaction.json"));
  assert.equal(await pathExists(fixture.toolTarget), false);
  assert.equal(await pathExists(journal.legacyToolBackup), true);

  const recoveryOnly = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-recovery",
    action: "throw",
  });
  await assertInstrumentedFailure({
    instrumentedInstallerPath: recoveryOnly.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-recovery:throw/,
  });

  const instrumentedRoots = [crashing.sourceRoot, recoveryOnly.sourceRoot].map((root) => (
    path.relative(sandbox.root, root).split(path.sep).join("/")
  ));
  const after = (await snapshotInstallerState(sandbox)).filter(
    (entry) => !instrumentedRoots.some((root) => entry.path.startsWith(root)),
  );
  assert.deepEqual(after, before);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  assert.equal(await sha256(fixture.skillTarget), fixture.skillHash);
  await assertNoTransactionArtifacts(sandbox);

  await runInstaller({ installerPath, sandbox });
  assert.equal(await pathExists(fixture.toolTarget), false);
  assert.equal((await readJson(fixture.ownerMarker)).version, 3);
});

test("Windows crash before staged Skill copy never creates the final Skill namespace", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const crashing = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-skill-stage-directory",
    action: "crash",
  });
  await assert.rejects(
    runInstaller({ installerPath: crashing.installerPath, sandbox }),
    (error) => error.powerShellMajorVersion === 5 && error.powerShellMinorVersion === 1,
  );

  const journalPath = path.join(sandbox.homeDir, ".legacy-code-atlas.transaction.json");
  const journal = await readJson(journalPath);
  const skillDir = path.join(sandbox.homeDir, ".agents", "skills", "understand");
  assert.equal(await pathExists(journal.skillTemp), true);
  assert.equal(await pathExists(skillDir), false);

  const recoveryOnly = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-recovery",
    action: "throw",
  });
  await assertInstrumentedFailure({
    instrumentedInstallerPath: recoveryOnly.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-recovery:throw/,
  });
  assert.equal(await pathExists(journal.skillTemp), false);
  assert.equal(await pathExists(skillDir), false);
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows recovery keeps a retired v2 tool absent after the v3 manifest commit", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await windowsHarness.createV2Install(sandbox, {
    skillContent: "# Old v2 Skill before committed crash\n",
    toolContent: "export const oldV2ToolBeforeCommittedCrash = true;\n",
  });
  const crashing = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-manifest",
    action: "crash",
  });
  await assert.rejects(
    runInstaller({ installerPath: crashing.installerPath, sandbox }),
    (error) => {
      assert.equal(error.powerShellMajorVersion, 5);
      assert.equal(error.powerShellMinorVersion, 1);
      return true;
    },
  );
  assert.equal(
    await pathExists(path.join(sandbox.homeDir, ".legacy-code-atlas.transaction.json")),
    true,
  );
  assert.equal(await pathExists(fixture.toolTarget), false);

  const recoveryOnly = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-recovery",
    action: "throw",
  });
  await assertInstrumentedFailure({
    instrumentedInstallerPath: recoveryOnly.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-recovery:throw/,
  });

  const installDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
  const skillTarget = path.join(sandbox.homeDir, ".agents", "skills", "understand", "SKILL.md");
  const manifest = await readJson(path.join(installDir, ".legacy-code-atlas-owner.json"));
  assert.equal(manifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(manifest.version, 3);
  assert.deepEqual(manifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
  assert.equal(await sha256(skillTarget), await sha256(sourceSkillPath));
  assert.equal(await pathExists(fixture.toolTarget), false);
  await assertNoTransactionArtifacts(sandbox);
});

test("Windows recovery preserves a v2 Skill modified after an interrupted replacement", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await windowsHarness.createV2Install(sandbox, {
    skillContent: "# Old owned Skill before update\n",
    toolContent: "export const oldOwnedToolBeforeUpdate = true;\n",
  });
  const crashing = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-skill",
    action: "crash",
  });
  await assert.rejects(
    runInstaller({ installerPath: crashing.installerPath, sandbox }),
    (error) => error.powerShellMajorVersion === 5 && error.powerShellMinorVersion === 1,
  );

  const journalPath = path.join(sandbox.homeDir, ".legacy-code-atlas.transaction.json");
  const journal = await readJson(journalPath);
  const userContent = "# User changed the newly installed Skill before recovery\n";
  await writeFile(fixture.skillTarget, userContent, "utf8");

  await assert.rejects(
    runInstaller({ installerPath, sandbox }),
    (error) => {
      assert.match(`${error.message}\n${error.stderr ?? ""}`, /回滚.*目标.*修改.*拒绝覆盖/);
      return true;
    },
  );
  assert.equal(await readFile(fixture.skillTarget, "utf8"), userContent);
  assert.equal(await pathExists(journal.skillBackup), true);
  assert.equal(await pathExists(journalPath), true);

  await writeFile(fixture.skillTarget, await readFile(sourceSkillPath));
  const recoveryOnly = await windowsHarness.createInstrumentedInstaller({
    sandbox,
    sourceRoot,
    phase: "after-recovery",
    action: "throw",
  });
  await assertInstrumentedFailure({
    instrumentedInstallerPath: recoveryOnly.installerPath,
    sandbox,
    message: /LEGACY_CODE_ATLAS_TEST_FAILPOINT:after-recovery:throw/,
  });

  assert.equal(await sha256(fixture.skillTarget), fixture.skillHash);
  assert.equal(await sha256(fixture.toolTarget), fixture.toolHash);
  assert.equal(await pathExists(journal.skillBackup), false);
  await assertNoTransactionArtifacts(sandbox);
});

for (const version of [1, 2, 3]) {
  test(`Windows v${version} uninstall removes matching owned files and only the private runtime`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const fixture = version === 1
      ? await createV1Install(sandbox)
      : version === 2
        ? await windowsHarness.createV2Install(sandbox)
        : await createV3Install(sandbox);
    const commandDir = path.join(sandbox.configDir, "commands");
    const toolDir = path.join(sandbox.configDir, "tools");
    const commandSibling = path.join(commandDir, "keep-command.md");
    const toolSibling = path.join(toolDir, "keep-tool.ts");
    const sharedSkillSibling = path.join(
      sandbox.homeDir,
      ".agents",
      "skills",
      "keep-skill",
      "SKILL.md",
    );
    const v3UnownedTool = path.join(toolDir, "legacy_atlas.ts");
    await Promise.all([
      mkdir(commandDir, { recursive: true }),
      mkdir(toolDir, { recursive: true }),
      mkdir(path.dirname(sharedSkillSibling), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(commandSibling, "keep command\n", "utf8"),
      writeFile(toolSibling, "keep tool\n", "utf8"),
      writeFile(sharedSkillSibling, "# Keep shared Skill\n", "utf8"),
      ...(version === 3
        ? [writeFile(v3UnownedTool, "export const companyTool = true;\n", "utf8")]
        : []),
    ]);

    await runInstaller({ installerPath, sandbox, args: ["-Uninstall"] });

    assert.equal(await pathExists(fixture.installDir), false);
    if (version === 1) {
      assert.equal(await pathExists(fixture.commandTarget), false);
      assert.equal(await pathExists(fixture.toolTarget), false);
    } else if (version === 2) {
      assert.equal(await pathExists(fixture.toolTarget), false);
      assert.equal(await pathExists(fixture.skillTarget), false);
      assert.equal(await pathExists(path.dirname(fixture.skillTarget)), false);
    } else {
      assert.equal(await pathExists(fixture.skillTarget), false);
      assert.equal(await pathExists(fixture.skillDir), false);
      assert.equal(await readFile(v3UnownedTool, "utf8"), "export const companyTool = true;\n");
    }
    assert.equal(await pathExists(commandDir), true);
    assert.equal(await pathExists(toolDir), true);
    assert.equal(await readFile(commandSibling, "utf8"), "keep command\n");
    assert.equal(await readFile(toolSibling, "utf8"), "keep tool\n");
    assert.equal(await readFile(sharedSkillSibling, "utf8"), "# Keep shared Skill\n");
    assert.equal(await pathExists(path.join(sandbox.homeDir, ".agents", "skills")), true);
    await assertNoTransactionArtifacts(sandbox);
  });
}

for (const [version, modifiedKind] of [
  [1, "command"],
  [1, "tool"],
  [2, "skill"],
  [2, "tool"],
  [3, "skill"],
]) {
  test(`Windows v${version} uninstall preserves a modified owned ${modifiedKind} and removes matching peers`, { skip: windowsOnly }, async (t) => {
    const sandbox = await createWindowsInstallerSandbox(t);
    const savedConfigDir = path.join(sandbox.root, `saved-v${version}-uninstall-config`);
    const fixture = version === 1
      ? await createV1Install({ ...sandbox, configDir: savedConfigDir })
      : version === 2
        ? await windowsHarness.createV2Install(sandbox, { configDir: savedConfigDir })
        : await createV3Install(sandbox, { configDir: savedConfigDir });
    const modifiedTarget = modifiedKind === "command"
      ? fixture.commandTarget
      : modifiedKind === "skill"
        ? fixture.skillTarget
        : fixture.toolTarget;
    const matchingPeer = version === 1
      ? (modifiedKind === "command" ? fixture.toolTarget : fixture.commandTarget)
      : version === 2
        ? (modifiedKind === "skill" ? fixture.toolTarget : fixture.skillTarget)
        : null;
    const modifiedContent = `user modified v${version} ${modifiedKind}\n`;
    const sibling = path.join(path.dirname(modifiedTarget), "keep-sibling.txt");
    await Promise.all([
      writeFile(modifiedTarget, modifiedContent, "utf8"),
      writeFile(sibling, "keep sibling\n", "utf8"),
    ]);

    await runInstaller({ installerPath, sandbox, args: ["-Uninstall"] });

    assert.equal(await pathExists(fixture.installDir), false);
    assert.equal(await readFile(modifiedTarget, "utf8"), modifiedContent);
    if (matchingPeer) {
      assert.equal(await pathExists(matchingPeer), false);
    }
    assert.equal(await readFile(sibling, "utf8"), "keep sibling\n");
    assert.equal(await pathExists(path.dirname(modifiedTarget)), true);
  });
}

test("Windows v3 uninstall preserves a matching Skill namespace that contains an extra sibling", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t);
  const fixture = await createV3Install(sandbox);
  const sibling = path.join(fixture.skillDir, "company-notes.txt");
  await writeFile(sibling, "keep namespace sibling\n", "utf8");

  await runInstaller({ installerPath, sandbox, args: ["-Uninstall"] });

  assert.equal(await pathExists(fixture.installDir), false);
  assert.equal(await pathExists(fixture.skillTarget), false);
  assert.equal(await readFile(sibling, "utf8"), "keep namespace sibling\n");
  assert.equal(await pathExists(fixture.skillDir), true);
  assert.equal(await pathExists(path.join(sandbox.homeDir, ".agents", "skills")), true);
});

test("Windows installs, updates, uninstalls, and freshly reinstalls inside a non-ASCII path", { skip: windowsOnly }, async (t) => {
  const sandbox = await createWindowsInstallerSandbox(t, {
    prefix: "legacy-atlas-公司旧项目-",
  });

  await runInstaller({ installerPath, sandbox });
  const installDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
  const ownerMarker = path.join(installDir, ".legacy-code-atlas-owner.json");
  const skillTarget = path.join(sandbox.homeDir, ".agents", "skills", "understand", "SKILL.md");
  const toolTarget = path.join(sandbox.configDir, "tools", "legacy_atlas.ts");
  const firstManifest = await readJson(ownerMarker);
  assert.equal(firstManifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(firstManifest.version, 3);
  assert.deepEqual(firstManifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
  assert.equal(path.normalize(firstManifest.configDir), path.normalize(sandbox.configDir));
  assert.equal(await sha256(skillTarget), await sha256(sourceSkillPath));
  assert.equal(await pathExists(toolTarget), false);
  assert.equal(await pathExists(path.dirname(toolTarget)), false);

  await runInstaller({ installerPath, sandbox });
  const updatedManifest = await readJson(ownerMarker);
  assert.equal(updatedManifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(updatedManifest.version, 3);
  assert.deepEqual(updatedManifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
  assert.equal(await sha256(skillTarget), await sha256(sourceSkillPath));
  assert.equal(await pathExists(toolTarget), false);

  await runInstaller({ installerPath, sandbox, args: ["-Uninstall"] });
  assert.equal(await pathExists(installDir), false);
  assert.equal(await pathExists(skillTarget), false);
  assert.equal(await pathExists(toolTarget), false);
  await assertNoTransactionArtifacts(sandbox);

  await runInstaller({ installerPath, sandbox });
  const reinstalledManifest = await readJson(ownerMarker);
  assert.equal(reinstalledManifest.owner, "legacy-code-atlas-install-v3");
  assert.equal(reinstalledManifest.version, 3);
  assert.deepEqual(reinstalledManifest.ownedFiles.map((entry) => entry.kind), ["agent-skill"]);
  assert.equal(await sha256(skillTarget), await sha256(sourceSkillPath));
  assert.equal(await pathExists(toolTarget), false);
  await assertNoTransactionArtifacts(sandbox);
});
