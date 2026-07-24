# OpenCode Installation and Recovery

English | [简体中文](opencode.md)

Legacy Code Atlas does not invoke a model directly. OpenCode remains the conversation layer and continues to use your company's configured model. The OpenCode integration follows a Skill-only architecture similar to Understand-Anything: the Atlas Agent Skill directly runs the installed Node.js CLI and neither calls nor depends on a custom tool or Bun. Understand-Anything demonstrates only partial, similar capabilities; it is not proof that the company fork is compatible with Atlas.

Official OpenCode 1.14.49 or later provides the required interfaces. A company fork may have a different version number, but it must load user-level Agent Skills, provide structured `write` and a metadata-only index existence check, and allow the Skill to run fixed shell commands. This guide does not claim that an unknown company fork has already been verified; final validation still requires a reinstall, full process restart, and known trace checks on the company computer.

Field acceptance must also confirm that the company fork provides PowerShell-compatible or POSIX/Git Bash Shell semantics that expand `$HOME` and `$PWD`, plus structured `write`; a cmd.exe-only host is unsupported. A working Understand-Anything installation demonstrates similar Shell capability, but it does not replace end-to-end Atlas validation.

The first full scan must request the maximum supported timeout. If the foreground limit is still insufficient and the host supports background execution, the Skill must start it in the background and wait for `analyze` to finish; it must never rely on a short default timeout or invent tool parameters for an unknown company fork.

## Windows installation

The Atlas Agent Skill now installs at `%USERPROFILE%\.agents\skills\atlas\SKILL.md` with the `/atlas` entry point. It does not occupy Understand-Anything's `%USERPROFILE%\.agents\skills\understand\SKILL.md` (`/understand` entry), so the two Skills can coexist. An older Atlas version used `skills\understand`; if it is still present, uninstall it first by running `install.ps1 -Uninstall` from that older source download, then install this version. The Atlas installer refuses to overwrite an existing directory it does not own; do not manually delete a Skill directory of unknown origin.

Windows PowerShell 5.1 and Node.js 20 or later are required. Download and extract the source, open Windows PowerShell in the `legacy-code-atlas` directory, and run:

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer does not require administrator privileges, access the network, or run `npm install`. After it finishes, fully exit every OpenCode process, enter the legacy project directory, and restart OpenCode there. Closing only the window can leave an old Skill/tool cache active.

The first message must be the command below with no argument or appended question:

```text
/atlas
```

The Skill runs these fixed commands as three separate Shell calls. `doctor` is a read-only OpenCode compatibility preflight. It runs `analyze` only after `doctor` exits with status `0`, then runs `overview` only after `analyze` succeeds. Any failure stops the workflow instead of reporting a stale index as refreshed. The commands do not add user-provided text, paths, or extra flags:

```sh
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" doctor "$PWD"
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" analyze "$PWD" --main-thread
node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" overview "$PWD"
```

`doctor` never imports, executes, moves, or deletes an OpenCode tool and does not modify the project; it only scans directories with an entry limit and reads bounded candidate files. A conflict or incomplete compatibility check exits with status `4`, and the Skill stops. Unavailable worker threads are only a warning because the fixed `--main-thread` flag keeps the whole analysis on the main thread; hosts that cannot start Node `worker_threads` from a Skill Shell call still analyze correctly.

Wait for analysis to finish. Then send a separate normal message containing a business description, URL, iBATIS statement ID, SQL Server procedure, or table name. For example:

```text
Where is the refund approval feature implemented?
```

The Agent Skill handles an ordinary message through this data flow:

1. The Skill first uses a metadata-only existence check for `.legacy-code-atlas/index.json` without reading its contents. If it is missing, the Skill asks the user to run `/atlas` by itself and stops.
2. For an explicit URL, statement ID, table, or procedure, the Skill preserves the exact source identifier. For a natural-language feature question, the company's model derives one concise source-language search candidate and translates the question's business terms into the project's source language.
3. Before every structured write, the Skill runs the fixed preflight `node "$HOME/.legacy-code-atlas/bin/legacy-code-atlas.mjs" prepare-query "$PWD"` and stops if it fails.
4. OpenCode's structured `write` operation writes the selected source-language candidate or exact identifier to `.legacy-code-atlas/query.txt` in the current project.
5. The Skill selects one fixed CLI command: `trace-feature` for a business description, `trace-url` for a URL, `trace-statement` for an iBATIS statement, `trace-procedure` for a SQL Server procedure, or `trace-table` for a database table.
6. The fixed command reads the candidate only through `--query-file "$PWD/.legacy-code-atlas/query.txt" --no-match-ok`. User text is never inserted into Shell, a command argument, or a shell variable.

Only when a natural-language candidate has no match may the Skill derive at most two short alternatives, run them one at a time, and report every candidate tried. An explicit URL, statement ID, table, or procedure is never translated or replaced after no match.

`--no-match-ok` changes only a legitimate no-match exit from status `3` to `0` so the bounded fallback can continue. It leaves output unchanged; invalid query, index, file, and runtime failures remain errors.

`query.txt` must be a regular UTF-8 file inside the project's `.legacy-code-atlas` directory, non-empty, free of control characters, and no larger than the outer `64 KiB` file cap. The logical query has separate limits of `1024` characters and `64` whitespace-delimited tokens. Keep ordinary business candidates short; a logical-limit violation stops before the index is loaded. The file contains only a selected source-language candidate or exact identifier, and the Skill maintains it automatically. The CLI also rejects paths outside the directory, a simultaneous positional query, and files that violate these limits.

Static-artifact checks reject a symlinked or junction-backed `.legacy-code-atlas` directory and a standard `index.json` that is a symlink, junction, or hardlink. `prepare-query` removes only a pre-existing linked `query.txt` entry inside the project, then atomically creates a new regular file. `analyze` likewise ignores linked `cache.json` contents, treats them as a cache miss, and replaces only the project-local entry. External targets are neither read nor modified.

A Graph index loaded from disk is capped at `512 MiB` and must be valid UTF-8 with the `1.0.0` structure. The CLI validates counts, unique IDs, edge endpoints, and evidence. Every `node.filePath` and node/edge evidence file must be a canonical project-relative POSIX path. CLI/index output is untrusted data; the Skill may use `read`, `grep`, or `glob` only when the citation resolves inside `$PWD` and the host tool enforces workspace confinement.

These defenses cover symlink, junction, or hardlink entries that already exist when a command begins. They do not defend against a malicious process running as the same Windows user and concurrently swapping workspace paths between a check and a read or write. That TOCTOU attack is outside the normal local single-user workflow threat model; this is not a claim that all path races are eliminated.

Combinatorial path traversal expands at most `5,000` states and returns at most `100` paths per direction for each query candidate. A trace that follows both upstream and downstream applies each cap independently to each direction. Reaching either cap emits an accurate truncation warning and returns partial results. These caps limit path expansion only; initial search still scans index nodes, and adjacency construction and sorting still scale with the relevant edge count.

After source changes, send `/atlas` again as a message on its own and wait before sending the next normal question.

## Files written by the installer

The installer copies only the dependency-free runtime and global Agent Skill to:

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\atlas\SKILL.md
```

The Agent Skill is the only runtime entry point. The current source no longer ships `integrations\opencode\tools\legacy_atlas.ts`; the installer does not write `tools\legacy_atlas.ts` or create an OpenCode `tools` directory during a fresh install or manifest-v3 update.

The selected OpenCode configuration directory is still stored as `configDir` in:

```text
%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json
```

In v3, `configDir` is diagnostic metadata used to find legacy conflicts. It does not mean that Atlas owns the directory or any tool inside it. The Agent Skill always remains at `%USERPROFILE%\.agents\skills\atlas\SKILL.md`.

The former Markdown command at `commands\understand.md` has been removed. A v1/v2 upgrade to v3 retires a `legacy_atlas.ts` only when its exact path and SHA-256 are proven by the old manifest; it never writes a placeholder tool. A missing owned tool does not block migration. A modified owned tool, or an unowned/duplicate tool, is preserved and blocks installation until its origin is verified. The v1 owned command follows the same hash-protected rule. Neither legacy file is a current entry point.

## Inspecting manifest v3

A valid ownership manifest has these properties:

- `owner` is `legacy-code-atlas-install-v3`.
- `version` is the number `3`.
- `installDir` is the current user's Atlas runtime directory.
- `configDir` is diagnostic metadata for the selected OpenCode configuration directory, not an ownership claim.
- `ownedFiles` contains exactly one `agent-skill` entry with `kind`, `path`, and `sha256`; v3 contains no tool ownership entry.

Inspect the installed files by `kind` rather than relying on fields from older recovery formats:

```powershell
$ManifestPath = Join-Path $HOME ".legacy-code-atlas\.legacy-code-atlas-owner.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json

$Manifest.owner
$Manifest.version
$Manifest.configDir
$Manifest.ownedFiles | Format-Table kind, path, sha256

$Skill = $Manifest.ownedFiles | Where-Object { $_.kind -ceq "agent-skill" }
Test-Path -LiteralPath $Skill.path
Test-Path -LiteralPath (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs")
```

The last two commands should return `True`. Verify the Skill's SHA-256:

```powershell
(Get-FileHash -LiteralPath $Skill.path -Algorithm SHA256).Hash
$Skill.sha256
```

Windows PowerShell prints uppercase hashes by default; compare them case-insensitively with the manifest. Check Node.js and the runtime separately:

```powershell
node --version
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") --help
```

Node.js must be version 20 or later. If the runtime works but `/atlas` is missing, fully exit every OpenCode process and confirm that OpenCode and the installer use the same Windows account.

## Compatibility doctor and recovery

You can run the same read-only check manually from the legacy-project root:

```powershell
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") doctor (Get-Location).Path
```

`doctor` checks these configuration roots:

- `OPENCODE_CONFIG_DIR`, when set.
- `%XDG_CONFIG_HOME%\opencode`, or `%USERPROFILE%\.config\opencode` when XDG is unset.
- `%USERPROFILE%\.opencode`.
- `configDir` from a valid `%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json` manifest.
- Every `.opencode` directory from the current project up to and including the detected worktree root. The installer cannot know which project will be opened later, so these project-level locations must be checked by runtime `doctor`.

Under each configuration root, it inspects only direct `.js` and `.ts` children of `tool` and `tools`. It does not recurse into subdirectories, import candidates, or execute them. Each reported conflict includes one file path, classification, and an available SHA-256. Exit status `0` means no conflict and a complete check; status `4` means a conflict or an incomplete/blocked check. Use `--json` to save a machine-readable report.

For recovery, first back up the reported individual file outside the Atlas runtime, then verify its complete path, SHA-256, and origin. Move or disable only that exact file, and only after confirming that it is an old Atlas artifact and the backup is restorable. When a hash is unavailable, preserve the path and evidence and establish provenance first. Never delete an entire OpenCode configuration, `tool`, or `tools` directory or clear unrelated company configuration and plugins.

Use these read-only commands to verify the individual file in the report. Enter the complete reported file path, not a directory:

```powershell
$ReportedFile = Read-Host "Individual file path reported by doctor"
Get-FileHash -LiteralPath $ReportedFile -Algorithm SHA256
Select-String -LiteralPath $ReportedFile -Pattern "Bun|legacy_atlas_"
```

Local `doctor` covers only the known paths above. It cannot prove that a proprietary company fork has no additional loader paths or process cache. Final acceptance requires reinstalling from the latest source on the company computer, terminating every OpenCode process, restarting it, and running `/atlas`; preserve the doctor report and complete error text if a problem remains.

## Troubleshooting `Bun is not defined`

The current Skill and runtime do not reference Bun, and the installer no longer ships a custom tool. Therefore, the most likely cause of `Bun is not defined` is that OpenCode is still reading an older, cached, or duplicate `legacy_atlas.ts`. Diagnose it in this order:

1. Run `install.ps1` again from the latest Atlas source. A v1/v2 tool proven by its manifest path and matching hash is retired transactionally. A modified or unowned file is preserved and blocks installation.
2. After a successful install, fully exit every OpenCode process before restarting it. Closing only the window may not clear all caches.
3. Run `doctor` from the legacy-project root and back up and verify each reported file; do not delete directories blindly.
4. If known locations are clean but the error remains, inspect the company fork's actual loader paths, process cache, and whether its proprietary custom-tool loader still assumes Bun.

From the legacy-project root, check the Node runtime directly to distinguish an analyzer failure from an OpenCode Skill/cache problem:

```powershell
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") doctor (Get-Location).Path
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") analyze (Get-Location).Path
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") overview (Get-Location).Path
```

Continue to the manual `analyze` and `overview` commands only after `doctor` returns `0`. If the direct CLI succeeds while the OpenCode Skill still fails, verify Windows PowerShell-compatible Shell expansion of `$HOME` and `$PWD`; inspect the actual Skill loading path, Skill cache, and `configDir`; and confirm that the host provides both structured `write` and a metadata-only existence check for `.legacy-code-atlas/index.json`. Also confirm that OpenCode and the installer use the same Windows account.

## `worker failed` and source paths

An older worker treated legitimate JSP field names such as `duration`, `worker`, and `node` as worker metadata. It could also misclassify the iBATIS source identifier `/home/job` quoted in a parser warning as a machine path, causing `worker failed`.

The current version preserves those values as source data while retaining strict worker-protocol, runtime-diagnostic, and serialized-error validation; the same fix also preserves `<url-pattern>/home/*</url-pattern>` and the Java string `C:\\company\\app`. The fix does not reduce JSP, Struts, iBATIS, or procedure-analysis accuracy. If `worker failed` persists after updating, reproduce it with the direct CLI above and preserve complete stdout/stderr, the project root, and the triggering file type. Do not execute project code or connect to SQL Server.

## Updates and modified files

Download and extract the new source, then run the installer from that new directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

An update replaces only the private runtime and manifest-owned Skill; it does not create or write an OpenCode `tools` directory. If the Skill's actual SHA-256 differs from its manifest value, the installer refuses to overwrite it.

During a v1/v2 migration, the installer validates the owned legacy tool (and the v1 command) before writing its journal. A matching file is moved to a transaction backup and cleaned only after the v3 manifest commits; a missing file does not block migration. A modified owned file or an unowned same-name file in any known candidate configuration is preserved, and installation stops before changing state.

When a conflict occurs:

1. For a v3 Skill, use the `ownedFiles` commands above; for a legacy tool or command, use the exact path reported by the installer.
2. Confirm where the file came from and what currently uses it. Back it up outside the Atlas runtime.
3. If it belongs to company configuration or another plugin, do not move or delete it. Preserve the evidence and ask the OpenCode administrator to resolve the namespace conflict.
4. Only handle that exact path after confirming it is an old Atlas file and that your backup can be restored. Either restore content matching the old manifest hash before updating, or uninstall first, allow the uninstaller to preserve the modified file, then verify and remove the residue before reinstalling.

Do not blindly delete the ownership manifest, `%USERPROFILE%\.agents\skills\atlas`, the OpenCode `tools` directory, or the entire OpenCode configuration directory.

## Uninstall

Run this from any downloaded Atlas source directory:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

Uninstall requires a valid ownership manifest. A v3 uninstall handles only the private runtime and its single owned Agent Skill; it never deletes an OpenCode tool. SHA-256-based external-file deletion applies only to the Agent Skill, not to any OpenCode tool. A matching Skill hash is removed, while a modified Skill is preserved. After removing a matching Skill, the installer removes only the exact `%USERPROFILE%\.agents\skills\atlas` child when it is a normal, non-reparse, empty directory; a nonempty namespace is preserved. This allows a normal install -> uninstall -> reinstall cycle while leaving shared `.agents\skills` untouched. Legacy v1/v2 manifests still use hash matching for their external files. Company projects and OpenCode configuration directories are never removed.

`%USERPROFILE%\.legacy-code-atlas\` is the installer's private runtime directory. Uninstall always deletes that directory recursively, including added or modified files. Never use it for personal files or backups.

## Crash and transaction recovery

Installation first writes a transaction journal:

```text
%USERPROFILE%\.legacy-code-atlas.transaction.json
```

The runtime, Skill, and v3 manifest are staged before replacement. Existing targets receive transaction-ID backups. During v1/v2 migration, matching owned legacy tools (and the v1 command) are moved to transaction backups. The ownership manifest acts as the commit marker.

If PowerShell or the computer stops during installation, preserve the journal, stage, and backup. The next `install.ps1` run performs recovery before reading the ownership manifest:

- If the commit marker matches the journal's manifest SHA-256, the install committed successfully; recovery removes the stage, backups, and journal.
- If it does not match, installation was incomplete; recovery restores the previous runtime, Skill, old tool, and old command state.
- If a v3 commit marker matches, recovery keeps the old tool absent and completes backup cleanup; it never republishes a tool.
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

The current suite contains 70 tests. The release gate passes only with `70 pass` and `0 skip`. Non-Windows systems skip the real installer scenarios. Those runs are useful for development syntax checks but are not evidence that the Windows release gate passed.

## Large projects and sensitive data

For projects below 50,000 files and 2 million source lines, use `.legacy-code-atlasignore` to exclude backups, generated output, dependencies, and binary directories. Begin with a known module and validate known chains. Do not exclude Struts, iBATIS, or procedure source needed for tracing.

The analyzer reads source offline. It does not run Java, JSP, SQL, or procedures, and it does not connect to SQL Server. `.legacy-code-atlas/index.json` contains paths, symbols, call relationships, and SQL fragments, while `.legacy-code-atlas/query.txt` contains only a selected source-language candidate or exact identifier. Treat both as sensitive source code and keep them only on company-approved devices and storage.

## Analysis limitations

- SQL Server procedure support includes `CREATE/ALTER PROCEDURE`, nested `EXEC`, table reads/writes, and calls from iBATIS `<procedure>` or static `CALL/EXEC` inside a generic `<statement>`. It never connects to a database or executes procedures.
- Struts 2 support includes namespace/action/method/result links, configured action extensions, `redirectAction`, JSP tag routes, and Spring bean IDs used as Action classes. Duplicate bean IDs, dynamic actions, and missing source still require review.
- Struts 1 Tiles forwards and Tiles definitions, inheritance, templates, and put pages across XML files produce explicit relationships.
- Java call analysis handles fields, local variables, no-argument return types on the current or parent class, and normalized overload signatures. Parameterized factories, complex chained calls, reflection, and dynamic objects can remain unresolved.
- JSP support covers native forms/links, common Struts 1 `html:*` tags, and Struts 2 `s:*` form/link/url tags. Dynamic actions, namespaces, EL/OGNL, and JavaScript-built URLs require manual inspection.
- Dynamic URLs, reflection, and missing source may require OpenCode to inspect Atlas-referenced files. Use `read`, `grep`, or `glob` only for canonical relative citations that still resolve inside the project. Do not infer a specific route from a dynamic JSP URL without source evidence.

Do not add undocumented performance, cache, or incremental-scan parameters to OpenCode messages. `/atlas` and the CLI manage the cache automatically at `.legacy-code-atlas\cache.json` inside the analyzed project.
