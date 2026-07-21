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

Legacy Code Atlas does not connect to a database or invoke a separate model. OpenCode continues to use the model already configured by your company. The analyzer only reads source code downloaded to your computer and creates a local index.

## Quick start: three steps

### 1. Download and extract

Download this repository as a source archive, extract it, and open the extracted `legacy-code-atlas` directory.

Requirements:

- Windows 10/11 or Windows Server
- The built-in Windows PowerShell 5.1
- Node.js 20 or later; run `node --version` to check
- OpenCode 1.14.49 or later, or a compatible company fork that supports user-level Agent Skills and custom tools with plain JSON Schema parameters

A company fork does not need to use the same version number. What matters is whether it can load a user-level Agent Skill and a custom tool.

### 2. Install it into OpenCode

Open Windows PowerShell in the extracted directory and run:

```powershell
node --version
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

Administrator privileges are not required. The installer only copies the downloaded files: it does not access the network or run `npm install`.

After the installer reports that installation is complete, fully close every OpenCode process and restart OpenCode.

### 3. Analyze first, then ask questions

Open the legacy project directory and start OpenCode there. Your first message must contain only this command:

```text
/understand
```

Do not append a question to `/understand`. Wait for the analysis to finish, then send a separate normal message without a slash. For example:

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

After the source code changes, send `/understand` again as a message on its own. Once analysis finishes, continue asking questions normally. You do not need to run PowerShell or Node.js commands during everyday use.

## What you can trace

- Find pages, URLs, Actions, Services, DAOs, iBATIS statements, and tables from a business description.
- Follow a URL through Struts or Servlet mappings and subsequent Java calls.
- Find SQL and callers from a fully qualified iBATIS statement ID.
- Trace a SQL Server procedure back to iBATIS/Java callers, nested procedures, and tables read or written.
- Trace a SQL Server table back to read/write locations and upstream entry points.

Results include source file paths and line numbers. Relationships directly supported by source or configuration evidence have higher confidence. Heuristic relationships, dynamic URLs, reflection, and missing source files require you to inspect the referenced files. Do not treat a relationship with confidence below `0.95` as established fact without reviewing its evidence.

## Installation locations

The default installation is under the current Windows user profile:

```text
%USERPROFILE%\.legacy-code-atlas\
%USERPROFILE%\.agents\skills\understand\SKILL.md
%USERPROFILE%\.config\opencode\tools\legacy_atlas.ts
```

The Agent Skill path is always `%USERPROFILE%\.agents\skills\understand\SKILL.md`. If `OPENCODE_CONFIG_DIR` is set during the first installation, only the OpenCode tool is installed under that configuration directory at `tools\legacy_atlas.ts`.

The selected OpenCode configuration directory is saved as `configDir` in:

```text
%USERPROFILE%\.legacy-code-atlas\.legacy-code-atlas-owner.json
```

Updates and uninstallations continue to use this saved directory. Changing `OPENCODE_CONFIG_DIR` later does not migrate an existing installation.

The old `commands\understand.md` Markdown command has been removed. The current `/understand` entry point is a global Agent Skill.

## Update and uninstall

To update, download and extract the new source, open Windows PowerShell in the new directory, and run:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

The installer reuses the configuration path stored in the ownership manifest. If an installer-owned Skill or tool has been modified, the update refuses to overwrite it. Back it up and verify its origin before resolving the conflict; see the [detailed OpenCode installation and recovery guide](docs/opencode-en.md).

To uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
```

For the Agent Skill and OpenCode tool outside the runtime directory, the uninstaller deletes a file only when its SHA-256 still matches the ownership manifest. Modified files are preserved. Company projects and shared OpenCode configuration directories are never deleted.

`%USERPROFILE%\.legacy-code-atlas\` is the installer's private runtime directory. Uninstalling always removes that entire directory recursively, including files that were added or modified inside it. Do not store your own files there.

## Local cache and full rebuild

Each `/understand` run stores fingerprint-validated, per-file parse results in `.legacy-code-atlas\cache.json` inside the analyzed project. A later scan still reads files and calculates SHA-256 fingerprints, but reuses parse results when both the content and parser schema/version are unchanged.

Missing, corrupt, unsafe, or incomplete cache data is treated as a cache miss. A cache write error is reported as a diagnostic and does not discard the graph that was already produced. To force a full rebuild, delete the project's `.legacy-code-atlas` directory and run `/understand` again.

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
- Installation and source analysis can run offline. Whether the model itself uses a network depends on your company's OpenCode configuration.
- `.legacy-code-atlas/index.json` contains source structure, paths, relationships, and SQL fragments. Treat it as sensitive source code and keep it only on company-approved devices and storage.

## Troubleshooting

If `/understand` is unavailable, confirm that installation completed successfully, fully exit all OpenCode processes, and start it again. The installer and OpenCode must run as the same Windows user. For a company fork with an unknown version, verify that it supports user-level Agent Skills and custom tools with plain JSON Schema parameters.

If you see `Bun is not defined`, OpenCode is still loading an older `legacy_atlas.ts`. Run `install.ps1` again from the latest source directory, confirm that installation completes, then fully exit and restart OpenCode. The current tool uses Node.js standard modules and does not require a global `Bun` object.

If the first scan is too slow, improve `.legacy-code-atlasignore` or start with a smaller business module. If a query returns no result, run `/understand` again by itself and then ask a new question using a URL, Java class name, fully qualified statement ID, procedure name, or table name.

For ownership-manifest checks, update conflicts, transaction recovery, and the real-Windows release gate, see [OpenCode installation and recovery](docs/opencode-en.md).

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

The cold scan covered 758 Java/JSP/XML/SQL files and 84,169 source lines, producing 7,186 nodes and 8,213 edges. It took about 0.97 seconds on the development Mac. This is a reproducible public validation sample, not a claim that every 50,000-file project has the same runtime. See the [full validation record](docs/validation-thedailyplan.md).

## Development verification

Run the general test suite from the repository directory:

```powershell
npm test
```

The current cross-platform run contains 426 tests: 385 pass, 0 fail, and 41 Windows-only scenarios are skipped outside Windows. This does **not** mean the Windows installer release gate has passed. A release must be tested on real Windows with the built-in Windows PowerShell 5.1, where `npm run test:installer:windows` must report `50 pass` and `0 skip`.

The cold-cache benchmark compares the current implementation with the frozen `0.1.0` baseline and requires at least a `3.00x` median speedup:

```powershell
$env:ATLAS_BENCH_FILES = 500
$env:ATLAS_BENCH_SAMPLES = 3
npm run benchmark
```

The latest development run measured a baseline median of 15,893.76 ms and a candidate median of 887.96 ms, a `17.90x` speedup. Real company projects should still be measured separately.
