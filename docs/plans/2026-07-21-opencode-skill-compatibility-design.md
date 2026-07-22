# OpenCode Skill-Only Compatibility Design

## Context

The company Windows OpenCode fork can run Egonex-AI/Understand-Anything but reports both `Bun is not defined` and `worker failed` with Legacy Code Atlas. The reference was inspected at commit `2f24580ba076592a1a6d766e47590836436f30f6` (2026-07-20). Its Windows `opencode` installer only links Agent Skill directories into `%USERPROFILE%\.agents\skills`; its `/understand` skill uses the host's shell, Node/Python helper scripts, and agent dispatch. It does not install an OpenCode TypeScript custom tool and does not require a `Bun` global in the OpenCode integration path. That reference demonstrates similar, partial host behavior only; it is not proof of Atlas compatibility.

Before this change, Atlas took a different path: `/understand` called a TypeScript custom tool, the tool started the Node CLI, and the CLI used `worker_threads`. That created two extra runtime compatibility boundaries that the working reference did not have.

## Confirmed failures

Before the fix, `worker failed` was reproducible without OpenCode. `src/worker-pool.mjs` scanned every string in parsed facts for machine-looking absolute paths. Legitimate old-project source such as `<url-pattern>/home/*</url-pattern>` or `"C:\\company\\app"` therefore failed worker validation. The same validation ran after main-thread fallback, so retry and batch splitting could not recover.

During the investigation, a continued `Bun is not defined` error was most likely caused by an old, cached, or duplicate tool. Publishing a placeholder tool would still invoke an unknown proprietary custom-tool loader and would leave Atlas responsible for a file it does not need. Updating a different manifest-saved `configDir` could also leave the active copy unchanged.

## Chosen architecture

Atlas will use a similar Skill-only compatibility boundary: the Agent Skill is the executable OpenCode integration. `/understand` invokes the installed Node CLI with fixed shell commands. For later questions, explicit source identifiers remain exact while the company's model reduces natural-language requests to concise source-language search candidates. The host's structured `write` tool stores the selected source-language candidate or exact identifier in `.legacy-code-atlas/query.txt`; the CLI reads it through `--query-file`. User text and derived candidates are never interpolated into a shell command.

The repository no longer ships `legacy_atlas.ts`, and fresh installs or v3 updates do not create an OpenCode `tools` directory. Manifest v3 owns exactly one external file, the `agent-skill`; its saved `configDir` is diagnostic metadata only and does not claim ownership of any tool.

For a v1/v2 migration, the installer accepts the old manifest only at its exact expected paths. A matching owned tool is moved to a transaction backup and retired only when the v3 manifest commits. An already-missing tool does not block migration. A modified owned tool or any unowned same-name file in the saved, current, or default configuration is preserved and blocks installation before state changes. A pre-commit crash restores the old tool; a post-commit recovery keeps it absent and finishes cleanup. The same transaction rules cover the v1 command, and legacy transaction-v1 journals remain recoverable.

Worker result validation will continue rejecting absolute paths in runtime diagnostics and serialized errors, but it will allow paths and routes derived from source facts. Worker startup failures retain the existing deterministic main-thread fallback. A direct CLI smoke test with Windows-style paths becomes part of verification.

## Data flow

```text
/understand
-> global Agent Skill
-> fixed shell command: node <installed CLI> analyze <current project>
-> scanner / parsers / graph index
-> fixed shell command: node <installed CLI> overview <current project>

ordinary question
-> metadata-only existence check for .legacy-code-atlas/index.json
-> if missing, ask for a standalone /understand and stop
-> preserve an explicit identifier, or derive a concise source-language candidate
-> prepare-query validates the project Atlas directory/index and query-file boundary
-> structured write stores the source-language candidate or exact identifier in .legacy-code-atlas/query.txt
-> fixed shell command selects a trace command plus --query-file and --no-match-ok
-> only for a natural-language no-match, try at most two short alternatives
-> evidence-backed trace
-> optional read/grep verification only for confined project-relative cited source
```

## Compatibility and security

- Windows PowerShell remains installation-only; daily OpenCode use requires the shell behavior demonstrated partially by Understand-Anything, but that behavior is not proof of Atlas compatibility.
- Node.js 20+ remains the only runtime dependency. No Bun API, MCP server, registry, database, or network access is required.
- Static-artifact checks require a real `.legacy-code-atlas` directory and reject a standard `index.json` that is a symlink, junction, or hardlink. Before every structured `write`, `prepare-query` removes only a pre-existing linked project-local `query.txt` entry and atomically creates a new regular file. Analysis ignores a linked `cache.json`, treats it as a cache miss, and replaces only the project-local entry. These operations do not follow a link to read or modify its external target.
- The link checks defend against symlink, junction, and hardlink entries that already exist when a command begins. They do not defend against a malicious same-user local process concurrently swapping workspace paths between a check and a read or write. That TOCTOU scenario is outside the normal local single-user workflow threat model, so the design does not claim complete filesystem-race protection.
- The logical query is capped at 1024 characters and 64 whitespace-delimited tokens before index loading; the containing query file has a separate outer cap of 64 KiB. Ordinary source-language candidates should remain short. Candidate derivation does not weaken this boundary because only structured `write` creates the file and every Shell command remains fixed.
- `--no-match-ok` converts only a legitimate trace no-match from exit status 3 to 0 so bounded fallback can continue. Invalid query, index, file, and runtime failures remain errors.
- Disk-loaded indexes are capped at 512 MiB, decoded as strict UTF-8, and validated against the 1.0.0 graph structure. Node IDs are unique, edge endpoints exist, and every node/evidence file path is canonical project-relative POSIX syntax. CLI output and index citations remain untrusted data; the Skill opens a citation only when its resolved path remains inside the current project and the host tool enforces workspace confinement.
- Combinatorial graph traversal is capped at 5,000 states and 100 result paths per direction for each candidate. Bidirectional traces apply the caps independently to incoming and outgoing traversal. Dense graphs that reach a cap emit an accurate truncation warning and return partial results. Initial candidate search and adjacency construction still scale with index nodes and relevant edges, so these are traversal-expansion bounds rather than a bound on all per-candidate work.
- The company OpenCode fork must provide structured `write`, a metadata-only index existence check, and PowerShell-compatible expansion of `$HOME` and `$PWD` for the fixed Shell commands.
- The analyzer remains static: it does not execute Java, JSP, SQL, or procedures and does not connect to SQL Server.
- Manifest v3 uninstall removes only the private runtime and a hash-matching owned Skill. It removes the exact `skills\understand` child only when that directory is normal, non-reparse, and empty; a modified Skill or nonempty namespace is preserved, and the shared `.agents\skills` directory is never removed.

## Verification boundary

Automated tests can prove the Node CLI, Skill contract, installer artifacts, worker regression, and public sample behavior. They cannot prove the proprietary OpenCode fork. Completion therefore also requires a company-machine reinstall, full process restart, `/understand` run, and at least one known URL/statement/table/procedure trace.
