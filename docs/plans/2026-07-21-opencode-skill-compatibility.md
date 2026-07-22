# OpenCode Skill-Only Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Legacy Code Atlas run through the same Agent Skill compatibility boundary as Understand-Anything, eliminate Bun custom-tool dependence, and prevent legitimate old-project paths from producing `worker failed`.

**Architecture:** Keep the deterministic Node analyzer and specialized legacy parsers. Replace runtime custom-tool calls with fixed Skill-authored CLI commands and a bounded project-local query-file bridge. Ship only the Agent Skill integration and use manifest v3 to transactionally retire hash-proven v1/v2 tools without publishing a replacement tool.

**Tech Stack:** Windows PowerShell 5.1 installer, OpenCode Agent Skills, Node.js 20+ ESM CLI, `node:worker_threads`, Node test runner.

---

### Task 1: Accept source-derived Windows paths

**Files:**
- Modify: `test/worker-pool.test.mjs`
- Modify: `src/worker-pool.mjs`

1. Add a worker test with `/home/*` in `web.xml` and `C:\\company\\app` in Java source.
2. Run the named test and confirm it fails with `WorkerFailure: worker failed`.
3. Restrict absolute-path leak checks to diagnostics and serialized errors, not source facts.
4. Run `node --test test/worker-pool.test.mjs` and confirm diagnostic leak tests still pass.

### Task 2: Add a safe query-file CLI bridge

**Files:**
- Modify: `test/cli.test.mjs`
- Modify: `bin/legacy-code-atlas.mjs`

1. Add a CLI test that writes a question containing spaces and shell metacharacters to `.legacy-code-atlas/query.txt` and invokes `trace-feature --query-file` without a positional query.
2. Run the named test and confirm the current parser treats the option as query text and fails.
3. Parse `--query-file`, reject a simultaneous positional query, and read only a regular UTF-8 file inside the project's `.legacy-code-atlas` directory.
4. Enforce non-empty, NUL-free content and a 64 KiB maximum.
5. Run all CLI tests.

### Task 3: Replace custom-tool execution with Skill execution

**Files:**
- Modify: `test/integration.test.mjs`
- Modify: `integrations/opencode/skills/understand/SKILL.md`
- Modify: `integrations/opencode/AGENTS.fragment.md`
- Modify: `integrations/opencode/commands/legacy-find.md`
- Modify: `integrations/opencode/commands/legacy-table.md`
- Delete: `integrations/opencode/tools/legacy_atlas.ts`

1. Replace custom-tool assertions with failing tests for fixed CLI shell commands, structured query-file writes, no user interpolation, and no `legacy_atlas_*` tool calls.
2. Confirm the integration tests fail against the current custom-tool Skill.
3. Rewrite the Skill using the reference project's Skill-only pattern.
4. Delete the shipped TypeScript tool; fresh installs and v3 updates must not create `tools\legacy_atlas.ts` or an OpenCode `tools` directory.
5. Update optional command templates and Agent guidance to the same query-file protocol.
6. Run all integration tests.

### Task 4: Verify installer migration behavior

**Files:**
- Modify: `test/installer.test.mjs`
- Modify: `test/installer-windows.test.mjs`
- Modify: `test/helpers/windows-installer-harness.mjs`
- Modify: `install.ps1`

1. Add static and Windows-gated assertions that the Skill contains the CLI entry while fresh/v3 installs publish no tool and create no `tools` directory.
2. Confirm old expectations for executable custom tools or an inert placeholder fail.
3. Introduce strict manifest v3 ownership with exactly one `agent-skill` entry; retain `configDir` only as diagnostic metadata.
4. Migrate v1/v2 installs by transactionally retiring only the exact owned old tool after a hash check. Continue when it is missing; preserve and block on modified or unowned files.
5. Cover rollback before manifest commit, cleanup after commit, v3 uninstall namespace cleanup, modified/nonempty namespace preservation, and old transaction-v1 journal recovery.
6. Run installer tests; retain the real Windows `65 pass / 0 skip` release gate for the current suite.

### Task 5: Update user documentation

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `docs/opencode.md`
- Modify: `docs/opencode-en.md`

1. Document the Understand-Anything-derived Skill-only architecture.
2. Remove claims that a plain JSON Schema custom tool is required.
3. Add exact update/restart and diagnostic commands for stale Bun tools and direct CLI analysis.
4. Explain the fixed source-path worker failure and the remaining real-Windows/company-fork validation boundary.

### Task 6: Full verification and delivery

1. Run `npm test` and require zero failures.
2. Re-run the minimal Windows-path CLI reproduction and require exit 0.
3. Run the frozen benchmark and require at least `3.00x` speedup with byte-equivalent graph output.
4. Run the pinned TheDailyPlan validation workflow and compare verified routes/procedure chains.
5. Request code review and address all critical/important findings.
6. Commit the branch, integrate into `main`, push GitHub, and verify the remote commit.
7. Have the user reinstall on the company machine, restart all OpenCode processes, run `/understand`, and verify known old-project traces before marking the goal complete.
