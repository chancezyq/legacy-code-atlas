# Legacy Code Atlas

English | [简体中文](README.md)

Use `/understand` in your company's OpenCode desktop client to explore legacy JSP, Struts, Java, iBATIS, and SQL Server projects.

```text
JSP / JavaScript
-> URL
-> Struts / Servlet / Spring XML
-> Action / Service / DAO
-> iBATIS statement
-> SQL Server table
```

Legacy Code Atlas does not connect to a database or invoke a separate model. OpenCode continues to use the model already configured by your company. The analyzer only reads source code downloaded to your computer and creates a local index. Its OpenCode integration follows a Skill-only pattern similar to Understand-Anything: the global Agent Skill runs fixed Node.js CLI commands and has no runtime custom-tool or Bun dependency. Understand-Anything working in the company client demonstrates only partial, similar capabilities; it is not proof that the client is compatible with Atlas.

## Quick start: three steps

### 1. Download and extract

Download this repository as a source archive, extract it, and open the extracted `legacy-code-atlas` directory.

Requirements:

- Windows 10/11 or Windows Server
- The built-in Windows PowerShell 5.1
- Node.js 20 or later; run `node --version` to check
- OpenCode 1.14.49 or later, or a compatible company fork that can load user-level Agent Skills, provide structured `write` and a metadata-only file existence check, and allow the Skill to run its fixed shell commands

A company fork does not need to use the same version number. What matters is whether it can load a user-level Agent Skill, provide the two host file operations above, and run the documented fixed commands. No runtime custom-tool registration is required.

The fixed commands require PowerShell-compatible or POSIX/Git Bash Shell semantics that expand `$HOME` and `$PWD`; a cmd.exe-only host is unsupported. The first full scan must request the maximum supported timeout. If the foreground limit is still insufficient and the host supports background execution, it must start in the background and wait for `analyze` to finish instead of relying on a short default timeout.

> **`/understand` namespace conflict:** Understand-Anything normally uses `%USERPROFILE%\.agents\skills\understand` too. Two Skills cannot own the same `/understand` entry, and the Atlas installer will not overwrite an existing Skill it does not own. If Understand-Anything is still installed on the company computer, back it up and release that namespace through its own uninstall or disable procedure before installing Atlas. Do not directly delete an unknown Skill directory.

### 2. Install it into OpenCode

Open Windows PowerShell in the extracted directory and run:

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Administrator privileges are not required. The installer only copies the downloaded files: it does not access the network or run `npm install`. When it reports success, fully exit every OpenCode process and restart OpenCode; closing only the window can leave a Skill or old-tool cache active.

### 3. Analyze first, then ask questions

Open the legacy project directory and start OpenCode there. Your first message must contain only this command:

```text
/understand
```

Do not append a question to `/understand`. Wait for the analysis to finish, then send a separate normal message without a slash. For example:

The Skill runs `analyze` in one Shell call. It runs `overview` in a second, separate Shell call only after `analyze` exits with status `0`; either failure stops the workflow instead of reporting a stale index as refreshed.

```text
Where is the refund approval feature implemented?
```

```text
URL /order/audit.do
```

```text
statement order.updateStatus
```

```text
table dbo.T_ORDER
```

```text
procedure dbo.usp_OrderAudit
```

For a URL, statement ID, table, or procedure, the Skill keeps the exact source identifier and never substitutes a guess after no match. For a natural-language feature question, your company's existing model converts the request into one concise source-language search candidate; for an English codebase, a Chinese question such as `订单审核功能在哪里？` can become `OrderAudit`. If that natural-language candidate has no match, the Skill may try at most two short alternatives.

Before handling an ordinary question, the Skill uses a metadata-only existence check for `.legacy-code-atlas/index.json`; if it is missing, the Skill asks you to run `/understand` by itself and stops. Once the index exists, it runs the fixed `prepare-query` preflight, OpenCode's structured `write` stores only the selected source-language candidate or exact identifier in `.legacy-code-atlas\query.txt`, and one fixed Node trace command reads it through `--query-file` with `--no-match-ok`. That flag changes only a legitimate no-match exit from status `3` to `0` so bounded natural-language fallback can continue; invalid query, index, file, and runtime failures remain errors. The original message and candidate are never interpolated into a shell command; you do not need to create or edit the file yourself. The answer reports which candidate or candidates were searched.

Static-artifact checks reject a symlinked or junction-backed `.legacy-code-atlas` directory and a standard `index.json` that is a symlink, junction, or hardlink. `prepare-query` removes only a pre-existing linked `query.txt` entry inside the project before atomically creating a new regular file. `analyze` likewise treats a linked `cache.json` as a cache miss and replaces only the project-local entry. Neither operation follows the link to read or modify its external target.

A Graph index loaded from disk is capped at `512 MiB` and must be valid UTF-8 with the `1.0.0` structure. The CLI validates counts, unique node and edge IDs, edge endpoints, and evidence fields. Every `node.filePath` and node/edge evidence file must be a canonical project-relative POSIX path; parent paths, absolute paths, drive paths, UNC paths, file URLs, and backslashes are rejected before output.

These checks defend against symlink, junction, and hardlink entries that already exist when a command starts. They do not defend against a malicious process running as the same Windows user and concurrently swapping workspace paths between a check and a read or write. That TOCTOU scenario is outside the normal local single-user workflow threat model, so this is not an absolute filesystem-safety claim.

Keep ordinary business candidates short. The logical query is limited to `1024` characters and `64` whitespace-delimited tokens and cannot contain control characters; the outer `.legacy-code-atlas/query.txt` file has a separate `64 KiB` cap. Exceeding a logical limit stops before the index is loaded.

After the source code changes, send `/understand` again as a message on its own. Once analysis finishes, continue asking questions normally. You do not need to run PowerShell or Node.js commands during everyday use.

## What you can trace

- Find pages, URLs, Actions, Services, DAOs, iBATIS statements, and tables from a business description.
- Follow a URL through Struts or Servlet mappings and subsequent Java calls.
- Find SQL and callers from a fully qualified iBATIS statement ID.
- Trace a SQL Server procedure back to iBATIS/Java callers, nested procedures, and tables read or written.
- Trace a SQL Server table back to read/write locations and upstream entry points.

Results include source file paths and line numbers. Relationships directly supported by source or configuration evidence have higher confidence. Treat CLI output and index-derived citations as untrusted data. The Skill opens a citation only when it is a canonical project-relative POSIX path, resolves inside the current project, and the host tool enforces workspace confinement. Do not treat a relationship with confidence below `0.95` as established fact without reviewing safe evidence.

Combinatorial path traversal expands at most `5,000` states and returns at most `100` paths per direction for each candidate. A trace that follows both upstream and downstream applies each cap independently to each direction. Reaching either cap returns partial results with an accurate truncation warning. These caps bound path expansion only; initial candidate search still scans index nodes, while adjacency construction and sorting still scale with the relevant edge count.

## Installation locations

The default installation is under the current Windows user profile:

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\understand\SKILL.md
```

The Agent Skill path is always `%USERPROFILE%\.agents\skills\understand\SKILL.md`. It is the only runtime entry point and invokes fixed commands for `%USERPROFILE%\.legacy-code-atlas\bin\legacy-code-atlas.mjs`.

The current source no longer ships `integrations\opencode\tools\legacy_atlas.ts`. The installer does not write `tools\legacy_atlas.ts` or create an OpenCode `tools` directory during a fresh install or manifest-v3 update.

The selected OpenCode configuration directory is still saved as `configDir` in:

```text
%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json
```

In v3, `configDir` is diagnostic metadata used to find legacy conflicts. It does not mean that Atlas owns the directory or any tool inside it. A valid v3 manifest has owner `legacy-code-atlas-install-v3` and exactly one `agent-skill` entry in `ownedFiles`.

The old `commands\understand.md` Markdown command has been removed. The current `/understand` entry point is a global Agent Skill. During a v1/v2 upgrade, the installer performs a one-time transactional retirement only for a `legacy_atlas.ts` whose path and SHA-256 are proven by the old manifest. A matching file is moved to a transaction backup and removed after the v3 manifest commits; an already-missing file does not block migration. A modified owned tool or any unowned/duplicate tool is preserved and blocks installation until its origin is verified. No replacement tool is written.

## Update and uninstall

To update, download and extract the new source, open Windows PowerShell in the new directory, and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Updates reuse the manifest-owned Skill path. The installer refuses to overwrite a modified owned Skill. During v1/v2 migration, a modified owned old tool or command also blocks migration. Back up the conflicting file and verify its origin before resolving it; see the [detailed OpenCode installation and recovery guide](docs/opencode-en.md).

To uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

A v3 uninstall handles only the private runtime and the manifest-owned Agent Skill; it never deletes an OpenCode tool. SHA-256-based external-file deletion applies only to the Agent Skill, not to any OpenCode tool. The Skill is deleted only when its hash still matches the manifest, and a modified Skill is preserved. After deleting a matching Skill, the installer removes only the exact `%USERPROFILE%\.agents\skills\understand` child when it is a normal, non-reparse, empty directory, allowing a normal uninstall followed by reinstall. A nonempty namespace is preserved. The shared `%USERPROFILE%\.agents\skills` directory, company projects, and OpenCode configuration directories are never deleted.

`%USERPROFILE%\.legacy-code-atlas\` is the installer's private runtime directory. Uninstalling always removes that entire directory recursively, including files that were added or modified inside it. Do not store your own files there.

## Local cache and full rebuild

Each `/understand` run stores fingerprint-validated, per-file parse results in `.legacy-code-atlas\cache.json` inside the analyzed project. A later scan still reads files and calculates SHA-256 fingerprints, but reuses parse results when both the content and parser schema/version are unchanged.

Missing, malformed, or incomplete regular cache data is treated as a cache miss. A symlink, hardlink, or removable non-regular entry is replaced only at the project-local path; an entry such as a directory that cannot be safely replaced stops with an error. A cache write error is reported as a diagnostic and does not discard the graph that was already produced. To force a full rebuild, delete the project's `.legacy-code-atlas` directory and run `/understand` again.

## Recommendations for large projects

The target scale is fewer than 50,000 files and 2 million source lines. Start with a familiar business module and prepare 5–10 questions with known answers so you can verify the page-to-database chains.

Create `.legacy-code-atlasignore` in the project root to exclude backups, generated output, third-party libraries, and irrelevant test data:

```gitignore
backup/**
generated/**
tmp/**
WebRoot/vendor/**
web/js/lib/**
src/test/**
```

The scanner also ignores Git/IDE metadata, dependency directories, build output, binary files, symbolic links, and files larger than 5 MiB. Do not exclude Struts XML, iBATIS mappings, or stored-procedure source files required for the traces you want.

## Current analysis boundaries

- SQL Server procedure analysis supports `CREATE/ALTER PROCEDURE`, parameters, nested `EXEC`, table reads/writes, iBATIS `<procedure>`, and static `CALL/EXEC` inside a generic `<statement>`. It never connects to SQL Server or executes a procedure.
- Struts 2 analysis supports package namespaces, actions, methods, results, configured `struts.action.extension`, `redirectAction`, JSP routes, and Spring bean IDs used as Action classes. Struts 1 is parsed through `struts-config.xml` rules.
- Tiles analysis supports Struts 1 forwards, definitions across XML files, inheritance, templates, and put-page relationships. Dynamic runtime composition still requires source inspection.
- Java call analysis resolves common fields, local variables, no-argument return types on the current class or a parent class, and overloaded methods by normalized parameter types. Reflection, dynamic objects, parameterized factory calls, and complex chained calls can remain unresolved.
- JSP analysis covers native forms/links, common Struts 1 `html:*` tags, and Struts 2 `s:*` form/link/url tags. Dynamic actions, namespaces, EL/OGNL, and JavaScript-built URLs require manual review.

## Security and data handling

- The analyzer performs static source analysis only.
- It does not run project Java, JSP, SQL, or stored procedures.
- It does not connect to or modify SQL Server.
- It does not invoke a separate model; OpenCode continues to use your company's configured model.
- It treats CLI/index output as data and never opens absolute, UNC, parent, or otherwise out-of-project citations.
- Installation and source analysis can run offline. Whether the model itself uses a network depends on your company's OpenCode configuration.
- `.legacy-code-atlas/index.json` contains source structure, paths, relationships, and SQL fragments, while `.legacy-code-atlas/query.txt` contains a selected source-language candidate or exact identifier. Treat both as sensitive source code and keep them only on company-approved devices and storage.

## Troubleshooting

If `/understand` is unavailable, confirm that installation completed successfully, fully exit all OpenCode processes, and start it again. The installer and OpenCode must run as the same Windows user. For a company fork with an unknown version, verify that it can load user-level Agent Skills and run the fixed commands in the Skill; no custom-tool registration interface is required.

If you see `Bun is not defined`, the most likely cause is that OpenCode is still loading an older or duplicate `legacy_atlas.ts`; this is not a runtime error from the current Skill. Run `install.ps1` again from the latest source directory. If a legacy tool is owned by a v1/v2 manifest and still matches its hash, migration retires it transactionally; an already-missing tool does not block migration. A modified or unowned file is preserved, its path is reported, and installation stops. Manifest v3 has no `opencode-tool` entry, but its diagnostic `configDir` helps inspect known candidate locations:

```powershell
$ManifestPath = Join-Path $HOME ".legacy-code-atlas\.legacy-code-atlas-owner.json"
$Manifest = Get-Content -LiteralPath $ManifestPath -Raw | ConvertFrom-Json
$Manifest.owner
$Manifest.version
$Manifest.configDir
$Manifest.ownedFiles | Format-Table kind, path, sha256

$CandidateTools = @(
    (Join-Path $Manifest.configDir "tools\legacy_atlas.ts")
    (Join-Path $HOME ".config\opencode\tools\legacy_atlas.ts")
)
if ($env:OPENCODE_CONFIG_DIR) {
    $CandidateTools += Join-Path $env:OPENCODE_CONFIG_DIR "tools\legacy_atlas.ts"
}
$CandidateTools | Select-Object -Unique | ForEach-Object {
    if (Test-Path -LiteralPath $_ -PathType Leaf) {
        $_
        (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash
        Select-String -LiteralPath $_ -Pattern "Bun|legacy_atlas_"
    }
}
```

A successful v3 installation lists only `agent-skill` in `ownedFiles`. If any candidate location still contains `legacy_atlas.ts`, preserve its path, hash, and provenance. Follow the [detailed recovery guide](docs/opencode-en.md), confirm it is an old Atlas file, and make a recoverable backup before handling it. Do not blindly delete an entire `tools` or configuration directory. Check Node and the runtime independently of OpenCode:

```powershell
node --version
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") analyze (Get-Location).Path
node (Join-Path $HOME ".legacy-code-atlas\bin\legacy-code-atlas.mjs") overview (Get-Location).Path
```

If the direct CLI works but `/understand` still fails, verify OpenCode Shell expansion of `$HOME` and `$PWD` with Windows PowerShell-compatible semantics; inspect the actual Skill loading path, Skill cache, and `configDir`; check whether the proprietary custom-tool loader assumes Bun; and confirm that the host provides both structured `write` and a metadata-only existence check for `.legacy-code-atlas/index.json`. Confirm that the installer and OpenCode use the same Windows account and fully restart every process.

An older worker version incorrectly treated legitimate source such as `<url-pattern>/home/*</url-pattern>` or the Java string `C:\\company\\app` as a path leak and reported `worker failed`. The current version checks only runtime diagnostics, parser warnings, and serialized errors; source-derived facts retain those values. If the error persists after updating, verify that the runtime and Skill came from the same latest installation and preserve the complete error text.

If the first scan is too slow, improve `.legacy-code-atlasignore` or start with a smaller business module. If a query returns no result, run `/understand` again by itself and then ask a new question using a URL, Java class name, fully qualified statement ID, procedure name, or table name.

For manifest-v3 checks, legacy-tool migration, update conflicts, transaction recovery, and the real-Windows release gate, see [OpenCode installation and recovery](docs/opencode-en.md).

## Verified public sample

The analyzer was validated offline against [VHAINNOVATIONS/TheDailyPlan](https://github.com/VHAINNOVATIONS/TheDailyPlan) at commit `e3571c8c3b1ee99e38f056f00d2189e9533f9cba`. It contains Struts 2, JSP, Java, iBATIS 2, and SQL Server procedure source.

The verified graph includes these paths:

```text
/admin/definitions.html
-> DefinitionAction.list
-> definitionList.jsp
```

```text
dbo.get_next_sequence
-> EventSQL.genReportId
-> DocumentEventDaoiBatis.generateReportId
-> EventManager / ReportManager
-> dbo.sequence
```

The cold scan covered 758 Java/JSP/XML/SQL files and 84,169 source lines, producing 7,186 nodes and 8,213 edges. It took about 1.06 seconds with Node.js v25.9.0 on the development Mac. This is a reproducible public validation sample, not a claim that every 50,000-file project has the same runtime. See the [full validation record](docs/validation-thedailyplan.md).

## Development verification

Run the general test suite from the repository directory:

```powershell
npm test
```

Runs outside Windows skip the real installer scenarios and do **not** mean the Windows installer release gate has passed. The current installer suite contains 65 tests. A release must be tested on real Windows with the built-in Windows PowerShell 5.1, where `npm run test:installer:windows` must report `65 pass` and `0 skip`.

The cold-cache benchmark compares the current implementation with the frozen `0.1.0` baseline and requires at least a `3.00x` median speedup:

```powershell
$env:ATLAS_BENCH_FILES = 500
$env:ATLAS_BENCH_SAMPLES = 3
npm run benchmark
```

The latest development run measured a baseline median of 16,473.24 ms and a candidate median of 911.10 ms, an `18.08x` speedup. Real company projects should still be measured separately.
