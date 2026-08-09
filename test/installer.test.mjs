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

test("v1 and v2 tools are retired through journal v3 while journal v2 remains recoverable", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const writeJournal = topLevelFunction(installer, "Write-TransactionJournal");
  const retireTool = topLevelFunction(installer, "Backup-LegacyTool");
  const publishedValidation = topLevelFunction(installer, "Assert-PublishedIntegrationFiles");
  const commit = topLevelFunction(installer, "Commit-InstallTransaction");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(installer, /\$PreviousTransactionOwnerValue\s*=\s*["']legacy-code-atlas-transaction-v2["']/);
  assert.match(installer, /\$TransactionOwnerValue\s*=\s*["']legacy-code-atlas-transaction-v3["']/);
  assert.match(loadTransaction, /\$PreviousTransactionOwnerValue/);
  assert.match(loadTransaction, /\$TransactionOwnerValue/);
  assert.match(loadTransaction, /upgrade-v1/);
  assert.match(loadTransaction, /upgrade-v2/);
  assert.match(loadTransaction, /update-v3/);
  assert.match(writeJournal, /version\s*=\s*3/);
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

test("uninstall removes only the empty directory of the exact owned Skill", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const uninstallStart = installer.indexOf("if ($Uninstall)");
  const installStart = installer.indexOf("$nodeCommand = Get-Command node", uninstallStart);
  assert.ok(uninstallStart >= 0 && installStart > uninstallStart, "missing uninstall block");
  const uninstall = installer.slice(uninstallStart, installStart);

  assertOrdered(uninstall, [
    'if ($entry.Kind -ceq "agent-skill")',
    "Remove-Item -LiteralPath $entry.Path -Force",
    "Split-Path -Parent $entry.Path",
    "Get-PathEntryWithoutFollowingTarget $ownedSkillDirectory",
    "Get-ChildItem -LiteralPath $ownedSkillDirectory -Force",
    "Remove-Item -LiteralPath $ownedSkillDirectory -Force",
  ]);
  assert.match(uninstall, /PSIsContainer/);
  assert.match(uninstall, /ReparsePoint/);
  assert.doesNotMatch(
    uninstall,
    /^\s*Assert-TargetPathsSafe\s*$/m,
    "uninstall must not validate the unowned current atlas namespace",
  );
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
  assert.match(installer, /\$SkillDir\s*=\s*Join-Path\s+\$HOME\s+["']\.agents\\skills\\atlas["']/);
  assert.match(installer, /\$SkillTarget\s*=\s*Join-Path\s+\$SkillDir\s+["']SKILL\.md["']/);
  assert.match(installer, /tools[\\/]legacy_atlas\.ts/);
  assert.match(installer, /integrations[\\/]opencode[\\/]skills[\\/]atlas[\\/]SKILL\.md/);
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
    new URL("../integrations/opencode/skills/atlas/SKILL.md", import.meta.url),
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
  assert.ok(
    skillValidation.includes('node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" analyze "$PWD" --main-thread'),
    "installer must require the OpenCode main-thread compatibility command",
  );
  assert.match(skillValidation, /overview/);
  assert.ok(
    skillValidation.includes('node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" docs "$PWD"'),
    "installer must require the fixed docs generation command",
  );
  assert.ok(
    skillValidation.includes('node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" docs "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok'),
    "installer must require the fixed scoped docs command",
  );
  assert.ok(
    skillValidation.includes('node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" technical-doc prepare "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt"'),
    "installer must require the fixed technical document preparation command",
  );
  assert.ok(
    skillValidation.includes('node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" technical-doc validate "$PWD" --query-file "$PWD/.legacy-code-atlas/query.txt"'),
    "installer must require the fixed technical document validation command",
  );
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

test("preflight blocks an orphaned pre-rename Atlas Skill without claiming unrelated understand content", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const collisionGuard = topLevelFunction(installer, "Assert-NoUnownedLegacyIntegrationFiles");

  assert.match(
    collisionGuard,
    /Get-PathEntryWithoutFollowingTarget\s+\$LegacySkillTarget/,
  );
  assert.match(
    collisionGuard,
    /Test-ManifestOwnsExternalPath[\s\S]*?-Kind\s+["']agent-skill["'][\s\S]*?-Path\s+\$LegacySkillTarget/,
  );
  assert.match(
    collisionGuard,
    /Get-Content\s+-LiteralPath\s+\$LegacySkillTarget[\s\S]*?-Encoding\s+Byte[\s\S]*?-TotalCount\s+1048576[\s\S]*?-ReadCount\s+0/,
  );
  assert.match(
    collisionGuard,
    /\[Text[.]Encoding\]::UTF8[.]GetString\(\$legacySkillBytes\)/,
  );
  assert.match(collisionGuard, /[.]legacy-code-atlas\/bin\/legacy-code-atlas[.]mjs/);
  assert.match(collisionGuard, /legacy_atlas_/);
  assert.match(
    collisionGuard,
    /if\s*\(\$hasLegacyAtlasSignature\)\s*\{[\s\S]*?Get-ContentHash\s+\$LegacySkillTarget[\s\S]*?无有效 ownership manifest[\s\S]*?保留文件并停止/,
  );
  assert.doesNotMatch(collisionGuard, /Remove-Item/);
});

test("preflight preserves an unowned understand junction without weakening owned path guards", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const collisionGuard = topLevelFunction(installer, "Assert-NoUnownedLegacyIntegrationFiles");
  const transactionGuard = topLevelFunction(installer, "Assert-TransactionPathsSafe");

  assert.match(
    collisionGuard,
    /Get-PathEntryWithoutFollowingTarget\s+\$LegacySkillDir/,
  );
  assert.match(
    collisionGuard,
    /\$legacySkillDirectoryEntry[\s\S]*?Attributes[\s\S]*?\[IO[.]FileAttributes\]::ReparsePoint/,
  );
  assert.match(
    collisionGuard,
    /不属于[^\r\n]*Atlas[^\r\n]*ownership manifest[^\r\n]*\/understand[^\r\n]*(?:重解析点|reparse point)[^\r\n]*不在[^\r\n]*Atlas[^\r\n]*管理范围[^\r\n]*保留[^\r\n]*跳过/iu,
  );
  assert.doesNotMatch(collisionGuard, /按第三方|视为第三方/iu);
  assert.doesNotMatch(collisionGuard, /Remove-Item/);
  assert.match(
    transactionGuard,
    /if\s*\(\$Transaction[.]LegacySkillSha256[.]Length\s*-gt\s*0\)[\s\S]*?Assert-NoReparsePointInPath[^\r\n]*\$Transaction[.]LegacySkillTarget/,
  );
});

test("transaction snapshot checks an owned legacy Skill directory before its child", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const newTransaction = topLevelFunction(installer, "New-InstallTransaction");

  assert.match(
    newTransaction,
    /if\s*\(\$legacySkillSha256[.]Length\s+-gt\s+0\)\s*\{[\s\S]*?Assert-NoReparsePointInPath[^\n]*\$paths[.]LegacySkillTarget/,
  );
  assert.ok(
    newTransaction.indexOf("Assert-NoReparsePointInPath -Boundary $homeFull -Path $paths.LegacySkillTarget")
      < newTransaction.indexOf("Get-PathEntryWithoutFollowingTarget $paths.LegacySkillTarget"),
  );
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

test("pre-rename v2 and v3 understand Skills migrate through the recoverable transaction", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadManifest = topLevelFunction(installer, "Get-InstallManifest");
  const transactionPaths = topLevelFunction(installer, "Get-TransactionPaths");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const writeJournal = topLevelFunction(installer, "Write-TransactionJournal");
  const backupLegacySkill = topLevelFunction(installer, "Backup-LegacySkill");
  const preflight = topLevelFunction(installer, "Assert-InstallTransactionPreflight");
  const commit = topLevelFunction(installer, "Commit-InstallTransaction");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(installer, /\$LegacySkillDir\s*=\s*Join-Path\s+\$HOME\s+["']\.agents\\skills\\understand["']/);
  assert.match(installer, /\$LegacySkillTarget\s*=\s*Join-Path\s+\$LegacySkillDir\s+["']SKILL[.]md["']/);
  assert.match(loadManifest, /Test-SamePath\s+\$path\s+\$LegacySkillTarget/);
  assert.match(loadManifest, /Test-SamePath\s+\$path\s+\$SkillTarget/);
  assert.match(transactionPaths, /LegacySkillBackup/);
  assert.match(installer, /legacy-code-atlas-transaction-v2/);
  assert.match(installer, /legacy-code-atlas-transaction-v3/);
  assert.match(writeJournal, /version\s*=\s*3/);
  assert.match(writeJournal, /legacySkillSha256/);
  assert.match(writeJournal, /legacySkillExisted/);
  assert.match(writeJournal, /legacySkillBackup/);
  assertOrdered(backupLegacySkill, [
    "Get-PathEntryWithoutFollowingTarget $Transaction.LegacySkillTarget",
    "Get-ContentHash $Transaction.LegacySkillTarget",
    "Move-Item -LiteralPath $Transaction.LegacySkillTarget -Destination $Transaction.LegacySkillBackup",
  ]);
  assert.match(backupLegacySkill, /\$Transaction[.]LegacySkillSha256/);
  assert.match(preflight, /Test-ManifestOwnsExternalPath[\s\S]*-Kind\s+["']agent-skill["'][\s\S]*-Path\s+\$SkillTarget/);
  assertOrdered(commit, ["Replace-SkillFile", "Backup-LegacySkill", "Commit-ManifestFile"]);
  assertOrdered(rollback, [
    "Restore-LegacyOwnedFile",
    "-Target $Transaction.LegacySkillTarget",
    "-Backup $Transaction.LegacySkillBackup",
  ]);
});

test("transaction-v1 and transaction-v2 recovery recognize only the two released Skill namespaces", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const legacyPaths = topLevelFunction(installer, "Get-LegacyTransactionPaths");
  const loadLegacy = topLevelFunction(installer, "Get-LegacyInstallTransaction");
  const transactionPaths = topLevelFunction(installer, "Get-TransactionPaths");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const legacySafety = topLevelFunction(installer, "Assert-LegacyTransactionPathsSafe");
  const transactionSafety = topLevelFunction(installer, "Assert-TransactionPathsSafe");
  const legacyRollback = topLevelFunction(installer, "Rollback-LegacyInstallTransaction");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  for (const pathBuilder of [legacyPaths, transactionPaths]) {
    assert.match(pathBuilder, /\[string\]\$SkillDirectory/);
    assert.match(pathBuilder, /\[string\]\$SkillFile/);
    assert.match(pathBuilder, /SkillDir\s*=\s*Get-CanonicalPath\s+\$SkillDirectory/);
    assert.match(pathBuilder, /SkillTarget\s*=\s*Get-CanonicalPath\s+\$SkillFile/);
  }
  for (const loader of [loadLegacy, loadTransaction]) {
    assert.match(loader, /-SkillDirectory\s+\$SkillDir/);
    assert.match(loader, /-SkillFile\s+\$SkillTarget/);
    assert.match(loader, /-SkillDirectory\s+\$LegacySkillDir/);
    assert.match(loader, /-SkillFile\s+\$LegacySkillTarget/);
    assert.match(loader, /包含任意或非推导路径/);
    assert.match(loader, /SkillDir\s*=\s*\$paths[.]SkillDir/);
    assert.match(loader, /SkillTarget\s*=\s*\$paths[.]SkillTarget/);
  }
  assert.match(legacySafety, /\$Transaction[.]SkillTarget/);
  assert.match(transactionSafety, /\$Transaction[.]SkillTarget/);
  assert.match(legacyRollback, /-Target\s+\$Transaction[.]SkillTarget/);
  assert.match(rollback, /-Target\s+\$Transaction[.]SkillTarget/);
  assert.match(legacyRollback, /Get-PathEntryWithoutFollowingTarget\s+\$Transaction[.]SkillDir/);
  assert.match(rollback, /Get-PathEntryWithoutFollowingTarget\s+\$Transaction[.]SkillDir/);
});

test("uninstall cleans the exact owned Skill namespace instead of assuming atlas", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const uninstallStart = installer.indexOf("if ($Uninstall)");
  const installStart = installer.indexOf("$nodeCommand = Get-Command node", uninstallStart);
  assert.ok(uninstallStart >= 0 && installStart > uninstallStart, "missing uninstall block");
  const uninstall = installer.slice(uninstallStart, installStart);

  assert.match(uninstall, /Split-Path\s+-Parent\s+\$entry[.]Path/);
  assert.match(uninstall, /Get-PathEntryWithoutFollowingTarget\s+\$ownedSkillDirectory/);
  assert.match(uninstall, /Get-ChildItem\s+-LiteralPath\s+\$ownedSkillDirectory\s+-Force/);
  assert.match(uninstall, /Remove-Item\s+-LiteralPath\s+\$ownedSkillDirectory\s+-Force/);
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
  assert.match(loadTransaction, /Test-ExactIntegerValue[^\r\n]+\$versionProperty\.Value[^\r\n]+2/);
  assert.match(loadTransaction, /Test-ExactIntegerValue[^\r\n]+\$versionProperty\.Value[^\r\n]+3/);
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
    "fresh installs and v1 upgrades must reject any pre-existing atlas Skill directory",
  );
  for (const collisionGuard of [preflight, replaceSkill]) {
    assert.match(collisionGuard, /两个\s*Skill/);
    assert.match(collisionGuard, /不能[^\r\n]*同一个?\s*\/atlas\s+namespace/);
    assert.match(collisionGuard, /不会[^\r\n]*覆盖[^\r\n]*删除/);
    assert.match(collisionGuard, /先备份[^\r\n]*来源插件[^\r\n]*(?:卸载|禁用)/);
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

test("transaction v3 rechecks the previous Skill hash at the final replacement boundary", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const writeJournal = topLevelFunction(installer, "Write-TransactionJournal");
  const newTransaction = topLevelFunction(installer, "New-InstallTransaction");
  const replaceFile = topLevelFunction(installer, "Replace-TransactionFile");
  const replaceSkill = topLevelFunction(installer, "Replace-SkillFile");

  assert.match(writeJournal, /previousSkillSha256\s*=\s*\$Transaction\.PreviousSkillSha256/);
  assert.match(loadTransaction, /["']previousSkillSha256["']/);
  assert.match(loadTransaction, /PreviousSkillSha256\s*=\s*\$previousSkillSha256\.ToUpperInvariant\(\)/);
  assert.match(newTransaction, /PreviousSkillSha256\s*=\s*\$previousSkillSha256/);
  assert.match(replaceFile, /\[string\]\$ExpectedCurrentSha256/);
  assertOrdered(replaceFile, [
    "$targetExists -ne $ExpectedExisted",
    "if ($targetExists -and $ExpectedCurrentSha256.Length -gt 0)",
    "(Get-ContentHash $Target) -ne $ExpectedCurrentSha256",
    'throw "Agent Skill 内容在预检后已改变，拒绝覆盖',
    "[IO.File]::Replace",
  ]);
  assert.match(
    replaceSkill,
    /-ExpectedCurrentSha256\s+\$Transaction\.PreviousSkillSha256/,
  );
});

test("transaction v3 rollback verifies SkillBackup before replacing the current Skill", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const restoreFile = topLevelFunction(installer, "Restore-TransactionFile");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(restoreFile, /\[string\]\$ExpectedBackupSha256\s*=\s*["']["']/);
  assert.match(
    restoreFile,
    /\$PSBoundParameters[.]ContainsKey\(["']ExpectedBackupSha256["']\)/,
  );
  assertOrdered(restoreFile, [
    "Get-PathEntryWithoutFollowingTarget $Backup",
    "if (-not $Existed)",
    'throw "回滚时出现不应存在的事务 backup，拒绝恢复',
    "Get-ContentHash $Backup",
    'throw "回滚时事务 backup 已被修改，拒绝恢复',
    "Get-PathEntryWithoutFollowingTarget $Target",
    "Remove-Item -LiteralPath $Target -Force",
    "Move-Item -LiteralPath $Backup -Destination $Target",
  ]);
  assert.match(
    rollback,
    /if\s*\(\$Transaction[.]Version\s+-eq\s+3\)\s*\{[\s\S]*?Restore-TransactionFile\s+-Target\s+\$Transaction[.]SkillTarget[\s\S]*?-ExpectedBackupSha256\s+\$Transaction[.]PreviousSkillSha256[\s\S]*?\}\s*else\s*\{[\s\S]*?Restore-TransactionFile\s+-Target\s+\$Transaction[.]SkillTarget/,
  );
});

test("transaction v3 rollback requires the untouched old Skill when SkillBackup is missing", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const restoreFile = topLevelFunction(installer, "Restore-TransactionFile");

  assert.match(
    restoreFile,
    /elseif\s*\(\$PSBoundParameters[.]ContainsKey\(["']ExpectedBackupSha256["']\)\s+-and\s+\$Existed\)\s*\{\s*\$targetEntry\s*=\s*Get-PathEntryWithoutFollowingTarget\s+\$Target[\s\S]*?\$null\s+-eq\s+\$targetEntry[\s\S]*?Get-ContentHash\s+\$Target[\s\S]*?-ne\s+\$ExpectedBackupSha256[\s\S]*?throw\s+["']回滚时事务 backup 缺失且原目标无法证明未被替换，拒绝继续/,
  );
});

test("same-process rollback distinguishes a rejected Skill update from an interrupted replacement", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const loadTransaction = topLevelFunction(installer, "Get-InstallTransaction");
  const newTransaction = topLevelFunction(installer, "New-InstallTransaction");
  const replaceFile = topLevelFunction(installer, "Replace-TransactionFile");
  const replaceSkill = topLevelFunction(installer, "Replace-SkillFile");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(loadTransaction, /SkillMutationStarted\s*=\s*\$true/);
  assert.match(newTransaction, /SkillMutationStarted\s*=\s*\$false/);
  assert.match(replaceFile, /\[psobject\]\$MutationState/);
  assertOrdered(replaceFile, [
    "(Get-ContentHash $Target) -ne $ExpectedCurrentSha256",
    'throw "Agent Skill 内容在预检后已改变，拒绝覆盖',
    "$MutationState.SkillMutationStarted = $true",
    "[IO.File]::Replace",
  ]);
  assert.match(
    replaceSkill,
    /Replace-TransactionFile[^\r\n]+-MutationState\s+\$Transaction/,
  );
  assertOrdered(replaceSkill, [
    "$Transaction.SkillMutationStarted = $true",
    "Move-Item -LiteralPath $Transaction.SkillTemp -Destination $SkillDir",
  ]);
  assertOrdered(rollback, [
    "if (-not $Transaction.SkillMutationStarted)",
    "Get-PathEntryWithoutFollowingTarget $Transaction.SkillBackup",
    'throw "Skill 变更尚未开始但出现事务 backup，拒绝继续回滚',
    "elseif ($Transaction.Version -eq 3)",
    "Restore-TransactionFile -Target $Transaction.SkillTarget",
  ]);
});

test("transaction v3 cleanup verifies SkillBackup while transaction v2 keeps its recovery path", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const complete = topLevelFunction(installer, "Complete-InstallTransaction");
  const removeVerifiedBackup = topLevelFunction(installer, "Remove-VerifiedLegacyBackup");

  assertOrdered(removeVerifiedBackup, [
    "Get-PathEntryWithoutFollowingTarget $Backup",
    "Get-ContentHash $Backup",
    'throw "legacy backup ownership 校验失败，拒绝删除',
    "Remove-Item -LiteralPath $Backup -Force",
  ]);
  assert.match(
    complete,
    /if\s*\(\$Transaction[.]Version\s+-eq\s+3\)[\s\S]*?Remove-VerifiedLegacyBackup[\s\S]*?-Backup\s+\$Transaction[.]SkillBackup[\s\S]*?-ExpectedExisted\s+\$Transaction[.]SkillExisted[\s\S]*?-ExpectedSha256\s+\$Transaction[.]PreviousSkillSha256[\s\S]*?else\s*\{[\s\S]*?Remove-Item\s+-LiteralPath\s+\$Transaction[.]SkillBackup\s+-Force/,
  );
  assert.match(
    complete,
    /-ExpectedSha256\s+\$Transaction[.]PreviousSkillSha256\s*\r?\n\s*\}\s*catch\s*\{[\s\S]*?\$cleanupFailed\s*=\s*\$true/,
  );
  assertOrdered(complete, [
    "-ExpectedSha256 $Transaction.PreviousSkillSha256",
    "if ($cleanupFailed)",
    "$TransactionJournal",
  ]);
});

test("rollback never overwrites a target modified after an interrupted replacement", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const restoreFile = topLevelFunction(installer, "Restore-TransactionFile");

  assertOrdered(restoreFile, [
    "Get-PathEntryWithoutFollowingTarget $Backup",
    "Get-PathEntryWithoutFollowingTarget $Target",
    "Get-ContentHash $Target",
    "-ne $ExpectedNewSha256",
    'throw "回滚时目标在安装中断后已被修改，拒绝覆盖',
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
  assert.match(installer, /legacy-code-atlas-transaction-v2/);
  assert.match(installer, /legacy-code-atlas-transaction-v3/);
  assert.match(loadTransaction, /\^\[0-9a-fA-F\]\{32\}\$/);
  assert.match(loadTransaction, /\.PSObject\.Properties/);
  assert.match(loadTransaction, /Get-CanonicalPath/);
  for (const pathField of [
    "runtimeStage",
    "runtimeBackup",
    "skillTemp",
    "skillBackup",
    "legacySkillBackup",
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
    "Backup-LegacySkill",
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
    /SkillTemp\s*=\s*Get-CanonicalPath\s*\(\$SkillDirectory\s*\+\s*["']\.legacy-code-atlas-temp-\$transactionId["']\)/,
  );
  assert.doesNotMatch(transactionPaths, /SkillTemp[^\r\n]+\$SkillFile\s*\+/);
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

test("Windows uninstaller rechecks an owned file hash immediately before deletion", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const uninstallStart = installer.indexOf("if ($Uninstall)");
  const installStart = installer.indexOf("$nodeCommand = Get-Command node", uninstallStart);
  assert.ok(uninstallStart >= 0 && installStart > uninstallStart, "missing uninstall block");
  const uninstall = installer.slice(uninstallStart, installStart);
  const removalStart = uninstall.indexOf("foreach ($entry in $filesToRemove)");
  assert.ok(removalStart >= 0, "missing owned-file removal loop");
  const removal = uninstall.slice(removalStart);

  assertOrdered(removal, [
    "Get-PathEntryWithoutFollowingTarget $entry.Path",
    "$finalHash = Get-ContentHash $entry.Path",
    "$finalHash -ne $entry.Sha256",
    'Write-Warning "文件在卸载删除前已被修改，保留',
    "Remove-Item -LiteralPath $entry.Path -Force",
  ]);
  assert.match(
    removal,
    /Write-Warning\s+["']文件在卸载删除前已被修改，保留[^\r\n]*\r?\n\s*continue\r?\n\s*}\r?\n\s*Remove-Item\s+-LiteralPath\s+\$entry[.]Path\s+-Force/,
  );
});

test("rollback releases only a newly created and hash-proven Skill namespace", async () => {
  const installer = await readFile(new URL("../install.ps1", import.meta.url), "utf8");
  const rollback = topLevelFunction(installer, "Rollback-InstallTransaction");

  assert.match(rollback, /\$ownsCreatedSkillNamespace\s*=\s*\$false/);
  assert.match(rollback, /-not\s+\$Transaction\.SkillDirectoryExisted/);
  assert.match(
    rollback,
    /\$skillTargetHash\s*=\s*Get-ContentHash\s+\$Transaction\.SkillTarget[\s\S]*\$skillTargetHash\s+-eq\s+\$Transaction\.SkillSha256/,
  );
  assert.match(rollback, /Get-ChildItem[^\r\n]+\$Transaction\.SkillDir[^\r\n]+\.Count\s+-eq\s+0/);
  assertOrdered(rollback, [
    "Get-ContentHash $Transaction.SkillTarget",
    "$ownsCreatedSkillNamespace = $true",
    "Restore-TransactionFile -Target $Transaction.SkillTarget",
    "Remove-AtlasTree $Transaction.SkillTemp",
    "if ($ownsCreatedSkillNamespace)",
    "Get-PathEntryWithoutFollowingTarget $Transaction.SkillDir",
    "Remove-Item -LiteralPath $Transaction.SkillDir -Force",
  ]);
  assert.doesNotMatch(rollback, /Remove-Item[^\r\n]+\$Transaction\.SkillDir[^\r\n]+-Recurse/);
});
