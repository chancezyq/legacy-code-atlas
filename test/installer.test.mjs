import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Windows installer targets the Agent Skill and OpenCode tool", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");

  assert.match(installer, /\[switch\]\$Uninstall/);
  assert.match(installer, /\.legacy-code-atlas/);
  assert.match(installer, /OPENCODE_CONFIG_DIR/);
  assert.match(installer, /\.config[\\/]opencode/);
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
  assert.match(installer, /拒绝覆盖已有 (?:Agent Skill|OpenCode) 文件/);
  assert.doesNotMatch(installer, /SetEnvironmentVariable\("LEGACY_CODE_ATLAS_CLI", \$CliTarget/);
});

test("Windows installer validates v1 and v2 manifests and writes v2 owned files", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");

  assert.match(installer, /legacy-code-atlas-install-v1/);
  assert.match(installer, /legacy-code-atlas-install-v2/);
  assert.match(installer, /ConvertFrom-Json/);
  assert.match(installer, /owner\s*=\s*\$OwnerValueV2/);
  assert.match(installer, /version\s*=\s*2/);
  assert.match(installer, /ownedFiles\s*=/);
  assert.match(installer, /kind\s*=\s*["']agent-skill["']/);
  assert.match(installer, /kind\s*=\s*["']opencode-tool["']/);
  assert.match(installer, /path\s*=\s*Get-CanonicalPath\s+\$SkillTarget/);
  assert.match(installer, /path\s*=\s*Get-CanonicalPath\s+(?:\$ToolTarget|\$Transaction\.ToolTarget)/);
  assert.match(installer, /sha256\s*=\s*(?:Get-ContentHash|\$Transaction\.(?:Skill|Tool)Sha256)/);
  assert.match(installer, /@\(\$manifest\.ownedFiles\)/);
  assert.match(installer, /\.Count\s*-ne\s*2/);
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
  assert.match(loadManifest, /Test-ExactIntegerValue\s+-Value\s+\$version\s+-Expected\s+1/);
  assert.match(loadManifest, /Test-ExactIntegerValue\s+-Value\s+\$version\s+-Expected\s+2/);
  assert.doesNotMatch(loadManifest, /\[string\]\$manifest\.owner|\[int\]\$manifest\.version/);
  assert.doesNotMatch(loadManifest, /\$owner\s+-eq\s+\$OwnerValueV[12]/);
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

  for (const type of ["byte", "sbyte", "int16", "uint16", "int32", "uint32", "int64", "uint64"]) {
    assert.match(integerCheck, new RegExp(`\\[${type}\\]`, "i"));
  }
  assert.match(integerCheck, /-notcontains/);
  assert.match(integerCheck, /\[decimal\]\$Value\s*-eq\s*\[decimal\]\$Expected/);
  assert.match(loadTransaction, /Test-ExactIntegerValue[^\r\n]+\$transaction\.version[^\r\n]+1/);
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
  assert.match(preflight, /Assert-NoReparsePointTree\s+\$InstallDir/);
  assert.match(replaceSkill, /\$Transaction\.Mode\s+-ceq\s+["']fresh["']/);
  assert.match(replaceSkill, /\$Transaction\.Mode\s+-ceq\s+["']upgrade-v1["']/);
  assertOrdered(replaceSkill, [
    "Get-PathEntryWithoutFollowingTarget $SkillDir",
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

test("atomic replacement enforces the target existence observed at preflight", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const replaceFile = topLevelFunction(installer, "Replace-TransactionFile");
  const replaceSkill = topLevelFunction(installer, "Replace-SkillFile");
  const replaceTool = topLevelFunction(installer, "Replace-ToolFile");
  const commitManifest = topLevelFunction(installer, "Commit-ManifestFile");

  assert.match(replaceFile, /\[bool\]\$ExpectedExisted/);
  assert.match(replaceFile, /Get-PathEntryWithoutFollowingTarget/);
  assert.match(replaceFile, /target existence changed|\u76ee\u6807[^\r\n]*\u5b58\u5728\u72b6\u6001[^\r\n]*\u6539\u53d8/i);
  assert.match(replaceSkill, /-ExpectedExisted\s+\$Transaction\.SkillExisted/);
  assert.match(replaceTool, /-ExpectedExisted\s+\$Transaction\.ToolExisted/);
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
    "$ToolTarget",
    "$LegacyCommandTarget",
  ]) {
    assert.ok(targetGuard.includes(requiredPath), `reparse preflight omits ${requiredPath}`);
  }
  assert.match(targetGuard, /-Boundary\s+\(Get-CanonicalPath\s+\$HOME\)[^\r\n]+\$SkillTarget/);
  assert.match(targetGuard, /-Boundary\s+\$ConfigDir[^\r\n]+\$ToolTarget/);

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
  assert.match(loadTransaction, /legacy-code-atlas-transaction-v1/);
  assert.match(loadTransaction, /\^\[0-9a-fA-F\]\{32\}\$/);
  assert.match(loadTransaction, /\.PSObject\.Properties/);
  assert.match(loadTransaction, /Get-CanonicalPath/);
  for (const pathField of [
    "runtimeStage",
    "runtimeBackup",
    "skillTemp",
    "skillBackup",
    "toolTemp",
    "toolBackup",
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
    "Replace-ToolFile",
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
  assert.doesNotMatch(installer, /Copy-Item[^\r\n]+-Destination\s+(?:\$InstallDir|\$SkillTarget|\$ToolTarget)\b/);
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

  assert.match(replaceSkill, /Mode\s+-ceq\s+["']fresh["']/);
  assert.match(replaceSkill, /Mode\s+-ceq\s+["']upgrade-v1["']/);
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

test("fresh and v1 rollback release only a hash-proven published Skill namespace", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(rollback, /\$ownsCreatedSkillNamespace\s*=\s*\$false/);
  assert.match(
    rollback,
    /\$Transaction\.Mode\s+-ceq\s+["']fresh["'][\s\S]*\$Transaction\.Mode\s+-ceq\s+["']upgrade-v1["']/,
  );
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
