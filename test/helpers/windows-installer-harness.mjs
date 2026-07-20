import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const powerShellPrefix = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
];
const installerFailpointStatements = new Map([
  ["after-journal", "Write-TransactionJournal $Transaction"],
  [
    "after-skill-stage-directory",
    "New-Item -ItemType Directory -Path $Transaction.SkillTemp -Force | Out-Null",
  ],
  ["after-runtime", "Move-RuntimeIntoPlace $Transaction"],
  ["after-skill", "Replace-SkillFile $Transaction"],
  ["after-tool", "Replace-ToolFile $Transaction"],
  ["after-legacy-command", "Backup-LegacyCommand $Transaction"],
  ["after-manifest", "Commit-ManifestFile $Transaction"],
  ["after-recovery", "Recover-InstallTransaction"],
  ["before-skill-recheck", "$toolDir = Split-Path -Parent $Transaction.ToolTarget"],
]);

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireSandbox(sandbox) {
  for (const field of ["root", "homeDir", "configDir"]) {
    if (!sandbox || typeof sandbox[field] !== "string" || sandbox[field].length === 0) {
      throw new TypeError(`sandbox.${field} must be a non-empty path`);
    }
  }
}

function sameWindowsPath(left, right) {
  return path.win32.resolve(left).toLowerCase() === path.win32.resolve(right).toLowerCase();
}

function sha256Bytes(content) {
  return createHash("sha256").update(content).digest("hex").toUpperCase();
}

export function assertWindowsPowerShell51({ major, minor, version }) {
  if (major !== 5 || minor !== 1) {
    throw new Error(`Windows PowerShell 5.1 is required; found ${version}`);
  }
}

export async function createWindowsInstallerSandbox(t, options = {}) {
  const prefix = options.prefix ?? "legacy-atlas-windows-installer-";
  if (typeof prefix !== "string" || prefix.length === 0 || /[\\/]/.test(prefix)) {
    throw new TypeError("sandbox prefix must be a non-empty path segment");
  }
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const homeDir = path.join(root, "home");
  const configDir = path.join(root, "opencode-config");
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(configDir, { recursive: true }),
  ]);

  if (t && typeof t.after === "function") {
    t.after(() => rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    }));
  }

  return { root, homeDir, configDir };
}

export async function readJson(filePath) {
  const content = await readFile(filePath, "utf8");
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return JSON.parse(withoutBom);
}

export async function sha256(filePath) {
  const content = await readFile(filePath);
  return createHash("sha256").update(content).digest("hex").toUpperCase();
}

export async function snapshotTree(root) {
  const snapshot = [];

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareOrdinal(left.name, right.name));

    for (const entry of entries) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(root, absolutePath).split(path.sep).join("/");

      if (entry.isSymbolicLink()) {
        snapshot.push({
          path: relativePath,
          type: "symbolic-link",
          target: await readlink(absolutePath),
        });
      } else if (entry.isDirectory()) {
        snapshot.push({ path: relativePath, type: "directory" });
        await visit(absolutePath);
      } else if (entry.isFile()) {
        const content = await readFile(absolutePath);
        snapshot.push({
          path: relativePath,
          type: "file",
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex").toUpperCase(),
        });
      } else {
        snapshot.push({ path: relativePath, type: "other" });
      }
    }
  }

  await visit(root);
  snapshot.sort((left, right) => compareOrdinal(left.path, right.path));
  return snapshot;
}

export async function createV1Install(sandbox, options = {}) {
  requireSandbox(sandbox);
  const installDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
  const ownerMarker = path.join(installDir, ".legacy-code-atlas-owner.json");
  const commandTarget = path.join(sandbox.configDir, "commands", "understand.md");
  const toolTarget = path.join(sandbox.configDir, "tools", "legacy_atlas.ts");
  const commandContent = options.commandContent ?? "# Legacy Understand command\n";
  const toolContent = options.toolContent ?? "export const legacyAtlasTool = {};\n";

  await Promise.all([
    mkdir(installDir, { recursive: true }),
    mkdir(path.dirname(commandTarget), { recursive: true }),
    mkdir(path.dirname(toolTarget), { recursive: true }),
  ]);
  const externalWrites = [];
  if (!options.omitCommand) {
    externalWrites.push(writeFile(commandTarget, commandContent, "utf8"));
  }
  if (!options.omitTool) {
    externalWrites.push(writeFile(toolTarget, toolContent, "utf8"));
  }
  await Promise.all(externalWrites);

  const commandHash = sha256Bytes(Buffer.from(commandContent, "utf8"));
  const toolHash = sha256Bytes(Buffer.from(toolContent, "utf8"));
  const manifest = {
    owner: "legacy-code-atlas-install-v1",
    version: 1,
    installDir,
    configDir: sandbox.configDir,
    commandTarget,
    toolTarget,
    commandHash,
    toolHash,
  };
  await writeFile(ownerMarker, `\uFEFF${JSON.stringify(manifest, null, 2)}`, "utf8");

  return {
    installDir,
    ownerMarker,
    commandTarget,
    toolTarget,
    commandHash,
    toolHash,
    manifest,
  };
}

export async function createV2Install(sandbox, options = {}) {
  requireSandbox(sandbox);
  const configDir = options.configDir ?? sandbox.configDir;
  const installDir = path.join(sandbox.homeDir, ".legacy-code-atlas");
  const ownerMarker = path.join(installDir, ".legacy-code-atlas-owner.json");
  const skillTarget = path.join(
    sandbox.homeDir,
    ".agents",
    "skills",
    "understand",
    "SKILL.md",
  );
  const toolTarget = path.join(configDir, "tools", "legacy_atlas.ts");
  const skillContent = options.skillContent ?? "# Installed Legacy Code Atlas Skill\n";
  const toolContent = options.toolContent ?? "export const legacyAtlasTool = {};\n";
  const skillHash = sha256Bytes(Buffer.from(skillContent, "utf8"));
  const toolHash = sha256Bytes(Buffer.from(toolContent, "utf8"));

  await Promise.all([
    mkdir(installDir, { recursive: true }),
    mkdir(path.dirname(skillTarget), { recursive: true }),
    mkdir(path.dirname(toolTarget), { recursive: true }),
  ]);
  await writeFile(
    path.join(installDir, "runtime-sentinel.txt"),
    options.runtimeContent ?? "legacy-code-atlas-v2-runtime\n",
    "utf8",
  );
  const externalWrites = [];
  if (!options.omitSkill) {
    externalWrites.push(writeFile(skillTarget, skillContent, "utf8"));
  }
  if (!options.omitTool) {
    externalWrites.push(writeFile(toolTarget, toolContent, "utf8"));
  }
  await Promise.all(externalWrites);

  const manifest = {
    owner: "legacy-code-atlas-install-v2",
    version: 2,
    installDir,
    configDir,
    ownedFiles: options.ownedFiles ?? [
      { kind: "agent-skill", path: skillTarget, sha256: skillHash },
      { kind: "opencode-tool", path: toolTarget, sha256: toolHash },
    ],
  };
  await writeFile(ownerMarker, `\uFEFF${JSON.stringify(manifest, null, 2)}`, "utf8");

  return {
    installDir,
    ownerMarker,
    skillTarget,
    toolTarget,
    skillHash,
    toolHash,
    manifest,
  };
}

export async function createInstrumentedInstaller({
  sandbox,
  sourceRoot,
  phase,
  action,
}) {
  requireSandbox(sandbox);
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0) {
    throw new TypeError("sourceRoot must be a non-empty path");
  }
  const statement = installerFailpointStatements.get(phase);
  if (!statement) {
    throw new TypeError(`unsupported installer failpoint phase: ${phase}`);
  }
  if (action !== "throw" && action !== "crash" && action !== "create-skill-conflict") {
    throw new TypeError(`unsupported installer failpoint action: ${action}`);
  }
  if ((phase === "before-skill-recheck") !== (action === "create-skill-conflict")) {
    throw new TypeError(`installer failpoint phase/action mismatch: ${phase}/${action}`);
  }

  const copiedSourceRoot = await mkdtemp(path.join(
    sandbox.root,
    `installer-source-${phase}-${action}-`,
  ));
  await Promise.all([
    cp(path.join(sourceRoot, "bin"), path.join(copiedSourceRoot, "bin"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    }),
    cp(path.join(sourceRoot, "src"), path.join(copiedSourceRoot, "src"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    }),
    copyFile(
      path.join(sourceRoot, "package.json"),
      path.join(copiedSourceRoot, "package.json"),
    ),
  ]);

  const copiedSkill = path.join(
    copiedSourceRoot,
    "integrations",
    "opencode",
    "skills",
    "understand",
    "SKILL.md",
  );
  const copiedTool = path.join(
    copiedSourceRoot,
    "integrations",
    "opencode",
    "tools",
    "legacy_atlas.ts",
  );
  await Promise.all([
    mkdir(path.dirname(copiedSkill), { recursive: true }),
    mkdir(path.dirname(copiedTool), { recursive: true }),
  ]);
  await Promise.all([
    copyFile(
      path.join(sourceRoot, "integrations", "opencode", "skills", "understand", "SKILL.md"),
      copiedSkill,
    ),
    copyFile(
      path.join(sourceRoot, "integrations", "opencode", "tools", "legacy_atlas.ts"),
      copiedTool,
    ),
  ]);

  const installerPath = path.join(copiedSourceRoot, "install.ps1");
  const installer = await readFile(path.join(sourceRoot, "install.ps1"), "utf8");
  const newline = installer.includes("\r\n") ? "\r\n" : "\n";
  const anchor = phase === "after-recovery"
    ? `${newline}${statement}${newline}`
    : statement;
  const occurrences = installer.split(anchor).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `installer failpoint statement must occur exactly once (${phase}: found ${occurrences})`,
    );
  }
  const marker = `# LEGACY_CODE_ATLAS_TEST_FAILPOINT:${phase}:${action}`;
  let effect;
  if (action === "throw") {
    effect = `throw \"LEGACY_CODE_ATLAS_TEST_FAILPOINT:${phase}:${action}\"`;
  } else if (action === "crash") {
    effect = [
        "[Diagnostics.Process]::GetCurrentProcess().Kill()",
        "exit 197",
      ].join(newline);
  } else {
    effect = "New-Item -ItemType Directory -Path $SkillDir -Force | Out-Null";
  }
  const replacement = phase === "after-recovery"
    ? `${newline}${statement}${newline}${marker}${newline}${effect}${newline}`
    : [statement, marker, effect].join(newline);
  const instrumented = installer.replace(anchor, replacement);
  await writeFile(installerPath, instrumented, "utf8");

  return {
    sourceRoot: copiedSourceRoot,
    installerPath,
    phase,
    action,
  };
}

export async function createDirectoryJunction({ target, junction }) {
  if (process.platform !== "win32") {
    throw new Error("createDirectoryJunction requires Windows");
  }
  for (const [name, value] of [["target", target], ["junction", junction]]) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty path`);
    }
  }
  await symlink(path.resolve(target), junction, "junction");
  return { target: path.resolve(target), junction: path.resolve(junction) };
}

export async function runInstaller({
  installerPath,
  sandbox,
  args = [],
  env = {},
  timeout = 120_000,
}) {
  if (process.platform !== "win32") {
    throw new Error("runInstaller requires Windows");
  }
  requireSandbox(sandbox);
  if (typeof installerPath !== "string" || installerPath.length === 0) {
    throw new TypeError("installerPath must be a non-empty path");
  }
  if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
    throw new TypeError("args must be an array of strings");
  }

  const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
  if (!systemRoot) {
    throw new Error("SystemRoot is not set; cannot locate Windows PowerShell 5.1");
  }
  const command = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const childEnv = {
    ...process.env,
    ...env,
    HOME: sandbox.homeDir,
    USERPROFILE: sandbox.homeDir,
    OPENCODE_CONFIG_DIR: sandbox.configDir,
  };
  const probePath = path.join(sandbox.root, "assert-windows-powershell.ps1");
  const probeSource = [
    "$ErrorActionPreference = 'Stop'",
    "$outputEncoding = New-Object System.Text.UTF8Encoding -ArgumentList $false",
    "[Console]::OutputEncoding = $outputEncoding",
    "$result = [ordered]@{",
    "    major = $PSVersionTable.PSVersion.Major",
    "    minor = $PSVersionTable.PSVersion.Minor",
    "    version = $PSVersionTable.PSVersion.ToString()",
    "    home = [string]$HOME",
    "    userProfile = [string]$env:USERPROFILE",
    "    configDir = [string]$env:OPENCODE_CONFIG_DIR",
    "}",
    "$result | ConvertTo-Json -Compress",
    "",
  ].join("\r\n");
  await writeFile(probePath, probeSource, "ascii");

  const executionOptions = {
    env: childEnv,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    timeout,
    windowsHide: true,
  };
  const probe = await execFileAsync(
    command,
    [...powerShellPrefix, probePath],
    executionOptions,
  );
  const probeResult = JSON.parse(probe.stdout.replace(/^\uFEFF/, "").trim());
  assertWindowsPowerShell51(probeResult);
  for (const [name, actual, expected] of [
    ["HOME", probeResult.home, sandbox.homeDir],
    ["USERPROFILE", probeResult.userProfile, sandbox.homeDir],
    ["OPENCODE_CONFIG_DIR", probeResult.configDir, sandbox.configDir],
  ]) {
    if (!sameWindowsPath(actual, expected)) {
      throw new Error(`${name} escaped the installer test sandbox: ${actual}`);
    }
  }

  const installerArgs = [...powerShellPrefix, installerPath, ...args];
  try {
    const result = await execFileAsync(command, installerArgs, executionOptions);
    return {
      command,
      args: installerArgs,
      powerShellMajorVersion: probeResult.major,
      powerShellMinorVersion: probeResult.minor,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    error.command = command;
    error.args = installerArgs;
    error.powerShellMajorVersion = probeResult.major;
    error.powerShellMinorVersion = probeResult.minor;
    throw error;
  }
}
