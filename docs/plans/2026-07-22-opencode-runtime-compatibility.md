# OpenCode Runtime Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate the reproducible JSP `worker failed` error and make stale Bun-based Atlas tools discoverable before `/understand` analyzes a company project.

**Architecture:** Keep the Skill-only OpenCode integration and deterministic Node analyzer. Separate source-derived facts and parser warnings from the worker protocol's operational envelope: source data may contain arbitrary business keys and path-like identifiers, while result/record shape, diagnostics, and serialized errors stay strict. Add read-only OpenCode compatibility discovery to the Node CLI, use it as a fixed `/understand` preflight, and make the Windows installer inspect every official user-level tool root it can know at install time without executing or deleting unknown tools.

**Tech Stack:** Windows PowerShell 5.1, OpenCode Agent Skills, Node.js 20+ ESM, `node:worker_threads`, Node test runner.

---

### Task 1: Preserve the clean test baseline

**Files:**
- Modify: `test/cli.test.mjs`

1. Keep the logical-query test self-contained by creating its ignored `.legacy-code-atlas` fixture directory.
2. Run the named CLI test and confirm it passes in a fresh worktree.
3. Run `npm test` and record the pass/skip/fail counts before compatibility changes.

### Task 2: Accept source-derived keys and path-like identifiers

**Files:**
- Modify: `test/worker-pool.test.mjs`
- Modify: `test/fixtures/workers/crash-worker.mjs`
- Modify: `src/worker-pool.mjs`

1. Add real-worker regressions using a JSP form whose static input names include `duration`, `worker`, and `node`, plus an iBATIS procedure statement whose source identifier is `/home/job`.
2. Run the named tests and confirm the current implementation reaches main-thread validation and throws `WorkerFailure: worker failed`.
3. Make JSON-safety validation reject non-JSON values and malformed descriptors without treating property names inside `record.facts` as protocol fields. Keep exact result and record key validation as the scheduler boundary.
4. Exclude parser warnings from machine-path leak detection because they may quote source identifiers; keep leak detection on operational diagnostics and serialized errors.
5. Keep top-level extra protocol fields rejected. Replace synthetic deep-fact blacklist tests with tests proving source-derived reserved keys are inert data.
6. Run the worker-pool tests and both end-to-end CLI reproductions.

### Task 3: Discover stale OpenCode tools without Bun

**Files:**
- Create: `src/opencode-doctor.mjs`
- Create: `test/opencode-doctor.test.mjs`
- Modify: `bin/legacy-code-atlas.mjs`
- Modify: `test/cli.test.mjs`

1. Add tests for the official user roots: `OPENCODE_CONFIG_DIR`, `XDG_CONFIG_HOME/opencode` or `%USERPROFILE%/.config/opencode`, and `%USERPROFILE%/.opencode`.
2. Add project-root tests that walk the current project up to and including its worktree root, inspecting each `.opencode` directory while excluding parents above the worktree.
3. Inspect only direct `tool` and `tools` children with `.js` or `.ts` extensions. Never import or execute a candidate.
4. Classify exact released Atlas tool hashes separately from modified/suspicious `legacy_atlas` files; ignore unrelated company tools.
5. Reject reparse/symbolic-link candidates and bound file count and file size.
6. Expose `doctor <project> [--json]` with runtime version, Node version, checked roots, and actionable conflict paths/hashes. Return nonzero when a conflicting Atlas tool is present.

### Task 4: Run the doctor from the Agent Skill

**Files:**
- Modify: `integrations/opencode/skills/understand/SKILL.md`
- Modify: `test/integration.test.mjs`
- Modify: `install.ps1`
- Modify: `test/installer.test.mjs`
- Modify: `test/installer-windows.test.mjs`

1. Add a fixed `doctor "$PWD"` Shell call before `analyze "$PWD"`; proceed only when doctor exits zero.
2. Keep `/understand` no-argument behavior and prohibit interpolation of user text.
3. Expand installer preflight discovery to both `tool` and `tools`, `.js` and `.ts`, under the manifest root, environment root, XDG/default root, and `%USERPROFILE%/.opencode`.
4. Preserve every unowned file and fail with its exact path and SHA-256. Continue automatic retirement only for the one path and hash proven by a valid v1/v2 manifest.
5. Keep project/ancestor discovery in `doctor`, because the installer cannot infer a future project directory.
6. Run static installer tests and the real Windows PowerShell 5.1 suite when a Windows host is available.

### Task 5: Document diagnosis and recovery

**Files:**
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `docs/opencode.md`
- Modify: `docs/opencode-en.md`

1. Keep the normal workflow at download, `install.ps1`, restart, and `/understand`.
2. Explain that `doctor` runs automatically and is read-only.
3. Document the paths scanned, the reason project roots are checked at runtime, and the exact recovery rule: back up and verify a reported file; never delete an entire OpenCode directory.
4. State that a clean local check is not proof of a proprietary fork's extra loader paths or process cache; final acceptance still requires reinstall and a full process restart on the company machine.

### Task 6: Verify and publish

1. Run focused red-green regression tests.
2. Run `npm test` with zero failures.
3. Run the frozen benchmark and require byte-equivalent output with at least `3.00x` median speedup.
4. Run the pinned TheDailyPlan validation workflow.
5. Run the Windows PowerShell 5.1 release gate on a real Windows host; if unavailable, report the skipped gate without claiming company-client compatibility.
6. Request independent code reviews and address all critical or important findings.
7. Commit the feature branch, fast-forward `main`, push GitHub, and verify `origin/main` at the published commit.
8. Ask the user to reinstall, terminate all OpenCode background processes, run `/understand`, and report any path printed by `doctor` before marking company compatibility complete.
