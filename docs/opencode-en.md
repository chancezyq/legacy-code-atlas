# OpenCode Installation and Recovery

English | [简体中文](opencode.md)

Legacy Code Atlas does not invoke a model directly. OpenCode remains the conversation layer and continues to use your company's configured model. After analysis, the Atlas Agent Skill routes normal questions to local custom tools.

Official OpenCode 1.14.49 or later provides the required interfaces. A company fork may have a different version number, but it must load user-level Agent Skills and support custom tools with plain JSON Schema parameters.

## Windows installation

Windows PowerShell 5.1 and Node.js 20 or later are required. Download and extract the source, open Windows PowerShell in the `legacy-code-atlas` directory, and run:

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer does not require administrator privileges, access the network, or run `npm install`. After it finishes, completely close OpenCode, enter the legacy project directory, and restart OpenCode there.

The current OpenCode tool uses Node.js standard modules to start the installed CLI and does not require a global `Bun` object. Node.js 20 or later, already checked by the installer, is sufficient.

The first message must be the command below with no argument or appended question:

```text
/understand
```

Wait for `legacy_atlas_analyze` to finish. Then send a separate normal message containing a business description, URL, iBATIS statement ID, SQL Server procedure, or table name. For example:

```text
Where is the refund approval feature implemented?
```

The Agent Skill routes normal messages to these tools:

- Business description: `legacy_atlas_trace_feature`
- URL: `legacy_atlas_trace_url`
- iBATIS statement: `legacy_atlas_trace_statement`
- SQL Server procedure: `legacy_atlas_trace_procedure`
- Database table: `legacy_atlas_trace_table`

After source changes, send `/understand` again as a message on its own and wait before sending the next normal question.

## Files written by the installer

The installer copies the dependency-free runtime, global Agent Skill, and OpenCode tool to:

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\understand\SKILL.md
%USERPROFILE%\.config\opencode\tools\legacy_atlas.ts
```

`%USERPROFILE%\.config\opencode` is the default tool configuration directory. If `OPENCODE_CONFIG_DIR` exists during the first installation, the tool is instead written to `%OPENCODE_CONFIG_DIR%\tools\legacy_atlas.ts`. The selected directory is stored as `configDir` in:

```text
%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json
```

Later updates and uninstallations use the saved `configDir`. Changing or removing `OPENCODE_CONFIG_DIR` does not migrate installed files. The Agent Skill always remains at `%USERPROFILE%\.agents\skills\understand\SKILL.md`.

The former Markdown command at `commands\understand.md` has been removed. Version 1 installations migrate to the Agent Skill and manifest v2 during the next successful update.

## Inspecting manifest v2

A valid ownership manifest has these properties:

- `owner` is `legacy-code-atlas-install-v2`.
- `version` is the number `2`.
- `installDir` is the current user's Atlas runtime directory.
- `configDir` is the OpenCode configuration directory selected during first installation.
- `ownedFiles` records exactly the `agent-skill` and `opencode-tool` entries with `kind`, `path`, and `sha256`.

Inspect the installed files by `kind` rather than relying on fields from older recovery formats:

```powershell
$ManifestPath = Join-Path $HOME ".legacy-code-atlas\.legacy-code-atlas-owner.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

$Manifest.owner
$Manifest.version
$Manifest.configDir
$Manifest.ownedFiles | Format-Table kind, path, sha256

$Skill = $Manifest.ownedFiles | Where-Object { $_.kind -ceq "agent-skill" }
$Tool = $Manifest.ownedFiles | Where-Object { $_.kind -ceq "opencode-tool" }
Test-Path -LiteralPath $Skill.path
Test-Path -LiteralPath $Tool.path
Test-Path -LiteralPath (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs")
```

The last three commands should return `True`. To verify SHA-256 values:

```powershell
(Get-FileHash -LiteralPath $Skill.path -Algorithm SHA256).Hash
$Skill.sha256
(Get-FileHash -LiteralPath $Tool.path -Algorithm SHA256).Hash
$Tool.sha256
```

Windows PowerShell prints uppercase hashes by default; compare them case-insensitively with the manifest. Check Node.js and the runtime separately:

```powershell
node --version
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") --help
```

Node.js must be version 20 or later. If the runtime works but `/understand` is missing, fully exit every OpenCode process and confirm that OpenCode and the installer use the same Windows account.

## Updates and modified files

Download and extract the new source, then run the installer from that new directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The update reuses the manifest's saved `configDir`. If an owned file's actual SHA-256 differs from its manifest value, the installer refuses to overwrite it.

When a conflict occurs:

1. Use the `ownedFiles` commands above to locate the exact Skill or tool path by `kind`.
2. Confirm where the file came from and what currently uses it. Back it up outside the Atlas runtime.
3. If it belongs to company configuration or another plugin, do not move or delete it. Preserve the evidence and ask the OpenCode administrator to resolve the namespace conflict.
4. Only handle that exact path after confirming it is an old Atlas file and that your backup can be restored. Either restore content matching the old manifest hash before updating, or uninstall first, allow the uninstaller to preserve the modified file, then verify and remove the residue before reinstalling.

Do not blindly delete the ownership manifest, `%USERPROFILE%\.agents\skills\understand`, the OpenCode `tools` directory, or the entire OpenCode configuration directory.

## Uninstall

Run this from any downloaded Atlas source directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Uninstall requires a valid ownership manifest. For the external Agent Skill and OpenCode tool, matching SHA-256 files are removed while modified files are preserved. Shared `.agents\skills` and OpenCode `tools` directories are not removed, and company projects are never removed.

`%USERPROFILE%\.legacy-code-atlas\` is the installer's private runtime directory. Uninstall always deletes that directory recursively, including added or modified files. Never use it for personal files or backups.

## Crash and transaction recovery

Installation first writes a transaction journal:

```text
%USERPROFILE%\.legacy-code-atlas.transaction.json
```

The runtime, Skill, tool, and manifest are staged before replacement. Existing targets receive transaction-ID backups. The ownership manifest acts as the commit marker.

If PowerShell or the computer stops during installation, preserve the journal, stage, and backup. The next `install.ps1` run performs recovery before reading the ownership manifest:

- If the commit marker matches the journal's manifest SHA-256, the install committed successfully; recovery removes the stage, backups, and journal.
- If it does not match, installation was incomplete; recovery restores the previous runtime, Skill, tool, and old command state.
- If a target changed after interruption, recovery refuses to overwrite or delete it and preserves the journal for investigation.

Do not manually delete the journal or transaction backups and do not repeatedly copy files over the targets. Save the full error and directory listings first, then restore only after verifying file ownership or provide the journal to a maintainer.

## Path safety and threat boundary

The installer validates canonical paths, ownership, SHA-256, reparse points, and transaction state, and repeats critical checks before replacement. These checks protect against normal misconfiguration, link redirection, and accidental replacement of unknown files.

Windows PowerShell 5.1 does not expose a reliable handle-relative filesystem API to scripts. Therefore, the installer cannot bind every operation to a previously opened parent-directory handle. A malicious process running as the same Windows account and concurrently replacing parent directories is outside the current threat model; do not claim that every time-of-check/time-of-use window is eliminated. Stop installation and isolate untrusted processes if this threat is suspected.

## Real-Windows release gate

Before a release, run this on real Windows using the built-in Windows PowerShell 5.1:

```powershell
npm run test:installer:windows
```

The release gate passes only with `50 pass` and `0 skip`. Non-Windows systems skip the real installer scenarios. Those runs are useful for development syntax checks but are not evidence that the Windows release gate passed.

## Large projects and sensitive data

For projects below 50,000 files and 2 million source lines, use `.legacy-code-atlasignore` to exclude backups, generated output, dependencies, and binary directories. Begin with a known module and validate known chains. Do not exclude Struts, iBATIS, or procedure source needed for tracing.

The analyzer reads source offline. It does not run Java, JSP, SQL, or procedures, and it does not connect to SQL Server. `.legacy-code-atlas/index.json` contains paths, symbols, call relationships, and SQL fragments. Treat it as sensitive source code and keep it only on company-approved devices and storage.

## Analysis limitations

- SQL Server procedure support includes `CREATE/ALTER PROCEDURE`, nested `EXEC`, table reads/writes, and calls from iBATIS `<procedure>` or static `CALL/EXEC` inside a generic `<statement>`. It never connects to a database or executes procedures.
- Struts 2 support includes namespace/action/method/result links, configured action extensions, `redirectAction`, JSP tag routes, and Spring bean IDs used as Action classes. Duplicate bean IDs, dynamic actions, and missing source still require review.
- Struts 1 Tiles forwards and Tiles definitions, inheritance, templates, and put pages across XML files produce explicit relationships.
- Java call analysis handles fields, local variables, no-argument return types on the current or parent class, and normalized overload signatures. Parameterized factories, complex chained calls, reflection, and dynamic objects can remain unresolved.
- JSP support covers native forms/links, common Struts 1 `html:*` tags, and Struts 2 `s:*` form/link/url tags. Dynamic actions, namespaces, EL/OGNL, and JavaScript-built URLs require manual inspection.
- Dynamic URLs, reflection, and missing source may require OpenCode to inspect Atlas-referenced files with `read`, `grep`, or `glob`. Do not infer a specific route from a dynamic JSP URL without source evidence.

Do not add undocumented performance, cache, or incremental-scan parameters to OpenCode messages. `/understand` and the CLI manage the cache automatically at `.legacy-code-atlas\cache.json` inside the analyzed project.
