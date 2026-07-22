import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

function topLevelFunction(installer, name) {
  const startPattern = new RegExp(`^function\\s+${name}\\b`, "m");
  const match = startPattern.exec(installer);
  assert.ok(match, `missing PowerShell function ${name}`);

  const remainder = installer.slice(match.index + match[0].length);
  const nextFunction = /\r?\nfunction\s+[A-Za-z][A-Za-z0-9-]*\b/.exec(remainder);
  return installer.slice(
    match.index,
    nextFunction ? match.index + match[0].length + nextFunction.index : installer.length,
  );
}

function assertOrdered(source, snippets) {
  let previous = -1;
  for (const snippet of snippets) {
    const current = source.indexOf(snippet);
    assert.ok(current >= 0, `missing ordered installer step: ${snippet}`);
    assert.ok(current > previous, `installer step is out of order: ${snippet}`);
    previous = current;
  }
}

test("Skill-only v3 never ships or publishes an OpenCode TypeScript tool", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const initialize = topLevelFunction(installer, "Initialize-InstallTransactionManifest");
  const prepare = topLevelFunction(installer, "Prepare-InstallTransaction");
  const commit = topLevelFunction(installer, "Commit-InstallTransaction");

  await assert.rejects(
    access(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );
  assert.match(installer, /legacy-code-atlas-install-v3/);
  assert.match(initialize, /owner\s*=\s*\$OwnerValueV3/);
  assert.match(initialize, /version\s*=\s*3/);
  assert.match(initialize, /kind\s*=\s*["']agent-skill["']/);
  assert.doesNotMatch(initialize, /opencode-tool|ToolSource|ToolSha256/);
  assert.doesNotMatch(prepare, /ToolSource|ToolTemp|tools[\\/]legacy_atlas[.]ts/);
  assert.doesNotMatch(commit, /Replace-ToolFile/);
  assert.doesNotMatch(installer, /\$ToolSource\b|integrations[\\/]opencode[\\/]tools[\\/]legacy_atlas[.]ts/);
});

test("v1 and v2 tools are retired through journal v2 instead of being replaced", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const writeJournal = topLevelFunction(installer, "Write-TransactionJournal");
  const retireTool = topLevelFunction(installer, "Backup-LegacyTool");
  const publishedValidation = topLevelFunction(installer, "Assert-PublishedIntegrationFiles");
  const commit = topLevelFunction(installer, "Commit-InstallTransaction");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(loadTransaction, /legacy-code-atlas-transaction-v2/);
  assert.match(loadTransaction, /upgrade-v1/);
  assert.match(loadTransaction, /upgrade-v2/);
  assert.match(loadTransaction, /update-v3/);
  assert.match(writeJournal, /version\s*=\s*2/);
  assert.match(writeJournal, /legacyToolSha256/);
  assert.match(writeJournal, /legacyToolBackup/);
  assert.doesNotMatch(writeJournal, /(?:^|[^A-Za-z])toolTemp\b|(?:^|[^A-Za-z])toolSha256\s*=/im);
  assertOrdered(retireTool, [
    "Get-PathEntryWithoutFollowingTarget $Transaction.LegacyToolTarget",
    "Get-ContentHash $Transaction.LegacyToolTarget",
    "$Transaction.LegacyToolSha256",
    "Move-Item -LiteralPath $Transaction.LegacyToolTarget -Destination $Transaction.LegacyToolBackup",
  ]);
  assertOrdered(commit, ["Backup-LegacyTool", "Commit-ManifestFile"]);
  assert.match(publishedValidation, /Get-PathEntryWithoutFollowingTarget\s+\$Transaction\.LegacyToolTarget/);
  assert.match(publishedValidation, /legacy tool[^\r\n]*(?:仍存在|未移除)/i);
  assertOrdered(rollback, [
    "Restore-LegacyOwnedFile",
    "-Target $Transaction.LegacyToolTarget",
    "-Backup $Transaction.LegacyToolBackup",
  ]);
});

test("uninstall removes only an empty owned understand Skill directory so reinstall can proceed", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const uninstallStart = installer.indexOf("if ($Uninstall)");
  const installStart = installer.indexOf("$nodeCommand = Get-Command node", uninstallStart);
  assert.ok(uninstallStart >= 0 && installStart > uninstallStart, "missing uninstall block");
  const uninstall = installer.slice(uninstallStart, installStart);

  assertOrdered(uninstall, [
    'if ($entry.Kind -ceq "agent-skill")',
    "Remove-Item -LiteralPath $entry.Path -Force",
    "Get-PathEntryWithoutFollowingTarget $SkillDir",
    "Get-ChildItem -LiteralPath $SkillDir -Force",
    "Remove-Item -LiteralPath $SkillDir -Force",
  ]);
  assert.match(uninstall, /PSIsContainer/);
  assert.match(uninstall, /ReparsePoint/);
  assert.doesNotMatch(uninstall, /Remove-Item[^\r\n]+\$SkillDir[^\r\n]+-Recurse/);
});

test("Windows PowerShell 5.1 installer has a UTF-8 BOM", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url));

  assert.deepEqual([...installer.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test("Windows installer configures UTF-8 process output with PowerShell 5.1 APIs", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const firstFunction = installer.indexOf("function Get-CanonicalPath");
  assert.ok(firstFunction > 0, "missing installer initialization block");
  const initialization = installer.slice(0, firstFunction);

  assertOrdered(initialization, [
    "New-Object System.Text.UTF8Encoding -ArgumentList $false",
    "[Console]::OutputEncoding = $utf8OutputEncoding",
    "$OutputEncoding = $utf8OutputEncoding",
  ]);
  assert.doesNotMatch(initialization, /UTF8Encoding\]::new/);
});

test("Windows installer targets the Agent Skill and only recognizes old OpenCode files for migration", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");

  assert.match(installer, /\[switch\]\$Uninstall/);
  assert.match(installer, /\.legacy-code-atlas/);
  assert.match(installer, /OPENCODE_CONFIG_DIR/);
  assert.match(installer, /XDG_CONFIG_HOME/);
  assert.match(installer, /\.config[\\/]opencode/);
  assert.match(installer, /\.opencode/);
  assert.match(installer, /\$SkillDir\s*=\s*Join-Path\s+\$HOME\s+["']\.agents\\skills\\understand["']/);
  assert.match(installer, /\$SkillTarget\s*=\s*Join-Path\s+\$SkillDir\s+["']SKILL\.md["']/);
  assert.match(installer, /tools[\\/]legacy_atlas\.ts/);
  assert.match(installer, /integrations[\\/]opencode[\\/]skills[\\/]understand[\\/]SKILL\.md/);
  assert.doesNotMatch(installer, /integrations[\\/]opencode[\\/]commands[\\/]understand\.md/);
  assert.doesNotMatch(installer, /Copy-Item[^\r\n]+\$CommandTarget/);
  assert.match(installer, /LEGACY_CODE_ATLAS_CLI/);
  assert.match(installer, /\.legacy-code-atlas-owner/);
  assert.match(installer, /Get-Content[^\n]+\$OwnerMarker/);
  assert.doesNotMatch(installer, /\[string\]\$InstallDir|\[string\]\$OpenCodeConfigDir/);
  assert.match(installer, /已被修改，拒绝覆盖/);
  assert.match(installer, /Node\.js 20/);
  assert.match(installer, /拒绝覆盖已有目录/);
  assert.match(installer, /拒绝覆盖已有 Agent Skill 文件|不属于当前 manifest/);
  assert.doesNotMatch(installer, /Copy-Item[^\r\n]+legacy_atlas[.]ts/);
  assert.doesNotMatch(installer, /SetEnvironmentVariable\("LEGACY_CODE_ATLAS_CLI", \$CliTarget/);
});

test("OpenCode integration source is a true Skill-only runtime without a TypeScript tool", async () => {
  const skill = await readFile(
    new URL("../integrations/opencode/skills/understand/SKILL.md", import.meta.url),
    "utf8",
  );
  await assert.rejects(
    access(new URL("../integrations/opencode/tools/legacy_atlas.ts", import.meta.url)),
    (error) => error?.code === "ENOENT",
  );

  assert.match(
    skill,
    /node\s+[`\"]?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas[.]mjs[`\"]?\s+doctor\s+[`\"]?\$PWD[`\"]?/i,
  );
  assert.match(
    skill,
    /node\s+[`\"]?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas[.]mjs[`\"]?\s+analyze\s+[`\"]?\$PWD[`\"]?/i,
  );
  assert.match(skill, /node\s+[`\"]?\$HOME\/[.]legacy-code-atlas\/bin\/legacy-code-atlas[.]mjs[`\"]?\s+overview\s+[`\"]?\$PWD[`\"]?/i);
  assert.match(skill, /[.]legacy-code-atlas[\\/]query[.]txt/);
  assert.match(skill, /--query-file/);
  assert.doesNotMatch(skill, /legacy_atlas_/);
});

test("installer validates Skill-only sources and published artifacts before committing ownership", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const sourceValidation = topLevelFunction(installer, "Assert-IntegrationSourceFiles");
  const skillValidation = topLevelFunction(installer, "Assert-SkillCliProtocolContent");
  const publishedValidation = topLevelFunction(installer, "Assert-PublishedIntegrationFiles");
  const initialize = topLevelFunction(installer, "Initialize-InstallTransactionManifest");
  const commit = topLevelFunction(installer, "Commit-InstallTransaction");

  assert.match(sourceValidation, /Assert-SkillCliProtocolContent\s+\$SkillSource/);
  assert.doesNotMatch(sourceValidation, /ToolSource|Tombstone|legacy_atlas[.]ts/);
  for (const command of [
    "trace-url",
    "trace-statement",
    "trace-table",
    "trace-procedure",
    "trace-feature",
  ]) {
    const fixedCommand = `node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" ${command} "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok`;
    assert.ok(
      skillValidation.includes(fixedCommand),
      `installer must validate the complete fixed ${command} command`,
    );
  }
  assert.match(skillValidation, /[.]legacy-code-atlas[\\/]query[.]txt/);
  assert.match(skillValidation, /prepare-query/);
  assert.match(skillValidation, /doctor/);
  assert.match(skillValidation, /analyze/);
  assert.match(skillValidation, /overview/);
  assert.match(publishedValidation, /Get-ContentHash\s+\$SkillTarget/);
  assert.match(publishedValidation, /SkillSha256/);
  assert.match(publishedValidation, /Assert-.*Skill/);
  assert.doesNotMatch(publishedValidation, /ToolSha256|Tombstone|legacy_atlas[.]ts/);
  assert.match(initialize, /Assert-IntegrationSourceFiles/);
  assertOrdered(commit, [
    "Replace-SkillFile $Transaction",
    "Backup-LegacyTool $Transaction",
    "Assert-PublishedIntegrationFiles $Transaction",
    "Commit-ManifestFile $Transaction",
  ]);
});

test("installer blocks but never deletes unowned stale or duplicate OpenCode files", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const preflight = topLevelFunction(installer, "Assert-InstallTransactionPreflight");
  const collisionGuard = topLevelFunction(installer, "Assert-NoUnownedLegacyIntegrationFiles");

  assert.match(installer, /运行时[^\r\n]*(?:不依赖|无需)[^\r\n]*custom tool/i);
  assert.match(installer, /legacy_atlas[.]ts/);
  assert.match(installer, /不要盲目删除|不要直接删除|保留现场/);
  assert.match(preflight, /Assert-NoUnownedLegacyIntegrationFiles/);
  assert.match(preflight, /已被修改/);
  assert.match(collisionGuard, /OPENCODE_CONFIG_DIR/);
  assert.match(collisionGuard, /XDG_CONFIG_HOME/);
  assert.match(collisionGuard, /\.config[\\/]opencode/);
  assert.match(collisionGuard, /\.opencode/);
  assert.match(collisionGuard, /Join-Path\s+\$configDir\s+["']tool["']/);
  assert.match(collisionGuard, /Join-Path\s+\$configDir\s+["']tools["']/);
  assert.match(collisionGuard, /Get-ChildItem[^\r\n]+-LiteralPath[^\r\n]+-Force/);
  assert.match(collisionGuard, /GetExtension/);
  assert.match(collisionGuard, /["'][.]js["']/);
  assert.match(collisionGuard, /["'][.]ts["']/);
  for (const hash of [
    "410C82A1CBC65A4FEF185F8F2B6DA506AB328997C505569E4A88A3667A9290FF",
    "17A88674FD7F9822B2D7DBF0320AF8BBB3F6A7ABDB7EF725AB6066A505310E57",
    "5A7985A2DE64F6BC072C7890D2A3964D6645A3ED694C804F5896F615D8510235",
    "1D683E03F06B0C1CDD80671174C5BC467BD4B871736DE2728BE3E530FB87D4CC",
  ]) assert.match(collisionGuard, new RegExp(hash));
  assert.match(collisionGuard, /Get-PathEntryWithoutFollowingTarget/);
  assert.match(collisionGuard, /Get-ContentHash/);
  assert.match(collisionGuard, /Bun is not defined/);
  assert.match(collisionGuard, /保留文件并停止|保留文件/);
  assert.doesNotMatch(collisionGuard, /Remove-Item/);
});

test("Windows installer validates v1/v2 manifests and writes a one-file v3 manifest", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const initialize = topLevelFunction(installer, "Initialize-InstallTransactionManifest");

  assert.match(installer, /legacy-code-atlas-install-v1/);
  assert.match(installer, /legacy-code-atlas-install-v2/);
  assert.match(installer, /legacy-code-atlas-install-v3/);
  assert.match(installer, /ConvertFrom-Json/);
  assert.match(initialize, /owner\s*=\s*\$OwnerValueV3/);
  assert.match(initialize, /version\s*=\s*3/);
  assert.match(initialize, /ownedFiles\s*=/);
  assert.match(initialize, /kind\s*=\s*["']agent-skill["']/);
  assert.doesNotMatch(initialize, /kind\s*=\s*["']opencode-tool["']/);
  assert.match(installer, /Kind\s*=\s*["']opencode-tool["']/);
  assert.match(initialize, /path\s*=\s*Get-CanonicalPath\s+\$SkillTarget/);
  assert.match(initialize, /sha256\s*=\s*\$Transaction\.SkillSha256/);
  assert.match(installer, /@\(\$manifest\.ownedFiles\)/);
  assert.match(installer, /\.Count\s*-ne\s*2/);
  assert.match(installer, /\.Count\s*-ne\s*1/);
  assert.match(installer, /\^\[0-9A-Fa-f\]\{64\}\$/);
  assert.match(installer, /commands[\\/]understand\.md/);
  assert.match(installer, /tools[\\/]legacy_atlas\.ts/);
  assert.match(installer, /Get-FileHash/);
  assert.match(installer, /commandTarget/);
  assert.match(installer, /toolTarget/);
  assert.match(installer, /commandHash/);
  assert.match(installer, /toolHash/);
  assert.match(installer, /ConvertTo-Json\s+-Depth\s+4/);
  assert.doesNotMatch(installer, /Set-Content[^\r\n]+\$OwnerMarker|\$manifest[^\r\n]+\|\s*Set-Content/);
});

test("install manifest owner and version validation is type- and case-strict", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadManifest = topLevelFunction(installer, "Get-InstallManifest");

  assert.match(loadManifest, /PSObject\.Properties\[["']owner["']\]/);
  assert.match(loadManifest, /PSObject\.Properties\[["']version["']\]/);
  assert.match(loadManifest, /ownerProperty\.Value\s+-isnot\s+\[string\]/);
  assert.match(loadManifest, /\$owner\s+-ceq\s+\$OwnerValueV1/);
  assert.match(loadManifest, /\$owner\s+-ceq\s+\$OwnerValueV2/);
  assert.match(loadManifest, /\$owner\s+-ceq\s+\$OwnerValueV3/);
  assert.match(loadManifest, /Test-ExactIntegerValue\s+-Value\s+\$version\s+-Expected\s+1/);
  assert.match(loadManifest, /Test-ExactIntegerValue\s+-Value\s+\$version\s+-Expected\s+2/);
  assert.match(loadManifest, /Test-ExactIntegerValue\s+-Value\s+\$version\s+-Expected\s+3/);
  assert.doesNotMatch(loadManifest, /\[string\]\$manifest\.owner|\[int\]\$manifest\.version/);
  assert.doesNotMatch(loadManifest, /\$owner\s+-eq\s+\$OwnerValueV[123]/);
});

test("Get-CanonicalPath preserves drive and UNC roots while trimming both separators elsewhere", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const canonicalPath = topLevelFunction(installer, "Get-CanonicalPath");

  assert.match(canonicalPath, /\$fullPath\s*=\s*\[IO\.Path\]::GetFullPath\(\$Path\)/);
  assert.match(canonicalPath, /\$rootPath\s*=\s*\[IO\.Path\]::GetPathRoot\(\$fullPath\)/);
  assert.match(canonicalPath, /OrdinalIgnoreCase\.Equals\(\$fullPath,\s*\$rootPath\)/);
  assert.match(canonicalPath, /return\s+\$rootPath/);
  assert.match(
    canonicalPath,
    /\.TrimEnd\(\[char\[\]\]@\([\s\S]*DirectorySeparatorChar[\s\S]*AltDirectorySeparatorChar[\s\S]*\)\)/,
  );
  assert.doesNotMatch(canonicalPath, /\.TrimEnd\(\[IO\.Path\]::DirectorySeparatorChar\)/);
});

test("transaction version accepts only exact integral CLR values without narrowing overflow", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const integerCheck = topLevelFunction(installer, "Test-ExactIntegerValue");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const loadLegacyTransaction = topLevelFunction(installer, "Get-LegacyInstallTransaction");

  for (const type of ["byte", "sbyte", "int16", "uint16", "int32", "uint32", "int64", "uint64"]) {
    assert.match(integerCheck, new RegExp(`\\[${type}\\]`, "i"));
  }
  assert.match(integerCheck, /-notcontains/);
  assert.match(integerCheck, /\[decimal\]\$Value\s*-eq\s*\[decimal\]\$Expected/);
  assert.match(loadTransaction, /Test-ExactIntegerValue[^\r\n]+\$transaction\.version[^\r\n]+2/);
  assert.match(loadLegacyTransaction, /Test-ExactIntegerValue[^\r\n]+\$transaction\.version[^\r\n]+1/);
  assert.doesNotMatch(loadTransaction, /version[^\r\n]+-isnot\s+\[int\]|\[int\]\$transaction\.version/);
});

test("atomic UTF-8 files and manifest hashes include the UTF-8 BOM bytes", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const atomicWrite = topLevelFunction(installer, "Write-AtomicUtf8File");
  const bomHash = topLevelFunction(installer, "Get-Utf8BomContentHash");

  assert.match(atomicWrite, /\$preamble\s*=\s*\$encoding\.GetPreamble\(\)/);
  assertOrdered(atomicWrite, [
    "$stream.Write($preamble, 0, $preamble.Length)",
    "$stream.Write($bytes, 0, $bytes.Length)",
    "$stream.Flush($true)",
  ]);
  assert.match(bomHash, /GetPreamble\(\)/);
  assert.match(bomHash, /ComputeHash/);
});

test("installer preserves namespace ownership and journals before staging", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const preflight = topLevelFunction(installer, "Assert-InstallTransactionPreflight");
  const invoke = topLevelFunction(installer, "Invoke-InstallTransaction");
  const prepare = topLevelFunction(installer, "Prepare-InstallTransaction");
  const replaceSkill = topLevelFunction(installer, "Replace-SkillFile");

  const skillDirectoryChecks = preflight.match(
    /Get-PathEntryWithoutFollowingTarget[^\r\n]+\$SkillDir/g,
  ) ?? [];
  assert.ok(
    skillDirectoryChecks.length >= 2,
    "fresh installs and v1 upgrades must reject any pre-existing understand Skill directory",
  );
  for (const collisionGuard of [preflight, replaceSkill]) {
    assert.match(collisionGuard, /Understand-Anything/);
    assert.match(collisionGuard, /两个\s*\/understand\s+Skill/);
    assert.match(collisionGuard, /不能[^\r\n]*同一\s+namespace/);
    assert.match(collisionGuard, /不会[^\r\n]*覆盖[^\r\n]*删除/);
    assert.match(collisionGuard, /先备份[^\r\n]*原插件[^\r\n]*(?:卸载|禁用)/);
  }
  assert.match(preflight, /Assert-NoReparsePointTree\s+\$InstallDir/);
  assert.match(replaceSkill, /-not\s+\$Transaction\.SkillDirectoryExisted/);
  assertOrdered(replaceSkill, [
    "$skillNamespaceBeforePublish = Get-PathEntryWithoutFollowingTarget $SkillDir",
    "Move-Item -LiteralPath $Transaction.SkillTemp -Destination $SkillDir",
  ]);
  assert.doesNotMatch(prepare, /New-Item[^\r\n]+-Path\s+\$SkillDir\b/);
  assertOrdered(invoke, [
    "Assert-InstallTransactionPreflight",
    "Initialize-InstallTransactionManifest",
    "Write-TransactionJournal",
    "Prepare-InstallTransaction",
    "Commit-InstallTransaction",
  ]);
});

test("transaction cleanup retains its journal until every artifact is gone", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const complete = topLevelFunction(installer, "Complete-InstallTransaction");

  assert.match(complete, /\$cleanupFailed\s*=\s*\$false/);
  assert.match(complete, /\$cleanupFailed\s*=\s*\$true/);
  assert.match(complete, /if\s*\(\$cleanupFailed\)[\s\S]*throw/);
  assertOrdered(complete, ["if ($cleanupFailed)", "$TransactionJournal"]);
});

test("atomic replacement and legacy retirement enforce target existence observed at preflight", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const replaceFile = topLevelFunction(installer, "Replace-TransactionFile");
  const replaceSkill = topLevelFunction(installer, "Replace-SkillFile");
  const backupTool = topLevelFunction(installer, "Backup-LegacyTool");
  const commitManifest = topLevelFunction(installer, "Commit-ManifestFile");

  assert.match(replaceFile, /\[bool\]\$ExpectedExisted/);
  assert.match(replaceFile, /Get-PathEntryWithoutFollowingTarget/);
  assert.match(replaceFile, /target existence changed|\u76ee\u6807[^\r\n]*\u5b58\u5728\u72b6\u6001[^\r\n]*\u6539\u53d8/i);
  assert.match(replaceSkill, /-ExpectedExisted\s+\$Transaction\.SkillExisted/);
  assert.match(backupTool, /\$toolExists\s+-ne\s+\$Transaction\.LegacyToolExisted/);
  assert.match(backupTool, /Get-ContentHash\s+\$Transaction\.LegacyToolTarget/);
  assert.match(commitManifest, /-ExpectedExisted\s+\$false/);
});

test("rollback never overwrites a target modified after an interrupted replacement", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const restoreFile = topLevelFunction(installer, "Restore-TransactionFile");

  assertOrdered(restoreFile, [
    "Get-PathEntryWithoutFollowingTarget $Backup",
    "Get-PathEntryWithoutFollowingTarget $Target",
    "Get-ContentHash $Target",
    "-ne $ExpectedNewSha256",
    "throw",
    "Remove-Item -LiteralPath $Target -Force",
    "Move-Item -LiteralPath $Backup -Destination $Target",
  ]);
  assert.match(restoreFile, /回滚[^\r\n]*目标[^\r\n]*修改[^\r\n]*拒绝覆盖/);
});

test("Windows installer rejects reparse points on every owned write/delete path", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const entryLookup = topLevelFunction(installer, "Get-PathEntryWithoutFollowingTarget");
  const reparseGuard = topLevelFunction(installer, "Assert-NoReparsePointInPath");
  const reparseTree = topLevelFunction(installer, "Assert-NoReparsePointTree");
  const targetGuard = topLevelFunction(installer, "Assert-TargetPathsSafe");
  const transactionGuard = topLevelFunction(installer, "Assert-TransactionPathsSafe");
  const treeRemoval = topLevelFunction(installer, "Remove-AtlasTree");

  assert.match(entryLookup, /Get-Item[^\r\n]+-Force/);
  assert.match(entryLookup, /Get-ChildItem[^\r\n]+\$parent[^\r\n]+-Force/);
  assert.match(entryLookup, /OrdinalIgnoreCase\.Equals\([^\r\n]+\.Name[^\r\n]+\$leaf/);
  assert.match(reparseGuard, /Get-PathEntryWithoutFollowingTarget/);
  assert.match(reparseTree, /Get-PathEntryWithoutFollowingTarget/);
  assert.doesNotMatch(reparseGuard, /Test-Path/);
  assert.doesNotMatch(reparseTree, /Test-Path/);
  assert.match(reparseGuard, /\.Attributes\s*-band\s*\[IO\.FileAttributes\]::ReparsePoint/);
  assert.match(reparseGuard, /拒绝.*(?:重解析|reparse)/i);

  for (const requiredPath of [
    "$InstallDir",
    'Join-Path $InstallDir "bin"',
    'Join-Path $InstallDir "src"',
    'Join-Path $InstallDir "package.json"',
    "$SkillTarget",
  ]) {
    assert.ok(targetGuard.includes(requiredPath), `reparse preflight omits ${requiredPath}`);
  }
  assert.match(targetGuard, /-Boundary\s+\(Get-CanonicalPath\s+\$HOME\)[^\r\n]+\$SkillTarget/);
  assert.match(transactionGuard, /-Boundary\s+\$Transaction\.ConfigDir[^\r\n]+\$Transaction\.LegacyToolTarget/);
  assert.match(transactionGuard, /-Boundary\s+\$Transaction\.ConfigDir[^\r\n]+\$Transaction\.LegacyToolBackup/);
  assert.match(transactionGuard, /-Boundary\s+\$Transaction\.ConfigDir[^\r\n]+\$Transaction\.LegacyCommandTarget/);

  assert.match(treeRemoval, /Assert-NoReparsePointTree/);
  assert.match(treeRemoval, /Remove-Item[^\r\n]+-Recurse[^\r\n]+-Force/);
  const outsideTreeRemoval = installer.replace(treeRemoval, "");
  assert.doesNotMatch(outsideTreeRemoval, /Remove-Item[^\r\n]+-Recurse/);
  assert.doesNotMatch(installer, /Remove-Item[^\r\n]+\$SkillDir[^\r\n]+-Recurse/);
  assert.doesNotMatch(installer, /Remove-Item[^\r\n]+(?:\.agents|skills)[^\r\n]+-Recurse/);
});

test("Windows installer stages all content and commits through a recoverable journal", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const recovery = topLevelFunction(installer, "Recover-InstallTransaction");
  const invoke = topLevelFunction(installer, "Invoke-InstallTransaction");
  const commit = topLevelFunction(installer, "Commit-InstallTransaction");
  const replaceFile = topLevelFunction(installer, "Replace-TransactionFile");
  const atomicWrite = topLevelFunction(installer, "Write-AtomicUtf8File");

  assert.match(installer, /\$TransactionJournal\s*=\s*Join-Path\s+\$HOME\s+["']\.legacy-code-atlas\.transaction\.json["']/);
  assert.match(loadTransaction, /legacy-code-atlas-transaction-v2/);
  assert.match(loadTransaction, /\^\[0-9a-fA-F\]\{32\}\$/);
  assert.match(loadTransaction, /\.PSObject\.Properties/);
  assert.match(loadTransaction, /Get-CanonicalPath/);
  for (const pathField of [
    "runtimeStage",
    "runtimeBackup",
    "skillTemp",
    "skillBackup",
    "legacyToolBackup",
    "legacyCommandBackup",
    "manifestTemp",
  ]) {
    assert.match(loadTransaction, new RegExp(`\\.${pathField}\\b`));
  }

  const recoveryCall = installer.indexOf("\nRecover-InstallTransaction\n");
  const manifestLoad = installer.indexOf("\n$existingManifest = Get-InstallManifest");
  assert.ok(recoveryCall >= 0, "installer never invokes startup transaction recovery");
  assert.ok(manifestLoad >= 0, "installer never loads its ownership manifest");
  assert.ok(recoveryCall < manifestLoad, "transaction recovery must run before manifest validation");
  assert.match(recovery, /Get-ContentHash[^\r\n]+\$OwnerMarker/);
  assert.match(recovery, /ManifestSha256/);
  assert.match(recovery, /Get-LegacyInstallTransaction/);
  assert.match(recovery, /Complete-LegacyInstallTransaction/);
  assert.match(recovery, /Rollback-LegacyInstallTransaction/);
  assertOrdered(recovery, ["Complete-InstallTransaction", "Rollback-InstallTransaction"]);

  assertOrdered(invoke, [
    "Assert-InstallTransactionPreflight",
    "Initialize-InstallTransactionManifest",
    "Write-TransactionJournal",
    "Prepare-InstallTransaction",
    "Commit-InstallTransaction",
  ]);
  assert.match(invoke, /catch\s*\{[\s\S]*Rollback-InstallTransaction/);

  assertOrdered(commit, [
    "Move-RuntimeIntoPlace",
    "Replace-SkillFile",
    "Backup-LegacyTool",
    "Backup-LegacyCommand",
    "Commit-ManifestFile",
  ]);
  assert.match(commit, /Assert-TransactionPathsSafe/);
  assert.match(replaceFile, /\[IO\.File\]::Replace/);
  assert.match(replaceFile, /Move-Item/);
  assert.match(atomicWrite, /\[IO\.FileStream\]/);
  assert.match(atomicWrite, /\.Flush\(\$true\)/);
  assert.match(atomicWrite, /\.Dispose\(\)/);

  assert.match(installer, /\.legacy-code-atlas\.stage-\$transactionId/);
  assert.match(installer, /\$OwnerMarker\s*\+\s*["']\.legacy-code-atlas-temp-\$transactionId["']/);
  assert.doesNotMatch(installer, /Copy-Item[^\r\n]+-Destination\s+(?:\$InstallDir|\$SkillTarget)\b/);
  assert.doesNotMatch(topLevelFunction(installer, "Prepare-InstallTransaction"), /legacy_atlas[.]ts|LegacyTool|ToolTemp/);
  assert.doesNotMatch(installer, /Set-Content[^\r\n]+\$OwnerMarker/);
});

test("Agent Skill is fully staged in a sibling directory before namespace publication", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const transactionPaths = topLevelFunction(installer, "Get-TransactionPaths");
  const transactionSafety = topLevelFunction(installer, "Assert-TransactionPathsSafe");
  const prepare = topLevelFunction(installer, "Prepare-InstallTransaction");
  const replaceSkill = topLevelFunction(installer, "Replace-SkillFile");
  const complete = topLevelFunction(installer, "Complete-InstallTransaction");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(
    transactionPaths,
    /SkillTemp\s*=\s*Get-CanonicalPath\s*\(\$SkillDir\s*\+\s*["']\.legacy-code-atlas-temp-\$transactionId["']\)/,
  );
  assert.doesNotMatch(transactionPaths, /SkillTemp[^\r\n]+\$SkillTarget\s*\+/);
  assert.match(
    transactionSafety,
    /Assert-NoReparsePointInPath[^\r\n]+Join-Path\s+\$Transaction\.SkillTemp\s+["']SKILL\.md["']/,
  );

  assertOrdered(prepare, [
    '$stagedSkillTarget = Join-Path $Transaction.SkillTemp "SKILL.md"',
    "New-Item -ItemType Directory -Path $Transaction.SkillTemp",
    "Copy-Item -LiteralPath $SkillSource -Destination $stagedSkillTarget",
    "Get-ContentHash $stagedSkillTarget",
  ]);
  assert.doesNotMatch(prepare, /New-Item[^\r\n]+-Path\s+\$SkillDir\b/);

  assert.match(replaceSkill, /-not\s+\$Transaction\.SkillDirectoryExisted/);
  assertOrdered(replaceSkill, [
    "Get-PathEntryWithoutFollowingTarget $SkillDir",
    "Assert-NoReparsePointTree $Transaction.SkillTemp",
    "Move-Item -LiteralPath $Transaction.SkillTemp -Destination $SkillDir",
  ]);
  assert.match(
    replaceSkill,
    /Replace-TransactionFile\s+-Temporary\s+\$stagedSkillTarget\s+-Target\s+\$SkillTarget/,
  );
  assert.match(replaceSkill, /Remove-AtlasTree\s+\$Transaction\.SkillTemp/);

  assert.match(complete, /@\([^)]*\$Transaction\.SkillTemp[^)]*\)/);
  assert.match(complete, /Remove-AtlasTree\s+\$tree/);
  assertOrdered(rollback, [
    "Get-PathEntryWithoutFollowingTarget $Transaction.SkillTemp",
    "Remove-AtlasTree $Transaction.SkillTemp",
  ]);
  for (const cleanup of [complete, rollback]) {
    assert.doesNotMatch(cleanup, /Remove-Item[^\r\n]+\$Transaction\.SkillTemp/);
  }
});

test("Windows installer uses only Windows PowerShell 5.1 syntax", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");

  assert.doesNotMatch(installer, /\?\?/);
  assert.doesNotMatch(installer, /\$[A-Za-z_][A-Za-z0-9_.]*\s*\?\s*[^\r\n:]+\s*:/);
  assert.doesNotMatch(installer, /ForEach-Object[^\r\n]+-Parallel/);
  assert.doesNotMatch(installer, /ConvertFrom-Json[^\r\n]+-AsHashtable/);
  assert.doesNotMatch(installer, /Get-Content[^\r\n]+-AsByteStream/);
  assert.doesNotMatch(installer, /Join-Path[^\r\n]+-AdditionalChildPath/);
  assert.doesNotMatch(installer, /utf8NoBOM/i);
});

test("Windows installer is offline, non-admin, and does not invoke a shell string", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");

  assert.doesNotMatch(installer, /Invoke-WebRequest|\biwr\b|\bcurl\b|git\s+clone/i);
  assert.doesNotMatch(installer, /Invoke-Expression|\biex\b|cmd\.exe|Start-Process[^\n]+RunAs/i);
  assert.match(installer, /Test-Path[^\n]+\.legacy-code-atlas-owner/);
});

test("Windows uninstaller leaves shared OpenCode directories in place", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");

  assert.doesNotMatch(installer, /Remove-EmptyParent/);
});

test("Windows uninstaller validates the entire private runtime tree before deleting owned files", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const uninstallStart = installer.indexOf("if ($Uninstall)");
  const installStart = installer.indexOf("$nodeCommand = Get-Command node", uninstallStart);
  assert.ok(uninstallStart >= 0 && installStart > uninstallStart, "missing uninstall block");
  const uninstall = installer.slice(uninstallStart, installStart);

  assertOrdered(uninstall, [
    "Assert-NoReparsePointTree $InstallDir",
    "foreach ($entry in $filesToRemove)",
  ]);
});

test("rollback releases only a newly created and hash-proven Skill namespace", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(rollback, /\$ownsCreatedSkillNamespace\s*=\s*\$false/);
  assert.match(rollback, /-not\s+\$Transaction\.SkillDirectoryExisted/);
  assert.match(
    rollback,
    /\$skillTargetHash\s*=\s*Get-ContentHash\s+\$SkillTarget[\s\S]*\$skillTargetHash\s+-eq\s+\$Transaction\.SkillSha256/,
  );
  assert.match(rollback, /Get-ChildItem[^\r\n]+\$SkillDir[^\r\n]+\.Count\s+-eq\s+0/);
  assertOrdered(rollback, [
    "Get-ContentHash $SkillTarget",
    "$ownsCreatedSkillNamespace = $true",
    "Restore-TransactionFile -Target $SkillTarget",
    "Remove-AtlasTree $Transaction.SkillTemp",
    "if ($ownsCreatedSkillNamespace)",
    "Get-PathEntryWithoutFollowingTarget $SkillDir",
    "Remove-Item -LiteralPath $SkillDir -Force",
  ]);
  assert.doesNotMatch(rollback, /Remove-Item[^\r\n]+\$SkillDir[^\r\n]+-Recurse/);
});
